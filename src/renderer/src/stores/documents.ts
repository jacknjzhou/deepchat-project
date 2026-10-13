import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DocumentsClient } from '@api/DocumentsClient'
import type {
  DocumentTemplate,
  DocumentFieldValueType,
  DocumentExtractionMode,
  DocumentTemplateCategory,
  DocumentRecord,
  DocumentFieldEntry,
  DocumentStatus,
  RecognitionDuplicate
} from '@shared/documents'
import type { z } from 'zod'
import type {
  documentsStatsEntrySchema,
  documentsTasksScanBatchesRoute,
  documentsTemplateUpsertInputSchema,
  unifiedTaskEntrySchema,
  ReimbursementConfig,
  ReimbursementTreeResult
} from '@shared/contracts/routes'
import type { documentsTaskUpdatedEvent } from '@shared/contracts/events'
import { documentsApi, type DocumentsTaskItem } from '@api/documentTasks'

export type { DocumentsTaskItem }

export type TemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>

type DocumentsStatsEntry = z.infer<typeof documentsStatsEntrySchema>
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

const defaultClient = documentsApi

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
      // The tasks view refreshes alongside the archive once it has been opened.
      if (taskList.value.length > 0 || taskPage.value > 1) {
        scheduleTaskRefresh()
      }
      // Once loaded, keep the reimbursement tree fresh for the session.
      if (reimbursementTree.value !== null) {
        scheduleReimbursementRefresh()
      }
    }
  }

  async function createRecognitionTasks(
    input: { files: Array<{ path: string; name?: string }>; templateId: string },
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.createTasks({ ...input, source: 'manual' })
    const created = result.tasks as DocumentsTaskItem[]
    tasks.value = [...created, ...tasks.value]
    // Content-dedupe skips: tolerate clients that predate the duplicates field.
    const duplicates = (result as { duplicates?: RecognitionDuplicate[] }).duplicates ?? []
    return { created, duplicates }
  }

  async function retryRecognitionTask(
    task: { id: string },
    options?: { templateId?: string },
    client: DocumentsClient = defaultClient
  ) {
    // The manager resets the same task row and re-queues it; keep the strip
    // entry in place instead of creating a second task for the same file.
    // A template override re-targets the task at a user-picked category.
    const result = await client.retryTask(task.id, options?.templateId)
    if (!result.task) {
      throw new Error(`Task is not retryable: ${task.id}`)
    }
    const reset = result.task as DocumentsTaskItem
    const index = tasks.value.findIndex((t) => t.id === reset.id)
    if (index >= 0) {
      tasks.value[index] = reset
    } else {
      tasks.value.unshift(reset)
    }
    return reset
  }

  async function clearFailedRecognitionTasks(client: DocumentsClient = defaultClient) {
    const result = await client.clearFailedTasks()
    tasks.value = tasks.value.filter((t) => t.status !== 'failed')
    return result.removed
  }

  const TASK_PAGE_SIZE = 50
  type UnifiedTaskItem = z.infer<typeof unifiedTaskEntrySchema>
  type ScanBatchItem = z.infer<typeof documentsTasksScanBatchesRoute.output>['batches'][number]
  type UnifiedSource = UnifiedTaskItem['source']

  const taskList = ref<UnifiedTaskItem[]>([])
  const taskTotal = ref(0)
  const taskPage = ref(1)
  const taskIsLoading = ref(false)
  const taskLoadError = ref<string | null>(null)
  const taskFilter = reactive({
    source: undefined as UnifiedSource | undefined,
    status: undefined as UnifiedTaskItem['status'] | undefined,
    batchId: undefined as string | undefined
  })
  const scanBatches = ref<ScanBatchItem[]>([])
  const taskTotalPages = computed(() => Math.max(1, Math.ceil(taskTotal.value / TASK_PAGE_SIZE)))

  // Guards against out-of-order task-view responses: only the latest
  // loadTaskList call may commit results or manage taskIsLoading.
  let taskLoadSeq = 0
  // Trailing-edge debounce so batch completion events refresh once, not per task.
  const TASK_REFRESH_DEBOUNCE_MS = 300
  let taskRefreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleTaskRefresh() {
    if (taskRefreshTimer !== null) {
      clearTimeout(taskRefreshTimer)
    }
    taskRefreshTimer = setTimeout(() => {
      taskRefreshTimer = null
      void loadTaskList(taskPage.value)
    }, TASK_REFRESH_DEBOUNCE_MS)
  }

  async function loadTaskList(page = 1, client: DocumentsClient = defaultClient) {
    const seq = ++taskLoadSeq
    taskIsLoading.value = true
    taskLoadError.value = null
    try {
      const result = await client.listTasksPaged({
        status: taskFilter.status,
        source: taskFilter.source,
        batchId: taskFilter.batchId,
        limit: TASK_PAGE_SIZE,
        offset: (page - 1) * TASK_PAGE_SIZE
      })
      if (seq !== taskLoadSeq) {
        return
      }
      taskList.value = result.tasks
      taskTotal.value = result.total
      taskPage.value = page
    } catch (error) {
      if (seq !== taskLoadSeq) {
        return
      }
      console.error('[DocumentsStore] loadTaskList failed', error)
      taskLoadError.value = 'settings.documents.tasks.loadFailed'
    } finally {
      if (seq === taskLoadSeq) {
        taskIsLoading.value = false
      }
    }
  }

  async function loadScanBatches(client: DocumentsClient = defaultClient) {
    try {
      const result = await client.listScanBatches({ limit: 200, offset: 0 })
      scanBatches.value = result.batches
    } catch (error) {
      console.error('[DocumentsStore] loadScanBatches failed', error)
    }
  }

  async function clearFailedTaskList(client: DocumentsClient = defaultClient) {
    const removed = await client.clearFailedTasks()
    tasks.value = tasks.value.filter((t) => t.status !== 'failed')
    await loadTaskList(taskPage.value, client)
    if (taskList.value.length === 0 && taskPage.value > 1) {
      await loadTaskList(taskPage.value - 1, client)
    }
    return removed
  }

  function replaceArchiveDocument(document: DocumentRecord) {
    const index = archiveDocuments.value.findIndex((d) => d.id === document.id)
    if (index >= 0) {
      archiveDocuments.value[index] = document
    } else {
      archiveDocuments.value.unshift(document)
    }
  }

  // In-place-only sibling of replaceArchiveDocument: never prepends, so
  // reimbursement calls made from views without the archive list loaded cannot
  // inject orphan rows into an unloaded/filtered list.
  function replaceArchiveDocumentInPlace(document: DocumentRecord) {
    const index = archiveDocuments.value.findIndex((d) => d.id === document.id)
    if (index >= 0) {
      archiveDocuments.value[index] = document
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
    // With documentId the main process updated the existing record in place
    // (re-recognize); without it a new draft was archived, so prepend it.
    if (input.documentId) {
      replaceArchiveDocument(document)
    } else {
      archiveDocuments.value.unshift(document)
    }
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

  const reimbursementConfig = ref<ReimbursementConfig | null>(null)
  const reimbursementTree = ref<ReimbursementTreeResult | null>(null)
  const reimbursementIsLoading = ref(false)
  const reimbursementLoadError = ref<string | null>(null)

  async function loadReimbursementConfig(client: DocumentsClient = defaultClient) {
    const result = await client.reimbursementGetConfig()
    reimbursementConfig.value = result.config
    return result.config
  }

  async function saveReimbursementConfig(
    config: ReimbursementConfig,
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.reimbursementSetConfig(config)
    reimbursementConfig.value = result.config
    return result.config
  }

  // Guards against out-of-order reimbursement responses: only the latest
  // loadReimbursementTree call may commit results or manage isLoading.
  let reimbursementLoadSeq = 0
  // Trailing-edge debounce so batch completion events refresh the tree once,
  // mirroring scheduleArchiveRefresh; guarded by reimbursementLoadSeq.
  const REIMBURSEMENT_REFRESH_DEBOUNCE_MS = 300
  let reimbursementRefreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleReimbursementRefresh() {
    if (reimbursementRefreshTimer !== null) {
      clearTimeout(reimbursementRefreshTimer)
    }
    reimbursementRefreshTimer = setTimeout(() => {
      reimbursementRefreshTimer = null
      void loadReimbursementTree()
    }, REIMBURSEMENT_REFRESH_DEBOUNCE_MS)
  }

  async function loadReimbursementTree(client: DocumentsClient = defaultClient) {
    const seq = ++reimbursementLoadSeq
    reimbursementIsLoading.value = true
    reimbursementLoadError.value = null
    try {
      const result = await client.reimbursementTree({
        status: archiveFilter.status,
        dateFrom: archiveFilter.dateFrom,
        dateTo: archiveFilter.dateTo
      })
      if (seq !== reimbursementLoadSeq) {
        return
      }
      reimbursementTree.value = result
    } catch (error) {
      if (seq !== reimbursementLoadSeq) {
        return
      }
      console.error('[DocumentsStore] loadReimbursementTree failed', error)
      reimbursementLoadError.value = 'settings.documents.reimbursement.loadFailed'
    } finally {
      if (seq === reimbursementLoadSeq) {
        reimbursementIsLoading.value = false
      }
    }
  }

  async function setReimbursementOverride(
    documentId: string,
    categoryId: string | null,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentRecord | null> {
    const result = await client.reimbursementSetOverride(documentId, categoryId)
    const document = result.document as DocumentRecord | null
    if (document) {
      replaceArchiveDocumentInPlace(document)
    }
    await loadReimbursementTree(client)
    return document
  }

  async function setReimbursementGroupOverride(
    documentId: string,
    groupId: string | null,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentRecord | null> {
    const result = await client.reimbursementSetGroupOverride(documentId, groupId)
    const document = result.document as DocumentRecord | null
    if (document) {
      replaceArchiveDocumentInPlace(document)
    }
    await loadReimbursementTree(client)
    return document
  }

  async function exportReimbursementPackage(
    selection?: { categoryId: string; groupIds: string[] },
    client: DocumentsClient = defaultClient
  ) {
    return client.reimbursementExport({
      status: archiveFilter.status,
      dateFrom: archiveFilter.dateFrom,
      dateTo: archiveFilter.dateTo,
      ...(selection ? { categoryId: selection.categoryId, groupIds: selection.groupIds } : {})
    })
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
    taskList,
    taskTotal,
    taskPage,
    taskTotalPages,
    taskIsLoading,
    taskLoadError,
    taskFilter,
    scanBatches,
    loadTaskList,
    loadScanBatches,
    clearFailedTaskList,
    handleTaskUpdated,
    createRecognitionTasks,
    retryRecognitionTask,
    clearFailedRecognitionTasks,
    saveArchiveDocument,
    removeArchiveDocument,
    recognizeDocument,
    exportArchiveCsv,
    previewArchiveFile,
    reimbursementConfig,
    reimbursementTree,
    reimbursementIsLoading,
    reimbursementLoadError,
    loadReimbursementConfig,
    saveReimbursementConfig,
    loadReimbursementTree,
    setReimbursementOverride,
    setReimbursementGroupOverride,
    exportReimbursementPackage
  }
})
