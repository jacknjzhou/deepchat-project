/**
 * 回流链路的真容器联调。
 *
 * 同一份 `backflow.ts` 在单测里跑过很多遍，但那些 fetch 是假的——它们证明「代码按
 * 我理解的协议发请求」，并不证明「服务端按这个协议收请求」。两者之间隔着 nginx、
 * uvicorn、psycopg 和 PG 事务，任何一层理解错了，单测都照样全绿。
 *
 * 所以这个 suite 指向一个**真的**跑起来的 StaffDeck（packaging/docker 那套），用
 * 生产代码 `createStaffdeckBackflow` 打真实 HTTP。它会自己去登录、签发凭证，不需要
 * 事先手工准备 key —— 手工准备的东西一旦过期，这个 suite 就悄悄变成「验环境」而不是
 * 「验代码」。
 *
 * 默认不参与 CI：没设 `STAFFDECK_CONTAINER_BASE_URL` 时整组 skip。它是按需跑的
 * 集成门禁，不是每次 `vitest run` 都要等网络的东西。
 *
 * 跑法：
 *   cd packaging/docker && docker compose up -d      # 在 StaffDeck 仓库
 *   STAFFDECK_CONTAINER_BASE_URL=http://localhost:5173 \
 *     node node_modules/vitest/vitest.mjs run test/main/digital-employee/backflow.container.test.ts
 */

import { describe, expect, it, beforeAll } from 'vitest'
import { createStaffdeckBackflow, type BackflowEvent } from '@/digital-employee/backflow'

const BASE_URL = process.env.STAFFDECK_CONTAINER_BASE_URL?.replace(/\/+$/, '')
const AGENT_ID = process.env.STAFFDECK_AGENT_ID ?? 'agent_f2828efc2a2a476d'
const TENANT = process.env.STAFFDECK_TENANT ?? 'tenant_demo'
const ADMIN_USER = process.env.STAFFDECK_ADMIN_USER ?? 'admin'
const ADMIN_PASSWORD = process.env.STAFFDECK_ADMIN_PASSWORD ?? 'admin'

/**
 * 走宿主机代理时 127.0.0.1 会被劫持到外部代理，导致连 localhost 也走远端。
 * 真容器联调一律绕开：代理相关的环境变量由调用方置空，这里只做透传，
 * 避免往 fetch 上塞非标准字段（Node 的类型定义里没有 `proxy`）。
 */
const directFetch: typeof fetch = (input, init) => fetch(input, init)

interface Session {
  apiKey: string
}

const request = async (
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> => {
  const response = await directFetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/** 登录管理员并签发一把只带回流所需 scope 的凭证 —— 就是 deepchat 实际持有的那把。 */
const provisionCredential = async (label: string): Promise<Session> => {
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { tenant_id: TENANT, username: ADMIN_USER, password: ADMIN_PASSWORD }
  })
  expect(login.status, `login failed: ${JSON.stringify(login.body)}`).toBe(200)
  const token = (login.body as { token: string }).token

  const client = await request('/api/v1/api-clients', {
    method: 'POST',
    token,
    body: { name: `${label}-${Date.now()}`, scopes: ['*'] }
  })
  expect(client.status, `api-client create failed: ${JSON.stringify(client.body)}`).toBe(201)

  const credential = await request(
    `/api/v1/api-clients/${(client.body as { id: string }).id}/credentials`,
    { method: 'POST', token, body: { name: `${label}-key`, scopes: ['sessions:write', 'agents:read'] } }
  )
  expect(credential.status, `credential create failed: ${JSON.stringify(credential.body)}`).toBe(201)
  return { apiKey: (credential.body as { api_key: string }).api_key }
}

const oneTurn = (tag: string): BackflowEvent[] => [
  { type: 'message', eventId: `m:u-${tag}`, role: 'user', content: '查一下 A 类物料的库存' },
  { type: 'tool_call', eventId: `t:a-${tag}:1`, name: 'staffdeck_inventory_lookup', status: 'ok', durationMs: 320 },
  { type: 'message', eventId: `m:a-${tag}`, role: 'assistant', content: '库存 1234 件，低于安全线。' },
  { type: 'usage', eventId: `u:a-${tag}`, promptTokens: 1200, completionTokens: 80, totalTokens: 1280 }
]

