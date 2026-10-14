// 为存量卡片批量抓网站图标。
//
// 难点不在抓取（lib/image.ts 已经能抓单张）而在存储：整库收藏压在 uTools 的
// 单个文档里（上限见 storage.ts 的 MAX_DOC_BYTES），一张 64px 图标 base64 之后
// 一两 KB 到几 KB，几百张卡片全抓一遍就能把文档顶到上限。不记账的话会在抓完
// 几百个网站之后一次性写入失败，整轮白跑。所以这里一边抓一边算还剩多少额度，
// 装不下下一张就停，并且每抓够一批就落盘一次。

import { originOf } from './core'
import { MAX_DOC_BYTES } from './storage'
import type { Bookmark } from './types'

/** 预留额度：抓完图标用户还要加卡片、写笔记，不能把文档正好填到上限。 */
export const ICON_RESERVE_BYTES = 64 * 1024

/** 一张抓来的图标的典型占用，只用于给用户估「还能存多少张」。 */
export const ICON_COST_ESTIMATE = 3 * 1024

const CONCURRENCY = 4
const BATCH_SIZE = 10

/** 一张待抓图标的卡片。 */
export interface IconTarget {
  id: string
  title: string
  /** 卡片上的原网址，只用于展示。 */
  url: string
  /** 真正拿去请求的网址：去掉了 {q} 占位符。 */
  requestUrl: string
  /** 卡片现有图标占的字节数。重抓时实际多占的只有新旧之差。 */
  existingBytes: number
}

export interface IconUpdate {
  id: string
  iconData: string
}

export interface IconFailure {
  id: string
  title: string
  url: string
  reason: string
}

/** 这一轮为什么收工：跑到头 / 用户停的 / 额度用完 / 落盘失败。 */
export type IconBackfillHalt = 'done' | 'user' | 'budget' | 'storage'

export interface IconBackfillProgress {
  /** 已处理的卡片数（含抓失败的）。 */
  done: number
  /** 已抓到图标的卡片数。 */
  filled: number
  failed: number
}

export interface IconBackfillOptions {
  candidates: IconTarget[]
  /** 这一轮最多还能多占多少字节，见 iconBudget。 */
  budget: number
  /** 抓一张图标，抓不到返回空串。 */
  fetch: (url: string) => Promise<string>
  /** 把一批图标写进卡片并落盘，返回是否写成功。 */
  apply: (updates: IconUpdate[]) => boolean
  /** 返回 true 表示用户已经点了停止。 */
  stopped?: () => boolean
  onProgress?: (progress: IconBackfillProgress) => void
  concurrency?: number
  batchSize?: number
}

export interface IconBackfillResult {
  /** 真正落盘了的张数。 */
  filled: number
  failures: IconFailure[]
  stoppedBy: IconBackfillHalt
}

/** 一张图标写进存档后多占的字节数。data URL 是纯 ASCII，长度即字节数。 */
export function iconCost(dataUrl: string): number {
  // +32 算上 "iconData": 字段名和 iconType 从 text 变 image 的那几个字符。
  return dataUrl ? dataUrl.length + 32 : 0
}

/** 这一轮抓取最多还能多占多少字节。已经到上限时返回 0。 */
export function iconBudget(usedBytes: number): number {
  return Math.max(0, MAX_DOC_BYTES - usedBytes - ICON_RESERVE_BYTES)
}

/**
 * 挑出需要抓图标的卡片。
 * @param includeExisting 连已经有图片图标的卡片也重新抓一遍
 */
export function iconBackfillCandidates(bookmarks: Bookmark[], { includeExisting = false } = {}): IconTarget[] {
  return bookmarks.flatMap((bookmark): IconTarget[] => {
    // 废纸篓里的不抓：恢复出来之后再抓就行，没必要为它花额度。
    if (bookmark.deletedAt) return []
    const url = String(bookmark.url || '').trim()
    // 只抓 http(s)：file / ftp 没有网页图标可读。
    if (!/^https?:\/\//i.test(url)) return []
    const iconData = bookmark.iconType === 'image' ? String(bookmark.iconData || '') : ''
    if (iconData && !includeExisting) return []
    return [{
      id: bookmark.id,
      title: bookmark.title,
      url,
      // 搜索类网址带着 {q} 占位符，原样请求是个无意义的地址；
      // 去掉占位符后站点首页和 /favicon.ico 兜底都还在。
      requestUrl: url.replaceAll('{q}', ''),
      existingBytes: iconCost(iconData),
    }]
  })
}

/**
 * 跑一轮批量抓取：并发抓、按预算记账、分批落盘，中途可停。
 *
 * 抓到的图标不会攒到最后一次性写：几百张卡片要抓好几分钟，中途停下或撞上额度时
 * 已经抓到的也该留住，不然用户只能从头再来一遍。
 */
export async function runIconBackfill({
  candidates, budget, fetch, apply,
  stopped = () => false, onProgress,
  concurrency = CONCURRENCY, batchSize = BATCH_SIZE,
}: IconBackfillOptions): Promise<IconBackfillResult> {
  const queue = candidates.slice()
  const failures: IconFailure[] = []
  const pending: IconUpdate[] = []
  // 同一个域名下常有好几张卡片（首页、文档、后台），图标是同一张。
  // 按源缓存这次抓取的 Promise，并发的 worker 共用一次请求。
  const byOrigin = new Map<string, Promise<string>>()
  let remaining = budget
  let committed = 0
  let done = 0
  let halted: IconBackfillHalt | '' = ''

  function fetchOnce(target: IconTarget): Promise<string> {
    const key = originOf(target.requestUrl) || target.requestUrl
    const cached = byOrigin.get(key)
    if (cached) return cached
    const request = fetch(target.requestUrl)
    byOrigin.set(key, request)
    return request
  }

  function flush(): boolean {
    if (!pending.length) return true
    const batch = pending.splice(0, pending.length)
    if (apply(batch)) {
      committed += batch.length
      return true
    }
    // 写不进去的话后面每一批都会撞同一个上限，没有再抓下去的意义。
    // 失败原因已经由落盘那边提示给用户了，这里只负责停。
    halted ||= 'storage'
    return false
  }

  const worker = async () => {
    while (queue.length && !halted) {
      if (stopped()) {
        halted = 'user'
        return
      }
      const target = queue.shift()
      // 多个 worker 共享队列，shift 到空就收工。
      if (!target) break
      const failed = (reason: string) => failures.push({ id: target.id, title: target.title, url: target.url, reason })
      try {
        const icon = await fetchOnce(target)
        if (stopped()) {
          halted = 'user'
          return
        }
        if (!icon) failed('没找到图标')
        else {
          // 重抓已有图标的卡片时，真正多占的只有新旧之差。
          const cost = Math.max(0, iconCost(icon) - target.existingBytes)
          if (cost > remaining) {
            halted = 'budget'
            return
          }
          remaining -= cost
          pending.push({ id: target.id, iconData: icon })
          if (pending.length >= batchSize && !flush()) return
        }
      } catch (caught) {
        failed(caught instanceof Error ? caught.message : String(caught))
      }
      done += 1
      onProgress?.({ done, filled: committed + pending.length, failed: failures.length })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  // 跑到头、被停下、撞上额度，都要把攒着的这一批落盘——重来一次又是一轮网络请求。
  flush()
  return { filled: committed, failures, stoppedBy: halted || 'done' }
}
