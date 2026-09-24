<template>
  <SettingsPageShell
    :title="t('routes.settings-documents')"
    :description="t('settings.documents.description')"
    data-testid="documents-settings-page"
  >
    <div class="mb-4 flex justify-end">
      <DcButton variant="default" size="sm" data-testid="template-create" @click="createNew">
        <Icon icon="lucide:plus" class="mr-2 size-4" />
        {{ t('settings.documents.templates.create') }}
      </DcButton>
    </div>

    <Alert v-if="store.loadError" variant="destructive" class="mb-4">
      <Icon icon="lucide:circle-alert" class="size-4" />
      <AlertDescription class="flex items-center gap-3">
        <span>{{ t('settings.documents.templates.loadFailed') }}</span>
        <DcButton variant="outline" size="sm" data-testid="retry-load" @click="store.loadTemplates">
          <Icon icon="lucide:refresh-cw" class="mr-2 size-4" />
          {{ t('settings.documents.templates.retry') }}
        </DcButton>
      </AlertDescription>
    </Alert>

    <div v-if="store.isLoading" class="flex items-center text-sm text-muted-foreground">
      <Spinner class="mr-2 size-4" />
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <SettingsSectionCard
        v-for="group in builtinGroups"
        :key="group.category"
        :title="t(`settings.documents.category.${categoryKey(group.category)}`)"
        class="mb-4"
      >
        <div
          class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="builtin-group"
        >
          <div v-for="template in group.templates" :key="template.id" class="rounded-lg border p-4">
            <div class="flex items-start justify-between">
              <div>
                <div class="font-medium">{{ template.name }}</div>
                <div class="text-xs text-muted-foreground">
                  {{
                    t('settings.documents.templates.fieldCount', { count: template.fields.length })
                  }}
                </div>
              </div>
              <Icon
                :icon="template.icon ?? 'lucide:file-text'"
                class="size-5 text-muted-foreground"
              />
            </div>
            <div class="mt-3 flex gap-2">
              <DcButton
                variant="outline"
                size="sm"
                data-testid="template-view"
                @click="edit(template.id)"
              >
                {{ t('settings.documents.templates.view') }}
              </DcButton>
              <DcButton
                variant="ghost"
                size="sm"
                data-testid="template-fork"
                @click="fork(template.id)"
              >
                <Icon icon="lucide:copy" class="mr-1 size-4" />
                {{ t('settings.documents.templates.fork') }}
              </DcButton>
            </div>
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        :title="t('settings.documents.templates.customGroup')"
        data-testid="custom-group"
      >
        <div v-if="store.customTemplates.length === 0" class="text-sm text-muted-foreground">
          {{ t('settings.documents.templates.empty') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="template in store.customTemplates"
            :key="template.id"
            class="flex items-center justify-between rounded-lg border p-3"
          >
            <div>
              <div class="font-medium">{{ template.name }}</div>
              <div class="text-xs text-muted-foreground">
                {{
                  t('settings.documents.templates.fieldCount', { count: template.fields.length })
                }}
              </div>
            </div>
            <div class="flex gap-2">
              <DcButton
                variant="outline"
                size="sm"
                data-testid="template-edit"
                @click="edit(template.id)"
              >
                <Icon icon="lucide:pencil" class="mr-1 size-4" />
                {{ t('settings.documents.templates.edit') }}
              </DcButton>
              <DcButton
                variant="ghost"
                size="sm"
                data-testid="template-delete"
                @click="requestDelete(template)"
              >
                <Icon icon="lucide:trash-2" class="mr-1 size-4" />
                {{ t('settings.documents.templates.delete') }}
              </DcButton>
            </div>
          </div>
        </div>
      </SettingsSectionCard>
    </template>

    <AlertDialog v-model:open="deleteConfirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ deleteDialogTitle }}</AlertDialogTitle>
          <AlertDialogDescription>{{ deleteDialogDescription }}</AlertDialogDescription>
        </AlertDialogHeader>
        <p v-if="deleteErrorKey" class="text-sm text-destructive" data-testid="delete-error">
          {{ t(deleteErrorKey) }}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-cancel">
            {{ t('common.cancel') }}
          </AlertDialogCancel>
          <AlertDialogAsyncAction
            :disabled="isDeleting"
            data-testid="delete-confirm"
            @click="confirmDelete"
          >
            {{ t('common.confirm') }}
          </AlertDialogAsyncAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Spinner } from '@shadcn/components/ui/spinner'
import { DcButton } from '@dc-ui/components/button'
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
import SettingsPageShell from './control-center/SettingsPageShell.vue'
import SettingsSectionCard from './control-center/SettingsSectionCard.vue'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentTemplate } from '@shared/documents'
import { DOCUMENT_TEMPLATE_CATEGORIES, type DocumentTemplateCategory } from '@shared/documents'

