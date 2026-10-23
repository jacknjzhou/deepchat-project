import { z } from 'zod'
import type { StaffdeckAwaitingInput } from '@shared/contracts/routes'

/**
 * 本地会话 → StaffDeck 远端会话的绑定表。
 *
 * 为什么不放 renderer：分流发生在主进程的 `ChatService.sendMessage` 入口，
 * 那里读不到 renderer 的 Pinia 状态；进程重启后也必须能恢复绑定，否则
 * 重进会话会静默退回本地执行。
 *
 * 存储复用 config entry（与 D1 的 `digitalEmployee.configHashes` 同一条通路），
 * 不新建数据库表。
 */

export const DIGITAL_EMPLOYEE_REMOTE_SESSIONS_KEY = 'digitalEmployee.remoteSessions'

const remoteSessionBindingSchema = z.object({
  remoteSessionId: z.string().min(1),
  employeeId: z.string().min(1),
  /** 最近一轮的 run id，供断线续传与取消使用 */
  runId: z.string().nullable().default(null),
  /** 最近一次收到的事件 sequence，续传游标 */
  lastEventId: z.string().nullable().default(null),
  executionMode: z.enum(['remote', 'hybrid']).default('remote')
})

export type RemoteSessionBinding = z.infer<typeof remoteSessionBindingSchema>

export interface RemoteSessionRegistryEntry extends RemoteSessionBinding {
  sessionId: string
}

const remoteSessionsStoreSchema = z.record(z.string(), z.unknown())

export interface RemoteSessionRegistryDeps {
  settings: {
    get<TValue = unknown>(key: string): TValue | undefined
    set(key: string, value: unknown): void
  }
  key?: string
}

export interface RemoteSessionRegistry {
  get(sessionId: string): RemoteSessionBinding | null
  has(sessionId: string): boolean
  set(sessionId: string, binding: RemoteSessionBinding): void
  update(sessionId: string, patch: Partial<RemoteSessionBinding>): void
  delete(sessionId: string): void
  listAll(): RemoteSessionRegistryEntry[]
}

export function createRemoteSessionRegistry(
  deps: RemoteSessionRegistryDeps
): RemoteSessionRegistry {
  const key = deps.key ?? DIGITAL_EMPLOYEE_REMOTE_SESSIONS_KEY

  /**
   * 每次读写都从 settings 重新解析，不做进程内缓存：
   * 绑定表由 main 与（潜在的）其它窗口共同写入，缓存会读到过期值。
   * 损坏数据一律按空表处理——丢绑定最多降级回本地执行，抛错会阻断整条聊天链路。
   */
  const readAll = (): Record<string, RemoteSessionBinding> => {
    const raw = deps.settings.get<unknown>(key)
    if (raw === undefined || raw === null) return {}
    const parsed = remoteSessionsStoreSchema.safeParse(raw)
    if (!parsed.success) {
      return {}
    }
    const entries: Record<string, RemoteSessionBinding> = {}
    for (const [sessionId, binding] of Object.entries(parsed.data)) {
      const single = remoteSessionBindingSchema.safeParse(binding)
      if (single.success) entries[sessionId] = single.data
    }
    return entries
  }

  const writeAll = (next: Record<string, RemoteSessionBinding>): void => {
    deps.settings.set(key, next)
  }

  return {
    get(sessionId) {
      return readAll()[sessionId] ?? null
    },
    has(sessionId) {
      return Object.hasOwn(readAll(), sessionId)
    },
    set(sessionId, binding) {
      const normalized = remoteSessionBindingSchema.parse(binding)
      writeAll({ ...readAll(), [sessionId]: normalized })
    },
    update(sessionId, patch) {
      const all = readAll()
      const existing = all[sessionId]
      // 未绑定的会话不因 update 凭空造出半条记录。
      if (!existing) return
      const merged = remoteSessionBindingSchema.parse({ ...existing, ...patch })
      writeAll({ ...all, [sessionId]: merged })
    },
    delete(sessionId) {
      const all = readAll()
      if (!Object.hasOwn(all, sessionId)) return
      const next = { ...all }
      delete next[sessionId]
      writeAll(next)
    },
    listAll() {
      return Object.entries(readAll()).map(([sessionId, binding]) => ({
        sessionId,
        ...binding
      }))
    }
  }
}

/** 供 remoteStatus 路由回填 `awaitingInput` 用；持久化在绑定表之外，避免与 run 状态耦合。 */
export type RemoteAwaitingInputSnapshot = StaffdeckAwaitingInput
