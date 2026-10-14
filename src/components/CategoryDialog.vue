<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { childrenOf as childrenIn, rootCategories } from '../lib/views'
import type { Category, CategoryAction } from '../lib/types'

type TabPosition = NonNullable<Category['tabPosition']>

// 放在脚本里而不是模板的内联字面量里，位置值才能被收窄成 TabPosition，
// 否则传给 setPosition 的是宽泛的 string。
const POSITIONS: { value: TabPosition, label: string }[] = [
  { value: 'left', label: '左' },
  { value: 'right', label: '右' },
  { value: 'top', label: '上' },
  { value: 'bottom', label: '下' },
]
const props = defineProps<{
  categories: Category[]
  /** 统计分类下的卡片数，由父组件从 useFunLink 透传。 */
  categoryCount: (categoryId: string) => number
}>()
const emit = defineEmits<{
  /** 新增分类：名字、父分类 id（一级分类传空串）、插在哪个分类后面。 */
  add: [name: string, parentId: string, afterId?: string]
  action: [id: string, action: CategoryAction]
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const rootName = ref('')
const popoverName = ref('')
const expandedIds = ref<string[]>([])
const draggedId = ref('')
const opened = ref(false)
const popover = reactive({ id: '', type: '', left: 0, top: 0 })
const activeCategory = computed(() => props.categories.find(category => category.id === popover.id))
const childrenOf = (id: string) => childrenIn(props.categories, id)
// 模板原先对每个一级分类都要调四五次 childrenOf，每次都把整份分类过一遍，
// 而且每改一张卡片就会重算一遍。这里一次分好组，模板直接用分好的结果。
const tree = computed(() => {
  const children = new Map<string, Category[]>()
  props.categories.forEach(category => {
    if (!category.parentId) return
    const siblings = children.get(category.parentId)
    if (siblings) siblings.push(category)
    else children.set(category.parentId, [category])
  })
  return rootCategories(props.categories).map(root => ({ root, children: children.get(root.id) || [] }))
})

function open() {
  opened.value = true
  expandedIds.value = rootCategories(props.categories).map(root => root.id)
  closePopover()
  if (!dialog.value?.open) dialog.value?.showModal()
}

function close() {
  closePopover()
  // 整棵分类树和每个分类的卡片数都挂在模板上，而本组件一直挂在 App 下。
  // 关掉之后不卸载内容的话，之后每改一张卡片都要连带重算一遍这些东西。
  opened.value = false
  dialog.value?.close()
}

function closeOnBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) close()
}

function addRoot() {
  const name = rootName.value.trim()
  if (!name) return
  emit('add', name, '')
  rootName.value = ''
}

function toggleExpanded(id: string) {
  expandedIds.value = expandedIds.value.includes(id)
    ? expandedIds.value.filter(item => item !== id)
    : [...expandedIds.value, id]
}

function closePopover() {
  Object.assign(popover, { id: '', type: '', left: 0, top: 0 })
}

function togglePopover(id: string, type: string, event: MouseEvent) {
  const shouldClose = popover.id === id && popover.type === type
  if (shouldClose) return closePopover()
  // 气泡要定位到被点的按钮上，所以 currentTarget 必须收窄成元素才能取尺寸。
  const trigger = event.currentTarget as HTMLElement | null
  const modal = dialog.value?.getBoundingClientRect()
  if (!trigger || !modal) return
  const anchor = trigger.getBoundingClientRect()
  Object.assign(popover, {
    id,
    type,
    left: anchor.left - modal.left + anchor.width / 2,
    top: anchor.bottom - modal.top + 10,
  })
  popoverName.value = ''
}

function addNear(category: Category) {
  const name = popoverName.value.trim()
  if (!name) return
  const isChild = Boolean(category.parentId)
  emit('add', name, isChild ? category.parentId : category.id, isChild ? category.id : '')
  if (!isChild && !expandedIds.value.includes(category.id)) expandedIds.value.push(category.id)
  closePopover()
  popoverName.value = ''
}

