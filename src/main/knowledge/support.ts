/**
 * 内置知识库的环境能力探测。
 *
 * DuckDB + VSS 扩展只为这些平台/架构组合打包了原生二进制；其余平台
 * （如 win32-arm64、freebsd）加载扩展会失败，需要在 UI 层提前隐藏
 * 入口，而不是让用户建库到一半才报错。
 */

/** 有预编译 DuckDB 扩展的平台-架构组合白名单。 */
const SUPPORTED_OS = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']

/**
 * 判断当前运行环境是否支持内置知识库。
 * 纯同步探测（读 process 常量），无 IO、无副作用。
 */
export function isBuiltinKnowledgeSupported(): boolean {
  return SUPPORTED_OS.includes(`${process.platform}-${process.arch}`)
}
