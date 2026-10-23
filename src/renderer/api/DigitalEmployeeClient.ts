import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  digitalEmployeeBindRemoteSessionRoute,
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute,
  digitalEmployeeRemoteStatusRoute,
  digitalEmployeeSwitchToRemoteRoute
} from '@shared/contracts/routes'
import type { DigitalEmployee, StaffdeckAwaitingInput } from '@shared/contracts/routes'
import { digitalEmployeeRemoteRunUpdatedEvent } from '@shared/contracts/events'
import type { DeepchatEventPayload } from '@shared/contracts/events'
import { getDeepchatBridge } from './core'

export interface DigitalEmployeeListResult {
  employees: DigitalEmployee[]
  fetchedAt: string
  /** Provider 已回退到本地 Mock，本批数据并非来自 StaffDeck 远端 */
  degraded?: boolean
  source?: 'http' | 'mock'
}

export interface DigitalEmployeeRemoteStatus {
  bound: boolean
  remoteSessionId: string | null
  employeeId: string | null
  runId: string | null
  awaitingInput: StaffdeckAwaitingInput | null
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

  /**
   * 把本地会话绑到 StaffDeck 远端会话；`openingQuestion` 非空时由 main 直接拉起首轮。
   * 首轮不经 renderer 再发一次：本地会话创建时消息体为空，重发会产生两条用户消息。
   */
  async function bindRemoteSession(input: {
    sessionId: string
    employeeId: string
    openingQuestion?: string
  }): Promise<{ remoteSessionId: string; runId: string | null }> {
    const result = await bridge.invoke(digitalEmployeeBindRemoteSessionRoute.name, input)
    return result as { remoteSessionId: string; runId: string | null }
  }

  async function remoteStatus(sessionId: string): Promise<DigitalEmployeeRemoteStatus> {
    const result = await bridge.invoke(digitalEmployeeRemoteStatusRoute.name, { sessionId })
    return result as DigitalEmployeeRemoteStatus
  }

  async function switchToRemote(input: {
    sessionId: string
    employeeId: string
    contextSummary?: string
  }): Promise<{ remoteSessionId: string }> {
    const result = await bridge.invoke(digitalEmployeeSwitchToRemoteRoute.name, input)
    return result as { remoteSessionId: string }
  }

  /** 远端 run 状态变化（不含正文；正文走 `chat.stream.updated`）。 */
  function onRemoteRunUpdated(
    listener: (
      payload: DeepchatEventPayload<typeof digitalEmployeeRemoteRunUpdatedEvent.name>
    ) => void
  ): () => void {
    return bridge.on(digitalEmployeeRemoteRunUpdatedEvent.name, listener)
  }

  return {
    list,
    get,
    bindRemoteSession,
    remoteStatus,
    switchToRemote,
    onRemoteRunUpdated
  }
}

export type DigitalEmployeeClient = ReturnType<typeof createDigitalEmployeeClient>
