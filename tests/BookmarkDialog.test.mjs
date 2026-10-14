// @vitest-environment jsdom
import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import BookmarkDialog from '../src/components/BookmarkDialog.vue'

const CATEGORIES = [
  { id: 'cat_1', name: '工作', parentId: '' },
  { id: 'cat_1_1', name: '文档', parentId: 'cat_1' },
  { id: 'cat_1_2', name: '工具', parentId: 'cat_1' },
  { id: 'cat_2', name: '娱乐', parentId: '' },
]

// jsdom 不一定实现 <dialog> 的模态行为，这里只需要 open 标记跟着变。
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

async function openDialog(bookmark = null, props = {}) {
  stubDialog()
  const wrapper = mount(BookmarkDialog, {
    attachTo: document.body,
    props: { categories: CATEGORIES, defaultCategoryId: 'cat_2', bookmarkCount: 3, ...props },
  })
  wrapper.vm.open(bookmark)
  await nextTick()
  return wrapper
}

function tagNames(wrapper) {
  return wrapper.findAll('.selected-tag > span').map(node => node.text())
}

test('旧备份里 { value } 形式的附加网址会拍平成字符串', async () => {
  const wrapper = await openDialog({
    id: 'web_1', title: '示例', url: 'https://example.com',
    urls: [{ value: 'https://a.example.com' }, 'https://b.example.com'],
  })

  const extras = wrapper.findAll('.extra-url').map(input => input.element.value)
  assert.deepEqual(extras, ['https://a.example.com', 'https://b.example.com'])
})

test('保存时网址会补全协议、标题去掉首尾空格', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '  示例  ', url: 'example.com' })
  await wrapper.find('form').trigger('submit')

  const [[saved, afterId]] = wrapper.emitted('save')
  assert.equal(saved.url, 'https://example.com/')
  assert.equal(saved.title, '示例')
  assert.equal(saved.id, 'web_1')
  assert.equal(afterId, null)
})

test('没填标题时报错且不保存', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '示例', url: 'https://example.com' })
  const title = wrapper.findAll('.web-preview-fields input')[0]
  await title.setValue('   ')
  await wrapper.find('form').trigger('submit')

  assert.equal(wrapper.emitted('save'), undefined)
  assert.equal(wrapper.find('.form-error').text(), '网站名称不能为空')
})

test('清空分类后保存会提示选分类', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '示例', url: 'https://example.com' })
  await wrapper.find('.category-clear').trigger('click')
  await wrapper.find('form').trigger('submit')

  assert.equal(wrapper.emitted('save'), undefined)
  assert.equal(wrapper.find('.form-error').text(), '请选择分类')
})

test('勾选一级分类等于勾上它的全部子分类', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '示例', url: 'https://example.com', categoryIds: ['cat_2'] })
  assert.deepEqual(tagNames(wrapper), ['娱乐'])

  await wrapper.find('.category-select').trigger('click')
  const rows = wrapper.findAll('.category-option-row')
  await rows.find(row => row.text().includes('工作')).trigger('click')

  assert.deepEqual(tagNames(wrapper), ['娱乐', '文档', '工具'])
})

test('图片图标超过 200KB 会被挡住', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '示例', url: 'https://example.com' })
  const input = wrapper.find('input[type="file"]')
  const file = new File([new Uint8Array(300 * 1024)], 'icon.png', { type: 'image/png' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })

  await input.trigger('change')
  await nextTick()

  assert.equal(wrapper.find('.form-error').text(), '图标图片不能超过 200KB')
})

test('新建卡片时网址未填协议前只显示骨架屏', async () => {
  const wrapper = await openDialog()

  assert.ok(wrapper.find('.web-edit-card').classes('skeleton'))
  assert.equal(wrapper.find('.form-error').exists(), false)
})

// 自动抓图标的链路是：弹窗 → lib/image → preload 桥接层 → 解码压缩。
// 桥接层和图片解码在 jsdom 里都不存在，这里全换成替身（解码细节由 image.test.mjs 覆盖），
// 只验弹窗这一层的行为：什么时候抓、抓回来填不填。
const RAW_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const FETCHED = 'data:image/webp;base64,FETCHED'
// 抓取要跨好几个 await（桥接层 → 解码 → 压缩 → 渲染），把排队的微任务跑干再断言。
const AFTER_FETCH = 600 + 50

function stubIconPipeline(fetchIcon) {
  const createElement = document.createElement.bind(document)
  globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} })
  document.createElement = tag => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => FETCHED }
    : createElement(tag)
  window.funlink = { fetchIcon }
  vi.useFakeTimers()
  return () => {
    vi.useRealTimers()
    document.createElement = createElement
    delete globalThis.createImageBitmap
    delete window.funlink
  }
}

function defer() {
  let resolve = () => {}
  const promise = new Promise(settle => { resolve = settle })
  return { promise, resolve }
}

async function settle() {
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
  await nextTick()
}

