import { test } from 'vitest'
import assert from 'node:assert/strict'
import { convertLegacyExport, isLegacyExport } from '../src/lib/legacy.ts'
import { prepareState } from '../src/lib/state.ts'

// 取自「网址精灵」真实导出的各类文档形状（内容已简化）。
const EXPORT = {
  db: [
    { _id: 'cat_root', label: '开发', pid: '', tabPosition: 'left', children: [] },
    { _id: 'cat_child', label: '文档', pid: 'cat_root', tabPosition: 'top', children: [] },
    { _id: 'cat_other', label: '娱乐', pid: '', tabPosition: 'top', children: [] },
    {
      _id: 'web_1', title: 'GitHub', url: 'https://github.com/', desc: '代码托管',
      catIds: ['cat_child'], isFly: true, isOften: false, browser: 'chrome',
      icon: { type: 'text', text: 'GH', fontSize: 18, textColor: '#2792ff', data: '' },
    },
    {
      // image 型但没有图片数据：原插件靠第三方 favicon 现取，必须回落成文字图标
      _id: 'web_2', title: '掘金', url: 'https://juejin.cn/', desc: '',
      catIds: ['cat_root'], isFly: false, isOften: true,
      icon: { type: 'image', text: '', fontSize: 16, textColor: '#ff7f1b', data: '' },
    },
    {
      _id: 'web_3', title: '带图标的', url: 'https://example.com/',
      catIds: ['cat@default'], browser: 0,
      icon: { type: 'image', data: 'data:image/png;base64,AAAA' },
    },
    { _id: 'web_4', title: '已删除', url: 'https://trash.example/', catIds: ['cat_root', 'cat@dustbin'] },
    { _id: 'web_5', title: '有笔记', url: 'https://note.example/', catIds: ['cat_root'], hasNote: true },
    { _id: 'web_bad', title: '危险', url: 'javascript:alert(1)', catIds: ['cat_root'] },
    { _id: 'note_5', title: '有笔记', content: '<p>笔记正文</p>' },
    { _id: 'setting', value: { browser: { isOpenIn: true, width: 1200, height: 800 }, search: ['title', 'url', 'desc'], navbar: { rounded: 12 } } },
    { _id: 'sort_cat@category', value: [{ _id: 'cat_other', children: [] }, { _id: 'cat_root', children: [{ _id: 'cat_child' }] }] },
    { _id: 'sort_web@cat_root', value: ['web_5', 'web_2'] },
    { _id: 'cookie@web_1', data: 'U2FsdGVkX1+encrypted' },
  ],
  flyDb: [{ code: 'open@web_1', cmds: ['GitHub'], explain: '前往 GitHub' }],
}

test('isLegacyExport recognises both export shapes', () => {
  assert.equal(isLegacyExport(EXPORT), true)
  assert.equal(isLegacyExport([{ _id: 'web_1', title: 'x', url: 'https://x.com' }]), true, '裸数组也是合法形状')
  assert.equal(isLegacyExport({ version: 1, categories: [], bookmarks: [] }), false, 'FunLink 自己的备份不能误判')
  assert.equal(isLegacyExport(null), false)
})

test('convertLegacyExport maps categories, bookmarks and markers', () => {
  const { state, dropped } = convertLegacyExport(EXPORT)

  assert.equal(dropped, 1, 'javascript: 卡片要被丢弃并计数')
  assert.deepEqual(state.bookmarks.map(bookmark => bookmark.id).sort(), ['web_1', 'web_2', 'web_3', 'web_4', 'web_5'])

  // 分类树：pid 转 parentId，setting / sort_ / cookie@ 等文档不能混进分类
  assert.equal(state.categories.length, 3)
  assert.equal(state.categories.find(c => c.id === 'cat_child').parentId, 'cat_root')
  assert.equal(state.categories.find(c => c.id === 'cat_root').tabPosition, 'left')

  const byId = Object.fromEntries(state.bookmarks.map(bookmark => [bookmark.id, bookmark]))
  assert.equal(byId.web_1.quick, true, 'isFly -> quick')
  assert.equal(byId.web_2.favorite, true, 'isOften -> favorite')
  assert.equal(byId.web_1.description, '代码托管', 'desc -> description')
  assert.equal(byId.web_5.note, '<p>笔记正文</p>', 'note_ 文档按 id 后缀挂到对应卡片')

  // cat@dustbin 是状态标记，应转成 deletedAt 且不留在 categoryIds 里
  assert.ok(byId.web_4.deletedAt)
  assert.deepEqual(byId.web_4.categoryIds, ['cat_root'])
  assert.equal(byId.web_1.deletedAt, null)

  // 收集箱要保留
  assert.deepEqual(byId.web_3.categoryIds, ['cat@default'])
})

