# 简历筛选智能助手设计（Resume Screening Assistant）

- 日期：2026-09-28
- 状态：已批准（用户确认七节设计后写入）
- 范围：DeepChat 主窗口新增"简历筛选"顶级功能页，全量实现截图 UI 与五角色 LLM 流水线

## 1. 背景与目标

为需要筛选简历的招聘人员提供一个智能助手：输入岗位 JD 与一批简历文件，由多角色 LLM 流水线
自动完成简历结构化提取、初筛评分、面试视角分析与 HR 综合意见，输出结构化报告并保存任务历史。

参照 UI 截图（深色单页布局）：左栏为任务创建与配置区，右栏为筛选结果浏览区。

### 目标

1. 主窗口新增顶级页面"简历筛选"（路由 `/resume-screening` + 侧边栏入口）
2. 按截图全量实现：JD 输入（文本/文件）、简历上传（≤20 份）、筛选配置、智能审阅、任务历史、
   任务卡片 + 统计、JD 内容 Tab、多简历 Tab、简历详情五段式结论
3. 五角色 LLM 流水线：JD 解析官 → 结构化提取员 → 初筛专员 → 资深面试官 → HR 主管
4. 任务与简历数据 SQLite 持久化，支持任务历史回看
5. 复用 DeepChat 已配置的模型 Provider，功能页内可选模型（默认取应用当前默认模型）

### 非目标（本版不做）

- 不做多用户账号体系（本地单用户，姓名/邮箱为可编辑的本地设置）
- 不做简历报告导出（md/xlsx）
- 不做与"单据档案"人才库的自动联动（仅字段结构对齐，见 §7）
- 不做简历去重、跨任务统计报表

## 2. 决策记录

| 决策点 | 结论 |
| --- | --- |
| 项目基线 | 全新独立实现，不依赖工作区既有 resume-filter-project 代码 |
| 实现形态 | DeepChat 应用内新功能页（原生 Tab，方案 A） |
| 用户体系 | 本地单用户；姓名/邮箱存本地设置，可编辑 |
| 模型接入 | 单一模型跑全部五角色；功能页提供选择器，默认取 DeepChat 默认模型 |
| 数据存储 | SQLite 表 + 简历原文文件存 userData 磁盘目录 |
| 功能范围 | 按截图全量实现 |
| 主题 | 跟随应用深/浅色主题（现有 CSS 变量） |
| 简历上限 | 单任务 ≤20 份（超限禁选并提示） |

## 3. 入口与页面结构

### 改动点

1. 路由注册：`src/renderer/src/router/index.ts` 路由表新增
   `{ path: '/resume-screening', name: 'resume-screening', component: 懒加载, meta: { titleKey: 'routes.resume-screening', icon: 'lucide:file-search' } }`
2. 侧边栏入口：`src/renderer/src/components/WindowSideBar.vue` 参照现有"单据档案"按钮
   （`openDocuments()` 模式）新增"简历筛选"按钮 → `router.push({ name: 'resume-screening' })`
3. 页面组件：新建 `src/renderer/src/pages/resume-screening/` 目录：

```
ResumeScreeningPage.vue        页面骨架（左右两栏布局、任务态状态机）
components/
  JdInputCard.vue              岗位描述卡片（文本/文件 Tab）
  ResumeUploadCard.vue         简历文件卡片（选择/列表/移除/上限提示）
  ScreeningConfigCard.vue      筛选配置卡片（开关×2 + 并发数）
  ReviewButton.vue             智能审阅主按钮（运行中变取消）
  TaskHistoryList.vue          任务历史列表（状态徽标 + 时间）
  UserProfileBadge.vue         当前用户（姓名/邮箱，点击编辑）
  TaskHeader.vue               右栏任务头部（状态/进度/提交人/起止时间）
  StatsCardsRow.vue            统计卡片行（总数/成功/失败/平均分/推荐人数）
  JdContentTabs.vue            JD 内容 Tab（工作职责/岗位要求/加分项）
  ResumeTabsBar.vue            简历 Tab 条（候选人姓名 + 状态色点）
  ResumeDetailPanel.vue        简历详情（推荐总结 + 五段 Tab）
  ModelSelector.vue            模型选择器
```

### 页面布局（ASCII）

