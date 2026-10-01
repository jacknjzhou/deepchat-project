import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { fetchManagedConfig, toLocalProviderId } from '@/managed/client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const knownProviderTypes = ['openai', 'new-api', 'anthropic']
const builtinIdByApiType = { openai: 'openai', 'new-api': 'new-api', anthropic: 'anthropic' }

describe('toLocalProviderId', () => {
  it('prefixes and keeps safe characters', () => {
    expect(toLocalProviderId('corp-gw')).toBe('managed-corp-gw')
    expect(toLocalProviderId('a.b_c-1')).toBe('managed-a.b_c-1')
  })

  it('replaces unsafe characters with dash', () => {
    expect(toLocalProviderId('corp gw/主')).toBe('managed-corp-gw--')
  })
})

describe('fetchManagedConfig', () => {
  const device = { username: 'zhangsan', domain: 'CORP', hostname: 'PC-01', sid: 'S-1-5-21' }
  const base = { endpoint: 'https://cfg.corp/api', device, knownProviderTypes, builtinIdByApiType }

  it('normalizes a new-api provider into a managed instance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          {
            key: 'corp-gw',
            name: '企业网关',
            apiType: 'new-api',
            baseUrl: 'https://gw.corp.example.com',
            apiKey: 'sk-x',
            enabled: true,
            instanceLabel: '企业网关'
          }
        ],
        documents: {
          textModel: { providerKey: 'corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
          visionModel: { providerKey: 'corp-gw', modelId: 'gpt-4o' },
          concurrency: 4
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.status).toBe('applied')
    expect(result.config?.providers[0]).toEqual({
      id: 'managed-corp-gw',
      key: 'corp-gw',
      name: '企业网关',
      apiType: 'new-api',
      baseProviderId: 'new-api',
      instanceLabel: '企业网关',
      baseUrl: 'https://gw.corp.example.com',
      apiKey: 'sk-x',
      enabled: true
    })
    expect(result.config?.documents).toEqual({
      textModel: { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
      visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
      concurrency: 4,
      temperature: null,
      maxTokens: null
    })
    const calledUrl = fetchImpl.mock.calls[0][0] as string
    expect(calledUrl).toContain('username=zhangsan')
    expect(calledUrl).toContain('domain=CORP')
  })

  it('defaults instanceLabel to name and enabled to true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'k', name: '网关', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers[0]).toMatchObject({
      instanceLabel: '网关',
      enabled: true,
      baseProviderId: 'new-api'
    })
  })

  it('keeps agentModels as bare model ids and records the anchor provider id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        defaultProviderKey: 'corp-gw',
        providers: [
          { key: 'other', name: 'Other', apiType: 'new-api', baseUrl: 'https://o', apiKey: 'k' },
          {
            key: 'corp-gw',
            name: '企业网关',
            apiType: 'new-api',
            baseUrl: 'https://gw',
            apiKey: 'sk'
          }
        ],
        agentModels: {
          chat: 'deepseek-v3',
          assistant: 'gpt-4o-mini',
          vision: 'gpt-4o',
          imageGeneration: 'gpt-image-2'
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.defaultProviderId).toBe('managed-corp-gw')
    expect(result.config?.agentModels).toEqual({
      chat: 'deepseek-v3',
      assistant: 'gpt-4o-mini',
      vision: 'gpt-4o',
      imageGeneration: 'gpt-image-2'
    })
  })

  it('omits empty agentModels entries and nulls the block when nothing is left', async () => {
    const partial = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          agentModels: { chat: 'm1', assistant: '', vision: null }
        })
      )
    })
    expect(partial.config?.agentModels).toEqual({ chat: 'm1' })

    const empty = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          agentModels: { chat: '', assistant: null }
        })
      )
    })
    expect(empty.config?.agentModels).toBeNull()
  })

  it('falls back to the first provider as the anchor when defaultProviderKey is missing or unknown', async () => {
    const body = (defaultProviderKey?: string) => ({
      version: 1,
      ...(defaultProviderKey ? { defaultProviderKey } : {}),
      providers: [
        { key: 'first', name: 'First', apiType: 'new-api', baseUrl: 'https://f', apiKey: 'k' },
        { key: 'second', name: 'Second', apiType: 'new-api', baseUrl: 'https://s', apiKey: 'k' }
      ]
    })

    const withoutAnchor = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(body()))
    })
    expect(withoutAnchor.config?.defaultProviderId).toBe('managed-first')

    const unknownAnchor = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(body('nope')))
    })
    expect(unknownAnchor.config?.defaultProviderId).toBe('managed-first')
    expect(unknownAnchor.warnings.some((w) => w.includes('defaultProviderKey not found'))).toBe(
      true
    )
  })

  it('keeps the agentModels ids even when no provider survives normalization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'bad', name: 'Bad', apiType: 'not-a-real-type', baseUrl: 'https://b', apiKey: 'k' }
        ],
        agentModels: { chat: 'm1' }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers).toEqual([])
    expect(result.config?.agentModels).toEqual({ chat: 'm1' })
    expect(result.config?.defaultProviderId).toBeNull()
  })

  it('returns absent on 404 and 204', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: notFound })).status).toBe('absent')
    const noContent = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: noContent })).status).toBe('absent')
  })

  it('returns denied on 401/403', async () => {
    const denied = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: denied })).status).toBe('denied')
  })

  it('returns unavailable on network error, 5xx and invalid json', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await fetchManagedConfig({ ...base, fetchImpl: boom })).status).toBe('unavailable')
    const five = vi.fn().mockResolvedValue(new Response('oops', { status: 502 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: five })).status).toBe('unavailable')
    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: badJson })).status).toBe('unavailable')
  })

  it('drops providers with unknown apiType or missing required fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' },
          {
            key: 'bad-type',
            name: 'X',
            apiType: 'not-a-real-type',
            baseUrl: 'https://b',
            apiKey: 'k'
          },
          { key: 'no-url', name: 'Y', apiType: 'new-api', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers.map((p) => p.key)).toEqual(['ok'])
    expect(result.warnings.some((w) => w.includes('not-a-real-type'))).toBe(true)
  })

  it('drops the whole documents section when a ref references an unknown providerKey', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
        ],
        documents: {
          textModel: { providerKey: 'missing', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' }
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    // 只有一个模型可用 → 整段作废（视作未锁定），用户仍可补配缺失的模型
    expect(result.config?.documents).toBeNull()
    expect(result.warnings.some((w) => w.includes('unknown providerKey: missing'))).toBe(true)
  })

  it('drops invalid endpointType from a model ref', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
        ],
        documents: {
          textModel: { providerKey: 'ok', modelId: 'm', endpointType: 'not-a-real-endpoint' },
          visionModel: { providerKey: 'ok', modelId: 'm2', endpointType: 'anthropic' }
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.documents?.textModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm'
    })
    expect(result.config?.documents?.visionModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm2',
      endpointType: 'anthropic'
    })
  })

  it('clamps documents concurrency into 1-10', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
        ],
        documents: {
          textModel: { providerKey: 'ok', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' },
          concurrency: 99
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.documents?.concurrency).toBe(10)
  })

  it('drops malformed provider entries individually and records the reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          null,
          'oops',
          ['array', 'entry'],
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' },
          { key: 'no-api-type', name: 'Y', baseUrl: 'https://b', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.status).toBe('applied')
    expect(result.config?.providers.map((p) => p.key)).toEqual(['ok'])
    const dropped = result.warnings.filter((w) => w.includes('provider spec dropped'))
    expect(dropped).toHaveLength(4)
    expect(dropped.every((w) => w !== 'provider spec dropped: ')).toBe(true)
    expect(dropped.some((w) => w.includes('apiType'))).toBe(true)
  })

  it('drops the documents section when a model ref is malformed', async () => {
    const providers = [
      { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
    ]
    const nonObject = await fetchManagedConfig({
      ...base,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ version: 1, providers, documents: { textModel: 'oops' } })
        )
    })
    expect(nonObject.status).toBe('applied')
    // 两个模型引用都不可用 → 整段作废（视作未锁定），避免用户无法补配上缺失的模型
    expect(nonObject.config?.documents).toBeNull()

    const badFields = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers,
          documents: {
            textModel: { providerKey: 1, modelId: 'm' },
            visionModel: { providerKey: 'ok', modelId: 'm2' }
          }
        })
      )
    })
    expect(badFields.status).toBe('applied')
    // textModel 非法 → 只有一个模型可用 → 整段作废，用户仍可补配 textModel
    expect(badFields.config?.documents).toBeNull()
    expect(
      badFields.warnings.some((w) => w.includes('providerKey and modelId must be strings'))
    ).toBe(true)
  })

  it('unlocks the documents section when only non-model parameters are delivered', async () => {
    const result = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          documents: { concurrency: 6 }
        })
      )
    })
    expect(result.status).toBe('applied')
    // 没有可用模型引用 → 整段为 null，用户仍可自行配置提取模型，不会被只读锁死
    expect(result.config?.documents).toBeNull()
    expect(result.warnings.some((w) => w.startsWith('documents section ignored'))).toBe(true)
  })

  it('keeps the documents section when both textModel and visionModel are delivered', async () => {
    const result = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          documents: {
            textModel: { providerKey: 'ok', modelId: 'm' },
            visionModel: { providerKey: 'ok', modelId: 'm2' }
          }
        })
      )
    })
    expect(result.status).toBe('applied')
    expect(result.config?.documents?.textModel).toEqual({ providerId: 'managed-ok', modelId: 'm' })
    expect(result.config?.documents?.visionModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm2'
    })
    expect(result.warnings.some((w) => w.startsWith('documents section ignored'))).toBe(false)
  })

  it('ignores the documents section when only textModel is delivered', async () => {
    const result = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          documents: {
            textModel: { providerKey: 'ok', modelId: 'm' },
            concurrency: 3
          }
        })
      )
    })
    expect(result.status).toBe('applied')
    expect(result.config?.documents).toBeNull()
    expect(
      result.warnings.some(
        (w) => w.startsWith('documents section ignored') && w.includes('textModel and visionModel')
      )
    ).toBe(true)
  })

  it('ignores the documents section when only visionModel is delivered', async () => {
    const result = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [
            { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
          ],
          documents: {
            visionModel: { providerKey: 'ok', modelId: 'm2' }
          }
        })
      )
    })
    expect(result.status).toBe('applied')
    expect(result.config?.documents).toBeNull()
    expect(
      result.warnings.some(
        (w) => w.startsWith('documents section ignored') && w.includes('textModel and visionModel')
      )
    ).toBe(true)
  })

  it('url-encodes non-ascii username and domain', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: 1, providers: [] }))
    await fetchManagedConfig({
      ...base,
      device: { username: '张三', domain: '研发域', hostname: 'PC-01', sid: 'S-1' },
      fetchImpl
    })
    const calledUrl = fetchImpl.mock.calls[0][0] as string
    expect(calledUrl).toContain(`username=${encodeURIComponent('张三')}`)
    expect(calledUrl).toContain(`domain=${encodeURIComponent('研发域')}`)
    expect(calledUrl).not.toContain('张三')
  })

  it('does not abort immediately when timeoutMs is invalid', async () => {
    const body = {
      version: 1,
      providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }]
    }
    let signal: AbortSignal | null | undefined
    const fetchImpl = vi.fn().mockImplementation((_input: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse(body)), 10))
    })
    const result = await fetchManagedConfig({ ...base, timeoutMs: Number.NaN, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('applied')
    expect(signal?.aborted).toBe(false)
  })

  it('skips the request entirely when endpoint is empty', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchManagedConfig({ ...base, endpoint: '', fetchImpl })
    expect(result.status).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
