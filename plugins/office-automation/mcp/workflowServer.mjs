#!/usr/bin/env node
// Office Workflow MCP Server（零依赖 stdio）
// 工具: search/get_workflow_definition, submit/track/approve_workflow,
//       list_pending_approvals, cancel_workflow, register_workflow_callback
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { runStdioServer, loadConfig, textResult, jsonResult } from './lib/stdioFramework.mjs'
import { FeishuApprovalClient } from './lib/feishuApproval.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(__dirname, '..')
const CALLBACKS_PATH = join(pluginRoot, 'data', 'workflowCallbacks.json')

const WARNING_TEXT =
  'Office Automation is not configured. Please open the plugin settings and set your Feishu App ID and App Secret, then restart the MCP server.'

const config = loadConfig(pluginRoot)
const appId = config?.appId || process.env.FEISHU_APP_ID || ''
const appSecret = config?.appSecret || process.env.FEISHU_APP_SECRET || ''

// 实例状态码 -> 可读文本（飞书审批 v4）
const STATUS_TEXT = {
  PENDING: '审批中',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
  CANCELED: '已撤销',
  DELETED: '已删除'
}

// ---------- 回调（轮询）注册存储 ----------

function loadCallbacks() {
  try {
    if (!existsSync(CALLBACKS_PATH)) return { callbacks: [] }
    return JSON.parse(readFileSync(CALLBACKS_PATH, 'utf-8'))
  } catch {
    return { callbacks: [] }
  }
}

function saveCallbacks(data) {
  const dir = join(pluginRoot, 'data')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(CALLBACKS_PATH, JSON.stringify(data, null, 2))
}

// ---------- 工具定义 ----------

function createClient() {
  return new FeishuApprovalClient({
    appId,
    appSecret,
    brand: config?.brand || 'feishu'
  })
}

const tools = [
  {
    name: 'search_workflow_definitions',
    description: 'Search Feishu approval workflow definitions by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词（如 报销/请假/采购）' },
        pageSize: { type: 'number', description: '每页数量（默认 20）' }
      }
    }
  },
  {
    name: 'get_workflow_definition',
    description: 'Get the detail (form definition) of a Feishu approval workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalCode: { type: 'string', description: '审批定义 code' }
      },
      required: ['approvalCode']
    }
  },
  {
    name: 'submit_workflow',
    description:
      'Submit a Feishu approval instance with form values. Requires user confirmation beforehand.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalCode: { type: 'string', description: '审批定义 code' },
        userId: { type: 'string', description: '发起人飞书用户 open_id' },
        form: { type: 'object', description: '表单字段键值对' }
      },
      required: ['approvalCode', 'userId', 'form']
    }
  },
  {
    name: 'track_workflow',
    description: 'Track the status of a Feishu approval instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '审批实例 ID' }
      },
      required: ['instanceId']
    }
  },
  {
    name: 'approve_workflow',
    description:
      'Approve or reject a pending task. NOTE: requires the approver identity (user_access_token); if unavailable, guide the user to approve in the Feishu client.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '审批任务 ID' },
        action: { type: 'string', enum: ['approve', 'reject'], description: '同意或拒绝' },
        comment: { type: 'string', description: '审批意见（可选）' }
      },
      required: ['taskId', 'action']
    }
  },
  {
    name: 'list_pending_approvals',
    description: 'List pending approval tasks assigned to a Feishu user.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '飞书用户 open_id' }
      },
      required: ['userId']
    }
  },
  {
    name: 'cancel_workflow',
    description:
      'Cancel (revoke) a submitted Feishu approval instance. Requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '审批实例 ID' },
        reason: { type: 'string', description: '撤销原因（可选）' }
      },
      required: ['instanceId']
    }
  },
  {
    name: 'register_workflow_callback',
    description:
      'Register a polling-based status callback for an approval instance. Returns a cron config for the agent to create a cronjob that polls track_workflow and notifies the user on status change.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '审批实例 ID' },
        intervalMinutes: { type: 'number', description: '轮询间隔分钟数（默认 30）' },
        notifyChannel: { type: 'string', description: '通知渠道: session/system（默认 session）' }
      },
      required: ['instanceId']
    }
  },
  {
    name: 'workflow_configure',
    description:
      'Feishu credentials are not configured. Open the Office Automation plugin settings.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
]

const activeTools =
  appId && appSecret
    ? tools.filter((t) => t.name !== 'workflow_configure')
    : [tools[tools.length - 1]]

