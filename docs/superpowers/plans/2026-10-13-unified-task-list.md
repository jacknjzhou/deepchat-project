# 统一文档任务列表页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在归档页新增「任务」视图：manual/scheduled 真任务与 chat 伪任务统一混排展示，支持来源/状态过滤、扫描批次下钻、分页、失败重试/清除/跳文档详情。

**Architecture:** 数据层新增过滤分页查询（`document_tasks.listFiltered` + `documents.listChatAsTasks` chat 伪任务投影）与批次聚合（按 `batch_id` GROUP BY）；repository 层做「两查询 + 分页窗口归并」产出统一条目；IPC 扩展 `documents.tasks.list` 入参与新增 `documents.tasks.scanBatches` 通道；前端复用归档页 viewMode/过滤/分页范式新增第三个视图。

**Tech Stack:** TypeScript (Electron main + Vue3 renderer)、better-sqlite3-multiple-ciphers、zod 契约、Vitest、vue-i18n。
Spec: `docs/superpowers/specs/2026-10-13-unified-task-list-design.md`

## Global Constraints

- 主进程测试命令（bash；本机 pnpm exec/run shim 损坏，直接调 node_modules 下二进制）：
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`
- test:main 全仓有既有环境性失败基线（rendererPerformanceLogService、sessionDataMigrations 等）：只比对失败文件清单与本次改动区域，不修既有失败。
- `typecheck:node` 必须通过：`./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false`（会触碰 tsconfig.node.tsbuildinfo，勿提交）。
- `typecheck:web`：`./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false`；本机 tsgo/vue-tsc OOM（errno 1455/134）复现则跳过并注明（本次改 renderer，尽量跑通）。
- oxfmt 单引号/无分号/100 列（`./node_modules/.bin/oxfmt <files>`）+ `./node_modules/.bin/oxlint <files>` 0 警告，仅对改动文件执行（仓库级 .oxlintrc.json 忽略 test/** 属正常）。
- 提交信息 Conventional Commits ≤50 字符。
- 依赖注入风格：repository/table 分层沿用现状（repository 组合 database 下各 table，port 接口 `DocumentRepositoryTaskPort` 供注入方使用）。
- 测试导入别名用 `@/documents/...`（`test/main/documents/` 目录既有约定）；需要真实 fs 的测试文件头加 `vi.unmock('fs')/'node:fs'/'path'/'node:path'`（参照 taskManager.test.ts）。
- 数据表迁移注意：document_tasks/documents 两表**不在主 schema_versions 目录迁移循环内**（表内注释已说明 version 2 永远够不到），新增索引**不得**走 getLatestVersion+getMigrationSQL 路径——在 `getCreateTableSQL()` 加索引 DDL（新库）+ `ensureMigrated()` 末尾执行幂等 `CREATE INDEX IF NOT EXISTS`（存量库）。
- Edit 工具在 Windows 有损坏文件尾部的前科：每次编辑后读回文件尾部确认完整性。

---

### Task 1: 表层查询改造（过滤分页 + 批次聚合 + chat 伪任务投影）

**Files:**
- Modify: `src/main/documents/data/tables/documentTasks.ts`
- Modify: `src/main/documents/data/tables/documents.ts`
- Test: `test/main/documents/documentsTables.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `BaseTable`、`DocumentTaskRow`、`DocumentRow`
- Produces（后续任务依赖的精确签名）:
  - `export interface DocumentTaskListFilter { status?: 'pending' | 'running' | 'done' | 'failed'; source?: 'chat' | 'manual' | 'scheduled'; batchId?: string; limit: number; offset: number }`（documentTasks.ts 导出）
  - `DocumentTasksTable.listFiltered(filter: DocumentTaskListFilter): DocumentTaskRow[]`
  - `DocumentTasksTable.countFiltered(filter: DocumentTaskListFilter): number`
  - `DocumentTasksTable.listScanBatches(limit: number, offset: number): Array<{ batch_id: string; started_at: number; total: number; done: number; failed: number }>`
  - `DocumentTasksTable.countScanBatches(): number`
  - `DocumentsTable.listChatAsTasks(limit: number, offset: number): DocumentRow[]`
  - `DocumentsTable.countChatAsTasks(): number`
  - 新索引：`idx_document_tasks_source(source, created_at DESC)`、`idx_documents_source(source, created_at DESC)`

- [ ] **Step 1: 写失败测试**（追加到 `test/main/documents/documentsTables.test.ts`，沿用该文件既有建库/插桩方式；若该文件用 `new DocumentTasksTable(db)` 风格则保持一致）

