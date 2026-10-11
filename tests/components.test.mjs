// @vitest-environment jsdom
// 几个展示型组件的用例：它们没有内部状态，重点是渲染出来的内容和抛出的事件。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mount } from '@vue/test-utils'
import AppHeader from '../src/components/AppHeader.vue'
import BookmarkCard from '../src/components/BookmarkCard.vue'
import BookmarkGrid from '../src/components/BookmarkGrid.vue'
import ContextMenu from '../src/components/ContextMenu.vue'
import KeywordDialog from '../src/components/KeywordDialog.vue'
import SecondaryNavigation from '../src/components/SecondaryNavigation.vue'
import { nextTick } from 'vue'

const ROOTS = [
  { id: 'cat_1', name: '工作', parentId: '' },
  { id: 'cat_2', name: '娱乐', parentId: '' },
]

test('顶部导航高亮当前一级分类并回传 category: 前缀', async () => {
  const wrapper = mount(AppHeader, { props: { roots: ROOTS, currentView: 'category:cat_2', activeRootId: 'cat_2', theme: 'dark' } })
  const buttons = wrapper.findAll('.top-nav > button')

  assert.ok(!buttons[0].classes('active'))
  assert.ok(buttons[1].classes('active'))
  await buttons[0].trigger('click')
  assert.deepEqual(wrapper.emitted('select'), [['category:cat_1']])
})

test('右键顶部导航打开分类管理', async () => {
  const wrapper = mount(AppHeader, { props: { roots: ROOTS, currentView: 'inbox', activeRootId: '', theme: 'system' } })
  await wrapper.find('.top-nav').trigger('contextmenu')

  assert.equal(wrapper.emitted('manage').length, 1)
})

test('二级分类为空时整条导航不渲染', () => {
  const wrapper = mount(SecondaryNavigation, { props: { categories: [], activeCategoryId: '' } })

  assert.equal(wrapper.find('.secondary-nav').exists(), false)
})

test('二级导航按位置加上样式类', () => {
  const wrapper = mount(SecondaryNavigation, { props: { categories: ROOTS, activeCategoryId: 'cat_1', position: 'left' } })

  assert.ok(wrapper.find('.secondary-nav').classes('is-left'))
  assert.ok(wrapper.findAll('.secondary-nav > button')[0].classes('active'))
})

test('卡片没有简介时退化成显示主机名', () => {
  const wrapper = mount(BookmarkCard, { props: { bookmark: { id: 'web_1', title: '示例站点', url: 'https://www.example.com/path?a=1' } } })

  assert.equal(wrapper.find('.bookmark-copy p span').text(), 'www.example.com')
})

test('卡片有简介时优先显示简介', () => {
  const wrapper = mount(BookmarkCard, { props: { bookmark: { id: 'web_1', title: '示例站点', url: 'https://example.com', description: '一句话简介' } } })

  assert.equal(wrapper.find('.bookmark-copy p span').text(), '一句话简介')
})

test('卡片图标只用本地图片，image 类型缺数据时回退成文字', () => {
  const wrapper = mount(BookmarkCard, { props: { bookmark: { id: 'web_1', title: 'Hello World', url: 'https://example.com', iconType: 'image' } } })

  assert.equal(wrapper.find('.bookmark-icon img').exists(), false)
  assert.equal(wrapper.find('.bookmark-icon span').text(), 'HW')
})

test('点图标打开笔记，点卡片其他区域打开网址', async () => {
  const bookmark = { id: 'web_1', title: '示例', url: 'https://example.com' }
  const wrapper = mount(BookmarkCard, { props: { bookmark } })

  await wrapper.find('.bookmark-icon').trigger('click')
  assert.deepEqual(wrapper.emitted('note'), [[bookmark]])
  assert.equal(wrapper.emitted('open'), undefined)

  await wrapper.find('.bookmark-copy').trigger('click')
  assert.deepEqual(wrapper.emitted('open'), [[bookmark]])
})

test('废纸篓视图里的卡片不能拖动', () => {
  const wrapper = mount(BookmarkCard, { props: { bookmark: { id: 'web_1', title: '示例', url: 'https://example.com' }, trashView: true } })

  assert.equal(wrapper.find('.bookmark-card').attributes('draggable'), 'false')
})

test('卡片有笔记时显示笔记标记', () => {
  const wrapper = mount(BookmarkCard, { props: { bookmark: { id: 'web_1', title: '示例', url: 'https://example.com', hasNote: true } } })

  assert.ok(wrapper.find('.note-mark').exists())
})

test('网格按需渲染添加按钮并把卡片事件透传上来', async () => {
  const bookmarks = [{ id: 'web_1', title: 'A', url: 'https://a.com' }, { id: 'web_2', title: 'B', url: 'https://b.com' }]
  const wrapper = mount(BookmarkGrid, { props: { bookmarks, showAdd: true } })

  assert.equal(wrapper.findAll('.bookmark-card').length, 2)
  await wrapper.find('.add-item').trigger('click')
  assert.equal(wrapper.emitted('add').length, 1)

  await wrapper.findAll('.bookmark-copy')[1].trigger('click')
  assert.deepEqual(wrapper.emitted('open'), [[bookmarks[1]]])
})

test('showAdd 为假时不渲染添加按钮', () => {
  const wrapper = mount(BookmarkGrid, { props: { bookmarks: [], showAdd: false } })

  assert.equal(wrapper.find('.add-item').exists(), false)
})

test('右键菜单渲染分隔线并回传 action', async () => {
  const items = [
    { action: 'edit', label: '编辑', icon: 'icon-edit', divided: true },
    { action: 'trash', label: '移除' },
  ]
  const wrapper = mount(ContextMenu, { props: { items, x: 10, y: 20 } })

  assert.equal(wrapper.findAll('.menu-divider').length, 1)
  await wrapper.findAll('button')[1].trigger('click')
  assert.deepEqual(wrapper.emitted('select'), [['trash']])
})

test('右键菜单贴边时会被拉回视口内', async () => {
  // jsdom 里 offsetWidth 恒为 0，所以按兜底宽度 184 算：1024 - 184 - 8 = 832。
  const wrapper = mount(ContextMenu, { props: { items: [{ action: 'edit', label: '编辑' }], x: 2000, y: -50 } })
  await new Promise(resolve => setTimeout(resolve, 0))

  const style = wrapper.find('.context-menu').attributes('style')
  assert.match(style, /left: 832px/)
  assert.match(style, /top: 8px/)
})

test('关键词对话框提交时带上输入的关键词', async () => {
  // jsdom 不一定实现 <dialog> 的模态行为，这里只需要 open 标记跟着变。
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
  const wrapper = mount(KeywordDialog, { attachTo: document.body, props: { visible: true, title: '站内搜索' } })
  await nextTick()

  assert.equal(wrapper.find('h2').text(), '站内搜索')
  await wrapper.find('input').setValue('vue')
  await wrapper.find('form').trigger('submit')
  assert.deepEqual(wrapper.emitted('submit'), [['vue']])

  await wrapper.find('footer .button').trigger('click')
  assert.equal(wrapper.emitted('cancel').length, 1)
})

test('关键词对话框每次打开都清空上一次的输入', async () => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
  const wrapper = mount(KeywordDialog, { attachTo: document.body, props: { visible: true } })
  await nextTick()
  await wrapper.find('input').setValue('上一次')

  await wrapper.setProps({ visible: false })
  await nextTick()
  await wrapper.setProps({ visible: true })
  await nextTick()

  assert.equal(wrapper.find('input').element.value, '')
})
