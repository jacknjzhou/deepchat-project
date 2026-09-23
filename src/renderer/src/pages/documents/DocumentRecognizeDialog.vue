<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-lg" data-testid="document-recognize-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('settings.documents.archive.newRecognition') }}</DialogTitle>
        <DialogDescription>{{ t('settings.documents.archive.reRecognizeHint') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <Input
              :model-value="
                t('settings.documents.archive.filesSelected', { count: selectedFiles.length })
              "
              readonly
              data-testid="recognize-file-input"
            />
            <DcButton
              variant="outline"
              data-testid="recognize-select-file"
              :disabled="submitting"
              @click="onSelectFile"
            >
              {{ t('settings.documents.archive.selectFile') }}
            </DcButton>
          </div>
          <ul v-if="selectedFiles.length" class="flex flex-wrap gap-1">
            <li
              v-for="(file, index) in selectedFiles"
              :key="file.path"
              class="flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
            >
              <span class="max-w-48 truncate">{{ file.name }}</span>
              <button
                type="button"
                :data-testid="`recognize-file-remove-${index}`"
                class="text-muted-foreground hover:text-destructive"
                @click="removeFile(index)"
              >
                ×
              </button>
            </li>
          </ul>
        </div>
        <div class="space-y-1">
          <span class="text-sm font-medium">
            {{ t('settings.documents.archive.templatePlaceholder') }}
          </span>
          <Select
            :model-value="templateId"
            @update:model-value="(value) => (templateId = String(value))"
          >
            <SelectTrigger data-testid="recognize-template-trigger"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">
                {{ t('settings.documents.archive.autoClassify') }}
              </SelectItem>
              <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.id">
                {{ tpl.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p
          v-if="isPdfFile && !error"
          class="text-xs text-muted-foreground"
          data-testid="recognize-pdf-hint"
        >
          {{ t('settings.documents.archive.recognizePdfHint') }}
        </p>
        <p v-if="error" class="text-sm text-destructive" data-testid="recognize-error">
          {{ t('settings.documents.archive.recognizeFailed') }}: {{ error }}
        </p>
      </div>
      <DialogFooter>
        <DcButton
          :disabled="!canSubmit || submitting"
          data-testid="recognize-submit"
          @click="onSubmit"
        >
          {{ t('settings.documents.archive.recognize') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@shadcn/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shadcn/components/ui/dialog'
import { DcButton } from '@dc-ui/components/button'
import { createDeviceClient } from '@api/DeviceClient'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  submitted: [count: number]
}>()

const { t } = useI18n()
const store = useDocumentsStore()
const deviceClient = createDeviceClient()

const AUTO_VALUE = '__auto__'
const selectedFiles = ref<Array<{ path: string; name: string }>>([])
const templateId = ref(AUTO_VALUE)
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => selectedFiles.value.length > 0 && !submitting.value)
const isPdfFile = computed(() =>
  selectedFiles.value.some((file) => file.path.toLowerCase().endsWith('.pdf'))
)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return
    }
    selectedFiles.value = []
    templateId.value = AUTO_VALUE
    submitting.value = false
    error.value = ''
  }
)

onMounted(() => {
  if (store.templates.length === 0) {
    void store.loadTemplates()
  }
})

async function onSelectFile() {
  try {
    const result = await deviceClient.selectFiles({
      multiple: true,
      filters: [{ name: 'Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return
    }
    const existing = new Set(selectedFiles.value.map((file) => file.path))
    for (const uri of result.filePaths) {
      if (existing.has(uri)) continue
      selectedFiles.value.push({ path: uri, name: uri.split(/[\\/]/).pop() ?? uri })
    }
    error.value = ''
  } catch (err) {
    console.error('[DocumentRecognizeDialog] select files failed', err)
  }
}

function removeFile(index: number) {
  selectedFiles.value.splice(index, 1)
}

async function onSubmit() {
  if (!canSubmit.value || submitting.value) {
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const created = await store.createRecognitionTasks({
      files: selectedFiles.value.map((file) => ({ path: file.path, name: file.name })),
      templateId: templateId.value === AUTO_VALUE ? 'auto' : templateId.value
    })
    emit('submitted', created.length)
    emit('update:open', false)
  } catch (err) {
    console.error('[DocumentRecognizeDialog] create tasks failed', err)
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>
