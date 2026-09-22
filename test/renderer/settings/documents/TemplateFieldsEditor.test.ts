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

const editorStubs = {
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

function makeFields() {
  return [
    {
      key: 'amount',
      label: 'Amount',
      valueType: 'number' as const,
      required: true,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 1
    },
    {
      key: 'date',
      label: 'Date',
      valueType: 'date' as const,
      required: false,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 2
    }
  ]
}

async function setup(readonly = false, fields = makeFields()) {
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

  const wrapper = mount(TemplateFieldsEditor, {
    props: { fields, readonly },
    global: {
      stubs: editorStubs
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

  it('renders prompt hint, validation and enum option inputs for enum fields', async () => {
    const fields = makeFields().map((field, index) =>
      index === 0 ? { ...field, valueType: 'enum' as const } : field
    )
    const { wrapper } = await setup(false, fields)
    expect(
      wrapper.findAll('input[placeholder="settings.documents.editor.fieldPromptHint"]')
    ).toHaveLength(2)
    expect(
      wrapper.findAll('input[placeholder="settings.documents.editor.fieldValidationHint"]')
    ).toHaveLength(2)
    expect(
      wrapper.findAll('input[placeholder="settings.documents.editor.fieldEnumOptionsHint"]')
    ).toHaveLength(1)
  })

  it('hides enum options input for non-enum fields', async () => {
    const { wrapper } = await setup()
    expect(
      wrapper.findAll('input[placeholder="settings.documents.editor.fieldEnumOptionsHint"]')
    ).toHaveLength(0)
  })

  it('emits update when a prompt hint changes', async () => {
    const { wrapper } = await setup()
    const inputs = wrapper.findAll('input[placeholder="settings.documents.editor.fieldPromptHint"]')
    await inputs[0].setValue('Invoice total in words')
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<Record<string, unknown>>
    expect(newFields[0].promptHint).toBe('Invoice total in words')
    expect(newFields[0].key).toBe('amount')
    expect(newFields[0].label).toBe('Amount')
    expect(newFields[0].valueType).toBe('number')
    expect(newFields[1].promptHint).toBe('')
  })

  it('emits update when enum options change', async () => {
    const fields = makeFields().map((field, index) =>
      index === 0 ? { ...field, valueType: 'enum' as const } : field
    )
    const { wrapper } = await setup(false, fields)
    const input = wrapper.get('input[placeholder="settings.documents.editor.fieldEnumOptionsHint"]')
    await input.setValue('paid,unpaid')
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<Record<string, unknown>>
    expect(newFields[0].enumOptions).toBe('paid,unpaid')
    expect(newFields[0].promptHint).toBe('')
    expect(newFields[0].validation).toBe('')
    expect(newFields[1].enumOptions).toBe('')
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

  it('shows an inline error for an invalid field key', async () => {
    const fields = makeFields().map((field) => ({ ...field, key: '1bad' }))
    const { wrapper } = await setup(false, fields)
    expect(wrapper.text()).toContain('settings.documents.editor.fieldKeyInvalid')
    const keyInput = wrapper.get('input[placeholder="settings.documents.editor.fieldKey"]')
    expect(keyInput.attributes('aria-invalid')).toBe('true')
    expect(keyInput.attributes('aria-describedby')).toBe('field-key-issue-0')
  })

  it('shows a duplicated key error and hides issues in readonly mode', async () => {
    const fields = makeFields().map((field) => ({ ...field, key: 'amount' }))
    const { wrapper } = await setup(false, fields)
    expect(wrapper.text()).toContain('settings.documents.editor.fieldKeyDuplicated')
    const readonlyWrapper = (await setup(true, fields)).wrapper
    expect(readonlyWrapper.text()).not.toContain('settings.documents.editor.fieldKeyInvalid')
    expect(readonlyWrapper.text()).not.toContain('settings.documents.editor.fieldKeyDuplicated')
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

// These tests run the real @vueuse/integrations useSortable and the real
// sortablejs: the stubbed suite cannot detect the default onUpdate that
// mutates the list in place before onEnd fires, and sortablejs is externalized
// so its module cannot be mocked here. The merged Sortable options are read
// back from the instance stored on the list element (sortablejs expando).
describe('TemplateFieldsEditor sortable options', () => {
  async function setupRealSortable(fields = makeFields()) {
    vi.resetModules()
    // Keep the real useSortable (unmock the suite-wide stub); vue-i18n is
    // mocked only to keep translation keys readable in assertions.
    vi.doUnmock('@vueuse/integrations/useSortable')
    vi.doMock('vue-i18n', () => ({
      useI18n: () => ({
        t: (key: string) => key
      })
    }))
    const TemplateFieldsEditor = (
      await import('../../../../src/renderer/settings/components/documents/TemplateFieldsEditor.vue')
    ).default

    const wrapper = mount(TemplateFieldsEditor, {
      props: { fields },
      global: {
        stubs: editorStubs
      }
    })
    await flushPromises()
    const listEl = wrapper.get('[data-testid="field-row"]').element.parentElement as HTMLElement
    const expandoKey = Object.keys(listEl).find((key) => /^Sortable\d+$/.test(key))
    const options = expandoKey
      ? (listEl as unknown as Record<string, { options: SortableOptions }>)[expandoKey].options
      : undefined
    return { wrapper, fields, options }
  }

  it('overrides useSortable default onUpdate so onEnd stays the only mutation source', async () => {
    const { fields, options } = await setupRealSortable()
    expect(typeof options?.onUpdate).toBe('function')
    expect(typeof options?.onEnd).toBe('function')

    // The useSortable default onUpdate would splice props.fields (0 -> 1) in
    // place; invoking the captured handler must leave the list untouched.
    const before = fields.map((field) => field.key)
    options!.onUpdate!({
      oldIndex: 0,
      newIndex: 1,
      item: document.createElement('div'),
      from: document.createElement('div')
    } as unknown as Event)
    await flushPromises()
    expect(fields.map((field) => field.key)).toEqual(before)
  })

  it('moves the field exactly once when onEnd fires', async () => {
    const { wrapper, options } = await setupRealSortable()
    options!.onEnd!({ oldIndex: 0, newIndex: 1 } as unknown as Event)
    await flushPromises()
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const moved = updateEvents!.at(-1)![0] as Array<{ key: string }>
    expect(moved.map((field) => field.key)).toEqual(['date', 'amount'])
  })
})

interface SortableOptions {
  onUpdate?: (event: Event) => void
  onEnd?: (event: Event) => void
}
