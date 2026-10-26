import { describe, expect, it } from 'vitest'
import { backflowEventId, collectBackflowEvents } from '@/features/chat-page/model/backflowEvents'
import type { ChatMessageRecord } from '@shared/types/agent-interface'

/**
 * 回流事件采集。
 *
 * 这一层唯一的不可逆决定是**事件 id**：它就是服务端的去重粒度。id 一旦带上
 * 时间戳或序号，同一轮重报就会被当成新消息，归档里出现两份同样的对话。
 * 所以下面一半的用例都在钉 id 的稳定性。
 */

const SESSION = 'session-1'

function userMessage(
  orderSeq: number,
  text: string,
  overrides: Partial<ChatMessageRecord> = {}
): ChatMessageRecord {
  return {
    id: `msg-user-${orderSeq}`,
    sessionId: SESSION,
    orderSeq,
    role: 'user',
    content: JSON.stringify({
      text,
      files: [],
      links: [],
      search: false,
      think: false
    }),
    status: 'sent',
    isContextEdge: 0,
    metadata: '{}',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function assistantMessage(
  orderSeq: number,
  blocks: unknown[],
  metadata: Record<string, unknown> = {},
  overrides: Partial<ChatMessageRecord> = {}
): ChatMessageRecord {
  return {
    id: `msg-assistant-${orderSeq}`,
    sessionId: SESSION,
    orderSeq,
    role: 'assistant',
    content: JSON.stringify(blocks),
    status: 'sent',
    isContextEdge: 0,
    metadata: JSON.stringify(metadata),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

const contentBlock = (content: string) => ({
  type: 'content',
  content,
  status: 'success',
  timestamp: 1_700_000_000_000
})

const toolCallBlock = (name: string, status = 'success') => ({
  type: 'tool_call',
  status,
  timestamp: 1_700_000_000_000,
  tool_call: { id: 'call-1', name, params: '{}', response: 'ok' }
})

describe('collectBackflowEvents', () => {
  it('turns a user and assistant exchange into message events', () => {
    const collected = collectBackflowEvents({
      messages: [
        userMessage(1, '帮我查一下库存'),
        assistantMessage(2, [contentBlock('库存还有 12 件。')])
      ],
      afterOrderSeq: null
    })

    expect(collected.events).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', content: '帮我查一下库存' }),
      expect.objectContaining({ type: 'message', role: 'assistant', content: '库存还有 12 件。' })
    ])
    expect(collected.nextOrderSeq).toBe(2)
  })

  it('derives event ids from the message id alone, so a resend stays idempotent', () => {
    const messages = [userMessage(1, 'hi'), assistantMessage(2, [contentBlock('hello')])]

    const first = collectBackflowEvents({ messages, afterOrderSeq: null })
    // Same messages, different cursor bookkeeping: ids must not move.
    const second = collectBackflowEvents({ messages, afterOrderSeq: null })

    expect(first.events.map((event) => event.eventId)).toEqual(
      second.events.map((event) => event.eventId)
    )
    expect(first.events[0].eventId).toBe(backflowEventId.message('msg-user-1'))
  })

  it('does not renumber ids when earlier messages scroll out of the window', () => {
    // A positional id (index in the array) would shift here and duplicate everything.
    const full = collectBackflowEvents({
      messages: [userMessage(1, 'a'), userMessage(2, 'b')],
      afterOrderSeq: null
    })
    const trimmed = collectBackflowEvents({
      messages: [userMessage(2, 'b')],
      afterOrderSeq: null
    })

    expect(trimmed.events[0].eventId).toBe(full.events[1].eventId)
  })

  it('reports tool calls as their own events', () => {
    const collected = collectBackflowEvents({
      messages: [
        assistantMessage(1, [contentBlock('查询中'), toolCallBlock('staffdeck_inventory_lookup')])
      ],
      afterOrderSeq: null
    })

    const toolEvent = collected.events.find((event) => event.type === 'tool_call')
    expect(toolEvent).toMatchObject({
      type: 'tool_call',
      name: 'staffdeck_inventory_lookup',
      status: 'ok'
    })
    expect(toolEvent?.eventId).toBe(backflowEventId.toolCall('msg-assistant-1', 1))
  })

  it('maps a failed tool call to an error status', () => {
    const collected = collectBackflowEvents({
      messages: [assistantMessage(1, [toolCallBlock('broken_tool', 'error')])],
      afterOrderSeq: null
    })

    expect(collected.events[0]).toMatchObject({ type: 'tool_call', status: 'error' })
  })

  it('reports token usage once per assistant message', () => {
    const collected = collectBackflowEvents({
      messages: [
        assistantMessage(1, [contentBlock('done')], {
          totalTokens: 120,
          inputTokens: 100,
          outputTokens: 20
        })
      ],
      afterOrderSeq: null
    })

    const usage = collected.events.find((event) => event.type === 'usage')
    expect(usage).toMatchObject({
      type: 'usage',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120
    })
  })

  it('skips usage when the provider reported no tokens', () => {
    const collected = collectBackflowEvents({
      messages: [assistantMessage(1, [contentBlock('done')])],
      afterOrderSeq: null
    })

    expect(collected.events.some((event) => event.type === 'usage')).toBe(false)
  })

  it('only collects messages past the cursor', () => {
    const collected = collectBackflowEvents({
      messages: [userMessage(1, 'old'), userMessage(2, 'new')],
      afterOrderSeq: 1
    })

    expect(collected.events).toHaveLength(1)
    expect(collected.events[0]).toMatchObject({ content: 'new' })
    expect(collected.nextOrderSeq).toBe(2)
  })

  it('keeps the cursor when there is nothing new', () => {
    // Returning null here would drop the baseline and replay the whole window
    // on the next turn.
    const collected = collectBackflowEvents({
      messages: [userMessage(1, 'old')],
      afterOrderSeq: 1
    })

    expect(collected.events).toEqual([])
    expect(collected.nextOrderSeq).toBe(1)
  })

  it('stops before an unpersisted optimistic message', () => {
    // The optimistic user row gets a real id after the turn commits. Reporting
    // it now would file an event under an id that never comes back.
    const collected = collectBackflowEvents({
      messages: [
        assistantMessage(1, [contentBlock('previous answer')]),
        userMessage(2, 'just typed', { id: '__optimistic_user_1700000000000_3' }),
        assistantMessage(3, [contentBlock('streaming answer')])
      ],
      afterOrderSeq: null
    })

    expect(collected.events).toHaveLength(1)
    expect(collected.events[0]).toMatchObject({ content: 'previous answer' })
    // Cursor must not move past the optimistic row either.
    expect(collected.nextOrderSeq).toBe(1)
  })

  it('skips an empty user message instead of filing a blank turn', () => {
    const collected = collectBackflowEvents({
      messages: [userMessage(1, '   ')],
      afterOrderSeq: null
    })

    expect(collected.events).toEqual([])
    // The row was examined, so the cursor still advances past it.
    expect(collected.nextOrderSeq).toBe(1)
  })

  it('sends raw content through when the row is not JSON', () => {
    const collected = collectBackflowEvents({
      messages: [userMessage(1, 'x', { content: 'legacy plain text' })],
      afterOrderSeq: null
    })

    expect(collected.events[0]).toMatchObject({ content: 'legacy plain text' })
  })

  it('never lets one malformed row abort the whole batch', () => {
    const collected = collectBackflowEvents({
      messages: [
        userMessage(1, 'ok'),
        assistantMessage(2, [], {}, { content: '{not json' }),
        userMessage(3, 'still collected')
      ],
      afterOrderSeq: null
    })

    expect(collected.events.map((event) => event.content)).toEqual(['ok', 'still collected'])
  })
})
