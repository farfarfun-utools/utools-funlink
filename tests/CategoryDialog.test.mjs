// @vitest-environment jsdom
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import CategoryDialog from '../src/components/CategoryDialog.vue'

const CATEGORIES = [
  { id: 'cat_1', name: '工作', parentId: '' },
  { id: 'cat_1_1', name: '文档', parentId: 'cat_1' },
  { id: 'cat_2', name: '娱乐', parentId: '' },
]

// jsdom 不一定实现 <dialog> 的模态行为，这里只需要 open 标记跟着变。
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

async function openDialog(categoryCount = () => 0, categories = CATEGORIES) {
  stubDialog()
  const wrapper = mount(CategoryDialog, { attachTo: document.body, props: { categories, categoryCount } })
  wrapper.vm.open()
  await nextTick()
  return wrapper
}

function nameField(wrapper, text) {
  return wrapper.findAll('.category-name').find(node => node.text() === text)
}

test('回车提交新的一级分类', async () => {
  const wrapper = await openDialog()
  await wrapper.find('.category-root-form input').setValue('  学习  ')
  await wrapper.find('.category-root-form').trigger('submit')

  assert.deepEqual(wrapper.emitted('add'), [['学习', '']])
  assert.equal(wrapper.find('.category-root-form input').element.value, '')
})

test('分类名为空时不提交', async () => {
  const wrapper = await openDialog()
  await wrapper.find('.category-root-form input').setValue('   ')
  await wrapper.find('.category-root-form').trigger('submit')

  assert.equal(wrapper.emitted('add'), undefined)
})

test('改名失焦后发出 rename', async () => {
  const wrapper = await openDialog()
  const field = nameField(wrapper, '工作')
  field.element.innerText = '  办公  '
  await field.trigger('blur')

  assert.deepEqual(wrapper.emitted('action'), [['cat_1', { type: 'rename', name: '办公' }]])
})

test('改成空名字时还原原名且不发出事件', async () => {
  const wrapper = await openDialog()
  const field = nameField(wrapper, '工作')
  field.element.innerText = '   '
  await field.trigger('blur')

  assert.equal(wrapper.emitted('action'), undefined)
  assert.equal(field.element.innerText, '工作')
})

test('名字没变时不发出 rename，避免白写一次盘', async () => {
  const wrapper = await openDialog()
  const field = nameField(wrapper, '娱乐')
  field.element.innerText = '娱乐'
  await field.trigger('blur')

  assert.equal(wrapper.emitted('action'), undefined)
})

test('二级 Tabs 位置选项带上分类 id 发出 position', async () => {
  const wrapper = await openDialog()
  // 气泡定位要读元素尺寸，jsdom 里全是 0，但 position 事件本身不依赖它。
  await wrapper.findAll('.category-action.success')[0].trigger('click')
  const options = wrapper.findAll('.position-options input')
  await options[2].trigger('change')

  assert.deepEqual(wrapper.emitted('action'), [['cat_1', { type: 'position', position: 'top' }]])
})

test('删除确认后发出 delete 并关掉气泡', async () => {
  const wrapper = await openDialog()
  await wrapper.findAll('.category-action.danger')[0].trigger('click')
  await wrapper.find('.confirm-delete').trigger('click')

  assert.deepEqual(wrapper.emitted('action'), [['cat_1', { type: 'delete', confirmed: true }]])
  assert.equal(wrapper.find('.delete-popover').exists(), false)
})

test('带卡片的一级分类不能被拖进别的分类', async () => {
  // 一级分类下还有卡片时拖进去会让这些卡片无处可去，所以这种拖拽要被忽略。
  const wrapper = await openDialog(id => (id === 'cat_2' ? 4 : 0))
  await wrapper.findAll('.category-item-content')[2].trigger('dragstart')
  await wrapper.findAll('.category-children')[0].trigger('drop')

  assert.equal(wrapper.emitted('action'), undefined)
})

test('空的一级分类可以拖进另一个一级分类', async () => {
  const wrapper = await openDialog()
  await wrapper.findAll('.category-item-content')[2].trigger('dragstart')
  await wrapper.findAll('.category-children')[0].trigger('drop')

  assert.deepEqual(wrapper.emitted('action'), [['cat_2', { type: 'move', parentId: 'cat_1', targetId: '' }]])
})

test('拖到同级分类上发出排序用的 move', async () => {
  const wrapper = await openDialog()
  await wrapper.findAll('.category-item-content')[2].trigger('dragstart')
  await wrapper.findAll('.category-item-content')[0].trigger('drop')

  assert.deepEqual(wrapper.emitted('action'), [['cat_2', { type: 'move', parentId: '', targetId: 'cat_1' }]])
})
