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
 * 本地附件没能透传给服务端的原因。
 *
 * 与 `remoteAttachments.ts` 的 `RemoteAttachmentSkipReason` 一一对应，在这里单独
 * 声明是因为事件契约要跨进程校验，不能依赖主进程模块。
 */
export const DIGITAL_EMPLOYEE_REMOTE_ATTACHMENT_SKIP_REASONS = [
  'unsupported_type',
  'empty_content',
  'invalid_image_data',
  'image_type_unsupported',
  'image_too_large',
  'payload_budget_exceeded',
  'too_many_attachments'
] as const

export const DigitalEmployeeRemoteAttachmentSkipReasonSchema = z.enum(
  DIGITAL_EMPLOYEE_REMOTE_ATTACHMENT_SKIP_REASONS
)
export type DigitalEmployeeRemoteAttachmentSkipReason = z.infer<
  typeof DigitalEmployeeRemoteAttachmentSkipReasonSchema
>

export const DigitalEmployeeSkippedAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  reason: DigitalEmployeeRemoteAttachmentSkipReasonSchema
})
export type DigitalEmployeeSkippedAttachment = z.infer<
  typeof DigitalEmployeeSkippedAttachmentSchema
>

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
    /**
     * hybrid 会话在本轮失败后已退回本地执行。
     *
     * 必须由主进程告知：绑定表在 main，renderer 无从推断「下一轮会走哪条路」，
     * 用户刚看到一次失败、下一条消息却突然由本地执行，没有这句话就是静默换引擎。
     */
    fallbackToLocal: z.boolean().optional(),
    /**
     * 本轮被丢弃的本地附件（只有文件名与原因码，不含内容）。
     *
     * 服务端没有附件上传端点，图片之外的二进制文件没有可信通道；对话框里明明挂着
     * 一个文件、模型却全然不知，是比报错更难自查的失败，因此必须显式告知。
     */
    skippedAttachments: z.array(DigitalEmployeeSkippedAttachmentSchema).optional(),
    updatedAt: TimestampMsSchema
  })
})