```ts
describe('DocumentTasksTable listFiltered / scanBatches', () => {
  it('listFiltered 按 status/source/batchId 过滤且 created_at DESC 分页', () => {
    const t1 = table.insert({ batchId: 'b1', filePath: 'C:/a.pdf', fileName: 'a.pdf', templateId: 'auto', source: 'manual', now: 1000 })
    table.insert({ batchId: 'b2', filePath: 'C:/b.pdf', fileName: 'b.pdf', templateId: 'auto', source: 'scheduled', now: 2000 })
    table.insert({ batchId: 'b2', filePath: 'C:/c.pdf', fileName: 'c.pdf', templateId: 'auto', source: 'scheduled', now: 3000 })
    table.update(t1.id, { status: 'done' })
    expect(table.listFiltered({ source: 'scheduled', limit: 10, offset: 0 }).map((r) => r.file_name)).toEqual(['c.pdf', 'b.pdf'])
    expect(table.listFiltered({ status: 'done', limit: 10, offset: 0 }).map((r) => r.id)).toEqual([t1.id])
    expect(table.listFiltered({ batchId: 'b2', limit: 1, offset: 0 }).map((r) => r.file_name)).toEqual(['c.pdf'])
    expect(table.listFiltered({ batchId: 'b2', limit: 1, offset: 1 }).map((r) => r.file_name)).toEqual(['b.pdf'])
    expect(table.countFiltered({ source: 'scheduled' })).toBe(2)
    expect(table.countFiltered({})).toBe(3)
  })

  it('listScanBatches 按批次聚合（startedAt/total/done/failed）且按 startedAt DESC 排序', () => {
    table.insert({ batchId: 'old', filePath: 'C:/a.pdf', fileName: 'a.pdf', templateId: 'auto', source: 'scheduled', now: 1000 })
    table.insert({ batchId: 'old', filePath: 'C:/b.pdf', fileName: 'b.pdf', templateId: 'auto', source: 'scheduled', now: 1100 })
    table.insert({ batchId: 'new', filePath: 'C:/c.pdf', fileName: 'c.pdf', templateId: 'auto', source: 'scheduled', now: 2000 })
    table.insert({ batchId: 'manual-mix', filePath: 'C:/d.pdf', fileName: 'd.pdf', templateId: 'auto', source: 'manual', now: 1500 })
    const batches = table.listScanBatches(10, 0)
    expect(batches.map((b) => b.batch_id)).toEqual(['new', 'old'])
    expect(batches[1]).toMatchObject({ started_at: 1000, total: 2, done: 0, failed: 0 })
    expect(table.countScanBatches()).toBe(2)
  })

  it('source 索引由 ensureMigrated 幂等创建（存量库无 getLatestVersion 变更）', () => {
    // ensureMigrated 执行后索引必须存在；重复执行不抛错
    table.ensureMigrated()
    table.ensureMigrated()
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_document_tasks_source'`).get()
    expect(idx).toBeDefined()
  })
})

