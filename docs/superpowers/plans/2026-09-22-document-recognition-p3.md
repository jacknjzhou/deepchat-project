# 单据识别 P3：模板管理 UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置窗口新增「单据识别」Tab（模板列表 CRUD）与独立模板编辑器页（字段增删改 + 拖拽排序 + 样张测试），复用 P1 的 `documentTemplates.*` typed IPC 路由与 P2 的 `testExtract` 服务。

**Architecture:** 设置窗口是独立 Vue app（`src/renderer/settings/main.ts`），Tab 即 vue-router 路由：在 `src/shared/settingsNavigation.ts` 注册 `settings-documents`（可见 Tab）与 `settings-documents-template`（`hiddenInSidebar` 编辑器路由），组件挂到 `settingsRouteComponents.ts`。状态用新 Pinia setup store `DocumentsStore` 缓存模板列表；编辑器页用 `settingsLeaveGuard` 单例做 dirty 拦截；拖拽用 `@vueuse/integrations` 的 `useSortable`（sortablejs）。

**Tech Stack:** Vue 3 setup + Pinia 3 + vue-router 4 + vue-i18n 11 + shadcn-vue（`@shadcn/components/ui/*`、`@dc-ui/components/*`）+ @vueuse/integrations(useSortable) + sortablejs + Vitest/Vue Test Utils。

---

## 关键事实（研究者必读）

- **设置窗口路由**：`src/renderer/settings/main.ts:20-56` 用 `getSettingsRouteItems()` 生成 routes，`routeName → settingsRouteComponents[routeName]`。新增路由只需改 `settingsNavigation.ts` + `settingsRouteComponents.ts`，无需改 main.ts。
- **routeName 是字面量联合类型**（`settingsNavigation.ts:2-25`），必须同步扩展。
- **settings 组件别名**：`@api/*` → `src/renderer/api/*`；`@/stores/*` → `src/renderer/src/stores/*`；`@shared/*` → `src/shared/*`；`@shadcn/components/ui/*`；`@dc-ui/components/*`；`@renderer-notifications/rendererNotificationPort`（`notifyRenderer`）。
- **IPC 错误契约**（P1 `src/main/documents/repository.ts`）：
  - 删预置：`Cannot delete a builtin template`
  - 删有档案引用的自定义模板（未 force）：`Template has ${n} archived document(s); pass force to confirm` → 渲染层用 `/Template has (\d+) archived document/` 提取数量后弹 force 二次确认。
- **typeKey 唯一**：fork 时冲突报 `typeKey already exists: ${typeKey}`；编辑器创建保存前用 store 缓存做客户端查重。
- **文件路径获取**：`createFileClient()`（`@api/FileClient`）→ `fileClient.getPathForFile(file: File): string`（preload 走 `webUtils.getPathForFile`）。
- **测试命令**：
  - 单文件：`pnpm exec vitest run <file> --config vitest.config.renderer.ts`
  - 全量渲染层：PowerShell 下 `$env:NODE_OPTIONS='--max-old-space-size=8192'; pnpm run test:renderer`
  - i18n 校验：`pnpm run i18n`（zh-CN 源）与 `pnpm run i18n:en`；key 生成 `pnpm run i18n:types`
  - format/lint/typecheck：`pnpm run format` / `pnpm run lint` / `pnpm run typecheck`
- **测试范式**：参照 `test/renderer/components/OcrSettings.test.ts` — `vi.doMock('@api/...')` 后动态 import 组件；stub shadcn 组件；`vue-i18n` mock 成 `t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key`（断言直接匹配 key 字符串）。
- **i18n 硬约束**：20 个语言包 key 必须完全对齐（`i18n-check -s zh-CN` 强制），每个 key 都要进全部 20 个文件。
- **工作区保留项（永远不要 stage）**：`test/renderer/stores/pluginCatalogStore.test.ts`、`resources/skills/*`。
- **提交规范**：Conventional Commits ≤50 字符；直接提交 develop；禁 AI co-author；Oxfmt 单引号无分号 100 列。

## 文件结构总览

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `package.json` | 新增 @vueuse/integrations、sortablejs、@types/sortablejs |
| 修改 | `src/shared/settingsNavigation.ts` | routeName 联合类型 + 2 个导航项 |
| 修改 | `src/renderer/settings/settingsRouteComponents.ts` | 2 个路由组件映射 |
| 新建 | `src/renderer/src/stores/documents.ts` | DocumentsStore（模板列表缓存 + CRUD + testExtract 透传） |
| 新建 | `src/renderer/settings/components/documents/templateFields.ts` | 纯函数：字段增删/重排/序号归一/枚举解析/key 校验 |
| 新建 | `src/renderer/settings/components/documents/TemplateFieldsEditor.vue` | 字段行编辑 + 整行拖拽排序 |
| 新建 | `src/renderer/settings/components/documents/TemplateTestExtract.vue` | 样张测试折叠区（选文件 → testExtract → 结果表） |
| 新建 | `src/renderer/settings/components/documents/TemplateEditorPage.vue` | 编辑器独立页（新建/编辑/fork 预填 + dirty 守卫 + 保存） |
| 新建 | `src/renderer/settings/components/DocumentsSettings.vue` | 「单据识别」Tab：预置按 category 分组 + 自定义组 CRUD |
| 修改 | `src/renderer/src/i18n/{20 locale}/routes.json` | +2 key |
| 修改 | `src/renderer/src/i18n/{20 locale}/settings.json` | + documents 命名空间（66 key） |
| 新建测试 | `test/renderer/stores/documentsStore.test.ts` | store 行为 |
| 新建测试 | `test/renderer/settings/documents/templateFields.test.ts` | 纯函数 |
| 新建测试 | `test/renderer/settings/documents/TemplateFieldsEditor.test.ts` | 字段编辑/拖拽重排/readonly |
| 新建测试 | `test/renderer/settings/documents/TemplateEditorPage.test.ts` | 加载/保存/fork/readonly/dirty/查重 |
| 新建测试 | `test/renderer/settings/documents/DocumentsSettings.test.ts` | 分组/删除 force 二次确认/导航 |

## 编辑器路由与模式约定

- 路由：`settings-documents-template`，path `/documents/template/:id`（设置窗口 hash router 下实际 URL `#/documents/template/...`）。
- `:id === 'new'` → 新建模式；query `forkFrom`（预置模板 id）→ fork 预填模式：加载源模板填充表单，保存时以 `upsert` create 携带 `builtinSourceId=源 id` 落库（`documentsTemplateUpsertInputSchema` 允许 `builtinSourceId`，repository.create 持久化）。列表页「复制为自定义」直接跳 `new?forkFrom=`，保存即创建，无需 fork 弹窗（`documentTemplates.fork` 路由留给 P4/skill 使用）。
- 编辑模式加载已有模板；`isBuiltin === true` → 只读（无保存/拖拽/增删字段），显示「预置」徽标与 fork 引导。
- 样张测试在新建未保存时禁用（testExtract 需要 templateId）。
- dirty 守卫：`settingsLeaveGuard.register({ id, onDiscard })` 返回 lease，深 watch draft → `setRisk('dirty'|'clean')`；`onDiscard` 把 draft 还原为已保存快照；`onBeforeUnmount` release。

---

### Task 1: 拖拽依赖安装 + 提交计划文档

**Files:**
- Modify: `package.json`（dependencies + devDependencies）

- [x] **Step 1: 安装运行时依赖**

Run:
```bash
pnpm add @vueuse/integrations sortablejs
pnpm add -D @types/sortablejs
```
Expected: package.json 出现 `"@vueuse/integrations"`、`"sortablejs"`（dependencies）与 `"@types/sortablejs"`（devDependencies）；`@vueuse/integrations` 主版本应与 `@vueuse/core@^14.3.0` 对齐（^14.x）。若 pnpm 解析出更高主版本导致 peer 警告，改用 `pnpm add @vueuse/integrations@^14`。

- [x] **Step 2: 验证导入可用**

Run: `pnpm exec node -e "import('@vueuse/integrations/useSortable').then(m => console.log(typeof m.useSortable))"`
Expected: 输出 `function`。

- [x] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml docs/superpowers/plans/2026-09-22-document-recognition-p3.md
git commit -m "chore: add sortablejs drag deps"
```

---

### Task 2: i18n 文案（routes.json ×20 + settings.json documents 命名空间 ×20）

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/routes.json`（20 个：da-DK de-DE en-US es-ES fa-IR fr-FR he-IL id-ID it-IT ja-JP ko-KR ms-MY pl-PL pt-BR ru-RU tr-TR vi-VN zh-CN zh-HK zh-TW）
- Modify: `src/renderer/src/i18n/<locale>/settings.json`（同上 20 个）

- [x] **Step 1: zh-CN routes.json 顶层对象中追加 2 个 key**（按字母序插入合适位置，保持 JSON 合法）

```json
"settings-documents": "单据识别",
"settings-documents-template": "模板编辑器"
```

- [x] **Step 2: zh-CN settings.json 顶层追加 documents 命名空间**

```json
"documents": {
  "description": "管理单据识别模板，配置字段并测试提取效果",
  "templates": {
    "title": "单据模板",
    "builtinGroup": "预置模板",
    "customGroup": "自定义模板",
    "fieldCount": "{count} 个字段",
    "create": "新建模板",
    "view": "查看",
    "edit": "编辑",
    "fork": "复制为自定义",
    "delete": "删除",
    "deleteConfirmTitle": "删除模板",
    "deleteConfirmDescription": "确定要删除模板「{name}」吗？此操作不可撤销。",
    "deleteForceDescription": "该模板已被 {count} 份单据档案引用，确认强制删除吗？",
    "deleteFailed": "删除模板失败",
    "loadFailed": "模板列表加载失败",
    "retry": "重试",
    "empty": "还没有自定义模板"
  },
  "category": {
    "contract": "合同类",
    "travel": "出行票据类",
    "purchase": "采购类",
    "payment": "支付凭证类",
    "invoice": "发票类",
    "custom": "自定义"
  },
  "valueType": {
    "text": "文本",
    "number": "数字",
    "date": "日期",
    "array": "数组",
    "enum": "枚举"
  },
  "editor": {
    "newTitle": "新建模板",
    "notFound": "模板不存在或已被删除",
    "nameLabel": "模板名称",
    "namePlaceholder": "例如：差旅报销单",
    "nameRequired": "请填写模板名称",
    "typeKeyLabel": "类型标识",
    "typeKeyHint": "唯一标识，小写字母开头，仅含小写字母、数字与下划线",
    "typeKeyInvalid": "类型标识格式无效",
    "typeKeyTaken": "类型标识已存在：{typeKey}",
    "typeKeyImmutableHint": "类型标识创建后不可修改",
    "iconLabel": "图标",
    "iconPlaceholder": "lucide:receipt-text（可选）",
    "extractionModeLabel": "提取模式",
    "extractionModeHint": "自动按文件形态路由；视觉模型直读图片与扫描件；文本提取适合文本层 PDF",
    "mode.auto": "自动",
    "mode.vision": "视觉模型",
    "mode.text": "文本提取",
    "promptPresetLabel": "附加提取指令",
    "promptPresetPlaceholder": "需要补充给模型的提取要求（可选）",
    "fieldsTitle": "字段列表",
    "addField": "添加字段",
    "fieldKey": "字段 Key",
    "fieldLabel": "显示名",
    "fieldType": "类型",
    "fieldRequired": "必需",
    "fieldPromptHint": "提取提示",
    "fieldValidation": "校验规则",
    "fieldEnumOptions": "枚举选项",
    "fieldKeyHint": "字母或下划线开头，仅含字母、数字与下划线",
    "fieldKeyInvalid": "Key 格式无效",
    "fieldKeyDuplicated": "Key 重复",
    "fieldValidationHint": "正则表达式，或内置规则 amount_conservation / date_format",
    "fieldEnumOptionsHint": "多个选项用英文逗号分隔",
    "fieldDeleteRequiredConfirmTitle": "删除必需字段",
    "fieldDeleteRequiredConfirmDescription": "字段「{label}」标记为必需，确定要删除吗？",
    "save": "保存",
    "saving": "保存中…",
    "saveFailed": "保存失败",
    "saved": "已保存",
    "builtinBadge": "预置",
    "readonlyHint": "预置模板不可直接修改，可复制为自定义模板后编辑",
    "forkCta": "复制为自定义模板",
    "dirty": "未保存",
    "back": "返回",
    "testCreateModeHint": "模板保存后可进行样张测试"
  },
  "test": {
    "title": "样张测试",
    "description": "上传样张验证提取效果，结果不会存入档案",
    "selectFile": "选择样张",
    "reselect": "重新选择",
    "running": "识别中…",
    "failed": "识别失败",
    "duration": "耗时 {ms} ms",
    "routeVision": "视觉模型",
    "routeText": "文本提取",
    "routeOcr": "OCR",
    "fieldHeader": "字段",
    "valueHeader": "值",
    "statusHeader": "状态",
    "uncertain": "待确认",
    "issues": "提示",
    "empty": "上传样张后查看提取结果",
    "fileRequired": "未能获取样张文件路径，请重新选择"
  }
}
```

注意：`"mode.auto"` 等带点的 key 在 vue-i18n 中会被解析为嵌套路径，必须写成嵌套对象 `"mode": { "auto": "自动", "vision": "视觉模型", "text": "文本提取" }`；同样 `"routeVision"` 已用驼峰规避。上面 JSON 中 `mode.*` 三行按此规则落位为嵌套对象。

- [x] **Step 3: en-US 两文件**

routes.json：
```json
"settings-documents": "Document Recognition",
"settings-documents-template": "Template Editor"
```

settings.json documents 命名空间：
```json
"documents": {
  "description": "Manage document recognition templates, configure fields and test extraction",
  "templates": {
    "title": "Document Templates",
    "builtinGroup": "Preset Templates",
    "customGroup": "Custom Templates",
    "fieldCount": "{count} fields",
    "create": "New Template",
    "view": "View",
    "edit": "Edit",
    "fork": "Duplicate as Custom",
    "delete": "Delete",
    "deleteConfirmTitle": "Delete Template",
    "deleteConfirmDescription": "Delete template \"{name}\"? This cannot be undone.",
    "deleteForceDescription": "This template is referenced by {count} archived document(s). Force delete anyway?",
    "deleteFailed": "Failed to delete template",
    "loadFailed": "Failed to load templates",
    "retry": "Retry",
    "empty": "No custom templates yet"
  },
  "category": {
    "contract": "Contracts",
    "travel": "Travel Tickets",
    "purchase": "Purchasing",
    "payment": "Payment Proofs",
    "invoice": "Invoices",
    "custom": "Custom"
  },
  "valueType": {
    "text": "Text",
    "number": "Number",
    "date": "Date",
    "array": "Array",
    "enum": "Enum"
  },
  "editor": {
    "newTitle": "New Template",
    "notFound": "Template not found or deleted",
    "nameLabel": "Template Name",
    "namePlaceholder": "e.g. Travel Expense Form",
    "nameRequired": "Template name is required",
    "typeKeyLabel": "Type Key",
    "typeKeyHint": "Unique key, starts with a lowercase letter, lowercase letters/digits/underscores only",
    "typeKeyInvalid": "Invalid type key format",
    "typeKeyTaken": "Type key already exists: {typeKey}",
    "typeKeyImmutableHint": "Type key cannot be changed after creation",
    "iconLabel": "Icon",
    "iconPlaceholder": "lucide:receipt-text (optional)",
    "extractionModeLabel": "Extraction Mode",
    "extractionModeHint": "Auto routes by file type; vision reads images/scans directly; text fits text-layer PDFs",
    "mode": { "auto": "Auto", "vision": "Vision Model", "text": "Text Extraction" },
    "promptPresetLabel": "Extra Extraction Instructions",
    "promptPresetPlaceholder": "Additional instructions for the model (optional)",
    "fieldsTitle": "Fields",
    "addField": "Add Field",
    "fieldKey": "Field Key",
    "fieldLabel": "Display Name",
    "fieldType": "Type",
    "fieldRequired": "Required",
    "fieldPromptHint": "Extraction Hint",
    "fieldValidation": "Validation Rule",
    "fieldEnumOptions": "Enum Options",
    "fieldKeyHint": "Starts with a letter or underscore, letters/digits/underscores only",
    "fieldKeyInvalid": "Invalid key format",
    "fieldKeyDuplicated": "Duplicated key",
    "fieldValidationHint": "A regex, or builtin rule amount_conservation / date_format",
    "fieldEnumOptionsHint": "Separate options with commas",
    "fieldDeleteRequiredConfirmTitle": "Delete Required Field",
    "fieldDeleteRequiredConfirmDescription": "Field \"{label}\" is marked as required. Delete it anyway?",
    "save": "Save",
    "saving": "Saving…",
    "saveFailed": "Failed to save",
    "saved": "Saved",
    "builtinBadge": "Preset",
    "readonlyHint": "Preset templates are read-only. Duplicate as a custom template to edit",
    "forkCta": "Duplicate as Custom Template",
    "dirty": "Unsaved",
    "back": "Back",
    "testCreateModeHint": "Sample testing is available after the template is saved"
  },
  "test": {
    "title": "Sample Testing",
    "description": "Upload a sample to verify extraction. Results are not archived",
    "selectFile": "Select Sample",
    "reselect": "Reselect",
    "running": "Extracting…",
    "failed": "Extraction failed",
    "duration": "{ms} ms",
    "routeVision": "Vision Model",
    "routeText": "Text Extraction",
    "routeOcr": "OCR",
    "fieldHeader": "Field",
    "valueHeader": "Value",
    "statusHeader": "Status",
    "uncertain": "Uncertain",
    "issues": "Notes",
    "empty": "Upload a sample to see extraction results",
    "fileRequired": "Could not resolve the sample file path. Please reselect"
  }
}
```

- [x] **Step 4: 其余 18 个语言包 routes.json 追加（key 与 zh/en 相同，值为译文）**

| locale | settings-documents | settings-documents-template |
|---|---|---|
| da-DK | Dokumentgenkendelse | Skabeloneditor |
| de-DE | Belegerkennung | Vorlageneditor |
| es-ES | Reconocimiento de documentos | Editor de plantillas |
| fa-IR | شناسایی اسناد | ویرایشگر قالب |
| fr-FR | Reconnaissance de documents | Éditeur de modèle |
| he-IL | זיהוי מסמכים | עורך תבניות |
| id-ID | Pengenalan Dokumen | Editor Templat |
| it-IT | Riconoscimento documenti | Editor di modelli |
| ja-JP | 帳票認識 | テンプレートエディター |
| ko-KR | 문서 인식 | 템플릿 편집기 |
| ms-MY | Pengecaman Dokumen | Penyunting Templat |
| pl-PL | Rozpoznawanie dokumentów | Edytor szablonów |
| pt-BR | Reconhecimento de documentos | Editor de modelo |
| ru-RU | Распознавание документов | Редактор шаблонов |
| tr-TR | Belge tanıma | Şablon düzenleyici |
| vi-VN | Nhận dạng chứng từ | Trình soạn thảo mẫu |
| zh-HK | 單據識別 | 模板編輯器 |
| zh-TW | 單據識別 | 範本編輯器 |

- [x] **Step 5: 其余 18 个语言包 settings.json 追加 documents 命名空间**

以下为每个 locale 的完整 documents JSON（key 结构与 zh-CN 完全一致；`mode` 为嵌套对象，其余 key 同 zh-CN 列表）。逐一写入对应文件（保持各自 settings.json 现有 key 顺序风格，追加为顶层 `"documents"` 成员）。

**de-DE**
```json
"documents": {
  "description": "Belegvorlagen verwalten, Felder konfigurieren und Extraktion testen",
  "templates": {
    "title": "Belegvorlagen", "builtinGroup": "Vordefinierte Vorlagen", "customGroup": "Eigene Vorlagen",
    "fieldCount": "{count} Felder", "create": "Neue Vorlage", "view": "Anzeigen", "edit": "Bearbeiten",
    "fork": "Als eigene Vorlage duplizieren", "delete": "Löschen",
    "deleteConfirmTitle": "Vorlage löschen",
    "deleteConfirmDescription": "Vorlage „{name}“ löschen? Dies kann nicht rückgängig gemacht werden.",
    "deleteForceDescription": "Diese Vorlage wird von {count} archivierten Dokument(en) referenziert. Trotzdem endgültig löschen?",
    "deleteFailed": "Löschen der Vorlage fehlgeschlagen", "loadFailed": "Laden der Vorlagen fehlgeschlagen",
    "retry": "Erneut versuchen", "empty": "Noch keine eigenen Vorlagen"
  },
  "category": { "contract": "Verträge", "travel": "Reisetickets", "purchase": "Einkauf", "payment": "Zahlungsnachweise", "invoice": "Rechnungen", "custom": "Eigene" },
  "valueType": { "text": "Text", "number": "Zahl", "date": "Datum", "array": "Array", "enum": "Aufzählung" },
  "editor": {
    "newTitle": "Neue Vorlage", "notFound": "Vorlage nicht gefunden oder gelöscht",
    "nameLabel": "Vorlagenname", "namePlaceholder": "z. B. Reisespesenformular", "nameRequired": "Vorlagenname ist erforderlich",
    "typeKeyLabel": "Typ-Schlüssel",
    "typeKeyHint": "Eindeutiger Schlüssel, beginnt mit Kleinbuchstaben, nur Kleinbuchstaben/Ziffern/Unterstriche",
    "typeKeyInvalid": "Ungültiges Format des Typ-Schlüssels", "typeKeyTaken": "Typ-Schlüssel existiert bereits: {typeKey}",
    "typeKeyImmutableHint": "Der Typ-Schlüssel kann nach dem Erstellen nicht geändert werden",
    "iconLabel": "Symbol", "iconPlaceholder": "lucide:receipt-text (optional)",
    "extractionModeLabel": "Extraktionsmodus",
    "extractionModeHint": "Auto routet nach Dateityp; Vision liest Bilder/Scans direkt; Text für PDFs mit Textebene",
    "mode": { "auto": "Auto", "vision": "Vision-Modell", "text": "Textextraktion" },
    "promptPresetLabel": "Zusätzliche Extraktionshinweise", "promptPresetPlaceholder": "Zusätzliche Anweisungen für das Modell (optional)",
    "fieldsTitle": "Felder", "addField": "Feld hinzufügen",
    "fieldKey": "Feld-Schlüssel", "fieldLabel": "Anzeigename", "fieldType": "Typ", "fieldRequired": "Erforderlich",
    "fieldPromptHint": "Extraktionshinweis", "fieldValidation": "Validierungsregel", "fieldEnumOptions": "Aufzählungsoptionen",
    "fieldKeyHint": "Beginnt mit Buchstabe oder Unterstrich, nur Buchstaben/Ziffern/Unterstriche",
    "fieldKeyInvalid": "Ungültiges Schlüsselformat", "fieldKeyDuplicated": "Doppelter Schlüssel",
    "fieldValidationHint": "Ein regulärer Ausdruck oder eingebaute Regel amount_conservation / date_format",
    "fieldEnumOptionsHint": "Optionen mit Kommas trennen",
    "fieldDeleteRequiredConfirmTitle": "Erforderliches Feld löschen",
    "fieldDeleteRequiredConfirmDescription": "Feld „{label}“ ist als erforderlich markiert. Trotzdem löschen?",
    "save": "Speichern", "saving": "Speichern…", "saveFailed": "Speichern fehlgeschlagen", "saved": "Gespeichert",
    "builtinBadge": "Vordefiniert",
    "readonlyHint": "Vordefinierte Vorlagen sind schreibgeschützt. Als eigene Vorlage duplizieren, um zu bearbeiten",
    "forkCta": "Als eigene Vorlage duplizieren", "dirty": "Ungespeichert", "back": "Zurück",
    "testCreateModeHint": "Stichprobentests sind nach dem Speichern der Vorlage verfügbar"
  },
  "test": {
    "title": "Stichprobentest", "description": "Beispiel hochladen, um die Extraktion zu prüfen. Ergebnisse werden nicht archiviert",
    "selectFile": "Beispiel auswählen", "reselect": "Neu auswählen", "running": "Extraktion läuft…",
    "failed": "Extraktion fehlgeschlagen", "duration": "{ms} ms",
    "routeVision": "Vision-Modell", "routeText": "Textextraktion", "routeOcr": "OCR",
    "fieldHeader": "Feld", "valueHeader": "Wert", "statusHeader": "Status",
    "uncertain": "Unsicher", "issues": "Hinweise", "empty": "Beispiel hochladen, um Ergebnisse zu sehen",
    "fileRequired": "Dateipfad konnte nicht ermittelt werden. Bitte neu auswählen"
  }
}
```

