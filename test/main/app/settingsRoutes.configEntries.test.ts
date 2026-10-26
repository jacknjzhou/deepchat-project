import { describe, expect, it, vi } from 'vitest'
import { createAppSettingsRoutes } from '../../../src/main/app/settingsRoutes'
import { configGetEntriesRoute } from '../../../src/shared/contracts/routes'

// 回归：readEntries 是显式 read(...) 清单而不是遍历 CONFIG_ENTRY_KEYS。
// digitalEmployee.featureEnabled 曾漏在清单外——设置窗口写入并广播成功，
// 主窗口经 config.getEntries 却永远读不到，侧边栏入口因此不出现。
describe('appSettingsRoutes config.getEntries', () => {
  it('surfaces the persisted digital employee feature switch', async () => {
    const store = new Map<string, unknown>([['digitalEmployee.featureEnabled', true]])
    const routes = createAppSettingsRoutes({
      settings: {
        get: <T>(key: string, defaultValue?: T) =>
          store.has(key) ? (store.get(key) as T) : defaultValue,
        set: (key: string, value: unknown) => {
          store.set(key, value)
        }
      },
      agentDefaults: {},
      privacy: {},
      traceSettings: {},
      desktopSettings: {},
      fonts: {},
      logging: {},
      ocr: {},
      commandShell: {},
      publishEvent: vi.fn(),
      applyContentProtection: vi.fn(),
      recordActivity: vi.fn(),
      listActivities: vi.fn(async () => []),
      managed: { getStatus: vi.fn(), refresh: vi.fn(async () => ({}) as never) }
    })

    const result = (await routes.get(configGetEntriesRoute.name)!({
      keys: ['digitalEmployee.featureEnabled']
    })) as { values: Record<string, unknown> }

    expect(result.values).toEqual({ 'digitalEmployee.featureEnabled': true })
  })
})
