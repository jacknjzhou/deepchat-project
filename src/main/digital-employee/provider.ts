import type { DigitalEmployee } from '@shared/contracts/routes'
import { MOCK_DIGITAL_EMPLOYEES } from './mockData'

export interface DigitalEmployeeProvider {
  list(): Promise<DigitalEmployee[]>
}

export class MockDigitalEmployeeProvider implements DigitalEmployeeProvider {
  async list(): Promise<DigitalEmployee[]> {
    return MOCK_DIGITAL_EMPLOYEES.filter((employee) => employee.enabled)
  }
}

export class HttpDigitalEmployeeProvider implements DigitalEmployeeProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async list(): Promise<DigitalEmployee[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/employees`, {
      headers: { accept: 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`[digitalEmployee] HTTP ${response.status} from ${this.baseUrl}`)
    }
    const payload = (await response.json()) as { employees: DigitalEmployee[] }
    return payload.employees
  }
}
