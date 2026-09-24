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

const { pdfMock, getPage, destroy } = vi.hoisted(() => ({
  pdfMock: vi.fn(),
  getPage: vi.fn(),
  destroy: vi.fn()
}))

vi.mock('pdf-to-img', () => ({ pdf: pdfMock }))

import { PDF_VISION_MAX_PAGES, renderPdfPagesToDataUrls } from '@/file/adapters/pdfPageRenderer'

const makePng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: 'white' } })
    .png()
    .toBuffer()

describe('renderPdfPagesToDataUrls', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renderer-'))
    filePath = path.join(dir, 'sample.pdf')
    await fs.writeFile(filePath, '%PDF-1.4 mock')
    getPage.mockReset()
    destroy.mockReset()
    destroy.mockResolvedValue(undefined)
    pdfMock.mockClear()
    pdfMock.mockImplementation(async () => ({ length: 2, getPage, destroy }))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('renders each page, compresses to jpeg dataURL within maxDimension', async () => {
    getPage.mockImplementation(async (page: number) =>
      page === 1 ? makePng(2400, 1600) : makePng(800, 600)
    )
    const { dataUrls, pageCount } = await renderPdfPagesToDataUrls(filePath)
    expect(pageCount).toBe(2)
    expect(dataUrls).toHaveLength(2)
    expect(dataUrls[0]).toMatch(/^data:image\/jpeg;base64,/)
    const meta = await sharp(
      Buffer.from(dataUrls[0].replace(/^data:image\/\w+;base64,/, ''), 'base64')
    ).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048)
    expect(getPage).toHaveBeenNthCalledWith(1, 1)
    expect(getPage).toHaveBeenNthCalledWith(2, 2)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('truncates pages beyond PDF_VISION_MAX_PAGES and reports total pageCount', async () => {
    pdfMock.mockImplementation(async () => ({
      length: PDF_VISION_MAX_PAGES + 3,
      getPage: async () => makePng(600, 400),
      destroy
    }))
    const { dataUrls, pageCount } = await renderPdfPagesToDataUrls(filePath)
    expect(pageCount).toBe(PDF_VISION_MAX_PAGES + 3)
    expect(dataUrls).toHaveLength(PDF_VISION_MAX_PAGES)
  })

  it('propagates getPage errors and still destroys the document once', async () => {
    getPage.mockImplementation(async () => {
      throw new Error('boom')
    })
    await expect(renderPdfPagesToDataUrls(filePath)).rejects.toThrow('boom')
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
