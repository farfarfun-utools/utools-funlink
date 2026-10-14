import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  bookmarkMatches, createId, displayHost, isSafeUrl, migrateBookmark, migrateState, moveCategory,
  moveItem, normalizeCategoryIds, normalizeUrl, safeColor, splitTitle, urlsOf, validateState,
} from '../src/lib/core.ts'

test('core bookmark operations stay predictable', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/')
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /仅支持/)
  assert.equal(bookmarkMatches({ title: 'Vue 文档', url: 'https://vuejs.org' }, 'vue'), true)
  assert.equal(bookmarkMatches({ title: 'Vue 文档', description: '渐进式框架' }, '渐进', ['title']), false)
  assert.equal(bookmarkMatches({ title: 'Vue 文档', description: '渐进式框架' }, '渐进', ['description']), true)
  assert.deepEqual(moveItem([{ id: 'a' }, { id: 'b' }], 'a', 'b').map(item => item.id), ['b', 'a'])
  assert.deepEqual(normalizeCategoryIds(['cat-a', 'cat-b', 'cat-a']), ['cat-a', 'cat-b'])
  assert.deepEqual(normalizeCategoryIds([]), ['cat@default'])
  assert.deepEqual(moveCategory([{ id: 'a', parentId: '' }, { id: 'b', parentId: '' }], 'b', 'a').map(item => [item.id, item.parentId]), [['b', 'a'], ['a', '']])
})

test('validateState only rejects the wrong shape', () => {
  assert.throws(() => validateState(null), /不是有效/)
  assert.throws(() => validateState({ version: 2, categories: [], bookmarks: [] }), /不是有效/)
  assert.throws(() => validateState({ version: 1, categories: [] }), /不是有效/)
  const value = { version: 1, categories: [], bookmarks: [] }
  assert.equal(validateState(value), value)
})

// 回归测试：重构前的备份里卡片只有 categoryId，迁移时曾抛异常，
// 上层 catch 后用演示数据顶替，再一保存就把用户数据覆盖掉。
test('migrateBookmark upgrades pre-1.0 cards without throwing', () => {
  const migrated = migrateBookmark({ id: 'w1', title: '旧卡片', url: 'https://example.com/', categoryId: 'cat_demo' })
  assert.deepEqual(migrated.categoryIds, ['cat_demo'])
  assert.equal(migrated.categoryId, 'cat_demo')

  const orphan = migrateBookmark({ id: 'w2', title: '无分类', url: 'https://example.com/' })
  assert.deepEqual(orphan.categoryIds, ['cat@default'])
  assert.equal(orphan.categoryId, 'cat@default')

  const trashed = migrateBookmark({ id: 'w3', url: 'https://example.com/', previousCategoryId: 'cat_demo' })
  assert.deepEqual(trashed.previousCategoryIds, ['cat_demo'])
  assert.equal('previousCategoryId' in trashed, false)
})

// 旧版靠第三方 favicon 服务取图，iconType 是 image 但 iconData always 为空。
// 现在不再外部取图，这类卡片必须回落成文字图标，否则整屏都是空白圆圈。
test('migrateBookmark falls back to a text icon when there is no image data', () => {
  const noData = migrateBookmark({ id: 'w1', url: 'https://example.com/', iconType: 'image', iconData: '' })
  assert.equal(noData.iconType, 'text')

  const withData = migrateBookmark({ id: 'w2', url: 'https://example.com/', iconType: 'image', iconData: 'data:image/png;base64,AAAA' })
  assert.equal(withData.iconType, 'image', '用户自己上传的图片图标要保留')

  const text = migrateBookmark({ id: 'w3', url: 'https://example.com/', iconType: 'text' })
  assert.equal(text.iconType, 'text')
})

