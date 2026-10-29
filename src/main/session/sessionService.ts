import type {
  ChatMessagePageResult,
  CreateSessionInput,
  MessageStartResult,
  MessagePageCursor,
  SessionWithState
} from '@shared/types/agent-interface'
import type { Scheduler } from '@/routes/scheduler'
import type { RendererRouteCaller } from '@/routes/routeRegistry'

const SESSION_OPERATION_TIMEOUT_MS = 5_000
const SESSION_LIST_TIMEOUT_MS = 15_000
const DEFAULT_RESTORE_MESSAGE_LIMIT = 100

export type SessionRouteContext = RendererRouteCaller

export type SessionListFilters = {
  agentId?: string
  projectDir?: string
  includeSubagents?: boolean
  parentSessionId?: string
}

export interface SessionServiceLifecyclePort {
  createSession(
    input: CreateSessionInput,
    webContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<SessionWithState & { initialTurn?: MessageStartResult }>
}

export interface SessionServiceProjectionPort {
  getSession(sessionId: string): Promise<SessionWithState | null>
  listSessions(filters?: SessionListFilters): Promise<SessionWithState[]>
  listMessagesPage(
    sessionId: string,
    options?: { limit?: number; cursor?: MessagePageCursor | null }
  ): Promise<ChatMessagePageResult>
}

export interface SessionServiceDesktopPort {
  activate(webContentsId: number, sessionId: string): Promise<void>
  deactivate(webContentsId: number): Promise<void>
  getActive(webContentsId: number): Promise<SessionWithState | null>
}

/**
 * 会话路由服务（SessionService）：渲染层会话路由的最外层薄封装。职责仅两件：
 * 给每个操作套 scheduler 超时，并把调用转发给对应模块（lifecycle 建会话、
 * projection 读数据、desktop 窗口绑定）。
 *
 * 例外是 createSession 不套超时：超时只是「不再等结果」，不会取消底层操作，
 * 建会话这种写持久态的操作一旦晚到的重复执行就会产生重复会话；取消应由
 * 调用方 signal 驱动。restoreSession 的会话读取带一次重试，容忍启动初期
 * 运行时尚未就绪的瞬时失败。
 */
export class SessionService {
  constructor(
    private readonly deps: {
      lifecycle: SessionServiceLifecyclePort
      projection: SessionServiceProjectionPort
      desktop: SessionServiceDesktopPort
      scheduler: Scheduler
    }
  ) {}

  async createSession(
    input: CreateSessionInput,
    context: SessionRouteContext,
    options?: { signal?: AbortSignal }
  ): Promise<SessionWithState & { initialTurn?: MessageStartResult }> {
    // Creation mutates durable/session runtime state. Scheduler.timeout only races the promise and
    // cannot cancel the underlying operation, so timing out here could publish a late duplicate.
    return options
      ? await this.deps.lifecycle.createSession(input, context.webContentsId, options)
      : await this.deps.lifecycle.createSession(input, context.webContentsId)
  }

  /** 恢复会话视图：会话 + 首页消息一次拿齐；会话不存在返回空页而不是报错。 */
  async restoreSession(
    sessionId: string,
    limit?: number
  ): Promise<
    {
      session: SessionWithState | null
    } & ChatMessagePageResult
  > {
    const effectiveLimit = limit ?? DEFAULT_RESTORE_MESSAGE_LIMIT
    const session = await this.deps.scheduler.retry({
      task: async () =>
        await this.deps.scheduler.timeout({
          task: this.deps.projection.getSession(sessionId),
          ms: SESSION_OPERATION_TIMEOUT_MS,
          reason: `sessions.restore:${sessionId}:session`
        }),
      maxAttempts: 2,
      initialDelayMs: 25,
      backoff: 1,
      reason: `sessions.restore:${sessionId}`
    })

    if (!session) {
      return {
        session: null,
        messages: [],
        nextCursor: null,
        hasMore: false
      }
    }

    const page = await this.deps.scheduler.timeout({
      task: this.deps.projection.listMessagesPage(sessionId, {
        limit: effectiveLimit
      }),
      ms: SESSION_OPERATION_TIMEOUT_MS,
      reason: `sessions.restore:${sessionId}:messages`
    })

    return {
      session,
      ...page
    }
  }

  async listMessagesPage(
    sessionId: string,
    options?: {
      limit?: number
      cursor?: MessagePageCursor | null
    }
  ): Promise<ChatMessagePageResult> {
    return await this.deps.scheduler.timeout({
      task: this.deps.projection.listMessagesPage(sessionId, options),
      ms: SESSION_OPERATION_TIMEOUT_MS,
      reason: `sessions.listMessagesPage:${sessionId}`
    })
  }

  async listSessions(filters?: SessionListFilters) {
    return await this.deps.scheduler.timeout({
      task: this.deps.projection.listSessions(filters),
      ms: SESSION_LIST_TIMEOUT_MS,
      reason: 'sessions.list'
    })
  }

  async activateSession(context: SessionRouteContext, sessionId: string): Promise<void> {
    await this.deps.scheduler.timeout({
      task: this.deps.desktop.activate(context.webContentsId, sessionId),
      ms: SESSION_OPERATION_TIMEOUT_MS,
      reason: `sessions.activate:${sessionId}`
    })
  }

  async deactivateSession(context: SessionRouteContext): Promise<void> {
    await this.deps.scheduler.timeout({
      task: this.deps.desktop.deactivate(context.webContentsId),
      ms: SESSION_OPERATION_TIMEOUT_MS,
      reason: 'sessions.deactivate'
    })
  }

  async getActiveSession(context: SessionRouteContext): Promise<SessionWithState | null> {
    return await this.deps.scheduler.timeout({
      task: this.deps.desktop.getActive(context.webContentsId),
      ms: SESSION_OPERATION_TIMEOUT_MS,
      reason: 'sessions.getActive'
    })
  }
}