```
┌────────┬──────────────────────────────────────────────────────────┐
│ 侧边栏  │ 简历筛选助手              [模型选择器] [用户名/邮箱 ▾]      │
│        │ ┌──────────────┬─────────────────────────────────────┐   │
│  聊天   │ │ 岗位描述      │ 任务头部：状态 · 进度 x/y             │   │
│  插件   │ │ [文本|文件]   │          提交人+邮箱 · 起止时间       │   │
│  单据   │ │ (textarea /  ├─────────────────────────────────────┤   │
│ ▸简历  │ │  选择文件)    │ [简历总数][成功][失败][平均分][推荐数]  │   │
│  设置   │ ├──────────────┼─────────────────────────────────────┤   │
│        │ │ 简历文件      │ [工作职责|岗位要求|加分项]  ← JD 内容  │   │
│        │ │ (多选≤20,    ├─────────────────────────────────────┤   │
│        │ │  列表可移除)  │ [张三●|李四○|王五◐|...]  ← 简历 Tab 条 │   │
│        │ ├──────────────┼─────────────────────────────────────┤   │
│        │ │ 筛选配置      │ 推荐总结（置顶卡片）                  │   │
│        │ │ 生成解释 [✓]  │ [简历信息|初筛结论|面试信息|HR意见|优势] │   │
│        │ │ 返回原文 [✓]  │ （五段 Tab 内容区）                  │   │
│        │ │ 并发数 [3▾]   │                                     │   │
│        │ ├──────────────┤                                     │   │
│        │ │ [智能审阅]    │                                     │   │
│        │ ├──────────────┤                                     │   │
│        │ │ 任务历史      │                                     │   │
│        │ │ ● 运行中 ...  │                                     │   │
│        │ └──────────────┴─────────────────────────────────────┘   │
└────────┴──────────────────────────────────────────────────────────┘
```

### 交互要点

- 智能审阅按钮：校验 JD 非空 + ≥1 份简历 → 可用；运行中变为「取消」按钮
- 任务历史点击 → 加载任务详情（`getTask`），右栏切换为该任务视图
- 简历 Tab 状态色点：灰=待处理、蓝=运行中、绿=完成、红=失败
- 空状态：右栏显示引导文案（无任务且无选中历史时）
- 简历详情五段 Tab：简历信息（结构化字段展示）、初筛结论（分数/推荐/结论）、
  面试信息（亮点/风险/建议问题）、HR 意见（综合建议 + 推荐总结）、优势（列表）
- "返回原文"开关开启时，简历信息 Tab 额外展示提取的简历原文（`raw_text`）

## 4. 数据模型（SQLite）

遵循现有表类模式（`BaseTable` + schemaCatalog 注册，存量库靠 `CREATE TABLE IF NOT EXISTS`
自动补建，无需迁移 SQL）。参照先例：`src/main/documents/data/tables/documentTasks.ts`。

### 表 `resume_screening_tasks`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | randomUUID |
| status | TEXT CHECK | queued / running / completed / partial / failed / cancelled |
| jd_source | TEXT CHECK | text / file |
| jd_text | TEXT | JD 原文（文本输入或文件提取结果） |
| jd_file_name | TEXT NULL | JD 文件名（file 来源时） |
| jd_analysis_json | TEXT NULL | JD 解析官输出 {responsibilities, requirements, preferred} |
| config_json | TEXT | {generateExplanation, includeRawText, maxConcurrency} |
| provider_id | TEXT | 本次任务使用的 Provider |
| model_id | TEXT | 本次任务使用的模型 |
| total | INTEGER | 简历总数 |
| succeeded | INTEGER DEFAULT 0 | |
| failed | INTEGER DEFAULT 0 | |
| avg_score | REAL NULL | 完成简历的平均分 |
| recommended_count | INTEGER DEFAULT 0 | 推荐人数 |
| created_by_name | TEXT | 提交人姓名（来自本地设置） |
| created_by_email | TEXT | 提交人邮箱 |
| started_at | INTEGER NULL | 毫秒时间戳 |
| finished_at | INTEGER NULL | |
| created_at / updated_at | INTEGER | Date.now() |

索引：`idx_resume_screening_tasks_status (status, created_at DESC)`

