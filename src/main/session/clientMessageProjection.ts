import { AssistantMessageBlockSchema } from '@shared/contracts/common'
import type { DeepchatEventPayload } from '@shared/contracts/events'
import type {
  AssistantMessageBlock,
  ChatMessagePageResult,
  ChatMessageRecord
} from '@shared/types/agent-interface'

const RenderedAssistantBlocksSchema = AssistantMessageBlockSchema.array()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 发往渲染层的消息投影（clientMessageProjection）：assistant block 里可能
 * 挂着 providerReplayJson（供 tape 回放用的原始 provider 响应，体积大且
 * 含内部细节），出主进程前统一剥掉。剥除是防御性的：解析失败宁可把整条
 * content 清空，也不把可疑结构发给渲染层。
 */

/** 剥掉单个 block 的 providerReplayJson；extra 因此变空时连同 extra 一并去掉。 */
function stripProviderReplayJson(block: unknown): unknown {
  if (!isRecord(block) || !isRecord(block.extra)) {
    return block
  }
  if (!Object.hasOwn(block.extra, 'providerReplayJson')) {
    return block
  }

  const { providerReplayJson: _providerReplayJson, ...visibleExtra } = block.extra
  return {
    ...block,
    extra: Object.keys(visibleExtra).length > 0 ? visibleExtra : undefined
  }
}

function projectBlocksForClient(blocks: readonly unknown[]): unknown[] {
  return blocks.map(stripProviderReplayJson)
}

/** 流式事件用：深度克隆并清洗 blocks，再过 zod schema 保证事件契约成立。 */
export function cloneBlocksForRenderer(
  blocks: AssistantMessageBlock[]
): DeepchatEventPayload<'chat.stream.updated'>['blocks'] {
  const rendererBlocks = projectBlocksForClient(blocks)
  return RenderedAssistantBlocksSchema.parse(JSON.parse(JSON.stringify(rendererBlocks)))
}

function projectMessageRecordForClient(message: ChatMessageRecord): ChatMessageRecord {
  // 先做字符串级快速检查：不含该键的消息直接原样返回，避免无谓的解析。
  if (message.role !== 'assistant' || !message.content.includes('"providerReplayJson"')) {
    return message
  }

  try {
    const blocks: unknown = JSON.parse(message.content)
    if (!Array.isArray(blocks)) {
      throw new Error('Assistant content is not a block array.')
    }
    return {
      ...message,
      content: JSON.stringify(projectBlocksForClient(blocks))
    }
  } catch (error) {
    console.warn('[ClientMessageProjection] Redacted invalid assistant blocks:', error)
    return { ...message, content: '[]' }
  }
}

/** 分页消息出站前的统一投影入口（消息历史读取走这里）。 */
export function projectMessagePageForClient(page: ChatMessagePageResult): ChatMessagePageResult {
  return {
    ...page,
    messages: page.messages.map(projectMessageRecordForClient)
  }
}
