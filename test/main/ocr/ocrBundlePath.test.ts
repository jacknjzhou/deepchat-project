import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')
vi.unmock('path')
vi.unmock('node:path')

import { resolveHelperAccessibleBundlePath } from '@/ocr/ocrRuntimeService'

describe('resolveHelperAccessibleBundlePath', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ocr-bundle-path-'))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it.runIf(process.platform !== 'win32')('returns the original path off Windows', async () => {
    const bundle = path.join(root, 'bundle')
    await mkdir(bundle)
    await expect(resolveHelperAccessibleBundlePath(bundle, root)).resolves.toBe(bundle)
  })

  it.runIf(process.platform === 'win32')('exposes short bundles via junction too', async () => {
    const bundle = path.join(root, 'bundle')
    await mkdir(bundle)
    await writeFile(path.join(bundle, 'model.bin'), 'payload')

    const resolved = await resolveHelperAccessibleBundlePath(bundle, root)
    expect(resolved).toBe(path.join(root, 'bundle-link'))
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).resolves.toBe('payload')
  })

  it.runIf(process.platform === 'win32')('creates a short junction for a long path', async () => {
    const segments = Array.from({ length: 18 }, (_, i) => `segment-${i}-padding-padding`)
    const bundle = path.join(root, ...segments, 'bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(path.join(bundle, 'model.bin'), 'payload')
    expect(bundle.length).toBeGreaterThanOrEqual(260)

    const resolved = await resolveHelperAccessibleBundlePath(bundle, root)
    expect(resolved).toBe(path.join(root, 'bundle-link'))
    expect(resolved.length).toBeLessThan(240)
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).resolves.toBe('payload')

    const again = await resolveHelperAccessibleBundlePath(bundle, root)
    expect(again).toBe(resolved)

    const other = path.join(root, ...segments, 'other-bundle')
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, 'model.bin'), 'replaced')
    const changed = await resolveHelperAccessibleBundlePath(other, root)
    expect(changed).toBe(path.join(root, 'bundle-link'))
    await expect(readFile(path.join(changed, 'model.bin'), 'utf8')).resolves.toBe('replaced')
  })

  it.runIf(process.platform === 'win32')('replaces a broken link target', async () => {
    const segments = Array.from({ length: 18 }, (_, i) => `segment-${i}-padding-padding`)
    const bundle = path.join(root, ...segments, 'bundle')
    await mkdir(bundle, { recursive: true })
    const linkPath = path.join(root, 'bundle-link')
    await symlink(path.join(root, 'missing-target'), linkPath, 'junction')

    const resolved = await resolveHelperAccessibleBundlePath(bundle, root)
    expect(resolved).toBe(linkPath)
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).rejects.toThrow()
  })
})
