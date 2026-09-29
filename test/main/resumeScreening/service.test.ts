import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const Database = sqliteModule?.default
const DatabaseCtor = Database!

import {
  JD_ANALYST_SYSTEM_PROMPT,
  EXTRACTOR_SYSTEM_PROMPT,
  SCREENING_SYSTEM_PROMPT,
  INTERVIEWER_SYSTEM_PROMPT,
  HR_MANAGER_SYSTEM_PROMPT
} from '@/resumeScreening/prompts'

const tasksModule = Database
  ? await import('@/resumeScreening/data/tables/resumeScreeningTasks')
  : null
const resumesModule = Database
  ? await import('@/resumeScreening/data/tables/resumeScreeningResumes')
  : null
const databaseModule = Database ? await import('@/resumeScreening/data/database') : null
const serviceModule = await import('@/resumeScreening/service')

let sqliteAvailable = false
if (Database) {
  try {
    const probe = new DatabaseCtor(':memory:')
    probe.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const describeIfSqlite =
  sqliteAvailable && tasksModule && resumesModule && databaseModule ? describe : describe.skip

const serviceDir = tmpdir()

function scriptInvoker(
  responses: Record<string, unknown>
): Pick<import('@/resumeScreening/llmInvoker').ResumeLlmInvoker, 'invokeJson'> {
  return {
    invokeJson: vi.fn(async (options: { systemPrompt: string }) => {
      const response = responses[options.systemPrompt]
      if (response === undefined) {
        throw new Error(`未脚本化的角色调用: ${options.systemPrompt.slice(0, 16)}`)
      }
      return JSON.parse(JSON.stringify(response))
    })
  }
}

const FULL_SCRIPT: Record<string, unknown> = {
  [JD_ANALYST_SYSTEM_PROMPT]: {
    responsibilities: ['开发 Web 应用'],
    requirements: ['三年经验'],
    preferred: ['英语流利']
  },
  [EXTRACTOR_SYSTEM_PROMPT]: {
    name: '张三',
    email: 'zhang@example.com',
    skills: ['Vue', 'TypeScript'],
    experience: ['某公司前端工程师 2020-2024']
  },
  [SCREENING_SYSTEM_PROMPT]: {
    score: 88,
    recommended: true,
    conclusion: '高度匹配',
    strengths: ['技术栈吻合']
  },
  [INTERVIEWER_SYSTEM_PROMPT]: {
    highlights: ['项目经验丰富'],
    risks: ['缺少大促经验'],
    questions: ['介绍一次重构经历']
  },
  [HR_MANAGER_SYSTEM_PROMPT]: {
    finalSummary: '建议进入下一轮',
    hrOpinion: '薪资期望待确认'
  }
}

function makeSetup() {
  const db = new DatabaseCtor(':memory:')
  const tasksTable = new tasksModule!.ResumeScreeningTasksTable(db)
  const resumesTable = new resumesModule!.ResumeScreeningResumesTable(db)
  tasksTable.createTable()
  resumesTable.createTable()
  const database = new databaseModule!.ResumeScreeningDatabase({ getDatabase: () => db })
  const publishedTasks: import('@/resumeScreening/service').ResumeScreeningTaskUpdatedPayload[] = []
  const publishedResumes: import('@/resumeScreening/service').ResumeScreeningResumeUpdatedPayload[] =
    []
  const copied: Array<[string, string]> = []
  const deps: import('@/resumeScreening/service').ResumeScreeningServiceDeps = {
    database,
    invoker: scriptInvoker(FULL_SCRIPT),
    textExtractor: {
      extract: vi.fn(async (filePath: string) =>
        filePath.endsWith('jd.txt') ? 'JD 文件内容' : '张三的简历内容'
      )
    },
    storageDir: path.join(serviceDir, 'resume-service-root'),
    copyFile: vi.fn(async (src: string, dest: string) => {
      copied.push([src, dest])
    }),
    getProfile: vi.fn(() => ({ name: '张三', email: 'zhang@example.com' })),
    saveProfile: vi.fn(),
    getDefaultModel: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
    listModels: vi.fn(() => []),
    publishTaskUpdated: vi.fn(
      (payload: import('@/resumeScreening/service').ResumeScreeningTaskUpdatedPayload) => {
        publishedTasks.push(payload)
      }
    ),
    publishResumeUpdated: vi.fn(
      (payload: import('@/resumeScreening/service').ResumeScreeningResumeUpdatedPayload) => {
        publishedResumes.push(payload)
      }
    ),
    now: () => 1000
  }
  const service = new serviceModule.ResumeScreeningService(deps)
  return { db, deps, service, publishedTasks, publishedResumes, copied }
}

function makeTaskInput(
  overrides?: Partial<import('@/resumeScreening/service').CreateResumeScreeningTaskInput>
): import('@/resumeScreening/service').CreateResumeScreeningTaskInput {
  return {
    jdSource: 'text',
    jdText: '前端工程师 JD：负责 Web 应用开发',
    resumes: [
      { path: '/upload/张三.pdf', name: '张三.pdf', mimeType: 'application/pdf', size: 1024 }
    ],
    config: { generateExplanation: true, includeRawText: false, maxConcurrency: 2 },
    ...overrides
  }
}

async function waitForTaskStatus(
  deps: import('@/resumeScreening/service').ResumeScreeningServiceDeps,
  taskId: string,
  status: string
): Promise<import('@/resumeScreening/data/tables/resumeScreeningTasks').ResumeScreeningTaskRow> {
  for (let i = 0; i < 200; i++) {
    const task = deps.database.tasksTable.get(taskId)
    if (task && task.status === status) return task
    // 流水线推进依赖微任务，必须让出事件循环才能观察到状态变化
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待任务 ${taskId} 进入状态 ${status} 超时`)
}

describeIfSqlite('ResumeScreeningService', () => {
  // console.error spy 必须每个用例重建：全局 afterEach restore 会把顶层 spy 还原
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('完整流水线：建任务 → JD 解析 → 四阶段单简历 → completed 终态与事件', async () => {
    const { db, deps, service, publishedTasks, publishedResumes, copied } = makeSetup()
    const created = await service.createTask(makeTaskInput())

    expect(created.provider_id).toBe('openai')
    expect(created.model_id).toBe('gpt-4o')
    expect(created.created_by_name).toBe('张三')
    expect(created.total).toBe(1)

    const task = await waitForTaskStatus(deps, created.id, 'completed')
    const resumes = deps.database.resumesTable.listByTask(created.id)
    expect(resumes).toHaveLength(1)
    const resume = resumes[0]!
    expect(resume.status).toBe('done')
    expect(resume.candidate_name).toBe('张三')
    // includeRawText 仅控制事件/DTO 是否携带原文，数据库始终落库
    expect(resume.raw_text).toBe('张三的简历内容')
    expect(resume.interview_json).not.toBeNull()
    expect(JSON.parse(resume.interview_json!)).toMatchObject({ questions: ['介绍一次重构经历'] })
    expect(resume.hr_json).not.toBeNull()
    expect(JSON.parse(resume.hr_json!)).toMatchObject({ finalSummary: '建议进入下一轮' })
    expect(resume.score).toBe(88)
    expect(resume.recommended).toBe(1)

    // 简历文件已复制进 storageDir/<taskId>/ 且扩展名保留
    expect(copied).toHaveLength(1)
    expect(resume.file_path).toBe(copied[0]![1])
    expect(path.basename(resume.file_path)).toMatch(/\.pdf$/)

    // JD 恰好调用一次
    const jdCalls = vi
      .mocked(deps.invoker.invokeJson)
      .mock.calls.filter(
        (call) => (call[0] as { systemPrompt: string }).systemPrompt === JD_ANALYST_SYSTEM_PROMPT
      )
    expect(jdCalls).toHaveLength(1)

    expect(task).toMatchObject({ succeeded: 1, failed: 0, recommended_count: 1, avg_score: 88 })
    expect(publishedTasks[publishedTasks.length - 1]).toMatchObject({
      taskId: created.id,
      status: 'completed'
    })
    const stages = publishedResumes
      .map((payload) => payload.stage)
      .filter((stage) => stage !== null)
    expect(new Set(stages)).toEqual(new Set(['extracting', 'screening', 'interviewing', 'hr']))
    expect(publishedResumes[publishedResumes.length - 1]).toMatchObject({
      status: 'done',
      stage: null
    })
    db.close()
  })

  it('generateExplanation=false 时跳过面试官与 HR 角色', async () => {
    const { db, deps, service } = makeSetup()
    const input = makeTaskInput({
      config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 }
    })
    const created = await service.createTask(input)
    await waitForTaskStatus(deps, created.id, 'completed')

    const byPrompt = (systemPrompt: string) =>
      vi
        .mocked(deps.invoker.invokeJson)
        .mock.calls.filter(
          (call) => (call[0] as { systemPrompt: string }).systemPrompt === systemPrompt
        )
    expect(byPrompt(INTERVIEWER_SYSTEM_PROMPT)).toHaveLength(0)
    expect(byPrompt(HR_MANAGER_SYSTEM_PROMPT)).toHaveLength(0)

    const resume = deps.database.resumesTable.listByTask(created.id)[0]!
    expect(resume.interview_json).toBeNull()
    expect(resume.hr_json).toBeNull()
    expect(resume.score).toBe(88)
    db.close()
  })

  it('单份简历失败时任务为 partial', async () => {
    const { db, deps, service } = makeSetup()
    const scripted = scriptInvoker(FULL_SCRIPT)
    let screeningCalls = 0
    const wrapper: Pick<import('@/resumeScreening/llmInvoker').ResumeLlmInvoker, 'invokeJson'> = {
      invokeJson: async (options) => {
        if (options.systemPrompt === SCREENING_SYSTEM_PROMPT) {
          screeningCalls += 1
          if (screeningCalls === 1) throw new Error('模型输出异常')
        }
        return scripted.invokeJson(options)
      }
    }
    deps.invoker = wrapper
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/甲.pdf', name: '甲.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/乙.pdf', name: '乙.pdf', mimeType: 'application/pdf', size: 1 }
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 1 }
      })
    )
    const task = await waitForTaskStatus(deps, created.id, 'partial')

    const statuses = deps.database.resumesTable
      .listByTask(created.id)
      .map((resume) => resume.status)
      .sort()
    expect(statuses).toEqual(['done', 'failed'])
    const failed = deps.database.resumesTable
      .listByTask(created.id)
      .find((resume) => resume.status === 'failed')
    expect(failed!.error).toBe('模型输出异常')
    expect(screeningCalls).toBe(2)
    expect(task).toMatchObject({ succeeded: 1, failed: 1 })
    db.close()
  })

  it('全部简历失败时任务为 failed', async () => {
    const { db, deps, service } = makeSetup()
    const scripted = scriptInvoker(FULL_SCRIPT)
    deps.invoker = {
      invokeJson: async (options) => {
        if (options.systemPrompt === SCREENING_SYSTEM_PROMPT) throw new Error('初筛崩溃')
        return scripted.invokeJson(options)
      }
    }
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/甲.pdf', name: '甲.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/乙.pdf', name: '乙.pdf', mimeType: 'application/pdf', size: 1 }
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 }
      })
    )
    const task = await waitForTaskStatus(deps, created.id, 'failed')
    expect(task).toMatchObject({ succeeded: 0, failed: 2 })
    db.close()
  })

  it('并发上限被严格遵守', async () => {
    const { db, deps, service } = makeSetup()
    let active = 0
    let maxActive = 0
    let extractCalls = 0
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const baseExtract = deps.textExtractor.extract
    deps.textExtractor = {
      extract: async (filePath: string) => {
        active += 1
        extractCalls += 1
        maxActive = Math.max(maxActive, active)
        await sleep(20)
        active -= 1
        return baseExtract(filePath)
      }
    }
    const created = await service.createTask(
      makeTaskInput({
        resumes: ['甲', '乙', '丙', '丁'].map((name) => ({
          path: `/upload/${name}.pdf`,
          name: `${name}.pdf`,
          mimeType: 'application/pdf',
          size: 1
        })),
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 2 }
      })
    )
    await waitForTaskStatus(deps, created.id, 'completed')
    expect(maxActive).toBe(2)
    expect(extractCalls).toBe(4)
    db.close()
  })

  it('cancelTask 中止运行中的任务并把未完成简历标记为已取消', async () => {
    const { db, deps, service, publishedTasks } = makeSetup()
    const hangingInvoker = {
      invokeJson: <T>(options: { signal?: AbortSignal }) =>
        new Promise<T>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted')),
            { once: true }
          )
        })
    }
    deps.invoker = hangingInvoker
    const created = await service.createTask(makeTaskInput())
    expect(service.cancelTask(created.id)).toBe(true)

    const task = deps.database.tasksTable.get(created.id)!
    expect(task.status).toBe('cancelled')
    // 未完成简历先标记失败再统计，cancelled 行内 failed 计数必须包含刚被标记的简历
    expect(task.failed).toBe(1)
    expect(task.succeeded).toBe(0)
    const resume = deps.database.resumesTable.listByTask(created.id)[0]!
    expect(resume.status).toBe('failed')
    expect(resume.error).toBe('已取消')
    expect(service.cancelTask(created.id)).toBe(false)
    expect(publishedTasks[publishedTasks.length - 1]).toMatchObject({ status: 'cancelled' })
    db.close()
  })

  it('storageDir 为已存在文件时 createTask 失败且任务落库为 failed', async () => {
    const { db, deps, service, publishedTasks } = makeSetup()
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'resume-mkdir-fail-'))
    const blockerFile = path.join(tempRoot, 'storage-blocker')
    await writeFile(blockerFile, '占位文件，阻止在其下创建任务目录', 'utf-8')
    deps.storageDir = blockerFile
    try {
      await expect(service.createTask(makeTaskInput())).rejects.toThrow('简历筛选目录创建失败')
      // 任务行已插入，失败后必须落库为 failed，不能永久卡在 queued
      expect(deps.database.tasksTable.listRecent(10)[0]?.status).toBe('failed')
      expect(publishedTasks[publishedTasks.length - 1]).toMatchObject({ status: 'failed' })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
    db.close()
  })

  it('JD 文件模式读取文件内容，空 JD 拒绝建任务', async () => {
    const { db, deps, service } = makeSetup()
    const created = await service.createTask(
      makeTaskInput({ jdSource: 'file', jdFilePath: '/fake/jd.txt', jdFileName: undefined })
    )
    expect(created.jd_text).toBe('JD 文件内容')
    expect(created.jd_file_name).toBe('jd.txt')
    // JD 文件 1 次 + 简历 1 次
    expect(deps.textExtractor.extract).toHaveBeenCalledTimes(2)
    await waitForTaskStatus(deps, created.id, 'completed')

    await expect(service.createTask(makeTaskInput({ jdText: '   ' }))).rejects.toThrow(
      '请填写岗位 JD'
    )
    db.close()
  })

  it('简历文件复制失败时该简历直接 failed 且不进入流水线', async () => {
    const { db, deps, service } = makeSetup()
    deps.copyFile = vi.fn(async (src: string) => {
      if (src.includes('坏')) throw new Error('磁盘已满')
    })
    const created = await service.createTask(
      makeTaskInput({
        resumes: [
          { path: '/upload/张三.pdf', name: '张三.pdf', mimeType: 'application/pdf', size: 1 },
          { path: '/upload/坏简历.pdf', name: '坏简历.pdf', mimeType: 'application/pdf', size: 1 }
        ],
        config: { generateExplanation: false, includeRawText: false, maxConcurrency: 1 }
      })
    )
    await waitForTaskStatus(deps, created.id, 'partial')

    const resumes = deps.database.resumesTable.listByTask(created.id)
    const bad = resumes.find((resume) => resume.file_name === '坏简历.pdf')!
    expect(bad.status).toBe('failed')
    expect(bad.error).toContain('简历文件复制失败')
    expect(bad.error).toContain('磁盘已满')
    const good = resumes.find((resume) => resume.file_name === '张三.pdf')!
    expect(good.status).toBe('done')
    expect(deps.database.tasksTable.get(created.id)).toMatchObject({ succeeded: 1, failed: 1 })
    db.close()
  })

  it('recoverInterruptedTasks 把启动时仍为 running/queued 的任务标记为失败', () => {
    const { db, deps, service } = makeSetup()
    const first = deps.database.tasksTable.insert({
      jdSource: 'text',
      jdText: 'JD 甲',
      configJson: JSON.stringify({
        generateExplanation: true,
        includeRawText: false,
        maxConcurrency: 2
      }),
      providerId: 'openai',
      modelId: 'gpt-4o',
      total: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com'
    })
    const second = deps.database.tasksTable.insert({
      jdSource: 'text',
      jdText: 'JD 乙',
      configJson: JSON.stringify({
        generateExplanation: true,
        includeRawText: false,
        maxConcurrency: 2
      }),
      providerId: 'openai',
      modelId: 'gpt-4o',
      total: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com'
    })
    deps.database.tasksTable.update(second.id, { status: 'running', startedAt: 1000 })
    deps.database.resumesTable.insert({
      id: 'r-1',
      taskId: first.id,
      fileName: '甲.pdf',
      filePath: '/x/甲.pdf',
      size: 0
    })
    deps.database.resumesTable.insert({
      id: 'r-2',
      taskId: second.id,
      fileName: '乙.pdf',
      filePath: '/x/乙.pdf',
      size: 0
    })

    service.recoverInterruptedTasks()

    for (const taskId of [first.id, second.id]) {
      expect(deps.database.tasksTable.get(taskId)!.status).toBe('failed')
    }
    const resumes = deps.database.resumesTable
    expect(resumes.get('r-1')!.status).toBe('failed')
    expect(resumes.get('r-1')!.error).toBe('应用重启导致任务中断')
    expect(resumes.get('r-2')!.status).toBe('failed')
    expect(resumes.get('r-2')!.error).toBe('应用重启导致任务中断')
    db.close()
  })

  it('getProfile 归一化空档案，updateProfile 合并保存', () => {
    const { db, deps, service } = makeSetup()
    deps.getProfile = vi.fn(() => undefined)
    expect(service.getProfile()).toEqual({ name: '', email: '' })
    const next = service.updateProfile({ name: '李四' })
    expect(next).toEqual({ name: '李四', email: '' })
    expect(deps.saveProfile).toHaveBeenCalledWith({ name: '李四', email: '' })
    db.close()
  })

  it('listModels 透传模型目录', () => {
    const { db, deps, service } = makeSetup()
    deps.listModels = vi.fn(() => [
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        isDefault: true
      }
    ])
    expect(service.listModels()).toEqual([
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        isDefault: true
      }
    ])
    db.close()
  })

  it('未选择模型且应用无默认模型时拒绝建任务', async () => {
    const { db, deps, service } = makeSetup()
    deps.getDefaultModel = vi.fn(() => undefined)
    await expect(
      service.createTask(makeTaskInput({ providerId: undefined, modelId: undefined }))
    ).rejects.toThrow('未选择模型且应用未设置默认模型')
    db.close()
  })
})
