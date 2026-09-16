---
name: process-submission
description: Guide the agent to submit and track approval workflows
  (审批流程提交). Use when the user asks to 发起审批/提交流程 or track
  an approval instance.
metadata:
  deepchatFeature: office-automation
---

# process-submission

Guide the agent to submit generic approval workflows and track their status.

## Runtime Context

- Plugin id: `${OWNER_PLUGIN_ID}`.
- Plugin root: `${PLUGIN_ROOT}`.
- Server id: `office-workflow-server`.

## When To Activate

- 用户要求发起审批 / 提交流程 / 走审批（非报销类，报销走 office-reimbursement）
- 用户查询审批进度 / 待办 / 撤销审批
- 用户要求审批同意/拒绝（注意 approve_workflow 的身份限制）

## Workflow

1. 理解用户审批需求，必要时询问流程类型与表单内容
2. Call `search_workflow_definitions`（关键词搜索，如 请假/采购/合同）
3. Call `get_workflow_definition` 获取表单定义
4. 按表单定义辅助用户填写（缺失字段主动询问，不臆造）
5. [用户确认] Call `submit_workflow` 提交，返回 instance_id
6. 追踪：Call `track_workflow`；用户需要时 `register_workflow_callback` 登记轮询通知

## Important Notes

- ALWAYS confirm with user before `submit_workflow` and `cancel_workflow`
- `approve_workflow` 需审批人用户身份授权，当前不可用时引导用户在飞书客户端人工审批
- `list_pending_approvals` 需要用户 open_id，缺失时询问用户或从上下文获取
- 流程定义采用动态搜索，不要硬编码 approval_code
- 表单字段值一律使用字符串；金额两位小数；日期 YYYY-MM-DD
