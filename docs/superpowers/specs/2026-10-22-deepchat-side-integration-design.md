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

| 决策点      | 结论                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| SOP 执行位置 | 混合模式：员工级 `executionMode`（local/remote/hybrid）；SOP 级 `execution_hint` **由服务端消费、不下发**，客户端无法据此逐条路由（见 §5.2 修订 3） |
| 鉴权       | 部署级共享密钥（`sd_live_` API key）；请求必带 `external_user_id` 标识端上用户                                                   |
| 知识库      | 本地同步检索：StaffDeck 分发知识包，deepchat 落地本地副本并 `similarityQuery`                                                    |
| 数据回流     | 本地执行对话全量回流（本地队列 + 幂等重试）                                                                                      |
| 原则       | 配置和能力只下行，对话数据只上行                                                                                             |

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

| 能力       | 端点                                                                                                          | 状态           |
| -------- | ----------------------------------------------------------------------------------------------------------- | ------------ |
| 配置分发     | `GET /api/v1/digital-employees`、`/{id}`、`/{id}:export-skill`                                                | StaffDeck M2 |
| 知识同步     | `GET /api/v1/digital-employees/{id}/knowledge-packages`、`/knowledge-packages/{kb}/concepts/{path}:download` | StaffDeck M3 |
| MCP 工具网关 | `/api/v1/mcp/agents/{id}`（streamable HTTP，工具命名空间 `staffdeck_`）                                              | StaffDeck M4 |
| 远端执行     | `POST /agents/{id}/sessions` + `POST /agents/{id}/runs:stream`（SSE，Last-Event-ID 续传）                        | 已有           |
| 对话回流     | `POST /agents/{id}/sessions`（取远端 id，幂等）+ `POST /agents/{id}/sessions/{sid}/events:batch`            | StaffDeck M6 |
| 鉴权       | Bearer `sd_live_` 共享密钥；scopes 见 StaffDeck 方案 §8                                                             | 已有           |

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
> 3. ~~**附件在 D2 不传**。`AgentRunCreate.attachments` 接受 `ChatAttachmentRead`（`session_schema.py:258-270`），与 deepchat 的 `MessageFile` 字段不同构；D2 远端首轮仅纯文本，附件能力留待后续。~~ **已于 2026-10-24 补齐，见下方「P1-6 补充修订」。**
>
> 实测同时确认了两个此前只能从源码推断的行为：
>
> - **服务端把执行期错误当作正文回复**：未配置默认模型时，流里推的是 `run.output.delta` 分片（内容为「Harness v2 执行出错（HARNESS_V2_ERROR）：…」），并以 `run.succeeded` 正常结束，`/result` 的 `reply` 也是这段文本。也就是说 `run.failed` 不是唯一的失败表达——正文可能是错误说明。UI 因此不能把「有正文」等同于「执行成功」，失败提示只由 `remoteRunUpdated` 的 `phase` 与 `messageCode` 驱动。
> - **`Idempotency-Key` 语义已验证**：同 key 同 body 重放返回同一 `job_id` 的完整流；同 key 不同 body 返回 409 `IDEMPOTENCY_CONFLICT`（problem+json，取 `code`）。D2 用 `deepchat:{sessionId}:{turnId}` 作确定性键，重试不会产生第二个 run。

> **P1-6 补充修订：附件透传的真实边界（2026-10-24）**
>
> 原判断「服务端会剥掉客户端文本、且没有 API Key 能用的上传端点」只对了一半，动工时按源码重新核对后修正如下：
>
> 1. **文本其实是通的**。`public_api/runs.py:190` 对 `payload["attachments"]` 只做 `ChatAttachmentRead.model_validate`，**没有**调用 `validate_chat_turn_attachments`——后者只在 `api/chat.py:1019,1094` 那条走会话 cookie（`get_current_user`）的路径上。所以客户端的 `text` 不会像网页端那样被剥掉，会一路进到 `harness_attachments.py:132` 的 `elif attachment.text` 分支，被写成 workspace 文件。**「无上传端点」只意味着拿不到原始二进制，不意味着拿不到文本。**
> 2. **PDF 同理**，但服务端 note 已写明这种情况下保存的是「服务端提取文本」，因此客户端送本地已提取的 markdown 是正确的，而不是把二进制塞成 `text` 冒名顶替。
> 3. **图片必须过 `_validated_image_data_url` 的二次校验**：base64 解码后的字节数要和 `size` **完全相等**（差 1 字节整条作废）、≤4MB、魔数与 `content_type` 一致、且 data URL 前缀必须逐字等于 `data:{content_type};base64,`。因此 `image/jpg` 这类别名要连前缀一起改写成 `image/jpeg`。
> 4. **不传 `sha256`**。一旦带上，服务端会走 `read_staged_chat_attachment` 去查暂存原件，而这条路径从未上传过，白跑一趟还会误导日志。
> 5. **单轮载荷要设预算**。run 的请求体会原样存进 `APIJob.request_json` 并参与幂等回放比对，不设限时 8 张 4MB 图会变成 40MB+ 的 SQLite 行。当前定 8MB。
> 6. **丢掉附件必须说出来**。docx/xlsx/音频没有可信通道，只能跳过；但「对话框里挂着文件、模型全然不知」比报错更难自查——用户只会归因于模型变笨。因此 `remoteRunUpdated` 带 `skippedAttachments`（仅文件名与原因码），聊天页渲染一条 amber 提示。
>
> 落地：`src/main/digital-employee/remoteAttachments.ts`（纯函数裁剪 + 18 例单测），接线在 `remoteRunner.execute` 的首发 `streamRun`；续传走 `runs/{id}/events`，不重发附件。

