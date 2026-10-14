// 图标附件存储：内容寻址去重、读进缓存、孤儿清理、导出时还原内联图标。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { bytesToDataUrl, dataUrlToBytes } from '../src/lib/dataurl.ts'
import {
  bookmarkIcon, cachedIcon, iconRefFor, iconRefsOf, iconStoreAvailable, isIconRef,
  loadIcon, resetIconStore, storeIcon, sweepIcons, warmIcons, withInlineIcons,
} from '../src/lib/iconStore.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const WEBP = 'data:image/webp;base64,UklGRgA='

/**
 * uTools 数据库的替身。只实现用到的那几个附件接口，并记下调用次数——
 * 「同一张图只存一份」「同一个附件只读一次」这两件事只能靠次数验。
 * @param pullState replicateStateFromCloud 的返回值：null 没开同步 / 0 拉完 / 1 还在拉
 */
function fakeDb({ pullState = 0 } = {}) {
  const attachments = new Map()
  const calls = { post: [], get: [], removed: [] }
  const promises = {
    postAttachment: async (id, bytes, type) => {
      calls.post.push(id)
      // 真实接口只能创建不能更新，已存在的 ID 返回 conflict。
      if (attachments.has(id)) return { id, error: true, name: 'conflict', message: 'Document update conflict' }
      attachments.set(id, { bytes: Uint8Array.from(bytes), type })
      return { id, ok: true, rev: '1-x' }
    },
    getAttachment: async id => {
      calls.get.push(id)
      return attachments.get(id)?.bytes ?? null
    },
    getAttachmentType: async id => attachments.get(id)?.type ?? null,
    allDocs: async prefix => [...attachments.keys()].filter(id => id.startsWith(String(prefix || ''))).map(id => ({ _id: id })),
    remove: async id => {
      calls.removed.push(id)
      attachments.delete(id)
      return { id, ok: true }
    },
    replicateStateFromCloud: async () => pullState,
  }
  return { utools: { db: { promises } }, attachments, calls }
}

/** 装上替身跑一段，跑完把全局和模块级缓存都清干净。 */
async function withDb(host, run) {
  resetIconStore()
  globalThis.window = host ? { utools: host.utools } : {}
  try {
    return await run()
  } finally {
    delete globalThis.window
    resetIconStore()
  }
}

test('附件 ID 按内容算：同一张图同一个 ID，改一个字节就是另一个 ID', () => {
  assert.equal(iconRefFor(PNG), iconRefFor(PNG))
  assert.notEqual(iconRefFor(PNG), iconRefFor(WEBP))
  // 去重完全靠这个等式成立：同一个站点图标被十张卡片引用时，存储里只该有一份。
  assert.ok(isIconRef(iconRefFor(PNG)))
  assert.equal(iconRefFor(''), '', '没有图标就没有 ID')
  assert.equal(isIconRef('data:image/png;base64,AAA'), false, '内联的 data URL 不是附件 ID')
})

test('同一张图标只写一份附件，第二次连写入都不发生', async () => {
  const host = fakeDb()
  await withDb(host, async () => {
    const first = await storeIcon(PNG)
    const second = await storeIcon(PNG)

    assert.equal(first, second)
    assert.equal(host.attachments.size, 1)
    assert.deepEqual(host.calls.post, [first], '第二张命中内存缓存，不该再写一遍')
    // 存进去的是原始字节，不是 base64 文本。
    assert.deepEqual(host.attachments.get(first).bytes, dataUrlToBytes(PNG).bytes)
    assert.equal(host.attachments.get(first).type, 'image/png')
  })
})

test('上一次启动就存过的同一张图返回 conflict，当成存好了', async () => {
  const host = fakeDb()
  const ref = iconRefFor(PNG)
  host.attachments.set(ref, { bytes: dataUrlToBytes(PNG).bytes, type: 'image/png' })
  await withDb(host, async () => {
    assert.equal(await storeIcon(PNG), ref)
  })
})

test('不在 uTools 里时存不进附件，图标继续内联在卡片上', async () => {
  await withDb(null, async () => {
    assert.equal(iconStoreAvailable(), false)
    assert.equal(await storeIcon(PNG), '')
  })
})

test('附件读成 data URL，同一个附件并发只读一次', async () => {
  const host = fakeDb()
  const ref = iconRefFor(PNG)
  host.attachments.set(ref, { bytes: dataUrlToBytes(PNG).bytes, type: 'image/png' })
  await withDb(host, async () => {
    const [a, b] = await Promise.all([loadIcon(ref), loadIcon(ref)])

    assert.equal(a, PNG)
    assert.equal(b, PNG)
    assert.deepEqual(host.calls.get, [ref], '首屏一批卡片常引用同一张图标，不拦一下就是读好几遍')
    assert.equal(cachedIcon(ref), PNG, '读过之后同步就能取到，主搜索框推送图标要靠这个')
  })
})

test('附件已经不在了的卡片回落成文字图标，而不是一直等', async () => {
  const host = fakeDb()
  const ref = iconRefFor(PNG)
  await withDb(host, async () => {
    const bookmark = { id: 'w1', title: 'Hello World', url: 'https://a.com', iconType: 'image', iconRef: ref }

    // 还没读过：有图，但得等附件读出来，这期间不显示首字母（否则图标会跳一下）。
    assert.deepEqual(bookmarkIcon(bookmark), { url: '', pending: true })
    await loadIcon(ref)
    // 读出来是空的（另一台设备把附件清掉了）：不再等，让卡片显示文字图标。
    assert.deepEqual(bookmarkIcon(bookmark), { url: '', pending: false })
  })
})

