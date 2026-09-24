# 内置模板与标准配置（YAML）同步计划

## Context

`docs/superpowers/specs/templates/` 下新增了 13 份内置模板标准配置（YAML）。当前 `src/main/documents/presetTemplates.json` 只 seed 了 10 个内置模板，且 `seed.ts` 对已存在 typeKey 直接跳过——已装机用户永远拿不到字段更新。需要：已配置的模板补齐标准配置中缺失的字段/校验/枚举；未配置的 10 个模板新增；并为既有安装打通 seed 升级路径。

**已确认的关键机制**（探索结论）：
- 内置模板无用户编辑路由（[routes.ts](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\main\documents\routes.ts) 只有 fork），只能 forkTemplate 复制为自定义 → seed 覆盖内置模板字段是安全的。
- [documentTemplates.ts](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\main\documents\data\tables\documentTemplates.ts) `upsert` 对已存在 typeKey 会覆盖 name/category/fields_json 等并递增 version → seed 升级可直接复用，但需"内容不变则跳过"避免每次启动 version 空转。
- 类别仅在 [DocumentsSettings.vue](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\renderer\settings\components\DocumentsSettings.vue) 动态迭代 `DOCUMENT_TEMPLATE_CATEGORIES` → 扩展枚举即自动生效，无 i18n。
- 分类候选来自 `listTemplates()` 全量，无 typeKey 硬编码 → 新模板自动进入分类。
- 运行时字段类型支持 enum（含 enumOptions）、validation 正则已有（fieldValidator）。
- YAML 含嵌套数组（如 payment_schedule.items）而 `DocumentTemplateField` 无嵌套结构 → 参照现有 line_items 模式：数组类型 + 把子字段结构写进 promptHint。

## 对应关系与策略（原则：只增不删；同义字段保留现有 key，吸收标准配置的 label/hint/rule/required/enum）

### A. 已配置、需补齐（3 个）
| YAML 标准 | 现有模板 (typeKey) | 处理 |
|---|---|---|
| vat_invoice（增值税发票） | 增值税专用发票 (invoice_special)、普通发票 (invoice_general) | 两张表各自做**增量合并**（见下） |
| lease_contract（租赁合同） | 租赁合同模板 (lease_contract) | 增量合并 |
| purchase_sales_contract（采购/销售合同） | 合同模板 (contract) | 增量合并 |

- **invoice_special**：新增 `invoice_type`（enum：专票/普票/电子专票/电子普票/数电）；`tax_rate` 从 text 升级为 enum（13%/9%/6%/5%/3%/1%/0%/免税）；同义吸收 YAML：`buyer_tax_no`←buyer_tax_id（加 rule `^[0-9A-Z]{18}$`）、`seller_tax_no`←seller_tax_id（同 rule）、`amount_ex_tax`←amount（吸收 hint）、`invoice_remark`←remark；`invoice_code` 按 YAML 改 required:false。现有 buyer_address/buyer_bank/seller_address/seller_bank/amount_upper/drawer/checker/payee/line_items 保留。
- **invoice_general**：新增 `invoice_type`、`buyer_tax_no`、`tax_rate`（enum）、`tax_amount`、`amount_ex_tax`；`invoice_code` required:false。其余保留。
- **lease_contract**：新增 `lease_type`（enum）、`area`、`escalation_clause`、`free_rent_period`、`breach_clause`；`payment_cycle` 升级 enum（月付/季付/半年付/年付/一次性）；`lease_object`←property_address（改 label"租赁物地址/描述"+hint）；`deposit` required:false。
- **contract**：新增 `contract_name`、`contract_type`（enum）、`subject_matter`、`tax_rate`（enum）、`payment_schedule`（array，promptHint 写明 `[{milestone, ratio, amount, trigger}]` 结构）、`seal_status`（enum）、`breach_clause`、`start_date`/`end_date`；`party_a`/`party_b` 吸收 hint；`contract_amount`←total_amount（吸收 hint）。