> **D2 补充修订：hybrid 的「可切换」与「失败降级」（2026-10-24）**
>
> §5.2 的 hybrid 只写到「整会话可切换」，没有说清**谁触发、怎么切、失败之后怎么办**。三处都补上了，共同点是「绑定表是唯一真相」：
>
> 1. **切换入口在聊天页顶栏，不在下拉菜单**。整会话换执行引擎不可逆，藏进二级菜单容易被误点。按钮出现的条件是三个与关系的交集：员工 `executionMode === 'hybrid'`、会话未绑远端、会话可写。判断「未绑远端」必须查主进程的绑定表（新增 store 方法 `loadRemoteBinding` → `digitalEmployee.remoteStatus` 的 `bound`）——员工的 `executionMode` 说不了这件事，它配的是能力而非某个会话的现状。查询失败按**已绑定**处理：乐观显示「可切换」会让用户点了才发现切不了。
> 2. **切换前可补一段上下文摘要**。服务端看不到本地历史，这是它「接上上下文」的唯一途径。摘要为空白时整个字段不传（不是传空串），否则远端会多收到一段无意义的上下文。切换失败不静默：确认弹窗保持打开并给出原因，因为用户刚做了一次显式操作。
> 3. **hybrid 失败降级为本地，remote 失败不降级**。判据是绑定表里的 `executionMode`：`hybrid` 解除绑定（`ChatService.handles` 只读 `has`，删掉这条记录下一轮自然走本地），`remote` 保持绑定并报错——remote 员工的提示词、知识库、工具都在服务端，本地跑出来是另一个员工，比报错更糟。降级结论通过 `digitalEmployee.remoteRunUpdated` 的 `fallbackToLocal: true` 告知渲染层，聊天页据此显示「已自动切回本地执行」。
> 4. **降级标记是粘性的**：它只说「引擎换了」，不因下一轮的 `started` 事件清除；错误码才随轮次清空。切换会话时两者都重置。
>
> 测试：runner 侧 4 例（hybrid 解除绑定并上报、remote 保留绑定、未绑定时不谎称降级、事件带 `fallbackToLocal`），composable 侧 4 例（标记置位、跨轮保持、普通失败不置位、切会话重置），store 侧 6 例（摘要裁剪/省略、失败回报而非抛错、绑定查询三态），顶栏 6 例（四个可见性组合 + 成功/失败两条路径）。

> **D2 补充修订：追问明细的生命周期（2026-10-24）**
>
> `awaiting_input` 的明细**不在 SSE 事件里**（§5.2 已知事实），提示条要靠事件到达后回查 `digitalEmployee.remoteStatus` 拿到。这条链路原先有一处断点，修完后形成的约束值得写进 spec：
>
> **明细必须存在一个两处可写的共享位置，且每轮都要写（含空值）。** 首轮的 run 由 `bindRemoteSession` / `switchToRemote` 发起，之后的每一轮由 `ChatService` 的 `remoteTurn.send` 发起——两条路径分属不同层，任何一方私有一份副本都会让另一方读到过期或空的值。原实现把明细放在路由内部的 Map 里，于是第二轮起恒返回 `null`，提示条再也不出现（真实对话里追问多发生在第二、三轮，所以表现是「偶尔生效」）。
>
> 三条性质：
> 1. **不落库**。追问是瞬时的：进程重启后补查旧 run 会拿到与服务端现状不符的结论。与绑定表刻意分开——绑定是必须恢复的持久事实，追问是答完就该消失的瞬时状态。
> 2. **每轮都写 `null` 也是写**。「这一轮没有追问」正是撤掉上一条提示的信号；只在有追问时写入，会让提示条在用户答完之后继续挂着。
> 3. **会话退回本地时清除**。hybrid 降级后旧明细不该被后来的查询读到。
>
> 实现：`src/main/digital-employee/remoteRunOutcomes.ts`，`remoteRoutes` 与 `composition` 的 `remoteTurn.send` 共用一份。

### 5.3 技能导入
- 分发 payload 的 `skills[].downloadUrl` → 下载 `:export-skill` zip（SKILL.md 包格式，与 deepchat 技能目录同构）；
- 走现有 Skills 管理的导入能力装进 `digital-employee:<id>` agentId 隔离目录；主进程在会话创建时按 `skillIds` 解析注册，不引入「技能安装」确认流程（企业分发场景默认信任）；
- 仓库根 `skills/staffdeck-api-*` 4 个 OpenAPI 调用技能包可作为可选内置项安装（使本地 Agent 具备直接调用 StaffDeck OpenAPI 的能力）。

