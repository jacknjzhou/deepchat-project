import { describe, expect, it, vi } from 'vitest'
import type { DigitalEmployee } from '../../../src/shared/contracts/routes'
import {
  createEmployeeProvisioner,
  type EmployeeProvisionerDeps,
  type EmployeeProvisioningTarget
} from '../../../src/main/digital-employee/provisioning'
import type { StaffdeckMcpRegisterResult } from '../../../src/main/digital-employee/mcpRegistration'
import type { StaffdeckSkillSyncResult } from '../../../src/main/digital-employee/skillSync'
import type { KnowledgeToolRegisterResult } from '../../../src/main/digital-employee/knowledgeToolRegistration'

/**
 * 员工本地执行前的准备工作。
 *
 * 两条链路（远端工具、技能包）在这里汇合，但只是汇合，不是耦合：任一条失败
 * 都不影响另一条，也都不阻塞会话。这个文件测的就是这层「编排 + 隔离」，
 * 单条链路的细节由 mcpRegistration / skillSync 各自的测试覆盖。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'

const employee = (overrides: Partial<DigitalEmployee> = {}): DigitalEmployee => ({
  id: EMPLOYEE,
  name: '财务',
  role: '财务',
  description: '',
  avatar: null,
  capabilities: [],
  greeting: null,
  systemPrompt: '# 角色',
  sops: [],
  knowledgeBaseIds: ['kb_1'],
  skillIds: [],
  tools: ['staffdeck_expense_submit'],
  enabled: true,
  updatedAt: '2026-10-23T00:00:00.000Z',
  executionMode: 'local',
  skills: [{ id: 'sk_1', name: 'staffdeck-api', slug: 'staffdeck-api', downloadUrl: 'x' }],
  ...overrides
})

type Harness = {
  deps: EmployeeProvisionerDeps
  registered: Array<{ employeeId: string; tools: readonly string[] }>
  unregistered: string[]
  synced: Array<{ employeeId: string; slugs: string[] }>
  knowledgeRegistered: Array<{ employeeId: string; knowledgeBaseIds: readonly string[] }>
  knowledgeUnregistered: string[]
}

function createHarness(
  options: {
    employees?: DigitalEmployee[]
    source?: 'http' | 'mock'
    registerResult?: StaffdeckMcpRegisterResult
    registerError?: Error
    skillResult?: StaffdeckSkillSyncResult
    skillError?: Error
    knowledgeResult?: KnowledgeToolRegisterResult
    knowledgeError?: Error
  } = {}
): Harness {
  const registered: Harness['registered'] = []
  const unregistered: string[] = []
  const synced: Harness['synced'] = []
  const knowledgeRegistered: Harness['knowledgeRegistered'] = []
  const knowledgeUnregistered: string[] = []

  const listed = options.employees ?? [employee()]

  const deps: EmployeeProvisionerDeps = {
    getEmployee: async (employeeId) => listed.find((item) => item.id === employeeId) ?? null,
    source: () => options.source ?? 'http',
    registrar: {
      registerForEmployee: async (input) => {
        registered.push(input)
        if (options.registerError) throw options.registerError
        return options.registerResult ?? { registered: true, started: true }
      },
      unregister: async (employeeId) => {
        unregistered.push(employeeId)
      }
    },
    skillSync: {
      syncEmployee: async (input) => {
        synced.push({ employeeId: input.employeeId, slugs: input.skills.map((s) => s.slug) })
        if (options.skillError) throw options.skillError
        return (
          options.skillResult ?? {
            ok: true,
            installed: input.skills.length,
            failedSkills: [],
            failureReasons: {}
          }
        )
      }
    },
    knowledgeRegistrar: {
      registerForEmployee: async (input) => {
        knowledgeRegistered.push(input)
        if (options.knowledgeError) throw options.knowledgeError
        return options.knowledgeResult ?? { registered: true, started: true }
      },
      unregister: async (employeeId) => {
        knowledgeUnregistered.push(employeeId)
      }
    }
  }

  return { deps, registered, unregistered, synced, knowledgeRegistered, knowledgeUnregistered }
}

const target = (
  overrides: Partial<EmployeeProvisioningTarget> = {}
): EmployeeProvisioningTarget => ({
  id: EMPLOYEE,
  executionMode: 'local',
  tools: ['staffdeck_expense_submit'],
  knowledgeBaseIds: ['kb_1'],
  skills: [{ id: 'sk_1', name: 'staffdeck-api', slug: 'staffdeck-api', downloadUrl: 'x' }],
  ...overrides
})

describe('provisioner gating', () => {
  it('registers tools and installs skills for a local employee', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(harness.registered).toEqual([
      { employeeId: EMPLOYEE, tools: ['staffdeck_expense_submit'] }
    ])
    expect(harness.synced).toEqual([{ employeeId: EMPLOYEE, slugs: ['staffdeck-api'] }])
    expect(outcome.skipped).toBeNull()
    expect(outcome.mcp?.registered).toBe(true)
    expect(outcome.skills?.ok).toBe(true)
  })

  it('treats hybrid like local', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target({ executionMode: 'hybrid' }))

    expect(outcome.skipped).toBeNull()
    expect(harness.registered).toHaveLength(1)
    expect(harness.synced).toHaveLength(1)
  })

  it('never provisions a remote employee, and clears any leftover registration', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target({ executionMode: 'remote' }))

    expect(outcome.skipped).toBe('NOT_LOCAL')
    expect(harness.registered).toHaveLength(0)
    expect(harness.synced).toHaveLength(0)
    // A server left over from when this employee ran locally would keep feeding
    // its remote tools into every other conversation's tool list.
    expect(harness.unregistered).toEqual([EMPLOYEE])
    expect(harness.knowledgeUnregistered).toEqual([EMPLOYEE])
  })

  it('skips mock employees, whose tools and skills are fabricated', async () => {
    const harness = createHarness({ source: 'mock' })
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(outcome.skipped).toBe('DEGRADED')
    expect(harness.registered).toHaveLength(0)
    expect(harness.synced).toHaveLength(0)
  })

  it('registers the local knowledge tool when the employee has knowledge bases', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(harness.knowledgeRegistered).toEqual([
      { employeeId: EMPLOYEE, knowledgeBaseIds: ['kb_1'] }
    ])
    expect(outcome.knowledgeTool).toEqual({ registered: true, started: true })
  })

  it('passes empty knowledgeBaseIds through to the knowledge registrar', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target({ knowledgeBaseIds: [] }))

    // 清不清注册由注册器自己决定（没配知识库是常态而非故障）；编排层只负责透传。
    expect(harness.knowledgeRegistered).toEqual([{ employeeId: EMPLOYEE, knowledgeBaseIds: [] }])
    expect(outcome.knowledgeTool).toEqual({ registered: true, started: true })
  })
})

describe('provisioner failure isolation', () => {
  it('still installs skills when tool registration throws', async () => {
    const harness = createHarness({ registerError: new Error('boom') })
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(outcome.mcp).toBeNull()
    expect(outcome.failures).toContain('mcp')
    expect(outcome.skills?.ok).toBe(true)
  })

  it('keeps the tool registration when skill sync throws', async () => {
    const harness = createHarness({ skillError: new Error('boom') })
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(outcome.mcp?.registered).toBe(true)
    expect(outcome.skills).toBeNull()
    expect(outcome.failures).toContain('skills')
  })

  it('still registers tools and skills when the knowledge chain throws', async () => {
    const harness = createHarness({ knowledgeError: new Error('boom') })
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provision(target())

    expect(outcome.knowledgeTool).toBeNull()
    expect(outcome.failures).toContain('knowledgeTool')
    expect(outcome.mcp?.registered).toBe(true)
    expect(outcome.skills?.ok).toBe(true)
  })

  it('never rejects, even when both chains throw', async () => {
    const harness = createHarness({
      registerError: new Error('no network'),
      skillError: new Error('no network')
    })
    const provisioner = createEmployeeProvisioner(harness.deps)

    await expect(provisioner.provision(target())).resolves.toBeTruthy()
  })
})

describe('provisioner concurrency', () => {
  it('runs one round for concurrent opens of the same employee', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    await Promise.all([
      provisioner.provision(target()),
      provisioner.provision(target()),
      provisioner.provision(target())
    ])

    expect(harness.registered).toHaveLength(1)
    expect(harness.synced).toHaveLength(1)
  })

  it('does not serialise different employees behind each other', async () => {
    const other = employee({ id: 'agent_other', name: '人事' })
    const harness = createHarness({ employees: [employee(), other] })
    const provisioner = createEmployeeProvisioner(harness.deps)

    await Promise.all([
      provisioner.provision(target()),
      provisioner.provision(target({ id: 'agent_other' }))
    ])

    // Sorted: 'agent_f...' sorts before 'agent_o...'.
    expect(harness.registered.map((item) => item.employeeId).sort()).toEqual([
      EMPLOYEE,
      'agent_other'
    ])
  })

  it('starts a fresh round after reset, for a changed configuration', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    await provisioner.provision(target())
    provisioner.reset()
    await provisioner.provision(target())

    // Registration itself is idempotent, so running twice is only about making
    // sure a stale in-flight promise never answers for new credentials.
    expect(harness.registered).toHaveLength(2)
  })

  it('re-runs on every call once the previous round settled', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    await provisioner.provision(target())
    await provisioner.provision(target())

    expect(harness.registered).toHaveLength(2)
  })
})

describe('provisionById', () => {
  it('resolves the employee through the provider before provisioning', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provisionById(EMPLOYEE)

    expect(outcome.skipped).toBeNull()
    expect(harness.registered).toHaveLength(1)
    expect(harness.synced[0]?.slugs).toEqual(['staffdeck-api'])
  })

  it('reports NOT_FOUND instead of throwing for an unknown id', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provisionById('agent_missing')

    expect(outcome.skipped).toBe('NOT_FOUND')
    expect(harness.registered).toHaveLength(0)
  })

  it('reports NOT_FOUND when listing the employees fails', async () => {
    const harness = createHarness()
    harness.deps.getEmployee = async () => {
      throw new Error('HTTP 401')
    }
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provisionById(EMPLOYEE)

    expect(outcome.skipped).toBe('NOT_FOUND')
  })

  it('passes distributed skills through unchanged, ignoring downloadUrl', async () => {
    const harness = createHarness()
    const provisioner = createEmployeeProvisioner(harness.deps)

    await provisioner.provisionById(EMPLOYEE)

    expect(harness.synced[0]?.slugs).toEqual(['staffdeck-api'])
  })

  it('does not call the registrar twice for one provisionById round', async () => {
    const spy = vi.fn()
    const harness = createHarness()
    harness.deps.getEmployee = async (employeeId: string) => {
      spy(employeeId)
      return employee()
    }
    const provisioner = createEmployeeProvisioner(harness.deps)

    await provisioner.provisionById(EMPLOYEE)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('drops a skill with no slug instead of failing the round', async () => {
    // The export endpoint addresses skills by slug, so an entry without one
    // cannot be fetched. Payloads from before the field existed look like this.
    const legacy = {
      id: 'sk_legacy',
      name: 'legacy',
      downloadUrl: 'https://sd/x'
    } as unknown as DigitalEmployee['skills'][number]
    const harness = createHarness({
      employees: [
        employee({ skills: [legacy, { id: 'sk_1', name: 'ok', slug: 'ok', downloadUrl: 'x' }] })
      ]
    })
    const provisioner = createEmployeeProvisioner(harness.deps)

    const outcome = await provisioner.provisionById(EMPLOYEE)

    expect(outcome.skipped).toBeNull()
    expect(harness.synced[0]?.slugs).toEqual(['ok'])
  })
})
