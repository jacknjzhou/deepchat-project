import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeFileResult } from '../../../src/shared/types/knowledge'
import type { ConceptEntry, KnowledgeManifest, KnowledgePackage } from './knowledgeClient'
import { StaffdeckProblemError } from './remoteClient'
import type { KnowledgeStaleReason } from './knowledgeSyncState'
import type { KnowledgeSyncStateStore } from './knowledgeSyncState'
import type { ProvisioningResult } from './knowledgeProvisioning'

/**
 * 知识同步编排：把 StaffDeck 分发的概念正文落到本地磁盘并进向量索引。
 *
 * 三条不可动摇的规则，都来自「同步绝不能拖垮会话」这一条上层约束：
 *
 * 1. **失败即降级**。旧副本与旧向量一律保留，只打 `stale` 标记。用户还能
 *    检索到过期内容，比检索不到强得多。
 * 2. **空清单不是错误**。服务端的同步开关默认关闭（`deepchat_sync_enabled`
 *    必须显式为 True），绝大多数租户的清单恒为空。这不是故障，不重试、不报错。
 * 3. **增量判据是 per-concept hash**。`configHash` 会因单概念变化而整体改变，
 *    只看它会导致每次都全量重拉。
 */

/** 下载并发上限：单轮同步打服务端不超 3 个并发，避免触发限流。 */
const DOWNLOAD_CONCURRENCY = 3

/**
 * 概念正文原样落盘，不拼 frontmatter。
 *
 * 索引器吃的是正文分块；塞 YAML frontmatter 会被当正文切进块，反而稀释检索
 * 命中率。概念元信息另有状态表记录，不需要写进文件。
 */
export interface KnowledgeSyncKnowledgePort {
  addFile(knowledgeBaseId: string, filePath: string): Promise<KnowledgeFileResult>
  reAddFile(knowledgeBaseId: string, fileId: string): Promise<KnowledgeFileResult>
  deleteFile(knowledgeBaseId: string, fileId: string): Promise<void>
}

export interface KnowledgeSyncClientPort {
  fetchManifest(employeeId: string, etag?: string | null): Promise<KnowledgeManifest | null>
  fetchConcept(
    employeeId: string,
    knowledgeBaseId: string,
    conceptId: string
  ): Promise<string | null>
}

export interface KnowledgeSyncDeps {
  stateStore: KnowledgeSyncStateStore
  client: KnowledgeSyncClientPort
  knowledge: KnowledgeSyncKnowledgePort
  /** 建库 / 选嵌入模型；关闭依赖注入以便单测不碰真实 provider。 */
  provision: (input: { employeeId: string; employeeName: string }) => Promise<ProvisioningResult>
  /** 概念 md 的缓存根目录：`{userData}/digital-employee-knowledge` */
  cacheDir: string
  now?: () => string
}

export interface KnowledgeSyncInput {
  employeeId: string
  employeeName: string
  knowledgeBaseIds: string[]
}

export interface KnowledgeSyncResult {
  ok: boolean
  /** 整轮被跳过的原因（如没有嵌入模型）；不阻塞会话。 */
  reason?: KnowledgeStaleReason
  /** 本轮实际下载的概念数，便于联调核对。 */
  downloaded: number
  /** 本轮失败的 KB 数。 */
  failedPackages: number
}

/**
 * conceptId → 落盘相对路径。
 *
 * 每个 `/` 段都过一遍清洗：`..` 逃逸、Windows 非法字符、空段都要处理，
 * 否则一个恶意或畸形的 conceptId 能写到缓存根目录之外。
 */
/**
 * Windows 文件名非法字符 + 控制字符统一替换。
 *
 * 控制字符用码点判断而不是正则字符类：`\u0000-\u001f` 写在字符类里会触发
 * `no-control-regex`，而且不同引擎对字面量控制符的转义处理不一致。
 */
const WINDOWS_ILLEGAL = new Set(['<', '>', ':', '"', '\\', '|', '?', '*'])

function sanitizeSegment(segment: string): string {
  let output = ''
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0
    output += code < 0x20 || WINDOWS_ILLEGAL.has(char) ? '_' : char
  }
  return output
}

