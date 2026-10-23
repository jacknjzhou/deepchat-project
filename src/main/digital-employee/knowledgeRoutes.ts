import { digitalEmployeeKnowledgeStatusRoute } from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import {
  KNOWLEDGE_STALE_REASONS,
  type KnowledgePackageStatus,
  type KnowledgeStaleReasonValue
} from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { KnowledgeSyncStateStore } from './knowledgeSyncState'

/**
 * 知识同步状态的只读路由。
 *
 * 无写操作：同步由后台调度器驱动，renderer 只需要知道「知识是否可能过期」。
 * 这样即使用户疯狂点刷新也不会触发下载。
 */

export interface DigitalEmployeeKnowledgeRoutesDeps {
  stateStore: KnowledgeSyncStateStore
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
    ]
  ])
}
