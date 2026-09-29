import { BaseFileAdapter } from './BaseFileAdapter'
import fs from 'fs/promises'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  PDF_LOW_TEXT_PAGE_SAMPLE_LIMIT,
  PDF_ROUTING_REVISION,
  PDF_SUBSTANTIVE_TEXT_MIN_CODE_POINTS,
  PDF_PAGE_COUNT_SANITY_LIMIT,
  type PdfEmbeddedTextCoverage
} from '@shared/types/attachment'
import { resolvePdfJsAssetDirs } from './pdfJsAssets'

interface PdfPageInfo {
  PDFFormatVersion?: string
  Producer?: string
  Creator?: string
}

interface LoadedPdfText {
  numpages: number
  pageContents: string[]
  info: PdfPageInfo | null
}

export class PdfFileAdapter extends BaseFileAdapter {
  private fileContent: string | undefined
  private maxFileSize: number
  private textCoverage: PdfEmbeddedTextCoverage | undefined
  private pdfLoadPromise: Promise<LoadedPdfText | undefined> | undefined

  constructor(filePath: string, maxFileSize: number) {
    super(filePath)
    this.maxFileSize = maxFileSize
  }

  protected getFileDescription(): string | undefined {
    return 'PDF Document'
  }

  private loadPdfData(): Promise<LoadedPdfText | undefined> {
    this.pdfLoadPromise ??= this.readPdfData().catch((error) => {
      console.error('Error reading PDF:', error)
      return undefined
    })
    return this.pdfLoadPromise
  }

  private async readPdfData(): Promise<LoadedPdfText | undefined> {
    const stats = await fs.stat(this.filePath)
    if (stats.size > this.maxFileSize) return undefined
    const buffer = await fs.readFile(this.filePath)

    // pdf-parse-new (still used by OCR smoke fixtures) can leave a stale v4
    // pdfjs worker on globalThis; pdfjs-dist prefers that global and crashes
    // on version mismatch, so clear it before opening a document.
    delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker

    // Chinese invoice PDFs rely on CMap-encoded fonts; without these asset
    // dirs the extracted text is garbled and recognition silently degrades.
    const { cMapUrl, standardFontDataUrl, wasmUrl } = resolvePdfJsAssetDirs()
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      wasmUrl,
      // Suppress PDF.js warn() noise (e.g. benign font fallbacks); real
      // failures still throw from the API calls below.
      verbosity: 0
    })
    const document = await loadingTask.promise

    try {
      const pageContents: string[] = []
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        const textContent = await page.getTextContent()
        pageContents.push(
          extractPageText(textContent.items as Array<{ str?: string; transform?: number[] }>)
        )
      }
      this.textCoverage = buildPdfEmbeddedTextCoverage(document.numPages, pageContents)
      const metadata = await document.getMetadata().catch(() => null)
      return {
        numpages: document.numPages,
        pageContents,
        info: (metadata?.info ?? null) as PdfPageInfo | null
      }
    } finally {
      await loadingTask.destroy()
    }
  }

  public async getTextCoverage(): Promise<PdfEmbeddedTextCoverage | undefined> {
    await this.loadPdfData()
    return this.textCoverage
      ? { ...this.textCoverage, lowTextPageSamples: [...this.textCoverage.lowTextPageSamples] }
      : undefined
  }

  private convertTextToMarkdown(text: string): string {
    // Split text into lines and then paragraphs
    const lines = text.split('\n')
    const paragraphs: string[] = []
    let currentParagraph = ''

    // Group lines into paragraphs
    for (const line of lines) {
      const trimmedLine = line.trim()

      // If line is empty and we have content in current paragraph, push it and reset
      if (!trimmedLine && currentParagraph) {
        paragraphs.push(currentParagraph)
        currentParagraph = ''
        continue
      }

      // If line is not empty, add it to current paragraph
      if (trimmedLine) {
        if (currentParagraph) {
          // Check if this might be a new paragraph or continuation
          // Heuristic: If line starts with lowercase and previous ends with period, likely continuation
          const lastChar = currentParagraph[currentParagraph.length - 1]
          const firstChar = trimmedLine[0]

          if (
            (lastChar === '.' || lastChar === '?' || lastChar === '!') &&
            firstChar === firstChar.toUpperCase() &&
            /[a-zA-Z]/.test(firstChar)
          ) {
            // Likely a new sentence in a new paragraph
            paragraphs.push(currentParagraph)
            currentParagraph = trimmedLine
          } else {
            // Continuation of current paragraph
            currentParagraph += ' ' + trimmedLine
          }
        } else {
          currentParagraph = trimmedLine
        }
      }
    }

    // Add the last paragraph if there's content
    if (currentParagraph) {
      paragraphs.push(currentParagraph)
    }

    // Process each paragraph to determine its type and format accordingly
    const markdownParagraphs = paragraphs.map((paragraph) => {
      // Skip empty paragraphs
      if (!paragraph.trim()) return ''

      // Check if paragraph is a heading (simple heuristics)
      if (paragraph.length < 100) {
        // Likely a main heading (all caps, short)
        if (paragraph === paragraph.toUpperCase() && paragraph.length < 50) {
          return `# ${paragraph}`
        }

        // Likely a subheading (ends with colon, no period)
        if (paragraph.endsWith(':') && !paragraph.includes('.')) {
          return `## ${paragraph}`
        }

        // Possible section heading (short, no punctuation at end)
        if (paragraph.length < 60 && !/[.,:;?!]$/.test(paragraph) && /^[A-Z0-9]/.test(paragraph)) {
          return `### ${paragraph}`
        }
      }

      // Check if paragraph is a numbered list item
      if (/^\d+\.?\s/.test(paragraph)) {
        // Ensure proper Markdown numbered list format
        return paragraph.replace(/^(\d+)\.?\s/, '$1. ')
      }

      // Check if paragraph is a bullet point
      if (/^[•\-*]\s/.test(paragraph)) {
        // Ensure proper Markdown bullet list format
        return paragraph.replace(/^[•\-*]\s/, '* ')
      }

      // Check for table-like content (contains multiple tabs or spaces in sequence)
      if (paragraph.includes('\t') || /\s{3,}/.test(paragraph)) {
        // Convert to code block for better preservation of formatting
        return '```\n' + paragraph + '\n```'
      }

      // Regular paragraph
      return paragraph
    })

    // Join paragraphs with double newlines
    return markdownParagraphs.filter((p) => p).join('\n\n')
  }

  // Get raw text content for specified page
  public async getPageContent(pageNumber: number): Promise<string | undefined> {
    const pdfData = await this.loadPdfData()
    if (!pdfData || !pdfData.pageContents) return undefined

    // Page numbers start from 1, array index starts from 0
    const pageIndex = pageNumber - 1
    if (pageIndex < 0 || pageIndex >= pdfData.pageContents.length) {
      return undefined
    }

    return pdfData.pageContents[pageIndex]
  }

  // Get Markdown format content for specified page
  public async getPageMarkdown(pageNumber: number): Promise<string | undefined> {
    const pageContent = await this.getPageContent(pageNumber)
    if (!pageContent) return undefined

    return this.convertTextToMarkdown(pageContent)
  }

  // Get Markdown format content for all pages
  public async getAllPagesMarkdown(): Promise<string[] | undefined> {
    const pdfData = await this.loadPdfData()
    if (!pdfData || !pdfData.pageContents) return undefined

    return pdfData.pageContents.map((pageContent) => this.convertTextToMarkdown(pageContent))
  }

  async getContent(): Promise<string | undefined> {
    if (this.fileContent === undefined) {
      const pdfData = await this.loadPdfData()
      if (pdfData) {
        this.fileContent = pdfData.pageContents.join('\n\n--- Page Separator ---\n\n')
      }
    }
    return this.fileContent
  }

  public async getLLMContent(): Promise<string | undefined> {
    const pdfData = await this.loadPdfData()
    if (!pdfData) return undefined

    // Get Markdown content for all pages
    const markdownPages = pdfData.pageContents.map((pageContent, index) => {
      const pageNumber = index + 1
      const pageMarkdown = this.convertTextToMarkdown(pageContent)
      return `## Page ${pageNumber}\n\n${pageMarkdown}`
    })

    const allPagesMarkdown = markdownPages.join('\n\n---\n\n')

    const fileDescription = `
      # PDF file description

      ## Basic PDF file information
      * **Total pages:** ${pdfData.numpages}
      * **PDF version:** ${pdfData.info?.PDFFormatVersion || 'Unknown'}
      * **PDF generator:** ${pdfData.info?.Producer || 'Unknown'}
      * **PDF creator:** ${pdfData.info?.Creator || 'Unknown'}

      ## PDF content (page by page)
      ${allPagesMarkdown}
`
    return fileDescription
  }

  async getThumbnail(): Promise<string | undefined> {
    return ''
  }
}

