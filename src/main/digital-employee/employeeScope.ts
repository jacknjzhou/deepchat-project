import { createHash } from 'node:crypto'

/**
 * Stable identifiers derived from a digital-employee id.
 *
 * Three different namespaces come out of one employee id, and they have
 * different rules:
 *
 * - Skill folders must match `/^[a-z0-9][a-z0-9._-]*$/` (see `SKILL_NAME_PATTERN`
 *   in `src/main/skill/index.ts`) and are used verbatim as directory names.
 * - MCP server names are settings keys; anything readable works, but they must
 *   be recognisable so cleanup never deletes a user's own server.
 * - Employee ids arrive from StaffDeck as opaque strings and may contain ':',
 *   '/', spaces or non-ASCII text.
 *
 * Normalisation is many-to-one, so every derived name carries a digest of the
 * original id. Without it `a:b` and `a/b` would share one folder and one
 * employee would silently inherit the other's skills.
 */

const SKILL_PREFIX_TAG = 'de-'
const MCP_SERVER_TAG = 'staffdeck-'
const KNOWLEDGE_SERVER_TAG = 'de-kb-'
const DIGEST_LENGTH = 8

/** Keeps the total inside the 255-char Skill name limit with room for the slug. */
const MAX_ID_SEGMENT = 32
const MAX_SLUG_SEGMENT = 160
const MAX_NAME_LENGTH = 255

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, DIGEST_LENGTH)

/**
 * Lowercase, ASCII-only text with runs of illegal characters collapsed to '-'.
 *
 * Non-ASCII characters are dropped rather than transliterated: a lossy guess at
 * a Chinese id would be more surprising than a digest, and the digest already
 * carries uniqueness.
 */
const toSafeSegment = (value: string, maxLength: number): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
  return normalized.slice(0, maxLength).replace(/[-._]+$/, '')
}

/**
 * Prefix every Skill belonging to one employee so two employees can carry a
 * Skill with the same name without fighting over one folder.
 *
 * Ids that are already folder-safe keep a readable prefix; anything that had to
 * be rewritten gains a digest, because the rewrite is many-to-one.
 */
export const employeeSkillPrefix = (employeeId: string): string => {
  const idPart = toSafeSegment(employeeId, MAX_ID_SEGMENT) || 'employee'
  const isLossless = idPart === employeeId.toLowerCase() && idPart.length === employeeId.length
  return isLossless
    ? `${SKILL_PREFIX_TAG}${idPart}-`
    : `${SKILL_PREFIX_TAG}${idPart}-${digest(employeeId)}-`
}

/**
 * The folder name a distributed Skill gets on disk.
 *
 * Stable for the same (employee, skill) pair, so re-installing overwrites the
 * same directory instead of accumulating copies.
 */
export const employeeSkillName = (employeeId: string, skillSlug: string): string => {
  const prefix = employeeSkillPrefix(employeeId)
  const slugPart = toSafeSegment(skillSlug, MAX_SLUG_SEGMENT)
  // A skill whose slug is entirely non-ASCII still needs a name; fall back to
  // the digest so two such skills stay distinct.
  const suffix = slugPart || digest(skillSlug)
  return `${prefix}${suffix}`.slice(0, MAX_NAME_LENGTH)
}

/**
 * The key one employee's remote MCP server is stored under.
 *
 * Prefixed so `removeMcpServer` can never hit a server the user configured, and
 * digested so two ids that normalise alike stay separate.
 */
export const mcpServerNameForEmployee = (employeeId: string): string => {
  const idPart = toSafeSegment(employeeId, MAX_ID_SEGMENT) || 'employee'
  return `${MCP_SERVER_TAG}${idPart}-${digest(employeeId)}`
}

/** True when the server was registered by this feature rather than by the user. */
export const isEmployeeMcpServerName = (name: string): boolean => name.startsWith(MCP_SERVER_TAG)

/**
 * The key one employee's local knowledge search server is stored under.
 *
 * Same prefix/digest discipline as `mcpServerNameForEmployee`, but a distinct
 * tag: the knowledge server is in-memory and per-employee, and a cleanup for
 * the remote tool server must never take the knowledge server with it.
 */
export const knowledgeServerNameForEmployee = (employeeId: string): string => {
  const idPart = toSafeSegment(employeeId, MAX_ID_SEGMENT) || 'employee'
  return `${KNOWLEDGE_SERVER_TAG}${idPart}-${digest(employeeId)}`
}

/** True when the in-memory server belongs to the digital-employee knowledge feature. */
export const isEmployeeKnowledgeServerName = (name: string): boolean =>
  name.startsWith(KNOWLEDGE_SERVER_TAG)

/**
 * 员工会话的 MCP server 白名单。
 *
 * 数字员工会话只能看到本员工的两个 server（远端工具 + 本地知识检索）。
 * 名单里多出的 server id 无害——universe 里不存在的 server 就是零工具，
 * 所以调用方不需要先确认注册是否真的发生过（preset 员工两个都没有，
 * 白名单恰好把全部 MCP 工具挡掉，这正是想要的）。
 */
export const digitalEmployeeMcpServerAllowList = (employeeId: string): [string, string] => [
  mcpServerNameForEmployee(employeeId),
  knowledgeServerNameForEmployee(employeeId)
]
