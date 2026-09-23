import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
import type { DocumentTemplate } from '@shared/documents'
import { createDocumentsRoutes } from '@/documents/routes'
import { DocumentsRepository } from '@/documents/repository'
import { DocumentsDatabase } from '@/documents/data/database'
import { DocumentTemplatesTable } from '@/documents/data/tables/documentTemplates'
import { DocumentsTable } from '@/documents/data/tables/documents'

// export/preview handlers touch the real file system; undo the global fs/path mocks
vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)

let sqliteAvailable = false
if (sqliteModule) {
  try {
    const smokeDb = new sqliteModule.default(':memory:')
    smokeDb.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const describeIfSqlite = sqliteAvailable ? describe : describe.skip

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
        {
          key: 'f1',
          label: '字段1',
          valueType: 'text',
          required: true,
          promptHint: null,
          validation: null,
          enumOptions: null,
          order: 1
        }
      ]
    })
    expect(input.typeKey).toBe('k1')
    expect(() =>
      documentTemplatesUpsertRoute.input.parse({
        typeKey: 'k2',
        name: 'X',
        category: '自定义',
        fields: [
          {
            key: 'f1',
            label: '字段1',
            valueType: 'money',
            required: true,
            promptHint: null,
            validation: null,
            enumOptions: null,
            order: 1
          }
        ]
      })
    ).toThrow()
    const output = documentTemplatesUpsertRoute.output.parse({
      template: {
        id: 'id-1',
        typeKey: 'k1',
        name: '模板',
        icon: null,
        category: '自定义',
        fields: [],
        extractionMode: 'auto',
        promptPreset: null,
        isBuiltin: false,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      }
    })
    expect(output.template.id).toBe('id-1')
  })

  it('parses document list input filters and record output', () => {
    const input = documentsListRoute.input.parse({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      limit: 50,
      offset: 0
    })
    expect(input.limit).toBe(50)
    const record = {
      id: 'd1',
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {
        id: 't1',
        typeKey: 'contract',
        name: '合同模板',
        icon: null,
        category: '合同类',
        fields: [],
        extractionMode: 'auto' as const,
        promptPreset: null,
        isBuiltin: true,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      },
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'],
      source: 'chat' as const,
      sessionId: 's1',
      status: 'draft' as const,
      createdAt: 1,
      updatedAt: 2
    }
    const output = documentsListRoute.output.parse({ documents: [record], total: 1 })
    expect(output.documents[0].fields.party_a.value).toBe('甲公司')
  })

  it('exposes route names', () => {
    expect(documentTemplatesGetRoute.name).toBe('documentTemplates.get')
    expect(documentTemplatesForkRoute.name).toBe('documentTemplates.fork')
    expect(documentsGetRoute.name).toBe('documents.get')
    expect(documentsUpsertRoute.name).toBe('documents.upsert')
    expect(documentsDeleteRoute.name).toBe('documents.delete')
  })

  it('documents.list 输入接受 dateFrom/dateTo', () => {
    const input = documentsListRoute.input.parse({
      typeKey: 'invoice_special',
      dateFrom: 1000,
      dateTo: 2000
    })
    expect(input.dateFrom).toBe(1000)
    expect(input.dateTo).toBe(2000)
    expect(() => documentsListRoute.input.parse({ dateFrom: -1 })).toThrow()
    expect(() => documentsListRoute.input.parse({ dateFrom: 1.5 })).toThrow()
  })

  it('documents.exportCsv 契约解析筛选输入与取消输出', () => {
    const input = documentsExportCsvRoute.input.parse({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      dateFrom: 1000,
      dateTo: 2000
    })
    expect(input.typeKey).toBe('contract')
    expect(documentsExportCsvRoute.output.parse({ canceled: true }).path).toBeUndefined()
    expect(
      documentsExportCsvRoute.output.parse({ canceled: false, path: 'C:\\out\\a.csv' }).path
    ).toBe('C:\\out\\a.csv')
    expect(() => documentsExportCsvRoute.output.parse({ canceled: false })).toThrow()
  })

  it('documents.previewFile 契约解析定位输入与 base64 输出', () => {
    const input = documentsPreviewFileRoute.input.parse({ documentId: 'd1', uriIndex: 0 })
    expect(input.uriIndex).toBe(0)
    expect(() =>
      documentsPreviewFileRoute.input.parse({ documentId: 'd1', uriIndex: -1 })
    ).toThrow()
    const output = documentsPreviewFileRoute.output.parse({
      dataBase64: 'aGk=',
      mimeType: 'image/png',
      name: 'a.png'
    })
    expect(output.mimeType).toBe('image/png')
  })

  it('documents.list output requires total', () => {
    expect(() => documentsListRoute.output.parse({ documents: [] })).toThrow()
    const output = documentsListRoute.output.parse({ documents: [], total: 0 })
    expect(output.total).toBe(0)
  })

  it('documents.stats parses per-type counters', () => {
    const output = documentsStatsRoute.output.parse({
      stats: [{ typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }]
    })
    expect(output.stats[0]?.draft).toBe(2)
  })

  it('documents.tasks.create accepts files and auto template', () => {
    const input = documentsTasksCreateRoute.input.parse({
      files: [{ path: 'C:\\a.png' }, { path: 'C:\\b.pdf' }],
      templateId: 'auto'
    })
    expect(input.files).toHaveLength(2)
    expect(input.source).toBe('manual')
    // 上限 20
    expect(() =>
      documentsTasksCreateRoute.input.parse({
        files: Array.from({ length: 21 }, (_, i) => ({ path: `C:\\f${i}.png` })),
        templateId: 'auto'
      })
    ).toThrow()
  })

  it('documents.tasks.create/list output parses task rows', () => {
    const task = {
      id: 't1',
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto',
      status: 'pending',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1
    }
    expect(documentsTasksCreateRoute.output.parse({ tasks: [task] }).tasks).toHaveLength(1)
    expect(documentsTasksListRoute.output.parse({ tasks: [] }).tasks).toEqual([])
  })

  it('documents.task.updated event payload parses', async () => {
    const { documentsTaskUpdatedEvent } = await import('@shared/contracts/events')
    const payload = {
      id: 't1',
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto',
      status: 'running',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      doneCount: 0,
      totalCount: 1,
      version: 1
    }
    expect(documentsTaskUpdatedEvent.payload.parse(payload)).toMatchObject({ status: 'running' })
  })
})

