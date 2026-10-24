import type { StaffdeckAwaitingInput } from '@shared/contracts/routes'

/**
 * 「这个会话最近一轮问到哪了」——追问明细的进程内暂存。
 *
 * 为什么不塞进绑定表：绑定表回答的是「这个会话在哪执行」，那是跨进程要恢复的
 * 持久事实；追问回答的是「这一轮缺哪些字段」，答完就该消失。混在一起会让重启
 * 后冒出一条早已回答过的提示条，而绑定恰恰必须能恢复。
 *
 * 为什么不放 renderer：`digitalEmployee.remoteStatus` 由 main 回答，而第二轮起
 * 的 run 由 `ChatService` 经 `remoteTurn` 发起，整条链路没有 renderer 参与。
 * 于是状态只能由「发起 run 的那一层」记录——首轮是 bind/switch 路由，之后是
 * `remoteTurn.send`。两边共用同一份，是本模块存在的唯一理由。
 *
 * 不落库：追问是瞬时的，进程重启后那一轮早就结束了，补查一个旧 run 只会拿到
 * 与服务端现状不符的结论。
 */

export interface RemoteRunOutcomeStore {
  /**
   * 记录一轮的追问明细。
   *
   * 必须每轮都调，即使是 `null`：那一轮没有追问，正是「该把上一轮的提示条撤掉」
   * 的信号。只在有追问时写入，会让提示条在用户答完之后继续挂着。
   */
  remember(sessionId: string, awaitingInput: StaffdeckAwaitingInput | null): void
  awaitingInputOf(sessionId: string): StaffdeckAwaitingInput | null
  /** 会话不再走远端（降级、解绑）时丢弃，避免旧明细被后来的查询读到。 */
  forget(sessionId: string): void
}

/**
 * 上限只为防长跑进程无界增长，不是业务约束。
 *
 * 一个员工会话对应一条记录，正常用量远小于此；命中上限时淘汰最久未更新的那条，
 * 代价是该会话的提示条要等下一轮才恢复——远好于内存随会话数单调上涨。
 */
const MAX_ENTRIES = 512

export function createRemoteRunOutcomeStore(): RemoteRunOutcomeStore {
  /**
   * Map 保持插入顺序，删除后重插即把该键推到末尾，于是「表头 = 最久未更新」。
   * 这比额外维护时间戳省事，也不会因为时钟回拨而失效。
   */
  const entries = new Map<string, StaffdeckAwaitingInput | null>()

  return {
    remember(sessionId, awaitingInput) {
      entries.delete(sessionId)
      entries.set(sessionId, awaitingInput)

      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },
    awaitingInputOf(sessionId) {
      return entries.get(sessionId) ?? null
    },
    forget(sessionId) {
      entries.delete(sessionId)
    }
  }
}