> **实现修订（2026-10-23，D4 交付后据实记录）**：上面两条里的 `digital-employee:<id>` 与 `skillIds` **都不能照字面实现**，实测各自会静默失效。
>
> **agentId 不能带冒号，也没有「每员工一个 agent」。** 数字员工的全部对话都跑在内置 agent `deepchat` 下（`DIGITAL_EMPLOYEE_AGENT_ID = 'deepchat'`），不存在可以按员工分配的 agent 目录。而且 `assertSafeSkillAgentId`（`main/skill/agentSkillRoots.ts`）只接受 `^[A-Za-z0-9][A-Za-z0-9._-]*$`，冒号直接拒绝；Windows 目录名同样不允许冒号。**技能隔离靠名字前缀**：安装时用 `targetName = de-{employeeId}-{slug}`（`main/digital-employee/employeeScope.ts`），装进内置 agent 的技能根。
>
> **`downloadUrl` 不可用，必须用客户端 baseUrl 重拼。** 该字段由服务端 `get_settings().normalized_tool_base_url` 拼出（默认 `http://localhost:5173`），与客户端实际访问地址无关——D3 的 `bundleUrl` 同病。实际请求 `{clientBaseUrl}/api/v1/digital-employees/{employeeId}:export-skill?slug={slug}`，slug 是 **query 参数**。注意 `/api/v1` 必须自己拼：设置里存的是主机根（占位符 `https://staffdeck.example.com`），`provider` / `remoteClient` / `knowledgeClient` 都遵守这个约定；漏掉它端点直接 404，而界面上只表现为「技能没装上」。
>
> **`skills[].slug` 必须在契约里显式声明。** zod 会剥掉未声明的键，漏声明就变成「每个技能都没有 slug」，导出请求全部 400/404，而界面上只表现为「技能没装上」。已在 `digitalEmployee.routes.ts` 补上（可选，兼容旧 payload）。
>
> **会话的 `activeSkills` 必须用安装后的名字。** 装出来的名字带员工前缀，payload 里的 slug 在本地技能目录中不存在，直接传 `skillIds` 会安静地激活不到任何技能。准备工作（`digitalEmployee.provision`）返回 `skillNames`，会话用它；仅在未做过准备时退回 `skillIds`。
>
> **解包复用 `extractSkillArchive`**，已用真实导出包验证（zip 根即 `SKILL.md`，见 `test/main/skill/staffdeckSkillArchive.test.ts` 与 fixture）。版本判据用 `skills[].id`——服务端每次保存都换 id，无需额外做内容 hash。

### 5.4 知识同步任务

- 后台同步器（主进程，**非 worker**——见下方 D3 落地修订）：
  1. `GET /digital-employees/{id}/knowledge-packages` 取清单（每概念 hash + 仓库级 ETag）；
  2. 与本地记录逐概念比对 hash，差异概念经 `concepts/{path}:download` 拉取；
  3. 概念正文落盘后交给 `KnowledgeService.addFile` / `reAddFile` 建索引；
- 一致性规则：清单 304 → 沿用本地状态；同步失败 → 沿用旧副本 + `stale` 标记（对话 UI 提示「知识可能过期」）；后台定时重试；
- 同步粒度按员工（只同步其 `knowledgeBaseIds`），不全量镜像租户知识。

> **D3 落地修订（2026-10-23，本地起 StaffDeck 服务实测）**
>
> 原文有 4 处与实现不符，按实际修正：
>
> 1. **没有 `:export-manifest` 端点**。清单就是 `knowledge-packages`，它本身带 per-concept hash，不需要单独 manifest。概念正文走 `concepts/{conceptPath}:download`（`public_api/knowledge_sync.py:130`），`conceptPath` 含 `/`，URL 编码时必须**逐段编码后拼回**，整体 `encodeURIComponent` 会把 `/` 变成 `%2F`，FastAPI 的 `:path` 转换器就收不到分段。
> 2. **`bundleUrl` 不可用于下载**。它由服务端 `normalized_tool_base_url` 拼出（默认 `http://localhost:5173`），与客户端配置的 baseUrl 无关。D3 完全忽略该字段，一律用自己配置的 baseUrl 拼端点。
> 3. **同步开关默认关闭，空清单是常态**。`build_knowledge_packages` 对每个 KB 版本检查 `metadata_json["deepchat_sync_enabled"] is True`（`digital_employees/knowledge_sync.py:38-40`），否则整个包被跳过。因此「清单为空」不是错误，不重试、不报错、不标 stale。
> 4. **不做 worker 化**。同步是纯 HTTP + 落盘 + 已有索引队列（`KnowledgeBase.processFileAsync` 本身就是异步队列），再加一层 worker 只会多一条跨进程状态同步路径。改为 main 内调度器 + 并发上限 3。
>
> 实测确认的事实：
>
> - 25 个概念 / 1 个 KB，首轮 25 次下载全部成功，二轮 hash 全同 → **零下载**；
> - 概念正文是 **OKF 格式**（自带 YAML frontmatter + `# Summary` / `# Source Sections` / `# Notes` / `# Citations` 分段），D3 **原样保存**、不拼接也不剥离——因为服务端 hash 就是对这份正文算的，改写会让 hash 永远对不上，每轮都重拉；
> - 13 个概念 id 形如 `sources/<doc>/sections/sec-N`，落盘后形成真实层级目录，未被压平成单文件；
> - `If-None-Match` 携 ETag 返回 **304**，D3 据此跳过整轮（沿用本地状态，不视为空清单）。

