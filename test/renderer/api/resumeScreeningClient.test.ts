import type { DeepchatBridge } from '@shared/contracts/bridge'
import { createResumeScreeningClient } from '../../../src/renderer/api/ResumeScreeningClient'

describe('ResumeScreeningClient', () => {
  it('invokes read routes through the bridge', async () => {
    const invoke = vi.fn(async (routeName: string, input: unknown) => {
      structuredClone(input)
      switch (routeName) {
        case 'resumeScreening.getTask':
          return { task: null, resumes: [] }
        case 'resumeScreening.listTasks':
          return { tasks: [] }
        case 'resumeScreening.cancelTask':
          return { ok: true }
        case 'resumeScreening.getProfile':
          return { profile: { name: '', email: '' } }
        case 'resumeScreening.listModels':
          return { models: [] }
        default:
          throw new Error(`Unexpected route: ${routeName}`)
      }
    })
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createResumeScreeningClient(bridge)

    expect(await client.getTask('t-1')).toEqual({ task: null, resumes: [] })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.getTask', { taskId: 't-1' })

    await client.listTasks()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listTasks', {})
    await client.listTasks(50)
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listTasks', { limit: 50 })

    expect(await client.cancelTask('t-1')).toEqual({ ok: true })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.cancelTask', { taskId: 't-1' })

    await client.getProfile()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.getProfile', {})

    await client.listModels()
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.listModels', {})
  })

  it('sends createTask and updateProfile inputs as-is', async () => {
    const invoke = vi.fn(async () => ({ task: {} }))
    const bridge = { invoke, on: vi.fn(() => () => undefined) } as unknown as DeepchatBridge
    const client = createResumeScreeningClient(bridge)

    const input = {
      jdSource: 'file' as const,
      jdText: '',
      jdFilePath: 'C:\\jd.txt',
      jdFileName: 'jd.txt',
      resumes: [{ path: 'C:\\a.pdf', name: 'a.pdf', size: 10 }],
      config: { generateExplanation: true, includeRawText: false, maxConcurrency: 2 }
    }
    await client.createTask(input)
    expect(invoke).toHaveBeenCalledWith('resumeScreening.createTask', input)

    await client.updateProfile({ name: '张三', email: 'z@example.com' })
    expect(invoke).toHaveBeenLastCalledWith('resumeScreening.updateProfile', {
      name: '张三',
      email: 'z@example.com'
    })
  })

  it('subscribes to task/resume events and returns unsubscribe', () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const client = createResumeScreeningClient({ on } as never)

    const listener = vi.fn()
    const stop = client.onTaskUpdated(listener)
    expect(on).toHaveBeenCalledWith('resumeScreening.task.updated', listener)
    stop()
    expect(off).toHaveBeenCalled()

    const stopResume = client.onResumeUpdated(listener)
    expect(on).toHaveBeenCalledWith('resumeScreening.resume.updated', listener)
    stopResume()
    expect(off).toHaveBeenCalled()
  })
})
