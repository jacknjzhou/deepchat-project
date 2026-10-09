# 报销分类整理（Reimbursement Classification）设计

日期：2026-10-09
状态：待评审

## 背景与目标

「智能信息提取」（单据识别）已能对上传文件识别并归档（`documents` 表）。本设计在其后增加**报销分类整理**能力：

1. 依据**报销类别**（源自 `docs/finacial-helper/报销制度中涉及的报销材料清单.csv` 的费用大类）对已识别记录分类；
2. 类别内再按识别出的**人员**、**日期（期间）**细分；
3. 对照每类**所需材料清单**自动统计收集情况；
4. 支持一键导出整理包（按 类别/人员/期间 的目录树 + 汇总 CSV）。

## 已确认的需求决策

| 决策点 | 结论 |
| --- | --- |
| 输出形态 | 虚拟分组视图 + 可选导出整理包（不自动复制文件） |
| 归类方式 | 报销类别配置模板映射自动归 + 用户手动调整；映射不到落「未分类」 |
| 人员/日期取值 | 可配置字段映射（预置常见字段 key，可增删）；匹配不到归「未知」组 |
| 配置存储 | 类别配置存 settings KV（`documents.reimbursementConfig`）；手动归属存 `documents` 表新列 |
| 材料跟踪 | 仅自动统计份数，不做手动勾选 |
| 范围 | 仅分类整理；xlsx 报销表生成、差旅标准合规校验为后续迭代 |

## 总体架构

```
识别完成（已有 documents 记录）
        │
        ▼
归类计算（主进程 reimbursement.ts 纯函数）
  手动 override 优先 → 模板映射(linkedTypeKeys) → 未分类
        │
        ▼
分组树构建   类别 → 人员 → 期间（粒度可配：月/天）
        │
        ├─► 渲染端「报销整理」视图（归档页新增视图切换）
        └─► 导出整理包（主进程写目录树：原件复制 + 汇总 CSV）
```

归类与分组逻辑全部在主进程（单一事实源），渲染端只做展示与交互。

## 数据模型与配置

### 报销类别配置（settings KV）

存于 app-settings.json 的 `documents.reimbursementConfig` 键，沿用 documents 模型设置（`modelSettings.ts`）的读写模式：

```ts
interface ReimbursementConfig {
  version: 1
  categories: Array<{
    id: string                  // uuid
    name: string                // 如「业务招待费」
    requiredMaterials: Array<{
      name: string              // 如「发票」「用餐流水单」
      linkedTypeKeys: string[]  // 可选关联模板 type_key，用于自动统计已有份数
    }>
    linkedTypeKeys: string[]    // 自动归类：记录模板 type_key 命中即归入
    sortOrder: number
  }>
  personFieldKeys: string[]     // 人员字段 key 候选，按顺序取第一个命中
  dateFieldKeys: string[]       // 日期字段 key 候选
  amountFieldKeys: string[]     // 金额字段 key 候选（汇总 CSV 金额列）
  dateGrouping: 'day' | 'month' // 日期分组粒度，默认 'month'
}
```

预置默认字段映射（对照 presetTemplates.json 实际字段）：

- personFieldKeys：`passenger_name`、`guest_name`、`buyer_name`、`payer_name`、`payee_name`、`handover_person`、`name`
- dateFieldKeys：`invoice_date`、`consume_date`、`depart_date`、`checkin_date`、`sign_date`、`order_date`、`meeting_date`、`claim_date`、`purchase_date`、`entry_date`、`value_date`、`quote_date`
- amountFieldKeys：`total_amount`、`amount`、`contract_amount`

取值规则：按列表顺序在记录 `fields` 中找第一个有非空 `value` 的 key；值为数组时取首个非空元素；找不到归「未知人员 / 未知期间」；金额找不到则 CSV 该列留空。日期值解析支持 `YYYY-MM-DD`、`YYYY/MM/DD`（及带时间的变体取日期部分）；无法解析归「未知期间」。

### 预置 seed

首次使用时惰性初始化：`getConfig` 读取时若 settings 键不存在，写入默认配置并返回（写入后与用户自定义配置无异，不再被覆盖）：

