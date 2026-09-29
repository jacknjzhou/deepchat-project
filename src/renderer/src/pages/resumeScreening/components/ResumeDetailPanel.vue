<template>
  <div class="flex min-h-0 flex-col gap-3 overflow-y-auto">
    <p
      v-if="!resume"
      data-testid="detail-empty"
      class="py-8 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.detailEmpty') }}
    </p>
    <template v-else>
      <div
        v-if="resume.error"
        data-testid="detail-error"
        class="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ resume.error }}
      </div>

      <!-- 基本信息/初筛评估/面试考察/HR 汇总以 Tab 切换（浅色激活态，同 JD 内容 Tab 模式） -->
      <div class="rounded-lg border p-4" data-testid="detail-section-tabs">
        <div class="flex items-center gap-1">
          <DcButton
            v-for="tab in tabs"
            :key="tab.key"
            size="xs"
            :variant="activeTab === tab.key ? 'secondary' : 'ghost'"
            :active="activeTab === tab.key"
            :data-testid="`detail-tab-${tab.key}`"
            @click="activeTab = tab.key"
          >
            {{ t(tab.labelKey) }}
          </DcButton>
        </div>

        <div v-if="activeTab === 'profile'" data-testid="profile-section" class="mt-3">
          <div class="flex items-center justify-between gap-2">
            <h3 class="min-w-0 truncate text-base font-semibold">
              {{ resume.candidateName ?? resume.fileName }}
            </h3>
            <div class="flex shrink-0 items-center gap-2">
              <span v-if="resume.score !== null" class="text-sm font-medium">
                {{ t('resumeScreening.detailScore', { score: resume.score }) }}
              </span>
              <DcBadge :variant="resume.recommended ? 'success' : 'neutral'">
                {{
                  resume.recommended
                    ? t('resumeScreening.detailRecommended')
                    : t('resumeScreening.detailNotRecommended')
                }}
              </DcBadge>
            </div>
          </div>

          <div
            v-if="infoEntries.length > 0"
            data-testid="detail-info"
            class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
          >
            <template v-for="[key, value] in infoEntries" :key="key">
              <span class="text-muted-foreground">{{ key }}</span>
              <span class="min-w-0 break-words whitespace-pre-line">{{
                value.kind === 'text' ? value.text : value.lines.join('\n')
              }}</span>
            </template>
          </div>
        </div>

        <div v-else-if="activeTab === 'screening'" data-testid="screening-section" class="mt-3">
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-medium">{{ t('resumeScreening.screeningSection') }}</h4>
            <span class="text-lg font-semibold">{{ resume.screening?.score }}</span>
          </div>
          <p class="mt-2 text-sm">{{ resume.screening?.conclusion }}</p>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li v-for="strength in resume.screening?.strengths" :key="strength">{{ strength }}</li>
          </ul>
        </div>

        <div v-else-if="activeTab === 'interview'" data-testid="interview-section" class="mt-3">
          <div class="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewHighlights') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview?.highlights" :key="item">{{ item }}</li>
              </ul>
            </div>
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewRisks') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview?.risks" :key="item">{{ item }}</li>
              </ul>
            </div>
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewQuestions') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview?.questions" :key="item">{{ item }}</li>
              </ul>
            </div>
          </div>
        </div>

        <div v-else-if="activeTab === 'hr'" data-testid="hr-section" class="mt-3">
          <p class="text-xs text-muted-foreground">{{ t('resumeScreening.hrFinalSummary') }}</p>
          <p class="mt-1 text-sm">{{ resume.hr?.finalSummary }}</p>
          <p class="mt-3 text-xs text-muted-foreground">{{ t('resumeScreening.hrOpinion') }}</p>
          <p class="mt-1 text-sm">{{ resume.hr?.hrOpinion }}</p>
        </div>
      </div>

      <div v-if="resume.rawText" class="rounded-lg border p-4">
        <h4 class="mb-2 text-sm font-medium">{{ t('resumeScreening.rawTextSection') }}</h4>
        <!-- pre 内容顶格写，避免模板缩进被 whitespace-pre 保留 -->
        <pre
          data-testid="detail-rawtext"
          class="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs"
          >{{ resume.rawText }}</pre
        >
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

type DetailTabKey = 'profile' | 'screening' | 'interview' | 'hr'

const props = defineProps<{
  resume: ResumeScreeningResumeDto | null
}>()

const { t } = useI18n()

const activeTab = ref<DetailTabKey>('profile')

// 仅列出当前简历已有数据的 Tab；基本信息恒可用
const tabs = computed(() => {
  const current = props.resume
  if (!current) return []
  const list: Array<{ key: DetailTabKey; labelKey: string }> = [
    { key: 'profile', labelKey: 'resumeScreening.detailProfileTab' }
  ]
  if (current.screening)
    list.push({ key: 'screening', labelKey: 'resumeScreening.screeningSection' })
  if (current.interview)
    list.push({ key: 'interview', labelKey: 'resumeScreening.interviewSection' })
  if (current.hr) list.push({ key: 'hr', labelKey: 'resumeScreening.hrSection' })
  return list
})

// 切换候选人时回到基本信息；防抖重同步会替换对象引用，只按简历 id 触发
watch(
  () => props.resume?.id,
  () => {
    activeTab.value = 'profile'
  }
)

// resumeInfo 是宽松契约字段（z.unknown()，见 Task 1），按键值对渲染：
// 简单值内联显示；对象数组逐条分行（· 前缀）格式化展示；对象递归展开为「键:值」文本
type InfoValue = { kind: 'text'; text: string } | { kind: 'lines'; lines: string[] }

const infoEntries = computed(() => {
  if (!props.resume?.resumeInfo || typeof props.resume.resumeInfo !== 'object') return []
  return Object.entries(props.resume.resumeInfo as Record<string, unknown>).map(([key, value]) => [
    key,
    describeInfoValue(value)
  ])
})

function describeInfoValue(value: unknown): InfoValue {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item !== null && typeof item === 'object')
  ) {
    return { kind: 'lines', lines: value.map((item) => `· ${formatInfoInline(item)}`) }
  }
  return { kind: 'text', text: formatInfoInline(value) }
}

function formatInfoInline(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    return value.map((item) => formatInfoInline(item)).join('、')
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}:${formatInfoInline(item)}`)
      .join('，')
  }
  return String(value)
}
</script>
