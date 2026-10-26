import { z } from 'zod'
import { defineRouteContract } from '../common'

/**
 * StaffDeck 连接配置的专用契约。
 * 注意：API Key 明文永不出现在任何 route 的 output 中，仅以 apiKeyConfigured 表示状态。
 */

export const digitalEmployeeSettingsKeys = {
  enabled: 'digitalEmployee.staffdeckEnabled',
  baseUrl: 'digitalEmployee.staffdeckBaseUrl',
  externalUserId: 'digitalEmployee.externalUserId',
  /** 仅 SecretStore 读写的 wrapped 值键 */
  apiKey: 'digitalEmployee.staffdeckApiKey',
  /** 知识同步的轮询间隔（秒）；缺省/非法值按 3600 处理。 */
  syncIntervalSeconds: 'digitalEmployee.knowledgeSyncIntervalSeconds',
  /**
   * 本地执行的对话是否回流到 StaffDeck 归档。
   *
   * 默认开启（缺省视为 true）：关闭会造成审计盲区，所以「没设置过」不能等于
   * 「不上报」。关闭由用户在设置里显式操作。
   */
  backflowEnabled: 'digitalEmployee.backflowEnabled'
} as const

/** 测试连接结果码：renderer 依此映射本地化文案，不接收原始响应体。 */
export const DIGITAL_EMPLOYEE_TEST_MESSAGE_CODES = [
  'ok',
  'missingConfig',
  'unauthorized',
  'httpError',
  'networkError',
  'invalidPayload',
  /**
   * 列表能读、但 MCP 端点拒绝。结果码必须单列。
   *
   * `agents:read` 与 `mcp:invoke` 是两个独立的 scope：只做一次列表探测时，
   * 一个恰好缺 `mcp:invoke` 的 key 会显示「连接正常」，而对话里一个
   * `staffdeck_*` 工具都没有——用户与运维都会去查服务端，查不到东西。
   */
  'missingMcpScope'
] as const

export const DigitalEmployeeTestMessageCodeSchema = z.enum(DIGITAL_EMPLOYEE_TEST_MESSAGE_CODES)

export const DigitalEmployeeSettingsStateSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
  externalUserId: z.string(),
  apiKeyConfigured: z.boolean(),
  /**
   * 已保存的密钥能否在本机解密。`apiKeyConfigured` 为 true 而它为 false 时，
   * 密文多半来自别的加密环境（跨系统拷贝的配置），在本机永远解不开——
   * 连接会一直静默降级到 mock，只有这里能把「为什么」告诉用户。
   */
  apiKeyUsable: z.boolean(),
  /** 本地执行的对话是否回流归档。缺省视为开启，见 `backflowEnabled` 键的说明。 */
  backflowEnabled: z.boolean(),
  /**
   * 知识同步的轮询间隔（秒）。
   *
   * 回传**生效值**而不是原始配置：用户没设置过时是默认值，回传 `null` 会让
   * 设置页显示成「未设置」，而后台其实按 3600 在跑。
   */
  syncIntervalSeconds: z.number().int().positive()
})

export const digitalEmployeeSettingsGetRoute = defineRouteContract({
  name: 'digitalEmployeeSettings.get',
  input: z.object({}).strict().default({}),
  output: DigitalEmployeeSettingsStateSchema
})

export const digitalEmployeeSettingsSaveRoute = defineRouteContract({
  name: 'digitalEmployeeSettings.save',
  input: z
    .object({
      enabled: z.boolean(),
      baseUrl: z.string().max(2048),
      externalUserId: z.string().max(128),
      /** 空字符串或省略表示保留已存密钥 */
      apiKey: z.string().max(512).optional(),
      /** 省略表示保留当前值：老版本 renderer 不会带这个字段。 */
      backflowEnabled: z.boolean().optional(),
      /**
       * 知识同步间隔（秒）。省略表示保留当前值。
       *
       * 下限 60 秒：更短的间隔不会更实时（同步本身要下载并建索引），只会把
       * 服务端和本地嵌入模型一起打满。
       */
      syncIntervalSeconds: z.number().int().min(60).max(86_400).optional()
    })
    .strict(),
  output: DigitalEmployeeSettingsStateSchema
})

export const digitalEmployeeSettingsTestConnectionRoute = defineRouteContract({
  name: 'digitalEmployeeSettings.testConnection',
  input: z
    .object({
      /** 草稿优先；缺省回落到已保存配置 */
      baseUrl: z.string().max(2048).optional(),
      externalUserId: z.string().max(128).optional(),
      apiKey: z.string().max(512).optional()
    })
    .strict()
    .default({}),
  output: z.object({
    ok: z.boolean(),
    messageCode: DigitalEmployeeTestMessageCodeSchema
  })
})

export const digitalEmployeeSettingsClearApiKeyRoute = defineRouteContract({
  name: 'digitalEmployeeSettings.clearApiKey',
  input: z.object({}).strict().default({}),
  output: z.object({ apiKeyConfigured: z.literal(false) })
})

export type DigitalEmployeeSettingsState = z.infer<typeof DigitalEmployeeSettingsStateSchema>
export type DigitalEmployeeTestMessageCode = z.infer<typeof DigitalEmployeeTestMessageCodeSchema>
