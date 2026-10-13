# 任务视图「文件相对路径」列实施计划（提交时落库）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动扫描识别阶段计算文件相对扫描目录的层级路径，落库 `document_tasks.relative_path`，任务视图新增一列展示。

**Architecture:** autoWatch 扫描时用纯函数 `computeRelativePath` 对 `config.dir` 相对化，经 submit 链透传落库（快照语义，多发票产物回溯源文件路径）；repository/契约原样透传；启动时对存量 NULL 行幂等回填；renderer 表格加一列。

**Tech Stack:** Electron main (TypeScript, better-sqlite3-multiple-ciphers, Vitest) + Vue3 renderer + zod 契约。

**Spec:** `docs/superpowers/specs/2026-10-13-task-relative-path-design.md`

## Global Constraints

- 本机 pnpm exec/run shim 损坏：直接调 node_modules 下二进制
  - 主进程测试：`ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`
  - typecheck:node：`./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` 必须 exit 0（会触碰 tsconfig.node.tsbuildinfo，勿提交）
  - typecheck:web：`./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false`（OOM errno 1455/134 重试一次，仍 OOM 注明跳过）
  - lint：`./node_modules/.bin/oxfmt <files>`、`./node_modules/.bin/oxlint <files>`（单引号/无分号/100 列），仅改动文件，0 警告（仓库级 .oxlintrc.json 忽略 test/** 属正常）
- Edit 工具在本机有损坏文件尾部的前科：每次编辑后读回编辑区域与文件尾部确认完整性
- 提交信息 Conventional Commits ≤50 字符；勿提交 tsconfig.node.tsbuildinfo
- **迁移纪律**：`document_tasks` 不在主 schema_versions 迁移循环内（表内注释已说明 version 2 永远够不到）。新列不得走 getLatestVersion 版本升级路径——`getCreateTableSQL()` + `getMigrationSQL(2)` 重建 DDL 同步加列（重建与新建一致）+ `ensureMigrated()` 末尾幂等 `PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`；不 bump getLatestVersion
- 计算语义（纯函数，逐字）：`path.relative(path.normalize(scanDir), path.normalize(filePath))`，结果为空串 / 以 `..` 开头 / 仍是绝对路径（跨盘符）→ `null`；否则 `replace(/\\/g, '/')`
- 全仓 test:main 有 ~98 既有环境性失败基线（rendererPerformanceLogService、sessionDataMigrations 两文件等）；documents 套件当前全绿，不得回归
- 测试导入别名用 `@/documents/...`；`documentsTables.test.ts` 用顶部条件加载的 `*Ctor` 常量与 `describeIfSqlite` 守卫，新用例一律追加进既有 describe

---

### Task 1: relative_path 落库链路（表层列 + repository 类型透传）

**Files:**
- Modify: `src/main/documents/data/tables/documentTasks.ts`
- Modify: `src/main/documents/repository.ts`
- Test: `test/main/documents/documentsTables.test.ts`（追加用例）
- Test: `test/main/documents/documentsRepository.test.ts`（追加用例）

**Interfaces:**
- Produces（后续任务依赖）:
  - `DocumentTaskInsertInput` 增 `relativePath?: string | null`
  - `DocumentTaskRow` 增 `relative_path: string | null`；`DocumentTask` 增 `relativePath: string | null`
  - `DocumentRepositoryTaskPort.insertTasks` 输入项增 `relativePath?: string | null`
  - `UnifiedTaskEntry` 增 `relativePath: string | null`（chat 条目恒 null）
  - `DocumentTasksTable.listScheduledWithoutRelativePath(): DocumentTaskRow[]`、`updateRelativePath(id: string, relativePath: string): void`（Task 3 消费）

- [ ] **Step 1: 写失败测试（documentsTables.test.ts）**

在既有 `describeIfSqlite('documentTasksTable', ...)` 块内追加（复用该 describe 内已有的表实例构造方式；若块内用 `new DocumentTasksTableCtor(db)` 局部变量，沿用其命名）：

```ts
it('insert 带 relativePath 落库，缺省为 null', () => {
  const db = new DatabaseCtor(':memory:')
  const table = new DocumentTasksTableCtor(db)
  const withRel = table.insert({
    batchId: 'b1', filePath: 'D:\\scan\\sub\\a.pdf', fileName: 'a.pdf',
    templateId: 'auto', source: 'scheduled', relativePath: 'sub/a.pdf'
  })
  expect(withRel.relative_path).toBe('sub/a.pdf')
  const withoutRel = table.insert({
    batchId: 'b1', filePath: 'C:\\tmp\\b.pdf', fileName: 'b.pdf', templateId: 'auto'
  })
  expect(withoutRel.relative_path).toBeNull()
})

it('ensureMigrated 为存量库补 relative_path 列且数据保留', () => {
  const db = new DatabaseCtor(':memory:')
  // 旧版 DDL：无 relative_path 的 v2 形态（无 source CHECK）
  db.exec(`CREATE TABLE document_tasks (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file_path TEXT NOT NULL,
    file_name TEXT NOT NULL, template_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
    type_key TEXT, document_id TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO document_tasks VALUES ('id1','b1','p','n','tpl','scheduled','done',NULL,NULL,NULL,1,1)`)
  const table = new DocumentTasksTableCtor(db)
  table.ensureMigrated()
  const row = table.get('id1')!
  expect(row.relative_path).toBeNull()
  expect(row.file_path).toBe('p')
})
```

在 `describeIfSqlite('documentsRepository.test' 对应的 repository describe)`（文件内 `DocumentsRepository file dedupe` 同级，新建 `describeIfSqlite('DocumentsRepository relative path', ...)`）追加：

```ts
it('insertTasks 透传 relativePath，listUnifiedTasks 条目携带；chat 条目恒 null', () => {
  const { repository } = makeRepo()
  const [task] = repository.insertTasks([
    { batchId: 'b1', filePath: 'D:\\scan\\s\\a.pdf', fileName: 'a.pdf', templateId: 'auto', source: 'scheduled', relativePath: 's/a.pdf' }
  ])
  expect(task.relativePath).toBe('s/a.pdf')
  const { tasks } = repository.listUnifiedTasks({ limit: 50, offset: 0 })
  const entry = tasks.find((t) => t.id === task.id)
  expect(entry?.relativePath).toBe('s/a.pdf')
})
```

（makeRepo/insertDocument 的既有桩形态以文件实际为准对齐；如需 chat 条目对照，可按文件内既有 chat 文档插入辅助补一条断言 `relativePath === null`，若无现成辅助则省略该断言、由 toChatTaskEntry 恒 null 的类型保证覆盖。）

- [ ] **Step 2: 确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTables.test.ts test/main/documents/documentsRepository.test.ts --config vitest.config.ts`

Expected: 新用例 FAIL（relative_path 列不存在 / 类型错误），既有用例全绿。

- [ ] **Step 3: 实现 documentTasks.ts**

1. `DocumentTaskRow` 增 `relative_path: string | null`（置于 `updated_at` 后）。
2. `DocumentTaskInsertInput` 增 `relativePath?: string | null`。
3. `getCreateTableSQL()`：`updated_at INTEGER NOT NULL` 后加一行 `relative_path TEXT`（注意前一行补逗号）。
4. `getMigrationSQL(2)` 重建 DDL：`document_tasks_v2` 建表同样加 `relative_path TEXT`；`INSERT INTO ... SELECT` 列清单**不加**该列（旧表无此列，重建后全 NULL，由 Task 3 回填）。
5. `ensureMigrated()` 末尾（索引保证之后）追加：

```ts
const columns = this.db.prepare('PRAGMA table_info(document_tasks)').all() as Array<{ name: string }>
if (!columns.some((c) => c.name === 'relative_path')) {
  this.db.exec('ALTER TABLE document_tasks ADD COLUMN relative_path TEXT')
}
```

6. `insert()`：SQL 列清单与 VALUES 各加一项，`.run(...)` 在 `now, now` 后追加 `input.relativePath ?? null`。
7. 追加两个方法：

```ts
listScheduledWithoutRelativePath(): DocumentTaskRow[] {
  return this.db
    .prepare(
      "SELECT * FROM document_tasks WHERE source = 'scheduled' AND relative_path IS NULL"
    )
    .all() as DocumentTaskRow[]
}

updateRelativePath(id: string, relativePath: string): void {
  this.db
    .prepare('UPDATE document_tasks SET relative_path = ? WHERE id = ?')
    .run(relativePath, id)
}
```

- [ ] **Step 4: 实现 repository.ts**

1. `DocumentTask` 接口增 `relativePath: string | null`（`updatedAt` 后）。
2. `toTask` 增 `relativePath: row.relative_path`。
3. `UnifiedTaskEntry` 增 `relativePath: string | null`（`filePath` 后）。
4. `toUnifiedTaskEntry` 增 `relativePath: task.relativePath`；`toChatTaskEntry` 返回对象增 `relativePath: null`。
5. `insertTasks` 方法与 `DocumentRepositoryTaskPort.insertTasks` 的输入类型均增 `relativePath?: string | null`（透传给 `insertBatch`，无需改方法体）。

- [ ] **Step 5: 确认 GREEN**

Run: 同 Step 2 命令。Expected: 全部 PASS（含既有用例零回归）。

- [ ] **Step 6: 格式化 / lint / typecheck + 提交**

```bash
./node_modules/.bin/oxfmt src/main/documents/data/tables/documentTasks.ts src/main/documents/repository.ts test/main/documents/documentsTables.test.ts test/main/documents/documentsRepository.test.ts
./node_modules/.bin/oxlint src/main/documents/data/tables/documentTasks.ts src/main/documents/repository.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/data/tables/documentTasks.ts src/main/documents/repository.ts test/main/documents/documentsTables.test.ts test/main/documents/documentsRepository.test.ts
git commit -m "feat(documents): relative path column"
```

---

### Task 2: 自动扫描提交链（computeRelativePath + relativePathByPath 透传）

**Files:**
- Modify: `src/main/documents/autoWatch.ts`
- Modify: `src/main/documents/taskManager.ts`
- Test: `test/main/documents/autoWatch.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `insertTasks` 输入 `relativePath`。
- Produces:
  - `autoWatch.ts` 导出纯函数 `computeRelativePath(filePath: string, scanDir: string): string | null`（Task 3 回填复用）
  - `AutoWatchDeps.submit` 输入增 `relativePathByPath?: Record<string, string | null>`
  - `RecognitionTaskSubmitInput` 增 `relativePathByPath?: Record<string, string | null>`（composition 的 submitWithDedupe 包装器原样透传，manual/chat 不带 → null）

- [ ] **Step 1: 写失败测试（autoWatch.test.ts 追加）**

在既有 `describe('AutoWatchScheduler.runOnce', ...)` 内追加（baseConfig.dir 为 `'D:/scan'`，readdir 产出 a.pdf/b.pdf/c.pdf；路径用 `path.join(baseConfig.dir, 'a.pdf')` 构造期望值——Windows 下 readdir 桩的文件会被 `path.join(dir, name)` 拼成反斜杠路径）：

```ts
it('提交输入携带 relativePathByPath（按 config.dir 相对化）', async () => {
  const deps = makeDeps()
  const s = new AutoWatchScheduler(deps as never)
  await s.runOnce()
  const arg = deps.submit.mock.calls[0][0]
  expect(arg.relativePathByPath).toBeDefined()
  expect(arg.relativePathByPath[path.join('D:/scan', 'a.pdf')]).toBe('a.pdf')
})

it('拆分产物回溯源文件的相对路径', async () => {
  const deps = makeDeps({
    expandFiles: vi.fn(async (files: Array<{ path: string }>) => ({
      files: files.map((f) => ({
        ...f,
        path: path.join('D:/split-out', `p-${path.basename(f.path)}`)
      })),
      sourceOf: new Map([
        [path.join('D:/split-out', 'p-a.pdf'), path.join('D:/scan', 'a.pdf')]
      ])
    }))
  })
  const s = new AutoWatchScheduler(deps as never)
  await s.runOnce()
  const arg = deps.submit.mock.calls[0][0]
  expect(arg.relativePathByPath[path.join('D:/split-out', 'p-a.pdf')]).toBe('a.pdf')
})

it('computeRelativePath 语义', async () => {
  const { computeRelativePath } = await import('@/documents/autoWatch')
  expect(computeRelativePath('D:\\scan\\sub\\a.pdf', 'D:\\scan')).toBe('sub/a.pdf')
  expect(computeRelativePath('D:\\scan\\a.pdf', 'D:\\scan')).toBe('a.pdf')
  expect(computeRelativePath('D:\\other\\a.pdf', 'D:\\scan')).toBeNull()
  expect(computeRelativePath('D:\\scan\\a.pdf', '')).toBeNull()
  expect(computeRelativePath('C:\\scan\\a.pdf', 'D:\\scan')).toBeNull()
})
```

- [ ] **Step 2: 确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/autoWatch.test.ts --config vitest.config.ts`

Expected: 新用例 FAIL（computeRelativePath 未导出 / submit 输入无 relativePathByPath），既有用例全绿。

- [ ] **Step 3: 实现 autoWatch.ts**

1. 文件末尾（类外）导出纯函数：

```ts
/** 计算文件相对扫描目录的层级路径（POSIX 分隔）；不在目录下/无法相对化返回 null */
export const computeRelativePath = (filePath: string, scanDir: string): string | null => {
  if (scanDir === '') return null
  const rel = path.relative(path.normalize(scanDir), path.normalize(filePath))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}
