import { randomUUID } from 'node:crypto'
import {
  digitalEmployeeListRoute,
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsKeys,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsTestConnectionRoute,
  type DigitalEmployeeSettingsState,
  type DigitalEmployeeTestMessageCode
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import { EXTERNAL_USER_ID_HEADER } from './provider'

const TEST_CONNECTION_TIMEOUT_MS = 10_000

export interface DigitalEmployeeSettingsDeps {
  settings: {
    get<TValue = unknown>(key: string, defaultValue?: TValue): TValue | undefined
    set(key: string, value: unknown): void
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
): DigitalEmployeeSettingsState => ({
  enabled: deps.settings.get<boolean>(digitalEmployeeSettingsKeys.enabled) === true,
  baseUrl: deps.settings.get<string>(digitalEmployeeSettingsKeys.baseUrl) ?? '',
  externalUserId,
  apiKeyConfigured: Boolean(deps.secretStore.getWrapped(digitalEmployeeSettingsKeys.apiKey))
})

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
        const previousWrappedKey = deps.secretStore.getWrapped(digitalEmployeeSettingsKeys.apiKey)

        try {
          deps.settings.set(digitalEmployeeSettingsKeys.enabled, input.enabled)
          deps.settings.set(digitalEmployeeSettingsKeys.baseUrl, baseUrl)
          deps.settings.set(digitalEmployeeSettingsKeys.externalUserId, externalUserId)
          if (wrappedKey) {
            deps.secretStore.setWrapped(digitalEmployeeSettingsKeys.apiKey, wrappedKey)
          }
        } catch (error) {
          // 回滚密钥，避免设置写入失败但密钥已被替换。
          if (wrappedKey) {
            deps.secretStore.restoreWrapped(
              digitalEmployeeSettingsKeys.apiKey,
              previousWrappedKey
            )
          }
          throw error
        }

        deps.onConfigurationChanged()
        return digitalEmployeeSettingsSaveRoute.output.parse(readState(deps, externalUserId))
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
        const apiKey = input.apiKey?.trim() || deps.secretStore.get(digitalEmployeeSettingsKeys.apiKey)
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
              authorization: `Bearer ${apiKey}`,
              [EXTERNAL_USER_ID_HEADER]: externalUserId
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
