import { describe, expect, it, vi } from 'vitest'
import { ResumeLlmInvoker } from '@/resumeScreening/llmInvoker'

const makeDeps = () => {
  const calls: string[] = []
  const executeWithRateLimit = vi.fn(async () => {
    calls.push('rateLimit')
  })
  let responses: string[] = []
  const generateCompletion = vi.fn(async () => {
    calls.push('completion')
    return responses.shift() ?? ''
  })
  return {
    calls,
    executeWithRateLimit,
    generateCompletion,
    setResponses: (list: string[]) => {
      responses = [...list]
    }
  }
}

const baseOptions = {
  providerId: 'openai',
  modelId: 'gpt-4o',
  systemPrompt: 'system-prompt',
  userPrompt: 'user-prompt'
}

describe('ResumeLlmInvoker', () => {
  it('parses plain JSON and calls rate limit before completion', async () => {
    const deps = makeDeps()
    deps.setResponses(['{"score": 85}'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ score: number }>(baseOptions)
    expect(result.score).toBe(85)
    expect(deps.calls).toEqual(['rateLimit', 'completion'])
  })

  it('strips markdown fences before parsing', async () => {
    const deps = makeDeps()
    deps.setResponses(['```json\n{"ok": true}\n```'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ ok: boolean }>(baseOptions)
    expect(result.ok).toBe(true)
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
  })

  it('retries once with context when first output is not JSON', async () => {
    const deps = makeDeps()
    deps.setResponses(['抱歉，我无法回答。', '{"ok": 1}'])
    const invoker = new ResumeLlmInvoker(deps)
    const result = await invoker.invokeJson<{ ok: number }>(baseOptions)
    expect(result.ok).toBe(1)
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    const retryMessages = deps.generateCompletion.mock.calls[1][1] as Array<{
      role: string
      content?: string
    }>
    expect(retryMessages).toHaveLength(4)
    expect(retryMessages[2]).toMatchObject({ role: 'assistant' })
    expect(retryMessages[3]).toMatchObject({ role: 'user' })
    expect(String(retryMessages[3].content)).toContain('JSON')
  })

  it('throws when both attempts fail to parse', async () => {
    const deps = makeDeps()
    deps.setResponses(['bad 1', 'bad 2'])
    const invoker = new ResumeLlmInvoker(deps)
    await expect(invoker.invokeJson(baseOptions)).rejects.toThrow('两次输出均无法解析')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
  })

  it('forwards the abort signal to both calls', async () => {
    const deps = makeDeps()
    deps.setResponses(['{}'])
    const invoker = new ResumeLlmInvoker(deps)
    const controller = new AbortController()
    await invoker.invokeJson({ ...baseOptions, signal: controller.signal })
    expect(deps.executeWithRateLimit.mock.calls[0][1]).toEqual({ signal: controller.signal })
    expect(deps.generateCompletion.mock.calls[0][5]).toMatchObject({ signal: controller.signal })
  })
})
