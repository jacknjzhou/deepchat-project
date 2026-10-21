import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import {
  documentsReimbursementExportRoute,
  documentsReimbursementGetConfigRoute,
  documentsReimbursementSetConfigRoute,
  documentsReimbursementSetOverrideRoute,
  documentsReimbursementTreeRoute,
  reimbursementConfigSchema
} from '@shared/contracts/routes'
import type { DocumentRecord } from '@shared/documents'
import {
  amountFor,
  buildReimbursementTree,
  parsePeriodValue,
  periodFor,
  personFor,
  REIMBURSEMENT_UNASSIGNED,
  resolveDocumentCategoryId
} from '@/documents/reimbursement'
import {
  readReimbursementConfig,
  writeReimbursementConfig,
  REIMBURSEMENT_SETTINGS_KEY
} from '@/documents/reimbursementConfig'

const validConfig = {
  version: 1 as const,
  categories: [
    {
      id: 'cat-meeting',
      name: '会议费',
      requiredMaterials: [{ name: '发票', linkedTypeKeys: ['invoice_general'] }],
      linkedTypeKeys: ['meeting_minutes'],
      customGroups: [],
      sortOrder: 1
    }
  ],
  personFieldKeys: ['buyer_name'],
  dateFieldKeys: ['invoice_date'],
  amountFieldKeys: ['total_amount'],
  dateGrouping: 'month' as const
}

describe('reimbursement contracts', () => {
  it('parses a valid config', () => {
    expect(reimbursementConfigSchema.parse(validConfig)).toEqual(validConfig)
  })

  it('rejects invalid linked type keys', () => {
    expect(
      reimbursementConfigSchema.safeParse({
        ...validConfig,
        categories: [{ ...validConfig.categories[0], linkedTypeKeys: ['Bad-Key'] }]
      }).success
    ).toBe(false)
  })

  it('defines the five routes', () => {
    expect(documentsReimbursementGetConfigRoute.name).toBe('documents.reimbursement.getConfig')
    expect(documentsReimbursementSetConfigRoute.name).toBe('documents.reimbursement.setConfig')
    expect(documentsReimbursementTreeRoute.name).toBe('documents.reimbursement.tree')
    expect(documentsReimbursementSetOverrideRoute.name).toBe('documents.reimbursement.setOverride')
    expect(documentsReimbursementExportRoute.name).toBe('documents.reimbursement.export')
  })

  it('rejects the reserved unassigned category id', () => {
    expect(
      reimbursementConfigSchema.safeParse({
        ...validConfig,
        categories: [{ ...validConfig.categories[0], id: 'unassigned' }]
      }).success
    ).toBe(false)
  })

  it('rejects duplicate category ids', () => {
    expect(
      reimbursementConfigSchema.safeParse({
        ...validConfig,
        categories: [validConfig.categories[0], { ...validConfig.categories[0], name: '副本' }]
      }).success
    ).toBe(false)
  })
})

const config = reimbursementConfigSchema.parse({
  version: 1,
  categories: [
    {
      id: 'cat-a',
      name: '会议费',
      requiredMaterials: [{ name: '发票', linkedTypeKeys: ['invoice_general'] }],
      linkedTypeKeys: ['meeting_minutes'],
      sortOrder: 1
    },
    {
      id: 'cat-b',
      name: '业务招待费',
      requiredMaterials: [],
      linkedTypeKeys: ['catering_receipt'],
      sortOrder: 2
    }
  ],
  personFieldKeys: ['buyer_name', 'guest_name'],
  dateFieldKeys: ['invoice_date', 'consume_date'],
  amountFieldKeys: ['total_amount', 'amount'],
  dateGrouping: 'month'
})

const doc = (overrides: Partial<DocumentRecord> & { fields?: Record<string, unknown> }) =>
  ({
    id: 'd1',
    templateId: 't',
    typeKey: 'meeting_minutes',
    templateSnapshot: {} as never,
    fields: {},
    fileUris: [],
    source: 'manual',
    sessionId: null,
    status: 'confirmed',
    reimbursementOverride: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }) as DocumentRecord

describe('resolveDocumentCategoryId', () => {
  it('override wins', () => {
    const d = doc({ typeKey: 'catering_receipt', reimbursementOverride: 'cat-a' })
    expect(resolveDocumentCategoryId(d, config)).toEqual({ categoryId: 'cat-a', isOverride: true })
  })

  it('maps by typeKey (lowest sortOrder)', () => {
    expect(resolveDocumentCategoryId(doc({ typeKey: 'meeting_minutes' }), config)).toEqual({
      categoryId: 'cat-a',
      isOverride: false
    })
  })

  it('unassigned override forces null', () => {
    expect(
      resolveDocumentCategoryId(doc({ reimbursementOverride: REIMBURSEMENT_UNASSIGNED }), config)
    ).toEqual({ categoryId: null, isOverride: true })
  })

  it('stale override (deleted category) falls back to auto mapping', () => {
    expect(
      resolveDocumentCategoryId(
        doc({ typeKey: 'catering_receipt', reimbursementOverride: 'cat-gone' }),
        config
      )
    ).toEqual({ categoryId: 'cat-b', isOverride: false })
  })

  it('no mapping → null', () => {
    expect(resolveDocumentCategoryId(doc({ typeKey: 'resume' }), config)).toEqual({
      categoryId: null,
      isOverride: false
    })
  })
})

