# 发票分组汇总 Excel 设计（文件分组导出能力增强）

日期：2026-10-21
状态：已确认（设计经用户确认，4 项澄清决策见 §2）

## 1. 背景与目标

「智能信息提取 → 文件分组」（自定义分组）下的分组可能包含发票类单据。当前导出整理包时仅有包根的 `汇总.csv`（单列金额），缺少分组维度的发票明细与金额合计。

**目标**：导出整理包时，对含发票类单据的自定义分组，自动在该分组目录内生成 `发票汇总.xlsx`，聚合该分组（跨期间目录）全部发票的关键信息与金额合计，随导出包一并交付。

**非目标（一期不做）**：
- 不做列配置（固定核心列）
- 不做包根总表
- 不为普通「人员→期间」分组与未分类生成汇总
- 不展开 `line_items` 明细行（一张发票一行）
- 不改动文档数据模型与数据库（纯导出侧能力，无迁移）
- 不改动现有 `汇总.csv`（并存）

## 2. 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| Excel 位置 | 各含发票的自定义分组目录内一份（`报销整理包/类别/分组名/发票汇总.xlsx`） |
| 触发时机 | 导出整理包时自动生成，与现有导出流程合并 |
| 表格列 | 固定核心列（见 §5） |
| 混合分组 | 仅汇总发票类单据，非发票文件照常复制但不出现在表格中 |

## 3. 发票判定

- 依据模板分类：`templateId → 模板 category === '发票类'`。
- 预置模板中「增值税专用发票」「普通发票」均为 `category: "发票类"`；用户自建模板若分类为发票类同样纳入。
- 模板分类来源：`repository.listTemplates()`（导出路由内已有 repository 访问权）。
- 未归入自定义分组的发票（普通分组/未分类）不生成汇总——树结构天然排除（只有 `customGroups` 节点处理）。

## 4. 模块设计

### 4.1 新增 `src/main/documents/invoiceSummary.ts`

纯函数模块（与 `csv.ts`/`reimbursement.ts` 同风格，无 IO 依赖，可单测）：

```ts
export interface InvoiceRowInput {
  entry: ReimbursementDocumentEntry
  document: DocumentRecord | undefined   // documentsById 取不到时降级
}

export interface InvoiceRow {
  invoiceNumber: string
  invoiceDate: string
  sellerName: string
  sellerTaxNo: string
  buyerName: string
  buyerTaxNo: string
  totalAmount: number | string | null   // 数值解析成功为 number，失败为原始文本
  taxAmount: number | string | null
  amountExTax: number | string | null
  taxRate: string
  uncertain: boolean                    // 金额存疑
  remark: string
  fileRelPaths: string[]                // 文件相对路径（期间/文件名），多文件多路径
  fileMissing: boolean                  // 原件缺失标记
}

export function buildInvoiceRow(entry: InvoiceRowInput): InvoiceRow
export function serializeInvoiceWorkbook(rows: InvoiceRow[]): Uint8Array
```

- `buildInvoiceRow`：从 `document.fields` 直取字段值（`DocumentFieldEntry { value, uncertain }`），字段 key 见 §5。
- 金额解析：`typeof value === 'number'` 直接用；字符串可 `Number()` 解析则转数值；失败保留原始文本写入单元格并置 `uncertain = true`。
- `uncertain` 口径：三个金额字段（`total_amount`/`tax_amount`/`amount_ex_tax`）任一 `uncertain` 为 true，或金额解析失败，或 `entry.amountUncertain` 为 true → 该行「金额存疑」列为「是」。
- 公式注入防护：所有文本单元格沿用 `reimbursementExport.ts` 的 `FORMULA_PREFIX_RE` 规则（`= + - @ \t \r` 开头前置单引号）。
- `serializeInvoiceWorkbook`：`XLSX.utils.aoa_to_sheet` + `book_new` + `XLSX.write({ type: 'array', bookType: 'xlsx' })`，返回 `Uint8Array`。Sheet 名「发票汇总」。列宽通过 `ws['!cols']` 设置（金额列宽 12、路径列宽 40 等）。

### 4.2 修改 `src/main/documents/reimbursementExport.ts`

