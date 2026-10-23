import { z } from 'zod'

/**
 * 知识同步状态：每员工 → 每远端知识库 → 每概念 hash 的对照表。
 *
 * 为什么不放 renderer：同步由 main 的后台调度器执行，索引也建在 main 的
 * 向量库里；renderer 只读状态做「知识可能过期」提示，不参与写。
 *
 * 存储复用 config entry（与 `digitalEmployee.remoteSessions` 同一条通路），
 * 不新建数据库表——同步状态本质上是从服务端可重建的缓存，不该进业务库。
 */

export const DIGITAL_EMPLOYEE_KNOWLEDGE_SYNC_KEY = 'digitalEmployee.knowledgeSync'

/** 同步失败的原因；UI 按此映射文案，因此取值必须收敛在这几个之上。 */
export const knowledgeStaleReasons = [
  /** 连不上服务端（网络、DNS、超时） */
  'UNREACHABLE',
  /** 服务端返回非 2xx（'HTTP_404' 这类动态值另算，见下） */
  'HTTP_ERROR',
  /** 只同步成功了一部分概念 */
  'PARTIAL',
  /** 本机没有可用的嵌入模型，建不了索引 */
  'NO_EMBEDDING_MODEL',
  /** 索引写入失败（磁盘、维度不匹配） */
  'INDEX_FAILED'
] as const

export type KnowledgeStaleReason =
  | (typeof knowledgeStaleReasons)[number]
  /** `HTTP_<status>`：保留具体状态码，便于排查 401 与 500 的区别 */
  | `HTTP_${number}`

const conceptRecordSchema = z.object({
  /** 服务端 `content_md` 的 sha256 前 16 位 */
  hash: z.string().min(1),
  /** 本地知识库里的文件 id：增量更新靠它定位，不能靠路径 */
  fileId: z.string().min(1)
})

const packageStateSchema = z.object({
  /** 服务端 `configVersion`（`kv1:{digest}`），列表级变化判据 */
  configVersion: z.string(),
  /** 服务端 `configHash`（`sha256:{digest}`），单 KB 变化判据 */
  configHash: z.string(),
  /** 清单端点的 ETag，用于 304 协商 */
  etag: z.string().nullable(),
  /** 旧副本是否已过期。为真时保留旧向量，不删不重建。 */
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  lastSyncAt: z.string(),
  concepts: z.record(z.string(), conceptRecordSchema)
})

const employeeStateSchema = z.object({
  /** 本地内置知识库 id（`de-` 前缀 + 员工 id 派生） */
  localKnowledgeBaseId: z.string().min(1),
  /** key = 远端 `knowledgeBaseId` */
  packages: z.record(z.string(), packageStateSchema)
})

export type KnowledgePackageState = z.infer<typeof packageStateSchema>
export type KnowledgeEmployeeState = z.infer<typeof employeeStateSchema>

export interface KnowledgeEmployeeEntry extends KnowledgeEmployeeState {
  employeeId: string
}

export interface KnowledgeSyncStateStoreDeps {
  settings: {
    get<TValue = unknown>(key: string): TValue | undefined
    set(key: string, value: unknown): void
  }
  key?: string
}

export interface KnowledgeSyncStateStore {
  getEmployee(employeeId: string): KnowledgeEmployeeState | null
  listEmployees(): KnowledgeEmployeeEntry[]
  setEmployee(employeeId: string, state: KnowledgeEmployeeState): void
  removeEmployee(employeeId: string): void
  /** 只改 stale 相关字段，不动已同步的 hash 表——旧向量仍可检索。 */
  markPackageStale(employeeId: string, knowledgeBaseId: string, reason: string): void
  clearPackageStale(employeeId: string, knowledgeBaseId: string): void
  removePackage(employeeId: string, knowledgeBaseId: string): void
}

export function createKnowledgeSyncStateStore(
  deps: KnowledgeSyncStateStoreDeps
): KnowledgeSyncStateStore {
  const key = deps.key ?? DIGITAL_EMPLOYEE_KNOWLEDGE_SYNC_KEY

  /**
   * 每次读写都从 settings 重新解析，不做进程内缓存：
   * 调度器与「首轮对话触发同步」可能并发写，缓存会互相覆盖。
   * 损坏数据按空状态处理——丢掉的只是增量基线，代价是全量重拉一次。
   */
  const readAll = (): Record<string, KnowledgeEmployeeState> => {
    const raw = deps.settings.get<unknown>(key)
    if (raw === undefined || raw === null) return {}
    if (typeof raw !== 'object' || Array.isArray(raw)) return {}

    const entries: Record<string, KnowledgeEmployeeState> = {}
    for (const [employeeId, state] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = employeeStateSchema.safeParse(state)
      // 单条损坏不牵连其他员工：跳过这一条，其余照常。
      if (parsed.success) entries[employeeId] = parsed.data
    }
    return entries
  }

  const writeAll = (next: Record<string, KnowledgeEmployeeState>): void => {
    deps.settings.set(key, next)
  }

  /** 取员工记录并保证可写；未记录时返回 null，由调用方决定是否新建。 */
  const mutateEmployee = (
    employeeId: string,
    mutate: (state: KnowledgeEmployeeState) => void
  ): boolean => {
    const all = readAll()
    const existing = all[employeeId]
    if (!existing) return false
    mutate(existing)
    writeAll({ ...all, [employeeId]: existing })
    return true
  }

  return {
    getEmployee(employeeId) {
      return readAll()[employeeId] ?? null
    },
    listEmployees() {
      return Object.entries(readAll()).map(([employeeId, state]) => ({
        employeeId,
        ...state
      }))
    },
    setEmployee(employeeId, state) {
      const normalized = employeeStateSchema.parse(state)
      writeAll({ ...readAll(), [employeeId]: normalized })
    },
    removeEmployee(employeeId) {
      const all = readAll()
      if (!Object.hasOwn(all, employeeId)) return
      const next = { ...all }
      delete next[employeeId]
      writeAll(next)
    },
    markPackageStale(employeeId, knowledgeBaseId, reason) {
      mutateEmployee(employeeId, (state) => {
        const target = state.packages[knowledgeBaseId]
        // 未同步过的 KB 不该被标 stale：没有旧副本可保，标了只会误导用户。
        if (!target) return
        target.stale = true
        target.staleReason = reason
      })
    },
    clearPackageStale(employeeId, knowledgeBaseId) {
      mutateEmployee(employeeId, (state) => {
        const target = state.packages[knowledgeBaseId]
        if (!target) return
        target.stale = false
        target.staleReason = null
      })
    },
    removePackage(employeeId, knowledgeBaseId) {
      const all = readAll()
      const existing = all[employeeId]
      if (!existing) return
      if (!Object.hasOwn(existing.packages, knowledgeBaseId)) return

      const nextPackages = { ...existing.packages }
      delete nextPackages[knowledgeBaseId]

      if (Object.keys(nextPackages).length === 0) {
        // 最后一个包被移除就整条记录报废：留着空 packages 会让
        // 「这个员工同步过吗」变成假阳性，调度器会对一个空壳反复跑。
        const next = { ...all }
        delete next[employeeId]
        writeAll(next)
        return
      }

      writeAll({ ...all, [employeeId]: { ...existing, packages: nextPackages } })
    }
  }
}
