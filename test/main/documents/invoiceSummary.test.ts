import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import type { DocumentRecord } from '@shared/documents'
import type { ReimbursementDocumentEntry } from '../../../src/main/documents/reimbursement'
import {
  buildInvoiceRow,
  parseMoney,
  serializeInvoiceWorkbook
} from '../../../src/main/documents/invoiceSummary'

const makeEntry = (overrides?: Partial<ReimbursementDocumentEntry>): ReimbursementDocumentEntry => ({
  id: 'doc-1',
  typeKey: 'invoice_vat_special',
  templateName: '增值税专用发票',
  person: null,
  period: '2026-09',
  amount: 100,
  amountUncertain: false,
  uncertainCount: 0,
  fileNames: ['a.pdf'],
  isOverride: false,
  groupId: 'grp-1',
  ...overrides
})

const makeDocument = (fields: Record<string, { value: unknown; uncertain?: boolean }>): DocumentRecord =>
  ({
    id: 'doc-1',
    templateId: 'tpl-1',
    typeKey: 'invoice_vat_special',
    source: 'upload',
    status: 'recognized',
    createdAt: 0,
    updatedAt: 0,
    fileUris: [],
    templateSnapshot: { fields: [] },
    fields
  }) as unknown as DocumentRecord

describe('parseMoney', () => {
  it('accepts finite numbers and numeric strings', () => {
    expect(parseMoney(100.5)).toBe(100.5)
    expect(parseMoney('1234.56')).toBe(1234.56)
  })
  it('rejects non-numeric and empty values', () => {
    expect(parseMoney('叁万元整')).toBeNull()
    expect(parseMoney('')).toBeNull()
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
    expect(parseMoney({})).toBeNull()
  })
})

describe('buildInvoiceRow', () => {
  it('maps fields and parses money to numbers', () => {
    const row = buildInvoiceRow({
      entry: makeEntry(),
      document: makeDocument({
        invoice_number: { value: '24312000000012345678' },
        invoice_date: { value: '2026-09-15' },
        seller_name: { value: '甲公司' },
        seller_tax_no: { value: '91330100MA2XXXXXXX' },
        buyer_name: { value: '乙公司' },
        buyer_tax_no: { value: '91330100MA2YYYYYYY' },
        total_amount: { value: 11300 },
        tax_amount: { value: '1300' },
        amount_ex_tax: { value: 10000 },
        tax_rate: { value: '13%' },
        invoice_remark: { value: '办公设备' }
      }),
      fileRelPaths: ['2026-09/a.pdf']
    })
    expect(row.invoiceNumber).toBe('24312000000012345678')
    expect(row.invoiceDate).toBe('2026-09-15')
    expect(row.sellerName).toBe('甲公司')
    expect(row.sellerTaxNo).toBe('91330100MA2XXXXXXX')
    expect(row.buyerName).toBe('乙公司')
    expect(row.buyerTaxNo).toBe('91330100MA2YYYYYYY')
    expect(row.totalAmount).toBe(11300)
    expect(row.taxAmount).toBe(1300)
    expect(row.amountExTax).toBe(10000)
    expect(row.taxRate).toBe('13%')
    expect(row.uncertain).toBe(false)
    expect(row.remark).toBe('办公设备')
    expect(row.fileRelPath).toBe('2026-09/a.pdf')
  })

  it('marks uncertain when a money field fails to parse', () => {
    const row = buildInvoiceRow({
      entry: makeEntry(),
      document: makeDocument({ total_amount: { value: '叁万元整' } }),
      fileRelPaths: []
    })
    expect(row.totalAmount).toBe('叁万元整')
    expect(row.uncertain).toBe(true)
  })

  it('marks uncertain when the extractor flagged the field or entry amount', () => {
    const flagged = buildInvoiceRow({
      entry: makeEntry({ amountUncertain: true }),
      document: makeDocument({ total_amount: { value: 100, uncertain: true } }),
      fileRelPaths: []
    })
    expect(flagged.uncertain).toBe(true)
  })

  it('keeps tax numbers as text and leaves missing tax numbers empty', () => {
    const row = buildInvoiceRow({
      entry: makeEntry(),
      document: makeDocument({ seller_tax_no: { value: '91330100MA2XXXXXXX' } }),
      fileRelPaths: []
    })
    expect(row.sellerTaxNo).toBe('91330100MA2XXXXXXX')
    expect(row.buyerTaxNo).toBe('')
  })

  it('falls back to missing-file markers and joins multiple paths', () => {
    const row = buildInvoiceRow({
      entry: makeEntry({ fileNames: ['a.pdf', 'b.pdf'] }),
      document: undefined,
      fileRelPaths: ['2026-09/a-1.pdf', '缺失:b.pdf']
    })
    expect(row.fileRelPath).toBe('2026-09/a-1.pdf、缺失:b.pdf')
  })
})

