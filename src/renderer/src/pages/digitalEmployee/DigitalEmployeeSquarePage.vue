<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 顶部：标题 + Tab -->
    <div class="shrink-0 border-b border-border/60 px-6 pt-4">
      <h1 class="text-lg font-semibold">{{ t('routes.digitalEmployees') }}</h1>
      <div class="mt-3 flex items-center gap-1">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="rounded-lg px-3 py-1.5 text-sm transition-colors"
          :class="
            activeTab === tab.key
              ? 'bg-accent/70 text-foreground'
              : 'text-muted-foreground hover:bg-accent/40'
          "
          :data-testid="`digital-employee-tab-${tab.key}`"
          @click="activeTab = tab.key"
        >
          {{ t(tab.labelKey) }}
        </button>
      </div>
    </div>

    <!-- 工具行：搜索 + 能力筛选 -->
    <div class="flex shrink-0 items-center gap-3 px-6 py-3">
      <Input
        v-model="searchQuery"
        type="search"
        data-testid="digital-employee-search-input"
        :placeholder="t('digitalEmployee.searchPlaceholder')"
        class="h-9 max-w-xs"
      />
      <div
        v-if="activeCapabilityFilter"
        class="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <DcBadge variant="active">{{ activeCapabilityFilter }}</DcBadge>
        <button
          type="button"
          class="ml-1 text-muted-foreground hover:text-foreground"
          @click="activeCapabilityFilter = null"
        >
          <Icon icon="lucide:x" class="size-3.5" />
        </button>
      </div>
      <!-- square Tab：预聚合能力 chips 供点击筛选 -->
      <div
        v-if="activeTab === 'square' && squareCapabilities.length"
        class="flex flex-wrap items-center gap-1"
      >
        <button
          v-for="capability in squareCapabilities"
          :key="capability"
          type="button"
          class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40"
          :class="activeCapabilityFilter === capability ? 'bg-primary/10 text-foreground' : ''"
          :data-testid="`digital-employee-capability-chip-${capability}`"
          @click="
            activeCapabilityFilter = activeCapabilityFilter === capability ? null : capability
          "
        >
          {{ capability }}
        </button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="flex-1 overflow-y-auto px-6 pb-6">
      <!-- 降级：明确说明展示的是本地 Mock 数据，不能宣称仍在连接远端 -->
      <div
        v-if="store.degraded"
        data-testid="digital-employee-degraded-banner"
        class="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <Icon icon="lucide:cloud-off" class="mt-0.5 size-4 shrink-0" />
        <span>{{ t('digitalEmployee.banner.degraded') }}</span>
      </div>

      <div
        v-if="store.hasConfigUpdates"
        data-testid="digital-employee-config-updated-banner"
        class="mb-4 flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300"
      >
        <Icon icon="lucide:refresh-cw" class="mt-0.5 size-4 shrink-0" />
        <span class="flex-1">{{ t('digitalEmployee.banner.configUpdated') }}</span>
        <button
          type="button"
          class="shrink-0 underline underline-offset-2 hover:no-underline"
          data-testid="digital-employee-ack-config-updates"
          @click="store.acknowledgeConfigUpdates()"
        >
          {{ t('digitalEmployee.banner.dismiss') }}
        </button>
      </div>

      <div v-if="store.loading" class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <Skeleton v-for="i in 8" :key="i" class="h-36 rounded-xl" />
      </div>

      <!-- team Tab 只显示下方占位空态，不显示「没有找到数字员工」 -->
      <DcEmpty
        v-else-if="activeTab !== 'team' && visibleEmployees.length === 0"
        icon="lucide:users-round"
        :title="t('digitalEmployee.emptyTitle')"
        :description="t('digitalEmployee.emptyDescription')"
      />

      <div
        v-else-if="activeTab !== 'team'"
        class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4"
      >
        <button
          v-for="employee in visibleEmployees"
          :key="employee.id"
          type="button"
          class="flex flex-col items-start gap-2 rounded-xl border border-border/60 bg-card/50 p-4 text-left transition-colors hover:bg-accent/40"
          :data-testid="`digital-employee-card-${employee.id}`"
          @click="openDetail(employee)"
        >
          <div class="flex w-full items-center gap-2">
            <div
              class="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary"
            >
              {{ employee.name.slice(0, 1) }}
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">
                {{ employee.name }}
                <span class="text-xs text-muted-foreground">@{{ employee.role }}</span>
              </div>
            </div>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="
                employee.executionMode === 'remote'
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground'
              "
              :data-testid="`digital-employee-mode-${employee.id}`"
              :data-execution-mode="employee.executionMode ?? 'local'"
              >{{
                employee.executionMode === 'remote'
                  ? t('digitalEmployee.remote.badge')
                  : t('digitalEmployee.local.badge')
              }}</span
            >
            <span
              role="button"
              tabindex="0"
              class="ml-auto shrink-0 cursor-pointer transition-colors"
              :class="
                store.favorites.includes(employee.id)
                  ? 'text-amber-400 hover:opacity-80'
                  : 'text-muted-foreground/40 hover:text-amber-400'
              "
              :data-testid="`digital-employee-favorite-${employee.id}`"
              @click.stop="store.toggleFavorite(employee.id)"
              @keydown.enter.stop="store.toggleFavorite(employee.id)"
            >
              <Icon
                icon="lucide:star"
                class="size-4"
                :class="store.favorites.includes(employee.id) ? 'fill-amber-400' : ''"
              />
            </span>
          </div>
          <p class="line-clamp-2 text-xs text-muted-foreground">{{ employee.description }}</p>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="capability in employee.capabilities.slice(0, 3)"
              :key="capability"
              class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              @click.stop="activeCapabilityFilter = capability"
              >{{ capability }}</span
            >
          </div>
          <div class="mt-auto flex gap-3 text-[10px] text-muted-foreground/70">
            <span>{{ t('digitalEmployee.countSops', { count: employee.sops.length }) }}</span>
            <span>{{ t('digitalEmployee.countSkills', { count: employee.skillIds.length }) }}</span>
            <span>{{ t('digitalEmployee.countTools', { count: employee.tools.length }) }}</span>
          </div>
        </button>
      </div>

      <!-- 团队对话 Tab 空态 -->
      <DcEmpty
        v-if="activeTab === 'team'"
        icon="lucide:users"
        :title="t('digitalEmployee.teamComingSoon')"
        class="py-16"
      />
    </div>

    <!-- 详情弹层：四类配置清单 + 开场问题 + 开始对话 -->
    <Dialog
      :open="detailEmployee !== null"
      @update:open="
        (open: boolean) => {
          if (!open) detailEmployee = null
        }
      "
    >
      <DialogContent
        v-if="detailEmployee"
        class="max-w-lg"
        data-testid="digital-employee-detail-dialog"
      >
        <DialogHeader>
          <DialogTitle>{{ detailEmployee.name }} · {{ detailEmployee.role }}</DialogTitle>
          <DialogDescription>{{ detailEmployee.description }}</DialogDescription>
        </DialogHeader>
        <div class="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
          <section v-if="detailEmployee.sops.length">
            <h3 class="text-xs font-semibold text-muted-foreground">
              {{ t('digitalEmployee.sectionSops') }}
            </h3>
            <ul class="mt-1 list-disc pl-4 text-xs">
              <li v-for="sop in detailEmployee.sops" :key="sop.title">{{ sop.title }}</li>
            </ul>
          </section>
          <section v-if="detailEmployee.skillIds.length">
            <h3 class="text-xs font-semibold text-muted-foreground">
              {{ t('digitalEmployee.sectionSkills') }}
            </h3>
            <p class="mt-1 text-xs">{{ detailEmployee.skillIds.join('、') }}</p>
          </section>
          <section v-if="detailEmployee.tools.length">
            <h3 class="text-xs font-semibold text-muted-foreground">
              {{ t('digitalEmployee.sectionTools') }}
            </h3>
            <p class="mt-1 text-xs">{{ detailEmployee.tools.join('、') }}</p>
          </section>
          <section v-if="detailEmployee.knowledgeBaseIds.length">
            <h3 class="text-xs font-semibold text-muted-foreground">
              {{ t('digitalEmployee.sectionKnowledge') }}
            </h3>
            <p class="mt-1 text-xs">{{ detailEmployee.knowledgeBaseIds.join('、') }}</p>
          </section>
        </div>
        <div class="space-y-2">
          <p
            v-if="startError"
            data-testid="digital-employee-start-error"
            class="text-sm text-destructive"
          >
            {{ t('digitalEmployee.startConversationFailed') }}
          </p>
          <Input
            v-model="openingQuestion"
            type="text"
            data-testid="digital-employee-opening-question"
            :placeholder="t('digitalEmployee.openingQuestionPlaceholder')"
          />
          <DcButton
            class="w-full"
            data-testid="digital-employee-start-button"
            :disabled="startingConversation"
            :loading="startingConversation"
            @click="startConversation"
          >
            {{ t('digitalEmployee.startConversation') }}
          </DcButton>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { createDigitalEmployeeSettingsClient } from '@api/DigitalEmployeeSettingsClient'
