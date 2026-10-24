import { describe, expect, it, vi } from 'vitest'
import {
  HttpDigitalEmployeeProvider,
  MockDigitalEmployeeProvider,
  ResilientDigitalEmployeeProvider
} from '../../../src/main/digital-employee/provider'
import { digitalEmployeeSchema } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

const makeEmployee = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  executionMode: 'local',
  ...overrides
})

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('MockDigitalEmployeeProvider', () => {
  it('returns at least 10 enabled employees passing the shared contract', async () => {
    const provider = new MockDigitalEmployeeProvider()
    const employees = await provider.list()

    expect(employees.length).toBeGreaterThanOrEqual(10)
    for (const employee of employees) {
      expect(digitalEmployeeSchema.parse(employee)).toBeTruthy()
      expect(employee.enabled).toBe(true)
    }
  })

  it('covers the roles shown on the square page screenshot', async () => {
    const roles = (await new MockDigitalEmployeeProvider().list()).map((e) => e.role)
    for (const expected of ['财务', '人事', 'IT', '销售', '采购', '法务', '行政', '市场']) {
      expect(roles).toContain(expected)
    }
  })

  it('reports its data source as mock and is never degraded', async () => {
    const provider = new MockDigitalEmployeeProvider()
    expect(provider.source).toBe('mock')
    expect(provider.degraded).toBeUndefined()
  })
})

describe('HttpDigitalEmployeeProvider', () => {
  const config = { baseUrl: 'https://sd.example', apiKey: 'sd_live_k1' }

  it('sends bearer auth to the versioned endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))

    const employees = await new HttpDigitalEmployeeProvider(config, fetchMock).list()

    expect(employees).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sd.example/api/v1/digital-employees')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sd_live_k1')
    expect(headers.accept).toBe('application/json')
    expect(headers['if-none-match']).toBeUndefined()
    // `external_user_id` 是执行期身份，只走 run/backflow 的 body。发成请求头
    // 会让排查者以为列表按用户过滤——服务端从头到尾没读过这个 header。
    expect(headers['x-external-user-id']).toBeUndefined()
  })

  it('trims trailing slashes from the configured base url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))

    await new HttpDigitalEmployeeProvider(
      { ...config, baseUrl: 'https://sd.example///' },
      fetchMock
    ).list()

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://sd.example/api/v1/digital-employees'
    )
  })

  it('returns the cache on 304 and revalidates with the stored etag', async () => {
    const employee = makeEmployee()
    let call = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1
      if (call === 1) {
        return Promise.resolve(jsonResponse(200, { employees: [employee] }, { etag: '"v1"' }))
      }
      return Promise.resolve(new Response(null, { status: 304 }))
    })
    const provider = new HttpDigitalEmployeeProvider(config, fetchMock)

    expect(await provider.list()).toEqual([employee])
    expect(await provider.list()).toEqual([employee])

    const secondInit = fetchMock.mock.calls[1][1] as RequestInit
    expect((secondInit.headers as Record<string, string>)['if-none-match']).toBe('"v1"')
  })

  it('fills fetchedAt locally when StaffDeck omits it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))

    // 契约要求 fetchedAt 非空；Provider 负责补齐，不把缺失抛给调用方。
    const employees = await new HttpDigitalEmployeeProvider(config, fetchMock).list()
    expect(employees[0].executionMode).toBe('local')
  })

  it('rejects payloads that fail contract validation', async () => {
    const bad = new HttpDigitalEmployeeProvider(
      config,
      vi.fn().mockResolvedValue(jsonResponse(200, { employees: [{ id: '' }] }))
    )
    await expect(bad.list()).rejects.toThrow()
  })

  it('rejects non-2xx responses with the status code', async () => {
    const err = new HttpDigitalEmployeeProvider(
      config,
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    )
    await expect(err.list()).rejects.toThrow('HTTP 500')
  })

  it('rejects invalid json bodies', async () => {
    const broken = new HttpDigitalEmployeeProvider(
      config,
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }))
    )
    await expect(broken.list()).rejects.toThrow('invalid JSON')
  })

  it('does not treat a 304 without cache as a valid empty list', async () => {
    const provider = new HttpDigitalEmployeeProvider(
      config,
      vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    )
    await expect(provider.list()).rejects.toThrow('HTTP 304')
  })
})

describe('ResilientDigitalEmployeeProvider', () => {
  it('falls back to the mock provider and marks degraded when primary fails', async () => {
    const failing = { list: vi.fn().mockRejectedValue(new Error('network down')) }
    const mock = new MockDigitalEmployeeProvider()
    const provider = new ResilientDigitalEmployeeProvider(failing, mock)

    const employees = await provider.list()

    expect(provider.degraded).toBe(true)
    expect(provider.source).toBe('mock')
    expect(employees).toEqual(await mock.list())
  })

  it('recovers to live data after a successful primary call', async () => {
    const employee = makeEmployee()
    const primary = {
      list: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockResolvedValue([employee])
    }
    const provider = new ResilientDigitalEmployeeProvider(
      primary,
      new MockDigitalEmployeeProvider()
    )

    await provider.list()
    expect(provider.degraded).toBe(true)

    const employees = await provider.list()
    expect(provider.degraded).toBe(false)
    expect(provider.source).toBe('http')
    expect(employees).toHaveLength(1)
  })

  it('rethrows the primary error when the fallback also fails', async () => {
    const primaryError = new Error('primary down')
    const provider = new ResilientDigitalEmployeeProvider(
      { list: vi.fn().mockRejectedValue(primaryError) },
      { list: vi.fn().mockRejectedValue(new Error('fallback down')) }
    )

    await expect(provider.list()).rejects.toThrow('primary down')
    // 不能因为 fallback 失败就返回空列表冒充成功。
    expect(provider.degraded).toBe(true)
  })
})
