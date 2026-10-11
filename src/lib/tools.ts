// AI Agent 和 MCP 客户端调用插件时的工具逻辑。
//
// 这里只做纯推导：校验参数、按条件挑卡片、把卡片整理成适合 AI 读的形状。
// 注册和落盘在 composables/useAiTools.ts，分开写这组逻辑才能直接跑单测。
//
// 故意不提供删除卡片、清空废纸篓、恢复备份这类破坏性操作：工具一旦开给第三方
// Agent，调用时机就不在用户视野里了，误删整库的代价远大于省下的几次点击。

import { bookmarkMatches, createId, displayHost, initials, normalizeUrl } from './core'
import { categoryIdsOf } from './state'
import type { AppState, Bookmark } from './types'

// 收集箱不是真实分类，它只是「没指定分类」的卡片落点，所以不在 state.categories 里。
const INBOX_ID = 'cat@default'
const INBOX_NAME = '收集箱'

const DEFAULT_LIMIT = 10
// 整库可能有上千条，一次全丢给 AI 既占上下文又没意义。
const MAX_LIMIT = 50

/** 给 AI 看的卡片。图标数据和笔记正文这类又长又用不上的字段不往外传。 */
export interface ToolBookmark {
  id: string
  title: string
  url: string
  description: string
  /** 分类名称，而不是 id——AI 读得懂名称，追问时用户也对得上。 */
  categories: string[]
  favorite: boolean
  quick: boolean
  hasNote: boolean
}

export interface ToolCategory {
  id: string
  name: string
  parentId: string
  count: number
}

function categoryName(state: AppState, id: string): string {
  if (id === INBOX_ID) return INBOX_NAME
  return state.categories.find(category => category.id === id)?.name || id
}

function countIn(state: AppState, categoryId: string): number {
  return state.bookmarks.filter(bookmark => !bookmark.deletedAt && categoryIdsOf(bookmark).includes(categoryId)).length
}

/** 把一条卡片整理成工具返回值。 */
export function describeBookmark(state: AppState, bookmark: Bookmark): ToolBookmark {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    description: bookmark.description || '',
    categories: categoryIdsOf(bookmark).map(id => categoryName(state, id)),
    favorite: Boolean(bookmark.favorite),
    quick: Boolean(bookmark.quick),
    // 笔记正文可能有几千字，这里只告诉 AI 有没有，要看再去插件里看。
    hasNote: Boolean(bookmark.note),
  }
}

function clampLimit(value: unknown): number {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

/**
 * 按关键词搜收藏。关键词留空就返回收藏列表的开头几条。
 * 匹配字段跟界面搜索保持一致（settings.search），结果里不含废纸篓的卡片。
 */
export function searchBookmarks(state: AppState, params: Record<string, unknown> = {}): { total: number, bookmarks: ToolBookmark[] } {
  const keyword = String(params.keyword ?? '').trim()
  const matched = state.bookmarks.filter(bookmark => !bookmark.deletedAt && bookmarkMatches(bookmark, keyword, state.settings.search))
  // total 给的是命中总数而不是返回条数，AI 据此判断要不要换个更准的关键词。
  return {
    total: matched.length,
    bookmarks: matched.slice(0, clampLimit(params.limit)).map(bookmark => describeBookmark(state, bookmark)),
  }
}

/** 列出分类和各自的卡片数，AI 据此决定新卡片放哪。 */
export function listCategories(state: AppState): { categories: ToolCategory[] } {
  return {
    categories: [
      // 收集箱排在最前：它是不指定分类时的落点，但不在 categories 里，不列出来 AI 就不知道有这个去处。
      { id: INBOX_ID, name: INBOX_NAME, parentId: '', count: countIn(state, INBOX_ID) },
      ...state.categories.map((category): ToolCategory => ({
        id: category.id,
        name: category.name,
        parentId: category.parentId,
        count: countIn(state, category.id),
      })),
    ],
  }
}

/** 把 AI 给的分类（id 或名称）解析成分类 id，留空落到收集箱。 */
export function resolveCategoryId(state: AppState, value: unknown): string {
  const input = String(value ?? '').trim()
  if (!input || input === INBOX_ID || input === INBOX_NAME) return INBOX_ID
  const matched = state.categories.find(category => category.id === input)
    || state.categories.find(category => category.name === input)
  // 猜一个分类塞进去不如报错：卡片落错地方用户未必会发现，而 Agent 收到错误会改参数重试。
  if (!matched) throw new Error(`没有找到分类“${input}”，可以先调用 list_categories 看看有哪些分类`)
  return matched.id
}

/** 按 AI 给的参数拼出一张待保存的卡片；网址非法时抛错。 */
export function buildBookmark(state: AppState, params: Record<string, unknown> = {}): Bookmark {
  // normalizeUrl 会补协议并挡掉 javascript: 之类，错误信息本身就能直接给 AI 看。
  const url = normalizeUrl(params.url)
  const title = String(params.title ?? '').trim() || displayHost(url)
  const categoryId = resolveCategoryId(state, params.category)
  return {
    // 自己生成 id 而不是让保存链路生成，返回值里才能带上它，AI 后续能直接按 id 打开。
    id: createId('bookmark-tool'),
    title,
    url,
    description: String(params.description ?? '').trim() || displayHost(url),
    categoryId,
    categoryIds: [categoryId],
    // 不指定配色：safeColor 会回落到默认色，不值得为此再抄一份调色板。
    iconType: 'text',
    icon: initials(title),
    iconSize: 16,
    urls: [],
    browser: '',
    favorite: false,
    quick: false,
    note: '',
    deletedAt: null,
  }
}

/** 库里是否已有同网址的卡片。Agent 失败重试很常见，同一个网址不该收藏出两张卡片。 */
export function findByUrl(state: AppState, url: string): Bookmark | undefined {
  return state.bookmarks.find(bookmark => !bookmark.deletedAt && bookmark.url === url)
}

/** 按 id 或关键词定位一张卡片，定位不到就抛错让 AI 换参数重试。 */
export function findBookmark(state: AppState, params: Record<string, unknown> = {}): Bookmark {
  const id = String(params.id ?? '').trim()
  if (id) {
    const matched = state.bookmarks.find(bookmark => bookmark.id === id && !bookmark.deletedAt)
    if (!matched) throw new Error(`没有找到 id 为 ${id} 的网址`)
    return matched
  }
  const keyword = String(params.keyword ?? '').trim()
  if (!keyword) throw new Error('请给出 id 或 keyword，用来指定要打开哪个网址')
  // 取第一条而不是报「有多条匹配」：收藏列表本身是按用户排的序，最靠前的最符合预期。
  const matched = state.bookmarks.find(bookmark => !bookmark.deletedAt && bookmarkMatches(bookmark, keyword, state.settings.search))
  if (!matched) throw new Error(`没有匹配“${keyword}”的网址，可以先调用 search_bookmarks 确认收藏里有没有`)
  return matched
}
