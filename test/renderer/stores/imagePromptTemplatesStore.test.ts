import { beforeEach, describe, expect, it, vi } from 'vitest'

const configMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => configMocks
}))

vi.mock('pinia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pinia')>())
}))

import { createPinia, setActivePinia } from 'pinia'
import { useImagePromptTemplatesStore } from '@/stores/imagePromptTemplates'
import type { UserImagePromptTemplate } from '@shared/imagePromptTemplates'

const validTemplate = (
  overrides: Partial<UserImagePromptTemplate> = {}
): UserImagePromptTemplate => ({
  id: 'tpl-1',
  title: '设计范本',
  prompt: 'a red apple on a table',
  createdAt: 1700000000000,
  ...overrides
})

describe('useImagePromptTemplatesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('load 读取有效数据并置 loaded', async () => {
    configMocks.getSetting.mockResolvedValue([validTemplate()])
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toHaveLength(1)
    expect(store.userTemplates[0].title).toBe('设计范本')
    expect(store.loaded).toBe(true)
  })

  it('load 坏数据回退空列表并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configMocks.getSetting.mockResolvedValue([{ id: 42 }])
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toEqual([])
    expect(store.loaded).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('load 失败回退空列表并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configMocks.getSetting.mockRejectedValue(new Error('ipc down'))
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toEqual([])
    expect(store.loaded).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('add 追加并持久化', () => {
    const store = useImagePromptTemplatesStore()
    const created = store.add({ title: '商品图', prompt: 'bottle', size: '1024x1024' })
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBeGreaterThan(0)
    expect(store.userTemplates).toHaveLength(1)
    expect(configMocks.setSetting).toHaveBeenCalledWith('user_image_prompt_templates', [
      expect.objectContaining({ title: '商品图' })
    ])
  })

  it('add 空白标题抛错且不持久化', () => {
    const store = useImagePromptTemplatesStore()
    expect(() => store.add({ title: '   ', prompt: 'x' })).toThrow('Invalid image prompt template')
    expect(store.userTemplates).toHaveLength(0)
    expect(configMocks.setSetting).not.toHaveBeenCalled()
  })

  it('add 超上限抛错', () => {
    const store = useImagePromptTemplatesStore()
    for (let i = 0; i < 50; i++) {
      store.add({ title: `t${i}`, prompt: 'p' })
    }
    configMocks.setSetting.mockClear()
    expect(() => store.add({ title: 'overflow', prompt: 'p' })).toThrow('limit reached')
    expect(configMocks.setSetting).not.toHaveBeenCalled()
  })

  it('update 清除 size/quality 并保留 createdAt', () => {
    const store = useImagePromptTemplatesStore()
    store.add({ title: '旧', prompt: 'p', size: '1024x1024', quality: 'high' })
    configMocks.setSetting.mockClear()
    store.update(store.userTemplates[0].id, { title: '新', prompt: 'q' })
    const updated = store.userTemplates[0]
    expect(updated.title).toBe('新')
    expect(updated.size).toBeUndefined()
    expect(updated.quality).toBeUndefined()
    expect(updated.createdAt).toBeGreaterThan(0)
    const payload = configMocks.setSetting.mock.calls[0][1] as UserImagePromptTemplate[]
    expect(payload[0].size).toBeUndefined()
    expect(payload[0].quality).toBeUndefined()
  })

  it('update 未知 id 抛错', () => {
    const store = useImagePromptTemplatesStore()
    expect(() => store.update('missing', { title: 'x', prompt: 'y' })).toThrow('not found')
  })

  it('remove 删除并持久化剩余项', () => {
    const store = useImagePromptTemplatesStore()
    const a = store.add({ title: 'a', prompt: 'p' })
    const b = store.add({ title: 'b', prompt: 'p' })
    configMocks.setSetting.mockClear()
    store.remove(a.id)
    expect(store.userTemplates.map((tpl) => tpl.id)).toEqual([b.id])
    expect(configMocks.setSetting).toHaveBeenCalledWith('user_image_prompt_templates', [
      expect.objectContaining({ id: b.id })
    ])
  })
})
