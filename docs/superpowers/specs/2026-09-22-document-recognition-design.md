# 行政单据智能识别与模板化提取 — 设计文档

日期：2026-09-22
状态：已评审通过（待实施）

## 1. 背景与目标

行政场景需要处理大量纸质/电子单据：合同、采购单、发票、行程单、高铁票、机票、住宿单等。当前 office-automation 插件已有发票识别 skill（视觉模型 + 内嵌 Extraction Template），但模板硬编码在 skill 内、仅支持发票、且识别结果无持久化档案。

本设计将"单一发票模板"泛化为：

1. **可配置的字段模板体系**：每种单据类型一份模板，字段可增删改排序，支持用户从零新建或复制预置模板修改。
2. **统一的智能识别服务**：按文件形态智能路由（视觉模型 / PDF 文本提取），按模板动态生成提取 prompt 与校验。
3. **单据档案库**：识别结果持久化，支持列表筛选、字段编辑修正、原文件关联、CSV 导出，为后续报销/汇总报表提供数据基础。

## 2. 已确认的需求边界

| 决策点 | 结论 |
|---|---|
| 落地形态 | **主程序内置功能**（非插件扩展）：主进程新模块 + 设置页 Tab + 独立管理页 |
| 识别引擎 | **智能路由**：图片/扫描件 → 视觉模型直读；文本层 PDF → 主进程文本提取 + 文本模型；超长文档分段合并。不接外部云 OCR |
| 功能范围 | **含单据档案库**：SQLite 持久化、管理页 CRUD、CSV 导出 |
| 实现架构 | **方案 A**：主进程单据服务 + skill 与管理页双入口复用 |

非目标（本期不做）：自由表达式校验 DSL、报销流程改造、多语言 OCR 增强、云 OCR 接入。

## 3. 现状与依赖

| 现有能力 | 位置 | 复用方式 |
|---|---|---|
| 发票识别 skill（视觉模型直读 + Extraction Template + 校验规则） | `plugins/office-automation/skills/invoice-recognition/SKILL.md` | 模板→prompt 逻辑泛化到主进程；预置 invoice 模板字段与其对齐 |
| PDF 文本提取 / 文档 OCR（带页码分段） | `src/main/ocr/`（attachmentCapabilityRouter、documentOcrText） | 智能路由的文本通道 |
| 主进程 LLM 调用通道（含 defaultVisionModel） | `src/main/provider/` | 提取服务调用模型 |
| SQLite 表 + repository 模式 | `src/main/scheduler/data/tables/`、`CronJobsRepository` | 新表与新 repository 的写法范本 |
| typed IPC 路由契约 | `src/shared/contracts/routes/`（如 cronJobs、remote-control） | 新增 documents 路由的写法范本 |
| settings Tabs / 独立页面 / Pinia | `RemoteSettings.vue`、`OfficialPluginDetailPage.vue`、`PluginsCatalogPage.vue` | UI 范本 |
| 文件引用体系 | deepchat-file:// | 档案原文件关联 |

## 4. 总体架构（方案 A）

```
主进程（新模块 src/main/documents/）
  ├─ DocumentTemplateStore   模板 CRUD + 预置模板 seed（SQLite，seed 源: preset_templates.json）
  ├─ DocumentExtractor       智能路由提取 + 动态 prompt + zod 校验
  ├─ DocumentArchiveStore    档案 CRUD + 快照（SQLite）
  └─ typed IPC 路由          src/shared/contracts/routes/documents.routes.ts
渲染层
  ├─ 设置页「单据识别」Tab    模板列表 + 独立模板编辑器页（含样张测试）
  ├─ 「单据档案」管理页       列表筛选 / 详情编辑 / 原文件预览 / CSV 导出
  └─ DocumentsStore (Pinia)  模板与档案状态缓存
Agent 入口
  └─ document-recognition skill（泛化 invoice-recognition）→ 调提取服务 → 确认存档
下游消费
  └─ office-automation create_reimbursement 等工具继续读档案数据
```

双入口（聊天 skill / 档案管理页）复用同一个提取服务与模板库。

## 5. 数据模型

