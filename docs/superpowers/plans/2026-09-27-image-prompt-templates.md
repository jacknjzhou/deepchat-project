# 图像生成提示词范本 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天输入区为支持图像生成的模型提供"提示词范本"能力：空态显示精选范本卡片、工具栏新增范本按钮打开弹层（精选 / 我的 两个 tab）。点击范本 = 填充提示词到输入框，并按"仅有值合并"策略合并图像参数（size / quality）到会话生成设置。"我的"范本支持在弹层内新建 / 编辑 / 删除（含删除确认），持久化到 config（key `user_image_prompt_templates`，上限 50 条，zod 校验，坏数据回退空列表）。

**Architecture:** 依据 spec（`docs/superpowers/specs/2026-09-27-image-prompt-templates-design.md`）分五层落地：① shared 契约（zod schema + config 路由白名单三接触点 + 主进程默认值）；② i18n 20 locale 文案（内置范本 7 条标题+提示词全部本地化）；③ renderer 数据层（内置范本常量 + pinia store，ConfigClient 在 store setup 内延迟实例化）；④ UI 组件（弹层管理面板 `ImagePromptTemplateButton`、空态卡片 `ImagePromptTemplateCards`）；⑤ 集成（ChatInputToolbar 以 `v-if="showImageTemplates"` 门控子组件保证现有测试零破坏；NewThreadPage 以 `model.type === 'imageGeneration'` 判定入口显隐与空态卡片）。

**Tech Stack:** zod（shared 契约校验）、pinia、vue-i18n、shadcn-vue（Popover / Tabs / Select / Input / Textarea / Label）、@dc-ui（DcButton / DcConfirmDialog）、nanoid、vitest + Vue Test Utils。

**执行前置须知：**
- 工作区可能有无关未提交改动。**每个 commit 只 add 本任务列出的文件**，绝不 `git add -A`。
- 仓库规范：Oxfmt（单引号/无分号/100 列）、Conventional Commits（`type(scope): subject` ≤50 字符）、无 AI 署名。提交前对涉及文件跑 `pnpm exec oxfmt <files>`（或最后统一 `pnpm format`）。
- **单文件测试一律 `pnpm exec vitest run --config vitest.config.renderer.ts <path>`**；不要用 `pnpm run test:renderer <path>`（script 尾部已有 `test/renderer` 位置参数，多 filter 会 OR 导致跑全量）。
- 20 个 locale 目录（T2 遍历用）：`zh-CN en-US zh-TW zh-HK de-DE es-ES id-ID ms-MY pl-PL it-IT vi-VN tr-TR he-IL fa-IR ja-JP da-DK fr-FR pt-BR ru-RU ko-KR`。
- 所有 locale 的 `chat.json` 插入锚点统一：**在该文件 `  "floatingWidget": {` 行之前插入整个 `imageTemplates` 块**（即 old_str 用 `  },\n  "floatingWidget": {`，new_str 为 `  },\n<imageTemplates 块>\n  "floatingWidget": {`）。
- JSON 转义注意：凡文案含 ASCII 双引号（en/da/pt/id/ms/vi/ko/tr/he/fa 等的删除确认与空态提示）必须写成 `\"`；中文/德/西/意/法/俄/波等使用全角或 «» „" 引号无需转义。

---

### Task 1: shared 契约（schema + config 白名单 + 主进程默认值）

**Files:**
- Create: `src/shared/imagePromptTemplates.ts`
- Modify: `src/shared/contracts/routes/config.routes.ts`
- Modify: `src/main/config/settingsStore.ts`

- [ ] **Step 1: 创建 `src/shared/imagePromptTemplates.ts`**

```ts
import { z } from 'zod'
import {
  IMAGE_GENERATION_QUALITY_VALUES,
  isValidOpenAIImageGenerationSize,
  type ImageGenerationQuality
} from './imageGenerationSettings'

export const MAX_USER_IMAGE_PROMPT_TEMPLATES = 50

export const UserImagePromptTemplateSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8000),
  size: z.string().refine(isValidOpenAIImageGenerationSize).optional(),
  quality: z.enum(IMAGE_GENERATION_QUALITY_VALUES).optional(),
  createdAt: z.number().int().positive()
})

export type UserImagePromptTemplate = z.infer<typeof UserImagePromptTemplateSchema>
export const UserImagePromptTemplatesSchema = z.array(UserImagePromptTemplateSchema)

export interface ResolvedImagePromptTemplate {
  id: string
  title: string
  prompt: string
  size?: string
  quality?: ImageGenerationQuality
}

export interface ImagePromptTemplateApplyPayload {
  prompt: string
  size?: string
  quality?: ImageGenerationQuality
}
```

- [ ] **Step 2: config 白名单三接触点（`src/shared/contracts/routes/config.routes.ts`）**

2a. 文件头部 import（L1-15 区域，紧跟 `} from '../domainSchemas'` 之后插入）：

```ts
import { UserImagePromptTemplateSchema } from '../../imagePromptTemplates'
```

2b. `CONFIG_ENTRY_KEYS` 末项追加（L124 `'input_enabledMcpTools'` 后）：

```ts
  'input_enabledMcpTools',
  'user_image_prompt_templates'
] as const
```

2c. `ConfigEntryValuesSchema` 末成员追加（L155 `input_enabledMcpTools: z.array(z.string())` 后）：

```ts
  sidebar_group_mode: z.string(),
  input_enabledMcpTools: z.array(z.string()),
  user_image_prompt_templates: z.array(UserImagePromptTemplateSchema)
})
```

2d. `ConfigEntryChangeSchema` 末成员追加（L219-222 的 `input_enabledMcpTools` member 之后、`]` 之前）：

```ts
  z.object({
    key: z.literal('input_enabledMcpTools'),
    value: z.array(z.string())
  }),
  z.object({
    key: z.literal('user_image_prompt_templates'),
    value: z.array(UserImagePromptTemplateSchema)
  })
])
```

- [ ] **Step 3: 主进程默认值（`src/main/config/settingsStore.ts`）**

defaults 块末项 `agentCommandShell: { preference: 'auto' }`（L40）后追加一行：

```ts
        agentCommandShell: { preference: 'auto' },
        user_image_prompt_templates: []
```

- [ ] **Step 4: 验证**

```bash
pnpm run typecheck:node
```

Expected: 通过（0 error）。若 `ConfigEntryValues[K]` 推断报错，确认 `ConfigClient.ts` 的 `getSetting/setSetting` 泛型引用的是本文件导出的 `ConfigEntryValuesSchema` 推断类型。

- [ ] **Step 5: 提交**

```bash
pnpm exec oxfmt src/shared/imagePromptTemplates.ts src/shared/contracts/routes/config.routes.ts src/main/config/settingsStore.ts
git add src/shared/imagePromptTemplates.ts src/shared/contracts/routes/config.routes.ts src/main/config/settingsStore.ts
git commit -m "feat(shared): image prompt template contract"
```

---

