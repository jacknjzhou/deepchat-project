# StaffDeck 接入 D2：远端执行 + SSE 渲染 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `executionMode = remote` 的数字员工在 deepchat 内完整跑通「建远端会话 → 发消息 → SSE 流式渲染 → 追问续跑 → 终态落库」，且渲染、消息持久化、中断恢复全部复用现有 deepchat 聊天链路，不引入新的聊天 UI。

**Architecture:** renderer 仍用 `sessionStore.createSession` 建本地会话（消息体为空），随后调新增的 `digitalEmployee.bindRemoteSession` route，由 main 在 StaffDeck 建远端会话并把绑定写入 config entry。此后该会话的每一轮消息在 `ChatService.sendMessage` 入口按绑定分流到 `StaffDeckRemoteTurn`：它消费 `POST /agents/{id}/runs:stream` 的 SSE，把 `run.output.delta` 累积成 `content` block，经 `updateAssistantContent` 落库并经 `chat.stream.updated` 推 renderer；终态后补查 `GET /runs/{id}/result` 取 `awaiting_input` 与 `citations`。deepchat runtime、agentStore、SessionTurn 均不改动。

**Tech Stack:** Electron main + zod 契约路由 + Pinia + Vitest + vue-i18n（20 locale）。SSE 用全局 `fetch` + `ReadableStream` 手写解析，不新增运行时依赖。

## Global Constraints

- 禁止新增运行时依赖（SSE 用 fetch ReadableStream；不引入 eventsource / sse.js）
- 不改动 deepchat / acp 运行时与 `agentStore`；分流只发生在 `ChatService` 一层
- API Key 只在 main 内取用，绝不出现在 route output / renderer state / 日志
- SSE 消费必须在 main 进程完成，renderer 只接收 `chat.stream.updated` 快照事件（对齐现有事件规则）
- 契约走 zod route contract（`defineRouteContract`）+ main `createRouteMap`
- 测试目录镜像 src 结构；`test/main/**` 用 `../../../src/`
- pnpm shim 损坏——直接执行：`C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run <path>`（不要在 exe 前加 `node`）
- vitest 与 vue-tsc / oxlint 必须分开串行执行（并行会 CPU 争抢产生假超时）
- Lint = oxlint；每任务单独 commit，不 `--no-verify`
- i18n：zh-CN 为源语言，en 真实翻译，其余 18 locale 复制 en 值

---

## 协议核实结论（对照 StaffDeck 源码实测，非推测）

本计划的每个协议细节都来自本地 StaffDeck 仓库（`D:\sync-workspace\traework\StaffDeck-Project\StaffDeck-Project\backend`）源码，行号可直接复核。

| 事实 | 证据位置 | 对 D2 的影响 |
|---|---|---|
| SSE 单条格式为 `id: {seq}\nevent: {type}\ndata: {json}\n\n` | `jobs.py:570` | 解析器按三字段行解析，`data` 单行 JSON |
| 空行分隔事件；每 15 秒发一次 `: keepalive\n\n` 注释行 | `jobs.py:574-576`（100 × 0.15s） | **解析器必须跳过以 `:` 开头的注释行**，否则 JSON.parse 抛错 |
| `Last-Event-ID` 只接受数字，取 `max(after, int(id))` | `jobs.py:547-548` | 续传游标是整数 sequence，不是字符串 |
| SSE 响应头带 `X-Run-ID` | `runs.py:464` | 必须在开始消费前记录 run id，后续补查与取消都靠它 |
| `run.output.delta` 的 `data.content` 是增量文本 | `runs.py:49` 映射 + `agent_loop.py:411-423` | 累积拼接，不能整体替换 |
| `run.output.completed` **不含回复正文**，payload 只有 `execution_engine` / `turn_id` / `user_message_id` | `runs.py:357-381` 取 `stream_end` payload；`agent_loop.py:424-430` 只放 `execution_engine` | 最终文本只能靠 delta 累积；**不能指望 completed 带全文** |
| `run.output.replace` 在服务端**没有产生点** | `runs.py:50` 仅映射表中存在；`agent_loop.py:481` 仅在「需落库的事件名集合」里；全仓无 `_stream_event("stream_replace", ...)` 调用 | 不实现 replace 分支；只在解析层保留类型以免未来上线时崩溃 |
| `awaiting_input` **不在 SSE 事件里** | 仅出现在 `runs.py:307`（`GET /runs/{id}/result` 的返回体）与 `sessions.py:29`（`GET sessions/{id}`） | 终态后必须补查 `GET /runs/{run_id}/result`（且要求 status 已为 succeeded） |
| `awaiting_input` 结构为 `{task_id?, skill_id?, step_id?, expected_fields[], question_summary?, kind?, requirements?}` | `session_schema.py:137-143`（AwaitingInput）、`agent_loop.py:1000-1006`、`harness_v2_engine.py:1503-1512` | 契约按可选字段全宽松定义，`kind` 与 `requirements` 只在 conversation 型出现 |
| Run 终态另发 `run.succeeded` / `run.failed` / `run.cancelled` 事件，`data` 为 `{job_id}` 或错误体 | `jobs.py:385-395` | 必须把这三个也当终止条件 |
| 失败体是 `application/problem+json`：`{type,title,status,code,detail,request_id}` | `errors.py:28-54` | 错误码取 `code` 字段，不要用 `title` |
| 幂等靠 `Idempotency-Key` header，同 key 不同 body 返回 409 `IDEMPOTENCY_CONFLICT` | `idempotency.py:28-61` | 每轮消息用确定性 key，重试不产生重复 run |
| `external_user_id` / `external_session_id` 是 **body 字段**，均可选 | `schemas.py:122-143` | D1 遗留的 header 传法在 D2 必须改为 body（分发端点已确认无影响） |
| 建会话幂等：同 credential + 同 `external_session_id` 返回原会话；已绑到别的 agent 返回 409 `EXTERNAL_SESSION_CONFLICT` | `sessions.py:81-97` | 用本地会话 id 作 `external_session_id` 即可自然幂等 |
| scope 分离：`sessions:write` / `sessions:read` / `runs:create` / `runs:read` / `runs:cancel` / `agents:read` | `auth.py:198-212`、`jobs.py:479-486` | 部署级 Key 需覆盖这 6 个 |
| `execution_hint` **不下发到 payload**，只在服务端决定哪些 SOP 进 `sops[]` | `sop_text.py:152-154`（读 binding metadata 后过滤）；`payload.py:105` 只放筛完的结果 | hybrid「按单条 SOP 路由」在客户端**不可实现**（见下节偏差 3） |
| `_SENSITIVE_KEYS` 会在服务端剥离 `system_prompt`/`credentials`/`error_traceback` 等 | `runs.py:77-86` | 客户端拿不到系统提示词，属预期，不要试图回读 |

