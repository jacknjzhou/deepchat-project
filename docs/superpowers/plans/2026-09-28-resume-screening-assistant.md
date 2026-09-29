# 简历筛选智能助手实施计划（Resume Screening Assistant）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. 逐任务执行：每个任务先读本任务全部上下文，按 checkbox 顺序完成，commit 后再进入下一任务。

- **Spec**: [docs/superpowers/specs/2026-09-28-resume-screening-assistant-design.md](../specs/2026-09-28-resume-screening-assistant-design.md)（已批准，commit `a7715718`）
- **日期**: 2026-09-28
- **状态**: 待执行

## Goal

在 DeepChat 主窗口新增"简历筛选"顶级功能页：输入岗位 JD 与 ≤20 份简历文件，由五角色 LLM 流水线
（JD 解析官 → 结构化提取员 → 初筛专员 → 资深面试官 → HR 主管）产出结构化筛选报告，任务与简历数据
SQLite 持久化并支持历史回看。复用 DeepChat 已配置的 Provider，页内可选模型（默认取应用默认模型）。

## Architecture

- **双通道契约**：仅两个物理 IPC 通道（`deepchat:route:invoke` / `deepchat:event`），业务按 Zod
  契约（`defineRouteContract` / `defineEventContract`）注册进集中目录，`src/preload/*` 零改动。
- **数据层**：两张新表 `resume_screening_tasks` / `resume_screening_resumes`，`BaseTable` 模式，
  同时注册进 `CATALOG_DEFINITIONS` 与 `createMainSchemaCatalog().createTables`（fresh install 直接
  建表；存量库走既有启动诊断 → repair 路径亦可补建，两者等价无冲突，见 Task 5 安全性说明）。
- **流水线**：`ResumeScreeningService` 在主进程编排；简历间并发（信号量，1–5，默认 3）、简历内五角色
  串行；`AbortController` 贯穿全部 LLM 调用实现取消。
- **LLM 直调**：`providerRuntime.executeWithRateLimit` + `generateCompletionStandalone(..., { swallowErrors: false })`，
  apiKey/baseURL 不出主进程。
- **文件存储**：`path.join(app.getPath('userData'), 'resume-screening', taskId, `${resumeId}.${ext}`)`
  （对 spec §4 中 `userData/app_files/resume-screening/` 的合理修正：仓库既有惯例是
  `userData/<feature>` 直挂，如 `logs`、`local-control`，无 `app_files` 层级先例）。
- **目录命名**：页面目录 `pages/resumeScreening/`（对 spec §10 中 `pages/resume-screening/` 的
  合理修正：与主进程目录 `src/main/resumeScreening/`、契约文件名及测试目录保持同一 camelCase
  命名，同功能跨层目录名一致；仓库 camel 目录先例如 `components/ChatConfig`、`components/computerUse`）。
- **语义决策（spec §5 补充）**：`config.generateExplanation = false` 时跳过 ④interviewer 与
  ⑤hr_manager 两个角色（对应 UI"生成解释"开关），`interview_json`/`hr_json` 落库为 NULL；
  `config.includeRawText` 仅控制渲染层是否展示 `raw_text`，提取始终执行（extractor 角色的输入就是原文）。

## Tech Stack

Electron + Vue 3 + TypeScript + better-sqlite3-multiple-ciphers + zod + jsonrepair（均已在
package.json 中，**零新增依赖**）+ Tailwind（应用既有 CSS 变量）+ shadcn-vue 原语（`@shadcn/components/ui/*`）
+ Dc 原语（`@dc-ui/components/*`）+ `@iconify/vue` + vue-i18n。

## 约定

- 代码风格 Oxfmt：单引号、无分号、100 列。新增主进程代码注释用中文（与 documents 域一致）。
- 提交信息 Conventional Commits（`type(scope): subject`，≤50 字符，英文）。
- 主进程测试 Vitest（`test/main/`），sqlite 原生模块缺失时自动降级 `describe.skip`
  （照抄 [test/main/documents/documentsTables.test.ts](../../../test/main/documents/documentsTables.test.ts) 的探测模式）。
- 每个任务完成即 commit；Task 17 统一跑 `pnpm format`、`pnpm lint`、`pnpm typecheck`、`pnpm i18n`
  与相关测试套件。
- 路由/事件目录注册三处口诀（Task 1/2）：**import 区 + `export *` 区 + 目录条目**。

---

## Task 1: 共享层路由契约 + routes.ts 目录注册

**Files:**

- 新建：`src/shared/contracts/routes/resumeScreening.routes.ts`
- 修改：`src/shared/contracts/routes.ts`

**背景知识**：

- 契约工厂：`defineRouteContract({ name, input, output })`，来自 `../common`
- 先例：[device.routes.ts](../../../src/shared/contracts/routes/device.routes.ts)、
  [documents.routes.ts](../../../src/shared/contracts/routes/documents.routes.ts)
- [routes.ts](../../../src/shared/contracts/routes.ts) 注册三处：
  1. import 区末尾（L652-658 的 orchestration import 块之后）
  2. `export *` 区末尾（L706 `export * from './routes/orchestration.routes'` 之后）
  3. 目录条目：追加到 `DEEPCHAT_ROUTE_CATALOG_PART_5`（L1102 起）末尾，即 L1307
     `[toolchainsPickCustomRoute.name]: toolchainsPickCustomRoute,` 之后、
     L1308 `} satisfies Record<string, RouteContract>` 之前

### 步骤

- [ ] 创建 `src/shared/contracts/routes/resumeScreening.routes.ts`：

```ts
import { z } from 'zod'
import { defineRouteContract } from '../common'

const timestampMsSchema = z.number().int().nonnegative()

export const resumeScreeningTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled'
])

export const resumeScreeningResumeStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])

export const resumeScreeningJdAnalysisSchema = z.object({
  responsibilities: z.array(z.string()),
  requirements: z.array(z.string()),
  preferred: z.array(z.string())
})

export const resumeScreeningScreeningSchema = z.object({
  score: z.number().min(0).max(100),
  recommended: z.boolean(),
  conclusion: z.string(),
  strengths: z.array(z.string())
})

export const resumeScreeningInterviewSchema = z.object({
  highlights: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(z.string())
})

export const resumeScreeningHrSchema = z.object({
  finalSummary: z.string(),
  hrOpinion: z.string()
})

export const resumeScreeningProfileSchema = z.object({
  name: z.string(),
  email: z.string()
})

export const resumeScreeningResumeDtoSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  fileName: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  candidateName: z.string().nullable(),
  rawText: z.string().nullable(),
  // 结构化简历信息，字段对齐 docs/superpowers/specs/templates/resume.yaml（resume_v1），
  // 由 LLM 输出结构多变，契约层保持宽松、展示层按需取字段
  resumeInfo: z.unknown().nullable(),
  screening: resumeScreeningScreeningSchema.nullable(),
  interview: resumeScreeningInterviewSchema.nullable(),
  hr: resumeScreeningHrSchema.nullable(),
  score: z.number().nullable(),
  recommended: z.boolean().nullable(),
  status: resumeScreeningResumeStatusSchema,
  error: z.string().nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const resumeScreeningTaskDtoSchema = z.object({
  id: z.string().min(1),
  status: resumeScreeningTaskStatusSchema,
  jdSource: z.enum(['text', 'file']),
  jdText: z.string(),
  jdFileName: z.string().nullable(),
  jdAnalysis: resumeScreeningJdAnalysisSchema.nullable(),
  config: z.object({
    generateExplanation: z.boolean(),
    includeRawText: z.boolean(),
    maxConcurrency: z.number().int().min(1).max(5)
  }),
  providerId: z.string(),
  modelId: z.string(),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgScore: z.number().nullable(),
  recommendedCount: z.number().int().nonnegative(),
  createdByName: z.string(),
  createdByEmail: z.string(),
  startedAt: timestampMsSchema.nullable(),
  finishedAt: timestampMsSchema.nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const resumeScreeningCreateTaskRoute = defineRouteContract({
  name: 'resumeScreening.createTask',
  input: z.object({
    jdSource: z.enum(['text', 'file']),
    jdText: z.string().max(60000).default(''),
    jdFilePath: z.string().min(1).optional(),
    jdFileName: z.string().min(1).optional(),
    resumes: z
      .array(
        z.object({
          path: z.string().min(1),
          name: z.string().min(1),
          mimeType: z.string().min(1).optional(),
          // 渲染层选择文件时拿不到文件大小，改为可选，由服务端兜底 0
          size: z.number().int().nonnegative().optional()
        })
      )
      .min(1)
      .max(20),
    config: z.object({
      generateExplanation: z.boolean(),
      includeRawText: z.boolean(),
      maxConcurrency: z.number().int().min(1).max(5)
    }),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional()
  }),
  output: z.object({ task: resumeScreeningTaskDtoSchema })
})

export const resumeScreeningGetTaskRoute = defineRouteContract({
  name: 'resumeScreening.getTask',
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({
    task: resumeScreeningTaskDtoSchema.nullable(),
    resumes: z.array(resumeScreeningResumeDtoSchema)
  })
})

export const resumeScreeningListTasksRoute = defineRouteContract({
  name: 'resumeScreening.listTasks',
  input: z.object({ limit: z.number().int().positive().max(100).optional() }),
  output: z.object({ tasks: z.array(resumeScreeningTaskDtoSchema) })
})

export const resumeScreeningCancelTaskRoute = defineRouteContract({
  name: 'resumeScreening.cancelTask',
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() })
})

export const resumeScreeningGetProfileRoute = defineRouteContract({
  name: 'resumeScreening.getProfile',
  input: z.object({}).default({}),
  output: z.object({ profile: resumeScreeningProfileSchema })
})

export const resumeScreeningUpdateProfileRoute = defineRouteContract({
  name: 'resumeScreening.updateProfile',
  input: z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().max(200).optional()
  }),
  output: z.object({ profile: resumeScreeningProfileSchema })
})

export const resumeScreeningListModelsRoute = defineRouteContract({
  name: 'resumeScreening.listModels',
  input: z.object({}).default({}),
  output: z.object({
    models: z.array(
      z.object({
        providerId: z.string().min(1),
        providerName: z.string().min(1),
        modelId: z.string().min(1),
        modelName: z.string().min(1),
        isDefault: z.boolean()
      })
    )
  })
})
```

- [ ] 修改 `src/shared/contracts/routes.ts` 三处：

1. import 区末尾（orchestration import 块 `} from './routes/orchestration.routes'` 之后）追加：

```ts
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
  resumeScreeningUpdateProfileRoute
} from './routes/resumeScreening.routes'
```

2. `export *` 区末尾（`export * from './routes/orchestration.routes'` 之后）追加：

```ts
export * from './routes/resumeScreening.routes'
```

3. `DEEPCHAT_ROUTE_CATALOG_PART_5` 末尾（`[toolchainsPickCustomRoute.name]: toolchainsPickCustomRoute,`
   之后、`} satisfies Record<string, RouteContract>` 之前）追加：

```ts
  [resumeScreeningCreateTaskRoute.name]: resumeScreeningCreateTaskRoute,
  [resumeScreeningGetTaskRoute.name]: resumeScreeningGetTaskRoute,
  [resumeScreeningListTasksRoute.name]: resumeScreeningListTasksRoute,
  [resumeScreeningCancelTaskRoute.name]: resumeScreeningCancelTaskRoute,
  [resumeScreeningGetProfileRoute.name]: resumeScreeningGetProfileRoute,
  [resumeScreeningUpdateProfileRoute.name]: resumeScreeningUpdateProfileRoute,
  [resumeScreeningListModelsRoute.name]: resumeScreeningListModelsRoute
```

- [ ] 验证：`pnpm typecheck` 通过（契约目录自动扩展 preload 类型，无需改 preload）。

- [ ] Commit：`feat(contracts): add resumeScreening route contracts`

---

## Task 2: 共享层事件契约 + events.ts 目录注册

**Files:**

- 新建：`src/shared/contracts/events/resumeScreening.events.ts`
- 修改：`src/shared/contracts/events.ts`

**背景知识**：

- 契约工厂：`defineEventContract({ name, payload })`；`TimestampMsSchema` 来自 `../common`
- 先例：[documents.events.ts](../../../src/shared/contracts/events/documents.events.ts)
- [events.ts](../../../src/shared/contracts/events.ts) 注册三处：
  1. import 区（L139 `liveDelegationChangedEvent` / L146 `runs.events` import 块之后）
  2. `export *` 区末尾（L178 `export * from './events/workspace.events'` 之后）
  3. `DEEPCHAT_EVENT_CATALOG`（L180 起）末尾——插入到 catalog 对象的**最后一个条目之后**
     （定位方式：搜索 `DEEPCHAT_EVENT_CATALOG` 对象内最后一个 `[xxxEvent.name]:` 行）
- 事件 payload 末尾带 `version: TimestampMsSchema` 防乱序（spec §6 快照模式的落地方，
  与 documents.task.updated 先例一致）

### 步骤

- [ ] 创建 `src/shared/contracts/events/resumeScreening.events.ts`：

```ts
import { z } from 'zod'
import { TimestampMsSchema, defineEventContract } from '../common'
import {
  resumeScreeningResumeStatusSchema,
  resumeScreeningTaskStatusSchema
} from '../routes/resumeScreening.routes'

export const resumeScreeningTaskUpdatedEvent = defineEventContract({
  name: 'resumeScreening.task.updated',
  payload: z.object({
    taskId: z.string().min(1),
    status: resumeScreeningTaskStatusSchema,
    progress: z.object({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative()
    }),
    stats: z.object({
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      avgScore: z.number().nullable(),
      recommendedCount: z.number().int().nonnegative()
    }),
    version: TimestampMsSchema
  })
})

export const resumeScreeningResumeUpdatedEvent = defineEventContract({
  name: 'resumeScreening.resume.updated',
  payload: z.object({
    taskId: z.string().min(1),
    resumeId: z.string().min(1),
    status: resumeScreeningResumeStatusSchema,
    stage: z.enum(['extracting', 'screening', 'interviewing', 'hr']).nullable(),
    version: TimestampMsSchema
  })
})
```

- [ ] 修改 `src/shared/contracts/events.ts` 三处：

1. import 区追加（runs.events import 块之后）：

```ts
import {
  resumeScreeningResumeUpdatedEvent,
  resumeScreeningTaskUpdatedEvent
} from './events/resumeScreening.events'
```

2. `export *` 区末尾追加：

```ts
export * from './events/resumeScreening.events'
```

3. `DEEPCHAT_EVENT_CATALOG` 对象末尾追加两条目：

```ts
  [resumeScreeningTaskUpdatedEvent.name]: resumeScreeningTaskUpdatedEvent,
  [resumeScreeningResumeUpdatedEvent.name]: resumeScreeningResumeUpdatedEvent
```

（注意保持前一条目末尾补逗号。）

- [ ] 验证：`pnpm typecheck` 通过。

- [ ] Commit：`feat(contracts): add resumeScreening event contracts`

---

## Task 3: tasks 表类 + 表测试

**Files:**

- 新建：`src/main/resumeScreening/data/tables/resumeScreeningTasks.ts`
- 新建：`test/main/resumeScreening/resumeScreeningTables.test.ts`

**背景知识**：

- `BaseTable`（[src/main/data/baseTable.ts](../../../src/main/data/baseTable.ts)）：
  构造 `super(db, tableName)`，`createTable()` 仅在 `!tableExists()` 时执行 `getCreateTableSQL()`
- 表类模板：[documentTasks.ts](../../../src/main/documents/data/tables/documentTasks.ts)
  （Row/InsertInput/UpdateInput 接口 + `CREATE TABLE IF NOT EXISTS` + 双索引 SQL +
  "update 时 undefined 字段保留原值"语义）
- 本表 id 由表类内部 `randomUUID()` 生成（Task 4 的 resumes 表才需要显式 id）

### 步骤

- [ ] 创建 `src/main/resumeScreening/data/tables/resumeScreeningTasks.ts`：

```ts
import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface ResumeScreeningTaskRow {
  id: string
  status: string
  jd_source: string
  jd_text: string
  jd_file_name: string | null
  jd_analysis_json: string | null
  config_json: string
  provider_id: string
  model_id: string
  total: number
  succeeded: number
  failed: number
  avg_score: number | null
  recommended_count: number
  created_by_name: string
  created_by_email: string
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
}

export interface ResumeScreeningTaskInsertInput {
  jdSource: 'text' | 'file'
  jdText: string
  jdFileName?: string | null
  configJson: string
  providerId: string
  modelId: string
  total: number
  createdByName: string
  createdByEmail: string
  now?: number
}

export interface ResumeScreeningTaskUpdateInput {
  status?: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  jdAnalysisJson?: string | null
  succeeded?: number
  failed?: number
  avgScore?: number | null
  recommendedCount?: number
  startedAt?: number | null
  finishedAt?: number | null
  now?: number
}

export class ResumeScreeningTasksTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'resume_screening_tasks')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS resume_screening_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        jd_source TEXT NOT NULL CHECK(jd_source IN ('text', 'file')),
        jd_text TEXT NOT NULL,
        jd_file_name TEXT,
        jd_analysis_json TEXT,
        config_json TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        total INTEGER NOT NULL,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        avg_score REAL,
        recommended_count INTEGER NOT NULL DEFAULT 0,
        created_by_name TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resume_screening_tasks_status
        ON resume_screening_tasks(status, created_at DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): ResumeScreeningTaskRow | undefined {
    return this.db.prepare('SELECT * FROM resume_screening_tasks WHERE id = ?').get(id) as
      | ResumeScreeningTaskRow
      | undefined
  }

  insert(input: ResumeScreeningTaskInsertInput): ResumeScreeningTaskRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO resume_screening_tasks
           (id, status, jd_source, jd_text, jd_file_name, jd_analysis_json, config_json,
            provider_id, model_id, total, succeeded, failed, avg_score, recommended_count,
            created_by_name, created_by_email, started_at, finished_at, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.jdSource,
        input.jdText,
        input.jdFileName ?? null,
        input.configJson,
        input.providerId,
        input.modelId,
        input.total,
        input.createdByName,
        input.createdByEmail,
        now,
        now
      )
    return this.get(id)!
  }

  update(id: string, input: ResumeScreeningTaskUpdateInput): ResumeScreeningTaskRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE resume_screening_tasks
         SET status = ?, jd_analysis_json = ?, succeeded = ?, failed = ?, avg_score = ?,
             recommended_count = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status ?? existing.status,
        input.jdAnalysisJson !== undefined ? input.jdAnalysisJson : existing.jd_analysis_json,
        input.succeeded !== undefined ? input.succeeded : existing.succeeded,
        input.failed !== undefined ? input.failed : existing.failed,
        input.avgScore !== undefined ? input.avgScore : existing.avg_score,
        input.recommendedCount !== undefined
          ? input.recommendedCount
          : existing.recommended_count,
        input.startedAt !== undefined ? input.startedAt : existing.started_at,
        input.finishedAt !== undefined ? input.finishedAt : existing.finished_at,
        now,
        id
      )
    return this.get(id)
  }

  listRecent(limit = 100): ResumeScreeningTaskRow[] {
    return this.db
      .prepare('SELECT * FROM resume_screening_tasks ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as ResumeScreeningTaskRow[]
  }

  listActive(): ResumeScreeningTaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM resume_screening_tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC"
      )
      .all() as ResumeScreeningTaskRow[]
  }
}
```

- [ ] 创建 `test/main/resumeScreening/resumeScreeningTables.test.ts`（首段含 Task 4 的共用探测代码，
  本任务先写 tasks 部分）：

```ts
import { describe, expect, it } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const tasksModule = sqliteModule
  ? await import('@/resumeScreening/data/tables/resumeScreeningTasks').catch(() => null)
  : null
const resumesModule = sqliteModule
  ? await import('@/resumeScreening/data/tables/resumeScreeningResumes').catch(() => null)
  : null

const Database = sqliteModule?.default
const DatabaseCtor = Database!
const TasksTableCtor = tasksModule?.ResumeScreeningTasksTable!
const ResumesTableCtor = resumesModule?.ResumeScreeningResumesTable!

let sqliteAvailable = false
if (Database) {
  try {
    const smokeDb = new Database(':memory:')
    smokeDb.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const describeIfSqlite = sqliteAvailable && TasksTableCtor ? describe : describe.skip

describeIfSqlite('ResumeScreeningTasksTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new TasksTableCtor(db).createTable()
    return db
  }

  const makeInput = (overrides?: Partial<Parameters<InstanceType<typeof TasksTableCtor>['insert']>[0]>) => ({
    jdSource: 'text' as const,
    jdText: '高级前端工程师',
    configJson: JSON.stringify({ generateExplanation: true, includeRawText: false, maxConcurrency: 3 }),
    providerId: 'openai',
    modelId: 'gpt-4o',
    total: 2,
    createdByName: '张三',
    createdByEmail: 'zhang@example.com',
    now: 1000,
    ...overrides
  })

  it('creates table and inserts a queued task', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const row = table.insert(makeInput())
    expect(row.id).toBeTruthy()
    expect(row.status).toBe('queued')
    expect(row.succeeded).toBe(0)
    expect(row.failed).toBe(0)
    expect(row.recommended_count).toBe(0)
    expect(row.avg_score).toBeNull()
    expect(row.created_at).toBe(1000)
    db.close()
  })

  it('updates fields preserving unspecified ones', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const created = table.insert(makeInput())
    const updated = table.update(created.id, {
      status: 'running',
      startedAt: 2000,
      jdAnalysisJson: JSON.stringify({ responsibilities: ['a'], requirements: [], preferred: [] }),
      now: 3000
    })
    expect(updated?.status).toBe('running')
    expect(updated?.started_at).toBe(2000)
    expect(updated?.jd_analysis_json).toContain('responsibilities')
    expect(updated?.total).toBe(2)
    expect(updated?.created_at).toBe(1000)
    db.close()
  })

  it('lists recent and active tasks', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const a = table.insert(makeInput({ now: 100 }))
    table.insert(makeInput({ now: 200 }))
    table.update(a.id, { status: 'running' })
    expect(table.listRecent(10)).toHaveLength(2)
    expect(table.listRecent(10)[0].created_at).toBe(200)
    expect(table.listActive()).toHaveLength(1)
    expect(table.listActive()[0].id).toBe(a.id)
    db.close()
  })
})
```

- [ ] 跑测试：`pnpm vitest run test/main/resumeScreening/resumeScreeningTables.test.ts` 全绿。

- [ ] Commit：`feat(resume-screening): add tasks table`

---

## Task 4: resumes 表类 + 表测试

**Files:**

- 新建：`src/main/resumeScreening/data/tables/resumeScreeningResumes.ts`
- 修改：`test/main/resumeScreening/resumeScreeningTables.test.ts`（追加 resumes 描述块）

### 步骤

- [ ] 创建 `src/main/resumeScreening/data/tables/resumeScreeningResumes.ts`：

