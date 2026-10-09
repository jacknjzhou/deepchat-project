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
  documentsReimbursementExportRoute,
  documentsReimbursementGetConfigRoute,
  documentsReimbursementSetConfigRoute,
  documentsReimbursementSetOverrideRoute,
  documentsReimbursementTreeRoute,
  documentsStatsRoute,
  documentsTasksClearFailedRoute,
  documentsTasksCreateRoute,
  documentsTasksListRoute,
  documentsTasksRetryRoute,
  documentsUpsertRoute,
  type DeepchatRouteName
} from '@shared/contracts/routes'
import type { DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DocumentTemplate } from '@shared/documents'
import type { ReimbursementTreeResult } from '@/documents/reimbursement'
import { defaultReimbursementConfig } from '@/documents/reimbursementConfig'
import {
  exportReimbursementPackage,
  type ReimbursementExportDeps
} from '@/documents/reimbursementExport'
import { createDocumentsRoutes } from '@/documents/routes'
import { DocumentsRepository } from '@/documents/repository'
import { DocumentsDatabase } from '@/documents/data/database'
import { DocumentTasksTable } from '@/documents/data/tables/documentTasks'
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
      reimbursementOverride: null,
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

  it('documents.tasks.retry/clearFailed 契约解析', () => {
    expect(documentsTasksRetryRoute.input.parse({ id: 't1' }).id).toBe('t1')
    expect(
      documentsTasksRetryRoute.input.parse({ id: 't1', templateId: 'tpl-contract' }).templateId
    ).toBe('tpl-contract')
    expect(() => documentsTasksRetryRoute.input.parse({ id: '' })).toThrow()
    expect(documentsTasksRetryRoute.output.parse({ task: null }).task).toBeNull()
    expect(documentsTasksClearFailedRoute.output.parse({ removed: 3 }).removed).toBe(3)
    expect(() => documentsTasksClearFailedRoute.output.parse({ removed: -1 })).toThrow()
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

const fakeExtractor = { extract: vi.fn() } as never
const fakeTaskManager = { submit: vi.fn(), resumePending: vi.fn() } as never

function getRouteHandler(
  routes: DeepchatRouteMap,
  name: DeepchatRouteName
): (input: unknown) => Promise<unknown> {
  const handler = routes.get(name)
  if (!handler) {
    throw new Error(`missing route: ${name}`)
  }
  return handler as (input: unknown) => Promise<unknown>
}

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
    const routes = createDocumentsRoutes(repository, extractor as never, fakeTaskManager)
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
    const routes = createDocumentsRoutes(repository, extractor as never, fakeTaskManager)
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

  it('documents.extractAndDraft 带 documentId 时原位更新不新建', async () => {
    const repository = makeRepository()
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never, fakeTaskManager)
    const handler = routes.get('documents.extractAndDraft')
    expect(handler).toBeDefined()

    const created = await handler!({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'manual'
    })
    const existingId = (created as { document: { id: string } }).document.id

    const updated = await handler!({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'manual',
      documentId: existingId
    })
    const document = (updated as { document: { id: string; status: string } }).document
    expect(document.id).toBe(existingId)
    expect(document.status).toBe('draft')

    // Still exactly one archived document: re-recognize replaced it in place.
    expect(repository.listDocuments({})).toHaveLength(1)
  })

  it('documents.extractAndDraft 带未知 documentId 时报错', async () => {
    const repository = makeRepository()
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never, fakeTaskManager)
    const handler = routes.get('documents.extractAndDraft')
    expect(handler).toBeDefined()

    await expect(
      handler!({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.jpg' },
        source: 'manual',
        documentId: 'missing'
      })
    ).rejects.toThrow('Document not found: missing')
    expect(repository.listDocuments({})).toHaveLength(0)
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
      const routes = createDocumentsRoutes(
        repository,
        makeExtractorStub() as never,
        fakeTaskManager
      )
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
      const routes = createDocumentsRoutes(
        repository,
        makeExtractorStub() as never,
        fakeTaskManager,
        {
          showSaveDialog: async () => ({ canceled: false, filePath: targetPath })
        }
      )
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
    const routes = createDocumentsRoutes(
      repository,
      makeExtractorStub() as never,
      fakeTaskManager,
      {
        showSaveDialog: async () => ({ canceled: true })
      }
    )
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

describeIfSqlite('documents stats and tasks route handlers', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    new DocumentTasksTable(db).createTable()
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

  const validInsertInput = {
    templateId: template.id,
    typeKey: template.typeKey,
    templateSnapshot: template,
    fields: {},
    fileUris: [] as string[],
    source: 'manual' as const,
    sessionId: null,
    status: 'draft' as const,
    now: 1000
  }

  it('documents.list returns total from repository', async () => {
    const repository = makeRepository()
    repository.upsertTemplate(template)
    repository.insertDocument(validInsertInput)
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
    const handler = getRouteHandler(routes, documentsListRoute.name)
    const output = documentsListRoute.output.parse(await handler({ limit: 10 }))
    expect(output.total).toBe(1)
    expect(output.documents).toHaveLength(1)
  })

  it('documents.stats returns per-type counters', async () => {
    const repository = makeRepository()
    repository.upsertTemplate(template)
    repository.insertDocument(validInsertInput)
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
    const handler = getRouteHandler(routes, documentsStatsRoute.name)
    const output = documentsStatsRoute.output.parse(await handler({}))
    expect(output.stats).toEqual([
      { typeKey: validInsertInput.typeKey, total: 1, draft: 1, confirmed: 0 }
    ])
  })

  it('documents.tasks.create submits to task manager and returns tasks', async () => {
    const repository = makeRepository()
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
    const submit = vi.fn().mockReturnValue([task])
    const taskManager = { submit, resumePending: vi.fn() }
    const routes = createDocumentsRoutes(repository, fakeExtractor, taskManager as never)
    const handler = getRouteHandler(routes, documentsTasksCreateRoute.name)
    const output = documentsTasksCreateRoute.output.parse(
      await handler({ files: [{ path: 'C:\\a.png' }], templateId: 'auto' })
    )
    expect(output.tasks).toEqual([task])
    expect(submit).toHaveBeenCalledWith({
      files: [{ path: 'C:\\a.png' }],
      templateId: 'auto',
      source: 'manual'
    })
  })

  it('documents.tasks.list returns recent tasks from repository', async () => {
    const repository = makeRepository()
    repository.insertTasks([
      { batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' }
    ])
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
    const handler = getRouteHandler(routes, documentsTasksListRoute.name)
    const output = documentsTasksListRoute.output.parse(await handler({}))
    expect(output.tasks).toHaveLength(1)
    expect(output.tasks[0]).toMatchObject({ filePath: 'C:\\a.png', status: 'pending' })
  })

  it('documents.tasks.retry delegates to task manager and returns the task', async () => {
    const repository = makeRepository()
    const created = repository.insertTasks([
      { batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' }
    ])[0]
    expect(created).toBeDefined()
    if (!created) {
      throw new Error('task not created')
    }
    repository.updateTask(created.id, { status: 'failed', error: 'boom' })
    const retryTask = vi
      .fn()
      .mockReturnValue(repository.updateTask(created.id, { status: 'pending', error: null }))
    const taskManager = { submit: vi.fn(), resumePending: vi.fn(), retryTask }
    const routes = createDocumentsRoutes(repository, fakeExtractor, taskManager as never)
    const handler = getRouteHandler(routes, documentsTasksRetryRoute.name)
    const output = documentsTasksRetryRoute.output.parse(await handler({ id: created.id }))
    expect(output.task).toMatchObject({ id: created.id, status: 'pending', error: null })
    expect(retryTask).toHaveBeenCalledWith(created.id, undefined)
  })

  it('documents.tasks.retry forwards a manual template override to the task manager', async () => {
    const repository = makeRepository()
    const created = repository.insertTasks([
      { batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' }
    ])[0]
    expect(created).toBeDefined()
    if (!created) {
      throw new Error('task not created')
    }
    repository.updateTask(created.id, { status: 'failed', error: 'boom' })
    const retryTask = vi.fn().mockReturnValue(
      repository.updateTask(created.id, {
        status: 'pending',
        templateId: 'tpl-contract',
        error: null,
        typeKey: null
      })
    )
    const taskManager = { submit: vi.fn(), resumePending: vi.fn(), retryTask }
    const routes = createDocumentsRoutes(repository, fakeExtractor, taskManager as never)
    const handler = getRouteHandler(routes, documentsTasksRetryRoute.name)
    const output = documentsTasksRetryRoute.output.parse(
      await handler({ id: created.id, templateId: 'tpl-contract' })
    )
    expect(output.task).toMatchObject({ id: created.id, templateId: 'tpl-contract' })
    expect(retryTask).toHaveBeenCalledWith(created.id, { templateId: 'tpl-contract' })
  })

  it('documents.tasks.clearFailed removes only failed tasks', async () => {
    const repository = makeRepository()
    const inserted = repository.insertTasks([
      { batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' },
      { batchId: 'b1', filePath: 'C:\\b.png', fileName: 'b.png', templateId: 'auto' }
    ])
    const first = inserted[0]
    expect(first).toBeDefined()
    if (!first) {
      throw new Error('task not created')
    }
    repository.updateTask(first.id, { status: 'failed', error: 'boom' })
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
    const handler = getRouteHandler(routes, documentsTasksClearFailedRoute.name)
    const output = documentsTasksClearFailedRoute.output.parse(await handler({}))
    expect(output.removed).toBe(1)
    const remaining = documentsTasksListRoute.output.parse(
      await getRouteHandler(routes, documentsTasksListRoute.name)({})
    )
    expect(remaining.tasks).toHaveLength(1)
    expect(remaining.tasks[0]).toMatchObject({ filePath: 'C:\\b.png', status: 'pending' })
  })
})

describeIfSqlite('reimbursement routes', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return new DocumentsRepository(database)
  }

  const makeStore = () => {
    const map = new Map<string, unknown>()
    return {
      map,
      getSetting: <T>(key: string) => map.get(key) as T | undefined,
      setSetting: (key: string, value: unknown) => {
        map.set(key, value)
      }
    }
  }

  const template: DocumentTemplate = {
    id: 'tpl-meeting',
    typeKey: 'meeting_minutes',
    name: '会议纪要',
    icon: null,
    category: '会议类',
    fields: [],
    extractionMode: 'auto',
    promptPreset: null,
    isBuiltin: true,
    builtinSourceId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }

  const insertMeetingDocument = (
    repository: ReturnType<typeof makeRepository>,
    fileUris: string[] = []
  ) => {
    repository.upsertTemplate(template)
    return repository.insertDocument({
      templateId: template.id,
      typeKey: template.typeKey,
      templateSnapshot: template,
      fields: {},
      fileUris,
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
  }

  it('getConfig returns seeded defaults', async () => {
    const routes = createDocumentsRoutes(
      makeRepository(),
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore()
    )
    const handler = getRouteHandler(routes, documentsReimbursementGetConfigRoute.name)
    const output = documentsReimbursementGetConfigRoute.output.parse(await handler({}))
    expect(output.config.version).toBe(1)
    expect(output.config.categories.length).toBeGreaterThan(0)
  })

  it('setConfig persists and returns normalized config', async () => {
    const store = makeStore()
    const routes = createDocumentsRoutes(
      makeRepository(),
      fakeExtractor,
      fakeTaskManager,
      undefined,
      store
    )
    const handler = getRouteHandler(routes, documentsReimbursementSetConfigRoute.name)
    const config = defaultReimbursementConfig()
    const output = documentsReimbursementSetConfigRoute.output.parse(await handler({ config }))
    expect(output.config).toEqual(config)
    expect(store.map.get('documents.reimbursementConfig')).toEqual(config)
  })

  it('setOverride validates and updates document', async () => {
    const repository = makeRepository()
    const document = insertMeetingDocument(repository)
    const routes = createDocumentsRoutes(
      repository,
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore()
    )
    const handler = getRouteHandler(routes, documentsReimbursementSetOverrideRoute.name)
    const output = documentsReimbursementSetOverrideRoute.output.parse(
      await handler({ documentId: document.id, categoryId: 'cat-meeting' })
    )
    expect(output.document).not.toBeNull()
    expect(output.document?.reimbursementOverride).toBe('cat-meeting')
  })

  it('setOverride rejects unknown category id', async () => {
    const repository = makeRepository()
    const document = insertMeetingDocument(repository)
    const routes = createDocumentsRoutes(
      repository,
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore()
    )
    const handler = getRouteHandler(routes, documentsReimbursementSetOverrideRoute.name)
    await expect(handler({ documentId: document.id, categoryId: 'cat-gone' })).rejects.toThrow(
      'Unknown reimbursement category: cat-gone'
    )
  })

  it('tree returns category nodes with mapped documents', async () => {
    const repository = makeRepository()
    insertMeetingDocument(repository)
    const routes = createDocumentsRoutes(
      repository,
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore()
    )
    const handler = getRouteHandler(routes, documentsReimbursementTreeRoute.name)
    const output = documentsReimbursementTreeRoute.output.parse(await handler({}))
    const meeting = output.tree.find((node) => node.category.id === 'cat-meeting')
    expect(meeting?.total).toBe(1)
    expect(output.unassigned).toHaveLength(0)
  })

  it('export canceled returns canceled only', async () => {
    const routes = createDocumentsRoutes(
      makeRepository(),
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore(),
      { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
    )
    const handler = getRouteHandler(routes, documentsReimbursementExportRoute.name)
    expect(await handler({})).toEqual({ canceled: true })
  })

  it('export with missing files completes with zero copied files', async () => {
    const repository = makeRepository()
    insertMeetingDocument(repository, ['/nonexistent/a.jpg'])
    const routes = createDocumentsRoutes(
      repository,
      fakeExtractor,
      fakeTaskManager,
      undefined,
      makeStore(),
      { showOpenDialog: async () => ({ canceled: false, filePaths: [tmpdir()] }) }
    )
    const handler = getRouteHandler(routes, documentsReimbursementExportRoute.name)
    const output = documentsReimbursementExportRoute.output.parse(await handler({}))
    expect(output.canceled).toBe(false)
    expect(output.exportedFiles).toBe(0)
    expect(typeof output.path).toBe('string')
    await fs.rm(output.path as string, { recursive: true, force: true })
  })
})

describe('reimbursementExport', () => {
  const EXPORT_NOW = new Date('2026-01-02T03:04:00')

  const makeEntry = (person: string | null) => ({
    id: 'doc-1',
    typeKey: 'meeting_minutes',
    templateName: '会议纪要',
    person,
    period: '2026-09',
    amount: 120.5,
    amountUncertain: false,
    uncertainCount: 0,
    fileNames: ['a.jpg', 'b.jpg'],
    isOverride: false
  })

  const makeTreeResult = (person: string | null): ReimbursementTreeResult => ({
    tree: [
      {
        category: {
          id: 'cat-1',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          sortOrder: 1
        },
        total: 1,
        materials: [],
        groups: [{ person, buckets: [{ period: '2026-09', documents: [makeEntry(person)] }] }]
      }
    ],
    unassigned: [
      {
        person: null,
        buckets: [{ period: null, documents: [{ ...makeEntry(null), id: 'doc-2', fileNames: [] }] }]
      }
    ],
    summary: []
  })

  const makeHarness = (options?: { existsMatches?: (target: string) => boolean }) => {
    const mkdirs: string[] = []
    const copied: Array<{ src: string; dest: string }> = []
    const written: Array<{ file: string; data: string }> = []
    const deps: ReimbursementExportDeps = {
      copyFile: async (src, dest) => {
        copied.push({ src, dest })
      },
      mkdir: async (dir) => {
        mkdirs.push(dir)
        return undefined
      },
      writeFile: async (file, data) => {
        written.push({ file, data })
      },
      exists: async (target) => options?.existsMatches?.(target) ?? false
    }
    return { deps, mkdirs, copied, written }
  }

  type Harness = ReturnType<typeof makeHarness>

  const runExport = async (
    harness: Harness,
    result: ReimbursementTreeResult,
    filesById: Map<string, string[]>
  ) =>
    exportReimbursementPackage({
      rootDir: 'export-root',
      result,
      filesById,
      deps: harness.deps,
      now: EXPORT_NOW
    })

  const summaryCsv = (harness: Harness, summaryPath: string): string => {
    const entry = harness.written.find((item) => item.file === summaryPath)
    if (!entry) {
      throw new Error('summary csv not written')
    }
    return entry.data
  }

  it('copies mapped files and writes summary csv without issues', async () => {
    const harness = makeHarness()
    const output = await runExport(
      harness,
      makeTreeResult('张三'),
      new Map([['doc-1', ['/src/a.jpg', '/src/b.jpg']]])
    )
    expect(output.exportedFiles).toBe(2)
    expect(output.issues).toEqual([])
    expect(harness.copied.map((item) => item.src)).toEqual(['/src/a.jpg', '/src/b.jpg'])
    expect(harness.mkdirs[0]).toBe(output.path)
    const csv = summaryCsv(harness, output.summaryPath)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('类别,人员,期间,单据模板,文件名,金额,金额存疑,手动指定')
    expect(csv).toContain('会议费,张三,2026-09,会议纪要,a.jpg,120.5,否,否')
    expect(csv).toContain('会议费,张三,2026-09,会议纪要,b.jpg,120.5,否,否')
  })

  it('renames colliding file names with a -1 suffix', async () => {
    const harness = makeHarness({ existsMatches: (target) => target.endsWith('a.jpg') })
    const output = await runExport(
      harness,
      makeTreeResult('张三'),
      new Map([['doc-1', ['/src/a.jpg', '/src/b.jpg']]])
    )
    expect(output.exportedFiles).toBe(2)
    expect(harness.copied[0]?.dest.endsWith('a-1.jpg')).toBe(true)
    expect(harness.copied[1]?.dest.endsWith('b.jpg')).toBe(true)
  })

  it('sanitizes person directory segments against traversal and illegal chars', async () => {
    const harness = makeHarness()
    const result = makeTreeResult('..\\evil')
    const meetingNode = result.tree[0]
    if (meetingNode) {
      meetingNode.groups.push({
        person: 'a/b:c',
        buckets: [{ period: '2026-09', documents: [] }]
      })
    }
    const output = await runExport(
      harness,
      result,
      new Map([['doc-1', ['/src/a.jpg', '/src/b.jpg']]])
    )
    expect(output.issues).toEqual([])
    for (const dir of harness.mkdirs) {
      expect(dir).not.toContain('/')
      expect(dir).not.toContain(':')
      for (const segment of dir.split(/[\\/]/)) {
        expect(segment).not.toBe('..')
        expect(segment).not.toBe('.')
      }
    }
    const segments = harness.mkdirs.flatMap((dir) => dir.split(/[\\/]/))
    expect(segments).toContain('.._evil')
    expect(segments).toContain('a_b_c')
  })

  it('neutralizes formula-like csv cells with a single-quote prefix', async () => {
    const harness = makeHarness()
    const output = await runExport(
      harness,
      makeTreeResult('=cmd'),
      new Map([['doc-1', ['/src/a.jpg', '/src/b.jpg']]])
    )
    const csv = summaryCsv(harness, output.summaryPath)
    expect(csv).toContain("'=cmd")
    expect(csv).not.toMatch(/(^|,)=cmd/)
  })

  it('records missing sources without copying', async () => {
    const harness = makeHarness()
    const output = await runExport(harness, makeTreeResult('张三'), new Map())
    expect(output.exportedFiles).toBe(0)
    expect(output.issues).toEqual(['缺失:a.jpg', '缺失:b.jpg'])
    const csv = summaryCsv(harness, output.summaryPath)
    expect(csv).toContain('会议费,张三,2026-09,会议纪要,缺失:a.jpg,120.5,否,否')
  })
})