// Process text items, preserving line breaks via the same Y-gap heuristic the
// previous pdf-parse-new renderer used (5pt vertical delta starts a new line).
function extractPageText(items: Array<{ str?: string; transform?: number[] }>): string {
  let lastY: number | null = null
  let text = ''
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.transform) continue
    const y = item.transform[5]
    if (lastY === null || Math.abs(lastY - y) > 5) {
      if (text) text += '\n'
      lastY = y
    } else if (text && !text.endsWith(' ')) {
      text += ' '
    }
    text += item.str
  }
  return text
}

export function buildPdfEmbeddedTextCoverage(
  pageCount: number,
  pageTexts: readonly string[]
): PdfEmbeddedTextCoverage | undefined {
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    pageCount > PDF_PAGE_COUNT_SANITY_LIMIT
  ) {
    return undefined
  }
  let substantivePageCount = 0
  let hasEmbeddedText = false
  const lowTextPageSamples: number[] = []

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const nonWhitespaceCodePoints = countNonWhitespaceCodePoints(
      pageTexts[pageIndex] ?? '',
      PDF_SUBSTANTIVE_TEXT_MIN_CODE_POINTS
    )
    hasEmbeddedText ||= nonWhitespaceCodePoints > 0
    if (nonWhitespaceCodePoints >= PDF_SUBSTANTIVE_TEXT_MIN_CODE_POINTS) {
      substantivePageCount += 1
    } else if (lowTextPageSamples.length < PDF_LOW_TEXT_PAGE_SAMPLE_LIMIT) {
      lowTextPageSamples.push(pageIndex + 1)
    }
  }

  return {
    routingRevision: PDF_ROUTING_REVISION,
    pageCount,
    substantivePageCount,
    lowTextPageCount: pageCount - substantivePageCount,
    lowTextPageSamples,
    hasEmbeddedText
  }
}

function countNonWhitespaceCodePoints(text: string, limit: number): number {
  let count = 0
  for (const character of text) {
    if (character !== '\u0000' && /\S/u.test(character)) {
      count += 1
      if (count >= limit) break
    }
  }
  return count
}