describe('DocumentsTable listChatAsTasks', () => {
  it('仅返回 source=chat 的行，created_at DESC 分页；countChatAsTasks 同口径', () => {
    documents.insert({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: ['C:/chat1.pdf'], source: 'chat', sessionId: 's1', status: 'draft', now: 1000 })
    documents.insert({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: ['C:/chat2.pdf'], source: 'chat', sessionId: 's2', status: 'draft', now: 2000 })
    documents.insert({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: ['C:/manual.pdf'], source: 'manual', sessionId: null, status: 'draft', now: 3000 })
    const rows = documents.listChatAsTasks(10, 0)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.file_uris_json).toContain('chat2.pdf')
    expect(documents.countChatAsTasks()).toBe(2)
  })

  it('documents.source 索引由 ensureMigrated 幂等创建', () => {
    documents.ensureMigrated()
    documents.ensureMigrated()
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_documents_source'`).get()
    expect(idx).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTables.test.ts --config vitest.config.ts`
Expected: FAIL（listFiltered/listScanBatches/listChatAsTasks 不存在）

- [ ] **Step 3: 实现 documentTasks.ts**

```ts
export interface DocumentTaskListFilter {
  status?: 'pending' | 'running' | 'done' | 'failed'
  source?: 'chat' | 'manual' | 'scheduled'
  batchId?: string
  limit: number
  offset: number
}
```

`getCreateTableSQL()` 的索引段追加一行：
```sql
CREATE INDEX IF NOT EXISTS idx_document_tasks_source
  ON document_tasks(source, created_at DESC);
```
`getMigrationSQL(2)` 重建后的索引段同样追加该索引（保持重建 DDL 与新建 DDL 一致）。
`ensureMigrated()` 在 CHECK 检测逻辑之后（函数末尾）追加幂等索引保证（不 bump getLatestVersion——本表不在主迁移循环内，version 3 永远不会被触达）：
```ts
this.db.exec(
  'CREATE INDEX IF NOT EXISTS idx_document_tasks_source ON document_tasks(source, created_at DESC)'
)
```

类内新增方法（放在 `listRecent` 之后）：
```ts
private buildFilterWhere(filter: DocumentTaskListFilter): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }
  if (filter.source) {
    conditions.push('source = ?')
    params.push(filter.source)
  }
  if (filter.batchId) {
    conditions.push('batch_id = ?')
    params.push(filter.batchId)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

listFiltered(filter: DocumentTaskListFilter): DocumentTaskRow[] {
  const { where, params } = this.buildFilterWhere(filter)
  return this.db
    .prepare(
      `SELECT * FROM document_tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, filter.limit, filter.offset) as DocumentTaskRow[]
}

countFiltered(filter: DocumentTaskListFilter): number {
  const { where, params } = this.buildFilterWhere(filter)
  const row = this.db
    .prepare(`SELECT COUNT(*) AS count FROM document_tasks ${where}`)
    .get(...params) as { count: number }
  return row.count
}

listScanBatches(
  limit: number,
  offset: number
): Array<{ batch_id: string; started_at: number; total: number; done: number; failed: number }> {
  return this.db
    .prepare(
      `SELECT batch_id,
              MIN(created_at) AS started_at,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM document_tasks WHERE source = 'scheduled'
       GROUP BY batch_id
       ORDER BY started_at DESC, batch_id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    batch_id: string
    started_at: number
    total: number
    done: number
    failed: number
  }>
}

countScanBatches(): number {
  const row = this.db
    .prepare(`SELECT COUNT(DISTINCT batch_id) AS count FROM document_tasks WHERE source = 'scheduled'`)
    .get() as { count: number }
  return row.count
}
```

- [ ] **Step 4: 实现 documents.ts**

`getCreateTableSQL()` 索引段追加：
```sql
CREATE INDEX IF NOT EXISTS idx_documents_source
  ON documents(source, created_at DESC);
```
`getMigrationSQL(2)` 重建索引段同样追加；`ensureMigrated()` 末尾追加：
```ts
this.db.exec('CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source, created_at DESC)')
```

类内新增（放在 `count` 之后）：
```ts
listChatAsTasks(limit: number, offset: number): DocumentRow[] {
  return this.db
    .prepare(
      `SELECT * FROM documents WHERE source = 'chat' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as DocumentRow[]
}

countChatAsTasks(): number {
  const row = this.db
    .prepare(`SELECT COUNT(*) AS count FROM documents WHERE source = 'chat'`)
    .get() as { count: number }
  return row.count
}
```

- [ ] **Step 5: 运行确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTables.test.ts --config vitest.config.ts`
Expected: PASS（含既有用例不回归；documentsTableMigration.test.ts 同跑确认迁移不回归）

- [ ] **Step 6: 格式化、lint、typecheck、Commit**

```bash
./node_modules/.bin/oxfmt src/main/documents/data/tables/documentTasks.ts src/main/documents/data/tables/documents.ts test/main/documents/documentsTables.test.ts
./node_modules/.bin/oxlint src/main/documents/data/tables/documentTasks.ts src/main/documents/data/tables/documents.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/data/tables/documentTasks.ts src/main/documents/data/tables/documents.ts test/main/documents/documentsTables.test.ts
git commit -m "feat(documents): task list table queries"
```

---

### Task 2: repository 层统一条目（伪任务投影 + 窗口归并 + 批次映射）

**Files:**
- Modify: `src/main/documents/repository.ts`（`DocumentRepositoryTaskPort` 接口 + `DocumentsRepository` 实现）
- Test: `test/main/documents/documentsRepository.test.ts`（若无此文件则追加到 `documentsTables.test.ts` 同级新文件 `test/main/documents/documentsRepository.test.ts`，用内存库构造 repository——构造方式参照现有测试对 `DocumentsRepository`/`DocumentsDatabase` 的实例化方式）

**Interfaces:**
- Consumes: Task 1 全部签名
- Produces:
  - `export interface UnifiedTaskEntry { id: string; filePath: string | null; fileName: string; templateId: string | null; source: 'chat' | 'manual' | 'scheduled'; status: 'pending' | 'running' | 'done' | 'failed'; typeKey: string | null; documentId: string | null; error: string | null; createdAt: number; updatedAt: number; batchId: string | null }`（repository.ts 导出；filePath/updatedAt/templateId 保留是为让既有 DocumentTaskStrip 无损切换）
  - `export interface UnifiedTaskListFilter { status?: DocumentTaskStatus; source?: 'chat' | 'manual' | 'scheduled'; batchId?: string; limit: number; offset: number }`
  - `export interface ScanBatchSummary { batchId: string; startedAt: number; total: number; done: number; failed: number }`
  - `listUnifiedTasks(filter: UnifiedTaskListFilter): { tasks: UnifiedTaskEntry[]; total: number }`
  - `listScanBatches(limit: number, offset: number): ScanBatchSummary[]`
  - `countScanBatches(): number`

- [ ] **Step 1: 写失败测试**

```ts
describe('listUnifiedTasks', () => {
  it('source=chat → documents 伪任务条目（fileName 取 fileUris[0] basename，status=done，documentId=id）', () => {
    repository.insertDocument({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: ['C:\\scan\\话费发票.pdf'], source: 'chat', sessionId: 's', status: 'draft', now: 1000 })
    const { tasks, total } = repository.listUnifiedTasks({ source: 'chat', limit: 10, offset: 0 })
    expect(total).toBe(1)
    expect(tasks[0]).toMatchObject({ fileName: '话费发票.pdf', source: 'chat', status: 'done', documentId: tasks[0]!.id, filePath: 'C:\\scan\\话费发票.pdf', typeKey: 'invoice' })
    expect(tasks[0]!.templateId).toBeNull()
    expect(tasks[0]!.batchId).toBeNull()
  })

  it('chat fileUris 空数组 → fileName 回退 (未知文件)、filePath null', () => {
    repository.insertDocument({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: [], source: 'chat', sessionId: null, status: 'draft', now: 1000 })
    const { tasks } = repository.listUnifiedTasks({ source: 'chat', limit: 10, offset: 0 })
    expect(tasks[0]!.fileName).toBe('(未知文件)')
    expect(tasks[0]!.filePath).toBeNull()
  })

  it('无 source → 混排归并（created_at DESC），total 为两表之和', () => {
    // insertTasks 无 now 参数（created_at=Date.now()），顺序断言用单调性校验而非具体序
    repository.insertTasks([{ batchId: 'b1', filePath: 'C:/m.pdf', fileName: 'm.pdf', templateId: 'auto', source: 'manual' }])
    repository.insertDocument({ templateId: 't', typeKey: 'invoice', templateSnapshot: {}, fields: {}, fileUris: ['C:/chat.pdf'], source: 'chat', sessionId: null, status: 'draft' })
    const { tasks, total } = repository.listUnifiedTasks({ limit: 10, offset: 0 })
    expect(total).toBe(2)
    expect(tasks.map((t) => t.source).sort()).toEqual(['chat', 'manual'].sort())
    expect(tasks.map((t) => t.createdAt)).toEqual([...tasks.map((t) => t.createdAt)].sort((a, b) => b - a))
  })

  it('混排分页窗口正确（offset 跨越两表边界不重不漏）', () => {
    // 造 3 条真任务（now 递增）+ 2 条 chat 文档，混合排序后逐页拉取（limit 2）应覆盖全部 5 条且不重复
    const seen = new Set<string>()
    for (let page = 1; page <= 3; page++) {
      const { tasks } = repository.listUnifiedTasks({ limit: 2, offset: (page - 1) * 2 })
      for (const t of tasks) {
        expect(seen.has(t.id)).toBe(false)
        seen.add(t.id)
      }
    }
    expect(seen.size).toBe(5)
  })

  it('batchId 过滤只命中该批次真任务', () => {
    repository.insertTasks([
      { batchId: 'bx', filePath: 'C:/x.pdf', fileName: 'x.pdf', templateId: 'auto', source: 'scheduled' },
      { batchId: 'by', filePath: 'C:/y.pdf', fileName: 'y.pdf', templateId: 'auto', source: 'scheduled' }
    ])
    const { tasks, total } = repository.listUnifiedTasks({ batchId: 'bx', limit: 10, offset: 0 })
    expect(total).toBe(1)
    expect(tasks[0]!.batchId).toBe('bx')
  })
})

describe('listScanBatches / countScanBatches', () => {
  it('返回批次摘要（batchId 驼峰映射、startedAt 为批内最早 created_at）', () => {
    repository.insertTasks([
      { batchId: 's1', filePath: 'C:/a.pdf', fileName: 'a.pdf', templateId: 'auto', source: 'scheduled' },
      { batchId: 's1', filePath: 'C:/b.pdf', fileName: 'b.pdf', templateId: 'auto', source: 'scheduled' }
    ])
    const batches = repository.listScanBatches(10, 0)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ batchId: 's1', total: 2 })
    expect(repository.countScanBatches()).toBe(1)
  })
})
```

注意：`insertTasks` 无 now 参数时 created_at 由 Date.now() 生成，同批内多条可能同毫秒——排序用例靠「同毫秒按 id 稳定排序」断言不重不漏即可，不要断言具体顺序。

- [ ] **Step 2: 运行确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRepository.test.ts --config vitest.config.ts`
Expected: FAIL（listUnifiedTasks 不存在）

- [ ] **Step 3: 实现 repository.ts**

`DocumentRepositoryTaskPort` 接口追加三个方法声明（签名与本任务 Produces 一致）；`DocumentsRepository` 实现：

```ts
const UNKNOWN_TASK_FILE_NAME = '(未知文件)'

const toUnifiedTaskEntry = (task: DocumentTask): UnifiedTaskEntry => ({
  id: task.id,
  filePath: task.filePath,
  fileName: task.fileName,
  templateId: task.templateId,
  source: task.source,
  status: task.status,
  typeKey: task.typeKey,
  documentId: task.documentId,
  error: task.error,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  batchId: task.batchId
})

const toChatTaskEntry = (row: DocumentRow): UnifiedTaskEntry => {
  let rawPath: string | null = null
  try {
    const uris = JSON.parse(row.file_uris_json) as unknown
    rawPath = Array.isArray(uris) && typeof uris[0] === 'string' ? uris[0] : null
  } catch {
    rawPath = null
  }
  const base = rawPath?.split(/[\\/]/).pop() ?? ''
  return {
    id: row.id,
    filePath: rawPath,
    fileName: base || UNKNOWN_TASK_FILE_NAME,
    templateId: null,
    source: 'chat',
    status: 'done',
    typeKey: row.type_key,
    documentId: row.id,
    error: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    batchId: null
  }
}

const mergeByCreatedDesc = (entries: UnifiedTaskEntry[]): UnifiedTaskEntry[] =>
  entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
```

```ts
listUnifiedTasks(filter: UnifiedTaskListFilter): { tasks: UnifiedTaskEntry[]; total: number } {
  if (filter.source === 'chat') {
    const rows = this.database.documentsTable.listChatAsTasks(filter.limit, filter.offset)
    return { tasks: rows.map(toChatTaskEntry), total: this.database.documentsTable.countChatAsTasks() }
  }
  const realRows = this.database.documentTasksTable.listFiltered(filter)
  const realTotal = this.database.documentTasksTable.countFiltered(filter)
  if (filter.source === 'manual' || filter.source === 'scheduled') {
    return { tasks: realRows.map(toUnifiedTaskEntry), total: realTotal }
  }
  // 混排：两表各取 offset+limit 窗口，内存归并后切页（数量级下无性能问题）
  const chatRows = this.database.documentsTable.listChatAsTasks(filter.offset + filter.limit, 0)
  const merged = mergeByCreatedDesc([...realRows.map(toUnifiedTaskEntry), ...chatRows.map(toChatTaskEntry)])
  return { tasks: merged.slice(filter.offset, filter.offset + filter.limit), total: realTotal + this.database.documentsTable.countChatAsTasks() }
}

listScanBatches(limit: number, offset: number): ScanBatchSummary[] {
  return this.database.documentTasksTable.listScanBatches(limit, offset).map((b) => ({
    batchId: b.batch_id,
    startedAt: b.started_at,
    total: b.total,
    done: b.done,
    failed: b.failed
  }))
}

countScanBatches(): number {
  return this.database.documentTasksTable.countScanBatches()
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRepository.test.ts test/main/documents/documentsTables.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 5: 格式化、lint、typecheck、Commit**

```bash
./node_modules/.bin/oxfmt src/main/documents/repository.ts test/main/documents/documentsRepository.test.ts
./node_modules/.bin/oxlint src/main/documents/repository.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/repository.ts test/main/documents/documentsRepository.test.ts
git commit -m "feat(documents): unified task entries"
```

---

### Task 3: IPC 契约扩展与 routes 实现（tasks.list 改造 + scanBatches 新通道）

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`（documentTaskSchema 补 source、tasks.list 入参/出参、新通道）
- Modify: `src/main/documents/routes.ts`（tasks.list 实现替换 + scanBatches 注册）
- Test: `test/main/documents/documentsRoutes.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `listUnifiedTasks/listScanBatches/countScanBatches`
- Produces:
  - `documentTaskSchema` 增加 `source: documentSourceSchema`
  - `documents.tasks.list` 入参 `{ status?, source?, batchId?, limit(1..200, default 50), offset(min 0, default 0) }`，出参 `{ tasks: unifiedTaskEntrySchema[], total }`
  - `unifiedTaskEntrySchema`（contract 导出；字段与 Task 2 的 `UnifiedTaskEntry` 一致，其中 filePath/templateId/typeKey/documentId/error/batchId 均 `.nullable()`）
  - `documents.tasks.scanBatches`：入参 `{ limit(1..200, default 50), offset(min 0, default 0) }`，出参 `{ batches: [{ batchId, startedAt, total, done, failed }], total }`
  - 既有 `documents.tasks.create` 出参因 documentTaskSchema 加 source 而多带 source（DocumentTask 本就含 source，parse 由剔除变透传）；既有 `listTasks()`（无参调用）因入参全部可选/有默认而继续可用，出参条目变为统一条目（超集兼容 DocumentTaskStrip 所需字段）

- [ ] **Step 1: 修改契约**（documents.routes.ts）

```ts
export const documentTaskSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  filePath: z.string().min(1),
  fileName: z.string().min(1),
  templateId: z.string().min(1),
  source: documentSourceSchema,
  status: documentTaskStatusSchema,
  typeKey: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  error: z.string().nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const unifiedTaskEntrySchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1).nullable(),
  fileName: z.string().min(1),
  templateId: z.string().min(1).nullable(),
  source: documentSourceSchema,
  status: documentTaskStatusSchema,
  typeKey: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  error: z.string().nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema,
  batchId: z.string().min(1).nullable()
})

