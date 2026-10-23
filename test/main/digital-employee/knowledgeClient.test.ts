import { describe, expect, it, vi } from 'vitest'
import {
  StaffdeckKnowledgeClient,
  encodeConceptPath
} from '../../../src/main/digital-employee/knowledgeClient'
import { StaffdeckProblemError } from '../../../src/main/digital-employee/remoteClient'

const BASE = 'http://127.0.0.1:5174'

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })

const createClient = (fetchImpl: typeof fetch, apiKey = 'sd_live_test') =>
  new StaffdeckKnowledgeClient(
    { baseUrl: BASE, apiKey, externalUserId: 'deepchat-local' },
    fetchImpl
  )

const manifestBody = {
  packages: [
    {
      knowledgeBaseId: 'kb_1',
      name: 'Product Docs',
      version: '3',
      configHash: 'sha256:abc',
      bundleUrl: `${BASE}/api/v1/digital-employees/agent_1/knowledge-packages/kb_1:export-bundle`,
      conceptCount: 2,
      concepts: [
        { conceptId: 'sources/guide', type: 'Source Document', title: 'Guide', hash: 'h1', size: 10 },
        {
          conceptId: 'sources/guide/sections/sec-1',
          type: 'Source Section',
          title: 'Sec 1',
          hash: 'h2',
          size: 20
        }
      ]
    }
  ],
  configVersion: 'kv1:deadbeef',
  fetchedAt: '2026-10-23T00:00:00Z'
}

describe('encodeConceptPath', () => {
  it('keeps slashes so the :path converter still matches', () => {
    // 概念 id 形如 sources/doc/sections/sec-1；整体编码会把 / 变成 %2F，
    // FastAPI 的 :path 转换器就收不到分段了。
    expect(encodeConceptPath('sources/guide/sections/sec-1')).toBe(
      'sources/guide/sections/sec-1:download'
    )
  })

  it('encodes characters that would break the URL but not the separators', () => {
    expect(encodeConceptPath('sources/我的 文档')).toBe(
      'sources/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3:download'
    )
  })
})

describe('StaffdeckKnowledgeClient', () => {
  it('parses the manifest into typed packages', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(manifestBody))
    const client = createClient(fetchImpl as unknown as typeof fetch)

    const result = await client.fetchManifest('agent_1')

    expect(result).not.toBeNull()
    expect(result?.configVersion).toBe('kv1:deadbeef')
    expect(result?.packages[0].knowledgeBaseId).toBe('kb_1')
    expect(result?.packages[0].concepts).toHaveLength(2)
    expect(result?.packages[0].concepts[1].conceptId).toBe('sources/guide/sections/sec-1')
  })

  it('treats an empty package list as a normal answer, not an error', async () => {
    // 服务端的同步开关默认关闭，清单为空是常态；报错会让调度器疯狂重试。
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ packages: [], configVersion: 'kv1:empty', fetchedAt: 'x' })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    const result = await client.fetchManifest('agent_1')

    expect(result?.packages).toEqual([])
  })

  it('returns null on 304 so the caller keeps its cached manifest', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 304, headers: { ETag: '"etag-1"' } })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    const result = await client.fetchManifest('agent_1', '"etag-1"')

    expect(result).toBeNull()
  })

  it('sends the ETag as If-None-Match and the API key as bearer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(manifestBody))
    const client = createClient(fetchImpl as unknown as typeof fetch, 'sd_live_secret')

    await client.fetchManifest('agent_1', '"etag-1"')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/digital-employees/agent_1/knowledge-packages`)
    const headers = init.headers as Record<string, string>
    expect(headers['if-none-match']).toBe('"etag-1"')
    expect(headers.authorization).toBe('Bearer sd_live_secret')
  })

  it('reads the ETag off the manifest response for the next round', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(manifestBody, { headers: { 'content-type': 'application/json', ETag: '"v2"' } })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    const result = await client.fetchManifest('agent_1')

    expect(result?.etag).toBe('"v2"')
  })

  it('raises a typed problem error on 401 so callers can tell auth from network', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'NOT_AUTHENTICATED', detail: 'bad key', status: 401 }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } }
        )
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    await expect(client.fetchManifest('agent_1')).rejects.toBeInstanceOf(StaffdeckProblemError)
    await expect(client.fetchManifest('agent_1')).rejects.toMatchObject({
      status: 401,
      code: 'NOT_AUTHENTICATED'
    })
  })

  it('downloads a concept body as text', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('# Guide\n\nbody', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' }
        })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    const body = await client.fetchConcept('agent_1', 'kb_1', 'sources/guide')

    expect(body).toBe('# Guide\n\nbody')
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      `${BASE}/api/v1/digital-employees/agent_1/knowledge-packages/kb_1/concepts/sources/guide:download`
    )
  })

  it('returns null for a missing concept instead of aborting the whole sync', async () => {
    // 概念在清单生成之后被删掉是正常竞态：跳过它，其余照常同步。
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'CONCEPT_NOT_FOUND' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' }
        })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    await expect(client.fetchConcept('agent_1', 'kb_1', 'sources/gone')).resolves.toBeNull()
  })

  it('still raises on 404 for a package that is not synced at all', async () => {
    // 包级 404 说明整个 KB 不可见（开关被关/员工解绑），与单概念消失不同：
    // 静默吞掉会让本地留下一个永远追不上的 KB。
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'KNOWLEDGE_PACKAGE_NOT_FOUND' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' }
        })
    )
    const client = createClient(fetchImpl as unknown as typeof fetch)

    await expect(client.fetchConcept('agent_1', 'kb_gone', 'sources/x')).rejects.toMatchObject({
      status: 404,
      code: 'KNOWLEDGE_PACKAGE_NOT_FOUND'
    })
  })

  it('never leaks the api key into an error message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const client = createClient(fetchImpl as unknown as typeof fetch, 'sd_live_topsecret')

    await expect(client.fetchManifest('agent_1')).rejects.toSatisfy(
      (error: Error) => !error.message.includes('sd_live_topsecret')
    )
  })
})