```ts
import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface ResumeScreeningResumeRow {
  id: string
  task_id: string
  file_name: string
  file_path: string
  mime_type: string | null
  size: number
  candidate_name: string | null
  raw_text: string | null
  resume_info_json: string | null
  screening_json: string | null
  interview_json: string | null
  hr_json: string | null
  score: number | null
  recommended: number | null
  status: string
  error: string | null
  created_at: number
  updated_at: number
}

// id 由调用方显式传入：简历原文文件路径为 userData/resume-screening/{taskId}/{id}.{ext}，
// 复制文件前必须先确定 id
export interface ResumeScreeningResumeInsertInput {
  id: string
  taskId: string
  fileName: string
  filePath: string
  mimeType?: string | null
  size: number
  now?: number
}

export interface ResumeScreeningResumeUpdateInput {
  status?: 'pending' | 'running' | 'done' | 'failed'
  candidateName?: string | null
  rawText?: string | null
  resumeInfoJson?: string | null
  screeningJson?: string | null
  interviewJson?: string | null
  hrJson?: string | null
  score?: number | null
  recommended?: boolean | null
  error?: string | null
  now?: number
}

export interface ResumeScreeningTaskStats {
  total: number
  succeeded: number
  failed: number
  avgScore: number | null
  recommendedCount: number
}

export class ResumeScreeningResumesTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'resume_screening_resumes')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS resume_screening_resumes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL,
        candidate_name TEXT,
        raw_text TEXT,
        resume_info_json TEXT,
        screening_json TEXT,
        interview_json TEXT,
        hr_json TEXT,
        score REAL,
        recommended INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'done', 'failed')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resume_screening_resumes_task
        ON resume_screening_resumes(task_id, created_at);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): ResumeScreeningResumeRow | undefined {
    return this.db.prepare('SELECT * FROM resume_screening_resumes WHERE id = ?').get(id) as
      | ResumeScreeningResumeRow
      | undefined
  }

  insert(input: ResumeScreeningResumeInsertInput): ResumeScreeningResumeRow {
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO resume_screening_resumes
           (id, task_id, file_name, file_path, mime_type, size, candidate_name, raw_text,
            resume_info_json, screening_json, interview_json, hr_json, score, recommended,
            status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 'pending', NULL, ?, ?)`
      )
      .run(input.id, input.taskId, input.fileName, input.filePath, input.mimeType ?? null, input.size, now, now)
    return this.get(input.id)!
  }

  update(id: string, input: ResumeScreeningResumeUpdateInput): ResumeScreeningResumeRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE resume_screening_resumes
         SET status = ?, candidate_name = ?, raw_text = ?, resume_info_json = ?,
             screening_json = ?, interview_json = ?, hr_json = ?, score = ?, recommended = ?,
             error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status ?? existing.status,
        input.candidateName !== undefined ? input.candidateName : existing.candidate_name,
        input.rawText !== undefined ? input.rawText : existing.raw_text,
        input.resumeInfoJson !== undefined ? input.resumeInfoJson : existing.resume_info_json,
        input.screeningJson !== undefined ? input.screeningJson : existing.screening_json,
        input.interviewJson !== undefined ? input.interviewJson : existing.interview_json,
        input.hrJson !== undefined ? input.hrJson : existing.hr_json,
        input.score !== undefined ? input.score : existing.score,
        input.recommended !== undefined
          ? input.recommended === null
            ? null
            : input.recommended
              ? 1
              : 0
          : existing.recommended,
        input.error !== undefined ? input.error : existing.error,
        now,
        id
      )
    return this.get(id)
  }

  listByTask(taskId: string): ResumeScreeningResumeRow[] {
    return this.db
      .prepare('SELECT * FROM resume_screening_resumes WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as ResumeScreeningResumeRow[]
  }

  markUnfinishedAsFailed(taskId: string, error: string, now?: number): number {
    const info = this.db
      .prepare(
        `UPDATE resume_screening_resumes
         SET status = 'failed', error = ?, updated_at = ?
         WHERE task_id = ? AND status IN ('pending', 'running')`
      )
      .run(error, now ?? Date.now(), taskId)
    return info.changes
  }

  getTaskStats(taskId: string): ResumeScreeningTaskStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                AVG(CASE WHEN status = 'done' AND score IS NOT NULL THEN score END) AS avg_score,
                SUM(CASE WHEN status = 'done' AND recommended = 1 THEN 1 ELSE 0 END) AS recommended_count
         FROM resume_screening_resumes WHERE task_id = ?`
      )
      .get(taskId) as {
      total: number
      succeeded: number | null
      failed: number | null
      avg_score: number | null
      recommended_count: number | null
    }
    return {
      total: row.total,
      succeeded: row.succeeded ?? 0,
      failed: row.failed ?? 0,
      avgScore: row.avg_score ?? null,
      recommendedCount: row.recommended_count ?? 0
    }
  }
}
```

- [ ] 在 `test/main/resumeScreening/resumeScreeningTables.test.ts` 末尾追加：

```ts
describeIfSqlite('ResumeScreeningResumesTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new TasksTableCtor(db).createTable()
    new ResumesTableCtor(db).createTable()
    return db
  }

  const makeResumeInput = (overrides?: Record<string, unknown>) => ({
    id: 'resume-1',
    taskId: 'task-1',
    fileName: '张三.pdf',
    filePath: 'C:\\tmp\\resume-1.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    now: 1000,
    ...overrides
  })

  it('inserts with explicit id and lists by task', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    const row = table.insert(makeResumeInput())
    expect(row.id).toBe('resume-1')
    expect(row.status).toBe('pending')
    table.insert(makeResumeInput({ id: 'resume-2', now: 200 }))
    expect(table.listByTask('task-1')).toHaveLength(2)
    expect(table.listByTask('task-2')).toHaveLength(0)
    db.close()
  })

  it('updates report fields and boolean recommended', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    table.insert(makeResumeInput())
    const updated = table.update('resume-1', {
      status: 'done',
      candidateName: '张三',
      screeningJson: JSON.stringify({ score: 88, recommended: true, conclusion: 'ok', strengths: [] }),
      score: 88,
      recommended: true,
      now: 2000
    })
    expect(updated?.status).toBe('done')
    expect(updated?.recommended).toBe(1)
    expect(updated?.score).toBe(88)
    db.close()
  })

  it('computes task stats and marks unfinished as failed', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    table.insert(makeResumeInput({ id: 'r1' }))
    table.insert(makeResumeInput({ id: 'r2' }))
    table.insert(makeResumeInput({ id: 'r3' }))
    table.update('r1', { status: 'done', score: 80, recommended: true })
    table.update('r2', { status: 'done', score: 90, recommended: false })
    // r3 保持 pending
    const stats = table.getTaskStats('task-1')
    expect(stats.total).toBe(3)
    expect(stats.succeeded).toBe(2)
    expect(stats.failed).toBe(0)
    expect(stats.avgScore).toBe(85)
    expect(stats.recommendedCount).toBe(1)
    const changed = table.markUnfinishedAsFailed('task-1', '已取消', 3000)
    expect(changed).toBe(1)
    expect(table.get('r3')?.status).toBe('failed')
    expect(table.get('r3')?.error).toBe('已取消')
    db.close()
  })
})
```

- [ ] 跑测试：`pnpm vitest run test/main/resumeScreening/resumeScreeningTables.test.ts` 全绿。

- [ ] Commit：`feat(resume-screening): add resumes table`

---

## Task 5: 领域数据库封装 + schemaCatalog 注册

**Files:**

- 新建：`src/main/resumeScreening/data/database.ts`
- 修改：`src/main/data/schemaCatalog.ts`

**背景知识**：

- 模板：[DocumentsDatabase](../../../src/main/documents/data/database.ts)（24 行）——
  `constructor(connection: DatabaseConnectionProvider)` + getter 每次新建表实例。
  composition.ts L902 把 `mainDatabase` 直接传给 DocumentsDatabase，同一实例可直接传给
  `ResumeScreeningDatabase`。
- schemaCatalog **双处注册**：
  1. `CATALOG_DEFINITIONS`（L80 起）：全表目录，驱动启动诊断/repair（`getSchemaCatalog()`）与
     fresh-install 判定。新表名不在 [schemaCatalogMetadata.ts](../../../src/main/data/schemaCatalogMetadata.ts)
     的 `SCHEMA_TABLES_NOT_CREATED_ON_FRESH_INSTALL` 排除名单 → `isSchemaTableCreatedOnFreshInstall()`
     默认返回 true，无需改 metadata 文件。
  2. `createMainSchemaCatalog()`（L479 起）：主库启动时实例化并 `createTables()`。
- **迁移安全性**（新表 `getLatestVersion()=1`、`getMigrationSQL()` 恒 `null`，见 Task 3/4）：
  - fresh install：`createTables()` 直接建表；随后 `migrate()` 走
    [mainDatabase.ts](../../../src/main/data/mainDatabase.ts) L293-299 的分支把 `schema_versions`
    直接盖到 `getLatestSchemaVersion()`（全表 max），不执行任何迁移 SQL。
  - 存量库：`CREATE TABLE IF NOT EXISTS` 幂等补建两张新表；`migrate()` 对每个未执行版本逐表调用
    `getMigrationSQL(version)`，新表恒返回 `null` → 不产生任何 SQL，不影响既有版本推进。
  - repair 路径：启动诊断把缺失表报告出来，repair 用目录里的 `createSql` 补建，与 createTables 等价。

### 步骤

- [ ] 创建 `src/main/resumeScreening/data/database.ts`：

```ts
import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { ResumeScreeningResumesTable } from './tables/resumeScreeningResumes'
import { ResumeScreeningTasksTable } from './tables/resumeScreeningTasks'

export class ResumeScreeningDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {}

  getDatabase() {
    return this.connection.getDatabase()
  }

  get tasksTable(): ResumeScreeningTasksTable {
    return new ResumeScreeningTasksTable(this.getDatabase())
  }

  get resumesTable(): ResumeScreeningResumesTable {
    return new ResumeScreeningResumesTable(this.getDatabase())
  }
}
```

- [ ] 修改 [schemaCatalog.ts](../../../src/main/data/schemaCatalog.ts) **三处**：

  1. import 区：L41 `import { DocumentTasksTable } from '@/documents/data/tables/documentTasks'`
     之后追加两行：

```ts
import { ResumeScreeningResumesTable } from '@/resumeScreening/data/tables/resumeScreeningResumes'
import { ResumeScreeningTasksTable } from '@/resumeScreening/data/tables/resumeScreeningTasks'
```

  2. `CATALOG_DEFINITIONS` 数组末尾：L406-409 的 `document_tasks` 条目之后、L410 的 `]` 之前
     追加两个条目（给 `document_tasks` 条目的收尾 `}` 补逗号）：

```ts
  {
    name: 'document_tasks',
    createTable: (db) => new DocumentTasksTable(db)
  },
  {
    name: 'resume_screening_tasks',
    createTable: (db) => new ResumeScreeningTasksTable(db)
  },
  {
    name: 'resume_screening_resumes',
    createTable: (db) => new ResumeScreeningResumesTable(db)
  }
]
```

  3. `createMainSchemaCatalog()` 内：L518 `const liveDelegationEvents = new LiveDelegationEventsTable(db)`
     之后追加两行实例化：

```ts
  const resumeScreeningTasks = new ResumeScreeningTasksTable(db)
  const resumeScreeningResumes = new ResumeScreeningResumesTable(db)
```

     再在 L520-560 createTables 数组末尾（L559 `liveDelegationEvents` 之后）追加两项：

```ts
    liveDelegations,
    liveDelegationTurns,
    liveDelegationEvents,
    resumeScreeningTasks,
    resumeScreeningResumes
  ]
```

- [ ] 跑 `pnpm typecheck` 确认无类型错误。

- [ ] Commit：`feat(resume-screening): add domain database`

---

## Task 6: 简历文本提取器 + 单测

**Files:**

- 新建：`src/main/resumeScreening/textExtractor.ts`
- 新建：`test/main/resumeScreening/textExtractor.test.ts`

**背景知识**：

- 三个适配器构造签名一致 `(filePath: string, maxFileSize: number)`，文本入口统一是
  `getContent(): Promise<string | undefined>`：
  - [PdfFileAdapter.ts](../../../src/main/file/adapters/PdfFileAdapter.ts) L31 / L228
  - [DocFileAdapter.ts](../../../src/main/file/adapters/DocFileAdapter.ts) L14 / L86
  - [TextFileAdapter.ts](../../../src/main/file/adapters/TextFileAdapter.ts) L19 / L29
- maxFileSize 复用应用既有设置键 `maxFileSize`（composition.ts L2873-2874 的取值方式：
  `settingsStore.get<number>('maxFileSize') ?? 30 * 1024 * 1024`），以 `getMaxFileSize` 回调注入保持可测。
- 扩展名白名单：`.pdf` / `.docx` / `.txt` / `.md`。不支持二进制 `.doc`（mammoth 仅支持 OOXML）、
  图片扫描件等；不支持时抛中文错误，Task 9 的 service 会把它落库为该简历的 error。
- 主进程测试可直接用 `@/` 别名 import（见 documentsTables.test.ts L1）。

### 步骤

- [ ] 先写测试 `test/main/resumeScreening/textExtractor.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ResumeTextExtractor } from '@/resumeScreening/textExtractor'

describe('ResumeTextExtractor', () => {
  let dir: string

  const extractor = new ResumeTextExtractor({ getMaxFileSize: () => 10 * 1024 * 1024 })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-extractor-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const writeFile = (name: string, content: string) => {
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  it('extracts text from txt and md files', async () => {
    const txt = await extractor.extract(writeFile('张三.txt', '张三的简历内容'))
    expect(txt).toBe('张三的简历内容')
    const md = await extractor.extract(writeFile('李四.md', '# 李四\n内容'))
    expect(md).toContain('李四')
  })

  it('throws on unsupported extension', async () => {
    const filePath = writeFile('王五.exe', 'binary-ish')
    await expect(extractor.extract(filePath)).rejects.toThrow('不支持的简历文件格式')
  })

  it('throws on empty text content', async () => {
    const filePath = writeFile('空简历.txt', '   \n  ')
    await expect(extractor.extract(filePath)).rejects.toThrow('无法提取文本')
  })
})
```

- [ ] 跑测试确认失败（模块不存在）：`pnpm vitest run test/main/resumeScreening/textExtractor.test.ts`。

- [ ] 最小实现 `src/main/resumeScreening/textExtractor.ts`：

```ts
import * as path from 'path'
import { DocFileAdapter } from '@/file/adapters/DocFileAdapter'
import { PdfFileAdapter } from '@/file/adapters/PdfFileAdapter'
import { TextFileAdapter } from '@/file/adapters/TextFileAdapter'

export interface ResumeTextExtractorDeps {
  getMaxFileSize: () => number
}

/** 按扩展名把简历文件分派给既有文件适配器，提取纯文本 */
export class ResumeTextExtractor {
  constructor(private readonly deps: ResumeTextExtractorDeps) {}

  async extract(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase()
    const maxFileSize = this.deps.getMaxFileSize()
    let adapter: { getContent(): Promise<string | undefined> }
    if (ext === '.pdf') {
      adapter = new PdfFileAdapter(filePath, maxFileSize)
    } else if (ext === '.docx') {
      adapter = new DocFileAdapter(filePath, maxFileSize)
    } else if (ext === '.txt' || ext === '.md') {
      adapter = new TextFileAdapter(filePath, maxFileSize)
    } else {
      throw new Error(`不支持的简历文件格式: ${ext || '(无扩展名)'}，仅支持 PDF / DOCX / TXT / MD`)
    }
    const content = await adapter.getContent()
    if (!content || !content.trim()) {
      throw new Error(`简历内容为空或无法提取文本: ${path.basename(filePath)}`)
    }
    return content
  }
}
```

- [ ] 跑测试确认通过：`pnpm vitest run test/main/resumeScreening/textExtractor.test.ts`。

- [ ] Commit：`feat(resume-screening): add text extractor`

---

## Task 7: 五角色提示词常量

**Files:**

- 新建：`src/main/resumeScreening/prompts.ts`

**背景知识**：

- 五角色流水线（spec §5）：①JD 解析官 → ②结构化提取员 → ③初筛专员 → ④资深面试官 → ⑤HR 主管。
- 每个角色的 system prompt 内声明输出 JSON 结构；user 消息由 Task 9 的 service 组装。
- 提取员输出对齐 [resume.yaml](../../specs/templates/resume.yaml)（resume_v1）的 18 个字段
  （snake_case），前端展示层按需取字段（契约层 `resumeInfo` 为宽松 `z.unknown()`）。
- ④⑤两个角色受 `config.generateExplanation` 开关控制，关闭时 service 直接跳过、不调用。
- 本文件只有常量，无逻辑，无需单独测试（service 测试会覆盖提示词注入路径）。

### 步骤

- [ ] 创建 `src/main/resumeScreening/prompts.ts`：

```ts
// 五角色流水线的 system prompt。每个角色都在 prompt 中声明输出 JSON 结构，由
// llmInvoker 统一负责解析与修复。user 消息由 service 按角色组装。

export const JD_ANALYST_SYSTEM_PROMPT = `你是资深的招聘岗位 JD 解析官。你的任务是阅读一段岗位 JD 原文，提取出三类信息：
1. responsibilities：岗位职责列表（每条一句话）
2. requirements：任职要求中的"必须具备"项（学历、经验、技能、证书等）
3. preferred：任职要求中的"优先/加分"项

要求：
- 只输出 JSON 对象，不要输出任何解释、markdown 代码围栏或其他文字
- 每类信息为字符串数组，无法提取时输出空数组
- 语言与 JD 原文保持一致
- 禁止编造 JD 中不存在的内容

输出格式：
{"responsibilities": ["..."], "requirements": ["..."], "preferred": ["..."]}`

export const EXTRACTOR_SYSTEM_PROMPT = `你是专业的简历结构化提取员。你的任务是阅读一份简历原文，输出结构化 JSON 信息。

输出 JSON 的字段定义（字段名必须完全一致，保持 snake_case）：
- name：姓名（字符串，必填）
- gender：性别（"男" / "女" / "未注明"）
- phone：手机号（字符串，去掉空格和分隔符）
- email：邮箱（字符串）
- birth_date：出生年月（字符串，如 "1995-06"）
- highest_degree：最高学历（"博士" / "硕士" / "本科" / "大专" / "其他"）
- university：最高学历对应毕业院校（字符串）
- major：专业（字符串）
- graduation_date：毕业时间（字符串，如 "2017-06"）
- work_years：工作年限（数字，明确写"X年"取该值；未写则按最早工作经历推算）
- recent_company：最近任职公司（字符串，必填）
- recent_position：最近职位（字符串，必填）
- expected_position：求职意向岗位（字符串）
- expected_salary：期望薪资（字符串，原样记录，如 "20-25K·14薪"）
- skills：技能标签（字符串数组，从技能栏/自我评价提炼，最多 10 个）
- work_history：工作经历（对象数组，每项 {"company", "position", "start", "end"}，end 至今填当天日期）
- education_history：教育经历（对象数组，每项 {"school", "degree", "major", "start", "end"}）

要求：
- 只输出 JSON 对象，不要输出任何解释、markdown 代码围栏或其他文字
- 简历中没有的字段输出 null（数组字段输出空数组）
- 禁止编造简历中不存在的内容`

export const SCREENING_SYSTEM_PROMPT = `你是严格的简历初筛专员。你会收到一份岗位 JD 分析（JSON）和一份候选人简历的结构化信息（JSON）。你的任务是从人岗匹配角度给出初筛结论。

评估维度：学历与专业匹配、工作年限与经验相关性、技能覆盖度、岗位职责契合度。

要求：
- 只输出 JSON 对象，不要输出任何解释、markdown 代码围栏或其他文字
- score：0-100 的整数匹配分
- recommended：是否推荐进入下一环节（布尔值，score >= 60 视为 true）
- conclusion：一句话结论，说明推荐或淘汰的核心理由
- strengths：候选人亮点列表（字符串数组，最多 5 条）

输出格式：
{"score": 85, "recommended": true, "conclusion": "...", "strengths": ["..."]}`

export const INTERVIEWER_SYSTEM_PROMPT = `你是资深面试官。你会收到一份岗位 JD 分析（JSON）、候选人简历结构化信息（JSON）和初筛结论（JSON）。你的任务是为面试环节做准备。

要求：
- 只输出 JSON 对象，不要输出任何解释、markdown 代码围栏或其他文字
- highlights：值得在面试中深挖的亮点（字符串数组，最多 5 条）
- risks：简历中值得关注的疑点或风险（如空窗期、频繁跳槽、技能描述模糊）（字符串数组，最多 5 条）
- questions：建议的面试问题（字符串数组，3-5 条，结合 JD 与简历定制，禁止通用模板问题）

输出格式：
{"highlights": ["..."], "risks": ["..."], "questions": ["..."]}`

export const HR_MANAGER_SYSTEM_PROMPT = `你是经验丰富的 HR 主管，负责给出最终综合评价。你会收到岗位 JD 分析、候选人简历结构化信息、初筛结论和面试官评估（均为 JSON）。

要求：
- 只输出 JSON 对象，不要输出任何解释、markdown 代码围栏或其他文字
- finalSummary：面向筛选决策者的 2-3 句综合评价，明确给出是否建议推进
- hrOpinion：从稳定性、薪资期望匹配度、发展潜力等 HR 视角给出的一句话意见

输出格式：
{"finalSummary": "...", "hrOpinion": "..."}`
```

- [ ] 跑 `pnpm typecheck` 确认无类型错误。

- [ ] Commit：`feat(resume-screening): add role prompts`

---

## Task 8: LLM 调用器（限速 + JSON 修复 + 重试）+ 单测

**Files:**

- 新建：`src/main/resumeScreening/llmInvoker.ts`
- 新建：`test/main/resumeScreening/llmInvoker.test.ts`

**背景知识**：

- LLM 直调两步（先限速后补全）：
  - `providerRuntime.executeWithRateLimit(providerId, { signal })`（[provider/index.ts](../../../src/main/provider/index.ts) L417，
    `options?: { signal?: AbortSignal; onQueued?...; scope? }`）
  - `providerRuntime.generateCompletionStandalone(providerId, messages: ChatMessage[], modelId, temperature?, maxTokens?, { signal?, swallowErrors? })`
    （[provider/index.ts](../../../src/main/provider/index.ts) L491-498），必须传 `{ swallowErrors: false }`
    让错误向上抛（composition.ts L2878-2885 的 documentExtractor 先例）。
- `ChatMessage` 类型：`import type { ChatMessage } from '@shared/types/core/chat-message'`
  （`{ role: 'system' | 'user' | 'assistant' | 'tool', content?: string | ... }`）。
- JSON 修复：`import { jsonrepair } from 'jsonrepair'`（named import，仓库先例 tool/index.ts L57；
  package.json 已有 `"jsonrepair": "^3.14.0"`）。
- deps 注入 `executeWithRateLimit` / `generateCompletion` 两个回调，composition 装配时指向
  providerRuntime（Task 10），测试用 fake。

### 步骤

- [ ] 先写测试 `test/main/resumeScreening/llmInvoker.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { ResumeLlmInvoker } from '@/resumeScreening/llmInvoker'

const makeDeps = () => {
  const calls: string[] = []
  const executeWithRateLimit = vi.fn(async () => {
    calls.push('rateLimit')
  })
  let responses: string[] = []
  const generateCompletion = vi.fn(async () => {
    calls.push('completion')
    return responses.shift() ?? ''
  })
  return {
    calls,
    executeWithRateLimit,
    generateCompletion,
    setResponses: (list: string[]) => {
      responses = [...list]
    }
  }
}

const baseOptions = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  systemPrompt: 'system-prompt',
  userPrompt: 'user-prompt'
}

describe('ResumeLlmInvoker', () => {
  it('parses plain JSON and calls rate limit before completion', async () => {
    const deps = makeDeps()
    deps.setResponses(['{"score": 85}'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ score: number }>(baseOptions)
    expect(result.score).toBe(85)
    expect(deps.calls).toEqual(['rateLimit', 'completion'])
  })

  it('strips markdown fences before parsing', async () => {
    const deps = makeDeps()
    deps.setResponses(['```json\n{"ok": true}\n```'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ ok: boolean }>(baseOptions)
    expect(result.ok).toBe(true)
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
  })

  it('retries once with context when first output is not JSON', async () => {
    const deps = makeDeps()
    deps.setResponses(['抱歉，我无法回答。', '{"ok": 1}'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ ok: number }>(baseOptions)
    expect(result.ok).toBe(1)
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    const retryMessages = deps.generateCompletion.mock.calls[1][1] as Array<{
      role: string
      content?: string
    }>
    expect(retryMessages).toHaveLength(4)
    expect(retryMessages[2]).toMatchObject({ role: 'assistant' })
    expect(retryMessages[3]).toMatchObject({ role: 'user' })
    expect(String(retryMessages[3].content)).toContain('JSON')
  })

  it('throws when both attempts fail to parse', async () => {
    const deps = makeDeps()
    deps.setResponses(['bad 1', 'bad 2'])
    const invoker = new ResumeLlmInvoker(deps)
    await expect(invoker.invokeJson(baseOptions)).rejects.toThrow('两次输出均无法解析')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
  })

  it('forwards the abort signal to both calls', async () => {
    const deps = makeDeps()
    deps.setResponses(['{}'])
    const invoker = new ResumeLlmInvoker(deps)
    const controller = new AbortController()
    await invoker.invokeJson({ ...baseOptions, signal: controller.signal })
    expect(deps.executeWithRateLimit.mock.calls[0][1]).toEqual({ signal: controller.signal })
    expect(deps.generateCompletion.mock.calls[0][5]).toMatchObject({ signal: controller.signal })
  })
})
```

- [ ] 跑测试确认失败（模块不存在）：`pnpm vitest run test/main/resumeScreening/llmInvoker.test.ts`。

- [ ] 最小实现 `src/main/resumeScreening/llmInvoker.ts`：

```ts
import type { ChatMessage } from '@shared/types/core/chat-message'
import { jsonrepair } from 'jsonrepair'

export interface ResumeLlmInvokerDeps {
  executeWithRateLimit: (providerId: string, options?: { signal?: AbortSignal }) => Promise<void>
  generateCompletion: (
    providerId: string,
    messages: ChatMessage[],
    modelId: string,
    temperature: number | undefined,
    maxTokens: number | undefined,
    options?: { signal?: AbortSignal; swallowErrors?: boolean }
  ) => Promise<string>
}

export interface ResumeLlmInvokeOptions {
  providerId: string
  modelId: string
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 单角色 LLM 调用：限速 → 补全 → 清理围栏 → jsonrepair 解析；失败带上下文重试一次 */
export class ResumeLlmInvoker {
  constructor(private readonly deps: ResumeLlmInvokerDeps) {}

  async invokeJson<T>(options: ResumeLlmInvokeOptions): Promise<T> {
    await this.deps.executeWithRateLimit(options.providerId, { signal: options.signal })
    const messages: ChatMessage[] = [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt }
    ]
    const first = await this.deps.generateCompletion(
      options.providerId,
      messages,
      options.modelId,
      options.temperature,
      options.maxTokens,
      { signal: options.signal, swallowErrors: false }
    )
    const parsed = this.tryParse<T>(first)
    if (parsed !== null) {
      return parsed
    }
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first },
      {
        role: 'user',
        content:
          '你的上一条回复不是合法的 JSON。请重新回复，只输出符合要求的 JSON，不要包含任何解释、markdown 代码围栏或其他文字。'
      }
    ]
    const second = await this.deps.generateCompletion(
      options.providerId,
      retryMessages,
      options.modelId,
      options.temperature,
      options.maxTokens,
      { signal: options.signal, swallowErrors: false }
    )
    const reparsed = this.tryParse<T>(second)
    if (reparsed !== null) {
      return reparsed
    }
    throw new Error('模型两次输出均无法解析为 JSON')
  }

  private tryParse<T>(raw: string): T | null {
    try {
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim()
      return JSON.parse(jsonrepair(cleaned)) as T
    } catch {
      return null
    }
  }
}
```

- [ ] 跑测试确认通过：`pnpm vitest run test/main/resumeScreening/llmInvoker.test.ts`。

- [ ] Commit：`feat(resume-screening): add llm invoker`

---

## Task 9: 五角色流水线编排服务 + 单测

**Files:**
- 新建 `src/main/resumeScreening/service.ts`
- 新建 `test/main/resumeScreening/service.test.ts`

**背景知识**

本任务是简历筛选域的核心编排层：把前 8 个任务产出的事件契约、表类、JD 分析/五角色 prompt、文本提取器、LLM 调用器装配成「建任务 → JD 解析 → 并发处理简历 → 终态落库与事件发布」的完整流水线。所有 LLM 角色调用经 `ResumeLlmInvoker.invokeJson`（Task 8），所有落库经 `ResumeScreeningDatabase`（Task 5）的 `tasksTable` / `resumesTable` getter，所有事件经依赖注入的 `publishTaskUpdated` / `publishResumeUpdated` 回调发出（renderer 侧 Task 11 用 `bridge.on` 订阅，Task 15 在页面装配落地）。

关键约束：
- 生命周期与 `AbortController`：每个任务一个 controller 存 `abortControllers` Map；取消时 abort 并立即落 cancelled 终态；`runTask` 的 catch 分支看到 aborted 时不碰数据库（db 可能已关）。
- 简历阶段追踪：`resumeStages` Map 记录 running 简历的当前阶段（extracting/screening/interviewing/hr），发布事件时带出，简历终态后删除。
- 取消/失败语义：取消时 `cancelTask` 负责把任务置 cancelled 并 `markUnfinishedAsFailed('已取消')`；单份简历失败不中断任务（继续并发处理）；JD 解析失败则任务整体 failed。
- 复制失败的简历在 `processResume` 顶部直接 return（保住「简历文件复制失败」的 error 不被覆盖），由任务收尾统一记入 failed 统计。

### 步骤

- [ ] 写失败测试：新建 `test/main/resumeScreening/service.test.ts`：

```ts
import { mkdtemp, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const Database = sqliteModule?.default
const DatabaseCtor = Database!

type ResumeLlmInvoker = import('jsonrepair') extends never ? never : import('@/resumeScreening/llmInvoker').ResumeLlmInvoker
type {
  ResumeScreeningServiceDeps,
  ResumeScreeningTaskUpdatedPayload,
  ResumeScreeningResumeUpdatedPayload,
  CreateResumeScreeningTaskInput,
} from '@/resumeScreening/service'
import {
  JD_ANALYST_SYSTEM_PROMPT,
  EXTRACTOR_SYSTEM_PROMPT,
  SCREENING_SYSTEM_PROMPT,
  INTERVIEWER_SYSTEM_PROMPT,
  HR_MANAGER_SYSTEM_PROMPT,
} from '@/resumeScreening/prompts'

const tasksModule = Database
  ? await import('@/resumeScreening/tasks')
  : null
const resumesModule = Database
  ? await import('@/resumeScreening/resumes')
  : null
const databaseModule = Database
  ? await import('@/resumeScreening/database')
  : null
const serviceModule = await import('@/resumeScreening/service')

let sqliteAvailable = false
if (Database) {
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  sqliteAvailable = true
}

const describeIfSqlite = sqliteAvailable && tasksModule && resumesModule && databaseModule ? describe : describe.skip

const serviceDir = tmpdir()

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(() => {
  vi.restoreAllMocks()
})

function scriptInvoker(responses: Record<string, unknown>): Pick<import('@/resumeScreening/llmInvoker').ResumeLlmInvoker, 'invokeJson'> {
  return {
    invokeJson: vi.fn(async (options: { systemPrompt: string }) => {
      const response = responses[options.systemPrompt]
      if (response === undefined) {
        throw new Error(`未脚本化的角色调用: ${options.systemPrompt.slice(0, 16)}`)
      }
      return JSON.parse(JSON.stringify(response))
    }),
  }
}

const FULL_SCRIPT: Record<string, unknown> = {
  [JD_ANALYST_SYSTEM_PROMPT]: {
    responsibilities: ['开发 Web 应用'],
    requirements: ['三年经验'],
    preferred: ['英语流利'],
  },
  [EXTRACTOR_SYSTEM_PROMPT]: {
    name: '张三',
    email: 'zhang@example.com',
    skills: ['Vue', 'TypeScript'],
    experience: ['某公司前端工程师 2020-2024'],
  },
  [SCREENING_SYSTEM_PROMPT]: {
    score: 88,
    recommended: true,
    conclusion: '高度匹配',
    strengths: ['技术栈吻合'],
  },
  [INTERVIEWER_SYSTEM_PROMPT]: {
    highlights: ['项目经验丰富'],
    risks: ['缺少大促经验'],
    questions: ['介绍一次重构经历'],
  },
  [HR_MANAGER_SYSTEM_PROMPT]: {
    finalSummary: '建议进入下一轮',
    hrOpinion: '薪资期望待确认',
  },
}

function makeSetup() {
  const db = new DatabaseCtor(':memory:')
  const tasksTable = new tasksModule!.ResumeScreeningTasksTable(db)
  const resumesTable = new resumesModule!.ResumeScreeningResumesTable(db)
  tasksTable.createTable()
  resumesTable.createTable()
  const database = new databaseModule!.ResumeScreeningDatabase({ getDatabase: () => db })
  const publishedTasks: import('@/resumeScreening/service').ResumeScreeningTaskUpdatedPayload[] = []
  const publishedResumes: import('@/resumeScreening/service').ResumeScreeningResumeUpdatedPayload[] = []
  const copied: Array<[string, string]> = []
  const deps: import('@/resumeScreening/service').ResumeScreeningServiceDeps = {
    database,
    invoker: scriptInvoker(FULL_SCRIPT),
    textExtractor: {
      extract: vi.fn(async (filePath: string) =>
        filePath.endsWith('jd.txt') ? 'JD 文件内容' : '张三的简历内容',
      ),
    },
    storageDir: path.join(serviceDir, 'resume-service-root'),
    copyFile: vi.fn(async (src: string, dest: string) => {
      copied.push([src, dest])
    }),
    getProfile: vi.fn(() => ({ name: '张三', email: 'zhang@example.com' })),
    saveProfile: vi.fn(),
    getDefaultModel: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
    listModels: vi.fn(() => []),
    publishTaskUpdated: vi.fn((payload: import('@/resumeScreening/service').ResumeScreeningTaskUpdatedPayload) => {
      publishedTasks.push(payload)
    }),
    publishResumeUpdated: vi.fn((payload: import('@/resumeScreening/service').ResumeScreeningResumeUpdatedPayload) => {
      publishedResumes.push(payload)
    }),
    now: () => 1000,
  }
  const service = new serviceModule.ResumeScreeningService(deps)
  return { db, deps, service, publishedTasks, publishedResumes, copied }
}

function makeTaskInput(
  overrides?: Partial<import('@/resumeScreening/service').CreateResumeScreeningTaskInput>,
): import('@/resumeScreening/service').CreateResumeScreeningTaskInput {
  return {
    jdSource: 'text',
    jdText: '前端工程师 JD：负责 Web 应用开发',
    resumes: [{ path: '/upload/张三.pdf', name: '张三.pdf', mimeType: 'application/pdf', size: 1024 }],
    config: { generateExplanation: true, includeRawText: false, maxConcurrency: 2 },
    ...overrides,
  }
}

function waitForTaskStatus(
  deps: import('@/resumeScreening/service').ResumeScreeningServiceDeps,
  taskId: string,
  status: string,
): import('@/resumeScreening/tasks').ResumeScreeningTaskRow {
  for (let i = 0; i < 200; i++) {
    const task = deps.database.tasksTable.get(taskId)
    if (task && task.status === status) return task
    const syncStart = Date.now()
    while (Date.now() - syncStart < 10) {
      /* 忙等 10ms，保持同步轮询语义 */
    }
  }
  throw new Error(`等待任务 ${taskId} 进入状态 ${status} 超时`)
}

describeIfSqlite('ResumeScreeningService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('完整流水线：建任务 → JD 解析 → 四阶段单简历 → completed 终态与事件', async () => {
    const { db, deps, service, publishedTasks, publishedResumes, copied } = makeSetup()
    const created = await service.createTask(makeTaskInput())

    expect(created.provider_id).toBe('openai')
    expect(created.model_id).toBe('gpt-4o')
    expect(created.created_by_name).toBe('张三')
    expect(created.total).toBe(1)

    const task = waitForTaskStatus(deps, created.id, 'completed')
    const resumes = deps.database.resumesTable.listByTask(created.id)
    expect(resumes).toHaveLength(1)
    const resume = resumes[0]!
    expect(resume.status).toBe('done')
    expect(resume.candidate_name).toBe('张三')
    // includeRawText 仅控制事件/DTO 是否携带原文，数据库始终落库
    expect(resume.raw_text).toBe('张三的简历内容')
    expect(resume.interview_json).not.toBeNull()
    expect(JSON.parse(resume.interview_json!)).toMatchObject({ questions: ['介绍一次重构经历'] })
    expect(resume.hr_json).not.toBeNull()
    expect(JSON.parse(resume.hr_json!)).toMatchObject({ finalSummary: '建议进入下一轮' })
    expect(resume.score).toBe(88)
    expect(resume.recommended).toBe(1)

    // 简历文件已复制进 storageDir/<taskId>/ 且扩展名保留
    expect(copied).toHaveLength(1)
    expect(resume.file_path).toBe(copied[0]![1])
    expect(path.basename(resume.file_path)).toMatch(/\.pdf$/)

    // JD 恰好调用一次
    const jdCalls = vi
      .mocked(deps.invoker.invokeJson)
      .mock.calls.filter((call) => (call[0] as { systemPrompt: string }).systemPrompt === JD_ANALYST_SYSTEM_PROMPT)
    expect(jdCalls).toHaveLength(1)

    expect(task).toMatchObject({ succeeded: 1, failed: 0, recommended_count: 1, avg_score: 88 })
    expect(publishedTasks[publishedTasks.length - 1]).toMatchObject({ taskId: created.id, status: 'completed' })
    const stages = publishedResumes.map((payload) => payload.stage).filter((stage) => stage !== null)
    expect(new Set(stages)).toEqual(new Set(['extracting', 'screening', 'interviewing', 'hr']))
    expect(publishedResumes[publishedResumes.length - 1]).toMatchObject({ status: 'done', stage: null })
    db.close()
  })

  it('generateExplanation=false 时跳过面试官与 HR 角色', async () => {
    const { db, deps, service } = makeSetup()
    const input = makeTaskInput({ config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 } })
    const created = await service.createTask(input)
    waitForTaskStatus(deps, created.id, 'completed')

    const byPrompt = (systemPrompt: string) =>
      vi
        .mocked(deps.invoker.invokeJson)
        .mock.calls.filter((call) => (call[0] as { systemPrompt: string }).systemPrompt === systemPrompt)
    expect(byPrompt(INTERVIEWER_SYSTEM_PROMPT)).toHaveLength(0)
    expect(byPrompt(HR_MANAGER_SYSTEM_PROMPT)).toHaveLength(0)

    const resume = deps.database.resumesTable.listByTask(created.id)[0]!
    expect(resume.interview_json).toBeNull()
    expect(resume.hr_json).toBeNull()
    expect(resume.score).toBe(88)
    db.close()
  })

  it('单份简历失败时任务为 partial', async () => {
    const { db, deps, service } = makeSetup()
    const scripted = scriptInvoker(FULL_SCRIPT)
    let screeningCalls = 0
    const wrapper: Pick<import('@/resumeScreening/llmInvoker').ResumeLlmInvoker, 'invokeJson'> = {
      invokeJson: async (options) => {
        if (options.systemPrompt === SCREENING_SYSTEM_PROMPT) {
          screeningCalls += 1
          if (screeningCalls === 1) throw new Error('模型输出异常')
        }
        return scripted.invokeJson(options)
      },
    }
    deps.invoker = wrapper
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/甲.pdf', name: '甲.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/乙.pdf', name: '乙.pdf', mimeType: 'application/pdf', size: 1 },
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 1 },
      }),
    )
    const task = waitForTaskStatus(deps, created.id, 'partial')

    const statuses = deps.database.resumesTable
      .listByTask(created.id)
      .map((resume) => resume.status)
      .sort()
    expect(statuses).toEqual(['done', 'failed'])
    const failed = deps.database.resumesTable.listByTask(created.id).find((resume) => resume.status === 'failed')
    expect(failed!.error).toBe('模型输出异常')
    expect(screeningCalls).toBe(2)
    expect(task).toMatchObject({ succeeded: 1, failed: 1 })
    db.close()
  })

  it('全部简历失败时任务为 failed', async () => {
    const { db, deps, service } = makeSetup()
    const scripted = scriptInvoker(FULL_SCRIPT)
    deps.invoker = {
      invokeJson: async (options) => {
        if (options.systemPrompt === SCREENING_SYSTEM_PROMPT) throw new Error('初筛崩溃')
        return scripted.invokeJson(options)
      },
    }
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/甲.pdf', name: '甲.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/乙.pdf', name: '乙.pdf', mimeType: 'application/pdf', size: 1 },
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 },
      }),
    )
    const task = waitForTaskStatus(deps, created.id, 'failed')
    expect(task).toMatchObject({ succeeded: 0, failed: 2 })
    db.close()
  })

  it('并发上限被严格遵守', async () => {
    const { db, deps, service } = makeSetup()
    let active = 0
    let maxActive = 0
    let extractCalls = 0
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const baseExtract = deps.textExtractor.extract
    deps.textExtractor = {
      extract: async (filePath: string) => {
        active += 1
        extractCalls += 1
        maxActive = Math.max(maxActive, active)
        await sleep(20)
        active -= 1
        return baseExtract(filePath)
      },
    }
    const created = await service.createTask(
      makeTaskInput({
        resumes: ['甲', '乙', '丙', '丁'].map((name) => ({
          path: `/upload/${name}.pdf`,
          name: `${name}.pdf`,
          mimeType: 'application/pdf',
          size: 1,
        })),
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 },
      }),
    )
    waitForTaskStatus(deps, created.id, 'completed')
    expect(maxActive).toBe(2)
    expect(extractCalls).toBe(4)
    db.close()
  })

  it('cancelTask 中止运行中的任务并把未完成简历标记为已取消', async () => {
    const { db, deps, service, publishedTasks } = makeSetup()
    const hangingInvoker = {
      invokeJson: <T>(options: { signal?: AbortSignal }) =>
        new Promise<T>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted')),
            { once: true },
          )
        }),
    }
    deps.invoker = hangingInvoker
    const created = await service.createTask(makeTaskInput())
    expect(service.cancelTask(created.id)).toBe(true)

    const task = deps.database.tasksTable.get(created.id)!
    expect(task.status).toBe('cancelled')
    const resume = deps.database.resumesTable.listByTask(created.id)[0]!
    expect(resume.status).toBe('failed')
    expect(resume.error).toBe('已取消')
    expect(service.cancelTask(created.id)).toBe(false)
    expect(publishedTasks[publishedTasks.length - 1]).toMatchObject({ status: 'cancelled' })
    db.close()
  })

  it('JD 文件模式读取文件内容，空 JD 拒绝建任务', async () => {
    const { db, deps, service } = makeSetup()
    const created = await service.createTask(
      makeTaskInput({ jdSource: 'file', jdFilePath: '/fake/jd.txt', jdFileName: undefined }),
    )
    expect(created.jd_text).toBe('JD 文件内容')
    expect(created.jd_file_name).toBe('jd.txt')
    // JD 文件 1 次 + 简历 1 次
    expect(deps.textExtractor.extract).toHaveBeenCalledTimes(2)
    waitForTaskStatus(deps, created.id, 'completed')

    await expect(service.createTask(makeTaskInput({ jdText: '   ' }))).rejects.toThrow('请填写岗位 JD')
    db.close()
  })

  it('简历文件复制失败时该简历直接 failed 且不进入流水线', async () => {
    const { db, deps, service } = makeSetup()
    deps.copyFile = vi.fn(async (src: string) => {
      if (src.includes('坏')) throw new Error('磁盘已满')
    })
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/张三.pdf', name: '张三.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/坏简历.pdf', name: '坏简历.pdf', mimeType: 'application/pdf', size: 1 },
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 1 },
      }),
    )
    waitForTaskStatus(deps, created.id, 'partial')

    const resumes = deps.database.resumesTable.listByTask(created.id)
    const bad = resumes.find((resume) => resume.file_name === '坏简历.pdf')!
    expect(bad.status).toBe('failed')
    expect(bad.error).toContain('简历文件复制失败')
    expect(bad.error).toContain('磁盘已满')
    const good = resumes.find((resume) => resume.file_name === '张三.pdf')!
    expect(good.status).toBe('done')
    expect(deps.database.tasksTable.get(created.id)).toMatchObject({ succeeded: 1, failed: 1 })
    db.close()
  })

  it('recoverInterruptedTasks 把启动时仍为 running/queued 的任务标记为失败', () => {
    const { db, deps, service } = makeSetup()
    const first = deps.database.tasksTable.insert({
      jdSource: 'text',
      jdText: 'JD 甲',
      configJson: JSON.stringify({ generateExplanation: true, includeRawText: false, maxConcurrency: 2 }),
      providerId: 'openai',
      modelId: 'gpt-4o',
      total: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com',
    })
    const second = deps.database.tasksTable.insert({
      jdSource: 'text',
      jdText: 'JD 乙',
      configJson: JSON.stringify({ generateExplanation: true, includeRawText: false, maxConcurrency: 2 }),
      providerId: 'openai',
      modelId: 'gpt-4o',
      total: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com',
    })
    deps.database.tasksTable.update(second.id, { status: 'running', startedAt: 1000 })
    deps.database.resumesTable.insert({ id: 'r-1', taskId: first.id, fileName: '甲.pdf', filePath: '/x/甲.pdf' })
    deps.database.resumesTable.insert({ id: 'r-2', taskId: second.id, fileName: '乙.pdf', filePath: '/x/乙.pdf' })

    service.recoverInterruptedTasks()

    for (const taskId of [first.id, second.id]) {
      expect(deps.database.tasksTable.get(taskId)!.status).toBe('failed')
    }
    const resumes = deps.database.resumesTable
    expect(resumes.get('r-1')!.status).toBe('failed')
    expect(resumes.get('r-1')!.error).toBe('应用重启导致任务中断')
    expect(resumes.get('r-2')!.status).toBe('failed')
    expect(resumes.get('r-2')!.error).toBe('应用重启导致任务中断')
    db.close()
  })

  it('getProfile 归一化空档案，updateProfile 合并保存', () => {
    const { db, deps, service } = makeSetup()
    deps.getProfile = vi.fn(() => undefined)
    expect(service.getProfile()).toEqual({ name: '', email: '' })
    const next = service.updateProfile({ name: '李四' })
    expect(next).toEqual({ name: '李四', email: '' })
    expect(deps.saveProfile).toHaveBeenCalledWith({ name: '李四', email: '' })
    db.close()
  })

  it('listModels 透传模型目录', () => {
    const { db, deps, service } = makeSetup()
    deps.listModels = vi.fn(() => [
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o', modelName: 'GPT-4o', isDefault: true },
    ])
    expect(service.listModels()).toEqual([
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o', modelName: 'GPT-4o', isDefault: true },
    ])
    db.close()
  })

  it('未选择模型且应用无默认模型时拒绝建任务', async () => {
    const { db, deps, service } = makeSetup()
    deps.getDefaultModel = vi.fn(() => undefined)
    await expect(service.createTask(makeTaskInput({ providerId: undefined, modelId: undefined }))).rejects.toThrow(
      '未选择模型且应用未设置默认模型',
    )
    db.close()
  })
})
```

注意测试侧的类型引用统一用 `import('...')` 内联类型（避免顶部大量 type import 与 sqlite 守卫动态 import 冲突），`ResumeLlmInvoker` 类型直接来自 `@/resumeScreening/llmInvoker`。若 oxfmt 对内联 import type 有格式要求，以 `pnpm format` 结果为准。

- [ ] 跑测试确认失败（`service.ts` 尚不存在导致 import 报错）：`pnpm vitest run test/main/resumeScreening/service.test.ts`

- [ ] 最小实现：新建 `src/main/resumeScreening/service.ts`：

```ts
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { z } from 'zod'
import {
  resumeScreeningTaskUpdatedEvent,
  resumeScreeningResumeUpdatedEvent,
} from '@shared/contracts/events/resumeScreening.events'
import type {
  resumeScreeningJdAnalysisSchema,
  resumeScreeningScreeningSchema,
  resumeScreeningInterviewSchema,
  resumeScreeningHrSchema,
  resumeScreeningProfileSchema,
  resumeScreeningTaskStatusSchema,
  resumeScreeningResumeStatusSchema,
} from '@shared/contracts/routes/resumeScreening.routes'
import {
  JD_ANALYST_SYSTEM_PROMPT,
  EXTRACTOR_SYSTEM_PROMPT,
  SCREENING_SYSTEM_PROMPT,
  INTERVIEWER_SYSTEM_PROMPT,
  HR_MANAGER_SYSTEM_PROMPT,
} from '@/resumeScreening/prompts'
import type { ResumeScreeningDatabase } from '@/resumeScreening/database'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/tasks'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/resumes'
import type { ResumeLlmInvoker } from '@/resumeScreening/llmInvoker'
import type { ResumeTextExtractor } from '@/resumeScreening/textExtractor'

export type ResumeScreeningJdAnalysis = z.infer<typeof resumeScreeningJdAnalysisSchema>
export type ResumeScreeningScreening = z.infer<typeof resumeScreeningScreeningSchema>
export type ResumeScreeningInterview = z.infer<typeof resumeScreeningInterviewSchema>
export type ResumeScreeningHr = z.infer<typeof resumeScreeningHrSchema>
export type ResumeScreeningProfile = z.infer<typeof resumeScreeningProfileSchema>
export type ResumeScreeningTaskStatus = z.infer<typeof resumeScreeningTaskStatusSchema>
export type ResumeScreeningResumeStatus = z.infer<typeof resumeScreeningResumeStatusSchema>
export type ResumeScreeningTaskUpdatedPayload = z.infer<typeof resumeScreeningTaskUpdatedEvent.payload>
export type ResumeScreeningResumeUpdatedPayload = z.infer<typeof resumeScreeningResumeUpdatedEvent.payload>

export type ResumeScreeningStage = 'extracting' | 'screening' | 'interviewing' | 'hr'

export interface ResumeScreeningTaskConfig {
  generateExplanation: boolean
  includeRawText: boolean
  maxConcurrency: number
}

export interface ResumeScreeningModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  isDefault: boolean
}

export interface CreateResumeScreeningTaskInput {
  jdSource: 'text' | 'file'
  jdText?: string
  jdFilePath?: string
  jdFileName?: string
  resumes: Array<{ path: string; name: string; mimeType?: string; size?: number }>
  config: ResumeScreeningTaskConfig
  providerId?: string
  modelId?: string
}

export interface ResumeScreeningServiceDeps {
  database: ResumeScreeningDatabase
  invoker: Pick<ResumeLlmInvoker, 'invokeJson'>
  textExtractor: Pick<ResumeTextExtractor, 'extract'>
  storageDir: string
  copyFile: (src: string, dest: string) => Promise<void>
  getProfile: () => ResumeScreeningProfile | undefined
  saveProfile: (profile: ResumeScreeningProfile) => void
  getDefaultModel: () => { providerId: string; modelId: string } | undefined
  listModels: () => ResumeScreeningModelOption[]
  publishTaskUpdated: (payload: ResumeScreeningTaskUpdatedPayload) => void
  publishResumeUpdated: (payload: ResumeScreeningResumeUpdatedPayload) => void
  now: () => number
}

const STAGE_KEYS = ['extracting', 'screening', 'interviewing', 'hr'] as const

/** 五角色简历筛选流水线编排：建任务 → JD 解析 → 并发处理简历 → 终态落库与事件发布 */
export class ResumeScreeningService {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly resumeStages = new Map<string, ResumeScreeningStage>()

  constructor(private readonly deps: ResumeScreeningServiceDeps) {}

  private get tasksTable() {
    return this.deps.database.tasksTable
  }

  private get resumesTable() {
    return this.deps.database.resumesTable
  }

  async createTask(input: CreateResumeScreeningTaskInput): Promise<ResumeScreeningTaskRow> {
    const providerId = input.providerId ?? this.deps.getDefaultModel()?.providerId
    const modelId = input.modelId ?? this.deps.getDefaultModel()?.modelId
    if ((input.providerId === undefined) !== (input.modelId === undefined)) {
      throw new Error('providerId 与 modelId 必须同时提供')
    }
    if (providerId === undefined || modelId === undefined) {
      throw new Error('未选择模型且应用未设置默认模型')
    }

    let jdText: string
    let jdFileName: string
    if (input.jdSource === 'file') {
      if (!input.jdFilePath) throw new Error('缺少 JD 文件路径')
      jdText = await this.deps.textExtractor.extract(input.jdFilePath)
      jdFileName = input.jdFileName ?? path.basename(input.jdFilePath)
    } else {
      jdText = (input.jdText ?? '').trim()
      jdFileName = input.jdFileName ?? ''
    }
    if (!jdText) throw new Error('请填写岗位 JD 或选择 JD 文件')

    const profile = this.deps.getProfile()
    const task = this.tasksTable.insert({
      jdSource: input.jdSource,
      jdText,
      jdFileName,
      configJson: JSON.stringify(input.config),
      providerId,
      modelId,
      total: input.resumes.length,
      createdByName: profile?.name ?? '',
      createdByEmail: profile?.email ?? '',
      now: this.deps.now(),
    })

    const taskDir = path.join(this.deps.storageDir, task.id)
    await mkdir(taskDir, { recursive: true })
    for (const item of input.resumes) {
      const id = randomUUID()
      const ext = path.extname(item.name).toLowerCase()
      const destPath = path.join(taskDir, `${id}${ext}`)
      this.resumesTable.insert({
        id,
        taskId: task.id,
        fileName: item.name,
        filePath: destPath,
        mimeType: item.mimeType,
        size: item.size ?? 0,
        now: this.deps.now(),
      })
      try {
        await this.deps.copyFile(item.path, destPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.resumesTable.update(id, {
          status: 'failed',
          error: `简历文件复制失败: ${message}`,
          now: this.deps.now(),
        })
      }
      this.publishResumeUpdate(id)
    }

    const controller = new AbortController()
    this.abortControllers.set(task.id, controller)
    void this.runTask(task.id, controller).catch((error) => {
      console.error('[ResumeScreeningService] 任务执行异常:', error)
    })
    return this.tasksTable.get(task.id)!
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasksTable.get(taskId)
    if (!task || (task.status !== 'queued' && task.status !== 'running')) return false
    this.abortControllers.get(taskId)?.abort()
    const stats = this.resumesTable.getTaskStats(taskId)
    this.tasksTable.update(taskId, {
      status: 'cancelled',
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      finishedAt: this.deps.now(),
      now: this.deps.now(),
    })
    this.resumesTable.markUnfinishedAsFailed(taskId, '已取消', this.deps.now())
    this.abortControllers.delete(taskId)
    this.publishTaskUpdate(taskId)
    return true
  }

  getTask(taskId: string): { task: ResumeScreeningTaskRow; resumes: ResumeScreeningResumeRow[] } | undefined {
    const task = this.tasksTable.get(taskId)
    if (!task) return undefined
    return { task, resumes: this.resumesTable.listByTask(taskId) }
  }

  listTasks(limit = 100): ResumeScreeningTaskRow[] {
    return this.tasksTable.listRecent(limit)
  }

  getProfile(): ResumeScreeningProfile {
    const stored = this.deps.getProfile()
    return { name: stored?.name ?? '', email: stored?.email ?? '' }
  }

  updateProfile(input: Partial<ResumeScreeningProfile>): ResumeScreeningProfile {
    const current = this.getProfile()
    const next: ResumeScreeningProfile = {
      name: input.name ?? current.name,
      email: input.email ?? current.email,
    }
    this.deps.saveProfile(next)
    return next
  }

  listModels(): ResumeScreeningModelOption[] {
    return this.deps.listModels()
  }

  /** 应用启动时调用：把上次未跑完的任务统一标记为失败，避免永久卡在 running */
  recoverInterruptedTasks(): void {
    for (const task of this.tasksTable.listActive()) {
      this.tasksTable.update(task.id, {
        status: 'failed',
        finishedAt: this.deps.now(),
        now: this.deps.now(),
      })
      this.resumesTable.markUnfinishedAsFailed(task.id, '应用重启导致任务中断', this.deps.now())
      this.publishTaskUpdate(task.id)
    }
  }

  private async runTask(taskId: string, controller: AbortController): Promise<void> {
    const initial = this.tasksTable.get(taskId)
    if (!initial || initial.status !== 'queued') {
      this.abortControllers.delete(taskId)
      return
    }
    this.tasksTable.update(taskId, { status: 'running', startedAt: this.deps.now(), now: this.deps.now() })
    this.publishTaskUpdate(taskId)

    const signal = controller.signal
    let jdAnalysis: ResumeScreeningJdAnalysis
    try {
      jdAnalysis = await this.deps.invoker.invokeJson<ResumeScreeningJdAnalysis>({
        providerId: initial.provider_id,
        modelId: initial.model_id,
        systemPrompt: JD_ANALYST_SYSTEM_PROMPT,
        userPrompt: `岗位 JD 原文：\n${initial.jd_text}`,
        signal,
      })
    } catch (error) {
      this.abortControllers.delete(taskId)
      if (!signal.aborted) {
        console.error('[ResumeScreeningService] JD 解析失败:', error)
        this.resumesTable.markUnfinishedAsFailed(taskId, 'JD 解析失败，任务中止', this.deps.now())
        const stats = this.resumesTable.getTaskStats(taskId)
        this.tasksTable.update(taskId, {
          status: 'failed',
          succeeded: stats.succeeded,
          failed: stats.failed,
          avgScore: stats.avgScore,
          recommendedCount: stats.recommendedCount,
          finishedAt: this.deps.now(),
          now: this.deps.now(),
        })
        this.publishTaskUpdate(taskId)
      }
      return
    }

    this.tasksTable.update(taskId, { jdAnalysisJson: JSON.stringify(jdAnalysis), now: this.deps.now() })
    this.publishTaskUpdate(taskId)

    const config = JSON.parse(initial.config_json) as ResumeScreeningTaskConfig
    const resumes = this.resumesTable.listByTask(taskId)
    let cursor = 0
    const concurrency = Math.min(5, Math.max(1, config.maxConcurrency))
    const worker = async () => {
      while (cursor < resumes.length) {
        if (signal.aborted) return
        const resume = resumes[cursor++]!
        await this.processResume(initial, config, jdAnalysis, resume, signal)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, resumes.length) }, worker))
    this.abortControllers.delete(taskId)
    if (signal.aborted) return

    const stats = this.resumesTable.getTaskStats(taskId)
    const status: ResumeScreeningTaskStatus =
      stats.succeeded === 0 ? 'failed' : stats.failed > 0 ? 'partial' : 'completed'
    this.tasksTable.update(taskId, {
      status,
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      finishedAt: this.deps.now(),
      now: this.deps.now(),
    })
    this.publishTaskUpdate(taskId)
  }

  private async processResume(
    task: ResumeScreeningTaskRow,
    config: ResumeScreeningTaskConfig,
    jdAnalysis: ResumeScreeningJdAnalysis,
    resume: ResumeScreeningResumeRow,
    signal: AbortSignal,
  ): Promise<void> {
    if (resume.status === 'failed') return
    const { id: resumeId } = resume
    try {
      this.resumesTable.update(resumeId, { status: 'running', now: this.deps.now() })
      this.setStageAndPublish(resumeId, 'extracting')

      const rawText = await this.deps.textExtractor.extract(resume.file_path)
      this.resumesTable.update(resumeId, { rawText, now: this.deps.now() })

      const resumeInfo = await this.deps.invoker.invokeJson<Record<string, unknown>>({
        providerId: task.provider_id,
        modelId: task.model_id,
        systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
        userPrompt: `简历原文：\n${rawText}`,
        signal,
      })
      const candidateName = typeof resumeInfo.name === 'string' ? resumeInfo.name : ''
      this.resumesTable.update(resumeId, {
        resumeInfoJson: JSON.stringify(resumeInfo),
        candidateName,
        now: this.deps.now(),
      })

      this.setStageAndPublish(resumeId, 'screening')
      const screening = await this.deps.invoker.invokeJson<ResumeScreeningScreening>({
        providerId: task.provider_id,
        modelId: task.model_id,
        systemPrompt: SCREENING_SYSTEM_PROMPT,
        userPrompt: ['岗位 JD 分析：', JSON.stringify(jdAnalysis), '', '候选人简历结构化信息：', JSON.stringify(resumeInfo)].join(
          '\n',
        ),
        signal,
      })
      this.resumesTable.update(resumeId, {
        screeningJson: JSON.stringify(screening),
        score: typeof screening.score === 'number' ? screening.score : null,
        recommended: screening.recommended === true,
        now: this.deps.now(),
      })

      if (config.generateExplanation) {
        this.setStageAndPublish(resumeId, 'interviewing')
        const interview = await this.deps.invoker.invokeJson<ResumeScreeningInterview>({
          providerId: task.provider_id,
          modelId: task.model_id,
          systemPrompt: INTERVIEWER_SYSTEM_PROMPT,
          userPrompt: [
            '岗位 JD 分析：',
            JSON.stringify(jdAnalysis),
            '',
            '候选人简历结构化信息：',
            JSON.stringify(resumeInfo),
            '',
            '初筛结论：',
            JSON.stringify(screening),
          ].join('\n'),
          signal,
        })
        this.resumesTable.update(resumeId, { interviewJson: JSON.stringify(interview), now: this.deps.now() })

        this.setStageAndPublish(resumeId, 'hr')
        const hr = await this.deps.invoker.invokeJson<ResumeScreeningHr>({
          providerId: task.provider_id,
          modelId: task.model_id,
          systemPrompt: HR_MANAGER_SYSTEM_PROMPT,
          userPrompt: [
            '岗位 JD 分析：',
            JSON.stringify(jdAnalysis),
            '',
            '候选人简历结构化信息：',
            JSON.stringify(resumeInfo),
            '',
            '初筛结论：',
            JSON.stringify(screening),
            '',
            '面试官评估：',
            JSON.stringify(interview),
          ].join('\n'),
          signal,
        })
        this.resumesTable.update(resumeId, { hrJson: JSON.stringify(hr), now: this.deps.now() })
      }

      this.resumesTable.update(resumeId, { status: 'done', error: null, now: this.deps.now() })
      this.resumeStages.delete(resumeId)
      this.publishResumeUpdate(resumeId)
    } catch (error) {
      const message = signal.aborted
        ? '已取消'
        : error instanceof Error
          ? error.message
          : String(error)
      this.resumesTable.update(resumeId, { status: 'failed', error: message, now: this.deps.now() })
      this.resumeStages.delete(resumeId)
      this.publishResumeUpdate(resumeId)
    } finally {
      this.syncTaskProgress(task.id)
    }
  }

  private setStageAndPublish(resumeId: string, stage: ResumeScreeningStage): void {
    this.resumeStages.set(resumeId, stage)
    this.publishResumeUpdate(resumeId)
  }

  private syncTaskProgress(taskId: string): void {
    const stats = this.resumesTable.getTaskStats(taskId)
    this.tasksTable.update(taskId, {
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      now: this.deps.now(),
    })
    this.publishTaskUpdate(taskId)
  }

  private publishTaskUpdate(taskId: string): void {
    const task = this.tasksTable.get(taskId)
    if (!task) return
    const stats = this.resumesTable.getTaskStats(taskId)
    this.deps.publishTaskUpdated({
      taskId,
      status: task.status as ResumeScreeningTaskStatus,
      progress: { done: stats.succeeded + stats.failed, total: task.total },
      stats: {
        succeeded: stats.succeeded,
        failed: stats.failed,
        avgScore: stats.avgScore,
        recommendedCount: stats.recommendedCount,
      },
      version: this.deps.now(),
    })
  }

  private publishResumeUpdate(resumeId: string): void {
    const resume = this.resumesTable.get(resumeId)
    if (!resume) return
    this.deps.publishResumeUpdated({
      taskId: resume.task_id,
      resumeId,
      status: resume.status as ResumeScreeningResumeStatus,
      stage: resume.status === 'running' ? (this.resumeStages.get(resumeId) ?? null) : null,
      version: this.deps.now(),
    })
  }
}

// STAGE_KEYS 供后续 DTO 层复用（阶段枚举与事件 stage 一致）
void STAGE_KEYS
```

注：`publishTaskUpdate` / `publishResumeUpdate` 是服务内私有方法（把行数据转成事件 payload），与 deps 注入的 `publishTaskUpdated` / `publishResumeUpdated`（真正的 IPC 广播通道，Task 10 装配）命名上仅一字母之差，属有意设计。若 lint 提示 `STAGE_KEYS` 未使用，直接删除该常量与末尾 `void` 行。

- [ ] 跑测试确认通过：`pnpm vitest run test/main/resumeScreening/service.test.ts`

- [ ] 跑 typecheck：`pnpm typecheck`

- [ ] Commit：`feat(resume-screening): add pipeline service`

---

## Task 10: 主进程路由工厂 + composition 装配

**Files:**

- 新建：`src/main/resumeScreening/routes.ts`
- 新建：`test/main/resumeScreening/routes.test.ts`
- 修改：`src/main/app/composition.ts`

**背景知识**：

- 路由工厂先例：[documents/routes.ts](../../../src/main/documents/routes.ts) 的 `createDocumentsRoutes`——
  `createRouteMap([[route.name, async (rawInput) => { ... }]])`，handler 内先
  `route.input.parse(rawInput)` 再调业务、最后 `route.output.parse({...})`
- [routeRegistry.ts](../../../src/main/routes/routeRegistry.ts)：
  `DeepchatRouteHandler = (rawInput: unknown, context: RouteContext) => Promise<unknown>`；
  `createRouteMap` 对重复路由名抛错；测试可导入 `createRendererRouteContext(webContentsId, windowId)`
- 装配先例（[composition.ts](../../../src/main/app/composition.ts)）：数据库构造在 L902-904 同构区
  （`new DocumentsDatabase(mainDatabase)`）；服务/路由装配在 `registerRoutes()` 内
  `void recognitionTaskManager.resumePending()`（L2992）之后；`routeMaps` 数组（L3240-3280）中
  `documentsRoutes,`（L3248）之后加条目
- LLM 装配模板：`executeWithRateLimit` 照 [memoryProviderBindings.ts](../../../src/main/app/memoryProviderBindings.ts) L18-19；
  `generateCompletion` 照 composition.ts L2877-2885（`generateCompletionStandalone` 五个位置参数 + options）
- composition.ts 现无 `node:fs` 导入，需新增 `import { promises as fsp } from 'node:fs'`

### 步骤

- [ ] 创建 `test/main/resumeScreening/routes.test.ts`（写失败测试）：

```ts
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningGetTaskRoute
} from '@shared/contracts/routes'
import {
  createResumeScreeningRoutes,
  toResumeScreeningResumeDto,
  toResumeScreeningTaskDto
} from '@/resumeScreening/routes'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/resumes'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/tasks'
import type { ResumeScreeningService } from '@/resumeScreening/service'
import { createRendererRouteContext } from '@/routes/routeRegistry'

function makeTaskRow(overrides: Partial<ResumeScreeningTaskRow> = {}): ResumeScreeningTaskRow {
  return {
    id: 'task-1',
    status: 'completed',
    jd_source: 'text',
    jd_text: '高级前端工程师 JD',
    jd_file_name: null,
    jd_analysis_json:
      '{"responsibilities":["开发"],"requirements":["五年经验"],"preferred":["英语"]}',
    config_json: '{"generateExplanation":true,"includeRawText":true,"maxConcurrency":2}',
    provider_id: 'provider-1',
    model_id: 'model-1',
    total: 1,
    succeeded: 1,
    failed: 0,
    avg_score: 88,
    recommended_count: 1,
    created_by_name: '张三',
    created_by_email: 'zhang@example.com',
    started_at: 1000,
    finished_at: 2000,
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  }
}

function makeResumeRow(overrides: Partial<ResumeScreeningResumeRow> = {}): ResumeScreeningResumeRow {
  return {
    id: 'resume-1',
    task_id: 'task-1',
    file_name: '张三.pdf',
    file_path: '/storage/task-1/resume-1.pdf',
    mime_type: 'application/pdf',
    size: 1024,
    candidate_name: '张三',
    raw_text: '张三的简历内容',
    resume_info_json: '{"name":"张三"}',
    screening_json: '{"score":88,"recommended":true,"conclusion":"推荐","strengths":["基础扎实"]}',
    interview_json: null,
    hr_json: null,
    score: 88,
    recommended: 1,
    status: 'done',
    error: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  }
}

type GetTaskResult =
  | { task: ResumeScreeningTaskRow; resumes: ResumeScreeningResumeRow[] }
  | undefined

// 路由工厂只依赖 service 的少量方法，用局部 stub 避免构造真实服务（无需 sqlite）
function makeServiceStub(methods: {
  getTask?: (taskId: string) => GetTaskResult
  cancelTask?: (taskId: string) => boolean
}): ResumeScreeningService {
  return methods as unknown as ResumeScreeningService
}

describe('resumeScreening routes', () => {
  it('task DTO 把 snake_case 行转换为 camelCase', () => {
    const dto = toResumeScreeningTaskDto(makeTaskRow())
    expect(dto).toEqual({
      id: 'task-1',
      status: 'completed',
      jdSource: 'text',
      jdText: '高级前端工程师 JD',
      jdFileName: null,
      jdAnalysis: { responsibilities: ['开发'], requirements: ['五年经验'], preferred: ['英语'] },
      config: { generateExplanation: true, includeRawText: true, maxConcurrency: 2 },
      providerId: 'provider-1',
      modelId: 'model-1',
      total: 1,
      succeeded: 1,
      failed: 0,
      avgScore: 88,
      recommendedCount: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com',
      startedAt: 1000,
      finishedAt: 2000,
      createdAt: 1000,
      updatedAt: 2000
    })
  })

  it('resume DTO 把 0/1 转成 boolean 并按 includeRawText 门控原文', () => {
    const withRaw = toResumeScreeningResumeDto(makeResumeRow(), { includeRawText: true })
    expect(withRaw.recommended).toBe(true)
    expect(withRaw.rawText).toBe('张三的简历内容')
    expect(withRaw.screening).toEqual({
      score: 88,
      recommended: true,
      conclusion: '推荐',
      strengths: ['基础扎实']
    })

    const withoutRaw = toResumeScreeningResumeDto(makeResumeRow(), { includeRawText: false })
    expect(withoutRaw.rawText).toBeNull()

    const notRecommended = toResumeScreeningResumeDto(makeResumeRow({ recommended: 0 }), {
      includeRawText: true
    })
    expect(notRecommended.recommended).toBe(false)

    const unknownRecommended = toResumeScreeningResumeDto(makeResumeRow({ recommended: null }), {
      includeRawText: true
    })
    expect(unknownRecommended.recommended).toBeNull()

    const brokenJson = toResumeScreeningResumeDto(makeResumeRow({ resume_info_json: 'not-json' }), {
      includeRawText: true
    })
    expect(brokenJson.resumeInfo).toBeNull()
  })

  it('getTask 未知 taskId 返回 task=null 且 resumes 为空数组', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        getTask: () => undefined
      })
    )
    const handler = routes.get(resumeScreeningGetTaskRoute.name)!
    const result = await handler({ taskId: 'missing' }, createRendererRouteContext(1, null))
    expect(result).toEqual({ task: null, resumes: [] })
  })

  it('getTask 返回任务与简历，并按 config.includeRawText 门控原文', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        getTask: (taskId) =>
          taskId === 'task-1' ? { task: makeTaskRow(), resumes: [makeResumeRow()] } : undefined
      })
    )
    const handler = routes.get(resumeScreeningGetTaskRoute.name)!
    const result = (await handler(
      { taskId: 'task-1' },
      createRendererRouteContext(1, null)
    )) as z.infer<(typeof resumeScreeningGetTaskRoute.output)>
    expect(result.task).toMatchObject({ id: 'task-1', avgScore: 88 })
    expect(result.resumes).toHaveLength(1)
    expect(result.resumes[0]).toMatchObject({ id: 'resume-1', rawText: '张三的简历内容' })
  })

  it('cancelTask 把结果透传为 ok', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        cancelTask: (taskId) => taskId === 'task-1'
      })
    )
    const handler = routes.get(resumeScreeningCancelTaskRoute.name)!
    expect(await handler({ taskId: 'task-1' }, createRendererRouteContext(1, null))).toEqual({
      ok: true
    })
    expect(await handler({ taskId: 'other' }, createRendererRouteContext(1, null))).toEqual({
      ok: false
    })
  })
})
```

- [ ] 跑测试确认失败（模块不存在）：`pnpm vitest run test/main/resumeScreening/routes.test.ts`

- [ ] 最小实现 `src/main/resumeScreening/routes.ts`：

```ts
import type { z } from 'zod'
import type {
  resumeScreeningResumeDtoSchema,
  resumeScreeningTaskDtoSchema
} from '@shared/contracts/routes'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
  resumeScreeningUpdateProfileRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/resumes'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/tasks'
import {
  ResumeScreeningService,
  type ResumeScreeningHr,
  type ResumeScreeningInterview,
  type ResumeScreeningJdAnalysis,
  type ResumeScreeningResumeStatus,
  type ResumeScreeningScreening,
  type ResumeScreeningTaskConfig,
  type ResumeScreeningTaskStatus
} from '@/resumeScreening/service'

type ResumeScreeningTaskDto = z.infer<typeof resumeScreeningTaskDtoSchema>
type ResumeScreeningResumeDto = z.infer<typeof resumeScreeningResumeDtoSchema>

// config_json 损坏时的兜底配置，保证 DTO 满足契约
const FALLBACK_CONFIG: ResumeScreeningTaskConfig = {
  generateExplanation: false,
  includeRawText: false,
  maxConcurrency: 1
}

function parseJsonOrNull<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function toResumeScreeningTaskDto(task: ResumeScreeningTaskRow): ResumeScreeningTaskDto {
  return {
    id: task.id,
    status: task.status as ResumeScreeningTaskStatus,
    jdSource: task.jd_source as ResumeScreeningTaskDto['jdSource'],
    jdText: task.jd_text,
    jdFileName: task.jd_file_name,
    jdAnalysis: parseJsonOrNull<ResumeScreeningJdAnalysis>(task.jd_analysis_json),
    config: parseJsonOrNull<ResumeScreeningTaskConfig>(task.config_json) ?? FALLBACK_CONFIG,
    providerId: task.provider_id,
    modelId: task.model_id,
    total: task.total,
    succeeded: task.succeeded,
    failed: task.failed,
    avgScore: task.avg_score,
    recommendedCount: task.recommended_count,
    createdByName: task.created_by_name,
    createdByEmail: task.created_by_email,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  }
}

export function toResumeScreeningResumeDto(
  resume: ResumeScreeningResumeRow,
  options: { includeRawText: boolean }
): ResumeScreeningResumeDto {
  return {
    id: resume.id,
    taskId: resume.task_id,
    fileName: resume.file_name,
    mimeType: resume.mime_type,
    size: resume.size,
    candidateName: resume.candidate_name,
    // includeRawText 只控制原文是否下发渲染层，提取阶段始终读取原文
    rawText: options.includeRawText ? resume.raw_text : null,
    resumeInfo: parseJsonOrNull<unknown>(resume.resume_info_json),
    screening: parseJsonOrNull<ResumeScreeningScreening>(resume.screening_json),
    interview: parseJsonOrNull<ResumeScreeningInterview>(resume.interview_json),
    hr: parseJsonOrNull<ResumeScreeningHr>(resume.hr_json),
    score: resume.score,
    recommended: resume.recommended === null ? null : resume.recommended === 1,
    status: resume.status as ResumeScreeningResumeStatus,
    error: resume.error,
    createdAt: resume.created_at,
    updatedAt: resume.updated_at
  }
}

/** 简历筛选域 7 条路由：契约解析输入 → 调用服务 → 契约校验输出 */
export function createResumeScreeningRoutes(service: ResumeScreeningService): DeepchatRouteMap {
  return createRouteMap([
    [
      resumeScreeningCreateTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningCreateTaskRoute.input.parse(rawInput)
        const task = await service.createTask({
          jdSource: input.jdSource,
          jdText: input.jdText,
          jdFilePath: input.jdFilePath,
          jdFileName: input.jdFileName,
          resumes: input.resumes,
          config: input.config,
          providerId: input.providerId,
          modelId: input.modelId
        })
        return resumeScreeningCreateTaskRoute.output.parse({
          task: toResumeScreeningTaskDto(task)
        })
      }
    ],
    [
      resumeScreeningGetTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningGetTaskRoute.input.parse(rawInput)
        const found = service.getTask(input.taskId)
        if (!found) {
          return resumeScreeningGetTaskRoute.output.parse({ task: null, resumes: [] })
        }
        const config =
          parseJsonOrNull<ResumeScreeningTaskConfig>(found.task.config_json) ?? FALLBACK_CONFIG
        return resumeScreeningGetTaskRoute.output.parse({
          task: toResumeScreeningTaskDto(found.task),
          resumes: found.resumes.map((resume) =>
            toResumeScreeningResumeDto(resume, { includeRawText: config.includeRawText })
          )
        })
      }
    ],
    [
      resumeScreeningListTasksRoute.name,
      async (rawInput) => {
        const input = resumeScreeningListTasksRoute.input.parse(rawInput)
        return resumeScreeningListTasksRoute.output.parse({
          tasks: service.listTasks(input.limit).map(toResumeScreeningTaskDto)
        })
      }
    ],
    [
      resumeScreeningCancelTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningCancelTaskRoute.input.parse(rawInput)
        return resumeScreeningCancelTaskRoute.output.parse({ ok: service.cancelTask(input.taskId) })
      }
    ],
    [
      resumeScreeningGetProfileRoute.name,
      async (rawInput) => {
        resumeScreeningGetProfileRoute.input.parse(rawInput)
        return resumeScreeningGetProfileRoute.output.parse({ profile: service.getProfile() })
      }
    ],
    [
      resumeScreeningUpdateProfileRoute.name,
      async (rawInput) => {
        const input = resumeScreeningUpdateProfileRoute.input.parse(rawInput)
        return resumeScreeningUpdateProfileRoute.output.parse({
          profile: service.updateProfile({ name: input.name, email: input.email })
        })
      }
    ],
    [
      resumeScreeningListModelsRoute.name,
      async (rawInput) => {
        resumeScreeningListModelsRoute.input.parse(rawInput)
        return resumeScreeningListModelsRoute.output.parse({ models: service.listModels() })
      }
    ]
  ])
}
```

- [ ] 跑测试确认通过：`pnpm vitest run test/main/resumeScreening/routes.test.ts`

- [ ] 修改 `src/main/app/composition.ts` 四处：

1. 顶部 `import path from 'path'` 之后追加：

```ts
import { promises as fsp } from 'node:fs'
```

2. documents 导入块（`import { seedPresetTemplates } from '@/documents/seed'`）之后追加：

```ts
import { ResumeScreeningDatabase } from '@/resumeScreening/database'
import { ResumeLlmInvoker } from '@/resumeScreening/llmInvoker'
import { createResumeScreeningRoutes } from '@/resumeScreening/routes'
import { ResumeScreeningService, type ResumeScreeningProfile } from '@/resumeScreening/service'
import { ResumeTextExtractor } from '@/resumeScreening/textExtractor'
```

3. 数据库构造区 `const documentsRepository = new DocumentsRepository(documentsDatabase)` 之后追加：

```ts
  const resumeScreeningDatabase = new ResumeScreeningDatabase(mainDatabase)
```

4. `registerRoutes()` 内 `void recognitionTaskManager.resumePending()` 之后追加（服务装配 +
   路由工厂 + 启动恢复）：

```ts
    const resumeScreeningService = new ResumeScreeningService({
      database: resumeScreeningDatabase,
      invoker: new ResumeLlmInvoker({
        executeWithRateLimit: (providerId, options) =>
          providerRuntime.executeWithRateLimit(providerId, { signal: options?.signal }),
        generateCompletion: (providerId, messages, modelId, temperature, maxTokens, options) =>
          providerRuntime.generateCompletionStandalone(
            providerId,
            messages,
            modelId,
            temperature,
            maxTokens,
            { signal: options?.signal, swallowErrors: false }
          )
      }),
      textExtractor: new ResumeTextExtractor({
        getMaxFileSize: () =>
          dependencies.settingsStore.get<number>('maxFileSize') ?? 30 * 1024 * 1024
      }),
      storageDir: path.join(app.getPath('userData'), 'resume-screening'),
      copyFile: (src, dest) => fsp.copyFile(src, dest),
      getProfile: () =>
        dependencies.settingsStore.get<ResumeScreeningProfile>('resumeScreening.profile'),
      saveProfile: (profile) => dependencies.settingsStore.set('resumeScreening.profile', profile),
      getDefaultModel: () => agentSettings.getDefaultModel(),
      listModels: () => {
        const defaultModel = agentSettings.getDefaultModel()
        return providerSettings
          .getProviders()
          .filter((provider) => provider.enable)
          .flatMap((provider) =>
            providerSettings.getProviderModels(provider.id).map((model) => ({
              providerId: provider.id,
              providerName: provider.name,
              modelId: model.id,
              modelName: model.name,
              isDefault: defaultModel?.providerId === provider.id && defaultModel?.modelId === model.id
            }))
          )
      },
      publishTaskUpdated: (payload) => publishDeepchatEvent('resumeScreening.task.updated', payload),
      publishResumeUpdated: (payload) =>
        publishDeepchatEvent('resumeScreening.resume.updated', payload),
      now: () => Date.now()
    })
    const resumeScreeningRoutes = createResumeScreeningRoutes(resumeScreeningService)
    // 应用启动时把上次未跑完的简历筛选任务统一标记为失败
    resumeScreeningService.recoverInterruptedTasks()
```

- [ ] 在 `routeDispatcher` 的 `routeMaps` 数组中 `documentsRoutes,` 之后追加一行：

```ts
        resumeScreeningRoutes,
```

- [ ] 跑 typecheck：`pnpm typecheck`

- [ ] Commit：`feat(resume-screening): add main routes`

---

## Task 11: 渲染层 API Client（工厂 + 单例）

**Files:**

- 新建：`src/renderer/api/ResumeScreeningClient.ts`
- 新建：`src/renderer/api/resumeScreeningTasks.ts`
- 新建：`test/renderer/api/resumeScreeningClient.test.ts`

**背景知识**：

- Client 工厂模板：[DocumentsClient.ts](../../../src/renderer/api/DocumentsClient.ts)
  （`createXxxClient(bridge = getDeepchatBridge())` + `ReturnType` 类型导出 + `z.input` 输入类型 +
  事件订阅直接透传 `bridge.on`）
- 单例模板：[documentTasks.ts](../../../src/renderer/api/documentTasks.ts)
  （无状态 bridge 封装在模块顶层实例化一次，store 与页面共享同一实例）
- 页面/store 经 `@api/*` 别名导入（[tsconfig.app.json](../../../tsconfig.app.json)：
  `@api/*` → `./src/renderer/api/*`）；`api/index.ts` 无需改动（DocumentsClient 亦未注册其中）
- 测试先例：[test/renderer/api/documentsClient.test.ts](../../../test/renderer/api/documentsClient.test.ts)
  （mock bridge + vitest globals，测试文件用相对路径导入被测模块）

### 步骤

- [ ] 创建测试 `test/renderer/api/resumeScreeningClient.test.ts`：

```ts
import type { DeepchatBridge } from '@shared/contracts/bridge'
import { createResumeScreeningClient } from '../../../src/renderer/api/ResumeScreeningClient'

describe('ResumeScreeningClient', () => {
  it('invokes read routes through the bridge', async () => {
    const invoke = vi.fn(async (routeName: string, input: unknown) => {
      structuredClone(input)
      switch (routeName) {
        case 'resumeScreening.getTask':
          return { task: null, resumes: [] }
        case 'resumeScreening.listTasks':
          return { tasks: [] }
        case 'resumeScreening.cancelTask':
          return { ok: true }
        case 'resumeScreening.getProfile':
          return { profile: { name: '', email: '' } }
        case 'resumeScreening.listModels':
          return { models: [] }
        default:
          throw new Error(`Unexpected route: ${routeName}`)
      }
    })
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createResumeScreeningClient(bridge)

    expect(await client.getTask('t-1')).toEqual({ task: null, resumes: [] })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.getTask', { taskId: 't-1' })

    await client.listTasks()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listTasks', {})
    await client.listTasks(50)
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listTasks', { limit: 50 })

    expect(await client.cancelTask('t-1')).toEqual({ ok: true })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.cancelTask', { taskId: 't-1' })

    await client.getProfile()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.getProfile', {})

    await client.listModels()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listModels', {})
  })

  it('sends createTask and updateProfile inputs as-is', async () => {
    const invoke = vi.fn(async () => ({ task: {} }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createResumeScreeningClient(bridge)

    const input = {
      jdSource: 'file' as const,
      jdText: '',
      jdFilePath: 'C:\\jd.txt',
      jdFileName: 'jd.txt',
      resumes: [{ path: 'C:\\a.pdf', name: 'a.pdf', size: 10 }],
      config: { generateExplanation: true, includeRawText: false, maxConcurrency: 2 }
    }
    await client.createTask(input)
    expect(invoke).toHaveBeenCalledWith('resumeScreening.createTask', input)

    await client.updateProfile({ name: '张三', email: 'z@example.com' })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.updateProfile', {
      name: '张三',
      email: 'z@example.com'
    })
  })

  it('subscribes to task/resume events and returns unsubscribe', () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const client = createResumeScreeningClient({ on } as never)

    const listener = vi.fn()
    const stop = client.onTaskUpdated(listener)
    expect(on).toHaveBeenCalledWith('resumeScreening.task.updated', listener)
    stop()
    expect(off).toHaveBeenCalled()

    const stopResume = client.onResumeUpdated(listener)
    expect(on).toHaveBeenCalledWith('resumeScreening.resume.updated', listener)
    stopResume()
    expect(off).toHaveBeenCalled()
  })
})
```

- [ ] 跑测试确认失败：`pnpm vitest run test/renderer/api/resumeScreeningClient.test.ts`
  （被测模块尚不存在）

- [ ] 创建 `src/renderer/api/ResumeScreeningClient.ts`：

```ts
import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
  resumeScreeningUpdateProfileRoute
} from '@shared/contracts/routes'
import {
  resumeScreeningResumeUpdatedEvent,
  resumeScreeningTaskUpdatedEvent
} from '@shared/contracts/events'
import type { z } from 'zod'
import { getDeepchatBridge } from './core'

export type ResumeScreeningCreateTaskInput = z.input<typeof resumeScreeningCreateTaskRoute.input>
export type ResumeScreeningUpdateProfileInput = z.input<
  typeof resumeScreeningUpdateProfileRoute.input
>

export function createResumeScreeningClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  return {
    createTask: (input: ResumeScreeningCreateTaskInput) =>
      bridge.invoke(resumeScreeningCreateTaskRoute.name, input),
    getTask: (taskId: string) => bridge.invoke(resumeScreeningGetTaskRoute.name, { taskId }),
    listTasks: (limit?: number) =>
      bridge.invoke(resumeScreeningListTasksRoute.name, limit === undefined ? {} : { limit }),
    cancelTask: (taskId: string) =>
      bridge.invoke(resumeScreeningCancelTaskRoute.name, { taskId }),
    getProfile: () => bridge.invoke(resumeScreeningGetProfileRoute.name, {}),
    updateProfile: (input: ResumeScreeningUpdateProfileInput) =>
      bridge.invoke(resumeScreeningUpdateProfileRoute.name, input),
    listModels: () => bridge.invoke(resumeScreeningListModelsRoute.name, {}),
    onTaskUpdated: (
      listener: (payload: z.infer<typeof resumeScreeningTaskUpdatedEvent.payload>) => void
    ) => bridge.on(resumeScreeningTaskUpdatedEvent.name, listener),
    onResumeUpdated: (
      listener: (payload: z.infer<typeof resumeScreeningResumeUpdatedEvent.payload>) => void
    ) => bridge.on(resumeScreeningResumeUpdatedEvent.name, listener)
  }
}

export type ResumeScreeningClient = ReturnType<typeof createResumeScreeningClient>
```

- [ ] 创建 `src/renderer/api/resumeScreeningTasks.ts`：

```ts
import { createResumeScreeningClient } from './ResumeScreeningClient'
import type {
  resumeScreeningResumeDtoSchema,
  resumeScreeningTaskDtoSchema
} from '@shared/contracts/routes'
import type { z } from 'zod'

export type ResumeScreeningTaskDto = z.infer<typeof resumeScreeningTaskDtoSchema>
export type ResumeScreeningResumeDto = z.infer<typeof resumeScreeningResumeDtoSchema>

// 无状态 bridge 封装单例：筛选 store 与页面组件共享同一实例
export const resumeScreeningApi = createResumeScreeningClient()
```

- [ ] 跑测试确认通过：`pnpm vitest run test/renderer/api/resumeScreeningClient.test.ts`

- [ ] 跑 typecheck：`pnpm typecheck`

- [ ] Commit：`feat(resume-screening): add renderer client`

---

## Task 12: 渲染层页面骨架 + 路由注册 + i18n 域初始化

**Files:**

- 修改：`src/renderer/src/router/index.ts`
- 新建：`src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`
- 修改：20 个 locale 的 `src/renderer/src/i18n/{locale}/routes.json`（追加一键）
- 新建：20 个 locale 的 `src/renderer/src/i18n/{locale}/resumeScreening.json`
- 修改：20 个 locale 的 `src/renderer/src/i18n/{locale}/index.ts`（注册新域）
- 再生成：`src/types/i18n.d.ts`（脚本产物，随代码入库）

**背景知识**：

- 路由先例：[router/index.ts](../../../src/renderer/src/router/index.ts) L92-100 的 `/documents`
  顶级路由（`meta.titleKey` + `meta.icon`）；新路由插在该块之后、`/welcome` 之前
- 页面骨架先例：[DocumentsArchivePage.vue](../../../src/renderer/src/pages/documents/DocumentsArchivePage.vue)
  L2-22（`flex h-full min-h-0 flex-col` 根 + `header` 标题栏）
- i18n 组织：每 locale 目录内 `{域}.json` + [index.ts](../../../src/renderer/src/i18n/zh-CN/index.ts)
  集中注册；`pnpm i18n` 校验 20 个 locale 键集与 zh-CN 一致（zh-CN 为源）；新增键后必须跑
  `pnpm i18n:types` 再生成 [src/types/i18n.d.ts](../../../src/types/i18n.d.ts)（该文件入库且参与
  typecheck）
- 本 Task 只建最小 i18n 骨架（routes.json 一键 + resumeScreening.json 的 `title` 一键）；其余
  组件文案键在 Task 14（左栏创建区 20 键）与 Task 15（任务详情区 31 键）分批补全

### 步骤

- [ ] 修改 `src/renderer/src/router/index.ts`：在 `/documents` 路由对象（L92-100 的
  `    },`）之后、`/welcome` 之前插入：

```ts
    {
      path: '/resume-screening',
      name: 'resume-screening',
      component: () => import('@/pages/resumeScreening/ResumeScreeningPage.vue'),
      meta: {
        titleKey: 'routes.resumeScreening',
        icon: 'lucide:file-search'
      }
    },
```

- [ ] 创建页面骨架 `src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`：

```vue
<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">{{ t('resumeScreening.title') }}</h1>
    </header>

    <div class="min-h-0 flex-1" data-testid="resume-screening-workspace">
      <!-- Task 13/14 在此填充任务工作区（左栏任务列表 + 右栏详情） -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
```

- [ ] 20 个 locale 的 `routes.json` 各追加一键（注意前一条目末尾补逗号）：

```json
  "resumeScreening": "<下表值>"
```

| locale | 值 |
| --- | --- |
| zh-CN | 简历筛选 |
| zh-TW | 履歷篩選 |
| zh-HK | 簡歷篩選 |
| en-US | Resume Screening |
| ja-JP | 履歴書スクリーニング |
| ko-KR | 이력서 스크리닝 |
| vi-VN | Sàng lọc hồ sơ |
| tr-TR | Özgeçmiş Eleme |
| ru-RU | Скрининг резюме |
| pt-BR | Triagem de Currículos |
| pl-PL | Selekcja CV |
| ms-MY | Saringan Resume |
| it-IT | Screening dei CV |
| id-ID | Penyaringan Resume |
| he-IL | סינון קורות חיים |
| fr-FR | Tri des CV |
| fa-IR | غربالگری رزومه |
| es-ES | Filtrado de CV |
| de-DE | Lebenslauf-Screening |
| da-DK | CV-screening |

- [ ] 20 个 locale 各新建 `resumeScreening.json`（内容仅 title，值取上表同 locale 值）：

```json
{
  "title": "<同表值>"
}
```

- [ ] 20 个 locale 的 `index.ts` 各改两处（所有 locale 的 index.ts 结构一致，锚点相同）：

1. `import plan from './plan.json'` 之后追加：

```ts
import resumeScreening from './resumeScreening.json'
```

2. export 对象内 `  plan,` 之后追加：

```ts
  resumeScreening,
```

- [ ] 再生成 i18n 类型并验证：

```sh
pnpm i18n:types
pnpm typecheck
pnpm i18n
```

- [ ] Commit：`feat(resume-screening): add renderer page skeleton`

## Task 13: 渲染层 Pinia store（草稿状态 + 任务列表 + 事件处理）

**Files:**
- Create: `src/renderer/src/stores/resumeScreening.ts`
- Create: `test/renderer/stores/resumeScreeningStore.test.ts`
- Test: `pnpm vitest run test/renderer/stores/resumeScreeningStore.test.ts`

- [ ] 创建失败测试 `test/renderer/stores/resumeScreeningStore.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const createTaskMock = vi.fn()
const getTask = vi.fn()
const listTasks = vi.fn()
const cancelTask = vi.fn()
const getProfile = vi.fn()
const updateProfile = vi.fn()
const listModels = vi.fn()
const onTaskUpdated = vi.fn()
const onResumeUpdated = vi.fn()

vi.doMock('@api/ResumeScreeningClient', () => ({
  createResumeScreeningClient: () => ({
    createTask: createTaskMock,
    getTask,
    listTasks,
    cancelTask,
    getProfile,
    updateProfile,
    listModels,
    onTaskUpdated,
    onResumeUpdated
  })
}))

const { useResumeScreeningStore } = await import('@/stores/resumeScreening')

const makeTask = (): ResumeScreeningTaskDto => ({
  id: 'task-1',
  status: 'queued',
  jdSource: 'text',
  jdText: '前端工程师',
  jdFileName: null,
  jdAnalysis: null,
  config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
  providerId: 'openai',
  modelId: 'gpt-4o',
  total: 1,
  succeeded: 0,
  failed: 0,
  avgScore: null,
  recommendedCount: 0,
  createdByName: '张三',
  createdByEmail: 'z@example.com',
  startedAt: null,
  finishedAt: null,
  createdAt: 1,
  updatedAt: 1
})

const makeResume = () => ({
  id: 'resume-1',
  taskId: 'task-1',
  fileName: '张三.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  candidateName: '张三',
  rawText: null,
  resumeInfo: null,
  screening: null,
  interview: null,
  hr: null,
  score: null,
  recommended: null,
  status: 'pending',
  error: null,
  createdAt: 1,
  updatedAt: 1
})

describe('resumeScreening store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('createTask sends trimmed draft input, prepends the task and resets the draft', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '  前端工程师  '
    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    store.draft.providerId = 'openai'
    store.draft.modelId = 'gpt-4o'
    createTaskMock.mockResolvedValue({ task: makeTask() })
    getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })

    const created = await store.createTask()

    expect(created?.id).toBe('task-1')
    expect(createTaskMock).toHaveBeenCalledWith({
      jdSource: 'text',
      jdText: '前端工程师',
      jdFilePath: undefined,
      jdFileName: undefined,
      resumes: [{ path: 'C:\\a.pdf', name: 'a.pdf' }],
      config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
      providerId: 'openai',
      modelId: 'gpt-4o'
    })
    expect(store.tasks[0].id).toBe('task-1')
    expect(store.currentTask?.id).toBe('task-1')
    expect(store.currentResumes).toHaveLength(1)
    expect(store.selectedResumeId).toBe('resume-1')
    expect(store.draft.jdText).toBe('')
    expect(store.draft.resumes).toHaveLength(0)
    expect(store.isCreating).toBe(false)
  })

  it('createTask rejects an empty draft without calling the client', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '前端工程师'

    await expect(store.createTask()).resolves.toBeNull()
    expect(createTaskMock).not.toHaveBeenCalled()
  })

  it('createTask records the error message when the client call fails', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '前端工程师'
    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    createTaskMock.mockRejectedValue(new Error('模型不可用'))

    await store.createTask()

    expect(store.createError).toBe('模型不可用')
    expect(store.isCreating).toBe(false)
  })

  it('loadTask selects the first resume and clears state when the task is missing', async () => {
    const store = useResumeScreeningStore()
    getTask.mockResolvedValue({
      task: makeTask(),
      resumes: [makeResume(), { ...makeResume(), id: 'resume-2', fileName: '李四.pdf' }]
    })

    await store.loadTask('task-1')

    expect(store.currentTask?.id).toBe('task-1')
    expect(store.currentResumes).toHaveLength(2)
    expect(store.selectedResumeId).toBe('resume-1')

    getTask.mockResolvedValue({ task: null, resumes: [] })
    await store.loadTask('missing')

    expect(store.currentTask).toBeNull()
    expect(store.currentResumes).toHaveLength(0)
    expect(store.selectedResumeId).toBeNull()
  })

  it('handleTaskUpdated reloads the task list for unknown tasks', async () => {
    const store = useResumeScreeningStore()
    listTasks.mockResolvedValue({ tasks: [makeTask()] })

    store.handleTaskUpdated({
      taskId: 'task-1',
      status: 'running',
      progress: { done: 0, total: 1 },
      stats: { succeeded: 0, failed: 0, avgScore: null, recommendedCount: 0 },
      version: 2
    })

    await vi.waitFor(() => expect(store.tasks).toHaveLength(1))
    expect(store.tasksLoaded).toBe(true)
  })

  it('handleTaskUpdated patches the list and current task, then reloads after debounce', async () => {
    vi.useFakeTimers()
    try {
      const store = useResumeScreeningStore()
      listTasks.mockResolvedValue({ tasks: [makeTask()] })
      getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })
      await store.loadTasks()
      await store.loadTask('task-1')
      expect(getTask).toHaveBeenCalledTimes(1)

      store.handleTaskUpdated({
        taskId: 'task-1',
        status: 'done',
        progress: { done: 1, total: 1 },
        stats: { succeeded: 1, failed: 0, avgScore: 88, recommendedCount: 1 },
        version: 2
      })

      expect(store.tasks[0].status).toBe('done')
      expect(store.tasks[0].avgScore).toBe(88)
      expect(store.currentTask?.succeeded).toBe(1)
      expect(getTask).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(300)
      expect(getTask).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handleResumeUpdated patches the matching resume of the current task only', async () => {
    const store = useResumeScreeningStore()
    getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })
    await store.loadTask('task-1')

    store.handleResumeUpdated({
      taskId: 'task-1',
      resumeId: 'resume-1',
      status: 'done',
      stage: 'hr',
      version: 3
    })

    expect(store.currentResumes[0].status).toBe('done')

    store.handleResumeUpdated({
      taskId: 'other-task',
      resumeId: 'resume-1',
      status: 'failed',
      stage: null,
      version: 4
    })

    expect(store.currentResumes[0].status).toBe('done')
  })

  it('saveProfile persists the profile via updateProfile', async () => {
    const store = useResumeScreeningStore()
    updateProfile.mockResolvedValue({ profile: { name: '李四', email: 'li@example.com' } })

    await store.saveProfile({ name: '李四' })

    expect(updateProfile).toHaveBeenCalledWith({ name: '李四' })
    expect(store.profile?.name).toBe('李四')
  })

  it('loadModels stores models and defaults the draft to the default model', async () => {
    const store = useResumeScreeningStore()
    listModels.mockResolvedValue({
      models: [
        {
          providerId: 'openai',
          providerName: 'OpenAI',
          modelId: 'gpt-4o',
          modelName: 'GPT-4o',
          isDefault: true
        },
        {
          providerId: 'anthropic',
          providerName: 'Anthropic',
          modelId: 'claude',
          modelName: 'Claude',
          isDefault: false
        }
      ]
    })

    await store.loadModels()

    expect(store.models).toHaveLength(2)
    expect(store.selectedModelKey).toBe('openai::gpt-4o')

    store.selectModel('anthropic', 'claude')
    expect(store.selectedModelKey).toBe('anthropic::claude')
  })

  it('canReview requires jd text, at least one resume and an idle state', () => {
    const store = useResumeScreeningStore()
    expect(store.canReview).toBe(false)

    store.draft.jdText = '前端工程师'
    expect(store.canReview).toBe(false)

    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    expect(store.canReview).toBe(true)

    store.currentTask = { ...makeTask(), status: 'running' }
    expect(store.canReview).toBe(false)
  })
})
```

- [ ] 跑测试确认失败：`pnpm vitest run test/renderer/stores/resumeScreeningStore.test.ts`
  （被测模块尚不存在）

- [ ] 创建 `src/renderer/src/stores/resumeScreening.ts`：

```ts
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { z } from 'zod'
import type {
  resumeScreeningResumeUpdatedEvent,
  resumeScreeningTaskUpdatedEvent
} from '@shared/contracts/events'
import type {
  ResumeScreeningClient,
  ResumeScreeningUpdateProfileInput
} from '@api/ResumeScreeningClient'
import {
  resumeScreeningApi,
  type ResumeScreeningResumeDto,
  type ResumeScreeningTaskDto
} from '@api/resumeScreeningTasks'

type ResumeScreeningTaskUpdatedPayload = z.infer<typeof resumeScreeningTaskUpdatedEvent.payload>
type ResumeScreeningResumeUpdatedPayload = z.infer<typeof resumeScreeningResumeUpdatedEvent.payload>

export const RESUME_LIMIT = 20

const TASK_LIST_LIMIT = 20
const REFRESH_DEBOUNCE_MS = 300

export interface PickedResume {
  path: string
  name: string
}

export interface ResumeScreeningDraft {
  jdSource: 'text' | 'file'
  jdText: string
  jdFilePath: string | null
  jdFileName: string | null
  resumes: PickedResume[]
  config: {
    generateExplanation: boolean
    includeRawText: boolean
    maxConcurrency: number
  }
  providerId: string | null
  modelId: string | null
}

export interface ResumeScreeningModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  isDefault: boolean
}

export function createDefaultDraft(): ResumeScreeningDraft {
  return {
    jdSource: 'text',
    jdText: '',
    jdFilePath: null,
    jdFileName: null,
    resumes: [],
    config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
    providerId: null,
    modelId: null
  }
}

// 简历筛选页全局状态：左栏草稿、任务历史、当前任务详情与实时事件同步
export const useResumeScreeningStore = defineStore('resumeScreening', () => {
  const defaultClient = resumeScreeningApi

  const draft = reactive<ResumeScreeningDraft>(createDefaultDraft())
  const tasks = ref<ResumeScreeningTaskDto[]>([])
  const tasksLoaded = ref(false)
  const currentTaskId = ref<string | null>(null)
  const currentTask = ref<ResumeScreeningTaskDto | null>(null)
  const currentResumes = ref<ResumeScreeningResumeDto[]>([])
  const selectedResumeId = ref<string | null>(null)
  const profile = ref<{ name: string; email: string } | null>(null)
  const models = ref<ResumeScreeningModelOption[]>([])
  const isCreating = ref(false)
  const createError = ref<string | null>(null)

  let loadTaskSeq = 0
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const selectedResume = computed(
    () => currentResumes.value.find((item) => item.id === selectedResumeId.value) ?? null
  )
  const isTaskActive = computed(
    () => currentTask.value?.status === 'queued' || currentTask.value?.status === 'running'
  )
  const hasValidDraft = computed(() => {
    const jdValid =
      draft.jdSource === 'file' ? draft.jdFilePath !== null : draft.jdText.trim().length > 0
    return jdValid && draft.resumes.length > 0
  })
  const canReview = computed(() => hasValidDraft.value && !isTaskActive.value && !isCreating.value)
  const selectedModelKey = computed(() =>
    draft.providerId && draft.modelId ? `${draft.providerId}::${draft.modelId}` : null
  )

  // 事件风暴下 300ms 防抖全量重同步当前任务（镜像 documents store 的 scheduleArchiveRefresh）
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (currentTaskId.value) void loadTask(currentTaskId.value)
    }, REFRESH_DEBOUNCE_MS)
  }

  async function loadTasks(client: ResumeScreeningClient = defaultClient) {
    const result = await client.listTasks(TASK_LIST_LIMIT)
    tasks.value = result.tasks
    tasksLoaded.value = true
  }

  // seq 防乱序：用户切换历史任务时丢弃迟到的旧响应
  async function loadTask(taskId: string, client: ResumeScreeningClient = defaultClient) {
    const seq = ++loadTaskSeq
    const result = await client.getTask(taskId)
    if (seq !== loadTaskSeq) return
    currentTaskId.value = result.task ? taskId : null
    currentTask.value = result.task
    currentResumes.value = result.resumes
    selectedResumeId.value = result.resumes[0]?.id ?? null
  }

  async function createTask(client: ResumeScreeningClient = defaultClient) {
    if (!hasValidDraft.value || isCreating.value) return null
    isCreating.value = true
    createError.value = null
    try {
      const result = await client.createTask({
        jdSource: draft.jdSource,
        jdText: draft.jdSource === 'text' ? draft.jdText.trim() : '',
        jdFilePath: draft.jdSource === 'file' ? (draft.jdFilePath ?? undefined) : undefined,
        jdFileName: draft.jdSource === 'file' ? (draft.jdFileName ?? undefined) : undefined,
        resumes: draft.resumes.map((item) => ({ path: item.path, name: item.name })),
        config: { ...draft.config },
        providerId: draft.providerId ?? undefined,
        modelId: draft.modelId ?? undefined
      })
      const index = tasks.value.findIndex((task) => task.id === result.task.id)
      if (index >= 0) tasks.value.splice(index, 1, result.task)
      else tasks.value.unshift(result.task)
      await loadTask(result.task.id, client)
      resetDraft()
      return result.task
    } catch (error) {
      createError.value = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      isCreating.value = false
    }
  }

  async function cancelTask(client: ResumeScreeningClient = defaultClient) {
    const taskId = currentTask.value?.id
    if (!taskId) return
    await client.cancelTask(taskId)
  }

  async function loadProfile(client: ResumeScreeningClient = defaultClient) {
    profile.value = (await client.getProfile()).profile
  }

  async function saveProfile(
    input: ResumeScreeningUpdateProfileInput,
    client: ResumeScreeningClient = defaultClient
  ) {
    const result = await client.updateProfile(input)
    profile.value = result.profile
    return result.profile
  }

  async function loadModels(client: ResumeScreeningClient = defaultClient) {
    models.value = (await client.listModels()).models
    // 草稿未选模型时默认选中系统默认模型
    if (!draft.providerId && !draft.modelId) {
      const preferred = models.value.find((item) => item.isDefault) ?? models.value[0]
      if (preferred) {
        draft.providerId = preferred.providerId
        draft.modelId = preferred.modelId
      }
    }
  }

  function selectModel(providerId: string, modelId: string) {
    draft.providerId = providerId
    draft.modelId = modelId
  }

  function handleTaskUpdated(payload: ResumeScreeningTaskUpdatedPayload) {
    const patch = {
      status: payload.status,
      total: payload.progress.total,
      succeeded: payload.stats.succeeded,
      failed: payload.stats.failed,
      avgScore: payload.stats.avgScore,
      recommendedCount: payload.stats.recommendedCount,
      updatedAt: payload.version
    }
    const index = tasks.value.findIndex((task) => task.id === payload.taskId)
    if (index >= 0) {
      tasks.value[index] = { ...tasks.value[index], ...patch }
    } else {
      void loadTasks()
    }
    const current = currentTask.value
    if (current && current.id === payload.taskId) {
      currentTask.value = { ...current, ...patch }
      scheduleRefresh()
    }
  }

  function handleResumeUpdated(payload: ResumeScreeningResumeUpdatedPayload) {
    const current = currentTask.value
    if (!current || current.id !== payload.taskId) return
    const index = currentResumes.value.findIndex((item) => item.id === payload.resumeId)
    if (index < 0) return
    currentResumes.value[index] = {
      ...currentResumes.value[index],
      status: payload.status,
      updatedAt: payload.version
    }
    scheduleRefresh()
  }

  function resetDraft() {
    Object.assign(draft, createDefaultDraft())
  }

  return {
    draft,
    tasks,
    tasksLoaded,
    currentTaskId,
    currentTask,
    currentResumes,
    selectedResumeId,
    selectedResume,
    profile,
    models,
    isCreating,
    createError,
    isTaskActive,
    hasValidDraft,
    canReview,
    selectedModelKey,
    loadTasks,
    loadTask,
    createTask,
    cancelTask,
    loadProfile,
    saveProfile,
    loadModels,
    selectModel,
    handleTaskUpdated,
    handleResumeUpdated,
    resetDraft
  }
})
```

- [ ] 跑测试确认通过：`pnpm vitest run test/renderer/stores/resumeScreeningStore.test.ts`

- [ ] 跑 typecheck：`pnpm typecheck`

- [ ] Commit：`feat(resume-screening): add renderer store`

---

## Task 14: 左栏创建区组件 + 页面装配 + 组件测试

**Files:**

- 新建：`src/renderer/src/pages/resumeScreening/components/JdInputCard.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ResumeUploadCard.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ScreeningConfigCard.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ReviewButton.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/UserProfileBadge.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ModelSelector.vue`
- 修改：`src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`（装配左栏）
- 新建：`test/renderer/pages/resumeScreening/JdInputCard.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ResumeUploadCard.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ScreeningConfigCard.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ReviewButton.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ModelSelector.test.ts`
- 修改：20 个 locale 的 `src/renderer/src/i18n/{locale}/resumeScreening.json`（补组件文案键）
- 再生成：`src/types/i18n.d.ts`

**背景知识**：

- 组件全部为**纯 props/emits 组件**（不内联 `useResumeScreeningStore`），由页面接线。
  这样组件测试无需 mock store，`UserProfileBadge` 为纯展示组件不单独写测试
- 组件测试模板：[DocumentRecognizeDialog.test.ts](../../../test/renderer/pages/documents/DocumentRecognizeDialog.test.ts)
  （`vi.resetModules` + `vi.doMock('vue-i18n')` + 全套 stub；Select 系 stub 保持
  `<select>`/`<option>` 直属关系，`SelectTrigger` 渲染真实元素以保留 data-testid）
- DcButton：`import { DcButton } from '@dc-ui/components/button'`；带文本按钮用 slot 文本，
  icon-only 按钮必须传 `label`（DEV 告警）；`variant` 支持 `default|ghost|outline|destructive`
  等，`size` 支持 `xs|icon-xs`；Switch 用 `:model-value` + `@update:model-value`
- 文件选择：`createDeviceClient().selectFiles(...)`，过滤器扩展名与 Task 8 提取器白名单一致
  （`pdf/docx/txt/md`）；`ResumeUploadCard` 从 store 导入 `RESUME_LIMIT`，其测试用
  `vi.doMock('@/stores/resumeScreening')` 提供常量 stub（避免加载真实 store 触发
  `getDeepchatBridge` 抛错）
- 契约 `jdText` 上限 60000（[routes.ts 计划 L173](./2026-09-28-resume-screening-assistant.md)），
  Textarea `:maxlength` 与之同步
- i18n：Task 12 只建了 `title` 一键，本 Task 组件用到的键在本 Task 全部补齐（20 locale），
  补键后必须 `pnpm i18n:types` 再生成类型，否则 `pnpm typecheck` 因 `t()` 未定义键失败
- 事件订阅（`onTaskUpdated`/`onResumeUpdated`）与 `loadTasks` 在 Task 15 装配（右栏就绪后）

### 步骤

- [ ] 先写 5 个组件测试。

  `test/renderer/pages/resumeScreening/JdInputCard.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const textareaStub = defineComponent({
  name: 'TextareaStub',
  props: ['modelValue', 'placeholder', 'maxlength'],
  emits: ['update:modelValue'],
  template:
    '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const JdInputCard = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/JdInputCard.vue')
  ).default
  return mount(JdInputCard, {
    props,
    global: { stubs: { DcButton: dcButtonStub, Textarea: textareaStub } }
  })
}

const baseProps = { jdSource: 'text', jdText: '', jdFilePath: null, jdFileName: null }

describe('JdInputCard', () => {
  it('文本模式渲染输入框并上抛文本更新', async () => {
    const wrapper = await setup(baseProps)
    expect(wrapper.find('[data-testid="jd-text-input"]').exists()).toBe(true)
    await wrapper.get('textarea').setValue('前端工程师')
    expect(wrapper.emitted('update:jdText')?.[0]).toEqual(['前端工程师'])
  })

  it('点击文件页签切换 jdSource', async () => {
    const wrapper = await setup(baseProps)
    await wrapper.get('[data-testid="jd-tab-file"]').trigger('click')
    expect(wrapper.emitted('update:jdSource')?.[0]).toEqual(['file'])
  })

  it('文件模式未选文件时渲染选择按钮并上抛 pickFile', async () => {
    const wrapper = await setup({ ...baseProps, jdSource: 'file' })
    expect(wrapper.find('[data-testid="jd-text-input"]').exists()).toBe(false)
    await wrapper.get('[data-testid="jd-pick-file"]').trigger('click')
    expect(wrapper.emitted('pickFile')).toHaveLength(1)
  })

  it('文件模式已选文件时展示文件名并支持移除', async () => {
    const wrapper = await setup({
      ...baseProps,
      jdSource: 'file',
      jdFilePath: 'C:\\jd\\frontend.txt',
      jdFileName: 'frontend.txt'
    })
    expect(wrapper.get('[data-testid="jd-file-info"]').text()).toContain('frontend.txt')
    await wrapper.get('[data-testid="jd-clear-file"]').trigger('click')
    expect(wrapper.emitted('clearFile')).toHaveLength(1)
  })
})
```

  `test/renderer/pages/resumeScreening/ResumeUploadCard.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

async function setup(resumes: Array<{ path: string; name: string }>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  vi.doMock('@/stores/resumeScreening', () => ({ RESUME_LIMIT: 20 }))
  const ResumeUploadCard = (
    await import(
      '../../../../src/renderer/src/pages/resumeScreening/components/ResumeUploadCard.vue'
    )
  ).default
  return mount(ResumeUploadCard, {
    props: { resumes },
    global: { stubs: { DcButton: dcButtonStub } }
  })
}

describe('ResumeUploadCard', () => {
  it('空列表渲染空态与计数', async () => {
    const wrapper = await setup([])
    expect(wrapper.get('[data-testid="resume-empty"]').text()).toContain('resumeEmpty')
    expect(wrapper.get('[data-testid="resume-count"]').text()).toContain('"current":0')
  })

  it('渲染文件列表并在移除时上抛路径', async () => {
    const wrapper = await setup([
      { path: 'C:\\a.pdf', name: 'a.pdf' },
      { path: 'C:\\b.docx', name: 'b.docx' }
    ])
    expect(wrapper.find('[data-testid="resume-empty"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="resume-item-0"]').text()).toContain('a.pdf')
    await wrapper.get('[data-testid="resume-remove-1"]').trigger('click')
    expect(wrapper.emitted('remove')?.[0]).toEqual(['C:\\b.docx'])
  })

  it('达到上限时添加按钮禁用并提示', async () => {
    const resumes = Array.from({ length: 20 }, (_, i) => ({
      path: `C:\\r${i}.pdf`,
      name: `r${i}.pdf`
    }))
    const wrapper = await setup(resumes)
    expect(
      (wrapper.get('[data-testid="resume-pick-files"]').element as HTMLButtonElement).disabled
    ).toBe(true)
    expect(wrapper.get('[data-testid="resume-limit-hint"]').text()).toContain('resumeLimitReached')
  })
})
```

  `test/renderer/pages/resumeScreening/ScreeningConfigCard.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const switchStub = defineComponent({
  name: 'SwitchStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<button type="button" @click="$emit(\'update:modelValue\', !modelValue)" />'
})

const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
})

const selectTriggerStub = defineComponent({ name: 'SelectTrigger', template: '<div><slot /></div>' })
const selectValueStub = defineComponent({ name: 'SelectValue', template: '<slot />' })
const selectContentStub = defineComponent({ name: 'SelectContent', template: '<slot />' })
const selectItemStub = defineComponent({
  name: 'SelectItem',
  props: ['value'],
  template: '<option :value="value"><slot /></option>'
})

const baseConfig = { generateExplanation: true, includeRawText: false, maxConcurrency: 3 }

async function setup(config: typeof baseConfig) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ScreeningConfigCard = (
    await import(
      '../../../../src/renderer/src/pages/resumeScreening/components/ScreeningConfigCard.vue'
    )
  ).default
  return mount(ScreeningConfigCard, {
    props: { config },
    global: {
      stubs: {
        Switch: switchStub,
        Select: selectStub,
        SelectTrigger: selectTriggerStub,
        SelectValue: selectValueStub,
        SelectContent: selectContentStub,
        SelectItem: selectItemStub
      }
    }
  })
}

describe('ScreeningConfigCard', () => {
  it('切换开关以不可变替换方式上抛完整配置', async () => {
    const wrapper = await setup(baseConfig)
    await wrapper.get('[data-testid="config-explanation"] button').trigger('click')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { generateExplanation: false, includeRawText: false, maxConcurrency: 3 }
    ])
  })

  it('选择并发数上抛数值型配置', async () => {
    const wrapper = await setup(baseConfig)
    await wrapper.find('select').setValue('2')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { generateExplanation: true, includeRawText: false, maxConcurrency: 2 }
    ])
  })

  it('渲染 5 个并发选项', async () => {
    const wrapper = await setup(baseConfig)
    expect(wrapper.findAll('option')).toHaveLength(5)
  })
})
```

  `test/renderer/pages/resumeScreening/ReviewButton.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ReviewButton = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ReviewButton.vue')
  ).default
  return mount(ReviewButton, { props, global: { stubs: { DcButton: dcButtonStub } } })
}

const startDisabled = (wrapper: { get: (selector: string) => { element: Element } }) =>
  (wrapper.get('[data-testid="review-start"]').element as HTMLButtonElement).disabled

describe('ReviewButton', () => {
  it('不可审阅时开始按钮禁用', async () => {
    const wrapper = await setup({ canReview: false, isRunning: false, isCreating: false })
    expect(startDisabled(wrapper)).toBe(true)
  })

  it('可审阅时点击上抛 review', async () => {
    const wrapper = await setup({ canReview: true, isRunning: false, isCreating: false })
    expect(startDisabled(wrapper)).toBe(false)
    await wrapper.get('[data-testid="review-start"]').trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })

  it('创建中把 loading 传给开始按钮', async () => {
    const wrapper = await setup({ canReview: true, isRunning: false, isCreating: true })
    expect(wrapper.findComponent(dcButtonStub).props('loading')).toBe(true)
  })

  it('运行中渲染取消按钮并上抛 cancel', async () => {
    const wrapper = await setup({ canReview: false, isRunning: true, isCreating: false })
    expect(wrapper.find('[data-testid="review-start"]').exists()).toBe(false)
    await wrapper.get('[data-testid="review-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
```

  `test/renderer/pages/resumeScreening/ModelSelector.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
})

const selectTriggerStub = defineComponent({ name: 'SelectTrigger', template: '<div><slot /></div>' })
const selectValueStub = defineComponent({ name: 'SelectValue', template: '<slot />' })
const selectContentStub = defineComponent({ name: 'SelectContent', template: '<slot />' })
const selectItemStub = defineComponent({
  name: 'SelectItem',
  props: ['value'],
  template: '<option :value="value"><slot /></option>'
})

const models = [
  {
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-4o',
    modelName: 'GPT-4o',
    isDefault: true
  },
  {
    providerId: 'anthropic',
    providerName: 'Anthropic',
    modelId: 'claude',
    modelName: 'Claude',
    isDefault: false
  }
]

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ModelSelector = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ModelSelector.vue')
  ).default
  return mount(ModelSelector, {
    props,
    global: {
      stubs: {
        Select: selectStub,
        SelectTrigger: selectTriggerStub,
        SelectValue: selectValueStub,
        SelectContent: selectContentStub,
        SelectItem: selectItemStub
      }
    }
  })
}

describe('ModelSelector', () => {
  it('渲染 provider/model 组合的选项', async () => {
    const wrapper = await setup({ models, modelKey: 'openai::gpt-4o' })
    const options = wrapper.findAll('option')
    expect(options).toHaveLength(2)
    expect(options[0].element.value).toBe('openai::gpt-4o')
    expect(options[1].text()).toContain('Anthropic / Claude')
  })

  it('选择模型上抛 modelKey', async () => {
    const wrapper = await setup({ models, modelKey: 'openai::gpt-4o' })
    await wrapper.find('select').setValue('anthropic::claude')
    expect(wrapper.emitted('update:modelKey')?.[0]).toEqual(['anthropic::claude'])
  })
})
```

- [ ] 跑测试确认失败：`pnpm vitest run test/renderer/pages/resumeScreening`
  （组件尚不存在）

- [ ] 创建 6 个组件。

  `src/renderer/src/pages/resumeScreening/components/JdInputCard.vue`：

```vue
<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('resumeScreening.jdSection') }}</h2>
      <div class="flex items-center gap-1">
        <DcButton
          size="xs"
          :variant="jdSource === 'text' ? 'default' : 'ghost'"
          :active="jdSource === 'text'"
          data-testid="jd-tab-text"
          @click="emit('update:jdSource', 'text')"
        >
          {{ t('resumeScreening.jdTextTab') }}
        </DcButton>
        <DcButton
          size="xs"
          :variant="jdSource === 'file' ? 'default' : 'ghost'"
          :active="jdSource === 'file'"
          data-testid="jd-tab-file"
          @click="emit('update:jdSource', 'file')"
        >
          {{ t('resumeScreening.jdFileTab') }}
        </DcButton>
      </div>
    </div>

    <Textarea
      v-if="jdSource === 'text'"
      :model-value="jdText"
      :placeholder="t('resumeScreening.jdTextPlaceholder')"
      :maxlength="JD_TEXT_MAX_LENGTH"
      data-testid="jd-text-input"
      class="mt-3 min-h-32"
      @update:model-value="(value) => emit('update:jdText', String(value))"
    />

    <div v-else class="mt-3">
      <div
        v-if="jdFilePath"
        data-testid="jd-file-info"
        class="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ jdFileName ?? jdFilePath }}</span>
        <DcButton
          icon="lucide:x"
          size="icon-xs"
          variant="ghost"
          :label="t('resumeScreening.jdClearFile')"
          data-testid="jd-clear-file"
          @click="emit('clearFile')"
        />
      </div>
      <DcButton
        v-else
        variant="outline"
        icon="lucide:file-up"
        data-testid="jd-pick-file"
        @click="emit('pickFile')"
      >
        {{ t('resumeScreening.jdPickFile') }}
      </DcButton>
      <p class="mt-2 text-xs text-muted-foreground">{{ t('resumeScreening.jdFileHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { Textarea } from '@shadcn/components/ui/textarea'

defineProps<{
  jdSource: 'text' | 'file'
  jdText: string
  jdFilePath: string | null
  jdFileName: string | null
}>()

const emit = defineEmits<{
  'update:jdSource': [value: 'text' | 'file']
  'update:jdText': [value: string]
  pickFile: []
  clearFile: []
}>()

const { t } = useI18n()

// 与 Task 1 契约的 jdText 上限（60000）保持一致
const JD_TEXT_MAX_LENGTH = 60000
</script>
```

  `src/renderer/src/pages/resumeScreening/components/ResumeUploadCard.vue`：

```vue
<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('resumeScreening.resumeSection') }}</h2>
      <span class="text-xs text-muted-foreground" data-testid="resume-count">
        {{ t('resumeScreening.resumeCount', { current: resumes.length, limit: RESUME_LIMIT }) }}
      </span>
    </div>

    <DcButton
      variant="outline"
      icon="lucide:file-plus"
      :disabled="limitReached"
      data-testid="resume-pick-files"
      class="mt-3 w-full"
      @click="emit('pickFiles')"
    >
      {{ t('resumeScreening.resumeAdd') }}
    </DcButton>

    <ul v-if="resumes.length" class="mt-3 space-y-1" data-testid="resume-list">
      <li
        v-for="(resume, index) in resumes"
        :key="resume.path"
        class="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
        :data-testid="`resume-item-${index}`"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ resume.name }}</span>
        <DcButton
          icon="lucide:x"
          size="icon-xs"
          variant="ghost"
          :label="t('resumeScreening.resumeRemove')"
          :data-testid="`resume-remove-${index}`"
          @click="emit('remove', resume.path)"
        />
      </li>
    </ul>
    <p v-else class="mt-3 text-xs text-muted-foreground" data-testid="resume-empty">
      {{ t('resumeScreening.resumeEmpty') }}
    </p>

    <p v-if="limitReached" class="mt-2 text-xs text-destructive" data-testid="resume-limit-hint">
      {{ t('resumeScreening.resumeLimitReached', { limit: RESUME_LIMIT }) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { RESUME_LIMIT, type PickedResume } from '@/stores/resumeScreening'

const props = defineProps<{
  resumes: PickedResume[]
}>()

const emit = defineEmits<{
  pickFiles: []
  remove: [path: string]
}>()

const { t } = useI18n()

const limitReached = computed(() => props.resumes.length >= RESUME_LIMIT)
</script>
```

  `src/renderer/src/pages/resumeScreening/components/ScreeningConfigCard.vue`：

```vue
<template>
  <div class="rounded-lg border p-4">
    <h2 class="text-sm font-medium">{{ t('resumeScreening.configSection') }}</h2>

    <div class="mt-3 space-y-3">
      <div class="flex items-center justify-between text-sm" data-testid="config-explanation">
        <span>{{ t('resumeScreening.configGenerateExplanation') }}</span>
        <Switch
          :model-value="config.generateExplanation"
          @update:model-value="(value) => update({ generateExplanation: Boolean(value) })"
        />
      </div>
      <div class="flex items-center justify-between text-sm" data-testid="config-raw-text">
        <span>{{ t('resumeScreening.configIncludeRawText') }}</span>
        <Switch
          :model-value="config.includeRawText"
          @update:model-value="(value) => update({ includeRawText: Boolean(value) })"
        />
      </div>
      <div class="flex items-center justify-between text-sm">
        <span>{{ t('resumeScreening.configMaxConcurrency') }}</span>
        <Select
          :model-value="String(config.maxConcurrency)"
          @update:model-value="(value) => update({ maxConcurrency: Number(value) })"
        >
          <SelectTrigger class="h-8 w-20" data-testid="config-concurrency-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="n in 5" :key="n" :value="String(n)">{{ n }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Switch } from '@shadcn/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'

export interface ScreeningConfig {
  generateExplanation: boolean
  includeRawText: boolean
  maxConcurrency: number
}

const props = defineProps<{
  config: ScreeningConfig
}>()

const emit = defineEmits<{
  'update:config': [config: ScreeningConfig]
}>()

const { t } = useI18n()

function update(patch: Partial<ScreeningConfig>) {
  emit('update:config', { ...props.config, ...patch })
}
</script>
```

  `src/renderer/src/pages/resumeScreening/components/ReviewButton.vue`：

```vue
<template>
  <div class="flex items-center gap-2" data-testid="review-actions">
    <DcButton
      v-if="isRunning"
      variant="destructive"
      icon="lucide:square"
      data-testid="review-cancel"
      @click="emit('cancel')"
    >
      {{ t('resumeScreening.reviewCancel') }}
    </DcButton>
    <DcButton
      v-else
      :disabled="!canReview"
      :loading="isCreating"
      data-testid="review-start"
      @click="emit('review')"
    >
      {{ t('resumeScreening.reviewStart') }}
    </DcButton>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'

defineProps<{
  canReview: boolean
  isRunning: boolean
  isCreating: boolean
}>()

const emit = defineEmits<{
  review: []
  cancel: []
}>()

const { t } = useI18n()
</script>
```

  `src/renderer/src/pages/resumeScreening/components/UserProfileBadge.vue`（纯展示，无测试）：

```vue
<template>
  <div class="flex items-center gap-2 text-sm" data-testid="user-profile-badge">
    <Icon icon="lucide:user" class="size-4 text-muted-foreground" />
    <span class="font-medium">{{ name }}</span>
    <span class="text-muted-foreground">{{ email }}</span>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
  name: string
  email: string
}>()
</script>
```

  `src/renderer/src/pages/resumeScreening/components/ModelSelector.vue`：

```vue
<template>
  <div class="flex items-center justify-between text-sm">
    <span>{{ t('resumeScreening.modelLabel') }}</span>
    <Select
      :model-value="modelKey ?? ''"
      @update:model-value="(value) => emit('update:modelKey', String(value))"
    >
      <SelectTrigger class="h-8 min-w-48" data-testid="model-select-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="model in models" :key="modelKeyOf(model)" :value="modelKeyOf(model)">
          {{ model.providerName }} / {{ model.modelName }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import type { ResumeScreeningModelOption } from '@/stores/resumeScreening'

defineProps<{
  models: ResumeScreeningModelOption[]
  modelKey: string | null
}>()

const emit = defineEmits<{
  'update:modelKey': [key: string]
}>()

const { t } = useI18n()

function modelKeyOf(model: ResumeScreeningModelOption) {
  return `${model.providerId}::${model.modelId}`
}
</script>
```

- [ ] 跑测试确认通过：`pnpm vitest run test/renderer/pages/resumeScreening`

- [ ] 修改 `src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`：用以下内容整体替换
  Task 12 建的骨架（文件选择用 [SkillInstallDialog.vue](../../../src/renderer/src/pages/plugins/skills/SkillInstallDialog.vue)
  L312-316 的 `selectFiles` 先例；`basename` 镜像 [DocumentRecognizeDialog.vue](../../../src/renderer/src/pages/documents/DocumentRecognizeDialog.vue)
  的 uri basename 提取）。注意：ReviewButton 的事件名是 `review`（对应 store 无 `isRunning`，传
  `isTaskActive`）；ResumeUploadCard 的事件名是 `pickFiles`；UserProfileBadge 用 `name`/`email`
  两个 prop：

```vue
<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">{{ t('resumeScreening.title') }}</h1>
      <UserProfileBadge
        v-if="store.profile"
        :name="store.profile.name"
        :email="store.profile.email"
      />
    </header>

    <div
      class="grid min-h-0 flex-1 grid-cols-[380px_1fr] divide-x"
      data-testid="resume-screening-workspace"
    >
      <aside
        class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        data-testid="resume-screening-create-panel"
      >
        <JdInputCard
          :jd-source="store.draft.jdSource"
          :jd-text="store.draft.jdText"
          :jd-file-path="store.draft.jdFilePath"
          :jd-file-name="store.draft.jdFileName"
          @update:jd-source="(value) => (store.draft.jdSource = value)"
          @update:jd-text="(value) => (store.draft.jdText = value)"
          @pick-file="onPickJdFile"
          @clear-file="clearJdFile"
        />
        <ResumeUploadCard
          :resumes="store.draft.resumes"
          @pick-files="onPickResumeFiles"
          @remove="removeResume"
        />
        <ScreeningConfigCard
          :config="store.draft.config"
          @update:config="(config) => (store.draft.config = config)"
        />
        <ModelSelector
          v-if="store.models.length > 0"
          :models="store.models"
          :model-key="store.selectedModelKey"
          @update:model-key="onSelectModel"
        />
        <p v-if="store.createError" class="text-sm text-destructive" data-testid="create-error">
          {{ store.createError }}
        </p>
        <ReviewButton
          :can-review="store.canReview"
          :is-running="store.isTaskActive"
          :is-creating="store.isCreating"
          @review="onReview"
          @cancel="store.cancelTask()"
        />
      </aside>

      <section class="min-h-0 overflow-y-auto p-6" data-testid="resume-screening-detail-panel">
        <!-- Task 15 填充右栏任务详情 -->
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { createDeviceClient } from '@api/DeviceClient'
import { RESUME_LIMIT, useResumeScreeningStore } from '@/stores/resumeScreening'
import JdInputCard from './components/JdInputCard.vue'
import ResumeUploadCard from './components/ResumeUploadCard.vue'
import ScreeningConfigCard from './components/ScreeningConfigCard.vue'
import ReviewButton from './components/ReviewButton.vue'
import UserProfileBadge from './components/UserProfileBadge.vue'
import ModelSelector from './components/ModelSelector.vue'

const { t } = useI18n()
const deviceClient = createDeviceClient()
const store = useResumeScreeningStore()

// 与 Task 1 契约的扩展名白名单一致
const FILE_FILTERS = [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }]

onMounted(() => {
  void store.loadProfile()
  void store.loadModels()
})

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

async function onPickJdFile() {
  const result = await deviceClient.selectFiles({ multiple: false, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const filePath = result.filePaths[0]
  store.draft.jdFilePath = filePath
  store.draft.jdFileName = basename(filePath)
}

function clearJdFile() {
  store.draft.jdFilePath = null
  store.draft.jdFileName = null
}

async function onPickResumeFiles() {
  const result = await deviceClient.selectFiles({ multiple: true, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const existing = new Set(store.draft.resumes.map((item) => item.path))
  for (const filePath of result.filePaths) {
    if (store.draft.resumes.length >= RESUME_LIMIT || existing.has(filePath)) continue
    existing.add(filePath)
    store.draft.resumes.push({ path: filePath, name: basename(filePath) })
  }
}

function removeResume(path: string) {
  const index = store.draft.resumes.findIndex((item) => item.path === path)
  if (index >= 0) store.draft.resumes.splice(index, 1)
}

function onSelectModel(key: string) {
  const [providerId, modelId] = key.split('::')
  if (providerId && modelId) store.selectModel(providerId, modelId)
}

function onReview() {
  void store.createTask()
}
</script>
```

- [ ] 跑 typecheck：`pnpm typecheck`

- [ ] 为 20 个 locale 的 `src/renderer/src/i18n/{locale}/resumeScreening.json` 补齐组件文案键
  （在 `title` 之后追加；zh-CN 为源，其余 locale 键集必须与 zh-CN 一致，注意 JSON 逗号）：

  zh-CN 追加：

```json
{
  "jdSection": "职位描述",
  "jdTextTab": "粘贴文本",
  "jdFileTab": "上传文件",
  "jdTextPlaceholder": "粘贴职位描述内容",
  "jdPickFile": "选择文件",
  "jdFileHint": "支持 PDF、DOCX、TXT、MD",
  "jdClearFile": "移除文件",
  "resumeSection": "简历文件",
  "resumeAdd": "添加简历",
  "resumeCount": "已选 {current}/{limit}",
  "resumeLimitReached": "最多只能添加 {limit} 份简历",
  "resumeEmpty": "尚未添加简历",
  "resumeRemove": "移除",
  "configSection": "审阅配置",
  "configGenerateExplanation": "生成审阅说明",
  "configIncludeRawText": "结果携带简历原文",
  "configMaxConcurrency": "并发数",
  "reviewStart": "开始审阅",
  "reviewCancel": "取消任务",
  "modelLabel": "模型"
}
```

  en-US 追加：

```json
{
  "jdSection": "Job Description",
  "jdTextTab": "Paste Text",
  "jdFileTab": "Upload File",
  "jdTextPlaceholder": "Paste the job description",
  "jdPickFile": "Choose File",
  "jdFileHint": "Supports PDF, DOCX, TXT, MD",
  "jdClearFile": "Remove File",
  "resumeSection": "Resume Files",
  "resumeAdd": "Add Resumes",
  "resumeCount": "{current}/{limit} selected",
  "resumeLimitReached": "You can add up to {limit} resumes",
  "resumeEmpty": "No resumes added yet",
  "resumeRemove": "Remove",
  "configSection": "Screening Settings",
  "configGenerateExplanation": "Generate review notes",
  "configIncludeRawText": "Include resume raw text in results",
  "configMaxConcurrency": "Concurrency",
  "reviewStart": "Start Screening",
  "reviewCancel": "Cancel Task",
  "modelLabel": "Model"
}
```

  ja-JP 追加：

```json
{
  "jdSection": "職務内容",
  "jdTextTab": "テキスト貼り付け",
  "jdFileTab": "ファイルアップロード",
  "jdTextPlaceholder": "職務内容を貼り付けてください",
  "jdPickFile": "ファイルを選択",
  "jdFileHint": "PDF、DOCX、TXT、MD に対応",
  "jdClearFile": "ファイルを削除",
  "resumeSection": "履歴書ファイル",
  "resumeAdd": "履歴書を追加",
  "resumeCount": "{current}/{limit} 件選択中",
  "resumeLimitReached": "追加できる履歴書は最大 {limit} 件です",
  "resumeEmpty": "履歴書はまだ追加されていません",
  "resumeRemove": "削除",
  "configSection": "スクリーニング設定",
  "configGenerateExplanation": "レビューコメントを生成",
  "configIncludeRawText": "結果に履歴書原文を含める",
  "configMaxConcurrency": "同時実行数",
  "reviewStart": "スクリーニング開始",
  "reviewCancel": "タスクをキャンセル",
  "modelLabel": "モデル"
}
```

  ko-KR 追加：

```json
{
  "jdSection": "직무 기술",
  "jdTextTab": "텍스트 붙여넣기",
  "jdFileTab": "파일 업로드",
  "jdTextPlaceholder": "직무 기술을 붙여넣으세요",
  "jdPickFile": "파일 선택",
  "jdFileHint": "PDF, DOCX, TXT, MD 지원",
  "jdClearFile": "파일 제거",
  "resumeSection": "이력서 파일",
  "resumeAdd": "이력서 추가",
  "resumeCount": "{current}/{limit}개 선택됨",
  "resumeLimitReached": "최대 {limit}개의 이력서를 추가할 수 있습니다",
  "resumeEmpty": "아직 추가된 이력서가 없습니다",
  "resumeRemove": "제거",
  "configSection": "스크리닝 설정",
  "configGenerateExplanation": "검토 의견 생성",
  "configIncludeRawText": "결과에 이력서 원문 포함",
  "configMaxConcurrency": "동시 실행 수",
  "reviewStart": "스크리닝 시작",
  "reviewCancel": "작업 취소",
  "modelLabel": "모델"
}
```

  zh-TW 追加：

```json
{
  "jdSection": "職務描述",
  "jdTextTab": "貼上文字",
  "jdFileTab": "上傳檔案",
  "jdTextPlaceholder": "貼上職務描述內容",
  "jdPickFile": "選擇檔案",
  "jdFileHint": "支援 PDF、DOCX、TXT、MD",
  "jdClearFile": "移除檔案",
  "resumeSection": "履歷檔案",
  "resumeAdd": "新增履歷",
  "resumeCount": "已選 {current}/{limit}",
  "resumeLimitReached": "最多只能新增 {limit} 份履歷",
  "resumeEmpty": "尚未新增履歷",
  "resumeRemove": "移除",
  "configSection": "審閱設定",
  "configGenerateExplanation": "產生審閱說明",
  "configIncludeRawText": "結果附帶履歷原文",
  "configMaxConcurrency": "並行數",
  "reviewStart": "開始審閱",
  "reviewCancel": "取消任務",
  "modelLabel": "模型"
}
```

  zh-HK 追加：

```json
{
  "jdSection": "職位描述",
  "jdTextTab": "貼上文字",
  "jdFileTab": "上載檔案",
  "jdTextPlaceholder": "貼上職位描述內容",
  "jdPickFile": "選擇檔案",
  "jdFileHint": "支援 PDF、DOCX、TXT、MD",
  "jdClearFile": "移除檔案",
  "resumeSection": "履歷檔案",
  "resumeAdd": "新增履歷",
  "resumeCount": "已選 {current}/{limit}",
  "resumeLimitReached": "最多只能新增 {limit} 份履歷",
  "resumeEmpty": "尚未新增履歷",
  "resumeRemove": "移除",
  "configSection": "審閱設定",
  "configGenerateExplanation": "產生審閱說明",
  "configIncludeRawText": "結果附帶履歷原文",
  "configMaxConcurrency": "並行數",
  "reviewStart": "開始審閱",
  "reviewCancel": "取消任務",
  "modelLabel": "模型"
}
```

  vi-VN 追加：

```json
{
  "jdSection": "Mô tả công việc",
  "jdTextTab": "Dán văn bản",
  "jdFileTab": "Tải tệp lên",
  "jdTextPlaceholder": "Dán nội dung mô tả công việc",
  "jdPickFile": "Chọn tệp",
  "jdFileHint": "Hỗ trợ PDF, DOCX, TXT, MD",
  "jdClearFile": "Gỡ tệp",
  "resumeSection": "Tệp hồ sơ",
  "resumeAdd": "Thêm hồ sơ",
  "resumeCount": "Đã chọn {current}/{limit}",
  "resumeLimitReached": "Chỉ có thể thêm tối đa {limit} hồ sơ",
  "resumeEmpty": "Chưa thêm hồ sơ nào",
  "resumeRemove": "Gỡ bỏ",
  "configSection": "Cấu hình sàng lọc",
  "configGenerateExplanation": "Tạo nhận xét đánh giá",
  "configIncludeRawText": "Kèm văn bản gốc của hồ sơ",
  "configMaxConcurrency": "Số chạy đồng thời",
  "reviewStart": "Bắt đầu đánh giá",
  "reviewCancel": "Hủy tác vụ",
  "modelLabel": "Mô hình"
}
```

  tr-TR 追加：

```json
{
  "jdSection": "İş Tanımı",
  "jdTextTab": "Metin Yapıştır",
  "jdFileTab": "Dosya Yükle",
  "jdTextPlaceholder": "İş tanımını yapıştırın",
  "jdPickFile": "Dosya Seç",
  "jdFileHint": "PDF, DOCX, TXT, MD desteklenir",
  "jdClearFile": "Dosyayı Kaldır",
  "resumeSection": "Özgeçmiş Dosyaları",
  "resumeAdd": "Özgeçmiş Ekle",
  "resumeCount": "{current}/{limit} seçildi",
  "resumeLimitReached": "En fazla {limit} özgeçmiş ekleyebilirsiniz",
  "resumeEmpty": "Henüz özgeçmiş eklenmedi",
  "resumeRemove": "Kaldır",
  "configSection": "Eleme Ayarları",
  "configGenerateExplanation": "Değerlendirme notu oluştur",
  "configIncludeRawText": "Sonuçlara özgeçmiş ham metnini ekle",
  "configMaxConcurrency": "Eşzamanlılık",
  "reviewStart": "Elemeyi Başlat",
  "reviewCancel": "Görevi İptal Et",
  "modelLabel": "Model"
}
```

  ru-RU 追加：

```json
{
  "jdSection": "Описание вакансии",
  "jdTextTab": "Вставить текст",
  "jdFileTab": "Загрузить файл",
  "jdTextPlaceholder": "Вставьте описание вакансии",
  "jdPickFile": "Выбрать файл",
  "jdFileHint": "Поддерживаются PDF, DOCX, TXT, MD",
  "jdClearFile": "Убрать файл",
  "resumeSection": "Файлы резюме",
  "resumeAdd": "Добавить резюме",
  "resumeCount": "Выбрано {current}/{limit}",
  "resumeLimitReached": "Можно добавить не более {limit} резюме",
  "resumeEmpty": "Резюме пока не добавлены",
  "resumeRemove": "Убрать",
  "configSection": "Настройки скрининга",
  "configGenerateExplanation": "Создавать комментарии к оценке",
  "configIncludeRawText": "Включать исходный текст резюме",
  "configMaxConcurrency": "Параллелизм",
  "reviewStart": "Начать проверку",
  "reviewCancel": "Отменить задачу",
  "modelLabel": "Модель"
}
```

  pt-BR 追加：

```json
{
  "jdSection": "Descrição da Vaga",
  "jdTextTab": "Colar Texto",
  "jdFileTab": "Enviar Arquivo",
  "jdTextPlaceholder": "Cole a descrição da vaga",
  "jdPickFile": "Escolher Arquivo",
  "jdFileHint": "Suporta PDF, DOCX, TXT, MD",
  "jdClearFile": "Remover Arquivo",
  "resumeSection": "Arquivos de Currículo",
  "resumeAdd": "Adicionar Currículos",
  "resumeCount": "{current}/{limit} selecionados",
  "resumeLimitReached": "É possível adicionar até {limit} currículos",
  "resumeEmpty": "Nenhum currículo adicionado ainda",
  "resumeRemove": "Remover",
  "configSection": "Configurações da Triagem",
  "configGenerateExplanation": "Gerar observações de avaliação",
  "configIncludeRawText": "Incluir texto original do currículo",
  "configMaxConcurrency": "Concorrência",
  "reviewStart": "Iniciar Triagem",
  "reviewCancel": "Cancelar Tarefa",
  "modelLabel": "Modelo"
}
```

  pl-PL 追加：

```json
{
  "jdSection": "Opis stanowiska",
  "jdTextTab": "Wklej tekst",
  "jdFileTab": "Prześlij plik",
  "jdTextPlaceholder": "Wklej opis stanowiska",
  "jdPickFile": "Wybierz plik",
  "jdFileHint": "Obsługuje PDF, DOCX, TXT, MD",
  "jdClearFile": "Usuń plik",
  "resumeSection": "Pliki CV",
  "resumeAdd": "Dodaj CV",
  "resumeCount": "Wybrano {current}/{limit}",
  "resumeLimitReached": "Można dodać maksymalnie {limit} CV",
  "resumeEmpty": "Nie dodano jeszcze żadnego CV",
  "resumeRemove": "Usuń",
  "configSection": "Ustawienia selekcji",
  "configGenerateExplanation": "Generuj uwagi do oceny",
  "configIncludeRawText": "Dołącz surowy tekst CV",
  "configMaxConcurrency": "Współbieżność",
  "reviewStart": "Rozpocznij selekcję",
  "reviewCancel": "Anuluj zadanie",
  "modelLabel": "Model"
}
```

  ms-MY 追加：

```json
{
  "jdSection": "Penerangan Jawatan",
  "jdTextTab": "Tampal Teks",
  "jdFileTab": "Muat Naik Fail",
  "jdTextPlaceholder": "Tampal penerangan jawatan",
  "jdPickFile": "Pilih Fail",
  "jdFileHint": "Menyokong PDF, DOCX, TXT, MD",
  "jdClearFile": "Buang Fail",
  "resumeSection": "Fail Resume",
  "resumeAdd": "Tambah Resume",
  "resumeCount": "{current}/{limit} dipilih",
  "resumeLimitReached": "Anda hanya boleh menambah sehingga {limit} resume",
  "resumeEmpty": "Tiada resume ditambah lagi",
  "resumeRemove": "Buang",
  "configSection": "Tetapan Penapisan",
  "configGenerateExplanation": "Jana nota ulasan",
  "configIncludeRawText": "Sertakan teks asal resume",
  "configMaxConcurrency": "Serentak",
  "reviewStart": "Mula Penapisan",
  "reviewCancel": "Batalkan Tugasan",
  "modelLabel": "Model"
}
```

  it-IT 追加：

```json
{
  "jdSection": "Descrizione della Posizione",
  "jdTextTab": "Incolla Testo",
  "jdFileTab": "Carica File",
  "jdTextPlaceholder": "Incolla la descrizione della posizione",
  "jdPickFile": "Scegli File",
  "jdFileHint": "Supporta PDF, DOCX, TXT, MD",
  "jdClearFile": "Rimuovi File",
  "resumeSection": "File CV",
  "resumeAdd": "Aggiungi CV",
  "resumeCount": "{current}/{limit} selezionati",
  "resumeLimitReached": "Puoi aggiungere al massimo {limit} CV",
  "resumeEmpty": "Nessun CV aggiunto",
  "resumeRemove": "Rimuovi",
  "configSection": "Impostazioni Screening",
  "configGenerateExplanation": "Genera note di revisione",
  "configIncludeRawText": "Includi testo originale del CV",
  "configMaxConcurrency": "Concorrenza",
  "reviewStart": "Avvia Screening",
  "reviewCancel": "Annulla Attività",
  "modelLabel": "Modello"
}
```

  id-ID 追加：

```json
{
  "jdSection": "Deskripsi Posisi",
  "jdTextTab": "Tempel Teks",
  "jdFileTab": "Unggah Berkas",
  "jdTextPlaceholder": "Tempel deskripsi posisi",
  "jdPickFile": "Pilih Berkas",
  "jdFileHint": "Mendukung PDF, DOCX, TXT, MD",
  "jdClearFile": "Hapus Berkas",
  "resumeSection": "Berkas Resume",
  "resumeAdd": "Tambah Resume",
  "resumeCount": "{current}/{limit} dipilih",
  "resumeLimitReached": "Anda hanya dapat menambah hingga {limit} resume",
  "resumeEmpty": "Belum ada resume yang ditambahkan",
  "resumeRemove": "Hapus",
  "configSection": "Pengaturan Penyaringan",
  "configGenerateExplanation": "Buat catatan tinjauan",
  "configIncludeRawText": "Sertakan teks asli resume",
  "configMaxConcurrency": "Konkurensi",
  "reviewStart": "Mulai Penyaringan",
  "reviewCancel": "Batalkan Tugas",
  "modelLabel": "Model"
}
```

  he-IL 追加：

```json
{
  "jdSection": "תיאור התפקיד",
  "jdTextTab": "הדבקת טקסט",
  "jdFileTab": "העלאת קובץ",
  "jdTextPlaceholder": "הדביקו את תיאור התפקיד",
  "jdPickFile": "בחירת קובץ",
  "jdFileHint": "תמיכה ב-PDF, DOCX, TXT, MD",
  "jdClearFile": "הסרת קובץ",
  "resumeSection": "קבצי קורות חיים",
  "resumeAdd": "הוספת קורות חיים",
  "resumeCount": "נבחרו {current}/{limit}",
  "resumeLimitReached": "ניתן להוסיף עד {limit} קורות חיים",
  "resumeEmpty": "טרם נוספו קורות חיים",
  "resumeRemove": "הסרה",
  "configSection": "הגדרות סינון",
  "configGenerateExplanation": "יצירת הערות סקירה",
  "configIncludeRawText": "כלול טקסט מקורי של קורות החיים",
  "configMaxConcurrency": "מקביליות",
  "reviewStart": "התחלת סינון",
  "reviewCancel": "ביטול משימה",
  "modelLabel": "מודל"
}
```

  fr-FR 追加：

```json
{
  "jdSection": "Description du Poste",
  "jdTextTab": "Coller le texte",
  "jdFileTab": "Téléverser un fichier",
  "jdTextPlaceholder": "Collez la description du poste",
  "jdPickFile": "Choisir un fichier",
  "jdFileHint": "Prend en charge PDF, DOCX, TXT, MD",
  "jdClearFile": "Retirer le fichier",
  "resumeSection": "Fichiers CV",
  "resumeAdd": "Ajouter des CV",
  "resumeCount": "{current}/{limit} sélectionnés",
  "resumeLimitReached": "Vous pouvez ajouter au maximum {limit} CV",
  "resumeEmpty": "Aucun CV ajouté pour le moment",
  "resumeRemove": "Retirer",
  "configSection": "Paramètres de tri",
  "configGenerateExplanation": "Générer des commentaires d'évaluation",
  "configIncludeRawText": "Inclure le texte brut du CV",
  "configMaxConcurrency": "Concurrence",
  "reviewStart": "Lancer le tri",
  "reviewCancel": "Annuler la tâche",
  "modelLabel": "Modèle"
}
```

  fa-IR 追加：

```json
{
  "jdSection": "شرح شغلی",
  "jdTextTab": "چسباندن متن",
  "jdFileTab": "بارگذاری فایل",
  "jdTextPlaceholder": "شرح شغلی را بچسبانید",
  "jdPickFile": "انتخاب فایل",
  "jdFileHint": "پشتیبانی از PDF، DOCX، TXT، MD",
  "jdClearFile": "حذف فایل",
  "resumeSection": "فایل‌های رزومه",
  "resumeAdd": "افزودن رزومه",
  "resumeCount": "{current}/{limit} انتخاب شد",
  "resumeLimitReached": "حداکثر می‌توانید {limit} رزومه اضافه کنید",
  "resumeEmpty": "هنوز رزومه‌ای اضافه نشده است",
  "resumeRemove": "حذف",
  "configSection": "تنظیمات غربالگری",
  "configGenerateExplanation": "تولید یادداشت‌های بررسی",
  "configIncludeRawText": "درج متن اصلی رزومه در نتایج",
  "configMaxConcurrency": "همزمانی",
  "reviewStart": "شروع غربالگری",
  "reviewCancel": "لغو وظیفه",
  "modelLabel": "مدل"
}
```

  es-ES 追加：

```json
{
  "jdSection": "Descripción del Puesto",
  "jdTextTab": "Pegar Texto",
  "jdFileTab": "Subir Archivo",
  "jdTextPlaceholder": "Pega la descripción del puesto",
  "jdPickFile": "Elegir Archivo",
  "jdFileHint": "Compatible con PDF, DOCX, TXT, MD",
  "jdClearFile": "Quitar Archivo",
  "resumeSection": "Archivos de CV",
  "resumeAdd": "Añadir CV",
  "resumeCount": "{current}/{limit} seleccionados",
  "resumeLimitReached": "Puedes añadir un máximo de {limit} CV",
  "resumeEmpty": "Aún no se han añadido CV",
  "resumeRemove": "Quitar",
  "configSection": "Ajustes de Filtrado",
  "configGenerateExplanation": "Generar observaciones de revisión",
  "configIncludeRawText": "Incluir texto original del CV",
  "configMaxConcurrency": "Concurrencia",
  "reviewStart": "Iniciar Filtrado",
  "reviewCancel": "Cancelar Tarea",
  "modelLabel": "Modelo"
}
```

  de-DE 追加：

```json
{
  "jdSection": "Stellenbeschreibung",
  "jdTextTab": "Text einfügen",
  "jdFileTab": "Datei hochladen",
  "jdTextPlaceholder": "Stellenbeschreibung einfügen",
  "jdPickFile": "Datei auswählen",
  "jdFileHint": "Unterstützt PDF, DOCX, TXT, MD",
  "jdClearFile": "Datei entfernen",
  "resumeSection": "Lebenslauf-Dateien",
  "resumeAdd": "Lebensläufe hinzufügen",
  "resumeCount": "{current}/{limit} ausgewählt",
  "resumeLimitReached": "Es können maximal {limit} Lebensläufe hinzugefügt werden",
  "resumeEmpty": "Noch keine Lebensläufe hinzugefügt",
  "resumeRemove": "Entfernen",
  "configSection": "Screening-Einstellungen",
  "configGenerateExplanation": "Prüfnotizen erstellen",
  "configIncludeRawText": "Lebenslauf-Originaltext in Ergebnisse aufnehmen",
  "configMaxConcurrency": "Parallelität",
  "reviewStart": "Screening starten",
  "reviewCancel": "Aufgabe abbrechen",
  "modelLabel": "Modell"
}
```

  da-DK 追加：

```json
{
  "jdSection": "Stillingbeskrivelse",
  "jdTextTab": "Indsæt tekst",
  "jdFileTab": "Upload fil",
  "jdTextPlaceholder": "Indsæt stillingbeskrivelsen",
  "jdPickFile": "Vælg fil",
  "jdFileHint": "Understøtter PDF, DOCX, TXT, MD",
  "jdClearFile": "Fjern fil",
  "resumeSection": "CV-filer",
  "resumeAdd": "Tilføj CV'er",
  "resumeCount": "{current}/{limit} valgt",
  "resumeLimitReached": "Du kan højst tilføje {limit} CV'er",
  "resumeEmpty": "Ingen CV'er tilføjet endnu",
  "resumeRemove": "Fjern",
  "configSection": "Screening-indstillinger",
  "configGenerateExplanation": "Generér vurderingsnoter",
  "configIncludeRawText": "Medtag CV-tekst i resultater",
  "configMaxConcurrency": "Samtidighed",
  "reviewStart": "Start screening",
  "reviewCancel": "Annuller opgave",
  "modelLabel": "Model"
}
```

- [ ] 再生成 i18n 类型并验证（新增键后必须再生成，否则 typecheck 失败）：

```sh
pnpm i18n:types
pnpm typecheck
pnpm i18n
```

- [ ] Commit：`feat(resume-screening): add left column components`

## Task 15: 右栏任务详情组件 + 事件订阅

**Files:**

- 新建：`src/renderer/src/pages/resumeScreening/components/statusPresentation.ts`
- 新建：`src/renderer/src/pages/resumeScreening/components/TaskHistoryList.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/TaskProgressHeader.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ResumeListPanel.vue`
- 新建：`src/renderer/src/pages/resumeScreening/components/ResumeDetailPanel.vue`
- 新建：`test/renderer/pages/resumeScreening/TaskHistoryList.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ResumeListPanel.test.ts`
- 新建：`test/renderer/pages/resumeScreening/ResumeDetailPanel.test.ts`
- 修改：`src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`（左栏追加任务历史 + 右栏装配 + 事件订阅）
- 修改：20 个 locale 的 `src/renderer/src/i18n/{locale}/resumeScreening.json`（追加详情文案键）
- 再生成：`src/types/i18n.d.ts`

**背景知识**：

- 组件延续 Task 14 的纯 props/emits 设计，测试无需 mock store；DTO 类型从
  `@api/resumeScreeningTasks` type-only 导入（Task 11 产物，运行时擦除，无 bridge 副作用）
- [DcBadge.vue](../../../src/dc-ui/components/badge/DcBadge.vue) variant 全集：
  default/secondary/destructive/outline + success/warning/danger/active/neutral；
  本域状态映射（`statusPresentation.ts` 统一实现）：running→active、completed/done→success、
  partial→warning、failed→danger、其余（queued/cancelled/pending）→neutral
- 状态文案键动态拼接 `status${首字母大写}`：statusQueued/statusRunning/statusCompleted/
  statusPartial/statusFailed/statusCancelled/statusPending/statusDone（任务与简历共用
  running/failed；`statusCompleted` 与 `statusDone` 分开建键避免语义混用）
- 时间显示沿用 [DocumentsArchivePage.vue](../../../src/renderer/src/pages/documents/DocumentsArchivePage.vue)
  L154 的 `new Date(x).toLocaleString()`
- `resumeInfo` 是契约宽松字段（`z.unknown()`，见计划 Task 1 L130 备注）：展示层按
  `Record<string, unknown>` 键值对渲染，值格式化：数组顿号 join、对象 JSON.stringify、
  null/undefined 显示 `—`
- 事件订阅：`resumeScreeningApi.onTaskUpdated/onResumeUpdated`（Task 11）返回 `() => void`；
  onMounted 内订阅 + `store.loadTasks()`，onUnmounted 清理（镜像 store 事件处理器的调用方装配）
- 组件测试沿用 Task 14 模板：`vi.resetModules()` + `vi.doMock('vue-i18n')` + 文件内 stub

### 步骤

- [ ] 创建 `test/renderer/pages/resumeScreening/TaskHistoryList.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(props: {
  tasks: ResumeScreeningTaskDto[]
  tasksLoaded: boolean
  selectedId: string | null
}) {
  const { default: TaskHistoryList } = await import(
    '@/pages/resumeScreening/components/TaskHistoryList.vue'
  )
  const wrapper = mount(TaskHistoryList, {
    props,
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
  return wrapper
}

function makeTask(overrides: Partial<ResumeScreeningTaskDto> = {}): ResumeScreeningTaskDto {
  return {
    id: 'task-1',
    status: 'completed',
    jdSource: 'text',
    jdText: '前端工程师',
    jdFileName: null,
    jdAnalysis: null,
    config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
    providerId: 'openai',
    modelId: 'gpt-4o',
    total: 2,
    succeeded: 1,
    failed: 1,
    avgScore: 78.5,
    recommendedCount: 1,
    createdByName: '张三',
    createdByEmail: 'zhang@example.com',
    startedAt: 1700000000000,
    finishedAt: 1700000060000,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('TaskHistoryList', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('任务列表为空且已加载时显示空态', async () => {
    wrapper = await setup({ tasks: [], tasksLoaded: true, selectedId: null })
    expect(wrapper.find('[data-testid="history-empty"]').exists()).toBe(true)
  })

  it('渲染任务条目（状态徽标 + 进度 + 时间）', async () => {
    wrapper = await setup({
      tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', status: 'running', total: 5, succeeded: 2, failed: 0 })],
      tasksLoaded: true,
      selectedId: null
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('resumeScreening.statusCompleted')
    expect(items[0].text()).toContain('2/2')
    expect(items[1].text()).toContain('resumeScreening.statusRunning')
    expect(items[1].text()).toContain('2/5')
  })

  it('选中项带高亮样式', async () => {
    wrapper = await setup({
      tasks: [makeTask({ id: 'task-1' })],
      tasksLoaded: true,
      selectedId: 'task-1'
    })
    expect(wrapper.find('[data-testid="history-item-task-1"]').classes()).toContain('bg-muted')
  })

  it('点击条目上抛 select(taskId)', async () => {
    wrapper = await setup({ tasks: [makeTask({ id: 'task-1' })], tasksLoaded: true, selectedId: null })
    await wrapper.find('[data-testid="history-item-task-1"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['task-1'])
  })
})
```

- [ ] 创建 `test/renderer/pages/resumeScreening/ResumeListPanel.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(props: {
  resumes: ResumeScreeningResumeDto[]
  selectedId: string | null
}) {
  const { default: ResumeListPanel } = await import(
    '@/pages/resumeScreening/components/ResumeListPanel.vue'
  )
  const wrapper = mount(ResumeListPanel, {
    props,
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
  return wrapper
}

function makeResume(overrides: Partial<ResumeScreeningResumeDto> = {}): ResumeScreeningResumeDto {
  return {
    id: 'resume-1',
    taskId: 'task-1',
    fileName: '张三.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    candidateName: '张三',
    rawText: null,
    resumeInfo: null,
    screening: null,
    interview: null,
    hr: null,
    score: 85,
    recommended: true,
    status: 'done',
    error: null,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('ResumeListPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('渲染简历条目（候选人名 + 状态徽标 + 分数）', async () => {
    wrapper = await setup({
      resumes: [makeResume(), makeResume({ id: 'resume-2', candidateName: null, status: 'running', score: null })],
      selectedId: null
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('张三')
    expect(items[0].text()).toContain('85')
    expect(items[0].text()).toContain('resumeScreening.statusDone')
    expect(items[1].text()).toContain('张三.pdf')
    expect(items[1].text()).toContain('resumeScreening.statusRunning')
  })

  it('推荐简历显示推荐标记', async () => {
    wrapper = await setup({
      resumes: [makeResume({ recommended: true }), makeResume({ id: 'resume-2', recommended: false })],
      selectedId: null
    })
    expect(wrapper.find('[data-testid="recommended-mark"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="recommended-mark"]')).toHaveLength(1)
  })

  it('点击条目上抛 select(resumeId)', async () => {
    wrapper = await setup({ resumes: [makeResume()], selectedId: null })
    await wrapper.find('[data-testid="result-item-resume-1"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['resume-1'])
  })
})
```

- [ ] 创建 `test/renderer/pages/resumeScreening/ResumeDetailPanel.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(resume: ResumeScreeningResumeDto | null) {
  const { default: ResumeDetailPanel } = await import(
    '@/pages/resumeScreening/components/ResumeDetailPanel.vue'
  )
  const wrapper = mount(ResumeDetailPanel, {
    props: { resume },
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
  return wrapper
}

function makeResume(overrides: Partial<ResumeScreeningResumeDto> = {}): ResumeScreeningResumeDto {
  return {
    id: 'resume-1',
    taskId: 'task-1',
    fileName: '张三.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    candidateName: '张三',
    rawText: '张三的简历原文',
    resumeInfo: { 学历: '本科', 技能: ['Vue', 'TypeScript'] },
    screening: { score: 88, recommended: true, conclusion: '匹配度高', strengths: ['技术扎实'] },
    interview: { highlights: ['沟通顺畅'], risks: ['经验较浅'], questions: ['项目细节'] },
    hr: { finalSummary: '整体优秀', hrOpinion: '建议推进' },
    score: 88,
    recommended: true,
    status: 'done',
    error: null,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('ResumeDetailPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('resume 为 null 时显示空态', async () => {
    wrapper = await setup(null)
    expect(wrapper.find('[data-testid="detail-empty"]').exists()).toBe(true)
  })

  it('处理失败时显示错误信息', async () => {
    wrapper = await setup(makeResume({ status: 'failed', error: 'PDF 解析失败' }))
    expect(wrapper.find('[data-testid="detail-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-error"]').text()).toContain('PDF 解析失败')
  })

  it('展示初筛评估节（结论 + 优势 + 分数）', async () => {
    wrapper = await setup(makeResume())
    const section = wrapper.find('[data-testid="screening-section"]')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('匹配度高')
    expect(section.text()).toContain('技术扎实')
    expect(wrapper.text()).toContain('88')
  })

  it('展示 resumeInfo 键值对与 rawText', async () => {
    wrapper = await setup(makeResume())
    const info = wrapper.find('[data-testid="detail-info"]')
    expect(info.exists()).toBe(true)
    expect(info.text()).toContain('学历')
    expect(info.text()).toContain('本科')
    expect(info.text()).toContain('Vue、TypeScript')
    expect(wrapper.find('[data-testid="detail-rawtext"]').text()).toContain('张三的简历原文')
  })

  it('rawText 为 null 时不渲染原文节', async () => {
    wrapper = await setup(makeResume({ rawText: null }))
    expect(wrapper.find('[data-testid="detail-rawtext"]').exists()).toBe(false)
  })
})
```

- [ ] 跑测试确认失败：`pnpm vitest run test/renderer/pages/resumeScreening`
  （statusPresentation/组件尚不存在）

- [ ] 创建 `src/renderer/src/pages/resumeScreening/components/statusPresentation.ts`：

```ts
// 任务/简历状态 → 文案键与徽标 variant 的统一映射，
// 供 TaskHistoryList / TaskProgressHeader / ResumeListPanel 复用
export function statusLabel(t: (key: string) => string, status: string): string {
  return t(`resumeScreening.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)
}