### 设计文档（spec §5.2 / §9）需要修正的 4 处

D1 的 spec `docs/superpowers/specs/2026-10-22-deepchat-side-integration-design.md` 在 D2 相关部分有 4 处与 StaffDeck 实现不符，本计划按实测事实设计，不按原文：

| # | spec 原文 | 实测 | 本计划的处理 |
|---|---|---|---|
| 1 | 「`run.output.replace` 整体替换」 | 服务端无产生点 | 不实现替换语义；解析层识别但不消费，收到时降级为「清空后按增量重放」并打 warning |
| 2 | 「`awaiting_input` 状态时展示补充信息输入框」 | 不在 SSE 流里 | 终态后补查 `/runs/{id}/result`；追问内容来自 `question_summary` + `expected_fields` |
| 3 | hybrid「按单条 SOP 的 `execution_hint` 路由——local SOP 注入、remote SOP 触发远端 runs」 | `execution_hint` 不下发，服务端已把 remote SOP 从 `sops[]` 剔除 | hybrid 降级为**整会话可切换**：默认 local（与服务端筛选结果一致），用户显式切换为云端执行后整会话走 remote，切换时注入上下文摘要 |
| 4 | 「`run.output.completed` 停止流式」隐含其携带终稿 | completed 不带正文 | 终稿 = delta 累积；completed 仅作停止信号，随后补查 result 拿 `citations` 与 `awaiting_input` |

> 建议在 D2 实施前同步修订 spec §5.2 与 §9 的对应表述，避免 D3/D4 继续基于错误假设。

---

## 评估结论（spec vs 当前代码，已逐项核实）

| spec 假设 | 实际状态 | 处理 |
|---|---|---|
| 「main 无通用 SSE 消费先例」 | 部分成立：`githubCopilotProvider.ts:539`、`providerDbLoader.ts:41`、`enterpriseIdentityManager.ts:113` 都有 `response.body.getReader()`，但**没有可复用的 SSE 行协议解析器** | Task 2 新建纯函数解析器（可单测，不依赖网络） |
| 「事件转发 renderer（复用现有事件系统）」 | ✅ `chat.stream.updated` 是 blocks 快照模型（`echo.ts:17-30`），renderer 被动接收 | 远端执行器直接发同类事件，renderer 零改动 |
| 「store `startConversation` 按 executionMode 分流」 | ✅ 现有 `digitalEmployeeStore.ts:222-265` 是唯一入口 | Task 4 在其中加 remote 分支 |
| 「ChatTopBar 徽标 local/remote」 | ✅ `src/renderer/src/components/chat/ChatTopBar.vue` 存在 | Task 5 增加徽标 |
| 「hybrid 切换时保留上下文摘要」 | ⚠️ 无现成摘要能力可复用（compaction 是另一套） | Task 4 用「最近 N 轮 user+assistant 拼接」做轻量摘要，明确写为 D2 内部实现，不接入 compaction |
| 会话绑定存储 | ✅ D1 已有 renderer 侧 `digitalEmployee.sessionBindings`（config entry），但只在 renderer | Task 3 新增 main 侧 `digitalEmployee.remoteSessions`（含远端会话 id 与事件游标），renderer 那份仅作展示 |

---

### Task 1: 远端执行契约 + 事件契约

**Files:**
- Create: `src/shared/contracts/routes/digitalEmployeeRemote.routes.ts`
- Modify: `src/shared/contracts/routes.ts`（导入、注册、导出）
- Modify: `src/shared/contracts/events/digitalEmployee.events.ts`（新增 `digitalEmployee.remoteRunUpdated`）
- Test: `test/main/contracts/digitalEmployeeRemoteSchema.test.ts`（新建）

**Interfaces:**
- Produces: `staffdeckAwaitingInputSchema`（全字段可选）、`staffdeckRunResultSchema`、`staffdeckRunEventSchema`
- Produces: `digitalEmployeeBindRemoteSessionRoute`（`{ sessionId, employeeId, openingQuestion? }` → `{ remoteSessionId, runId }`）
- Produces: `digitalEmployeeRemoteStatusRoute`（`{ sessionId }` → `{ executionMode, remoteSessionId, awaitingInput }`）
- Produces: `digitalEmployeeRemoteEventsRoute`（订阅或查询用，见 Task 3）

- [x] **Step 1: 写失败测试**

