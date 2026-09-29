<template>
  <button
    type="button"
    class="flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted"
    :title="t('resumeScreening.profileEdit')"
    data-testid="user-profile-badge"
    @click="emit('edit')"
  >
    <Icon icon="lucide:user" class="size-4 text-muted-foreground" />
    <span class="font-medium">{{ name }}</span>
    <span class="text-muted-foreground">{{ email }}</span>
    <Icon icon="lucide:pencil" class="size-3.5 text-muted-foreground" />
  </button>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'

defineProps<{
  name: string
  email: string
}>()

const emit = defineEmits<{
  edit: []
}>()

const { t } = useI18n()
</script>
