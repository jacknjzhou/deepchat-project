# deepchat 数字员工接入 StaffDeck 服务端方案

- 日期：2026-10-22
- 状态：设计已确认（由总设计文档拆分而来；建议移入 deepchat 仓库 `docs/superpowers/specs/` 维护并纳入其 SDD 流程）
- 范围：deepchat-project（fork：`jacknjzhou/deepchat-project`，基线分支 `202610211551`）。StaffDeck 侧改造见姊妹文档 `2026-10-22-staffdeck-server-side-design.md`
- 技术栈约束：Electron + Vue3 + TS + zod 契约路由 + Pinia + vue-i18n + Vitest；禁止新增运行时依赖；不改动现有 agentStore（deepchat/acp 体系零侵入）

---

## 1. 背景与目标

deepchat 已实现「数字员工广场」（设计见 `docs/superpowers/specs/2026-10-21-digital-employee-square-design.md`）：数字员工 = 人设 + 四类能力包（SOP/技能/工具/知识库），当前 10 个角色（财务/销售/项目管理/人事/IT/采购/数据分析/法务/行政/市场）为 mock 数据。

本方案将 mock Provider 替换为对接 StaffDeck 服务端，使 deepchat 成为数字员工的**使用入口 + 本地运行时**：

1. 广场与对话使用 StaffDeck 分发的真实数字员工配置；
2. 按员工 `executionMode` 分流：简单 SOP 本地注入执行，复杂 SOP 回源 StaffDeck 远端执行；
3. 技能、工具（MCP）、知识库三类能力真实生效；
4. 本地执行对话全量回流 StaffDeck 审计归档。

### 非目标

- 不做远端对话执行服务端（执行内核在 StaffDeck，deepchat 只是调用方）；
- 不把数字员工并入现有 agentStore（保持独立 store + 顶级路由）；
- 不上行 deepchat 本地配置（个人 MCP/插件留端侧自管）；
- 不做数字员工配置编辑 UI（配置来源于 StaffDeck，客户端只读）。

## 2. 已确认的关键决策（两端共识）

| 决策点 | 结论 |
|---|---|
| SOP 执行位置 | 混合模式：员工级 `executionMode`（local/remote/hybrid）；SOP 级 `execution_hint` **由服务端消费、不下发**，客户端无法据此逐条路由（见 §5.2 修订 3） |
| 鉴权 | 部署级共享密钥（`sd_live_` API key）；请求必带 `external_user_id` 标识端上用户 |
| 知识库 | 本地同步检索：StaffDeck 分发知识包，deepchat 落地本地副本并 `similarityQuery` |
| 数据回流 | 本地执行对话全量回流（本地队列 + 幂等重试） |
| 原则 | 配置和能力只下行，对话数据只上行 |

## 3. 共享数据契约（zod，两端锁定）

deepchat 侧现有契约（`src/shared/contracts/routes/digitalEmployee.routes.ts`）为权威起点，StaffDeck 分发 payload 以它为超集：

```ts
export const sopDocumentSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(20000)
})

export const digitalEmployeeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(50),
  role: z.string().min(1).max(50),
  description: z.string().max(500),
  avatar: z.string().max(256).nullable(),
  capabilities: z.array(z.string().min(1).max(30)).max(20),
  greeting: z.string().max(500).nullable(),
  systemPrompt: z.string().min(1).max(10000),
  sops: z.array(sopDocumentSchema).max(20),
  knowledgeBaseIds: z.array(z.string().min(1)).max(10),
  skillIds: z.array(z.string().min(1)).max(10),
  tools: z.array(z.string().min(1)).max(20),
  enabled: z.boolean(),
  updatedAt: z.string().min(1)
})
// StaffDeck 扩展字段（本方案新增消费）：
//   executionMode: 'local' | 'remote' | 'hybrid'
//   configHash: string          — 员工配置摘要，增量比对
//   skills: [{ id, name, downloadUrl }] — GeneralSkill 导出包下载信息
//   knowledgePackagesUrl — 该员工知识同步清单端点
```

