/**
 * Electron 主进程入口。
 *
 * package.json 的 "main" 字段指向本文件的构建产物，Electron 启动后从这里
 * 执行第一行用户代码。本文件刻意保持极薄：只调用 startApp()，进程级的
 * 启动编排（单实例锁、scheme 注册、deep link、quit/shutdown 状态机）全部
 * 在 appMain.ts，服务装配在其下游 mainProcess.ts → composition.ts。
 */
import { startApp } from './appMain'

startApp()