**es-ES**
```json
"documents": {
  "description": "Gestiona plantillas de reconocimiento de documentos, configura campos y prueba la extracción",
  "templates": {
    "title": "Plantillas de documentos", "builtinGroup": "Plantillas predefinidas", "customGroup": "Plantillas personalizadas",
    "fieldCount": "{count} campos", "create": "Nueva plantilla", "view": "Ver", "edit": "Editar",
    "fork": "Duplicar como personalizada", "delete": "Eliminar",
    "deleteConfirmTitle": "Eliminar plantilla",
    "deleteConfirmDescription": "¿Eliminar la plantilla «{name}»? Esta acción no se puede deshacer.",
    "deleteForceDescription": "La plantilla está referenciada por {count} documento(s) archivado(s). ¿Forzar eliminación?",
    "deleteFailed": "Error al eliminar la plantilla", "loadFailed": "Error al cargar las plantillas",
    "retry": "Reintentar", "empty": "Aún no hay plantillas personalizadas"
  },
  "category": { "contract": "Contratos", "travel": "Billetes de viaje", "purchase": "Compras", "payment": "Justificantes de pago", "invoice": "Facturas", "custom": "Personalizada" },
  "valueType": { "text": "Texto", "number": "Número", "date": "Fecha", "array": "Array", "enum": "Enumeración" },
  "editor": {
    "newTitle": "Nueva plantilla", "notFound": "Plantilla no encontrada o eliminada",
    "nameLabel": "Nombre de la plantilla", "namePlaceholder": "p. ej. Formulario de gastos de viaje", "nameRequired": "El nombre de la plantilla es obligatorio",
    "typeKeyLabel": "Clave de tipo",
    "typeKeyHint": "Clave única, empieza por minúscula, solo minúsculas/dígitos/guiones bajos",
    "typeKeyInvalid": "Formato de clave de tipo no válido", "typeKeyTaken": "La clave de tipo ya existe: {typeKey}",
    "typeKeyImmutableHint": "La clave de tipo no se puede cambiar después de crearla",
    "iconLabel": "Icono", "iconPlaceholder": "lucide:receipt-text (opcional)",
    "extractionModeLabel": "Modo de extracción",
    "extractionModeHint": "Auto enruta por tipo de archivo; visión lee imágenes/escaneos; texto para PDF con capa de texto",
    "mode": { "auto": "Auto", "vision": "Modelo de visión", "text": "Extracción de texto" },
    "promptPresetLabel": "Instrucciones de extracción adicionales", "promptPresetPlaceholder": "Instrucciones adicionales para el modelo (opcional)",
    "fieldsTitle": "Campos", "addField": "Añadir campo",
    "fieldKey": "Clave del campo", "fieldLabel": "Nombre visible", "fieldType": "Tipo", "fieldRequired": "Obligatorio",
    "fieldPromptHint": "Pista de extracción", "fieldValidation": "Regla de validación", "fieldEnumOptions": "Opciones de enumeración",
    "fieldKeyHint": "Empieza por letra o guion bajo, solo letras/dígitos/guiones bajos",
    "fieldKeyInvalid": "Formato de clave no válido", "fieldKeyDuplicated": "Clave duplicada",
    "fieldValidationHint": "Una expresión regular o regla integrada amount_conservation / date_format",
    "fieldEnumOptionsHint": "Separa las opciones con comas",
    "fieldDeleteRequiredConfirmTitle": "Eliminar campo obligatorio",
    "fieldDeleteRequiredConfirmDescription": "El campo «{label}» está marcado como obligatorio. ¿Eliminarlo igualmente?",
    "save": "Guardar", "saving": "Guardando…", "saveFailed": "Error al guardar", "saved": "Guardado",
    "builtinBadge": "Predefinida",
    "readonlyHint": "Las plantillas predefinidas son de solo lectura. Duplica como personalizada para editar",
    "forkCta": "Duplicar como plantilla personalizada", "dirty": "Sin guardar", "back": "Volver",
    "testCreateModeHint": "Las pruebas con muestras están disponibles tras guardar la plantilla"
  },
  "test": {
    "title": "Prueba con muestras", "description": "Sube una muestra para verificar la extracción. Los resultados no se archivan",
    "selectFile": "Seleccionar muestra", "reselect": "Volver a seleccionar", "running": "Extrayendo…",
    "failed": "Extracción fallida", "duration": "{ms} ms",
    "routeVision": "Modelo de visión", "routeText": "Extracción de texto", "routeOcr": "OCR",
    "fieldHeader": "Campo", "valueHeader": "Valor", "statusHeader": "Estado",
    "uncertain": "Dudoso", "issues": "Avisos", "empty": "Sube una muestra para ver los resultados",
    "fileRequired": "No se pudo obtener la ruta del archivo. Vuelve a seleccionarlo"
  }
}
```

**fa-IR**
```json
"documents": {
  "description": "مدیریت قالب‌های شناسایی اسناد، پیکربندی فیلدها و آزمون استخراج",
  "templates": {
    "title": "قالب‌های اسناد", "builtinGroup": "قالب‌های از پیش تعریف‌شده", "customGroup": "قالب‌های سفارشی",
    "fieldCount": "{count} فیلد", "create": "قالب جدید", "view": "مشاهده", "edit": "ویرایش",
    "fork": "تکثیر به‌عنوان سفارشی", "delete": "حذف",
    "deleteConfirmTitle": "حذف قالب",
    "deleteConfirmDescription": "قالب «{name}» حذف شود؟ این عمل قابل بازگشت نیست.",
    "deleteForceDescription": "این قالب توسط {count} سند بایگانی‌شده ارجاع شده است. حذف اجباری انجام شود؟",
    "deleteFailed": "حذف قالب ناموفق بود", "loadFailed": "بارگذاری قالب‌ها ناموفق بود",
    "retry": "تلاش مجدد", "empty": "هنوز قالب سفارشی وجود ندارد"
  },
  "category": { "contract": "قراردادها", "travel": "بلیت‌های سفر", "purchase": "خرید", "payment": "مدرک پرداخت", "invoice": "صورتحساب‌ها", "custom": "سفارشی" },
  "valueType": { "text": "متن", "number": "عدد", "date": "تاریخ", "array": "آرایه", "enum": "شمارش" },
  "editor": {
    "newTitle": "قالب جدید", "notFound": "قالب یافت نشد یا حذف شده است",
    "nameLabel": "نام قالب", "namePlaceholder": "مثلاً فرم هزینه سفر", "nameRequired": "نام قالب الزامی است",
    "typeKeyLabel": "کلید نوع",
    "typeKeyHint": "کلید یکتا، با حرف کوچک آغاز می‌شود، فقط حروف کوچک/رقم/زیرخط",
    "typeKeyInvalid": "قالب کلید نوع نامعتبر است", "typeKeyTaken": "کلید نوع از قبل وجود دارد: {typeKey}",
    "typeKeyImmutableHint": "کلید نوع پس از ایجاد قابل تغییر نیست",
    "iconLabel": "نماد", "iconPlaceholder": "lucide:receipt-text (اختیاری)",
    "extractionModeLabel": "حالت استخراج",
    "extractionModeHint": "خودکار بر اساس نوع فایل مسیریابی می‌کند؛ بینایی تصویر/اسکن را مستقیم می‌خواند؛ متن برای PDF با لایه متنی",
    "mode": { "auto": "خودکار", "vision": "مدل بینایی", "text": "استخراج متن" },
    "promptPresetLabel": "دستورالعمل‌های تکمیلی استخراج", "promptPresetPlaceholder": "دستورالعمل‌های بیشتر برای مدل (اختیاری)",
    "fieldsTitle": "فیلدها", "addField": "افزودن فیلد",
    "fieldKey": "کلید فیلد", "fieldLabel": "نام نمایشی", "fieldType": "نوع", "fieldRequired": "الزامی",
    "fieldPromptHint": "راهنمای استخراج", "fieldValidation": "قاعده اعتبارسنجی", "fieldEnumOptions": "گزینه‌های شمارش",
    "fieldKeyHint": "با حرف یا زیرخط آغاز می‌شود، فقط حروف/رقم/زیرخط",
    "fieldKeyInvalid": "قالب کلید نامعتبر", "fieldKeyDuplicated": "کلید تکراری",
    "fieldValidationHint": "یک عبارت باقاعده یا قاعده داخلی amount_conservation / date_format",
    "fieldEnumOptionsHint": "گزینه‌ها را با کاما جدا کنید",
    "fieldDeleteRequiredConfirmTitle": "حذف فیلد الزامی",
    "fieldDeleteRequiredConfirmDescription": "فیلد «{label}» الزامی علامت‌گذاری شده است. با این حال حذف شود؟",
    "save": "ذخیره", "saving": "در حال ذخیره…", "saveFailed": "ذخیره ناموفق بود", "saved": "ذخیره شد",
    "builtinBadge": "پیش‌فرض",
    "readonlyHint": "قالب‌های پیش‌فرض فقط‌خواندنی هستند. برای ویرایش به‌عنوان سفارشی تکثیر کنید",
    "forkCta": "تکثیر به‌عنوان قالب سفارشی", "dirty": "ذخیره‌نشده", "back": "بازگشت",
    "testCreateModeHint": "آزمون نمونه پس از ذخیره قالب در دسترس است"
  },
  "test": {
    "title": "آزمون نمونه", "description": "نمونه‌ای بارگذاری کنید تا استخراج بررسی شود. نتایج بایگانی نمی‌شوند",
    "selectFile": "انتخاب نمونه", "reselect": "انتخاب مجدد", "running": "در حال استخراج…",
    "failed": "استخراج ناموفق بود", "duration": "{ms} میلی‌ثانیه",
    "routeVision": "مدل بینایی", "routeText": "استخراج متن", "routeOcr": "OCR",
    "fieldHeader": "فیلد", "valueHeader": "مقدار", "statusHeader": "وضعیت",
    "uncertain": "نامطمئن", "issues": "نکات", "empty": "برای دیدن نتایج نمونه‌ای بارگذاری کنید",
    "fileRequired": "مسیر فایل نمونه به دست نیامد. دوباره انتخاب کنید"
  }
}
```

**fr-FR**
```json
"documents": {
  "description": "Gérer les modèles de reconnaissance de documents, configurer les champs et tester l'extraction",
  "templates": {
    "title": "Modèles de documents", "builtinGroup": "Modèles prédéfinis", "customGroup": "Modèles personnalisés",
    "fieldCount": "{count} champs", "create": "Nouveau modèle", "view": "Consulter", "edit": "Modifier",
    "fork": "Dupliquer en personnalisé", "delete": "Supprimer",
    "deleteConfirmTitle": "Supprimer le modèle",
    "deleteConfirmDescription": "Supprimer le modèle « {name} » ? Action irréversible.",
    "deleteForceDescription": "Ce modèle est référencé par {count} document(s) archivé(s). Forcer la suppression ?",
    "deleteFailed": "Échec de la suppression du modèle", "loadFailed": "Échec du chargement des modèles",
    "retry": "Réessayer", "empty": "Aucun modèle personnalisé pour l'instant"
  },
  "category": { "contract": "Contrats", "travel": "Billets de transport", "purchase": "Achats", "payment": "Justificatifs de paiement", "invoice": "Factures", "custom": "Personnalisé" },
  "valueType": { "text": "Texte", "number": "Nombre", "date": "Date", "array": "Tableau", "enum": "Énumération" },
  "editor": {
    "newTitle": "Nouveau modèle", "notFound": "Modèle introuvable ou supprimé",
    "nameLabel": "Nom du modèle", "namePlaceholder": "ex. Formulaire de frais de déplacement", "nameRequired": "Le nom du modèle est requis",
    "typeKeyLabel": "Clé de type",
    "typeKeyHint": "Clé unique, commence par une minuscule, lettres minuscules/chiffres/underscores uniquement",
    "typeKeyInvalid": "Format de clé de type invalide", "typeKeyTaken": "La clé de type existe déjà : {typeKey}",
    "typeKeyImmutableHint": "La clé de type n'est pas modifiable après création",
    "iconLabel": "Icône", "iconPlaceholder": "lucide:receipt-text (facultatif)",
    "extractionModeLabel": "Mode d'extraction",
    "extractionModeHint": "Auto route selon le type de fichier ; vision lit images/scans ; texte pour PDF avec couche texte",
    "mode": { "auto": "Auto", "vision": "Modèle de vision", "text": "Extraction de texte" },
    "promptPresetLabel": "Consignes d'extraction supplémentaires", "promptPresetPlaceholder": "Consignes additionnelles pour le modèle (facultatif)",
    "fieldsTitle": "Champs", "addField": "Ajouter un champ",
    "fieldKey": "Clé du champ", "fieldLabel": "Nom affiché", "fieldType": "Type", "fieldRequired": "Requis",
    "fieldPromptHint": "Indice d'extraction", "fieldValidation": "Règle de validation", "fieldEnumOptions": "Options d'énumération",
    "fieldKeyHint": "Commence par une lettre ou un underscore, lettres/chiffres/underscores uniquement",
    "fieldKeyInvalid": "Format de clé invalide", "fieldKeyDuplicated": "Clé en double",
    "fieldValidationHint": "Une expression régulière ou une règle intégrée amount_conservation / date_format",
    "fieldEnumOptionsHint": "Séparez les options par des virgules",
    "fieldDeleteRequiredConfirmTitle": "Supprimer un champ requis",
    "fieldDeleteRequiredConfirmDescription": "Le champ « {label} » est marqué comme requis. Supprimer quand même ?",
    "save": "Enregistrer", "saving": "Enregistrement…", "saveFailed": "Échec de l'enregistrement", "saved": "Enregistré",
    "builtinBadge": "Prédéfini",
    "readonlyHint": "Les modèles prédéfinis sont en lecture seule. Dupliquez-les en personnalisé pour les modifier",
    "forkCta": "Dupliquer en modèle personnalisé", "dirty": "Non enregistré", "back": "Retour",
    "testCreateModeHint": "Le test sur échantillon est disponible après enregistrement du modèle"
  },
  "test": {
    "title": "Test sur échantillon", "description": "Téléversez un échantillon pour vérifier l'extraction. Les résultats ne sont pas archivés",
    "selectFile": "Choisir un échantillon", "reselect": "Remplacer", "running": "Extraction…",
    "failed": "Échec de l'extraction", "duration": "{ms} ms",
    "routeVision": "Modèle de vision", "routeText": "Extraction de texte", "routeOcr": "OCR",
    "fieldHeader": "Champ", "valueHeader": "Valeur", "statusHeader": "Statut",
    "uncertain": "Incertain", "issues": "Remarques", "empty": "Téléversez un échantillon pour voir les résultats",
    "fileRequired": "Chemin du fichier introuvable. Veuillez remplacer l'échantillon"
  }
}
```

**he-IL**
```json
"documents": {
  "description": "ניהול תבניות זיהוי מסמכים, הגדרת שדות ובדיקת חילוץ",
  "templates": {
    "title": "תבניות מסמכים", "builtinGroup": "תבניות מובנות", "customGroup": "תבניות מותאמות",
    "fieldCount": "{count} שדות", "create": "תבנית חדשה", "view": "הצג", "edit": "עריכה",
    "fork": "שכפול כמותאמת", "delete": "מחיקה",
    "deleteConfirmTitle": "מחיקת תבנית",
    "deleteConfirmDescription": "למחוק את התבנית \"{name}\"? לא ניתן לבטל פעולה זו.",
    "deleteForceDescription": "התבנית מוזכרת ב-{count} מסמכים בארכיון. לאלץ מחיקה בכל זאת?",
    "deleteFailed": "מחיקת התבנית נכשלה", "loadFailed": "טעינת התבניות נכשלה",
    "retry": "נסה שוב", "empty": "אין עדיין תבניות מותאמות"
  },
  "category": { "contract": "חוזים", "travel": "כרטיסי נסיעה", "purchase": "רכש", "payment": "אישורי תשלום", "invoice": "חשבוניות", "custom": "מותאם" },
  "valueType": { "text": "טקסט", "number": "מספר", "date": "תאריך", "array": "מערך", "enum": "ספירה" },
  "editor": {
    "newTitle": "תבנית חדשה", "notFound": "התבנית לא נמצאה או נמחקה",
    "nameLabel": "שם התבנית", "namePlaceholder": "לדוגמה: טופס הוצאות נסיעה", "nameRequired": "שם התבנית נדרש",
    "typeKeyLabel": "מזהה סוג",
    "typeKeyHint": "מזהה ייחודי, מתחיל באות קטנה באנגלית, אותיות קטנות/ספרות/קו תחתון בלבד",
    "typeKeyInvalid": "פורמט מזהה הסוג שגוי", "typeKeyTaken": "מזהה הסוג כבר קיים: {typeKey}",
    "typeKeyImmutableHint": "לא ניתן לשנות את מזהה הסוג לאחר היצירה",
    "iconLabel": "סמל", "iconPlaceholder": "lucide:receipt-text (רשות)",
    "extractionModeLabel": "מצב חילוץ",
    "extractionModeHint": "אוטומטי לפי סוג הקובץ; ראייה קורא תמונות/סריקות ישירות; טקסט ל-PDF עם שכבת טקסט",
    "mode": { "auto": "אוטומטי", "vision": "מודל ראייה", "text": "חילוץ טקסט" },
    "promptPresetLabel": "הנחיות חילוץ נוספות", "promptPresetPlaceholder": "הנחיות נוספות למודל (רשות)",
    "fieldsTitle": "שדות", "addField": "הוספת שדה",
    "fieldKey": "מפתח השדה", "fieldLabel": "שם לתצוגה", "fieldType": "סוג", "fieldRequired": "נדרש",
    "fieldPromptHint": "רמז חילוץ", "fieldValidation": "כלל אימות", "fieldEnumOptions": "אפשרויות ספירה",
    "fieldKeyHint": "מתחיל באות או קו תחתון, אותיות/ספרות/קו תחתון בלבד",
    "fieldKeyInvalid": "פורמט מפתח שגוי", "fieldKeyDuplicated": "מפתח כפול",
    "fieldValidationHint": "ביטוי רגולרי או כלל מובנה amount_conservation / date_format",
    "fieldEnumOptionsHint": "הפרדת אפשרויות בפסיקים",
    "fieldDeleteRequiredConfirmTitle": "מחיקת שדה נדרש",
    "fieldDeleteRequiredConfirmDescription": "השדה \"{label}\" מסומן כנדרש. למחוק בכל זאת?",
    "save": "שמירה", "saving": "שומר…", "saveFailed": "השמירה נכשלה", "saved": "נשמר",
    "builtinBadge": "מובנה",
    "readonlyHint": "תבניות מובנות הן לקריאה בלבד. שכפלו כמותאמת כדי לערוך",
    "forkCta": "שכפול כתבנית מותאמת", "dirty": "לא נשמר", "back": "חזרה",
    "testCreateModeHint": "בדיקת דגימה זמינה לאחר שמירת התבנית"
  },
  "test": {
    "title": "בדיקת דגימה", "description": "העלו דגימה לאימות החילוץ. התוצאות אינן נשמרות בארכיון",
    "selectFile": "בחירת דגימה", "reselect": "בחירה מחדש", "running": "מחלץ…",
    "failed": "החילוץ נכשל", "duration": "{ms} מ\"ש",
    "routeVision": "מודל ראייה", "routeText": "חילוץ טקסט", "routeOcr": "OCR",
    "fieldHeader": "שדה", "valueHeader": "ערך", "statusHeader": "מצב",
    "uncertain": "לא ודאי", "issues": "הערות", "empty": "העלו דגימה לצפייה בתוצאות",
    "fileRequired": "לא ניתן היה לאתר את נתיב הקובץ. יש לבחור מחדש"
  }
}
```

