#!/usr/bin/env node
// Office Reimbursement MCP Server（零依赖 stdio）
// 工具: create_reimbursement / submit_reimbursement / track_reimbursement / list_reimbursements
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { runStdioServer, loadConfig, textResult, jsonResult } from './lib/stdioFramework.mjs'
import { FeishuApprovalClient } from './lib/feishuApproval.mjs'
import { fillApprovalForm } from './lib/formFiller.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(__dirname, '..')
const STORE_PATH = join(pluginRoot, 'data', 'reimbursements.json')

const WARNING_TEXT =
  'Office Automation is not configured. Please open the plugin settings and set your Feishu App ID and App Secret, then restart the MCP server.'

const config = loadConfig(pluginRoot)
const appId = config?.appId || process.env.FEISHU_APP_ID || ''
const appSecret = config?.appSecret || process.env.FEISHU_APP_SECRET || ''

// ---------- 报销单本地存储（JSON 文件） ----------

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return { drafts: [] }
    return JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
  } catch {
    return { drafts: [] }
  }
}

function saveStore(store) {
  const dir = join(pluginRoot, 'data')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

// ---------- 工具实现 ----------

function createClient() {
  return new FeishuApprovalClient({
    appId,
    appSecret,
    brand: config?.brand || 'feishu'
  })
}

const tools = [
  {
    name: 'create_reimbursement',
    description:
      'Create a reimbursement draft from extracted invoice data. Does NOT submit to approval. Returns a draft ID for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '报销类型（差旅费/办公费/招待费/培训费/其他）' },
        invoices: {
          type: 'array',
          description: '发票结构化数据数组（invoice-recognition Skill 的输出）',
          items: { type: 'object' }
        },
        attachments: {
          type: 'array',
          description: '附件文件路径列表',
          items: { type: 'string' }
        },
        remark: { type: 'string', description: '备注（可选）' }
      },
      required: ['type', 'invoices']
    }
  },
  {
    name: 'submit_reimbursement',
    description:
      'Submit a confirmed reimbursement draft to Feishu approval. Requires user confirmation beforehand.',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '报销单草稿 ID（create_reimbursement 返回）' },
        approvalCode: {
          type: 'string',
          description: '飞书审批定义 code（缺省时自动搜索默认报销流程）'
        },
        userId: { type: 'string', description: '发起人飞书用户 open_id' },
        extraFormFields: {
          type: 'object',
          description: '额外表单字段（覆盖自动映射，如 {事由: "xxx"}）'
        }
      },
      required: ['draftId', 'userId']
    }
  },
  {
    name: 'track_reimbursement',
    description: 'Track the approval status of a submitted reimbursement.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: {
          type: 'string',
          description: '飞书审批实例 ID（submit_reimbursement 返回）'
        }
      },
      required: ['instanceId']
    }
  },
  {
    name: 'list_reimbursements',
    description: 'List local reimbursement records (drafts and submitted).',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: '按状态过滤: draft/submitted/all（默认 all）'
        }
      }
    }
  },
  {
    name: 'reimbursement_configure',
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
    ? tools.filter((t) => t.name !== 'reimbursement_configure')
    : [tools[tools.length - 1]]

async function callTool({ name, args }) {
  if (!appId || !appSecret) {
    return textResult(WARNING_TEXT, true)
  }
  const client = createClient()

  switch (name) {
    case 'create_reimbursement': {
      const { type, invoices, attachments = [], remark = '' } = args
      if (!Array.isArray(invoices) || invoices.length === 0) {
        return textResult('invoices 不能为空', true)
      }
      const totalAmount = invoices.reduce((sum, inv) => sum + (Number(inv.totalAmount) || 0), 0)
      const totalTax = invoices.reduce((sum, inv) => sum + (Number(inv.tax) || 0), 0)

      const store = loadStore()
      const draft = {
        id: `RMB-${new Date().getFullYear()}-${String(store.drafts.length + 1).padStart(3, '0')}`,
        type,
        invoices,
        attachments,
        remark,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalTax: Number(totalTax.toFixed(2)),
        status: 'draft',
        createdAt: new Date().toISOString()
      }
      store.drafts.push(draft)
      saveStore(store)

      return jsonResult({
        draftId: draft.id,
        type,
        invoiceCount: invoices.length,
        totalAmount: draft.totalAmount,
        totalTax: draft.totalTax,
        status: 'draft',
        message: '草稿已创建，等待用户确认后调用 submit_reimbursement 提交'
      })
    }

    case 'submit_reimbursement': {
      const { draftId, approvalCode, userId, extraFormFields = {} } = args
      const store = loadStore()
      const draft = store.drafts.find((d) => d.id === draftId)
      if (!draft) {
        return textResult(`报销单不存在: ${draftId}`, true)
      }
      if (draft.status === 'submitted') {
        return textResult(`报销单已提交过: ${draft.instanceId}`, true)
      }

      // 定位审批定义
      let code = approvalCode
      if (!code) {
        const searchResult = await client.searchApprovalDefinitions({
          keyword: '报销'
        })
        const approvals = searchResult.approvals ?? []
        if (approvals.length === 0) {
          return textResult('未找到报销类审批流程，请在飞书后台创建或指定 approvalCode', true)
        }
        code = approvals[0].approval_code
      }

      const definition = await client.getApprovalDefinition(code)
      const formItems = definition.form?.form ?? definition.form ?? []

      // 表单映射
      const formValues = fillApprovalForm({
        formDefinition: formItems,
        invoices: draft.invoices,
        extra: {
          ...extraFormFields,
          报销类型: draft.type,
          ...(draft.remark ? { 备注: draft.remark } : {})
        }
      })

      const instance = await client.createApprovalInstance({
        approvalCode: code,
        userId,
        form: formValues
      })

      draft.status = 'submitted'
      draft.instanceId = instance.approval_instance_id ?? instance.instance_id
      draft.approvalCode = code
      draft.submittedAt = new Date().toISOString()
      saveStore(store)

      return jsonResult({
        draftId: draft.id,
        instanceId: draft.instanceId,
        approvalCode: code,
        status: '审批中',
        message: '已提交飞书审批'
      })
    }

    case 'track_reimbursement': {
      const { instanceId } = args
      const detail = await client.getApprovalInstance(instanceId)
      return jsonResult({
        instanceId,
        status: detail.status,
        currentNode: detail.current_node_name ?? null,
        currentApprover: detail.current_task_approvers?.map((a) => a.user_name).join(', ') ?? null,
        startTime: detail.start_time,
        endTime: detail.end_time ?? null
      })
    }

    case 'list_reimbursements': {
      const { status = 'all' } = args
      const store = loadStore()
      const drafts =
        status === 'all' ? store.drafts : store.drafts.filter((d) => d.status === status)
      return jsonResult({
        count: drafts.length,
        items: drafts.map((d) => ({
          id: d.id,
          type: d.type,
          status: d.status,
          totalAmount: d.totalAmount,
          instanceId: d.instanceId ?? null,
          createdAt: d.createdAt
        }))
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

runStdioServer({
  serverInfo: { name: 'office-reimbursement-server', version: '0.1.0' },
  tools: activeTools,
  callTool
})
