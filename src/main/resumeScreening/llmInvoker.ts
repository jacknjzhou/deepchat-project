import type { ChatMessage } from '@shared/types/core/chat-message'
import { jsonrepair } from 'jsonrepair'

export interface ResumeLlmInvokerDeps {
  executeWithRateLimit: (providerId: string, options?: { signal?: AbortSignal }) => Promise<void>
  /** 对应 provider.generateCompletionStandalone；swallowErrors 由本模块固定为 false */
  generateCompletion: (
    providerId: string,
    messages: ChatMessage[],
    modelId: string,
    temperature: number | undefined,
    maxTokens: number | undefined,
    options?: { signal?: AbortSignal; swallowErrors?: boolean }
  ) => Promise<string>
}

export interface ResumeLlmInvokeOptions {
  providerId: string
  modelId: string
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 单角色 LLM 调用：限速 → 补全 → 清理围栏 → jsonrepair 解析；失败带上下文重试一次 */
export class ResumeLlmInvoker {
  constructor(private readonly deps: ResumeLlmInvokerDeps) {}

  async invokeJson<T>(options: ResumeLlmInvokeOptions): Promise<T> {
    await this.deps.executeWithRateLimit(options.providerId, { signal: options.signal })
    const messages: ChatMessage[] = [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt }
    ]
    const first = await this.deps.generateCompletion(
      options.providerId,
      messages,
      options.modelId,
      options.temperature,
      options.maxTokens,
      { signal: options.signal, swallowErrors: false }
    )
    const parsed = this.tryParse<T>(first)
    if (parsed !== null) {
      return parsed
    }
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first },
      {
        role: 'user',
        content:
          '你的上一条回复不是合法的 JSON。请重新回复，只输出符合要求的 JSON，不要包含任何解释、markdown 代码围栏或其他文字。'
      }
    ]
    await this.deps.executeWithRateLimit(options.providerId, { signal: options.signal })
    const second = await this.deps.generateCompletion(
      options.providerId,
      retryMessages,
      options.modelId,
      options.temperature,
      options.maxTokens,
      { signal: options.signal, swallowErrors: false }
    )
    const reparsed = this.tryParse<T>(second)
    if (reparsed !== null) {
      return reparsed
    }
    throw new Error('模型两次输出均无法解析为 JSON')
  }

  private tryParse<T>(raw: string): T | null {
    try {
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim()
      // jsonrepair 会把「JSON + 尾随杂讯」修复成含杂讯的数组，先截取首个 {/[ 到末个 }/] 的切片
      const start = cleaned.search(/[{[]/)
      const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
      if (start === -1 || end <= start) {
        return null
      }
      const parsed = JSON.parse(jsonrepair(cleaned.slice(start, end + 1))) as T
      // jsonrepair 会把裸文本修复为 JSON 字符串，这里只接受对象/数组结果
      if (typeof parsed !== 'object' || parsed === null) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }
}
