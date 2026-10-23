import { z } from 'zod'
import { EntityIdSchema, defineRouteContract } from '../common'

/**
 * StaffDeck 远端执行（D2）的协议契约。
 *
 * 所有字段形状均对照 StaffDeck 后端源码核实，不做推测：
 * - SSE 帧与事件名：`app/public_api/jobs.py:570`、`app/public_api/runs.py:43-75`
 * - run result 与 awaiting_input：`app/public_api/runs.py:488-497`、
 *   `app/session/session_schema.py:137-143`
 *
 * 语义约定：本文件的 schema 只描述「线上形状」，不含业务判定。
 */

/**
 * SSE 流里可能出现的事件名白名单。
 *
 * 服务端把两类事件写进同一个 job 事件表，因此都会从同一条流里出来：
 * 1. trace 映射（`runs.py` 的 `_TRACE_EVENT_MAP`，28 项）
 * 2. job 生命周期（`jobs.py` 的 `job.queued` / `run.started` / `{kind}.{status}` /
 *    `job.cancel_requested`，由 `create_job:87`、`run_job:406`、
 *    `_emit_terminal_job_event:394`、`cancel:530` 发出）
 *
 * `run.executing` 由 `runs.py:187` 单独发出，不在映射表内。
 */
export const STAFFDECK_RUN_EVENT_NAMES = [
  // job 生命周期
  'job.queued',
  'job.cancel_requested',
  'run.started',
  'run.executing',
  // trace → run.* 映射（runs.py _TRACE_EVENT_MAP）
  'run.status',
  'run.plan',
  'run.intent',
  'run.output.delta',
  'run.output.replace',
  'run.output.completed',
  'run.cancelled',
  'run.failed',
  'run.succeeded',
  'run.task_frame.started',
  'run.task_frame.finished',
  'run.task_frame.completed',
  'run.task_frame.waiting',
  'run.task_frame.released',
  'run.capability.search',
  'run.capability.described',
  'run.capability.completed',
  'run.action.started',
  'run.action.failed',
  'run.sop.state',
  'run.sop.step',
  'run.sop.step.timeout',
  'run.citation',
  'run.tool.completed',
  'run.skill.trace',
  'run.skill.completed',
  'run.loop.continued',
  'run.loop.completed',
  'handoff.created'
] as const

export const StaffdeckRunEventNameSchema = z.enum(STAFFDECK_RUN_EVENT_NAMES)
export type StaffdeckRunEventName = z.infer<typeof StaffdeckRunEventNameSchema>

/**
 * 单条 SSE 事件。`id` 是 job 事件表的自增 sequence，断线续传的游标。
 * `data` 保持宽松：服务端会按需附加 `citations` 等字段（`runs.py:357-381`）。
 */
export const staffdeckRunEventSchema = z.object({
  id: z.number().int().nonnegative(),
  event: StaffdeckRunEventNameSchema,
  data: z.record(z.string(), z.unknown())
})

export type StaffdeckRunEvent = z.infer<typeof staffdeckRunEventSchema>

/**
 * 追问结构。`agent_loop.py:1000-1006` 与 `harness_v2_engine.py:1503-1512` 说明：
 * 只有 conversation 型会带 `kind` 和 `requirements`，其余字段按需出现，
 * 因此除 `expected_fields` 外全部可选。
 */
export const staffdeckAwaitingInputSchema = z.object({
  task_id: z.string().optional(),
  skill_id: z.string().optional(),
  step_id: z.string().optional(),
  expected_fields: z.array(z.string()).default([]),
  question_summary: z.string().nullable().optional(),
  kind: z.string().optional(),
  requirements: z.array(z.record(z.string(), z.unknown())).optional()
})

export type StaffdeckAwaitingInput = z.infer<typeof staffdeckAwaitingInputSchema>

/**
 * `GET /runs/{id}/result` 的响应体（`runs.py:488-497` 直接返回 `result_json`）。
 * 纯文本 run 会省略全部集合字段，所以集合一律 default 空数组。
 */
export const staffdeckRunResultSchema = z.object({
  run_id: z.string().min(1),
  session_id: z.string().nullable().optional(),
  reply: z.string().default(''),
  citations: z.array(z.record(z.string(), z.unknown())).default([]),
  tool_calls: z.array(z.record(z.string(), z.unknown())).default([]),
  task_results: z.array(z.record(z.string(), z.unknown())).default([]),
  awaiting_input: staffdeckAwaitingInputSchema.nullable().optional(),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([])
})

export type StaffdeckRunResult = z.infer<typeof staffdeckRunResultSchema>

/**
 * 把本地会话绑定到 StaffDeck 远端会话。
 *
 * `openingQuestion` 交给 main 内的 runner 直接拉起首轮，因为 renderer 建本地
 * 会话时消息体为空，若等 renderer 再发一条会与「空会话」语义冲突。
 */
export const digitalEmployeeBindRemoteSessionRoute = defineRouteContract({
  name: 'digitalEmployee.bindRemoteSession',
  input: z
    .object({
      sessionId: EntityIdSchema,
      employeeId: z.string().min(1).max(64),
      openingQuestion: z.string().max(20000).optional()
    })
    .strict(),
  output: z.object({
    remoteSessionId: z.string().min(1),
    /** 首轮 run 已拉起时返回；没有 openingQuestion 时为 null */
    runId: z.string().min(1).nullable().default(null)
  })
})

/** 查询某本地会话是否已绑定远端，以及是否在等待用户补充信息。 */
export const digitalEmployeeRemoteStatusRoute = defineRouteContract({
  name: 'digitalEmployee.remoteStatus',
  input: z.object({ sessionId: EntityIdSchema }).strict(),
  output: z.object({
    bound: z.boolean(),
    remoteSessionId: z.string().nullable().default(null),
    employeeId: z.string().nullable().default(null),
    runId: z.string().nullable().default(null),
    awaitingInput: staffdeckAwaitingInputSchema.nullable().default(null)
  })
})

/** 把 hybrid 会话显式切到云端执行；切换不可逆，避免状态机分叉。 */
export const digitalEmployeeSwitchToRemoteRoute = defineRouteContract({
  name: 'digitalEmployee.switchToRemote',
  input: z
    .object({
      sessionId: EntityIdSchema,
      employeeId: z.string().min(1).max(64),
      contextSummary: z.string().max(20000).optional()
    })
    .strict(),
  output: z.object({ remoteSessionId: z.string().min(1) })
})

export type DigitalEmployeeBindRemoteSessionInput = z.input<
  typeof digitalEmployeeBindRemoteSessionRoute.input
>

/** 生成确定性的幂等键：同一次本地轮次重发不会在服务端产生第二个 run。 */
export function makeStaffdeckRunKey(sessionId: string, turnId: string): string {
  return `deepchat:${sessionId}:${turnId}`
}
