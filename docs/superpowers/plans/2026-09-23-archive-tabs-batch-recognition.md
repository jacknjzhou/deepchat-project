# 单据档案 Tab 化 + 批量识别任务 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 档案页按单据类型 Tab 展示（每类显示全部识别字段 + 各状态数量统计 + 最近 1 周默认 + 分页）；新建识别支持一次提交多文件（可自动分类），提交立即返回，主进程异步任务队列处理并经 typed event 推送进度。

**Architecture:** 主进程新增 `document_tasks` sqlite 表 + `RecognitionTaskManager`（并发 2 的任务泵，复用现有 `DocumentExtractor`，`templateId='auto'` 走既有大模型分类），经 `documents.tasks.create/list` 路由 + `documents.task.updated` 事件对接渲染层；档案页改造为 Tabs（全部 + 每模板一 Tab），`documents.list` 增加 `total`、新增 `documents.stats` 统计路由，load-more 改为页码分页。

**Tech Stack:** Electron/Vue 3/TS、zod typed IPC 契约、better-sqlite3、Pinia、DcButton/DcBadge、Vitest。

---

## 关键事实（研究结论，实现者必读）

环境：Windows PowerShell（命令用 `;` 分隔，`&&` 会报错）；pnpm only；Oxfmt 单引号无分号 100 列；Conventional Commits ≤50 字符；分支 develop；用户完成后直接 push origin/develop。

### 既有模块（P1-P4 产物）

