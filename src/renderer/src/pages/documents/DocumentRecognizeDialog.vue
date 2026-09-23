<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-lg" data-testid="document-recognize-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('settings.documents.archive.newRecognition') }}</DialogTitle>
        <DialogDescription>{{ t('settings.documents.archive.reRecognizeHint') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1">
          <span class="text-sm font-medium">{{ t('settings.documents.archive.selectFile') }}</span>
          <div class="flex items-center gap-2">
            <Input
              :model-value="fileName ?? t('settings.documents.archive.filePlaceholder')"
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
              <SelectItem v-for="tpl in store.templates" :key="tpl.id" :value="tpl.id">
                {{ tpl.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
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
          {{ submitText }}
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
import type { DocumentRecord } from '@shared/documents'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  recognized: [document: DocumentRecord]
}>()

const { t } = useI18n()
const store = useDocumentsStore()
const deviceClient = createDeviceClient()

const filePath = ref('')
const fileName = ref<string | null>(null)
const templateId = ref(store.templates[0]?.id ?? '')
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => Boolean(filePath.value && templateId.value))
const submitText = computed(() =>
  submitting.value
    ? t('settings.documents.archive.recognizing')
    : t('settings.documents.archive.recognize')
)

function fillDefaultTemplateId() {
  if (!templateId.value) {
    templateId.value = store.templates[0]?.id ?? ''
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return
    }
    submitting.value = false
    error.value = ''
    fillDefaultTemplateId()
  }
)

watch(
  () => store.templates,
  () => {
    fillDefaultTemplateId()
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
      multiple: false,
      filters: [{ name: 'Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }]
    })
    if (result.canceled || !result.filePaths[0]) {
      return
    }
    const uri = result.filePaths[0]
    filePath.value = uri
    fileName.value = uri.split(/[\\/]/).pop() ?? uri
    error.value = ''
  } catch (err) {
    console.error('[DocumentRecognizeDialog] select file failed', err)
  }
}

async function onSubmit() {
  if (!canSubmit.value || submitting.value) {
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const result = await store.recognizeDocument({
      templateId: templateId.value,
      file: { path: filePath.value },
      source: 'manual'
    })
    emit('recognized', result.document)
    emit('update:open', false)
  } catch (err) {
    console.error('[DocumentRecognizeDialog] recognize failed', err)
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>
