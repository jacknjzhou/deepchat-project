import type { KnowledgeServicePort } from '@shared/types/knowledge'
import type { KnowledgeSettings } from './settings'
import {
  configGetKnowledgeConfigsRoute,
  configSetKnowledgeConfigsRoute,
  knowledgeAddFileRoute,
  knowledgeDeleteFileRoute,
  knowledgeGetSeparatorsForLanguageRoute,
  knowledgeGetSupportedFileExtensionsRoute,
  knowledgeGetSupportedLanguagesRoute,
  knowledgeIsSupportedRoute,
  knowledgeListFilesRoute,
  knowledgePauseAllRunningTasksRoute,
  knowledgeReAddFileRoute,
  knowledgeResumeAllPausedTasksRoute,
  knowledgeSimilarityQueryRoute,
  knowledgeValidateFileRoute,
  type SettingsActivityInput
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'

/**
 * 知识库模块的 IPC 路由注册：把渲染端的调用映射到 KnowledgeService 与
 * KnowledgeSettings。每个路由先用共享契约里的 zod schema 校验入参再
 * 调用，出参同样过 schema——错误在边界处暴露，不让非法数据进入主进程。
 *
 * 配置读写路由走 settings（持久化 + applyConfigChange 驱动服务同步）；
 * 文件与检索路由直接转发 service。recordActivity 把配置变更写入控制
 * 中心的操作记录。
 */
export function createKnowledgeRoutes(deps: {
  service: KnowledgeServicePort
  settings: KnowledgeSettings
  /** 配置落盘后驱动 KnowledgeService 按差异增删改实例。 */
  applyConfigChange(): Promise<void>
  /** 向控制中心记录一次设置变更，仅供展示。 */
  recordActivity(input: SettingsActivityInput): void
}): DeepchatRouteMap {
  const { service } = deps
  return createRouteMap([
    // 读取当前知识库配置列表（设置页回显用），直接从 settings 取。
    [
      configGetKnowledgeConfigsRoute.name,
      async (rawInput) => {
        configGetKnowledgeConfigsRoute.input.parse(rawInput)
        return configGetKnowledgeConfigsRoute.output.parse({
          configs: deps.settings.getKnowledgeConfigs()
        })
      }
    ],
    // 整体覆写知识库配置：先落盘，再由 applyConfigChange 把差异同步到
    // 运行中的服务实例，最后记入控制中心操作记录。
    [
      configSetKnowledgeConfigsRoute.name,
      async (rawInput) => {
        const input = configSetKnowledgeConfigsRoute.input.parse(rawInput)
        deps.settings.setKnowledgeConfigs(input.configs)
        await deps.applyConfigChange()
        deps.recordActivity({
          category: 'knowledge',
          action: 'updated',
          targetType: 'knowledge-configs',
          targetLabel: 'Knowledge sources',
          routeName: 'settings-knowledge-base',
          summaryKey: 'settings.controlCenter.activity.settingUpdated',
          summaryParams: { key: `knowledge sources (${input.configs.length})` }
        })
        return configSetKnowledgeConfigsRoute.output.parse({
          configs: deps.settings.getKnowledgeConfigs()
        })
      }
    ],
    // 环境能力探测：当前平台/架构是否支持内置知识库（决定 UI 是否展示入口）。
    [
      knowledgeIsSupportedRoute.name,
      async (rawInput) => {
        knowledgeIsSupportedRoute.input.parse(rawInput)
        return knowledgeIsSupportedRoute.output.parse({ supported: await service.isSupported() })
      }
    ],
    // 文本分块能力元信息：支持的语言列表与各语言的分隔符，
    // 供前端在知识库设置里做分块参数选择。
    [
      knowledgeGetSupportedLanguagesRoute.name,
      async (rawInput) => {
        knowledgeGetSupportedLanguagesRoute.input.parse(rawInput)
        return knowledgeGetSupportedLanguagesRoute.output.parse({
          languages: await service.getSupportedLanguages()
        })
      }
    ],
    [
      knowledgeGetSeparatorsForLanguageRoute.name,
      async (rawInput) => {
        const input = knowledgeGetSeparatorsForLanguageRoute.input.parse(rawInput)
        return knowledgeGetSeparatorsForLanguageRoute.output.parse({
          separators: await service.getSeparatorsForLanguage(input.language)
        })
      }
    ],
    [
      knowledgeGetSupportedFileExtensionsRoute.name,
      async (rawInput) => {
        knowledgeGetSupportedFileExtensionsRoute.input.parse(rawInput)
        return knowledgeGetSupportedFileExtensionsRoute.output.parse({
          extensions: await service.getSupportedFileExtensions()
        })
      }
    ],
    // 文件管理路由：列表、入库前校验、添加/删除/重灌。
    [
      knowledgeListFilesRoute.name,
      async (rawInput) => {
        const input = knowledgeListFilesRoute.input.parse(rawInput)
        return knowledgeListFilesRoute.output.parse({
          files: await service.listFiles(input.knowledgeBaseId)
        })
      }
    ],
    // 检索与任务控制路由：相似度查询、暂停/恢复库内全部处理任务。
    [
      knowledgeSimilarityQueryRoute.name,
      async (rawInput) => {
        const input = knowledgeSimilarityQueryRoute.input.parse(rawInput)
        return knowledgeSimilarityQueryRoute.output.parse({
          results: await service.similarityQuery(input.knowledgeBaseId, input.query)
        })
      }
    ],
    [
      knowledgeValidateFileRoute.name,
      async (rawInput) => {
        const input = knowledgeValidateFileRoute.input.parse(rawInput)
        return knowledgeValidateFileRoute.output.parse({
          result: await service.validateFile(input.filePath)
        })
      }
    ],
    [
      knowledgeAddFileRoute.name,
      async (rawInput) => {
        const input = knowledgeAddFileRoute.input.parse(rawInput)
        return knowledgeAddFileRoute.output.parse({
          result: await service.addFile(input.knowledgeBaseId, input.filePath)
        })
      }
    ],
    [
      knowledgeDeleteFileRoute.name,
      async (rawInput) => {
        const input = knowledgeDeleteFileRoute.input.parse(rawInput)
        await service.deleteFile(input.knowledgeBaseId, input.fileId)
        return knowledgeDeleteFileRoute.output.parse({ deleted: true })
      }
    ],
    [
      knowledgeReAddFileRoute.name,
      async (rawInput) => {
        const input = knowledgeReAddFileRoute.input.parse(rawInput)
        return knowledgeReAddFileRoute.output.parse({
          result: await service.reAddFile(input.knowledgeBaseId, input.fileId)
        })
      }
    ],
    [
      knowledgePauseAllRunningTasksRoute.name,
      async (rawInput) => {
        const input = knowledgePauseAllRunningTasksRoute.input.parse(rawInput)
        await service.pauseAllRunningTasks(input.knowledgeBaseId)
        return knowledgePauseAllRunningTasksRoute.output.parse({ paused: true })
      }
    ],
    [
      knowledgeResumeAllPausedTasksRoute.name,
      async (rawInput) => {
        const input = knowledgeResumeAllPausedTasksRoute.input.parse(rawInput)
        await service.resumeAllPausedTasks(input.knowledgeBaseId)
        return knowledgeResumeAllPausedTasksRoute.output.parse({ resumed: true })
      }
    ]
  ])
}
