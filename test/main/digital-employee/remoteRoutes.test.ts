import { describe, expect, it, vi } from 'vitest'
import { StaffdeckProblemError } from '../../../src/main/digital-employee/remoteClient'
import { createDigitalEmployeeRemoteRoutes } from '../../../src/main/digital-employee/remoteRoutes'
import { createRemoteRunOutcomeStore } from '../../../src/main/digital-employee/remoteRunOutcomes'

const BINDING = {
  remoteSessionId: 'remote-1',
  employeeId: 'emp-1',
  runId: null,
  lastEventId: null,
  executionMode: 'remote' as const
}

function createHarness() {
  const bindings = new Map<string, typeof BINDING>()
  const registry = {
    get: vi.fn((sessionId: string) => bindings.get(sessionId) ?? null),
    set: vi.fn((sessionId: string, binding: typeof BINDING) => {
      bindings.set(sessionId, binding)
    }),
    update: vi.fn((sessionId: string, patch: Partial<typeof BINDING>) => {
      const existing = bindings.get(sessionId)
      if (existing) bindings.set(sessionId, { ...existing, ...patch })
    }),
    has: vi.fn((sessionId: string) => bindings.has(sessionId)),
    delete: vi.fn((sessionId: string) => {
      bindings.delete(sessionId)
    }),
    listAll: vi.fn(() => [])
  }

  const client = {
    createSession: vi.fn().mockResolvedValue({ id: 'remote-1' }),
    currentRunId: null
  }

  const outcomes = createRemoteRunOutcomeStore()

  const runner = {
    run: vi.fn().mockResolvedValue({
      phase: 'completed',
      text: '好的',
      runId: 'run-1',
      messageId: 'm1',
      awaitingInput: null,
      messageCode: null
    })
  }

  const routes = createDigitalEmployeeRemoteRoutes({
    client: client as never,
    registry: registry as never,
    runner: runner as never,
    outcomes,
    createAssistantPlaceholder: vi.fn(() => 'm1'),
    now: () => 1_700_000_000_000
  })

  const call = async (name: string, input: unknown) => {
    const handler = routes.get(name as never)
    if (!handler) throw new Error(`route missing: ${name}`)
    return await handler(input, { caller: { kind: 'renderer', webContentsId: 1, windowId: null } })
  }

  return { routes, registry, client, runner, bindings, outcomes, call }
}

describe('digitalEmployee.bindRemoteSession', () => {
  it('creates the remote session and returns its id', async () => {
    const harness = createHarness()

    const output = await harness.call('digitalEmployee.bindRemoteSession', {
      sessionId: 'local-1',
      employeeId: 'emp-1',
      openingQuestion: '你好'
    })

    expect(output).toEqual({ remoteSessionId: 'remote-1', runId: 'run-1' })
    expect(harness.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'emp-1', externalSessionId: 'local-1' })
    )
    expect(harness.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'local-1', input: '你好' })
    )
  })

  it('reuses an existing binding instead of creating a second remote session', async () => {
    const harness = createHarness()
    harness.bindings.set('local-1', BINDING)

    await harness.call('digitalEmployee.bindRemoteSession', {
      sessionId: 'local-1',
      employeeId: 'emp-1',
      openingQuestion: '继续'
    })

    expect(harness.client.createSession).not.toHaveBeenCalled()
    expect(harness.runner.run).toHaveBeenCalledTimes(1)
  })

  it('binds without running when there is no opening question', async () => {
    const harness = createHarness()

    const output = await harness.call('digitalEmployee.bindRemoteSession', {
      sessionId: 'local-1',
      employeeId: 'emp-1'
    })

    expect(output).toEqual({ remoteSessionId: 'remote-1', runId: null })
    expect(harness.runner.run).not.toHaveBeenCalled()
  })

  it('does not persist a binding when the remote session cannot be created', async () => {
    const harness = createHarness()
    harness.client.createSession.mockRejectedValue(
      new StaffdeckProblemError(403, 'INSUFFICIENT_SCOPE', '/srv/secret/path')
    )

    await expect(
      harness.call('digitalEmployee.bindRemoteSession', {
        sessionId: 'local-1',
        employeeId: 'emp-1'
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('INSUFFICIENT_SCOPE') })

    // 失败不能留下半条绑定，否则该会话后续所有消息都会被判为远端。
    expect(harness.registry.set).not.toHaveBeenCalled()
    expect(harness.bindings.has('local-1')).toBe(false)
  })

  it('never leaks the server detail or the api key in the error', async () => {
    const harness = createHarness()
    harness.client.createSession.mockRejectedValue(
      new StaffdeckProblemError(403, 'INSUFFICIENT_SCOPE', '/srv/secret/path')
    )

    let message = ''
    try {
      await harness.call('digitalEmployee.bindRemoteSession', {
        sessionId: 'local-1',
        employeeId: 'emp-1'
      })
    } catch (error) {
      message = String((error as Error).message)
    }

    expect(message).not.toContain('/srv/secret/path')
    expect(message).not.toContain('sd_live_')
  })
})

