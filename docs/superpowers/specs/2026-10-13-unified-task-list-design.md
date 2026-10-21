# 统一文档任务列表页 设计（Unified Task List）

**状态**：已实施
**日期**：2026-10-13
**分支**：`20261009classifier-docs-content`

## 1. 背景与目标

文档识别任务目前分散在三处：手工上传与自动扫描产生 `document_tasks` 真任务（归档页任务条只显示未完成任务），对话（chat）文件解析直接生成 document（无任务记录）。用户需要在一个页面查看全部三类任务的列表信息、跟踪自动扫描批次历史、并分页浏览。

**目标**：在归档页（`/documents`）新增「任务」视图，统一混排展示 manual / scheduled / chat 三来源任务条目，支持来源/状态过滤、扫描批次下钻、分页浏览与失败重试/清除/跳详情。

**用户决策记录**：
- 页面位置：归档页内新增 Tab（与「文档 / 报销」视图切换并列）
- chat 呈现：documents 伪任务条目（不补建真任务）
- 扫描历史：按 `batch_id` 聚合（不新增扫描历史表；去重拦截文件不进批次历史）
- 展示形态：三来源统一混排表 + 来源 badge + 过滤
- 操作：重试 + 清除失败 + 跳文档详情

## 2. 数据现状（调研结论）

| 来源 | 数据位置 | 缺口 |
|---|---|---|
| manual | `document_tasks`（source='manual'）完整任务生命周期 | IPC `documents.tasks.list` 无分页/过滤；出参 schema 剔除了 source |
| scheduled | `document_tasks`（source='scheduled'）+ `documents_watched_files` | 无批次历史表（仅 settings 单例 `{lastRunAt, lastError}`）；去重拦截文件不入任何表 |
| chat | 仅 `documents`（source='chat'，session_id 有值） | 无任务记录、无过程态；file_uris 为 JSON 数组 |

既有可复用资产：归档页 tab+chip+分页+任务条范式（`ARCHIVE_PAGE_SIZE=50`、乱序守卫 `loadArchiveDocuments`）、`documents.task.updated` 事件实时刷新管线（300ms debounce）、`documents.tasks.retry`/`clearFailed` 通道、`idx_document_tasks_created_at` 索引。

## 3. 方案（后端：分页窗口归并）

统一列表采用**「两查询 + 分页窗口内归并」**而非单条 UNION SQL：`document_tasks`（真任务）与 `documents`（chat 伪任务投影）各按过滤条件取 `offset+limit` 条，内存归并按 `created_at DESC, id` 排序取 limit 条；total 为两查询 count 之和。数量级下无性能问题，避免跨表 UNION 的投影对齐复杂度。

## 4. 数据层

### 4.1 `document_tasks` 查询改造（`src/main/documents/data/tables/documentTasks.ts`）

- `listRecent` 保留；新增 `listFiltered(filter: { status?, source?, batchId?, limit, offset })`：WHERE 按 status/source/batchId 可选拼接，`ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`。
- 新增 `countFiltered(filter)`（同 WHERE，返回 total）。
- 新增 `listScanBatches({ limit, offset })`：`WHERE source='scheduled' GROUP BY batch_id`，投影 `{ batchId, startedAt: MIN(created_at), total: COUNT(*), done: SUM(status='done'), failed: SUM(status='failed') }`，`ORDER BY startedAt DESC LIMIT ? OFFSET ?`；配套 `countScanBatches()`（GROUP BY 去重计数）。
- 迁移：补索引 `idx_document_tasks_source(source, created_at DESC)`（复用 ensureMigrated 幂等 `CREATE INDEX IF NOT EXISTS` 重建范式，不 bump 版本号）。

### 4.2 documents 表 chat 伪任务投影（`src/main/documents/data/tables/documents.ts`）

- 新增 `listChatAsTasks({ limit, offset })`：`WHERE source='chat' ORDER BY created_at DESC, id DESC`，投影统一形状（SQL 层取 `json_extract(file_uris, '$[0]')` 为 rawPath，fileName 的 basename 提取与空值回退在 JS 映射层完成，避免 SQLite 无 basename 函数的问题）：

