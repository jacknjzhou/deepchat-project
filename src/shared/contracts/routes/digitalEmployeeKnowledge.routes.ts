import { z } from 'zod'
import { EntityIdSchema } from '../common'
import { defineRouteContract } from '../common'

/**
 * 数字员工本地知识同步的状态查询契约。
 *
 * 只暴露 UI 真正要渲染的字段。刻意不含 `localKnowledgeBaseId`、概念 hash 表、
 * 本地文件路径——那些是存储实现细节，一旦进契约就变成事实上的公共 API。
 */

export const KNOWLEDGE_STALE_REASONS = [
  'UNREACHABLE',
  'HTTP_ERROR',
  'PARTIAL',
  'NO_EMBEDDING_MODEL',
  'INDEX_FAILED',
  'UNKNOWN'
] as const

export const KnowledgeStaleReasonSchema = z.enum(KNOWLEDGE_STALE_REASONS)

/** `HTTP_ERROR` 的细粒度变体：保留状态码，401 与 500 的处置不同。 */
const httpReasonSchema = z.custom<`HTTP_${number}`>(
  (value) => typeof value === 'string' && /^HTTP_\d{3}$/.test(value),
  { message: 'expected HTTP_<status>' }
)

export const KnowledgeStaleReasonValueSchema = z.union([
  KnowledgeStaleReasonSchema,
  httpReasonSchema
])

export const KnowledgePackageStatusSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  stale: z.boolean(),
  staleReason: KnowledgeStaleReasonValueSchema.nullable(),
  lastSyncAt: z.string(),
  conceptCount: z.number().int().nonnegative()
})

export const digitalEmployeeKnowledgeStatusRoute = defineRouteContract({
  name: 'digitalEmployee.knowledgeStatus',
  input: z.object({ employeeId: EntityIdSchema }).strict(),
  output: z.object({ packages: z.array(KnowledgePackageStatusSchema) })
})

export type KnowledgePackageStatus = z.infer<typeof KnowledgePackageStatusSchema>
export type KnowledgeStaleReasonValue = z.infer<typeof KnowledgeStaleReasonValueSchema>
export type DigitalEmployeeKnowledgeStatus = z.infer<
  typeof digitalEmployeeKnowledgeStatusRoute.output
>