- `ReimbursementExportDeps` 增加：`writeFileBinary: (file: string, data: Uint8Array) => Promise<void>`（实现为 `fsp.writeFile`）。
- `ReimbursementExportInput` 增加：
  - `documentsById: Map<string, DocumentRecord>`（路由侧由 `repository.listDocuments` 结果构建，key 为 document.id）
  - `invoiceTypeKeys: Set<string>`（模板分类为发票类的模板 typeKey 集合）
- 在 `exportReimbursementPackage` 的 customGroups 处理路径（`writeEntries(categoryName, groupDir, ...)` 完成后）：递归覆盖该分组目录下的全部期间/其他子目录，聚合 `customGroup.buckets` 中所有 `invoiceTypeKeys.has(entry.typeKey)` 的条目 → 构建一份 `InvoiceRow[]` → 写入分组层 `path.join(packageDir, categoryName, groupDirName, '发票汇总.xlsx')`。不按子目录拆分 Excel，也不遗漏任何子目录中的发票。

  > 注意：`ReimbursementDocumentEntry` 携带 `typeKey` 而非 `templateId`，发票判定集以 typeKey 构建（模板 `typeKey → category` 来自同一 repository 数据源，见 §4.4）——不动 `ReimbursementDocumentEntry` 结构，零侵入。

- 文件相对路径：行内路径为 `期间目录名/导出文件名`（与包内实际结构一致）；同一单据多文件用「、」连接；原件缺失时该单据路径列显示 `缺失:文件名`，金额照计。
  > 实施要点：`writeEntries` 内文件名经 `uniqueFileName` 消重后可能与 `entry.fileNames` 原名不同，需在复制时记录 `documentId → 实际导出相对路径[]`（含缺失标记），供发票行构建时取用，禁止事后用原始文件名拼接路径。
- `ReimbursementExportOutput` 增加 `invoiceSummaries: string[]`（生成的 Excel 相对路径清单，路径分隔符统一为 `/`）。
- 空分组（无发票条目）不生成文件；发票条目存在但全部原件缺失时仍生成（路径列标缺失）。
- 文件名冲突：分组目录下若已有同名文件（理论上不会，包目录为新建 uniqueDir），复用 `uniqueFileName` 兜底。

### 4.3 合计行

`serializeInvoiceWorkbook` 内追加末行：
- 「合计」写入第 1 列；对三个金额列分别求和（仅累加成功解析为 number 的行；全空则合计留空）。
- 合计行样式不依赖 xlsx 样式能力（SheetJS 社区版不支持样式）——以行首「合计」文字 + 数值区分即可，不写样式代码。

### 4.4 修改导出路由 `src/main/documents/routes.ts`

- `documentsReimbursementExportRoute` 处理器：
  - `repository.listTemplates()` 过滤 `category === '发票类'` → 构建 `invoiceTypeKeys: Set<string>`（模板的 typeKey 字段）。
  - `documentsById` 由已有 `documents` 数组构建。
  - 将两个入参传入 `exportReimbursementPackage`。
- 输出契约增加 `invoiceSummaries`。

### 4.5 契约修改 `src/shared/contracts/routes/documents.routes.ts`

`documentsReimbursementExportRoute.output` 增加：

```ts
invoiceSummaries: z.array(z.string().min(1)).optional()
```

（可选字段，保持向后兼容——renderer 侧旧逻辑不受影响。）

### 4.6 Renderer 提示

导出完成 toast 增加汇总文件数提示（`invoiceSummaries.length`）：
- 新增 locale key（如 `documents.export.invoiceSummariesGenerated`：`已生成 {{count}} 份发票汇总`）。
- 覆盖全部 20 locale（与近期视图改名变更同范围）。
- 具体接入点为导出结果处理处（`DocumentsArchivePage.vue` 导出成功回调，实施时以 `summaryPath` 现有消费位置为准）。

## 5. Excel 表设计

Sheet「发票汇总」，表头：

| 序号 | 发票号码 | 开票日期 | 销售方名称 | 销售方税号 | 购买方名称 | 购买方税号 | 价税合计 | 税额 | 不含税金额 | 税率 | 金额存疑 | 备注 | 文件相对路径 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

