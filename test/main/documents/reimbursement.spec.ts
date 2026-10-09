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

const validConfig = {
  version: 1 as const,
  categories: [
    {
      id: 'cat-meeting',
      name: '会议费',
      requiredMaterials: [{ name: '发票', linkedTypeKeys: ['invoice_general'] }],
      linkedTypeKeys: ['meeting_minutes'],
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

  it('rejects duplicate-empty category names and bad type keys', () => {
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
})
