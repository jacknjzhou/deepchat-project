# 报销整理自定义分组（细分项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「报销整理」视图中支持每个报销类别下用户自定义分组（细分项）：条目行内可选所属分组，已分组条目从 人员→年月 列表移出、改在「自定义分组」区域按 分组名→年月 展示，导出整理包体现分组层级。

**Architecture:** 自定义分组定义挂在报销配置的每个 category 上（`customGroups` 字段，随 `documents.reimbursement.setConfig` 持久化）；条目级分组指派是新的一维覆盖，落库为 documents 表新列 `reimbursement_group_override`（repairableColumns 幂等补列，沿用 v51 `reimbursement_override` 先例）。主进程 `buildReimbursementTree` 把已分组条目从 person→period 分组拆出，按 分组→年月 聚合进类别节点的 `customGroups` 字段；视图渲染两部分，导出按同类层级写目录并在汇总 CSV 增加「分组」列。

**Tech Stack:** Electron/Vue3/TS、zod 契约路由、better-sqlite3-multiple-ciphers、Vitest。

---

## 需求与决策记录（来自用户简略图 + 三个确认答案）

1. **分组管理入口在视图**：右侧内容区提供「添加分组」按钮，为左侧当前选中类别添加自定义分组；支持重命名、删除。分组定义属于报销配置（按类别）。
2. **条目行内下拉始终显示**：选中某类别时，该类别下条目行始终渲染分组下拉（含「未分组」项）；类别未定义分组时下拉禁用并提示先添加分组。「未分类」视图无所属类别，不渲染分组下拉。
3. **展示层级**：已分组条目在「自定义分组」区域按 分组名 → 年月 展示（跨人员合并），不再出现在上方 人员→年月 列表（`不再单独显示`）。
4. **导出体现分组**（用户选择）：已分组条目目录为 `类别/分组名/年月/文件`；未分组条目维持 `类别/人员/年月/文件`；未分类不变。汇总 CSV 固定中文表头新增「分组」列（分组名为空串表示未分组），人员列照常记录条目人员。
5. **语义规则**：
   - `reimbursement_group_override = null` 表示未分组；
   - 条目分组 id 不在当前所属类别的 `customGroups` 中（陈旧/分组已删/类别已换）→ 视为未分组（防御性降级）；
   - 调整类别（`setOverride`）时清空该条目的分组覆盖（分组从属于旧类别）；
   - 删除分组不回写条目（陈旧 id 自然降级为未分组），不做级联清理。

