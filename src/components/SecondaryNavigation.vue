<script setup lang="ts">
import type { Category } from '../lib/types'

withDefaults(defineProps<{
  categories: Category[]
  activeCategoryId: string
  position?: Category['tabPosition']
}>(), { position: 'top' })
const emit = defineEmits(['select'])
</script>

<template>
  <aside v-if="categories.length" class="secondary-nav" :class="`is-${position}`" aria-label="二级分类">
    <button
      v-for="category in categories"
      :key="category.id"
      type="button"
      :class="{ active: activeCategoryId === category.id }"
      @click="emit('select', `category:${category.id}`)"
    >
      {{ category.name }}
    </button>
  </aside>
</template>
