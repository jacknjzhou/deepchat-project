import { describe, expect, it } from 'vitest'
import {
  buildClassificationPrompts,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt
} from '@/documents/extractor/promptBuilder'
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
    },
    {
      key: 'total_amount',
      label: '价税合计',
      valueType: 'number',
      required: true,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 2
    },
    {
      key: 'invoice_date',
      label: '开票日期',
      valueType: 'date',
      required: true,
      promptHint: 'YYYY-MM-DD',
      validation: null,
      enumOptions: null,
      order: 3
    },
    {
      key: 'line_items',
      label: '明细行',
      valueType: 'array',
      required: false,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 4
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

describe('buildExtractionSystemPrompt', () => {
  it('包含字段清单、valueType 指引与禁止臆造原则', () => {
    const prompt = buildExtractionSystemPrompt(makeTemplate())
    expect(prompt).toContain('invoice_code')
    expect(prompt).toContain('12位发票代码')
    expect(prompt).toContain('total_amount')
    expect(prompt).toContain('number')
    expect(prompt).toContain('YYYY-MM-DD')
    expect(prompt).toContain('null')
    expect(prompt).toContain('line_items')
    expect(prompt).toContain('uncertain_fields')
  })

  it('promptPreset 非空时附加到末尾', () => {
    const prompt = buildExtractionSystemPrompt(makeTemplate({ promptPreset: '额外注意盖章日期' }))
    expect(prompt).toContain('额外注意盖章日期')
  })
})

describe('buildExtractionUserPrompt', () => {
  it('文本通道携带文档文本', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), '发票抬头：某某公司')
    expect(prompt).toContain('发票抬头：某某公司')
  })

  it('视觉通道不携带文档文本', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), null)
    expect(prompt).not.toContain('以下是需要识别的文档内容')
  })

  it('分段模式包含分段提示', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), '片段内容', {
      segmentIndex: 1,
      segmentCount: 3
    })
    expect(prompt).toContain('1/3')
  })
})

describe('buildClassificationPrompts', () => {
  it('枚举候选模板 typeKey 与名称', () => {
    const { system, user } = buildClassificationPrompts([makeTemplate()])
    expect(user).toContain('invoice_special')
    expect(user).toContain('增值税专用发票')
  })
})
