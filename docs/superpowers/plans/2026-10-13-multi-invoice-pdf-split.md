# 多发票 PDF 拆分识别 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 智能信息提取支持「一个 PDF 内含多张独立发票」的合并件：提交时按文本层规则检测，逐页物理拆分为 N 个单页 PDF，各自走现有任务/识别/去重/归档管线。

**Architecture:** 新增纯逻辑层 `invoicePdfSplitter.ts`（检测 + 展开，fail-open）与 pdf-lib 落盘适配器 `pdfPageSplitter.ts`；三条提交路径（manual/scheduled/chat）在 composition 各自先展开再进现有收口（`submitWithDedupe` / `submitChatFileWithDedupe`），现有模块契约零改动；autoWatch 增加 `expandFiles` 依赖并按**源文件**登记 watched 防重扫。

**Tech Stack:** TypeScript (Electron main)、pdf-lib（新增依赖）、Vitest。Spec: `docs/superpowers/specs/2026-10-13-multi-invoice-pdf-split-design.md`

## Global Constraints

- 集成点代码块为「对齐现有模式的目标形状」：落地时以锚点处实际代码为准，保持既有行为契约不变，不盲抄。composition.ts 巨大且行号漂移，一律符号搜索定位（如 `documentsDedupeSubmit`、`new AutoWatchScheduler`、`extractAndDraft:`）。
- 主进程测试命令（bash；本机 pnpm exec/run shim 损坏，直接调用 node_modules 下二进制）：
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`
- test:main 全仓有 ~98 个既有环境性失败基线：只比对失败文件清单与本次改动区域，不修既有失败。
- `typecheck:node` 必须通过：`./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false`（会触碰 tsconfig.node.tsbuildinfo，勿提交）。
- `typecheck:web` 本机 tsgo OOM（errno 1455/134）复现则跳过并注明（本次仅改主进程）。
- oxfmt 单引号/无分号/100 列（`./node_modules/.bin/oxfmt <files>`）+ `./node_modules/.bin/oxlint <files>` 0 警告，仅对改动文件执行。
- 提交信息 Conventional Commits ≤50 字符；使用 pnpm only（新依赖用 `pnpm add`，勿用 npm 以免破坏 pnpm-lock.yaml）。
- 依赖注入风格：新模块 IO 一律 deps 注入（镜像 `contentDedupe.ts` 的 `DedupeSubmitDeps` 模式）。
- 测试导入别名用 `@/documents/...`（`test/main/documents/` 目录既有约定）；测试文件头 `vi.unmock('fs')/'node:fs'/'path'/'node:path'`（共享 `test/setup.ts` 全局 mock 了 fs，需要真实 fs 的测试参照 `taskManager.test.ts` 头部）。
- Edit 工具在 Windows 有损坏文件尾部的前科：每次编辑后读回文件尾部确认完整性。

---

### Task 1: invoicePdfSplitter 纯逻辑（检测 + 展开 + fail-open）

**Files:**
- Create: `src/main/documents/invoicePdfSplitter.ts`
- Test: `test/main/documents/invoicePdfSplitter.test.ts`

**Interfaces:**
- Consumes: `DocumentExtractFileInput`（from `./extractor/documentExtractor`，字段 `{ path: string; name?: string; mimeType?: string }`）
- Produces（后续任务依赖的精确签名）:
  - `export const INVOICE_NO_PATTERN: RegExp`（= `/发票号码[:：]?\s*\d{8,}/`，非全局）
  - `export function isMultiInvoicePages(pages: string[]): boolean`
  - `export interface InvoiceSplitDeps { extractPdfPagesText: (filePath: string) => Promise<string[] | null>; splitPdfPages: (filePath: string, outDir: string) => Promise<string[]>; makeWorkDir: () => Promise<string> }`
  - `export interface ExpandedSubmission { files: DocumentExtractFileInput[]; sourceOf: Map<string, string> }`（sourceOf: 产物 path → 源 path，仅拆分文件有条目）
  - `export async function expandSubmissionFiles(files: DocumentExtractFileInput[], deps: InvoiceSplitDeps): Promise<ExpandedSubmission>`

- [ ] **Step 1: 写失败测试**

```ts
// test/main/documents/invoicePdfSplitter.test.ts
import { describe, expect, it, vi } from 'vitest'
import {
  expandSubmissionFiles,
  isMultiInvoicePages,
  type InvoiceSplitDeps
} from '@/documents/invoicePdfSplitter'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

const pdfFile = (path = 'C:\\合并发票.pdf', name?: string) => ({
  path,
  ...(name !== undefined ? { name } : {}),
  mimeType: 'application/pdf'
})

