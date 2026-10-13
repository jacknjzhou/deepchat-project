# 文档内容级去重 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能信息提取三条提交路径（manual/chat/scheduled）按文件字节 SHA-256 在提交环节拦截内容重复文件，不建任务不提取，并在弹窗/通知中提示。

**Architecture:** 新表 `documents_file_dedupe` 登记内容哈希（task_id 关联、成功回填 document_id、失败清理）；去重过滤器 + submit 包装器在 service 组装层收口，`RecognitionTaskManager` 仅增加两个生命周期钩子；IPC 返回值扩展 `duplicates`，识别弹窗内联提示，自动监控走通知通道。

**Tech Stack:** Electron 主进程 TypeScript、better-sqlite3-multiple-ciphers、Vitest（主进程测试需 `ELECTRON_RUN_AS_NODE=1`）、Vue 3 + vue-i18n。

**Spec:** `docs/superpowers/specs/2026-10-12-document-content-dedupe-design.md`（口径与验收标准以 spec 为准）

**执行须知（所有任务通用）：**
- 集成点代码块为「对齐现有模式的目标形状」：落地时以锚点处实际代码为准，保持既有行为契约不变，不盲抄。
- 主进程 sqlite 相关测试必须用：`$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`（PowerShell，无 `&&`）。
- test:main 本机约 98 个既有环境性失败：只比对失败文件清单与本次改动区域。
- `pnpm run typecheck:web` 本机可能 tsgo OOM（errno 1455/134），复现则跳过并注明；`typecheck:node` 必须通过。
- 提交信息 Conventional Commits ≤50 字符；oxfmt 单引号/无分号/100 列。
- Edit 工具在 Windows 有损坏文件尾部的前科：每次编辑后检查文件尾部完整性。

---

### Task 1: shared 类型与 IPC 契约扩展

**Files:**
- Modify: `src/shared/documents.ts`（类型区，DocumentFieldEntry 附近）
- Modify: `src/shared/contracts/routes/documents.routes.ts:289-297`（`documents.tasks.create` output）
- Test: 契约如有快照/schema 测试则同步（搜 `documents.tasks.create` 在 test/ 下的断言）

- [ ] **Step 1: 在 src/shared/documents.ts 增加类型**

```ts
/** 内容去重：提交时被拦截的重复文件（path 供自动监控登记使用，UI 只用 fileName/existingName） */
export interface RecognitionDuplicate {
  fileName: string
  existingName: string
  path: string
}
```

- [ ] **Step 2: 扩展 documents.tasks.create output 契约**

将 output 由 `{ tasks }` 改为：

```ts
output: z.object({
  tasks: z.array(/* 保持现有 task schema 不变 */),
  duplicates: z.array(
    z.object({
      fileName: z.string(),
      existingName: z.string(),
      path: z.string()
    })
  )
})
```

- [ ] **Step 3: 全仓搜 `documents.tasks.create` 的测试/消费方**，凡断言 output 形状处补 `duplicates` 字段；仅类型引用处不动。

- [ ] **Step 4: 运行 `pnpm run typecheck:node`，确认因 renderer/main 消费方暂缺字段导致的编译错误清单**（记录待改文件，Task 6/7 消化；本任务允许临时以 `duplicates: []` 常量兜底处不引入——类型错误留给后续任务，或在本任务内给所有消费方补默认值）。

- [ ] **Step 5: Commit** `feat(documents): dedupe aware task contract`

---

### Task 2: repository —— documents_file_dedupe 表 + 端口方法 + watched.task_id 可空

**Files:**
- Create: `src/main/documents/data/tables/fileDedupe.ts`（镜像 `data/tables/watchedFiles.ts` L19-38 的建表模式）
- Modify: `src/main/documents/data/database.ts:7-19`（注册新表实例，同 WatchedFilesTable 写法）
- Modify: `src/main/documents/data/tables/watchedFiles.ts:19-38`（`task_id TEXT NOT NULL` → 可空，走 repairableColumns 幂等修复）
- Modify: `src/main/documents/repository.ts:60-96`（端口）、`repository.ts:316-373`（SQL 实现）
- Test: `test/main/documents/documentsTables.test.ts`

- [ ] **Step 1: 写失败测试（documentsTables.test.ts 追加）**