describe('digitalEmployee.remoteStatus', () => {
  it('reports an unbound session', async () => {
    const harness = createHarness()

    const output = await harness.call('digitalEmployee.remoteStatus', { sessionId: 'local-1' })

    expect(output).toEqual({
      bound: false,
      remoteSessionId: null,
      employeeId: null,
      runId: null,
      awaitingInput: null
    })
  })

  it('reports the binding and the last awaiting_input', async () => {
    const harness = createHarness()
    harness.bindings.set('local-1', BINDING)
    harness.registry.get.mockReturnValue(BINDING)

    const output = await harness.call('digitalEmployee.remoteStatus', { sessionId: 'local-1' })

    expect(output).toMatchObject({
      bound: true,
      remoteSessionId: 'remote-1',
      employeeId: 'emp-1'
    })
  })

  /**
   * 追问明细必须跨轮存续。
   *
   * 原实现对 `awaitingInput` 用路由私有 Map，只有 bind / switch 会写；第二轮起
   * 的 run 由 `ChatService` 的 `remoteTurn` 发起，写不进去，于是第二轮之后的
   * 追问提示条恒为空——而真实对话里追问恰恰多发生在第二、三轮。
   */
  it('surfaces an awaiting_input recorded by a later turn', async () => {
    const harness = createHarness()
    harness.bindings.set('local-1', BINDING)
    harness.registry.get.mockReturnValue(BINDING)

    // 模拟 remoteTurn.send 写入第二轮的结果：路由自己没参与这一轮。
    harness.outcomes.remember('local-1', {
      task_id: 't2',
      expected_fields: ['发票号'],
      question_summary: '请补充发票号'
    })

    const output = await harness.call('digitalEmployee.remoteStatus', { sessionId: 'local-1' })

    expect(output.awaitingInput).toMatchObject({
      task_id: 't2',
      expected_fields: ['发票号']
    })
  })

  it('clears the previous awaiting_input when a later turn asks nothing', async () => {
    const harness = createHarness()
    harness.bindings.set('local-1', BINDING)
    harness.registry.get.mockReturnValue(BINDING)

    harness.outcomes.remember('local-1', { task_id: 't1', expected_fields: ['金额'] })
    // 用户答完之后这一轮结束了：必须显式写 null，否则提示条会一直挂着。
    harness.outcomes.remember('local-1', null)

    const output = await harness.call('digitalEmployee.remoteStatus', { sessionId: 'local-1' })

    expect(output.awaitingInput).toBeNull()
  })
})

describe('digitalEmployee.switchToRemote', () => {
  it('binds the session and prefixes the context summary', async () => {
    const harness = createHarness()

    const output = await harness.call('digitalEmployee.switchToRemote', {
      sessionId: 'local-1',
      employeeId: 'emp-1',
      contextSummary: '此前已确认报销金额为 300 元'
    })

    expect(output).toEqual({ remoteSessionId: 'remote-1' })
    expect(harness.registry.set).toHaveBeenCalledWith(
      'local-1',
      expect.objectContaining({ executionMode: 'hybrid' })
    )
    // 摘要作为首轮输入前缀，避免远端「从零开始」丢失上下文。
    expect(harness.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining('300 元') })
    )
  })

  it('rejects switching a session that is already remote', async () => {
    const harness = createHarness()
    harness.bindings.set('local-1', BINDING)

    await expect(
      harness.call('digitalEmployee.switchToRemote', {
        sessionId: 'local-1',
        employeeId: 'emp-1'
      })
    ).rejects.toThrow(/already/i)
  })
})