**id-ID**
```json
"documents": {
  "description": "Kelola templat pengenalan dokumen, konfigurasi field, dan uji ekstraksi",
  "templates": {
    "title": "Templat Dokumen", "builtinGroup": "Templat Bawaan", "customGroup": "Templat Kustom",
    "fieldCount": "{count} field", "create": "Templat Baru", "view": "Lihat", "edit": "Edit",
    "fork": "Duplikasi sebagai Kustom", "delete": "Hapus",
    "deleteConfirmTitle": "Hapus Templat",
    "deleteConfirmDescription": "Hapus templat \"{name}\"? Tindakan ini tidak dapat dibatalkan.",
    "deleteForceDescription": "Templat dirujuk oleh {count} dokumen arsip. Paksa hapus?",
    "deleteFailed": "Gagal menghapus templat", "loadFailed": "Gagal memuat templat",
    "retry": "Coba lagi", "empty": "Belum ada templat kustom"
  },
  "category": { "contract": "Kontrak", "travel": "Tiket Perjalanan", "purchase": "Pembelian", "payment": "Bukti Pembayaran", "invoice": "Faktur", "custom": "Kustom" },
  "valueType": { "text": "Teks", "number": "Angka", "date": "Tanggal", "array": "Array", "enum": "Enumerasi" },
  "editor": {
    "newTitle": "Templat Baru", "notFound": "Templat tidak ditemukan atau telah dihapus",
    "nameLabel": "Nama Templat", "namePlaceholder": "mis. Formulir Biaya Perjalanan", "nameRequired": "Nama templat wajib diisi",
    "typeKeyLabel": "Kunci Tipe",
    "typeKeyHint": "Kunci unik, diawali huruf kecil, hanya huruf kecil/angka/garis bawah",
    "typeKeyInvalid": "Format kunci tipe tidak valid", "typeKeyTaken": "Kunci tipe sudah ada: {typeKey}",
    "typeKeyImmutableHint": "Kunci tipe tidak dapat diubah setelah dibuat",
    "iconLabel": "Ikon", "iconPlaceholder": "lucide:receipt-text (opsional)",
    "extractionModeLabel": "Mode Ekstraksi",
    "extractionModeHint": "Otomatis merutekan berdasarkan jenis berkas; visi membaca gambar/hasil pindai; teks untuk PDF berlapis teks",
    "mode": { "auto": "Otomatis", "vision": "Model Visi", "text": "Ekstraksi Teks" },
    "promptPresetLabel": "Instruksi Ekstraksi Tambahan", "promptPresetPlaceholder": "Instruksi tambahan untuk model (opsional)",
    "fieldsTitle": "Field", "addField": "Tambah Field",
    "fieldKey": "Kunci Field", "fieldLabel": "Nama Tampilan", "fieldType": "Tipe", "fieldRequired": "Wajib",
    "fieldPromptHint": "Petunjuk Ekstraksi", "fieldValidation": "Aturan Validasi", "fieldEnumOptions": "Opsi Enumerasi",
    "fieldKeyHint": "Diawali huruf atau garis bawah, hanya huruf/angka/garis bawah",
    "fieldKeyInvalid": "Format kunci tidak valid", "fieldKeyDuplicated": "Kunci duplikat",
    "fieldValidationHint": "Sebuah regex, atau aturan bawaan amount_conservation / date_format",
    "fieldEnumOptionsHint": "Pisahkan opsi dengan koma",
    "fieldDeleteRequiredConfirmTitle": "Hapus Field Wajib",
    "fieldDeleteRequiredConfirmDescription": "Field \"{label}\" ditandai wajib. Tetap hapus?",
    "save": "Simpan", "saving": "Menyimpan…", "saveFailed": "Gagal menyimpan", "saved": "Tersimpan",
    "builtinBadge": "Bawaan",
    "readonlyHint": "Templat bawaan hanya bisa dibaca. Duplikasi sebagai kustom untuk mengedit",
    "forkCta": "Duplikasi sebagai Templat Kustom", "dirty": "Belum disimpan", "back": "Kembali",
    "testCreateModeHint": "Pengujian contoh tersedia setelah templat disimpan"
  },
  "test": {
    "title": "Uji Contoh", "description": "Unggah contoh untuk memverifikasi ekstraksi. Hasil tidak diarsipkan",
    "selectFile": "Pilih Contoh", "reselect": "Pilih Ulang", "running": "Mengekstrak…",
    "failed": "Ekstraksi gagal", "duration": "{ms} md",
    "routeVision": "Model Visi", "routeText": "Ekstraksi Teks", "routeOcr": "OCR",
    "fieldHeader": "Field", "valueHeader": "Nilai", "statusHeader": "Status",
    "uncertain": "Tidak Yakin", "issues": "Catatan", "empty": "Unggah contoh untuk melihat hasil",
    "fileRequired": "Jalur berkas contoh tidak ditemukan. Silakan pilih ulang"
  }
}
```

**it-IT**
```json
"documents": {
  "description": "Gestisci i modelli di riconoscimento documenti, configura i campi e testa l'estrazione",
  "templates": {
    "title": "Modelli di documenti", "builtinGroup": "Modelli predefiniti", "customGroup": "Modelli personalizzati",
    "fieldCount": "{count} campi", "create": "Nuovo modello", "view": "Visualizza", "edit": "Modifica",
    "fork": "Duplica come personalizzato", "delete": "Elimina",
    "deleteConfirmTitle": "Elimina modello",
    "deleteConfirmDescription": "Eliminare il modello «{name}»? L'operazione non è annullabile.",
    "deleteForceDescription": "Il modello è referenziato da {count} documento/i archiviato/i. Forzare l'eliminazione?",
    "deleteFailed": "Eliminazione del modello non riuscita", "loadFailed": "Caricamento dei modelli non riuscito",
    "retry": "Riprova", "empty": "Nessun modello personalizzato"
  },
  "category": { "contract": "Contratti", "travel": "Biglietti di viaggio", "purchase": "Acquisti", "payment": "Prove di pagamento", "invoice": "Fatture", "custom": "Personalizzato" },
  "valueType": { "text": "Testo", "number": "Numero", "date": "Data", "array": "Array", "enum": "Enumerazione" },
  "editor": {
    "newTitle": "Nuovo modello", "notFound": "Modello non trovato o eliminato",
    "nameLabel": "Nome del modello", "namePlaceholder": "es. Modulo spese di viaggio", "nameRequired": "Il nome del modello è obbligatorio",
    "typeKeyLabel": "Chiave di tipo",
    "typeKeyHint": "Chiave univoca, inizia con una lettera minuscola, solo lettere minuscole/cifre/underscore",
    "typeKeyInvalid": "Formato della chiave di tipo non valido", "typeKeyTaken": "La chiave di tipo esiste già: {typeKey}",
    "typeKeyImmutableHint": "La chiave di tipo non è modificabile dopo la creazione",
    "iconLabel": "Icona", "iconPlaceholder": "lucide:receipt-text (facoltativo)",
    "extractionModeLabel": "Modalità di estrazione",
    "extractionModeHint": "Auto instrada per tipo di file; vision legge immagini/scansioni; testo per PDF con livello di testo",
    "mode": { "auto": "Auto", "vision": "Modello di visione", "text": "Estrazione testo" },
    "promptPresetLabel": "Istruzioni di estrazione aggiuntive", "promptPresetPlaceholder": "Istruzioni aggiuntive per il modello (facoltativo)",
    "fieldsTitle": "Campi", "addField": "Aggiungi campo",
    "fieldKey": "Chiave del campo", "fieldLabel": "Nome visualizzato", "fieldType": "Tipo", "fieldRequired": "Obbligatorio",
    "fieldPromptHint": "Suggerimento di estrazione", "fieldValidation": "Regola di validazione", "fieldEnumOptions": "Opzioni enumerazione",
    "fieldKeyHint": "Inizia con lettera o underscore, solo lettere/cifre/underscore",
    "fieldKeyInvalid": "Formato chiave non valido", "fieldKeyDuplicated": "Chiave duplicata",
    "fieldValidationHint": "Un'espressione regolare o la regola integrata amount_conservation / date_format",
    "fieldEnumOptionsHint": "Separa le opzioni con virgole",
    "fieldDeleteRequiredConfirmTitle": "Elimina campo obbligatorio",
    "fieldDeleteRequiredConfirmDescription": "Il campo «{label}» è contrassegnato come obbligatorio. Eliminarlo comunque?",
    "save": "Salva", "saving": "Salvataggio…", "saveFailed": "Salvataggio non riuscito", "saved": "Salvato",
    "builtinBadge": "Predefinito",
    "readonlyHint": "I modelli predefiniti sono di sola lettura. Duplica come personalizzato per modificare",
    "forkCta": "Duplica come modello personalizzato", "dirty": "Non salvato", "back": "Indietro",
    "testCreateModeHint": "Il test su campione è disponibile dopo il salvataggio del modello"
  },
  "test": {
    "title": "Test su campione", "description": "Carica un campione per verificare l'estrazione. I risultati non vengono archiviati",
    "selectFile": "Seleziona campione", "reselect": "Seleziona di nuovo", "running": "Estrazione…",
    "failed": "Estrazione non riuscita", "duration": "{ms} ms",
    "routeVision": "Modello di visione", "routeText": "Estrazione testo", "routeOcr": "OCR",
    "fieldHeader": "Campo", "valueHeader": "Valore", "statusHeader": "Stato",
    "uncertain": "Incerto", "issues": "Note", "empty": "Carica un campione per vedere i risultati",
    "fileRequired": "Impossibile ottenere il percorso del file. Seleziona di nuovo"
  }
}
```

**ja-JP**
```json
"documents": {
  "description": "帳票認識テンプレートを管理し、フィールドを設定して抽出をテストします",
  "templates": {
    "title": "帳票テンプレート", "builtinGroup": "プリセットテンプレート", "customGroup": "カスタムテンプレート",
    "fieldCount": "{count} 個のフィールド", "create": "新規テンプレート", "view": "表示", "edit": "編集",
    "fork": "カスタムとして複製", "delete": "削除",
    "deleteConfirmTitle": "テンプレートの削除",
    "deleteConfirmDescription": "テンプレート「{name}」を削除しますか？この操作は元に戻せません。",
    "deleteForceDescription": "このテンプレートは {count} 件のアーカイブ済み文書から参照されています。強制的に削除しますか？",
    "deleteFailed": "テンプレートの削除に失敗しました", "loadFailed": "テンプレートの読み込みに失敗しました",
    "retry": "再試行", "empty": "カスタムテンプレートはまだありません"
  },
  "category": { "contract": "契約書", "travel": "交通チケット", "purchase": "購買", "payment": "支払証憑", "invoice": "請求書", "custom": "カスタム" },
  "valueType": { "text": "テキスト", "number": "数値", "date": "日付", "array": "配列", "enum": "列挙" },
  "editor": {
    "newTitle": "新規テンプレート", "notFound": "テンプレートが見つからないか削除されました",
    "nameLabel": "テンプレート名", "namePlaceholder": "例：出張経費伝票", "nameRequired": "テンプレート名は必須です",
    "typeKeyLabel": "タイプキー",
    "typeKeyHint": "一意のキー。小文字で始まり、小文字英字・数字・アンダースコアのみ使用可",
    "typeKeyInvalid": "タイプキーの形式が不正です", "typeKeyTaken": "タイプキーは既に存在します: {typeKey}",
    "typeKeyImmutableHint": "タイプキーは作成後変更できません",
    "iconLabel": "アイコン", "iconPlaceholder": "lucide:receipt-text（任意）",
    "extractionModeLabel": "抽出モード",
    "extractionModeHint": "自動はファイル形式でルーティング。ビジョンは画像・スキャンを直接読取。テキストはテキスト層 PDF 向け",
    "mode": { "auto": "自動", "vision": "ビジョンモデル", "text": "テキスト抽出" },
    "promptPresetLabel": "追加の抽出指示", "promptPresetPlaceholder": "モデルへの追加指示（任意）",
    "fieldsTitle": "フィールド一覧", "addField": "フィールドを追加",
    "fieldKey": "フィールドキー", "fieldLabel": "表示名", "fieldType": "型", "fieldRequired": "必須",
    "fieldPromptHint": "抽出ヒント", "fieldValidation": "検証ルール", "fieldEnumOptions": "列挙オプション",
    "fieldKeyHint": "英字またはアンダースコアで開始。英数字とアンダースコアのみ",
    "fieldKeyInvalid": "キーの形式が不正です", "fieldKeyDuplicated": "キーが重複しています",
    "fieldValidationHint": "正規表現、または組み込みルール amount_conservation / date_format",
    "fieldEnumOptionsHint": "オプションはカンマで区切ります",
    "fieldDeleteRequiredConfirmTitle": "必須フィールドの削除",
    "fieldDeleteRequiredConfirmDescription": "フィールド「{label}」は必須に設定されています。削除しますか？",
    "save": "保存", "saving": "保存中…", "saveFailed": "保存に失敗しました", "saved": "保存しました",
    "builtinBadge": "プリセット",
    "readonlyHint": "プリセットテンプレートは変更できません。カスタムとして複製して編集してください",
    "forkCta": "カスタムテンプレートとして複製", "dirty": "未保存", "back": "戻る",
    "testCreateModeHint": "テンプレート保存後、サンプルテストが可能になります"
  },
  "test": {
    "title": "サンプルテスト", "description": "サンプルをアップロードして抽出を検証します。結果はアーカイブされません",
    "selectFile": "サンプルを選択", "reselect": "選び直す", "running": "抽出中…",
    "failed": "抽出に失敗しました", "duration": "{ms} ms",
    "routeVision": "ビジョンモデル", "routeText": "テキスト抽出", "routeOcr": "OCR",
    "fieldHeader": "フィールド", "valueHeader": "値", "statusHeader": "状態",
    "uncertain": "要確認", "issues": "注意点", "empty": "サンプルをアップロードすると結果が表示されます",
    "fileRequired": "サンプルファイルのパスを取得できませんでした。選び直してください"
  }
}
```

**ko-KR**
```json
"documents": {
  "description": "문서 인식 템플릿을 관리하고, 필드를 구성하며, 추출을 테스트합니다",
  "templates": {
    "title": "문서 템플릿", "builtinGroup": "기본 제공 템플릿", "customGroup": "사용자 지정 템플릿",
    "fieldCount": "필드 {count}개", "create": "새 템플릿", "view": "보기", "edit": "편집",
    "fork": "사용자 지정으로 복제", "delete": "삭제",
    "deleteConfirmTitle": "템플릿 삭제",
    "deleteConfirmDescription": "템플릿 \"{name}\"을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다.",
    "deleteForceDescription": "이 템플릿은 보관된 문서 {count}건에서 참조됩니다. 강제로 삭제할까요?",
    "deleteFailed": "템플릿 삭제 실패", "loadFailed": "템플릿 로드 실패",
    "retry": "다시 시도", "empty": "아직 사용자 지정 템플릿이 없습니다"
  },
  "category": { "contract": "계약서", "travel": "교통 티켓", "purchase": "구매", "payment": "지급 증빙", "invoice": "세금계산서", "custom": "사용자 지정" },
  "valueType": { "text": "텍스트", "number": "숫자", "date": "날짜", "array": "배열", "enum": "열거형" },
  "editor": {
    "newTitle": "새 템플릿", "notFound": "템플릿을 찾을 수 없거나 삭제되었습니다",
    "nameLabel": "템플릿 이름", "namePlaceholder": "예: 출장 경비 전표", "nameRequired": "템플릿 이름은 필수입니다",
    "typeKeyLabel": "타입 키",
    "typeKeyHint": "고유 키, 소문자로 시작하며 소문자/숫자/밑줄만 사용",
    "typeKeyInvalid": "타입 키 형식이 잘못되었습니다", "typeKeyTaken": "이미 존재하는 타입 키입니다: {typeKey}",
    "typeKeyImmutableHint": "타입 키는 생성 후 변경할 수 없습니다",
    "iconLabel": "아이콘", "iconPlaceholder": "lucide:receipt-text (선택)",
    "extractionModeLabel": "추출 모드",
    "extractionModeHint": "자동은 파일 형태로 라우팅, 비전은 이미지/스캔을 직접 읽고, 텍스트는 텍스트층 PDF에 적합",
    "mode": { "auto": "자동", "vision": "비전 모델", "text": "텍스트 추출" },
    "promptPresetLabel": "추가 추출 지시", "promptPresetPlaceholder": "모델에 전달할 추가 지시 (선택)",
    "fieldsTitle": "필드 목록", "addField": "필드 추가",
    "fieldKey": "필드 키", "fieldLabel": "표시 이름", "fieldType": "유형", "fieldRequired": "필수",
    "fieldPromptHint": "추출 힌트", "fieldValidation": "검증 규칙", "fieldEnumOptions": "열거 옵션",
    "fieldKeyHint": "영문자 또는 밑줄로 시작, 영문자/숫자/밑줄만 사용",
    "fieldKeyInvalid": "키 형식이 잘못되었습니다", "fieldKeyDuplicated": "키가 중복되었습니다",
    "fieldValidationHint": "정규식 또는 내장 규칙 amount_conservation / date_format",
    "fieldEnumOptionsHint": "옵션은 쉼표로 구분",
    "fieldDeleteRequiredConfirmTitle": "필수 필드 삭제",
    "fieldDeleteRequiredConfirmDescription": "필드 \"{label}\"은(는) 필수로 표시되어 있습니다. 삭제할까요?",
    "save": "저장", "saving": "저장 중…", "saveFailed": "저장 실패", "saved": "저장됨",
    "builtinBadge": "기본 제공",
    "readonlyHint": "기본 제공 템플릿은 수정할 수 없습니다. 사용자 지정으로 복제하여 편집하세요",
    "forkCta": "사용자 지정 템플릿으로 복제", "dirty": "저장 안 됨", "back": "뒤로",
    "testCreateModeHint": "템플릿을 저장한 후 샘플 테스트를 할 수 있습니다"
  },
  "test": {
    "title": "샘플 테스트", "description": "샘플을 업로드하여 추출을 검증합니다. 결과는 보관되지 않습니다",
    "selectFile": "샘플 선택", "reselect": "다시 선택", "running": "추출 중…",
    "failed": "추출 실패", "duration": "{ms} ms",
    "routeVision": "비전 모델", "routeText": "텍스트 추출", "routeOcr": "OCR",
    "fieldHeader": "필드", "valueHeader": "값", "statusHeader": "상태",
    "uncertain": "확인 필요", "issues": "참고", "empty": "샘플을 업로드하면 결과가 표시됩니다",
    "fileRequired": "샘플 파일 경로를 가져올 수 없습니다. 다시 선택해 주세요"
  }
}
```

**ms-MY**
```json
"documents": {
  "description": "Urus templat pengecaman dokumen, konfigur medan dan uji pengekstrakan",
  "templates": {
    "title": "Templat Dokumen", "builtinGroup": "Templat Terbina Dalam", "customGroup": "Templat Tersuai",
    "fieldCount": "{count} medan", "create": "Templat Baharu", "view": "Lihat", "edit": "Sunting",
    "fork": "Pendua sebagai Tersuai", "delete": "Padam",
    "deleteConfirmTitle": "Padam Templat",
    "deleteConfirmDescription": "Padam templat \"{name}\"? Tindakan ini tidak boleh dibatalkan.",
    "deleteForceDescription": "Templat dirujuk oleh {count} dokumen arkib. Paksa padam?",
    "deleteFailed": "Gagal memadam templat", "loadFailed": "Gagal memuatkan templat",
    "retry": "Cuba lagi", "empty": "Belum ada templat tersuai"
  },
  "category": { "contract": "Kontrak", "travel": "Tiket Perjalanan", "purchase": "Pembelian", "payment": "Bukti Bayaran", "invoice": "Invois", "custom": "Tersuai" },
  "valueType": { "text": "Teks", "number": "Nombor", "date": "Tarikh", "array": "Tatasusunan", "enum": "Enumerasi" },
  "editor": {
    "newTitle": "Templat Baharu", "notFound": "Templat tidak dijumpai atau telah dipadam",
    "nameLabel": "Nama Templat", "namePlaceholder": "cth. Borang Perbelanjaan Perjalanan", "nameRequired": "Nama templat diperlukan",
    "typeKeyLabel": "Kunci Jenis",
    "typeKeyHint": "Kunci unik, bermula dengan huruf kecil, huruf kecil/digit/garis bawah sahaja",
    "typeKeyInvalid": "Format kunci jenis tidak sah", "typeKeyTaken": "Kunci jenis sudah wujud: {typeKey}",
    "typeKeyImmutableHint": "Kunci jenis tidak boleh diubah selepas dicipta",
    "iconLabel": "Ikon", "iconPlaceholder": "lucide:receipt-text (pilihan)",
    "extractionModeLabel": "Mod Pengekstrakan",
    "extractionModeHint": "Auto menghala mengikut jenis fail; visi membaca imej/imbasan terus; teks untuk PDF berlapis teks",
    "mode": { "auto": "Auto", "vision": "Model Visi", "text": "Pengekstrakan Teks" },
    "promptPresetLabel": "Arahan Pengekstrakan Tambahan", "promptPresetPlaceholder": "Arahan tambahan untuk model (pilihan)",
    "fieldsTitle": "Senarai Medan", "addField": "Tambah Medan",
    "fieldKey": "Kunci Medan", "fieldLabel": "Nama Paparan", "fieldType": "Jenis", "fieldRequired": "Wajib",
    "fieldPromptHint": "Petunjuk Pengekstrakan", "fieldValidation": "Peraturan Pengesahan", "fieldEnumOptions": "Pilihan Enumerasi",
    "fieldKeyHint": "Bermula dengan huruf atau garis bawah, huruf/digit/garis bawah sahaja",
    "fieldKeyInvalid": "Format kunci tidak sah", "fieldKeyDuplicated": "Kunci pendua",
    "fieldValidationHint": "Regex, atau peraturan terbina dalam amount_conservation / date_format",
    "fieldEnumOptionsHint": "Pisahkan pilihan dengan koma",
    "fieldDeleteRequiredConfirmTitle": "Padam Medan Wajib",
    "fieldDeleteRequiredConfirmDescription": "Medan \"{label}\" ditanda wajib. Padam juga?",
    "save": "Simpan", "saving": "Menyimpan…", "saveFailed": "Gagal menyimpan", "saved": "Disimpan",
    "builtinBadge": "Terbina Dalam",
    "readonlyHint": "Templat terbina dalam adalah baca sahaja. Pendua sebagai tersuai untuk menyunting",
    "forkCta": "Pendua sebagai Templat Tersuai", "dirty": "Belum disimpan", "back": "Kembali",
    "testCreateModeHint": "Ujian sampel tersedia selepas templat disimpan"
  },
  "test": {
    "title": "Ujian Sampel", "description": "Muat naik sampel untuk mengesahkan pengekstrakan. Hasil tidak diarkibkan",
    "selectFile": "Pilih Sampel", "reselect": "Pilih Semula", "running": "Mengekstrak…",
    "failed": "Pengekstrakan gagal", "duration": "{ms} ms",
    "routeVision": "Model Visi", "routeText": "Pengekstrakan Teks", "routeOcr": "OCR",
    "fieldHeader": "Medan", "valueHeader": "Nilai", "statusHeader": "Status",
    "uncertain": "Tidak Pasti", "issues": "Nota", "empty": "Muat naik sampel untuk melihat hasil",
    "fileRequired": "Laluan fail sampel tidak diperoleh. Sila pilih semula"
  }
}
```

