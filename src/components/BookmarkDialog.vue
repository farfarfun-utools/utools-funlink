<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { initials, isAbsoluteUrl, isHttpUrl, normalizeUrl, safeColor } from '../lib/core'
import { bookmarkIcon, loadIcon } from '../lib/iconStore'
import { fetchSiteIcon, toIconDataUrl } from '../lib/image'
import { childrenOf as childrenIn, rootCategories } from '../lib/views'
import type { BrowserMode, Bookmark, Category } from '../lib/types'

/** 表单的字段都是必填的：空值用 '' / [] 表示，这样模板里不用到处判 undefined。 */
interface BookmarkForm {
  id: string
  url: string
  urls: string[]
  title: string
  description: string
  categoryId: string
  categoryIds: string[]
  iconType: 'text' | 'image'
  icon: string
  color: string
  iconData: string
  iconSize: number
  browser: BrowserMode
  favorite: boolean
  quick: boolean
}

const COLORS = ['#8480f9', '#2792ff', '#1fd88b', '#fdcd05', '#ff7ba2', '#98d517', '#ff7f1b', '#07b882']
// 图标以 data URL 存进 dbStorage。选图时会按显示尺寸压缩，这里卡的是解码前的原图体积。
const MAX_ICON_BYTES = 200 * 1024
// 网址是一个字一个字敲（或整段粘贴）出来的，等手停下来再去抓，
// 否则一个网址要抓十几次。
const AUTO_ICON_DELAY = 600
const props = withDefaults(defineProps<{
  categories: Category[]
  defaultCategoryId: string
  bookmarkCount: number
  /** 填完网址自动去站点抓图标，对应设置里的「自动抓取图标」。 */
  autoIcon?: boolean
}>(), { autoIcon: true })
const emit = defineEmits(['save'])
const dialog = ref<HTMLDialogElement | null>(null)
const urlInput = ref<HTMLInputElement | null>(null)
const iconInput = ref<HTMLInputElement | null>(null)
const afterId = ref<string | null>(null)
const editing = ref(false)
const expanded = ref(false)
const categoryOpen = ref(false)
const activeCategoryRootId = ref('')
const error = ref('')
const fetchingIcon = ref(false)
const form = reactive<BookmarkForm>(blankForm())
// 自动抓取只在用户自己没定过图标时动手；已经抓过（或已处理过）的网址不再抓第二遍。
let iconTouched = false
let handledUrl = ''
let iconTimer: ReturnType<typeof setTimeout> | null = null
const roots = computed(() => rootCategories(props.categories))
const childrenOf = (id: string) => childrenIn(props.categories, id)
// 「收集箱」不是真实分类，但在选择器里要能被勾上，所以拼成一个同形状的伪分类。
const categoryRoots = computed<Category[]>(() => [...roots.value, { id: 'cat@default', name: '收集箱', parentId: '' }])
const activeCategoryChildren = computed(() => childrenOf(activeCategoryRootId.value))
// 只有 http(s) 的网址才有网页图标可抓，file / ftp 没有。
const canFetchIcon = computed(() => isHttpUrl(form.url))
const selectedCategories = computed<{ id: string, name: string }[]>(() => form.categoryIds.flatMap(id => {
  if (id === 'cat@default') return [{ id, name: '收集箱' }]
  const category = props.categories.find(item => item.id === id)
  return category ? [category] : []
}))

function blankForm(): BookmarkForm {
  return {
    id: '', url: '', urls: [], title: '', description: '', categoryId: props.defaultCategoryId || 'cat@default', categoryIds: [props.defaultCategoryId || 'cat@default'],
    iconType: 'text', icon: '', color: safeColor(COLORS[props.bookmarkCount % COLORS.length]), iconData: '', iconSize: 16,
    browser: 'default', favorite: false, quick: false,
  }
}

