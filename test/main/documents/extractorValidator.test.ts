import { describe, expect, it } from 'vitest'
import {
  chineseAmountToNumber,
  extractJsonBlock,
  parseModelOutput,
  validateTemplateRules
} from '@/documents/extractor/fieldValidator'
import type { DocumentTemplate } from '@shared/documents'

const field = (
  key: string,
  valueType: 'text' | 'number' | 'date' | 'array' | 'enum',
  overrides: Record<string, unknown> = {}
) => ({
  key,
  label: key,
  valueType,
  required: false,
  promptHint: null,
  validation: null,
  enumOptions: valueType === 'enum' ? ['专票', '普票'] : null,
  order: 1,
  ...overrides
})

const makeTemplate = (fields: ReturnType<typeof field>[]): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields,
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
})

describe('extractJsonBlock', () => {
  it('解析嵌套对象', () => {
    const raw = '前缀 {"fields": {"a": {"b": 1}}, "uncertain_fields": []}'
    expect(extractJsonBlock(raw)).toEqual({ fields: { a: { b: 1 } }, uncertain_fields: [] })
  })

  it('字符串内花括号不被截断', () => {
    const raw = '{"fields": {"a": "包含 } 与 { 的文本"}, "uncertain_fields": []}'
    expect(extractJsonBlock(raw)).toEqual({
      fields: { a: '包含 } 与 { 的文本' },
      uncertain_fields: []
    })
  })

  it('值中含转义引号与反斜杠时正常解析', () => {
    const raw = '{"fields": {"a": "引号 \\" 反斜杠 \\\\"}, "uncertain_fields": []}'
    expect(extractJsonBlock(raw)).toEqual({
      fields: { a: '引号 " 反斜杠 \\' },
      uncertain_fields: []
    })
  })

  it('前导杂文含平衡花括号时跳过并解析真 JSON', () => {
    const raw = '示例 {A} 如下：{"fields": {"a": "ok"}, "uncertain_fields": []}'
    expect(extractJsonBlock(raw)).toEqual({ fields: { a: 'ok' }, uncertain_fields: [] })
  })
})