const twoInvoicePages = [
  '电子发票（普通发票） 发票号码：25957000000181334458 开票日期：2025年12月09日 价税合计 ¥18.00',
  '电子发票（普通发票） 发票号码：25957000000181335300 开票日期：2025年12月08日 价税合计 ¥110.00'
]

const makeDeps = (overrides: Partial<InvoiceSplitDeps> = {}): InvoiceSplitDeps => ({
  extractPdfPagesText: vi.fn(async () => twoInvoicePages),
  splitPdfPages: vi.fn(async (_filePath: string, outDir: string) => [
    `${outDir}\\p1.pdf`,
    `${outDir}\\p2.pdf`
  ]),
  makeWorkDir: vi.fn(async () => 'C:\\split\\uuid-1'),
  ...overrides
})

describe('isMultiInvoicePages', () => {
  it('每页恰好一张发票（2 页及以上）→ true', () => {
    expect(isMultiInvoicePages(twoInvoicePages)).toBe(true)
    expect(isMultiInvoicePages([...twoInvoicePages, ...twoInvoicePages])).toBe(true)
  })

  it('单页文件 → false', () => {
    expect(isMultiInvoicePages([twoInvoicePages[0]!])).toBe(false)
  })

  it('含非发票页（无发票号码）→ false', () => {
    expect(isMultiInvoicePages([...twoInvoicePages, '报销单封面，无发票内容'])).toBe(false)
  })

  it('一页多张发票（发票号码出现 2 次）→ false', () => {
    const merged = `${twoInvoicePages[0]}\n${twoInvoicePages[1]}`
    expect(isMultiInvoicePages([merged, twoInvoicePages[1]!])).toBe(false)
  })
})

