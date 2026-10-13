import path from 'node:path'
import type { DocumentsAutoWatchConfig } from '@shared/documents'
import type { DocumentExtractFileInput } from './extractor/documentExtractor'
import type { DocumentsAutoWatchState } from './modelSettings'

export type AutoWatchConfig = DocumentsAutoWatchConfig

const HOUR_MS = 3_600_000
const TICK_MS = 60_000

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export interface AutoWatchDeps {
  readConfig: () => DocumentsAutoWatchConfig
  writeState: (state: DocumentsAutoWatchState) => void
  listWatchedFiles: () => Array<{ path: string; mtime_ms: number }>
  upsertWatchedFile: (input: {
    path: string
    mtimeMs: number
    taskId: string | null
    now: number
  }) => void
  submit: (input: {
    files: DocumentExtractFileInput[]
    source: 'scheduled'
    relativePathByPath?: Record<string, string | null>
  }) => Promise<{
    tasks: Array<{ id: string; filePath: string }>
    duplicates: Array<{ path: string }>
  }>
  /** 可选：多发票合并件拆分展开（产物 path → 源 path，仅被拆分的源文件有条目） */
  expandFiles?: (files: DocumentExtractFileInput[]) => Promise<{
    files: DocumentExtractFileInput[]
    sourceOf: Map<string, string>
  }>
  readdir: (dir: string, options: { withFileTypes: true }) => Promise<Array<DirentLike>>
  stat: (p: string) => Promise<{ mtimeMs: number }>
  now?: () => number
}

/** fs.Dirent 的结构子集，便于测试桩注入 */
interface DirentLike {
  name: string
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

/**
 * 目录自动识别调度器：分钟 tick 对齐小时间隔，递归扫描目录树内新/变更文件
 * 经 RecognitionTaskManager 提交（source='scheduled'，模板缺省走自动分类）。
 * 已处理文件以 path+mtime 记录在 documents_watched_files，mtime 变化才会重识别。
 */
export class AutoWatchScheduler {
  private nextRunAt: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AutoWatchDeps) {
    this.nextRunAt = (deps.now ?? Date.now)()
  }

  getNextRunAt(): number {
    return this.nextRunAt
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if ((this.deps.now ?? Date.now)() >= this.nextRunAt) void this.runOnce()
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<void> {
    const now = this.deps.now ?? Date.now
    let lastError: string | null = null
    try {
      const config = this.deps.readConfig()
      this.nextRunAt = now() + config.intervalHours * HOUR_MS
      if (!config.enabled || config.dir === '') return
      const rootEntries = await this.deps.readdir(config.dir, { withFileTypes: true })
      const extSet = new Set(config.extensions.map((e) => e.toLowerCase()))
      const candidates = (await this.collectCandidates(config.dir, rootEntries, extSet)).sort()
      const watched = new Map(
        this.deps.listWatchedFiles().map((w) => [path.normalize(w.path), w.mtime_ms])
      )
      const pending: Array<{ path: string; mtimeMs: number }> = []
      for (const p of candidates) {
        let mtimeMs: number
        try {
          mtimeMs = (await this.deps.stat(p)).mtimeMs
        } catch {
          continue
        }
        // normalize 两侧再比较：watched 记录与本次 join 产出的分隔符风格可能不同（Windows）
        if (watched.get(path.normalize(p)) === mtimeMs) continue
        pending.push({ path: p, mtimeMs })
      }
      const batch = pending.slice(0, config.roundLimit)
      if (batch.length > 0) {
        const batchInputs = batch.map((f) => {
          const ext = path.extname(f.path).toLowerCase()
          return {
            path: f.path,
            name: path.basename(f.path),
            mimeType: MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
          }
        })
        const relBySource = new Map(
          batch.map((f) => [path.normalize(f.path), computeRelativePath(f.path, config.dir)])
        )
        // 多发票合并件在此展开为逐页产物；未注入 expandFiles 或未命中拆分时原样透传
        const expanded = this.deps.expandFiles
          ? await this.deps.expandFiles(batchInputs)
          : { files: batchInputs, sourceOf: new Map<string, string>() }
        // 产物回溯源文件计算相对路径；未拆分文件以自身路径计算
        const relativePathByPath: Record<string, string | null> = {}
        for (const f of expanded.files) {
          const source = expanded.sourceOf.get(f.path) ?? f.path
          relativePathByPath[f.path] = relBySource.get(path.normalize(source)) ?? null
        }
        const { tasks, duplicates } = await this.deps.submit({
          files: expanded.files,
          source: 'scheduled',
          relativePathByPath
        })
        // submit 返回按文件 1:1 产出任务；内容去重拦截的文件以 duplicates 报告。
        // 被拆分的源文件：产物已各自提交/拦截，源文件按 null taskId 登记 watched，
        // mtime 不变即不再重扫；未拆分文件维持按 filePath zip 的既有登记逻辑。
        const taskIdByPath = new Map(tasks.map((t) => [t.filePath, t.id]))
        const dupPaths = new Set(duplicates.map((d) => d.path))
        const splitSources = new Set([...expanded.sourceOf.values()].map((p) => path.normalize(p)))
        batch.forEach((f) => {
          if (splitSources.has(path.normalize(f.path))) {
            this.deps.upsertWatchedFile({
              path: f.path,
              mtimeMs: f.mtimeMs,
              taskId: null,
              now: now()
            })
            return
          }
          const taskId = taskIdByPath.get(f.path) ?? null
          if (taskId === null && !dupPaths.has(f.path)) return
          this.deps.upsertWatchedFile({
            path: f.path,
            mtimeMs: f.mtimeMs,
            taskId,
            now: now()
          })
        })
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    try {
      this.deps.writeState({ lastRunAt: now(), lastError })
    } catch {
      // settings store failure must not reject the timer callback
    }
  }

  /**
   * 递归收集目录树下匹配后缀的文件：进入普通子目录，跳过符号链接/联结目录（防环）
   * 与点前缀目录；单个子目录读取失败仅跳过该子树，不影响本轮其余目录。
   * 根目录的 readdir 错误不在此吞掉，由 runOnce 统一记入 lastError。
   */
  private async collectCandidates(
    rootDir: string,
    rootEntries: Array<DirentLike>,
    extSet: Set<string>
  ): Promise<string[]> {
    const visited = new Set([path.normalize(rootDir)])
    const files: string[] = []
    const walk = async (dir: string, entries: Array<DirentLike>): Promise<void> => {
      for (const entry of entries) {
        if (entry.isFile()) {
          if (extSet.has(path.extname(entry.name).toLowerCase())) {
            files.push(path.join(dir, entry.name))
          }
          continue
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
        const subDir = path.join(dir, entry.name)
        const key = path.normalize(subDir)
        if (visited.has(key)) continue
        visited.add(key)
        try {
          await walk(subDir, await this.deps.readdir(subDir, { withFileTypes: true }))
        } catch {
          // 子目录不可读时跳过该子树
        }
      }
    }
    await walk(rootDir, rootEntries)
    return files
  }
}

/** 计算文件相对扫描目录的层级路径（POSIX 分隔）；不在目录下/无法相对化返回 null */
export const computeRelativePath = (filePath: string, scanDir: string): string | null => {
  if (scanDir === '') return null
  const rel = path.relative(path.normalize(scanDir), path.normalize(filePath))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}