describe('parseModelOutput', () => {
  it('解析裸 JSON 输出', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '{"fields": {"invoice_code": "12345678"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.invoice_code).toEqual({ value: '12345678', uncertain: false })
    expect(result.issues).toEqual([])
  })

  it('剥离 Markdown 代码围栏', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '```json\n{"fields": {"invoice_code": "12345678"}, "uncertain_fields": []}\n```',
      template
    )
    expect(result.fields.invoice_code?.value).toBe('12345678')
  })

  it('缺失字段补 null，required 字段标记 uncertain', () => {
    const template = makeTemplate([
      field('invoice_code', 'text', { required: true }),
      field('drawer', 'text')
    ])
    const result = parseModelOutput('{"fields": {}, "uncertain_fields": []}', template)
    expect(result.fields.invoice_code).toEqual({ value: null, uncertain: true })
    expect(result.fields.drawer).toEqual({ value: null, uncertain: false })
  })

  it('uncertain_fields 命中时标记 uncertain', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '{"fields": {"invoice_code": "12345678"}, "uncertain_fields": ["invoice_code"]}',
      template
    )
    expect(result.fields.invoice_code).toEqual({ value: '12345678', uncertain: true })
  })

  it('number 接受带货币符号与千分位的字符串并归一化', () => {
    const template = makeTemplate([field('total_amount', 'number')])
    const result = parseModelOutput(
      '{"fields": {"total_amount": "¥1,234.50"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.total_amount).toEqual({ value: 1234.5, uncertain: false })
  })

  it('number 无法解析时置 null 并记录 issue', () => {
    const template = makeTemplate([field('total_amount', 'number')])
    const result = parseModelOutput(
      '{"fields": {"total_amount": "see attached"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.total_amount?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('date 接受斜杠与中文格式并归一化为 YYYY-MM-DD', () => {
    const template = makeTemplate([field('invoice_date', 'date')])
    for (const raw of ['2026/09/22', '2026年9月22日', '2026-9-22']) {
      const result = parseModelOutput(
        `{"fields": {"invoice_date": "${raw}"}, "uncertain_fields": []}`,
        template
      )
      expect(result.fields.invoice_date?.value).toBe('2026-09-22')
    }
  })

  it('array 接受 JSON 字符串并解析为数组', () => {
    const template = makeTemplate([field('line_items', 'array')])
    const result = parseModelOutput(
      '{"fields": {"line_items": "[{\\"name\\": \\"a\\"}]"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.line_items?.value).toEqual([{ name: 'a' }])
  })

  it('enum 值不在选项内时置 null 并记录 issue', () => {
    const template = makeTemplate([field('invoice_type', 'enum')])
    const result = parseModelOutput(
      '{"fields": {"invoice_type": "收据"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.invoice_type?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('非 JSON 输出返回全 null fields 并记录 issue', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput('抱歉，我无法识别', template)
    expect(result.fields.invoice_code?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })
})

describe('validateTemplateRules', () => {
  it('date_format：date 字段值不符合 YYYY-MM-DD 时报 issue', () => {
    const template = makeTemplate([field('invoice_date', 'date')])
    const issues = validateTemplateRules(template, {
      invoice_date: { value: '22/09/2026', uncertain: false }
    })
    expect(issues.some((issue) => issue.includes('invoice_date'))).toBe(true)
  })

  it('amount_conservation：amount_ex_tax + tax_amount ≠ total_amount 时报 issue', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 113, uncertain: false },
      amount_ex_tax: { value: 100, uncertain: false },
      tax_amount: { value: 9, uncertain: false }
    })
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain('amount_conservation')
  })

  it('amount_conservation：金额守恒通过时不报 issue', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 113, uncertain: false },
      amount_ex_tax: { value: 100, uncertain: false },
      tax_amount: { value: 13, uncertain: false }
    })
    expect(issues).toEqual([])
  })

  it('正则 validation：字段值不匹配时报 issue', () => {
    const template = makeTemplate([field('invoice_code', 'text', { validation: '^\\d{12}$' })])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: '123', uncertain: false }
    })
    expect(issues.length).toBe(1)
  })

  it('正则 validation：null 值跳过', () => {
    const template = makeTemplate([field('invoice_code', 'text', { validation: '^\\d{12}$' })])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: null, uncertain: false }
    })
    expect(issues).toEqual([])
  })

  it('正则 validation：非法正则表达式报 issue 而非抛错', () => {
    const template = makeTemplate([field('invoice_code', 'text', { validation: '[' })])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: 'abc', uncertain: false }
    })
    expect(issues.length).toBe(1)
  })

  it('已知格式：invoice_number 位数不符时报 issue', () => {
    const template = makeTemplate([field('invoice_number', 'text')])
    const issues = validateTemplateRules(template, {
      invoice_number: { value: '1234567', uncertain: false }
    })
    expect(issues).toContainEqual(expect.stringContaining('invoice_number'))
  })

  it('已知格式：接受 8 位或 20 位 invoice_number', () => {
    const template = makeTemplate([field('invoice_number', 'text')])
    const issues = validateTemplateRules(template, {
      invoice_number: { value: '24120000000123456789', uncertain: false }
    })
    expect(issues).toHaveLength(0)
  })

  it('已知格式：buyer_tax_no 少于 15 位时报 issue', () => {
    const template = makeTemplate([field('buyer_tax_no', 'text')])
    const issues = validateTemplateRules(template, {
      buyer_tax_no: { value: '913301', uncertain: false }
    })
    expect(issues).toContainEqual(expect.stringContaining('buyer_tax_no'))
  })

  it('已知格式：seller_tax_no 少于 15 位时报 issue', () => {
    const template = makeTemplate([field('seller_tax_no', 'text')])
    const issues = validateTemplateRules(template, {
      seller_tax_no: { value: '913301', uncertain: false }
    })
    expect(issues).toContainEqual(expect.stringContaining('seller_tax_no'))
  })

  it('已知格式：invoice_code 位数不符时报 issue，10 位通过', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const bad = validateTemplateRules(template, {
      invoice_code: { value: '123456789', uncertain: false }
    })
    expect(bad).toContainEqual(expect.stringContaining('invoice_code'))
    const ok = validateTemplateRules(template, {
      invoice_code: { value: '0410320001', uncertain: false }
    })
    expect(ok).toHaveLength(0)
  })

  it('已知格式：tax_rate 接受免税、不征税与常见税率', () => {
    const template = makeTemplate([field('tax_rate', 'text')])
    for (const value of ['免税', '不征税', '13%', '3%']) {
      const issues = validateTemplateRules(template, {
        tax_rate: { value, uncertain: false }
      })
      expect(issues).toHaveLength(0)
    }
    const issues = validateTemplateRules(template, {
      tax_rate: { value: '17%', uncertain: false }
    })
    expect(issues).toContainEqual(expect.stringContaining('tax_rate'))
  })

  it('已知格式：值两侧空白先 trim 再校验', () => {
    const template = makeTemplate([field('invoice_number', 'text')])
    const issues = validateTemplateRules(template, {
      invoice_number: { value: ' 12345678 ', uncertain: false }
    })
    expect(issues).toHaveLength(0)
  })

  it('大写金额：amount_upper 与 total_amount 矛盾时报 issue', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number'),
      field('amount_upper', 'text')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 30000, uncertain: false },
      amount_upper: { value: '伍万元整', uncertain: false }
    })
    expect(issues).toContainEqual(expect.stringContaining('amount_upper does not match'))
  })

  it('大写金额：amount_upper 与 total_amount 一致时通过', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number'),
      field('amount_upper', 'text')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 30000, uncertain: false },
      amount_upper: { value: '叁万元整', uncertain: false }
    })
    expect(issues).toHaveLength(0)
  })

  it('大写金额：模板缺求和对时跳过交叉核对（普票口径）', () => {
    const template = makeTemplate([field('total_amount', 'number'), field('amount_upper', 'text')])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 200, uncertain: false },
      amount_upper: { value: '贰佰贰拾陆元整', uncertain: false }
    })
    expect(issues).toHaveLength(0)
  })

  it('大写金额：amount_upper 无法解析时跳过', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number'),
      field('amount_upper', 'text')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 30000, uncertain: false },
      amount_upper: { value: 'abc', uncertain: false }
    })
    expect(issues).toHaveLength(0)
  })
})

describe('chineseAmountToNumber', () => {
  it.each([
    ['叁万元整', 30000],
    ['壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分', 1234567.89],
    ['拾贰元', 12],
    ['人民币壹佰元整', 100],
    ['贰拾元零伍分', 20.05],
    ['壹拾元整', 10],
    ['拾元整', 10],
    ['拾万元整', 100000],
    ['壹亿贰仟万元整', 120000000],
    ['壹亿零壹拾万元整', 100100000]
  ])('解析 %s -> %d', (raw, expected) => {
    expect(chineseAmountToNumber(raw)).toBe(expected)
  })

  it('无法解析或空串返回 null', () => {
    expect(chineseAmountToNumber('abc')).toBeNull()
    expect(chineseAmountToNumber('')).toBeNull()
    expect(chineseAmountToNumber('两万元整')).toBeNull()
  })
})
