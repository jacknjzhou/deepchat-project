<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent
      v-if="employee && open"
      side="right"
      class="w-[440px] gap-0 sm:max-w-[440px]"
      data-testid="digital-employee-detail-sheet"
    >
      <SheetHeader class="border-b pr-12">
        <SheetTitle class="text-base leading-snug">
          {{ employee.name }} · {{ employee.role }}
        </SheetTitle>
        <SheetDescription class="text-xs leading-relaxed">
          {{ employee.description }}
        </SheetDescription>
      </SheetHeader>
      <div class="flex-1 space-y-6 overflow-y-auto px-5 py-5 pb-8">
        <!-- 概要：执行模式 + 能力标签 + 未初始化提示 -->
        <section data-testid="detail-overview" class="space-y-2.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="rounded-md px-2 py-0.5 text-[11px] font-medium"
              :class="
                employee.executionMode === 'remote'
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground'
              "
              >{{
                employee.executionMode === 'remote'
                  ? t('digitalEmployee.remote.badge')
                  : t('digitalEmployee.local.badge')
              }}</span
            >
            <span
              v-for="capability in employee.capabilities"
              :key="capability"
              class="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
              >{{ capability }}</span
            >
          </div>
          <p
            v-if="showNotProvisioned"
            class="rounded-md bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
            data-testid="detail-not-provisioned"
          >
            {{ t('digitalEmployee.detail.notProvisioned') }}
          </p>
        </section>

        <!-- SOP：全文折叠列表（不受执行链路 600 字截断限制，那是提示词注入的事） -->
        <section data-testid="detail-sops" class="space-y-2">
          <h3 class="text-[11px] font-semibold tracking-wide text-muted-foreground">
            {{ t('digitalEmployee.sectionSops') }}
          </h3>
          <p v-if="employee.sops.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySops') }}
          </p>
          <details
            v-for="sop in employee.sops"
            :key="sop.title"
            class="group rounded-lg border border-border/60 bg-muted/20 open:bg-transparent"
          >
            <summary
              class="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-xs font-medium select-none [&::-webkit-details-marker]:hidden"
            >
              <Icon
                icon="lucide:chevron-right"
                class="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              />
              <span class="truncate">{{ sop.title }}</span>
            </summary>
            <p
              class="border-t border-border/40 px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
              :data-testid="`detail-sop-content-${sop.title}`"
            >
              {{ sop.content }}
            </p>
          </details>
        </section>

        <!-- 知识库：包级状态卡 -->
        <section data-testid="detail-knowledge" class="space-y-2">
          <h3 class="text-[11px] font-semibold tracking-wide text-muted-foreground">
            {{ t('digitalEmployee.sectionKnowledge') }}
          </h3>
          <p v-if="employee.knowledgeBaseIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyKnowledge') }}
          </p>
          <p
            v-else-if="knowledgePackages.length === 0"
            class="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground"
            data-testid="detail-knowledge-unavailable"
          >
            {{ t('digitalEmployee.detail.knowledgeUnavailable') }}
          </p>
          <template v-else>
            <div
              v-for="pkg in knowledgePackages"
              :key="pkg.knowledgeBaseId"
              class="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs"
              :data-testid="`detail-knowledge-${pkg.knowledgeBaseId}`"
            >
              <div class="flex items-center justify-between gap-2">
                <!-- 目录端点拉到名称就显示名称，否则退回远端 id（端点未上线是常态）。 -->
                <span class="truncate font-medium">{{ pkg.name || pkg.knowledgeBaseId }}</span>
                <span
                  class="shrink-0"
                  :class="pkg.stale ? 'text-amber-600' : 'text-emerald-600'"
                  data-testid="detail-knowledge-badge"
                >
                  {{
                    pkg.stale
                      ? t('digitalEmployee.detail.knowledgeStale', {
                          reason: pkg.staleReason ?? '-'
                        })
                      : t('digitalEmployee.detail.knowledgeFresh')
                  }}
                </span>
              </div>
              <p v-if="pkg.description" class="mt-0.5 text-muted-foreground">
                {{ pkg.description }}
              </p>
              <p class="mt-1 text-muted-foreground">
                {{
                  t('digitalEmployee.detail.knowledgeMeta', {
                    count: pkg.conceptCount,
                    time: formatSyncTime(pkg.lastSyncAt)
                  })
                }}
              </p>

              <!-- 知识图谱与概念明细：undefined=加载中，null=不可用，空概念=空态 -->
              <div class="mt-2.5 border-t border-border/40 pt-2.5">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-[11px] font-medium text-muted-foreground">
                    {{ t('digitalEmployee.detail.graphTitle') }}
                  </p>
                  <span
                    v-if="graphFor(pkg.knowledgeBaseId)?.truncated"
                    class="text-[10px] text-amber-600"
                    data-testid="detail-graph-truncated"
                  >
                    {{ t('digitalEmployee.detail.graphTruncated') }}
                  </span>
                </div>
                <p
                  v-if="!knowledgeGraphs.has(pkg.knowledgeBaseId)"
                  class="py-3 text-center text-muted-foreground"
                  :data-testid="`detail-graph-loading-${pkg.knowledgeBaseId}`"
                >
                  {{ t('digitalEmployee.detail.graphLoading') }}
                </p>
                <p
                  v-else-if="graphFor(pkg.knowledgeBaseId) === null"
                  class="py-3 text-center text-muted-foreground"
                  :data-testid="`detail-graph-unavailable-${pkg.knowledgeBaseId}`"
                >
                  {{ t('digitalEmployee.detail.graphUnavailable') }}
                </p>
                <p
                  v-else-if="conceptsFor(pkg.knowledgeBaseId).length === 0"
                  class="py-3 text-center text-muted-foreground"
                  :data-testid="`detail-graph-empty-${pkg.knowledgeBaseId}`"
                >
                  {{ t('digitalEmployee.detail.graphEmpty') }}
                </p>
                <template v-else>
                  <!-- 概念明细：按关联度排序，点击展开正文（按需拉取、缓存） -->
                  <div
                    class="mt-1.5 space-y-1"
                    :data-testid="`detail-concept-list-${pkg.knowledgeBaseId}`"
                  >
                    <div
                      v-for="concept in conceptsFor(pkg.knowledgeBaseId)"
                      :key="concept.conceptId"
                      class="rounded-md border border-border/40 bg-background/60"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-1.5 px-2.5 py-2 text-left select-none"
                        :data-testid="`detail-concept-${concept.conceptId}`"
                        @click="toggleConcept(pkg.knowledgeBaseId, concept.conceptId)"
                      >
                        <Icon
                          icon="lucide:chevron-right"
                          class="size-3.5 shrink-0 text-muted-foreground transition-transform"
                          :class="{
                            'rotate-90': isConceptExpanded(
                              pkg.knowledgeBaseId,
                              concept.conceptId
                            )
                          }"
                        />
                        <span class="truncate font-medium">{{ concept.title }}</span>
                        <span
                          class="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
                        >
                          <span class="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5">
                            {{ concept.type }}
                          </span>
                          <span>
                            {{ t('digitalEmployee.detail.conceptDegree', { degree: concept.degree }) }}
                          </span>
                        </span>
                      </button>
                      <div
                        v-if="isConceptExpanded(pkg.knowledgeBaseId, concept.conceptId)"
                        class="border-t border-border/40 px-2.5 py-2"
                      >
                        <p
                          v-if="isConceptLoading(pkg.knowledgeBaseId, concept.conceptId)"
                          class="text-muted-foreground"
                          :data-testid="`detail-concept-loading-${concept.conceptId}`"
                        >
                          {{ t('digitalEmployee.detail.conceptLoading') }}
                        </p>
                        <p
                          v-else-if="conceptContent(pkg.knowledgeBaseId, concept.conceptId) === null"
                          class="text-muted-foreground"
                          :data-testid="`detail-concept-unavailable-${concept.conceptId}`"
                        >
                          {{ t('digitalEmployee.detail.conceptUnavailable') }}
                        </p>
                        <pre
                          v-else
                          class="font-sans text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
                          :data-testid="`detail-concept-content-${concept.conceptId}`"
                          >{{ conceptContent(pkg.knowledgeBaseId, concept.conceptId) }}</pre
                        >
                      </div>
                    </div>
                  </div>
                  <!-- 图谱：内环枢纽 + 外环叶子，纯几何布局，节点大小随关联度 -->
                  <svg
                    class="mt-2 w-full"
                    :viewBox="`0 0 ${GRAPH_VIEW_W} ${GRAPH_VIEW_H}`"
                    :data-testid="`detail-knowledge-graph-${pkg.knowledgeBaseId}`"
                  >
                    <line
                      v-for="(edge, index) in graphLayoutFor(pkg.knowledgeBaseId).edges"
                      :key="`edge-${index}`"
                      :x1="edge.x1"
                      :y1="edge.y1"
                      :x2="edge.x2"
                      :y2="edge.y2"
                      stroke="currentColor"
                      class="text-muted-foreground/40"
                      stroke-width="1"
                    />
                    <g v-for="node in graphLayoutFor(pkg.knowledgeBaseId).nodes" :key="node.id">
                      <circle :cx="node.x" :cy="node.y" :r="node.r" :fill="node.color" fill-opacity="0.85">
                        <title>{{ node.title }}</title>
                      </circle>
                      <text
                        v-if="node.showLabel"
                        :x="node.x"
                        :y="node.y - node.r - 4"
                        text-anchor="middle"
                        font-size="9"
                        fill="currentColor"
                        class="text-muted-foreground"
                      >
                        {{ node.label }}
                      </text>
                    </g>
                  </svg>
                </template>
              </div>
            </div>
          </template>
        </section>

        <!-- 技能：服务端定义（有明细展示名称，无明细回退 id）+ 本地安装状态 -->
        <section data-testid="detail-skills" class="space-y-2">
          <h3 class="text-[11px] font-semibold tracking-wide text-muted-foreground">
            {{ t('digitalEmployee.sectionSkills') }}
          </h3>
          <p v-if="employee.skillIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySkills') }}
          </p>
          <ul v-else class="space-y-1.5">
            <li
              v-for="(skill, index) in employee.skills ?? []"
              :key="`detail-${skill.id}`"
              class="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
            >
              <p class="truncate text-xs font-medium">{{ skill.name }}</p>
              <p class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                {{ skill.id }}
              </p>
              <p
                v-if="descriptionForSkill(index)"
                class="mt-1 text-xs leading-relaxed text-muted-foreground"
                :data-testid="`detail-skill-description-${skill.id}`"
              >
                {{ descriptionForSkill(index) }}
              </p>
            </li>
            <li
              v-for="id in skillIdsWithoutDetail"
              :key="id"
              class="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
            >
              <p class="truncate font-mono text-[11px] text-muted-foreground">{{ id }}</p>
            </li>
          </ul>
          <p
            v-if="provisionResult?.skillNames.length"
            class="rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-600"
            data-testid="detail-installed-skills"
          >
            {{
              t('digitalEmployee.provision.installedSkills', {
                skills: provisionResult.skillNames.join('、')
              })
            }}
          </p>
          <ul
            v-if="provisionResult?.failedSkills.length"
            class="list-disc space-y-1 pl-4 text-xs text-destructive"
            data-testid="detail-failed-skills"
          >
            <li v-for="slug in provisionResult.failedSkills" :key="slug">
              {{ slug }}：{{ provisionResult.failureReasons[slug] ?? '' }}
            </li>
          </ul>
        </section>

        <!-- 工具：名单 + provision 就绪状态 -->
        <section data-testid="detail-tools" class="space-y-2">
          <h3 class="text-[11px] font-semibold tracking-wide text-muted-foreground">
            {{ t('digitalEmployee.sectionTools') }}
          </h3>
          <p v-if="employee.tools.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyTools') }}
          </p>
          <div v-else class="flex flex-wrap gap-1.5">
            <span
              v-for="tool in employee.tools"
              :key="tool"
              class="max-w-full truncate rounded-md border border-border/60 bg-muted/20 px-2 py-1 font-mono text-[11px] text-muted-foreground"
              >{{ tool }}</span
            >
          </div>
          <div
            v-if="provisionResult"
            class="flex flex-wrap gap-2"
            data-testid="detail-tool-readiness"
          >
            <span
              class="rounded-md px-2 py-0.5 text-[11px] font-medium"
              :class="
                provisionResult.toolsReady
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive'
              "
            >
              {{
                t(
                  provisionResult.toolsReady
                    ? 'digitalEmployee.detail.toolsReady'
                    : 'digitalEmployee.detail.toolsNotReady'
                )
              }}
            </span>
            <span
              v-if="employee.knowledgeBaseIds.length > 0"
              class="rounded-md px-2 py-0.5 text-[11px] font-medium"
              :class="
                provisionResult.knowledgeToolReady
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-destructive/10 text-destructive'
              "
            >
              {{
                t(
                  provisionResult.knowledgeToolReady
                    ? 'digitalEmployee.detail.knowledgeToolReady'
                    : 'digitalEmployee.detail.knowledgeToolNotReady'
                )
              }}
            </span>
          </div>
        </section>
      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@shadcn/components/ui/sheet'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import type { DigitalEmployeeProvisionResult } from '@shared/contracts/routes'
