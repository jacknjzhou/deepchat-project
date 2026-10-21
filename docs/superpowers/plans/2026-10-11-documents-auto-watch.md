# Documents 目录自动识别（Auto Watch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「智能信息提取」新增指定目录的定时自动识别：按小时间隔扫描、后缀过滤、路径+mtime 去重、每轮限量提交（自动分类），失败不自动重试。

**Architecture:** 主进程常驻 `AutoWatchScheduler`（分钟 tick 对齐小时间隔）读取 settings 键 `documents.autoWatch`，扫描目录后经既有 `RecognitionTaskManager` 队列提交（`source:'scheduled'`、`templateId` 缺省走 extractor 内部 `'auto'` 自动分类）；已处理文件记录在 sqlite 新表 `documents_watched_files`。设置页新增「自动识别」卡片经现有 `configClient.getSetting/setSetting` 通道读写。

**Tech Stack:** Electron 主进程 / Vue 3 + TS / better-sqlite3-multiple-ciphers / zod 契约 / Vitest（sqlite 用例需 ELECTRON_RUN_AS_NODE=1 + Electron 运行）。

**Spec:** `docs/superpowers/specs/2026-10-11-documents-auto-watch-design.md`

**关键背景（实现者必读）：**

- extractor 自动分类约定：`DocumentExtractor.extract()` 的 `input.templateId === 'auto'` 时走自动分类（`src/main/documents/extractor/documentExtractor.ts:91-118`）。因此本功能**不是省略 templateId**，而是约定值 `'auto'`：契约层 `templateId` 改 optional，taskManager 在缺省时补 `'auto'`。
- `document_tasks.source` 列有 `CHECK(source IN ('chat','manual'))`（`src/main/documents/data/tables/documentTasks.ts:51`）。SQLite 修改 CHECK 必须重建表 → 该表 v2 迁移。重建时**去掉 source 的 CHECK**（zod 契约已校验 source，DB 层去约束避免未来再迁移）；status 的 CHECK 保留。
- 表类样板：`BaseTable`（构造传 `db, tableName`），实现 `getCreateTableSQL()`（可多条语句）/`getLatestVersion()`/`getMigrationSQL(version)`。参考 `src/main/documents/data/tables/documentTasks.ts`。
- 表注册：`src/main/documents/data/database.ts` 的 `DocumentsDatabase` 用 getter 注册。
- 装配点：`src/main/app/composition.ts` L3129 创建 `RecognitionTaskManager`，L3144 `createDocumentsRoutes(...)`，L3152 `void recognitionTaskManager.resumePending()` —— scheduler 在其后创建并 `start()`。进程退出即止，无需显式 dispose（保留 `stop()` 供测试）。
- 渲染端设置页读写通道：`configClient.getSetting/setSetting`（参考 `src/renderer/settings/components/DocumentsModelsSettings.vue:308-337`）。
- 测试运行方式：纯逻辑/组件测试用 `pnpm exec vitest run <files>`；涉及 better-sqlite3 的主进程测试必须 `powershell: $env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`。PowerShell 5 不支持 `&&`（用 `;`）。
- 代码风格：Oxfmt——单引号、无分号、100 列。Commit 用 Conventional Commits ≤50 字符。
- Edit 工具在本仓库偶发 NUL/截断损坏：每次编辑后 `git diff` 核验。

---

### Task 1: DB 层——watched_files 新表 + document_tasks v2 迁移 + repository 方法

**Files:**
- Create: `src/main/documents/data/tables/watchedFiles.ts`
- Modify: `src/main/documents/data/tables/documentTasks.ts`（版本 2 迁移 + 新表 SQL 去 source CHECK）
- Modify: `src/main/documents/data/database.ts`（注册 getter）
- Modify: `src/main/documents/repository.ts`（两个方法）
- Test: `test/main/documents/documentsTables.test.ts`（无则新建；sqlite 套件）

- [ ] **Step 1: 先读样板文件对齐 API**

Read `src/main/documents/data/tables/documentTasks.ts` 全文与 `src/main/documents/data/baseTable.ts`、`src/main/documents/data/database.ts`。下方代码按已核实的 BaseTable 模式编写；若实际 API 有出入，以样板为准调整（不改变行为契约）。

- [ ] **Step 2: 写失败测试（sqlite）**

新建/扩展 `test/main/documents/documentsTables.test.ts`（镜像既有 sqlite 表测试的 setup 方式：内存库 + `exec(getCreateTableSQL())`）：

