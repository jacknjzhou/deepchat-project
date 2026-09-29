# 单据识别 P1（数据层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地单据识别功能的数据层：`document_templates` / `documents` 两张 SQLite 表、repository、10 类预置模板 seed、typed IPC 路由与渲染层 Client。

**Architecture:** 完全复用项目现有模式：`BaseTable` 表定义 + `schemaCatalog` 注册迁移 + `SchedulerDatabase` 式 Database 封装 + `defineRouteContract` zod 契约 + `createRouteMap` 主进程路由 + 渲染层 `createXxxClient(bridge)`。seed 数据源自 [preset_templates.json](../../specs/preset_templates.json)，复制为主进程资源，启动时按 `typeKey` 幂等补插。

**Tech Stack:** better-sqlite3-multiple-ciphers、zod、Vitest。Spec: [2026-09-22-document-recognition-design.md](../../specs/2026-09-22-document-recognition-design.md)

**P1 范围裁剪说明：** 契约 11 条中，`documentTemplates.testExtract`、`documents.extractAndDraft`、`documents.exportCsv` 依赖 P2 提取服务/文件导出，**不在本计划**；P1 交付 `documentTemplates.list/get/upsert/delete/fork` + `documents.list/get/upsert/delete` 共 9 条。偏离 spec 的一点：主键用 `randomUUID`（项目模式，见 `cronJobs.ts:1`），不用 nanoid。

**验证命令约定：** 测试用 `pnpm exec vitest run <file> --reporter=verbose`；收尾跑 `pnpm run typecheck` 与 `pnpm run lint`（以 package.json scripts 实名为准，先 `node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"` 确认）。

---

## File Structure（P1 全量）

```
src/shared/documents.ts                              [新建] 共享类型 + 常量（valueType/category/status/seed 映射表）
src/shared/contracts/routes/documents.routes.ts      [新建] 9 条 route 契约（zod）
src/shared/contracts/routes.ts                       [修改] barrel 导出新契约
src/main/documents/data/tables/documentTemplates.ts  [新建] 表定义（BaseTable）
src/main/documents/data/tables/documents.ts          [新建] 表定义（BaseTable）
src/main/documents/data/database.ts                  [新建] DocumentsDatabase（getter 两表）
src/main/documents/presetTemplates.json              [新建] seed 数据（自 docs 复制）
src/main/documents/seed.ts                           [新建] JSON→模板行映射 + 幂等 seed
src/main/documents/repository.ts                     [新建] DocumentsRepository（模板/档案 CRUD）
src/main/documents/routes.ts                         [新建] createDocumentsRoutes(deps)
src/main/data/schemaCatalog.ts                       [修改] 注册两张表
src/main/app/composition.ts                          [修改] 构造 DocumentsDatabase + seed + routeMaps 挂载
src/renderer/api/DocumentsClient.ts                  [新建] 渲染层 typed client
test/main/documents/documentsTables.test.ts          [新建] 表层测试（建表/upsert/seed 幂等）
test/main/documents/documentsRoutes.test.ts          [新建] 契约解析测试
test/renderer/api/documentsClient.test.ts            [新建] client 测试（mock bridge）
```

---

### Task 1: 共享类型与常量

**Files:**
- Create: `src/shared/documents.ts`

- [ ] **Step 1: 写类型文件**

```typescript
// src/shared/documents.ts
export const DOCUMENT_FIELD_VALUE_TYPES = ['text', 'number', 'date', 'array', 'enum'] as const
export type DocumentFieldValueType = (typeof DOCUMENT_FIELD_VALUE_TYPES)[number]

export const DOCUMENT_EXTRACTION_MODES = ['auto', 'vision', 'text'] as const
export type DocumentExtractionMode = (typeof DOCUMENT_EXTRACTION_MODES)[number]

export const DOCUMENT_TEMPLATE_CATEGORIES = [
  '合同类',
  '出行票据类',
  '采购类',
  '支付凭证类',
  '发票类',
  '自定义'
] as const
export type DocumentTemplateCategory = (typeof DOCUMENT_TEMPLATE_CATEGORIES)[number]

export const DOCUMENT_SOURCES = ['chat', 'manual'] as const
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number]

export const DOCUMENT_STATUSES = ['draft', 'confirmed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export interface DocumentTemplateField {
  key: string
  label: string
  valueType: DocumentFieldValueType
  required: boolean
  promptHint: string | null
  validation: string | null
  enumOptions: string[] | null
  order: number
}

export interface DocumentTemplate {
  id: string
  typeKey: string
  name: string
  icon: string | null
  category: DocumentTemplateCategory
  fields: DocumentTemplateField[]
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin: boolean
  builtinSourceId: string | null
  version: number
  createdAt: number
  updatedAt: number
}

export interface DocumentFieldEntry {
  value: unknown
  uncertain: boolean
}

export interface DocumentRecord {
  id: string
  templateId: string
  typeKey: string
  templateSnapshot: DocumentTemplate
  fields: Record<string, DocumentFieldEntry>
  fileUris: string[]
  source: DocumentSource
  sessionId: string | null
  status: DocumentStatus
  createdAt: number
  updatedAt: number
}

// seed JSON (docs/superpowers/specs/preset_templates.json) → 内部结构的映射表
export const PRESET_TEMPLATE_TYPE_KEY_MAP: Record<string, string> = {
  合同模板: 'contract',
  租赁合同模板: 'lease_contract',
  补充说明模板: 'contract_supplement',
  行程单模板: 'travel_itinerary',
  住宿单模板: 'hotel_receipt',
  餐饮流水单模板: 'catering_receipt',
  订购单模板: 'purchase_order',
  付款截图模板: 'payment_screenshot',
  增值税专用发票: 'invoice_special',
  普通发票: 'invoice_general'
}

export const SEED_VALUE_TYPE_MAP: Record<string, DocumentFieldValueType> = {
  string: 'text',
  number: 'number',
  date: 'date',
  array: 'array'
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm exec vue-tsc --noEmit -p tsconfig.json` 若项目 typecheck script 不同，先用 scripts 列表确认；预期无错误。

