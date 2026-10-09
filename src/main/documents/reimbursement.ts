import type { ReimbursementConfig } from '@shared/contracts/routes'
import { REIMBURSEMENT_UNASSIGNED, type DocumentRecord } from '@shared/documents'

export { REIMBURSEMENT_UNASSIGNED }

export const REIMBURSEMENT_TREE_MAX_DOCUMENTS = 5000

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = asText(item)
      if (text) return text
    }
  }
  return null
}

export function extractFieldValue(
  fields: DocumentRecord['fields'],
  keys: string[]
): { value: unknown; uncertain: boolean } | null {
  for (const key of keys) {
    const entry = fields[key]
    if (!entry || entry.value === null || entry.value === undefined) continue
    if (Array.isArray(entry.value) && entry.value.length === 0) continue
    return entry
  }
  return null
}

const PERIOD_RE = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/

export function parsePeriodValue(value: unknown): string | null {
  const text = asText(value)
  if (!text) return null
  const match = PERIOD_RE.exec(text)
  if (!match) return null
  const [, year, month, day] = match
  const pad = (part: string) => part.padStart(2, '0')
  return day ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}`
}

export interface CategoryResolution {
  categoryId: string | null
  isOverride: boolean
}

export function resolveDocumentCategoryId(
  document: Pick<DocumentRecord, 'typeKey' | 'reimbursementOverride'>,
  config: ReimbursementConfig
): CategoryResolution {
  const override = document.reimbursementOverride
  if (override === REIMBURSEMENT_UNASSIGNED) return { categoryId: null, isOverride: true }
  if (override && config.categories.some((c) => c.id === override)) {
    return { categoryId: override, isOverride: true }
  }
  const mapped = config.categories
    .filter((c) => c.linkedTypeKeys.includes(document.typeKey))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0]
  return { categoryId: mapped?.id ?? null, isOverride: false }
}

export function personFor(document: DocumentRecord, config: ReimbursementConfig): string | null {
  const entry = extractFieldValue(document.fields, config.personFieldKeys)
  return entry ? asText(entry.value) : null
}

export function periodFor(
  document: DocumentRecord,
  config: ReimbursementConfig,
  grouping: 'day' | 'month' = config.dateGrouping
): string | null {
  const entry = extractFieldValue(document.fields, config.dateFieldKeys)
  const parsed = entry ? parsePeriodValue(entry.value) : null
  if (!parsed) return null
  return grouping === 'day' ? parsed : parsed.slice(0, 7)
}

export function amountFor(
  document: DocumentRecord,
  config: ReimbursementConfig
): { amount: number | null; uncertain: boolean } {
  const entry = extractFieldValue(document.fields, config.amountFieldKeys)
  if (!entry) return { amount: null, uncertain: false }
  const raw = entry.value
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.replace(/[,，\s元]/g, ''))
        : NaN
  return { amount: Number.isFinite(numeric) ? numeric : null, uncertain: entry.uncertain }
}

export function uncertainCountFor(document: DocumentRecord): number {
  return Object.values(document.fields).filter((entry) => entry.uncertain).length
}

export interface ReimbursementDocumentEntry {
  id: string
  typeKey: string
  templateName: string
  person: string | null
  period: string | null
  amount: number | null
  amountUncertain: boolean
  uncertainCount: number
  fileNames: string[]
  isOverride: boolean
}

export interface ReimbursementBucket {
  period: string | null
  documents: ReimbursementDocumentEntry[]
}

export interface ReimbursementGroup {
  person: string | null
  buckets: ReimbursementBucket[]
}

export interface ReimbursementCategoryNode {
  category: ReimbursementConfig['categories'][number]
  total: number
  materials: Array<{ name: string; linkedTypeKeys: string[]; count: number }>
  groups: ReimbursementGroup[]
}

export interface ReimbursementTreeResult {
  tree: ReimbursementCategoryNode[]
  unassigned: ReimbursementGroup[]
  summary: Array<{ categoryId: string | null; total: number }>
}

const basename = (uri: string): string => {
  const normalized = uri.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || uri
}

const toEntry = (
  document: DocumentRecord,
  config: ReimbursementConfig,
  templateNameById: Map<string, string>,
  isOverride: boolean
): ReimbursementDocumentEntry => {
  const amount = amountFor(document, config)
  return {
    id: document.id,
    typeKey: document.typeKey,
    templateName: templateNameById.get(document.templateId) ?? document.typeKey,
    person: personFor(document, config),
    period: periodFor(document, config),
    amount: amount.amount,
    amountUncertain: amount.uncertain,
    uncertainCount: uncertainCountFor(document),
    fileNames: document.fileUris.map(basename),
    isOverride
  }
}

const PERSON_UNKNOWN = null

function groupByPersonAndPeriod(entries: ReimbursementDocumentEntry[]): ReimbursementGroup[] {
  const byPerson = new Map<string | null, ReimbursementDocumentEntry[]>()
  for (const entry of entries) {
    const list = byPerson.get(entry.person) ?? []
    list.push(entry)
    byPerson.set(entry.person, list)
  }
  const groups: ReimbursementGroup[] = []
  for (const [person, list] of byPerson) {
    const byPeriod = new Map<string | null, ReimbursementDocumentEntry[]>()
    for (const entry of list) {
      const bucket = byPeriod.get(entry.period) ?? []
      bucket.push(entry)
      byPeriod.set(entry.period, bucket)
    }
    const buckets: ReimbursementBucket[] = [...byPeriod.entries()]
      .map(([period, docs]) => ({ period, documents: docs }))
      .sort((a, b) => {
        if (a.period === null) return 1
        if (b.period === null) return -1
        return b.period.localeCompare(a.period)
      })
    groups.push({ person, buckets })
  }
  return groups.sort((a, b) => {
    if (a.person === PERSON_UNKNOWN) return 1
    if (b.person === PERSON_UNKNOWN) return -1
    return (a.person ?? '').localeCompare(b.person ?? '', 'zh-Hans-CN')
  })
}

export function buildReimbursementTree(
  documents: DocumentRecord[],
  config: ReimbursementConfig,
  templateNameById: Map<string, string>
): ReimbursementTreeResult {
  const unassignedEntries: ReimbursementDocumentEntry[] = []
  const entriesByCategory = new Map<string, ReimbursementDocumentEntry[]>()
  const summary = new Map<string | null, number>()

  for (const document of documents) {
    const { categoryId, isOverride } = resolveDocumentCategoryId(document, config)
    const entry = toEntry(document, config, templateNameById, isOverride)
    summary.set(categoryId, (summary.get(categoryId) ?? 0) + 1)
    if (categoryId === null) {
      unassignedEntries.push(entry)
    } else {
      const list = entriesByCategory.get(categoryId) ?? []
      list.push(entry)
      entriesByCategory.set(categoryId, list)
    }
  }

  const tree: ReimbursementCategoryNode[] = config.categories.map((category) => {
    const entries = entriesByCategory.get(category.id) ?? []
    return {
      category,
      total: entries.length,
      materials: category.requiredMaterials.map((material) => ({
        name: material.name,
        linkedTypeKeys: material.linkedTypeKeys,
        count: entries.filter((entry) => material.linkedTypeKeys.includes(entry.typeKey)).length
      })),
      groups: groupByPersonAndPeriod(entries)
    }
  })

  return {
    tree,
    unassigned: groupByPersonAndPeriod(unassignedEntries),
    summary: [
      ...tree.map((node) => ({ categoryId: node.category.id, total: node.total })),
      { categoryId: null, total: summary.get(null) ?? 0 }
    ]
  }
}
