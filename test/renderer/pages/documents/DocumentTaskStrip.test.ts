import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DocumentTaskStrip from '../../../../src/renderer/src/pages/documents/DocumentTaskStrip.vue'

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

describe('DocumentTaskStrip', () => {
  it('renders file name and status for each task', () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: {
        tasks: [
          makeTask(),
          makeTask({ id: 't2', status: 'failed', error: 'boom', fileName: 'b.pdf' })
        ],
        typeNameFor: (typeKey: string | null) => (typeKey ? `T:${typeKey}` : null)
      },
      global: { stubs: { Icon: true, DcBadge: { template: '<span><slot /></span>' } } }
    })
    expect(wrapper.text()).toContain('a.png')
    expect(wrapper.text()).toContain('b.pdf')
    expect(wrapper.text()).toContain('boom')
  })

  it('emits retry with the failed task', async () => {
    const wrapper = mount(DocumentTaskStrip, {
      props: { tasks: [makeTask({ status: 'failed', error: 'x' })], typeNameFor: () => null },
      global: {
        stubs: {
          Icon: true,
          DcBadge: { template: '<span><slot /></span>' },
          DcButton: {
            template: '<button data-testid="task-retry" @click="$emit(\'click\')"><slot /></button>'
          }
        }
      }
    })
    await wrapper.get('[data-testid="task-retry"]').trigger('click')
    expect(wrapper.emitted('retry')?.[0]?.[0]).toMatchObject({ id: 't1' })
  })
})