- [ ] **Step 3: Commit**

```bash
git add src/shared/documents.ts
git commit -m "feat(documents): add shared document types"
```

---

### Task 2: documentTemplates 表 + schemaCatalog 注册

**Files:**
- Create: `src/main/documents/data/tables/documentTemplates.ts`
- Modify: `src/main/data/schemaCatalog.ts`（import 区 + catalog 数组尾部）
- Test: `test/main/documents/documentsTables.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/documents/documentsTables.test.ts
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { DocumentTemplatesTable } from '@/documents/data/tables/documentTemplates'

const sqliteAvailable = (() => {
  try {
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
})()

const describeIfSqlite = sqliteAvailable ? describe : describe.skip

describeIfSqlite('DocumentTemplatesTable', () => {
  const makeDb = () => {
    const db = new Database(':memory:')
    new DocumentTemplatesTable(db).createTable()
    return db
  }

  it('creates table and upserts a template', () => {
    const db = makeDb()
    const table = new DocumentTemplatesTable(db)
    const row = table.upsert({
      typeKey: 'contract',
      name: '合同模板',
      category: '合同类',
      fields: [
        {
          key: 'party_a',
          label: '甲方名称',
          valueType: 'text',
          required: true,
          promptHint: '合同中甲方的全称',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ],
      now: 1000
    })
    expect(row.type_key).toBe('contract')
    expect(row.version).toBe(1)
    const fetched = table.getByTypeKey('contract')
    expect(fetched?.id).toBe(row.id)
    db.close()
  })

  it('bumps version on update and enforces unique typeKey', () => {
    const db = makeDb()
    const table = new DocumentTemplatesTable(db)
    const created = table.upsert({ typeKey: 'k1', name: 'N', category: '自定义', fields: [], now: 1 })
    const updated = table.upsert({
      id: created.id,
      typeKey: 'k1',
      name: 'N2',
      category: '自定义',
      fields: [],
      now: 2
    })
    expect(updated.version).toBe(2)
    expect(updated.updated_at).toBe(2)
    expect(() =>
      table.upsert({ typeKey: 'k1', name: 'X', category: '自定义', fields: [], now: 3 })
    ).toThrow()
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: FAIL（模块 `@/documents/data/tables/documentTemplates` 不存在）

- [ ] **Step 3: 实现表定义**

```typescript
// src/main/documents/data/tables/documentTemplates.ts
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
```

- [ ] **Step 4: schemaCatalog 注册**

在 `src/main/data/schemaCatalog.ts`：import 区（约 L39 `import { CronJobsTable } ...` 附近）加：

```typescript
import { DocumentTemplatesTable } from '@/documents/data/tables/documentTemplates'
```

catalog 数组尾部（L388 `live_delegation_events` 项之后、`]` 之前）加：

```typescript
  {
    name: 'document_templates',
    createTable: (db) => new DocumentTemplatesTable(db)
  },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: PASS（2 tests）

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/data/tables/documentTemplates.ts src/main/data/schemaCatalog.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): add document_templates table"
```

---

### Task 3: documents 表 + schemaCatalog 注册

**Files:**
- Create: `src/main/documents/data/tables/documents.ts`
- Modify: `src/main/data/schemaCatalog.ts`
- Test: `test/main/documents/documentsTables.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加到 test/main/documents/documentsTables.test.ts
import { DocumentsTable } from '@/documents/data/tables/documents'

