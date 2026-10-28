import { describe, expect, it } from 'vitest'
import { buildKnowledgeGraph, resolveKnowledgeLink } from '../../../src/main/digital-employee/knowledgeGraph'
import type { ConceptMetadata } from '../../../src/main/digital-employee/knowledgeClient'

/**
 * 图谱构建语义与 StaffDeck 企业管理台 `knowledgeGraphModel.ts` 同源：
 * 相对路径解析、外部链接忽略、自环/重复边剔除、度数统计。这里固化的是
 * 契约承诺的行为——renderer 拿到的 edges 就是「按这些规则清洗后的事实」。
 */

const concept = (conceptId: string, links: Array<{ label?: string; target: string }>): ConceptMetadata => ({
  conceptId,
  type: 'term',
  title: conceptId,
  description: '',
  links: links.map((link) => ({ label: link.label ?? '', target: link.target }))
})

describe('resolveKnowledgeLink', () => {
  it('resolves sibling and parent-relative paths like the management console', () => {
    expect(resolveKnowledgeLink('sources/doc/sections/sec-1', './glossary.md')).toEqual({
      kind: 'internal',
      conceptId: 'sources/doc/sections/glossary'
    })
    expect(resolveKnowledgeLink('sources/doc/sections/sec-1', '../../glossary')).toEqual({
      kind: 'internal',
      conceptId: 'sources/glossary'
    })
    expect(resolveKnowledgeLink('sources/doc/sec-1', '/policies/leave')).toEqual({
      kind: 'internal',
      conceptId: 'policies/leave'
    })
  })

  it('strips anchors and queries, and tolerates encoded segments', () => {
    expect(resolveKnowledgeLink('a/b', 'c.md#anchor')).toEqual({ kind: 'internal', conceptId: 'a/c' })
    expect(resolveKnowledgeLink('a/b', 'c?x=1')).toEqual({ kind: 'internal', conceptId: 'a/c' })
    expect(resolveKnowledgeLink('a/b', 'c%20d.md')).toEqual({ kind: 'internal', conceptId: 'a/c d' })
  })

  it('treats external schemes, protocol-relative and empty targets as external', () => {
    expect(resolveKnowledgeLink('a', 'https://example.com')).toEqual({ kind: 'external' })
    expect(resolveKnowledgeLink('a', 'mailto:x@y.z')).toEqual({ kind: 'external' })
    expect(resolveKnowledgeLink('a', '//cdn.example.com/x')).toEqual({ kind: 'external' })
    expect(resolveKnowledgeLink('a', '')).toEqual({ kind: 'external' })
  })

  it('never throws on malformed encodings', () => {
    expect(resolveKnowledgeLink('a/b', 'c%zz.md')).toEqual({ kind: 'internal', conceptId: 'a/c%zz' })
  })
})

describe('buildKnowledgeGraph', () => {
  it('builds edges from internal links and drops self-loops, duplicates and unresolved targets', () => {
    const result = buildKnowledgeGraph({
      version: 'v1',
      concepts: [
        concept('a', [
          { label: 'to b', target: 'b.md' },
          { label: 'dup', target: 'b' },
          { label: 'self', target: '#anchor' },
          { label: 'ghost', target: 'missing.md' },
          { label: 'web', target: 'https://example.com' }
        ]),
        concept('b', [{ label: 'back', target: 'a.md' }]),
        concept('c', [])
      ]
    })

    expect(result.truncated).toBe(false)
    expect(result.edges).toEqual([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }
    ])
    const byId = new Map(result.concepts.map((entry) => [entry.conceptId, entry]))
    expect(byId.get('a')?.degree).toBe(2)
    expect(byId.get('b')?.degree).toBe(2)
    // 孤立概念保留在列表里（有正文可看），只是度为 0。
    expect(byId.get('c')?.degree).toBe(0)
  })

  it('keeps hub concepts and flags truncation past the node limit', async () => {
    const { KNOWLEDGE_GRAPH_NODE_LIMIT } = await import(
      '../../../src/main/digital-employee/knowledgeGraph'
    )
    // 中心节点连向所有叶子；叶子再多也挤不掉中心。
    const hub = concept('hub', Array.from({ length: KNOWLEDGE_GRAPH_NODE_LIMIT + 10 }, (_, i) => ({
      target: `leaf-${i}.md`
    })))
    const leaves = Array.from({ length: KNOWLEDGE_GRAPH_NODE_LIMIT + 10 }, (_, i) =>
      concept(`leaf-${i}`, [])
    )
    const result = buildKnowledgeGraph({ version: 'v1', concepts: [hub, ...leaves] })

    expect(result.truncated).toBe(true)
    expect(result.concepts).toHaveLength(KNOWLEDGE_GRAPH_NODE_LIMIT)
    expect(result.concepts[0].conceptId).toBe('hub')
    expect(result.edges.every((edge) => edge.source === 'hub')).toBe(true)
  })
})