```ts
// test/main/contracts/digitalEmployeeRemoteSchema.test.ts
import { describe, expect, it } from 'vitest'
import {
  staffdeckAwaitingInputSchema,
  staffdeckRunEventSchema,
  staffdeckRunResultSchema
} from '../../../src/shared/contracts/routes/digitalEmployeeRemote.routes'

describe('staffdeckRunEventSchema', () => {
  it('accepts a delta event with numeric id and content', () => {
    const parsed = staffdeckRunEventSchema.parse({
      id: 12,
      event: 'run.output.delta',
      data: { job_id: 'apijob_1', content: '你', turn_id: 'msg_1' }
    })
    expect(parsed.data.content).toBe('你')
  })

  it('accepts a completed event that carries no reply text', () => {
    const parsed = staffdeckRunEventSchema.parse({
      id: 20,
      event: 'run.output.completed',
      data: { job_id: 'apijob_1', execution_engine: 'harness_v2' }
    })
    expect(parsed.data.content).toBeUndefined()
  })

  it('rejects unknown event names so the matrix stays explicit', () => {
    expect(() =>
      staffdeckRunEventSchema.parse({ id: 1, event: 'run.whatever', data: {} })
    ).toThrow()
  })
})

describe('staffdeckRunResultSchema', () => {
  it('parses awaiting_input with only a task id', () => {
    const parsed = staffdeckRunResultSchema.parse({
      run_id: 'r1',
      reply: '需要补充',
      awaiting_input: { task_id: 't1' }
    })
    expect(parsed.awaiting_input?.task_id).toBe('t1')
    expect(parsed.awaiting_input?.expected_fields).toEqual([])
  })

  it('parses a conversation-style awaiting_input', () => {
    const parsed = staffdeckAwaitingInputSchema.parse({
      task_id: 't1',
      kind: 'conversation',
      expected_fields: ['金额', '事由'],
      question_summary: '请提供金额和事由',
      requirements: [{ name: '金额' }]
    })
    expect(parsed.kind).toBe('conversation')
    expect(parsed.expected_fields).toHaveLength(2)
  })

  it('keeps unknown fields out while tolerating server growth', () => {
    const parsed = staffdeckRunResultSchema.parse({
      run_id: 'r1',
      reply: 'ok',
      future_field: 'x'
    })
    expect((parsed as Record<string, unknown>).future_field).toBeUndefined()
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/contracts/digitalEmployeeRemoteSchema.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现契约**

`digitalEmployeeRemote.routes.ts` 关键定义（事件名用白名单枚举，未知即拒绝，避免静默丢事件）：

```ts
export const STAFFDECK_RUN_EVENT_NAMES = [
  'run.executing', 'run.status', 'run.plan', 'run.intent',
  'run.output.delta', 'run.output.replace', 'run.output.completed',
  'run.cancelled', 'run.failed', 'run.succeeded',
  'run.task_frame.started', 'run.task_frame.finished', 'run.task_frame.completed',
  'run.task_frame.waiting', 'run.task_frame.released',
  'run.capability.search', 'run.capability.described', 'run.capability.completed',
  'run.action.started', 'run.action.failed', 'run.sop.state', 'run.sop.step',
  'run.sop.step.timeout', 'run.citation', 'run.tool.completed',
  'run.skill.trace', 'run.skill.completed', 'run.loop.continued', 'run.loop.completed',
  'handoff.created'
] as const

export const staffdeckRunEventSchema = z.object({
  id: z.number().int().nonnegative(),
  event: z.enum(STAFFDECK_RUN_EVENT_NAMES),
  data: z.record(z.unknown())
})

export const staffdeckAwaitingInputSchema = z.object({
  task_id: z.string().optional(),
  skill_id: z.string().optional(),
  step_id: z.string().optional(),
  expected_fields: z.array(z.string()).default([]),
  question_summary: z.string().nullable().optional(),
  kind: z.string().optional(),
  requirements: z.array(z.record(z.unknown())).optional()
})

export const staffdeckRunResultSchema = z.object({
  run_id: z.string().min(1),
  session_id: z.string().nullable().optional(),
  reply: z.string().default(''),
  citations: z.array(z.record(z.unknown())).default([]),
  tool_calls: z.array(z.record(z.unknown())).default([]),
  task_results: z.array(z.record(z.unknown())).default([]),
  awaiting_input: staffdeckAwaitingInputSchema.nullable().optional(),
  artifacts: z.array(z.record(z.unknown())).default([])
})
```

事件契约（renderer 感知「远端轮次状态」的最小面，不承载正文）：

```ts
export const digitalEmployeeRemoteRunUpdatedEvent = defineEventContract({
  name: 'digitalEmployee.remoteRunUpdated',
  payload: z.object({
    sessionId: EntityIdSchema,
    employeeId: z.string().min(1),
    phase: z.enum(['started', 'awaiting_input', 'completed', 'failed', 'cancelled']),
    runId: z.string().optional(),
    message: z.string().optional(),
    updatedAt: TimestampMsSchema
  })
})
```

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2（PASS），再跑 `test/main/contracts` 全目录回归。

- [x] **Step 5: Commit**

```bash
git add src/shared/contracts/routes/digitalEmployeeRemote.routes.ts src/shared/contracts/routes.ts src/shared/contracts/events/digitalEmployee.events.ts test/main/contracts/digitalEmployeeRemoteSchema.test.ts
git commit -m "feat(digital-employee): add staffdeck remote run contracts"
```

---

### Task 2: SSE 行协议解析器（纯函数）

**Files:**
- Create: `src/main/digital-employee/sseParser.ts`
- Test: `test/main/digital-employee/sseParser.test.ts`

**Interfaces:**
- Produces: `createSseParser(): { push(chunk: string): StaffdeckSseFrame[]; flush(): StaffdeckSseFrame[] }`
- Produces: `type StaffdeckSseFrame = { id?: string; event?: string; data: string }`
- 约定：解析器**只负责分帧与字段切分**，不做 JSON 解析、不校验事件名——那是 Task 3 的职责

- [x] **Step 1: 写失败测试**

```ts
// test/main/digital-employee/sseParser.test.ts
import { describe, expect, it } from 'vitest'
import { createSseParser } from '../../../src/main/digital-employee/sseParser'

