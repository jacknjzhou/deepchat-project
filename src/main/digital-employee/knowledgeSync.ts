import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeFileResult } from '../../../src/shared/types/knowledge'
import type { ConceptEntry, KnowledgeManifest, KnowledgePackage } from './knowledgeClient'
import { StaffdeckProblemError } from './remoteClient'
import { deriveLocalKnowledgeBaseId } from './knowledgeProvisioning'
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
  /**
   * 员工 SOP（`{title, content}`）。与知识清单无关：清单 304 时 SOP 也可能
   * 改过，所以每轮都随员工配置带进来做增量比对。
   */
  sops?: ReadonlyArray<{ title: string; content: string }>
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

/**
 * SOP 在本地库缓存里的相对路径：统一放 `sops/` 子目录，标题做文件名。
 *
 * 统一用 `/` 而不是 path.join：这个字符串同时是状态表的记账 key，必须跨
 * 平台稳定；fs API 在 Windows 上同样接受正斜杠。标题清洗后为空（如全空格）
 * 用固定名兜底；`.md` 后缀保证了清洗结果再奇怪也不会构成 `..` 逃逸。
 */
function sopFilePath(title: string): string {
  const name = sanitizeSegment(title.trim())
  return `sops/${name === '' ? 'sop' : name}.md`
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
      },
      // SOP 记账不属于任何包，包级写回必须原样带走，否则会被 zod 剥掉。
      sops: employeeState?.sops
    })

    return { ok: !failed, downloaded, reason: failed ? 'PARTIAL' : undefined }
  }

  /**
   * 把员工 SOP 增量写入本地库（`sops/` 子目录，标题做文件名）。
   *
   * 与概念的增量机制同构：per-SOP hash（title+content）比对记账，没变就
   * 一行文件都不动。SOP 不随清单走，所以这步在清单请求**之前**执行——
   * 清单 304 甚至失败时，SOP 也要保持最新。
   *
   * 返回建库失败的原因（整轮受阻）；`null` 表示无需处理或已成功。
   */
  const syncSopsIfNeeded = async (input: {
    employeeId: string
    sops: ReadonlyArray<{ title: string; content: string }>
    ensureProvisioned: () => Promise<ProvisioningResult>
  }): Promise<KnowledgeStaleReason | null> => {
    const previous = deps.stateStore.getEmployee(input.employeeId)?.sops ?? {}
    const hashOf = (sop: { title: string; content: string }) =>
      createHash('sha256').update(`${sop.title}\n${sop.content}`).digest('hex').slice(0, 16)

    // 重复标题在 Map 里后者覆盖前者：文件只有一份，内容与记账保持一致。
    const wanted = new Map<string, { hash: string; body: string }>()
    for (const sop of input.sops) {
      wanted.set(sopFilePath(sop.title), {
        hash: hashOf(sop),
        body: `${sop.title}\n\n${sop.content}`
      })
    }

    const changed = [...wanted].filter(([relPath, sop]) => previous[relPath]?.hash !== sop.hash)
    const removed = Object.keys(previous).filter((relPath) => !wanted.has(relPath))
    if (changed.length === 0 && removed.length === 0) return null

    const provisioned = await input.ensureProvisioned()
    if (!provisioned.ok) return provisioned.reason ?? 'NO_EMBEDDING_MODEL'
    const localKnowledgeBaseId = provisioned.knowledgeBaseId
    const localDir = path.join(deps.cacheDir, localKnowledgeBaseId)

    const working: Record<string, { hash: string; fileId: string }> = { ...previous }
    for (const relPath of removed) delete working[relPath]

    // 已下线的 SOP 从索引移除。删失败与概念同策略：不致命，孤儿向量留待重建索引。
    for (const relPath of removed) {
      const fileId = previous[relPath]?.fileId
      if (!fileId) continue
      try {
        await deps.knowledge.deleteFile(localKnowledgeBaseId, fileId)
      } catch {
        // 文件与记账已分家：下轮 hash 对不上会重写，不在这里重试。
      }
    }

    for (const [relPath, sop] of changed) {
      try {
        const target = path.join(localDir, relPath)
        await writeFileAtomic(target, sop.body)
        const existingFileId = previous[relPath]?.fileId
        const result = existingFileId
          ? await deps.knowledge.reAddFile(localKnowledgeBaseId, existingFileId)
          : await deps.knowledge.addFile(localKnowledgeBaseId, target)
        if (result.error || !result.data?.id) continue
        working[relPath] = { hash: sop.hash, fileId: result.data.id }
      } catch {
        // 索引失败不记账：记了下一轮就会以为已同步，永远补不上。
      }
    }

    const employeeState = deps.stateStore.getEmployee(input.employeeId)
    deps.stateStore.setEmployee(input.employeeId, {
      localKnowledgeBaseId: employeeState?.localKnowledgeBaseId ?? localKnowledgeBaseId,
      packages: employeeState?.packages ?? {},
      sops: working
    })
    return null
  }

  return {
    async syncEmployee(input) {
      const requested = new Set(input.knowledgeBaseIds.filter((id) => id !== ''))
      const previousEmployee = deps.stateStore.getEmployee(input.employeeId)

      // 员工名下没有任何 KB 就没必要打服务端：这是「员工未配知识」的常态。
      // SOP 检索也挂在这个闸门下——没有 KB 的员工不会注册检索工具，
      // 把 SOP 写进索引也无人能查，留着提示词注入即可。
      if (requested.size === 0) {
        return { ok: true, downloaded: 0, failedPackages: 0 }
      }

      // 建库是幂等的，SOP 与概念共用同一个本地库；只在第一处需要时建立。
      let provisioned: ProvisioningResult | null = null
      const ensureProvisioned = async (): Promise<ProvisioningResult> => {
        if (provisioned !== null) return provisioned
        const result = await deps.provision({
          employeeId: input.employeeId,
          employeeName: input.employeeName
        })
        if (result.ok) provisioned = result
        return result
      }

      // 派生规则升级会让状态表指向旧库：记账里的 fileId 全部失效，增量比对
      // 会把「已在旧库」的内容当成已同步而漏灌新库，reAddFile 也会拿着旧库
      // 的 fileId 打新库而永久失败。检测到基座 id 与当前派生值不一致就整条
      // 重置记账，本轮对新库做全量重灌；旧库留作孤儿，不再被任何入口寻址。
      const derivedKnowledgeBaseId = deriveLocalKnowledgeBaseId(input.employeeId)
      if (previousEmployee && previousEmployee.localKnowledgeBaseId !== derivedKnowledgeBaseId) {
        deps.stateStore.setEmployee(input.employeeId, {
          localKnowledgeBaseId: derivedKnowledgeBaseId,
          packages: {},
          sops: {}
        })
      }

      const sopReason = await syncSopsIfNeeded({
        employeeId: input.employeeId,
        sops: input.sops ?? [],
        ensureProvisioned
      })
      if (sopReason !== null) {
        // 没有嵌入模型就没有索引入口，SOP 与概念都进不去，整轮跳过。
        return { ok: true, downloaded: 0, failedPackages: 0, reason: sopReason }
      }

      let manifest: KnowledgeManifest | null
      try {
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

      const pkgProvisioned = await ensureProvisioned()
      if (!pkgProvisioned.ok) {
        // 没有嵌入模型就没有索引入口，下载了也进不去索引，故直接跳过。
        return { ok: true, downloaded: 0, failedPackages: 0, reason: pkgProvisioned.reason }
      }

      const localDir = path.join(deps.cacheDir, pkgProvisioned.knowledgeBaseId)
      let downloaded = 0
      let failedPackages = 0

      for (const pkg of targets) {
        const outcome = await syncPackage({
          employeeId: input.employeeId,
          localKnowledgeBaseId: pkgProvisioned.knowledgeBaseId,
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
