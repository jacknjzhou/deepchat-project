/**
 * 工具派发前（尚未触达 server）失败时使用的错误码：调用方可据此区分
 * 「server 拒绝/环境变化」与「server 返回的执行错误」，选择重试或提示。
 */
export type McpPreDispatchErrorCode =
  /** 打包目录定义与 server 实际定义不一致（目录型工具核验失败）。 */
  | 'definition_changed'
  /** 参数非法（JSON 解析失败、imgcache 解析失败等）。 */
  | 'invalid_request'
  /** MCP 运行时整体不可用（注册表/映射缺失）。 */
  | 'runtime_unavailable'
  /** 派发前核验发现授权目标已变化（serverId/代际/绑定指纹不匹配）。 */
  | 'target_changed'
  /** 目标工具或其 server 配置不存在。 */
  | 'target_unavailable'
  /** 访问被访问控制拒绝（ACP 白名单、插件策略等）。 */
  | 'tool_not_allowed'

/**
 * 派发前错误。与普通执行错误不同，这类失败保证请求未被发送到 server，
 * 因此是安全的可重试点；ToolManager 在 throwPreDispatchErrors 关闭时会
 * 把它降级为 isError 响应对象。
 */
export class McpPreDispatchError extends Error {
  constructor(
    message: string,
    readonly code: McpPreDispatchErrorCode
  ) {
    super(message)
    this.name = 'McpPreDispatchError'
  }
}
