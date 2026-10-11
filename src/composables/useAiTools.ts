import type { Ref } from 'vue'
import { buildBookmark, describeBookmark, findBookmark, findByUrl, listCategories, searchBookmarks } from '../lib/tools'
import type { AppState, Bookmark } from '../lib/types'

/** 注册工具所需的回调，由组合式函数提供。 */
export interface AiToolsOptions {
  state: Ref<AppState>
  /** 界面用的那条保存链路：带内容去重、1MB 上限检查和快开入口同步，返回是否真的写进去了。 */
  saveBookmark: (input: Partial<Bookmark>) => boolean
  openLink: (bookmark: Bookmark, query?: string) => Promise<void>
}

/** 已注册的工具名，必须和 utools/plugin.json 的 tools 键名逐字一致。 */
export const TOOL_NAMES = ['search_bookmarks', 'list_categories', 'add_bookmark', 'open_bookmark'] as const

/**
 * 把收藏夹的查、增、打开三件事注册成 uTools 工具。
 *
 * 注册后有两条调用路径：`utools.ai()` 的 Function Calling，以及用户开启 MCP 服务后
 * 第三方 AI Agent 的调用。两条路都不会触发 onPluginEnter，所以注册必须在页面初始化时
 * 做（这里跟着 setupUtools 一起执行），绝不能挂在进入插件的回调里。
 *
 * 工具抛出的错误会交回 Agent，所以错误信息写成能直接指导它改参数重试的句子。
 */
export function registerAiTools({ state, saveBookmark, openLink }: AiToolsOptions) {
  // uTools 8 之前没有这个 API，浏览器里预览时也没有。
  if (!window.utools?.registerTool) return

  window.utools.registerTool('search_bookmarks', params => searchBookmarks(state.value, params))

  window.utools.registerTool('list_categories', () => listCategories(state.value))

  window.utools.registerTool('add_bookmark', params => {
    const bookmark = buildBookmark(state.value, params)
    const existing = findByUrl(state.value, bookmark.url)
    // 已经收藏过就把现成的那张返回去，不新建也不报错——重复调用是幂等的。
    if (existing) return { created: false, bookmark: describeBookmark(state.value, existing) }
    // 抛错而不是返回 { ok: false }：写不进去就是没收藏成功，Agent 必须知道。
    if (!saveBookmark(bookmark)) throw new Error('收藏没有保存成功，可能是数据已超出 uTools 单个文档 1MB 上限，请让用户在插件里清理后重试')
    return { created: true, bookmark: describeBookmark(state.value, bookmark) }
  })

  window.utools.registerTool('open_bookmark', async params => {
    const bookmark = findBookmark(state.value, params)
    const query = String(params.query ?? '').trim()
    // 带 {q} 的卡片要靠关键词补全网址。界面上会弹对话框问用户，但 Agent 这条路上没人回答，
    // 等于把调用挂死在那里，所以直接报错让它带上 query 重试。
    if (!query && bookmark.url.includes('{q}')) {
      throw new Error(`“${bookmark.title}”是搜索类网址，请在 query 参数里给出搜索关键词`)
    }
    await openLink(bookmark, query)
    return { opened: describeBookmark(state.value, bookmark) }
  })
}
