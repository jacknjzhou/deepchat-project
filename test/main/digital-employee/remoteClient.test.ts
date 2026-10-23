import { describe, expect, it, vi } from 'vitest'
import {
  StaffdeckProblemError,
  StaffdeckRemoteClient,
  type StaffdeckRemoteClientConfig
} from '../../../src/main/digital-employee/remoteClient'

const config: StaffdeckRemoteClientConfig = {
  baseUrl: 'https://sd.example/',
  apiKey: 'sd_live_test',
  externalUserId: 'user-1'
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function problemResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' }
  })
}

/** 把若干段 SSE 文本包成 fetch 能消费的 Response。 */
function streamResponse(
  chunks: string[],
  init: { headers?: Record<string, string> } = {},
  options: { runId?: string | null } = {}
) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  const headers: Record<string, string> = { 'content-type': 'text/event-stream', ...init.headers }
  // 默认带上 X-Run-ID：服务端对 runs:stream 总是会给（runs.py:464）。
  // 显式传 runId: null 用于验证缺失分支。
  if (options.runId !== null && !headers['X-Run-ID']) {
    headers['X-Run-ID'] = options.runId ?? 'run-1'
  }
  return new Response(body, { status: 200, headers })
}

describe('StaffdeckRemoteClient.createSession', () => {
  it('sends external_user_id in the body, never as a header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: 'remote-1' }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    const result = await client.createSession({
      employeeId: 'emp-1',
      externalSessionId: 'local-1',
      title: '报销',
      metadata: { source: 'deepchat' }
    })

    expect(result).toEqual({ id: 'remote-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sd.example/api/v1/agents/emp-1/sessions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.external_session_id).toBe('local-1')
    expect(body.external_user_id).toBe('user-1')
    expect(body.metadata).toEqual({ source: 'deepchat' })
    expect(init.headers['x-external-user-id']).toBeUndefined()
    expect(init.headers.authorization).toBe('Bearer sd_live_test')
  })

  it('rejects a response without an id instead of inventing one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { title: 'x' }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(
      client.createSession({ employeeId: 'emp-1', externalSessionId: 'local-1', title: 't' })
    ).rejects.toThrow(/invalid session payload/i)
  })

  it('surfaces the problem code instead of the title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      problemResponse(409, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'EXTERNAL_SESSION_CONFLICT',
        detail: 'bound to another agent',
        request_id: 'req-1'
      })
    )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(
      client.createSession({ employeeId: 'emp-1', externalSessionId: 'local-1', title: 't' })
    ).rejects.toMatchObject({ code: 'EXTERNAL_SESSION_CONFLICT', status: 409 })
  })
})

describe('StaffdeckRemoteClient.streamRun', () => {
  it('reads X-Run-ID before consuming any frame', async () => {
    const observedRunIds: Array<string | null> = []
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse(
          [
            'id: 1\nevent: run.output.delta\ndata: {"content":"a"}\n\n',
            'id: 2\nevent: run.succeeded\ndata: {}\n\n'
          ],
          { headers: { 'X-Run-ID': 'run-9' } }
        )
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    const outcome = await client.streamRun(
      {
        employeeId: 'emp-1',
        remoteSessionId: 'remote-1',
        runKey: 'deepchat:local-1:turn-1',
        input: '你好'
      },
      () => observedRunIds.push(client.currentRunId)
    )

    expect(outcome.runId).toBe('run-9')
    expect(observedRunIds[0]).toBe('run-9')
    expect(fetchMock.mock.calls[0][0]).toBe('https://sd.example/api/v1/agents/emp-1/runs:stream')
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers['idempotency-key']).toBe('deepchat:local-1:turn-1')
    const body = JSON.parse(init.body)
    expect(body.input).toBe('你好')
    expect(body.session_id).toBe('remote-1')
    expect(body.external_user_id).toBe('user-1')
  })

  it('fails loudly when the response omits X-Run-ID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse(['id: 1\nevent: run.status\ndata: {}\n\n'], {}, { runId: null })
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(
      client.streamRun(
        { employeeId: 'emp-1', remoteSessionId: 'r', runKey: 'k', input: 'x' },
        () => undefined
      )
    ).rejects.toThrow(/X-Run-ID/i)
  })

  it('skips keepalive comments and stops on run.succeeded', async () => {
    const events: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'id: 1\nevent: job.queued\ndata: {"job_id":"run-9"}\n\n',
          ': keepalive\n\n',
          'id: 2\nevent: run.output.delta\ndata: {"content":"a"}\n\n',
          'id: 3\nevent: run.succeeded\ndata: {"job_id":"run-9"}\n\n',
          'id: 4\nevent: run.output.delta\ndata: {"content":"late"}\n\n'
        ])
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await client.streamRun(
      { employeeId: 'emp-1', remoteSessionId: 'r', runKey: 'k', input: 'x' },
      (frame) => events.push(frame.event ?? '')
    )

    expect(events).toEqual(['job.queued', 'run.output.delta', 'run.succeeded'])
  })

  it('treats run.failed and run.cancelled as terminal as well', async () => {
    for (const terminal of ['run.failed', 'run.cancelled', 'run.output.completed']) {
      const events: string[] = []
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          streamResponse([
            `id: 1\nevent: ${terminal}\ndata: {"job_id":"run-9"}\n\n`,
            'id: 2\nevent: run.output.delta\ndata: {"content":"late"}\n\n'
          ])
        )
      const client = new StaffdeckRemoteClient(config, fetchMock)
      await client.streamRun(
        { employeeId: 'emp-1', remoteSessionId: 'r', runKey: `k-${terminal}`, input: 'x' },
        (frame) => events.push(frame.event ?? '')
      )
      expect(events).toEqual([terminal])
    }
  })

  it('drops unknown event names without breaking the stream', async () => {
    const events: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'id: 1\nevent: run.future.thing\ndata: {"x":1}\n\n',
          'id: 2\nevent: run.output.delta\ndata: {"content":"a"}\n\n',
          'id: 3\nevent: run.succeeded\ndata: {}\n\n'
        ])
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await client.streamRun(
      { employeeId: 'emp-1', remoteSessionId: 'r', runKey: 'k', input: 'x' },
      (frame) => events.push(frame.event ?? '')
    )

    expect(events).toEqual(['run.output.delta', 'run.succeeded'])
  })

  it('does not swallow a transport error as a completed run', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('id: 1\nevent: run.output.delta\ndata: {"content":"a"}\n\n')
            )
            controller.error(new Error('socket hang up'))
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream', 'X-Run-ID': 'run-9' } }
      )
    )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(
      client.streamRun(
        { employeeId: 'emp-1', remoteSessionId: 'r', runKey: 'k', input: 'x' },
        () => undefined
      )
    ).rejects.toThrow(/socket hang up/)
  })
})

