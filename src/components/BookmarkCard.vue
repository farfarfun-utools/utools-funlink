<script setup lang="ts">
import { displayHost, initials, safeColor } from '../lib/core'
import { useBookmarkIcon } from '../composables/useBookmarkIcon'
import type { Bookmark } from '../lib/types'

const props = withDefaults(defineProps<{ bookmark: Bookmark, trashView?: boolean }>(), { trashView: false })
const emit = defineEmits(['open', 'note', 'context-menu', 'drag-start', 'drop'])
// 只渲染存在本地的图（用户上传或添加时抓来的，存在数据库附件里，老数据还内联在卡片上），
// 渲染时不发任何请求，更不经过第三方 favicon 服务。
// icon.pending 是「有图但附件还没读出来」：这期间留个空圆圈，不显示首字母——
// 否则每次打开插件都能看到图标从首字母跳成图片。
const icon = useBookmarkIcon(() => props.bookmark)
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
      :class="{ image: Boolean(icon.url) || icon.pending }"
      role="button"
      tabindex="0"
      :aria-label="`打开 ${bookmark.title} 的笔记`"
      :style="{ '--bookmark-color': safeColor(bookmark.color), '--icon-size': `${bookmark.iconSize || 16}px` }"
      @click.stop="emit('note', bookmark)"
      @keydown.enter.stop="emit('note', bookmark)"
      @keydown.space.prevent.stop="emit('note', bookmark)"
    >
      <img v-if="icon.url" :src="icon.url" alt="" />
      <span v-else-if="!icon.pending" :class="{ 'emoji-text': bookmark.icon === '👌' }">{{ bookmark.icon || initials(bookmark.title) }}</span>
    </span>
    <!-- 整张卡片点哪儿都能打开，但 <article> 不可聚焦，键盘用户只能打开笔记（图标那颗）。
         标题这块本来就是「这张卡片是什么」的区域，让它兼任打开网址的可聚焦控件；
         不加 .stop，鼠标点击照样冒泡到 article 走同一条打开链路。 -->
    <div
      class="bookmark-copy"
      role="button"
      tabindex="0"
      :aria-label="`打开 ${bookmark.title}`"
      @keydown.enter="emit('open', bookmark)"
      @keydown.space.prevent="emit('open', bookmark)"
    >
      <h2 :title="bookmark.title">{{ bookmark.title }}</h2>
      <p :title="bookmark.description || displayHost(bookmark.url)">
        <i v-if="bookmark.hasNote || bookmark.note" class="iconfont icon-remarks note-mark" aria-hidden="true" />
        <span>{{ bookmark.description || displayHost(bookmark.url) }}</span>
      </p>
    </div>
  </article>
</template>