export const documentsTasksListRoute = defineRouteContract({
  name: 'documents.tasks.list',
  input: z.object({
    status: documentTaskStatusSchema.optional(),
    source: documentSourceSchema.optional(),
    batchId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0)
  }),
  output: z.object({
    tasks: z.array(unifiedTaskEntrySchema),
    total: z.number().int().nonnegative()
  })
})

export const documentsTasksScanBatchesRoute = defineRouteContract({
  name: 'documents.tasks.scanBatches',
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0)
  }),
  output: z.object({
    batches: z.array(
      z.object({
        batchId: z.string().min(1),
        startedAt: timestampMsSchema,
        total: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative()
      })
    ),
    total: z.number().int().nonnegative()
  })
})
```

- [ ] **Step 2: routes.ts 实现**（符号搜索 `documentsTasksListRoute` 定位既有 handler，整体替换并新增 scanBatches 注册——注册顺序放在 clearFailed 之后）

```ts
[
  documentsTasksListRoute.name,
  async (rawInput) => {
    const input = documentsTasksListRoute.input.parse(rawInput)
    return documentsTasksListRoute.output.parse(repository.listUnifiedTasks(input))
  }
],
[
  documentsTasksScanBatchesRoute.name,
  async (rawInput) => {
    const input = documentsTasksScanBatchesRoute.input.parse(rawInput)
    return documentsTasksScanBatchesRoute.output.parse({
      batches: repository.listScanBatches(input.limit, input.offset),
      total: repository.countScanBatches()
    })
  }
],
```

import 行补 `documentsTasksScanBatchesRoute`（from 与其他 documents routes 同源）。

- [ ] **Step 3: 写/更新 routes 测试**（追加到 `test/main/documents/documentsRoutes.test.ts`，沿用该文件对 `createDocumentsRoutes` 的 stub 方式；repository 桩补 `listUnifiedTasks/listScanBatches/countScanBatches` 三个方法）

```ts
it('tasks.list 透传过滤参数并返回统一条目 + total', async () => {
  // 桩 repository.listUnifiedTasks 记录入参、返回 { tasks: [entry], total: 1 }
  const result = await invoke(documentsTasksListRoute.name, { source: 'scheduled', limit: 10, offset: 5 })
  expect(stub.listUnifiedTasks).toHaveBeenCalledWith({ source: 'scheduled', limit: 10, offset: 5 })
  expect(result.total).toBe(1)
})

