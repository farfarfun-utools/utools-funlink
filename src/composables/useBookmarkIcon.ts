// 把图标附件缓存接到 Vue 的响应式上。
//
// lib/iconStore.ts 里的缓存是个普通 Map（lib 层不碰 vue），Vue 看不见它的变化，
// 所以附件读进缓存之后要靠它的订阅接口来通知组件重新取一次图标。

import { onUnmounted, shallowRef, watchEffect } from 'vue'
import { bookmarkIcon, subscribeIcons } from '../lib/iconStore'
import type { Bookmark } from '../lib/types'

const NO_ICON = { url: '', pending: false }

/**
 * 一张卡片当前该显示的图标。
 * @param source 取卡片的函数（而不是卡片本身），这样换卡片、改图标都能跟着重算。
 *   对话框类组件没打开时没有卡片，允许返回空。
 */
export function useBookmarkIcon(source: () => Bookmark | null | undefined) {
  const icon = shallowRef(NO_ICON)

  function refresh() {
    const bookmark = source()
    const next = bookmark ? bookmarkIcon(bookmark) : NO_ICON
    // 只在真的变了的时候赋值。预读一遍整库会通知好几轮，而每一轮里真正读到图标的
    // 只有少数几张卡片；无条件赋值等于每一轮都把屏幕上所有卡片重渲染一次。
    if (next.url !== icon.value.url || next.pending !== icon.value.pending) icon.value = next
  }

  // 卡片自己的字段（iconType / iconRef / iconData）变了由 watchEffect 收到，
  // 附件读进缓存了由订阅收到。subscribeIcons 返回的正是取消订阅的函数。
  watchEffect(refresh)
  onUnmounted(subscribeIcons(refresh))

  return icon
}