字段映射（两预置发票模板 key 完全一致，含 `required: false` 差异字段不影响）：

| 列 | field key | 类型处理 |
|---|---|---|
| 发票号码 | `invoice_number` | 文本（保留前导零，禁数值化） |
| 开票日期 | `invoice_date` | 文本（YYYY-MM-DD 原样） |
| 销售方名称 | `seller_name` | 文本 |
| 销售方税号 | `seller_tax_no` | 文本（个人销售方无税号留空） |
| 购买方名称 | `buyer_name` | 文本 |
| 购买方税号 | `buyer_tax_no` | 文本（个人购买方无税号留空） |
| 价税合计 | `total_amount` | 数值优先，失败转文本+存疑 |
| 税额 | `tax_amount` | 数值优先 |
| 不含税金额 | `amount_ex_tax` | 数值优先 |
| 税率 | `tax_rate` | 文本（枚举，如 "13%"、"免税"） |
| 金额存疑 | 派生 | 「是」/空 |
| 备注 | `invoice_remark` | 文本 |

行序：按分组内 buckets 现有顺序（期间升序、条目原有顺序）。

## 6. 安全与边界

- **公式注入**：所有文本单元格套用 `FORMULA_PREFIX_RE` 前置单引号（与 CSV 侧同规则，实现抽到 invoiceSummary 内部或复用同正则，两处正则保持一致）。
- **数值精度**：金额直接使用解析后的 number；合计求和为浮点累加，对结果 `Number.toFixed(2)` 处理（`parse` 与 `sum` 统一走一个工具函数，避免两处分叉）。
- **超大分组**：发票行数受 `REIMBURSEMENT_TREE_MAX_DOCUMENTS = 5000` 上游限制，无额外分页需求。
- **IO 失败**：Excel 写入失败不中断导出（与文件复制 `catch` 行为一致：记入 `issues`，导出结果继续返回）。

## 7. 测试计划

- `invoiceSummary` 单测：
  - 行构建（完整字段/字段缺失/字段 uncertain）
  - 税号列取值（`buyer_tax_no`/`seller_tax_no` 存在、缺失留空；保留文本类型）
  - 金额解析（number/数字字符串/非数字文本/空值）
  - 存疑口径（金额字段 uncertain、解析失败、amountUncertain）
  - 公式前缀消毒（`=SUM(A1)` 等开头文本）
  - 合计行（部分行金额为文本时仅累加数值行）
  - 序号连续性、发票号码保留文本类型
- `reimbursementExport` 集成测试扩展：
  - 含发票的自定义分组 → 分组目录下生成 `发票汇总.xlsx` 且行数正确
  - 无发票分组 → 不生成
  - 普通分组/未分类 → 不生成
  - 原件缺失 → 行仍在、路径列缺失标记
  - 跨期间/子目录递归聚合 → 分组层一份覆盖所有子目录中的发票，不生成子目录级分表
  - `invoiceSummaries` 输出正确
- 路由层：`invoiceSummaries` 契约校验（可选字段回归）。

## 8. 实施计划（TDD，建议 3-4 提交）

| # | 任务 | 交付 |
|---|---|---|
| T1 | `invoiceSummary.ts` 纯函数 + 全量单测 | 行构建/序列化/合计/消毒 |
| T2 | `reimbursementExport.ts` 集成（deps/入参/聚合写入/output）+ 集成测试扩展 | 导出包内生成 Excel |
| T3 | 契约 + 路由接线（`invoiceTypeKeys`/`documentsById`）+ renderer toast + 20 locale | 端到端可见 |
| T4 | typecheck + 全量测试回归 | 收尾 |

## 9. 风险

| 风险 | 缓解 |
|---|---|
| SheetJS 社区版无样式能力 | 合计行不依赖样式（§4.3）；如需样式后续评估 exceljs |
| `xlsx` 包体积影响主进程 bundle | 依赖已存在（`ExcelFileAdapter` 在用），无新增负担 |
| `invoiceTypeKeys` 与树条目 typeKey 对齐 | 模板 typeKey 来自同一 repository 数据源，测试覆盖判定集命中 |
| locale 遗漏 | 复用 `pnpm run i18n:validate` 校验 |