- 增量拉取：`GET /digital-employees` 支持 `ETag`/`If-None-Match`，304 时沿用本地缓存；
- **契约守护**：StaffDeck 仓库以 deepchat `digitalEmployeeSchema` 为 fixture 做金样测试；deepchat 侧同样保留对真实分发样本的解析测试，两端永不漂移。

## 4. StaffDeck 服务端依赖（外部依赖清单）

| 能力 | 端点 | 状态 |
|---|---|---|
| 配置分发 | `GET /api/v1/digital-employees`、`/{id}`、`/{id}:export-skill` | StaffDeck M2 |
| 知识同步 | `GET /api/v1/digital-employees/{id}/knowledge-packages`、`/knowledge-bases/{kb}:export-manifest`、`/documents/{doc}:download` | StaffDeck M3 |
| MCP 工具网关 | `/api/v1/mcp`（streamable HTTP，工具命名空间 `staffdeck:{slug}`） | StaffDeck M4 |
| 远端执行 | `POST /agents/{id}/sessions` + `POST /agents/{id}/runs:stream`（SSE，Last-Event-ID 续传） | 已有 |
| 对话回流 | `POST /external-sessions`、`POST /external-sessions/{id}/events:batch` | StaffDeck M6 |
| 鉴权 | Bearer `sd_live_` 共享密钥；scopes 见 StaffDeck 方案 §8 | 已有 |

各端点协议沿用 StaffDeck OpenAPI v1 惯例：Idempotency-Key、ETag/If-Match、`application/problem+json`、X-Request-ID。

## 5. deepchat 侧改造设计

### 5.1 HttpDigitalEmployeeProvider 完整实现

现状：`src/main/digital-employee/provider.ts` 已有 `DigitalEmployeeProvider` 接口与 mock 实现，HTTP 骨架预留。

改造：
- `providerFactory.ts` 按运行配置选择 mock / http 实现（配置缺失时保持 mock，供离线与开发）；
- `HttpDigitalEmployeeProvider`：读取 `STAFFDECK_BASE_URL`、`STAFFDECK_API_KEY`、`STAFFDECK_EXTERNAL_USER_ID`（构建时注入，对齐 `docs/managed` 构建期端点注入惯例）；
- 拉取策略：进入广场/启动时拉取，命中 ETag 缓存则不重新解析；`configHash` 变化的员工标记「配置已更新」；
- 失败降级：网络/服务端错误 → 回落 mock 数据并在广场页显示「配置过期」横幅（复用现有 fetch 降级逻辑）。

### 5.2 executionMode 分流与远端执行通道

现状：广场「开始对话」→ 本地新建会话 → 注入 systemPrompt/能力。

改造：
- 按 `executionMode` 分流：
  - `local`：现有链路不变（SOP+人设 → systemPrompt 拼接；技能 → `digital-employee:<id>` agentId；工具 → MCP 白名单；知识 → 首条消息前 `similarityQuery`）；
  - `remote`：会话创建改调 `POST /agents/{id}/sessions`（携带 `external_session_id`=本地会话 id、`external_user_id`、`metadata.source="deepchat"`），消息经 `POST /agents/{id}/runs:stream`（SSE）发送，流式渲染进聊天窗；`awaiting_input` 由**终态后补查 `GET /runs/{id}/result`** 获得（不入 SSE 流），据 `question_summary` + `expected_fields` 在输入框上方展示提示条，用户的下一条普通消息即续跑（**不额外内嵌输入框**——回答本身就是一条消息，多一个输入框会让「发到哪个通道」变含糊）；
  - `hybrid`：**整会话可切换**（详见下方「D2 协议核实修订」第 3 条）；
- SSE 处理（已按 StaffDeck 实测修订）：`run.output.delta` 累积渲染；`run.output.completed` 仅作停止信号（**不携带正文**），终稿取 delta 累积并由 `GET /runs/{id}/result` 的 `reply` 兜底覆盖；断线改用 `GET /runs/{id}/events` 并携带 `Last-Event-ID`（整数 sequence）续传；`ACTION_BUDGET_EXHAUSTED` 等结构化错误码转为可理解的 UI 提示；
- 聊天页徽标扩展：`local`（端侧）/ `remote`（云端执行）标识。

