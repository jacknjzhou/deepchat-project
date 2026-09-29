import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'

const storeState = vi.hoisted(() => ({
  profile: { name: '张三', email: 'z@example.com' }
}))

const saveProfile = vi.hoisted(() => vi.fn())

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.doMock('@/stores/resumeScreening', () => ({
  useResumeScreeningStore: () => ({ profile: storeState.profile, saveProfile })
}))
vi.doMock('@shadcn/components/ui/dialog', () => ({
  Dialog: defineComponent({
    name: 'Dialog',
    props: { open: { type: Boolean, default: false } },
    emits: ['update:open'],
    template: '<div v-if="open"><slot /></div>'
  }),
  DialogContent: defineComponent({ name: 'DialogContent', template: '<div><slot /></div>' }),
  DialogHeader: defineComponent({ name: 'DialogHeader', template: '<div><slot /></div>' }),
  DialogTitle: defineComponent({ name: 'DialogTitle', template: '<h2><slot /></h2>' }),
  DialogDescription: defineComponent({ name: 'DialogDescription', template: '<p><slot /></p>' }),
  DialogFooter: defineComponent({ name: 'DialogFooter', template: '<div><slot /></div>' })
}))
vi.doMock('@shadcn/components/ui/input', () => ({
  Input: defineComponent({
    name: 'Input',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  })
}))
vi.doMock('@dc-ui/components/button', () => ({
  DcButton: defineComponent({
    name: 'DcButton',
    props: ['variant', 'disabled'],
    emits: ['click'],
    template:
      '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
  })
}))

async function setup(open = true) {
  const { default: UserProfileDialog } =
    await import('@/pages/resumeScreening/components/UserProfileDialog.vue')
  return mount(UserProfileDialog, { props: { open } })
}

describe('UserProfileDialog', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
    storeState.profile = { name: '张三', email: 'z@example.com' }
    saveProfile.mockReset()
  })

  it('打开时用当前档案初始化姓名/邮箱输入', async () => {
    wrapper = await setup()
    expect(
      (wrapper.get('[data-testid="profile-name-input"]').element as HTMLInputElement).value
    ).toBe('张三')
    expect(
      (wrapper.get('[data-testid="profile-email-input"]').element as HTMLInputElement).value
    ).toBe('z@example.com')
  })

  it('姓名为空时保存按钮禁用', async () => {
    wrapper = await setup()
    await wrapper.get('[data-testid="profile-name-input"]').setValue('')
    expect(wrapper.get('[data-testid="profile-save"]').attributes('disabled')).toBeDefined()
    expect(saveProfile).not.toHaveBeenCalled()
  })

  it('邮箱非法时显示格式错误且禁保存，邮箱为空允许保存', async () => {
    wrapper = await setup()
    await wrapper.get('[data-testid="profile-email-input"]').setValue('not-an-email')
    expect(wrapper.find('[data-testid="profile-email-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="profile-save"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="profile-email-input"]').setValue('')
    expect(wrapper.find('[data-testid="profile-email-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="profile-save"]').attributes('disabled')).toBeUndefined()
  })

  it('保存成功时上抛 trim 后的档案并关闭对话框', async () => {
    saveProfile.mockResolvedValue({ name: '李四', email: 'li@example.com' })
    wrapper = await setup()
    await wrapper.get('[data-testid="profile-name-input"]').setValue('  李四  ')
    await wrapper.get('[data-testid="profile-email-input"]').setValue(' li@example.com ')
    await wrapper.get('[data-testid="profile-save"]').trigger('click')
    await flushPromises()

    expect(saveProfile).toHaveBeenCalledWith({ name: '李四', email: 'li@example.com' })
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('保存失败时显示错误并保持对话框打开', async () => {
    saveProfile.mockRejectedValue(new Error('保存失败'))
    wrapper = await setup()
    await wrapper.get('[data-testid="profile-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="profile-save-error"]').text()).toContain('保存失败')
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })
})
