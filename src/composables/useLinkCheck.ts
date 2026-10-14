// 无效链接检查：挨个 HEAD 探活，4xx 和请求失败都算无效，可以中途停。
//
// 和 useWebdav 一样从 SettingsDialog 搬出来。这里的要点是「一轮扫描一个编号」
// 的取消机制：几百条链接要探好几分钟，用户停下或重新发起时，在飞的请求还会陆续
// 回来，不认编号就会往已经清空的列表里继续塞结果。

import { computed, ref, type Ref } from 'vue'
import { hasQueryPlaceholder, isHttpUrl } from '../lib/core'
import { readStorage, writeStorage } from '../lib/storage'
import type { Bookmark } from '../lib/types'

const IGNORE_KEY = 'funlink-ignore-list'
// 同时在飞的探活请求数。再多不会更快（对端和网络是瓶颈），但会让停止按钮迟迟不生效。
const CONCURRENCY = 8

/** 失效链接扫描结果：书签本体加上这次探测到的错误信息。 */
export type InvalidLink = Bookmark & { message: string }

/** 用户主动忽略的链接，只需要记住网址，标题用于展示。 */
export interface IgnoredLink {
  title: string
  url: string
}

export interface LinkCheckDeps {
  bookmarks: Ref<Bookmark[]>
  /** 往界面上报一句话，第二个参数为真表示这是错误。 */
  onMessage: (text: string, error?: boolean) => void
}

export function useLinkCheck({ bookmarks, onMessage }: LinkCheckDeps) {
  const scanning = ref(false)
  const scanned = ref(0)
  const results = ref<InvalidLink[]>([])
  // readStorage 读的是存储里的任意 JSON，这里声明期望的形状。
  const ignored = ref(readStorage(IGNORE_KEY, []) as IgnoredLink[])
  // 忽略名单用 Set 查：原来每张卡片都把名单 some 一遍，两边都上百条时是乘法级的开销。
  const ignoredUrls = computed(() => new Set(ignored.value.map(item => item.url)))
  const candidates = computed(() => bookmarks.value.filter(bookmark => !bookmark.deletedAt
    // 探活走 preload 里的 http/https 请求。file:// 和 ftp:// 丢进去只会抛
    // ERR_INVALID_PROTOCOL，然后被当成「无效链接」报给用户——本地文件的卡片不该背这个锅。
    && isHttpUrl(bookmark.url)
    // 站内搜索卡片的网址带占位符，原样请求是个无意义的地址，探不出结果。
    && !hasQueryPlaceholder(bookmark.url)
    && !ignoredUrls.value.has(bookmark.url)))

  let token = 0

  async function scan() {
    if (scanning.value) return
    // 探活要走 preload 的 HEAD 请求，渲染进程里没有这个桥接层就做不了。
    const bridge = window.funlink
    if (!bridge) return onMessage('当前环境不支持链接检测', true)
    // 一轮扫描一个编号。停止扫描和重新发起都会换号，在飞的请求回来时按号对不上
    // 就把结果丢掉。
    const current = ++token
    const outdated = () => current !== token
    scanning.value = true
    scanned.value = 0
    results.value = []
    const queue = candidates.value.slice()
    const worker = async () => {
      while (queue.length) {
        if (outdated()) return
        const bookmark = queue.shift()
        // 多个 worker 共享队列，shift 到空就收工。
        if (!bookmark) break
        try {
          const status = await bridge.checkUrl(bookmark.url)
          if (!outdated() && status >= 400) results.value.push({ ...bookmark, message: `${status}错误` })
        } catch (error) {
          if (!outdated()) results.value.push({ ...bookmark, message: error instanceof Error ? error.message : String(error) })
        } finally {
          if (!outdated()) scanned.value++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    // 已经被停止、或者被新一轮接管时，这一轮不该再去改按钮状态。
    if (!outdated()) scanning.value = false
  }

  /** 停掉正在进行的扫描，已经查到的结果留在列表里。 */
  function stop() {
    if (!scanning.value) return
    token++
    scanning.value = false
  }

  function ignore(bookmark: InvalidLink) {
    results.value = results.value.filter(item => item.id !== bookmark.id)
    ignored.value.unshift({ title: bookmark.title, url: bookmark.url })
    writeStorage(IGNORE_KEY, ignored.value)
  }

  function unignore(index: number) {
    ignored.value.splice(index, 1)
    writeStorage(IGNORE_KEY, ignored.value)
  }

  return { scanning, scanned, results, ignored, candidates, scan, stop, ignore, unignore }
}
