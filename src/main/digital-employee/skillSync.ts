import { unzipSync, zipSync } from 'fflate'
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
    /** Names the Agent's catalog currently resolves (discovered + assigned). */
    listVisibleSkillNames: (agentId: string) => Promise<string[]>
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
  /**
   * slug → 失败原因（HTTP 状态码、安装器报错等）。只作诊断展示：没有它，
   * 「装不上」与「连不上」在调用方看来是同一个 false，而两者的处置完全不同
   * ——前者查服务端与包，后者查密钥与网络。
   */
  failureReasons: Record<string, string>
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
 * 修补服务端导出包里缺失的 SKILL.md frontmatter。
 *
 * StaffDeck 生成技能正文时不带 frontmatter（实测 `# 标题` 直接开头），而本地
 * 安装器要求 frontmatter 里必须有非空 `name`，否则三个环节全数拒装。这里在
 * 同步路径上注入最小合法 frontmatter 兜底：
 * - `name` 用清洗后的 slug（frontmatter 名有 `[a-z0-9._-]` 规范，中文显示名
 *   不合格）；最终目录名仍由 `targetName` 决定，不受影响。
 * - `description` 用服务端显示名（无格式限制，JSON 编码保证 YAML 合法）。
 * - 已带 frontmatter 的包原样透传；任何异常回退原始 bytes——修补失败不能
 *   比不修补更糟，安装器会对原始包给出自己的错误。
 */
const MAX_FRONTMATTER_PATCH_BYTES = 64 * 1024 * 1024

const sanitizeFrontmatterName = (slug: string): string => {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
  return cleaned || 'skill'
}

const hasFrontmatter = (content: string): boolean => /^\uFEFF?\s*---/.test(content)

export const ensureSkillFrontmatter = (
  bytes: Uint8Array,
  skill: Pick<DistributedSkill, 'name' | 'slug'>
): Uint8Array => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRONTMATTER_PATCH_BYTES) return bytes
  try {
    const files = unzipSync(bytes)
    const skillMdKey = Object.keys(files).find((key) => key === 'SKILL.md')
    if (!skillMdKey) return bytes
    const content = Buffer.from(files[skillMdKey]).toString('utf8')
    if (hasFrontmatter(content)) return bytes
    const description = skill.name?.trim() || skill.slug
    const patched =
      `---\n` +
      `name: ${sanitizeFrontmatterName(skill.slug)}\n` +
      `description: ${JSON.stringify(description)}\n` +
      `---\n` +
      `${content.replace(/^\uFEFF/, '')}`
    const repacked: Record<string, Uint8Array> = {}
    for (const [key, value] of Object.entries(files)) {
      // 目录项（以 `/` 结尾的空 entry）交给打包器按路径推断，原样带过去会生成怪条目。
      if (key.endsWith('/')) continue
      repacked[key] = value
    }
    repacked[skillMdKey] = Buffer.from(patched, 'utf8')
    return zipSync(repacked)
  } catch {
    return bytes
  }
}

/**
 * Rebuild the export URL from the client's own base URL.
 *
 * `downloadUrl` carries the server's `tool_base_url` (defaults to
 * `localhost:5173`), which is unrelated to the address the client actually
 * reaches StaffDeck at. D3 hit the same thing with knowledge `bundleUrl`.
 */
const exportUrl = (connection: StaffdeckConnection, employeeId: string, slug: string): string =>
  `${normalizeBaseUrl(connection.baseUrl)}/api/v1/digital-employees/` +
  `${encodeURIComponent(employeeId)}:export-skill?slug=${encodeURIComponent(slug)}`

