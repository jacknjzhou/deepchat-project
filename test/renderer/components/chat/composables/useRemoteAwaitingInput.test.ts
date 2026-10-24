import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useRemoteAwaitingInput } from '@/components/chat/composables/useRemoteAwaitingInput'
import type { DigitalEmployeeRemoteStatus } from '@api/DigitalEmployeeClient'
import type { StaffdeckAwaitingInput } from '@shared/contracts/routes'

type Listener = (payload: {
  sessionId: string
  employeeId: string
  phase: 'started' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled'
  runId?: string
  messageCode?: string
  fallbackToLocal?: boolean
  updatedAt: number
}) => void

function createHarness(statuses: Record<string, DigitalEmployeeRemoteStatus> = {}) {
  let listener: Listener | null = null
  const unobserve = vi.fn()
  const remoteStatus = vi.fn(async (sessionId: string) => {
    return (
      statuses[sessionId] ?? {
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'emp-1',
        runId: null,
        awaitingInput: null
      }
    )
  })

  const sessionId = ref('session-1')
  const result = useRemoteAwaitingInput({
    sessionId,
    client: {
      remoteStatus,
      onRemoteRunUpdated: (next: Listener) => {
        listener = next
        return unobserve
      }
    }
  })

  return { ...result, sessionId, remoteStatus, unobserve, emit: (payload: Parameters<Listener>[0]) => listener?.(payload), hasListener: () => listener !== null }
}

const awaiting: StaffdeckAwaitingInput = {
  task_id: 'task-1',
  expected_fields: ['金额'],
  question_summary: '请提供金额'
}

describe('useRemoteAwaitingInput', () => {
  it('does not fetch status before the first remote run event', () => {
    // 每个普通会话都会挂这个 composable：不订阅事件就不该打远端，否则每次开聊天都多一次 IPC。
    const harness = createHarness()

    expect(harness.hasListener()).toBe(true)
    expect(harness.remoteStatus).not.toHaveBeenCalled()
    expect(harness.awaitingInput.value).toBeNull()
  })

  it('loads the awaiting input detail when the run asks for more information', async () => {
    const harness = createHarness({
      'session-1': {
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'emp-1',
        runId: 'run-1',
        awaitingInput: awaiting
      }
    })

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'awaiting_input',
      updatedAt: 1
    })
    await vi.waitFor(() => expect(harness.awaitingInput.value).toEqual(awaiting))

    expect(harness.remoteStatus).toHaveBeenCalledWith('session-1')
  })

  it('clears the panel once a later turn starts', async () => {
    const harness = createHarness({
      'session-1': {
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'emp-1',
        runId: 'run-1',
        awaitingInput: awaiting
      }
    })

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'awaiting_input',
      updatedAt: 1
    })
    await vi.waitFor(() => expect(harness.awaitingInput.value).not.toBeNull())

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'started',
      updatedAt: 2
    })

    // 追问得到回答后必须撤掉提示条，否则会一直说「需要补充信息」
    expect(harness.awaitingInput.value).toBeNull()
  })

  it('ignores events from other sessions', async () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-2',
      employeeId: 'emp-1',
      phase: 'awaiting_input',
      updatedAt: 1
    })
    await Promise.resolve()

    expect(harness.remoteStatus).not.toHaveBeenCalled()
  })

  it('resets when the bound session changes', async () => {
    const harness = createHarness({
      'session-1': {
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'emp-1',
        runId: 'run-1',
        awaitingInput: awaiting
      }
    })

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'awaiting_input',
      updatedAt: 1
    })
    await vi.waitFor(() => expect(harness.awaitingInput.value).not.toBeNull())

    harness.sessionId.value = 'session-9'
    await vi.waitFor(() => expect(harness.awaitingInput.value).toBeNull())
  })

  it('keeps the panel hidden when the status lookup fails', async () => {
    const harness = createHarness()
    const failing = vi.fn(async () => {
      throw new Error('bridge down')
    })
    const local = useRemoteAwaitingInput({
      sessionId: ref('session-1'),
      client: {
        remoteStatus: failing,
        onRemoteRunUpdated: (next: Listener) => {
          queueMicrotask(() =>
            next({
              sessionId: 'session-1',
              employeeId: 'emp-1',
              phase: 'awaiting_input',
              updatedAt: 1
            })
          )
          return () => {}
        }
      }
    })

    await vi.waitFor(() => expect(failing).toHaveBeenCalled())
    // 拉不到明细时界面不能崩，只是不显示提示条
    expect(local.awaitingInput.value).toBeNull()
    expect(harness.awaitingInput.value).toBeNull()
  })

  it('unsubscribes on dispose', () => {
    const harness = createHarness()

    harness.dispose()

    expect(harness.unobserve).toHaveBeenCalledTimes(1)
  })

  it('exposes a boolean for cheap template checks', async () => {
    const harness = createHarness({
      'session-1': {
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'emp-1',
        runId: 'run-1',
        awaitingInput: awaiting
      }
    })

    expect(harness.isAwaitingInput.value).toBe(false)
    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'awaiting_input',
      updatedAt: 1
    })
    await vi.waitFor(() => expect(harness.isAwaitingInput.value).toBe(true))
  })

  it('keeps only the latest lookup when two awaiting events arrive quickly', async () => {
    let resolveFirst: ((value: DigitalEmployeeRemoteStatus) => void) | null = null
    const remoteStatus = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DigitalEmployeeRemoteStatus>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(async () => ({
        bound: true,
        remoteSessionId: 'remote-2',
        employeeId: 'emp-1',
        runId: 'run-2',
        awaitingInput: { task_id: 'task-2', expected_fields: ['事由'] } as StaffdeckAwaitingInput
      }))

    let listener: Listener | null = null
    const state = useRemoteAwaitingInput({
      sessionId: ref('session-1'),
      client: {
        remoteStatus,
        onRemoteRunUpdated: (next: Listener) => {
          listener = next
          return () => {}
        }
      }
    })

    listener!({ sessionId: 'session-1', employeeId: 'emp-1', phase: 'awaiting_input', updatedAt: 1 })
    listener!({ sessionId: 'session-1', employeeId: 'emp-1', phase: 'awaiting_input', updatedAt: 2 })
    await vi.waitFor(() => expect(state.awaitingInput.value?.task_id).toBe('task-2'))

    // 先发后到的旧响应不得覆盖新结果
    resolveFirst?.({
      bound: true,
      remoteSessionId: 'remote-1',
      employeeId: 'emp-1',
      runId: 'run-1',
      awaitingInput: { task_id: 'task-1' } as StaffdeckAwaitingInput
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(state.awaitingInput.value?.task_id).toBe('task-2')
  })

  it('clears on completed and failed phases too', async () => {
    for (const phase of ['completed', 'failed', 'cancelled'] as const) {
      // 每轮独立 harness：共用同一个会累积状态，无法证明是「相位事件」清掉的
      const harness = createHarness({
        'session-1': {
          bound: true,
          remoteSessionId: 'remote-1',
          employeeId: 'emp-1',
          runId: 'run-1',
          awaitingInput: awaiting
        }
      })
      harness.emit({
        sessionId: 'session-1',
        employeeId: 'emp-1',
        phase: 'awaiting_input',
        updatedAt: 1
      })
      await vi.waitFor(() => expect(harness.awaitingInput.value).not.toBeNull())
      harness.emit({ sessionId: 'session-1', employeeId: 'emp-1', phase, updatedAt: 2 })
      await vi.waitFor(() => expect(harness.awaitingInput.value).toBeNull())
    }
  })

  it('surfaces the last failure code for error copy', async () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      messageCode: 'INSUFFICIENT_SCOPE',
      updatedAt: 1
    })

    // 只暴露错误码，文案映射交给 staffdeckErrorCodeToI18nKey
    expect(harness.failureCode.value).toBe('INSUFFICIENT_SCOPE')
    expect(harness.isAwaitingInput.value).toBe(false)
  })

  it('drops the failure code when a new turn starts', async () => {
    const harness = createHarness()
    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      messageCode: 'RUN_FAILED',
      updatedAt: 1
    })
    expect(harness.failureCode.value).toBe('RUN_FAILED')

    harness.emit({ sessionId: 'session-1', employeeId: 'emp-1', phase: 'started', updatedAt: 2 })

    expect(harness.failureCode.value).toBeNull()
  })
})