### 表 `resume_screening_resumes`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | randomUUID |
| task_id | TEXT NOT NULL | 所属任务 |
| file_name | TEXT | 原始文件名 |
| file_path | TEXT | 磁盘路径（`userData/app_files/resume-screening/{taskId}/{id}.{ext}`） |
| mime_type | TEXT | |
| size | INTEGER | 字节 |
| candidate_name | TEXT NULL | 提取员识别的姓名 |
| raw_text | TEXT NULL | 提取的简历原文 |
| resume_info_json | TEXT NULL | 提取员输出（结构化简历信息） |
| screening_json | TEXT NULL | 初筛专员输出 {score, recommended, conclusion, strengths} |
| interview_json | TEXT NULL | 面试官输出 {highlights, risks, questions} |
| hr_json | TEXT NULL | HR 主管输出 {finalSummary, hrOpinion} |
| score | REAL NULL | 冗余自 screening_json.score（便于统计） |
| recommended | INTEGER NULL | 0/1 |
| status | TEXT CHECK | pending / running / done / failed |
| error | TEXT NULL | 失败原因 |
| created_at / updated_at | INTEGER | |

索引：`idx_resume_screening_resumes_task (task_id, created_at)`

### 装配与注册

1. 表类：`src/main/resumeScreening/data/tables/resumeScreeningTasks.ts`、
   `resumeScreeningResumes.ts`（`extends BaseTable`，`getLatestVersion()=1`、
   `getMigrationSQL()=null`）
2. 注册：`src/main/data/schemaCatalog.ts` — `CATALOG_DEFINITIONS` 尾部追加两个条目 +
   `createMainSchemaCatalog()` 的 `createTables` 数组实例化
3. 领域封装：`src/main/resumeScreening/data/database.ts`（`ResumeScreeningDatabase implements
   DatabaseConnectionProvider`，仿 `DocumentsDatabase`）
4. 装配：`src/main/app/composition.ts`（~901 行 documents 装配附近）实例化并注入 service

### 简历文件存储

- 目录：`userData/app_files/resume-screening/{taskId}/{resumeId}.{ext}`
- 创建任务时从用户选择位置复制；DB 存相对信息与路径
- 用户身份：settings 机制新增 `resumeScreening.profile` 键 `{name, email}`，
  经现有 settings 路由读写（无需新表）

## 5. 多角色流水线

### 角色与数据流

```
JD ──► ① jd_analyst  JD解析官（每任务 1 次）
        输出: { responsibilities: string[], requirements: string[], preferred: string[] }

每份简历（简历之间并发，受 config.maxConcurrency 限制；同一简历内串行）：
  ② extractor   简历原文 → 结构化简历信息（resume_info_json）
  ③ screener    JD分析 + 简历信息 → { score: 0-100, recommended: bool, conclusion, strengths[] }
  ④ interviewer JD分析 + 简历信息 → { highlights[], risks[], questions[] }
  ⑤ hr_manager  ②③④ 全部输出 → { finalSummary, hrOpinion }
```

### 实现要点

- 服务：`src/main/resumeScreening/service.ts` — `ResumeScreeningService`
  - `createTask()`：校验（JD 非空、简历 1–20 份）→ 复制文件 → 落库（queued）→ 入队启动
  - 任务运行器：并发池（简单信号量实现，上限 = maxConcurrency，默认 3，范围 1–5）
  - 每份简历状态机 pending → running → done/failed；单份失败不中断任务（任务级 partial）
  - 取消：AbortController 贯穿全部 LLM 调用；任务标 cancelled，未完成简历统一标
    failed 且 error 注明"已取消"
- LLM 调用：`src/main/resumeScreening/llmInvoker.ts`
  - `providerRuntime.executeWithRateLimit(providerId, { signal })` +
    `generateCompletionStandalone(providerId, messages, modelId, temperature, maxTokens,
    { signal, swallowErrors: false })`
  - JSON 输出：system prompt 强约束纯 JSON + `jsonrepair` 解析 + 一次带上下文重试
    （将首次输出作为 assistant 消息回填并附加修正指令，参照 DocumentExtractor 模式）
- 提示词：`src/main/resumeScreening/prompts.ts` — 五角色中文 system prompt，
  各自声明输出 JSON schema