| 事实 | 位置 |
|---|---|
| documents 契约：`documentsListRoute` input 已有 typeKey/status/keyword/dateFrom/dateTo/limit/offset，output 只有 `{documents}` **无 total** | src/shared/contracts/routes/documents.routes.ts:92-100,146-150 |
| 契约 barrel：新路由需在 `routes.ts` 的 import 块（约 L381-392）+ `DEEPCHAT_ROUTE_CATALOG`（约 L810）两处登记 | src/shared/contracts/routes.ts |
| `documentsTable.list(filter)` 已支持全部筛选 + limit/offset，`LIST_DEFAULT_LIMIT=100`；**无 count/stats 查询** | src/main/documents/data/tables/documents.ts:84-115 |
| `DocumentsRepository.listDocuments/insertDocument/updateDocument` 已有；extractor 依赖接口 `Pick<DocumentsRepository,...>` | src/main/documents/repository.ts:141-151 |
| **`templateId='auto'` 自动分类已实现**：图片走 vision 模型、PDF 取文本前 4000 字走 text 模型，输出 `"typeKey":"xxx"` 正则解析，失败抛错 | src/main/documents/extractor/documentExtractor.ts:205-260 |
| `buildRoutePlan`：图片→vision（mode='text' 强制 ocr）；PDF 有文本层→text，否则 ocr。**图片 mode='auto' 时若无 vision 模型会直接抛错（requireTarget），没有 OCR 回落** | src/main/documents/extractor/documentExtractor.ts:84,262-286 |
| extractor 组装点（generateCompletion/resolveVisionTarget/resolveTextTarget/extractOcrText 等依赖注入） | src/main/app/composition.ts:2870-2932 |
| `createDocumentsRoutes(repository, extractor, csvDeps)`；route handler 直接闭包调用 | src/main/documents/routes.ts:54-58 |
| 新 sqlite 表必须在 schemaCatalog 登记：条目形如 `{ name: 'documents', createTable: (db) => new DocumentsTable(db) }` | src/main/data/schemaCatalog.ts:397-405 |
| `DocumentsDatabase` 提供 getter，mainDatabase 连接 | src/main/documents/data/database.ts；composition.ts:899 |
| BaseTable 模式：`getCreateTableSQL/getLatestVersion/getMigrationSQL`；表类含 insert/update/list SQL | src/main/documents/data/tables/documents.ts:49-78 |
| typed event 模式：`defineEventContract` + events.ts 里 `export *` + `DEEPCHAT_EVENT_CATALOG` 两处；main 用 `publishDeepchatEvent('name', payload)` | src/shared/contracts/events.ts:38,178；composition.ts:1354-1363 范本 |
| renderer 订阅：client 方法 `bridge.on(eventName.name, listener)` 返回退订函数 | src/renderer/api/AcpAuthClient.ts:32-36、src/preload/createBridge.ts:107-137 |
| `device.selectFiles` 支持 `{ multiple: true }` 返回 `filePaths[]`（对话框已用 multiple:false） | src/renderer/src/pages/documents/DocumentRecognizeDialog.vue:170-173 |
| DocumentsClient 13 方法（无 tasks/stats/onXxx） | src/renderer/api/DocumentsClient.ts:57-82 |
| store：`archiveFilter` reactive、`loadArchiveDocuments(reset)` offset 累加 + `archiveHasMore` load-more（将被页码分页替换）、`recognizeDocument` 同步等待 | src/renderer/src/stores/documents.ts:120-152 |
| 档案页：类型/状态是 Select；类型选中后列即切换为该模板全部字段（`tableFieldColumns`）；未选中时用 `buildMoneyColumns` + 摘要列 | src/renderer/src/pages/documents/DocumentsArchivePage.vue:88-134,207-217 |
| 识别对话框：单文件、templateId 默认第一个模板、submit 后同步等待（计时器） | src/renderer/src/pages/documents/DocumentRecognizeDialog.vue |
| UI 组件：DcButton（@dc-ui/components/button）、DcBadge（@shadcn 有 Tabs 但主窗口页测试 stub 复杂 → 本计划用普通按钮做 Tab）、Icon @iconify/vue | src/renderer/src/pages/plugins/skills/SkillImportExportTab.vue:269,373,387 |
| i18n：`settings.documents.archive.*` 在 20 语言 settings.json；校验 `pnpm run i18n`、`pnpm run i18n:en`、`pnpm run i18n:types` | src/renderer/src/i18n/<lang>/settings.json |
| main 测试范本：sqlite 可用性探测 + `vi.unmock('fs')/('node:fs')/('path')/('node:path')`（见文件头） | test/main/documents/documentsRoutes.test.ts:21-34 |
| renderer 测试范本：vi.doMock store/i18n + stub 组件 + setup 里重置 reactive stubStore | test/renderer/pages/documents/DocumentsArchivePage.test.ts:142-192 |
| 预存在失败：test:main ~98 个 Windows 环境失败（/tmp 路径、CRLF 等，勿修勿混入）；渲染层 17 个预存失败（providerStore 3、ModelProviderSettings 12、保留 2） | — |
| 工作区保留项（永不 stage）：test/renderer/stores/pluginCatalogStore.test.ts、resources/skills/* | — |

### 设计决策（定死）

1. **Tab = 普通 DcButton 行**（全部 + 每模板一个），不用 reka-ui Tabs：主窗口页测试 stub 简单、无额外依赖。Tab 徽标数字 = 该类型在当前日期范围内的总数（来自 `documents.stats`）。
2. **统计口径**：`documents.stats` 只按日期范围过滤（不含 status/keyword），返回每 typeKey 的 total/draft/confirmed；"全部" Tab 的状态数字为各类型之和。状态筛选改为 Tab 内容区的三个 chips（全部/待确认/已确认，带数量），替换原状态 Select；类型 Select 移除（被 Tab 取代）。
3. **默认日期范围**：挂载时默认"最近 7 天"（本地日期文本，止为今天），用户可清空日期输入查看全部。
4. **分页**：服务端 offset 分页，`documents.list` output 增加 `total`；UI 为 `‹ x / y ›` 页码控件 + "共 N 条"，每页 50，替换 load-more。切 Tab/筛选/任务完成都会回到第 1 页。
5. **批量提交**：对话框多选文件（上限 20，契约层 `.max(20)`），整批一个模板选择器，顶部固定 `auto`（自动分类，默认选中）；提交 → `documents.tasks.create` 立即返回 → 对话框关闭，档案页顶部任务条展示进度。
6. **任务持久化**：新表 `document_tasks`（pending/running/done/failed + source 列）。重启恢复策略：启动时 `running → failed("interrupted by app restart")`，`pending` 重新入队继续跑（文件仍在本地，安全）。
7. **并发与速度**：任务泵默认并发 2（OCR 是 CPU 型、LLM 是网络型，混跑可重叠提速）；OCR warmup 已有。**扫描版 PDF 无法走多模态**（无 PDF 栅格化依赖，不新增依赖），其仍走 OCR→text 模型；**图片 mode='auto' 时改为：配置了 vision 模型 → vision（快且准），未配置 → OCR+text 回落（原来直接抛错）**——这是"本地 OCR 慢时同步使用多模态大模型"的落地形式。
8. **自动分类失败兜底**：任务标 failed，error 透出 extractor 的错误消息（如 `auto classification failed: unknown typeKey xxx`），任务条提供"重试"（同 templateId 单文件重建任务）。
9. **聊天入口不变**：agent tool `document_recognition` 保持同步 extractAndDraft（聊天内联需要结果），不接任务队列。
10. **事件 payload**：`documents.task.updated` = task 全字段 + `doneCount/totalCount`（按 batchId 从表内统计，重启后仍正确）+ `version`。
11. **导出 CSV**：沿用 `archiveFilter`（含 Tab 对应 typeKey），无需改动。

### UI 变更 BEFORE/AFTER

```
BEFORE（混合大表）
┌──────────────────────────────────────────────────────────────┐
│ 单据档案                                 [导出CSV][新建识别] │
│ [全部类型▾][全部状态▾][日期起~止][关键字]                     │
│ │类型│金额列…│摘要│来源│状态│创建时间│  ← 只见金额列，看不到  │
│ └──混合所有类型，无法展示各类型全部字段──┘    各类型全部字段   │
│                    [加载更多]                                │
└──────────────────────────────────────────────────────────────┘

AFTER（类型 Tab + 状态统计 + 分页 + 任务条）
┌──────────────────────────────────────────────────────────────┐
│ 单据档案                                 [导出CSV][新建识别] │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ (全部 12)(增值税专用发票 5)(普通发票 3)(付款截图 2)(…)  │  │
│ └────────────────────────────────────────────────────────┘  │
│ [全部 5][待确认 3][已确认 2]  [日期起~止][关键字]             │
│ ┌ 识别任务：发票A 识别中… · 发票B 已完成 · 扫件C 失败[重试] ┐│
│ │该类型模板全部字段列（发票号码│开票日期│金额合计│…│状态│时间）││
│ 共 37 条                                       ‹ 1 / 2 ›    │
└──────────────────────────────────────────────────────────────┘

新建识别对话框 AFTER：多选文件列表（可移除）+ [自动分类（大模型）▾]
提交立即返回（不再卡窗口等待）。
```

---

## File Structure（新增/修改文件总览）

```
src/shared/contracts/routes/documents.routes.ts    [改] +total、+stats 路由、+tasks 路由、documentTaskSchema
src/shared/contracts/routes.ts                     [改] barrel import + catalog 两处登记
src/shared/contracts/events/documents.events.ts    [新] documentsTaskUpdatedEvent
src/shared/contracts/events.ts                     [改] export * + catalog 登记
src/main/documents/data/tables/documentTasks.ts    [新] DocumentTasksTable
src/main/documents/data/tables/documents.ts        [改] buildWhere 复用 + count + statsByType
src/main/documents/data/database.ts                [改] +documentTasksTable getter
src/main/data/schemaCatalog.ts                     [改] +document_tasks 条目
src/main/documents/repository.ts                   [改] countDocuments/statsByType + 任务 CRUD
src/main/documents/taskManager.ts                  [新] RecognitionTaskManager
src/main/documents/extractor/documentExtractor.ts  [改] auto 图片无 vision → ocr 回落
src/main/documents/routes.ts                       [改] list+total、stats、tasks.create/list handler
src/main/app/composition.ts                        [改] TaskManager 注入 + resumePending
src/renderer/api/DocumentsClient.ts                [改] +createTasks/listTasks/onTaskUpdated + 类型
src/renderer/src/stores/documents.ts               [改] 页码分页 + stats + tasks 状态
src/renderer/src/pages/documents/documentArchive.ts [改] +buildDefaultDateRangeTexts
src/renderer/src/pages/documents/DocumentsArchivePage.vue [改] Tab/chips/分页/任务条/事件订阅
src/renderer/src/pages/documents/DocumentTaskStrip.vue [新] 任务进度条
src/renderer/src/pages/documents/DocumentRecognizeDialog.vue [改] 多文件 + auto 分类 + 立即返回
src/renderer/src/i18n/<20 lang>/settings.json      [改] +12 keys
test/main/documents/documentsTables.test.ts        [改] +count/stats/tasks 表测试
test/main/documents/taskManager.test.ts            [新]
test/main/documents/documentsRoutes.test.ts        [改] +契约/handler 测试
test/renderer/api/documentsClient.test.ts          [改]
test/renderer/stores/documentsArchiveStore.test.ts [改] 分页/stats/任务事件
test/renderer/pages/documents/DocumentsArchivePage.test.ts [改] Tab/chips/分页/任务条
test/renderer/pages/documents/DocumentRecognizeDialog.test.ts [改]
```

---

### Task 1: 契约扩展（list total + stats + tasks + 事件）

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`
- Modify: `src/shared/contracts/routes.ts`（import 块约 L381-392 + catalog 约 L810）
- Create: `src/shared/contracts/events/documents.events.ts`
- Modify: `src/shared/contracts/events.ts`（export 块 + catalog）
- Test: `test/main/documents/documentsRoutes.test.ts`

- [ ] **Step 1: 写失败测试（契约 parse）**

在 `test/main/documents/documentsRoutes.test.ts` 的 `describe('documents route contracts', ...)` 内追加（import 块加入 `documentsStatsRoute, documentsTasksCreateRoute, documentsTasksListRoute`）：

```ts
  it('documents.list output requires total', () => {
    expect(() => documentsListRoute.output.parse({ documents: [] })).toThrow()
    const output = documentsListRoute.output.parse({ documents: [], total: 0 })
    expect(output.total).toBe(0)
  })

  it('documents.stats parses per-type counters', () => {
    const output = documentsStatsRoute.output.parse({
      stats: [{ typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }]
    })
    expect(output.stats[0]?.draft).toBe(2)
  })

  it('documents.tasks.create accepts files and auto template', () => {
    const input = documentsTasksCreateRoute.input.parse({
      files: [{ path: 'C:\\a.png' }, { path: 'C:\\b.pdf' }],
      templateId: 'auto'
    })
    expect(input.files).toHaveLength(2)
    expect(input.source).toBe('manual')
    expect(() =>
      documentsTasksCreateRoute.input.parse({
        files: [{ path: 'C:\\a.png' }],
        templateId: 'auto'
      } as never).files
    ).toBeDefined()
    // 上限 20
    expect(() =>
      documentsTasksCreateRoute.input.parse({
        files: Array.from({ length: 21 }, (_, i) => ({ path: `C:\\f${i}.png` })),
        templateId: 'auto'
      })
    ).toThrow()
  })

  it('documents.tasks.create/list output parses task rows', () => {
    const task = {
      id: 't1',
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto',
      status: 'pending',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1
    }
    expect(documentsTasksCreateRoute.output.parse({ tasks: [task] }).tasks).toHaveLength(1)
    expect(documentsTasksListRoute.output.parse({ tasks: [] }).tasks).toEqual([])
  })

  it('documents.task.updated event payload parses', async () => {
    const { documentsTaskUpdatedEvent } = await import('@shared/contracts/events')
    const payload = {
      id: 't1',
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto',
      status: 'running',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      doneCount: 0,
      totalCount: 1,
      version: 1
    }
    expect(documentsTaskUpdatedEvent.payload.parse(payload)).toMatchObject({ status: 'running' })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: FAIL — `documentsStatsRoute` 未导出 / parse 抛错

- [ ] **Step 3: 实现 routes 契约**

`src/shared/contracts/routes/documents.routes.ts` 追加（放在 documentsListRoute 附近）：

```ts
export const documentsStatsEntrySchema = z.object({
  typeKey: z.string().min(1),
  total: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative()
})

export const documentsStatsRoute = defineRouteContract({
  name: 'documents.stats',
  input: z.object({
    dateFrom: timestampMsSchema.optional(),
    dateTo: timestampMsSchema.optional()
  }),
  output: z.object({ stats: z.array(documentsStatsEntrySchema) })
})

export const documentTaskStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])

export const documentTaskSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  filePath: z.string().min(1),
  fileName: z.string().min(1),
  templateId: z.string().min(1),
  status: documentTaskStatusSchema,
  typeKey: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  error: z.string().nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const documentsTasksCreateRoute = defineRouteContract({
  name: 'documents.tasks.create',
  input: z.object({
    files: z.array(documentExtractFileSchema).min(1).max(20),
    templateId: z.string().min(1),
    source: documentSourceSchema.default('manual')
  }),
  output: z.object({ tasks: z.array(documentTaskSchema) })
})

export const documentsTasksListRoute = defineRouteContract({
  name: 'documents.tasks.list',
  input: z.object({}),
  output: z.object({ tasks: z.array(documentTaskSchema) })
})
```

并把 `documentsListRoute.output` 改为：

```ts
export const documentsListRoute = defineRouteContract({
  name: 'documents.list',
  input: documentsListInputSchema,
  output: z.object({
    documents: z.array(documentRecordSchema),
    total: z.number().int().nonnegative()
  })
})
```

- [ ] **Step 4: barrel 登记 + 事件契约**

`src/shared/contracts/routes.ts`：import 块加入 `documentsStatsRoute, documentsTasksCreateRoute, documentsTasksListRoute`；catalog 加三行：

```ts
  [documentsStatsRoute.name]: documentsStatsRoute,
  [documentsTasksCreateRoute.name]: documentsTasksCreateRoute,
  [documentsTasksListRoute.name]: documentsTasksListRoute,
```

新建 `src/shared/contracts/events/documents.events.ts`：

```ts
import { TimestampMsSchema, defineEventContract } from '../common'
import { documentTaskSchema } from '../routes/documents.routes'

export const documentsTaskUpdatedEvent = defineEventContract({
  name: 'documents.task.updated',
  payload: documentTaskSchema.extend({
    doneCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    version: TimestampMsSchema
  })
})
```

注意：common.ts 若未导出 `z`，在事件文件顶部 `import { z } from 'zod'`（以现有 events 文件写法为准，如 knowledge.events.ts 无 z 引用则该文件同样需要显式 import z）。

`src/shared/contracts/events.ts`：import 块加：

```ts
import { documentsTaskUpdatedEvent } from './events/documents.events'
```

`export *` 区加一行（按字母序插入）：`export * from './events/documents.events'`；catalog 加：

```ts
  [documentsTaskUpdatedEvent.name]: documentsTaskUpdatedEvent,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: PASS（原有用例若因 list output 变化需补 `total: N`，同步修正 fixture）

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes.ts src/shared/contracts/events/documents.events.ts src/shared/contracts/events.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): stats and batch task contracts"
```

---

### Task 2: sqlite — document_tasks 表 + count/stats 查询

**Files:**
- Create: `src/main/documents/data/tables/documentTasks.ts`
- Modify: `src/main/documents/data/tables/documents.ts`
- Modify: `src/main/documents/data/database.ts`
- Modify: `src/main/data/schemaCatalog.ts`
- Modify: `src/main/documents/repository.ts`
- Test: `test/main/documents/documentsTables.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/main/documents/documentsTables.test.ts` 追加（沿用该文件现有 sqlite 探测与建表 fixture 风格；新表用 `DocumentTasksTable`）：

```ts
describe('documentsTable count and stats', () => {
  it('counts rows matching the list filter', () => {
    const table = new DocumentsTable(db)
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'draft' }))
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'confirmed' }))
    table.insert(makeDocInput({ typeKey: 'contract', status: 'draft' }))
    expect(table.count({})).toBe(3)
    expect(table.count({ typeKey: 'invoice_special' })).toBe(2)
    expect(table.count({ status: 'draft', typeKey: 'contract' })).toBe(1)
  })

  it('groups stats by type_key and status', () => {
    const table = new DocumentsTable(db)
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'draft' }))
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'confirmed' }))
    const rows = table.statsByType({})
    expect(rows).toEqual([
      { type_key: 'invoice_special', status: 'draft', count: 1 },
      { type_key: 'invoice_special', status: 'confirmed', count: 1 }
    ])
  })
})

describe('documentTasksTable', () => {
  it('inserts pending tasks and updates lifecycle', () => {
    const table = new DocumentTasksTable(db)
    const task = table.insert({ batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' })
    expect(task.status).toBe('pending')
    expect(task.source).toBe('manual')
    const running = table.update(task.id, { status: 'running' })
    expect(running?.status).toBe('running')
    const done = table.update(task.id, { status: 'done', typeKey: 'invoice_special', documentId: 'd1' })
    expect(done?.documentId).toBe('d1')
    const failed = table.update(task.id, { status: 'failed', error: 'boom' })
    expect(failed?.error).toBe('boom')
  })

  it('lists pending in order and marks running as failed', () => {
    const table = new DocumentTasksTable(db)
    const a = table.insert({ batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' })
    const b = table.insert({ batchId: 'b1', filePath: 'C:\\b.png', fileName: 'b.png', templateId: 'auto', now: 2 })
    const c = table.insert({ batchId: 'b2', filePath: 'C:\\c.png', fileName: 'c.png', templateId: 'auto', now: 3 })
    table.update(b.id, { status: 'running' })
    table.update(c.id, { status: 'done', documentId: 'd9' })
    expect(table.listPending().map((t) => t.id)).toEqual([a.id])
    table.markRunningAsFailed('interrupted by app restart')
    expect(table.get(b.id)?.status).toBe('failed')
    expect(table.get(b.id)?.error).toBe('interrupted by app restart')
    expect(table.get(c.id)?.status).toBe('done')
  })

  it('counts batch progress', () => {
    const table = new DocumentTasksTable(db)
    const a = table.insert({ batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' })
    const b = table.insert({ batchId: 'b1', filePath: 'C:\\b.png', fileName: 'b.png', templateId: 'auto' })
    table.update(a.id, { status: 'done', documentId: 'd1' })
    table.update(b.id, { status: 'failed', error: 'x' })
    expect(table.countBatch('b1')).toEqual({ done: 2, total: 2 })
  })
})
```

注意：fixture `makeDocInput`/`db` 以该文件现状为准对齐（若现有用例直接 `new DocumentsTable(db)` 则照抄）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts --config vitest.config.ts`
Expected: FAIL — count/statsByType/DocumentTasksTable 不存在

- [ ] **Step 3: 实现 documents 表 count/statsByType**

`src/main/documents/data/tables/documents.ts`：把 `list` 内的条件拼接抽出为私有方法，list 复用；新增 `count`、`statsByType`：

```ts
  private buildWhere(filter: DocumentListFilter): { where: string; params: unknown[] } {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.typeKey) {
      conditions.push('type_key = ?')
      params.push(filter.typeKey)
    }
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.keyword) {
      conditions.push("fields_json LIKE ? ESCAPE '\\'")
      params.push(`%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    if (filter.dateFrom !== undefined) {
      conditions.push('created_at >= ?')
      params.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      conditions.push('created_at <= ?')
      params.push(filter.dateTo)
    }
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
  }

  count(filter: DocumentListFilter): number {
    const { where, params } = this.buildWhere(filter)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM documents ${where}`)
      .get(...params) as { count: number }
    return row.count
  }

  statsByType(filter: Pick<DocumentListFilter, 'dateFrom' | 'dateTo'>): Array<{
    type_key: string
    status: string
    count: number
  }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.dateFrom !== undefined) {
      conditions.push('created_at >= ?')
      params.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      conditions.push('created_at <= ?')
      params.push(filter.dateTo)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return this.db
      .prepare(
        `SELECT type_key, status, COUNT(*) AS count FROM documents ${where} GROUP BY type_key, status`
      )
      .all(...params) as Array<{ type_key: string; status: string; count: number }>
  }
```

`list` 改为使用 `const { where, params } = this.buildWhere(filter)`（查询体不变）。

- [ ] **Step 4: 实现 DocumentTasksTable**

新建 `src/main/documents/data/tables/documentTasks.ts`：

```ts
import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface DocumentTaskRow {
  id: string
  batch_id: string
  file_path: string
  file_name: string
  template_id: string
  source: string
  status: string
  type_key: string | null
  document_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface DocumentTaskInsertInput {
  batchId: string
  filePath: string
  fileName: string
  templateId: string
  source?: 'chat' | 'manual'
  now?: number
}

export interface DocumentTaskUpdateInput {
  status: 'pending' | 'running' | 'done' | 'failed'
  typeKey?: string | null
  documentId?: string | null
  error?: string | null
  now?: number
}

export class DocumentTasksTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'document_tasks')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS document_tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('chat', 'manual')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
        type_key TEXT,
        document_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_tasks_status
        ON document_tasks(status, created_at DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): DocumentTaskRow | undefined {
    return this.db.prepare('SELECT * FROM document_tasks WHERE id = ?').get(id) as
      | DocumentTaskRow
      | undefined
  }

  insert(input: DocumentTaskInsertInput): DocumentTaskRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO document_tasks
           (id, batch_id, file_path, file_name, template_id, source, status, type_key, document_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
      )
      .run(id, input.batchId, input.filePath, input.fileName, input.templateId, input.source ?? 'manual', now, now)
    return this.get(id)!
  }

  update(id: string, input: DocumentTaskUpdateInput): DocumentTaskRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE document_tasks
         SET status = ?, type_key = ?, document_id = ?, error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.typeKey !== undefined ? input.typeKey : existing.type_key,
        input.documentId !== undefined ? input.documentId : existing.document_id,
        input.error !== undefined ? input.error : existing.error,
        now,
        id
      )
    return this.get(id)
  }

  listPending(): DocumentTaskRow[] {
    return this.db
      .prepare("SELECT * FROM document_tasks WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all() as DocumentTaskRow[]
  }

  listRecent(limit = 200): DocumentTaskRow[] {
    return this.db
      .prepare('SELECT * FROM document_tasks ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as DocumentTaskRow[]
  }

  markRunningAsFailed(error: string, now?: number): void {
    this.db
      .prepare(
        "UPDATE document_tasks SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'"
      )
      .run(error, now ?? Date.now())
  }

  countBatch(batchId: string): { done: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('done', 'failed') THEN 1 ELSE 0 END) AS done
         FROM document_tasks WHERE batch_id = ?`
      )
      .get(batchId) as { total: number; done: number | null }
    return { done: row.done ?? 0, total: row.total }
  }
}
```

- [ ] **Step 5: database getter + schemaCatalog + repository**

`src/main/documents/data/database.ts` 加：

```ts
import { DocumentTasksTable } from './tables/documentTasks'
// ...
  get documentTasksTable(): DocumentTasksTable {
    return new DocumentTasksTable(this.getDatabase())
  }
```

`src/main/data/schemaCatalog.ts`：import `DocumentTasksTable`，CATALOG_DEFINITIONS 末尾（documents 条目后）加：

```ts
  {
    name: 'document_tasks',
    createTable: (db) => new DocumentTasksTable(db)
  }
```

`src/main/documents/repository.ts`：加任务类型与 mapper + 方法（import `DocumentTaskRow` 等）：

```ts
export type DocumentTaskStatus = 'pending' | 'running' | 'done' | 'failed'

export interface DocumentTask {
  id: string
  batchId: string
  filePath: string
  fileName: string
  templateId: string
  source: 'chat' | 'manual'
  status: DocumentTaskStatus
  typeKey: string | null
  documentId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

const toTask = (row: DocumentTaskRow): DocumentTask => ({
  id: row.id,
  batchId: row.batch_id,
  filePath: row.file_path,
  fileName: row.file_name,
  templateId: row.template_id,
  source: row.source as DocumentTask['source'],
  status: row.status as DocumentTaskStatus,
  typeKey: row.type_key,
  documentId: row.document_id,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})
```

类内追加：

```ts
  countDocuments(filter: {
    typeKey?: string
    status?: 'draft' | 'confirmed'
    keyword?: string
    dateFrom?: number
    dateTo?: number
  }): number {
    return this.database.documentsTable.count(filter)
  }

  statsByType(filter: { dateFrom?: number; dateTo?: number }): Array<{
    typeKey: string
    total: number
    draft: number
    confirmed: number
  }> {
    const rows = this.database.documentsTable.statsByType(filter)
    const map = new Map<string, { typeKey: string; total: number; draft: number; confirmed: number }>()
    for (const row of rows) {
      const entry = map.get(row.type_key) ?? { typeKey: row.type_key, total: 0, draft: 0, confirmed: 0 }
      entry.total += row.count
      if (row.status === 'draft') entry.draft += row.count
      if (row.status === 'confirmed') entry.confirmed += row.count
      map.set(row.type_key, entry)
    }
    return [...map.values()]
  }

  insertTasks(
    inputs: Array<{ batchId: string; filePath: string; fileName: string; templateId: string; source?: 'chat' | 'manual' }>
  ): DocumentTask[] {
    return inputs.map((input) => toTask(this.database.documentTasksTable.insert(input)))
  }

  updateTask(
    id: string,
    input: { status: DocumentTaskStatus; typeKey?: string | null; documentId?: string | null; error?: string | null }
  ): DocumentTask | null {
    const row = this.database.documentTasksTable.update(id, input)
    return row ? toTask(row) : null
  }

  listRecentTasks(limit?: number): DocumentTask[] {
    return this.database.documentTasksTable.listRecent(limit).map(toTask)
  }

  listPendingTasks(): DocumentTask[] {
    return this.database.documentTasksTable.listPending().map(toTask)
  }

  markRunningTasksFailed(error: string): void {
    this.database.documentTasksTable.markRunningAsFailed(error)
  }

  countTaskBatch(batchId: string): { done: number; total: number } {
    return this.database.documentTasksTable.countBatch(batchId)
  }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/documentsTables.test.ts test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/documents/data/tables/documentTasks.ts src/main/documents/data/tables/documents.ts src/main/documents/data/database.ts src/main/data/schemaCatalog.ts src/main/documents/repository.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): task table and stats queries"
```

---

### Task 3: extractor — 图片 auto 无 vision 模型时回落 OCR

**Files:**
- Modify: `src/main/documents/extractor/documentExtractor.ts:262-286`
- Test: `test/main/documents/extractorService.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/main/documents/extractorService.test.ts` 追加（沿用该文件 fake deps 构造方式；核心断言：resolveVisionTarget 返回 null 时图片 auto 走 ocr 路由而非抛错）：

```ts
  it('falls back to ocr route for images when no vision model is configured', async () => {
    const calls: string[] = []
    const extractor = new DocumentExtractor({
      ...baseDeps,
      resolveVisionTarget: async () => null,
      resolveTextTarget: async () => ({ providerId: 'p', modelId: 'm' }),
      extractOcrText: async () => 'OCR TEXT',
      generateCompletion: async (input) => {
        calls.push(input.messages.map((m) => m.role).join(','))
        return '{"fields":{}}'
      }
    })
    const result = await extractor.extract({ templateId: 'tpl1', file: { path: 'a.png' } })
    expect(result.route).toBe('ocr')
    expect(result.fields).toBeDefined()
  })
```

（`baseDeps` 为该文件已有的最小依赖集合；若现有测试直接内联全部 deps，则按其风格内联。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts --config vitest.config.ts`
Expected: FAIL — 抛 `No model available for extraction: configure "defaultVisionModel"...`

- [ ] **Step 3: 实现**

`buildRoutePlan` 改为 async 并感知 vision 可用性；`extract()` 内调用处加 `await`：

```ts
  private async buildRoutePlan(
    template: DocumentTemplate,
    file: DocumentExtractFileInput,
    pdfText: { text: string; hasTextLayer: boolean } | null
  ): Promise<{ route: DocumentExtractRoute; text?: string }> {
    const mode = template.extractionMode
    if (isImageFile(file)) {
      if (mode === 'text') {
        return { route: 'ocr' }
      }
      if (mode === 'auto') {
        // Prefer the multimodal model (fast, accurate); fall back to local OCR
        // + text model only when no vision model is configured.
        const visionAvailable = (await this.deps.resolveVisionTarget()) !== null
        return visionAvailable ? { route: 'vision' } : { route: 'ocr' }
      }
      return { route: 'vision' }
    }
    if (isPdfFile(file)) {
      if (mode === 'vision') {
        throw new Error(
          'extractionMode=vision only supports image files; use auto or text mode for PDFs'
        )
      }
      if (pdfText?.hasTextLayer) {
        return { route: 'text', text: pdfText.text }
      }
      return { route: 'ocr' }
    }
    throw new Error(`unsupported file type for extraction: ${file.mimeType ?? file.path}`)
  }
```

`extract()` 中：`const plan = await this.buildRoutePlan(template, input.file, pdfText)`。vision 分支的 `requireTarget` 保留（mode='vision' 显式指定而未配置时报错语义不变）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts --config vitest.config.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/documentExtractor.ts test/main/documents/extractorService.test.ts
git commit -m "feat(documents): ocr fallback when vision missing"
```

---

### Task 4: RecognitionTaskManager（异步任务泵）

**Files:**
- Create: `src/main/documents/taskManager.ts`
- Test: `test/main/documents/taskManager.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `test/main/documents/taskManager.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecognitionTaskManager } from '@/documents/taskManager'
import type { DocumentTask } from '@/documents/repository'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

function makeTask(overrides: Partial<DocumentTask> = {}): DocumentTask {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    batchId: 'b1',
    filePath: 'C:\\a.png',
    fileName: 'a.png',
    templateId: 'auto',
    source: 'manual',
    status: 'pending',
    typeKey: null,
    documentId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeDeps(overrides: Partial<Parameters<typeof RecognitionTaskManager.prototype['submit']>[0]> = {}) {
  return overrides
}

describe('RecognitionTaskManager', () => {
  it('creates tasks and returns immediately, then processes to done', async () => {
    const updates: Array<{ status: string; typeKey?: string | null; documentId?: string | null }> = []
    const published: string[] = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) =>
          inputs.map((input, i) => makeTask({ id: `t${i}`, filePath: input.filePath, fileName: input.fileName })),
        updateTask: (id, input) => {
          updates.push({ id, ...input })
          return makeTask({ id, status: input.status, typeKey: input.typeKey ?? null, documentId: input.documentId ?? null })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: (batchId) => ({ done: 0, total: batchId === 'b1' ? 1 : 0 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: {
        extract: async () => ({
          template: { id: 'tpl1', typeKey: 'invoice_special' },
          route: 'vision',
          fields: {},
          rawOutput: '',
          durationMs: 1,
          issues: []
        })
      },
      publishTaskUpdated: ({ task }) => published.push(task.status)
    })
    const tasks = manager.submit({ files: [{ path: 'C:\\a.png', name: 'a.png' }], templateId: 'auto', source: 'manual' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('pending') // 立即返回
    await manager.idle()
    expect(updates.map((u) => u.status)).toEqual(['running', 'done'])
    expect(updates[1]?.typeKey).toBe('invoice_special')
    expect(updates[1]?.documentId).toBe('doc-1')
    expect(published).toEqual(['running', 'done'])
  })

  it('marks failed tasks with the error message', async () => {
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => makeTask({ id, status: input.status, error: input.error ?? null }),
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 1, total: 1 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: { extract: async () => { throw new Error('auto classification failed') } },
      publishTaskUpdated: () => {}
    })
    manager.submit({ files: [{ path: 'C:\\a.png' }], templateId: 'auto', source: 'manual' })
    await manager.idle()
    const updated = (manager as unknown as { deps: { repository: { updateTask: unknown } } })
    void updated
  })
})
```

注意：上面第二个用例补一个断言细节——让 `updateTask` 记录进数组并断言 `error === 'auto classification failed'`（与第一个用例相同的收集方式，写成完整代码）：

```ts
  it('marks failed tasks with the error message', async () => {
    const updates: Array<{ status: string; error?: string | null }> = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => {
          updates.push({ status: input.status, error: input.error ?? null })
          return makeTask({ id, status: input.status, error: input.error ?? null })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 1, total: 1 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: {
        extract: async () => {
          throw new Error('auto classification failed')
        }
      },
      publishTaskUpdated: () => {}
    })
    manager.submit({ files: [{ path: 'C:\\a.png' }], templateId: 'auto', source: 'manual' })
    await manager.idle()
    expect(updates.map((u) => u.status)).toEqual(['running', 'failed'])
    expect(updates[1]?.error).toBe('auto classification failed')
  })

  it('processes with bounded concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 4 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {},
      concurrency: 2
    })
    manager.submit({
      files: [{ path: 'C:\\1' }, { path: 'C:\\2' }, { path: 'C:\\3' }, { path: 'C:\\4' }],
      templateId: 'auto',
      source: 'manual'
    })
    await manager.idle()
    expect(maxInFlight).toBe(2)
  })

  it('resumePending fails running tasks and re-queues pending ones', async () => {
    const stored = [
      makeTask({ id: 'running-1', status: 'running' }),
      makeTask({ id: 'pending-1', status: 'pending' })
    ]
    let markedFailed = false
    const processed: string[] = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: () => [],
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => stored.filter((t) => t.status === 'pending'),
        markRunningTasksFailed: () => {
          markedFailed = true
        },
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async (input) => {
          processed.push(input.templateId)
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {}
    })
    await manager.resumePending()
    await manager.idle()
    expect(markedFailed).toBe(true)
    expect(processed).toEqual(['pending-1' as never].slice(0, 0).concat(['auto']))
  })
```

（最后一个断言以 `processed` 包含 `'auto'` 为准：`expect(processed).toEqual(['auto'])`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/taskManager.test.ts --config vitest.config.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 taskManager.ts**

新建 `src/main/documents/taskManager.ts`：

```ts
import { randomUUID } from 'node:crypto'
import type { DocumentExtractor, DocumentExtractFileInput } from './extractor/documentExtractor'
import type { DocumentRepositoryTaskPort, DocumentTask } from './repository'

export interface RecognitionTaskSubmitInput {
  files: DocumentExtractFileInput[]
  templateId: string
  source: 'chat' | 'manual'
}

export interface TaskPublishedPayload {
  task: DocumentTask
  doneCount: number
  totalCount: number
}

export interface RecognitionTaskManagerDeps {
  repository: DocumentRepositoryTaskPort
  extractor: Pick<DocumentExtractor, 'extract'>
  publishTaskUpdated: (payload: TaskPublishedPayload) => void
  concurrency?: number
  now?: () => number
}

const DEFAULT_CONCURRENCY = 2

export class RecognitionTaskManager {
  private readonly concurrency: number
  private readonly queue: DocumentTask[] = []
  private running = 0

  constructor(private readonly deps: RecognitionTaskManagerDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY)
  }

  submit(input: RecognitionTaskSubmitInput): DocumentTask[] {
    const now = this.deps.now?.() ?? Date.now()
    void now
    const tasks = this.deps.repository.insertTasks(
      input.files.map((file) => ({
        batchId: randomUUID(),
        filePath: file.path,
        fileName: file.name ?? file.path.split(/[\\/]/).pop() ?? file.path,
        templateId: input.templateId,
        source: input.source
      }))
    )
    this.queue.push(...tasks)
    this.pump()
    return tasks
  }

  async resumePending(): Promise<void> {
    this.deps.repository.markRunningTasksFailed('interrupted by app restart')
    this.queue.push(...this.deps.repository.listPendingTasks())
    this.pump()
  }

  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) {
        return
      }
      this.running += 1
      void this.runTask(task).finally(() => {
        this.running -= 1
        this.pump()
      })
    }
  }

  private async runTask(started: DocumentTask): Promise<void> {
    const runningTask = this.deps.repository.updateTask(started.id, { status: 'running' }) ?? started
    this.publish(runningTask)
    try {
      const result = await this.deps.extractor.extract({
        templateId: runningTask.templateId,
        file: { path: runningTask.filePath, name: runningTask.fileName }
      })
      const document = this.deps.repository.insertDocument({
        templateId: result.template.id,
        typeKey: result.template.typeKey,
        templateSnapshot: result.template,
        fields: result.fields,
        fileUris: [runningTask.filePath],
        source: runningTask.source,
        sessionId: null,
        status: 'draft',
        now: this.deps.now?.()
      })
      this.publish(
        this.deps.repository.updateTask(runningTask.id, {
          status: 'done',
          typeKey: result.template.typeKey,
          documentId: document.id
        }) ?? runningTask
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish(
        this.deps.repository.updateTask(runningTask.id, { status: 'failed', error: message }) ??
          runningTask
      )
    }
  }

  private publish(task: DocumentTask): void {
    const counts = this.deps.repository.countTaskBatch(task.batchId)
    this.deps.publishTaskUpdated({ task, doneCount: counts.done, totalCount: counts.total })
  }
}
```

`src/main/documents/repository.ts` 导出任务端口类型（供 taskManager 依赖注入用，避免依赖完整 Repository 类）：

```ts
export interface DocumentRepositoryTaskPort {
  insertTasks(inputs: Array<{
    batchId: string
    filePath: string
    fileName: string
    templateId: string
    source?: 'chat' | 'manual'
  }>): DocumentTask[]
  updateTask(id: string, input: {
    status: DocumentTaskStatus
    typeKey?: string | null
    documentId?: string | null
    error?: string | null
  }): DocumentTask | null
  listRecentTasks(limit?: number): DocumentTask[]
  listPendingTasks(): DocumentTask[]
  markRunningTasksFailed(error: string): void
  countTaskBatch(batchId: string): { done: number; total: number }
  insertDocument(input: {
    templateId: string
    typeKey: string
    templateSnapshot: unknown
    fields: Record<string, { value: unknown; uncertain: boolean }>
    fileUris: string[]
    source: 'chat' | 'manual'
    sessionId: string | null
    status: 'draft' | 'confirmed'
    now?: number
  }): { id: string }
}
```

（`DocumentsRepository` 结构上满足该端口，无需显式 implements；若 typecheck 报签名差异，以 repository 实际签名为准微调端口定义。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/main/documents/taskManager.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/taskManager.ts src/main/documents/repository.ts test/main/documents/taskManager.test.ts
git commit -m "feat(documents): recognition task manager"
```

---

### Task 5: main 路由接线 + composition 注入

**Files:**
- Modify: `src/main/documents/routes.ts`
- Modify: `src/main/app/composition.ts:2870-2933`
- Test: `test/main/documents/documentsRoutes.test.ts`

- [ ] **Step 1: 写失败测试（route handler）**

在 `test/main/documents/documentsRoutes.test.ts` 现有 `describeIfSqlite` 的 routes 行为测试区追加（沿用其 fixture；taskManager 用 fake）：

```ts
  it('documents.list returns total from repository', async () => {
    const { repository, cleanup } = makeRepository()
    try {
      repository.insertDocument(validInsertInput)
      const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
      const handler = getRouteHandler(routes, documentsListRoute.name)
      const output = documentsListRoute.output.parse(await handler({ limit: 10 }))
      expect(output.total).toBe(1)
      expect(output.documents).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('documents.stats returns per-type counters', async () => {
    const { repository, cleanup } = makeRepository()
    try {
      repository.insertDocument(validInsertInput)
      const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
      const handler = getRouteHandler(routes, documentsStatsRoute.name)
      const output = documentsStatsRoute.output.parse(await handler({}))
      expect(output.stats).toEqual([
        { typeKey: validInsertInput.typeKey, total: 1, draft: 1, confirmed: 0 }
      ])
    } finally {
      cleanup()
    }
  })

  it('documents.tasks.create submits to task manager and returns tasks', async () => {
    const { repository, cleanup } = makeRepository()
    try {
      const submit = vi.fn().mockReturnValue([{ id: 't1' }])
      const taskManager = { submit, resumePending: vi.fn() }
      const routes = createDocumentsRoutes(repository, fakeExtractor, taskManager)
      const handler = getRouteHandler(routes, documentsTasksCreateRoute.name)
      const output = documentsTasksCreateRoute.output.parse(
        await handler({ files: [{ path: 'C:\\a.png' }], templateId: 'auto' })
      )
      expect(output.tasks).toEqual([{ id: 't1' }])
      expect(submit).toHaveBeenCalledWith({
        files: [{ path: 'C:\\a.png' }],
        templateId: 'auto',
        source: 'manual'
      })
    } finally {
      cleanup()
    }
  })

  it('documents.tasks.list returns recent tasks from repository', async () => {
    const { repository, cleanup } = makeRepository()
    try {
      repository.insertTasks([{ batchId: 'b1', filePath: 'C:\\a.png', fileName: 'a.png', templateId: 'auto' }])
      const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
      const handler = getRouteHandler(routes, documentsTasksListRoute.name)
      const output = documentsTasksListRoute.output.parse(await handler({}))
      expect(output.tasks).toHaveLength(1)
      expect(output.tasks[0]).toMatchObject({ filePath: 'C:\\a.png', status: 'pending' })
    } finally {
      cleanup()
    }
  })
```

`fakeExtractor`/`fakeTaskManager`/`getRouteHandler` 若文件里没有，按该文件现状补最小 helper：

```ts
const fakeExtractor = { extract: vi.fn() }
const fakeTaskManager = { submit: vi.fn(), resumePending: vi.fn() }

function getRouteHandler(routes: DeepchatRouteMap, name: string): (input: unknown) => Promise<unknown> {
  const handler = routes[name]
  if (!handler) {
    throw new Error(`missing route: ${name}`)
  }
  return handler as (input: unknown) => Promise<unknown>
}
```

（`validInsertInput` 沿用该文件既有 insertDocument fixture；`DeepchatRouteMap` 从 `@/routes/routeRegistry` import；若现有测试用别的取 handler 方式，以现状为准。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
Expected: FAIL — createDocumentsRoutes 参数数量不匹配 / 缺路由

- [ ] **Step 3: 实现 routes handler**

`src/main/documents/routes.ts`：签名改为

```ts
export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor,
  taskManager: RecognitionTaskManager,
  csvDeps: DocumentsCsvRouteDeps = defaultCsvDeps
): DeepchatRouteMap
```

import `documentsStatsRoute, documentsTasksCreateRoute, documentsTasksListRoute` 与 `type { RecognitionTaskManager } from './taskManager'`。catalog 块内追加三个 handler：

```ts
    [
      documentsStatsRoute.name,
      async (rawInput) => {
        const input = documentsStatsRoute.input.parse(rawInput)
        return documentsStatsRoute.output.parse({ stats: repository.statsByType(input) })
      }
    ],
    [
      documentsTasksCreateRoute.name,
      async (rawInput) => {
        const input = documentsTasksCreateRoute.input.parse(rawInput)
        const tasks = taskManager.submit({
          files: input.files,
          templateId: input.templateId,
          source: input.source
        })
        return documentsTasksCreateRoute.output.parse({ tasks })
      }
    ],
    [
      documentsTasksListRoute.name,
      async (rawInput) => {
        documentsTasksListRoute.input.parse(rawInput)
        return documentsTasksListRoute.output.parse({ tasks: repository.listRecentTasks() })
      }
    ]
```

`documentsListRoute` handler 改为：

```ts
    [
      documentsListRoute.name,
      async (rawInput) => {
        const input = documentsListRoute.input.parse(rawInput)
        return documentsListRoute.output.parse({
          documents: repository.listDocuments(input),
          total: repository.countDocuments(input)
        })
      }
    ],
```

- [ ] **Step 4: composition 注入**

`src/main/app/composition.ts`（在 `const documentsRoutes = createDocumentsRoutes(...)` 处，约 L2933）：

```ts
    const recognitionTaskManager = new RecognitionTaskManager({
      repository: documentsRepository,
      extractor: documentExtractor,
      publishTaskUpdated: ({ task, doneCount, totalCount }) =>
        publishDeepchatEvent('documents.task.updated', {
          ...task,
          doneCount,
          totalCount,
          version: Date.now()
        })
    })
    const documentsRoutes = createDocumentsRoutes(
      documentsRepository,
      documentExtractor,
      recognitionTaskManager
    )
    // Resume interrupted recognition tasks from the previous run.
    void recognitionTaskManager.resumePending()
```

顶部 import：`import { RecognitionTaskManager } from '@/documents/taskManager'`（与 L192 的 routes import 相邻）。

- [ ] **Step 5: 运行测试 + typecheck**

Run: `pnpm exec vitest run test/main/documents --config vitest.config.ts`
Expected: PASS（documents 套件全绿）
Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/routes.ts src/main/app/composition.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): batch task routes and wiring"
```

---

### Task 6: renderer — DocumentsClient + store（分页/统计/任务）

**Files:**
- Modify: `src/renderer/api/DocumentsClient.ts`
- Modify: `src/renderer/src/stores/documents.ts`
- Modify: `src/renderer/src/pages/documents/documentArchive.ts`
- Test: `test/renderer/api/documentsClient.test.ts`、`test/renderer/stores/documentsArchiveStore.test.ts`、`test/renderer/pages/documents/documentArchive.test.ts`

- [ ] **Step 1: 写失败测试**

`test/renderer/api/documentsClient.test.ts` 追加（沿用该文件 bridge mock 模式）：

```ts
  it('invokes tasks.create / tasks.list / stats routes', async () => {
    const invoke = vi.fn().mockResolvedValue({ tasks: [], stats: [] })
    const client = createDocumentsClient({ invoke } as never)
    await client.createTasks({ files: [{ path: 'C:\\a.png' }], templateId: 'auto' })
    expect(invoke).toHaveBeenCalledWith('documents.tasks.create', {
      files: [{ path: 'C:\\a.png' }],
      templateId: 'auto'
    })
    await client.listTasks()
    expect(invoke).toHaveBeenLastCalledWith('documents.tasks.list', {})
    await client.stats({ dateFrom: 1 })
    expect(invoke).toHaveBeenLastCalledWith('documents.stats', { dateFrom: 1 })
  })

  it('subscribes to documents.task.updated and returns unsubscribe', () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const client = createDocumentsClient({ on } as never)
    const listener = vi.fn()
    const stop = client.onTaskUpdated(listener)
    expect(on).toHaveBeenCalledWith('documents.task.updated', listener)
    stop()
    expect(off).toHaveBeenCalled()
  })
```

`test/renderer/stores/documentsArchiveStore.test.ts`（按该文件现状的 client mock 方式）追加：

```ts
  it('loadArchivePage keeps page and total', async () => {
    clientMock.listDocuments.mockResolvedValue({ documents: [makeRecord()], total: 51 })
    const store = useDocumentsStore()
    await store.loadArchivePage(2)
    expect(clientMock.listDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50, offset: 50 })
    )
    expect(store.archivePage).toBe(2)
    expect(store.archiveTotal).toBe(51)
  })

  it('loadArchiveStats fetches per-type counters with current date filter', async () => {
    clientMock.stats.mockResolvedValue({
      stats: [{ typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }]
    })
    const store = useDocumentsStore()
    store.archiveFilter.dateFrom = 100
    await store.loadArchiveStats()
    expect(clientMock.stats).toHaveBeenCalledWith({ dateFrom: 100, dateTo: undefined })
    expect(store.archiveStats).toEqual([
      { typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }
    ])
  })

  it('handleTaskUpdated upserts task and refreshes stats + current page on finish', async () => {
    clientMock.listTasks.mockResolvedValue({ tasks: [] })
    clientMock.stats.mockResolvedValue({ stats: [] })
    clientMock.listDocuments.mockResolvedValue({ documents: [], total: 0 })
    const store = useDocumentsStore()
    await store.loadArchiveTasks()
    const payload = {
      id: 't1',
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto',
      status: 'running' as const,
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      doneCount: 0,
      totalCount: 1,
      version: 1
    }
    store.handleTaskUpdated(payload)
    expect(store.tasks).toHaveLength(1)
    clientMock.listDocuments.mockClear()
    clientMock.stats.mockClear()
    store.handleTaskUpdated({ ...payload, status: 'done', typeKey: 'invoice_special', documentId: 'd1' })
    expect(store.tasks[0]?.status).toBe('done')
    expect(clientMock.stats).toHaveBeenCalled()
    expect(clientMock.listDocuments).toHaveBeenCalled()
  })
```

`test/renderer/pages/documents/documentArchive.test.ts` 追加：

```ts
  it('builds default last-week date range texts', () => {
    const { from, to } = buildDefaultDateRangeTexts(new Date('2026-09-23T10:00:00'))
    expect(from).toBe('2026-09-16')
    expect(to).toBe('2026-09-23')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts test/renderer/stores/documentsArchiveStore.test.ts test/renderer/pages/documents/documentArchive.test.ts --config vitest.config.renderer.ts`
Expected: FAIL — 方法/导出不存在

- [ ] **Step 3: 实现 DocumentsClient**

import 块加 `documentsStatsRoute, documentsTasksCreateRoute, documentsTasksListRoute` 与事件：

```ts
import { documentsTaskUpdatedEvent } from '@shared/contracts/events'
import type { z } from 'zod' // 若已有则复用
```

类体内加：

```ts
    stats: (input: z.input<typeof documentsStatsRoute.input> = {}) =>
      invokeRoute(bridge, documentsStatsRoute.name, input),
    createTasks: (input: z.input<typeof documentsTasksCreateRoute.input>) =>
      invokeRoute(bridge, documentsTasksCreateRoute.name, input),
    listTasks: () => invokeRoute(bridge, documentsTasksListRoute.name, {}),
    onTaskUpdated: (listener: (payload: z.infer<typeof documentsTaskUpdatedEvent.payload>) => void) =>
      bridge.on(documentsTaskUpdatedEvent.name, listener)
```

（`documentsTaskUpdatedEvent` 为值导入；返回类型为 bridge 的退订函数。）

- [ ] **Step 4: 实现 store 扩展**

`src/renderer/src/stores/documents.ts`：删除 `ARCHIVE_PAGE_SIZE=50` 的 load-more 语义（`archiveHasMore`），替换为页码分页 + stats + tasks。关键代码：

```ts
  const ARCHIVE_PAGE_SIZE = 50
  const archiveDocuments = ref<DocumentRecord[]>([])
  const archiveIsLoading = ref(false)
  const archiveLoadError = ref<string | null>(null)
  const archiveTotal = ref(0)
  const archivePage = ref(1)
  const archiveStats = ref<DocumentsStatsEntry[]>([])
  const tasks = ref<DocumentsTaskItem[]>([])
  const archiveFilter = reactive({
    typeKey: undefined as string | undefined,
    status: undefined as DocumentStatus | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  })
  const archiveTotalPages = computed(() =>
    Math.max(1, Math.ceil(archiveTotal.value / ARCHIVE_PAGE_SIZE))
  )

  async function loadArchiveDocuments(page = 1, client: DocumentsClient = defaultClient) {
    archiveIsLoading.value = true
    archiveLoadError.value = null
    try {
      const result = await client.listDocuments({
        ...archiveFilter,
        limit: ARCHIVE_PAGE_SIZE,
        offset: (page - 1) * ARCHIVE_PAGE_SIZE
      })
      archiveDocuments.value = result.documents as DocumentRecord[]
      archiveTotal.value = result.total
      archivePage.value = page
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveDocuments failed', error)
      archiveLoadError.value = 'settings.documents.archive.loadFailed'
    } finally {
      archiveIsLoading.value = false
    }
  }

  async function loadArchiveStats(client: DocumentsClient = defaultClient) {
    try {
      const result = await client.stats({ dateFrom: archiveFilter.dateFrom, dateTo: archiveFilter.dateTo })
      archiveStats.value = result.stats as DocumentsStatsEntry[]
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveStats failed', error)
    }
  }

  async function loadArchiveTasks(client: DocumentsClient = defaultClient) {
    try {
      const result = await client.listTasks()
      tasks.value = result.tasks as DocumentsTaskItem[]
    } catch (error) {
      console.error('[DocumentsStore] loadArchiveTasks failed', error)
    }
  }

  function handleTaskUpdated(payload: DocumentsTaskUpdatedPayload) {
    const index = tasks.value.findIndex((task) => task.id === payload.id)
    if (index >= 0) {
      tasks.value[index] = payload
    } else {
      tasks.value.unshift(payload)
    }
    if (payload.status === 'done' || payload.status === 'failed') {
      void loadArchiveStats()
      void loadArchiveDocuments(archivePage.value)
    }
  }

  async function createRecognitionTasks(
    input: { files: Array<{ path: string; name?: string }>; templateId: string },
    client: DocumentsClient = defaultClient
  ) {
    const result = await client.createTasks({ ...input, source: 'manual' })
    const created = result.tasks as DocumentsTaskItem[]
    tasks.value = [...created, ...tasks.value]
    return created
  }

  async function retryRecognitionTask(task: DocumentsTaskItem, client: DocumentsClient = defaultClient) {
    return createRecognitionTasks({ files: [{ path: task.filePath, name: task.fileName }], templateId: task.templateId }, client)
  }
```

类型别名（文件顶部 import 处）：

```ts
type DocumentsStatsEntry = { typeKey: string; total: number; draft: number; confirmed: number }
type DocumentsTaskItem = {
  id: string
  batchId: string
  filePath: string
  fileName: string
  templateId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  typeKey: string | null
  documentId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  doneCount?: number
  totalCount?: number
  version?: number
}
type DocumentsTaskUpdatedPayload = Required<DocumentsTaskItem>
```

（推荐：直接 `import type { z } from 'zod'` + `z.infer` 自契约 schema 推导，避免手写重复类型——若 render 侧可从 `@shared/contracts/routes` import type 则优先：`type DocumentsTaskItem = z.infer<typeof documentTaskSchema>`。）`replaceArchiveDocument/recognizeDocument/exportArchiveCsv/previewArchiveFile` 保持不变；return 导出对象更新：`archiveHasMore` 移除，新增 `archiveTotal, archivePage, archiveTotalPages, archiveStats, tasks, loadArchiveDocuments, loadArchiveStats, loadArchiveTasks, handleTaskUpdated, createRecognitionTasks, retryRecognitionTask`。

- [ ] **Step 5: documentArchive.ts 默认日期**

```ts
export function buildDefaultDateRangeTexts(now = new Date()): { from: string; to: string } {
  const toText = (date: Date): string =>
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-')
  return {
    from: toText(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
    to: toText(now)
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts test/renderer/stores test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: 新增 PASS；`documentsArchiveStore.test.ts`/`DocumentsArchivePage.test.ts` 中旧的 load-more 用例此时会 FAIL，属于预期——它们在 Task 7 中改造。若本步想保持全绿，可先在本任务同步删除 load-more 相关旧断言（推荐：留到 Task 7 一并改造页面测试，本任务先保证 client/store/documentArchive 三个文件绿）。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts src/renderer/src/pages/documents/documentArchive.ts test/renderer/api/documentsClient.test.ts test/renderer/stores/documentsArchiveStore.test.ts test/renderer/pages/documents/documentArchive.test.ts
git commit -m "feat(documents): archive store pagination and tasks"
```

---

### Task 7: 档案页 — Tab + 状态 chips + 默认近一周 + 分页

**Files:**
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue`
- Test: `test/renderer/pages/documents/DocumentsArchivePage.test.ts`

- [ ] **Step 1: 改造页面测试（先失败）**

`DocumentsArchivePage.test.ts`：
- stubStore 增加：`archiveTotal: 0, archivePage: 1, archiveTotalPages: 1, archiveStats: [] as Array<{typeKey: string; total: number; draft: number; confirmed: number}>, tasks: [] as Array<Record<string, unknown>>, loadArchiveStats: vi.fn(async () => {}), loadArchiveTasks: vi.fn(async () => {}), handleTaskUpdated: vi.fn(), createRecognitionTasks: vi.fn(), retryRecognitionTask: vi.fn(async () => [])`；`loadArchiveDocuments` 改为 `vi.fn(async (_page = 1) => {})`。
- 删除 load-more 用例，替换为：

```ts
  it('默认日期为最近一周并加载第一页', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="archive-filter-date-from"]').element as HTMLInputElement).value // 见下方断言
  })
```

写成可执行断言：

```ts
  it('默认日期为最近一周并加载第一页', async () => {
    await setup()
    const from = stubStore.archiveFilter.dateFrom as number
    const to = stubStore.archiveFilter.dateTo as number
    expect(from).toBeGreaterThan(0)
    expect(to - from).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3)
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
  })

  it('点击类型 Tab 切换筛选并回到第一页', async () => {
    const { wrapper } = await setup()
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-tab-contract"]').trigger('click')
    await flushPromises()
    expect(stubStore.archiveFilter.typeKey).toBe('contract')
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
    // 类型 Tab 下展示该模板全部字段列
    expect(wrapper.text()).toContain('购买方')
  })

  it('状态 chips 展示统计并可筛选', async () => {
    stubStore.archiveStats = [{ typeKey: 'contract', total: 3, draft: 2, confirmed: 1 }]
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('2') // 待确认数量（与模板名/字段并存，弱断言）
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-status-chip-draft"]').trigger('click')
    await flushPromises()
    expect(stubStore.archiveFilter.status).toBe('draft')
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
  })

  it('分页控件按页加载', async () => {
    stubStore.archiveTotal = 51
    stubStore.archiveTotalPages = 2
    const { wrapper } = await setup()
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-page-next"]').trigger('click')
    await flushPromises()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(2)
  })
```

（旧用例『修改类型筛选后调用 loadArchiveDocuments』的 select 版本删除；『全部类型视图渲染摘要列』保留——全部 Tab 仍是金额列 + 摘要。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/pages/documents/DocumentsArchivePage.test.ts --config vitest.config.renderer.ts`
Expected: FAIL

- [ ] **Step 3: 改造页面组件**

`DocumentsArchivePage.vue` template 关键变更：

```html
    <!-- Tab 行：替代原类型 Select -->
    <div class="flex flex-wrap items-center gap-1 border-b px-6 py-2" data-testid="archive-tabs">
      <DcButton
        :variant="activeTab === ALL_TAB ? 'default' : 'ghost'"
        size="sm"
        data-testid="archive-tab-all"
        @click="onTabChange(ALL_TAB)"
      >
        {{ t('settings.documents.archive.tabAll') }}
        <DcBadge variant="outline" class="ml-1">{{ allStats.total }}</DcBadge>
      </DcButton>
      <DcButton
        v-for="tpl in store.templates"
        :key="tpl.typeKey"
        :variant="activeTab === tpl.typeKey ? 'default' : 'ghost'"
        size="sm"
        :data-testid="`archive-tab-${tpl.typeKey}`"
        @click="onTabChange(tpl.typeKey)"
      >
        {{ tpl.name }}
        <DcBadge variant="outline" class="ml-1">{{ statsFor(tpl.typeKey).total }}</DcBadge>
      </DcButton>
    </div>

    <!-- 状态 chips + 日期 + 关键字（移除原类型/状态两个 Select） -->
    <div class="flex flex-wrap items-center gap-2 border-b px-6 py-3">
      <DcButton
        v-for="option in statusOptions"
        :key="option.value"
        size="sm"
        :variant="store.archiveFilter.status === option.statusValue ? 'default' : 'outline'"
        :data-testid="`archive-status-chip-${option.value}`"
        @click="onStatusChip(option.statusValue)"
      >
        {{ option.label }}
        <span class="ml-1 text-muted-foreground">{{ option.count }}</span>
      </DcButton>
      <!-- 两个日期 Input 与关键字 Input 保持原样 -->
    </div>

    <!-- 表格：逻辑不变（selectedTypeKey 驱动列切换） -->

    <!-- 分页（替换 load-more） -->
    <div class="flex items-center justify-between border-t px-6 py-2 text-sm">
      <span class="text-muted-foreground">
        {{ t('settings.documents.archive.totalCount', { total: store.archiveTotal }) }}
      </span>
      <div class="flex items-center gap-1">
        <DcButton
          variant="outline"
          size="sm"
          data-testid="archive-page-prev"
          :disabled="store.archivePage <= 1"
          @click="goPage(store.archivePage - 1)"
        >
          ‹
        </DcButton>
        <span>{{ store.archivePage }} / {{ store.archiveTotalPages }}</span>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="archive-page-next"
          :disabled="store.archivePage >= store.archiveTotalPages"
          @click="goPage(store.archivePage + 1)"
        >
          ›
        </DcButton>
      </div>
    </div>
```

script 变更：

```ts
import { DcBadge } from '@dc-ui/components/badge'
import { buildDefaultDateRangeTexts /* 原有 import 保留 */ } from './documentArchive'

