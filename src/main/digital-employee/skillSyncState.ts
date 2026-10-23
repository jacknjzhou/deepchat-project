import { z } from 'zod'

/**
 * Skill install baselines: employee → skill slug → the `skills[].id` last
 * installed.
 *
 * The id is the version. StaffDeck mints a fresh row id every time a skill is
 * saved, so comparing ids detects a re-publish without downloading the package
 * to hash it — and without keeping the zip around.
 *
 * Lives in config entries rather than a database table for the same reason the
 * knowledge state does: it is a cache that can always be rebuilt from the
 * server, so it should not need migrations.
 */

export const DIGITAL_EMPLOYEE_SKILL_SYNC_KEY = 'digitalEmployee.skillSync'

const baselineSchema = z.record(z.string(), z.string())

/**
 * Reads are total: a corrupt or hand-edited entry degrades to "nothing
 * installed", which just means every skill is reinstalled once.
 */
export interface SkillSyncStateStore {
  get(employeeId: string): Record<string, string> | undefined
  set(employeeId: string, value: Record<string, string> | undefined): void
}

export interface SkillSyncStateStoreDeps {
  settings: {
    get<TValue = unknown>(key: string): TValue | undefined
    set(key: string, value: unknown): void
  }
  key?: string
}

export function createSkillSyncStateStore(
  deps: SkillSyncStateStoreDeps
): SkillSyncStateStore {
  const key = deps.key ?? DIGITAL_EMPLOYEE_SKILL_SYNC_KEY

  const readAll = (): Record<string, Record<string, string>> => {
    const raw = deps.settings.get<unknown>(key)
    if (raw === undefined || raw === null) return {}
    if (typeof raw !== 'object' || Array.isArray(raw)) return {}

    const entries: Record<string, Record<string, string>> = {}
    for (const [employeeId, value] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = baselineSchema.safeParse(value)
      // One malformed employee must not invalidate the rest.
      if (parsed.success) entries[employeeId] = parsed.data
    }
    return entries
  }

  return {
    get(employeeId) {
      return readAll()[employeeId]
    },
    set(employeeId, value) {
      const all = readAll()
      if (value === undefined || Object.keys(value).length === 0) {
        if (!Object.hasOwn(all, employeeId)) return
        const next = { ...all }
        delete next[employeeId]
        deps.settings.set(key, next)
        return
      }
      deps.settings.set(key, { ...all, [employeeId]: value })
    }
  }
}
