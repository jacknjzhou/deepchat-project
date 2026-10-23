import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDigitalEmployeeSettingsRoutes,
  normalizeDigitalEmployeeBaseUrl
} from '../../../src/main/digital-employee/settingsRoutes'
import {
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsTestConnectionRoute
} from '../../../src/shared/contracts/routes/digitalEmployeeSettings.routes'

const makeEmployee = (): Record<string, unknown> => ({
  id: 'emp-finance',
  name: '财务',
  role: '财务',
  description: '报销管家',
  avatar: null,
  capabilities: ['报销'],
  greeting: null,
  systemPrompt: '#角色：报销管家',
  sops: [],
  knowledgeBaseIds: [],
  skillIds: [],
  tools: [],
  enabled: true,
  updatedAt: '2026-10-22T00:00:00Z',
  executionMode: 'local'
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

interface Harness {
  handlers: {
    get(input?: unknown): Promise<unknown>
    save(input: unknown): Promise<unknown>
    testConnection(input?: unknown): Promise<unknown>
    clearApiKey(input?: unknown): Promise<unknown>
  }
  settingsStore: Map<string, unknown>
  settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }
  secretStore: {
    isAvailable: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    getWrapped: ReturnType<typeof vi.fn>
    wrap: ReturnType<typeof vi.fn>
    setWrapped: ReturnType<typeof vi.fn>
    restoreWrapped: ReturnType<typeof vi.fn>
  }
  onConfigurationChanged: ReturnType<typeof vi.fn>
  fetchImpl: ReturnType<typeof vi.fn>
}

const createHarness = (
  options: {
    initialSettings?: Record<string, unknown>
    initialWrappedKey?: string
    plaintextKey?: string
    safeStorageAvailable?: boolean
    fetchImpl?: ReturnType<typeof vi.fn>
  } = {}
): Harness => {
  const settingsStore = new Map<string, unknown>(Object.entries(options.initialSettings ?? {}))
  const wrapped = new Map<string, string>()
  if (options.initialWrappedKey) {
    wrapped.set('digitalEmployee.staffdeckApiKey', options.initialWrappedKey)
  }
  const safeStorageAvailable = options.safeStorageAvailable ?? true

  const settings = {
    get: vi.fn((key: string, defaultValue?: unknown) =>
      settingsStore.has(key) ? settingsStore.get(key) : defaultValue
    ),
    set: vi.fn((key: string, value: unknown) => {
      settingsStore.set(key, value)
    }),
    delete: vi.fn((key: string) => {
      settingsStore.delete(key)
    })
  }

  const secretStore = {
    isAvailable: vi.fn(() => safeStorageAvailable),
    get: vi.fn(() => options.plaintextKey ?? ''),
    getWrapped: vi.fn((key: string) => wrapped.get(key)),
    wrap: vi.fn((value: string) => {
      if (!safeStorageAvailable) {
        throw new Error('sync.error.safeStorageUnavailable')
      }
      return `wrapped:${value}`
    }),
    setWrapped: vi.fn((key: string, value: string) => {
      wrapped.set(key, value)
    }),
    restoreWrapped: vi.fn((key: string, value: string | undefined) => {
      if (value === undefined) {
        wrapped.delete(key)
        return
      }
      wrapped.set(key, value)
    })
  }

  const onConfigurationChanged = vi.fn()
  const fetchImpl = options.fetchImpl ?? vi.fn()

  const routes = createDigitalEmployeeSettingsRoutes({
    settings,
    secretStore,
    onConfigurationChanged,
    fetchImpl,
    generateExternalUserId: () => 'generated-user-id'
  })

  return {
    handlers: {
      get: (input) => routes.get(digitalEmployeeSettingsGetRoute.name)!(input ?? {}),
      save: (input) => routes.get(digitalEmployeeSettingsSaveRoute.name)!(input),
      testConnection: (input) =>
        routes.get(digitalEmployeeSettingsTestConnectionRoute.name)!(input ?? {}),
      clearApiKey: (input) => routes.get(digitalEmployeeSettingsClearApiKeyRoute.name)!(input ?? {})
    },
    settingsStore,
    settings,
    secretStore,
    onConfigurationChanged,
    fetchImpl
  }
}

describe('normalizeDigitalEmployeeBaseUrl', () => {
  it('trims whitespace and removes trailing slashes', () => {
    expect(normalizeDigitalEmployeeBaseUrl('  https://sd.example///  ')).toBe('https://sd.example')
  })

  it.each(['ftp://sd.example', 'sd.example', 'https://user:pass@sd.example', ''])(
    'rejects invalid base url %s',
    (value) => {
      expect(() => normalizeDigitalEmployeeBaseUrl(value)).toThrow()
    }
  )
})

describe('digitalEmployeeSettings routes', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness({
      initialSettings: { 'digitalEmployee.externalUserId': 'user-1' },
      initialWrappedKey: 'wrapped:sd_live_secret',
      plaintextKey: 'sd_live_secret'
    })
  })

  it('does not expose the API key in get output', async () => {
    const result = (await harness.handlers.get()) as Record<string, unknown>

    expect(result).toEqual({
      enabled: false,
      baseUrl: '',
      externalUserId: 'user-1',
      apiKeyConfigured: true,
      backflowEnabled: true
    })
    expect(JSON.stringify(result)).not.toContain('sd_live_secret')
    expect(JSON.stringify(result)).not.toContain('wrapped:')
  })

  it('generates and persists an external user id only once', async () => {
    const fresh = createHarness()
    expect(((await fresh.handlers.get()) as { externalUserId: string }).externalUserId).toBe(
      'generated-user-id'
    )
    expect(fresh.settings.set).toHaveBeenCalledTimes(1)

    await fresh.handlers.get()
    await fresh.handlers.get()
    // 幂等：后续 get 不得重复生成或覆盖
    expect(fresh.settings.set).toHaveBeenCalledTimes(1)
  })

  it('preserves the stored key when save omits apiKey and normalizes the URL', async () => {
    const result = (await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example///',
      externalUserId: ' user-1 '
    })) as Record<string, unknown>

    expect(harness.secretStore.setWrapped).not.toHaveBeenCalled()
    expect(harness.settings.set).toHaveBeenCalledWith(
      'digitalEmployee.staffdeckBaseUrl',
      'https://sd.example'
    )
    expect(harness.settings.set).toHaveBeenCalledWith('digitalEmployee.externalUserId', 'user-1')
    expect(harness.onConfigurationChanged).toHaveBeenCalledTimes(1)
    expect(result.apiKeyConfigured).toBe(true)
  })

  it('treats an empty apiKey as keep-existing', async () => {
    await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1',
      apiKey: '   '
    })
    expect(harness.secretStore.setWrapped).not.toHaveBeenCalled()
  })

  it('reports backflow as on when the key was never set', async () => {
    // Unset must read as "report": the reporting side uses the same rule, and a
    // settings page that showed "off" while reporting stayed on would be lying.
    const result = (await harness.handlers.get()) as { backflowEnabled: boolean }

    expect(result.backflowEnabled).toBe(true)
  })

  it('persists backflow when the switch is turned off', async () => {
    const result = (await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1',
      backflowEnabled: false
    })) as { backflowEnabled: boolean }

    expect(harness.settings.set).toHaveBeenCalledWith('digitalEmployee.backflowEnabled', false)
    expect(result.backflowEnabled).toBe(false)
  })

  it('leaves backflow untouched when the caller omits it', async () => {
    // An older renderer saving the form must not silently re-enable reporting.
    harness.settingsStore.set('digitalEmployee.backflowEnabled', false)

    const result = (await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1'
    })) as { backflowEnabled: boolean }

    expect(harness.settings.set).not.toHaveBeenCalledWith(
      'digitalEmployee.backflowEnabled',
      expect.anything()
    )
    expect(result.backflowEnabled).toBe(false)
  })

  it('wraps a new key before persisting it', async () => {
    await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1',
      apiKey: ' sd_live_new '
    })

    expect(harness.secretStore.wrap).toHaveBeenCalledWith('sd_live_new')
    expect(harness.secretStore.setWrapped).toHaveBeenCalledWith(
      'digitalEmployee.staffdeckApiKey',
      'wrapped:sd_live_new'
    )
  })

  it.each(['ftp://sd.example', 'https://user:pass@sd.example', 'not-a-url'])(
    'rejects invalid base url %s without writing settings',
    async (baseUrl) => {
      await expect(
        harness.handlers.save({ enabled: true, baseUrl, externalUserId: 'user-1' })
      ).rejects.toThrow()
      expect(harness.settings.set).not.toHaveBeenCalled()
      expect(harness.onConfigurationChanged).not.toHaveBeenCalled()
    }
  )

  it('rejects a blank external user id', async () => {
    await expect(
      harness.handlers.save({
        enabled: true,
        baseUrl: 'https://sd.example',
        externalUserId: '   '
      })
    ).rejects.toThrow()
    expect(harness.settings.set).not.toHaveBeenCalled()
  })

  it('refuses to save when safeStorage is unavailable (no plaintext fallback)', async () => {
    const blocked = createHarness({
      initialSettings: { 'digitalEmployee.externalUserId': 'user-1' },
      safeStorageAvailable: false
    })

    await expect(
      blocked.handlers.save({
        enabled: true,
        baseUrl: 'https://sd.example',
        externalUserId: 'user-1',
        apiKey: 'sd_live_secret'
      })
    ).rejects.toThrow()

    // 校验/加密在写入之前完成，因此普通设置不应被部分写入。
    expect(blocked.settings.set).not.toHaveBeenCalled()
    expect(blocked.onConfigurationChanged).not.toHaveBeenCalled()
  })

  it('restores the previous wrapped key when settings persistence fails', async () => {
    let writes = 0
    harness.settings.set.mockImplementation((key: string, value: unknown) => {
      writes += 1
      // 让 baseUrl 写入成功、externalUserId 写入失败，触发回滚路径
      if (writes === 2) throw new Error('disk full')
      harness.settingsStore.set(key, value)
    })

    await expect(
      harness.handlers.save({
        enabled: true,
        baseUrl: 'https://sd.example',
        externalUserId: 'user-2',
        apiKey: 'sd_live_new'
      })
    ).rejects.toThrow('disk full')

    expect(harness.secretStore.restoreWrapped).toHaveBeenCalledWith(
      'digitalEmployee.staffdeckApiKey',
      'wrapped:sd_live_secret'
    )
    expect(harness.onConfigurationChanged).not.toHaveBeenCalled()
  })

  it('rolls back ordinary settings when a later write fails mid-save', async () => {
    let writes = 0
    harness.settings.set.mockImplementation((key: string, value: unknown) => {
      writes += 1
      // enabled 与 baseUrl 先写入成功，externalUserId 写入失败
      if (writes === 3) throw new Error('disk full')
      harness.settingsStore.set(key, value)
    })

    await expect(
      harness.handlers.save({
        enabled: true,
        baseUrl: 'https://sd.example',
        externalUserId: 'user-2',
        apiKey: 'sd_live_new'
      })
    ).rejects.toThrow('disk full')

    // 半更新会让下次启动用「已启用 + 新地址」去连一个并未保存成功的配置。
    expect(harness.settingsStore.has('digitalEmployee.staffdeckEnabled')).toBe(false)
    expect(harness.settingsStore.has('digitalEmployee.staffdeckBaseUrl')).toBe(false)
    expect(harness.onConfigurationChanged).not.toHaveBeenCalled()
  })

  it('restores previous ordinary settings values when an update fails mid-save', async () => {
    harness.settingsStore.set('digitalEmployee.staffdeckEnabled', false)
    harness.settingsStore.set('digitalEmployee.staffdeckBaseUrl', 'https://old.example')
    let writes = 0
    harness.settings.set.mockImplementation((key: string, value: unknown) => {
      writes += 1
      if (writes === 3) throw new Error('disk full')
      harness.settingsStore.set(key, value)
    })

    await expect(
      harness.handlers.save({
        enabled: true,
        baseUrl: 'https://new.example',
        externalUserId: 'user-2'
      })
    ).rejects.toThrow('disk full')

    expect(harness.settingsStore.get('digitalEmployee.staffdeckEnabled')).toBe(false)
    expect(harness.settingsStore.get('digitalEmployee.staffdeckBaseUrl')).toBe(
      'https://old.example'
    )
  })

  it('clears the stored key and reports it as not configured', async () => {
    const result = await harness.handlers.clearApiKey()

    expect(harness.secretStore.restoreWrapped).toHaveBeenCalledWith(
      'digitalEmployee.staffdeckApiKey',
      undefined
    )
    expect(result).toEqual({ apiKeyConfigured: false })
    expect(harness.onConfigurationChanged).toHaveBeenCalledTimes(1)
  })
})

