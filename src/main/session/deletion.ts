import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type {
  SessionDeletionPermissionPort,
  SessionDeletionOrchestrationPort,
  SessionDeletionRuntimePort,
  SessionDeletionSkillPort,
  SessionDeletionStatePort,
  SessionDeletionStorePort,
  SessionLifecycleDeletionPort
} from './contracts'
import type { SessionDeletionGatePort } from './deletionGate'

export interface SessionDeletionDependencies {
  sessions: SessionDeletionStorePort
  gate: SessionDeletionGatePort
  orchestration: SessionDeletionOrchestrationPort
  runtime: SessionDeletionRuntimePort
  state: SessionDeletionStatePort
  permissions: SessionDeletionPermissionPort
  skills: SessionDeletionSkillPort
}

/**
 * 会话删除模块（SessionDeletion）：把「删一个会话」落实为一连串分阶段清理，
 * 并保证 regular 会话连带其整棵子代理树一起删除。
 *
 * 删除设计为尽力而为（best-effort）：每个清理阶段失败只记录到 stageErrors
 * 继续走完后续阶段，绝不因某个外设清理失败而留下「记录在、运行时半死」
 * 的僵尸会话。顺序有讲究：先停运行时后端/浏览器（停止产生新数据），再清
 * 编排与子树，最后才删存储记录——记录一删，其它系统就再也找不到这个会话了。
 */
export class SessionDeletion implements SessionLifecycleDeletionPort {
  constructor(private readonly dependencies: SessionDeletionDependencies) {}

  /** 删除入口：先进删除门（与同会话其它操作互斥），返回级联删除的全部 id。 */
  async deleteSessionTree(sessionId: string): Promise<string[]> {
    return await this.dependencies.gate.runWithSessionDeletion(
      sessionId,
      async () => await this.deleteSessionTreeUnderGate(sessionId)
    )
  }

  private async deleteSessionTreeUnderGate(sessionId: string): Promise<string[]> {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) return []

    const stageErrors: Array<{ stage: string; error: unknown }> = []
    // Stop the parent producer before taking the orchestration and child snapshots. Runtime cleanup
    // requests cancellation; the deletion gate supplies the stronger guarantee that no new child
    // creation operation can enter while the asynchronous stack unwinds.
    try {
      await this.dependencies.runtime.cleanupSessionBackends(toAppSessionId(sessionId))
    } catch (error) {
      stageErrors.push({ stage: 'backend', error })
      console.warn(`[SessionDeletion] backend cleanup failed for ${sessionId}:`, error)
    }
    try {
      await this.dependencies.runtime.destroySessionBrowser(toAppSessionId(sessionId))
    } catch (error) {
      stageErrors.push({ stage: 'browser', error })
      console.warn(`[SessionDeletion] browser cleanup failed for ${sessionId}:`, error)
    }
    try {
      await this.dependencies.orchestration.prepareSessionDeletion(sessionId)
    } catch (error) {
      stageErrors.push({ stage: 'orchestration', error })
      console.warn(`[SessionDeletion] orchestration cleanup failed for ${sessionId}:`, error)
    }

    // regular 会话先递归删全部子代理，再删自己；子树删除各自走删除门。
    const deletedSessionIds: string[] = []
    if (session.sessionKind === 'regular') {
      const children = this.dependencies.sessions.list({
        includeSubagents: true,
        parentSessionId: sessionId
      })
      for (const child of children) {
        deletedSessionIds.push(...(await this.deleteSessionTree(child.id)))
      }
    }

    // Best-effort staged cleanup: never leave a zombie session row when later stages still work.
    try {
      await this.dependencies.state.destroySession(sessionId)
    } catch (error) {
      stageErrors.push({ stage: 'state', error })
      console.warn(`[SessionDeletion] state destroy failed for ${sessionId}:`, error)
    }

    try {
      this.dependencies.permissions.clearSessionPermissions(sessionId)
    } catch (error) {
      stageErrors.push({ stage: 'permissions', error })
    }
    try {
      await this.dependencies.skills.clearNewAgentSessionSkills(sessionId)
    } catch (error) {
      stageErrors.push({ stage: 'skills', error })
    }

    this.dependencies.sessions.delete(sessionId)
    try {
      this.dependencies.skills.completeNewAgentSessionSkillsDeletion(sessionId)
    } catch (error) {
      stageErrors.push({ stage: 'skills-completion', error })
    }
    deletedSessionIds.push(sessionId)

    if (stageErrors.length > 0) {
      console.warn(
        `[SessionDeletion] completed delete for ${sessionId} with partial failures:`,
        stageErrors.map((entry) => entry.stage).join(', ')
      )
    }
    return deletedSessionIds
  }
}
