import { describe, expect, it, vi } from 'vitest'
import { StaffdeckProblemError } from '../../../src/main/digital-employee/remoteClient'
import {
  StaffdeckRemoteRunner,
  type StaffdeckRemoteRunnerDeps
} from '../../../src/main/digital-employee/remoteRunner'
import type { StaffdeckSseFrame } from '../../../src/main/digital-employee/sseParser'

const BINDING = {
  remoteSessionId: 'remote-1',
  employeeId: 'emp-1',
  runId: null,
  lastEventId: null,
  executionMode: 'remote' as const
}

function createHarness(overrides: Partial<StaffdeckRemoteRunnerDeps> = {}) {
  const published: Array<{ name: string; payload: unknown }> = []
  const contents: Array<{ messageId: string; blocks: unknown[] }> = []
  const statuses: Array<{ messageId: string; status: string }> = []
  const registryStore = new Map<string, typeof BINDING>([['s1', BINDING]])

  const registry = {
    get: vi.fn((sessionId: string) => registryStore.get(sessionId) ?? null),
    set: vi.fn((sessionId: string, binding: typeof BINDING) => {
      registryStore.set(sessionId, binding)
    }),
    update: vi.fn((sessionId: string, patch: Partial<typeof BINDING>) => {
      const existing = registryStore.get(sessionId)
      if (existing) registryStore.set(sessionId, { ...existing, ...patch })
    }),
    delete: vi.fn(),
    has: vi.fn((sessionId: string) => registryStore.has(sessionId)),
    listAll: vi.fn(() => [])
  }

  const transcript = {
    getNextOrderSeq: vi.fn(() => 7),
    createAssistantMessage: vi.fn(() => 'msg-1'),
    updateAssistantContent: vi.fn((messageId: string, blocks: unknown[]) => {
      contents.push({ messageId, blocks })
    }),
    updateMessageStatus: vi.fn((messageId: string, status: string) => {
      statuses.push({ messageId, status })
    })
  }

  const client = {
    createSession: vi.fn().mockResolvedValue({ id: 'remote-1' }),
    streamRun: vi.fn(),
    resumeRun: vi.fn(),
    getResult: vi.fn().mockResolvedValue({
      run_id: 'run-1',
      reply: '',
      citations: [],
      tool_calls: [],
      task_results: [],
      artifacts: []
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    currentRunId: null
  }

  const deps: StaffdeckRemoteRunnerDeps = {
    client: client as never,
    registry: registry as never,
    transcript: transcript as never,
    publishEvent: ((name: string, payload: unknown) => {
      published.push({ name, payload })
    }) as never,
    rendererFlushIntervalMs: 0,
    dbFlushIntervalMs: 0,
    now: () => 1_700_000_000_000,
    ...overrides
  }

  return { deps, client, registry, transcript, published, contents, statuses }
}

function frame(event: string, data: Record<string, unknown>, id = 1): StaffdeckSseFrame {
  return { id: String(id), event, data: JSON.stringify(data) }
}

/** 让 streamRun 依次回放给定帧，然后正常返回。 */
function replayFrames(
  client: { streamRun: ReturnType<typeof vi.fn> },
  frames: StaffdeckSseFrame[]
) {
  client.streamRun.mockImplementation(
    async (_input: unknown, onFrame: (frame: StaffdeckSseFrame) => void) => {
      for (const item of frames) onFrame(item)
      return { runId: 'run-1' }
    }
  )
}

describe('StaffdeckRemoteRunner happy path', () => {
  it('accumulates deltas into one content block and marks it sent on completion', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '你' }, 1),
      frame('run.output.delta', { content: '好' }, 2),
      frame('run.output.completed', { job_id: 'run-1' }, 3),
      frame('run.succeeded', { job_id: 'run-1' }, 4)
    ])

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: '在吗',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('completed')
    expect(outcome.text).toBe('你好')
    const lastWrite = harness.contents.at(-1)
    expect(JSON.stringify(lastWrite?.blocks)).toContain('你好')
    expect(harness.statuses.at(-1)).toEqual({ messageId: 'msg-1', status: 'sent' })

    const names = harness.published.map((entry) => entry.name)
    expect(names).toContain('chat.stream.updated')
    expect(names.filter((name) => name === 'chat.stream.completed')).toHaveLength(1)
    expect(names).not.toContain('chat.stream.failed')
  })

  it('does not treat completed as carrying the final text', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '累' }, 1),
      frame('run.output.delta', { content: '积' }, 2),
      frame('run.output.completed', { job_id: 'run-1', execution_engine: 'harness_v2' }, 3)
    ])
    // result 端点返回空 reply，模拟「终稿只存在于 delta」的实测行为
    harness.client.getResult.mockResolvedValue({
      run_id: 'run-1',
      reply: '',
      citations: [],
      tool_calls: [],
      task_results: [],
      artifacts: []
    })

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.text).toBe('累积')
  })

  it('prefers the server reply over the accumulated text when both exist', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '草稿' }, 1),
      frame('run.output.completed', { job_id: 'run-1' }, 2)
    ])
    harness.client.getResult.mockResolvedValue({
      run_id: 'run-1',
      reply: '终稿',
      citations: [],
      tool_calls: [],
      task_results: [],
      artifacts: []
    })

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.text).toBe('终稿')
    expect(JSON.stringify(harness.contents.at(-1)?.blocks)).toContain('终稿')
  })

  it('creates the assistant message at the next order sequence', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [frame('run.output.completed', { job_id: 'run-1' }, 1)])

    await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(harness.transcript.getNextOrderSeq).toHaveBeenCalledWith('s1')
    expect(harness.transcript.createAssistantMessage).toHaveBeenCalledWith('s1', 7)
  })
})