describe('createSseParser', () => {
  it('splits a complete frame into id/event/data', () => {
    const parser = createSseParser()
    const frames = parser.push('id: 1\nevent: run.output.delta\ndata: {"content":"a"}\n\n')
    expect(frames).toEqual([{ id: '1', event: 'run.output.delta', data: '{"content":"a"}' }])
  })

  it('skips keepalive comment lines', () => {
    const parser = createSseParser()
    const frames = parser.push(': keepalive\n\n')
    expect(frames).toEqual([])
  })

  it('buffers a frame split across three chunks', () => {
    const parser = createSseParser()
    expect(parser.push('id: 2\nevent: run.output.')).toEqual([])
    expect(parser.push('delta\ndata: {"content":')).toEqual([])
    expect(parser.push('"b"}\n\n')).toEqual([
      { id: '2', event: 'run.output.delta', data: '{"content":"b"}' }
    ])
  })

  it('handles CRLF separators from proxies', () => {
    const parser = createSseParser()
    const frames = parser.push('id: 3\r\nevent: run.status\r\ndata: {}\r\n\r\n')
    expect(frames[0]).toMatchObject({ id: '3', event: 'run.status' })
  })

  it('drops an unterminated frame on flush instead of emitting a partial', () => {
    const parser = createSseParser()
    parser.push('id: 4\nevent: run.output.delta\ndata: {"content":')
    expect(parser.flush()).toEqual([])
  })

  it('joins multiple data lines of one frame with newlines', () => {
    const parser = createSseParser()
    const frames = parser.push('event: run.status\ndata: line1\ndata: line2\n\n')
    expect(frames[0].data).toBe('line1\nline2')
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `... vitest.mjs run test/main/digital-employee/sseParser.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

要点（每条都对应上文核实的服务端行为）：
- 维护 `buffer`，按 `\n\n` 或 `\r\n\r\n` 切帧；切分前统一把 `\r\n` 归一化为 `\n`
- 逐行处理：`:` 开头 → 注释，跳过；`id:` / `event:` / `data:` 按第一个 `:` 切分并 trim 前导单空格
- 多行 `data:` 用 `\n` join
- `flush()` 丢弃未终止的残帧（不把半截 JSON 交给上层，避免误判为坏事件）
- 纯同步、无 IO、无状态泄漏

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2（PASS，6 例）

- [x] **Step 5: Commit**

```bash
git add src/main/digital-employee/sseParser.ts test/main/digital-employee/sseParser.test.ts
git commit -m "feat(digital-employee): add sse frame parser for staffdeck streams"
```

---

### Task 3: StaffDeck 远端客户端 + 远端执行器

**Files:**
- Create: `src/main/digital-employee/remoteClient.ts`（HTTP 面：建会话 / 发 run:stream / 查 result / 取消）
- Create: `src/main/digital-employee/remoteRunner.ts`（编排面：SSE → blocks → 落库 + 发事件）
- Create: `src/main/digital-employee/remoteSessionRegistry.ts`（会话绑定持久化）
- Modify: `src/shared/contracts/routes/config.routes.ts` + `src/main/app/settingsRoutes.ts`（注册 `digitalEmployee.remoteSessions` 键，仿 D1 的 `configHashes` 三处注册）
- Test: `test/main/digital-employee/remoteClient.test.ts`、`test/main/digital-employee/remoteRunner.test.ts`、`test/main/digital-employee/remoteSessionRegistry.test.ts`

**Interfaces:**
- Produces: `class StaffdeckRemoteClient { constructor(config, fetchImpl?) ; createSession(input): Promise<{ id: string }> ; streamRun(input, onFrame): Promise<{ runId: string }> ; getResult(runId): Promise<StaffdeckRunResult> ; cancelRun(runId): Promise<void> }`
- Produces: `class StaffdeckRemoteRunner { constructor(deps) ; run(input: RemoteRunInput): Promise<RemoteRunOutcome> }`
- Produces: `createRemoteSessionRegistry(deps): { get(sessionId), set(sessionId, binding), delete(sessionId), listAll() }`

**关键实现约束（逐条有据）：**

1. **`external_user_id` 走 body**，不是 header（`schemas.py:139-140`）。同时把 D1 的 `EXTERNAL_USER_ID_HEADER` 从分发请求里去掉——已确认惰性，去掉不减功能。
2. **`Idempotency-Key` 用确定性值**：`deepchat:{sessionId}:{turnId}`，保证进程重启后重发同一轮不产生第二个 run（`idempotency.py:41-60`）。
3. **`createSession` 传 `external_session_id = sessionId`**，靠服务端天然幂等拿回原会话（`sessions.py:81-97`），不自己判重。
4. **run 的 `session_id` 必须用远端 id**，不是本地 id。
5. **建会话之后才能发 run**：`streamRun` 前若 registry 里没有 `remoteSessionId`，先 `createSession`。
6. **`X-Run-ID` 在响应头**，`onFrame` 可能在此之前就被调用，所以先读 header 再进循环；拿不到 header 时报错而不是猜测。
7. **终止条件三选一**：收到 `run.output.completed` / `run.succeeded` / `run.failed` / `run.cancelled` 任一（`runs.py:357`、`jobs.py:394`）。不要只认 completed。
8. **断线续传换端点**：`POST runs:stream` 断开后不能重放，必须 `GET /runs/{runId}/events` 并带 `Last-Event-ID: {末次 sequence}`；最多重试 3 次，指数退避。
9. **终态后补查 result**：`GET /runs/{runId}/result` 要求 status 为 succeeded，否则 409 `RUN_NOT_SUCCEEDED`；此情形下降级为「用累积文本 + 无 citations」，不判失败。
10. **超时分层**：建会话 10s；run 无数据空闲 120s 视为卡死并 abort；整体不设硬上限（长任务正常）。
11. **`awaiting_input` 触发 `digitalEmployee.remoteRunUpdated`** 的 `phase: 'awaiting_input'`，正文取 `question_summary`，字段列表取 `expected_fields`。

**流式落库（复用现有通道，不新建）**：

```ts
// remoteRunner 内部：与 echo.ts 同构，但由 SSE 驱动
const orderSeq = transcript.getNextOrderSeq(sessionId)
const messageId = transcript.createAssistantMessage(sessionId, orderSeq)
let text = ''
const push = (flush: boolean) => {
  const blocks: AssistantMessageBlock[] = [
    { id: messageId, type: 'content', content: text, status: 'loading', timestamp: Date.now() }
  ]
  if (flush) transcript.updateAssistantContent(messageId, blocks)
  publishEvent('chat.stream.updated', {
    kind: 'snapshot',
    requestId: runId,
    sessionId,
    messageId,
    updatedAt: Date.now(),
    blocks: cloneBlocksForRenderer(blocks)
  })
}
// delta → text += content，节流 120ms 推 renderer / 600ms 落库（对齐 echo.ts:7-8）
// 终态 → blocks status 'success'，updateMessageStatus(messageId, 'sent')，再发 chat.stream.completed
// 失败 → blocks 追加 type:'error'，updateMessageStatus(messageId, 'error')，发 chat.stream.failed
```

注意：`cloneBlocksForRenderer` 会跑 zod 校验（`clientMessageProjection.ts:37-41`），因此 block 必须满足 `AssistantMessageBlockSchema`（`common.ts:551+`；`status` 是必填枚举）。

- [x] **Step 1: 写失败测试**

`remoteClient.test.ts` 至少覆盖：
```ts
it('sends external_user_id in the body, never as a header', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: 'remote-1' }))
  await new StaffdeckRemoteClient(cfg, fetchMock).createSession({
    externalSessionId: 'local-1', externalUserId: 'user-1', title: 't', metadata: { source: 'deepchat' }
  })
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://sd.example/api/v1/agents/emp-1/sessions')
  expect(JSON.parse(init.body).external_user_id).toBe('user-1')
  expect(init.headers['x-external-user-id']).toBeUndefined()
})

