import { Server, Transport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { toDeepChatJsonSchema } from '@shared/lib/zodJsonSchema'
import type { MCPTextContent } from '@shared/types/mcp'
import type { KnowledgeSearchPort, QueryResult } from '@shared/types/knowledge'

/**
 * 每员工本地知识检索工具，形态与 `BuiltinKnowledgeServer` 同构。
 *
 * 与 staffdeck_* 远端工具对齐的思路：知识不该只在首问注入一次，模型在会话
 * 任何一轮都应该能主动查。三个不可破的规则：
 *
 * 1. 服务端只认本地库 id（`de-{employeeId}`），服务端 `kb_*` id 在本地配置里
 *    没有对应库，查了必然空手而归。
 * 2. 查询失败一律降级为工具文本，绝不抛错打断会话——知识是辅助，不是依赖。
 * 3. 没绑定本地库（如员工没配知识库、同步被跳过）时直接答「未找到」，
 *    不做无意义的索引查询。
 */

const SearchArgsSchema = z.object({
  query: z.string().describe('检索问题或关键词 (必填)')
})

const EMPTY_NOTICE = '未找到相关知识。'
const FAILURE_NOTICE = '知识检索失败，请稍后重试。'

export interface DigitalEmployeeKnowledgeServerDeps {
  /** 本地向量库的检索入口；实现方负责索引为空等内部异常。 */
  knowledge: Pick<KnowledgeSearchPort, 'similarityQuery'>
  /**
   * 该员工绑定的本地库 id（`de-{employeeId}`）。
   * 空串表示员工没有绑定任何本地知识库，工具将直接答「未找到」。
   */
  localKnowledgeBaseId: string
}

/**
 * 承载 `de_knowledge_search` 工具的 in-memory MCP server。
 *
 * 一个员工对应一个实例，由 `mcpClient` 经 inmemory 工厂按 config `env`
 * 里的 `localKnowledgeBaseId` 构造；生命周期（启动/停止）由
 * `knowledgeToolRegistration.ts` 管理，本类只负责协议应答。
 */
export class DigitalEmployeeKnowledgeServer {
  private server: Server
  private readonly knowledge: Pick<KnowledgeSearchPort, 'similarityQuery'>
  private readonly localKnowledgeBaseId: string

  constructor(deps: DigitalEmployeeKnowledgeServerDeps) {
    this.knowledge = deps.knowledge
    this.localKnowledgeBaseId = deps.localKnowledgeBaseId
    this.server = new Server(
      { name: 'deepchat-inmemory/de-kb-server', version: '0.1.0' },
      { capabilities: { tools: {} } }
    )
    this.setupRequestHandlers()
  }

  public startServer(transport: Transport): void {
    this.server.connect(transport)
  }

  /** 供 MCP handler 与测试共用；返回 MCP tools/list 的响应形状。 */
  public async listTools() {
    return {
      tools: [
        {
          name: 'de_knowledge_search',
          description:
            '检索该数字员工本地知识库中的参考内容。当用户问到制度、流程、事实类问题时使用。',
          inputSchema: toDeepChatJsonSchema(SearchArgsSchema),
          annotations: { title: 'Digital Employee Knowledge Search', readOnlyHint: true }
        }
      ]
    }
  }

  /** 供 MCP handler 与测试共用；失败一律降级为文本，不抛错。 */
  public async callTool(
    name: string,
    parameters: Record<string, unknown> | undefined
  ): Promise<{ content: MCPTextContent[] }> {
    if (name !== 'de_knowledge_search') {
      return { content: [{ type: 'text', text: `未知工具: ${name}` }] }
    }
    const query = (parameters as { query?: string } | undefined)?.query?.trim() ?? ''
    if (query === '' || this.localKnowledgeBaseId === '') {
      return { content: [{ type: 'text', text: EMPTY_NOTICE }] }
    }
    try {
      const results = await this.knowledge.similarityQuery(this.localKnowledgeBaseId, query)
      // 只取前 5 条并拼成编号列表；过滤掉剥离「[n] 」前缀后没有正文的空命中，
      // 避免把索引里的空片段当作结果喂给模型。
      const lines = results
        .slice(0, 5)
        .map((result: QueryResult, index: number) =>
          `[${index + 1}] ${result.metadata?.content ?? ''}`.trim()
        )
        .filter((line) => line.length > 4)
      return {
        content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : EMPTY_NOTICE }]
      }
    } catch (error) {
      // 检索链路的任何异常（索引缺失、向量库故障）都折行进工具文本：
      // 模型能看到失败并改用自身知识作答，会话不中断。
      return {
        content: [
          {
            type: 'text',
            text: `${FAILURE_NOTICE}(${error instanceof Error ? error.message : String(error)})`
          }
        ]
      }
    }
  }

  /** 把协议处理方法挂到 MCP server 上，构造时即完成装配。 */
  private setupRequestHandlers(): void {
    this.server.setRequestHandler('tools/list', async () => this.listTools())
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: parameters } = request.params
      return this.callTool(name, parameters)
    })
  }
}

export function createDigitalEmployeeKnowledgeServer(deps: DigitalEmployeeKnowledgeServerDeps) {
  return new DigitalEmployeeKnowledgeServer(deps)
}
