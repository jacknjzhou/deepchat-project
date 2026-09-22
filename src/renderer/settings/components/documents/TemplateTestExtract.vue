<template>
  <Collapsible v-model:open="open" class="rounded-lg border bg-muted/10">
    <CollapsibleTrigger as-child>
      <DcButton
        variant="ghost"
        class="flex h-auto w-full items-center justify-between rounded-lg p-4"
        data-testid="test-toggle"
      >
        <div class="min-w-0 text-start">
          <div class="text-sm font-medium">{{ t('settings.documents.test.title') }}</div>
          <p class="mt-1 text-xs font-normal text-muted-foreground">
            {{ t('settings.documents.test.description') }}
          </p>
        </div>
        <Icon
          :icon="open ? 'lucide:chevron-up' : 'lucide:chevron-down'"
          class="ml-3 size-4 shrink-0 text-muted-foreground"
        />
      </DcButton>
    </CollapsibleTrigger>
    <CollapsibleContent class="border-t p-4 space-y-3">
      <div v-if="!templateId" class="text-sm text-muted-foreground">
        {{ t('settings.documents.editor.testCreateModeHint') }}
      </div>
      <template v-else>
        <div class="flex items-center gap-3">
          <input
            ref="fileInputRef"
            type="file"
            class="hidden"
            accept="image/*,application/pdf"
            @change="onFileChange"
          />
          <DcButton
            variant="outline"
            size="sm"
            :disabled="isRunning"
            data-testid="test-select-file"
            @click="triggerFilePicker"
          >
            <Icon icon="lucide:upload" class="mr-2 size-4" />
            {{ fileName ?? t('settings.documents.test.selectFile') }}
          </DcButton>
          <span v-if="isRunning" class="text-sm text-muted-foreground">
            {{ t('settings.documents.test.running') }}
          </span>
        </div>
        <Alert v-if="error" variant="destructive">
          <Icon icon="lucide:circle-alert" class="size-4" />
          <AlertDescription>
            {{
              error === 'fileRequired'
                ? t('settings.documents.test.fileRequired')
                : t('settings.documents.test.failed')
            }}
          </AlertDescription>
        </Alert>
        <div v-if="result" class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{{ routeLabel }}</Badge>
            <span>{{ t('settings.documents.test.duration', { ms: result.meta.durationMs }) }}</span>
          </div>
          <ul v-if="result.meta.issues.length > 0" class="text-xs text-muted-foreground">
            <li v-for="(issue, idx) in result.meta.issues" :key="idx">{{ issue }}</li>
          </ul>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left">
                  <th class="py-2 pr-4">{{ t('settings.documents.test.fieldHeader') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.documents.test.valueHeader') }}</th>
                  <th class="py-2">{{ t('settings.documents.test.statusHeader') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="field in result.fields"
                  :key="field.key"
                  class="border-b"
                  :class="{ 'bg-amber-50 dark:bg-amber-950/30': field.uncertain }"
                >
                  <td class="py-2 pr-4 font-mono">{{ field.key }}</td>
                  <td class="py-2 pr-4">{{ formatValue(field.value) }}</td>
                  <td class="py-2">
                    <Badge v-if="field.uncertain" variant="outline">
                      {{ t('settings.documents.test.uncertain') }}
                    </Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p v-else-if="!isRunning" class="text-sm text-muted-foreground">
          {{ t('settings.documents.test.empty') }}
        </p>
      </template>
    </CollapsibleContent>
  </Collapsible>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@shadcn/components/ui/collapsible'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Badge } from '@shadcn/components/ui/badge'
import { DcButton } from '@dc-ui/components/button'
import { createFileClient } from '@api/FileClient'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{ templateId?: string }>()

const { t } = useI18n()
const store = useDocumentsStore()
const fileClient = createFileClient()
const open = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const fileName = ref<string | null>(null)
const isRunning = ref(false)
const error = ref<'failed' | 'fileRequired' | null>(null)
const result = ref<Awaited<ReturnType<typeof store.testExtract>> | null>(null)

const routeLabel = computed(() => {
  if (!result.value) return ''
  const route = result.value.meta.route
  return t(`settings.documents.test.route${route[0].toUpperCase()}${route.slice(1)}`)
})

function triggerFilePicker() {
  fileInputRef.value?.click()
}

async function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  const path = fileClient.getPathForFile(file)
  if (!path) {
    error.value = 'fileRequired'
    return
  }
  fileName.value = file.name
  isRunning.value = true
  error.value = null
  result.value = null
  try {
    result.value = await store.testExtract({
      templateId: props.templateId!,
      file: { path, name: file.name, mimeType: file.type }
    })
  } catch (e) {
    console.error('[TemplateTestExtract] failed', e)
    error.value = 'failed'
  } finally {
    isRunning.value = false
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
</script>
