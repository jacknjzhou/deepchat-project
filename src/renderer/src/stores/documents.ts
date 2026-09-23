import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { createDocumentsClient, type DocumentsClient } from '@api/DocumentsClient'
import type {
  DocumentTemplate,
  DocumentFieldValueType,
  DocumentExtractionMode,
  DocumentTemplateCategory,
  DocumentRecord,
  DocumentFieldEntry,
  DocumentStatus
} from '@shared/documents'
import type { z } from 'zod'
import type {
  documentTaskSchema,
  documentsStatsEntrySchema,
  documentsTemplateUpsertInputSchema
} from '@shared/contracts/routes'
import type { documentsTaskUpdatedEvent } from '@shared/contracts/events'

export type TemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>

type DocumentsStatsEntry = z.infer<typeof documentsStatsEntrySchema>
type DocumentsTaskItem = z.infer<typeof documentTaskSchema>
type DocumentsTaskUpdatedPayload = z.infer<typeof documentsTaskUpdatedEvent.payload>

export interface EditableTemplateDraft {
  id?: string
  typeKey: string
  name: string
  icon: string | null
  category: DocumentTemplateCategory
  fields: Array<{
    key: string
    label: string
    valueType: DocumentFieldValueType
    required: boolean
    promptHint: string | null
    validation: string | null
    enumOptions: string[] | null
    order: number
  }>
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin?: boolean
  builtinSourceId?: string | null
}

const ARCHIVE_REFERENCE_RE = /Template has (\d+) archived document/

const defaultClient = createDocumentsClient()

