// 飞书审批 API 封装（零依赖，Node >= 20 全局 fetch）
// 文档: https://open.feishu.cn/document/server-docs/approval-v4/overview

export class FeishuApprovalClient {
  constructor({ appId, appSecret, brand = 'feishu' }) {
    this.appId = appId
    this.appSecret = appSecret
    this.baseUrl =
      brand === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis'
    this.tokenCache = { token: null, expiresAt: 0 }
  }

  // 获取 tenant_access_token（内存缓存 + 过期刷新）
  async getTenantAccessToken() {
    const now = Date.now()
    if (this.tokenCache.token && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token
    }

    const response = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret
      })
    })

    const data = await response.json()
    if (data.code !== 0) {
      throw new Error(`获取 tenant_access_token 失败: ${data.code} ${data.msg}`)
    }

    this.tokenCache = {
      token: data.tenant_access_token,
      expiresAt: now + (data.expire ?? 7200) * 1000
    }
    return this.tokenCache.token
  }

  async request(method, path, body) {
    const token = await this.getTenantAccessToken()
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      ...(method !== 'GET' && body ? { body: JSON.stringify(body) } : {})
    })

    const data = await response.json()
    if (data.code !== 0) {
      throw new Error(`飞书 API 错误 (${path}): ${data.code} ${data.msg}`)
    }
    return data.data ?? {}
  }

  // 搜索审批定义
  async searchApprovalDefinitions({ pageSize = 20, keyword }) {
    const body = { page_size: pageSize }
    if (keyword) body.query = keyword
    return this.request('POST', '/approval/v4/approvals/search', body)
  }

  // 获取审批定义详情（含表单定义）
  async getApprovalDefinition(approvalCode) {
    return this.request('GET', `/approval/v4/approvals/${approvalCode}`)
  }

  // 创建审批实例
  async createApprovalInstance({ approvalCode, userId, form, departmentId }) {
    const body = {
      approval_code: approvalCode,
      user_id: userId,
      form: typeof form === 'string' ? form : JSON.stringify(form)
    }
    if (departmentId) body.department_id = departmentId
    return this.request('POST', '/approval/v4/instances', body)
  }

  // 获取审批实例详情
  async getApprovalInstance(instanceId) {
    return this.request('GET', `/approval/v4/instances/${instanceId}`)
  }

  // 批量获取审批实例详情
  async batchGetApprovalInstances(instanceIds) {
    return this.request('POST', '/approval/v4/instances/batch_get', { instance_ids: instanceIds })
  }
}
