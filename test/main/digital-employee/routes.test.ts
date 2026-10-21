import { describe, expect, it } from 'vitest'
import { MockDigitalEmployeeProvider } from '../../../src/main/digital-employee/provider'
import { createDigitalEmployeeRoutes } from '../../../src/main/digital-employee/routes'
import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '../../../src/shared/contracts/routes/digitalEmployee.routes'

describe('createDigitalEmployeeRoutes', () => {
  it('list returns contract-parsed employees with fetchedAt', async () => {
    const routes = createDigitalEmployeeRoutes(new MockDigitalEmployeeProvider())
    const handler = routes.get(digitalEmployeeListRoute.name)!
    expect(handler).toBeDefined()

    const result = (await handler({})) as { fetchedAt: string; employees: unknown[] }
    expect(result.fetchedAt).toBeTruthy()
    expect(result.employees.length).toBeGreaterThanOrEqual(10)
  })

  it('get returns the employee by id and null for unknown id', async () => {
    const routes = createDigitalEmployeeRoutes(new MockDigitalEmployeeProvider())
    const handler = routes.get(digitalEmployeeGetRoute.name)!

    expect(((await handler({ id: 'finance' })) as { employee: { name: string } | null }).employee?.name).toBe('财务')
    expect(((await handler({ id: 'nope' })) as { employee: unknown }).employee).toBeNull()
  })
})
