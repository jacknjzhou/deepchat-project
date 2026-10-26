import { describe, expect, it, vi } from 'vitest'
import { digitalEmployeeProvisionRoute } from '../../../src/shared/contracts/routes'
import { createDigitalEmployeeProvisioningRoutes } from '../../../src/main/digital-employee/provisioningRoutes'
import type {
  EmployeeProvisioningOutcome,
  ProvisioningSkipReason
} from '../../../src/main/digital-employee/provisioning'

/**
 * 准备路由的两件事：把准备结果摊平成 renderer 能直接渲染的字段，以及
 * 在准备工作成功时顺手触发首轮知识同步。
 *
 * 后者容易漏：同步没有自己的入口，全靠这个时机，否则用户要等完整一个间隔
 * （默认 1h）才检索得到知识。
 */

const outcome = (
  overrides: Partial<EmployeeProvisioningOutcome> = {}
): EmployeeProvisioningOutcome => ({
  employeeId: 'emp-1',
  skipped: null,
  mcp: { registered: true, started: true },
  skills: { installed: 2, failedSkills: [], failureReasons: {} },
  skillNames: ['de-emp-1-a', 'de-emp-1-b'],
  failures: [],
  ...overrides
})

function createHarness(
  options: {
    result?: EmployeeProvisioningOutcome
    skipped?: ProvisioningSkipReason
  } = {}
) {
  const provisionById = vi.fn(async () =>
    options.skipped
      ? outcome({ skipped: options.skipped, mcp: null, skills: null })
      : (options.result ?? outcome())
  )
  const triggerKnowledgeSync = vi.fn()

  const routes = createDigitalEmployeeProvisioningRoutes({
    provisioner: { provisionById } as never,
    triggerKnowledgeSync
  })

  return { routes, provisionById, triggerKnowledgeSync }
}

const call = async (
  harness: ReturnType<typeof createHarness>
): Promise<Record<string, unknown>> => {
  const handler = harness.routes.get(digitalEmployeeProvisionRoute.name)!
  return (await handler({ employeeId: 'emp-1' })) as Record<string, unknown>
}

describe('digitalEmployeeProvision route', () => {
  it('flattens the outcome into fields the renderer can render', async () => {
    const harness = createHarness()

    const result = await call(harness)

    expect(result).toMatchObject({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      installedSkills: 2,
      failedSkills: [],
      skillNames: ['de-emp-1-a', 'de-emp-1-b'],
      failures: []
    })
  })

  it('reports toolsReady false when registration succeeded but the server did not start', async () => {
    const harness = createHarness({
      result: outcome({ mcp: { registered: true, started: false, reason: 'START_FAILED' } })
    })

    const result = await call(harness)

    // 注册了但起不来，工具一个都用不了：说成「就绪」会让 P1-9 的提示失真。
    expect(result.toolsReady).toBe(false)
  })

  it('forwards per-skill failure reasons so the toast can tell users what to fix', async () => {
    const harness = createHarness({
      result: outcome({
        skills: { installed: 0, failedSkills: ['alpha'], failureReasons: { alpha: 'HTTP 401' } }
      })
    })

    const result = await call(harness)

    expect(result.failedSkills).toEqual(['alpha'])
    expect(result.failureReasons).toEqual({ alpha: 'HTTP 401' })
  })

  it('triggers the first-turn knowledge sync for a provisioned employee', async () => {
    const harness = createHarness()

    await call(harness)

    expect(harness.triggerKnowledgeSync).toHaveBeenCalledWith('emp-1')
  })

  it('does not sync for a remote employee, whose knowledge lives on the server', async () => {
    const harness = createHarness({ skipped: 'NOT_LOCAL' })

    await call(harness)

    expect(harness.triggerKnowledgeSync).not.toHaveBeenCalled()
  })

  it('does not sync against mock data, whose ids are fabricated', async () => {
    const harness = createHarness({ skipped: 'DEGRADED' })

    await call(harness)

    expect(harness.triggerKnowledgeSync).not.toHaveBeenCalled()
  })

  it('does not sync for an employee that no longer exists', async () => {
    const harness = createHarness({ skipped: 'NOT_FOUND' })

    await call(harness)

    expect(harness.triggerKnowledgeSync).not.toHaveBeenCalled()
  })

  it('still answers when no sync hook is wired', async () => {
    const routes = createDigitalEmployeeProvisioningRoutes({
      provisioner: { provisionById: vi.fn(async () => outcome()) } as never
    })
    const handler = routes.get(digitalEmployeeProvisionRoute.name)!

    // 钩子是可选的：没有连接或该员工没配知识库时，调用方根本不传它。
    await expect(handler({ employeeId: 'emp-1' })).resolves.toMatchObject({ toolsReady: true })
  })
})
