import { randomUUID } from 'node:crypto'
import {
  digitalEmployeeListRoute,
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsKeys,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsSetFeatureEnabledRoute,
  digitalEmployeeSettingsTestConnectionRoute,
  type DigitalEmployeeSettingsState,
  type DigitalEmployeeTestMessageCode
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import { DEFAULT_SYNC_INTERVAL_SECONDS } from './knowledgeSyncScheduler'

const TEST_CONNECTION_TIMEOUT_MS = 10_000

export interface DigitalEmployeeSettingsDeps {
  settings: {
    get<TValue = unknown>(key: string, defaultValue?: TValue): TValue | undefined
    set(key: string, value: unknown): void
    /** 回滚时删除「保存前并不存在」的键；未提供则回滚为 undefined。 */
    delete?(key: string): void
  }
  secretStore: {
    isAvailable(): boolean
    get(key: string): string
    getWrapped(key: string): string | undefined
    wrap(value: string): string
    setWrapped(key: string, wrapped: string): void
    restoreWrapped(key: string, wrapped: string | undefined): void
  }
  /** 保存/清除成功后重建 Provider；由 composition 注入，route 层不持有 Provider 实例。 */
  onConfigurationChanged(): void
  fetchImpl?: typeof fetch
  generateExternalUserId?: () => string
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

/**
 * 校验并规范化 Base URL：仅允许 http/https，禁止 userinfo（避免凭据塞进 URL），
 * 去掉末尾斜杠。非法时抛错，调用方转成可识别错误码。
 */
export function normalizeDigitalEmployeeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('digitalEmployee.settings.invalidBaseUrl')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('digitalEmployee.settings.invalidBaseUrl')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('digitalEmployee.settings.invalidBaseUrl')
  }
  if (url.username || url.password) {
    throw new Error('digitalEmployee.settings.invalidBaseUrl')
  }
  return normalizeBaseUrl(trimmed)
}

const readState = (
  deps: DigitalEmployeeSettingsDeps,
  externalUserId: string
): DigitalEmployeeSettingsState => {
  const wrappedKey = deps.secretStore.getWrapped(digitalEmployeeSettingsKeys.apiKey)
  return {
    enabled: deps.settings.get<boolean>(digitalEmployeeSettingsKeys.enabled) === true,
    // 总开关与连接开关同一口径（`=== true`）：未设置过视为关闭，首次使用必须
    // 由用户显式打开。
    featureEnabled: deps.settings.get<boolean>(digitalEmployeeSettingsKeys.featureEnabled) === true,
    baseUrl: deps.settings.get<string>(digitalEmployeeSettingsKeys.baseUrl) ?? '',
    externalUserId,
    apiKeyConfigured: Boolean(wrappedKey),
    // 解不开 ≠ 没配置：wrapped 存在但解密失败（跨加密环境拷来的配置）时，
    // 连接层拿到的是空 key，界面必须把它和「尚未配置」区分开。
    apiKeyUsable:
      Boolean(wrappedKey) && deps.secretStore.get(digitalEmployeeSettingsKeys.apiKey) !== '',
    // `!== false` 与上报侧同一口径：未设置过必须读成「开启」，否则用户一进设置页
    // 看到的默认状态就和实际行为不一致。
    backflowEnabled:
      deps.settings.get<boolean>(digitalEmployeeSettingsKeys.backflowEnabled) !== false,
    // 回传生效值：调度器在缺省/非法时按默认值跑，这里必须说同一个数，否则
    // 设置页会显示成「未设置」，而后台其实一直在同步。
    syncIntervalSeconds: readIntervalSeconds(deps)
  }
}

/**
 * 知识同步间隔的生效值。
 *
 * 与调度器同一口径：缺省、非法、非正数一律回落到 `DEFAULT_SYNC_INTERVAL_SECONDS`。
 * 读同一份规则而不是在这里另写一遍，是为了让「设置页显示的」和「后台实际跑的」
 * 永远是同一个数。
 */
const readIntervalSeconds = (deps: DigitalEmployeeSettingsDeps): number => {
  const raw = deps.settings.get<number>(digitalEmployeeSettingsKeys.syncIntervalSeconds)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SYNC_INTERVAL_SECONDS
  }
  return Math.floor(raw)
}

/**
 * External User ID 首次为空时生成并持久化；生成必须幂等，不能每次 get 覆盖。
 */
const ensureExternalUserId = (deps: DigitalEmployeeSettingsDeps): string => {
  const existing = deps.settings.get<string>(digitalEmployeeSettingsKeys.externalUserId)?.trim()
  if (existing) return existing
  const generated = (deps.generateExternalUserId ?? randomUUID)()
  deps.settings.set(digitalEmployeeSettingsKeys.externalUserId, generated)
  return generated
}