describe('documents extraction route contracts', () => {
  it('testExtract 契约解析合法输入', () => {
    const input = documentTemplatesTestExtractRoute.input.parse({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(input.templateId).toBe('tpl-1')

    const output = documentTemplatesTestExtractRoute.output.parse({
      fields: [{ key: 'invoice_code', value: '123', uncertain: false }],
      meta: { route: 'vision', rawOutput: '{}', durationMs: 12, issues: [] }
    })
    expect(output.fields[0]?.key).toBe('invoice_code')
  })

  it('testExtract 契约拒绝空 file.path', () => {
    expect(() =>
      documentTemplatesTestExtractRoute.input.parse({
        templateId: 'tpl-1',
        file: { path: '' }
      })
    ).toThrow()
  })

  it('extractAndDraft 契约解析合法输入并默认 source', () => {
    const input = documentsExtractAndDraftRoute.input.parse({
      templateId: 'auto',
      file: { path: '/tmp/a.pdf' }
    })
    expect(input.source).toBe('manual')
  })
})

const DatabaseCtor = sqliteModule?.default
const DocumentTemplatesTableCtor = DocumentTemplatesTable
const DocumentsTableCtor = DocumentsTable
const DocumentsDatabaseCtor = DocumentsDatabase

describeIfSqlite('documents extraction handlers', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return new DocumentsRepository(database)
  }

  const makeExtractorStub = () => ({
    extract: vi.fn(async () => ({
      template: {
        id: 'tpl-1',
        typeKey: 'invoice_special',
        name: '增值税专用发票',
        icon: null,
        category: '发票类',
        fields: [],
        extractionMode: 'auto',
        promptPreset: null,
        isBuiltin: true,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      },
      route: 'vision',
      fields: { invoice_code: { value: '123456789012', uncertain: false } },
      rawOutput: '{"fields":{}}',
      durationMs: 42,
      issues: []
    }))
  })

  it('documentTemplates.testExtract 返回字段数组与元信息', async () => {
    const repository = makeRepository()
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never)
    const handler = routes.get('documentTemplates.testExtract')
    expect(handler).toBeDefined()

    const result = await handler!({ templateId: 'tpl-1', file: { path: '/tmp/a.jpg' } })
    expect(result.fields[0]).toEqual({
      key: 'invoice_code',
      value: '123456789012',
      uncertain: false
    })
    expect(result.meta.route).toBe('vision')
    expect(result.meta.durationMs).toBe(42)
  })

  it('documents.extractAndDraft 入库 draft 档案', async () => {
    const repository = makeRepository()
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never)
    const handler = routes.get('documents.extractAndDraft')
    expect(handler).toBeDefined()

    const result = await handler!({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'manual'
    })
    expect(result.document.status).toBe('draft')
    expect(result.document.typeKey).toBe('invoice_special')
    expect(result.document.fileUris).toEqual(['/tmp/a.jpg'])
    expect(result.document.fields.invoice_code).toEqual({
      value: '123456789012',
      uncertain: false
    })

    const listed = repository.listDocuments({ typeKey: 'invoice_special' })
    expect(listed.length).toBe(1)
  })
})