test('图标的三种形态各取各的：附件、内联、文字', async () => {
  const host = fakeDb()
  await withDb(host, async () => {
    const ref = await storeIcon(PNG)

    assert.deepEqual(bookmarkIcon({ id: 'w1', title: 'A', url: 'https://a.com', iconType: 'image', iconRef: ref }), { url: PNG, pending: false })
    // 老数据和附件写失败时都是这个形态。
    assert.deepEqual(bookmarkIcon({ id: 'w2', title: 'B', url: 'https://b.com', iconType: 'image', iconData: WEBP }), { url: WEBP, pending: false })
    assert.deepEqual(bookmarkIcon({ id: 'w3', title: 'C', url: 'https://c.com', iconType: 'text', iconRef: ref }), { url: '', pending: false }, '文字图标不该去读附件')
  })
})

test('预读按卡片顺序去重，上一轮读空的下一轮再试一次', async () => {
  const host = fakeDb()
  const png = iconRefFor(PNG)
  const webp = iconRefFor(WEBP)
  await withDb(host, async () => {
    const bookmarks = [
      { id: 'w1', title: 'A', url: 'https://a.com', iconType: 'image', iconRef: png },
      { id: 'w2', title: 'B', url: 'https://b.com', iconType: 'image', iconRef: png },
      { id: 'w3', title: 'C', url: 'https://c.com', iconType: 'image', iconRef: webp },
      { id: 'w4', title: 'D', url: 'https://d.com', iconType: 'text' },
    ]
    assert.deepEqual(iconRefsOf(bookmarks), [png, webp])

    // 这一轮两张都还没同步过来，读到的是空。
    await warmIcons(iconRefsOf(bookmarks))
    assert.deepEqual(host.calls.get, [png, webp])

    host.attachments.set(png, { bytes: dataUrlToBytes(PNG).bytes, type: 'image/png' })
    await warmIcons(iconRefsOf(bookmarks))

    assert.deepEqual(host.calls.get, [png, webp, png, webp], '上一轮读空的不能永久记成没有：云同步可能稍后才把附件拉过来')
    assert.equal(cachedIcon(png), PNG)
  })
})

test('清理没人引用的图标附件', async () => {
  const host = fakeDb()
  await withDb(host, async () => {
    const used = await storeIcon(PNG)
    const orphan = await storeIcon(WEBP)

    assert.equal(await sweepIcons(new Set([used])), 1)
    assert.deepEqual(host.calls.removed, [orphan])
    assert.deepEqual([...host.attachments.keys()], [used])
    assert.equal(cachedIcon(orphan), '', '清掉的也要从内存缓存里去掉')
  })
})

test('云端数据还在往本机拉的时候不清理', async () => {
  const host = fakeDb({ pullState: 1 })
  await withDb(host, async () => {
    await storeIcon(PNG)

    // 另一台设备刚加的卡片还没同步过来，它引用的附件在这里看起来就是没人要的。
    assert.equal(await sweepIcons(new Set()), 0)
    assert.deepEqual(host.calls.removed, [])
  })
})

test('没开云同步（返回 null）照常清理', async () => {
  const host = fakeDb({ pullState: null })
  await withDb(host, async () => {
    const orphan = await storeIcon(PNG)

    assert.equal(await sweepIcons(new Set()), 1)
    assert.deepEqual(host.calls.removed, [orphan])
  })
})

test('导出备份时把图标还原成内联 data URL', async () => {
  const host = fakeDb()
  await withDb(host, async () => {
    const ref = await storeIcon(PNG)
    const state = {
      version: 1,
      bookmarks: [
        { id: 'w1', title: 'A', url: 'https://a.com', iconType: 'image', iconRef: ref },
        { id: 'w2', title: 'B', url: 'https://b.com', iconType: 'image', iconRef: iconRefFor(WEBP) },
        { id: 'w3', title: 'C', url: 'https://c.com', iconType: 'text', icon: 'C' },
      ],
    }

    const exported = withInlineIcons(state)

    // 只带附件 ID 的备份换一台设备恢复出来就是一堆空图标。
    assert.deepEqual(exported.bookmarks[0], { id: 'w1', title: 'A', url: 'https://a.com', iconType: 'image', iconData: PNG })
    // 附件已经读不到了的，连 iconType 一起退回文字，而不是留个空圆圈。
    assert.deepEqual(exported.bookmarks[1], { id: 'w2', title: 'B', url: 'https://b.com', iconType: 'text' })
    assert.equal(exported.bookmarks[2], state.bookmarks[2], '没有图标附件的卡片原样带过去')
    assert.equal(state.bookmarks[0].iconRef, ref, '导出不该改动内存里的整库状态')
  })
})

test('data URL 和字节互转，base64 和明文两种都认', () => {
  const parts = dataUrlToBytes(PNG)
  assert.equal(parts.mime, 'image/png')
  assert.equal(bytesToDataUrl(parts.bytes, parts.mime), PNG)

  // svg 图标常以明文形式内联。
  const plain = dataUrlToBytes('data:image/svg+xml,%3Csvg%2F%3E')
  assert.equal(new TextDecoder().decode(plain.bytes), '<svg/>')
  assert.equal(dataUrlToBytes('https://a.com/icon.png'), null)
  assert.equal(dataUrlToBytes(''), null)
})

test('大图标编回 data URL 不会撞上参数个数上限', () => {
  // btoa 要「一个字符一个字节」的字符串，String.fromCharCode(...bytes) 一把梭的话
  // 几十 KB 的图标就是几万个实参，这里按 8KB 一段拼。
  const bytes = new Uint8Array(64 * 1024).fill(7)
  const dataUrl = bytesToDataUrl(bytes, 'image/webp')

  assert.deepEqual(dataUrlToBytes(dataUrl).bytes, bytes)
})
