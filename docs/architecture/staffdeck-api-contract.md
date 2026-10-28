# StaffDeck 数字员工接口契约

本文档梳理 OfficeAgent 客户端对 StaffDeck 服务端的全部 HTTP 调用：端点、请求参数、响应约定与容错语义。实现分布在 `src/main/digital-employee/` 下，各节标注了对应实现文件。

## 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | 设置页配置的 StaffDeck 服务地址，去掉尾部斜杠后拼接路径；设置里存的是主机根，`/api/v1` 由客户端拼接 |
| 认证 | 所有请求带 `Authorization: Bearer <apiKey>`；key 由 secretStore 加密存储，不回传 renderer |
| 错误响应 | 非 2xx 时客户端解析 `application/problem+json`（`{ code, detail }`）抛 `StaffdeckProblemError`；响应体不可解析时降级为 `HTTP_<status>` |
| 超时 | 普通请求 10s；SSE 流 120s 空闲超时；测试连接 10s |
| `externalUserId` | 仅出现在**执行期** body 字段（建会话、发起 run）；员工列表的过滤完全由凭证绑定决定，换 user id 不会看到另一批员工 |

## 1. 员工列表

`GET /api/v1/digital-employees`

- 实现：`src/main/digital-employee/provider.ts`（`HttpDigitalEmployeeProvider.list`）
- Headers：`accept: application/json`；持有 ETag 时带 `If-None-Match`
- 响应：`{ employees: [...], fetchedAt }`，经 `digitalEmployeeListRoute.output.parse` 校验；`fetchedAt` 缺失时本地补当前时间
- 缓存：命中 304 直接返回上次缓存；无缓存却收到 304 视为错误
- 同一端点也被设置页「测试连接」复用

## 2. 测试连接（设置页）

实现：`src/main/digital-employee/settingsRoutes.ts`

| 请求 | 目的 | 判定 |
| --- | --- | --- |
| `GET /api/v1/digital-employees` | 校验 key 有效与列表结构合法 | 非 2xx 映射为失败码；响应体解析失败为 `invalidResponse` |
| `GET /api/v1/mcp/agents/deepchat-scope-probe` | 探测 key 是否有 `mcp:invoke` scope | 路径中的员工 id 是固定占位符（服务端不读取）；**405 = 通过**，401/403 = 缺 scope；网络异常不判失败（避免把网络抖动报成权限问题） |

## 3. 技能包下载（skillSync）

`GET /api/v1/digital-employees/{employeeId}:export-skill?slug={slug}`

- 实现：`src/main/digital-employee/skillSync.ts`（`exportUrl`）
- Headers：`Accept: application/zip`
- Query：`slug` 为服务端技能标识（URL 编码）
- 响应：zip 字节流；空响应体按失败处理。实测包内仅一个 `SKILL.md`，正文以 `# 标题` 直接开头，**不带 frontmatter**——本地安装器要求 frontmatter 含非空 `name` 否则拒装，客户端先经 `ensureSkillFrontmatter` 注入最小合法 frontmatter（`name` 取清洗后的 slug，`description` 取服务端显示名）再安装
- 本地后处理：SKILL.md 的 frontmatter `name` 会被改写为员工前缀名（`employeeSkillName`）后安装进 `deepchat` agent 技能目录
- 注意：下载 URL 由客户端基于自己的 baseUrl 重建，不信任服务端下发的 `downloadUrl`（其 `tool_base_url` 默认指向 `localhost:5173`）

slug 不属于该员工时返回 404 + problem+json（实测样本；`code`/`detail` 即 `StaffdeckProblemError` 的字段）：

```jsonc
{
  "type": "urn:staffdeck:error:skill_not_found",
  "title": "SKILL_NOT_FOUND",
  "status": 404,
  "code": "SKILL_NOT_FOUND",
  "detail": "This skill is not distributed to the requested employee.",
  "request_id": "req_..."
}
```

## 4. 知识库同步（knowledgeClient）

实现：`src/main/digital-employee/knowledgeClient.ts`

| 请求 | 说明 |
| --- | --- |
| `GET /api/v1/digital-employees/{employeeId}/knowledge-packages` | 知识包清单。Headers：`If-None-Match`（命中 304 返回 null 表示「没变」）；响应含 `packages[]`（`knowledgeBaseId`、`name`、`version`、`configHash`、`concepts[]`、`conceptCount`）、`configVersion`、`ETag`；无 `knowledgeBaseId` 的包被丢弃 |
| `GET /api/v1/digital-employees/{employeeId}/knowledge-packages/{knowledgeBaseId}/concepts/{conceptId}` | 单概念 markdown 正文。Headers：`accept: text/markdown`；404 + `CONCEPT_NOT_FOUND`（或普通 404）返回 null 按正常竞态跳过，其余 404 抛错 |

### 同步开关（清单为空的首要原因）

清单是 opt-in 的：服务端（`backend/app/digital_employees/knowledge_sync.py`）只收录 `KnowledgeBaseVersion.metadata_json.deepchat_sync_enabled === true` 的知识库，未开启的库**根本不出现**（不泄露存在性）。据此：