```typescript
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { WatchedFilesTable } from '@/documents/data/tables/watchedFiles'
import { DocumentTasksTable } from '@/documents/data/tables/documentTasks'

const newDb = () => new Database(':memory:')

describe('WatchedFilesTable', () => {
  it('upsert 同 path 覆盖 mtime 与 status', () => {
    const db = newDb()
    const table = new WatchedFilesTable(db)
    table.execCreateTableSQL()
    table.upsert({ path: 'D:/scan/a.pdf', mtimeMs: 100, taskId: 't1', now: 1 })
    table.upsert({ path: 'D:/scan/a.pdf', mtimeMs: 200, taskId: 't2', now: 2 })
    expect(table.listAll()).toEqual([
      { path: 'D:/scan/a.pdf', mtime_ms: 200, status: 'submitted', task_id: 't2', processed_at: 2 }
    ])
  })

  it('document_tasks v2 迁移后可写入 source=scheduled', () => {
    const db = newDb()
    const table = new DocumentTasksTable(db)
    // 模拟 v1 旧库
    db.exec(`CREATE TABLE document_tasks (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file_path TEXT NOT NULL,
      file_name TEXT NOT NULL, template_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('chat', 'manual')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
      type_key TEXT, document_id TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO document_tasks VALUES ('id1','b1','p','n','tpl','manual','done',NULL,NULL,NULL,1,1)`)
    expect(table.getLatestVersion()).toBe(2)
    table.runMigrationsFrom?.() // 若 BaseTable 有统一迁移入口则用之；否则直接：
    const sql = table.getMigrationSQL(2)
    expect(sql).not.toBeNull()
    db.exec(sql!)
    const row = db.prepare(`SELECT source FROM document_tasks WHERE id='id1'`).get() as { source: string }
    expect(row.source).toBe('manual')
    table.insert({ batchId: 'b2', filePath: 'p2', fileName: 'n2', templateId: 'auto', source: 'scheduled', now: 5 })
    expect(db.prepare(`SELECT source FROM document_tasks WHERE batch_id='b2'`).get()).toMatchObject({ source: 'scheduled' })
  })
})
```

> 若 `BaseTable` 提供统一的 `migrate()`/版本执行入口（先读样板确认），测试改调该入口而非手工 `getMigrationSQL(2)`；断言不变。

- [ ] **Step 3: 运行确认失败**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTables.test.ts --config vitest.config.ts
```
Expected: FAIL（WatchedFilesTable 不存在）

- [ ] **Step 4: 实现 watchedFiles 表类**

`src/main/documents/data/tables/watchedFiles.ts`：

```typescript
import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface WatchedFileRow {
  path: string
  mtime_ms: number
  status: string
  task_id: string
  processed_at: number
}

export interface WatchedFileUpsertInput {
  path: string
  mtimeMs: number
  taskId: string
  now?: number
}

export class WatchedFilesTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'documents_watched_files')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS documents_watched_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        task_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      )
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  listAll(): WatchedFileRow[] {
    return this.db.prepare('SELECT * FROM documents_watched_files').all() as WatchedFileRow[]
  }

  upsert(input: WatchedFileUpsertInput): void {
    this.db
      .prepare(
        `INSERT INTO documents_watched_files (path, mtime_ms, status, task_id, processed_at)
         VALUES (?, ?, 'submitted', ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms,
           status = excluded.status, task_id = excluded.task_id, processed_at = excluded.processed_at`
      )
      .run(input.path, input.mtimeMs, input.taskId, input.now ?? Date.now())
  }
}
```

- [ ] **Step 5: document_tasks v2 迁移（重建表去 source CHECK）**

`src/main/documents/data/tables/documentTasks.ts`：

1. `getCreateTableSQL()` 中 source 行改为 `source TEXT NOT NULL DEFAULT 'manual',`（去掉 CHECK；status CHECK 保留）。
2. `getLatestVersion()` 返回 `2`。
3. `getMigrationSQL(version)`：

```typescript
getMigrationSQL(version: number): string | null {
  if (version !== 2) return null
  return `
    CREATE TABLE document_tasks_v2 (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      template_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
      type_key TEXT,
      document_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO document_tasks_v2
      SELECT id, batch_id, file_path, file_name, template_id, source, status,
             type_key, document_id, error, created_at, updated_at
      FROM document_tasks;
    DROP TABLE document_tasks;
    ALTER TABLE document_tasks_v2 RENAME TO document_tasks;
    CREATE INDEX IF NOT EXISTS idx_document_tasks_status ON document_tasks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_document_tasks_created_at ON document_tasks(created_at DESC, id DESC);
  `
}
```

4. `DocumentTaskInsertInput.source` 类型改 `'chat' | 'manual' | 'scheduled'`。

- [ ] **Step 6: database.ts 注册 + repository 方法**

`database.ts` 加：

```typescript
import { WatchedFilesTable } from './tables/watchedFiles'
// class 内：
get watchedFilesTable(): WatchedFilesTable {
  return new WatchedFilesTable(this.getDatabase())
}
```

`repository.ts`（构造已持有 DocumentsDatabase；方法加在类尾部，命名对齐现有风格）：

```typescript
listWatchedFiles(): WatchedFileRow[] {
  return this.database.watchedFilesTable.listAll()
}

upsertWatchedFile(input: { path: string; mtimeMs: number; taskId: string; now?: number }): void {
  this.database.watchedFilesTable.upsert(input)
}
```

- [ ] **Step 7: 跑测试通过 + 提交**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTables.test.ts --config vitest.config.ts
```
Expected: PASS。再跑既有 documents sqlite 相关套件确认无回归（若 v51 相关测试受 document_tasks 迁移影响，修测试而非生产代码）。

