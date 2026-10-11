import type { Bookmark } from './types'

// 「网页快开」会把卡片注册成 uTools 的功能入口，code 统一用这个前缀。
// 整体替换数据时按前缀就能认出哪些入口是本插件注册的。
const PREFIX = 'open-link@'

/** 移除一张卡片的快开入口。卡片删除、移进废纸篓、关掉快开都要调。 */
export function removeQuickFeature(id: string): void {
  window.utools?.removeFeature?.(`${PREFIX}${id}`)
}

/** 按卡片当前的 quick 状态注册或移除快开入口。 */
export function syncQuickFeature(bookmark: Bookmark): void {
  if (!window.utools?.setFeature) return
  if (!bookmark.quick) return removeQuickFeature(bookmark.id)
  // 带 {q} 的卡片要能接着输关键词，所以多注册一条 over 类型的指令。
  const cmds: Feature['cmds'] = bookmark.url.includes('{q}')
    ? [bookmark.title, { type: 'over', label: bookmark.title }]
    : [bookmark.title]
  window.utools.setFeature({ code: `${PREFIX}${bookmark.id}`, description: `打开 ${bookmark.title}`, icon: 'logo.png', mainHide: true, cmds })
}

/**
 * 整体替换数据后（恢复备份 / 重置）重建快开入口。
 * 必须先按前缀清掉已注册的，否则旧入口还留在 uTools 里，而新数据的一个都没注册。
 */
export function resetQuickFeatures(bookmarks: Bookmark[]): void {
  if (!window.utools?.setFeature) return
  window.utools.getFeatures?.()?.forEach((feature: { code?: string }) => {
    if (feature?.code?.startsWith(PREFIX)) window.utools.removeFeature?.(feature.code)
  })
  bookmarks.filter(bookmark => bookmark.quick && !bookmark.deletedAt).forEach(syncQuickFeature)
}

/** 从快开入口的 code 还原出卡片 id；不是快开入口时返回空串。 */
export function quickFeatureTarget(code: string): string {
  return code.startsWith(PREFIX) ? code.slice(PREFIX.length) : ''
}
