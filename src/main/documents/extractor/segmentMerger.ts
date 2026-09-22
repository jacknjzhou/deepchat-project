import type { DocumentFieldEntry } from '@shared/documents'

export const SEGMENT_THRESHOLD_CHARS = 60000
export const SEGMENT_SIZE_CHARS = 40000

export function splitTextIntoSegments(text: string): string[] {
  if (text.length <= SEGMENT_THRESHOLD_CHARS) {
    return [text]
  }

  const segments: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    if (text.length - cursor <= SEGMENT_SIZE_CHARS) {
      segments.push(text.slice(cursor))
      break
    }
    let end = cursor + SEGMENT_SIZE_CHARS
    const boundary = text.lastIndexOf('\n\n', end)
    if (boundary > cursor) {
      end = boundary + 2
    }
    segments.push(text.slice(cursor, end))
    cursor = end
  }
  return segments
}

type FieldMap = Record<string, DocumentFieldEntry>

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function mergeSegmentOutputs(base: FieldMap, outputs: FieldMap[]): FieldMap {
  const merged: FieldMap = { ...base }

  for (const output of outputs) {
    for (const [key, entry] of Object.entries(output)) {
      const current = merged[key]
      if (!current || current.value === null || current.value === undefined) {
        merged[key] = { ...entry }
        continue
      }
      if (entry.value === null || entry.value === undefined) {
        continue
      }
      if (Array.isArray(current.value) && Array.isArray(entry.value)) {
        const seen = new Set(current.value.map((item) => JSON.stringify(item)))
        for (const item of entry.value) {
          const serialized = JSON.stringify(item)
          if (!seen.has(serialized)) {
            seen.add(serialized)
            current.value.push(item)
          }
        }
        continue
      }
      if (sameValue(current.value, entry.value)) {
        current.uncertain = current.uncertain || entry.uncertain
        continue
      }
      // 冲突：保留首个非空值并标 uncertain
      current.uncertain = true
    }
  }

  return merged
}
