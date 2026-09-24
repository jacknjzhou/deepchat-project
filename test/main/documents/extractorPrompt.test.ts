import { describe, expect, it } from 'vitest'
import {
  buildClassificationPrompts,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt
} from '@/documents/extractor/promptBuilder'
import type { DocumentTemplate, DocumentTemplateField } from '@shared/documents'

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

const makeField = (
  key: string,
  label: string,
  required: boolean,
  order: number,
  overrides: Partial<DocumentTemplateField> = {}
): DocumentTemplateField => ({
  key,
  label,
  valueType: 'text',
  required,
  promptHint: null,
  validation: null,
  enumOptions: null,
  order,
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

  it('乱序字段按 order 升序渲染', () => {
    const template = makeTemplate({
      fields: [
        makeField('field_c', '三号字段', false, 3),
        makeField('field_a', '一号字段', true, 1),
        makeField('field_b', '二号字段', true, 2)
      ]
    })
    const prompt = buildExtractionSystemPrompt(template)
    const positions = ['field_a', 'field_b', 'field_c'].map((key) => prompt.indexOf(key))
    expect(positions[0]).toBeGreaterThan(-1)
    expect(positions[1]).toBeGreaterThan(positions[0])
    expect(positions[2]).toBeGreaterThan(positions[1])
  })

  it('枚举字段渲染选项列表', () => {
    const template = makeTemplate({
      fields: [
        makeField('invoice_type', '发票种类', true, 1, {
          valueType: 'enum',
          enumOptions: ['专票', '普票']
        })
      ]
    })
    const prompt = buildExtractionSystemPrompt(template)
    expect(prompt).toContain('枚举选项: 专票 | 普票')
  })

  it('标注字段是否必填', () => {
    const template = makeTemplate({
      fields: [
        makeField('required_field', '必填项', true, 1),
        makeField('optional_field', '选填项', false, 2)
      ]
    })
    const prompt = buildExtractionSystemPrompt(template)
    const requiredStart = prompt.indexOf('key: required_field')
    const optionalStart = prompt.indexOf('key: optional_field')
    expect(prompt.slice(requiredStart, optionalStart)).toContain('必填: 是')
    expect(prompt.slice(optionalStart)).toContain('必填: 否')
  })
})

describe('buildExtractionSystemPrompt enhancements', () => {
  it('appends invoice guidance for invoice-category templates', () => {
    const template = makeTemplate({
      category: '发票类',
      fields: [makeField('invoice_number', '发票号码', true, 1)]
    })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('发票类专项提示')
    expect(system).toContain('发票号码通常为 8 位数字（全电发票为 20 位）')
    expect(system).toContain('价税合计需与"金额大写"一致')
  })

  it('does not append invoice guidance for other categories', () => {
    const template = makeTemplate({
      category: '合同类',
      fields: [makeField('party_a', '甲方', true, 1)]
    })
    expect(buildExtractionSystemPrompt(template)).not.toContain('发票类专项提示')
  })

  it('includes a structural output example', () => {
    const template = makeTemplate({
      category: '合同类',
      fields: [makeField('party_a', '甲方', true, 1)]
    })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('输出示例')
    expect(system).toContain('"party_a"')
  })

  it('adds per-field grounding rules that also guard custom templates', () => {
    const template = makeTemplate({
      category: '自定义',
      fields: [makeField('my_field', '自定义字段', true, 1)]
    })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('通用提取要求')
    expect(system).toContain('提示（hint）是字段含义的权威定义')
    expect(system).toContain('禁止用常识或经验推断补全')
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

  it('includes category and distinguishing field keys per template', () => {
    const templates = [
      makeTemplate({
        typeKey: 'invoice_special',
        name: '增值税专用发票',
        category: '发票类',
        fields: [
          makeField('checker', '复核人', false, 2),
          makeField('buyer_bank', '开户行', true, 1)
        ]
      }),
      makeTemplate({
        typeKey: 'invoice_general',
        name: '普通发票',
        category: '发票类',
        fields: [makeField('seller_name', '销售方名称', true, 1)]
      })
    ]
    const { system, user } = buildClassificationPrompts(templates)
    expect(system).toContain('注意区分字段集合不同但名称相近的类型')
    expect(user).toContain('invoice_special（发票类）: 增值税专用发票')
    expect(user).toContain('典型字段: buyer_bank, checker')
    expect(user).toContain('invoice_general（发票类）: 普通发票')
  })
})
