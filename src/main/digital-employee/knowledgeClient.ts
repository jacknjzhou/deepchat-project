import { StaffdeckProblemError } from './remoteClient'

/**
 * StaffDeck 知识同步的 HTTP 面。
 *
 * 端点与鉴权事实（对照 StaffDeck `backend/app/public_api/knowledge_sync.py`）：
 * - 清单：`GET /api/v1/digital-employees/{agent_id}/knowledge-packages`（`knowledge_sync.py:79`）
 * - 单概念：`GET .../knowledge-packages/{kb_id}/concepts/{concept_path}:download`（`:130`）
 *
 * 两点与 spec 原文不符，按实测实现：
 * 1. **没有 `:export-manifest`**。清单就是 `knowledge-packages`，它本身就带 per-concept hash，
 *    不需要单独的 manifest 端点。
 * 2. package 里的 `bundleUrl` 由服务端 `normalized_tool_base_url` 拼出（默认
 *    `http://localhost:5173`），与客户端配置的 baseUrl 无关，**不能直接拿来下载**。
 *    本客户端因此完全忽略它，一律用自己配置的 baseUrl 拼端点。
 */

const REQUEST_TIMEOUT_MS = 10_000

/** 客户端三要素，与 remoteClient 同一套凭证体系；externalUserId 只进 body。 */
export interface KnowledgeClientConfig {
  baseUrl: string
  apiKey: string
  externalUserId: string
}

/** 清单里单概念的指纹：hash 是增量同步的判据，size 供下载预算估算。 */
export interface ConceptEntry {
  conceptId: string
  type: string
  title: string
  hash: string
  size: number
}

/** 单个知识包：概念列表与 hash 用于本地判断「哪些概念需要重新下载」。 */
export interface KnowledgePackage {
  knowledgeBaseId: string
  name: string
  version: string
  configHash: string
  concepts: ConceptEntry[]
  conceptCount: number
}

export interface KnowledgeManifest {
  packages: KnowledgePackage[]
  configVersion: string
  /** 清单响应的 ETag；下一轮作为 If-None-Match 回传。 */
  etag: string | null
}

/**
 * 目录端点的单条展示信息：`/api/enterprise/knowledge-bases` 能力向 `/api/v1`
 * 的封装（2026-10-28 确认方向，端点尚未上线）。清单自带的 name/version 之外，
 * 这里补齐描述与统计，供详情页渲染。
 */
export interface KnowledgeBaseInfo {
  knowledgeBaseId: string
  name: string
  description: string
  version: string
  documentCount: number
  chunkCount: number
}

/** 概念正文里的 markdown 链接（服务端已滤掉 citations 区重复）。 */
export interface ConceptLink {
  label: string
  target: string
}

/** 概念元数据：不含正文，正文走 `:download` 按需拉。 */
export interface ConceptMetadata {
  conceptId: string
  type: string
  title: string
  description: string
  links: ConceptLink[]
}