describe('serializeInvoiceWorkbook', () => {
  const readSheet = (rows: Parameters<typeof serializeInvoiceWorkbook>[0]) => {
    const book = XLSX.read(serializeInvoiceWorkbook(rows), { type: 'array' })
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['发票汇总']!, {
      header: 1,
      raw: true
    })
  }

  it('returns writable Uint8Array data and writes header, numbered data rows and a totals row', () => {
    const rows = [
      buildInvoiceRow({
        entry: makeEntry(),
        document: makeDocument({
          invoice_number: { value: '11111111' },
          total_amount: { value: 113 },
          tax_amount: { value: 13 },
          amount_ex_tax: { value: 100 }
        }),
        fileRelPaths: ['2026-09/a.pdf']
      }),
      buildInvoiceRow({
        entry: makeEntry({ id: 'doc-2' }),
        document: makeDocument({
          invoice_number: { value: '22222222' },
          total_amount: { value: 226 },
          tax_amount: { value: 26 },
          amount_ex_tax: { value: 200 }
        }),
        fileRelPaths: ['2026-09/b.pdf']
      })
    ]
    const serialized = serializeInvoiceWorkbook(rows)
    expect(serialized).toBeInstanceOf(Uint8Array)
    expect(() => Buffer.from(serialized)).not.toThrow()
    const grid = readSheet(rows)
    expect(grid[0]).toEqual([
      '序号', '发票号码', '开票日期', '销售方名称', '销售方税号', '购买方名称',
      '购买方税号', '价税合计', '税额', '不含税金额', '税率', '金额存疑', '备注', '文件相对路径'
    ])
    expect(grid[1]![0]).toBe(1)
    expect(grid[1]![1]).toBe('11111111')
    expect(grid[1]![7]).toBe(113)
    expect(grid[2]![0]).toBe(2)
    expect(grid[3]![0]).toBe('合计')
    expect(grid[3]![7]).toBe(339)
    expect(grid[3]![8]).toBe(39)
    expect(grid[3]![9]).toBe(300)
    expect(grid[3]![10]).toBe('') // 税率列不合计
  })

  it('sums only numeric money cells and leaves the totals blank when none parse', () => {
    const grid = readSheet([
      buildInvoiceRow({
        entry: makeEntry(),
        document: makeDocument({ total_amount: { value: '叁万元整' } }),
        fileRelPaths: []
      })
    ])
    expect(grid[1]![7]).toBe('叁万元整')
    expect(grid[2]![7]).toBe('') // 合计行：无可累加数值则留空
  })

  it('sanitizes formula-prefixed text cells', () => {
    const grid = readSheet([
      buildInvoiceRow({
        entry: makeEntry(),
        document: makeDocument({ seller_name: { value: '=SUM(A1)' } }),
        fileRelPaths: []
      })
    ])
    expect(grid[1]![3]).toBe("'=SUM(A1)")
  })

  it('marks the uncertain column as 是 for a flagged row', () => {
    const grid = readSheet([
      buildInvoiceRow({
        entry: makeEntry({ amountUncertain: true }),
        document: makeDocument({ total_amount: { value: 100, uncertain: true } }),
        fileRelPaths: []
      })
    ])
    expect(grid[1]![11]).toBe('是')
  })
})