export function statusVariant(
  status: string
): 'active' | 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'running':
      return 'active'
    case 'completed':
    case 'done':
      return 'success'
    case 'partial':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
}
```

- [ ] 创建 `src/renderer/src/pages/resumeScreening/components/TaskHistoryList.vue`：

```vue
<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <h3 class="mb-2 shrink-0 text-sm font-medium">
      {{ t('resumeScreening.historySection') }}
    </h3>
    <p
      v-if="tasksLoaded && tasks.length === 0"
      data-testid="history-empty"
      class="py-4 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.historyEmpty') }}
    </p>
    <ul v-else class="min-h-0 flex-1 space-y-1 overflow-y-auto">
      <li
        v-for="task in tasks"
        :key="task.id"
        :data-testid="`history-item-${task.id}`"
        :class="[
          'cursor-pointer rounded-md border p-2 transition-colors hover:bg-muted/50',
          task.id === selectedId ? 'bg-muted' : ''
        ]"
        @click="emit('select', task.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <DcBadge :variant="statusVariant(task.status)">
            {{ statusLabel(t, task.status) }}
          </DcBadge>
          <span class="text-xs text-muted-foreground">
            {{ task.succeeded + task.failed }}/{{ task.total }}
          </span>
        </div>
        <p class="mt-1 truncate text-xs text-muted-foreground">
          {{ new Date(task.createdAt).toLocaleString() }}
        </p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