```ts
it('documents_file_dedupe 表幂等建表并支持登记/查询/清理/回填', () => {
  const db = createDocumentsDatabase() // 复用该文件既有的内存库构造方式
  // 建表重跑不抛错
  expect(() => new FileDedupeTable(db).createTable()).not.toThrow()
  db.insertFileDedupes([
    {
      contentHash: 'a'.repeat(64),
      fileName: '发票.pdf',
      filePath: 'D:/t/发票.pdf',
      source: 'scheduled',
      taskId: 'task-1',
      now: 1000
    }
  ])
  const found = db.findFileDedupeNames(['a'.repeat(64), 'b'.repeat(64)])
  expect(found.get('a'.repeat(64))).toBe('发票.pdf')
  expect(found.has('b'.repeat(64))).toBe(false)
  db.bindFileDedupeDocument('task-1', 'doc-1')
  db.deleteFileDedupesByTask('task-1')
  expect(db.findFileDedupeNames(['a'.repeat(64)]).size).toBe(0)
})

it('watched_files.task_id 放宽为可空：null 登记可查询且幂等', () => {
  const db = createDocumentsDatabase()
  db.upsertWatchedFile({ path: 'D:/t/dup.pdf', mtimeMs: 5, taskId: null, now: 1000 })
  expect(db.listWatchedFiles()).toContainEqual({ path: 'D:/t/dup.pdf', mtime_ms: 5 })
})
```

- [ ] **Step 2: 运行测试确认失败**（ELECTRON_RUN_AS_NODE 方式，预期 `FileDedupeTable` 未定义 / task_id NOT NULL 约束失败）。

- [ ] **Step 3: 实现 fileDedupe.ts（镜像 watchedFiles.ts 模式）**

```ts
export class FileDedupeTable {
  constructor(private readonly db: Database) {}
  createTable(): void {
    // CREATE TABLE IF NOT EXISTS documents_file_dedupe (
    //   content_hash TEXT PRIMARY KEY,
    //   file_name    TEXT NOT NULL,
    //   file_path    TEXT NOT NULL,
    //   source       TEXT NOT NULL,
    //   task_id      TEXT NOT NULL,
    //   document_id  TEXT,
    //   created_at   INTEGER NOT NULL
    // )
    // 走与 watchedFiles.ts 相同的 repairableColumns 幂等修复包装
  }
}
```

repository 增加四个方法（端口与实现同步，SQL 用预编译语句；批查询 `content_hash IN (...)` 动态占位符）：

```ts
findFileDedupeNames(hashes: string[]): Map<string, string>
insertFileDedupes(
  rows: Array<{
    contentHash: string
    fileName: string
    filePath: string
    source: string
    taskId: string
    now: number
  }>
): void // 单事务
deleteFileDedupesByTask(taskId: string): void
bindFileDedupeDocument(taskId: string, documentId: string): void
```

watchedFiles：task_id 列改为可空（NULL 登记不冲突，upsert 幂等语义不变：同 path 覆盖 mtime/task_id）。

**删除级联（用户确认语义）**：`repository.deleteDocument`（repository.ts:272）内在删除文档的同一事务中执行
`DELETE FROM documents_file_dedupe WHERE document_id = ?`——所有删除调用方自动生效，无需改 routes.ts:176 的调用点。
Step 1 测试补充：

```ts
it('删除文档时级联清理其哈希行，重传同内容可再次识别', () => {
  const db = createDocumentsDatabase()
  db.insertFileDedupes([
    { contentHash: 'c'.repeat(64), fileName: 'a.pdf', filePath: 'D:/t/a.pdf', source: 'manual', taskId: 't9', now: 1000 }
  ])
  db.bindFileDedupeDocument('t9', 'doc-9')
  db.deleteDocument('doc-9')
  expect(db.findFileDedupeNames(['c'.repeat(64)]).size).toBe(0)
})
```

- [ ] **Step 4: 测试通过** → **Step 5: Commit** `feat(documents): file dedupe table`

---

### Task 3: fileHash 流式哈希

**Files:**
- Create: `src/main/documents/fileHash.ts`
- Test: `test/main/documents/fileHash.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256File } from '@/main/documents/fileHash' // 对齐该目录既有测试的导入别名

it('sha256File 计算文件字节摘要', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'))
  const p = join(dir, 'a.pdf')
  writeFileSync(p, Buffer.from([1, 2, 3, 4, 5]))
  expect(await sha256File(p)).toBe(
    // node -e "console.log(require('crypto').createHash('sha256').update(Buffer.from([1,2,3,4,5])).digest('hex'))" 的期望值
    '74d da6f...' // ← 执行时用上述命令算出真实值填入
  )
})

it('读取失败返回 null 而不抛错', async () => {
  expect(await sha256File('Z:/不存在的路径/x.pdf')).toBeNull()
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现**

```ts
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const CHUNK_SIZE = 64 * 1024