export function conceptFilePath(conceptId: string): string {
  const segments = conceptId
    .split('/')
    .map((segment) => sanitizeSegment(segment.trim()))
    .map((segment) => (segment === '.' || segment === '..' ? '_' : segment))
    .filter((segment) => segment !== '')

  // 全被过滤掉时用 hash 兜底：路径必须稳定，不能因为清洗而塌成同一个空串。
  if (segments.length === 0) {
    return `${createHash('sha256').update(conceptId).digest('hex').slice(0, 16)}.md`
  }
  const last = segments[segments.length - 1]
  segments[segments.length - 1] = last.endsWith('.md') ? last : `${last}.md`
  return path.join(...segments)
}

/** 原子写：先写 `.tmp` 再 rename，避免半截文件被索引器读到。 */
async function writeFileAtomic(target: string, body: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, target)
}

const toStaleReason = (error: unknown): KnowledgeStaleReason => {
  if (error instanceof StaffdeckProblemError) {
    // 保留具体状态码：401（key 失效）和 500（服务端故障）的处置完全不同。
    return `HTTP_${error.status}`
  }
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && Number.isInteger(status) && status > 0) {
    return `HTTP_${status}`
  }
  return 'UNREACHABLE'
}

/** 按上限切分成若干批，供并发下载使用。 */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export interface KnowledgeSync {
  syncEmployee(input: KnowledgeSyncInput): Promise<KnowledgeSyncResult>
}