import { Input } from '@shadcn/components/ui/input'
import { Skeleton } from '@shadcn/components/ui/skeleton'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import { DcEmpty } from '@dc-ui/components/empty'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@shadcn/components/ui/dialog'
import { notifyRenderer } from '@renderer-notifications/rendererNotificationPort'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import { useMcpStore } from '@/stores/mcp'
import type { DigitalEmployee } from '@shared/contracts/routes'

const TABS = [
  { key: 'all', labelKey: 'digitalEmployee.tabAll' },
  { key: 'mine', labelKey: 'digitalEmployee.tabMine' },
  { key: 'team', labelKey: 'digitalEmployee.tabTeam' },
  { key: 'square', labelKey: 'digitalEmployee.tabSquare' }
] as const

type TabKey = (typeof TABS)[number]['key']

const { t } = useI18n()
const router = useRouter()
const store = useDigitalEmployeeStore()
const mcpStore = useMcpStore()
const activeTab = ref<TabKey>('all')
const searchQuery = ref('')
const activeCapabilityFilter = ref<string | null>(null)
const detailEmployee = ref<DigitalEmployee | null>(null)
const openingQuestion = ref('')
const startingConversation = ref(false)
const startError = ref(false)
let unsubscribeConfigurationChanged: (() => void) | null = null

