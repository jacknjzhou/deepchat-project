// 任务/简历状态 → 文案键与徽标 variant 的统一映射，
// 供 TaskHistoryList / TaskProgressHeader / ResumeListPanel 复用
export function statusLabel(t: (key: string) => string, status: string): string {
  return t(`resumeScreening.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)
}

export function statusVariant(
  status: string
): 'active' | 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'running':
      return 'active'
    case 'completed':
    case 'done':
      return 'success'
    case 'partial':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
}
