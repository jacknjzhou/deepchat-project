/**
 * StaffDeck 错误码 → i18n key 映射。
 *
 * 三条硬约束：
 * 1. 未知码回落通用文案，绝不把原始码拼进 key（内部枚举不该出现在 UI）。
 * 2. 绝不展示服务端 detail（`errors.py` 的 detail 可能含内部路径）。
 * 3. 只映射真实存在的码。表里的每一项都能在服务端 `public_api` 的
 *    `PublicAPIError` / `problem_response` 调用点，或本客户端
 *    `remoteRunner.ts` / `remoteClient.ts` / `remoteRoutes.ts` 里找到产生点；
 *    凭空登记的码会让排查永远命中不到真正的分支。
 */

const ERROR_CODE_KEYS: Record<string, string> = {
  // 鉴权/权限（public_api/auth.py 的 scope 校验）
  API_KEY_REQUIRED: 'digitalEmployee.remote.error.apiKeyRequired',
  INVALID_API_KEY: 'digitalEmployee.remote.error.apiKeyRequired',
  NOT_AUTHENTICATED: 'digitalEmployee.remote.error.apiKeyRequired',
  API_KEY_EXPIRED: 'digitalEmployee.remote.error.apiKeyExpired',
  API_KEY_REVOKED: 'digitalEmployee.remote.error.apiKeyRevoked',
  INSUFFICIENT_SCOPE: 'digitalEmployee.remote.error.insufficientScope',
  // 资源不存在
  AGENT_NOT_FOUND: 'digitalEmployee.remote.error.agentNotFound',
  SESSION_NOT_FOUND: 'digitalEmployee.remote.error.sessionNotFound',
  RUN_NOT_FOUND: 'digitalEmployee.remote.error.runNotFound',
  JOB_NOT_FOUND: 'digitalEmployee.remote.error.runNotFound',
  // 会话冲突与幂等
  EXTERNAL_SESSION_CONFLICT: 'digitalEmployee.remote.error.sessionConflict',
  IDEMPOTENCY_CONFLICT: 'digitalEmployee.remote.error.sessionConflict',
  // run 生命周期
  RUN_NOT_SUCCEEDED: 'digitalEmployee.remote.error.runNotSucceeded',
  JOB_EXECUTION_FAILED: 'digitalEmployee.remote.error.runFailed',
  JOB_HANDLER_MISSING: 'digitalEmployee.remote.error.runFailed',
  ACTION_BUDGET_EXHAUSTED: 'digitalEmployee.remote.error.actionBudget',
  CAPABILITY_UNAVAILABLE: 'digitalEmployee.remote.error.capabilityUnavailable',
  // 服务重启/流中断（harness_recovery.py、jobs.py 的终止帧）
  SERVICE_RESTARTED: 'digitalEmployee.remote.error.streamInterrupted',
  HARNESS_EXECUTION_LOST: 'digitalEmployee.remote.error.streamInterrupted',
  STREAM_INTERRUPTED: 'digitalEmployee.remote.error.streamInterrupted',
  // run.failed 帧体里透传的真实原因（agent_loop.py 的 error_occurred）
  LLM_ERROR: 'digitalEmployee.remote.error.llmError',
  HARNESS_V2_ERROR: 'digitalEmployee.remote.error.runFailed',
  // 本客户端产生的码
  REMOTE_RUN_IN_PROGRESS: 'digitalEmployee.remote.error.runInProgress',
  REMOTE_SESSION_UNAVAILABLE: 'digitalEmployee.remote.error.sessionUnavailable',
  REMOTE_TRANSPORT_ERROR: 'digitalEmployee.remote.error.transportError',
  RUN_FAILED: 'digitalEmployee.remote.error.runFailed'
}

export const STAFFDECK_ERROR_GENERIC_KEY = 'digitalEmployee.remote.error.generic'

export function staffdeckErrorCodeToI18nKey(code: string | null | undefined): string {
  if (!code) return STAFFDECK_ERROR_GENERIC_KEY
  return ERROR_CODE_KEYS[code] ?? STAFFDECK_ERROR_GENERIC_KEY
}

/** 测试与排查用：当前登记的全部错误码（顺序无意义）。 */
export const STAFFDECK_KNOWN_ERROR_CODES = Object.keys(ERROR_CODE_KEYS)
