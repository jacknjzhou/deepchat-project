<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('settings.provider.dialog.duplicate.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('settings.provider.dialog.duplicate.description', { name: t(sourceProvider?.name ?? '') }) }}
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4 py-2">
        <div class="grid gap-2">
          <Label for="instance-label">
            {{ t('settings.provider.dialog.duplicate.instanceLabel') }}
          </Label>
          <Input
            id="instance-label"
            v-model="instanceLabel"
            :placeholder="t('settings.provider.dialog.duplicate.instanceLabelPlaceholder')"
            class="h-9"
            @keydown.enter="handleConfirm"
          />
          <p class="text-xs text-muted-foreground">
            {{ t('settings.provider.dialog.duplicate.instanceLabelHint') }}
          </p>
        </div>

        <div class="rounded-md bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
          <div class="flex items-start gap-2">
            <Icon icon="lucide:alert-triangle" class="h-4 w-4 shrink-0 mt-0.5" />
            <span>{{ t('settings.provider.dialog.duplicate.securityHint') }}</span>
          </div>
        </div>
      </div>

      <DialogFooter>
        <DcButton variant="outline" @click="handleCancel">
          {{ t('dialog.cancel') }}
        </DcButton>
        <DcButton :disabled="isSubmitting" @click="handleConfirm">
          <Icon v-if="isSubmitting" icon="lucide:loader-2" class="mr-2 h-4 w-4 animate-spin" />
          {{ t('settings.provider.dialog.duplicate.confirm') }}
        </DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shadcn/components/ui/dialog'
import { Input } from '@shadcn/components/ui/input'
import { Label } from '@shadcn/components/ui/label'
import { DcButton } from '@dc-ui/components/button'
import type { LLM_PROVIDER } from '@shared/types/provider'

const props = defineProps<{
  sourceProvider: LLM_PROVIDER | null
}>()

const emit = defineEmits<{
  (e: 'confirm', label: string): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

const open = defineModel<boolean>('open', { default: false })
const instanceLabel = ref('')
const isSubmitting = ref(false)

watch(
  () => props.sourceProvider,
  () => {
    instanceLabel.value = ''
    isSubmitting.value = false
  },
  { immediate: true }
)

const handleCancel = () => {
  open.value = false
  emit('cancel')
}

const handleConfirm = () => {
  if (isSubmitting.value) return
  isSubmitting.value = true
  emit('confirm', instanceLabel.value.trim())
}

const markDone = () => {
  isSubmitting.value = false
  open.value = false
}

defineExpose({
  markDone
})
</script>
