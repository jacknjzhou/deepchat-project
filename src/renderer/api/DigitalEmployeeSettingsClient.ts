import type { DeepchatBridge } from '@shared/contracts/bridge'
import { digitalEmployeeConfigurationChangedEvent } from '@shared/contracts/events'
import {
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsTestConnectionRoute,
  type DigitalEmployeeSettingsState,
  type DigitalEmployeeTestMessageCode
} from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export interface DigitalEmployeeSettingsDraft {
  enabled: boolean
  baseUrl: string
  externalUserId: string
  apiKey?: string
}

export function createDigitalEmployeeSettingsClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function get(): Promise<DigitalEmployeeSettingsState> {
    return (await bridge.invoke(
      digitalEmployeeSettingsGetRoute.name,
      {}
    )) as DigitalEmployeeSettingsState
  }

  async function save(draft: DigitalEmployeeSettingsDraft): Promise<DigitalEmployeeSettingsState> {
    return (await bridge.invoke(
      digitalEmployeeSettingsSaveRoute.name,
      draft
    )) as DigitalEmployeeSettingsState
  }

  async function testConnection(draft: {
    baseUrl?: string
    externalUserId?: string
    apiKey?: string
  }): Promise<{ ok: boolean; messageCode: DigitalEmployeeTestMessageCode }> {
    return (await bridge.invoke(digitalEmployeeSettingsTestConnectionRoute.name, draft)) as {
      ok: boolean
      messageCode: DigitalEmployeeTestMessageCode
    }
  }

  async function clearApiKey(): Promise<{ apiKeyConfigured: false }> {
    return (await bridge.invoke(digitalEmployeeSettingsClearApiKeyRoute.name, {})) as {
      apiKeyConfigured: false
    }
  }

  /** StaffDeck 配置保存/清除后由 main 广播，renderer 据此刷新员工列表。 */
  function onConfigurationChanged(listener: () => void) {
    return bridge.on(digitalEmployeeConfigurationChangedEvent.name, () => listener())
  }

  return { get, save, testConnection, clearApiKey, onConfigurationChanged }
}

export type DigitalEmployeeSettingsClient = ReturnType<typeof createDigitalEmployeeSettingsClient>
