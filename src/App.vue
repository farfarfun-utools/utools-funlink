<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import AppHeader from './components/AppHeader.vue'
import BookmarkDialog from './components/BookmarkDialog.vue'
import BookmarkGrid from './components/BookmarkGrid.vue'
import CategoryDialog from './components/CategoryDialog.vue'
import ContextMenu from './components/ContextMenu.vue'
import KeywordDialog from './components/KeywordDialog.vue'
import NoteDialog from './components/NoteDialog.vue'
import SecondaryNavigation from './components/SecondaryNavigation.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { useFunLink } from './composables/useFunLink'
import type { Bookmark, Category } from './lib/types'

const funlink = useFunLink()
const {
  state, search, toast, storageError, keywordPrompt, roots, activeCategoryId, activeRootId,
  secondaryCategories, secondaryPosition, trashCount, currentBookmarks, defaultCategoryId,
} = funlink
// 换视图、换搜索词就是整批卡片换人，网格据此从第一批重新铺（见 BookmarkGrid）。
// 删一张卡片之类的改动不会动到它，已经铺开的卡片也就不会缩回去。
const gridViewKey = computed(() => `${state.value.currentView}|${search.value}`)
// 子组件用 defineExpose 暴露 open/close，模板 ref 标上实例类型后这些方法才能被检查，
// 写成 ref(null) 的话类型是 null，调用点全是 any。
const bookmarkDialog = ref<InstanceType<typeof BookmarkDialog> | null>(null)
const categoryDialog = ref<InstanceType<typeof CategoryDialog> | null>(null)
const noteDialog = ref<InstanceType<typeof NoteDialog> | null>(null)
const settingsDialog = ref<InstanceType<typeof SettingsDialog> | null>(null)
const draggedBookmarkId = ref<string | null>(null)
// bookmark 必须显式标成 Bookmark | null：写成 reactive({ bookmark: null }) 的话
// 类型会被推成 null，contextItems 里对它的字段访问就全都逃过了类型检查。
const context = reactive<{ visible: boolean, type: string, bookmark: Bookmark | null, x: number, y: number }>({ visible: false, type: '', bookmark: null, x: 0, y: 0 })
// help 是这四个视图各自的一句说明。它们不像普通分类那样是用户自己建的，
// 卡片凭什么出现在这里全靠这句话解释。
const specialView = computed(() => ({
  inbox: { label: '收集箱', icon: 'icon-inbox', help: '没有指定分类的卡片都先落在这里' },
  favorites: { label: '常用', icon: 'icon-card', help: '右键卡片「加入常用」的都会出现在这里' },
  quick: { label: '网页快开', icon: 'icon-fly', help: '在 uTools 主搜索框直接输入卡片名称就能打开' },
  trash: { label: '废纸篓', icon: 'icon-dust', help: '移除的卡片暂存在这里，右键左下角图标可清空' },
}[state.value.currentView] || null))

const contextItems = computed(() => {
  if (context.type === 'category') return [{ action: 'manage', label: '管理分类', icon: 'icon-add-circle' }]
  const bookmark = context.bookmark
  if (!bookmark) return []
  return bookmark.deletedAt
    ? [{ action: 'restore', label: '恢复', icon: 'icon-back' }, { action: 'delete', label: '删除', icon: 'icon-delete' }]
    : [
        { action: 'append', label: '追加', icon: 'icon-add-circle' },
        { action: 'edit', label: '编辑', icon: 'icon-edit', divided: true },
        { action: 'favorite', label: bookmark.favorite ? '取消常用' : '加入常用', icon: 'icon-card' },
        { action: 'quick', label: bookmark.quick ? '取消快开' : '网页快开', icon: bookmark.quick ? 'icon-quick-fill' : 'icon-quick', divided: true },
        { action: 'copy', label: '复制链接', icon: 'icon-remarks' },
        { action: 'trash', label: '移除', icon: 'icon-delete' },
      ]
})

function openContextMenu(bookmark: Bookmark, event: MouseEvent) {
  // DOM 类型里 currentTarget 是 EventTarget，拿不到尺寸，按实际情况收窄成元素。
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  Object.assign(context, {
    visible: true,
    type: 'bookmark',
    bookmark,
    x: event.type === 'contextmenu' ? event.clientX : (rect?.right ?? 0) - 134,
    y: event.type === 'contextmenu' ? event.clientY : (rect?.bottom ?? 0) + 4,
  })
}

function openCategoryContextMenu(event: MouseEvent) {
  Object.assign(context, { visible: true, type: 'category', bookmark: null, x: event.clientX, y: event.clientY })
}

function closeContextMenu() {
  context.visible = false
  context.type = ''
  context.bookmark = null
}

function handleContextAction(action: string) {
  const bookmark = context.bookmark
  closeContextMenu()
  if (action === 'manage') return categoryDialog.value?.open()
  if (!bookmark) return
  if (action === 'append') bookmarkDialog.value?.open(null, bookmark.id)
  if (action === 'edit') bookmarkDialog.value?.open(bookmark)
  if (action === 'favorite') funlink.toggleFavorite(bookmark)
  if (action === 'quick') funlink.toggleQuick(bookmark)
  if (action === 'copy') {
    if (window.utools?.copyText) window.utools.copyText(bookmark.url)
    else navigator.clipboard?.writeText(bookmark.url)
  }
  if (action === 'trash') funlink.moveToTrash(bookmark)
  if (action === 'restore') funlink.restoreBookmark(bookmark)
  if (action === 'delete') funlink.deleteBookmark(bookmark)
}

