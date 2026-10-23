import {
  digitalEmployeeKnowledgeLocalBaseRoute,
  digitalEmployeeKnowledgeStatusRoute
} from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import {
  KNOWLEDGE_STALE_REASONS,
  type KnowledgePackageStatus,
  type KnowledgeStaleReasonValue
} from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import { deriveLocalKnowledgeBaseId } from './knowledgeProvisioning'
import type { KnowledgeSyncStateStore } from './knowledgeSyncState'

/**
 * 知识同步状态的只读路由。
 *
 * 无写操作：同步由后台调度器驱动，renderer 只需要知道「知识是否可能过期」。
 * 这样即使用户疯狂点刷新也不会触发下载。
 */

export interface DigitalEmployeeKnowledgeRoutesDeps {
  stateStore: KnowledgeSyncStateStore
  /**
   * 本地是否真的存在这个知识库的配置（`KnowledgeSettings.getKnowledgeConfigs`）。
   *
   * 两个用途，都关乎「别把命中不了的 id 交出去」：
   * 1. 状态表被清过（config entry 损坏、被手工删除）但知识库还在；
   * 2. 用户在主设置里删掉了那个库，状态表却还留着记录。
   *
   * 省略时只信任状态表——单测不必为此拖进整个 KnowledgeSettings。
   */
  hasKnowledgeBase?: (knowledgeBaseId: string) => boolean
}

function readStatus(
  deps: DigitalEmployeeKnowledgeRoutesDeps,
  input: { employeeId: string }
): { packages: KnowledgePackageStatus[] } {
  const state = deps.stateStore.getEmployee(input.employeeId)
  if (!state) return { packages: [] }

  const packages: KnowledgePackageStatus[] = Object.entries(state.packages).map(
    ([knowledgeBaseId, pkg]) => ({
      knowledgeBaseId,
      stale: pkg.stale,
      staleReason: normalizeStaleReason(pkg.staleReason),
      lastSyncAt: pkg.lastSyncAt,
      conceptCount: Object.keys(pkg.concepts).length
    })
  )

  return { packages }
}

/**
 * 找出该员工在**本地**的知识库 id（`de-` 前缀），供会话建立前的检索寻址。
 *
 * 为什么不能直接用 payload 的 `knowledgeBaseIds`：那些是服务端 id（`kb_...`），
 * 本地库是按员工另建的，两套 id 之间没有映射关系。拿远端 id 去
 * `similarityQuery`，`KnowledgeService.getOrCreateKnowledgeBase` 找不到配置会
 * 直接抛错，而 renderer 侧只能 catch 成空结果——表现为「永远召回不到知识」。
 *
 * 解析顺序：
 * 1. 状态表里记录的 `localKnowledgeBaseId`（同步时写入，权威来源）；
 * 2. 状态表缺失时按同一派生规则重算一次——只要配置里真有这个库就用它。
 *    覆盖「状态表被清空但向量库还在」，不必为了检索再跑一轮全量索引。
 *
 * 返回 `null` 一律表示「本机没有可供检索的库」，调用方必须跳过检索而不是回退
 * 到远端 id。
 */
function readLocalKnowledgeBaseId(
  deps: DigitalEmployeeKnowledgeRoutesDeps,
  employeeId: string
): { knowledgeBaseId: string | null } {
  const recorded = deps.stateStore.getEmployee(employeeId)?.localKnowledgeBaseId
  const candidate = recorded ?? deriveLocalKnowledgeBaseId(employeeId)

  // 没有探测器时无从校验，只能按状态表返回；有就顺手排掉「已被删除的库」。
  if (deps.hasKnowledgeBase && !deps.hasKnowledgeBase(candidate)) {
    return { knowledgeBaseId: null }
  }
  return { knowledgeBaseId: candidate }
}

/**
 * 把存储侧的原因码收敛到契约允许的集合。
 *
 * 存储里可能残留旧版本的码或未来新增的码；直接透传会让界面显示原始字符串，
 * 所以未识别的统一降级为 `UNKNOWN`，由 i18n 提供兜底文案。
 */
function normalizeStaleReason(reason: string | null): KnowledgeStaleReasonValue | null {
  if (reason === null || reason === '') return null
  if (/^HTTP_\d{3}$/.test(reason)) return reason as KnowledgeStaleReasonValue
  if ((KNOWLEDGE_STALE_REASONS as readonly string[]).includes(reason)) {
    return reason as KnowledgeStaleReasonValue
  }
  return 'UNKNOWN'
}

export function createDigitalEmployeeKnowledgeRoutes(
  deps: DigitalEmployeeKnowledgeRoutesDeps
): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeKnowledgeStatusRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeKnowledgeStatusRoute.input.parse(rawInput)
        return digitalEmployeeKnowledgeStatusRoute.output.parse(readStatus(deps, input))
      }
    ],
    [
      digitalEmployeeKnowledgeLocalBaseRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeKnowledgeLocalBaseRoute.input.parse(rawInput)
        return digitalEmployeeKnowledgeLocalBaseRoute.output.parse(
          readLocalKnowledgeBaseId(deps, input.employeeId)
        )
      }
    ]
  ])
}
