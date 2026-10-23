import { describe, expect, it } from 'vitest'
import {
  digitalEmployeeKnowledgeLocalBaseRoute,
  digitalEmployeeKnowledgeStatusRoute
} from '../../../src/shared/contracts/routes/digitalEmployeeKnowledge.routes'
import { createDigitalEmployeeKnowledgeRoutes } from '../../../src/main/digital-employee/knowledgeRoutes'
import { createKnowledgeSyncStateStore } from '../../../src/main/digital-employee/knowledgeSyncState'

/**
 * 状态查询只暴露「UI 需要渲染的那几个字段」。
 *
 * 刻意不返回 hash 表与本地路径：那些是实现细节，暴露出去后一旦改存储结构
 * 就会变成破坏性变更。
 */

function statusOf(
  routes: ReturnType<typeof createDigitalEmployeeKnowledgeRoutes>,
  employeeId: string
) {
  // 路由表现在按契约名索引，测试从这里取，避免另起一套调用方式。
  const handler = routes.get(digitalEmployeeKnowledgeStatusRoute.name)
  if (!handler) throw new Error('knowledge status route is not registered')
  return handler({ employeeId }) as Promise<{ packages: unknown[] }>
}

function createStore() {
  const data = new Map<string, unknown>()
  return createKnowledgeSyncStateStore({
    settings: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      set: (key, value) => {
        data.set(key, value)
      }
    }
  })
}

describe('digitalEmployee.knowledgeStatus', () => {
  it('returns an empty list when nothing has been synced', async () => {
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: createStore() })

    const output = await statusOf(routes, 'agent_1')

    // 未同步是正常状态：UI 不该因此显示错误。
    expect(output.packages).toEqual([])
    expect(digitalEmployeeKnowledgeStatusRoute.output.safeParse(output).success).toBe(true)
  })

  it('reports staleness per knowledge base without leaking internals', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {
        'kb-1': {
          configVersion: 'kv1:digest',
          configHash: 'sha256:aaa',
          etag: '"etag"',
          stale: true,
          staleReason: 'PARTIAL',
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: { a: { hash: 'h-a', fileId: 'file-1' } }
        }
      }
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: store })

    const output = await statusOf(routes, 'agent_1')

    expect(output.packages).toEqual([
      {
        knowledgeBaseId: 'kb-1',
        stale: true,
        staleReason: 'PARTIAL',
        lastSyncAt: '2026-10-23T00:00:00.000Z',
        conceptCount: 1
      }
    ])
    expect(digitalEmployeeKnowledgeStatusRoute.output.safeParse(output).success).toBe(true)
    // 本地库 id 与 fileId 属实现细节，不应出现在契约里。
    expect(JSON.stringify(output)).not.toContain('de-agent_1')
    expect(JSON.stringify(output)).not.toContain('file-1')
  })

  it('collapses unknown stale reasons so the renderer never shows a raw code', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {
        'kb-1': {
          configVersion: 'kv1:digest',
          configHash: 'sha256:aaa',
          etag: null,
          stale: true,
          staleReason: 'SOMETHING_NEW_FROM_THE_FUTURE',
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: {}
        }
      }
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: store })

    const output = await statusOf(routes, 'agent_1')

    // 未识别的码降级为 generic，否则新增原因会在界面上暴露原始字符串。
    expect(output.packages[0].staleReason).toBe('UNKNOWN')
  })

  it('keeps HTTP_<status> distinct so auth failures are diagnosable', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {
        'kb-1': {
          configVersion: '',
          configHash: '',
          etag: null,
          stale: true,
          staleReason: 'HTTP_401',
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: {}
        }
      }
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: store })

    // 401 与 500 的处置不同（重新授权 vs 等服务端恢复），不能糊成一个码。
    const output = await statusOf(routes, 'agent_1')

    expect(output.packages[0].staleReason).toBe('HTTP_401')
  })

  it('reports not-stale packages as clean', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {
        'kb-1': {
          configVersion: 'kv1:digest',
          configHash: 'sha256:aaa',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: { a: { hash: 'h-a', fileId: 'file-1' } }
        }
      }
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: store })

    const output = await statusOf(routes, 'agent_1')

    expect(output.packages[0].stale).toBe(false)
    expect(output.packages[0].staleReason).toBeNull()
  })
})

/**
 * 会话检索要的是「本地库 id」，与展示用的状态是两件事，所以单独一条路由。
 *
 * 这组用例的重点不是「能不能读到值」，而是「读出来的 id 必须真的能在本地
 * 命中一个知识库」——拿到一个查不到的 id 比拿不到更糟：`similarityQuery`
 * 会抛错，而 renderer 只能 catch 成空结果，故障会一直静默。
 */
describe('digitalEmployee.knowledgeLocalBase', () => {
  function localBaseOf(
    routes: ReturnType<typeof createDigitalEmployeeKnowledgeRoutes>,
    employeeId: string
  ) {
    const handler = routes.get(digitalEmployeeKnowledgeLocalBaseRoute.name)
    if (!handler) throw new Error('knowledge local base route is not registered')
    return handler({ employeeId }) as Promise<{ knowledgeBaseId: string | null }>
  }

  it('returns the id recorded by the last sync', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {
        'kb-1': {
          configVersion: 'kv1:digest',
          configHash: 'sha256:aaa',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: {}
        }
      }
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({ stateStore: store })

    const output = await localBaseOf(routes, 'agent_1')

    // 必须与原同步写入的 id 完全一致：它是 `KnowledgeSettings` 里的配置 id，
    // 差一个字符 similarityQuery 就抛 `Knowledge config not found`。
    expect(output).toEqual({ knowledgeBaseId: 'de-agent_1' })
    expect(digitalEmployeeKnowledgeLocalBaseRoute.output.safeParse(output).success).toBe(true)
  })

  it('derives the id when the state table is empty but the library still exists', async () => {
    // 状态表被清（config entry 损坏 / 手工删除）但向量库还在：不该强迫用户
    // 再等一整轮全量重索引才能检索。
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: createStore(),
      hasKnowledgeBase: (id) => id === 'de-agent_1'
    })

    expect(await localBaseOf(routes, 'agent_1')).toEqual({ knowledgeBaseId: 'de-agent_1' })
  })

  it('returns null when the library does not exist locally', async () => {
    // 未同步 / 无嵌入模型 / 用户在主设置里删了库：都表现为 null，由调用方跳过检索。
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: createStore(),
      hasKnowledgeBase: () => false
    })

    expect(await localBaseOf(routes, 'agent_1')).toEqual({ knowledgeBaseId: null })
  })

  it('returns null when the recorded library was deleted from settings', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {}
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: store,
      hasKnowledgeBase: () => false
    })

    // 状态表是历史记录，配置才是事实：用户删了库就以配置为准。
    expect(await localBaseOf(routes, 'agent_1')).toEqual({ knowledgeBaseId: null })
  })

  it('never leaks the remote knowledge base ids', async () => {
    const store = createStore()
    store.setEmployee('agent_1', {
      localKnowledgeBaseId: 'de-agent_1',
      packages: {}
    })
    const routes = createDigitalEmployeeKnowledgeRoutes({
      stateStore: store,
      hasKnowledgeBase: () => true
    })

    // 远端 `kb_*` 是另一套 id 空间，混进来会让调用方以为可以直接拿去检索。
    const output = await localBaseOf(routes, 'agent_1')
    expect(output.knowledgeBaseId).not.toMatch(/^kb/)
  })
})
