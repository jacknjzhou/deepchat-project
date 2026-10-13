# 任务视图「文件相对路径」列设计

状态：已实施——2026-10-13 15:50 用户裁定：相对路径在**自动扫描识别阶段计算并落库**（提交时快照），非读取时计算。

## 1. 背景与目标

归档页「任务」视图（2026-10-13 上线）目前为 6 列（文件/来源/类型/状态/创建时间/操作），缺少文件的来源层级：自动扫描批次可能来自扫描目录下的多层子目录，用户希望直观看到文件在扫描目录内的相对位置。

目标：任务视图列表每行新增一列「文件相对路径」——对自动扫描（scheduled）任务，显示去掉所配置扫描目录前缀后的剩余路径（含文件名），分隔符统一为 `/`；手工上传与对话条目无扫描目录语义，显示 `—`。

## 2. 需求决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 列内容 | 去掉扫描目录前缀后的**子目录 + 文件名**，如 `工程技术处/10月/发票查查.pdf` |
| 非扫描来源（manual/chat） | 显示 `—`（该列值为 null） |
| 计算位置 | **自动扫描识别阶段（提交时）计算并写入 `document_tasks.relative_path` 列**——快照语义：扫描目录日后变更，历史任务仍显示当时的层级 |
| 存量数据 | 启动时幂等回填：`relative_path IS NULL AND source='scheduled'` 的行按**当前**配置目录计算补齐（算不出则保持 NULL） |

被否决的备选：读取时计算（用户裁定否决——快照语义不可接受「目录改配置后旧任务显示 —」）；前端计算（renderer 拿不到扫描目录配置）。

## 3. 计算语义（提交时）

纯函数（放在 autoWatch 可复用位置，随 Task 1 落地）：

```ts
export const computeRelativePath = (filePath: string, scanDir: string): string | null
```

规则（顺序判定）：

1. `scanDir` 为空串 → `null`
2. 两侧先 `path.normalize`（沿用 autoWatch.ts:102-103 的 Windows 分隔符防御先例），`path.relative(normalizedDir, normalizedPath)`
3. 结果为空串、以 `..` 开头、或结果仍是绝对路径（跨盘符防御）→ `null`
4. 否则 `replace(/\\/g, '/')` 后返回（POSIX 化，仓库既有 toPosixPath 先例：fileSearcher.ts:90）

示例：`dir = 'D:\scan'`，`filePath = 'D:\scan\工程技术处\10月\发票查查.pdf'` → `工程技术处/10月/发票查查.pdf`；根目录文件 → 文件名本身。

**多发票拆分产物的归属**：expandFiles 产物是临时单页 PDF（不在扫描目录下），其相对路径必须取**源文件**的相对路径——autoWatch 在提交批次里按 `sourceOf`（产物 path → 源 path）回溯源文件的相对路径，逐产物传入 submit。

## 4. 数据流改动（五层）

### 4.1 表层（src/main/documents/data/tables/documentTasks.ts）

- `document_tasks` 新增可空列 `relative_path TEXT`（无默认值）。
- **迁移纪律**（沿用统一任务列表 Task 1 的既定纪律）：该表不在主 schema_versions 迁移循环内——`getCreateTableSQL()` 建表 DDL 加列 + `getMigrationSQL(2)` 重建 DDL 加列（重建与新建一致）+ `ensureMigrated()` 末尾幂等加列（`PRAGMA table_info(document_tasks)` 检查缺列后 `ALTER TABLE ADD COLUMN relative_path TEXT`）。不 bump getLatestVersion。
- `DocumentTaskRow` 增加 `relative_path: string | null`；`toTask` 映射补 `relativePath`；`DocumentTask` 类型增加 `relativePath: string | null`；`insertTasks` 入参可选携带 `relativePath?: string | null`（缺省 null）。

### 4.2 提交链（src/main/documents/autoWatch.ts + taskManager.ts）

