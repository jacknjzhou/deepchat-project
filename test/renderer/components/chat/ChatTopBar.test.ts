import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatTopBar from '@/components/chat/ChatTopBar.vue'

const stores = vi.hoisted(() => ({
  session: {
    sessions: [
      {
        id: 'session-1',
        title: 'Conversation',
        projectDir: '',
        agentId: 'deepchat',
        sessionKind: 'regular',
        status: 'idle',
        isPinned: false
      }
    ],
    newConversationTargetAgentId: null as string | null,
    startNewConversation: vi.fn(),
    toggleSessionPinned: vi.fn(),
    renameSession: vi.fn(),
    clearSessionMessages: vi.fn(),
    deleteSession: vi.fn(),
    exportSession: vi.fn(),
    selectSession: vi.fn(),
    moveSessionToAgent: vi.fn()
  },
  agent: {
    agents: [] as Array<{ id: string; name: string; type: string; enabled: boolean }>,
    enabledAgents: [] as Array<{ id: string; name: string; type: string; enabled: boolean }>,
    fetchAgents: vi.fn()
  },
  sidepanel: {
    toggleWorkspace: vi.fn(),
    openTapeInspector: vi.fn()
  },
  sidebar: {
    collapsed: false
  },
  uiSettings: {
    traceDebugEnabled: true
  }
}))

const notifyRenderer = vi.hoisted(() => vi.fn())

const digitalEmployeeStoreMock = vi.hoisted(() => ({
  employeeForSession: vi.fn<
    () => { id: string; name: string; executionMode?: 'local' | 'remote' | 'hybrid' } | null
  >(() => null),
  ensureLoaded: vi.fn(),
  switchToRemote: vi.fn(),
  loadRemoteBinding: vi.fn()
}))

vi.mock('@/stores/ui/session', () => ({
  useSessionStore: () => stores.session
}))
vi.mock('@/stores/digitalEmployeeStore', () => ({
  useDigitalEmployeeStore: () => digitalEmployeeStoreMock
}))
vi.mock('@/stores/ui/agent', () => ({
  useAgentStore: () => stores.agent
}))
vi.mock('@/stores/ui/sidepanel', () => ({
  useSidepanelStore: () => stores.sidepanel
}))
vi.mock('@/stores/ui/sidebar', () => ({
  useSidebarStore: () => stores.sidebar
}))
vi.mock('@/stores/uiSettingsStore', () => ({
  useUiSettingsStore: () => stores.uiSettings
}))
vi.mock('@renderer-notifications/rendererNotificationPort', () => ({
  notifyRenderer
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))
vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    name: 'Icon',
    props: {
      icon: {
        type: String,
        required: true
      }
    },
    template: '<span :data-icon="icon" />'
  })
}))
vi.mock('@/components/agent/AgentTransferDialog.vue', () => ({
  default: defineComponent({
    name: 'AgentTransferDialog',
    template: '<div />'
  })
}))

vi.mock('@shadcn/components/ui/dropdown-menu', () => {
  const passthrough = (name: string) => ({
    name,
    template: '<div><slot /></div>'
  })
  return {
    DropdownMenu: passthrough('DropdownMenu'),
    DropdownMenuContent: passthrough('DropdownMenuContent'),
    DropdownMenuItem: passthrough('DropdownMenuItem'),
    DropdownMenuSeparator: passthrough('DropdownMenuSeparator'),
    DropdownMenuTrigger: passthrough('DropdownMenuTrigger')
  }
})
vi.mock('@dc-ui/components/button', () => ({
  DcButton: defineComponent({
    name: 'Button',
    props: {
      disabled: {
        type: Boolean,
        default: false
      },
      variant: {
        type: String,
        default: undefined
      }
    },
    emits: ['click'],
    template:
      '<button type="button" :disabled="disabled" :data-variant="variant" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'
  })
}))
vi.mock('@shadcn/components/ui/dialog', () => {
  const passthrough = (name: string) => ({
    name,
    template: '<div><slot /></div>'
  })
  return {
    Dialog: {
      name: 'Dialog',
      props: {
        open: {
          type: Boolean,
          default: false
        }
      },
      emits: ['update:open'],
      template: '<div v-if="open"><slot /></div>'
    },
    DialogContent: passthrough('DialogContent'),
    DialogDescription: passthrough('DialogDescription'),
    DialogFooter: passthrough('DialogFooter'),
    DialogHeader: passthrough('DialogHeader'),
    DialogTitle: passthrough('DialogTitle')
  }
})
vi.mock('@shadcn/components/ui/alert-dialog', () => {
  const passthrough = (name: string) => ({
    name,
    template: '<div><slot /></div>'
  })
  return {
    AlertDialog: {
      name: 'AlertDialog',
      props: {
        open: {
          type: Boolean,
          default: false
        }
      },
      emits: ['update:open'],
      template: '<div v-if="open"><slot /></div>'
    },
    AlertDialogAction: passthrough('AlertDialogAction'),
    AlertDialogAsyncAction: passthrough('AlertDialogAsyncAction'),
    AlertDialogCancel: passthrough('AlertDialogCancel'),
    AlertDialogContent: passthrough('AlertDialogContent'),
    AlertDialogDescription: passthrough('AlertDialogDescription'),
    AlertDialogFooter: passthrough('AlertDialogFooter'),
    AlertDialogHeader: passthrough('AlertDialogHeader'),
    AlertDialogTitle: passthrough('AlertDialogTitle'),
    AlertDialogTrigger: passthrough('AlertDialogTrigger')
  }
})