- 26 个报销类别源自 `报销制度中涉及的报销材料清单.csv`（同名类别合并，如业务招待费、培训费；材料清单保留 CSV 原文条目）；
- `linkedTypeKeys` 默认映射仅覆盖与内置模板用途明确对应的类别（如 城市交通费 ← 出租车/客运类模板、会议费 ← 会议类模板），完整映射表在实施 plan 阶段对照 presetTemplates.json 的 type_key 确定；无把握的类别留空映射，由用户手动调整或自行配置。

### documents 表加列迁移

- 新列：`reimbursement_override TEXT`（可空）
- 语义：`NULL` = 按映射自动归类；值为 category id = 强制归入该类别；值为 `'unassigned'` = 强制未分类
- 表版本 1 → 2，走 BaseTable 既有迁移机制（`ALTER TABLE documents ADD COLUMN reimbursement_override TEXT`）

## 主进程设计

### 纯函数模块 `src/main/documents/reimbursement.ts`

- `resolveDocumentCategory(doc, config)`：override 优先 → 模板 `type_key` 命中类别 `linkedTypeKeys`（多类别命中取 sortOrder 最小）→ 未分类。模板删除时用 `template_snapshot_json.typeKey` 兜底。
- `buildReimbursementTree(documents, config)`：输出分组树；类别按 `sortOrder`、人员按名称（未知人员恒排最后）、期间倒序。

```
tree: [{
  category: { id, name, requiredMaterials, linkedTypeKeys, stats }
  groups: [{
    person: string | null,        // null = 未知人员组
    buckets: [{
      period: '2026-09' | '2026-09-01' | null,
      documents: [{ id, templateName, fields, fileUris, amount, uncertainCount, isOverride }]
    }]
  }]
}]
```

材料统计：类别内每条 `requiredMaterials[i]`，统计归属记录中模板 type_key ∈ 其 `linkedTypeKeys` 的记录数，展示「已有 N 份」。

### IPC 契约（追加至 `src/shared/contracts/routes/documents.routes.ts`）

| 路由 | 输入 | 输出 |
| --- | --- | --- |
| `documents.reimbursement.getConfig` | — | `{ config }`（未初始化时返回 seed 默认） |
| `documents.reimbursement.setConfig` | `config`（zod：类别名非空且去重、材料 name 非空、字段 key 元素非空、dateGrouping 枚举） | `{ config }` |
| `documents.reimbursement.tree` | `status?: 'draft'\|'confirmed'`、`dateFrom?/dateTo?` | `{ tree, unassigned[], summary }` |
| `documents.reimbursement.setOverride` | `documentId`、`categoryId: string \| null`（null=清除覆盖恢复自动） | `{ document }` |
| `documents.reimbursement.export` | `directory: string`、`status?/dateFrom?/dateTo?` | `{ canceled, path?, exportedFiles, summaryPath }` |

路由接线追加到 `src/main/documents/routes.ts`，导出使用 `dialog.showOpenDialog` 选择目标目录。

### 导出整理包

```
<所选目录>/报销整理-YYYYMMDD-HHmm/
  ├── 业务招待费/
  │   ├── 张三/
  │   │   ├── 2026-09/          ← 粒度为天时为 2026-09-01
  │   │   │   └── <原件复制>
  │   │   └── 2026-08/
  │   └── 未知人员/
  ├── 会议费/
  ├── 未分类/
  └── 汇总.csv
```

- 汇总 CSV 列（固定中文表头，不随 locale 变化）：`类别 | 人员 | 期间 | 单据模板 | 文件名 | 金额 | 金额存疑 | 手动指定`；`手动指定` 列记录 override 状态（类别 id 归属=是，`'unassigned'`=强制未分类）。
- 文件重名：按 `name-1.ext` 递增，不覆盖。
- 原件缺失：跳过复制，CSV `文件名` 列记 `缺失:<原名>`；单文件复制失败不中断整体，同样记入 CSV。
- 目标目录不可写：报错中止；根目录名冲突追加 `-1` 后缀。

## 渲染端设计

### 归档页视图切换（DocumentsArchivePage.vue）

顶部新增 `[单据视图 | 报销整理]` 模式切换；单据视图保持现状（tabs + 筛选 + 表格）。

