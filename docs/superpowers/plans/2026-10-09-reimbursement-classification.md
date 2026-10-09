# 报销分类整理（Reimbursement Classification）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单据识别（documents）之上增加按报销类别 → 人员 → 期间的分类整理视图、可自定义报销类别配置、材料自动统计与整理包导出。

**Architecture:** 归类/分组为纯函数收在主进程 `src/main/documents/reimbursement.ts`；配置存 settings KV（`documents.reimbursementConfig`），手动归属存 `documents` 表新列 `reimbursement_override`；新增 5 条 IPC 路由；渲染端归档页加「报销整理」视图、设置加「报销类别配置」页。

**Tech Stack:** Electron/Vue 3/TS、zod 契约路由、better-sqlite3-multiple-ciphers（BaseTable 迁移）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-09-reimbursement-classification-design.md`

---

## File Structure

```
src/shared/contracts/routes/documents.routes.ts   # +5 路由 + zod schema（修改）
src/shared/documents.ts                            # DocumentRecord +reimbursementOverride（修改）
src/shared/contracts/routes/system.routes.ts       # SettingsRouteNameSchema +1（修改）
src/shared/settingsNavigation.ts                   # 导航项 +1（修改）
src/main/documents/data/tables/documents.ts        # 加列 reimbursement_override（修改）
src/main/data/schemaCatalog.ts                     # documents repairableColumns（修改）
src/main/documents/repository.ts                   # override 映射 + setReimbursementOverride（修改）
src/main/documents/presetReimbursementConfig.json  # 新增：seed 默认配置（28 类别）
src/main/documents/reimbursementConfig.ts          # 新增：配置读写/规范化
src/main/documents/reimbursement.ts                # 新增：归类+分组纯函数
src/main/documents/reimbursementExport.ts          # 新增：导出整理包
src/main/documents/routes.ts                       # +5 路由处理器（修改）
src/main/app/composition.ts                        # createDocumentsRoutes 传 configStore（修改）
src/renderer/api/DocumentsClient.ts                # +5 方法（修改）
src/renderer/src/stores/documents.ts               # +state/actions（修改）
src/renderer/src/pages/documents/DocumentsArchivePage.vue   # 视图切换（修改）
src/renderer/src/pages/documents/ReimbursementView.vue      # 新增
src/renderer/settings/components/documents/ReimbursementConfigPage.vue  # 新增
src/renderer/settings/settingsRouteComponents.ts   # +1（修改）
src/renderer/src/i18n/<locale>/documents.json      # ×20（修改）
src/renderer/src/i18n/<locale>/routes.json         # ×20（修改）
test/main/documents/reimbursement.spec.ts          # 新增
test/main/documents/documentsTableMigration.test.ts# 新增
test/main/documents/documentsRoutes.test.ts        # 扩展
test/renderer/stores/documentsReimbursementStore.test.ts # 新增
test/renderer/components/ReimbursementView.test.ts # 新增
```

**关键既有事实（实现者必读）：**

- 迁移机制（Task 2 实施后修正）：documents 三表**不在** `createMainSchemaCatalog().migrationTables` 中，`migrate()`/`getMigrationSQL` 对 documents 是死代码；agent.db 即 MainDatabase。既有表加列的真实机制是 `CATALOG_DEFINITIONS`（schemaCatalog.ts）的 `repairableColumns` → `getSchemaCatalog()` 生成 `columns[].addColumnSql` → 启动诊断 missing_column（repairable）→ 一次性 `repairStartupSchema` 执行 ALTER。先例：`agent_memory_audit.memory_ref_id`。全局 `schema_versions` 高水位实测 69（deepchatUsageStats），67 已被 deepchatPendingInputs 占用——**documents 表禁止占用版本号**。
- 渲染端 IPC：`src/renderer/api/DocumentsClient.ts` 的 `invokeRoute(bridge, route.name, input)` 模式。
- 设置 KV 接口：`DocumentsSettingsStore { getSetting, setSetting }`（见 `modelSettings.ts`）；composition.ts 中实例为 `providerSettings`。
- 主进程测试运行方式（better-sqlite3 需要 Electron ABI）：
  `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`
- `test/setup.ts` 全局 mock fs/path：主进程测试文件顶部需 `vi.unmock('fs'); vi.unmock('node:fs'); vi.unmock('path'); vi.unmock('node:path')`。
- 代码风格：Oxfmt，单引号、无分号、100 列。

---

### Task 1: 契约 schema + 5 条路由定义 + DocumentRecord 扩展

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`
- Modify: `src/shared/contracts/routes.ts`（路由 catalog 注册）
- Modify: `src/shared/documents.ts`（DocumentRecord 接口）
- Test: `test/main/documents/reimbursement.spec.ts`（本 task 仅契约解析用例，纯函数放 Task 3）

- [ ] **Step 1.1: documents.routes.ts 追加 schema 与路由**

在文件末尾（`documentsTasksClearFailedRoute` 之后）追加：

```ts
const reimbursementTypeKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/)

export const reimbursementMaterialSchema = z.object({
  name: z.string().min(1).max(100),
  linkedTypeKeys: z.array(reimbursementTypeKeySchema).max(50)
})

export const reimbursementCategorySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(50),
  requiredMaterials: z.array(reimbursementMaterialSchema).max(50),
  linkedTypeKeys: z.array(reimbursementTypeKeySchema).max(50),
  sortOrder: z.number().int().nonnegative()
})

export const reimbursementConfigSchema = z.object({
  version: z.literal(1),
  categories: z.array(reimbursementCategorySchema).max(200),
  personFieldKeys: z.array(z.string().min(1).max(64)).max(50),
  dateFieldKeys: z.array(z.string().min(1).max(64)).max(50),
  amountFieldKeys: z.array(z.string().min(1).max(64)).max(50),
  dateGrouping: z.enum(['day', 'month'])
})

export type ReimbursementConfig = z.infer<typeof reimbursementConfigSchema>

export const reimbursementDocumentEntrySchema = z.object({
  id: z.string().min(1),
  typeKey: z.string().min(1),
  templateName: z.string().min(1),
  person: z.string().nullable(),
  period: z.string().nullable(),
  amount: z.number().nullable(),
  amountUncertain: z.boolean(),
  uncertainCount: z.number().int().nonnegative(),
  fileNames: z.array(z.string()),
  isOverride: z.boolean()
})

export const reimbursementBucketSchema = z.object({
  period: z.string().nullable(),
  documents: z.array(reimbursementDocumentEntrySchema)
})

export const reimbursementGroupSchema = z.object({
  person: z.string().nullable(),
  buckets: z.array(reimbursementBucketSchema)
})

export const reimbursementMaterialStatSchema = reimbursementMaterialSchema.extend({
  count: z.number().int().nonnegative()
})

export const reimbursementCategoryNodeSchema = z.object({
  category: reimbursementCategorySchema,
  total: z.number().int().nonnegative(),
  materials: z.array(reimbursementMaterialStatSchema),
  groups: z.array(reimbursementGroupSchema)
})

export const documentsReimbursementGetConfigRoute = defineRouteContract({
  name: 'documents.reimbursement.getConfig',
  input: z.object({}),
  output: z.object({ config: reimbursementConfigSchema })
})

export const documentsReimbursementSetConfigRoute = defineRouteContract({
  name: 'documents.reimbursement.setConfig',
  input: z.object({ config: reimbursementConfigSchema }),
  output: z.object({ config: reimbursementConfigSchema })
})

export const documentsReimbursementTreeRoute = defineRouteContract({
  name: 'documents.reimbursement.tree',
  input: z.object({
    status: documentStatusSchema.optional(),
    dateFrom: timestampMsSchema.optional(),
    dateTo: timestampMsSchema.optional()
  }),
  output: z.object({
    tree: z.array(reimbursementCategoryNodeSchema),
    unassigned: z.array(reimbursementGroupSchema),
    summary: z.array(
      z.object({
        categoryId: z.string().min(1).nullable(),
        total: z.number().int().nonnegative()
      })
    )
  })
})

export const documentsReimbursementSetOverrideRoute = defineRouteContract({
  name: 'documents.reimbursement.setOverride',
  input: z.object({
    documentId: z.string().min(1),
    // category id | 'unassigned'（强制未分类）| null（清除覆盖，恢复自动归类）
    categoryId: z.string().min(1).nullable()
  }),
  output: z.object({ document: documentRecordSchema.nullable() })
})

export const documentsReimbursementExportRoute = defineRouteContract({
  name: 'documents.reimbursement.export',
  input: z.object({
    status: documentStatusSchema.optional(),
    dateFrom: timestampMsSchema.optional(),
    dateTo: timestampMsSchema.optional()
  }),
  output: z
    .object({
      canceled: z.boolean(),
      path: z.string().min(1).optional(),
      exportedFiles: z.number().int().nonnegative().optional(),
      summaryPath: z.string().min(1).optional()
    })
    .refine((value) => value.canceled || typeof value.path === 'string', {
      message: 'path is required when not canceled'
    })
})
```

- [ ] **Step 1.2: routes.ts 注册 5 条路由**

`src/shared/contracts/routes.ts`：
1. 在 `from './routes/documents.routes'` 的命名 import 块（约 379-398 行）中追加导入 5 条新路由常量。
2. 在 `DEEPCHAT_ROUTE_CATALOG_PART_1` 的 `documentsTasksClearFailedRoute` 条目（约 841 行）后追加：

```ts
  [documentsReimbursementGetConfigRoute.name]: documentsReimbursementGetConfigRoute,
  [documentsReimbursementSetConfigRoute.name]: documentsReimbursementSetConfigRoute,
  [documentsReimbursementTreeRoute.name]: documentsReimbursementTreeRoute,
  [documentsReimbursementSetOverrideRoute.name]: documentsReimbursementSetOverrideRoute,
  [documentsReimbursementExportRoute.name]: documentsReimbursementExportRoute,
```

（运行时 `getRouteContract` 依赖 catalog 查找，未注册则 IPC 不可达。）

- [ ] **Step 1.3: DocumentRecord 扩展**

`src/shared/documents.ts` 中找到 `interface DocumentRecord`，在 `status` 字段后加：

```ts
  /** 手动报销归类：null=自动；'unassigned'=强制未分类；其余=类别 id */
  reimbursementOverride: string | null
```

- [ ] **Step 1.4: 契约解析测试**

