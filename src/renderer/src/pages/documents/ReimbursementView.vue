<template>
  <div class="flex h-full min-h-0" data-testid="reimbursement-view">
    <aside class="w-56 shrink-0 overflow-y-auto border-r p-3">
      <button
        v-for="node in store.reimbursementTree?.tree ?? []"
        :key="node.category.id"
        class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === node.category.id }"
        :data-testid="`reimbursement-category-${node.category.id}`"
        @click="selectedCategoryId = node.category.id"
      >
        <span class="truncate">{{ node.category.name }}</span>
        <DcBadge variant="outline" class="ml-2">{{ node.total }}</DcBadge>
      </button>
      <button
        class="mt-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === null }"
        data-testid="reimbursement-category-unassigned"
        @click="selectedCategoryId = null"
      >
        <span>{{ t('settings.documents.reimbursement.unassigned') }}</span>
        <DcBadge variant="outline" class="ml-2">{{ unassignedTotal }}</DcBadge>
      </button>
      <div class="mt-3 border-t pt-3">
        <button
          class="w-full rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          @click="goConfig"
        >
          {{ t('settings.documents.reimbursement.manageCategories') }}
        </button>
      </div>
    </aside>
    <section class="min-w-0 flex-1 overflow-y-auto p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-medium">{{ selectedName }}</h2>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-export"
          :disabled="exporting"
          @click="onExport"
        >
          {{ t('settings.documents.reimbursement.export') }}
        </DcButton>
      </div>

      <details v-if="selectedMaterials.length" class="mb-3 rounded border p-2 text-sm">
        <summary class="cursor-pointer">
          {{ t('settings.documents.reimbursement.materialsTitle') }}
        </summary>
        <ul class="mt-2 space-y-1">
          <li
            v-for="material in selectedMaterials"
            :key="material.name"
            class="flex items-center justify-between"
          >
            <span>{{ material.name }}</span>
            <DcBadge v-if="material.linkedTypeKeys.length" variant="outline">
              {{ t('settings.documents.reimbursement.materialCount', { count: material.count }) }}
            </DcBadge>
          </li>
        </ul>
      </details>

      <div v-for="group in selectedGroups" :key="group.person ?? '__unknown__'" class="mb-5">
        <h3 class="mb-2 text-sm font-medium">
          {{ group.person ?? t('settings.documents.reimbursement.unknownPerson') }}
        </h3>
        <div
          v-for="bucket in group.buckets"
          :key="bucket.period ?? '__unknown_period__'"
          class="mb-3"
        >
          <div class="mb-1 text-xs text-muted-foreground">
            {{ bucket.period ?? t('settings.documents.reimbursement.unknownPeriod') }}
          </div>
          <div
            v-for="entry in bucket.documents"
            :key="entry.id"
            class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm"
            :data-testid="`reimbursement-entry-${entry.id}`"
          >
            <span class="w-40 shrink-0 truncate">{{ entry.templateName }}</span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground">
              {{ entry.fileNames.join('、') }}
            </span>
            <span
              v-if="entry.amount !== null"
              class="shrink-0 tabular-nums"
              :class="{ 'text-amber-600': entry.amountUncertain }"
            >
              ¥{{ entry.amount }}
            </span>
            <select
              class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
              :value="entry.isOverride ? '__override__' : '__auto__'"
              @change="onMove(entry.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="__auto__">
                {{ t('settings.documents.reimbursement.autoCategory') }}
              </option>
              <option value="__unassigned__">
                {{ t('settings.documents.reimbursement.forceUnassigned') }}
              </option>
              <option
                v-for="node in store.reimbursementTree?.tree ?? []"
                :key="node.category.id"
                :value="node.category.id"
              >
                {{ node.category.name }}
              </option>
            </select>
          </div>
        </div>
      </div>
      <p v-if="!selectedGroups.length" class="py-10 text-center text-sm text-muted-foreground">
        {{ t('settings.documents.reimbursement.empty') }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createConfigClient } from '@api/ConfigClient'
import { REIMBURSEMENT_UNASSIGNED } from '@shared/documents'
import { useDocumentsStore } from '@/stores/documents'

const { t } = useI18n()
const store = useDocumentsStore()
const configClient = createConfigClient()

const selectedCategoryId = ref<string | null>(null)
const exporting = ref(false)

onMounted(async () => {
  await store.loadReimbursementTree()
  // Land on the first category so the main content is visible right away;
  // the unassigned bucket stays one click away in the aside.
  selectedCategoryId.value = store.reimbursementTree?.tree[0]?.category.id ?? null
})

const selectedNode = computed(
  () =>
    store.reimbursementTree?.tree.find((node) => node.category.id === selectedCategoryId.value) ??
    null
)
const selectedName = computed(
  () => selectedNode.value?.category.name ?? t('settings.documents.reimbursement.unassigned')
)
const selectedGroups = computed(() =>
  selectedCategoryId.value === null
    ? (store.reimbursementTree?.unassigned ?? [])
    : (selectedNode.value?.groups ?? [])
)
const selectedMaterials = computed(() => selectedNode.value?.materials ?? [])
const unassignedTotal = computed(() =>
  (store.reimbursementTree?.unassigned ?? []).reduce((sum, group) => {
    return sum + group.buckets.reduce((total, bucket) => total + bucket.documents.length, 0)
  }, 0)
)

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[ReimbursementView] Failed to present notification', error)
  }
}

function onMove(documentId: string, value: string) {
  if (value === '__auto__') {
    void store.setReimbursementOverride(documentId, null)
    return
  }
  void store.setReimbursementOverride(
    documentId,
    value === '__unassigned__' ? REIMBURSEMENT_UNASSIGNED : value
  )
}

function goConfig() {
  void configClient.openSettings({ routeName: 'settings-documents-reimbursement' })
}

async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await store.exportReimbursementPackage()
    if (result.canceled) return
    notifyTransient(
      'success',
      'documents.reimbursement.exportSuccess',
      t('settings.documents.reimbursement.exportDone', {
        count: result.exportedFiles ?? 0,
        path: result.path ?? ''
      })
    )
  } catch (error) {
    console.error('[ReimbursementView] export failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.exportFailed',
      t('settings.documents.reimbursement.exportFailed')
    )
  } finally {
    exporting.value = false
  }
}
</script>