const { t } = useI18n()
const router = useRouter()
const store = useDocumentsStore()

const deleteConfirmOpen = ref(false)
const pendingDelete = ref<DocumentTemplate | null>(null)
const isDeleting = ref(false)
const forceRequired = ref<{ count: number } | null>(null)
const deleteErrorKey = ref<string | null>(null)

const builtinGroups = computed(() => {
  const groups: Array<{ category: DocumentTemplateCategory; templates: DocumentTemplate[] }> = []
  for (const category of DOCUMENT_TEMPLATE_CATEGORIES) {
    const templates = store.builtinTemplates.filter((t) => t.category === category)
    if (templates.length > 0) {
      groups.push({ category, templates })
    }
  }
  return groups
})

const deleteDialogTitle = computed(() => {
  if (!pendingDelete.value) return ''
  return t('settings.documents.templates.deleteConfirmTitle')
})

const deleteDialogDescription = computed(() => {
  if (!pendingDelete.value) return ''
  if (forceRequired.value) {
    return t('settings.documents.templates.deleteForceDescription', {
      count: forceRequired.value.count
    })
  }
  return t('settings.documents.templates.deleteConfirmDescription', {
    name: pendingDelete.value.name
  })
})

function categoryKey(category: DocumentTemplateCategory): string {
  const map: Record<DocumentTemplateCategory, string> = {
    合同类: 'contract',
    出行票据类: 'travel',
    采购类: 'purchase',
    支付凭证类: 'payment',
    发票类: 'invoice',
    财务类: 'finance',
    资产类: 'asset',
    行政类: 'admin',
    人事类: 'hr',
    招投标类: 'tender',
    自定义: 'custom'
  }
  return map[category] ?? 'custom'
}

function edit(id: string) {
  router.push({
    name: 'settings-documents-template',
    params: { id }
  })
}

function fork(sourceId: string) {
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' },
    query: { forkFrom: sourceId }
  })
}

function createNew() {
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' }
  })
}

function requestDelete(template: DocumentTemplate) {
  pendingDelete.value = template
  forceRequired.value = null
  deleteErrorKey.value = null
  deleteConfirmOpen.value = true
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  isDeleting.value = true
  try {
    const result = await store.attemptDelete(
      pendingDelete.value.id,
      forceRequired.value ? { force: true } : {}
    )
    if (result.kind === 'force-required') {
      forceRequired.value = { count: result.referenceCount }
      // keep dialog open for second confirmation
      return
    }
    if (result.kind === 'rejected') {
      // keep dialog open so the user can cancel or retry the confirmation
      deleteErrorKey.value = result.messageKey
      return
    }
    deleteConfirmOpen.value = false
    pendingDelete.value = null
    forceRequired.value = null
    deleteErrorKey.value = null
  } catch {
    // error already captured by store
  } finally {
    isDeleting.value = false
  }
}

watch(deleteConfirmOpen, (open) => {
  if (!open) {
    deleteErrorKey.value = null
  }
})

onMounted(() => {
  if (store.templates.length === 0) {
    store.loadTemplates()
  }
})
</script>
