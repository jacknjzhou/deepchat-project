<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">{{ t('resumeScreening.title') }}</h1>
      <UserProfileBadge
        v-if="store.profile"
        :name="store.profile.name"
        :email="store.profile.email"
      />
    </header>

    <div
      class="grid min-h-0 flex-1 grid-cols-[380px_1fr] divide-x"
      data-testid="resume-screening-workspace"
    >
      <aside
        class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        data-testid="resume-screening-create-panel"
      >
        <JdInputCard
          :jd-source="store.draft.jdSource"
          :jd-text="store.draft.jdText"
          :jd-file-path="store.draft.jdFilePath"
          :jd-file-name="store.draft.jdFileName"
          @update:jd-source="(value) => (store.draft.jdSource = value)"
          @update:jd-text="(value) => (store.draft.jdText = value)"
          @pick-file="onPickJdFile"
          @clear-file="clearJdFile"
        />
        <ResumeUploadCard
          :resumes="store.draft.resumes"
          @pick-files="onPickResumeFiles"
          @remove="removeResume"
        />
        <ScreeningConfigCard
          :config="store.draft.config"
          @update:config="(config) => (store.draft.config = config)"
        />
        <ModelSelector
          v-if="store.models.length > 0"
          :models="store.models"
          :model-key="store.selectedModelKey"
          @update:model-key="onSelectModel"
        />
        <p v-if="store.createError" class="text-sm text-destructive" data-testid="create-error">
          {{ store.createError }}
        </p>
        <ReviewButton
          :can-review="store.canReview"
          :is-running="store.isTaskActive"
          :is-creating="store.isCreating"
          @review="onReview"
          @cancel="store.cancelTask()"
        />
        <TaskHistoryList
          :tasks="store.tasks"
          :tasks-loaded="store.tasksLoaded"
          :selected-id="store.currentTaskId"
          @select="onSelectTask"
        />
      </aside>

      <section class="min-h-0 overflow-y-auto p-6" data-testid="resume-screening-detail-panel">
        <div
          v-if="!store.currentTask"
          class="flex h-full items-center justify-center"
          data-testid="detail-panel-empty"
        >
          <p class="text-sm text-muted-foreground">{{ t('resumeScreening.detailPanelEmpty') }}</p>
        </div>
        <div v-else class="flex flex-col gap-4">
          <TaskProgressHeader :task="store.currentTask" />
          <div class="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-4">
            <ResumeListPanel
              :resumes="store.currentResumes"
              :selected-id="store.selectedResumeId"
              @select="store.selectedResumeId = $event"
            />
            <ResumeDetailPanel :resume="store.selectedResume" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { createDeviceClient } from '@api/DeviceClient'
import { resumeScreeningApi } from '@api/resumeScreeningTasks'
import { RESUME_LIMIT, useResumeScreeningStore } from '@/stores/resumeScreening'
import JdInputCard from './components/JdInputCard.vue'
import ResumeUploadCard from './components/ResumeUploadCard.vue'
import ScreeningConfigCard from './components/ScreeningConfigCard.vue'
import ReviewButton from './components/ReviewButton.vue'
import UserProfileBadge from './components/UserProfileBadge.vue'
import ModelSelector from './components/ModelSelector.vue'
import TaskHistoryList from './components/TaskHistoryList.vue'
import TaskProgressHeader from './components/TaskProgressHeader.vue'
import ResumeListPanel from './components/ResumeListPanel.vue'
import ResumeDetailPanel from './components/ResumeDetailPanel.vue'

const { t } = useI18n()
const deviceClient = createDeviceClient()
const store = useResumeScreeningStore()

// 与 Task 1 契约的扩展名白名单一致
const FILE_FILTERS = [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }]

// 订阅取消函数，onUnmounted 清理
let offTaskUpdated: (() => void) | null = null
let offResumeUpdated: (() => void) | null = null

onMounted(() => {
  void store.loadProfile()
  void store.loadModels()
  void store.loadTasks()
  offTaskUpdated = resumeScreeningApi.onTaskUpdated(store.handleTaskUpdated)
  offResumeUpdated = resumeScreeningApi.onResumeUpdated(store.handleResumeUpdated)
})

onUnmounted(() => {
  offTaskUpdated?.()
  offResumeUpdated?.()
  offTaskUpdated = null
  offResumeUpdated = null
})

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

async function onPickJdFile() {
  const result = await deviceClient.selectFiles({ multiple: false, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const filePath = result.filePaths[0]
  store.draft.jdFilePath = filePath
  store.draft.jdFileName = basename(filePath)
}

function clearJdFile() {
  store.draft.jdFilePath = null
  store.draft.jdFileName = null
}

async function onPickResumeFiles() {
  const result = await deviceClient.selectFiles({ multiple: true, filters: FILE_FILTERS })
  if (result.canceled || result.filePaths.length === 0) return
  const existing = new Set(store.draft.resumes.map((item) => item.path))
  for (const filePath of result.filePaths) {
    if (store.draft.resumes.length >= RESUME_LIMIT || existing.has(filePath)) continue
    existing.add(filePath)
    store.draft.resumes.push({ path: filePath, name: basename(filePath) })
  }
}

function removeResume(path: string) {
  const index = store.draft.resumes.findIndex((item) => item.path === path)
  if (index >= 0) store.draft.resumes.splice(index, 1)
}

function onSelectModel(key: string) {
  const [providerId, modelId] = key.split('::')
  if (providerId && modelId) store.selectModel(providerId, modelId)
}

function onSelectTask(taskId: string) {
  void store.loadTask(taskId)
}

function onReview() {
  void store.createTask()
}
</script>
