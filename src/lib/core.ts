import type { AppState, Bookmark, Category, RawState } from './types'

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:'])

/** 将输入规范化为允许协议的绝对 URL。 */
export function normalizeUrl(value: unknown): string {
  const input = String(value || '').trim()
  if (!input) throw new Error('请输入网址')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('网址格式不正确')
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error('仅支持 http、https、ftp 和 file 网址')
  return url.href
}

// 站内搜索占位符。卡片网址里写上它，打开时换成用户输入的关键词。
// 判断、填充、去掉这三件事散在打开链路、抓图标、主搜索推送、AI 工具里一共七处，
// 字面量各写一遍的话，改规则就得同时记住七个地方。
export const QUERY_PLACEHOLDER = '{q}'

/** 是否是站内搜索类网址。这类卡片打开前必须先拿到关键词。 */
export function hasQueryPlaceholder(url: unknown): boolean {
  return String(url || '').includes(QUERY_PLACEHOLDER)
}

/** 把占位符换成关键词。关键词要 URL 编码，否则空格和中文会把地址截断。 */
export function fillQueryPlaceholder(url: string, keyword: string): string {
  return url.replaceAll(QUERY_PLACEHOLDER, encodeURIComponent(keyword))
}

/** 去掉占位符，得到一个还能请求的地址：站点首页和 /favicon.ico 兜底都还在。 */
export function stripQueryPlaceholder(url: string): string {
  return url.replaceAll(QUERY_PLACEHOLDER, '')
}

/** 是不是 http(s) 网址。只有这类才有网页图标可抓、才能发请求探活，file / ftp 没有。 */
export function isHttpUrl(value: unknown): boolean {
  return /^https?:\/\//i.test(String(value || '').trim())
}

/** 协议已经写全了的网址。没到这一步时，编辑卡片的预览区保持骨架屏。 */
export function isAbsoluteUrl(value: unknown): boolean {
  return /^(https?|ftp|file):\/\//i.test(String(value || '').trim())
}

/**
 * 一张卡片要打开的全部网址：主网址加上附加网址，去掉空的和协议不安全的。
 *
 * urls 这个字段历史上存过两种形状——字符串数组，以及 { value } 对象数组
 * （「网址精灵」的格式），两种都得认。
 */
export function urlsOf(bookmark: Bookmark): string[] {
  const extras: unknown[] = Array.isArray(bookmark.urls) ? bookmark.urls : []
  return [bookmark.url, ...extras.map((item: unknown) => (typeof item === 'string' ? item : (item as { value?: string })?.value))]
    .map(url => String(url || '').trim())
    .filter((url): url is string => Boolean(url) && isSafeUrl(url))
}

/** 判断书签是否匹配搜索词。 */
export function bookmarkMatches(bookmark: Record<string, unknown>, keyword: unknown, fields: string[] = ['title', 'description', 'url']): boolean {
  const query = String(keyword || '').trim().toLocaleLowerCase()
  if (!query) return true
  return fields.map(field => bookmark[field])
    .filter(Boolean)
    .some(value => String(value).toLocaleLowerCase().includes(query))
}

/** 从标题生成最多两个字符的图标缩写。 */
export function initials(title: unknown): string {
  const words = String(title || 'FL').trim().split(/\s+/)
  return (words.length > 1 ? words.map(word => word[0]).join('') : words[0] || '').slice(0, 2).toUpperCase()
}

/** 清理分类 ID 并保证至少保留一个默认分类。 */
export function normalizeCategoryIds(categoryIds: unknown, fallback = 'cat@default'): string[] {
  const ids = Array.isArray(categoryIds) ? categoryIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : []
  return ids.length ? [...new Set(ids)] : [fallback]
}

let idCounter = 0

