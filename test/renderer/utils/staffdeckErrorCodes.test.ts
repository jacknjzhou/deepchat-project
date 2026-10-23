import { describe, expect, it } from 'vitest'
import {
  STAFFDECK_KNOWN_ERROR_CODES,
  staffdeckErrorCodeToI18nKey
} from '../../../src/renderer/src/utils/staffdeckErrorCodes'

describe('staffdeckErrorCodeToI18nKey', () => {
  it('maps the scope failure to a permission message', () => {
    expect(staffdeckErrorCodeToI18nKey('INSUFFICIENT_SCOPE')).toBe(
      'digitalEmployee.remote.error.insufficientScope'
    )
  })

  it('maps the missing agent and session codes', () => {
    expect(staffdeckErrorCodeToI18nKey('AGENT_NOT_FOUND')).toBe(
      'digitalEmployee.remote.error.agentNotFound'
    )
    expect(staffdeckErrorCodeToI18nKey('SESSION_NOT_FOUND')).toBe(
      'digitalEmployee.remote.error.sessionNotFound'
    )
    expect(staffdeckErrorCodeToI18nKey('EXTERNAL_SESSION_CONFLICT')).toBe(
      'digitalEmployee.remote.error.sessionConflict'
    )
  })

  it('maps the run lifecycle codes', () => {
    expect(staffdeckErrorCodeToI18nKey('RUN_NOT_SUCCEEDED')).toBe(
      'digitalEmployee.remote.error.runNotSucceeded'
    )
    expect(staffdeckErrorCodeToI18nKey('JOB_EXECUTION_FAILED')).toBe(
      'digitalEmployee.remote.error.runFailed'
    )
    expect(staffdeckErrorCodeToI18nKey('STREAM_INTERRUPTED')).toBe(
      'digitalEmployee.remote.error.streamInterrupted'
    )
  })

  it('maps the failure reasons carried by the run.failed payload', () => {
    // 服务端 error_occurred 带真实原因；压成通用 code 会让「模型失败」和
    // 「harness 出错」变成同一句提示，用户无法判断该重试还是找管理员。
    expect(staffdeckErrorCodeToI18nKey('LLM_ERROR')).toBe('digitalEmployee.remote.error.llmError')
    expect(staffdeckErrorCodeToI18nKey('HARNESS_V2_ERROR')).toBe(
      'digitalEmployee.remote.error.runFailed'
    )
    expect(staffdeckErrorCodeToI18nKey('HARNESS_EXECUTION_LOST')).toBe(
      'digitalEmployee.remote.error.streamInterrupted'
    )
    expect(staffdeckErrorCodeToI18nKey('ACTION_BUDGET_EXHAUSTED')).toBe(
      'digitalEmployee.remote.error.actionBudget'
    )
    expect(staffdeckErrorCodeToI18nKey('CAPABILITY_UNAVAILABLE')).toBe(
      'digitalEmployee.remote.error.capabilityUnavailable'
    )
  })

  it('distinguishes an expired or revoked key from a merely missing one', () => {
    expect(staffdeckErrorCodeToI18nKey('API_KEY_EXPIRED')).toBe(
      'digitalEmployee.remote.error.apiKeyExpired'
    )
    expect(staffdeckErrorCodeToI18nKey('API_KEY_REVOKED')).toBe(
      'digitalEmployee.remote.error.apiKeyRevoked'
    )
    expect(staffdeckErrorCodeToI18nKey('API_KEY_REQUIRED')).toBe(
      'digitalEmployee.remote.error.apiKeyRequired'
    )
  })

  it('maps local codes produced by this client', () => {
    expect(staffdeckErrorCodeToI18nKey('REMOTE_RUN_IN_PROGRESS')).toBe(
      'digitalEmployee.remote.error.runInProgress'
    )
    expect(staffdeckErrorCodeToI18nKey('REMOTE_SESSION_UNAVAILABLE')).toBe(
      'digitalEmployee.remote.error.sessionUnavailable'
    )
    expect(staffdeckErrorCodeToI18nKey('REMOTE_TRANSPORT_ERROR')).toBe(
      'digitalEmployee.remote.error.transportError'
    )
  })

  it('falls back to a generic key for an unknown code', () => {
    expect(staffdeckErrorCodeToI18nKey('SOMETHING_NEW')).toBe(
      'digitalEmployee.remote.error.generic'
    )
  })

  it('falls back for an empty or missing code', () => {
    expect(staffdeckErrorCodeToI18nKey(undefined)).toBe('digitalEmployee.remote.error.generic')
    expect(staffdeckErrorCodeToI18nKey('')).toBe('digitalEmployee.remote.error.generic')
  })

  it('never echoes the raw code into a user-visible key', () => {
    // 未知码只回落到通用文案，避免把内部枚举直接展示给用户。
    const key = staffdeckErrorCodeToI18nKey('INTERNAL_DB_PATH_LEAK')
    expect(key).not.toContain('INTERNAL_DB_PATH_LEAK')
  })

  it('only registers i18n keys that actually exist in the baseline locale', () => {
    // 映射表登记了不存在的 key，UI 会直接显示原始 key（`digitalEmployee.remote.error.xxx`），
    // 比展示通用文案更糟。这里对 en-US 做一次落地校验。
    const messages = require('../../../src/renderer/src/i18n/en-US/digitalEmployee.json')
    const lookup = (key: string): unknown =>
      key
        .split('.')
        .slice(1)
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)

    for (const code of STAFFDECK_KNOWN_ERROR_CODES) {
      const key = staffdeckErrorCodeToI18nKey(code)
      expect(lookup(key), `missing locale entry for ${code} -> ${key}`).toBeTypeOf('string')
    }
  })
})
