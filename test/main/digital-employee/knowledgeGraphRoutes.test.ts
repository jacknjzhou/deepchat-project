import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  digitalEmployeeKnowledgeConceptRoute,
  digitalEmployeeKnowledgeGraphRoute
} from '../../../src/shared/contracts/routes/digitalEmployeeKnowledge.routes'
import { createDigitalEmployeeKnowledgeRoutes } from '../../../src/main/digital-employee/knowledgeRoutes'
import { createKnowledgeSyncStateStore } from '../../../src/main/digital-employee/knowledgeSyncState'
import { conceptFilePath } from '../../../src/main/digital-employee/knowledgeSync'
import type { StaffdeckKnowledgeClient } from '../../../src/main/digital-employee/knowledgeClient'

/**
 * 图谱与概念正文两条展示路由的降级语义：
 * - 图谱 null = 整包不可用（无连接 / 端点 404 / 网络失败），必须与空图区分；
 * - 正文本地缓存优先，远端按需拉只是兜底，失败收敛为 null 而不是错误。
 */

function stubClient(overrides: {
  metadata?: unknown | (() => unknown)
  concept?: (conceptId: string) => string | null
}): StaffdeckKnowledgeClient {
  return {
    fetchConceptMetadata: async () => {
      const value = overrides.metadata
      if (typeof value === 'function') return (value as () => unknown)()
      return value
    },
    fetchConcept: async (_e: string, _k: string, conceptId: string) =>
      overrides.concept ? overrides.concept(conceptId) : null
  } as unknown as StaffdeckKnowledgeClient
}

function createStore() {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: (key: string, value: unknown) => {
      data.set(key, value)
    }
  }
}

function emptyStateStore() {
  return createKnowledgeSyncStateStore({ settings: createStore() })
}

function handlerOf(routes: ReturnType<typeof createDigitalEmployeeKnowledgeRoutes>, name: string) {
  const handler = routes.get(name)
  if (!handler) throw new Error(`route ${name} is not registered`)
  return handler
}

describe('digitalEmployee.knowledgeGraph', () => {
  it('returns null when no client is available', async () => {
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: emptyStateStore() })

    const output = await handlerOf(routes, digitalEmployeeKnowledgeGraphRoute.name)({
      employeeId: 'agent_1',
      knowledgeBaseId: 'kb-1'
    })

    // null = 整包不可用；空数组会被误读成「概念存在但无链接」。
    expect(output).toBeNull()
    expect(digitalEmployeeKnowledgeGraphRoute.output.safeParse(output).success).toBe(true)
  })

  it('builds the graph from concept metadata and validates against the contract', async () => {
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: emptyStateStore(),
      readClient: () =>
        stubClient({
          metadata: {
            knowledgeBaseId: 'kb-1',
            version: 'v7',
            conceptCount: 2,
            concepts: [
              {
                conceptId: 'a',
                type: 'term',
                title: 'A',
                description: 'desc a',
                links: [
                  { label: 'to b', target: 'b.md' },
                  { label: 'out', target: 'https://example.com' },
                  { label: 'ghost', target: 'missing.md' }
                ]
              },
              { conceptId: 'b', type: 'term', title: 'B', description: '', links: [] }
            ]
          }
        })
    })

    const output = await handlerOf(routes, digitalEmployeeKnowledgeGraphRoute.name)({
      employeeId: 'agent_1',
      knowledgeBaseId: 'kb-1'
    })

    expect(output).toEqual({
      version: 'v7',
      truncated: false,
      concepts: [
        { conceptId: 'a', type: 'term', title: 'A', description: 'desc a', degree: 1 },
        { conceptId: 'b', type: 'term', title: 'B', description: '', degree: 1 }
      ],
      edges: [{ source: 'a', target: 'b' }]
    })
    expect(digitalEmployeeKnowledgeGraphRoute.output.safeParse(output).success).toBe(true)
    // 链接原文（label/target）是实现细节，契约只透出清洗后的边。
    expect(JSON.stringify(output)).not.toContain('https://example.com')
  })

  it('degrades to null when the fetch fails', async () => {
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: emptyStateStore(),
      readClient: () =>
        stubClient({
          metadata: () => {
            throw new Error('network down')
          }
        })
    })

    const output = await handlerOf(routes, digitalEmployeeKnowledgeGraphRoute.name)({
      employeeId: 'agent_1',
      knowledgeBaseId: 'kb-1'
    })

    // 展示端点的网络失败不能变成抽屉里的错误，降级为「暂不可用」。
    expect(output).toBeNull()
  })
})

describe('digitalEmployee.knowledgeConcept', () => {
  let cacheDir = ''

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'de-knowledge-routes-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('reads the synced local copy first without touching the remote', async () => {
    const localDir = path.join(cacheDir, 'de-agent_1')
    const filePath = path.join(localDir, conceptFilePath('sources/doc/sec-1'))
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '# 本地正文', 'utf8')
    let remoteCalled = false
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: emptyStateStore(),
      cacheDir,
      readClient: () =>
        stubClient({
          concept: () => {
            remoteCalled = true
            return 'remote'
          }
        })
    })

    const output = await handlerOf(routes, digitalEmployeeKnowledgeConceptRoute.name)({
      employeeId: 'agent_1',
      knowledgeBaseId: 'kb-1',
      conceptId: 'sources/doc/sec-1'
    })

    expect(output).toEqual({ content: '# 本地正文' })
    expect(remoteCalled).toBe(false)
    expect(digitalEmployeeKnowledgeConceptRoute.output.safeParse(output).success).toBe(true)
  })

  it('falls back to a remote read-only fetch when the cache misses', async () => {
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: emptyStateStore(),
      cacheDir,
      readClient: () => stubClient({ concept: (conceptId) => `remote:${conceptId}` })
    })

    const output = await handlerOf(routes, digitalEmployeeKnowledgeConceptRoute.name)({
      employeeId: 'agent_1',
      knowledgeBaseId: 'kb-1',
      conceptId: 'glossary'
    })

    expect(output).toEqual({ content: 'remote:glossary' })
  })

  it('returns null content when there is no cache, no client, or both fail', async () => {
    const withoutAnything = createDigitalEmployeeKnowledgeRoutes({ stateStore: emptyStateStore() })
    expect(
      await handlerOf(withoutAnything, digitalEmployeeKnowledgeConceptRoute.name)({
        employeeId: 'agent_1',
        knowledgeBaseId: 'kb-1',
        conceptId: 'glossary'
      })
    ).toEqual({ content: null })

    const withFailingClient = createDigitalEmployeeKnowledgeRoutes({
      stateStore: emptyStateStore(),
      cacheDir,
      readClient: () =>
        stubClient({
          concept: () => {
            throw new Error('network down')
          }
        })
    })
    expect(
      await handlerOf(withFailingClient, digitalEmployeeKnowledgeConceptRoute.name)({
        employeeId: 'agent_1',
        knowledgeBaseId: 'kb-1',
        conceptId: 'glossary'
      })
    ).toEqual({ content: null })
  })
})
