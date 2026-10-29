import type { ChatMessageRecord, SendMessageInput } from '@shared/types/agent-interface'
import type { SessionPendingInputs } from './data/pendingInputs'
import type { SessionSettingsStore } from './data/settings'
import type { SessionTranscript } from './data/transcript'
import { buildEditedUserContent, extractUserMessageInput } from './data/userMessageContent'
import { parseMessageMetadata } from './usageStats'

export interface SessionTranscriptRuntimePort {
  prepareClearMessages(sessionId: string): Promise<void>
  finishClearMessages(sessionId: string): void
  prepareRetry(
    sessionId: string,
    options?: { allowRestartHeldQueue?: boolean }
  ): Promise<{ projectDir: string | null }>
  assertNoActivePendingInputs(sessionId: string): void
  cancelForTranscriptMutation(sessionId: string): Promise<void>
  invalidateTranscriptFrom(sessionId: string, orderSeq: number): void
  finishTranscriptTruncate(sessionId: string): void
  resetForkTarget(sessionId: string): void
}

export interface SessionTranscriptMutationDependencies {
  transcript: SessionTranscript
  settings: SessionSettingsStore
  pendingInputs: SessionPendingInputs
  runtime: SessionTranscriptRuntimePort
  runInTransaction<T>(operation: () => T): T
}

/**
 * 消息变更的编排层（transcriptMutations）：清空/重试/删除/编辑/fork 这类
 * 「既要动存储、又要让运行时上下文失效」的操作都在这里协调。
 *
 * 与直接调 transcript 的区别：每次变更前先过 runtime 端口做前置校验
 * （无活跃待发输入、取消生成），变更后主动失效运行时缓存的历史上下文
 * （invalidateTranscriptFrom），否则模型还会看到已被删除/截断的消息。
 * 涉及多表一致的部分包在依赖注入的事务里执行。
 */
export class SessionTranscriptMutations {
  constructor(private readonly dependencies: SessionTranscriptMutationDependencies) {}

  /** 清空会话全部消息：先运行时准备，再事务内三连删（输入/消息/tape 状态）。 */
  async clearMessages(sessionId: string): Promise<void> {
    await this.dependencies.runtime.prepareClearMessages(sessionId)
    this.dependencies.runInTransaction(() => {
      this.dependencies.pendingInputs.deleteBySession(sessionId)
      this.dependencies.transcript.deleteBySession(sessionId)
      this.dependencies.settings.resetTape(sessionId)
    })
    this.dependencies.runtime.finishClearMessages(sessionId)
  }

  /**
   * 重试准备阶段（只读+状态修复，不截断）：定位重试的源头用户消息，抽出发送
   * 内容，让运行时做好准备并返回项目目录。失败的 steer 消息此时被修复成
   * sent——它必须留在上下文历史里，否则重发后模型看不到这轮提示。
   * 截断点（retryFromOrderSeq）与实际删除（commitRetryMessage）分离，由
   * 运行时选择提交时机（ACP 需要提前截，本地可在历史准备时再截）。
   */
  async prepareRetryMessage(
    sessionId: string,
    messageId: string
  ): Promise<{
    content: SendMessageInput
    projectDir: string | null
    sourceOrderSeq: number
    retryFromOrderSeq: number
    sourceMessageId: string | null
  }> {
    const target = this.requireMessage(sessionId, messageId)
    const sourceUserMessage =
      target.role === 'user'
        ? target
        : this.dependencies.transcript.getLastUserMessageBeforeOrAt(sessionId, target.orderSeq)
    if (!sourceUserMessage) throw new Error('No user message found for retry.')
    const sourceMetadata = parseMessageMetadata(sourceUserMessage.metadata)
    const allowRestartHeldQueue =
      target.status === 'error' && sourceMetadata.inputReceipt?.mode === 'steer'
    const { projectDir } = await this.dependencies.runtime.prepareRetry(sessionId, {
      allowRestartHeldQueue
    })

    const content = extractUserMessageInput(sourceUserMessage.content)
    if (!content.text.trim() && (content.files?.length ?? 0) === 0) {
      throw new Error('Cannot retry an empty user message.')
    }

    // The retried user prompt is kept in the transcript and reused as the
    // pre-stream anchor. A failed/error row (e.g. a failed Steer prompt) must be
    // restored to 'sent' so context history filtering keeps it; otherwise the
    // prompt silently drops out of future turns.
    if (sourceUserMessage.status !== 'sent') {
      this.dependencies.transcript.updateMessageStatus(sourceUserMessage.id, 'sent')
    }

    return {
      content,
      projectDir,
      sourceOrderSeq: sourceUserMessage.orderSeq,
      // Truncate from the retried message (not the source user message) so the
      // user prompt survives and only the assistant reply is regenerated. When
      // the retried message IS the user prompt, keep it too and truncate from
      // the next order sequence, anchoring it so the same record is re-sent
      // instead of a fresh duplicate.
      retryFromOrderSeq: target.role === 'user' ? target.orderSeq + 1 : target.orderSeq,
      sourceMessageId: sourceUserMessage.id
    }
  }

