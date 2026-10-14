import { computed, ref } from 'vue'
import { IMPORT_COLORS, createId, displayHost, fillQueryPlaceholder, hasQueryPlaceholder, initials, isSafeUrl, moveCategory, moveItem, normalizeCategoryIds, originOf, parseBookmarkHtml, splitTitle } from '../lib/core'
import { removeQuickFeature, resetQuickFeatures, syncQuickFeature } from '../lib/features'
import { STORAGE_KEY, categoryIdsOf, loadState, prepareState } from '../lib/state'
import { convertLegacyExport, isLegacyExport } from '../lib/legacy'
import { commitStorage, readStorage, serializeForStorage } from '../lib/storage'
import * as views from '../lib/views'
import type { AppState, Bookmark, Category, CategoryAction } from '../lib/types'
import type { IconUpdate } from '../lib/icons'
import { registerAiTools } from './useAiTools'
import { useIconBackfill } from './useIconBackfill'
import { useKeywordPrompt } from './useKeywordPrompt'
import { useToast } from './useToast'
import { setupUtoolsHost } from './useUtoolsHost'

export { PLUGIN_HEIGHT } from './useUtoolsHost'

// 示例数据本身就是「网址精灵」的文档格式，直接复用导入用的转换器，
// 免得示例数据和真实导入走两套映射、行为不一致。
//
// 用动态 import 而不是顶部静态 import：这份 JSON 有 84KB，压进主包要占四分之一的
// 体积，但只有首次启动和「恢复示例数据」才读得到，老用户每次启动都白解析一遍。
async function seedState(): Promise<AppState> {
  const { default: firstData } = await import('../data/firstData.json')
  return convertLegacyExport(firstData).state
}

