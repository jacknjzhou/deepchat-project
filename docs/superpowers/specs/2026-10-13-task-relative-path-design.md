# 任务视图「文件相对路径」列设计

状态：已确认（待实施）

## 1. 背景与目标

归档页「任务」视图（2026-10-13 上线）目前为 6 列（文件/来源/类型/状态/创建时间/操作），缺少文件的来源层级：自动扫描批次可能来自扫描目录下的多层子目录，用户希望直观看到文件在扫描目录内的相对位置。

目标：任务视图列表每行新增一列「文件相对路径」——对自动扫描（scheduled）任务，显示去掉所配置扫描目录前缀后的剩余路径（含文件名），分隔符统一为 `/`；手工上传与对话条目无扫描目录语义，显示 `—`。

## 2. 需求决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 列内容 | 去掉扫描目录前缀后的**子目录 + 文件名**，如 `工程技术处/10月/发票查查.pdf` |
| 非扫描来源（manual/chat） | 显示 `—`（该列值为 null） |
| 计算位置 | main 进程**读取时计算**（方案 A），不落库 |

被否决的备选：提交时落库 `relative_path` 列（可派生数据，YAGNI）；前端计算（renderer 拿不到扫描目录配置，需额外 IPC）。

## 3. 计算语义

新增模块级纯函数（`src/main/documents/repository.ts`）：

```ts
export const computeRelativePath = (filePath: string | null, source: string, scanDir: string): string | null
```

规则（顺序判定）：

1. `source !== 'scheduled'` → `null`
2. `scanDir` 为空串或 `filePath` 为空/null → `null`
3. 两侧先 `path.normalize`（沿用 autoWatch.ts:102-103 的 Windows 分隔符防御先例），`path.relative(normalizedDir, normalizedPath)`
4. 结果为空串、以 `..` 开头、或结果仍是绝对路径（跨盘符防御）→ `null`（扫描目录已变更的历史任务，诚实显示 `—`，不猜历史目录）
5. 否则 `replace(/\\/g, '/')` 后返回（POSIX 化，仓库既有 toPosixPath 先例：fileSearcher.ts:90）

示例：`dir = 'D:\scan'`，`filePath = 'D:\scan\工程技术处\10月\发票查查.pdf'` → `工程技术处/10月/发票查查.pdf`；根目录文件 → 文件名本身。

## 4. 数据流改动（三层）

### 4.1 repository 层（src/main/documents/repository.ts）

- `DocumentsRepository` 构造函数追加**可选**第二参数 `getAutoWatchDir?: () => string`（现有单参调用点全部保持合法；不注入时所有条目 relativePath 恒 null，保守降级）。
- `UnifiedTaskEntry` 增加 `relativePath: string | null`（置于 `filePath` 之后）。
- `toUnifiedTaskEntry` / `toChatTaskEntry` 两个构造器补字段：chat 恒 `null`；真任务在 `listUnifiedTasks` 出口处统一后处理——`tasks.map(t => ({ ...t, relativePath: computeRelativePath(t.filePath, t.source, dir) }))`，其中 `dir = this.getAutoWatchDir?.() ?? ''`。
- `DocumentRepositoryTaskPort` / `DocumentTask` 类型**不动**（relativePath 是统一条目派生字段，不进任务本体）。

### 4.2 契约层（src/shared/contracts/routes/documents.routes.ts）

- `unifiedTaskEntrySchema` 增加 `relativePath: z.string().min(1).nullable()`（置于 filePath 之后）。
- `documentTaskSchema` **不动**（`documents.task.updated` 事件 payload 不携带该字段，任务条无此需求）。
- routes handler 原样透传，无需改动（repository 返回什么就 parse 什么）。

### 4.3 renderer 层

- 行类型由 `unifiedTaskEntrySchema` zod 推导（stores/documents.ts 的 `UnifiedTaskItem`），契约加字段后自动获得类型，store 零改动。
- `DocumentsArchivePage.vue` 任务视图表格：六列 → 七列，新列插在「文件」与「来源」之间：
  - 表头：`{{ t('settings.documents.tasks.colRelativePath') }}`
  - 单元格：`<td class="max-w-[200px] truncate px-2 py-2" :title="task.relativePath ?? ''">`，内容 `task.relativePath ?? '—'`
- i18n：全部 locale（约 20 个）`src/renderer/src/i18n/<locale>/settings.json` documents 节加键 `colRelativePath`：zh-CN `文件相对路径`，en-US `Relative Path`，其余英文占位，键集合一致（沿用任务视图落地方式）。

### 4.4 composition 接线（src/main/app/composition.ts）

repository 构造点追加第二参数：

```ts
new DocumentsRepository(database, () => readAutoWatchConfig(providerSettings).dir)
```

（符号搜索 `new DocumentsRepository` 定位；`readAutoWatchConfig` 已在该文件作用域可用——autoWatchScheduler 的 `readConfig` 同源。）

## 5. 测试

- **纯函数**（`test/main/documents/documentsRepository.test.ts` 或独立小节）：
  - win32 反斜杠输入子目录层级 → `/` 分隔输出
  - 根目录文件 → 文件名本身
  - `..` 开头（目录不匹配）→ null
  - 跨盘符 → null
  - source 非 scheduled / scanDir 空 / filePath null → null
- **repository 集成**：注入 `getAutoWatchDir` 桩——scheduled 条目带 relativePath、manual/chat 条目 null；不注入时全 null。
- **契约回归**：既有 documentsRoutes 用例零回归（出参新增 nullable 字段后 parse 通过）。

## 6. 边界与明确不做

边界：扫描目录变更后旧任务显示 `—`；计算失败永不阻塞列表（纯派生字段，降级 null）。

明确不做（YAGNI）：不落库、不做历史扫描目录回溯、不加按相对路径的过滤/排序、事件流不携带该字段、不做多扫描目录支持（当前配置就是单目录）。
