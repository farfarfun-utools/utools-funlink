// 整库状态的中枢：持有 state、负责落盘，并把界面要用的推导和操作拼在一起。
// 打开卡片、整库进出、批量抓图标各自成一个 composable（见 useOpenLink /
// useDataTransfer / useIconBackfill），这里只留状态本身和卡片、分类的增删改。
import { computed, ref } from 'vue'
import { createId, moveCategory, moveItem, normalizeCategoryIds } from '../lib/core'
import { removeQuickFeature, syncQuickFeature } from '../lib/features'
import { iconRefFor, storeIcon } from '../lib/iconStore'
import { STORAGE_KEY, categoryIdsOf, loadState } from '../lib/state'
import { commitStorage, readStorage, serializeForStorage } from '../lib/storage'
import * as views from '../lib/views'
import type { AppState, Bookmark, Category, CategoryAction } from '../lib/types'
import type { IconUpdate } from '../lib/icons'
import { registerAiTools } from './useAiTools'
import { seedState, useDataTransfer } from './useDataTransfer'
import { useIconAttachments } from './useIconAttachments'
import { useIconBackfill } from './useIconBackfill'
import { useKeywordPrompt } from './useKeywordPrompt'
import { useOpenLink } from './useOpenLink'
import { useToast } from './useToast'
import { setupUtoolsHost } from './useUtoolsHost'

export { PLUGIN_HEIGHT } from './useUtoolsHost'

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

  // 图标存进数据库附件（整库文档里只留一个 ID），迁移和清理都在这里。
  const { offloadIcons, syncIconAttachments } = useIconAttachments({ state, storageError, saveState })

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
    // 图标存在数据库附件里，卡片上只留一个附件 ID。对话框回传的是 data URL
    // （预览、上传都要它），这里按内容哈希比一下：和已存的是同一张就继续用原来的 ID，
    // 换了图就先内联落盘，随后由 offloadIcons 挪进附件。
    if (bookmark.iconType === 'image' && bookmark.iconData) {
      if (iconRefFor(bookmark.iconData) === bookmark.iconRef) delete bookmark.iconData
      else delete bookmark.iconRef
    } else if (bookmark.iconType !== 'image') delete bookmark.iconRef
    if (previous) state.value.bookmarks[state.value.bookmarks.indexOf(previous)] = bookmark
    else if (afterId) state.value.bookmarks.splice(state.value.bookmarks.findIndex(item => item.id === afterId) + 1, 0, bookmark)
    else state.value.bookmarks.push(bookmark)
    syncQuickFeature(bookmark)
    const saved = saveState()
    if (saved) {
      showToast(previous ? '网址已更新' : '网址已添加')
      // 保存本身必须是同步的（AI 工具按返回值报成败），所以新图标先内联落盘，
      // 挪进附件在后台接着做。
      void offloadIcons()
    }
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
  async function applyIcons(updates: IconUpdate[]): Promise<boolean> {
    // 先存附件再落盘：这样整库文档里每张图标只多出一个 ID，图标本身不占那 1MB
    // 的额度，几百张卡片一次抓完也不会把文档顶到上限。
    const refs = new Map<string, string>()
    for (const update of updates) {
      const ref = update.iconData ? await storeIcon(update.iconData) : ''
      if (ref) refs.set(update.id, ref)
    }
    const changed = updates.flatMap(update => {
      const bookmark = state.value.bookmarks.find(item => item.id === update.id)
      if (!bookmark || !update.iconData) return []
      const previous = { bookmark, iconType: bookmark.iconType, iconData: bookmark.iconData, iconRef: bookmark.iconRef }
      const ref = refs.get(update.id)
      bookmark.iconType = 'image'
      if (ref) {
        bookmark.iconRef = ref
        delete bookmark.iconData
      } else {
        // 存不进附件（不在 uTools 里、写入失败）就还是内联在卡片上。
        bookmark.iconData = update.iconData
        delete bookmark.iconRef
      }
      // 快开入口的图标取自卡片，换了图标得重新注册一遍才会跟着变。
      if (bookmark.quick) syncQuickFeature(bookmark)
      return [previous]
    })
    if (!changed.length) return true
    if (saveState()) return true
    changed.forEach(({ bookmark, ...icon }) => {
      // 字段可能本来就没有，赋成 undefined 和没有这个字段在序列化时是一回事。
      Object.assign(bookmark, icon)
      if (bookmark.quick) syncQuickFeature(bookmark)
    })
    return false
  }

  const iconBackfill = useIconBackfill({ state, storageError, applyIcons, showToast })

  const { openLink, clearCookies } = useOpenLink({ state, search, askKeyword, showToast })

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

  function cycleTheme() {
    const order: AppState['theme'][] = ['system', 'light', 'dark']
    setTheme(order[(order.indexOf(state.value.theme) + 1) % order.length] ?? 'system')
    showToast({ system: '跟随系统主题', light: '已切换浅色主题', dark: '已切换深色主题' }[state.value.theme])
  }

  const { exportBackup, processDataFile, resetData } = useDataTransfer({
    state, storageError, saveState, showToast, applyTheme,
    syncIcons: () => { void syncIconAttachments() },
  })

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
    // 图标的迁移、预读、清理都要读写数据库，放在这里一并启动：
    // 首屏已经渲染出来了，这一轮在后台跑，图标读到哪张哪张就显示出来。
    void syncIconAttachments()
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
