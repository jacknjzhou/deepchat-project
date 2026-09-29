# 单据识别提速与精度提升 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 识别提速——只要配置了多模态模型就直接用多模态识别，未配置才回落本地 OCR；精度提升——发票识别与内置模板字段提取更准确。

**Architecture:** 不改动 OCR 集成架构（本地 OCR 保持为兜底路径）。速度侧：补齐"默认对话模型具备视觉能力即视为多模态可用"的推断、降低分类调用图片分辨率、提高任务并发。精度侧：提高提取用图片质量、增强分类与提取 prompt、增加字段格式与大写金额校验、解析失败自动重试一次。

**Tech Stack:** Electron 主进程 TS、Vitest（`--config vitest.config.ts`）、sharp、pnpm。

---

## 一、现状梳理（识别管线）

管线（提交后异步执行）：

```
提交文件(≤20) → RecognitionTaskManager (并发=2, taskManager.ts:42)
  → DocumentExtractor.extract (extractor/documentExtractor.ts:69)
      1. PDF → extractPdfText 取文本层 (composition.ts:2918, hasTextLayer=非空白≥200字符)
      2. templateId=auto → 分类 LLM 调用 (resolveTemplate:205-260)
           图片→vision 模型读图；PDF→text 模型读前4000字符；regex 解析 typeKey
      3. buildRoutePlan (:262-292) 决定路由：
           图片+auto:  有视觉模型 → vision；无 → ocr     ← 多模态优先已实现
           图片+text: 强制 ocr；图片+vision: vision
           PDF: 有文本层 → text；无文本层(扫描件) → ocr
           PDF+vision 模式: 直接抛错（但设置页 i18n 宣称"视觉模型直读图片与扫描件"）
           ⚠ PDF 任何情况下都不走 vision——扫描 PDF 只有本地 OCR 一条路
      4. vision 路由: ImageFileAdapter.getLLMContent
           sharp resize 1200×1200 + jpeg q70 (ImageFileAdapter.ts:76-86) → 1 次 LLM 调用
      5. ocr 路由: OcrRuntimeService.extractDocument (PaddleOCR v6 子进程,
           内容 hash 缓存; 首次冷启动: bundle 拷贝+模型加载+warmup)
           → splitTextIntoSegments → 每段串行 1 次 text LLM 调用 → merge
      6. parseModelOutput (fieldValidator.ts:135): 提取平衡 JSON 块 + 类型矫正
      7. validateTemplateRules (:194): 日期格式 / 金额守恒(仅当字段键齐全)
         → 只记 issues，不重试、不修正
```

### 速度瓶颈（按影响排序）

| # | 瓶颈 | 位置 |
|---|------|------|
| V1 | 视觉模型判定只看 `defaultVisionModel` 设置/agent visionModel。用户只把多模态模型设为**默认对话模型**时被判"未配置视觉模型"→ 图片走慢速本地 OCR | composition.ts:2884-2896 |
| V2 | auto 分类与提取共 2 次串行多模态调用；分类不需要高清图但与提取同样传 1200px 大图 | documentExtractor.ts:233 |
| V3 | 任务并发固定 2，多模态调用是网络 IO，可更高并行 | taskManager.ts:42 |

> 用户诉求"配置了多模态就直接用，未配置才 OCR"在 auto 路由**代码层已实现**（documentExtractor.ts:272-277），实际缺口是 V1 的能力判定过窄。

### 精度瓶颈

| # | 瓶颈 | 位置 |
|---|------|------|
| P1 | 提取图片压到 1200px/q70，发票小字（税号、明细行、金额大写）易丢失 | ImageFileAdapter.ts:76-86 |
| P2 | 分类 prompt 只列 `typeKey: name`，无类目与字段差异 → 专票/普票易混 | promptBuilder.ts:86 |
| P3 | 提取 prompt 无输出示例、无发票专项指引（号码位数、税率、大写金额、印章遮挡） | promptBuilder.ts:27-56 |
| P4 | 校验缺失：发票字段格式（号码位数、税号、税率）未校验；大写金额与合计金额不一致无交叉校验 | fieldValidator.ts:194 |
| P5 | 输出解析失败或必填字段全空时直接返回 issue，不重试 | documentExtractor.ts:103/126 |
| P6 | **扫描 PDF 只有本地 OCR 一条路**（bounded-960 低分辨率策略）；vision 模式对 PDF 直接抛错，与设置页"视觉模型直读图片与扫描件"的承诺不符 | documentExtractor.ts:280-289 |
| P7 | 提取 prompt 缺少通用逐字段核对要求——自定义模板（无发票专项提示、无内置校验规则）的提取精度依赖字段 hint 措辞，无兜底约束 | promptBuilder.ts:27-56 |

### 方案总览

| 任务 | 解决 | 覆盖范围 |
|------|------|---------|
| Task 1 图片压缩参数化(2048/85) | P1 | 图片单据（内置+自定义模板共用管线） |
| Task 2 视觉能力推断兜底 | V1 | 图片+扫描 PDF 路由的前置条件 |
| Task 3 分类 detail:low + 分类 prompt 增强 | V2+P2 | 全部模板（含自定义） |
| Task 4 提取 prompt 增强（发票专项+输出示例+通用逐字段要求） | P3+P7 | 发票类专项；通用要求覆盖**自定义模板** |
| Task 5 字段格式校验 + 大写金额交叉校验 | P4 | 含已知字段 key 的模板 |
| Task 6 解析失败重试一次 | P5 | 全部模板与全部路由 |
| Task 7 任务并发 2→4 | V3 | 全部 |
| Task 8 PDF 页渲染模块（新依赖 pdf-to-img） | P6 前置 | 扫描 PDF |
| Task 9 PDF vision 混合路由 | P6 | 扫描 PDF：vision 优先、OCR 兜底、vision 模式不再抛错 |
| Task 10 全量校验收尾 | — | — |

**非目标（明确不做）：** 合并分类与提取为单次调用（prompt 组合爆炸）；不改动 OCR 集成架构与本地 OCR 路径本身——`PDF_OCR_STRATEGY`（bounded-960）与 OCR artifact 缓存契约硬绑定（documentTextExtractionService.ts:299/548），属 OCR 架构范围，保持不动；OCR 继续作为扫描 PDF/图片在无多模态模型时的兜底路径。

