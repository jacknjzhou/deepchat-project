import type { DeepchatBridge } from '@shared/contracts/bridge'
import { createDocumentsClient } from '../../../src/renderer/api/DocumentsClient'

const template = {
  id: 'tpl-1',
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
  updatedAt: 2
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
      typeKey: 'contract',
      status: 'draft'
    })
  })

  it('sends template upsert and fork inputs', async () => {
    const invoke = vi.fn(async () => ({ template }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    await client.upsertTemplate({
      typeKey: 'k1',
      name: 'N',
      category: '自定义',
      fields: []
    })
    expect(invoke).toHaveBeenCalledWith('documentTemplates.upsert', {
      typeKey: 'k1',
      name: 'N',
      category: '自定义',
      fields: []
    })
    await client.forkTemplate({ sourceId: 's1', typeKey: 'k2', name: 'F' })
    expect(invoke).toHaveBeenCalledWith('documentTemplates.fork', {
      sourceId: 's1',
      typeKey: 'k2',
      name: 'F'
    })
  })

  it('testExtract invokes the documentTemplates.testExtract route', async () => {
    const invoke = vi.fn(async () => ({
      fields: [{ key: 'invoice_code', value: '123', uncertain: false }],
      meta: { route: 'vision' as const, rawOutput: '{}', durationMs: 8, issues: [] }
    }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    const result = await client.testExtract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(invoke).toHaveBeenCalledWith('documentTemplates.testExtract', {
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.meta.route).toBe('vision')
  })

  it('extractAndDraft invokes the documents.extractAndDraft route', async () => {
    const record = {
      id: 'doc-1',
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [],
      source: 'manual' as const,
      sessionId: null,
      status: 'draft' as const,
      createdAt: 1,
      updatedAt: 2
    }
    const invoke = vi.fn(async () => ({
      document: record,
      meta: { route: 'ocr' as const, rawOutput: '{}', durationMs: 5, issues: [] }
    }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    const result = await client.extractAndDraft({
      templateId: 'auto',
      file: { path: '/tmp/a.pdf' },
      source: 'chat'
    })
    expect(invoke).toHaveBeenCalledWith('documents.extractAndDraft', {
      templateId: 'auto',
      file: { path: '/tmp/a.pdf' },
      source: 'chat'
    })
    expect(result.document.status).toBe('draft')
    expect(result.meta.route).toBe('ocr')
  })

  it('exportCsv 透传筛选参数', async () => {
    const invoke = vi.fn(async () => ({ canceled: true }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    await client.exportCsv({ typeKey: 'contract', dateFrom: 1 })
    expect(invoke).toHaveBeenCalledWith('documents.exportCsv', { typeKey: 'contract', dateFrom: 1 })
  })

  it('previewFile 透传定位参数', async () => {
    const invoke = vi.fn(async () => ({ dataBase64: 'aGk=', mimeType: 'image/png', name: 'a.png' }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    const result = await client.previewFile({ documentId: 'd1', uriIndex: 0 })
    expect(invoke).toHaveBeenCalledWith('documents.previewFile', { documentId: 'd1', uriIndex: 0 })
    expect(result.mimeType).toBe('image/png')
  })

  it('invokes tasks.create / tasks.list / stats routes', async () => {
    const invoke = vi.fn().mockResolvedValue({ tasks: [], stats: [] })
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createDocumentsClient(bridge)

    await client.createTasks({ files: [{ path: 'C:\\a.png' }], templateId: 'auto' })
    expect(invoke).toHaveBeenCalledWith('documents.tasks.create', {
      files: [{ path: 'C:\\a.png' }],
      templateId: 'auto'
    })
    await client.listTasks()
    expect(invoke).toHaveBeenLastCalledWith('documents.tasks.list', {})
    await client.stats({ dateFrom: 1 })
    expect(invoke).toHaveBeenLastCalledWith('documents.stats', { dateFrom: 1 })
  })

  it('subscribes to documents.task.updated and returns unsubscribe', () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const client = createDocumentsClient({ on } as never)
    const listener = vi.fn()
    const stop = client.onTaskUpdated(listener)
    expect(on).toHaveBeenCalledWith('documents.task.updated', listener)
    stop()
    expect(off).toHaveBeenCalled()
  })
})
