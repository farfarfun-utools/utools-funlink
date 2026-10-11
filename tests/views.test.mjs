import { test } from 'vitest'
import assert from 'node:assert/strict'
import { activeCategoryId, activeRootId, childrenOf, defaultCategoryId, pushableBookmarks, visibleBookmarks } from '../src/lib/views.ts'

function makeState(overrides = {}) {
  return {
    version: 1,
    theme: 'system',
    currentView: 'all',
    lastCategoryId: '',
    settings: { browser: { isOpenIn: false, width: 1000, height: 680 }, search: ['title', 'description', 'url'], importSplit: '-', navbar: { rounded: 36 } },
    categories: [
      { id: 'work', name: '工作', parentId: '' },
      { id: 'work-doc', name: '文档', parentId: 'work' },
      { id: 'life', name: '生活', parentId: '' },
    ],
    bookmarks: [
      { id: 'b1', title: '工作台', url: 'https://work.example.com/', categoryIds: ['work'] },
      { id: 'b2', title: '接口文档', url: 'https://doc.example.com/', categoryIds: ['work-doc'] },
      { id: 'b3', title: '收集箱里的', url: 'https://inbox.example.com/', categoryIds: [] },
      { id: 'b4', title: '常用的', url: 'https://fav.example.com/', categoryIds: ['life'], favorite: true },
      { id: 'b5', title: '删掉的工作台', url: 'https://trash.example.com/', categoryIds: ['work'], deletedAt: 1 },
    ],
    ...overrides,
  }
}

const titles = bookmarks => bookmarks.map(bookmark => bookmark.title)

test('停在一级分类上时连子分类的卡片一起显示', () => {
  const state = makeState({ currentView: 'category:work' })

  assert.deepEqual(titles(visibleBookmarks(state, '')), ['工作台', '接口文档'])
})

test('停在子分类上时只显示它自己的卡片', () => {
  const state = makeState({ currentView: 'category:work-doc' })

  assert.deepEqual(titles(visibleBookmarks(state, '')), ['接口文档'])
})

test('收集箱收的是没有分类和落在 cat@default 的卡片', () => {
  const state = makeState({ currentView: 'inbox' })
  state.bookmarks.push({ id: 'b6', title: '默认分类', url: 'https://d.example.com/', categoryIds: ['cat@default'] })

  assert.deepEqual(titles(visibleBookmarks(state, '')), ['收集箱里的', '默认分类'])
})

test('搜索会跨出当前分类，但废纸篓里只搜废纸篓', () => {
  const inWork = makeState({ currentView: 'category:work' })
  assert.deepEqual(titles(visibleBookmarks(inWork, '常用')), ['常用的'], '分类视图里搜索要搜全部未删除卡片')

  const inTrash = makeState({ currentView: 'trash' })
  assert.deepEqual(titles(visibleBookmarks(inTrash, '工作台')), ['删掉的工作台'], '废纸篓里搜索不能跳去搜未删除的卡片')
})

test('删掉的卡片只出现在废纸篓里', () => {
  assert.deepEqual(titles(visibleBookmarks(makeState({ currentView: 'all' }), '')), ['工作台', '接口文档', '收集箱里的', '常用的'])
  assert.deepEqual(titles(visibleBookmarks(makeState({ currentView: 'trash' }), '')), ['删掉的工作台'])
})

test('搜索只按设置里勾选的字段匹配', () => {
  const state = makeState({ currentView: 'all' })
  state.settings.search = ['title']
  state.bookmarks[0].description = '仅出现在简介里'

  assert.deepEqual(titles(visibleBookmarks(state, '仅出现在简介里')), [], '没勾简介就不该按简介匹配')
})

test('废纸篓沿用进去之前的分类，二级导航不会整条消失', () => {
  const state = makeState({ currentView: 'trash', lastCategoryId: 'work-doc' })

  assert.equal(activeCategoryId(state), 'work-doc')
  assert.equal(activeRootId(state), 'work', '子分类要回溯到它的一级分类')
})

test('不在分类视图里时没有激活分类', () => {
  assert.equal(activeCategoryId(makeState({ currentView: 'all' })), '')
  assert.equal(activeRootId(makeState({ currentView: 'all' })), '')
})

test('新建卡片的默认分类：分类不存在就回落到 cat@default', () => {
  assert.equal(defaultCategoryId(makeState({ currentView: 'category:life' })), 'life')
  assert.equal(defaultCategoryId(makeState({ currentView: 'inbox' })), 'cat@default')
  // 分类被删掉之后视图可能还指着它。
  assert.equal(defaultCategoryId(makeState({ currentView: 'category:gone' })), 'cat@default')
})

test('childrenOf 只取直接子分类', () => {
  const state = makeState()

  assert.deepEqual(childrenOf(state.categories, 'work').map(category => category.id), ['work-doc'])
  assert.deepEqual(childrenOf(state.categories, 'life'), [])
})

test('主搜索框排除废纸篓和带 {q} 的卡片，并限制条数', () => {
  const state = makeState({ currentView: 'all' })
  state.bookmarks.push({ id: 'b7', title: '工作台搜索', url: 'https://work.example.com/s?q={q}', categoryIds: ['work'] })

  // 带 {q} 的卡片得先输关键词，主搜索框里没法弹对话框。
  assert.deepEqual(titles(pushableBookmarks(state, '工作台')), ['工作台'])
  assert.equal(pushableBookmarks(state, '', 2).length, 2)
})