describe('StaffdeckRemoteClient.getResult', () => {
  it('parses the run result with defaults', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { run_id: 'run-9', reply: '好的' }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    const result = await client.getResult('run-9')

    expect(result.reply).toBe('好的')
    expect(result.citations).toEqual([])
    expect(fetchMock.mock.calls[0][0]).toBe('https://sd.example/api/v1/runs/run-9/result')
  })

  it('maps RUN_NOT_SUCCEEDED to a typed error so callers can degrade', async () => {
    // 每次调用都要新建 Response：body 是一次性的，复用会读到已消费的流。
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          problemResponse(409, { code: 'RUN_NOT_SUCCEEDED', title: 'Conflict', status: 409 })
        )
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(client.getResult('run-9')).rejects.toBeInstanceOf(StaffdeckProblemError)
    await expect(client.getResult('run-9')).rejects.toMatchObject({
      code: 'RUN_NOT_SUCCEEDED'
    })
  })
})

describe('StaffdeckRemoteClient.cancelRun', () => {
  it('posts to the cancel endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'run-9' }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await client.cancelRun('run-9')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sd.example/api/v1/runs/run-9:cancel')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer sd_live_test')
  })

  it('ignores a 404 because the run is already gone', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(problemResponse(404, { code: 'RUN_NOT_FOUND', status: 404 }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(client.cancelRun('run-9')).resolves.toBeUndefined()
  })
})

describe('StaffdeckRemoteClient.resumeRun', () => {
  it('reconnects through GET /runs/{id}/events with the last sequence', async () => {
    const events: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'id: 4\nevent: run.output.delta\ndata: {"content":"b"}\n\n',
          'id: 5\nevent: run.succeeded\ndata: {}\n\n'
        ])
      )
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await client.resumeRun({ runId: 'run-9', lastEventId: '3' }, (frame) =>
      events.push(frame.event ?? '')
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sd.example/api/v1/runs/run-9/events')
    expect(init.method).toBe('GET')
    expect(init.headers['last-event-id']).toBe('3')
    expect(events).toEqual(['run.output.delta', 'run.succeeded'])
  })
})

describe('StaffdeckRemoteClient error surface', () => {
  it('never leaks the api key into an error message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(problemResponse(403, { code: 'INSUFFICIENT_SCOPE', status: 403 }))
    const client = new StaffdeckRemoteClient(config, fetchMock)

    await expect(
      client.createSession({ employeeId: 'emp-1', externalSessionId: 'local-1', title: 't' })
    ).rejects.toSatisfy(
      (error: unknown) =>
        !JSON.stringify({ ...(error as object), message: String(error) }).includes('sd_live_test')
    )
  })
})
