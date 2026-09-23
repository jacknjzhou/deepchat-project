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
import type { documentsTemplateUpsertInputSchema } from '@shared/contracts/routes'

export type TemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>

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
  const archiveHasMore = ref(false)
  const archiveFilter = reactive({
    typeKey: undefined as string | undefined,
    status: undefined as DocumentStatus | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  })

  async function loadArchiveDocuments(reset = true, client: DocumentsClient = defaultClient) {
    archiveIsLoading.value = true
    archiveLoadError.value = null
    try {
      const offset = reset ? 0 : archiveDocuments.value.length
      const result = await client.listDocuments({
        ...archiveFilter,
        limit: ARCHIVE_PAGE_SIZE,
        offset
      })
      const documents = result.documents as DocumentRecord[]
      archiveDocuments.value = reset ? documents : [...archiveDocuments.value, ...documents]
      archiveHasMore.value = documents.length === ARCHIVE_PAGE_SIZE
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveDocuments failed', error)
      archiveLoadError.value = 'settings.documents.archive.loadFailed'
    } finally {
      archiveIsLoading.value = false
    }
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
    archiveHasMore,
    archiveFilter,
    loadArchiveDocuments,
    saveArchiveDocument,
    removeArchiveDocument,
    recognizeDocument,
    exportArchiveCsv,
    previewArchiveFile
  }
})
