import { describe, expect, it } from 'vitest'
import { formatDocumentsTaskError } from '@/lib/documentsTaskErrors'

const t = (key: string, params?: Record<string, string>) =>
  `${key}${params ? `:${JSON.stringify(params)}` : ''}`

describe('formatDocumentsTaskError', () => {
  it('maps modelRequired prefix', () => {
    expect(
      formatDocumentsTaskError(
        '[documents.modelRequired] No documents extraction model configured.',
        t
      )
    ).toBe('documents.errors.modelRequired')
  })
  it('maps providerMissing with provider param', () => {
    expect(formatDocumentsTaskError('[documents.providerMissing:g1|m1] boom', t)).toBe(
      'documents.errors.modelProviderMissing:{"provider":"g1"}'
    )
  })
  it('maps providerDisabled to the same copy as providerMissing', () => {
    expect(formatDocumentsTaskError('[documents.providerDisabled:g2|m1] boom', t)).toBe(
      'documents.errors.modelProviderMissing:{"provider":"g2"}'
    )
  })
  it('maps modelMissing with model param', () => {
    expect(formatDocumentsTaskError('[documents.modelMissing:p1|mx] boom', t)).toBe(
      'documents.errors.modelMissing:{"model":"mx"}'
    )
  })
  it('returns null for unrelated errors', () => {
    expect(formatDocumentsTaskError('network timeout', t)).toBeNull()
  })
})
