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
})
