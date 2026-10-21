import type { DeepchatBridge } from '@shared/contracts/bridge'
import { digitalEmployeeGetRoute, digitalEmployeeListRoute } from '@shared/contracts/routes'
import type { DigitalEmployee } from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export function createDigitalEmployeeClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function list(): Promise<{
    employees: DigitalEmployee[]
    fetchedAt: string
  }> {
    const result = await bridge.invoke(digitalEmployeeListRoute.name, {})
    return result as { employees: DigitalEmployee[]; fetchedAt: string }
  }

  async function get(id: string): Promise<DigitalEmployee | null> {
    const result = await bridge.invoke(digitalEmployeeGetRoute.name, { id })
    return (result as { employee: DigitalEmployee | null }).employee
  }

  return { list, get }
}

export type DigitalEmployeeClient = ReturnType<typeof createDigitalEmployeeClient>
