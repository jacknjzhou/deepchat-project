import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  managedGetStatusRoute,
  managedRefreshRoute,
  type ManagedConfigStatus
} from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export function createManagedClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function getStatus(): Promise<ManagedConfigStatus> {
    return await bridge.invoke(managedGetStatusRoute.name, {})
  }

  async function refresh(): Promise<ManagedConfigStatus> {
    return await bridge.invoke(managedRefreshRoute.name, {})
  }

  return {
    getStatus,
    refresh
  }
}

export type ManagedClient = ReturnType<typeof createManagedClient>