it('reuses the deterministic idempotency key so a retry does not fork the run', async () => {
  const fetchMock = vi.fn().mockResolvedValue(streamResponse([...]))
  const client = new StaffdeckRemoteClient(cfg, fetchMock)
  await client.streamRun({ runKey: 'deepchat:local-1:turn-1', ... })
  await client.streamRun({ runKey: 'deepchat:local-1:turn-1', ... })
  expect(fetchMock.mock.calls[0][1].headers['idempotency-key']).toBe('deepchat:local-1:turn-1')
  expect(fetchMock.mock.calls[1][1].headers['idempotency-key']).toBe('deepchat:local-1:turn-1')
})

it('reads X-Run-ID before consuming frames', async () => {
  // 断言 onFrame 首次被调用时 runId 已可用
})

it('resumes from GET /runs/{id}/events with the last sequence after a broken stream', async () => {
  // 第一次 stream 在第 3 帧后抛错，第二次请求 URL 应为 /api/v1/runs/r1/events，header Last-Event-ID = '3'
})

it('maps problem+json code instead of title on failure', async () => {
  // 403 + {code:'INSUFFICIENT_SCOPE',title:'X'} → 错误里带 INSUFFICIENT_SCOPE
})
```

`remoteRunner.test.ts` 至少覆盖：
```ts
it('accumulates deltas into one content block and marks it sent on completion', async () => {
  // delta('你') + delta('好') + completed → updateAssistantContent 末次调用 content === '你好'
  // updateMessageStatus(messageId, 'sent')
  // publishEvent 收到 chat.stream.updated × N 与 chat.stream.completed × 1
})

it('does not treat completed as carrying the final text', async () => {
  // completed 无 content 时，text 仍为 delta 累积结果
})

it('queries run result after completion to surface awaiting_input', async () => {
  // getResult 返回 awaiting_input → 发 digitalEmployee.remoteRunUpdated phase='awaiting_input'
})

it('marks the message error and emits chat.stream.failed on run.failed', async () => {})
it('tolerates RUN_NOT_SUCCEEDED and keeps the accumulated text', async () => {})
```

`remoteSessionRegistry.test.ts`：set/get/delete 往返、重启后从 config entry 恢复、损坏数据按空处理。

- [x] **Step 2: 跑测试确认失败**

Run: `... vitest.mjs run test/main/digital-employee/remoteClient.test.ts test/main/digital-employee/remoteRunner.test.ts test/main/digital-employee/remoteSessionRegistry.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

按上文 11 条约束逐条落地。`remoteRunner` 依赖以接口注入（`transcript` / `publishEvent` / `cloneBlocksForRenderer` / `registry` / `client`），便于用 fake 测试而不起 Electron。

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2（PASS），再跑 `test/main/digital-employee` 全目录回归（D1 的 provider/factory 用例必须仍全绿）。

- [x] **Step 5: Commit**

```bash
git add src/main/digital-employee/remoteClient.ts src/main/digital-employee/remoteRunner.ts src/main/digital-employee/remoteSessionRegistry.ts src/shared/contracts/routes/config.routes.ts src/main/app/settingsRoutes.ts test/main/digital-employee
git commit -m "feat(digital-employee): add staffdeck remote client, runner and session registry"
```

---

### Task 4: 分链接入（ChatService 单点）+ 绑定路由 + store 分支

**Files:**
- Create: `src/main/digital-employee/remoteRoutes.ts`（`bindRemoteSession` / `remoteStatus` 两个 route）
- Modify: `src/main/session/chatService.ts`（构造注入可选 `remoteTurn`，`sendMessage` 开头分流）
- Modify: `src/main/app/composition.ts`（组装 client/runner/registry，注入 ChatService 与新 routes）
- Modify: `src/renderer/api/DigitalEmployeeClient.ts`（bindRemoteSession / remoteStatus）
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`（`startConversation` 的 remote 分支 + hybrid 切换）
- Test: `test/main/digital-employee/remoteRoutes.test.ts`、`test/main/session/chatService.remoteRouting.test.ts`、扩展 `test/renderer/stores/digitalEmployeeStore.test.ts`

**Interfaces:**
- Consumes: Task 3 的 runner / registry / client
- Produces: `ChatService` 构造新增 `remoteTurn?: { handles(sessionId: string): boolean; send(sessionId: string, content: SendMessageInput): Promise<MessageStartResult> }`
- Produces: store `startConversation` 对 `executionMode === 'remote'` 走「建空会话 → bindRemoteSession → 首轮由 main 拉起」

**分流语义（必须严格如此，否则会双写消息）：**

```ts
async sendMessage(sessionId, content, options) {
  // 远端会话：整轮交给远端执行器，ChatService 不再走 turn/runtime 路径
  if (this.deps.remoteTurn?.handles(sessionId)) {
    return this.deps.remoteTurn.send(sessionId, normalizeSendMessageInput(content))
  }
  // ...原逻辑不变
}
```

`handles()` 只读 registry，不读 renderer 状态。首轮消息（`openingQuestion`）由 `bindRemoteSession` 在 main 内直接调 runner，不经 ChatService，避免「renderer 建会话时 message 为空 → 无首轮」的缺口。

**renderer 侧改动要点：**
- `remote` 员工：`createSession({ agentId: DIGITAL_EMPLOYEE_AGENT_ID, message: '' })` → `client.bindRemoteSession({ sessionId, employeeId, openingQuestion })` → `pageRouter.goToChat(sessionId)`。原 `bindSession`（展示用）照旧 best-effort。
- 系统提示词、SOP 注入、知识片段、工具白名单在 remote 模式下**全部不下传**（服务端自己持有配置，且 `_SENSITIVE_KEYS` 会剥离 system_prompt）。仅在本地会话上写一条 metadata 说明「云端执行」用于回看。
- `hybrid` 员工：默认走 local 分支（与服务端已筛掉 remote SOP 的事实一致）；提供 `switchConversationToRemote(sessionId)`，切换时把最近 6 轮 user+assistant 文本拼成摘要，作为远端首轮 `input` 的前缀，并写 registry。切换不可逆（同一本地会话不来回切），避免状态机复杂化。

- [x] **Step 1: 写失败测试**

```ts
// chatService.remoteRouting.test.ts
it('routes a bound session to the remote turn port and skips the local turn', async () => {
  const turn = { sendMessage: vi.fn() }
  const remoteTurn = { handles: () => true, send: vi.fn().mockResolvedValue({ requestId: 'r', messageId: 'm' }) }
  const service = new ChatService({ turn, projection, sessionPermissionPort, scheduler, remoteTurn })
  await service.sendMessage('s1', 'hi')
  expect(remoteTurn.send).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'hi' }))
  expect(turn.sendMessage).not.toHaveBeenCalled()   // 关键：不得双写
})