import type {
  DigitalEmployee,
  DigitalEmployeeKnowledgeGraph,
  KnowledgeConceptMeta,
  KnowledgePackageStatus
} from '@shared/contracts/routes'

const props = defineProps<{
  employee: DigitalEmployee | null
  provisionResult: DigitalEmployeeProvisionResult | null
  open: boolean
}>()

const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const store = useDigitalEmployeeStore()

const knowledgePackages = ref<KnowledgePackageStatus[]>([])
/** kbId → 图谱；undefined=加载中，null=整包不可用（端点未上线/网络失败）。 */
const knowledgeGraphs = ref<Map<string, DigitalEmployeeKnowledgeGraph | null>>(new Map())
const skillDescriptions = ref<Map<string, string>>(new Map())
// 概念正文缓存与展开态：key = `${kbId}::${conceptId}`，null=本地+远端都拿不到
const conceptContents = ref<Map<string, string | null>>(new Map())
const expandedConceptKeys = ref<Set<string>>(new Set())
const loadingConceptKeys = ref<Set<string>>(new Set())

/**
 * 只读视图：打开时按需拉一次知识包状态、知识图谱与本地技能元数据，员工切换
 * 时重拉。结果回来时若员工已切换则直接丢弃，避免串显上一家的数据。
 * 绝不触发 provision——那是有副作用的准备动作，只读详情不代用户执行。
 */
