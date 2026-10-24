import {
  digitalEmployeeBindRemoteSessionRoute,
  digitalEmployeeRemoteStatusRoute,
  digitalEmployeeSwitchToRemoteRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { StaffdeckRemoteClient } from './remoteClient'
import type { StaffdeckRemoteRunner, RemoteRunOutcome } from './remoteRunner'
import type { RemoteRunOutcomeStore } from './remoteRunOutcomes'
import type { RemoteSessionRegistry } from './remoteSessionRegistry'

/**
 * 远端执行的路由层：只做「建绑定 / 查状态 / 切 hybrid」，不碰流式细节。
 *
 * 首轮由 main 直接调 runner（`openingQuestion` 随 bind 传入），不走
 * `ChatService`：renderer 建本地会话时消息体为空，若等它再发一条会与
 * 「空会话」语义冲突，也会多出一次用户消息落库。
 */

export interface DigitalEmployeeRemoteRoutesDeps {
  client: Pick<StaffdeckRemoteClient, 'createSession'>
  registry: RemoteSessionRegistry
  runner: Pick<StaffdeckRemoteRunner, 'run'>
  /**
   * 追问明细的共享暂存。
   *
   * 首轮（bind / switch）与后续轮（`ChatService` 的 `remoteTurn.send`）都会写入，
   * `remoteStatus` 从同一份里读。路由自己持有一份私有 Map 是原实现的缺陷：
   * 第二轮起 run 由 `remoteTurn` 发起，写不进这个 Map，于是追问提示条从第二轮
   * 起恒为空——而追问恰恰多半发生在第二、第三轮。
   */
  outcomes: RemoteRunOutcomeStore
}

/** 首轮轮次键固定，保证 bind 重试不会在服务端产生第二个 run。 */
const OPENING_TURN_KEY = 'opening'

export function createDigitalEmployeeRemoteRoutes(
  deps: DigitalEmployeeRemoteRoutesDeps
): DeepchatRouteMap {
  const remember = (sessionId: string, outcome: RemoteRunOutcome): void => {
    deps.outcomes.remember(sessionId, outcome.awaitingInput)
  }

  const bind = async (sessionId: string, employeeId: string): Promise<string> => {
    const existing = deps.registry.get(sessionId)
    if (existing) return existing.remoteSessionId

    const created = await deps.client.createSession({
      employeeId,
      externalSessionId: sessionId,
      title: employeeId,
      metadata: { source: 'deepchat' }
    })

    // 只有远端会话真的建成功了才写绑定：否则该会话后续每条消息都会被误判成远端。
    deps.registry.set(sessionId, {
      remoteSessionId: created.id,
      employeeId,
      runId: null,
      lastEventId: null,
      executionMode: 'remote'
    })
    return created.id
  }

  return createRouteMap([
    [
      digitalEmployeeBindRemoteSessionRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeBindRemoteSessionRoute.input.parse(rawInput)

        const remoteSessionId = await bind(input.sessionId, input.employeeId)

        if (!input.openingQuestion?.trim()) {
          return digitalEmployeeBindRemoteSessionRoute.output.parse({
            remoteSessionId,
            runId: null
          })
        }

        const outcome = await deps.runner.run({
          sessionId: input.sessionId,
          employeeId: input.employeeId,
          input: input.openingQuestion,
          turnKey: OPENING_TURN_KEY
        })
        remember(input.sessionId, outcome)

        return digitalEmployeeBindRemoteSessionRoute.output.parse({
          remoteSessionId,
          runId: outcome.runId
        })
      }
    ],
    [
      digitalEmployeeRemoteStatusRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeRemoteStatusRoute.input.parse(rawInput)
        const binding = deps.registry.get(input.sessionId)

        if (!binding) {
          return digitalEmployeeRemoteStatusRoute.output.parse({
            bound: false,
            remoteSessionId: null,
            employeeId: null,
            runId: null,
            awaitingInput: null
          })
        }

        return digitalEmployeeRemoteStatusRoute.output.parse({
          bound: true,
          remoteSessionId: binding.remoteSessionId,
          employeeId: binding.employeeId,
          runId: binding.runId,
          awaitingInput: deps.outcomes.awaitingInputOf(input.sessionId)
        })
      }
    ],
    [
      digitalEmployeeSwitchToRemoteRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeSwitchToRemoteRoute.input.parse(rawInput)
        const existing = deps.registry.get(input.sessionId)
        if (existing) {
          // 切换刻意不可逆：来回切会让「哪一段在哪个引擎执行」失去唯一答案。
          throw new Error('[digitalEmployee] session is already bound to remote execution')
        }

        const created = await deps.client.createSession({
          employeeId: input.employeeId,
          externalSessionId: input.sessionId,
          title: input.employeeId,
          metadata: { source: 'deepchat' }
        })

        deps.registry.set(input.sessionId, {
          remoteSessionId: created.id,
          employeeId: input.employeeId,
          runId: null,
          lastEventId: null,
          executionMode: 'hybrid'
        })

        const summary = input.contextSummary?.trim()
        if (summary) {
          // 摘要是远端「接上上下文」的唯一途径：服务端看不到本地历史。
          const outcome = await deps.runner.run({
            sessionId: input.sessionId,
            employeeId: input.employeeId,
            input: `以下是本会话此前在本地执行的上下文摘要，请据此继续：\n\n${summary}`,
            turnKey: OPENING_TURN_KEY
          })
          remember(input.sessionId, outcome)
        }

        return digitalEmployeeSwitchToRemoteRoute.output.parse({
          remoteSessionId: created.id
        })
      }
    ]
  ])
}
