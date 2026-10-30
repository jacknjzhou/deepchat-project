/**
 * 应用启动编排层。
 *
 * 职责边界（自上而下）：
 * - index.ts 只调用本文件的 startApp()；本文件负责 app ready 之前的进程级
 *   准备（自定义 scheme 注册、命令行开关、单实例锁）与 ready 之后的
 *   deep link 分发、更新安装路径、quit/shutdown 状态机。
 * - 真正的服务装配在其下游：startMainProcess()（mainProcess.ts）完成
 *   数据库初始化与迁移后，由 composition.createMainProcessControl 组装
 *   全部主进程服务并返回 MainProcessControl。
 *
 * 退出模型：`allowQuit` 与 `shutdownPromise` 两个状态位构成一个小型状态机。
 * before-quit 先被拦截（preventDefault），走「确认 → stop() 拆卸服务 →
 * 拿到 shutdown action claim → 放行 quit」的顺序；只有拆卸成功或无服务可拆
 * 时才置 allowQuit 放行第二次 before-quit。更新安装复用同一条拆卸链，
 * 只是收尾动作从 app.quit() 换成安装器回调。
 */
import { app, dialog } from 'electron'
import { StartupWorkloadCoordinator } from './app/startupWorkloadCoordinator'
import { registerWorkspacePreviewSchemes } from './workspace/workspacePreviewProtocol'
import { registerMcpAppScheme } from './mcp/apps/sandboxProtocol'
import { registerResumePreviewScheme } from './resumeScreening/resumePreviewProtocol'
import {
  findDeepLinkArg,
  findStartupDeepLink,
  isDeepLinkUrl,
  storeStartupDeepLink
} from './lib/startupDeepLink'
import { isInsecureTlsAllowed } from './lib/insecureTls'
import { ensureRegularAppOnMac } from './lib/activateApp'
import { startMainProcess, type MainProcessControl } from './app/mainProcess'
import type { MainShutdownActionClaim } from './app/mainShutdownCoordinator'
import { mainLogger, reportMainProcessFatal, reportNativeMainError } from './logging'
import { classifyMainLogError, type MainLogShutdownReason } from './logging/mainLogEvents'
import { elapsedMonotonicMs, readMonotonicNow } from './lib/monotonicTime'

let appStarted = false
const APP_NAME = 'OfficeAgent'

/**
 * 进程入口（幂等）：重复调用（如热重载或意外二次 import）直接返回。
 *
 * 时序敏感点：自定义 scheme 必须在 app ready 之前注册，且单实例锁必须在
 * 创建任何窗口/托盘之前请求——锁被他人持有时应尽早可见地退出。
 */
