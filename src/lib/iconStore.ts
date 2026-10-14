// 图标附件存储。
//
// 图标原来和整库一起塞在 uTools 的那个单文档里（上限 1MB，见 lib/storage.ts）：
// 一张压好的图标 base64 之后一两 KB 到几 KB，几百张卡片各带一张就能把文档顶到上限，
// 而且每改一个字段都要把所有图标重新序列化、重新落盘、重新同步一遍。
//
// 挪进附件（utools.db.postAttachment）之后，文档里每张图标只剩一个几十字节的 ID，
// 图标自己按内容寻址存一份：
//
// - 附件 ID 就是内容哈希，同一张图（同一个站点的 favicon、同一张上传的图片）
//   被多张卡片引用时只存一份，第二张连写入都不会发生；
// - 附件接口只能创建不能更新，内容寻址正好不需要更新——内容变了就是另一个 ID。
//
// 不在 uTools 里（浏览器预览、单测）或者写入失败时，图标继续以 data URL 内联在卡片上，
// 界面行为完全不变，只是没有省体积和去重的好处。

import { bytesToDataUrl, dataUrlToBytes } from './dataurl'
import type { AppState, Bookmark } from './types'

/** 图标附件 ID 的前缀。按前缀就能把图标附件从数据库里列出来。 */
export const ICON_REF_PREFIX = 'icon@'

/** 是不是图标附件 ID。 */
export function isIconRef(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ICON_REF_PREFIX)
}

/**
 * 内容哈希（cyrb53）。
 *
 * 只用来给「同样的字节」算出「同样的 ID」，不是密码学用途，所以没用 crypto.subtle：
 * 那套接口是异步的，而图标要在渲染、保存、迁移三条路上同步算出 ID，
 * 换成异步会把这三处全染成异步。哈希之外 ID 里还带着长度，两张图要撞 ID
 * 得同时撞上 53 位哈希和字节数。
 */
export function contentHash(text: string): string {
  let head = 0xdeadbeef
  let tail = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    head = Math.imul(head ^ code, 2654435761)
    tail = Math.imul(tail ^ code, 1597334677)
  }
  head = Math.imul(head ^ (head >>> 16), 2246822507) ^ Math.imul(tail ^ (tail >>> 13), 3266489909)
  tail = Math.imul(tail ^ (tail >>> 16), 2246822507) ^ Math.imul(head ^ (head >>> 13), 3266489909)
  return (4294967296 * (2097151 & tail) + (head >>> 0)).toString(36)
}

/** 一张图标的附件 ID。空图标返回空串。 */
export function iconRefFor(dataUrl: unknown): string {
  const text = String(dataUrl || '')
  if (!text) return ''
  return `${ICON_REF_PREFIX}${contentHash(text)}-${text.length.toString(36)}`
}

// 读出来的图标按附件 ID 缓存。值是能直接喂给 <img src> 的 data URL，
// 空串表示「确实没这张附件」（和 undefined 的「还没读过」要分开，见 bookmarkIcon）。
const cache = new Map<string, string>()
// 正在读的请求。首屏一批卡片常引用同一张图标，不拦一下就是同一个附件读好几遍。
const loading = new Map<string, Promise<string>>()
const listeners = new Set<() => void>()
let notifying = false

function notifyLater() {
  if (notifying || !listeners.size) return
  notifying = true
  // 一轮预读要读几百张图标，每读到一张就通知一次等于几百次重渲染。
  // 攒到微任务末尾发一次，这一轮读进来的图标就一起出现。
  Promise.resolve().then(() => {
    notifying = false
    listeners.forEach(listener => listener())
  })
}

