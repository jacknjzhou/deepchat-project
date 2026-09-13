# Office Automation 实现计划

规范来源（设计权威）：`docs/features/deepchat-office-automation-plan.html`（第 3 章设计、5.1-5.3 代码骨架）。本文件是唯一执行跟踪器，不创建 tasks.md。

核心约束：

- 不修改 `DeepChatLoopEngine` / `processStream()`；核心侧变更仅 Slice 1（新文件 + 2 处单行注册）
- 发票识别不建独立 OCR Server，由 invoice-recognition Skill 指导视觉模型提取
- 百度搜索对接千帆 AI Search（`qianfan.baidubce.com/v2/ai_search/web_search`），API Key 复用百度千帆 provider 凭证
- 插件 stdio server 零依赖（插件不携带 node_modules，沿用 feishu 插件已验证模式）
- 代码风格 Oxfmt：单引号、无分号、100 列

---

## Slice 1 — baiduSearchServer 核心 in-memory 服务（Phase 1 核心）

目标：新增百度搜索内置工具服务，全部会话可用。

文件：

- 新建 `src/main/mcp/inMemoryServers/baiduSearchServer.ts`
- 修改 `src/main/mcp/inMemoryServers/builder.ts`（`case 'braveSearch'` 之后，约 L52 插入新 case）
- 修改 `src/main/mcp/settings.ts`（`DEFAULT_INMEMORY_SERVERS` 中 `braveSearch` 条目之后，约 L151 插入新条目）

步骤：

- [x] 1.1 新建 `baiduSearchServer.ts`，逐行对齐 `bochaSearchServer.ts` 模式：
  - 导入与 bocha 完全一致：`Server, Transport` 与 `CallToolResult, ContentBlock`（`@modelcontextprotocol/server`）、`z`（`zod`）、`toDeepChatJsonSchema`（`@shared/lib/zodJsonSchema`）、`axios`
  - `export class BaiduSearchServer`：`constructor(env?: Record<string, unknown>)`，`env.apiKey` 缺失时抛错（文案含"与千帆 provider 同一凭证"）；`startServer(transport: Transport)`
  - 单工具 `baidu_web_search`：zod 入参 `query`（必填）/ `count`（1-50，默认 10）/ `freshness`（enum noLimit|oneYear|oneMonth|oneWeek|oneDay，映射千帆 `search_recency_filter`）/ `siteFilter`（可选域名数组）；`annotations: { readOnlyHint: true, openWorldHint: true }`
  - 请求：`POST https://qianfan.baidubce.com/v2/ai_search/web_search`，`Authorization: Bearer ${apiKey}`，body 为 `messages` + `search_source: 'baidu_search_v2'` + `resource_type_filter: [{ type: 'web', top_k }]` + `search_filter`（siteFilter 存在时）；完整骨架见 HTML 5.2
  - 响应 `references[]` → `application/deepchat-webpage` resource 块（title/url/rank/content/siteName/publishedDate），与 Bocha 输出同构
  - 错误统一 `isError: true` 返回（axios 错误带状态码）
- [x] 1.2 `builder.ts`：import `BaiduSearchServer`，switch 新增 `case 'baiduSearch': return new BaiduSearchServer(env)`
- [x] 1.3 `settings.ts`：新增条目 `{ args: [], descriptions: 'DeepChat内置百度搜索服务（千帆 AI Search）', icons: '🔎', type: 'inmemory' as MCPServerType, command: 'baiduSearch', env: { apiKey: 'YOUR_QIANFAN_API_KEY' }, disable: false }`

依赖：千帆平台开通「智能搜索生成服务」；apiKey 填写与千帆 provider 相同的 API Key（Bearer 认证）。

完成条件：`pnpm run typecheck` 通过；MCP 设置页出现百度搜索服务，填 Key 启用后会话内 `baidu_web_search` 返回结果。

---

## Slice 2 — office-automation 插件骨架 + 设置页（Phase 1）

目标：插件可加载、可配置、2 个 stdio server 以骨架态注册。

文件（模板均为 `plugins/feishu/` 对应文件）：

- 新建 `plugins/office-automation/plugin.json`
- 新建 `plugins/office-automation/mcp/reimbursementServer.mjs`、`mcp/workflowServer.mjs`（骨架态）
- 新建 `plugins/office-automation/settings/index.html`、`settings/assets/index.js`、`settings/assets/index.css`
- 新建 `plugins/office-automation/types/settings-preload.d.ts`（直接复制 feishu 同名文件）

