import { describe, expect, it, vi } from 'vitest'
import { MockDigitalEmployeeProvider } from '../../../src/main/digital-employee/provider'
import { createDigitalEmployeeProviderHolder } from '../../../src/main/digital-employee/providerFactory'
import { createDigitalEmployeeRoutes } from '../../../src/main/digital-employee/routes'
import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '../../../src/shared/contracts/routes/digitalEmployee.routes'

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

describe('createDigitalEmployeeRoutes', () => {
  const createRoutesWithMock = () =>
    createDigitalEmployeeRoutes(
      createDigitalEmployeeProviderHolder(new MockDigitalEmployeeProvider())
    )

  it('list returns contract-parsed employees with fetchedAt and mock source', async () => {
    const routes = createRoutesWithMock()
    const handler = routes.get(digitalEmployeeListRoute.name)!
    expect(handler).toBeDefined()

    const result = (await handler({})) as {
      fetchedAt: string
      employees: unknown[]
      degraded: boolean
      source: string
    }
    expect(result.fetchedAt).toBeTruthy()
    expect(result.employees.length).toBeGreaterThanOrEqual(10)
    expect(result.degraded).toBe(false)
    expect(result.source).toBe('mock')
  })

  it('get returns the employee by id and null for unknown id', async () => {
    const routes = createRoutesWithMock()
    const handler = routes.get(digitalEmployeeGetRoute.name)!

    expect(
      ((await handler({ id: 'finance' })) as { employee: { name: string } | null }).employee?.name
    ).toBe('财务')
    expect(((await handler({ id: 'nope' })) as { employee: unknown }).employee).toBeNull()
  })

  it('reads the provider from the holder on every request', async () => {
    const holder = createDigitalEmployeeProviderHolder(new MockDigitalEmployeeProvider())
    const routes = createDigitalEmployeeRoutes(holder)
    const handler = routes.get(digitalEmployeeListRoute.name)!

    const nextProvider = {
      source: 'http' as const,
      degraded: true,
      list: vi.fn().mockResolvedValue([makeEmployee({ id: 'remote-only', name: '远端员工' })])
    }
    holder.replace(nextProvider)

    const result = (await handler({})) as {
      employees: Array<{ id: string }>
      degraded: boolean
      source: string
    }

    // 热替换后必须使用新实例，且把降级/来源透传给 renderer。
    expect(nextProvider.list).toHaveBeenCalledTimes(1)
    expect(result.employees.map((item) => item.id)).toEqual(['remote-only'])
    expect(result.degraded).toBe(true)
    expect(result.source).toBe('http')
  })

  it('propagates provider failures instead of returning an empty list', async () => {
    const routes = createDigitalEmployeeRoutes(
      createDigitalEmployeeProviderHolder({
        list: vi.fn().mockRejectedValue(new Error('staffdeck down'))
      })
    )
    const handler = routes.get(digitalEmployeeListRoute.name)!

    await expect(handler({})).rejects.toThrow('staffdeck down')
  })
})