**通用约定：**
- 主进程测试命令：`pnpm exec vitest run <files> --config vitest.config.ts`（本计划不触碰 sqlite，无需 ELECTRON_RUN_AS_NODE）。
- 若测试文件触碰真实临时文件，须在文件顶部 `vi.unmock('fs')` / `vi.unmock('node:fs')` / `vi.unmock('path')` / `vi.unmock('node:path')`（test/setup.ts 全局 mock 了 fs/path）。
- 代码风格 Oxfmt：单引号、无分号、100 列。Conventional Commits ≤50 字符。

---

### Task 1: 图片压缩参数化（提取用 2048/85）

**Files:**
- Modify: `src/main/file/adapters/ImageFileAdapter.ts`
- Modify: `src/main/app/composition.ts:2910-2917`（readImageAsDataUrl）
- Test: `test/main/file/adapters/imageFileAdapter.test.ts`（新建）

聊天等其他调用方不传参数 → 默认 1200/70，行为不变；仅单据识别用高质量参数。

- [ ] **Step 1: 写失败测试**

```ts
// test/main/file/adapters/imageFileAdapter.test.ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { ImageFileAdapter } from '@/file/adapters/ImageFileAdapter'

describe('ImageFileAdapter.getLLMContent', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'img-adapter-'))
    filePath = path.join(dir, 'sample.png')
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: 'white' }
    })
      .png()
      .toFile(filePath)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const decoded = async (dataUrl: string) =>
    sharp(Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, '')))

  it('defaults to 1200px and jpeg quality compatible output', async () => {
    const adapter = new ImageFileAdapter(filePath, 30 * 1024 * 1024)
    const dataUrl = await adapter.getLLMContent()
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    const meta = await decoded(dataUrl!).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1200)
  })

  it('accepts higher maxDimension and quality for document extraction', async () => {
    const adapter = new ImageFileAdapter(filePath, 30 * 1024 * 1024)
    const dataUrl = await adapter.getLLMContent({ maxDimension: 2048, jpegQuality: 85 })
    const meta = await decoded(dataUrl!).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(2048)
  })

  it('returns undefined when file exceeds maxFileSize', async () => {
    const adapter = new ImageFileAdapter(filePath, 10)
    expect(await adapter.getLLMContent()).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/file/adapters/imageFileAdapter.test.ts --config vitest.config.ts`
Expected: FAIL — `getLLMContent({ maxDimension })` 类型报错/选项未生效（2048 断言失败）。

- [ ] **Step 3: 实现**

`ImageFileAdapter.ts` 中 `getLLMContent` 改为：

```ts
export interface LlmContentOptions {
  maxDimension?: number
  jpegQuality?: number
}

public async getLLMContent(options: LlmContentOptions = {}): Promise<string | undefined> {
  const { maxDimension = 1200, jpegQuality = 70 } = options
  const stats = await fs.stat(this.filePath)
  if (stats.size > this.maxFileSize) {
    return undefined
  }

  await this.extractImageMetadata()

  const compressedImage = sharp(this.filePath)
    .resize(maxDimension, maxDimension, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: jpegQuality, mozjpeg: true })
  this.imageMetadata.compressWidth = (await compressedImage.metadata()).width ?? this.imageMetadata.width
  this.imageMetadata.compressHeight =
    (await compressedImage.metadata()).height ?? this.imageMetadata.height

  const buffer = await compressedImage.toBuffer()
  const base64ImageString = buffer.toString('base64')
  return `data:image/jpeg;base64,${base64ImageString}`
}
```

`composition.ts` 的 `readImageAsDataUrl`（:2910）改为：

```ts
readImageAsDataUrl: async (filePath) => {
  const adapter = new ImageFileAdapter(filePath, documentsMaxFileSize())
  const dataUrl = await adapter.getLLMContent({ maxDimension: 2048, jpegQuality: 85 })
  if (!dataUrl) {
    throw new Error(`failed to read image for vision extraction: ${filePath}`)
  }
  return dataUrl
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/file/adapters/imageFileAdapter.test.ts --config vitest.config.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/main/file/adapters/ImageFileAdapter.ts src/main/app/composition.ts test/main/file/adapters/imageFileAdapter.test.ts
git commit -m "feat(documents): higher quality image for extraction"
```

---

### Task 2: 视觉能力推断兜底（默认模型是多模态则直接用）

**Files:**
- Create: `src/main/documents/extractor/visionTarget.ts`
- Modify: `src/main/app/composition.ts:2884-2896`（resolveVisionTarget）
- Test: `test/main/documents/extractor/visionTarget.test.ts`（新建）

纯决策逻辑抽为可测函数；composition 负责取候选与查询能力。

- [ ] **Step 1: 写失败测试**

