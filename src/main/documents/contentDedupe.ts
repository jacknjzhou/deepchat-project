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

export interface ChatFileDedupeDeps {
  sha256File: (path: string) => Promise<string | null>
  findFileDedupeNames: (hashes: string[]) => Map<string, string>
  insertFileDedupes: (rows: FileDedupeRow[]) => void
  bindFileDedupeDocument: (taskId: string, documentId: string) => void
  now?: () => number
}

export type ChatDedupeOutcome<D> =
  | { status: 'duplicate'; fileName: string; existingName: string }
  | { status: 'ok'; value: D }

export type ChatMultiProductMerge<D extends { documentId: string }> =
  | { status: 'duplicate'; fileName: string; existingName: string }
  | { status: 'ok'; value: D; issues: string[] }
  | { status: 'empty' }

/**
 * chat 单文件提交的内容去重（手动/定时批量提交走 submitWithDedupe）：
 * 提取前按哈希查 documents_file_dedupes，命中则拦截并返回 duplicate；
 * 未命中执行 proceed，且仅在 proceed 成功后登记 hash→document，
 * 提取/入库失败不会留下登记行。chat 无任务，task_id 以 document.id 占位
 * 并绑定 document_id，保持 deleteDocument 按 document_id 的级联清理语义。
 */
export async function submitChatFileWithDedupe<D extends { documentId: string }>(
  deps: ChatFileDedupeDeps,
  input: { file: DocumentExtractFileInput; source: string },
  proceed: () => Promise<D>
): Promise<ChatDedupeOutcome<D>> {
  const hash = await deps.sha256File(input.file.path)
  if (hash !== null) {
    const existingName = deps.findFileDedupeNames([hash]).get(hash)
    if (existingName !== undefined) {
      return { status: 'duplicate', fileName: displayName(input.file), existingName }
    }
  }
  const value = await proceed()
  if (hash !== null) {
    deps.insertFileDedupes([
      {
        contentHash: hash,
        fileName: displayName(input.file),
        filePath: input.file.path,
        source: input.source,
        taskId: value.documentId,
        now: (deps.now ?? Date.now)()
      }
    ])
    deps.bindFileDedupeDocument(value.documentId, value.documentId)
  }
  return { status: 'ok', value }
}

/**
 * chat 多产物（多发票拆分）闸门结果的合并，部分成功语义：
 * - 任一产物入库成功 → 返回首个文档，issues 逐条记录被拦截页与后续文档（拆分时追加拆分说明）；
 * - 全部被拦截（无任何产物入库）→ 返回首个 duplicate，整体拦截语义不变；
 * - 空产物（理论不可达，防御）→ empty，由调用方抛错。
 */
export function mergeChatProductOutcomes<D extends { documentId: string }>(
  outcomes: Array<ChatDedupeOutcome<D>>,
  options: { split: boolean }
): ChatMultiProductMerge<D> {
  const issues: string[] = []
  let first: D | null = null
  let firstDuplicate: { fileName: string; existingName: string } | null = null
  let okCount = 0
  for (let idx = 0; idx < outcomes.length; idx++) {
    const outcome = outcomes[idx]!
    if (outcome.status === 'duplicate') {
      issues.push(`page ${idx + 1} duplicate of existing document ${outcome.existingName}`)
      if (firstDuplicate === null) {
        firstDuplicate = { fileName: outcome.fileName, existingName: outcome.existingName }
      }
      continue
    }
    okCount += 1
    if (first === null) {
      first = outcome.value
    } else {
      issues.push(`additional invoice recognized: ${outcome.value.documentId}`)
    }
  }
  if (first !== null) {
    if (options.split) {
      issues.push(`merged multi-invoice pdf split into ${okCount} documents`)
    }
    return { status: 'ok', value: first, issues }
  }
  if (firstDuplicate !== null) {
    return {
      status: 'duplicate',
      fileName: firstDuplicate.fileName,
      existingName: firstDuplicate.existingName
    }
  }
  return { status: 'empty' }
}
