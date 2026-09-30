import { describe, expect, it, vi } from 'vitest'
import {
  readDocumentsModelSettings,
  resolveDocumentsModelSettings
} from '@/documents/modelSettings'
import { DocumentExtractor } from '@/documents/extractor/documentExtractor'
import type { DocumentExtractorDeps } from '@/documents/extractor/documentExtractor'
import type { DocumentsSettingsStore } from '@/documents/modelSettings'
import type { ManagedConfigPayload } from '@/managed/types'
import type { DocumentTemplate } from '@shared/documents'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

const makeTemplate = (): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields: [
    {
      key: 'invoice_code',
      label: '发票代码',
      valueType: 'text',
      required: true,
      promptHint: '12位发票代码',
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
})

const makeStore = (values: Record<string, unknown>): DocumentsSettingsStore => ({
  getSetting: <T>(key: string) => values[key] as T | undefined,
  setSetting: vi.fn()
})

const pdfWithTextLayer = { text: '发票全文内容', hasTextLayer: true }

// 组装层：托管配置 -> resolveDocumentsModelSettings -> extractor target -> provider 调用参数
const runExtraction = async (
  store: DocumentsSettingsStore,
  managed: ManagedConfigPayload | null,
  generateCompletion: DocumentExtractorDeps['generateCompletion']
): Promise<void> => {
  const settings = resolveDocumentsModelSettings(readDocumentsModelSettings(store), managed)
  const extractor = new DocumentExtractor({
    repository: {
      getTemplate: vi.fn(() => makeTemplate()),
      getTemplateByTypeKey: vi.fn(() => null),
      listTemplates: vi.fn(() => [makeTemplate()])
    },
    generateCompletion,
    resolveVisionTarget: async () => settings.visionModel,
    resolveTextTarget: async () => settings.textModel,
    readImageAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    extractPdfText: vi.fn(async () => pdfWithTextLayer),
    renderPdfPages: vi.fn(async () => ({
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      pageCount: 1
    })),
    extractOcrText: vi.fn(async () => ''),
    now: () => 1000
  })
  await extractor.extract({
    templateId: 'tpl-1',
    file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
  })
}

const managedWithEndpointType: ManagedConfigPayload = {
  version: 1,
  providers: [],
  defaultProviderId: null,
  agentModels: null,
  documents: {
    textModel: {
      providerId: 'managed-corp-gw',
      modelId: 'claude-x',
      endpointType: 'anthropic'
    },
    visionModel: null,
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

describe('documents endpointType 端到端透传', () => {
  it('把托管下发的显式 endpointType 一路带到 provider 调用参数', async () => {
    const requests: Array<{ providerId: string; modelId: string; endpointType?: string }> = []
    const store = makeStore({})

    await runExtraction(store, managedWithEndpointType, async (input) => {
      requests.push({
        providerId: input.providerId,
        modelId: input.modelId,
        endpointType: input.endpointType
      })
      return '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
    })

    expect(requests[0]).toEqual({
      providerId: 'managed-corp-gw',
      modelId: 'claude-x',
      endpointType: 'anthropic'
    })
  })

  it('未指定 endpointType 时 provider 调用参数不含该字段（回归保护）', async () => {
    const requests: Array<{ providerId: string; modelId: string; endpointType?: string }> = []
    const store = makeStore({
      'documents.textModel': { providerId: 'openai', modelId: 'gpt-4o-mini' }
    })

    await runExtraction(store, null, async (input) => {
      requests.push({
        providerId: input.providerId,
        modelId: input.modelId,
        endpointType: input.endpointType
      })
      return '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
    })

    expect(requests[0]).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      endpointType: undefined
    })
  })
})
