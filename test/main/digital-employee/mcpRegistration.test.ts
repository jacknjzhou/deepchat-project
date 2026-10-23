import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '../../../src/shared/types/mcp'
import {
  createStaffdeckMcpRegistrar,
  type StaffdeckMcpRegistrarDeps
} from '../../../src/main/digital-employee/mcpRegistration'
import { mcpServerNameForEmployee } from '../../../src/main/digital-employee/employeeScope'

/**
 * 远端工具的接入点。
 *
 * 这里只负责「把员工的 staffdeck_ 工具变成一个可连接的 MCP server」，
 * 不做工具白名单——那是会话层的事。分开的原因：白名单是每次会话的决策，
 * 注册是员工配置变化时的决策，混在一起会让两件事互相触发。
 */

type Harness = {
  deps: StaffdeckMcpRegistrarDeps
  servers: Map<string, MCPServerConfig>
  started: string[]
  stopped: string[]
}

function createHarness(
  overrides: Partial<StaffdeckMcpRegistrarDeps> = {},
  initial: Record<string, MCPServerConfig> = {}
): Harness {
  const servers = new Map<string, MCPServerConfig>(Object.entries(initial))
  const started: string[] = []
  const stopped: string[] = []

  const deps: StaffdeckMcpRegistrarDeps = {
    // 设置里存的是主机根（占位符 https://staffdeck.example.com），不含 /api/v1。
    getConnection: () => ({ baseUrl: 'http://staffdeck.test', apiKey: 'sd_live_abc' }),
    mcpSettings: {
      getMcpServers: async () => Object.fromEntries(servers),
      addMcpServer: async (name, config) => {
        servers.set(name, config)
        return true
      },
      removeMcpServer: async (name) => {
        servers.delete(name)
      },
      updateMcpServer: async (name, patch) => {
        const current = servers.get(name)
        if (!current) throw new Error('not found')
        servers.set(name, { ...current, ...patch })
      }
    },
    serverManager: {
      startServer: async (name) => {
        started.push(name)
        return 'connected'
      },
      stopServer: async (name) => {
        stopped.push(name)
      }
    },
    ...overrides
  }

  return {
    deps,
    servers,
    started,
    stopped
  }
}

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SERVER_NAME = mcpServerNameForEmployee(EMPLOYEE)

