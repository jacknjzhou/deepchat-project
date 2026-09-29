import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, inject, provide, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'

const configMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => configMocks
}))

vi.mock('pinia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pinia')>())
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    props: { icon: { type: String, default: '' } },
    template: '<i :data-icon="icon" />'
  })
}))

vi.mock('@dc-ui/components/button', () => ({
  DcButton: defineComponent({
    name: 'DcButton',
    props: {
      label: { type: String, default: '' },
      icon: { type: String, default: '' }
    },
    template: '<button type="button" :data-icon="icon" :data-label="label"><slot /></button>'
  })
}))

vi.mock('@dc-ui/components/confirm-dialog', () => ({
  DcConfirmDialog: defineComponent({
    name: 'DcConfirmDialog',
    props: {
      open: { type: Boolean, default: false },
      title: { type: String, default: '' },
      description: { type: String, default: '' }
    },
    emits: ['confirm', 'cancel', 'update:open'],
    template: `<div v-if="open" data-testid="confirm-dialog">
      <button data-testid="confirm-dialog-confirm" @click="$emit('confirm')"></button>
      <button data-testid="confirm-dialog-cancel" @click="$emit('update:open', false)"></button>
    </div>`
  })
}))

const popoverContextKey = vi.hoisted(() => Symbol('PopoverContext'))

vi.mock('@shadcn/components/ui/popover', () => ({
  Popover: defineComponent({
    name: 'Popover',
    props: { open: { type: Boolean, default: false } },
    emits: ['update:open'],
    setup(props, { emit, slots }) {
      provide(popoverContextKey, {
        open: computed(() => props.open),
        setOpen: (open: boolean) => emit('update:open', open)
      })
      return () => h('div', { 'data-open': String(props.open) }, slots.default?.())
    }
  }),
  PopoverContent: defineComponent({
    name: 'PopoverContent',
    setup(_props, { slots }) {
      const context = inject<any>(popoverContextKey)
      return () => (context?.open.value ? h('div', {}, slots.default?.()) : null)
    }
  }),
  PopoverTrigger: defineComponent({
    name: 'PopoverTrigger',
    setup(_props, { slots }) {
      const context = inject<any>(popoverContextKey)
      return () => h('div', { onClick: () => context?.setOpen(true) }, slots.default?.())
    }
  })
}))

const tabsContextKey = vi.hoisted(() => Symbol('TabsContext'))

vi.mock('@shadcn/components/ui/tabs', () => ({
  Tabs: defineComponent({
    name: 'Tabs',
    props: { defaultValue: { type: String, default: '' } },
    setup(props, { slots }) {
      const active = ref(props.defaultValue)
      provide(tabsContextKey, {
        active: computed(() => active.value),
        setActive: (value: string) => {
          active.value = value
        }
      })
      return () => h('div', {}, slots.default?.())
    }
  }),
  TabsList: defineComponent({
    name: 'TabsList',
    setup(_props, { slots }) {
      return () => h('div', {}, slots.default?.())
    }
  }),
  TabsTrigger: defineComponent({
    name: 'TabsTrigger',
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      const context = inject<any>(tabsContextKey)
      return () =>
        h(
          'div',
          {
            'data-state': context?.active.value === props.value ? 'active' : 'inactive',
            onClick: () => context?.setActive(props.value)
          },
          slots.default?.()
        )
    }
  }),
  TabsContent: defineComponent({
    name: 'TabsContent',
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      const context = inject<any>(tabsContextKey)
      return () => (context?.active.value === props.value ? h('div', {}, slots.default?.()) : null)
    }
  })
}))

const selectContextKey = vi.hoisted(() => Symbol('SelectContext'))

