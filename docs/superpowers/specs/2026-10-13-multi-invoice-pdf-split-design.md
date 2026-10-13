# 多发票 PDF 拆分识别 设计文档

- 日期：2026-10-13
- 状态：已实施
- 关联样本：`工程技术处通讯费报销（2025年10-12月份）/20261245w7878.pdf`（2 页 = 2 张独立电子发票：发票号码 25957000000181334458 / 25957000000181335300，¥18 与 ¥110，同一购买人同月话费发票合并提交）

## 1. 问题

智能信息提取（document recognition）现有管线是严格的 1 文件 → 1 任务 → 1 文档 → 1 组字段模型。报销场景普遍存在「把同月多张发票合并成一个 PDF 提交」的文件形态。现有多页 PDF 的 vision 路径按页提取后用 `mergeSegmentOutputs` 把所有页合并成一组字段（为「一张发票扫成多页」设计）：每页发票号码、日期、金额各不相同 → 关键字段全部冲突标 `uncertain` → 识别结果不可用。

## 2. 决策（用户确认）

| 决策点 | 结论 |
|---|---|
| 产出粒度 | 拆成 N 个独立文档（每张发票可单独确认/归档/去重/重试） |
| 拆分方式 | 物理拆分：一张发票 = 一页 = 一个独立 PDF 文件，后续管线 1:1 模型零改动 |
| 检测方式 | 文本层规则检测（零模型成本）；无文本层的扫描件不拆，维持现状 |
| 生效范围 | manual / scheduled(autoWatch) / chat 三条提交路径全开 |
| 架构 | 方案 A：提交收口前置拆分层（不选运行时懒拆分 B、入口分散拆分 C） |

## 3. 架构与数据流

新增纯函数层模块 `src/main/documents/invoicePdfSplitter.ts`，**不侵入任何现有模块契约**：

```
expandSubmissionFiles(files, deps)
  ├─ 透传条件：非 PDF / 无文本层 / pageCount < 2 → 原样返回
  ├─ 检测命中 → pdf-lib 逐页导出单页 PDF → <userData>/documents_split/<uuid>/p{n}.pdf
  │    物理文件名：<安全化stem>-p{n}.pdf
  │    任务显示名：<stem>（第n张）.pdf
  └─ 返回 { files: 展开后文件列表, sourceOf: Map<产物路径, 源文件路径> }
```

三条路径接线（均在 composition.ts）：

| 路径 | 接线点 | 适配点 |
|---|---|---|
| manual | routes handler：先 `expandSubmissionFiles` → 再 `submitWithDedupe` | 契约不变，duplicates 照常返回 |
| scheduled/autoWatch | 注入 `expandFiles` 依赖：expand → `submitWithDedupe` → **按源文件**登记 watched | 解决产物任务与源文件 zip 断裂：源文件登记防重扫，产物任务照常创建 |
| chat | extractAndDraft 接线处：expand → 对每个产物文件循环走现有 `submitChatFileWithDedupe` 闸门 | 工具层零改动，N 次提取产出 N 个文档 |

## 4. 检测规则（保守优先）

前置条件（全部满足才进入逐页判定）：
- 文件为 PDF（`isPdfFile`）
- 有文本层（非空白字符 ≥ 200，沿用 `extractPdfText` 的 `hasTextLayer` 判定）
- pageCount ≥ 2

逐页判定：
- 每页文本恰好命中 1 次发票号码模式：`/发票号码[:：]?\s*\d{8,}/`（全电发票 20 位、增值税普票 8 位均覆盖）
- **所有页**恰好各 1 次命中才拆分
- 任一页 0 次命中（夹带非发票页）或 ≥ 2 次命中（一页多票）→ 整文件走现有管线，不拆

分页文本来源：`PdfFileAdapter.getAllPagesMarkdown(): Promise<string[] | undefined>` 已返回按页文本数组。splitter 依赖注入 `extractPdfPagesText(filePath): Promise<string[] | null>`，composition 接线为 `new PdfFileAdapter(filePath, documentsMaxFileSize()).getAllPagesMarkdown()`（adapter 内含 maxFileSize 保护，与现有文本提取同源同限）。

## 5. 拆分产物文件管理

- 存放目录：`<userData>/documents_split/<uuid>/p{n}.pdf`（uuid 隔离每次提交）
- 原始文件绝不移动或删除；产物文件由应用所有，作为拆分后任务的 `fileUris` 长期存在
- 产物文件 GC：v1 不做（文档删除后产物文件成为孤儿，后续可选做启动期清理）；spec 记录为非目标
- 确定性：pdf-lib 导出时不写入创建时间等元数据（不调用 `setCreationDate`/`setModificationDate`）→ 同页拆分产物字节确定，内容哈希可复现

## 6. 去重交互

- 拆分发生在 `submitWithDedupe` 之前：每个产物文件各自 `sha256File`、各自查表/登记 → 同一张发票出现在不同合并包里也能被内容哈希拦截（文件级哈希做不到）
- 同一合并包重提：每页产物哈希命中 → 逐页拦截并提示 existingName（现有 duplicates 契约与 UI 原样生效）
- 整包哈希不登记（每页各自拦截已覆盖，避免语义混淆）
- 失败任务 → 哈希行清理 → retry 成功重登记：上一轮已落地的生命周期（commit 8df6fdf1）对产物任务原样生效

## 7. 错误处理（fail-open）

- 检测/拆分任何环节抛错 → 该文件原样透传走现有管线，绝不因拆分失败阻塞提交
- 拆分后单个任务提取失败 → 现有单任务重试机制原样生效（按发票粒度重试，不影响同包其他发票）

## 8. UI 与通知（v1 最小化）

- 无新 UI 组件、无新事件：任务条自然出现 N 个任务，命名「xxx（第1张）.pdf」自解释
- duplicates 弹窗提示、`documents.watch.duplicates` 通知契约不变
- 非目标（后续可选）：拆分提示 toast、任务按源文件分组展示、一页多票的版面级拆分

## 9. 依赖

- 新增：`pdf-lib`（唯一新依赖，仅主进程；用于逐页导出 PDF）
- 复用：`pdfjs-dist` / `pdf-parse-new`（文本提取，已有）、`sha256File`（Task 3）、`submitWithDedupe` / `submitChatFileWithDedupe`（Task 4/fix wave）

## 10. 测试策略

- splitter 单测（检测规则矩阵）：每页一票 → 拆；含非发票页 → 不拆；一页多票 → 不拆；无文本层 → 透传；单页 PDF → 透传；拆分抛错 → fail-open 透传
- 拆分产物单测：页数正确、命名规则、产物可用 `extractPdfText` 再解析、字节确定性（同输入两次拆分哈希一致）
- 接线测试：manual 提交合并件产出 N 任务；autoWatch 按源文件登记 watched 且下轮 runOnce 不重扫；chat 循环提取产出 N 文档且逐页闸门生效
- fixture：用 pdf-lib 生成两页各含不同「发票号码：」文本的测试 PDF（对齐样本特征，不依赖外部样本文件）

## 11. 非目标

- 一页多张发票的版面级拆分（需 LLM 版面归属，复杂度高，当前规则检测到即不拆）
- 扫描件（无文本层）多发票拆分
- 拆分产物 GC
- 拆分相关的 UI 分组/汇总视图