// 从主搜索框进来时只带着一个 url（见 useFunLink 的 setupUtools），所以收 Partial。
function open(bookmark: Partial<Bookmark> | null = null, insertAfterId: string | null = null) {
  editing.value = Boolean(bookmark?.id)
  afterId.value = insertAfterId
  error.value = ''
  Object.assign(form, blankForm(), bookmark || {})
  const categoryIds = bookmark?.categoryIds?.length
    ? bookmark.categoryIds.slice()
    : [bookmark?.categoryId || props.defaultCategoryId || 'cat@default']
  form.categoryIds = [...new Set(categoryIds)]
  form.categoryId = form.categoryIds[0] ?? ''
  const selectedCategory = props.categories.find(category => category.id === form.categoryIds[0])
  activeCategoryRootId.value = selectedCategory?.parentId || selectedCategory?.id || roots.value[0]?.id || 'cat@default'
  categoryOpen.value = false
  // 「网址精灵」旧备份里附加网址是 { value } 对象而不是字符串，这里统一拍平。
  const rawUrls: unknown = bookmark?.urls
  form.urls = Array.isArray(rawUrls)
    ? rawUrls.map(item => typeof item === 'string' ? item : String((item as { value?: unknown })?.value ?? ''))
    : []
  form.color = safeColor(form.color)
  // 图片图标存在数据库附件里，卡片上只有一个 ID（见 lib/iconStore.ts），
  // 而表单要的是能直接预览、提交时能原样回传的 data URL。
  // 文字图标的卡片沿用自己那份 iconData：用户切回「图片」时原来选的图还在。
  const icon = bookmark ? bookmarkIcon(bookmark as Bookmark) : { url: '', pending: false }
  form.iconData = icon.url || String(bookmark?.iconData || '')
  // 附件还没读出来（刚启动，预读还没走到这张）就现读一次，读到了再填进表单。
  if (icon.pending) {
    const editingId = bookmark?.id
    loadIcon(String(bookmark?.iconRef || '')).then(url => {
      if (url && form.id === editingId && !form.iconData) form.iconData = url
    })
  }
  expanded.value = editing.value || isAbsoluteUrl(form.url)
  // 编辑已有卡片时把当前网址记成「已处理」：点开弹窗不该把人家原来的图标换掉。
  // 新建时不记，这样从主搜索框带着网址进来的那条路也会自动抓。
  handledUrl = editing.value ? form.url.trim() : ''
  iconTouched = editing.value && form.iconType === 'image' && Boolean(form.iconData)
  stopIconFetch()
  if (!dialog.value?.open) dialog.value?.showModal()
}

function close() {
  categoryOpen.value = false
  stopIconFetch()
  dialog.value?.close()
}

function stopIconFetch() {
  if (iconTimer) clearTimeout(iconTimer)
  iconTimer = null
  fetchingIcon.value = false
}

/**
 * 去站点抓一张图标填进表单。抓不到就什么都不做，保持文字图标。
 * @param force 用户自己点的「抓取图标」，哪怕已经定过图标也照换
 */
async function fetchIcon(url: string, { force = false } = {}) {
  handledUrl = url
  fetchingIcon.value = true
  // 搜索类网址带着 {q} 占位符，原样请求是个无意义的地址；
  // 去掉占位符后站点首页和 /favicon.ico 兜底都还在。
  const icon = await fetchSiteIcon(url.replaceAll('{q}', ''))
  // 抓的这几秒里用户可能又改了网址，或者把弹窗关掉开了另一张卡片，
  // 那这张图就不是当前这条网址的图标了，丢掉。
  if (form.url.trim() !== url) return
  fetchingIcon.value = false
  if (!icon || (iconTouched && !force)) return
  form.iconData = icon
  form.iconType = 'image'
}

/** 手动抓图标：自动抓取关着、抓过没抓到、或者想换一张时用。 */
async function fetchIconNow() {
  const url = form.url.trim()
  if (fetchingIcon.value || !isHttpUrl(url)) return
  // 定时器还挂着的话等会儿又抓一次，这次手动的就白点了。
  stopIconFetch()
  await fetchIcon(url, { force: true })
  // 抓的过程中又改了网址，这次手动抓取就当没发生过。
  if (form.url.trim() !== url) return
  // 手动抓过就算用户定过图标：之后改网址不该再自动盖掉它。
  iconTouched = true
  if (form.iconType !== 'image' || !form.iconData) error.value = '没抓到这个网站的图标'
}