### document_templates（单据模板表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | nanoid |
| typeKey | TEXT UNIQUE | 见下方预置模板映射表；自定义模板用自定义 key |
| name / icon | TEXT | 显示名（i18n key 或用户自定义名）、图标 |
| category | TEXT | 分类：合同类 / 出行票据类 / 采购类 / 支付凭证类 / 发票类（预置）；自定义模板默认「自定义」 |
| fields | TEXT(JSON) | 字段定义数组，每项 `{ key, label, valueType, required, promptHint, validation, enumOptions, order }` |
| extractionMode | TEXT | `auto`（默认）/ `vision` / `text` |
| promptPreset | TEXT NULL | 用户附加提取指令 |
| isBuiltin | INTEGER | 预置标记 |
| builtinSourceId | TEXT NULL | fork 自预置模板的 id |
| version | INTEGER | 每次修改 +1 |
| createdAt / updatedAt | INTEGER | 时间戳 |

`valueType` ∈ `text | number | date | array | enum`（与 preset_templates.json 的 `type` 映射：`string→text`、`number→number`、`date→date`、`array→array`；`enum` 供用户自定义模板使用）。`validation` 一期支持两类：正则字符串、内置关系式枚举（`amount_conservation` 金额守恒、`date_format` 日期格式）。

### 预置模板（seed 数据源：docs/superpowers/specs/preset_templates.json）

预置模板以 [preset_templates.json](preset_templates.json) 为权威定义，共 **10 类**，seed 映射如下：

| typeKey | JSON name | category | 说明 |
|---|---|---|---|
| `contract` | 合同模板 | 合同类 | 通用商务合同 |
| `lease_contract` | 租赁合同模板 | 合同类 | 房屋/设备租赁 |
| `contract_supplement` | 补充说明模板 | 合同类 | 补充协议/补充说明 |
| `travel_itinerary` | 行程单模板 | 出行票据类 | 机票/火车票（含高铁）行程单，`ticket_type` 区分航程/车次类型 |
| `hotel_receipt` | 住宿单模板 | 出行票据类 | 酒店住宿账单/发票 |
| `catering_receipt` | 餐饮流水单模板 | 出行票据类 | 餐饮消费小票 |
| `purchase_order` | 订购单模板 | 采购类 | 采购订购单 |
| `payment_screenshot` | 付款截图模板 | 支付凭证类 | 微信/支付宝/银行付款截图 |
| `invoice_special` | 增值税专用发票 | 发票类 | 专票（含明细行 `line_items`，required:false） |
| `invoice_general` | 普通发票 | 发票类 | 普票/卷式发票（含明细行，required:false） |

JSON → 模板字段结构映射规则：

- `desc` → `promptHint`（提取提示，进入动态 prompt）
- `type` → `valueType`（见上）；**例外**：`line_items` 在 JSON 源中标注为 `string`（其 desc 自述"格式为 JSON 数组"），设计意图为结构化明细，seed 时按字段级 override 映射为 `array`（实现于 `src/main/documents/seed.ts` 的 `SEED_FIELD_VALUE_TYPE_OVERRIDES`）
- `required`：JSON 仅 `line_items` 显式 `required:false`；未标注字段默认 `required:true`
- `order`：按 JSON 数组序生成（1 起）
- `validation` / `enumOptions`：预置模板不带，由用户后续在编辑器中配置
- JSON 中的 `version: "1.0"` 作为 seed 数据集版本号

实施落位说明：JSON 原文中的「alembic 迁移 / extract_schema 表 / is_preset」概念映射到本项目的实现为——SQLite `document_templates` 表 + 启动时 seed（插入缺失 `typeKey` 的 `isBuiltin=1` 模板，幂等）。seed 文件在实施时复制为主进程资源（`src/main/documents/presetTemplates.json`），运行时不依赖 docs 目录；docs 下的 JSON 作为需求源文档保持同步。

### documents（单据档案表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | nanoid |
| templateId | TEXT | 关联模板 |
| typeKey | TEXT | 冗余，便于筛选 |
| templateSnapshot | TEXT(JSON) | 识别时模板字段快照——模板后续修改不污染历史档案 |
| fields | TEXT(JSON) | `key → { value, uncertain }` |
| fileUris | TEXT(JSON) | 原始文件 deepchat-file:// 引用数组 |
| source | TEXT | `chat` / `manual` |
| sessionId | TEXT NULL | 聊天识别来源会话 |
| status | TEXT | `draft`（识别完成待确认）→ `confirmed`（确认/修正后） |
| createdAt / updatedAt | INTEGER | 时间戳 |