const ALL_TAB = '__all__'
const activeTab = ref(ALL_TAB)
// 默认最近一周：初始化即写入（避免 watch 触发重复加载）
const defaultRange = buildDefaultDateRangeTexts()
const dateFromText = ref(defaultRange.from)
const dateToText = ref(defaultRange.to)

const allStats = computed(() =>
  store.archiveStats.reduce(
    (acc, entry) => ({
      total: acc.total + entry.total,
      draft: acc.draft + entry.draft,
      confirmed: acc.confirmed + entry.confirmed
    }),
    { total: 0, draft: 0, confirmed: 0 }
  )
)

function statsFor(typeKey: string) {
  return store.archiveStats.find((entry) => entry.typeKey === typeKey) ?? {
    typeKey,
    total: 0,
    draft: 0,
    confirmed: 0
  }
}

const statusOptions = computed(() => [
  { value: 'all', statusValue: undefined as DocumentStatus | undefined, label: t('settings.documents.archive.statusAll'), count: selectedTypeKey.value ? statsFor(selectedTypeKey.value).total : allStats.value.total },
  { value: 'draft', statusValue: 'draft' as DocumentStatus, label: t('settings.documents.archive.statusDraft'), count: selectedTypeKey.value ? statsFor(selectedTypeKey.value).draft : allStats.value.draft },
  { value: 'confirmed', statusValue: 'confirmed' as DocumentStatus, label: t('settings.documents.archive.statusConfirmed'), count: selectedTypeKey.value ? statsFor(selectedTypeKey.value).confirmed : allStats.value.confirmed }
])

