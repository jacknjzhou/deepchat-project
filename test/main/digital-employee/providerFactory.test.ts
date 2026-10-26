import { describe, expect, it } from 'vitest'
import {
  MockDigitalEmployeeProvider,
  ResilientDigitalEmployeeProvider
} from '../../../src/main/digital-employee/provider'
import {
  createDigitalEmployeeProvider,
  createDigitalEmployeeProviderHolder
} from '../../../src/main/digital-employee/providerFactory'

const completeConfig = {
  enabled: true,
  baseUrl: 'https://sd.example',
  apiKey: 'sd_live_k1',
  externalUserId: 'user-1'
}

describe('createDigitalEmployeeProvider', () => {
  it('returns the fallback when StaffDeck is disabled', () => {
    const fallback = new MockDigitalEmployeeProvider()
    expect(createDigitalEmployeeProvider({ ...completeConfig, enabled: false }, fallback)).toBe(
      fallback
    )
  })

  it('returns a resilient http provider when the config is complete', () => {
    const provider = createDigitalEmployeeProvider(
      completeConfig,
      new MockDigitalEmployeeProvider()
    )

    expect(provider).toBeInstanceOf(ResilientDigitalEmployeeProvider)
    expect(provider.source).toBe('http')
  })

  it.each(['baseUrl', 'apiKey', 'externalUserId'] as const)(
    'returns the fallback when %s is missing',
    (key) => {
      const fallback = new MockDigitalEmployeeProvider()
      const provider = createDigitalEmployeeProvider({ ...completeConfig, [key]: '' }, fallback)
      expect(provider).toBe(fallback)
    }
  )
})

describe('createDigitalEmployeeProviderHolder', () => {
  it('exposes the initial provider until replaced', () => {
    const initial = new MockDigitalEmployeeProvider()
    const holder = createDigitalEmployeeProviderHolder(initial)
    expect(holder.current()).toBe(initial)

    const replacement = createDigitalEmployeeProvider(
      completeConfig,
      new MockDigitalEmployeeProvider()
    )
    holder.replace(replacement)
    expect(holder.current()).toBe(replacement)

    // 替换后的实例类型必须能从 holder 读出，供 routes 透传 source/degraded。
    expect(holder.current()).toBeInstanceOf(ResilientDigitalEmployeeProvider)
    expect(holder.current().source).toBe('http')
    expect(holder.current()).not.toBeInstanceOf(MockDigitalEmployeeProvider)
  })
})
