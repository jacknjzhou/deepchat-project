import { randomUUID } from 'node:crypto'
import type { DocumentFieldEntry } from '@shared/documents'
import type { DocumentExtractFileInput, DocumentExtractRoute } from './extractor/documentExtractor'
import type { DocumentRepositoryTaskPort, DocumentTask } from './repository'

export interface RecognitionTaskSubmitInput {
  files: DocumentExtractFileInput[]
  templateId: string
  source: 'chat' | 'manual'
}

export interface RecognitionExtractResult {
  template: { id: string; typeKey: string }
  route: DocumentExtractRoute
  fields: Record<string, DocumentFieldEntry>
  rawOutput: string
  durationMs: number
  issues: string[]
}

export interface RecognitionExtractorPort {
  extract: (input: {
    templateId: string
    file: DocumentExtractFileInput
  }) => Promise<RecognitionExtractResult>
}

export interface TaskPublishedPayload {
  task: DocumentTask
  doneCount: number
  totalCount: number
}

export interface RecognitionTaskManagerDeps {
  repository: DocumentRepositoryTaskPort
  extractor: RecognitionExtractorPort
  publishTaskUpdated: (payload: TaskPublishedPayload) => void
  concurrency?: number
  now?: () => number
}

const DEFAULT_CONCURRENCY = 4

export class RecognitionTaskManager {
  private readonly concurrency: number
  private readonly queue: DocumentTask[] = []
  private running = 0

  constructor(private readonly deps: RecognitionTaskManagerDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY)
  }

  submit(input: RecognitionTaskSubmitInput): DocumentTask[] {
    const batchId = randomUUID()
    const tasks = this.deps.repository.insertTasks(
      input.files.map((file) => ({
        batchId,
        filePath: file.path,
        fileName: file.name ?? file.path.split(/[\\/]/).pop() ?? file.path,
        templateId: input.templateId,
        source: input.source
      }))
    )
    this.queue.push(...tasks)
    this.pump()
    return tasks
  }

  async resumePending(): Promise<void> {
    this.deps.repository.markRunningTasksFailed('interrupted by app restart')
    this.queue.push(...this.deps.repository.listPendingTasks())
    this.pump()
  }

  // Re-run a failed task in place: reset the same row and re-queue it instead
  // of inserting a fresh one, so the strip keeps a single entry per file.
  // An optional template override lets the user pick a different category
  // (e.g. instead of re-running the 'auto' classifier that already failed).
  retryTask(taskId: string, options?: { templateId?: string }): DocumentTask | null {
    const task = this.deps.repository.getTask(taskId)
    if (!task || task.status !== 'failed') {
      return null
    }
    const reset = this.deps.repository.updateTask(taskId, {
      status: 'pending',
      templateId: options?.templateId,
      typeKey: null,
      documentId: null,
      error: null
    })
    if (!reset) {
      return null
    }
    this.publish(reset)
    this.queue.push(reset)
    this.pump()
    return reset
  }

  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) {
        return
      }
      this.running += 1
      void this.runTask(task).finally(() => {
        this.running -= 1
        this.pump()
      })
    }
  }

  private async runTask(started: DocumentTask): Promise<void> {
    const runningTask =
      this.deps.repository.updateTask(started.id, { status: 'running' }) ?? started
    this.publish(runningTask)
    try {
      const result = await this.deps.extractor.extract({
        templateId: runningTask.templateId,
        file: { path: runningTask.filePath, name: runningTask.fileName }
      })
      const document = this.deps.repository.insertDocument({
        templateId: result.template.id,
        typeKey: result.template.typeKey,
        templateSnapshot: result.template,
        fields: result.fields,
        fileUris: [runningTask.filePath],
        source: runningTask.source,
        sessionId: null,
        status: 'draft',
        now: this.deps.now?.()
      })
      this.publish(
        this.deps.repository.updateTask(runningTask.id, {
          status: 'done',
          typeKey: result.template.typeKey,
          documentId: document.id
        }) ?? runningTask
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish(
        this.deps.repository.updateTask(runningTask.id, { status: 'failed', error: message }) ??
          runningTask
      )
    }
  }

  private publish(task: DocumentTask): void {
    const counts = this.deps.repository.countTaskBatch(task.batchId)
    this.deps.publishTaskUpdated({ task, doneCount: counts.done, totalCount: counts.total })
  }
}