function onTabChange(typeKey: string) {
  activeTab.value = typeKey
  store.archiveFilter.typeKey = typeKey === ALL_TAB ? undefined : typeKey
  store.archiveFilter.status = undefined
  void store.loadArchiveDocuments(1)
}

function onStatusChip(status: DocumentStatus | undefined) {
  store.archiveFilter.status = status
  void store.loadArchiveDocuments(1)
}

function goPage(page: number) {
  if (page < 1 || page > store.archiveTotalPages) {
    return
  }
  void store.loadArchiveDocuments(page)
}
```

setup 尾部：

```ts
syncFilters()
void store.loadTemplates()
void store.loadArchiveDocuments(1)
void store.loadArchiveStats()
```

`onTypeFilter/onStatusFilter`（Select 版）与 `ALL_VALUE` Select 常量删除；`moneyColumns`/`tableFieldColumns`/`summarizeDocument`/详情/导出逻辑不变。`DocumentStatus` 类型从 `@shared/documents` import。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/documents/DocumentsArchivePage.vue test/renderer/pages/documents/DocumentsArchivePage.test.ts
git commit -m "feat(documents): archive tabs and pagination"
```

---

### Task 8: 任务进度条（DocumentTaskStrip + 事件订阅）

**Files:**
- Create: `src/renderer/src/pages/documents/DocumentTaskStrip.vue`
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue`
- Test: `test/renderer/pages/documents/DocumentTaskStrip.test.ts`（新）

- [ ] **Step 1: 写失败测试**

新建 `test/renderer/pages/documents/DocumentTaskStrip.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DocumentTaskStrip from '../../../../src/renderer/src/pages/documents/DocumentTaskStrip.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const makeTask = (overrides = {}) => ({
  id: 't1',
  batchId: 'b1',
  filePath: 'C:\\a.png',
  fileName: 'a.png',
  templateId: 'auto',
  status: 'running',
  typeKey: null,
  documentId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('DocumentTaskStrip', () => {
  it('renders file name and status for each task', () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: {
        tasks: [makeTask(), makeTask({ id: 't2', status: 'failed', error: 'boom', fileName: 'b.pdf' })],
        typeNameFor: (typeKey: string | null) => (typeKey ? `T:${typeKey}` : null)
      },
      global: { stubs: { Icon: true, DcButton: { template: '<button><slot /></button>' } } }
    })
    expect(wrapper.text()).toContain('a.png')
    expect(wrapper.text()).toContain('b.pdf')
    expect(wrapper.text()).toContain('boom')
  })

  it('emits retry with the failed task', async () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: { tasks: [makeTask({ status: 'failed', error: 'x' })], typeNameFor: () => null },
      global: { stubs: { Icon: true, DcButton: { template: '<button @click=\"$emit(\'click\' 1)\" />' } } }
    })
    await wrapper.get('[data-testid="task-retry"]').trigger('click')
    expect(wrapper.emitted('retry')?.[0]?.[0]).toMatchObject({ id: 't1' })
  })
})
```

（retry stub 用普通按钮模板 `'<button data-testid="task-retry" @click="$emit(\'click\')">R</button>'` —— DcButton stub 需转发 click；以页面里重试按钮自带 data-testid 为准，stub 简化为透传 button。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/pages/documents/DocumentTaskStrip.test.ts --config vitest.config.renderer.ts`
Expected: FAIL — 组件不存在