## 文件结构总览

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/shared/documents.ts` | 修改 | DocumentRecord 增加 `reimbursementGroupOverride` |
| `src/shared/contracts/routes/documents.routes.ts` | 修改 | 分组 schema、entry/node schema 扩展、新路由契约 |
| `src/shared/contracts/routes.ts` | 修改 | 路由注册表登记新路由 |
| `src/main/documents/data/tables/documents.ts` | 修改 | 建表 SQL、行类型、`setReimbursementGroupOverride`、setOverride 联动清空 |
| `src/main/data/schemaCatalog.ts` | 修改 | repairableColumns 补列 |
| `src/main/documents/repository.ts` | 修改 | 行映射 + repository 方法 |
| `src/main/documents/reimbursement.ts` | 修改 | entry.groupId、分组拆分聚合、导出类型 |
| `src/main/documents/reimbursementExport.ts` | 修改 | 分组目录 + CSV「分组」列 |
| `src/main/documents/routes.ts` | 修改 | `documents.reimbursement.setGroupOverride` handler |
| `src/renderer/api/DocumentsClient.ts` | 修改 | client 方法 |
| `src/renderer/src/stores/documents.ts` | 修改 | store action |
| `src/renderer/src/pages/documents/ReimbursementEntryRow.vue` | 新建 | 条目行纯展示组件（两种列表区共用） |
| `src/renderer/src/pages/documents/ReimbursementView.vue` | 修改 | 添加/重命名/删除分组、自定义分组区、行内下拉接入 |
| `src/renderer/src/i18n/*/settings.json`（20 locale） | 修改 | reimbursement 块新增 13 键 |
| `test/main/documents/documentsTableMigration.test.ts` | 修改 | 新列断言 |
| `test/main/documents/reimbursement.spec.ts` | 修改 | 树构建分组拆分用例 |
| `test/main/documents/reimbursementExport.spec.ts` | 修改 | 目录/CSV 断言更新 |
| `test/renderer/stores/documentsReimbursementStore.test.ts` | 修改 | setGroupOverride 链路 |
| `test/renderer/components/ReimbursementView.test.ts` | 修改 | 视图行为用例 |
| `test/renderer/components/ReimbursementEntryRow.test.ts` | 新建 | 行组件用例 |

> 运行 main 进程 sqlite 相关测试的既定方式（环境依赖，勿用裸 vitest）：
> `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`
> 提交信息用 Conventional Commits（≤50 字符）；代码风格 oxfmt（单引号、无分号、100 列）。

---

### Task 1: 共享契约 + 持久层（分组定义、补列、repository）

**Files:**
- Modify: `src/shared/documents.ts:63`（DocumentRecord）
- Modify: `src/shared/contracts/routes/documents.routes.ts:320-437`
- Modify: `src/shared/contracts/routes.ts:844-851`
- Modify: `src/main/documents/data/tables/documents.ts:14,70,204-212`
- Modify: `src/main/data/schemaCatalog.ts:404-410`
- Modify: `src/main/documents/repository.ts:113-126,260-265`
- Modify: `test/main/documents/documentsTableMigration.test.ts`

- [ ] **Step 1: 写迁移测试（失败先行）**

在 `test/main/documents/documentsTableMigration.test.ts` 仿照现有 `reimbursement_override` 用例新增（保持同构断言风格）：

```ts
it('adds reimbursement_group_override column', () => {
  const columns = (
    db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
  ).map((c) => c.name)
  expect(columns).toContain('reimbursement_group_override')
})
```

- [ ] **Step 2: 运行验证失败**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTableMigration.test.ts --config vitest.config.ts
```

预期：新用例 FAIL（列不存在），其余 PASS。注意 test/setup.ts 全局 mock 了 fs/path，该文件若已有 `vi.unmock` 头则沿用，勿新增改动。

- [ ] **Step 3: 契约 schema 扩展（documents.routes.ts）**

`reimbursementCategorySchema` 上方新增，并给 category 增加 `customGroups` 字段（`.default([])` 保证存量业务配置 JSON 无该字段时可解析——zod input 可缺省、output 恒为数组）：

```ts
export const reimbursementCustomGroupSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(50),
  sortOrder: z.number().int().nonnegative()
})

export const reimbursementCategorySchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(50),
    requiredMaterials: z.array(reimbursementMaterialSchema).max(50),
    linkedTypeKeys: z.array(reimbursementTypeKeySchema).max(50),
    customGroups: z.array(reimbursementCustomGroupSchema).max(50).default([]),
    sortOrder: z.number().int().nonnegative()
  })
  .refine((category) => category.id !== REIMBURSEMENT_UNASSIGNED, {
    message: "category id 'unassigned' is reserved"
  })
  .refine(
    (category) => {
      const ids = category.customGroups.map((group) => group.id)
      return new Set(ids).size === ids.length
    },
    { message: 'duplicate custom group id' }
  )
```

`reimbursementDocumentEntrySchema` 增加 `groupId: z.string().min(1).nullable()`（条目当前归属的自定义分组，未分组为 null）。

`reimbursementCategoryNodeSchema` 增加：

```ts
customGroups: z.array(
  z.object({
    group: reimbursementCustomGroupSchema,
    buckets: z.array(reimbursementBucketSchema)
  })
)
```

`documentsReimbursementSetOverrideRoute` 之后新增路由契约（output 与 setOverride 同构）：

```ts
export const documentsReimbursementSetGroupOverrideRoute = defineRouteContract({
  name: 'documents.reimbursement.setGroupOverride',
  input: z.object({
    documentId: z.string().min(1),
    // 自定义分组 id | null（清除分组，条目回到 人员→年月 列表）
    groupId: z.string().min(1).nullable()
  }),
  output: z.object({ document: documentRecordSchema.nullable() })
})
```

在 `src/shared/contracts/routes.ts` 路由注册表（`documentsReimbursementSetOverrideRoute` 行后）追加：

```ts
[documentsReimbursementSetGroupOverrideRoute.name]: documentsReimbursementSetGroupOverrideRoute,
```

并同步补该 route 的 import。

- [ ] **Step 4: DocumentRecord 与行映射**

`src/shared/documents.ts` `DocumentRecord`（`reimbursementOverride` 后）增加：

```ts
reimbursementGroupOverride: string | null
```

`src/main/documents/data/tables/documents.ts`：
- `DocumentRow` 接口（`reimbursement_override` 后）增加 `reimbursement_group_override: string | null`
- `getCreateTableSQL()` 建表语句 `reimbursement_override TEXT,` 后加一行 `reimbursement_group_override TEXT,`
- `setReimbursementOverride`（204-212 行）的 UPDATE 改为同时清空分组（调整类别 = 分组从属于旧类别，必须复位）：

```ts
this.db
  .prepare(
    'UPDATE documents SET reimbursement_override = ?, reimbursement_group_override = NULL, updated_at = ? WHERE id = ?'
  )
  .run(value, now, id)
```

（保留该方法原有的取回/返回行为；若现实现为 UPDATE 后 `this.get(id)`，保持一致。）
- 新增表方法（紧随其后，同风格）：

```ts
setReimbursementGroupOverride(id: string, groupId: string | null): DocumentRow | undefined {
  const now = Date.now()
  this.db
    .prepare('UPDATE documents SET reimbursement_group_override = ?, updated_at = ? WHERE id = ?')
    .run(groupId, now, id)
  return this.get(id)
}
```

`src/main/data/schemaCatalog.ts` documents 表 `repairableColumns` 增加补列（幂等修复，沿用 v51 先例）：

```ts
reimbursement_group_override: 'ALTER TABLE documents ADD COLUMN reimbursement_group_override TEXT;'
```

`src/main/documents/repository.ts`：
- `toRecord`（`reimbursementOverride` 行后）增加 `reimbursementGroupOverride: row.reimbursement_group_override ?? null,`
- `setReimbursementOverride` 方法后新增（镜像现有委托风格）：

```ts
setReimbursementGroupOverride(id: string, groupId: string | null): DocumentRecord | undefined {
  const row = this.database.documentsTable.setReimbursementGroupOverride(id, groupId)
  return row ? toRecord(row) : undefined
}
```

- [ ] **Step 5: 运行迁移测试通过 + 相关 main 套件无回归**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsTableMigration.test.ts --config vitest.config.ts
```

预期：全部 PASS。再跑 `pnpm run typecheck` 确认 schema 改动没有破坏现有类型（`ReimbursementConfig` 消费方在 output 侧获得必填 `customGroups`，input 侧可缺省）。

- [ ] **Step 6: 回归保护——配置往返与 setOverride 联动**

在 `test/renderer/settings/documents/ReimbursementConfigPage.test.ts` 增加用例：加载带 `customGroups` 的配置 → 保存 → 断言 `saveReimbursementConfig` 收到的 payload 中对应 category 仍带原 `customGroups`（配置页 416-419 行是 `...category` 展开，天然保留，此测试防回归）。

在 `test/main/documents/documentsTableMigration.test.ts`（或同目录既有仓储级行为测试文件；若无则在本文件用真实内存库补一条）增加联动断言：

```ts
it('setReimbursementOverride clears group override', () => {
  // 插入文档 → setReimbursementGroupOverride(id, 'grp-a') → 断言行值 'grp-a'
  // → setReimbursementOverride(id, 'cat-other') → 断言 reimbursement_group_override 为 null
})
```

兼容性说明：`customGroups` 使用 `.default([])`，存量业务配置 JSON 与 `presetReimbursementConfig.json`（28 类别）均无需手工补字段——zod 解析时缺省自动补空数组。

- [ ] **Step 7: 提交**

```powershell
git add src/shared/documents.ts src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes.ts src/main/documents/data/tables/documents.ts src/main/data/schemaCatalog.ts src/main/documents/repository.ts test/main/documents/documentsTableMigration.test.ts test/renderer/settings/documents/ReimbursementConfigPage.test.ts
git commit -m "feat(documents): custom group schema and storage"
```

---

### Task 2: 树构建分组拆分 + 导出分组层级

**Files:**
- Modify: `src/main/documents/reimbursement.ts:109-248`
- Modify: `src/main/documents/reimbursementExport.ts:30,93-160`
- Modify: `test/main/documents/reimbursement.spec.ts`
- Modify: `test/main/documents/reimbursementExport.spec.ts`

- [ ] **Step 1: 写 buildReimbursementTree 分组拆分测试（失败先行）**

在 `test/main/documents/reimbursement.spec.ts` 的 `buildReimbursementTree` describe 内新增（fixture 风格沿用现有 `doc({...})` 助手；类别配置含 `customGroups`，文档用 `reimbursementGroupOverride` 指派）：

```ts
it('splits group-assigned entries into category customGroups by period', () => {
  const config = baseConfig([
    {
      id: 'cat-meeting',
      name: '会议费',
      linkedTypeKeys: ['meeting_minutes'],
      customGroups: [
        { id: 'grp-a', name: '分组一', sortOrder: 0 },
        { id: 'grp-b', name: '分组二', sortOrder: 1 }
      ]
    }
  ])
  const grouped = doc({
    typeKey: 'meeting_minutes',
    reimbursementOverride: 'cat-meeting',
    reimbursementGroupOverride: 'grp-a',
    fields: { meeting_date: { value: '2026-04-01', uncertain: false } }
  })
  const ungrouped = doc({
    typeKey: 'meeting_minutes',
    reimbursementOverride: 'cat-meeting',
    fields: { meeting_date: { value: '2026-03-01', uncertain: false } }
  })
  const stale = doc({
    typeKey: 'meeting_minutes',
    reimbursementOverride: 'cat-meeting',
    reimbursementGroupOverride: 'grp-gone',
    fields: { meeting_date: { value: '2026-03-02', uncertain: false } }
  })
  const result = buildReimbursementTree([grouped, ungrouped, stale], config, new Map())
  const node = result.tree[0]
  expect(node.total).toBe(3)
  expect(node.customGroups[0].group.id).toBe('grp-a')
  expect(node.customGroups[0].buckets[0].documents.map((d) => d.id)).toEqual([grouped.id])
  expect(node.customGroups[1].buckets).toEqual([])
  // 未分组 + 陈旧分组 id 一律留在 人员→年月 列表
  const normalDocs = node.groups.flatMap((g) => g.buckets.flatMap((b) => b.documents.map((d) => d.id)))
  expect(normalDocs).toEqual(expect.arrayContaining([ungrouped.id, stale.id]))
  expect(normalDocs).not.toContain(grouped.id)
})
```

（`baseConfig`/`doc` 助手若与现有签名不符，以现有文件内助手为准扩展：需支持注入 `customGroups` 与 `reimbursementGroupOverride`。）

- [ ] **Step 2: 运行验证失败**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts --config vitest.config.ts
```

预期：新用例 FAIL（`customGroups` 不存在/未拆分）。

- [ ] **Step 3: 实现 reimbursement.ts**

类型（`ReimbursementCategoryNode` 前）：

```ts
export interface ReimbursementCustomGroupNode {
  group: ReimbursementConfig['categories'][number]['customGroups'][number]
  buckets: ReimbursementBucket[]
}
```

`ReimbursementDocumentEntry` 增加 `groupId: string | null`；`ReimbursementCategoryNode` 增加 `customGroups: ReimbursementCustomGroupNode[]`；`toEntry` 增加末参 `groupId: string | null` 并写入返回值。

从 `groupByPersonAndPeriod` 中抽出按年月聚合（period 倒序、null 置底），两处共用：

```ts
function groupByPeriod(entries: ReimbursementDocumentEntry[]): ReimbursementBucket[] {
  const byPeriod = new Map<string | null, ReimbursementDocumentEntry[]>()
  for (const entry of entries) {
    const bucket = byPeriod.get(entry.period) ?? []
    bucket.push(entry)
    byPeriod.set(entry.period, bucket)
  }
  return [...byPeriod.entries()]
    .map(([period, docs]) => ({ period, documents: docs }))
    .sort((a, b) => {
      if (a.period === null) return 1
      if (b.period === null) return -1
      return b.period.localeCompare(a.period)
    })
}
```

`groupByPersonAndPeriod` 内部改用 `groupByPeriod`（行为不变）。

`buildReimbursementTree` 改造（关键：分组 id 按 类别→分组 两级 Map 存放，防止不同类别下同名分组 id 串桶；`total`/`materials` 仍统计该类别全部条目）：

```ts
const unassignedEntries: ReimbursementDocumentEntry[] = []
const entriesByCategory = new Map<string, ReimbursementDocumentEntry[]>()
const groupedByCategory = new Map<string, Map<string, ReimbursementDocumentEntry[]>>()
const summary = new Map<string | null, number>()

for (const document of documents) {
  const { categoryId, isOverride } = resolveDocumentCategoryId(document, config)
  const category =
    categoryId === null
      ? null
      : (config.categories.find((candidate) => candidate.id === categoryId) ?? null)
  const requestedGroup = document.reimbursementGroupOverride
  const groupId =
    category && requestedGroup && category.customGroups.some((group) => group.id === requestedGroup)
      ? requestedGroup
      : null
  const entry = toEntry(document, config, templateNameById, isOverride, groupId)
  summary.set(categoryId, (summary.get(categoryId) ?? 0) + 1)
  if (categoryId === null) {
    unassignedEntries.push(entry)
    continue
  }
  const list = entriesByCategory.get(categoryId) ?? []
  list.push(entry)
  entriesByCategory.set(categoryId, list)
  if (groupId !== null) {
    const byGroup = groupedByCategory.get(categoryId) ?? new Map()
    const groupList = byGroup.get(groupId) ?? []
    groupList.push(entry)
    byGroup.set(groupId, groupList)
    groupedByCategory.set(categoryId, byGroup)
  }
}

const tree: ReimbursementCategoryNode[] = config.categories.map((category) => {
  const allEntries = entriesByCategory.get(category.id) ?? []
  const normalEntries = allEntries.filter((entry) => entry.groupId === null)
  const groupEntries = groupedByCategory.get(category.id)
  return {
    category,
    total: allEntries.length,
    materials: category.requiredMaterials.map((material) => ({
      name: material.name,
      linkedTypeKeys: material.linkedTypeKeys,
      count: allEntries.filter((entry) => material.linkedTypeKeys.includes(entry.typeKey)).length
    })),
    customGroups: category.customGroups.map((group) => ({
      group,
      buckets: groupByPeriod(groupEntries?.get(group.id) ?? [])
    })),
    groups: groupByPersonAndPeriod(normalEntries)
  }
})
```

- [ ] **Step 4: 运行 reimbursement.spec.ts 通过**

同 Step 2 命令，预期全部 PASS（含既有用例——既有 fixture 无 `customGroups` 时 zod default 兜底为 `[]`，行为不变）。

- [ ] **Step 5: 更新导出测试（失败先行）**

（导出测试文件以 `test/main/documents/` 下实际存在的导出测试为准，命名可能为 `.spec.ts` 或 `.test.ts`。）

在导出测试文件：
- 更新现有断言：`CSV_HEADER` 变为 9 列（新增「分组」），普通行分组列为空串；
- 新增用例：类别节点含 `customGroups`（分组内条目跨人员）时，目录为 `类别/分组名/年月/文件`，且 CSV 行 `分组=分组名、人员=条目人员`。

- [ ] **Step 6: 实现 reimbursementExport.ts**

`CSV_HEADER` 改为：

```ts
const CSV_HEADER = '类别,分组,人员,期间,单据模板,文件名,金额,金额存疑,手动指定'
```

`writeGroup` 重构为按「子目录名 + 桶列表 + 分组名」写入（普通分组与自定义分组共用；CSV 第 2 列为分组名，普通分组传空串；人员列取条目自身人员）：

```ts
const writeEntries = async (
  categoryName: string,
  subDirName: string,
  buckets: ReimbursementTreeResult['tree'][number]['customGroups'][number]['buckets'],
  groupName: string
) => {
  for (const bucket of buckets) {
    const periodDirName = sanitizeDirName(bucket.period ?? UNKNOWN_PERIOD)
    const targetDir = path.join(packageDir, categoryName, subDirName, periodDirName)
    await deps.mkdir(targetDir, { recursive: true })
    for (const entry of bucket.documents) {
      const personCell = entry.person ?? UNKNOWN_PERSON
      const files = filesById.get(entry.id) ?? []
      for (let index = 0; index < entry.fileNames.length; index += 1) {
        const source = files[index]
        const originalName = entry.fileNames[index]
        if (!source) {
          issues.push(`缺失:${originalName}`)
          rows.push([categoryName, groupName, personCell, periodDirName, entry.templateName, `缺失:${originalName}`, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
          continue
        }
        const fileName = await uniqueFileName(targetDir, originalName, deps)
        try {
          await deps.copyFile(source, path.join(targetDir, fileName))
          exportedFiles += 1
          rows.push([categoryName, groupName, personCell, periodDirName, entry.templateName, fileName, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
        } catch {
          issues.push(`复制失败:${originalName}`)
          rows.push([categoryName, groupName, personCell, periodDirName, entry.templateName, `缺失:${originalName}`, entry.amount ?? '', entry.amountUncertain ? '是' : '否', entry.isOverride ? '是' : '否'])
        }
      }
    }
  }
}
```

调用处（先普通分组、后自定义分组，与视图顺序一致；未分类不变）：

```ts
for (const node of result.tree) {
  const categoryName = sanitizeDirName(node.category.name)
  for (const group of node.groups) {
    await writeEntries(categoryName, sanitizeDirName(group.person ?? UNKNOWN_PERSON), group.buckets, '')
  }
  for (const customGroup of node.customGroups) {
    await writeEntries(categoryName, sanitizeDirName(customGroup.group.name), customGroup.buckets, customGroup.group.name)
  }
}
for (const group of result.unassigned) {
  await writeEntries(sanitizeDirName('未分类'), sanitizeDirName(group.person ?? UNKNOWN_PERSON), group.buckets, '')
}
```

- [ ] **Step 7: 运行导出与树构建套件通过**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts test/main/documents/reimbursementExport.spec.ts --config vitest.config.ts
```

预期：全部 PASS。

- [ ] **Step 8: 提交**

```powershell
git add src/main/documents/reimbursement.ts src/main/documents/reimbursementExport.ts test/main/documents/reimbursement.spec.ts test/main/documents/reimbursementExport.spec.ts
git commit -m "feat(documents): group-aware reimbursement tree and export"
```

---

### Task 3: IPC 路由 + Client + store（setGroupOverride 链路）

**Files:**
- Modify: `src/main/documents/routes.ts:20,377-396`
- Modify: `src/renderer/api/DocumentsClient.ts:110-111`
- Modify: `src/renderer/src/stores/documents.ts:393-400,448`
- Modify: `test/renderer/stores/documentsReimbursementStore.test.ts`

- [ ] **Step 1: 写 store 测试（失败先行）**

在 `test/renderer/stores/documentsReimbursementStore.test.ts` 仿照现有 `setReimbursementOverride` 用例：

```ts
it('setReimbursementGroupOverride invokes client and reloads tree', async () => {
  const { store, client } = setup() // 沿用该文件现有装配方式
  await store.setReimbursementGroupOverride('doc-1', 'grp-a')
  expect(client.reimbursementSetGroupOverride).toHaveBeenCalledWith('doc-1', 'grp-a')
  expect(client.reimbursementTree).toHaveBeenCalledTimes(2) // 初始 + 重载
})

it('setReimbursementGroupOverride(null) clears grouping', async () => {
  const { store, client } = setup()
  await store.setReimbursementGroupOverride('doc-1', null)
  expect(client.reimbursementSetGroupOverride).toHaveBeenCalledWith('doc-1', null)
})
```

- [ ] **Step 2: 运行验证失败**

```powershell
pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts
```

预期：FAIL（action 不存在）。

- [ ] **Step 3: main 路由 handler（routes.ts）**

import 区（第 20 行附近的 route 导入清单）加入 `documentsReimbursementSetGroupOverrideRoute`；在 `documentsReimbursementSetOverrideRoute` handler 数组项之后插入：

```ts
[
  documentsReimbursementSetGroupOverrideRoute.name,
  async (rawInput) => {
    const input = documentsReimbursementSetGroupOverrideRoute.input.parse(rawInput)
    const store = requireConfigStore()
    // fail-fast：陈旧 groupId 静默降级为未分组会丢失用户意图，与 categoryUnknown 同理
    if (input.groupId !== null) {
      const config = readReimbursementConfig(store)
      const known = config.categories.some((category) =>
        category.customGroups.some((group) => group.id === input.groupId)
      )
      if (!known) {
        throw new Error(`[documents.reimbursement.groupUnknown:${input.groupId}]`)
      }
    }
    return documentsReimbursementSetGroupOverrideRoute.output.parse({
      document: repository.setReimbursementGroupOverride(input.documentId, input.groupId) ?? null
    })
  }
],
```

- [ ] **Step 4: Client 与 store**

`DocumentsClient.ts` 在 `reimbursementSetOverride` 后：

```ts
reimbursementSetGroupOverride: (documentId: string, groupId: string | null) =>
  invokeRoute(bridge, documentsReimbursementSetGroupOverrideRoute.name, { documentId, groupId }),
```

（同步补 route import。）

`stores/documents.ts` 在 `setReimbursementOverride` 后：

```ts
async function setReimbursementGroupOverride(
  documentId: string,
  groupId: string | null,
  client: DocumentsClient = defaultClient
) {
  await client.reimbursementSetGroupOverride(documentId, groupId)
  await loadReimbursementTree(client)
}
```

并加入 store 返回对象（`setReimbursementOverride` 旁）。

- [ ] **Step 5: 运行 store 套件 + typecheck**

```powershell
pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts
pnpm run typecheck
```

预期：PASS / 无类型错误。

- [ ] **Step 6: 提交**

```powershell
git add src/main/documents/routes.ts src/renderer/api/DocumentsClient.ts src/renderer/src/stores/documents.ts test/renderer/stores/documentsReimbursementStore.test.ts
git commit -m "feat(documents): setGroupOverride ipc and store"
```

---

### Task 4: 视图（行组件抽取 + 分组管理 + 自定义分组区）

**Files:**
- Create: `src/renderer/src/pages/documents/ReimbursementEntryRow.vue`
- Create: `test/renderer/components/ReimbursementEntryRow.test.ts`
- Modify: `src/renderer/src/pages/documents/ReimbursementView.vue`
- Modify: `test/renderer/components/ReimbursementView.test.ts`

- [ ] **Step 1: 写 ReimbursementEntryRow 测试（失败先行）**

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ReimbursementEntryRow from '@/pages/documents/ReimbursementEntryRow.vue'

const entry = {
  id: 'd1',
  typeKey: 'meeting_minutes',
  templateName: '会议纪要',
  person: 'XXX',
  period: '2026-03',
  amount: 1083.88,
  amountUncertain: false,
  uncertainCount: 0,
  fileNames: ['a.pdf'],
  isOverride: true,
  groupId: null
} as never

const groups = [
  { id: 'grp-a', name: '分组一', sortOrder: 0 },
  { id: 'grp-b', name: '分组二', sortOrder: 1 }
]

// 注：测试环境 vue-i18n 被全局 mock（t 返回 key 本身），断言用 key 字符串而非中文文案。

describe('ReimbursementEntryRow', () => {
  it('renders group select with groups and current value', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry: { ...entry, groupId: 'grp-a' }, groups, categories: [], showGroupSelect: true }
    })
    const select = wrapper.find('[data-testid="reimbursement-group-d1"]')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('grp-a')
    expect(select.findAll('option').length).toBe(3) // 未分组 + 2 分组
  })

  it('disables group select when category has no groups', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups: [], categories: [], showGroupSelect: true }
    })
    expect((wrapper.find('[data-testid="reimbursement-group-d1"]').element as HTMLSelectElement).disabled).toBe(true)
  })

  it('hides group select for unassigned view', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups: [], categories: [], showGroupSelect: false }
    })
    expect(wrapper.find('[data-testid="reimbursement-group-d1"]').exists()).toBe(false)
  })

  it('emits moveGroup with null for __none__', async () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups, categories: [], showGroupSelect: true }
    })
    await wrapper.find('[data-testid="reimbursement-group-d1"]').setValue('__none__')
    expect(wrapper.emitted('moveGroup')?.at(-1)?.[0]).toBe('d1')
    expect(wrapper.emitted('moveGroup')?.at(-1)?.[1]).toBe('__none__')
  })
})
```

- [ ] **Step 2: 运行验证失败**

```powershell
pnpm exec vitest run test/renderer/components/ReimbursementEntryRow.test.ts
```

预期：FAIL（组件不存在）。

- [ ] **Step 3: 新建 ReimbursementEntryRow.vue**

（模板迁移自 View 现有条目行 84-126 行，插入分组下拉于金额之前；分类下拉逻辑原样保留，options 改由 `categories` prop 提供。）

```vue
<template>
  <div
    class="flex items-center gap-2 rounded border px-2 py-1.5 text-sm"
    :data-testid="`reimbursement-entry-${entry.id}`"
  >
    <span class="w-40 shrink-0 truncate">{{ entry.templateName }}</span>
    <span class="min-w-0 flex-1 truncate text-muted-foreground">
      {{ entry.fileNames.join('、') }}
    </span>
    <select
      v-if="showGroupSelect"
      class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
      :value="entry.groupId ?? '__none__'"
      :disabled="groups.length === 0"
      :title="groups.length === 0 ? t('settings.documents.reimbursement.noGroupsHint') : undefined"
      :data-testid="`reimbursement-group-${entry.id}`"
      @change="emit('moveGroup', entry.id, ($event.target as HTMLSelectElement).value)"
    >
      <option value="__none__">{{ t('settings.documents.reimbursement.groupNone') }}</option>
      <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
    </select>
    <span
      v-if="entry.amount !== null"
      class="shrink-0 tabular-nums"
      :class="{ 'text-amber-600': entry.amountUncertain }"
    >
      ¥{{ entry.amount }}
    </span>
    <select
      class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
      :value="entry.isOverride ? (categoryId ?? '__unassigned__') : '__auto__'"
      @change="emit('move', entry.id, ($event.target as HTMLSelectElement).value)"
    >
      <option value="__auto__">{{ t('settings.documents.reimbursement.autoCategory') }}</option>
      <option value="__unassigned__">
        {{ t('settings.documents.reimbursement.forceUnassigned') }}
      </option>
      <option v-for="node in categories" :key="node.category.id" :value="node.category.id">
        {{ node.category.name }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ReimbursementTreeResult } from '@shared/contracts/routes'

type Entry = ReimbursementTreeResult['tree'][number]['groups'][number]['buckets'][number]['documents'][number]
type CategoryNode = ReimbursementTreeResult['tree'][number]

defineProps<{
  entry: Entry
  groups: CategoryNode['category']['customGroups']
  categories: CategoryNode[]
  categoryId: string | null
  showGroupSelect: boolean
}>()

const emit = defineEmits<{
  move: [documentId: string, value: string]
  moveGroup: [documentId: string, value: string]
}>()

const { t } = useI18n()
</script>
```

注意：`categoryId` prop——原行内分类 select 用 `selectedCategoryId` 作为 override 值回显；已作为 prop `categoryId: string | null` 传入（上方 props 已含），View 传当前选中类别。

- [ ] **Step 4: 运行行组件测试通过**

```powershell
pnpm exec vitest run test/renderer/components/ReimbursementEntryRow.test.ts
```

- [ ] **Step 5: 写 View 行为测试（失败先行）**

在 `test/renderer/components/ReimbursementView.test.ts`（沿用现有 mock 装配：`vi.mock('pinia')`、ConfigClient hoisted mock、RecycleScroller 无关可忽略；i18n 断言用 key 字符串）。新增用例：

```ts
it('renders group select on entries and moves to custom group section', async () => {
  // tree fixture：category 带 customGroups=[grp-a]，一个条目 groupId='grp-a'，一个 groupId=null
  // 断言：
  // 1) 人员→年月区不含已分组条目：'[data-testid="reimbursement-entry-d-grouped"]' 不在 person 区
  // 2) 自定义分组区存在：'[data-testid="reimbursement-custom-group-grp-a"]'
  // 3) 分组区内条目行存在：reimbursement-custom-group-grp-a 内 '[data-testid="reimbursement-entry-d-grouped"]'
  // 4) 行内分组下拉存在且未分组条目下拉值 '__none__'
})

it('add group saves config with appended customGroup', async () => {
  // store mock: reimbursementConfig 返回带目标类别的配置
  // click '[data-testid="reimbursement-add-group"]' → 填 '[data-testid="reimbursement-new-group-name"]' → click confirm
  // 断言 saveReimbursementConfig 被调用且 categories 中该类别 customGroups 追加了一项（id 以 'grp-' 前缀、name 为输入值）
})

it('delete group removes it from config', async () => {
  // click '[data-testid="reimbursement-group-delete-grp-a"]'
  // 断言 saveReimbursementConfig payload 中该类别 customGroups 不含 grp-a
})

it('moveGroup action wires entry select to setReimbursementGroupOverride', async () => {
  // setValue '[data-testid="reimbursement-group-d2"]' = 'grp-a'
  // 断言 store.setReimbursementGroupOverride 被调用 ('d2', 'grp-a')
})

it('unassigned view hides group select', async () => {
  // selectUnassigned 后断言无 '[data-testid^="reimbursement-group-"]'
})
```

（按现有文件 fixture 风格补全 tree 数据；树 fixture 的 category 需含 `customGroups` 字段与 groups/customGroups 分开的条目分布。）

- [ ] **Step 6: 实现 ReimbursementView.vue 改造**

script 增补：

```ts
import ReimbursementEntryRow from './ReimbursementEntryRow.vue'
import type { ReimbursementConfig } from '@shared/contracts/routes'

const showGroupForm = ref(false)
const newGroupName = ref('')
const editingGroupId = ref<string | null>(null)
const editingGroupName = ref('')

const selectedCustomGroups = computed(() => selectedNode.value?.customGroups ?? [])
const selectedCategoryGroups = computed(() => selectedNode.value?.category.customGroups ?? [])

onMounted(() => {
  void store.loadReimbursementConfig() // 分组 CRUD 需要；与既有 onMounted（树加载 + 首选类别）合并，勿注册两个钩子
})

async function updateSelectedCategory(
  mutate: (category: ReimbursementConfig['categories'][number]) => ReimbursementConfig['categories'][number]
) {
  const config = store.reimbursementConfig ?? (await store.loadReimbursementConfig())
  if (!config || selectedCategoryId.value === null) return
  try {
    await store.saveReimbursementConfig({
      ...config,
      categories: config.categories.map((category) =>
        category.id === selectedCategoryId.value ? mutate(category) : category
      )
    })
    await store.loadReimbursementTree()
  } catch (error) {
    console.error('[ReimbursementView] update custom groups failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.groupSaveFailed',
      t('settings.documents.reimbursement.groupSaveFailed')
    )
  }
}

async function addGroup() {
  const name = newGroupName.value.trim()
  if (!name || selectedCategoryId.value === null) return
  await updateSelectedCategory((category) => ({
    ...category,
    customGroups: [
      ...category.customGroups,
      { id: `grp-${crypto.randomUUID().slice(0, 8)}`, name, sortOrder: category.customGroups.length }
    ]
  }))
  newGroupName.value = ''
  showGroupForm.value = false
}

function startRename(groupId: string, name: string) {
  editingGroupId.value = groupId
  editingGroupName.value = name
}

async function confirmRename() {
  const groupId = editingGroupId.value
  const name = editingGroupName.value.trim()
  if (!groupId || !name) return
  await updateSelectedCategory((category) => ({
    ...category,
    customGroups: category.customGroups.map((group) => (group.id === groupId ? { ...group, name } : group))
  }))
  editingGroupId.value = null
}

async function removeGroup(groupId: string) {
  await updateSelectedCategory((category) => ({
    ...category,
    customGroups: category.customGroups.filter((group) => group.id !== groupId)
  }))
}

function onMoveGroup(documentId: string, value: string) {
  const groupId = value === '__none__' ? null : value
  void store.setReimbursementGroupOverride(documentId, groupId).catch((error: unknown) => {
    console.error('[ReimbursementView] set group override failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.moveGroupFailed',
      t('settings.documents.reimbursement.moveGroupFailed')
    )
  })
}

function groupEntryCount(node: { buckets: Array<{ documents: unknown[] }> }) {
  return node.buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0)
}
```

模板改动：
1. 标题行（`selectedName` 旁，仅 `selectedCategoryId !== null` 时）加：

```html
<DcButton
  v-if="selectedCategoryId !== null"
  variant="outline"
  size="sm"
  data-testid="reimbursement-add-group"
  @click="showGroupForm = !showGroupForm"
>
  {{ t('settings.documents.reimbursement.addGroup') }}
</DcButton>
```

及其内联表单（标题行下方，`v-if="showGroupForm"`）：

```html
<div v-if="showGroupForm" class="mb-3 flex items-center gap-2">
  <input
    v-model="newGroupName"
    class="w-48 rounded border px-2 py-1 text-sm"
    :placeholder="t('settings.documents.reimbursement.groupNamePlaceholder')"
    data-testid="reimbursement-new-group-name"
    @keydown.enter="addGroup"
  />
  <DcButton size="sm" data-testid="reimbursement-add-group-confirm" @click="addGroup">
    {{ t('settings.documents.reimbursement.confirm') }}
  </DcButton>
  <DcButton size="sm" variant="outline" @click="showGroupForm = false">
    {{ t('settings.documents.reimbursement.cancel') }}
  </DcButton>
</div>
```

2. 原 84-126 行条目行整体替换为组件（人员→年月区）：

```html
<ReimbursementEntryRow
  v-for="entry in bucket.documents"
  :key="entry.id"
  :entry="entry"
  :groups="selectedCategoryGroups"
  :categories="store.reimbursementTree?.tree ?? []"
  :category-id="selectedCategoryId"
  :show-group-select="selectedCategoryId !== null"
  @move="onMove"
  @move-group="onMoveGroup"
/>
```

3. 空态条件（129 行）改为 `v-if="!selectedGroups.length && !selectedCustomGroups.some((node) => node.buckets.length)"`（分组区有条目时不再显示大空态）。
4. section 末尾（空态 p 之后）新增自定义分组区：

```html
<div v-if="selectedCategoryId !== null" class="mt-6 border-t pt-4">
  <h3 class="mb-3 text-sm font-medium">
    {{ t('settings.documents.reimbursement.customGroupsTitle') }}
  </h3>
  <p v-if="!selectedCustomGroups.length" class="text-xs text-muted-foreground">
    {{ t('settings.documents.reimbursement.customGroupsEmpty') }}
  </p>
  <div
    v-for="node in selectedCustomGroups"
    :key="node.group.id"
    class="mb-4 rounded border p-3"
    :data-testid="`reimbursement-custom-group-${node.group.id}`"
  >
    <div class="mb-2 flex items-center justify-between gap-2">
      <template v-if="editingGroupId === node.group.id">
        <input
          v-model="editingGroupName"
          class="w-48 rounded border px-2 py-1 text-sm"
          data-testid="reimbursement-group-name-input"
          @keydown.enter="confirmRename"
        />
        <DcButton size="sm" @click="confirmRename">
          {{ t('settings.documents.reimbursement.confirm') }}
        </DcButton>
        <DcButton size="sm" variant="outline" @click="editingGroupId = null">
          {{ t('settings.documents.reimbursement.cancel') }}
        </DcButton>
      </template>
      <template v-else>
        <span class="flex items-center gap-2 text-sm font-medium">
          {{ node.group.name }}
          <DcBadge variant="outline">{{ groupEntryCount(node) }}</DcBadge>
        </span>
        <div class="flex gap-1">
          <DcButton
            size="sm"
            variant="outline"
            :data-testid="`reimbursement-group-rename-${node.group.id}`"
            @click="startRename(node.group.id, node.group.name)"
          >
            {{ t('settings.documents.reimbursement.renameGroup') }}
          </DcButton>
          <DcButton
            size="sm"
            variant="outline"
            :data-testid="`reimbursement-group-delete-${node.group.id}`"
            @click="removeGroup(node.group.id)"
          >
            {{ t('settings.documents.reimbursement.deleteGroup') }}
          </DcButton>
        </div>
      </template>
    </div>
    <div v-for="bucket in node.buckets" :key="bucket.period ?? '__unknown__'" class="mb-3">
      <div class="mb-1 text-xs text-muted-foreground">
        {{ bucket.period ?? t('settings.documents.reimbursement.unknownPeriod') }}
      </div>
      <ReimbursementEntryRow
        v-for="entry in bucket.documents"
        :key="entry.id"
        :entry="entry"
        :groups="selectedCategoryGroups"
        :categories="store.reimbursementTree?.tree ?? []"
        :category-id="selectedCategoryId"
        :show-group-select="true"
        @move="onMove"
        @move-group="onMoveGroup"
      />
    </div>
    <p v-if="!node.buckets.length" class="text-xs text-muted-foreground">
      {{ t('settings.documents.reimbursement.groupEmpty') }}
    </p>
  </div>
</div>
```

- [ ] **Step 7: 运行 View 与行组件测试**

```powershell
pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts test/renderer/components/ReimbursementEntryRow.test.ts test/renderer/pages/documents/
```

预期：全部 PASS（既有 6 例如因行结构替换需微调选择器，保持断言语义不变）。

- [ ] **Step 8: 提交**

```powershell
git add src/renderer/src/pages/documents/ReimbursementEntryRow.vue src/renderer/src/pages/documents/ReimbursementView.vue test/renderer/components/ReimbursementEntryRow.test.ts test/renderer/components/ReimbursementView.test.ts
git commit -m "feat(documents): custom groups in reimbursement view"
```

---

### Task 5: i18n（20 locale）+ 全量回归

**Files:**
- Modify: `src/renderer/src/i18n/{da-DK,de-DE,en-US,es-ES,fa-IR,fr-FR,he-IL,id-ID,it-IT,ja-JP,ko-KR,ms-MY,pl-PL,pt-BR,ru-RU,tr-TR,vi-VN,zh-CN,zh-HK,zh-TW}/settings.json`

- [ ] **Step 1: 20 locale 在 `settings.documents.reimbursement` 块 `retry` 键后插入 13 键**

zh-CN 基准（其余 locale 语义对齐；en-US 参考现有术语「分组」→ group）：

```json
"addGroup": "添加分组",
"groupNamePlaceholder": "输入分组名称",
"confirm": "确认",
"cancel": "取消",
"renameGroup": "重命名",
"deleteGroup": "删除",
"customGroupsTitle": "自定义分组",
"customGroupsEmpty": "尚未添加自定义分组",
"groupEmpty": "该分组暂无条目",
"groupNone": "未分组",
"noGroupsHint": "请先添加自定义分组",
"moveGroupFailed": "分组调整失败",
"groupSaveFailed": "分组保存失败"
```

- [ ] **Step 2: 校验与回归**

```powershell
pnpm run i18n
pnpm run typecheck
pnpm exec oxfmt
pnpm exec oxlint
pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts test/renderer/components/ReimbursementEntryRow.test.ts test/renderer/pages/documents/ test/renderer/settings/documents/ test/renderer/stores/documents
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/reimbursement.spec.ts test/main/documents/reimbursementExport.spec.ts test/main/documents/documentsTableMigration.test.ts --config vitest.config.ts
```

预期：全部通过、无格式 diff。

- [ ] **Step 3: 提交**

```powershell
git add src/renderer/src/i18n
git commit -m "feat(documents): custom groups i18n locales"
```

---

## As-built 记录

（执行后回填：提交链、计划偏差、遗留问题。）