/** 流式计算文件 SHA-256（hex 小写）；读取失败返回 null（该文件照常提交，由提取错误路径兜底）。 */
export async function sha256File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', () => resolve(null))
  })
}
```

- [ ] **Step 4: 通过 → Step 5: Commit** `feat(documents): streaming file sha256`

---

### Task 4: 去重过滤器 + submit 包装器

**Files:**
- Create: `src/main/documents/contentDedupe.ts`
- Test: `test/main/documents/contentDedupe.test.ts`

- [ ] **Step 1: 失败测试（覆盖：批内互重、查表命中、null hash 直通、登记行内容、tasks 与 hashes 按序 zip）**

```ts
it('批内同内容仅首个提交，后续为 duplicates', async () => {
  const files = [file('a.pdf'), file('b.pdf')] // 测试桩 sha256File 返回相同 hash
  const result = await filterDuplicateFiles(files, 'manual', stubDeps)
  expect(result.files).toHaveLength(1)
  expect(result.hashes).toHaveLength(1)
  expect(result.duplicates).toEqual([
    { fileName: 'b.pdf', existingName: 'a.pdf', path: files[1].path }
  ])
})

it('查表命中的文件被拦截且携带表内 existingName', async () => {
  /* stubDeps.findFileDedupeNames 命中 a.pdf → duplicates=[{fileName:'a.pdf', existingName:'表内名', path}] */
})

it('hash 计算失败(null)的文件照常提交且不登记', async () => { /* ... */ })

it('submitWithDedupe 按序 zip 登记 hash→task_id 并透传 duplicates', async () => { /* ... */ })
```

- [ ] **Step 2: 失败 → Step 3: 实现 contentDedupe.ts**

```ts
import type { DocumentExtractFileInput, RecognitionDuplicate } from '@shared/documents'

export interface DedupeFilterDeps {
  sha256File: (path: string) => Promise<string | null>
  findFileDedupeNames: (hashes: string[]) => Map<string, string>
  now?: () => number
}

export interface DedupeFilterResult {
  files: DocumentExtractFileInput[]
  /** 与 files 按下标对齐；null = 无法计算哈希（照常提交，不登记） */
  hashes: Array<string | null>
  duplicates: RecognitionDuplicate[]
}

export async function filterDuplicateFiles(
  files: DocumentExtractFileInput[],
  source: 'manual' | 'chat' | 'scheduled',
  deps: DedupeFilterDeps
): Promise<DedupeFilterResult> {
  const hashes = await Promise.all(files.map((f) => deps.sha256File(f.path)))
  const table = deps.findFileDedupeNames(hashes.filter((h): h is string => h !== null))
  const seen = new Map<string, string>()
  const outFiles: DocumentExtractFileInput[] = []
  const outHashes: Array<string | null> = []
  const duplicates: RecognitionDuplicate[] = []
  files.forEach((f, i) => {
    const hash = hashes[i]
    if (hash === null) {
      outFiles.push(f)
      outHashes.push(null)
      return
    }
    const existing = seen.get(hash) ?? table.get(hash)
    if (existing !== undefined) {
      duplicates.push({ fileName: f.name ?? basename(f.path), existingName: existing, path: f.path })
      return
    }
    seen.set(hash, f.name ?? basename(f.path))
    outFiles.push(f)
    outHashes.push(hash)
  })
  void source
  return { files: outFiles, hashes: outHashes, duplicates }
}
```

包装器（同文件，组装层唯一入口；submit 返回 tasks 与 files 1:1 同序——autoWatch 已依赖此约定）：

```ts
export interface DedupeSubmitDeps {
  submit: (input: RecognitionTaskSubmitInput) => DocumentTask[]
  filter: typeof filterDuplicateFiles
  register: (rows: Array<{ contentHash: string; fileName: string; filePath: string; source: string; taskId: string; now: number }>) => void
  now?: () => number
}