```ts
// test/main/documents/extractor/visionTarget.test.ts
import { describe, expect, it } from 'vitest'
import { pickVisionTarget } from '@/documents/extractor/visionTarget'

const T = (id: string) => ({ providerId: `${id}-provider`, modelId: `${id}-model` })

describe('pickVisionTarget', () => {
  it('prefers the explicit vision setting', async () => {
    const target = await pickVisionTarget({
      explicitVision: T('explicit'),
      agentVision: T('agent'),
      textTarget: T('text'),
      isVisionCapable: async () => true
    })
    expect(target).toEqual(T('explicit'))
  })

  it('falls back to the agent vision model', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: T('agent'),
      textTarget: T('text'),
      isVisionCapable: async () => true
    })
    expect(target).toEqual(T('agent'))
  })

  it('uses the default text model when it is vision-capable', async () => {
    const capable: string[] = ['text']
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: T('text'),
      isVisionCapable: async (t) => capable.includes(t.modelId)
    })
    expect(target).toEqual(T('text'))
  })

  it('returns null when nothing is vision-capable', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: T('text'),
      isVisionCapable: async () => false
    })
    expect(target).toBeNull()
  })

  it('returns null without a text target', async () => {
    const target = await pickVisionTarget({
      explicitVision: null,
      agentVision: null,
      textTarget: null,
      isVisionCapable: async () => true
    })
    expect(target).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractor/visionTarget.test.ts --config vitest.config.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/main/documents/extractor/visionTarget.ts
import type { ModelTarget } from './documentExtractor'

export interface VisionTargetCandidates {
  explicitVision: ModelTarget | null
  agentVision: ModelTarget | null
  textTarget: ModelTarget | null
  isVisionCapable: (target: ModelTarget) => Promise<boolean>
}

/**
 * Resolve the vision model for document extraction, most explicit first.
 * When no dedicated vision model is configured, accept the default text
 * model if it advertises vision capability, so images go to the multimodal
 * model instead of falling back to local OCR.
 */
export async function pickVisionTarget(
  candidates: VisionTargetCandidates
): Promise<ModelTarget | null> {
  if (candidates.explicitVision) return candidates.explicitVision
  if (candidates.agentVision) return candidates.agentVision
  if (candidates.textTarget && (await candidates.isVisionCapable(candidates.textTarget))) {
    return candidates.textTarget
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractor/visionTarget.test.ts --config vitest.config.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: composition 接线**

能力查询 API 已确认：`providerSettings.getProviderModels(providerId): MODEL_META[]`，
`MODEL_META.vision?: boolean`（src/main/provider/settings.ts:251、src/shared/types/provider.ts:60）。
在 `composition.ts` 顶部 import 处补充 `pickVisionTarget`（来自 `@/documents/extractor/visionTarget`）。

将 `resolveVisionTarget`（:2884-2896）整体替换为：

```ts
resolveVisionTarget: async () => {
  const selection = providerSettings.getSetting<{ providerId: string; modelId: string }>(
    'defaultVisionModel'
  )
  const agentConfig = await agentSettings.getDeepChatAgentConfig(BUILTIN_DEEPCHAT_AGENT_ID)
  const visionModel = agentConfig?.visionModel
  const textSelection = providerSettings.getSetting<{ providerId: string; modelId: string }>(
    'defaultModel'
  )
  const mainModel = agentConfig?.defaultModelPreset
  const textTarget =
    textSelection?.providerId && textSelection?.modelId
      ? { providerId: textSelection.providerId, modelId: textSelection.modelId }
      : mainModel?.providerId && mainModel?.modelId
        ? { providerId: mainModel.providerId, modelId: mainModel.modelId }
        : null
  return pickVisionTarget({
    explicitVision:
      selection?.providerId && selection?.modelId
        ? { providerId: selection.providerId, modelId: selection.modelId }
        : null,
    agentVision:
      visionModel?.providerId && visionModel?.modelId
        ? { providerId: visionModel.providerId, modelId: visionModel.modelId }
        : null,
    textTarget,
    isVisionCapable: async ({ providerId, modelId }) => {
      try {
        const model = providerSettings.getProviderModels(providerId).find((m) => m.id === modelId)
        return model?.vision === true
      } catch {
        return false
      }
    }
  })
}
```

> `resolveTextTarget`（:2897-2909）保持不变。

- [ ] **Step 6: 回归既有测试**

Run: `pnpm exec vitest run test/main/documents --config vitest.config.ts`
Expected: PASS（composition 无既有直测；extractor 路由测试不受影响——`resolveVisionTarget` 返回值语义不变）。

- [ ] **Step 7: Commit**

```bash
git add src/main/documents/extractor/visionTarget.ts src/main/app/composition.ts test/main/documents/extractor/visionTarget.test.ts
git commit -m "feat(documents): vision-capable default model fallback"
```

---

### Task 3: 分类调用提速 + 分类 prompt 增强

**Files:**
- Modify: `src/main/documents/extractor/documentExtractor.ts:233`（detail 'auto'→'low'）
- Modify: `src/main/documents/extractor/promptBuilder.ts:77-91`（buildClassificationPrompts）
- Test: `test/main/documents/extractorService.test.ts`、`test/main/documents/extractorPrompt.test.ts`

分类只判断类型，低分辨率图足够 → 更快；prompt 加入类目与字段差异 → 专票/普票可区分。

- [ ] **Step 1: 写失败测试（prompt 部分，加到 extractorPrompt.test.ts）**

```ts
describe('buildClassificationPrompts', () => {
  it('includes category and distinguishing field keys per template', () => {
    const templates = [
      makeTemplate({ typeKey: 'invoice_special', name: '增值税专用发票', category: '发票类',
        fields: [{ key: 'buyer_bank' }, { key: 'checker' }] }),
      makeTemplate({ typeKey: 'invoice_general', name: '普通发票', category: '发票类',
        fields: [{ key: 'seller_name' }] })
    ]
    const { user } = buildClassificationPrompts(templates)
    expect(user).toContain('invoice_special（发票类）: 增值税专用发票')
    expect(user).toContain('典型字段: buyer_bank, checker')
    expect(user).toContain('invoice_general（发票类）: 普通发票')
  })
})
```

（`makeTemplate` 复用该测试文件已有的模板构造 helper；若字段构造需要 valueType/order，与现有 helper 保持一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts --config vitest.config.ts`
Expected: FAIL — user prompt 不含类目/典型字段。

- [ ] **Step 3: 实现 promptBuilder**

`buildClassificationPrompts` 替换为：

```ts
export function buildClassificationPrompts(templates: DocumentTemplate[]): {
  system: string
  user: string
} {
  const system = [
    '你是单据类型分类助手。根据给定的单据内容，从候选类型中选出最匹配的一个。',
    '注意区分字段集合不同但名称相近的类型，以单据上实际出现的字段和版式为准。',
    '只输出一个 JSON 对象：{ "typeKey": "<选中的typeKey>" }，不要输出任何其他文字。'
  ].join('\n')

  const catalog = templates
    .map((template) => {
      const keys = template.fields
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((field) => field.key)
        .join(', ')
      return `- ${template.typeKey}（${template.category}）: ${template.name}；典型字段: ${keys}`
    })
    .join('\n')

  const user = ['候选类型清单：', catalog, '', '请判断这份单据属于哪个类型。'].join('\n')

  return { system, user }
}
```

- [ ] **Step 4: 实现 detail low（documentExtractor.ts:226-236 分类分支）**

分类消息中 image_url 的 `detail: 'auto'` 改为 `detail: 'low'`（仅 `resolveTemplate` 内；提取分支 :92 保持 `'auto'`）。

- [ ] **Step 5: 更新/确认 extractorService 测试**

