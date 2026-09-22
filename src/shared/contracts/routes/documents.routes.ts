import { z } from 'zod'
import { defineRouteContract } from '../common'
import {
  DOCUMENT_EXTRACTION_MODES,
  DOCUMENT_SOURCES,
  DOCUMENT_STATUSES,
  DOCUMENT_FIELD_VALUE_TYPES
} from '../../documents'

const timestampMsSchema = z.number().int().nonnegative()

export const documentFieldValueTypeSchema = z.enum(DOCUMENT_FIELD_VALUE_TYPES)
export const documentExtractionModeSchema = z.enum(DOCUMENT_EXTRACTION_MODES)
export const documentTemplateCategorySchema = z.string().min(1).max(32)
export const documentSourceSchema = z.enum(DOCUMENT_SOURCES)
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES)

export const documentTemplateFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().min(1).max(100),
  valueType: documentFieldValueTypeSchema,
  required: z.boolean(),
  promptHint: z.string().max(500).nullable(),
  validation: z.string().max(200).nullable(),
  enumOptions: z.array(z.string().max(100)).nullable(),
  order: z.number().int().positive()
})

export const documentTemplateSchema = z.object({
  id: z.string().min(1),
  typeKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(100),
  icon: z.string().max(64).nullable(),
  category: documentTemplateCategorySchema,
  fields: z.array(documentTemplateFieldSchema),
  extractionMode: documentExtractionModeSchema,
  promptPreset: z.string().max(2000).nullable(),
  isBuiltin: z.boolean(),
  builtinSourceId: z.string().min(1).nullable(),
  version: z.number().int().positive(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

const templateUpsertBaseSchema = documentTemplateSchema
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    version: true,
    isBuiltin: true,
    builtinSourceId: true
  })
  .extend({
    id: z.string().min(1).optional(),
    icon: z.string().max(64).nullable().optional(),
    extractionMode: documentExtractionModeSchema.optional(),
    promptPreset: z.string().max(2000).nullable().optional(),
    isBuiltin: z.boolean().optional(),
    builtinSourceId: z.string().min(1).nullable().optional()
  })

export const documentsTemplateUpsertInputSchema = templateUpsertBaseSchema

export const documentFieldEntrySchema = z.object({
  value: z.unknown(),
  uncertain: z.boolean()
})

export const documentRecordSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  typeKey: z.string().min(1),
  templateSnapshot: documentTemplateSchema,
  fields: z.record(z.string(), documentFieldEntrySchema),
  fileUris: z.array(z.string()),
  source: documentSourceSchema,
  sessionId: z.string().min(1).nullable(),
  status: documentStatusSchema,
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const documentsListInputSchema = z.object({
  typeKey: z.string().min(1).optional(),
  status: documentStatusSchema.optional(),
  keyword: z.string().max(200).optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional()
})

export const documentsUpsertInputSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), documentFieldEntrySchema).optional(),
  status: documentStatusSchema.optional()
})

export const documentTemplatesListRoute = defineRouteContract({
  name: 'documentTemplates.list',
  input: z.object({}),
  output: z.object({ templates: z.array(documentTemplateSchema) })
})

export const documentTemplatesGetRoute = defineRouteContract({
  name: 'documentTemplates.get',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ template: documentTemplateSchema.nullable() })
})

export const documentTemplatesUpsertRoute = defineRouteContract({
  name: 'documentTemplates.upsert',
  input: documentsTemplateUpsertInputSchema,
  output: z.object({ template: documentTemplateSchema })
})

export const documentTemplatesDeleteRoute = defineRouteContract({
  name: 'documentTemplates.delete',
  input: z.object({ id: z.string().min(1), force: z.boolean().optional() }),
  output: z.object({ success: z.literal(true) })
})

export const documentTemplatesForkRoute = defineRouteContract({
  name: 'documentTemplates.fork',
  input: z.object({
    sourceId: z.string().min(1),
    typeKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(100)
  }),
  output: z.object({ template: documentTemplateSchema })
})

export const documentsListRoute = defineRouteContract({
  name: 'documents.list',
  input: documentsListInputSchema,
  output: z.object({ documents: z.array(documentRecordSchema) })
})

export const documentsGetRoute = defineRouteContract({
  name: 'documents.get',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ document: documentRecordSchema.nullable() })
})

export const documentsUpsertRoute = defineRouteContract({
  name: 'documents.upsert',
  input: documentsUpsertInputSchema,
  output: z.object({ document: documentRecordSchema.nullable() })
})

export const documentsDeleteRoute = defineRouteContract({
  name: 'documents.delete',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ success: z.literal(true) })
})
