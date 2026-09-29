import { describe, expect, it } from 'vitest'
import {
  SEGMENT_SIZE_CHARS,
  SEGMENT_THRESHOLD_CHARS,
  splitTextIntoSegments,
  mergeSegmentOutputs
} from '@/documents/extractor/segmentMerger'

describe('splitTextIntoSegments', () => {
  it('短文本不分段', () => {
    expect(splitTextIntoSegments('短文本')).toEqual(['短文本'])
  })

  it('阈值长度文本不分段', () => {
    const text = 'a'.repeat(SEGMENT_THRESHOLD_CHARS)
    expect(splitTextIntoSegments(text)).toEqual([text])
  })

  it('超长文本按段落边界切分为 ≤40000 字符的段', () => {
    const paragraph = `${'x'.repeat(5000)}\n\n`
    const text = paragraph.repeat(20) // 100200 chars
    const segments = splitTextIntoSegments(text)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SEGMENT_SIZE_CHARS + 2)
    }
    expect(segments.join('')).toBe(text)
  })

  it('无段落边界的超长文本硬切', () => {
    const text = 'y'.repeat(SEGMENT_THRESHOLD_CHARS + 1)
    const segments = splitTextIntoSegments(text)
    expect(segments.length).toBe(2)
    expect(segments.join('')).toBe(text)
  })
})

describe('mergeSegmentOutputs', () => {
  const entry = (value: unknown, uncertain = false) => ({ value, uncertain })

  it('空段与 null 值由后续段补齐', () => {
    const merged = mergeSegmentOutputs(
      {
        a: entry(null),
        b: entry(null)
      },
      [
        { a: entry(null), b: entry(null) },
        { a: entry('v1'), b: entry('v2') }
      ]
    )
    expect(merged.a).toEqual({ value: 'v1', uncertain: false })
    expect(merged.b).toEqual({ value: 'v2', uncertain: false })
  })

  it('一致的非空值不标 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [{ a: entry('same') }, { a: entry('same') }])
    expect(merged.a).toEqual({ value: 'same', uncertain: false })
  })

  it('冲突值取首个并标 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [{ a: entry('first') }, { a: entry('second') }])
    expect(merged.a).toEqual({ value: 'first', uncertain: true })
  })

  it('array 字段跨段拼接去重', () => {
    const merged = mergeSegmentOutputs({}, [
      { items: entry([{ n: 1 }, { n: 2 }]) },
      { items: entry([{ n: 2 }, { n: 3 }]) }
    ])
    expect(merged.items).toEqual({ value: [{ n: 1 }, { n: 2 }, { n: 3 }], uncertain: false })
  })

  it('首个非空值已 uncertain 时合并结果保持 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [{ a: entry('v', true) }, { a: entry('v', false) }])
    expect(merged.a).toEqual({ value: 'v', uncertain: true })
  })

  it('合并后 base 对象未被修改', () => {
    const base = {
      a: entry('same'),
      items: entry([{ n: 1 }]),
      conflict: entry('base-v')
    }
    const snapshot = JSON.parse(JSON.stringify(base))
    const merged = mergeSegmentOutputs(base, [
      { a: entry('same', true), items: entry([{ n: 2 }]), conflict: entry('partial-v') }
    ])
    expect(base).toEqual(snapshot)
    expect(merged.items.value).not.toBe(base.items.value)
    expect(merged.a).toEqual({ value: 'same', uncertain: true })
    expect(merged.items).toEqual({ value: [{ n: 1 }, { n: 2 }], uncertain: false })
    expect(merged.conflict).toEqual({ value: 'base-v', uncertain: true })
  })

  it('合并后 partials 数组未被污染', () => {
    const first = { items: entry([{ n: 1 }]), tags: entry(['a']) }
    const second = { items: entry([{ n: 2 }]), tags: entry(['b']) }
    const merged = mergeSegmentOutputs({}, [first, second])
    expect(first.items.value).toEqual([{ n: 1 }])
    expect(first.tags.value).toEqual(['a'])
    expect(second.items.value).toEqual([{ n: 2 }])
    expect(second.tags.value).toEqual(['b'])
    expect(merged.items).toEqual({ value: [{ n: 1 }, { n: 2 }], uncertain: false })
    expect(merged.tags).toEqual({ value: ['a', 'b'], uncertain: false })
  })

  it('冲突标 uncertain 不改写原 entry 的 uncertain', () => {
    const baseEntry = entry('base-v')
    const adoptedEntry = entry('partial-v')
    const merged = mergeSegmentOutputs({ a: baseEntry, b: adoptedEntry }, [
      { a: entry('other-v'), b: entry('another-v') }
    ])
    expect(merged.a).toEqual({ value: 'base-v', uncertain: true })
    expect(merged.b).toEqual({ value: 'partial-v', uncertain: true })
    expect(baseEntry.uncertain).toBe(false)
    expect(adoptedEntry.uncertain).toBe(false)
  })
})
