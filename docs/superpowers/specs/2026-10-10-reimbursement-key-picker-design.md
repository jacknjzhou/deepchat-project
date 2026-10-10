# 报销类别设置 key 选择器 + 识别完成自动刷新报销树 — 设计

- 日期：2026-10-10
- 状态：已确认（用户批准勾选清单 / type_key+字段键全覆盖 / 失效 key 保留标记）
- 关联：`docs/superpowers/specs/2026-10-09-reimbursement-classification-design.md`（上位功能）

## 背景

1. 报销类别设置页（`ReimbursementConfigPage.vue`）当前的「自动归类模板 type_key」（类别/材料 `linkedTypeKeys`）与「全局字段映射键」（`personFieldKeys`/`dateFieldKeys`/`amountFieldKeys`）均为自由文本输入。用户需要手工记忆「智能信息识别」中模板的 `typeKey` 与字段 `key`，易拼错、不可发现。
2. 已核实（用户问询「识别后是否会按报销整理设置自动整理」）：自动归类**已实现**，为读取时实时派生模型——识别完成后文档入库（`reimbursement_override` 为 NULL），`documentsReimbursementTreeRoute` 在视图请求时按当前配置逐文档执行 `resolveDocumentCategoryId`（手动覆盖 > `linkedTypeKeys` 匹配 typeKey > 未分类），配置改动即时对全部历史文档生效，无需识别时落库。
3. 已核实的唯一缺口：报销整理视图仅在挂载与手动重试时加载树（`ReimbursementView.vue` 无任务事件监听）；视图打开期间识别任务完成，树不自动刷新。

## 目标

- 配置页四处 key 输入改为从已配置模板勾选选择，消灭手工拼写。
- 识别任务完成后，报销整理树自动刷新（视图已加载过树的前提下）。
- 失效 key（模板已删）保留可见并可移除，不阻塞保存。

## 非目标

- 不改 ReimbursementView、导出、数据模型与 IPC 契约（纯渲染端改造 + store 一处增强）。
- 不做失效 key 的自动清理或迁移。
- 不为 key 选择器做虚拟滚动/搜索（当前模板量级 ≤ 数十，勾选列表 max-height 滚动即可）。

## 设计

### 1. 数据来源（纯渲染端）

`ReimbursementConfigPage` 挂载时复用 `useDocumentsStore.templates`（为空才调 `loadTemplates()`，与模板编辑页共享缓存）。模板加载失败**不阻塞保存**（现有配置仍可保存），仅选择器区显示错误 + 重试。

### 2. 新组件 `ReimbursementKeyPicker.vue`

路径：`src/renderer/settings/components/documents/ReimbursementKeyPicker.vue`，一处组件四处复用。

- props：`modelValue: string[]`；`options: Array<{ value: string; label: string; hint?: string }>`；可选 `notice: 'empty' | 'error' | null`（父组件判定：`templates` 为空且加载未失败 → `'empty'`；`loadTemplates` 失败 → `'error'`；其余 `null`）；emits `update:modelValue` 与 `retry`。
- 已选区：`DcBadge` 标签，× 移除；**失效项**（value ∉ options）标签加「已失效」warning 样式标记。
- 勾选区：紧凑复选列表（label=模板名/字段名，hint=mono `type_key`/key），勾选 append 到数组尾部、取消即移除，顺序保持数组序；列表 `max-height` 内滚动。
- 空态：`notice='empty'` → 提示「请先在智能信息识别中配置模板」；`notice='error'` → 错误文案 + 重试按钮（emit `retry`，父组件重跑 `loadTemplates`）。
- 不提供自由文本输入；契约层 `^[a-z][a-z0-9_]*$` 校验保留兜底。

### 3. 配置页接线（4 处替换自由文本 Input）

| 位置 | options 来源 |
| --- | --- |
| 类别 `linkedTypeKeys` | 模板清单：`{ value: t.typeKey, label: t.name, hint: t.typeKey }` |
| 材料 `linkedTypeKeys` | 同上（共用同一选项集） |
| 全局 `personFieldKeys`/`dateFieldKeys`/`amountFieldKeys` | 全部模板 `fields[].key` 去重，`label` 取首次出现的 `field.label`，`hint` 为 key |

选项过滤：仅列符合 `^[a-z][a-z0-9_]*$` 且 ≠ `'unassigned'` 的 key（模板创建契约本已约束格式，此处兜底过滤，防止选中即保存失败）。

### 4. 自动刷新（store 增强）

`src/renderer/src/stores/documents.ts` 的 `handleTaskUpdated`：当 `payload.status ∈ {done, failed}` 且 `reimbursementTree.value !== null`（树已加载过，避免未打开视图时空跑）时，追加 `void loadReimbursementTree()`。既有 `reimbursementLoadSeq` 竞态守卫保证幂等。

### 5. i18n

`settings.documents.reimbursement` 命名空间新增 3 键（20 locale，settings.json）：`staleKey`（已失效）、`noTemplatesHint`、`templatesLoadFailed`。

## 测试

- `test/renderer/settings/documents/ReimbursementKeyPicker.test.ts`（组件级）：勾选/取消同步数组、失效标记、空态、× 移除。
- `ReimbursementConfigPage.test.ts`：mock 模板数据；勾选模板 → `linkedTypeKeys` 更新、失效 key 标记且可保存、字段键选项来自模板 fields、模板加载失败重试。
- `documentsReimbursementStore.test.ts`：树已加载时任务 done → 树刷新；树未加载 → 不刷新。
- 回归：typecheck、`pnpm run i18n`、定点 vitest（3 个测试文件）。

## 验收标准

1. 配置页四处 key 输入均为勾选清单，无自由文本输入。
2. 模板删除后，配置中残留 key 在标签上显示「已失效」，可移除，保存不被阻塞。
3. 报销整理视图打开状态下完成一次识别，树在任务 done 后自动出现新单据。
4. 20 locale i18n 校验通过；typecheck/lint/format 通过；