it('tasks.scanBatches 返回批次摘要 + total', async () => {
  const result = await invoke(documentsTasksScanBatchesRoute.name, {})
  expect(stub.listScanBatches).toHaveBeenCalledWith(50, 0)
  expect(result.batches).toEqual([{ batchId: 'b1', startedAt: 1000, total: 2, done: 1, failed: 0 }])
  expect(result.total).toBe(1)
})
```

（具体桩写法以该文件既有用例风格为准——它已经 stub 了 repository 的其余方法，照抄其模式即可。）

- [ ] **Step 4: 运行确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts test/main/documents/taskManager.test.ts --config vitest.config.ts`
Expected: PASS（documentsRoutes 既有用例不得回归——尤其 tasks.create 出参新增 source 后 parse 仍通过）

- [ ] **Step 5: 格式化、lint、typecheck、Commit**

```bash
./node_modules/.bin/oxfmt src/shared/contracts/routes/documents.routes.ts src/main/documents/routes.ts test/main/documents/documentsRoutes.test.ts
./node_modules/.bin/oxlint src/shared/contracts/routes/documents.routes.ts src/main/documents/routes.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/shared/contracts/routes/documents.routes.ts src/main/documents/routes.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): paged task list ipc"
```

---

### Task 4: renderer——API client、store 任务视图、归档页任务视图 UI、i18n

**Files:**
- Modify: `src/renderer/api/DocumentsClient.ts`（listTasksPaged + listScanBatches）
- Modify: `src/renderer/src/stores/documents.ts`（任务视图 state + loadTaskList/loadScanBatches + 事件刷新）
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue`（viewMode 三段 + 任务视图模板 + 逻辑）
- Modify: `src/renderer/src/i18n/<locale>/documents.json`（全部 locale 目录，约 20 个）
- Test: renderer 组件测试以项目现有基线为准（若 DocumentsArchivePage 无既有组件测试则不强求新增，靠 typecheck:web + 主进程套件兜底；有则追加任务视图渲染用例）

**Interfaces:**
- Consumes: Task 3 契约（`documentsTasksListRoute`/`documentsTasksScanBatchesRoute` 的 zod 类型）
- Produces（页面可用能力，无外部消费方）:
  - `client.listTasksPaged(input?)`、`client.listScanBatches(input?)`
  - store：`taskList/taskTotal/taskPage/taskTotalPages/taskIsLoading/taskLoadError/taskFilter/scanBatches/loadTaskList(page)/loadScanBatches()`，`taskFilter = reactive({ source?, status?, batchId? })`
  - 页面：viewMode `'documents' | 'tasks' | 'reimbursement'`

- [ ] **Step 1: DocumentsClient 追加方法**（在 `listTasks` 附近）

```ts
listTasksPaged: (input: z.input<typeof documentsTasksListRoute.input> = {}) =>
  invokeRoute(bridge, documentsTasksListRoute.name, input),