- [ ] **Step 3: 实现组件**

新建 `src/renderer/src/pages/documents/DocumentTaskStrip.vue`：

```vue
<template>
  <div class="border-b bg-muted/30 px-6 py-2" data-testid="archive-task-strip">
    <p class="mb-1 text-xs font-medium text-muted-foreground">
      {{ t('settings.documents.archive.taskStripTitle') }}
    </p>
    <ul class="space-y-1">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="flex items-center gap-2 text-sm"
        :data-testid="`archive-task-${task.id}`"
      >
        <Icon
          :icon="statusIcon(task.status)"
          :class="['size-4 shrink-0', task.status === 'running' ? 'animate-spin' : '']"
        />
        <span class="truncate">{{ task.fileName }}</span>
        <DcBadge v-if="typeNameFor(task.typeKey)" variant="outline">
          {{ typeNameFor(task.typeKey) }}
        </DcBadge>
        <span v-else-if="task.templateId === 'auto'" class="text-xs text-muted-foreground">
          {{ t('settings.documents.archive.taskClassifying') }}
        </span>
        <span
          v-if="task.error"
          class="truncate text-xs text-destructive"
          :title="task.error"
        >
          {{ task.error }}
        </span>
        <span class="ml-auto shrink-0 text-xs text-muted-foreground">
          {{ statusText(task.status) }}
        </span>
        <DcButton
          v-if="task.status === 'failed'"
          variant="outline"
          size="sm"
          data-testid="task-retry"
          @click="emit('retry', task)"
        >
          {{ t('settings.documents.archive.taskRetry') }}
        </DcButton>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { DcBadge } from '@dc-ui/components/badge'
import type { DocumentsTaskItem } from './documentTasks'

defineProps<{
  tasks: DocumentsTaskItem[]
  typeNameFor: (typeKey: string | null) => string | null
}>()

const emit = defineEmits<{ retry: [task: DocumentsTaskItem] }>()
const { t } = useI18n()

function statusIcon(status: DocumentsTaskItem['status']): string {
  if (status === 'running') return 'lucide:loader-2'
  if (status === 'done') return 'lucide:check-circle-2'
  if (status === 'failed') return 'lucide:x-circle'
  return 'lucide:clock'
}

function statusText(status: DocumentsTaskItem['status']): string {
  if (status === 'running') return t('settings.documents.archive.taskRunning')
  if (status === 'done') return t('settings.documents.archive.taskDone')
  if (status === 'failed') return t('settings.documents.archive.taskFailed')
  return t('settings.documents.archive.taskQueued')
}
</script>
```

