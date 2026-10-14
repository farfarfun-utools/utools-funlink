<script setup lang="ts">
// 本对话框直接改 settings 这个 prop：父组件传进来的就是它自己的响应式设置对象，
// 共享引用是有意的——设置项（如搜索范围、窗口尺寸）要即时生效，
// 落盘则由 save-settings 事件交回父组件统一处理。
// 改成本地草稿再回传会把「即时生效」变成「保存后生效」，那是行为变更，不在本次改动范围内。
/* eslint-disable vue/no-mutating-props */
import { computed, reactive, ref } from 'vue'
import emptyImage from '../assets/empty.svg'
import emptyDarkImage from '../assets/empty-dark.svg'
import type { IconBackfill } from '../composables/useIconBackfill'
import { decryptSecret, encryptSecret } from '../lib/secret'
import { readStorage, writeStorage } from '../lib/storage'
import type { AppState, Bookmark, Settings } from '../lib/types'

/** WebDav 目录列表里的一个备份文件。 */
interface WebDavFile {
  href: string
  name: string
  size: number
  modified: string
}

/** 存储里的 WebDav 配置。secret 是加密后的密码；password 是 1.x 的明文字段，只用于迁移。 */
interface StoredWebdav {
  host?: string
  username?: string
  secret?: string
  password?: string
}

/** 失效链接扫描结果：书签本体加上这次探测到的错误信息。 */
type InvalidLink = Bookmark & { message: string }

/** 用户主动忽略的链接，只需要记住网址，标题用于展示。 */
interface IgnoredLink {
  title: string
  url: string
}

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
const webdav = reactive({ host: '', username: '', password: '' })
const webdavLoading = ref(false)
const webdavFiles = ref<WebDavFile[]>([])
const invalidTab = ref('results')
const scanning = ref(false)
const scanned = ref(0)
const invalidResults = ref<InvalidLink[]>([])
let scanToken = 0
// readStorage 读的是存储里的任意 JSON，这里声明期望的形状。
const ignoredLinks = ref(readStorage('funlink-ignore-list', []) as IgnoredLink[])
const checkCandidates = computed(() => props.bookmarks.filter(bookmark => !bookmark.deletedAt && !bookmark.url.includes('{q}') && !ignoredLinks.value.some(item => item.url === bookmark.url)))

function open() {
  activeTab.value = 'basic'
  snapshot.value = JSON.stringify(props.settings)
  if (!dialog.value?.open) dialog.value?.showModal()
}

/** catch 到的是 unknown，统一取一句能直接展示给用户的原因。 */
function reason(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught)
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

/** 密码在存储里是加密的，这里只写加密后的串，内存里的明文不落盘。 */
async function writeWebdav() {
  writeStorage('funlink-webdav', { host: webdav.host, username: webdav.username, secret: await encryptSecret(webdav.password) })
}

async function readWebdav() {
  const stored = readStorage('funlink-webdav', {}) as StoredWebdav
  webdav.host = stored.host || ''
  webdav.username = stored.username || ''
  // 1.x 把密码明文存在 dbStorage 里，而 dbStorage 会同步上云。读到明文就当场
  // 加密重写一遍，把明文从存储里换掉。
  if (stored.password) {
    webdav.password = stored.password
    await writeWebdav()
    return
  }
  webdav.password = await decryptSecret(stored.secret)
  // 密文只在加密它的那台设备上解得开。同步到新设备后解不出来，得让用户知道
  // 该重新输一次密码，而不是等点了备份才看到一句「请先配置WebDav」。
  if (stored.secret && !webdav.password) emit('message', 'WebDav 密码只保存在原设备，请在本机重新输入', true)
}

// 配置只读一次：解密要跑 PBKDF2，而备份、还原、打开配置框都要用到它。
let webdavReady: Promise<void> | null = null

function loadWebdav(): Promise<void> {
  webdavReady ||= readWebdav()
  return webdavReady
}

async function openWebdav() {
  await loadWebdav()
  webdavDialog.value?.showModal()
}

