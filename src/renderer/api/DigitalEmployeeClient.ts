import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  digitalEmployeeBackflowRoute,
  digitalEmployeeBindRemoteSessionRoute,
  digitalEmployeeGetRoute,
  digitalEmployeeKnowledgeConceptRoute,
  digitalEmployeeKnowledgeGraphRoute,
  digitalEmployeeKnowledgeLocalBaseRoute,
  digitalEmployeeKnowledgeStatusRoute,
  digitalEmployeeListRoute,
  digitalEmployeeProvisionRoute,
  digitalEmployeeRemoteStatusRoute,
  digitalEmployeeSwitchToRemoteRoute
} from '@shared/contracts/routes'
import type { DigitalEmployee, StaffdeckAwaitingInput } from '@shared/contracts/routes'
import type {
  BackflowEventInput,
  DigitalEmployeeBackflowResult,
  DigitalEmployeeKnowledgeConcept,
  DigitalEmployeeKnowledgeGraph,
  DigitalEmployeeKnowledgeLocalBase,
  DigitalEmployeeKnowledgeStatus,
  DigitalEmployeeProvisionResult,
  KnowledgePackageStatus
} from '@shared/contracts/routes'
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

  /** 本地知识同步状态（只读；同步本身由 main 的后台调度器驱动）。 */
  async function knowledgeStatus(employeeId: string): Promise<DigitalEmployeeKnowledgeStatus> {
    const result = await bridge.invoke(digitalEmployeeKnowledgeStatusRoute.name, { employeeId })
    return result as DigitalEmployeeKnowledgeStatus
  }

  /**
   * 该员工在**本机**的知识库 id（`null` = 本机没有可检索的库）。
   *
   * 与 `knowledgeStatus` 分开：前者是展示数据，这条是会话检索的寻址参数。
   * 不要用 payload 的 `knowledgeBaseIds`（服务端 `kb_*` id）去检索本地库。
   */
  async function knowledgeLocalBase(
    employeeId: string
  ): Promise<DigitalEmployeeKnowledgeLocalBase> {
    const result = await bridge.invoke(digitalEmployeeKnowledgeLocalBaseRoute.name, { employeeId })
    return result as DigitalEmployeeKnowledgeLocalBase
  }

  /** 知识图谱（概念 + 链接边）；`null` = 整包不可用，UI 降级为「图谱暂不可用」。 */
  async function knowledgeGraph(input: {
    employeeId: string
    knowledgeBaseId: string
  }): Promise<DigitalEmployeeKnowledgeGraph | null> {
    const result = await bridge.invoke(digitalEmployeeKnowledgeGraphRoute.name, input)
    return result as DigitalEmployeeKnowledgeGraph | null
  }

  /** 单个概念的 markdown 正文；`content: null` = 本地缓存和远端都拿不到。 */
  async function knowledgeConcept(input: {
    employeeId: string
    knowledgeBaseId: string
    conceptId: string
  }): Promise<DigitalEmployeeKnowledgeConcept> {
    const result = await bridge.invoke(digitalEmployeeKnowledgeConceptRoute.name, input)
    return result as DigitalEmployeeKnowledgeConcept
  }

  /**
   * 本地执行前的准备：注册远端工具 + 安装技能包。
   *
   * 必须在 `loadTools()` **之前**调用：工具白名单是「可用工具列表的补集」，
   * 注册晚了第一轮对话就一个 `staffdeck_*` 工具都没有，之后也不会自动重试。
   * 主进程侧不抛错，所以这里也不做 try/catch——失败已经写在返回值里。
   */
  async function provision(employeeId: string): Promise<DigitalEmployeeProvisionResult> {
    const result = await bridge.invoke(digitalEmployeeProvisionRoute.name, { employeeId })
    return result as DigitalEmployeeProvisionResult
  }

  /**
   * 把本轮的本地事件回流到 StaffDeck 归档。
   *
   * 调用方不得因为失败而改变对话行为：这里返回结果而不抛错，是因为上报失败
   * 只意味着少一条归档记录。
   */
  async function backflow(input: {
    employeeId: string
    sessionId: string
    /** 会话标题，只在首次上报（服务端建会话）时用到。 */
    title?: string
    events: BackflowEventInput[]
  }): Promise<DigitalEmployeeBackflowResult> {
    const result = await bridge.invoke(digitalEmployeeBackflowRoute.name, input)
    return result as DigitalEmployeeBackflowResult
  }

  return {
    list,
    get,
    bindRemoteSession,
    remoteStatus,
    switchToRemote,
    knowledgeStatus,
    knowledgeLocalBase,
    knowledgeGraph,
    knowledgeConcept,
    provision,
    backflow,
    onRemoteRunUpdated
  }
}

export type { KnowledgePackageStatus }

export type DigitalEmployeeClient = ReturnType<typeof createDigitalEmployeeClient>