export async function submitWithDedupe(
  deps: DedupeSubmitDeps,
  input: RecognitionTaskSubmitInput
): Promise<{ tasks: DocumentTask[]; duplicates: RecognitionDuplicate[] }> {
  const { files, hashes, duplicates } = await deps.filter(input.files, input.source)
  if (files.length === 0) return { tasks: [], duplicates }
  const tasks = deps.submit({ ...input, files })
  const now = deps.now ?? Date.now
  const rows = tasks
    .map((task, i) => ({ task, hash: hashes[i] }))
    .filter((row): row is { task: DocumentTask; hash: string } => row.hash !== null)
    .map((row) => ({
      contentHash: row.hash,
      fileName: row.task.fileName,
      filePath: row.task.filePath,
      source: input.source,
      taskId: row.task.id,
      now: now()
    }))
  if (rows.length > 0) deps.register(rows)
  return { tasks, duplicates }
}
```

- [ ] **Step 4: 通过 → Step 5: Commit** `feat(documents): content dedupe filter`

---

### Task 5: taskManager 生命周期钩子

**Files:**
- Modify: `src/main/documents/repository.ts:60-96`（端口加 `deleteFileDedupesByTask`、`bindFileDedupeDocument` 必选成员）
- Modify: `src/main/documents/taskManager.ts:127-161`（runTask 成功/失败分支各加一行）
- Test: `test/main/documents/taskManager.test.ts`（既有 stub 端口补两个成员）

- [ ] **Step 1: 失败测试**

```ts
it('任务成功后按 task_id 回填 document_id', async () => {
  // 既有成功用例的断言区追加：
  expect(repository.bindFileDedupeDocument).toHaveBeenCalledWith(taskId, documentId)
})

it('任务失败后按 task_id 删除哈希行', async () => {
  // 既有失败用例（extractor 抛错）追加：
  expect(repository.deleteFileDedupesByTask).toHaveBeenCalledWith(taskId)
})
```

- [ ] **Step 2: 失败 → Step 3: 实现（runTask 内，各一行）**

```ts
const document = this.deps.repository.insertDocument({ /* 原样 */ })
this.deps.repository.bindFileDedupeDocument(runningTask.id, document.id)
// catch 分支：
this.deps.repository.deleteFileDedupesByTask(runningTask.id)
```

同步为测试文件中手工构造的 port stub 补齐两个 vi.fn() 成员（全仓搜 `DocumentRepositoryTaskPort` 的测试构造处）。

- [ ] **Step 4: 通过 → Step 5: Commit** `feat(documents): dedupe task lifecycle hooks`

---

### Task 6: 组装收口 + autoWatch 适配 + IPC + 通知

**Files:**
- Modify: `src/main/app/composition.ts:3141-3167`（submit 接线包 wrapper；注册/查询/清理方法接 repository）
- Modify: `src/main/documents/autoWatch.ts:20-32,97-119`（deps.submit 返回结构、按 filePath zip、duplicates 以 null taskId 登记）
- Modify: `src/main/documents/routes.ts:188-199`（handler 改调 wrapper，返回 `{ tasks, duplicates }`）
- Test: `test/main/documents/autoWatch.test.ts`、routes 相关测试

- [ ] **Step 1: autoWatch 失败测试**

```ts
it('被拦截的重复文件仍登记 watched（taskId null）且不再重扫', async () => {
  // deps.submit 桩返回 { tasks: [{ id: 't1', filePath: batch[0].path }], duplicates: [{ path: batch[1].path }] }
  // 断言 upsertWatchedFile 收到 batch[1] → taskId: null；下一轮 runOnce 不再提交 batch[1]
})
```

- [ ] **Step 2: autoWatch 实现（deps 类型与 runOnce zip 改造）**

```ts
submit: (input: { files: DocumentExtractFileInput[]; source: 'scheduled' }) => Promise<{
  tasks: Array<{ id: string; filePath: string }>
  duplicates: Array<{ path: string }>
}>
```

```ts
const { tasks, duplicates } = await this.deps.submit({ files: [...], source: 'scheduled' })
const taskIdByPath = new Map(tasks.map((t) => [t.filePath, t.id]))
const dupPaths = new Set(duplicates.map((d) => d.path))
batch.forEach((f) => {
  const taskId = taskIdByPath.get(f.path) ?? null
  if (taskId === null && !dupPaths.has(f.path)) return // 提交与登记间异常，保守不登记
  this.deps.upsertWatchedFile({ path: f.path, mtimeMs: f.mtimeMs, taskId, now: now() })
})
```

`upsertWatchedFile` dep 的 `taskId: string` → `string | null`。runOnce 本就为 async，签名兼容。

- [ ] **Step 3: composition.ts 接线**：`AutoWatchScheduler.deps.submit` 与 `documentsTasksCreateRoute` 内部均改走 `submitWithDedupe`（deps.filter=filterDuplicateFiles、deps.register=documentsRepository.insertFileDedupes、deps.submit=recognitionTaskManager.submit）；routes handler 返回 `{ tasks, duplicates }`。
- [ ] **Step 4: 自动监控通知**：composition 接线处 duplicates.length > 0 时经现有主进程→renderer 事件机制发布（镜像 `publishDeepchatEvent('documents.task.updated')` 的既有写法，新增 `documents.watch.duplicates` 载荷 `{ count: number }`；renderer 侧订阅在 Task 7）。
- [ ] **Step 5: 相关测试通过 → Step 6: Commit** `feat(documents): dedupe submit choke point`

---

### Task 7: renderer —— store、识别弹窗提示、自动监控通知订阅、i18n

**Files:**
- Modify: `src/renderer/src/stores/documents.ts:235-243`（createRecognitionTasks 返回 `{ created, duplicates }`）
- Modify: `src/renderer/src/pages/documents/DocumentRecognizeDialog.vue:67-75,187-205`（内联提示区 + 提交后保存 duplicates）
- Modify: renderer documents store/页面既有 `documents.task.updated` 订阅处（镜像新增 `documents.watch.duplicates` 订阅 → `rendererNotificationManager` 提示「本轮已跳过 N 个重复文件」）
- Modify: i18n `settings.json` ×20 locale（键见下）+ `src/types/i18n.d.ts`（若为生成物则跑对应 i18n 脚本刷新）
- Test: `test/renderer/pages/documents/DocumentRecognizeDialog.test.ts`

- [ ] **Step 1: 弹窗失败测试**

```ts
it('提交返回 duplicates 时内联提示跳过明细', async () => {
  // client.createTasks 桩返回 { tasks: [...], duplicates: [{ fileName: 'b.pdf', existingName: 'a.pdf', path: '...' }] }
  // 断言提示文本包含 'b.pdf' 与 'a.pdf'
})
```

- [ ] **Step 2: 实现**（提示区复用 L67-75 既有 v-if 反馈区样式）

```vue
<p v-if="skippedDuplicates.length" class="text-sm text-muted-foreground">
  {{
    t('settings.documents.recognize.duplicateSkipped', { count: skippedDuplicates.length })
  }}
  <span v-for="d in skippedDuplicates" :key="d.path">
    {{ d.fileName }}（{{ t('settings.documents.recognize.duplicateOf', { name: d.existingName }) }}）
  </span>
