import { createHash } from 'node:crypto'
import type { MessageFile } from '@shared/types/agent-interface'
import { isImageAttachment, isPdfAttachment } from '@shared/utils/attachmentRepresentation'

/**
 * 把本地附件压成 StaffDeck Public API 能接收的描述符。
 *
 * 服务端的接收能力是不对称的，这里必须照着它的真实分支走：
 *
 * - **图片**：只认 `data_url`。`harness_attachments._validated_image_data_url`
 *   会把它再丢进 `validate_chat_turn_attachments` 复检，要求 base64 解码后的
 *   字节数与 `size` **完全相等**、不超过 4MB、且魔数与 `content_type` 一致。
 *   三者任一不满足，`vision_available` 就是 false，模型根本看不到图。
 * - **文本**：`public_api/runs.py:190` 只做 `ChatAttachmentRead.model_validate`，
 *   **没有**走带会话 cookie 的 `validate_chat_turn_attachments`，所以 `text`
 *   不会被剥掉，会落进 `harness_attachments.py:132` 的 `elif attachment.text`
 *   分支写成 workspace 文件。
 * - **PDF**：同上分支，服务端 note 明确写着「PDF 附件保存的是服务端提取文本」，
 *   因此这里送的是本地已提取的 markdown，不是原始二进制。
 * - **其余（docx/xlsx/音频等）**：public_api 没有附件上传端点（`POST /api/attachments`
 *   走 `get_current_user` 的会话鉴权，API Key 进不去），没有可信通道，只能跳过。
 *
 * `sha256` 一律不传：一旦带上，服务端就会去 `read_staged_chat_attachment` 找暂存
 * 原件，而这条路径从来没有上传过，只会白跑一趟。
 */

/** 服务端 `MAX_CHAT_ATTACHMENTS`（`api/chat.py:105`）。 */
export const REMOTE_ATTACHMENT_MAX_COUNT = 8

/** 服务端 `IMAGE_DATA_URL_LIMIT_BYTES`（`session/attachments.py:21`）。 */
export const REMOTE_ATTACHMENT_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 服务端 `MAX_EXTRACTED_TEXT_CHARS`（`session/attachments.py:19`）。 */
export const REMOTE_ATTACHMENT_MAX_TEXT_CHARS = 24_000

/**
 * 单轮附件载荷预算。
 *
 * run 的请求体会原样存进 `APIJob.request_json` 并参与幂等回放比对，图片是 base64
 * 膨胀后的体积；不设上限的话 8 张 4MB 图会变成 40MB+ 的 SQLite 行。
 */
export const REMOTE_ATTACHMENT_MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** 服务端 `SUPPORTED_IMAGE_CONTENT_TYPES`（`session/attachments.py:23`）。 */
export const REMOTE_IMAGE_CONTENT_TYPES = new Set([
  'image/gif',
  'image/png',
  'image/svg+xml',
  'image/jpeg',
  'image/webp',
  'image/bmp'
])

/** 服务端 `TEXT_EXTENSIONS`（`session/attachments.py:31`）。 */
export const REMOTE_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml'
])

/** 非标准图片 MIME 到服务端白名单的映射；改类型时必须同步重写 data URL 前缀。 */
const IMAGE_CONTENT_TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp'
}

export type RemoteAttachmentSkipReason =
  | 'unsupported_type'
  | 'empty_content'
  | 'invalid_image_data'
  | 'image_type_unsupported'
  | 'image_too_large'
  | 'payload_budget_exceeded'
  | 'too_many_attachments'

export interface SkippedRemoteAttachment {
  name: string
  reason: RemoteAttachmentSkipReason
}

/**
 * 与 `ChatAttachmentRead` 对齐的线上结构。
 *
 * 只声明本客户端实际会填的字段：`preview` / `python_summary` / `error` /
 * `sandbox_path` / `sha256` 全部留给服务端自己派生。
 */
export interface StaffdeckAttachmentDescriptor {
  id: string
  filename: string
  content_type: string
  size: number
  kind: 'text' | 'pdf' | 'image'
  data_url?: string
  text?: string
}

export interface RemoteAttachmentPlan {
  attachments: StaffdeckAttachmentDescriptor[]
  skipped: SkippedRemoteAttachment[]
}

interface DecodedDataUrl {
  contentType: string
  /** base64 解码后的字节数；服务端会把它和 `size` 做严格相等比较。 */
  bytes: number
  /** 重新拼装的标准前缀 data URL，可直接回传。 */
  dataUrl: string
}

function extensionOf(name: string): string {
  const base = name.toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot) : ''
}

function basenameOf(name: string): string {
  const unified = name.replace(/\\/g, '/')
  const segment = unified.slice(unified.lastIndexOf('/') + 1).trim()
  return segment || 'attachment'
}