```bash
git add src/main/documents/data src/main/documents/repository.ts test/main/documents
git commit -m "feat(documents): watched files table and tasks v2"
```

---

### Task 2: 契约扩展 + 主进程路由（source/templateId/chooseDir）

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`（documentSourceSchema、tasksCreate input、新 chooseDir 路由）
- Modify: `src/main/documents/routes.ts`（chooseDir handler；复用 `reimbursementDeps.showOpenDialog`）
- Test: `test/main/documents/documentsRoutes.test.ts`

- [ ] **Step 1: 写失败测试（契约 + 路由）**

`test/main/documents/documentsRoutes.test.ts` 追加：

```typescript
describe('auto watch routes', () => {
  it('tasksCreate 接受 source=scheduled 且 templateId 可省略', async () => {
    // 沿用本文件既有 route 调用模式；taskManager.submit 为 vi.fn 注入
    await invoke(documentsTasksCreateRoute, {
      files: [{ path: 'D:/x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }],
      source: 'scheduled'
    })
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'scheduled' }))
  })

  it('chooseDir 返回选中目录；取消返回 null', async () => {
    const routes = createDocumentsRoutes(repo, extractor, taskManager, undefined, settings, {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['D:/scan'] })
    })
    const out = await invokeRoute(routes, documentAutoWatchChooseDirRoute, {})
    expect(out.dir).toBe('D:/scan')
  })
})
```

> 按本文件既有的 invoke helper / 注入模式编写（先读文件头部既有测试写法再落笔）；断言不变。

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec vitest run test/main/documents/documentsRoutes.test.ts
```
Expected: FAIL（schema 不接受 scheduled / 路由不存在）

- [ ] **Step 3: 契约修改**

`documents.routes.ts`：

1. `documentSourceSchema`：`z.enum(['chat', 'manual'])` → `z.enum(['chat', 'manual', 'scheduled'])`。
2. `documentTasksCreateRoute.input.templateId`：`z.string().min(1)` → `z.string().min(1).optional()`。
3. 新路由（放在 reimbursement 路由附近）：

```typescript
export const documentAutoWatchChooseDirRoute = defineRoute({
  name: 'documents.autoWatch.chooseDir',
  input: z.object({}).strict(),
  output: z.object({ dir: z.string().nullable() })
})
```

> 路由定义辅助函数（defineRoute/对象形状）以同文件既有路由写法为准。

- [ ] **Step 4: routes.ts handler**

`src/main/documents/routes.ts`：路由表加入（`reimbursementDeps.showOpenDialog` 已在 `createDocumentsRoutes` 参数中，直接复用）：

```typescript
[
  documentAutoWatchChooseDirRoute.name,
  async (rawInput) => {
    documentAutoWatchChooseDirRoute.input.parse(rawInput)
    const picked = await reimbursementDeps.showOpenDialog({
      properties: ['openDirectory']
    })
    const dir = picked.canceled ? null : (picked.filePaths[0] ?? null)
    return documentAutoWatchChooseDirRoute.output.parse({ dir })
  }
]
```

同时 import 该路由。注意 `createDocumentsRoutes` 的 `reimbursementDeps` 参数当前带默认值且排在最后——保持签名不变，仅在 handler 内引用。

- [ ] **Step 5: 测试通过 + 提交**

```powershell
pnpm exec vitest run test/main/documents/documentsRoutes.test.ts
```
Expected: PASS。

```bash
git add src/shared/contracts/routes/documents.routes.ts src/main/documents/routes.ts test/main/documents
git commit -m "feat(documents): scheduled source and chooseDir route"
```

---

### Task 3: taskManager 缺省 templateId → 'auto' + 任务列表显示

**Files:**
- Modify: `src/main/documents/taskManager.ts`（input 类型 + 缺省补 'auto'）
- Modify: `src/main/documents/extractor/documentExtractor.ts`（导出 `AUTO_TEMPLATE_ID = 'auto'` 常量；内部判断改用常量，行为不变）
- Modify: 渲染端任务列表模板名显示处（见 Step 3 定位指令）
- Test: `test/main/documents/documentsTaskManager.test.ts`（既有文件，无则按本 Task 新建）

- [ ] **Step 1: 写失败测试**

```typescript
it('submit 不带 templateId 时任务以 auto 模板入队并可执行成功', async () => {
  // extractor.extract mock：templateId === 'auto' 时返回自动分类结果
  const tasks = manager.submit({
    files: [{ path: 'D:/x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }],
    source: 'scheduled'
  })
  expect(repository.documentTasksTable 的写入或 get(tasks[0].id)).toMatchObject({ template_id: 'auto' })
})
```

> 依据本仓库既有 taskManager 测试的注入模式（`repository`/`extractor` fake）编写；若该测试文件不存在，参考 `test/main/documents/` 下相邻测试的 fake 结构新建。

- [ ] **Step 2: 实现**

`documentExtractor.ts`：`export const AUTO_TEMPLATE_ID = 'auto'`；内部 `input.templateId === 'auto'` 判断改用该常量。

`taskManager.ts`：