> **D2 协议核实修订（2026-10-23，对照 StaffDeck 源码实测）**
>
> 本节的原始表述有 4 处与 StaffDeck 实际实现不符，已按源码修正。实施计划见 `docs/superpowers/plans/2026-10-23-staffdeck-d2-remote-execution.md`。
>
> 1. **`run.output.replace` 在服务端没有产生点**。该事件名仅存在于 `public_api/runs.py:50` 的映射表与 `core/agent_loop.py:481` 的落库集合中，全仓无任何 `_stream_event("stream_replace", ...)` 调用。因此不实现「整体替换」语义；解析层保留该事件名，收到时按「清空后重放」降级并告警。
> 2. **`awaiting_input` 不在 SSE 事件里**。它只出现在 `GET /runs/{id}/result`（`runs.py:307`）与 `GET /agents/{id}/sessions/{sid}`（`sessions.py:29`）的响应体中，结构见 `session_schema.py:137-143`。故必须终态后补查，不能指望流里推送。
> 3. **`execution_hint` 不下发到客户端**。服务端 `digital_employees/sop_text.py:152-154` 读取该 hint 后自行决定哪些 SOP 进入 `sops[]`，`payload.py:105` 只下发筛选结果。因此「按单条 SOP 路由」在客户端不可实现，hybrid 降级为**整会话可切换**：默认 local（与服务端筛选结果一致），用户显式切换后整会话走 remote，切换时把最近若干轮文本拼成上下文摘要注入远端首轮；同一本地会话不做往返切换。
> 4. **`run.output.completed` 不携带终稿**。其 payload 仅有 `execution_engine` / `turn_id` / `user_message_id`（`agent_loop.py:424-430` 构造，`runs.py:357-381` 转发）。终稿只能由 delta 累积，并以 `GET /runs/{id}/result` 的 `reply` 覆盖兜底。
>
> 另核实：SSE 每 15 秒发 `: keepalive` 注释行（`jobs.py:574-576`），解析器必须跳过；`X-Run-ID` 在响应头（`runs.py:464`）；终止事件除 `run.output.completed` 还有 `run.succeeded` / `run.failed` / `run.cancelled`（`jobs.py:385-395`）；`external_user_id` 是 body 字段而非 header（`schemas.py:139-140`），D1 遗留的 header 传法在 D2 一并改为 body。
>
> **D2 落地实测补充（2026-10-23 晚，本地起 StaffDeck 服务跑通全链路）**
>
> 计划中列为「待实测确认」的 3 个开放项已收敛：
>
> 1. **`run.status` 的 phase 只有一个取值 `planning`**。产生点是 `core/agent_loop.py:338` 唯一一处 `_stream_status(..., "planning", "正在规划本轮任务", ...)`；取消路径走独立事件 `stream_cancelled`（映射为 `run.cancelled`），其 payload 里的 `phase` 是 `cancelled` 而非 `run.status`。结论：`run.status` 不能用作细粒度进度提示，D2 不消费它（保持现状）。
> 2. **`awaiting_input` 场景下 job 仍是 `succeeded`**。`public_api/jobs.py:418-428` 的 handler 返回后无条件 `_terminalize_job(..., status="succeeded", stage="completed")`，`APIJob.status` 状态机只有 `queued / running / succeeded / failed / cancelled`，不存在 `awaiting_input`。因此 `GET /runs/{id}/result` 的 `status != "succeeded"` 守卫不会在追问场景误报 409，`awaiting_input` 从 `result_json` 顶层字段取（`runs.py:307`）——与 D2 现有实现一致，无需改调 `GET /sessions/{id}`。
> 3. **附件在 D2 不传**。`AgentRunCreate.attachments` 接受 `ChatAttachmentRead`（`session_schema.py:258-270`），与 deepchat 的 `MessageFile` 字段不同构；D2 远端首轮仅纯文本，附件能力留待后续。
>
> 实测同时确认了两个此前只能从源码推断的行为：
>
> - **服务端把执行期错误当作正文回复**：未配置默认模型时，流里推的是 `run.output.delta` 分片（内容为「Harness v2 执行出错（HARNESS_V2_ERROR）：…」），并以 `run.succeeded` 正常结束，`/result` 的 `reply` 也是这段文本。也就是说 `run.failed` 不是唯一的失败表达——正文可能是错误说明。UI 因此不能把「有正文」等同于「执行成功」，失败提示只由 `remoteRunUpdated` 的 `phase` 与 `messageCode` 驱动。
> - **`Idempotency-Key` 语义已验证**：同 key 同 body 重放返回同一 `job_id` 的完整流；同 key 不同 body 返回 409 `IDEMPOTENCY_CONFLICT`（problem+json，取 `code`）。D2 用 `deepchat:{sessionId}:{turnId}` 作确定性键，重试不会产生第二个 run。


