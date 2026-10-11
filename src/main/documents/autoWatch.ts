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
  upsertWatchedFile: (input: { path: string; mtimeMs: number; taskId: string; now: number }) => void
  submit: (input: {
    files: DocumentExtractFileInput[]
    source: 'scheduled'
  }) => Array<{ id: string }>
  readdir: (
    dir: string,
    options: { withFileTypes: true }
  ) => Promise<Array<{ name: string; isFile: () => boolean }>>
  stat: (p: string) => Promise<{ mtimeMs: number }>
  now?: () => number
}

/**
 * 目录自动识别调度器：分钟 tick 对齐小时间隔，扫描目录内新/变更文件
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
      const entries = await this.deps.readdir(config.dir, { withFileTypes: true })
      const extSet = new Set(config.extensions.map((e) => e.toLowerCase()))
      const candidates = entries
        .filter((e) => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
        .map((e) => path.join(config.dir, e.name))
        .sort()
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
        const tasks = this.deps.submit({
          files: batch.map((f) => {
            const ext = path.extname(f.path).toLowerCase()
            return {
              path: f.path,
              name: path.basename(f.path),
              mimeType: MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
            }
          }),
          source: 'scheduled'
        })
        batch.forEach((f, i) => {
          // submit() persists one task per file in order within a single insertBatch transaction.
          const task = tasks[i]
          if (!task) throw new Error(`no submitted task for watched file: ${f.path}`)
          this.deps.upsertWatchedFile({
            path: f.path,
            mtimeMs: f.mtimeMs,
            taskId: task.id,
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
}
