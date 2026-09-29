import { open } from 'node:fs/promises'
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
      await this.assertDocxMagic(filePath)
      adapter = new DocFileAdapter(filePath, maxFileSize)
    } else if (ext === '.txt' || ext === '.md') {
      adapter = new TextFileAdapter(filePath, maxFileSize)
    } else {
      throw new Error(`不支持的简历文件格式: ${ext || '(无扩展名)'}，仅支持 PDF / DOCX / TXT / MD`)
    }
    const content = await adapter.getContent()
    if (!content || !content.trim()) {
      throw new Error(`简历内容为空、损坏或超过大小限制: ${path.basename(filePath)}`)
    }
    return content
  }

  /** DOCX 是 ZIP 容器，文件头必须是 PK 魔数；在交给 Word 解析器前拦截损坏或伪装的文件 */
  private async assertDocxMagic(filePath: string): Promise<void> {
    const handle = await open(filePath, 'r')
    try {
      const header = Buffer.alloc(2)
      const { bytesRead } = await handle.read(header, 0, 2, 0)
      if (bytesRead < 2 || header.toString('ascii', 0, 2) !== 'PK') {
        throw new Error(`简历文件已损坏或不是有效的 DOCX 文件: ${path.basename(filePath)}`)
      }
    } finally {
      await handle.close()
    }
  }
}
