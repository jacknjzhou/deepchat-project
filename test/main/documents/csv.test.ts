import { describe, expect, it } from 'vitest'
import {
  buildDocumentsCsv,
  escapeCsvCell,
  formatCsvValue,
  isMoneyLikeField,
  summarizeDocument
} from '@/documents/csv'
import type { DocumentRecord, DocumentTemplate } from '@shared/documents'

const makeTemplate = (
  fields: Array<{ key: string; label: string; order: number }>
): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields: fields.map((f) => ({
    ...f,
    valueType: 'text',
    required: true,
    promptHint: null,
    validation: null,
    enumOptions: null
  })),
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
})

const makeRecord = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'invoice_special',
  templateSnapshot: makeTemplate([
    { key: 'invoice_code', label: '发票代码', order: 1 },
    { key: 'total_amount', label: '价税合计', order: 2 }
  ]),
  fields: {
    invoice_code: { value: '12345', uncertain: false },
    total_amount: { value: 100.5, uncertain: true }
  },
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

describe('escapeCsvCell / formatCsvValue', () => {
  it('含逗号/引号/换行的单元格加引号并双写引号', () => {
    expect(escapeCsvCell('plain')).toBe('plain')
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"')
  })

  it('null→空串，数组/对象→JSON，其余 String()', () => {
    expect(formatCsvValue(null)).toBe('')
    expect(formatCsvValue(undefined)).toBe('')
    expect(formatCsvValue(100.5)).toBe('100.5')
    expect(formatCsvValue(['a', 'b'])).toBe('["a","b"]')
    expect(formatCsvValue({ k: 1 })).toBe('{"k":1}')
  })
})

describe('isMoneyLikeField', () => {
  it('按 key/label 识别金额类字段', () => {
    const f = (key: string, label: string) => ({
      key,
      label,
      valueType: 'text',
      required: false,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 1
    })
    expect(isMoneyLikeField(f('total_amount', '备注'))).toBe(true)
    expect(isMoneyLikeField(f('note', '价税合计'))).toBe(true)
    expect(isMoneyLikeField(f('buyer', '购买方'))).toBe(false)
  })
})

describe('summarizeDocument', () => {
  it('按 order 拼接非空字段 label: value', () => {
    const record = makeRecord({
      fields: {
        total_amount: { value: 9.9, uncertain: false },
        invoice_code: { value: null, uncertain: false }
      }
    })
    expect(summarizeDocument(record)).toBe('价税合计: 9.9')
  })
})

describe('buildDocumentsCsv', () => {
  it('单类型导出：固定列 + 模板字段列（label 表头，order 排序）', () => {
    const csv = buildDocumentsCsv({
      documents: [makeRecord()],
      templateFields: makeRecord().templateSnapshot.fields,
      templateNameById: new Map([['tpl-1', '增值税专用发票']])
    })
    const lines = csv.split('\r\n')
    expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true)
    expect(lines[0]).toBe(
      `${String.fromCharCode(0xfeff)}id,type,source,status,createdAt,updatedAt,发票代码,价税合计`
    )
    expect(lines[1]).toBe(
      'd1,增值税专用发票,manual,draft,2023-11-14T22:13:20.000Z,2023-11-14T22:15:00.000Z,12345,100.5'
    )
  })

  it('全类型导出：summary 列 + 类型列回退 typeKey', () => {
    const csv = buildDocumentsCsv({
      documents: [
        makeRecord({ templateId: 'unknown-tpl', typeKey: 'unknown-tpl' }),
        makeRecord({ id: 'd2' })
      ],
      templateFields: null,
      templateNameById: new Map([['tpl-1', '增值税专用发票']])
    })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(
      `${String.fromCharCode(0xfeff)}id,type,source,status,createdAt,updatedAt,summary`
    )
    expect(lines[1]).toContain('unknown-tpl')
    expect(lines[2]).toContain('发票代码: 12345; 价税合计: 100.5')
  })

  it('字段值含逗号时正确转义', () => {
    const csv = buildDocumentsCsv({
      documents: [makeRecord({ fields: { invoice_code: { value: 'a,b', uncertain: false } } })],
      templateFields: makeRecord().templateSnapshot.fields,
      templateNameById: new Map([['tpl-1', 'x']])
    })
    expect(csv).toContain('"a,b"')
  })
})
