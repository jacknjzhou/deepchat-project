// test/renderer/settings/documents/ReimbursementKeyPicker.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ReimbursementKeyPicker from '../../../../src/renderer/settings/components/documents/ReimbursementKeyPicker.vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
})

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span :class="variant"><slot /></span>'
})

const options = [
  { value: 'meeting_minutes', label: '会议纪要', hint: 'meeting_minutes' },
  { value: 'invoice', label: '发票', hint: 'invoice' }
]

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(ReimbursementKeyPicker, {
    props: { modelValue: [], options, notice: null, ...props },
    global: { stubs: { DcButton: dcButtonStub, DcBadge: dcBadgeStub, Icon: true } }
  })
}

describe('ReimbursementKeyPicker', () => {
  it('renders options with label and mono hint, unchecked by default', () => {
    const wrapper = mountPicker()
    const opt = wrapper.get('[data-testid="reimbursement-key-option-meeting_minutes"]')
    expect((opt.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('会议纪要')
    expect(wrapper.text()).toContain('meeting_minutes')
  })

  it('checking an option emits the appended array; unchecking emits the filtered array', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="reimbursement-key-option-invoice"]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['invoice'])
    await wrapper.setProps({ modelValue: ['invoice'] })
    await wrapper.get('[data-testid="reimbursement-key-option-invoice"]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([])
  })

  it('the × remove button emits the array without that value', async () => {
    const wrapper = mountPicker({ modelValue: ['meeting_minutes', 'invoice'] })
    await wrapper.get('[data-testid="reimbursement-key-remove-meeting_minutes"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['invoice'])
  })

  it('marks selected values missing from options as stale and keeps them removable', () => {
    const wrapper = mountPicker({ modelValue: ['ghost_key'] })
    const remove = wrapper.get('[data-testid="reimbursement-key-remove-ghost_key"]')
    expect(remove.element.closest('.stale-key')).not.toBeNull()
  })

  it('notice=empty shows the hint instead of the option list', () => {
    const wrapper = mountPicker({ options: [], notice: 'empty' })
    expect(wrapper.find('[data-testid="reimbursement-picker-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-key-option-invoice"]').exists()).toBe(false)
  })

  it('notice=error shows error text and emits retry from the retry button', async () => {
    const wrapper = mountPicker({ notice: 'error' })
    expect(wrapper.find('[data-testid="reimbursement-picker-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="reimbursement-picker-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
