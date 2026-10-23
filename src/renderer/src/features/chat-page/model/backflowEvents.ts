import type {
  AssistantMessageBlock,
  ChatMessageRecord,
  MessageMetadata
} from '@shared/types/agent-interface'
import type { BackflowEventInput } from '@shared/contracts/routes'
import type { DisplayUserMessageContent } from './displayMessage'

/**
 * 把本地消息记录转成回流事件。
 *
 * 这一层单独存在是因为它是整条回流链路里唯一「不可逆」的一步：事件 id 一旦
 * 生成就定死了服务端的去重粒度。所以规则要写清、要能单测：
 *
 * - **事件 id 只由消息 id 与块位置决定**，不含时间戳、不含序号。同一轮重报
 *   必须产生同一批 id，否则服务端会把重发当成新消息，归档里出现两份。
 * - **只上报窗口内、游标之后的消息**。上报失败后游标不前进，下一轮自然重发
 *   同一批；因为 id 稳定，重发不会产生重复。
 * - **消息正文取可见文本**，不取原始 JSON。用户消息的正文在
 *   `DisplayUserMessageContent.text`，助手消息分散在若干 `content` 块里。
 *   把整串 JSON 传上去会让管理端的对话记录全是转义字符。
 * - **工具调用单独成事件**，不混在助手正文里：管理端要按工具名统计成功率与
 *   耗时，混进正文就只能靠再解析一次。
 */

/** 助手消息可能是 `pending`（未完成），映射成服务端认识的两种状态。 */
const toolCallStatus = (block: AssistantMessageBlock): 'ok' | 'error' =>
  block.status === 'error' ? 'error' : 'ok'

export const backflowEventId = {
  message: (messageId: string): string => `m:${messageId}`,
  toolCall: (messageId: string, index: number): string => `t:${messageId}:${index}`,
  usage: (messageId: string): string => `u:${messageId}`
}

const parseJson = <TValue>(raw: string): TValue | null => {
  try {
    return JSON.parse(raw) as TValue
  } catch {
    return null
  }
}

const toIso = (milliseconds: number): string | undefined => {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
  return new Date(milliseconds).toISOString()
}

const userMessageText = (content: string): string => {
  const parsed = parseJson<DisplayUserMessageContent>(content)
  if (!parsed || typeof parsed !== 'object') {
    // 老数据可能不是 JSON。原文比丢掉更有价值，归档宁可粗糙也不要缺口。
    return content
  }
  return typeof parsed.text === 'string' ? parsed.text : ''
}

const assistantBlocks = (content: string): AssistantMessageBlock[] => {
  const parsed = parseJson<unknown>(content)
  return Array.isArray(parsed) ? (parsed as AssistantMessageBlock[]) : []
}

/** 助手消息的可见正文：按出现顺序拼接所有 `content` 块。 */
const assistantMessageText = (blocks: AssistantMessageBlock[]): string =>
  blocks
    .filter((block) => block.type === 'content' && typeof block.content === 'string')
    .map((block) => block.content as string)
    .join('\n\n')
    .trim()

const parseMetadata = (raw: string): MessageMetadata => {
  const parsed = parseJson<MessageMetadata>(raw)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export interface BackflowCollectInput {
  messages: readonly ChatMessageRecord[]
  /**
   * 已经上报到哪一条（含）。`null` 表示还没有基线，从窗口起点开始。
   *
   * 窗口起点而非 `0`：调用方只能拿到已加载的消息，用它算不出真实的第一条。
   */
  afterOrderSeq: number | null
}

export interface BackflowCollection {
  events: BackflowEventInput[]
  /**
   * 下一轮的游标。**本轮没有产出事件时原样返回入参**——否则一次「本轮无新消息」
   * 会清掉基线，下轮把整个窗口重报一遍。
   */
  nextOrderSeq: number | null
}

/**
 * 未落库的临时记录。
 *
 * 流刚结束时用户那条还是乐观记录（`__optimistic_user_<ts>_<n>`），提交持久化
 * 之后会被换成真实 id。此时上报有两个坏结果：用临时 id 上报的事件永远对不上
 * 后半段的重报（服务端看到两条不同的消息），而游标一旦越过它，真实记录出现时
 * 因为 `orderSeq` 不前进就再也采不到。
 *
 * 所以遇到临时记录就**在本轮停下**，不跳过它继续往后采——后面那些助手消息
 * 等下一轮连同用户那条一起报，服务端按 id 去重，不会重复。
 */
const isTemporaryRecord = (id: string): boolean =>
  id.startsWith('__optimistic') || id.startsWith('__rate_limit__:')

export function collectBackflowEvents(input: BackflowCollectInput): BackflowCollection {
  const pending =
    input.afterOrderSeq === null
      ? [...input.messages]
      : input.messages.filter((message) => message.orderSeq > (input.afterOrderSeq as number))

  const stable: ChatMessageRecord[] = []
  for (const message of pending) {
    if (isTemporaryRecord(message.id)) break
    stable.push(message)
  }

  if (stable.length === 0) {
    return { events: [], nextOrderSeq: input.afterOrderSeq }
  }

  const events: BackflowEventInput[] = []
  let maxOrderSeq = input.afterOrderSeq

  for (const message of stable) {
    maxOrderSeq = maxOrderSeq === null ? message.orderSeq : Math.max(maxOrderSeq, message.orderSeq)
    const createdAt = toIso(message.createdAt)

    if (message.role === 'user') {
      const content = userMessageText(message.content)
      // 空正文不占一条事件：用户可能只发了附件，正文本来就是空的。
      if (content.trim()) {
        events.push({
          type: 'message',
          eventId: backflowEventId.message(message.id),
          role: 'user',
          content,
          ...(createdAt ? { createdAt } : {})
        })
      }
      continue
    }

    const blocks = assistantBlocks(message.content)
    const text = assistantMessageText(blocks)
    if (text) {
      events.push({
        type: 'message',
        eventId: backflowEventId.message(message.id),
        role: 'assistant',
        content: text,
        ...(createdAt ? { createdAt } : {})
      })
    }

    blocks.forEach((block, index) => {
      if (block.type !== 'tool_call') return
      const name = block.tool_call?.name?.trim()
      // 没有名字的工具调用在管理端只会显示成一串空行，不如不报。
      if (!name) return
      events.push({
        type: 'tool_call',
        eventId: backflowEventId.toolCall(message.id, index),
        name,
        status: toolCallStatus(block),
        ...(createdAt ? { createdAt } : {})
      })
    })

    const metadata = parseMetadata(message.metadata)
    const totalTokens = metadata.totalTokens ?? 0
    if (totalTokens > 0) {
      events.push({
        type: 'usage',
        eventId: backflowEventId.usage(message.id),
        promptTokens: metadata.inputTokens ?? 0,
        completionTokens: metadata.outputTokens ?? 0,
        totalTokens,
        ...(createdAt ? { createdAt } : {})
      })
    }
  }

  return { events, nextOrderSeq: maxOrderSeq }
}
