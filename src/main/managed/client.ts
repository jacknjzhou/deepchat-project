import { isNewApiEndpointType, type NewApiEndpointType } from '@shared/model'
import {
  AGENT_MODEL_KEYS,
  ManagedConfigPayloadSchema,
  ManagedProviderSpecSchema,
  clampManagedConcurrency,
  toLocalProviderId,
  type ManagedAgentModelIds,
  type ManagedConfigPayload,
  type ManagedDocumentsConfig,
  type ManagedModelRef,
  type ManagedProvider,
  type SyncResult
} from './types'

export { toLocalProviderId }

export interface ManagedDeviceInfo {
  username: string
  domain: string
  hostname: string
  sid: string
}

export interface FetchManagedConfigOptions {
  endpoint: string
  device: ManagedDeviceInfo
  /** 内置注册表的 apiType 集合（DEFAULT_PROVIDERS.map(p => p.apiType)） */
  knownProviderTypes: readonly string[]
  /** apiType → 内置 provider id 的映射，用于写入 baseProviderId */
  builtinIdByApiType: Record<string, string>
  clientVersion?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 8000

function buildUrl(endpoint: string, device: ManagedDeviceInfo): string {
  const url = new URL(endpoint)
  url.searchParams.set('username', device.username)
  url.searchParams.set('domain', device.domain)
  url.searchParams.set('hostname', device.hostname)
  url.searchParams.set('sid', device.sid)
  return url.toString()
}

function normalizeModelRef(
  raw: unknown,
  localIdByKey: Map<string, string>,
  warnings: string[]
): ManagedModelRef | null {
  if (!raw || typeof raw !== 'object') return null
  const ref = raw as { providerKey?: unknown; modelId?: unknown; endpointType?: unknown }
  if (typeof ref.providerKey !== 'string' || typeof ref.modelId !== 'string') return null

  const providerId = localIdByKey.get(ref.providerKey)
  if (!providerId) {
    warnings.push(`model ref references unknown providerKey: ${ref.providerKey}`)
    return null
  }

  let endpointType: NewApiEndpointType | undefined
  if (ref.endpointType !== undefined) {
    if (isNewApiEndpointType(ref.endpointType)) {
      endpointType = ref.endpointType
    } else {
      warnings.push(`invalid endpointType dropped: ${String(ref.endpointType)}`)
    }
  }

  return {
    providerId,
    modelId: ref.modelId,
    ...(endpointType ? { endpointType } : {})
  }
}

function normalizeDocuments(
  raw: Record<string, unknown> | null | undefined,
  localIdByKey: Map<string, string>,
  warnings: string[]
): ManagedDocumentsConfig | null {
  if (!raw) return null
  return {
    textModel: normalizeModelRef(raw.textModel, localIdByKey, warnings),
    visionModel: normalizeModelRef(raw.visionModel, localIdByKey, warnings),
    concurrency: clampManagedConcurrency(raw.concurrency as number | null | undefined),
    temperature: typeof raw.temperature === 'number' ? raw.temperature : null,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : null
  }
}

function resolveAnchorProviderId(
  defaultProviderKey: string | undefined,
  localIdByKey: Map<string, string>,
  warnings: string[]
): string | null {
  if (defaultProviderKey) {
    const byKey = localIdByKey.get(defaultProviderKey)
    if (byKey) return byKey
    warnings.push(
      `defaultProviderKey not found, falling back to first provider: ${defaultProviderKey}`
    )
  }
  const first = localIdByKey.values().next()
  return first.done ? null : first.value
}

/** 只保留非空模型 id；归属 provider 由应用阶段的模型列表匹配决定 */
function normalizeAgentModelIds(
  raw: Record<string, unknown> | null | undefined
): ManagedAgentModelIds | null {
  if (!raw) return null
  const result: ManagedAgentModelIds = {}
  let hasAny = false
  for (const key of AGENT_MODEL_KEYS) {
    const modelId = raw[key]
    if (typeof modelId === 'string' && modelId.length > 0) {
      result[key] = modelId
      hasAny = true
    }
  }
  return hasAny ? result : null
}

export async function fetchManagedConfig(options: FetchManagedConfigOptions): Promise<SyncResult> {
  const { endpoint, device, clientVersion, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const warnings: string[] = []

  if (!endpoint) {
    return { status: 'skipped', config: null, warnings }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(buildUrl(endpoint, device), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-DeepChat-Client': clientVersion ?? 'unknown',
        'X-DeepChat-Device-Id': device.sid
      },
      signal: controller.signal
    })

    if (response.status === 204 || response.status === 404) {
      return { status: 'absent', config: null, warnings }
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'denied', config: null, warnings }
    }
    if (!response.ok) {
      return { status: 'unavailable', config: null, warnings }
    }

    const json = (await response.json()) as unknown
    const parsed = ManagedConfigPayloadSchema.safeParse(json)
    if (!parsed.success) {
      return { status: 'unavailable', config: null, warnings: ['invalid payload shape'] }
    }

    const knownTypes = new Set(options.knownProviderTypes)
    const providers: ManagedProvider[] = []
    const localIdByKey = new Map<string, string>()

    for (const item of parsed.data.providers) {
      const spec = ManagedProviderSpecSchema.safeParse(item)
      if (!spec.success) {
        warnings.push('provider spec dropped: invalid shape')
        continue
      }
      const provider = spec.data
      if (!knownTypes.has(provider.apiType)) {
        warnings.push(`unknown apiType skipped: ${provider.apiType}`)
        continue
      }
      const id = toLocalProviderId(provider.key)
      localIdByKey.set(provider.key, id)
      providers.push({
        id,
        key: provider.key,
        name: provider.name,
        apiType: provider.apiType,
        baseProviderId: options.builtinIdByApiType[provider.apiType] ?? null,
        instanceLabel: provider.instanceLabel ?? provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        enabled: provider.enabled ?? true
      })
    }

    const config: ManagedConfigPayload = {
      version: parsed.data.version,
      providers,
      defaultProviderId: resolveAnchorProviderId(
        parsed.data.defaultProviderKey,
        localIdByKey,
        warnings
      ),
      agentModels: normalizeAgentModelIds(
        (parsed.data.agentModels ?? null) as Record<string, unknown> | null
      ),
      documents: normalizeDocuments(
        (parsed.data.documents ?? null) as Record<string, unknown> | null,
        localIdByKey,
        warnings
      )
    }

    return { status: 'applied', config, warnings }
  } catch {
    return { status: 'unavailable', config: null, warnings }
  } finally {
    clearTimeout(timer)
  }
}