const matchesSearch = (employee: DigitalEmployee) => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return true
  return (
    employee.name.toLowerCase().includes(query) ||
    employee.role.toLowerCase().includes(query) ||
    employee.description.toLowerCase().includes(query) ||
    employee.capabilities.some((capability) => capability.toLowerCase().includes(query))
  )
}

const visibleEmployees = computed(() => {
  if (activeTab.value === 'team') return []
  let list = store.enabledEmployees
  if (activeTab.value === 'mine') {
    list = list.filter((employee) => store.favorites.includes(employee.id))
  }
  if (activeCapabilityFilter.value) {
    const capability = activeCapabilityFilter.value
    list = list.filter((employee) => employee.capabilities.includes(capability))
  }
  return list.filter(matchesSearch)
})

// square Tab 的预聚合能力清单（去重）
const squareCapabilities = computed(() => {
  const capabilities = new Set<string>()
  for (const employee of store.enabledEmployees) {
    for (const capability of employee.capabilities) capabilities.add(capability)
  }
  return [...capabilities]
})

const openDetail = (employee: DigitalEmployee) => {
  detailEmployee.value = employee
  openingQuestion.value = ''
}

/**
 * 把「准备工作降级了什么」告诉用户。
 *
 * 准备失败一律不阻断对话（这是设计），但什么都不说就变成静默降级：用户以为
 * 员工带着全部技能和工具在跑，实际少了几个，只会觉得「这个员工怎么不会用工具」。
 *
 * 跳转之后再提示，而不是跳转之前：提示条挂在聊天页上，页面还没切过去就发通知
 * 会被旧页面的卸载冲掉。
 */
