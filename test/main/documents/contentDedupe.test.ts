import { describe, expect, it, vi } from 'vitest'
import type { DocumentExtractFileInput } from '@/documents/extractor/documentExtractor'
import type { DocumentTask } from '@/documents/repository'
import type { RecognitionTaskSubmitInput } from '@/documents/taskManager'
import {
  filterDuplicateFiles,
  submitChatFileWithDedupe,
  submitWithDedupe
} from '@/documents/contentDedupe'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const file = (path: string, name: string): DocumentExtractFileInput => ({ path, name })

function makeFilterDeps(hashByPath: Map<string, string | null>, table = new Map<string, string>()) {
  return {
    sha256File: vi.fn(async (p: string) => hashByPath.get(p) ?? null),
    findFileDedupeNames: vi.fn(() => table)
  }
}

describe('filterDuplicateFiles', () => {
  it('批内同内容仅首个提交，后续为 duplicates', async () => {
    const deps = makeFilterDeps(
      new Map([
        ['D:/scan/a.pdf', HASH_A],
        ['D:/scan/b.pdf', HASH_A]
      ])
    )
    const files = [file('D:/scan/a.pdf', 'a.pdf'), file('D:/scan/b.pdf', 'b.pdf')]
    const result = await filterDuplicateFiles(files, 'manual', deps)
    expect(result.files).toEqual([files[0]])
    expect(result.hashes).toEqual([HASH_A])
    expect(result.duplicates).toEqual([
      { fileName: 'b.pdf', existingName: 'a.pdf', path: 'D:/scan/b.pdf' }
    ])
  })

  it('查表命中的文件被拦截且携带表内 existingName', async () => {
    const deps = makeFilterDeps(new Map([['D:/scan/a.pdf', HASH_A]]), new Map([[HASH_A, '表内名']]))
    const result = await filterDuplicateFiles([file('D:/scan/a.pdf', 'a.pdf')], 'chat', deps)
    expect(result.files).toHaveLength(0)
    expect(result.hashes).toHaveLength(0)
    expect(result.duplicates).toEqual([
      { fileName: 'a.pdf', existingName: '表内名', path: 'D:/scan/a.pdf' }
    ])
    expect(deps.findFileDedupeNames).toHaveBeenCalledWith([HASH_A])
  })

  it('hash 计算失败(null)的文件照常提交且不登记', async () => {
    const deps = makeFilterDeps(new Map([['D:/scan/a.pdf', null]]))
    const files = [file('D:/scan/a.pdf', 'a.pdf')]
    const result = await filterDuplicateFiles(files, 'manual', deps)
    expect(result.files).toEqual(files)
    expect(result.hashes).toEqual([null])
    expect(result.duplicates).toEqual([])
    // null 哈希不参与查表
    expect(deps.findFileDedupeNames).toHaveBeenCalledWith([])
  })
})

describe('submitWithDedupe', () => {
  const tasks: DocumentTask[] = [
    {
      id: 't1',
      batchId: 'batch',
      filePath: 'D:/scan/a.pdf',
      fileName: 'a.pdf',
      templateId: 'auto',
      source: 'manual',
      status: 'pending',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1000,
      updatedAt: 1000
    },
    {
      id: 't2',
      batchId: 'batch',
      filePath: 'D:/scan/b.pdf',
      fileName: 'b.pdf',
      templateId: 'auto',
      source: 'manual',
      status: 'pending',
      typeKey: null,
      documentId: null,
      error: null,
      createdAt: 1000,
      updatedAt: 1000
    }
  ]

  it('submitWithDedupe 按序 zip 登记 hash→task_id 并透传 duplicates', async () => {
    const files = [file('D:/scan/a.pdf', 'a.pdf'), file('D:/scan/b.pdf', 'b.pdf')]
    const duplicates = [{ fileName: 'c.pdf', existingName: '表内名', path: 'D:/scan/c.pdf' }]
    const deps = {
      submit: vi.fn(() => tasks),
      filter: vi.fn(async () => ({ files, hashes: [HASH_A, HASH_B], duplicates })),
      register: vi.fn(),
      now: vi.fn(() => 5000)
    }
    const input: RecognitionTaskSubmitInput = { files, source: 'manual' }
    const result = await submitWithDedupe(deps, input)
    expect(result.tasks).toEqual(tasks)
    expect(result.duplicates).toEqual(duplicates)
    expect(deps.submit).toHaveBeenCalledWith({ files, source: 'manual' })
    expect(deps.register).toHaveBeenCalledWith([
      {
        contentHash: HASH_A,
        fileName: 'a.pdf',
        filePath: 'D:/scan/a.pdf',
        source: 'manual',
        taskId: 't1',
        now: 5000
      },
      {
        contentHash: HASH_B,
        fileName: 'b.pdf',
        filePath: 'D:/scan/b.pdf',
        source: 'manual',
        taskId: 't2',
        now: 5000
      }
    ])
  })

  it('全部命中查表时不调用 submit 也不登记', async () => {
    const deps = {
      submit: vi.fn(() => tasks),
      filter: vi.fn(async () => ({ files: [], hashes: [], duplicates: [] })),
      register: vi.fn(),
      now: vi.fn(() => 5000)
    }
    const result = await submitWithDedupe(deps, { files: [], source: 'chat' })
    expect(result.tasks).toEqual([])
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.register).not.toHaveBeenCalled()
  })
})

