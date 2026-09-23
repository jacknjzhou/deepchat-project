import { promises as fsp } from 'node:fs'
import path from 'node:path'
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
  documentsStatsRoute,
  documentsTasksCreateRoute,
  documentsTasksListRoute,
  documentsUpsertRoute
} from '@shared/contracts/routes'
import { dialog } from 'electron'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import { buildDocumentsCsv, CSV_EXPORT_MAX_ROWS } from './csv'
import type { DocumentExtractor } from './extractor/documentExtractor'
import type { DocumentsRepository } from './repository'
import type { RecognitionTaskManager } from './taskManager'

interface DocumentsCsvRouteDeps {
  showSaveDialog: (
    options: Electron.SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
}

const PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf'
}

const PREVIEW_MAX_BYTES = 25 * 1024 * 1024

const defaultCsvDeps: DocumentsCsvRouteDeps = {
  showSaveDialog: (options) => dialog.showSaveDialog(options)
}

function resolvePreviewMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const mimeType = PREVIEW_MIME_BY_EXTENSION[extension]
  if (!mimeType) {
    throw new Error(`Unsupported preview type: ${extension || filePath}`)
  }
  return mimeType
}

export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor,
  taskManager: RecognitionTaskManager,
  csvDeps: DocumentsCsvRouteDeps = defaultCsvDeps
): DeepchatRouteMap {
  return createRouteMap([
    [
      documentTemplatesListRoute.name,
      async (rawInput) => {
        documentTemplatesListRoute.input.parse(rawInput)
        return documentTemplatesListRoute.output.parse({
          templates: repository.listTemplates()
        })
      }
    ],
    [
      documentTemplatesGetRoute.name,
      async (rawInput) => {
        const input = documentTemplatesGetRoute.input.parse(rawInput)
        return documentTemplatesGetRoute.output.parse({
          template: repository.getTemplate(input.id)
        })
      }
    ],
    [
      documentTemplatesUpsertRoute.name,
      async (rawInput) => {
        const input = documentTemplatesUpsertRoute.input.parse(rawInput)
        return documentTemplatesUpsertRoute.output.parse({
          template: repository.upsertTemplate(input)
        })
      }
    ],
    [
      documentTemplatesDeleteRoute.name,
      async (rawInput) => {
        const input = documentTemplatesDeleteRoute.input.parse(rawInput)
        repository.deleteTemplate(input.id, { force: input.force })
        return documentTemplatesDeleteRoute.output.parse({ success: true })
      }
    ],
    [
      documentTemplatesForkRoute.name,
      async (rawInput) => {
        const input = documentTemplatesForkRoute.input.parse(rawInput)
        return documentTemplatesForkRoute.output.parse({
          template: repository.forkTemplate(input.sourceId, input.typeKey, input.name)
        })
      }
    ],
    [
      documentsListRoute.name,
      async (rawInput) => {
        const input = documentsListRoute.input.parse(rawInput)
        return documentsListRoute.output.parse({
          documents: repository.listDocuments(input),
          total: repository.countDocuments(input)
        })
      }
    ],
    [
      documentsGetRoute.name,
      async (rawInput) => {
        const input = documentsGetRoute.input.parse(rawInput)
        return documentsGetRoute.output.parse({
          document: repository.getDocument(input.id)
        })
      }
    ],
    [
      documentsUpsertRoute.name,
      async (rawInput) => {
        const input = documentsUpsertRoute.input.parse(rawInput)
        return documentsUpsertRoute.output.parse({
          document: repository.updateDocument(input.id, {
            fields: input.fields,
            status: input.status
          })
        })
      }
    ],
    [
      documentsDeleteRoute.name,
      async (rawInput) => {
        const input = documentsDeleteRoute.input.parse(rawInput)
        repository.deleteDocument(input.id)
        return documentsDeleteRoute.output.parse({ success: true })
      }
    ],
    [
      documentsStatsRoute.name,
      async (rawInput) => {
        const input = documentsStatsRoute.input.parse(rawInput)
        return documentsStatsRoute.output.parse({ stats: repository.statsByType(input) })
      }
    ],
    [
      documentsTasksCreateRoute.name,
      async (rawInput) => {
        const input = documentsTasksCreateRoute.input.parse(rawInput)
        const tasks = taskManager.submit({
          files: input.files,
          templateId: input.templateId,
          source: input.source
        })
        return documentsTasksCreateRoute.output.parse({ tasks })
      }
    ],
    [
      documentsTasksListRoute.name,
      async (rawInput) => {
        documentsTasksListRoute.input.parse(rawInput)
        return documentsTasksListRoute.output.parse({ tasks: repository.listRecentTasks() })
      }
    ],
    [
      documentTemplatesTestExtractRoute.name,
      async (rawInput) => {
        const input = documentTemplatesTestExtractRoute.input.parse(rawInput)
        const result = await extractor.extract({ templateId: input.templateId, file: input.file })
        return documentTemplatesTestExtractRoute.output.parse({
          fields: Object.entries(result.fields).map(([key, entry]) => ({
            key,
            value: entry.value,
            uncertain: entry.uncertain
          })),
          meta: {
            route: result.route,
            rawOutput: result.rawOutput,
            durationMs: result.durationMs,
            issues: result.issues
          }
        })
      }
    ],
    [
      documentsExtractAndDraftRoute.name,
      async (rawInput) => {
        const input = documentsExtractAndDraftRoute.input.parse(rawInput)
        const result = await extractor.extract({ templateId: input.templateId, file: input.file })
        const document = repository.insertDocument({
          templateId: result.template.id,
          typeKey: result.template.typeKey,
          templateSnapshot: result.template,
          fields: result.fields,
          fileUris: [input.file.path],
          source: input.source ?? 'manual',
          sessionId: input.sessionId ?? null,
          status: 'draft',
          now: Date.now()
        })
        return documentsExtractAndDraftRoute.output.parse({
          document,
          meta: {
            route: result.route,
            rawOutput: result.rawOutput,
            durationMs: result.durationMs,
            issues: result.issues
          }
        })
      }
    ],
    [
      documentsExportCsvRoute.name,
      async (rawInput) => {
        const input = documentsExportCsvRoute.input.parse(rawInput)
        const documents = repository.listDocuments({ ...input, limit: CSV_EXPORT_MAX_ROWS })
        const templateNameById = new Map(repository.listTemplates().map((t) => [t.id, t.name]))
        const templateFields = input.typeKey
          ? (repository.getTemplateByTypeKey(input.typeKey)?.fields ?? null)
          : null
        const csv = buildDocumentsCsv({ documents, templateFields, templateNameById })
        const date = new Date()
        const stamp = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0')
        ].join('')
        const { canceled, filePath } = await csvDeps.showSaveDialog({
          defaultPath: `documents-export-${stamp}.csv`,
          filters: [
            { name: 'CSV', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        if (canceled || !filePath) {
          return documentsExportCsvRoute.output.parse({ canceled: true })
        }
        await fsp.writeFile(filePath, csv, 'utf-8')
        return documentsExportCsvRoute.output.parse({ canceled: false, path: filePath })
      }
    ],
    [
      documentsPreviewFileRoute.name,
      async (rawInput) => {
        const input = documentsPreviewFileRoute.input.parse(rawInput)
        const document = repository.getDocument(input.documentId)
        const uri = document?.fileUris[input.uriIndex]
        if (!uri) {
          throw new Error(`File not found for document ${input.documentId}[${input.uriIndex}]`)
        }
        const mimeType = resolvePreviewMimeType(uri)
        const stat = await fsp.stat(uri)
        if (stat.size > PREVIEW_MAX_BYTES) {
          throw new Error('File too large to preview')
        }
        const data = await fsp.readFile(uri)
        return documentsPreviewFileRoute.output.parse({
          dataBase64: data.toString('base64'),
          mimeType,
          name: path.basename(uri)
        })
      }
    ]
  ])
}