test('convertLegacyExport falls back to text icons without image data', () => {
  const { state } = convertLegacyExport(EXPORT)
  const byId = Object.fromEntries(state.bookmarks.map(bookmark => [bookmark.id, bookmark]))

  assert.equal(byId.web_2.iconType, 'text', 'image 但无 data 必须回落，否则显示成空白圆圈')
  assert.equal(byId.web_2.icon, '掘金', '没有图标文字时用标题首字')
  assert.equal(byId.web_3.iconType, 'image', '真有图片数据的要保留')
  assert.equal(byId.web_3.iconData, 'data:image/png;base64,AAAA')
  assert.equal(byId.web_1.icon, 'GH')
  assert.equal(byId.web_1.color, '#2792ff')
})

test('convertLegacyExport normalises browser values', () => {
  const { state } = convertLegacyExport(EXPORT)
  const byId = Object.fromEntries(state.bookmarks.map(bookmark => [bookmark.id, bookmark]))
  assert.equal(byId.web_1.browser, 'chrome', '已知浏览器保留')
  assert.equal(byId.web_3.browser, 'default', '历史遗留的数字值回落为 default')
  assert.equal(byId.web_4.browser, 'default', '缺省值回落为 default')
})

test('convertLegacyExport applies the saved sort order', () => {
  const { state } = convertLegacyExport(EXPORT)
  // sort_cat@category 把 cat_other 排在 cat_root 前面
  assert.deepEqual(state.categories.map(category => category.id), ['cat_other', 'cat_root', 'cat_child'])
  // sort_web@cat_root 指定 web_5 在 web_2 之前
  const order = state.bookmarks.map(bookmark => bookmark.id)
  assert.ok(order.indexOf('web_5') < order.indexOf('web_2'))
})

test('convertLegacyExport carries settings over with desc renamed', () => {
  const { state } = convertLegacyExport(EXPORT)
  assert.equal(state.settings.browser.isOpenIn, true)
  assert.equal(state.settings.browser.width, 1200)
  assert.equal(state.settings.navbar.rounded, 12)
  assert.deepEqual(state.settings.search, ['title', 'url', 'description'], 'desc 字段名要换成 description')
  assert.equal(state.settings.importSplit, '-,_,|,:,/,||', '缺失的设置项补默认值')
})

test('converted state passes the normal restore pipeline', () => {
  const { state } = convertLegacyExport(EXPORT)
  const result = prepareState(state)
  assert.equal(result.dropped, 0, '转换后不应再有非法 URL')
  assert.equal(result.state.bookmarks.length, 5)
  assert.equal(result.state.currentView, 'category:cat_other')
  assert.ok(result.state.bookmarks.every(bookmark => bookmark.categoryIds.length > 0))
})

test('convertLegacyExport rejects a shape it cannot read', () => {
  assert.throws(() => convertLegacyExport({ db: 'nope' }), /网址精灵/)
})

test('convertLegacyExport rejects non-data:image icon payloads', () => {
  const { state } = convertLegacyExport([
    { _id: 'web_file', title: '本地图', url: 'https://a.example.com/', icon: { type: 'image', data: 'file:///etc/passwd' } },
    { _id: 'web_js', title: '脚本图', url: 'https://b.example.com/', icon: { type: 'image', data: 'javascript:alert(1)' } },
    { _id: 'web_ok', title: '正常图', url: 'https://c.example.com/', icon: { type: 'image', data: 'data:image/png;base64,AAAA' } },
  ])
  const byId = Object.fromEntries(state.bookmarks.map(bookmark => [bookmark.id, bookmark]))
  assert.equal(byId.web_file.iconType, 'text')
  assert.equal(byId.web_file.iconData, '')
  assert.equal(byId.web_js.iconType, 'text')
  assert.equal(byId.web_js.iconData, '')
  assert.equal(byId.web_ok.iconType, 'image')
  assert.equal(byId.web_ok.iconData, 'data:image/png;base64,AAAA')
})