配套新建 `src/renderer/src/pages/documents/documentTasks.ts`（类型归一，页面与条共用）：

```ts
export interface DocumentsTaskItem {
  id: string
  batchId: string
  filePath: string
  fileName: string
  templateId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  typeKey: string | null
  documentId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  doneCount?: number
  totalCount?: number
  version?: number
}
```

（store 的本地类型改为从该文件 re-export/import，避免两处定义。）

- [ ] **Step 4: 页面接入**

`DocumentsArchivePage.vue`：

```ts
import DocumentTaskStrip from './DocumentTaskStrip.vue'
import { onBeforeUnmount, onMounted } from 'vue'
import { createDocumentsClient } from '@api/DocumentsClient'

const documentsApi = createDocumentsClient()
let unsubscribeTask: (() => void) | null = null
onMounted(() => {
  unsubscribeTask = documentsApi.onTaskUpdated((payload) => store.handleTaskUpdated(payload))
})
onBeforeUnmount(() => {
  unsubscribeTask?.()
  unsubscribeTask = null
})
void store.loadArchiveTasks()

const visibleTasks = computed(() =>
  store.tasks.filter((task) => task.status === 'pending' || task.status === 'running' || task.status === 'failed')
)

function typeNameFor(typeKey: string | null): string | null {
  if (!typeKey) return null
  return store.templates.find((tpl) => tpl.typeKey === typeKey)?.name ?? typeKey
}

async function onRetryTask(task: DocumentsTaskItem) {
  try {
    await store.retryRecognitionTask(task)
    notifyTransient('success', 'documents.archive.taskRetryQueued', t('settings.documents.archive.taskRetryQueued'))
  } catch (error) {
    console.error('[DocumentsArchivePage] retry task failed', error)
    notifyTransient('error', 'documents.archive.taskRetryFailed', t('settings.documents.archive.taskRetryFailed'))
  }
}
```

