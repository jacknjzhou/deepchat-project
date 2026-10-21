import * as XLSX from 'xlsx'
import type { DocumentRecord } from '@shared/documents'
import type { ReimbursementDocumentEntry } from './reimbursement'

// 公式注入防护：与 reimbursementExport.ts 的 FORMULA_PREFIX_RE 保持同一规则
// eslint-disable-next-line no-control-regex
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/

const safeText = (value: string): string =>
  FORMULA_PREFIX_RE.test(value) ? `'${value}` : value

/** 金额解析：有限数值直接用；数字字符串转数值；其余返回 null */
export const parseMoney = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const fieldText = (document: DocumentRecord | undefined, key: string): string => {
  const raw = document?.fields[key]?.value
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'object') return JSON.stringify(raw)
  return String(raw)
}

interface MoneyCell {
  parsed: number | null
  text: string   // 解析失败时的原始文本（供单元格回退展示）
  uncertain: boolean
}

const fieldMoney = (document: DocumentRecord | undefined, key: string): MoneyCell => {
  const field = document?.fields[key]
  const raw = field?.value
  const parsed = parseMoney(raw)
  const text =
    parsed === null && raw !== null && raw !== undefined && typeof raw !== 'object'
      ? String(raw)
      : ''
  // 提取器 uncertain 标记，或存在无法解析的非空金额文本，均视为存疑
  const uncertain = field?.uncertain === true || text !== ''
  return { parsed, text, uncertain }
}

const round2 = (value: number): number => Number(value.toFixed(2))

export interface InvoiceRowInput {
  entry: ReimbursementDocumentEntry
  document: DocumentRecord | undefined
  fileRelPaths: string[]
}

export interface InvoiceRow {
  invoiceNumber: string
  invoiceDate: string
  sellerName: string
  sellerTaxNo: string
  buyerName: string
  buyerTaxNo: string
  totalAmount: number | string | null
  taxAmount: number | string | null
  amountExTax: number | string | null
  taxRate: string
  uncertain: boolean
  remark: string
  fileRelPath: string
}

export function buildInvoiceRow(input: InvoiceRowInput): InvoiceRow {
  const { entry, document, fileRelPaths } = input
  const total = fieldMoney(document, 'total_amount')
  const tax = fieldMoney(document, 'tax_amount')
  const exTax = fieldMoney(document, 'amount_ex_tax')
  const uncertain =
    entry.amountUncertain || total.uncertain || tax.uncertain || exTax.uncertain
  return {
    invoiceNumber: fieldText(document, 'invoice_number'),
    invoiceDate: fieldText(document, 'invoice_date'),
    sellerName: fieldText(document, 'seller_name'),
    sellerTaxNo: fieldText(document, 'seller_tax_no'),
    buyerName: fieldText(document, 'buyer_name'),
    buyerTaxNo: fieldText(document, 'buyer_tax_no'),
    totalAmount: total.parsed ?? (total.text === '' ? null : total.text),
    taxAmount: tax.parsed ?? (tax.text === '' ? null : tax.text),
    amountExTax: exTax.parsed ?? (exTax.text === '' ? null : exTax.text),
    taxRate: fieldText(document, 'tax_rate'),
    uncertain,
    remark: fieldText(document, 'invoice_remark'),
    fileRelPath: fileRelPaths.join('、')
  }
}

const INVOICE_HEADER = [
  '序号', '发票号码', '开票日期', '销售方名称', '销售方税号', '购买方名称',
  '购买方税号', '价税合计', '税额', '不含税金额', '税率', '金额存疑', '备注', '文件相对路径'
] as const

type MoneyKey = 'totalAmount' | 'taxAmount' | 'amountExTax'

const moneyCell = (row: InvoiceRow, key: MoneyKey): string | number => {
  const value = row[key]
  if (value === null) return ''
  return typeof value === 'number' ? value : safeText(value)
}

const columnSum = (rows: InvoiceRow[], key: MoneyKey): string | number => {
  const sum = rows.reduce<number>(
    (acc, row) => acc + (typeof row[key] === 'number' ? (row[key] as number) : 0),
    0
  )
  // 无任何可累加数值时留空，避免展示 0 造成歧义
  return rows.some((row) => typeof row[key] === 'number') ? round2(sum) : ''
}

const dataRow = (row: InvoiceRow, index: number): Array<string | number> => [
  index + 1,
  safeText(row.invoiceNumber),
  safeText(row.invoiceDate),
  safeText(row.sellerName),
  safeText(row.sellerTaxNo),
  safeText(row.buyerName),
  safeText(row.buyerTaxNo),
  moneyCell(row, 'totalAmount'),
  moneyCell(row, 'taxAmount'),
  moneyCell(row, 'amountExTax'),
  safeText(row.taxRate),
  row.uncertain ? '是' : '',
  safeText(row.remark),
  safeText(row.fileRelPath)
]

export function serializeInvoiceWorkbook(rows: InvoiceRow[]): Uint8Array {
  const body = rows.map(dataRow)
  const totalRow: Array<string | number> = [
    '合计', '', '', '', '', '', '',
    columnSum(rows, 'totalAmount'),
    columnSum(rows, 'taxAmount'),
    columnSum(rows, 'amountExTax'),
    '', '', '', ''
  ]
  const sheet = XLSX.utils.aoa_to_sheet([INVOICE_HEADER, ...body, totalRow])
  sheet['!cols'] = [
    { wch: 6 }, { wch: 22 }, { wch: 12 }, { wch: 30 }, { wch: 22 }, { wch: 30 },
    { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 10 },
    { wch: 30 }, { wch: 40 }
  ]
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, '发票汇总')
  const out = XLSX.write(book, { type: 'array', bookType: 'xlsx' })
  return out as Uint8Array
}