it('keeps the local path untouched for unbound sessions', async () => {
  // handles → false，断言 turn.sendMessage 被调用一次、remoteTurn.send 未调用
})

// remoteRoutes.test.ts
it('binds a remote session and starts the opening run', async () => {})
it('returns 409-shaped error without leaking the api key when staffdeck rejects', async () => {
  expect(JSON.stringify(result)).not.toContain('sd_live_')
})

// digitalEmployeeStore.test.ts 追加
it('creates an empty local session then binds it remotely for remote employees', async () => {
  // 断言 createSession 收到的 message === ''
  // 断言 client.bindRemoteSession 被调用，参数含 employeeId 与 openingQuestion
})
it('keeps the local injection path for local employees', async () => {})
```

- [x] **Step 2: 跑测试确认失败**

Run: `... vitest.mjs run test/main/session/chatService.remoteRouting.test.ts test/main/digital-employee/remoteRoutes.test.ts test/renderer/stores/digitalEmployeeStore.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

按上述分流语义落地。`composition.ts` 组装顺序：`settingsStore` + `secretStore` → `StaffdeckRemoteClient` → `remoteSessionRegistry`（读 config）→ `StaffdeckRemoteRunner`（注入 transcript / publishEvent）→ 传给 `createChatService` 与新 routes。配置热替换时（D1 的 `onConfigurationChanged`）重建 client 与 runner，registry 保留。

- [x] **Step 4: 跑测试 + 类型检查 + lint（分开）**

Run: 定向 vitest（PASS）→ `vue-tsc -p tsconfig.app.json --noEmit` → `tsc -p tsconfig.node.json` → `oxlint <改动文件>`。四类命令依次执行，不并行。

- [x] **Step 5: Commit**

```bash
git add src/main/digital-employee/remoteRoutes.ts src/main/session/chatService.ts src/main/app/composition.ts src/renderer/api/DigitalEmployeeClient.ts src/renderer/src/stores/digitalEmployeeStore.ts test/main test/renderer
git commit -m "feat(digital-employee): route bound sessions to staffdeck remote execution"
```

---

### Task 5: UI 状态（徽标 / 追问输入 / 错误码文案）+ i18n

**Files:**
- Modify: `src/renderer/src/components/chat/ChatTopBar.vue`（`local` / `remote` 徽标）
- Modify: `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`（卡片上的执行位置标识）
- Create: `src/renderer/src/components/chat/RemoteAwaitingInputPanel.vue`（`question_summary` + `expected_fields` 提示条，输入仍复用现有 ChatInputBox）
- Modify: 20 locale 的 `digitalEmployee.json` / `chat.json`
- Test: 扩展 `test/renderer/pages/digitalEmployee/*`、新增 `test/renderer/components/chat/RemoteAwaitingInputPanel.test.ts`

**Interfaces:**
- Consumes: `digitalEmployee.remoteRunUpdated` 事件的 `phase` / `message`
- Produces: `staffdeckErrorCodeToI18nKey(code)` —— 把 `INSUFFICIENT_SCOPE` / `AGENT_NOT_FOUND` / `RUN_NOT_SUCCEEDED` / `EXTERNAL_SESSION_CONFLICT` / `ACTION_BUDGET_EXHAUSTED` 等映射为可读文案；未知码回落到通用「云端执行失败（code）」，**永远不直接展示服务端 detail**（可能含内部路径）

- [x] **Step 1: 写失败测试**（徽标渲染、追问面板展示 `expected_fields`、未知错误码不泄露 detail）
- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现 + 20 locale**
- [x] **Step 4: 跑测试 + vue-tsc + oxlint（分开）**
- [x] **Step 5: Commit**（`7e21ccab`）

**落地后的偏差记录（实现时发现，与计划描述不符）：**

1. **映射表不能照抄计划里的码。** 计划举例的 `ACTION_BUDGET_EXHAUSTED` 确实存在
   （`harness_agent.py` 的 action budget 分支），但原实现里登记的 `RUN_FAILED` /
   `UNAUTHORIZED` / `REMOTE_REQUEST_FAILED` 在服务端与客户端**都没有产生点**；同时
   真实存在的 `HARNESS_EXECUTION_LOST`、`NOT_AUTHENTICATED`、`API_KEY_EXPIRED` 被漏掉。
   现表只留可追溯产生点的码，并加了一条守护测试：每个登记的码都必须能在 en-US 里
   解析出字符串，写错 key 会直接失败而不是在 UI 上渲染原始 key。