### 5.3 技能导入

- 分发 payload 的 `skills[].downloadUrl` → 下载 `:export-skill` zip（SKILL.md 包格式，与 deepchat 技能目录同构）；
- 走现有 Skills 管理的导入能力装进 `digital-employee:<id>` agentId 隔离目录；主进程在会话创建时按 `skillIds` 解析注册，不引入「技能安装」确认流程（企业分发场景默认信任）；
- 仓库根 `skills/staffdeck-api-*` 4 个 OpenAPI 调用技能包可作为可选内置项安装（使本地 Agent 具备直接调用 StaffDeck OpenAPI 的能力）。

### 5.4 知识同步任务

- 新增后台同步器（主进程，worker 化）：
  1. `GET /digital-employees/{id}/knowledge-packages` 取清单（kb_version + 文档 hash 列表）；
  2. 与本地索引对比 hash，差异文档经 `:export-manifest` / `:download` 拉取；
  3. 重建本地知识库副本索引（复用现有 knowledgeClient / 本地向量检索）；
- 一致性规则：版本不齐（412/409）→ 全量重拉；同步失败 → 沿用旧副本 + `stale` 标记（对话 UI 可提示「知识可能过期」）；后台定时重试；
- 同步粒度按员工（只同步其 `knowledgeBaseIds`），不全量镜像租户知识。

### 5.5 MCP 白名单接入远端工具

- 员工 `tools[]` 中 `staffdeck:{slug}` 命名空间的工具 → 注册为 streamable HTTP MCP server（指向 `/api/v1/mcp`），由 deepchat 现有 MCP 客户端连接；
- 会话级工具白名单机制不变（`disabledAgentTools` 取补集）；
- 公共 MCP 工具（分发 payload 附连接信息、无凭证的）→ deepchat 本地直连，与远端工具在同一白名单体系中共存。

### 5.6 对话回流上报客户端

- 触点：本地执行会话（`executionMode=local` 及 hybrid 的本地段）每轮结束后上报；
- 实现：`POST /external-sessions`（`external_session_id` = 本地会话 id，幂等）建立映射 → 消息/工具调用/token 用量组批经 `POST /external-sessions/{id}/events:batch` 上报；
- 可靠性：本地 SQLite 队列暂存，指数退避重试；服务端 24h 幂等窗口，409 冲突视为已上报跳过；
- 隐私：上报内容与远端执行同一审计口径；用户可在设置中关闭回流（关闭时管理端无该会话记录，UI 明示）。

### 5.7 部署与配置注入

- 构建时/运行时配置：`STAFFDECK_BASE_URL`、`STAFFDECK_API_KEY`、`STAFFDECK_EXTERNAL_USER_ID`（端上用户唯一标识生成规则：首启生成 UUID 并持久化）、`STAFFDECK_SYNC_INTERVAL`（知识同步间隔）；
- 密钥存储走 deepchat 现有安全存储（对齐 MCP 凭证管理机制），不落明文配置文件。

## 6. 错误处理与降级（deepchat 侧）

