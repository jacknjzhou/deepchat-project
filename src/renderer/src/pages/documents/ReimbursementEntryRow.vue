<template>
  <div
    class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm"
    :data-testid="`reimbursement-entry-${entry.id}`"
  >
    <span class="w-40 shrink-0 truncate">{{ entry.templateName }}</span>
    <span class="min-w-0 flex-1 truncate text-muted-foreground">
      {{ entry.fileNames.join('、') }}
    </span>
    <select
      v-if="showGroupSelect"
      class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
      :value="entry.groupId ?? '__none__'"
      :disabled="groups.length === 0"
      :title="groups.length === 0 ? t('settings.documents.reimbursement.noGroupsHint') : undefined"
      :data-testid="`reimbursement-group-${entry.id}`"
      @change="emit('moveGroup', entry.id, ($event.target as HTMLSelectElement).value)"
    >
      <option value="__none__">{{ t('settings.documents.reimbursement.groupNone') }}</option>
      <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
    </select>
    <span
      v-if="entry.amount !== null"
      class="shrink-0 tabular-nums"
      :class="{ 'text-amber-600': entry.amountUncertain }"
    >
      ¥{{ entry.amount }}
    </span>
    <select
      class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
      :value="entry.isOverride ? (categoryId ?? '__unassigned__') : '__auto__'"
      @change="emit('move', entry.id, ($event.target as HTMLSelectElement).value)"
    >
      <option value="__auto__">{{ t('settings.documents.reimbursement.autoCategory') }}</option>
      <option value="__unassigned__">
        {{ t('settings.documents.reimbursement.forceUnassigned') }}
      </option>
      <option v-for="node in categories" :key="node.category.id" :value="node.category.id">
        {{ node.category.name }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ReimbursementTreeResult } from '@shared/contracts/routes'

type Entry =
  ReimbursementTreeResult['tree'][number]['groups'][number]['buckets'][number]['documents'][number]
type CategoryNode = ReimbursementTreeResult['tree'][number]

withDefaults(
  defineProps<{
    entry: Entry
    groups: CategoryNode['category']['customGroups']
    categories: CategoryNode[]
    categoryId?: string | null
    showGroupSelect: boolean
  }>(),
  { categoryId: null }
)

const emit = defineEmits<{
  move: [documentId: string, value: string]
  moveGroup: [documentId: string, value: string]
}>()

const { t } = useI18n()
</script>
