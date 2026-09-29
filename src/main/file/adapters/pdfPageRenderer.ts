import { readFile } from 'node:fs/promises'

import { pdf } from 'pdf-to-img'
import sharp from 'sharp'

import { resolvePdfJsAssetDirs } from './pdfJsAssets'

export const PDF_VISION_MAX_PAGES = 12
const PAGE_RENDER_SCALE = 2

export interface PdfPagesRenderResult {
  dataUrls: string[]
  pageCount: number
}

export async function renderPdfPagesToDataUrls(
  filePath: string,
  options: { maxPages?: number; maxDimension?: number; jpegQuality?: number } = {}
): Promise<PdfPagesRenderResult> {
  const { maxPages = PDF_VISION_MAX_PAGES, maxDimension = 2048, jpegQuality = 85 } = options
  const buffer = await readFile(filePath)
  // Explicit asset dirs override pdf-to-img's defaults, which resolve inside
  // app.asar in packaged builds — there CMap/standard-font loads fail and
  // CJK PDF pages render with garbled text for the vision model.
  const { cMapUrl, standardFontDataUrl, wasmUrl } = resolvePdfJsAssetDirs()
  const document = await pdf(buffer, {
    scale: PAGE_RENDER_SCALE,
    docInitParams: { cMapUrl, cMapPacked: true, standardFontDataUrl, wasmUrl }
  })
  const pageCount = document.length
  const dataUrls: string[] = []
  try {
    for (let page = 1; page <= Math.min(pageCount, maxPages); page += 1) {
      const png = await document.getPage(page)
      const jpeg = await sharp(png)
        .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer()
      dataUrls.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    }
  } finally {
    await document.destroy()
  }
  return { dataUrls, pageCount }
}