describe('field extraction', () => {
  it('person: first configured key with non-empty value', () => {
    const d = doc({
      fields: {
        buyer_name: { value: '张三', uncertain: false },
        guest_name: { value: '李四', uncertain: false }
      } as never
    })
    expect(personFor(d, config)).toBe('张三')
  })

  it('person: array value takes first non-empty element', () => {
    const d = doc({ fields: { buyer_name: { value: ['', '王五'], uncertain: false } } as never })
    expect(personFor(d, config)).toBe('王五')
  })

  it('period: parses and groups by month', () => {
    const d = doc({ fields: { invoice_date: { value: '2026/9/5', uncertain: false } } as never })
    expect(periodFor(d, config)).toBe('2026-09')
  })

  it('period: day grouping keeps the day', () => {
    const d = doc({
      fields: { invoice_date: { value: '2026-09-05 13:20', uncertain: false } } as never
    })
    expect(periodFor(d, { ...config, dateGrouping: 'day' })).toBe('2026-09-05')
  })

  it('parsePeriodValue handles dashes, slashes, dots and rejects garbage', () => {
    expect(parsePeriodValue('2026-09-05')).toBe('2026-09-05')
    expect(parsePeriodValue('2026.9.5')).toBe('2026-09-05')
    expect(parsePeriodValue('无日期')).toBeNull()
  })

  it('amount: numeric string with separators', () => {
    const d = doc({ fields: { total_amount: { value: '1,234.50', uncertain: true } } as never })
    expect(amountFor(d, config)).toEqual({ amount: 1234.5, uncertain: true })
  })

  it('amount: full-width comma and symbols-only strings', () => {
    const blank = doc({ fields: { total_amount: { value: '元 ， ', uncertain: true } } as never })
    expect(amountFor(blank, config)).toEqual({ amount: null, uncertain: true })
    const fullwidth = doc({
      fields: { total_amount: { value: '1，234', uncertain: false } } as never
    })
    expect(amountFor(fullwidth, config)).toEqual({ amount: 1234, uncertain: false })
  })
})

