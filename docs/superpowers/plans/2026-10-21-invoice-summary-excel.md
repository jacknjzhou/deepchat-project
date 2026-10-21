# 发票分组汇总 Excel 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出「文件分组」整理包时，为含发票类单据的自定义分组在其目录内自动生成 `发票汇总.xlsx`（14 列固定核心列 + 合计行），随导出包一并交付。

**Architecture:** 纯函数模块 `invoiceSummary.ts`（行构建 + SheetJS 序列化）+ `reimbursementExport.ts` 流程集成（deps 注入二进制写入、记录实际导出路径、customGroups 聚合生成）+ 导出契约/路由接线 + renderer toast。无数据库改动、无新增依赖。

**Tech Stack:** TypeScript（Electron 主进程）、`xlsx`（SheetJS 0.20.3，已有依赖）、Vitest、vue-i18n（20 locale）。

**Spec:** `docs/superpowers/specs/2026-10-21-invoice-summary-excel-design.md`

## Global Constraints

- 不新增任何 npm 依赖（`xlsx` 已在 `package.json` dependencies）
- 不改 `ReimbursementDocumentEntry` 结构（发票判定用 `entry.typeKey`，不用 templateId）
- 不改数据库 schema、不注册 schemaCatalog（纯导出侧能力）
- 现有 `汇总.csv` 逻辑保持不变（并存）
- 仅自定义分组（`customGroups`）生成 Excel；普通「人员→期间」分组与未分类不生成；分组无发票条目不生成
- 文本单元格公式消毒：`= + - @ \t \r` 开头前置单引号（与 `reimbursementExport.ts` 的 `FORMULA_PREFIX_RE` 同规则）
- 金额列数值单元格；解析失败转文本 + 该行「金额存疑」列标「是」
- Excel 写入失败不中断导出（记入 `issues`）
- locale 覆盖全部 20 个：`da-DK de-DE en-US es-ES fa-IR fr-FR he-IL id-ID it-IT ja-JP ko-KR ms-MY pl-PL pt-BR ru-RU tr-TR vi-VN zh-CN zh-HK zh-TW`（`src/renderer/src/i18n/<locale>/settings.json`）
- 发票判定：模板 `category === '发票类'`（`documentTemplateCategorySchema` 为自由字符串，无枚举约束）
- 测试命令：`pnpm exec vitest run <file>`；全量回归 `pnpm run test:main`；locale 校验 `pnpm run i18n:validate`
- 提交信息用 conventional commits（`feat(documents): ...`）

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/main/documents/invoiceSummary.ts` | 新建 | 发票行构建（字段取值/金额解析/存疑口径）+ xlsx 序列化（含合计行、列宽、消毒） |
| `test/main/documents/invoiceSummary.test.ts` | 新建 | 纯函数单测 |
| `src/main/documents/reimbursementExport.ts` | 修改 | deps 增 `writeFileBinary`；input 增 `documentsById`/`invoiceTypeKeys`；记录实际导出相对路径；customGroups 聚合写 Excel；output 增 `invoiceSummaries` |
| `test/main/documents/documentsRoutes.test.ts` | 修改 | `reimbursementExport` describe 块扩展集成测试 |
| `src/shared/contracts/routes/documents.routes.ts` | 修改 | `documentsReimbursementExportRoute.output` 增可选 `invoiceSummaries` |
| `src/main/documents/routes.ts` | 修改 | 导出处理器构建 `documentsById`/`invoiceTypeKeys` 并传入；deps 增二进制写入 |
| `src/renderer/src/pages/documents/ReimbursementView.vue` | 修改 | 导出成功 toast 增加「发票汇总 N 份」分支 |
| `test/renderer/components/ReimbursementView.test.ts` | 修改 | toast 断言测试 |
| `src/renderer/src/i18n/<locale>/settings.json` × 20 | 修改 | `documents.reimbursement` 下新增 `exportDoneWithInvoices` |

---

### Task 1: `invoiceSummary.ts` 纯函数 + 单测

**Files:**
- Create: `src/main/documents/invoiceSummary.ts`
- Test: `test/main/documents/invoiceSummary.test.ts`

**Interfaces:**
- Consumes: `ReimbursementDocumentEntry`（`./reimbursement`，字段 `typeKey/fileNames/amountUncertain`）；`DocumentRecord`（`@shared/documents`，`fields: Record<string, DocumentFieldEntry>`，`DocumentFieldEntry = { value: unknown; uncertain: boolean }`）
- Produces: `parseMoney(value: unknown): number | null`；`buildInvoiceRow(input: InvoiceRowInput): InvoiceRow`；`serializeInvoiceWorkbook(rows: InvoiceRow[]): Uint8Array`。类型：

```ts
export interface InvoiceRowInput {
  entry: ReimbursementDocumentEntry
  document: DocumentRecord | undefined   // documentsById 取不到时降级为空字段
  fileRelPaths: string[]                 // 调用方提供：实际导出相对路径或 '缺失:文件名' 标记
}