### Task 2: i18n 20 locale 文案（chat.json 新增 `imageTemplates` 块）

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/chat.json`（20 个 locale：zh-CN en-US zh-TW zh-HK de-DE es-ES id-ID ms-MY pl-PL it-IT vi-VN tr-TR he-IL fa-IR ja-JP da-DK fr-FR pt-BR ru-RU ko-KR）

统一操作：在 `chat.json` 中找到锚点（每个 locale 相同）：

```
  },
  "floatingWidget": {
```

替换为 `  },\n<下方该 locale 的 imageTemplates 块>\n  "floatingWidget": {`。即 `imageTemplates` 作为根级 key 插在 `floatingWidget` 之前（运行时全 key 为 `chat.imageTemplates.*`，`{title}`/`{max}` 为 vue-i18n 插值占位）。

翻译策略：zh-CN/zh-TW/zh-HK 全量精译（含 7 条 prompt）；其余 16 locale 翻译 25 个 UI key + 7 个内置标题，7 条 prompt 使用英文基准原文（对图像模型效果更稳）。

- [ ] **Step 1: zh-CN**

```json
  "imageTemplates": {
    "button": "范本",
    "panelTitle": "提示词范本",
    "tabFeatured": "精选",
    "tabMine": "我的",
    "add": "新建范本",
    "edit": "编辑",
    "delete": "删除",
    "deleteConfirmTitle": "删除范本",
    "deleteConfirmDescription": "确定删除「{title}」？此操作无法撤销。",
    "limitReached": "最多可保存 {max} 个范本",
    "emptyMine": "还没有自定义范本",
    "emptyMineHint": "点击「新建范本」创建你的第一个范本",
    "emptyCardsHint": "从范本开始你的创作",
    "cancel": "取消",
    "save": "保存",
    "formTitle": "标题",
    "formTitlePlaceholder": "例如：赛博朋克头像",
    "formPrompt": "提示词",
    "formPromptPlaceholder": "描述你想生成的画面…",
    "formSize": "尺寸",
    "formQuality": "质量",
    "sizeDefault": "默认",
    "qualityDefault": "默认",
    "titleRequired": "请输入标题",
    "promptRequired": "请输入提示词",
    "builtin": {
      "design": { "title": "设计创作", "prompt": "为一款可持续旅行产品设计极简品牌标志，采用大地色系与几何线条，风格现代、克制且具辨识度，白色背景，矢量风格" },
      "commodity": { "title": "商品图", "prompt": "一款香水瓶的商业产品摄影，置于浅色大理石台面，柔和自然光从左侧射入，背景虚化，高级质感，画面干净，8k 细节" },
      "poster": { "title": "海报制作", "prompt": "一张音乐节宣传海报，粗犷的孟菲斯风格几何图形，高饱和撞色，醒目留白版式，复古印刷质感，竖版构图" },
      "beautify": { "title": "图片美化", "prompt": "将照片提升为杂志级质感：增强细节与层次，平衡光影，色彩自然通透，保持原始构图不变，无过度锐化" },
      "portrait": { "title": "人像写真", "prompt": "一位年轻女性的室内自然光人像写真，侧脸特写，柔和窗光，浅景深，胶片颗粒感，温暖色调，真实质感" },
      "style": { "title": "风格创意", "prompt": "一座未来城市街景，吉卜力风格手绘动画质感，柔和的午后光线，云层层次丰富，细节饱满，治愈系氛围" },
      "photorealistic": { "title": "写实照片", "prompt": "清晨薄雾中的山间湖泊，超写实风景摄影，佳能 EOS R5 拍摄，35mm 广角，f/8 光圈，自然色彩，细节纤毫毕现" }
    }
  },
```

- [ ] **Step 2: en-US**

```json
  "imageTemplates": {
    "button": "Templates",
    "panelTitle": "Prompt Templates",
    "tabFeatured": "Featured",
    "tabMine": "Mine",
    "add": "New Template",
    "edit": "Edit",
    "delete": "Delete",
    "deleteConfirmTitle": "Delete template",
    "deleteConfirmDescription": "Delete \"{title}\"? This cannot be undone.",
    "limitReached": "You can save up to {max} templates",
    "emptyMine": "No custom templates yet",
    "emptyMineHint": "Click \"New Template\" to create your first one",
    "emptyCardsHint": "Start creating from a template",
    "cancel": "Cancel",
    "save": "Save",
    "formTitle": "Title",
    "formTitlePlaceholder": "e.g. Cyberpunk avatar",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Describe the image you want to generate…",
    "formSize": "Size",
    "formQuality": "Quality",
    "sizeDefault": "Default",
    "qualityDefault": "Default",
    "titleRequired": "Title is required",
    "promptRequired": "Prompt is required",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Product Shot", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Poster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Photo Enhance", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Portrait", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Style", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Photorealistic", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 3: zh-TW**

```json
  "imageTemplates": {
    "button": "範本",
    "panelTitle": "提示詞範本",
    "tabFeatured": "精選",
    "tabMine": "我的",
    "add": "新增範本",
    "edit": "編輯",
    "delete": "刪除",
    "deleteConfirmTitle": "刪除範本",
    "deleteConfirmDescription": "確定刪除「{title}」？此操作無法復原。",
    "limitReached": "最多可儲存 {max} 個範本",
    "emptyMine": "還沒有自訂範本",
    "emptyMineHint": "點擊「新增範本」建立你的第一個範本",
    "emptyCardsHint": "從範本開始你的創作",
    "cancel": "取消",
    "save": "儲存",
    "formTitle": "標題",
    "formTitlePlaceholder": "例如：賽博龐克頭像",
    "formPrompt": "提示詞",
    "formPromptPlaceholder": "描述你想生成的畫面…",
    "formSize": "尺寸",
    "formQuality": "品質",
    "sizeDefault": "預設",
    "qualityDefault": "預設",
    "titleRequired": "請輸入標題",
    "promptRequired": "請輸入提示詞",
    "builtin": {
      "design": { "title": "設計創作", "prompt": "為一款可持續旅行產品設計極簡品牌標誌，採用大地色系與幾何線條，風格現代、克制且具辨識度，白色背景，向量風格" },
      "commodity": { "title": "商品圖", "prompt": "一款香水瓶的商業產品攝影，置於淺色大理石檯面，柔和自然光從左側射入，背景虛化，高級質感，畫面乾淨，8k 細節" },
      "poster": { "title": "海報製作", "prompt": "一張音樂節宣傳海報，粗獷的孟菲斯風格幾何圖形，高飽和撞色，醒目留白版式，復古印刷質感，直式構圖" },
      "beautify": { "title": "圖片美化", "prompt": "將照片提升為雜誌級質感：增強細節與層次，平衡光影，色彩自然通透，保持原始構圖不變，無過度銳化" },
      "portrait": { "title": "人像寫真", "prompt": "一位年輕女性的室內自然光人像寫真，側臉特寫，柔和窗光，淺景深，膠片顆粒感，溫暖色調，真實質感" },
      "style": { "title": "風格創意", "prompt": "一座未來城市街景，吉卜力風格手繪動畫質感，柔和的午後光線，雲層層次豐富，細節飽滿，治癒系氛圍" },
      "photorealistic": { "title": "寫實照片", "prompt": "清晨薄霧中的山間湖泊，超寫實風景攝影，佳能 EOS R5 拍攝，35mm 廣角，f/8 光圈，自然色彩，細節纖毫畢現" }
    }
  },
```

- [ ] **Step 4: zh-HK**（与 zh-TW 相同内容，同锚点插入）

- [ ] **Step 5: de-DE**

```json
  "imageTemplates": {
    "button": "Vorlagen",
    "panelTitle": "Prompt-Vorlagen",
    "tabFeatured": "Empfohlen",
    "tabMine": "Meine",
    "add": "Neue Vorlage",
    "edit": "Bearbeiten",
    "delete": "Löschen",
    "deleteConfirmTitle": "Vorlage löschen",
    "deleteConfirmDescription": "„{title}" löschen? Dies kann nicht rückgängig gemacht werden.",
    "limitReached": "Du kannst bis zu {max} Vorlagen speichern",
    "emptyMine": "Noch keine eigenen Vorlagen",
    "emptyMineHint": "Klicke auf „Neue Vorlage“, um deine erste zu erstellen",
    "emptyCardsHint": "Starte mit einer Vorlage",
    "cancel": "Abbrechen",
    "save": "Speichern",
    "formTitle": "Titel",
    "formTitlePlaceholder": "z. B. Cyberpunk-Avatar",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Beschreibe das Bild, das du generieren möchtest …",
    "formSize": "Größe",
    "formQuality": "Qualität",
    "sizeDefault": "Standard",
    "qualityDefault": "Standard",
    "titleRequired": "Titel ist erforderlich",
    "promptRequired": "Prompt ist erforderlich",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Produktfoto", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Poster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Foto-Optimierung", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Porträt", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Stil", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorealistisch", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 6: es-ES**

```json
  "imageTemplates": {
    "button": "Plantillas",
    "panelTitle": "Plantillas de prompt",
    "tabFeatured": "Destacadas",
    "tabMine": "Mías",
    "add": "Nueva plantilla",
    "edit": "Editar",
    "delete": "Eliminar",
    "deleteConfirmTitle": "Eliminar plantilla",
    "deleteConfirmDescription": "¿Eliminar «{title}»? Esta acción no se puede deshacer.",
    "limitReached": "Puedes guardar hasta {max} plantillas",
    "emptyMine": "Aún no hay plantillas propias",
    "emptyMineHint": "Pulsa «Nueva plantilla» para crear la primera",
    "emptyCardsHint": "Empieza desde una plantilla",
    "cancel": "Cancelar",
    "save": "Guardar",
    "formTitle": "Título",
    "formTitlePlaceholder": "p. ej., avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Describe la imagen que quieres generar…",
    "formSize": "Tamaño",
    "formQuality": "Calidad",
    "sizeDefault": "Predeterminado",
    "qualityDefault": "Predeterminado",
    "titleRequired": "El título es obligatorio",
    "promptRequired": "El prompt es obligatorio",
    "builtin": {
      "design": { "title": "Diseño", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Foto de producto", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Póster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Mejorar foto", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Retrato", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Estilo", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorrealista", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 7: id-ID**

```json
  "imageTemplates": {
    "button": "Templat",
    "panelTitle": "Templat Prompt",
    "tabFeatured": "Pilihan",
    "tabMine": "Milik Saya",
    "add": "Templat Baru",
    "edit": "Edit",
    "delete": "Hapus",
    "deleteConfirmTitle": "Hapus templat",
    "deleteConfirmDescription": "Hapus \"{title}\"? Tindakan ini tidak dapat dibatalkan.",
    "limitReached": "Kamu dapat menyimpan hingga {max} templat",
    "emptyMine": "Belum ada templat khusus",
    "emptyMineHint": "Klik \"Templat Baru\" untuk membuat templat pertamamu",
    "emptyCardsHint": "Mulai berkarya dari sebuah templat",
    "cancel": "Batal",
    "save": "Simpan",
    "formTitle": "Judul",
    "formTitlePlaceholder": "mis. avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Deskripsikan gambar yang ingin kamu buat…",
    "formSize": "Ukuran",
    "formQuality": "Kualitas",
    "sizeDefault": "Default",
    "qualityDefault": "Default",
    "titleRequired": "Judul wajib diisi",
    "promptRequired": "Prompt wajib diisi",
    "builtin": {
      "design": { "title": "Desain", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Foto Produk", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Poster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Penajaman Foto", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Potret", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Gaya", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorealistis", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 8: ms-MY**

```json
  "imageTemplates": {
    "button": "Templat",
    "panelTitle": "Templat Prom",
    "tabFeatured": "Pilihan",
    "tabMine": "Milik Saya",
    "add": "Templat Baharu",
    "edit": "Edit",
    "delete": "Padam",
    "deleteConfirmTitle": "Padam templat",
    "deleteConfirmDescription": "Padam \"{title}\"? Tindakan ini tidak boleh dibatalkan.",
    "limitReached": "Anda boleh menyimpan sehingga {max} templat",
    "emptyMine": "Tiada templat tersuai lagi",
    "emptyMineHint": "Klik \"Templat Baharu\" untuk mencipta templat pertama anda",
    "emptyCardsHint": "Mula cipta daripada templat",
    "cancel": "Batal",
    "save": "Simpan",
    "formTitle": "Tajuk",
    "formTitlePlaceholder": "cth. avatar siberpunk",
    "formPrompt": "Prom",
    "formPromptPlaceholder": "Huraikan imej yang anda mahu jana…",
    "formSize": "Saiz",
    "formQuality": "Kualiti",
    "sizeDefault": "Lalai",
    "qualityDefault": "Lalai",
    "titleRequired": "Tajuk diperlukan",
    "promptRequired": "Prom diperlukan",
    "builtin": {
      "design": { "title": "Reka Bentuk", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Foto Produk", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Poster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Kecantikan Foto", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Potret", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Gaya", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Foto Realistik", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 9: pl-PL**

```json
  "imageTemplates": {
    "button": "Szablony",
    "panelTitle": "Szablony promptów",
    "tabFeatured": "Polecane",
    "tabMine": "Moje",
    "add": "Nowy szablon",
    "edit": "Edytuj",
    "delete": "Usuń",
    "deleteConfirmTitle": "Usuń szablon",
    "deleteConfirmDescription": "Usunąć „{title}”? Tej operacji nie można cofnąć.",
    "limitReached": "Możesz zapisać do {max} szablonów",
    "emptyMine": "Brak własnych szablonów",
    "emptyMineHint": "Kliknij „Nowy szablon”, aby utworzyć pierwszy",
    "emptyCardsHint": "Zacznij od szablonu",
    "cancel": "Anuluj",
    "save": "Zapisz",
    "formTitle": "Tytuł",
    "formTitlePlaceholder": "np. awatar cyberpunkowy",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Opisz obraz, który chcesz wygenerować…",
    "formSize": "Rozmiar",
    "formQuality": "Jakość",
    "sizeDefault": "Domyślny",
    "qualityDefault": "Domyślny",
    "titleRequired": "Tytuł jest wymagany",
    "promptRequired": "Prompt jest wymagany",
    "builtin": {
      "design": { "title": "Projekt", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Zdjęcie produktu", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Plakat", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Poprawa zdjęcia", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Portret", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Styl", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorealizm", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 10: it-IT**

```json
  "imageTemplates": {
    "button": "Modelli",
    "panelTitle": "Modelli di prompt",
    "tabFeatured": "In evidenza",
    "tabMine": "I miei",
    "add": "Nuovo modello",
    "edit": "Modifica",
    "delete": "Elimina",
    "deleteConfirmTitle": "Elimina modello",
    "deleteConfirmDescription": "Eliminare «{title}»? L'operazione non può essere annullata.",
    "limitReached": "Puoi salvare fino a {max} modelli",
    "emptyMine": "Ancora nessun modello personalizzato",
    "emptyMineHint": "Fai clic su «Nuovo modello» per crearne uno",
    "emptyCardsHint": "Inizia da un modello",
    "cancel": "Annulla",
    "save": "Salva",
    "formTitle": "Titolo",
    "formTitlePlaceholder": "es. avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Descrivi l'immagine che vuoi generare…",
    "formSize": "Dimensione",
    "formQuality": "Qualità",
    "sizeDefault": "Predefinito",
    "qualityDefault": "Predefinito",
    "titleRequired": "Il titolo è obbligatorio",
    "promptRequired": "Il prompt è obbligatorio",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Prodotto", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Poster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Migliora foto", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Ritratto", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Stile", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorealistico", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

---

- [ ] **Step 11: vi-VN**

```json
  "imageTemplates": {
    "button": "Mẫu",
    "panelTitle": "Mẫu prompt",
    "tabFeatured": "Nổi bật",
    "tabMine": "Của tôi",
    "add": "Tạo mẫu",
    "edit": "Sửa",
    "delete": "Xóa",
    "deleteConfirmTitle": "Xóa mẫu",
    "deleteConfirmDescription": "Xóa \"{title}\"? Hành động này không thể hoàn tác.",
    "limitReached": "Bạn có thể lưu tối đa {max} mẫu",
    "emptyMine": "Chưa có mẫu tùy chỉnh",
    "emptyMineHint": "Nhấp \"Tạo mẫu\" để tạo mẫu đầu tiên",
    "emptyCardsHint": "Bắt đầu từ một mẫu",
    "cancel": "Hủy",
    "save": "Lưu",
    "formTitle": "Tiêu đề",
    "formTitlePlaceholder": "vd. avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Mô tả hình ảnh bạn muốn tạo…",
    "formSize": "Kích thước",
    "formQuality": "Chất lượng",
    "sizeDefault": "Mặc định",
    "qualityDefault": "Mặc định",
    "titleRequired": "Cần nhập tiêu đề",
    "promptRequired": "Cần nhập prompt",
    "builtin": {
      "design": { "title": "Thiết kế", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Ảnh sản phẩm", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Áp phích", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Chỉnh ảnh", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Chân dung", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Phong cách", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Ảnh thực tế", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 12: tr-TR**

```json
  "imageTemplates": {
    "button": "Şablonlar",
    "panelTitle": "Prompt Şablonları",
    "tabFeatured": "Öne Çıkanlar",
    "tabMine": "Benim",
    "add": "Yeni Şablon",
    "edit": "Düzenle",
    "delete": "Sil",
    "deleteConfirmTitle": "Şablonu sil",
    "deleteConfirmDescription": "\"{title}\" silinsin mi? Bu işlem geri alınamaz.",
    "limitReached": "En fazla {max} şablon kaydedebilirsin",
    "emptyMine": "Henüz özel şablon yok",
    "emptyMineHint": "İlk şablonunuzu oluşturmak için \"Yeni Şablon\" öğesine tıklayın",
    "emptyCardsHint": "Bir şablonla başlayın",
    "cancel": "İptal",
    "save": "Kaydet",
    "formTitle": "Başlık",
    "formTitlePlaceholder": "örn. Siberpunk avatar",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Oluşturmak istediğiniz görseli tanımlayın…",
    "formSize": "Boyut",
    "formQuality": "Kalite",
    "sizeDefault": "Varsayılan",
    "qualityDefault": "Varsayılan",
    "titleRequired": "Başlık gerekli",
    "promptRequired": "Prompt gerekli",
    "builtin": {
      "design": { "title": "Tasarım", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Ürün Çekimi", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Afiş", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Foto Geliştirme", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Portre", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Stil", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotogerçekçi", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 13: he-IL**

```json
  "imageTemplates": {
    "button": "תבניות",
    "panelTitle": "תבניות פרומפט",
    "tabFeatured": "מומלצות",
    "tabMine": "שלי",
    "add": "תבנית חדשה",
    "edit": "עריכה",
    "delete": "מחיקה",
    "deleteConfirmTitle": "מחיקת תבנית",
    "deleteConfirmDescription": "למחוק את \"{title}\"? לא ניתן לבטל פעולה זו.",
    "limitReached": "ניתן לשמור עד {max} תבניות",
    "emptyMine": "עדיין אין תבניות מותאמות אישית",
    "emptyMineHint": "לחצו על \"תבנית חדשה\" כדי ליצור את הראשונה",
    "emptyCardsHint": "התחילו מתבנית",
    "cancel": "ביטול",
    "save": "שמירה",
    "formTitle": "כותרת",
    "formTitlePlaceholder": "למשל אווטאר סייברפאנק",
    "formPrompt": "פרומפט",
    "formPromptPlaceholder": "תארו את התמונה שברצונכם ליצור…",
    "formSize": "גודל",
    "formQuality": "איכות",
    "sizeDefault": "ברירת מחדל",
    "qualityDefault": "ברירת מחדל",
    "titleRequired": "נדרשת כותרת",
    "promptRequired": "נדרש פרומפט",
    "builtin": {
      "design": { "title": "עיצוב", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "צילום מוצר", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "פוסטר", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "שיפור תמונה", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "דיוקן", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "סגנון", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "פוטוריאליסטי", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 14: fa-IR**

```json
  "imageTemplates": {
    "button": "قالب‌ها",
    "panelTitle": "قالب‌های پرامپت",
    "tabFeatured": "برگزیده",
    "tabMine": "من",
    "add": "قالب جدید",
    "edit": "ویرایش",
    "delete": "حذف",
    "deleteConfirmTitle": "حذف قالب",
    "deleteConfirmDescription": "«{title}» حذف شود؟ این عمل قابل بازگشت نیست.",
    "limitReached": "حداکثر می‌توانید {max} قالب ذخیره کنید",
    "emptyMine": "هنوز قالب سفارشی ندارید",
    "emptyMineHint": "برای ساخت اولین قالب روی «قالب جدید» بزنید",
    "emptyCardsHint": "کار را با یک قالب شروع کنید",
    "cancel": "لغو",
    "save": "ذخیره",
    "formTitle": "عنوان",
    "formTitlePlaceholder": "مثلاً آواتار سایبرپانک",
    "formPrompt": "پرامپت",
    "formPromptPlaceholder": "تصویری که می‌خواهید بسازید را توصیف کنید…",
    "formSize": "اندازه",
    "formQuality": "کیفیت",
    "sizeDefault": "پیش‌فرض",
    "qualityDefault": "پیش‌فرض",
    "titleRequired": "عنوان الزامی است",
    "promptRequired": "پرامپت الزامی است",
    "builtin": {
      "design": { "title": "طراحی", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "عکس محصول", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "پوستر", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "بهبود عکس", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "پرتره", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "سبک", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "فوق‌واقع‌گرایانه", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 15: ja-JP**

```json
  "imageTemplates": {
    "button": "テンプレート",
    "panelTitle": "プロンプトテンプレート",
    "tabFeatured": "おすすめ",
    "tabMine": "マイテンプレート",
    "add": "新規テンプレート",
    "edit": "編集",
    "delete": "削除",
    "deleteConfirmTitle": "テンプレートを削除",
    "deleteConfirmDescription": "「{title}」を削除しますか？この操作は元に戻せません。",
    "limitReached": "保存できるのは最大 {max} 件までです",
    "emptyMine": "まだカスタムテンプレートはありません",
    "emptyMineHint": "「新規テンプレート」をクリックして最初のテンプレートを作成しましょう",
    "emptyCardsHint": "テンプレートから始めましょう",
    "cancel": "キャンセル",
    "save": "保存",
    "formTitle": "タイトル",
    "formTitlePlaceholder": "例：サイバーパンクのアバター",
    "formPrompt": "プロンプト",
    "formPromptPlaceholder": "生成したい画像を説明してください…",
    "formSize": "サイズ",
    "formQuality": "品質",
    "sizeDefault": "デフォルト",
    "qualityDefault": "デフォルト",
    "titleRequired": "タイトルは必須です",
    "promptRequired": "プロンプトは必須です",
    "builtin": {
      "design": { "title": "デザイン", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "商品写真", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "ポスター", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "写真補正", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "ポートレート", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "スタイル", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "リアル写真", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 16: da-DK**

```json
  "imageTemplates": {
    "button": "Skabeloner",
    "panelTitle": "Promptskabeloner",
    "tabFeatured": "Anbefalede",
    "tabMine": "Mine",
    "add": "Ny skabelon",
    "edit": "Redigér",
    "delete": "Slet",
    "deleteConfirmTitle": "Slet skabelon",
    "deleteConfirmDescription": "Slet \"{title}\"? Dette kan ikke fortrydes.",
    "limitReached": "Du kan gemme op til {max} skabeloner",
    "emptyMine": "Ingen egne skabeloner endnu",
    "emptyMineHint": "Klik på \"Ny skabelon\" for at oprette din første",
    "emptyCardsHint": "Kom i gang med en skabelon",
    "cancel": "Annullér",
    "save": "Gem",
    "formTitle": "Titel",
    "formTitlePlaceholder": "f.eks. cyberpunk-avatar",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Beskriv det billede, du vil generere…",
    "formSize": "Størrelse",
    "formQuality": "Kvalitet",
    "sizeDefault": "Standard",
    "qualityDefault": "Standard",
    "titleRequired": "Titel er påkrævet",
    "promptRequired": "Prompt er påkrævet",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Produktfoto", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Plakat", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Fotoforbedring", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Portræt", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Stil", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorealistisk", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 17: fr-FR**

```json
  "imageTemplates": {
    "button": "Modèles",
    "panelTitle": "Modèles de prompt",
    "tabFeatured": "À la une",
    "tabMine": "Les miens",
    "add": "Nouveau modèle",
    "edit": "Modifier",
    "delete": "Supprimer",
    "deleteConfirmTitle": "Supprimer le modèle",
    "deleteConfirmDescription": "Supprimer « {title} » ? Cette action est irréversible.",
    "limitReached": "Vous pouvez enregistrer jusqu'à {max} modèles",
    "emptyMine": "Aucun modèle personnalisé pour l'instant",
    "emptyMineHint": "Cliquez sur « Nouveau modèle » pour créer le premier",
    "emptyCardsHint": "Commencez à partir d'un modèle",
    "cancel": "Annuler",
    "save": "Enregistrer",
    "formTitle": "Titre",
    "formTitlePlaceholder": "ex. avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Décrivez l'image que vous souhaitez générer…",
    "formSize": "Taille",
    "formQuality": "Qualité",
    "sizeDefault": "Par défaut",
    "qualityDefault": "Par défaut",
    "titleRequired": "Le titre est requis",
    "promptRequired": "Le prompt est requis",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Photo produit", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Affiche", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Amélioration photo", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Portrait", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Style", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Photoréaliste", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 18: pt-BR**

```json
  "imageTemplates": {
    "button": "Modelos",
    "panelTitle": "Modelos de prompt",
    "tabFeatured": "Destaques",
    "tabMine": "Meus",
    "add": "Novo modelo",
    "edit": "Editar",
    "delete": "Excluir",
    "deleteConfirmTitle": "Excluir modelo",
    "deleteConfirmDescription": "Excluir \"{title}\"? Esta ação não pode ser desfeita.",
    "limitReached": "Você pode salvar até {max} modelos",
    "emptyMine": "Nenhum modelo personalizado ainda",
    "emptyMineHint": "Clique em \"Novo modelo\" para criar o primeiro",
    "emptyCardsHint": "Comece criando a partir de um modelo",
    "cancel": "Cancelar",
    "save": "Salvar",
    "formTitle": "Título",
    "formTitlePlaceholder": "ex. avatar cyberpunk",
    "formPrompt": "Prompt",
    "formPromptPlaceholder": "Descreva a imagem que você quer gerar…",
    "formSize": "Tamanho",
    "formQuality": "Qualidade",
    "sizeDefault": "Padrão",
    "qualityDefault": "Padrão",
    "titleRequired": "O título é obrigatório",
    "promptRequired": "O prompt é obrigatório",
    "builtin": {
      "design": { "title": "Design", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Foto de produto", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Pôster", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Melhorar foto", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Retrato", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Estilo", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Fotorrealista", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 19: ru-RU**

```json
  "imageTemplates": {
    "button": "Шаблоны",
    "panelTitle": "Шаблоны промптов",
    "tabFeatured": "Рекомендуемые",
    "tabMine": "Мои",
    "add": "Новый шаблон",
    "edit": "Изменить",
    "delete": "Удалить",
    "deleteConfirmTitle": "Удалить шаблон",
    "deleteConfirmDescription": "Удалить «{title}»? Это действие нельзя отменить.",
    "limitReached": "Можно сохранить до {max} шаблонов",
    "emptyMine": "Пока нет своих шаблонов",
    "emptyMineHint": "Нажмите «Новый шаблон», чтобы создать первый",
    "emptyCardsHint": "Начните с шаблона",
    "cancel": "Отмена",
    "save": "Сохранить",
    "formTitle": "Название",
    "formTitlePlaceholder": "напр. киберпанк-аватар",
    "formPrompt": "Промпт",
    "formPromptPlaceholder": "Опишите изображение, которое хотите создать…",
    "formSize": "Размер",
    "formQuality": "Качество",
    "sizeDefault": "По умолчанию",
    "qualityDefault": "По умолчанию",
    "titleRequired": "Укажите название",
    "promptRequired": "Укажите промпт",
    "builtin": {
      "design": { "title": "Дизайн", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "Фото товара", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "Плакат", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "Улучшение фото", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "Портрет", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "Стиль", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "Фотореализм", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 20: ko-KR**

```json
  "imageTemplates": {
    "button": "템플릿",
    "panelTitle": "프롬프트 템플릿",
    "tabFeatured": "추천",
    "tabMine": "내 템플릿",
    "add": "새 템플릿",
    "edit": "편집",
    "delete": "삭제",
    "deleteConfirmTitle": "템플릿 삭제",
    "deleteConfirmDescription": "\"{title}\"을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다.",
    "limitReached": "최대 {max}개까지 저장할 수 있어요",
    "emptyMine": "아직 사용자 지정 템플릿이 없어요",
    "emptyMineHint": "\"새 템플릿\"을 눌러 첫 템플릿을 만들어 보세요",
    "emptyCardsHint": "템플릿으로 시작해 보세요",
    "cancel": "취소",
    "save": "저장",
    "formTitle": "제목",
    "formTitlePlaceholder": "예：사이버펑크 아바타",
    "formPrompt": "프롬프트",
    "formPromptPlaceholder": "생성하고 싶은 이미지를 설명하세요…",
    "formSize": "크기",
    "formQuality": "품질",
    "sizeDefault": "기본값",
    "qualityDefault": "기본값",
    "titleRequired": "제목을 입력하세요",
    "promptRequired": "프롬프트를 입력하세요",
    "builtin": {
      "design": { "title": "디자인", "prompt": "Design a minimalist brand logo for a sustainable travel product, earthy color palette with geometric lines, modern and restrained, highly recognizable, white background, vector style" },
      "commodity": { "title": "상품 사진", "prompt": "Commercial product photography of a perfume bottle on light marble, soft natural light from the left, blurred background, premium feel, clean composition, 8k detail" },
      "poster": { "title": "포스터", "prompt": "A music festival promo poster, bold Memphis-style geometric shapes, high-saturation contrasting colors, striking whitespace layout, retro print texture, portrait composition" },
      "beautify": { "title": "사진 보정", "prompt": "Elevate the photo to magazine quality: enhance detail and depth, balance light and shadow, natural transparent colors, keep the original composition, no over-sharpening" },
      "portrait": { "title": "인물 사진", "prompt": "Indoor natural-light portrait of a young woman, side profile close-up, soft window light, shallow depth of field, film grain, warm tones, lifelike texture" },
      "style": { "title": "스타일", "prompt": "A futuristic city street scene in hand-painted Ghibli anime style, soft afternoon light, layered clouds, rich detail, healing atmosphere" },
      "photorealistic": { "title": "실사 사진", "prompt": "A mountain lake in morning mist, hyper-realistic landscape photography, shot on Canon EOS R5, 35mm wide angle, f/8, natural colors, razor-sharp detail" }
    }
  },
```

- [ ] **Step 21: 运行 i18n 校验与类型生成**

```bash
pnpm run i18n:types
pnpm run i18n
```

Expected: `i18n:validate` 通过、`i18n-check -s zh-CN` 报告 0 missing / 0 extra（20 个 locale 全部键齐备）；`src/types/i18n.d.ts` 被重新生成并包含 `imageTemplates` 键（该文件被 git 跟踪，vue-i18n 的 `DefineLocaleMessage` 类型增强依赖它，否则 Task 7 的 typecheck:web 会因 `t('chat.imageTemplates.*')` 键不存在而报错）。若报某 locale 缺 key，核对该文件是否漏插 `imageTemplates` 块或 JSON 语法错误（`pnpm exec node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/<dir>/chat.json','utf8'))"` 可快速定位）。

- [ ] **Step 22: 提交**

```bash
git add src/renderer/src/i18n/zh-CN/chat.json src/renderer/src/i18n/en-US/chat.json src/renderer/src/i18n/zh-TW/chat.json src/renderer/src/i18n/zh-HK/chat.json src/renderer/src/i18n/de-DE/chat.json src/renderer/src/i18n/es-ES/chat.json src/renderer/src/i18n/id-ID/chat.json src/renderer/src/i18n/ms-MY/chat.json src/renderer/src/i18n/pl-PL/chat.json src/renderer/src/i18n/it-IT/chat.json src/renderer/src/i18n/vi-VN/chat.json src/renderer/src/i18n/tr-TR/chat.json src/renderer/src/i18n/he-IL/chat.json src/renderer/src/i18n/fa-IR/chat.json src/renderer/src/i18n/ja-JP/chat.json src/renderer/src/i18n/da-DK/chat.json src/renderer/src/i18n/fr-FR/chat.json src/renderer/src/i18n/pt-BR/chat.json src/renderer/src/i18n/ru-RU/chat.json src/renderer/src/i18n/ko-KR/chat.json src/types/i18n.d.ts
git commit -m "feat(i18n): image prompt template copy"
```

---

### Task 3: 内置范本常量

**Files:**
- Create: `src/renderer/src/lib/builtinImagePromptTemplates.ts`

- [ ] **Step 1: 创建 `src/renderer/src/lib/builtinImagePromptTemplates.ts`**

```ts
import type { ImageGenerationQuality } from '@shared/imagePromptTemplates'

interface BuiltinImagePromptTemplate {
  id: string
  titleKey: string
  promptKey: string
  size?: string
  quality?: ImageGenerationQuality
}

export const BUILTIN_IMAGE_PROMPT_TEMPLATES: BuiltinImagePromptTemplate[] = [
  {
    id: 'builtin-design',
    titleKey: 'chat.imageTemplates.builtin.design.title',
    promptKey: 'chat.imageTemplates.builtin.design.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-commodity',
    titleKey: 'chat.imageTemplates.builtin.commodity.title',
    promptKey: 'chat.imageTemplates.builtin.commodity.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-poster',
    titleKey: 'chat.imageTemplates.builtin.poster.title',
    promptKey: 'chat.imageTemplates.builtin.poster.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-beautify',
    titleKey: 'chat.imageTemplates.builtin.beautify.title',
    promptKey: 'chat.imageTemplates.builtin.beautify.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-portrait',
    titleKey: 'chat.imageTemplates.builtin.portrait.title',
    promptKey: 'chat.imageTemplates.builtin.portrait.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-style',
    titleKey: 'chat.imageTemplates.builtin.style.title',
    promptKey: 'chat.imageTemplates.builtin.style.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-photorealistic',
    titleKey: 'chat.imageTemplates.builtin.photorealistic.title',
    promptKey: 'chat.imageTemplates.builtin.photorealistic.prompt',
    size: '1536x1024',
    quality: 'high'
  }
]
```

- [ ] **Step 2: 提交**

```bash
pnpm exec oxfmt src/renderer/src/lib/builtinImagePromptTemplates.ts
git add src/renderer/src/lib/builtinImagePromptTemplates.ts
git commit -m "feat(renderer): builtin image prompt templates"
```

（typecheck:web 延后到 Task 7 集成后统一运行；本文件仅含常量，类型错误风险极低。）

---

### Task 4: 用户范本 store + 测试

**Files:**
- Create: `src/renderer/src/stores/imagePromptTemplates.ts`
- Create: `test/renderer/stores/imagePromptTemplatesStore.test.ts`

- [ ] **Step 1: 创建 `src/renderer/src/stores/imagePromptTemplates.ts`**

关键点：`createConfigClient()` 必须放在 store setup 函数内（延迟实例化），否则 toolbar 测试 import 子组件模块时就会触碰 IPC。`update` 的 candidate 从 input 全新构建（不从 target spread），不传 size/quality 即可清除二者。

```ts
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { createConfigClient } from '@api/ConfigClient'
import {
  MAX_USER_IMAGE_PROMPT_TEMPLATES,
  UserImagePromptTemplateSchema,
  UserImagePromptTemplatesSchema,
  type ResolvedImagePromptTemplate,
  type UserImagePromptTemplate
} from '@shared/imagePromptTemplates'
import { BUILTIN_IMAGE_PROMPT_TEMPLATES } from '@/lib/builtinImagePromptTemplates'

const CONFIG_KEY = 'user_image_prompt_templates'

export interface NewImagePromptTemplateInput {
  title: string
  prompt: string
  size?: string
  quality?: UserImagePromptTemplate['quality']
}

export const useImagePromptTemplatesStore = defineStore('imagePromptTemplates', () => {
  const configClient = createConfigClient()
  const userTemplates = ref<UserImagePromptTemplate[]>([])
  const loaded = ref(false)
  const canAdd = computed(() => userTemplates.value.length < MAX_USER_IMAGE_PROMPT_TEMPLATES)

  const persist = () => {
    void configClient.setSetting(CONFIG_KEY, [...userTemplates.value])
  }

  const load = async () => {
    if (loaded.value) return
    try {
      const raw = await configClient.getSetting(CONFIG_KEY)
      const parsed = UserImagePromptTemplatesSchema.safeParse(raw ?? [])
      if (parsed.success) {
        userTemplates.value = parsed.data
      } else {
        console.warn('[imagePromptTemplates] invalid stored templates, falling back to empty list')
        userTemplates.value = []
      }
    } catch (error) {
      console.warn('[imagePromptTemplates] failed to load templates, falling back to empty list', error)
      userTemplates.value = []
    } finally {
      loaded.value = true
    }
  }

  const add = (input: NewImagePromptTemplateInput): UserImagePromptTemplate => {
    if (!canAdd.value) {
      throw new Error('Image prompt template limit reached')
    }
    const candidate = {
      id: nanoid(),
      title: input.title,
      prompt: input.prompt,
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      createdAt: Date.now()
    }
    const parsed = UserImagePromptTemplateSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error('Invalid image prompt template')
    }
    userTemplates.value = [...userTemplates.value, parsed.data]
    persist()
    return parsed.data
  }

  const update = (id: string, input: NewImagePromptTemplateInput): void => {
    const target = userTemplates.value.find((tpl) => tpl.id === id)
    if (!target) {
      throw new Error('Image prompt template not found')
    }
    const candidate = {
      id,
      title: input.title,
      prompt: input.prompt,
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      createdAt: target.createdAt
    }
    const parsed = UserImagePromptTemplateSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error('Invalid image prompt template')
    }
    userTemplates.value = userTemplates.value.map((tpl) => (tpl.id === id ? parsed.data : tpl))
    persist()
  }

  const remove = (id: string): void => {
    userTemplates.value = userTemplates.value.filter((tpl) => tpl.id !== id)
    persist()
  }

  return { userTemplates, loaded, canAdd, load, add, update, remove }
})

export const useBuiltinImagePromptTemplates = (): {
  builtinTemplates: ReturnType<typeof computed<ResolvedImagePromptTemplate[]>>
} => {
  const { t } = useI18n()
  const builtinTemplates = computed<ResolvedImagePromptTemplate[]>(() =>
    BUILTIN_IMAGE_PROMPT_TEMPLATES.map((tpl) => ({
      id: tpl.id,
      title: t(tpl.titleKey),
      prompt: t(tpl.promptKey),
      ...(tpl.size !== undefined ? { size: tpl.size } : {}),
      ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
    }))
  )
  return { builtinTemplates }
}
```

- [ ] **Step 2: 创建 `test/renderer/stores/imagePromptTemplatesStore.test.ts`**

mock 策略：`vi.mock('@api/ConfigClient')` 返回共享 `configMocks`（`vi.hoisted`）；`vi.mock('pinia')` 用 `importActual` 透传并导出 `createPinia`/`setActivePinia` 的测试用别名（避免 ESM 循环），**直接 `import { createPinia, setActivePinia } from 'pinia'` + `vi.mock('pinia', async (importOriginal) => ({ ...(await importOriginal()) }))` 透传即可**（此 mock 仅为保证 mock 层序稳定，实际可省略；如省略后测试运行正常则不写该 mock）。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => configMocks
}))

import { createPinia, setActivePinia } from 'pinia'
import {
  useImagePromptTemplatesStore
} from '@/stores/imagePromptTemplates'
import type { UserImagePromptTemplate } from '@shared/imagePromptTemplates'

const validTemplate = (overrides: Partial<UserImagePromptTemplate> = {}): UserImagePromptTemplate => ({
  id: 'tpl-1',
  title: '设计范本',
  prompt: 'a red apple on a table',
  createdAt: 1700000000000,
  ...overrides
})

describe('useImagePromptTemplatesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('load 读取有效数据并置 loaded', async () => {
    configMocks.getSetting.mockResolvedValue([validTemplate()])
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toHaveLength(1)
    expect(store.userTemplates[0].title).toBe('设计范本')
    expect(store.loaded).toBe(true)
  })

  it('load 坏数据回退空列表并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configMocks.getSetting.mockResolvedValue([{ id: 42 }])
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toEqual([])
    expect(store.loaded).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('load 失败回退空列表并告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configMocks.getSetting.mockRejectedValue(new Error('ipc down'))
    const store = useImagePromptTemplatesStore()
    await store.load()
    expect(store.userTemplates).toEqual([])
    expect(store.loaded).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('add 追加并持久化', () => {
    const store = useImagePromptTemplatesStore()
    const created = store.add({ title: '商品图', prompt: 'bottle', size: '1024x1024' })
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBeGreaterThan(0)
    expect(store.userTemplates).toHaveLength(1)
    expect(configMocks.setSetting).toHaveBeenCalledWith(
      'user_image_prompt_templates',
      [expect.objectContaining({ title: '商品图' })]
    )
  })

  it('add 空白标题抛错且不持久化', () => {
    const store = useImagePromptTemplatesStore()
    expect(() => store.add({ title: '   ', prompt: 'x' })).toThrow('Invalid image prompt template')
    expect(store.userTemplates).toHaveLength(0)
    expect(configMocks.setSetting).not.toHaveBeenCalled()
  })

  it('add 超上限抛错', () => {
    const store = useImagePromptTemplatesStore()
    for (let i = 0; i < 50; i++) {
      store.add({ title: `t${i}`, prompt: 'p' })
    }
    configMocks.setSetting.mockClear()
    expect(() => store.add({ title: 'overflow', prompt: 'p' })).toThrow('limit reached')
    expect(configMocks.setSetting).not.toHaveBeenCalled()
  })

  it('update 清除 size/quality 并保留 createdAt', () => {
    const store = useImagePromptTemplatesStore()
    store.add({ title: '旧', prompt: 'p', size: '1024x1024', quality: 'high' })
    configMocks.setSetting.mockClear()
    store.update(store.userTemplates[0].id, { title: '新', prompt: 'q' })
    const updated = store.userTemplates[0]
    expect(updated.title).toBe('新')
    expect(updated.size).toBeUndefined()
    expect(updated.quality).toBeUndefined()
    expect(updated.createdAt).toBeGreaterThan(0)
    const payload = configMocks.setSetting.mock.calls[0][1] as UserImagePromptTemplate[]
    expect(payload[0].size).toBeUndefined()
    expect(payload[0].quality).toBeUndefined()
  })

  it('update 未知 id 抛错', () => {
    const store = useImagePromptTemplatesStore()
    expect(() => store.update('missing', { title: 'x', prompt: 'y' })).toThrow('not found')
  })

  it('remove 删除并持久化剩余项', () => {
    const store = useImagePromptTemplatesStore()
    const a = store.add({ title: 'a', prompt: 'p' })
    const b = store.add({ title: 'b', prompt: 'p' })
    configMocks.setSetting.mockClear()
    store.remove(a.id)
    expect(store.userTemplates.map((tpl) => tpl.id)).toEqual([b.id])
    expect(configMocks.setSetting).toHaveBeenCalledWith(
      'user_image_prompt_templates',
      [expect.objectContaining({ id: b.id })]
    )
  })
})
```

- [ ] **Step 3: 运行测试**

```bash
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/stores/imagePromptTemplatesStore.test.ts
```

Expected: 9 passed。

- [ ] **Step 4: 提交**

```bash
pnpm exec oxfmt src/renderer/src/stores/imagePromptTemplates.ts test/renderer/stores/imagePromptTemplatesStore.test.ts
git add src/renderer/src/stores/imagePromptTemplates.ts test/renderer/stores/imagePromptTemplatesStore.test.ts
git commit -m "feat(renderer): image prompt template store"
```

---

### Task 5: 弹层管理面板 ImagePromptTemplateButton + 测试

**Files:**
- Create: `src/renderer/src/components/chat-input/ImagePromptTemplateButton.vue`
- Create: `test/renderer/components/ImagePromptTemplateButton.test.ts`

已核实的依赖事实：shadcn `popover`（Popover/PopoverTrigger/PopoverContent）、`tabs`（Tabs/TabsList/TabsTrigger/TabsContent）、`select`（Select/SelectTrigger/SelectValue/SelectContent/SelectItem）、`input`、`label`、`textarea` 均存在于 `@shadcn/components/ui/*`；Input/Textarea 用 `useVModel` 支持 `v-model`；Select 模式为 `<Select :model-value @update:model-value>` + `SelectValue placeholder` + `SelectItem :value`；`DcConfirmDialog` props `open/title/description/danger/confirmLabel/cancelLabel`、emits `update:open/confirm/cancel`。

- [ ] **Step 1: 创建 `src/renderer/src/components/chat-input/ImagePromptTemplateButton.vue`**

```vue
<template>
  <Popover v-model:open="panelOpen">
    <PopoverTrigger as-child>
      <DcButton
        variant="ghost"
        size="icon-sm"
        icon="lucide:images"
        :label="t('chat.imageTemplates.button')"
        :tooltip="t('chat.imageTemplates.button')"
        :tooltip-delay-duration="200"
        data-testid="image-template-button"
      />
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 p-0">
      <div class="px-3 pt-3 text-sm font-medium">
        {{ t('chat.imageTemplates.panelTitle') }}
      </div>
      <Tabs default-value="featured" class="mt-1">
        <TabsList class="mx-3 grid grid-cols-2">
          <TabsTrigger value="featured" data-testid="image-template-tab-featured">
            {{ t('chat.imageTemplates.tabFeatured') }}
          </TabsTrigger>
          <TabsTrigger value="mine" data-testid="image-template-tab-mine">
            {{ t('chat.imageTemplates.tabMine') }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="featured" class="min-h-0">
          <div class="max-h-80 overflow-y-auto px-1 py-1">
            <button
              v-for="tpl in builtinTemplates"
              :key="tpl.id"
              type="button"
              data-testid="image-template-card"
              class="block w-full rounded-lg px-2 py-2 text-left hover:bg-accent"
              @click="applyTemplate(tpl)"
            >
              <span class="flex items-center gap-2">
                <span class="text-sm">{{ tpl.title }}</span>
                <span
                  v-if="templateMeta(tpl)"
                  class="text-[11px] text-muted-foreground"
                >
                  {{ templateMeta(tpl) }}
                </span>
              </span>
              <span class="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                {{ tpl.prompt }}
              </span>
            </button>
          </div>
        </TabsContent>

        <TabsContent value="mine" class="min-h-0">
          <div class="max-h-80 overflow-y-auto px-1 py-1">
            <DcButton
              v-if="store.canAdd && !formMode"
              data-testid="image-template-add"
              variant="outline"
              size="sm"
              class="mx-1 my-1"
              icon="lucide:plus"
              @click="openCreate"
            >
              {{ t('chat.imageTemplates.add') }}
            </DcButton>
            <p
              v-else-if="!formMode"
              data-testid="image-template-limit"
              class="px-2 py-2 text-xs text-muted-foreground"
            >
              {{ t('chat.imageTemplates.limitReached', { max: MAX_USER_IMAGE_PROMPT_TEMPLATES }) }}
            </p>

            <form
              v-if="formMode"
              data-testid="image-template-form"
              class="flex flex-col gap-2 px-2 py-2"
              @submit.prevent="saveForm"
            >
              <Label for="image-template-form-title">
                {{ t('chat.imageTemplates.formTitle') }}
              </Label>
              <Input
                id="image-template-form-title"
                v-model="formTitle"
                data-testid="image-template-form-title"
                :placeholder="t('chat.imageTemplates.formTitlePlaceholder')"
              />
              <Label for="image-template-form-prompt">
                {{ t('chat.imageTemplates.formPrompt') }}
              </Label>
              <Textarea
                id="image-template-form-prompt"
                v-model="formPrompt"
                rows="4"
                data-testid="image-template-form-prompt"
                :placeholder="t('chat.imageTemplates.formPromptPlaceholder')"
              />
              <Label>{{ t('chat.imageTemplates.formSize') }}</Label>
              <Select :model-value="formSize" @update:model-value="onSizeSelect">
                <SelectTrigger data-testid="image-template-form-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="DEFAULT_SELECT_VALUE">
                    {{ t('chat.imageTemplates.sizeDefault') }}
                  </SelectItem>
                  <SelectItem
                    v-for="size in OPENAI_IMAGE_GENERATION_SIZE_PRESETS"
                    :key="size"
                    :value="size"
                  >
                    {{ size }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Label>{{ t('chat.imageTemplates.formQuality') }}</Label>
              <Select :model-value="formQuality" @update:model-value="onQualitySelect">
                <SelectTrigger data-testid="image-template-form-quality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="DEFAULT_SELECT_VALUE">
                    {{ t('chat.imageTemplates.qualityDefault') }}
                  </SelectItem>
                  <SelectItem
                    v-for="quality in IMAGE_GENERATION_QUALITY_VALUES"
                    :key="quality"
                    :value="quality"
                  >
                    {{ quality }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p
                v-if="formError"
                data-testid="image-template-form-error"
                class="text-xs text-destructive"
              >
                {{
                  formError === 'title'
                    ? t('chat.imageTemplates.titleRequired')
                    : t('chat.imageTemplates.promptRequired')
                }}
              </p>
              <div class="flex justify-end gap-2">
                <DcButton
                  data-testid="image-template-form-cancel"
                  variant="ghost"
                  size="sm"
                  @click="cancelForm"
                >
                  {{ t('chat.imageTemplates.cancel') }}
                </DcButton>
                <DcButton data-testid="image-template-form-save" size="sm" type="submit">
                  {{ t('chat.imageTemplates.save') }}
                </DcButton>
              </div>
            </form>

            <template v-else>
              <div
                v-if="store.userTemplates.length === 0"
                data-testid="image-template-empty"
                class="px-2 py-4 text-center"
              >
                <p class="text-sm">{{ t('chat.imageTemplates.emptyMine') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {{ t('chat.imageTemplates.emptyMineHint') }}
                </p>
              </div>
              <div
                v-for="tpl in store.userTemplates"
                :key="tpl.id"
                data-testid="image-template-user-item"
                class="flex items-start gap-1 rounded-lg px-2 py-2 hover:bg-accent"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left"
                  @click="applyTemplate(tpl)"
                >
                  <span class="block text-sm">{{ tpl.title }}</span>
                  <span class="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                    {{ tpl.prompt }}
                  </span>
                </button>
                <DcButton
                  data-testid="image-template-edit"
                  variant="ghost"
                  size="icon-sm"
                  icon="lucide:pencil"
                  :label="t('chat.imageTemplates.edit')"
                  @click="openEdit(tpl)"
                />
                <DcButton
                  data-testid="image-template-delete"
                  variant="ghost"
                  size="icon-sm"
                  icon="lucide:trash-2"
                  :label="t('chat.imageTemplates.delete')"
                  @click="deleteTarget = tpl"
                />
              </div>
            </template>
          </div>
        </TabsContent>
      </Tabs>
    </PopoverContent>
  </Popover>

  <DcConfirmDialog
    :open="deleteTarget !== null"
    :title="t('chat.imageTemplates.deleteConfirmTitle')"
    :description="deleteConfirmText"
    :confirm-label="t('chat.imageTemplates.delete')"
    :cancel-label="t('chat.imageTemplates.cancel')"
    danger
    @confirm="confirmDelete"
    @update:open="
      (value: boolean) => {
        if (!value) deleteTarget = null
      }
    "
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@shadcn/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@shadcn/components/ui/tabs'
import { Input } from '@shadcn/components/ui/input'
import { Label } from '@shadcn/components/ui/label'
import { Textarea } from '@shadcn/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import { DcConfirmDialog } from '@dc-ui/components/confirm-dialog'
import {
  IMAGE_GENERATION_QUALITY_VALUES,
  OPENAI_IMAGE_GENERATION_SIZE_PRESETS
} from '@shared/imageGenerationSettings'
import {
  MAX_USER_IMAGE_PROMPT_TEMPLATES,
  type ImagePromptTemplateApplyPayload,
  type ResolvedImagePromptTemplate,
  type UserImagePromptTemplate
} from '@shared/imagePromptTemplates'
import {
  useBuiltinImagePromptTemplates,
  useImagePromptTemplatesStore
} from '@/stores/imagePromptTemplates'

const DEFAULT_SELECT_VALUE = '__default'

const emit = defineEmits<{ 'apply-template': [payload: ImagePromptTemplateApplyPayload] }>()

const { t } = useI18n()
const store = useImagePromptTemplatesStore()
const { builtinTemplates } = useBuiltinImagePromptTemplates()

const panelOpen = ref(false)
type FormMode = 'create' | 'edit' | null
const formMode = ref<FormMode>(null)
const editingId = ref<string | null>(null)
const formTitle = ref('')
const formPrompt = ref('')
const formSize = ref<string>(DEFAULT_SELECT_VALUE)
const formQuality = ref<string>(DEFAULT_SELECT_VALUE)
const formError = ref<'title' | 'prompt' | null>(null)
const deleteTarget = ref<UserImagePromptTemplate | null>(null)

const deleteConfirmText = computed(() =>
  deleteTarget.value
    ? t('chat.imageTemplates.deleteConfirmDescription', { title: deleteTarget.value.title })
    : ''
)

const templateMeta = (tpl: ResolvedImagePromptTemplate): string =>
  [tpl.size, tpl.quality].filter(Boolean).join(' · ')

onMounted(() => {
  if (!store.loaded) void store.load()
})

watch(panelOpen, (open) => {
  if (!open) {
    cancelForm()
    deleteTarget.value = null
  }
})

const openCreate = () => {
  formMode.value = 'create'
  editingId.value = null
  formTitle.value = ''
  formPrompt.value = ''
  formSize.value = DEFAULT_SELECT_VALUE
  formQuality.value = DEFAULT_SELECT_VALUE
  formError.value = null
}

const openEdit = (tpl: UserImagePromptTemplate) => {
  formMode.value = 'edit'
  editingId.value = tpl.id
  formTitle.value = tpl.title
  formPrompt.value = tpl.prompt
  formSize.value = tpl.size ?? DEFAULT_SELECT_VALUE
  formQuality.value = tpl.quality ?? DEFAULT_SELECT_VALUE
  formError.value = null
}

const cancelForm = () => {
  formMode.value = null
  editingId.value = null
  formError.value = null
}

const onSizeSelect = (value: unknown) => {
  formSize.value = String(value)
}

const onQualitySelect = (value: unknown) => {
  formQuality.value = String(value)
}

const saveForm = () => {
  const title = formTitle.value.trim()
  const prompt = formPrompt.value.trim()
  if (!title) {
    formError.value = 'title'
    return
  }
  if (!prompt) {
    formError.value = 'prompt'
    return
  }
  const size = formSize.value === DEFAULT_SELECT_VALUE ? undefined : formSize.value
  const quality =
    formQuality.value === DEFAULT_SELECT_VALUE
      ? undefined
      : (formQuality.value as UserImagePromptTemplate['quality'])
  const input = {
    title,
    prompt,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {})
  }
  if (formMode.value === 'edit' && editingId.value) {
    store.update(editingId.value, input)
  } else {
    store.add(input)
  }
  cancelForm()
}

const applyTemplate = (tpl: ResolvedImagePromptTemplate) => {
  emit('apply-template', {
    prompt: tpl.prompt,
    ...(tpl.size !== undefined ? { size: tpl.size } : {}),
    ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
  })
  panelOpen.value = false
}

const confirmDelete = () => {
  if (deleteTarget.value) {
    store.remove(deleteTarget.value.id)
  }
  deleteTarget.value = null
}
</script>
```

- [ ] **Step 2: 创建 `test/renderer/components/ImagePromptTemplateButton.test.ts`**

要点：顶层 `vi.mock` vue-i18n（t 返回 key 原样，**不插值** → 断言 limit 文案只能断言 key 存在，不能断言 '50'）、`@iconify/vue`、`@dc-ui/components/button`、`@dc-ui/components/confirm-dialog`、`@api/ConfigClient`；用**真实 pinia + 真实 store**（不 mock store 模块），mount 前 stub teleport。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'

const configMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => configMocks
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    props: { icon: { type: String, default: '' } },
    template: '<i :data-icon="icon" />'
  })
}))

vi.mock('@dc-ui/components/button', () => ({
  DcButton: defineComponent({
    name: 'DcButton',
    props: {
      label: { type: String, default: '' },
      icon: { type: String, default: '' }
    },
    template: '<button type="button" :data-icon="icon" :data-label="label"><slot /></button>'
  })
}))

vi.mock('@dc-ui/components/confirm-dialog', () => ({
  DcConfirmDialog: defineComponent({
    name: 'DcConfirmDialog',
    props: {
      open: { type: Boolean, default: false },
      title: { type: String, default: '' },
      description: { type: String, default: '' }
    },
    emits: ['confirm', 'cancel', 'update:open'],
    template: `<div v-if="open" data-testid="confirm-dialog">
      <button data-testid="confirm-dialog-confirm" @click="$emit('confirm')"></button>
      <button data-testid="confirm-dialog-cancel" @click="$emit('update:open', false)"></button>
    </div>`
  })
}))

import type { UserImagePromptTemplate } from '@shared/imagePromptTemplates'

const storedTemplate = (overrides: Partial<UserImagePromptTemplate> = {}): UserImagePromptTemplate => ({
  id: 'tpl-1',
  title: '已存范本',
  prompt: 'stored prompt',
  createdAt: 1700000000000,
  ...overrides
})

const mountButton = async (): Promise<VueWrapper> => {
  const { default: ImagePromptTemplateButton } = await import(
    '@/components/chat-input/ImagePromptTemplateButton.vue'
  )
  return mount(ImagePromptTemplateButton, {
    global: {
      plugins: [createPinia()],
      stubs: { teleport: true }
    }
  })
}

const openPanel = async (wrapper: VueWrapper) => {
  await wrapper.get('[data-testid="image-template-button"]').trigger('click')
  await flushPromises()
}

const openMineTab = async (wrapper: VueWrapper) => {
  await wrapper.get('[data-testid="image-template-tab-mine"]').trigger('click')
  await flushPromises()
}

describe('ImagePromptTemplateButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMocks.getSetting.mockResolvedValue([])
    configMocks.setSetting.mockResolvedValue(undefined)
  })

  it('精选 tab 渲染 7 张内置卡片并发出 apply-template', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    const cards = wrapper.findAll('[data-testid="image-template-card"]')
    expect(cards).toHaveLength(7)
    await cards[2].trigger('click')
    expect(wrapper.emitted('apply-template')).toEqual([
      [
        {
          prompt: 'chat.imageTemplates.builtin.poster.prompt',
          size: '1024x1536',
          quality: 'high'
        }
      ]
    ])
    wrapper.unmount()
  })

  it('我的 tab 新建范本并持久化', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    await wrapper.get('[data-testid="image-template-add"]').trigger('click')
    await wrapper.get('[data-testid="image-template-form-title"]').setValue('我的范本')
    await wrapper.get('[data-testid="image-template-form-prompt"]').setValue('red apple')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    await flushPromises()
    expect(configMocks.setSetting).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('表单校验：先缺标题后缺提示词，不持久化', async () => {
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    await wrapper.get('[data-testid="image-template-add"]').trigger('click')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    expect(wrapper.text()).toContain('chat.imageTemplates.titleRequired')
    await wrapper.get('[data-testid="image-template-form-title"]').setValue('只有标题')
    await wrapper.get('[data-testid="image-template-form"]').trigger('submit')
    expect(wrapper.text()).toContain('chat.imageTemplates.promptRequired')
    expect(configMocks.setSetting).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('删除需确认，确认后持久化空列表', async () => {
    configMocks.getSetting.mockResolvedValue([storedTemplate()])
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(1)
    await wrapper.get('[data-testid="image-template-delete"]').trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true)
    await wrapper.get('[data-testid="confirm-dialog-confirm"]').trigger('click')
    await flushPromises()
    expect(configMocks.setSetting).toHaveBeenCalledWith('user_image_prompt_templates', [])
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('达到上限后隐藏新增按钮并显示上限提示', async () => {
    configMocks.getSetting.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `tpl-${i}`,
        title: `范本${i}`,
        prompt: 'p',
        createdAt: i + 1
      }))
    )
    const wrapper = await mountButton()
    await openPanel(wrapper)
    await openMineTab(wrapper)
    expect(wrapper.find('[data-testid="image-template-add"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="image-template-limit"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="image-template-user-item"]')).toHaveLength(50)
    wrapper.unmount()
  })
})
```

- [ ] **Step 3: 运行测试**

```bash
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/components/ImagePromptTemplateButton.test.ts
```

Expected: 5 passed。若 reka-ui Popover/Tabs 在 jsdom 下渲染异常，优先检查 teleport stub 与 flushPromises 时序，不得改动被测组件行为来迁就测试。

- [ ] **Step 4: 提交**

```bash
pnpm exec oxfmt src/renderer/src/components/chat-input/ImagePromptTemplateButton.vue test/renderer/components/ImagePromptTemplateButton.test.ts
git add src/renderer/src/components/chat-input/ImagePromptTemplateButton.vue test/renderer/components/ImagePromptTemplateButton.test.ts
git commit -m "feat(renderer): image template popover panel"
```

---

### Task 6: 快捷范本卡片 ImagePromptTemplateCards + 测试

**Files:**
- Create: `src/renderer/src/components/chat-input/ImagePromptTemplateCards.vue`
- Create: `test/renderer/components/ImagePromptTemplateCards.test.ts`

输入区上方的快捷 chips：选中图像模型且输入为空时展示 7 个内置范本，点击即套用。组件仅依赖 vue-i18n 与 shared 类型（不触 pinia store，保证 pages 测试在无 pinia 环境可渲染）。

- [ ] **Step 1: 创建 `src/renderer/src/components/chat-input/ImagePromptTemplateCards.vue`**

```vue
<template>
  <div
    v-if="templates.length > 0"
    data-testid="image-template-cards"
    class="flex flex-wrap items-center gap-2 px-1 py-2"
  >
    <span class="text-xs text-muted-foreground">
      {{ t('chat.imageTemplates.emptyCardsHint') }}
    </span>
    <button
      v-for="tpl in templates"
      :key="tpl.id"
      type="button"
      data-testid="image-template-card"
      class="rounded-full border px-3 py-1 text-xs hover:bg-accent"
      @click="applyTemplate(tpl)"
    >
      {{ tpl.title }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type {
  ImagePromptTemplateApplyPayload,
  ResolvedImagePromptTemplate
} from '@shared/imagePromptTemplates'

defineProps<{ templates: ResolvedImagePromptTemplate[] }>()

const emit = defineEmits<{ 'apply-template': [payload: ImagePromptTemplateApplyPayload] }>()

const { t } = useI18n()

const applyTemplate = (tpl: ResolvedImagePromptTemplate) => {
  emit('apply-template', {
    prompt: tpl.prompt,
    ...(tpl.size !== undefined ? { size: tpl.size } : {}),
    ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
  })
}
</script>
```

- [ ] **Step 2: 创建 `test/renderer/components/ImagePromptTemplateCards.test.ts`**

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedImagePromptTemplate } from '@shared/imagePromptTemplates'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

const mountCards = async (templates: ResolvedImagePromptTemplate[]) => {
  const { default: ImagePromptTemplateCards } = await import(
    '@/components/chat-input/ImagePromptTemplateCards.vue'
  )
  return mount(ImagePromptTemplateCards, { props: { templates } })
}

describe('ImagePromptTemplateCards', () => {
  it('空数组不渲染', async () => {
    const wrapper = await mountCards([])
    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击范本发出仅含存在字段的 apply-template', async () => {
    const wrapper = await mountCards([
      { id: 'a', title: 'Design', prompt: 'design prompt', size: '1024x1024', quality: 'high' },
      { id: 'b', title: 'Mine', prompt: 'my prompt' }
    ])
    const chips = wrapper.findAll('[data-testid="image-template-card"]')
    expect(chips).toHaveLength(2)
    await chips[0].trigger('click')
    await chips[1].trigger('click')
    expect(wrapper.emitted('apply-template')).toEqual([
      [{ prompt: 'design prompt', size: '1024x1024', quality: 'high' }],
      [{ prompt: 'my prompt' }]
    ])
    wrapper.unmount()
  })
})
```

- [ ] **Step 3: 运行测试**

```bash
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/components/ImagePromptTemplateCards.test.ts
```

Expected: 2 passed。

- [ ] **Step 4: 提交**

```bash
pnpm exec oxfmt src/renderer/src/components/chat-input/ImagePromptTemplateCards.vue test/renderer/components/ImagePromptTemplateCards.test.ts
git add src/renderer/src/components/chat-input/ImagePromptTemplateCards.vue test/renderer/components/ImagePromptTemplateCards.test.ts
git commit -m "feat(renderer): image template starter cards"
```

---

### Task 7: 工具栏与页面集成 + 测试

**Files:**
- Modify: `src/renderer/src/components/chat/ChatInputToolbar.vue`
- Modify: `test/renderer/components/ChatInputToolbar.test.ts`
- Modify: `src/renderer/src/pages/NewThreadPage.vue`
- Modify: `test/renderer/pages/NewThreadPage.test.ts`

已核实的锚点（行号为当前文件状态）：ChatInputToolbar.vue 左侧按钮组 L3-16（attach DcButton 结束于 L15 `/>`，L16 `</div>`）；props L196-227（`searchEnabled?: boolean` 为最后一个类型项 / `searchEnabled: false` 为最后一个默认值）；emits L229-238（`'cancel-preparation': []` 为最后一项）。NewThreadPage.vue 输入区 L97-142（L98 `<div ref="firstChatGuideHostRef"` 为卡片插入锚点；L119-140 为 `#toolbar` 内 ChatInputToolbar 绑定，`:is-preparing-attachments="isPreparingAttachments"` 在 L133、`@cancel-preparation="cancelSubmissionPreparation"` 在 L138）；store 区 L262-277（L274 `const { t } = useI18n()`）；`message`/`attachedFiles` 在 L286-287；`chatInputRef` L307-314（含 `focusInput?: () => void`）；`composerSupportsVision` L424-437。pages 测试 setup options L8-21（`awaitReady?: boolean` 为最后一项）；draftStore mock L25-51（无 `imageGeneration` 字段、无 `updateGenerationSettings`，`pendingStartDeeplink` 硬编码于 L40-46）；enabledModels[0].models 在 L100-102 为 `[{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }]`。`draftStore.updateGenerationSettings` 是整体替换语义，故 handler 先取 `draftStore.imageGeneration ?? {}` 展开再覆盖有值字段（spec §2.5：undefined 不覆盖用户已设值）。

- [ ] **Step 1: 修改 `src/renderer/src/components/chat/ChatInputToolbar.vue`**

1a. import 区（`import { useI18n } from 'vue-i18n'` 之后）新增：

```ts
import ImagePromptTemplateButton from '@/components/chat-input/ImagePromptTemplateButton.vue'
import type { ImagePromptTemplateApplyPayload } from '@shared/imagePromptTemplates'
```

1b. props 类型项 `searchEnabled?: boolean` 后加 `showImageTemplates?: boolean`；defaults 项 `searchEnabled: false` 后加 `showImageTemplates: false`。

1c. emits 最后一项 `'cancel-preparation': []` 后加：

```ts
  'apply-template': [payload: ImagePromptTemplateApplyPayload]
```

1d. script 内 `const { t } = useI18n()` 之后加转发函数（用具名函数而非模板内联箭头，规避 vue-tsc 对模板参数的隐式 any 推断）：

```ts
const forwardApplyTemplate = (payload: ImagePromptTemplateApplyPayload) => {
  emit('apply-template', payload)
}
```

1e. 模板：attach DcButton 的 `/>`（L15）之后、左侧按钮组 `</div>`（L16）之前插入：

```html
      <ImagePromptTemplateButton
        v-if="showImageTemplates"
        @apply-template="forwardApplyTemplate"
      />
```

- [ ] **Step 2: 修改 `test/renderer/components/ChatInputToolbar.test.ts`**

2a. 顶层 mock 区（tooltip mock 块之后、`describe('ChatInputToolbar')` 之前）加子组件 stub：

```ts
vi.mock('@/components/chat-input/ImagePromptTemplateButton.vue', () => ({
  default: {
    name: 'ImagePromptTemplateButton',
    emits: ['apply-template'],
    template: '<div data-testid="image-template-button-stub" />'
  }
}))
```

2b. `describe('ChatInputToolbar', ...)` 内末尾（`hides search when the active route has no provider execution path` 用例之后、describe 闭合之前）追加 2 用例：

```ts
  it('hides the image template button by default', async () => {
    const ChatInputToolbar = (await import('@/components/chat/ChatInputToolbar.vue')).default
    const wrapper = mount(ChatInputToolbar)

    expect(wrapper.find('[data-testid="image-template-button-stub"]').exists()).toBe(false)
  })

  it('renders the image template button when enabled and forwards apply-template', async () => {
    const ChatInputToolbar = (await import('@/components/chat/ChatInputToolbar.vue')).default
    const wrapper = mount(ChatInputToolbar, { props: { showImageTemplates: true } })

    expect(wrapper.find('[data-testid="image-template-button-stub"]').exists()).toBe(true)

    wrapper
      .findComponent({ name: 'ImagePromptTemplateButton' })
      .vm.$emit('apply-template', { prompt: 'p' })
    expect(wrapper.emitted('apply-template')).toEqual([[{ prompt: 'p' }]])
  })
```

- [ ] **Step 3: 修改 `src/renderer/src/pages/NewThreadPage.vue`**

3a. import 区（与其它 `@/components`、`@/stores` 导入相邻处）新增：

```ts
import ImagePromptTemplateCards from '@/components/chat-input/ImagePromptTemplateCards.vue'
import { useBuiltinImagePromptTemplates } from '@/stores/imagePromptTemplates'
import type { ImagePromptTemplateApplyPayload } from '@shared/imagePromptTemplates'
```

（只使用 `useBuiltinImagePromptTemplates` composable——其内部仅 `useI18n`；页面 setup 不得调用 `useImagePromptTemplatesStore()`，否则两个未装 pinia 的 NewThreadPage 测试文件会崩溃。`@/stores/imagePromptTemplates` 的模块级 import 本身安全：`createConfigClient()` 延迟在 store setup 内，仅在真正实例化 store 时触 IPC。）

3b. store 区 `const { t } = useI18n()`（L274）之后加：

```ts
const { builtinTemplates } = useBuiltinImagePromptTemplates()
```

3c. `composerSupportsVision`（L424-437）之后加：

```ts
const composerSupportsImageGeneration = computed(() => {
  if (
    isAcpSelectedAgent.value ||
    !modelStore.initialized ||
    !draftStore.providerId ||
    !draftStore.modelId
  ) {
    return false
  }
  return (
    modelStore.findChatSelectableModel(draftStore.providerId, draftStore.modelId)?.model.type ===
    'imageGeneration'
  )
})
const showImageTemplateCards = computed(
  () =>
    composerSupportsImageGeneration.value &&
    message.value.length === 0 &&
    attachedFiles.value.length === 0
)
const onApplyImageTemplate = (payload: ImagePromptTemplateApplyPayload) => {
  message.value = payload.prompt
  if (payload.size !== undefined || payload.quality !== undefined) {
    const current = draftStore.imageGeneration ?? {}
    draftStore.updateGenerationSettings({
      imageGeneration: {
        ...current,
        ...(payload.size !== undefined ? { size: payload.size } : {}),
        ...(payload.quality !== undefined ? { quality: payload.quality } : {})
      }
    })
  }
  chatInputRef.value?.focusInput?.()
}
```

3d. 模板：L98 `<div ref="firstChatGuideHostRef"` 之前（输入区上方）插入：

```html
        <div v-if="showImageTemplateCards" class="w-full max-w-4xl">
          <ImagePromptTemplateCards
            :templates="builtinTemplates"
            @apply-template="onApplyImageTemplate"
          />
        </div>
```

3e. `#toolbar` 内 ChatInputToolbar 绑定：`:is-preparing-attachments="isPreparingAttachments"`（L133）后加 `:show-image-templates="composerSupportsImageGeneration"`；`@cancel-preparation="cancelSubmissionPreparation"`（L138）后加 `@apply-template="onApplyImageTemplate"`。

- [ ] **Step 4: 修改 `test/renderer/pages/NewThreadPage.test.ts`**

4a. setup options 类型（`awaitReady?: boolean` 之后）加 `skipDeeplink?: boolean`。

4b. draftStore mock 的 `pendingStartDeeplink`（L40-46）改为条件值，`skipDeeplink` 时为 `null`（message 保持为空，卡片可见）：

```ts
    pendingStartDeeplink: options?.skipDeeplink
      ? null
      : {
          token: 1,
          msg: '帮我总结一下这周的迭代状态',
          modelId: pendingModelId,
          systemPrompt: 'You are a concise project assistant.',
          mentions: ['README.md', 'docs/spec.md']
        },
```

4c. draftStore mock 的 `clearPendingStartDeeplink` 之后加 `updateGenerationSettings: vi.fn()`。

4d. enabledModels[0].models（L100-102）直接在字面量内补图像模型（内联 `type` 字段推断出联合类型，避免测试内 push 触发 excess property 检查；预置但未选中不影响既有用例——deeplink 精确/模糊匹配与 `pickFirstChatSelectableModel` 均不受第三项影响）：

```ts
        models: [
          { id: 'gpt-4o-mini' },
          { id: 'deepseek-chat' },
          { id: 'gpt-image-2', type: 'imageGeneration' }
        ]
```

4e. 文件末尾（最后一个 describe 闭合之后）追加：

```ts
describe('NewThreadPage image template cards', () => {
  it('选中图像模型且输入为空时展示范本卡片，点击填充并合并图像设置', async () => {
    const { wrapper, draftStore } = await setup('deepseek-chat', { skipDeeplink: true })

    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(false)

    draftStore.modelId = 'gpt-image-2'
    await flushPromises()

    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="image-template-card"]')).toHaveLength(7)

    await wrapper.get('[data-testid="image-template-card"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="chat-input"]').text()).toContain(
      'chat.imageTemplates.builtin.design.prompt'
    )
    expect(draftStore.updateGenerationSettings).toHaveBeenCalledWith({
      imageGeneration: { size: '1024x1024', quality: 'high' }
    })
    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(false)
  }, 20000)

  it('输入文本后隐藏范本卡片', async () => {
    const { wrapper, draftStore } = await setup('deepseek-chat', { skipDeeplink: true })

    draftStore.modelId = 'gpt-image-2'
    await flushPromises()
    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(true)

    wrapper.findComponent({ name: 'ChatInputBox' }).vm.$emit('update:modelValue', 'hello')
    await flushPromises()
    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(false)
  }, 20000)
})
```

（断言依据：mock 的 vue-i18n `t` 返回 key 本身，故第 1 个 chip 的 prompt 为 `chat.imageTemplates.builtin.design.prompt`，design 范本 size=`1024x1024`、quality=`high`；`updateGenerationSettings` 收到 `{ imageGeneration: { size: '1024x1024', quality: 'high' } }`——draftStore mock 无 `imageGeneration` 字段，`?? {}` 得空对象。点击后 message 非空 → 卡片隐藏。`test/renderer/components/NewThreadPage.test.ts` 与 onboarding 相关测试零改动：非图像模型下 `composerSupportsImageGeneration` 为 false，卡片不渲染。）

- [ ] **Step 5: 运行测试与类型检查**

```bash
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/components/ChatInputToolbar.test.ts test/renderer/pages/NewThreadPage.test.ts test/renderer/components/NewThreadPage.test.ts
pnpm run typecheck
```

Expected: ChatInputToolbar 12 用例（原 10 + 新 2）、pages NewThreadPage 全部通过（原用例 + 新 2）、components NewThreadPage 零改动仍全部通过；`typecheck:node` 与 `typecheck:web` 0 错误（依赖 Task 2 已生成含 `imageTemplates` 键的 `src/types/i18n.d.ts`）。

- [ ] **Step 6: 提交**

```bash
pnpm exec oxfmt src/renderer/src/components/chat/ChatInputToolbar.vue test/renderer/components/ChatInputToolbar.test.ts src/renderer/src/pages/NewThreadPage.vue test/renderer/pages/NewThreadPage.test.ts
git add src/renderer/src/components/chat/ChatInputToolbar.vue test/renderer/components/ChatInputToolbar.test.ts src/renderer/src/pages/NewThreadPage.vue test/renderer/pages/NewThreadPage.test.ts
git commit -m "feat(renderer): image template integration"
```

---

### Task 8: 全量门禁

- [ ] **Step 1: 格式化与静态检查**

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
```

Expected: `oxfmt .` 后 `git status` 无改动（若有仅涉及本功能文件的格式化改动，`git add` 后 `git commit --amend --no-edit` 并入前序提交；涉及无关文件则停下人工核查）；两个守卫脚本与 `oxlint` 通过；`typecheck:node` / `typecheck:web` 0 错误。

- [ ] **Step 2: i18n 校验**

```bash
pnpm run i18n
```

Expected: `i18n:validate` 通过、`i18n-check -s zh-CN` 报告 0 missing / 0 extra。

- [ ] **Step 3: renderer 全量测试**

```bash
pnpm run test:renderer
```

Expected: 全部通过，无新增失败。若既有用例因本次改动失败，修复根因而非放宽断言。

（计划完结。）
