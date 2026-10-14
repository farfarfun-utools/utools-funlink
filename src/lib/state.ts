import { migrateState, normalizeCategoryIds, validateState } from './core'
import type { AppState, Bookmark, Settings } from './types'

// 纯状态逻辑：不依赖 vue / uTools / 示例数据，方便直接跑单测。
export const STORAGE_KEY = 'funlink-state-v1'

export const DEFAULT_SETTINGS: Settings = {
  browser: { isOpenIn: false, width: 1000, height: 680 },
  search: ['title', 'description', 'url'],
  importSplit: '-,_,|,:,/,||',
  navbar: { rounded: 36 },
  autoIcon: true,
}

/** 读取书签的兼容分类 ID 列表。 */
export function categoryIdsOf(bookmark: Bookmark): string[] {
  return bookmark.categoryIds || (bookmark.categoryId ? [bookmark.categoryId] : [])
}

/** 创建空白应用状态。 */
export function emptyState(): AppState {
  return {
    version: 1,
    theme: 'system',
    currentView: 'inbox',
    lastCategoryId: '',
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    categories: [],
    bookmarks: [],
  }
}

/** 补齐状态中的默认配置和兼容字段。 */
export function hydrateState(state: Omit<AppState, 'settings'> & { settings?: Partial<Settings> }): AppState {
  const hydrated = state as AppState
  hydrated.settings = {
    ...DEFAULT_SETTINGS,
    ...state.settings,
    browser: { ...DEFAULT_SETTINGS.browser, ...state.settings?.browser },
    navbar: { ...DEFAULT_SETTINGS.navbar, ...state.settings?.navbar },
    search: state.settings?.search?.length ? state.settings.search : DEFAULT_SETTINGS.search.slice(),
  }
  hydrated.theme ||= 'system'
  hydrated.currentView ||= 'inbox'
  // migrateState 已保证 categoryIds 非空，这里再兜一次，避免手工编辑过的备份。
  hydrated.bookmarks.forEach(bookmark => {
    bookmark.categoryIds = normalizeCategoryIds(categoryIdsOf(bookmark))
    bookmark.categoryId = bookmark.categoryIds[0]
  })
  hydrated.lastCategoryId ||= hydrated.currentView.startsWith('category:') ? hydrated.currentView.slice(9) : hydrated.categories[0]?.id || ''
  return hydrated
}

/** 校验、迁移并补齐已保存状态。 */
export function prepareState(saved: unknown): { state: AppState, dropped: number } {
  const { state, dropped } = migrateState(validateState(saved))
  return { state: hydrateState(state), dropped }
}

// 读不出来时绝不能拿演示数据顶上——那会在下一次写入时覆盖掉用户的真实数据。
// 返回 blocked 时由界面提示用户，并暂停一切写入。
/**
 * 从存储读取状态，失败时返回只读提示而不覆盖数据。
 *
 * 存储确实为空（首次启动）时返回 `empty: true` 的空状态，灌不灌示例数据交给调用方：
 * 示例数据有 84KB，放在这里就只能同步 import 进来，而它只有首次启动才用得到。
 */
export function loadState({ read }: { read: (key: string) => unknown }): { state: AppState, blocked: string, dropped: number, empty: boolean } {
  let saved: unknown
  try {
    saved = read(STORAGE_KEY)
  } catch (error) {
    return { state: emptyState(), blocked: `本地数据读取失败：${(error as Error).message}。`, dropped: 0, empty: false }
  }
  if (!saved) return { state: emptyState(), blocked: '', dropped: 0, empty: true }
  try {
    const { state, dropped } = prepareState(saved)
    return { state, blocked: '', dropped, empty: false }
  } catch (error) {
    return { state: emptyState(), blocked: `本地数据无法解析：${(error as Error).message}。`, dropped: 0, empty: false }
  }
}
