<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="max-w-sm" data-testid="user-profile-dialog">
      <DialogHeader>
        <DialogTitle>{{ t('resumeScreening.profileDialogTitle') }}</DialogTitle>
        <DialogDescription>{{ t('resumeScreening.profileDialogDescription') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1">
          <label class="text-sm font-medium" for="user-profile-name">
            {{ t('resumeScreening.profileNameLabel') }}
          </label>
          <Input
            id="user-profile-name"
            v-model="formName"
            :placeholder="t('resumeScreening.profileNamePlaceholder')"
            data-testid="profile-name-input"
          />
        </div>
        <div class="space-y-1">
          <label class="text-sm font-medium" for="user-profile-email">
            {{ t('resumeScreening.profileEmailLabel') }}
          </label>
          <Input
            id="user-profile-email"
            v-model="formEmail"
            :placeholder="t('resumeScreening.profileEmailPlaceholder')"
            data-testid="profile-email-input"
          />
          <p v-if="emailError" class="text-xs text-destructive" data-testid="profile-email-error">
            {{ emailError }}
          </p>
        </div>
        <p v-if="saveError" class="text-sm text-destructive" data-testid="profile-save-error">
          {{ saveError }}
        </p>
      </div>
      <DialogFooter>
        <DcButton
          variant="outline"
          :disabled="saving"
          data-testid="profile-cancel"
          @click="emit('update:open', false)"
        >
          {{ t('resumeScreening.profileCancel') }}
        </DcButton>
        <DcButton :disabled="!canSave || saving" data-testid="profile-save" @click="onSave">
          {{ t('resumeScreening.profileSave') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@shadcn/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shadcn/components/ui/dialog'
import { DcButton } from '@dc-ui/components/button'
import { useResumeScreeningStore } from '@/stores/resumeScreening'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

const { t } = useI18n()
const store = useResumeScreeningStore()

const formName = ref('')
const formEmail = ref('')
const saving = ref(false)
const saveError = ref('')

// 邮箱可空；非空时做轻量格式校验（本地提示用，契约校验以主进程为准）
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const emailError = computed(() => {
  const email = formEmail.value.trim()
  if (!email || EMAIL_PATTERN.test(email)) return ''
  return t('resumeScreening.profileEmailInvalid')
})

const canSave = computed(() => formName.value.trim().length > 0 && emailError.value === '')

// 每次打开都用当前档案重置表单与错误态
watch(
  () => props.open,
  (open) => {
    if (!open) return
    formName.value = store.profile?.name ?? ''
    formEmail.value = store.profile?.email ?? ''
    saving.value = false
    saveError.value = ''
  },
  { immediate: true }
)

async function onSave() {
  if (!canSave.value || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    await store.saveProfile({ name: formName.value.trim(), email: formEmail.value.trim() })
    emit('update:open', false)
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}
</script>