```

2. `AutoWatchDeps.submit` 输入类型增 `relativePathByPath?: Record<string, string | null>`。
3. `runOnce` 的 `if (batch.length > 0)` 块内：`batchInputs` 构造之后、`expanded` 之前加：

```ts
const relBySource = new Map(
  batch.map((f) => [path.normalize(f.path), computeRelativePath(f.path, config.dir)])
)
```

4. `expanded` 之后、`submit` 调用前构造映射并随输入传入（产物回溯源文件）：

```ts
const relativePathByPath: Record<string, string | null> = {}
for (const f of expanded.files) {
  const source = expanded.sourceOf.get(f.path) ?? f.path
  relativePathByPath[f.path] = relBySource.get(path.normalize(source)) ?? null
}
const { tasks, duplicates } = await this.deps.submit({
  files: expanded.files,
  source: 'scheduled',
  relativePathByPath
})
```

（原 `const { tasks, duplicates } = await this.deps.submit({...})` 整体替换为上述形态。）

- [ ] **Step 4: 实现 taskManager.ts**

1. `RecognitionTaskSubmitInput` 增：

```ts
/** 仅 scheduled 提交携带：文件绝对路径 → 相对扫描目录的层级（快照落库） */
relativePathByPath?: Record<string, string | null>
```

2. `submit()` 的 `insertTasks` map 项追加 `relativePath: input.relativePathByPath?.[file.path] ?? null`。

- [ ] **Step 5: 确认 GREEN + composition 类型核对**

Run: 同 Step 2 命令 + `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`。Expected: documents 全套件 PASS。

composition.ts 的 autoWatch submit 包装器 `submit: async (input) => { ... submitWithDedupe(documentsDedupeDeps, input) ... }` 为参数透传，`relativePathByPath` 随 input 自然流动，无需改动；`submitWithDedupe`/`DedupeSubmitDeps` 的输入类型若为 `RecognitionTaskSubmitInput` 则自动兼容（tsc 会验证）。

- [ ] **Step 6: 格式化 / lint / typecheck + 提交**

```bash
./node_modules/.bin/oxfmt src/main/documents/autoWatch.ts src/main/documents/taskManager.ts test/main/documents/autoWatch.test.ts
./node_modules/.bin/oxlint src/main/documents/autoWatch.ts src/main/documents/taskManager.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/autoWatch.ts src/main/documents/taskManager.ts test/main/documents/autoWatch.test.ts
git commit -m "feat(documents): scan relative path submit"
```

---

### Task 3: 启动回填（存量 scheduled 任务）

**Files:**
- Modify: `src/main/documents/dedupeBackfill.ts`
- Modify: `src/main/app/composition.ts`
- Test: `test/main/documents/dedupeBackfill.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `listScheduledWithoutRelativePath`/`updateRelativePath`（经 repository 包装）、Task 2 的 `computeRelativePath`。
- Produces: `backfillTaskRelativePaths(deps): number`（composition 启动调用，返回回填行数）。

