# 数字员工广场设计（对话能力的人格化封装）

日期：2026-10-21
状态：已确认（设计经用户确认，5 项澄清决策见 §2）

## 1. 背景与目标

用户希望有一个「数字员工广场」：在广场中浏览各领域数字员工（财务/销售/人事/IT/采购等），选择后进入对话交流。数字员工信息由独立系统接口对接获取。

核心定位：**数字员工 = 本地 Agent 的「人设 + 能力包」**。每个数字员工内建四类配置——知识库、技能、工具、SOP，这些配置在对话中真实加载生效，保证数字员工能力的独特性。对话本身仍复用现有会话体系与模型链路，客户端不做远端对话执行。

**目标（一期）**：
- 数字员工广场页：多 Tab + 卡片网格 + 搜索 + 能力筛选
- 选择数字员工 → 新建会话并注入四类内建能力 → 对话闭环
- 数据契约（zod）+ 主进程 Provider 层（mock 先行，预留 HTTP 对接）

**非目标（一期不做）**：
- 不做远端对话执行（数字员工不做独立推理服务）
- 不做「团队对话」多人协作（Tab 一期占位）
- 不做数字员工配置编辑 UI（配置来源于接口，客户端只读）
- 不把数字员工并入现有 agentStore（与 deepchat/acp Agent 体系隔离，零侵入）

## 2. 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 对话执行架构 | 人设包装：对话走现有本地会话体系，数字员工注入 system prompt 与能力配置 |
| 数据接口 | 接口未就绪：先定 zod 契约 + 主进程 mock Provider，接口就绪后切换 HTTP 实现（baseURL/鉴权可配） |
| 一期页面范围 | 广场列表页（含多 Tab）+ 选中进入对话，复用现有会话体系 |
| 与 Agent 体系关系 | 独立体系：独立 store + 顶级路由，不注册进 agentStore |
| 内建能力 | 知识库/技能/工具/SOP 四类配置为契约一等公民，对话中真实加载生效 |

## 3. 数据契约（zod）

新增 `src/main/digital-employee/contract.ts`：

```ts
export const sopDocumentSchema = z.object({
  title: z.string(),
  content: z.string()
})

export const digitalEmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),                       // 如「财务」「销售」
  description: z.string(),
  avatar: z.string().optional(),          // URL 或内置图标标识
  capabilities: z.array(z.string()),      // 能力标签，如「报销查询」「发票识别」
  greeting: z.string().optional(),        // 欢迎语，作为会话首条助手消息
  systemPrompt: z.string(),               // 角色人设（如 #角色：报销管家）
  sops: z.array(sopDocumentSchema),       // SOP 文档，注入 system prompt
  knowledgeBaseIds: z.array(z.string()),  // 引用现有知识库
  skillIds: z.array(z.string()),          // 引用现有技能目录
  tools: z.array(z.string()),             // MCP 工具名白名单
  enabled: z.boolean(),
  updatedAt: z.string()
})

export const digitalEmployeeListSchema = z.object({
  employees: z.array(digitalEmployeeSchema),
  fetchedAt: z.string()
})
```

## 4. 模块设计

### 4.1 主进程 Provider 层（参考 MCP 对接模式）

新增 `src/main/digital-employee/`：

- `contract.ts`：§3 的 zod schema 与 `DigitalEmployee` 类型
- `provider.ts`：`DigitalEmployeeProvider` 接口 `list(): Promise<DigitalEmployee[]>`
  - `MockDigitalEmployeeProvider`：内置约 10 个角色（财务/销售/项目管理/人事/IT/采购/数据分析/法务/行政/市场），对齐广场页截图；SOP/技能/工具/知识库配置为合理示例值
  - `HttpDigitalEmployeeProvider`：预留骨架，读配置的 baseURL/鉴权头；一期实现可直接抛「未配置」或返回空列表，接口就绪后补全
- `providerFactory.ts`：按配置选择 mock / http 实现（对齐 MCP server 配置管理模式）
- IPC handler：`digitalEmployee:list`（契约层注册路由，对齐 `config.routes.ts` 风格）

### 4.2 Renderer API Client

新增 `src/renderer/api/DigitalEmployeeClient.ts`：`list()` 方法，风格对齐 `ConfigClient`/`KnowledgeClient`（bridge 调用 + 类型导出）。

### 4.3 Renderer Store

新增 `src/renderer/src/stores/digitalEmployeeStore.ts`（参考 mcp store 模式）：

- state：`employees`、`loading`、`error`、`selectedDigitalEmployeeId`
- getters：`enabledEmployees`、`selectedDigitalEmployee`
- actions：
  - `fetchEmployees()`（启动/进入广场时拉取，错误降级到 mock）
  - `setSelectedDigitalEmployee(id | null)`
  - `toggleFavorite(id)`（「我的数字员工」Tab 数据源，本地持久化）