若 `extractorService.test.ts` 既有断言分类 image detail 为 `'auto'`，改为 `'low'`；再补一条断言：提取消息的 detail 仍为 `'auto'`。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts test/main/documents/extractorService.test.ts --config vitest.config.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/main/documents/extractor/documentExtractor.ts src/main/documents/extractor/promptBuilder.ts test/main/documents/extractorPrompt.test.ts test/main/documents/extractorService.test.ts
git commit -m "feat(documents): sharper classification prompts and payload"
```

---

### Task 4: 提取 prompt 增强（发票专项 + 输出示例）

**Files:**
- Modify: `src/main/documents/extractor/promptBuilder.ts:27-56`（buildExtractionSystemPrompt）
- Test: `test/main/documents/extractorPrompt.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('buildExtractionSystemPrompt enhancements', () => {
  it('appends invoice guidance for invoice-category templates', () => {
    const template = makeTemplate({ category: '发票类', fields: [{ key: 'invoice_number' }] })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('发票类专项提示')
    expect(system).toContain('发票号码通常为 8 位数字（全电发票为 20 位）')
    expect(system).toContain('价税合计需与"金额大写"一致')
  })

  it('does not append invoice guidance for other categories', () => {
    const template = makeTemplate({ category: '合同类', fields: [{ key: 'party_a' }] })
    expect(buildExtractionSystemPrompt(template)).not.toContain('发票类专项提示')
  })

  it('includes a structural output example', () => {
    const template = makeTemplate({ category: '合同类', fields: [{ key: 'party_a' }] })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('输出示例')
    expect(system).toContain('"party_a"')
  })

  it('adds per-field grounding rules that also guard custom templates', () => {
    const template = makeTemplate({ category: '自定义', fields: [{ key: 'my_field' }] })
    const system = buildExtractionSystemPrompt(template)
    expect(system).toContain('通用提取要求')
    expect(system).toContain('字段提示（hint）是字段含义的权威定义')
    expect(system).toContain('禁止用常识或经验推断补全')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts --config vitest.config.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`buildExtractionSystemPrompt` 中，在"输出要求"之后、`promptPreset` 之前追加：

```ts
  const firstKey = template.fields.slice().sort((a, b) => a.order - b.order)[0]?.key
  if (firstKey) {
    parts.push(
      '',
      '输出示例（仅示意结构，值必须替换为单据实际内容，其余字段同样按清单逐个输出）：',
      `   { "fields": { "${firstKey}": "<该字段提取值>" }, "uncertain_fields": [] }`
    )
  }

  parts.push(
    '',
    '通用提取要求（适用于所有单据类型，包括自定义模板）：',
    '- 先逐个字段在单据内容中定位文字依据，再输出该字段的值。',
    '- 字段清单中的提示（hint）是字段含义的权威定义；单据内容与提示含义不符时不要硬套。',
    '- 单据上找不到明确依据的字段填 null 并加入 uncertain_fields；禁止用常识或经验推断补全。'
  )

  if (template.category === '发票类') {
    parts.push(
      '',
      '发票类专项提示：',
      '- 发票号码通常为 8 位数字（全电发票为 20 位），发票代码为 10 或 12 位数字，不要把两者混填。',
      '- 税率输出为如 13% 的形式；金额为纯数字，不要包含 ¥ 符号或千分位逗号。',
      '- 价税合计需与"金额大写"一致，若明显不一致，把相关金额字段加入 uncertain_fields。',
      '- 明细行逐行完整提取，不要省略、合并或概括行。',
      '- 印章遮挡、反光或打印模糊导致无法确认的字符不要猜测，相应字段加入 uncertain_fields。'
    )
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts --config vitest.config.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/promptBuilder.ts test/main/documents/extractorPrompt.test.ts
git commit -m "feat(documents): invoice-aware extraction prompts"
```

---

### Task 5: 字段格式校验 + 大写金额交叉校验

**Files:**
- Modify: `src/main/documents/extractor/fieldValidator.ts`
- Test: `test/main/documents/extractorValidator.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('chineseAmountToNumber', () => {
  it.each([
    ['叁万元整', 30000],
    ['壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分', 1234567.89],
    ['拾贰元', 12],
    ['人民币壹佰元整', 100],
    ['贰拾元零伍分', 20.05],
    ['壹拾元整', 10]
  ])('parses %s -> %d', (raw, expected) => {
    expect(chineseAmountToNumber(raw)).toBe(expected)
  })

  it('returns null for non-amount text', () => {
    expect(chineseAmountToNumber('abc')).toBeNull()
    expect(chineseAmountToNumber('')).toBeNull()
  })
})

describe('validateTemplateRules enhancements', () => {
  it('flags invoice_number with wrong digit count', () => {
    const template = makeTemplate({ fields: [makeField({ key: 'invoice_number' })] })
    const fields = { invoice_number: { value: '1234567', uncertain: false } }
    expect(validateTemplateRules(template, fields)).toContainEqual(
      expect.stringContaining('invoice_number')
    )
  })

  it('accepts 8 or 20 digit invoice_number', () => {
    const template = makeTemplate({ fields: [makeField({ key: 'invoice_number' })] })
    const fields = { invoice_number: { value: '24120000000123456789', uncertain: false } }
    expect(validateTemplateRules(template, fields)).toHaveLength(0)
  })

  it('flags buyer_tax_no shorter than 15 chars', () => {
    const template = makeTemplate({ fields: [makeField({ key: 'buyer_tax_no' })] })
    const fields = { buyer_tax_no: { value: '913301', uncertain: false } }
    expect(validateTemplateRules(template, fields)).toContainEqual(
      expect.stringContaining('buyer_tax_no')
    )
  })

  it('flags amount_upper that contradicts total_amount', () => {
    const template = makeTemplate({
      fields: [makeField({ key: 'total_amount' }), makeField({ key: 'amount_upper' })]
    })
    const fields = {
      total_amount: { value: 30000, uncertain: false },
      amount_upper: { value: '伍万元整', uncertain: false }
    }
    expect(validateTemplateRules(template, fields)).toContainEqual(
      expect.stringContaining('amount_upper does not match')
    )
  })

  it('passes when amount_upper matches total_amount', () => {
    const template = makeTemplate({
      fields: [makeField({ key: 'total_amount' }), makeField({ key: 'amount_upper' })]
    })
    const fields = {
      total_amount: { value: 30000, uncertain: false },
      amount_upper: { value: '叁万元整', uncertain: false }
    }
    expect(validateTemplateRules(template, fields)).toHaveLength(0)
  })
})
```

（复用该测试文件已有的 `makeTemplate`/`makeField` helper；若无则按 `src/shared/documents.ts` 的 `DocumentTemplate`/`DocumentTemplateField` 构造最小对象。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorValidator.test.ts --config vitest.config.ts`
Expected: FAIL — 函数不存在 / 校验未生效。

- [ ] **Step 3: 实现 fieldValidator**

新增：

```ts
const KNOWN_FIELD_VALIDATIONS: Record<string, RegExp> = {
  invoice_code: /^\d{10}$|^\d{12}$/,
  invoice_number: /^\d{8}$|^\d{20}$/,
  buyer_tax_no: /^[A-Z0-9]{15,20}$/,
  seller_tax_no: /^[A-Z0-9]{15,20}$/,
  tax_rate: /^(13|12|9|6|5|3|1|0)(\.\d+)?%$/
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9
}
const CN_SMALL_UNITS: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 }
const CN_BIG_UNITS: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

// 中文大写金额 → 数字；不支持的形式返回 null（不臆造）
export function chineseAmountToNumber(raw: string): number | null {
  const text = raw
    .trim()
    .replace(/^(人民币|￥|¥|（大写）|\(大写\))+/, '')
    .replace(/整$/, '')
  const [intRaw = '', decRaw = ''] = text.split(/[元圆]/)
  if (!intRaw && !decRaw) return null

  let total = 0
  let section = 0
  let pending = 0
  let seenDigit = false
  for (const char of intRaw) {
    const digit = CN_DIGITS[char]
    if (digit !== undefined) {
      pending = digit
      seenDigit = true
      continue
    }
    const small = CN_SMALL_UNITS[char]
    if (small !== undefined) {
      section += (pending || (seenDigit ? 0 : 1)) * small
      pending = 0
      continue
    }
    const big = CN_BIG_UNITS[char]
    if (big !== undefined) {
      section += pending
      total = (total + section) * big
      section = 0
      pending = 0
      continue
    }
    return null
  }
  if (!seenDigit) return null

  // 小数部分逐字符扫描：角=0.1 位、分=0.01 位，取其前最近的数字
  let fraction = 0
  let decPending = 0
  for (const char of decRaw) {
    const digit = CN_DIGITS[char]
    if (digit !== undefined) {
      decPending = digit
      continue
    }
    if (char === '角') {
      fraction += decPending * 0.1
      decPending = 0
    } else if (char === '分') {
      fraction += decPending * 0.01
      decPending = 0
    }
  }
  return Number((total + section + pending + fraction).toFixed(2))
}
```

解析对照：`叁万元整`→30000；`壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分`→1234567.89；`拾贰元`→12（拾遇无前置数字按 1 计）；`贰拾元零伍分`→20.05；无法解析返回 null。

在 `validateTemplateRules` 的字段循环内，紧接既有 `field.validation` 处理之后加已知格式校验：

```ts
    const knownPattern = KNOWN_FIELD_VALIDATIONS[field.key]
    if (!field.validation && knownPattern && typeof value === 'string' && value.length > 0) {
      if (!knownPattern.test(value)) {
        issues.push(`${field.key}: known format validation failed`)
      }
    }
```

在 `matchesAmountConservation` 块之后追加金额大写交叉校验（复用同一 `totalKey` 探测逻辑）：

```ts
  const upperEntry = fields['amount_upper']
  const upperValue = typeof upperEntry?.value === 'string' ? upperEntry.value : null
  const upperTotalKey = AMOUNT_CONSERVATION_TOTAL_KEYS.find((key) => key in fields)
  if (upperValue && upperTotalKey) {
    const upper = chineseAmountToNumber(upperValue)
    const total = asNumber(fields[upperTotalKey])
    if (upper !== null && total !== null && Math.abs(upper - total) > AMOUNT_TOLERANCE) {
      issues.push(`amount_upper does not match ${upperTotalKey}`)
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorValidator.test.ts --config vitest.config.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/fieldValidator.ts test/main/documents/extractorValidator.test.ts
git commit -m "feat(documents): invoice field and amount validation"
```

---

### Task 6: 解析失败自动重试一次

**Files:**
- Modify: `src/main/documents/extractor/documentExtractor.ts`（extract 内 vision 与单段文本分支）
- Test: `test/main/documents/extractorService.test.ts`

触发条件（二者其一）：`model output is not valid JSON`；或全部必填字段值为 null。分段路由（长文本）不重试，控制成本。

- [ ] **Step 1: 写失败测试**

```ts
describe('extraction retry on unparsable output', () => {
  it('retries once and uses the better result when first output is invalid JSON', async () => {
    const goodJson = JSON.stringify({
      fields: { party_a: '甲公司' },
      uncertain_fields: []
    })
    const calls: any[] = []
    const extractor = makeExtractor({
      generateCompletion: async (input) => {
        calls.push(input)
        return calls.length === 1 ? '抱歉，我无法输出 JSON' : goodJson
      }
    })
    const result = await extractor.extract({ templateId: 't1', file: imageFile })
    expect(calls).toHaveLength(2)
    expect(result.fields.party_a.value).toBe('甲公司')
    expect(result.issues).not.toContain('model output is not valid JSON')
  })

  it('does not retry when first output parses fine', async () => {
    let calls = 0
    const extractor = makeExtractor({
      generateCompletion: async () => {
        calls += 1
        return JSON.stringify({ fields: { party_a: '甲公司' }, uncertain_fields: [] })
      }
    })
    await extractor.extract({ templateId: 't1', file: imageFile })
    expect(calls).toBe(1)
  })

  it('keeps the first result when retry is not better', async () => {
    const calls: string[] = []
    const extractor = makeExtractor({
      generateCompletion: async () => {
        calls.push('x')
        return calls.length === 1 ? '不是JSON' : '也不是JSON'
      }
    })
    const result = await extractor.extract({ templateId: 't1', file: imageFile })
    expect(calls).toHaveLength(2)
    expect(result.issues).toContain('model output is not valid JSON')
  })
})
```

（`makeExtractor`/`imageFile` 复用该测试文件既有 helper；vision 路由模板。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts --config vitest.config.ts`
Expected: FAIL — 只调用了一次 / 无重试。

- [ ] **Step 3: 实现**

在 `DocumentExtractor` 类内新增私有方法：

```ts
  private scoreParsed(template: DocumentTemplate, parsed: ParsedModelOutput): number {
    const filledRequired = template.fields.filter(
      (field) => field.required && parsed.fields[field.key]?.value !== null
    ).length
    return filledRequired * 100 - parsed.issues.length
  }

  private async completeWithRetry(
    template: DocumentTemplate,
    messages: ChatMessage[],
    target: ModelTarget
  ): Promise<string> {
    const request = { providerId: target.providerId, modelId: target.modelId }
    const first = await this.deps.generateCompletion({
      ...request,
      messages,
      temperature: EXTRACT_TEMPERATURE,
      maxTokens: EXTRACT_MAX_TOKENS
    })
    const firstParsed = parseModelOutput(first, template)
    const firstScore = this.scoreParsed(template, firstParsed)
    const hasRequiredGap = template.fields.some(
      (field) => field.required && firstParsed.fields[field.key]?.value === null
    )
    if (!firstParsed.issues.includes('model output is not valid JSON') && !hasRequiredGap) {
      return first
    }
    const retried = await this.deps.generateCompletion({
      ...request,
      messages: [
        ...messages,
        { role: 'assistant', content: first },
        {
          role: 'user',
          content:
            '上一次输出无法解析（不是合法 JSON）或必填字段全部缺失。请严格按系统提示重新输出一个完整的 JSON 对象，不要输出任何其他文字。'
        }
      ],
      temperature: EXTRACT_TEMPERATURE,
      maxTokens: EXTRACT_MAX_TOKENS
    })
    const retriedParsed = parseModelOutput(retried, template)
    return this.scoreParsed(template, retriedParsed) > firstScore ? retried : first
  }
```

vision 分支（:96-102）与单段文本分支（:119-125）中的 `generateCompletion` 调用替换为
`rawOutput = await this.completeWithRetry(template, messages, target)`。
需要在文件顶部 import 补充 `type ParsedModelOutput`（来自 `./fieldValidator`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts test/main/documents/extractorValidator.test.ts --config vitest.config.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/documentExtractor.ts test/main/documents/extractorService.test.ts
git commit -m "feat(documents): retry extraction on bad output"
```

---

### Task 7: 任务并发 2→4

**Files:**
- Modify: `src/main/documents/taskManager.ts:42`（DEFAULT_CONCURRENCY）
- Test: `test/main/documents/taskManager.test.ts`

- [ ] **Step 1: 检查并更新测试**

Read `test/main/documents/taskManager.test.ts`，找到并发行为断言（若断言 2 个并发上限则改为 4）；若测试通过 `deps.concurrency` 显式注入则无需改动，仅补一条默认并发断言：

```ts
it('defaults to concurrency 4', async () => {
  const manager = new RecognitionTaskManager({ repository, extractor, publishTaskUpdated })
  // 提交 5 个任务，观察同时 running 的峰值 ≤ 4 且 > 2
  // （复用该文件既有的 repository/extractor stub 构造方式）
})
```

- [ ] **Step 2: 实现**

```ts
const DEFAULT_CONCURRENCY = 4
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents --config vitest.config.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/main/documents/taskManager.ts test/main/documents/taskManager.test.ts
git commit -m "feat(documents): raise recognition concurrency to 4"
```

---

### Task 8: PDF 页渲染模块（扫描 PDF 走多模态的前置能力）

**Files:**
- Create: `src/main/file/adapters/pdfPageRenderer.ts`
- Modify: `package.json`（新增依赖 `pdf-to-img`）
- Test: `test/main/file/adapters/pdfPageRenderer.test.ts`（新建）

`pdf-to-img`（内部封装 pdfjs-dist + @napi-rs/canvas）把 PDF 每页渲染为 PNG；渲染后经 sharp 压缩为与 Task 1 相同参数的 JPEG dataURL。**打包注意**：`@napi-rs/canvas` 是原生模块，需确认 electron-builder 配置将其 asarUnpack（在 `package.json` 的 build 配置中检查现有 unpacked 列表，如 sharp 的处理方式）。

- [ ] **Step 1: 安装依赖**

```bash
pnpm add pdf-to-img
```

（确认安装版本 ≥4；其内部 pdfjs-dist 在 Node 无 worker 环境可运行。）

- [ ] **Step 2: 写失败测试**

渲染层（pdf-to-img）用 `vi.mock` 模拟（返回用 sharp 生成的真实 PNG buffer），只测编排逻辑：压缩参数、dataURL 构造、页数上限截断。

```ts
// test/main/file/adapters/pdfPageRenderer.test.ts
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

const renderPage = vi.fn()
const pdfMock = vi.fn(async () => ({ length: 2, renderPage }))
vi.mock('pdf-to-img', () => ({ pdf: pdfMock }))

import { PDF_VISION_MAX_PAGES, renderPdfPagesToDataUrls } from '@/file/adapters/pdfPageRenderer'

const makePng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: 'white' } }).png().toBuffer()

describe('renderPdfPagesToDataUrls', () => {
  beforeEach(() => {
    renderPage.mockReset()
    pdfMock.mockClear()
  })

  it('renders each page, compresses to jpeg dataURL within maxDimension', async () => {
    renderPage.mockImplementation(async (page: number) =>
      page === 1 ? makePng(2400, 1600) : makePng(800, 600)
    )
    const { dataUrls, pageCount } = await renderPdfPagesToDataUrls('/tmp/x.pdf')
    expect(pageCount).toBe(2)
    expect(dataUrls).toHaveLength(2)
    expect(dataUrls[0]).toMatch(/^data:image\/jpeg;base64,/)
    const meta = await sharp(
      Buffer.from(dataUrls[0].replace(/^data:image\/\w+;base64,/, ''), 'base64')
    ).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048)
  })

  it('truncates pages beyond PDF_VISION_MAX_PAGES and reports total pageCount', async () => {
    pdfMock.mockImplementation(async () => ({
      length: PDF_VISION_MAX_PAGES + 3,
      renderPage: async () => makePng(600, 400)
    }))
    const { dataUrls, pageCount } = await renderPdfPagesToDataUrls('/tmp/big.pdf')
    expect(pageCount).toBe(PDF_VISION_MAX_PAGES + 3)
    expect(dataUrls).toHaveLength(PDF_VISION_MAX_PAGES)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/file/adapters/pdfPageRenderer.test.ts --config vitest.config.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 4: 实现**

```ts
// src/main/file/adapters/pdfPageRenderer.ts
import { readFile } from 'node:fs/promises'

import { pdf } from 'pdf-to-img'
import sharp from 'sharp'

export const PDF_VISION_MAX_PAGES = 8
const PAGE_RENDER_SCALE = 2

export interface PdfPagesRenderResult {
  dataUrls: string[]
  pageCount: number
}

export async function renderPdfPagesToDataUrls(
  filePath: string,
  options: { maxPages?: number; maxDimension?: number; jpegQuality?: number } = {}
): Promise<PdfPagesRenderResult> {
  const { maxPages = PDF_VISION_MAX_PAGES, maxDimension = 2048, jpegQuality = 85 } = options
  const buffer = await readFile(filePath)
  const document = await pdf(buffer, { scale: PAGE_RENDER_SCALE })
  const pageCount = document.length
  const dataUrls: string[] = []
  for (let page = 1; page <= Math.min(pageCount, maxPages); page += 1) {
    const png = await document.renderPage(page)
    const jpeg = await sharp(png)
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer()
    dataUrls.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  }
  return { dataUrls, pageCount }
}
```

（若 `pdf-to-img` 实际导出的 API 形状与 `pdf(buffer, { scale })`/`document.length`/`document.renderPage(n)` 有出入，以所装版本的 README/类型定义为准做等价调整——编排逻辑不变。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/file/adapters/pdfPageRenderer.test.ts --config vitest.config.ts`
Expected: PASS（2 用例）。

- [ ] **Step 6: Commit**

```bash
git add src/main/file/adapters/pdfPageRenderer.ts package.json pnpm-lock.yaml test/main/file/adapters/pdfPageRenderer.test.ts
git commit -m "feat(documents): render pdf pages for vision"
```

---

### Task 9: PDF vision 混合路由（扫描 PDF 优先多模态，OCR 兜底）

**Files:**
- Modify: `src/main/documents/extractor/documentExtractor.ts`（deps、buildRoutePlan:280-289、extract vision 分支:83-105）
- Modify: `src/main/app/composition.ts`（extractPdfText 返回 pageCount、注入 renderPdfPages）
- Test: `test/main/documents/extractorService.test.ts`

路由语义变更：
- `auto` + 无文本层 PDF + vision 可用 + 页数 ≤ 8 → `vision`（逐页提取后合并）；否则 → `ocr`（兜底，含无 vision 模型、页数超限）。
- `vision` 模式 + PDF → 不再抛错，走 vision（渲染前 8 页，超出部分记 issue）——对齐设置页"视觉模型直读图片与扫描件"的既有承诺。
- `text` 路由、图片路由行为不变。

- [ ] **Step 1: 写失败测试（extractorService.test.ts 追加）**

```ts
describe('pdf vision routing', () => {
  it('routes scanned pdf to vision and merges per-page results', async () => {
    const pageJson = (page: number) =>
      JSON.stringify({ fields: { party_a: page === 1 ? '甲公司' : null }, uncertain_fields: [] })
    const calls: any[] = []
    const extractor = makeExtractor({
      extractPdfText: async () => ({ text: '', hasTextLayer: false, pageCount: 2 }),
      renderPdfPages: async () => ({ dataUrls: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'], pageCount: 2 }),
      resolveVisionTarget: async () => ({ providerId: 'p', modelId: 'm' }),
      generateCompletion: async (input) => {
        calls.push(input)
        const imageIndex = (input.messages[1].content as any[]).findIndex(
          (part: any) => part.type === 'image_url'
        )
        return pageJson(imageIndex + 1)
      }
    })
    const result = await extractor.extract({ templateId: 't1', file: pdfFile })
    expect(result.route).toBe('vision')
    expect(calls).toHaveLength(2)
    expect(result.fields.party_a.value).toBe('甲公司')
  })

  it('falls back to ocr for scanned pdf without a vision model', async () => {
    const extractor = makeExtractor({
      extractPdfText: async () => ({ text: '', hasTextLayer: false, pageCount: 1 }),
      extractOcrText: async () => '发票号码 12345678',
      resolveVisionTarget: async () => null,
      resolveTextTarget: async () => ({ providerId: 'p', modelId: 't' })
    })
    const result = await extractor.extract({ templateId: 't1', file: pdfFile })
    expect(result.route).toBe('ocr')
  })

  it('falls back to ocr when scanned pdf exceeds the vision page limit', async () => {
    const extractor = makeExtractor({
      extractPdfText: async () => ({ text: '', hasTextLayer: false, pageCount: 9 }),
      extractOcrText: async () => '发票号码 12345678',
      resolveVisionTarget: async () => ({ providerId: 'p', modelId: 'm' })
    })
    const result = await extractor.extract({ templateId: 't1', file: pdfFile })
    expect(result.route).toBe('ocr')
  })

  it('no longer throws for vision mode with a pdf', async () => {
    const extractor = makeExtractor({
      extractPdfText: async () => ({ text: '', hasTextLayer: false, pageCount: 1 }),
      renderPdfPages: async () => ({ dataUrls: ['data:image/jpeg;base64,AA'], pageCount: 1 }),
      resolveVisionTarget: async () => ({ providerId: 'p', modelId: 'm' }),
      generateCompletion: async () =>
        JSON.stringify({ fields: { party_a: '甲公司' }, uncertain_fields: [] })
    })
    const result = await extractor.extract({ templateId: 't1', file: pdfFile })
    expect(result.route).toBe('vision')
  })
})
```

（`makeExtractor`/`pdfFile` 复用该测试文件既有 helper；若 helper 尚无 `extractPdfText`/`extractOcrText` 缺省实现，按各用例显式传入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts --config vitest.config.ts`
Expected: FAIL — 无 renderPdfPages 依赖、vision 模式 PDF 抛错。

- [ ] **Step 3: 实现 extractor**

`DocumentExtractorDeps` 增加一项：

```ts
  renderPdfPages: (filePath: string) => Promise<{ dataUrls: string[]; pageCount: number }>
```

`extractPdfText` 的返回类型扩展为 `{ text: string; hasTextLayer: boolean; pageCount?: number }`
（可选字段，兼容既有调用与测试 stub）。

`buildRoutePlan` 的 PDF 分支（:280-289）替换为：

```ts
    if (isPdfFile(file)) {
      if (mode === 'vision') {
        return { route: 'vision' }
      }
      if (pdfText?.hasTextLayer) {
        return { route: 'text', text: pdfText.text }
      }
      const visionAvailable = (await this.deps.resolveVisionTarget()) !== null
      const withinPageLimit = (pdfText?.pageCount ?? 0) <= PDF_VISION_MAX_PAGES
      return visionAvailable && withinPageLimit ? { route: 'vision' } : { route: 'ocr' }
    }
```

（`PDF_VISION_MAX_PAGES` 从 `@/file/adapters/pdfPageRenderer` import。）

`extract` 的 vision 分支（:83-105）替换为支持多页：

```ts
    if (plan.route === 'vision') {
      const target = this.requireTarget(await this.deps.resolveVisionTarget(), 'defaultVisionModel')
      if (isPdfFile(input.file)) {
        const { dataUrls, pageCount } = await this.deps.renderPdfPages(input.file.path)
        if (pageCount > dataUrls.length) {
          issues.push(`pdf has ${pageCount} pages; only first ${dataUrls.length} processed by vision`)
        }
        const partials: Record<string, DocumentFieldEntry>[] = []
        for (let index = 0; index < dataUrls.length; index += 1) {
          if (input.signal?.aborted) {
            throw new Error('extraction aborted')
          }
          const messages: ChatMessage[] = [
            { role: 'system', content: buildExtractionSystemPrompt(template) },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    dataUrls.length > 1
                      ? `这是扫描件第 ${index + 1}/${dataUrls.length} 页。只提取本页出现的字段值；本页没有的字段填 null，后续页面会补充。`
                      : buildExtractionUserPrompt(template, null)
                },
                { type: 'image_url', image_url: { url: dataUrls[index], detail: 'auto' } }
              ]
            }
          ]
          const output = await this.completeWithRetry(template, messages, target)
          partials.push(parseModelOutput(output, template).fields)
          rawOutput += (rawOutput ? '\n---\n' : '') + output
        }
        fields = mergeSegmentOutputs(
          Object.fromEntries(
            template.fields.map((field) => [field.key, { value: null, uncertain: false }])
          ),
          partials
        )
        for (const field of template.fields) {
          const values = partials
            .map((partial) => partial[field.key]?.value)
            .filter((value) => value !== null && value !== undefined)
          const distinct = new Set(values.map((value) => JSON.stringify(value)))
          if (distinct.size > 1) {
            issues.push(`${field.key}: conflicting values across pages`)
            fields[field.key] = { ...(fields[field.key] ?? { value: null }), uncertain: true }
          }
        }
      } else {
        const dataUrl = await this.deps.readImageAsDataUrl(input.file.path)
        const messages: ChatMessage[] = [
          { role: 'system', content: buildExtractionSystemPrompt(template) },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildExtractionUserPrompt(template, null) },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
            ]
          }
        ]
        rawOutput = await this.completeWithRetry(template, messages, target)
        const parsed = parseModelOutput(rawOutput, template)
        fields = parsed.fields
        issues.push(...parsed.issues)
      }
    } else {
```

（`mergeSegmentOutputs` 已在文件顶部 import；`completeWithRetry` 来自 Task 6——若按任务顺序执行，Task 9 依赖 Task 6 已合入。）

- [ ] **Step 4: composition 接线**

`extractPdfText`（composition.ts:2918-2923）替换为：

```ts
      extractPdfText: async (filePath) => {
        const adapter = new PdfFileAdapter(filePath, documentsMaxFileSize())
        const pages = await adapter.getAllPagesMarkdown()
        const text = (pages ?? []).join('\n\n')
        return { text, hasTextLayer: text.replace(/\s/g, '').length >= 200, pageCount: pages?.length ?? 0 }
      },
      renderPdfPages: (filePath) => renderPdfPagesToDataUrls(filePath),
```

（顶部 import `renderPdfPagesToDataUrls`；若行宽超 100 列按 Oxfmt 拆行。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run test/main/documents --config vitest.config.ts`
Expected: PASS（含既有路由回归用例）。

- [ ] **Step 6: Commit**

```bash
git add src/main/documents/extractor/documentExtractor.ts src/main/app/composition.ts test/main/documents/extractorService.test.ts
git commit -m "feat(documents): vision route for scanned pdfs"
```

---

### Task 10: 全量校验收尾

- [ ] **Step 1: 全量校验**

```bash
pnpm run format
pnpm run i18n:check   # 若无 i18n 改动应通过（本计划无 renderer 文案变更）
pnpm run lint
pnpm run typecheck
pnpm exec vitest run test/main/documents test/main/file --config vitest.config.ts
```

Expected: 全部通过；test:main 存在的 ~98 个预存环境失败与本计划无关（对比失败文件列表，不涉及本计划触碰的文件即可）。

- [ ] **Step 2: 打包验证（可选但建议）**

`pnpm run build` 后确认 `@napi-rs/canvas`/`pdf-to-img` 相关原生模块在打包产物中可用（asarUnpack 生效）；若打包配置需调整，补充到 `package.json` build 配置并在本步骤提交。

---

## 验证清单（实现完成后）

1. `pnpm exec vitest run test/main/documents test/main/file --config vitest.config.ts` 全绿。
2. `pnpm run format && pnpm run lint && pnpm run typecheck` 通过。
3. 行为验证（手动，可选）：只配置默认对话模型为多模态模型（如 qwen-vl / glm-4v）→ 上传发票图片 → 任务 route 应为 `vision`（检查 documents.task.updated 事件或日志），而非本地 OCR。
4. 发票精度抽查：同一张含印章遮挡的发票图片，提取结果中遮挡字段应出现在 uncertain_fields 而非臆造值。
5. 扫描 PDF 验证（手动，可选）：上传扫描版发票 PDF → 配置了多模态模型时 route 应为 `vision` 且逐页提取合并；删除视觉模型配置后同一文件应回落 `ocr`。
