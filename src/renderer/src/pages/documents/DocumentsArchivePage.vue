<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">
        {{ t('settings.documents.archive.title') }}
      </h1>
      <div class="flex items-center gap-2">
        <DcButton
          variant="outline"
          data-testid="archive-export"
          :disabled="store.archiveIsLoading"
          @click="onExportCsv"
        >
          <Icon icon="lucide:download" class="mr-1 size-4" />
          {{ t('settings.documents.archive.exportCsv') }}
        </DcButton>
        <DcButton data-testid="archive-new-recognition" @click="recognizeOpen = true">
          <Icon icon="lucide:scan-text" class="mr-1 size-4" />
          {{ t('settings.documents.archive.newRecognition') }}
        </DcButton>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-1 border-b px-6 py-2" data-testid="archive-tabs">
      <DcButton
        :variant="activeTab === ALL_TAB ? 'default' : 'ghost'"
        size="sm"
        data-testid="archive-tab-all"
        @click="onTabChange(ALL_TAB)"
      >
        {{ t('settings.documents.archive.tabAll') }}
        <DcBadge variant="outline" class="ml-1">{{ allStats.total }}</DcBadge>
      </DcButton>
      <DcButton
        v-for="tpl in store.templates"
        :key="tpl.typeKey"
        :variant="activeTab === tpl.typeKey ? 'default' : 'ghost'"
        size="sm"
        :data-testid="`archive-tab-${tpl.typeKey}`"
        @click="onTabChange(tpl.typeKey)"
      >
        {{ tpl.name }}
        <DcBadge variant="outline" class="ml-1">{{ statsFor(tpl.typeKey).total }}</DcBadge>
      </DcButton>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <DcButton
        v-for="option in statusOptions"
        :key="option.value"
        size="sm"
        :variant="store.archiveFilter.status === option.statusValue ? 'default' : 'outline'"
        :data-testid="`archive-status-chip-${option.value}`"
        @click="onStatusChip(option.statusValue)"
      >
        {{ option.label }}
        <span class="ml-1 text-muted-foreground">{{ option.count }}</span>
      </DcButton>
      <Input
        v-model="dateFromText"
        type="date"
        data-testid="archive-filter-date-from"
        class="w-40"
        :aria-label="t('settings.documents.archive.dateFrom')"
      />
      <span class="text-muted-foreground">~</span>
      <Input
        v-model="dateToText"
        type="date"
        data-testid="archive-filter-date-to"
        class="w-40"
        :aria-label="t('settings.documents.archive.dateTo')"
      />
      <Input
        v-model="keywordText"
        type="search"
        data-testid="archive-filter-keyword"
        class="w-52"
        :placeholder="t('settings.documents.archive.keywordPlaceholder')"
        @keydown.enter="applyFilters"
      />
    </div>

    <DocumentTaskStrip
      v-if="visibleTasks.length"
      :tasks="visibleTasks"
      :type-name-for="typeNameFor"
      :retrying-task-ids="retryingTaskIds"
      @retry="onRetryTask"
    />

    <div v-if="store.archiveLoadError" class="flex flex-col items-center gap-3 px-6 py-10">
      <p class="text-sm text-destructive">{{ t(store.archiveLoadError) }}</p>
      <DcButton variant="outline" data-testid="archive-retry" @click="retry">
        {{ t('settings.documents.archive.retry') }}
      </DcButton>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-auto px-6 py-3">
      <table v-if="store.archiveDocuments.length" class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-b text-left text-muted-foreground">
            <th v-if="!selectedTypeKey" class="px-2 py-2 font-medium">
              {{ t('settings.documents.archive.colType') }}
            </th>
            <th v-for="column in tableFieldColumns" :key="column.key" class="px-2 py-2 font-medium">
              {{ column.label }}
            </th>
            <th v-if="!selectedTypeKey" class="px-2 py-2 font-medium">
              {{ t('settings.documents.archive.colSummary') }}
            </th>
            <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colSource') }}</th>
            <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colStatus') }}</th>
            <th class="px-2 py-2 font-medium">
              {{ t('settings.documents.archive.colCreatedAt') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="document in store.archiveDocuments"
            :key="document.id"
            data-testid="archive-row"
            class="cursor-pointer border-b transition-colors hover:bg-accent/40"
            @click="openDetail(document)"
          >
            <td v-if="!selectedTypeKey" class="px-2 py-2">
              {{ templateNameById.get(document.templateId) ?? document.typeKey }}
            </td>
            <td v-for="column in tableFieldColumns" :key="column.key" class="px-2 py-2">
              {{ formatFieldValue(document.fields[column.key]?.value ?? null) }}
            </td>
            <td v-if="!selectedTypeKey" class="max-w-64 truncate px-2 py-2">
              {{ summarizeDocument(document) }}
            </td>
            <td class="px-2 py-2">
              {{ t(`settings.documents.archive.source${capitalize(document.source)}`) }}
            </td>
            <td class="px-2 py-2">
              {{ t(`settings.documents.archive.status${capitalize(document.status)}`) }}
            </td>
            <td class="px-2 py-2">{{ new Date(document.createdAt).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
      <p
        v-else-if="!store.archiveIsLoading"
        class="px-2 py-10 text-center text-sm text-muted-foreground"
      >
        {{ t('settings.documents.archive.empty') }}
      </p>
    </div>

    <div class="flex items-center justify-between border-t px-6 py-2 text-sm">
      <span class="text-muted-foreground">
        {{ t('settings.documents.archive.totalCount', { total: store.archiveTotal }) }}
      </span>
      <div class="flex items-center gap-1">
        <DcButton
          variant="outline"
          size="sm"
          data-testid="archive-page-prev"
          :disabled="store.archivePage <= 1 || store.archiveIsLoading"
          @click="goPage(store.archivePage - 1)"
        >
          ‹
        </DcButton>
        <span>{{ store.archivePage }} / {{ store.archiveTotalPages }}</span>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="archive-page-next"
          :disabled="store.archivePage >= store.archiveTotalPages || store.archiveIsLoading"
          @click="goPage(store.archivePage + 1)"
        >
          ›
        </DcButton>
      </div>
    </div>

    <DocumentDetailDialog
      v-model:open="detailOpen"
      :document="detailDocument"
      @re-recognized="onReRecognized"
    />
    <DocumentRecognizeDialog v-model:open="recognizeOpen" @recognized="onRecognized" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import { DcButton } from '@dc-ui/components/button'
import { DcBadge } from '@dc-ui/components/badge'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createOcrClient } from '@api/OcrClient'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentRecord, DocumentStatus } from '@shared/documents'
import {
  buildDefaultDateRangeTexts,
  buildMoneyColumns,
  formatDateRangeToMs,
  formatFieldValue,
  orderedSnapshotFields,
  type MoneyColumn
} from './documentArchive'
import { summarizeDocument } from './documentSummary'
import { documentsApi, type DocumentsTaskItem } from '@api/documentTasks'
import DocumentDetailDialog from './DocumentDetailDialog.vue'
import DocumentRecognizeDialog from './DocumentRecognizeDialog.vue'
import DocumentTaskStrip from './DocumentTaskStrip.vue'

const ALL_TAB = '__all__'

const { t } = useI18n()
const store = useDocumentsStore()

const detailOpen = ref(false)
const recognizeOpen = ref(false)
const detailDocument = ref<DocumentRecord | null>(null)
// Default to the trailing week up front so the first load is already scoped;
// date text is converted to ms once in syncFilters before the first query.
const defaultRange = buildDefaultDateRangeTexts()
const dateFromText = ref(defaultRange.from)
const dateToText = ref(defaultRange.to)
const keywordText = ref('')
const activeTab = ref(ALL_TAB)

const selectedTypeKey = computed(() => store.archiveFilter.typeKey ?? null)

const templateNameById = computed(() => new Map(store.templates.map((tpl) => [tpl.id, tpl.name])))

const moneyColumns = computed<MoneyColumn[]>(() => buildMoneyColumns(store.archiveDocuments))

const tableFieldColumns = computed<{ key: string; label: string }[]>(() => {
  if (selectedTypeKey.value) {
    const template = store.templates.find((tpl) => tpl.typeKey === selectedTypeKey.value)
    if (!template) {
      return []
    }
    const snapshot = { fields: template.fields } as DocumentRecord['templateSnapshot']
    return orderedSnapshotFields(snapshot).map((f) => ({ key: f.key, label: f.label }))
  }
  return moneyColumns.value
})

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

const allStats = computed(() =>
  store.archiveStats.reduce(
    (acc, entry) => ({
      total: acc.total + entry.total,
      draft: acc.draft + entry.draft,
      confirmed: acc.confirmed + entry.confirmed
    }),
    { total: 0, draft: 0, confirmed: 0 }
  )
)

function statsFor(typeKey: string) {
  return (
    store.archiveStats.find((entry) => entry.typeKey === typeKey) ?? {
      typeKey,
      total: 0,
      draft: 0,
      confirmed: 0
    }
  )
}

const statusOptions = computed(() => [
  {
    value: 'all',
    statusValue: undefined as DocumentStatus | undefined,
    label: t('settings.documents.archive.statusAll'),
    count: selectedTypeKey.value ? statsFor(selectedTypeKey.value).total : allStats.value.total
  },
  {
    value: 'draft',
    statusValue: 'draft' as DocumentStatus,
    label: t('settings.documents.archive.statusDraft'),
    count: selectedTypeKey.value ? statsFor(selectedTypeKey.value).draft : allStats.value.draft
  },
  {
    value: 'confirmed',
    statusValue: 'confirmed' as DocumentStatus,
    label: t('settings.documents.archive.statusConfirmed'),
    count: selectedTypeKey.value
      ? statsFor(selectedTypeKey.value).confirmed
      : allStats.value.confirmed
  }
])

function syncFilters() {
  store.archiveFilter.dateFrom = formatDateRangeToMs(dateFromText.value)
  store.archiveFilter.dateTo = formatDateRangeToMs(dateToText.value, 'end')
  store.archiveFilter.keyword = keywordText.value.trim() || undefined
}

function applyFilters() {
  syncFilters()
  void store.loadArchiveDocuments()
  void store.loadArchiveStats()
}

function onTabChange(typeKey: string) {
  if (activeTab.value === typeKey) {
    return
  }
  activeTab.value = typeKey
  store.archiveFilter.typeKey = typeKey === ALL_TAB ? undefined : typeKey
  store.archiveFilter.status = undefined
  void store.loadArchiveDocuments(1)
}

function onStatusChip(status: DocumentStatus | undefined) {
  if (store.archiveFilter.status === status) {
    return
  }
  store.archiveFilter.status = status
  void store.loadArchiveDocuments(1)
}

function goPage(page: number) {
  if (page < 1 || page > store.archiveTotalPages) {
    return
  }
  void store.loadArchiveDocuments(page)
}

watch(dateFromText, applyFilters)
watch(dateToText, applyFilters)

function retry() {
  void store.loadArchiveDocuments(store.archivePage)
}

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[DocumentsArchivePage] Failed to present notification', error)
  }
}

