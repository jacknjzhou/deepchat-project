import { describe, expect, it } from 'vitest'
import {
  createStaffdeckBackflow,
  type BackflowEvent,
  type StaffdeckBackflowDeps
} from '../../../src/main/digital-employee/backflow'

/**
 * 对话回流。
 *
 * 本地执行的会话要上报给 StaffDeck 归档，让管理端能看到完整对话。三条硬约束：
 *
 * 1. **永不阻塞对话**：上报失败只是少一条归档，不能让用户发不出消息。
 * 2. **重试要能重发整批而不会重复**：服务端按单事件去重，客户端只管重发。
 * 3. **关闭后真的不上报**：这是隐私开关，不是性能开关。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SESSION = 'session-local-1'

type Call = { url: string; body: unknown }

type HarnessOptions = {
  connection?: { baseUrl: string; apiKey: string; externalUserId: string } | null
  enabled?: boolean
  /** events:batch 的响应码序列：第 n 次用第 n 个，用完取最后一个。 */
  statuses?: number[]
  /** 建会话的响应码；省略则一律 201 返回 `REMOTE_SESSION`。 */
  createStatuses?: number[]
  batchSize?: number
}

const REMOTE_SESSION = 'session-remote-1'

function createHarness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const createCalls: Call[] = []
  const statuses = [...(options.statuses ?? [200])]
  const createStatuses = [...(options.createStatuses ?? [201])]
  let index = 0
  let createIndex = 0

  const deps: StaffdeckBackflowDeps = {
    getConnection: () =>
      options.connection === null
        ? null
        : {
            baseUrl: 'http://staffdeck.test',
            apiKey: 'sd_live_abc',
            externalUserId: 'user-1'
          },
    isEnabled: () => options.enabled ?? true,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? 'null'))
      // 建会话与追加事件是两个端点，用同一份假 fetch 时得分开计数：
      // 混在一起会让「第几次请求失败」的断言变成猜顺序。
      if (url.endsWith('/sessions')) {
        createCalls.push({ url, body })
        const status = createStatuses[Math.min(createIndex, createStatuses.length - 1)]
        createIndex += 1
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({ id: REMOTE_SESSION }),
          text: async () => ''
        }
      }
      calls.push({ url, body })
      const status = statuses[Math.min(index, statuses.length - 1)]
      index += 1
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ accepted: 1, duplicates: 0 }),
        text: async () => ''
      }
    }) as unknown as typeof fetch,
    batchSize: options.batchSize
  }

  return { deps, calls, createCalls }
}

const message = (eventId: string, content = 'hi'): BackflowEvent => ({
  type: 'message',
  eventId,
  role: 'user',
  content
})

