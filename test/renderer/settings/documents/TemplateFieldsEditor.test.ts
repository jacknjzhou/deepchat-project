import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })
const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue', 'disabled', 'placeholder'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLInputElement).value)
      }
    }
  },
  template:
    '<input :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="handleInput" />'
})
const switchStub = defineComponent({
  name: 'SwitchStub',
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue'],
  template:
    '<button :disabled="disabled" :data-model-value="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />'
})
const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      choose: (value: string) => emit('update:modelValue', value)
    }
  },
  template: '<div><slot /></div>'
})
const selectItemStub = defineComponent({
  name: 'SelectItemStub',
  props: { value: { type: String, required: true } },
  emits: ['pick'],
  template:
    '<button type="button" :data-value="value" @click="$emit(\'pick\', value)"><slot /></button>'
})
const PROVIDE_KEY = Symbol('select-pick')
const selectRootStub = defineComponent({
  name: 'SelectRootStub',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(props, { emit, slots }) {
    return () => {
      const provide = (value: string) => emit('update:modelValue', value)
      const children = slots.default?.({
        pick: provide
      })
      return children
    }
  },
  template: '<slot :pick="pick" />'
})
const useSortableStub = vi.fn(() => ({ start: () => undefined, option: () => undefined }))

async function setup(readonly = false) {
  vi.resetModules()
  vi.doMock('@vueuse/integrations/useSortable', () => ({ useSortable: useSortableStub }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string) => key
    })
  }))
  const TemplateFieldsEditor = (
    await import('../../../../src/renderer/settings/components/documents/TemplateFieldsEditor.vue')
  ).default

  const initialFields = [
    {
      key: 'amount',
      label: 'Amount',
      valueType: 'number',
      required: true,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 1
    },
    {
      key: 'date',
      label: 'Date',
      valueType: 'date',
      required: false,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 2
    }
  ]

  const wrapper = mount(TemplateFieldsEditor, {
    props: { fields: initialFields, readonly },
    global: {
      stubs: {
        Icon: true,
        Input: inputStub,
        Textarea: inputStub,
        Switch: switchStub,
        Select: selectRootStub,
        SelectTrigger: passthrough('SelectTrigger'),
        SelectValue: passthrough('SelectValue'),
        SelectContent: passthrough('SelectContent'),
        SelectItem: selectItemStub,
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }),
        AlertDialog: defineComponent({
          name: 'AlertDialogStub',
          props: { open: Boolean },
          template: '<div v-if="open"><slot /></div>'
        }),
        AlertDialogContent: passthrough('AlertDialogContent'),
        AlertDialogHeader: passthrough('AlertDialogHeader'),
        AlertDialogTitle: passthrough('AlertDialogTitle'),
        AlertDialogDescription: passthrough('AlertDialogDescription'),
        AlertDialogFooter: passthrough('AlertDialogFooter'),
        AlertDialogCancel: defineComponent({
          name: 'AlertDialogCancelStub',
          template: '<button data-testid="field-delete-cancel"><slot /></button>'
        }),
        AlertDialogAction: defineComponent({
          name: 'AlertDialogActionStub',
          props: ['disabled'],
          emits: ['click'],
          template:
            '<button data-testid="field-delete-confirm" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
        })
      }
    }
  })
  await flushPromises()
  return { wrapper, useSortableStub }
}

describe('TemplateFieldsEditor', () => {
  it('renders one row per field', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="field-row"]')).toHaveLength(2)
  })

  it('emits update when a field label changes', async () => {
    const { wrapper } = await setup()
    const inputs = wrapper.findAll('input[placeholder="settings.documents.editor.fieldLabel"]')
    expect(inputs).toHaveLength(2)
    await inputs[0].setValue('New Amount')
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<{ label: string }>
    expect(newFields[0].label).toBe('New Amount')
  })

  it('shows confirmation when deleting a required field', async () => {
    const { wrapper } = await setup()
    const deleteButtons = wrapper.findAll('[data-testid="field-delete"]')
    await deleteButtons[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="field-delete-confirm"]').exists()).toBe(true)
  })

  it('deletes without confirmation when field is not required', async () => {
    const { wrapper } = await setup()
    const deleteButtons = wrapper.findAll('[data-testid="field-delete"]')
    await deleteButtons[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="field-delete-confirm"]').exists()).toBe(false)
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<{ key: string }>
    expect(newFields.map((f) => f.key)).toEqual(['amount'])
  })

  it('emits add-field event on add button click', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="field-add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
  })

  it('initializes useSortable on the row container', async () => {
    const { useSortableStub } = await setup()
    expect(useSortableStub).toHaveBeenCalled()
  })

  it('disables all controls in readonly mode', async () => {
    const { wrapper } = await setup(true)
    expect(wrapper.find('[data-testid="field-add"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="field-delete"]')).toHaveLength(0)
    const inputs = wrapper.findAll('input')
    for (const input of inputs) {
      expect(input.attributes('disabled')).toBeDefined()
    }
  })
})