const reportDegradedProvisioning = (
  provisioned: Awaited<ReturnType<typeof store.provisionEmployee>>,
  hasKnowledgeBases: boolean
): void => {
  if (!provisioned) return
  // remote 员工本来就不在本地准备，`skipped` 不是降级信号。
  if (provisioned.skipped !== null) return

  const missingSkills = provisioned.failedSkills.length
  const toolsUnavailable = !provisioned.toolsReady
  // 没配知识库的员工本来就没有检索工具（注册器按常态清理，不算失败），
  // 只有「配了库但工具没起来」才是降级。
  const knowledgeUnavailable = hasKnowledgeBases && !provisioned.knowledgeToolReady
  if (!toolsUnavailable && !knowledgeUnavailable && missingSkills === 0) return

  // 失败原因随 toast 透出：HTTP 401 和安装器拒绝的处置完全不同（换 key vs
  // 查服务端），只报个数等于让用户继续猜。
  const reasons = Object.entries(provisioned.failureReasons)
    .map(([slug, reason]) => `${slug}: ${reason}`)
    .join(', ')
  const skillsDescription = reasons
    ? `${t('digitalEmployee.provision.degradedSkills', { count: missingSkills })} ${t('digitalEmployee.provision.degradedSkillReasons', { reasons })}`
    : t('digitalEmployee.provision.degradedSkills', { count: missingSkills })

  const messages: string[] = []
  if (toolsUnavailable) messages.push(t('digitalEmployee.provision.degradedTools'))
  if (knowledgeUnavailable) {
    messages.push(t('digitalEmployee.provision.knowledgeToolUnavailable'))
  }
  if (missingSkills > 0) messages.push(skillsDescription)

  notifyRenderer({
    kind: 'warning',
    code: 'digitalEmployee.provision.degraded',
    title: t('digitalEmployee.provision.degradedTitle'),
    description: messages.join(' ')
  })
}

const startConversation = async () => {
  const employee = detailEmployee.value
  // 忙碌中禁止重复点击，避免重复创建会话
  if (!employee || startingConversation.value) return
  startingConversation.value = true
  startError.value = false
  try {
    // 准备必须先于 loadTools：工具白名单是「可用工具列表的补集」，
    // 注册晚了第一轮对话就一个 staffdeck_* 工具都没有，之后不会自动重试。
    // provision 内部已吞掉全部失败，这里的 catch 只兜 IPC 层异常。
    const provisioned = await store.provisionEmployee(employee.id).catch(() => null)
    // 取可用 MCP 工具名供白名单收敛；loadTools 内部已兜错，失败时列表为空 → 放弃收敛（宁多勿缺）。
    // 必须 force：默认走 refresh，30 秒 staleTime 内会直接返回注册前的缓存，
    // 刚注册的 server 工具就看不见，「先注册后读列表」白做。
    await mcpStore.loadTools({ force: true })
    const sessionId = await store.startConversation(employee, {
      openingQuestion: openingQuestion.value.trim() || undefined,
      availableMcpToolNames: mcpStore.tools.map((tool) => tool.function.name),
      ...(provisioned?.skillNames.length ? { activeSkillNames: provisioned.skillNames } : {})
    })
    detailEmployee.value = null
    await router.push({ name: 'chat' })
    reportDegradedProvisioning(provisioned, employee.knowledgeBaseIds.length > 0)
    void sessionId
  } catch (error) {
    console.error('[DigitalEmployeeSquarePage] startConversation failed', error)
    // 失败保持弹层打开，让用户可以重试
    startError.value = true
  } finally {
    startingConversation.value = false
  }
}

onMounted(() => {
  void store.loadInitialData()
  // 设置页保存/清除 StaffDeck 配置后自动刷新，避免用户手动重进页面
  unsubscribeConfigurationChanged = createDigitalEmployeeSettingsClient().onConfigurationChanged(
    () => {
      void store.fetchEmployees()
    }
  )
})

onBeforeUnmount(() => {
  unsubscribeConfigurationChanged?.()
  unsubscribeConfigurationChanged = null
})
</script>
