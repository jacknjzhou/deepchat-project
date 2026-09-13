---
name: invoice-recognition
description: 识别发票并提取结构化信息。Use when the user provides invoice
  images/PDFs or asks to extract invoice fields (发票/收据/报销票据).
metadata:
  deepchatFeature: office-automation
---

# invoice-recognition

Guide the agent to extract structured invoice data using the vision model.
Do NOT attempt to parse invoices with regex or external OCR tools — the
vision model reads the invoice layout directly.

## Runtime Context

- Plugin id: `${OWNER_PLUGIN_ID}`.
- Plugin root: `${PLUGIN_ROOT}`.
- Server id: `office-reimbursement` (downstream tools).

## When To Use

- 用户附加发票图片/PDF，或提到 发票 / 收据 / 报销 / 提取发票信息
- office-reimbursement Skill 需要发票数据作为输入

## Prerequisites

- 当前模型具备视觉能力，或已配置 defaultVisionModel
- 若均不可用：引导用户配置视觉模型，或请用户改用文字描述（不要臆造字段）

## Required Loop

1. 获取发票文件：会话附件优先；用户仅提供路径时读取文件后经视觉通道分析
2. 视觉模型按 Extraction Template 提取字段，输出严格 JSON
3. 校验（不过则标注问题字段，请用户核对）：
   - 价税合计 = 金额 + 税额
   - 发票号码 8 位 / 发票代码 10-12 位
   - 开票日期格式 YYYY-MM-DD（或 YYYY年MM月DD日 归一化）
4. 向用户展示提取结果表格，等待确认或修正
5. 确认后输出最终 JSON（供 create_reimbursement 等下游工具使用）

## Extraction Template

{
  "invoiceType": "增值税专用发票 | 增值税普通发票 | 电子发票 | 收据 | 其他",
  "invoiceCode": "string | null",
  "invoiceNumber": "string | null",
  "issueDate": "YYYY-MM-DD",
  "buyer": { "name": "string", "taxId": "string | null" },
  "seller": { "name": "string", "taxId": "string | null" },
  "amount": "number (不含税, 两位小数)",
  "tax": "number",
  "totalAmount": "number (价税合计)",
  "items": [{ "name": "string", "qty": "number", "unitPrice": "number", "amount": "number" }],
  "uncertainFields": ["识别置信度低的字段名"]
}

## Important Notes

- 缺失字段填 null，禁止凭空补全
- 金额一律两位小数；不要对金额做四舍五入以外的加工
- 多张发票逐张提取、逐张校验，最后汇总总额与总税额
- 可选：baidu_web_search 核验销售方信息或查询报销政策（只读，自动放行）
- 提取结果必须经用户确认后才可进入 create_reimbursement 流程