async function saveWebdav() {
  await writeWebdav()
  webdavDialog.value?.close()
  emit('message', '设置已保存！')
}

// 'restore' 并不是直接还原，而是先列出 WebDav 上的备份让用户挑一个，
// 真正的还原在 restoreWebdav 里。
async function webdavAction(action: 'backup' | 'restore') {
  // 配置是存出来的，不能只靠「用户这次打开过配置框」：以前不先点一下 WebDav 配置，
  // 内存里的 host 还是空的，备份一律报「请先配置」。
  await loadWebdav()
  if (!webdav.host || !webdav.username || !webdav.password) return emit('message', '请先配置WebDav！', true)
  // 先把桥接层取到局部变量：window.funlink 是可选属性，await 之后类型收窄会失效。
  const bridge = window.funlink
  if (!bridge) return emit('message', '当前环境不支持 WebDav', true)
  webdavLoading.value = true
  try {
    if (action === 'backup') {
      if (!window.confirm('导出内容为明文，可能包含网址、笔记和设置。确认上传到 WebDav？')) return
      await bridge.webdavBackup(JSON.parse(JSON.stringify(webdav)), JSON.stringify(props.backupData, null, 2))
      emit('message', '备份到WebDav成功！')
    } else {
      const xml = await bridge.webdavList(JSON.parse(JSON.stringify(webdav)))
      const document = new DOMParser().parseFromString(xml, 'application/xml')
      webdavFiles.value = [...document.getElementsByTagNameNS('*', 'response')].flatMap(response => {
        const value = (name: string) => response.getElementsByTagNameNS('*', name)[0]?.textContent || ''
        const href = value('href')
        if (!decodeURIComponent(href).endsWith('.json')) return []
        return [{ href, name: value('displayname') || decodeURIComponent(href.split('/').pop() || ''), size: Number(value('getcontentlength') || 0), modified: value('getlastmodified') }]
      }).sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
      webdavListDialog.value?.showModal()
    }
  } catch (error) {
    emit('message', `WebDav操作失败：${reason(error)}`, true)
  } finally {
    webdavLoading.value = false
  }
}

async function restoreWebdav(file: WebDavFile) {
  const bridge = window.funlink
  if (!bridge) return emit('message', '当前环境不支持 WebDav', true)
  try {
    emit('data-file', 'restore', await bridge.webdavRestore(JSON.parse(JSON.stringify(webdav)), file.href))
    webdavListDialog.value?.close()
  } catch (error) {
    emit('message', `还原失败：${reason(error)}`, true)
  }
}

async function deleteWebdav(file: WebDavFile) {
  const bridge = window.funlink
  if (!bridge) return emit('message', '当前环境不支持 WebDav', true)
  try {
    await bridge.webdavDelete(JSON.parse(JSON.stringify(webdav)), file.href)
    webdavFiles.value = webdavFiles.value.filter(item => item.href !== file.href)
    emit('message', '删除成功！')
  } catch (error) {
    emit('message', `删除失败：${reason(error)}`, true)
  }
}

