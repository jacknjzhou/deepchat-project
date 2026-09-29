import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')
vi.unmock('path')
vi.unmock('node:path')

import { PdfFileAdapter, buildPdfEmbeddedTextCoverage } from '@/file/adapters/PdfFileAdapter'

describe('PdfFileAdapter embedded-text coverage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts substantive pages by Unicode code points and keeps bounded low-text samples', () => {
    const pages = [`${'字'.repeat(63)}😀`, 'short note', ...Array.from({ length: 24 }, () => '')]

    expect(buildPdfEmbeddedTextCoverage(26, pages)).toEqual({
      routingRevision: 'pdf-text-coverage-v1',
      pageCount: 26,
      substantivePageCount: 1,
      lowTextPageCount: 25,
      lowTextPageSamples: Array.from({ length: 20 }, (_, index) => index + 2),
      hasEmbeddedText: true
    })
  })

  it('treats missing parser pages as low text and rejects implausible page counts', () => {
    expect(buildPdfEmbeddedTextCoverage(3, ['text'])).toEqual({
      routingRevision: 'pdf-text-coverage-v1',
      pageCount: 3,
      substantivePageCount: 0,
      lowTextPageCount: 3,
      lowTextPageSamples: [1, 2, 3],
      hasEmbeddedText: true
    })
    expect(buildPdfEmbeddedTextCoverage(0, [])).toBeUndefined()
    expect(buildPdfEmbeddedTextCoverage(1_000_001, [])).toBeUndefined()
  })

  it('degrades filesystem read failures without retaining a rejected load promise', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const adapter = new PdfFileAdapter('/missing/deepchat-pdf-adapter-test.pdf', 1024)

    await expect(adapter.getTextCoverage()).resolves.toBeUndefined()
    await expect(adapter.getTextCoverage()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledTimes(1)
  })
})

function buildPdfFixture(objects: Buffer[]): Buffer {
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')]
  const offsets = [0]
  let byteOffset = chunks[0].byteLength

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteOffset)
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      objects[index],
      Buffer.from('\nendobj\n', 'ascii')
    ])
    chunks.push(object)
    byteOffset += object.byteLength
  }

  const xrefOffset = byteOffset
  const xrefEntries = offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii'
    )
  )
  return Buffer.concat(chunks)
}

// STSong-Light + UniGB-UCS2-H with no ToUnicode map: extracting text from
// this fixture requires pdfjs CMap data, otherwise the text is garbled.
function buildChineseCMapPdfFixture(): Buffer {
  const content = Buffer.from('BT /F1 36 Tf 30 35 Td <4E2D65876D4B8BD5> Tj ET', 'ascii')
  const fontDescriptor =
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 ' +
    '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 752 /Descent -271 ' +
    '/CapHeight 737 /StemV 58 /MissingWidth 500 >>'
  const descendantFont =
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> ' +
    `/DW 1000 /FontDescriptor ${fontDescriptor} >>`
  const font =
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ' +
    `/DescendantFonts [${descendantFont}] >>`

  return buildPdfFixture([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'ascii'
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.from(font, 'ascii')
  ])
}

function buildImageOnlyPdfFixture(): Buffer {
  const compressedRgb = deflateSync(Buffer.from([255, 255, 255]), { level: 9 })
  const content = Buffer.from('q\n700 0 0 260 0 0 cm\n/Im0 Do\nQ\n', 'ascii')
  return buildPdfFixture([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 260] ' +
        '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      'ascii'
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedRgb.byteLength} >>\nstream\n`,
        'ascii'
      ),
      compressedRgb,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii')
    ])
  ])
}

describe('PdfFileAdapter text extraction', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pdf-adapter-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const writeFixture = async (pdf: Buffer, name: string) => {
    const filePath = path.join(dir, name)
    await writeFile(filePath, pdf)
    return filePath
  }

  it('extracts Chinese text from a CMap-encoded PDF via UniGB-UCS2-H', async () => {
    const filePath = await writeFixture(buildChineseCMapPdfFixture(), 'chinese.pdf')
    const adapter = new PdfFileAdapter(filePath, 10 * 1024 * 1024)
    const content = await adapter.getPageContent(1)
    expect(content).toContain('中文测试')
  })

  it('reports no embedded text for image-only PDFs', async () => {
    const filePath = await writeFixture(buildImageOnlyPdfFixture(), 'raster.pdf')
    const adapter = new PdfFileAdapter(filePath, 10 * 1024 * 1024)
    const coverage = await adapter.getTextCoverage()
    expect(coverage).toMatchObject({ pageCount: 1, hasEmbeddedText: false })
    await expect(adapter.getPageContent(1)).resolves.toBe('')
  })

  it('returns undefined content for oversized PDFs without parsing', async () => {
    const filePath = await writeFixture(buildChineseCMapPdfFixture(), 'big.pdf')
    const adapter = new PdfFileAdapter(filePath, 1)
    await expect(adapter.getPageContent(1)).resolves.toBeUndefined()
  })
})