defineProps<{
  tasks: ResumeScreeningTaskDto[]
  tasksLoaded: boolean
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [taskId: string]
}>()

const { t } = useI18n()
</script>
```

- [ ] 创建 `src/renderer/src/pages/resumeScreening/components/TaskProgressHeader.vue`
  （纯展示组件，无交互，不写测试）：

```vue
<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center gap-2">
      <DcBadge :variant="statusVariant(task.status)">
        {{ statusLabel(t, task.status) }}
      </DcBadge>
      <span class="min-w-0 truncate text-xs text-muted-foreground">
        {{ task.providerId }} / {{ task.modelId }}
      </span>
    </div>

    <div class="mt-3 grid grid-cols-5 gap-2 text-center text-sm">
      <div data-testid="progress-total">
        <p class="text-lg font-semibold">{{ task.total }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressTotal') }}</p>
      </div>
      <div data-testid="progress-succeeded">
        <p class="text-lg font-semibold">{{ task.succeeded }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressSucceeded') }}</p>
      </div>
      <div data-testid="progress-failed">
        <p class="text-lg font-semibold">{{ task.failed }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressFailed') }}</p>
      </div>
      <div data-testid="progress-avg-score">
        <p class="text-lg font-semibold">{{ task.avgScore ?? '—' }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressAvgScore') }}</p>
      </div>
      <div data-testid="progress-recommended">
        <p class="text-lg font-semibold">{{ task.recommendedCount }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressRecommended') }}</p>
      </div>
    </div>

    <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        class="h-full rounded-full bg-primary transition-all"
        :style="{ width: `${progressPercent}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

const props = defineProps<{
  task: ResumeScreeningTaskDto
}>()

const { t } = useI18n()

// 已处理（成功+失败）/总数，total=0 时显示 0% 避免除零
const progressPercent = computed(() => {
  if (props.task.total === 0) return 0
  return Math.round(((props.task.succeeded + props.task.failed) / props.task.total) * 100)
})
</script>
```

- [ ] 创建 `src/renderer/src/pages/resumeScreening/components/ResumeListPanel.vue`：

```vue
<template>
  <section class="flex min-h-0 flex-col">
    <h3 class="mb-2 shrink-0 text-sm font-medium">
      {{ t('resumeScreening.resumeListSection') }}
    </h3>
    <p
      v-if="resumes.length === 0"
      data-testid="resume-list-empty"
      class="py-4 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.resumeListEmpty') }}
    </p>
    <ul v-else class="space-y-1 overflow-y-auto">
      <li
        v-for="resume in resumes"
        :key="resume.id"
        :data-testid="`result-item-${resume.id}`"
        :class="[
          'flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/50',
          resume.id === selectedId ? 'bg-muted' : ''
        ]"
        @click="emit('select', resume.id)"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ resume.candidateName ?? resume.fileName }}</span>
        <span
          v-if="resume.recommended"
          data-testid="recommended-mark"
          class="shrink-0 text-emerald-600"
        >
          <Icon icon="lucide:thumbs-up" class="size-4" />
        </span>
        <span v-if="resume.score !== null" class="shrink-0 text-xs font-medium">
          {{ resume.score }}
        </span>
        <DcBadge :variant="statusVariant(resume.status)">
          {{ statusLabel(t, resume.status) }}
        </DcBadge>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

defineProps<{
  resumes: ResumeScreeningResumeDto[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [resumeId: string]
}>()

const { t } = useI18n()
</script>
```

- [ ] 创建 `src/renderer/src/pages/resumeScreening/components/ResumeDetailPanel.vue`：

```vue
<template>
  <div class="flex min-h-0 flex-col gap-3 overflow-y-auto">
    <p
      v-if="!resume"
      data-testid="detail-empty"
      class="py-8 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.detailEmpty') }}
    </p>
    <template v-else>
      <div
        v-if="resume.error"
        data-testid="detail-error"
        class="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ resume.error }}
      </div>

      <div class="rounded-lg border p-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="min-w-0 truncate text-base font-semibold">
            {{ resume.candidateName ?? resume.fileName }}
          </h3>
          <div class="flex shrink-0 items-center gap-2">
            <span v-if="resume.score !== null" class="text-sm font-medium">
              {{ t('resumeScreening.detailScore', { score: resume.score }) }}
            </span>
            <DcBadge :variant="resume.recommended ? 'success' : 'neutral'">
              {{
                resume.recommended
                  ? t('resumeScreening.detailRecommended')
                  : t('resumeScreening.detailNotRecommended')
              }}
            </DcBadge>
          </div>
        </div>

        <div
          v-if="infoEntries.length > 0"
          data-testid="detail-info"
          class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
        >
          <template v-for="[key, value] in infoEntries" :key="key">
            <span class="text-muted-foreground">{{ key }}</span>
            <span class="min-w-0 break-words">{{ value }}</span>
          </template>
        </div>
      </div>

      <div v-if="resume.screening" data-testid="screening-section" class="rounded-lg border p-4">
        <div class="flex items-center justify-between">
          <h4 class="text-sm font-medium">{{ t('resumeScreening.screeningSection') }}</h4>
          <span class="text-lg font-semibold">{{ resume.screening.score }}</span>
        </div>
        <p class="mt-2 text-sm">{{ resume.screening.conclusion }}</p>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li v-for="strength in resume.screening.strengths" :key="strength">{{ strength }}</li>
        </ul>
      </div>

      <div v-if="resume.interview" data-testid="interview-section" class="rounded-lg border p-4">
        <h4 class="text-sm font-medium">{{ t('resumeScreening.interviewSection') }}</h4>
        <div class="mt-2 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <p class="font-medium">{{ t('resumeScreening.interviewHighlights') }}</p>
            <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li v-for="item in resume.interview.highlights" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div>
            <p class="font-medium">{{ t('resumeScreening.interviewRisks') }}</p>
            <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li v-for="item in resume.interview.risks" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div>
            <p class="font-medium">{{ t('resumeScreening.interviewQuestions') }}</p>
            <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li v-for="item in resume.interview.questions" :key="item">{{ item }}</li>
            </ul>
          </div>
        </div>
      </div>

      <div v-if="resume.hr" data-testid="hr-section" class="rounded-lg border p-4">
        <h4 class="text-sm font-medium">{{ t('resumeScreening.hrSection') }}</h4>
        <p class="mt-2 text-xs text-muted-foreground">{{ t('resumeScreening.hrFinalSummary') }}</p>
        <p class="mt-1 text-sm">{{ resume.hr.finalSummary }}</p>
        <p class="mt-3 text-xs text-muted-foreground">{{ t('resumeScreening.hrOpinion') }}</p>
        <p class="mt-1 text-sm">{{ resume.hr.hrOpinion }}</p>
      </div>

      <div v-if="resume.rawText" class="rounded-lg border p-4">
        <h4 class="mb-2 text-sm font-medium">{{ t('resumeScreening.rawTextSection') }}</h4>
        <!-- pre 内容顶格写，避免模板缩进被 whitespace-pre 保留 -->
        <pre
          data-testid="detail-rawtext"
          class="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs"
        >{{ resume.rawText }}</pre>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const props = defineProps<{
  resume: ResumeScreeningResumeDto | null
}>()

const { t } = useI18n()

// resumeInfo 是宽松契约字段（z.unknown()，见 Task 1），按键值对渲染；值格式化：
// 数组顿号 join、对象 JSON.stringify、null/undefined 显示 —
const infoEntries = computed(() => {
  if (!props.resume?.resumeInfo || typeof props.resume.resumeInfo !== 'object') return []
  return Object.entries(props.resume.resumeInfo as Record<string, unknown>).map(([key, value]) => [
    key,
    formatInfoValue(value)
  ])
})

function formatInfoValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
</script>
```

- [ ] 修改 `src/renderer/src/pages/resumeScreening/ResumeScreeningPage.vue`：用以下内容
  整体替换 Task 14 装配的版本。变化点：左栏 ReviewButton 之后追加 TaskHistoryList；
  右栏替换为「无任务空态 / 任务详情」双分支；script 增加事件订阅与清理（Task 11 的
  `resumeScreeningApi.onTaskUpdated/onResumeUpdated` 返回 `() => void`，onMounted 内
  订阅并追加 `store.loadTasks()`，onUnmounted 清理）：

```vue
<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">{{ t('resumeScreening.title') }}</h1>
      <UserProfileBadge
        v-if="store.profile"
        :name="store.profile.name"
        :email="store.profile.email"
      />
    </header>

    <div
      class="grid min-h-0 flex-1 grid-cols-[380px_1fr] divide-x"
      data-testid="resume-screening-workspace"
    >
      <aside
        class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        data-testid="resume-screening-create-panel"
      >
        <JdInputCard
          :jd-source="store.draft.jdSource"
          :jd-text="store.draft.jdText"
          :jd-file-path="store.draft.jdFilePath"
          :jd-file-name="store.draft.jdFileName"
          @update:jd-source="(value) => (store.draft.jdSource = value)"
          @update:jd-text="(value) => (store.draft.jdText = value)"
          @pick-file="onPickJdFile"
          @clear-file="clearJdFile"
        />
        <ResumeUploadCard
          :resumes="store.draft.resumes"
          @pick-files="onPickResumeFiles"
          @remove="removeResume"
        />
        <ScreeningConfigCard
          :config="store.draft.config"
          @update:config="(config) => (store.draft.config = config)"
        />
        <ModelSelector
          v-if="store.models.length > 0"
          :models="store.models"
          :model-key="store.selectedModelKey"
          @update:model-key="onSelectModel"
        />
        <p v-if="store.createError" class="text-sm text-destructive" data-testid="create-error">
          {{ store.createError }}
        </p>
        <ReviewButton
          :can-review="store.canReview"
          :is-running="store.isTaskActive"
          :is-creating="store.isCreating"
          @review="onReview"
          @cancel="store.cancelTask()"
        />
        <TaskHistoryList
          :tasks="store.tasks"
          :tasks-loaded="store.tasksLoaded"
          :selected-id="store.currentTaskId"
          @select="onSelectTask"
        />
      </aside>

      <section class="min-h-0 overflow-y-auto p-6" data-testid="resume-screening-detail-panel">
        <div
          v-if="!store.currentTask"
          class="flex h-full items-center justify-center"
          data-testid="detail-panel-empty"
        >
          <p class="text-sm text-muted-foreground">{{ t('resumeScreening.detailPanelEmpty') }}</p>
        </div>
        <div v-else class="flex flex-col gap-4">
          <TaskProgressHeader :task="store.currentTask" />
          <div class="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-4">
            <ResumeListPanel
              :resumes="store.currentResumes"
              :selected-id="store.selectedResumeId"
              @select="store.selectedResumeId = $event"
            />
            <ResumeDetailPanel :resume="store.selectedResume" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { createDeviceClient } from '@api/DeviceClient'
import { resumeScreeningApi } from '@api/resumeScreeningTasks'
import { RESUME_LIMIT, useResumeScreeningStore } from '@/stores/resumeScreening'
import JdInputCard from './components/JdInputCard.vue'
import ResumeUploadCard from './components/ResumeUploadCard.vue'
import ScreeningConfigCard from './components/ScreeningConfigCard.vue'
import ReviewButton from './components/ReviewButton.vue'
import UserProfileBadge from './components/UserProfileBadge.vue'
import ModelSelector from './components/ModelSelector.vue'
import TaskHistoryList from './components/TaskHistoryList.vue'
import TaskProgressHeader from './components/TaskProgressHeader.vue'
import ResumeListPanel from './components/ResumeListPanel.vue'
import ResumeDetailPanel from './components/ResumeDetailPanel.vue'

const { t } = useI18n()
const deviceClient = createDeviceClient()
const store = useResumeScreeningStore()

// 与 Task 1 契约的扩展名白名单一致
const FILE_FILTERS = [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }]

// 订阅取消函数，onUnmounted 清理
let offTaskUpdated: (() => void) | null = null
let offResumeUpdated: (() => void) | null = null

onMounted(() => {
  void store.loadProfile()
  void store.loadModels()
  void store.loadTasks()
  offTaskUpdated = resumeScreeningApi.onTaskUpdated(store.handleTaskUpdated)
  offResumeUpdated = resumeScreeningApi.onResumeUpdated(store.handleResumeUpdated)
})

onUnmounted(() => {
  offTaskUpdated?.()
  offResumeUpdated?.()
  offTaskUpdated = null
  offResumeUpdated = null
})

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

async function onPickJdFile() {
  const result = await deviceClient.selectFiles({ multiple: false, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const filePath = result.filePaths[0]
  store.draft.jdFilePath = filePath
  store.draft.jdFileName = basename(filePath)
}

function clearJdFile() {
  store.draft.jdFilePath = null
  store.draft.jdFileName = null
}

async function onPickResumeFiles() {
  const result = await deviceClient.selectFiles({ multiple: true, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const existing = new Set(store.draft.resumes.map((item) => item.path))
  for (const filePath of result.filePaths) {
    if (store.draft.resumes.length >= RESUME_LIMIT || existing.has(filePath)) continue
    existing.add(filePath)
    store.draft.resumes.push({ path: filePath, name: basename(filePath) })
  }
}

function removeResume(path: string) {
  const index = store.draft.resumes.findIndex((item) => item.path === path)
  if (index >= 0) store.draft.resumes.splice(index, 1)
}

function onSelectModel(key: string) {
  const [providerId, modelId] = key.split('::')
  if (providerId && modelId) store.selectModel(providerId, modelId)
}

function onSelectTask(taskId: string) {
  void store.loadTask(taskId)
}

function onReview() {
  void store.createTask()
}
</script>
```

- [ ] 跑测试与 typecheck（组件与页面装配完成，3 个组件测试应通过）：

```sh
pnpm vitest run test/renderer/pages/resumeScreening
pnpm typecheck
```

- [ ] 为 20 个 locale 的 `src/renderer/src/i18n/{locale}/resumeScreening.json` 追加详情
  文案键（在 Task 14 的 `modelLabel` 之后追加；zh-CN 为源，其余 locale 键集必须与
  zh-CN 一致，注意 JSON 逗号）：

  zh-CN 追加：

```json
{
  "historySection": "任务历史",
  "historyEmpty": "暂无历史任务",
  "statusQueued": "排队中",
  "statusRunning": "处理中",
  "statusCompleted": "已完成",
  "statusPartial": "部分完成",
  "statusFailed": "失败",
  "statusCancelled": "已取消",
  "statusPending": "待处理",
  "statusDone": "已完成",
  "progressTotal": "总数",
  "progressSucceeded": "成功",
  "progressFailed": "失败",
  "progressAvgScore": "平均分",
  "progressRecommended": "推荐",
  "resumeListSection": "简历结果",
  "resumeListEmpty": "该任务暂无简历",
  "detailPanelEmpty": "选择左侧任务查看详情",
  "detailEmpty": "选择一份简历查看详情",
  "detailScore": "得分 {score}",
  "detailRecommended": "推荐",
  "detailNotRecommended": "不推荐",
  "screeningSection": "初筛评估",
  "interviewSection": "面试考察",
  "interviewHighlights": "亮点",
  "interviewRisks": "风险",
  "interviewQuestions": "考察问题",
  "hrSection": "HR 汇总",
  "hrFinalSummary": "最终总结",
  "hrOpinion": "HR 意见",
  "rawTextSection": "简历原文"
}
```

  en-US 追加：

```json
{
  "historySection": "Task History",
  "historyEmpty": "No tasks yet",
  "statusQueued": "Queued",
  "statusRunning": "Processing",
  "statusCompleted": "Completed",
  "statusPartial": "Partially Completed",
  "statusFailed": "Failed",
  "statusCancelled": "Cancelled",
  "statusPending": "Pending",
  "statusDone": "Completed",
  "progressTotal": "Total",
  "progressSucceeded": "Succeeded",
  "progressFailed": "Failed",
  "progressAvgScore": "Avg Score",
  "progressRecommended": "Recommended",
  "resumeListSection": "Resume Results",
  "resumeListEmpty": "No resumes in this task",
  "detailPanelEmpty": "Select a task on the left to view details",
  "detailEmpty": "Select a resume to view details",
  "detailScore": "Score {score}",
  "detailRecommended": "Recommended",
  "detailNotRecommended": "Not Recommended",
  "screeningSection": "Screening Assessment",
  "interviewSection": "Interview Focus",
  "interviewHighlights": "Highlights",
  "interviewRisks": "Risks",
  "interviewQuestions": "Questions",
  "hrSection": "HR Summary",
  "hrFinalSummary": "Final Summary",
  "hrOpinion": "HR Opinion",
  "rawTextSection": "Resume Raw Text"
}
```

  ja-JP 追加：

```json
{
  "historySection": "タスク履歴",
  "historyEmpty": "履歴はありません",
  "statusQueued": "待機中",
  "statusRunning": "処理中",
  "statusCompleted": "完了",
  "statusPartial": "部分完了",
  "statusFailed": "失敗",
  "statusCancelled": "キャンセル済み",
  "statusPending": "保留中",
  "statusDone": "完了",
  "progressTotal": "合計",
  "progressSucceeded": "成功",
  "progressFailed": "失敗",
  "progressAvgScore": "平均スコア",
  "progressRecommended": "推奨",
  "resumeListSection": "履歴書結果",
  "resumeListEmpty": "このタスクには履歴書がありません",
  "detailPanelEmpty": "左側のタスクを選択して詳細を表示",
  "detailEmpty": "履歴書を選択して詳細を表示",
  "detailScore": "スコア {score}",
  "detailRecommended": "推奨",
  "detailNotRecommended": "非推奨",
  "screeningSection": "スクリーニング評価",
  "interviewSection": "面接ポイント",
  "interviewHighlights": "ハイライト",
  "interviewRisks": "リスク",
  "interviewQuestions": "質問事項",
  "hrSection": "HR まとめ",
  "hrFinalSummary": "最終まとめ",
  "hrOpinion": "HR 意見",
  "rawTextSection": "履歴書原文"
}
```

  ko-KR 追加：

```json
{
  "historySection": "작업 기록",
  "historyEmpty": "기록이 없습니다",
  "statusQueued": "대기 중",
  "statusRunning": "처리 중",
  "statusCompleted": "완료",
  "statusPartial": "부분 완료",
  "statusFailed": "실패",
  "statusCancelled": "취소됨",
  "statusPending": "보류 중",
  "statusDone": "완료",
  "progressTotal": "전체",
  "progressSucceeded": "성공",
  "progressFailed": "실패",
  "progressAvgScore": "평균 점수",
  "progressRecommended": "추천",
  "resumeListSection": "이력서 결과",
  "resumeListEmpty": "이 작업에는 이력서가 없습니다",
  "detailPanelEmpty": "왼쪽에서 작업을 선택하여 상세 보기",
  "detailEmpty": "이력서를 선택하여 상세 보기",
  "detailScore": "점수 {score}",
  "detailRecommended": "추천",
  "detailNotRecommended": "비추천",
  "screeningSection": "스크리닝 평가",
  "interviewSection": "면접 포인트",
  "interviewHighlights": "강점",
  "interviewRisks": "리스크",
  "interviewQuestions": "질문",
  "hrSection": "HR 요약",
  "hrFinalSummary": "최종 요약",
  "hrOpinion": "HR 의견",
  "rawTextSection": "이력서 원문"
}
```

  zh-TW 追加：

```json
{
  "historySection": "任務歷史",
  "historyEmpty": "暫無歷史任務",
  "statusQueued": "排隊中",
  "statusRunning": "處理中",
  "statusCompleted": "已完成",
  "statusPartial": "部分完成",
  "statusFailed": "失敗",
  "statusCancelled": "已取消",
  "statusPending": "待處理",
  "statusDone": "已完成",
  "progressTotal": "總數",
  "progressSucceeded": "成功",
  "progressFailed": "失敗",
  "progressAvgScore": "平均分",
  "progressRecommended": "推薦",
  "resumeListSection": "履歷結果",
  "resumeListEmpty": "該任務暫無履歷",
  "detailPanelEmpty": "選擇左側任務查看詳情",
  "detailEmpty": "選擇一份履歷查看詳情",
  "detailScore": "得分 {score}",
  "detailRecommended": "推薦",
  "detailNotRecommended": "不推薦",
  "screeningSection": "初篩評估",
  "interviewSection": "面試考察",
  "interviewHighlights": "亮點",
  "interviewRisks": "風險",
  "interviewQuestions": "考察問題",
  "hrSection": "HR 彙總",
  "hrFinalSummary": "最終總結",
  "hrOpinion": "HR 意見",
  "rawTextSection": "履歷原文"
}
```

  zh-HK 追加：

```json
{
  "historySection": "任務歷史",
  "historyEmpty": "暫無歷史任務",
  "statusQueued": "排隊中",
  "statusRunning": "處理中",
  "statusCompleted": "已完成",
  "statusPartial": "部分完成",
  "statusFailed": "失敗",
  "statusCancelled": "已取消",
  "statusPending": "待處理",
  "statusDone": "已完成",
  "progressTotal": "總數",
  "progressSucceeded": "成功",
  "progressFailed": "失敗",
  "progressAvgScore": "平均分",
  "progressRecommended": "推薦",
  "resumeListSection": "履歷結果",
  "resumeListEmpty": "該任務暫無履歷",
  "detailPanelEmpty": "選擇左側任務查看詳情",
  "detailEmpty": "選擇一份履歷查看詳情",
  "detailScore": "得分 {score}",
  "detailRecommended": "推薦",
  "detailNotRecommended": "不推薦",
  "screeningSection": "初篩評估",
  "interviewSection": "面試考察",
  "interviewHighlights": "亮點",
  "interviewRisks": "風險",
  "interviewQuestions": "考察問題",
  "hrSection": "HR 匯總",
  "hrFinalSummary": "最終總結",
  "hrOpinion": "HR 意見",
  "rawTextSection": "履歷原文"
}
```

  vi-VN 追加：

```json
{
  "historySection": "Lịch sử tác vụ",
  "historyEmpty": "Chưa có tác vụ nào",
  "statusQueued": "Đang chờ",
  "statusRunning": "Đang xử lý",
  "statusCompleted": "Hoàn tất",
  "statusPartial": "Hoàn tất một phần",
  "statusFailed": "Thất bại",
  "statusCancelled": "Đã hủy",
  "statusPending": "Đang chờ xử lý",
  "statusDone": "Hoàn tất",
  "progressTotal": "Tổng số",
  "progressSucceeded": "Thành công",
  "progressFailed": "Thất bại",
  "progressAvgScore": "Điểm trung bình",
  "progressRecommended": "Đề xuất",
  "resumeListSection": "Kết quả CV",
  "resumeListEmpty": "Tác vụ này chưa có CV",
  "detailPanelEmpty": "Chọn tác vụ bên trái để xem chi tiết",
  "detailEmpty": "Chọn một CV để xem chi tiết",
  "detailScore": "Điểm {score}",
  "detailRecommended": "Đề xuất",
  "detailNotRecommended": "Không đề xuất",
  "screeningSection": "Đánh giá sàng lọc",
  "interviewSection": "Điểm phỏng vấn",
  "interviewHighlights": "Điểm nổi bật",
  "interviewRisks": "Rủi ro",
  "interviewQuestions": "Câu hỏi",
  "hrSection": "Tổng kết HR",
  "hrFinalSummary": "Tổng kết cuối cùng",
  "hrOpinion": "Ý kiến HR",
  "rawTextSection": "Văn bản gốc CV"
}
```

  tr-TR 追加：

```json
{
  "historySection": "Görev Geçmişi",
  "historyEmpty": "Henüz görev yok",
  "statusQueued": "Sırada",
  "statusRunning": "İşleniyor",
  "statusCompleted": "Tamamlandı",
  "statusPartial": "Kısmen Tamamlandı",
  "statusFailed": "Başarısız",
  "statusCancelled": "İptal Edildi",
  "statusPending": "Beklemede",
  "statusDone": "Tamamlandı",
  "progressTotal": "Toplam",
  "progressSucceeded": "Başarılı",
  "progressFailed": "Başarısız",
  "progressAvgScore": "Ortalama Puan",
  "progressRecommended": "Önerilen",
  "resumeListSection": "Özgeçmiş Sonuçları",
  "resumeListEmpty": "Bu görevde özgeçmiş yok",
  "detailPanelEmpty": "Detayları görmek için soldan bir görev seçin",
  "detailEmpty": "Detayları görmek için bir özgeçmiş seçin",
  "detailScore": "Puan {score}",
  "detailRecommended": "Önerilen",
  "detailNotRecommended": "Önerilmeyen",
  "screeningSection": "Eleme Değerlendirmesi",
  "interviewSection": "Mülakat Odağı",
  "interviewHighlights": "Öne Çıkanlar",
  "interviewRisks": "Riskler",
  "interviewQuestions": "Sorular",
  "hrSection": "İK Özeti",
  "hrFinalSummary": "Son Özet",
  "hrOpinion": "İK Görüşü",
  "rawTextSection": "Özgeçmiş Ham Metni"
}
```

  ru-RU 追加：

```json
{
  "historySection": "История задач",
  "historyEmpty": "Задач пока нет",
  "statusQueued": "В очереди",
  "statusRunning": "Обработка",
  "statusCompleted": "Завершено",
  "statusPartial": "Частично завершено",
  "statusFailed": "Ошибка",
  "statusCancelled": "Отменено",
  "statusPending": "Ожидает",
  "statusDone": "Завершено",
  "progressTotal": "Всего",
  "progressSucceeded": "Успешно",
  "progressFailed": "С ошибкой",
  "progressAvgScore": "Средний балл",
  "progressRecommended": "Рекомендовано",
  "resumeListSection": "Результаты резюме",
  "resumeListEmpty": "В этой задаче нет резюме",
  "detailPanelEmpty": "Выберите задачу слева для просмотра",
  "detailEmpty": "Выберите резюме для просмотра",
  "detailScore": "Балл {score}",
  "detailRecommended": "Рекомендовано",
  "detailNotRecommended": "Не рекомендовано",
  "screeningSection": "Оценка скрининга",
  "interviewSection": "Фокус интервью",
  "interviewHighlights": "Сильные стороны",
  "interviewRisks": "Риски",
  "interviewQuestions": "Вопросы",
  "hrSection": "Итог HR",
  "hrFinalSummary": "Итоговое резюме",
  "hrOpinion": "Мнение HR",
  "rawTextSection": "Исходный текст резюме"
}
```

  pt-BR 追加：

```json
{
  "historySection": "Histórico de Tarefas",
  "historyEmpty": "Nenhuma tarefa ainda",
  "statusQueued": "Na fila",
  "statusRunning": "Processando",
  "statusCompleted": "Concluída",
  "statusPartial": "Parcialmente Concluída",
  "statusFailed": "Falhou",
  "statusCancelled": "Cancelada",
  "statusPending": "Pendente",
  "statusDone": "Concluída",
  "progressTotal": "Total",
  "progressSucceeded": "Sucessos",
  "progressFailed": "Falhas",
  "progressAvgScore": "Pontuação Média",
  "progressRecommended": "Recomendados",
  "resumeListSection": "Resultados dos Currículos",
  "resumeListEmpty": "Nenhum currículo nesta tarefa",
  "detailPanelEmpty": "Selecione uma tarefa à esquerda para ver os detalhes",
  "detailEmpty": "Selecione um currículo para ver os detalhes",
  "detailScore": "Pontuação {score}",
  "detailRecommended": "Recomendado",
  "detailNotRecommended": "Não Recomendado",
  "screeningSection": "Avaliação de Triagem",
  "interviewSection": "Foco da Entrevista",
  "interviewHighlights": "Destaques",
  "interviewRisks": "Riscos",
  "interviewQuestions": "Perguntas",
  "hrSection": "Resumo do RH",
  "hrFinalSummary": "Resumo Final",
  "hrOpinion": "Opinião do RH",
  "rawTextSection": "Texto Original do Currículo"
}
```

  pl-PL 追加：

```json
{
  "historySection": "Historia zadań",
  "historyEmpty": "Brak zadań",
  "statusQueued": "W kolejce",
  "statusRunning": "Przetwarzanie",
  "statusCompleted": "Ukończono",
  "statusPartial": "Częściowo ukończono",
  "statusFailed": "Niepowodzenie",
  "statusCancelled": "Anulowano",
  "statusPending": "Oczekuje",
  "statusDone": "Ukończono",
  "progressTotal": "Łącznie",
  "progressSucceeded": "Sukcesy",
  "progressFailed": "Błędy",
  "progressAvgScore": "Średni wynik",
  "progressRecommended": "Polecane",
  "resumeListSection": "Wyniki CV",
  "resumeListEmpty": "To zadanie nie ma CV",
  "detailPanelEmpty": "Wybierz zadanie po lewej, aby zobaczyć szczegóły",
  "detailEmpty": "Wybierz CV, aby zobaczyć szczegóły",
  "detailScore": "Wynik {score}",
  "detailRecommended": "Polecane",
  "detailNotRecommended": "Niepolecane",
  "screeningSection": "Ocena wstępna",
  "interviewSection": "Zakres rozmowy",
  "interviewHighlights": "Mocne strony",
  "interviewRisks": "Ryzyka",
  "interviewQuestions": "Pytania",
  "hrSection": "Podsumowanie HR",
  "hrFinalSummary": "Podsumowanie końcowe",
  "hrOpinion": "Opinia HR",
  "rawTextSection": "Oryginalny tekst CV"
}
```

  ms-MY 追加：

```json
{
  "historySection": "Sejarah Tugasan",
  "historyEmpty": "Tiada tugasan lagi",
  "statusQueued": "Dalam baris gilir",
  "statusRunning": "Sedang diproses",
  "statusCompleted": "Selesai",
  "statusPartial": "Selesai Sebahagian",
  "statusFailed": "Gagal",
  "statusCancelled": "Dibatalkan",
  "statusPending": "Menunggu",
  "statusDone": "Selesai",
  "progressTotal": "Jumlah",
  "progressSucceeded": "Berjaya",
  "progressFailed": "Gagal",
  "progressAvgScore": "Skor Purata",
  "progressRecommended": "Disyorkan",
  "resumeListSection": "Keputusan Resume",
  "resumeListEmpty": "Tugasan ini tiada resume",
  "detailPanelEmpty": "Pilih tugasan di kiri untuk lihat butiran",
  "detailEmpty": "Pilih resume untuk lihat butiran",
  "detailScore": "Skor {score}",
  "detailRecommended": "Disyorkan",
  "detailNotRecommended": "Tidak Disyorkan",
  "screeningSection": "Penilaian Saringan",
  "interviewSection": "Fokus Temuduga",
  "interviewHighlights": "Sorotan",
  "interviewRisks": "Risiko",
  "interviewQuestions": "Soalan",
  "hrSection": "Ringkasan HR",
  "hrFinalSummary": "Ringkasan Akhir",
  "hrOpinion": "Pandangan HR",
  "rawTextSection": "Teks Asal Resume"
}
```

  it-IT 追加：

```json
{
  "historySection": "Cronologia Attività",
  "historyEmpty": "Nessuna attività",
  "statusQueued": "In coda",
  "statusRunning": "In elaborazione",
  "statusCompleted": "Completata",
  "statusPartial": "Parzialmente Completata",
  "statusFailed": "Non riuscita",
  "statusCancelled": "Annullata",
  "statusPending": "In attesa",
  "statusDone": "Completata",
  "progressTotal": "Totale",
  "progressSucceeded": "Riuscite",
  "progressFailed": "Fallite",
  "progressAvgScore": "Punteggio Medio",
  "progressRecommended": "Consigliati",
  "resumeListSection": "Risultati CV",
  "resumeListEmpty": "Nessun CV in questa attività",
  "detailPanelEmpty": "Seleziona un'attività a sinistra per i dettagli",
  "detailEmpty": "Seleziona un CV per i dettagli",
  "detailScore": "Punteggio {score}",
  "detailRecommended": "Consigliato",
  "detailNotRecommended": "Non Consigliato",
  "screeningSection": "Valutazione Preselezione",
  "interviewSection": "Focus Colloquio",
  "interviewHighlights": "Punti di Forza",
  "interviewRisks": "Rischi",
  "interviewQuestions": "Domande",
  "hrSection": "Riepilogo HR",
  "hrFinalSummary": "Riepilogo Finale",
  "hrOpinion": "Parere HR",
  "rawTextSection": "Testo Originale del CV"
}
```

  id-ID 追加：

```json
{
  "historySection": "Riwayat Tugas",
  "historyEmpty": "Belum ada tugas",
  "statusQueued": "Dalam antrean",
  "statusRunning": "Sedang diproses",
  "statusCompleted": "Selesai",
  "statusPartial": "Selesai Sebagian",
  "statusFailed": "Gagal",
  "statusCancelled": "Dibatalkan",
  "statusPending": "Menunggu",
  "statusDone": "Selesai",
  "progressTotal": "Total",
  "progressSucceeded": "Berhasil",
  "progressFailed": "Gagal",
  "progressAvgScore": "Skor Rata-rata",
  "progressRecommended": "Direkomendasikan",
  "resumeListSection": "Hasil Resume",
  "resumeListEmpty": "Tugas ini belum ada resume",
  "detailPanelEmpty": "Pilih tugas di kiri untuk melihat detail",
  "detailEmpty": "Pilih satu resume untuk melihat detail",
  "detailScore": "Skor {score}",
  "detailRecommended": "Direkomendasikan",
  "detailNotRecommended": "Tidak Direkomendasikan",
  "screeningSection": "Penilaian Penyaringan",
  "interviewSection": "Fokus Wawancara",
  "interviewHighlights": "Sorotan",
  "interviewRisks": "Risiko",
  "interviewQuestions": "Pertanyaan",
  "hrSection": "Ringkasan HR",
  "hrFinalSummary": "Ringkasan Akhir",
  "hrOpinion": "Pendapat HR",
  "rawTextSection": "Teks Asli Resume"
}
```

  he-IL 追加：

```json
{
  "historySection": "היסטוריית משימות",
  "historyEmpty": "אין משימות עדיין",
  "statusQueued": "בתור",
  "statusRunning": "מעבד",
  "statusCompleted": "הושלם",
  "statusPartial": "הושלם חלקית",
  "statusFailed": "נכשל",
  "statusCancelled": "בוטל",
  "statusPending": "ממתין",
  "statusDone": "הושלם",
  "progressTotal": "סה\"כ",
  "progressSucceeded": "הצליחו",
  "progressFailed": "נכשלו",
  "progressAvgScore": "ציון ממוצע",
  "progressRecommended": "מומלצים",
  "resumeListSection": "תוצאות קורות חיים",
  "resumeListEmpty": "אין קורות חיים במשימה זו",
  "detailPanelEmpty": "בחרו משימה משמאל לצפייה בפרטים",
  "detailEmpty": "בחרו קורות חיים לצפייה בפרטים",
  "detailScore": "ציון {score}",
  "detailRecommended": "מומלץ",
  "detailNotRecommended": "לא מומלץ",
  "screeningSection": "הערכת סינון",
  "interviewSection": "מוקד ראיון",
  "interviewHighlights": "נקודות חוזק",
  "interviewRisks": "סיכונים",
  "interviewQuestions": "שאלות",
  "hrSection": "סיכום HR",
  "hrFinalSummary": "סיכום סופי",
  "hrOpinion": "חוות דעת HR",
  "rawTextSection": "טקסט מקורי של קורות החיים"
}
```

  fr-FR 追加：

```json
{
  "historySection": "Historique des tâches",
  "historyEmpty": "Aucune tâche pour le moment",
  "statusQueued": "En file d'attente",
  "statusRunning": "En cours",
  "statusCompleted": "Terminée",
  "statusPartial": "Partiellement terminée",
  "statusFailed": "Échec",
  "statusCancelled": "Annulée",
  "statusPending": "En attente",
  "statusDone": "Terminée",
  "progressTotal": "Total",
  "progressSucceeded": "Réussies",
  "progressFailed": "Échouées",
  "progressAvgScore": "Score moyen",
  "progressRecommended": "Recommandés",
  "resumeListSection": "Résultats des CV",
  "resumeListEmpty": "Aucun CV dans cette tâche",
  "detailPanelEmpty": "Sélectionnez une tâche à gauche pour voir les détails",
  "detailEmpty": "Sélectionnez un CV pour voir les détails",
  "detailScore": "Score {score}",
  "detailRecommended": "Recommandé",
  "detailNotRecommended": "Non recommandé",
  "screeningSection": "Évaluation de présélection",
  "interviewSection": "Axes d'entretien",
  "interviewHighlights": "Points forts",
  "interviewRisks": "Risques",
  "interviewQuestions": "Questions",
  "hrSection": "Synthèse RH",
  "hrFinalSummary": "Synthèse finale",
  "hrOpinion": "Avis RH",
  "rawTextSection": "Texte original du CV"
}
```

  fa-IR 追加：

```json
{
  "historySection": "تاریخچه وظایف",
  "historyEmpty": "هنوز وظیفه‌ای نیست",
  "statusQueued": "در صف",
  "statusRunning": "در حال پردازش",
  "statusCompleted": "تکمیل شده",
  "statusPartial": "تکمیل جزئی",
  "statusFailed": "ناموفق",
  "statusCancelled": "لغو شده",
  "statusPending": "در انتظار",
  "statusDone": "تکمیل شده",
  "progressTotal": "مجموع",
  "progressSucceeded": "موفق",
  "progressFailed": "ناموفق",
  "progressAvgScore": "میانگین امتیاز",
  "progressRecommended": "پیشنهاد شده",
  "resumeListSection": "نتایج رزومه",
  "resumeListEmpty": "این وظیفه رزومه‌ای ندارد",
  "detailPanelEmpty": "برای مشاهده جزئیات یک وظیفه را از چپ انتخاب کنید",
  "detailEmpty": "برای مشاهده جزئیات یک رزومه را انتخاب کنید",
  "detailScore": "امتیاز {score}",
  "detailRecommended": "پیشنهاد شده",
  "detailNotRecommended": "پیشنهاد نشده",
  "screeningSection": "ارزیابی غربالگری",
  "interviewSection": "محورهای مصاحبه",
  "interviewHighlights": "نقاط قوت",
  "interviewRisks": "ریسک‌ها",
  "interviewQuestions": "سؤالات",
  "hrSection": "جمع‌بندی HR",
  "hrFinalSummary": "جمع‌بندی نهایی",
  "hrOpinion": "نظر HR",
  "rawTextSection": "متن اصلی رزومه"
}
```

  es-ES 追加：

```json
{
  "historySection": "Historial de Tareas",
  "historyEmpty": "Aún no hay tareas",
  "statusQueued": "En cola",
  "statusRunning": "Procesando",
  "statusCompleted": "Completada",
  "statusPartial": "Parcialmente Completada",
  "statusFailed": "Fallida",
  "statusCancelled": "Cancelada",
  "statusPending": "Pendiente",
  "statusDone": "Completada",
  "progressTotal": "Total",
  "progressSucceeded": "Exitosas",
  "progressFailed": "Fallidas",
  "progressAvgScore": "Puntuación Media",
  "progressRecommended": "Recomendados",
  "resumeListSection": "Resultados de CV",
  "resumeListEmpty": "No hay CV en esta tarea",
  "detailPanelEmpty": "Selecciona una tarea a la izquierda para ver detalles",
  "detailEmpty": "Selecciona un CV para ver detalles",
  "detailScore": "Puntuación {score}",
  "detailRecommended": "Recomendado",
  "detailNotRecommended": "No Recomendado",
  "screeningSection": "Evaluación de Filtrado",
  "interviewSection": "Enfoque de Entrevista",
  "interviewHighlights": "Puntos Fuertes",
  "interviewRisks": "Riesgos",
  "interviewQuestions": "Preguntas",
  "hrSection": "Resumen de RR. HH.",
  "hrFinalSummary": "Resumen Final",
  "hrOpinion": "Opinión de RR. HH.",
  "rawTextSection": "Texto Original del CV"
}
```

  de-DE 追加：

```json
{
  "historySection": "Aufgabenverlauf",
  "historyEmpty": "Noch keine Aufgaben",
  "statusQueued": "In Warteschlange",
  "statusRunning": "Wird verarbeitet",
  "statusCompleted": "Abgeschlossen",
  "statusPartial": "Teilweise abgeschlossen",
  "statusFailed": "Fehlgeschlagen",
  "statusCancelled": "Abgebrochen",
  "statusPending": "Ausstehend",
  "statusDone": "Abgeschlossen",
  "progressTotal": "Gesamt",
  "progressSucceeded": "Erfolgreich",
  "progressFailed": "Fehlgeschlagen",
  "progressAvgScore": "Durchschnittspunktzahl",
  "progressRecommended": "Empfohlen",
  "resumeListSection": "Lebenslauf-Ergebnisse",
  "resumeListEmpty": "Keine Lebensläufe in dieser Aufgabe",
  "detailPanelEmpty": "Wähle links eine Aufgabe aus, um Details zu sehen",
  "detailEmpty": "Wähle einen Lebenslauf aus, um Details zu sehen",
  "detailScore": "Punktzahl {score}",
  "detailRecommended": "Empfohlen",
  "detailNotRecommended": "Nicht Empfohlen",
  "screeningSection": "Screening-Bewertung",
  "interviewSection": "Interview-Schwerpunkte",
  "interviewHighlights": "Stärken",
  "interviewRisks": "Risiken",
  "interviewQuestions": "Fragen",
  "hrSection": "HR-Zusammenfassung",
  "hrFinalSummary": "Abschließende Zusammenfassung",
  "hrOpinion": "HR-Einschätzung",
  "rawTextSection": "Lebenslauf-Originaltext"
}
```

  da-DK 追加：

```json
{
  "historySection": "Opgavehistorik",
  "historyEmpty": "Ingen opgaver endnu",
  "statusQueued": "I kø",
  "statusRunning": "Behandler",
  "statusCompleted": "Fuldført",
  "statusPartial": "Delvist fuldført",
  "statusFailed": "Fejlede",
  "statusCancelled": "Annulleret",
  "statusPending": "Afventer",
  "statusDone": "Fuldført",
  "progressTotal": "I alt",
  "progressSucceeded": "Lykkedes",
  "progressFailed": "Fejlede",
  "progressAvgScore": "Gennemsnitsscore",
  "progressRecommended": "Anbefalede",
  "resumeListSection": "CV-resultater",
  "resumeListEmpty": "Ingen CV'er i denne opgave",
  "detailPanelEmpty": "Vælg en opgave til venstre for at se detaljer",
  "detailEmpty": "Vælg et CV for at se detaljer",
  "detailScore": "Score {score}",
  "detailRecommended": "Anbefalet",
  "detailNotRecommended": "Ikke anbefalet",
  "screeningSection": "Screeningvurdering",
  "interviewSection": "Interviewfokus",
  "interviewHighlights": "Højdepunkter",
  "interviewRisks": "Risici",
  "interviewQuestions": "Spørgsmål",
  "hrSection": "HR-opsamling",
  "hrFinalSummary": "Endelig opsamling",
  "hrOpinion": "HR-udtalelse",
  "rawTextSection": "CV-tekst"
}
```

- [ ] 再生成 i18n 类型并验证（新增键后必须再生成，否则 typecheck 失败）：

```sh
pnpm i18n:types
pnpm typecheck
pnpm i18n
```

- [ ] Commit：`feat(resume-screening): add task detail components`

## Task 16: 侧边栏入口（WindowSideBar）

**Files:**

- 修改：`src/renderer/src/components/WindowSideBar.vue`

**背景知识**：

- 侧边栏功能菜单为硬编码按钮列表（非 router meta 驱动）；既有先例是 documents 按钮
  （[WindowSideBar.vue](../../../src/renderer/src/components/WindowSideBar.vue) L203-212，
  `documentsRouteActive` + `openDocuments` 模式）
- `routes.resumeScreening` 键已在 Task 12 加入 20 个 locale 的 routes.json；图标沿用路由
  meta 的 `lucide:file-search`（Task 12 路由定义）
- 路由名 `resume-screening` 已在 Task 12 注册（router/index.ts），直接按名 `router.push`

### 步骤

- [ ] 修改 `src/renderer/src/components/WindowSideBar.vue`：在 documents 按钮
  （`data-testid="app-documents-button"`，约 L203-212）的 `</button>` 之后插入：

```vue
            <button
              data-testid="app-resume-screening-button"
              type="button"
              class="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors hover:bg-accent/60"
              :class="
                resumeScreeningRouteActive ? 'bg-accent/70 text-foreground' : 'text-foreground'
              "
              @click="openResumeScreening"
            >
              <Icon icon="lucide:file-search" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ t('routes.resumeScreening') }}</span>
            </button>
```

- [ ] 同文件 `<script setup>`：在 `documentsRouteActive` computed（约 L818）之后追加：

```ts
const resumeScreeningRouteActive = computed(
  () => router?.currentRoute?.value?.name === 'resume-screening'
)
```

- [ ] 同文件：在 `openDocuments` 函数（约 L1032-1034）之后追加：

```ts
const openResumeScreening = () => {
  void router?.push({ name: 'resume-screening' })
}
```

- [ ] 验证 typecheck：

```sh
pnpm typecheck
```

- [ ] Commit：`feat(resume-screening): add sidebar entry`

## Task 17: 收尾质检

**Files:** 无新增改动（全量验证与收尾）

**背景知识**：

- 仓库规范（AGENTS.md）：交接前跑 format、i18n、lint、typecheck 与相关测试套件
- 测试分布：主进程 `test/main/resumeScreening/`（5 个文件）、渲染层
  `test/renderer/api/resumeScreeningClient.test.ts` +
  `test/renderer/stores/resumeScreeningStore.test.ts` +
  `test/renderer/pages/resumeScreening/`（3 个文件）
- `pnpm i18n:types` 已在 Task 12/15 各自跑过；此处 `pnpm i18n` 做键集一致性校验

### 步骤

- [ ] 全量静态检查：

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm i18n
```

- [ ] 跑本功能全部测试套件：

```sh
pnpm vitest run test/main/resumeScreening
pnpm vitest run test/renderer/api/resumeScreeningClient.test.ts
pnpm vitest run test/renderer/stores/resumeScreeningStore.test.ts
pnpm vitest run test/renderer/pages/resumeScreening
```

- [ ] 修复检查中发现的问题（如有），直至全部通过
- [ ] 手动冒烟：`pnpm dev` 启动应用，点击侧边栏「简历筛选」进入页面，走一遍创建任务 →
  查看进度 → 查看详情的完整流程
- [ ] Commit（如有收尾改动）：`feat(resume-screening): final quality checks`