2. **`run.failed` 被压平成 `RUN_FAILED` 是一个真缺陷。** 该帧体带
   `{"code", "message"}`（`agent_loop.py` 的 `LLM_ERROR` / `HARNESS_V2_ERROR`），
   原实现硬编码通用码，导致「模型调用失败」与「harness 出错」在 UI 上无法区分。
   现从帧体取 `code`（只取 code，`message` 不出本进程），缺失时回落 `RUN_FAILED`。
3. **状态不放 store。** 计划把追问态写在 store 里，实现改为会话级 composable
   `useRemoteAwaitingInput`：它按 `sessionId` 过滤事件、用 token 防迟到回查覆盖
   新一轮、并随组件作用域自动退订。放 store 会让「当前会话的追问态」变成全局表，
   多标签切换时容易残留。
4. **追问面板刻意不含输入框。** 回答就是下一条普通消息，复用现有 `ChatInputBox`；
   自带输入框会出现两个输入框并让「发到哪个通道」变得含糊。

---

### Task 6: 真实环境联调与文档收尾

- [ ] **Step 1: 起本地 StaffDeck 联调环境**（沿用 D1 的 Compose/单体启动方式，`/api/v1` 挂载点见 `app/main.py:259`）
- [ ] **Step 2: 手工验证三条链路**（记录到 plan 末尾）
  1. `remote` 员工：首轮出字 → 完成 → 消息落库 → 重进会话可见全文
  2. 追问：`awaiting_input` 出现 → 补充信息 → 同 session 续跑
  3. 断网撕裂：流中断 → 带 `Last-Event-ID` 续传 → 文本不重复不丢字
- [ ] **Step 3: 缺陷登记与修复**（发现的每个问题：先写失败测试再修）
- [ ] **Step 4: 修订 spec §5.2 / §9**（把本计划「4 处偏差」写回设计文档）
- [ ] **Step 5: 全量回归**（`test/main` 与 `test/renderer` 分开跑；renderer 需 `--maxWorkers=2 --minWorkers=1`，本机默认并发会 OOM）
- [ ] **Step 6: Commit**

```bash
git commit -m "docs(digital-employee): record staffdeck d2 verification and revise spec"
```

---

## 风险与开放项

| 风险 | 缓解 |
|---|---|
| SSE 在 main 里长时间占用，进程重启丢流 | registry 持久化 `runId` + 末次 sequence；重启后走 `GET /runs/{id}/events` 续传 |
| delta 与最终文本不一致（引用修复后会走 replace，但服务端暂无产生点） | 终态后用 `GET /runs/{id}/result` 的 `reply` **覆盖**累积文本，以服务端终稿为准。这条是兜底，不是主路径 |
| 远端执行时长超过 renderer 的 generating 状态预期 | 由 `digitalEmployee.remoteRunUpdated` 驱动状态，不依赖本地 runtime 的 pending 队列 |
| 同一会话并发两轮 | `ChatService` 现有 abort/pending 语义对远端不适用；D2 在 runner 内对同 session 加互斥，第二轮直接拒绝并提示 |
| 服务端新增事件名导致 `z.enum` 拒绝 | 解析失败按「未知事件忽略 + 计数告警」处理，不中断流（与 D1 的 schema 非严格策略一致） |

**开放项（需在 Task 6 用真实运行结果确认）**：
1. `run.status` 的 phase 取值全集（目前源码只看到 `planning`/`received`/`cancelled`），是否可作为细粒度进度提示。
2. `GET /runs/{id}/result` 在 `awaiting_input` 场景下的 status 到底是 `succeeded` 还是 `awaiting_input`——`runs.py:495-496` 只允许 succeeded，而 `jobs.py` 侧 status 枚举含 `awaiting_input`。若实际返回非 succeeded，则改为调用 `GET /agents/{id}/sessions/{sid}`（`sessions.py:189-200` 恒返回 `awaiting_input`）。
3. ~~附件透传：`AgentRunCreate.attachments` 接受 `ChatAttachmentRead` 形状（`session_schema.py:258-270`），但 deepchat 的 `MessageFile` 与之字段不同，D2 先不传附件（远端首轮仅纯文本），附件能力留到 D2 后续或 D5。~~
   **已于 2026-10-24 在 P1-6 补齐**：`remoteAttachments.ts` 把本地附件裁成服务端可接收的三种通道（文本内联、PDF 提取文本、图片 `data_url`），其余类型明确跳过并在聊天页提示。详见审计文档 P1-6。

### Task 6 实测结论（2026-10-23，本地 StaffDeck 服务 + 真实 client/runner）

环境：`backend/.venv` 起 `uvicorn app.main:app --port 5174`，用 `tenant_demo` 下带 6 个 public API scope 的 credential 直连；deepchat 侧用真实 `StaffdeckRemoteClient` + `StaffdeckRemoteRunner`（transcript/registry 用内存适配器）跑完整链路。

**三个开放项全部收敛：**

| # | 结论 | 证据 |
|---|---|---|
| 1 | `run.status` 的 phase **只有 `planning` 一个值**，不能当细粒度进度 | `core/agent_loop.py:338` 是唯一 `_stream_status(...)` 调用点；取消走独立事件 `stream_cancelled`（其 payload 的 `phase` 为 `cancelled`，事件名映射成 `run.cancelled`），不经过 `run.status` |
| 2 | awaiting_input 时 job 仍 `succeeded`，`/result` 返回 200，`awaiting_input` 取 `result_json` 顶层 | `public_api/jobs.py:418-428` handler 返回后无条件 `_terminalize_job(status="succeeded")`；`APIJob.status` 无 `awaiting_input` 取值。**不改调 sessions 端点** |
| 3 | ~~附件不通传~~ **已于 2026-10-24 修复（P1-6）** | `ChatAttachmentRead`（`session_schema.py:258-270`）与 `MessageFile` 异构；现由 `remoteAttachments.ts` 做字段映射与能力裁剪 |

**链路实测结果（3 项全绿）：**