const mountTopBar = () =>
  mount(ChatTopBar, {
    props: {
      sessionId: 'session-1',
      title: 'Conversation',
      project: ''
    }
  })

afterEach(() => {
  stores.uiSettings.traceDebugEnabled = true
})

describe('ChatTopBar action buttons', () => {
  it('uses ghost DcButtons for workspace, share, and more actions', () => {
    const wrapper = mountTopBar()

    for (const icon of ['lucide:folder-tree', 'lucide:share', 'lucide:ellipsis']) {
      const button = wrapper
        .findAll('button')
        .find(
          (candidate) =>
            candidate.attributes('icon') === icon ||
            candidate.find(`[data-icon="${icon}"]`).exists()
        )

      expect(button?.attributes('data-variant')).toBe('ghost')
    }
  })

  it('opens the session Inspector only when diagnostics are enabled', async () => {
    stores.uiSettings.traceDebugEnabled = true
    const wrapper = mountTopBar()

    await wrapper.get('[data-testid="open-tape-inspector-button"]').trigger('click')
    expect(stores.sidepanel.openTapeInspector).toHaveBeenCalledWith('session-1')

    stores.uiSettings.traceDebugEnabled = false
    const hiddenWrapper = mountTopBar()
    expect(hiddenWrapper.find('[data-testid="open-tape-inspector-button"]').exists()).toBe(false)
  })
})

describe('ChatTopBar digital employee badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue(null)
  })

  it('hides badge when no employee is bound and ensures the store is loaded on mount', () => {
    const wrapper = mountTopBar()

    expect(wrapper.find('[data-testid="chat-digital-employee-badge"]').exists()).toBe(false)
    expect(digitalEmployeeStoreMock.ensureLoaded).toHaveBeenCalledTimes(1)
  })

  it('shows the bound digital employee name in the badge', () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({ id: 'finance', name: '财务助手' })
    const wrapper = mountTopBar()

    const badge = wrapper.get('[data-testid="chat-digital-employee-badge"]')
    expect(badge.text()).toContain('财务助手')
  })

  it('marks a remote-execution employee as running in the cloud', () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'finance',
      name: '财务助手',
      executionMode: 'remote'
    })
    const wrapper = mountTopBar()

    const modeBadge = wrapper.get('[data-testid="chat-digital-employee-mode-badge"]')
    // 执行位置必须可见：同一个员工可能有本地/远端两份执行路径，只说名字会误导。
    expect(modeBadge.text()).toContain('digitalEmployee.remote.badge')
  })

  it('marks a locally executed employee as running locally', () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'finance',
      name: '财务助手',
      executionMode: 'local'
    })
    const wrapper = mountTopBar()

    const modeBadge = wrapper.get('[data-testid="chat-digital-employee-mode-badge"]')
    expect(modeBadge.text()).toContain('digitalEmployee.local.badge')
  })

  it('falls back to the local badge when executionMode is absent', () => {
    // 老数据/旧绑定没有 executionMode，字段默认值就是 local，不能因此隐藏徽标。
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({ id: 'finance', name: '财务助手' })
    const wrapper = mountTopBar()

    expect(wrapper.get('[data-testid="chat-digital-employee-mode-badge"]').text()).toContain(
      'digitalEmployee.local.badge'
    )
  })

  it('hides the mode badge together with the employee badge', () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue(null)
    const wrapper = mountTopBar()

    expect(wrapper.find('[data-testid="chat-digital-employee-mode-badge"]').exists()).toBe(false)
  })
})