- 文本提取：`src/main/resumeScreening/textExtractor.ts` — 按扩展名分派到现有
  `src/main/file/adapters/` 体系（`PdfFileAdapter` / `DocFileAdapter` / `TextFileAdapter`）
  的 `getContent()`；JD 文件同理；提取失败则该简历记为 failed
- 事件推送：状态变更即 `publishDeepchatEvent`（见 §6）

## 6. IPC 契约与事件

双通道契约架构（`deepchat:route:invoke` + `deepchat:event`），preload 零改动。

### 路由契约（新建 `src/shared/contracts/routes/resumeScreening.routes.ts`）

| 路由 | 输入 | 输出 |
| --- | --- | --- |
| resumeScreening.createTask | { jdSource, jdText?, jdFilePath?, jdFileName?, resumes: [{path, name, mimeType, size}]≤20, config: {generateExplanation, includeRawText, maxConcurrency 1-5}, providerId?, modelId? } | { taskId } |
| resumeScreening.getTask | { taskId } | { task, resumes[] }（含全部报告 JSON） |
| resumeScreening.listTasks | { limit? } | { tasks[] }（轻量，不含简历） |
| resumeScreening.cancelTask | { taskId } | { ok } |
| resumeScreening.getProfile | {} | { name, email } |
| resumeScreening.updateProfile | { name?, email? } | { profile } |
| resumeScreening.listModels | {} | { models: [{providerId, providerName, modelId, isDefault}] } |

- createTask 未显式指定模型时，主进程回退默认模型（`agentSettings.getDefaultModel()`）
- `listModels` 基于现有 provider 列表（启用中的模型），标记当前默认

### 事件契约（新建 `src/shared/contracts/events/resumeScreening.events.ts`）

| 事件 | payload（快照模式，防乱序） |
| --- | --- |
| resumeScreening.task.updated | { taskId, status, progress: {done, total}, stats: {succeeded, failed, avgScore, recommendedCount} } |
| resumeScreening.resume.updated | { taskId, resumeId, status, stage: 'extracting'\|'screening'\|'interviewing'\|'hr'\|null } |

- 注册：`src/shared/contracts/routes.ts`（目录 + 导出）、`src/shared/contracts/events.ts`
- 主进程经 `publishDeepchatEvent` 发布（广播至主窗口即可，单用户场景无需定向）

### 渲染层

- 新建 `src/renderer/src/api/ResumeScreeningClient.ts`（invoke + `bridge.on` 封装），
  在 `src/renderer/api/index.ts` 导出
- 模型选择器数据经 `resumeScreening.listModels`，不直接依赖 ProviderClient

## 7. 模型接入

- 默认值：DeepChat 当前默认模型（主进程 `agentSettings.getDefaultModel()`）
- 选择器：功能页顶栏展示，可选范围 = 已启用 Provider 的启用模型（去重）
- 调用路径：全部在主进程经 `providerRuntime`，apiKey/baseURL 不出主进程（现有安全边界）
- 任务落库 provider_id/model_id，任务卡片可展示所用模型

## 8. 结构化提取字段（与单据档案对齐）

extractor 角色输出 schema 参照现有简历识别模板
`docs/superpowers/specs/templates/resume.yaml`（resume_v1）：姓名/性别/手机/邮箱/出生年月/
最高学历/毕业院校/专业/毕业时间/工作年限/最近任职公司/最近职位/求职意向/期望薪资/
技能标签/工作经历（一对多）/教育经历（一对多）。

仅对齐字段结构，不引入对单据档案代码的运行时依赖。

## 9. i18n 与主题

- `src/renderer/src/i18n/<locale>/routes.json`：20 个 locale 各加
  `"resume-screening": "简历筛选"`（对应语言译文）
- 新命名空间 `src/renderer/src/i18n/<locale>/resumeScreening.json` × 20 locale：
  页面全部文案（卡片标题、按钮、状态徽标、Tab 名、统计标签、错误提示、空状态等）；
  zh-CN / en-US 完整翻译，其余 18 个 locale 以英文文案兜底（满足 `scripts/validate-i18n.mjs`）
- 主题：使用应用现有 CSS 变量与 shadcn-vue 原语，深浅色自适应

## 10. 改动文件清单（汇总）

