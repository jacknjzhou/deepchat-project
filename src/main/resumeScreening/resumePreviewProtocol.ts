import { protocol } from 'electron'
import path from 'path'

export const RESUME_PREVIEW_PROTOCOL = 'resume-preview'

let schemesRegistered = false

/** 必须在 app ready 前调用；standard+stream 特权使渲染层 iframe 可直接加载源文件 */
export function registerResumePreviewScheme(): void {
  if (schemesRegistered) return
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RESUME_PREVIEW_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
  schemesRegistered = true
}

/**
 * 解析 resume-preview://<taskId>/<fileName> 到简历存储目录内的真实路径。
 * 仅允许两段路径，并做越界防护；不合法返回 null
 */
export function resolveResumePreviewRequest(url: string, storageRoot: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(
      url.slice(`${RESUME_PREVIEW_PROTOCOL}://`.length).split(/[?#]/, 1)[0] ?? ''
    )
  } catch {
    return null
  }

  const segments = decoded.split('/').filter(Boolean)
  if (segments.length !== 2) return null
  const [taskId, fileName] = segments
  if (!taskId || !fileName) return null

  const root = path.resolve(storageRoot)
  const fullPath = path.resolve(root, taskId, fileName)
  const relative = path.relative(root, fullPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return fullPath
}