- [ ] **Step 1: 写失败测试（dedupeBackfill.test.ts 追加）**

沿用该文件既有 describe 与 stub 风格，追加：

```ts
describe('backfillTaskRelativePaths', () => {
  it('按当前扫描目录回填 scheduled 任务的 NULL 相对路径', () => {
    const updates: Array<{ id: string; relativePath: string }> = []
    const updated = backfillTaskRelativePaths({
      listScheduledTasksWithoutRelativePath: () => [
        { id: 't1', filePath: 'D:\\scan\\sub\\a.pdf' },
        { id: 't2', filePath: 'D:\\scan\\b.pdf' }
      ],
      getAutoWatchDir: () => 'D:\\scan',
      updateTaskRelativePath: (id, relativePath) => updates.push({ id, relativePath })
    })
    expect(updated).toBe(2)
    expect(updates).toEqual([
      { id: 't1', relativePath: 'sub/a.pdf' },
      { id: 't2', relativePath: 'b.pdf' }
    ])
  })

  it('目录外文件与空目录跳过（保持 NULL）', () => {
    const updateTaskRelativePath = vi.fn()
    const updated = backfillTaskRelativePaths({
      listScheduledTasksWithoutRelativePath: () => [
        { id: 't1', filePath: 'D:\\other\\a.pdf' },
        { id: 't2', filePath: 'D:\\scan\\b.pdf' }
      ],
      getAutoWatchDir: () => 'D:\\scan',
      updateTaskRelativePath
    })
    expect(updated).toBe(1)
    expect(updateTaskRelativePath).toHaveBeenCalledTimes(1)
    expect(updateTaskRelativePath).toHaveBeenCalledWith('t2', 'b.pdf')
  })

  it('扫描目录为空时直接返回 0', () => {
    const listScheduledTasksWithoutRelativePath = vi.fn()
    const updated = backfillTaskRelativePaths({
      listScheduledTasksWithoutRelativePath,
      getAutoWatchDir: () => '',
      updateTaskRelativePath: vi.fn()
    })
    expect(updated).toBe(0)
    expect(listScheduledTasksWithoutRelativePath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/dedupeBackfill.test.ts --config vitest.config.ts`

