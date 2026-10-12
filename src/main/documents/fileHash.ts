import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const CHUNK_SIZE = 64 * 1024

/** 流式计算文件 SHA-256（hex 小写）；读取失败返回 null（该文件照常提交，由提取错误路径兜底）。 */
export async function sha256File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', () => resolve(null))
  })
}
