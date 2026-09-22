import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesTestExtractRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsExtractAndDraftRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DocumentExtractor } from './extractor/documentExtractor'
import type { DocumentsRepository } from './repository'

export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor
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
          documents: repository.listDocuments(input)
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
    ]
  ])
}