test('migrateState keeps good cards and drops unsafe ones', () => {
  const { state, dropped } = migrateState({
    version: 1,
    categories: [{ id: 'cat_demo', name: '演示' }],
    bookmarks: [
      { id: 'w1', url: 'https://example.com/', categoryId: 'cat_demo' },
      { id: 'w2', url: 'javascript:alert(1)', categoryId: 'cat_demo' },
    ],
  })
  assert.equal(dropped, 1)
  assert.deepEqual(state.bookmarks.map(bookmark => bookmark.id), ['w1'])
  assert.equal(state.categories[0].parentId, '')
  assert.equal(state.categories[0].tabPosition, 'top')
})

test('isSafeUrl guards the protocol allow-list', () => {
  assert.equal(isSafeUrl('https://example.com'), true)
  assert.equal(isSafeUrl('example.com'), true)
  assert.equal(isSafeUrl('javascript:alert(1)'), false)
  assert.equal(isSafeUrl(''), false)
  assert.equal(isSafeUrl(undefined), false)
})

test('splitTitle prefers the longest separator', () => {
  assert.deepEqual(splitTitle('掘金 - 开发者社区', '-,_,|'), { title: '掘金', description: '开发者社区' })
  assert.deepEqual(splitTitle('掘金 || 社区', '|,||'), { title: '掘金', description: '社区' })
  assert.deepEqual(splitTitle('没有分隔符', '-,_'), { title: '没有分隔符', description: '' })
  // 分隔符在首尾时不切，避免切出空标题。
  assert.deepEqual(splitTitle('-开头', '-'), { title: '-开头', description: '' })
  assert.deepEqual(splitTitle('结尾-', '-'), { title: '结尾-', description: '' })
})

test('createId does not collide within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => createId('bookmark')))
  assert.equal(ids.size, 500)
  assert.equal([...ids].every(id => id.startsWith('bookmark-')), true)
})

test('displayHost 取主机名，取不出来就原样返回', () => {
  assert.equal(displayHost('https://www.example.com/a/b?c=1'), 'www.example.com')
  assert.equal(displayHost('https://search.example.com?q={q}'), 'search.example.com')
  // 带 {q} 占位符的站内搜索网址、用户手敲一半的网址都解析不成 URL。
  assert.equal(displayHost('example'), 'example')
  assert.equal(displayHost(''), '')
})

// 颜色值会被拼进 style 属性，必须拦住非法内容，否则等于开了个注入口子。
test('safeColor 只放过颜色字面量，其余回退到默认色', () => {
  assert.equal(safeColor('#fff'), '#fff')
  assert.equal(safeColor('#16B8C7'), '#16B8C7')
  assert.equal(safeColor('rgba(1, 2, 3, 0.5)'), 'rgba(1, 2, 3, 0.5)')
  assert.equal(safeColor('red; background: url(javascript:alert(1))'), '#16b8c7')
  assert.equal(safeColor(undefined), '#16b8c7')
})

test('urlsOf 认两种附加网址格式，并挡掉不安全协议', () => {
  // 字符串数组是现在写入的格式，{ value } 对象是「网址精灵」备份里的格式。
  assert.deepEqual(urlsOf({ url: 'https://a.example', urls: ['https://b.example'] }),
    ['https://a.example', 'https://b.example'])
  assert.deepEqual(urlsOf({ url: 'https://a.example', urls: [{ value: 'https://b.example' }] }),
    ['https://a.example', 'https://b.example'])

  // 空串、空白和 javascript: 都不该跟着被打开。
  assert.deepEqual(urlsOf({ url: 'https://a.example', urls: ['', '   ', 'javascript:alert(1)', { value: '' }] }),
    ['https://a.example'])
  // 主网址自己不安全时返回空列表，调用方据此什么都不做。
  assert.deepEqual(urlsOf({ url: 'javascript:alert(1)' }), [])
  assert.deepEqual(urlsOf({ url: '' }), [])
  // urls 字段历史上可能根本不是数组。
  assert.deepEqual(urlsOf({ url: 'https://a.example', urls: 'https://b.example' }), ['https://a.example'])
})
