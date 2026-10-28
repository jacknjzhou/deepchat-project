import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeBaseInfo,
  KnowledgePackage
} from '../../../src/main/digital-employee/knowledgeClient'
import {
  knowledgeStaleReasons,
  createKnowledgeSyncStateStore
} from '../../../src/main/digital-employee/knowledgeSyncState'
import {
  createKnowledgeSync,
  type KnowledgeSyncDeps
} from '../../../src/main/digital-employee/knowledgeSync'
import type { ProvisioningResult } from '../../../src/main/digital-employee/knowledgeProvisioning'
import type { KnowledgeFileResult } from '../../../src/shared/types/knowledge'

/**
 * Task 4 编排器的行为边界。
 *
 * 这批用例的重点不是「跑通」，而是四类最容易写错的地方：
 * 1. 空清单不是错误（服务端同步开关默认关闭，绝大多数租户的清单恒为空）；
 * 2. 增量判据是 per-concept hash，不是 configHash——单概念变化也会改 configHash；
 * 3. 失败必须降级：已完成的部分保留 + stale 标记，绝不回滚、绝不抛给会话；
 * 4. 落盘路径必须稳定且能容下带 `/` 的 conceptId。
 */

const EMPLOYEE_ID = 'agent_1'
const EMPLOYEE_NAME = '财务助手'
const LOCAL_KB_ID = 'de-agent_1'

interface Harness {
  deps: KnowledgeSyncDeps
  /** 远端概念正文，key 是 conceptId */
  bodies: Map<string, string>
  downloads: string[]
  calls: { add: string[]; reAdd: string[]; delete: string[] }
  cacheDir: string
  store: ReturnType<typeof createKnowledgeSyncStateStore>
  setPackages: (packages: KnowledgePackage[]) => void
  failDownloadFor: Set<string>
  addFileError: string | null
  provisionResult: ProvisioningResult
  provisionCalls: number
  /** 目录端点的返回值；null 表示端点抛错（未部署之外的故障）。 */
  catalog: KnowledgeBaseInfo[] | null
}

const makePackage = (
  overrides: Partial<KnowledgePackage> & { concepts: KnowledgePackage['concepts'] }
): KnowledgePackage => ({
  knowledgeBaseId: 'kb-1',
  name: '财务制度',
  version: '1',
  configHash: 'sha256:aaa',
  conceptCount: overrides.concepts.length,
  ...overrides
})

async function createHarness(cacheDir: string): Promise<Harness> {
  const settingsData = new Map<string, unknown>()
  const store = createKnowledgeSyncStateStore({
    settings: {
      get: <T>(key: string) => settingsData.get(key) as T | undefined,
      set: (key, value) => {
        settingsData.set(key, value)
      }
    }
  })

  let packages: KnowledgePackage[] = []
  const bodies = new Map<string, string>()
  const downloads: string[] = []
  const failDownloadFor = new Set<string>()
  const calls = { add: [] as string[], reAdd: [] as string[], delete: [] as string[] }

  const harness: Harness = {
    deps: undefined as unknown as KnowledgeSyncDeps,
    bodies,
    downloads,
    calls,
    cacheDir,
    store,
    setPackages: (next) => {
      packages = next
    },
    failDownloadFor,
    addFileError: null,
    provisionResult: { ok: true, knowledgeBaseId: LOCAL_KB_ID, created: true },
    provisionCalls: 0,
    catalog: []
  }

  harness.deps = {
    stateStore: store,
    cacheDir,
    now: () => '2026-10-23T00:00:00.000Z',
    client: {
      fetchManifest: async () => ({
        packages,
        configVersion: 'kv1:digest',
        etag: '"etag-1"'
      }),
      fetchConcept: async (_employeeId, _kbId, conceptId) => {
        downloads.push(conceptId)
        if (failDownloadFor.has(conceptId)) throw new Error('boom')
        return bodies.get(conceptId) ?? null
      },
      fetchKnowledgeBases: async () => {
        if (harness.catalog === null) throw new Error('catalog down')
        return harness.catalog
      }
    } as unknown as KnowledgeSyncDeps['client'],
    provision: async () => {
      harness.provisionCalls += 1
      return harness.provisionResult
    },
    knowledge: {
      addFile: async (_id, filePath): Promise<KnowledgeFileResult> => {
        calls.add.push(filePath)
        if (harness.addFileError) return { error: harness.addFileError }
        return { data: { id: `file-${calls.add.length}` } as never }
      },
      reAddFile: async (_id, fileId): Promise<KnowledgeFileResult> => {
        calls.reAdd.push(fileId)
        return { data: { id: fileId } as never }
      },
      deleteFile: async (_id, fileId) => {
        calls.delete.push(fileId)
      }
    }
  }

  return harness
}

