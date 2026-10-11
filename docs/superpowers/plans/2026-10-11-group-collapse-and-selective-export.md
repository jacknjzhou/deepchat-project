# 自定义分组折叠 + 按勾选分组导出实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 报销整理视图「自定义分组」区域支持按分组**折叠/展开（默认折叠）**；导出整理包支持**勾选分组**——仅导出当前选中类别下被勾选分组中的条目（未分组与未分类条目不导出）。

**Architecture:** 折叠与勾选为纯视图状态（ReimbursementView 本地 ref，切类别重置）。导出过滤采用**路由层树过滤**：`documents.reimbursement.export` 输入扩展可选 `categoryId + groupIds`，主进程校验后把 `buildReimbursementTree` 结果过滤为「仅该类别的勾选分组条目」（清空 person→period 组与 unassigned），`exportReimbursementPackage` 写包函数**零改动**（它只写树里有的内容），目录结构与 CSV 格式自然复用。

**Tech Stack:** Electron/Vue3/TS、zod 契约、Vitest。

---

## 需求与决策记录（用户需求 + 三个确认答案）

1. **默认折叠**（用户确认）：自定义分组区各分组默认收起，仅显示标题行（分组名 + 条目数徽标 + 操作按钮），点击展开/收起；状态为视图本地状态。
2. **仅当前类别勾选**（用户确认）：勾选框只出现在当前选中类别的自定义分组区各分组标题行；切换类别时勾选与展开状态重置。
3. **仅导出勾选分组的条目**（用户确认）：勾选存在时导出包**只含**勾选分组下的条目（目录 `类别/分组名/年月/文件` + 汇总 CSV 仅对应行）；未分组（人员→年月区）与未分类条目**不导出**。
4. **单导出按钮语义**：无勾选 → 现行全量导出（行为不变）；有勾选 → 仅导出勾选分组（按钮旁显示勾选计数徽标以明示模式）。
5. **契约校验 fail-fast**（沿用 setGroupOverride 先例）：`categoryId` 不存在 → `[documents.reimbursement.categoryUnknown:<id>]`；任一 `groupIds` 不在该类别的 `customGroups` 中 → `[documents.reimbursement.groupUnknown:<id>]`（注意：是**类别内**校验，比 setGroupOverride 的全局校验更强，避免跨类别同 id 误命中）。
6. **过滤位置**：路由层过滤树（route 拿到 treeResult 后收窄），`exportReimbursementPackage` 不改——普通组/自定义组/unassigned 分别清空即得到「仅勾选分组」输出；status/dateFrom/dateTo 过滤照常叠加。
7. **范围外**：报销类别配置页、分组 CRUD、CSV 表头（固定中文 9 列不变）、树构建逻辑均不改动。

