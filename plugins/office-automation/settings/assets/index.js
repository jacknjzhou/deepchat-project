const stateNode = document.getElementById('plugin-state')
const mcpReimbursementNode = document.getElementById('mcp-reimbursement-state')
const mcpWorkflowNode = document.getElementById('mcp-workflow-state')
const brandNode = document.getElementById('brand')
const appIdNode = document.getElementById('app-id')
const appSecretNode = document.getElementById('app-secret')
const presetNode = document.getElementById('preset')
const messageNode = document.getElementById('message')

function setMessage(value) {
  if (messageNode) messageNode.textContent = value || ''
}

function setState(enabled) {
  if (!stateNode) return
  stateNode.textContent = enabled ? 'Enabled' : 'Disabled'
  stateNode.className = enabled ? 'state state-ok' : 'state state-muted'
}

function setMcpState(node, mcp) {
  if (!node) return
  if (!mcp) {
    node.textContent = 'Unavailable'
    node.className = 'state state-muted'
    return
  }
  if (mcp.running) {
    node.textContent = 'Running'
    node.className = 'state state-ok'
    setMessage('')
  } else if (mcp.enabled) {
    node.textContent = 'Stopped'
    node.className = 'state state-muted'
    setMessage('')
  } else if (mcp.lastError) {
    node.textContent = 'Error'
    node.className = 'state state-error'
    setMessage(mcp.lastError)
  } else {
    node.textContent = 'Disabled'
    node.className = 'state state-muted'
    setMessage('')
  }
}

function getPluginApi() {
  const api = window.deepchatPlugin
  if (!api) throw new Error('Plugin settings bridge is unavailable.')
  return api
}

async function loadConfig() {
  const result = await getPluginApi().invokeAction('config.get')
  if (result.ok && result.data) {
    brandNode.value = result.data.brand || 'feishu'
    appIdNode.value = result.data.appId || ''
    appSecretNode.value = result.data.appSecret || ''
    presetNode.value = result.data.preset || ''
  }
}

async function refreshStatus() {
  const status = await getPluginApi().getStatus()
  setState(status.enabled)

  setMcpState(
    mcpReimbursementNode,
    status.mcpServers?.find((s) => s.serverId === 'office-reimbursement')
  )
  setMcpState(
    mcpWorkflowNode,
    status.mcpServers?.find((s) => s.serverId === 'office-workflow')
  )
}

document.getElementById('save')?.addEventListener('click', async () => {
  const appId = appIdNode.value.trim()
  const appSecret = appSecretNode.value.trim()

  if (!appId || !appSecret) {
    setMessage('App ID and App Secret are required.')
    return
  }

  setMessage('Saving...')
  const result = await getPluginApi().invokeAction('config.set', {
    appId,
    appSecret,
    brand: brandNode.value,
    preset: presetNode.value.trim()
  })

  if (result.ok) {
    setMessage('Saved. Restart the MCP servers if they are running.')
  } else {
    setMessage(result.error || 'Failed to save configuration.')
  }
  await refreshStatus()
})

document.getElementById('refresh')?.addEventListener('click', async () => {
  setMessage('Refreshing...')
  await refreshStatus()
  setMessage('')
})

;(async () => {
  try {
    await loadConfig()
    await refreshStatus()
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error))
  }
})()