const runSync = (
  harness: Harness,
  knowledgeBaseIds: string[] = ['kb-1'],
  sops: Array<{ title: string; content: string }> = []
) =>
  createKnowledgeSync(harness.deps).syncEmployee({
    employeeId: EMPLOYEE_ID,
    employeeName: EMPLOYEE_NAME,
    knowledgeBaseIds,
    sops
  })

describe('knowledgeSync', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'de-knowledge-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('rebuilds bookkeeping when the recorded base no longer matches the derived id', async () => {
    const harness = await createHarness(cacheDir)
    harness.store.setEmployee(EMPLOYEE_ID, {
      // 旧派生规则的记录：id 对不上当前派生值，记账里的 fileId 也不属于
      // 新库。不重置的话 hash 一致的概念会被当成已同步而漏灌新库。
      localKnowledgeBaseId: 'de-agent_1-legacy',
      packages: {
        'kb-1': {
          configVersion: 'kv1:digest',
          configHash: 'sha256:aaa',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: { 'c-1': { hash: 'sha256:same', fileId: 'file-old' } }
        }
      },
      sops: { 'sops/old.md': { hash: 'sha256:same-sop', fileId: 'file-old-sop' } }
    })
    harness.setPackages([
      makePackage({
        concepts: [{ conceptId: 'c-1', type: 'text', title: '制度', hash: 'sha256:same', size: 10 }]
      })
    ])
    harness.bodies.set('c-1', '正文')

    // SOP 的 hash 也与记账一致：重置前增量比对会认为什么都没变。
    const result = await runSync(harness, ['kb-1'], [{ title: 'old', content: '正文' }])

    expect(result.ok).toBe(true)
    expect(harness.downloads).toContain('c-1')
    expect(harness.calls.add.some((filePath) => filePath.includes('c-1'))).toBe(true)
    expect(harness.calls.add.some((filePath) => filePath.includes('sops'))).toBe(true)
    const state = harness.store.getEmployee(EMPLOYEE_ID)
    expect(state?.localKnowledgeBaseId).toBe(LOCAL_KB_ID)
  })

  it('does nothing at all when the manifest is empty', async () => {
    const harness = await createHarness(cacheDir)
    harness.setPackages([])

    const result = await runSync(harness)

    // 服务端同步开关默认关闭，空清单是最常见的正常状态：
    // 不建库、不标 stale、不报错，也不该写任何状态记录。
    expect(result.ok).toBe(true)
    expect(harness.provisionCalls).toBe(0)
    expect(harness.downloads).toEqual([])
    expect(harness.store.getEmployee(EMPLOYEE_ID)).toBeNull()
  })

  it('downloads and indexes every concept on the first run', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.bodies.set('b', '# B\n')
    harness.setPackages([
      makePackage({
        concepts: [
          { conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 },
          { conceptId: 'b', type: 'doc', title: 'B', hash: 'h-b', size: 4 }
        ]
      })
    ])

    const result = await runSync(harness)

    expect(result.ok).toBe(true)
    expect(harness.downloads.sort()).toEqual(['a', 'b'])
    expect(harness.calls.add).toHaveLength(2)
    const state = harness.store.getEmployee(EMPLOYEE_ID)
    expect(state?.localKnowledgeBaseId).toBe(LOCAL_KB_ID)
    expect(Object.keys(state?.packages['kb-1'].concepts ?? {}).sort()).toEqual(['a', 'b'])
  })

  it('re-downloads nothing when every hash is unchanged', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)
    harness.downloads.length = 0
    harness.calls.add.length = 0
    harness.calls.reAdd.length = 0

    await runSync(harness)

    // 增量判据是 per-concept hash：一次没变就一次都不该打服务端。
    expect(harness.downloads).toEqual([])
    expect(harness.calls.add).toEqual([])
    expect(harness.calls.reAdd).toEqual([])
  })

  it('re-adds only the concept whose hash changed', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A v1\n')
    harness.bodies.set('b', '# B\n')
    harness.setPackages([
      makePackage({
        concepts: [
          { conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a1', size: 7 },
          { conceptId: 'b', type: 'doc', title: 'B', hash: 'h-b', size: 4 }
        ]
      })
    ])
    await runSync(harness)
    const firstFileId =
      harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].concepts['a'].fileId
    harness.downloads.length = 0
    harness.calls.reAdd.length = 0

    harness.bodies.set('a', '# A v2\n')
    harness.setPackages([
      makePackage({
        concepts: [
          { conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a2', size: 7 },
          { conceptId: 'b', type: 'doc', title: 'B', hash: 'h-b', size: 4 }
        ]
      })
    ])
    await runSync(harness)

    expect(harness.downloads).toEqual(['a'])
    // 用原 fileId 原地重建，不新增文件（新增会留下孤儿向量）。
    expect(harness.calls.reAdd).toEqual([firstFileId])
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].concepts['a'].hash).toBe('h-a2')
  })

  it('deletes concepts the server dropped', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.bodies.set('b', '# B\n')
    harness.setPackages([
      makePackage({
        concepts: [
          { conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 },
          { conceptId: 'b', type: 'doc', title: 'B', hash: 'h-b', size: 4 }
        ]
      })
    ])
    await runSync(harness)
    const bFileId = harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].concepts['b'].fileId

    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)

    expect(harness.calls.delete).toEqual([bFileId])
    expect(
      Object.keys(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].concepts ?? {})
    ).toEqual(['a'])
  })

  it('marks the package stale but keeps finished work when a download fails', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.bodies.set('b', '# B\n')
    harness.failDownloadFor.add('b')
    harness.setPackages([
      makePackage({
        concepts: [
          { conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 },
          { conceptId: 'b', type: 'doc', title: 'B', hash: 'h-b', size: 4 }
        ]
      })
    ])

    const result = await runSync(harness)

    // 单概念失败不上升为整轮失败：会话不该因此中断。
    expect(result.ok).toBe(true)
    const state = harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1']
    expect(state?.stale).toBe(true)
    expect(state?.staleReason).toBe('PARTIAL')
    // 已成功的 a 必须留下来，否则每次失败都要重拉全部。
    expect(Object.keys(state?.concepts ?? {})).toEqual(['a'])
  })

  it('reuses the cached manifest on 304 without downloading anything', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)
    harness.downloads.length = 0

    // 304 由 client 返回 null 表达；上层必须沿用已记录的状态，而不是当成空清单。
    harness.deps.client.fetchManifest = async () => null
    const result = await runSync(harness)

    expect(result.ok).toBe(true)
    expect(harness.downloads).toEqual([])
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].stale).toBe(false)
  })

  it('ignores packages the employee is not bound to', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.bodies.set('x', '# X\n')
    harness.setPackages([
      makePackage({
        knowledgeBaseId: 'kb-1',
        concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }]
      }),
      makePackage({
        knowledgeBaseId: 'kb-other',
        concepts: [{ conceptId: 'x', type: 'doc', title: 'X', hash: 'h-x', size: 4 }]
      })
    ])

    await runSync(harness, ['kb-1'])

    // 只同步 knowledgeBaseIds 指向的 KB：租户里的其他知识不该被镜像到本机。
    expect(harness.downloads).toEqual(['a'])
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-other']).toBeUndefined()
  })

  it('keeps nested directories for concept ids containing slashes', async () => {
    const harness = await createHarness(cacheDir)
    const conceptId = 'sources/handbook/sections/sec-1'
    harness.bodies.set(conceptId, '# Sec\n')
    harness.setPackages([
      makePackage({
        concepts: [{ conceptId, type: 'doc', title: 'Sec', hash: 'h-1', size: 5 }]
      })
    ])

    await runSync(harness)

    const expected = path.join(cacheDir, LOCAL_KB_ID, 'sources', 'handbook', 'sections', 'sec-1.md')
    expect(harness.calls.add).toEqual([expected])
    await expect(readFile(expected, 'utf8')).resolves.toBe('# Sec\n')
  })

  it('writes the same path for the same concept across runs', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('sources/a', '# A\n')
    harness.setPackages([
      makePackage({
        concepts: [{ conceptId: 'sources/a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }]
      })
    ])
    await runSync(harness)
    const firstPath = harness.calls.add[0]

    harness.setPackages([
      makePackage({
        concepts: [{ conceptId: 'sources/a', type: 'doc', title: 'A', hash: 'h-a2', size: 4 }]
      })
    ])
    harness.bodies.set('sources/a', '# A v2\n')
    await runSync(harness)

    // 路径不稳定会在向量库里堆出同一概念的多个副本。
    const written = path.join(cacheDir, LOCAL_KB_ID, 'sources', 'a.md')
    expect(firstPath).toBe(written)
    await expect(readFile(written, 'utf8')).resolves.toBe('# A v2\n')
  })

  it('clears stale and updates lastSyncAt after a fully successful run', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.failDownloadFor.add('a')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].stale).toBe(true)

    harness.failDownloadFor.clear()
    await runSync(harness)

    const state = harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1']
    expect(state?.stale).toBe(false)
    expect(state?.staleReason).toBeNull()
    expect(state?.lastSyncAt).toBe('2026-10-23T00:00:00.000Z')
  })

  it('records a failed addFile without throwing the whole run', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.addFileError = 'disk full'
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])

    const result = await runSync(harness)

    expect(result.ok).toBe(true)
    const state = harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1']
    expect(state?.stale).toBe(true)
    // 索引失败的 hash 不能记账：记了下一轮就会以为已同步，永远补不上。
    expect(state?.concepts['a']).toBeUndefined()
  })

  it('does not create a knowledge base when no embedding model exists', async () => {
    const harness = await createHarness(cacheDir)
    harness.provisionResult = { ok: false, reason: 'NO_EMBEDDING_MODEL' }
    harness.bodies.set('a', '# A\n')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])

    const result = await runSync(harness)

    expect(result.ok).toBe(true)
    // 没有嵌入模型就没有索引落点，连下载都不该开始。
    expect(harness.downloads).toEqual([])
    expect(result.reason).toBe('NO_EMBEDDING_MODEL')
  })

  it('writes files atomically so half-written markdown never reaches the index', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])

    await runSync(harness)

    // 落盘目录里只允许留下最终的 .md：`.tmp` 残留意味着 rename 没走完。
    const dir = path.join(cacheDir, LOCAL_KB_ID)
    const entries = await readdir(dir)
    expect(entries).toEqual(['a.md'])
    const info = await stat(path.join(dir, 'a.md'))
    expect(info.isFile()).toBe(true)
  })

  it('marks the package stale with HTTP_<status> when the manifest request fails', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)

    const err = Object.assign(new Error('unauthorized'), { status: 401, code: 'UNAUTHORIZED' })
    harness.deps.client.fetchManifest = vi.fn(async () => {
      throw err
    })
    harness.downloads.length = 0

    const result = await runSync(harness)

    // 认证失败不能静默：保留旧副本，但必须让用户看到「知识可能过期」。
    expect(result.ok).toBe(true)
    expect(harness.downloads).toEqual([])
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].stale).toBe(true)
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].staleReason).toBe('HTTP_401')
  })

  it('persists catalog info into the package status', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.catalog = [
      {
        knowledgeBaseId: 'kb-1',
        name: '财务制度库',
        description: '报销与采购制度',
        version: '3',
        documentCount: 12,
        chunkCount: 345
      }
    ]
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])

    await runSync(harness)

    // 目录端点是纯展示增强：info 落盘后详情页才能显示名字而不是远端 id。
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].info).toEqual({
      name: '财务制度库',
      description: '报销与采购制度',
      version: '3',
      documentCount: 12,
      chunkCount: 345
    })
  })

  it('keeps the previous catalog info when the endpoint fails', async () => {
    const harness = await createHarness(cacheDir)
    harness.bodies.set('a', '# A\n')
    harness.catalog = [
      {
        knowledgeBaseId: 'kb-1',
        name: '财务制度库',
        description: '',
        version: '1',
        documentCount: 1,
        chunkCount: 1
      }
    ]
    harness.setPackages([
      makePackage({ concepts: [{ conceptId: 'a', type: 'doc', title: 'A', hash: 'h-a', size: 4 }] })
    ])
    await runSync(harness)

    harness.catalog = null
    const result = await runSync(harness)

    // 目录端点故障只损失展示字段，绝不能标 stale 或让同步轮失败。
    expect(result.ok).toBe(true)
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].stale).toBe(false)
    expect(harness.store.getEmployee(EMPLOYEE_ID)?.packages['kb-1'].info?.name).toBe('财务制度库')
  })

  it('exposes every stale reason the UI needs to render', () => {
    // 文案映射表按这个集合穷举；新增原因却忘了加文案会在渲染时露 key。
    expect([...knowledgeStaleReasons]).toEqual([
      'UNREACHABLE',
      'HTTP_ERROR',
      'PARTIAL',
      'NO_EMBEDDING_MODEL',
      'INDEX_FAILED'
    ])
  })

  it('writes sops into the local knowledge base even when the manifest is empty', async () => {
    const harness = await createHarness(cacheDir)
    harness.setPackages([])

    const result = await runSync(harness, ['kb-1'], [{ title: '报销流程', content: '先提交 OA' }])

    // SOP 与清单解耦：清单为空也必须把 SOP 送进可检索的本地库。
    expect(result.ok).toBe(true)
    expect(harness.provisionCalls).toBe(1)
    const sopPath = path.join(cacheDir, LOCAL_KB_ID, 'sops', '报销流程.md')
    expect(harness.calls.add).toEqual([sopPath])
    await expect(readFile(sopPath, 'utf8')).resolves.toBe('报销流程\n\n先提交 OA')
    const state = harness.store.getEmployee(EMPLOYEE_ID)
    expect(state?.sops?.['sops/报销流程.md']?.hash).toBeTruthy()
  })

  it('rewrites a sop in place only when its content changes', async () => {
    const harness = await createHarness(cacheDir)
    harness.setPackages([])
    await runSync(harness, ['kb-1'], [{ title: '报销流程', content: 'v1' }])
    const fileId = harness.store.getEmployee(EMPLOYEE_ID)?.sops?.['sops/报销流程.md']?.fileId
    harness.calls.add.length = 0
    harness.calls.reAdd.length = 0

    // 未变化的 SOP 不触发任何文件操作，也不重复建库。
    await runSync(harness, ['kb-1'], [{ title: '报销流程', content: 'v1' }])
    expect(harness.calls.add).toEqual([])
    expect(harness.calls.reAdd).toEqual([])

    // 内容变了：复用原 fileId 原地重建，文件正文同步更新。
    await runSync(harness, ['kb-1'], [{ title: '报销流程', content: 'v2' }])
    expect(harness.calls.reAdd).toEqual([fileId])
    const sopPath = path.join(cacheDir, LOCAL_KB_ID, 'sops', '报销流程.md')
    await expect(readFile(sopPath, 'utf8')).resolves.toBe('报销流程\n\nv2')
  })

  it('deletes sops the configuration removed', async () => {
    const harness = await createHarness(cacheDir)
    harness.setPackages([])
    await runSync(
      harness,
      ['kb-1'],
      [
        { title: '报销流程', content: 'a' },
        { title: '采购流程', content: 'b' }
      ]
    )
    const removedFileId = harness.store.getEmployee(EMPLOYEE_ID)?.sops?.['sops/采购流程.md']?.fileId

    await runSync(harness, ['kb-1'], [{ title: '报销流程', content: 'a' }])

    expect(harness.calls.delete).toEqual([removedFileId])
    expect(Object.keys(harness.store.getEmployee(EMPLOYEE_ID)?.sops ?? {})).toEqual([
      'sops/报销流程.md'
    ])
  })
})
