import { watch, type Ref } from 'vue'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import { useMessageStore } from '@/stores/ui/message'
import { collectBackflowEvents } from '../model/backflowEvents'

/**
 * 每轮结束时把本地执行的对话上报给 StaffDeck。
 *
 * 触点选在「流结束」而不是「用户发消息」：一轮可能包含多轮工具调用，中途没有
 * 一个完整的边界，只有结算之后消息记录才是终态。
 *
 * 四条必须守住的约束：
 *
 * - **永不阻塞对话**。上报是 fire-and-forget，任何失败都只静默记日志。
 * - **游标在「主进程接手」后前进**，不只是「送达后」。主进程发不出去时会落进
 *   本地队列按退避补发，那批事件已经有人负责，renderer 再重采只会让两边重复
 *   计数。真正需要保留游标的只有「主进程没接手」（关了回流、没配连接、事件被
 *   服务端明确拒收）。
 * - **只报本地执行的员工**。远端员工的对话本来就在服务端，重报会让管理端看到
 *   每条消息两份。这个判断在 store 里也有一层，这里是避免白跑一次 IPC。
 * - **切换会话要重置游标**。游标是模块级 Map，不清就会把上一个会话的进度
 *   当成这个会话的基线，整个窗口被跳过。
 */

/**
 * 每个会话已经上报到哪一条（`orderSeq` 游标）。
 *
 * 放模块级而不是组件内：切换会话会重建对话页，游标跟着组件消失就会把整个窗口
 * 重报一遍。虽然服务端能去重，但那是兜底不是设计意图。
 */
const reportedThrough = new Map<string, number>()

export function resetBackflowCursor(sessionId?: string): void {
  if (sessionId === undefined) {
    reportedThrough.clear()
    return
  }
  reportedThrough.delete(sessionId)
}

export interface UseBackflowReportingOptions {
  sessionId: Ref<string>
}

export function useBackflowReporting(options: UseBackflowReportingOptions): void {
  const messageStore = useMessageStore()
  const digitalEmployeeStore = useDigitalEmployeeStore()

  const flush = async (sessionId: string): Promise<void> => {
    const employee = digitalEmployeeStore.employeeForSession(sessionId)
    if (!employee || employee.executionMode === 'remote') return

    const collected = collectBackflowEvents({
      messages: messageStore.messages,
      afterOrderSeq: reportedThrough.get(sessionId) ?? null
    })
    if (collected.events.length === 0) return

    const result = await digitalEmployeeStore.reportBackflow({
      employeeId: employee.id,
      sessionId,
      title: employee.name,
      events: collected.events
    })
    // `null` 是 IPC 层异常，`ok: false` 是主进程没接手（关了回流/没配连接/被拒收）。
    // 两种都要保留游标，让下一轮重发同一批。
    if (!result?.ok) return
    if (collected.nextOrderSeq !== null) {
      reportedThrough.set(sessionId, collected.nextOrderSeq)
    }
  }

  // 只关心「这个会话刚刚结束一轮」。`isStreaming` 在流被别的会话接管时也会
  // 变 false，所以要同时看它落到哪个会话上，否则会把别处的会话当成自己结束。
  watch(
    () =>
      messageStore.isStreaming && messageStore.currentStreamSessionId === options.sessionId.value,
    (streaming, wasStreaming) => {
      if (!streaming && wasStreaming) {
        void flush(options.sessionId.value).catch(() => undefined)
      }
    }
  )
}
