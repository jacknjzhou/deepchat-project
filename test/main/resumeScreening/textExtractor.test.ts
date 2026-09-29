import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ResumeTextExtractor } from '@/resumeScreening/textExtractor'

describe('ResumeTextExtractor', () => {
  let dir: string

  const extractor = new ResumeTextExtractor({ getMaxFileSize: () => 10 * 1024 * 1024 })

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-extractor-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const writeFile = async (name: string, content: string) => {
    const filePath = path.join(dir, name)
    await fs.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  it('extracts text from txt and md files', async () => {
    const txt = await extractor.extract(await writeFile('张三.txt', '张三的简历内容'))
    expect(txt).toBe('张三的简历内容')
    const md = await extractor.extract(await writeFile('李四.md', '# 李四\n内容'))
    expect(md).toContain('李四')
  })

  it('throws on unsupported extension', async () => {
    const filePath = await writeFile('王五.exe', 'binary-ish')
    await expect(extractor.extract(filePath)).rejects.toThrow('不支持的简历文件格式')
  })

  it('throws on empty text content', async () => {
    const filePath = await writeFile('空简历.txt', '   \n  ')
    await expect(extractor.extract(filePath)).rejects.toThrow('简历内容为空、损坏或超过大小限制')
  })

  it('rejects a fake docx without PK magic bytes', async () => {
    const filePath = await writeFile('假简历.docx', '这不是一个 ZIP 文件')
    await expect(extractor.extract(filePath)).rejects.toThrow(
      '简历文件已损坏或不是有效的 DOCX 文件'
    )
  })

  it('rejects a txt file exceeding the size limit', async () => {
    const strictExtractor = new ResumeTextExtractor({ getMaxFileSize: () => 10 })
    const filePath = await writeFile('超限简历.txt', 'a'.repeat(11))
    await expect(strictExtractor.extract(filePath)).rejects.toThrow(
      '简历内容为空、损坏或超过大小限制'
    )
  })

  it('rejects files without an extension', async () => {
    const filePath = await writeFile('无扩展名文件', 'some content')
    await expect(extractor.extract(filePath)).rejects.toThrow('不支持的简历文件格式: (无扩展名)')
  })
})