Expected: FAIL（backfillTaskRelativePaths 未导出）。

- [ ] **Step 3: 实现 dedupeBackfill.ts**

文件头部加 `import { computeRelativePath } from './autoWatch'`，文件末尾追加：

```ts
export interface RelativePathBackfillDeps {
  listScheduledTasksWithoutRelativePath: () => Array<{ id: string; filePath: string }>
  getAutoWatchDir: () => string
  updateTaskRelativePath: (id: string, relativePath: string) => void
}

/**
 * 存量 scheduled 任务相对路径回填：relative_path 列上线前入库的自动扫描任务
 * 没有该值。按**当前**配置的扫描目录计算；目录已变更导致算不出（.. 开头等）
 * 保持 NULL（前端显示 —）。幂等：每次启动执行，只触碰 NULL 行，纯内存计算。
 */
export function backfillTaskRelativePaths(deps: RelativePathBackfillDeps): number {
  const dir = deps.getAutoWatchDir()
  if (dir === '') return 0
  let updated = 0
  for (const task of deps.listScheduledTasksWithoutRelativePath()) {
    const rel = computeRelativePath(task.filePath, dir)
    if (rel === null) continue
    deps.updateTaskRelativePath(task.id, rel)
    updated += 1
  }
  return updated
}
```

- [ ] **Step 4: repository 包装 + composition 接线**

