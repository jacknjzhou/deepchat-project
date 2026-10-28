import type { ConceptMetadata } from './knowledgeClient'

/**
 * 知识图谱构建：把概念元数据里的 markdown 链接解析为概念间的边。
 *
 * 语义与 StaffDeck 企业管理台 `knowledgeGraphModel.ts` 保持同源（2026-10-28 对齐），
 * 差异只有两点：这里在服务端已过滤 citations 的 links 上工作（管理台在客户端拿
 * citations 对账）；超上限时按度数截断并回传 `truncated` 标记，管理台只在展示层截。
 */

export const KNOWLEDGE_GRAPH_NODE_LIMIT = 500

const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i

export type ResolvedKnowledgeLink =
  | { kind: 'internal'; conceptId: string }
  | { kind: 'external'; conceptId?: undefined }

/**
 * 把一条 markdown 链接解析成概念 id。
 *
 * - 外部 scheme（`http:`、`mailto:`…）与协议相对地址（`//host`）不是内部概念；
 * - `#`/`?` 之后的锚点与查询串不参与定位；
 * - 相对路径按源概念所在目录解析，`.`/`..` 逐段消解，末段去掉 `.md` 后缀；
 * - 纯锚点链接（`#section`）解析回源概念自身——随后会被自环检查剔除。
 *
 * 解析失败不抛错：畸形 URI 保持原样，作为「不可解析」被丢弃而不是崩掉建图。
 */
export function resolveKnowledgeLink(sourceConceptId: string, rawTarget: string): ResolvedKnowledgeLink {
  const target = rawTarget.trim()
  if (!target || target.startsWith('//') || EXTERNAL_SCHEME.test(target)) {
    return { kind: 'external' }
  }
  let pathname = target.split('#', 1)[0]?.split('?', 1)[0] || ''
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // 保留原文继续走路径解析：解不开的编码按字面文本处理。
  }
  if (!pathname) return { kind: 'internal', conceptId: sourceConceptId }
  const isAbsolute = pathname.startsWith('/')
  const sourceParts = sourceConceptId.split('/').filter(Boolean)
  const parts = isAbsolute ? [] : sourceParts.slice(0, -1)
  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  const lastIndex = parts.length - 1
  if (lastIndex >= 0) parts[lastIndex] = parts[lastIndex].replace(/\.md$/i, '')
  return { kind: 'internal', conceptId: parts.join('/') }
}

export interface KnowledgeGraphConcept {
  conceptId: string
  type: string
  title: string
  description: string
  degree: number
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
}

export interface KnowledgeGraphResult {
  version: string
  /** 概念数超上限被截断时为 true：渲染层据此提示「仅展示核心概念」。 */
  truncated: boolean
  concepts: KnowledgeGraphConcept[]
  edges: KnowledgeGraphEdge[]
}

export function buildKnowledgeGraph(input: {
  version: string
  concepts: ConceptMetadata[]
}): KnowledgeGraphResult {
  const conceptsById = new Map(input.concepts.map((concept) => [concept.conceptId, concept]))
  const edges = new Map<string, KnowledgeGraphEdge>()

  for (const concept of input.concepts) {
    for (const link of concept.links) {
      const resolved = resolveKnowledgeLink(concept.conceptId, link.target)
      if (resolved.kind === 'external') continue
      // 指向不存在概念（尚未创建 / 已删除 / id 变体）的链接不构成边。
      if (!resolved.conceptId || !conceptsById.has(resolved.conceptId)) continue
      // 自环（含纯锚点链接）对图谱没有信息量。
      if (resolved.conceptId === concept.conceptId) continue
      const key = `${concept.conceptId}\u0000${resolved.conceptId}`
      if (edges.has(key)) continue
      edges.set(key, { source: concept.conceptId, target: resolved.conceptId })
    }
  }

  let truncated = false
  let kept = input.concepts
  if (kept.length > KNOWLEDGE_GRAPH_NODE_LIMIT) {
    truncated = true
    // 按度数保留核心概念：抽屉里的图谱本来也画不下全量，丢边远节点保枢纽节点。
    const degreeOf = new Map<string, number>()
    for (const edge of edges.values()) {
      degreeOf.set(edge.source, (degreeOf.get(edge.source) ?? 0) + 1)
      degreeOf.set(edge.target, (degreeOf.get(edge.target) ?? 0) + 1)
    }
    kept = [...kept]
      .sort(
        (left, right) =>
          (degreeOf.get(right.conceptId) ?? 0) - (degreeOf.get(left.conceptId) ?? 0) ||
          left.conceptId.localeCompare(right.conceptId)
      )
      .slice(0, KNOWLEDGE_GRAPH_NODE_LIMIT)
  }
  const keptIds = new Set(kept.map((concept) => concept.conceptId))

  const degree = new Map<string, number>()
  const keptEdges: KnowledgeGraphEdge[] = []
  for (const edge of edges.values()) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    keptEdges.push(edge)
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  return {
    version: input.version,
    truncated,
    concepts: kept.map((concept) => ({
      conceptId: concept.conceptId,
      type: concept.type,
      title: concept.title,
      description: concept.description,
      degree: degree.get(concept.conceptId) ?? 0
    })),
    edges: keptEdges
  }
}
