import { vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256File } from '@/documents/fileHash'

it('sha256File 计算文件字节摘要', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'))
  const p = join(dir, 'a.pdf')
  writeFileSync(p, Buffer.from([1, 2, 3, 4, 5]))
  expect(await sha256File(p)).toBe(
    '74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0'
  )
})

it('读取失败返回 null 而不抛错', async () => {
  expect(await sha256File('Z:/不存在的路径/x.pdf')).toBeNull()
})