export function createStaffdeckSkillSync(deps: StaffdeckSkillSyncDeps): StaffdeckSkillSync {
  /**
   * 下载并安装一个技能包。成功返回 null，失败返回一句话原因。
   *
   * 原因必须活着回到调用方：HTTP 401、空响应、安装器拒绝在布尔世界里都是
   * false，但用户要采取的动作完全不同（换 key / 查服务端 / 清理本地目录）。
   */
  const installOne = async (
    connection: StaffdeckConnection,
    employeeId: string,
    skill: DistributedSkill
  ): Promise<string | null> => {
    let zipPath: string | null = null
    try {
      const response = await deps.fetchImpl(exportUrl(connection, employeeId, skill.slug), {
        headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: 'application/zip' }
      })
      if (!response.ok) return `HTTP ${response.status}`

      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0) return 'empty response body'

      zipPath = await deps.writeTempFile(ensureSkillFrontmatter(bytes, skill))
      const targetName = employeeSkillName(employeeId, skill.slug)
      const result = await deps.skills.installFromZipForAgent(SKILL_AGENT_ID, zipPath, {
        // A re-published skill must replace the old folder, not collide with it.
        overwrite: true,
        targetName
      })
      return result.success ? null : `installer: ${result.error ?? 'unknown error'}`
    } catch (error) {
      // Network failure, corrupt archive, install rejection — the round still
      // degrades the same way, but the message survives for the toast and log.
      return `error: ${error instanceof Error ? error.message : String(error)}`
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
        return {
          ok: false,
          installed: 0,
          failedSkills: [],
          failureReasons: {},
          reason: 'NOT_CONFIGURED'
        }
      }
      if (skills.length === 0) {
        // Nothing distributed: clear the baseline so a future re-publish is seen as new.
        deps.stateStore.set(employeeId, undefined)
        return { ok: true, installed: 0, failedSkills: [], failureReasons: {} }
      }

      const baseline = deps.stateStore.get(employeeId) ?? {}
      const nextBaseline: Record<string, string> = {}
      const failedSkills: string[] = []
      const failureReasons: Record<string, string> = {}
      let installed = 0

      /**
       * 目录可见性探测，一轮内只取一次。baseline 命中仍要求预期（带前缀）名字
       * 在目录里可解析：旧构建可能装过无前缀目录，而记账的 id 永不变化，没有
       * 这层检查该缺口永远不会自愈。缓存不跨轮——自愈安装会让名字变可见，读到
       * 安装前的旧结果会导致每轮重复重装。探测失败降级为「信任 baseline」
       * （返回 null）：可见性只是记账之上的校验，它自身的故障不能变成一轮
       * 重装风暴。
       */
      let visibleNamesPromise: Promise<Set<string> | null> | undefined
      const isInstalledVisible = async (slug: string): Promise<boolean> => {
        if (visibleNamesPromise === undefined) {
          visibleNamesPromise = deps.skills
            .listVisibleSkillNames(SKILL_AGENT_ID)
            .then((names) => new Set(names))
            .catch((error) => {
              console.warn(
                `[digitalEmployee] skill visibility probe failed, trusting baseline — ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
              return null
            })
        }
        const visibleNames = await visibleNamesPromise
        return visibleNames === null || visibleNames.has(employeeSkillName(employeeId, slug))
      }

      for (const skill of skills) {
        // The server mints a new id whenever a skill is saved, so it doubles as
        // a content version without hashing the package ourselves. A baseline
        // hit still requires the expected (prefixed) name to be visible: an
        // older build may have installed under a different naming rule, and
        // since the recorded id never changes the gap would otherwise persist
        // forever instead of healing on the next round.
        const baselineHit =
          baseline[skill.slug] === skill.id && (await isInstalledVisible(skill.slug))
        if (baselineHit) {
          nextBaseline[skill.slug] = skill.id
          continue
        }

        const failure = await installOne(connection, employeeId, skill)
        if (failure === null) {
          // Only successful installs become the baseline; a failure must be
          // retried rather than remembered as done.
          nextBaseline[skill.slug] = skill.id
          installed += 1
        } else {
          failedSkills.push(skill.slug)
          failureReasons[skill.slug] = failure
          console.warn(
            `[digitalEmployee] skill install failed: ${employeeId}/${skill.slug} — ${failure}`
          )
        }
      }

      deps.stateStore.set(employeeId, nextBaseline)

      return { ok: failedSkills.length === 0, installed, failedSkills, failureReasons }
    }
  }
}
