import { Server, Transport } from '@modelcontextprotocol/server'
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { toDeepChatJsonSchema } from '@shared/lib/zodJsonSchema'
import axios from 'axios'

// 百度千帆 AI Search web_search 端点（智能搜索生成服务）
const BAIDU_AI_SEARCH_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search'

// freshness 入参 -> 千帆 search_recency_filter 取值映射
const RECENCY_MAP = {
  noLimit: 'noLimit',
  oneYear: 'year',
  oneMonth: 'month',
  oneWeek: 'week',
  oneDay: 'day'
} as const

// Schema definitions
const BaiduWebSearchArgsSchema = z.object({
  query: z.string().describe('Search query (required)'),
  count: z.number().optional().default(10).describe('Number of results top_k (1-50, default 10)'),
  freshness: z
    .string()
    .optional()
    .default('noLimit')
    .describe(
      'The time range for the search results. (Available options noLimit, oneYear, oneMonth, oneWeek, oneDay. Default is noLimit)'
    ),
  siteFilter: z
    .array(z.string())
    .optional()
    .describe('Optional site filter (list of domains, e.g. ["www.weather.com.cn"])')
})

// 千帆 AI Search web_search 响应结构（按官方文档对接）
interface QianfanWebSearchResponse {
  id?: string
  references?: Array<{
    title: string
    url: string
    content: string // 摘要片段
    siteName?: string
    publishDate?: string
  }>
}

export class BaiduSearchServer {
  private server: Server
  private apiKey: string

  constructor(env?: Record<string, unknown>) {
    // 凭证复用百度千帆 provider 的 API Key（Bearer 认证）
    const apiKey = String(env?.apiKey ?? '')
    if (!apiKey) {
      throw new Error('需要提供百度千帆 API Key（与千帆 provider 同一凭证）')
    }
    this.apiKey = apiKey

    // 创建服务器实例
    this.server = new Server(
      {
        name: 'deepchat-inmemory/baidu-search-server',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    // 设置请求处理器
    this.setupRequestHandlers()
  }

  // 启动服务器
  public startServer(transport: Transport): void {
    this.server.connect(transport)
  }

  // 设置请求处理器
  private setupRequestHandlers(): void {
    // 设置工具列表处理器
    this.server.setRequestHandler('tools/list', async () => {
      return {
        tools: [
          {
            name: 'baidu_web_search',
            description:
              'Search the web with Baidu (Qianfan AI Search) and get results including titles, urls, summaries, site names and publication dates.',
            inputSchema: toDeepChatJsonSchema(BaiduWebSearchArgsSchema),
            annotations: {
              title: 'Baidu Web Search',
              readOnlyHint: true,
              openWorldHint: true
            }
          }
        ]
      }
    })

    // 设置工具调用处理器
    this.server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
      try {
        const { name, arguments: args } = request.params

        switch (name) {
          case 'baidu_web_search': {
            const parsed = BaiduWebSearchArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid search parameters: ${parsed.error}`)
            }

            const { query, count, freshness, siteFilter } = parsed.data

            // 千帆 AI Search web_search 请求体（Bearer 认证，Key 与千帆 provider 同源）
            const requestBody: Record<string, unknown> = {
              messages: [{ content: query, role: 'user' }],
              search_source: 'baidu_search_v2',
              resource_type_filter: [{ type: 'web', top_k: count }],
              search_recency_filter: RECENCY_MAP[freshness as keyof typeof RECENCY_MAP] ?? 'noLimit'
            }
            if (siteFilter?.length) {
              requestBody.search_filter = { match: { site: siteFilter } }
            }

            const response = await axios.post(BAIDU_AI_SEARCH_ENDPOINT, requestBody, {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            })

            const searchResponse = response.data as QianfanWebSearchResponse
            const pages = searchResponse.references ?? []

            if (pages.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No results found.'
                  }
                ]
              }
            }

            // 将结果转换为MCP资源格式（与 Bocha 输出同构）
            const results = pages.map((item, index): ContentBlock => {
              const blobContent = {
                title: item.title,
                url: item.url,
                rank: index + 1,
                content: item.content,
                siteName: item.siteName,
                publishedDate: item.publishDate
              }

              return {
                type: 'resource',
                resource: {
                  uri: item.url,
                  mimeType: 'application/deepchat-webpage',
                  text: JSON.stringify(blobContent)
                }
              }
            })

            // 添加搜索摘要
            const summaryText = `Found ${results.length} results for "${query}"`
            const summary: ContentBlock = {
              type: 'text',
              text: summaryText
            }

            return {
              content: [summary, ...results]
            }
          }

          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (error) {
        console.error('Error calling tool:', error) // Log the error server-side
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'An unknown error occurred'

        // Check for specific Axios errors
        if (axios.isAxiosError(error)) {
          const status = error.response?.status
          const details = error.response?.data ? JSON.stringify(error.response.data) : error.message
          const finalMessage = `Baidu AI Search request failed: ${status ? `Status ${status}` : ''} - ${details}`
          return {
            content: [{ type: 'text', text: `Error: ${finalMessage}` }],
            isError: true
          }
        }

        return {
          content: [{ type: 'text', text: `Error: ${errorMessage}` }],
          isError: true
        }
      }
    })
  }
}
