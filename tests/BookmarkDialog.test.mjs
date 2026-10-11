// @vitest-environment jsdom
import { test } from 'vitest'
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

async function openDialog(bookmark = null) {
  stubDialog()
  const wrapper = mount(BookmarkDialog, {
    attachTo: document.body,
    props: { categories: CATEGORIES, defaultCategoryId: 'cat_2', bookmarkCount: 3 },
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
