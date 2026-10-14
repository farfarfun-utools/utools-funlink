import { bookmarkMatches, hasQueryPlaceholder } from './core'
import { categoryIdsOf } from './state'
import type { AppState, Bookmark, Category } from './types'

// 「当前该显示哪些卡片」这组推导只依赖状态和搜索词，和 Vue 无关，
// 所以放在 lib 里写成纯函数，组合式函数只负责把它们包成 computed。
const CATEGORY_PREFIX = 'category:'

/** 取某个分类的直接子分类。 */
export function childrenOf(categories: Category[], parentId: string): Category[] {
  return categories.filter(category => category.parentId === parentId)
}

/**
 * 一级分类，即顶部导航上的那几项。
 * 这里按 parentId 为假判断，不写成 childrenOf(categories, '')：旧备份里的分类
 * 可能压根没有 parentId 字段，严格比 '' 会把它们从导航上漏掉。
 */
export function rootCategories(categories: Category[]): Category[] {
  return categories.filter(category => !category.parentId)
}

/**
 * 当前视图落在哪个分类上，不在分类视图时返回空串。
 * 废纸篓沿用进废纸篓之前的分类，这样二级导航不会在切到废纸篓时整条消失。
 */
export function activeCategoryId(state: AppState): string {
  if (state.currentView.startsWith(CATEGORY_PREFIX)) return state.currentView.slice(CATEGORY_PREFIX.length)
  return state.currentView === 'trash' ? state.lastCategoryId : ''
}

/** 当前分类所属的一级分类，二级导航据此渲染。 */
export function activeRootId(state: AppState): string {
  const category = state.categories.find(item => item.id === activeCategoryId(state))
  return category?.parentId || category?.id || ''
}

/** 新建卡片时默认落在哪个分类。 */
export function defaultCategoryId(state: AppState): string {
  if (state.currentView === 'inbox') return 'cat@default'
  const categoryId = activeCategoryId(state)
  return state.categories.some(category => category.id === categoryId) ? categoryId : 'cat@default'
}

/** 当前视图下的卡片集合，还没应用搜索词。 */
function viewBookmarks(state: AppState, searching: boolean): Bookmark[] {
  // 废纸篓要先判断：否则一搜索就跳去搜全部未删除卡片，废纸篓里反而搜不到东西。
  if (state.currentView === 'trash') return state.bookmarks.filter(bookmark => bookmark.deletedAt)
  const active = state.bookmarks.filter(bookmark => !bookmark.deletedAt)
  if (searching || state.currentView === 'all') return active
  if (state.currentView === 'favorites') return active.filter(bookmark => bookmark.favorite)
  if (state.currentView === 'quick') return active.filter(bookmark => bookmark.quick)
  if (state.currentView === 'inbox') {
    return active.filter(bookmark => {
      const categoryIds = categoryIdsOf(bookmark)
      return !categoryIds.length || categoryIds.includes('cat@default')
    })
  }
  // 停在一级分类上时连它的子分类一起显示，否则刚建完子分类的父分类看起来是空的。
  const categoryId = activeCategoryId(state)
  const category = state.categories.find(item => item.id === categoryId)
  const ids = category && !category.parentId
    ? new Set([category.id, ...childrenOf(state.categories, category.id).map(item => item.id)])
    : new Set([categoryId])
  return active.filter(bookmark => categoryIdsOf(bookmark).some(id => ids.has(id)))
}

/** 当前视图加搜索词下应该显示的卡片。 */
export function visibleBookmarks(state: AppState, search: string): Bookmark[] {
  const keyword = search.trim()
  return viewBookmarks(state, Boolean(keyword)).filter(bookmark => bookmarkMatches(bookmark, keyword, state.settings.search))
}

/** 主搜索框里能直接打开的卡片，最多 limit 条。 */
export function pushableBookmarks(state: AppState, keyword: string, limit = 6): Bookmark[] {
  return state.bookmarks
    // 带 {q} 的卡片得先输关键词，而主搜索框里没法弹对话框，直接排除。
    .filter(bookmark => !bookmark.deletedAt && !hasQueryPlaceholder(bookmark.url) && bookmarkMatches(bookmark, keyword, state.settings.search))
    .slice(0, limit)
}