`test/main/documents/reimbursement.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import {
  documentsReimbursementExportRoute,
  documentsReimbursementGetConfigRoute,
  documentsReimbursementSetConfigRoute,
  documentsReimbursementSetOverrideRoute,
  documentsReimbursementTreeRoute,
  reimbursementConfigSchema
} from '@shared/contracts/routes'

const validConfig = {
  version: 1 as const,
  categories: [
    {
      id: 'cat-meeting',
      name: '会议费',
      requiredMaterials: [{ name: '发票', linkedTypeKeys: ['invoice_general'] }],
      linkedTypeKeys: ['meeting_minutes'],
      sortOrder: 1
    }
  ],
  personFieldKeys: ['buyer_name'],
  dateFieldKeys: ['invoice_date'],
  amountFieldKeys: ['total_amount'],
  dateGrouping: 'month' as const
}

describe('reimbursement contracts', () => {
  it('parses a valid config', () => {
    expect(reimbursementConfigSchema.parse(validConfig)).toEqual(validConfig)
  })

  it('rejects duplicate-empty category names and bad type keys', () => {
    expect(
      reimbursementConfigSchema.safeParse({
        ...validConfig,
        categories: [{ ...validConfig.categories[0], linkedTypeKeys: ['Bad-Key'] }]
      }).success
    ).toBe(false)
  })

  it('defines the five routes', () => {
    expect(documentsReimbursementGetConfigRoute.name).toBe('documents.reimbursement.getConfig')
    expect(documentsReimbursementSetConfigRoute.name).toBe('documents.reimbursement.setConfig')
    expect(documentsReimbursementTreeRoute.name).toBe('documents.reimbursement.tree')
    expect(documentsReimbursementSetOverrideRoute.name).toBe('documents.reimbursement.setOverride')
    expect(documentsReimbursementExportRoute.name).toBe('documents.reimbursement.export')
  })
})
```

- [ ] **Step 1.5: 运行测试**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts --config vitest.config.ts`
Expected: PASS（此时仅契约用例，纯函数用例 Task 3 补充）

- [ ] **Step 1.6: Commit**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes.ts src/shared/documents.ts test/main/documents/reimbursement.spec.ts
git commit -m "feat(documents): reimbursement route contracts"
```

---

### Task 2: documents 表加列迁移 + repository override 支持

**Files:**
- Modify: `src/main/documents/data/tables/documents.ts`
- Modify: `src/main/data/schemaCatalog.ts`（repairableColumns，见 Step 2.3a）
- Modify: `src/main/documents/repository.ts`
- Modify: `src/shared/contracts/routes/documents.routes.ts`（documentRecordSchema 同步补字段，见 Step 2.4a）
- Test: `test/main/documents/documentsTableMigration.test.ts`

> **Task 1 质量审查强制修订项：** `interface DocumentRecord` 已有必填 `reimbursementOverride`，但 zod `documentRecordSchema`（documents.routes.ts:78-90）没有。zod object 默认 strip 未知键，若不同步补字段，Task 2 起所有经 `output.parse` 的 IPC 响应（list/get/upsert/setOverride）都会静默丢弃 `reimbursementOverride`，渲染端 `as DocumentRecord` 强转后将拿到 `undefined` 却被类型声称 `string | null`——必须在本 task 中一并修复。

- [ ] **Step 2.1: 写迁移测试（先失败）**

`test/main/documents/documentsTableMigration.test.ts`：

```ts
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { DocumentsTable } from '@/documents/data/tables/documents'

describe('documents table reimbursement_override migration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => db.close())

  it('fresh create includes the column', () => {
    new DocumentsTable(db).createTable()
    const columns = (db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(columns).toContain('reimbursement_override')
  })

  it('registers the column as repairable in the schema catalog', () => {
    const spec = getSchemaCatalog().find((table) => table.name === 'documents')
    expect(spec).toBeDefined()
    const column = spec!.columns.find((c) => c.name === 'reimbursement_override')
    expect(column).toBeDefined()
    expect(column!.addColumnSql).toContain('reimbursement_override')
  })

  it('addColumnSql upgrades a legacy documents table', () => {
    const spec = getSchemaCatalog().find((table) => table.name === 'documents')!
    db.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, template_id TEXT NOT NULL, type_key TEXT NOT NULL,
      template_snapshot_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
      file_uris_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL CHECK(source IN ('chat','manual')),
      session_id TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
    db.exec(spec.columns.find((c) => c.name === 'reimbursement_override')!.addColumnSql!)
    const columns = (db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(columns).toContain('reimbursement_override')
  })
})
```

（import 追加 `import { getSchemaCatalog } from '@/data/schemaCatalog'`；describe 名 `documents table reimbursement_override schema repair`。）

- [ ] **Step 2.2: 运行确认失败**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTableMigration.test.ts --config vitest.config.ts`
Expected: FAIL（getLatestVersion 返回 1、无该列）

- [ ] **Step 2.3: 修改 documents.ts 表（不改版本方法）**

1. `DocumentRow` 接口 `session_id` 后加 `reimbursement_override: string | null`。
2. `getCreateTableSQL()` 中 `session_id TEXT,` 后加一行 `reimbursement_override TEXT,`。
3. `getLatestVersion()`/`getMigrationSQL()` **保持原样**（documents 不在 migrationTables，版本机制对它是死代码；禁止占用全局版本号）。
4. `DocumentTableInsertInput` 加 `reimbursementOverride?: string | null`；`insert()` 的 INSERT 列与值各加一项（`reimbursement_override` / `input.reimbursementOverride ?? null`）。
5. 新方法：

```ts
  setReimbursementOverride(id: string, value: string | null): DocumentRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    this.db
      .prepare('UPDATE documents SET reimbursement_override = ?, updated_at = ? WHERE id = ?')
      .run(value, Date.now(), id)
    return this.get(id)
  }
```

- [ ] **Step 2.3a（关键）: schemaCatalog 注册 repairableColumns**

`src/main/data/schemaCatalog.ts` 的 `CATALOG_DEFINITIONS` documents 条目（约 404-407 行）改为：

```ts
  {
    name: 'documents',
    createTable: (db) => new DocumentsTable(db),
    repairableColumns: {
      reimbursement_override: 'ALTER TABLE documents ADD COLUMN reimbursement_override TEXT;'
    }
  },
```

这是存量 v1.2.7 用户数据库获得新列的唯一路径（启动诊断 missing_column → 一次性 repair 执行 addColumnSql）。

- [ ] **Step 2.4: repository.ts 映射与方法**

在 `repository.ts` 的行→DocumentRecord 映射处（搜 `sessionId:` 的映射对象）加：

```ts
      reimbursementOverride: row.reimbursement_override ?? null,
```

并新增方法（与其他 update 方法并列）：

```ts
  setReimbursementOverride(id: string, categoryId: string | null): DocumentRecord | undefined {
    const row = this.documentsTable.setReimbursementOverride(id, categoryId)
    return row ? this.toDocumentRecord(row) : undefined
  }
```

（`toDocumentRecord` 为既有私有映射方法名；若实际名称不同，复用实际名称。）

**Step 2.4a（强制）: documentRecordSchema 同步补字段**

`src/shared/contracts/routes/documents.routes.ts` 的 `documentRecordSchema` 中 `status: documentStatusSchema,` 后加：

```ts
  reimbursementOverride: z.string().nullable(),
```

（必须与 repository 行映射同 commit 落地：先有 DB 字段而 schema 无此键 → output.parse 静默 strip；先有 schema 必填键而 repository 不产出 → parse 直接抛错。本 task 两者同时就位，顺序安全。）

- [ ] **Step 2.5: 运行测试确认通过**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTableMigration.test.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 2.6: Commit**

```bash
git add src/main/documents/data/tables/documents.ts src/main/data/schemaCatalog.ts src/main/documents/repository.ts src/shared/contracts/routes/documents.routes.ts test/main/documents/documentsTableMigration.test.ts
git commit -m "feat(documents): reimbursement_override column"
```

> **实施记录（as-built）**：初版实施（d6b931b0）误按全局版本迁移机制实现（v67），复审发现 documents 表不在 migrationTables、迁移为死代码且 67 已被占用，返工（f37dc5f2）改为 repairableColumns 机制并还原版本方法。复审通过：存量库升级路径闭环（诊断→一次性 repair→ALTER）。

> **Task 1 质量审查建议项（后续 task 落实）：**
> - Task 3：`REIMBURSEMENT_UNASSIGNED = 'unassigned'` 常量放 `src/shared/documents.ts`（渲染端复用，避免魔法字符串跨 IPC）；规范化时拒绝 `id === 'unassigned'` 的类别，消除与哨兵值碰撞（`resolveDocumentCategoryId` 先查哨兵，真实类别 id 为 'unassigned' 时会被误判）。
> - Task 4：`setOverride` handler 对 `categoryId` 做 fail-fast 校验（须 ∈ config.categories ∪ {'unassigned'} ∪ {null}），避免陈旧 id 静默降级丢失用户意图。
> - Task 5：从 `@shared/contracts/routes` 导出 `export type ReimbursementTreeResult = z.infer<typeof documentsReimbursementTreeRoute.output>`，满足「类型优先放 shared」的诉求，避免届时再动契约文件。

---

### Task 3: 归类纯函数 + 配置模块 + seed 数据（TDD）

**Files:**
- Create: `src/main/documents/presetReimbursementConfig.json`
- Create: `src/main/documents/reimbursementConfig.ts`
- Create: `src/main/documents/reimbursement.ts`
- Test: `test/main/documents/reimbursement.spec.ts`（追加）

- [ ] **Step 3.1: 追加纯函数失败测试**

在 `test/main/documents/reimbursement.spec.ts` 追加：

```ts
import {
  amountFor,
  buildReimbursementTree,
  parsePeriodValue,
  periodFor,
  personFor,
  REIMBURSEMENT_UNASSIGNED,
  resolveDocumentCategoryId
} from '@/documents/reimbursement'
import type { DocumentRecord } from '@shared/documents'

const config = reimbursementConfigSchema.parse({
  version: 1,
  categories: [
    { id: 'cat-a', name: '会议费', requiredMaterials: [{ name: '发票', linkedTypeKeys: ['invoice_general'] }], linkedTypeKeys: ['meeting_minutes'], sortOrder: 1 },
    { id: 'cat-b', name: '业务招待费', requiredMaterials: [], linkedTypeKeys: ['catering_receipt'], sortOrder: 2 }
  ],
  personFieldKeys: ['buyer_name', 'guest_name'],
  dateFieldKeys: ['invoice_date', 'consume_date'],
  amountFieldKeys: ['total_amount', 'amount'],
  dateGrouping: 'month'
})

const doc = (overrides: Partial<DocumentRecord> & { fields?: Record<string, unknown> }) =>
  ({
    id: 'd1', templateId: 't', typeKey: 'meeting_minutes', templateSnapshot: {} as never,
    fields: {}, fileUris: [], source: 'manual', sessionId: null, status: 'confirmed',
    reimbursementOverride: null, createdAt: 0, updatedAt: 0, ...overrides
  }) as DocumentRecord