```typescript
import { AUTO_TEMPLATE_ID } from './extractor/documentExtractor'

export interface RecognitionTaskSubmitInput {
  files: Array<z.infer<typeof documentExtractFileSchema>>
  templateId?: string          // 原必填 string
  source: DocumentSource
}
// submit() 内写入任务行处：
const templateId = input.templateId ?? AUTO_TEMPLATE_ID
```

`documentsTasksCreateRoute` handler（`routes.ts`）不变（input.parse 后原样传 taskManager）。

- [ ] **Step 3: 任务列表 'auto' 模板名特判**

定位指令：`grep -rn "templateId" src/renderer/src --glob "*ask*"` 与 `grep -rn "listRecentTasks\|documentsTasksListRoute" src/renderer/src`。任务行显示模板名处，`templateId === 'auto'`（或 `AUTO_TEMPLATE_ID` 值）显示 `t('settings.documents.autoClassified')`（键在 Task 6 i18n 补齐，先用键名占位不影响 Task 3 测试——组件测试断言 i18n 键存在）。

- [ ] **Step 4: 测试通过 + 提交**

```powershell
pnpm exec vitest run test/main/documents/documentsTaskManager.test.ts
pnpm exec vitest run test/main/documents/documentsRoutes.test.ts
```
Expected: PASS。

```bash
git add src/main/documents/taskManager.ts src/main/documents/extractor/documentExtractor.ts src/renderer src/shared test
git commit -m "feat(documents): auto template default for scheduled tasks"
```

---

### Task 4: modelSettings 键 + AutoWatchScheduler + 装配

**Files:**
- Modify: `src/main/documents/modelSettings.ts`（键 + schema + 读写函数）
- Create: `src/main/documents/autoWatch.ts`
- Modify: `src/main/app/composition.ts`（装配 start）
- Test: `test/main/documents/autoWatch.test.ts`（纯 vitest，注入 fake）

- [ ] **Step 1: 写失败测试（核心行为全覆盖）**

`test/main/documents/autoWatch.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { AutoWatchScheduler, type AutoWatchConfig } from '@/documents/autoWatch'

const baseConfig: AutoWatchConfig = {
  enabled: true,
  dir: 'D:/scan',
  intervalHours: 1,
  extensions: ['.pdf', '.png'],
  roundLimit: 2
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const files = [
    { name: 'a.pdf', isFile: () => true },
    { name: 'b.pdf', isFile: () => true },
    { name: 'c.pdf', isFile: () => true },
    { name: 'note.txt', isFile: () => true }
  ]
  const deps = {
    readConfig: vi.fn(() => ({ ...baseConfig })),
    writeState: vi.fn(),
    listWatchedFiles: vi.fn(() => [] as Array<{ path: string; mtime_ms: number }>),
    upsertWatchedFile: vi.fn(),
    submit: vi.fn(() => [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
    readdir: vi.fn(async () => files),
    stat: vi.fn(async (p: string) => ({ mtimeMs: 111 })),
    join: (dir: string, name: string) => `${dir}/${name}`,
    now: vi.fn(() => 1_000_000)
  }
  Object.assign(deps, overrides)
  return deps
}

describe('AutoWatchScheduler.runOnce', () => {
  it('首轮全量识别、按后缀过滤、限量提交', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit).toHaveBeenCalledTimes(1)
    const arg = deps.submit.mock.calls[0][0]
    expect(arg.source).toBe('scheduled')
    expect(arg.files).toHaveLength(2) // roundLimit=2，txt 被过滤
    expect(arg.files[0].mimeType).toBe('application/pdf')
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(2)
  })

  it('path+mtime 均相同跳过；mtime 变化重识别', async () => {
    const deps = makeDeps({
      listWatchedFiles: vi.fn(() => [
        { path: 'D:/scan/a.pdf', mtime_ms: 111 },
        { path: 'D:/scan/b.pdf', mtime_ms: 999 } // 变化
      ])
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const submitted = deps.submit.mock.calls[0][0].files.map((f: { name: string }) => f.name)
    expect(submitted).toEqual(['b.pdf', 'c.pdf'])
  })

  it('目录异常写 lastError 且不提交', async () => {
    const deps = makeDeps({ readdir: vi.fn(async () => { throw new Error('ENOENT') }) })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.writeState).toHaveBeenCalledWith(expect.objectContaining({ lastError: expect.stringContaining('ENOENT') }))
  })

  it('enabled=false 或 dir 空直接跳过', async () => {
    const deps = makeDeps({ readConfig: vi.fn(() => ({ ...baseConfig, enabled: false })) })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.readdir).not.toHaveBeenCalled()
  })

  it('后缀大小写不敏感', async () => {
    const deps = makeDeps({ readdir: vi.fn(async () => [{ name: 'A.PDF', isFile: () => true }]) })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit.mock.calls[0][0].files).toHaveLength(1)
  })
})

describe('nextRunAt', () => {
  it('每轮结束按 intervalHours 顺延', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(s.getNextRunAt()).toBe(1_000_000 + 3_600_000)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec vitest run test/main/documents/autoWatch.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: modelSettings 键与读写函数**

`src/main/documents/modelSettings.ts`（沿用现有键定义与 sanitize 模式）：

```typescript
export interface DocumentsAutoWatchConfig {
  enabled: boolean
  dir: string
  intervalHours: number
  extensions: string[]
  roundLimit: number
}

