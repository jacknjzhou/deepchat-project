import { describe, expect, it, vi } from 'vitest'
import { AutoWatchScheduler, type AutoWatchConfig } from '@/documents/autoWatch'

const baseConfig: AutoWatchConfig = {
  enabled: true,
  dir: 'D:/scan',
  intervalHours: 1,
  extensions: ['.pdf', '.png'],
  roundLimit: 2
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const files = [
    { name: 'a.pdf', isFile: () => true },
    { name: 'b.pdf', isFile: () => true },
    { name: 'c.pdf', isFile: () => true },
    { name: 'note.txt', isFile: () => true }
  ]
  const deps = {
    readConfig: vi.fn(() => ({ ...baseConfig })),
    writeState: vi.fn(),
    listWatchedFiles: vi.fn(() => [] as Array<{ path: string; mtime_ms: number }>),
    upsertWatchedFile: vi.fn(),
    submit: vi.fn(() => [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
    readdir: vi.fn(async () => files),
    stat: vi.fn(async (_p: string) => ({ mtimeMs: 111 })),
    now: vi.fn(() => 1_000_000)
  }
  Object.assign(deps, overrides)
  return deps
}

describe('AutoWatchScheduler.runOnce', () => {
  it('首轮全量识别、按后缀过滤、限量提交', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit).toHaveBeenCalledTimes(1)
    const arg = deps.submit.mock.calls[0][0]
    expect(arg.source).toBe('scheduled')
    expect(arg.files).toHaveLength(2) // roundLimit=2，txt 被过滤
    expect(arg.files[0].mimeType).toBe('application/pdf')
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(2)
    expect(deps.writeState).toHaveBeenCalledWith({ lastRunAt: 1_000_000, lastError: null })
  })

  it('path+mtime 均相同跳过；mtime 变化重识别', async () => {
    const deps = makeDeps({
      listWatchedFiles: vi.fn(() => [
        { path: 'D:/scan/a.pdf', mtime_ms: 111 },
        { path: 'D:/scan/b.pdf', mtime_ms: 999 } // 变化
      ])
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const submitted = deps.submit.mock.calls[0][0].files.map((f: { name: string }) => f.name)
    expect(submitted).toEqual(['b.pdf', 'c.pdf'])
  })

  it('目录异常写 lastError 且不提交', async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => {
        throw new Error('ENOENT')
      })
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.writeState).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: expect.stringContaining('ENOENT') })
    )
  })

  it('enabled=false 或 dir 空直接跳过', async () => {
    const deps = makeDeps({ readConfig: vi.fn(() => ({ ...baseConfig, enabled: false })) })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.readdir).not.toHaveBeenCalled()
    expect(deps.writeState).not.toHaveBeenCalled()
  })

  it('后缀大小写不敏感', async () => {
    const deps = makeDeps({ readdir: vi.fn(async () => [{ name: 'A.PDF', isFile: () => true }]) })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit.mock.calls[0][0].files).toHaveLength(1)
  })
})

describe('nextRunAt', () => {
  it('每轮结束按 intervalHours 顺延', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(s.getNextRunAt()).toBe(1_000_000 + 3_600_000)
  })
})

describe('AutoWatchScheduler.start/stop', () => {
  it('tick 到点触发一轮，stop 后不再触发', async () => {
    vi.useFakeTimers()
    try {
      let current = 1_000_000
      const deps = makeDeps({ now: vi.fn(() => current) })
      const s = new AutoWatchScheduler(deps as never)
      s.start()
      current += 60_000
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deps.submit).toHaveBeenCalledTimes(1)
      s.stop()
      current += 60_000
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deps.submit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
