// 整库收藏都存在 uTools 的单个数据库文档里，上限 1MB（见 lib/storage.ts）。
// 图标是唯一会把体积顶到这个量级的字段：一张 200KB 的图转成 base64 要占 267KB，
// 四张就把整个文档写崩。所以存之前先按显示尺寸压一遍，让单张图标稳定在几 KB。

import { initials, safeColor } from './core'
import type { Bookmark } from './types'

// 图标最大边长。卡片上渲染为 42px，128px 已经覆盖 3 倍 HiDPI。
const MAX_EDGE = 128

// 本来就小的图原样存：重新编码有可能反而更大（16×16 的 png 尤其明显）。
const KEEP_AS_IS_BYTES = 16 * 1024

// 自动抓来的图标比用户自己选的更要省体积：开了自动抓取，等于每张卡片都带一张图，
// 而整库共用 1MB。64px 在 42px 的卡片上足够清楚。
const FETCHED_MAX_EDGE = 64

// 压不动的格式（svg / ico 解不开位图，只能原样留）超过这个体积就不要了：
// 一张自动抓来的图标不值得占掉几十 KB 的公共额度。
const MAX_FETCHED_BYTES = 32 * 1024

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 把图片文件转成有界的 data URL：按最大边长等比缩放后重新编码。
 * @param file 用户选的图片
 * @param maxEdge 缩放后的最大边长
 */
export async function toIconDataUrl(file: Blob, maxEdge: number = MAX_EDGE): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // svg 这类没有固有尺寸的图片解不开位图，原样存。
    // 这种文件通常只有几 KB，不会把文档撑爆。
    return readAsDataUrl(file)
  }

  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) return await readAsDataUrl(file)

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // webp 保留透明通道，同画质下比 png 小一个量级；
    // 引擎不支持时 toDataURL 会静默退回 png，结果依然可用。
    return canvas.toDataURL('image/webp', 0.9)
  } finally {
    bitmap.close()
  }
}

/** 把 data URL 解回 Blob。解析不出来返回 null（当成抓取失败处理）。 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const matched = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!matched) return null
  const [, mime, base64, data] = matched
  try {
    if (!base64) return new Blob([decodeURIComponent(data ?? '')], { type: mime })
    const binary = atob(data ?? '')
    return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: mime })
  } catch {
    return null
  }
}

/**
 * 抓取网址对应站点的图标，压好之后返回 data URL；拿不到返回空串。
 *
 * 真正的请求在 preload 的 Node 侧（页面 CSP 不允许往外拉图，渲染进程也会撞 CORS），
 * 这里只负责把抓回来的图压到能进存储的体积。
 */
export async function fetchSiteIcon(url: string): Promise<string> {
  try {
    const raw = await window.funlink?.fetchIcon?.(url)
    if (!raw) return ''
    const blob = dataUrlToBlob(raw)
    if (!blob) return ''
    const icon = await toIconDataUrl(blob, FETCHED_MAX_EDGE)
    return icon.length <= MAX_FETCHED_BYTES ? icon : ''
  } catch {
    // 抓图标是顺手做的事，失败就让调用方保持文字图标。
    return ''
  }
}

// uTools 主搜索框只认图片：推送结果和动态指令的 icon 要么是插件目录里的文件路径，
// 要么是 data URL，没法把界面上那套「底色 + 文字」直接交过去。所以文字图标在这里
// 画成一张小图，否则主搜索里所有卡片都长着同一个插件 logo，根本分不出谁是谁。
const TEXT_ICON_EDGE = 64

// 同一张卡片的图标会被反复要（主搜索框每敲一个字都要重算一遍推送列表），
// 画一次存下来。键里带上文字和颜色，改了图标就自然算成另一张。
const textIcons = new Map<string, string>()

/** 把「底色 + 文字」的图标画成 png data URL。画不出来（拿不到画布）返回空串。 */
export function textIconDataUrl(text: string, color: string): string {
  const key = `${color}|${text}`
  const cached = textIcons.get(key)
  if (cached != null) return cached

  // 这个函数在 onMainPush 里被调用，主搜索框每敲一个字都走一遍。画布取不到
  // （不在浏览器环境里）只是没有图标，不该把整个推送列表一起带崩，所以整段兜住。
  try {
    const canvas = document.createElement('canvas')
    canvas.width = TEXT_ICON_EDGE
    canvas.height = TEXT_ICON_EDGE
    const context = canvas.getContext('2d')
    if (!context) return ''
    const center = TEXT_ICON_EDGE / 2
    context.fillStyle = color
    context.beginPath()
    context.arc(center, center, center, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#fff'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    // 文字图标最多 4 个字，字多了要缩一号，不然会顶出圆外。
    context.font = `500 ${Math.round(TEXT_ICON_EDGE * (text.length > 2 ? 0.3 : 0.44))}px sans-serif`
    context.fillText(text, center, center)
    const dataUrl = canvas.toDataURL('image/png')
    textIcons.set(key, dataUrl)
    return dataUrl
  } catch {
    return ''
  }
}

/** 卡片交给 uTools 用的图标：图片图标直接用，文字图标现画一张，都拿不到才回落插件 logo。 */
export function bookmarkIconUrl(bookmark: Bookmark): string {
  if (bookmark.iconType === 'image' && bookmark.iconData) return bookmark.iconData
  return textIconDataUrl(bookmark.icon || initials(bookmark.title), safeColor(bookmark.color)) || 'logo.png'
}