export const DOCUMENTS_AUTO_WATCH_DEFAULT: DocumentsAutoWatchConfig = {
  enabled: false,
  dir: '',
  intervalHours: 1,
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],
  roundLimit: 20
}

export const DOCUMENTS_AUTO_WATCH_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']

export interface DocumentsAutoWatchState {
  lastRunAt: number | null
  lastError: string | null
}

const isFiniteInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export function readAutoWatchConfig(store: DocumentsSettingsStore): DocumentsAutoWatchConfig {
  const raw = store.get<Record<string, unknown>>('documents.autoWatch')
  if (!raw || typeof raw !== 'object') return { ...DOCUMENTS_AUTO_WATCH_DEFAULT }
  const r = raw as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    dir: typeof r.dir === 'string' ? r.dir : '',
    intervalHours: isFiniteInt(r.intervalHours, 1, 72) ? r.intervalHours : 1,
    extensions:
      Array.isArray(r.extensions) &&
      r.extensions.length > 0 &&
      r.extensions.every((e) => typeof e === 'string' && /^\.[A-Za-z0-9]+$/.test(e))
        ? (r.extensions as string[])
        : [...DOCUMENTS_AUTO_WATCH_DEFAULT.extensions],
    roundLimit: isFiniteInt(r.roundLimit, 1, 20) ? r.roundLimit : 20
  }
}

export function readAutoWatchState(store: DocumentsSettingsStore): DocumentsAutoWatchState {
  const raw = store.get<Record<string, unknown>>('documents.autoWatchState')
  if (!raw || typeof raw !== 'object') return { lastRunAt: null, lastError: null }
  const r = raw as Record<string, unknown>
  return {
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null
  }
}
```

> 键名常量若现有 `DOCUMENTS_SETTINGS_KEYS` 是集中定义，则在其中追加 `autoWatch: 'documents.autoWatch'` / `autoWatchState: 'documents.autoWatchState'` 并使用常量。

- [ ] **Step 4: AutoWatchScheduler 实现**

`src/main/documents/autoWatch.ts`：

```typescript
import path from 'node:path'
import { AUTO_TEMPLATE_ID } from './extractor/documentExtractor'
import type { DocumentsAutoWatchConfig, DocumentsAutoWatchState } from './modelSettings'

const HOUR_MS = 3_600_000
const TICK_MS = 60_000

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export interface AutoWatchDeps {
  readConfig: () => DocumentsAutoWatchConfig
  writeState: (state: DocumentsAutoWatchState) => void
  listWatchedFiles: () => Array<{ path: string; mtime_ms: number }>
  upsertWatchedFile: (input: { path: string; mtimeMs: number; taskId: string; now: number }) => void
  submit: (input: {
    files: Array<{ path: string; name: string; mimeType: string }>
    source: 'scheduled'
  }) => Array<{ id: string }>
  readdir: (dir: string, options: { withFileTypes: true }) => Promise<Array<{ name: string; isFile: () => boolean }>>
  stat: (p: string) => Promise<{ mtimeMs: number }>
  now?: () => number
}

