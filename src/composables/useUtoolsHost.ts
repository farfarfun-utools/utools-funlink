import type { Ref } from 'vue'
import { displayHost } from '../lib/core'
import { quickFeatureTarget } from '../lib/features'
import { pushableBookmarks } from '../lib/views'
import type { AppState, Bookmark } from '../lib/types'

// 插件窗口高度，与 utools/plugin.json 的 pluginSetting.height 保持一致。
export const PLUGIN_HEIGHT = 558

/** 取 action 的文本载荷；files / window 等非文本指令回落成空串。 */
function textPayload(payload: PluginEnterAction['payload']): string {
  return typeof payload === 'string' ? payload : ''
}

/** 接入 uTools 宿主所需的回调，全部由组合式函数提供。 */
export interface UtoolsHostOptions {
  state: Ref<AppState>
  search: Ref<string>
  openLink: (bookmark: Bookmark, query?: string) => Promise<void>
  addBookmark: (input: Partial<Bookmark>) => void
  /** 退出到后台时收尾挂着的关键词对话框。 */
  dismissKeyword: () => void
}

/**
 * 注册与 uTools 宿主的全部交互：子输入框、快开入口、主搜索框推送、退出清理。
 *
 * 没有走 utools.onPluginReady：那个事件在插件加载完成时就触发了，而这里是渲染进程里
 * Vue 挂载之后才注册，赶不上也就不会再补发。进入插件相关的逻辑统一挂在
 * onEnter（preload 会补发注册前积压的 action）上，时序更确定。
 */
export function setupUtoolsHost({ state, search, openLink, addBookmark, dismissKeyword }: UtoolsHostOptions) {
  window.utools?.setExpandHeight?.(PLUGIN_HEIGHT)
  window.utools?.setSubInput?.(({ text }) => { search.value = text || '' }, '搜索卡片', true)

  window.funlink?.onEnter?.(async action => {
    const payload = textPayload(action.payload)
    const quickTarget = quickFeatureTarget(action.code)
    if (quickTarget) {
      const bookmark = state.value.bookmarks.find(item => item.id === quickTarget)
      if (bookmark) {
        // 等 openLink 结束再退出，否则关键词还没输入插件就被关掉了。
        await openLink(bookmark, payload)
        window.utools?.outPlugin?.()
      }
      return
    }
    window.utools?.setExpandHeight?.(PLUGIN_HEIGHT)
    if (action.code === 'add-link') addBookmark({ url: payload.trim() })
    if (action.code === 'search-link') search.value = payload
  })

  // 主搜索框推送结果与书签的对应关系。uTools 只把用户选中的文本回传
  // （PluginEnterAction.option 仅有 text），挂在推送结果上的自定义字段不会带回来，
  // 所以推送时按显示文本记下 id，选中后再查回来。
  let pushedIds = new Map<string, string>()
  window.utools?.onMainPush?.(action => {
    const matched = pushableBookmarks(state.value, textPayload(action.payload))
    // 同名卡片只认第一条——回传的文本无法区分它们，取最靠前的最符合预期。
    pushedIds = new Map()
    matched.forEach(bookmark => {
      if (!pushedIds.has(bookmark.title)) pushedIds.set(bookmark.title, bookmark.id)
    })
    return matched.map(bookmark => ({
      icon: 'logo.png',
      text: bookmark.title,
      title: bookmark.description || displayHost(bookmark.url),
    }))
  }, action => {
    const id = pushedIds.get(action.option?.text || '')
    const bookmark = id ? state.value.bookmarks.find(item => item.id === id) : undefined
    if (bookmark) openLink(bookmark, textPayload(action.payload))
    // 不返回 true：直接打开网址，不进入插件界面。
    return false
  })

  // 退出到后台时清掉搜索词。uTools 会收走子输入框，但插件进程还活着，
  // 不清的话下次进来界面还停在上次的筛选结果上，而子输入框是空的，对不上。
  window.utools?.onPluginOut?.(() => {
    search.value = ''
    dismissKeyword()
  })
}
