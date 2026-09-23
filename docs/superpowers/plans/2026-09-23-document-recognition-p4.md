# 单据识别 P4：档案管理页 + 聊天识别入口 + CSV 导出 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付设计文档（docs/superpowers/specs/2026-09-22-document-recognition-design.md §7/§9/§10）的 P4：`/documents` 档案管理页（筛选/动态表格/详情编辑/原文件预览/新建识别）、`documents.exportCsv` CSV 导出、聊天识别入口（内建 agent tool + document-recognition skill 泛化）。

**Architecture:** 主进程扩展 documents 模块（契约 + repository 日期筛选 + CSV 纯函数 + export/preview 路由）；渲染层主窗口新增独立路由页与 Pinia 档案状态；聊天入口走内建 agent tool（cronjob 模式，进程内直连 extractor/repository），skill 由内嵌模板改为指引 agent 调用该工具。

**Tech Stack:** Electron/Vue 3/TS、zod typed IPC 契约、better-sqlite3、Pinia、shadcn-vue（@shadcn/components/ui/*）、Vitest。

---

## 关键事实（研究结论，实现者必读）

环境：Windows PowerShell（命令用 `;` 分隔，`&&` 会报错）；pnpm only；Oxfmt 单引号无分号 100 列；Conventional Commits ≤50 字符；分支 develop。

### 既有模块（P1-P3 产物）

| 事实 | 位置 |
|---|---|
| 契约：documentsListInputSchema 仅 typeKey/status/keyword/limit/offset；**无 dateFrom/dateTo、无 exportCsv/previewFile 路由** | src/shared/contracts/routes/documents.routes.ts:92-98 |
| 契约 barrel（新路由必须在此导出） | src/shared/contracts/routes/index.ts |
| documentsTable.list(filter) 支持 typeKey/status/keyword(LIKE)/limit/offset，**默认 limit=100**，ORDER BY updated_at DESC | src/main/documents/data/tables/documents.ts:82-105（`LIST_DEFAULT_LIMIT=100` 在 L45） |
| repository.listDocuments 透传 filter；insertDocument/updateDocument/deleteDocument 已有 | src/main/documents/repository.ts:141-183 |
| extractAndDraft 路由将 `input.file.path` 存入 fileUris（**原始路径，非 deepchat-file://**） | src/main/documents/routes.ts:126-151（L135） |
| extractor.extract({templateId,file}) → {template, fields, route, rawOutput, durationMs, issues} | src/main/documents/extractor/documentExtractor.ts |
| DocumentsClient 11 方法（无 exportCsv/previewFile） | src/renderer/api/DocumentsClient.ts |
| DocumentsStore（templates 状态；无档案状态） | src/renderer/src/stores/documents.ts |
| P3 组件（模板管理，settings 窗口） | src/renderer/settings/components/documents/ |
| P3 i18n：settings.documents.* 在各语言 settings.json；category/valueType key 可复用 | src/renderer/src/i18n/<lang>/settings.json |

### P4 涉及但需新增/修改的机制

| 机制 | 结论 |
|---|---|
| 主窗口路由 | src/renderer/src/router/index.ts 顶层路由数组（/chat、/plugins、/welcome）；新增 `/documents` |
| 侧边栏入口 | src/renderer/src/components/WindowSideBar.vue:192-201 plugins 按钮范本（Icon lucide:* + t() + openXxx 方法 + route active 判断） |
| CSV 保存对话框范本 | src/main/file/index.ts:350-370 saveImage：dialog.showSaveDialog → fs.writeFile → 返回 {canceled, path} |
| 文件选择 | typed 路由 `device.selectFiles`（src/shared/contracts/routes/device.routes.ts:31）+ src/renderer/api/DeviceClient.ts selectFiles(options) |
| 文件预览 | imgcache:// 仅服务 userData/images；file.readFile 仅 userData 相对路径 → **必须新增 documents.previewFile**（documentId+uriIndex 定位，mime 白名单，base64 返回） |
| 内建 agent tool 范本 | src/main/tool/agentTools/cronJobTool.ts（zod schema + getToolDefinition + call + isXxxTool + 权限 helper）；envelope：src/shared/lib/agentToolResultEnvelope.ts 的 createAgentToolSuccessResult(name, content, {summary?, data?, meta?}) / createAgentToolErrorResult(name, message, {code?, recoverable?}) → AgentToolResult{ok,summary,data?,meta?,error?} |
| agentToolManager 接线点（5 处） | ①字段声明 L269 附近 ②构造实例化 L555 附近 ③appendDefinitions L714-717（cronjob 在 `if (isAgentMode)` 内） ④call 路由 L958-967 ⑤权限 L3025-3034 |
| 依赖端口 | src/main/tool/runtimePorts.ts:260 AgentToolDependencies（+ `documents: AgentDocumentsToolPort`）；composition.ts 端口对象范本 L1653 cronJobs |
| composition.ts 现有 documents 资源 | documentsRepository L900、documentExtractor L2816、createDocumentsRoutes L2870；端口闭包引用（调用时已赋值） |
| 共享 tool name 常量 | src/shared/agentTools.ts（+ DOCUMENT_RECOGNITION_* 常量；exposure 默认 'user-configurable' 无需登记） |
| skill | plugins/office-automation/skills/invoice-recognition/SKILL.md → 泛化为 document-recognition；plugin.json skills 数组 L36-40；交叉引用：office-reimbursement/SKILL.md:31、mcp/reimbursementServer.mjs:62 |
| 测试命令 | `pnpm run test:main`（vitest.config.ts，test/main）；`pnpm run test:renderer`（vitest.config.renderer.ts）；单文件 `pnpm exec vitest run <file> --config vitest.config.ts` |
| main 测试范本 | test/main/documents/documentsRoutes.test.ts：sqlite 可用性探测 L21-34；`makeRepository()` fixture L187-194（DocumentsTable/DocumentTemplatesTable 建表 + DocumentsDatabase） |
| renderer 测试范本 | test/renderer/stores/documentsStore.test.ts、test/renderer/api/documentsClient.test.ts、test/renderer/router/pluginsRouter.test.ts、test/renderer/components/WindowSideBar.test.ts（setup.renderer.ts 全局 mock vue-router 与轻量 pinia；组件测试用 vi.doMock + 动态 import） |
| UI 组件 | @shadcn/components/ui/dialog（Dialog/DialogContent/DialogHeader/DialogTitle/DialogFooter/DialogDescription）、@shadcn/components/ui/select、@shadcn/components/ui/input、@shadcn/components/ui/switch、@shadcn/components/ui/alert-dialog、@dc-ui/components/button（DcButton）、@iconify/vue（Icon）——**无 Sheet 原语，详情抽屉用 Dialog** |
| i18n 校验 | `pnpm run i18n`、`pnpm run i18n:en`、`pnpm run i18n:types`；20 语言：zh-CN zh-TW zh-HK en-US ja-JP ko-KR de-DE fr-FR es-ES pt-BR it-IT ru-RU tr-TR pl-PL da-DK fa-IR he-IL vi-VN id-ID ms-MY |
| 预存在失败（勿修勿混入） | 渲染层全量 17 个失败（providerStore 3、ModelProviderSettings 12、保留项 2） |
| 工作区保留项（永不 stage） | test/renderer/stores/pluginCatalogStore.test.ts、resources/skills/* |

### 设计决策（定死）

1. **日期范围**：按 `createdAt`（识别日）过滤，输入为本地日期字符串转 ms（起 00:00:00.000 / 止 23:59:59.999）。
2. **CSV 列**：单类型导出（指定 typeKey）= 固定列（id,type,source,status,createdAt,updatedAt）+ 该模板快照字段列（按 order 排序，列头用 label）；全类型导出 = 固定列 + `summary` 列（按快照 order 拼接 `label: value`，分号连接）。RFC 4180 转义 + `\uFEFF` BOM + CRLF。导出行数上限常量 10000（list 默认 limit=100，导出需显式传大 limit）。
3. **金额类字段（全类型视图动态列）**：key 或 label 匹配 `/amount|total|tax|price|金额|合计|税|价格|价税/i`。
4. **previewFile 安全边界**：仅允许读取已归档文档 fileUris 中记录的路径（documentId+uriIndex 定位），mime 白名单 png/jpeg/webp/gif/pdf，大小上限 25MB。
5. **详情保存语义**：编辑保存 = `updateDocument(id, {fields, status:'confirmed'})`（修正即确认，spec §9 "draft 可编辑入库"）；被编辑字段 `uncertain:false`，未编辑字段保留原 entry；required 字段为空阻断保存。
6. **重新识别**：用原 fileUris[0] + 当前模板重跑 extractAndDraft → 生成新 draft 记录（旧记录保留），抽屉切换到新记录。
7. **array 值编辑**：Textarea 每行一项（显示 join('\n')，保存 split 过滤空行）。
8. **聊天入口 = 内建 agent tool**（MCP stdio server 是独立进程无法调主进程，这是唯一可行路径）。工具名 `document_recognition`，3 个 action：`list_templates`（免权限）/ `recognize`（需确认，source:'chat'）/ `confirm`（需确认）。注册不加 isAgentMode 门（聊天会话需要）；若实现时发现 appendDefinitions 仅在 agent 模式可达，则按 cronjob 模式加门并记录偏差。
9. **skill 泛化**：删除 invoice-recognition skill，新建 document-recognition skill；plugin.json/office-reimbursement SKILL.md/reimbursementServer.mjs 的交叉引用同步更新。

---

## File Structure（新增/修改文件总览）

```
src/shared/agentTools.ts                                   [改] +2 常量
src/shared/contracts/routes/documents.routes.ts            [改] 日期筛选 + 2 新路由
src/shared/contracts/routes/index.ts                       [改] barrel 导出
src/main/documents/data/tables/documents.ts                [改] DocumentListFilter + 日期条件
src/main/documents/repository.ts                           [改] listDocuments 签名
src/main/documents/csv.ts                                  [新] CSV 纯函数
src/main/documents/routes.ts                               [改] exportCsv/previewFile handler
src/main/tool/runtimePorts.ts                              [改] AgentDocumentsToolPort
src/main/tool/agentTools/documentRecognitionTool.ts        [新] agent tool handler
src/main/tool/agentTools/agentToolManager.ts               [改] 5 处接线
src/main/app/composition.ts                                [改] documents 端口
src/renderer/api/DocumentsClient.ts                        [改] +2 方法
src/renderer/src/stores/documents.ts                       [改] 档案状态
src/renderer/src/router/index.ts                           [改] /documents 路由
src/renderer/src/components/WindowSideBar.vue              [改] 侧边栏入口
src/renderer/src/pages/documents/DocumentsArchivePage.vue  [新] 档案页
src/renderer/src/pages/documents/DocumentDetailDialog.vue  [新] 详情
src/renderer/src/pages/documents/DocumentRecognizeDialog.vue [新] 新建识别
src/renderer/src/pages/documents/documentArchive.ts        [新] 纯函数
src/renderer/src/i18n/<20 lang>/settings.json              [改] archive keys
src/renderer/src/i18n/<20 lang>/routes.json                [改] routes.documents
plugins/office-automation/plugin.json                      [改] skill 注册
plugins/office-automation/skills/document-recognition/SKILL.md [新]
plugins/office-automation/skills/invoice-recognition/*     [删]
plugins/office-automation/skills/office-reimbursement/SKILL.md [改] 引用
plugins/office-automation/mcp/reimbursementServer.mjs      [改] 工具描述引用
test/main/documents/documentsRoutes.test.ts                [改] 契约/日期/路由测试
test/main/documents/csv.test.ts                            [新]
test/main/documents/documentRecognitionTool.test.ts        [新]
test/renderer/api/documentsClient.test.ts                  [改]
test/renderer/stores/documentsArchiveStore.test.ts         [新]
test/renderer/router/documentsRouter.test.ts               [新]
test/renderer/pages/documents/documentArchive.test.ts      [新]
test/renderer/pages/documents/DocumentsArchivePage.test.ts [新]
test/renderer/pages/documents/DocumentDetailDialog.test.ts [新]
test/renderer/pages/documents/DocumentRecognizeDialog.test.ts [新]
```

---

### Task 1: 契约扩展（日期筛选 + exportCsv + previewFile）

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`
- Modify: `src/shared/contracts/routes/index.ts`
- Test: `test/main/documents/documentsRoutes.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/main/documents/documentsRoutes.test.ts` 的 `describe('documents route contracts', ...)` 内追加（import 区域同步追加 `documentsExportCsvRoute, documentsPreviewFileRoute`）：

```ts
  it('documents.list 输入接受 dateFrom/dateTo', () => {
    const input = documentsListRoute.input.parse({
      typeKey: 'invoice_special',
      dateFrom: 1000,
      dateTo: 2000
    })
    expect(input.dateFrom).toBe(1000)
    expect(input.dateTo).toBe(2000)
    expect(() => documentsListRoute.input.parse({ dateFrom: -1 })).toThrow()
    expect(() => documentsListRoute.input.parse({ dateFrom: 1.5 })).toThrow()
  })

  it('documents.exportCsv 契约解析筛选输入与取消输出', () => {
    const input = documentsExportCsvRoute.input.parse({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      dateFrom: 1000,
      dateTo: 2000
    })
    expect(input.typeKey).toBe('contract')
    expect(documentsExportCsvRoute.output.parse({ canceled: true }).path).toBeUndefined()
    expect(
      documentsExportCsvRoute.output.parse({ canceled: false, path: 'C:\\out\\a.csv' }).path
    ).toBe('C:\\out\\a.csv')
    expect(() => documentsExportCsvRoute.output.parse({ canceled: false })).toThrow()
  })

  it('documents.previewFile 契约解析定位输入与 base64 输出', () => {
    const input = documentsPreviewFileRoute.input.parse({ documentId: 'd1', uriIndex: 0 })
    expect(input.uriIndex).toBe(0)
    expect(() => documentsPreviewFileRoute.input.parse({ documentId: 'd1', uriIndex: -1 })).toThrow()
    const output = documentsPreviewFileRoute.output.parse({
      dataBase64: 'aGk=',
      mimeType: 'image/png',
      name: 'a.png'
    })
    expect(output.mimeType).toBe('image/png')
  })
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: FAIL（documentsExportCsvRoute 未导出）

- [ ] **Step 3: 修改契约文件**

`src/shared/contracts/routes/documents.routes.ts`：`documentsListInputSchema`（L92-98）追加两个可选字段，并在文件末尾追加两个路由：

```ts
export const documentsListInputSchema = z.object({
  typeKey: z.string().min(1).optional(),
  status: documentStatusSchema.optional(),
  keyword: z.string().max(200).optional(),
  dateFrom: timestampMsSchema.optional(),
  dateTo: timestampMsSchema.optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional()
})
```

```ts
export const documentsExportCsvRoute = defineRouteContract({
  name: 'documents.exportCsv',
  input: z.object({
    typeKey: z.string().min(1).optional(),
    status: documentStatusSchema.optional(),
    keyword: z.string().max(200).optional(),
    dateFrom: timestampMsSchema.optional(),
    dateTo: timestampMsSchema.optional()
  }),
  output: z.object({
    canceled: z.boolean(),
    path: z.string().min(1).optional()
  })
})

export const documentsPreviewFileRoute = defineRouteContract({
  name: 'documents.previewFile',
  input: z.object({
    documentId: z.string().min(1),
    uriIndex: z.number().int().nonnegative()
  }),
  output: z.object({
    dataBase64: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().min(1)
  })
})
```

`src/shared/contracts/routes/index.ts`：在 documents.routes 导出区追加 `documentsExportCsvRoute` 与 `documentsPreviewFileRoute`（与现有 documentsXxx 导出同模式）。

- [ ] **Step 4: 运行验证通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes/index.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): add csv/preview and date contracts"
```

---

### Task 2: repository/表层日期筛选

**Files:**
- Modify: `src/main/documents/data/tables/documents.ts:37-105`
- Modify: `src/main/documents/repository.ts:141-149`
- Test: `test/main/documents/documentsRoutes.test.ts`（sqlite describe 内）

- [ ] **Step 1: 写失败测试**

在 `test/main/documents/documentsRoutes.test.ts` 的 `describeIfSqlite('documents extraction handlers', ...)` 同级新增 describe（复用该文件顶部 sqlite 探测与 `makeRepository` 同款 fixture）：

```ts
describeIfSqlite('documents list date filter', () => {
  const makeRepository = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return new DocumentsRepository(database)
  }

  const template = {
    id: 'tpl-1',
    typeKey: 'contract',
    name: '合同模板',
    icon: null,
    category: '合同类',
    fields: [],
    extractionMode: 'auto',
    promptPreset: null,
    isBuiltin: true,
    builtinSourceId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  } as const

  it('按 createdAt 日期范围筛选', () => {
    const repository = makeRepository()
    repository.upsertTemplate({ ...template })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 3000
    })
    expect(repository.listDocuments({ dateFrom: 1000, dateTo: 2000 })).toHaveLength(1)
    expect(repository.listDocuments({ dateFrom: 5000 })).toHaveLength(0)
    expect(repository.listDocuments({ dateTo: 5000 })).toHaveLength(2)
  })
})
```

注意：`insertDocument` 的 `templateSnapshot` 参数类型为 `DocumentTemplate`——若 `as const` 与可变字段冲突，改用显式对象（去掉 `as const`）并补全字段类型。

- [ ] **Step 2: 运行验证失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: FAIL（listDocuments 不识别 dateFrom，2 条都返回）

- [ ] **Step 3: 实现**

`src/main/documents/data/tables/documents.ts`：`DocumentListFilter`（L37-43）与 `list()`（L82-105）：

```ts
export interface DocumentListFilter {
  typeKey?: string
  status?: 'draft' | 'confirmed'
  keyword?: string
  dateFrom?: number
  dateTo?: number
  limit?: number
  offset?: number
}
```

`list()` 中 keyword 条件之后追加：

```ts
    if (filter.dateFrom !== undefined) {
      conditions.push('created_at >= ?')
      params.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      conditions.push('created_at <= ?')
      params.push(filter.dateTo)
    }
```

`src/main/documents/repository.ts` 的 `listDocuments`（L141-149）filter 参数类型同步加 `dateFrom?: number` 与 `dateTo?: number`。

- [ ] **Step 4: 运行验证通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/data/tables/documents.ts src/main/documents/repository.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): filter archive list by date"
```

---

### Task 3: CSV 生成纯函数

**Files:**
- Create: `src/main/documents/csv.ts`
- Test: `test/main/documents/csv.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildDocumentsCsv,
  escapeCsvCell,
  formatCsvValue,
  isMoneyLikeField,
  summarizeDocument
} from '@/documents/csv'
import type { DocumentRecord } from '@shared/documents'

const makeTemplate = (fields: Array<{ key: string; label: string; order: number }>) => ({
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
      templateFields:
        makeRecord().templateSnapshot.fields,
      templateNameById: new Map([['tpl-1', '增值税专用发票']])
    })
    const lines = csv.split('\r\n')
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(lines[0]).toBe('id,type,source,status,createdAt,updatedAt,发票代码,价税合计')
    expect(lines[1]).toBe(
      'd1,增值税专用发票,manual,draft,2023-11-14T22:13:20.000Z,2023-11-14T22:15:00.000Z,12345,100.5'
    )
  })

  it('全类型导出：summary 列 + 类型列回退 typeKey', () => {
    const csv = buildDocumentsCsv({
      documents: [makeRecord({ templateId: 'unknown-tpl' }), makeRecord({ id: 'd2' })],
      templateFields: null,
      templateNameById: new Map([['tpl-1', '增值税专用发票']])
    })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('id,type,source,status,createdAt,updatedAt,summary')
    expect(lines[1]).toContain('unknown-tpl')
    expect(lines[2]).toContain('发票代码: 12345; 价税合计: 100.5')
  })

  it('字段值含逗号时正确转义', () => {
    const csv = buildDocumentsCsv({
      documents: [
        makeRecord({ fields: { invoice_code: { value: 'a,b', uncertain: false } } })
      ],
      templateFields: makeRecord().templateSnapshot.fields,
      templateNameById: new Map([['tpl-1', 'x']])
    })
    expect(csv).toContain('"a,b"')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm exec vitest run test/main/documents/csv.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 csv.ts**

```ts
import type { DocumentRecord, DocumentTemplateField } from '@shared/documents'

const MONEY_FIELD_RE = /amount|total|tax|price|金额|合计|税|价格|价税/i

export const CSV_EXPORT_MAX_ROWS = 10000

export function isMoneyLikeField(field: DocumentTemplateField): boolean {
  return MONEY_FIELD_RE.test(field.key) || MONEY_FIELD_RE.test(field.label)
}

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export function escapeCsvCell(text: string): string {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function summarizeDocument(document: DocumentRecord): string {
  const fields = [...document.templateSnapshot.fields].sort((a, b) => a.order - b.order)
  return fields
    .map((field) => ({ label: field.label, value: document.fields[field.key]?.value }))
    .filter((item) => item.value !== null && item.value !== undefined)
    .map((item) => `${item.label}: ${formatCsvValue(item.value)}`)
    .join('; ')
}

export interface DocumentsCsvInput {
  documents: DocumentRecord[]
  templateFields: DocumentTemplateField[] | null
  templateNameById: Map<string, string>
}

export function buildDocumentsCsv(input: DocumentsCsvInput): string {
  const { documents, templateFields, templateNameById } = input
  const fixedHeader = ['id', 'type', 'source', 'status', 'createdAt', 'updatedAt']
  const fieldColumns = templateFields
    ? [...templateFields].sort((a, b) => a.order - b.order)
    : null
  const header = [
    ...fixedHeader,
    ...(fieldColumns ? fieldColumns.map((f) => f.label) : ['summary'])
  ]
  const lines = [header.map(escapeCsvCell).join(',')]
  for (const document of documents) {
    const fixedCells = [
      document.id,
      templateNameById.get(document.templateId) ?? document.typeKey,
      document.source,
      document.status,
      new Date(document.createdAt).toISOString(),
      new Date(document.updatedAt).toISOString()
    ]
    const restCells = fieldColumns
      ? fieldColumns.map((f) => formatCsvValue(document.fields[f.key]?.value ?? null))
      : [summarizeDocument(document)]
    lines.push([...fixedCells, ...restCells].map(escapeCsvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
```

- [ ] **Step 4: 运行验证通过**

Run: `pnpm exec vitest run test/main/documents/csv.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/csv.ts test/main/documents/csv.test.ts
git commit -m "feat(documents): csv builder pure functions"
```

---

### Task 4: 主进程 exportCsv/previewFile 路由 + DocumentsClient

**Files:**
- Modify: `src/main/documents/routes.ts`
- Modify: `src/renderer/api/DocumentsClient.ts`
- Test: `test/main/documents/documentsRoutes.test.ts`、`test/renderer/api/documentsClient.test.ts`

- [ ] **Step 1: 写失败测试（主进程）**

`test/main/documents/documentsRoutes.test.ts` 顶部 import 追加 `documentsExportCsvRoute, documentsPreviewFileRoute`（来自 `@shared/contracts/routes`）；在 `describeIfSqlite('documents extraction handlers', ...)` 内追加（`createDocumentsRoutes` 调用处改传 deps stub——先看现有 extractAndDraft 用例如何构造 routes，再按同款方式为新增用例传入 `csvDeps`）：

```ts
  it('previewFile 返回 base64 与 mime；越界/类型不符报错', async () => {
    const repository = makeRepository()
    repository.upsertTemplate({ ...template })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: {},
      fileUris: [pngPath, textPath],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    const routes = createDocumentsRoutes(repository, makeExtractorStub())
    // pngPath：测试内用 fs 写入的 1x1 PNG 临时文件；textPath：纯文本文件
    const preview = await routes['documents.previewFile']({ documentId: docId, uriIndex: 0 })
    expect(preview.mimeType).toBe('image/png')
    expect(preview.dataBase64.length).toBeGreaterThan(0)
    await expect(
      routes['documents.previewFile']({ documentId: docId, uriIndex: 5 })
    ).rejects.toThrow()
    await expect(
      routes['documents.previewFile']({ documentId: docId, uriIndex: 1 })
    ).rejects.toThrow('Unsupported preview type')
  })
```

实现说明：`routes` 是 `DeepchatRouteMap`——参照同文件现有 extractAndDraft handler 用例的实际调用方式（若现有用例直接调用 handler 函数而非 map 索引，按现有模式写）。临时文件用 `node:fs/promises` 的 `mkdtemp`+`writeFile` 在 `os.tmpdir()` 创建，用例后 `rm` 清理；1x1 PNG 用固定 base64 常量 `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`。

```ts
  it('exportCsv 写入用户选择的路径', async () => {
    const repository = makeRepository()
    repository.upsertTemplate({ ...template })
    repository.insertDocument({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: template,
      fields: { buyer: { value: '甲,公司', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    const targetPath = path.join(tmpDir, 'out.csv')
    const routes = createDocumentsRoutes(repository, makeExtractorStub(), {
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath })
    })
    const result = await routes['documents.exportCsv']({ typeKey: 'contract' })
    expect(result).toEqual({ canceled: false, path: targetPath })
    const content = await fs.readFile(targetPath, 'utf-8')
    expect(content.startsWith('\uFEFF')).toBe(true)
    expect(content).toContain('"甲,公司"')
  })

  it('exportCsv 用户取消时返回 canceled', async () => {
    const routes = createDocumentsRoutes(makeRepository(), makeExtractorStub(), {
      showSaveDialog: async () => ({ canceled: true })
    })
    expect(await routes['documents.exportCsv']({})).toEqual({ canceled: true })
  })
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: FAIL（createDocumentsRoutes 不接受第三参；routes map 无新键）

- [ ] **Step 3: 实现 routes.ts**

`src/main/documents/routes.ts` 重构签名与新增两个 handler（保留现有 11 个 handler 不变）：

```ts
import { promises as fsp } from 'node:fs'
import * as nodePath from 'node:path'
import { dialog } from 'electron'
import {
  // ...现有 import 保持...
  documentsExportCsvRoute,
  documentsPreviewFileRoute
} from '@shared/contracts/routes'
import { buildDocumentsCsv, CSV_EXPORT_MAX_ROWS } from './csv'

interface DocumentsCsvRouteDeps {
  showSaveDialog: (
    options: Electron.SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
}

const PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf'
}

const PREVIEW_MAX_BYTES = 25 * 1024 * 1024

const defaultCsvDeps: DocumentsCsvRouteDeps = {
  showSaveDialog: (options) => dialog.showSaveDialog(options)
}

function resolvePreviewMimeType(filePath: string): string {
  const extension = nodePath.extname(filePath).toLowerCase()
  const mimeType = PREVIEW_MIME_BY_EXTENSION[extension]
  if (!mimeType) {
    throw new Error(`Unsupported preview type: ${extension || filePath}`)
  }
  return mimeType
}

export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor,
  csvDeps: DocumentsCsvRouteDeps = defaultCsvDeps
): DeepchatRouteMap {
  return createRouteMap([
    // ...现有 11 个 handler 保持不变...
    [
      documentsExportCsvRoute.name,
      async (rawInput) => {
        const input = documentsExportCsvRoute.input.parse(rawInput)
        const documents = repository.listDocuments({ ...input, limit: CSV_EXPORT_MAX_ROWS })
        const templateNameById = new Map(
          repository.listTemplates().map((t) => [t.id, t.name])
        )
        const templateFields = input.typeKey
          ? (repository.getTemplateByTypeKey(input.typeKey)?.fields ?? null)
          : null
        const csv = buildDocumentsCsv({ documents, templateFields, templateNameById })
        const date = new Date()
        const stamp = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0')
        ].join('')
        const { canceled, filePath } = await csvDeps.showSaveDialog({
          defaultPath: `documents-export-${stamp}.csv`,
          filters: [
            { name: 'CSV', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        if (canceled || !filePath) {
          return documentsExportCsvRoute.output.parse({ canceled: true })
        }
        await fsp.writeFile(filePath, csv, 'utf-8')
        return documentsExportCsvRoute.output.parse({ canceled: false, path: filePath })
      }
    ],
    [
      documentsPreviewFileRoute.name,
      async (rawInput) => {
        const input = documentsPreviewFileRoute.input.parse(rawInput)
        const document = repository.getDocument(input.documentId)
        const uri = document?.fileUris[input.uriIndex]
        if (!uri) {
          throw new Error(`File not found for document ${input.documentId}[${input.uriIndex}]`)
        }
        const mimeType = resolvePreviewMimeType(uri)
        const stat = await fsp.stat(uri)
        if (stat.size > PREVIEW_MAX_BYTES) {
          throw new Error('File too large to preview')
        }
        const data = await fsp.readFile(uri)
        return documentsPreviewFileRoute.output.parse({
          dataBase64: data.toString('base64'),
          mimeType,
          name: nodePath.basename(uri)
        })
      }
    ]
  ])
}
```

注意：现有文件未 import `dialog`/`node:fs`/`node:path`——按上面补齐；若项目 lint 禁止 `import * as path`，用 `import { basename, extname, join } from 'node:path'` 风格（与文件内既有风格一致即可，需保持全文件统一）。

- [ ] **Step 4: DocumentsClient 扩展**

`src/renderer/api/DocumentsClient.ts`：import 追加 `documentsExportCsvRoute, documentsPreviewFileRoute` 与类型 `type documentsExportCsvInputSchema`；方法区追加：

```ts
export type DocumentsExportCsvInput = z.input<typeof documentsExportCsvInputSchema>
export type DocumentsPreviewFileInput = z.input<typeof documentsPreviewFileRoute.input>
```

```ts
    exportCsv: (input: DocumentsExportCsvInput = {}) =>
      invokeRoute(bridge, documentsExportCsvRoute.name, input),
    previewFile: (input: DocumentsPreviewFileInput) =>
      invokeRoute(bridge, documentsPreviewFileRoute.name, input)
```

- [ ] **Step 5: 写 client 测试**

`test/renderer/api/documentsClient.test.ts`：按该文件现有用例模式（mock bridge.invoke 断言路由名与透传参数）追加：

```ts
  it('exportCsv 透传筛选参数', async () => {
    const invoke = vi.fn(async () => ({ canceled: true }))
    const client = createClientWithBridge(invoke)
    await client.exportCsv({ typeKey: 'contract', dateFrom: 1 })
    expect(invoke).toHaveBeenCalledWith('documents.exportCsv', {
      typeKey: 'contract',
      dateFrom: 1
    })
  })

  it('previewFile 透传定位参数', async () => {
    const invoke = vi.fn(async () => ({ dataBase64: 'aGk=', mimeType: 'image/png', name: 'a.png' }))
    const client = createClientWithBridge(invoke)
    await client.previewFile({ documentId: 'd1', uriIndex: 0 })
    expect(invoke).toHaveBeenCalledWith('documents.previewFile', { documentId: 'd1', uriIndex: 0 })
  })
```

（`createClientWithBridge` 替换为该文件现有的 client 构造辅助——先读文件头部确认辅助名与用法，保持一致。）

- [ ] **Step 6: 运行验证通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts test/main/documents/csv.test.ts --config vitest.config.ts`
Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/documents/routes.ts src/renderer/api/DocumentsClient.ts test/main/documents/documentsRoutes.test.ts test/renderer/api/documentsClient.test.ts
git commit -m "feat(documents): export/preview ipc routes"
```

---

### Task 5: i18n 20 语言包

**Files:**
- Modify: `src/renderer/src/i18n/<lang>/settings.json` × 20（documents 命名空间内追加 `archive` 对象，位置放在 `editor` 对象之后）
- Modify: `src/renderer/src/i18n/<lang>/routes.json` × 20（追加 `documents` key）

每个语言的 `archive` 对象与 `routes.documents` 如下（严格对齐 key 集，禁止增删）：

- [ ] **Step 1: en-US**

settings.json → documents.archive：

```json
"archive": {
  "title": "Document Archive",
  "loadFailed": "Failed to load documents",
  "empty": "No documents",
  "retry": "Retry",
  "typeAll": "All Types",
  "statusAll": "All Statuses",
  "statusDraft": "Draft",
  "statusConfirmed": "Confirmed",
  "keywordPlaceholder": "Search field values",
  "dateFrom": "From",
  "dateTo": "To",
  "newRecognition": "New Recognition",
  "exportCsv": "Export CSV",
  "exportSuccess": "Exported to {path}",
  "exportFailed": "Export failed",
  "exportCanceled": "Export canceled",
  "loadMore": "Load More",
  "colType": "Type",
  "colSummary": "Summary",
  "colSource": "Source",
  "colStatus": "Status",
  "colCreatedAt": "Created At",
  "sourceChat": "Chat",
  "sourceManual": "Manual",
  "detailTitle": "Document Detail",
  "fieldsTitle": "Fields",
  "filesTitle": "Original Files",
  "previewFailed": "Preview failed",
  "noFiles": "No attached files",
  "save": "Save",
  "saved": "Saved",
  "saveFailed": "Save failed",
  "confirmAction": "Confirm",
  "confirmFailed": "Confirm failed",
  "delete": "Delete",
  "deleteConfirmTitle": "Delete Document",
  "deleteConfirmDescription": "Delete this document? This cannot be undone.",
  "deleteFailed": "Delete failed",
  "reRecognize": "Re-recognize",
  "reRecognizeHint": "Re-runs extraction with the original file and the same template; creates a new draft",
  "reRecognizeFailed": "Re-recognition failed",
  "reRecognized": "Re-recognition complete, review the fields",
  "selectFile": "Select File",
  "filePlaceholder": "No file selected",
  "templatePlaceholder": "Select a template",
  "recognize": "Recognize",
  "recognizing": "Recognizing…",
  "recognizeFailed": "Recognition failed",
  "fieldRequired": "\"{label}\" is required"
}
```

routes.json：

```json
"documents": "Document Archive"
```

- [ ] **Step 2: zh-CN**

settings.json → documents.archive：

```json
"archive": {
  "title": "单据档案",
  "loadFailed": "加载单据失败",
  "empty": "暂无单据",
  "retry": "重试",
  "typeAll": "全部类型",
  "statusAll": "全部状态",
  "statusDraft": "待确认",
  "statusConfirmed": "已确认",
  "keywordPlaceholder": "搜索字段值",
  "dateFrom": "开始日期",
  "dateTo": "结束日期",
  "newRecognition": "新建识别",
  "exportCsv": "导出 CSV",
  "exportSuccess": "已导出到 {path}",
  "exportFailed": "导出失败",
  "exportCanceled": "已取消导出",
  "loadMore": "加载更多",
  "colType": "类型",
  "colSummary": "摘要",
  "colSource": "来源",
  "colStatus": "状态",
  "colCreatedAt": "创建时间",
  "sourceChat": "聊天",
  "sourceManual": "手动",
  "detailTitle": "单据详情",
  "fieldsTitle": "字段",
  "filesTitle": "原文件",
  "previewFailed": "预览失败",
  "noFiles": "无关联文件",
  "save": "保存",
  "saved": "已保存",
  "saveFailed": "保存失败",
  "confirmAction": "确认归档",
  "confirmFailed": "确认失败",
  "delete": "删除",
  "deleteConfirmTitle": "删除单据",
  "deleteConfirmDescription": "删除该单据？此操作不可撤销。",
  "deleteFailed": "删除失败",
  "reRecognize": "重新识别",
  "reRecognizeHint": "用原文件与当前模板重新提取，会生成一条新的待确认记录",
  "reRecognizeFailed": "重新识别失败",
  "reRecognized": "重新识别完成，请核对字段",
  "selectFile": "选择文件",
  "filePlaceholder": "未选择文件",
  "templatePlaceholder": "选择模板",
  "recognize": "开始识别",
  "recognizing": "识别中…",
  "recognizeFailed": "识别失败",
  "fieldRequired": "「{label}」为必填项"
}
```

routes.json：`"documents": "单据档案"`

- [ ] **Step 3: zh-TW**

```json
"archive": {
  "title": "單據檔案",
  "loadFailed": "載入單據失敗",
  "empty": "暫無單據",
  "retry": "重試",
  "typeAll": "全部類型",
  "statusAll": "全部狀態",
  "statusDraft": "待確認",
  "statusConfirmed": "已確認",
  "keywordPlaceholder": "搜尋欄位值",
  "dateFrom": "開始日期",
  "dateTo": "結束日期",
  "newRecognition": "新建識別",
  "exportCsv": "匯出 CSV",
  "exportSuccess": "已匯出到 {path}",
  "exportFailed": "匯出失敗",
  "exportCanceled": "已取消匯出",
  "loadMore": "載入更多",
  "colType": "類型",
  "colSummary": "摘要",
  "colSource": "來源",
  "colStatus": "狀態",
  "colCreatedAt": "建立時間",
  "sourceChat": "聊天",
  "sourceManual": "手動",
  "detailTitle": "單據詳情",
  "fieldsTitle": "欄位",
  "filesTitle": "原始檔案",
  "previewFailed": "預覽失敗",
  "noFiles": "無關聯檔案",
  "save": "儲存",
  "saved": "已儲存",
  "saveFailed": "儲存失敗",
  "confirmAction": "確認歸檔",
  "confirmFailed": "確認失敗",
  "delete": "刪除",
  "deleteConfirmTitle": "刪除單據",
  "deleteConfirmDescription": "刪除該單據？此操作無法復原。",
  "deleteFailed": "刪除失敗",
  "reRecognize": "重新識別",
  "reRecognizeHint": "用原始檔案與目前範本重新擷取，會產生一筆新的待確認記錄",
  "reRecognizeFailed": "重新識別失敗",
  "reRecognized": "重新識別完成，請核對欄位",
  "selectFile": "選擇檔案",
  "filePlaceholder": "未選擇檔案",
  "templatePlaceholder": "選擇範本",
  "recognize": "開始識別",
  "recognizing": "識別中…",
  "recognizeFailed": "識別失敗",
  "fieldRequired": "「{label}」為必填項"
}
```

routes.json：`"documents": "單據檔案"`

- [ ] **Step 4: zh-HK**

```json
"archive": {
  "title": "單據檔案",
  "loadFailed": "載入單據失敗",
  "empty": "暫無單據",
  "retry": "重試",
  "typeAll": "全部類型",
  "statusAll": "全部狀態",
  "statusDraft": "待確認",
  "statusConfirmed": "已確認",
  "keywordPlaceholder": "搜尋欄位值",
  "dateFrom": "開始日期",
  "dateTo": "結束日期",
  "newRecognition": "新建識別",
  "exportCsv": "匯出 CSV",
  "exportSuccess": "已匯出到 {path}",
  "exportFailed": "匯出失敗",
  "exportCanceled": "已取消匯出",
  "loadMore": "載入更多",
  "colType": "類型",
  "colSummary": "摘要",
  "colSource": "來源",
  "colStatus": "狀態",
  "colCreatedAt": "建立時間",
  "sourceChat": "聊天",
  "sourceManual": "手動",
  "detailTitle": "單據詳情",
  "fieldsTitle": "欄位",
  "filesTitle": "原始檔案",
  "previewFailed": "預覽失敗",
  "noFiles": "無關聯檔案",
  "save": "儲存",
  "saved": "已儲存",
  "saveFailed": "儲存失敗",
  "confirmAction": "確認歸檔",
  "confirmFailed": "確認失敗",
  "delete": "刪除",
  "deleteConfirmTitle": "刪除單據",
  "deleteConfirmDescription": "刪除該單據？此操作無法復原。",
  "deleteFailed": "刪除失敗",
  "reRecognize": "重新識別",
  "reRecognizeHint": "用原始檔案與目前範本重新擷取，會產生一筆新的待確認記錄",
  "reRecognizeFailed": "重新識別失敗",
  "reRecognized": "重新識別完成，請核對欄位",
  "selectFile": "選擇檔案",
  "filePlaceholder": "未選擇檔案",
  "templatePlaceholder": "選擇範本",
  "recognize": "開始識別",
  "recognizing": "識別中…",
  "recognizeFailed": "識別失敗",
  "fieldRequired": "「{label}」為必填項"
}
```

routes.json：`"documents": "單據檔案"`

- [ ] **Step 5: ja-JP**

```json
"archive": {
  "title": "ドキュメントアーカイブ",
  "loadFailed": "ドキュメントの読み込みに失敗しました",
  "empty": "ドキュメントはありません",
  "retry": "再試行",
  "typeAll": "すべての種類",
  "statusAll": "すべての状態",
  "statusDraft": "確認待ち",
  "statusConfirmed": "確認済み",
  "keywordPlaceholder": "フィールド値を検索",
  "dateFrom": "開始日",
  "dateTo": "終了日",
  "newRecognition": "新規認識",
  "exportCsv": "CSV をエクスポート",
  "exportSuccess": "{path} にエクスポートしました",
  "exportFailed": "エクスポートに失敗しました",
  "exportCanceled": "エクスポートをキャンセルしました",
  "loadMore": "さらに読み込む",
  "colType": "種類",
  "colSummary": "概要",
  "colSource": "ソース",
  "colStatus": "状態",
  "colCreatedAt": "作成日時",
  "sourceChat": "チャット",
  "sourceManual": "手動",
  "detailTitle": "ドキュメント詳細",
  "fieldsTitle": "フィールド",
  "filesTitle": "元ファイル",
  "previewFailed": "プレビューに失敗しました",
  "noFiles": "関連ファイルはありません",
  "save": "保存",
  "saved": "保存しました",
  "saveFailed": "保存に失敗しました",
  "confirmAction": "確認",
  "confirmFailed": "確認に失敗しました",
  "delete": "削除",
  "deleteConfirmTitle": "ドキュメントを削除",
  "deleteConfirmDescription": "このドキュメントを削除しますか？元に戻せません。",
  "deleteFailed": "削除に失敗しました",
  "reRecognize": "再認識",
  "reRecognizeHint": "元ファイルと現在のテンプレートで再抽出し、新しい確認待ちレコードを作成します",
  "reRecognizeFailed": "再認識に失敗しました",
  "reRecognized": "再認識が完了しました。フィールドを確認してください",
  "selectFile": "ファイルを選択",
  "filePlaceholder": "ファイル未選択",
  "templatePlaceholder": "テンプレートを選択",
  "recognize": "認識を開始",
  "recognizing": "認識中…",
  "recognizeFailed": "認識に失敗しました",
  "fieldRequired": "「{label}」は必須です"
}
```

routes.json：`"documents": "ドキュメントアーカイブ"`

- [ ] **Step 6: ko-KR**

```json
"archive": {
  "title": "문서 아카이브",
  "loadFailed": "문서를 불러오지 못했습니다",
  "empty": "문서가 없습니다",
  "retry": "재시도",
  "typeAll": "모든 유형",
  "statusAll": "모든 상태",
  "statusDraft": "확인 대기",
  "statusConfirmed": "확인됨",
  "keywordPlaceholder": "필드 값 검색",
  "dateFrom": "시작일",
  "dateTo": "종료일",
  "newRecognition": "새 인식",
  "exportCsv": "CSV 내보내기",
  "exportSuccess": "{path} 로 내보냈습니다",
  "exportFailed": "내보내기 실패",
  "exportCanceled": "내보내기가 취소되었습니다",
  "loadMore": "더 불러오기",
  "colType": "유형",
  "colSummary": "요약",
  "colSource": "소스",
  "colStatus": "상태",
  "colCreatedAt": "생성 시각",
  "sourceChat": "채팅",
  "sourceManual": "수동",
  "detailTitle": "문서 상세",
  "fieldsTitle": "필드",
  "filesTitle": "원본 파일",
  "previewFailed": "미리보기 실패",
  "noFiles": "연결된 파일이 없습니다",
  "save": "저장",
  "saved": "저장되었습니다",
  "saveFailed": "저장 실패",
  "confirmAction": "확인",
  "confirmFailed": "확인 실패",
  "delete": "삭제",
  "deleteConfirmTitle": "문서 삭제",
  "deleteConfirmDescription": "이 문서를 삭제하시겠습니까? 되돌릴 수 없습니다.",
  "deleteFailed": "삭제 실패",
  "reRecognize": "다시 인식",
  "reRecognizeHint": "원본 파일과 현재 템플릿으로 다시 추출하여 새 확인 대기 레코드를 만듭니다",
  "reRecognizeFailed": "다시 인식 실패",
  "reRecognized": "다시 인식 완료, 필드를 확인해 주세요",
  "selectFile": "파일 선택",
  "filePlaceholder": "파일이 선택되지 않았습니다",
  "templatePlaceholder": "템플릿 선택",
  "recognize": "인식 시작",
  "recognizing": "인식 중…",
  "recognizeFailed": "인식 실패",
  "fieldRequired": "\"{label}\" 은(는) 필수입니다"
}
```

routes.json：`"documents": "문서 아카이브"`

- [ ] **Step 7: de-DE**

```json
"archive": {
  "title": "Dokumentarchiv",
  "loadFailed": "Dokumente konnten nicht geladen werden",
  "empty": "Keine Dokumente",
  "retry": "Erneut versuchen",
  "typeAll": "Alle Typen",
  "statusAll": "Alle Status",
  "statusDraft": "Ausstehend",
  "statusConfirmed": "Bestätigt",
  "keywordPlaceholder": "Feldwerte suchen",
  "dateFrom": "Von",
  "dateTo": "Bis",
  "newRecognition": "Neue Erkennung",
  "exportCsv": "CSV exportieren",
  "exportSuccess": "Exportiert nach {path}",
  "exportFailed": "Export fehlgeschlagen",
  "exportCanceled": "Export abgebrochen",
  "loadMore": "Mehr laden",
  "colType": "Typ",
  "colSummary": "Zusammenfassung",
  "colSource": "Quelle",
  "colStatus": "Status",
  "colCreatedAt": "Erstellt am",
  "sourceChat": "Chat",
  "sourceManual": "Manuell",
  "detailTitle": "Dokumentdetails",
  "fieldsTitle": "Felder",
  "filesTitle": "Originaldateien",
  "previewFailed": "Vorschau fehlgeschlagen",
  "noFiles": "Keine verknüpften Dateien",
  "save": "Speichern",
  "saved": "Gespeichert",
  "saveFailed": "Speichern fehlgeschlagen",
  "confirmAction": "Bestätigen",
  "confirmFailed": "Bestätigung fehlgeschlagen",
  "delete": "Löschen",
  "deleteConfirmTitle": "Dokument löschen",
  "deleteConfirmDescription": "Dieses Dokument löschen? Dies kann nicht rückgängig gemacht werden.",
  "deleteFailed": "Löschen fehlgeschlagen",
  "reRecognize": "Erneut erkennen",
  "reRecognizeHint": "Extrahiert mit der Originaldatei und der aktuellen Vorlage erneut; erstellt einen neuen Entwurf",
  "reRecognizeFailed": "Erneute Erkennung fehlgeschlagen",
  "reRecognized": "Erneute Erkennung abgeschlossen, bitte Felder prüfen",
  "selectFile": "Datei auswählen",
  "filePlaceholder": "Keine Datei ausgewählt",
  "templatePlaceholder": "Vorlage auswählen",
  "recognize": "Erkennen",
  "recognizing": "Wird erkannt…",
  "recognizeFailed": "Erkennung fehlgeschlagen",
  "fieldRequired": "\"{label}\" ist erforderlich"
}
```

routes.json：`"documents": "Dokumentarchiv"`

- [ ] **Step 8: fr-FR**

```json
"archive": {
  "title": "Archives de documents",
  "loadFailed": "Échec du chargement des documents",
  "empty": "Aucun document",
  "retry": "Réessayer",
  "typeAll": "Tous les types",
  "statusAll": "Tous les statuts",
  "statusDraft": "À confirmer",
  "statusConfirmed": "Confirmé",
  "keywordPlaceholder": "Rechercher des valeurs de champs",
  "dateFrom": "Du",
  "dateTo": "Au",
  "newRecognition": "Nouvelle reconnaissance",
  "exportCsv": "Exporter en CSV",
  "exportSuccess": "Exporté vers {path}",
  "exportFailed": "Échec de l'export",
  "exportCanceled": "Export annulé",
  "loadMore": "Charger plus",
  "colType": "Type",
  "colSummary": "Résumé",
  "colSource": "Source",
  "colStatus": "Statut",
  "colCreatedAt": "Créé le",
  "sourceChat": "Chat",
  "sourceManual": "Manuel",
  "detailTitle": "Détails du document",
  "fieldsTitle": "Champs",
  "filesTitle": "Fichiers originaux",
  "previewFailed": "Échec de l'aperçu",
  "noFiles": "Aucun fichier associé",
  "save": "Enregistrer",
  "saved": "Enregistré",
  "saveFailed": "Échec de l'enregistrement",
  "confirmAction": "Confirmer",
  "confirmFailed": "Échec de la confirmation",
  "delete": "Supprimer",
  "deleteConfirmTitle": "Supprimer le document",
  "deleteConfirmDescription": "Supprimer ce document ? Cette action est irréversible.",
  "deleteFailed": "Échec de la suppression",
  "reRecognize": "Reconnaître à nouveau",
  "reRecognizeHint": "Relance l'extraction avec le fichier original et le modèle actuel ; crée un nouveau brouillon",
  "reRecognizeFailed": "Échec de la nouvelle reconnaissance",
  "reRecognized": "Nouvelle reconnaissance terminée, vérifiez les champs",
  "selectFile": "Sélectionner un fichier",
  "filePlaceholder": "Aucun fichier sélectionné",
  "templatePlaceholder": "Sélectionner un modèle",
  "recognize": "Reconnaître",
  "recognizing": "Reconnaissance…",
  "recognizeFailed": "Échec de la reconnaissance",
  "fieldRequired": "\"{label}\" est requis"
}
```

routes.json：`"documents": "Archives de documents"`

- [ ] **Step 9: es-ES**

```json
"archive": {
  "title": "Archivo de documentos",
  "loadFailed": "No se pudieron cargar los documentos",
  "empty": "No hay documentos",
  "retry": "Reintentar",
  "typeAll": "Todos los tipos",
  "statusAll": "Todos los estados",
  "statusDraft": "Pendiente",
  "statusConfirmed": "Confirmado",
  "keywordPlaceholder": "Buscar valores de campos",
  "dateFrom": "Desde",
  "dateTo": "Hasta",
  "newRecognition": "Nuevo reconocimiento",
  "exportCsv": "Exportar CSV",
  "exportSuccess": "Exportado a {path}",
  "exportFailed": "Error al exportar",
  "exportCanceled": "Exportación cancelada",
  "loadMore": "Cargar más",
  "colType": "Tipo",
  "colSummary": "Resumen",
  "colSource": "Origen",
  "colStatus": "Estado",
  "colCreatedAt": "Creado el",
  "sourceChat": "Chat",
  "sourceManual": "Manual",
  "detailTitle": "Detalle del documento",
  "fieldsTitle": "Campos",
  "filesTitle": "Archivos originales",
  "previewFailed": "Error en la vista previa",
  "noFiles": "Sin archivos asociados",
  "save": "Guardar",
  "saved": "Guardado",
  "saveFailed": "Error al guardar",
  "confirmAction": "Confirmar",
  "confirmFailed": "Error al confirmar",
  "delete": "Eliminar",
  "deleteConfirmTitle": "Eliminar documento",
  "deleteConfirmDescription": "¿Eliminar este documento? Esta acción no se puede deshacer.",
  "deleteFailed": "Error al eliminar",
  "reRecognize": "Volver a reconocer",
  "reRecognizeHint": "Repite la extracción con el archivo original y la plantilla actual; crea un nuevo borrador",
  "reRecognizeFailed": "Error al volver a reconocer",
  "reRecognized": "Reconocimiento completado, revise los campos",
  "selectFile": "Seleccionar archivo",
  "filePlaceholder": "Ningún archivo seleccionado",
  "templatePlaceholder": "Seleccionar plantilla",
  "recognize": "Reconocer",
  "recognizing": "Reconociendo…",
  "recognizeFailed": "Error de reconocimiento",
  "fieldRequired": "\"{label}\" es obligatorio"
}
```

routes.json：`"documents": "Archivo de documentos"`

- [ ] **Step 10: pt-BR**

```json
"archive": {
  "title": "Arquivo de documentos",
  "loadFailed": "Falha ao carregar documentos",
  "empty": "Nenhum documento",
  "retry": "Tentar novamente",
  "typeAll": "Todos os tipos",
  "statusAll": "Todos os status",
  "statusDraft": "Pendente",
  "statusConfirmed": "Confirmado",
  "keywordPlaceholder": "Pesquisar valores dos campos",
  "dateFrom": "De",
  "dateTo": "Até",
  "newRecognition": "Novo reconhecimento",
  "exportCsv": "Exportar CSV",
  "exportSuccess": "Exportado para {path}",
  "exportFailed": "Falha na exportação",
  "exportCanceled": "Exportação cancelada",
  "loadMore": "Carregar mais",
  "colType": "Tipo",
  "colSummary": "Resumo",
  "colSource": "Origem",
  "colStatus": "Status",
  "colCreatedAt": "Criado em",
  "sourceChat": "Chat",
  "sourceManual": "Manual",
  "detailTitle": "Detalhes do documento",
  "fieldsTitle": "Campos",
  "filesTitle": "Arquivos originais",
  "previewFailed": "Falha na pré-visualização",
  "noFiles": "Nenhum arquivo associado",
  "save": "Salvar",
  "saved": "Salvo",
  "saveFailed": "Falha ao salvar",
  "confirmAction": "Confirmar",
  "confirmFailed": "Falha na confirmação",
  "delete": "Excluir",
  "deleteConfirmTitle": "Excluir documento",
  "deleteConfirmDescription": "Excluir este documento? Esta ação não pode ser desfeita.",
  "deleteFailed": "Falha ao excluir",
  "reRecognize": "Reconhecer novamente",
  "reRecognizeHint": "Executa novamente a extração com o arquivo original e o modelo atual; cria um novo rascunho",
  "reRecognizeFailed": "Falha ao reconhecer novamente",
  "reRecognized": "Reconhecimento concluído, revise os campos",
  "selectFile": "Selecionar arquivo",
  "filePlaceholder": "Nenhum arquivo selecionado",
  "templatePlaceholder": "Selecionar modelo",
  "recognize": "Reconhecer",
  "recognizing": "Reconhecendo…",
  "recognizeFailed": "Falha no reconhecimento",
  "fieldRequired": "\"{label}\" é obrigatório"
}
```

routes.json：`"documents": "Arquivo de documentos"`

- [ ] **Step 11: it-IT**

```json
"archive": {
  "title": "Archivio documenti",
  "loadFailed": "Impossibile caricare i documenti",
  "empty": "Nessun documento",
  "retry": "Riprova",
  "typeAll": "Tutti i tipi",
  "statusAll": "Tutti gli stati",
  "statusDraft": "Da confermare",
  "statusConfirmed": "Confermato",
  "keywordPlaceholder": "Cerca valori dei campi",
  "dateFrom": "Dal",
  "dateTo": "Al",
  "newRecognition": "Nuovo riconoscimento",
  "exportCsv": "Esporta CSV",
  "exportSuccess": "Esportato in {path}",
  "exportFailed": "Esportazione non riuscita",
  "exportCanceled": "Esportazione annullata",
  "loadMore": "Carica altri",
  "colType": "Tipo",
  "colSummary": "Riepilogo",
  "colSource": "Origine",
  "colStatus": "Stato",
  "colCreatedAt": "Creato il",
  "sourceChat": "Chat",
  "sourceManual": "Manuale",
  "detailTitle": "Dettagli documento",
  "fieldsTitle": "Campi",
  "filesTitle": "File originali",
  "previewFailed": "Anteprima non riuscita",
  "noFiles": "Nessun file associato",
  "save": "Salva",
  "saved": "Salvato",
  "saveFailed": "Salvataggio non riuscito",
  "confirmAction": "Conferma",
  "confirmFailed": "Conferma non riuscita",
  "delete": "Elimina",
  "deleteConfirmTitle": "Elimina documento",
  "deleteConfirmDescription": "Eliminare questo documento? L'operazione non è annullabile.",
  "deleteFailed": "Eliminazione non riuscita",
  "reRecognize": "Ripeti riconoscimento",
  "reRecognizeHint": "Ripete l'estrazione con il file originale e il modello attuale; crea una nuova bozza",
  "reRecognizeFailed": "Ripetizione del riconoscimento non riuscita",
  "reRecognized": "Riconoscimento completato, controlla i campi",
  "selectFile": "Seleziona file",
  "filePlaceholder": "Nessun file selezionato",
  "templatePlaceholder": "Seleziona modello",
  "recognize": "Riconosci",
  "recognizing": "Riconoscimento…",
  "recognizeFailed": "Riconoscimento non riuscito",
  "fieldRequired": "\"{label}\" è obbligatorio"
}
```

routes.json：`"documents": "Archivio documenti"`

- [ ] **Step 12: ru-RU**

```json
"archive": {
  "title": "Архив документов",
  "loadFailed": "Не удалось загрузить документы",
  "empty": "Нет документов",
  "retry": "Повторить",
  "typeAll": "Все типы",
  "statusAll": "Все статусы",
  "statusDraft": "Ожидает подтверждения",
  "statusConfirmed": "Подтверждён",
  "keywordPlaceholder": "Поиск по значениям полей",
  "dateFrom": "С",
  "dateTo": "По",
  "newRecognition": "Новое распознавание",
  "exportCsv": "Экспорт CSV",
  "exportSuccess": "Экспортировано в {path}",
  "exportFailed": "Не удалось экспортировать",
  "exportCanceled": "Экспорт отменён",
  "loadMore": "Загрузить ещё",
  "colType": "Тип",
  "colSummary": "Сводка",
  "colSource": "Источник",
  "colStatus": "Статус",
  "colCreatedAt": "Создан",
  "sourceChat": "Чат",
  "sourceManual": "Вручную",
  "detailTitle": "Сведения о документе",
  "fieldsTitle": "Поля",
  "filesTitle": "Исходные файлы",
  "previewFailed": "Не удалось открыть предпросмотр",
  "noFiles": "Нет связанных файлов",
  "save": "Сохранить",
  "saved": "Сохранено",
  "saveFailed": "Не удалось сохранить",
  "confirmAction": "Подтвердить",
  "confirmFailed": "Не удалось подтвердить",
  "delete": "Удалить",
  "deleteConfirmTitle": "Удалить документ",
  "deleteConfirmDescription": "Удалить этот документ? Действие необратимо.",
  "deleteFailed": "Не удалось удалить",
  "reRecognize": "Распознать снова",
  "reRecognizeHint": "Повторяет извлечение по исходному файлу и текущему шаблону; создаёт новый черновик",
  "reRecognizeFailed": "Не удалось распознать снова",
  "reRecognized": "Распознавание завершено, проверьте поля",
  "selectFile": "Выбрать файл",
  "filePlaceholder": "Файл не выбран",
  "templatePlaceholder": "Выберите шаблон",
  "recognize": "Распознать",
  "recognizing": "Распознавание…",
  "recognizeFailed": "Не удалось распознать",
  "fieldRequired": "\"{label}\" — обязательное поле"
}
```

routes.json：`"documents": "Архив документов"`

- [ ] **Step 13: tr-TR**

```json
"archive": {
  "title": "Belge Arşivi",
  "loadFailed": "Belgeler yüklenemedi",
  "empty": "Belge yok",
  "retry": "Yeniden dene",
  "typeAll": "Tüm türler",
  "statusAll": "Tüm durumlar",
  "statusDraft": "Onay bekliyor",
  "statusConfirmed": "Onaylandı",
  "keywordPlaceholder": "Alan değerlerinde ara",
  "dateFrom": "Başlangıç",
  "dateTo": "Bitiş",
  "newRecognition": "Yeni tanıma",
  "exportCsv": "CSV dışa aktar",
  "exportSuccess": "{path} konumuna dışa aktarıldı",
  "exportFailed": "Dışa aktarma başarısız",
  "exportCanceled": "Dışa aktarma iptal edildi",
  "loadMore": "Daha fazla yükle",
  "colType": "Tür",
  "colSummary": "Özet",
  "colSource": "Kaynak",
  "colStatus": "Durum",
  "colCreatedAt": "Oluşturulma",
  "sourceChat": "Sohbet",
  "sourceManual": "Manuel",
  "detailTitle": "Belge ayrıntıları",
  "fieldsTitle": "Alanlar",
  "filesTitle": "Orijinal dosyalar",
  "previewFailed": "Önizleme başarısız",
  "noFiles": "İlişkili dosya yok",
  "save": "Kaydet",
  "saved": "Kaydedildi",
  "saveFailed": "Kaydetme başarısız",
  "confirmAction": "Onayla",
  "confirmFailed": "Onaylama başarısız",
  "delete": "Sil",
  "deleteConfirmTitle": "Belgeyi sil",
  "deleteConfirmDescription": "Bu belge silinsin mi? Bu işlem geri alınamaz.",
  "deleteFailed": "Silme başarısız",
  "reRecognize": "Yeniden tanı",
  "reRecognizeHint": "Orijinal dosya ve geçerli şablonla çıkarımı yineler; yeni bir taslak oluşturur",
  "reRecognizeFailed": "Yeniden tanıma başarısız",
  "reRecognized": "Yeniden tanıma tamamlandı, alanları gözden geçirin",
  "selectFile": "Dosya seç",
  "filePlaceholder": "Dosya seçilmedi",
  "templatePlaceholder": "Şablon seç",
  "recognize": "Tanı",
  "recognizing": "Tanınıyor…",
  "recognizeFailed": "Tanıma başarısız",
  "fieldRequired": "\"{label}\" zorunludur"
}
```

routes.json：`"documents": "Belge Arşivi"`

- [ ] **Step 14: pl-PL**

```json
"archive": {
  "title": "Archiwum dokumentów",
  "loadFailed": "Nie udało się wczytać dokumentów",
  "empty": "Brak dokumentów",
  "retry": "Ponów",
  "typeAll": "Wszystkie typy",
  "statusAll": "Wszystkie statusy",
  "statusDraft": "Oczekuje",
  "statusConfirmed": "Potwierdzony",
  "keywordPlaceholder": "Szukaj wartości pól",
  "dateFrom": "Od",
  "dateTo": "Do",
  "newRecognition": "Nowe rozpoznawanie",
  "exportCsv": "Eksportuj CSV",
  "exportSuccess": "Wyeksportowano do {path}",
  "exportFailed": "Eksport nie powiódł się",
  "exportCanceled": "Eksport anulowano",
  "loadMore": "Wczytaj więcej",
  "colType": "Typ",
  "colSummary": "Podsumowanie",
  "colSource": "Źródło",
  "colStatus": "Status",
  "colCreatedAt": "Utworzono",
  "sourceChat": "Czat",
  "sourceManual": "Ręcznie",
  "detailTitle": "Szczegóły dokumentu",
  "fieldsTitle": "Pola",
  "filesTitle": "Pliki źródłowe",
  "previewFailed": "Podgląd nie powiódł się",
  "noFiles": "Brak powiązanych plików",
  "save": "Zapisz",
  "saved": "Zapisano",
  "saveFailed": "Zapis nie powiódł się",
  "confirmAction": "Potwierdź",
  "confirmFailed": "Potwierdzenie nie powiodło się",
  "delete": "Usuń",
  "deleteConfirmTitle": "Usuń dokument",
  "deleteConfirmDescription": "Usunąć ten dokument? Tej operacji nie można cofnąć.",
  "deleteFailed": "Usunięcie nie powiodło się",
  "reRecognize": "Rozpoznaj ponownie",
  "reRecognizeHint": "Ponawia ekstrakcję z oryginalnego pliku i bieżącego szablonu; tworzy nowy szkic",
  "reRecognizeFailed": "Ponowne rozpoznawanie nie powiodło się",
  "reRecognized": "Ponowne rozpoznawanie zakończone, sprawdź pola",
  "selectFile": "Wybierz plik",
  "filePlaceholder": "Nie wybrano pliku",
  "templatePlaceholder": "Wybierz szablon",
  "recognize": "Rozpoznaj",
  "recognizing": "Rozpoznawanie…",
  "recognizeFailed": "Rozpoznawanie nie powiodło się",
  "fieldRequired": "\"{label}\" jest wymagane"
}
```

routes.json：`"documents": "Archiwum dokumentów"`

- [ ] **Step 15: da-DK**

```json
"archive": {
  "title": "Dokumentarkiv",
  "loadFailed": "Kunne ikke indlæse dokumenter",
  "empty": "Ingen dokumenter",
  "retry": "Prøv igen",
  "typeAll": "Alle typer",
  "statusAll": "Alle statusser",
  "statusDraft": "Afventer",
  "statusConfirmed": "Bekræftet",
  "keywordPlaceholder": "Søg i feltværdier",
  "dateFrom": "Fra",
  "dateTo": "Til",
  "newRecognition": "Ny genkendelse",
  "exportCsv": "Eksportér CSV",
  "exportSuccess": "Eksporteret til {path}",
  "exportFailed": "Eksport mislykkedes",
  "exportCanceled": "Eksport annulleret",
  "loadMore": "Indlæs flere",
  "colType": "Type",
  "colSummary": "Resumé",
  "colSource": "Kilde",
  "colStatus": "Status",
  "colCreatedAt": "Oprettet",
  "sourceChat": "Chat",
  "sourceManual": "Manuel",
  "detailTitle": "Dokumentdetaljer",
  "fieldsTitle": "Felter",
  "filesTitle": "Originalfiler",
  "previewFailed": "Forhåndsvisning mislykkedes",
  "noFiles": "Ingen tilknyttede filer",
  "save": "Gem",
  "saved": "Gemt",
  "saveFailed": "Kunne ikke gemme",
  "confirmAction": "Bekræft",
  "confirmFailed": "Bekræftelse mislykkedes",
  "delete": "Slet",
  "deleteConfirmTitle": "Slet dokument",
  "deleteConfirmDescription": "Slet dette dokument? Dette kan ikke fortrydes.",
  "deleteFailed": "Kunne ikke slette",
  "reRecognize": "Genkend igen",
  "reRecognizeHint": "Kører ekstraktion igen med originalfilen og den aktuelle skabelon; opretter et nyt udkast",
  "reRecognizeFailed": "Genkendelse igen mislykkedes",
  "reRecognized": "Genkendelse fuldført, gennemgå felterne",
  "selectFile": "Vælg fil",
  "filePlaceholder": "Ingen fil valgt",
  "templatePlaceholder": "Vælg skabelon",
  "recognize": "Genkend",
  "recognizing": "Genkender…",
  "recognizeFailed": "Genkendelse mislykkedes",
  "fieldRequired": "\"{label}\" er påkrævet"
}
```

routes.json：`"documents": "Dokumentarkiv"`

- [ ] **Step 16: fa-IR**

```json
"archive": {
  "title": "آرشیو اسناد",
  "loadFailed": "بارگذاری اسناد ناموفق بود",
  "empty": "سندی وجود ندارد",
  "retry": "تلاش دوباره",
  "typeAll": "همه انواع",
  "statusAll": "همه وضعیت‌ها",
  "statusDraft": "در انتظار تأیید",
  "statusConfirmed": "تأییدشده",
  "keywordPlaceholder": "جستجوی مقادیر فیلدها",
  "dateFrom": "از",
  "dateTo": "تا",
  "newRecognition": "شناسایی جدید",
  "exportCsv": "خروجی CSV",
  "exportSuccess": "به {path} صادر شد",
  "exportFailed": "خروجی ناموفق بود",
  "exportCanceled": "خروجی لغو شد",
  "loadMore": "بارگذاری بیشتر",
  "colType": "نوع",
  "colSummary": "خلاصه",
  "colSource": "منبع",
  "colStatus": "وضعیت",
  "colCreatedAt": "تاریخ ایجاد",
  "sourceChat": "گفتگو",
  "sourceManual": "دستی",
  "detailTitle": "جزئیات سند",
  "fieldsTitle": "فیلدها",
  "filesTitle": "فایل‌های اصلی",
  "previewFailed": "پیش‌نمایش ناموفق بود",
  "noFiles": "فایل پیوستی وجود ندارد",
  "save": "ذخیره",
  "saved": "ذخیره شد",
  "saveFailed": "ذخیره ناموفق بود",
  "confirmAction": "تأیید",
  "confirmFailed": "تأیید ناموفق بود",
  "delete": "حذف",
  "deleteConfirmTitle": "حذف سند",
  "deleteConfirmDescription": "این سند حذف شود؟ این عمل قابل بازگشت نیست.",
  "deleteFailed": "حذف ناموفق بود",
  "reRecognize": "شناسایی مجدد",
  "reRecognizeHint": "استخراج را با فایل اصلی و قالب فعلی دوباره اجرا می‌کند؛ یک پیش‌نویس جدید می‌سازد",
  "reRecognizeFailed": "شناسایی مجدد ناموفق بود",
  "reRecognized": "شناسایی مجدد کامل شد، فیلدها را بازبینی کنید",
  "selectFile": "انتخاب فایل",
  "filePlaceholder": "فایلی انتخاب نشده است",
  "templatePlaceholder": "قالب را انتخاب کنید",
  "recognize": "شناسایی",
  "recognizing": "در حال شناسایی…",
  "recognizeFailed": "شناسایی ناموفق بود",
  "fieldRequired": "\"{label}\" الزامی است"
}
```

routes.json：`"documents": "آرشیو اسناد"`

- [ ] **Step 17: he-IL**

```json
"archive": {
  "title": "ארכיון מסמכים",
  "loadFailed": "טעינת המסמכים נכשלה",
  "empty": "אין מסמכים",
  "retry": "נסה שוב",
  "typeAll": "כל הסוגים",
  "statusAll": "כל המצבים",
  "statusDraft": "ממתין לאישור",
  "statusConfirmed": "אושר",
  "keywordPlaceholder": "חיפוש ערכי שדות",
  "dateFrom": "מתאריך",
  "dateTo": "עד תאריך",
  "newRecognition": "זיהוי חדש",
  "exportCsv": "ייצוא CSV",
  "exportSuccess": "יוצא אל {path}",
  "exportFailed": "ייצוא נכשל",
  "exportCanceled": "הייצוא בוטל",
  "loadMore": "טען עוד",
  "colType": "סוג",
  "colSummary": "תקציר",
  "colSource": "מקור",
  "colStatus": "מצב",
  "colCreatedAt": "נוצר",
  "sourceChat": "צ'אט",
  "sourceManual": "ידני",
  "detailTitle": "פרטי המסמך",
  "fieldsTitle": "שדות",
  "filesTitle": "קבצים מקוריים",
  "previewFailed": "תצוגה מקדימה נכשלה",
  "noFiles": "אין קבצים משויכים",
  "save": "שמור",
  "saved": "נשמר",
  "saveFailed": "שמירה נכשלה",
  "confirmAction": "אישור",
  "confirmFailed": "אישור נכשל",
  "delete": "מחק",
  "deleteConfirmTitle": "מחיקת מסמך",
  "deleteConfirmDescription": "למחוק את המסמך הזה? לא ניתן לבטל.",
  "deleteFailed": "מחיקה נכשלה",
  "reRecognize": "זהה שוב",
  "reRecognizeHint": "מריץ שוב את החילוץ עם הקובץ המקורי והתבנית הנוכחית; יוצר טיוטה חדשה",
  "reRecognizeFailed": "זיהוי חוזר נכשל",
  "reRecognized": "הזיהוי החוזר הושלם, סקור את השדות",
  "selectFile": "בחר קובץ",
  "filePlaceholder": "לא נבחר קובץ",
  "templatePlaceholder": "בחר תבנית",
  "recognize": "זהה",
  "recognizing": "מזהה…",
  "recognizeFailed": "זיהוי נכשל",
  "fieldRequired": "\"{label}\" נדרש"
}
```

routes.json：`"documents": "ארכיון מסמכים"`

- [ ] **Step 18: vi-VN**

```json
"archive": {
  "title": "Lưu trữ chứng từ",
  "loadFailed": "Không thể tải chứng từ",
  "empty": "Chưa có chứng từ",
  "retry": "Thử lại",
  "typeAll": "Mọi loại",
  "statusAll": "Mọi trạng thái",
  "statusDraft": "Chờ xác nhận",
  "statusConfirmed": "Đã xác nhận",
  "keywordPlaceholder": "Tìm giá trị trường",
  "dateFrom": "Từ",
  "dateTo": "Đến",
  "newRecognition": "Nhận diện mới",
  "exportCsv": "Xuất CSV",
  "exportSuccess": "Đã xuất tới {path}",
  "exportFailed": "Xuất thất bại",
  "exportCanceled": "Đã hủy xuất",
  "loadMore": "Tải thêm",
  "colType": "Loại",
  "colSummary": "Tóm tắt",
  "colSource": "Nguồn",
  "colStatus": "Trạng thái",
  "colCreatedAt": "Ngày tạo",
  "sourceChat": "Trò chuyện",
  "sourceManual": "Thủ công",
  "detailTitle": "Chi tiết chứng từ",
  "fieldsTitle": "Trường",
  "filesTitle": "Tệp gốc",
  "previewFailed": "Xem trước thất bại",
  "noFiles": "Không có tệp đính kèm",
  "save": "Lưu",
  "saved": "Đã lưu",
  "saveFailed": "Lưu thất bại",
  "confirmAction": "Xác nhận",
  "confirmFailed": "Xác nhận thất bại",
  "delete": "Xóa",
  "deleteConfirmTitle": "Xóa chứng từ",
  "deleteConfirmDescription": "Xóa chứng từ này? Hành động này không thể hoàn tác.",
  "deleteFailed": "Xóa thất bại",
  "reRecognize": "Nhận diện lại",
  "reRecognizeHint": "Chạy lại trích xuất với tệp gốc và mẫu hiện tại; tạo bản nháp mới",
  "reRecognizeFailed": "Nhận diện lại thất bại",
  "reRecognized": "Nhận diện lại hoàn tất, hãy kiểm tra các trường",
  "selectFile": "Chọn tệp",
  "filePlaceholder": "Chưa chọn tệp",
  "templatePlaceholder": "Chọn mẫu",
  "recognize": "Nhận diện",
  "recognizing": "Đang nhận diện…",
  "recognizeFailed": "Nhận diện thất bại",
  "fieldRequired": "\"{label}\" là bắt buộc"
}
```

routes.json：`"documents": "Lưu trữ chứng từ"`

- [ ] **Step 19: id-ID**

```json
"archive": {
  "title": "Arsip Dokumen",
  "loadFailed": "Gagal memuat dokumen",
  "empty": "Belum ada dokumen",
  "retry": "Coba lagi",
  "typeAll": "Semua jenis",
  "statusAll": "Semua status",
  "statusDraft": "Menunggu konfirmasi",
  "statusConfirmed": "Terkonfirmasi",
  "keywordPlaceholder": "Cari nilai kolom",
  "dateFrom": "Dari",
  "dateTo": "Hingga",
  "newRecognition": "Pengenalan baru",
  "exportCsv": "Ekspor CSV",
  "exportSuccess": "Diekspor ke {path}",
  "exportFailed": "Ekspor gagal",
  "exportCanceled": "Ekspor dibatalkan",
  "loadMore": "Muat lagi",
  "colType": "Jenis",
  "colSummary": "Ringkasan",
  "colSource": "Sumber",
  "colStatus": "Status",
  "colCreatedAt": "Dibuat",
  "sourceChat": "Obrolan",
  "sourceManual": "Manual",
  "detailTitle": "Detail dokumen",
  "fieldsTitle": "Kolom",
  "filesTitle": "Berkas asli",
  "previewFailed": "Pratinjau gagal",
  "noFiles": "Tidak ada berkas terkait",
  "save": "Simpan",
  "saved": "Tersimpan",
  "saveFailed": "Gagal menyimpan",
  "confirmAction": "Konfirmasi",
  "confirmFailed": "Konfirmasi gagal",
  "delete": "Hapus",
  "deleteConfirmTitle": "Hapus dokumen",
  "deleteConfirmDescription": "Hapus dokumen ini? Tindakan ini tidak dapat dibatalkan.",
  "deleteFailed": "Gagal menghapus",
  "reRecognize": "Kenali ulang",
  "reRecognizeHint": "Menjalankan ulang ekstraksi dengan berkas asli dan templat saat ini; membuat draf baru",
  "reRecognizeFailed": "Pengenalan ulang gagal",
  "reRecognized": "Pengenalan ulang selesai, periksa kolom",
  "selectFile": "Pilih berkas",
  "filePlaceholder": "Belum ada berkas dipilih",
  "templatePlaceholder": "Pilih templat",
  "recognize": "Kenali",
  "recognizing": "Mengenali…",
  "recognizeFailed": "Pengenalan gagal",
  "fieldRequired": "\"{label}\" wajib diisi"
}
```

routes.json：`"documents": "Arsip Dokumen"`

- [ ] **Step 20: ms-MY**

```json
"archive": {
  "title": "Arkib Dokumen",
  "loadFailed": "Gagal memuatkan dokumen",
  "empty": "Tiada dokumen",
  "retry": "Cuba lagi",
  "typeAll": "Semua jenis",
  "statusAll": "Semua status",
  "statusDraft": "Menunggu pengesahan",
  "statusConfirmed": "Disahkan",
  "keywordPlaceholder": "Cari nilai medan",
  "dateFrom": "Dari",
  "dateTo": "Hingga",
  "newRecognition": "Pengecaman baharu",
  "exportCsv": "Eksport CSV",
  "exportSuccess": "Dieksport ke {path}",
  "exportFailed": "Eksport gagal",
  "exportCanceled": "Eksport dibatalkan",
  "loadMore": "Muat lagi",
  "colType": "Jenis",
  "colSummary": "Ringkasan",
  "colSource": "Sumber",
  "colStatus": "Status",
  "colCreatedAt": "Dicipta",
  "sourceChat": "Sembang",
  "sourceManual": "Manual",
  "detailTitle": "Butiran dokumen",
  "fieldsTitle": "Medan",
  "filesTitle": "Fail asal",
  "previewFailed": "Pratonton gagal",
  "noFiles": "Tiada fail berkaitan",
  "save": "Simpan",
  "saved": "Disimpan",
  "saveFailed": "Gagal menyimpan",
  "confirmAction": "Sahkan",
  "confirmFailed": "Pengesahan gagal",
  "delete": "Padam",
  "deleteConfirmTitle": "Padam dokumen",
  "deleteConfirmDescription": "Padam dokumen ini? Tindakan ini tidak boleh dibatalkan.",
  "deleteFailed": "Gagal memadam",
  "reRecognize": "Kenali semula",
  "reRecognizeHint": "Menjalankan semula pengekstrakan dengan fail asal dan templat semasa; mencipta draf baharu",
  "reRecognizeFailed": "Pengecaman semula gagal",
  "reRecognized": "Pengecaman semula selesai, semak medan",
  "selectFile": "Pilih fail",
  "filePlaceholder": "Tiada fail dipilih",
  "templatePlaceholder": "Pilih templat",
  "recognize": "Kenali",
  "recognizing": "Mengecam…",
  "recognizeFailed": "Pengecaman gagal",
  "fieldRequired": "\"{label}\" adalah wajib"
}
```

routes.json：`"documents": "Arkib Dokumen"`

- [ ] **Step 21: 校验 + 类型生成**

Run: `pnpm run i18n ; pnpm run i18n:en ; pnpm run i18n:types`
Expected: 全部通过（20 语言 key 对齐）

- [ ] **Step 22: Commit**

```bash
git add src/renderer/src/i18n
git commit -m "feat(documents): archive i18n 20 locales"
```

---

### Task 6: DocumentsStore 档案状态

**Files:**
- Modify: `src/renderer/src/stores/documents.ts`
- Test: `test/renderer/stores/documentsArchiveStore.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新文件 `test/renderer/stores/documentsArchiveStore.test.ts`——参照 test/renderer/stores/documentsStore.test.ts 的现有 mock 模式（vi.doMock DocumentsClient + 动态 import store；pinia 用 setup 提供的轻量实现，`createPinia`/`setActivePinia` 按该文件现状）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listDocuments = vi.fn()
const updateDocument = vi.fn()
const deleteDocument = vi.fn()
const extractAndDraft = vi.fn()
const exportCsv = vi.fn()
const previewFile = vi.fn()

vi.doMock('@api/DocumentsClient', () => ({
  createDocumentsClient: () => ({
    listDocuments,
    updateDocument,
    deleteDocument,
    extractAndDraft,
    exportCsv,
    previewFile
  })
}))

const { useDocumentsStore } = await import('@/stores/documents')

const draft = {
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'contract',
  templateSnapshot: { fields: [] },
  fields: {},
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1,
  updatedAt: 1
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('documents archive store', () => {
  it('loadArchiveDocuments 首页重置 + 追加 + hasMore', async () => {
    listDocuments.mockResolvedValueOnce({ documents: Array.from({ length: 50 }, (_, i) => ({ ...draft, id: `d${i}` })) })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    expect(listDocuments).toHaveBeenCalledWith({ limit: 50, offset: 0 })
    expect(store.archiveDocuments).toHaveLength(50)
    expect(store.archiveHasMore).toBe(true)
    listDocuments.mockResolvedValueOnce({ documents: [{ ...draft, id: 'x' }] })
    await store.loadArchiveDocuments(false)
    expect(listDocuments).toHaveBeenLastCalledWith({ limit: 50, offset: 50 })
    expect(store.archiveDocuments).toHaveLength(51)
    expect(store.archiveHasMore).toBe(false)
  })

  it('筛选参数透传给 listDocuments', async () => {
    listDocuments.mockResolvedValue({ documents: [] })
    const store = useDocumentsStore()
    store.archiveFilter.typeKey = 'contract'
    store.archiveFilter.status = 'draft'
    store.archiveFilter.keyword = '甲'
    store.archiveFilter.dateFrom = 1
    store.archiveFilter.dateTo = 2
    await store.loadArchiveDocuments()
    expect(listDocuments).toHaveBeenCalledWith({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      dateFrom: 1,
      dateTo: 2,
      limit: 50,
      offset: 0
    })
  })

  it('saveArchiveDocument 保存后替换列表项并置 confirmed', async () => {
    listDocuments.mockResolvedValue({ documents: [draft] })
    updateDocument.mockResolvedValue({ document: { ...draft, status: 'confirmed' } })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    const saved = await store.saveArchiveDocument('d1', {
      buyer: { value: '乙', uncertain: false }
    })
    expect(updateDocument).toHaveBeenCalledWith({
      id: 'd1',
      fields: { buyer: { value: '乙', uncertain: false } },
      status: 'confirmed'
    })
    expect(saved?.status).toBe('confirmed')
    expect(store.archiveDocuments[0].status).toBe('confirmed')
  })

  it('removeArchiveDocument 删除后移出列表', async () => {
    listDocuments.mockResolvedValue({ documents: [draft] })
    deleteDocument.mockResolvedValue({ success: true })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    await store.removeArchiveDocument('d1')
    expect(deleteDocument).toHaveBeenCalledWith('d1')
    expect(store.archiveDocuments).toHaveLength(0)
  })

  it('recognizeDocument 插入新 draft 到列表头部', async () => {
    extractAndDraft.mockResolvedValue({
      document: { ...draft, id: 'new' },
      meta: { route: 'vision', rawOutput: '', durationMs: 1, issues: [] }
    })
    const store = useDocumentsStore()
    const result = await store.recognizeDocument({
      templateId: 'tpl-1',
      file: { path: '/a.png' }
    })
    expect(result.document.id).toBe('new')
    expect(store.archiveDocuments[0].id).toBe('new')
  })

  it('exportArchiveCsv 透传当前筛选', async () => {
    exportCsv.mockResolvedValue({ canceled: false, path: 'C:\\a.csv' })
    const store = useDocumentsStore()
    store.archiveFilter.typeKey = 'contract'
    const result = await store.exportArchiveCsv()
    expect(exportCsv).toHaveBeenCalledWith({ typeKey: 'contract' })
    expect(result).toEqual({ canceled: false, path: 'C:\\a.csv' })
  })

  it('previewArchiveFile 转发 documentId+uriIndex', async () => {
    previewFile.mockResolvedValue({ dataBase64: 'aGk=', mimeType: 'image/png', name: 'a.png' })
    const store = useDocumentsStore()
    const result = await store.previewArchiveFile('d1', 0)
    expect(previewFile).toHaveBeenCalledWith({ documentId: 'd1', uriIndex: 0 })
    expect(result.mimeType).toBe('image/png')
  })
})
```

（若 documentsStore.test.ts 的 pinia 初始化不是 `createPinia`——setup.renderer.ts 有轻量 pinia mock——按该文件现状对齐 setup 方式；断言中 store 属性经 `storeToRefs` 或直接访问均可，以现有文件写法为准。）

- [ ] **Step 2: 运行验证失败**

Run: `pnpm exec vitest run test/renderer/stores/documentsArchiveStore.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（store 无 archive 属性）

- [ ] **Step 3: 实现 store 扩展**

`src/renderer/src/stores/documents.ts`：import 追加 `reactive`（来自 vue）与 `type DocumentRecord, type DocumentFieldEntry, type DocumentStatus`（来自 @shared/documents）；defineStore 返回体前追加：

```ts
  const ARCHIVE_PAGE_SIZE = 50
  const archiveDocuments = ref<DocumentRecord[]>([])
  const archiveIsLoading = ref(false)
  const archiveLoadError = ref<string | null>(null)
  const archiveHasMore = ref(false)
  const archiveFilter = reactive({
    typeKey: undefined as string | undefined,
    status: undefined as DocumentStatus | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  })

  async function loadArchiveDocuments(reset = true, client: DocumentsClient = defaultClient) {
    archiveIsLoading.value = true
    archiveLoadError.value = null
    try {
      const offset = reset ? 0 : archiveDocuments.value.length
      const result = await client.listDocuments({
        ...archiveFilter,
        limit: ARCHIVE_PAGE_SIZE,
        offset
      })
      const documents = result.documents as DocumentRecord[]
      archiveDocuments.value = reset ? documents : [...archiveDocuments.value, ...documents]
      archiveHasMore.value = documents.length === ARCHIVE_PAGE_SIZE
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveDocuments failed', error)
      archiveLoadError.value = 'settings.documents.archive.loadFailed'
    } finally {
      archiveIsLoading.value = false
    }
  }

  function replaceArchiveDocument(document: DocumentRecord) {
    const index = archiveDocuments.value.findIndex((d) => d.id === document.id)
    if (index >= 0) {
      archiveDocuments.value[index] = document
    } else {
      archiveDocuments.value.unshift(document)
    }
  }

  async function saveArchiveDocument(
    id: string,
    fields: Record<string, DocumentFieldEntry>,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentRecord | null> {
    const result = await client.updateDocument({ id, fields, status: 'confirmed' })
    const document = result.document as DocumentRecord | null
    if (document) {
      replaceArchiveDocument(document)
    }
    return document
  }

  async function removeArchiveDocument(id: string, client: DocumentsClient = defaultClient) {
    await client.deleteDocument(id)
    archiveDocuments.value = archiveDocuments.value.filter((d) => d.id !== id)
  }

  async function recognizeDocument(
    input: Parameters<DocumentsClient['extractAndDraft']>[0],
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.extractAndDraft(input)
    const document = result.document as DocumentRecord
    archiveDocuments.value.unshift(document)
    return { document, meta: result.meta }
  }

  async function exportArchiveCsv(client: DocumentsClient = defaultClient) {
    return client.exportCsv({ ...archiveFilter })
  }

  async function previewArchiveFile(
    documentId: string,
    uriIndex: number,
    client: DocumentsClient = defaultClient
  ) {
    return client.previewFile({ documentId, uriIndex })
  }
```

return 对象追加：`archiveDocuments, archiveIsLoading, archiveLoadError, archiveHasMore, archiveFilter, loadArchiveDocuments, saveArchiveDocument, removeArchiveDocument, recognizeDocument, exportArchiveCsv, previewArchiveFile`。

- [ ] **Step 4: 运行验证通过**

Run: `pnpm exec vitest run test/renderer/stores/documentsArchiveStore.test.ts test/renderer/stores/documentsStore.test.ts --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores/documents.ts test/renderer/stores/documentsArchiveStore.test.ts
git commit -m "feat(documents): archive state in pinia store"
```

---

### Task 7: /documents 路由 + 侧边栏入口

**Files:**
- Modify: `src/renderer/src/router/index.ts`
- Modify: `src/renderer/src/components/WindowSideBar.vue`
- Test: `test/renderer/router/documentsRouter.test.ts`（新建）、`test/renderer/components/WindowSideBar.test.ts`（追加）

- [ ] **Step 1: 写失败测试（路由）**

`test/renderer/router/documentsRouter.test.ts`——先读 test/renderer/router/pluginsRouter.test.ts 的 router 断言方式，按同款写：

```ts
import { describe, expect, it } from 'vitest'
import router from '@/router'

describe('documents archive route', () => {
  it('注册了 /documents 路由并指向档案页', () => {
    const route = router.resolve('/documents')
    expect(route.name).toBe('documents')
    expect(route.matched[0]?.components?.default).toBeDefined()
  })
})
```

- [ ] **Step 2: 写失败测试（侧边栏）**

`test/renderer/components/WindowSideBar.test.ts` 按该文件现有用例模式追加一条：挂载后存在 `data-testid="app-documents-button"` 按钮，文本含 `单据档案`（或 t('routes.documents') 的解析值，依现有测试对 i18n 的处理方式），且点击后触发 router push `/documents`（以现有 plugins 按钮用例的断言方式为范本）。

- [ ] **Step 3: 运行验证失败**

Run: `pnpm exec vitest run test/renderer/router/documentsRouter.test.ts test/renderer/components/WindowSideBar.test.ts --config vitest.config.renderer.ts`
Expected: FAIL

- [ ] **Step 4: 实现**

`src/renderer/src/router/index.ts` 在 `/welcome` 路由前插入：

```ts
    {
      path: '/documents',
      name: 'documents',
      component: () => import('@/pages/documents/DocumentsArchivePage.vue'),
      meta: {
        titleKey: 'routes.documents',
        icon: 'lucide:inbox'
      }
    },
```

`src/renderer/src/components/WindowSideBar.vue`：plugins 按钮（L192-201）之后追加同款按钮：

```html
            <button
              data-testid="app-documents-button"
              type="button"
              class="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors hover:bg-accent/60"
              :class="documentsRouteActive ? 'bg-accent/70 text-foreground' : 'text-foreground'"
              @click="openDocuments"
            >
              <Icon icon="lucide:inbox" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ t('routes.documents') }}</span>
            </button>
```

script 区：照 `pluginsRouteActive`/`openPlugins` 的既有实现（computed + router.push），追加：

```ts
const documentsRouteActive = computed(() => route.name === 'documents')
const openDocuments = () => {
  void router.push('/documents')
}
```

（具体变量名以该文件中 plugins 版本的实际命名为准，保持同款风格。）

- [ ] **Step 5: 创建档案页占位组件使路由可解析**

`src/renderer/src/pages/documents/DocumentsArchivePage.vue`（本任务仅最小骨架，Task 8 填充）：

```vue
<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">
        {{ t('settings.documents.archive.title') }}
      </h1>
    </header>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
```

- [ ] **Step 6: 运行验证通过**

Run: `pnpm exec vitest run test/renderer/router/documentsRouter.test.ts test/renderer/components/WindowSideBar.test.ts --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/router/index.ts src/renderer/src/components/WindowSideBar.vue src/renderer/src/pages/documents/DocumentsArchivePage.vue test/renderer/router/documentsRouter.test.ts test/renderer/components/WindowSideBar.test.ts
git commit -m "feat(documents): archive route and sidebar entry"
```

### Task 8: 档案页纯函数 + 列表页（工具栏 + 动态表格）

**Files:**
- Create: `src/renderer/src/pages/documents/documentArchive.ts`
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue`（替换 Task 7 骨架）
- Test: `test/renderer/pages/documents/documentArchive.test.ts`、`test/renderer/pages/documents/DocumentsArchivePage.test.ts`（新建）

- [ ] **Step 1: 写纯函数失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildMoneyColumns,
  formatDateRangeToMs,
  formatFieldValue,
  orderedSnapshotFields
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
  it('收集列表中出现过的金额类字段（typeKey+key 去重）', () => {
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
          fields: [money('total_amount', '合计金额')]
        },
        fields: { total_amount: { value: 2, uncertain: false } }
      }),
      record({
        id: 'd3',
        templateSnapshot: { ...snapshot, fields: [field('buyer', '购买方', 1)] },
        fields: {}
      })
    ]
    const columns = buildMoneyColumns(documents)
    expect(columns).toHaveLength(2)
    expect(columns[0]).toEqual({ typeKey: 'invoice_special', key: 'total_amount', label: '价税合计' })
    expect(columns[1]).toEqual({ typeKey: 'invoice_general', key: 'total_amount', label: '合计金额' })
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
```

- [ ] **Step 2: 实现 documentArchive.ts**

```ts
import type { DocumentRecord, DocumentTemplateField } from '@shared/documents'

const MONEY_FIELD_RE = /amount|total|tax|price|金额|合计|税|价格|价税/i

export interface MoneyColumn {
  typeKey: string
  key: string
  label: string
}

export function orderedSnapshotFields(snapshot: DocumentRecord['templateSnapshot']) {
  return [...snapshot.fields].sort((a, b) => a.order - b.order)
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export function buildMoneyColumns(documents: DocumentRecord[]): MoneyColumn[] {
  const seen = new Map<string, MoneyColumn>()
  for (const document of documents) {
    for (const field of document.templateSnapshot.fields) {
      if (!MONEY_FIELD_RE.test(field.key) && !MONEY_FIELD_RE.test(field.label)) {
        continue
      }
      if (document.fields[field.key]?.value == null) {
        continue
      }
      const columnKey = `${document.typeKey}:${field.key}`
      if (!seen.has(columnKey)) {
        seen.set(columnKey, { typeKey: document.typeKey, key: field.key, label: field.label })
      }
    }
  }
  return [...seen.values()]
}

export function formatDateRangeToMs(
  value: string,
  boundary: 'start' | 'end' = 'start'
): number | undefined {
  if (!value) {
    return undefined
  }
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (!year || !month || !day) {
    return undefined
  }
  return boundary === 'start'
    ? new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
    : new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
}
```

- [ ] **Step 3: 写列表页组件失败测试**

`test/renderer/pages/documents/DocumentsArchivePage.test.ts`——参照 DocumentsSettings.test.ts 的组件测试模式（vi.doMock store/子组件 + mount）。核心用例：

```ts
// 文件头部 mock（按 DocumentsSettings.test.ts 现有模式适配）：
// - vi.doMock('@/stores/documents', ...) 提供 useDocumentsStore stub：
//   templates、archiveDocuments、archiveFilter(reactive)、archiveIsLoading、archiveHasMore、
//   loadArchiveDocuments、removeArchiveDocument、exportArchiveCsv 等 ref/函数
// - vi.doMock('./DocumentDetailDialog.vue' 与 './DocumentRecognizeDialog.vue', ...) 为 stub 组件
const makeRecord = (overrides = {}) => ({
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'contract',
  templateSnapshot: {
    fields: [{ key: 'buyer', label: '购买方', valueType: 'text', required: true, promptHint: null, validation: null, enumOptions: null, order: 1 }]
  },
  fields: { buyer: { value: '甲公司', uncertain: false } },
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

describe('DocumentsArchivePage', () => {
  it('挂载时调用 loadArchiveDocuments 并渲染行', async () => {
    const loadArchiveDocuments = vi.fn()
    // ...mount，stub store.archiveDocuments = [makeRecord()]
    expect(loadArchiveDocuments).toHaveBeenCalled()
    expect(document.body.textContent).toContain('甲公司')
    expect(document.body.textContent).toContain('购买方')
  })

  it('全部类型视图渲染类型/摘要/来源/状态列', async () => {
    // stub archiveDocuments = [makeRecord()]，typeFilter 为空
    expect(document.body.textContent).toContain('摘要')
  })

  it('修改类型筛选后调用 loadArchiveDocuments(false 之外重置)', async () => {
    // 触发类型 Select change → 断言 loadArchiveDocuments 再次被调用
  })

  it('导出按钮调用 exportArchiveCsv 并按结果提示', async () => {
    // stub exportArchiveCsv resolved { canceled: false, path: 'C:\\a.csv' }
    // 点击 data-testid="archive-export" → 断言 exportArchiveCsv 被调用
  })

  it('行点击打开详情对话框', async () => {
    // 点击行 → 断言 stub 的 DocumentDetailDialog 收到 open + document props
  })

  it('点击新建识别打开识别对话框', async () => {
    // 点击 data-testid="archive-new-recognition" → stub RecognizeDialog open=true
  })

  it('加载失败显示错误与重试', async () => {
    // stub archiveLoadError = 'settings.documents.archive.loadFailed'
    // 断言重试按钮 data-testid="archive-retry" 点击再次调用 loadArchiveDocuments
  })

  it('hasMore 时显示加载更多按钮', async () => {
    // stub archiveHasMore = true → data-testid="archive-load-more" 点击调 loadArchiveDocuments(false)
  })
})
```

（以上为行为契约；实际 mock 结构与挂载辅助照 DocumentsSettings.test.ts 的现有写法完整展开，不得留下伪代码。）

- [ ] **Step 4: 实现 DocumentsArchivePage.vue**

完整替换 Task 7 骨架：

```vue
<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">
        {{ t('settings.documents.archive.title') }}
      </h1>
      <div class="flex items-center gap-2">
        <DcButton
          variant="outline"
          data-testid="archive-export"
          :disabled="store.archiveIsLoading"
          @click="onExportCsv"
        >
          <Icon icon="lucide:download" class="mr-1 size-4" />
          {{ t('settings.documents.archive.exportCsv') }}
        </DcButton>
        <DcButton data-testid="archive-new-recognition" @click="recognizeOpen = true">
          <Icon icon="lucide:scan-text" class="mr-1 size-4" />
          {{ t('settings.documents.archive.newRecognition') }}
        </DcButton>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <Select
        :model-value="store.archiveFilter.typeKey ?? ALL_VALUE"
        data-testid="archive-filter-type"
        class="w-44"
        @update:model-value="onTypeFilter"
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_VALUE">{{ t('settings.documents.archive.typeAll') }}</SelectItem>
          <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.typeKey">
            {{ tpl.name }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select
        :model-value="store.archiveFilter.status ?? ALL_VALUE"
        data-testid="archive-filter-status"
        class="w-36"
        @update:model-value="onStatusFilter"
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_VALUE">{{ t('settings.documents.archive.statusAll') }}</SelectItem>
          <SelectItem value="draft">{{ t('settings.documents.archive.statusDraft') }}</SelectItem>
          <SelectItem value="confirmed">{{ t('settings.documents.archive.statusConfirmed') }}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        v-model="dateFromText"
        type="date"
        data-testid="archive-filter-date-from"
        class="w-40"
        :aria-label="t('settings.documents.archive.dateFrom')"
      />
      <span class="text-muted-foreground">~</span>
      <Input
        v-model="dateToText"
        type="date"
        data-testid="archive-filter-date-to"
        class="w-40"
        :aria-label="t('settings.documents.archive.dateTo')"
      />
      <Input
        v-model="keywordText"
        type="search"
        data-testid="archive-filter-keyword"
        class="w-52"
        :placeholder="t('settings.documents.archive.keywordPlaceholder')"
        @keydown.enter="applyFilters"
      />
    </div>

    <div v-if="store.archiveLoadError" class="flex flex-col items-center gap-3 px-6 py-10">
      <p class="text-sm text-destructive">{{ t(store.archiveLoadError) }}</p>
      <DcButton variant="outline" data-testid="archive-retry" @click="retry">
        {{ t('settings.documents.archive.retry') }}
      </DcButton>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-auto px-6 py-3">
      <table v-if="store.archiveDocuments.length" class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-b text-left text-muted-foreground">
            <th v-if="!selectedTypeKey" class="px-2 py-2 font-medium">
              {{ t('settings.documents.archive.colType') }}
            </th>
            <th
              v-for="column in tableFieldColumns"
              :key="columnKey(column)"
              class="px-2 py-2 font-medium"
            >
              {{ column.label }}
            </th>
            <th v-if="!selectedTypeKey" class="px-2 py-2 font-medium">
              {{ t('settings.documents.archive.colSummary') }}
            </th>
            <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colSource') }}</th>
            <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colStatus') }}</th>
            <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colCreatedAt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="document in store.archiveDocuments"
            :key="document.id"
            data-testid="archive-row"
            class="cursor-pointer border-b transition-colors hover:bg-accent/40"
            @click="openDetail(document)"
          >
            <td v-if="!selectedTypeKey" class="px-2 py-2">
              {{ templateNameById.get(document.templateId) ?? document.typeKey }}
            </td>
            <td v-for="column in tableFieldColumns" :key="columnKey(column)" class="px-2 py-2">
              {{ formatFieldValue(document.fields[column.key]?.value ?? null) }}
            </td>
            <td v-if="!selectedTypeKey" class="max-w-64 truncate px-2 py-2">
              {{ summarizeDocument(document) }}
            </td>
            <td class="px-2 py-2">
              {{ t(`settings.documents.archive.source${capitalize(document.source)}`) }}
            </td>
            <td class="px-2 py-2">
              {{ t(`settings.documents.archive.status${capitalize(document.status)}`) }}
            </td>
            <td class="px-2 py-2">{{ new Date(document.createdAt).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!store.archiveIsLoading" class="px-2 py-10 text-center text-sm text-muted-foreground">
        {{ t('settings.documents.archive.empty') }}
      </p>
      <div v-if="store.archiveHasMore" class="flex justify-center py-3">
        <DcButton variant="outline" data-testid="archive-load-more" @click="store.loadArchiveDocuments(false)">
          {{ t('settings.documents.archive.loadMore') }}
        </DcButton>
      </div>
    </div>

    <DocumentDetailDialog
      v-model:open="detailOpen"
      :document="detailDocument"
      @re-recognized="onReRecognized"
    />
    <DocumentRecognizeDialog v-model:open="recognizeOpen" @recognized="onRecognized" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentRecord } from '@shared/documents'
import {
  formatDateRangeToMs,
  formatFieldValue,
  orderedSnapshotFields,
  type MoneyColumn
} from './documentArchive'
import DocumentDetailDialog from './DocumentDetailDialog.vue'
import DocumentRecognizeDialog from './DocumentRecognizeDialog.vue'
import { summarizeDocument } from './documentSummary'

const ALL_VALUE = '__all__'

const { t } = useI18n()
const store = useDocumentsStore()

const detailOpen = ref(false)
const recognizeOpen = ref(false)
const detailDocument = ref<DocumentRecord | null>(null)
const dateFromText = ref('')
const dateToText = ref('')
const keywordText = ref('')

const selectedTypeKey = computed(() =>
  store.archiveFilter.typeKey ? store.archiveFilter.typeKey : null
)

const templateNameById = computed(
  () => new Map(store.templates.map((tpl) => [tpl.id, tpl.name]))
)

const tableFieldColumns = computed<{ key: string; label: string; typeKey?: string }[]>(() => {
  if (selectedTypeKey.value) {
    const template = store.templates.find((tpl) => tpl.typeKey === selectedTypeKey.value)
    if (template) {
      return orderedSnapshotFields({ fields: template.fields } as DocumentRecord['templateSnapshot']).map(
        (f) => ({ key: f.key, label: f.label })
      )
    }
    return []
  }
  return moneyColumns.value.map((column) => ({
    key: column.key,
    label: column.label,
    typeKey: column.typeKey
  }))
})

const moneyColumns = computed<MoneyColumn[]>(() => buildMoneyColumns(store.archiveDocuments))

const columnKey = (column: { key: string; typeKey?: string }) =>
  column.typeKey ? `${column.typeKey}:${column.key}` : column.key

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

function syncFilters() {
  store.archiveFilter.dateFrom = formatDateRangeToMs(dateFromText.value)
  store.archiveFilter.dateTo = formatDateRangeToMs(dateToText.value, 'end')
  store.archiveFilter.keyword = keywordText.value.trim() || undefined
}

function applyFilters() {
  syncFilters()
  void store.loadArchiveDocuments()
}

function onTypeFilter(value: unknown) {
  store.archiveFilter.typeKey = value === ALL_VALUE ? undefined : String(value)
  void store.loadArchiveDocuments()
}

function onStatusFilter(value: unknown) {
  store.archiveFilter.status =
    value === ALL_VALUE ? undefined : (String(value) as 'draft' | 'confirmed')
  void store.loadArchiveDocuments()
}

watch(dateFromText, applyFilters)
watch(dateToText, applyFilters)

function retry() {
  void store.loadArchiveDocuments()
}

async function onExportCsv() {
  const result = await store.exportArchiveCsv()
  if (result.canceled) {
    // 取消无需报错
    return
  }
  // 成功提示（sonner toast；参照项目内现有 toast 用法）
  // toast.success(t('settings.documents.archive.exportSuccess', { path: result.path }))
}

function openDetail(document: DocumentRecord) {
  detailDocument.value = document
  detailOpen.value = true
}

function onReRecognized(document: DocumentRecord) {
  detailDocument.value = document
}

function onRecognized(document: DocumentRecord) {
  detailDocument.value = document
  detailOpen.value = true
}

void store.loadTemplates()
void store.loadArchiveDocuments()
</script>
```

实现注意：
- `summarizeDocument` 从 Task 3 的 `@main/documents/csv` 是主进程模块——**渲染层不可直接 import**。在 `src/renderer/src/pages/documents/documentSummary.ts` 新建渲染层副本（同 summarizeDocument 逻辑 + formatFieldValue，纯函数 15 行），Page 与测试均引用它；主进程 csv.ts 保持不动（两处用途不同，允许重复，注释说明来源）。
- `buildMoneyColumns` import 自 `./documentArchive`（上面代码遗漏处补上：`import { buildMoneyColumns } from './documentArchive'`，合并进现有 import）。
- toast 用项目现有 toast 机制（搜索 `sonner` 或 `useToast` 的既有用法），成功/失败提示 `exportSuccess`/`exportFailed`。
- 单类型视图列来自 `store.templates`（当前模板最新字段）；行值仍按快照 fields 之外可能缺 key，`?? null` 兜底显示空串。

- [ ] **Step 5: 运行验证通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/documents test/renderer/pages/documents
git commit -m "feat(documents): archive list page"
```

---

### Task 9: 详情对话框（字段编辑 + 预览 + 确认/删除/重识别）

**Files:**
- Create: `src/renderer/src/pages/documents/DocumentDetailDialog.vue`
- Modify: `src/renderer/src/pages/documents/documentArchive.ts`（追加值编辑纯函数）
- Test: `test/renderer/pages/documents/DocumentDetailDialog.test.ts`（新建）

- [ ] **Step 1: 追加值编辑纯函数与测试**

`documentArchive.ts` 追加：

```ts
export interface FieldEditState {
  key: string
  label: string
  valueType: DocumentTemplateField['valueType']
  required: boolean
  enumOptions: string[] | null
  raw: string
  entry: { value: unknown; uncertain: boolean } | null
}

export function buildFieldEditStates(document: DocumentRecord): FieldEditState[] {
  return orderedSnapshotFields(document.templateSnapshot).map((field) => {
    const entry = document.fields[field.key] ?? null
    const raw =
      field.valueType === 'array' && Array.isArray(entry?.value)
        ? (entry.value as unknown[]).map((item) => String(item)).join('\n')
        : entry
          ? formatFieldValue(entry.value)
          : ''
    return {
      key: field.key,
      label: field.label,
      valueType: field.valueType,
      required: field.required,
      enumOptions: field.enumOptions,
      raw,
      entry
    }
  })
}

export function parseFieldEditState(state: FieldEditState):
  | { ok: true; value: unknown }
  | { ok: false; error: 'required' | 'number' | 'json' } {
  const text = state.raw
  if (state.valueType === 'array') {
    if (!text.trim()) {
      return state.required ? { ok: false, error: 'required' } : { ok: true, value: null }
    }
    return { ok: true, value: text.split('\n').map((line) => line.trim()).filter(Boolean) }
  }
  if (!text.trim()) {
    return state.required ? { ok: false, error: 'required' } : { ok: true, value: null }
  }
  if (state.valueType === 'number') {
    const parsed = Number(text.trim())
    return Number.isFinite(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: 'number' }
  }
  if (state.valueType === 'enum' && state.enumOptions && !state.enumOptions.includes(text)) {
    return { ok: false, error: 'json' }
  }
  return { ok: true, value: text }
}
```

测试（追加到 documentArchive.test.ts）：

```ts
describe('buildFieldEditStates / parseFieldEditState', () => {
  it('array 值按行序列化，保存时按行解析', () => {
    const document = record({
      fields: { items: { value: ['甲', '乙'], uncertain: true } }
    })
    const states = buildFieldEditStates(document)
    expect(states[0].raw).toBe('甲\n乙')
    const parsed = parseFieldEditState({ ...states[0], raw: '甲\n乙\n\n' })
    expect(parsed).toEqual({ ok: true, value: ['甲', '乙'] })
  })

  it('required 字段为空报 required', () => {
    const states = buildFieldEditStates(record({ fields: {} }))
    const required = { ...states[0], required: true, raw: '' }
    expect(parseFieldEditState(required)).toEqual({ ok: false, error: 'required' })
  })

  it('number 非法报 number', () => {
    const states = buildFieldEditStates(record({ fields: {} }))
    expect(parseFieldEditState({ ...states[0], valueType: 'number', raw: 'abc' })).toEqual({
      ok: false,
      error: 'number'
    })
  })

  it('编辑后值参与保存、未编辑字段保留原 entry', () => {
    // DocumentDetailDialog 保存逻辑测试中覆盖（见下）
  })
})
```

- [ ] **Step 2: 写组件失败测试**

`test/renderer/pages/documents/DocumentDetailDialog.test.ts`（mock store 同 Task 8 模式）核心用例：

```ts
describe('DocumentDetailDialog', () => {
  it('按快照渲染字段控件并显示值', async () => {})
  it('修改 text 字段后保存调用 saveArchiveDocument 且 edited 字段 uncertain=false', async () => {})
  it('未编辑字段原样透传原 entry', async () => {})
  it('required 空值阻断保存并显示 fieldRequired', async () => {})
  it('draft 显示确认按钮；confirmed 显示确认时间', async () => {})
  it('删除走 AlertDialog 确认后调用 removeArchiveDocument 并关闭', async () => {})
  it('重新识别调用 recognizeDocument(fileUris[0], 原模板) 并 emit re-recognized', async () => {})
  it('文件区列出 fileUris 并可预览图片（previewArchiveFile 返回后渲染 img）', async () => {})
  it('preview 失败显示 previewFailed', async () => {})
})
```

每条用例需给出完整 mount/stub/断言代码（照 DocumentsSettings.test.ts 模式展开；`document` prop 用 Task 8 的 makeRecord 结构）。

- [ ] **Step 3: 实现组件**

```vue
<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-3xl" data-testid="document-detail-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('settings.documents.archive.detailTitle') }}</DialogTitle>
      </DialogHeader>

      <div v-if="document" class="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{{ templateName }}</span>
          <span>·</span>
          <span>{{ statusText }}</span>
          <span v-if="document.status === 'confirmed'">
            · {{ new Date(document.updatedAt).toLocaleString() }}
          </span>
        </div>

        <section class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('settings.documents.archive.fieldsTitle') }}</h3>
          <div
            v-for="state in editStates"
            :key="state.key"
            class="grid grid-cols-[10rem_1fr] items-start gap-2"
          >
            <label class="pt-2 text-sm" :for="`field-${state.key}`">
              {{ state.label }}
              <span v-if="state.entry?.uncertain" class="text-amber-500">*</span>
            </label>
            <div>
              <Select
                v-if="state.valueType === 'enum' && state.enumOptions"
                :model-value="state.raw"
                @update:model-value="(value) => (state.raw = String(value))"
              >
                <SelectTrigger :id="`field-${state.key}`"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in state.enumOptions" :key="option" :value="option">
                    {{ option }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                v-else-if="state.valueType === 'array'"
                :id="`field-${state.key}`"
                v-model="state.raw"
                rows="3"
                data-testid="detail-field-array"
              />
              <Input
                v-else
                :id="`field-${state.key}`"
                v-model="state.raw"
                :type="state.valueType === 'number' ? 'number' : state.valueType === 'date' ? 'date' : 'text'"
                :data-testid="`detail-field-${state.key}`"
              />
            </div>
          </div>
          <p v-if="fieldError" class="text-xs text-destructive" data-testid="detail-field-error">
            {{ fieldError }}
          </p>
        </section>

        <section class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('settings.documents.archive.filesTitle') }}</h3>
          <p v-if="document.fileUris.length === 0" class="text-sm text-muted-foreground">
            {{ t('settings.documents.archive.noFiles') }}
          </p>
          <div v-else class="space-y-2">
            <div
              v-for="(uri, index) in document.fileUris"
              :key="uri"
              class="flex items-center gap-2 text-sm"
            >
              <Icon icon="lucide:paperclip" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate" :title="uri">{{ uri }}</span>
              <DcButton
                variant="outline"
                size="sm"
                :data-testid="`detail-preview-${index}`"
                @click="togglePreview(index)"
              >
                {{ t('settings.documents.archive.filesTitle') }}
              </DcButton>
            </div>
            <p v-if="previewError" class="text-xs text-destructive" data-testid="detail-preview-error">
              {{ t('settings.documents.archive.previewFailed') }}
            </p>
            <img
              v-if="preview && preview.mimeType.startsWith('image/')"
              :src="`data:${preview.mimeType};base64,${preview.dataBase64}`"
              :alt="preview.name"
              class="max-h-96 rounded border"
              data-testid="detail-preview-image"
            />
            <embed
              v-else-if="preview && preview.mimeType === 'application/pdf'"
              :src="`data:application/pdf;base64,${preview.dataBase64}`"
              type="application/pdf"
              class="h-96 w-full rounded border"
              data-testid="detail-preview-pdf"
            />
          </div>
        </section>
      </div>

      <DialogFooter class="flex-wrap gap-2">
        <span v-if="feedback" class="mr-auto text-sm" :class="feedbackClass" data-testid="detail-feedback">
          {{ feedback }}
        </span>
        <DcButton variant="outline" :disabled="busy" @click="onReRecognize">
          {{ t('settings.documents.archive.reRecognize') }}
        </DcButton>
        <DcButton variant="outline" :disabled="busy" data-testid="detail-delete" @click="deleteOpen = true">
          {{ t('settings.documents.archive.delete') }}
        </DcButton>
        <DcButton :disabled="busy" data-testid="detail-save" @click="onSave">
          {{ t('settings.documents.archive.save') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="deleteOpen" @update:open="(value) => (deleteOpen = value)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('settings.documents.archive.deleteConfirmTitle') }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ t('settings.documents.archive.deleteConfirmDescription') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('settings.documents.archive.reRecognizeFailed') ? '' : '' }}</AlertDialogCancel>
        <AlertDialogAction data-testid="detail-delete-confirm" @click="onDelete">
          {{ t('settings.documents.archive.delete') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
```

（AlertDialogCancel 文案用通用取消 key——若 common 命名空间已有 `common.cancel` 则用之；否则该处直接用 `settings.documents.archive` 之外不新增 key 的方案：读取 `t('common.cancel')` 前先在 en-US/common.json 确认存在，若不存在则 AlertDialogCancel 内容留空标签不可行——此时改用 `t('settings.documents.archive.exportCanceled')` 不合适；最终方案：**检查 common.json 已有 cancel key**（大概率存在，项目通用组件大量使用取消按钮），按实际存在的 key 使用并在计划执行时如无则用 `t('chat.sidebar.searchAriaLabel')` 式既有 key 不可取——执行者必须先 `grep "cancel" src/renderer/src/i18n/zh-CN/common.json` 确认后使用该 key。）

script 逻辑（与模板配合的完整 setup，此处给出行为规范，代码按模板逐项落实）：
- props：`open: boolean`、`document: DocumentRecord | null`；emits：`update:open`、`re-recognized`。
- `editStates = ref<FieldEditState[]>([])`，`watch(() => props.document, (doc) => { editStates.value = doc ? buildFieldEditStates(doc) : []; preview.value = null; previewError.value = false }, { immediate: true })`。
- `onSave`：逐 state `parseFieldEditState`；任一失败 → `fieldError = t('settings.documents.archive.fieldRequired', { label })`（number/json 错误用同 key 语义不合适——直接显示 `t('settings.documents.archive.saveFailed')`）并 return；全部通过 → `fields = {}`：state 有原始 entry 且 `state.raw === 原始序列化值` → 原样保留 `fields[key] = state.entry`；否则 `fields[key] = { value: parsed.value, uncertain: false }`；调用 `store.saveArchiveDocument(document.id, fields)`；成功 `feedback = t('...saved')`（3s 后清除），失败 `feedback = t('...saveFailed')`。
- `onReRecognize`：`fileUris[0]` 存在时调用 `store.recognizeDocument({ templateId: document.templateId, file: { path: document.fileUris[0] }, source: 'manual' })`，成功 `emit('re-recognized', result.document)` + `feedback = t('...reRecognized')`；无文件或失败 `feedback = t('...reRecognizeFailed')`。
- `onDelete`：`await store.removeArchiveDocument(document.id)` → `emit('update:open', false)`；失败 `feedback = t('...deleteFailed')`。
- `togglePreview(index)`：`await store.previewArchiveFile(document.id, index)` → `preview`/`previewError`。
- `statusText`：draft → `t('settings.documents.archive.statusDraft')`；confirmed → `statusConfirmed`。
- `busy` = save/recognize/delete 进行中任一为真。

- [ ] **Step 4: 运行验证通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/documents test/renderer/pages/documents
git commit -m "feat(documents): detail dialog with edit"
```

---

### Task 10: 新建识别对话框

**Files:**
- Create: `src/renderer/src/pages/documents/DocumentRecognizeDialog.vue`
- Test: `test/renderer/pages/documents/DocumentRecognizeDialog.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

核心用例（mock store 与 DeviceClient，模式同前）：

```ts
describe('DocumentRecognizeDialog', () => {
  it('渲染模板下拉（templates）与文件选择', async () => {})
  it('选择文件后显示文件名', async () => {})
  it('未选文件或未选模板时开始识别禁用', async () => {})
  it('提交调用 recognizeDocument({templateId, file:{path}, source:"manual"}) 并 emit recognized', async () => {})
  it('识别中按钮显示 recognizing 且禁用', async () => {})
  it('失败显示 recognizeFailed 并可重试', async () => {})
})
```

每条用例完整展开（stub `selectFiles` 返回 `{ canceled: false, filePaths: ['C:\\a.png'] }`）。

- [ ] **Step 2: 实现组件**

```vue
<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-lg" data-testid="document-recognize-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('settings.documents.archive.newRecognition') }}</DialogTitle>
        <DialogDescription>{{ t('settings.documents.archive.reRecognizeHint') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1">
          <span class="text-sm font-medium">{{ t('settings.documents.archive.selectFile') }}</span>
          <div class="flex items-center gap-2">
            <Input
              :model-value="fileName ?? t('settings.documents.archive.filePlaceholder')"
              readonly
              data-testid="recognize-file-input"
            />
            <DcButton variant="outline" data-testid="recognize-select-file" @click="onSelectFile">
              {{ t('settings.documents.archive.selectFile') }}
            </DcButton>
          </div>
        </div>
        <div class="space-y-1">
          <span class="text-sm font-medium">{{ t('settings.documents.archive.templatePlaceholder') }}</span>
          <Select :model-value="templateId" @update:model-value="(value) => (templateId = String(value))">
            <SelectTrigger data-testid="recognize-template-trigger"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.id">
                {{ tpl.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-if="error" class="text-sm text-destructive" data-testid="recognize-error">
          {{ t('settings.documents.archive.recognizeFailed') }}
        </p>
      </div>
      <DialogFooter>
        <DcButton :disabled="!canSubmit || submitting" data-testid="recognize-submit" @click="onSubmit">
          {{ submitting ? t('settings.documents.archive.recognizing') : t('settings.documents.archive.recognize') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

script 规范：
- props `open: boolean`；emits `update:open`、`recognized(document: DocumentRecord)`。
- `onSelectFile`：`createDeviceClient().selectFiles({ multiple: false, filters: [{ name: 'Documents', extensions: ['png','jpg','jpeg','webp','gif','pdf'] }] })`——DeviceClient 的导入与用法先读 src/renderer/api/DeviceClient.ts 确认（是否需参数工厂或默认导出实例，按现状使用）；`filePaths[0]` → `filePath`，`fileName = basename`（渲染层用 `uri.split(/[\\/]/).pop()`）。
- `canSubmit = computed(() => Boolean(filePath && templateId))`；`templateId` 默认 `store.templates[0]?.id ?? ''`（watch open 打开时重置 error/submitting，保留已选文件）。
- `onSubmit`：`submitting = true; error = false`；`await store.recognizeDocument({ templateId, file: { path: filePath }, source: 'manual' })` → `emit('recognized', result.document)` + `emit('update:open', false)`；catch → `error = true`；finally `submitting = false`。

- [ ] **Step 3: 运行验证通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages/documents test/renderer/pages/documents
git commit -m "feat(documents): recognize dialog"
```

---

### Task 11: 内建 agent tool handler

**Files:**
- Modify: `src/shared/agentTools.ts`
- Create: `src/main/tool/agentTools/documentRecognitionTool.ts`
- Modify: `src/main/tool/runtimePorts.ts`
- Test: `test/main/documents/documentRecognitionTool.test.ts`（新建）

- [ ] **Step 1: 共享常量**

`src/shared/agentTools.ts` 追加（放在 CRON_JOB_AGENT_TOOL_NAME 附近）：

```ts
export const DOCUMENT_RECOGNITION_AGENT_TOOL_NAME = 'document_recognition'
export const DOCUMENT_RECOGNITION_TOOL_SERVER_NAME = 'documents'
```

- [ ] **Step 2: 端口类型**

`src/main/tool/runtimePorts.ts` 追加（AgentToolDependencies 定义之前）：

```ts
export interface AgentDocumentsToolPort {
  listTemplates: () => Promise<
    Array<{
      id: string
      typeKey: string
      name: string
      fields: Array<{ key: string; label: string; valueType: string; required: boolean; order: number }>
    }>
  >
  extractAndDraft: (input: {
    templateId: string
    file: { path: string; name?: string; mimeType?: string }
    source?: 'chat' | 'manual'
    sessionId?: string
  }) => Promise<{
    document: {
      id: string
      typeKey: string
      status: string
      fields: Record<string, { value: unknown; uncertain: boolean }>
      fileUris: string[]
    }
    meta: { route: string; durationMs: number; issues: string[] }
  }>
  confirmDocument: (input: {
    id: string
    fields?: Record<string, { value: unknown; uncertain: boolean }>
  }) => Promise<{ id: string; status: string } | null>
}
```

`AgentToolDependencies` 追加成员：`documents: AgentDocumentsToolPort`。

- [ ] **Step 3: 写失败测试**

`test/main/documents/documentRecognitionTool.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { DocumentRecognitionToolHandler, documentRecognitionActionNeedsPermission } from '@/tool/agentTools/documentRecognitionTool'
import { DOCUMENT_RECOGNITION_AGENT_TOOL_NAME } from '@shared/agentTools'

const makePort = () => ({
  listTemplates: vi.fn(async () => [
    {
      id: 'tpl-1',
      typeKey: 'invoice_special',
      name: '增值税专用发票',
      fields: [{ key: 'invoice_code', label: '发票代码', valueType: 'text', required: true, order: 1 }]
    }
  ]),
  extractAndDraft: vi.fn(async () => ({
    document: {
      id: 'd1',
      typeKey: 'invoice_special',
      status: 'draft',
      fields: { invoice_code: { value: '123', uncertain: false } },
      fileUris: ['/tmp/a.jpg']
    },
    meta: { route: 'vision', durationMs: 10, issues: [] }
  })),
  confirmDocument: vi.fn(async () => ({ id: 'd1', status: 'confirmed' }))
})

describe('documentRecognitionTool', () => {
  it('definition 暴露 tool 名与 json schema', () => {
    const definition = new DocumentRecognitionToolHandler().getToolDefinition()
    expect(definition.name).toBe(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME)
    expect(definition.inputSchema).toBeDefined()
  })

  it('list_templates 返回模板列表且免权限', async () => {
    const port = makePort()
    const result = await new DocumentRecognitionToolHandler().call(
      { action: 'list_templates' },
      port
    )
    expect(result.ok).toBe(true)
    expect(port.listTemplates).toHaveBeenCalled()
    expect(documentRecognitionActionNeedsPermission({ action: 'list_templates' })).toBe(false)
  })

  it('recognize 需要 templateId+file 并透传 source=chat', async () => {
    const port = makePort()
    const handler = new DocumentRecognitionToolHandler()
    const ok = await handler.call(
      { action: 'recognize', templateId: 'tpl-1', file: { path: '/tmp/a.jpg' } },
      port
    )
    expect(ok.ok).toBe(true)
    expect(port.extractAndDraft).toHaveBeenCalledWith({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'chat'
    })
    const missing = await handler.call({ action: 'recognize' }, port)
    expect(missing.ok).toBe(false)
    expect(documentRecognitionActionNeedsPermission({ action: 'recognize' })).toBe(true)
  })

  it('confirm 需要 documentId；未找到返回错误', async () => {
    const handler = new DocumentRecognitionToolHandler()
    const missing = await handler.call({ action: 'confirm' }, makePort())
    expect(missing.ok).toBe(false)
    const port = makePort()
    port.confirmDocument.mockResolvedValueOnce(null)
    const notFound = await handler.call({ action: 'confirm', documentId: 'x' }, port)
    expect(notFound.ok).toBe(false)
    const ok = await handler.call({ action: 'confirm', documentId: 'd1' }, port)
    expect(ok.ok).toBe(true)
    expect(documentRecognitionActionNeedsPermission({ action: 'confirm' })).toBe(true)
  })

  it('非法输入返回 INVALID_INPUT 错误', async () => {
    const result = await new DocumentRecognitionToolHandler().call({ action: 'nope' }, makePort())
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_INPUT')
    expect(documentRecognitionActionNeedsPermission({ action: 'nope' })).toBe(true)
  })
})
```

- [ ] **Step 4: 运行验证失败**

Run: `pnpm exec vitest run test/main/documents/documentRecognitionTool.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 5: 实现 handler**

`src/main/tool/agentTools/documentRecognitionTool.ts`：

```ts
import { z } from 'zod'
import { toDeepChatJsonSchema } from '@shared/lib/zodJsonSchema'
import type { MCPToolDefinition } from '@shared/types/mcp'
import { DOCUMENT_RECOGNITION_AGENT_TOOL_NAME } from '@shared/agentTools'
import {
  createAgentToolErrorResult,
  createAgentToolSuccessResult,
  type AgentToolResult
} from '@shared/lib/agentToolResultEnvelope'
import type { AgentDocumentsToolPort } from '../runtimePorts'

const fileSchema = z.strictObject({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(255).optional(),
  mimeType: z.string().trim().min(1).max(128).optional()
})

const documentRecognitionToolSchema = z.strictObject({
  action: z.enum(['list_templates', 'recognize', 'confirm']),
  templateId: z.string().trim().min(1).optional(),
  file: fileSchema.optional(),
  documentId: z.string().trim().min(1).optional(),
  fields: z
    .record(z.string(), z.object({ value: z.unknown(), uncertain: z.boolean() }))
    .optional()
})

type DocumentRecognitionToolInput = z.infer<typeof documentRecognitionToolSchema>

export function documentRecognitionActionNeedsPermission(args: unknown): boolean {
  const parsed = documentRecognitionToolSchema.safeParse(args)
  if (!parsed.success) {
    return true
  }
  return parsed.data.action !== 'list_templates'
}

const TOOL_DESCRIPTION = [
  'Recognize administrative documents (invoices, contracts, travel tickets, hotel receipts,',
  'purchase orders, payment screenshots, ...) and archive the extracted fields.',
  'Actions: list_templates — list available document templates with their fields;',
  'recognize — extract fields from a local file with the chosen template and save a draft',
  'archive record; confirm — mark the draft as confirmed after the user reviews the fields.'
].join(' ')

export class DocumentRecognitionToolHandler {
  getToolDefinition(): MCPToolDefinition {
    return {
      name: DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: toDeepChatJsonSchema(documentRecognitionToolSchema)
    }
  }

  isDocumentRecognitionTool(toolName: string): boolean {
    return toolName === DOCUMENT_RECOGNITION_AGENT_TOOL_NAME
  }

  async call(args: unknown, port: AgentDocumentsToolPort): Promise<AgentToolResult> {
    let input: DocumentRecognitionToolInput
    try {
      input = documentRecognitionToolSchema.parse(args)
    } catch (error) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        error instanceof Error ? error.message : String(error),
        { code: 'INVALID_INPUT' }
      )
    }

    if (input.action === 'list_templates') {
      const templates = await port.listTemplates()
      return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, templates, {
        summary: `Found ${templates.length} document template(s).`,
        data: { templates },
        meta: { resultCount: templates.length }
      })
    }

    if (input.action === 'recognize') {
      if (!input.templateId || !input.file) {
        return createAgentToolErrorResult(
          DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
          'templateId and file.path are required for the recognize action.',
          { code: 'MISSING_ARGUMENTS', recoverable: true }
        )
      }
      const result = await port.extractAndDraft({
        templateId: input.templateId,
        file: input.file,
        source: 'chat'
      })
      return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, result, {
        summary:
          `Recognized document ${result.document.id} (type ${result.document.typeKey}) and saved ` +
          'a draft archive. Show the extracted fields to the user, highlight uncertain fields, ' +
          'and ask for confirmation before calling confirm.',
        data: result
      })
    }

    if (!input.documentId) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        'documentId is required for the confirm action.',
        { code: 'MISSING_ARGUMENTS', recoverable: true }
      )
    }
    const updated = await port.confirmDocument({ id: input.documentId, fields: input.fields })
    if (!updated) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        `Document not found: ${input.documentId}`,
        { code: 'NOT_FOUND', recoverable: true }
      )
    }
    return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, updated, {
      summary: `Document ${updated.id} confirmed.`
    })
  }
}
```

- [ ] **Step 6: 运行验证通过 + Commit**

Run: `pnpm exec vitest run test/main/documents/documentRecognitionTool.test.ts --config vitest.config.ts`
Expected: PASS

```bash
git add src/shared/agentTools.ts src/main/tool/runtimePorts.ts src/main/tool/agentTools/documentRecognitionTool.ts test/main/documents/documentRecognitionTool.test.ts
git commit -m "feat(documents): agent recognition tool"
```

---

### Task 12: agentToolManager 接线 + composition 端口

**Files:**
- Modify: `src/main/tool/agentTools/agentToolManager.ts`（5 处）
- Modify: `src/main/app/composition.ts`
- Test: 既有 agent tool 相关套件回归（本任务无新测试，靠 typecheck + 回归）

- [ ] **Step 1: manager 五处接线**

① import 区（cronJobTool import 附近）：

```ts
import {
  DocumentRecognitionToolHandler,
  documentRecognitionActionNeedsPermission
} from './documentRecognitionTool'
```

以及从 `@shared/agentTools` 的既有 import 中追加 `DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, DOCUMENT_RECOGNITION_TOOL_SERVER_NAME`。

② 字段声明（L269 `cronJobToolHandler` 旁）：

```ts
  private readonly documentRecognitionToolHandler: DocumentRecognitionToolHandler
```

③ 构造实例化（L555 旁）：

```ts
    this.documentRecognitionToolHandler = new DocumentRecognitionToolHandler()
```

④ appendDefinitions（L714-717 cronjob 块之后；决策 8：不加 isAgentMode 门；若发现 appendDefinitions 仅在 agent 模式上下文可达，则加同款门并在计划偏差记录中注明）：

```ts
    // 2.4. Document recognition tool
    appendDefinitions(
      [this.documentRecognitionToolHandler.getToolDefinition()],
      'user-configurable'
    )
```

⑤ call 路由（L958-967 cronjob 路由之后）：

```ts
    if (this.documentRecognitionToolHandler.isDocumentRecognitionTool(toolName)) {
      return await this.documentRecognitionToolHandler.call(args, this.dependencies.documents)
    }
```

⑥ 权限（L3025-3034 cronjob 权限块之后）：

```ts
    if (
      toolName === DOCUMENT_RECOGNITION_AGENT_TOOL_NAME &&
      documentRecognitionActionNeedsPermission(args)
    ) {
      return {
        needsPermission: true,
        toolName,
        serverName: DOCUMENT_RECOGNITION_TOOL_SERVER_NAME,
        permissionType: 'write',
        description: 'Document recognition writes an archive draft and consumes model quota.',
        conversationId
      }
    }
```

- [ ] **Step 2: composition 端口**

`src/main/app/composition.ts`：cronJobs 端口对象（L1653-1665）之后追加：

```ts
    documents: {
      listTemplates: async () =>
        documentsRepository.listTemplates().map((template) => ({
          id: template.id,
          typeKey: template.typeKey,
          name: template.name,
          fields: [...template.fields]
            .sort((a, b) => a.order - b.order)
            .map((field) => ({
              key: field.key,
              label: field.label,
              valueType: field.valueType,
              required: field.required,
              order: field.order
            }))
        })),
      extractAndDraft: async (input) => {
        const result = await documentExtractor.extract({
          templateId: input.templateId,
          file: input.file
        })
        const document = documentsRepository.insertDocument({
          templateId: result.template.id,
          typeKey: result.template.typeKey,
          templateSnapshot: result.template,
          fields: result.fields,
          fileUris: [input.file.path],
          source: input.source ?? 'chat',
          sessionId: input.sessionId ?? null,
          status: 'draft',
          now: Date.now()
        })
        return {
          document: {
            id: document.id,
            typeKey: document.typeKey,
            status: document.status,
            fields: document.fields,
            fileUris: document.fileUris
          },
          meta: {
            route: result.route,
            durationMs: result.durationMs,
            issues: result.issues
          }
        }
      },
      confirmDocument: async (input) => {
        const updated = await documentsRepository.updateDocument(input.id, {
          fields: input.fields,
          status: 'confirmed'
        })
        return updated ? { id: updated.id, status: updated.status } : null
      }
    },
```

注意：`documentExtractor`（L2816）在端口对象声明之后才赋值——闭包在工具调用时才执行，运行时安全；若 typecheck 报"use before declaration"，将 `documentExtractor` 的声明提升或在端口处改用惰性访问（参照 `createLivePort(() => liveDelegationService)` 模式，L1680）。`updateDocument` 的 `fields` 参数类型为 `Record<string, { value: unknown; uncertain: boolean }>`，与端口入参一致；确认 `repository.updateDocument` 支持仅传 status（Task 现有签名支持 fields/status 均可选）。

- [ ] **Step 3: 验证**

Run: `pnpm run typecheck:node`
Expected: PASS

Run: `pnpm exec vitest run test/main/tool --config vitest.config.ts`（若该目录测试量大，改为跑 agentToolManager 相关测试文件；至少保证无新增失败）
Expected: 无新增失败

- [ ] **Step 4: Commit**

```bash
git add src/main/tool/agentTools/agentToolManager.ts src/main/app/composition.ts
git commit -m "feat(documents): wire recognition tool"
```

---

### Task 13: skill 泛化（document-recognition）

**Files:**
- Create: `plugins/office-automation/skills/document-recognition/SKILL.md`
- Delete: `plugins/office-automation/skills/invoice-recognition/SKILL.md`（整个目录）
- Modify: `plugins/office-automation/plugin.json:36-40`
- Modify: `plugins/office-automation/skills/office-reimbursement/SKILL.md:31`
- Modify: `plugins/office-automation/mcp/reimbursementServer.mjs:62`

- [ ] **Step 1: 新 skill**

`plugins/office-automation/skills/document-recognition/SKILL.md`：

```markdown
---
name: document-recognition
description: 识别行政单据（发票/合同/行程单/住宿单/订购单/付款截图等）并归档。Use when the user
  provides document images/PDFs or asks to extract, archive, or reimburse document fields
  (发票/收据/合同/行程单/报销票据).
metadata:
  deepchatFeature: office-automation
---

# document-recognition

Guide the agent to recognize administrative documents through the built-in
`document_recognition` agent tool. Do NOT parse documents with regex or
external OCR tools, and do NOT hand-craft extraction prompts — the main
process extraction service routes by file type and generates prompts from
the selected template.

## When To Use

- 用户附加单据图片/PDF，或提到 发票 / 收据 / 合同 / 行程单 / 住宿单 / 订购单 / 付款截图 / 报销
- 需要把单据字段归档（draft → confirmed）供报销/汇总使用

## Required Loop

1. 调用 `document_recognition`（action: `list_templates`）获取可用模板，
   按文档内容选择最匹配的模板 id（如发票 → invoice_special / invoice_general）
2. 调用 `document_recognition`（action: `recognize`，带 templateId 与
   file.path——会话附件优先，用户提供路径时直接使用该路径）
3. 向用户展示返回的 fields 表格，uncertain 字段高亮提示核对；
   缺失字段显示为空，禁止臆造
4. 用户确认或修正后：action: `confirm`（documentId；修正值通过 fields 传入）
5. 报销场景：确认后的字段按 create_reimbursement 工具的 invoices 入参
   结构整理后调用下游工具

## Important Notes

- recognize 每次生成一条 draft 档案记录；重新识别会产生新记录
- 金额一律两位小数；不对金额做四舍五入以外的加工
- 多张单据逐张识别、逐张确认
- 视觉模型不可用时 recognize 返回降级提示，引导用户配置 defaultVisionModel
```

- [ ] **Step 2: 更新引用**

`plugin.json` skills 数组：`invoice-recognition` 项替换为：

```json
    {
      "id": "document-recognition",
      "path": "skills/document-recognition/SKILL.md",
      "scope": "agent"
    },
```

`office-reimbursement/SKILL.md:31`："Follow the invoice-recognition skill" → "Follow the document-recognition skill"。

`reimbursementServer.mjs:62`：工具描述中 "invoice-recognition Skill 的输出" → "document-recognition Skill 的输出"。

- [ ] **Step 3: 删除旧 skill**

用文件删除工具删除 `plugins/office-automation/skills/invoice-recognition/SKILL.md`（目录随之清空）。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm exec vitest run test/main --config vitest.config.ts` 过滤插件相关（若存在 office-automation/plugin.json 解析测试则确保通过；无则跳过）
Expected: 无新增失败

```bash
git add plugins/office-automation
git commit -m "feat(documents): generalize invoice skill"
```

---

### Task 14: 收尾验证 + 推送

- [ ] **Step 1: 全量检查**

```bash
pnpm run format
pnpm run i18n
pnpm run i18n:en
pnpm run i18n:types
pnpm run lint
pnpm run typecheck
```
Expected: 全部通过（format 有改动则归入最后一个修复 commit）

- [ ] **Step 2: 相关测试套件**

```bash
pnpm run test:main
pnpm exec vitest run test/renderer/pages/documents test/renderer/stores test/renderer/api test/renderer/router test/renderer/components/WindowSideBar.test.ts test/renderer/settings/documents --config vitest.config.renderer.ts
```
Expected: main 全绿；renderer 除预存在 17 失败（providerStore 3 / ModelProviderSettings 12 / 保留项 2）外无新增失败。

- [ ] **Step 3: 整体代码审查**

派最终 code reviewer 子代理审查 `git log --oneline develop` 自 P4 首个提交起的全部变更（对照 spec §7/§9/§10 与本计划），修复其发现的问题并补提交。

- [ ] **Step 4: 计划偏差回填**

将执行期所有偏差（Task 8 的 toast 用法、Task 9 的 cancel key、Task 12 的 extractor 声明处理、Task 12 的 isAgentMode 门决策等）记入本节下方「执行期偏差记录」。

- [ ] **Step 5: 推送**

```bash
git push origin develop
```

---

## 自查记录（writing-plans Self-Review）

1. **Spec 覆盖**：§7 契约（list 日期✓/exportCsv✓/其余已有）；§9 工具栏四件套✓、动态表格（单类型字段列/全类型摘要+金额列）✓、详情抽屉（编辑/预览/重识别/状态）✓、新建识别✓；§10 skill 泛化✓、agent tool✓、确认转 confirmed✓、下游 create_reimbursement 输入兼容（fields 语义对齐，工具本身不改）✓；CSV 导出✓。e2e（spec §11）标注为可选手测，本计划不含。
2. **占位符扫描**：Task 8/9/10 的组件测试以「行为契约 + 指定 mock 模式」表述并明确要求完整展开（现有测试范本驱动），组件 script 部分以行为规范+关键决策给出——这是有意折中（组件视觉代码由测试驱动），执行者不得留 TODO。Task 9 cancel key 与 Task 12 两处已给明确决策路径，无悬空引用。
3. **类型一致性**：AgentDocumentsToolPort ↔ composition 端口 ↔ handler port 调用一致；store 方法签名 ↔ 页面调用一致；DocumentsClient 新方法 ↔ 契约 input/output 一致；csv.ts 的 DocumentsCsvInput ↔ routes 调用一致。

---

## 执行期偏差记录（回填于 Task 14）

- **T1 契约**：barrel 实际为 `src/shared/contracts/routes.ts`（非计划的 `routes/index.ts`），新路由已补 `DEEPCHAT_ROUTE_CATALOG` 注册；exportCsv output 用 `.refine` 表达非取消时 path 必填（zod v4 下 `optional()+min(1)` 语义不足，沿仓库既有惯例）。
- **T3 csv 纯函数**：计划自带测试代码 3 处笔误修正——BOM 断言与 `split('\r\n')` 冲突（lines[0] 含 BOM 前缀）、全类型用例 fixture 漏 typeKey override、`as const` 与 DocumentTemplate 类型冲突。
- **T4 export/preview 路由**：test/setup.ts 全局 mock fs/path，测试文件顶部需 `vi.unmock('fs')/('node:fs')/('path')/('node:path')`（有既有先例）。
- **T8 档案列表页**：toast 走 `rendererNotificationManager.notify({kind, code, title})`；因 Vite import-analysis 要求 import 文件存在，先落 DocumentDetailDialog/DocumentRecognizeDialog 占位骨架，由 T9/T10 替换为完整实现。
- **T9 详情对话框**：AlertDialog lint guard 禁止 AlertDialogAction 绑定 async handler → 用 `AlertDialogAsyncAction` + 成功后手动关闭（照 DocumentsSettings.vue 范本）。
- **T11 agent tool**：MCPToolDefinition 实际为嵌套结构 `{execution, type, function:{name,description,parameters}, server}`（非计划假设的扁平结构），按 cronJobTool 同构实现；测试断言相应改为 `definition.function.name/parameters`。
- **T12 接线**：① 注册加 `isAgentMode` 门（同类原生工具注册 2.1/2.16/2.25/2.3 全带门；仅排除 ACP 会话，普通聊天 agent 模式不受影响，决策 8 据此修订）；② call 路由做 envelope→AgentToolCallResult 转换（`content = JSON.stringify(data ?? summary)` + `rawData.toolResult` 保留完整信封，参照 question/tool-search 路由）；③ `documentExtractor` 声明在 registerRoutes() 内部（比计划 TDZ 预案更受限，直接引用报 TS2304），按 liveDelegationService 同款模式外层 `let` + 函数内赋值。
- **验证环境**：本机标准 Node 下 better-sqlite3-multiple-ciphers ABI 不匹配 → plain node 跑主进程测试时 sqlite 用例 skip；sqlite 套件用 `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files>` 验证。
- **收尾验证结果**：format/i18n×3/lint/typecheck(node+web) 全绿；test/main 98 失败均为 P4 未触碰区域预存在 Windows 环境问题（47 个失败文件与 P4 改动零交集，示例：`/tmp` vs `D:\tmp`、CRLF、toolchains）；test/main/documents 全套（Electron 运行时）98/98 通过；test/main/tool 与基线持平（16 失败为已知环境问题）；renderer 定向套件仅预存在失败（pluginCatalogStore 2 / providerStore 3；stores 大批量合跑有资源型 worker 原生崩溃 flake，子集均通过）。
- **最终整体审查**：READY，无 Critical/Important；后续跟进 Minor/Nit——①全类型视图金额列按 field.key 取值未校验 typeKey（同名 key 可能重复列）②spec「或 auto」选项 UI 未暴露（计划阶段有意收窄）③archive 死 i18n key 3 个（exportCanceled/confirmAction/confirmFailed ×20 语言）④formatFieldValue 双副本可复用 documentSummary 副本；已知遗留（agentToolDependencies 未 stub documents、路由未接 dispatch commit、port 无 AbortSignal 槽位、dateFrom>dateTo 无交叉校验等）均确认无恶化。