步骤：

- [x] 2.1 `plugin.json` 按 HTML 5.1（模板 `plugins/feishu/plugin.json`）：
  - `id: "com.deepchat.plugins.office-automation"`；`capabilities: ["runtime.manage", "mcp.register", "skills.register", "settings.contribute"]`（不声明 `process.execDeclared`）
  - `mcpServers` 2 个 stdio 条目：`command: "node"`，`args: ["${plugin.root}/mcp/reimbursementServer.mjs"]` / `["${plugin.root}/mcp/workflowServer.mjs"]`，`startMode: "onDemand"`
  - `skills` 4 条（Slice 3/5 落地文件，条目先行声明）；`settingsContributions`（`placement: "plugins"`、`entry: "settings/index.html"`、`preloadTypes: "types/settings-preload.d.ts"`）
  - `toolPolicies` 按 HTML 3.5 权限表（reimbursement：create/submit 为 ask，track/list 为 allow；workflow 同表）
  - `engines`/`source` 按最终发布方式决定；本地开发阶段可省略 `source`
- [x] 2.2 两个 `.mjs` 骨架，零依赖：
  - stdio 分帧（Content-Length 解析）复制 `plugins/feishu/mcp/serve.mjs` L29-L153 的 `sendFrame`/`sendResult`/`sendError`/stdin buffer 模式
  - 未配置凭证（config.json 缺 appId/appSecret）时进入 warning server：`tools/list` 返回单个 `*_configure` 提示工具，`tools/call` 返回 `isError` 引导文案（对齐 feishu warning 模式）
- [x] 2.3 配置约定：插件根 `config.json`（`appId` / `appSecret` / `brand`（feishu|lark）/ `preset` / `reimbursementTemplates`）；server 侧读取同 feishu `serve.mjs` 的 `loadConfig()`，env 兜底（`FEISHU_APP_ID` 等）
- [x] 2.4 设置页对齐 feishu `settings/assets/index.js`：`window.deepchatPlugin` bridge；`invokeAction('config.get' | 'config.set', payload)` 读写配置；`getStatus()` 展示插件启用态与 2 个 MCP server 运行态（Running/Stopped/Error/Disabled + lastError）；字段：飞书 App ID / App Secret / brand / preset / 报销模板（含千帆 apiKey 配置提示文案：填写与千帆 provider 相同 Key 后在 MCP 设置启用百度搜索）

完成条件：应用启动无插件加载错误；设置页可保存并写入 `config.json`；MCP 面板列出 2 个 server（骨架 warning 态可接受）。

---

## Slice 3 — invoice-recognition + office-reimbursement Skills（Phase 2）

目标：发票识别能力落地（零新增服务）。

文件：

- 新建 `plugins/office-automation/skills/invoice-recognition/SKILL.md`（内容 = HTML 5.3 成稿）
- 新建 `plugins/office-automation/skills/office-reimbursement/SKILL.md`

步骤：

- [x] 3.1 `invoice-recognition/SKILL.md`：frontmatter `name` / `description`（含中英触发词）/ `metadata.deepchatFeature: office-automation`；Runtime Context 段使用 `${OWNER_PLUGIN_ID}` / `${PLUGIN_ROOT}` 占位（对齐 `plugins/feishu/skills/feishu-tools/SKILL.md` 结构）；正文含提取模板 JSON、校验规则（价税合计=金额+税额、号码 8 位、代码 10-12 位、日期归一化）、Required Loop（HTML 5.3 已成稿，直接落地）
- [x] 3.2 `office-reimbursement/SKILL.md`：全流程编排（invoice-recognition 提取 → 用户确认 → `create_reimbursement` → `submit_reimbursement` → `track_reimbursement`；步骤清单见 HTML 3.4 卡片）

依赖：会话具备视觉能力（多模态模型或已配置 `defaultVisionModel`）；Skill 内置无视觉能力时的引导分支。

完成条件：插件管理中 2 个 Skill 可见并被激活；样例发票图片经视觉模型提取出完整 JSON 且通过校验规则。

---

## Slice 4 — office-reimbursement-server 工具实现（Phase 3）

目标：报销工具链真实可用（B 组 4 工具，HTML 3.3 B）。

文件：

- 修改 `plugins/office-automation/mcp/reimbursementServer.mjs`（骨架 → 实现）
- 新建 `plugins/office-automation/mcp/lib/feishuApproval.mjs`
- 新建 `plugins/office-automation/mcp/lib/formFiller.mjs`