**新建（主进程）**
- `src/main/resumeScreening/index.ts`（服务入口）
- `src/main/resumeScreening/service.ts`（任务编排/并发/状态机）
- `src/main/resumeScreening/prompts.ts`（五角色提示词）
- `src/main/resumeScreening/llmInvoker.ts`（LLM 调用 + JSON 解析重试）
- `src/main/resumeScreening/textExtractor.ts`（简历/JD 文本提取分派）
- `src/main/resumeScreening/routes.ts`（路由表工厂）
- `src/main/resumeScreening/data/database.ts`
- `src/main/resumeScreening/data/tables/resumeScreeningTasks.ts`
- `src/main/resumeScreening/data/tables/resumeScreeningResumes.ts`

**新建（共享契约）**
- `src/shared/contracts/routes/resumeScreening.routes.ts`
- `src/shared/contracts/events/resumeScreening.events.ts`

**新建（渲染层）**
- `src/renderer/src/pages/resume-screening/`（页面 + 12 个子组件，见 §3）
- `src/renderer/src/api/ResumeScreeningClient.ts`

**修改（现有文件）**
- `src/renderer/src/router/index.ts`（路由）
- `src/renderer/src/components/WindowSideBar.vue`（侧边栏按钮）
- `src/shared/contracts/routes.ts`（路由目录注册）
- `src/shared/contracts/events.ts`（事件目录注册）
- `src/main/data/schemaCatalog.ts`（两张表注册）
- `src/main/app/composition.ts`（域装配 + 路由表注册）
- `src/renderer/src/i18n/<locale>/routes.json` × 20（入口标题）
- `src/renderer/src/i18n/<locale>/resumeScreening.json` × 20（新建）
- `src/renderer/src/i18n/index.ts`（如命名空间需显式声明则同步）

**零改动**：`src/preload/*`（契约目录自动扩展类型）

## 11. 测试与验证策略

- 表类测试：`test/main/resumeScreening/tables.test.ts`（`:memory:` 库测建表 + CRUD，
  仿 `test/main/documents/documentsTables.test.ts`，原生模块缺失时 describe.skip）
- 服务测试：`test/main/resumeScreening/service.test.ts`（mock llmInvoker：
  任务编排、并发上限、单份失败→partial、取消传播、统计列正确性）
- 提示词/解析测试：JSON 解析（含 jsonrepair 失败→重试→报错路径）
- 渲染层：页面关键交互的组件测试（Vitest + Vue Test Utils，mock ResumeScreeningClient）
- 回归：`pnpm typecheck`、`pnpm lint`、i18n 校验、相关测试套件

## 12. 风险与开放问题

| 风险 | 缓解 |
| --- | --- |
| PDF 为扫描件（无文本层）导致提取为空 | textExtractor 提取结果为空 → 该简历标 failed，错误信息提示"疑似扫描件，请使用含文本层的 PDF"；OCR 不在本版范围 |
| 模型输出不稳定（JSON 截断/字段缺失） | jsonrepair + 一次带上下文重试 + 必填字段校验，仍失败则该简历 failed |
| 长简历超出上下文 | extractor prompt 声明超长时优先保留结构化要素；maxTokens 按角色设置上限 |
| 20 locale 文案维护成本 | 非中英文 locale 英文兜底；后续由翻译流程补齐 |
| 大量并发请求触发 Provider 限速 | 复用 `executeWithRateLimit`；并发上限默认 3 且最大 5 |
| DocFileAdapter 对 .doc（老格式）支持有限 | 仅承诺 .docx；.doc 提示转换（实现时以 adapter 实际支持为准并做能力探测降级） |

## 13. 里程碑建议（供 writing-plans 参考）

1. M1 数据层：表类 + schemaCatalog 注册 + 领域封装 + 表测试
2. M2 契约与 IPC：路由/事件契约 + 目录注册 + 渲染层 Client
3. M3 流水线：prompts + llmInvoker + textExtractor + service（mock 验证）+ 服务测试
4. M4 渲染层 UI：页面骨架 + 左栏（创建/配置/历史）+ 右栏（任务/统计/JD/简历详情）
5. M5 装配与打磨：composition 装配、侧边栏入口、i18n 20 locale、主题走查、端到端手测
