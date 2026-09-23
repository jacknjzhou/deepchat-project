import { describe, expect, it } from 'vitest'
import {
  buildFieldEditStates,
  buildMoneyColumns,
  formatDateRangeToMs,
  formatFieldValue,
  orderedSnapshotFields,
  parseFieldEditState
} from '@/pages/documents/documentArchive'
import type { DocumentRecord } from '@shared/documents'

const field = (key: string, label: string, order: number) => ({
  key,
  label,
  valueType: 'text' as const,
  required: false,
  promptHint: null,
  validation: null,
  enumOptions: null,
  order
})

const snapshot = {
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields: [field('total_amount', '价税合计', 2), field('invoice_code', '发票代码', 1)],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
} as unknown as DocumentRecord['templateSnapshot']

const record = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'invoice_special',
  templateSnapshot: snapshot,
  fields: { invoice_code: { value: '123', uncertain: false } },
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('orderedSnapshotFields', () => {
  it('按 order 升序返回快照字段', () => {
    const keys = orderedSnapshotFields(record().templateSnapshot).map((f) => f.key)
    expect(keys).toEqual(['invoice_code', 'total_amount'])
  })
})

describe('formatFieldValue', () => {
  it('null→空串，数组→JSON，其余 String', () => {
    expect(formatFieldValue(null)).toBe('')
    expect(formatFieldValue(['a'])).toBe('["a"]')
    expect(formatFieldValue(1.5)).toBe('1.5')
  })
})

describe('buildMoneyColumns', () => {
  it('收集列表中出现过的金额类字段（跨类型按 key 去重）', () => {
    const money = (key: string, label: string) => ({ ...field(key, label, 1) })
    const documents = [
      record({
        fields: { total_amount: { value: 1, uncertain: false } }
      }),
      record({
        id: 'd2',
        typeKey: 'invoice_general',
        templateId: 'tpl-2',
        templateSnapshot: {
          ...snapshot,
          fields: [money('total_amount', '合计金额'), money('tax_amount', '税额')]
        },
        fields: {
          total_amount: { value: 2, uncertain: false },
          tax_amount: { value: 0.5, uncertain: true }
        }
      }),
      record({
        id: 'd3',
        templateSnapshot: { ...snapshot, fields: [field('buyer', '购买方', 1)] },
        fields: {}
      })
    ]
    const columns = buildMoneyColumns(documents)
    expect(columns).toEqual([
      { key: 'total_amount', label: '价税合计' },
      { key: 'tax_amount', label: '税额' }
    ])
  })
})

describe('formatDateRangeToMs', () => {
  it('空串→undefined；日期→当地时区起止 ms', () => {
    expect(formatDateRangeToMs('')).toBeUndefined()
    const from = formatDateRangeToMs('2026-01-02')
    expect(from).toBe(new Date(2026, 0, 2, 0, 0, 0, 0).getTime())
    const to = formatDateRangeToMs('2026-01-02', 'end')
    expect(to).toBe(new Date(2026, 0, 2, 23, 59, 59, 999).getTime())
  })
})

describe('buildFieldEditStates / parseFieldEditState', () => {
  const editRecord = (fields: DocumentRecord['fields']): DocumentRecord =>
    record({
      fields,
      templateSnapshot: {
        ...snapshot,
        fields: [
          { ...field('items', '明细', 1), valueType: 'array' as const },
          field('buyer', '购买方', 2)
        ]
      } as DocumentRecord['templateSnapshot']
    })

  it('array 值按行序列化，保存时按行解析', () => {
    const document = editRecord({ items: { value: ['甲', '乙'], uncertain: true } })
    const states = buildFieldEditStates(document)
    expect(states[0].raw).toBe('甲\n乙')
    const parsed = parseFieldEditState({ ...states[0], raw: '甲\n乙\n\n' })
    expect(parsed).toEqual({ ok: true, value: ['甲', '乙'] })
  })

  it('array 对象元素按 JSON 展示并在保存时还原', () => {
    const items = [
      { 名称: '标准间', 金额: 300 },
      { 名称: '早餐', 金额: 40 }
    ]
    const states = buildFieldEditStates(editRecord({ items: { value: items, uncertain: false } }))
    expect(states[0].raw).toBe('{"名称":"标准间","金额":300}\n{"名称":"早餐","金额":40}')

    const edited = parseFieldEditState({
      ...states[0],
      raw: '{"名称":"标准间","金额":300}\n含税费\n300'
    })
    expect(edited).toEqual({
      ok: true,
      value: [{ 名称: '标准间', 金额: 300 }, '含税费', '300']
    })
  })

  it('required 字段为空报 required', () => {
    const states = buildFieldEditStates(editRecord({}))
    const required = { ...states[0], required: true, raw: '' }
    expect(parseFieldEditState(required)).toEqual({ ok: false, error: 'required' })
  })

  it('number 非法报 number', () => {
    const states = buildFieldEditStates(editRecord({}))
    expect(parseFieldEditState({ ...states[0], valueType: 'number', raw: 'abc' })).toEqual({
      ok: false,
      error: 'number'
    })
  })

  it('enum 值不在选项内报错，非 required 空值放行 null', () => {
    const states = buildFieldEditStates(editRecord({}))
    const enumState = { ...states[0], valueType: 'enum' as const, enumOptions: ['甲', '乙'] }
    expect(parseFieldEditState({ ...enumState, raw: '丙' })).toEqual({ ok: false, error: 'json' })
    expect(parseFieldEditState({ ...enumState, raw: '' })).toEqual({ ok: true, value: null })
  })
})