**pl-PL**
```json
"documents": {
  "description": "Zarządzaj szablonami rozpoznawania dokumentów, konfiguruj pola i testuj ekstrakcję",
  "templates": {
    "title": "Szablony dokumentów", "builtinGroup": "Szablony wbudowane", "customGroup": "Szablony własne",
    "fieldCount": "{count} pól", "create": "Nowy szablon", "view": "Podgląd", "edit": "Edytuj",
    "fork": "Duplikuj jako własny", "delete": "Usuń",
    "deleteConfirmTitle": "Usuń szablon",
    "deleteConfirmDescription": "Usunąć szablon „{name}”? Tej operacji nie można cofnąć.",
    "deleteForceDescription": "Szablon jest powiązany z {count} zarchiwizowanym(i) dokumentami. Wymusi usunięcie?",
    "deleteFailed": "Nie udało się usunąć szablonu", "loadFailed": "Nie udało się wczytać szablonów",
    "retry": "Ponów", "empty": "Brak szablonów własnych"
  },
  "category": { "contract": "Umowy", "travel": "Bilety podróżne", "purchase": "Zakupy", "payment": "Potwierdzenia płatności", "invoice": "Faktury", "custom": "Własny" },
  "valueType": { "text": "Tekst", "number": "Liczba", "date": "Data", "array": "Tablica", "enum": "Wyliczenie" },
  "editor": {
    "newTitle": "Nowy szablon", "notFound": "Szablon nie istnieje lub został usunięty",
    "nameLabel": "Nazwa szablonu", "namePlaceholder": "np. Formularz wydatków podróżnych", "nameRequired": "Nazwa szablonu jest wymagana",
    "typeKeyLabel": "Klucz typu",
    "typeKeyHint": "Unikalny klucz, zaczyna się małą literą, tylko małe litery/cyfry/podkreślenia",
    "typeKeyInvalid": "Nieprawidłowy format klucza typu", "typeKeyTaken": "Klucz typu już istnieje: {typeKey}",
    "typeKeyImmutableHint": "Klucza typu nie można zmienić po utworzeniu",
    "iconLabel": "Ikona", "iconPlaceholder": "lucide:receipt-text (opcjonalnie)",
    "extractionModeLabel": "Tryb ekstrakcji",
    "extractionModeHint": "Auto kieruje wg typu pliku; wizja czyta obrazy/skan bezpośrednio; tekst dla PDF z warstwą tekstową",
    "mode": { "auto": "Auto", "vision": "Model wizji", "text": "Ekstrakcja tekstu" },
    "promptPresetLabel": "Dodatkowe instrukcje ekstrakcji", "promptPresetPlaceholder": "Dodatkowe instrukcje dla modelu (opcjonalnie)",
    "fieldsTitle": "Pola", "addField": "Dodaj pole",
    "fieldKey": "Klucz pola", "fieldLabel": "Nazwa wyświetlana", "fieldType": "Typ", "fieldRequired": "Wymagane",
    "fieldPromptHint": "Wskazówka ekstrakcji", "fieldValidation": "Reguła walidacji", "fieldEnumOptions": "Opcje wyliczenia",
    "fieldKeyHint": "Zaczyna się literą lub podkreśleniem, tylko litery/cyfry/podkreślenia",
    "fieldKeyInvalid": "Nieprawidłowy format klucza", "fieldKeyDuplicated": "Zduplikowany klucz",
    "fieldValidationHint": "Wyrażenie regularne lub wbudowana reguła amount_conservation / date_format",
    "fieldEnumOptionsHint": "Oddziel opcje przecinkami",
    "fieldDeleteRequiredConfirmTitle": "Usuń pole wymagane",
    "fieldDeleteRequiredConfirmDescription": "Pole „{label}” jest oznaczone jako wymagane. Mimo to usunąć?",
    "save": "Zapisz", "saving": "Zapisywanie…", "saveFailed": "Zapis nie powiódł się", "saved": "Zapisano",
    "builtinBadge": "Wbudowany",
    "readonlyHint": "Szablony wbudowane są tylko do odczytu. Zduplikuj jako własny, aby edytować",
    "forkCta": "Duplikuj jako szablon własny", "dirty": "Niezapisane", "back": "Wstecz",
    "testCreateModeHint": "Test na próbce jest dostępny po zapisaniu szablonu"
  },
  "test": {
    "title": "Test na próbce", "description": "Prześlij próbkę, aby zweryfikować ekstrakcję. Wyniki nie są archiwizowane",
    "selectFile": "Wybierz próbkę", "reselect": "Wybierz ponownie", "running": "Ekstrakcja…",
    "failed": "Ekstrakcja nie powiodła się", "duration": "{ms} ms",
    "routeVision": "Model wizji", "routeText": "Ekstrakcja tekstu", "routeOcr": "OCR",
    "fieldHeader": "Pole", "valueHeader": "Wartość", "statusHeader": "Status",
    "uncertain": "Niepewne", "issues": "Uwagi", "empty": "Prześlij próbkę, aby zobaczyć wyniki",
    "fileRequired": "Nie udało się uzyskać ścieżki pliku. Wybierz ponownie"
  }
}
```

**pt-BR**
```json
"documents": {
  "description": "Gerencie modelos de reconhecimento de documentos, configure campos e teste a extração",
  "templates": {
    "title": "Modelos de documentos", "builtinGroup": "Modelos predefinidos", "customGroup": "Modelos personalizados",
    "fieldCount": "{count} campos", "create": "Novo modelo", "view": "Visualizar", "edit": "Editar",
    "fork": "Duplicar como personalizado", "delete": "Excluir",
    "deleteConfirmTitle": "Excluir modelo",
    "deleteConfirmDescription": "Excluir o modelo \"{name}\"? Esta ação não pode ser desfeita.",
    "deleteForceDescription": "O modelo é referenciado por {count} documento(s) arquivado(s). Forçar exclusão?",
    "deleteFailed": "Falha ao excluir o modelo", "loadFailed": "Falha ao carregar os modelos",
    "retry": "Tentar novamente", "empty": "Nenhum modelo personalizado ainda"
  },
  "category": { "contract": "Contratos", "travel": "Bilhetes de viagem", "purchase": "Compras", "payment": "Comprovantes de pagamento", "invoice": "Faturas", "custom": "Personalizado" },
  "valueType": { "text": "Texto", "number": "Número", "date": "Data", "array": "Matriz", "enum": "Enumeração" },
  "editor": {
    "newTitle": "Novo modelo", "notFound": "Modelo não encontrado ou excluído",
    "nameLabel": "Nome do modelo", "namePlaceholder": "ex.: Formulário de despesas de viagem", "nameRequired": "O nome do modelo é obrigatório",
    "typeKeyLabel": "Chave de tipo",
    "typeKeyHint": "Chave única, começa com letra minúscula, apenas minúsculas/dígitos/underscores",
    "typeKeyInvalid": "Formato de chave de tipo inválido", "typeKeyTaken": "A chave de tipo já existe: {typeKey}",
    "typeKeyImmutableHint": "A chave de tipo não pode ser alterada após a criação",
    "iconLabel": "Ícone", "iconPlaceholder": "lucide:receipt-text (opcional)",
    "extractionModeLabel": "Modo de extração",
    "extractionModeHint": "Auto roteia por tipo de arquivo; visão lê imagens/escaneios; texto para PDFs com camada de texto",
    "mode": { "auto": "Auto", "vision": "Modelo de visão", "text": "Extração de texto" },
    "promptPresetLabel": "Instruções de extração adicionais", "promptPresetPlaceholder": "Instruções adicionais para o modelo (opcional)",
    "fieldsTitle": "Campos", "addField": "Adicionar campo",
    "fieldKey": "Chave do campo", "fieldLabel": "Nome de exibição", "fieldType": "Tipo", "fieldRequired": "Obrigatório",
    "fieldPromptHint": "Dica de extração", "fieldValidation": "Regra de validação", "fieldEnumOptions": "Opções de enumeração",
    "fieldKeyHint": "Começa com letra ou underscore, apenas letras/dígitos/underscores",
    "fieldKeyInvalid": "Formato de chave inválido", "fieldKeyDuplicated": "Chave duplicada",
    "fieldValidationHint": "Uma regex ou regra integrada amount_conservation / date_format",
    "fieldEnumOptionsHint": "Separe as opções com vírgulas",
    "fieldDeleteRequiredConfirmTitle": "Excluir campo obrigatório",
    "fieldDeleteRequiredConfirmDescription": "O campo \"{label}\" está marcado como obrigatório. Excluir mesmo assim?",
    "save": "Salvar", "saving": "Salvando…", "saveFailed": "Falha ao salvar", "saved": "Salvo",
    "builtinBadge": "Predefinido",
    "readonlyHint": "Modelos predefinidos são somente leitura. Duplique como personalizado para editar",
    "forkCta": "Duplicar como modelo personalizado", "dirty": "Não salvo", "back": "Voltar",
    "testCreateModeHint": "O teste com amostra fica disponível após salvar o modelo"
  },
  "test": {
    "title": "Teste com amostra", "description": "Envie uma amostra para verificar a extração. Os resultados não são arquivados",
    "selectFile": "Selecionar amostra", "reselect": "Reeleger arquivo", "running": "Extraindo…",
    "failed": "Falha na extração", "duration": "{ms} ms",
    "routeVision": "Modelo de visão", "routeText": "Extração de texto", "routeOcr": "OCR",
    "fieldHeader": "Campo", "valueHeader": "Valor", "statusHeader": "Status",
    "uncertain": "Incerto", "issues": "Observações", "empty": "Envie uma amostra para ver os resultados",
    "fileRequired": "Não foi possível obter o caminho do arquivo. Selecione novamente"
  }
}
```

**ru-RU**
```json
"documents": {
  "description": "Управление шаблонами распознавания документов, настройка полей и тестирование извлечения",
  "templates": {
    "title": "Шаблоны документов", "builtinGroup": "Предустановленные шаблоны", "customGroup": "Пользовательские шаблоны",
    "fieldCount": "{count} полей", "create": "Новый шаблон", "view": "Просмотр", "edit": "Изменить",
    "fork": "Дублировать как пользовательский", "delete": "Удалить",
    "deleteConfirmTitle": "Удаление шаблона",
    "deleteConfirmDescription": "Удалить шаблон «{name}»? Действие необратимо.",
    "deleteForceDescription": "На шаблон ссылаются архивированные документы ({count}). Принудительно удалить?",
    "deleteFailed": "Не удалось удалить шаблон", "loadFailed": "Не удалось загрузить шаблоны",
    "retry": "Повторить", "empty": "Пользовательских шаблонов пока нет"
  },
  "category": { "contract": "Договоры", "travel": "Проездные билеты", "purchase": "Закупки", "payment": "Платёжные подтверждения", "invoice": "Счета", "custom": "Пользовательский" },
  "valueType": { "text": "Текст", "number": "Число", "date": "Дата", "array": "Массив", "enum": "Перечисление" },
  "editor": {
    "newTitle": "Новый шаблон", "notFound": "Шаблон не найден или удалён",
    "nameLabel": "Название шаблона", "namePlaceholder": "напр. Авансовый отчёт по командировке", "nameRequired": "Укажите название шаблона",
    "typeKeyLabel": "Ключ типа",
    "typeKeyHint": "Уникальный ключ, начинается со строчной буквы, только строчные буквы/цифры/подчёркивания",
    "typeKeyInvalid": "Недопустимый формат ключа типа", "typeKeyTaken": "Ключ типа уже существует: {typeKey}",
    "typeKeyImmutableHint": "Ключ типа нельзя изменить после создания",
    "iconLabel": "Значок", "iconPlaceholder": "lucide:receipt-text (необязательно)",
    "extractionModeLabel": "Режим извлечения",
    "extractionModeHint": "Авто маршрутизирует по типу файла; vision читает изображения/сканы; текст — для PDF с текстовым слоем",
    "mode": { "auto": "Авто", "vision": "Визуальная модель", "text": "Извлечение текста" },
    "promptPresetLabel": "Дополнительные инструкции извлечения", "promptPresetPlaceholder": "Дополнительные указания для модели (необязательно)",
    "fieldsTitle": "Поля", "addField": "Добавить поле",
    "fieldKey": "Ключ поля", "fieldLabel": "Отображаемое имя", "fieldType": "Тип", "fieldRequired": "Обязательное",
    "fieldPromptHint": "Подсказка извлечения", "fieldValidation": "Правило проверки", "fieldEnumOptions": "Варианты перечисления",
    "fieldKeyHint": "Начинается с буквы или подчёркивания, только буквы/цифры/подчёркивания",
    "fieldKeyInvalid": "Недопустимый формат ключа", "fieldKeyDuplicated": "Дублирующийся ключ",
    "fieldValidationHint": "Регулярное выражение или встроенное правило amount_conservation / date_format",
    "fieldEnumOptionsHint": "Разделяйте варианты запятыми",
    "fieldDeleteRequiredConfirmTitle": "Удаление обязательного поля",
    "fieldDeleteRequiredConfirmDescription": "Поле «{label}» помечено как обязательное. Всё равно удалить?",
    "save": "Сохранить", "saving": "Сохранение…", "saveFailed": "Не удалось сохранить", "saved": "Сохранено",
    "builtinBadge": "Предустановлен",
    "readonlyHint": "Предустановленные шаблоны доступны только для чтения. Дублируйте как пользовательский для изменения",
    "forkCta": "Дублировать как пользовательский шаблон", "dirty": "Не сохранено", "back": "Назад",
    "testCreateModeHint": "Тестирование на образце доступно после сохранения шаблона"
  },
  "test": {
    "title": "Тест на образце", "description": "Загрузите образец, чтобы проверить извлечение. Результаты не архивируются",
    "selectFile": "Выбрать образец", "reselect": "Выбрать заново", "running": "Извлечение…",
    "failed": "Не удалось выполнить извлечение", "duration": "{ms} мс",
    "routeVision": "Визуальная модель", "routeText": "Извлечение текста", "routeOcr": "OCR",
    "fieldHeader": "Поле", "valueHeader": "Значение", "statusHeader": "Статус",
    "uncertain": "Неточно", "issues": "Замечания", "empty": "Загрузите образец, чтобы увидеть результаты",
    "fileRequired": "Не удалось получить путь к файлу. Выберите образец заново"
  }
}
```

**tr-TR**
```json
"documents": {
  "description": "Belge tanıma şablonlarını yönet, alanları yapılandır ve çıkarmayı test et",
  "templates": {
    "title": "Belge Şablonları", "builtinGroup": "Hazır Şablonlar", "customGroup": "Özel Şablonlar",
    "fieldCount": "{count} alan", "create": "Yeni Şablon", "view": "Görüntüle", "edit": "Düzenle",
    "fork": "Özel olarak çoğalt", "delete": "Sil",
    "deleteConfirmTitle": "Şablonu Sil",
    "deleteConfirmDescription": "\"{name}\" şablonu silinsin mi? Bu işlem geri alınamaz.",
    "deleteForceDescription": "Şablon {count} arşivlenmiş belge tarafından kullanılıyor. Yine de silinsin mi?",
    "deleteFailed": "Şablon silinemedi", "loadFailed": "Şablonlar yüklenemedi",
    "retry": "Yeniden dene", "empty": "Henüz özel şablon yok"
  },
  "category": { "contract": "Sözleşmeler", "travel": "Seyahat Biletleri", "purchase": "Satın Alma", "payment": "Ödeme Belgeleri", "invoice": "Faturalar", "custom": "Özel" },
  "valueType": { "text": "Metin", "number": "Sayı", "date": "Tarih", "array": "Dizi", "enum": "Numaralama" },
  "editor": {
    "newTitle": "Yeni Şablon", "notFound": "Şablon bulunamadı veya silindi",
    "nameLabel": "Şablon Adı", "namePlaceholder": "örn. Seyahat Gider Formu", "nameRequired": "Şablon adı gerekli",
    "typeKeyLabel": "Tür Anahtarı",
    "typeKeyHint": "Benzersiz anahtar, küçük harfle başlar, yalnızca küçük harf/rakam/alt çizgi",
    "typeKeyInvalid": "Tür anahtarı biçimi geçersiz", "typeKeyTaken": "Tür anahtarı zaten var: {typeKey}",
    "typeKeyImmutableHint": "Tür anahtarı oluşturulduktan sonra değiştirilemez",
    "iconLabel": "Simge", "iconPlaceholder": "lucide:receipt-text (isteğe bağlı)",
    "extractionModeLabel": "Çıkarma Modu",
    "extractionModeHint": "Otomatik dosya türüne göre yönlendirir; görsel model resim/taramayı doğrudan okur; metin, metin katmanlı PDF için",
    "mode": { "auto": "Otomatik", "vision": "Görsel Model", "text": "Metin Çıkarma" },
    "promptPresetLabel": "Ek Çıkarma Talimatları", "promptPresetPlaceholder": "Modele verilecek ek talimatlar (isteğe bağlı)",
    "fieldsTitle": "Alanlar", "addField": "Alan Ekle",
    "fieldKey": "Alan Anahtarı", "fieldLabel": "Görünen Ad", "fieldType": "Tür", "fieldRequired": "Zorunlu",
    "fieldPromptHint": "Çıkarma İpucu", "fieldValidation": "Doğrulama Kuralı", "fieldEnumOptions": "Numaralama Seçenekleri",
    "fieldKeyHint": "Harf veya alt çizgiyle başlar, yalnızca harf/rakam/alt çizgi",
    "fieldKeyInvalid": "Anahtar biçimi geçersiz", "fieldKeyDuplicated": "Anahtar yineleniyor",
    "fieldValidationHint": "Bir regex veya yerleşik kural amount_conservation / date_format",
    "fieldEnumOptionsHint": "Seçenekleri virgülle ayırın",
    "fieldDeleteRequiredConfirmTitle": "Zorunlu Alanı Sil",
    "fieldDeleteRequiredConfirmDescription": "\"{label}\" alanı zorunlu olarak işaretli. Yine de silinsin mi?",
    "save": "Kaydet", "saving": "Kaydediliyor…", "saveFailed": "Kaydedilemedi", "saved": "Kaydedildi",
    "builtinBadge": "Hazır",
    "readonlyHint": "Hazır şablonlar salt okunurdur. Düzenlemek için özel olarak çoğaltın",
    "forkCta": "Özel Şablon Olarak Çoğalt", "dirty": "Kaydedilmedi", "back": "Geri",
    "testCreateModeHint": "Şablon kaydedildikten sonra örnek testi yapılabilir"
  },
  "test": {
    "title": "Örnek Testi", "description": "Çıkarmayı doğrulamak için örnek yükleyin. Sonuçlar arşivlenmez",
    "selectFile": "Örnek Seç", "reselect": "Yeniden Seç", "running": "Çıkarılıyor…",
    "failed": "Çıkarma başarısız", "duration": "{ms} ms",
    "routeVision": "Görsel Model", "routeText": "Metin Çıkarma", "routeOcr": "OCR",
    "fieldHeader": "Alan", "valueHeader": "Değer", "statusHeader": "Durum",
    "uncertain": "Emin Değil", "issues": "Notlar", "empty": "Sonuçları görmek için örnek yükleyin",
    "fileRequired": "Örnek dosya yolu alınamadı. Lütfen yeniden seçin"
  }
}
```