1. 首轮：建会话 → SSE 13 帧（`job.queued` / `run.started` / `run.executing` / `run.status` / 8×`run.output.delta` / `run.output.completed` / `run.succeeded`）→ delta 累积 62 字 → 落库文本与终稿逐字一致 → 绑定写入 `runId` + `lastEventId=13` → 发出 `chat.stream.updated` 与 `digitalEmployee.remoteRunUpdated`。
2. 续传：`GET /runs/{id}/events` 带 `Last-Event-ID: 5` 精确回放 id 6–14，与 `>5` 的期望集合**顺序与内容都相等**（不重不漏）；`lastEventId` 全量 13 帧。
3. 追问：当前环境 `model_configs` 为空，无法产生真实 `awaiting_input`（该状态只在真实 LLM 走到 SOP `expected_user_info` 收集步骤时才出现，`harness_v2_engine.py:1503-1512`）。已确认代码路径正确（`awaitingInput` 为 null 时不误判），真实追问需服务端配好模型后复验。

**两条新发现（已写回 spec §5.2）：**

- **服务端把执行期错误当作正文回复**：无模型时流里推的是 `run.output.delta` 分片（「Harness v2 执行出错（HARNESS_V2_ERROR）：…」）并以 `run.succeeded` 结束，`/result.reply` 也是这段文本。**「有正文」≠「执行成功」**，失败提示必须只由 `phase`/`messageCode` 驱动，不能靠正文是否为空判断。
- **`Idempotency-Key` 语义已验证**：同 key 同 body 重放返回同一 `job_id` 的完整流；同 key 不同 body → 409 `IDEMPOTENCY_CONFLICT`。D2 的 `deepchat:{sessionId}:{turnId}` 确定性键有效。

**已知限制（不阻塞 D2 交付）：**
- 追问链路端到端需服务端配置可用模型；D2 侧的 `awaitingInput` 解析、`remoteStatus` 回查与提示条渲染均有单测覆盖。
- ~~附件透传未实现（开放项 3）~~ **已于 2026-10-24 修复（P1-6）**：仅 docx/xlsx/音频等无可信通道的格式仍不支持，且会显式提示用户。


## 实施结果（2026-10-23，代码已落地并提交）

| Task | 提交 | 交付 |
|---|---|---|
| 1 远端执行契约 | `abade886` | `digitalEmployeeRemote.routes.ts`：32 个事件名、awaiting_input / run result schema、三个路由契约、`makeStaffdeckRunKey` |
| 2 SSE 行协议解析器 | `07d18944` | `sseParser.ts` 纯函数，跳过 `:` 注释行，`flush()` 丢弃残帧 |
| 3 远端客户端/执行器/绑定表 | `91fed6ae` | `remoteClient`（含 `X-Run-ID` 先取、四终止事件、续传退避）、`remoteRunner`（delta 累积 + 终态补查 + 落库）、`remoteSessionRegistry`；配置键三处注册 |
| 4 分链接入 | `0dee3bee`（main）+ `54f9b715`（renderer） | `ChatService` 单点分流 + 三个绑定路由 + composition 组装；store 的 remote 分支提到知识检索之前 |
| 5 UI 状态与 i18n | `7e21ccab` | 徽标、追问提示条、错误码映射表 + 20 locale |
| 6 联调与 spec 修订 | `81d5c806` | 本地起服务跑通首轮/续传、3 个开放项全部收敛、spec §5.2 与本文档回写实测结论 |

**Task 6 Step 1/2/3 已执行**（本地 StaffDeck 服务 + 真实 client/runner，结论见上文「Task 6 实测结论」）。Step 4（spec 修订）内容：

- §5.2 补齐「4 处偏差」正文，并把「补充信息输入框」改为「提示条 + 复用下一条消息」；
- 关键决策表标注 `execution_hint` 由服务端消费、客户端无法逐条路由；
- §8 里程碑表修正 D2 依赖：**不受 M5 阻塞**，通道④是零新增接口；
- §9 修正知识同步开关为**默认关闭**（`is not True`），回流改为服务端承接、客户端无开关。

**遗留项（转入后续）：**

1. deepchat 的 `EXTERNAL_USER_ID_HEADER` 仍在分发请求里发送。已确认惰性无害（分发端点不消费），但同一条 `external_user_id` 有两套传法容易误导后续维护，建议下次动 D1 Provider 时一并清理。
2. Task 6 的三条链路中，**追问续跑未能在本机走通真实路径**：`awaiting_input` 只在真实 LLM 走到 SOP 的 `expected_user_info` 收集步骤时产生（`harness_v2_engine.py:1503-1512`），而本地库 `model_configs` 为空。D2 侧的 `awaitingInput` 解析、`remoteStatus` 回查、提示条渲染均有单测覆盖，但端到端需服务端配好模型后复验。
3. ~~附件透传未实现（`ChatAttachmentRead` 与 `MessageFile` 异构），远端首轮仅纯文本。~~ **已于 2026-10-24 修复（P1-6）**。
4. `tsc -p tsconfig.node.json` 有 10 个既有错误，全部在 `*/data/database.ts`（`better-sqlite3-multiple-ciphers` 具名类型），与 D2 无关。
5. renderer 全量回归在本机（4GB 默认堆）会 OOM，须按目录分批 + `--maxWorkers=1` 运行。本轮分批结果：`api`/`utils`/`stores`/`components` 有 3 个**既有**失败文件（`documentsClient`（`listTasks` 已改传 `limit:200` 而测试未同步，源于 `aa1e0fd8`）、`pluginCatalogStore`、`providerStore`/`ModelProviderSettings`），经 `git show --name-only` 逐个核对 5 个 D2 提交均未触碰这些文件；其余 16 个目录全绿。

## Plan 自审

- spec §5.2 的 5 个子项（分流、SSE、hybrid、徽标、上下文摘要）在 Task 1/3/4/5 均有落点；其中 hybrid 按实测降级为整会话切换，已单列偏差说明。
- spec §7 的测试计划第 3、4 项（分流测试、SSE 消费测试）对应 Task 2/3/4 的用例；「Last-Event-ID 续传」有独立用例。
- 协议不确定性已收敛：**没有 TBD 项**，所有端点、header、事件名、字段名都能指到 StaffDeck 源码行。剩余 3 个开放项都是「两种都合规、需实测取值」的细节，不影响架构。
- 安全：API Key 仅 main；错误文案不透传服务端 detail；renderer 不接触 SSE。
