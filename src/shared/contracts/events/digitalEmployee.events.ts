import { z } from 'zod'
import { EntityIdSchema, TimestampMsSchema, defineEventContract } from '../common'

/** StaffDeck 连接配置已变更（保存/清除密钥后），renderer 应重新拉取员工列表。 */
export const digitalEmployeeConfigurationChangedEvent = defineEventContract({
  name: 'digitalEmployee.configurationChanged',
  payload: z.object({ changedAt: TimestampMsSchema })
})

/** 远端轮次的相位。正文仍走 `chat.stream.updated`，本事件只承载状态。 */
export const DIGITAL_EMPLOYEE_REMOTE_RUN_PHASES = [
  'started',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled'
] as const

export const DigitalEmployeeRemoteRunPhaseSchema = z.enum(DIGITAL_EMPLOYEE_REMOTE_RUN_PHASES)
export type DigitalEmployeeRemoteRunPhase = z.infer<typeof DigitalEmployeeRemoteRunPhaseSchema>

/**
 * 远端 run 状态变化。刻意不携带回复正文与追问字段明细：
 * 正文走既有 `chat.stream.updated`，追问明细由 `remoteStatus` 路由按需拉取，
 * 避免同一份内容在两个通道里各自演化。
 */
export const digitalEmployeeRemoteRunUpdatedEvent = defineEventContract({
  name: 'digitalEmployee.remoteRunUpdated',
  payload: z.object({
    sessionId: EntityIdSchema,
    employeeId: z.string().min(1).max(64),
    phase: DigitalEmployeeRemoteRunPhaseSchema,
    runId: z.string().min(1).optional(),
    /** 便于直接提示的错误码（如 RUN_NOT_SUCCEEDED），不含服务端 detail */
    messageCode: z.string().max(128).optional(),
    updatedAt: TimestampMsSchema
  })
})
