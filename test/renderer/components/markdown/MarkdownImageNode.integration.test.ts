import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import NodeRenderer, { setCustomComponents, getCustomNodeComponents } from 'markstream-vue'
import MarkdownImageNode from '@/components/markdown/MarkdownImageNode.vue'

describe('MarkdownImageNode integration with real markstream', () => {
  it('registers the image override in the merged custom component map', () => {
    setCustomComponents({ image: MarkdownImageNode })

    const merged = getCustomNodeComponents('any-custom-id')
    expect(merged.image).toBe(MarkdownImageNode)
  })

  it('renders imgcache markdown images through the override at runtime', async () => {
    setCustomComponents({ image: MarkdownImageNode })

    const renderedBuiltin: string[] = []
    const Host = defineComponent({
      setup() {
        return () =>
          h(NodeRenderer, {
            content: 'before\n\n![gen](imgcache://img_real.png)\n\nafter',
            customId: 'integration-test',
            final: true,
            mode: 'chat'
          })
      }
    })

    const wrapper = mount(Host, {
      global: {
        stubs: {
          // Capture the built-in ImageNode so we can tell which path ran.
          StubBuiltinImageNode: true
        }
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    const html = wrapper.html()
    // The override renders the img with the imgcache src directly.
    expect(html).toContain('imgcache://img_real.png')
    // And it must not surface the built-in load-error chip.
    expect(html).not.toContain('Image failed to load')
    expect(renderedBuiltin).toHaveLength(0)

    wrapper.unmount()
  })
})