describe('digitalEmployeeSettings.testConnection', () => {
  const baseSettings = {
    'digitalEmployee.staffdeckBaseUrl': 'https://sd.example',
    'digitalEmployee.externalUserId': 'user-1'
  }

  it('returns ok for a 200 with a valid employees payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl
    })

    const result = await harness.handlers.testConnection()

    expect(result).toEqual({ ok: true, messageCode: 'ok' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sd.example/api/v1/digital-employees')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sd_live_k')
    expect(headers['x-external-user-id']).toBe('user-1')
    // 测试连接不得替换当前 Provider 或改动内存配置
    expect(harness.secretStore.setWrapped).not.toHaveBeenCalled()
    expect(harness.onConfigurationChanged).not.toHaveBeenCalled()
  })

  it('prefers the draft config over the saved config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_saved',
      fetchImpl
    })

    await harness.handlers.testConnection({
      baseUrl: 'https://draft.example',
      externalUserId: 'draft-user',
      apiKey: 'sd_live_draft'
    })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://draft.example/api/v1/digital-employees')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sd_live_draft')
    expect(headers['x-external-user-id']).toBe('draft-user')
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'httpError']
  ])('maps HTTP %s to %s', async (status, code) => {
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status }))
    })

    expect(await harness.handlers.testConnection()).toEqual({ ok: false, messageCode: code })
  })

  it('maps network failures to networkError', async () => {
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    })

    expect(await harness.handlers.testConnection()).toEqual({
      ok: false,
      messageCode: 'networkError'
    })
  })

  it('maps schema-invalid payloads to invalidPayload', async () => {
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { employees: [{ id: '' }] }))
    })

    expect(await harness.handlers.testConnection()).toEqual({
      ok: false,
      messageCode: 'invalidPayload'
    })
  })

  it('maps non-json payloads to invalidPayload', async () => {
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl: vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }))
    })

    expect(await harness.handlers.testConnection()).toEqual({
      ok: false,
      messageCode: 'invalidPayload'
    })
  })

  it('reports missingConfig when no key or user id is available', async () => {
    const harness = createHarness({
      initialSettings: { 'digitalEmployee.staffdeckBaseUrl': 'https://sd.example' },
      fetchImpl: vi.fn()
    })

    expect(await harness.handlers.testConnection()).toEqual({
      ok: false,
      messageCode: 'missingConfig'
    })
    expect(harness.fetchImpl).not.toHaveBeenCalled()
  })

  it('reports missingConfig for an invalid draft url without any request', async () => {
    const harness = createHarness({
      initialSettings: baseSettings,
      initialWrappedKey: 'wrapped:k',
      plaintextKey: 'sd_live_k',
      fetchImpl: vi.fn()
    })

    expect(await harness.handlers.testConnection({ baseUrl: 'ftp://nope' })).toEqual({
      ok: false,
      messageCode: 'missingConfig'
    })
    expect(harness.fetchImpl).not.toHaveBeenCalled()
  })
})
