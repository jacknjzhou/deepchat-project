import { digitalEmployeeListRoute, type DigitalEmployee } from '@shared/contracts/routes'
import { MOCK_DIGITAL_EMPLOYEES } from './mockData'

/**
 * 跨仓库联调结论：GET /api/v1/digital-employees **不消费** external_user_id。
 * 该端点用 Bearer 凭证鉴权、租户由凭证反推；全后端只读取 If-None-Match /
 * If-Match / Last-Event-ID 三个 header。实测不带此 header 返回 200，带任意值
 * 响应 body 与 ETag 完全一致，因此这里发出去是惰性的、保留无害。
 *
 * externalUserId 的真正用途在 D2 远端执行：届时放进 POST /agents/{id}/runs:stream
 * 的 JSON body（服务端 schemas.py 定义为可选字段），而不是 header。
 */
export const EXTERNAL_USER_ID_HEADER = 'x-external-user-id'

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

export interface HttpProviderConfig {
  baseUrl: string
  apiKey: string
  externalUserId: string
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
      authorization: `Bearer ${this.config.apiKey}`,
      [EXTERNAL_USER_ID_HEADER]: this.config.externalUserId
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
