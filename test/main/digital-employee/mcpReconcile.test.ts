import { describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '../../../src/shared/types/mcp'
import {
  createStaffdeckMcpReconciler,
  type StaffdeckMcpReconcileDeps
} from '../../../src/main/digital-employee/mcpReconcile'
import { mcpServerNameForEmployee } from '../../../src/main/digital-employee/employeeScope'

const serverConfig = (name: string): MCPServerConfig => ({
  command: '',
  args: [],
  env: {},
  descriptions: '',
  icons: '',
  enabled: true,
  type: 'http',
  baseUrl: `https://staffdeck.test/api/v1/mcp/agents/${name}`,
  customHeaders: { Authorization: 'Bearer k' }
})

function createHarness(overrides: Partial<StaffdeckMcpReconcileDeps> = {}) {
  const removed: string[] = []
  const stopped: string[] = []

  const deps: StaffdeckMcpReconcileDeps = {
    mcpSettings: {
      getMcpServers: vi.fn(async () => ({}) as Record<string, MCPServerConfig>),
      removeMcpServer: vi.fn(async (name: string) => {
        removed.push(name)
      })
    },
    stopServer: vi.fn(async (name: string) => {
      stopped.push(name)
    }),
    mcpServerNameFor: mcpServerNameForEmployee,
    listLocalEmployeeIds: vi.fn(async () => ['emp-keep']),
    ...overrides
  }

  return { deps, removed, stopped }
}

describe('staffdeck MCP registration reconcile', () => {
  it('removes a registration whose employee is gone', async () => {
    const gone = mcpServerNameForEmployee('emp-gone')
    const harness = createHarness({
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [gone]: serverConfig(gone) })),
        removeMcpServer: vi.fn(async (name: string) => {
          harness.removed.push(name)
        })
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    expect(result.removed).toEqual([gone])
    expect(result.skipped).toBe(false)
    // 先停再删：只删配置会让进程里的连接悬着，工具仍出现在缓存里。
    expect(harness.stopped).toEqual([gone])
  })

  it('leaves the registration of a still-existing employee alone', async () => {
    const kept = mcpServerNameForEmployee('emp-keep')
    const harness = createHarness({
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [kept]: serverConfig(kept) })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    expect(result.removed).toEqual([])
    expect(harness.deps.mcpSettings.removeMcpServer).not.toHaveBeenCalled()
    // 在册的员工不能白停一次，那会让进行中的对话掉工具。
    expect(harness.stopped).toEqual([])
  })

  it('never touches a server the user configured by hand', async () => {
    const harness = createHarness({
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({
          'my-local-tools': serverConfig('local'),
          'filesystem': serverConfig('fs')
        })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    // 前缀是唯一的归属判据；用户自建的 server 一个都不动。
    expect(result.removed).toEqual([])
    expect(harness.deps.mcpSettings.removeMcpServer).not.toHaveBeenCalled()
  })

  it('claims any name under its own prefix, even one no employee produced', async () => {
    const orphan = 'staffdeck-renamed-by-hand'
    const harness = createHarness({
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [orphan]: serverConfig('x') })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    // 前缀即归属：无法反解到员工的名字同样要清，否则它会永久残留。
    expect(result.removed).toEqual([orphan])
  })

  it('skips the whole round when the employee list is not trustworthy', async () => {
    const gone = mcpServerNameForEmployee('emp-gone')
    const harness = createHarness({
      listLocalEmployeeIds: vi.fn(async () => null),
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [gone]: serverConfig(gone) })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    // provider 降级到 mock 时列表里是假 id，按它删会把真实注册全删光。
    expect(result).toEqual({ removed: [], skipped: true })
    expect(harness.deps.mcpSettings.removeMcpServer).not.toHaveBeenCalled()
  })

  it('treats a failed employee lookup the same as an untrustworthy one', async () => {
    const gone = mcpServerNameForEmployee('emp-gone')
    const harness = createHarness({
      listLocalEmployeeIds: vi.fn(async () => {
        throw new Error('network down')
      }),
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [gone]: serverConfig(gone) })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    expect(result.skipped).toBe(true)
    expect(harness.deps.mcpSettings.removeMcpServer).not.toHaveBeenCalled()
  })

  it('does nothing at all when there are no registrations', async () => {
    const harness = createHarness({
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({})),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    expect(result).toEqual({ removed: [], skipped: false })
    expect(harness.stopped).toEqual([])
  })

  it('keeps going when stopping one server fails', async () => {
    const first = mcpServerNameForEmployee('emp-a')
    const second = mcpServerNameForEmployee('emp-b')
    const harness = createHarness({
      stopServer: vi.fn(async (name: string) => {
        if (name === first) throw new Error('already stopped')
        harness.stopped.push(name)
      }),
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({
          [first]: serverConfig(first),
          [second]: serverConfig(second)
        })),
        removeMcpServer: vi.fn(async (name: string) => {
          harness.removed.push(name)
        })
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    // 停不掉一个就放弃其余的，会让另一个孤儿永久残留。
    expect(result.removed).toEqual([first, second])
  })

  it('keeps two employees whose ids normalise alike apart', async () => {
    const a = mcpServerNameForEmployee('a:b')
    const b = mcpServerNameForEmployee('a/b')
    const harness = createHarness({
      listLocalEmployeeIds: vi.fn(async () => ['a:b']),
      mcpSettings: {
        getMcpServers: vi.fn(async () => ({ [a]: serverConfig(a), [b]: serverConfig(b) })),
        removeMcpServer: vi.fn(async () => undefined)
      }
    })

    const result = await createStaffdeckMcpReconciler(harness.deps)()

    // 规范化是多对一的，摘要才是区分依据：删一个不能把另一个带走。
    expect(result.removed).toEqual([b])
    expect(harness.deps.mcpSettings.removeMcpServer).toHaveBeenCalledWith(b)
    expect(harness.deps.mcpSettings.removeMcpServer).not.toHaveBeenCalledWith(a)
  })
})
