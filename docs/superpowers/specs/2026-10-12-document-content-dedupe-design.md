# 智能信息提取：文件内容级去重 设计文档

日期：2026-10-12
状态：已确认（用户确认四项口径：字节级 SHA-256 / 提交时拦截 / 通知+弹窗提示 / 仅增量）

## 背景与目标

智能信息提取功能的文件入口有三条：

1. 手动提交（识别弹窗，`source: 'manual'`）
2. 聊天内上传（`source: 'chat'`）
3. 目录自动监控（`AutoWatchScheduler`，`source: 'scheduled'`）

现状：自动监控仅有 path+mtime 去重（`documents_watched_files`），手动/聊天路径无任何去重。
同一内容的文件换名、换目录、重复上传都会重复提取，产生重复单据并浪费模型调用。

目标：按**文件字节内容**（SHA-256）判重，在提交环节拦截重复文件不再提取，并给出提示。

## 已确认的口径

| 维度 | 决策 |
| --- | --- |
| 判重口径 | 文件原始字节流 SHA-256（流式计算，内存恒定）；不做文本级指纹 |
| 拦截时机 | 提交时拦截（`submit` 收口处），不建任务不占队列 |
| 提示方式 | 手动提交弹窗内联提示 + 自动监控系统通知 |
| 历史数据 | 仅增量：上线后新提取的文件才登记哈希，不回填历史文档 |

## 架构

```
手动/聊天上传 ──► IPC createRecognitionTasks ─┐
                                              ├─► [内容去重过滤器] ─► RecognitionTaskManager.submit
自动监控轮次 ──► AutoWatchScheduler.submit ───┘      │  │
                                              命中重复┘  │未命中（批内互重也在此拦截）
                                                         ▼
                                              建任务时登记 hash→task_id
                                              任务成功→回填 document_id
                                              任务失败→删除该 hash 行
```

### 1. 数据层

- 新表 `documents_file_dedupe`：
  - `content_hash TEXT PRIMARY KEY`（SHA-256 hex 小写）
  - `file_name TEXT NOT NULL`、`file_path TEXT NOT NULL`（首次登记时的文件）
  - `source TEXT NOT NULL`（manual/chat/scheduled）
  - `task_id TEXT NOT NULL`（登记来源任务，失败清理键）
  - `document_id TEXT`（可空；任务成功后回填，支撑提示文案与将来跳转）
  - `created_at INTEGER NOT NULL`
- 建表走既有 repairableColumns 幂等修复模式（失败可重试修复，不依赖单次版本迁移成功）
- `documents_watched_files.task_id` 放宽为可空：自动监控中被拦截的文件仍登记为已处理（task_id 记 NULL），保证下一轮不重扫

### 2. 哈希计算（新文件 `src/main/documents/fileHash.ts`）

- `sha256File(filePath): Promise<string | null>`：`createReadStream` + `crypto.createHash('sha256')`，64KB 分块
- 读文件失败（文件消失/无权限）→ 返回 null，该文件**照常提交提取**（不因判重失败而拦截，提取自有错误路径兜底）

### 3. 拦截点（唯一收口）

- 去重过滤器为独立模块，在 service 组装层包裹 `submit`，三条来源统一生效；`RecognitionTaskManager` 保持纯净（单测不受影响）
- 处理顺序：批内逐文件算 hash → 批内互重去重（同批同内容仅首个提交）→ 查表过滤 → 单事务登记未命中文件的哈希行 → 原有 submit
- `retryTask` 直接重排队不经过 `submit`，失败重试天然不受影响
- 同一文件 mtime 变化但内容未变：watched_files 允许重扫，但内容哈希命中即拦截（覆盖「重新保存同内容」场景）

### 4. 生命周期联动

- 提交成功 → 登记哈希行（含 task_id）
- 任务失败 → 按 `task_id` 删除哈希行（用户修复文件后重传同内容不被误拦）
- 任务成功 → 按 `task_id` 回填 `document_id`

### 5. 提示

- IPC `createRecognitionTasks` 返回值扩展为 `{ tasks, duplicates: Array<{ fileName, existingName }> }`
- 手动提交弹窗：内联提示「已跳过 N 个内容重复的文件：a.pdf（与 b.pdf 重复）」（i18n 新键，20 语言）
- 自动监控：轮次结束后经现有 renderer 通知通道发系统通知「本轮已跳过 N 个重复文件」；duplicates>0 才发
- 列表/导出零改动（被拦截文件不产生记录）

### 6. 不做的事（YAGNI）

- 不做提取文本级指纹二级判重（另存为/重导出场景 v1 不覆盖）
- 不做历史文档哈希回填
- 不新增开关设置项（去重为正确性默认行为）

## 测试

- `fileHash`：流式哈希正确性、读取失败返回 null
- 去重过滤器：批内互重、查表命中、事务登记、哈希行返回的 existingName 映射
- `RecognitionTaskManager`：失败按 task_id 清理哈希行、成功回填 document_id（deps 端口扩展）
- `AutoWatchScheduler`：被拦截文件仍登记 watched（task_id 为 NULL）且下一轮不重扫
- repository：新表幂等建表/修复
- 识别弹窗：duplicates 提示渲染

## 影响面

- 主进程：documents repository/migration、fileHash（新）、dedupe 过滤器（新）、documents service 组装、taskManager（生命周期钩子）、autoWatch（submit 返回结构与 watched 登记）
- preload/IPC：createRecognitionTasks 返回类型
- renderer：DocumentRecognizeDialog 提示、i18n 20 语言
- 无 settings 键、无 ACP/Provider 耦合
