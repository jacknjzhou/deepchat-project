# Documents 自动识别（目录定时扫描）设计

日期：2026-10-11
状态：已获用户批准的设计（四项决策见下）

## 背景与目标

「智能信息提取」（Documents）目前仅支持手工上传文件识别。本设计新增：用户在设置中指定一个监控目录，应用按小时级间隔自动扫描该目录，对符合后缀过滤的文件（新增与存量）提交识别任务，并通过每轮限量与失败不重试控制服务负载。

## 用户确认的决策

1. **模板策略：自动分类** —— 扫描到的文件不指定模板，由 extractor 已有的 auto classification 按内容自动选模板。
2. **去重语义：路径 + 修改时间** —— 同一文件路径且 mtime 未变化则跳过；mtime 变化（内容被修改）重新识别。首轮开启时目录内全部匹配文件视为存量全量识别（因为无处理记录）。
3. **负载控制：每轮限量 + 失败不重试** —— 每轮扫描最多提交 N 个新任务（可配，默认 20），超出部分下一轮处理；「提交成功」即写入已处理记录（无论后续识别成败，均不再自动重新提交）；识别失败的任务进入现有失败列表，用户可手动重识别。
4. **目录数量：单个监控目录**。

## 架构

定时层放主进程常驻调度器（渲染层定时器会随页面/窗口状态停摆，不采用）。与现有 taskManager 队列、DocumentsSettingsStore、sqlite 同层。

```
设置页(渲染) --IPC--> settings 键 documents.autoWatch
                          |
AutoWatchScheduler(主进程) --每分钟 tick--> 到达 nextRunAt 则执行一轮:
  readdir(dir) -> 后缀过滤 -> stat 取 mtime
  -> 对比 documents_watched_files (path+mtime 均同 => 跳过)
  -> 取前 roundLimit 个 => taskManager.submit({source:'scheduled', 无 templateId})
  -> 提交成功写 watched_files(submitted, mtime)
  -> 目录异常 => lastError 记入 settings, 本轮跳过
```

## 组件设计

### 1. 主进程调度器 `src/main/documents/autoWatch.ts`（新模块）

`AutoWatchScheduler` 类：

- `start()` / `stop()` / `dispose()`：应用启动时由 Documents 模块装配处创建并 start。
- 内部 `setInterval` 每分钟 tick：对比 `now >= nextRunAt` 决定是否执行；`nextRunAt` 在每轮结束或配置变更后按 `intervalHours` 重算。分钟级 tick 对小时级间隔天然容忍系统休眠唤醒后的时钟跳变。
- 每轮流程（可注入依赖便于测试：`fspLike`、`now`、settingsStore、taskManager、repository）：
  1. 读配置 `documents.autoWatch`；`enabled=false` 或 `dir` 为空直接返回。
  2. `readdir(dir, { withFileTypes })` → 仅取文件项 → 按配置后缀（大小写不敏感）过滤。
  3. 对候选文件 `stat` 取 `mtimeMs`，与 `documents_watched_files` 比对：path 命中且 `mtime_ms` 相同（容差取整到毫秒）则跳过。
  4. 未处理文件按文件名排序取前 `roundLimit` 个，构造 `files` 提交 `taskManager.submit({ files, source: 'scheduled' })`（不传 templateId → 自动分类）。
  5. 每个提交成功（拿到 task）的文件写 `documents_watched_files`：`(path, mtime_ms, status='submitted', task_id, processed_at)`。
  6. 写 `documents.autoWatchState`：`{ lastRunAt, lastError: null }`。
  - 目录不存在/无权限/readdir 抛错：写 `autoWatchState.lastError`，本轮不提交，`nextRunAt` 照常顺延。
- 任务提交后的识别成败由 taskManager 既有流程处理（失败任务进入现有失败列表）；识别失败不回写 watched_files（即「失败不重试」——去重以「提交成功」为准）。

### 2. 配置存储（settings 单键对象）

`DOCUMENTS_SETTINGS_KEYS` 新增：

```ts
autoWatch: 'documents.autoWatch',
autoWatchState: 'documents.autoWatchState'
```

`documents.autoWatch` 结构与默认值：

```ts
{
  enabled: false,
  dir: '',
  intervalHours: 1,      // 1–72，整数
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],  // 候选固定为识别支持的类型
  roundLimit: 20         // 1–20，对齐契约 files.max(20)
}
```

读写校验：zod schema 镜像（主进程读时解析，非法值回落默认）。

### 3. 存储层：sqlite v52 迁移新增表

```sql
CREATE TABLE IF NOT EXISTS documents_watched_files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL,          -- 固定 'submitted'（提交成功即永久去重）
  task_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL
)
```

- 幂等 `CREATE TABLE IF NOT EXISTS`，独立于 documents 表结构（不使用 repairableColumns）。
- Repository 新增方法：`listWatchedFiles()`（全量，含 mtime）、`upsertWatchedFile(entry)`。
- 不做记录清理：文件删除后残留记录无副作用（同名新文件 mtime 更新自然重识别）。

### 4. 契约扩展（`src/shared/contracts/routes/documents.routes.ts`）

- `documentSourceSchema`：`'chat' | 'manual'` → 增加 `'scheduled'`。
- `documentTasksCreateRoute.input.templateId`：`z.string().min(1)` → `.optional()`；不传时 extractor 走既有自动分类路径（extractor.extract 无模板时自动分类已存在，无需新增分类代码）。
- 渲染端手工上传链路不受影响（仍显式传 templateId）。

### 5. UI（文档识别设置页新增「自动识别」卡片）

沿用现有设置页样式与 shadcn-vue 原语：

- 启用开关（切换时校验：启用需已选目录）。
- 目录选择：按钮调起系统目录选择 dialog（复用现有目录选择 IPC；若渲染端无现成通道则新增一条 `documents.autoWatch.chooseDir`）。
- 扫描间隔：数字输入（1–72 小时）。
- 后缀过滤：固定候选勾选（pdf/png/jpg/jpeg/webp/gif），默认勾选 pdf/png/jpg/jpeg。
- 每轮上限：数字输入（1–20）。
- 状态行：上次扫描时间、lastError 提示（红色）。
- 保存沿用设置页现有保存模式。

## 数据流与边界

- 存量识别：开启后首轮，目录内全部匹配文件无记录 → 全量进入待处理，受每轮限量分轮消化。
- 新增识别：后续轮次只有新路径或 mtime 变化的文件会被提交。
- 大目录：仅对后缀匹配文件 stat；提交限量；readdir 单次全量列举（目录规模预期可控）。
- 目录被删后重建：残留记录的 path 对同名新文件 mtime 不同 → 重新识别（符合预期）。
- 应用关闭即停止调度，重启后从 `autoWatchState.lastRunAt` 重算 `nextRunAt` 继续。

## 测试

- 主进程调度器单测：注入 fake fsp/时钟/taskManager/repository，覆盖：首轮全量限量、mtime 变化重识别、路径+mtime 相同跳过、roundLimit 截断、目录异常 lastError、enabled=false 跳过、后缀大小写不敏感。
- 契约测试：source 增加 'scheduled'、templateId optional 后既有必传校验回归、tasksCreate 路由无 templateId 提交走自动分类。
- 迁移测试：v52 建表幂等。
- 渲染端设置页组件测试：卡片渲染、开关校验、保存调用、状态行展示。

## 明确不做（YAGNI）

- 多目录监控。
- 失败自动重试。
- 文件删除联动清理 watched_files 记录。
- 文件内容哈希去重（mtime 已满足需求）。
