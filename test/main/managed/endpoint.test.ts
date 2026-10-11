import { describe, expect, it } from 'vitest'

import { resolveManagedEndpointInfo } from '@/managed/endpoint'

describe('resolveManagedEndpointInfo', () => {
  it('prefers runtime env over builtin', () => {
    expect(resolveManagedEndpointInfo('http://env/config', 'http://builtin/config')).toEqual({
      endpoint: 'http://env/config',
      source: 'env'
    })
  })

  it('falls back to builtin when env is missing', () => {
    expect(resolveManagedEndpointInfo(undefined, 'http://builtin/config')).toEqual({
      endpoint: 'http://builtin/config',
      source: 'builtin'
    })
  })

  it('treats empty or whitespace-only values as unset', () => {
    expect(resolveManagedEndpointInfo('   ', 'http://builtin/config')).toEqual({
      endpoint: 'http://builtin/config',
      source: 'builtin'
    })
    expect(resolveManagedEndpointInfo(undefined, undefined)).toEqual({
      endpoint: '',
      source: 'none'
    })
  })

  it('trims the returned endpoint', () => {
    expect(resolveManagedEndpointInfo('  http://env/config  ', undefined)).toEqual({
      endpoint: 'http://env/config',
      source: 'env'
    })
  })
})
