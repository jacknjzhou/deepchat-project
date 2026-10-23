import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeSyncScheduler,
  DEFAULT_SYNC_INTERVAL_SECONDS,
  type KnowledgeSyncSchedulerDeps
} from '../../../src/main/digital-employee/knowledgeSyncScheduler'

/**
 * 调度器的职责边界：只在「该跑的时候」跑，且一轮失败不牵连其他员工。
 *
 * 用假时钟推进，不依赖真实 setInterval——真实定时器会让这类测试既慢又不稳。
 */

interface Harness {
  deps: KnowledgeSyncSchedulerDeps
  syncCalls: string[]
  advance: (ms: number) => void
  triggerTick: () => void
  setEmployees: (next: Array<{ id: string; name: string; knowledgeBaseIds: string[] }>) => void
  failFor: Set<string>
  runningCount: () => number
  maxConcurrent: () => number
}

function createHarness(overrides: Partial<KnowledgeSyncSchedulerDeps> = {}): Harness {
  let clock = 1_000_000
  let handlers: Array<() => void> = []
  let employees: Array<{ id: string; name: string; knowledgeBaseIds: string[] }> = []
  const syncCalls: string[] = []
  const failFor = new Set<string>()
  let inFlight = 0
  let maxInFlight = 0

  const harness: Harness = {
    deps: undefined as unknown as KnowledgeSyncSchedulerDeps,
    syncCalls,
    advance: (ms) => {
      clock += ms
    },
    triggerTick: () => {
      for (const handler of handlers) handler()
    },
    setEmployees: (next) => {
      employees = next
    },
    failFor,
    runningCount: () => inFlight,
    maxConcurrent: () => maxInFlight
  }

  harness.deps = {
    now: () => clock,
    isEnabled: () => true,
    listEmployees: async () => employees,
    syncEmployee: async (input) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      syncCalls.push(input.employeeId)
      try {
        if (failFor.has(input.employeeId)) throw new Error('boom')
        return { ok: true, downloaded: 0, failedPackages: 0 }
      } finally {
        inFlight -= 1
      }
    },
    readIntervalSeconds: () => 3600,
    setInterval: ((handler: () => void) => {
      handlers.push(handler)
      return handlers.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as KnowledgeSyncSchedulerDeps['setInterval'],
    clearInterval: (() => {
      handlers = []
    }) as unknown as KnowledgeSyncSchedulerDeps['clearInterval'],
    ...overrides
  }

  return harness
}

describe('knowledgeSyncScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not run when the scheduler is disabled', async () => {
    const harness = createHarness({ isEnabled: () => false })
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    scheduler.start()
    harness.triggerTick()

    expect(harness.syncCalls).toEqual([])
  })

  it('does not run before the configured interval elapses', async () => {
    const harness = createHarness()
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    scheduler.start()
    harness.advance(60_000)
    harness.triggerTick()

    // 首轮不应立刻跑：启动瞬间就打服务端会让冷启动变慢，且与首轮对话触发撞车。
    expect(harness.syncCalls).toEqual([])
  })

  it('runs after the interval elapses', async () => {
    const harness = createHarness()
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    scheduler.start()
    harness.advance(3_600_000 + 60_000)
    harness.triggerTick()
    await vi.waitFor(() => expect(harness.syncCalls).toEqual(['agent_1']))
  })

  it('exposes runOnce for the first-turn trigger', async () => {
    const harness = createHarness()
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    await scheduler.runOnce()

    // 首次对话要能立刻触发同步，不必等满一个间隔。
    expect(harness.syncCalls).toEqual(['agent_1'])
  })

  it('keeps syncing other employees when one of them fails', async () => {
    const harness = createHarness()
    harness.failFor.add('agent_1')
    harness.setEmployees([
      { id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] },
      { id: 'agent_2', name: 'B', knowledgeBaseIds: ['kb-2'] },
      { id: 'agent_3', name: 'C', knowledgeBaseIds: ['kb-3'] }
    ])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    await scheduler.runOnce()

    // 一个员工抛错不能让其余员工饿死——这是后台同步最常见的静默故障。
    expect(harness.syncCalls.sort()).toEqual(['agent_1', 'agent_2', 'agent_3'])
  })

  it('skips employees that have no knowledge bases', async () => {
    const harness = createHarness()
    harness.setEmployees([
      { id: 'agent_1', name: 'A', knowledgeBaseIds: [] },
      { id: 'agent_2', name: 'B', knowledgeBaseIds: ['kb-2'] }
    ])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    await scheduler.runOnce()

    // 没配知识的员工占大多数，逐个打服务端纯属浪费。
    expect(harness.syncCalls).toEqual(['agent_2'])
  })

  it('ignores a concurrent tick while a round is still running', async () => {
    let release: (() => void) | null = null
    const harness = createHarness({
      syncEmployee: async (input) => {
        harness.syncCalls.push(input.employeeId)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { ok: true, downloaded: 0, failedPackages: 0 }
      }
    })
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    const first = scheduler.runOnce()
    const second = scheduler.runOnce()
    await vi.waitFor(() => expect(release).not.toBeNull())
    release!()
    await Promise.all([first, second])

    // 上一轮还没跑完就再起一轮，会同时写同一个状态表并重复下载。
    expect(harness.syncCalls).toEqual(['agent_1'])
  })

  it('stops and can be restarted', async () => {
    const harness = createHarness()
    harness.setEmployees([{ id: 'agent_1', name: 'A', knowledgeBaseIds: ['kb-1'] }])
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    scheduler.start()
    scheduler.stop()
    scheduler.start()
    await scheduler.runOnce()

    expect(harness.syncCalls).toEqual(['agent_1'])
    scheduler.stop()
  })

  it('gives up quietly when the employee list cannot be fetched', async () => {
    const harness = createHarness({
      listEmployees: async () => {
        throw new Error('unauthorized')
      }
    })
    const scheduler = createKnowledgeSyncScheduler(harness.deps)

    // 列表拉取失败不是崩溃点：下一轮自然重试，不该让 setInterval 回调抛错。
    await expect(scheduler.runOnce()).resolves.toBeUndefined()
    expect(harness.syncCalls).toEqual([])
  })

  it('uses a sane default interval', () => {
    // 1 小时：知识库变更频率远低于对话，更短的间隔只会白打服务端。
    expect(DEFAULT_SYNC_INTERVAL_SECONDS).toBe(3600)
  })
})