watch(
  () => [props.open, props.employee?.id] as const,
  async ([open, id]) => {
    if (!open || !props.employee || !id) return
    // 未绑定知识库就不发状态请求：请求必空，只会把空态渲染成「获取失败」。
    if (props.employee.knowledgeBaseIds.length === 0) {
      knowledgePackages.value = []
      knowledgeGraphs.value = new Map()
      resetConceptState()
    } else {
      resetConceptState()
      const baseIds = props.employee.knowledgeBaseIds
      // 状态与图谱并行拉取；图谱失败收敛为 null → 卡片内显示「暂不可用」。
      const [packages, graphs] = await Promise.all([
        store.listKnowledgePackages(id),
        Promise.all(baseIds.map((kbId) => store.fetchKnowledgeGraph(id, kbId)))
      ])
      if (props.employee.id !== id) return
      knowledgePackages.value = packages
      const graphMap = new Map<string, DigitalEmployeeKnowledgeGraph | null>()
      baseIds.forEach((kbId, index) => graphMap.set(kbId, graphs[index]))
      knowledgeGraphs.value = graphMap
    }
    const skills = await store.listLocalSkillMetadata()
    if (props.employee.id !== id) return
    skillDescriptions.value = new Map(skills.map((skill) => [skill.name, skill.description]))
  },
  { immediate: true }
)