describe('resolveDocumentCategoryId', () => {
  it('override wins', () => {
    const d = doc({ typeKey: 'catering_receipt', reimbursementOverride: 'cat-a' })
    expect(resolveDocumentCategoryId(d, config)).toEqual({ categoryId: 'cat-a', isOverride: true })
  })
  it('maps by typeKey (lowest sortOrder)', () => {
    expect(resolveDocumentCategoryId(doc({ typeKey: 'meeting_minutes' }), config)).toEqual({
      categoryId: 'cat-a', isOverride: false
    })
  })
  it('unassigned override forces null', () => {
    expect(resolveDocumentCategoryId(doc({ reimbursementOverride: REIMBURSEMENT_UNASSIGNED }), config))
      .toEqual({ categoryId: null, isOverride: true })
  })
  it('stale override (deleted category) falls back to auto mapping', () => {
    expect(resolveDocumentCategoryId(doc({ typeKey: 'catering_receipt', reimbursementOverride: 'cat-gone' }), config))
      .toEqual({ categoryId: 'cat-b', isOverride: false })
  })
  it('no mapping → null', () => {
    expect(resolveDocumentCategoryId(doc({ typeKey: 'resume' }), config)).toEqual({ categoryId: null, isOverride: false })
  })
})

describe('field extraction', () => {
  it('person: first configured key with non-empty value', () => {
    const d = doc({ fields: { buyer_name: { value: '张三', uncertain: false }, guest_name: { value: '李四', uncertain: false } } as never })
    expect(personFor(d, config)).toBe('张三')
  })
  it('person: array value takes first non-empty element', () => {
    const d = doc({ fields: { buyer_name: { value: ['', '王五'], uncertain: false } } as never })
    expect(personFor(d, config)).toBe('王五')
  })
  it('period: parses and groups by month', () => {
    const d = doc({ fields: { invoice_date: { value: '2026/9/5', uncertain: false } } as never })
    expect(periodFor(d, config)).toBe('2026-09')
  })
  it('period: day grouping keeps the day', () => {
    const d = doc({ fields: { invoice_date: { value: '2026-09-05 13:20', uncertain: false } } as never })
    expect(periodFor(d, { ...config, dateGrouping: 'day' })).toBe('2026-09-05')
  })
  it('parsePeriodValue handles dashes, slashes, dots and rejects garbage', () => {
    expect(parsePeriodValue('2026-09-05')).toBe('2026-09-05')
    expect(parsePeriodValue('2026.9.5')).toBe('2026-09-05')
    expect(parsePeriodValue('无日期')).toBeNull()
  })
  it('amount: numeric string with separators', () => {
    const d = doc({ fields: { total_amount: { value: '1,234.50', uncertain: true } } as never })
    expect(amountFor(d, config)).toEqual({ amount: 1234.5, uncertain: true })
  })
})

describe('buildReimbursementTree', () => {
  const templateNameById = new Map([['t', '会议纪要']])
  it('groups category → person → period desc, unknown last', () => {
    const d1 = doc({ id: 'd1', fields: { buyer_name: { value: '张三', uncertain: false }, invoice_date: { value: '2026-09-01', uncertain: false }, total_amount: { value: 100, uncertain: false } } as never })
    const d2 = doc({ id: 'd2', fields: { buyer_name: { value: '张三', uncertain: false }, invoice_date: { value: '2026-10-01', uncertain: false } } as never })
    const d3 = doc({ id: 'd3', fields: {} as never })
    const result = buildReimbursementTree([d1, d2, d3], config, templateNameById)
    const catA = result.tree.find((n) => n.category.id === 'cat-a')!
    expect(catA.groups.map((g) => g.person)).toEqual(['张三', null])
    expect(catA.groups[0].buckets.map((b) => b.period)).toEqual(['2026-10', '2026-09'])
    expect(catA.materials[0]).toEqual({ name: '发票', linkedTypeKeys: ['invoice_general'], count: 0 })
    expect(result.unassigned.length).toBe(1)
    expect(result.summary).toEqual([
      { categoryId: 'cat-a', total: 2 },
      { categoryId: 'cat-b', total: 0 },
      { categoryId: null, total: 1 }
    ])
  })
})
```

- [ ] **Step 3.2: 运行确认失败**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3.3: 创建 `src/main/documents/reimbursement.ts`**

```ts
import type { ReimbursementConfig } from '@shared/contracts/routes'
import type { DocumentRecord } from '@shared/documents'

export const REIMBURSEMENT_UNASSIGNED = 'unassigned'
export const REIMBURSEMENT_TREE_MAX_DOCUMENTS = 5000

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = asText(item)
      if (text) return text
    }
  }
  return null
}

export function extractFieldValue(
  fields: DocumentRecord['fields'],
  keys: string[]
): { value: unknown; uncertain: boolean } | null {
  for (const key of keys) {
    const entry = fields[key]
    if (!entry || entry.value === null || entry.value === undefined) continue
    if (Array.isArray(entry.value) && entry.value.length === 0) continue
    return entry
  }
  return null
}

const PERIOD_RE = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/

export function parsePeriodValue(value: unknown): string | null {
  const text = asText(value)
  if (!text) return null
  const match = PERIOD_RE.exec(text)
  if (!match) return null
  const [, year, month, day] = match
  const pad = (part: string) => part.padStart(2, '0')
  return day ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}`
}

export interface CategoryResolution {
  categoryId: string | null
  isOverride: boolean
}

export function resolveDocumentCategoryId(
  document: Pick<DocumentRecord, 'typeKey' | 'reimbursementOverride'>,
  config: ReimbursementConfig
): CategoryResolution {
  const override = document.reimbursementOverride
  if (override === REIMBURSEMENT_UNASSIGNED) return { categoryId: null, isOverride: true }
  if (override && config.categories.some((c) => c.id === override)) {
    return { categoryId: override, isOverride: true }
  }
  const mapped = config.categories
    .filter((c) => c.linkedTypeKeys.includes(document.typeKey))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0]
  return { categoryId: mapped?.id ?? null, isOverride: false }
}

export function personFor(document: DocumentRecord, config: ReimbursementConfig): string | null {
  const entry = extractFieldValue(document.fields, config.personFieldKeys)
  return entry ? asText(entry.value) : null
}

export function periodFor(
  document: DocumentRecord,
  config: ReimbursementConfig,
  grouping: 'day' | 'month' = config.dateGrouping
): string | null {
  const entry = extractFieldValue(document.fields, config.dateFieldKeys)
  const parsed = entry ? parsePeriodValue(entry.value) : null
  if (!parsed) return null
  return grouping === 'day' ? parsed : parsed.slice(0, 7)
}

export function amountFor(
  document: DocumentRecord,
  config: ReimbursementConfig
): { amount: number | null; uncertain: boolean } {
  const entry = extractFieldValue(document.fields, config.amountFieldKeys)
  if (!entry) return { amount: null, uncertain: false }
  const raw = entry.value
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.replace(/[,，\s元]/g, ''))
        : NaN
  return { amount: Number.isFinite(numeric) ? numeric : null, uncertain: entry.uncertain }
}

export function uncertainCountFor(document: DocumentRecord): number {
  return Object.values(document.fields).filter((entry) => entry.uncertain).length
}

export interface ReimbursementDocumentEntry {
  id: string
  typeKey: string
  templateName: string
  person: string | null
  period: string | null
  amount: number | null
  amountUncertain: boolean
  uncertainCount: number
  fileNames: string[]
  isOverride: boolean
}

export interface ReimbursementBucket {
  period: string | null
  documents: ReimbursementDocumentEntry[]
}

export interface ReimbursementGroup {
  person: string | null
  buckets: ReimbursementBucket[]
}

export interface ReimbursementCategoryNode {
  category: ReimbursementConfig['categories'][number]
  total: number
  materials: Array<{ name: string; linkedTypeKeys: string[]; count: number }>
  groups: ReimbursementGroup[]
}

export interface ReimbursementTreeResult {
  tree: ReimbursementCategoryNode[]
  unassigned: ReimbursementGroup[]
  summary: Array<{ categoryId: string | null; total: number }>
}

const basename = (uri: string): string => {
  const normalized = uri.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || uri
}

const toEntry = (
  document: DocumentRecord,
  config: ReimbursementConfig,
  templateNameById: Map<string, string>,
  isOverride: boolean
): ReimbursementDocumentEntry => ({
  id: document.id,
  typeKey: document.typeKey,
  templateName: templateNameById.get(document.templateId) ?? document.typeKey,
  person: personFor(document, config),
  period: periodFor(document, config),
  amount: amountFor(document, config).amount,
  amountUncertain: amountFor(document, config).uncertain,
  uncertainCount: uncertainCountFor(document),
  fileNames: document.fileUris.map(basename),
  isOverride
})

const PERSON_UNKNOWN = null

function groupByPersonAndPeriod(
  entries: ReimbursementDocumentEntry[]
): ReimbursementGroup[] {
  const byPerson = new Map<string | null, ReimbursementDocumentEntry[]>()
  for (const entry of entries) {
    const list = byPerson.get(entry.person) ?? []
    list.push(entry)
    byPerson.set(entry.person, list)
  }
  const groups: ReimbursementGroup[] = []
  for (const [person, list] of byPerson) {
    const byPeriod = new Map<string | null, ReimbursementDocumentEntry[]>()
    for (const entry of list) {
      const bucket = byPeriod.get(entry.period) ?? []
      bucket.push(entry)
      byPeriod.set(entry.period, bucket)
    }
    const buckets: ReimbursementBucket[] = [...byPeriod.entries()]
      .map(([period, docs]) => ({ period, documents: docs }))
      .sort((a, b) => {
        if (a.period === null) return 1
        if (b.period === null) return -1
        return b.period.localeCompare(a.period)
      })
    groups.push({ person, buckets })
  }
  return groups.sort((a, b) => {
    if (a.person === PERSON_UNKNOWN) return 1
    if (b.person === PERSON_UNKNOWN) return -1
    return (a.person ?? '').localeCompare(b.person ?? '', 'zh-Hans-CN')
  })
}

export function buildReimbursementTree(
  documents: DocumentRecord[],
  config: ReimbursementConfig,
  templateNameById: Map<string, string>
): ReimbursementTreeResult {
  const unassignedEntries: ReimbursementDocumentEntry[] = []
  const entriesByCategory = new Map<string, ReimbursementDocumentEntry[]>()
  const summary = new Map<string | null, number>()

  for (const document of documents) {
    const { categoryId, isOverride } = resolveDocumentCategoryId(document, config)
    const entry = toEntry(document, config, templateNameById, isOverride)
    summary.set(categoryId, (summary.get(categoryId) ?? 0) + 1)
    if (categoryId === null) {
      unassignedEntries.push(entry)
    } else {
      const list = entriesByCategory.get(categoryId) ?? []
      list.push(entry)
      entriesByCategory.set(categoryId, list)
    }
  }

  const tree: ReimbursementCategoryNode[] = config.categories.map((category) => {
    const entries = entriesByCategory.get(category.id) ?? []
    return {
      category,
      total: entries.length,
      materials: category.requiredMaterials.map((material) => ({
        name: material.name,
        linkedTypeKeys: material.linkedTypeKeys,
        count: entries.filter((entry) =>
          material.linkedTypeKeys.includes(entry.typeKey)
        ).length
      })),
      groups: groupByPersonAndPeriod(entries)
    }
  })

  return {
    tree,
    unassigned: groupByPersonAndPeriod(unassignedEntries),
    summary: [
      ...tree.map((node) => ({ categoryId: node.category.id, total: node.total })),
      { categoryId: null, total: summary.get(null) ?? 0 }
    ]
  }
}
```

