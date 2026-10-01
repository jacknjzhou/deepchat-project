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
  it('maps providerLocked prefix behind the real ipc wrapper', () => {
    // 真实调用链传入的是 catch 到的 Error 经 String(error) 的结果，
    // 形如 errors.test.ts 中的 "Error invoking remote method 'deepchat:route:invoke': Error: ..."
    const ipcWrapped = String(
      new Error(
        "Error invoking remote method 'deepchat:route:invoke': Error: [managed.providerLocked:managed-corp-gw] This provider is managed by your organization and cannot be changed."
      )
    )
    expect(ipcWrapped).toBe(
      "Error: Error invoking remote method 'deepchat:route:invoke': Error: [managed.providerLocked:managed-corp-gw] This provider is managed by your organization and cannot be changed."
    )
    expect(formatManagedProviderError(ipcWrapped, t)).toBe('settings.managed.providerLocked')
  })
  it('returns null for unrelated errors', () => {
    expect(formatManagedProviderError('network timeout', t)).toBeNull()
  })
  it('returns null for unrelated ipc errors', () => {
    expect(
      formatManagedProviderError(
        String(
          new Error("Error invoking remote method 'deepchat:route:invoke': Error: network timeout")
        ),
        t
      )
    ).toBeNull()
  })
  it('returns null for malformed prefixed errors', () => {
    expect(formatManagedProviderError('[managed.providerLocked] x', t)).toBeNull()
    expect(formatManagedProviderError('[managed.providerLocked:openai x', t)).toBeNull()
    expect(formatManagedProviderError('[managed.providerLocked:] x', t)).toBeNull()
  })
})
