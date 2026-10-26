import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '../../../src/shared/types/mcp'
import {
  createKnowledgeToolRegistrar,
  type KnowledgeToolRegistrarDeps
} from '../../../src/main/digital-employee/knowledgeToolRegistration'
import { knowledgeServerNameForEmployee } from '../../../src/main/digital-employee/employeeScope'

/**
 * 每员工本地知识检索 server 的注册器。
 *
 * 与远端工具注册器同一套幂等纪律，但有两个本质差异：不需要连接凭证（纯本地），
 * 且员工没配知识库是常态而非故障——此时要清掉旧注册，而不是报错。
 */

const SERVER_NAME = knowledgeServerNameForEmployee('emp-1')

const harness = () => {
  const servers = new Map<string, MCPServerConfig>()
  const started: string[] = []
  const stopped: string[] = []
  const deps: KnowledgeToolRegistrarDeps = {
    mcpSettings: {
      getMcpServers: async () => Object.fromEntries(servers),
      addMcpServer: vi.fn(async (name: string, config: MCPServerConfig) => {
        servers.set(name, config)
        return true
      }),
      updateMcpServer: vi.fn(async (name: string, patch: Partial<MCPServerConfig>) => {
        servers.set(name, { ...servers.get(name), ...patch } as MCPServerConfig)
      }),
      removeMcpServer: vi.fn(async (name: string) => {
        servers.delete(name)
      })
    },
    serverManager: {
      startServer: vi.fn(async (name: string) => {
        started.push(name)
      }),
      stopServer: vi.fn(async (name: string) => {
        stopped.push(name)
      })
    }
  }
  return { deps, servers, started, stopped }
}

describe('knowledgeToolRegistrar', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('registers an in-memory server bound to the derived local base and starts it', async () => {
    const registrar = createKnowledgeToolRegistrar(h.deps)

    const result = await registrar.registerForEmployee({
      employeeId: 'emp-1',
      knowledgeBaseIds: ['kb_1']
    })

    expect(result).toEqual({ registered: true, started: true })
    const config = h.servers.get(SERVER_NAME)
    expect(config?.type).toBe('inmemory')
    expect(config?.enabled).toBe(true)
    // 本地库 id 必须走 deriveLocalKnowledgeBaseId 的规则，与服务端 kb_* id 无关。
    expect(config?.env?.localKnowledgeBaseId).toBe('de-emp-1')
    expect(h.started).toEqual([SERVER_NAME])
  })

  it('is idempotent: an unchanged registration is neither rewritten nor re-added', async () => {
    const registrar = createKnowledgeToolRegistrar(h.deps)
    await registrar.registerForEmployee({ employeeId: 'emp-1', knowledgeBaseIds: ['kb_1'] })
    const writesAfterFirst = h.deps.mcpSettings.addMcpServer.mock.calls.length

    // 与 staffdeck 注册器同一约定：配置没变就不重写（避免触发全量 MCP 重连），
    // 但 startServer 每轮都调，交给 serverManager 自己去重。
    const result = await registrar.registerForEmployee({
      employeeId: 'emp-1',
      knowledgeBaseIds: ['kb_1']
    })

    expect(result).toEqual({ registered: true, started: true })
    expect(h.deps.mcpSettings.addMcpServer).toHaveBeenCalledTimes(writesAfterFirst)
    expect(h.deps.mcpSettings.updateMcpServer).not.toHaveBeenCalled()
    expect(h.started).toContain(SERVER_NAME)
  })

  it('clears a stale registration when the employee no longer has knowledge bases', async () => {
    const registrar = createKnowledgeToolRegistrar(h.deps)
    await registrar.registerForEmployee({ employeeId: 'emp-1', knowledgeBaseIds: ['kb_1'] })

    const result = await registrar.registerForEmployee({
      employeeId: 'emp-1',
      knowledgeBaseIds: []
    })

    // 服务端把知识库配空是用户决策：本地工具必须跟着消失，否则模型还能查到
    // 已下线的知识。
    expect(result).toEqual({ registered: false, started: false, reason: 'NO_KNOWLEDGE' })
    expect(h.servers.has(SERVER_NAME)).toBe(false)
    expect(h.stopped).toEqual([SERVER_NAME])
  })

  it('reports REGISTER_FAILED instead of throwing when settings reject the write', async () => {
    h.deps.mcpSettings.addMcpServer = vi.fn(async () => {
      throw new Error('disk full')
    })
    const registrar = createKnowledgeToolRegistrar(h.deps)

    const result = await registrar.registerForEmployee({
      employeeId: 'emp-1',
      knowledgeBaseIds: ['kb_1']
    })

    expect(result).toEqual({ registered: false, started: false, reason: 'REGISTER_FAILED' })
  })

  it('keeps the registration and reports START_FAILED when the server cannot start', async () => {
    h.deps.serverManager.startServer = vi.fn(async () => {
      throw new Error('boom')
    })
    const registrar = createKnowledgeToolRegistrar(h.deps)

    const result = await registrar.registerForEmployee({
      employeeId: 'emp-1',
      knowledgeBaseIds: ['kb_1']
    })

    expect(result).toEqual({ registered: true, started: false, reason: 'START_FAILED' })
    expect(h.servers.has(SERVER_NAME)).toBe(true)
  })

  it('unregister removes only this feature’s server', async () => {
    h.servers.set(SERVER_NAME, { type: 'inmemory' } as MCPServerConfig)
    h.servers.set('user-server', { type: 'sse' } as MCPServerConfig)
    const registrar = createKnowledgeToolRegistrar(h.deps)

    await registrar.unregister('emp-1')

    expect(h.servers.has(SERVER_NAME)).toBe(false)
    expect(h.servers.has('user-server')).toBe(true)
  })
})
