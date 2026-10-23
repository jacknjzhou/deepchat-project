import { describe, expect, it } from 'vitest'
import {
  STAFFDECK_RUN_EVENT_NAMES,
  staffdeckAwaitingInputSchema,
  staffdeckRunEventSchema,
  staffdeckRunResultSchema
} from '../../../src/shared/contracts/routes/digitalEmployeeRemote.routes'

describe('staffdeckRunEventSchema', () => {
  it('accepts a delta event with numeric id and content', () => {
    const parsed = staffdeckRunEventSchema.parse({
      id: 12,
      event: 'run.output.delta',
      data: { job_id: 'apijob_1', content: '你', turn_id: 'msg_1' }
    })
    expect(parsed.data.content).toBe('你')
  })

  it('accepts a completed event that carries no reply text', () => {
    const parsed = staffdeckRunEventSchema.parse({
      id: 20,
      event: 'run.output.completed',
      data: { job_id: 'apijob_1', execution_engine: 'harness_v2' }
    })
    expect(parsed.data.content).toBeUndefined()
  })

  it('accepts the completed event carrying citations', () => {
    // runs.py:357-381 attaches citations onto the completed payload when the
    // assistant message already stored knowledge citations.
    const parsed = staffdeckRunEventSchema.parse({
      id: 21,
      event: 'run.output.completed',
      data: { job_id: 'apijob_1', citations: [{ title: '报销制度', score: 0.9 }] }
    })
    expect(parsed.data.citations).toHaveLength(1)
  })

  it('accepts every event name the backend can actually emit', () => {
    // The SSE stream mixes trace events (runs.py _TRACE_EVENT_MAP) with
    // job-lifecycle events (jobs.py create_job / run_job / terminal emit).
    const emittedByBackend = [...STAFFDECK_RUN_EVENT_NAMES]
    expect(emittedByBackend).toEqual(
      expect.arrayContaining([
        'job.queued',
        'job.cancel_requested',
        'run.started',
        'run.executing',
        'run.status',
        'run.output.delta',
        'run.output.completed',
        'run.succeeded',
        'run.failed',
        'run.cancelled'
      ])
    )
  })

  it('parses the job lifecycle events that precede the first delta', () => {
    expect(
      staffdeckRunEventSchema.parse({
        id: 1,
        event: 'job.queued',
        data: { job_id: 'apijob_1', kind: 'run' }
      }).event
    ).toBe('job.queued')

    expect(
      staffdeckRunEventSchema.parse({
        id: 2,
        event: 'run.executing',
        data: { job_id: 'apijob_1', session_id: 's1', engine: 'harness_v2' }
      }).event
    ).toBe('run.executing')

    expect(
      staffdeckRunEventSchema.parse({ id: 3, event: 'run.succeeded', data: { job_id: 'apijob_1' } })
        .event
    ).toBe('run.succeeded')
  })

  it('rejects unknown event names so the matrix stays explicit', () => {
    expect(() =>
      staffdeckRunEventSchema.parse({ id: 1, event: 'run.whatever', data: {} })
    ).toThrow()
  })

  it('rejects a negative or fractional sequence id', () => {
    expect(() => staffdeckRunEventSchema.parse({ id: -1, event: 'run.status', data: {} })).toThrow()
    expect(() =>
      staffdeckRunEventSchema.parse({ id: 1.5, event: 'run.status', data: {} })
    ).toThrow()
  })
})

describe('staffdeckRunResultSchema', () => {
  it('parses awaiting_input with only a task id', () => {
    const parsed = staffdeckRunResultSchema.parse({
      run_id: 'r1',
      reply: '需要补充',
      awaiting_input: { task_id: 't1' }
    })
    expect(parsed.awaiting_input?.task_id).toBe('t1')
    expect(parsed.awaiting_input?.expected_fields).toEqual([])
  })

  it('parses a conversation-style awaiting_input', () => {
    const parsed = staffdeckAwaitingInputSchema.parse({
      task_id: 't1',
      kind: 'conversation',
      expected_fields: ['金额', '事由'],
      question_summary: '请提供金额和事由',
      requirements: [{ name: '金额' }]
    })
    expect(parsed.kind).toBe('conversation')
    expect(parsed.expected_fields).toHaveLength(2)
  })

  it('accepts a null question_summary', () => {
    // agent_loop.py:1000-1006 emits None when the server has no summary.
    const parsed = staffdeckAwaitingInputSchema.parse({
      task_id: 't1',
      question_summary: null
    })
    expect(parsed.question_summary).toBeNull()
  })

  it('keeps unknown fields out while tolerating server growth', () => {
    const parsed = staffdeckRunResultSchema.parse({
      run_id: 'r1',
      reply: 'ok',
      future_field: 'x'
    })
    expect((parsed as Record<string, unknown>).future_field).toBeUndefined()
  })

  it('defaults the collections that a text-only run omits', () => {
    const parsed = staffdeckRunResultSchema.parse({ run_id: 'r1', reply: 'ok' })
    expect(parsed.citations).toEqual([])
    expect(parsed.tool_calls).toEqual([])
    expect(parsed.task_results).toEqual([])
    expect(parsed.artifacts).toEqual([])
    expect(parsed.awaiting_input).toBeUndefined()
  })
})