repository.ts（`DocumentsRepository` 类内，`insertTasks` 附近）追加：

```ts
listScheduledTasksWithoutRelativePath(): DocumentTask[] {
  return this.database.documentTasksTable.listScheduledWithoutRelativePath().map(toTask)
}

updateTaskRelativePath(id: string, relativePath: string): void {
  this.database.documentTasksTable.updateRelativePath(id, relativePath)
}
```

composition.ts：import 处加 `backfillTaskRelativePaths`（与既有 `backfillDocumentHashes` 同一 import 语句合并）；在存量哈希回填 `if` 块之后、`createDocumentsRoutes` 之前追加（同步执行——纯内存计算 + 少量 UPDATE）：

```ts
// 存量 scheduled 任务相对路径回填：幂等（只触碰 NULL 行），失败不阻塞启动。
try {
  const backfilled = backfillTaskRelativePaths({
    listScheduledTasksWithoutRelativePath: () =>
      documentsRepository.listScheduledTasksWithoutRelativePath(),
    getAutoWatchDir: () => readAutoWatchConfig(providerSettings).dir,
    updateTaskRelativePath: (id, relativePath) =>
      documentsRepository.updateTaskRelativePath(id, relativePath)
  })
  if (backfilled > 0) {
    console.info(`[documents] relative path backfill updated ${backfilled} tasks`)
  }
} catch (error) {
  console.error('[documents] relative path backfill failed:', error)
}
```

- [ ] **Step 5: 确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/dedupeBackfill.test.ts test/main/documents/documentsTables.test.ts --config vitest.config.ts`

Expected: PASS（documentsRepository.test.ts 若被 tsc 触碰需同步检查）。

- [ ] **Step 6: 格式化 / lint / typecheck + 提交**

```bash
./node_modules/.bin/oxfmt src/main/documents/dedupeBackfill.ts src/main/documents/repository.ts src/main/app/composition.ts test/main/documents/dedupeBackfill.test.ts
./node_modules/.bin/oxlint src/main/documents/dedupeBackfill.ts src/main/documents/repository.ts src/main/app/composition.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/dedupeBackfill.ts src/main/documents/repository.ts src/main/app/composition.ts test/main/documents/dedupeBackfill.test.ts
git commit -m "feat(documents): relative path backfill"
```

---

### Task 4: 契约字段 + renderer 列 + i18n

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue`
- Modify: `src/renderer/src/i18n/<locale>/settings.json`（全部 locale，约 20 个）
- Test: 既有 `test/main/documents/documentsRoutes.test.ts` 回归（无需新文件）

