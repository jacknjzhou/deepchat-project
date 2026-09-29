import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))
vi.doMock('@iconify/vue', () => ({
  Icon: { name: 'Icon', props: ['icon'], template: '<span :data-icon="icon" />' }
}))

async function setup() {
  const { default: UserProfileBadge } =
    await import('@/pages/resumeScreening/components/UserProfileBadge.vue')
  return mount(UserProfileBadge, { props: { name: '张三', email: 'z@example.com' } })
}

describe('UserProfileBadge', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('渲染姓名与邮箱', async () => {
    wrapper = await setup()
    expect(wrapper.get('[data-testid="user-profile-badge"]').text()).toContain('张三')
    expect(wrapper.get('[data-testid="user-profile-badge"]').text()).toContain('z@example.com')
  })

  it('点击 badge 上抛 edit 事件', async () => {
    wrapper = await setup()
    await wrapper.get('[data-testid="user-profile-badge"]').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })
})
