import { describe, expect, it, vi } from 'vitest'

describe('documents router', () => {
  it('registers the /documents archive route pointing at the archive page', async () => {
    vi.resetModules()
    vi.doMock('vue-router', async () => vi.importActual<typeof import('vue-router')>('vue-router'))
    const router = (await import('../../../src/renderer/src/router')).default

    expect(router.resolve('/documents').name).toBe('documents')
    expect(router.resolve('/documents').matched[0]?.components?.default).toBeDefined()
  })
})
