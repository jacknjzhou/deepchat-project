import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('markstream-vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ImageNode: defineComponent({
      name: 'StubBuiltinImageNode',
      props: {
        node: {
          type: Object,
          required: true
        },
        fallbackSrc: {
          type: String,
          default: ''
        },
        lazy: {
          type: Boolean,
          default: false
        },
        usePlaceholder: {
          type: Boolean,
          default: false
        }
      },
      emits: ['load', 'error', 'click'],
      setup(props) {
        return () => h('span', { 'data-testid': 'builtin-image-node' }, props.node.src)
      }
    })
  }
})

import MarkdownImageNode from '@/components/markdown/MarkdownImageNode.vue'

const createNode = (overrides: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  src: 'https://example.com/picture.png',
  alt: 'a picture',
  title: null,
  raw: '',
  ...overrides
})

describe('MarkdownImageNode', () => {
  it('delegates standard http sources to the built-in image node', () => {
    const wrapper = mount(MarkdownImageNode, {
      props: { node: createNode() }
    })

    expect(wrapper.find('[data-testid="builtin-image-node"]').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('renders imgcache sources directly instead of the sanitizer-stripped built-in node', () => {
    const wrapper = mount(MarkdownImageNode, {
      props: {
        node: createNode({ src: 'imgcache://img_abc.png' })
      }
    })

    expect(wrapper.find('[data-testid="builtin-image-node"]').exists()).toBe(false)
    const img = wrapper.get('img')
    expect(img.attributes('src')).toBe('imgcache://img_abc.png')
    expect(img.attributes('alt')).toBe('a picture')
  })

  it('waits for the parser to finish streaming before rendering the image', () => {
    const wrapper = mount(MarkdownImageNode, {
      props: {
        node: createNode({ src: 'imgcache://img_abc.png', loading: true })
      }
    })

    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('shows the load-error fallback when an imgcache source fails', async () => {
    const wrapper = mount(MarkdownImageNode, {
      props: {
        node: createNode({ src: 'imgcache://img_missing.png' })
      }
    })

    await wrapper.get('img').trigger('error')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('image.loadError')
  })

  it('emits error for failed imgcache sources and click for loaded ones', async () => {
    const wrapper = mount(MarkdownImageNode, {
      props: {
        node: createNode({ src: 'imgcache://img_abc.png' })
      }
    })

    const img = wrapper.get('img')
    await img.trigger('error')
    expect(wrapper.emitted('error')).toEqual([['imgcache://img_abc.png']])

    await wrapper.setProps({ node: createNode({ src: 'imgcache://img_ok.png' }) })
    const retryImg = wrapper.get('img')
    await retryImg.trigger('load')
    await retryImg.trigger('click')

    expect(wrapper.emitted('load')).toEqual([['imgcache://img_ok.png']])
    expect(wrapper.emitted('click')).toEqual([[[expect.any(Event), 'imgcache://img_ok.png']]])
  })
})