/** 概念元数据的包级结果；version 供缓存与图谱版本标注使用。 */
export interface ConceptMetadataResult {
  knowledgeBaseId: string
  version: string
  conceptCount: number
  concepts: ConceptMetadata[]
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

const readNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * 概念 id 里带 `/`（`sources/<doc>/sections/sec-1`），必须**逐段编码再拼回**：
 * 整体 `encodeURIComponent` 会把 `/` 变成 `%2F`，FastAPI 的 `:path` 转换器
 * 就收不到分段，服务端会当成一个不存在的单段概念。
 */
export function encodeConceptPath(conceptId: string): string {
  return conceptId.split('/').map(encodeURIComponent).join('/') + ':download'
}

/**
 * StaffDeck 知识同步端点的 HTTP 客户端。
 *
 * 只负责取数与形状归一（宽松解析、逐字段兜底），增量判定与落库在
 * `knowledgeSyncScheduler` / `knowledgeProvisioning` 侧完成。
 */
export class StaffdeckKnowledgeClient {
  constructor(
    private readonly config: KnowledgeClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private get base(): string {
    return normalizeBaseUrl(this.config.baseUrl)
  }

  private authHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.config.apiKey}`
    }
  }

  private async throwForResponse(response: Response): Promise<never> {
    let code = `HTTP_${response.status}`
    let detail = ''
    try {
      const body: unknown = await response.json()
      if (isRecord(body)) {
        if (typeof body.code === 'string' && body.code) code = body.code
        if (typeof body.detail === 'string') detail = body.detail
      }
    } catch {
      // problem+json 之外的响应体不可解析时保留 HTTP_<status>。
    }
    throw new StaffdeckProblemError(response.status, code, detail)
  }

  /**
   * 取知识包清单。命中 304 时返回 null 表示「没变，用你手上的缓存」——
   * 这里刻意不返回空清单：那会被上层误读成「服务端把知识都删了」。
   */
  async fetchManifest(employeeId: string, etag?: string | null): Promise<KnowledgeManifest | null> {
    const url = `${this.base}/api/v1/digital-employees/${encodeURIComponent(employeeId)}/knowledge-packages`
    const headers: Record<string, string> = { ...this.authHeaders() }
    if (etag) headers['if-none-match'] = etag

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (response.status === 304) return null
    if (!response.ok) await this.throwForResponse(response)

    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      throw new Error('[digitalEmployee] invalid knowledge manifest payload from StaffDeck')
    }

    const rawPackages = Array.isArray(body.packages) ? body.packages : []
    const packages: KnowledgePackage[] = rawPackages
      .filter(isRecord)
      .map((entry) => {
        const rawConcepts = Array.isArray(entry.concepts) ? entry.concepts : []
        const concepts: ConceptEntry[] = rawConcepts.filter(isRecord).map((concept) => ({
          conceptId: readString(concept.conceptId),
          type: readString(concept.type),
          title: readString(concept.title),
          hash: readString(concept.hash),
          size: readNumber(concept.size)
        }))
        return {
          knowledgeBaseId: readString(entry.knowledgeBaseId),
          name: readString(entry.name),
          version: readString(entry.version),
          configHash: readString(entry.configHash),
          concepts,
          conceptCount: readNumber(entry.conceptCount) || concepts.length
        }
      })
      // 没有 id 的包无法落库也无法对比 hash，直接丢弃而不是留个空壳。
      .filter((entry) => entry.knowledgeBaseId !== '')

    return {
      packages,
      configVersion: readString(body.configVersion),
      etag: response.headers.get('ETag')
    }
  }

  /**
   * 拉单个概念的 markdown 正文。
   *
   * 单概念 404 返回 null（概念在清单生成后被删，属正常竞态，跳过它继续同步）；
   * 但包级 404 必须抛错——那说明整个 KB 已经不可见，静默跳过会让本地
   * 留下一个永远追不上的知识库。
   */
  async fetchConcept(
    employeeId: string,
    knowledgeBaseId: string,
    conceptId: string
  ): Promise<string | null> {
    const url =
      `${this.base}/api/v1/digital-employees/${encodeURIComponent(employeeId)}` +
      `/knowledge-packages/${encodeURIComponent(knowledgeBaseId)}` +
      `/concepts/${encodeConceptPath(conceptId)}`

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { ...this.authHeaders(), accept: 'text/markdown' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (response.status === 404) {
      let code = ''
      try {
        const body: unknown = await response.json()
        if (isRecord(body) && typeof body.code === 'string') code = body.code
      } catch {
        // 非 problem+json 的 404 按「概念不存在」处理。
      }
      if (code === 'CONCEPT_NOT_FOUND' || code === '') return null
      throw new StaffdeckProblemError(404, code)
    }

    if (!response.ok) await this.throwForResponse(response)
    return await response.text()
  }

  /**
   * 取员工关联的知识库目录（描述、统计等展示信息）。
   *
   * 与清单不同，这是**纯展示数据**，不参与同步判定：
   * - 404 一律返回空目录——端点未上线或员工不可见时，UI 退回用清单自带的
   *   name 渲染。绝不能因它 404 把已同步的知识标 stale，那会让目录端点的
   *   部署节奏绑架同步可用性。
   * - 字段同时兼容 camelCase 与管理端的 snake_case：封装层的最终形状未定，
   *   两种命名各自有先例（/api/v1 全 camelCase，管理端全 snake_case）。
   */
  async fetchKnowledgeBases(employeeId: string): Promise<KnowledgeBaseInfo[]> {
    const url =
      `${this.base}/api/v1/digital-employees/` + `${encodeURIComponent(employeeId)}/knowledge-bases`
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { ...this.authHeaders() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (response.status === 404) return []
    if (!response.ok) await this.throwForResponse(response)

    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      throw new Error('[digitalEmployee] invalid knowledge catalog payload from StaffDeck')
    }

    const rawItems = Array.isArray(body.knowledgeBases) ? body.knowledgeBases : []
    return (
      rawItems
        .filter(isRecord)
        .map((entry) => ({
          knowledgeBaseId: readString(entry.knowledgeBaseId) || readString(entry.id),
          name: readString(entry.name),
          description: readString(entry.description),
          version: readString(entry.version),
          documentCount: readNumber(entry.documentCount ?? entry.document_count),
          chunkCount: readNumber(entry.chunkCount ?? entry.chunk_count)
        }))
        // 没有 id 的条目无法与包对账，丢弃而不是留个孤儿卡片。
        .filter((entry) => entry.knowledgeBaseId !== '')
    )
  }

  /**
   * 取某个知识包的概念元数据（含正文链接），供本地建知识图谱。
   *
   * 与 fetchKnowledgeBases 同款降级语义：**纯展示数据，不参与同步判定**——
   * 404（端点未上线 / 包被 opt-out / 员工不可见）返回 null，由上层显示
   * 「图谱暂不可用」，绝不能把展示端点的缺席放大成同步故障。
   */
  async fetchConceptMetadata(
    employeeId: string,
    knowledgeBaseId: string
  ): Promise<ConceptMetadataResult | null> {
    const url =
      `${this.base}/api/v1/digital-employees/${encodeURIComponent(employeeId)}` +
      `/knowledge-packages/${encodeURIComponent(knowledgeBaseId)}/concepts`
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { ...this.authHeaders() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (response.status === 404) return null
    if (!response.ok) await this.throwForResponse(response)

    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      throw new Error('[digitalEmployee] invalid concept metadata payload from StaffDeck')
    }

    const rawConcepts = Array.isArray(body.concepts) ? body.concepts : []
    const concepts: ConceptMetadata[] = rawConcepts
      .filter(isRecord)
      .map((entry) => ({
        conceptId: readString(entry.conceptId),
        type: readString(entry.type),
        title: readString(entry.title),
        description: readString(entry.description),
        links: (Array.isArray(entry.links) ? entry.links : [])
          .filter(isRecord)
          .map((link) => ({ label: readString(link.label), target: readString(link.target) }))
          // 没有 target 的链接不构成边，解析层也救不了它，直接丢。
          .filter((link) => link.target !== '')
      }))
      // 没有 id 的概念既无法建图也无法定位正文，丢弃。
      .filter((entry) => entry.conceptId !== '')

    return {
      knowledgeBaseId: readString(body.knowledgeBaseId) || knowledgeBaseId,
      version: readString(body.version),
      conceptCount: readNumber(body.conceptCount) || concepts.length,
      concepts
    }
  }
}