## 6. 提取服务（DocumentExtractor）

```
输入: fileUris + templateId（或 typeKey="auto" 自动分类）
 1. 文件读取 → 复用现有 file 服务
 2. 智能路由:
    图片 / 扫描件 PDF   → 视觉模型直读
    文本层 PDF          → 主进程 PDF 文本提取 → 文本模型
    超长文本(>60000字符) → 按 40000 字符分段提取 partial JSON
                          → 字段合并(冲突标 uncertain; 阈值常量可配置)
 3. Prompt 构建: 模板 fields → JSON schema + promptHint + 校验规则说明
 4. 模型调用: 主进程 provider 通道; 视觉优先 defaultVisionModel
 5. 校验: 按模板动态生成 zod schema + 金额/日期归一化 + validation 规则
输出: fields(value + uncertain 标记) + 模型原始输出(调试)
```

- `typeKey="auto"`：先由视觉模型对文件首页做类型分类，匹配模板后再提取。
- 缺失字段填 null，禁止模型臆造（沿用 invoice skill 原则）。
- 视觉模型不可用时返回明确降级提示，引导用户配置 defaultVisionModel。

## 7. IPC 契约（typed routes）

新增 `src/shared/contracts/routes/documents.routes.ts`（zod 契约，经 preload 桥接）：

```
documentTemplates.list        → 模板列表
documentTemplates.get         → 模板详情
documentTemplates.upsert      → 新建/更新（bump version）
documentTemplates.delete      → 删除（预置模板拒绝；有档案引用需 force 参数二次确认）
documentTemplates.fork        → 复制预置模板为自定义
documentTemplates.testExtract → 样张测试（不入库，返回提取结果+耗时）
documents.extractAndDraft     → 识别并存为 draft（聊天/管理页共用入口）
documents.list                → 档案列表（类型/日期/关键字筛选 + 分页）
documents.get                 → 档案详情
documents.upsert              → 修正字段保存（draft→confirmed）
documents.delete              → 删除档案
documents.exportCsv           → 导出 CSV（返回保存路径）
```

## 8. 模板管理 UI（设置页「单据识别」Tab）

复用 settings 页 Tabs 模式（参照 `RemoteSettings.vue`）与 shadcn-vue 组件：

```
设置 > 单据识别 (Tab)
└─ 模板列表
     ├─ 预置模板组: 10 类单据卡片，按 category 二级分组
     │    （合同类 / 出行票据类 / 采购类 / 支付凭证类 / 发票类）
     │    └─ 操作: 查看、复制为自定义（fork）
     └─ 自定义模板组: 新建（从零/从预置 fork）、删除（有档案引用时二次确认）
          └─ 点「编辑」→ 跳转独立页面 /settings/documents/template/:id

模板编辑器（独立页面，参照 OfficialPluginDetailPage 页面路由模式）
├─ 顶栏: 返回（dirty 未保存时 onBeforeRouteLeave 拦截）· 名称行内编辑 · 保存 · 样张测试
├─ 基本信息区: 图标 / 提取模式(auto·vision·text) / promptPreset 文本域
├─ 字段列表（整行拖拽排序）
│    ├─ 每行: 拖拽手柄 · key · 显示名 · 类型 · 必需开关 · promptHint · 校验规则 · 枚举选项
│    ├─ 拖动行整体重排 → order 实时更新，保存时写入 fields 数组顺序
│    └─ 添加字段 / 删除字段（required 字段删除需确认）
└─ 样张测试区（可折叠）: 上传样张 → testExtract → 结果表格（uncertain 高亮 + 耗时）
```

实现要点：

- **拖拽排序**：优先用 `@vueuse/integrations` 的 `useSortable`（底层 sortablejs）实现表格行拖拽；若项目尚未安装该依赖，实施时引入（轻量依赖，符合 VueUse 优先惯例）。
- 编辑器独立页面路由：`/settings/documents/template/:id`（编辑）；`/settings/documents/template/new?typeKey=&forkFrom=`（新建/复制品）。全宽布局适配字段表格 + 样张测试。
- 字段 `valueType` 决定编辑控件（text→文本输入、number→数字输入、date→日期选择器、enum→下拉、array→明细表格行编辑）。
- 状态用 Pinia `DocumentsStore` 缓存，改动走 typed IPC。
- i18n：所有文案进 20 个语言包，key 前缀 `settings.documents.*`。

