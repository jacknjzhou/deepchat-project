import { z } from 'zod'
import { defineRouteContract } from '../common'

/**
 * 员工本地执行前的准备工作（D4）契约。
 *
 * 只暴露 renderer 需要决策的字段：主进程内部还有失败原因码、注册器返回值等，
 * 那些进契约就会变成事实上的公共 API，改一次实现就要动一次 renderer。
 *
 * 语义：**这个调用永远不表示「对话不能开始」**。所有失败都在结果里表达，
 * renderer 拿到之后照常建会话，只是能力少一点。
 */

export const PROVISIONING_SKIP_REASONS = [
  /** 员工在服务端执行：本地不需要工具与技能 */
  'NOT_LOCAL',
  /** Provider 已降级到 mock，员工 id 与技能包都是假数据 */
  'DEGRADED',
  /** 分发列表里已找不到这个员工 */
  'NOT_FOUND'
] as const

export const ProvisioningSkipReasonSchema = z.enum(PROVISIONING_SKIP_REASONS)
export type ProvisioningSkipReasonValue = z.infer<typeof ProvisioningSkipReasonSchema>

/** 准备失败的链路名；UI 据此提示「工具或技能可能不完整」。 */
export const PROVISIONING_CHAINS = ['mcp', 'skills', 'knowledgeTool'] as const
export const ProvisioningChainSchema = z.enum(PROVISIONING_CHAINS)
export type ProvisioningChainValue = z.infer<typeof ProvisioningChainSchema>

/**
 * 云端工具注册失败的具体原因。`NOT_CONFIGURED` 指向设置缺失（去配置），
 * `START_FAILED` 指向服务不可达（查地址/网络）——两者的处置完全不同，
 * 所以随 provision 输出透传，供降级提示给出可操作文案。
 */
export const StaffdeckMcpRegisterReasonSchema = z.enum([
  'NOT_CONFIGURED',
  'NO_TOOLS',
  'START_FAILED',
  'REGISTER_FAILED'
])
export type StaffdeckMcpRegisterReasonValue = z.infer<typeof StaffdeckMcpRegisterReasonSchema>

export const digitalEmployeeProvisionRoute = defineRouteContract({
  name: 'digitalEmployee.provision',
  input: z.object({ employeeId: z.string().min(1).max(64) }).strict(),
  output: z.object({
    employeeId: z.string().min(1),
    /** `null` 表示已尝试准备；非空表示整轮跳过。 */
    skipped: ProvisioningSkipReasonSchema.nullable().default(null),
    /** 远端 MCP server 是否已注册并可连接。 */
    toolsReady: z.boolean().default(false),
    /**
     * 云端工具未就绪时的具体原因；就绪或整轮跳过时为 `null`。
     * `NO_TOOLS` 表示员工本就没有云端工具——那不是降级，UI 不该告警。
     */
    toolsReason: StaffdeckMcpRegisterReasonSchema.nullable().default(null),
    /** 本地知识检索工具（会话内可主动查知识库）是否已注册并启动。 */
    knowledgeToolReady: z.boolean().default(false),
    /** 本轮新装/更新的技能数。 */
    installedSkills: z.number().int().nonnegative().default(0),
    /** 下载或安装失败的技能 slug；下轮会自动重试，UI 只做提示。 */
    failedSkills: z.array(z.string()).default([]),
    /**
     * slug → 简短失败原因（HTTP 状态码、安装器报错等），随降级 toast 一并展示。
     *
     * 排障时「装不上」和「连不上」的处置完全不同（查服务端 vs 换密钥），
     * 只报个数的 toast 会让人把密钥损坏当成服务端故障去查。
     */
    failureReasons: z.record(z.string(), z.string()).default({}),
    /**
     * 技能在本地装成的名字（带员工前缀），会话的 `activeSkills` 要用这些。
     *
     * 不是 payload 里的 slug：安装时名字被加了作用域前缀，用 slug 去激活
     * 会安静地匹配不到任何技能。
     */
    skillNames: z.array(z.string()).default([]),
    /** 抛错的链路。空数组表示没有异常路径。 */
    failures: z.array(ProvisioningChainSchema).default([])
  })
})

export type DigitalEmployeeProvisionResult = z.infer<typeof digitalEmployeeProvisionRoute.output>