export const useDocumentsStore = defineStore('documents', () => {
  const templates = ref<DocumentTemplate[]>([])
  const isLoading = ref(false)
  const loadError = ref<string | null>(null)

  const builtinTemplates = computed(() => templates.value.filter((t) => t.isBuiltin))
  const customTemplates = computed(() => templates.value.filter((t) => !t.isBuiltin))

  async function loadTemplates(client: DocumentsClient = defaultClient) {
    isLoading.value = true
    loadError.value = null
    try {
      const result = await client.listTemplates()
      templates.value = result.templates as DocumentTemplate[]
    } catch (error) {
      console.error('[DocumentsStore] loadTemplates failed', error)
      loadError.value = 'settings.documents.templates.loadFailed'
      templates.value = []
    } finally {
      isLoading.value = false
    }
  }

  function isTypeKeyTaken(typeKey: string, excludeId?: string): boolean {
    return templates.value.some((t) => t.typeKey === typeKey && t.id !== excludeId)
  }

  type DeleteResult =
    | { kind: 'deleted' }
    | { kind: 'force-required'; referenceCount: number }
    | { kind: 'rejected'; messageKey: string }

  async function attemptDelete(
    id: string,
    options?: { force?: boolean },
    client: DocumentsClient = defaultClient
  ): Promise<DeleteResult> {
    try {
      await client.deleteTemplate(id, options?.force)
      templates.value = templates.value.filter((t) => t.id !== id)
      return { kind: 'deleted' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const match = message.match(ARCHIVE_REFERENCE_RE)
      if (match) {
        return { kind: 'force-required', referenceCount: Number(match[1]) }
      }
      if (message.includes('Cannot delete a builtin template')) {
        return { kind: 'rejected', messageKey: 'settings.documents.templates.builtinGroup' }
      }
      return { kind: 'rejected', messageKey: 'settings.documents.templates.deleteFailed' }
    }
  }

  async function saveTemplate(
    input: TemplateUpsertInput,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentTemplate> {
    const result = await client.upsertTemplate(input)
    const template = result.template as DocumentTemplate
    const index = templates.value.findIndex((t) => t.id === template.id)
    if (index >= 0) {
      templates.value[index] = template
    } else {
      templates.value.push(template)
    }
    return template
  }

  async function testExtract(
    input: Parameters<DocumentsClient['testExtract']>[0],
    client: DocumentsClient = defaultClient
  ) {
    return client.testExtract(input)
  }

  const ARCHIVE_PAGE_SIZE = 50
  const archiveDocuments = ref<DocumentRecord[]>([])
  const archiveIsLoading = ref(false)
  const archiveLoadError = ref<string | null>(null)
  const archiveTotal = ref(0)
  const archivePage = ref(1)
  const archiveStats = ref<DocumentsStatsEntry[]>([])
  const tasks = ref<DocumentsTaskItem[]>([])
  const archiveFilter = reactive({
    typeKey: undefined as string | undefined,
    status: undefined as DocumentStatus | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  })
  const archiveTotalPages = computed(() =>
    Math.max(1, Math.ceil(archiveTotal.value / ARCHIVE_PAGE_SIZE))
  )

  // Guards against out-of-order archive responses: only the latest
  // loadArchiveDocuments call may commit results or manage isLoading.
  let archiveLoadSeq = 0
  // Trailing-edge debounce so batch completion events refresh once, not per task.
  const ARCHIVE_REFRESH_DEBOUNCE_MS = 300
  let archiveRefreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleArchiveRefresh() {
    if (archiveRefreshTimer !== null) {
      clearTimeout(archiveRefreshTimer)
    }
    archiveRefreshTimer = setTimeout(() => {
      archiveRefreshTimer = null
      void loadArchiveStats()
      void loadArchiveDocuments(archivePage.value)
    }, ARCHIVE_REFRESH_DEBOUNCE_MS)
  }

  async function loadArchiveDocuments(page = 1, client: DocumentsClient = defaultClient) {
    const seq = ++archiveLoadSeq
    archiveIsLoading.value = true
    archiveLoadError.value = null
    try {
      const result = await client.listDocuments({
        ...archiveFilter,
        limit: ARCHIVE_PAGE_SIZE,
        offset: (page - 1) * ARCHIVE_PAGE_SIZE
      })
      if (seq !== archiveLoadSeq) {
        return
      }
      archiveDocuments.value = result.documents as DocumentRecord[]
      archiveTotal.value = result.total
      archivePage.value = page
    } catch (error) {
      if (seq !== archiveLoadSeq) {
        return
      }
      console.error('[DocumentsStore] loadArchiveDocuments failed', error)
      archiveLoadError.value = 'settings.documents.archive.loadFailed'
    } finally {
      if (seq === archiveLoadSeq) {
        archiveIsLoading.value = false
      }
    }
  }

  async function loadArchiveStats(client: DocumentsClient = defaultClient) {
    try {
      const result = await client.stats({
        dateFrom: archiveFilter.dateFrom,
        dateTo: archiveFilter.dateTo
      })
      archiveStats.value = result.stats as DocumentsStatsEntry[]
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveStats failed', error)
    }
  }

  async function loadArchiveTasks(client: DocumentsClient = defaultClient) {
    try {
      const result = await client.listTasks()
      tasks.value = result.tasks as DocumentsTaskItem[]
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveTasks failed', error)
    }
  }

  function handleTaskUpdated(payload: DocumentsTaskUpdatedPayload) {
    const index = tasks.value.findIndex((task) => task.id === payload.id)
    if (index >= 0) {
      tasks.value[index] = payload
    } else {
      tasks.value.unshift(payload)
    }
    if (payload.status === 'done' || payload.status === 'failed') {
      scheduleArchiveRefresh()
    }
  }

  async function createRecognitionTasks(
    input: { files: Array<{ path: string; name?: string }>; templateId: string },
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.createTasks({ ...input, source: 'manual' })
    const created = result.tasks as DocumentsTaskItem[]
    tasks.value = [...created, ...tasks.value]
    return created
  }

  async function retryRecognitionTask(
    task: DocumentsTaskItem,
    client: DocumentsClient = defaultClient
  ) {
    return createRecognitionTasks(
      { files: [{ path: task.filePath, name: task.fileName }], templateId: task.templateId },
      client
    )
  }

  function replaceArchiveDocument(document: DocumentRecord) {
    const index = archiveDocuments.value.findIndex((d) => d.id === document.id)
    if (index >= 0) {
      archiveDocuments.value[index] = document
    } else {
      archiveDocuments.value.unshift(document)
    }
  }

  async function saveArchiveDocument(
    id: string,
    fields: Record<string, DocumentFieldEntry>,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentRecord | null> {
    const result = await client.updateDocument({ id, fields, status: 'confirmed' })
    const document = result.document as DocumentRecord | null
    if (document) {
      replaceArchiveDocument(document)
    }
    return document
  }

  async function removeArchiveDocument(id: string, client: DocumentsClient = defaultClient) {
    await client.deleteDocument(id)
    archiveDocuments.value = archiveDocuments.value.filter((d) => d.id !== id)
  }

  async function recognizeDocument(
    input: Parameters<DocumentsClient['extractAndDraft']>[0],
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.extractAndDraft(input)
    const document = result.document as DocumentRecord
    archiveDocuments.value.unshift(document)
    return { document, meta: result.meta }
  }

  async function exportArchiveCsv(client: DocumentsClient = defaultClient) {
    return client.exportCsv({ ...archiveFilter })
  }

  async function previewArchiveFile(
    documentId: string,
    uriIndex: number,
    client: DocumentsClient = defaultClient
  ) {
    return client.previewFile({ documentId, uriIndex })
  }

  return {
    templates,
    isLoading,
    loadError,
    builtinTemplates,
    customTemplates,
    loadTemplates,
    isTypeKeyTaken,
    attemptDelete,
    saveTemplate,
    testExtract,
    archiveDocuments,
    archiveIsLoading,
    archiveLoadError,
    archiveTotal,
    archivePage,
    archiveTotalPages,
    archiveStats,
    tasks,
    archiveFilter,
    loadArchiveDocuments,
    loadArchiveStats,
    loadArchiveTasks,
    handleTaskUpdated,
    createRecognitionTasks,
    retryRecognitionTask,
    saveArchiveDocument,
    removeArchiveDocument,
    recognizeDocument,
    exportArchiveCsv,
    previewArchiveFile
  }
})
