import type { DeepchatBridge } from '@shared/contracts/bridge'
import { digitalEmployeeConfigurationChangedEvent } from '@shared/contracts/events'
import {
  digitalEmployeeBackflowQueueStatusRoute,
  digitalEmployeeSettingsClearApiKeyRoute,
  digitalEmployeeSettingsGetRoute,
  digitalEmployeeSettingsSaveRoute,
  digitalEmployeeSettingsSetFeatureEnabledRoute,
  digitalEmployeeSettingsTestConnectionRoute,
  type DigitalEmployeeSettingsState,
  type DigitalEmployeeTestMessageCode
} from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

/**
 * 补发队列的积压情况。
 *
 * 与设置本身放同一个 client 而不是另起一个文件：它唯一的用途是让设置页的
 * 回流开关能说清「现在还有 N 条没归档」，两者总是出现在同一屏。
 */
export interface DigitalEmployeeBackflowQueueStatus {
  pending: number
  due: number
  oldestCreatedAt: number | null
}

export interface DigitalEmployeeSettingsDraft {
  enabled: boolean
  baseUrl: string
  externalUserId: string
  apiKey?: string
  /** 省略表示保留当前值：老版本保存时不会带上这个字段。 */
  backflowEnabled?: boolean
  /** 同上：省略表示保留当前值。 */
  syncIntervalSeconds?: number
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

  /** 功能总开关独立读写：连接未配置时也必须可切换，故不并入 save。 */
  async function setFeatureEnabled(enabled: boolean): Promise<{ featureEnabled: boolean }> {
    return (await bridge.invoke(digitalEmployeeSettingsSetFeatureEnabledRoute.name, {
      enabled
    })) as { featureEnabled: boolean }
  }

  /** StaffDeck 配置保存/清除后由 main 广播，renderer 据此刷新员工列表。 */
  function onConfigurationChanged(listener: () => void) {
    return bridge.on(digitalEmployeeConfigurationChangedEvent.name, () => listener())
  }

  /**
   * 读取补发队列的积压情况。
   *
   * 查询失败一律按「没有积压」处理：这是纯展示用的信息，为它弹一个错误提示
   * 反而会让人以为回流出问题了。
   */
  async function backflowQueueStatus(): Promise<DigitalEmployeeBackflowQueueStatus> {
    try {
      return (await bridge.invoke(
        digitalEmployeeBackflowQueueStatusRoute.name,
        {}
      )) as DigitalEmployeeBackflowQueueStatus
    } catch {
      return { pending: 0, due: 0, oldestCreatedAt: null }
    }
  }

  return {
    get,
    save,
    setFeatureEnabled,
    testConnection,
    clearApiKey,
    backflowQueueStatus,
    onConfigurationChanged
  }
}

export type DigitalEmployeeSettingsClient = ReturnType<typeof createDigitalEmployeeSettingsClient>
