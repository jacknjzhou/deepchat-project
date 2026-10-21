import path from 'node:path'
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
  // 内存版 watched 登记：upsert 即写入，供下一轮 listWatchedFiles 断言不重扫
  const watched: Array<{ path: string; mtime_ms: number }> = []
  const deps = {
    readConfig: vi.fn(() => ({ ...baseConfig })),
    writeState: vi.fn(),
    listWatchedFiles: vi.fn(() => watched.map((w) => ({ ...w }))),
    upsertWatchedFile: vi.fn((input: { path: string; mtimeMs: number }) => {
      const existing = watched.find((w) => w.path === input.path)
      if (existing) existing.mtime_ms = input.mtimeMs
      else watched.push({ path: input.path, mtime_ms: input.mtimeMs })
    }),
    submit: vi.fn(
      async (input: {
        files: Array<{ path: string }>
        relativePathByPath?: Record<string, string | null>
      }) => ({
        tasks: input.files.map((f, i) => ({ id: `t${i + 1}`, filePath: f.path })),
        duplicates: []
      })
    ),
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

  it('递归扫描子目录中的匹配文件，跳过点前缀目录', async () => {
    const root = 'D:/scan'
    const sub = path.join(root, 'sub')
    const deeper = path.join(sub, 'deeper')
    const hidden = path.join(root, '.hidden')
    const dirent = (name: string, isDir: boolean, isLink = false) => ({
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => isLink
    })
    const deps = makeDeps({
      readConfig: vi.fn(() => ({ ...baseConfig, roundLimit: 5 })),
      readdir: vi.fn(async (dir: string) => {
        if (dir === root) {
          return [dirent('top.pdf', false), dirent('sub', true), dirent('.hidden', true)]
        }
        if (dir === sub) {
          return [dirent('nested.pdf', false), dirent('deeper', true)]
        }
        if (dir === hidden) {
          return [dirent('secret.pdf', false)]
        }
        if (dir === deeper) {
          return [dirent('deep.pdf', false)]
        }
        return []
      })
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const names = deps.submit.mock.calls[0][0].files.map((f: { name: string }) => f.name).sort()
    expect(names).toEqual(['deep.pdf', 'nested.pdf', 'top.pdf'])
    expect(deps.readdir).not.toHaveBeenCalledWith(hidden, expect.anything())
  })

  it('跳过符号链接子目录（防环）', async () => {
    const root = 'D:/scan'
    const loop = path.join(root, 'loop')
    const dirent = (name: string, isDir: boolean, isLink = false) => ({
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => isLink
    })
    const deps = makeDeps({
      readdir: vi.fn(async (dir: string) => {
        if (dir === root) {
          return [dirent('loop', true, true), dirent('plain', true)]
        }
        return [dirent('x.pdf', false)]
      })
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.readdir).not.toHaveBeenCalledWith(loop, expect.anything())
    expect(deps.submit.mock.calls[0][0].files.map((f: { name: string }) => f.name)).toEqual([
      'x.pdf'
    ])
  })

  it('子目录读取失败跳过该子树并继续本轮', async () => {
    const root = 'D:/scan'
    const denied = path.join(root, 'denied')
    const dirent = (name: string, isDir: boolean) => ({
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false
    })
    const deps = makeDeps({
      readdir: vi.fn(async (dir: string) => {
        if (dir === root) return [dirent('denied', true), dirent('ok', true)]
        if (dir === denied) throw new Error('EACCES')
        return [dirent('y.pdf', false)]
      })
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.submit.mock.calls[0][0].files.map((f: { name: string }) => f.name)).toEqual([
      'y.pdf'
    ])
    expect(deps.writeState).toHaveBeenCalledWith({ lastRunAt: 1_000_000, lastError: null })
  })

  it('被拦截的重复文件仍登记 watched（taskId null）且不再重扫', async () => {
    const deps = makeDeps({
      submit: vi.fn(async (input: { files: Array<{ path: string }> }) => ({
        tasks: [{ id: 't1', filePath: input.files[0]!.path }],
        duplicates: [{ path: input.files[1]!.path }]
      }))
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(2)
    expect(deps.upsertWatchedFile).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }))
    expect(deps.upsertWatchedFile).toHaveBeenCalledWith(expect.objectContaining({ taskId: null }))
    const nullCall = deps.upsertWatchedFile.mock.calls.find((call) => call[0].taskId === null)
    expect(nullCall?.[0].path).toContain('b.pdf')
    // 下一轮：重复文件已登记（taskId null）不再提交；roundLimit 外的 c.pdf 仍会进入本轮
    deps.submit.mockClear()
    await s.runOnce()
    const resubmitted = deps.submit.mock.calls[0]?.[0].files.map((f: { name: string }) => f.name)
    expect(resubmitted).toEqual(['c.pdf'])
  })

  it('既不在 tasks 也不在 duplicates 中的文件保守跳过登记', async () => {
    const deps = makeDeps({
      submit: vi.fn(async (input: { files: Array<{ path: string }> }) => ({
        tasks: [{ id: 't1', filePath: input.files[0]!.path }],
        duplicates: []
      }))
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(1)
    expect(deps.upsertWatchedFile).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1' }))
  })

  it('expandFiles 拆分源文件：提交产物、源文件按 null taskId 登记 watched 且下轮不重扫', async () => {
    const productFiles = [
      { path: 'C:/split/u1/p1.pdf', name: 'merged（第1张）.pdf', mimeType: 'application/pdf' },
      { path: 'C:/split/u1/p2.pdf', name: 'merged（第2张）.pdf', mimeType: 'application/pdf' }
    ]
    const sourceOf = new Map([
      ['C:/split/u1/p1.pdf', 'D:/scan/merged.pdf'],
      ['C:/split/u1/p2.pdf', 'D:/scan/merged.pdf']
    ])
    const deps = makeDeps({
      readdir: vi.fn(async () => [{ name: 'merged.pdf', isFile: () => true }]),
      expandFiles: vi.fn(async () => ({ files: productFiles, sourceOf }))
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const submitted = deps.submit.mock.calls[0][0].files
    expect(submitted.map((f: { path: string }) => f.path)).toEqual([
      'C:/split/u1/p1.pdf',
      'C:/split/u1/p2.pdf'
    ])
    // 源文件登记 watched（taskId null），产物任务路径不参与登记
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(1)
    expect(deps.upsertWatchedFile).toHaveBeenCalledWith({
      path: path.join('D:/scan', 'merged.pdf'),
      mtimeMs: 111,
      taskId: null,
      now: 1_000_000
    })
    // 第二轮：mtime 不变 → 不再提交
    await s.runOnce()
    expect(deps.submit).toHaveBeenCalledTimes(1)
  })

  it('expandFiles 拆分后全部产物被去重拦截：源文件仍登记 watched', async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => [{ name: 'merged.pdf', isFile: () => true }]),
      expandFiles: vi.fn(async () => ({
        files: [
          { path: 'C:/split/u1/p1.pdf', name: 'merged（第1张）.pdf', mimeType: 'application/pdf' },
          { path: 'C:/split/u1/p2.pdf', name: 'merged（第2张）.pdf', mimeType: 'application/pdf' }
        ],
        sourceOf: new Map([
          ['C:/split/u1/p1.pdf', 'D:/scan/merged.pdf'],
          ['C:/split/u1/p2.pdf', 'D:/scan/merged.pdf']
        ])
      })),
      submit: vi.fn(async () => ({
        tasks: [],
        duplicates: [{ path: 'C:/split/u1/p1.pdf' }, { path: 'C:/split/u1/p2.pdf' }]
      }))
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(1)
    expect(deps.upsertWatchedFile).toHaveBeenCalledWith({
      path: path.join('D:/scan', 'merged.pdf'),
      mtimeMs: 111,
      taskId: null,
      now: 1_000_000
    })
  })

  it('未注入 expandFiles 时行为不变（回归）', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    expect(deps.expandFiles).toBeUndefined()
    // Windows 下 path.join 产出反斜杠分隔符，期望值按实际 join 结果构造
    expect(deps.submit.mock.calls[0][0].files[0].path).toBe(path.join('D:/scan', 'a.pdf'))
  })

  it('提交输入携带 relativePathByPath（按 config.dir 相对化）', async () => {
    const deps = makeDeps()
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const arg = deps.submit.mock.calls[0][0]
    expect(arg.relativePathByPath).toBeDefined()
    expect(arg.relativePathByPath[path.join('D:/scan', 'a.pdf')]).toBe('a.pdf')
  })

  it('拆分产物回溯源文件的相对路径', async () => {
    const deps = makeDeps({
      expandFiles: vi.fn(async (files: Array<{ path: string }>) => ({
        files: files.map((f) => ({
          ...f,
          path: path.join('D:/split-out', `p-${path.basename(f.path)}`)
        })),
        sourceOf: new Map([[path.join('D:/split-out', 'p-a.pdf'), path.join('D:/scan', 'a.pdf')]])
      }))
    })
    const s = new AutoWatchScheduler(deps as never)
    await s.runOnce()
    const arg = deps.submit.mock.calls[0][0]
    expect(arg.relativePathByPath[path.join('D:/split-out', 'p-a.pdf')]).toBe('a.pdf')
  })

  it('computeRelativePath 语义', async () => {
    const { computeRelativePath } = await import('@/documents/autoWatch')
    expect(computeRelativePath('D:\\scan\\sub\\a.pdf', 'D:\\scan')).toBe('sub/a.pdf')
    expect(computeRelativePath('D:\\scan\\a.pdf', 'D:\\scan')).toBe('a.pdf')
    expect(computeRelativePath('D:\\other\\a.pdf', 'D:\\scan')).toBeNull()
    expect(computeRelativePath('D:\\scan\\a.pdf', '')).toBeNull()
    expect(computeRelativePath('C:\\scan\\a.pdf', 'D:\\scan')).toBeNull()
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