// ---------- 工具实现 ----------

async function callTool({ name, args }) {
  if (!appId || !appSecret) {
    return textResult(WARNING_TEXT, true)
  }
  const client = createClient()

  switch (name) {
    case 'search_workflow_definitions': {
      const { keyword, pageSize = 20 } = args
      const result = await client.searchApprovalDefinitions({ keyword, pageSize })
      const approvals = result.approvals ?? []
      return jsonResult({
        count: approvals.length,
        items: approvals.map((a) => ({
          approvalCode: a.approval_code,
          name: a.approval_name,
          status: a.status ?? null,
          description: a.description ?? null
        }))
      })
    }

    case 'get_workflow_definition': {
      const { approvalCode } = args
      const definition = await client.getApprovalDefinition(approvalCode)
      return jsonResult({
        approvalCode,
        name: definition.approval_name ?? null,
        form: definition.form ?? null,
        nodeList: definition.node_list ?? null
      })
    }

    case 'submit_workflow': {
      const { approvalCode, userId, form } = args
      const instance = await client.createApprovalInstance({ approvalCode, userId, form })
      return jsonResult({
        instanceId: instance.approval_instance_id ?? instance.instance_id,
        approvalCode,
        status: STATUS_TEXT.PENDING
      })
    }

    case 'track_workflow': {
      const { instanceId } = args
      const detail = await client.getApprovalInstance(instanceId)
      return jsonResult({
        instanceId,
        status: detail.status ?? null,
        statusText: STATUS_TEXT[detail.status] ?? detail.status,
        currentNode: detail.current_node_name ?? null,
        currentApprover: detail.current_task_approvers?.map((a) => a.user_name).join(', ') ?? null,
        startTime: detail.start_time ?? null,
        endTime: detail.end_time ?? null
      })
    }

    case 'approve_workflow': {
      // 飞书审批同意/拒绝需用户身份（user_access_token）
      // 应用身份（tenant_access_token）不可代审批——返回引导而非报错中断
      return textResult(
        '审批操作需要审批人用户身份授权（user_access_token），当前插件仅支持应用身份。' +
          '请在飞书客户端中打开该审批任务并人工处理；或为本插件配置用户身份授权后重试。',
        true
      )
    }

    case 'list_pending_approvals': {
      const { userId } = args
      // 飞书 v4 待办查询: approval/v4/tasks/query (user_id 为查询主体)
      const result = await client.request('POST', '/approval/v4/tasks/query', {
        user_id: userId
      })
      const tasks = result.tasks ?? []
      return jsonResult({
        count: tasks.length,
        items: tasks.map((t) => ({
          taskId: t.task_id,
          instanceId: t.instance_id ?? null,
          name: t.title ?? null,
          status: t.status ?? null
        }))
      })
    }

    case 'cancel_workflow': {
      const { instanceId, reason = '' } = args
      await client.request('POST', `/approval/v4/instances/${instanceId}/revoke`, {
        reason
      })
      return jsonResult({ instanceId, status: STATUS_TEXT.CANCELED })
    }

    case 'register_workflow_callback': {
      const { instanceId, intervalMinutes = 30, notifyChannel = 'session' } = args
      const data = loadCallbacks()
      const existing = data.callbacks.find((c) => c.instanceId === instanceId)
      if (existing) {
        return jsonResult({
          message: '该实例已注册轮询回调',
          ...existing
        })
      }

      const callback = {
        instanceId,
        intervalMinutes,
        notifyChannel,
        lastStatus: null,
        createdAt: new Date().toISOString()
      }
      data.callbacks.push(callback)
      saveCallbacks(data)

      // 返回 cron 配置，由 Agent 通过 cronjob Agent Tool 创建定时任务
      return jsonResult({
        ...callback,
        cronConfig: {
          expression: `*/${Math.min(59, Math.max(1, Math.round(intervalMinutes)))} * * * *`,
          task:
            `调用 track_workflow 工具查询实例 ${instanceId} 状态；` +
            `状态从上次记录变化时通过 ${notifyChannel} 通知用户；` +
            '实例到达终态（APPROVED/REJECTED/CANCELED）后删除本 cronjob'
        },
        message: '已登记回调，请按 cronConfig 创建 cronjob 定时任务'
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

runStdioServer({
  serverInfo: { name: 'office-workflow', version: '0.1.0' },
  tools: activeTools,
  callTool
})