describe('expandSubmissionFiles', () => {
  it('多发票 PDF：拆分为逐页产物，显示名带序号，sourceOf 指向源文件', async () => {
    const deps = makeDeps()
    const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({
      path: 'C:\\split\\uuid-1\\p1.pdf',
      name: '合并发票（第1张）.pdf',
      mimeType: 'application/pdf'
    })
    expect(files[1]).toMatchObject({
      path: 'C:\\split\\uuid-1\\p2.pdf',
      name: '合并发票（第2张）.pdf'
    })
    expect(sourceOf.get('C:\\split\\uuid-1\\p1.pdf')).toBe('C:\\合并发票.pdf')
    expect(sourceOf.get('C:\\split\\uuid-1\\p2.pdf')).toBe('C:\\合并发票.pdf')
  })

  it('无文本层（总文本过短，即便页数达标）→ 原样透传', async () => {
    const deps = makeDeps({
      extractPdfPagesText: vi.fn(async () => ['发票号码：12345678', '发票号码：87654321'])
    })
    const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(sourceOf.size).toBe(0)
  })

  it('单页 PDF / 含非发票页 / 一页多票 → 原样透传', async () => {
    for (const pages of [
      [twoInvoicePages[0]!],
      [...twoInvoicePages, '封面页无发票'],
      [`${twoInvoicePages[0]}\n${twoInvoicePages[1]}`, twoInvoicePages[1]!]
    ]) {
      const deps = makeDeps({ extractPdfPagesText: vi.fn(async () => pages) })
      const { files, sourceOf } = await expandSubmissionFiles([pdfFile()], deps)
      expect(files[0]?.path).toBe('C:\\合并发票.pdf')
      expect(sourceOf.size).toBe(0)
    }
  })

  it('非 PDF 文件（mimeType 图片 / 扩展名）→ 不调提取直接透传', async () => {
    const extractPdfPagesText = vi.fn(async () => twoInvoicePages)
    const deps = makeDeps({ extractPdfPagesText })
    const { files, sourceOf } = await expandSubmissionFiles(
      [
        { path: 'C:\\photo.png', mimeType: 'image/png' },
        { path: 'C:\\scan.jpg' },
        pdfFile()
      ],
      deps
    )
    expect(extractPdfPagesText).toHaveBeenCalledTimes(1)
    expect(files).toHaveLength(3)
    expect(files[0]?.path).toBe('C:\\photo.png')
    expect(files[1]?.path).toBe('C:\\scan.jpg')
    expect(sourceOf.size).toBe(1)
  })

  it('无 mimeType 时按 .pdf 扩展名判断', async () => {
    const extractPdfPagesText = vi.fn(async () => twoInvoicePages)
    const deps = makeDeps({ extractPdfPagesText })
    const { sourceOf } = await expandSubmissionFiles([{ path: 'C:\\合并发票.PDF' }], deps)
    expect(sourceOf.size).toBe(1)
  })

  it('提取失败（null）或拆分抛错 → fail-open 原样透传', async () => {
    const nullDeps = makeDeps({ extractPdfPagesText: vi.fn(async () => null) })
    const r1 = await expandSubmissionFiles([pdfFile()], nullDeps)
    expect(r1.files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(r1.sourceOf.size).toBe(0)

    const throwDeps = makeDeps({ splitPdfPages: vi.fn(async () => { throw new Error('disk full') }) })
    const r2 = await expandSubmissionFiles([pdfFile()], throwDeps)
    expect(r2.files[0]?.path).toBe('C:\\合并发票.pdf')
    expect(r2.sourceOf.size).toBe(0)
  })

  it('显示名优先用 file.name 且净化非法字符；无 name 用路径 stem', async () => {
    const deps = makeDeps()
    const { files } = await expandSubmissionFiles(
      [pdfFile('C:\\dir\\报告:最终版.pdf', '通讯费:12月.pdf')],
      deps
    )
    expect(files[0]?.name).toBe('通讯费_12月（第1张）.pdf')
    const { files: noName } = await expandSubmissionFiles([pdfFile('C:\\dir\\话费发票.pdf')], deps)
    expect(noName[0]?.name).toBe('话费发票（第1张）.pdf')
  })

  it('多文件混合：仅拆分命中的文件，其余保持原顺序', async () => {
    const deps = makeDeps()
    const { files, sourceOf } = await expandSubmissionFiles(
      [{ path: 'C:\\a.png', mimeType: 'image/png' }, pdfFile(), pdfFile('C:\\单页.pdf')],
      deps
    )
    expect(files.map((f) => f.path)).toEqual([
      'C:\\a.png',
      'C:\\split\\uuid-1\\p1.pdf',
      'C:\\split\\uuid-1\\p2.pdf',
      'C:\\单页.pdf'
    ])
    expect(sourceOf.size).toBe(2)
  })
})
```

- [ ] **Step 2: 运行确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/invoicePdfSplitter.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在 / isMultiInvoicePages not exported）

- [ ] **Step 3: 实现**

```ts
// src/main/documents/invoicePdfSplitter.ts
import type { DocumentExtractFileInput } from './extractor/documentExtractor'

/** 发票号码模式：全电发票 20 位、增值税普票 8 位均以 8 位起步数字覆盖 */
export const INVOICE_NO_PATTERN = /发票号码[:：]?\s*\d{8,}/

/** 文本层判定阈值，与 composition extractPdfText 的 hasTextLayer 判定保持一致 */
const TEXT_LAYER_MIN_CHARS = 200

export interface InvoiceSplitDeps {
  /** 分页文本；null = 非 PDF 或读取/解析失败 */
  extractPdfPagesText: (filePath: string) => Promise<string[] | null>
  /** 逐页导出单页 PDF 到 outDir，返回按页序排列的产物路径 */
  splitPdfPages: (filePath: string, outDir: string) => Promise<string[]>
  /** 创建本次拆分的专属工作目录（uuid 隔离），失败由调用方 fail-open */
  makeWorkDir: () => Promise<string>
}

export interface ExpandedSubmission {
  files: DocumentExtractFileInput[]
  /** 产物 path → 源文件 path；仅被拆分的源文件产生条目 */
  sourceOf: Map<string, string>
}

/**
 * 多发票合并件判定（保守优先）：页数 ≥ 2 且每页文本恰好命中一次发票号码。
 * 任一页 0 次（夹带非发票页）或 ≥ 2 次（一页多票）→ 不拆。
 */
export function isMultiInvoicePages(pages: string[]): boolean {
  if (pages.length < 2) return false
  return pages.every((page) => {
    const matches = page.match(new RegExp(INVOICE_NO_PATTERN.source, 'g'))
    return matches !== null && matches.length === 1
  })
}

const isPdfFile = (file: DocumentExtractFileInput): boolean =>
  file.mimeType ? file.mimeType === 'application/pdf' : /\.pdf$/i.test(file.path)

// 与 contentDedupe/taskManager 的显示名回退逻辑保持一致
const displayStem = (file: DocumentExtractFileInput): string => {
  const raw = file.name ?? file.path.split(/[\\/]/).pop() ?? file.path
  const stem = raw.replace(/\.pdf$/i, '')
  // Windows 文件名非法字符净化（冒号等），避免产物显示名落盘/展示异常
  return stem.replace(/[\\/:*?"<>|]/g, '_')
}

async function expandOne(
  file: DocumentExtractFileInput,
  deps: InvoiceSplitDeps
): Promise<DocumentExtractFileInput[] | null> {
  if (!isPdfFile(file)) return null
  const pages = await deps.extractPdfPagesText(file.path)
  if (pages === null || pages.length < 2) return null
  if (pages.join('').replace(/\s/g, '').length < TEXT_LAYER_MIN_CHARS) return null
  if (!isMultiInvoicePages(pages)) return null
  const outDir = await deps.makeWorkDir()
  const productPaths = await deps.splitPdfPages(file.path, outDir)
  const stem = displayStem(file)
  return productPaths.map((p, i) => ({
    path: p,
    name: `${stem}（第${i + 1}张）.pdf`,
    mimeType: 'application/pdf'
  }))
}

/**
 * 提交前展开：多发票合并件 → N 个单页产物文件，其余原样透传。
 * fail-open：单个文件检测/拆分任何环节抛错 → 该文件原样透传，绝不阻塞提交。
 */
export async function expandSubmissionFiles(
  files: DocumentExtractFileInput[],
  deps: InvoiceSplitDeps
): Promise<ExpandedSubmission> {
  const out: DocumentExtractFileInput[] = []
  const sourceOf = new Map<string, string>()
  for (const file of files) {
    try {
      const products = await expandOne(file, deps)
      if (products === null) {
        out.push(file)
        continue
      }
      for (const product of products) {
        out.push(product)
        sourceOf.set(product.path, file.path)
      }
    } catch {
      out.push(file)
    }
  }
  return { files: out, sourceOf }
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/invoicePdfSplitter.test.ts --config vitest.config.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 格式化、lint、typecheck**

```bash
./node_modules/.bin/oxfmt src/main/documents/invoicePdfSplitter.ts test/main/documents/invoicePdfSplitter.test.ts
./node_modules/.bin/oxlint src/main/documents/invoicePdfSplitter.ts test/main/documents/invoicePdfSplitter.test.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
```
Expected: 0 警告 0 错误；tsc exit 0

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/invoicePdfSplitter.ts test/main/documents/invoicePdfSplitter.test.ts
git commit -m "feat(documents): invoice pdf splitter core"
```

---

### Task 2: pdf-lib 逐页拆分适配器（字节确定性）

**Files:**
- Create: `src/main/file/adapters/pdfPageSplitter.ts`
- Test: `test/main/file/pdfPageSplitter.test.ts`（目录新建，vitest include 为 `test/main/**` 已覆盖）

**Interfaces:**
- Consumes: `pdf-lib` 的 `PDFDocument`（Task 内安装）
- Produces:
  - `export async function splitPdfPagesToFile(filePath: string, outDir: string): Promise<string[]>`（返回按页序的单页 PDF 产物路径，命名 `p{n}.pdf`）

- [ ] **Step 1: 安装 pdf-lib**

```bash
pnpm add pdf-lib
```
若 pnpm shim 报 store 路径错误：先试 `pnpm add pdf-lib`（add 走主 CLI，可能不受 exec shim 影响）；仍失败则 **BLOCKED 上报**，不得改用 npm（会破坏 pnpm-lock.yaml）。

- [ ] **Step 2: 写失败测试**

```ts
// test/main/file/pdfPageSplitter.test.ts
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { splitPdfPagesToFile } from '@/file/adapters/pdfPageSplitter'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

let baseDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'pdf-split-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

// 两页源 PDF fixture（pdf-lib 生成；本测试只验证拆分行为，不做中文文本层断言）
async function createTwoPagePdf(target: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage()
    page.drawText(`invoice page ${i}`, { x: 40, y: 700, size: 24, font })
  }
  await writeFile(target, await doc.save())
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('splitPdfPagesToFile', () => {
  it('两页源 PDF → 两个单页产物 p1.pdf / p2.pdf，各自可加载且页数为 1', async () => {
    const src = path.join(baseDir, 'src.pdf')
    await createTwoPagePdf(src)
    const outDir = path.join(baseDir, 'out1')
    const products = await splitPdfPagesToFile(src, outDir)
    expect(products).toEqual([path.join(outDir, 'p1.pdf'), path.join(outDir, 'p2.pdf')])
    for (const product of products) {
      const doc = await PDFDocument.load(await readFile(product))
      expect(doc.getPageCount()).toBe(1)
    }
  })

  it('字节确定性：同一源页两次拆分产物哈希一致（元数据固定 epoch）', async () => {
    const src = path.join(baseDir, 'src.pdf')
    await createTwoPagePdf(src)
    const a = await splitPdfPagesToFile(src, path.join(baseDir, 'det-a'))
    const b = await splitPdfPagesToFile(src, path.join(baseDir, 'det-b'))
    expect(sha256(await readFile(a[0]!))).toBe(sha256(await readFile(b[0]!)))
    expect(sha256(await readFile(a[1]!))).toBe(sha256(await readFile(b[1]!)))
  })
})
```

- [ ] **Step 3: 运行确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/file/pdfPageSplitter.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

```ts
// src/main/file/adapters/pdfPageSplitter.ts
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

/**
 * 逐页导出单页 PDF：产物不携带可变元数据（创建/修改时间固定为 epoch），
 * 同一源页的产物字节确定 → 内容哈希（sha256File）可复现，去重按发票页粒度生效。
 */
export async function splitPdfPagesToFile(filePath: string, outDir: string): Promise<string[]> {
  const src = await PDFDocument.load(await readFile(filePath))
  const products: string[] = []
  for (let i = 0; i < src.getPageCount(); i++) {
    const doc = await PDFDocument.create()
    doc.setCreationDate(new Date(0))
    doc.setModificationDate(new Date(0))
    const [page] = await doc.copyPages(src, [i])
    doc.addPage(page)
    const target = path.join(outDir, `p${i + 1}.pdf`)
    await writeFile(target, await doc.save())
    products.push(target)
  }
  return products
}
```

- [ ] **Step 5: 运行确认 GREEN + 格式化 + lint + typecheck**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/file/pdfPageSplitter.test.ts --config vitest.config.ts`
Expected: PASS

```bash
./node_modules/.bin/oxfmt src/main/file/adapters/pdfPageSplitter.ts test/main/file/pdfPageSplitter.test.ts
./node_modules/.bin/oxlint src/main/file/adapters/pdfPageSplitter.ts test/main/file/pdfPageSplitter.test.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
```

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/file/adapters/pdfPageSplitter.ts test/main/file/pdfPageSplitter.test.ts
git commit -m "feat(documents): per-page pdf splitting"
```

---

### Task 3: autoWatch 展开支持（expandFiles 依赖 + 源文件登记）

**Files:**
- Modify: `src/main/documents/autoWatch.ts`（`AutoWatchDeps` 接口 + `runOnce` 登记逻辑）
- Test: `test/main/documents/autoWatch.test.ts`（追加用例）

**Interfaces:**
- Consumes: `expandSubmissionFiles` 的返回形状 `ExpandedSubmission`（Task 1）
- Produces:
  - `AutoWatchDeps` 新增可选成员：`expandFiles?: (files: DocumentExtractFileInput[]) => Promise<{ files: DocumentExtractFileInput[]; sourceOf: Map<string, string> }>`
  - 语义变更（仅当注入 expandFiles 且源文件被拆分时）：源文件登记 watched `{ taskId: null }`；未拆分文件的登记行为与现状完全一致

- [ ] **Step 1: 写失败测试**（追加到 `test/main/documents/autoWatch.test.ts` 既有 describe 内，沿用该文件 `makeDeps(overrides)` 桩风格：`Object.assign` 覆盖、内存 watched、`deps as never`）

```ts
it('expandFiles 拆分源文件：提交产物、源文件按 null taskId 登记 watched 且下轮不重扫', async () => {
  const productFiles = [
    { path: 'C:/split/u1/p1.pdf', name: 'merged（第1张）.pdf', mimeType: 'application/pdf' },
    { path: 'C:/split/u1/p2.pdf', name: 'merged（第2张）.pdf', mimeType: 'application/pdf' }
  ]
  const sourceOf = new Map([
    ['C:/split/u1/p1.pdf', 'D:/scan/merged.pdf'],
    ['C:/split/u1/p2.pdf', 'D:/scan/merged.pdf']
  ])
  const deps = makeDeps({
    readdir: vi.fn(async () => [{ name: 'merged.pdf', isFile: () => true }]),
    expandFiles: vi.fn(async () => ({ files: productFiles, sourceOf }))
  })
  const s = new AutoWatchScheduler(deps as never)
  await s.runOnce()
  const submitted = deps.submit.mock.calls[0][0].files
  expect(submitted.map((f: { path: string }) => f.path)).toEqual([
    'C:/split/u1/p1.pdf',
    'C:/split/u1/p2.pdf'
  ])
  // 源文件登记 watched（taskId null），产物任务路径不参与登记
  expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(1)
  expect(deps.upsertWatchedFile).toHaveBeenCalledWith({
    path: 'D:/scan/merged.pdf',
    mtimeMs: 111,
    taskId: null,
    now: 1_000_000
  })
  // 第二轮：mtime 不变 → 不再提交
  await s.runOnce()
  expect(deps.submit).toHaveBeenCalledTimes(1)
})

it('expandFiles 拆分后全部产物被去重拦截：源文件仍登记 watched', async () => {
  const deps = makeDeps({
    readdir: vi.fn(async () => [{ name: 'merged.pdf', isFile: () => true }]),
    expandFiles: vi.fn(async () => ({
      files: [
        { path: 'C:/split/u1/p1.pdf', name: 'merged（第1张）.pdf', mimeType: 'application/pdf' },
        { path: 'C:/split/u1/p2.pdf', name: 'merged（第2张）.pdf', mimeType: 'application/pdf' }
      ],
      sourceOf: new Map([
        ['C:/split/u1/p1.pdf', 'D:/scan/merged.pdf'],
        ['C:/split/u1/p2.pdf', 'D:/scan/merged.pdf']
      ])
    })),
    submit: vi.fn(async () => ({
      tasks: [],
      duplicates: [{ path: 'C:/split/u1/p1.pdf' }, { path: 'C:/split/u1/p2.pdf' }]
    }))
  })
  const s = new AutoWatchScheduler(deps as never)
  await s.runOnce()
  expect(deps.upsertWatchedFile).toHaveBeenCalledTimes(1)
  expect(deps.upsertWatchedFile).toHaveBeenCalledWith({
    path: 'D:/scan/merged.pdf',
    mtimeMs: 111,
    taskId: null,
    now: 1_000_000
  })
})

it('未注入 expandFiles 时行为不变（回归）', async () => {
  const deps = makeDeps()
  const s = new AutoWatchScheduler(deps as never)
  await s.runOnce()
  expect(deps.expandFiles).toBeUndefined()
  expect(deps.submit.mock.calls[0][0].files[0].path).toBe('D:/scan/a.pdf')
})
```

- [ ] **Step 2: 运行确认 RED**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/autoWatch.test.ts --config vitest.config.ts`
Expected: 新用例 FAIL（expandFiles 未实现 / 登记逻辑未变）

- [ ] **Step 3: 实现 autoWatch 修改**

`AutoWatchDeps` 追加：

```ts
expandFiles?: (files: DocumentExtractFileInput[]) => Promise<{
  files: DocumentExtractFileInput[]
  sourceOf: Map<string, string>
}>
```

`runOnce` 中 `if (batch.length > 0) {` 块改为：

```ts
if (batch.length > 0) {
  const batchInputs = batch.map((f) => {
    const ext = path.extname(f.path).toLowerCase()
    return {
      path: f.path,
      name: path.basename(f.path),
      mimeType: MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
    }
  })
  // 多发票合并件在此展开为逐页产物；未注入 expandFiles 或未命中拆分时原样透传
  const expanded = this.deps.expandFiles
    ? await this.deps.expandFiles(batchInputs)
    : { files: batchInputs, sourceOf: new Map<string, string>() }
  const { tasks, duplicates } = await this.deps.submit({
    files: expanded.files,
    source: 'scheduled'
  })
  // submit 返回按文件 1:1 产出任务；内容去重拦截的文件以 duplicates 报告。
  // 被拆分的源文件：产物已各自提交/拦截，源文件按 null taskId 登记 watched，
  // mtime 不变即不再重扫；未拆分文件维持按 filePath zip 的既有登记逻辑。
  const taskIdByPath = new Map(tasks.map((t) => [t.filePath, t.id]))
  const dupPaths = new Set(duplicates.map((d) => d.path))
  const splitSources = new Set([...expanded.sourceOf.values()].map((p) => path.normalize(p)))
  batch.forEach((f) => {
    if (splitSources.has(path.normalize(f.path))) {
      this.deps.upsertWatchedFile({
        path: f.path,
        mtimeMs: f.mtimeMs,
        taskId: null,
        now: now()
      })
      return
    }
    const taskId = taskIdByPath.get(f.path) ?? null
    if (taskId === null && !dupPaths.has(f.path)) return
    this.deps.upsertWatchedFile({
      path: f.path,
      mtimeMs: f.mtimeMs,
      taskId,
      now: now()
    })
  })
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents/autoWatch.test.ts --config vitest.config.ts`
Expected: 新旧用例全部 PASS（既有用例不得回归——未注入 expandFiles 时行为不变）

- [ ] **Step 5: 格式化、lint、typecheck、Commit**

```bash
./node_modules/.bin/oxfmt src/main/documents/autoWatch.ts test/main/documents/autoWatch.test.ts
./node_modules/.bin/oxlint src/main/documents/autoWatch.ts test/main/documents/autoWatch.test.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/main/documents/autoWatch.ts test/main/documents/autoWatch.test.ts
git commit -m "feat(documents): autowatch source registration"
```

---

### Task 4: composition 三路径接线（manual / scheduled / chat）

**Files:**
- Modify: `src/main/app/composition.ts`（imports、`documentsSplitDeps`、`documentsDedupeSubmit`、autoWatch 接线、`extractAndDraft`）
- Test: 无新测试文件（薄接线，行为由 Task 1/3 测试与既有 routes 套件覆盖）；回归运行既有套件

**Interfaces:**
- Consumes:
  - Task 1: `expandSubmissionFiles(files, deps): Promise<ExpandedSubmission>`、`InvoiceSplitDeps`
  - Task 2: `splitPdfPagesToFile(filePath, outDir): Promise<string[]>`
  - Task 3: `AutoWatchDeps.expandFiles`（可选成员）
  - 既有: `submitWithDedupe(documentsDedupeDeps, input)`、`submitChatFileWithDedupe(gateDeps, {file, source}, proceed)`、`PdfFileAdapter(filePath, maxFileSize).getAllPagesMarkdown(): Promise<string[] | undefined>`、`documentsMaxFileSize()`
- Produces: 三条路径的提交入口在提交收口前完成多发票展开（无新导出）

- [ ] **Step 1: imports（符号搜索确认是否已存在，缺则补）**

```ts
import { randomUUID } from 'node:crypto' // 若文件顶部尚未导入
import {
  expandSubmissionFiles,
  type InvoiceSplitDeps
} from '@/documents/invoicePdfSplitter'
import { splitPdfPagesToFile } from '@/file/adapters/pdfPageSplitter'
```
`PdfFileAdapter` / `fsp` / `path` / `app` 均已在 composition 使用，无需新增导入。

- [ ] **Step 2: documentsSplitDeps（插入在 `documentsDedupeDeps` 定义之前）**

```ts
// 多发票合并件拆分依赖：分页文本与现有文本提取同源（PdfFileAdapter，含 maxFileSize 保护），
// 产物落 userData/documents_split/<uuid>/，原文件绝不移动或删除。
const documentsSplitDeps: InvoiceSplitDeps = {
  extractPdfPagesText: async (filePath) => {
    const adapter = new PdfFileAdapter(filePath, documentsMaxFileSize())
    return (await adapter.getAllPagesMarkdown()) ?? null
  },
  splitPdfPages: (filePath, outDir) => splitPdfPagesToFile(filePath, outDir),
  makeWorkDir: async () => {
    const dir = path.join(app.getPath('userData'), 'documents_split', randomUUID())
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }
}
```

- [ ] **Step 3: manual 路径——documentsDedupeSubmit 先展开再收口**

将（符号搜索 `documentsDedupeSubmit`）：

```ts
const documentsDedupeSubmit: DocumentsDedupeSubmit = (input) =>
  submitWithDedupe(documentsDedupeDeps, input)
```

改为：

```ts
const documentsDedupeSubmit: DocumentsDedupeSubmit = async (input) => {
  // 多发票合并件先展开为逐页产物，再进内容去重收口（每张发票独立查表/登记）
  const { files } = await expandSubmissionFiles(input.files, documentsSplitDeps)
  return submitWithDedupe(documentsDedupeDeps, { ...input, files })
}
```

- [ ] **Step 4: scheduled 路径——autoWatch 注入 expandFiles**

在 `new AutoWatchScheduler({...})` 的 deps 中（`submit:` 之前或之后均可）追加：

```ts
expandFiles: (files) => expandSubmissionFiles(files, documentsSplitDeps),
```

- [ ] **Step 5: chat 路径——extractAndDraft 展开后循环闸门**

将 `extractAndDraft: async (input) => {` 的整个函数体（符号搜索 `extractAndDraft:`）替换为：

```ts
extractAndDraft: async (input) => {
  // chat 路径内容去重（手动/定时批量提交走 documents.tasks.create 的 submitWithDedupe）：
  // 多发票合并件先展开为逐页产物，每个产物独立过闸门（提取前查重、入库成功后登记）。
  const chatSource = input.source ?? 'chat'
  const gateDeps = {
    sha256File,
    findFileDedupeNames: (hashes: string[]) => documentsRepository.findFileDedupeNames(hashes),
    insertFileDedupes: (rows: FileDedupeRow[]) => documentsRepository.insertFileDedupes(rows),
    bindFileDedupeDocument: (taskId: string, documentId: string) =>
      documentsRepository.bindFileDedupeDocument(taskId, documentId)
  }
  const extractAndInsert = (file: DocumentExtractFileInput) =>
    submitChatFileWithDedupe(gateDeps, { file, source: chatSource }, async () => {
      const result = await documentExtractor.extract({
        templateId: input.templateId,
        file
      })
      const document = documentsRepository.insertDocument({
        templateId: result.template.id,
        typeKey: result.template.typeKey,
        templateSnapshot: result.template,
        fields: result.fields,
        fileUris: [file.path],
        source: chatSource,
        sessionId: input.sessionId ?? null,
        status: 'draft',
        now: Date.now()
      })
      return {
        documentId: document.id,
        document: {
          id: document.id,
          typeKey: document.typeKey,
          status: document.status,
          fields: document.fields,
          fileUris: document.fileUris
        },
        meta: {
          route: result.route,
          durationMs: result.durationMs,
          issues: result.issues
        }
      }
    })

  const { files: products, sourceOf } = await expandSubmissionFiles(
    [input.file],
    documentsSplitDeps
  )
  if (sourceOf.size === 0) {
    const outcome = await extractAndInsert(input.file)
    if (outcome.status === 'duplicate') return outcome
    return { status: 'ok', document: outcome.value.document, meta: outcome.value.meta }
  }
  // 多发票合并件：逐产物走闸门+提取；顺序=页序。首个命中去重的产物直接返回
  // duplicate（其后续产物本次不处理，与单文件拦截语义一致）；全部成功时返回
  // 首个文档并在 meta.issues 注明拆分事实（工具层契约零改动）。
  type ChatValue = {
    documentId: string
    document: { id: string; typeKey: string; status: string; fields: unknown; fileUris: string[] }
    meta: { route: string; durationMs: number; issues: string[] }
  }
  const issues: string[] = []
  let first: { document: ChatValue['document']; meta: ChatValue['meta'] } | null = null
  for (const product of products) {
    const outcome = await extractAndInsert(product)
    if (outcome.status === 'duplicate') return outcome
    const value: ChatValue = outcome.value
    if (first === null) {
      first = { document: value.document, meta: value.meta }
    } else {
      issues.push(`additional invoice recognized: ${value.documentId}`)
    }
  }
  if (first === null) {
    throw new Error('multi-invoice split produced no documents')
  }
  issues.push(`merged multi-invoice pdf split into ${products.length} documents`)
  return {
    status: 'ok',
    document: first.document,
    meta: { ...first.meta, issues: [...first.meta.issues, ...issues] }
  }
}
```

注意：`FileDedupeRow` 类型需从 `@/documents/contentDedupe` 导入（composition 若未导入则补）。`ChatValue` 的 `document` 形状以 `documentsRepository.insertDocument` 实际返回类型为准（含 id/typeKey/status/fields/fileUris），若 tsc 报形状不符则以仓库真实类型收窄/放宽，保证 typecheck 通过。

- [ ] **Step 6: 回归验证**

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents test/main/app --config vitest.config.ts
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
```
Expected: 既有全部 PASS（compositionBoundaries.test.ts 对 composition 源码的文本断言不得破坏）；tsc exit 0

- [ ] **Step 7: 格式化、lint、Commit**

```bash
./node_modules/.bin/oxfmt src/main/app/composition.ts
./node_modules/.bin/oxlint src/main/app/composition.ts
git add src/main/app/composition.ts
git commit -m "feat(documents): split wiring three paths"
```

---

### Task 5: 全量验证与收尾

**Files:**
- 无新文件；只读验证 + 文档状态更新

**Interfaces:**
- Consumes: 前 4 个任务的全部产出
- Produces: 验证报告 + spec 状态更新

- [ ] **Step 1: 全量主进程套件**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe ./node_modules/vitest/vitest.mjs run test/main/documents test/main/file test/main/app --config vitest.config.ts`
Expected: 全部 PASS（对比 ~98 既有失败基线，失败文件不得落入本次改动区域）

- [ ] **Step 2: typecheck:node + typecheck:web**

```bash
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false   # 必须 exit 0
./node_modules/.bin/vue-tsc --noEmit -p tsconfig.app.json --composite false          # OOM 则注明跳过
```

- [ ] **Step 3: 改动文件 lint 终检**

```bash
./node_modules/.bin/oxfmt src/main/documents/invoicePdfSplitter.ts src/main/file/adapters/pdfPageSplitter.ts src/main/documents/autoWatch.ts src/main/app/composition.ts
./node_modules/.bin/oxlint src/main/documents/invoicePdfSplitter.ts src/main/file/adapters/pdfPageSplitter.ts src/main/documents/autoWatch.ts src/main/app/composition.ts
```

- [ ] **Step 4: git 卫生检查**

`git status --porcelain` — 工作树干净（tsconfig.node.tsbuildinfo 变动不入库）。

- [ ] **Step 5: 人工 QA 清单（dev 实例，写进验证报告留待执行）**

1. 提交样本 `20261245w7878.pdf`（或任意两页各含一张发票号码的 PDF）→ 任务条出现 2 个任务「xxx（第1张）/（第2张）」，各自识别出对应发票字段
2. 同一合并包再次提交 → 两页均被弹窗拦截并提示 existingName
3. 同一张单页发票出现在另一合并包中提交 → 该页被拦截，另一页正常识别
4. autoWatch 监控目录放入合并件 → 下轮扫描产出 N 任务，源文件不再重扫；归档页收到 duplicates 通知（若重复）
5. 拆分后某页识别失败 → 单任务重试只影响该发票
6. chat 工具提交合并件 → 逐页提取，回复含拆分说明 issue

- [ ] **Step 6: spec 状态更新 + Commit**

将 `docs/superpowers/specs/2026-10-13-multi-invoice-pdf-split-design.md` 头部「状态」改为「已实施」。

```bash
git add docs/superpowers/specs/2026-10-13-multi-invoice-pdf-split-design.md
git commit -m "docs(documents): mark split spec implemented"
```
