import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  digitalEmployeeKnowledgeConceptRoute,
  digitalEmployeeKnowledgeGraphRoute,
  digitalEmployeeKnowledgeLocalBaseRoute,
  digitalEmployeeKnowledgeStatusRoute,
  type DigitalEmployeeKnowledgeGraph
} from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import {
  KNOWLEDGE_STALE_REASONS,
  type KnowledgePackageStatus,
  type KnowledgeStaleReasonValue
} from '@shared/contracts/routes/digitalEmployeeKnowledge.routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { StaffdeckKnowledgeClient } from './knowledgeClient'
import { buildKnowledgeGraph } from './knowledgeGraph'
import { deriveLocalKnowledgeBaseId } from './knowledgeProvisioning'
import { conceptFilePath } from './knowledgeSync'
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
  /**
   * 现取 StaffDeck 知识客户端（连接缺失返回 null）。调用时现取而不是建路由时
   * 取死：路由只创建一次，而连接会随配置变更整体重建。
   */
  readClient?: () => StaffdeckKnowledgeClient | null
  /** 概念正文缓存根目录：`{userData}/digital-employee-knowledge`。缺省时只走远端。 */
  cacheDir?: string
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
      conceptCount: Object.keys(pkg.concepts).length,
      // 目录信息随包记录透出；未拉到（端点未上线）时自然缺省。
      ...pkg.info
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
 * 只按派生规则重算、不读状态表：派生是确定性的，状态表里的记录只服务同步
 * 记账。派生规则升级后旧记录会指向旧库（旧规则可能把多个员工并进同一个
 * id），按记录寻址等于把撞车的混库继续交出去；按当前规则寻址最多空手到
 * 下一轮同步灌满新库。
 *
 * 返回 `null` 一律表示「本机没有可供检索的库」，调用方必须跳过检索而不是回退
 * 到远端 id。
 */
function readLocalKnowledgeBaseId(
  deps: DigitalEmployeeKnowledgeRoutesDeps,
  employeeId: string
): { knowledgeBaseId: string | null } {
  const knowledgeBaseId = deriveLocalKnowledgeBaseId(employeeId)
  // 没有探测器时无从校验，只能直接返回派生值；有就顺手排掉「已被删除的库」。
  if (deps.hasKnowledgeBase && !deps.hasKnowledgeBase(knowledgeBaseId)) {
    return { knowledgeBaseId: null }
  }
  return { knowledgeBaseId }
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

/**
 * 拉取概念元数据并按管理台语义建图。
 *
 * 图谱是纯展示数据：端点未上线（client 返回 null）、网络失败都收敛为 `null`，
 * 由抽屉降级为「图谱暂不可用」。这与同步的容错哲学一致——展示端点的缺席
 * 不能变成用户可见的错误。
 */
async function readKnowledgeGraph(
  deps: DigitalEmployeeKnowledgeRoutesDeps,
  input: { employeeId: string; knowledgeBaseId: string }
): Promise<DigitalEmployeeKnowledgeGraph | null> {
  const client = deps.readClient?.()
  if (!client) return null
  try {
    const metadata = await client.fetchConceptMetadata(input.employeeId, input.knowledgeBaseId)
    if (!metadata) return null
    return buildKnowledgeGraph({ version: metadata.version, concepts: metadata.concepts })
  } catch {
    return null
  }
}

/**
 * 读单个概念的 markdown 正文：本地同步缓存优先，缺失时远端按需拉。
 *
 * 本地读不到（未同步 / 概念被清）不抛错，走远端兜底；远端也拿不到返回 null，
 * 由 UI 显示「内容不可用」。按需拉取只读、不进向量索引，不影响同步记账。
 */
async function readConceptContent(
  deps: DigitalEmployeeKnowledgeRoutesDeps,
  input: { employeeId: string; knowledgeBaseId: string; conceptId: string }
): Promise<{ content: string | null }> {
  if (deps.cacheDir) {
    const filePath = path.join(
      deps.cacheDir,
      deriveLocalKnowledgeBaseId(input.employeeId),
      conceptFilePath(input.conceptId)
    )
    try {
      return { content: await readFile(filePath, 'utf8') }
    } catch {
      // 缓存未命中，走远端兜底。
    }
  }
  const client = deps.readClient?.()
  if (!client) return { content: null }
  try {
    return {
      content: await client.fetchConcept(input.employeeId, input.knowledgeBaseId, input.conceptId)
    }
  } catch {
    return { content: null }
  }
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
    ],
    [
      digitalEmployeeKnowledgeGraphRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeKnowledgeGraphRoute.input.parse(rawInput)
        return digitalEmployeeKnowledgeGraphRoute.output.parse(
          await readKnowledgeGraph(deps, input)
        )
      }
    ],
    [
      digitalEmployeeKnowledgeConceptRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeKnowledgeConceptRoute.input.parse(rawInput)
        return digitalEmployeeKnowledgeConceptRoute.output.parse(
          await readConceptContent(deps, input)
        )
      }
    ]
  ])
}
