/**
 * stdio 子进程的最小化环境变量构造。
 *
 * inheritEnv === 'minimal' 时使用：只透传运行 OS 必需的键（PATH、临时
 * 目录、Windows 系统目录、Linux 桌面会话相关等），其余一律丢弃——
 * 避免把主进程的代理/凭据类环境变量泄漏给不可信的 MCP server 子进程。
 * 平台差异集中在三个白名单集合；LC_* 区域变量始终放行。
 */

const COMMON_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG'
])

const LINUX_ENVIRONMENT_KEYS = new Set([
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS',
  'SWAYSOCK',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_DESKTOP',
  'DESKTOP_SESSION',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS'
])

const WINDOWS_ENVIRONMENT_KEYS = new Set([
  ...COMMON_ENVIRONMENT_KEYS,
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROCESSOR_ARCHITECTURE'
])

const isMinimalEnvironmentKeyAllowed = (key: string, platform: NodeJS.Platform): boolean => {
  if (platform === 'win32') {
    const normalizedKey = key.toUpperCase()
    return WINDOWS_ENVIRONMENT_KEYS.has(normalizedKey) || normalizedKey.startsWith('LC_')
  }

  return (
    COMMON_ENVIRONMENT_KEYS.has(key) ||
    key.startsWith('LC_') ||
    (platform === 'linux' && LINUX_ENVIRONMENT_KEYS.has(key))
  )
}

/** 从 source 中筛出白名单内的键值对，构成子进程环境。 */
export const createMinimalProcessEnvironment = (
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && isMinimalEnvironmentKeyAllowed(entry[0], platform)
    )
  )