> **D3 补充修订：会话检索的库 id 与状态契约（2026-10-23，缺口审计后回写）**
>
> 原文只写了「概念正文落盘后交给 `KnowledgeService.addFile`」，没写**对话时从哪个库检索**。这一段的缺失导致 P0 断链：同步把索引写进 `de-{employeeId}`，而会话检索读的是 payload 的 `knowledgeBaseIds`（服务端 `kb_*`），两套 id 之间没有换算关系。
>
> 1. **本地库 id 与远端 KB id 是两个空间**。`deriveLocalKnowledgeBaseId(employeeId)`（`knowledgeProvisioning.ts:50`，`de-` 前缀 + 清洗后的员工 id，必要时补 8 位 hash）是唯一权威来源；`kb_*` 只用于「服务端还配着哪些知识」的判据。
> 2. **新增窄契约 `digitalEmployee.knowledgeLocalBase`**（`digitalEmployeeKnowledge.routes.ts`），入参 `employeeId`，出参 `{ knowledgeBaseId: string | null }`。**不**把 `localKnowledgeBaseId` 塞进 `knowledgeStatus` 的 `packages[]`：那是展示用列表，本地库 id 是员工级单值，混进去会变成「列表为空时 id 无处安放」，而列表为空恰恰最需要它。
> 3. **解析顺序**：状态表记录的 id → 缺失时按同一规则重算；再用 `KnowledgeSettings.getKnowledgeConfigs()` 校验该库真的存在（用户可能在主设置里删了库）。任一环节不成立就返回 `null`。
> 4. **`null` 一律表示「跳过检索」**，绝不回退到远端 id。回退只会让 `similarityQuery` 抛 `Knowledge config not found`，再被 `.catch(() => [])` 吞成空结果——故障不可见，这正是原缺陷能长期潜伏的原因。
> 5. 检索仍只在有开场问题时执行，且仅对 `executionMode !== 'remote'` 生效（remote 由服务端检索）。


### 5.5 MCP 白名单接入远端工具

- 员工 `tools[]` 中 `staffdeck_*` 命名空间的工具 → 注册为 streamable HTTP MCP server，由 deepchat 现有 MCP 客户端连接；
- 会话级工具白名单机制不变（`disabledAgentTools` 取补集）；
- 公共 MCP 工具（分发 payload 附连接信息、无凭证的）→ deepchat 本地直连，与远端工具在同一白名单体系中共存。

> **D4 落地修订（2026-10-23，实测）**
>
> 1. **命名空间是 `staffdeck_`，不是 `staffdeck:`**。冒号会让 deepchat 的 MCP 工具名过滤器（`/^[a-zA-Z0-9_-]+$/`）整条丢掉该工具，OpenAI 兼容 API 也拒绝这种函数名；服务端因此把 `.` 归一为 `_` 并对需要归一的 slug 附 8 位摘要（`digital_employees/tool_namespace.py`）。归一后的名字在分发 payload 与 MCP catalog 中**逐字节一致**，白名单可直接比对。
> 2. **端点带员工路径段**：`{baseUrl}/api/v1/mcp/agents/{employeeId}`。deepchat 的 `MCPServerConfig` 只有静态 header，标准 MCP 客户端也不会往 `tools/list` 注入 `_meta`，服务端没别的办法知道是哪个员工在问。
> 3. **`/api/v1` 由客户端拼**。设置里存的是主机根（占位符 `https://staffdeck.example.com`），与 `provider` / `remoteClient` / `knowledgeClient` 一致。漏掉这段时 `/mcp/agents/...` 直接 404，而 MCP 客户端只会表现为「没有工具」。
> 4. **需要 `mcp:invoke` scope**，与分发列表的 `agents:read` 是两个不同 scope。缺它同样是「工具一个都没有」而非明确报错。
> 5. **准备必须在读工具列表之前**，且那次读取必须 `force`。白名单是「可用工具列表的补集」，注册晚了第一轮对话就没有任何 `staffdeck_*` 工具且不会重试；而 `loadTools()` 默认走 `refresh`，`staleTime` 30s 会返回注册前的缓存。

### 5.6 对话回流上报客户端

- 触点：本地执行会话（`executionMode=local` 及 hybrid 的本地段）每轮结束后上报；
- 实现：先 `POST /agents/{id}/sessions`（`external_session_id` = 本地会话 id，幂等）取服务端会话 id → 消息/工具调用/token 用量组批经 `POST /agents/{id}/sessions/{sid}/events:batch` 上报；
- 可靠性：上报失败不前进游标，下一轮重发同一批；服务端按单事件 id 去重，重发安全；
- 隐私：上报内容与远端执行同一审计口径；用户可在设置中关闭回流（关闭时管理端无该会话记录，UI 明示）。

