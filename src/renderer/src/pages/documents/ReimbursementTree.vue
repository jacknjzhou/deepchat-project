<template>
  <div class="min-h-0" data-testid="reimbursement-tree">
    <RecycleScroller
      v-if="visibleRows.length"
      class="h-full"
      :items="visibleRows"
      :item-size="null"
      :min-item-size="40"
      key-field="key"
      v-slot="{ item }"
    >
      <div :style="{ paddingLeft: `${item.depth * 16}px` }">
        <div
          v-if="item.kind === 'category'"
          class="flex items-center gap-2 border-b px-2 py-1.5 text-sm font-medium hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-4 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <button
            v-if="item.materials && item.materials.length"
            type="button"
            class="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            :data-testid="`reimbursement-materials-${item.categoryId}`"
            @click="toggleMaterials(item.key)"
          >
            {{ t('settings.documents.reimbursement.materialsTitle') }}
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div v-else-if="item.kind === 'materials'" class="border-b px-2 py-2 text-sm">
          <ul class="space-y-1">
            <li
              v-for="material in item.materials ?? []"
              :key="material.name"
              class="flex items-center justify-between"
            >
              <span>{{ material.name }}</span>
              <DcBadge v-if="material.linkedTypeKeys.length" variant="outline">
                {{ t('settings.documents.reimbursement.materialCount', { count: material.count }) }}
              </DcBadge>
            </li>
          </ul>
        </div>

        <div
          v-else-if="item.kind === 'person'"
          class="flex items-center gap-2 border-b px-2 py-1 text-sm font-medium hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-3.5 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div
          v-else-if="item.kind === 'period'"
          class="flex items-center gap-2 border-b px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-3 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div
          v-else
          class="flex items-center gap-2 border-b px-2 py-1 text-sm"
          :data-testid="`reimbursement-entry-${item.entry?.id}`"
        >
          <span class="w-36 shrink-0 truncate">{{ item.entry?.templateName }}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">
            {{ item.entry?.fileNames.join('、') }}
          </span>
          <span
            v-if="item.entry?.amount !== null && item.entry?.amount !== undefined"
            class="shrink-0 tabular-nums"
            :class="{ 'text-amber-600': item.entry?.amountUncertain }"
          >
            ¥{{ item.entry?.amount }}
          </span>
          <select
            class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
            :value="selectValueFor(item)"
            @change="onRowMove(item, ($event.target as HTMLSelectElement).value)"
          >
            <option value="__auto__">
              {{ t('settings.documents.reimbursement.autoCategory') }}
            </option>
            <option value="__unassigned__">
              {{ t('settings.documents.reimbursement.forceUnassigned') }}
            </option>
            <option v-for="node in tree" :key="node.category.id" :value="node.category.id">
              {{ node.category.name }}
            </option>
          </select>
        </div>
      </div>
    </RecycleScroller>
    <p v-else class="py-10 text-center text-sm text-muted-foreground">
      {{ t('settings.documents.reimbursement.empty') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcBadge } from '@dc-ui/components/badge'
import { RecycleScroller } from 'vue-virtual-scroller'
import type { z } from 'zod'
import type {
  reimbursementCategoryNodeSchema,
  reimbursementDocumentEntrySchema,
  reimbursementGroupSchema
} from '@shared/contracts/routes'

type TreeCategoryNode = z.infer<typeof reimbursementCategoryNodeSchema>
type TreeGroup = z.infer<typeof reimbursementGroupSchema>
type TreeEntry = z.infer<typeof reimbursementDocumentEntrySchema>

interface TreeRow {
  key: string
  kind: 'category' | 'person' | 'period' | 'entry' | 'materials'
  depth: number
  label: string
  count: number | null
  materials: TreeCategoryNode['materials'] | null
  categoryId: string | null
  entry: TreeEntry | null
}

const props = withDefaults(
  defineProps<{
    tree: TreeCategoryNode[]
    unassigned: TreeGroup[]
    showUnassignedOnly?: boolean
  }>(),
  { showUnassignedOnly: false }
)

const emit = defineEmits<{ move: [documentId: string, value: string] }>()

const { t } = useI18n()

// Expansion resets to fully expanded whenever the tree data is replaced
// (load, task-completion refresh); folding is session-local by design.
const expanded = ref(new Set<string>())
const materialsOpen = ref(new Set<string>())

watch(
  () => [props.tree, props.unassigned],
  () => {
    const keys = new Set<string>()
    for (const node of props.tree) {
      const catKey = `cat:${node.category.id}`
      keys.add(catKey)
      for (const group of node.groups) {
        const personKey = `${catKey}:p:${group.person ?? 'unknown'}`
        keys.add(personKey)
        for (const bucket of group.buckets) {
          keys.add(`${personKey}:b:${bucket.period ?? 'unknown'}`)
        }
      }
    }
    keys.add('unassigned')
    for (const group of props.unassigned) {
      const personKey = `un:p:${group.person ?? 'unknown'}`
      keys.add(personKey)
      for (const bucket of group.buckets) {
        keys.add(`${personKey}:b:${bucket.period ?? 'unknown'}`)
      }
    }
    expanded.value = keys
    materialsOpen.value = new Set<string>()
  },
  { immediate: true }
)

function isExpanded(key: string) {
  return expanded.value.has(key)
}

function isMaterialsOpen(key: string) {
  return materialsOpen.value.has(key)
}

function toggleExpand(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expanded.value = next
}

function toggleMaterials(key: string) {
  const next = new Set(materialsOpen.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  materialsOpen.value = next
}

function pushGroupRows(
  rows: TreeRow[],
  prefix: string,
  depth: number,
  groups: TreeGroup[],
  categoryId: string | null
) {
  for (const group of groups) {
    const personKey = `${prefix}:p:${group.person ?? 'unknown'}`
    const personCount = group.buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0)
    rows.push({
      key: personKey,
      kind: 'person',
      depth,
      label: group.person ?? t('settings.documents.reimbursement.unknownPerson'),
      count: personCount,
      materials: null,
      categoryId,
      entry: null
    })
    if (!isExpanded(personKey)) {
      continue
    }
    for (const bucket of group.buckets) {
      const periodKey = `${personKey}:b:${bucket.period ?? 'unknown'}`
      rows.push({
        key: periodKey,
        kind: 'period',
        depth: depth + 1,
        label: bucket.period ?? t('settings.documents.reimbursement.unknownPeriod'),
        count: bucket.documents.length,
        materials: null,
        categoryId,
        entry: null
      })
      if (!isExpanded(periodKey)) {
        continue
      }
      for (const entry of bucket.documents) {
        rows.push({
          key: `${periodKey}:d:${entry.id}`,
          kind: 'entry',
          depth: depth + 2,
          label: '',
          count: null,
          materials: null,
          categoryId,
          entry
        })
      }
    }
  }
}

const visibleRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  if (!props.showUnassignedOnly) {
    for (const node of props.tree) {
      const catKey = `cat:${node.category.id}`
      rows.push({
        key: catKey,
        kind: 'category',
        depth: 0,
        label: node.category.name,
        count: node.total,
        materials: node.materials,
        categoryId: node.category.id,
        entry: null
      })
      if (!isExpanded(catKey)) {
        continue
      }
      if (isMaterialsOpen(catKey) && node.materials.length) {
        rows.push({
          key: `mat:${node.category.id}`,
          kind: 'materials',
          depth: 1,
          label: '',
          count: null,
          materials: node.materials,
          categoryId: node.category.id,
          entry: null
        })
      }
      pushGroupRows(rows, catKey, 1, node.groups, node.category.id)
    }
  }
  const unassignedCount = props.unassigned.reduce(
    (sum, group) =>
      sum + group.buckets.reduce((total, bucket) => total + bucket.documents.length, 0),
    0
  )
  rows.push({
    key: 'unassigned',
    kind: 'category',
    depth: 0,
    label: t('settings.documents.reimbursement.unassigned'),
    count: unassignedCount,
    materials: null,
    categoryId: null,
    entry: null
  })
  if (isExpanded('unassigned')) {
    pushGroupRows(rows, 'un', 1, props.unassigned, null)
  }
  return rows
})

function selectValueFor(row: TreeRow): string {
  if (!row.entry) {
    return '__auto__'
  }
  return row.entry.isOverride ? (row.categoryId ?? '__unassigned__') : '__auto__'
}

function onRowMove(row: TreeRow, value: string) {
  if (row.entry) {
    emit('move', row.entry.id, value)
  }
}
</script>
