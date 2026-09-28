import * as path from 'path'
import { DocFileAdapter } from '@/file/adapters/DocFileAdapter'
import { PdfFileAdapter } from '@/file/adapters/PdfFileAdapter'
import { TextFileAdapter } from '@/file/adapters/TextFileAdapter'

export interface ResumeTextExtractorDeps {
  getMaxFileSize: () => number
}

/** 按扩展名把简历文件分派给既有文件适配器，提取纯文本 */
export class ResumeTextExtractor {
  constructor(private readonly deps: ResumeTextExtractorDeps) {}

  async extract(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase()
    const maxFileSize = this.deps.getMaxFileSize()
    let adapter: { getContent(): Promise<string | undefined> }
    if (ext === '.pdf') {
      adapter = new PdfFileAdapter(filePath, maxFileSize)
    } else if (ext === '.docx') {
      adapter = new DocFileAdapter(filePath, maxFileSize)
    } else if (ext === '.txt' || ext === '.md') {
      adapter = new TextFileAdapter(filePath, maxFileSize)
    } else {
      throw new Error(`不支持的简历文件格式: ${ext || '(无扩展名)'}，仅支持 PDF / DOCX / TXT / MD`)
    }
    const content = await adapter.getContent()
    if (!content || !content.trim()) {
      throw new Error(`简历内容为空或无法提取文本: ${path.basename(filePath)}`)
    }
    return content
  }
}