describeIfSqlite('DocumentsTable', () => {
  const makeDb = () => {
    const db = new Database(':memory:')
    new DocumentTemplatesTable(db).createTable()
    new DocumentsTable(db).createTable()
    return db
  }

  it('inserts a draft record and confirms it', () => {
    const db = makeDb()
    const table = new DocumentsTable(db)
    const row = table.insert({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: { id: 'tpl-1', typeKey: 'contract' } as Record<string, unknown>,
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'],
      source: 'chat',
      sessionId: 's-1',
      status: 'draft',
      now: 10
    })
    expect(row.status).toBe('draft')
    const confirmed = table.updateFieldsAndStatus(row.id, {
      fields: { party_a: { value: '甲公司改', uncertain: false } },
      status: 'confirmed',
      now: 20
    })
    expect(confirmed?.status).toBe('confirmed')
    expect(confirmed?.updated_at).toBe(20)
    db.close()
  })

  it('lists with typeKey and status filters', () => {
    const db = makeDb()
    const table = new DocumentsTable(db)
    table.insert({
      templateId: 't1', typeKey: 'contract', templateSnapshot: {},
      fields: {}, fileUris: [], source: 'manual', sessionId: null, status: 'draft', now: 1
    })
    table.insert({
      templateId: 't2', typeKey: 'hotel_receipt', templateSnapshot: {},
      fields: {}, fileUris: [], source: 'manual', sessionId: null, status: 'confirmed', now: 2
    })
    expect(table.list({ typeKey: 'contract' })).toHaveLength(1)
    expect(table.list({ status: 'confirmed' })).toHaveLength(1)
    expect(table.list({})).toHaveLength(2)
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: FAIL（`documents` 模块不存在）

- [ ] **Step 3: 实现表定义**

```typescript
// src/main/documents/data/tables/documents.ts
import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface DocumentRow {
  id: string
  template_id: string
  type_key: string
  template_snapshot_json: string
  fields_json: string
  file_uris_json: string
  source: string
  session_id: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface DocumentTableInsertInput {
  templateId: string
  typeKey: string
  templateSnapshot: Record<string, unknown>
  fields: Record<string, unknown>
  fileUris: string[]
  source: 'chat' | 'manual'
  sessionId: string | null
  status: 'draft' | 'confirmed'
  now?: number
}

export interface DocumentTableUpdateInput {
  fields?: Record<string, unknown>
  status?: 'draft' | 'confirmed'
  now?: number
}

export interface DocumentListFilter {
  typeKey?: string
  status?: 'draft' | 'confirmed'
  keyword?: string
  limit?: number
  offset?: number
}

const LIST_DEFAULT_LIMIT = 100

export class DocumentsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'documents')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        type_key TEXT NOT NULL,
        template_snapshot_json TEXT NOT NULL DEFAULT '{}',
        fields_json TEXT NOT NULL DEFAULT '{}',
        file_uris_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL CHECK(source IN ('chat', 'manual')),
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_type_key_status
        ON documents(type_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at
        ON documents(updated_at DESC, id DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  list(filter: DocumentListFilter): DocumentRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.typeKey) {
      conditions.push('type_key = ?')
      params.push(filter.typeKey)
    }
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.keyword) {
      conditions.push("fields_json LIKE ? ESCAPE '\\'")
      params.push(`%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? LIST_DEFAULT_LIMIT
    const offset = filter.offset ?? 0
    return this.db
      .prepare(
        `SELECT * FROM documents ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as DocumentRow[]
  }

  get(id: string): DocumentRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentRow
      | undefined
  }

  insert(input: DocumentTableInsertInput): DocumentRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO documents
           (id, template_id, type_key, template_snapshot_json, fields_json,
            file_uris_json, source, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.templateId,
        input.typeKey,
        JSON.stringify(input.templateSnapshot),
        JSON.stringify(input.fields),
        JSON.stringify(input.fileUris),
        input.source,
        input.sessionId,
        input.status,
        now,
        now
      )
    return this.get(id)!
  }

  updateFieldsAndStatus(id: string, input: DocumentTableUpdateInput): DocumentRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    const fields = input.fields ? JSON.stringify(input.fields) : existing.fields_json
    const status = input.status ?? existing.status
    this.db
      .prepare(
        'UPDATE documents SET fields_json = ?, status = ?, updated_at = ? WHERE id = ?'
      )
      .run(fields, status, now, id)
    return this.get(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  countByTemplateId(templateId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM documents WHERE template_id = ?')
      .get(templateId) as { count: number }
    return row.count
  }
}
```

- [ ] **Step 4: schemaCatalog 注册**

import 区加：

```typescript
import { DocumentsTable } from '@/documents/data/tables/documents'
```

数组内 `document_templates` 项后加：

```typescript
  {
    name: 'documents',
    createTable: (db) => new DocumentsTable(db)
  },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: PASS（4 tests）

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/data/tables/documents.ts src/main/data/schemaCatalog.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): add documents archive table"
```

---

### Task 4: DocumentsDatabase + Repository

**Files:**
- Create: `src/main/documents/data/database.ts`
- Create: `src/main/documents/repository.ts`
- Test: `test/main/documents/documentsTables.test.ts`（追加 repository describe）

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加到 test/main/documents/documentsTables.test.ts
import { DocumentsDatabase } from '@/documents/data/database'
import { DocumentsRepository } from '@/documents/repository'

describeIfSqlite('DocumentsRepository', () => {
  const makeRepo = () => {
    const db = new Database(':memory:')
    new DocumentTemplatesTable(db).createTable()
    new DocumentsTable(db).createTable()
    const database = new DocumentsDatabase({ getDatabase: () => db })
    return { database, repo: new DocumentsRepository(database) }
  }

  it('upserts and lists templates with domain types', () => {
    const { repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'contract',
      name: '合同模板',
      category: '合同类',
      fields: [
        { key: 'party_a', label: '甲方名称', valueType: 'text', required: true, promptHint: '甲方全称', validation: null, enumOptions: null, order: 1 }
      ],
      now: 100
    })
    expect(tpl.isBuiltin).toBe(false)
    expect(tpl.fields[0].valueType).toBe('text')
    expect(repo.listTemplates()).toHaveLength(1)
    expect(repo.getTemplate(tpl.id)?.name).toBe('合同模板')
    expect(repo.getTemplateByTypeKey('contract')?.id).toBe(tpl.id)
  })

  it('deleteTemplate rejects builtin and reports archive references', () => {
    const { repo } = makeRepo()
    const tpl = repo.upsertTemplate({ typeKey: 'k', name: 'N', category: '自定义', fields: [], isBuiltin: true, now: 1 })
    expect(() => repo.deleteTemplate(tpl.id)).toThrow(/builtin/)
    const editable = repo.upsertTemplate({ typeKey: 'k2', name: 'N2', category: '自定义', fields: [], now: 1 })
    repo.insertDocument({
      templateId: editable.id, typeKey: 'k2', templateSnapshot: editable,
      fields: {}, fileUris: [], source: 'manual', sessionId: null, status: 'draft', now: 2
    })
    expect(repo.countDocumentsByTemplateId(editable.id)).toBe(1)
    repo.deleteTemplate(editable.id, { force: true })
    expect(repo.getTemplate(editable.id)).toBeNull()
  })

  it('inserts document with snapshot and updates to confirmed', () => {
    const { repo } = makeRepo()
    const tpl = repo.upsertTemplate({ typeKey: 'k3', name: 'N3', category: '自定义', fields: [], now: 1 })
    const doc = repo.insertDocument({
      templateId: tpl.id, typeKey: 'k3', templateSnapshot: tpl,
      fields: { f1: { value: 42, uncertain: true } },
      fileUris: ['deepchat-file://x.pdf'], source: 'chat', sessionId: 's1', status: 'draft', now: 5
    })
    expect(doc.templateSnapshot.id).toBe(tpl.id)
    expect(doc.fields.f1.uncertain).toBe(true)
    const updated = repo.updateDocument(doc.id, { status: 'confirmed', now: 9 })
    expect(updated?.status).toBe('confirmed')
    expect(repo.listDocuments({ typeKey: 'k3' })).toHaveLength(1)
    expect(repo.listDocuments({ keyword: '42' })).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: FAIL（`@/documents/data/database`、`@/documents/repository` 不存在）

- [ ] **Step 3: 实现 DocumentsDatabase**

```typescript
// src/main/documents/data/database.ts
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { DocumentTemplatesTable } from './tables/documentTemplates'
import { DocumentsTable } from './tables/documents'

export class DocumentsDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {}

  getDatabase() {
    return this.connection.getDatabase()
  }

  get documentTemplatesTable(): DocumentTemplatesTable {
    return new DocumentTemplatesTable(this.getDatabase())
  }

  get documentsTable(): DocumentsTable {
    return new DocumentsTable(this.getDatabase())
  }
}
```

- [ ] **Step 4: 实现 DocumentsRepository**

```typescript
// src/main/documents/repository.ts
import {
  type DocumentRecord,
  type DocumentTemplate,
  type DocumentTemplateCategory,
  type DocumentTemplateField
} from '@shared/documents'
import type { z } from 'zod'
import type { documentsTemplateUpsertInputSchema } from '@shared/contracts/routes/documents.routes'
import type { DocumentsDatabase } from './data/database'
import type { DocumentRow, DocumentTableInsertInput } from './data/tables/documents'
import type { DocumentTemplateRow, DocumentTemplateTableUpsertInput } from './data/tables/documentTemplates'

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
```

注意：`@/data/databaseConnection` 的 `DatabaseConnectionProvider` 接口真实形状需先打开 `src/main/data/databaseConnection.ts` 核对（SchedulerDatabase 用的是带 `getDatabasePath/getDatabasePassword` 的扩展接口；若 `DatabaseConnectionProvider` 仅含 `getDatabase` 则上面的实现即正确，否则补齐两个方法——测试里 mock 只给了 `getDatabase`，此时给 database.ts 的构造参数类型放宽为 `{ getDatabase(): Database.Database }` 本地接口即可）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: PASS（7 tests）

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/data/database.ts src/main/documents/repository.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): add documents database and repository"
```

---

### Task 5: 预置模板 seed

**Files:**
- Create: `src/main/documents/presetTemplates.json`（自 `docs/superpowers/specs/preset_templates.json` 复制）
- Create: `src/main/documents/seed.ts`
- Test: `test/main/documents/documentsTables.test.ts`（追加 seed describe）

- [ ] **Step 1: 追加失败测试**

```typescript
// 追加到 test/main/documents/documentsTables.test.ts
import { seedPresetTemplates } from '@/documents/seed'

describeIfSqlite('seedPresetTemplates', () => {
  it('seeds all 10 preset templates idempotently', () => {
    const db = new Database(':memory:')
    new DocumentTemplatesTable(db).createTable()
    const database = new DocumentsDatabase({ getDatabase: () => db })
    const count1 = seedPresetTemplates(database, { now: 100 })
    expect(count1).toBe(10)
    const templates = database.documentTemplatesTable.list()
    const typeKeys = templates.map((t) => t.type_key).sort()
    expect(typeKeys).toEqual([
      'catering_receipt', 'contract', 'contract_supplement', 'hotel_receipt',
      'invoice_general', 'invoice_special', 'lease_contract', 'payment_screenshot',
      'purchase_order', 'travel_itinerary'
    ].sort())
    const invoice = templates.find((t) => t.type_key === 'invoice_special')!
    const fields = JSON.parse(invoice.fields_json) as Array<{ key: string; valueType: string; order: number }>
    expect(fields[0]).toMatchObject({ key: 'invoice_code', valueType: 'text', order: 1 })
    expect(fields.find((f) => f.key === 'line_items')?.valueType).toBe('array')
    const lineItems = JSON.parse(invoice.fields_json).find((f: { key: string }) => f.key === 'line_items')
    expect(lineItems.required).toBe(false)
    expect(invoice.is_builtin).toBe(1)
    expect(invoice.category).toBe('发票类')

    const count2 = seedPresetTemplates(database, { now: 200 })
    expect(count2).toBe(0)
    expect(database.documentTemplatesTable.list().every((t) => t.created_at === 100)).toBe(true)
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: FAIL（`@/documents/seed` 不存在）

- [ ] **Step 3: 复制 seed JSON 并实现 seed**

复制 `docs/superpowers/specs/preset_templates.json` → `src/main/documents/presetTemplates.json`（内容不变）。

```typescript
// src/main/documents/seed.ts
import presetJson from './presetTemplates.json'
import {
  PRESET_TEMPLATE_TYPE_KEY_MAP,
  SEED_VALUE_TYPE_MAP,
  type DocumentTemplateCategory,
  type DocumentFieldValueType,
  type DocumentTemplateField
} from '@shared/documents'
import type { DocumentsDatabase } from './data/database'

interface SeedFieldRaw {
  key: string
  label: string
  type: string
  desc: string
  required?: boolean
}

interface SeedTemplateRaw {
  name: string
  category: string
  description: string
  fields: SeedFieldRaw[]
}

const toFields = (raw: SeedFieldRaw[]): DocumentTemplateField[] =>
  raw.map((field, index) => ({
    key: field.key,
    label: field.label,
    valueType: (SEED_VALUE_TYPE_MAP[field.type] ?? 'text') as DocumentFieldValueType,
    required: field.required ?? true,
    promptHint: field.desc,
    validation: null,
    enumOptions: null,
    order: index + 1
  }))

export function seedPresetTemplates(
  database: DocumentsDatabase,
  options: { now?: number } = {}
): number {
  const now = options.now ?? Date.now()
  let inserted = 0
  const templates = (presetJson as { templates: SeedTemplateRaw[] }).templates
  for (const template of templates) {
    const typeKey = PRESET_TEMPLATE_TYPE_KEY_MAP[template.name]
    if (!typeKey) {
      throw new Error(`Unmapped preset template name: ${template.name}`)
    }
    if (database.documentTemplatesTable.getByTypeKey(typeKey)) {
      continue
    }
    database.documentTemplatesTable.upsert({
      typeKey,
      name: template.name,
      category: template.category as DocumentTemplateCategory,
      fields: toFields(template.fields) as unknown[],
      isBuiltin: true,
      now
    })
    inserted += 1
  }
  return inserted
}
```

JSON import 需要 resolveJsonModule：打开 `tsconfig.node.json`（或主进程所用 tsconfig）核对 `resolveJsonModule: true`；若未开启则加上。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --reporter=verbose`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/presetTemplates.json src/main/documents/seed.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): add preset template seed"
```

---

### Task 6: typed IPC 路由契约

**Files:**
- Create: `src/shared/contracts/routes/documents.routes.ts`
- Modify: `src/shared/contracts/routes.ts`（barrel 导出）
- Test: `test/main/documents/documentsRoutes.test.ts`

- [ ] **Step 1: 写契约测试（失败）**

```typescript
// test/main/documents/documentsRoutes.test.ts
import { describe, expect, it } from 'vitest'
import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute
} from '@shared/contracts/routes'

describe('documents route contracts', () => {
  it('parses template list output', () => {
    const output = documentTemplatesListRoute.output.parse({ templates: [] })
    expect(output.templates).toEqual([])
  })

  it('parses template upsert input and output', () => {
    const input = documentTemplatesUpsertRoute.input.parse({
      typeKey: 'k1',
      name: '模板',
      category: '自定义',
      fields: [
        { key: 'f1', label: '字段1', valueType: 'text', required: true, promptHint: null, validation: null, enumOptions: null, order: 1 }
      ]
    })
    expect(input.typeKey).toBe('k1')
    expect(() =>
      documentTemplatesUpsertRoute.input.parse({
        typeKey: 'k2', name: 'X', category: '自定义',
        fields: [{ key: 'f1', label: '字段1', valueType: 'money', required: true, promptHint: null, validation: null, enumOptions: null, order: 1 }]
      })
    ).toThrow()
    const output = documentTemplatesUpsertRoute.output.parse({
      template: {
        id: 'id-1', typeKey: 'k1', name: '模板', icon: null, category: '自定义',
        fields: [], extractionMode: 'auto', promptPreset: null,
        isBuiltin: false, builtinSourceId: null, version: 1, createdAt: 1, updatedAt: 1
      }
    })
    expect(output.template.id).toBe('id-1')
  })

  it('parses document list input filters and record output', () => {
    const input = documentsListRoute.input.parse({
      typeKey: 'contract', status: 'draft', keyword: '甲', limit: 50, offset: 0
    })
    expect(input.limit).toBe(50)
    const record = {
      id: 'd1', templateId: 't1', typeKey: 'contract',
      templateSnapshot: {
        id: 't1', typeKey: 'contract', name: '合同模板', icon: null, category: '合同类',
        fields: [], extractionMode: 'auto' as const, promptPreset: null,
        isBuiltin: true, builtinSourceId: null, version: 1, createdAt: 1, updatedAt: 1
      },
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'], source: 'chat' as const, sessionId: 's1',
      status: 'draft' as const, createdAt: 1, updatedAt: 2
    }
    const output = documentsListRoute.output.parse({ documents: [record] })
    expect(output.documents[0].fields.party_a.value).toBe('甲公司')
  })

  it('exposes route names', () => {
    expect(documentTemplatesGetRoute.name).toBe('documentTemplates.get')
    expect(documentTemplatesForkRoute.name).toBe('documentTemplates.fork')
    expect(documentsGetRoute.name).toBe('documents.get')
    expect(documentsUpsertRoute.name).toBe('documents.upsert')
    expect(documentsDeleteRoute.name).toBe('documents.delete')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --reporter=verbose`
Expected: FAIL（`documents.routes` 导出不存在）

- [ ] **Step 3: 实现契约**

```typescript
// src/shared/contracts/routes/documents.routes.ts
import { z } from 'zod'
import { defineRouteContract } from '../common'
import {
  DOCUMENT_EXTRACTION_MODES,
  DOCUMENT_SOURCES,
  DOCUMENT_STATUSES,
  DOCUMENT_TEMPLATE_CATEGORIES,
  DOCUMENT_FIELD_VALUE_TYPES
} from '../../documents'

const timestampMsSchema = z.number().int().nonnegative()

export const documentFieldValueTypeSchema = z.enum(DOCUMENT_FIELD_VALUE_TYPES)
export const documentExtractionModeSchema = z.enum(DOCUMENT_EXTRACTION_MODES)
export const documentTemplateCategorySchema = z.string().min(1).max(32)
export const documentSourceSchema = z.enum(DOCUMENT_SOURCES)
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES)

export const documentTemplateFieldSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
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
  typeKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
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
  .omit({ id: true, createdAt: true, updatedAt: true, version: true, isBuiltin: true, builtinSourceId: true })
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
    typeKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
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
```

在 `src/shared/contracts/routes.ts` barrel 的 cronJobs 导出块（L363-367 附近）后追加：

```typescript
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute,
```

并确认该文件底部 `export * from './routes/documents.routes'` 或按现有逐项 re-export 风格保持一致（打开文件核对既有风格，照抄 cronJobs 的做法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --reporter=verbose`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): add typed IPC route contracts"
```

---

### Task 7: 主进程 routes + composition 挂载（含 seed 调用）

**Files:**
- Create: `src/main/documents/routes.ts`
- Modify: `src/main/app/composition.ts`（L889 附近构造 + L3050 routeMaps + seed 调用）

- [ ] **Step 1: 实现 routes**

```typescript
// src/main/documents/routes.ts
import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DocumentsRepository } from './repository'

export function createDocumentsRoutes(repository: DocumentsRepository): DeepchatRouteMap {
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
    ]
  ])
}
```

- [ ] **Step 2: composition.ts 挂载**

在 `src/main/app/composition.ts`：

1. import 区加：

```typescript
import { DocumentsDatabase } from '@/documents/data/database'
import { DocumentsRepository } from '@/documents/repository'
import { createDocumentsRoutes } from '@/documents/routes'
import { seedPresetTemplates } from '@/documents/seed'
```

2. L889 `const schedulerDatabase = new SchedulerDatabase(mainDatabase)` 之后加：

```typescript
  const documentsDatabase = new DocumentsDatabase(mainDatabase)
  seedPresetTemplates(documentsDatabase)
  const documentsRepository = new DocumentsRepository(documentsDatabase)
```

（`mainDatabase` 需满足 `DocumentsDatabase` 构造参数接口；`SchedulerDatabase` 同处用 `mainDatabase`，其连接 provider 形状一致。若 `DatabaseConnectionProvider` 形状不匹配，按 Task 4 Step 4 的核对结论处理。）

3. L3050 `routeMaps: [` 数组内 `schedulerRoutes,`（L3057）之后加：

```typescript
        documentsRoutes,
```

4. L2802 `const schedulerRoutes = createSchedulerRoutes(cronJobs)` 之后加：

```typescript
    const documentsRoutes = createDocumentsRoutes(documentsRepository)
```

（注意作用域：`documentsRepository` 定义于 L889 区块，`createDocumentsRoutes` 调用在 L2800+ 区块，两处须在同一函数作用域内可达；若不在，参考 `schedulerRoutes` 用 `cronJobs` 的方式——`cronJobs` 也定义于上方区块，说明同作用域可达。）

- [ ] **Step 3: 启动冒烟验证**

Run: `pnpm run dev`（后台启动，等 app 就绪后关闭）
Expected: 主进程无报错、无 schema 迁移错误。若 `mainDatabase` 尚未就绪导致 seed 时序问题，把 seed 移到数据库迁移完成后（对照 `schedulerDatabase` 首次使用的位置）。

- [ ] **Step 4: Commit**

```bash
git add src/main/documents/routes.ts src/main/app/composition.ts
git commit -m "feat(documents): register documents IPC routes"
```

---

### Task 8: 渲染层 DocumentsClient

**Files:**
- Create: `src/renderer/api/DocumentsClient.ts`
- Test: `test/renderer/api/documentsClient.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/renderer/api/documentsClient.test.ts
import type { DeepchatBridge } from '@shared/contracts/bridge'
import { createDocumentsClient } from '../../../src/renderer/api/DocumentsClient'

const template = {
  id: 'tpl-1', typeKey: 'contract', name: '合同模板', icon: null, category: '合同类',
  fields: [], extractionMode: 'auto' as const, promptPreset: null,
  isBuiltin: true, builtinSourceId: null, version: 1, createdAt: 1, updatedAt: 2
}

describe('DocumentsClient', () => {
  it('invokes documents routes through the bridge', async () => {
    const bridge: DeepchatBridge = {
      invoke: vi.fn(async (routeName: string, input: unknown) => {
        structuredClone(input)
        switch (routeName) {
          case 'documentTemplates.list':
            return { templates: [template] }
          case 'documentTemplates.get':
            return { template }
          case 'documents.list':
            return { documents: [] }
          case 'documents.get':
            return { document: null }
          default:
            throw new Error(`Unexpected route: ${routeName}`)
        }
      }),
      on: vi.fn(() => () => undefined)
    }
    const client = createDocumentsClient(bridge)

    expect(await client.listTemplates()).toEqual({ templates: [template] })
    expect(await client.getTemplate('tpl-1')).toEqual({ template })
    expect(await client.listDocuments({ typeKey: 'contract', status: 'draft' })).toEqual({
      documents: []
    })
    expect(await client.getDocument('d-1')).toEqual({ document: null })
    expect(bridge.invoke).toHaveBeenCalledWith('documentTemplates.list', {})
    expect(bridge.invoke).toHaveBeenCalledWith('documents.list', {
      typeKey: 'contract', status: 'draft'
    })
  })

  it('sends template upsert and fork inputs', async () => {
    const invoke = vi.fn(async () => ({ template }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    await client.upsertTemplate({
      typeKey: 'k1', name: 'N', category: '自定义', fields: []
    })
    expect(invoke).toHaveBeenCalledWith('documentTemplates.upsert', {
      typeKey: 'k1', name: 'N', category: '自定义', fields: []
    })
    await client.forkTemplate({ sourceId: 's1', typeKey: 'k2', name: 'F' })
    expect(invoke).toHaveBeenCalledWith('documentTemplates.fork', {
      sourceId: 's1', typeKey: 'k2', name: 'F'
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts --reporter=verbose`
Expected: FAIL（`DocumentsClient` 不存在）

- [ ] **Step 3: 实现 Client**

```typescript
// src/renderer/api/DocumentsClient.ts
import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute,
  documentsListInputSchema,
  documentsTemplateUpsertInputSchema,
  documentsUpsertInputSchema,
  type documentTemplatesForkRoute,
  type documentTemplatesUpsertRoute,
  type documentsUpsertRoute
} from '@shared/contracts/routes'
import type { z } from 'zod'
import { getDeepchatBridge } from './core'

export type DocumentsTemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>
export type DocumentsForkInput = z.input<typeof documentTemplatesForkRoute.input>
export type DocumentsUpdateInput = z.input<typeof documentsUpsertInputSchema>
export type DocumentsListInput = z.input<typeof documentsListInputSchema>

const invoke = async <T>(bridge: DeepchatBridge, name: string, input: unknown): Promise<T> =>
  (await bridge.invoke(name, structuredClone(input))) as T

export function createDocumentsClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  return {
    listTemplates: () =>
      invoke<z.output<typeof documentTemplatesListRoute.output>>(bridge, documentTemplatesListRoute.name, {}),
    getTemplate: (id: string) =>
      invoke<z.output<typeof documentTemplatesGetRoute.output>>(bridge, documentTemplatesGetRoute.name, { id }),
    upsertTemplate: (input: DocumentsTemplateUpsertInput) =>
      invoke<z.output<typeof documentTemplatesUpsertRoute.output>>(bridge, documentTemplatesUpsertRoute.name, input),
    deleteTemplate: (id: string, force?: boolean) =>
      invoke<z.output<typeof documentTemplatesDeleteRoute.output>>(bridge, documentTemplatesDeleteRoute.name, { id, force }),
    forkTemplate: (input: DocumentsForkInput) =>
      invoke<z.output<typeof documentTemplatesForkRoute.output>>(bridge, documentTemplatesForkRoute.name, input),
    listDocuments: (input: DocumentsListInput = {}) =>
      invoke<z.output<typeof documentsListRoute.output>>(bridge, documentsListRoute.name, input),
    getDocument: (id: string) =>
      invoke<z.output<typeof documentsGetRoute.output>>(bridge, documentsGetRoute.name, { id }),
    updateDocument: (input: DocumentsUpdateInput) =>
      invoke<z.output<typeof documentsUpsertRoute.output>>(bridge, documentsUpsertRoute.name, input),
    deleteDocument: (id: string) =>
      invoke<z.output<typeof documentsDeleteRoute.output>>(bridge, documentsDeleteRoute.name, { id })
  }
}
```

注意：`documentTemplatesUpsertRoute`/`documentsUpsertRoute` 的 input 已含校验逻辑在主进程；此处 import 的 `documentsListInputSchema` 等用于推导输入类型。若 `type documentTemplatesUpsertRoute` 形式不可用（route 是值不是类型），改用 `z.input<typeof documentTemplatesUpsertRoute.input>` 推导。`getDeepchatBridge` 的真实签名打开 `src/renderer/api/core.ts` 核对（CronJobsClient L22 `import { getDeepchatBridge } from './core'`，照抄用法；若它不是可选参数默认值形态，改为与 CronJobsClient 相同的构造方式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts --reporter=verbose`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/api/DocumentsClient.ts test/renderer/api/documentsClient.test.ts
git commit -m "feat(documents): add renderer documents client"
```

---

### Task 9: 收尾验证

- [ ] **Step 1: 全量相关测试**

```bash
pnpm exec vitest run test/main/documents test/renderer/api/documentsClient.test.ts --reporter=verbose
```
Expected: 全部 PASS

- [ ] **Step 2: typecheck + lint + format**

```bash
pnpm run typecheck
pnpm run lint
pnpm run format
```
（script 名以 package.json 为准，先列出 scripts 确认；出现既有无关失败则记录并在总结中说明。）

- [ ] **Step 3: 清理与最终提交**

确认无临时探针残留后：

```bash
git status --short
git add -A
git commit -m "chore(documents): finalize p1 data layer"
```

---

## Self-Review 记录

1. **Spec 覆盖**：P1 = 表×2 + repository + seed + typed IPC 路由（spec §5/§7/§12）。9 条路由落 Task 6/7；testExtract/extractAndDraft/exportCsv 属 P2/P4，已在范围说明中声明。渲染层 Client 属 P1 的 typed 边界收口（spec §7 "经 preload 桥接"），落 Task 8。
2. **占位符**：无 TBD/TODO；两处"打开文件核对"（databaseConnection 形状、getDeepchatBridge 签名、routes.ts barrel 风格）为显式核对指令并给出了两种处理分支，非占位符。
3. **类型一致性**：`DocumentsTemplateUpsertInput`（Task 4）= `z.input<documentsTemplateUpsertInputSchema>`（Task 6 导出）一致；`DocumentInsertInput.templateSnapshot: DocumentTemplate` 与表层 `Record<string, unknown>` 转换显式；seed 测试期望 typeKeys 与 Task 1 `PRESET_TEMPLATE_TYPE_KEY_MAP` 10 项一致。
