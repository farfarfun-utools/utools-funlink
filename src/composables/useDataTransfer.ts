// 整库进出的几条路：备份到电脑、从备份恢复、导入浏览器书签、恢复示例数据。
//
// 从 useFunLink 里分出来。这几条路有个共同的要求：写不进存储就必须按失败报出来。
// 备份体积可能超过单文档上限，这时界面上是恢复好的、存储里还是旧数据，
// 悄悄算成功的话，用户要到下次打开插件才发现恢复没生效。

import { type Ref } from 'vue'
import { IMPORT_COLORS, createId, displayHost, initials, parseBookmarkHtml, splitTitle } from '../lib/core'
import { removeQuickFeature, resetQuickFeatures } from '../lib/features'
import { withInlineIcons } from '../lib/iconStore'
import { convertLegacyExport, isLegacyExport } from '../lib/legacy'
import { prepareState } from '../lib/state'
import type { AppState, Bookmark, Category } from '../lib/types'

/** 导入书签 / 恢复备份时可带的选项。 */
interface TransferOptions {
  mode?: string
  tabPosition?: Category['tabPosition']
}

// 示例数据本身就是「网址精灵」的文档格式，直接复用导入用的转换器，
// 免得示例数据和真实导入走两套映射、行为不一致。
//
// 用动态 import 而不是顶部静态 import：这份 JSON 有 84KB，压进主包要占四分之一的
// 体积，但只有首次启动和「恢复示例数据」才读得到，老用户每次启动都白解析一遍。
export async function seedState(): Promise<AppState> {
  const { default: firstData } = await import('../data/firstData.json')
  return convertLegacyExport(firstData).state
}

export interface DataTransferDeps {
  state: Ref<AppState>
  /** 存档异常时整库是只读的。恢复和重置拿到了可用数据，可以解除这个保护。 */
  storageError: Ref<string>
  /** 落盘，返回是否写成功。写失败时它自己会弹错误提示。 */
  saveState: () => boolean
  showToast: (message: string, error?: boolean) => void
  /** 整库换掉之后主题也跟着变了，要重新应用到根节点上。 */
  applyTheme: () => void
  /** 整库换掉之后跑一遍图标附件的迁移和清理（见 useIconAttachments）。 */
  syncIcons: () => void
}

export function useDataTransfer({ state, storageError, saveState, showToast, applyTheme, syncIcons }: DataTransferDeps) {
  function exportBackup() {
    if (!window.confirm('导出内容为明文，可能包含网址、笔记和设置。确认备份到电脑？')) return
    // 图标要还原成内联的 data URL：卡片上存的是本机数据库里的附件 ID，
    // 只带 ID 的备份换一台设备恢复出来就是一堆空图标。
    const content = JSON.stringify(withInlineIcons(state.value), null, 2)
    if (window.funlink?.saveBackup?.(content)) return showToast('备份已导出')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    link.download = `funlink-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    showToast('备份已导出')
  }

  function restoreBackup(content: string): boolean {
    const parsed = JSON.parse(content)
    // 既接受 FunLink 自己的备份，也接受「网址精灵」导出的 { db, flyDb } / 裸数组。
    const source = isLegacyExport(parsed) ? convertLegacyExport(parsed).state : parsed
    const { state: restored, dropped } = prepareState(source)
    state.value = restored
    // 恢复成功即说明拿到了可用数据，可以解除只读保护。
    storageError.value = ''
    const saved = saveState()
    applyTheme()
    resetQuickFeatures(state.value.bookmarks)
    if (saved) {
      // 备份里的图标是内联的，恢复完挪进附件；上一份数据的附件这时也没人引用了。
      syncIcons()
      showToast(dropped ? `备份已恢复，已跳过 ${dropped} 条无效网址` : '备份已恢复')
    }
    return saved
  }

  function importBookmarks(content: string, options: TransferOptions): boolean {
    const imported = parseBookmarkHtml(content)
    if (options.mode === 'replace') {
      state.value.bookmarks.filter(bookmark => bookmark.quick).forEach(bookmark => removeQuickFeature(bookmark.id))
      state.value.categories = []
      state.value.bookmarks = []
    }
    const categoryId = createId('category-import')
    state.value.categories.push({ id: categoryId, name: '导入书签', parentId: '', tabPosition: options.tabPosition || 'left' })
    const existing = new Set(state.value.bookmarks.map(bookmark => bookmark.url))
    const bookmarks: Bookmark[] = imported.filter(bookmark => !existing.has(bookmark.url)).map((bookmark, index): Bookmark => {
      // 浏览器书签常写成「名称 - 简介」，按设置里的分隔符拆开。
      const { title, description } = splitTitle(bookmark.title, state.value.settings.importSplit)
      return {
        ...bookmark,
        id: createId('bookmark-import'),
        title: title || bookmark.title,
        description: description || displayHost(bookmark.url),
        categoryId,
        categoryIds: [categoryId],
        color: IMPORT_COLORS[index % IMPORT_COLORS.length],
        iconType: 'text',
        icon: initials(title || bookmark.title),
        urls: [],
        browser: '', favorite: false, quick: false, note: '', deletedAt: null,
      }
    })
    state.value.bookmarks.push(...bookmarks)
    state.value.currentView = `category:${categoryId}`
    const saved = saveState()
    if (saved) {
      // 整库替换模式下原来那批卡片连图标一起没了，它们的附件要清掉。
      if (options.mode === 'replace') syncIcons()
      showToast(`已导入 ${bookmarks.length} 个网址`)
    }
    return saved
  }

  /** 恢复备份或导入浏览器书签。两条路都可能拿到脏数据，异常统一在这里转成提示。 */
  function processDataFile(type: 'restore' | 'import', content: string, options: TransferOptions = {}): boolean {
    try {
      return type === 'restore' ? restoreBackup(content) : importBookmarks(content, options)
    } catch (error) {
      showToast((error as Error).message, true)
      return false
    }
  }

  async function resetData() {
    if (!window.confirm('恢复示例数据？当前数据会被覆盖。')) return false
    state.value.bookmarks.filter(bookmark => bookmark.quick).forEach(bookmark => removeQuickFeature(bookmark.id))
    state.value = await seedState()
    // 用户明确选择了覆盖，此时解除只读保护。
    storageError.value = ''
    const saved = saveState()
    applyTheme()
    resetQuickFeatures(state.value.bookmarks)
    if (saved) {
      // 示例数据自带图标，同样挪进附件；被覆盖掉的那份数据的附件顺手清掉。
      syncIcons()
      showToast('已恢复示例数据')
    }
    return saved
  }

  return { exportBackup, processDataFile, resetData }
}
