# 单据详情手工分组 + 归档表格报销列实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「单据详情」弹窗（DocumentDetailDialog）中直接设置该单据的报销类型（类别覆盖）与自定义分组，**选择后立即生效**；归档（智能信息提取）文档表格新增「报销类型」「分组」两列，显示**生效类别**（含自动归类解析）与分组名，设置结果实时同步到报销整理视图。

**Architecture:** 零后端/契约/迁移改动——完全复用既有 `documents.reimbursement.setOverride` / `setGroupOverride` IPC、`DocumentRecord.reimbursementOverride` / `reimbursementGroupOverride` 字段、树构建的生效类别解析（override > typeKey 联动 > 未分类）。渲染端三处改动：store 的两个 `setReimbursement*` action 扩展为返回更新后的 DocumentRecord 并**原地修补** archiveDocuments 行；详情弹窗字段页签底部新增「手工分组」区块（本地状态 + 立即调用 + 失败回退）；归档表格新增两列，用 `reimbursementConfig` 解析显示名。

**Tech Stack:** Electron/Vue3/TS、zod 契约（不修改）、Vitest。

---

## 需求与决策记录（用户截图 + 两个确认答案）

1. **弹窗设置立即生效**（用户确认）：下拉切换即写库，不依赖「保存」按钮；「保存」仍仅负责字段确认。与报销整理行内下拉语义一致。
2. **表格显示生效类别**（用户确认）：报销类型列显示 生效类别（手工覆盖 > 模板 typeKey 联动自动归类 > 未分类）；分组列显示分组名。
3. **调用顺序约束**：后端 `setReimbursementOverride` 无条件清空分组（documents.ts:212 `reimbursement_group_override = NULL`）。因此：类别变更只调 setOverride（分组随返回记录复位为未分组）；仅分组变更只调 setGroupOverride。无需新增原子契约。
4. **自动归类下也可选分组**：树构建（reimbursement.ts:234-240）按生效类别校验分组归属，typeKey 联动解析出的类别其 customGroups 对自动条目同样生效——弹窗类别为「自动归类」时分组下拉列出联动类别的分组。
5. **archiveDocuments 原地修补**：setReimbursement* 返回的记录用 findIndex 命中才替换，**不得 unshift**（避免报销整理视图下调用时向未加载/已过滤的归档列表插入孤立行）。
6. **哨兵值复用**：下拉用 `'__auto__'` / `'__unassigned__'` / `'__none__'`，映射逻辑与 ReimbursementView.vue:380 一致（`'__auto__'→null`、`'__unassigned__'→REIMBURSEMENT_UNASSIGNED`）。
7. **显示兜底**：强制未分类复用现有键 `settings.documents.reimbursement.unassigned`（未分类）；自动归类但模板未联动任何类别 → `—`；未分组或分组 id 陈旧（不在生效类别 customGroups 中）→ `—`。
8. **范围外**：归档 CSV 导出不加列（用户未要求）；报销整理视图本身不改动。

