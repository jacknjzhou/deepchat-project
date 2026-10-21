// src/main/file/adapters/pdfPageSplitter.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

/**
 * 逐页导出单页 PDF：产物不携带可变元数据（创建/修改时间固定为 epoch），
 * 同一源页的产物字节确定 → 内容哈希（sha256File）可复现，去重按发票页粒度生效。
 */
export async function splitPdfPagesToFile(filePath: string, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true })
  const src = await PDFDocument.load(await readFile(filePath))
  const products: string[] = []
  for (let i = 0; i < src.getPageCount(); i++) {
    const doc = await PDFDocument.create()
    doc.setCreationDate(new Date(0))
    doc.setModificationDate(new Date(0))
    const [page] = await doc.copyPages(src, [i])
    doc.addPage(page)
    const target = path.join(outDir, `p${i + 1}.pdf`)
    await writeFile(target, await doc.save())
    products.push(target)
  }
  return products
}