listScanBatches: (input: z.input<typeof documentsTasksScanBatchesRoute.input> = {}) =>
  invokeRoute(bridge, documentsTasksScanBatchesRoute.name, input),
```

import 补两个 route 契约类型（与其他 documents routes 同源导入行）。

- [ ] **Step 2: store 任务视图 state**（`stores/documents.ts`，放在 archive 区块之后）

```ts
const TASK_PAGE_SIZE = 50
type UnifiedTaskItem = z.infer<typeof unifiedTaskEntrySchema>
type ScanBatchItem = z.infer<typeof documentsTasksScanBatchesRoute.output>['batches'][number]
type UnifiedSource = UnifiedTaskItem['source']

const taskList = ref<UnifiedTaskItem[]>([])
const taskTotal = ref(0)
const taskPage = ref(1)
const taskIsLoading = ref(false)
const taskLoadError = ref<string | null>(null)
const taskFilter = reactive({
  source: undefined as UnifiedSource | undefined,
  status: undefined as UnifiedTaskItem['status'] | undefined,
  batchId: undefined as string | undefined
})
const scanBatches = ref<ScanBatchItem[]>([])
const taskTotalPages = computed(() => Math.max(1, Math.ceil(taskTotal.value / TASK_PAGE_SIZE)))

let taskLoadSeq = 0
const TASK_REFRESH_DEBOUNCE_MS = 300
let taskRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTaskRefresh() {
  if (taskRefreshTimer !== null) clearTimeout(taskRefreshTimer)
  taskRefreshTimer = setTimeout(() => {
    taskRefreshTimer = null
    void loadTaskList(taskPage.value)
  }, TASK_REFRESH_DEBOUNCE_MS)
}

async function loadTaskList(page = 1, client: DocumentsClient = defaultClient) {
  const seq = ++taskLoadSeq
  taskIsLoading.value = true
  taskLoadError.value = null
  try {
    const result = await client.listTasksPaged({
      status: taskFilter.status,
      source: taskFilter.source,
      batchId: taskFilter.batchId,
      limit: TASK_PAGE_SIZE,
      offset: (page - 1) * TASK_PAGE_SIZE
    })
    if (seq !== taskLoadSeq) return
    taskList.value = result.tasks
    taskTotal.value = result.total
    taskPage.value = page
  } catch (error) {
    if (seq !== taskLoadSeq) return
    console.error('[DocumentsStore] loadTaskList failed', error)
    taskLoadError.value = 'settings.documents.tasks.loadFailed'
  } finally {
    if (seq === taskLoadSeq) taskIsLoading.value = false
  }
}

async function loadScanBatches(client: DocumentsClient = defaultClient) {
  try {
    const result = await client.listScanBatches({ limit: 200, offset: 0 })
    scanBatches.value = result.batches
  } catch (error) {
    console.error('[DocumentsStore] loadScanBatches failed', error)
  }
}

async function clearFailedTaskList(client: DocumentsClient = defaultClient) {
  const removed = await client.clearFailedTasks()
  await loadTaskList(taskPage.value, client)
  if (taskList.value.length === 0 && taskPage.value > 1) {
    await loadTaskList(taskPage.value - 1, client)
  }
  return removed
}
```

`handleTaskUpdated` 内追加一行（`scheduleArchiveRefresh()` 旁）：
```ts
if (taskList.value.length > 0 || taskPage.value > 1) {
  scheduleTaskRefresh()
}
```

store return 对象补：`taskList, taskTotal, taskPage, taskTotalPages, taskIsLoading, taskLoadError, taskFilter, scanBatches, loadTaskList, loadScanBatches, clearFailedTaskList`。
import 补 `unifiedTaskEntrySchema, documentsTasksScanBatchesRoute`（from `@shared/contracts/routes`）。

- [ ] **Step 3: 归档页任务视图**（`DocumentsArchivePage.vue`）

3a. viewMode 扩为三段：
```ts
const viewMode = ref<'documents' | 'tasks' | 'reimbursement'>('documents')
```
顶部切换按钮组复制现有「报销」按钮一段：
```html
<DcButton
  :variant="viewMode === 'tasks' ? 'default' : 'ghost'"
  size="sm"
  data-testid="archive-view-tasks"
  @click="switchToTasks"
>
  {{ t('settings.documents.tasks.title') }}