function resetConceptState(): void {
  conceptContents.value = new Map()
  expandedConceptKeys.value = new Set()
  loadingConceptKeys.value = new Set()
}

function graphFor(knowledgeBaseId: string): DigitalEmployeeKnowledgeGraph | null | undefined {
  return knowledgeGraphs.value.get(knowledgeBaseId)
}

/** 概念按关联度降序、同度数按标题稳定排序，枢纽概念排前面。 */
function conceptsFor(knowledgeBaseId: string): KnowledgeConceptMeta[] {
  const graph = knowledgeGraphs.value.get(knowledgeBaseId)
  if (!graph) return []
  return [...graph.concepts].sort(
    (left, right) => right.degree - left.degree || left.title.localeCompare(right.title)
  )
}

const conceptKey = (knowledgeBaseId: string, conceptId: string): string =>
  `${knowledgeBaseId}::${conceptId}`
const isConceptExpanded = (knowledgeBaseId: string, conceptId: string): boolean =>
  expandedConceptKeys.value.has(conceptKey(knowledgeBaseId, conceptId))
const isConceptLoading = (knowledgeBaseId: string, conceptId: string): boolean =>
  loadingConceptKeys.value.has(conceptKey(knowledgeBaseId, conceptId))
const conceptContent = (knowledgeBaseId: string, conceptId: string): string | null | undefined =>
  conceptContents.value.get(conceptKey(knowledgeBaseId, conceptId))