  /** 重试的截断提交：从事故删 + 运行时历史同步失效，二者一体执行。 */
  commitRetryMessage(sessionId: string, orderSeq: number): void {
    this.dependencies.runInTransaction(() => {
      this.dependencies.transcript.deleteFromOrderSeq(sessionId, orderSeq)
    })
    this.dependencies.runtime.invalidateTranscriptFrom(sessionId, orderSeq)
  }

  /** 删除消息：从该消息起整段截断（后续回复随之失效），先取消生成。 */
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    this.dependencies.runtime.assertNoActivePendingInputs(sessionId)
    const target = this.requireMessage(sessionId, messageId)

    await this.dependencies.runtime.cancelForTranscriptMutation(sessionId)
    this.dependencies.runtime.invalidateTranscriptFrom(sessionId, target.orderSeq)
    this.dependencies.transcript.deleteFromOrderSeq(sessionId, target.orderSeq)
    this.dependencies.runtime.finishTranscriptTruncate(sessionId)
  }

  /** 编辑用户消息文本：只改 text，保留文件等其它字段（buildEditedUserContent）。 */
  async editUserMessage(
    sessionId: string,
    messageId: string,
    text: string
  ): Promise<ChatMessageRecord> {
    this.dependencies.runtime.assertNoActivePendingInputs(sessionId)
    const target = this.requireMessage(sessionId, messageId)
    if (target.role !== 'user') throw new Error('Only user messages can be edited.')

    const nextText = text.trim()
    if (!nextText) throw new Error('Edited message cannot be empty.')

    await this.dependencies.runtime.cancelForTranscriptMutation(sessionId)
    this.dependencies.runtime.invalidateTranscriptFrom(sessionId, target.orderSeq)
    this.dependencies.transcript.updateMessageContent(
      messageId,
      buildEditedUserContent(target.content, nextText)
    )

    const updated = this.dependencies.transcript.getMessage(messageId)
    if (!updated) throw new Error(`Message ${messageId} not found after edit`)
    return updated
  }

  /** fork 的消息复制阶段：复制到目标消息为止的已发送消息，然后重置 fork 运行时。 */
  async forkSessionFromMessage(
    sourceSessionId: string,
    targetSessionId: string,
    targetMessageId: string
  ): Promise<void> {
    const target = this.requireMessage(sourceSessionId, targetMessageId)
    this.dependencies.transcript.cloneSentMessagesToSession(
      sourceSessionId,
      targetSessionId,
      target.orderSeq
    )
    this.dependencies.runtime.resetForkTarget(targetSessionId)
  }

  private requireMessage(sessionId: string, messageId: string): ChatMessageRecord {
    const message = this.dependencies.transcript.getMessage(messageId)
    if (!message) throw new Error(`Message ${messageId} not found`)
    if (message.sessionId !== sessionId) {
      throw new Error(`Message ${messageId} does not belong to session ${sessionId}`)
    }
    return message
  }
}
