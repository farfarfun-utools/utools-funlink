import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildBookmark, describeBookmark, findBookmark, findByUrl, listCategories, resolveCategoryId, searchBookmarks } from '../src/lib/tools.ts'

function fakeState(bookmarks = [], categories = []) {
  return {
    version: 1,
    theme: 'system',
    currentView: 'inbox',
    lastCategoryId: '',
    settings: { browser: { isOpenIn: false, width: 1000, height: 680 }, search: ['title', 'description', 'url'], importSplit: '-', navbar: { rounded: 36 } },
    categories,
    bookmarks,
  }
}

const sample = () => fakeState([
  { id: 'w1', title: '文档', url: 'https://doc.example.com/', description: '开发文档', categoryIds: ['cat1'], note: '<p>记一笔</p>' },
  { id: 'w2', title: '论坛', url: 'https://forum.example.com/', categoryIds: ['cat@default'], favorite: true },
  { id: 'w3', title: '站内搜索', url: 'https://s.example.com/?q={q}', categoryIds: ['cat1'], quick: true },
  { id: 'w4', title: '删掉的文档', url: 'https://old.example.com/', categoryIds: ['cat1'], deletedAt: 1 },
], [
  { id: 'cat1', name: '工作', parentId: '' },
  { id: 'cat2', name: '阅读', parentId: 'cat1' },
])

test('search_bookmarks 按关键词匹配，废纸篓里的卡片不出现在结果里', () => {
  const result = searchBookmarks(sample(), { keyword: '文档' })

  assert.deepEqual(result.bookmarks.map(bookmark => bookmark.id), ['w1'], '已删除的「删掉的文档」不该被搜出来')
  assert.equal(result.total, 1)
})

test('search_bookmarks 关键词留空返回全部未删除卡片', () => {
  const result = searchBookmarks(sample(), {})

  assert.deepEqual(result.bookmarks.map(bookmark => bookmark.id), ['w1', 'w2', 'w3'])
})

// 整库可能有上千条，一次全丢给 AI 既占上下文又没意义。
test('search_bookmarks 的 limit 有默认值和上限，非法值按默认处理', () => {
  const many = fakeState(Array.from({ length: 80 }, (_, index) => ({ id: `w${index}`, title: `卡片${index}`, url: `https://e${index}.example.com/` })))

  assert.equal(searchBookmarks(many, {}).bookmarks.length, 10, '默认返回 10 条')
  assert.equal(searchBookmarks(many, { limit: 50 }).bookmarks.length, 50)
  assert.equal(searchBookmarks(many, { limit: 500 }).bookmarks.length, 50, '上限 50')
  assert.equal(searchBookmarks(many, { limit: 'abc' }).bookmarks.length, 10)
  assert.equal(searchBookmarks(many, { limit: -3 }).bookmarks.length, 10)
  assert.equal(searchBookmarks(many, { limit: 3 }).total, 80, 'total 给的是命中总数，不是返回条数')
})

// 图标数据是 base64 图片，笔记正文可能有几千字，都不该挤进 AI 的上下文。
test('describeBookmark 只输出 AI 用得上的字段，分类给名称而不是 id', () => {
  const state = sample()
  const described = describeBookmark(state, state.bookmarks[0])

  assert.deepEqual(described, {
    id: 'w1',
    title: '文档',
    url: 'https://doc.example.com/',
    description: '开发文档',
    categories: ['工作'],
    favorite: false,
    quick: false,
    hasNote: true,
  })
})

test('describeBookmark 把收集箱的固定 id 显示成名称', () => {
  const state = sample()

  assert.deepEqual(describeBookmark(state, state.bookmarks[1]).categories, ['收集箱'])
})

test('list_categories 列出收集箱和各分类的卡片数', () => {
  assert.deepEqual(listCategories(sample()).categories, [
    { id: 'cat@default', name: '收集箱', parentId: '', count: 1 },
    { id: 'cat1', name: '工作', parentId: '', count: 2 },
    { id: 'cat2', name: '阅读', parentId: 'cat1', count: 0 },
  ])
})

test('resolveCategoryId 接受名称和 id，留空落到收集箱', () => {
  const state = sample()

  assert.equal(resolveCategoryId(state, '工作'), 'cat1')
  assert.equal(resolveCategoryId(state, 'cat1'), 'cat1')
  assert.equal(resolveCategoryId(state, ''), 'cat@default')
  assert.equal(resolveCategoryId(state, '收集箱'), 'cat@default')
})

// 猜一个分类塞进去不如报错：卡片落错地方用户未必会发现，而 Agent 收到错误会改参数重试。
test('resolveCategoryId 遇到不存在的分类时报错，不默默放进收集箱', () => {
  assert.throws(() => resolveCategoryId(sample(), '不存在的分类'), /没有找到分类/)
})

test('buildBookmark 补协议、补标题简介和图标', () => {
  const built = buildBookmark(sample(), { url: 'doc.example.org/guide' })

  assert.equal(built.url, 'https://doc.example.org/guide')
  assert.equal(built.title, 'doc.example.org', '没给标题就用主机名')
  assert.equal(built.description, 'doc.example.org')
  assert.equal(built.iconType, 'text')
  assert.equal(built.deletedAt, null)
  assert.ok(built.id, '自己生成 id，返回值里才能带给 AI')
})

test('buildBookmark 挡住协议不安全的网址', () => {
  assert.throws(() => buildBookmark(sample(), { url: 'javascript:alert(1)' }), /仅支持/)
  assert.throws(() => buildBookmark(sample(), {}), /请输入网址/)
})

test('findByUrl 只认未删除的卡片', () => {
  const state = sample()

  assert.equal(findByUrl(state, 'https://doc.example.com/')?.id, 'w1')
  assert.equal(findByUrl(state, 'https://old.example.com/'), undefined, '废纸篓里的不算已收藏')
})

test('findBookmark 支持按 id 和按关键词定位', () => {
  const state = sample()

  assert.equal(findBookmark(state, { id: 'w2' }).title, '论坛')
  assert.equal(findBookmark(state, { keyword: '论坛' }).id, 'w2')
})

test('findBookmark 定位不到时报错，并提示下一步怎么做', () => {
  const state = sample()

  assert.throws(() => findBookmark(state, { id: 'w4' }), /没有找到 id/, '废纸篓里的卡片不该被打开')
  assert.throws(() => findBookmark(state, { keyword: '没有这个' }), /search_bookmarks/)
  assert.throws(() => findBookmark(state, {}), /id 或 keyword/)
})