/** 订阅「又有图标读进缓存了」。返回取消订阅的函数。 */
export function subscribeIcons(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function store() {
  return window.utools?.db?.promises
}

/** 附件存储是否可用。浏览器预览和单测里没有 uTools，这时图标继续内联在卡片上。 */
export function iconStoreAvailable(): boolean {
  return Boolean(store()?.postAttachment)
}

/** 已经读进内存的图标。没读到过返回空串。 */
export function cachedIcon(ref: unknown): string {
  return cache.get(String(ref || '')) || ''
}

/**
 * 卡片当前能显示的图标。
 *
 * pending 为真表示「这张卡片有图，但附件还没读出来」——此时既不该显示文字图标
 * （一眼就会看到图标从首字母跳成图片），也不该当成没有图标。
 */
export function bookmarkIcon(bookmark: Bookmark): { url: string, pending: boolean } {
  if (bookmark.iconType !== 'image') return { url: '', pending: false }
  const ref = String(bookmark.iconRef || '')
  const cached = ref ? cache.get(ref) : undefined
  if (cached) return { url: cached, pending: false }
  // 内联的 data URL 既是老数据的形态，也是附件还没写成功时的形态，都直接能用。
  const inline = String(bookmark.iconData || '')
  if (inline) return { url: inline, pending: false }
  // 读出来是空的（附件被另一台设备清掉了）就不再等，让卡片回落成文字图标。
  return { url: '', pending: Boolean(ref) && cached == null }
}

/**
 * 把图标存成附件，返回它的 ID；存不进去返回空串（调用方把 data URL 留在卡片上）。
 */
export async function storeIcon(dataUrl: string): Promise<string> {
  const ref = iconRefFor(dataUrl)
  const promises = store()
  if (!ref || !promises?.postAttachment) return ''
  // 内容寻址：这个 ID 的附件存在就一定是同一张图，不用再写一遍。
  if (cache.get(ref)) return ref
  const parts = dataUrlToBytes(dataUrl)
  if (!parts) return ''
  try {
    const result = await promises.postAttachment(ref, parts.bytes, parts.mime)
    // 上一次启动就存过同一张图时会返回 conflict。内容一样，这正是想要的结果。
    if (result?.error && result.name !== 'conflict') return ''
  } catch {
    return ''
  }
  cache.set(ref, dataUrl)
  notifyLater()
  return ref
}

/** 把一张图标读进内存缓存，返回 data URL；读不到返回空串。 */
export function loadIcon(ref: string): Promise<string> {
  const cached = cache.get(ref)
  if (cached) return Promise.resolve(cached)
  const inflight = loading.get(ref)
  if (inflight) return inflight
  const promises = store()
  if (!isIconRef(ref) || !promises?.getAttachment) return Promise.resolve('')
  const request = Promise.all([promises.getAttachment(ref), promises.getAttachmentType(ref)])
    .then(([bytes, type]) => (bytes?.length ? bytesToDataUrl(bytes, type || 'image/png') : ''))
    .catch(() => '')
    .then(dataUrl => {
      loading.delete(ref)
      // 读不到也记一笔，免得每次渲染都再要一遍。云同步还没拉完时附件可能稍后才到，
      // 那种情况由下一轮 warmIcons 重试（它会把空记录清掉）。
      cache.set(ref, dataUrl)
      notifyLater()
      return dataUrl
    })
  loading.set(ref, request)
  return request
}

const WARM_CONCURRENCY = 6

/** 整库用到的图标附件 ID，按卡片顺序，已去重。 */
export function iconRefsOf(bookmarks: Bookmark[]): string[] {
  const refs = bookmarks.map(bookmark => String(bookmark.iconRef || '')).filter(isIconRef)
  return [...new Set(refs)]
}

/**
 * 预读整库用到的图标。
 *
 * 不等卡片滚到眼前再读那一张：uTools 主搜索框的推送列表要同步拿图标
 * （见 lib/image.ts 的 bookmarkIconUrl），临时去读是异步的，赶不上。
 * @param refs 要预读的附件 ID。按卡片顺序传进来，首屏那几张就会先读到。
 */
export async function warmIcons(refs: string[]): Promise<void> {
  if (!store()?.getAttachment) return
  // 上一轮读空的（当时云同步还没拉完）这次再试一次。
  const queue = [...new Set(refs.filter(ref => isIconRef(ref) && !cache.get(ref)))]
  queue.forEach(ref => cache.delete(ref))
  if (!queue.length) return
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const ref = queue[next]
      next += 1
      if (ref) await loadIcon(ref)
    }
  }
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker))
}

/**
 * 删掉没有卡片再引用的图标附件。
 *
 * 必须先确认云端数据已经拉完：另一台设备刚添加的卡片还没同步到本机时，
 * 它引用的附件在这里看起来就是没人要的，删掉等于把那台设备的图标弄丢了。
 * @param keep 还在引用的附件 ID
 * @returns 删掉的张数
 */
export async function sweepIcons(keep: Set<string>): Promise<number> {
  const promises = store()
  if (!promises?.allDocs) return 0
  try {
    // null 表示没开云同步（纯本地，不用等），0 表示已经拉完，1 表示还在拉。
    if (await promises.replicateStateFromCloud() === 1) return 0
    const docs = await promises.allDocs(ICON_REF_PREFIX)
    const orphans = docs.filter(doc => isIconRef(doc._id) && !keep.has(doc._id))
    if (!orphans.length) return 0
    await Promise.all(orphans.map(doc => promises.remove(doc._id)))
    orphans.forEach(doc => cache.delete(doc._id))
    return orphans.length
  } catch {
    // 清理是顺手做的事，失败就留着下次启动再清。
    return 0
  }
}

/**
 * 导出备份用的整库副本：图标从附件还原成内联 data URL。
 *
 * 备份要能在别的设备、别的安装上单独恢复，只带附件 ID 的备份换个地方就是一堆空图标。
 * 读不到的（附件已经不在了）就连 iconType 一起退回文字图标，而不是留个空圆圈。
 */
export function withInlineIcons(state: AppState): AppState {
  return {
    ...state,
    bookmarks: state.bookmarks.map((bookmark): Bookmark => {
      if (!isIconRef(bookmark.iconRef)) return bookmark
      const copy = { ...bookmark }
      delete copy.iconRef
      const inline = cachedIcon(bookmark.iconRef) || String(bookmark.iconData || '')
      if (inline) copy.iconData = inline
      else {
        delete copy.iconData
        copy.iconType = 'text'
      }
      return copy
    }),
  }
}

/** 单测用：清掉内存缓存。 */
export function resetIconStore(): void {
  cache.clear()
  loading.clear()
}
