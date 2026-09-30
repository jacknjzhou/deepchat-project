// 零依赖 MCP stdio 通信框架
// MCP stdio 传输规范：消息为换行分隔的 JSON（一行一条，不得内嵌换行），
// 与 @modelcontextprotocol/client 的 StdioClientTransport 对齐。
// 由 reimbursementServer.mjs / workflowServer.mjs 共享使用
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function sendFrame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

export function sendResult(id, result) {
  sendFrame({ jsonrpc: '2.0', id, result })
}

export function sendError(id, code, message) {
  sendFrame({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  })
}

export function loadConfig(pluginRoot) {
  const configPath = join(pluginRoot, 'config.json')
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

// 构建并运行 MCP server：tools 为 [{name, description, inputSchema}]，
// callTool 为 async ({name, args}) => {content, isError?}
export function runStdioServer({ serverInfo, tools, callTool, instructions }) {
  let buffer = Buffer.alloc(0)

  async function handleMessage(message) {
    if (message.id == null || typeof message.method !== 'string') {
      return
    }

    switch (message.method) {
      case 'initialize':
        sendResult(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo,
          ...(instructions ? { instructions } : {})
        })
        return
      case 'ping':
      case 'logging/setLevel':
        sendResult(message.id, {})
        return
      case 'tools/list':
        sendResult(message.id, { tools })
        return
      case 'tools/call': {
        const { name, arguments: args } = message.params ?? {}
        try {
          const result = await callTool({ name, args: args ?? {} })
          sendResult(message.id, result)
        } catch (error) {
          sendResult(message.id, {
            content: [
              {
                type: 'text',
                text: `Error: ${error instanceof Error ? error.message : String(error)}`
              }
            ],
            isError: true
          })
        }
        return
      }
      case 'resources/list':
        sendResult(message.id, { resources: [] })
        return
      case 'prompts/list':
        sendResult(message.id, { prompts: [] })
        return
      default:
        sendError(message.id, -32601, `Method not found: ${message.method}`)
    }
  }

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }

      const line = buffer.slice(0, newlineIndex).toString('utf8').trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }

      try {
        const message = JSON.parse(line)
        if (Array.isArray(message)) {
          for (const item of message) {
            handleMessage(item)
          }
          continue
        }
        handleMessage(message)
      } catch {
        // Ignore malformed frames and keep the server alive.
      }
    }
  })

  process.stdin.resume()
}

// 文本结果快捷构造
export function textResult(text, isError = false) {
  const result = {
    content: [
      {
        type: 'text',
        text
      }
    ]
  }
  if (isError) result.isError = true
  return result
}

export function jsonResult(data) {
  return textResult(JSON.stringify(data, null, 2))
}