> **实现修订（2026-10-23，D5 交付后据实记录）**：上面两条端点都改了，原因分别是「重复」和「会丢数据」，另有第三条「缺一步就整条不通」。
>
> **建会话不需要新端点，但建会话本身不能省。** 原文的 `POST /external-sessions` 与既有 `POST /agents/{agent_id}/sessions` 功能重叠——后者本来就接受 `external_session_id`，并按 `(credential_id, external_session_id)` 幂等 upsert（`sessions.py` 的 `create_public_session_row`），`StaffdeckRemoteClient.createSession` 一直在走它。再开一个就是同一规则两处实现，一旦漂移，同一对话会在服务端产生两行、消息各写一半。**故不新增建会话端点**，路径放进既有命名空间：`POST /agents/{agent_id}/sessions/{session_id}/events:batch`。
>
> **但「不新增端点」不等于「不用建会话」。** `events:batch` 要求 `session_id` 是服务端的 `ChatSession` 行，且该凭证在 `ExternalSessionBinding` 里拥有它。本地执行的会话从未建过远端记录，**直接发事件一律 404**。所以客户端第一次上报必须先按 `external_session_id` 把会话建出来，再用返回的服务端 id 发事件。早期 D5 联调之所以通过，是因为脚本手工建了会话；真正接线到对话页时才暴露。
>
> **服务端 id 缓存在内存，不回填成「本地 id 就是远端 id」。** 每轮多一次建会话往返没有意义；但缓存不能落盘——落盘会让「服务端换了库」变成一堆指向不存在会话的陈旧 id。缓存命中后若收到 404，丢缓存重建一次，再失败就如实回报，不无限重试。
>
> **幂等必须按单事件，不能按整批。** 客户端重试必然重发整批。整批幂等的话，只要重发时夹带一条已存事件，整批就被 409 拒掉，随行的新事件全部丢失。服务端改为按 `event_id` 逐条去重（存于 `Message.metadata_json["external_event_id"]`），响应 `{accepted, duplicates}`；`accepted: 0` 是「重试生效」，不是错误。
>
> **鉴权三层，第三层不可省。** agent 属本租户 → session 属该 agent 且同租户 → **该凭证在绑定表里拥有这个 session**。只校验租户的话，任何同租户 key 都能往它叫得出名字的会话里写，等于把只读权限升级成写权限。
>
> **远端员工不上报。** `executionMode=remote` 的对话本来就在服务端，再报一次会让管理端看到每条消息两份。
>
> **开关缺省视为开启。** 读 `!== false` 而非 `=== true`：误关会留审计盲区，误开只是多归档一条用户本来就期望归档的对话。
>
> **失败即停，不跳过。** 跳过失败块会在归档里留一个洞，而调用方分不清「已发过」和「丢了」，那一段就永远补不回来。
>
> **事件 id 只由消息 id 与块位置决定。** 它就是服务端的去重粒度：一旦带上时间戳或数组下标，同一轮重报就会被当成新消息，归档里出现两份。相应地，`orderSeq` 游标只在成功后才前进，失败就原地等下一轮重发。
>
> **乐观消息前面停住。** 流刚结束时用户那条还是 `__optimistic_user_*` 临时记录，提交后会被换成真实 id。此时上报会留下一个永远对不上的事件 id，且游标一旦越过它，真实记录因为 `orderSeq` 不前进就再也采不到。所以遇到临时记录就在本轮停下，等下一轮连同后面的助手消息一起报。
>
> 服务端实现 `backend/app/public_api/external_sessions.py`，客户端 `src/main/digital-employee/backflow.ts` + `backflowRoutes.ts`，采集 `src/renderer/src/features/chat-page/model/backflowEvents.ts` + `composables/useBackflowReporting.ts`。

> **P1-1 补充修订：本地队列与指数退避（2026-10-24，`604a893f`）**
>
> 上面「游标只在成功后才前进」这句在实现成队列之后**必须改口径**，否则两边会重复计数：
>
> 1. **`ok` 的语义从「送达」改成「主进程接手」**。主进程发不出去时会先把事件落进本地 SQLite 队列（表 `digital_employee_backflow_queue`），那批事件已经有人负责；renderer 若仍保留游标，下一轮会重采同一批，队列里就多出一份。所以 `ok: true` + `reason: 'NETWORK'` 表示「已入队待补发」，renderer 照常前进游标。只有「主进程没接手」（关了回流 / 没配连接 / 事件被服务端明确拒收 / 落盘失败）才是 `ok: false`，此时才保留游标重发。
> 2. **去重粒度决定了队列的粒度**：一行一个事件，唯一索引 `(session_id, event_id)`。一行一批会和服务端的单事件去重错位——重发时夹带一条已存事件，整批就被判成重复。
> 3. **退避 30s 起、翻倍、封顶 30 分钟**。不带抖动：这里是单机单客户端，抖动只会让「第几次失败等多久」变得不可预测。**按会话分组发送**（事件端点路径里带会话 id），组内保持 `seq` 升序，否则管理端看到的是倒序对话。
> 4. **哪些失败值得重试**：`NETWORK` / 5xx / 408 / 429。401 / 403 / 404 / 422 直接丢弃——重试一万次还是同一个结局，留着只会让队列变成永不消失的垃圾。
> 5. **两条收尾规则**：队列里的事件超 7 天丢弃（长期离线会把 `batchLimit` 名额永远占满，补发成本高于归档价值）；**关掉回流时清空队列**——攒着不发等于把隐私开关做成摆设。
> 6. **积压要看得见**。新增只读路由 `digitalEmployee.backflowQueueStatus`（只回条数与最早入队时间，不回任何对话内容），设置页据此提示「有 N 条对话尚未归档」。否则「暂时连不上」和「一直没归档」在界面上长得一样。
>
> 顺带修：`reportBackflow` 之前收了 `title` 但没往下传，服务端那条会话因此永远没有标题。