template 中筛选行之后、表格之前插入：

```html
    <DocumentTaskStrip
      v-if="visibleTasks.length"
      :tasks="visibleTasks"
      :type-name-for="typeNameFor"
      @retry="onRetryTask"
    />
```

任务完成后当前页会自动刷新（store.handleTaskUpdated 内），若新单据落在当前 Tab 的当页即可见。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/documents/DocumentTaskStrip.vue src/renderer/src/pages/documents/documentTasks.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue test/renderer/pages/documents/DocumentTaskStrip.test.ts
git commit -m "feat(documents): task strip progress ui"
```

---

### Task 9: 识别对话框 — 多文件 + 自动分类 + 立即返回

**Files:**
- Modify: `src/renderer/src/pages/documents/DocumentRecognizeDialog.vue`
- Test: `test/renderer/pages/documents/DocumentRecognizeDialog.test.ts`

- [ ] **Step 1: 改造测试（先失败）**

`DocumentRecognizeDialog.test.ts`：将"选择文件/提交调 recognizeDocument"用例替换为：

```ts
  it('多选文件并提交创建批量任务', async () => {
    deviceClientMock.selectFiles.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\a.png', 'C:\\b.pdf']
    })
    storeMock.createRecognitionTasks.mockResolvedValue([])
    const wrapper = await setup()
    await wrapper.get('[data-testid="recognize-select-file"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('2') // filesSelected 计数
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(storeMock.createRecognitionTasks).toHaveBeenCalledWith({
      files: [
        { path: 'C:\\a.png', name: 'a.png' },
        { path: 'C:\\b.pdf', name: 'b.pdf' }
      ],
      templateId: 'auto'
    })
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('默认模板为自动分类且可切换到具体模板', async () => {
    const wrapper = await setup()
    // 模板 Select 第一个 option 为 __auto__
    const options = wrapper.findAll('option').map((o) => o.element.value)
    expect(options[0]).toBe('__auto__')
    await wrapper.get('[data-testid="recognize-template-trigger"]').setValue('tpl-1')
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    expect(storeMock.createRecognitionTasks).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-1' })
    )
  })

  it('移除已选文件', async () => {
    deviceClientMock.selectFiles.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\a.png', 'C:\\b.pdf']
    })
    const wrapper = await setup()
    await wrapper.get('[data-testid="recognize-select-file"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="recognize-file-remove-1"]').trigger('click')
    expect(wrapper.text()).toContain('1')
  })
