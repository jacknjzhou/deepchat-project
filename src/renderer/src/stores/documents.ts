import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createDocumentsClient, type DocumentsClient } from '@api/DocumentsClient'
import type {
  DocumentTemplate,
  DocumentFieldValueType,
  DocumentExtractionMode,
  DocumentTemplateCategory
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
    testExtract
  }
})