describe('ChatTopBar hybrid switch entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue(null)
    digitalEmployeeStoreMock.switchToRemote.mockResolvedValue({ ok: true })
    digitalEmployeeStoreMock.loadRemoteBinding.mockResolvedValue(false)
  })

  it('offers the switch only for a hybrid employee still running locally', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'hybrid-hr',
      name: '人事助手',
      executionMode: 'hybrid'
    })
    const wrapper = mountTopBar()

    // 绑定状态在主进程，按钮在查询返回前刻意不渲染（乐观显示会让人点了才发现切不了）。
    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(true)
    expect(digitalEmployeeStoreMock.loadRemoteBinding).toHaveBeenCalledWith('session-1')
  })

  it('hides the switch for a plain local employee', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'finance',
      name: '财务助手',
      executionMode: 'local'
    })
    const wrapper = mountTopBar()
    await flushPromises()

    // local 员工没有云端可切，展示按钮等于给一个必失败的入口。
    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(false)
  })

  it('hides the switch once the session is already bound remotely', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'hybrid-hr',
      name: '人事助手',
      executionMode: 'hybrid'
    })
    digitalEmployeeStoreMock.loadRemoteBinding.mockResolvedValue(true)
    const wrapper = mountTopBar()
    await flushPromises()

    // 绑定后主进程会以「已绑定」拒绝，按钮留着只会让人反复点。
    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(false)
  })

  it('hides the switch for a remote-mode employee without asking the registry', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'remote-hr',
      name: '远程助手',
      executionMode: 'remote'
    })
    const wrapper = mountTopBar()
    await flushPromises()

    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(false)
    // 非 hybrid 不必白跑一次 IPC。
    expect(digitalEmployeeStoreMock.loadRemoteBinding).not.toHaveBeenCalled()
  })

  it('hides the switch in a read-only session', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'hybrid-hr',
      name: '人事助手',
      executionMode: 'hybrid'
    })
    const wrapper = mount(ChatTopBar, {
      props: { sessionId: 'session-1', title: 'Conversation', project: '', isReadOnly: true }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="chat-digital-employee-switch-remote"]').exists()).toBe(false)
  })

  it('sends the trimmed summary and closes the dialog on success', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'hybrid-hr',
      name: '人事助手',
      executionMode: 'hybrid'
    })
    const wrapper = mountTopBar()
    const viewModel = wrapper.vm as unknown as {
      switchToRemoteDialogOpen: boolean
      switchToRemoteSummary: string
      handleSwitchToRemoteConfirm(): Promise<void>
    }
    viewModel.switchToRemoteDialogOpen = true
    viewModel.switchToRemoteSummary = '  已确认单号 R-1  '

    await viewModel.handleSwitchToRemoteConfirm()
    await flushPromises()

    expect(digitalEmployeeStoreMock.switchToRemote).toHaveBeenCalledWith({
      sessionId: 'session-1',
      employeeId: 'hybrid-hr',
      contextSummary: '已确认单号 R-1'
    })
    expect(viewModel.switchToRemoteDialogOpen).toBe(false)
    expect(notifyRenderer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
  })

  it('keeps the dialog open with an explanation when the switch fails', async () => {
    digitalEmployeeStoreMock.employeeForSession.mockReturnValue({
      id: 'hybrid-hr',
      name: '人事助手',
      executionMode: 'hybrid'
    })
    digitalEmployeeStoreMock.switchToRemote.mockResolvedValue({
      ok: false,
      error: 'already bound'
    })
    const wrapper = mountTopBar()
    const viewModel = wrapper.vm as unknown as {
      switchToRemoteDialogOpen: boolean
      switchToRemoteError: string | null
      handleSwitchToRemoteConfirm(): Promise<void>
    }
    viewModel.switchToRemoteDialogOpen = true

    await viewModel.handleSwitchToRemoteConfirm()
    await flushPromises()

    // 用户刚点了「切到云端」，没切成必须有原因，不能静默关窗。
    expect(viewModel.switchToRemoteDialogOpen).toBe(true)
    expect(viewModel.switchToRemoteError).toBe('digitalEmployee.hybrid.switchFailed')
    expect(notifyRenderer).not.toHaveBeenCalled()
  })
})

describe('ChatTopBar destructive operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stores.session.clearSessionMessages.mockResolvedValue(undefined)
    stores.session.deleteSession.mockResolvedValue(undefined)
  })

  it('keeps the clear dialog open and shows an inline error when clearing fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stores.session.clearSessionMessages.mockRejectedValueOnce(new Error('database busy'))
    const wrapper = mountTopBar()
    const viewModel = wrapper.vm as unknown as {
      clearDialogOpen: boolean
      handleClearConfirm(): Promise<void>
    }
    viewModel.clearDialogOpen = true

    await viewModel.handleClearConfirm()
    await flushPromises()

    expect(viewModel.clearDialogOpen).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toBe('common.error.requestFailed')
    expect(notifyRenderer).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('closes the clear dialog only after clearing succeeds', async () => {
    const wrapper = mountTopBar()
    const viewModel = wrapper.vm as unknown as {
      clearDialogOpen: boolean
      handleClearConfirm(): Promise<void>
    }
    viewModel.clearDialogOpen = true

    await viewModel.handleClearConfirm()

    expect(stores.session.clearSessionMessages).toHaveBeenCalledWith('session-1')
    expect(viewModel.clearDialogOpen).toBe(false)
  })

  it('keeps the delete dialog open and shows an inline error when deletion fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stores.session.deleteSession.mockRejectedValueOnce(new Error('database busy'))
    const wrapper = mountTopBar()
    const viewModel = wrapper.vm as unknown as {
      deleteDialogOpen: boolean
      handleDeleteConfirm(): Promise<void>
    }
    viewModel.deleteDialogOpen = true

    await viewModel.handleDeleteConfirm()
    await flushPromises()

    expect(viewModel.deleteDialogOpen).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toBe('common.error.requestFailed')
    expect(notifyRenderer).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