### 5.7 部署与配置注入

- 构建时/运行时配置：`STAFFDECK_BASE_URL`、`STAFFDECK_API_KEY`、`STAFFDECK_EXTERNAL_USER_ID`（端上用户唯一标识生成规则：首启生成 UUID 并持久化）、`STAFFDECK_SYNC_INTERVAL`（知识同步间隔）；
- 密钥存储走 deepchat 现有安全存储（对齐 MCP 凭证管理机制），不落明文配置文件。

> **实现偏离（2026-10-24 回写，原为审计遗留的文档不一致）**
>
> 上述「构建期 env 注入」**没有按原文实现**，实际是**只从持久化设置读入**：`providerFactory.ts:16` 明写「配置只从持久化设置读入，factory 内不读 env / renderer 全局」，全仓 `grep process.env.STAFFDECK` 零命中。对应关系是
>
> | spec 变量 | 实际来源 |
> |---|---|
> | `STAFFDECK_BASE_URL` | 设置项 `digitalEmployee.staffdeckBaseUrl` |
> | `STAFFDECK_API_KEY` | 设置项 `digitalEmployee.staffdeckApiKey`，值经 SecretStore 包装后存入 |
> | `STAFFDECK_EXTERNAL_USER_ID` | 设置项 `digitalEmployee.externalUserId`，首启生成 UUID 并持久化（与原规则一致） |
> | `STAFFDECK_SYNC_INTERVAL` | 设置项 `digitalEmployee.knowledgeSyncIntervalSeconds` |
>
> 这个偏离是有意的，且比原案更适合企业部署：底座地址与凭证由管理员在设置页填写并即时生效（保存后 `onConfigurationChanged` 重建 Provider），不需要为换一个租户重新打包；env 注入无法在已分发的客户端上修改，而这类接入恰恰最常变的就是地址与 key。
>
> 代价是**多端部署无法用镜像固化配置**，需要走设置页或预置设置库。若未来要做「开箱即用」的分发形态，应补一条「env 作为首次启动的默认值、设置页可覆盖」的路径，而不是回到纯 env。
>
> 另外 `external_user_id` 只以 **JSON body 字段** 传递，不发 `x-external-user-id` 请求头：服务端 `backend/` 全目录对该 header 零读取（见审计 P2-5）。

## 6. 错误处理与降级（deepchat 侧）

| 故障            | 行为                                                   |
| ------------- | ---------------------------------------------------- |
| 分发 API 不可达    | 降级 mock（现有逻辑）+「配置过期」横幅                               |
| 知识同步失败        | 旧副本 + stale 标记，后台重试                                  |
| 远端 runs 中断    | Last-Event-ID 续传；不可恢复时 hybrid 转本地模式，remote 明确报错并保留会话 |
| 回流上报失败        | 本地队列暂存 + 退避重试                                        |
| MCP 工具超时/预算耗尽 | 结构化错误码转 UI 提示，允许人工接管                                 |

> **D3 落地补充（stale 原因的完整集合与处置）**
>
> 同步失败经 `knowledgeStaleReasons` 收敛为有限集合，UI 按此映射文案（未识别的码降级为 `UNKNOWN`，绝不回显原始字符串）：
>
> | 原因                      | 触发条件                          | 用户是否需要动手                      |
> | ----------------------- | ----------------------------- | ----------------------------- |
> | `NO_EMBEDDING_MODEL`    | 本机没有任何已启用的 embedding 模型，建不了索引 | **是** —— 去设置启用一个 embedding 模型 |
> | `HTTP_401` / `HTTP_403` | StaffDeck API Key 失效或权限不足     | **是** —— 检查设置里的 API Key       |
> | `UNREACHABLE`           | 网络/DNS/超时                     | 否 —— 后台自动重试                   |
> | `PARTIAL`               | 部分概念下载或索引失败                   | 否 —— 后台自动重试                   |
> | `INDEX_FAILED`          | 索引写入失败（磁盘、维度不匹配）              | 否（通常需重启或换模型，属异常态）             |
> | `UNKNOWN`               | 契约新增了未识别的原因码                  | 否 —— 显示通用文案                   |
>
> 两处刻意的设计取舍：
>
> - **索引失败的 hash 不记账**。若记了，下一轮会认为「已同步」，那条概念永远补不上。
> - **已完成的部分不回滚**。单个概念失败只标 `PARTIAL`，已下好的兄弟概念保留，避免每次失败都全量重拉。

## 7. 测试计划（deepchat 侧）

1. **契约解析测试**：真实分发样本（含扩展字段）过 `digitalEmployeeSchema` zod 解析；非法样本拒绝；
2. **Provider 测试**：ETag 缓存命中、降级 mock、configHash 变化标记；
3. **分流测试**：local/remote/hybrid 三类员工的会话创建参数与注入行为（store 层断言 client 调用参数，沿用现有测试纪律）；
4. **SSE 消费测试**：delta 追加 / replace 替换 / completed 停止 / Last-Event-ID 续传 / awaiting_input 续跑；
5. **知识同步测试**：hash 对比增量、stale 降级、全量重拉；