/** 生成不会在同一进程内重复的实体 ID。 */
export function createId(prefix = 'id'): string {
  idCounter += 1
  const unique = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${unique}`
}

// 1.0 之前的卡片只有 categoryId / previousCategoryId，这里补齐为数组形式。
/** 将旧版书签迁移为当前结构。 */
export function migrateBookmark(bookmark: Record<string, unknown>): Bookmark {
  const next = { ...bookmark } as Bookmark
  const categoryIds = Array.isArray(bookmark.categoryIds) && bookmark.categoryIds.length
    ? bookmark.categoryIds
    : [bookmark.categoryId].filter(Boolean)
  next.categoryIds = normalizeCategoryIds(categoryIds)
  next.categoryId = next.categoryIds[0]

  const previous: unknown[] = Array.isArray(bookmark.previousCategoryIds)
    ? bookmark.previousCategoryIds
    : [bookmark.previousCategoryId].filter(Boolean)
  if (previous.length) next.previousCategoryIds = previous.filter((id): id is string => typeof id === 'string' && Boolean(id))
  delete next.previousCategoryId

  // 旧版把 iconType 默认设成 image 却从不写 iconData——图标是渲染时去第三方 favicon 服务现取的。
  // 现在图标一律存在本地（添加时抓一次），这类卡片回落成文字图标，否则会显示成空白圆圈。
  // iconRef 也算有图：图标存进附件之后卡片上只剩这个 ID（见 lib/iconStore.ts）。
  if (next.iconType === 'image' && !next.iconData && !next.iconRef) next.iconType = 'text'
  return next
}

// 丢弃协议不安全的卡片（例如 javascript:），但不因为单条脏数据让整次恢复失败。
/** 迁移并过滤备份状态中的不安全网址。 */
export function migrateState(value: RawState): { state: Omit<AppState, 'settings'> & Record<string, unknown>, dropped: number } {
  const bookmarks = value.bookmarks.filter(bookmark => isSafeUrl(bookmark?.url)).map(migrateBookmark)
  return {
    state: {
      ...value,
      categories: value.categories.map((category): Category => ({
        id: String(category.id),
        name: String(category.name || ''),
        parentId: String(category.parentId || ''),
        tabPosition: (category.tabPosition as Category['tabPosition']) || 'top',
      })),
      bookmarks,
    } as Omit<AppState, 'settings'> & Record<string, unknown>,
    dropped: value.bookmarks.length - bookmarks.length,
  }
}

// 导入书签时按用户配置的分隔符把「名称 - 简介」拆开，长分隔符优先。
/** 按配置分隔符拆分导入书签标题。 */
export function splitTitle(rawTitle: unknown, separators = ''): { title: string, description: string } {
  const title = String(rawTitle || '').trim()
  const marks = String(separators || '')
    .split(',')
    .map(mark => mark.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const mark of marks) {
    const index = title.indexOf(mark)
    if (index > 0 && index < title.length - mark.length) {
      return { title: title.slice(0, index).trim(), description: title.slice(index + mark.length).trim() }
    }
  }
  return { title, description: '' }
}

/** 将列表项移动到目标项位置。 */
export function moveItem<T extends { id: string }>(items: T[], sourceId: string, targetId: string): T[] {
  const from = items.findIndex(item => item.id === sourceId)
  const to = items.findIndex(item => item.id === targetId)
  if (from < 0 || to < 0 || from === to) return items
  const next = items.slice()
  // 用展开而不是 next.splice(from, 1)[0]：下标访问的类型带 undefined，
  // 而这里 from 已经校验过，取出来一定是一条。
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

/** 移动分类并更新父分类。 */
export function moveCategory(items: Category[], sourceId: string, parentId: string, targetId = ''): Category[] {
  const from = items.findIndex(item => item.id === sourceId)
  if (from < 0 || sourceId === targetId) return items
  const next = items.slice()
  const removed = next.splice(from, 1)[0]
  // from 已校验 >= 0，splice 必然取到一条；这个判空只是为了让下标访问的类型落地。
  if (!removed) return items
  const category: Category = { ...removed, parentId }
  const target = targetId ? next.findIndex(item => item.id === targetId) : -1
  if (target >= 0) next.splice(target, 0, category)
  else {
    const sibling = next.reduce((last, item, index) => item.parentId === parentId ? index : last, -1)
    next.splice(sibling + 1, 0, category)
  }
  return next
}

/** 验证 FunLink 备份的基本结构。 */
export function validateState(value: unknown): RawState {
  const candidate = value as Partial<RawState> | null | undefined
  if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.categories) || !Array.isArray(candidate.bookmarks)) {
    throw new Error('不是有效的 FunLink 备份')
  }
  return candidate as RawState
}

/** 判断网址是否使用允许的协议。 */
export function isSafeUrl(value: unknown): boolean {
  try {
    normalizeUrl(value)
    return true
  } catch {
    return false
  }
}

/** 从浏览器书签 HTML 中提取去重后的网址。 */
export function parseBookmarkHtml(html: string): { title: string, url: string }[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [...document.querySelectorAll('a[href]')].flatMap((anchor): { title: string, url: string }[] => {
    try {
      const url = normalizeUrl(anchor.getAttribute('href'))
      return [{ title: anchor.textContent?.trim() || new URL(url).hostname, url }]
    } catch {
      return []
    }
  }).filter((bookmark, index, all) => all.findIndex(item => item.url === bookmark.url) === index)
}

/** 取网址的源（协议 + 域名 + 端口），解析不出来时返回空串。 */
export function originOf(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

/** 从网址提取展示用主机名。 */
export function displayHost(url: string): string {
  try { return new URL(url).hostname || url } catch { return url }
}

/**
 * 文字图标的轮换底色。
 * 导入浏览器书签和迁移「网址精灵」备份两条链路都用它：各存一份的话，
 * 同一批数据从不同入口进来颜色就不一样了。
 */
export const IMPORT_COLORS = ['#16b8c7', '#2563eb', '#7c3aed', '#db2777', '#e85d3f', '#0f9f6e', '#64748b']

/** 校验颜色值，非法值回退到默认颜色。 */
export function safeColor(value: unknown): string {
  const text = String(value || '')
  return /^(#[\da-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(text) ? text : '#16b8c7'
}