export class AutoWatchScheduler {
  private nextRunAt: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AutoWatchDeps) {
    this.nextRunAt = (deps.now ?? Date.now)()
  }

  getNextRunAt(): number {
    return this.nextRunAt
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if ((this.deps.now ?? Date.now)() >= this.nextRunAt) void this.runOnce()
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<void> {
    const now = this.deps.now ?? Date.now
    this.nextRunAt = now() + this.readIntervalHours() * HOUR_MS
    const config = this.deps.readConfig()
    if (!config.enabled || config.dir === '') return
    let lastError: string | null = null
    try {
      const entries = await this.deps.readdir(config.dir, { withFileTypes: true })
      const extSet = new Set(config.extensions.map((e) => e.toLowerCase()))
      const candidates = entries
        .filter((e) => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
        .map((e) => path.join(config.dir, e.name))
        .sort()
      const watched = new Map(this.deps.listWatchedFiles().map((w) => [w.path, w.mtime_ms]))
      const pending: string[] = []
      for (const p of candidates) {
        const mtimeMs = (await this.deps.stat(p)).mtimeMs
        if (watched.get(p) === mtimeMs) continue
        pending.push(p)
      }
      const batch = pending.slice(0, config.roundLimit)
      if (batch.length > 0) {
        const stats = await Promise.all(
          batch.map(async (p) => ({ p, mtimeMs: (await this.deps.stat(p)).mtimeMs }))
        )
        const tasks = this.deps.submit({
          files: stats.map(({ p }) => ({
            path: p,
            name: path.basename(p),
            mimeType: MIME_BY_EXTENSION[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
          })),
          source: 'scheduled'
        })
        stats.forEach(({ p, mtimeMs }, i) =>
          this.deps.upsertWatchedFile({
            path: p,
            mtimeMs,
            taskId: tasks[i]?.id ?? AUTO_TEMPLATE_ID,
            now: now()
          })
        )
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    this.deps.writeState({ lastRunAt: now(), lastError })
  }

  private readIntervalHours(): number {
    const config = this.deps.readConfig()
    return config.intervalHours
  }
}
```

> 细节裁定权：`taskId` 兜底值、`stat` 双调合并等微实现可在不破坏测试断言前提下精简（如 batch 与 stat 一次循环完成）；但「path+mtime 相同跳过」「限量」「后缀大小写不敏感」「异常写 lastError」「nextRunAt 顺延」五个行为契约必须保持。

- [ ] **Step 5: composition 装配**

`src/main/app/composition.ts`，`void recognitionTaskManager.resumePending()`（L3152）之后：

```typescript
const autoWatchDeps = {
  readConfig: () => readAutoWatchConfig(providerSettings),
  writeState: (state) => providerSettings.set('documents.autoWatchState', state),
  listWatchedFiles: () => documentsRepository.listWatchedFiles(),
  upsertWatchedFile: (input) => documentsRepository.upsertWatchedFile(input),
  submit: (input) =>
    recognitionTaskManager.submit({
      files: input.files,
      source: input.source
    }),
  readdir: (dir, options) => fsp.readdir(dir, options),
  stat: (p) => fsp.stat(p)
}
const autoWatchScheduler = new AutoWatchScheduler(autoWatchDeps)
autoWatchScheduler.start()
```

> `providerSettings` 的 set 方法名以 composition 内既有 settings 写入用法为准（`grep -n "providerSettings.set" src/main/app/composition.ts | head`）。scheduler 不需要 dispose（进程退出即止）。

- [ ] **Step 6: 测试通过 + typecheck:node + 提交**

```powershell
pnpm exec vitest run test/main/documents/autoWatch.test.ts
pnpm run typecheck:node
```
Expected: PASS / 无类型错误。

```bash
git add src/main/documents/modelSettings.ts src/main/documents/autoWatch.ts src/main/app/composition.ts test/main/documents
git commit -m "feat(documents): auto watch scheduler"
```

---

### Task 5: 渲染端——DocumentsClient 方法 + 设置页「自动识别」卡片

**Files:**
- Modify: 渲染端 DocumentsClient（定位：`grep -rn "documentsTasks" src/renderer/src/api` 的文件）
- Modify: `src/renderer/settings/components/DocumentsModelsSettings.vue`（新卡片区块）
- Test: 该设置页组件的既有测试文件（定位：`grep -rln "DocumentsModelsSettings" test/renderer`）

- [ ] **Step 1: DocumentsClient 加方法**

```typescript
async chooseAutoWatchDir(): Promise<string | null> {
  const out = await this.invoke('documents.autoWatch.chooseDir', {})
  return out.dir
}
```

> `invoke` 封装名以该文件现有方法为准（先读文件）；与其它 documents 路由调用方式一致。

- [ ] **Step 2: 设置页卡片（组件测试先行）**

在既有组件测试文件追加（沿用现有 mount/存根模式）：

```typescript
it('auto watch 卡片：加载配置、勾选后缀、保存写入 documents.autoWatch', async () => {
  // arrange: configClient.getSetting mock 返回 enabled/dir/extensions 等
  // act: mount → 修改开关/间隔/上限 → 点保存
  // assert: setSetting 以 ('documents.autoWatch', { enabled, dir, intervalHours, extensions, roundLimit }) 调用
})
it('启用但未选目录时保存被阻止并提示', async () => { /* assert: setSetting 未被调用 */ })
it('选择目录按钮经 chooseAutoWatchDir 返回路径并回填', async () => { /* mock client 方法 */ })
it('状态行显示 lastError（红色）与上次扫描时间', async () => { /* getSetting documents.autoWatchState */ })
```

- [ ] **Step 3: 实现卡片**

`DocumentsModelsSettings.vue` 在模型/并发区块之后追加「自动识别」卡片，仅用现有原语（DcButton/DcSwitch/DcInput 或页面已用组件 + Tailwind class），布局：

```
┌ 自动识别 ────────────────────────────────────────────┐
│ [开关] 监控目录: D:\scan            [选择目录…]      │
│ 扫描间隔(小时): [1]   每轮上限: [20]                  │
│ 识别后缀: [x]pdf [x]png [x]jpg [x]jpeg [ ]webp [ ]gif│
│ 上次扫描: 2026-10-11 10:00  （错误信息红字，如有）    │
└──────────────────────────────────────────────────────┘
```

要点：

- 加载时 `getSetting('documents.autoWatch')` + `getSetting('documents.autoWatchState')`（空值回落 `DOCUMENTS_AUTO_WATCH_DEFAULT` 镜像值——渲染端定义同一份默认常量，或从 shared 导入若 modelSettings 逻辑可共享；主进程 `modelSettings.ts` 在 `src/main`，不可直接 import → 在 `src/shared/documents.ts` 放默认值与类型，主进程与渲染端共用）。
- 勾选后缀候选 = `DOCUMENTS_AUTO_WATCH_EXTENSIONS`（同上放 shared）。
- 保存：启用校验 `dir !== ''`，失败不写配置并提示；成功 `setSetting('documents.autoWatch', {...})`。
- 后缀、间隔、上限的取值范围与 Task 4 sanitize 一致（1–72 小时、1–20、后缀格式 `^\.[A-Za-z0-9]+$`）。
- 文案 i18n 键（Task 6 翻译，先建键）：
  - `settings.documents.autoWatch.title`
  - `settings.documents.autoWatch.enable`
  - `settings.documents.autoWatch.dir`
  - `settings.documents.autoWatch.chooseDir`
  - `settings.documents.autoWatch.intervalHours`
  - `settings.documents.autoWatch.roundLimit`
  - `settings.documents.autoWatch.extensions`
  - `settings.documents.autoWatch.lastRun`
  - `settings.documents.autoWatch.needDir`
  - `settings.documents.autoClassified`
- `shared/documents.ts` 增加：

```typescript
export interface DocumentsAutoWatchConfig {
  enabled: boolean
  dir: string
  intervalHours: number
  extensions: string[]
  roundLimit: number
}
export const DOCUMENTS_AUTO_WATCH_DEFAULT: DocumentsAutoWatchConfig = {
  enabled: false,
  dir: '',
  intervalHours: 1,
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],
  roundLimit: 20
}
export const DOCUMENTS_AUTO_WATCH_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']
```

主进程 `modelSettings.ts` 改为从 shared 复用类型与默认值（删除 Task 4 中的本地定义，保留读写函数）。

- [ ] **Step 4: 测试通过 + 提交**

```powershell
pnpm exec vitest run test/renderer/<该设置页测试文件>
pnpm run typecheck:web
```
Expected: PASS / 无类型错误。

```bash
git add src/renderer src/shared/documents.ts src/main/documents/modelSettings.ts test/renderer
git commit -m "feat(documents): auto watch settings card"
```

---

### Task 6: i18n（20 locale）+ 全量回归

**Files:**
- Modify: 20 个 locale 文件中 documents 相关分组（定位：`grep -rln "settings-documents\|documents.reimbursement" src/renderer/src/locales` —— 以现有 documents 键所在 locale 文件为准）
- Test: i18n 校验脚本 + 全量回归

- [ ] **Step 1: 翻译 9 个键 × 20 locale**

键（Task 5 列出的 9 个）：`title / enable / dir / chooseDir / intervalHours / roundLimit / extensions / lastRun / needDir`，加 Task 3 的 `settings.documents.autoClassified`，共 10 键。

zh-CN 参考译文（其余 locale 按同一语义翻译，术语对齐各 locale 既有 documents 词条）：

```json
{
  "autoWatch.title": "自动识别",
  "autoWatch.enable": "启用目录自动识别",
  "autoWatch.dir": "监控目录",
  "autoWatch.chooseDir": "选择目录…",
  "autoWatch.intervalHours": "扫描间隔（小时）",
  "autoWatch.roundLimit": "每轮提交上限",
  "autoWatch.extensions": "识别后缀",
  "autoWatch.lastRun": "上次扫描",
  "autoWatch.needDir": "启用前请先选择监控目录",
  "autoClassified": "自动分类"
}
```

en-US 参考译文：`Automatic recognition` / `Enable directory auto recognition` / `Watched directory` / `Choose directory…` / `Scan interval (hours)` / `Per-round submission limit` / `File extensions` / `Last scan` / `Choose a watched directory before enabling` / `Auto classification`。

- [ ] **Step 2: i18n 校验 + 全量回归**

```powershell
pnpm run i18n:validate
pnpm exec vitest run test/main/documents
pnpm exec vitest run test/renderer --silent   # 若大套件 segfault 则分批（见 memory 教训）
pnpm run typecheck:web ; pnpm run typecheck:node
pnpm run format ; pnpm run lint
```

Expected: 全绿（既有基线失败按 memory 教训对比失败文件清单，不引入新失败）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/locales
git commit -m "i18n: documents auto watch keys"
```

---

## 自审记录（writing-plans Self-Review）

- **Spec 覆盖**：调度器（Task 4）、配置键（Task 4/5）、v52 新表（Task 1）、契约扩展（Task 2）、自动分类透传（Task 3）、UI 卡片（Task 5）、i18n（Task 6）——全覆盖。spec 的「应用重启续扫」由 nextRunAt 基于 now 计算 + tick 每分钟实现（Task 4）。
- **占位符**：无 TBD；三处「以既有写法为准」均为对齐既有测试 helper / 路由辅助函数 / settings set 方法名，属于既有模式引用而非行为未定，且都给了 grep 定位指令与断言契约。
- **类型一致性**：`WatchedFileRow`/`WatchedFileUpsertInput`（Task 1）与 scheduler deps（Task 4）签名一致；`DocumentsAutoWatchConfig` 在 Task 4 定义、Task 5 移到 shared 并由主进程复用（plan 内已注明移动）；`AUTO_TEMPLATE_ID` Task 3 定义、Task 4 引用，顺序正确（Task 3 先于 Task 4 执行）。
- **对 spec 的一处修正**：spec 写「templateId 改 optional——不传时走自动分类」；实际实现为「缺省时补约定值 `'auto'`」（extractor 既有约定，`documentExtractor.ts:91-118`）。语义一致，实现更贴合代码库现状，已写进计划头部关键背景。
- **对 spec 的补充**：`document_tasks.source` CHECK 约束需 v2 迁移重建表（spec 未预见，Task 1 Step 5 处理）。

---

## As-built（2026-10-11 实施记录）

**状态**：6 Task 全部完成，每 Task 通过 spec + 质量双审（质量审查 3 次 Needs fixes 均已修复并复审 Approve），最终整体终审 **Ready to merge**。

**提交链**（本功能 14 个实现提交 + 2 个文档提交，分支 `20261009classifier-docs-content`）：

| Commit | 内容 |
| --- | --- |
| `77a9fbdc` | spec 文档 |
| `a3d8d751` | plan 文档 |
| `2854bff9` | Task 1：documents_watched_files 表 + document_tasks v2 迁移 + repository 方法 |
| `380df2b3` | Task 1 补：schema catalog 注册 + DocumentsDatabase bootstrap ensureMigrated（生产可达性） |
| `5563cfb1` | Task 1 审查修复：迁移脚本内聚事务 + DDL 匹配改正则 + 注释 |
| `196ca334` | Task 2：DOCUMENT_SOURCES 加 'scheduled' + templateId optional + chooseDir 路由 |
| `63abff69` | Task 3：documents 表 v2 迁移（去 source CHECK，13 列重建） |
| `59edc6ab` | Task 3：AUTO_TEMPLATE_ID 常量 + taskManager 缺省归一化 |
| `dbcd3026` | Task 3：端口类型加宽 + cast 清理 + 契约微调 |
| `bddc0fd4` | Task 3 审查修复：sourceScheduled × 20 locale + 迁移 SQL 显式列清单 |
| `5a9fa077` | Task 4：shared autoWatch 类型 + readAutoWatchConfig/State + AutoWatchScheduler |
| `9ddfdebd` | Task 4：composition 装配（resumePending 后 start） |
| `23714e37` | Task 4 审查修复：destroy 序列 stop + per-file stat 容错 + 硬失败语义 + start/stop 测试 |
| `1013d9b9` | Task 5：设置页「自动识别」卡片 + DocumentsClient.chooseAutoWatchDir + config 白名单联动 |
| `0465f6fb` | Task 5：i18n 10 键 × 20 locale |
| `62eb83b5` | Task 5 审查修复：locked 态 disabled + 边界常量互指注释 + sanitize 注释修正 |

**验证**：主进程 documents 套件 17 文件 291 用例全绿（Electron + ELECTRON_RUN_AS_NODE）；渲染端相关 152 用例全绿；`pnpm run i18n` 20 locale 全过；lint 0 警告；typecheck 双端通过。

**实现中相对 plan 的关键偏差（均已审查确认合理）**：

1. **迁移触发机制**：plan 假设 catalog 迁移循环可达 v2，实际全局 `schema_versions` 高水位使其不可达 → 改为 `DocumentsDatabase` 构造函数事务内 `ensureMigrated()`（DDL 文本检测 `CHECK(source IN`，重建后天然幂等），documents 与 document_tasks 两表同法。
2. **Windows 路径归一化**：plan 的去重比较在 Windows 上因 `path.join` 反斜杠失效 → 两侧 `path.normalize` 归一化。
3. **config 白名单联动**（Task 5 必要偏离）：渲染端 getSetting/setSetting 走 config 契约白名单，新增键必须同步 `CONFIG_ENTRY_KEYS`/ValuesSchema/ChangeSchema + settingsRoutes `read()`，否则配置读不回。
4. **i18n 键命名**：归入既有 `documents.archive` 段（`autoWatchTitle` 等 10 键，含额外 `autoWatchInvalidExtensions`）；任务列表 'auto' 显示复用既有键 `taskClassifying`/`autoClassify`（DocumentTaskStrip 已有特判），未新建 autoClassified。
5. **重启策略**：实现为启动即到期（≤1 分钟跑首轮）而非「从 lastRunAt 重算」，去重表保证安全，行为等效。
6. **documents 表迁移**（Task 3 计划外）：scheduled 归档硬前提（taskManager 透传任务 source 到 insertDocument），镜像 document_tasks 方案。
7. **提交信息记录**：`380df2b3` 52 字符超 ≤50 约定（reword 成本 > 收益，未整改）；`dbcd3026` 范围混杂（拆分成本 > 收益，保留）。

**非阻塞遗留（后续迭代候选）**：

1. `watched_files.status` 列恒 'submitted'（状态扩展位，当前死重）
2. autoWatchState 无实时刷新推送（重进设置页可见新状态）
3. chooseDir 复用 `reimbursementDeps.showOpenDialog` 端口（命名失真，可改 dialogDeps）
4. 路径去重未做大小写折叠（Windows 重选同目录不同大小写会全量重识别一轮）
5. `ConfigEntryChangeSchema` 的 autoWatchState 成员渲染端无写入者

