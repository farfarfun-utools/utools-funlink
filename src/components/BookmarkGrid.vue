<script setup lang="ts">
import BookmarkCard from './BookmarkCard.vue'
import type { Bookmark } from '../lib/types'

defineProps<{
  bookmarks: Bookmark[]
  trashView?: boolean
  showAdd?: boolean
}>()
const emit = defineEmits(['add', 'open', 'note', 'context-menu', 'drag-start', 'drop'])
</script>

<template>
  <section class="card-list" aria-live="polite">
    <div class="bookmark-grid">
      <BookmarkCard
        v-for="bookmark in bookmarks"
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
