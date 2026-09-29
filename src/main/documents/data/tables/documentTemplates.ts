import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface DocumentTemplateRow {
  id: string
  type_key: string
  name: string
  icon: string | null
  category: string
  fields_json: string
  extraction_mode: string
  prompt_preset: string | null
  is_builtin: number
  builtin_source_id: string | null
  version: number
  created_at: number
  updated_at: number
}

export interface DocumentTemplateTableUpsertInput {
  id?: string
  typeKey: string
  name: string
  icon?: string | null
  category: string
  fields: unknown[]
  extractionMode?: 'auto' | 'vision' | 'text'
  promptPreset?: string | null
  isBuiltin?: boolean
  builtinSourceId?: string | null
  now?: number
}

export class DocumentTemplatesTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'document_templates')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS document_templates (
        id TEXT PRIMARY KEY,
        type_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        icon TEXT,
        category TEXT NOT NULL DEFAULT '自定义',
        fields_json TEXT NOT NULL DEFAULT '[]',
        extraction_mode TEXT NOT NULL DEFAULT 'auto'
          CHECK(extraction_mode IN ('auto', 'vision', 'text')),
        prompt_preset TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK(is_builtin IN (0, 1)),
        builtin_source_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_templates_updated_at
        ON document_templates(updated_at DESC, id DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  list(): DocumentTemplateRow[] {
    return this.db
      .prepare('SELECT * FROM document_templates ORDER BY updated_at DESC, id DESC')
      .all() as DocumentTemplateRow[]
  }

  get(id: string): DocumentTemplateRow | undefined {
    return this.db.prepare('SELECT * FROM document_templates WHERE id = ?').get(id) as
      | DocumentTemplateRow
      | undefined
  }

  getByTypeKey(typeKey: string): DocumentTemplateRow | undefined {
    return this.db.prepare('SELECT * FROM document_templates WHERE type_key = ?').get(typeKey) as
      | DocumentTemplateRow
      | undefined
  }

  upsert(input: DocumentTemplateTableUpsertInput): DocumentTemplateRow {
    const now = input.now ?? Date.now()
    const existing = input.id ? this.get(input.id) : undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE document_templates SET
             name = ?, icon = ?, category = ?, fields_json = ?, extraction_mode = ?,
             prompt_preset = ?, is_builtin = ?, builtin_source_id = ?, version = version + 1,
             updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.icon ?? null,
          input.category,
          JSON.stringify(input.fields),
          input.extractionMode ?? 'auto',
          input.promptPreset ?? null,
          input.isBuiltin ? 1 : 0,
          input.builtinSourceId ?? null,
          now,
          existing.id
        )
      return this.get(existing.id)!
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO document_templates
           (id, type_key, name, icon, category, fields_json, extraction_mode,
            prompt_preset, is_builtin, builtin_source_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        input.typeKey,
        input.name,
        input.icon ?? null,
        input.category,
        JSON.stringify(input.fields),
        input.extractionMode ?? 'auto',
        input.promptPreset ?? null,
        input.isBuiltin ? 1 : 0,
        input.builtinSourceId ?? null,
        now,
        now
      )
    return this.get(id)!
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM document_templates WHERE id = ?').run(id)
  }
}
