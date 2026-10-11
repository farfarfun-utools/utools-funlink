<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { initials } from '../lib/core'
import { sanitizeNoteHtml } from '../lib/sanitize'
import { safeColor } from '../lib/core'
import type { Bookmark } from '../lib/types'

const emit = defineEmits(['save'])
const dialog = ref<HTMLDialogElement | null>(null)
const editor = ref<HTMLElement | null>(null)
const bookmark = ref<Bookmark | null>(null)
const original = ref('')

function open(value: Bookmark) {
  bookmark.value = value
  if (!dialog.value?.open) dialog.value?.showModal()
  nextTick(() => {
    if (!editor.value) return
    // 笔记可能来自别人的备份文件，所以不走 innerHTML：按白名单重建一棵树再插入，
    // <img src=x onerror=...> 这类内联事件处理器在重建时就被丢掉了。
    editor.value.replaceChildren(sanitizeNoteHtml(bookmark.value?.note))
    // 空笔记补一个空段落，光标才有地方落。
    if (!editor.value.childNodes.length) editor.value.appendChild(document.createElement('p'))
    // 比较基准取过滤后的内容：只是打开看一眼不该被判定成修改，
    // 否则每次浏览笔记都会触发一次整库写盘。
    original.value = editor.value.innerHTML
    editor.value.focus()
  })
}

function close() {
  const content = editor.value?.innerHTML || ''
  if (bookmark.value && content !== original.value) emit('save', bookmark.value.id, content === '<p><br></p>' ? '' : content)
  dialog.value?.close()
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    close()
  }
  if (event.key === 'Escape') event.preventDefault()
}

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="note-dialog" aria-label="card-note-modal" @cancel.prevent @keydown="handleKeydown">
    <template v-if="bookmark">
      <header class="note-dialog-header">
        <button type="button" class="note-card-title">
          <span class="note-avatar" :style="{ backgroundColor: safeColor(bookmark.color), fontSize: `${(bookmark.iconSize || 16) * 0.6}px` }">
            <img v-if="bookmark.iconType === 'image' && bookmark.iconData" :src="bookmark.iconData" alt="" />
            <template v-else>{{ bookmark.icon || initials(bookmark.title) }}</template>
          </span>
          <span>{{ bookmark.title }}</span>
        </button>
        <span class="note-description">{{ bookmark.description }}</span>
        <button type="button" class="note-close" aria-label="关闭" @click="close">×</button>
      </header>
      <div ref="editor" class="note-editor prose" contenteditable="true" role="textbox" aria-label="笔记内容" aria-multiline="true" spellcheck="true" />
      <footer class="note-footer">
        <div class="note-footer-spacer" />
        <div class="note-footer-content">
          <button type="button" title="暂未开放"><i class="iconfont icon-help" aria-hidden="true" /> 帮助</button>
          <span class="note-shortcuts"><i /><kbd>/</kbd> 菜单命令 <i /><kbd>esc</kbd> 或 <kbd>ctrl</kbd> + <kbd>s</kbd> 保存</span>
        </div>
      </footer>
    </template>
  </dialog>
</template>
