<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent
      v-if="employee && open"
      side="right"
      class="w-[440px] overflow-y-auto sm:max-w-[440px]"
      data-testid="digital-employee-detail-sheet"
    >
      <SheetHeader>
        <SheetTitle>{{ employee.name }} · {{ employee.role }}</SheetTitle>
        <SheetDescription>{{ employee.description }}</SheetDescription>
      </SheetHeader>
      <div class="space-y-5 text-sm">
        <!-- 概要：执行模式 + 能力标签 + 未初始化提示 -->
        <section data-testid="detail-overview" class="space-y-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
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
              class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >{{ capability }}</span
            >
          </div>
          <p
            v-if="showNotProvisioned"
            class="text-xs text-muted-foreground"
            data-testid="detail-not-provisioned"
          >
            {{ t('digitalEmployee.detail.notProvisioned') }}
          </p>
        </section>

        <!-- SOP：全文折叠列表（不受执行链路 600 字截断限制，那是提示词注入的事） -->
        <section data-testid="detail-sops" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionSops') }}
          </h3>
          <p v-if="employee.sops.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySops') }}
          </p>
          <details
            v-for="sop in employee.sops"
            :key="sop.title"
            class="rounded-md border border-border/60 p-2"
          >
            <summary class="cursor-pointer text-xs font-medium">{{ sop.title }}</summary>
            <p
              class="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"
              :data-testid="`detail-sop-content-${sop.title}`"
            >
              {{ sop.content }}
            </p>
          </details>
        </section>

        <!-- 知识库：包级状态卡 -->
        <section data-testid="detail-knowledge" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionKnowledge') }}
          </h3>
          <p v-if="employee.knowledgeBaseIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyKnowledge') }}
          </p>
          <p
            v-else-if="knowledgePackages.length === 0"
            class="text-xs text-muted-foreground"
            data-testid="detail-knowledge-unavailable"
          >
            {{ t('digitalEmployee.detail.knowledgeUnavailable') }}
          </p>
          <template v-else>
            <div
              v-for="pkg in knowledgePackages"
              :key="pkg.knowledgeBaseId"
              class="rounded-md border border-border/60 p-2 text-xs"
              :data-testid="`detail-knowledge-${pkg.knowledgeBaseId}`"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{{ pkg.knowledgeBaseId }}</span>
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
              <p class="mt-1 text-muted-foreground">
                {{
                  t('digitalEmployee.detail.knowledgeMeta', {
                    count: pkg.conceptCount,
                    time: formatSyncTime(pkg.lastSyncAt)
                  })
                }}
              </p>
            </div>
          </template>
        </section>

        <!-- 技能：服务端定义（有明细展示名称，无明细回退 id）+ 本地安装状态 -->
        <section data-testid="detail-skills" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionSkills') }}
          </h3>
          <p v-if="employee.skillIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySkills') }}
          </p>
          <ul v-else class="space-y-1 text-xs">
            <li
              v-for="skill in employee.skills ?? []"
              :key="`detail-${skill.id}`"
              class="flex items-center justify-between gap-2"
            >
              <span class="truncate">{{ skill.name }}</span>
              <span class="shrink-0 text-muted-foreground">{{ skill.id }}</span>
            </li>
            <li v-for="id in skillIdsWithoutDetail" :key="id" class="truncate">{{ id }}</li>
          </ul>
          <p
            v-if="provisionResult?.skillNames.length"
            class="text-xs text-emerald-600"
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
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionTools') }}
          </h3>
          <p v-if="employee.tools.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyTools') }}
          </p>
          <ul v-else class="space-y-1 text-xs">
            <li v-for="tool in employee.tools" :key="tool" class="truncate">{{ tool }}</li>
          </ul>
          <div
            v-if="provisionResult"
            class="flex flex-wrap gap-3 text-xs"
            data-testid="detail-tool-readiness"
          >
            <span :class="provisionResult.toolsReady ? 'text-emerald-600' : 'text-destructive'">
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
              :class="provisionResult.knowledgeToolReady ? 'text-emerald-600' : 'text-destructive'"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@shadcn/components/ui/sheet'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import type { DigitalEmployeeProvisionResult } from '@shared/contracts/routes'
import type { DigitalEmployee, KnowledgePackageStatus } from '@shared/contracts/routes'

const props = defineProps<{
  employee: DigitalEmployee | null
  provisionResult: DigitalEmployeeProvisionResult | null
  open: boolean
}>()

const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const store = useDigitalEmployeeStore()

const knowledgePackages = ref<KnowledgePackageStatus[]>([])

/**
 * 只读视图：打开时按需拉一次知识包状态，员工切换时重拉。
 * 结果回来时若员工已切换则直接丢弃，避免串显上一家的数据。
 * 绝不触发 provision——那是有副作用的准备动作，只读详情不代用户执行。
 */
watch(
  () => [props.open, props.employee?.id] as const,
  async ([open, id]) => {
    if (!open || !props.employee || !id) return
    // 未绑定知识库就不发状态请求：请求必空，只会把空态渲染成「获取失败」。
    if (props.employee.knowledgeBaseIds.length === 0) {
      knowledgePackages.value = []
      return
    }
    const packages = await store.listKnowledgePackages(id)
    if (props.employee.id !== id) return
    knowledgePackages.value = packages
  },
  { immediate: true }
)

const skillDetailIds = computed(
  () => new Set((props.employee?.skills ?? []).map((skill) => skill.id))
)
const skillIdsWithoutDetail = computed(() =>
  (props.employee?.skillIds ?? []).filter((id) => !skillDetailIds.value.has(id))
)

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
