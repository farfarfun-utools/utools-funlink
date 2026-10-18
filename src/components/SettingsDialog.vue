<script setup lang="ts">
// 本对话框直接改 settings 这个 prop：父组件传进来的就是它自己的响应式设置对象，
// 共享引用是有意的——设置项（如搜索范围、窗口尺寸）要即时生效，
// 落盘则由 save-settings 事件交回父组件统一处理。
// 改成本地草稿再回传会把「即时生效」变成「保存后生效」，那是行为变更，不在本次改动范围内。
/* eslint-disable vue/no-mutating-props */
// WebDav 备份和无效链接检查各有一套自己的状态机（密码迁移、扫描编号取消），
// 都搬到了 composables 里，这里只剩「哪个弹窗开着」和一屏设置项的读写。
import { computed, ref } from 'vue'
import emptyImage from '../assets/empty.svg'
import emptyDarkImage from '../assets/empty-dark.svg'
import type { IconBackfill } from '../composables/useIconBackfill'
import { useLinkCheck } from '../composables/useLinkCheck'
import { useWebdav } from '../composables/useWebdav'
import { withInlineIcons } from '../lib/iconStore'
import type { WebDavFile } from '../lib/webdav'
import type { AppState, Bookmark, Settings } from '../lib/types'

const props = withDefaults(defineProps<{
  settings: Settings
  /** 批量抓图标的状态，由 useIconBackfill 提供；本组件只管展示和按钮。 */
  backfill: IconBackfill
  bookmarks?: Bookmark[]
  backupData?: AppState | null
}>(), { bookmarks: () => [], backupData: null })
const emit = defineEmits(['save-settings', 'clear-cookies', 'export', 'data-file', 'reset', 'message'])
const dialog = ref<HTMLDialogElement | null>(null)
const webdavDialog = ref<HTMLDialogElement | null>(null)
const invalidDialog = ref<HTMLDialogElement | null>(null)
const iconDialog = ref<HTMLDialogElement | null>(null)
const webdavListDialog = ref<HTMLDialogElement | null>(null)
const restoreInput = ref<HTMLInputElement | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const activeTab = ref('basic')
const importMode = ref('append')
const tabPosition = ref('left')
const snapshot = ref('')
const invalidTab = ref('results')
// 这两个子弹窗里的统计（整库体积、待检查条数）只在打开时才有意义，
// 但 <dialog> 必须一直挂着，showModal() 要靠模板 ref 调。所以留着壳、按需渲染内容。
const iconDialogOpen = ref(false)
const invalidDialogOpen = ref(false)

/** 两个 composable 都要往界面上报话，统一走本组件的 message 事件。 */
const report = (text: string, error = false) => emit('message', text, error)

// 解构出来而不是整个对象挂在模板上：顶层的 ref 绑定在模板里会自动解包，
// 写成 webdav.loading 就得在模板里到处跟 .value 打交道。
const {
  config: webdav, loading: webdavLoading, files: webdavFiles,
  load: loadWebdav, save: saveWebdavConfig,
  backup: backupWebdav, loadFiles: loadWebdavFiles, restore: restoreFile, remove: deleteWebdav,
} = useWebdav({
  onMessage: report,
  // 图标还原成内联 data URL：卡片上存的是本机数据库里的附件 ID，
  // 只带 ID 的备份换一台设备恢复出来就是一堆空图标。
  backupContent: () => JSON.stringify(props.backupData && withInlineIcons(props.backupData), null, 2),
  onRestore: content => emit('data-file', 'restore', content),
})

const {
  scanning, scanned, results: invalidResults, ignored: ignoredLinks, candidates: checkCandidates,
  scan: scanInvalidLinks, stop: stopScan, ignore: ignoreLink, unignore: unignoreLink,
} = useLinkCheck({ bookmarks: computed(() => props.bookmarks), onMessage: report })

function open() {
  activeTab.value = 'basic'
  snapshot.value = JSON.stringify(props.settings)
  if (!dialog.value?.open) dialog.value?.showModal()
}