- [ ] **Step 3.4: 运行纯函数测试确认通过**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 3.5: 创建 seed JSON `src/main/documents/presetReimbursementConfig.json`**

内容为 `报销制度中涉及的报销材料清单.csv` 的 28 个去重费用大类（来源 `docs/finacial-helper/`，同名行合并），默认映射仅覆盖与内置模板用途明确对应的类别（type_key 对照 `src/shared/documents.ts` 的 `PRESET_TEMPLATE_TYPE_KEY_MAP`）：

```json
{
  "version": 1,
  "categories": [
    { "id": "cat-city-transport", "name": "城市交通费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 1 },
    { "id": "cat-abroad", "name": "因公出国（境）", "requiredMaterials": [{ "name": "机票电子行程单", "linkedTypeKeys": ["travel_itinerary"] }, { "name": "登机牌", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 2 },
    { "id": "cat-business-hospitality", "name": "业务招待费", "requiredMaterials": [{ "name": "用餐人数说明", "linkedTypeKeys": [] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "支付记录", "linkedTypeKeys": ["bank_receipt", "payment_screenshot"] }, { "name": "用餐流水单", "linkedTypeKeys": ["catering_receipt"] }], "linkedTypeKeys": ["catering_receipt"], "sortOrder": 3 },
    { "id": "cat-meeting", "name": "会议费", "requiredMaterials": [{ "name": "会议通知（议程）", "linkedTypeKeys": ["meeting_minutes"] }, { "name": "会议签到表", "linkedTypeKeys": [] }, { "name": "参会人员截图（线上会议）", "linkedTypeKeys": [] }, { "name": "费用清单", "linkedTypeKeys": [] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "合同", "linkedTypeKeys": ["contract"] }], "linkedTypeKeys": ["meeting_minutes"], "sortOrder": 4 },
    { "id": "cat-office-supplies", "name": "办公用品", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "订单完整截图（网购）", "linkedTypeKeys": ["purchase_order"] }, { "name": "采购申请单", "linkedTypeKeys": [] }, { "name": "送货单", "linkedTypeKeys": [] }], "linkedTypeKeys": ["purchase_order"], "sortOrder": 5 },
    { "id": "cat-printing", "name": "印刷费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "送货单", "linkedTypeKeys": [] }, { "name": "验收单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 6 },
    { "id": "cat-handling-fee", "name": "手续费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 7 },
    { "id": "cat-communication", "name": "通讯费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 8 },
    { "id": "cat-landline", "name": "固定电话费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": [] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "费用明细清单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 9 },
    { "id": "cat-network", "name": "网络费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": [] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "费用明细清单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 10 },
    { "id": "cat-express", "name": "快递费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": [] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "费用明细清单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 11 },
    { "id": "cat-commissioned", "name": "委托业务费", "requiredMaterials": [{ "name": "合同或具有同等法律效力的订单", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "完成验收单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 12 },
    { "id": "cat-patent", "name": "专利费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "专利申请受理通知书", "linkedTypeKeys": [] }, { "name": "收费明细清单（合同未明确总计）", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 13 },
    { "id": "cat-publication", "name": "文字版面费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "刊发文章（含研究院或项目署名）", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 14 },
    { "id": "cat-research-materials", "name": "课题研究资料费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "明细清单", "linkedTypeKeys": [] }, { "name": "领用和签收记录", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 15 },
    { "id": "cat-consulting-meeting", "name": "专家咨询费（会议形式）", "requiredMaterials": [{ "name": "会议通知（议程）", "linkedTypeKeys": ["meeting_minutes"] }, { "name": "会议签到表", "linkedTypeKeys": [] }, { "name": "会议截图（线上会议）", "linkedTypeKeys": [] }], "linkedTypeKeys": ["meeting_minutes"], "sortOrder": 16 },
    { "id": "cat-consulting-remote", "name": "专家咨询费（通讯形式）", "requiredMaterials": [{ "name": "信函或邮件等书面材料", "linkedTypeKeys": [] }, { "name": "专家本人身份证明", "linkedTypeKeys": [] }, { "name": "任职证明", "linkedTypeKeys": [] }, { "name": "收款信息", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 17 },
    { "id": "cat-materials-over", "name": "材料费（一万元以上）", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "订单明细", "linkedTypeKeys": ["purchase_order"] }, { "name": "验收单", "linkedTypeKeys": [] }, { "name": "合同", "linkedTypeKeys": ["contract"] }], "linkedTypeKeys": ["purchase_order"], "sortOrder": 18 },
    { "id": "cat-materials-under", "name": "材料费（一万元以下）", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "订单明细", "linkedTypeKeys": ["purchase_order"] }, { "name": "验收单（无法提供合同时）", "linkedTypeKeys": [] }], "linkedTypeKeys": ["purchase_order"], "sortOrder": 19 },
    { "id": "cat-equipment", "name": "设备费", "requiredMaterials": [{ "name": "合同/协议/订单（三选一）", "linkedTypeKeys": ["contract", "purchase_order"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "报价单", "linkedTypeKeys": ["quotation"] }, { "name": "送货单", "linkedTypeKeys": [] }, { "name": "验收单", "linkedTypeKeys": ["asset_acceptance"] }, { "name": "资产处理单", "linkedTypeKeys": [] }], "linkedTypeKeys": ["asset_acceptance", "quotation"], "sortOrder": 20 },
    { "id": "cat-renovation", "name": "场地装修费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract", "lease_contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 21 },
    { "id": "cat-renovation-special", "name": "场地装修费（非常规费用）", "requiredMaterials": [{ "name": "费用明细说明文件（赔偿费及押金没收）", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 22 },
    { "id": "cat-property", "name": "物业管理费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "费用明细清单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 23 },
    { "id": "cat-utilities", "name": "水电气暖费", "requiredMaterials": [{ "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "收费明细", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 24 },
    { "id": "cat-resource-rental", "name": "资源租用费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "收费明细", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 25 },
    { "id": "cat-training", "name": "培训费", "requiredMaterials": [{ "name": "培训协议/合同或年审规定", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 26 },
    { "id": "cat-activity", "name": "活动费", "requiredMaterials": [{ "name": "活动内容/日期/人数/姓名说明", "linkedTypeKeys": [] }, { "name": "费用单据", "linkedTypeKeys": ["invoice_special", "invoice_general"] }, { "name": "审批流程单", "linkedTypeKeys": [] }], "linkedTypeKeys": [], "sortOrder": 27 },
    { "id": "cat-recruiting", "name": "招聘费", "requiredMaterials": [{ "name": "合同", "linkedTypeKeys": ["contract"] }, { "name": "发票", "linkedTypeKeys": ["invoice_special", "invoice_general"] }], "linkedTypeKeys": [], "sortOrder": 28 }
  ],
  "personFieldKeys": ["passenger_name", "guest_name", "buyer_name", "payer_name", "payee_name", "handover_person", "name"],
  "dateFieldKeys": ["invoice_date", "consume_date", "depart_date", "checkin_date", "sign_date", "order_date", "meeting_date", "claim_date", "purchase_date", "entry_date", "value_date", "quote_date"],
  "amountFieldKeys": ["total_amount", "amount", "contract_amount"],
  "dateGrouping": "month"
}
```

- [ ] **Step 3.6: 创建配置模块 `src/main/documents/reimbursementConfig.ts`**

```ts
import { reimbursementConfigSchema, type ReimbursementConfig } from '@shared/contracts/routes'
import type { DocumentsSettingsStore } from './modelSettings'
import presetJson from './presetReimbursementConfig.json'

export const REIMBURSEMENT_SETTINGS_KEY = 'documents.reimbursementConfig'

const DEFAULT_CONFIG: ReimbursementConfig = reimbursementConfigSchema.parse(presetJson)

export function defaultReimbursementConfig(): ReimbursementConfig {
  return structuredClone(DEFAULT_CONFIG)
}

export function normalizeReimbursementConfig(value: unknown): ReimbursementConfig | null {
  const parsed = reimbursementConfigSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 惰性 seed：settings 键不存在或损坏时写入默认配置并返回；写入后与用户配置无异，不再被覆盖 */
export function readReimbursementConfig(store: DocumentsSettingsStore): ReimbursementConfig {
  const existing = normalizeReimbursementConfig(store.getSetting(REIMBURSEMENT_SETTINGS_KEY))
  if (existing) return existing
  const seeded = defaultReimbursementConfig()
  store.setSetting(REIMBURSEMENT_SETTINGS_KEY, seeded)
  return seeded
}

export function writeReimbursementConfig(
  store: DocumentsSettingsStore,
  config: ReimbursementConfig
): ReimbursementConfig {
  const normalized = reimbursementConfigSchema.parse(config)
  store.setSetting(REIMBURSEMENT_SETTINGS_KEY, normalized)
  return normalized
}
```

并在 `test/main/documents/reimbursement.spec.ts` 追加 seed 幂等测试：

```ts
import { readReimbursementConfig, writeReimbursementConfig, REIMBURSEMENT_SETTINGS_KEY } from '@/documents/reimbursementConfig'

function fakeStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    getSetting: <T>(key: string) => map.get(key) as T | undefined,
    setSetting: (key: string, value: unknown) => void map.set(key, value)
  }
}

describe('reimbursementConfig', () => {
  it('seeds defaults once and preserves user edits', () => {
    const store = fakeStore()
    const seeded = readReimbursementConfig(store)
    expect(seeded.categories.length).toBe(28)
    expect(readReimbursementConfig(store)).toEqual(seeded)
    const edited = { ...seeded, categories: [{ ...seeded.categories[0], name: '改名' }, ...seeded.categories.slice(1)] }
    writeReimbursementConfig(store, edited)
    expect(readReimbursementConfig(store)).toEqual(edited)
    expect(store.map.get(REIMBURSEMENT_SETTINGS_KEY)).toEqual(edited)
  })
  it('repairs corrupted config with defaults', () => {
    const store = fakeStore()
    store.setSetting(REIMBURSEMENT_SETTINGS_KEY, { broken: true })
    expect(readReimbursementConfig(store).version).toBe(1)
  })
})
```

