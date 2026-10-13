import type { DocumentExtractFileInput } from './extractor/documentExtractor'

/** 发票号码模式：全电发票 20 位、增值税普票 8 位均以 8 位起步数字覆盖 */
export const INVOICE_NO_PATTERN = /发票号码[:：]?\s*\d{8,}/

/** 文本层判定阈值，与 composition extractPdfText 的 hasTextLayer 判定保持一致 */
const TEXT_LAYER_MIN_CHARS = 200

export interface InvoiceSplitDeps {
  /** 分页文本；null = 非 PDF 或读取/解析失败 */
  extractPdfPagesText: (filePath: string) => Promise<string[] | null>
  /** 逐页导出单页 PDF 到 outDir，返回按页序排列的产物路径 */
  splitPdfPages: (filePath: string, outDir: string) => Promise<string[]>
  /** 创建本次拆分的专属工作目录（uuid 隔离），失败由调用方 fail-open */
  makeWorkDir: () => Promise<string>
}

export interface ExpandedSubmission {
  files: DocumentExtractFileInput[]
  /** 产物 path → 源文件 path；仅被拆分的源文件产生条目 */
  sourceOf: Map<string, string>
}

/**
 * 多发票合并件判定（保守优先）：页数 ≥ 2 且每页文本恰好命中一次发票号码。
 * 任一页 0 次（夹带非发票页）或 ≥ 2 次（一页多票）→ 不拆。
 */
export function isMultiInvoicePages(pages: string[]): boolean {
  if (pages.length < 2) return false
  return pages.every((page) => {
    const matches = page.match(new RegExp(INVOICE_NO_PATTERN.source, 'g'))
    return matches !== null && matches.length === 1
  })
}

const isPdfFile = (file: DocumentExtractFileInput): boolean =>
  file.mimeType ? file.mimeType === 'application/pdf' : /\.pdf$/i.test(file.path)

// 与 contentDedupe/taskManager 的显示名回退逻辑保持一致
const displayStem = (file: DocumentExtractFileInput): string => {
  const raw = file.name ?? file.path.split(/[\\/]/).pop() ?? file.path
  const stem = raw.replace(/\.pdf$/i, '')
  // Windows 文件名非法字符净化（冒号等），避免产物显示名落盘/展示异常
  return stem.replace(/[\\/:*?"<>|]/g, '_')
}

async function expandOne(
  file: DocumentExtractFileInput,
  deps: InvoiceSplitDeps
): Promise<DocumentExtractFileInput[] | null> {
  if (!isPdfFile(file)) return null
  const pages = await deps.extractPdfPagesText(file.path)
  if (pages === null || pages.length < 2) return null
  if (pages.join('').replace(/\s/g, '').length < TEXT_LAYER_MIN_CHARS) return null
  if (!isMultiInvoicePages(pages)) return null
  const outDir = await deps.makeWorkDir()
  const productPaths = await deps.splitPdfPages(file.path, outDir)
  const stem = displayStem(file)
  return productPaths.map((p, i) => ({
    path: p,
    name: `${stem}（第${i + 1}张）.pdf`,
    mimeType: 'application/pdf'
  }))
}

/**
 * 提交前展开：多发票合并件 → N 个单页产物文件，其余原样透传。
 * fail-open：单个文件检测/拆分任何环节抛错 → 该文件原样透传，绝不阻塞提交。
 */
export async function expandSubmissionFiles(
  files: DocumentExtractFileInput[],
  deps: InvoiceSplitDeps
): Promise<ExpandedSubmission> {
  const out: DocumentExtractFileInput[] = []
  const sourceOf = new Map<string, string>()
  for (const file of files) {
    try {
      const products = await expandOne(file, deps)
      if (products === null) {
        out.push(file)
        continue
      }
      for (const product of products) {
        out.push(product)
        sourceOf.set(product.path, file.path)
      }
    } catch {
      out.push(file)
    }
  }
  return { files: out, sourceOf }
}
