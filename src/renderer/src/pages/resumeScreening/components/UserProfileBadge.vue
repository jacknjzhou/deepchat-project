<template>
  <div class="flex items-center gap-2 text-sm" data-testid="user-profile-badge">
    <Icon icon="lucide:user" class="size-4 text-muted-foreground" />
    <span class="font-medium">{{ name }}</span>
    <span class="text-muted-foreground">{{ email }}</span>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
  name: string
  email: string
}>()
</script>
