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

      <!-- 基本信息/初筛评估/面试考察/HR 汇总横向排列；窄窗口按 2 列/1 列回退 -->
      <div class="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div class="min-w-0 rounded-lg border p-4">
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
              <span class="min-w-0 break-words">{{ value }}</span>
            </template>
          </div>
        </div>

        <div
          v-if="resume.screening"
          data-testid="screening-section"
          class="min-w-0 rounded-lg border p-4"
        >
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-medium">{{ t('resumeScreening.screeningSection') }}</h4>
            <span class="text-lg font-semibold">{{ resume.screening.score }}</span>
          </div>
          <p class="mt-2 text-sm">{{ resume.screening.conclusion }}</p>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li v-for="strength in resume.screening.strengths" :key="strength">{{ strength }}</li>
          </ul>
        </div>

        <div
          v-if="resume.interview"
          data-testid="interview-section"
          class="min-w-0 rounded-lg border p-4"
        >
          <h4 class="text-sm font-medium">{{ t('resumeScreening.interviewSection') }}</h4>
          <!-- 横向卡片内子列表纵向堆叠，避免多列挤压 -->
          <div class="mt-2 grid grid-cols-1 gap-3 text-sm">
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewHighlights') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview.highlights" :key="item">{{ item }}</li>
              </ul>
            </div>
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewRisks') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview.risks" :key="item">{{ item }}</li>
              </ul>
            </div>
            <div>
              <p class="font-medium">{{ t('resumeScreening.interviewQuestions') }}</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li v-for="item in resume.interview.questions" :key="item">{{ item }}</li>
              </ul>
            </div>
          </div>
        </div>

        <div v-if="resume.hr" data-testid="hr-section" class="min-w-0 rounded-lg border p-4">
          <h4 class="text-sm font-medium">{{ t('resumeScreening.hrSection') }}</h4>
          <p class="mt-2 text-xs text-muted-foreground">
            {{ t('resumeScreening.hrFinalSummary') }}
          </p>
          <p class="mt-1 text-sm">{{ resume.hr.finalSummary }}</p>
          <p class="mt-3 text-xs text-muted-foreground">{{ t('resumeScreening.hrOpinion') }}</p>
          <p class="mt-1 text-sm">{{ resume.hr.hrOpinion }}</p>
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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const props = defineProps<{
  resume: ResumeScreeningResumeDto | null
}>()

const { t } = useI18n()

// resumeInfo 是宽松契约字段（z.unknown()，见 Task 1），按键值对渲染；值格式化：
// 数组顿号 join、对象 JSON.stringify、null/undefined 显示 —
const infoEntries = computed(() => {
  if (!props.resume?.resumeInfo || typeof props.resume.resumeInfo !== 'object') return []
  return Object.entries(props.resume.resumeInfo as Record<string, unknown>).map(([key, value]) => [
    key,
    formatInfoValue(value)
  ])
})

function formatInfoValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
</script>
