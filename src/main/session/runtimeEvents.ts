import type { AssistantMessageBlock } from '@shared/types/agent-interface'
import type { AssistantDeliverySegment } from '@shared/lib/assistantDeliverySegments'

export type SessionRuntimeStatus = 'idle' | 'generating' | 'error'

/** 等待用户操作（权限批准/提问回答）的卡片信息，随状态更新附带。 */
export interface SessionWaitingInteraction {
  type: 'permission' | 'question'
  messageId: string
  toolCallId: string
  actionBlock: AssistantMessageBlock
}

/**
 * 会话运行时事件的进程内广播（runtimeEvents）：agent runtime 的流式产出
 * （blocks/状态变更/用量）经此分发到订阅方（如聊天流桥接层）。发布是同步
 * 且逐个容错的——单个订阅者抛错不影响其它订阅者，也不打断事件流。
 * 注意这是进程内事件总线，不含跨进程投递；到渲染层另有桥接。
 */

/** 一次更新只携带一种负载：blocks 为内容流，status 为状态迁移。 */
export interface SessionRuntimeUpdate {
  sessionId: string
  kind: 'blocks' | 'status'
  updatedAt: number
  messageId?: string
  status?: SessionRuntimeStatus
  previewMarkdown?: string
  responseMarkdown?: string
  deliverySegments?: AssistantDeliverySegment[]
  waitingInteraction?: SessionWaitingInteraction | null
  usage?: Record<string, number>
}

export interface SessionRuntimeEventPort {
  subscribe(listener: (update: SessionRuntimeUpdate) => void): () => void
}

/** 简单同步事件总线：publish 广播、subscribe 返回退订函数。 */
export class SessionRuntimeEvents implements SessionRuntimeEventPort {
  private readonly listeners = new Set<(update: SessionRuntimeUpdate) => void>()

  publish(update: SessionRuntimeUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update)
      } catch (error) {
        console.error('[SessionRuntimeEvents] Failed to publish session update:', error)
      }
    }
  }

  subscribe(listener: (update: SessionRuntimeUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