| 故障 | 行为 |
|---|---|
| 分发 API 不可达 | 降级 mock（现有逻辑）+「配置过期」横幅 |
| 知识同步失败 | 旧副本 + stale 标记，后台重试 |
| 远端 runs 中断 | Last-Event-ID 续传；不可恢复时 hybrid 转本地模式，remote 明确报错并保留会话 |
| 回流上报失败 | 本地队列暂存 + 退避重试 |
| MCP 工具超时/预算耗尽 | 结构化错误码转 UI 提示，允许人工接管 |

## 7. 测试计划（deepchat 侧）

1. **契约解析测试**：真实分发样本（含扩展字段）过 `digitalEmployeeSchema` zod 解析；非法样本拒绝；
2. **Provider 测试**：ETag 缓存命中、降级 mock、configHash 变化标记；
3. **分流测试**：local/remote/hybrid 三类员工的会话创建参数与注入行为（store 层断言 client 调用参数，沿用现有测试纪律）；
4. **SSE 消费测试**：delta 追加 / replace 替换 / completed 停止 / Last-Event-ID 续传 / awaiting_input 续跑；
5. **知识同步测试**：hash 对比增量、stale 降级、全量重拉；
6. **回流测试**：组批、幂等重试、关闭回流后不上报；
7. **回归纪律**：vitest 与 vue-tsc/oxlint 分开跑；zh-CN 为源语言，en 同步，其余 locale 补 key；每任务单独 commit。

## 8. 实施里程碑（deepchat 侧，与 StaffDeck M 对应）

| 阶段 | 内容 | 依赖 | 交付标志 |
|---|---|---|---|
| D1 | HttpDigitalEmployeeProvider 完整实现 + 配置注入 + 降级 | StaffDeck M2 | 广场显示真实配置，mock 仅作降级 |
| D2 | executionMode 分流 + remote SSE 渲染 + awaiting_input 续跑 | **无 M5 依赖**：通道④是「复用现有 API，零新增」（§6.4），`runs:stream` 自 M1 即存在 | remote 员工完整对话闭环 |
| D3 | 知识同步任务 + 本地索引 | StaffDeck M3 | 本地对话带知识引用与 stale 提示 |
| D4 | 技能导入 + `staffdeck:*` MCP 工具接入 | StaffDeck M2/M4 | 本地技能生效；远端工具可执行 |
| D5 | 回流上报客户端 + 设置开关 | StaffDeck M6 | 管理端看板可见本地执行会话 |

D1 → {D2, D3, D4} → D5；联调环境使用 StaffDeck M1 交付的 Compose 部署。

## 9. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 契约演进（StaffDeck 扩展字段增多） | deepchat 侧 schema 保持非严格模式，未知字段忽略；扩展字段消费逐项开关 |
| SSE 在 Electron 渲染进程的稳定性 | 主进程统一消费 SSE → 契约事件转发 renderer（对齐现有事件系统规则） |
| 本地知识副本的隐私合规 | 知识同步仅覆盖开启开关的 KB；企业策略可整体禁用 D3。注意开关是**默认关闭**：`knowledge_sync.py:36` 用 `metadata.get("deepchat_sync_enabled") is not True` 判定，未显式设置一律不同步（当前种子数据 33 个 version 全部为 None，故 `/knowledge-packages` 实际返回空列表） |
| 回流关闭导致审计盲区 | 回路由服务端 `POST /external-sessions` + `events:batch` 承接，客户端不带开关；服务端按 `source=deepchat` 只读归档 |
| hybrid 会话内本地/远端切换的上下文丢失 | 切换时生成上下文摘要并注入远端会话首条消息（实现为 D2 细化项） |
| `run.output.replace` / `awaiting_input` 被误当作流内事件 | 已在 §5.2「D2 协议核实修订」中按源码修正：replace 无产生点、awaiting_input 需终态补查 |
| 服务端新增 SSE 事件名导致客户端解析拒绝 | 事件名白名单之外的帧按「忽略 + 计数告警」处理，不中断流（与契约非严格策略一致） |