</p>
```

i18n 新键（20 语言同步）：`settings.documents.recognize.duplicateSkipped`（zh-CN: 「已跳过 {count} 个内容重复的文件」）、`settings.documents.recognize.duplicateOf`（「与 {name} 重复」）、`settings.documents.autoWatch.duplicatesNotice`（「本轮已跳过 {count} 个重复文件」）。i18n 术语沿用各 locale 既有「智能信息提取」功能名对应译法（en "Document Recognition"、ja 帳票認識）。

- [ ] **Step 3: 测试通过 → Step 4: Commit** `feat(documents): dedupe ui hints`

---

### Task 8: 全量验证与收尾

- [ ] **Step 1: 运行相关套件**（ELECTRON_RUN_AS_NODE 方式跑主进程 sqlite/manager/autoWatch/routes 套件；vitest.renderer 跑弹窗/store/契约套件）
- [ ] **Step 2:** `pnpm run typecheck:node`（必须过）；`typecheck:web` OOM 则注明跳过
- [ ] **Step 3:** `pnpm exec oxfmt <改动文件>` + `pnpm exec oxlint <改动文件>`
- [ ] **Step 4: 手动验收**（dev 实例）：同内容 PDF 改名两次提交 → 第二个被弹窗提示拦截；放入监控目录同内容新文件 → 通知提示且下轮不重扫；失败任务重试不受影响；删除已识别文档后手动重传同内容 → 可重新识别，监控目录原文件 mtime 未变不复活
- [ ] **Step 5: 更新 project_memory 去重条目**

---

## Self-Review 结论

- Spec 覆盖：表/端口(2)、哈希(3)、过滤器+收口(4,6)、生命周期(5)、IPC(1,6)、弹窗/通知/i18n(7)、验收(8)——无缺口
- 类型一致性：`RecognitionDuplicate{fileName,existingName,path}` 贯穿 1/4/6/7；`submitWithDedupe` 返回 `{tasks, duplicates}` 与 routes/store 对齐
- 已知风险：composition.ts 巨大且行号会漂移，Task 6 以符号搜索（`new AutoWatchScheduler`/`recognitionTaskManager.submit`）定位锚点
