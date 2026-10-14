<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import BookmarkCard from './BookmarkCard.vue'
import type { Bookmark } from '../lib/types'

const props = defineProps<{
  bookmarks: Bookmark[]
  trashView?: boolean
  showAdd?: boolean
  /** 这批卡片属于哪个视图（视图 + 搜索词）。换了就退回第一批重新铺。 */
  viewKey?: string
}>()
const emit = defineEmits(['add', 'open', 'note', 'context-menu', 'drag-start', 'drop'])

// 「全部」视图和搜索结果给的都是整库。两千张卡片一次性挂完实测要 130ms 以上，
// 这一整帧里点击和滚动都没有响应。改成先挂够铺满首屏的一批，剩下的按帧补上：
// 每帧一批约十毫秒，补的过程中界面照常响应。
//
// 这不是虚拟滚动：补完之后所有卡片都留在 DOM 里，滚动、拖拽排序、页内查找、
// 读屏都和原来一样，离屏卡片的排版绘制开销由 cards.css 里的 content-visibility 兜住。
const CHUNK = 120
const limit = ref(CHUNK)
const shownBookmarks = computed(() => (props.bookmarks.length > limit.value ? props.bookmarks.slice(0, limit.value) : props.bookmarks))

let frame = 0
function growNextFrame() {
  if (frame || limit.value >= props.bookmarks.length) return
  frame = requestAnimationFrame(() => {
    frame = 0
    limit.value += CHUNK
    growNextFrame()
  })
}

// 只在换视图、换搜索词时退回第一批。跟着列表长度变化重置会踩一个坑：删掉一张卡片
// 时，已经铺开的卡片缩回首批，页面高度跟着塌，用户的滚动位置会被拽回顶部。
watch(() => props.viewKey, () => {
  limit.value = CHUNK
  growNextFrame()
})
// 列表变长（新增卡片、首屏数据异步到位）时也要接着往下铺。
watch(() => props.bookmarks.length, growNextFrame, { immediate: true })
onUnmounted(() => { if (frame) cancelAnimationFrame(frame) })
</script>

<template>
  <section class="card-list" aria-live="polite">
    <div class="bookmark-grid">
      <BookmarkCard
        v-for="bookmark in shownBookmarks"
        :key="bookmark.id"
        :bookmark="bookmark"
        :trash-view="trashView"
        @open="emit('open', $event)"
        @note="emit('note', $event)"
        @context-menu="(bookmark, event) => emit('context-menu', bookmark, event)"
        @drag-start="(id, event) => emit('drag-start', id, event)"
        @drop="emit('drop', $event)"
      />
      <button v-if="showAdd" class="add-item" type="button" aria-label="添加网址" @click="emit('add')">
        <i class="iconfont icon-add" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>