function scheduleIconFetch() {
  // 网址一改，在飞的那次抓取结果就作废了（上面的 form.url 判断会丢掉它），
  // 所以转圈也该停下来，等这次的定时器到点再转。
  stopIconFetch()
  if (!props.autoIcon || iconTouched) return
  const url = form.url.trim()
  // 只抓 http(s)：file / ftp 没有网页图标可读。地址没填全（协议都还没敲完）时
  // 界面还是骨架屏，这时去抓只会抓到一堆 404。
  if (!isHttpUrl(url) || url === handledUrl) return
  iconTimer = setTimeout(() => {
    iconTimer = null
    fetchIcon(url)
  }, AUTO_ICON_DELAY)
}

function addUrl() { form.urls.push('') }

function pickIcon() {
  iconInput.value?.click()
}

async function readIcon(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 先清空 input，同一张图片再选一次也能触发 change。
  input.value = ''
  if (!file) return
  if (file.size > MAX_ICON_BYTES) {
    error.value = `图标图片不能超过 ${MAX_ICON_BYTES / 1024}KB`
    return
  }
  try {
    form.iconData = await toIconDataUrl(file)
    form.iconType = 'image'
    // 用户自己选了图，在飞的自动抓取结果就别再往上盖了。
    iconTouched = true
    stopIconFetch()
    error.value = ''
  } catch {
    error.value = '图片读取失败'
  }
}

function useImageIcon() {
  form.iconType = 'image'
  if (!form.iconData) pickIcon()
}

function useTextIcon() {
  form.iconType = 'text'
  iconTouched = true
  stopIconFetch()
}

function clearIcon() {
  form.iconData = ''
  form.iconType = 'text'
  iconTouched = true
  stopIconFetch()
}

function submit() {
  try {
    if (!form.title.trim()) throw new Error('网站名称不能为空')
    if (!form.categoryIds.length) throw new Error('请选择分类')
    if (form.iconType === 'image' && !form.iconData) throw new Error('请选择图标图片，或改用文字图标')
    emit('save', {
      id: form.id,
      url: normalizeUrl(form.url),
      // 附加网址同样要过一遍协议校验，避免 javascript: 之类被存进来。
      urls: form.urls.filter(Boolean).map(normalizeUrl),
      title: form.title.trim(),
      description: form.description.trim(),
      categoryId: form.categoryIds[0],
      categoryIds: form.categoryIds.slice(),
      iconType: form.iconType,
      icon: form.icon.trim() || initials(form.title),
      iconData: form.iconData,
      iconSize: form.iconSize,
      color: safeColor(form.color),
      browser: form.browser,
      favorite: form.favorite,
      quick: form.quick,
    }, afterId.value)
    close()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '保存失败'
    nextTick(() => urlInput.value?.focus())
  }
}

function closeOnBackdrop(event: MouseEvent) { if (event.target === dialog.value) close() }

function cancel(event: Event) {
  if (!categoryOpen.value) return close()
  event.preventDefault()
  categoryOpen.value = false
}

function openCategoryMenu() {
  categoryOpen.value = !categoryOpen.value
  error.value = ''
}

function categoryIdsForRoot(root: Category) {
  const children = childrenOf(root.id)
  return children.length ? children.map(category => category.id) : [root.id]
}

function rootChecked(root: Category) {
  const ids = categoryIdsForRoot(root)
  return ids.every(id => form.categoryIds.includes(id)) || form.categoryIds.includes(root.id)
}

function rootIndeterminate(root: Category) {
  const ids = categoryIdsForRoot(root)
  const count = ids.filter(id => form.categoryIds.includes(id)).length
  return count > 0 && count < ids.length
}

function toggleCategory(id: string) {
  form.categoryIds = form.categoryIds.includes(id)
    ? form.categoryIds.filter(categoryId => categoryId !== id)
    : [...form.categoryIds, id]
  form.categoryId = form.categoryIds[0] || ''
  error.value = ''
}

function toggleRoot(root: Category) {
  const ids = categoryIdsForRoot(root)
  // 一级分类没有子分类时，勾它就等于勾自己这一个 id。
  if (ids.length === 1 && ids[0]) return toggleCategory(ids[0])
  const remove = rootChecked(root)
  form.categoryIds = remove
    ? form.categoryIds.filter(id => id !== root.id && !ids.includes(id))
    : [...new Set([...form.categoryIds.filter(id => id !== root.id), ...ids])]
  form.categoryId = form.categoryIds[0] || ''
  error.value = ''
}