### B. 全新模板（10 个）
| YAML | name | typeKey | category |
|---|---|---|---|
| expense_claim | 报销单 | expense_claim | 财务类（新） |
| asset_acceptance | 资产验收单 | asset_acceptance | 资产类（新） |
| bank_receipt | 银行回单 | bank_receipt | 财务类（新） |
| meeting_minutes | 会议纪要 | meeting_minutes | 行政类（新） |
| official_incoming | 红头文件/收文 | official_incoming | 行政类 |
| onboarding_offboarding | 入职/离职单 | onboarding_offboarding | 人事类（新） |
| resume | 简历 | resume | 人事类 |
| quotation | 报价单 | quotation | 采购类（复用现有） |
| nda | 保密协议（NDA） | nda | 合同类（复用） |
| tender_notice | 招标公告/招标文件 | tender_notice | 招投标类（新） |

付款截图 (payment_screenshot) 与银行回单语义不同，两者并存。

## 改动文件

1. **[src/shared/documents.ts](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\shared\documents.ts)**
   - `DOCUMENT_TEMPLATE_CATEGORIES` 追加：`财务类`、`资产类`、`行政类`、`人事类`、`招投标类`。
   - `PRESET_TEMPLATE_TYPE_KEY_MAP` 追加 10 个 name→typeKey。
2. **[src/main/documents/presetTemplates.json](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\main\documents\presetTemplates.json)**（seed 数据源，YAML 不进运行时、不引入 YAML 解析依赖）
   - 按 A 的合并表更新 3 个既有模板（吸收 label/hint/rule/required/enum，字段顺序：既有顺序在前，新字段按 YAML 顺序追加）。
   - 新增 10 个模板条目。JSON 字段结构扩展：在 key/label/type/desc/required 基础上增加 `enum_values?: string[]`、`rule?: string`；嵌套数组按 line_items 模式把子字段结构写进 desc。
   - `version` 提到 "2.0"。
3. **[src/main/documents/seed.ts](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\main\documents\seed.ts)**
   - `SeedFieldRaw` 增加 `enum_values?`、`rule?`；`toFields` 映射：`money`→number（`SEED_VALUE_TYPE_MAP` 或 overrides 加 money/enum→enum）、`enum`+enum_values→`valueType:'enum'`+`enumOptions`、rule→`validation`、required 缺省仍 true。
   - **升级路径**：对已存在 typeKey 的内置模板不再直接 `continue`，改为对比现有 `fieldsJson`（及 name/category）与期望值，不一致才 `upsert`（覆盖字段、version+1）；一致则跳过。fork 出的自定义模板（isBuiltin=false）不受影响。
4. **[test/main/documents/documentsTables.test.ts](d:\sync-workspace\traework\tools-market-project\deepchat-project\test\main\documents\documentsTables.test.ts)**
   - 更新 'seeds all 10 preset templates idempotently'（数量与断言改为 23；idempotent 断言扩展为二次 seed 不再递增 version）。
   - 新增用例：预置旧版字段行 → seed → 字段被升级（新增字段存在、version 递增）；自定义 fork 模板不被 seed 覆盖。
5. 若 [DocumentsSettings.vue](d:\sync-workspace\traework\tools-market-project\deepchat-project\src\renderer\settings\components\DocumentsSettings.vue) 存在按类别的图标/颜色映射表，为新类别补条目（探索显示类别是动态迭代，预计无需改；执行时确认）。

## 执行注意

- presetTemplates.json 较大（~680 行），用 Python/Node 脚本从 YAML 机械转换生成新模板条目可减少手抄错误；合并 3 个既有模板手工编辑。
- `PRESET_TEMPLATE_TYPE_KEY_MAP` 按 name 逐字匹配，新增名与现有名无冲突（"增值税发票"≠"增值税专用发票"，"租赁合同"≠"租赁合同模板"）。
- 提交拆分：`feat(documents): sync preset templates with standard specs`（数据+seed+shared）；Conventional Commits ≤50 字符；排除工作区无关文件（resources/*、icons generated、docs/plans）。

## 验证

1. `ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`（含 seed/table/routes 全套）。
2. `pnpm run format && pnpm run lint && pnpm run typecheck:node && pnpm run typecheck:web`。
3. 手动：`pnpm run build` 重启 → 设置页模板管理应出现 23 个内置模板与 5 个新类别（旧库启动时字段自动升级、二次启动 version 不变）；上传一份招标公告/报销单样张走 auto 分类验证新模板可被选中并提取。