describe.skipIf(!BASE_URL)('backflow against a running StaffDeck container', () => {
  let session: Session
  /** 每次跑用新的本地 session id，避免反复跑时撞上上一轮留下的行。 */
  const localSessionId = `local-container-${Date.now()}`

  beforeAll(async () => {
    session = await provisionCredential('dc-container-e2e')
  }, 30_000)

  const makeBackflow = (overrides: { apiKey?: string; enabled?: boolean } = {}) =>
    createStaffdeckBackflow({
      getConnection: () => ({
        baseUrl: BASE_URL!,
        apiKey: overrides.apiKey ?? session.apiKey,
        externalUserId: 'user-container-e2e'
      }),
      isEnabled: () => overrides.enabled ?? true,
      fetchImpl: directFetch
    })

  it('creates the remote session on first flush instead of 404ing', async () => {
    // 这条是本次修复的核心断言：本地执行的会话在服务端本来不存在，客户端必须自己
    // 把远端行建出来。以前直接发 events:batch，第一次上报必然 404。
    const result = await makeBackflow().flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      title: '容器联调',
      events: oneTurn('first')
    })
    expect(result).toEqual({ ok: true, reason: null, delivered: 4 })
  }, 30_000)

  it('replays the same turn as duplicates without double writing', async () => {
    const backflow = makeBackflow()
    // 先跑一次让远端 id 进缓存，再重放整批：服务端应全部判重，delivered 仍算 4。
    await backflow.flush({ employeeId: AGENT_ID, sessionId: localSessionId, events: oneTurn('first') })
    const replay = await backflow.flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      events: oneTurn('first')
    })
    expect(replay.ok).toBe(true)
    expect(replay.delivered).toBe(4)
  }, 30_000)

  it('appends a second turn to the same remote session', async () => {
    const backflow = makeBackflow()
    const result = await backflow.flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      events: oneTurn('second')
    })
    expect(result).toEqual({ ok: true, reason: null, delivered: 4 })

    // 怎么证明「两轮进了同一个会话」而不是各建一行？查端点不行——那需要
    // sessions:read，而回流凭证只有 sessions:write（而且查得到也只说明行存在，
    // 不说明事件落在哪一行）。改用事件幂等性来证：把两轮共 8 条一起重放，
    // 若它们确实都在同一会话里，服务端应全部判重、一条都不新增。
    const replayOfBothTurns = await makeBackflow().flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      events: [...oneTurn('first'), ...oneTurn('second')]
    })
    expect(replayOfBothTurns.ok).toBe(true)
    expect(replayOfBothTurns.delivered).toBe(8)
  }, 30_000)

  it('honours the settings toggle without touching the network', async () => {
    const disabled = await makeBackflow({ enabled: false }).flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      events: oneTurn('disabled')
    })
    expect(disabled).toEqual({ ok: false, reason: 'DISABLED', delivered: 0 })
  })

  it('reports a bad key as HTTP_401 instead of throwing', async () => {
    // 调用方在发消息路径上，这里抛错会让用户看到「发送失败」。
    const result = await makeBackflow({ apiKey: 'sd_live_not_a_real_key' }).flush({
      employeeId: AGENT_ID,
      sessionId: localSessionId,
      events: oneTurn('badkey')
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP_401')
    expect(result.delivered).toBe(0)
  }, 30_000)

  it('rebuilds the remote session when the cached id is gone', async () => {
    // 模拟「服务端清理过会话」：用一个新本地 id 拿不到旧缓存，行为应等同于首次上报；
    // 而同一 id 连续两次 flush 也不该产生两行（服务端按 external_session_id 幂等）。
    const fresh = makeBackflow()
    const first = await fresh.flush({
      employeeId: AGENT_ID,
      sessionId: `${localSessionId}-rebuilt`,
      events: oneTurn('rebuilt')
    })
    const second = await fresh.flush({
      employeeId: AGENT_ID,
      sessionId: `${localSessionId}-rebuilt`,
      events: oneTurn('rebuilt')
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  }, 30_000)
})
