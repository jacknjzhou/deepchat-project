import { describe, expect, it } from 'vitest'
import { createDigitalEmployeeBackflowRoutes } from '../../../src/main/digital-employee/backflowRoutes'
import type { BackflowEvent, BackflowResult } from '../../../src/main/digital-employee/backflow'

/**
 * 回流 route 只做两件事：按契约收参、把结果压平成 renderer 能用的形状。
 * 真正的上报逻辑在 backflow.test.ts。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SESSION = 'session-local-1'

function harness(result: BackflowResult) {
  const seen: Array<{ employeeId: string; sessionId: string; events: readonly BackflowEvent[] }> =
    []
  const routes = createDigitalEmployeeBackflowRoutes({
    backflow: {
      async flush(input) {
        seen.push(input)
        return result
      }
    }
  })
  const handler = routes.get('digitalEmployee.backflow')!
  return { handler, seen }
}

describe('digitalEmployee.backflow route', () => {
  it('passes the parsed events through', async () => {
    const { handler, seen } = harness({ ok: true, reason: null, delivered: 1 })

    await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    expect(seen[0].employeeId).toBe(EMPLOYEE)
    expect(seen[0].sessionId).toBe(SESSION)
    expect(seen[0].events).toHaveLength(1)
  })

  it('returns the delivered count so the caller knows what to drop', async () => {
    const { handler } = harness({ ok: false, reason: 'HTTP_500', delivered: 2 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'usage', eventId: 'u1', promptTokens: 1, completionTokens: 2, totalTokens: 3 }]
    })

    expect(result).toEqual({ ok: false, reason: 'HTTP_500', delivered: 2 })
  })

  it('rejects a malformed event instead of silently dropping it', async () => {
    const { handler } = harness({ ok: true, reason: null, delivered: 0 })

    await expect(
      handler({ employeeId: EMPLOYEE, sessionId: SESSION, events: [{ type: 'nope' }] })
    ).rejects.toThrow()
  })
})