describe('submitChatFileWithDedupe', () => {
  const makeChatDeps = (hash: string | null, table = new Map<string, string>()) => ({
    sha256File: vi.fn(async () => hash),
    findFileDedupeNames: vi.fn(() => table),
    insertFileDedupes: vi.fn(),
    bindFileDedupeDocument: vi.fn(),
    now: vi.fn(() => 5000)
  })
  const proceed = (documentId: string) => vi.fn(async () => ({ documentId, extracted: 'payload' }))

  it('命中查表时返回 duplicate 且不执行 proceed', async () => {
    const deps = makeChatDeps(HASH_A, new Map([[HASH_A, '表内名']]))
    const run = proceed('doc-1')
    const outcome = await submitChatFileWithDedupe(
      deps,
      { file: file('D:/scan/a.pdf', 'a.pdf'), source: 'chat' },
      run
    )
    expect(outcome).toEqual({ status: 'duplicate', fileName: 'a.pdf', existingName: '表内名' })
    expect(deps.sha256File).toHaveBeenCalledWith('D:/scan/a.pdf')
    expect(deps.findFileDedupeNames).toHaveBeenCalledWith([HASH_A])
    expect(run).not.toHaveBeenCalled()
    expect(deps.insertFileDedupes).not.toHaveBeenCalled()
  })

  it('未命中时执行 proceed 并登记 hash→document（task_id 以 document.id 占位并绑定）', async () => {
    const deps = makeChatDeps(HASH_A)
    const run = proceed('doc-9')
    const outcome = await submitChatFileWithDedupe(
      deps,
      { file: file('D:/scan/a.pdf', 'a.pdf'), source: 'chat' },
      run
    )
    expect(outcome).toEqual({ status: 'ok', value: { documentId: 'doc-9', extracted: 'payload' } })
    expect(run).toHaveBeenCalledTimes(1)
    expect(deps.insertFileDedupes).toHaveBeenCalledWith([
      {
        contentHash: HASH_A,
        fileName: 'a.pdf',
        filePath: 'D:/scan/a.pdf',
        source: 'chat',
        taskId: 'doc-9',
        now: 5000
      }
    ])
    expect(deps.bindFileDedupeDocument).toHaveBeenCalledWith('doc-9', 'doc-9')
  })

  it('hash 计算失败(null)时照常 proceed 且不登记', async () => {
    const deps = makeChatDeps(null)
    const run = proceed('doc-1')
    const outcome = await submitChatFileWithDedupe(
      deps,
      { file: file('D:/scan/a.pdf', 'a.pdf'), source: 'chat' },
      run
    )
    expect(outcome.status).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
    expect(deps.findFileDedupeNames).not.toHaveBeenCalled()
    expect(deps.insertFileDedupes).not.toHaveBeenCalled()
    expect(deps.bindFileDedupeDocument).not.toHaveBeenCalled()
  })
})