- autoWatch `runOnce`：`collectCandidates` 产出的候选文件（绝对路径）对 `config.dir` 调 `computeRelativePath` 得到源文件相对路径；经 expandFiles 展开后，逐提交条目按 `sourceOf` 回溯源文件相对路径（未被拆分的条目即自身）。
- 提交链以**逐文件映射**透传：`RecognitionTaskSubmitInput` 增可选 `relativePathByPath?: Record<string, string | null>`（键为提交文件绝对路径）；`taskManager.submit` 落库时逐文件取 `relativePathByPath?.[file.path] ?? null` 传给 `insertTasks`；manual/chat 提交路径不传 → null。

### 4.3 repository 层（src/main/documents/repository.ts）

- `UnifiedTaskEntry` 增加 `relativePath: string | null`（置于 `filePath` 之后）。
- `toUnifiedTaskEntry` 从 `DocumentTask.relativePath` 原样读取；`toChatTaskEntry` 恒 `null`。
- **不做读取时计算**——repository 只透传落库快照。`DocumentRepositoryTaskPort` 不新增方法。

### 4.4 启动回填（src/main/documents/dedupeBackfill.ts 扩展）

- 现有启动回填 routine 扩展（或并列新增函数）：查询 `source='scheduled' AND relative_path IS NULL` 的行，读 `readAutoWatchConfig(providerSettings).dir`，逐行 `computeRelativePath(filePath, dir)`，非 null 则 UPDATE。
- **无条件幂等执行**（每次启动跑，只触碰 NULL 行，代价可忽略），不引入新的 settings 完成标记键——与 dedupeBackfill 的「done 标记」不同，本回填语义是「随配置刷新可回填的空值」，无一次性性质。
- composition 启动接线处与 dedupeBackfill 同点追加（符号搜索定位）。

### 4.5 契约与 renderer

- `unifiedTaskEntrySchema`（src/shared/contracts/routes/documents.routes.ts）增加 `relativePath: z.string().min(1).nullable()`（置于 filePath 之后）。`documentTaskSchema` **不动**（`documents.task.updated` 事件不携带该字段）。
- renderer 行类型由 schema 推导，store 零改动。
- `DocumentsArchivePage.vue` 任务视图表格：6 列 → 7 列，新列插在「文件」与「来源」之间：
  - 表头：`{{ t('settings.documents.tasks.colRelativePath') }}`
  - 单元格：`<td class="max-w-[200px] truncate px-2 py-2" :title="task.relativePath ?? ''">`，内容 `task.relativePath ?? '—'`
- i18n：全部 locale（约 20 个）`src/renderer/src/i18n/<locale>/settings.json` documents 节加键 `colRelativePath`：zh-CN `文件相对路径`，en-US `Relative Path`，其余英文占位，键集合一致。

## 5. 测试

- **纯函数**：win32 反斜杠输入 → `/` 分隔输出；根目录文件 → 文件名本身；`..` 开头 → null；跨盘符 → null；scanDir 空 → null。
- **表层**：新库含列、存量库 ensureMigrated 后补列且既有数据保留；insertTasks 带/不带 relativePath。
- **提交链**：autoWatch runOnce——未拆分文件按 config.dir 落 relativePath；拆分产物回溯源文件相对路径；manual 路径提交不含 relativePath（null）。
- **repository**：真任务条目透传行值、chat 条目恒 null。
- **回填**：NULL + scheduled + 路径在当前目录下 → 补齐；`..` 情形保持 NULL；manual/chat 行不触碰。
- **契约回归**：既有 documentsRoutes 用例零回归（出参新增 nullable 字段后 parse 通过）。

## 6. 边界与明确不做

边界：提交时快照——目录改配置后**新**任务按新目录、**旧**任务保留旧层级（历史准确性正是落库动机）；回填对已变更目录的存量行算不出 → 保持 NULL 显示 `—`；计算失败永不阻塞提交与列表（fail-open，降级 null）。

明确不做（YAGNI）：不做多扫描目录支持（当前配置就是单目录）、不做按相对路径的过滤/排序、事件流不携带该字段、不记录历史目录列表。
