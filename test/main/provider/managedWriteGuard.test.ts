import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { assertProviderWritable } from '@/provider/managedGuard'

describe('assertProviderWritable', () => {
  const readProviderIds = vi.fn(() => ['managed-corp-gw'])

  it('throws for managed provider on update', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'update', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp-gw\]/
    )
  })

  it('throws for managed provider on remove', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'remove', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp-gw\]/
    )
  })

  it('allows the builtin new-api entry', () => {
    expect(() => assertProviderWritable('new-api', 'update', readProviderIds)).not.toThrow()
  })

  it('allows user-created instances of the same apiType', () => {
    expect(() => assertProviderWritable('my-newapi', 'remove', readProviderIds)).not.toThrow()
    expect(() =>
      assertProviderWritable('managed-corp-gw-2', 'remove', readProviderIds)
    ).not.toThrow()
    expect(() => assertProviderWritable('MANAGED-CORP-GW', 'remove', readProviderIds)).not.toThrow()
  })

  it('allows everything when nothing is managed', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'update', () => [])).not.toThrow()
  })
})
