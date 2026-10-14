<script setup lang="ts">
import { computed } from 'vue'
import { initials } from '../lib/core'
import { displayHost, safeColor } from '../lib/core'
import type { Bookmark } from '../lib/types'

const props = withDefaults(defineProps<{ bookmark: Bookmark, trashView?: boolean }>(), { trashView: false })
const emit = defineEmits(['open', 'note', 'context-menu', 'drag-start', 'drop'])
// 只渲染存在本地的图（用户上传或添加时抓来的，都存成 data URL），
// 渲染时不发任何请求，更不经过第三方 favicon 服务。
const iconImage = computed(() => (props.bookmark.iconType === 'image' ? props.bookmark.iconData : '') || '')
</script>

<template>
  <article
    class="bookmark-card"
    :draggable="!trashView"
    @click="emit('open', bookmark)"
    @contextmenu.prevent="emit('context-menu', bookmark, $event)"
    @dragstart="emit('drag-start', bookmark.id, $event)"
    @dragover.prevent
    @drop.prevent="emit('drop', bookmark.id)"
  >
    <span
      class="bookmark-icon"
      :class="{ image: Boolean(iconImage) }"
      role="button"
      tabindex="0"
      :aria-label="`打开 ${bookmark.title} 的笔记`"
      :style="{ '--bookmark-color': safeColor(bookmark.color), '--icon-size': `${bookmark.iconSize || 16}px` }"
      @click.stop="emit('note', bookmark)"
      @keydown.enter.stop="emit('note', bookmark)"
      @keydown.space.prevent.stop="emit('note', bookmark)"
    >
      <img v-if="iconImage" :src="iconImage" alt="" />
      <span v-else :class="{ 'emoji-text': bookmark.icon === '👌' }">{{ bookmark.icon || initials(bookmark.title) }}</span>
    </span>
    <div class="bookmark-copy">
      <h2 :title="bookmark.title">{{ bookmark.title }}</h2>
      <p :title="bookmark.description || displayHost(bookmark.url)">
        <i v-if="bookmark.hasNote || bookmark.note" class="iconfont icon-remarks note-mark" aria-hidden="true" />
        <span>{{ bookmark.description || displayHost(bookmark.url) }}</span>
      </p>
    </div>
  </article>
</template>
