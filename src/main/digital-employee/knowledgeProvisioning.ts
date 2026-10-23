import { createHash } from 'node:crypto'
import type { BuiltinKnowledgeConfig } from '@shared/types/knowledge'
import type { LLM_PROVIDER, MODEL_META } from '@shared/types/provider'
import { ModelType } from '@shared/model'

/**
 * 为数字员工准备一个本地内置知识库。
 *
 * 为什么必须自动建库：`addFile` 需要一个 `knowledgeBaseId`，而内置知识库的
 * 配置（含嵌入模型与向量维度）在 deepchat 里没有默认值——`BuiltinKnowledgeConfig`
 * 里 `embedding` 与 `dimensions` 都是必填。不自动准备，知识同步就没有落点。
 *
 * 嵌入模型的选择是 D3 唯一无法自决的地方：deepchat 不设默认模型，所以这里
 * 取「第一个启用的 provider 下第一个 embedding 模型」。一个都没有时不建空壳，
 * 明确返回 `NO_EMBEDDING_MODEL`，由上层标 stale 并提示用户去设置里配。
 */

/** 本地知识库 id 前缀；与用户手动建的库区分开。 */
const LOCAL_ID_PREFIX = 'de-'

/** 目录名长度上限：向量库路径是 `{userData}/app_db/KnowledgeBase/{id}`， */
/** Windows 上总路径有 260 字符限制，id 留 64 位足够且安全。 */
const MAX_ID_LENGTH = 64

export interface ProvisioningDeps {
  /** 已启用或未启用的全部 provider；本模块自己过滤。 */
  listProviders: () => LLM_PROVIDER[]
  getDimensions: (
    providerId: string,
    modelId: string
  ) => Promise<{ data: { dimensions: number; normalized: boolean } }>
  getKnowledgeConfigs: () => BuiltinKnowledgeConfig[]
  setKnowledgeConfigs: (configs: BuiltinKnowledgeConfig[]) => void
  /** 让 KnowledgeService 重建实例；不调用则新配置不会生效。 */
  applyConfigChange: () => Promise<void>
  now?: () => string
}

export type ProvisioningResult =
  | { ok: true; knowledgeBaseId: string; created: boolean }
  | { ok: false; reason: 'NO_EMBEDDING_MODEL' }

/**
 * 由员工 id 派生本地知识库 id。
 *
 * 必须稳定：重建会换掉向量库目录，旧目录变孤儿，且要重跑一次全量索引。
 * 只保留 `[a-z0-9_-]`：这个 id 会被 `path.join` 成目录名，冒号在 Windows
 * 非法，斜杠会跨目录，点会与 `.wal` 之类的后缀混淆。
 */
export function deriveLocalKnowledgeBaseId(employeeId: string): string {
  const slug = employeeId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const raw = `${LOCAL_ID_PREFIX}${slug || 'employee'}`
  if (raw.length <= MAX_ID_LENGTH) return raw

  // 截断会让前缀相同的两个员工撞成同一个 id（覆盖彼此的向量库），
  // 所以补 8 位原文 hash 保证唯一。
  const suffix = createHash('sha256').update(employeeId).digest('hex').slice(0, 8)
  return `${raw.slice(0, MAX_ID_LENGTH - suffix.length - 1)}-${suffix}`
}

interface EmbeddingChoice {
  providerId: string
  modelId: string
}

/**
 * 取第一个启用的 provider 下第一个 embedding 模型。
 *
 * 顺序固定（provider 列表顺序 → 模型列表顺序）而不是随机挑：
 * 同一台机器反复建库要选到同一个模型，否则向量空间会飘。
 */
function pickEmbeddingModel(providers: LLM_PROVIDER[]): EmbeddingChoice | null {
  for (const provider of providers) {
    if (!provider.enable) continue
    const models: MODEL_META[] = [...(provider.models ?? []), ...(provider.customModels ?? [])]
    for (const model of models) {
      if (model.type !== ModelType.Embedding) continue
      // 显式禁用的模型不能选：用户关掉它通常是有原因的（费用、限流）。
      if (model.enabled === false) continue
      return { providerId: provider.id, modelId: model.id }
    }
  }
  return null
}

export async function provisionLocalKnowledgeBase(
  input: { employeeId: string; employeeName: string },
  deps: ProvisioningDeps
): Promise<ProvisioningResult> {
  const knowledgeBaseId = deriveLocalKnowledgeBaseId(input.employeeId)
  const existing = deps.getKnowledgeConfigs()
  const current = existing.find((config) => config.id === knowledgeBaseId)

  // 已存在就原样复用：换了嵌入模型等于换了向量空间，已有索引全部作废；
  // 换 id 则更糟——旧目录成孤儿，还要全量重索引。
  if (current) {
    return { ok: true, knowledgeBaseId, created: false }
  }

  const embedding = pickEmbeddingModel(deps.listProviders())
  if (!embedding) {
    return { ok: false, reason: 'NO_EMBEDDING_MODEL' }
  }

  // 探测失败不阻断建库：写 0 让后续索引阶段显式报错，
  // 比编一个看似合理的维度（比如 1536）更安全——那会让检索永远返回空而不报错。
  let dimensions = 0
  let normalized = true
  try {
    const probed = await deps.getDimensions(embedding.providerId, embedding.modelId)
    dimensions = probed.data.dimensions
    normalized = probed.data.normalized
  } catch {
    dimensions = 0
  }

  const config: BuiltinKnowledgeConfig = {
    id: knowledgeBaseId,
    description: `synced from StaffDeck for ${input.employeeName}`,
    embedding,
    dimensions,
    normalized,
    fragmentsNumber: 5,
    enabled: true,
    managedBy: 'digital-employee'
  }

  deps.setKnowledgeConfigs([...existing, config])
  // 不调这个，KnowledgeService 的配置快照仍是旧的，addFile 会读不到新库。
  await deps.applyConfigChange()
  return { ok: true, knowledgeBaseId, created: true }
}
