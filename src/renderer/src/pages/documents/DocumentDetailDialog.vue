<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-3xl" data-testid="document-detail-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('settings.documents.archive.detailTitle') }}</DialogTitle>
      </DialogHeader>

      <div v-if="document" class="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{{ templateName }}</span>
          <span>·</span>
          <span>{{ statusText }}</span>
          <span v-if="document.status === 'confirmed'">
            · {{ new Date(document.updatedAt).toLocaleString() }}
          </span>
        </div>

        <section class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('settings.documents.archive.fieldsTitle') }}</h3>
          <div
            v-for="state in editStates"
            :key="state.key"
            class="grid grid-cols-[10rem_1fr] items-start gap-2"
          >
            <label class="pt-2 text-sm" :for="`field-${state.key}`">
              {{ state.label }}
              <span v-if="state.entry?.uncertain" class="text-amber-500">*</span>
            </label>
            <div>
              <Select
                v-if="state.valueType === 'enum' && state.enumOptions"
                :id="`field-${state.key}`"
                :model-value="state.raw"
                @update:model-value="(value) => (state.raw = String(value))"
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in state.enumOptions" :key="option" :value="option">
                    {{ option }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                v-else-if="state.valueType === 'array'"
                :id="`field-${state.key}`"
                v-model="state.raw"
                rows="3"
                data-testid="detail-field-array"
              />
              <Input
                v-else
                :id="`field-${state.key}`"
                v-model="state.raw"
                :type="
                  state.valueType === 'number'
                    ? 'number'
                    : state.valueType === 'date'
                      ? 'date'
                      : 'text'
                "
                :data-testid="`detail-field-${state.key}`"
              />
            </div>
          </div>
          <p v-if="fieldError" class="text-xs text-destructive" data-testid="detail-field-error">
            {{ fieldError }}
          </p>
        </section>

        <section class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('settings.documents.archive.filesTitle') }}</h3>
          <p v-if="document.fileUris.length === 0" class="text-sm text-muted-foreground">
            {{ t('settings.documents.archive.noFiles') }}
          </p>
          <div v-else class="space-y-2">
            <div
              v-for="(uri, index) in document.fileUris"
              :key="uri"
              class="flex items-center gap-2 text-sm"
            >
              <Icon icon="lucide:paperclip" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate" :title="uri">{{ uri }}</span>
              <DcButton
                variant="outline"
                size="sm"
                :data-testid="`detail-preview-${index}`"
                @click="togglePreview(index)"
              >
                {{ t('settings.documents.archive.filesTitle') }}
              </DcButton>
            </div>
            <p
              v-if="previewError"
              class="text-xs text-destructive"
              data-testid="detail-preview-error"
            >
              {{ t('settings.documents.archive.previewFailed') }}
            </p>
            <img
              v-if="preview && preview.mimeType.startsWith('image/')"
              :src="`data:${preview.mimeType};base64,${preview.dataBase64}`"
              :alt="preview.name"
              class="max-h-96 rounded border"
              data-testid="detail-preview-image"
            />
            <embed
              v-else-if="preview && preview.mimeType === 'application/pdf'"
              :src="`data:application/pdf;base64,${preview.dataBase64}`"
              type="application/pdf"
              class="h-96 w-full rounded border"
              data-testid="detail-preview-pdf"
            />
          </div>
        </section>
      </div>

      <DialogFooter class="flex-wrap gap-2">
        <span
          v-if="feedback"
          class="mr-auto text-sm"
          :class="feedback.kind === 'success' ? 'text-emerald-500' : 'text-destructive'"
          data-testid="detail-feedback"
        >
          {{ feedback.text }}
        </span>
        <DcButton
          variant="outline"
          :disabled="busy"
          data-testid="detail-re-recognize"
          @click="onReRecognize"
        >
          {{ t('settings.documents.archive.reRecognize') }}
        </DcButton>
        <DcButton
          variant="outline"
          :disabled="busy"
          data-testid="detail-delete"
          @click="deleteOpen = true"
        >
          {{ t('settings.documents.archive.delete') }}
        </DcButton>
        <DcButton :disabled="busy" data-testid="detail-save" @click="onSave">
          {{ t('settings.documents.archive.save') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="deleteOpen" @update:open="(value) => (deleteOpen = value)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{
          t('settings.documents.archive.deleteConfirmTitle')
        }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ t('settings.documents.archive.deleteConfirmDescription') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel data-testid="detail-delete-cancel">{{ cancelText }}</AlertDialogCancel>
        <AlertDialogAsyncAction
          :disabled="deleting"
          data-testid="detail-delete-confirm"
          @click="onDelete"
        >
          {{ t('settings.documents.archive.delete') }}
        </AlertDialogAsyncAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import { Textarea } from '@shadcn/components/ui/textarea'
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
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shadcn/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAsyncAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@shadcn/components/ui/alert-dialog'
import { DcButton } from '@dc-ui/components/button'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentFieldEntry, DocumentRecord } from '@shared/documents'
import { buildFieldEditStates, parseFieldEditState, type FieldEditState } from './documentArchive'