```

（store mock 用 `createRecognitionTasks` 替换 `recognizeDocument`；以该文件现有 setup/mock 结构对齐。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/pages/documents/DocumentRecognizeDialog.test.ts --config vitest.config.renderer.ts`
Expected: FAIL

- [ ] **Step 3: 实现对话框**

`DocumentRecognizeDialog.vue` 变更：

script：

```ts
const AUTO_VALUE = '__auto__'
const selectedFiles = ref<Array<{ path: string; name: string }>>([])
const templateId = ref(AUTO_VALUE)
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => selectedFiles.value.length > 0 && !submitting.value)
const isPdfFile = computed(() => selectedFiles.value.some((f) => f.path.toLowerCase().endsWith('.pdf')))

async function onSelectFile() {
  try {
    const result = await deviceClient.selectFiles({
      multiple: true,
      filters: [{ name: 'Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return
    }
    const existing = new Set(selectedFiles.value.map((f) => f.path))
    for (const uri of result.filePaths) {
      if (existing.has(uri)) continue
      selectedFiles.value.push({ path: uri, name: uri.split(/[\\/]/).pop() ?? uri })
    }
    error.value = ''
  } catch (err) {
    console.error('[DocumentRecognizeDialog] select files failed', err)
  }
}

function removeFile(index: number) {
  selectedFiles.value.splice(index, 1)
}

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = ''
  try {
    await store.createRecognitionTasks({
      files: selectedFiles.value.map((f) => ({ path: f.path, name: f.name })),
      templateId: templateId.value === AUTO_VALUE ? 'auto' : templateId.value
    })
    emit('submitted')
    emit('update:open', false)
  } catch (err) {
    console.error('[DocumentRecognizeDialog] create tasks failed', err)
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
```

删除 elapsed timer 相关代码（`elapsedSeconds/elapsedTimer/startElapsedTimer/stopElapsedTimer/submitText`），按钮文案固定 `t('settings.documents.archive.recognize')`，提交中禁用即可。watch(open) 重置 `selectedFiles = []`、`error = ''`、`templateId = AUTO_VALUE`；`fillDefaultTemplateId` 逻辑删除（不再自动选第一个模板）。emits 增加 `submitted: []`，移除 `recognized`。

template：

```html
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <Input
            :model-value="t('settings.documents.archive.filesSelected', { count: selectedFiles.length })"
            readonly
            data-testid="recognize-file-input"
          />
          <DcButton variant="outline" data-testid="recognize-select-file" :disabled="submitting" @click="onSelectFile">
            {{ t('settings.documents.archive.selectFile') }}
          </DcButton>
        </div>
        <ul class="flex flex-wrap gap-1">
          <li
            v-for="(file, index) in selectedFiles"
            :key="file.path"
            class="flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
          >
            <span class="max-w-48 truncate">{{ file.name }}</span>
            <button
              type="button"
              :data-testid="`recognize-file-remove-${index}`"
              class="text-muted-foreground hover:text-destructive"
              @click="removeFile(index)"
            >
              ×
            </button>
          </li>
        </ul>
      </div>
      <div class="space-y-1">
        <Select :model-value="templateId" @update:model-value="(value) => (templateId = String(value))">
          <SelectTrigger data-testid="recognize-template-trigger"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto__">
              {{ t('settings.documents.archive.autoClassify') }}
            </SelectItem>
            <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.id">
              {{ tpl.name }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
```

`DocumentsArchivePage.vue` 中对话框事件接线同步改为 `@submitted="onTasksSubmitted"`：

```ts
function onTasksSubmitted() {
  notifyTransient('success', 'documents.archive.taskQueuedToast', t('settings.documents.archive.taskQueuedToast'))
  void store.loadArchiveTasks()
}
```

（页面测试若断言 recognized 事件，一并替换。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/pages/documents --config vitest.config.renderer.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages/documents/DocumentRecognizeDialog.vue src/renderer/src/pages/documents/DocumentsArchivePage.vue test/renderer/pages/documents/DocumentRecognizeDialog.test.ts
git commit -m "feat(documents): multi-file recognize dialog"
```

---

### Task 10: i18n 20 语言 + 全量校验 + 推送

**Files:**
- Modify: `src/renderer/src/i18n/{zh-CN,zh-TW,zh-HK,en-US,ja-JP,ko-KR,de-DE,fr-FR,es-ES,pt-BR,it-IT,ru-RU,tr-TR,pl-PL,da-DK,fa-IR,he-IL,vi-VN,id-ID,ms-MY}/settings.json`
- Modify: `src/types/i18n.d.ts`（由 i18n:types 生成）

- [ ] **Step 1: 补齐 key（以 zh-CN / en-US 为基准，其余 18 语言按各自语言翻译）**

在 `settings.documents.archive` 对象内（`reRecognizeHint` 之后）追加 12 个 key：

zh-CN：

```json
"tabAll": "全部",
"totalCount": "共 {total} 条",
"taskStripTitle": "识别任务",
"taskQueued": "排队中",
"taskRunning": "识别中",
"taskDone": "已完成",
"taskFailed": "失败",
"taskRetry": "重试",
"taskRetryQueued": "已重新提交识别任务",
"taskRetryFailed": "重试失败",
"taskClassifying": "分类中…",
"autoClassify": "自动分类（大模型）",
"filesSelected": "已选 {count} 个文件",
"taskQueuedToast": "已提交 {count} 个识别任务"
```

en-US：

```json
"tabAll": "All",
"totalCount": "{total} in total",
"taskStripTitle": "Recognition tasks",
"taskQueued": "Queued",
"taskRunning": "Recognizing",
"taskDone": "Done",
"taskFailed": "Failed",
"taskRetry": "Retry",
"taskRetryQueued": "Recognition task re-submitted",
"taskRetryFailed": "Retry failed",
"taskClassifying": "Classifying…",
"autoClassify": "Auto classify (LLM)",
"filesSelected": "{count} file(s) selected",
"taskQueuedToast": "Submitted {count} recognition task(s)"
```

（共 14 个 key；`taskQueuedToast` 带 {count} 参数——页面调用处改为 `t('...taskQueuedToast', { count: createdCount })`，`onTasksSubmitted` 需拿到返回的任务数：`const created = await store.loadArchiveTasks()` 不可行，改为 `onTasksSubmitted(count: number)` 由对话框 emit 传出 `created.length`。）

- [ ] **Step 2: 生成校验**

Run: `pnpm run i18n ; pnpm run i18n:en ; pnpm run i18n:types`
Expected: PASS（缺译会报错，按报错补齐对应语言）

- [ ] **Step 3: 全量校验**

Run: `pnpm run format ; pnpm run lint ; pnpm run typecheck`
Expected: PASS

Run: `pnpm exec vitest run test/main/documents --config vitest.config.ts`
Expected: documents 主进程套件全绿

Run: `pnpm exec vitest run test/renderer/pages/documents test/renderer/api test/renderer/stores/documentsArchiveStore.test.ts test/renderer/stores/documentsStore.test.ts --config vitest.config.renderer.ts`
Expected: PASS（若 stores 全量跑出现 tinypool 段错误，按 memory 拆小批重跑）

- [ ] **Step 4: 对照预存失败清单**

Run: `pnpm run test:main`
Expected: ~98 个预存环境失败；对比失败文件清单，确认新增失败仅来自本次触及文件（如有，修复后重跑）。

- [ ] **Step 5: Commit + Push**

```bash
git add src/renderer/src/i18n src/types/i18n.d.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue src/renderer/src/pages/documents/DocumentRecognizeDialog.vue
git commit -m "i18n: document archive and task keys"
git push origin develop
```

---

## Self-Review 结论

- **覆盖检查**：需求(1) tab 呈现→Task 7；每类型全部字段→已有 `tableFieldColumns`（Tab 驱动 typeKey 后天然生效）；状态统计→Task 1/2/6/7（stats 路由 + chips）；默认近 1 周→Task 6/7；分页→Task 6/7。需求(2) 多文件提交→Task 9；自动分类→Task 4/9（`templateId='auto'` 复用既有分类）；立即返回+进度→Task 4/5/8（任务泵 + event + strip）；多模态优先/OCR 兜底→Task 3；并发提速→Task 4（并发 2）。
- **占位符扫描**：测试代码中标注"沿用该文件现状对齐"的 fixture（makeDocInput/db/validInsertInput/store mock 结构）为对既有测试文件的引用，非逻辑占位；所有新文件给出完整代码。
- **类型一致性**：`DocumentTask`（repository）= `documentTaskSchema`（契约）= `DocumentsTaskItem`（渲染层）字段一一对应（snake_case 行 → camelCase 映射在 `toTask`）；`RecognitionTaskManager.submit` 输入与 `documentsTasksCreateRoute.input` 匹配（source 由 zod default 填充）；事件 payload 的 `doneCount/totalCount/version` 在 manager.publish 与 composition publish 两端一致。

## 执行注意

- 每个任务完成即 commit（消息见各任务 Step）；全部完成后 push origin/develop。
- 遇到与"关键事实"不符的代码现状（行号漂移属正常，行为不符要停下来核实），以实际代码为准并在计划文档记录偏差。
- 渲染层 stores 全量测试曾出现 tinypool 段错误（资源型 flake），拆小批重跑即可，不要归因于本次改动。