export function createKnowledgeSync(deps: KnowledgeSyncDeps): KnowledgeSync {
  const now = deps.now ?? (() => new Date().toISOString())

  /**
   * 单个 KB 的同步。返回是否成功；失败时已把该 KB 标 stale，
   * 但**不动**已完成的 hash 记账。
   */
  const syncPackage = async (input: {
    employeeId: string
    localKnowledgeBaseId: string
    localDir: string
    pkg: KnowledgePackage
    etag: string | null
    configVersion: string
  }): Promise<{ ok: boolean; downloaded: number; reason?: KnowledgeStaleReason }> => {
    const { employeeId, localKnowledgeBaseId, localDir, pkg, etag, configVersion } = input
    const previous = deps.stateStore.getEmployee(employeeId)?.packages[pkg.knowledgeBaseId]
    const previousConcepts = previous?.concepts ?? {}

    const remoteIds = new Set(pkg.concepts.map((concept) => concept.conceptId))
    const changed: ConceptEntry[] = pkg.concepts.filter(
      (concept) => previousConcepts[concept.conceptId]?.hash !== concept.hash
    )
    const removed = Object.keys(previousConcepts).filter((conceptId) => !remoteIds.has(conceptId))

    // 先搬状态表再动手：中途失败时 setEmployee 已在 finally 前写过一次中间态，
    // 这样「删掉的」不会残留、新下好的不会白下。
    const workingConcepts: Record<string, { hash: string; fileId: string }> = {
      ...previousConcepts
    }
    // 待删除的概念先从记账里摘掉，避免删文件失败后留下「文件没了但记账还在」。
    for (const conceptId of removed) delete workingConcepts[conceptId]

    let failed = false
    let downloaded = 0

    // 1) 删除服务端已移除的概念。删失败不算致命：下轮还会再试。
    for (const conceptId of removed) {
      const fileId = previousConcepts[conceptId]?.fileId
      if (!fileId) continue
      try {
        await deps.knowledge.deleteFile(localKnowledgeBaseId, fileId)
      } catch {
        failed = true
      }
    }

    // 2) 拉取变更的概念（限并发），落盘后进索引。
    for (const batch of chunk(changed, DOWNLOAD_CONCURRENCY)) {
      const settled = await Promise.all(
        batch.map(async (concept) => {
          try {
            const body = await deps.client.fetchConcept(
              employeeId,
              pkg.knowledgeBaseId,
              concept.conceptId
            )
            // null 表示清单生成后该概念被删，属正常竞态：跳过它，下一轮会从清单里消失。
            if (body === null) return { concept, body: null as string | null }
            const target = path.join(localDir, conceptFilePath(concept.conceptId))
            await writeFileAtomic(target, body)
            return { concept, body, target }
          } catch {
            return { concept, body: null as string | null }
          }
        })
      )

      for (const item of settled) {
        if (item.body === null || !item.target) {
          // 下载失败或竞态消失：记为失败，但绝不回滚已完成的兄弟概念。
          failed = true
          continue
        }
        const existingFileId = previousConcepts[item.concept.conceptId]?.fileId
        try {
          const result = existingFileId
            ? await deps.knowledge.reAddFile(localKnowledgeBaseId, existingFileId)
            : await deps.knowledge.addFile(localKnowledgeBaseId, item.target)
          if (result.error || !result.data?.id) {
            failed = true
            continue
          }
          workingConcepts[item.concept.conceptId] = {
            hash: item.concept.hash,
            fileId: result.data.id
          }
          downloaded += 1
        } catch {
          // 索引失败不记账：记了下一轮就会以为已同步，永远补不上。
          failed = true
        }
      }
    }

    // 3) 落状态。无论成败都写，保证「已完成的部分」不丢。
    const employeeState = deps.stateStore.getEmployee(employeeId)
    const localKnowledgeBaseIdForWrite = employeeState?.localKnowledgeBaseId ?? localKnowledgeBaseId
    deps.stateStore.setEmployee(employeeId, {
      localKnowledgeBaseId: localKnowledgeBaseIdForWrite,
      packages: {
        ...employeeState?.packages,
        [pkg.knowledgeBaseId]: {
          configVersion,
          configHash: pkg.configHash,
          etag,
          stale: failed,
          staleReason: failed ? 'PARTIAL' : null,
          lastSyncAt: now(),
          concepts: workingConcepts
        }
      }
    })

    return { ok: !failed, downloaded, reason: failed ? 'PARTIAL' : undefined }
  }

  return {
    async syncEmployee(input) {
      const requested = new Set(input.knowledgeBaseIds.filter((id) => id !== ''))
      const previousEmployee = deps.stateStore.getEmployee(input.employeeId)

      let manifest: KnowledgeManifest | null
      try {
        // 员工名下没有任何 KB 就没必要打服务端：这是「员工未配知识」的常态。
        if (requested.size === 0) {
          return { ok: true, downloaded: 0, failedPackages: 0 }
        }
        manifest = await deps.client.fetchManifest(
          input.employeeId,
          previousEmployee?.packages[
            // ETag 是仓库级的，用任一包的记录即可；这里取第一个已记录的包。
            Object.keys(previousEmployee?.packages ?? {})[0] ?? ''
          ]?.etag ?? null
        )
      } catch (error) {
        const reason = toStaleReason(error)
        // 连不上服务端：把所有已同步的 KB 标 stale，保留旧副本与旧向量。
        for (const knowledgeBaseId of requested) {
          deps.stateStore.markPackageStale(input.employeeId, knowledgeBaseId, reason)
        }
        return { ok: true, downloaded: 0, failedPackages: requested.size, reason }
      }

      // 304：清单没变，沿用本地状态，一个字节都不下。
      if (manifest === null) {
        return { ok: true, downloaded: 0, failedPackages: 0 }
      }

      const targets = manifest.packages.filter((pkg) => requested.has(pkg.knowledgeBaseId))
      // 空清单 / 无交集都是正常状态，不是错误。
      if (targets.length === 0) {
        return { ok: true, downloaded: 0, failedPackages: 0 }
      }

      const provisioned = await deps.provision({
        employeeId: input.employeeId,
        employeeName: input.employeeName
      })
      if (!provisioned.ok) {
        // 没有嵌入模型就没有索引入口，下载了也进不去索引，故直接跳过。
        return { ok: true, downloaded: 0, failedPackages: 0, reason: provisioned.reason }
      }

      const localDir = path.join(deps.cacheDir, provisioned.knowledgeBaseId)
      let downloaded = 0
      let failedPackages = 0

      for (const pkg of targets) {
        const outcome = await syncPackage({
          employeeId: input.employeeId,
          localKnowledgeBaseId: provisioned.knowledgeBaseId,
          localDir,
          pkg,
          etag: manifest.etag,
          configVersion: manifest.configVersion
        })
        downloaded += outcome.downloaded
        if (!outcome.ok) failedPackages += 1
      }

      return { ok: true, downloaded, failedPackages }
    }
  }
}