function clearCategories() {
  form.categoryIds = []
  form.categoryId = ''
}

watch(() => form.url, value => {
  expanded.value = editing.value || isAbsoluteUrl(value)
  if (expanded.value && !form.title && editing.value) form.title = ''
  error.value = ''
  scheduleIconFetch()
})

// 弹窗是常驻组件，正常关闭走 close()；这里兜住组件被卸载的情况，别留着定时器。
onBeforeUnmount(stopIconFetch)

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="bookmark-dialog" @click="closeOnBackdrop" @cancel.prevent="cancel">
    <form @submit.prevent="submit" @click="categoryOpen = false">
      <header class="bookmark-dialog-header">
        <span class="bookmark-dialog-heading-icon"><i class="iconfont icon-card" aria-hidden="true" /></span>
        <h2>{{ editing ? '编辑卡片' : '添加卡片' }}</h2>
        <button type="button" class="bookmark-add-url" aria-label="打开多个网页" title="打开多个网页" @click="addUrl"><i class="iconfont icon-add" aria-hidden="true" /></button>
      </header>

      <div class="bookmark-dialog-body">
        <input ref="urlInput" v-model="form.url" class="bookmark-url-input" inputmode="url" placeholder="请输入网站地址" required />
        <input v-for="(_, index) in form.urls" :key="index" v-model="form.urls[index]" class="bookmark-url-input extra-url" inputmode="url" :placeholder="`请输入附加网址 ${index + 1}`" />

        <div class="web-edit-card" :class="{ skeleton: !expanded }">
          <template v-if="expanded">
            <span class="web-preview-icon" :class="{ empty: form.iconType === 'image' && !form.iconData, ripple: !editing && form.iconType === 'image' && !form.iconData }" :style="{ backgroundColor: form.iconType === 'text' ? form.color : '' }">
              <img v-if="form.iconType === 'image' && form.iconData" :src="form.iconData" alt="" />
              <template v-else-if="form.iconType === 'text'">{{ form.icon || initials(form.title) }}</template>
              <span v-if="fetchingIcon" class="icon-spinner" role="status" aria-label="正在抓取网站图标" />
            </span>
            <div class="web-preview-fields">
              <label><span class="sr-only">网站名称</span><input v-model="form.title" maxlength="20" placeholder="请输入网站名称" required /><small>{{ form.title.length }} / 20</small></label>
              <label><span class="sr-only">网站简介</span><textarea v-model="form.description" maxlength="60" placeholder="请输入网站简介" /></label>
            </div>
          </template>
          <template v-else>
            <span class="skeleton-circle" />
            <span class="skeleton-lines"><i /><i /></span>
          </template>
        </div>

        <template v-if="expanded">
          <div class="icon-editor">
            <div class="icon-type-switch" role="group" aria-label="图标类型">
              <button type="button" :class="{ active: form.iconType === 'text' }" @click="useTextIcon">文字</button>
              <button type="button" :class="{ active: form.iconType === 'image' }" @click="useImageIcon">图片</button>
            </div>
            <template v-if="form.iconType === 'text'">
              <input v-model="form.icon" class="icon-text-input" maxlength="4" :placeholder="initials(form.title)" aria-label="图标文字" />
              <div class="icon-colors" role="group" aria-label="图标颜色">
                <button
                  v-for="color in COLORS"
                  :key="color"
                  type="button"
                  :class="{ active: form.color === color }"
                  :style="{ backgroundColor: color }"
                  :aria-label="`使用颜色 ${color}`"
                  :aria-pressed="form.color === color"
                  @click="form.color = color"
                />
              </div>
            </template>
            <template v-else>
              <button type="button" class="icon-upload" @click="pickIcon">{{ form.iconData ? '更换图片' : '选择图片' }}</button>
              <button v-if="form.iconData" type="button" class="icon-clear-image" @click="clearIcon">移除</button>
              <small>支持本地图片，最大 200KB</small>
            </template>
            <button v-if="canFetchIcon" type="button" class="icon-fetch" :disabled="fetchingIcon" @click="fetchIconNow">{{ fetchingIcon ? '抓取中...' : '抓取网站图标' }}</button>
          </div>

          <div class="bookmark-options-row">
            <div class="bookmark-category-field"><span><b>*</b> 所在分类</span>
              <div
                class="category-select"
                :class="{ open: categoryOpen }"
                role="combobox"
                tabindex="0"
                aria-label="所在分类"
                aria-haspopup="tree"
                :aria-expanded="categoryOpen"
                @click.stop="openCategoryMenu"
                @keydown.enter.prevent="openCategoryMenu"
                @keydown.space.prevent="openCategoryMenu"
                @keydown.down.prevent="categoryOpen = true"
                @keydown.esc.stop.prevent="categoryOpen = false"
              >
                <span class="category-tags">
                  <span v-for="category in selectedCategories" :key="category.id" class="selected-tag">
                    <span>{{ category.name }}</span>
                    <button type="button" :aria-label="`移除分类${category.name}`" @click.stop="toggleCategory(category.id)">×</button>
                  </span>
                  <span v-if="!selectedCategories.length" class="category-placeholder">请选择分类...</span>
                </span>
                <button v-if="selectedCategories.length" class="category-clear" type="button" aria-label="清空分类" @click.stop="clearCategories">×</button>
                <span class="select-arrow" aria-hidden="true" />
              </div>

              <div v-if="categoryOpen" class="category-options-popover" role="tree" aria-label="分类列表" @click.stop @keydown.esc.stop.prevent="categoryOpen = false">
                <div class="category-option-panel" role="group" aria-label="一级分类">
                  <button
                    v-for="root in categoryRoots"
                    :key="root.id"
                    type="button"
                    class="category-option-row"
                    :class="{ active: activeCategoryRootId === root.id, checked: rootChecked(root) }"
                    role="treeitem"
                    :aria-checked="rootChecked(root)"
                    @mouseenter="activeCategoryRootId = root.id"
                    @focus="activeCategoryRootId = root.id"
                    @click="toggleRoot(root)"
                  >
                    <span class="category-option-checkbox" :class="{ checked: rootChecked(root), indeterminate: rootIndeterminate(root) }" aria-hidden="true" />
                    <span class="category-option-label">{{ root.name }}</span>
                    <span v-if="childrenOf(root.id).length" class="category-option-arrow" aria-hidden="true" />
                  </button>
                </div>
                <div v-if="activeCategoryChildren.length" class="category-option-panel" role="group" aria-label="二级分类">
                  <button
                    v-for="category in activeCategoryChildren"
                    :key="category.id"
                    type="button"
                    class="category-option-row"
                    :class="{ checked: form.categoryIds.includes(category.id) }"
                    role="treeitem"
                    :aria-checked="form.categoryIds.includes(category.id)"
                    @click="toggleCategory(category.id)"
                  >
                    <span class="category-option-checkbox" :class="{ checked: form.categoryIds.includes(category.id) }" aria-hidden="true" />
                    <span class="category-option-label">{{ category.name }}</span>
                  </button>
                </div>
              </div>
            </div>
            <label class="bookmark-browser-field"><span>打开方式</span>
              <select v-model="form.browser" aria-label="打开方式">
                <option value="default">默认设置</option><option value="system">系统浏览器</option><option value="inner">内置浏览器</option>
                <option value="chrome">Google Chrome</option><option value="chrome-incognito">Google Chrome（无痕）</option>
                <option value="edge">Microsoft Edge</option><option value="edge-inprivate">Microsoft Edge（无痕）</option>
                <option value="safari">Safari</option><option value="firefox">Firefox</option>
              </select>
            </label>
          </div>
          <label class="quick-switch"><input v-model="form.quick" type="checkbox" /><span class="switch-control" aria-hidden="true" /><span>网页快开</span><i class="iconfont icon-help" title="支持从 uTools 主搜索框快速打开网页" /></label>
          <div class="form-error" role="alert">{{ error }}</div>
          <footer class="bookmark-dialog-footer"><button class="button" type="button" @click="close">取消</button><button class="button primary" type="submit">保存</button></footer>
        </template>
      </div>
      <input ref="iconInput" type="file" accept="image/*" hidden @change="readIcon" />
    </form>
  </dialog>
</template>