async function onExportCsv() {
  try {
    const result = await store.exportArchiveCsv()
    if (result.canceled) {
      return
    }
    notifyTransient(
      'success',
      'documents.archive.exportSuccess',
      t('settings.documents.archive.exportSuccess', { path: result.path })
    )
  } catch (error) {
    console.error('[DocumentsArchivePage] exportCsv failed', error)
    notifyTransient(
      'error',
      'documents.archive.exportFailed',
      t('settings.documents.archive.exportFailed')
    )
  }
}

function openDetail(document: DocumentRecord) {
  detailDocument.value = document
  detailOpen.value = true
}

function onReRecognized(document: DocumentRecord) {
  detailDocument.value = document
}

function onRecognized(document: DocumentRecord) {
  detailDocument.value = document
  detailOpen.value = true
}

const visibleTasks = computed(() =>
  store.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running' || task.status === 'failed'
  )
)

function typeNameFor(typeKey: string | null): string | null {
  if (!typeKey) return null
  return store.templates.find((tpl) => tpl.typeKey === typeKey)?.name ?? typeKey
}

// Replaced wholesale on mutation so the Set change triggers reactivity.
const retryingTaskIds = ref(new Set<string>())

async function onRetryTask(task: DocumentsTaskItem) {
  if (retryingTaskIds.value.has(task.id)) {
    return
  }
  retryingTaskIds.value = new Set(retryingTaskIds.value).add(task.id)
  try {
    await store.retryRecognitionTask(task)
    notifyTransient(
      'success',
      'documents.archive.taskRetryQueued',
      t('settings.documents.archive.taskRetryQueued')
    )
  } catch (error) {
    console.error('[DocumentsArchivePage] retry task failed', error)
    notifyTransient(
      'error',
      'documents.archive.taskRetryFailed',
      t('settings.documents.archive.taskRetryFailed')
    )
  } finally {
    const next = new Set(retryingTaskIds.value)
    next.delete(task.id)
    retryingTaskIds.value = next
  }
}

let unsubscribeTask: (() => void) | null = null

onMounted(() => {
  unsubscribeTask = documentsApi.onTaskUpdated((payload) => store.handleTaskUpdated(payload))
})

onBeforeUnmount(() => {
  unsubscribeTask?.()
  unsubscribeTask = null
})

syncFilters()
void store.loadTemplates()
void store.loadArchiveDocuments(1)
void store.loadArchiveStats()
void store.loadArchiveTasks()

// Start the OCR helper ahead of the first recognition so scanned PDFs skip
// the cold start. Failures surface naturally when a real extraction runs.
void createOcrClient()
  .warmup()
  .catch(() => {})
</script>