> **第 5 条落地拆分（D3）**：单概念 hash 变化只重拉该概念并 `reAddFile`；服务端删除的概念 → `deleteFile` 并从记账里摘除；清单 304 → 零下载；空清单 → 不建库不标 stale；`knowledgeBaseIds` 与清单取交集（清单多出的 KB 不处理）；下载中途失败 → 标 `PARTIAL` 且保留已完成部分；`addFile` 返回 `{error}` → 不记账、整轮继续；无嵌入模型 → 不下载直接返回 `NO_EMBEDDING_MODEL`；落盘原子写（不留 `.tmp`）且路径稳定；概念 id 含 `/` 建层级目录。共 16 条编排用例 + 10 条调度用例 + 5 条状态路由用例 + 5 条提示条用例。
>
> **第 5 条补充（检索接线，2026-10-23）**：`knowledgeLocalBase` 路由 5 例——回传同步记录的 id、状态表缺失但库存在时按规则重算、库不存在回 `null`、记录的库被用户删除后回 `null`、绝不回传 `kb_*` 远端 id。renderer 侧 4 例——用本地 id 检索且不带 `kb-*`、`null` 时跳过检索且 systemPrompt 无「参考资料」段、查询失败时跳过、无开场问题时连查询都不发。

1. **技能与工具测试（D4）**：MCP 注册幂等（目标未变时零写入）、凭证缺失/无工具时清理、Bearer 只进 header；技能按 `skills[].id` 增量、失败不记账、临时文件必删；准备闸门（remote / mock / 已下线）与两条链路的失败隔离；renderer 侧「provision 先于 `loadTools({force:true})`」的顺序。

> **第 6 条落地拆分（D4）**：注册器 14 例 + 技能同步 16 例 + baseline 存储 8 例 + 准备编排 17 例 + 作用域派生 12 例 + 契约 1 例 + 广场页 17 例（含顺序与技能名透传）。真实导出包作为 fixture 固化「两边对包结构的假设一致」。

1. **回流测试**：组批、幂等重试、关闭回流后不上报；
2. **回归纪律**：vitest 与 vue-tsc/oxlint 分开跑；zh-CN 为源语言，en 同步，其余 locale 补 key；每任务单独 commit。

## 8. 实施里程碑（deepchat 侧，与 StaffDeck M 对应）

| 阶段 | 内容                                                   | 依赖                                                          | 交付标志                |
| -- | ---------------------------------------------------- | ----------------------------------------------------------- | ------------------- |
| D1 | HttpDigitalEmployeeProvider 完整实现 + 配置注入 + 降级         | StaffDeck M2                                                | 广场显示真实配置，mock 仅作降级  |
| D2 | executionMode 分流 + remote SSE 渲染 + awaiting_input 续跑 | **无 M5 依赖**：通道④是「复用现有 API，零新增」（§6.4），`runs:stream` 自 M1 即存在 | remote 员工完整对话闭环     |
| D3 | 知识同步任务 + 本地索引                                        | StaffDeck M3                                                | 本地对话带知识引用与 stale 提示 |
| D4 | 技能导入 + `staffdeck_*` MCP 工具接入                        | StaffDeck M2/M4                                             | 本地技能生效；远端工具可执行      |
| D5 | 回流上报客户端 + 设置开关                                       | StaffDeck M6                                                | 管理端看板可见本地执行会话       |

D1 → {D2, D3, D4} → D5；联调环境使用 StaffDeck M1 交付的 Compose 部署。

> **D4 交付记录（2026-10-23）**：已完成，见 `docs/superpowers/plans/2026-10-23-staffdeck-d4-skills-and-tools.md`。联调实测：`initialize` 200、`tools/list` 3 个工具与 payload `tools[]` 逐字一致、`tools/call` 返回真实额度数据；两个技能包首轮装 2 个、二轮零下载。联调暴露并修复了一个会让整个 D4 不可用的缺陷（两个 client 漏拼 `/api/v1`，端点全 404），以及一处缓存导致的顺序失效（`loadTools` 需 `force`）。
>
> 运维前提：API Key 需额外带 `mcp:invoke` scope——分发列表只要 `agents:read`，但工具网关不认。缺它表现为「工具一个都没有」而非明确报错。

> **D3 补交付（2026-10-23，缺口审计后）**：D3 原交付只做到「索引写进本地库」，没接「对话从本地库检索」，里程碑里的交付标志「本地对话带知识引用」实际未达成。补齐方式见 §5.4 的补充修订（新增 `digitalEmployee.knowledgeLocalBase` 窄契约 + 渲染侧改用本地库 id 寻址）。完整缺口清单见 `docs/superpowers/plans/2026-10-23-staffdeck-integration-gap-audit.md`。

> **D5 交付记录（2026-10-24）**：已完成，计划见 `docs/superpowers/plans/2026-10-24-staffdeck-d5-backflow.md`。交付标志「管理端看板可见本地执行会话」在补齐两个缺陷后才成立：
>
> 1. **没有调用方**。`reportBackflow` 自 `bee793f5` 起就定义、导出、有单测，但 `.vue` 与 main 的 session/agent 目录零调用——没有任何一轮对话会被上报。补齐方式：`useBackflowReporting` 挂在聊天页，触点是「流结束」而非「用户发消息」（一轮可能含多轮工具调用，中途没有完整边界）。
> 2. **发包必然 404**。本地执行的会话在服务端没有 `ChatSession` 行，`events:batch` 要求该行属于本凭证并在 `ExternalSessionBinding` 里登记。补齐方式：第一次上报先按 `external_session_id` 建会话（服务端按此键幂等），缓存服务端 id，404 时丢缓存重建一次。早期握手「通过」只是因为联调脚本手工调过 create-session。
>
> ~~仍未做：本地 SQLite 队列与指数退避重试（审计 P1-1，spec §5.6 有要求），当前是一次性 `flush()`，离线那一轮不会补发。~~
>
> **P1-1 补齐（2026-10-24，同一轮）**：本地队列与指数退避已落地，D5 的「可靠性」一栏现在名副其实。做法见 §5.6 的「P1-1 补充修订」与计划文档 §8。要点是 `ok` 的语义从「送达」改成「主进程接手」（落盘也算），否则 renderer 会与队列各重发一份。

