import { describe, expect, it } from 'vitest'
import type { MessageFile } from '../../../src/shared/types/agent-interface'
import {
  REMOTE_ATTACHMENT_MAX_COUNT,
  REMOTE_ATTACHMENT_MAX_IMAGE_BYTES,
  REMOTE_ATTACHMENT_MAX_TEXT_CHARS,
  planRemoteAttachments
} from '../../../src/main/digital-employee/remoteAttachments'

/** 1x1 PNG，魔数正确，长度 68 字节。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = 70

function pngFile(overrides: Partial<MessageFile> = {}): MessageFile {
  return {
    name: 'shot.png',
    path: '/tmp/shot.png',
    mimeType: 'image/png',
    content: `data:image/png;base64,${PNG_BASE64}`,
    ...overrides
  }
}

function textFile(overrides: Partial<MessageFile> = {}): MessageFile {
  return {
    name: 'notes.md',
    path: '/tmp/notes.md',
    mimeType: 'text/markdown',
    content: '# hello',
    ...overrides
  }
}

describe('planRemoteAttachments', () => {
  it('returns nothing for an empty or missing file list', () => {
    expect(planRemoteAttachments(undefined)).toEqual({ attachments: [], skipped: [] })
    expect(planRemoteAttachments([])).toEqual({ attachments: [], skipped: [] })
  })

  it('converts a png data url into a descriptor whose size matches the decoded bytes', () => {
    const { attachments, skipped } = planRemoteAttachments([pngFile()])

    expect(skipped).toEqual([])
    expect(attachments).toHaveLength(1)
    // 服务端拿 size 和解码后的字节数做严格相等比较，多一个字节就整条作废。
    expect(attachments[0]).toMatchObject({
      filename: 'shot.png',
      content_type: 'image/png',
      size: PNG_BYTES,
      kind: 'image'
    })
    expect(attachments[0].data_url).toBe(`data:image/png;base64,${PNG_BASE64}`)
    // 不传 sha256：带上就会触发服务端去查从未上传过的暂存原件。
    expect(attachments[0]).not.toHaveProperty('sha256')
  })

  it('rewrites aliased image mime types so prefix and content_type stay identical', () => {
    const { attachments } = planRemoteAttachments([
      pngFile({
        name: 'shot.png',
        mimeType: 'image/x-png',
        content: `data:image/x-png;base64,${PNG_BASE64}`
      })
    ])

    expect(attachments[0].content_type).toBe('image/png')
    // 前缀必须跟着改：服务端要求 data_url 以 `data:{content_type};base64,` 开头。
    expect(attachments[0].data_url?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('strips embedded whitespace from the base64 payload', () => {
    const wrapped = `${PNG_BASE64.slice(0, 20)}\n${PNG_BASE64.slice(20)}`
    const { attachments } = planRemoteAttachments([
      pngFile({ content: `data:image/png;base64,${wrapped}` })
    ])

    expect(attachments[0].size).toBe(PNG_BYTES)
    expect(attachments[0].data_url).not.toContain('\n')
  })

  it('skips an image whose mime type the service does not accept', () => {
    const { attachments, skipped } = planRemoteAttachments([
      pngFile({ name: 'raw.tiff', mimeType: 'image/tiff', content: 'data:image/tiff;base64,AAAA' })
    ])

    expect(attachments).toEqual([])
    expect(skipped).toEqual([{ name: 'raw.tiff', reason: 'image_type_unsupported' }])
  })

  it('skips an image whose content is not a valid data url', () => {
    const { attachments, skipped } = planRemoteAttachments([
      pngFile({ content: 'https://example.com/shot.png' })
    ])

    expect(attachments).toEqual([])
    expect(skipped).toEqual([{ name: 'shot.png', reason: 'invalid_image_data' }])
  })

  it('skips an image larger than the 4MB data url limit', () => {
    // 解码后超过 4MB：base64 长度约为字节数的 4/3，且必须是合法 base64 的长度
    // （4 的倍数），否则会先被判成 invalid_image_data，测不到体积这一支。
    const rawLength = Math.ceil((REMOTE_ATTACHMENT_MAX_IMAGE_BYTES + 1) * 1.34)
    const oversize = 'A'.repeat(rawLength + ((4 - (rawLength % 4)) % 4))
    const { attachments, skipped } = planRemoteAttachments([
      pngFile({ content: `data:image/png;base64,${oversize}` })
    ])

    expect(attachments).toEqual([])
    expect(skipped).toEqual([{ name: 'shot.png', reason: 'image_too_large' }])
  })

  it('sends a text file inline because public api never accepts uploaded bytes', () => {
    const { attachments, skipped } = planRemoteAttachments([textFile()])

    expect(skipped).toEqual([])
    expect(attachments[0]).toMatchObject({
      filename: 'notes.md',
      content_type: 'text/markdown',
      kind: 'text',
      text: '# hello'
    })
    // size 用 UTF-8 字节数，服务端据此做体积判断与预览摘要。
    expect(attachments[0].size).toBe(7)
    expect(attachments[0]).not.toHaveProperty('data_url')
  })

  it('treats a pdf as pdf kind and sends the locally extracted text', () => {
    const { attachments } = planRemoteAttachments([
      {
        name: 'report.pdf',
        path: '/tmp/report.pdf',
        mimeType: 'application/pdf',
        content: '## Page 1\n\nhello'
      }
    ])

    expect(attachments[0]).toMatchObject({
      kind: 'pdf',
      content_type: 'application/pdf',
      filename: 'report.pdf'
    })
    expect(attachments[0].text).toContain('hello')
  })

  it('skips binary formats that have no trusted channel', () => {
    const { attachments, skipped } = planRemoteAttachments([
      {
        name: 'deck.pptx',
        path: '/tmp/deck.pptx',
        mimeType: 'application/vnd.ms-powerpoint',
        content: 'x'
      },
      { name: 'voice.mp3', path: '/tmp/voice.mp3', mimeType: 'audio/mpeg', content: 'x' }
    ])

    expect(attachments).toEqual([])
    expect(skipped).toEqual([
      { name: 'deck.pptx', reason: 'unsupported_type' },
      { name: 'voice.mp3', reason: 'unsupported_type' }
    ])
  })

  it('skips a text file whose content was never extracted', () => {
    const { skipped } = planRemoteAttachments([textFile({ content: '   ' })])

    expect(skipped).toEqual([{ name: 'notes.md', reason: 'empty_content' }])
  })

  it('truncates extracted text to the service character limit', () => {
    const long = 'a'.repeat(REMOTE_ATTACHMENT_MAX_TEXT_CHARS + 500)
    const { attachments } = planRemoteAttachments([textFile({ content: long })])

    expect(attachments[0].text).toHaveLength(REMOTE_ATTACHMENT_MAX_TEXT_CHARS)
  })

  it('keeps at most 8 attachments and reports the rest', () => {
    const files = Array.from({ length: REMOTE_ATTACHMENT_MAX_COUNT + 2 }, (_, index) =>
      textFile({ name: `note-${index}.md` })
    )
    const { attachments, skipped } = planRemoteAttachments(files)

    expect(attachments).toHaveLength(REMOTE_ATTACHMENT_MAX_COUNT)
    expect(skipped).toEqual([
      { name: 'note-8.md', reason: 'too_many_attachments' },
      { name: 'note-9.md', reason: 'too_many_attachments' }
    ])
  })

  it('stops adding payloads once the per-turn budget is spent', () => {
    // 每张约 3.75MB（解码后），单张过得去，两张就超出 8MB 的单轮预算。
    const big = 'A'.repeat(5_000_000)
    const files = [0, 1, 2].map((index) =>
      pngFile({ name: `big-${index}.png`, content: `data:image/png;base64,${big}` })
    )
    const { attachments, skipped } = planRemoteAttachments(files)

    expect(attachments).toHaveLength(1)
    expect(skipped).toEqual([
      { name: 'big-1.png', reason: 'payload_budget_exceeded' },
      { name: 'big-2.png', reason: 'payload_budget_exceeded' }
    ])
  })

  it('derives a stable id so the same attachment resent maps to one sandbox file', () => {
    const first = planRemoteAttachments([textFile()]).attachments[0]
    const second = planRemoteAttachments([textFile()]).attachments[0]

    expect(first.id).toBe(second.id)
    expect(first.id.startsWith('att_')).toBe(true)
  })

  it('gives different ids to different attachments with the same name', () => {
    const a = planRemoteAttachments([textFile({ name: 'a.md' })]).attachments[0]
    const b = planRemoteAttachments([textFile({ name: 'b.md' })]).attachments[0]

    expect(a.id).not.toBe(b.id)
  })

  it('keeps the original order so the sandbox index stays aligned', () => {
    const { attachments } = planRemoteAttachments([
      textFile({ name: 'first.md' }),
      pngFile(),
      textFile({ name: 'third.md' })
    ])

    expect(attachments.map((item) => item.filename)).toEqual(['first.md', 'shot.png', 'third.md'])
  })

  it('reduces a path to its basename so the sandbox never sees host directories', () => {
    const { attachments } = planRemoteAttachments([
      textFile({ name: 'C:\\Users\\jacky\\secret\\notes.md' })
    ])

    expect(attachments[0].filename).toBe('notes.md')
  })
})
