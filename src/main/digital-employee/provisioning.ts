import type { DigitalEmployee } from '@shared/contracts/routes'
import { employeeSkillName } from './employeeScope'
import type {
  StaffdeckMcpRegistrar,
  StaffdeckMcpRegisterResult
} from './mcpRegistration'
import type { DistributedSkill, StaffdeckSkillSync, StaffdeckSkillSyncResult } from './skillSync'

/**
 * Runs the two local-execution preparations for one employee, right before a
 * conversation starts: register its remote tools, then install its skills.
 *
 * Why this is a separate layer rather than two calls at the call site:
 *
 * - **Neither chain may block the conversation.** A missing StaffDeck, an
 *   expired key or a corrupt zip all mean "fewer capabilities", never "you
 *   cannot talk to your employee". Both chains are wrapped so a throw becomes a
 *   recorded failure.
 * - **One round per employee at a time.** Opening a conversation is a UI action
 *   users repeat; registering an MCP server and installing skills both write
 *   shared state, so overlapping rounds would race on settings and trigger
 *   redundant MCP reconnects. Concurrent callers share the in-flight round.
 *
 * The gate is deliberately narrow. `remote` employees run on the server, which
 * already holds their tools and skills — provisioning them locally would put
 * duplicate tools in the model's list. Employees served by the mock provider
 * carry fabricated ids that would only produce 404s.
 */

/** Only what provisioning needs; the rest of `DigitalEmployee` is irrelevant here. */
export interface EmployeeProvisioningTarget {
  id: string
  executionMode: 'local' | 'remote' | 'hybrid'
  tools: readonly string[]
  skills: readonly DistributedSkill[]
}

export type ProvisioningSkipReason =
  /** Runs on the server: no local tools, no local skills. */
  | 'NOT_LOCAL'
  /** Provider is serving mock data, so ids and packages are fabricated. */
  | 'DEGRADED'
  /** The employee id no longer exists in the distributed list. */
  | 'NOT_FOUND'

export interface EmployeeProvisioningOutcome {
  employeeId: string
  /** `null` when the employee was provisioned. */
  skipped: ProvisioningSkipReason | null
  /** `null` means the chain was not attempted or threw. */
  mcp: StaffdeckMcpRegisterResult | null
  skills: StaffdeckSkillSyncResult | null
  /**
   * The names the distributed skills are installed under.
   *
   * Callers must use these rather than the payload's slugs: installation
   * prefixes every name with the employee scope, so activating a session with
   * the slug alone silently matches nothing.
   */
  skillNames: string[]
  /** Chain names that threw. Empty on a clean round. */
  failures: Array<'mcp' | 'skills'>
}

export interface EmployeeProvisionerDeps {
  /** Looks the employee up in the distributed list; may reject. */
  getEmployee: (employeeId: string) => Promise<DigitalEmployee | null>
  /** Actual provider behind that list, so mock data is never provisioned. */
  source: () => 'http' | 'mock'
  registrar: Pick<StaffdeckMcpRegistrar, 'registerForEmployee' | 'unregister'>
  skillSync: Pick<StaffdeckSkillSync, 'syncEmployee'>
}

export interface EmployeeProvisioner {
  /** Provisions an employee already in hand (the store has the object before it navigates). */
  provision(target: EmployeeProvisioningTarget): Promise<EmployeeProvisioningOutcome>
  /** Same, resolving the target from the distributed list first. */
  provisionById(employeeId: string): Promise<EmployeeProvisioningOutcome>
  /**
   * Drops in-flight state after a configuration change.
   *
   * Not a cache: registration is idempotent and skill sync is version-based, so
   * the next round re-checks everything anyway. This exists so a round started
   * with the old credentials can never answer for the new ones.
   */
  reset(): void
}

const toTarget = (employee: DigitalEmployee): EmployeeProvisioningTarget => ({
  id: employee.id,
  executionMode: employee.executionMode,
  tools: employee.tools,
  // `skills[]` is optional in the contract because older payloads omit it.
  // A skill without a slug cannot be fetched — the export endpoint addresses it
  // by slug — so it is dropped here rather than failing every round.
  skills: (employee.skills ?? []).filter(
    (skill): skill is { id: string; name: string; slug: string; downloadUrl: string } =>
      typeof skill.slug === 'string'
  )
})

