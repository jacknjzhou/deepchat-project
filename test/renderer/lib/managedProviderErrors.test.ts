import { describe, expect, it } from 'vitest'
import { formatManagedProviderError } from '@/lib/managedProviderErrors'

const t = (key: string, params?: Record<string, string>) =>
  `${key}${params ? `:${JSON.stringify(params)}` : ''}`

describe('formatManagedProviderError', () => {
  it('maps providerLocked prefix to localized copy', () => {
    expect(
      formatManagedProviderError(
        '[managed.providerLocked:openai] This provider is managed by your organization and cannot be changed.',
        t
      )
    ).toBe('settings.managed.providerLocked')
  })
  it('returns null for unrelated errors', () => {
    expect(formatManagedProviderError('network timeout', t)).toBeNull()
  })
  it('returns null for malformed prefixed errors', () => {
    expect(formatManagedProviderError('[managed.providerLocked] x', t)).toBeNull()
    expect(formatManagedProviderError('[managed.providerLocked:openai x', t)).toBeNull()
    expect(formatManagedProviderError('[managed.providerLocked:] x', t)).toBeNull()
  })
})