describe('buildReimbursementTree', () => {
  const templateNameById = new Map([['t', '会议纪要']])

  it('splits group-assigned entries into category customGroups by period', () => {
    const groupedConfig = reimbursementConfigSchema.parse({
      version: 1,
      categories: [
        {
          id: 'cat-meeting',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: ['meeting_minutes'],
          customGroups: [
            { id: 'grp-a', name: '分组一', sortOrder: 0 },
            { id: 'grp-b', name: '分组二', sortOrder: 1 }
          ],
          sortOrder: 1
        }
      ],
      personFieldKeys: ['buyer_name'],
      dateFieldKeys: ['meeting_date'],
      amountFieldKeys: ['total_amount'],
      dateGrouping: 'month'
    })
    const grouped = doc({
      id: 'd-grouped',
      typeKey: 'meeting_minutes',
      reimbursementOverride: 'cat-meeting',
      reimbursementGroupOverride: 'grp-a',
      fields: { meeting_date: { value: '2026-04-01', uncertain: false } }
    })
    const ungrouped = doc({
      id: 'd-ungrouped',
      typeKey: 'meeting_minutes',
      reimbursementOverride: 'cat-meeting',
      fields: { meeting_date: { value: '2026-03-01', uncertain: false } }
    })
    const stale = doc({
      id: 'd-stale',
      typeKey: 'meeting_minutes',
      reimbursementOverride: 'cat-meeting',
      reimbursementGroupOverride: 'grp-gone',
      fields: { meeting_date: { value: '2026-03-02', uncertain: false } }
    })
    const result = buildReimbursementTree([grouped, ungrouped, stale], groupedConfig, new Map())
    const node = result.tree[0]!
    expect(node.total).toBe(3)
    expect(node.customGroups[0]?.group.id).toBe('grp-a')
    expect(node.customGroups[0]?.buckets[0]?.documents.map((d) => d.id)).toEqual([grouped.id])
    expect(node.customGroups[1]?.buckets).toEqual([])
    // 未分组 + 陈旧分组 id 一律留在 人员→年月 列表
    const normalDocs = node.groups.flatMap((g) =>
      g.buckets.flatMap((b) => b.documents.map((d) => d.id))
    )
    expect(normalDocs).toEqual(expect.arrayContaining([ungrouped.id, stale.id]))
    expect(normalDocs).not.toContain(grouped.id)
  })

  it('keeps same-id custom groups in different categories separate', () => {
    // 两个类别各自定义同 id 的分组，分组 id 校验必须限定在条目所属类别内
    const sameIdConfig = reimbursementConfigSchema.parse({
      version: 1,
      categories: [
        {
          id: 'cat-a',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: ['meeting_minutes'],
          customGroups: [{ id: 'grp-a', name: '会议分组', sortOrder: 0 }],
          sortOrder: 1
        },
        {
          id: 'cat-b',
          name: '业务招待费',
          requiredMaterials: [],
          linkedTypeKeys: ['catering_receipt'],
          customGroups: [{ id: 'grp-a', name: '招待分组', sortOrder: 0 }],
          sortOrder: 2
        }
      ],
      personFieldKeys: ['buyer_name'],
      dateFieldKeys: ['invoice_date'],
      amountFieldKeys: ['total_amount'],
      dateGrouping: 'month'
    })
    const docA = doc({
      id: 'd-a',
      typeKey: 'meeting_minutes',
      reimbursementOverride: 'cat-a',
      reimbursementGroupOverride: 'grp-a',
      fields: { invoice_date: { value: '2026-04-01', uncertain: false } }
    })
    const docB = doc({
      id: 'd-b',
      typeKey: 'catering_receipt',
      reimbursementOverride: 'cat-b',
      reimbursementGroupOverride: 'grp-a',
      fields: { invoice_date: { value: '2026-05-01', uncertain: false } }
    })
    const result = buildReimbursementTree([docA, docB], sameIdConfig, new Map())
    const nodeA = result.tree.find((n) => n.category.id === 'cat-a')!
    const nodeB = result.tree.find((n) => n.category.id === 'cat-b')!
    expect(nodeA.customGroups[0]?.group.name).toBe('会议分组')
    expect(nodeA.customGroups[0]?.buckets[0]?.documents.map((d) => d.id)).toEqual(['d-a'])
    expect(nodeB.customGroups[0]?.group.name).toBe('招待分组')
    expect(nodeB.customGroups[0]?.buckets[0]?.documents.map((d) => d.id)).toEqual(['d-b'])
    // 每个类别的 人员→年月 列表都不应包含任何被分组条目
    for (const node of [nodeA, nodeB]) {
      const normalDocs = node.groups.flatMap((g) =>
        g.buckets.flatMap((b) => b.documents.map((d) => d.id))
      )
      expect(normalDocs).not.toContain('d-a')
      expect(normalDocs).not.toContain('d-b')
    }
  })

  it('groups category → person → period desc, unknown last', () => {
    const d1 = doc({
      id: 'd1',
      fields: {
        buyer_name: { value: '张三', uncertain: false },
        invoice_date: { value: '2026-09-01', uncertain: false },
        total_amount: { value: 100, uncertain: false }
      } as never
    })
    const d2 = doc({
      id: 'd2',
      fields: {
        buyer_name: { value: '张三', uncertain: false },
        invoice_date: { value: '2026-10-01', uncertain: false }
      } as never
    })
    const d3 = doc({ id: 'd3', fields: {} as never })
    const d4 = doc({ id: 'd4', typeKey: 'resume', fields: {} as never })
    const result = buildReimbursementTree([d1, d2, d3, d4], config, templateNameById)
    const catA = result.tree.find((n) => n.category.id === 'cat-a')!
    expect(catA.groups.map((g) => g.person)).toEqual(['张三', null])
    expect(catA.groups[0].buckets.map((b) => b.period)).toEqual(['2026-10', '2026-09'])
    expect(catA.materials[0]).toEqual({
      name: '发票',
      linkedTypeKeys: ['invoice_general'],
      count: 0
    })
    expect(result.unassigned.length).toBe(1)
    expect(result.summary).toEqual([
      { categoryId: 'cat-a', total: 3 },
      { categoryId: 'cat-b', total: 0 },
      { categoryId: null, total: 1 }
    ])
  })
})

function fakeStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    getSetting: <T>(key: string) => map.get(key) as T | undefined,
    setSetting: (key: string, value: unknown) => void map.set(key, value)
  }
}

describe('reimbursementConfig', () => {
  it('seeds defaults once and preserves user edits', () => {
    const store = fakeStore()
    const seeded = readReimbursementConfig(store)
    expect(seeded.categories.length).toBe(28)
    expect(readReimbursementConfig(store)).toEqual(seeded)
    const edited = {
      ...seeded,
      categories: [{ ...seeded.categories[0], name: '改名' }, ...seeded.categories.slice(1)]
    }
    writeReimbursementConfig(store, edited)
    expect(readReimbursementConfig(store)).toEqual(edited)
    expect(store.map.get(REIMBURSEMENT_SETTINGS_KEY)).toEqual(edited)
  })

  it('repairs corrupted config with defaults', () => {
    const store = fakeStore()
    store.setSetting(REIMBURSEMENT_SETTINGS_KEY, { broken: true })
    expect(readReimbursementConfig(store).version).toBe(1)
  })
})
