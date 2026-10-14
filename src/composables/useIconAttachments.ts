// 把卡片里内联的图标挪进数据库附件，并清掉没人再引用的附件。
//
// 存量数据的迁移就在这里完成：老卡片的图标是一串 data URL 存在整库文档里，
// 启动时挪进附件、文档里只留一个 ID（为什么要挪见 lib/iconStore.ts）。
// 挪不动（不在 uTools 里、写入失败）就原样留着，界面行为不变。

import { type Ref } from 'vue'
import { iconRefsOf, iconStoreAvailable, storeIcon, sweepIcons, warmIcons } from '../lib/iconStore'
import type { AppState, Bookmark } from '../lib/types'

export interface IconAttachmentDeps {
  state: Ref<AppState>
  /** 存档异常时整库是只读的，这时不能动图标字段。 */
  storageError: Ref<string>
  /** 落盘，返回是否写成功。 */
  saveState: () => boolean
}

export function useIconAttachments({ state, storageError, saveState }: IconAttachmentDeps) {
  /**
   * 把内联的图标挪进附件，返回挪了几张。
   * 新加卡片、抓完图标之后也走这里，所以不只是一次性的迁移。
   */
  async function offloadIcons(): Promise<number> {
    if (storageError.value || !iconStoreAvailable()) return 0
    const snapshot = state.value
    const targets = snapshot.bookmarks.filter(bookmark => bookmark.iconType === 'image' && bookmark.iconData && !bookmark.iconRef)
    if (!targets.length) return 0

    const moved: { bookmark: Bookmark, ref: string }[] = []
    // 一张一张存，不并发：同一张图被多张卡片引用时（同一个站点的 favicon、
    // 同一张上传的图），后面那些算出的附件 ID 和第一张一样，直接命中缓存，
    // 连写入都不会发生——并发的话这几张会同时去写同一个 ID。
    for (const bookmark of targets) {
      const ref = await storeIcon(String(bookmark.iconData))
      if (ref) moved.push({ bookmark, ref })
    }
    // 存的这段时间里整库可能被整个换掉了（恢复备份、重置），这批卡片已经不在界面上，
    // 改它们没有意义；换进来的那份由对应的 syncIconAttachments 再走一遍。
    if (!moved.length || state.value !== snapshot) return 0

    // 攒到这里一次改完。边存边改的话，每挪一张图标都要让引用它的卡片重渲染一次。
    moved.forEach(({ bookmark, ref }) => {
      bookmark.iconRef = ref
      delete bookmark.iconData
    })
    saveState()
    return moved.length
  }

  /**
   * 启动时、整库换人之后各跑一遍：挪图标、预读、清理。
   *
   * 预读排在清理前面：清理要先等云端数据拉完（见 sweepIcons），那一步可能等上几秒，
   * 而卡片上的图标得尽快显示出来。
   */
  async function syncIconAttachments(): Promise<void> {
    if (!iconStoreAvailable()) return
    await offloadIcons()
    await warmIcons(iconRefsOf(state.value.bookmarks))
    // 废纸篓里的卡片也算还在引用：恢复出来之后图标得还在。
    await sweepIcons(new Set(iconRefsOf(state.value.bookmarks)))
  }

  return { offloadIcons, syncIconAttachments }
}
