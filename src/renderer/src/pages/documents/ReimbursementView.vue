<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="reimbursement-view">
    <div class="flex items-center justify-between border-b px-4 py-2">
      <h2 class="text-base font-medium">
        {{ t('settings.documents.reimbursement.viewReimbursement') }}
      </h2>
      <div class="flex items-center gap-2">
        <DcButton
          :variant="showUnassignedOnly ? 'default' : 'outline'"
          size="sm"
          data-testid="reimbursement-unassigned-only"
          @click="showUnassignedOnly = !showUnassignedOnly"
        >
          {{ t('settings.documents.reimbursement.showUnassignedOnly') }}
        </DcButton>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-manage-categories"
          @click="goConfig"
        >
          {{ t('settings.documents.reimbursement.manageCategories') }}
        </DcButton>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-export"
          :disabled="exporting"
          @click="onExport"
        >
          {{ t('settings.documents.reimbursement.export') }}
        </DcButton>
      </div>
    </div>

    <div v-if="store.reimbursementLoadError" class="flex flex-col items-center gap-3 py-6">
      <p class="text-sm text-destructive">{{ t(store.reimbursementLoadError) }}</p>
      <DcButton variant="outline" data-testid="reimbursement-retry" @click="retry">
        {{ t('settings.documents.reimbursement.retry') }}
      </DcButton>
    </div>

    <ReimbursementTree
      v-else-if="store.reimbursementTree"
      class="min-h-0 flex-1"
      :tree="store.reimbursementTree.tree"
      :unassigned="store.reimbursementTree.unassigned"
      :show-unassigned-only="showUnassignedOnly"
      @move="onMove"
    />

    <p v-else class="flex-1 py-10 text-center text-sm text-muted-foreground">
      {{
        store.reimbursementIsLoading
          ? t('settings.documents.reimbursement.loading')
          : t('settings.documents.reimbursement.treeEmpty')
      }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createConfigClient } from '@api/ConfigClient'
import { REIMBURSEMENT_UNASSIGNED } from '@shared/documents'
import { useDocumentsStore } from '@/stores/documents'
import ReimbursementTree from './ReimbursementTree.vue'

const { t } = useI18n()
const store = useDocumentsStore()
const configClient = createConfigClient()

const showUnassignedOnly = ref(false)
const exporting = ref(false)

onMounted(() => {
  void store.loadReimbursementTree()
})

function retry() {
  void store.loadReimbursementTree()
}

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[ReimbursementView] Failed to present notification', error)
  }
}

function onMove(documentId: string, value: string) {
  const categoryId =
    value === '__auto__' ? null : value === '__unassigned__' ? REIMBURSEMENT_UNASSIGNED : value
  void store.setReimbursementOverride(documentId, categoryId).catch((error: unknown) => {
    console.error('[ReimbursementView] set override failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.moveFailed',
      t('settings.documents.reimbursement.moveFailed')
    )
  })
}

function goConfig() {
  void configClient.openSettings({ routeName: 'settings-documents-reimbursement' })
}

async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await store.exportReimbursementPackage()
    if (result.canceled) return
    notifyTransient(
      'success',
      'documents.reimbursement.exportSuccess',
      t('settings.documents.reimbursement.exportDone', {
        count: result.exportedFiles ?? 0,
        path: result.path ?? ''
      })
    )
  } catch (error) {
    console.error('[ReimbursementView] export failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.exportFailed',
      t('settings.documents.reimbursement.exportFailed')
    )
  } finally {
    exporting.value = false
  }
}
</script>
