---
name: document-recognition
description: 识别行政单据（发票/合同/行程单/住宿单/订购单/付款截图等）并归档。Use when the user
  provides document images/PDFs or asks to extract, archive, or reimburse document fields
  (发票/收据/合同/行程单/报销票据).
metadata:
  deepchatFeature: office-automation
---

# document-recognition

Guide the agent to recognize administrative documents through the built-in
`document_recognition` agent tool. Do NOT parse documents with regex or
external OCR tools, and do NOT hand-craft extraction prompts — the main
process extraction service routes by file type and generates prompts from
the selected template.

## When To Use

- 用户附加单据图片/PDF，或提到 发票 / 收据 / 合同 / 行程单 / 住宿单 / 订购单 / 付款截图 / 报销
- 需要把单据字段归档（draft → confirmed）供报销/汇总使用

## Required Loop

1. 调用 `document_recognition`（action: `list_templates`）获取可用模板，
   按文档内容选择最匹配的模板 id（如发票 → invoice_special / invoice_general）
2. 调用 `document_recognition`（action: `recognize`，带 templateId 与
   file.path——会话附件优先，用户提供路径时直接使用该路径）
3. 向用户展示返回的 fields 表格，uncertain 字段高亮提示核对；
   缺失字段显示为空，禁止臆造
4. 用户确认或修正后：action: `confirm`（documentId；修正值通过 fields 传入）
5. 报销场景：确认后的字段按 create_reimbursement 工具的 invoices 入参
   结构整理后调用下游工具

## Important Notes

- recognize 每次生成一条 draft 档案记录；重新识别会产生新记录
- 金额一律两位小数；不对金额做四舍五入以外的加工
- 多张单据逐张识别、逐张确认
- 视觉模型不可用时 recognize 返回降级提示，引导用户配置 defaultVisionModel
