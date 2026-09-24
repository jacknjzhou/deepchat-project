import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')
vi.unmock('path')
vi.unmock('node:path')

import { ImageFileAdapter } from '@/file/adapters/ImageFileAdapter'

describe('ImageFileAdapter.getLLMContent', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'img-adapter-'))
    filePath = path.join(dir, 'sample.png')
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: 'white' }
    })
      .png()
      .toFile(filePath)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const decoded = (dataUrl: string) =>
    sharp(Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'))

  it('defaults to 1200px and jpeg quality compatible output', async () => {
    const adapter = new ImageFileAdapter(filePath, 30 * 1024 * 1024)
    const dataUrl = await adapter.getLLMContent()
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    const meta = await decoded(dataUrl!).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1200)
  })

  it('accepts higher maxDimension and quality for document extraction', async () => {
    const adapter = new ImageFileAdapter(filePath, 30 * 1024 * 1024)
    const dataUrl = await adapter.getLLMContent({ maxDimension: 2048, jpegQuality: 85 })
    const meta = await decoded(dataUrl!).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(2048)
  })

  it('returns undefined when file exceeds maxFileSize', async () => {
    const adapter = new ImageFileAdapter(filePath, 10)
    expect(await adapter.getLLMContent()).toBeUndefined()
  })
})