- 全空清单（`configVersion=kv1:4f53cda18c2b`，空配置的 hash）是服务端**默认状态**，不是故障——客户端按「员工未配知识」处理，不重试、不报错、不标 stale
- 管理端 UI 没有这个开关（前端源码零引用），只能调 `PUT /api/enterprise/knowledge-bases/{kbId}?agent_id={agentId}`（admin token）把 `deepchat_sync_enabled: true` 放进请求 `metadata`。注意该端点对 metadata 是**整体替换**（仅保留 creator 键），请求必须携带现有 metadata 全量键
- 普通员工的开关写在**该员工的分支版本**上（`?agent_id=` 路径），改整体库版本对员工分支不生效；员工可见性还要求 `AgentKnowledgeBranch` active + 资源绑定 active
- 方向确认（2026-10-28）：`/api/enterprise/knowledge-bases` 的能力（列表、概念、统计）将由服务端封装进 `/api/v1/*` 并以 api key 鉴权，客户端**不需要也不应该**引入管理端登录；封装端点上线前，`knowledge-packages`（已含 name/version/conceptCount/hash）+ 员工列表 `knowledgeBaseIds` 足以承载同步与检索，新端点主要用于补展示信息（描述、chunk 统计）
- 清单内每个概念带 `hash`（正文 sha256 前 16 位）与 `size`（UTF-8 字节数），客户端据 hash 做增量、跳过未变概念

## 5. 远程会话与执行（remoteClient）

实现：`src/main/digital-employee/remoteClient.ts`

| 端点 | Method | 请求参数 |
| --- | --- | --- |
| `/api/v1/agents/{employeeId}/sessions` | POST | body：`{ external_session_id, external_user_id, title, metadata }`；响应：`{ id }` |
| `/api/v1/agents/{employeeId}/runs:stream` | POST | Headers：`accept: text/event-stream`、`content-type: application/json`、`idempotency-key: <runKey>`。body：`{ input, session_id, external_user_id, session_mode: 'stateful', metadata: { source: 'deepchat' } }`，有附件时附 `attachments`（见下）。响应头 `X-Run-ID` 携带 run id（缺失即失败），之后为 SSE 流 |
| `/api/v1/runs/{runId}/events` | GET | 断线续传（`runs:stream` 无法重放）。Headers：`accept: text/event-stream`，`last-event-id`（数字 id，服务端取 max） |
| `/api/v1/runs/{runId}/result` | GET | 终态结果补查。响应经 `staffdeckRunResultSchema` 校验（`awaiting_input` 场景可能缺正文，契约有默认值） |
| `/api/v1/runs/{runId}:cancel` | POST | 取消执行。404 视为「已取消」，不算失败 |

### 附件描述符（`attachments[]`）

`src/main/digital-employee/remoteAttachments.ts`：

```jsonc
{
  "id": "...",
  "filename": "...",
  "content_type": "text/plain | application/pdf | image/*",
  "size": 12345,
  "kind": "text" | "pdf" | "image",
  "data_url": "data:...;base64,...", // text/pdf/image 均可携带
  "text": "..."                      // kind=text 时可直接给正文
}
```

### SSE 流约定

- 每 15 秒一条 `: keepalive` 注释行，解析器跳过
- 未知事件名不得中断流（服务端会持续新增 trace 事件）
- 终止事件共 4 个：`run.output.completed`、`run.succeeded`、`run.failed`、`run.cancelled`——漏判会导致调用方永久等待
- 传输层中断必须抛错，不得当作「已完成」
- 错误码透传：服务端 problem+json 的 `code`/`detail` 转为 `StaffdeckProblemError`

## 6. 对话回流归档（backflow）

实现：`src/main/digital-employee/backflow.ts`。前置条件依次：功能开关已启用 → 连接三要素齐备 → 事件非空；任一不满足按 `DISABLED` / `NOT_CONFIGURED` / `EMPTY` 拒绝且不计投递。

| 端点 | Method | 请求参数 |
| --- | --- | --- |
| `/api/v1/agents/{employeeId}/sessions` | POST | 幂等 upsert（服务端按 `credential_id + external_session_id` 去重，重复调用返回同一行）。body：`{ external_session_id, external_user_id, title?, metadata: { source: 'deepchat' } }` |
| `/api/v1/agents/{employeeId}/sessions/{remoteSessionId}/events:batch` | POST | body：`{ events: [...] }`，每批最多 50 条（`DEFAULT_BATCH_SIZE`） |

### 回流事件结构（`events[]`，全 snake_case）

| type | 必填字段 | 可选字段 |
| --- | --- | --- |
| `message` | `event_id`, `role`, `content` | `created_at`, `metadata` |
| `tool_call` | `event_id`, `name`, `status` | `duration_ms`, `error_code`, `created_at` |
| `usage` | `event_id`, `prompt_tokens`, `completion_tokens`, `total_tokens` | `created_at` |

容错语义：

- 服务端会话 id 只存内存，缺失/404 时重建（代价是一次幂等建会话请求），重建后仍失败如实回报，不无限重试
- 批次失败即停止（不跳过后续批次）：已投递的空洞与丢失无法区分，调用方必须能从断点重发
- 网络/超时统一回报 `NETWORK`

## 7. MCP 工具端点（非 REST）

`POST /api/v1/mcp/agents/{employeeId}`

- 实现：`src/main/digital-employee/mcpRegistration.ts`（`buildConfig`）——客户端不直接调它，而是把它注册为 MCP server 由 MCP 客户端连接
- 协议：Streamable HTTP MCP；Headers 由 MCP 协议层附加（含 `Authorization: Bearer`）
- baseUrl 拼接：`{baseUrl}/api/v1/mcp/agents/{employeeId}`——缺少 `/api/v1` 段会导致每次 initialize 都 404
- 员工工具经 `staffdeck_` 前缀暴露；provision 时校验工具列表至少含一个该前缀工具，否则拒绝注册并清理旧注册（原因码 `NO_TOOLS`）
- 其他注册失败原因码：`NOT_CONFIGURED`（连接三要素缺失）、`REGISTER_FAILED`（配置写入失败）、`START_FAILED`（server 启动/连接失败）
