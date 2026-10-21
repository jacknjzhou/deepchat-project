import { describe, expect, it } from 'vitest'
import { MockDigitalEmployeeProvider } from '../../../src/main/digital-employee/provider'
import { digitalEmployeeSchema } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

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
})
