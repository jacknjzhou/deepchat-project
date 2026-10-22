import type { DeepchatBridge } from '@shared/contracts/bridge'
import { digitalEmployeeGetRoute, digitalEmployeeListRoute } from '@shared/contracts/routes'
import type { DigitalEmployee } from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export interface DigitalEmployeeListResult {
  employees: DigitalEmployee[]
  fetchedAt: string
  /** Provider 已回退到本地 Mock，本批数据并非来自 StaffDeck 远端 */
  degraded?: boolean
  source?: 'http' | 'mock'
}

export function createDigitalEmployeeClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function list(): Promise<DigitalEmployeeListResult> {
    const result = await bridge.invoke(digitalEmployeeListRoute.name, {})
    return result as DigitalEmployeeListResult
  }

  async function get(id: string): Promise<DigitalEmployee | null> {
    const result = await bridge.invoke(digitalEmployeeGetRoute.name, { id })
    return (result as { employee: DigitalEmployee | null }).employee
  }

  return { list, get }
}

export type DigitalEmployeeClient = ReturnType<typeof createDigitalEmployeeClient>
