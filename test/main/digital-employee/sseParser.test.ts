import { describe, expect, it } from 'vitest'
import { createSseParser } from '../../../src/main/digital-employee/sseParser'

describe('createSseParser', () => {
  it('splits a complete frame into id/event/data', () => {
    const parser = createSseParser()
    const frames = parser.push('id: 1\nevent: run.output.delta\ndata: {"content":"a"}\n\n')
    expect(frames).toEqual([{ id: '1', event: 'run.output.delta', data: '{"content":"a"}' }])
  })

  it('skips keepalive comment lines', () => {
    // jobs.py:574-576 yields ": keepalive\n\n" every 100 idle ticks.
    const parser = createSseParser()
    expect(parser.push(': keepalive\n\n')).toEqual([])
  })

  it('buffers a frame split across three chunks', () => {
    const parser = createSseParser()
    expect(parser.push('id: 2\nevent: run.output.')).toEqual([])
    expect(parser.push('delta\ndata: {"content":')).toEqual([])
    expect(parser.push('"b"}\n\n')).toEqual([
      { id: '2', event: 'run.output.delta', data: '{"content":"b"}' }
    ])
  })

  it('handles CRLF separators from proxies', () => {
    const parser = createSseParser()
    const frames = parser.push('id: 3\r\nevent: run.status\r\ndata: {}\r\n\r\n')
    expect(frames[0]).toMatchObject({ id: '3', event: 'run.status', data: '{}' })
  })

  it('drops an unterminated frame on flush instead of emitting a partial', () => {
    const parser = createSseParser()
    parser.push('id: 4\nevent: run.output.delta\ndata: {"content":')
    expect(parser.flush()).toEqual([])
  })

  it('joins multiple data lines of one frame with newlines', () => {
    const parser = createSseParser()
    const frames = parser.push('event: run.status\ndata: line1\ndata: line2\n\n')
    expect(frames[0].data).toBe('line1\nline2')
  })

  it('emits several frames delivered in a single chunk', () => {
    const parser = createSseParser()
    const frames = parser.push(
      'id: 1\nevent: job.queued\ndata: {}\n\nid: 2\nevent: run.started\ndata: {}\n\n'
    )
    expect(frames.map((frame) => frame.event)).toEqual(['job.queued', 'run.started'])
    expect(frames.map((frame) => frame.id)).toEqual(['1', '2'])
  })

  it('keeps a frame without an id or event field', () => {
    const parser = createSseParser()
    const frames = parser.push('data: {"job_id":"j"}\n\n')
    expect(frames).toEqual([{ data: '{"job_id":"j"}' }])
  })

  it('ignores a frame that carries only comments', () => {
    const parser = createSseParser()
    expect(parser.push(': keepalive\n: keepalive\n\n')).toEqual([])
  })

  it('does not leak state between parser instances', () => {
    const a = createSseParser()
    const b = createSseParser()
    a.push('id: 1\nevent: run.status\ndata: {"x":')
    expect(b.push('id: 9\nevent: run.status\ndata: {}\n\n')).toEqual([
      { id: '9', event: 'run.status', data: '{}' }
    ])
  })

  it('trims only a single leading space after the field colon', () => {
    // The SSE spec strips exactly one space; any further padding is data.
    const parser = createSseParser()
    const frames = parser.push('event:  run.status\ndata:  {"a":1}\n\n')
    expect(frames[0].event).toBe(' run.status')
    expect(frames[0].data).toBe(' {"a":1}')
  })
})