interface PreviewPayload {
  dataBase64: string
  mimeType: string
  name: string
}

const props = defineProps<{
  open: boolean
  document: DocumentRecord | null
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  're-recognized': [document: DocumentRecord]
}>()

const { t } = useI18n()
const store = useDocumentsStore()

const editStates = ref<FieldEditState[]>([])
const initialRaws = new Map<string, string>()
const deleteOpen = ref(false)
const fieldError = ref<string | null>(null)
const preview = ref<PreviewPayload | null>(null)
const previewError = ref(false)
const feedback = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
const saving = ref(false)
const recognizing = ref(false)
const deleting = ref(false)

const busy = computed(() => saving.value || recognizing.value || deleting.value)
const statusText = computed(() =>
  props.document?.status === 'draft'
    ? t('settings.documents.archive.statusDraft')
    : t('settings.documents.archive.statusConfirmed')
)
const templateName = computed(() =>
  props.document ? props.document.templateSnapshot.name || props.document.typeKey : ''
)
const cancelText = computed(() => t('common.cancel'))

watch(
  () => props.document,
  (doc) => {
    editStates.value = doc ? buildFieldEditStates(doc) : []
    initialRaws.clear()
    for (const state of editStates.value) {
      initialRaws.set(state.key, state.raw)
    }
    preview.value = null
    previewError.value = false
    fieldError.value = null
  },
  { immediate: true }
)

let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function showFeedback(kind: 'success' | 'error', text: string) {
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
  }
  feedback.value = { kind, text }
  feedbackTimer = setTimeout(() => {
    feedback.value = null
    feedbackTimer = null
  }, 3000)
}

onUnmounted(() => {
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
    feedbackTimer = null
  }
})

function onSave() {
  const doc = props.document
  if (!doc || busy.value) {
    return
  }
  const fields: Record<string, DocumentFieldEntry> = {}
  for (const state of editStates.value) {
    // Untouched fields keep their original entry object so uncertain flags
    // survive confirmation untouched.
    if (state.entry && state.raw === initialRaws.get(state.key)) {
      fields[state.key] = state.entry
      continue
    }
    const parsed = parseFieldEditState(state)
    if (!parsed.ok) {
      fieldError.value =
        parsed.error === 'required'
          ? t('settings.documents.archive.fieldRequired', { label: state.label })
          : t('settings.documents.archive.saveFailed')
      return
    }
    fields[state.key] = { value: parsed.value, uncertain: false }
  }
  fieldError.value = null
  void runSave(doc.id, fields)
}

async function runSave(id: string, fields: Record<string, DocumentFieldEntry>) {
  saving.value = true
  try {
    await store.saveArchiveDocument(id, fields)
    showFeedback('success', t('settings.documents.archive.saved'))
  } catch (error) {
    console.error('[DocumentDetailDialog] save failed', error)
    showFeedback('error', t('settings.documents.archive.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function onReRecognize() {
  const doc = props.document
  if (!doc || busy.value) {
    return
  }
  if (doc.fileUris.length === 0) {
    showFeedback('error', t('settings.documents.archive.reRecognizeFailed'))
    return
  }
  recognizing.value = true
  try {
    const result = await store.recognizeDocument({
      templateId: doc.templateId,
      file: { path: doc.fileUris[0] },
      source: 'manual'
    })
    emit('re-recognized', result.document)
    showFeedback('success', t('settings.documents.archive.reRecognized'))
  } catch (error) {
    console.error('[DocumentDetailDialog] re-recognize failed', error)
    showFeedback('error', t('settings.documents.archive.reRecognizeFailed'))
  } finally {
    recognizing.value = false
  }
}

async function onDelete() {
  const doc = props.document
  if (!doc || busy.value) {
    return
  }
  deleting.value = true
  try {
    await store.removeArchiveDocument(doc.id)
    deleteOpen.value = false
    emit('update:open', false)
  } catch (error) {
    console.error('[DocumentDetailDialog] delete failed', error)
    showFeedback('error', t('settings.documents.archive.deleteFailed'))
  } finally {
    deleting.value = false
  }
}

async function togglePreview(index: number) {
  const doc = props.document
  if (!doc) {
    return
  }
  try {
    previewError.value = false
    preview.value = await store.previewArchiveFile(doc.id, index)
  } catch (error) {
    console.error('[DocumentDetailDialog] preview failed', error)
    preview.value = null
    previewError.value = true
  }
}
</script>