报销整理视图（新组件 `ReimbursementView.vue`）：

```
┌──────────┬──────────────────────────────────────────────┐
│ 类别列表  │ 张三  2026-09 (3)                            │
│ ·业务招待费│   ├ 发票.pdf  ¥120  [移动到类别…]            │
│ ·会议费(8)│ 李四  2026-08 (1)                            │
│ ·未分类(5)│ ▸ 材料对照：发票 已有4份 / 流水单 已有0份      │
│ [管理类别] │                        [导出整理包]          │
└──────────┴──────────────────────────────────────────────┘
```

- 左侧类别列表：名称 + 记录数徽标，含「未分类」；底部「管理类别」跳转设置页
- 右侧：人员分组 → 期间子分组 → 记录行（模板名、摘要、金额——存疑沿用标黄约定、预览按钮）
- 材料对照区：类别顶部折叠面板，关联模板的材料项显示「已有 N 份」
- 手动调整：记录行「移动到类别…」下拉（含「强制未分类」「恢复自动」），调 `setOverride` 后局部刷新
- 导出：工具栏按钮 → 目录选择 → 完成提示（文件数 + 路径）

### 配置页（settings/components/documents/ReimbursementConfigPage.vue）

与「文档识别模型」「模板管理」并列的设置入口：

- 类别列表管理：增/删/重命名/排序
- 类别编辑：材料清单行编辑（名称 + 可选关联模板多选）、自动归类模板映射（type_key 多选，下拉列出全部模板）
- 全局设置：人员/日期/金额字段 key 列表（chips 增删）、日期分组粒度（月/天）
- 校验：类别名重复、空名阻断保存
- 删除类别：手动指定到该类别的记录回落为「未分类」（override 值失效即视为未分类，无需级联清理）

### Store 扩展

documents store 新增 reimbursement 配置 / 树 / override 状态与 action，复用现有 IPC 调用模式。

## 错误处理

- 配置校验：`setConfig` zod 校验失败即报错；渲染端表单同步校验阻断保存
- 归类容错：字段匹配不到归「未知」组；override 指向已删除类别 → 未分类；模板删除 → 快照 typeKey 兜底
- 导出容错：见上节；导出目录不存在时先创建
- 迁移容错：加列失败按 BaseTable 机制记录，不阻断启动
- 托管配置：本次不扩展 managed.config（报销类别为本地业务配置，托管下发留作后续）

## i18n

- 新键统一前缀 `settings.documents.reimbursement.*`，覆盖全部 20 个 locale
- 汇总 CSV 表头固定中文，与现有 `buildDocumentsCsv` 行为一致

## 测试策略（最小回归）

- 主进程纯函数单测 `test/main/documents/reimbursement.spec.ts`：归类优先级（override > 映射 > 未分类）、字段匹配与数组取值、粒度分组、排序、override 失效回落；文件顶部 `vi.unmock('fs')/('node:fs')/('path')/('node:path')`
- 表迁移测试：v1→v2 加列、旧数据读取兼容
- seed 测试：默认配置写入幂等、用户已有配置不被覆盖
- 契约测试：5 条新路由 zod 正反例
- 渲染端组件测试：ReimbursementView 分组渲染与「移动到类别」交互；配置页增删类别与校验

## 明确不做

- xlsx 报销表生成、差旅住宿费/交通费标准合规校验（后续迭代）
- 材料手动勾选状态
- LLM 智能归类
- 企业托管下发报销类别配置

## 涉及文件（预估）

- 新增：`src/main/documents/reimbursement.ts`、`src/renderer/src/pages/documents/ReimbursementView.vue`、`src/renderer/src/settings/components/documents/ReimbursementConfigPage.vue`
- 修改：`src/shared/contracts/routes/documents.routes.ts`、`src/main/documents/routes.ts`、`src/main/documents/modelSettings.ts`（或新建 configSettings 读写）、`src/main/documents/data/tables/documents.ts`、`src/main/documents/seed.ts`、documents store、`DocumentsArchivePage.vue`、settings 导航、i18n locale 文件 ×20
- 测试：`test/main/documents/reimbursement.spec.ts`、迁移/seed/契约/渲染端测试