**vi-VN**
```json
"documents": {
  "description": "Quản lý mẫu nhận dạng chứng từ, cấu hình trường và kiểm tra trích xuất",
  "templates": {
    "title": "Mẫu chứng từ", "builtinGroup": "Mẫu dựng sẵn", "customGroup": "Mẫu tùy chỉnh",
    "fieldCount": "{count} trường", "create": "Tạo mẫu mới", "view": "Xem", "edit": "Chỉnh sửa",
    "fork": "Nhân bản thành tùy chỉnh", "delete": "Xóa",
    "deleteConfirmTitle": "Xóa mẫu",
    "deleteConfirmDescription": "Xóa mẫu \"{name}\"? Thao tác này không thể hoàn tác.",
    "deleteForceDescription": "Mẫu đang được {count} hồ sơ lưu trữ tham chiếu. Vẫn ép xóa?",
    "deleteFailed": "Xóa mẫu thất bại", "loadFailed": "Tải mẫu thất bại",
    "retry": "Thử lại", "empty": "Chưa có mẫu tùy chỉnh"
  },
  "category": { "contract": "Hợp đồng", "travel": "Vé đi lại", "purchase": "Mua hàng", "payment": "Bằng chứng thanh toán", "invoice": "Hóa đơn", "custom": "Tùy chỉnh" },
  "valueType": { "text": "Văn bản", "number": "Số", "date": "Ngày", "array": "Mảng", "enum": "Liệt kê" },
  "editor": {
    "newTitle": "Mẫu mới", "notFound": "Không tìm thấy mẫu hoặc mẫu đã bị xóa",
    "nameLabel": "Tên mẫu", "namePlaceholder": "vd. Phiếu chi phí công tác", "nameRequired": "Vui lòng nhập tên mẫu",
    "typeKeyLabel": "Khóa loại",
    "typeKeyHint": "Khóa duy nhất, bắt đầu bằng chữ thường, chỉ gồm chữ thường/chữ số/gạch dưới",
    "typeKeyInvalid": "Định dạng khóa loại không hợp lệ", "typeKeyTaken": "Khóa loại đã tồn tại: {typeKey}",
    "typeKeyImmutableHint": "Khóa loại không thể thay đổi sau khi tạo",
    "iconLabel": "Biểu tượng", "iconPlaceholder": "lucide:receipt-text (tùy chọn)",
    "extractionModeLabel": "Chế độ trích xuất",
    "extractionModeHint": "Tự động định tuyến theo loại tệp; thị giác đọc ảnh/bản_scan trực tiếp; văn bản cho PDF có lớp văn bản",
    "mode": { "auto": "Tự động", "vision": "Mô hình thị giác", "text": "Trích xuất văn bản" },
    "promptPresetLabel": "Chỉ thị trích xuất bổ sung", "promptPresetPlaceholder": "Chỉ thị bổ sung cho mô hình (tùy chọn)",
    "fieldsTitle": "Danh sách trường", "addField": "Thêm trường",
    "fieldKey": "Khóa trường", "fieldLabel": "Tên hiển thị", "fieldType": "Loại", "fieldRequired": "Bắt buộc",
    "fieldPromptHint": "Gợi ý trích xuất", "fieldValidation": "Quy tắc kiểm tra", "fieldEnumOptions": "Tùy chọn liệt kê",
    "fieldKeyHint": "Bắt đầu bằng chữ cái hoặc gạch dưới, chỉ gồm chữ/chữ số/gạch dưới",
    "fieldKeyInvalid": "Định dạng khóa không hợp lệ", "fieldKeyDuplicated": "Khóa trùng lặp",
    "fieldValidationHint": "Biểu thức chính quy, hoặc quy tắc có sẵn amount_conservation / date_format",
    "fieldEnumOptionsHint": "Phân tách tùy chọn bằng dấu phẩy",
    "fieldDeleteRequiredConfirmTitle": "Xóa trường bắt buộc",
    "fieldDeleteRequiredConfirmDescription": "Trường \"{label}\" được đánh dấu bắt buộc. Vẫn xóa chứ?",
    "save": "Lưu", "saving": "Đang lưu…", "saveFailed": "Lưu thất bại", "saved": "Đã lưu",
    "builtinBadge": "Dựng sẵn",
    "readonlyHint": "Mẫu dựng sẵn chỉ được xem. Nhân bản thành tùy chỉnh để chỉnh sửa",
    "forkCta": "Nhân bản thành mẫu tùy chỉnh", "dirty": "Chưa lưu", "back": "Quay lại",
    "testCreateModeHint": "Kiểm tra mẫu vật khả dụng sau khi lưu mẫu"
  },
  "test": {
    "title": "Kiểm tra mẫu vật", "description": "Tải lên mẫu vật để xác minh trích xuất. Kết quả không được lưu trữ",
    "selectFile": "Chọn mẫu vật", "reselect": "Chọn lại", "running": "Đang trích xuất…",
    "failed": "Trích xuất thất bại", "duration": "{ms} ms",
    "routeVision": "Mô hình thị giác", "routeText": "Trích xuất văn bản", "routeOcr": "OCR",
    "fieldHeader": "Trường", "valueHeader": "Giá trị", "statusHeader": "Trạng thái",
    "uncertain": "Cần xác nhận", "issues": "Lưu ý", "empty": "Tải lên mẫu vật để xem kết quả",
    "fileRequired": "Không lấy được đường dẫn tệp mẫu. Vui lòng chọn lại"
  }
}
```

**zh-HK**
```json
"documents": {
  "description": "管理單據識別模板，配置欄位並測試擷取效果",
  "templates": {
    "title": "單據模板", "builtinGroup": "預置模板", "customGroup": "自訂模板",
    "fieldCount": "{count} 個欄位", "create": "新建模板", "view": "查看", "edit": "編輯",
    "fork": "複製為自訂", "delete": "刪除",
    "deleteConfirmTitle": "刪除模板",
    "deleteConfirmDescription": "確定要刪除模板「{name}」嗎？此操作不可復原。",
    "deleteForceDescription": "該模板已被 {count} 份單據檔案引用，確認強制刪除嗎？",
    "deleteFailed": "刪除模板失敗", "loadFailed": "載入模板清單失敗",
    "retry": "重試", "empty": "還沒有自訂模板"
  },
  "category": { "contract": "合約類", "travel": "出行票據類", "purchase": "採購類", "payment": "支付憑證類", "invoice": "發票類", "custom": "自訂" },
  "valueType": { "text": "文字", "number": "數字", "date": "日期", "array": "陣列", "enum": "列舉" },
  "editor": {
    "newTitle": "新建模板", "notFound": "模板不存在或已被刪除",
    "nameLabel": "模板名稱", "namePlaceholder": "例如：差旅報銷單", "nameRequired": "請填寫模板名稱",
    "typeKeyLabel": "類型標識",
    "typeKeyHint": "唯一標識，小寫字母開頭，僅含小寫字母、數字與底線",
    "typeKeyInvalid": "類型標識格式無效", "typeKeyTaken": "類型標識已存在：{typeKey}",
    "typeKeyImmutableHint": "類型標識建立後不可修改",
    "iconLabel": "圖示", "iconPlaceholder": "lucide:receipt-text（可選）",
    "extractionModeLabel": "擷取模式",
    "extractionModeHint": "自動按檔案形態路由；視覺模型直讀圖片與掃描件；文字擷取適合有文字層的 PDF",
    "mode": { "auto": "自動", "vision": "視覺模型", "text": "文字擷取" },
    "promptPresetLabel": "附加擷取指令", "promptPresetPlaceholder": "需要補充給模型的擷取要求（可選）",
    "fieldsTitle": "欄位清單", "addField": "新增欄位",
    "fieldKey": "欄位 Key", "fieldLabel": "顯示名稱", "fieldType": "類型", "fieldRequired": "必需",
    "fieldPromptHint": "擷取提示", "fieldValidation": "校驗規則", "fieldEnumOptions": "列舉選項",
    "fieldKeyHint": "字母或底線開頭，僅含字母、數字與底線",
    "fieldKeyInvalid": "Key 格式無效", "fieldKeyDuplicated": "Key 重複",
    "fieldValidationHint": "正規表示式，或內建規則 amount_conservation / date_format",
    "fieldEnumOptionsHint": "多個選項用英文逗號分隔",
    "fieldDeleteRequiredConfirmTitle": "刪除必需欄位",
    "fieldDeleteRequiredConfirmDescription": "欄位「{label}」已標記為必需，確定要刪除嗎？",
    "save": "儲存", "saving": "儲存中…", "saveFailed": "儲存失敗", "saved": "已儲存",
    "builtinBadge": "預置",
    "readonlyHint": "預置模板不可直接修改，可複製為自訂模板後編輯",
    "forkCta": "複製為自訂模板", "dirty": "未儲存", "back": "返回",
    "testCreateModeHint": "模板儲存後可進行樣張測試"
  },
  "test": {
    "title": "樣張測試", "description": "上傳樣張驗證擷取效果，結果不會存入檔案",
    "selectFile": "選擇樣張", "reselect": "重新選擇", "running": "識別中…",
    "failed": "識別失敗", "duration": "耗時 {ms} ms",
    "routeVision": "視覺模型", "routeText": "文字擷取", "routeOcr": "OCR",
    "fieldHeader": "欄位", "valueHeader": "值", "statusHeader": "狀態",
    "uncertain": "待確認", "issues": "提示", "empty": "上傳樣張後查看擷取結果",
    "fileRequired": "無法取得樣張檔案路徑，請重新選擇"
  }
}
```

**zh-TW**
```json
"documents": {
  "description": "管理單據識別範本，設定欄位並測試擷取效果",
  "templates": {
    "title": "單據範本", "builtinGroup": "預設範本", "customGroup": "自訂範本",
    "fieldCount": "{count} 個欄位", "create": "新增範本", "view": "檢視", "edit": "編輯",
    "fork": "複製為自訂", "delete": "刪除",
    "deleteConfirmTitle": "刪除範本",
    "deleteConfirmDescription": "確定要刪除範本「{name}」嗎？此操作無法復原。",
    "deleteForceDescription": "此範本已被 {count} 份單據檔案參照，確認強制刪除嗎？",
    "deleteFailed": "刪除範本失敗", "loadFailed": "載入範本清單失敗",
    "retry": "重試", "empty": "尚無自訂範本"
  },
  "category": { "contract": "合約類", "travel": "出行票據類", "purchase": "採購類", "payment": "支付憑證類", "invoice": "發票類", "custom": "自訂" },
  "valueType": { "text": "文字", "number": "數字", "date": "日期", "array": "陣列", "enum": "列舉" },
  "editor": {
    "newTitle": "新增範本", "notFound": "範本不存在或已被刪除",
    "nameLabel": "範本名稱", "namePlaceholder": "例如：差旅報銷單", "nameRequired": "請填寫範本名稱",
    "typeKeyLabel": "類型識別碼",
    "typeKeyHint": "唯一識別碼，小寫字母開頭，僅含小寫字母、數字與底線",
    "typeKeyInvalid": "類型識別碼格式無效", "typeKeyTaken": "類型識別碼已存在：{typeKey}",
    "typeKeyImmutableHint": "類型識別碼建立後不可修改",
    "iconLabel": "圖示", "iconPlaceholder": "lucide:receipt-text（選填）",
    "extractionModeLabel": "擷取模式",
    "extractionModeHint": "自動依檔案型態路由；視覺模型直接讀取圖片與掃描件；文字擷取適合有文字層的 PDF",
    "mode": { "auto": "自動", "vision": "視覺模型", "text": "文字擷取" },
    "promptPresetLabel": "附加擷取指示", "promptPresetPlaceholder": "需要補充給模型的擷取要求（選填）",
    "fieldsTitle": "欄位清單", "addField": "新增欄位",
    "fieldKey": "欄位 Key", "fieldLabel": "顯示名稱", "fieldType": "類型", "fieldRequired": "必要",
    "fieldPromptHint": "擷取提示", "fieldValidation": "驗證規則", "fieldEnumOptions": "列舉選項",
    "fieldKeyHint": "字母或底線開頭，僅含字母、數字與底線",
    "fieldKeyInvalid": "Key 格式無效", "fieldKeyDuplicated": "Key 重複",
    "fieldValidationHint": "正規表示式，或內建規則 amount_conservation / date_format",
    "fieldEnumOptionsHint": "多個選項以半形逗號分隔",
    "fieldDeleteRequiredConfirmTitle": "刪除必要欄位",
    "fieldDeleteRequiredConfirmDescription": "欄位「{label}」已標記為必要，確定要刪除嗎？",
    "save": "儲存", "saving": "儲存中…", "saveFailed": "儲存失敗", "saved": "已儲存",
    "builtinBadge": "預設",
    "readonlyHint": "預設範本不可直接修改，可複製為自訂範本後編輯",
    "forkCta": "複製為自訂範本", "dirty": "未儲存", "back": "返回",
    "testCreateModeHint": "範本儲存後可進行樣張測試"
  },
  "test": {
    "title": "樣張測試", "description": "上傳樣張驗證擷取效果，結果不會存入檔案",
    "selectFile": "選擇樣張", "reselect": "重新選擇", "running": "辨識中…",
    "failed": "辨識失敗", "duration": "耗時 {ms} ms",
    "routeVision": "視覺模型", "routeText": "文字擷取", "routeOcr": "OCR",
    "fieldHeader": "欄位", "valueHeader": "值", "statusHeader": "狀態",
    "uncertain": "待確認", "issues": "提示", "empty": "上傳樣張後查看擷取結果",
    "fileRequired": "無法取得樣張檔案路徑，請重新選擇"
  }
}
```

**da-DK**
```json
"documents": {
  "description": "Administrer dokumentgenkendelsesskabeloner, konfigurer felter og test udtræk",
  "templates": {
    "title": "Documentskabeloner", "builtinGroup": "Indbyggede skabeloner", "customGroup": "Brugerdefinerede skabeloner",
    "fieldCount": "{count} felter", "create": "Ny skabelon", "view": "Vis", "edit": "Rediger",
    "fork": "Dupliker som brugerdefineret", "delete": "Slet",
    "deleteConfirmTitle": "Slet skabelon",
    "deleteConfirmDescription": "Vil du slette skabelonen \"{name}\"? Dette kan ikke fortrydes.",
    "deleteForceDescription": "Skabelonen bruges af {count} arkiveret(te) dokument(er). Tving sletning?",
    "deleteFailed": "Kunne ikke slette skabelonen", "loadFailed": "Kunne ikke indlæse skabelonerne",
    "retry": "Prøv igen", "empty": "Ingen brugerdefinerede skabeloner endnu"
  },
  "category": { "contract": "Kontrakter", "travel": "Rejsebilleter", "purchase": "Indkøb", "payment": "Betalingsbeviser", "invoice": "Fakturaer", "custom": "Brugerdefineret" },
  "valueType": { "text": "Tekst", "number": "Tal", "date": "Dato", "array": "Matrix", "enum": "Fast værdi" },
  "editor": {
    "newTitle": "Ny skabelon", "notFound": "Skabelonen blev ikke fundet eller er slettet",
    "nameLabel": "Skabelonnavn", "namePlaceholder": "fx Rejseudgiftsformular", "nameRequired": "Skabelonnavn er påkrævet",
    "typeKeyLabel": "Type-nøgle",
    "typeKeyHint": "Unik nøgle, starter med lille bogstav, kun små bogstaver/tal/understreger",
    "typeKeyInvalid": "Ugyldigt format for type-nøgle", "typeKeyTaken": "Type-nøglen findes allerede: {typeKey}",
    "typeKeyImmutableHint": "Type-nøglen kan ikke ændres efter oprettelse",
    "iconLabel": "Ikon", "iconPlaceholder": "lucide:receipt-text (valgfrit)",
    "extractionModeLabel": "Udtræksmetode",
    "extractionModeHint": "Auto路由 efter filtype; vision læser billeder/scanninger direkte; tekst til PDF med tekstlag",
    "mode": { "auto": "Auto", "vision": "Vision-model", "text": "Tekstudtræk" },
    "promptPresetLabel": "Ekstra udtræksinstruktioner", "promptPresetPlaceholder": "Yderligere instruktioner til modellen (valgfrit)",
    "fieldsTitle": "Felter", "addField": "Tilføj felt",
    "fieldKey": "Feltnøgle", "fieldLabel": "Visningsnavn", "fieldType": "Type", "fieldRequired": "Påkrævet",
    "fieldPromptHint": "Udtrækstip", "fieldValidation": "Valideringsregel", "fieldEnumOptions": "Fast værdi-muligheder",
    "fieldKeyHint": "Starter med bogstav eller understreg, kun bogstaver/tal/understreger",
    "fieldKeyInvalid": "Ugyldigt nøgleformat", "fieldKeyDuplicated": "Nøglen duplikeret",
    "fieldValidationHint": "Et regex eller den indbyggede regel amount_conservation / date_format",
    "fieldEnumOptionsHint": "Adskil muligheder med kommaer",
    "fieldDeleteRequiredConfirmTitle": "Slet påkrævet felt",
    "fieldDeleteRequiredConfirmDescription": "Feltet \"{label}\" er markeret som påkrævet. Slet alligevel?",
    "save": "Gem", "saving": "Gemmer…", "saveFailed": "Kunne ikke gemme", "saved": "Gemt",
    "builtinBadge": "Indbygget",
    "readonlyHint": "Indbyggede skabeloner er skrivebeskyttede. Dupliker som brugerdefineret for at redigere",
    "forkCta": "Dupliker som brugerdefineret skabelon", "dirty": "Ugemt", "back": "Tilbage",
    "testCreateModeHint": "Prøvetest er tilgængelig, efter skabelonen er gemt"
  },
  "test": {
    "title": "Prøvetest", "description": "Upload en prøve for at verificere udtrækket. Resultaterne arkiveres ikke",
    "selectFile": "Vælg prøve", "reselect": "Vælg igen", "running": "Udtrækker…",
    "failed": "Udtræk mislykkedes", "duration": "{ms} ms",
    "routeVision": "Vision-model", "routeText": "Tekstudtræk", "routeOcr": "OCR",
    "fieldHeader": "Felt", "valueHeader": "Værdi", "statusHeader": "Status",
    "uncertain": "Usikker", "issues": "Bemærkninger", "empty": "Upload en prøve for at se resultaterne",
    "fileRequired": "Kunne ikke finde filstien. Vælg prøven igen"
  }
}
```

注意 da-DK 文案中的 "Auto路由" 为笔误源，写入时修正为 "Auto routet efter filtype"。

- [x] **Step 6: 重新生成 i18n 类型并验证**

Run:
```bash
pnpm run i18n:types
pnpm run i18n
pnpm run i18n:en
```
Expected: `i18n:types` 更新生成文件；`i18n` / `i18n:en` 全部通过（0 missing / 0 extra）。若报某 locale 缺 key，对照 zh-CN 的 documents 结构补齐。

- [x] **Step 7: Commit**

```bash
git add src/renderer/src/i18n
git commit -m "feat(i18n): add documents UI keys"
```

### Task 3: 注册设置页导航项与路由组件

**Files:**
- Modify: `src/shared/settingsNavigation.ts:2-25`（routeName 联合类型）+ `:91-310`（SETTINGS_NAVIGATION_ITEMS）
- Modify: `src/renderer/settings/settingsRouteComponents.ts`

- [x] **Step 1: 扩展 routeName 联合类型**

在 `'settings-debug'` 之后追加一行：

```ts
    | 'settings-documents'
    | 'settings-documents-template'
```

- [x] **Step 2: 在 SETTINGS_NAVIGATION_ITEMS 末尾（settings-debug 项之后、`]` 之前）插入两项**

```ts
  {
    routeName: 'settings-documents',
    path: '/documents',
    titleKey: 'routes.settings-documents',
    icon: 'lucide:scan-text',
    position: 5.05,
    groupKey: 'tools',
    keywords: ['documents', 'template', 'extraction', 'document recognition', '单据', '识别', '模板']
  },
  {
    routeName: 'settings-documents-template',
    path: '/documents/template/:id',
    titleKey: 'routes.settings-documents-template',
    icon: 'lucide:file-pen',
    position: 5.06,
    groupKey: 'tools',
    keywords: ['documents', 'template', 'editor', '单据', '模板', '编辑'],
    hiddenInSidebar: true
  }
```

- [x] **Step 3: settingsRouteComponents.ts 增加懒加载映射**

在 `'settings-debug'` 之后追加：

```ts
  'settings-documents': () => import('./components/DocumentsSettings.vue'),
  'settings-documents-template': () =>
    import('./components/documents/TemplateEditorPage.vue')
```

- [x] **Step 4: typecheck 通过**

Run: `pnpm run typecheck:web`
Expected: 0 errors。

- [x] **Step 5: Commit**

```bash
git add src/shared/settingsNavigation.ts src/renderer/settings/settingsRouteComponents.ts
git commit -m "feat: register documents settings routes"
```

---

### Task 4: 字段操作纯函数 module

**Files:**
- Create: `src/renderer/settings/components/documents/templateFields.ts`
- Create: `test/renderer/settings/documents/templateFields.test.ts`

模块职责：字段增删/重排/序号归一/枚举解析/key 校验/查重。纯函数，无 Vue 依赖，便于单测。

- [x] **Step 1: 写测试文件**

```ts
import { describe, expect, it } from 'vitest'
import {
  addField,
  createEmptyField,
  isFieldKeyValid,
  isTypeKeyValid,
  moveField,
  normalizeOrders,
  parseEnumOptions,
  removeField,
  updateField,
  validateFields,
  type EditableField
} from '../../../../src/renderer/settings/components/documents/templateFields'

const baseField = (key: string, order: number): EditableField => ({
  key,
  label: key.toUpperCase(),
  valueType: 'text',
  required: true,
  promptHint: '',
  validation: '',
  enumOptions: '',
  order
})

describe('templateFields', () => {
  it('creates an empty text field with placeholder key', () => {
    expect(createEmptyField(3)).toEqual({
      key: 'field_3',
      label: '',
      valueType: 'text',
      required: true,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 3
    })
  })

  it('validates field key format', () => {
    expect(isFieldKeyValid('amount')).toBe(true)
    expect(isFieldKeyValid('_priv')).toBe(true)
    expect(isFieldKeyValid('1st')).toBe(false)
    expect(isFieldKeyValid('has-dash')).toBe(false)
    expect(isFieldKeyValid('')).toBe(false)
    expect(isFieldKeyValid('a'.repeat(65))).toBe(false)
  })

  it('validates type key format', () => {
    expect(isTypeKeyValid('contract')).toBe(true)
    expect(isTypeKeyValid('lease_contract')).toBe(true)
    expect(isTypeKeyValid('Contract')).toBe(false)
    expect(isTypeKeyValid('1contract')).toBe(false)
    expect(isTypeKeyValid('')).toBe(false)
  })

  it('adds a field at the end and reorders by sequence', () => {
    const fields = [baseField('a', 1), baseField('b', 2)]
    const next = addField(fields, { ...baseField('c', 99), order: 99 })
    expect(next.map((f) => f.key)).toEqual(['a', 'b', 'c'])
    expect(next.map((f) => f.order)).toEqual([1, 2, 3])
  })

  it('removes a field and renumbers', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('c', 3)]
    const next = removeField(fields, 1)
    expect(next.map((f) => f.key)).toEqual(['a', 'c'])
    expect(next.map((f) => f.order)).toEqual([1, 2])
  })

  it('updates a field by index without mutating the original array', () => {
    const fields = [baseField('a', 1)]
    const next = updateField(fields, 0, { label: 'A New' })
    expect(fields[0].label).toBe('A')
    expect(next[0].label).toBe('A New')
  })

  it('moves a field forward and backward and renumbers', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('c', 3)]
    const forward = moveField(fields, 0, 2)
    expect(forward.map((f) => f.key)).toEqual(['b', 'c', 'a'])
    const backward = moveField(fields, 2, 0)
    expect(backward.map((f) => f.key)).toEqual(['c', 'a', 'b'])
  })

  it('parses comma-separated enum options and trims blanks', () => {
    expect(parseEnumOptions('  a , b ,, c')).toEqual(['a', 'b', 'c'])
    expect(parseEnumOptions('')).toEqual([])
  })

  it('normalizes orders so sequence starts at 1', () => {
    const fields = [baseField('a', 9), baseField('b', 2), baseField('c', 5)]
    const next = normalizeOrders(fields)
    expect(next.map((f) => f.order)).toEqual([1, 2, 3])
    expect(next.map((f) => f.key)).toEqual(['a', 'b', 'c'])
  })

  it('reports duplicated keys as a map of index to "duplicated"', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('a', 3)]
    const result = validateFields(fields)
    expect(result).toEqual({ 0: 'duplicated', 2: 'duplicated' })
  })

  it('reports invalid keys as a map of index to "invalid"', () => {
    const fields = [
      { ...baseField('a', 1) },
      { ...baseField('1bad', 2) },
      { ...baseField('has-dash', 3) }
    ]
    const result = validateFields(fields)
    expect(result).toEqual({ 1: 'invalid', 2: 'invalid' })
  })

  it('validates empty label-free fields as ok (label optional in editor draft)', () => {
    const fields = [{ ...baseField('a', 1), label: '' }]
    expect(validateFields(fields)).toEqual({})
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/templateFields.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 写实现**

`src/renderer/settings/components/documents/templateFields.ts`:

```ts
import type { DocumentFieldValueType } from '@shared/documents'

