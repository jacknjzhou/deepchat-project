import { describe, expect, it, vi } from 'vitest'
import { DocumentExtractor } from '@/documents/extractor/documentExtractor'
import type { DocumentExtractorDeps } from '@/documents/extractor/documentExtractor'
import type { DocumentTemplate } from '@shared/documents'

const makeTemplate = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
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
  updatedAt: 1,
  ...overrides
})

const makeDeps = (overrides: Partial<DocumentExtractorDeps> = {}): DocumentExtractorDeps => ({
  repository: {
    getTemplate: vi.fn(() => makeTemplate()),
    getTemplateByTypeKey: vi.fn(() => null),
    listTemplates: vi.fn(() => [makeTemplate()])
  },
  generateCompletion: vi.fn(
    async () => '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
  ),
  resolveVisionTarget: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
  resolveTextTarget: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o-mini' })),
  readImageAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false })),
  renderPdfPages: vi.fn(async () => ({
    dataUrls: ['data:image/jpeg;base64,AAAA'],
    pageCount: 1
  })),
  extractOcrText: vi.fn(async () => ''),
  now: () => 1000,
  ...overrides
})

describe('DocumentExtractor endpointType 透传', () => {
  it('把文本模型 target 的显式 endpointType 透传给 provider 请求', async () => {
    const deps = makeDeps({
      resolveTextTarget: vi.fn(() => ({
        providerId: 'managed-corp-gw',
        modelId: 'claude-x',
        endpointType: 'anthropic' as const
      })),
      extractPdfText: vi.fn(async () => ({ text: '发票全文内容', hasTextLayer: true }))
    })
    const extractor = new DocumentExtractor(deps)
    await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })

    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.providerId).toBe('managed-corp-gw')
    expect(call.modelId).toBe('claude-x')
    expect(call.endpointType).toBe('anthropic')
  })

  it('把视觉模型 target 的显式 endpointType 透传给 provider 请求', async () => {
    const deps = makeDeps({
      resolveVisionTarget: vi.fn(() => ({
        providerId: 'managed-corp-gw',
        modelId: 'claude-vision',
        endpointType: 'anthropic' as const
      }))
    })
    const extractor = new DocumentExtractor(deps)
    await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })

    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.modelId).toBe('claude-vision')
    expect(call.endpointType).toBe('anthropic')
  })

  it('target 未指定 endpointType 时不写入该字段（保持既有行为）', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '发票全文内容', hasTextLayer: true }))
    })
    const extractor = new DocumentExtractor(deps)
    await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })

    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.endpointType).toBeUndefined()
  })
})