/** base64 文本长度换算成解码后字节数，含 `=` 补齐修正。 */
function base64ByteLength(payload: string): number {
  if (payload.length === 0) return 0
  let padding = 0
  if (payload.endsWith('==')) padding = 2
  else if (payload.endsWith('=')) padding = 1
  return Math.floor((payload.length * 3) / 4) - padding
}

/**
 * 拆解并规范化 `data:image/...;base64,...`。
 *
 * 顺便把 `image/jpg` 这类服务端白名单外的别名改成标准 MIME：前缀和
 * `content_type` 必须逐字一致，否则 `_validated_image_data_url` 直接判无效。
 */
function decodeImageDataUrl(raw: unknown): DecodedDataUrl | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(trimmed)
  if (!match) return null
  const declared = match[1].toLowerCase()
  const payload = match[2].replace(/\s/g, '')
  if (payload.length === 0 || payload.length % 4 === 1) return null
  if (!/^[a-z0-9+/]*={0,2}$/i.test(payload)) return null
  const contentType = IMAGE_CONTENT_TYPE_ALIASES[declared] ?? declared
  if (!REMOTE_IMAGE_CONTENT_TYPES.has(contentType)) return null
  return {
    contentType,
    bytes: base64ByteLength(payload),
    dataUrl: `data:${contentType};base64,${payload}`
  }
}

/** 稳定短 id：服务端用它派生沙箱文件名，重发同一附件不该产生两份。 */
function attachmentIdOf(parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex')
  return `att_${digest.slice(0, 24)}`
}

function trimText(text: string): string {
  if (text.length <= REMOTE_ATTACHMENT_MAX_TEXT_CHARS) return text
  return text.slice(0, REMOTE_ATTACHMENT_MAX_TEXT_CHARS)
}

/**
 * 把一轮的本地附件整理成服务端描述符。
 *
 * 顺序即发送顺序（服务端按数组下标派生沙箱路径），因此不排序。
 */
export function planRemoteAttachments(files: MessageFile[] | undefined): RemoteAttachmentPlan {
  const attachments: StaffdeckAttachmentDescriptor[] = []
  const skipped: SkippedRemoteAttachment[] = []
  if (!files || files.length === 0) return { attachments, skipped }

  let budget = REMOTE_ATTACHMENT_MAX_TOTAL_BYTES

  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    const name = basenameOf(typeof file.name === 'string' && file.name ? file.name : 'attachment')

    if (attachments.length >= REMOTE_ATTACHMENT_MAX_COUNT) {
      skipped.push({ name, reason: 'too_many_attachments' })
      continue
    }

    if (isImageAttachment(file)) {
      const decoded = decodeImageDataUrl(file.content)
      if (!decoded) {
        skipped.push({
          name,
          reason: REMOTE_IMAGE_CONTENT_TYPES.has(String(file.mimeType ?? '').toLowerCase())
            ? 'invalid_image_data'
            : 'image_type_unsupported'
        })
        continue
      }
      if (decoded.bytes > REMOTE_ATTACHMENT_MAX_IMAGE_BYTES) {
        skipped.push({ name, reason: 'image_too_large' })
        continue
      }
      // base64 在 JSON 里的真实体积是 4/3 再乘载荷，按 data URL 长度记账最保守。
      if (decoded.dataUrl.length > budget) {
        skipped.push({ name, reason: 'payload_budget_exceeded' })
        continue
      }
      budget -= decoded.dataUrl.length
      attachments.push({
        id: attachmentIdOf([name, String(decoded.bytes), decoded.contentType]),
        filename: name,
        content_type: decoded.contentType,
        size: decoded.bytes,
        kind: 'image',
        data_url: decoded.dataUrl
      })
      continue
    }

    const content = typeof file.content === 'string' ? file.content : ''
    if (!content.trim()) {
      skipped.push({ name, reason: 'empty_content' })
      continue
    }

    const isPdf = isPdfAttachment(file)
    const extension = extensionOf(name)
    if (!isPdf && !REMOTE_TEXT_EXTENSIONS.has(extension)) {
      // docx/xlsx/音频等：没有可信通道，宁可明确不支持，也不要把二进制塞成 text
      // 写到 workspace 里冒名顶替。
      skipped.push({ name, reason: 'unsupported_type' })
      continue
    }

    const text = trimText(content)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > budget) {
      skipped.push({ name, reason: 'payload_budget_exceeded' })
      continue
    }
    budget -= bytes
    attachments.push({
      id: attachmentIdOf([name, String(bytes), isPdf ? 'pdf' : 'text']),
      filename: name,
      content_type: isPdf ? 'application/pdf' : (file.mimeType ?? 'text/plain'),
      size: bytes,
      kind: isPdf ? 'pdf' : 'text',
      text
    })
  }

  return { attachments, skipped }
}
