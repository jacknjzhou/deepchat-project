import { effectScope, nextTick, reactive, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回流触点是「流结束」。
 *
 * 这个文件只守一件事：**游标什么时候前进**。P1-1 之后语义变了一点——主进程把
 * 事件落进本地队列也算接手，renderer 必须放掉游标，否则它下一轮会重采同一批。
 * 反过来，关了回流 / 没配连接时游标必须原地不动。
 */

// 必须是响应式的：composable 靠 watch 观察「流从跑到停」，普通对象上的赋值
// 不会触发依赖，测试会变成「断言某件事从未发生」而永远通过。
const messageStore = reactive({
  isStreaming: false,
  currentStreamSessionId: '' as string,
  messages: [] as Array<Record<string, unknown>>
})

const setStreaming = (streaming: boolean, sessionId: string): void => {
  messageStore.isStreaming = streaming
  messageStore.currentStreamSessionId = sessionId
}

const digitalEmployeeStore = {
  employeeForSession: vi.fn(),
  reportBackflow: vi.fn()
}

vi.mock('@/stores/ui/message', () => ({
  useMessageStore: () => messageStore
}))

vi.mock('@/stores/digitalEmployeeStore', () => ({
  useDigitalEmployeeStore: () => digitalEmployeeStore
}))

const collectBackflowEvents = vi.fn()
vi.mock('@/features/chat-page/model/backflowEvents', () => ({
  collectBackflowEvents: (input: unknown) => collectBackflowEvents(input)
}))

import {
  resetBackflowCursor,
  useBackflowReporting
} from '@/features/chat-page/composables/useBackflowReporting'

const LOCAL_EMPLOYEE = { id: 'agent_1', name: '采购助手', executionMode: 'local' }

function createHarness() {
  const sessionId = ref('s1')
  const scope = effectScope()
  scope.run(() => {
    useBackflowReporting({ sessionId })
  })
  return { sessionId, scope }
}

const flushTurn = async () => {
  setStreaming(true, 's1')
  await nextTick()
  setStreaming(false, 's1')
  await nextTick()
  await nextTick()
}

describe('useBackflowReporting', () => {
  beforeEach(() => {
    resetBackflowCursor()
    vi.clearAllMocks()
    setStreaming(false, '')
    digitalEmployeeStore.employeeForSession.mockReturnValue(LOCAL_EMPLOYEE)
    digitalEmployeeStore.reportBackflow.mockResolvedValue({
      ok: true,
      reason: null,
      delivered: 1,
      queued: 0,
      pending: 0
    })
    collectBackflowEvents.mockReturnValue({
      events: [{ type: 'message', eventId: 'm:1', role: 'user', content: 'hi' }],
      nextOrderSeq: 5
    })
  })

  it('reports once the stream ends', async () => {
    createHarness()
    await flushTurn()

    expect(digitalEmployeeStore.reportBackflow).toHaveBeenCalledTimes(1)
    expect(digitalEmployeeStore.reportBackflow).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'agent_1', sessionId: 's1', title: '采购助手' })
    )
  })

  it('does not report a remote employee', async () => {
    // 远端对话本来就在服务端，再报一次会让管理端看到每条消息两份。
    digitalEmployeeStore.employeeForSession.mockReturnValue({
      id: 'agent_2',
      name: '远端助手',
      executionMode: 'remote'
    })
    createHarness()
    await flushTurn()

    expect(digitalEmployeeStore.reportBackflow).not.toHaveBeenCalled()
  })

  it('keeps the cursor when the main process did not take the batch', async () => {
    // `ok: false`：关了回流 / 没配连接 / 事件被拒收——这批没人接手，必须重发。
    digitalEmployeeStore.reportBackflow.mockResolvedValue({
      ok: false,
      reason: 'DISABLED',
      delivered: 0,
      queued: 0,
      pending: 0
    })
    createHarness()
    await flushTurn()

    await flushTurn()
    // 第二次调用仍从同一个基线开始采，说明游标没被推进。
    expect(collectBackflowEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterOrderSeq: null })
    )
  })

  it('moves the cursor when the batch was only queued', async () => {
    // `ok: true` + `reason: 'NETWORK'`：主进程落盘了，本地队列负责补发。
    // renderer 若因此保留游标，下一轮会重采同一批，队列里就多出一份。
    digitalEmployeeStore.reportBackflow.mockResolvedValue({
      ok: true,
      reason: 'NETWORK',
      delivered: 0,
      queued: 1,
      pending: 1
    })
    createHarness()
    await flushTurn()
    await flushTurn()

    expect(collectBackflowEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterOrderSeq: 5 })
    )
  })

  it('does not move the cursor when the IPC call itself failed', async () => {
    // `null` 是 IPC 异常，与「服务端拒收」不同：连结果都没拿到，不能假设有人接手。
    digitalEmployeeStore.reportBackflow.mockResolvedValue(null)
    createHarness()
    await flushTurn()
    await flushTurn()

    expect(collectBackflowEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterOrderSeq: null })
    )
  })

  it('ignores a stream that belongs to another session', async () => {
    createHarness()
    setStreaming(true, 'other')
    await nextTick()
    setStreaming(false, 'other')
    await nextTick()
    await nextTick()

    expect(digitalEmployeeStore.reportBackflow).not.toHaveBeenCalled()
  })

  it('does not report when there is nothing new', async () => {
    collectBackflowEvents.mockReturnValue({ events: [], nextOrderSeq: null })
    createHarness()
    await flushTurn()

    expect(digitalEmployeeStore.reportBackflow).not.toHaveBeenCalled()
  })

  it('swallows a rejected report instead of surfacing it', async () => {
    // 上报挂在发消息的返回路径上：抛出去会变成用户看到的「发送失败」。
    digitalEmployeeStore.reportBackflow.mockRejectedValue(new Error('boom'))
    createHarness()

    await expect(flushTurn()).resolves.toBeUndefined()
  })
})
