// @vitest-environment jsdom
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import NoteDialog from '../src/components/NoteDialog.vue'

// jsdom 不一定实现 <dialog> 的模态行为，这里只需要 open 标记跟着变。
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

function bookmarkWith(note) {
  return { id: 'web_1', title: '示例', url: 'https://example.com', note }
}

async function openWith(note) {
  stubDialog()
  const wrapper = mount(NoteDialog, { attachTo: document.body })
  wrapper.vm.open(bookmarkWith(note))
  await nextTick()
  await nextTick()
  return wrapper
}

test('打开笔记时内联事件处理器不会进入 DOM', async () => {
  const wrapper = await openWith('<p>正文</p><img src="x" onerror="globalThis.__pwned = true">')
  const editor = wrapper.find('.note-editor').element

  assert.equal(editor.querySelectorAll('[onerror]').length, 0)
  assert.equal(globalThis.__pwned, undefined)
  assert.match(editor.innerHTML, /正文/)
})

test('笔记里的 script 标签连内容一起丢掉', async () => {
  const wrapper = await openWith('<p>前</p><script>globalThis.__ran = true</script><p>后</p>')
  const editor = wrapper.find('.note-editor').element

  assert.equal(editor.querySelectorAll('script').length, 0)
  assert.equal(globalThis.__ran, undefined)
  assert.doesNotMatch(editor.innerHTML, /__ran/)
})

test('只打开看一眼不会触发保存', async () => {
  // 比较基准取的是过滤后的内容，否则每次浏览都会被判定成修改、整库写一次盘。
  const wrapper = await openWith('<p>正文</p><img src="x" onerror="alert(1)">')
  wrapper.vm.close()

  assert.equal(wrapper.emitted('save'), undefined)
})

test('改过内容再关闭会带着过滤后的 HTML 保存', async () => {
  const wrapper = await openWith('<p>原文</p>')
  wrapper.find('.note-editor').element.innerHTML = '<p>改过的</p>'
  wrapper.vm.close()

  const [[id, content]] = wrapper.emitted('save')
  assert.equal(id, 'web_1')
  assert.equal(content, '<p>改过的</p>')
})

// 页脚写着「esc 或 ctrl+s 保存」。<dialog> 原生的 Esc 只关窗口，
// 不拦下来的话按提示操作反而会把刚写的笔记丢掉。
test('按 esc 和 ctrl+s 一样是保存后关闭', async () => {
  const wrapper = await openWith('<p>原文</p>')
  wrapper.find('.note-editor').element.innerHTML = '<p>改过的</p>'
  await wrapper.find('dialog').trigger('keydown', { key: 'Escape' })

  const [[, content]] = wrapper.emitted('save')
  assert.equal(content, '<p>改过的</p>')
  assert.equal(wrapper.find('dialog').element.open, false)
})

test('空笔记会补一个空段落，光标才有地方落', async () => {
  const wrapper = await openWith('')

  assert.equal(wrapper.find('.note-editor').element.innerHTML, '<p></p>')
})

test('清空笔记保存成空串而不是占位的空段落', async () => {
  const wrapper = await openWith('<p>原文</p>')
  wrapper.find('.note-editor').element.innerHTML = '<p><br></p>'
  wrapper.vm.close()

  const [[, content]] = wrapper.emitted('save')
  assert.equal(content, '')
})
