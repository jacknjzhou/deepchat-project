import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DocumentTaskStrip from '../../../../src/renderer/src/pages/documents/DocumentTaskStrip.vue'
import type { DocumentTemplate } from '@shared/documents'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const makeTask = (overrides = {}) => ({
  id: 't1',
  batchId: 'b1',
  filePath: 'C:\\a.png',
  fileName: 'a.png',
  templateId: 'auto',
  status: 'running',
  typeKey: null,
  documentId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeTemplate = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 'tpl-c',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: 'other',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('DocumentTaskStrip', () => {
  it('renders file name and status for each task', () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: {
        tasks: [
          makeTask(),
          makeTask({ id: 't2', status: 'failed', error: 'boom', fileName: 'b.pdf' })
        ],
        templates: [],
        typeNameFor: (typeKey: string | null) => (typeKey ? `T:${typeKey}` : null)
      },
      global: { stubs: { Icon: true, DcBadge: { template: '<span><slot /></span>' } } }
    })
    expect(wrapper.text()).toContain('a.png')
    expect(wrapper.text()).toContain('b.pdf')
    expect(wrapper.text()).toContain('boom')
  })

  it('emits retry with the picked template from the category menu', async () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: {
        tasks: [makeTask({ status: 'failed', error: 'x' })],
        templates: [
          makeTemplate(),
          makeTemplate({ id: 'tpl-r', typeKey: 'receipt', name: 'Receipt' })
        ],
        typeNameFor: () => null
      },
      global: {
        stubs: {
          Icon: true,
          DcBadge: { template: '<span><slot /></span>' },
          DcButton: { template: '<button data-testid="task-retry"><slot /></button>' },
          DropdownMenu: { template: '<div><slot /></div>' },
          DropdownMenuTrigger: { template: '<div><slot /></div>' },
          DropdownMenuContent: { template: '<div><slot name="default" /></div>' },
          DropdownMenuItem: {
            // inheritAttrs:false keeps the parent's onClick listener off the
            // native button so each click emits exactly once.
            inheritAttrs: false,
            template:
              '<button :data-testid="$attrs[\'data-testid\']" @click="$emit(\'click\')"><slot /></button>'
          }
        }
      }
    })
    await wrapper.get('[data-testid="task-retry-auto"]').trigger('click')
    await wrapper.get('[data-testid="task-retry-template-contract"]').trigger('click')
    expect(wrapper.emitted('retry')?.[0]).toEqual([expect.objectContaining({ id: 't1' }), 'auto'])
    expect(wrapper.emitted('retry')?.[1]).toEqual([expect.objectContaining({ id: 't1' }), 'tpl-c'])
  })
})