export interface EditableField {
  key: string
  label: string
  valueType: DocumentFieldValueType
  required: boolean
  promptHint: string
  validation: string
  enumOptions: string
  order: number
}

const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/

export function isFieldKeyValid(key: string): boolean {
  return FIELD_KEY_RE.test(key)
}

export function isTypeKeyValid(key: string): boolean {
  return TYPE_KEY_RE.test(key)
}

export function createEmptyField(order: number): EditableField {
  return {
    key: `field_${order}`,
    label: '',
    valueType: 'text',
    required: true,
    promptHint: '',
    validation: '',
    enumOptions: '',
    order
  }
}

export function normalizeOrders(fields: EditableField[]): EditableField[] {
  return fields.map((field, index) => ({ ...field, order: index + 1 }))
}

export function addField(fields: EditableField[], field: EditableField): EditableField[] {
  return normalizeOrders([...fields, field])
}

export function removeField(fields: EditableField[], index: number): EditableField[] {
  return normalizeOrders(fields.filter((_, idx) => idx !== index))
}

export function updateField(
  fields: EditableField[],
  index: number,
  patch: Partial<EditableField>
): EditableField[] {
  return fields.map((field, idx) => (idx === index ? { ...field, ...patch } : field))
}

export function moveField(
  fields: EditableField[],
  from: number,
  to: number
): EditableField[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= fields.length ||
    to >= fields.length
  ) {
    return fields
  }
  const next = [...fields]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return normalizeOrders(next)
}

export function parseEnumOptions(raw: string): string[] {
  return raw
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
}

export type FieldValidationIssue = 'invalid' | 'duplicated'

export function validateFields(fields: EditableField[]): Record<number, FieldValidationIssue> {
  const issues: Record<number, FieldValidationIssue> = {}
  const seenKeys = new Set<string>()
  fields.forEach((field, index) => {
    if (!isFieldKeyValid(field.key)) {
      issues[index] = 'invalid'
      return
    }
    if (seenKeys.has(field.key)) {
      issues[index] = 'duplicated'
      return
    }
    seenKeys.add(field.key)
  })
  return issues
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/settings/documents/templateFields.test.ts --config vitest.config.renderer.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/renderer/settings/components/documents/templateFields.ts test/renderer/settings/documents/templateFields.test.ts
git commit -m "feat: add template field helpers"
```

---

### Task 5: DocumentsStore（Pinia）

**Files:**
- Create: `src/renderer/src/stores/documents.ts`
- Create: `test/renderer/stores/documentsStore.test.ts`

Store 职责：模板列表缓存 + CRUD 透传 + testExtract 透传 + 客户端查重 + 错误归一化。setup store 范式（参 pluginCatalog.ts）。

- [x] **Step 1: 写测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockDocumentsClient = () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  upsertTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  forkTemplate: vi.fn(),
  testExtract: vi.fn()
})

const builtinTemplate = {
  id: 'tpl_contract',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: '合同类',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
}

const customTemplate = {
  ...builtinTemplate,
  id: 'tpl_custom',
  typeKey: 'custom_doc',
  name: 'Custom Doc',
  isBuiltin: false
}

describe('DocumentsStore', () => {
  let client: ReturnType<typeof mockDocumentsClient>

  beforeEach(async () => {
    setActivePinia(createPinia())
    client = mockDocumentsClient()
    vi.resetModules()
    vi.doMock('@api/DocumentsClient', () => ({
      createDocumentsClient: () => client
    }))
  })

  it('loads templates and separates builtin vs custom', async () => {
    client.listTemplates.mockResolvedValue({
      templates: [builtinTemplate, customTemplate]
    })
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.builtinTemplates).toHaveLength(1)
    expect(store.customTemplates).toHaveLength(1)
    expect(store.loadError).toBeNull()
    expect(store.isLoading).toBe(false)
  })

  it('captures load error and surfaces user-facing message', async () => {
    client.listTemplates.mockRejectedValue(new Error('boom'))
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.loadError).toBe('settings.documents.templates.loadFailed')
    expect(store.builtinTemplates).toEqual([])
  })

  it('detects typeKey conflicts using cached templates', async () => {
    client.listTemplates.mockResolvedValue({
      templates: [builtinTemplate, customTemplate]
    })
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.isTypeKeyTaken('custom_doc')).toBe(true)
    expect(store.isTypeKeyTaken('fresh_key')).toBe(false)
    // editing the same template: exclude its own id
    expect(store.isTypeKeyTaken('custom_doc', 'tpl_custom')).toBe(false)
  })

  it('parses archive reference count from delete error', async () => {
    client.deleteTemplate.mockRejectedValueOnce(
      new Error('Template has 3 archived document(s); pass force to confirm')
    )
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    const result = await store.attemptDelete('tpl_custom')

    expect(result).toEqual({ kind: 'force-required', referenceCount: 3 })
    // retry with force
    client.deleteTemplate.mockResolvedValueOnce({ success: true })
    const forced = await store.attemptDelete('tpl_custom', { force: true })
    expect(forced).toEqual({ kind: 'deleted' })
    expect(store.customTemplates).toHaveLength(0)
  })

  it('upserts and updates the cached list', async () => {
    client.listTemplates.mockResolvedValue({ templates: [builtinTemplate] })
    client.upsertTemplate.mockResolvedValue({ template: customTemplate })
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    await store.loadTemplates()

    const saved = await store.saveTemplate({
      typeKey: 'custom_doc',
      name: 'Custom Doc',
      category: '自定义',
      fields: [],
      extractionMode: 'auto'
    })

    expect(saved.id).toBe('tpl_custom')
    expect(store.customTemplates[0]).toEqual(customTemplate)
  })

  it('forwards testExtract to the client', async () => {
    client.testExtract.mockResolvedValue({
      fields: [{ key: 'amount', value: 100, uncertain: false }],
      meta: {
        route: 'vision',
        rawOutput: '{}',
        durationMs: 500,
        issues: []
      }
    })
    const { useDocumentsStore } = await import(
      '../../../src/renderer/src/stores/documents'
    )
    const store = useDocumentsStore()
    const result = await store.testExtract({
      templateId: 'tpl_contract',
      file: { path: '/tmp/sample.png', name: 'sample.png' }
    })

    expect(result.fields[0].key).toBe('amount')
    expect(result.meta.route).toBe('vision')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/stores/documentsStore.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（store 不存在）。

- [x] **Step 3: 写实现**

`src/renderer/src/stores/documents.ts`:

```ts
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createDocumentsClient, type DocumentsClient } from '@api/DocumentsClient'
import type {
  DocumentTemplate,
  DocumentFieldValueType,
  DocumentExtractionMode,
  DocumentTemplateCategory
} from '@shared/documents'
import type { z } from 'zod'
import type { documentsTemplateUpsertInputSchema } from '@shared/contracts/routes'

export type TemplateUpsertInput = z.input<typeof documentsTemplateUpsertInputSchema>

export interface EditableTemplateDraft {
  id?: string
  typeKey: string
  name: string
  icon: string | null
  category: DocumentTemplateCategory
  fields: Array<{
    key: string
    label: string
    valueType: DocumentFieldValueType
    required: boolean
    promptHint: string | null
    validation: string | null
    enumOptions: string[] | null
    order: number
  }>
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin?: boolean
  builtinSourceId?: string | null
}

const ARCHIVE_REFERENCE_RE = /Template has (\d+) archived document/

const defaultClient = createDocumentsClient()

export const useDocumentsStore = defineStore('documents', () => {
  const templates = ref<DocumentTemplate[]>([])
  const isLoading = ref(false)
  const loadError = ref<string | null>(null)

  const builtinTemplates = computed(() => templates.value.filter((t) => t.isBuiltin))
  const customTemplates = computed(() => templates.value.filter((t) => !t.isBuiltin))

  async function loadTemplates(client: DocumentsClient = defaultClient) {
    isLoading.value = true
    loadError.value = null
    try {
      const result = await client.listTemplates()
      templates.value = result.templates
    } catch (error) {
      console.error('[DocumentsStore] loadTemplates failed', error)
      loadError.value = 'settings.documents.templates.loadFailed'
      templates.value = []
    } finally {
      isLoading.value = false
    }
  }

  function isTypeKeyTaken(typeKey: string, excludeId?: string): boolean {
    return templates.value.some(
      (t) => t.typeKey === typeKey && t.id !== excludeId
    )
  }

  type DeleteResult =
    | { kind: 'deleted' }
    | { kind: 'force-required'; referenceCount: number }
    | { kind: 'rejected'; messageKey: string }

  async function attemptDelete(
    id: string,
    options?: { force?: boolean },
    client: DocumentsClient = defaultClient
  ): Promise<DeleteResult> {
    try {
      await client.deleteTemplate(id, options?.force)
      templates.value = templates.value.filter((t) => t.id !== id)
      return { kind: 'deleted' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const match = message.match(ARCHIVE_REFERENCE_RE)
      if (match) {
        return { kind: 'force-required', referenceCount: Number(match[1]) }
      }
      if (message.includes('Cannot delete a builtin template')) {
        return { kind: 'rejected', messageKey: 'settings.documents.templates.builtinGroup' }
      }
      return { kind: 'rejected', messageKey: 'settings.documents.templates.deleteFailed' }
    }
  }

  async function saveTemplate(
    input: TemplateUpsertInput,
    client: DocumentsClient = defaultClient
  ): Promise<DocumentTemplate> {
    const result = await client.upsertTemplate(input)
    const index = templates.value.findIndex((t) => t.id === result.template.id)
    if (index >= 0) {
      templates.value[index] = result.template
    } else {
      templates.value.push(result.template)
    }
    return result.template
  }

  async function testExtract(
    input: Parameters<DocumentsClient['testExtract']>[0],
    client: DocumentsClient = defaultClient
  ) {
    return client.testExtract(input)
  }

  return {
    templates,
    isLoading,
    loadError,
    builtinTemplates,
    customTemplates,
    loadTemplates,
    isTypeKeyTaken,
    attemptDelete,
    saveTemplate,
    testExtract
  }
})
```

注意 `DocumentsClient` type 已从 `src/renderer/api/DocumentsClient.ts` 导出（`export type DocumentsClient = ReturnType<typeof createDocumentsClient>`）。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/stores/documentsStore.test.ts --config vitest.config.renderer.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/stores/documents.ts test/renderer/stores/documentsStore.test.ts
git commit -m "feat: add documents store"
```

---

### Task 6: TemplateFieldsEditor.vue（字段行编辑 + 拖拽排序）

**Files:**
- Create: `src/renderer/settings/components/documents/TemplateFieldsEditor.vue`
- Create: `test/renderer/settings/documents/TemplateFieldsEditor.test.ts`

职责：受控组件，`v-model:fields`（`EditableField[]`），每行编辑 key/label/valueType/required/promptHint/validation/enumOptions；整行拖拽（useSortable）重排后 emit update；删除必需字段弹 AlertDialog 确认；readonly 模式禁用所有交互。

- [x] **Step 1: 写测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })
const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue', 'disabled', 'placeholder'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="$emit(\'update:modelValue\', ($event.target as HTMLInputElement).value)" />'
})
const switchStub = defineComponent({
  name: 'SwitchStub',
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue'],
  template:
    '<button :disabled="disabled" :data-model-value="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />'
})
const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      choose: (value: string) => emit('update:modelValue', value)
    }
  },
  template: '<div><slot /></div>'
})
const selectItemStub = defineComponent({
  name: 'SelectItemStub',
  props: { value: { type: String, required: true } },
  emits: ['pick'],
  template: '<button type="button" :data-value="value" @click="$emit(\'pick\', value)"><slot /></button>'
})
const PROVIDE_KEY = Symbol('select-pick')
const selectRootStub = defineComponent({
  name: 'SelectRootStub',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(props, { emit, slots }) {
    return () => {
      const provide = (value: string) => emit('update:modelValue', value)
      const children = slots.default?.({
        pick: provide
      })
      return children
    }
  },
  template: '<slot :pick="pick" />'
})
const useSortableStub = vi.fn(() => ({ start: () => undefined, option: () => undefined }))

async function setup(readonly = false) {
  vi.resetModules()
  vi.doMock('@vueuse/integrations/useSortable', () => ({ useSortable: useSortableStub }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string) => key
    })
  }))
  const TemplateFieldsEditor = (
    await import(
      '../../../src/renderer/settings/components/documents/TemplateFieldsEditor.vue'
    )
  ).default

  const initialFields = [
    { key: 'amount', label: 'Amount', valueType: 'number', required: true, promptHint: '', validation: '', enumOptions: '', order: 1 },
    { key: 'date', label: 'Date', valueType: 'date', required: false, promptHint: '', validation: '', enumOptions: '', order: 2 }
  ]

  const wrapper = mount(TemplateFieldsEditor, {
    props: { fields: initialFields, readonly },
    global: {
      stubs: {
        Icon: true,
        Input: inputStub,
        Textarea: inputStub,
        Switch: switchStub,
        Select: selectRootStub,
        SelectTrigger: passthrough('SelectTrigger'),
        SelectValue: passthrough('SelectValue'),
        SelectContent: passthrough('SelectContent'),
        SelectItem: selectItemStub,
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }),
        AlertDialog: defineComponent({
          name: 'AlertDialogStub',
          props: { open: Boolean },
          template: '<div v-if="open"><slot /></div>'
        }),
        AlertDialogContent: passthrough('AlertDialogContent'),
        AlertDialogHeader: passthrough('AlertDialogHeader'),
        AlertDialogTitle: passthrough('AlertDialogTitle'),
        AlertDialogDescription: passthrough('AlertDialogDescription'),
        AlertDialogFooter: passthrough('AlertDialogFooter'),
        AlertDialogCancel: defineComponent({
          name: 'AlertDialogCancelStub',
          template: '<button data-testid="field-delete-cancel"><slot /></button>'
        }),
        AlertDialogAction: defineComponent({
          name: 'AlertDialogActionStub',
          props: ['disabled'],
          emits: ['click'],
          template:
            '<button data-testid="field-delete-confirm" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
        })
      }
    }
  })
  await flushPromises()
  return { wrapper, useSortableStub }
}

