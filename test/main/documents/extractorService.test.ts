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
  extractOcrText: vi.fn(async () => ''),
  now: () => 1000,
  ...overrides
})

describe('DocumentExtractor.extract 路由', () => {
  it('图片走视觉模型', async () => {
    const deps = makeDeps()
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.route).toBe('vision')
    expect(deps.readImageAsDataUrl).toHaveBeenCalledWith('/tmp/a.jpg')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.providerId).toBe('openai')
    expect(call.modelId).toBe('gpt-4o')
    const content = call.messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    expect(JSON.stringify(content)).toContain('image_url')
    expect(result.fields.invoice_code).toEqual({ value: '123456789012', uncertain: false })
    expect(result.durationMs).toBe(0)
  })

  it('文本层 PDF 走文本模型', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '发票全文内容', hasTextLayer: true }))
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('text')
    expect(deps.extractOcrText).not.toHaveBeenCalled()
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.messages[0]?.content).toContain('发票全文内容')
  })

  it('扫描件 PDF 走 OCR 再走文本模型', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false })),
      extractOcrText: vi.fn(async () => 'OCR 识别出的文本')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.pdf')
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.messages[0]?.content).toContain('OCR 识别出的文本')
  })

  it('extractionMode=text 强制图片走 OCR 通道', async () => {
    const deps = makeDeps({
      extractOcrText: vi.fn(async () => '图片 OCR 文本'),
      repository: {
        getTemplate: vi.fn(() => makeTemplate({ extractionMode: 'text' })),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.readImageAsDataUrl).not.toHaveBeenCalled()
  })

  it('extractionMode=vision 对 PDF 抛错', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => makeTemplate({ extractionMode: 'vision' })),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
      })
    ).rejects.toThrow(/vision/)
  })

  it('视觉模型未配置时抛带引导语的错误', async () => {
    const deps = makeDeps({ resolveVisionTarget: vi.fn(() => null) })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/defaultVisionModel/)
  })

  it('不支持的文件类型抛错', async () => {
    const extractor = new DocumentExtractor(makeDeps())
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: {
          path: '/tmp/a.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }
      })
    ).rejects.toThrow(/unsupported/i)
  })

  it('模板不存在时抛错', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => null),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'missing',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/template/i)
  })
})

describe('DocumentExtractor.extract auto 分类', () => {
  it('templateId=auto 时图片先分类再提取', async () => {
    const secondTemplate = makeTemplate({
      id: 'tpl-2',
      typeKey: 'hotel_receipt',
      name: '住宿单模板'
    })
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn((id: string) =>
          id === 'tpl-1' ? makeTemplate() : id === 'tpl-2' ? secondTemplate : null
        ),
        getTemplateByTypeKey: vi.fn((typeKey: string) =>
          typeKey === 'hotel_receipt' ? secondTemplate : null
        ),
        listTemplates: vi.fn(() => [makeTemplate(), secondTemplate])
      },
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('{"typeKey": "hotel_receipt"}')
        .mockResolvedValueOnce('{"fields": {"invoice_code": null}, "uncertain_fields": []}')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'auto',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.template.typeKey).toBe('hotel_receipt')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.generateCompletion).mock.calls[1][0].modelId).toBe('gpt-4o')
  })

  it('auto 分类返回未知 typeKey 时抛错', async () => {
    const deps = makeDeps({
      generateCompletion: vi.fn().mockResolvedValue('{"typeKey": "unknown_type"}')
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'auto',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/classif/i)
  })
})

describe('DocumentExtractor.extract 分段', () => {
  it('超长文本分段提取并合并', async () => {
    const longText = 'z'.repeat(60001)
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: longText, hasTextLayer: true })),
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "111111111111"}, "uncertain_fields": []}'
        )
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "222222222222"}, "uncertain_fields": []}'
        )
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '111111111111', uncertain: true })
    expect(result.issues).toContain('invoice_code: conflicting values across segments')
  })
})
