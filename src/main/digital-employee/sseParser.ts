/**
 * StaffDeck SSE 帧解析器（纯函数，无 IO）。
 *
 * 只做分帧与字段切分，不解析 JSON、不校验事件名——那是调用方的职责。
 * 协议依据（`app/public_api/jobs.py:570`）：
 *   `id: {seq}\nevent: {type}\ndata: {json}\n\n`
 * 另外每 100 个空闲 tick 会插入 `: keepalive\n\n` 注释行（`jobs.py:574-576`），
 * 必须跳过，否则上层会把注释当 JSON 解析而抛错。
 */

export interface StaffdeckSseFrame {
  id?: string
  event?: string
  data: string
}

export interface StaffdeckSseParser {
  /** 喂入一段文本，返回本次切出的完整帧。 */
  push(chunk: string): StaffdeckSseFrame[]
  /** 流结束时调用；丢弃未终止的残帧，避免把半截 JSON 交给上层。 */
  flush(): StaffdeckSseFrame[]
}

/** 帧分隔符：优先按 CRLF 归一化后的空行切分。 */
const FRAME_SEPARATOR = '\n\n'

/**
 * 按 SSE 规范剥掉字段值前的单个空格（只有一个）。
 * `event:  run.status` → `' run.status'`，多余空格属于值本身。
 */
function stripSingleLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

function parseFrame(raw: string): StaffdeckSseFrame | null {
  const lines = raw.split('\n')
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  let sawData = false

  for (const line of lines) {
    if (line.length === 0) continue
    // 注释行（含 keepalive）整行忽略。
    if (line.startsWith(':')) continue

    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      // 无冒号的行按规范是「字段名 + 空值」，本项目无此用法，忽略即可。
      continue
    }

    const field = line.slice(0, colonIndex)
    const value = stripSingleLeadingSpace(line.slice(colonIndex + 1))

    switch (field) {
      case 'id':
        id = value
        break
      case 'event':
        event = value
        break
      case 'data':
        dataLines.push(value)
        sawData = true
        break
      default:
        // retry 等字段当前用不到，忽略。
        break
    }
  }

  // 纯注释块或空块不产生帧。
  if (!sawData && id === undefined && event === undefined) return null

  const frame: StaffdeckSseFrame = { data: dataLines.join('\n') }
  if (id !== undefined) frame.id = id
  if (event !== undefined) frame.event = event
  return frame
}

export function createSseParser(): StaffdeckSseParser {
  let buffer = ''

  return {
    push(chunk: string): StaffdeckSseFrame[] {
      buffer += chunk.replace(/\r\n/g, '\n')

      const frames: StaffdeckSseFrame[] = []
      let separatorIndex = buffer.indexOf(FRAME_SEPARATOR)
      while (separatorIndex !== -1) {
        const raw = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + FRAME_SEPARATOR.length)
        const frame = parseFrame(raw)
        if (frame) frames.push(frame)
        separatorIndex = buffer.indexOf(FRAME_SEPARATOR)
      }
      return frames
    },

    flush(): StaffdeckSseFrame[] {
      // 刻意丢弃残帧：半截 JSON 解析失败会被误判成坏事件并触发降级。
      buffer = ''
      return []
    }
  }
}