describe('TemplateFieldsEditor', () => {
  it('renders one row per field', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="field-row"]')).toHaveLength(2)
  })

  it('emits update when a field label changes', async () => {
    const { wrapper } = await setup()
    const inputs = wrapper.findAll('input[placeholder="settings.documents.editor.fieldLabel"]')
    expect(inputs).toHaveLength(2)
    await inputs[0].setValue('New Amount')
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<{ label: string }>
    expect(newFields[0].label).toBe('New Amount')
  })

  it('shows confirmation when deleting a required field', async () => {
    const { wrapper } = await setup()
    const deleteButtons = wrapper.findAll('[data-testid="field-delete"]')
    await deleteButtons[0].trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="field-delete-confirm"]').exists()).toBe(true)
  })

  it('deletes without confirmation when field is not required', async () => {
    const { wrapper } = await setup()
    const deleteButtons = wrapper.findAll('[data-testid="field-delete"]')
    await deleteButtons[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="field-delete-confirm"]').exists()).toBe(false)
    const updateEvents = wrapper.emitted('update:fields')
    expect(updateEvents).toBeTruthy()
    const newFields = updateEvents!.at(-1)![0] as Array<{ key: string }>
    expect(newFields.map((f) => f.key)).toEqual(['amount'])
  })

  it('emits add-field event on add button click', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="field-add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
  })

  it('initializes useSortable on the row container', async () => {
    const { useSortableStub } = await setup()
    expect(useSortableStub).toHaveBeenCalled()
  })

  it('disables all controls in readonly mode', async () => {
    const { wrapper } = await setup(true)
    expect(wrapper.find('[data-testid="field-add"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="field-delete"]')).toHaveLength(0)
    const inputs = wrapper.findAll('input')
    for (const input of inputs) {
      expect(input.attributes('disabled')).toBeDefined()
    }
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/TemplateFieldsEditor.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（组件不存在）。

- [x] **Step 3: 写组件**

`src/renderer/settings/components/documents/TemplateFieldsEditor.vue`:

```vue
<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium">{{ t('settings.documents.editor.fieldsTitle') }}</h3>
      <DcButton
        v-if="!readonly"
        variant="outline"
        size="sm"
        data-testid="field-add"
        @click="emit('add')"
      >
        <Icon icon="lucide:plus" class="mr-1 size-4" />
        {{ t('settings.documents.editor.addField') }}
      </DcButton>
    </div>

    <div ref="listRef" class="space-y-2">
      <div
        v-for="(field, index) in fields"
        :key="index"
        data-testid="field-row"
        class="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[auto_1fr_1fr_1fr_auto]"
      >
        <Icon
          v-if="!readonly"
          icon="lucide:grip-vertical"
          class="size-4 cursor-grab self-center text-muted-foreground"
        />
        <Input
          :model-value="field.key"
          :placeholder="t('settings.documents.editor.fieldKey')"
          :disabled="readonly"
          data-testid="field-key"
          @update:model-value="(value: string) => update(index, { key: value })"
        />
        <Input
          :model-value="field.label"
          :placeholder="t('settings.documents.editor.fieldLabel')"
          :disabled="readonly"
          data-testid="field-label"
          @update:model-value="(value: string) => update(index, { label: value })"
        />
        <Select
          :model-value="field.valueType"
          :disabled="readonly"
          @update:model-value="(value: string) => update(index, { valueType: value as DocumentFieldValueType })"
        >
          <SelectTrigger data-testid="field-type-trigger">
            <SelectValue :placeholder="t('settings.documents.editor.fieldType')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in valueTypes"
              :key="option"
              :value="option"
            >
              {{ t(`settings.documents.valueType.${option}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div class="flex items-center gap-2">
          <Switch
            :model-value="field.required"
            :disabled="readonly"
            :aria-label="t('settings.documents.editor.fieldRequired')"
            data-testid="field-required"
            @update:model-value="(value: boolean) => update(index, { required: value })"
          />
          <DcButton
            v-if="!readonly"
            variant="ghost"
            size="icon"
            data-testid="field-delete"
            @click="requestDelete(index)"
          >
            <Icon icon="lucide:trash-2" class="size-4" />
          </DcButton>
        </div>
      </div>
    </div>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ t('settings.documents.editor.fieldDeleteRequiredConfirmTitle') }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {{ t('settings.documents.editor.fieldDeleteRequiredConfirmDescription', { label: pendingLabel }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="field-delete-cancel">
            {{ t('common.cancel') }}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="field-delete-confirm"
            @click="confirmDelete"
          >
            {{ t('common.confirm') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSortable } from '@vueuse/integrations/useSortable'
import { Icon } from '@iconify/vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@shadcn/components/ui/input'
import { Switch } from '@shadcn/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@shadcn/components/ui/alert-dialog'
import { DOCUMENT_FIELD_VALUE_TYPES, type DocumentFieldValueType } from '@shared/documents'
import {
  moveField,
  removeField,
  updateField,
  type EditableField
} from './templateFields'

const props = defineProps<{
  fields: EditableField[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:fields': [fields: EditableField[]]
  add: []
}>()

const { t } = useI18n()
const valueTypes = DOCUMENT_FIELD_VALUE_TYPES

const listRef = ref<HTMLElement | null>(null)
const confirmOpen = ref(false)
const pendingIndex = ref<number | null>(null)
const pendingLabel = computed(() =>
  pendingIndex.value !== null ? props.fields[pendingIndex.value]?.label ?? '' : ''
)

useSortable(listRef, props.fields, {
  animation: 150,
  handle: '.lucide-grip-vertical',
  disabled: props.readonly,
  onEnd: (event) => {
    if (event.oldIndex === undefined || event.newIndex === undefined) return
    emit('update:fields', moveField(props.fields, event.oldIndex, event.newIndex))
  }
})

watch(
  () => props.fields,
  (next) => {
    // ensure sortable reflects external array changes
    void next
  }
)

function update(index: number, patch: Partial<EditableField>) {
  emit('update:fields', updateField(props.fields, index, patch))
}

function requestDelete(index: number) {
  const field = props.fields[index]
  if (field?.required) {
    pendingIndex.value = index
    confirmOpen.value = true
    return
  }
  emit('update:fields', removeField(props.fields, index))
}

function confirmDelete() {
  if (pendingIndex.value !== null) {
    emit('update:fields', removeField(props.fields, pendingIndex.value))
  }
  pendingIndex.value = null
  confirmOpen.value = false
}
</script>
```

注意 `useSortable` 接受 reactive target + options，`disabled` 不可写为静态，应改为 computed，实现时替换为 `disabled: computed(() => props.readonly)`。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/settings/documents/TemplateFieldsEditor.test.ts --config vitest.config.renderer.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/renderer/settings/components/documents/TemplateFieldsEditor.vue test/renderer/settings/documents/TemplateFieldsEditor.test.ts
git commit -m "feat: add template fields editor"
```

---

### Task 7: TemplateTestExtract.vue（样张测试折叠区）

**Files:**
- Create: `src/renderer/settings/components/documents/TemplateTestExtract.vue`

职责：上传样张文件（`<input type="file">` 隐藏触发 + `fileClient.getPathForFile`）→ 调 store.testExtract → 展示字段表格（uncertain 高亮）+ 耗时 + route 标签。读 prop `templateId?: string`（未保存时禁用）。

- [x] **Step 1: 写组件**

```vue
<template>
  <Collapsible v-model:open="open" class="rounded-lg border bg-muted/10">
    <CollapsibleTrigger as-child>
      <DcButton
        variant="ghost"
        class="flex h-auto w-full items-center justify-between rounded-lg p-4"
        data-testid="test-toggle"
      >
        <div class="min-w-0 text-start">
          <div class="text-sm font-medium">{{ t('settings.documents.test.title') }}</div>
          <p class="mt-1 text-xs font-normal text-muted-foreground">
            {{ t('settings.documents.test.description') }}
          </p>
        </div>
        <Icon
          :icon="open ? 'lucide:chevron-up' : 'lucide:chevron-down'"
          class="ml-3 size-4 shrink-0 text-muted-foreground"
        />
      </DcButton>
    </CollapsibleTrigger>
    <CollapsibleContent class="border-t p-4 space-y-3">
      <div v-if="!templateId" class="text-sm text-muted-foreground">
        {{ t('settings.documents.editor.testCreateModeHint') }}
      </div>
      <template v-else>
        <div class="flex items-center gap-3">
          <input
            ref="fileInputRef"
            type="file"
            class="hidden"
            accept="image/*,application/pdf"
            @change="onFileChange"
          />
          <DcButton
            variant="outline"
            size="sm"
            :disabled="isRunning"
            data-testid="test-select-file"
            @click="triggerFilePicker"
          >
            <Icon icon="lucide:upload" class="mr-2 size-4" />
            {{ fileName ?? t('settings.documents.test.selectFile') }}
          </DcButton>
          <span v-if="isRunning" class="text-sm text-muted-foreground">
            {{ t('settings.documents.test.running') }}
          </span>
        </div>
        <Alert v-if="error" variant="destructive">
          <Icon icon="lucide:circle-alert" class="size-4" />
          <AlertDescription>{{ t('settings.documents.test.failed') }}</AlertDescription>
        </Alert>
        <div v-if="result" class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{{ routeLabel }}</Badge>
            <span>{{ t('settings.documents.test.duration', { ms: result.meta.durationMs }) }}</span>
          </div>
          <ul v-if="result.meta.issues.length > 0" class="text-xs text-muted-foreground">
            <li v-for="(issue, idx) in result.meta.issues" :key="idx">{{ issue }}</li>
          </ul>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left">
                  <th class="py-2 pr-4">{{ t('settings.documents.test.fieldHeader') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.documents.test.valueHeader') }}</th>
                  <th class="py-2">{{ t('settings.documents.test.statusHeader') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="field in result.fields"
                  :key="field.key"
                  class="border-b"
                  :class="{ 'bg-amber-50 dark:bg-amber-950/30': field.uncertain }"
                >
                  <td class="py-2 pr-4 font-mono">{{ field.key }}</td>
                  <td class="py-2 pr-4">{{ field.value }}</td>
                  <td class="py-2">
                    <Badge v-if="field.uncertain" variant="outline">
                      {{ t('settings.documents.test.uncertain') }}
                    </Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p v-else-if="!isRunning" class="text-sm text-muted-foreground">
          {{ t('settings.documents.test.empty') }}
        </p>
      </template>
    </CollapsibleContent>
  </Collapsible>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@shadcn/components/ui/collapsible'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Badge } from '@shadcn/components/ui/badge'
import { DcButton } from '@dc-ui/components/button'
import { createFileClient } from '@api/FileClient'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{ templateId?: string }>()

const { t } = useI18n()
const store = useDocumentsStore()
const fileClient = createFileClient()
const fileInputRef = ref<HTMLInputElement | null>(null)
const fileName = ref<string | null>(null)
const isRunning = ref(false)
const error = ref(false)
const result = ref<Awaited<ReturnType<typeof store.testExtract>> | null>(null)

const routeLabel = computed(() => {
  if (!result.value) return ''
  return t(`settings.documents.test.route${result.value.meta.route[0].toUpperCase()}${result.value.meta.route.slice(1)}`)
})

function triggerFilePicker() {
  fileInputRef.value?.click()
}

async function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  const path = fileClient.getPathForFile(file)
  if (!path) {
    error.value = true
    return
  }
  fileName.value = file.name
  isRunning.value = true
  error.value = false
  result.value = null
  try {
    result.value = await store.testExtract({
      templateId: props.templateId!,
      file: { path, name: file.name, mimeType: file.type }
    })
  } catch (e) {
    console.error('[TemplateTestExtract] failed', e)
    error.value = true
  } finally {
    isRunning.value = false
  }
}
</script>
```

- [x] **Step 2: 不单测（该组件行为主要是委托 store，已在 store 单测覆盖；UI 仅做渲染分层，可放入集成测试与 TemplateEditorPage 合测，避免测试重复）**

- [x] **Step 3: Commit**

```bash
git add src/renderer/settings/components/documents/TemplateTestExtract.vue
git commit -m "feat: add template test extract panel"
```

---

### Task 8: TemplateEditorPage.vue（编辑器独立页）

**Files:**
- Create: `src/renderer/settings/components/documents/TemplateEditorPage.vue`
- Create: `test/renderer/settings/documents/TemplateEditorPage.test.ts`

职责：
1. 解析路由 `:id` 与 `forkFrom` query
2. 新建：空草稿；fork：从源模板预填草稿（`builtinSourceId = 源 id`，清空 id/typeKey 由用户填）
3. 编辑：`store.templates` 命中即用；否则 store.loadTemplates 后再查；未命中显示 notFound
4. 预置模板：`isBuiltin === true` → 全组件 readonly + 显示 fork CTA
5. dirty 守卫：deep watch draft → `settingsLeaveGuard` lease `setRisk('dirty'|'clean')`；`onDiscard` 还原为已保存快照
6. 保存：客户端校验（name 非空 / typeKey 格式 / typeKey 查重 / fields 无 invalid+duplicate）→ store.saveTemplate → 更新已保存快照、清 dirty
7. 样张测试：`<TemplateTestExtract :template-id="savedId" />`，未保存时禁用

- [x] **Step 1: 写测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const builtinTemplate = {
  id: 'tpl_contract',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: '合同类',
  fields: [
    { key: 'party_a', label: 'Party A', valueType: 'text', required: true, promptHint: null, validation: null, enumOptions: null, order: 1 }
  ],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
}

const customTemplate = {
  ...builtinTemplate,
  id: 'tpl_custom',
  typeKey: 'custom_doc',
  name: 'Custom Doc',
  isBuiltin: false
}

const stubStore = {
  templates: [builtinTemplate, customTemplate],
  isLoading: false,
  loadError: null,
  builtinTemplates: [builtinTemplate],
  customTemplates: [customTemplate],
  loadTemplates: vi.fn(),
  isTypeKeyTaken: vi.fn((typeKey: string, excludeId?: string) => {
    if (excludeId === 'tpl_custom' && typeKey === 'custom_doc') return false
    return typeKey === 'contract' || typeKey === 'custom_doc'
  }),
  attemptDelete: vi.fn(),
  saveTemplate: vi.fn(),
  testExtract: vi.fn()
}

const settingsLeaveGuardStub = {
  register: vi.fn(() => ({
    setRisk: vi.fn(),
    release: vi.fn()
  }))
}

async function setup(routePath: string, initialRoutes: Array<{ path: string; name: string; component: any }>) {
  vi.resetModules()
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('../services/settingsLeaveGuard', () => ({
    settingsLeaveGuard: settingsLeaveGuardStub,
    type SettingsLeaveRisk = any
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const TemplateEditorPage = (
    await import(
      '../../../src/renderer/settings/components/documents/TemplateEditorPage.vue'
    )
  ).default

  const router = (await import('vue-router')).createRouter({
    history: createMemoryHistory(),
    routes: initialRoutes
  })
  await router.push(routePath)
  await router.isReady()

  const wrapper = mount(TemplateEditorPage, {
    global: {
      plugins: [router],
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: passthrough('SettingsSectionCard'),
        Icon: true,
        Input: defineComponent({
          name: 'InputStub',
          props: ['modelValue', 'disabled', 'placeholder'],
          emits: ['update:modelValue'],
          template:
            '<input :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="$emit(\'update:modelValue\', ($event.target as HTMLInputElement).value)" />'
        }),
        Textarea: defineComponent({
          name: 'TextareaStub',
          props: ['modelValue', 'disabled', 'placeholder'],
          emits: ['update:modelValue'],
          template:
            '<textarea :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="$emit(\'update:modelValue\', ($event.target as HTMLTextAreaElement).value)" />'
        }),
        Switch: defineComponent({
          name: 'SwitchStub',
          props: { modelValue: Boolean, disabled: Boolean },
          emits: ['update:modelValue'],
          template:
            '<button :disabled="disabled" :data-model-value="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />'
        }),
        Select: passthrough('Select'),
        SelectTrigger: passthrough('SelectTrigger'),
        SelectValue: passthrough('SelectValue'),
        SelectContent: passthrough('SelectContent'),
        SelectItem: passthrough('SelectItem'),
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }),
        Badge: passthrough('Badge'),
        Alert: passthrough('Alert'),
        AlertDescription: passthrough('AlertDescription'),
        TemplateFieldsEditor: defineComponent({
          name: 'TemplateFieldsEditorStub',
          props: ['fields', 'readonly'],
          emits: ['update:fields', 'add'],
          template: '<div data-testid="fields-editor"><slot /></div>'
        }),
        TemplateTestExtract: defineComponent({
          name: 'TemplateTestExtractStub',
          props: ['templateId'],
          template: '<div data-testid="test-extract" />'
        })
      }
    }
  })
  await flushPromises()
  return { wrapper, router }
}

describe('TemplateEditorPage', () => {
  beforeEach(() => {
    stubStore.loadTemplates.mockClear()
    stubStore.saveTemplate.mockClear()
    stubStore.isTypeKeyTaken.mockClear()
    settingsLeaveGuardStub.register.mockClear()
  })

  it('loads existing custom template and shows save button', async () => {
    const { wrapper } = await setup('/documents/template/tpl_custom', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('Custom Doc')
    expect(wrapper.find('[data-testid="template-save"]').exists()).toBe(true)
  })

  it('renders builtin template as readonly with fork CTA', async () => {
    const { wrapper } = await setup('/documents/template/tpl_contract', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    expect(wrapper.find('[data-testid="template-save"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="builtin-fork-cta"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="template-name"]').attributes('disabled')).toBeDefined()
  })

  it('renders new template form with empty fields', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('')
    expect(wrapper.get('[data-testid="template-save"]').exists()).toBe(true)
  })

  it('prefills draft from forkFrom source template', async () => {
    const { wrapper } = await setup('/documents/template/new?forkFrom=tpl_contract', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('Contract')
    // typeKey cleared for user to choose
    expect(wrapper.get('[data-testid="template-type-key"]').attributes('value')).toBe('')
  })

  it('blocks save when name is empty', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('settings.documents.editor.nameRequired')
  })

  it('blocks save when typeKey is already taken', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    await wrapper.get('[data-testid="template-name"]').setValue('New Template')
    await wrapper.get('[data-testid="template-type-key"]').setValue('contract')
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('settings.documents.editor.typeKeyTaken')
  })

  it('saves valid new template and clears dirty state', async () => {
    stubStore.saveTemplate.mockResolvedValueOnce({
      ...customTemplate,
      id: 'tpl_new',
      typeKey: 'new_doc',
      name: 'New Template'
    })
    const { wrapper } = await setup('/documents/template/new', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    await wrapper.get('[data-testid="template-name"]').setValue('New Template')
    await wrapper.get('[data-testid="template-type-key"]').setValue('new_doc')
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).toHaveBeenCalledTimes(1)
    expect(stubStore.saveTemplate.mock.calls[0][0].name).toBe('New Template')
  })

  it('navigates back to documents tab on back button', async () => {
    const { wrapper, router } = await setup('/documents/template/tpl_custom', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } },
      { path: '/documents', name: 'settings-documents', component: { template: '<div />' } }
    ])
    await wrapper.get('[data-testid="template-back"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('settings-documents')
  })

  it('registers with settings leave guard', async () => {
    await setup('/documents/template/tpl_custom', [
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ])
    expect(settingsLeaveGuardStub.register).toHaveBeenCalledTimes(1)
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/TemplateEditorPage.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（组件不存在）。

- [x] **Step 3: 写组件**

`src/renderer/settings/components/documents/TemplateEditorPage.vue`:

```vue
<template>
  <SettingsPageShell
    :title="pageTitle"
    :description="t('settings.documents.description')"
    :eyebrow="t('routes.settings-documents')"
    data-testid="template-editor-page"
  >
    <template v-if="notFound">
      <Alert variant="destructive">
        <Icon icon="lucide:circle-alert" class="size-4" />
        <AlertDescription>{{ t('settings.documents.editor.notFound') }}</AlertDescription>
      </Alert>
      <DcButton variant="outline" size="sm" data-testid="template-back" @click="goBack">
        <Icon icon="lucide:arrow-left" class="mr-2 size-4" />
        {{ t('settings.documents.editor.back') }}
      </DcButton>
    </template>

    <template v-else>
      <div class="mb-4 flex items-center justify-between">
        <DcButton variant="ghost" size="sm" data-testid="template-back" @click="goBack">
          <Icon icon="lucide:arrow-left" class="mr-2 size-4" />
          {{ t('settings.documents.editor.back') }}
        </DcButton>
        <div class="flex items-center gap-2">
          <Badge v-if="isReadonly" variant="secondary">
            {{ t('settings.documents.editor.builtinBadge') }}
          </Badge>
          <Badge v-if="isDirty" variant="outline">
            {{ t('settings.documents.editor.dirty') }}
          </Badge>
          <DcButton
            v-if="!isReadonly"
            size="sm"
            :disabled="isSaving"
            data-testid="template-save"
            @click="onSave"
          >
            <Spinner v-if="isSaving" class="mr-2 size-4" />
            <Icon v-else icon="lucide:save" class="mr-2 size-4" />
            {{ isSaving ? t('settings.documents.editor.saving') : t('settings.documents.editor.save') }}
          </DcButton>
        </div>
      </div>

      <Alert v-if="saveError" variant="destructive" class="mb-4">
        <Icon icon="lucide:circle-alert" class="size-4" />
        <AlertDescription>{{ t('settings.documents.editor.saveFailed') }}</AlertDescription>
      </Alert>

      <SettingsSectionCard>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="text-sm font-medium" for="template-name">
              {{ t('settings.documents.editor.nameLabel') }}
            </label>
            <Input
              id="template-name"
              :model-value="draft.name"
              :placeholder="t('settings.documents.editor.namePlaceholder')"
              :disabled="isReadonly"
              data-testid="template-name"
              class="mt-1"
              @update:model-value="(value: string) => updateField('name', value)"
            />
            <p v-if="errors.name" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.nameRequired') }}
            </p>
          </div>
          <div>
            <label class="text-sm font-medium" for="template-type-key">
              {{ t('settings.documents.editor.typeKeyLabel') }}
            </label>
            <Input
              id="template-type-key"
              :model-value="draft.typeKey"
              :placeholder="t('settings.documents.editor.typeKeyHint')"
              :disabled="isReadonly || isEditing"
              data-testid="template-type-key"
              class="mt-1"
              @update:model-value="(value: string) => updateField('typeKey', value)"
            />
            <p v-if="errors.typeKeyInvalid" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.typeKeyInvalid') }}
            </p>
            <p v-else-if="errors.typeKeyTaken" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.typeKeyTaken', { typeKey: draft.typeKey }) }}
            </p>
            <p v-else class="mt-1 text-xs text-muted-foreground">
              {{ isEditing ? t('settings.documents.editor.typeKeyImmutableHint') : t('settings.documents.editor.typeKeyHint') }}
            </p>
          </div>
          <div>
            <label class="text-sm font-medium" for="template-icon">
              {{ t('settings.documents.editor.iconLabel') }}
            </label>
            <Input
              id="template-icon"
              :model-value="draft.icon ?? ''"
              :placeholder="t('settings.documents.editor.iconPlaceholder')"
              :disabled="isReadonly"
              data-testid="template-icon"
              class="mt-1"
              @update:model-value="(value: string) => updateField('icon', value)"
            />
          </div>
          <div>
            <label class="text-sm font-medium">{{ t('settings.documents.editor.extractionModeLabel') }}</label>
            <Select
              :model-value="draft.extractionMode"
              :disabled="isReadonly"
              @update:model-value="(value: string) => updateField('extractionMode', value as DocumentExtractionMode)"
            >
              <SelectTrigger class="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in extractionModes"
                  :key="option"
                  :value="option"
                >
                  {{ t(`settings.documents.editor.mode.${option}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ t('settings.documents.editor.extractionModeHint') }}
            </p>
          </div>
        </div>

        <div class="mt-4">
          <label class="text-sm font-medium" for="template-prompt-preset">
            {{ t('settings.documents.editor.promptPresetLabel') }}
          </label>
          <Textarea
            id="template-prompt-preset"
            :model-value="draft.promptPreset ?? ''"
            :placeholder="t('settings.documents.editor.promptPresetPlaceholder')"
            :disabled="isReadonly"
            data-testid="template-prompt-preset"
            class="mt-1 min-h-[80px]"
            @update:model-value="(value: string) => updateField('promptPreset', value)"
          />
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard class="mt-4">
        <TemplateFieldsEditor
          :fields="editableFields"
          :readonly="isReadonly"
          @update:fields="updateFields"
          @add="addField"
        />
      </SettingsSectionCard>

      <div v-if="isReadonly" class="mt-4">
        <Alert>
          <Icon icon="lucide:info" class="size-4" />
          <AlertDescription>{{ t('settings.documents.editor.readonlyHint') }}</AlertDescription>
        </Alert>
        <DcButton
          variant="default"
          size="sm"
          class="mt-3"
          data-testid="builtin-fork-cta"
          @click="forkBuiltin"
        >
          <Icon icon="lucide:copy" class="mr-2 size-4" />
          {{ t('settings.documents.editor.forkCta') }}
        </DcButton>
      </div>

      <TemplateTestExtract
        v-if="savedId"
        :template-id="savedId"
        class="mt-4"
      />
    </template>
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import { Textarea } from '@shadcn/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { Badge } from '@shadcn/components/ui/badge'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Spinner } from '@shadcn/components/ui/spinner'
import { DcButton } from '@dc-ui/components/button'
import SettingsPageShell from '../control-center/SettingsPageShell.vue'
import SettingsSectionCard from '../control-center/SettingsSectionCard.vue'
import TemplateFieldsEditor from './TemplateFieldsEditor.vue'
import TemplateTestExtract from './TemplateTestExtract.vue'
import {
  useDocumentsStore,
  type EditableTemplateDraft
} from '@/stores/documents'
import { settingsLeaveGuard } from '../services/settingsLeaveGuard'
import {
  DOCUMENT_EXTRACTION_MODES,
  type DocumentExtractionMode,
  type DocumentTemplate,
  type DocumentTemplateField
} from '@shared/documents'
import {
  addField as addFieldHelper,
  createEmptyField,
  isFieldKeyValid,
  isTypeKeyValid,
  normalizeOrders,
  validateFields,
  type EditableField
} from './templateFields'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const store = useDocumentsStore()

const extractionModes = DOCUMENT_EXTRACTION_MODES

const notFound = ref(false)
const isSaving = ref(false)
const saveError = ref(false)
const isDirty = ref(false)
const savedId = ref<string | undefined>(undefined)

interface Draft {
  id?: string
  typeKey: string
  name: string
  icon: string | null
  category: string
  fields: EditableField[]
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin: boolean
  builtinSourceId?: string | null
}

const draft = reactive<Draft>({
  typeKey: '',
  name: '',
  icon: null,
  category: '自定义',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: false,
  builtinSourceId: null
})

let savedSnapshot: Draft | null = null

const isEditing = computed(() => Boolean(draft.id))
const isReadonly = computed(() => draft.isBuiltin)
const pageTitle = computed(() =>
  isEditing.value
    ? draft.name
    : t('settings.documents.editor.newTitle')
)

const editableFields = computed(() => draft.fields)

const errors = computed(() => ({
  name: !draft.name.trim(),
  typeKeyInvalid: !isTypeKeyValid(draft.typeKey),
  typeKeyTaken:
    isTypeKeyValid(draft.typeKey) &&
    store.isTypeKeyTaken(draft.typeKey, draft.id)
}))

const fieldValidation = computed(() => validateFields(draft.fields))

const leaveGuardLease = settingsLeaveGuard.register({
  id: 'documents-template-editor',
  onDiscard: () => {
    if (savedSnapshot) {
      Object.assign(draft, savedSnapshot)
      draft.fields = savedSnapshot.fields.map((f) => ({ ...f }))
      isDirty.value = false
    }
  }
})

watch(
  draft,
  () => {
    const dirty = !savedSnapshot || !shallowEqualDraft(draft, savedSnapshot)
    isDirty.value = dirty
    leaveGuardLease.setRisk(dirty ? 'dirty' : 'clean')
  },
  { deep: true }
)

onBeforeUnmount(() => {
  leaveGuardLease.release()
})

function shallowEqualDraft(a: Draft, b: Draft | null): boolean {
  if (!b) return false
  return (
    a.id === b.id &&
    a.typeKey === b.typeKey &&
    a.name === b.name &&
    a.icon === b.icon &&
    a.category === b.category &&
    a.extractionMode === b.extractionMode &&
    a.promptPreset === b.promptPreset &&
    a.fields.length === b.fields.length &&
    a.fields.every((f, i) => shallowEqualField(f, b.fields[i]))
  )
}

function shallowEqualField(a: EditableField, b: EditableField): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.valueType === b.valueType &&
    a.required === b.required &&
    a.promptHint === b.promptHint &&
    a.validation === b.validation &&
    a.enumOptions === b.enumOptions &&
    a.order === b.order
  )
}

async function loadTemplate(id: string) {
  if (id === 'new') {
    const forkFrom = route.query.forkFrom as string | undefined
    if (forkFrom) {
      const source = store.templates.find((t) => t.id === forkFrom)
      if (source) {
        applyTemplateToDraft(source, { fork: true })
      } else {
        await store.loadTemplates()
        const fetched = store.templates.find((t) => t.id === forkFrom)
        if (fetched) applyTemplateToDraft(fetched, { fork: true })
      }
    }
    savedSnapshot = null
    return
  }

  let template: DocumentTemplate | undefined = store.templates.find(
    (t) => t.id === id
  )
  if (!template) {
    await store.loadTemplates()
    template = store.templates.find((t) => t.id === id)
  }
  if (!template) {
    notFound.value = true
    return
  }
  applyTemplateToDraft(template)
  savedId.value = template.id
}

function applyTemplateToDraft(template: DocumentTemplate, options?: { fork?: boolean }) {
  draft.id = options?.fork ? undefined : template.id
  draft.typeKey = options?.fork ? '' : template.typeKey
  draft.name = template.name
  draft.icon = template.icon
  draft.category = template.category
  draft.fields = template.fields.map((f) => toEditableField(f))
  draft.extractionMode = template.extractionMode
  draft.promptPreset = template.promptPreset
  draft.isBuiltin = template.isBuiltin
  draft.builtinSourceId = options?.fork ? template.id : template.builtinSourceId
  savedSnapshot = JSON.parse(JSON.stringify(draft))
}

function toEditableField(field: DocumentTemplateField): EditableField {
  return {
    key: field.key,
    label: field.label,
    valueType: field.valueType,
    required: field.required,
    promptHint: field.promptHint ?? '',
    validation: field.validation ?? '',
    enumOptions: field.enumOptions?.join(', ') ?? '',
    order: field.order
  }
}

function updateField<K extends keyof Draft>(key: K, value: Draft[K]) {
  draft[key] = value
}

function updateFields(fields: EditableField[]) {
  draft.fields = normalizeOrders(fields)
}

function addField() {
  draft.fields = addFieldHelper(draft.fields, createEmptyField(draft.fields.length + 1))
}

async function onSave() {
  if (errors.value.name) return
  if (errors.value.typeKeyInvalid || errors.value.typeKeyTaken) return
  if (Object.keys(fieldValidation.value).length > 0) return

  isSaving.value = true
  saveError.value = false
  try {
    const input: EditableTemplateDraft = {
      typeKey: draft.typeKey,
      name: draft.name,
      icon: draft.icon || null,
      category: draft.category as any,
      fields: draft.fields.map((f) => ({
        key: f.key,
        label: f.label,
        valueType: f.valueType,
        required: f.required,
        promptHint: f.promptHint || null,
        validation: f.validation || null,
        enumOptions: f.enumOptions ? f.enumOptions.split(',').map((s) => s.trim()).filter(Boolean) : null,
        order: f.order
      })),
      extractionMode: draft.extractionMode,
      promptPreset: draft.promptPreset || null,
      ...(draft.id ? { id: draft.id } : {}),
      ...(draft.builtinSourceId ? { builtinSourceId: draft.builtinSourceId } : {})
    }
    const saved = await store.saveTemplate(input)
    draft.id = saved.id
    savedId.value = saved.id
    savedSnapshot = JSON.parse(JSON.stringify(draft))
    isDirty.value = false
    leaveGuardLease.setRisk('clean')
  } catch (error) {
    console.error('[TemplateEditorPage] save failed', error)
    saveError.value = true
  } finally {
    isSaving.value = false
  }
}

function forkBuiltin() {
  if (!draft.builtinSourceId && !draft.id) return
  const sourceId = draft.builtinSourceId ?? draft.id!
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' },
    query: { forkFrom: sourceId }
  })
}

function goBack() {
  router.push({ name: 'settings-documents' })
}

loadTemplate(route.params.id as string)
</script>
```

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/settings/documents/TemplateEditorPage.test.ts --config vitest.config.renderer.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/renderer/settings/components/documents/TemplateEditorPage.vue test/renderer/settings/documents/TemplateEditorPage.test.ts
git commit -m "feat: add template editor page"
```

---

### Task 9: DocumentsSettings.vue（列表 Tab）

**Files:**
- Create: `src/renderer/settings/components/DocumentsSettings.vue`
- Create: `test/renderer/settings/documents/DocumentsSettings.test.ts`

职责：按 category 分组显示预置模板（卡片 grid）+ 自定义模板列表 + 新建按钮 + 删除（force 二次确认）+ 跳转编辑器。

- [x] **Step 1: 写测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const builtinContract = {
  id: 'tpl_contract', typeKey: 'contract', name: 'Contract', icon: null,
  category: '合同类', fields: [], extractionMode: 'auto', promptPreset: null,
  isBuiltin: true, builtinSourceId: null, version: 1, createdAt: 1, updatedAt: 1
}
const builtinInvoice = {
  ...builtinContract, id: 'tpl_invoice', typeKey: 'invoice_special', name: 'Invoice',
  category: '发票类'
}
const customTemplate = {
  ...builtinContract, id: 'tpl_custom', typeKey: 'custom_doc', name: 'Custom',
  isBuiltin: false
}

const stubStore = {
  templates: [builtinContract, builtinInvoice, customTemplate],
  isLoading: false,
  loadError: null,
  builtinTemplates: [builtinContract, builtinInvoice],
  customTemplates: [customTemplate],
  loadTemplates: vi.fn(async () => {
    stubStore.templates = [builtinContract, builtinInvoice, customTemplate]
    stubStore.builtinTemplates = [builtinContract, builtinInvoice]
    stubStore.customTemplates = [customTemplate]
  }),
  isTypeKeyTaken: vi.fn(),
  attemptDelete: vi.fn(async (id: string) => {
    stubStore.templates = stubStore.templates.filter((t) => t.id !== id)
    stubStore.customTemplates = stubStore.customTemplates.filter((t) => t.id !== id)
    return { kind: 'deleted' }
  }),
  saveTemplate: vi.fn(),
  testExtract: vi.fn()
}

async function setup(forceConfirm = false) {
  vi.resetModules()
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const DocumentsSettings = (
    await import('../../../src/renderer/settings/components/DocumentsSettings.vue')
  ).default

  const router = (await import('vue-router')).createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/documents', name: 'settings-documents', component: DocumentsSettings },
      { path: '/documents/template/:id', name: 'settings-documents-template', component: { template: '<div />' } }
    ]
  })
  await router.push('/documents')
  await router.isReady()

  const wrapper = mount(DocumentsSettings, {
    attachTo: forceConfirm ? document.body : undefined,
    global: {
      plugins: [router],
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: passthrough('SettingsSectionCard'),
        Icon: true,
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled" data-testid="dc-button"><slot /></button>'
        }),
        Badge: passthrough('Badge'),
        Alert: passthrough('Alert'),
        AlertDescription: passthrough('AlertDescription'),
        Spinner: true,
        AlertDialog: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogStub',
              props: { open: Boolean },
              template: '<div v-if="open"><slot /></div>'
            }),
        AlertDialogContent: forceConfirm ? false : passthrough('AlertDialogContent'),
        AlertDialogHeader: forceConfirm ? false : passthrough('AlertDialogHeader'),
        AlertDialogTitle: forceConfirm ? false : passthrough('AlertDialogTitle'),
        AlertDialogDescription: forceConfirm ? false : passthrough('AlertDialogDescription'),
        AlertDialogFooter: forceConfirm ? false : passthrough('AlertDialogFooter'),
        AlertDialogCancel: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogCancelStub',
              template: '<button data-testid="delete-cancel"><slot /></button>'
            }),
        AlertDialogAction: forceConfirm
          ? defineComponent({
              name: 'AlertDialogActionStub',
              props: ['disabled'],
              emits: ['click'],
              template:
                '<button data-testid="delete-confirm" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
            })
          : defineComponent({
              name: 'AlertDialogActionStub',
              props: ['disabled'],
              template: '<button :disabled="disabled"><slot /></button>'
            }),
        AlertDialogAsyncAction: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogAsyncActionStub',
              template: '<button><slot /></button>'
            })
      }
    }
  })
  await flushPromises()
  return { wrapper, router }
}

