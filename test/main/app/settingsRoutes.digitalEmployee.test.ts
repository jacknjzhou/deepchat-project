import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDigitalEmployeeSettingsRoutes,
  normalizeDigitalEmployeeBaseUrl
} from '../../../src/main/digital-employee/settingsRoutes'
import {
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsSetFeatureEnabledRoute,
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
    setFeatureEnabled(input: unknown): Promise<unknown>
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
      setFeatureEnabled: (input) =>
        routes.get(digitalEmployeeSettingsSetFeatureEnabledRoute.name)!(input),
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
      // 总开关缺省必须读成关闭：入口只能被用户显式打开，不能靠「没设置」猜成开。
      featureEnabled: false,
      baseUrl: '',
      externalUserId: 'user-1',
      apiKeyConfigured: true,
      apiKeyUsable: true,
      backflowEnabled: true,
      // 未设置过时回传生效值而不是 null：后台按 3600 在跑，界面必须说同一个数。
      syncIntervalSeconds: 3600
    })
    expect(JSON.stringify(result)).not.toContain('sd_live_secret')
    expect(JSON.stringify(result)).not.toContain('wrapped:')
  })

  it('persists the feature master switch immediately and broadcasts it', async () => {
    const result = (await harness.handlers.setFeatureEnabled({ enabled: true })) as {
      featureEnabled: boolean
    }

    expect(harness.settingsStore.get('digitalEmployee.featureEnabled')).toBe(true)
    expect(harness.onConfigurationChanged).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ featureEnabled: true })

    const reread = (await harness.handlers.get()) as { featureEnabled: boolean }
    expect(reread.featureEnabled).toBe(true)

    await harness.handlers.setFeatureEnabled({ enabled: false })
    expect((await harness.handlers.get()) as { featureEnabled: boolean }).toMatchObject({
      featureEnabled: false
    })
  })

  it('flags a wrapped key that cannot be decrypted on this machine', async () => {
    // 跨加密环境拷来的配置在本机永远解不开，连接层拿到空 key 会静默降级到
    // mock。设置页必须把「已配置但不可用」和「尚未配置」区分开，用户才有得修。
    const broken = createHarness({
      initialWrappedKey: 'wrapped:sd_live_secret',
      plaintextKey: ''
    })

    const result = (await broken.handlers.get()) as Record<string, unknown>

    expect(result).toMatchObject({ apiKeyConfigured: true, apiKeyUsable: false })
    expect(JSON.stringify(result)).not.toContain('sd_live_secret')
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

  it('persists the knowledge sync interval when supplied', async () => {
    const result = (await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1',
      syncIntervalSeconds: 1800
    })) as { syncIntervalSeconds: number }

    expect(harness.settings.set).toHaveBeenCalledWith(
      'digitalEmployee.knowledgeSyncIntervalSeconds',
      1800
    )
    expect(result.syncIntervalSeconds).toBe(1800)
  })

  it('leaves the sync interval untouched when the caller omits it', async () => {
    harness.settingsStore.set('digitalEmployee.knowledgeSyncIntervalSeconds', 900)

    const result = (await harness.handlers.save({
      enabled: true,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1'
    })) as { syncIntervalSeconds: number }

    // 省略是「保留」，不是「改回默认」——旧版 renderer 保存一次就把用户的设置冲掉了。
    expect(harness.settings.set).not.toHaveBeenCalledWith(
      'digitalEmployee.knowledgeSyncIntervalSeconds',
      expect.anything()
    )
    expect(result.syncIntervalSeconds).toBe(900)
  })

  it('reports the effective default when the stored interval is unusable', async () => {
    harness.settingsStore.set('digitalEmployee.knowledgeSyncIntervalSeconds', 0)

    const result = (await harness.handlers.get()) as { syncIntervalSeconds: number }

    // 0 会让调度器回落到 3600；界面若照抄 0 就会显示「不同步」，与事实相反。
    expect(result.syncIntervalSeconds).toBe(3600)
  })

  it('rejects an interval below the floor instead of silently clamping it', async () => {
    await expect(
      harness.handlers.save({
        enabled: true,
        baseUrl: 'https://sd.example',
        externalUserId: 'user-1',
        syncIntervalSeconds: 10
      })
    ).rejects.toThrow()
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
    expect(headers['x-external-user-id']).toBeUndefined()
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

  /**
   * `mcp:invoke` 与 `agents:read` 是两个独立 scope。只探列表会给出「连接成功」，
   * 而实际对话里一个 `staffdeck_*` 工具都没有——这个故障在设置页看不出来，
   * 只会在用户开口第一句时以「这个员工不会用工具」的形式出现。
   */
  describe('mcp scope probe', () => {
    const listOk = () => jsonResponse(200, { employees: [makeEmployee()] })

    it('probes the employee-addressed MCP endpoint with the same key', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(listOk())
        // 405 = 鉴权通过但没有服务端推送的一半，正是这里的「有 scope」信号。
        .mockResolvedValueOnce(new Response(null, { status: 405 }))
      const harness = createHarness({
        initialSettings: baseSettings,
        initialWrappedKey: 'wrapped:k',
        plaintextKey: 'sd_live_k',
        fetchImpl
      })

      expect(await harness.handlers.testConnection()).toEqual({ ok: true, messageCode: 'ok' })

      const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit]
      expect(url).toBe('https://sd.example/api/v1/mcp/agents/deepchat-scope-probe')
      expect(init.method).toBe('GET')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sd_live_k')
    })

    it.each([401, 403])(
      'reports missingMcpScope when the MCP endpoint returns %s',
      async (status) => {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(listOk())
          .mockResolvedValueOnce(new Response('denied', { status }))
        const harness = createHarness({
          initialSettings: baseSettings,
          initialWrappedKey: 'wrapped:k',
          plaintextKey: 'sd_live_k',
          fetchImpl
        })

        expect(await harness.handlers.testConnection()).toEqual({
          ok: false,
          messageCode: 'missingMcpScope'
        })
      }
    )

    it('does not blame scopes for a network failure on the MCP endpoint', async () => {
      // 列表刚成功、MCP 端点却连不上：多半是反代规则或网络抖动。报成「缺权限」
      // 会让人去改一个根本不需要改的东西。
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(listOk())
        .mockRejectedValueOnce(new TypeError('fetch failed'))
      const harness = createHarness({
        initialSettings: baseSettings,
        initialWrappedKey: 'wrapped:k',
        plaintextKey: 'sd_live_k',
        fetchImpl
      })

      expect(await harness.handlers.testConnection()).toEqual({ ok: true, messageCode: 'ok' })
    })

    it('does not probe when the list already failed', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
      const harness = createHarness({
        initialSettings: baseSettings,
        initialWrappedKey: 'wrapped:k',
        plaintextKey: 'sd_live_k',
        fetchImpl
      })

      expect(await harness.handlers.testConnection()).toEqual({
        ok: false,
        messageCode: 'httpError'
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
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