</DcButton>
```
```ts
function switchToTasks() {
  viewMode = 'tasks'  // script setup 中为 viewMode.value
  void store.loadTaskList(1)
  if (store.taskFilter.source === 'scheduled' && store.scanBatches.length === 0) {
    void store.loadScanBatches()
  }
}
```

3b. 任务视图模板（放在 documents 视图 `div` 与 reimbursement 视图之间，`v-if="viewMode === 'tasks'"`，结构与文档视图对齐）：

```html
<div v-if="viewMode === 'tasks'" class="flex min-h-0 flex-1 flex-col">
  <!-- 过滤行：来源 chip -->
  <div class="flex flex-wrap items-center gap-2 border-b px-6 py-2">
    <DcButton
      v-for="option in taskSourceOptions"
      :key="option.value ?? 'all'"
      size="sm"
      :variant="store.taskFilter.source === option.value ? 'default' : 'ghost'"
      :data-testid="`task-source-${option.value ?? 'all'}`"
      @click="onTaskSourceChange(option.value)"
    >
      {{ option.label }}
    </DcButton>
    <!-- 状态 chip：复用 statusOptions 风格，任务状态集 -->
    <DcButton
      v-for="option in taskStatusOptions"
      :key="option.value ?? 'all'"
      size="sm"
      :variant="store.taskFilter.status === option.value ? 'default' : 'ghost'"
      :data-testid="`task-status-${option.value ?? 'all'}`"
      @click="onTaskStatusChange(option.value)"
    >
      {{ option.label }}
    </DcButton>
    <!-- 扫描批次下拉：仅来源=扫描 -->
    <select
      v-if="store.taskFilter.source === 'scheduled'"
      class="h-8 rounded-md border bg-background px-2 text-sm"
      data-testid="task-batch-select"
      :value="store.taskFilter.batchId ?? ''"
      @change="onBatchChange(($event.target as HTMLSelectElement).value || undefined)"
    >
      <option value="">{{ t('settings.documents.tasks.allBatches') }}</option>
      <option v-for="b in store.scanBatches" :key="b.batchId" :value="b.batchId">
        {{ formatBatchLabel(b) }}
      </option>
    </select>
  </div>

  <!-- 统一表格 -->
  <div class="min-h-0 flex-1 overflow-auto px-6">
    <table class="w-full text-sm" data-testid="task-list-table">
      <thead class="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.tasks.colFile') }}</th>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.tasks.colSource') }}</th>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.tasks.colType') }}</th>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.tasks.colStatus') }}</th>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.archive.colCreatedAt') }}</th>
          <th class="px-2 py-2 font-medium">{{ t('settings.documents.tasks.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in store.taskList" :key="task.id" class="border-b" :data-testid="`task-row-${task.id}`">
          <td class="max-w-[240px] truncate px-2 py-2">
            <button
              v-if="task.documentId"
              class="truncate hover:underline"
              :title="task.fileName"
              data-testid="task-open-document"
              @click="openTaskDocument(task)"
            >
              {{ task.fileName }}
            </button>
            <span v-else class="truncate" :title="task.error ?? task.fileName">{{ task.fileName }}</span>
          </td>
          <td class="px-2 py-2">
            <DcBadge variant="outline">{{ taskSourceLabel(task.source) }}</DcBadge>
          </td>
          <td class="px-2 py-2 text-xs text-muted-foreground">{{ typeNameFor(task.typeKey) ?? '—' }}</td>
          <td class="px-2 py-2">
            <span class="flex items-center gap-1 text-xs">
              <Icon :icon="taskStatusIcon(task.status)" :class="task.status === 'running' ? 'animate-spin' : ''" class="size-3.5" />
              {{ taskStatusText(task.status) }}
            </span>
            <span v-if="task.error" class="block max-w-[200px] truncate text-xs text-destructive" :title="task.error">{{ task.error }}</span>
          </td>
          <td class="px-2 py-2 text-xs text-muted-foreground">{{ formatDateTime(task.createdAt) }}</td>
          <td class="px-2 py-2">
            <DropdownMenu v-if="task.status === 'failed' && task.source !== 'chat'">
              <DropdownMenuTrigger as-child>
                <DcButton variant="outline" size="sm" :data-testid="`task-retry-${task.id}`" :disabled="retryingTaskIds.has(task.id)">
                  {{ t('settings.documents.archive.taskRetry') }}
                </DcButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem :data-testid="`task-retry-auto-${task.id}`" @click="onRetryTask(task, 'auto')">
                  {{ t('settings.documents.archive.autoClassify') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-for="tpl in store.templates" :key="tpl.id" @click="onRetryTask(task, tpl.id)">
                  {{ tpl.name }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="store.taskList.length === 0 && !store.taskIsLoading" class="py-10 text-center text-sm text-muted-foreground" data-testid="task-list-empty">
      {{ t('settings.documents.tasks.empty') }}
    </p>
  </div>

  <!-- 底部：清除失败 + 分页 -->
  <div class="flex items-center justify-between border-t px-6 py-2">
    <DcButton
      v-if="taskFailedCount > 0"
      variant="outline"
      size="sm"
      data-testid="task-view-clear-failed"
      @click="onClearFailed"
    >
      {{ t('settings.documents.archive.taskClearFailed') }}
    </DcButton>
    <span v-else />
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{{ t('settings.documents.archive.totalCount', { total: store.taskTotal }) }}</span>
      <DcButton variant="outline" size="sm" :disabled="store.taskPage <= 1 || store.taskIsLoading" data-testid="task-page-prev" @click="store.loadTaskList(store.taskPage - 1)">
        {{ t('settings.documents.archive.prevPage') }}
      </DcButton>
      <span>{{ store.taskPage }} / {{ store.taskTotalPages }}</span>
      <DcButton variant="outline" size="sm" :disabled="store.taskPage >= store.taskTotalPages || store.taskIsLoading" data-testid="task-page-next" @click="store.loadTaskList(store.taskPage + 1)">
        {{ t('settings.documents.archive.nextPage') }}
      </DcButton>
    </div>
  </div>
</div>
```

3c. script 补充（复用文件内已有 `typeNameFor`/`formatDateTime`/`retryingTaskIds`/`onRetryTask` 等逻辑——若名称不同以实际为准对齐）：

```ts
const TASK_SOURCES = ['manual', 'scheduled', 'chat'] as const
const TASK_STATUSES = ['pending', 'running', 'done', 'failed'] as const

const taskSourceOptions = [
  { value: undefined, label: t('settings.documents.tasks.sourceAll') },
  ...TASK_SOURCES.map((s) => ({ value: s, label: t(`settings.documents.tasks.source_${s}`) }))
]
const taskStatusOptions = [
  { value: undefined, label: t('settings.documents.tasks.statusAll') },
  ...TASK_STATUSES.map((s) => ({ value: s, label: t(`settings.documents.tasks.status_${s}`) }))
]

function taskSourceLabel(source: string): string {
  return t(`settings.documents.tasks.source_${source}`)
}
function taskStatusIcon(status: string): string {
  if (status === 'running') return 'lucide:loader-2'
  if (status === 'done') return 'lucide:check-circle-2'
  if (status === 'failed') return 'lucide:x-circle'
  return 'lucide:clock'
}
function taskStatusText(status: string): string {
  const map: Record<string, string> = {
    running: 'settings.documents.archive.taskRunning',
    done: 'settings.documents.archive.taskDone',
    failed: 'settings.documents.archive.taskFailed',
    pending: 'settings.documents.archive.taskQueued'
  }
  return t(map[status]!)
}

const taskFailedCount = computed(() => store.taskList.filter((t) => t.status === 'failed').length)

function onTaskSourceChange(value: string | undefined) {
  store.taskFilter.source = value as 'chat' | 'manual' | 'scheduled' | undefined
  if (value !== 'scheduled') store.taskFilter.batchId = undefined
  void store.loadTaskList(1)
  if (value === 'scheduled' && store.scanBatches.length === 0) void store.loadScanBatches()
}
function onTaskStatusChange(value: string | undefined) {
  store.taskFilter.status = value as 'pending' | 'running' | 'done' | 'failed' | undefined
  void store.loadTaskList(1)
}
function onBatchChange(batchId: string | undefined) {
  store.taskFilter.batchId = batchId
  void store.loadTaskList(1)
}
function formatBatchLabel(b: { startedAt: number; total: number; failed: number }): string {
  return `${formatDateTime(b.startedAt)} · ${b.total}${b.failed > 0 ? ` · ${t('settings.documents.tasks.failedCount', { failed: b.failed })}` : ''}`
}
function openTaskDocument(task: { documentId: string | null }) {
  if (task.documentId) void openDetailById(task.documentId)  // 复用文件内已有的详情打开逻辑；名称以实际为准
}
async function onRetryTask(task: { id: string }, templateId: string) {
  retryingTaskIds.value.add(task.id)
  try {
    await store.retryRecognitionTask(task as never, { templateId })
    await store.loadTaskList(store.taskPage)
  } finally {
    retryingTaskIds.value.delete(task.id)
  }
}
async function onClearFailed() {
  clearing.value = true
  try {
    await store.clearFailedTaskList()
  } finally {
    clearing.value = false
  }
}
```

注意：`openDetail`/`retryingTaskIds`/`clearing`/`formatDateTime`/`typeNameFor` 等符号在 DocumentsArchivePage.vue 中已存在（任务条/详情弹窗在用），实现时**符号搜索对齐实际名称**，缺失的才补。`retryRecognitionTask` 的返回会更新 `store.tasks`（任务条），同时任务视图靠 `loadTaskList` 刷新当前页。

- [ ] **Step 4: i18n**（每个 locale 的 `documents.json` 的 `settings.documents` 下新增 `tasks` 节；en-US 与 zh-CN 语义如下，其余 locale 用英文文案占位保持键集合一致）

en-US:
```json
"tasks": {
  "title": "Tasks",
  "loadFailed": "Failed to load tasks",
  "empty": "No tasks",
  "allBatches": "All batches",
  "sourceAll": "All sources", "source_manual": "Upload", "source_scheduled": "Scan", "source_chat": "Chat",
  "statusAll": "All statuses", "status_pending": "Queued", "status_running": "Running", "status_done": "Done", "status_failed": "Failed",
  "colFile": "File", "colSource": "Source", "colType": "Type", "colStatus": "Status", "colActions": "Actions",
  "failedCount": "{failed} failed"
}
```
zh-CN:
```json
"tasks": {
  "title": "任务",
  "loadFailed": "任务加载失败",
  "empty": "暂无任务",
  "allBatches": "全部批次",
  "sourceAll": "全部来源", "source_manual": "手工上传", "source_scheduled": "自动扫描", "source_chat": "对话",
  "statusAll": "全部状态", "status_pending": "排队中", "status_running": "识别中", "status_done": "已完成", "status_failed": "失败",
  "colFile": "文件", "colSource": "来源", "colType": "类型", "colStatus": "状态", "colActions": "操作",
  "failedCount": "{failed} 条失败"
}
```

- [ ] **Step 5: 验证**

```bash
./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false   # OOM 则注明跳过
./node_modules/.bin/oxfmt src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue
./node_modules/.bin/oxlint src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts
```
Expected: typecheck:web exit 0（OOM 注明）；lint 0 警告；主进程 documents 套件无新失败。若 `documentTaskSchema` 加 source 后 renderer 出现 `templateId` 可空导致的既有编译错误，最小修复（如 strip 中 `task.templateId ?? undefined`），不得改变行为。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue src/renderer/src/i18n
git commit -m "feat(documents): archive tasks view"
```

---

### Task 5: 全量验证与收尾

**Files:**
- 无新文件；只读验证 + spec 状态更新

- [ ] **Step 1: 全量主进程套件**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents test/main/app --config vitest.config.ts`
Expected: 失败文件清单与既有基线一致（不落入本次改动区域）

- [ ] **Step 2: typecheck 双跑**

```bash
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false   # 必须 exit 0
./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false          # OOM 则注明跳过
```

- [ ] **Step 3: 改动文件 lint 终检**（全部改动文件过一遍 oxfmt + oxlint，0 警告）

- [ ] **Step 4: git 卫生**

`git status --porcelain` — 工作树干净（tsconfig.node.tsbuildinfo 不入库）。

- [ ] **Step 5: 人工 QA 清单（dev 实例，写进验证报告留待执行）**

1. 手工上传 2 个文件 → 任务视图出现 2 条 manual 条目，状态随识别进度实时刷新（running→done）
2. 自动扫描目录放入新文件 → 下轮扫描后任务视图出现 scheduled 条目；批次下拉出现新批次（时间 + 数量）
3. chat 中解析一个文件 → 任务视图出现 chat 条目（来源=对话、状态=已完成），点文件名可打开文档详情
4. 失败任务行重试（换模板）→ 状态回排队中并重新识别；清除失败后条目消失、分页 total 减少
5. 来源/状态过滤组合 + 翻页 → 结果正确、翻页不重不漏；混排模式下三来源按时间倒序交织
6. 现有文档视图 / 报销视图 / 任务条（归档页顶部）行为不回归

- [ ] **Step 6: spec 状态更新 + Commit**

将 `docs/superpowers/specs/2026-10-13-unified-task-list-design.md` 头部「状态」改为「已实施」。

```bash
git add docs/superpowers/specs/2026-10-13-unified-task-list-design.md
git commit -m "docs(documents): mark unified tasks spec done"
```