describe('StaffdeckRemoteRunner awaiting_input', () => {
  it('queries the run result after completion to surface awaiting_input', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '需要补充信息' }, 1),
      frame('run.output.completed', { job_id: 'run-1' }, 2)
    ])
    harness.client.getResult.mockResolvedValue({
      run_id: 'run-1',
      reply: '需要补充信息',
      citations: [],
      tool_calls: [],
      task_results: [],
      artifacts: [],
      awaiting_input: {
        task_id: 't1',
        kind: 'conversation',
        expected_fields: ['金额', '事由'],
        question_summary: '请提供金额和事由'
      }
    })

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: '报销',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('awaiting_input')
    expect(outcome.awaitingInput?.expected_fields).toEqual(['金额', '事由'])

    // 这一轮会发两次状态事件：先 started（UI 显示「远端执行中」），
    // 终态后再发 awaiting_input。断言终态，所以取最后一个而不是 find 的首个。
    const updates = harness.published.filter(
      (entry) => entry.name === 'digitalEmployee.remoteRunUpdated'
    )
    expect(updates.map((entry) => (entry.payload as { phase: string }).phase)).toEqual([
      'started',
      'awaiting_input'
    ])
    expect(updates.at(-1)?.payload).toMatchObject({ phase: 'awaiting_input', sessionId: 's1' })
  })

  it('records the cursor so a reconnect does not replay, and keeps the message readable', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: 'a' }, 3),
      frame('run.output.delta', { content: 'b' }, 9)
    ])
    harness.client.getResult.mockResolvedValue({
      run_id: 'run-1',
      reply: 'ab',
      citations: [],
      tool_calls: [],
      task_results: [],
      artifacts: [],
      awaiting_input: { task_id: 't1' }
    })

    await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(harness.registry.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastEventId: '9', runId: 'run-1' })
    )
  })
})

