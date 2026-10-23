<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'

/**
 * 知识可能过期的提示条。
 *
 * 只处理「同步失败」这一种状态：`staleReason` 为 null 时整条不渲染。
 * 三种原因对应三种用户动作，措辞必须区分开，否则用户不知道要不要动手。
 */
const props = defineProps<{
  knowledgeBaseId: string
  staleReason: string | null
  lastSyncAt: number | null
}>()

const { t } = useI18n()

type BannerShape = { messageKey: string; actionKey: string | null }

const shape = computed<BannerShape | null>(() => {
  const reason = props.staleReason
  if (reason === null) return null

  // 401/403 与 NO_EMBEDDING_MODEL 是用户可自行解决的，需要给出动作指引；
  // 其余（网络、部分失败、索引失败）后台会重试，不该让用户去找按钮。
  if (reason === 'NO_EMBEDDING_MODEL') {
    return {
      messageKey: 'digitalEmployee.knowledge.noEmbedding',
      actionKey: 'digitalEmployee.knowledge.noEmbeddingAction'
    }
  }
  if (reason === 'HTTP_401' || reason === 'HTTP_403') {
    return {
      messageKey: 'digitalEmployee.knowledge.unauthorized',
      actionKey: 'digitalEmployee.knowledge.unauthorizedAction'
    }
  }
  if (reason === 'UNREACHABLE') {
    return { messageKey: 'digitalEmployee.knowledge.unreachable', actionKey: null }
  }
  // 含未知码：一律回落通用文案，绝不把原始 code 显示给用户。
  return { messageKey: 'digitalEmployee.knowledge.stale', actionKey: null }
})
</script>

<template>
  <div
    v-if="shape"
    data-testid="knowledge-stale-banner"
    class="flex w-full items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
  >
    <Icon icon="lucide:triangle-alert" class="mt-0.5 size-3.5 shrink-0" />
    <div class="min-w-0 flex-1">
      <p class="leading-5">{{ t(shape.messageKey, { knowledgeBaseId }) }}</p>
      <p
        v-if="shape.actionKey"
        data-testid="knowledge-stale-action"
        class="mt-0.5 leading-5 opacity-80"
      >
        {{ t(shape.actionKey) }}
      </p>
    </div>
  </div>
</template>
