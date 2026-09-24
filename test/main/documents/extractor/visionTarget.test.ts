import { describe, expect, it } from 'vitest'
import { pickVisionTarget } from '@/documents/extractor/visionTarget'

const T = (id: string) => ({ providerId: `${id}-provider`, modelId: `${id}-model` })

describe('pickVisionTarget', () => {
  it('prefers the explicit vision setting', async () => {
    const target = await pickVisionTarget({
      explicitVision: T('explicit'),
      agentVision: T('agent'),
      textTarget: T('text'),
      isVisionCapable: async () => true
    })
    expect(target).toEqual(T('explicit'))
  })

  it('falls back to the agent vision model', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: T('agent'),
      textTarget: T('text'),
      isVisionCapable: async () => true
    })
    expect(target).toEqual(T('agent'))
  })

  it('uses the default text model when it is vision-capable', async () => {
    const capable: string[] = ['text-model']
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: T('text'),
      isVisionCapable: async (t) => capable.includes(t.modelId)
    })
    expect(target).toEqual(T('text'))
  })

  it('returns null when nothing is vision-capable', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: T('text'),
      isVisionCapable: async () => false
    })
    expect(target).toBeNull()
  })

  it('returns null without a text target', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: null,
      isVisionCapable: async () => true
    })
    expect(target).toBeNull()
  })
})