> **P1-6 补齐（2026-10-24，同一轮）**：D2 遗留的「远端首轮仅纯文本」已解决。核对源码后确认附件三条通道都可走（文本内联、PDF 提取文本、图片 `data_url`），只有 docx/xlsx/音频因 public_api 无附件上传端点而不支持，且会显式提示。做法见 §5.2 的「P1-6 补充修订」。里程碑里「远端执行能力对齐 D2 契约」这一栏至此不再有已知缺口。

> **P2 运维可观测性补齐（2026-10-24，同一轮）**
>
> 三处「功能能用、但出错时看不出哪里错」的地方：
>
> 1. **`mcp:invoke` 缺 scope 无法识别**（§5.5）。列表端点要 `agents:read`，MCP 端点是独立的 `mcp:invoke`。只测连接会给出「连接成功」，而对话里一个 `staffdeck_*` 工具都没有。现补一次 `GET /api/v1/mcp/agents/{固定占位}` 探测：该处理器接收 `agent_id` 却不读取，校验 scope 后无条件 405，所以 405 = 有权限、401/403 = 缺权限，整个过程不建会话不调工具。MCP 端点的网络失败**不**报缺 scope——把网络故障说成权限问题会让人去改不需要改的东西。
> 2. **`external_user_id` 双传法**（§5.7）。删掉 `x-external-user-id` 请求头：服务端 `backend/` 全目录零读取，留着只会让排查者以为列表按用户过滤。
> 3. **hybrid 会话的重复归档**（§5.2 / §5.6）。审计原文担心的是「将来 hybrid 默认走远端会双份注入工具与技能」，那是假想风险；顺着同一条判据查到的真缺陷是：hybrid 会话被 `switchToRemote` 切到云端后，`reportBackflow` 仍只按 `executionMode !== 'remote'` 放行，于是一段已经在服务端归档的对话又被本地报了一遍，且事后无法区分哪份是真的。现补查绑定状态，查询失败按「已绑定」处理——与 `loadRemoteBinding` 的乐观方向刻意相反，因为这里的错误代价不可见。
>
> 剩下 P2-2 / P2-3 是真正的**验证**项：缺的不是代码，是真机服务与启用的 embedding provider，CI 里跑不出来。走查步骤见 `docs/superpowers/plans/2026-10-24-staffdeck-p2-field-walkthrough.md`。
>
> **P2-4 不是验证项**：原判为「等真实模型才能验」，实际逐条核对判据时发现追问明细只有首轮会写入，第二轮起 `remoteStatus.awaitingInput` 恒为 `null`。缺的是代码而不是环境，已修（见 §5.2「追问明细的生命周期」）。这条记在这里是因为分类错误的代价很实在——一项被标成「等环境」之后，就没有人再去读它的代码了。

## 9. 风险与开放问题

| 风险                                               | 缓解                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约演进（StaffDeck 扩展字段增多）                           | deepchat 侧 schema 保持非严格模式，未知字段忽略；扩展字段消费逐项开关                                                                                                                                                         |
| SSE 在 Electron 渲染进程的稳定性                          | 主进程统一消费 SSE → 契约事件转发 renderer（对齐现有事件系统规则）                                                                                                                                                           |
| 本地知识副本的隐私合规                                      | 知识同步仅覆盖开启开关的 KB；企业策略可整体禁用 D3。注意开关是**默认关闭**：`knowledge_sync.py:36` 用 `metadata.get("deepchat_sync_enabled") is not True` 判定，未显式设置一律不同步（当前种子数据 33 个 version 全部为 None，故 `/knowledge-packages` 实际返回空列表） |
| 回流关闭导致审计盲区                                       | 回路由服务端 `POST /agents/{id}/sessions` + `events:batch` 承接，客户端设置页提供开关（默认开启）；服务端按 `source=deepchat` 只读归档。关掉时设置页显式警示「管理端看不到这些会话」，不静默生效 |
| hybrid 会话内本地/远端切换的上下文丢失                          | 切换时生成上下文摘要并注入远端会话首条消息（实现为 D2 细化项）                                                                                                                                                                   |
| `run.output.replace` / `awaiting_input` 被误当作流内事件 | 已在 §5.2「D2 协议核实修订」中按源码修正：replace 无产生点、awaiting_input 需终态补查                                                                                                                                          |
| 服务端新增 SSE 事件名导致客户端解析拒绝                           | 事件名白名单之外的帧按「忽略 + 计数告警」处理，不中断流（与契约非严格策略一致）                                                                                                                                                           |