describe('StaffDeck backflow', () => {
  it('creates the remote session before appending events', async () => {
    // events:batch only accepts a session the server knows and the credential
    // owns. A locally executed conversation never created one, so appending
    // first would 404 every time.
    const harness = createHarness()

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(true)
    expect(harness.createCalls).toHaveLength(1)
    expect(harness.createCalls[0].url).toBe(
      `http://staffdeck.test/api/v1/agents/${EMPLOYEE}/sessions`
    )
    expect(harness.createCalls[0].body).toMatchObject({
      external_session_id: SESSION,
      external_user_id: 'user-1'
    })
    // The batch must address the session the server handed back, not the local id.
    expect(harness.calls[0].url).toContain(`/sessions/${REMOTE_SESSION}/events:batch`)
  })

  it('reuses the remote session id instead of creating one per turn', async () => {
    const harness = createHarness()
    const backflow = createStaffdeckBackflow(harness.deps)

    await backflow.flush({ employeeId: EMPLOYEE, sessionId: SESSION, events: [message('e1')] })
    await backflow.flush({ employeeId: EMPLOYEE, sessionId: SESSION, events: [message('e2')] })

    expect(harness.createCalls).toHaveLength(1)
    expect(harness.calls).toHaveLength(2)
  })

  it('rebuilds the mapping once when the cached session id is gone', async () => {
    // The server can drop the session (cleanup, or a different database). A
    // cached id then 404s forever unless we drop it and rebuild.
    const harness = createHarness({ statuses: [404, 200] })
    const backflow = createStaffdeckBackflow(harness.deps)

    const result = await backflow.flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(true)
    expect(harness.createCalls).toHaveLength(2)
  })

  it('does not loop when the rebuilt session also 404s', async () => {
    const harness = createHarness({ statuses: [404, 404, 404] })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP_404')
    // Initial attempt + one retry, then stop.
    expect(harness.calls).toHaveLength(2)
  })

  it('drops the cached mapping on reset', async () => {
    const harness = createHarness()
    const backflow = createStaffdeckBackflow(harness.deps)

    await backflow.flush({ employeeId: EMPLOYEE, sessionId: SESSION, events: [message('e1')] })
    backflow.reset()
    await backflow.flush({ employeeId: EMPLOYEE, sessionId: SESSION, events: [message('e2')] })

    expect(harness.createCalls).toHaveLength(2)
  })

  it('reports a failed session creation without attempting the batch', async () => {
    const harness = createHarness({ createStatuses: [403] })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP_403')
    expect(harness.calls).toHaveLength(0)
  })

  it('posts a batch to the session events endpoint', async () => {
    const harness = createHarness()

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1'), message('e2')]
    })

    expect(result.ok).toBe(true)
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].url).toBe(
      `http://staffdeck.test/api/v1/agents/${EMPLOYEE}/sessions/${REMOTE_SESSION}/events:batch`
    )
    expect((harness.calls[0].body as { events: unknown[] }).events).toHaveLength(2)
  })

  it('sends events in the shape the server expects', async () => {
    const harness = createHarness()

    await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1', '你好')]
    })

    const events = (harness.calls[0].body as { events: Record<string, unknown>[] }).events
    expect(events[0]).toMatchObject({
      type: 'message',
      event_id: 'e1',
      content: '你好',
      role: 'user'
    })
  })

  it('splits an oversized batch instead of sending one huge request', async () => {
    // A long conversation replays a lot at once; one request carrying thousands
    // of messages is both a slow upload and a single point of failure.
    const harness = createHarness({ batchSize: 2 })

    await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1'), message('e2'), message('e3'), message('e4'), message('e5')]
    })

    expect(harness.calls).toHaveLength(3)
    const sizes = harness.calls.map((call) => (call.body as { events: unknown[] }).events.length)
    expect(sizes).toEqual([2, 2, 1])
  })

  it('reports failure without throwing', async () => {
    // Callers are on the message-send path: a throw here would surface as a
    // failed send to the user, for a problem that only costs an archive row.
    const harness = createHarness({ statuses: [500] })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('HTTP_500')
  })

  it('stops at the first failed chunk so a retry can resend it', async () => {
    const harness = createHarness({ statuses: [200, 500, 200], batchSize: 1 })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1'), message('e2'), message('e3')]
    })

    expect(result.ok).toBe(false)
    // e1 accepted, e2 failed, e3 never attempted: sending past a failure would
    // leave a hole that the caller cannot tell from an already-delivered chunk.
    expect(harness.calls).toHaveLength(2)
  })

  it('does nothing when backflow is switched off', async () => {
    const harness = createHarness({ enabled: false })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('DISABLED')
    expect(harness.calls).toHaveLength(0)
  })

  it('does nothing without a connection', async () => {
    const harness = createHarness({ connection: null })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.reason).toBe('NOT_CONFIGURED')
    expect(harness.calls).toHaveLength(0)
  })

  it('skips the request for an empty event list', async () => {
    const harness = createHarness()

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: []
    })

    expect(result.reason).toBe('EMPTY')
    expect(harness.calls).toHaveLength(0)
  })

  it('treats an already-reported batch as success', async () => {
    // The server answers 200 with accepted=0 when everything was stored before.
    // That is the retry working, not an error.
    const harness = createHarness({ statuses: [200] })

    const result = await createStaffdeckBackflow(harness.deps).flush({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [message('e1')]
    })

    expect(result.ok).toBe(true)
  })
})