/** 展开/收起概念正文；首次展开时按需拉一次正文并缓存。 */
async function toggleConcept(knowledgeBaseId: string, conceptId: string): Promise<void> {
  const key = conceptKey(knowledgeBaseId, conceptId)
  const next = new Set(expandedConceptKeys.value)
  if (next.has(key)) {
    next.delete(key)
    expandedConceptKeys.value = next
    return
  }
  next.add(key)
  expandedConceptKeys.value = next
  if (conceptContents.value.has(key) || loadingConceptKeys.value.has(key)) return
  const employeeId = props.employee?.id
  if (!employeeId) return
  const loading = new Set(loadingConceptKeys.value)
  loading.add(key)
  loadingConceptKeys.value = loading
  const result = await store.fetchKnowledgeConcept(employeeId, knowledgeBaseId, conceptId)
  if (props.employee?.id !== employeeId) return
  const contents = new Map(conceptContents.value)
  contents.set(key, result.content)
  conceptContents.value = contents
  const done = new Set(loadingConceptKeys.value)
  done.delete(key)
  loadingConceptKeys.value = done
}

// —— 图谱紧凑布局：内环枢纽、外环叶子，纯几何、位置稳定（无力导向）。 ——
const GRAPH_VIEW_W = 400
const GRAPH_VIEW_H = 240
const GRAPH_NODES_PER_RING = 26
const NODE_PALETTE = [
  '#0ea5e9',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#6366f1',
  '#ec4899',
  '#14b8a6'
]

interface GraphLayoutNode {
  id: string
  title: string
  label: string
  x: number
  y: number
  r: number
  color: string
  showLabel: boolean
}
interface GraphLayout {
  nodes: GraphLayoutNode[]
  edges: { x1: number; y1: number; x2: number; y2: number }[]
}

const EMPTY_GRAPH_LAYOUT: GraphLayout = { nodes: [], edges: [] }

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

/**
 * 内环放枢纽概念（度数 >= 3，唯一枢纽居中），叶子按每环 26 个向外铺开；
 * 节点半径随度数增长。只依赖数据本身，每次打开位置一致。
 */
