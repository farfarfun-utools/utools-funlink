import { test } from 'vitest'
import assert from 'node:assert/strict'
import { STORAGE_KEY, loadState, prepareState } from '../src/lib/state.ts'

// 重构前（commit 6b8331a）真实的存档形状：同样的 key、同样的 version 1，
// 但卡片只有 categoryId，废纸篓项只有 previousCategoryId。
const LEGACY_STATE = {
  version: 1,
  theme: 'dark',
  currentView: 'category:cat_demo',
  categories: [{ id: 'cat_demo', name: '演示', parentId: '' }],
  bookmarks: [
    { id: 'w1', title: '我的书签', url: 'https://example.com/', categoryId: 'cat_demo', deletedAt: null },
    { id: 'w2', title: '已删除', url: 'https://deleted.example/', categoryId: '', previousCategoryId: 'cat_demo', deletedAt: 1 },
  ],
}

test('legacy save files load instead of being replaced by demo data', () => {
  const result = loadState({ read: () => structuredClone(LEGACY_STATE) })

  assert.equal(result.blocked, '', '旧存档必须能正常读取，不能进入只读模式')
  assert.equal(result.empty, false, '有存档就不能让调用方去灌示例数据')
  assert.deepEqual(result.state.bookmarks.map(bookmark => bookmark.title), ['我的书签', '已删除'])
  assert.deepEqual(result.state.bookmarks[0].categoryIds, ['cat_demo'])
  assert.deepEqual(result.state.bookmarks[1].previousCategoryIds, ['cat_demo'])
  assert.equal(result.state.theme, 'dark', '用户的主题选择要保留')
  // 旧版没有 settings，需要补上默认值。
  assert.equal(result.state.settings.browser.width, 1000)
  assert.deepEqual(result.state.settings.search, ['title', 'description', 'url'])
})

test('first run with empty storage asks the caller for demo data', () => {
  const result = loadState({ read: () => null })
  assert.equal(result.empty, true)
  assert.equal(result.blocked, '')
  assert.deepEqual(result.state.bookmarks, [])
})

test('unreadable data blocks writes rather than overwriting', () => {
  // 坏数据和读取异常都不能报 empty：报了调用方就会灌示例数据，把真实数据覆盖掉。
  const broken = loadState({ read: () => ({ version: 99, categories: [], bookmarks: [] }) })
  assert.match(broken.blocked, /无法解析/)
  assert.equal(broken.empty, false, '损坏时也不能拿示例数据顶替')
  assert.deepEqual(broken.state.bookmarks, [])

  const throwing = loadState({ read: () => { throw new Error('dbStorage 挂了') } })
  assert.match(throwing.blocked, /读取失败/)
  assert.equal(throwing.empty, false)
})

test('storage key stays the one earlier versions wrote to', () => {
  assert.equal(STORAGE_KEY, 'funlink-state-v1')
})

test('prepareState reports skipped unsafe cards', () => {
  const { state, dropped } = prepareState({
    version: 1,
    categories: [],
    bookmarks: [
      { id: 'w1', title: '好的', url: 'https://example.com/' },
      { id: 'w2', title: '危险', url: 'javascript:alert(1)' },
    ],
  })
  assert.equal(dropped, 1)
  assert.deepEqual(state.bookmarks.map(bookmark => bookmark.id), ['w1'])
  assert.deepEqual(state.bookmarks[0].categoryIds, ['cat@default'])
})