describeIfSqlite('documents export and preview handlers', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return new DocumentsRepository(database)
  }

  const makeExtractorStub = () => ({
    extract: vi.fn()
  })

  const template: DocumentTemplate = {
    id: 'tpl-1',
    typeKey: 'contract',
    name: '合同模板',
    icon: null,
    category: '合同类',
    fields: [
      {
        key: 'buyer',
        label: '买方',
        valueType: 'text',
        required: false,
        promptHint: null,
        validation: null,
        enumOptions: null,
        order: 1
      }
    ],
    extractionMode: 'auto',
    promptPreset: null,
    isBuiltin: true,
    builtinSourceId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }

  it('previewFile 返回 base64 与 mime；越界/类型不符报错', async () => {
    const repository = makeRepository()
    const dir = await fs.mkdtemp(join(tmpdir(), 'documents-preview-'))
    try {
      const pngPath = join(dir, 'a.png')
      const textPath = join(dir, 'b.txt')
      await fs.writeFile(pngPath, Buffer.from(PNG_BASE64, 'base64'))
      await fs.writeFile(textPath, 'plain text')
      repository.upsertTemplate(template)
      const document = repository.insertDocument({
        templateId: template.id,
        typeKey: template.typeKey,
        templateSnapshot: template,
        fields: {},
        fileUris: [pngPath, textPath],
        source: 'manual',
        sessionId: null,
        status: 'draft',
        now: 1000
      })
      const routes = createDocumentsRoutes(repository, makeExtractorStub() as never)
      const handler = routes.get('documents.previewFile')
      expect(handler).toBeDefined()

      const preview = await handler!({ documentId: document.id, uriIndex: 0 })
      expect(preview.mimeType).toBe('image/png')
      expect(preview.name).toBe('a.png')
      expect(preview.dataBase64.length).toBeGreaterThan(0)
      await expect(handler!({ documentId: document.id, uriIndex: 5 })).rejects.toThrow()
      await expect(handler!({ documentId: document.id, uriIndex: 1 })).rejects.toThrow(
        'Unsupported preview type'
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('exportCsv 写入用户选择的路径', async () => {
    const repository = makeRepository()
    const dir = await fs.mkdtemp(join(tmpdir(), 'documents-export-'))
    try {
      const targetPath = join(dir, 'out.csv')
      repository.upsertTemplate(template)
      repository.insertDocument({
        templateId: template.id,
        typeKey: template.typeKey,
        templateSnapshot: template,
        fields: { buyer: { value: '甲,公司', uncertain: false } },
        fileUris: [],
        source: 'manual',
        sessionId: null,
        status: 'draft',
        now: 1000
      })
      const routes = createDocumentsRoutes(repository, makeExtractorStub() as never, {
        showSaveDialog: async () => ({ canceled: false, filePath: targetPath })
      })
      const handler = routes.get('documents.exportCsv')
      expect(handler).toBeDefined()

      const result = await handler!({ typeKey: 'contract' })
      expect(result).toEqual({ canceled: false, path: targetPath })
      const content = await fs.readFile(targetPath, 'utf-8')
      expect(content.startsWith(String.fromCharCode(0xfeff))).toBe(true)
      expect(content).toContain('"甲,公司"')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('exportCsv 用户取消时返回 canceled', async () => {
    const repository = makeRepository()
    const routes = createDocumentsRoutes(repository, makeExtractorStub() as never, {
      showSaveDialog: async () => ({ canceled: true })
    })
    const handler = routes.get('documents.exportCsv')
    expect(handler).toBeDefined()

    expect(await handler!({})).toEqual({ canceled: true })
  })
})

describeIfSqlite('documents list date filter', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return new DocumentsRepository(database)
  }

  const template: DocumentTemplate = {
    id: 'tpl-1',
    typeKey: 'contract',
    name: '合同模板',
    icon: null,
    category: '合同类',
    fields: [],
    extractionMode: 'auto',
    promptPreset: null,
    isBuiltin: true,
    builtinSourceId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }

  it('按 createdAt 日期范围筛选', () => {
    const repository = makeRepository()
    repository.upsertTemplate({ ...template })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 3000
    })
    expect(repository.listDocuments({ dateFrom: 1000, dateTo: 2000 })).toHaveLength(1)
    expect(repository.listDocuments({ dateFrom: 5000 })).toHaveLength(0)
    expect(repository.listDocuments({ dateTo: 5000 })).toHaveLength(2)
  })
})
