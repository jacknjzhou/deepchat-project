import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { DigitalEmployeeRemoteStatus } from '@api/DigitalEmployeeClient'
import type { StaffdeckAwaitingInput } from '@shared/contracts/routes'

/** `digitalEmployee.remoteRunUpdated` 的最小形状；避免 renderer 依赖事件契约的全部细节。 */
export interface RemoteRunUpdatedPayload {
  sessionId: string
  employeeId: string
  phase: 'started' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled'
  runId?: string
  messageCode?: string
  /** hybrid 会话失败后已退回本地执行；绑定表在 main，只有它能给出这个结论。 */
  fallbackToLocal?: boolean
  updatedAt: number
}

export interface RemoteAwaitingInputClient {
  remoteStatus(sessionId: string): Promise<DigitalEmployeeRemoteStatus>
  onRemoteRunUpdated(listener: (payload: RemoteRunUpdatedPayload) => void): () => void
}

export interface UseRemoteAwaitingInputOptions {
  sessionId: Ref<string>
  client: RemoteAwaitingInputClient
}

/**
 * 把「远端 run 状态事件」翻译成聊天页需要的两组状态：
 * - `awaitingInput`：追问提示条的数据（事件本身不带明细，需回查 `remoteStatus`）
 * - `failureCode`：失败时的错误码（文案由 `staffdeckErrorCodeToI18nKey` 映射）
 *
 * 为什么不缓存 phase：正在生成的状态已经由 `chat.stream.updated` 驱动，
 * 再存一份 phase 就会有两个真相来源。
 */
export function useRemoteAwaitingInput(options: UseRemoteAwaitingInputOptions) {
  const awaitingInput = ref<StaffdeckAwaitingInput | null>(null)
  const failureCode = ref<string | null>(null)
  /**
   * 已退回本地执行。
   *
   * 与 `failureCode` 分开：错误码说「这轮为什么失败」，本标记说「下一轮走哪儿」。
   * 两者可以同时为真——失败恰恰是降级的原因。
   */
  const fellBackToLocal = ref(false)

  // 只接受最后一次回查的结果：连续两轮追问时，先发后到的旧响应不能覆盖新结果。
  let lookupToken = 0

  const reset = (): void => {
    lookupToken += 1
    awaitingInput.value = null
    failureCode.value = null
  }

  const loadStatus = async (sessionId: string): Promise<void> => {
    const token = ++lookupToken
    try {
      const status = await options.client.remoteStatus(sessionId)
      if (token !== lookupToken) return
      awaitingInput.value = status.awaitingInput ?? null
    } catch {
      // 回查失败只是拿不到明细，界面退化为「无提示条」，不能因此中断聊天。
      if (token === lookupToken) awaitingInput.value = null
    }
  }

  const unsubscribe = options.client.onRemoteRunUpdated((payload) => {
    if (payload.sessionId !== options.sessionId.value) return

    // 降级是粘性的：此后这个会话一直走本地，直到用户重新切换。
    // 放在相位分支之前，因为 `failed` 分支会调用 reset() 清掉临时状态。
    if (payload.fallbackToLocal) fellBackToLocal.value = true

    if (payload.phase === 'awaiting_input') {
      failureCode.value = null
      void loadStatus(payload.sessionId)
      return
    }

    reset()
    if (payload.phase === 'failed' && payload.messageCode) {
      failureCode.value = payload.messageCode
    }
  })

  watch(options.sessionId, () => {
    reset()
    fellBackToLocal.value = false
  })

  // 组件内使用时随作用域自动回收；脱离作用域调用（测试/工具函数）时由调用方 dispose。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      unsubscribe()
    })
  }

  return {
    awaitingInput,
    failureCode,
    fellBackToLocal,
    isAwaitingInput: computed(() => awaitingInput.value !== null),
    dispose: () => unsubscribe()
  }
}