async function scanInvalidLinks() {
  if (scanning.value) return
  // 探活要走 preload 的 HEAD 请求，渲染进程里没有这个桥接层就做不了。
  const bridge = window.funlink
  if (!bridge) return emit('message', '当前环境不支持链接检测', true)
  // 一轮扫描一个编号。停止扫描和重新发起都会换号，在飞的请求回来时按号对不上
  // 就把结果丢掉——几百条链接挨个探活要等很久，用户中途停下后不该再往列表里塞东西。
  const token = ++scanToken
  const outdated = () => token !== scanToken
  scanning.value = true
  scanned.value = 0
  invalidResults.value = []
  const queue = checkCandidates.value.slice()
  const worker = async () => {
    while (queue.length) {
      if (outdated()) return
      const bookmark = queue.shift()
      // 多个 worker 共享队列，shift 到空就收工。
      if (!bookmark) break
      try {
        const status = await bridge.checkUrl(bookmark.url)
        if (!outdated() && status >= 400) invalidResults.value.push({ ...bookmark, message: `${status}错误` })
      } catch (error) {
        if (!outdated()) invalidResults.value.push({ ...bookmark, message: reason(error) })
      } finally {
        if (!outdated()) scanned.value++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker))
  // 已经被停止、或者被新一轮接管时，这一轮不该再去改按钮状态。
  if (!outdated()) scanning.value = false
}

/** 停掉正在进行的扫描，已经查到的结果留在列表里。 */
function stopScan() {
  if (!scanning.value) return
  scanToken++
  scanning.value = false
}

function closeInvalidDialog() {
  stopScan()
  invalidDialog.value?.close()
}

/** 关掉对话框就停掉在跑的抓取：看不见进度了还在一个个访问网站不合理。 */
function closeIconDialog() {
  props.backfill.stop()
  iconDialog.value?.close()
}

function kilobytes(bytes: number) {
  return `${Math.round(bytes / 1024)}KB`
}

function ignoreLink(bookmark: InvalidLink) {
  invalidResults.value = invalidResults.value.filter(item => item.id !== bookmark.id)
  ignoredLinks.value.unshift({ title: bookmark.title, url: bookmark.url })
  writeStorage('funlink-ignore-list', ignoredLinks.value)
}

function unignoreLink(index: number) {
  ignoredLinks.value.splice(index, 1)
  writeStorage('funlink-ignore-list', ignoredLinks.value)
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
          <div class="button-pair"><button type="button" class="data-button warning" :disabled="webdavLoading" @click="webdavAction('backup')">{{ webdavLoading ? '正在处理...' : '备份到WebDav' }}</button><button type="button" class="data-button success" :disabled="webdavLoading" @click="webdavAction('restore')">从WebDav还原</button></div>
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
          <button type="button" class="data-button primary icon-fetch-entry" @click="iconDialog?.showModal()">批量抓取图标</button>
          <p class="setting-help">给已经收藏的卡片补上网站图标。图标直接从各个网站取，不经过第三方服务。</p>
        </section>
        <section class="data-field">
          <h3>链接检查</h3>
          <button type="button" class="data-button danger" @click="invalidDialog?.showModal()">检查无效链接</button>
        </section>
      </div>
    </div>
    <input ref="restoreInput" type="file" accept="application/json,.json" hidden @change="readFile('restore', $event)" />
    <input ref="importInput" type="file" accept="text/html,.html,.htm" hidden @change="readFile('import', $event)" />
  </dialog>

  <dialog ref="webdavDialog" class="sub-modal webdav-modal">
    <form method="dialog" @submit.prevent="saveWebdav">
      <header><h2>WebDav配置</h2><button type="button" aria-label="关闭" @click="webdavDialog?.close()">×</button></header>
      <label><span>服务器</span><input v-model="webdav.host" placeholder="请输入webdav服务器地址" required /></label>
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

  <dialog ref="invalidDialog" class="invalid-links-modal">
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
  </dialog>

  <dialog ref="iconDialog" class="icon-fetch-modal">
    <header>
      <button v-if="backfill.running" type="button" class="data-button warning" @click="backfill.stop()">停止抓取</button>
      <button v-else type="button" class="data-button primary" :disabled="!backfill.candidates.length" @click="backfill.start()">{{ backfill.finished ? '继续抓取' : '开始抓取' }}</button>
      <button type="button" aria-label="关闭" @click="closeIconDialog()">×</button>
    </header>
    <div class="icon-fetch-summary">
      <template v-if="backfill.running">已处理 <b>{{ backfill.done }}</b> / {{ backfill.candidates.length }} 张，抓到 <b>{{ backfill.filled }}</b> 张，请稍后...</template>
      <template v-else>有 <b>{{ backfill.candidates.length }}</b> 张卡片需要抓图标，当前数据 <b>{{ kilobytes(backfill.storageBytes) }}</b>，剩余空间约够放 <b>{{ backfill.capacity }}</b> 张。</template>
    </div>
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
  </dialog>
</template>
