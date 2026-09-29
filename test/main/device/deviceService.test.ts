import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import { DeviceService } from '@/device'

const { appRelaunchMock, appExitMock, execMock, osMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  appExitMock: vi.fn(),
  execMock: vi.fn(),
  osMock: {
    release: vi.fn(() => '10.0.22631'),
    cpus: vi.fn(() => [{ model: 'Mock CPU' }]),
    totalmem: vi.fn(() => 16 * 1024 ** 3),
    userInfo: vi.fn(() => ({
      username: 'zhangsan',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\zhangsan'
    })),
    homedir: vi.fn(() => 'C:\\Users\\zhangsan'),
    hostname: vi.fn(() => 'DESKTOP-ABC')
  }
}))

vi.mock('os', () => ({ default: osMock, ...osMock }))
vi.mock('child_process', () => ({ exec: execMock }))

const WHOAMI_OUTPUT = [
  'USER INFORMATION',
  '----------------',
  'User Name      SID',
  '============== =======================================',
  'DESKTOP-ABC\\zhangsan S-1-5-21-1004336348-1177238915-682003330-5122'
].join('\r\n')

const originalPlatform = process.platform
const originalUserDomain = process.env.USERDOMAIN

const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.2.3'),
    getPath: vi.fn(() => '/mock/path'),
    relaunch: appRelaunchMock,
    exit: appExitMock
  },
  dialog: {
    showMessageBoxSync: vi.fn(),
    showOpenDialog: vi.fn()
  }
}))

// Mock svgSanitizer (imported by DeviceService via @/lib/svgSanitizer)
vi.mock('@/lib/svgSanitizer', () => ({
  svgSanitizer: {
    sanitize: vi.fn()
  }
}))

describe('DeviceService', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    appRelaunchMock.mockClear()
    appExitMock.mockClear()
    setPlatform(originalPlatform)
    process.env.USERDOMAIN = originalUserDomain
  })

  describe('getDefaultHeaders', () => {
    it('should include User-Agent header with DeepChat/ prefix', () => {
      const headers = DeviceService.getDefaultHeaders()

      expect(headers).toHaveProperty('User-Agent')
      expect(headers['User-Agent']).toMatch(/^DeepChat\//)
    })

    it('should include HTTP-Referer and X-Title headers', () => {
      const headers = DeviceService.getDefaultHeaders()

      expect(headers['HTTP-Referer']).toBe('https://deepchatai.cn')
      expect(headers['X-Title']).toBe('DeepChat')
    })
  })

  describe('getDeviceInfo winAccount', () => {
    // 每个用例重新加载模块，隔离 getWindowsSid 的模块级缓存
    const loadFreshService = async (): Promise<typeof DeviceService> => {
      vi.resetModules()
      const mod = await import('@/device')
      return mod.DeviceService
    }

    beforeEach(() => {
      execMock.mockReset()
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          cb(null, { stdout: WHOAMI_OUTPUT, stderr: '' })
        }
      )
      process.env.USERDOMAIN = 'DESKTOP-ABC'
    })

    it('returns null winAccount on non-win32 platforms', async () => {
      setPlatform('darwin')
      const FreshService = await loadFreshService()
      const info = await new FreshService().getDeviceInfo()

      expect(info.winAccount).toBeNull()
      expect(execMock).not.toHaveBeenCalled()
    })

    it('collects windows account fields and parses sid on win32', async () => {
      setPlatform('win32')
      const FreshService = await loadFreshService()
      const info = await new FreshService().getDeviceInfo()

      expect(info.winAccount).toEqual({
        username: 'zhangsan',
        domain: 'DESKTOP-ABC',
        hostname: 'DESKTOP-ABC',
        homeDir: 'C:\\Users\\zhangsan',
        sid: 'S-1-5-21-1004336348-1177238915-682003330-5122'
      })
      expect(execMock).toHaveBeenCalledWith('whoami /user', { timeout: 5000 }, expect.any(Function))
    })

    it('falls back to null sid without rejecting when whoami fails', async () => {
      setPlatform('win32')
      execMock.mockImplementation((cmd: string, opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error('whoami failed'))
      )
      const FreshService = await loadFreshService()
      const info = await new FreshService().getDeviceInfo()

      expect(info.winAccount).not.toBeNull()
      expect(info.winAccount?.username).toBe('zhangsan')
      expect(info.winAccount?.sid).toBeNull()
    })

    it('falls back to null sid when output cannot be parsed', async () => {
      setPlatform('win32')
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          cb(null, { stdout: 'no sid here', stderr: '' })
        }
      )
      const FreshService = await loadFreshService()
      const info = await new FreshService().getDeviceInfo()

      expect(info.winAccount?.sid).toBeNull()
    })

    it('caches sid and executes whoami only once across calls', async () => {
      setPlatform('win32')
      const FreshService = await loadFreshService()
      const service = new FreshService()

      const first = await service.getDeviceInfo()
      const second = await service.getDeviceInfo()

      expect(first.winAccount?.sid).toBe('S-1-5-21-1004336348-1177238915-682003330-5122')
      expect(second.winAccount?.sid).toBe(first.winAccount?.sid)
      expect(execMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('restartAppWithDelay', () => {
    it('relaunches the process after data reset', async () => {
      vi.useFakeTimers()
      const presenter = new DeviceService()

      const restartPromise = (
        presenter as unknown as { restartAppWithDelay: () => Promise<void> }
      ).restartAppWithDelay()
      await vi.advanceTimersByTimeAsync(1000)
      await restartPromise

      expect(appRelaunchMock).toHaveBeenCalledTimes(1)
      expect(appExitMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('resetDataByType', () => {
    it('only removes data after the App owner has stopped runtime resources', async () => {
      vi.useFakeTimers()
      vi.spyOn(fs, 'existsSync').mockReturnValue(false)
      const presenter = new DeviceService()

      const resetPromise = presenter.resetDataByType('all')
      await vi.advanceTimersByTimeAsync(1000)
      await resetPromise

      expect(appRelaunchMock).toHaveBeenCalledTimes(1)
      expect(appExitMock).toHaveBeenCalledTimes(1)
    })

    it('reports a delayed relaunch failure to the shutdown owner', async () => {
      vi.useFakeTimers()
      vi.spyOn(fs, 'existsSync').mockReturnValue(false)
      const failure = new Error('relaunch failed')
      appRelaunchMock.mockImplementationOnce(() => {
        throw failure
      })
      const presenter = new DeviceService()

      const resetPromise = presenter.resetDataByType('all')
      const rejection = expect(resetPromise).rejects.toBe(failure)
      await vi.advanceTimersByTimeAsync(1000)

      await rejection
      expect(appExitMock).not.toHaveBeenCalled()
    })
  })
})
