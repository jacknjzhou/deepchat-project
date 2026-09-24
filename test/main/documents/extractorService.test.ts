import { describe, expect, it, vi } from 'vitest'
import { DocumentExtractor } from '@/documents/extractor/documentExtractor'
import type {
  CompletionRequest,
  DocumentExtractorDeps
} from '@/documents/extractor/documentExtractor'
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
  renderPdfPages: vi.fn(async () => ({ dataUrls: ['data:image/jpeg;base64,AAAA'], pageCount: 1 })),
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
    expect(call.messages[0]?.role).toBe('system')
    expect(call.messages[0]?.content).toContain('- key: invoice_code')
    expect(call.messages[0]?.content).toContain('12位发票代码')
    const content = call.messages[1]?.content
    expect(Array.isArray(content)).toBe(true)
    expect(JSON.stringify(content)).toContain('image_url')
    expect(JSON.stringify(content)).toContain('"detail":"auto"')
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
    expect(call.messages[0]?.role).toBe('system')
    expect(call.messages[1]?.content).toContain('发票全文内容')
  })

  it('扫描件 PDF 无视觉模型时走 OCR 再走文本模型', async () => {
    const deps = makeDeps({
      resolveVisionTarget: vi.fn(() => null),
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
    expect(call.messages[0]?.role).toBe('system')
    expect(call.messages[1]?.content).toContain('OCR 识别出的文本')
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

  it('extractionMode=vision 视觉模型未配置时抛带引导语的错误', async () => {
    const deps = makeDeps({
      resolveVisionTarget: vi.fn(() => null),
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
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/defaultVisionModel/)
  })

  it('图片 auto 模式无视觉模型时回落 OCR 路由', async () => {
    const deps = makeDeps({
      resolveVisionTarget: vi.fn(() => null),
      extractOcrText: vi.fn(async () => 'OCR TEXT')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.png', mimeType: 'image/png' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.readImageAsDataUrl).not.toHaveBeenCalled()
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.png')
    expect(result.fields.invoice_code).toEqual({ value: '123456789012', uncertain: false })
  })

  it('文本模型未配置时抛带引导语的错误', async () => {
    const deps = makeDeps({
      resolveTextTarget: vi.fn(() => null),
      extractPdfText: vi.fn(async () => ({ text: '发票全文内容', hasTextLayer: true }))
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
      })
    ).rejects.toThrow(/defaultModel/)
  })

  it('无 mimeType 时按扩展名路由', async () => {
    const deps = makeDeps()
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({ templateId: 'tpl-1', file: { path: '/tmp/a.png' } })
    expect(result.route).toBe('vision')
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

describe('pdf vision routing', () => {
  const makeScannedTemplate = () =>
    makeTemplate({
      fields: [
        {
          key: 'invoice_code',
          label: '发票代码',
          valueType: 'text',
          required: false,
          promptHint: '12位发票代码',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ]
    })

  it('扫描件 PDF 页数在限制内走 vision 并逐页提取合并', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => makeScannedTemplate()),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      },
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false, pageCount: 2 })),
      renderPdfPages: vi.fn(async () => ({
        dataUrls: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'],
        pageCount: 2
      })),
      generateCompletion: vi.fn(async (input: CompletionRequest) => {
        const content = JSON.stringify(input.messages[1]?.content)
        return content.includes('base64,AA')
          ? '{"fields": {"invoice_code": "888888888888"}, "uncertain_fields": []}'
          : '{"fields": {"invoice_code": null}, "uncertain_fields": []}'
      })
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('vision')
    expect(deps.renderPdfPages).toHaveBeenCalledWith('/tmp/a.pdf')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '888888888888', uncertain: false })
    expect(result.issues).not.toContain('invoice_code: conflicting values across pages')
    expect(result.rawOutput).toContain('\n---\n')
  })

  it('某页必填字段全部为空时不触发重试', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false, pageCount: 2 })),
      renderPdfPages: vi.fn(async () => ({
        dataUrls: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'],
        pageCount: 2
      })),
      generateCompletion: vi.fn(async (input: CompletionRequest) => {
        const content = JSON.stringify(input.messages[1]?.content)
        return content.includes('base64,AA')
          ? '{"fields": {"invoice_code": "888888888888"}, "uncertain_fields": []}'
          : '{"fields": {"invoice_code": null}, "uncertain_fields": []}'
      })
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('vision')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '888888888888', uncertain: false })
  })

  it('某页输出非法 JSON 时仍重试', async () => {
    const deps = makeDeps({
      renderPdfPages: vi.fn(async () => ({
        dataUrls: ['data:image/jpeg;base64,AA'],
        pageCount: 1
      })),
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('抱歉，我无法输出 JSON')
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "888888888888"}, "uncertain_fields": []}'
        )
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('vision')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '888888888888', uncertain: false })
  })

  it('扫描件 PDF 无视觉模型时回落 OCR', async () => {
    const deps = makeDeps({
      resolveVisionTarget: vi.fn(() => null),
      extractOcrText: vi.fn(async () => 'OCR 识别出的文本')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.renderPdfPages).not.toHaveBeenCalled()
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.pdf')
  })

  it('扫描件 PDF 超过视觉页数上限时走 OCR', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false, pageCount: 9 })),
      extractOcrText: vi.fn(async () => 'OCR 识别出的文本')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.renderPdfPages).not.toHaveBeenCalled()
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.pdf')
  })

  it('extractionMode=vision 对 PDF 走逐页视觉提取', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => makeTemplate({ extractionMode: 'vision' })),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('vision')
    expect(deps.renderPdfPages).toHaveBeenCalledWith('/tmp/a.pdf')
    expect(deps.readImageAsDataUrl).not.toHaveBeenCalled()
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
  })
})

