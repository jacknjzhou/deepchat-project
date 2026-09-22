import type { z } from 'zod'
import {
  type DocumentRecord,
  type DocumentTemplate,
  type DocumentTemplateCategory,
  type DocumentTemplateField
} from '@shared/documents'
import type { documentsTemplateUpsertInputSchema } from '@shared/contracts/routes/documents.routes'
import type { DocumentsDatabase } from './data/database'
import type { DocumentRow, DocumentTableInsertInput } from './data/tables/documents'
import type {
  DocumentTemplateRow,
  DocumentTemplateTableUpsertInput
} from './data/tables/documentTemplates'

export type DocumentsTemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema> & {
  now?: number
}

export interface DocumentInsertInput {
  templateId: string
  typeKey: string
  templateSnapshot: DocumentTemplate
  fields: Record<string, { value: unknown; uncertain: boolean }>
  fileUris: string[]
  source: 'chat' | 'manual'
  sessionId: string | null
  status: 'draft' | 'confirmed'
  now?: number
}

export interface DocumentUpdateInput {
  fields?: Record<string, { value: unknown; uncertain: boolean }>
  status?: 'draft' | 'confirmed'
  now?: number
}

const toTemplate = (row: DocumentTemplateRow): DocumentTemplate => ({
  id: row.id,
  typeKey: row.type_key,
  name: row.name,
  icon: row.icon,
  category: row.category as DocumentTemplateCategory,
  fields: JSON.parse(row.fields_json) as DocumentTemplateField[],
  extractionMode: row.extraction_mode as DocumentTemplate['extractionMode'],
  promptPreset: row.prompt_preset,
  isBuiltin: row.is_builtin === 1,
  builtinSourceId: row.builtin_source_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toRecord = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  templateId: row.template_id,
  typeKey: row.type_key,
  templateSnapshot: JSON.parse(row.template_snapshot_json) as DocumentTemplate,
  fields: JSON.parse(row.fields_json) as Record<string, { value: unknown; uncertain: boolean }>,
  fileUris: JSON.parse(row.file_uris_json) as string[],
  source: row.source as DocumentRecord['source'],
  sessionId: row.session_id,
  status: row.status as DocumentRecord['status'],
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export class DocumentsRepository {
  constructor(private readonly database: DocumentsDatabase) {}

  listTemplates(): DocumentTemplate[] {
    return this.database.documentTemplatesTable.list().map(toTemplate)
  }

  getTemplate(id: string): DocumentTemplate | null {
    const row = this.database.documentTemplatesTable.get(id)
    return row ? toTemplate(row) : null
  }

  getTemplateByTypeKey(typeKey: string): DocumentTemplate | null {
    const row = this.database.documentTemplatesTable.getByTypeKey(typeKey)
    return row ? toTemplate(row) : null
  }

  upsertTemplate(input: DocumentsTemplateUpsertInput): DocumentTemplate {
    const tableInput: DocumentTemplateTableUpsertInput = {
      id: input.id,
      typeKey: input.typeKey,
      name: input.name,
      icon: input.icon ?? null,
      category: input.category,
      fields: input.fields as unknown[],
      extractionMode: input.extractionMode,
      promptPreset: input.promptPreset ?? null,
      isBuiltin: input.isBuiltin ?? false,
      builtinSourceId: input.builtinSourceId ?? null,
      now: input.now
    }
    return toTemplate(this.database.documentTemplatesTable.upsert(tableInput))
  }

  deleteTemplate(id: string, options?: { force?: boolean }): void {
    const row = this.database.documentTemplatesTable.get(id)
    if (!row) return
    if (row.is_builtin === 1) {
      throw new Error('Cannot delete a builtin template')
    }
    const references = this.database.documentsTable.countByTemplateId(id)
    if (references > 0 && !options?.force) {
      throw new Error(`Template has ${references} archived document(s); pass force to confirm`)
    }
    this.database.documentTemplatesTable.delete(id)
  }

  forkTemplate(sourceId: string, typeKey: string, name: string, now?: number): DocumentTemplate {
    const source = this.getTemplate(sourceId)
    if (!source) {
      throw new Error(`Unknown source template: ${sourceId}`)
    }
    if (this.getTemplateByTypeKey(typeKey)) {
      throw new Error(`typeKey already exists: ${typeKey}`)
    }
    return this.upsertTemplate({
      typeKey,
      name,
      icon: source.icon,
      category: '自定义',
      fields: source.fields,
      extractionMode: source.extractionMode,
      promptPreset: source.promptPreset,
      isBuiltin: false,
      builtinSourceId: source.id,
      now
    })
  }

  listDocuments(filter: {
    typeKey?: string
    status?: 'draft' | 'confirmed'
    keyword?: string
    limit?: number
    offset?: number
  }): DocumentRecord[] {
    return this.database.documentsTable.list(filter).map(toRecord)
  }

  getDocument(id: string): DocumentRecord | null {
    const row = this.database.documentsTable.get(id)
    return row ? toRecord(row) : null
  }

  insertDocument(input: DocumentInsertInput): DocumentRecord {
    const tableInput: DocumentTableInsertInput = {
      templateId: input.templateId,
      typeKey: input.typeKey,
      templateSnapshot: input.templateSnapshot as unknown as Record<string, unknown>,
      fields: input.fields as Record<string, unknown>,
      fileUris: input.fileUris,
      source: input.source,
      sessionId: input.sessionId,
      status: input.status,
      now: input.now
    }
    return toRecord(this.database.documentsTable.insert(tableInput))
  }

  updateDocument(id: string, input: DocumentUpdateInput): DocumentRecord | null {
    const row = this.database.documentsTable.updateFieldsAndStatus(id, {
      fields: input.fields as Record<string, unknown> | undefined,
      status: input.status,
      now: input.now
    })
    return row ? toRecord(row) : null
  }

  deleteDocument(id: string): void {
    this.database.documentsTable.delete(id)
  }

  countDocumentsByTemplateId(templateId: string): number {
    return this.database.documentsTable.countByTemplateId(templateId)
  }
}