test('填完网址后自动去站点抓一张图标填进表单', async () => {
  const gate = defer()
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); await gate.promise; return RAW_ICON })
  try {
    const wrapper = await openDialog()
    const input = wrapper.find('.bookmark-url-input')
    await input.setValue('https://exa')
    await input.setValue('https://example.com/{q}')
    assert.deepEqual(requested, [], '每敲一个字都发一次请求的话，一个网址要抓十几遍')

    await vi.advanceTimersByTimeAsync(AFTER_FETCH)
    assert.deepEqual(requested, ['https://example.com/'], '搜索类网址带着 {q} 占位符，要去掉再抓')
    await nextTick()
    assert.ok(wrapper.find('.icon-spinner').exists(), '抓的这几秒要有个转圈，否则像是卡住了')

    gate.resolve()
    await settle()
    assert.equal(wrapper.find('.web-preview-icon img').attributes('src'), FETCHED)
    assert.equal(wrapper.find('.icon-spinner').exists(), false)
  } finally {
    restore()
  }
})

test('设置里关掉自动抓取后，填网址不会访问那个站点', async () => {
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); return RAW_ICON })
  try {
    const wrapper = await openDialog(null, { autoIcon: false })
    await wrapper.find('.bookmark-url-input').setValue('https://example.com')
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    assert.deepEqual(requested, [])
    assert.equal(wrapper.find('.web-preview-icon img').exists(), false)
  } finally {
    restore()
  }
})

test('只抓 http(s)：file 之类的地址没有网页图标可读', async () => {
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); return RAW_ICON })
  try {
    const wrapper = await openDialog()
    await wrapper.find('.bookmark-url-input').setValue('file:///home/me/notes.html')
    await vi.advanceTimersByTimeAsync(AFTER_FETCH)
    await settle()

    assert.deepEqual(requested, [])
  } finally {
    restore()
  }
})

test('用户自己定了图标，抓回来的图不往上盖', async () => {
  const gate = defer()
  const restore = stubIconPipeline(async () => { await gate.promise; return RAW_ICON })
  try {
    const wrapper = await openDialog()
    await wrapper.find('.bookmark-url-input').setValue('https://example.com')
    await vi.advanceTimersByTimeAsync(AFTER_FETCH)
    // 抓的过程中用户自己点了「文字」图标。
    await wrapper.findAll('.icon-type-switch button')[0].trigger('click')

    gate.resolve()
    await settle()
    assert.equal(wrapper.find('.web-preview-icon img').exists(), false, '用户自己的选择优先于抓来的图')
    assert.equal(wrapper.find('.icon-spinner').exists(), false)
  } finally {
    restore()
  }
})

test('抓的过程中改了网址，上一个网址的图标不会落到新网址上', async () => {
  const gate = defer()
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); await gate.promise; return RAW_ICON })
  try {
    const wrapper = await openDialog()
    const input = wrapper.find('.bookmark-url-input')
    await input.setValue('https://old.example.com')
    await vi.advanceTimersByTimeAsync(AFTER_FETCH)
    assert.deepEqual(requested, ['https://old.example.com'])

    await input.setValue('https://new.example.com')
    gate.resolve()
    await settle()
    assert.equal(wrapper.find('.web-preview-icon img').exists(), false, 'old 站点的图标不该挂到 new 站点上')
  } finally {
    restore()
  }
})

// 自动抓取的规矩是「不覆盖用户定过的图标」，手动按的这一下正好相反：
// 存量卡片本来就有文字图标 / 旧图片，点了就是想换掉。
test('手动点抓取会盖掉卡片原来的图标', async () => {
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); return RAW_ICON })
  try {
    const wrapper = await openDialog({
      id: 'web_1', title: '示例', url: 'https://example.com',
      iconType: 'image', iconData: 'data:image/webp;base64,MINE',
    })
    await wrapper.find('.icon-fetch').trigger('click')
    await settle()

    assert.deepEqual(requested, ['https://example.com'])
    assert.equal(wrapper.find('.web-preview-icon img').attributes('src'), FETCHED)
  } finally {
    restore()
  }
})

test('手动抓不到图标时明确告诉用户，而不是默默没反应', async () => {
  const restore = stubIconPipeline(async () => '')
  try {
    const wrapper = await openDialog({ id: 'web_1', title: '示例', url: 'https://no-icon.example.com' })
    await wrapper.find('.icon-fetch').trigger('click')
    await settle()

    assert.equal(wrapper.find('.form-error').text(), '没抓到这个网站的图标')
    assert.equal(wrapper.find('.icon-spinner').exists(), false)
  } finally {
    restore()
  }
})

test('非 http(s) 的网址没有图标可抓，不显示这个按钮', async () => {
  const wrapper = await openDialog({ id: 'web_1', title: '本地文件', url: 'file:///home/me/notes.html' })
  assert.equal(wrapper.find('.icon-fetch').exists(), false)

  await wrapper.find('.bookmark-url-input').setValue('https://example.com')
  assert.ok(wrapper.find('.icon-fetch').exists())
})

test('编辑已有卡片时不动它原来的图标', async () => {
  const requested = []
  const restore = stubIconPipeline(async url => { requested.push(url); return RAW_ICON })
  try {
    const wrapper = await openDialog({
      id: 'web_1', title: '示例', url: 'https://example.com',
      iconType: 'image', iconData: 'data:image/webp;base64,MINE',
    })
    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    assert.deepEqual(requested, [], '点开弹窗看一眼，不该把人家原来的图标换掉')
    assert.equal(wrapper.find('.web-preview-icon img').attributes('src'), 'data:image/webp;base64,MINE')
  } finally {
    restore()
  }
})
