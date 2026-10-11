<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// Electron 不实现 window.prompt，站内搜索（网址里的 {q}）用这个对话框取关键词。
const props = withDefaults(defineProps<{
  visible?: boolean
  title?: string
}>(), { visible: false, title: '' })
const emit = defineEmits(['submit', 'cancel'])
const dialog = ref<HTMLDialogElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
const value = ref('')

watch(() => props.visible, async visible => {
  if (!visible) {
    dialog.value?.close()
    return
  }
  value.value = ''
  if (!dialog.value?.open) dialog.value?.showModal()
  await nextTick()
  field.value?.focus()
})
</script>

<template>
  <dialog ref="dialog" class="keyword-dialog" @cancel.prevent="emit('cancel')">
    <form @submit.prevent="emit('submit', value)">
      <h2>{{ title }}</h2>
      <input ref="field" v-model="value" aria-label="搜索关键词" placeholder="请输入搜索关键词" />
      <footer>
        <button class="button" type="button" @click="emit('cancel')">取消</button>
        <button class="button primary" type="submit">搜索</button>
      </footer>
    </form>
  </dialog>
</template>
