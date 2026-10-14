// 打开卡片这条链路：选浏览器、填站内搜索关键词、一张卡片开多个网址。
//
// 从 useFunLink 里分出来，和「清空内置浏览器 Cookies」放在一起——后者也是
// 走 ubrowser，而且要把库里所有网址的源过一遍，和这里的 urlsOf 是同一套输入。

import { type Ref } from 'vue'
import { fillQueryPlaceholder, hasQueryPlaceholder, originOf, urlsOf } from '../lib/core'
import type { AppState, Bookmark } from '../lib/types'

export interface OpenLinkDeps {
  state: Ref<AppState>
  /** 卡片搜索框里的词。站内搜索卡片没带关键词时拿它顶上。 */
  search: Ref<string>
  /** 弹出关键词输入框，用户取消时返回空串。 */
  askKeyword: (title: string) => Promise<string>
  showToast: (message: string, error?: boolean) => void
}

export function useOpenLink({ state, search, askKeyword, showToast }: OpenLinkDeps) {
  function openUrl(bookmark: Bookmark, url: string) {
    const followsDefault = !bookmark.browser || bookmark.browser === 'default'
    const useInner = bookmark.browser === 'inner' || (followsDefault && state.value.settings.browser.isOpenIn)
    if (useInner && window.utools?.ubrowser) {
      window.utools.ubrowser.goto(url).run({ width: state.value.settings.browser.width, height: state.value.settings.browser.height })
    } else if (window.funlink?.openExternal) {
      // 'default' / 'system' 都表示交给系统默认浏览器。
      window.funlink.openExternal(url, followsDefault || bookmark.browser === 'system' ? '' : bookmark.browser)
    } else window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function openLink(bookmark: Bookmark, query = '') {
    const urls = urlsOf(bookmark)
    if (!urls.length) return
    let keyword = String(query || '').trim() || search.value.trim()
    if (urls.some(hasQueryPlaceholder) && !keyword) {
      keyword = await askKeyword(`在 ${bookmark.title} 中搜索`)
      if (!keyword) return
    }
    urls.forEach(url => openUrl(bookmark, fillQueryPlaceholder(url, keyword)))
  }

  // 原来的实现是删 dbStorage 里 cookie@ 开头的文档——那是「网址精灵」留下的东西，
  // FunLink 从不写，内置浏览器的 Cookie 也不存在那里，所以点了等于没点，还白报一句
  // 「已清空」。真正的入口只有 ubrowser 链上的 clearCookies，它按 URL 清，
  // 所以把库里所有网址的源过一遍。
  async function clearCookies() {
    const ubrowser = window.utools?.ubrowser
    if (!ubrowser) return showToast('当前环境没有内置浏览器', true)
    const origins = [...new Set(state.value.bookmarks.flatMap(urlsOf).map(originOf).filter(Boolean))]
    if (!origins.length) return showToast('没有需要清理的 Cookies')
    try {
      // 不显示窗口：只是借 ubrowser 执行一遍清理队列。
      await origins
        .reduce((chain, origin) => chain.clearCookies(origin), ubrowser.goto('about:blank'))
        .run({ show: false, width: 100, height: 100 })
      showToast('内置浏览器 Cookies 已清空')
    } catch (error) {
      showToast(`清空 Cookies 失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  return { openLink, clearCookies }
}
