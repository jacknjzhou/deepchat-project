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

    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <Select
        :model-value="store.archiveFilter.typeKey ?? ALL_VALUE"
        data-testid="archive-filter-type"
        class="w-44"
        @update:model-value="onTypeFilter"
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_VALUE">{{ t('settings.documents.archive.typeAll') }}</SelectItem>
          <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.typeKey">
            {{ tpl.name }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select
        :model-value="store.archiveFilter.status ?? ALL_VALUE"
        data-testid="archive-filter-status"
        class="w-36"
        @update:model-value="onStatusFilter"
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_VALUE">{{
            t('settings.documents.archive.statusAll')
          }}</SelectItem>
          <SelectItem value="draft">{{ t('settings.documents.archive.statusDraft') }}</SelectItem>
          <SelectItem value="confirmed">
            {{ t('settings.documents.archive.statusConfirmed') }}
          </SelectItem>
        </SelectContent>
      </Select>
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
      <div v-if="store.archivePage < store.archiveTotalPages" class="flex justify-center py-3">
        <DcButton
          variant="outline"
          data-testid="archive-load-more"
          @click="store.loadArchiveDocuments(store.archivePage + 1)"
        >
          {{ t('settings.documents.archive.loadMore') }}
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
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createOcrClient } from '@api/OcrClient'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentRecord } from '@shared/documents'
import {
  buildMoneyColumns,
  formatDateRangeToMs,
  formatFieldValue,
  orderedSnapshotFields,
  type MoneyColumn
} from './documentArchive'
import { summarizeDocument } from './documentSummary'
import DocumentDetailDialog from './DocumentDetailDialog.vue'
import DocumentRecognizeDialog from './DocumentRecognizeDialog.vue'

const ALL_VALUE = '__all__'

const { t } = useI18n()
const store = useDocumentsStore()

const detailOpen = ref(false)
const recognizeOpen = ref(false)
const detailDocument = ref<DocumentRecord | null>(null)
const dateFromText = ref('')
const dateToText = ref('')
const keywordText = ref('')

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

function syncFilters() {
  store.archiveFilter.dateFrom = formatDateRangeToMs(dateFromText.value)
  store.archiveFilter.dateTo = formatDateRangeToMs(dateToText.value, 'end')
  store.archiveFilter.keyword = keywordText.value.trim() || undefined
}

function applyFilters() {
  syncFilters()
  void store.loadArchiveDocuments()
}

function onTypeFilter(value: unknown) {
  store.archiveFilter.typeKey = value === ALL_VALUE ? undefined : String(value)
  void store.loadArchiveDocuments()
}

function onStatusFilter(value: unknown) {
  store.archiveFilter.status =
    value === ALL_VALUE ? undefined : (String(value) as 'draft' | 'confirmed')
  void store.loadArchiveDocuments()
}

watch(dateFromText, applyFilters)
watch(dateToText, applyFilters)

function retry() {
  void store.loadArchiveDocuments()
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

void store.loadTemplates()
void store.loadArchiveDocuments()

// Start the OCR helper ahead of the first recognition so scanned PDFs skip
// the cold start. Failures surface naturally when a real extraction runs.
void createOcrClient()
  .warmup()
  .catch(() => {})
</script>
