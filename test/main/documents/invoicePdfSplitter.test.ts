import { describe, expect, it, vi } from 'vitest'
import {
  expandSubmissionFiles,
  isMultiInvoicePages,
  type InvoiceSplitDeps
} from '@/documents/invoicePdfSplitter'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

const pdfFile = (path = 'C:\\合并发票.pdf', name?: string) => ({
  path,
  ...(name !== undefined ? { name } : {}),
  mimeType: 'application/pdf'
})

const twoInvoicePages = [
  '电子发票（普通发票） 发票号码：25957000000181334458 开票日期：2025年12月09日 价税合计 ¥18.00',
  '电子发票（普通发票） 发票号码：25957000000181335300 开票日期：2025年12月08日 价税合计 ¥110.00'
]

const makeDeps = (overrides: Partial<InvoiceSplitDeps> = {}): InvoiceSplitDeps => ({
  extractPdfPagesText: vi.fn(async () => twoInvoicePages),
  splitPdfPages: vi.fn(async (_filePath: string, outDir: string) => [
    `${outDir}\\p1.pdf`,
    `${outDir}\\p2.pdf`
  ]),
  makeWorkDir: vi.fn(async () => 'C:\\split\\uuid-1'),
  ...overrides
})

describe('isMultiInvoicePages', () => {
  it('每页恰好一张发票（2 页及以上）→ true', () => {
    expect(isMultiInvoicePages(twoInvoicePages)).toBe(true)
    expect(isMultiInvoicePages([...twoInvoicePages, ...twoInvoicePages])).toBe(true)
  })

  it('单页文件 → false', () => {
    expect(isMultiInvoicePages([twoInvoicePages[0]!])).toBe(false)
  })

  it('含非发票页（无发票号码）→ false', () => {
    expect(isMultiInvoicePages([...twoInvoicePages, '报销单封面，无发票内容'])).toBe(false)
  })

  it('一页多张发票（发票号码出现 2 次）→ false', () => {
    const merged = `${twoInvoicePages[0]}\n${twoInvoicePages[1]}`
    expect(isMultiInvoicePages([merged, twoInvoicePages[1]!])).toBe(false)
  })
})

describe('expandSubmissionFiles', () => {
  it('多发票 PDF：拆分为逐页产物，显示名带序号，sourceOf 指向源文件', async () => {
    const deps = makeDeps()
    const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({
      path: 'C:\\split\\uuid-1\\p1.pdf',
      name: '合并发票（第1张）.pdf',
      mimeType: 'application/pdf'
    })
    expect(files[1]).toMatchObject({
      path: 'C:\\split\\uuid-1\\p2.pdf',
      name: '合并发票（第2张）.pdf'
    })
    expect(sourceOf.get('C:\\split\\uuid-1\\p1.pdf')).toBe('C:\\合并发票.pdf')
    expect(sourceOf.get('C:\\split\\uuid-1\\p2.pdf')).toBe('C:\\合并发票.pdf')
  })

  it('无文本层（总文本过短，即便页数达标）→ 原样透传', async () => {
    const deps = makeDeps({
      extractPdfPagesText: vi.fn(async () => ['发票号码：12345678', '发票号码：87654321'])
    })
    const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(sourceOf.size).toBe(0)
  })

  it('单页 PDF / 含非发票页 / 一页多票 → 原样透传', async () => {
    for (const pages of [
      [twoInvoicePages[0]!],
      [...twoInvoicePages, '封面页无发票'],
      [`${twoInvoicePages[0]}\n${twoInvoicePages[1]}`, twoInvoicePages[1]!]
    ]) {
      const deps = makeDeps({ extractPdfPagesText: vi.fn(async () => pages) })
      const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
      expect(files[0]?.path).toBe('C:\\合并发票.pdf')
      expect(sourceOf.size).toBe(0)
    }
  })

  it('非 PDF 文件（mimeType 图片 / 扩展名）→ 不调提取直接透传', async () => {
    const extractPdfPagesText = vi.fn(async () => twoInvoicePages)
    const deps = makeDeps({ extractPdfPagesText })
    const { files, sourceOf } = await expandSubmissionFiles(
      [{ path: 'C:\\photo.png', mimeType: 'image/png' }, { path: 'C:\\scan.jpg' }, pdfFile()],
      deps
    )
    expect(extractPdfPagesText).toHaveBeenCalledTimes(1)
    expect(files).toHaveLength(4)
    expect(files[0]?.path).toBe('C:\\photo.png')
    expect(files[1]?.path).toBe('C:\\scan.jpg')
    expect(sourceOf.size).toBe(2)
  })

  it('无 mimeType 时按 .pdf 扩展名判断', async () => {
    const extractPdfPagesText = vi.fn(async () => twoInvoicePages)
    const deps = makeDeps({ extractPdfPagesText })
    const { sourceOf } = await expandSubmissionFiles([{ path: 'C:\\合并发票.PDF' }], deps)
    expect(sourceOf.size).toBe(2)
  })

  it('提取失败（null）或拆分抛错 → fail-open 原样透传', async () => {
    const nullDeps = makeDeps({ extractPdfPagesText: vi.fn(async () => null) })
    const r1 = await expandSubmissionFiles([pdfFile()], nullDeps)
    expect(r1.files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(r1.sourceOf.size).toBe(0)

    const throwDeps = makeDeps({
      splitPdfPages: vi.fn(async () => {
        throw new Error('disk full')
      })
    })
    const r2 = await expandSubmissionFiles([pdfFile()], throwDeps)
    expect(r2.files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(r2.sourceOf.size).toBe(0)
  })

  it('显示名优先用 file.name 且净化非法字符；无 name 用路径 stem', async () => {
    const deps = makeDeps()
    const { files } = await expandSubmissionFiles(
      [pdfFile('C:\\dir\\报告:最终版.pdf', '通讯费:12月.pdf')],
      deps
    )
    expect(files[0]?.name).toBe('通讯费_12月（第1张）.pdf')
    const { files: noName } = await expandSubmissionFiles([pdfFile('C:\\dir\\话费发票.pdf')], deps)
    expect(noName[0]?.name).toBe('话费发票（第1张）.pdf')
  })

  it('多文件混合：仅拆分命中的文件，其余保持原顺序', async () => {
    // 按路径区分：单页.pdf 仅 1 页，其余 PDF 为双发票合并件
    const deps = makeDeps({
      extractPdfPagesText: vi.fn(async (filePath: string) =>
        filePath.includes('单页') ? [twoInvoicePages[0]!] : twoInvoicePages
      )
    })
    const { files, sourceOf } = await expandSubmissionFiles(
      [{ path: 'C:\\a.png', mimeType: 'image/png' }, pdfFile(), pdfFile('C:\\单页.pdf')],
      deps
    )
    expect(files.map((f) => f.path)).toEqual([
      'C:\\a.png',
      'C:\\split\\uuid-1\\p1.pdf',
      'C:\\split\\uuid-1\\p2.pdf',
      'C:\\单页.pdf'
    ])
    expect(sourceOf.size).toBe(2)
  })
})