- [ ] **Step 3.7: 运行测试**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts --config vitest.config.ts`
Expected: PASS

- [ ] **Step 3.8: Commit**

```bash
git add src/main/documents/reimbursement.ts src/main/documents/reimbursementConfig.ts src/main/documents/presetReimbursementConfig.json test/main/documents/reimbursement.spec.ts
git commit -m "feat(documents): reimbursement classification core"
```

> **实施记录（as-built）**：Task 3 以 38bc7787 + 7a7e3e2a 交付。落实 Task 1 审查建议：`REIMBURSEMENT_UNASSIGNED` 唯一定义放 `src/shared/documents.ts`（reimbursement.ts re-export），`reimbursementCategorySchema` refine 拒绝 `id === 'unassigned'`。树测试按修订 B 改为 4 文档（plan 原稿 d3 默认 typeKey 会映射 cat-a，与 summary/unassigned 断言矛盾）。质量审查修复：`reimbursementConfigSchema` refine 拒绝重复 category id；`amountFor` 剥离后空串返回 null（原先 `Number('') === 0` 静默归零）。约定：tree 顺序跟随 config.categories 数组序，sortOrder 仅用于 typeKey 映射冲突仲裁（最低者胜，并列时数组序靠前胜）。测试 20/20。

---

### Task 4: IPC 路由接线 + 导出整理包 + composition 注入

**Files:**
- Create: `src/main/documents/reimbursementExport.ts`
- Modify: `src/main/documents/routes.ts`
- Modify: `src/main/app/composition.ts:3144`
- Test: `test/main/documents/documentsRoutes.test.ts`（追加）

- [ ] **Step 4.1: 路由测试（先写，失败）**

在 `test/main/documents/documentsRoutes.test.ts` 末尾追加（复用该文件既有的 fake repository/extractor/taskManager 构造方式；fake repository 需支持 `listDocuments`/`listTemplates`/`setReimbursementOverride`）：

```ts
import {
  documentsReimbursementGetConfigRoute,
  documentsReimbursementSetConfigRoute,
  documentsReimbursementSetOverrideRoute
} from '@shared/contracts/routes'
import { defaultReimbursementConfig } from '@/documents/reimbursementConfig'

describe('reimbursement routes', () => {
  it('getConfig returns seeded defaults', async () => {
    const store = { map: new Map(), getSetting: () => undefined, setSetting() {} }
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager, store as never)
    const output = await routes[documentsReimbursementGetConfigRoute.name]({})
    expect(output.config.version).toBe(1)
  })

  it('setConfig persists and returns normalized config', async () => {
    const store = { map: new Map(), getSetting: () => undefined, setSetting() {} }
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager, store as never)
    const config = defaultReimbursementConfig()
    const output = await routes[documentsReimbursementSetConfigRoute.name]({ config })
    expect(output.config).toEqual(config)
  })

  it('setOverride returns updated document', async () => {
    const routes = createDocumentsRoutes(repository, fakeExtractor, fakeTaskManager)
    const output = await routes[documentsReimbursementSetOverrideRoute.name]({
      documentId: 'doc-1',
      categoryId: 'cat-meeting'
    })
    expect(output.document).not.toBeNull()
  })
})
```

（若该文件 fake repository 未实现 `setReimbursementOverride`，按既有 fake 模式补一个返回样例记录的实现。）

- [ ] **Step 4.2: 创建 `src/main/documents/reimbursementExport.ts`**

```ts
import path from 'node:path'
import type { ReimbursementTreeResult } from './reimbursement'

export interface ReimbursementExportDeps {
  copyFile: (src: string, dest: string) => Promise<void>
  mkdir: (dir: string, options: { recursive: true }) => Promise<string | undefined>
  writeFile: (file: string, data: string, encoding: 'utf-8') => Promise<void>
  exists: (target: string) => Promise<boolean>
}

export interface ReimbursementExportInput {
  rootDir: string
  result: ReimbursementTreeResult
  deps: ReimbursementExportDeps
  now?: Date
}

export interface ReimbursementExportOutput {
  path: string
  exportedFiles: number
  summaryPath: string
  /** 汇总行：原件缺失记录 */
  issues: string[]
}

const UNKNOWN_PERSON = '未知人员'
const UNKNOWN_PERIOD = '未知期间'
const CSV_HEADER = '类别,人员,期间,单据模板,文件名,金额,金额存疑,手动指定'

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function uniqueDir(base: string, deps: ReimbursementExportDeps): Promise<string> {
  let candidate = base
  for (let index = 1; (await deps.exists(candidate)) && index < 100; index += 1) {
    candidate = `${base}-${index}`
  }
  return candidate
}

async function uniqueFileName(dir: string, fileName: string, deps: ReimbursementExportDeps): Promise<string> {
  let candidate = fileName
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  for (let index = 1; (await deps.exists(path.join(dir, candidate))) && index < 1000; index += 1) {
    candidate = `${stem}-${index}${extension}`
  }
  return candidate
}

