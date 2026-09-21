<template>
  <ImageNode
    v-if="!usesLocalProtocol"
    :node="props.node"
    :fallback-src="props.fallbackSrc"
    :lazy="props.lazy"
    :use-placeholder="props.usePlaceholder"
    @load="(src: string) => emit('load', src)"
    @error="(src: string) => emit('error', src)"
    @click="(payload: [Event, string]) => emit('click', payload)"
  />
  <span v-else class="dc-markdown-image-node">
    <img
      v-if="showImage"
      :src="props.node.src"
      :alt="props.node.alt ?? ''"
      :title="props.node.title ?? props.node.alt ?? ''"
      decoding="async"
      @load="handleLoad"
      @error="handleError"
      @click="handleClick"
    />
    <span v-else-if="hasFailed" class="dc-markdown-image-node__error">
      <Icon icon="lucide:image-off" class="size-4 shrink-0" />
      <span>{{ t('image.loadError') }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { ImageNode } from 'markstream-vue'

// Mirrors markstream's ImageNodeProps; written inline so the SFC compiler can
// resolve it without importing from node_modules.
const props = defineProps<{
  node: {
    type: 'image'
    src: string
    alt: string
    title: string | null
    raw: string
    loading?: boolean
  }
  fallbackSrc?: string
  lazy?: boolean
  usePlaceholder?: boolean
}>()

const emit = defineEmits<{
  load: [src: string]
  error: [src: string]
  click: [payload: [Event, string]]
}>()

const { t } = useI18n()

// markstream's URL sanitizer only whitelists http/https for <img src>, so
// DeepChat-only protocols like imgcache:// get stripped to an empty src and the
// built-in node jumps straight to its error state. Render those sources here
// and defer everything else to the built-in node.
const DEECHAT_IMAGE_PROTOCOLS = ['imgcache://'] as const

const usesLocalProtocol = computed(() => {
  const src = props.node.src?.trim() ?? ''
  return DEECHAT_IMAGE_PROTOCOLS.some((protocol) => src.toLowerCase().startsWith(protocol))
})

const hasFailed = ref(false)

// A new source should get a fresh load attempt after streaming updates.
watch(
  () => props.node.src,
  () => {
    hasFailed.value = false
  }
)

const showImage = computed(
  () => Boolean(props.node.src) && props.node.loading !== true && !hasFailed.value
)

const handleLoad = () => {
  hasFailed.value = false
  emit('load', props.node.src)
}

const handleError = () => {
  hasFailed.value = true
  emit('error', props.node.src)
}

const handleClick = (event: Event) => {
  if (!hasFailed.value) {
    emit('click', [event, props.node.src])
  }
}
</script>

<style scoped>
.dc-markdown-image-node img {
  max-width: 100%;
  height: auto;
  border-radius: 0.375rem;
}

.dc-markdown-image-node__error {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
  color: hsl(var(--destructive));
}
</style>
