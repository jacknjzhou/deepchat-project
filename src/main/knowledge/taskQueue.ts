import logger from '@shared/logger'
import type { KnowledgeTaskQueueStatus } from '@shared/types/knowledge'
import type { KnowledgeTask, KnowledgeTaskQueuePort } from './ports'

/**
 * 知识库背景任务的并发调度器（KnowledgeTaskQueuePort 实现）。
 *
 * 承载分块嵌入等耗时任务：按 maxConcurrency 并发消费 FIFO 队列，每个
 * 任务持有独立的 AbortController，支持按知识库/文件维度取消（删除库
 * 或文件时不再继续无谓的嵌入计算）。生命周期回调（成功/失败/终止）由
 * KnowledgeBase 注入，用于驱动文件进度收敛。
 */
export class KnowledgeTaskQueue implements KnowledgeTaskQueuePort {
  private queue: KnowledgeTask[] = []
  private controllers: Map<string, AbortController> = new Map()
  private runningTasks: Map<string, KnowledgeTask> = new Map()
  private maxConcurrency: number

  /**
   * @param maxConcurrency 最大并发数。嵌入调用走网络，默认 16 在吞吐与
   *   对嵌入服务的压力之间取平衡；过大会触发限流，过小拖慢入库。
   */
  constructor(maxConcurrency = 16) {
    this.maxConcurrency = maxConcurrency
  }

  /**
   * 入队一个任务并立即尝试调度。此时就建好 AbortController：取消不必
   * 等任务开跑，排队中的任务同样可以被中止。
   */
  addTask(task: KnowledgeTask): void {
    logger.info(`[RAG TASK] Adding task: ${task.id}`)
    this.queue.push(task)
    this.controllers.set(task.id, new AbortController())
    this.processQueue()
  }

  /**
   * 按谓词移除任务：排队中的直接剔除；运行中的通过 abort 信号请求
   * 终止——任务体在下一个检查点抛 AbortError，生命周期走 onTerminate。
   */
  removeTasks(filter: (task: KnowledgeTask) => boolean): void {
    // Remove tasks from the queue
    this.queue = this.queue.filter((task) => {
      if (filter(task)) {
        logger.info(`[RAG TASK] Removing queued task: ${task.id}`)
        this.terminateTask(task.id)
        return false
      }
      return true
    })

    // Terminate the currently running task if it matches
    for (const [taskId, task] of this.runningTasks) {
      if (filter(task)) {
        logger.info(`[RAG TASK] Terminating running task: ${taskId}`)
        this.terminateTask(taskId)
      }
    }
  }

  // Convenience method: cancel tasks by knowledge base ID (implemented via filter)
  cancelTasksByKnowledgeBase(knowledgeBaseId: string): void {
    this.removeTasks((task) => task.payload.knowledgeBaseId === knowledgeBaseId)
  }

  // Convenience method: cancel tasks by file ID (implemented via filter)
  cancelTasksByFile(fileId: string): void {
    this.removeTasks((task) => task.payload.fileId === fileId)
  }

  // Get task execution status (implemented by traversal, no need to maintain index)
  getTaskStatus(): {
    pending: number
    processing: number
    byKnowledgeBase: Map<string, { pending: number; processing: number }>
  } {
    const status = {
      pending: this.queue.length,
      processing: this.runningTasks.size,
      byKnowledgeBase: new Map<string, { pending: number; processing: number }>()
    }

    // Count tasks in the queue (grouped by knowledge base)
    for (const task of this.queue) {
      const kbId = task.payload.knowledgeBaseId
      if (!status.byKnowledgeBase.has(kbId)) {
        status.byKnowledgeBase.set(kbId, { pending: 0, processing: 0 })
      }
      status.byKnowledgeBase.get(kbId)!.pending++
    }

    // Count the currently processing task
    for (const task of this.runningTasks.values()) {
      const kbId = task.payload.knowledgeBaseId
      if (!status.byKnowledgeBase.has(kbId)) {
        status.byKnowledgeBase.set(kbId, { pending: 0, processing: 0 })
      }
      status.byKnowledgeBase.get(kbId)!.processing++
    }

    return status
  }

  // Check if there are any active tasks
  hasActiveTasks(): boolean {
    return this.queue.length > 0 || this.runningTasks.size > 0
  }

  // Check if there are active tasks for the specified knowledge base
  hasActiveTasksForKnowledgeBase(knowledgeBaseId: string): boolean {
    return (
      this.queue.some((t) => t.payload.knowledgeBaseId === knowledgeBaseId) ||
      Array.from(this.runningTasks.values()).some(
        (t) => t.payload.knowledgeBaseId === knowledgeBaseId
      )
    )
  }

  // Check if there are active tasks for the specified file
  hasActiveTasksForFile(fileId: string): boolean {
    return (
      this.queue.some((t) => t.payload.fileId === fileId) ||
      Array.from(this.runningTasks.values()).some((t) => t.payload.fileId === fileId)
    )
  }

  getStatus(): KnowledgeTaskQueueStatus {
    return {
      totalTasks: this.queue.length + this.runningTasks.size,
      runningTasks: this.runningTasks.size,
      queuedTasks: this.queue.length
    }
  }

  /**
   * 销毁队列：终止一切任务（含运行中）并清空全部记账。用于应用退出
   * 或服务销毁；只负责中止，不等待任务体收尾。
   */
  destroy(): void {
    logger.info('[RAG TASK] Destroying TaskManager, all tasks will be terminated.')
    // Remove all tasks (including current task)
    this.removeTasks(() => true)
    // Clear queue and reset state
    this.queue = []
    // Clear all controllers
    this.controllers.forEach((c) => c.abort())
    this.controllers.clear()
    // Clear all running tasks
    this.runningTasks.clear()
  }

  private terminateTask(taskId: string): void {
    // 中止信号只对已开跑的任务有意义；controller 删除后，排队任务
    // 出队时已无处可寻，等同直接丢弃。
    const controller = this.controllers.get(taskId)
    if (controller) {
      controller.abort()
      this.controllers.delete(taskId)
    }
    this.runningTasks.delete(taskId)
  }

  /**
   * 调度循环：只要队列有货且未满并发就持续出队开跑。
   * 任务体异步执行不阻塞循环——单个任务的完成回调里会再次触发调度，
   * 空位随完成逐个释放。
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.runningTasks.size < this.maxConcurrency) {
      const task = this.queue.shift()!
      const controller = this.controllers.get(task.id)!
      this.runningTasks.set(task.id, task)
      ;(async () => {
        try {
          await task.run({ signal: controller.signal })
          // 跑完不等于成功：信号可能在执行期间被 abort（如库被删除），
          // 此时结果已无意义，按「终止」而非「成功」回调。
          if (controller.signal.aborted) {
            task.onTerminate?.()
          } else {
            task.onSuccess?.()
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            logger.info(`[RAG TASK] Task ${task.id} aborted during execution.`)
            task.onTerminate?.()
          } else {
            console.error(`[RAG TASK] Task ${task.id} failed with error:`, error)
            task.onError?.(error as Error)
          }
        } finally {
          // 无论成败都释放并发槽位并继续调度，保证队列永不因单个任务
          // 卡死。
          this.controllers.delete(task.id)
          this.runningTasks.delete(task.id)
          logger.info(`[RAG TASK] Task ${task.id} finished.`)
          this.processQueue()
        }
      })()
    }
  }
}