export async function exportReimbursementPackage(input: ReimbursementExportInput): Promise<ReimbursementExportOutput> {
  const { rootDir, result, deps, now = new Date() } = input
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('')
  const packageDir = await uniqueDir(path.join(rootDir, `报销整理-${stamp}`), deps)
  await deps.mkdir(packageDir, { recursive: true })

  const rows: string[][] = []
  const issues: string[] = []
  let exportedFiles = 0

  const writeGroup = async (categoryName: string, group: { person: string | null; buckets: Array<{ period: string | null; documents: Array<{ templateName: string; fileNames: string[]; amount: number | null; amountUncertain: boolean; isOverride: boolean; files?: string[] }> }> }) => {
    const personDirName = group.person ?? UNKNOWN_PERSON
    for (const bucket of group.buckets) {
      const periodDirName = bucket.period ?? UNKNOWN_PERIOD
      const targetDir = path.join(packageDir, categoryName, personDirName, periodDirName)
      await deps.mkdir(targetDir, { recursive: true })
      for (const entry of bucket.documents) {
        for (let index = 0; index < entry.fileNames.length; index += 1) {
          const source = entry.files?.[index]
          const originalName = entry.fileNames[index]
          if (!source) {
            issues.push(`缺失:${originalName}`)
            rows.push([categoryName, personDirName, periodDirName, entry.templateName, `缺失:${originalName}`, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
            continue
          }
          const fileName = await uniqueFileName(targetDir, originalName, deps)
          try {
            await deps.copyFile(source, path.join(targetDir, fileName))
            exportedFiles += 1
            rows.push([categoryName, personDirName, periodDirName, entry.templateName, fileName, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
          } catch (error) {
            issues.push(`复制失败:${originalName}`)
            rows.push([categoryName, personDirName, periodDirName, entry.templateName, `缺失:${originalName}`, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
          }
        }
      }
    }
  }

  for (const node of result.tree) {
    for (const group of node.groups) {
      await writeGroup(node.category.name, group)
    }
  }
  for (const group of result.unassigned) {
    await writeGroup('未分类', group)
  }

  const summaryPath = path.join(packageDir, '汇总.csv')
  const csv = `\uFEFF${CSV_HEADER}\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
  await deps.writeFile(summaryPath, csv, 'utf-8')

  return { path: packageDir, exportedFiles, summaryPath, issues }
}
```

注意：`entry.files`（fileUris 原路径）需从树构建传入 —— 在 Task 3 的 `ReimbursementDocumentEntry` 中**不**放 fileUris（渲染端不需要），导出时主进程单独构建「documentId → fileUris」映射并合并。因此导出路由中：构建 `filesById = new Map(documents.map((d) => [d.id, d.fileUris]))`，调用导出时对每个 entry 附加 `files: filesById.get(entry.id)`。实现方式：`exportReimbursementPackage` 输入加 `filesById: Map<string, string[]>`，在 `writeGroup` 内 `const files = filesById.get(entry.id)` 代替 `entry.files`。**以此为准实现**（上面代码块中的 `entry.files` 改为 `filesById` 注入）。

- [ ] **Step 4.3: routes.ts 接线**

1. 导入：`documentsReimbursement*` 5 个路由契约、`readReimbursementConfig`/`writeReimbursementConfig`/`REIMBURSEMENT_SETTINGS_KEY`、`buildReimbursementTree`/`REIMBURSEMENT_TREE_MAX_DOCUMENTS`、`exportReimbursementPackage`、`type DocumentsSettingsStore`（from `./modelSettings`）。
2. `createDocumentsRoutes` 增加第 4 参：

```ts
export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor,
  taskManager: RecognitionTaskManager,
  configStore: DocumentsSettingsStore,
  exportDeps: {
    showOpenDialog: (
      options: Electron.OpenDialogOptions
    ) => Promise<{ canceled: boolean; filePaths: string[] }>
  } = { showOpenDialog: (options) => dialog.showOpenDialog(options) }
): DeepchatRouteMap {
```

3. 在路由数组追加 5 个处理器：

```ts
    [
      documentsReimbursementGetConfigRoute.name,
      async (rawInput) => {
        documentsReimbursementGetConfigRoute.input.parse(rawInput)
        return documentsReimbursementGetConfigRoute.output.parse({
          config: readReimbursementConfig(configStore)
        })
      }
    ],
    [
      documentsReimbursementSetConfigRoute.name,
      async (rawInput) => {
        const input = documentsReimbursementSetConfigRoute.input.parse(rawInput)
        return documentsReimbursementSetConfigRoute.output.parse({
          config: writeReimbursementConfig(configStore, input.config)
        })
      }
    ],
    [
      documentsReimbursementTreeRoute.name,
      async (rawInput) => {
        const input = documentsReimbursementTreeRoute.input.parse(rawInput)
        const config = readReimbursementConfig(configStore)
        const documents = repository.listDocuments({
          status: input.status,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          limit: REIMBURSEMENT_TREE_MAX_DOCUMENTS
        })
        const templateNameById = new Map(repository.listTemplates().map((t) => [t.id, t.name]))
        return documentsReimbursementTreeRoute.output.parse(
          buildReimbursementTree(documents, config, templateNameById)
        )
      }
    ],
    [
      documentsReimbursementSetOverrideRoute.name,
      async (rawInput) => {
        const input = documentsReimbursementSetOverrideRoute.input.parse(rawInput)
        return documentsReimbursementSetOverrideRoute.output.parse({
          document: repository.setReimbursementOverride(input.documentId, input.categoryId)
        })
      }
    ],
    [
      documentsReimbursementExportRoute.name,
      async (rawInput) => {
        const input = documentsReimbursementExportRoute.input.parse(rawInput)
        const { canceled, filePaths } = await exportDeps.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: '选择报销整理包导出目录'
        })
        const rootDir = canceled ? undefined : filePaths[0]
        if (!rootDir) {
          return documentsReimbursementExportRoute.output.parse({ canceled: true })
        }
        const config = readReimbursementConfig(configStore)
        const documents = repository.listDocuments({
          status: input.status,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          limit: REIMBURSEMENT_TREE_MAX_DOCUMENTS
        })
        const templateNameById = new Map(repository.listTemplates().map((t) => [t.id, t.name]))
        const treeResult = buildReimbursementTree(documents, config, templateNameById)
        const filesById = new Map(documents.map((document) => [document.id, document.fileUris]))
        const output = await exportReimbursementPackage({
          rootDir,
          result: treeResult,
          filesById,
          deps: {
            copyFile: (src, dest) => fsp.copyFile(src, dest),
            mkdir: (dir, options) => fsp.mkdir(dir, options),
            writeFile: (file, data, encoding) => fsp.writeFile(file, data, encoding),
            exists: async (target) => {
              try {
                await fsp.access(target)
                return true
              } catch {
                return false
              }
            }
          }
        })
        return documentsReimbursementExportRoute.output.parse({
          canceled: false,
          path: output.path,
          exportedFiles: output.exportedFiles,
          summaryPath: output.summaryPath
        })
      }
    ]
```

（`fsp.access` 需要导入：`import { promises as fsp } from 'node:fs'` 已存在，`fsp.access` 可直接用。）

- [ ] **Step 4.4: composition.ts 注入**

`src/main/app/composition.ts:3144` 改为：

```ts
    const documentsRoutes = createDocumentsRoutes(
      documentsRepository,
      documentExtractor,
      recognitionTaskManager,
      providerSettings
    )
```

- [ ] **Step 4.5: 运行主进程 documents 测试**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`
Expected: PASS（含既有 documentsRoutes.test.ts 无回归）

- [ ] **Step 4.6: Commit**

```bash
git add src/main/documents/reimbursementExport.ts src/main/documents/routes.ts src/main/app/composition.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): reimbursement routes and export"
```

> **实施记录（as-built）**：Task 4 以 d6ca888b + b202c5bd 交付。签名与现实修正：`createDocumentsRoutes` 第 4 参已被 csvDeps 占用，`configStore?` 落在第 5 参、`reimbursementDeps`（showOpenDialog）第 6 参，既有调用零改动；composition 在 csvDeps 位传 `undefined` 走默认。落实 Task 1 审查建议：setOverride fail-fast 校验 categoryId ∈ categories ∪ {'unassigned'} ∪ {null}，repository undefined → `?? null`。导出按 plan 1124 行以 `filesById` 注入源路径。质量审查修复：`sanitizeDirName` 消毒三级目录名（防路径穿越与 Windows 非法字符）；CSV 公式注入中和（`/^[=+\-@\t\r]/` 前缀 `'`，csvCell 复用 csv.ts 的 escapeCsvCell）。测试 251/251（含 reimbursementExport 单元 5 例）。
>
> **Task 4 质量审查跨 task 修订（后续 task 落实）：**
> - Task 5-8（错误本地化）：渲染端 documentsTaskErrors.ts 用 `^\[documents\.xxx\]` 锚定前缀码匹配本地化；当前主进程报销路由错误（'Unknown reimbursement category: xxx'、'documents settings store is not configured'）为裸英文，渲染端将回退原文。接入 UI 时改主进程错误为 `[documents.reimbursement.*]` 稳定前缀码，并在渲染端与 i18n 登记。
> - Task 6（导出交互）：导出 5000 上限内串行复制可达分钟级，导出按钮需 loading/进行中提示，完成后提示 exportedFiles。
> - 可选（不强制本分支）：导出 `issues`（缺失/复制失败清单）未随 IPC 返回（契约无字段），如渲染端要展示失败明细需扩契约。

---

### Task 5: 渲染端 DocumentsClient + store 扩展

**Files:**
- Modify: `src/renderer/api/DocumentsClient.ts`
- Modify: `src/renderer/src/stores/documents.ts`
- Test: `test/renderer/stores/documentsReimbursementStore.test.ts`

- [ ] **Step 5.1: DocumentsClient 追加 5 方法**

在 `clearFailedTasks` 之后、`onTaskUpdated` 之前追加（导入区同步追加 5 个 route 契约）：

```ts
    reimbursementGetConfig: () => invokeRoute(bridge, documentsReimbursementGetConfigRoute.name, {}),
    reimbursementSetConfig: (config: ReimbursementConfig) =>
      invokeRoute(bridge, documentsReimbursementSetConfigRoute.name, { config }),
    reimbursementTree: (input: z.input<typeof documentsReimbursementTreeRoute.input> = {}) =>
      invokeRoute(bridge, documentsReimbursementTreeRoute.name, input),
    reimbursementSetOverride: (documentId: string, categoryId: string | null) =>
      invokeRoute(bridge, documentsReimbursementSetOverrideRoute.name, { documentId, categoryId }),
    reimbursementExport: (input: z.input<typeof documentsReimbursementExportRoute.input> = {}) =>
      invokeRoute(bridge, documentsReimbursementExportRoute.name, input),
```

类型导入：`import type { ReimbursementConfig } from '@shared/contracts/routes'`。

- [ ] **Step 5.2: store 扩展**

`src/renderer/src/stores/documents.ts` 在归档区之后追加：

```ts
  const reimbursementConfig = ref<ReimbursementConfig | null>(null)
  const reimbursementTree = ref<ReimbursementTreeResult | null>(null)
  const reimbursementIsLoading = ref(false)
  const reimbursementLoadError = ref<string | null>(null)

  async function loadReimbursementConfig(client: DocumentsClient = defaultClient) {
    const result = await client.reimbursementGetConfig()
    reimbursementConfig.value = result.config
    return result.config
  }

  async function saveReimbursementConfig(config: ReimbursementConfig, client: DocumentsClient = defaultClient) {
    const result = await client.reimbursementSetConfig(config)
    reimbursementConfig.value = result.config
    return result.config
  }

  async function loadReimbursementTree(client: DocumentsClient = defaultClient) {
    reimbursementIsLoading.value = true
    reimbursementLoadError.value = null
    try {
      reimbursementTree.value = await client.reimbursementTree({
        status: archiveFilter.status,
        dateFrom: archiveFilter.dateFrom,
        dateTo: archiveFilter.dateTo
      })
    } catch (error) {
      console.error('[DocumentsStore] loadReimbursementTree failed', error)
      reimbursementLoadError.value = 'settings.documents.reimbursement.loadFailed'
    } finally {
      reimbursementIsLoading.value = false
    }
  }

  async function setReimbursementOverride(documentId: string, categoryId: string | null, client: DocumentsClient = defaultClient) {
    await client.reimbursementSetOverride(documentId, categoryId)
    await loadReimbursementTree(client)
  }

  async function exportReimbursementPackage(client: DocumentsClient = defaultClient) {
    return client.reimbursementExport({
      status: archiveFilter.status,
      dateFrom: archiveFilter.dateFrom,
      dateTo: archiveFilter.dateTo
    })
  }
```

类型导入：`import type { ReimbursementConfig } from '@shared/contracts/routes'`、`import type { ReimbursementTreeResult } from '@/documents/reimbursement'`（渲染端 import 主进程文件仅作类型引用，若 lint 限制跨层 import，则将 `ReimbursementTreeResult` 等类型定义移到 `@shared/contracts/routes` 并由 `reimbursement.ts` 复用 re-export —— 二选一，优先移到 shared）。
return 对象中暴露上述 state/action。

- [ ] **Step 5.3: store 测试**

`test/renderer/stores/documentsReimbursementStore.test.ts`（参照 `documentsArchiveStore.test.ts` 的 fake client 模式）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'
import { defaultReimbursementConfig } from '../../../src/main/documents/reimbursementConfig'

const fakeClient = {
  reimbursementGetConfig: vi.fn(async () => ({ config: defaultReimbursementConfig() })),
  reimbursementSetConfig: vi.fn(async ({ config }: { config: unknown }) => ({ config })),
  reimbursementTree: vi.fn(async () => ({ tree: [], unassigned: [], summary: [] })),
  reimbursementSetOverride: vi.fn(async () => ({ document: null })),
  reimbursementExport: vi.fn(async () => ({ canceled: true }))
}

describe('documents store reimbursement actions', () => {
  setActivePinia(createPinia())

  it('loads and saves config', async () => {
    const store = useDocumentsStore()
    const config = await store.loadReimbursementConfig(fakeClient as never)
    expect(config.categories.length).toBe(28)
    await store.saveReimbursementConfig(config, fakeClient as never)
    expect(fakeClient.reimbursementSetConfig).toHaveBeenCalled()
  })

  it('loads tree and refreshes after override', async () => {
    const store = useDocumentsStore()
    await store.loadReimbursementTree(fakeClient as never)
    expect(store.reimbursementTree).not.toBeNull()
    await store.setReimbursementOverride('doc-1', 'cat-meeting', fakeClient as never)
    expect(fakeClient.reimbursementSetOverride).toHaveBeenCalledWith('doc-1', 'cat-meeting')
    expect(fakeClient.reimbursementTree).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 5.4: 运行渲染端测试**

Run: `pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts`
Expected: PASS

- [ ] **Step 5.5: Commit**

```bash
git add src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts test/renderer/stores/documentsReimbursementStore.test.ts
git commit -m "feat(documents): renderer reimbursement client and store"
```

> **实施记录（as-built）**：Task 5 以 1a39111a + c5b8b054 交付。落实 plan 449 行建议：`ReimbursementTreeResult` 以 `z.infer<typeof documentsReimbursementTreeRoute.output>` 导出到 shared 契约（渲染端零主进程 import）。store 测试去主进程依赖（内联 minimal config，28 类断言由主进程侧覆盖）。质量审查修复：`loadReimbursementTree` 补 seq 竞态守卫（对齐 archiveLoadSeq 模式）；tree/export 用例断言 archiveFilter 透传精确对象；新增乱序守卫与 export 透传用例。渲染端测试 5 例 + archive 回归 18 例全绿。
>
> **Task 5 质量审查跨 task 修订（后续 task 落实）：**
> - Task 6：setOverride 每次强制整树重载（5000 文档级 IPC），连续归类会反复重建 + isLoading 抖动——接 UI 时给覆盖触发的刷新加尾沿防抖（复用 scheduleArchiveRefresh 300ms 模式）或乐观移动；同时确认报销视图是否需要独立筛选（当前树/导出绑定 archiveFilter）。
> - Task 8：i18n key `settings.documents.reimbursement.loadFailed` 目前全部 locale 未定义（store 已引用），必须与 reimbursement 其余文案一并补齐 20 locale，否则界面显示裸 key（parity 检查脚本发现不了缺 key，需人工核对）。

---

### Task 6: ReimbursementView 组件 + 归档页视图切换

**Files:**
- Create: `src/renderer/src/pages/documents/ReimbursementView.vue`
- Modify: `src/renderer/src/pages/documents/DocumentsArchivePage.vue:24`
- Test: `test/renderer/components/ReimbursementView.test.ts`

- [ ] **Step 6.1: 组件测试（先写）**

`test/renderer/components/ReimbursementView.test.ts`（参照既有组件测试 mock i18n 与 store 的方式）：

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ReimbursementView from '@/pages/documents/ReimbursementView.vue'
import { useDocumentsStore } from '@/stores/documents'

const mountView = () =>
  mount(ReimbursementView, { global: { plugins: [createPinia()] } })

describe('ReimbursementView', () => {
  it('renders category list and groups from store tree', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    store.reimbursementTree = {
      tree: [
        {
          category: { id: 'cat-a', name: '会议费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 1 },
          total: 1,
          materials: [],
          groups: [{ person: '张三', buckets: [{ period: '2026-09', documents: [{ id: 'd1', typeKey: 'meeting_minutes', templateName: '会议纪要', person: '张三', period: '2026-09', amount: 100, amountUncertain: false, uncertainCount: 0, fileNames: ['a.pdf'], isOverride: false }] }] }]
        }
      ],
      unassigned: [],
      summary: [{ categoryId: 'cat-a', total: 1 }]
    }
    const wrapper = mountView()
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('a.pdf')
  })
})
```

（store 直接赋值时需确保字段可写：reimbursementTree 为 ref，测试中 `store.reimbursementTree = ...` 可行。）

- [ ] **Step 6.2: 创建 `ReimbursementView.vue`**

结构（复用 DocumentsArchivePage.vue 的 UI 原语导入——DcBadge 等 import 行照抄该文件）：

```vue
<template>
  <div class="flex h-full min-h-0" data-testid="reimbursement-view">
    <aside class="w-56 shrink-0 overflow-y-auto border-r p-3">
      <button
        v-for="node in store.reimbursementTree?.tree ?? []"
        :key="node.category.id"
        class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === node.category.id }"
        :data-testid="`reimbursement-category-${node.category.id}`"
        @click="selectedCategoryId = node.category.id"
      >
        <span class="truncate">{{ node.category.name }}</span>
        <DcBadge variant="outline" class="ml-2">{{ node.total }}</DcBadge>
      </button>
      <button
        class="mt-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === null }"
        data-testid="reimbursement-category-unassigned"
        @click="selectedCategoryId = null"
      >
        <span>{{ t('settings.documents.reimbursement.unassigned') }}</span>
        <DcBadge variant="outline" class="ml-2">{{ unassignedTotal }}</DcBadge>
      </button>
      <div class="mt-3 border-t pt-3">
        <button class="w-full rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted" @click="goConfig">
          {{ t('settings.documents.reimbursement.manageCategories') }}
        </button>
      </div>
    </aside>
    <section class="min-w-0 flex-1 overflow-y-auto p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-medium">{{ selectedName }}</h2>
        <button class="rounded border px-3 py-1.5 text-sm hover:bg-muted" data-testid="reimbursement-export" @click="onExport">
          {{ t('settings.documents.reimbursement.export') }}
        </button>
      </div>

      <details v-if="selectedMaterials.length" class="mb-3 rounded border p-2 text-sm">
        <summary class="cursor-pointer">{{ t('settings.documents.reimbursement.materialsTitle') }}</summary>
        <ul class="mt-2 space-y-1">
          <li v-for="material in selectedMaterials" :key="material.name" class="flex items-center justify-between">
            <span>{{ material.name }}</span>
            <DcBadge v-if="material.linkedTypeKeys.length" variant="outline">
              {{ t('settings.documents.reimbursement.materialCount', { count: material.count }) }}
            </DcBadge>
          </li>
        </ul>
      </details>

      <div v-for="group in selectedGroups" :key="group.person ?? '__unknown__'" class="mb-5">
        <h3 class="mb-2 text-sm font-medium">
          {{ group.person ?? t('settings.documents.reimbursement.unknownPerson') }}
        </h3>
        <div v-for="bucket in group.buckets" :key="bucket.period ?? '__unknown_period__'" class="mb-3">
          <div class="mb-1 text-xs text-muted-foreground">{{ bucket.period ?? t('settings.documents.reimbursement.unknownPeriod') }}</div>
          <div v-for="entry in bucket.documents" :key="entry.id" class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm" :data-testid="`reimbursement-entry-${entry.id}`">
            <span class="w-40 shrink-0 truncate">{{ entry.templateName }}</span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ entry.fileNames.join('、') }}</span>
            <span v-if="entry.amount !== null" class="shrink-0 tabular-nums" :class="{ 'text-amber-600': entry.amountUncertain }">
              ¥{{ entry.amount }}
            </span>
            <select
              class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
              :value="entry.isOverride ? '__override__' : '__auto__'"
              @change="onMove(entry.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="__auto__">{{ t('settings.documents.reimbursement.autoCategory') }}</option>
              <option value="__unassigned__">{{ t('settings.documents.reimbursement.forceUnassigned') }}</option>
              <option v-for="node in store.reimbursementTree?.tree ?? []" :key="node.category.id" :value="node.category.id">
                {{ node.category.name }}
              </option>
            </select>
          </div>
        </div>
      </div>
      <p v-if="!selectedGroups.length" class="py-10 text-center text-sm text-muted-foreground">
        {{ t('settings.documents.reimbursement.empty') }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore } from '@/stores/documents'
import { DcBadge } from '@/components/ui/badge'
import type { ReimbursementDocumentEntry } from '@shared/contracts/routes'

const { t } = useI18n()
const router = useRouter()
const store = useDocumentsStore()

const selectedCategoryId = ref<string | null>(null)

onMounted(() => {
  void store.loadReimbursementTree()
})

const selectedNode = computed(
  () => store.reimbursementTree?.tree.find((node) => node.category.id === selectedCategoryId.value) ?? null
)
const selectedName = computed(() => selectedNode.value?.category.name ?? t('settings.documents.reimbursement.unassigned'))
const selectedGroups = computed(() =>
  selectedCategoryId.value === null
    ? (store.reimbursementTree?.unassigned ?? [])
    : (selectedNode.value?.groups ?? [])
)
const selectedMaterials = computed(() => selectedNode.value?.materials ?? [])
const unassignedTotal = computed(
  () => (store.reimbursementTree?.unassigned ?? []).reduce((sum, group) => sum + group.buckets.reduce((s, b) => s + b.documents.length, 0), 0)
)

function onMove(documentId: string, value: string) {
  if (value === '__auto__') {
    void store.setReimbursementOverride(documentId, null)
    return
  }
  void store.setReimbursementOverride(documentId, value === '__unassigned__' ? 'unassigned' : value)
}

function goConfig() {
  void router.push({ name: 'settings', params: { routeName: 'settings-documents-reimbursement' } })
}

async function onExport() {
  const result = await store.exportReimbursementPackage()
  if (!result.canceled) {
    // 提示导出完成（沿用应用内消息机制；如项目用 toast 组件，则替换为 toast）
    window.alert(
      t('settings.documents.reimbursement.exportDone', { count: result.exportedFiles ?? 0, path: result.path ?? '' })
    )
  }
}
</script>
```

（`DcBadge` 导入路径以 DocumentsArchivePage.vue 实际导入为准；路由跳转参数以应用 settings 路由实际形态为准——若 settings 为独立窗口路由，参照 TemplateEditorPage 的跳转方式。）

- [ ] **Step 6.3: DocumentsArchivePage 视图切换**

1. `<script setup>` 加 `const viewMode = ref<'documents' | 'reimbursement'>('documents')`（`ref` 已导入）。
2. 在 line 24 `<div ... data-testid="archive-tabs">` 之前插入切换条：

```vue
    <div class="flex items-center gap-1 border-b px-6 py-2" data-testid="archive-view-switch">
      <button
        :variant="viewMode === 'documents' ? 'default' : 'ghost'"
        class="rounded px-3 py-1.5 text-sm"
        data-testid="archive-view-documents"
        @click="viewMode = 'documents'"
      >
        {{ t('settings.documents.reimbursement.viewDocuments') }}
      </button>
      <button
        :variant="viewMode === 'reimbursement' ? 'default' : 'ghost'"
        class="rounded px-3 py-1.5 text-sm"
        data-testid="archive-view-reimbursement"
        @click="viewMode = 'reimbursement'"
      >
        {{ t('settings.documents.reimbursement.viewReimbursement') }}
      </button>
    </div>
```

3. 用 `v-if="viewMode === 'documents'"` 包住既有 tabs 行、筛选行与表格区（保持单据视图原逻辑不变），其后加：

```vue
    <ReimbursementView v-else class="min-h-0 flex-1" />
```

并导入 `import ReimbursementView from './ReimbursementView.vue'`。

- [ ] **Step 6.4: 运行组件测试**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts`
Expected: PASS

- [ ] **Step 6.5: Commit**

```bash
git add src/renderer/src/pages/documents/ReimbursementView.vue src/renderer/src/pages/documents/DocumentsArchivePage.vue test/renderer/components/ReimbursementView.test.ts
git commit -m "feat(documents): reimbursement archive view"
```

---

### Task 7: 设置页 ReimbursementConfigPage + 导航注册

**Files:**
- Create: `src/renderer/settings/components/documents/ReimbursementConfigPage.vue`
- Modify: `src/shared/contracts/routes/system.routes.ts:29`（SettingsRouteNameSchema 加 `'settings-documents-reimbursement'`）
- Modify: `src/shared/settingsNavigation.ts:27`（类型联合）+ `:157`（导航项后插入）
- Modify: `src/renderer/settings/settingsRouteComponents.ts:26`

- [ ] **Step 7.1: 三处注册**

1. `system.routes.ts` SettingsRouteNameSchema 数组末尾加 `'settings-documents-reimbursement'`。
2. `settingsNavigation.ts` 类型联合（line 27 附近）加 `| 'settings-documents-reimbursement'`；`settings-documents-models` 导航项后插入：

```ts
  {
    routeName: 'settings-documents-reimbursement',
    path: '/documents-reimbursement',
    titleKey: 'routes.settings-documents-reimbursement',
    icon: 'lucide:folder-tree',
    position: 3.56,
    groupKey: 'models',
    keywords: ['documents', 'reimbursement', '报销', '类别', '分类']
  },
```

3. `settingsRouteComponents.ts` 加：

```ts
  'settings-documents-reimbursement': () => import('./components/documents/ReimbursementConfigPage.vue')
```

- [ ] **Step 7.2: 创建 ReimbursementConfigPage.vue**

页面骨架参照 `TemplateEditorPage.vue`（`useRoute/useRouter/useI18n` + onMounted 加载）。核心结构：

```vue
<template>
  <div class="mx-auto w-full max-w-3xl p-6" data-testid="reimbursement-config-page">
    <h1 class="mb-4 text-lg font-medium">{{ t('settings.documents.reimbursement.configTitle') }}</h1>

    <section class="mb-6 rounded-lg border p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-medium">{{ t('settings.documents.reimbursement.categoriesTitle') }}</h2>
        <button class="rounded border px-2 py-1 text-sm hover:bg-muted" data-testid="reimbursement-add-category" @click="addCategory">
          {{ t('settings.documents.reimbursement.addCategory') }}
        </button>
      </div>
      <div v-for="(category, index) in draft.categories" :key="category.id" class="mb-3 rounded border p-3">
        <div class="mb-2 flex items-center gap-2">
          <input v-model="category.name" class="w-48 rounded border px-2 py-1 text-sm" data-testid="reimbursement-category-name" />
          <button class="text-sm text-muted-foreground hover:text-foreground" :disabled="index === 0" @click="moveCategory(index, -1)">↑</button>
          <button class="text-sm text-muted-foreground hover:text-foreground" :disabled="index === draft.categories.length - 1" @click="moveCategory(index, 1)">↓</button>
          <button class="text-sm text-destructive hover:underline" @click="removeCategory(index)">
            {{ t('settings.documents.reimbursement.remove') }}
          </button>
        </div>
        <label class="block text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.linkedTypeKeys') }}</label>
        <input v-model="linkedText(category)" class="mt-1 w-full rounded border px-2 py-1 text-sm" data-testid="reimbursement-category-linked" />
        <label class="mt-2 block text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.materials') }}</label>
        <div v-for="(material, mIndex) in category.requiredMaterials" :key="mIndex" class="mt-1 flex items-center gap-2">
          <input v-model="material.name" class="flex-1 rounded border px-2 py-1 text-sm" />
          <input v-model="linkedText(material)" class="flex-1 rounded border px-2 py-1 text-sm" :placeholder="t('settings.documents.reimbursement.materialLinkedPlaceholder')" />
          <button class="text-sm text-destructive hover:underline" @click="category.requiredMaterials.splice(mIndex, 1)">×</button>
        </div>
        <button class="mt-1 text-xs text-muted-foreground hover:underline" @click="category.requiredMaterials.push({ name: '', linkedTypeKeys: [] })">
          + {{ t('settings.documents.reimbursement.addMaterial') }}
        </button>
      </div>
    </section>

    <section class="mb-6 rounded-lg border p-4">
      <h2 class="mb-3 text-sm font-medium">{{ t('settings.documents.reimbursement.globalTitle') }}</h2>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label class="block text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.personFieldKeys') }}</label>
          <input v-model="chipsText(draft.personFieldKeys)" class="mt-1 w-full rounded border px-2 py-1 text-sm" />
        </div>
        <div>
          <label class="block text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.dateFieldKeys') }}</label>
          <input v-model="chipsText(draft.dateFieldKeys)" class="mt-1 w-full rounded border px-2 py-1 text-sm" />
        </div>
        <div>
          <label class="block text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.amountFieldKeys') }}</label>
          <input v-model="chipsText(draft.amountFieldKeys)" class="mt-1 w-full rounded border px-2 py-1 text-sm" />
        </div>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <label class="text-xs text-muted-foreground">{{ t('settings.documents.reimbursement.dateGrouping') }}</label>
        <select v-model="draft.dateGrouping" class="rounded border px-2 py-1 text-sm" data-testid="reimbursement-date-grouping">
          <option value="month">{{ t('settings.documents.reimbursement.groupByMonth') }}</option>
          <option value="day">{{ t('settings.documents.reimbursement.groupByDay') }}</option>
        </select>
      </div>
    </section>

    <p v-if="validationError" class="mb-3 text-sm text-destructive" data-testid="reimbursement-config-error">{{ validationError }}</p>
    <div class="flex justify-end gap-2">
      <button class="rounded border px-4 py-1.5 text-sm hover:bg-muted" @click="resetDraft">{{ t('settings.documents.reimbursement.reset') }}</button>
      <button class="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="reimbursement-config-save" :disabled="!!validationError" @click="save">
        {{ t('settings.documents.reimbursement.save') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore } from '@/stores/documents'
import type { ReimbursementConfig } from '@shared/contracts/routes'

const { t } = useI18n()
const store = useDocumentsStore()
const draft = reactive<ReimbursementConfig>({
  version: 1,
  categories: [],
  personFieldKeys: [],
  dateFieldKeys: [],
  amountFieldKeys: [],
  dateGrouping: 'month'
})

onMounted(async () => {
  const config = store.reimbursementConfig ?? (await store.loadReimbursementConfig())
  Object.assign(draft, structuredClone(config))
})

function resetDraft() {
  void store.loadReimbursementConfig().then((config) => Object.assign(draft, structuredClone(config)))
}

function addCategory() {
  draft.categories.push({
    id: `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    requiredMaterials: [],
    linkedTypeKeys: [],
    sortOrder: draft.categories.length + 1
  })
}

function removeCategory(index: number) {
  draft.categories.splice(index, 1)
  draft.categories.forEach((category, i) => (category.sortOrder = i + 1))
}

function moveCategory(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= draft.categories.length) return
  const [moved] = draft.categories.splice(index, 1)
  draft.categories.splice(target, 0, moved)
  draft.categories.forEach((category, i) => (category.sortOrder = i + 1))
}

function linkedText(target: { linkedTypeKeys: string[] }) {
  return computed({
    get: () => target.linkedTypeKeys.join(','),
    set: (value: string) => {
      target.linkedTypeKeys = value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
    }
  }).value
}

function chipsText(target: string[]) {
  return computed({
    get: () => target.join(','),
    set: (value: string) => {
      target.splice(0, target.length, ...value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean))
    }
  }).value
}

const validationError = computed(() => {
  const names = draft.categories.map((category) => category.name.trim())
  if (names.some((name) => !name)) return t('settings.documents.reimbursement.errorNameRequired')
  if (new Set(names).size !== names.length) return t('settings.documents.reimbursement.errorNameDuplicate')
  if (draft.categories.some((category) => category.requiredMaterials.some((material) => !material.name.trim())))
    return t('settings.documents.reimbursement.errorMaterialName')
  return null
})

async function save() {
  if (validationError.value) return
  draft.categories.forEach((category, index) => (category.sortOrder = index + 1))
  await store.saveReimbursementConfig(structuredClone(draft))
}
</script>
```

（`linkedText`/`chipsText` 用 computed-in-function 的写法在模板中可用；若 lint 报 non-idiomatic，改为每类别本地组件或 `v-model` 直接绑定 join/split watch —— 实现者可等价改写，保持行为：逗号/空格分隔、去空。）

- [ ] **Step 7.3: 类型检查**

Run: `pnpm typecheck`
Expected: PASS（若 settings 路由类型联合有联动报错，按报错文件补齐）

- [ ] **Step 7.4: Commit**

```bash
git add src/renderer/settings/components/documents/ReimbursementConfigPage.vue src/shared/contracts/routes/system.routes.ts src/shared/settingsNavigation.ts src/renderer/settings/settingsRouteComponents.ts
git commit -m "feat(documents): reimbursement config settings page"
```

---

### Task 8: i18n（20 locale）+ 渲染端回归

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/documents.json` ×20（locale：zh-CN zh-TW zh-HK en-US ja-JP ko-KR fr-FR de-DE es-ES pt-BR ru-RU it-IT pl-PL tr-TR vi-VN ms-MY id-ID he-IL fa-IR da-DK）
- Modify: `src/renderer/src/i18n/<locale>/routes.json` ×20

- [ ] **Step 8.1: documents.json 加 `settings.documents.reimbursement.*` 键**

zh-CN 基准（其余 locale 按译文表翻译，结构一致）：

```json
"reimbursement": {
  "viewDocuments": "单据视图",
  "viewReimbursement": "报销整理",
  "unassigned": "未分类",
  "manageCategories": "管理类别",
  "export": "导出整理包",
  "exportDone": "导出完成：{count} 个文件，{path}",
  "materialsTitle": "所需材料对照",
  "materialCount": "已有 {count} 份",
  "unknownPerson": "未知人员",
  "unknownPeriod": "未知期间",
  "autoCategory": "自动归类",
  "forceUnassigned": "强制未分类",
  "empty": "该类别下暂无单据记录",
  "loadFailed": "报销整理数据加载失败",
  "configTitle": "报销类别配置",
  "categoriesTitle": "报销类别",
  "addCategory": "新增类别",
  "remove": "删除",
  "linkedTypeKeys": "自动归类模板 type_key（逗号分隔）",
  "materials": "所需材料清单",
  "addMaterial": "新增材料",
  "materialLinkedPlaceholder": "关联模板 type_key（可选，逗号分隔）",
  "globalTitle": "字段映射与分组",
  "personFieldKeys": "人员字段 key",
  "dateFieldKeys": "日期字段 key",
  "amountFieldKeys": "金额字段 key",
  "dateGrouping": "日期分组粒度",
  "groupByMonth": "按月",
  "groupByDay": "按天",
  "reset": "重置",
  "save": "保存",
  "errorNameRequired": "类别名称不能为空",
  "errorNameDuplicate": "类别名称不能重复",
  "errorMaterialName": "材料名称不能为空"
}
```

各 locale 译文：en-US（Documents View / Reimbursement View / Unclassified / Manage categories / Export package / Exported {count} files to {path} / Required materials / {count} collected / Unknown person / Unknown period / Auto / Force unclassified / No records in this category / Failed to load / Reimbursement categories / Categories / Add category / Delete / Auto-classify template type_keys (comma separated) / Required materials / Add material / Linked type_keys (optional) / Field mapping & grouping / Person field keys / Date field keys / Amount field keys / Date grouping / By month / By day / Reset / Save / Category name is required / Category names must be unique / Material name is required）；zh-TW/zh-HK 用繁体对应；其余 16 locale 按语义翻译（机器翻译初稿 + 人工可读即可，与既有 locale 文件风格一致）。

- [ ] **Step 8.2: routes.json 加 `"settings-documents-reimbursement"`**

zh-CN：`"报销类别配置"`；en-US：`"Reimbursement Categories"`；其余 locale 对应翻译。

- [ ] **Step 8.3: i18n 校验**

Run: `pnpm check:i18n`
Expected: PASS（若脚本名不同，用 `pnpm run` 查看实际 i18n 校验脚本名后运行）

- [ ] **Step 8.4: 渲染端相关测试回归**

Run: `pnpm exec vitest run test/renderer/stores test/renderer/components`
Expected: PASS（如遇 tinypool 段错误为资源型 flake，按更小批次重跑）

- [ ] **Step 8.5: Commit**

```bash
git add src/renderer/src/i18n
git commit -m "feat(documents): reimbursement i18n locales"
```

---

### Task 9: 全量回归与收尾

- [ ] **Step 9.1: 格式与静态检查**

Run: `pnpm format && pnpm lint && pnpm typecheck`
Expected: 全部通过（若 lint 报既有文件问题，仅修复本次触碰的文件）

- [ ] **Step 9.2: 主进程测试回归**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`
Expected: PASS

- [ ] **Step 9.3: 主进程全量对比（防 P4 式回归）**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main --config vitest.config.ts`
Expected: 失败集合与既有 ~98 个环境性失败基线一致（对比失败文件清单，确认无本次触碰区域的新失败）

- [ ] **Step 9.4: spec 修正同步**

spec 中导出路由输入为 `directory`（实现为主进程弹目录选择框，与 `documentsExportCsvRoute` 模式一致）、报销类别数为 28（CSV 去重后实际数量）——更新 `docs/superpowers/specs/2026-10-09-reimbursement-classification-design.md` 对应两处并与实现一致。

- [ ] **Step 9.5: Commit**

```bash
git add -A
git commit -m "chore(documents): reimbursement regression fixes"
```

---

## Self-Review 记录

1. **Spec 覆盖**：配置 KV+惰性 seed（Task 3）、表加列迁移（Task 2）、归类优先级/字段映射/分组树（Task 3）、5 条 IPC 路由（Task 1/4）、导出整理包+汇总 CSV（Task 4）、归档页视图+手动调整+材料统计（Task 6）、设置配置页（Task 7）、i18n 20 locale（Task 8）、测试策略（各 Task TDD + Task 9 回归）——全覆盖。
2. **占位符**：无 TBD；两处「以实际文件为准」的说明均为精确定位指引而非功能占位。
3. **类型一致性**：`ReimbursementConfig`/`Reimburseme