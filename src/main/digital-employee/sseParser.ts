/**
 * StaffDeck SSE 帧解析器（纯函数，无 IO）。
 *
 * 只做分帧与字段切分，不解析 JSON、不校验事件名——那是调用方的职责。
 * 协议依据（`app/public_api/jobs.py:570`）：
 *   `id: {seq}\nevent: {type}\ndata: {json}\n\n`
 * 另外每 100 个空闲 tick 会插入 `: keepalive\n\n` 注释行（`jobs.py:574-576`），
 * 必须跳过，否则上层会把注释当 JSON 解析而抛错。
 */

/**
 * 单个 SSE 帧的解析结果。id/event 缺省表示该帧未携带对应字段；
 * data 为帧内所有 data 行以 `\n` 拼接（多行 data 是合法的）。
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

/** 解析单个原始帧文本；不含任何 data/id/event 字段时返回 null（如纯注释块）。 */
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

/**
 * 创建有状态的分帧器：跨 push 调用维护半帧缓冲，网络分包不影响帧完整性。
 * 典型时序：循环 push → 收集帧 → 流结束后 flush 收尾。
 */
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
