export interface SessionDeletionGatePort {
  runWithSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
  runWithSessionDeletion<T>(sessionId: string, deletion: () => Promise<T>): Promise<T>
}

/**
 * 会话删除门（SessionDeletionGate）：用「操作计数 + 删除标记」保证删除与
 * 其它会话操作互斥。规则：
 * - runWithSessionOperation：普通操作入口。会话正在删除则直接拒绝；否则
 *   计数 +1 进入，结束时 -1，归零时唤醒等待的删除方。
 * - runWithSessionDeletion：删除入口。先挂上删除标记（此后新操作一律被拒），
 *   再等待在途操作排空（最多 30 秒，超时报错而不是带着活动操作硬删）。
 * 这与 assignment 的操作门不同：那边是同一会话写操作的排队串行化，这里是
 * 「删除 vs 一切」的读多写少互斥，允许多个普通操作并发共存。
 */

/** 删除前等待在途操作排空的上限；超时说明有操作卡死，宁可不删也不硬删。 */
export const SESSION_OPERATION_DRAIN_TIMEOUT_MS = 30_000

export class SessionDeletionGate implements SessionDeletionGatePort {
  /** 每会话在途普通操作计数。 */
  private readonly activeOperations = new Map<string, number>()
  private readonly deletingSessionIds = new Set<string>()
  private readonly drainWaiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly operationDrainTimeoutMs: number = SESSION_OPERATION_DRAIN_TIMEOUT_MS
  ) {
    if (!Number.isFinite(operationDrainTimeoutMs) || operationDrainTimeoutMs <= 0) {
      throw new Error('Session operation drain timeout must be a positive finite number.')
    }
  }

  async runWithSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const normalizedSessionId = this.normalizeSessionId(sessionId)
    if (this.deletingSessionIds.has(normalizedSessionId)) {
      throw new Error(`Session is being deleted: ${normalizedSessionId}`)
    }

    this.activeOperations.set(
      normalizedSessionId,
      (this.activeOperations.get(normalizedSessionId) ?? 0) + 1
    )
    try {
      return await operation()
    } finally {
      this.finishSessionOperation(normalizedSessionId)
    }
  }

  async runWithSessionDeletion<T>(sessionId: string, deletion: () => Promise<T>): Promise<T> {
    const normalizedSessionId = this.normalizeSessionId(sessionId)
    if (this.deletingSessionIds.has(normalizedSessionId)) {
      throw new Error(`Session deletion is already in progress: ${normalizedSessionId}`)
    }

    this.deletingSessionIds.add(normalizedSessionId)
    try {
      await this.waitForSessionOperations(normalizedSessionId)
      return await deletion()
    } finally {
      this.deletingSessionIds.delete(normalizedSessionId)
    }
  }

  private normalizeSessionId(sessionId: string): string {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) throw new Error('Session ID is required.')
    return normalizedSessionId
  }

  private finishSessionOperation(sessionId: string): void {
    const remaining = (this.activeOperations.get(sessionId) ?? 1) - 1
    if (remaining > 0) {
      this.activeOperations.set(sessionId, remaining)
      return
    }

    this.activeOperations.delete(sessionId)
    const waiters = this.drainWaiters.get(sessionId)
    this.drainWaiters.delete(sessionId)
    for (const resolve of waiters ?? []) resolve()
  }

  /** 删除前等待在途操作归零；带超时的 waiter 注册/唤醒。 */
  private async waitForSessionOperations(sessionId: string): Promise<void> {
    if ((this.activeOperations.get(sessionId) ?? 0) === 0) return
    await new Promise<void>((resolve, reject) => {
      let waiters = this.drainWaiters.get(sessionId)
      if (!waiters) {
        waiters = new Set()
        this.drainWaiters.set(sessionId, waiters)
      }

      const waiter = (): void => {
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        const currentWaiters = this.drainWaiters.get(sessionId)
        currentWaiters?.delete(waiter)
        if (currentWaiters?.size === 0 && this.drainWaiters.get(sessionId) === currentWaiters) {
          this.drainWaiters.delete(sessionId)
        }
        reject(
          new Error(
            `Timed out waiting for active Session operations to drain: ${sessionId} ` +
              `(${this.operationDrainTimeoutMs}ms)`
          )
        )
      }, this.operationDrainTimeoutMs)
      waiters.add(waiter)
    })
  }
}
