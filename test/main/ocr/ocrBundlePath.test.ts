import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const BUNDLE_ID = 'ppocrv6-small-native-20260719.1'

describe('resolveHelperAccessibleBundlePath', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ocr-bundle-path-'))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  const makeBundle = async (marker: string) => {
    const bundle = path.join(root, marker, 'bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(path.join(bundle, 'model.bin'), marker)
    return bundle
  }

  it.runIf(process.platform !== 'win32')('returns the original path off Windows', async () => {
    const bundle = await makeBundle('offwin')
    await expect(resolveHelperAccessibleBundlePath(bundle, root, BUNDLE_ID)).resolves.toBe(bundle)
  })

  it.runIf(process.platform === 'win32')('copies the bundle to a short path', async () => {
    const segments = Array.from({ length: 18 }, (_, i) => `segment-${i}-padding-padding`)
    const bundle = path.join(root, ...segments, 'bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(path.join(bundle, 'model.bin'), 'payload')
    expect(bundle.length).toBeGreaterThanOrEqual(260)

    const resolved = await resolveHelperAccessibleBundlePath(bundle, root, BUNDLE_ID)
    expect(resolved).toBe(path.join(root, 'bundle-copy'))
    expect(resolved.length).toBeLessThan(240)
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).resolves.toBe('payload')

    const again = await resolveHelperAccessibleBundlePath(bundle, root, BUNDLE_ID)
    expect(again).toBe(resolved)
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).resolves.toBe('payload')
  })

  it.runIf(process.platform === 'win32')('refreshes the copy on bundleId mismatch', async () => {
    const bundle = await makeBundle('first')
    const resolved = await resolveHelperAccessibleBundlePath(bundle, root, 'bundle-v1')
    expect(resolved).toBe(path.join(root, 'bundle-copy'))
    await expect(readFile(path.join(resolved, 'model.bin'), 'utf8')).resolves.toBe('first')

    const other = await makeBundle('second')
    const refreshed = await resolveHelperAccessibleBundlePath(other, root, 'bundle-v2')
    expect(refreshed).toBe(resolved)
    await expect(readFile(path.join(refreshed, 'model.bin'), 'utf8')).resolves.toBe('second')
  })

  it.runIf(process.platform === 'win32')('rebuilds a copy with a corrupted marker', async () => {
    const bundle = await makeBundle('payload')
    const copyPath = path.join(root, 'bundle-copy')
    await cp(bundle, copyPath, { recursive: true })
    await writeFile(path.join(root, 'bundle-copy.bundle-id'), 'stale-id')

    const resolved = await resolveHelperAccessibleBundlePath(bundle, root, BUNDLE_ID)
    expect(resolved).toBe(copyPath)
    await expect(readFile(path.join(root, 'bundle-copy.bundle-id'), 'utf8')).resolves.toBe(
      BUNDLE_ID
    )
  })

  it.runIf(process.platform === 'win32')('keeps the marker outside the bundle copy', async () => {
    const bundle = await makeBundle('payload')
    const resolved = await resolveHelperAccessibleBundlePath(bundle, root, BUNDLE_ID)
    await expect(readFile(path.join(resolved, '.bundle-id'), 'utf8')).rejects.toThrow()
  })
})
