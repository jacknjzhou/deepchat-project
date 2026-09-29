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

          <!-- 按截图分两栏：个人基础字段在左，教育/职业等其余字段在右 -->
          <div
            v-if="infoEntries.length > 0"
            data-testid="detail-info"
            class="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 text-sm md:grid-cols-2"
          >
            <div
              v-for="(group, index) in infoGroups"
              :key="index"
              data-testid="detail-info-group"
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 self-start"
              :class="infoGroups.length === 1 ? 'md:col-span-2' : ''"
            >
              <template v-for="[key, value] in group" :key="key">
                <span class="text-muted-foreground">{{ fieldLabel(key) }}</span>
                <span class="min-w-0 break-words whitespace-pre-line">{{ value.text }}</span>
              </template>
            </div>

            <!-- 数组类长内容（skills/work_history/education_history 等）通栏显示，从左侧占满整行 -->
            <div
              v-for="[key, value] in wideEntries"
              :key="key"
              data-testid="detail-info-wide"
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 self-start md:col-span-2"
            >
              <span class="text-muted-foreground">{{ fieldLabel(key) }}</span>
              <span class="min-w-0 break-words whitespace-pre-line">{{
                value.kind === 'lines' ? value.lines.join('\n') : value.text
              }}</span>
            </div>
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
          <div class="grid grid-cols-1 gap-3 text-sm">
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

      <!-- 简历原文：不展示解析文本，直接内嵌预览源文件（docx 等格式无法在浏览器渲染时提示） -->
      <div class="rounded-lg border p-4">
        <h4 class="mb-2 text-sm font-medium">{{ t('resumeScreening.rawTextSection') }}</h4>
        <iframe
          v-if="previewUrl"
          :src="previewUrl"
          data-testid="detail-preview"
          class="h-96 w-full rounded-md border bg-muted"
          :title="resume.fileName"
        ></iframe>
        <p v-else data-testid="detail-preview-unsupported" class="text-sm text-muted-foreground">
          {{ t('resumeScreening.detailPreviewUnsupported') }}
        </p>
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
// 标量分两栏（个人基础字段左栏、其余右栏）；数组类长内容（对象数组逐行、原始数组内联）通栏显示
type InfoValue =
  | { kind: 'text'; text: string } // 标量，参与两栏分列
  | { kind: 'wide'; text: string } // 原始类型数组，内联文本但通栏
  | { kind: 'lines'; lines: string[] } // 对象数组，逐行展示且通栏
type InfoScalar = Extract<InfoValue, { kind: 'text' }>

const infoEntries = computed(() => {
  if (!props.resume?.resumeInfo || typeof props.resume.resumeInfo !== 'object') return []
  return Object.entries(props.resume.resumeInfo as Record<string, unknown>).map(
    ([key, value]): [string, InfoValue] => [key, describeInfoValue(value)]
  )
})

// 个人基础字段进左栏，其余标量进右栏；宽松契约下未匹配键全部归右栏
const BASIC_INFO_KEYS = new Set([
  'name',
  'gender',
  'phone',
  'email',
  'birth_date',
  'highest_degree',
  'university'
])

const infoGroups = computed(() => {
  const scalars = infoEntries.value.filter(
    (entry): entry is [string, InfoScalar] => entry[1].kind === 'text'
  )
  const basic = scalars.filter(([key]) => BASIC_INFO_KEYS.has(key))
  const rest = scalars.filter(([key]) => !BASIC_INFO_KEYS.has(key))
  return [basic, rest].filter((group) => group.length > 0)
})

const wideEntries = computed(() => infoEntries.value.filter(([, value]) => value.kind !== 'text'))

// LLM 抽取键多为英文 snake_case，映射为中文标签展示；未匹配键原样展示
const FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  gender: '性别',
  age: '年龄',
  birth_date: '出生日期',
  phone: '电话',
  email: '邮箱',
  location: '所在地',
  highest_degree: '最高学历',
  university: '毕业院校',
  major: '专业',
  graduation_date: '毕业年份',
  work_years: '工作年限',
  recent_company: '最近任职公司',
  recent_position: '最近任职职位',
  expected_position: '期望职位',
  expected_city: '期望城市',
  expected_salary: '期望薪资',
  political_status: '政治面貌',
  marital_status: '婚姻状况',
  languages: '语言能力',
  certificates: '证书',
  skills: '技能',
  work_history: '工作经历',
  education_history: '教育经历',
  project_history: '项目经历',
  self_evaluation: '自我评价',
  company: '公司',
  position: '职位',
  title: '职位',
  department: '部门',
  school: '学校',
  degree: '学历',
  start: '开始时间',
  end: '结束时间',
  start_date: '开始时间',
  end_date: '结束时间',
  description: '描述'
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

// 浏览器内核可直接渲染的格式才内嵌预览；docx 等提示不支持
const PREVIEWABLE_EXTENSIONS = new Set(['.pdf', '.txt', '.md'])

// 源文件地址：resume-preview://<taskId>/<resumeId><ext>，主进程仅服务 resume-screening 存储目录
const previewUrl = computed(() => {
  const current = props.resume
  if (!current) return null
  const dotIndex = current.fileName.lastIndexOf('.')
  if (dotIndex < 0) return null
  const ext = current.fileName.slice(dotIndex).toLowerCase()
  if (!PREVIEWABLE_EXTENSIONS.has(ext)) return null
  return `resume-preview://${current.taskId}/${encodeURIComponent(current.id + ext)}`
})

function describeInfoValue(value: unknown): InfoValue {
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'wide', text: '—' }
    if (value.every((item) => item !== null && typeof item === 'object')) {
      return { kind: 'lines', lines: value.map((item) => `· ${formatInfoInline(item)}`) }
    }
    return { kind: 'wide', text: formatInfoInline(value) }
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
      .map(([key, item]) => `${fieldLabel(key)}:${formatInfoInline(item)}`)
      .join('，')
  }
  return String(value)
}
</script>
