# 报销整理全宽虚拟树视图 — 设计

- 日期：2026-10-10
- 状态：设计已确认（用户选定：全宽树 / 条目内下拉 / 方案 B 含虚拟滚动）
- 前置：`2026-10-09-reimbursement-classification-design.md`（归类数据层）与 `2026-10-10-reimbursement-key-picker-design.md`

## 背景与动机

当前报销整理视图（`ReimbursementView.vue`）为「左侧类别列表 aside + 点击后右侧查看该类别下 人员→年月 分组」的选择式浏览。用户要求改为**整棵树一屏展开展示**：报销类型 → 人员 → 发生日期(年月) → 文件条目，天然浏览全部分类结果；人工归类调整保留。归类数据层（`loadReimbursementTree`/`setOverride`/`reimbursementExport`/配置）在既有实现中已完备，本次**纯展示形态改造**。

## 决策记录（用户已确认）

1. 展示形态：全宽树一屏展开（类别 → 人员 → 年月 → 条目），移除 aside。
2. 人工归类交互：条目行内类别下拉（复用 `setOverride`），不做拖拽。
3. 实施方案 B：容器 + 递归树子组件 + 虚拟滚动，使用仓库既有 `vue-virtual-scroller`（零新依赖）。

## 目标

- 全宽树展示全部归类结果；未分类组置底。
- 每级节点可折叠/展开，默认全展开；每级显示文件计数徽标。
- 类别节点可展开「所需材料对照」行（原 aside 的材料 details 内容）。
- 工具条：「只看未分类」开关、「导出整理包」、「管理类别」入口。
- 数据层零变更（store/IPC/归类纯函数/导出逻辑均不动）。

## 非目标

- 不做拖拽归类；不做展开状态持久化；不做维度扩展（金额小计等）；不改导出格式与归类规则。

## 设计

### 1. 组件结构

- `ReimbursementView.vue`（容器，重写）：工具条 + 数据加载/错误重试/空态 + 监听树的 `move(entryId, categoryId)` 事件走 `store.setReimbursementOverride` + 导出逻辑（`onExport` 沿用）。移除 `selectedCategoryId`/`userSelected`/aside 相关逻辑。
- `ReimbursementTree.vue`（新建，纯展示）：props `tree`/`unassigned`/`showUnassignedOnly`；emits `move(documentId, value)`（value 语义与现有一致：`'__auto__'`/`'__unassigned__'`/类别 id）。下拉选项从 `tree` 节点派生。

### 2. 虚拟滚动与行模型

- flatten：由 `tree + unassigned + expandedSet` 计算可见行数组；行 `{ key, kind: 'category'|'person'|'period'|'entry'|'materials', depth 0-3, label, count?, materials?, categoryId?, entry? }`。条目行的下拉绑定值取**所在树节点**的类别 id（修正现实现依赖全局选中态的推断）。
- `RecycleScroller :item-size="null" :min-item-size="40"`（镜像 `ProviderModelList.vue:207-210` 既有惯例，支持材料行变高）。
- 折叠：`expandedSet`（本地 ref）+ `materialsOpenSet`（本地 ref），数据变化时重置为全展开；chevron 切换。未分类组置底且无材料行。
- 节点渲染：类别（名称+计数徽标+材料按钮+chevron）；人员（null→`unknownPerson`）；年月（null→`unknownPeriod`，降序沿用数据）；条目（模板名+文件名+金额(不确定琥珀色)+状态+类别下拉）。

### 3. 工具条

- 右侧：「只看未分类」toggle（`showUnassignedOnly`，开启时树仅渲染未分类组）、「导出整理包」（沿用 `reimbursement-export` testid 与 `exporting` 态）、「管理类别」（`configClient.openSettings({ routeName: 'settings-documents-reimbursement' })` 沿用）。
- 单据/报销视图切换保持在 `DocumentsArchivePage` 顶部，不动。

### 4. 错误/加载/空态

沿用现有：`reimbursementLoadError` 错误区+重试（`reimbursement-retry`）、loading 文案、空文案（树模式新增 `treeEmpty` 键）。

### 5. 测试策略

- **RecycleScroller stub**：jsdom 无真实尺寸，测试用 stub 渲染全部 items 并透传 scoped slot（`{ item }`），避免虚拟窗口导致行数为 0。
- 新 `ReimbursementTree.test.ts`：层级渲染、折叠/展开行数变化、计数徽标、未分类置底且无材料按钮、条目下拉 emit move、材料行展开、只看未分类模式。
- `ReimbursementView.test.ts` 改造：aside 断言 → 工具条（导出/只看未分类）+ move 透传 setOverride + 保留错误/加载/空态用例。
- i18n：新增 2 键（`showUnassignedOnly`、`treeEmpty`）×20 locale；其余复用现有键。

## 验收标准

1. 报销整理视图一屏完整展示 类别→人员→年月→条目 树，未分类置底，默认全展开，可折叠。
2. 每级节点显示文件计数；类别节点可展开材料对照行。
3. 条目下拉调整归类后树即时刷新（读取时派生模型），无需手动刷新。
4. 「只看未分类」「导出整理包」「管理类别」在工具条可用；错误/加载/空态不回归。
5. i18n 校验通过（20 locale）；typecheck/lint/format 通过；定点测试全绿。
