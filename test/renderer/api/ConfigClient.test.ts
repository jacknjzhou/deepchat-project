import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createConfigClient } from '@api/ConfigClient'
import type { DeepchatBridge } from '@shared/contracts/bridge'
import type { UserImagePromptTemplate } from '@shared/imagePromptTemplates'

describe('createConfigClient setSetting', () => {
  it('deep-converts reactive values to plain data before IPC', async () => {
    const invoke = vi.fn(async () => ({
      version: 1,
      changedKeys: ['user_image_prompt_templates' as const],
      values: {}
    }))
    window.deepchat = {
      invoke,
      on: vi.fn(() => () => {})
    } as unknown as DeepchatBridge

    const client = createConfigClient()
    const template: UserImagePromptTemplate = {
      id: 'tpl-1',
      title: '设计范本',
      prompt: 'a red apple on a table',
      createdAt: 1700000000000
    }
    // Refs hand out reactive proxies per element; spreading the array does not
    // strip them, and the IPC bridge rejects proxies ("could not be cloned").
    const reactiveTemplates = reactive([template])

    await client.setSetting('user_image_prompt_templates', reactiveTemplates)

    expect(invoke).toHaveBeenCalledTimes(1)
    const [routeName, payload] = invoke.mock.calls[0] as unknown as [string, unknown]
    expect(routeName).toBe('config.updateEntries')
    // Mirrors the structured clone performed by the real IPC bridge.
    expect(() => structuredClone(payload)).not.toThrow()
    expect(structuredClone(payload)).toEqual({
      changes: [{ key: 'user_image_prompt_templates', value: [template] }]
    })
  })
})
