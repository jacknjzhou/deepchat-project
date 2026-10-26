import { describe, expect, it } from 'vitest'
import {
  digitalEmployeeListRoute,
  digitalEmployeeSchema
} from '../../../src/shared/contracts/routes/digitalEmployee.routes'

const baseEmployee = {
  id: 'emp-finance',
  name: '财务',
  role: '财务',
  description: '报销管家',
  avatar: null,
  capabilities: ['报销'],
  greeting: null,
  systemPrompt: '#角色：报销管家',
  sops: [],
  knowledgeBaseIds: [],
  skillIds: [],
  tools: [],
  enabled: true,
  updatedAt: '2026-10-22T00:00:00Z'
}

describe('digitalEmployeeSchema (StaffDeck superset)', () => {
  it('accepts StaffDeck extended fields', () => {
    const parsed = digitalEmployeeSchema.parse({
      ...baseEmployee,
      executionMode: 'hybrid',
      configHash: 'abc123',
      skills: [
        {
          id: 'sk-1',
          name: 'staffdeck-api',
          downloadUrl: 'https://sd/api/v1/digital-employees/emp-finance:export-skill'
        }
      ],
      knowledgePackagesUrl: 'https://sd/api/v1/digital-employees/emp-finance/knowledge-packages'
    })

    expect(parsed.executionMode).toBe('hybrid')
    expect(parsed.skills).toHaveLength(1)
  })

  it('keeps skills[].slug, which the export endpoint addresses by', () => {
    // zod strips unknown keys, so a missing schema field silently becomes
    // "no slug" and every skill fails to download with no visible cause.
    const parsed = digitalEmployeeSchema.parse({
      ...baseEmployee,
      skills: [
        {
          id: 'sk-1',
          name: 'staffdeck-api',
          slug: 'staffdeck-api',
          downloadUrl: 'https://sd/api/v1/digital-employees/emp-finance:export-skill'
        }
      ]
    })

    expect(parsed.skills?.[0]?.slug).toBe('staffdeck-api')
  })

  it('still accepts skills[] entries from payloads without a slug', () => {
    const parsed = digitalEmployeeSchema.parse({
      ...baseEmployee,
      skills: [{ id: 'sk-1', name: 'legacy', downloadUrl: 'https://sd/x' }]
    })

    expect(parsed.skills?.[0]?.slug).toBeUndefined()
  })

  it('defaults executionMode to local and strips unknown fields', () => {
    const parsed = digitalEmployeeSchema.parse({
      ...baseEmployee,
      unknownFutureField: 'x'
    })

    expect(parsed.executionMode).toBe('local')
    expect((parsed as Record<string, unknown>).unknownFutureField).toBeUndefined()
  })

  it('rejects invalid executionMode', () => {
    expect(() =>
      digitalEmployeeSchema.parse({ ...baseEmployee, executionMode: 'serverless' })
    ).toThrow()
  })

  it('list output tolerates degraded/source markers', () => {
    const out = digitalEmployeeListRoute.output.parse({
      employees: [baseEmployee],
      fetchedAt: 't',
      degraded: true,
      source: 'mock'
    })

    expect(out.degraded).toBe(true)
    expect(out.source).toBe('mock')
  })
})