步骤：

- [x] 4.1 `lib/feishuApproval.mjs`（零依赖，Node ≥20 全局 fetch）：
  - `tenant_access_token` 获取 + 内存缓存 + 过期刷新
  - 审批 API 封装：定义搜索（`approval/v4/approvals/search`）、定义详情（`approval/v4/approvals/:approval_code`）、实例创建（`approval/v4/instances`）、实例详情（`approval/v4/instances/:instance_id`）、批量实例详情（`approval/v4/instances/batch_get`）
  - baseURL 按 `brand` 切换：feishu `https://open.feishu.cn/open-apis` / lark `https://open.larksuite.com/open-apis`
- [x] 4.2 工具实现：`create_reimbursement`（草稿创建，关联发票 JSON 与附件路径）/ `submit_reimbursement`（表单映射 → 审批实例创建，返回 instance_id）/ `track_reimbursement`（实例详情 → 当前节点/审批人/状态）/ `list_reimbursements`（本地记录列表）
- [x] 4.3 `lib/formFiller.mjs`：发票 JSON → 审批表单字段映射（`formFiller` 按定义 form 字段类型映射 text/amount/date）
- [x] 4.4 `plugin.json` toolPolicies 与实现对齐（HTML 3.5）

完成条件：HTML 3.6 场景一全链路手动走通（3 张样例发票 → 汇总 → 创建 → 确认提交 → 追踪）。

---

## Slice 5 — office-workflow-server + 剩余 Skills（Phase 4/5）

目标：通用流程提交与定时任务能力。

文件：

- 修改 `plugins/office-automation/mcp/workflowServer.mjs`
- 新建 `plugins/office-automation/skills/process-submission/SKILL.md`
- 新建 `plugins/office-automation/skills/office-scheduler/SKILL.md`

步骤：

- [x] 5.1 工具实现（C 组 8 工具，HTML 3.3 C）：`search_workflow_definitions` / `get_workflow_definition` / `submit_workflow` / `track_workflow` / `approve_workflow` / `list_pending_approvals` / `cancel_workflow` / `register_workflow_callback`
  - `register_workflow_callback`：桌面端无公网事件订阅端点，实现为本地轮询——工具内部引导创建 cronjob（Agent Tool `cronjob`）定时调用 `track_workflow` 并投递通知；不直连飞书事件回调
  - `approve_workflow`：飞书审批同意/拒绝需用户身份（user_access_token）；仅应用身份可用时返回明确错误引导用户到飞书客户端人工审批（不做 OAuth 流程，见未决问题）
- [x] 5.2 两个 SKILL.md（步骤清单见 HTML 3.4 卡片；office-scheduler 含 cron 任务模板与 delivery targets 说明）

完成条件：HTML 3.6 场景二、三手动验证通过。

---

## Slice 6 — 场景联调与质量门

- [x] 6.1 按 HTML 3.6 场景一/二/三手动走查；每个 Slice 独立可交付（Phase 分期与 HTML 4.1 对齐）
- [x] 6.2 测试选型（implementation-first）：默认不新增测试；`test/main` 无 in-memory server 测试先例。仅当千帆响应映射出现回归时，补最小契约测试 `test/main/mcp/inMemoryServers/baiduSearchServer.test.ts`（仅覆盖请求体构造与 references→resource 映射）
- [x] 6.3 交接前运行：`pnpm run format`、`pnpm run lint`、`pnpm run typecheck`；`pnpm run i18n` 不适用（插件设置页为纯 HTML，沿用 feishu 先例，未改 renderer）
- [x] 6.4 提交规范：Conventional Commits（`type(scope): subject` ≤50 字符），常规 PR 目标 `dev` 分支，无 AI co-author

---

## 未决问题（不阻塞 Slice 1-3）

- `approve_workflow` 用户身份：是否引入飞书 user_access_token OAuth 流程（当前按"返回错误引导人工审批"实现）
- `register_workflow_callback` 轮询通知的投递渠道（系统通知 / 会话消息）待产品确认
- baiduSearchServer 自动读取千帆 provider Key（`InMemoryServerDependencies` 注入 provider 凭证服务）为可选增强，默认 env 手动配置
- 千帆 AI Search 响应字段（`references[].content` / `publishDate` 等）以官方文档实测为准，对接时若字段名有出入在 1.1 内修正