export interface InvoiceRow {
  invoiceNumber: string
  invoiceDate: string
  sellerName: string
  sellerTaxNo: string
  buyerName: string
  buyerTaxNo: string
  totalAmount: number | string | null    // 数值解析成功为 number，失败为原始文本，缺失为 null
  taxAmount: number | string | null
  amountExTax: number | string | null
  taxRate: string
  uncertain: boolean                     // 金额存疑（见下）
  remark: string
  fileRelPath: string                    // 多文件以 '、' 连接
}
```

- [ ] **Step 1: 写失败测试**

创建 `test/main/documents/invoiceSummary.test.ts`。测试通过「写入 → `XLSX.read` 回读 → `sheet_to_json` 校验」验证序列化内容：

```ts
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

  it('writes header, numbered data rows and a totals row', () => {
    const grid = readSheet([
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
    ])
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/invoiceSummary.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/documents/invoiceSummary.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/invoiceSummary.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/documents/invoiceSummary.ts test/main/documents/invoiceSummary.test.ts
git commit -m "feat(documents): add invoice summary row builder and xlsx serializer"
```

---

### Task 2: `reimbursementExport.ts` 集成 + 集成测试扩展

**Files:**
- Modify: `src/main/documents/reimbursementExport.ts`
- Test: `test/main/documents/documentsRoutes.test.ts`（`describe('reimbursementExport', ...)` 块，约 1522 行起）

**Interfaces:**
- Consumes: Task 1 的 `buildInvoiceRow`/`serializeInvoiceWorkbook`；`ReimbursementDocumentEntry`/`ReimbursementTreeResult`（现有）；`DocumentRecord`（`@shared/documents`）
- Produces:
  - `ReimbursementExportDeps` 增 `writeFileBinary: (file: string, data: Uint8Array) => Promise<void>`
  - `ReimbursementExportInput` 增可选 `documentsById?: Map<string, DocumentRecord>` 与 `invoiceTypeKeys?: Set<string>`（缺省为空 → 不生成 Excel，保持旧调用兼容）
  - `ReimbursementExportOutput` 增 `invoiceSummaries: string[]`（包内相对路径，`/` 分隔）

- [ ] **Step 1: 写失败测试**

在 `test/main/documents/documentsRoutes.test.ts` 的 `reimbursementExport` describe 块内追加（复用现有 `makeHarness`/`runExport` helper；先扩展 harness 支持 `writeFileBinary` 与自定义分组树）：

扩展 `makeHarness`（约 1565 行）：

```ts
  const makeHarness = (options?: { existsMatches?: (target: string) => boolean }) => {
    const mkdirs: string[] = []
    const copied: Array<{ src: string; dest: string }> = []
    const written: Array<{ file: string; data: string }> = []
    const binaryWrites: Array<{ file: string; data: Uint8Array }> = []
    const deps: ReimbursementExportDeps = {
      copyFile: async (src, dest) => {
        copied.push({ src, dest })
      },
      mkdir: async (dir) => {
        mkdirs.push(dir)
        return undefined
      },
      writeFile: async (file, data) => {
        written.push({ file, data })
      },
      writeFileBinary: async (file, data) => {
        binaryWrites.push({ file, data })
      },
      exists: async (target) => options?.existsMatches?.(target) ?? false
    }
    return { deps, mkdirs, copied, written, binaryWrites }
  }
```

> 注意：现有 harness 的 `deps` 对象缺少新增的 `writeFileBinary` 会导致类型错误——此扩展同时修复编译。`runExport` 需支持透传新入参：

```ts
  const runExport = async (
    harness: Harness,
    result: ReimbursementTreeResult,
    filesById: Map<string, string[]>,
    extra?: {
      documentsById?: Map<string, DocumentRecord>
      invoiceTypeKeys?: Set<string>
    }
  ) =>
    exportReimbursementPackage({
      rootDir: 'export-root',
      result,
      filesById,
      deps: harness.deps,
      now: EXPORT_NOW,
      ...extra
    })
```

> `DocumentRecord` 如未导入则从 `@shared/documents` 补充 import。构造带发票条目的自定义分组树 fixture：

```ts
  const makeCustomGroupTree = (): ReimbursementTreeResult => ({
    tree: [
      {
        category: {
          id: 'cat-1',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          customGroups: [],
          sortOrder: 1
        },
        total: 2,
        materials: [],
        groups: [],
        customGroups: [
          {
            group: { id: 'grp-a', name: '重点会议', sortOrder: 0 },
            buckets: [
              {
                period: '2026-09',
                documents: [
                  makeEntry('张三'),
                  {
                    ...makeEntry('李四'),
                    id: 'doc-inv',
                    typeKey: 'invoice_vat_special',
                    templateName: '增值税专用发票',
                    amount: 113,
                    fileNames: ['发票A.pdf']
                  }
                ]
              },
              {
                period: '2026-10',
                documents: [
                  {
                    ...makeEntry('王五'),
                    id: 'doc-inv-2',
                    typeKey: 'invoice_vat_special',
                    templateName: '增值税专用发票',
                    amount: 226,
                    fileNames: ['发票B.pdf']
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    unassigned: [],
    summary: []
  })

  const invoiceDocument = (id: string, fields: Record<string, { value: unknown }>): DocumentRecord =>
    ({
      id,
      templateId: 'tpl-inv',
      typeKey: 'invoice_vat_special',
      source: 'upload',
      status: 'recognized',
      createdAt: 0,
      updatedAt: 0,
      fileUris: [],
      templateSnapshot: { fields: [] },
      fields
    }) as unknown as DocumentRecord

  const INVOICE_FIELDS = {
    invoice_number: { value: '24312000000012345678' },
    invoice_date: { value: '2026-09-15' },
    seller_name: { value: '甲公司' },
    seller_tax_no: { value: '91330100MA2XXXXXXX' },
    buyer_name: { value: '乙公司' },
    buyer_tax_no: { value: '91330100MA2YYYYYYY' },
    total_amount: { value: 113 },
    tax_amount: { value: 13 },
    amount_ex_tax: { value: 100 },
    tax_rate: { value: '13%' }
  }
```

追加测试用例（使用 `XLSX.read` 回读验证，import 语句置于文件顶部已有 import 区）：

```ts
describe('reimbursementExport invoice summaries', () => {
  const readInvoiceSheet = (data: Uint8Array) => {
    const book = XLSX.read(data, { type: 'array' })
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['发票汇总']!, { header: 1 })
  }

  it('writes an invoice summary xlsx inside the custom group directory', async () => {
    const harness = makeHarness()
    const output = await runExport(harness, makeCustomGroupTree(), new Map(), {
      documentsById: new Map([
        ['doc-inv', invoiceDocument('doc-inv', INVOICE_FIELDS)],
        ['doc-inv-2', invoiceDocument('doc-inv-2', { ...INVOICE_FIELDS, invoice_number: { value: '22222222' } })]
      ]),
      invoiceTypeKeys: new Set(['invoice_vat_special'])
    })
    const write = harness.binaryWrites.find((item) => item.file.endsWith(join('会议费', '重点会议', '发票汇总.xlsx')))
    expect(write).toBeDefined()
    const grid = readInvoiceSheet(write!.data)
    expect(grid[0]![7]).toBe('价税合计')
    expect(grid[1]![1]).toBe('24312000000012345678')
    expect(grid[1]![12]).toBe('2026-09/发票A.pdf') // 文件相对路径列
    expect(grid[2]![12]).toBe('2026-10/发票B.pdf') // 跨期间聚合进同一份
    expect(grid[3]![0]).toBe('合计')
    expect(grid[3]![7]).toBe(339)
    expect(output.invoiceSummaries).toEqual(['会议费/重点会议/发票汇总.xlsx'])
    expect(output.issues).toEqual([])
  })

  it('skips the summary when the group has no invoice documents', async () => {
    const harness = makeHarness()
    const output = await runExport(
      harness,
      { ...makeCustomGroupTree(), tree: [{ ...makeCustomGroupTree().tree[0]!, customGroups: [{ group: { id: 'grp-a', name: '重点会议', sortOrder: 0 }, buckets: [{ period: '2026-09', documents: [makeEntry('张三')] }] }] }] },
      new Map(),
      { documentsById: new Map(), invoiceTypeKeys: new Set(['invoice_vat_special']) }
    )
    expect(harness.binaryWrites).toEqual([])
    expect(output.invoiceSummaries).toEqual([])
  })

  it('does not generate summaries without invoiceTypeKeys (backward compatible)', async () => {
    const harness = makeHarness()
    const output = await runExport(harness, makeCustomGroupTree(), new Map())
    expect(harness.binaryWrites).toEqual([])
    expect(output.invoiceSummaries).toEqual([])
  })

  it('keeps missing-file markers in the path column and still counts the money', async () => {
    const harness = makeHarness({ existsMatches: () => false })
    const tree = makeCustomGroupTree()
    tree.tree[0]!.customGroups[0]!.buckets[0]!.documents[1]!.fileNames = [] // 发票A.pdf 无源文件映射
    const output = await runExport(harness, tree, new Map(), {
      documentsById: new Map([['doc-inv', invoiceDocument('doc-inv', INVOICE_FIELDS)]]),
      invoiceTypeKeys: new Set(['invoice_vat_special'])
    })
    const write = harness.binaryWrites.find((item) => item.file.endsWith('发票汇总.xlsx'))
    const grid = readInvoiceSheet(write!.data)
    // fileNames 为空 → 行存在但路径列为空；金额照计
    expect(grid[1]![7]).toBe(113)
    expect(output.issues).toContain('缺失:发票A.pdf')
  })

  it('records an issue instead of failing the export when xlsx write throws', async () => {
    const harness = makeHarness()
    harness.deps.writeFileBinary = async () => {
      throw new Error('disk full')
    }
    const output = await runExport(harness, makeCustomGroupTree(), new Map(), {
      documentsById: new Map([['doc-inv', invoiceDocument('doc-inv', INVOICE_FIELDS)]]),
      invoiceTypeKeys: new Set(['invoice_vat_special'])
    })
    expect(output.issues).toEqual([expect.stringContaining('汇总失败')])
    expect(output.invoiceSummaries).toEqual([])
  })
})
```

> 若 `makeCustomGroupTree` 的 category 结构需要满足 `ReimbursementConfig['categories'][number]` 的完整字段（以 `src/main/documents/reimbursement.ts` 的类型定义为准），以现有 `makeTreeResult` 的 category 写法为模板补齐缺省字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts`
Expected: FAIL（`writeFileBinary` 缺失 / `invoiceSummaries` 不存在）

- [ ] **Step 3: 修改 `src/main/documents/reimbursementExport.ts`**

完整改动（基于现有 195 行文件）：

```ts
import path from 'node:path'
import { escapeCsvCell } from './csv'
import type { DocumentRecord } from '@shared/documents'
import type { ReimbursementTreeResult } from './reimbursement'
import { buildInvoiceRow, serializeInvoiceWorkbook } from './invoiceSummary'
```

接口扩展：

```ts
export interface ReimbursementExportDeps {
  copyFile: (src: string, dest: string) => Promise<void>
  mkdir: (dir: string, options: { recursive: true }) => Promise<string | undefined>
  writeFile: (file: string, data: string, encoding: 'utf-8') => Promise<void>
  writeFileBinary: (file: string, data: Uint8Array) => Promise<void>
  exists: (target: string) => Promise<boolean>
}

export interface ReimbursementExportInput {
  rootDir: string
  result: ReimbursementTreeResult
  filesById: Map<string, string[]>
  deps: ReimbursementExportDeps
  /** 发票行构建所需的文档字段映射；缺省视为空（不生成汇总） */
  documentsById?: Map<string, DocumentRecord>
  /** 发票模板 typeKey 集合；缺省视为空集（不生成汇总） */
  invoiceTypeKeys?: Set<string>
  now?: Date
}

export interface ReimbursementExportOutput {
  path: string
  exportedFiles: number
  summaryPath: string
  issues: string[]
  /** 生成的发票汇总 Excel 相对路径（'/' 分隔） */
  invoiceSummaries: string[]
}
```

`exportReimbursementPackage` 内（`const { rootDir, result, filesById, deps, now = new Date() } = input` 处扩展解构）：

```ts
  const { rootDir, result, filesById, deps, now = new Date() } = input
  const documentsById = input.documentsById ?? new Map<string, DocumentRecord>()
  const invoiceTypeKeys = input.invoiceTypeKeys ?? new Set<string>()
  const exportedRelPathsById = new Map<string, string[]>()
  const invoiceSummaries: string[] = []
```

`writeEntries` 内循环（`for (const entry of bucket.documents)` 中，两处 `rows.push` 调用前）记录实际导出路径——在 `const files = filesById.get(entry.id) ?? []` 后初始化收集器，在每个文件的分支中追加：

```ts
      for (const entry of bucket.documents) {
        const personCell = entry.person ?? UNKNOWN_PERSON
        const files = filesById.get(entry.id) ?? []
        const entryRelPaths: string[] = []
        exportedRelPathsById.set(entry.id, entryRelPaths)
        for (let index = 0; index < entry.fileNames.length; index += 1) {
          const source = files[index]
          const originalName = entry.fileNames[index]
          if (!source) {
            issues.push(`缺失:${originalName}`)
            entryRelPaths.push(`缺失:${originalName}`)
            rows.push(/* 原有缺失分支不变 */)
            continue
          }
          const fileName = await uniqueFileName(targetDir, originalName, deps)
          try {
            await deps.copyFile(source, path.join(targetDir, fileName))
            exportedFiles += 1
            entryRelPaths.push(`${periodDirName}/${fileName}`)
            rows.push(/* 原有成功分支不变 */)
          } catch {
            issues.push(`复制失败:${originalName}`)
            entryRelPaths.push(`缺失:${originalName}`)
            rows.push(/* 原有失败分支不变 */)
          }
        }
      }
```

customGroups 循环处（约 172-179 行）改为：

```ts
    for (const customGroup of node.customGroups) {
      const groupDirName = sanitizeDirName(customGroup.group.name)
      await writeEntries(categoryName, groupDirName, customGroup.buckets, customGroup.group.name)
      const entries = customGroup.buckets.flatMap((bucket) => bucket.documents)
      const invoiceEntries = entries.filter((entry) => invoiceTypeKeys.has(entry.typeKey))
      if (invoiceEntries.length === 0) continue
      const rowsForGroup = invoiceEntries.map((entry) =>
        buildInvoiceRow({
          entry,
          document: documentsById.get(entry.id),
          fileRelPaths: exportedRelPathsById.get(entry.id) ?? entry.fileNames.map((name) => `缺失:${name}`)
        })
      )
      const targetDir = path.join(packageDir, categoryName, groupDirName)
      const summaryName = await uniqueFileName(targetDir, '发票汇总.xlsx', deps)
      try {
        await deps.writeFileBinary(
          path.join(targetDir, summaryName),
          serializeInvoiceWorkbook(rowsForGroup)
        )
        invoiceSummaries.push([categoryName, groupDirName, summaryName].join('/'))
      } catch {
        issues.push(`汇总失败:${summaryName}`)
      }
    }
```

返回值（函数末尾）：

```ts
  return { path: packageDir, exportedFiles, summaryPath, issues, invoiceSummaries }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts`
Expected: PASS（新增用例 + 既有 `reimbursementExport`/`routes` 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/documents/reimbursementExport.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): generate per-group invoice summary xlsx during export"
```

---

### Task 3: 契约 + 路由接线

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts:546-556`（`documentsReimbursementExportRoute` output）
- Modify: `src/main/documents/routes.ts:443-527`（导出处理器）

**Interfaces:**
- Consumes: Task 2 的 `ReimbursementExportInput`（`documentsById`/`invoiceTypeKeys`）；`repository.listTemplates(): DocumentTemplate[]`（含 `typeKey`/`category`）
- Produces: 导出路由 output 契约增 `invoiceSummaries?: string[]`；renderer 侧类型随契约自动生效

- [ ] **Step 1: 更新契约**

`src/shared/contracts/routes/documents.routes.ts` 的 `documentsReimbursementExportRoute.output`（546-555 行）：

```ts
  output: z
    .object({
      canceled: z.boolean(),
      path: z.string().min(1).optional(),
      exportedFiles: z.number().int().nonnegative().optional(),
      summaryPath: z.string().min(1).optional(),
      invoiceSummaries: z.array(z.string().min(1)).optional()
    })
    .refine((value) => value.canceled || typeof value.path === 'string', {
      message: 'path is required when not canceled'
    })
```

- [ ] **Step 2: 接线导出处理器**

`src/main/documents/routes.ts` 导出处理器（443 行起的 handler 内）：

deps 对象（约 506-514 行）增加二进制写入：

```ts
          deps: {
            copyFile: (src, dest) => fsp.copyFile(src, dest),
            mkdir: (dir, options) => fsp.mkdir(dir, options),
            writeFile: (file, data, encoding) => fsp.writeFile(file, data, encoding),
            writeFileBinary: (file, data) => fsp.writeFile(file, data),
            exists: async (target) => { /* 原有实现不变 */ }
          },
```

在 `const filesById = ...`（约 501 行）旁增加：

```ts
        const documentsById = new Map(documents.map((document) => [document.id, document]))
        const invoiceTypeKeys = new Set(
          repository
            .listTemplates()
            .filter((template) => template.category === '发票类')
            .map((template) => template.typeKey)
        )
```

`exportReimbursementPackage` 调用（约 502 行）传入两个新入参：

```ts
        const output = await exportReimbursementPackage({
          rootDir,
          result: exportResult,
          filesById,
          documentsById,
          invoiceTypeKeys,
          deps: { /* 如上 */ }
        })
```

输出 parse（约 521-525 行）增加字段透传：

```ts
        return documentsReimbursementExportRoute.output.parse({
          path: output.path,
          exportedFiles: output.exportedFiles,
          summaryPath: output.summaryPath,
          invoiceSummaries: output.invoiceSummaries
        })
```

- [ ] **Step 3: 运行契约与路由测试**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts test/main/documents/documentsTableMigration.test.ts`
Expected: PASS（可选字段向后兼容，无契约破坏）

- [ ] **Step 4: 提交**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/main/documents/routes.ts
git commit -m "feat(documents): expose invoiceSummaries through the export route contract"
```

---

### Task 4: renderer toast + 20 locale

**Files:**
- Modify: `src/renderer/src/pages/documents/ReimbursementView.vue:495-502`（`onExport` 成功分支）
- Modify: `test/renderer/components/ReimbursementView.test.ts`（`exports package and notifies success once` 附近）
- Modify: `src/renderer/src/i18n/<locale>/settings.json` × 20

**Interfaces:**
- Consumes: Task 3 的 output 契约字段 `invoiceSummaries?: string[]`；现有 `notifyTransient(kind, code, title)`（`ReimbursementView.vue:350`，内部 `rendererNotificationManager.notify({ kind, code, title })`）
- Produces: locale key `settings.documents.reimbursement.exportDoneWithInvoices`（占位符 `{count} {invoices} {path}`）

- [ ] **Step 1: 写失败测试**

在 `test/renderer/components/ReimbursementView.test.ts` 的 `exports package and notifies success once`（172 行）之后追加：

```ts
  it('mentions invoice summaries in the export toast when present', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'exportReimbursementPackage').mockResolvedValue({
      canceled: false,
      path: 'D:\\pkg',
      exportedFiles: 3,
      invoiceSummaries: ['会议费/重点会议/发票汇总.xlsx']
    })
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-export"]').trigger('click')
    await flushPromises()
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        code: 'documents.reimbursement.exportSuccess',
        title: expect.stringContaining('1')
      })
    )
  })
```

> mock 返回值需满足 store 的返回类型（Task 3 契约已含 `invoiceSummaries`，若类型报错以契约推导类型为准）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts`
Expected: FAIL（title 仍为旧文案，不含发票汇总数量）

- [ ] **Step 3: 修改 `ReimbursementView.vue` 的 onExport**

```ts
    const result = await store.exportReimbursementPackage(selection)
    if (result.canceled) return
    const invoiceCount = result.invoiceSummaries?.length ?? 0
    notifyTransient(
      'success',
      'documents.reimbursement.exportSuccess',
      invoiceCount > 0
        ? t('settings.documents.reimbursement.exportDoneWithInvoices', {
            count: result.exportedFiles ?? 0,
            invoices: invoiceCount,
            path: result.path ?? ''
          })
        : t('settings.documents.reimbursement.exportDone', {
            count: result.exportedFiles ?? 0,
            path: result.path ?? ''
          })
    )
```

- [ ] **Step 4: 20 locale 增加 `exportDoneWithInvoices`**

在每份 `src/renderer/src/i18n/<locale>/settings.json` 中定位同级键 `"exportDone"`（`documents.reimbursement` 节点内，zh-CN 在 379 行附近），紧随其后插入 `"exportDoneWithInvoices"`。各 locale 文案（占位符 `{count}`/`{invoices}`/`{path}` 逐字保留）：

| locale | 值 |
|---|---|
| zh-CN | `导出完成：{count} 个文件，发票汇总 {invoices} 份，{path}` |
| zh-HK | `導出完成：{count} 個文件，發票匯總 {invoices} 份，{path}` |
| zh-TW | `匯出完成：{count} 個檔案，發票彙總 {invoices} 份，{path}` |
| en-US | `Export complete: {count} files, {invoices} invoice summaries, {path}` |
| ja-JP | `エクスポート完了：{count} 件のファイル、請求書サマリー {invoices} 件、{path}` |
| ko-KR | `내보내기 완료: 파일 {count}개, 인보이스 요약 {invoices}개, {path}` |
| de-DE | `Export abgeschlossen: {count} Dateien, {invoices} Rechnungsübersichten, {path}` |
| fr-FR | `Export terminé : {count} fichiers, {invoices} récapitulatifs de factures, {path}` |
| es-ES | `Exportación completada: {count} archivos, {invoices} resúmenes de facturas, {path}` |
| it-IT | `Esportazione completata: {count} file, {invoices} riepiloghi fatture, {path}` |
| pt-BR | `Exportação concluída: {count} arquivos, {invoices} resumos de faturas, {path}` |
| ru-RU | `Экспорт завершён: файлов — {count}, сводок счетов — {invoices}, {path}` |
| pl-PL | `Eksport zakończony: pliki — {count}, podsumowania faktur — {invoices}, {path}` |
| tr-TR | `Dışa aktarma tamamlandı: {count} dosya, {invoices} fatura özeti, {path}` |
| vi-VN | `Xuất hoàn tất: {count} tệp, {invoices} bản tóm tắt hóa đơn, {path}` |
| id-ID | `Ekspor selesai: {count} berkas, {invoices} ringkasan faktur, {path}` |
| ms-MY | `Eksport selesai: {count} fail, {invoices} ringkasan invois, {path}` |
| da-DK | `Eksport fuldført: {count} filer, {invoices} fakturaoversigter, {path}` |
| fa-IR | `خروجی کامل شد: {count} فایل، {invoices} خلاصه فاکتور، {path}` |
| he-IL | `הייצוא הושלם: {count} קבצים, {invoices} סיכומי חשבוניות, {path}` |

JSON 插入示例（zh-CN，注意前一行行尾补逗号）：

```json
      "exportDone": "导出完成：{count} 个文件，{path}",
      "exportDoneWithInvoices": "导出完成：{count} 个文件，发票汇总 {invoices} 份，{path}",
```

- [ ] **Step 5: 运行 renderer 测试与 locale 校验**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts && pnpm run i18n:validate`
Expected: PASS（i18n key 全 locale 齐全）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/pages/documents/ReimbursementView.vue test/renderer/components/ReimbursementView.test.ts src/renderer/src/i18n
git commit -m "feat(documents): show invoice summary count in the export toast (20 locales)"
```

---

### Task 5: 全量回归收尾

**Files:**
- 无新增/修改（验证性任务）

- [ ] **Step 1: 主进程测试回归**

Run: `pnpm run test:main`
Expected: PASS

- [ ] **Step 2: renderer 测试回归**

Run: `pnpm run test:renderer`
Expected: PASS

- [ ] **Step 3: 类型检查**

Run: `pnpm run typecheck:node`
Expected: PASS（若 `typecheck:web` 因 vue-tsc OOM 环境问题失败，单独跑 `pnpm exec vue-tsc --noEmit -p tsconfig.app.json --composite false` 复核；仍 OOM 则记录为环境限制并说明）

- [ ] **Step 4: lint**

Run: `pnpm run lint`
Expected: PASS

- [ ] **Step 5: 汇报**

汇总：新增文件、修改文件、测试结果、已知限制（如有）。

---

## Self-Review 结论

1. **Spec 覆盖**：§3 发票判定（Task 3 `invoiceTypeKeys`）✓；§4.1 纯函数（Task 1）✓；§4.2 集成与 `invoiceSummaries`（Task 2）✓ 含实施要点（uniqueFileName 消重后真实路径 `exportedRelPathsById`）；§4.3 合计行（Task 1）✓；§4.4 路由（Task 3）✓；§4.5 契约（Task 3）✓；§4.6 toast+locale（Task 4）✓；§7 测试计划（Task 1/2/4 各自覆盖）✓；§6 安全（公式消毒 Task 1、IO 失败 Task 2 用例、数值精度 `round2`）✓。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；locale 给出 20 份逐字文案。
3. **类型一致性**：`buildInvoiceRow(input: InvoiceRowInput)`、`serializeInvoiceWorkbook(rows: InvoiceRow[]): Uint8Array`、`writeFileBinary(file: string, data: Uint8Array)`、`invoiceSummaries: string[]` 在 Task 1/2/3/4 间签名一致；`ReimbursementExportInput` 新入参为可选 + 缺省空值，旧测试无需改动（仅 harness 补 `writeFileBinary`）。
