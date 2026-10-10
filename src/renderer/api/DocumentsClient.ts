import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesTestExtractRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsExportCsvRoute,
  documentsExtractAndDraftRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsPreviewFileRoute,
  documentsReimbursementExportRoute,
  documentsReimbursementGetConfigRoute,
  documentsReimbursementSetConfigRoute,
  documentsReimbursementSetGroupOverrideRoute,
  documentsReimbursementSetOverrideRoute,
  documentsReimbursementTreeRoute,
  documentsStatsRoute,
  documentsTasksCreateRoute,
  documentsTasksClearFailedRoute,
  documentsTasksListRoute,
  documentsTasksRetryRoute,
  documentsUpsertRoute,
  type documentsListInputSchema,
  type documentsTemplateUpsertInputSchema,
  type documentsUpsertInputSchema,
  type DeepchatRouteInput,
  type DeepchatRouteName,
  type DeepchatRouteOutput,
  type ReimbursementConfig
} from '@shared/contracts/routes'
import { documentsTaskUpdatedEvent } from '@shared/contracts/events'
import type { z } from 'zod'
import { getDeepchatBridge } from './core'

export type DocumentsTemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>
export type DocumentsForkInput = z.input<typeof documentTemplatesForkRoute.input>
export type DocumentsUpdateInput = z.input<typeof documentsUpsertInputSchema>
export type DocumentsListInput = z.input<typeof documentsListInputSchema>
export type DocumentsTestExtractInput = z.input<typeof documentTemplatesTestExtractRoute.input>
export type DocumentsExtractAndDraftInput = z.input<typeof documentsExtractAndDraftRoute.input>

const toPlainIpcValue = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainIpcValue(item)) as T
  }

  const plain: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    plain[key] = toPlainIpcValue(nestedValue)
  }
  return plain as T
}

const invokeRoute = async <N extends DeepchatRouteName>(
  bridge: DeepchatBridge,
  name: N,
  input: DeepchatRouteInput<N>
): Promise<DeepchatRouteOutput<N>> => bridge.invoke(name, toPlainIpcValue(input))

export function createDocumentsClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  return {
    listTemplates: () => invokeRoute(bridge, documentTemplatesListRoute.name, {}),
    getTemplate: (id: string) => invokeRoute(bridge, documentTemplatesGetRoute.name, { id }),
    upsertTemplate: (input: DocumentsTemplateUpsertInput) =>
      invokeRoute(bridge, documentTemplatesUpsertRoute.name, input),
    deleteTemplate: (id: string, force?: boolean) =>
      invokeRoute(bridge, documentTemplatesDeleteRoute.name, { id, force }),
    forkTemplate: (input: DocumentsForkInput) =>
      invokeRoute(bridge, documentTemplatesForkRoute.name, input),
    listDocuments: (input: DocumentsListInput = {}) =>
      invokeRoute(bridge, documentsListRoute.name, input),
    getDocument: (id: string) => invokeRoute(bridge, documentsGetRoute.name, { id }),
    updateDocument: (input: DocumentsUpdateInput) =>
      invokeRoute(bridge, documentsUpsertRoute.name, input),
    deleteDocument: (id: string) => invokeRoute(bridge, documentsDeleteRoute.name, { id }),
    testExtract: (input: DocumentsTestExtractInput) =>
      invokeRoute(bridge, documentTemplatesTestExtractRoute.name, input),
    extractAndDraft: (input: DocumentsExtractAndDraftInput) =>
      invokeRoute(bridge, documentsExtractAndDraftRoute.name, input),
    exportCsv: (input: z.input<typeof documentsExportCsvRoute.input> = {}) =>
      invokeRoute(bridge, documentsExportCsvRoute.name, input),
    previewFile: (input: z.input<typeof documentsPreviewFileRoute.input>) =>
      invokeRoute(bridge, documentsPreviewFileRoute.name, input),
    stats: (input: z.input<typeof documentsStatsRoute.input> = {}) =>
      invokeRoute(bridge, documentsStatsRoute.name, input),
    createTasks: (input: z.input<typeof documentsTasksCreateRoute.input>) =>
      invokeRoute(bridge, documentsTasksCreateRoute.name, input),
    listTasks: () => invokeRoute(bridge, documentsTasksListRoute.name, {}),
    retryTask: (id: string, templateId?: string) =>
      invokeRoute(bridge, documentsTasksRetryRoute.name, {
        id,
        ...(templateId ? { templateId } : {})
      }),
    clearFailedTasks: () => invokeRoute(bridge, documentsTasksClearFailedRoute.name, {}),
    reimbursementGetConfig: () =>
      invokeRoute(bridge, documentsReimbursementGetConfigRoute.name, {}),
    reimbursementSetConfig: (config: ReimbursementConfig) =>
      invokeRoute(bridge, documentsReimbursementSetConfigRoute.name, { config }),
    reimbursementTree: (input: z.input<typeof documentsReimbursementTreeRoute.input> = {}) =>
      invokeRoute(bridge, documentsReimbursementTreeRoute.name, input),
    reimbursementSetOverride: (documentId: string, categoryId: string | null) =>
      invokeRoute(bridge, documentsReimbursementSetOverrideRoute.name, { documentId, categoryId }),
    reimbursementSetGroupOverride: (documentId: string, groupId: string | null) =>
      invokeRoute(bridge, documentsReimbursementSetGroupOverrideRoute.name, {
        documentId,
        groupId
      }),
    reimbursementExport: (input: z.input<typeof documentsReimbursementExportRoute.input> = {}) =>
      invokeRoute(bridge, documentsReimbursementExportRoute.name, input),
    onTaskUpdated: (
      listener: (payload: z.infer<typeof documentsTaskUpdatedEvent.payload>) => void
    ) => bridge.on(documentsTaskUpdatedEvent.name, listener)
  }
}

export type DocumentsClient = ReturnType<typeof createDocumentsClient>
