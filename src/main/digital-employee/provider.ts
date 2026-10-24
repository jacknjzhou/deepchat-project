import { digitalEmployeeListRoute, type DigitalEmployee } from '@shared/contracts/routes'
import { MOCK_DIGITAL_EMPLOYEES } from './mockData'

/**
 * `external_user_id` 只以 **body 字段** 参与，从不走 header。
 *
 * 跨仓库核对结论：全后端没有任何位置读取 `x-external-user-id`（`grep` 整个
 * `backend/` 无命中），该端点用 Bearer 凭证鉴权、租户由凭证反推，只读
 * If-None-Match / If-Match / Last-Event-ID 三个 header。此前这里多发一个
 * 同名请求头，服务端不消费、实测响应与 ETag 完全一致，属于惰性冗余。
 *
 * 保留它的代价不是带宽，而是误导：看到请求头会以为服务端按用户过滤，于是
 * 「为什么别人能看到我的员工」这类排查会从错误的地方开始。真正生效的位置在
 * `remoteClient.streamRun` 与 `backflow` 的 JSON body 里。
 */

export interface DigitalEmployeeProvider {
  /** Resilient Provider 在回退到 fallback 后为 true；其余 Provider 不设置。 */
  readonly degraded?: boolean
  /** 本次列表数据实际来源；Resilient 在降级后报告 fallback 的来源。 */
  readonly source?: 'http' | 'mock'
  list(): Promise<DigitalEmployee[]>
}

export class MockDigitalEmployeeProvider implements DigitalEmployeeProvider {
  readonly source = 'mock' as const

  async list(): Promise<DigitalEmployee[]> {
    return MOCK_DIGITAL_EMPLOYEES.filter((employee) => employee.enabled)
  }
}

/**
 * 列表端点只需要地址与凭证。
 *
 * `externalUserId` 刻意不在这里：它是**执行期**的身份（远端 run 与回流的 body
 * 字段），列表响应不受它影响。放进来会让人以为换一个用户 id 就能看到另一批
 * 员工，而实际过滤靠凭证绑定。
 */
export interface HttpProviderConfig {
  baseUrl: string
  apiKey: string
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

export class HttpDigitalEmployeeProvider implements DigitalEmployeeProvider {
  readonly source = 'http' as const

  private etag: string | null = null
  private cache: DigitalEmployee[] = []

  constructor(
    private readonly config: HttpProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async list(): Promise<DigitalEmployee[]> {
    const url = `${normalizeBaseUrl(this.config.baseUrl)}/api/v1/digital-employees`
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.config.apiKey}`
    }
    if (this.etag) {
      headers['if-none-match'] = this.etag
    }

    const response = await this.fetchImpl(url, { headers })

    if (response.status === 304) {
      if (this.cache.length > 0) {
        return this.cache
      }
      throw new Error(`[digitalEmployee] HTTP 304 without cached payload from ${url}`)
    }
    if (!response.ok) {
      throw new Error(`[digitalEmployee] HTTP ${response.status} from ${url}`)
    }

    let body: Record<string, unknown>
    try {
      body = (await response.json()) as Record<string, unknown>
    } catch {
      throw new Error(`[digitalEmployee] invalid JSON response from ${url}`)
    }

    // StaffDeck 可能不返回 fetchedAt，契约要求非空字符串，缺失时由本地补当前时间。
    const payload = digitalEmployeeListRoute.output.parse({
      ...body,
      employees: body.employees,
      fetchedAt:
        typeof body.fetchedAt === 'string' && body.fetchedAt
          ? body.fetchedAt
          : new Date().toISOString()
    })

    this.etag = response.headers.get('etag')
    this.cache = payload.employees
    return this.cache
  }
}

export class ResilientDigitalEmployeeProvider implements DigitalEmployeeProvider {
  private isDegraded = false

  constructor(
    private readonly primary: DigitalEmployeeProvider,
    private readonly fallback: DigitalEmployeeProvider
  ) {}

  get degraded(): boolean {
    return this.isDegraded
  }

  get source(): 'http' | 'mock' {
    return this.isDegraded ? (this.fallback.source ?? 'mock') : (this.primary.source ?? 'http')
  }

  async list(): Promise<DigitalEmployee[]> {
    try {
      const employees = await this.primary.list()
      this.isDegraded = false
      return employees
    } catch (primaryError) {
      this.isDegraded = true
      try {
        return await this.fallback.list()
      } catch {
        // fallback 也失败时向上抛原始错误：route 不能伪造空列表。
        throw primaryError
      }
    }
  }
}
