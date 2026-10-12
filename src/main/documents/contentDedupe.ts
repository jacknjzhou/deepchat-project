import type { DocumentSource, RecognitionDuplicate } from '@shared/documents'
import type { DocumentExtractFileInput } from './extractor/documentExtractor'
import type { DocumentTask } from './repository'
import type { RecognitionTaskSubmitInput } from './taskManager'

export interface DedupeFilterDeps {
  sha256File: (path: string) => Promise<string | null>
  findFileDedupeNames: (hashes: string[]) => Map<string, string>
}

export interface DedupeFilterResult {
  files: DocumentExtractFileInput[]
  /** 与 files 按下标对齐；null = 无法计算哈希（照常提交，不登记） */
  hashes: Array<string | null>
  duplicates: RecognitionDuplicate[]
}

/** documents_file_dedupes 登记行（与 DocumentRepositoryTaskPort.insertFileDedupes 对齐） */
export interface FileDedupeRow {
  contentHash: string
  fileName: string
  filePath: string
  source: string
  taskId: string
  now: number
}

export interface DedupeSubmitDeps {
  submit: (input: RecognitionTaskSubmitInput) => DocumentTask[]
  filter: (files: DocumentExtractFileInput[], source: DocumentSource) => Promise<DedupeFilterResult>
  register: (rows: FileDedupeRow[]) => void
  now?: () => number
}

// 与 taskManager.submit 的文件名回退逻辑保持一致
const displayName = (file: DocumentExtractFileInput): string =>
  file.name ?? file.path.split(/[\\/]/).pop() ?? file.path

/**
 * 提交前的内容去重：批内同内容仅保留首个，已入库内容（file_dedupes 命中）整批拦截。
 * 输出 files 与 hashes 按下标对齐，顺序与入参一致。
 */
export async function filterDuplicateFiles(
  files: DocumentExtractFileInput[],
  source: DocumentSource,
  deps: DedupeFilterDeps
): Promise<DedupeFilterResult> {
  void source
  const hashes = await Promise.all(files.map((f) => deps.sha256File(f.path)))
  const table = deps.findFileDedupeNames(hashes.filter((h): h is string => h !== null))
  const seen = new Map<string, string>()
  const outFiles: DocumentExtractFileInput[] = []
  const outHashes: Array<string | null> = []
  const duplicates: RecognitionDuplicate[] = []
  files.forEach((f, i) => {
    const hash = hashes[i]
    if (hash === null) {
      outFiles.push(f)
      outHashes.push(null)
      return
    }
    const existing = seen.get(hash) ?? table.get(hash)
    if (existing !== undefined) {
      duplicates.push({ fileName: displayName(f), existingName: existing, path: f.path })
      return
    }
    seen.set(hash, displayName(f))
    outFiles.push(f)
    outHashes.push(hash)
  })
  return { files: outFiles, hashes: outHashes, duplicates }
}

/**
 * submit 包装器：先过滤重复，再提交并登记 hash→task_id。
 * 依赖 submit 返回 tasks 与 files 1:1 同序（autoWatch 已依赖此约定）。
 */
export async function submitWithDedupe(
  deps: DedupeSubmitDeps,
  input: RecognitionTaskSubmitInput
): Promise<{ tasks: DocumentTask[]; duplicates: RecognitionDuplicate[] }> {
  const { files, hashes, duplicates } = await deps.filter(input.files, input.source)
  if (files.length === 0) return { tasks: [], duplicates }
  const tasks = deps.submit({ ...input, files })
  const now = deps.now ?? Date.now
  const rows = tasks
    .map((task, i) => ({ task, hash: hashes[i] }))
    .filter((row): row is { task: DocumentTask; hash: string } => row.hash !== null)
    .map((row) => ({
      contentHash: row.hash,
      fileName: row.task.fileName,
      filePath: row.task.filePath,
      source: input.source,
      taskId: row.task.id,
      now: now()
    }))
  if (rows.length > 0) deps.register(rows)
  return { tasks, duplicates }
}
