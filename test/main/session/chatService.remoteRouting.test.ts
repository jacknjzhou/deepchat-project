import { describe, expect, it, vi } from 'vitest'
import { ChatService } from '../../../src/main/session/chatService'

function createHarness(overrides: { handles?: boolean } = {}) {
  const projection = {
    getSession: vi.fn().mockResolvedValue({ id: 's1', agentId: 'deepchat' }),
    getMessage: vi.fn().mockResolvedValue(null)
  }
  const turn = {
    sendMessage: vi.fn().mockResolvedValue({ requestId: 'r-local', messageId: 'm-local' }),
    steerActiveTurn: vi.fn().mockResolvedValue({ requestId: null, messageId: null }),
    cancelGeneration: vi.fn().mockResolvedValue(undefined),
    respondToolInteraction: vi.fn().mockResolvedValue({ resumed: true }),
    dismissToolInteraction: vi.fn().mockResolvedValue(true)
  }
  const sessionPermissionPort = { clearSessionPermissions: vi.fn() }
  const scheduler = {
    timeout: vi.fn(async ({ task }: { task: Promise<unknown> }) => await task)
  }
  const remoteTurn = {
    handles: vi.fn(() => overrides.handles ?? true),
    send: vi.fn().mockResolvedValue({
      accepted: true,
      requestId: 'r-remote',
      messageId: 'm-remote'
    })
  }

  const service = new ChatService({
    projection,
    turn,
    sessionPermissionPort,
    scheduler: scheduler as never,
    remoteTurn
  })

  return { service, projection, turn, remoteTurn, scheduler, sessionPermissionPort }
}

describe('ChatService remote routing', () => {
  it('routes a bound session to the remote turn port and skips the local turn', async () => {
    const harness = createHarness({ handles: true })

    const result = await harness.service.sendMessage('s1', 'hi')

    expect(result).toEqual({
      accepted: true,
      requestId: 'r-remote',
      messageId: 'm-remote'
    })
    expect(harness.remoteTurn.send).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ text: 'hi' })
    )
    // 关键：远端分流后绝不能再走本地 turn，否则同一条用户消息会被写两次。
    expect(harness.turn.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps the local path untouched for unbound sessions', async () => {
    const harness = createHarness({ handles: false })

    await harness.service.sendMessage('s1', 'hi')

    expect(harness.remoteTurn.send).not.toHaveBeenCalled()
    expect(harness.turn.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('normalizes a plain string into SendMessageInput before handing it to the remote port', async () => {
    const harness = createHarness({ handles: true })

    await harness.service.sendMessage('s1', 'plain text')

    const [, input] = harness.remoteTurn.send.mock.calls[0]
    expect(input).toEqual({ text: 'plain text' })
  })

  it('passes a structured input through unchanged', async () => {
    const harness = createHarness({ handles: true })
    const structured = { text: 'with files', files: [{ name: 'a.txt' }] }

    await harness.service.sendMessage('s1', structured as never)

    const [, input] = harness.remoteTurn.send.mock.calls[0]
    expect(input).toEqual(structured)
  })

  it('does not require a session lookup before routing remotely', async () => {
    // 远端会话的元数据由 main 的绑定表决定，不依赖 projection；
    // 但会话存在性仍要校验，避免往不存在的会话里写消息。
    const harness = createHarness({ handles: true })
    harness.projection.getSession.mockResolvedValue(null)

    await expect(harness.service.sendMessage('s1', 'hi')).rejects.toThrow(/not found/i)
    expect(harness.remoteTurn.send).not.toHaveBeenCalled()
  })

  it('propagates a remote failure instead of falling back to local execution', async () => {
    const harness = createHarness({ handles: true })
    harness.remoteTurn.send.mockRejectedValue(new Error('remote exploded'))

    await expect(harness.service.sendMessage('s1', 'hi')).rejects.toThrow(/remote exploded/)
    // 远端失败不得静默回落本地：那会在服务端和本地各产生一次回答。
    expect(harness.turn.sendMessage).not.toHaveBeenCalled()
  })

  it('accepts an empty text because attachments may carry the content', async () => {
    const harness = createHarness({ handles: true })

    await harness.service.sendMessage('s1', { text: '' } as never)

    expect(harness.remoteTurn.send).toHaveBeenCalledWith('s1', { text: '' })
  })
})
