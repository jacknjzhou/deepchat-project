import { describe, expect, it } from 'vitest'
import {
  digitalEmployeeMcpServerAllowList,
  employeeSkillName,
  employeeSkillPrefix,
  isEmployeeKnowledgeServerName,
  isEmployeeMcpServerName,
  knowledgeServerNameForEmployee,
  mcpServerNameForEmployee
} from '../../../src/main/digital-employee/employeeScope'

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/

describe('employeeSkillPrefix', () => {
  it('keeps a plain employee id readable', () => {
    expect(employeeSkillPrefix('agent_f2828efc2a2a476d')).toBe('de-agent_f2828efc2a2a476d-')
  })

  it('survives an id with characters that are illegal in a folder name', () => {
    // Skill names feed directly into a directory name, and the Skill service
    // rejects anything outside /^[a-z0-9][a-z0-9._-]*$/. Windows additionally
    // forbids ':' outright.
    const prefix = employeeSkillPrefix('Digital Employee: 财务/001')
    expect(prefix).toMatch(/^[a-z0-9]/)
    expect(prefix).toMatch(/^[a-z0-9._-]+$/)
    expect(prefix).not.toContain(':')
    expect(prefix).not.toContain('/')
  })

  it('is stable for the same id', () => {
    expect(employeeSkillPrefix('abc')).toBe(employeeSkillPrefix('abc'))
  })

  it('never collides when two ids normalise onto the same text', () => {
    // ':' and '/' and ' ' all collapse to '-', so the raw text alone would
    // collide; distinct ids must still get distinct prefixes.
    expect(employeeSkillPrefix('a:b')).not.toBe(employeeSkillPrefix('a/b'))
  })
})

describe('employeeSkillName', () => {
  it('prefixes the skill so two employees can carry the same skill', () => {
    const first = employeeSkillName('agent_one', 'expense-approval')
    const second = employeeSkillName('agent_two', 'expense-approval')
    expect(first).not.toBe(second)
    expect(first.endsWith('expense-approval')).toBe(true)
    expect(second.endsWith('expense-approval')).toBe(true)
  })

  it('always produces a name the Skill service accepts', () => {
    const ids = ['agent_1', 'Agent.With.Dots', '财务员工', 'x'.repeat(120)]
    const skills = ['expense-approval', 'My Skill!', 'a.b.c', 'x'.repeat(200)]
    for (const id of ids) {
      for (const skill of skills) {
        const name = employeeSkillName(id, skill)
        expect(name).toMatch(SAFE_SKILL_NAME)
        expect(name.length).toBeLessThanOrEqual(255)
      }
    }
  })

  it('is idempotent so a reinstall targets the same folder', () => {
    expect(employeeSkillName('agent_1', 'expense')).toBe(employeeSkillName('agent_1', 'expense'))
  })

  it('keeps a non-ASCII skill name distinguishable', () => {
    expect(employeeSkillName('agent_1', '报销流程')).not.toBe(
      employeeSkillName('agent_1', '结算流程')
    )
  })
})

describe('mcpServerNameForEmployee', () => {
  it('is stable and distinct from the skill prefix', () => {
    expect(mcpServerNameForEmployee('agent_1')).toBe(mcpServerNameForEmployee('agent_1'))
    // The MCP server name is a local settings key, not a folder; it must not
    // equal the Skill prefix or a cleanup for one would look like the other.
    expect(mcpServerNameForEmployee('agent_1')).not.toBe(employeeSkillPrefix('agent_1'))
  })

  it('is recognisable as ours so cleanup never touches a user server', () => {
    expect(mcpServerNameForEmployee('agent_1').startsWith('staffdeck-')).toBe(true)
  })

  it('keeps two employees apart', () => {
    expect(mcpServerNameForEmployee('a:b')).not.toBe(mcpServerNameForEmployee('a/b'))
  })

  it('also satisfies the agent-id charset, since it may be reused there', () => {
    expect(mcpServerNameForEmployee('财务/001')).toMatch(SAFE_AGENT_ID)
  })
})

describe('knowledgeServerNameForEmployee', () => {
  it('is stable and keeps two employees apart', () => {
    expect(knowledgeServerNameForEmployee('agent_1')).toBe(
      knowledgeServerNameForEmployee('agent_1')
    )
    expect(knowledgeServerNameForEmployee('a:b')).not.toBe(knowledgeServerNameForEmployee('a/b'))
  })

  it('is recognisable as ours and distinct from the staffdeck remote server', () => {
    const name = knowledgeServerNameForEmployee('agent_1')
    expect(isEmployeeKnowledgeServerName(name)).toBe(true)
    expect(isEmployeeMcpServerName(name)).toBe(false)
    expect(name).toMatch(SAFE_AGENT_ID)
  })

  it('does not claim foreign server names', () => {
    expect(isEmployeeKnowledgeServerName('staffdeck-agent_1-deadbeef')).toBe(false)
    expect(isEmployeeKnowledgeServerName('my-own-server')).toBe(false)
  })
})

describe('digitalEmployeeMcpServerAllowList', () => {
  it('lists both employee servers for the session allowlist', () => {
    // 两个名字与注册器用的推导完全一致：名单恒定，注册与否不影响名单——
    // preset 员工两个 server 都不存在，白名单恰好挡掉全部 MCP 工具。
    expect(digitalEmployeeMcpServerAllowList('agent_1')).toEqual([
      mcpServerNameForEmployee('agent_1'),
      knowledgeServerNameForEmployee('agent_1')
    ])
  })

  it('keeps two normalise-alike ids apart', () => {
    const [first] = digitalEmployeeMcpServerAllowList('a:b')
    const [second] = digitalEmployeeMcpServerAllowList('a/b')
    expect(first).not.toBe(second)
  })
})
