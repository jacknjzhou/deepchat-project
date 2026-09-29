import { describe, expect, it } from 'vitest'
import { statusVariant } from '@/pages/resumeScreening/components/statusPresentation'

describe('statusPresentation', () => {
  it('statusVariant 覆盖全部已知状态分支与默认值', () => {
    expect(statusVariant('running')).toBe('active')
    expect(statusVariant('completed')).toBe('success')
    expect(statusVariant('done')).toBe('success')
    expect(statusVariant('partial')).toBe('warning')
    expect(statusVariant('failed')).toBe('danger')
    expect(statusVariant('queued')).toBe('neutral')
    expect(statusVariant('cancelled')).toBe('neutral')
    expect(statusVariant('pending')).toBe('neutral')
    expect(statusVariant('unknown-status')).toBe('neutral')
  })
})