const mapTestFailure = (status: number): DigitalEmployeeTestMessageCode => {
  if (status === 401 || status === 403) return 'unauthorized'
  return 'httpError'
}

/**
 * 探一次 MCP 端点，只为回答「这个 key 有没有 `mcp:invoke`」。
 *
 * 用 `GET /api/v1/mcp/agents/{id}` 而不是 POST：服务端对 GET 只做 scope 校验
 * 然后返回 405（`mcp.py:191-204`，streamable HTTP 没有服务端推送的那一半）。
 * 405 恰好是「鉴权通过」的证明，不建会话、不调用任何工具，比发一个真实的
 * `initialize` 便宜且安全。
 *
 * 路径里的员工 id 用固定占位值即可：那个处理器接收 `agent_id` 却从不读取，
 * 校验通过后无条件 405，与该员工是否存在无关。所以只有两种结论——
 * 401/403 是缺 scope，其余（含 405）都是不缺。
 */
const probeMcpScope = async (
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string
): Promise<DigitalEmployeeTestMessageCode | null> => {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/mcp/agents/deepchat-scope-probe`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS)
    })
  } catch {
    // 列表刚成功、MCP 端点却连不上：网络抖动或反代规则不同。不把这当成权限
    // 问题——把网络故障报成「缺权限」会让人去改根本不需要改的东西。
    return null
  }

  return response.status === 401 || response.status === 403 ? 'missingMcpScope' : null
}

type SettingsSnapshot = Map<string, { present: boolean; value: unknown }>

const captureSnapshot = (deps: DigitalEmployeeSettingsDeps, keys: string[]): SettingsSnapshot => {
  const snapshot: SettingsSnapshot = new Map()
  for (const key of keys) {
    const value = deps.settings.get(key)
    snapshot.set(key, { present: value !== undefined, value })
  }
  return snapshot
}

const restoreSnapshot = (deps: DigitalEmployeeSettingsDeps, snapshot: SettingsSnapshot): void => {
  for (const [key, entry] of snapshot) {
    if (entry.present) {
      deps.settings.set(key, entry.value)
      continue
    }
    // 保存前该键不存在：回滚必须删掉，否则会残留「已启用」这类默认值缺失的状态。
    if (deps.settings.delete) {
      deps.settings.delete(key)
    } else {
      deps.settings.set(key, undefined)
    }
  }
}

export function createDigitalEmployeeSettingsRoutes(
  deps: DigitalEmployeeSettingsDeps
): DeepchatRouteMap {
  const fetchImpl = deps.fetchImpl ?? fetch

  return createRouteMap([
    [
      digitalEmployeeSettingsGetRoute.name,
      async () => {
        return digitalEmployeeSettingsGetRoute.output.parse(
          readState(deps, ensureExternalUserId(deps))
        )
      }
    ],
    [
      digitalEmployeeSettingsSaveRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeSettingsSaveRoute.input.parse(rawInput)
        const baseUrl = normalizeDigitalEmployeeBaseUrl(input.baseUrl)
        const externalUserId = input.externalUserId.trim()
        if (!externalUserId) {
          throw new Error('digitalEmployee.settings.invalidExternalUserId')
        }
        const apiKey = input.apiKey?.trim() ?? ''

        // 先完成全部校验与加密，再写 store；任一步失败都不留下半更新。
        const wrappedKey = apiKey ? deps.secretStore.wrap(apiKey) : null

        // 保存前快照，失败时连同密钥一起恢复，避免「已启用 + 新地址」的半更新配置在下次启动生效。
        const snapshot = captureSnapshot(deps, [
          digitalEmployeeSettingsKeys.enabled,
          digitalEmployeeSettingsKeys.baseUrl,
          digitalEmployeeSettingsKeys.externalUserId,
          digitalEmployeeSettingsKeys.backflowEnabled,
          digitalEmployeeSettingsKeys.syncIntervalSeconds
        ])
        const previousWrappedKey = deps.secretStore.getWrapped(digitalEmployeeSettingsKeys.apiKey)

        try {
          deps.settings.set(digitalEmployeeSettingsKeys.enabled, input.enabled)
          deps.settings.set(digitalEmployeeSettingsKeys.baseUrl, baseUrl)
          deps.settings.set(digitalEmployeeSettingsKeys.externalUserId, externalUserId)
          // 只有显式带了这个字段才写：省略的是「保留」，不是「改回开启」，
          // 否则旧版 renderer 一保存就会把用户关掉的回流悄悄打开。
          if (input.backflowEnabled !== undefined) {
            deps.settings.set(digitalEmployeeSettingsKeys.backflowEnabled, input.backflowEnabled)
          }
          // 与 backflowEnabled 同理：省略是「保留」，不是「改回默认」。
          if (input.syncIntervalSeconds !== undefined) {
            deps.settings.set(
              digitalEmployeeSettingsKeys.syncIntervalSeconds,
              input.syncIntervalSeconds
            )
          }
          if (wrappedKey) {
            deps.secretStore.setWrapped(digitalEmployeeSettingsKeys.apiKey, wrappedKey)
          }
        } catch (error) {
          // 回滚普通设置与密钥，使整次保存要么全生效、要么全不生效。
          restoreSnapshot(deps, snapshot)
          if (wrappedKey) {
            deps.secretStore.restoreWrapped(digitalEmployeeSettingsKeys.apiKey, previousWrappedKey)
          }
          throw error
        }

        deps.onConfigurationChanged()
        return digitalEmployeeSettingsSaveRoute.output.parse(readState(deps, externalUserId))
      }
    ],
    [
      digitalEmployeeSettingsSetFeatureEnabledRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeSettingsSetFeatureEnabledRoute.input.parse(rawInput)
        deps.settings.set(digitalEmployeeSettingsKeys.featureEnabled, input.enabled)
        // 复用既有广播：主窗口据此刷新侧边栏入口；副作用（Provider 重建等）
        // 对纯 UI 开关无害，只是多一次幂等重建。
        deps.onConfigurationChanged()
        return digitalEmployeeSettingsSetFeatureEnabledRoute.output.parse({
          featureEnabled: input.enabled
        })
      }
    ],
    [
      digitalEmployeeSettingsTestConnectionRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeSettingsTestConnectionRoute.input.parse(rawInput)

        const savedBaseUrl = deps.settings.get<string>(digitalEmployeeSettingsKeys.baseUrl) ?? ''
        const externalUserId = (
          input.externalUserId?.trim() ||
          deps.settings.get<string>(digitalEmployeeSettingsKeys.externalUserId) ||
          ''
        ).trim()

        let baseUrl: string
        try {
          baseUrl = normalizeDigitalEmployeeBaseUrl(input.baseUrl?.trim() || savedBaseUrl)
        } catch {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: 'missingConfig'
          })
        }

        // 草稿 key 优先；否则取已保存的 wrapped 值在 main 内解密，绝不回传 renderer。
        const apiKey =
          input.apiKey?.trim() || deps.secretStore.get(digitalEmployeeSettingsKeys.apiKey)
        if (!apiKey || !externalUserId) {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: 'missingConfig'
          })
        }

        let response: Response
        try {
          response = await fetchImpl(`${baseUrl}/api/v1/digital-employees`, {
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS)
          })
        } catch {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: 'networkError'
          })
        }

        if (!response.ok) {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: mapTestFailure(response.status)
          })
        }

        try {
          const body = (await response.json()) as Record<string, unknown>
          digitalEmployeeListRoute.output.parse({
            ...body,
            employees: body.employees,
            fetchedAt:
              typeof body.fetchedAt === 'string' && body.fetchedAt
                ? body.fetchedAt
                : new Date().toISOString()
          })
        } catch {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: 'invalidPayload'
          })
        }

        // 测试连接只验证可用性：不写 ETag、不替换当前 Provider、不改启用状态。
        //
        // 列表通了不等于能用：`mcp:invoke` 是独立 scope，缺它时列表照常返回，
        // 但 `staffdeck_*` 工具一个都不会出现。不在这里报出来，这个故障只会
        // 在用户开口问第一句时以「这个员工没有工具」的形式暴露。
        const mcpScopeFailure = await probeMcpScope(fetchImpl, baseUrl, apiKey)
        if (mcpScopeFailure) {
          return digitalEmployeeSettingsTestConnectionRoute.output.parse({
            ok: false,
            messageCode: mcpScopeFailure
          })
        }

        return digitalEmployeeSettingsTestConnectionRoute.output.parse({
          ok: true,
          messageCode: 'ok'
        })
      }
    ],
    [
      digitalEmployeeSettingsClearApiKeyRoute.name,
      async () => {
        deps.secretStore.restoreWrapped(digitalEmployeeSettingsKeys.apiKey, undefined)
        deps.onConfigurationChanged()
        return digitalEmployeeSettingsClearApiKeyRoute.output.parse({ apiKeyConfigured: false })
      }
    ]
  ])
}