## 9. 档案管理页

参照 `PluginsCatalogPage.vue` 的独立页面模式，新增 `/documents` 路由页：

```
单据档案
├─ 工具栏: 类型筛选(模板下拉) · 日期范围 · 关键字搜索(字段值 LIKE) · 导出 CSV
├─ 列表: 动态表格（列随所选类型模板快照 fields 渲染；"全部"视图显示类型+摘要+金额类字段）
├─ 详情抽屉:
│    ├─ 字段编辑表单（按快照 valueType 渲染控件，修正后 upsert）
│    ├─ 原文件预览（图片/PDF，复用现有文件预览通道）
│    ├─ 重新识别（换模板/换文件后重跑 extractAndDraft）
│    └─ 状态: draft 可编辑入库 / confirmed 显示确认时间
└─ 新建识别: 上传文件 + 选模板（或 auto）→ extractAndDraft → 确认入库
```

## 10. Agent 入口（skill 联动）

- office-automation 的 `invoice-recognition` skill 泛化为 `document-recognition`：skill 不再内嵌字段模板，改为指引 agent 调用 `documents.extractAndDraft` 识别，并按返回的 fields 渲染确认卡片（复用渲染层确认 UI），用户确认后转 `confirmed`。
- 预置 `invoice_special` / `invoice_general` 模板字段与现 skill 的 Extraction Template 对齐（`invoice_code`=发票代码、`invoice_number`=发票号码，语义与 JSON seed 一致），`create_reimbursement` 等下游工具无感迁移（从档案读数）。
- 聊天附件识别的展示沿用现有消息块体系（图片预览 + 结构化 JSON 结果卡片）。

## 11. 测试策略

| 层 | 内容 | 形式 |
|---|---|---|
| 数据层 | repository CRUD、预置 seed 幂等、快照与 version 行为 | Vitest（`test/main/documents/`） |
| 提取服务 | 路由决策（vision/text/auto）、动态 prompt 生成、zod 校验、分段合并冲突处理、校验规则（正则/关系式） | Vitest（mock provider 通道） |
| IPC 契约 | routes zod 契约解析 | Vitest |
| 模板编辑器 | 字段增删改、拖拽重排后 order 正确、dirty 守卫 | Vitest + Vue Test Utils |
| 档案页 | 列表筛选、动态列、导出 CSV | Vitest + Vue Test Utils |
| 端到端 | 上传样张 → 识别 → 确认入库 → 档案可见 | Playwright（P4，视样张依赖可选手测） |

临时探针/脚手架测试在合入前移除；仅保留契约与回归测试。

## 12. 分期计划

| 期 | 内容 | 验证方式 |
|---|---|---|
| P1 | 数据层：两张表 + repository + 预置模板 seed + typed IPC 路由 | 单测（repository/seed/route 契约） |
| P2 | 提取服务：智能路由 + 动态 prompt/zod 校验 + 分段合并 | 单测 + 样张手测 |
| P3 | 模板管理 UI（设置 Tab + 独立编辑器页 + 样张测试 + 拖拽排序） | 渲染层组件测试 |
| P4 | 档案管理页 + 聊天识别入口（skill 泛化）+ CSV 导出 | e2e + 手测 |

每期独立可合入；P1/P2 为 P3/P4 的前置。

## 13. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 合同/采购单长文档字段一致性 | 阈值分段提取 + 合并冲突标 uncertain；一期可接受"关键信息提取"而非全文全字段 |
| 视觉模型不可用 | 沿用 invoice skill 的降级引导（提示配置 defaultVisionModel） |
| 模板 schema 演进污染历史档案 | templateSnapshot 快照 + version，档案按快照渲染 |
| 自定义模板 key 冲突/重名 | typeKey UNIQUE 约束 + 保存前查重提示 |
| 拖拽依赖引入 | 仅一个轻量依赖（sortablejs via @vueuse/integrations），符合 VueUse 优先惯例 |
| docs 下 JSON 与主进程 seed 资源双源漂移 | 主进程 seed（src/main/documents/presetTemplates.json）以 docs/superpowers/specs/preset_templates.json 为需求源；后续变更先改 docs 源再同步，并在 seed 单测中比对两者一致 |