function buildGraphLayout(graph: NonNullable<DigitalEmployeeKnowledgeGraph>): GraphLayout {
  const centerX = GRAPH_VIEW_W / 2
  const centerY = GRAPH_VIEW_H / 2
  const maxRadius = Math.min(GRAPH_VIEW_W, GRAPH_VIEW_H) / 2 - 14
  const nodes = [...graph.concepts].sort(
    (left, right) => right.degree - left.degree || left.conceptId.localeCompare(right.conceptId)
  )
  const positions = new Map<string, { x: number; y: number }>()
  const hubs = nodes.filter((node) => node.degree >= 3)
  const leaves = nodes.filter((node) => node.degree < 3)

  const hubRing = hubs.length > 1 ? Math.min(24 + hubs.length * 2, maxRadius * 0.45) : 0
  hubs.forEach((node, index) => {
    if (hubs.length === 1) {
      positions.set(node.conceptId, { x: centerX, y: centerY })
      return
    }
    const angle = (index / hubs.length) * Math.PI * 2 - Math.PI / 2
    positions.set(node.conceptId, {
      x: centerX + hubRing * Math.cos(angle),
      y: centerY + hubRing * Math.sin(angle)
    })
  })

  const leafRingCount = Math.max(1, Math.ceil(leaves.length / GRAPH_NODES_PER_RING))
  const leafStart = hubs.length > 0 ? hubRing + 30 : maxRadius * 0.45
  const leafStep = leafRingCount > 1 ? (maxRadius - leafStart) / (leafRingCount - 1) : 0
  for (let ring = 0; ring < leafRingCount; ring += 1) {
    const batch = leaves.slice(ring * GRAPH_NODES_PER_RING, (ring + 1) * GRAPH_NODES_PER_RING)
    const radius = Math.min(leafStart + ring * leafStep, maxRadius)
    batch.forEach((node, index) => {
      const angle = (index / batch.length) * Math.PI * 2 - Math.PI / 2
      positions.set(node.conceptId, {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle)
      })
    })
  }

  // 节点少时全标，多时只标枢纽，避免 440px 抽屉里标签糊成一片。
  const labelAll = nodes.length <= 15
  const layoutNodes: GraphLayoutNode[] = nodes.map((node) => {
    const at = positions.get(node.conceptId) ?? { x: centerX, y: centerY }
    return {
      id: node.conceptId,
      title: node.title,
      label: node.title.length > 16 ? `${node.title.slice(0, 15)}…` : node.title,
      x: at.x,
      y: at.y,
      r: 3 + Math.min(node.degree, 10) * 0.6,
      color: NODE_PALETTE[hashString(node.type) % NODE_PALETTE.length],
      showLabel: labelAll || node.degree >= 4
    }
  })
  const layoutEdges = graph.edges.flatMap((edge) => {
    const from = positions.get(edge.source)
    const to = positions.get(edge.target)
    if (!from || !to) return []
    return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y }]
  })
  return { nodes: layoutNodes, edges: layoutEdges }
}

const graphLayouts = computed(() => {
  const layouts = new Map<string, GraphLayout>()
  for (const [kbId, graph] of knowledgeGraphs.value) {
    if (graph && graph.concepts.length > 0) layouts.set(kbId, buildGraphLayout(graph))
  }
  return layouts
})
function graphLayoutFor(knowledgeBaseId: string): GraphLayout {
  return graphLayouts.value.get(knowledgeBaseId) ?? EMPTY_GRAPH_LAYOUT
}

const skillDetailIds = computed(
  () => new Set((props.employee?.skills ?? []).map((skill) => skill.id))
)
const skillIdsWithoutDetail = computed(() =>
  (props.employee?.skillIds ?? []).filter((id) => !skillDetailIds.value.has(id))
)

/**
 * 服务端技能明细行 ↔ 本地安装名按位置配对：provision 的 skillNames 与服务端
 * skills 同源同序（都是 resolved.skills 逐项派生），不需要在渲染侧重现
 * 员工前缀命名规则。未安装/位置对不上时返回空，行内退化为不显示描述。
 */
const descriptionForSkill = (index: number): string => {
  const localName = props.provisionResult?.skillNames[index]
  if (!localName) return ''
  return skillDescriptions.value.get(localName) ?? ''
}

// remote 员工本来就不在本地准备，「未初始化」提示只对本地员工有意义。
const showNotProvisioned = computed(
  () =>
    props.employee !== null &&
    props.employee.executionMode !== 'remote' &&
    props.provisionResult === null
)

// lastSyncAt 是 ISO 字符串；解析不了就显示占位，与 store 的解析纪律一致。
const formatSyncTime = (lastSyncAt: string): string => {
  const parsed = Date.parse(lastSyncAt)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '—'
}
</script>