vi.mock('@shadcn/components/ui/select', () => ({
  Select: defineComponent({
    name: 'Select',
    props: { modelValue: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup(props, { slots }) {
      provide(selectContextKey, {
        open: computed(() => false),
        setOpen: () => {},
        modelValue: computed(() => props.modelValue),
        setModelValue: (value: string) => emit('update:modelValue', value)
      })
      return () => h('div', {}, slots.default?.())
    }
  }),
  SelectTrigger: defineComponent({
    name: 'SelectTrigger',
    setup(_props, { slots }) {
      return () => h('button', { type: 'button' }, slots.default?.())
    }
  }),
  SelectValue: defineComponent({
    name: 'SelectValue',
    props: { placeholder: { type: String, default: '' } },
    setup(props) {
      const context = inject<any>(selectContextKey)
      return () => h('span', {}, context?.modelValue.value || props.placeholder)
    }
  }),
  SelectContent: defineComponent({
    name: 'SelectContent',
    setup(_props, { slots }) {
      const context = inject<any>(selectContextKey)
      return () => (context?.open.value ? h('div', {}, slots.default?.()) : null)
    }
  }),
  SelectItem: defineComponent({
    name: 'SelectItem',
    props: { value: { type: String, required: true } },
    setup(props, { slots }) {
      const context = inject<any>(selectContextKey)
      return () =>
        h('div', { onClick: () => context?.setModelValue(props.value) }, slots.default?.())
    }
  })
}))

import type { UserImagePromptTemplate } from '@shared/imagePromptTemplates'

const storedTemplate = (
  overrides: Partial<UserImagePromptTemplate> = {}
): UserImagePromptTemplate => ({
  id: 'tpl-1',
  title: '已存范本',
  prompt: 'stored prompt',
  createdAt: 1700000000000,
  ...overrides
})

const mountButton = async (): Promise<VueWrapper> => {
  const { default: ImagePromptTemplateButton } =
    await import('@/components/chat-input/ImagePromptTemplateButton.vue')
  return mount(ImagePromptTemplateButton, {
    global: {
      plugins: [createPinia()],
      stubs: { teleport: true }
    }
  })
}

const openPanel = async (wrapper: VueWrapper) => {
  await wrapper.get('[data-testid="image-template-button"]').trigger('click')
  await flushPromises()
}

const openMineTab = async (wrapper: VueWrapper) => {
  await wrapper.get('[data-testid="image-template-tab-mine"]').trigger('click')
  await flushPromises()
}

describe('ImagePromptTemplateButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMocks.getSetting.mockResolvedValue([])
    configMocks.setSetting.mockResolvedValue(undefined)
  })

  it('精选 tab 渲染 7 张内置卡片并发出 apply-template', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    const cards = wrapper.findAll('[data-testid="image-template-card"]')
    expect(cards).toHaveLength(7)
    await cards[2].trigger('click')
    expect(wrapper.emitted('apply-template')).toEqual([
      [
        {
          prompt: 'chat.imageTemplates.builtin.poster.prompt',
          size: '1024x1536',
          quality: 'high'
        }
      ]
    ])
    wrapper.unmount()
  })

  it('我的 tab 新建范本并持久化', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    await wrapper.get('[data-testid="image-template-add"]').trigger('click')
    await wrapper.get('[data-testid="image-template-form-title"]').setValue('我的范本')
    await wrapper.get('[data-testid="image-template-form-prompt"]').setValue('red apple')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    await flushPromises()
    expect(configMocks.setSetting).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('表单校验：先缺标题后缺提示词，不持久化', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    await wrapper.get('[data-testid="image-template-add"]').trigger('click')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    expect(wrapper.text()).toContain('chat.imageTemplates.titleRequired')
    await wrapper.get('[data-testid="image-template-form-title"]').setValue('只有标题')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    expect(wrapper.text()).toContain('chat.imageTemplates.promptRequired')
    expect(configMocks.setSetting).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('删除需确认，确认后持久化空列表', async () => {
    configMocks.getSetting.mockResolvedValue([storedTemplate()])
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(1)
    await wrapper.get('[data-testid="image-template-delete"]').trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true)
    await wrapper.get('[data-testid="confirm-dialog-confirm"]').trigger('click')
    await flushPromises()
    expect(configMocks.setSetting).toHaveBeenCalledWith('user_image_prompt_templates', [])
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('达到上限后隐藏新增按钮并显示上限提示', async () => {
    configMocks.getSetting.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `tpl-${i}`,
        title: `范本${i}`,
        prompt: 'p',
        createdAt: i + 1
      }))
    )
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    expect(wrapper.find('[data-testid="image-template-add"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="image-template-limit"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(50)
    wrapper.unmount()
  })
})
