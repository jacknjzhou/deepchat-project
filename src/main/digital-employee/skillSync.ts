import type { StaffdeckConnection } from './mcpRegistration'
import { employeeSkillName } from './employeeScope'

/**
 * Installs the skill packages StaffDeck distributes with each employee.
 *
 * What this deliberately does not do: create a per-employee Agent. Digital
 * employee conversations all run on the built-in `deepchat` Agent, so there is
 * no isolated skill root to install into (`requireAgentScope` would reject
 * `digital-employee:<id>` anyway — the id is not a registered Agent, and the
 * colon is illegal in a Windows path). Isolation comes from the skill name
 * prefix instead, which is what `employeeSkillName` provides.
 *
 * Everything here degrades: a skill that fails to download or install is
 * reported and retried next round. A conversation must never be held up
 * because a skill package was unreachable.
 */

export interface DistributedSkill {
  id: string
  name: string
  slug: string
  /** Present in the payload but unusable: the server bakes its own tool_base_url into it. */
  downloadUrl?: string
}

export interface StaffdeckSkillSyncDeps {
  getConnection: () => StaffdeckConnection | null
  fetchImpl: typeof fetch
  /** Writes bytes somewhere the installer can read, returning that path. */
  writeTempFile: (bytes: Uint8Array) => Promise<string>
  removeTempFile: (path: string) => Promise<void>
  skills: {
    installFromZipForAgent: (
      agentId: string,
      zipPath: string,
      options?: { overwrite?: boolean; targetName?: string }
    ) => Promise<{ success: boolean; error?: string }>
  }
  /** Records the `skills[].id` last installed for each slug, so unchanged skills are not re-fetched. */
  stateStore: {
    get: (employeeId: string) => Record<string, string> | undefined
    set: (employeeId: string, value: Record<string, string> | undefined) => void
  }
}

export interface StaffdeckSkillSyncResult {
  ok: boolean
  installed: number
  failedSkills: string[]
  reason?: 'NOT_CONFIGURED'
}

export interface StaffdeckSkillSync {
  syncEmployee(input: {
    employeeId: string
    skills: readonly DistributedSkill[]
  }): Promise<StaffdeckSkillSyncResult>
}

/**
 * Skills install into the built-in Agent's root — the same place a digital
 * employee conversation resolves its skills from.
 */
const SKILL_AGENT_ID = 'deepchat'

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '')

/**
 * Rebuild the export URL from the client's own base URL.
 *
 * `downloadUrl` carries the server's `tool_base_url` (defaults to
 * `localhost:5173`), which is unrelated to the address the client actually
 * reaches StaffDeck at. D3 hit the same thing with knowledge `bundleUrl`.
 */
const exportUrl = (
  connection: StaffdeckConnection,
  employeeId: string,
  slug: string
): string =>
  `${normalizeBaseUrl(connection.baseUrl)}/api/v1/digital-employees/` +
  `${encodeURIComponent(employeeId)}:export-skill?slug=${encodeURIComponent(slug)}`

export function createStaffdeckSkillSync(deps: StaffdeckSkillSyncDeps): StaffdeckSkillSync {
  const installOne = async (
    connection: StaffdeckConnection,
    employeeId: string,
    skill: DistributedSkill
  ): Promise<boolean> => {
    let zipPath: string | null = null
    try {
      const response = await deps.fetchImpl(exportUrl(connection, employeeId, skill.slug), {
        headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: 'application/zip' }
      })
      if (!response.ok) return false

      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0) return false

      zipPath = await deps.writeTempFile(bytes)
      const targetName = employeeSkillName(employeeId, skill.slug)
      const result = await deps.skills.installFromZipForAgent(SKILL_AGENT_ID, zipPath, {
        // A re-published skill must replace the old folder, not collide with it.
        overwrite: true,
        targetName
      })
      return result.success
    } catch {
      // Network failure, corrupt archive, install rejection — all the same to
      // the caller: this skill is not updated this round.
      return false
    } finally {
      if (zipPath) {
        try {
          await deps.removeTempFile(zipPath)
        } catch {
          // A leftover temp file is not worth failing the sync over.
        }
      }
    }
  }

  return {
    async syncEmployee({ employeeId, skills }) {
      const connection = deps.getConnection()
      if (!connection) {
        return { ok: false, installed: 0, failedSkills: [], reason: 'NOT_CONFIGURED' }
      }
      if (skills.length === 0) {
        // Nothing distributed: clear the baseline so a future re-publish is seen as new.
        deps.stateStore.set(employeeId, undefined)
        return { ok: true, installed: 0, failedSkills: [] }
      }

      const baseline = deps.stateStore.get(employeeId) ?? {}
      const nextBaseline: Record<string, string> = {}
      const failedSkills: string[] = []
      let installed = 0

      for (const skill of skills) {
        // The server mints a new id whenever a skill is saved, so it doubles as
        // a content version without hashing the package ourselves.
        if (baseline[skill.slug] === skill.id) {
          nextBaseline[skill.slug] = skill.id
          continue
        }

        const ok = await installOne(connection, employeeId, skill)
        if (ok) {
          // Only successful installs become the baseline; a failure must be
          // retried rather than remembered as done.
          nextBaseline[skill.slug] = skill.id
          installed += 1
        } else {
          failedSkills.push(skill.slug)
        }
      }

      deps.stateStore.set(employeeId, nextBaseline)

      return { ok: failedSkills.length === 0, installed, failedSkills }
    }
  }
}
