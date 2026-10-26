import { describe, expect, it, vi } from 'vitest'
import {
  deriveLocalKnowledgeBaseId,
  provisionLocalKnowledgeBase,
  type ProvisioningDeps
} from '../../../src/main/digital-employee/knowledgeProvisioning'
import type { BuiltinKnowledgeConfig } from '../../../src/shared/types/knowledge'
import type { LLM_PROVIDER } from '../../../src/shared/types/provider'
import { ModelType } from '../../../src/shared/model'

const embeddingProvider = (overrides: Partial<LLM_PROVIDER> = {}): LLM_PROVIDER => ({
  id: 'prov-openai',
  name: 'OpenAI',
  apiType: 'openai-completions',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  enable: true,
  models: [
    {
      id: 'text-embedding-3-small',
      name: 'Embedding Small',
      group: 'embedding',
      providerId: 'prov-openai',
      type: ModelType.Embedding
    },
    { id: 'gpt-4o', name: 'GPT-4o', group: 'chat', providerId: 'prov-openai', type: ModelType.Chat }
  ],
  ...overrides
})

const createDeps = (overrides: Partial<ProvisioningDeps> = {}) => {
  const stored: { configs: BuiltinKnowledgeConfig[] } = { configs: [] }
  const deps: ProvisioningDeps = {
    listProviders: () => [embeddingProvider()],
    getDimensions: vi.fn(async () => ({ data: { dimensions: 1536, normalized: true } })),
    getKnowledgeConfigs: () => stored.configs,
    setKnowledgeConfigs: (configs) => {
      stored.configs = configs
    },
    applyConfigChange: vi.fn(async () => {}),
    now: () => '2026-10-23T00:00:00.000Z',
    ...overrides
  }
  return { deps, stored }
}

describe('deriveLocalKnowledgeBaseId', () => {
  it('produces a stable id for the same employee', () => {
    expect(deriveLocalKnowledgeBaseId('emp-1')).toBe(deriveLocalKnowledgeBaseId('emp-1'))
  })

  it('keeps only path-safe characters', () => {
    // id 会被当作向量库目录名（knowledge/index.ts:304 的 path.join），
    // 冒号、斜杠、点在任何平台上都可能出问题。
    const id = deriveLocalKnowledgeBaseId('emp/1:weird name')
    expect(id).toMatch(/^de-[a-z0-9_-]+$/)
  })

  it('stays short enough to be a directory name', () => {
    const id = deriveLocalKnowledgeBaseId('x'.repeat(400))
    expect(id.length).toBeLessThanOrEqual(64)
  })

  it('does not collide for ids that differ only after truncation', () => {
    const a = deriveLocalKnowledgeBaseId(`${'a'.repeat(200)}-alpha`)
    const b = deriveLocalKnowledgeBaseId(`${'a'.repeat(200)}-beta`)
    expect(a).not.toBe(b)
  })
})

describe('provisionLocalKnowledgeBase', () => {
  it('creates a config bound to the first enabled embedding model', async () => {
    const { deps, stored } = createDeps()

    const result = await provisionLocalKnowledgeBase(
      { employeeId: 'emp-1', employeeName: '小美' },
      deps
    )

    expect(result.ok).toBe(true)
    expect(stored.configs).toHaveLength(1)
    expect(stored.configs[0]).toMatchObject({
      id: deriveLocalKnowledgeBaseId('emp-1'),
      embedding: { providerId: 'prov-openai', modelId: 'text-embedding-3-small' },
      dimensions: 1536,
      normalized: true,
      enabled: true
    })
  })

  it('marks the knowledge base as managed so the settings page can protect it', async () => {
    const { deps, stored } = createDeps()

    await provisionLocalKnowledgeBase({ employeeId: 'emp-1', employeeName: '小美' }, deps)

    expect(stored.configs[0].managedBy).toBe('digital-employee')
  })

  it('reuses an existing config instead of recreating it', async () => {
    // 重建会换 id，旧向量库变成孤儿目录；也会触发一次全量重索引。
    const existing: BuiltinKnowledgeConfig = {
      id: deriveLocalKnowledgeBaseId('emp-1'),
      description: 'existing',
      embedding: { providerId: 'prov-openai', modelId: 'text-embedding-3-small' },
      dimensions: 1536,
      normalized: true,
      fragmentsNumber: 5,
      enabled: true,
      managedBy: 'digital-employee'
    }
    const { deps, stored } = createDeps({ getKnowledgeConfigs: () => [existing] })

    const result = await provisionLocalKnowledgeBase(
      { employeeId: 'emp-1', employeeName: '新名字' },
      deps
    )

    expect(result).toMatchObject({ ok: true, knowledgeBaseId: existing.id, created: false })
    // 复用分支不该写回配置：写回会把用户/历史留下的字段覆盖成默认值。
    expect(stored.configs).toHaveLength(0)
    expect(deps.getDimensions).not.toHaveBeenCalled()
  })

  it('fails clearly when no embedding model is enabled', async () => {
    // 没有嵌入模型就建不了向量库。这里必须明确失败而不是建一个空壳——
    // 空壳会让上层以为同步成功了。
    const { deps, stored } = createDeps({
      listProviders: () => [
        embeddingProvider({
          models: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              group: 'chat',
              providerId: 'prov-openai',
              type: ModelType.Chat
            }
          ]
        })
      ]
    })

    const result = await provisionLocalKnowledgeBase(
      { employeeId: 'emp-1', employeeName: '小美' },
      deps
    )

    expect(result).toMatchObject({ ok: false, reason: 'NO_EMBEDDING_MODEL' })
    expect(stored.configs).toHaveLength(0)
  })

  it('ignores disabled providers', async () => {
    const { deps, stored } = createDeps({
      listProviders: () => [embeddingProvider({ enable: false })]
    })

    const result = await provisionLocalKnowledgeBase(
      { employeeId: 'emp-1', employeeName: '小美' },
      deps
    )

    expect(result).toMatchObject({ ok: false, reason: 'NO_EMBEDDING_MODEL' })
    expect(stored.configs).toHaveLength(0)
  })

  it('falls back to index 0 when dimension probing fails', async () => {
    const { deps, stored } = createDeps({
      getDimensions: vi.fn(async () => {
        throw new Error('probe failed')
      })
    })

    const result = await provisionLocalKnowledgeBase(
      { employeeId: 'emp-1', employeeName: '小美' },
      deps
    )

    expect(result.ok).toBe(true)
    // 探测失败不能凭空编一个维度：用 0 让后续索引失败暴露出来，
    // 而不是把错维度写进去、让检索永远返回空。
    expect(stored.configs[0].dimensions).toBe(0)
  })

  it('applies the config change so the service rebuilds its instance', async () => {
    const { deps } = createDeps()

    await provisionLocalKnowledgeBase({ employeeId: 'emp-1', employeeName: '小美' }, deps)

    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1)
  })

  it('keeps other knowledge bases untouched', async () => {
    const other: BuiltinKnowledgeConfig = {
      id: 'user-kb',
      description: '手动建的',
      embedding: { providerId: 'prov-openai', modelId: 'text-embedding-3-small' },
      dimensions: 1536,
      normalized: true,
      fragmentsNumber: 5,
      enabled: true
    }
    const { deps, stored } = createDeps({ getKnowledgeConfigs: () => [other] })

    await provisionLocalKnowledgeBase({ employeeId: 'emp-1', employeeName: '小美' }, deps)

    expect(stored.configs.map((config) => config.id)).toEqual([
      'user-kb',
      deriveLocalKnowledgeBaseId('emp-1')
    ])
  })
})
