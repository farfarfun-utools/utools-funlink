<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { MenuItem } from '../lib/types'

const props = defineProps<{ items: MenuItem[]; x: number; y: number }>()
const emit = defineEmits(['select'])
const menu = ref<HTMLElement | null>(null)
const position = ref({ left: `${props.x}px`, top: `${props.y}px` })

watch(() => [props.x, props.y, props.items], async () => {
  await nextTick()
  const width = menu.value?.offsetWidth || 184
  const height = menu.value?.offsetHeight || 100
  position.value = {
    left: `${Math.max(8, Math.min(props.x, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(props.y, window.innerHeight - height - 8))}px`,
  }
}, { immediate: true })
</script>

<template>
  <div ref="menu" class="context-menu" role="menu" :style="position" @click.stop>
    <template v-for="item in items" :key="item.action">
      <button type="button" role="menuitem" @click="emit('select', item.action)">
        <i v-if="item.icon" class="iconfont menu-icon" :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
        <span v-if="item.arrow" class="menu-arrow" aria-hidden="true">›</span>
      </button>
      <span v-if="item.divided" class="menu-divider" />
    </template>
  </div>
</template>