function handleDragStart(id: string, event: DragEvent) {
  draggedBookmarkId.value = id
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function handleDrop(targetId: string) {
  if (!draggedBookmarkId.value || draggedBookmarkId.value === targetId) return
  funlink.reorderBookmarks(draggedBookmarkId.value, targetId)
  draggedBookmarkId.value = null
}

function handleDataFile(type: 'restore' | 'import', content: string, options: { mode?: string, tabPosition?: Category['tabPosition'] }) {
  if (funlink.processDataFile(type, content, options)) settingsDialog.value?.close()
}

async function handleReset() {
  if (await funlink.resetData()) settingsDialog.value?.close()
}

function handleKeydown(event: KeyboardEvent) { if (event.key === 'Escape') closeContextMenu() }

onMounted(() => {
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('keydown', handleKeydown)
  funlink.setupUtools({ addBookmark: bookmark => bookmarkDialog.value?.open(bookmark) })
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :roots="roots"
      :current-view="state.currentView"
      :active-root-id="activeRootId"
      :theme="state.theme"
      :rounded="state.settings.navbar.rounded"
      @select="funlink.setView"
      @manage="openCategoryContextMenu"
      @cycle-theme="funlink.cycleTheme"
      @settings="settingsDialog?.open()"
    />

    <div v-if="storageError" class="storage-alert" role="alert">
      <span>{{ storageError }}为避免覆盖原有数据，已暂停写入。可从备份恢复，或选择重置为示例数据。</span>
      <button type="button" @click="settingsDialog?.open()">从备份恢复</button>
      <button type="button" @click="handleReset">重置数据</button>
    </div>

    <main class="main">
      <div class="main-view">
        <div v-if="specialView" class="special-view-header">
          <span class="special-view-title" :class="{ danger: state.currentView === 'trash' }"><i class="iconfont" :class="specialView.icon" aria-hidden="true" />{{ specialView.label }}</span>
          <!-- 原来这里是个点了没反应的「帮助」按钮，换成直接把说明写出来。 -->
          <p class="special-view-help"><i class="iconfont icon-help" aria-hidden="true" />{{ specialView.help }}</p>
        </div>
        <div class="detail-content" :class="secondaryCategories.length ? `tabs-${secondaryPosition}` : ''">
          <SecondaryNavigation
            :categories="secondaryCategories"
            :active-category-id="activeCategoryId"
            :position="secondaryPosition"
            @select="funlink.setView"
          />
          <BookmarkGrid
            :bookmarks="currentBookmarks"
            :view-key="gridViewKey"
            :trash-view="state.currentView === 'trash'"
            :show-add="!['trash', 'quick', 'favorites'].includes(state.currentView)"
            @add="bookmarkDialog?.open()"
            @open="funlink.openLink"
            @note="noteDialog?.open($event)"
            @context-menu="openContextMenu"
            @drag-start="handleDragStart"
            @drop="handleDrop"
          />
        </div>
      </div>
    </main>

    <button class="trash-button" type="button" aria-label="打开废纸篓" title="废纸篓" @click="funlink.setView('trash')" @contextmenu.prevent="funlink.emptyTrash">
      <span class="trash-badge">
        <i class="iconfont icon-dust" aria-hidden="true" />
        <sup v-if="trashCount">{{ trashCount }}</sup>
      </span>
    </button>

    <ContextMenu v-if="context.visible" :items="contextItems" :x="context.x" :y="context.y" @select="handleContextAction" />
    <div v-if="toast.visible" class="toast" :class="{ error: toast.error }" role="status" aria-live="polite">{{ toast.message }}</div>

    <BookmarkDialog
      ref="bookmarkDialog"
      :categories="state.categories"
      :default-category-id="defaultCategoryId"
      :bookmark-count="state.bookmarks.length"
      :auto-icon="state.settings.autoIcon"
      @save="funlink.saveBookmark"
    />
    <CategoryDialog ref="categoryDialog" :categories="state.categories" :category-count="funlink.categoryCount" @add="funlink.addCategory" @action="funlink.categoryAction" />
    <NoteDialog ref="noteDialog" @save="funlink.saveNote" />
    <KeywordDialog
      :visible="keywordPrompt.visible"
      :title="keywordPrompt.title"
      @submit="funlink.resolveKeyword"
      @cancel="funlink.resolveKeyword('')"
    />
    <SettingsDialog
      ref="settingsDialog"
      :settings="state.settings"
      :bookmarks="state.bookmarks"
      :backup-data="state"
      :backfill="funlink.iconBackfill"
      @save-settings="funlink.saveSettings"
      @clear-cookies="funlink.clearCookies"
      @message="funlink.showToast"
      @export="funlink.exportBackup"
      @data-file="handleDataFile"
      @reset="handleReset"
    />
  </div>
</template>
