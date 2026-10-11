<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { initials, normalizeUrl } from '../lib/core'
import { toIconDataUrl } from '../lib/image'
import { safeColor } from '../lib/core'
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
const props = defineProps<{
  categories: Category[]
  defaultCategoryId: string
  bookmarkCount: number
}>()
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
const form = reactive<BookmarkForm>(blankForm())
const roots = computed(() => props.categories.filter(category => !category.parentId))
const childrenOf = (id: string) => props.categories.filter(category => category.parentId === id)
// 「收集箱」不是真实分类，但在选择器里要能被勾上，所以拼成一个同形状的伪分类。
const categoryRoots = computed<Category[]>(() => [...roots.value, { id: 'cat@default', name: '收集箱', parentId: '' }])
const activeCategoryChildren = computed(() => childrenOf(activeCategoryRootId.value))
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
  expanded.value = editing.value || /^(https?|ftp|file):\/\//i.test(form.url)
  if (!dialog.value?.open) dialog.value?.showModal()
}

function close() {
  categoryOpen.value = false
  dialog.value?.close()
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
    error.value = ''
  } catch {
    error.value = '图片读取失败'
  }
}

function useImageIcon() {
  form.iconType = 'image'
  if (!form.iconData) pickIcon()
}

function clearIcon() {
  form.iconData = ''
  form.iconType = 'text'
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
  expanded.value = editing.value || /^(https?|ftp|file):\/\//i.test(String(value || '').trim())
  if (expanded.value && !form.title && editing.value) form.title = ''
  error.value = ''
})

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
              <button type="button" :class="{ active: form.iconType === 'text' }" @click="form.iconType = 'text'">文字</button>
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