## 文件结构总览

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/renderer/src/stores/documents.ts` | 修改 | `setReimbursementOverride` / `setReimbursementGroupOverride` 返回 `DocumentRecord \| null` 并原地修补 archiveDocuments |
| `src/renderer/src/pages/documents/documentArchive.ts` | 修改 | 新增纯函数 `resolveEffectiveReimbursement(document, config)`（生效类别 id + 校验后的分组 id） |
| `src/renderer/src/pages/documents/DocumentDetailDialog.vue` | 修改 | 字段页签底部「手工分组」区块：报销类型 + 分组名称两个下拉，立即生效、失败回退 |
| `src/renderer/src/pages/documents/DocumentsArchivePage.vue` | 修改 | 挂载时 `loadReimbursementConfig()`；表格新增「报销类型」「分组」两列（摘要后、来源前，两种页签下均显示） |
| `src/renderer/src/i18n/*/settings.json`（20 locale） | 修改 | 4 个新键（见 i18n 章节） |
| `test/renderer/stores/documentsReimbursementStore.test.ts` | 修改 | store 修补语义测试 |
| `test/renderer/pages/documents/documentArchive.test.ts` | 修改 | 解析纯函数测试 |
| `test/renderer/pages/documents/DocumentDetailDialog.test.ts` | 修改 | 弹窗手工分组交互测试 |
| `test/renderer/pages/documents/DocumentsArchivePage.test.ts` | 修改 | 表格两列渲染测试 |

## UI 布局（BEFORE / AFTER）

详情弹窗字段页签：

```
BEFORE:                          AFTER:
┌─ 字段网格（2 列）──────────┐    ┌─ 字段网格（2 列）──────────┐
│ 订单编号*    供应商*        │    │ 订单编号*    供应商*        │
│ ...                        │    │ ...                        │
└────────────────────────────┘    └────────────────────────────┘
(fieldError)                      (fieldError)
                                  ┌ 手工分组 ────────────────────┐
                                  │ 报销类型        分组名称      │
                                  │ [自动归类 ▾]   [未分组 ▾]     │
                                  └──────────────────────────────┘
```

归档表格（全部与模板页签一致）：

```
BEFORE: [类型] [字段列...] [摘要] [来源] [状态] [创建时间]
AFTER:  [类型] [字段列...] [摘要] [报销类型] [分组] [来源] [状态] [创建时间]
```

## i18n 新键（20 locale 全量）

| 键 | zh-CN | 用途 |
| --- | --- | --- |
| `settings.documents.archive.manualGroupingTitle` | 手工分组 | 区块标题 |
| `settings.documents.archive.colReimbursement` | 报销类型 | 表头 + 表单 label |
| `settings.documents.archive.colGroup` | 分组 | 表头 + 表单 label |
| `settings.documents.archive.reimbursementSetFailed` | 设置失败 | 设置写库失败 feedback |

复用既有键（不新增）：`settings.documents.reimbursement.autoCategory`（自动归类）、`forceUnassigned`（强制未分类）、`unassigned`（未分类）、`groupNone`（未分组）、`noGroupsHint`（请先添加自定义分组）。

---

## Task 1: store 扩展 + 生效类别解析纯函数

- [ ] `src/renderer/src/stores/documents.ts`：`setReimbursementOverride` / `setReimbursementGroupOverride` 捕获 client 返回的 `document`（`DocumentRecord | null`）；archiveDocuments 中 findIndex 命中则原地替换（未命中不插入）；函数返回该记录。树刷新逻辑保持现状（无条件 reload）。
- [ ] `src/renderer/src/pages/documents/documentArchive.ts`：新增 `resolveEffectiveReimbursement(document: DocumentRecord, config: ReimbursementConfig | null): { categoryId: string | null; groupId: string | null }`。规则：override === REIMBURSEMENT_UNASSIGNED → categoryId null（调用方以 document.reimbursementOverride === 'unassigned' 区分强制未分类）；override 为有效类别 id → 该类别；否则按 `linkedTypeKeys.includes(document.typeKey)` 自动解析（无联动 → null）。groupId 仅当 categoryId 非空且存在于该类别 customGroups 时返回，否则 null。纯函数、无 i18n 依赖。
- [ ] 测试：`documentsReimbursementStore.test.ts`（返回记录、原地替换、未命中不 unshift）；`documentArchive.test.ts`（强制未分类 / 有效 override / 联动自动 / 无联动 / 分组有效 / 分组陈旧 / config 为 null）。

## Task 2: 详情弹窗「手工分组」区块

- [ ] `DocumentDetailDialog.vue` 字段页签底部（fieldError 之后）新增区块，标题 `manualGroupingTitle`，两个 shadcn Select 并排（md:grid-cols-2）：
  - 报销类型：选项 `__auto__`（autoCategory）/ `__unassigned__`（forceUnassigned）/ `store.reimbursementConfig.categories`（按 sortOrder）。初值来自 `document.reimbursementOverride`（null → `__auto__`）。
  - 分组名称：选项 `__none__`（groupNone）+ 生效类别 customGroups（按 sortOrder）。生效类别 = 当前所选类别的联动/覆盖解析。禁用条件：无生效类别、该类别无分组、写库 pending、config 未加载；禁用时 title 用 `noGroupsHint`（无分组场景）。
- [ ] 立即生效语义：类别 change → `store.setReimbursementOverride(doc.id, 映射值)`；成功后以返回记录提交本地状态（分组复位为返回记录的 `reimbursementGroupOverride ?? '__none__'`）；失败 `showFeedback('error', reimbursementSetFailed)` 并回退本地选择。分组 change → `setReimbursementGroupOverride` 同理（映射 `'__none__' → null`）。写库 pending 期间两个下拉互斥禁用。
- [ ] props.document watch 中同步初始化两个本地 ref；`busy` 计算纳入 pending 状态；弹窗打开时若 config 未加载由页面层负责加载（Task 3），弹窗内 config 为 null 时两个下拉禁用。
- [ ] 测试：`DocumentDetailDialog.test.ts`——初值渲染（自动/覆盖/未分类）、类别 change 调用参数、分组 change 调用参数、类别变更后分组复位（以返回记录为准）、失败回退 + feedback、禁用态（config null / 类别无分组 / 未分类）。

## Task 3: 归档表格「报销类型」「分组」两列

- [ ] `DocumentsArchivePage.vue` setup 增加 `void store.loadReimbursementConfig()`（幂等）。
- [ ] 表头在「摘要」之后、「来源」之前插入两列（`colReimbursement` / `colGroup`），全部与模板页签下均显示；行单元格用 `resolveEffectiveReimbursement` + config 映射名字：强制未分类 → `t(reimbursement.unassigned)`；生效类别 → 类别名；无生效类别 → `—`。分组 → 分组名或 `—`。
- [ ] 测试：`DocumentsArchivePage.test.ts`——表头渲染、覆盖类别名、联动自动类别名、强制未分类、无联动 `—`、分组名/陈旧分组 `—`。

## Task 4: i18n（20 locale）+ 回归收尾

- [ ] 4 个新键补齐 20 个 locale（参照既有翻译风格；en/ja 等参照 `settings.documents.archive` 命名空间现有术语）。
- [ ] 定点回归：`pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts test/renderer/pages/documents/documentArchive.test.ts test/renderer/pages/documents/DocumentDetailDialog.test.ts test/renderer/pages/documents/DocumentsArchivePage.test.ts`
- [ ] `pnpm run i18n`；`pnpm run typecheck`；`pnpm run format:check`（必要时 `pnpm run format`）；`pnpm run lint`。
- [ ] 提交遵循 Conventional Commits（≤50 字符），PR 附上方 BEFORE/AFTER ASCII。

## 验证命令备注

- 渲染层测试直接 `pnpm exec vitest run <files>`（无需 Electron）。
- 本方案不改主进程代码，无需跑 sqlite 套件；如需回归主进程契约测试：`$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts --config vitest.config.ts`。
- Edit 工具在本机出现过 NUL 字节/截断损坏先例：每次编辑后用 `git diff` 核验完整性再继续。

---

## As-built 记录（2026-10-11）

**执行方式**：Subagent-Driven（4 Task × 实现 → spec 合规审查 → 质量审查 → 修复复审），最终整体终审 **Ready to merge**。

**提交链**（分支 `20261009classifier-docs-content`）：

| SHA | 消息 | 内容 |
| --- | --- | --- |
| 2442e5e9 | feat(documents): return record from set actions | store 两 action 返回记录 + 原地修补（replaceArchiveDocumentInPlace） |
| 774b2f91 | feat(documents): effective reimbursement resolver | resolveEffectiveReimbursement 纯函数 |
| 89f2cb68 | fix(documents): mirror sortOrder arbitration | resolver 补齐与主进程一致的 sortOrder 仲裁 |
| 4ddc82b6 | feat(documents): manual grouping in detail dialog | 弹窗「手工分组」区块 + zh-CN/en-US 4 键 |
| ba18ec4e | fix(documents): dialog grouping robustness | 质量修复：打开时加载 config、共享 resolver 复用、陈旧 override 播种降级 |
| 08200dd3 | feat(documents): archive reimbursement columns | 归档表格两列 + 页面级 config 加载 |
| ccea4919 | fix(documents): catch reimbursement config load | 两处 void 调用补 catch |
| 6af49ad8 | i18n(documents): manual grouping keys for 20 locales | 18 locale 补 4 键 |

**计划偏差**：
1. zh-CN `colGroup` 实际译为「分组名称」（对齐用户截图标注），非计划 i18n 表中的「分组」；zh-TW/zh-HK 同。
2. Task 1 实现者自查发现 resolver 未镜像主进程 sortOrder 仲裁，补 89f2cb68。
3. Task 2 质量审查 2 个 Important（默认入口 config 未加载致区块静默禁用、组件内 resolver 与共享 resolver 陈旧 id 行为分歧）→ ba18ec4e 修复：弹窗打开时加载 config、组件内联动逻辑删除改为合成记录走共享 resolver、播种校验降级。
4. Task 3 后追加 ccea4919（质量审查 Minor 采纳：void 调用补 catch）。

**验证状态**：4 个渲染层套件 79 用例全绿；`pnpm run i18n` / `i18n:en` / 双端 `typecheck` / `format:check`（3087 文件）/ `lint` 全部通过。主进程零改动，未跑 sqlite 套件。

**已知局限（低危，自愈型）**：
1. 弹窗分组下拉播种不校验存储的分组 id 是否属于生效类别（分组被删/跨类别时可能显示不在选项内的原始 id；表格列与树视图正常降级 `—`；用户下次操作自愈）。
2. config 异步加载完成前播种保留原始 override id，加载后不重新播种（极罕见时序，重开弹窗自愈）。
3. 弹窗本地 ref 与页面 detailDocument 快照不互换（设计决策：避免写库中途重播种打断编辑）；关闭重开或重新识别时收敛。