- 会话绑定状态：`activeConversationDigitalEmployeeId`（记录哪些会话由哪个数字员工创建，供聊天页徽标与能力注入判定）

### 4.4 广场页与路由

- 路由：`/digital-employees` 顶级路由（对齐 `/documents` 挂法），`titleKey: 'routes.digitalEmployees'`，icon 建议 `lucide:users-round`
- 侧边栏入口：`WindowSideBar.vue` 增加一项，位于「智能信息提取/文档」附近
- 新增 `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`

页面结构（对齐截图）：

- 左侧沿用现有侧边栏；顶部 Tab 四个：
  - **所有员工**（默认）：全部启用的数字员工网格
  - **我的数字员工**：收藏/最近使用的数字员工（本地持久化）
  - **团队对话**：一期占位（空态提示「团队协作即将上线」）
  - **数字员工广场**：全量浏览 + 搜索框 + 能力标签筛选
- 卡片：头像（AgentAvatar 复用或 image）/ 姓名 + @角色 / 角色描述 / 能力标签（chips）/ 资料·技能·SOP 计数（分别为描述文档数、skillIds.length、sops.length）
- 点击卡片 → 详情弹层（四类配置清单：SOP 文档列表、技能列表、工具白名单、知识库）→「开始对话」按钮

### 4.5 对话闭环与四类能力生效

进入对话：详情弹层「开始对话」→ 新建会话 → 跳转 `/chat` → 会话与数字员工绑定。

| 能力 | 生效机制 | 复用的现有链路 |
|---|---|---|
| SOP + systemPrompt | 会话创建时拼接为首条 system 消息（角色人设 + 逐条 SOP 段落） | 现有会话创建消息流 |
| 技能 | 数字员工映射为 skillsStore 的独立 agentId（`digital-employee:<id>`），技能目录按 agentId 天然隔离，chat 时随 prompt 链路注入 | `skillsStore`（`getSkillsForAgent(agentId)`，BUILTIN_AGENT_ID='deepchat' 的机制直接扩展） |
| 工具 | 会话级 MCP 工具白名单覆盖全局 `input_enabledMcpTools`：chat 请求扩展 `toolOverrides`，主进程 chat 路径合并 | mcp store 的 `enabledToolNames` 持久化机制 |
| 知识库 | 会话创建时绑定 `knowledgeBaseIds`，chat 时走知识库检索注入引用上下文 | `KnowledgeClient` / 现有知识库检索链路 |

聊天页：头部显示数字员工徽标（头像 + 姓名角标）；`greeting` 作为会话首条助手消息渲染。切回普通会话即恢复默认（无注入）。

**实现锚点提示**（plan 阶段细化）：
- 会话创建入口在 `session.ts`（ui store）与主进程会话链路，注入点需在 plan 中定位到具体函数
- `toolOverrides` 需扩展 chat 请求契约（shared contracts），主进程 chat 路径在组装 MCP 工具列表处合并
- 技能注入需要确认 `digital-employee:<id>` agentId 的技能目录由谁注册（主进程在会话创建时按 skillIds 解析，避免引入「技能安装」流程）

## 5. 国际化与文案

- `routes.digitalEmployees`、Tab 标题、空态文案、详情弹层标签（SOP/技能/工具/知识库）等新增文案，遵循项目 vue-i18n 20 locale 惯例（zh-CN 为主，其余 locale 同步补 key）。

## 6. 测试计划

- 主进程：contract zod 解析单测（合法/非法样本）、MockProvider 返回结构与必填字段、providerFactory 选择逻辑
- renderer store：fetch 降级、favorite 切换持久化、selected 绑定
- 广场页组件：Tab 切换渲染、搜索过滤、卡片字段渲染、详情弹层内容
- 能力注入：会话创建时 system 消息拼接（SOP 逐条渲染）、toolOverrides 传递、知识库绑定参数传递（store 层断言 client 调用参数）
- 测试纪律：vitest 与 vue-tsc 分开跑（避免 CPU 争抢超时假失败）

## 7. 里程碑拆分建议（供 writing-plans 参考）

1. **M1 契约 + 主进程 Provider + IPC + Client**（mock 数据先行，含单测）
2. **M2 广场页**（路由/侧边栏/Tab/卡片/搜索/详情弹层/收藏）
3. **M3 对话闭环**（会话创建注入 SOP+人设、greeting、徽标）
4. **M4 能力加载**（技能 agentId 映射、toolOverrides、知识库绑定）
5. **M5 i18n 全量补齐 + 定向回归**

M1-M3 交付最小可用（广场 + 人设对话）；M4 补齐四类能力真实加载。