/**
 * 这个员工需不需要在本地准备工具与技能。
 *
 * 判据写成「哪些**不需要**」而不是「哪些需要」，因为答案只取决于一件事：
 * 执行发生在哪里。`remote` 一律在服务端跑，服务端自己持有它的工具与技能，
 * 本地再准备一遍只会让模型看到两份同名工具。`local` 与 `hybrid` 都可能（或
 * 一定）在本地执行，所以都要准备。
 *
 * 特别说 hybrid：它配的是「可切换」，一个会话切到云端之后，绑定表里那一轮
 * 走服务端，但**下一次新建会话仍然从本地开始**。因此 hybrid 的本地准备不是
 * 冗余，而是它默认形态的前提条件。这条判断与 `switchToRemote` 无关，不能用
 * 「这个会话此刻在哪」来做——那是另一个问题，答案在绑定表里。
 */
const needsLocalProvisioning = (executionMode: EmployeeProvisioningTarget['executionMode']) =>
  executionMode !== 'remote'

export function createEmployeeProvisioner(
  deps: EmployeeProvisionerDeps
): EmployeeProvisioner {
  const inFlight = new Map<string, Promise<EmployeeProvisioningOutcome>>()

  const runChain = async <TResult>(
    name: 'mcp' | 'skills',
    run: () => Promise<TResult>,
    failures: Array<'mcp' | 'skills'>
  ): Promise<TResult | null> => {
    try {
      return await run()
    } catch {
      // Network failure, 403, corrupt archive, settings write rejection — all
      // the same here: this capability is unavailable for this conversation.
      failures.push(name)
      return null
    }
  }

  /**
   * Tools first, skills second, and not in parallel.
   *
   * Registering the server is what makes `staffdeck_*` names appear in the
   * renderer's tool list, which the store reads right after this returns to
   * build the allowlist. Installing skills touches a directory the first turn
   * reads the system prompt from. Doing both before returning keeps the two
   * dependent reads correct without making them depend on each other.
   */
  const provision = async (
    employeeId: string,
    resolve: () => Promise<EmployeeProvisioningTarget | ProvisioningSkipReason>
  ): Promise<EmployeeProvisioningOutcome> => {
    const existing = inFlight.get(employeeId)
    if (existing) return existing

    const round = (async (): Promise<EmployeeProvisioningOutcome> => {
      const base = {
        employeeId,
        mcp: null,
        skills: null,
        skillNames: [] as string[],
        failures: [] as Array<'mcp' | 'skills'>
      }

      const resolved = await resolve().catch((): ProvisioningSkipReason => 'NOT_FOUND')
      if (typeof resolved === 'string') {
        // A stale registration outlives the employee leaving local mode: its
        // tools would keep showing up in every other conversation.
        if (resolved !== 'DEGRADED') {
          await deps.registrar.unregister(employeeId).catch(() => undefined)
        }
        return { ...base, skipped: resolved }
      }

      const failures = base.failures
      const mcp = await runChain(
        'mcp',
        () => deps.registrar.registerForEmployee({ employeeId, tools: resolved.tools }),
        failures
      )
      const skills = await runChain(
        'skills',
        () => deps.skillSync.syncEmployee({ employeeId, skills: resolved.skills }),
        failures
      )

      return {
        ...base,
        skipped: null,
        mcp,
        skills,
        failures,
        // Reported even when the sync threw: a skill installed in an earlier
        // round is still on disk and still worth activating.
        skillNames: resolved.skills.map((skill) => employeeSkillName(employeeId, skill.slug))
      }
    })()

    inFlight.set(employeeId, round)
    try {
      return await round
    } finally {
      if (inFlight.get(employeeId) === round) inFlight.delete(employeeId)
    }
  }

  return {
    provision(target) {
      if (!needsLocalProvisioning(target.executionMode)) {
        // Gate before touching the registry so the cleanup path always runs,
        // even when the caller handed us a fully-formed target.
        return provision(target.id, async () => 'NOT_LOCAL')
      }
      if (deps.source() === 'mock') {
        return provision(target.id, async () => 'DEGRADED')
      }
      return provision(target.id, async () => target)
    },

    provisionById(employeeId) {
      return provision(employeeId, async () => {
        const employee = await deps.getEmployee(employeeId)
        // Losing the employee between the click and the lookup is normal: the
        // list is refreshed from the server, and an admin may have disabled it.
        if (!employee) return 'NOT_FOUND'
        if (!needsLocalProvisioning(employee.executionMode)) return 'NOT_LOCAL'
        if (deps.source() === 'mock') return 'DEGRADED'
        return toTarget(employee)
      })
    },

    reset() {
      inFlight.clear()
    }
  }
}