**Interfaces:**
- Consumes: Task 1 的 `UnifiedTaskEntry.relativePath`（repository 已返回，zod 对象默认 strip 未声明字段，此前静默丢弃——本任务声明后透传 renderer）。

- [ ] **Step 1: 契约加字段**

`unifiedTaskEntrySchema` 的 `filePath` 行后追加：

```ts
relativePath: z.string().min(1).nullable(),
```

`documentTaskSchema` 不动（`documents.task.updated` 事件不携带该字段）。既有 documentsRoutes 用例回归：出参多 nullable 字段后 parse 仍通过。

- [ ] **Step 2: renderer 表格加列**

`DocumentsArchivePage.vue` 任务视图表格（符号搜索 `colFile` 定位 thead；行内文件名列 `<td>` 含 `openTaskDocument` 定位 tbody）：

1. thead：`colFile` 的 `<th>` 之后插入：

```html
<th class="px-2 py-2 text-left font-medium">{{ t('settings.documents.tasks.colRelativePath') }}</th>
```

（`text-left` 等类以相邻 `<th>` 实际类为准对齐。）

2. tbody：文件名列 `</td>` 之后插入：

```html
<td class="max-w-[200px] truncate px-2 py-2" :title="task.relativePath ?? ''">
  {{ task.relativePath ?? '—' }}
</td>
```

（`px-2 py-2` 与相邻 `<td>` 对齐；`truncate` 需要的其余类照抄相邻单元格。）

- [ ] **Step 3: i18n 全 locale 加键**

符号搜索 `"colFile"` 定位各 locale 的 tasks 键块，紧邻追加 `"colRelativePath"`：zh-CN 系 locale（zh-CN、zh-TW 等）用 `文件相对路径`（zh-TW 用 `檔案相對路徑`，若无 zh-TW 则略），其余全部用 `"Relative Path"`。键集合 20 locale 一致。

- [ ] **Step 4: 验证**

```bash
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts
./node_modules/.bin/oxfmt src/shared/contracts/routes/documents.routes.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue
./node_modules/.bin/oxlint src/shared/contracts/routes/documents.routes.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue
```

Expected: tsc exit 0；vue-tsc exit 0（OOM 两次则注明跳过）；routes 回归 PASS；lint 0 警告。

- [ ] **Step 5: 提交**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/renderer/src/pages/documents/DocumentsArchivePage.vue src/renderer/src/i18n
git commit -m "feat(documents): relative path column ui"
```

---

### Task 5: 全量验证与收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-task-relative-path-design.md`（状态行）

- [ ] **Step 1: 全量主进程套件**

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents test/main/app --config vitest.config.ts
```

失败文件清单必须与既有基线一致（不得出现新失败文件）。

- [ ] **Step 2: typecheck 双跑 + lint 终检 + git 卫生**

```bash
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false
git status --porcelain
```

工作树应干净（tsbuildinfo 与 git-ignored scratch 除外）。

- [ ] **Step 3: 人工 QA 清单（写入验证报告，不执行）**

1. 设置页配置扫描目录后，向其子目录放入新 PDF → 任务视图该行显示 `子目录/文件名.pdf`
2. 扫描目录根目录放文件 → 显示文件名本身
3. 手工上传与对话提交的条目 → 该列显示 `—`
4. 多发票合并件（样本 `20261245w7878.pdf`）放入子目录 → 拆分产物各行显示源文件的相对路径
5. 变更扫描目录后再扫描 → 新任务按新目录显示；旧任务保留旧层级（快照）
6. 分页/过滤/重试/清除失败操作后新列显示稳定

- [ ] **Step 4: spec 标已实施并提交**

`docs/superpowers/specs/2026-10-13-task-relative-path-design.md` 头部「状态」改为「已实施」。只 add 该文件：

```bash
git add docs/superpowers/specs/2026-10-13-task-relative-path-design.md
git commit -m "docs(documents): mark relative path spec done"
```