function close() {
  if (snapshot.value !== JSON.stringify(props.settings)) emit('save-settings')
  dialog.value?.close()
}

function closeOnBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) close()
}

function choose(type: 'restore' | 'import', mode = 'append') {
  importMode.value = mode
  const extensions = type === 'restore' ? ['json'] : ['html', 'htm']
  const content = window.funlink?.chooseTextFile?.(extensions)
  if (typeof content === 'string') emit('data-file', type, content, { mode, tabPosition: tabPosition.value })
  else (type === 'restore' ? restoreInput : importInput).value?.click()
}

async function readFile(type: 'restore' | 'import', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('data-file', type, await file.text(), { mode: importMode.value, tabPosition: tabPosition.value })
  input.value = ''
}

function changeNumber(key: 'width' | 'height', amount: number, minimum: number) {
  props.settings.browser[key] = Math.max(minimum, Number(props.settings.browser[key]) + amount)
}

function toggleSearch(field: string) {
  const search = props.settings.search
  const index = search.indexOf(field)
  if (index >= 0) search.splice(index, 1)
  else search.push(field)
}

async function openWebdav() {
  await loadWebdav()
  webdavDialog.value?.showModal()
}

async function saveWebdav() {
  await saveWebdavConfig()
  webdavDialog.value?.close()
}

/** 「从WebDav还原」不是直接还原，而是先列出备份让用户挑一个。 */
async function showWebdavFiles() {
  if (await loadWebdavFiles()) webdavListDialog.value?.showModal()
}

async function restoreWebdav(file: WebDavFile) {
  if (await restoreFile(file)) webdavListDialog.value?.close()
}

function openInvalidDialog() {
  invalidDialogOpen.value = true
  invalidDialog.value?.showModal()
}

function closeInvalidDialog() {
  stopScan()
  invalidDialogOpen.value = false
  invalidDialog.value?.close()
}

function openIconDialog() {
  iconDialogOpen.value = true
  iconDialog.value?.showModal()
}

/** 关掉对话框就停掉在跑的抓取：看不见进度了还在一个个访问网站不合理。 */
function closeIconDialog() {
  props.backfill.stop()
  iconDialogOpen.value = false
  iconDialog.value?.close()
}

