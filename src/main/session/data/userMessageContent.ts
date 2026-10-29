import type {
  MessageFile,
  SendMessageInput,
  UserMessageContent
} from '@shared/types/agent-interface'

const normalizeStringList = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )

/**
 * 用户消息内容的双向转换工具：历史消息的 content JSON ↔ 可重发的发送输入。
 * 编辑消息（editUserMessage）只允许改 text，文件/链接等字段必须原样保留；
 * 重试（retry）则要从 content 反抽出完整的 SendMessageInput。
 */

/** 从用户消息 content 中抽取可重发的发送输入；解析失败按纯文本兜底。 */
export function extractUserMessageInput(content: string): SendMessageInput {
  const fallback: SendMessageInput = { text: '', files: [] }

  try {
    const parsed = JSON.parse(content) as UserMessageContent | SendMessageInput | string
    if (typeof parsed === 'string') return { text: parsed, files: [] }
    if (!parsed || typeof parsed !== 'object') return fallback

    const text = typeof parsed.text === 'string' ? parsed.text : ''
    const files = Array.isArray((parsed as { files?: unknown }).files)
      ? ((parsed as { files?: unknown }).files as MessageFile[]).filter(Boolean)
      : []
    const activeSkills = normalizeStringList(
      Array.isArray((parsed as { activeSkills?: unknown }).activeSkills)
        ? ((parsed as { activeSkills?: unknown }).activeSkills as string[])
        : []
    )
    const inlineItems = Array.isArray((parsed as { inlineItems?: unknown }).inlineItems)
      ? ((parsed as { inlineItems?: unknown }).inlineItems as NonNullable<
          SendMessageInput['inlineItems']
        >)
      : []
    return {
      text,
      files,
      search: (parsed as { search?: unknown }).search === true,
      ...(activeSkills.length > 0 ? { activeSkills } : {}),
      ...(inlineItems.length > 0 ? { inlineItems } : {})
    }
  } catch {
    return { text: content, files: [] }
  }
}

/** 发送输入的规范化：字段逐一兜底，attachmentFallbackPolicy 只认两个合法值。 */
export function normalizeUserMessageInput(input: string | SendMessageInput): SendMessageInput {
  if (typeof input === 'string') return { text: input, files: [] }
  if (!input || typeof input !== 'object') return { text: '', files: [] }

  const text = typeof input.text === 'string' ? input.text : ''
  const files = Array.isArray(input.files) ? input.files.filter(Boolean) : []
  const activeSkills = normalizeStringList(
    Array.isArray(input.activeSkills) ? input.activeSkills : []
  )
  const inlineItems = Array.isArray(input.inlineItems) ? input.inlineItems : []
  return {
    text,
    files,
    search: input.search === true,
    ...(activeSkills.length > 0 ? { activeSkills } : {}),
    ...(inlineItems.length > 0 ? { inlineItems } : {}),
    ...(input.attachmentFallbackPolicy === 'auto' ||
    input.attachmentFallbackPolicy === 'send_without_image_content'
      ? { attachmentFallbackPolicy: input.attachmentFallbackPolicy }
      : {})
  }
}

/**
 * 生成编辑后的用户消息 content：只替换 text 字段（兼容旧版 content 数组
 * 结构，替换首个 text 块），其余字段原样保留；inlineItems 与编辑语义
 * 冲突（偏移会失效），一并清除。解析失败退回最小合法结构。
 */
export function buildEditedUserContent(rawContent: string, text: string): string {
  const fallback: UserMessageContent = {
    text,
    files: [],
    links: [],
    search: false,
    think: false
  }

  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown> | string
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return JSON.stringify(fallback)
    }

    const next = { ...parsed, text } as Record<string, unknown>
    delete next.inlineItems
    if (!Array.isArray(next.files)) next.files = []
    if (!Array.isArray(next.links)) next.links = []
    if (typeof next.search !== 'boolean') next.search = false
    if (typeof next.think !== 'boolean') next.think = false

    if (Array.isArray(next.content)) {
      let replaced = false
      const mapped = next.content.map((item) => {
        if (
          !replaced &&
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as { type?: unknown }).type === 'text'
        ) {
          replaced = true
          return { ...(item as Record<string, unknown>), content: text }
        }
        return item
      })
      if (!replaced) mapped.unshift({ type: 'text', content: text })
      next.content = mapped
    }

    return JSON.stringify(next)
  } catch {
    return JSON.stringify(fallback)
  }
}