describe('scanned pdf classification', () => {
  const makeClassifyDeps = (overrides: Partial<DocumentExtractorDeps> = {}) =>
    makeDeps({
      repository: {
        getTemplate: vi.fn((id: string) => (id === 'tpl-1' ? makeTemplate() : null)),
        getTemplateByTypeKey: vi.fn((typeKey: string) =>
          typeKey === 'invoice_special' ? makeTemplate() : null
        ),
        listTemplates: vi.fn(() => [makeTemplate()])
      },
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false, pageCount: 2 })),
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('{"typeKey": "invoice_special"}')
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
        ),
      ...overrides
    })

  it('扫描件 auto 分类使用第 1 页图片', async () => {
    const deps = makeClassifyDeps()
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'auto',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.template.typeKey).toBe('invoice_special')
    expect(result.route).toBe('vision')
    const renderMock = vi.mocked(deps.renderPdfPages)
    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(renderMock.mock.calls[0]).toEqual(['/tmp/a.pdf', { maxPages: 1 }])
    const classifyCall = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(classifyCall.modelId).toBe('gpt-4o')
    expect(JSON.stringify(classifyCall.messages[1]?.content)).toContain('"detail":"low"')
    expect(JSON.stringify(classifyCall.messages[1]?.content)).toContain('base64,AA')
  })

  it('扫描件无视觉模型时回退文本分类', async () => {
    const deps = makeClassifyDeps({
      resolveVisionTarget: vi.fn(() => null),
      extractOcrText: vi.fn(async () => 'OCR 识别出的文本')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'auto',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.renderPdfPages).not.toHaveBeenCalled()
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.pdf')
    const classifyCall = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(classifyCall.modelId).toBe('gpt-4o-mini')
    expect(Array.isArray(classifyCall.messages[1]?.content)).toBe(false)
    expect(JSON.stringify(classifyCall.messages[1]?.content)).not.toContain('image_url')
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
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
        )
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'auto',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.template.typeKey).toBe('hotel_receipt')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    const classifyCall = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(classifyCall.messages[0]?.role).toBe('system')
    expect(JSON.stringify(classifyCall.messages[1]?.content)).toContain('"detail":"low"')
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

describe('DocumentExtractor.extract 解析失败重试', () => {
  it('首次输出非法 JSON 时重试一次并采用更好的结果', async () => {
    const deps = makeDeps({
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('抱歉，我无法输出 JSON')
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
        )
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '123456789012', uncertain: false })
    expect(result.issues).not.toContain('model output is not valid JSON')
  })

  it('首次输出可解析时不重试', async () => {
    const deps = makeDeps()
    const extractor = new DocumentExtractor(deps)
    await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
  })

  it('重试仍未改善时保留首次结果', async () => {
    const deps = makeDeps({
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('不是JSON')
        .mockResolvedValueOnce('也不是JSON')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.issues).toContain('model output is not valid JSON')
  })

  it('重试调用抛错时回退首次结果', async () => {
    const deps = makeDeps({
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('抱歉，我无法输出 JSON')
        .mockRejectedValueOnce(new Error('model unavailable'))
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.rawOutput).toBe('抱歉，我无法输出 JSON')
    expect(result.issues).toContain('model output is not valid JSON')
  })

  it('首次输出必填字段全为空时重试并采用填充结果', async () => {
    const deps = makeDeps({
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('{"fields": {"invoice_code": null}, "uncertain_fields": []}')
        .mockResolvedValueOnce(
          '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
        )
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '123456789012', uncertain: false })
    expect(result.issues).not.toContain('model output is not valid JSON')
  })
})