export function startApp(): void {
  if (appStarted) {
    return
  }
  appStarted = true

  // E2E 测试注入独立 userData 目录，避免污染真实用户数据；必须在应用
  // 首次读取 userData 路径之前设置。
  const e2eUserDataDir = process.env.DEEPCHAT_E2E_USER_DATA_DIR?.trim()
  if (e2eUserDataDir) {
    app.setPath('userData', e2eUserDataDir)
  }

  app.setName(APP_NAME)
  if (process.platform === 'darwin') {
    if (app.isReady()) {
      ensureRegularAppOnMac()
    } else {
      app.once('ready', () => {
        ensureRegularAppOnMac()
      })
    }
  }

  // 自定义协议 scheme 的注册是 ready 前一次性动作，放到 ready 之后会失效，
  // 因此与窗口创建无关地提前在这里执行。
  registerWorkspacePreviewSchemes()
  registerMcpAppScheme()
  registerResumePreviewScheme()

  let mainProcess: MainProcessControl | undefined
  let allowQuit = false
  let shutdownPromise: Promise<void> | undefined
  let shutdownReason: MainLogShutdownReason = 'app_quit'

  // Handle unhandled exceptions to prevent app crash or error dialogs
  process.on('uncaughtException', (error) => {
    reportMainProcessFatal('process.uncaught_exception', error)
  })

  process.on('unhandledRejection', (reason) => {
    reportMainProcessFatal('process.unhandled_rejection', reason)
  })

  // Set application command line arguments
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') // Allow video autoplay
  app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100') // Set WebRTC max CPU usage
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096') // Set V8 heap memory size
  if (isInsecureTlsAllowed()) {
    // This disables certificate validation app-wide, so keep it limited to local debugging.
    app.commandLine.appendSwitch('ignore-certificate-errors')
  }

  // Set platform-specific command line arguments
  if (process.platform == 'win32') {
    // Windows platform specific parameters (currently commented out)
    // app.commandLine.appendSwitch('in-process-gpu')
    // app.commandLine.appendSwitch('wm-window-animations-disabled')
  }
  if (process.platform === 'darwin') {
    // macOS platform specific parameters
    app.commandLine.appendSwitch('disable-features', 'DesktopCaptureMacV2,IOSurfaceCapturer')
  }

  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    // 静默退出会让用户误以为安装包损坏：必须给出可见反馈。
    // 锁可能被 dev 实例、托盘常驻实例或其他共享 %APPDATA%\DeepChat 的版本持有。
    dialog.showMessageBoxSync({
      type: 'info',
      title: APP_NAME,
      message: '应用已在运行',
      detail:
        '无法同时启动多个实例。若未看到应用窗口，请检查系统托盘；若设备上还安装了其他 OfficeAgemt 版本,请先退出后再启动。'
    })
    app.quit()
    return
  }

  const startupDeepLink = findStartupDeepLink(process.argv, process.env)
  if (startupDeepLink) {
    storeStartupDeepLink(startupDeepLink)
  }

  const focusExistingAppWindow = () => {
    mainProcess?.focusPrimaryWindow()
  }

  const routeIncomingDeeplink = (url: string) => {
    if (!isDeepLinkUrl(url)) {
      return
    }

    const normalizedUrl = storeStartupDeepLink(url)
    if (!normalizedUrl) {
      return
    }

    if (mainProcess && app.isReady()) {
      void mainProcess.handleDeepLink(normalizedUrl)
    }
  }

  // Listen for open-url events that might occur during startup
  // This must be set before app.whenReady() because open-url events can fire before that
  app.on('open-url', (event, url) => {
    event.preventDefault()
    routeIncomingDeeplink(url)
  })

  // Also listen for second-instance events (Windows/Linux)
  if (gotSingleInstanceLock) {
    app.on('second-instance', (_event, commandLine) => {
      focusExistingAppWindow()

      const deepLinkUrl = findDeepLinkArg(commandLine)
      if (deepLinkUrl) {
        routeIncomingDeeplink(deepLinkUrl)
      }
    })
  }

  const startupWorkloadCoordinator = new StartupWorkloadCoordinator()
  const mainStartupRunId = startupWorkloadCoordinator.createRun('main')
  const startupStartedAt = readMonotonicNow()
  mainLogger.emit('app.startup.started', {
    startupRunId: mainStartupRunId,
    argumentCount: process.argv.length,
    deepLinkPresent: startupDeepLink !== null
  })

  /**
   * 更新安装入口（由更新模块回调）：先走完整的 stop() 拆卸拿到关停权，
   * 再在 claim 内执行安装动作。与普通退出互斥——拆卸已在进行时拒绝安装，
   * 反之安装失败要把状态机复位回「可正常退出」。
   */
  const requestUpdateInstall = async (installAction: () => void): Promise<void> => {
    const activeMainProcess = mainProcess
    if (!activeMainProcess) {
      throw new Error('Cannot install update before main process startup completes')
    }
    if (shutdownPromise) {
      throw new Error('Cannot install update while application shutdown is already in progress')
    }

    activeMainProcess.clearPermissionCaches()
    let actionClaim: MainShutdownActionClaim | undefined
    shutdownPromise = (async () => {
      actionClaim = await activeMainProcess.stop('update_install')
      if (!actionClaim) {
        throw new Error('Application shutdown is already owned by another action')
      }
    })()
    try {
      await shutdownPromise
      if (!actionClaim) throw new Error('Application shutdown claim is unavailable')
      allowQuit = true
      await actionClaim.run(installAction)
    } catch (error) {
      allowQuit = false
      actionClaim?.abandon()
      shutdownPromise = undefined
      throw error
    }
  }

  // ready 后装配全部主进程服务；启动失败就地弹错误框并退出，
  // 启动成败都记入 startup 终态日志供遥测聚合。
  app.whenReady().then(async () => {
    ensureRegularAppOnMac()
    try {
      mainProcess = await startMainProcess(
        startupWorkloadCoordinator,
        mainStartupRunId,
        requestUpdateInstall
      )
      const durationMs = elapsedMonotonicMs(startupStartedAt)
      mainLogger.emit('app.startup.terminal', {
        startupRunId: mainStartupRunId,
        outcome: 'completed',
        ...(durationMs === undefined ? {} : { durationMs })
      })
    } catch (error) {
      reportNativeMainError('main: Application startup failed:', error)
      const durationMs = elapsedMonotonicMs(startupStartedAt)
      mainLogger.emit('app.startup.terminal', {
        startupRunId: mainStartupRunId,
        outcome: 'failed',
        ...(durationMs === undefined ? {} : { durationMs }),
        error: classifyMainLogError(error)
      })
      dialog.showErrorBox(
        'Application startup failed',
        error instanceof Error ? error.message : String(error)
      )
      allowQuit = true
      app.quit()
    }
  })

  // 退出状态机：第一次 before-quit 被 preventDefault 拦下，转入异步拆卸
  // （confirmShutdown 用户确认 → stop() 拆卸 → claim.run 内部放行退出）。
  // shutdownPromise 同时充当「拆卸进行中」标志，防止重入产生两条拆卸链。
  app.on('before-quit', (event) => {
    mainProcess?.clearPermissionCaches()
    if (allowQuit) {
      return
    }

    event.preventDefault()
    if (shutdownPromise) {
      return
    }

    shutdownPromise = (async () => {
      const activeMainProcess = mainProcess
      if (!activeMainProcess) {
        allowQuit = true
        app.quit()
        return
      }

      const confirmed = await activeMainProcess.confirmShutdown()
      if (!confirmed) {
        activeMainProcess.cancelShutdown()
        shutdownPromise = undefined
        shutdownReason = 'app_quit'
        return
      }

      let actionClaim: MainShutdownActionClaim | undefined
      try {
        actionClaim = await activeMainProcess.stop(shutdownReason)
        if (!actionClaim) {
          shutdownPromise = undefined
          shutdownReason = 'app_quit'
          return
        }
      } catch (error) {
        reportNativeMainError('main: Application shutdown teardown failed:', error)
        // Teardown is one-shot and may already have dismantled application services. Continue with
        // the emergency quit rather than leave a partially stopped process that cannot retry it.
      }

      allowQuit = true
      try {
        if (actionClaim) {
          await actionClaim.run(() => app.quit())
        } else {
          app.quit()
        }
      } catch (error) {
        reportNativeMainError('main: Application shutdown action failed:', error)
        allowQuit = false
        actionClaim?.abandon()
        shutdownPromise = undefined
        shutdownReason = 'app_quit'
      }
    })()
  })

  // 全部窗口关闭：非 macOS 平台视为退出信号（macOS 惯例是驻留托盘）。
  // 仅剩悬浮球等非主窗口时不退出，避免后台功能被误杀。
  app.on('window-all-closed', () => {
    mainProcess?.clearPermissionCaches()
    if (!mainProcess) return

    if (!mainProcess.hasMainWindows()) {
      // When only floating button windows exist, quit app on non-macOS platforms
      shutdownReason = 'all_windows_closed'
      app.quit() // Keep this event to avoid unexpected situations
    }
  })
}
