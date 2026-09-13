---
name: office-reimbursement
description: Guide the agent through the complete reimbursement workflow
  (发票报销全流程). Use when the user asks to 报销, submit expenses,
  or track a reimbursement.
metadata:
  deepchatFeature: office-automation
---

# office-reimbursement

Guide the agent through the complete reimbursement workflow:
invoice recognition → reimbursement creation → approval submission → status tracking.

## Runtime Context

- Plugin id: `${OWNER_PLUGIN_ID}`.
- Plugin root: `${PLUGIN_ROOT}`.
- Server id: `office-reimbursement`.

## When To Activate

- User mentions 报销, reimbursement, 发票, expense
- User provides invoice images or PDFs for reimbursement
- User asks to track or query reimbursement status

## Workflow

### Step 1: Collect and Recognize Invoices

1. Follow the invoice-recognition skill to extract structured data for each
   invoice (vision model extraction, validation, user confirmation)
2. Summarize: list all recognized invoices with amounts, dates, and types
3. Calculate total amount and tax amount

### Step 2: Create Reimbursement

1. Ask user for:
   - Reimbursement type (差旅费/办公费/招待费/培训费/其他)
   - Department and project code (if applicable)
2. Call `create_reimbursement` with:
   - Invoice data from Step 1
   - User-provided metadata
   - Attachment file paths
3. Present the generated reimbursement summary for user confirmation

### Step 3: Submit for Approval

1. Ask user to confirm the reimbursement details
2. Ask user to specify the approver (or use default approval chain)
3. Call `submit_reimbursement` with the reimbursement ID
4. Return the approval instance ID and current status

### Step 4: Track Status (on request)

1. Call `track_reimbursement` with the approval instance ID
2. Report current approval node, approver, and status
3. If approved, offer to export the reimbursement record

## Important Notes

- ALWAYS confirm with user before submitting (submit_reimbursement)
- Verify invoice data completeness before creating reimbursement
- If vision extraction confidence is low, ask user to verify extracted data
- Support batch processing for multiple invoices
- 可选：baidu_web_search 查询报销政策或核验开票方信息（只读）
