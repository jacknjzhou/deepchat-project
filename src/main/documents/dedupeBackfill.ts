import { computeRelativePath } from './autoWatch'
import type { FileDedupeRow } from './contentDedupe'

export interface DedupeBackfillDeps {
  listBackfillDocuments: () => Array<{ id: string; fileUris: string[]; source: string }>
  sha256File: (path: string) => Promise<string | null>
  findFileDedupeNames: (hashes: string[]) => Map<string, string>
  insertFileDedupes: (rows: FileDedupeRow[]) => void
  bindFileDedupeDocument: (taskId: string, documentId: string) => void
  now?: () => number
}

// 与 contentDedupe/taskManager 的文件名回退逻辑保持一致
const baseName = (uri: string): string => uri.split(/[\\/]/).pop() ?? uri

/**
 * 存量文档哈希回填：去重功能上线之前入库的文档（手动/自动扫描/聊天）没有
 * documents_file_dedupes 行，同内容文件再次提交不会被拦截。为每个文档的
 * fileUris 计算哈希并登记；chat 之外的历史提交没有任务可关联，task_id 以
 * document.id 占位并绑定 document_id，保持 deleteDocument 按 document_id
 * 的级联清理语义（删除文档后重传同内容可再次识别）。
 *
 * 幂等：已在表中的哈希跳过；批内同内容仅登记首个；哈希读取失败(null)跳过。
 * 返回本次新登记的哈希行数。
 */
export async function backfillDocumentHashes(deps: DedupeBackfillDeps): Promise<number> {
  const documents = deps.listBackfillDocuments()
  const entries: Array<{
    docId: string
    uri: string
    hash: string
    name: string
    source: string
  }> = []
  for (const document of documents) {
    for (const uri of document.fileUris) {
      const hash = await deps.sha256File(uri)
      if (hash === null) continue
      entries.push({ docId: document.id, uri, hash, name: baseName(uri), source: document.source })
    }
  }
  if (entries.length === 0) return 0
  const table = deps.findFileDedupeNames(entries.map((entry) => entry.hash))
  const seen = new Set<string>()
  const now = (deps.now ?? Date.now)()
  const rows: FileDedupeRow[] = []
  const boundDocIds = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.hash)) continue
    seen.add(entry.hash)
    if (table.has(entry.hash)) continue
    rows.push({
      contentHash: entry.hash,
      fileName: entry.name,
      filePath: entry.uri,
      source: entry.source,
      taskId: entry.docId,
      now
    })
    boundDocIds.add(entry.docId)
  }
  if (rows.length === 0) return 0
  deps.insertFileDedupes(rows)
  for (const docId of boundDocIds) deps.bindFileDedupeDocument(docId, docId)
  return rows.length
}

export interface RelativePathBackfillDeps {
  listScheduledTasksWithoutRelativePath: () => Array<{ id: string; filePath: string }>
  getAutoWatchDir: () => string
  updateTaskRelativePath: (id: string, relativePath: string) => void
}

/**
 * 存量 scheduled 任务相对路径回填：relative_path 列上线前入库的自动扫描任务
 * 没有该值。按**当前**配置的扫描目录计算；目录已变更导致算不出（.. 开头等）
 * 保持 NULL（前端显示 —）。幂等：每次启动执行，只触碰 NULL 行，纯内存计算。
 */
export function backfillTaskRelativePaths(deps: RelativePathBackfillDeps): number {
  const dir = deps.getAutoWatchDir()
  if (dir === '') return 0
  let updated = 0
  for (const task of deps.listScheduledTasksWithoutRelativePath()) {
    const rel = computeRelativePath(task.filePath, dir)
    if (rel === null) continue
    deps.updateTaskRelativePath(task.id, rel)
    updated += 1
  }
  return updated
}
