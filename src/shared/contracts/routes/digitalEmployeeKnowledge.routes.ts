import { z } from 'zod'
import { EntityIdSchema } from '../common'
import { defineRouteContract } from '../common'

/**
 * 数字员工本地知识同步的状态查询契约。
 *
 * `knowledgeStatus` 只暴露 UI 真正要渲染的字段，刻意不含 `localKnowledgeBaseId`、
 * 概念 hash 表、本地文件路径——那些是存储实现细节，一旦进契约就变成事实上的
 * 公共 API。
 *
 * 但会话检索**必须**知道本地库 id（远端 `kb_*` 在本地库里不存在），所以另开
 * 一条 `knowledgeLocalBase` 单值查询：窄接口、单一用途、与展示字段解耦。
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
  conceptCount: z.number().int().nonnegative(),
  /**
   * 远端目录端点（`GET .../knowledge-bases`）带来的展示信息。目录端点未上线
   * 或未拉到时缺省，UI 退回用 `knowledgeBaseId` 渲染标题——缺省是常态而非
   * 异常，所以全部 optional 而不是 nullable。
   */
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  documentCount: z.number().int().nonnegative().optional(),
  chunkCount: z.number().int().nonnegative().optional()
})

export const digitalEmployeeKnowledgeStatusRoute = defineRouteContract({
  name: 'digitalEmployee.knowledgeStatus',
  input: z.object({ employeeId: EntityIdSchema }).strict(),
  output: z.object({ packages: z.array(KnowledgePackageStatusSchema) })
})

/**
 * 「这个员工的本地知识库是哪个」——单独开一条路由，而不是塞进状态查询。
 *
 * 两个理由：
 * 1. **粒度不同**。状态是 `per 远端 KB` 的列表，本地库 id 是员工级的单值；
 *    混进 `packages[]` 就得在每条记录上重复同一个值，或者变成「列表为空时
 *    连 id 都没处放」——而列表为空恰恰是最需要它的场景（未开始同步）。
 * 2. **用途不同**。状态供 UI 渲染「知识可能过期」；这条只给会话建立前做一次
 *    检索寻址。前者是展示数据，后者是流程参数，混在一起会让「改展示字段」
 *    变成「改检索行为」。
 *
 * `null` 表示本机还没有该员工的本地库（未同步 / 用户删了 / 无嵌入模型），
 * 调用方应直接跳过检索——用远端 `kb_*` id 去查本地库必然抛错。
 */
export const digitalEmployeeKnowledgeLocalBaseRoute = defineRouteContract({
  name: 'digitalEmployee.knowledgeLocalBase',
  input: z.object({ employeeId: EntityIdSchema }).strict(),
  output: z.object({ knowledgeBaseId: z.string().min(1).nullable() })
})

export type KnowledgePackageStatus = z.infer<typeof KnowledgePackageStatusSchema>
export type KnowledgeStaleReasonValue = z.infer<typeof KnowledgeStaleReasonValueSchema>
export type DigitalEmployeeKnowledgeStatus = z.infer<
  typeof digitalEmployeeKnowledgeStatusRoute.output
>
export type DigitalEmployeeKnowledgeLocalBase = z.infer<
  typeof digitalEmployeeKnowledgeLocalBaseRoute.output
>