## 文件结构总览

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/shared/contracts/routes/documents.routes.ts` | 修改 | export 输入扩展可选 `categoryId` + `groupIds`（两者必须同时出现，refine 校验） |
| `src/main/documents/routes.ts` | 修改 | export handler：fail-fast 校验 + 按勾选过滤树 |
| `src/renderer/src/api/documentTasks.ts`（client 所在文件，先确认） | 修改 | `reimbursementExport` 入参透传新字段 |
| `src/renderer/src/stores/documents.ts` | 修改 | `exportReimbursementPackage` 增加可选 `{ categoryId, groupIds }` 参数 |
| `src/renderer/src/pages/documents/ReimbursementView.vue` | 修改 | 分组折叠（默认折叠）+ 勾选框 + 导出联动 + 切类别重置 |
| `test/main/documents/documentsRoutes.test.ts` | 修改 | 导出过滤 + fail-fast 测试 |
| `test/renderer/pages/documents/ReimbursementView.test.ts` | 修改 | 折叠/勾选/导出参数测试 |
| `test/renderer/stores/documentsReimbursementStore.test.ts` | 修改 | action 透传测试 |
| `src/renderer/src/i18n/*/settings.json`（20 locale） | 修改 | 3 个新键 |

## UI 布局（BEFORE / AFTER）

自定义分组区（当前选中类别）：

```
BEFORE:                              AFTER:
┌ 自定义分组 ────────────────────┐    ┌ 自定义分组 ────────────────────────────┐
│ ┌ 差旅费 [3] [重命名] [删除] ┐ │    │ ┌ ☐ ▸ 差旅费 [3] [重命名] [删除] ┐      │
│ │ 2026-09                    │ │    │ └────────────────────────────────┘      │
│ │  ・张三 发票.pdf  ¥120      │ │    │ ┌ ☐ ▸ 招待费 [2] ...            ┐      │
│ │  ・李四 ...                │ │    │ └────────────────────────────────┘      │
│ └────────────────────────────┘ │    │ （默认全部收起；点 ▸ 展开条目）          │
│ ┌ 招待费 [2] ...              │ │    │ [导出整理包 (2)]  ← 勾选时显示计数徽标   │
└────────────────────────────────┘    └─────────────────────────────────────────┘
```

导出目录（勾选模式）：`报销整理-<时间戳>/差旅费/2026-09/…`、`…/招待费/…`（无 人员 目录、无未分组/未分类目录）；CSV 仅勾选分组行。

## i18n 新键（20 locale 全量）

| 键 | zh-CN | 用途 |
| --- | --- | --- |
| `settings.documents.reimbursement.expandGroup` | 展开分组 | 折叠切换 aria-label（展开态） |
| `settings.documents.reimbursement.collapseGroup` | 收起分组 | 折叠切换 aria-label（收起态） |
| `settings.documents.reimbursement.selectGroupForExport` | 勾选以导出该分组 | 勾选框 aria-label |

---

## Task 1: 契约扩展 + 路由层导出过滤

- [ ] `documents.routes.ts`：`documentsReimbursementExportRoute.input` 增加可选 `categoryId: z.string().min(1).max(64).optional()` 与 `groupIds: z.array(z.string().min(1).max(64)).max(50).optional()`；`.refine` 两者必须同时出现（都缺省 = 全量导出，兼容现状）
- [ ] `routes.ts` export handler：有勾选参数时——
  1. fail-fast：categoryId 必须存在于 config.categories；每个 groupIds 必须存在于**该类别**的 customGroups（错误码沿用 `[documents.reimbursement.categoryUnknown:<id>]` / `[documents.reimbursement.groupUnknown:<id>]`）
  2. 校验通过后过滤 `treeResult`：`tree` 收窄为该类别一个节点，节点 `groups: []`、`customGroups` 仅保留 group.id ∈ groupIds 的项、`unassigned: []`；`summary` 同步收窄（仅该类别）或整体置空——以 exportReimbursementPackage 实际消费面为准（先读其实现确认 summary 是否被消费，未被消费则不动）
  3. `exportReimbursementPackage` 本体**零改动**
- [ ] 测试 `documentsRoutes.test.ts`（导出 describe 扩展）：勾选导出仅写勾选分组目录与 CSV 行（未分组/未分类/其他类别不出现）、未知 categoryId fail-fast、未知 groupId（类别内校验，含「分组 id 属于其他类别」的用例）fail-fast、无勾选参数全量导出回归、showOpenDialog 取消不受影响

## Task 2: store 透传 + 视图折叠/勾选/导出联动

- [ ] `stores/documents.ts`：`exportReimbursementPackage(selection?: { categoryId: string; groupIds: string[] }, client?)` — selection 存在时并入 IPC 入参，status/date 过滤照旧
- [ ] client 入参类型随契约自动扩展（确认 client 方法签名来源，必要时同步）
- [ ] `ReimbursementView.vue`：
  - 折叠：`expandedGroupIds = ref(new Set<string>())`，分组标题行加切换按钮（chevron 图标，aria-label 用 expandGroup/collapseGroup，testid `reimbursement-group-toggle-<id>`）；buckets 区域 `v-show`/`v-if` 受控；**默认全部收起**
  - 勾选：`checkedGroupIds = ref(new Set<string>())`，分组标题行加 checkbox（aria-label selectGroupForExport，testid `reimbursement-group-check-<id>`）
  - 切换类别时两个 Set 清空（在现有选中类别 watch/handler 中重置）
  - 导出联动：`onExport` 按 `checkedGroupIds.size > 0` 传 `{ categoryId: 当前类别 id, groupIds: [...checked] }`，否则不传（全量）；导出按钮在有勾选时显示计数徽标（如 `导出整理包 (2)`，无新 i18n 键，仅数字）
  - 分组被删除时同步清理两个 Set 中的该 id（removeGroup 成功回调处）
- [ ] 测试：`ReimbursementView.test.ts`（默认折叠不渲染条目、点击展开/收起、切类别重置、勾选/取消、有勾选时导出调用参数含 categoryId+groupIds、无勾选时不传、分组删除后勾选清理、导出按钮计数徽标）；`documentsReimbursementStore.test.ts`（selection 透传、缺省不传）

## Task 3: i18n（20 locale）+ 回归收尾

- [ ] 3 个新键补齐 20 个 locale（术语对齐各 locale reimbursement 命名空间既有译法）
- [ ] 定点回归：`pnpm exec vitest run test/main/documents/documentsRoutes.test.ts`（需 `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`）+ `pnpm exec vitest run test/renderer/pages/documents/ReimbursementView.test.ts test/renderer/stores/documentsReimbursementStore.test.ts`
- [ ] `pnpm run i18n`；`pnpm run i18n:en`；`pnpm run typecheck`；`pnpm run format:check`；`pnpm run lint`
- [ ] 提交遵循 Conventional Commits（≤50 字符）；PR 附上方 BEFORE/AFTER ASCII

## 验证命令备注

- 主进程 sqlite 套件：`$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`
- 渲染层：`pnpm exec vitest run <files>`；PowerShell 5 无 `&&`/`tail`
- Edit 工具损坏先例：每次编辑后 `git diff` 核验完整性

---

## As-built（2026-10-11 交付记录）

### 提交链（基点 77949cac）
| Commit | 内容 |
| --- | --- |
| `2cf621df` | 契约：export input 增加可选 `categoryId` + `groupIds`（`.min(1).max(50)`），refine 成对出现 |
| `5a42849c` | 路由：fail-fast（config 提前到弹框前读取，类别内 groupId 校验）+ 树非 mutate 收窄 + 5 测试用例 |
| `7b46ad9f` | store：`exportReimbursementPackage(selection?, client?)` 条件透传 + 2 测试用例 |
| `b7fecb47` | 视图：折叠（默认收起）/勾选/导出联动、切类别重置、删组清理 + zh-CN/en-US 3 键 + 测试 |
| `ba6cfd18` | i18n 4 键 × 20 locale 补全 + 2 个 Minor a11y 修复 |

### 与计划的偏差
1. **client 零改动**：client 实际为 `src/renderer/api/DocumentsClient.ts`，入参类型由契约 `z.input` 推导，契约扩展后自动兼容，计划中的 `documentTasks.ts` 候选不适用。
2. **视图测试路径**：实际为 `test/renderer/components/ReimbursementView.test.ts`（非计划所写 pages/documents 下）。
3. **i18n 新键 3→4**：新增 `exportWithCount`（Task 2 质量审查 Minor：导出按钮计数由硬拼接 `${base} (${n})` 改为 i18n 插值 `导出 ({count})` / `Export ({count})`，20 locale 全量）。
4. **折叠按钮 a11y**：chevron 按钮去掉覆盖可见分组名的固定 aria-label，改用 `:aria-expanded` 标准 disclosure 模式；checkbox aria-label 拼接分组名。
5. 其余（契约约束、fail-fast 错误码、树收窄、store 签名、折叠/勾选交互）与计划一致。

### 审查记录（Subagent-Driven）
- Task 1：spec 审查 ✅（refine 语义、fail-fast 时序、不 mutate、零范围蔓延）；质量审查 Approve（Minor：冗余空值判断可接受、魔法数注释、测试容错断言——均不阻塞）
- Task 2：spec 审查 ✅（默认折叠、条件传参键不存在序列化、切类别重置）；质量审查 Approve（Minor ①aria ②计数拼接→已并入 Task 3 修复；③removeGroup 去重→跳过）
- Task 3 + 整体终审：**Ready to merge**（Task 3 符合规格；端到端数据流/约束闭环核对通过）

### 验证结果
- 主进程 `documentsRoutes.test.ts`：51/51（electron + ELECTRON_RUN_AS_NODE）
- 渲染层：ReimbursementView + store 37/37；`test/renderer/pages` 18 文件全过；`test/renderer/components` 162/163（唯一失败 ModelProviderSettings 12 例为基线既有，与功能零关联）
- `i18n:validate`：20 locales / 4760 契约通过；`typecheck:web`、`typecheck:node`、`format:check`、`lint` 全过
- 非阻塞遗留：`src/types/i18n.d.ts` 生成物与新增键脱节（与既有 `groupEmpty` 同源，未扩大）；勾选分组被外部删除后导出 fail-fast 报错（设计内行为，有 i18n 提示）