function kilobytes(bytes: number) {
  return `${Math.round(bytes / 1024)}KB`
}

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="settings-drawer" aria-labelledby="settings-title" @click="closeOnBackdrop" @cancel.prevent="close">
    <header class="settings-header">
      <h2 id="settings-title">设置</h2>
      <button type="button" class="settings-close" aria-label="关闭" @click="close">×</button>
    </header>
    <div class="settings-body">
      <div class="settings-tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="activeTab === 'basic'" :class="{ active: activeTab === 'basic' }" @click="activeTab = 'basic'">基础设置</button>
        <button type="button" role="tab" :aria-selected="activeTab === 'data'" :class="{ active: activeTab === 'data' }" @click="activeTab = 'data'">数据管理</button>
      </div>

      <div v-if="activeTab === 'basic'" class="settings-pane basic-settings" role="tabpanel">
        <section class="setting-field">
          <h3>默认打开方式</h3>
          <label class="switch-line">
            <input v-model="settings.browser.isOpenIn" type="checkbox" />
            <span class="switch-control" aria-hidden="true" />
            <span>{{ settings.browser.isOpenIn ? '内置浏览器' : '系统浏览器' }}</span>
          </label>
        </section>

        <section class="setting-field browser-setting">
          <h3>浏览器设置 <small>(仅内置浏览器有效)</small></h3>
          <div class="browser-size-row">
            <span>宽</span>
            <div class="number-stepper">
              <button type="button" aria-label="减小浏览器宽度" @click="changeNumber('width', -10, 300)">−</button>
              <input v-model.number="settings.browser.width" type="number" min="300" step="10" aria-label="浏览器宽度" />
              <button type="button" aria-label="增大浏览器宽度" @click="changeNumber('width', 10, 300)">＋</button>
            </div>
            <span>高</span>
            <div class="number-stepper">
              <button type="button" aria-label="减小浏览器高度" @click="changeNumber('height', -10, 200)">−</button>
              <input v-model.number="settings.browser.height" type="number" min="200" step="10" aria-label="浏览器高度" />
              <button type="button" aria-label="增大浏览器高度" @click="changeNumber('height', 10, 200)">＋</button>
            </div>
          </div>
          <button type="button" class="outline-pill" @click="emit('clear-cookies')">清空内置浏览器 Cookies</button>
        </section>

        <div class="settings-divider" />
        <section class="setting-field">
          <h3>自动抓取图标</h3>
          <label class="switch-line">
            <input v-model="settings.autoIcon" type="checkbox" />
            <span class="switch-control" aria-hidden="true" />
            <span>{{ settings.autoIcon ? '添加卡片时访问该网站取图标' : '只用文字图标或本地图片' }}</span>
          </label>
          <p class="setting-help">图标直接从收藏的网站取，不经过第三方 favicon 服务。抓不到就保留文字图标。</p>
        </section>

        <div class="settings-divider" />
        <section class="setting-field search-setting">
          <h3>卡片搜索</h3>
          <div class="checkbox-row">
            <label class="check disabled"><input type="checkbox" checked disabled /><span />匹配名称</label>
            <label class="check"><input type="checkbox" :checked="settings.search.includes('description')" @change="toggleSearch('description')" /><span />匹配简介</label>
            <label class="check"><input type="checkbox" :checked="settings.search.includes('url')" @change="toggleSearch('url')" /><span />匹配域名</label>
          </div>
        </section>
        <div class="settings-divider" />
        <section class="setting-field rounded-setting">
          <h3>导航圆角 <small>(深色模式有效)</small></h3>
          <input v-model.number="settings.navbar.rounded" class="range" type="range" min="0" max="50" aria-label="导航圆角" :style="{ '--range': settings.navbar.rounded }" />
        </section>
      </div>

      <div v-else class="settings-pane data-settings" role="tabpanel">
        <section class="data-field">
          <div class="data-label"><span>WebDav备份还原</span><button type="button" class="text-button" @click="openWebdav">配置WebDav</button></div>
          <div class="button-pair"><button type="button" class="data-button warning" :disabled="webdavLoading" @click="backupWebdav">{{ webdavLoading ? '正在处理...' : '备份到WebDav' }}</button><button type="button" class="data-button success" :disabled="webdavLoading" @click="showWebdavFiles">从WebDav还原</button></div>
        </section>
        <section class="data-field">
          <h3>本地备份还原</h3>
          <div class="button-pair"><button type="button" class="data-button warning" @click="emit('export')">备份到电脑</button><button type="button" class="data-button success" @click="choose('restore')">从电脑还原</button></div>
        </section>
        <section class="data-field bookmark-import">
          <h3>书签导入</h3>
          <div class="bookmark-import-select">
            <select v-model="tabPosition" aria-label="分类Tabs位置">
              <option value="left">分类Tabs位置：左</option><option value="top">分类Tabs位置：上</option>
              <option value="right">分类Tabs位置：右</option><option value="bottom">分类Tabs位置：下</option>
            </select>
            <span aria-hidden="true">⌄</span>
          </div>
          <label class="input-group"><span>名称简介分割符</span><input v-model="settings.importSplit" placeholder="按此符号进行分割" /></label>
          <p class="import-help">将按这些符号自动分割名称与简介。多个请用英文逗号分隔</p>
          <div class="button-pair"><button type="button" class="data-button primary" @click="choose('import', 'append')">追加导入</button><button type="button" class="data-button primary" @click="choose('import', 'replace')">替换导入</button></div>
          <div class="import-notes">
            1、支持chrome、edge浏览器导出的html格式数据 2、导入之前请先<span>备份</span>数据，以防数据丢失！！！ 3、导入成功后需<span>“完全退出插件”</span>再打开才能生效
          </div>
        </section>
        <section class="data-field">
          <h3>网站图标</h3>
          <button type="button" class="data-button primary icon-fetch-entry" @click="openIconDialog">批量抓取图标</button>
          <p class="setting-help">给已经收藏的卡片补上网站图标。图标直接从各个网站取，不经过第三方服务。</p>
        </section>
        <section class="data-field">
          <h3>链接检查</h3>
          <button type="button" class="data-button danger invalid-links-entry" @click="openInvalidDialog">检查无效链接</button>
        </section>
      </div>
    </div>
    <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="readFile('restore', $event)" />
    <input ref="importInput" type="file" accept="text/html,.html,.htm" hidden @change="readFile('import', $event)" />
  </dialog>

  <dialog ref="webdavDialog" class="sub-modal webdav-modal">
    <form method="dialog" @submit.prevent="saveWebdav">
      <header><h2>WebDav配置</h2><button type="button" aria-label="关闭" @click="webdavDialog?.close()">×</button></header>
      <label><span>服务器</span><input v-model="webdav.host" type="url" placeholder="https://example.com/dav/" required /></label>
      <label><span>用户名</span><input v-model="webdav.username" placeholder="请输入webdav用户名" required /></label>
      <label><span>密 码</span><input v-model="webdav.password" type="password" placeholder="请输入webdav访问密码" required /></label>
      <footer><button type="button" class="button" @click="webdavDialog?.close()">取消</button><button type="submit" class="button primary">保存</button></footer>
    </form>
  </dialog>

  <dialog ref="webdavListDialog" class="sub-modal webdav-list-modal">
    <header><h2>已备份文件</h2><button type="button" aria-label="关闭" @click="webdavListDialog?.close()">×</button></header>
    <div v-if="webdavFiles.length" class="webdav-file-list">
      <div v-for="file in webdavFiles" :key="file.href"><span>{{ file.name }}</span><small>{{ (file.size / 1024).toFixed(2) }}kb</small><button type="button" @click="restoreWebdav(file)">还原</button><button type="button" class="danger-text" @click="deleteWebdav(file)">删除</button></div>
    </div>
    <div v-else class="webdav-empty">暂无数据</div>
  </dialog>

  <dialog ref="invalidDialog" class="invalid-links-modal" @cancel.prevent="closeInvalidDialog()">
    <template v-if="invalidDialogOpen">
      <header><button v-if="scanning" type="button" class="data-button warning" @click="stopScan">停止扫描</button><button v-else type="button" class="data-button primary" @click="scanInvalidLinks"><i class="iconfont icon-search" aria-hidden="true" /> {{ scanned ? '重新检查' : '开始检查' }}</button><button type="button" aria-label="关闭" @click="closeInvalidDialog()">×</button></header>
      <div class="invalid-tabs"><button :class="{ active: invalidTab === 'results' }" type="button" @click="invalidTab = 'results'">扫描结果</button><button :class="{ active: invalidTab === 'ignored' }" type="button" @click="invalidTab = 'ignored'">忽略名单</button></div>
      <template v-if="invalidTab === 'results'">
        <div class="invalid-summary">共需检查 <b>{{ checkCandidates.length }}</b> 条链接，<template v-if="scanning">正在检查第 <b>{{ scanned }}</b> 个，已查到 <b>{{ invalidResults.length }}</b> 条无效链接，请稍后...</template><template v-else>点击按钮后开始检查无效链接。</template></div>
        <div v-if="invalidResults.length" class="invalid-result-list"><div v-for="item in invalidResults" :key="item.id"><span>{{ item.title }}</span><a :href="item.url">{{ item.url }}</a><em>{{ item.message }}</em><button type="button" @click="ignoreLink(item)">忽略</button></div></div>
        <div v-else class="invalid-empty"><img class="empty-image-light" :src="emptyImage" alt="" /><img class="empty-image-dark" :src="emptyDarkImage" alt="" /><span>提示：由于个别站点原因，扫描结果可能有小误差！</span></div>
      </template>
      <template v-else>
        <div class="invalid-summary">已忽略 <b>{{ ignoredLinks.length }}</b> 条链接 <span>如果个别网址检查不准确，请加入忽略检查白名单</span></div>
        <div v-if="ignoredLinks.length" class="invalid-result-list"><div v-for="(item, index) in ignoredLinks" :key="item.url"><span>{{ item.title }}</span><a :href="item.url">{{ item.url }}</a><button type="button" @click="unignoreLink(index)">取消</button></div></div>
        <div v-else class="invalid-empty"><img class="empty-image-light" :src="emptyImage" alt="" /><img class="empty-image-dark" :src="emptyDarkImage" alt="" /><span>暂无数据</span></div>
      </template>
    </template>
  </dialog>

  <dialog ref="iconDialog" class="icon-fetch-modal" @cancel.prevent="closeIconDialog()">
    <!-- 整库体积要序列化一遍才知道，对话框不打开就别算：这段挂在模板上的时候，
         每改一张卡片都会连带把整库多序列化一次。 -->
    <template v-if="iconDialogOpen">
      <header>
        <button v-if="backfill.running" type="button" class="data-button warning" @click="backfill.stop()">停止抓取</button>
        <button v-else type="button" class="data-button primary" :disabled="!backfill.candidates.length" @click="backfill.start()">{{ backfill.finished ? '继续抓取' : '开始抓取' }}</button>
        <button type="button" aria-label="关闭" @click="closeIconDialog()">×</button>
      </header>
      <div class="icon-fetch-summary">
        <template v-if="backfill.running || backfill.finished">已处理 <b>{{ backfill.done }}</b> / {{ backfill.total }} 张，抓到 <b>{{ backfill.filled }}</b> 张，失败 <b>{{ backfill.failed }}</b> 张<template v-if="backfill.running">，请稍后...</template></template>
        <template v-else-if="backfill.candidates.length">有 <b>{{ backfill.candidates.length }}</b> 张卡片需要抓图标，当前数据 <b>{{ kilobytes(backfill.storageBytes) }}</b>，剩余空间约够放 <b>{{ backfill.capacity }}</b> 张。</template>
        <template v-else>没有需要抓图标的卡片，当前数据 <b>{{ kilobytes(backfill.storageBytes) }}</b>，剩余空间约够放 <b>{{ backfill.capacity }}</b> 张。</template>
      </div>
      <!-- 一张图标要访问一个站点，几百张能跑好几分钟。只给数字的话第一张抓完前
           界面是静止的，看着就像没反应，所以这条进度条在 0% 时也要动。 -->
      <div
        v-if="backfill.running || backfill.finished"
        class="icon-fetch-progress"
        :class="{ waiting: backfill.running && !backfill.done }"
        role="progressbar"
        :aria-valuenow="backfill.percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div :style="backfill.done ? { width: `${backfill.percent}%` } : undefined" />
      </div>
      <p v-if="backfill.message" class="icon-fetch-message" :class="{ error: backfill.messageError }">{{ backfill.message }}</p>
      <p class="icon-fetch-note">逐个访问这些网站取图标，不经过第三方 favicon 服务。整库收藏共用 1MB 额度，装不下时会停下来告诉你。</p>
      <label class="switch-line icon-fetch-option">
        <input v-model="backfill.includeExisting" type="checkbox" :disabled="backfill.running" />
        <span class="switch-control" aria-hidden="true" />
        <span>连已有图片图标的卡片一起重新抓</span>
      </label>
      <div v-if="backfill.failures.length" class="icon-fetch-list">
        <div v-for="item in backfill.failures" :key="item.id"><span>{{ item.title }}</span><a :href="item.url">{{ item.url }}</a><em>{{ item.reason }}</em></div>
      </div>
      <div v-else class="invalid-empty">
        <img class="empty-image-light" :src="emptyImage" alt="" /><img class="empty-image-dark" :src="emptyDarkImage" alt="" />
        <span>{{ backfill.finished ? '这一轮没有抓失败的卡片' : '抓不到图标的网站会列在这里，这些卡片保持原来的文字图标' }}</span>
      </div>
    </template>
  </dialog>
</template>