```
{ id: documents.id,           // 与 document id 同值（操作双保险的依据）
  fileName: basename(json_extract(file_uris, '$[0]')),  // 空数组回退 '(未知文件)'
  source: 'chat', status: 'done', typeKey: documents.type_key,
  documentId: documents.id, createdAt: documents.created_at }
```

- 新增 `countChatAsTasks()`。
- 迁移：补索引 `idx_documents_source(source, created_at DESC)`。

### 4.3 统一条目形状（shared）

```
UnifiedTaskEntry = {
  id: string; fileName: string;
  source: 'manual' | 'scheduled' | 'chat';
  status: 'pending' | 'running' | 'done' | 'failed';
  typeKey: string | null; documentId: string | null;
  error: string | null; createdAt: number;
  batchId?: string;   // 仅 scheduled
  templateId?: string; // 仅真任务（重试换模板用）
}
```

## 5. IPC 契约（`src/shared/contracts/routes/documents.routes.ts` + `src/main/documents/routes.ts`）

- `documentTaskSchema` 补 `source` 字段（`DOCUMENT_SOURCES` 枚举）——`documents.task.updated` 事件 payload 随之携带 source。
- `documents.tasks.list` 入参扩展：`{ status?, source?, batchId?, limit(1..200, default 50), offset(default 0) }`；返回 `{ tasks: UnifiedTaskEntry[], total }`。
  - `source='chat'` → `listChatAsTasks`；`source` 省略 → 混排归并；`batchId` 隐含 `source='scheduled'`。
- 新增通道 `documents.tasks.scanBatches`：`{ limit(1..200), offset }` → `{ batches, total }`（批次视图数据源）。
- `documents.tasks.retry` / `clearFailed` 零改动复用。

## 6. 前端（归档页新增「任务」视图）

- **viewMode**：「文档 / 任务 / 报销」三段切换（`DocumentsArchivePage.vue`）。
- **过滤行**：来源 chip（全部/手工/扫描/对话）+ 状态过滤（复用现有状态 chip）+ 扫描批次下拉（仅来源=扫描时显示；「全部批次」默认；懒加载——切到扫描来源才请求 scanBatches）。
- **统一表格**：文件名 / 来源 badge / 类型（typeKey）/ 状态（图标+色，复用任务条映射）/ 创建时间；done 且有 documentId 的行文件名可点击，通过 `openDetail` 打开文档详情弹窗。
- **操作**：failed 行重试下拉（换模板，复用任务条逻辑）；底部「清除失败记录」（failed>0 时显示）；chat 条目不渲染操作按钮。
- **分页**：50/页 + 上一页/下一页 + total，独立页码状态（不与文档视图串页）；当前页空且 page>1 自动回退上一页。
- **Pinia store**（`stores/documents.ts`）：`taskList/taskTotal/taskFilter/taskPage/scanBatches` + `loadTaskList(page)`（乱序守卫，镜像 `loadArchiveDocuments`）+ `loadScanBatches()`；`documents.task.updated` 事件在任务视图激活时刷新当前页。
- **i18n**：documents 命名空间新增 `tasks.*` 键（~15 键 × 20 locale）。

## 7. 错误处理与边界

- chat 条目 `file_uris` 空数组 → fileName `'(未知文件)'`。
- 批次明细实时查询，任务被 `clearFailed` 删除后自然消失（自洽）。
- 伪任务 id 与 document id 同值：UI 不渲染操作 + 后端 retry 对 chat 无行（双保险）。
- 混排 `created_at` 相同时按 `id` 二次排序，保证分页稳定不重不漏。
- 混排归并取窗口：两查询各取 `offset+limit` 条再归并，不追求 SQL 级精确窗口。

## 8. 测试

- 表层：`listFiltered`/`countFiltered`（status/source/batchId 组合）、`listScanBatches`/`countScanBatches`、索引迁移；`listChatAsTasks`（basename 提取、空 file_uris 回退、source 过滤）。
- routes 层：tasks.list 分页/过滤/混排归并（含 created_at 并列排序稳定性）、scanBatches 通道、documentTaskSchema source 出参。
- renderer：按项目现有约定补过滤切换 + 分页渲染用例（以现有页面测试基线为准）。

## 9. 明确不做（YAGNI）

不建扫描历史表；不补 chat 真任务；不做取消 pending；不做 CSV 导出；批次历史不含去重拦截文件明细（维持现有 `{count}` toast + lastError）。