describe('StaffdeckRemoteRunner failures', () => {
  it('marks the message error and emits chat.stream.failed on run.failed', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '半' }, 1),
      frame('run.failed', { job_id: 'run-1', code: 'JOB_EXECUTION_FAILED' }, 2)
    ])

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('failed')
    expect(harness.statuses.at(-1)).toEqual({ messageId: 'msg-1', status: 'error' })
    const failed = harness.published.filter((entry) => entry.name === 'chat.stream.failed')
    expect(failed).toHaveLength(1)
    // 失败也必须把已累积的文本落库，不能只剩一个错误块。
    expect(JSON.stringify(harness.contents.at(-1)?.blocks)).toContain('半')
  })

  it('carries the failure code from the run.failed payload instead of a generic one', async () => {
    // 服务端在 error_occurred 里带真实原因（agent_loop.py:240/254 的 LLM_ERROR、
    // HARNESS_V2_ERROR）。统一压成 RUN_FAILED 会让「模型调用失败」和「harness 出错」
    // 变成同一句提示，用户无法判断该重试还是该找管理员。
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '半' }, 1),
      frame('run.failed', { job_id: 'run-1', code: 'LLM_ERROR' }, 2)
    ])

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.messageCode).toBe('LLM_ERROR')
    const failed = harness.published.filter((entry) => entry.name === 'chat.stream.failed')
    expect((failed[0]?.payload as { error?: string }).error).toBe('LLM_ERROR')
    const phase = harness.published
      .filter((entry) => entry.name === 'digitalEmployee.remoteRunUpdated')
      .at(-1)
    expect((phase?.payload as { messageCode?: string }).messageCode).toBe('LLM_ERROR')
  })

  it('falls back to RUN_FAILED when the failure payload carries no code', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [frame('run.failed', { job_id: 'run-1' }, 1)])

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.messageCode).toBe('RUN_FAILED')
  })

  it('tolerates RUN_NOT_SUCCEEDED and keeps the accumulated text', async () => {
    const harness = createHarness()
    replayFrames(harness.client, [
      frame('run.output.delta', { content: '已完成一部分' }, 1),
      frame('run.output.completed', { job_id: 'run-1' }, 2)
    ])
    harness.client.getResult.mockRejectedValue(
      new StaffdeckProblemError(409, 'RUN_NOT_SUCCEEDED', 'The run has not succeeded.')
    )

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('completed')
    expect(outcome.text).toBe('已完成一部分')
    expect(outcome.awaitingInput).toBeNull()
  })

  it('reports a transport failure as failed instead of completed', async () => {
    const harness = createHarness()
    harness.client.streamRun.mockRejectedValue(new Error('socket hang up'))

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('failed')
    expect(harness.statuses.at(-1)).toEqual({ messageId: 'msg-1', status: 'error' })
  })

  it('surfaces a problem code without the server detail text', async () => {
    const harness = createHarness()
    harness.client.streamRun.mockRejectedValue(
      new StaffdeckProblemError(403, 'INSUFFICIENT_SCOPE', '/srv/internal/path leaked')
    )

    const outcome = await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(outcome.phase).toBe('failed')
    expect(outcome.messageCode).toBe('INSUFFICIENT_SCOPE')
    const failed = harness.published.find((entry) => entry.name === 'chat.stream.failed')
    expect(JSON.stringify(failed?.payload)).not.toContain('/srv/internal/path')
  })
})

describe('StaffdeckRemoteRunner isolation', () => {
  it('creates the remote session when the registry has no binding yet', async () => {
    const harness = createHarness()
    harness.registry.get.mockReturnValue(null)
    replayFrames(harness.client, [frame('run.output.completed', { job_id: 'run-1' }, 1)])

    await new StaffdeckRemoteRunner(harness.deps).run({
      sessionId: 's-new',
      employeeId: 'emp-1',
      input: 'x',
      turnKey: 'turn-1'
    })

    expect(harness.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'emp-1', externalSessionId: 's-new' })
    )
    expect(harness.registry.set).toHaveBeenCalledWith(
      's-new',
      expect.objectContaining({ remoteSessionId: 'remote-1' })
    )
  })

  it('rejects a second concurrent run on the same session', async () => {
    const harness = createHarness()
    let release: (() => void) | undefined
    harness.client.streamRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ runId: 'run-1' })
        })
    )
    const runner = new StaffdeckRemoteRunner(harness.deps)

    const first = runner.run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'a',
      turnKey: 'turn-1'
    })
    const second = await runner.run({
      sessionId: 's1',
      employeeId: 'emp-1',
      input: 'b',
      turnKey: 'turn-2'
    })

    expect(second.phase).toBe('failed')
    expect(second.messageCode).toBe('REMOTE_RUN_IN_PROGRESS')
    expect(harness.client.streamRun).toHaveBeenCalledTimes(1)

    release?.()
    await first
  })
})
