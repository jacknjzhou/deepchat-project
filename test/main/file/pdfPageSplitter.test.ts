// test/main/file/pdfPageSplitter.test.ts
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { splitPdfPagesToFile } from '@/file/adapters/pdfPageSplitter'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

let baseDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'pdf-split-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

// 两页源 PDF fixture（pdf-lib 生成；本测试只验证拆分行为，不做中文文本层断言）
async function createTwoPagePdf(target: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage()
    page.drawText(`invoice page ${i}`, { x: 40, y: 700, size: 24, font })
  }
  await writeFile(target, await doc.save())
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('splitPdfPagesToFile', () => {
  it('两页源 PDF → 两个单页产物 p1.pdf / p2.pdf，各自可加载且页数为 1', async () => {
    const src = path.join(baseDir, 'src.pdf')
    await createTwoPagePdf(src)
    const outDir = path.join(baseDir, 'out1')
    const products = await splitPdfPagesToFile(src, outDir)
    expect(products).toEqual([path.join(outDir, 'p1.pdf'), path.join(outDir, 'p2.pdf')])
    for (const product of products) {
      const doc = await PDFDocument.load(await readFile(product))
      expect(doc.getPageCount()).toBe(1)
    }
  })

  it('字节确定性：同一源页两次拆分产物哈希一致（元数据固定 epoch）', async () => {
    const src = path.join(baseDir, 'src.pdf')
    await createTwoPagePdf(src)
    const a = await splitPdfPagesToFile(src, path.join(baseDir, 'det-a'))
    const b = await splitPdfPagesToFile(src, path.join(baseDir, 'det-b'))
    expect(sha256(await readFile(a[0]!))).toBe(sha256(await readFile(b[0]!)))
    expect(sha256(await readFile(a[1]!))).toBe(sha256(await readFile(b[1]!)))
    // 页映射区分度：两页文本不同 → 产物哈希不同，锁定 p1 ← 源页 1 不退化
    expect(sha256(await readFile(a[0]!))).not.toBe(sha256(await readFile(a[1]!)))
  })
})