describe('useRemoteAwaitingInput hybrid fallback flag', () => {
  it('remembers that the session fell back to local execution', () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      messageCode: 'REMOTE_TRANSPORT_ERROR',
      fallbackToLocal: true,
      updatedAt: 1
    })

    // 错误码说「这轮为什么失败」，本标记说「下一轮走哪儿」，两者同时为真。
    expect(harness.fellBackToLocal.value).toBe(true)
    expect(harness.failureCode.value).toBe('REMOTE_TRANSPORT_ERROR')
  })

  it('keeps the flag across a later turn because the binding is gone for good', () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      fallbackToLocal: true,
      updatedAt: 1
    })
    harness.emit({ sessionId: 'session-1', employeeId: 'emp-1', phase: 'started', updatedAt: 2 })

    // 降级是粘性的：`started` 清掉的是错误码，不是「已换引擎」这个事实。
    expect(harness.fellBackToLocal.value).toBe(true)
    expect(harness.failureCode.value).toBeNull()
  })

  it('does not flag a plain failure as a fallback', () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      messageCode: 'RUN_FAILED',
      updatedAt: 1
    })

    expect(harness.fellBackToLocal.value).toBe(false)
  })

  it('clears the flag when the user moves to another session', async () => {
    const harness = createHarness()

    harness.emit({
      sessionId: 'session-1',
      employeeId: 'emp-1',
      phase: 'failed',
      fallbackToLocal: true,
      updatedAt: 1
    })
    expect(harness.fellBackToLocal.value).toBe(true)

    harness.sessionId.value = 'session-2'
    await vi.waitFor(() => expect(harness.fellBackToLocal.value).toBe(false))
  })
})