function rename(category: Category, event: FocusEvent) {
  // contenteditable 的内容在 currentTarget 上，失焦时读回来当新名字。
  const field = event.currentTarget as HTMLElement | null
  if (!field) return
  const name = field.innerText.trim()
  if (!name) {
    field.innerText = category.name
    return
  }
  if (name !== category.name) emit('action', category.id, { type: 'rename', name })
}

function confirmDelete(category: Category) {
  // 面板里刚点过「确认删除」，不用再弹一次系统确认框。
  emit('action', category.id, { type: 'delete', confirmed: true })
  closePopover()
}

function setPosition(category: Category, position: TabPosition) {
  emit('action', category.id, { type: 'position', position })
}

function startDrag(category: Category, event: DragEvent) {
  draggedId.value = category.id
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function endDrag() {
  draggedId.value = ''
}

function dropBefore(target: Category, event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (!draggedId.value || draggedId.value === target.id) return
  emit('action', draggedId.value, { type: 'move', parentId: target.parentId || '', targetId: target.id })
  draggedId.value = ''
}

function dropInto(root: Category, event: DragEvent) {
  event.preventDefault()
  event.stopPropagation()
  const source = props.categories.find(category => category.id === draggedId.value)
  if (!source || source.id === root.id || childrenOf(source.id).length || props.categoryCount(source.id)) return
  emit('action', source.id, { type: 'move', parentId: root.id, targetId: '' })
  if (!expandedIds.value.includes(root.id)) expandedIds.value.push(root.id)
  draggedId.value = ''
}

defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="modal category-modal" @click="closeOnBackdrop" @cancel.prevent="close">
    <template v-if="opened">
      <header class="category-dialog-header">
        <span class="category-dialog-icon" aria-hidden="true"><i class="iconfont icon-cat" /></span>
        <span class="category-dialog-title">分类管理</span>
        <button
          class="category-help"
          type="button"
          aria-label="分类管理帮助"
          title="注意：一级分类下如果有卡片或子分类，将无法拖入其他二级分类；上下拖动可排序，向右拖动可移入二级分类。"
        ><i class="iconfont icon-help" aria-hidden="true" /></button>
      </header>

      <div class="category-dialog-body">
        <form class="category-root-form" @submit.prevent="addRoot">
          <input v-model="rootName" maxlength="12" aria-label="新增一级分类" placeholder="输入分类名，回车提交！" />
        </form>

        <div class="category-tree-scroll">
          <ul class="category-tree">
            <li v-for="{ root, children } in tree" :key="root.id" class="category-item" :class="{ 'has-children': children.length }">
              <div
                class="category-item-content"
                draggable="true"
                @dragstart="startDrag(root, $event)"
                @dragend="endDrag"
                @dragover.prevent
                @drop="dropBefore(root, $event)"
              >
                <button
                  v-if="children.length"
                  class="category-tree-toggle"
                  type="button"
                  :aria-label="expandedIds.includes(root.id) ? '收起分类' : '展开分类'"
                  @click="toggleExpanded(root.id)"
                ><i class="iconfont icon-totop" :class="{ expanded: expandedIds.includes(root.id) }" aria-hidden="true" /></button>
                <i v-else class="iconfont icon-drag category-drag-icon" aria-hidden="true" />
                <span
                  class="category-name"
                  contenteditable="true"
                  role="textbox"
                  spellcheck="false"
                  :aria-label="`重命名${root.name}`"
                  :textContent="root.name"
                  @keydown.enter.prevent="($event.currentTarget as HTMLElement).blur()"
                  @blur="rename(root, $event)"
                />
                <span v-if="categoryCount(root.id)" class="category-count">{{ categoryCount(root.id) }}</span>

                <div class="category-actions">
                  <span class="category-action-wrap">
                    <button class="category-action success" type="button" aria-label="设置二级 Tabs 位置" @click="togglePopover(root.id, 'position', $event)">
                      <i class="iconfont icon-tab" aria-hidden="true" />
                    </button>
                  </span>
                  <span class="category-action-wrap">
                    <button class="category-action primary" type="button" aria-label="添加子分类" @click="togglePopover(root.id, 'add', $event)">
                      <i class="iconfont icon-add" aria-hidden="true" />
                    </button>
                  </span>
                  <span class="category-action-wrap">
                    <button class="category-action danger" type="button" aria-label="删除分类" @click="togglePopover(root.id, 'delete', $event)">
                      <i class="iconfont icon-delete" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              </div>

              <ul
                v-show="expandedIds.includes(root.id) || !children.length"
                class="category-tree category-children"
                :class="{ empty: !children.length }"
                @dragover.prevent
                @drop="dropInto(root, $event)"
              >
                <li v-for="child in children" :key="child.id" class="category-item">
                  <div
                    class="category-item-content"
                    draggable="true"
                    @dragstart.stop="startDrag(child, $event)"
                    @dragend="endDrag"
                    @dragover.prevent
                    @drop="dropBefore(child, $event)"
                  >
                    <i class="iconfont icon-drag category-drag-icon" aria-hidden="true" />
                    <span
                      class="category-name"
                      contenteditable="true"
                      role="textbox"
                      spellcheck="false"
                      :aria-label="`重命名${child.name}`"
                      :textContent="child.name"
                      @keydown.enter.prevent="($event.currentTarget as HTMLElement).blur()"
                      @blur="rename(child, $event)"
                    />
                    <span v-if="categoryCount(child.id)" class="category-count">{{ categoryCount(child.id) }}</span>

                    <div class="category-actions">
                      <span class="category-action-wrap">
                        <button class="category-action primary" type="button" aria-label="追加分类" @click="togglePopover(child.id, 'add', $event)">
                          <i class="iconfont icon-add" aria-hidden="true" />
                        </button>
                      </span>
                      <span class="category-action-wrap">
                        <button class="category-action danger" type="button" aria-label="删除分类" @click="togglePopover(child.id, 'delete', $event)">
                          <i class="iconfont icon-delete" aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  </div>
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </div>

      <template v-if="activeCategory">
        <div
          v-if="popover.type === 'position'"
          class="category-popover position-popover"
          :style="{ left: `${popover.left}px`, top: `${popover.top}px` }"
          @click.stop
        >
          <span>二级Tabs位置：</span>
          <div class="position-options">
            <label v-for="option in POSITIONS" :key="option.value">
              <input type="radio" :checked="activeCategory.tabPosition === option.value" @change="setPosition(activeCategory, option.value)" />{{ option.label }}
            </label>
          </div>
        </div>
        <form
          v-if="popover.type === 'add'"
          class="category-popover add-popover"
          :style="{ left: `${popover.left}px`, top: `${popover.top}px` }"
          @submit.prevent="addNear(activeCategory)"
          @click.stop
        >
          <span>{{ activeCategory.parentId ? '追加分类' : '添加子分类' }}</span>
          <input v-model="popoverName" maxlength="12" aria-label="分类名称" placeholder="输入分类名，回车提交！" />
        </form>
        <div
          v-if="popover.type === 'delete'"
          class="category-popover delete-popover"
          :style="{ left: `${popover.left}px`, top: `${popover.top}px` }"
          @click.stop
        >
          <p>{{ activeCategory.parentId ? '删除分类后，分类中的卡片会移到废纸篓。' : '删除分类后，其子分类将一并删除，分类中的卡片会移到废纸篓。' }}</p>
          <div><button type="button" @click="closePopover">算了</button><button class="confirm-delete" type="button" @click="confirmDelete(activeCategory)">删吧</button></div>
        </div>
      </template>
    </template>
  </dialog>
</template>