/** 提供收藏状态、导入导出及 uTools 交互能力。 @returns {object} */
export function useFunLink() {
  const loaded = loadState({ read: readStorage })
  const state = ref(loaded.state)
  const storageError = ref(loaded.blocked)
  const search = ref('')
  const { toast, showToast } = useToast()
  const { keywordPrompt, askKeyword, resolveKeyword } = useKeywordPrompt()
  let lastSavedJson = ''

  const childrenOf = (parentId: string): Category[] => views.childrenOf(state.value.categories, parentId)
  const roots = computed(() => views.rootCategories(state.value.categories))
  const activeCategoryId = computed(() => views.activeCategoryId(state.value))
  const activeRootId = computed(() => views.activeRootId(state.value))
  const secondaryCategories = computed(() => state.value.currentView.startsWith('category:') && activeRootId.value ? childrenOf(activeRootId.value) : [])
  const secondaryPosition = computed(() => state.value.categories.find(category => category.id === activeRootId.value)?.tabPosition || 'top')
  const trashCount = computed(() => state.value.bookmarks.filter(bookmark => bookmark.deletedAt).length)
  const currentBookmarks = computed(() => views.visibleBookmarks(state.value, search.value))
  const defaultCategoryId = computed(() => views.defaultCategoryId(state.value))

  /**
   * 把当前状态写回存储。这里是所有改动落盘的唯一出口。
   * 写失败时自己弹错误提示，并返回 false——调用方必须据此决定还要不要报「已保存」，
   * 否则成功提示会盖掉错误提示，用户看到的就是一次假成功。
   */
  function saveState(): boolean {
    if (storageError.value) return false
    const snapshot = serializeForStorage(state.value)
    // 内容和上次写进去的完全一样就不再写。整库收藏压在一个文档里，一次保存就是
    // 全量落盘加一次云同步，而点同一个导航、把卡片拖回原处这类空操作很常见。
    // 初值留空而不是用读出来的状态：读的时候做过迁移和补默认值，第一次保存
    // 要把迁移结果落下去。
    if (snapshot.json === lastSavedJson) return true
    const result = commitStorage(STORAGE_KEY, snapshot)
    if (!result.ok) showToast(result.message || '保存失败', true)
    else lastSavedJson = snapshot.json
    return result.ok
  }

  function setView(view: string) {
    if (view.startsWith('category:')) {
      const categoryId = view.slice(9)
      const firstChild = childrenOf(categoryId)[0]
      state.value.currentView = `category:${firstChild?.id || categoryId}`
      state.value.lastCategoryId = firstChild?.id || categoryId
    } else state.value.currentView = view
    search.value = ''
    saveState()
  }

  /** 新增或更新一张卡片。返回是否真的写进了存储，AI 工具据此判断要不要报错。 */
  function saveBookmark(input: Partial<Bookmark>, afterId: string | null = null): boolean {
    const id = input.id || createId('bookmark')
    const previous = state.value.bookmarks.find(bookmark => bookmark.id === id)
    const categoryIds = normalizeCategoryIds(input.categoryIds || (input.categoryId ? [input.categoryId] : []))
    const bookmark: Bookmark = {
      ...previous, ...input, id,
      // title/url 是必填字段，但 input 是 Partial（主搜索框只带 url 进来），
      // 编辑时从原记录兜底，新增时表单已经校验过非空。
      title: input.title ?? previous?.title ?? '',
      url: input.url ?? previous?.url ?? '',
      categoryId: categoryIds[0], categoryIds, note: previous?.note || '', deletedAt: null,
    }
    if (previous) state.value.bookmarks[state.value.bookmarks.indexOf(previous)] = bookmark
    else if (afterId) state.value.bookmarks.splice(state.value.bookmarks.findIndex(item => item.id === afterId) + 1, 0, bookmark)
    else state.value.bookmarks.push(bookmark)
    syncQuickFeature(bookmark)
    const saved = saveState()
    if (saved) showToast(previous ? '网址已更新' : '网址已添加')
    return saved
  }

  function saveNote(id: string, note: string) {
    const bookmark = state.value.bookmarks.find(item => item.id === id)
    if (!bookmark) return
    bookmark.note = note
    if (saveState()) showToast('笔记已保存')
  }

  /**
   * 批量把抓来的图标写进卡片。返回是否落盘成功。
   * 写失败就把这一批改回原样：内存和存储必须一致，否则后面每次保存都会
   * 带着这批图标再撞一次同样的上限。
   */
  function applyIcons(updates: IconUpdate[]): boolean {
    const changed = updates.flatMap(update => {
      const bookmark = state.value.bookmarks.find(item => item.id === update.id)
      if (!bookmark || !update.iconData) return []
      const previous = { bookmark, iconType: bookmark.iconType, iconData: bookmark.iconData }
      bookmark.iconType = 'image'
      bookmark.iconData = update.iconData
      // 快开入口的图标取自卡片，换了图标得重新注册一遍才会跟着变。
      if (bookmark.quick) syncQuickFeature(bookmark)
      return [previous]
    })
    if (!changed.length) return true
    if (saveState()) return true
    changed.forEach(({ bookmark, iconType, iconData }) => {
      bookmark.iconType = iconType
      bookmark.iconData = iconData
      if (bookmark.quick) syncQuickFeature(bookmark)
    })
    return false
  }

  const iconBackfill = useIconBackfill({ state, storageError, applyIcons, showToast })

  function urlsOf(bookmark: Bookmark): string[] {
    const extras: unknown[] = Array.isArray(bookmark.urls) ? bookmark.urls : []
    return [bookmark.url, ...extras.map((item: unknown) => (typeof item === 'string' ? item : (item as { value?: string })?.value))]
      .map(url => String(url || '').trim())
      .filter((url): url is string => Boolean(url) && isSafeUrl(url))
  }

  function openUrl(bookmark: Bookmark, url: string) {
    const followsDefault = !bookmark.browser || bookmark.browser === 'default'
    const useInner = bookmark.browser === 'inner' || (followsDefault && state.value.settings.browser.isOpenIn)
    if (useInner && window.utools?.ubrowser) {
      window.utools.ubrowser.goto(url).run({ width: state.value.settings.browser.width, height: state.value.settings.browser.height })
    } else if (window.funlink?.openExternal) {
      // 'default' / 'system' 都表示交给系统默认浏览器。
      window.funlink.openExternal(url, followsDefault || bookmark.browser === 'system' ? '' : bookmark.browser)
    } else window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function openLink(bookmark: Bookmark, query = '') {
    const urls = urlsOf(bookmark)
    if (!urls.length) return
    let keyword = String(query || '').trim() || search.value.trim()
    if (urls.some(hasQueryPlaceholder) && !keyword) {
      keyword = await askKeyword(`在 ${bookmark.title} 中搜索`)
      if (!keyword) return
    }
    urls.forEach(url => openUrl(bookmark, fillQueryPlaceholder(url, keyword)))
  }

  function toggleFavorite(bookmark: Bookmark) {
    bookmark.favorite = !bookmark.favorite
    if (saveState()) showToast(bookmark.favorite ? '已加入常用' : '已取消常用')
  }

  function toggleQuick(bookmark: Bookmark) {
    bookmark.quick = !bookmark.quick
    syncQuickFeature(bookmark)
    if (saveState()) showToast(bookmark.quick ? '已开启网页快开' : '已关闭网页快开')
  }

  function moveToTrash(bookmark: Bookmark) {
    bookmark.previousCategoryIds = categoryIdsOf(bookmark)
    bookmark.deletedAt = Date.now()
    bookmark.quick = false
    syncQuickFeature(bookmark)
    if (saveState()) showToast('已移到废纸篓')
  }

  function restoreBookmark(bookmark: Bookmark) {
    bookmark.categoryIds = (bookmark.previousCategoryIds || []).filter(id => id === 'cat@default' || state.value.categories.some(category => category.id === id))
    bookmark.categoryId = bookmark.categoryIds[0] || 'cat@default'
    if (!bookmark.categoryIds.length) bookmark.categoryIds = ['cat@default']
    bookmark.deletedAt = null
    delete bookmark.previousCategoryIds
    if (saveState()) showToast('网址已恢复')
  }

  function deleteBookmark(bookmark: Bookmark) {
    if (!window.confirm(`永久删除“${bookmark.title}”？此操作无法撤销。`)) return
    state.value.bookmarks = state.value.bookmarks.filter(item => item.id !== bookmark.id)
    removeQuickFeature(bookmark.id)
    if (saveState()) showToast('网址已永久删除')
  }

  function emptyTrash() {
    const deleted = state.value.bookmarks.filter(bookmark => bookmark.deletedAt)
    if (!deleted.length) return showToast('废纸篓已经是空的')
    if (!window.confirm(`永久删除废纸篓中的 ${deleted.length} 个网址？此操作无法撤销。`)) return
    state.value.bookmarks = state.value.bookmarks.filter(bookmark => !bookmark.deletedAt)
    if (saveState()) showToast('废纸篓已清空')
  }

  function reorderBookmarks(sourceId: string, targetId: string) {
    state.value.bookmarks = moveItem(state.value.bookmarks, sourceId, targetId)
    saveState()
  }

  // 分类管理里每个分类都要显示自己的卡片数。原来是每个分类各把整库过一遍，
  // 开销等于分类数乘卡片数；这里过一遍就把所有分类的数都数出来。
  const categoryCounts = computed(() => {
    const counts = new Map<string, number>()
    state.value.bookmarks.forEach(bookmark => {
      if (bookmark.deletedAt) return
      // categoryIds 在读取和保存时都经过 normalizeCategoryIds 去重，同一个分类不会数两遍。
      categoryIdsOf(bookmark).forEach(id => counts.set(id, (counts.get(id) || 0) + 1))
    })
    return counts
  })

  function categoryCount(categoryId: string) {
    return categoryCounts.value.get(categoryId) || 0
  }

  function addCategory(name: string, parentId: string, afterId = '') {
    if (!name.trim()) return
    const category: Category = { id: createId('category'), name: name.trim(), parentId, tabPosition: 'top' }
    const index = afterId ? state.value.categories.findIndex(item => item.id === afterId) : -1
    if (index >= 0) state.value.categories.splice(index + 1, 0, category)
    else state.value.categories.push(category)
    saveState()
  }

  function categoryAction(id: string, action: CategoryAction) {
    const category = state.value.categories.find(item => item.id === id)
    if (!category) return
    if (action.type === 'rename') {
      const name = action.name.trim()
      if (!name) return
      category.name = name
    }
    if (action.type === 'delete') {
      const descendants = new Set([id, ...childrenOf(id).map(item => item.id)])
      if (!action.confirmed && !window.confirm(`删除“${category.name}”？分类中的网址会移到收集箱。`)) return
      state.value.categories = state.value.categories.filter(item => !descendants.has(item.id))
      state.value.bookmarks.forEach(bookmark => {
        bookmark.categoryIds = categoryIdsOf(bookmark).filter(categoryId => !descendants.has(categoryId))
        if (!bookmark.categoryIds.length) bookmark.categoryIds = ['cat@default']
        bookmark.categoryId = bookmark.categoryIds[0]
      })
      if (descendants.has(activeCategoryId.value)) state.value.currentView = 'inbox'
    }
    if (action.type === 'position') category.tabPosition = action.position
    if (action.type === 'move') state.value.categories = moveCategory(state.value.categories, id, action.parentId, action.targetId)
    saveState()
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.value.theme
  }

  function setTheme(theme: AppState['theme']) {
    state.value.theme = theme
    saveState()
    applyTheme()
  }

  function saveSettings() {
    if (saveState()) showToast('设置已保存！')
  }

  // 原来的实现是删 dbStorage 里 cookie@ 开头的文档——那是「网址精灵」留下的东西，
  // FunLink 从不写，内置浏览器的 Cookie 也不存在那里，所以点了等于没点，还白报一句
  // 「已清空」。真正的入口只有 ubrowser 链上的 clearCookies，它按 URL 清，
  // 所以把库里所有网址的源过一遍。
  async function clearCookies() {
    const ubrowser = window.utools?.ubrowser
    if (!ubrowser) return showToast('当前环境没有内置浏览器', true)
    const origins = [...new Set(state.value.bookmarks.flatMap(urlsOf).map(originOf).filter(Boolean))]
    if (!origins.length) return showToast('没有需要清理的 Cookies')
    try {
      // 不显示窗口：只是借 ubrowser 执行一遍清理队列。
      await origins
        .reduce((chain, origin) => chain.clearCookies(origin), ubrowser.goto('about:blank'))
        .run({ show: false, width: 100, height: 100 })
      showToast('内置浏览器 Cookies 已清空')
    } catch (error) {
      showToast(`清空 Cookies 失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  function cycleTheme() {
    const order: AppState['theme'][] = ['system', 'light', 'dark']
    setTheme(order[(order.indexOf(state.value.theme) + 1) % order.length] ?? 'system')
    showToast({ system: '跟随系统主题', light: '已切换浅色主题', dark: '已切换深色主题' }[state.value.theme])
  }

  function exportBackup() {
    if (!window.confirm('导出内容为明文，可能包含网址、笔记和设置。确认备份到电脑？')) return
    const content = JSON.stringify(state.value, null, 2)
    if (window.funlink?.saveBackup?.(content)) return showToast('备份已导出')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    link.download = `funlink-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    showToast('备份已导出')
  }

  function restoreBackup(content: string): boolean {
    const parsed = JSON.parse(content)
    // 既接受 FunLink 自己的备份，也接受「网址精灵」导出的 { db, flyDb } / 裸数组。
    const source = isLegacyExport(parsed) ? convertLegacyExport(parsed).state : parsed
    const { state: restored, dropped } = prepareState(source)
    state.value = restored
    // 恢复成功即说明拿到了可用数据，可以解除只读保护。
    storageError.value = ''
    // 备份体积超过单文档上限时写不进去，这时界面上是恢复好的、存储里还是旧数据，
    // 必须按失败报出来，否则用户关掉插件才发现恢复没生效。
    const saved = saveState()
    applyTheme()
    resetQuickFeatures(state.value.bookmarks)
    if (saved) showToast(dropped ? `备份已恢复，已跳过 ${dropped} 条无效网址` : '备份已恢复')
    return saved
  }

  function importBookmarks(content: string, options: { mode?: string, tabPosition?: Category['tabPosition'] }): boolean {
    const imported = parseBookmarkHtml(content)
    if (options.mode === 'replace') {
      state.value.bookmarks.filter(bookmark => bookmark.quick).forEach(bookmark => removeQuickFeature(bookmark.id))
      state.value.categories = []
      state.value.bookmarks = []
    }
    const categoryId = createId('category-import')
    state.value.categories.push({ id: categoryId, name: '导入书签', parentId: '', tabPosition: options.tabPosition || 'left' })
    const existing = new Set(state.value.bookmarks.map(bookmark => bookmark.url))
    const bookmarks: Bookmark[] = imported.filter(bookmark => !existing.has(bookmark.url)).map((bookmark, index): Bookmark => {
      // 浏览器书签常写成「名称 - 简介」，按设置里的分隔符拆开。
      const { title, description } = splitTitle(bookmark.title, state.value.settings.importSplit)
      return {
        ...bookmark,
        id: createId('bookmark-import'),
        title: title || bookmark.title,
        description: description || displayHost(bookmark.url),
        categoryId,
        categoryIds: [categoryId],
        color: IMPORT_COLORS[index % IMPORT_COLORS.length],
        iconType: 'text',
        icon: initials(title || bookmark.title),
        urls: [],
        browser: '', favorite: false, quick: false, note: '', deletedAt: null,
      }
    })
    state.value.bookmarks.push(...bookmarks)
    state.value.currentView = `category:${categoryId}`
    const saved = saveState()
    if (saved) showToast(`已导入 ${bookmarks.length} 个网址`)
    return saved
  }

  /** 恢复备份或导入浏览器书签。两条路都可能拿到脏数据，异常统一在这里转成提示。 */
  function processDataFile(type: 'restore' | 'import', content: string, options: { mode?: string, tabPosition?: Category['tabPosition'] } = {}): boolean {
    try {
      return type === 'restore' ? restoreBackup(content) : importBookmarks(content, options)
    } catch (error) {
      showToast((error as Error).message, true)
      return false
    }
  }

  async function resetData() {
    if (!window.confirm('恢复示例数据？当前数据会被覆盖。')) return false
    state.value.bookmarks.filter(bookmark => bookmark.quick).forEach(bookmark => removeQuickFeature(bookmark.id))
    state.value = await seedState()
    // 用户明确选择了覆盖，此时解除只读保护。
    storageError.value = ''
    const saved = saveState()
    applyTheme()
    resetQuickFeatures(state.value.bookmarks)
    if (saved) showToast('已恢复示例数据')
    return saved
  }

  function setupUtools({ addBookmark }: { addBookmark: (input: Partial<Bookmark>) => void }) {
    setupUtoolsHost({
      state,
      search,
      openLink,
      addBookmark,
      // 关键词对话框的 Promise 还挂着，不解决掉下次进来对话框还在。
      dismissKeyword: () => { if (keywordPrompt.visible) resolveKeyword('') },
    })
    // 和宿主事件一起注册，都在页面初始化阶段：AI / MCP 调用不会触发进入插件事件，
    // 注册代码要是挂在那上面就永远不会执行。
    registerAiTools({ state, saveBookmark, openLink })
  }

  applyTheme()

  // 首次启动：示例数据所在的异步块到位后再填进来，这之前界面是空的。
  // 期间用户可能已经自己加了卡片，那就别覆盖人家的东西。
  if (loaded.empty) {
    seedState().then(seeded => {
      if (state.value.bookmarks.length || state.value.categories.length) return
      state.value = seeded
      applyTheme()
    })
  }

  return {
    state, search, toast, storageError, keywordPrompt, roots, activeCategoryId, activeRootId,
    secondaryCategories, secondaryPosition, trashCount, iconBackfill, applyIcons,
    currentBookmarks, defaultCategoryId, childrenOf, categoryCount,
    setView, saveBookmark, saveNote, openLink, toggleFavorite, toggleQuick, moveToTrash,
    restoreBookmark, deleteBookmark, emptyTrash, reorderBookmarks, addCategory, categoryAction,
    setTheme, cycleTheme, saveSettings, clearCookies, exportBackup, processDataFile, resetData,
    setupUtools, showToast, resolveKeyword,
  }
}
