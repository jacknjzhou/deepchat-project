<template>
  <div class="rounded-lg border p-4" data-testid="jd-content-tabs">
    <template v-if="jdAnalysis">
      <div class="flex items-center gap-1">
        <DcButton
          v-for="tab in TABS"
          :key="tab.key"
          size="xs"
          :variant="activeTab === tab.key ? 'default' : 'ghost'"
          :active="activeTab === tab.key"
          :data-testid="`jd-content-tab-${tab.key}`"
          @click="activeTab = tab.key"
        >
          {{ t(tab.labelKey) }}
        </DcButton>
      </div>
      <ul
        v-if="activeItems.length > 0"
        :data-testid="`jd-content-panel-${activeTab}`"
        class="mt-3 list-disc space-y-1 pl-5 text-sm"
      >
        <li v-for="item in activeItems" :key="item">{{ item }}</li>
      </ul>
      <p v-else class="mt-3 text-sm text-muted-foreground" data-testid="jd-content-empty">
        {{ t('resumeScreening.jdContentEmpty') }}
      </p>
    </template>
    <p v-else class="text-sm text-muted-foreground" data-testid="jd-analysis-empty">
      {{ t('resumeScreening.jdAnalysisEmpty') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

// JD 解析官输出三段（契约 resumeScreeningJdAnalysisSchema），只读展示，无数据上抛
const TABS = [
  { key: 'responsibilities', labelKey: 'resumeScreening.jdTabResponsibilities' },
  { key: 'requirements', labelKey: 'resumeScreening.jdTabRequirements' },
  { key: 'preferred', labelKey: 'resumeScreening.jdTabPreferred' }
] as const

type TabKey = (typeof TABS)[number]['key']

const props = defineProps<{
  jdAnalysis: ResumeScreeningTaskDto['jdAnalysis']
}>()

const { t } = useI18n()

const activeTab = ref<TabKey>('responsibilities')

const activeItems = computed(() => (props.jdAnalysis ? props.jdAnalysis[activeTab.value] : []))
</script>
