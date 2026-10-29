/**
 * MCP OAuth 回调常量。本地回调端口与等待时长可用环境变量覆盖（部署/
 * 测试场景），非法值一律回落默认——配置错误不应阻断 OAuth 流程。
 * 端口被占用时由 OAuth 管理器自行降级到随机端口，这里的值只是首选。
 */

function getPortEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback
}

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const MCP_OAUTH_REDIRECT_PORT = getPortEnv('DEEPCHAT_MCP_OAUTH_REDIRECT_PORT', 1456)
export const MCP_OAUTH_REDIRECT_PATH = '/mcp/oauth/callback'
export const MCP_OAUTH_CALLBACK_TIMEOUT_MS = getNumberEnv(
  'DEEPCHAT_MCP_OAUTH_CALLBACK_TIMEOUT_MS',
  10 * 60 * 1000
)