describe('DocumentsSettings', () => {
  beforeEach(() => {
    stubStore.templates = [builtinContract, builtinInvoice, customTemplate]
    stubStore.builtinTemplates = [builtinContract, builtinInvoice]
    stubStore.customTemplates = [customTemplate]
    stubStore.loadTemplates.mockClear()
    stubStore.attemptDelete.mockClear()
  })

  it('renders builtin templates grouped by category', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="builtin-group"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('settings.documents.category.contract')
    expect(wrapper.text()).toContain('settings.documents.category.invoice')
  })

  it('renders custom templates section with edit button', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('[data-testid="custom-group"]').exists()).toBe(true)
    const editButtons = wrapper.findAll('[data-testid="template-edit"]')
    expect(editButtons).toHaveLength(1)
  })

  it('does not render edit/delete for builtin templates', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="template-edit"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="template-delete"]')).toHaveLength(1)
  })

  it('shows fork button for builtin templates', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="template-fork"]')).toHaveLength(2)
  })

  it('navigates to editor on edit button click', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="template-edit"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe('tpl_custom')
  })

  it('navigates to new template on create button', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="template-create"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe('new')
  })

  it('deletes custom template after confirmation', async () => {
    const { wrapper } = await setup(true)
    await wrapper.get('[data-testid="template-delete"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="delete-confirm"]')!.click()
    await flushPromises()
    expect(stubStore.attemptDelete).toHaveBeenCalledWith('tpl_custom', {})
    expect(wrapper.text()).not.toContain('Custom')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/DocumentsSettings.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（组件不存在）。

- [x] **Step 3: 写组件**

`src/renderer/settings/components/DocumentsSettings.vue`:

```vue
<template>
  <SettingsPageShell
    :title="t('routes.settings-documents')"
    :description="t('settings.documents.description')"
    data-testid="documents-settings-page"
  >
    <div class="mb-4 flex justify-end">
      <DcButton variant="default" size="sm" data-testid="template-create" @click="createNew">
        <Icon icon="lucide:plus" class="mr-2 size-4" />
        {{ t('settings.documents.templates.create') }}
      </DcButton>
    </div>

    <Alert v-if="store.loadError" variant="destructive" class="mb-4">
      <Icon icon="lucide:circle-alert" class="size-4" />
      <AlertDescription class="flex items-center gap-3">
        <span>{{ t('settings.documents.templates.loadFailed') }}</span>
        <DcButton variant="outline" size="sm" data-testid="retry-load" @click="store.loadTemplates">
          <Icon icon="lucide:refresh-cw" class="mr-2 size-4" />
          {{ t('settings.documents.templates.retry') }}
        </DcButton>
      </AlertDescription>
    </Alert>

    <div v-if="store.isLoading" class="flex items-center text-sm text-muted-foreground">
      <Spinner class="mr-2 size-4" />
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <SettingsSectionCard
        v-for="group in builtinGroups"
        :key="group.category"
        :title="t(`settings.documents.category.${categoryKey(group.category)}`)"
        class="mb-4"
      >
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="builtin-group">
          <div
            v-for="template in group.templates"
            :key="template.id"
            class="rounded-lg border p-4"
          >
            <div class="flex items-start justify-between">
              <div>
                <div class="font-medium">{{ template.name }}</div>
                <div class="text-xs text-muted-foreground">
                  {{ t('settings.documents.templates.fieldCount', { count: template.fields.length }) }}
                </div>
              </div>
              <Icon :icon="template.icon ?? 'lucide:file-text'" class="size-5 text-muted-foreground" />
            </div>
            <div class="mt-3 flex gap-2">
              <DcButton
                variant="outline"
                size="sm"
                data-testid="template-view"
                @click="edit(template.id)"
              >
                {{ t('settings.documents.templates.view') }}
              </DcButton>
              <DcButton
                variant="ghost"
                size="sm"
                data-testid="template-fork"
                @click="fork(template.id)"
              >
                <Icon icon="lucide:copy" class="mr-1 size-4" />
                {{ t('settings.documents.templates.fork') }}
              </DcButton>
            </div>
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        :title="t('settings.documents.templates.customGroup')"
        data-testid="custom-group"
      >
        <div v-if="store.customTemplates.length === 0" class="text-sm text-muted-foreground">
          {{ t('settings.documents.templates.empty') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="template in store.customTemplates"
            :key="template.id"
            class="flex items-center justify-between rounded-lg border p-3"
          >
            <div>
              <div class="font-medium">{{ template.name }}</div>
              <div class="text-xs text-muted-foreground">
                {{ t('settings.documents.templates.fieldCount', { count: template.fields.length }) }}
              </div>
            </div>
            <div class="flex gap-2">
              <DcButton
                variant="outline"
                size="sm"
                data-testid="template-edit"
                @click="edit(template.id)"
              >
                <Icon icon="lucide:pencil" class="mr-1 size-4" />
                {{ t('settings.documents.templates.edit') }}
              </DcButton>
              <DcButton
                variant="ghost"
                size="sm"
                data-testid="template-delete"
                @click="requestDelete(template)"
              >
                <Icon icon="lucide:trash-2" class="mr-1 size-4" />
                {{ t('settings.documents.templates.delete') }}
              </DcButton>
            </div>
          </div>
        </div>
      </SettingsSectionCard>
    </template>

    <AlertDialog v-model:open="deleteConfirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ deleteDialogTitle }}</AlertDialogTitle>
          <AlertDialogDescription>{{ deleteDialogDescription }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-cancel">
            {{ t('common.cancel') }}
          </AlertDialogCancel>
          <AlertDialogAction
            :disabled="isDeleting"
            data-testid="delete-confirm"
            @click="confirmDelete"
          >
            {{ t('common.confirm') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Spinner } from '@shadcn/components/ui/spinner'
import { DcButton } from '@dc-ui/components/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@shadcn/components/ui/alert-dialog'
import SettingsPageShell from './control-center/SettingsPageShell.vue'
import SettingsSectionCard from './control-center/SettingsSectionCard.vue'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentTemplate } from '@shared/documents'
import { DOCUMENT_TEMPLATE_CATEGORIES, type DocumentTemplateCategory } from '@shared/documents'

const { t } = useI18n()
const router = useRouter()
const store = useDocumentsStore()

const deleteConfirmOpen = ref(false)
const pendingDelete = ref<DocumentTemplate | null>(null)
const isDeleting = ref(false)
const forceRequired = ref<{ count: number } | null>(null)

const builtinGroups = computed(() => {
  const groups: Array<{ category: string; templates: DocumentTemplate[] }> = []
  for (const category of DOCUMENT_TEMPLATE_CATEGORIES) {
    const templates = store.builtinTemplates.filter((t) => t.category === category)
    if (templates.length > 0) {
      groups.push({ category, templates })
    }
  }
  return groups
})

const deleteDialogTitle = computed(() => {
  if (!pendingDelete.value) return ''
  return t('settings.documents.templates.deleteConfirmTitle')
})

const deleteDialogDescription = computed(() => {
  if (!pendingDelete.value) return ''
  if (forceRequired.value) {
    return t('settings.documents.templates.deleteForceDescription', {
      count: forceRequired.value.count
    })
  }
  return t('settings.documents.templates.deleteConfirmDescription', {
    name: pendingDelete.value.name
  })
})

function categoryKey(category: DocumentTemplateCategory): string {
  const map: Record<DocumentTemplateCategory, string> = {
    合同类: 'contract',
    出行票据类: 'travel',
    采购类: 'purchase',
    支付凭证类: 'payment',
    发票类: 'invoice',
    自定义: 'custom'
  }
  return map[category] ?? 'custom'
}

function edit(id: string) {
  router.push({
    name: 'settings-documents-template',
    params: { id }
  })
}

function fork(sourceId: string) {
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' },
    query: { forkFrom: sourceId }
  })
}

function createNew() {
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' }
  })
}

async function requestDelete(template: DocumentTemplate) {
  pendingDelete.value = template
  forceRequired.value = null
  deleteConfirmOpen.value = true
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  isDeleting.value = true
  try {
    const result = await store.attemptDelete(pendingDelete.value.id, {
      force: Boolean(forceRequired.value)
    })
    if (result.kind === 'force-required') {
      forceRequired.value = { count: result.referenceCount }
      // keep dialog open for second confirmation
      return
    }
    deleteConfirmOpen.value = false
    pendingDelete.value = null
    forceRequired.value = null
  } catch {
    // error already captured by store
  } finally {
    isDeleting.value = false
  }
}

onMounted(() => {
  if (store.templates.length === 0) {
    store.loadTemplates()
  }
})
</script>
```

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/settings/documents/DocumentsSettings.test.ts --config vitest.config.renderer.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/renderer/settings/components/DocumentsSettings.vue test/renderer/settings/documents/DocumentsSettings.test.ts
git commit -m "feat: add documents settings tab"
```

---

### Task 10: 收尾验证（全量测试 + typecheck + lint + format）

**Files:** 无新文件，仅运行验证。

- [x] **Step 1: 渲染层全量测试**

PowerShell:
```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'; pnpm run test:renderer
```
Expected: 全部 PASS（不引入既有测试失败，确认新测试文件全 PASS）。

- [x] **Step 2: typecheck**

Run: `pnpm run typecheck`
Expected: 0 errors。

- [x] **Step 3: lint**

Run: `pnpm run lint`
Expected: 0 errors。

- [x] **Step 4: format**

Run: `pnpm run format`
Expected: 全部已格式化（Oxfmt 单引号无分号 100 列）。

- [x] **Step 5: i18n 校验**

Run:
```bash
pnpm run i18n
pnpm run i18n:en
```
Expected: 0 missing / 0 extra。

- [x] **Step 6: 推送 develop**

```bash
git push origin develop
```
Expected: push 成功；远端 CI 通过（用户期望阶段完成后推 origin/develop，既定模式）。

---

## 自查

### 1. Spec 覆盖

- 模板列表 CRUD：Task 9（列表 + 新建 + 删除 force 二次确认）
- 独立模板编辑器页：Task 3（路由）+ Task 8（组件）
- 字段编辑 + 拖拽排序：Task 4（纯函数）+ Task 6（编辑器子组件，含 useSortable）
- 样张测试：Task 7（折叠区，调 store.testExtract → DocumentsClient.testExtract → P2 路由）
- 预置模板分组（category 二级分组）：Task 9（builtinGroups by DOCUMENT_TEMPLATE_CATEGORIES）
- 复制为自定义（fork）：Task 8（forkFrom query + builtinSourceId）+ Task 9（fork 按钮）
- dirty 守卫（onBeforeRouteLeave 拦截）：Task 8（settingsLeaveGuard 集成）
- i18n 全 20 语言包：Task 2
- shadcn-vue 组件复用：Tasks 6/7/8/9
- Pinia store 缓存：Task 5

### 2. 占位符扫描

- ✅ 每个 step 都有具体代码或命令
- ✅ 无 "TBD" / "TODO" / "implement later"
- ✅ 无 "Add appropriate error handling"
- ✅ 无 "Similar to Task N"（所有代码都重新展示）
- ✅ 无未定义的类型/函数（DocumentsClient / EditableField / settingsLeaveGuard 均在前置 task 或现有代码中定义）

### 3. 类型一致性

- `EditableField`：Task 4 定义，Task 6/8 使用（key/label/valueType/required/promptHint/validation/enumOptions/order）
- `EditableTemplateDraft`：Task 5 定义，Task 8 使用
- `DocumentsClient`：`src/renderer/api/DocumentsClient.ts` 已导出，Task 5 使用
- `DocumentTemplate` / `DocumentFieldValueType` / `DocumentExtractionMode`：`@shared/documents` 已导出
- `settingsLeaveGuard`：`src/renderer/settings/services/settingsLeaveGuard.ts` 已导出
- `createFileClient`：`@api/FileClient` 已导出
- `DOCUMENT_TEMPLATE_CATEGORIES` / `DOCUMENT_FIELD_VALUE_TYPES` / `DOCUMENT_EXTRACTION_MODES`：`@shared/documents` 已导出
- i18n key 前缀 `settings.documents.*`：与 spec §8 一致
- 路由 name `settings-documents` / `settings-documents-template`：Task 3 注册，Task 8/9 使用

### 4. 已知偏差与说明

- **useSortable 的 reactive target 写法**：实现时需确保 useSortable 监听 list ref 的 DOM 重排，而非直接 mutate props.fields（Vue 单向数据流）。Task 6 实现注释中已标注 `disabled` 选项应改为 computed。
- **da-DK 文案笔误**：Task 2 Step 5 da-DK 块中 "Auto路由" 为笔误，写入时已修正为 "Auto routet efter filtype"。实现者复制 JSON 时以修正后的为准。
- **TemplateTestExtract 单测**：Task 7 不单测，因行为委托 store（Task 5 已覆盖），UI 渲染分层在 Task 8 集成测试中合测。

### 5. 执行期偏差记录（实现完成后补记）

- **Task 2 附带**：补齐 3f6f9f0 遗留的 18 语言包 `provider.dialog.duplicate.*` + `provider.menu.duplicate` 缺译（043ae93），否则收尾 `pnpm run i18n` 无法通过。
- **Task 3**：额外扩展 `system.routes.ts` 与 `settings.events.ts` 两处 `SettingsRouteNameSchema` zod enum（否则 IPC openSettings/navigateRequested 运行时拒绝新路由，4cba49f）。
- **Task 4**：计划内部不一致（validateFields 实现只标后续重复 vs 测试断言首尾都标）以测试为准修实现：所有 count>1 的 key 均标 'duplicated'（80f83cd）。
- **Task 5**：测试加 `vi.mock('pinia', importActual)`（setup.renderer.ts 轻量 mock 缺 setActivePinia，与既有 store 测试同模式）；client 返回边界两处 `as DocumentTemplate` cast（wire schema category 为 string、shared 类型为字面量联合，与 repository.ts 既有 cast 风格一致）。
- **Task 6**：5 处——测试 import 4 级路径；`disabled` 经 `sortable.option('disabled', v)` + watch 实现（useSortable 不解包 options 内 ref，computed 会恒 truthy）；stub 去 TS as 断言；Input/Select 事件签名 `(value) => ... String(value)`（shadcn emit `string | number`）；grip Icon 显式补 `lucide-grip-vertical` class（iconify 不注入图标名 class，否则 handle 选择器永不命中）。
- **Task 6 补缺**：字段行补 promptHint/validation/enumOptions 三个输入（spec §8 L178 要求，计划代码遗漏；bdd9c6f）。
- **Task 7**：计划代码漏声明 `open` ref，补 `const open = ref(false)`（e3ded55）。
- **Task 8**：9 处计划 bug 修正（测试路径/leave guard mock 路径与非法 type 断言/vue-router importActual/stub as 断言/组件内 `../../services` 导入/未用导入/category 类型/事件签名），另加 `watch(() => route.params.id)` 重载（fork CTA 同路由记录跳转组件复用）；fork 预填 `isBuiltin` 固定 false（继承 true 会使 fork 页只读，dcaecbb）。
- **Task 9**：6 处——vue-router importActual；测试 import 4 级路径；reactive stub store + 渲染 title 的 SectionCard stub（计划桩与其自身断言矛盾）；attemptDelete 传参 `{force:true}|{}`；`AlertDialogAsyncAction`（alert-dialog-contract-guard 禁 async handler 绑 AlertDialogAction，且 AsyncAction 不自动关弹窗满足 force 二次确认）；category 类型收紧 + requestDelete 去 async。补 rejected 反馈：删除被拒时保持弹窗并显示 messageKey 文案（1e2ca75）。
- **组件测试通用**：setup.renderer.ts 全局 mock vue-router，组件测试统一用 `vi.doMock('vue-router', () => vi.importActual('vue-router'))` 恢复真路由。