describe('registerForEmployee', () => {
  it('registers nothing when the employee has no staffdeck tools', async () => {
    const harness = createHarness()

    const result = await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: []
    })

    // 没有工具就没有理由把一个连上也是空的 server 挂进设置页。
    expect(result.registered).toBe(false)
    expect(harness.servers.size).toBe(0)
    expect(harness.started).toEqual([])
  })

  it('ignores tools that are not in the staffdeck namespace', async () => {
    const harness = createHarness()

    const result = await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['web_search', 'staffdeck_expense_submit']
    })

    expect(result.registered).toBe(true)
    expect(harness.servers.has(SERVER_NAME)).toBe(true)
  })

  it('registers an http server pointing at the employee-addressed endpoint', async () => {
    const harness = createHarness()

    await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })

    const config = harness.servers.get(SERVER_NAME)
    expect(config?.type).toBe('http')
    // 必须带路径段：标准 MCP 客户端只会发 tools/list 的 {}，无法注入 _meta，
    // 服务端只能从 URL 认出是哪个员工。
    // `/api/v1` 是客户端自己拼的（设置里只有主机根），漏了它每次 initialize 都是 404。
    expect(config?.baseUrl).toBe(`http://staffdeck.test/api/v1/mcp/agents/${EMPLOYEE}`)
    expect(config?.enabled).toBe(true)
  })

  it('sends the api key as a bearer header and never in the url', async () => {
    const harness = createHarness()

    await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })

    const config = harness.servers.get(SERVER_NAME)
    expect(config?.customHeaders?.Authorization).toBe('Bearer sd_live_abc')
    // 密钥进 query string 会出现在审计日志与报错截图里。
    expect(JSON.stringify(config)).not.toContain('sd_live_abc?')
    expect(config?.baseUrl).not.toContain('sd_live')
  })

  it('starts the server after registering', async () => {
    const harness = createHarness()

    const result = await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })

    expect(harness.started).toEqual([SERVER_NAME])
    expect(result.registered).toBe(true)
  })

  it('is idempotent: an unchanged registration is not rewritten', async () => {
    const harness = createHarness()
    const registrar = createStaffdeckMcpRegistrar(harness.deps)
    const input = { employeeId: EMPLOYEE, tools: ['staffdeck_expense_submit'] }

    await registrar.registerForEmployee(input)
    const addSpy = vi.spyOn(harness.deps.mcpSettings, 'addMcpServer')
    await registrar.registerForEmployee(input)

    // 每次会话都重写一遍设置会触发 MCP 全量重连，对话中途工具列表闪断。
    expect(addSpy).not.toHaveBeenCalled()
    expect(harness.started).toEqual([SERVER_NAME, SERVER_NAME])
  })

  it('rewrites the registration when the api key changes', async () => {
    let apiKey = 'sd_live_old'
    const harness = createHarness({ getConnection: () => ({ baseUrl: 'http://x', apiKey }) })
    const registrar = createStaffdeckMcpRegistrar(harness.deps)
    const input = { employeeId: EMPLOYEE, tools: ['staffdeck_a'] }

    await registrar.registerForEmployee(input)
    apiKey = 'sd_live_new'
    await registrar.registerForEmployee(input)

    expect(harness.servers.get(SERVER_NAME)?.customHeaders?.Authorization).toBe(
      'Bearer sd_live_new'
    )
  })

  it('clears a stale registration when the connection is no longer configured', async () => {
    const harness = createHarness({ getConnection: () => null })

    const result = await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })

    expect(result.registered).toBe(false)
    expect(result.reason).toBe('NOT_CONFIGURED')
    // 留着旧配置等于把失效的密钥持续发给服务端。
    expect(harness.servers.size).toBe(0)
  })

  it('removes the registration once the employee no longer has tools', async () => {
    const harness = createHarness()
    const registrar = createStaffdeckMcpRegistrar(harness.deps)

    await registrar.registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })
    await registrar.registerForEmployee({ employeeId: EMPLOYEE, tools: [] })

    expect(harness.servers.has(SERVER_NAME)).toBe(false)
    expect(harness.stopped).toContain(SERVER_NAME)
  })

  it('reports a start failure without throwing', async () => {
    const harness = createHarness({
      serverManager: {
        startServer: async () => {
          throw new Error('connect refused')
        },
        stopServer: async () => undefined
      }
    })

    const result = await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })

    // 服务端不可达时对话仍要能继续，只是没有远端工具。
    expect(result.registered).toBe(true)
    expect(result.started).toBe(false)
    expect(result.reason).toBe('START_FAILED')
  })

  it('never removes a server the user configured themselves', async () => {
    const harness = createHarness({}, {
      'my-own-server': {
        command: 'npx',
        args: [],
        env: {},
        descriptions: '',
        icons: '',
        enabled: true,
        type: 'stdio'
      }
    })

    const registrar = createStaffdeckMcpRegistrar(harness.deps)
    await registrar.registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_expense_submit']
    })
    await registrar.registerForEmployee({ employeeId: EMPLOYEE, tools: [] })

    expect(harness.servers.has('my-own-server')).toBe(true)
  })
})

describe('unregister', () => {
  it('stops and removes only the given employee server', async () => {
    const harness = createHarness()
    const registrar = createStaffdeckMcpRegistrar(harness.deps)
    await registrar.registerForEmployee({ employeeId: EMPLOYEE, tools: ['staffdeck_a'] })
    await registrar.registerForEmployee({ employeeId: 'other', tools: ['staffdeck_b'] })

    await registrar.unregister(EMPLOYEE)

    expect(harness.servers.has(SERVER_NAME)).toBe(false)
    expect(harness.servers.has(mcpServerNameForEmployee('other'))).toBe(true)
  })

  it('is a no-op when nothing was registered', async () => {
    const harness = createHarness()

    await expect(createStaffdeckMcpRegistrar(harness.deps).unregister('never')).resolves.toBe(
      undefined
    )
    expect(harness.stopped).toEqual([])
  })
})

describe('base url handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the api version segment that the setting does not carry', async () => {
    // 设置页的占位符是 `https://staffdeck.example.com`，即主机根。`/api/v1`
    // 属于客户端知识；照搬 baseUrl 会得到 `/mcp/agents/...` 的 404。
    const harness = createHarness({
      getConnection: () => ({ baseUrl: 'http://staffdeck.test/', apiKey: 'k' })
    })

    await createStaffdeckMcpRegistrar(harness.deps).registerForEmployee({
      employeeId: EMPLOYEE,
      tools: ['staffdeck_a']
    })

    expect(harness.servers.get(SERVER_NAME)?.baseUrl).toBe(
      `http://staffdeck.test/api/v1/mcp/agents/${EMPLOYEE}`
    )
  })
})
