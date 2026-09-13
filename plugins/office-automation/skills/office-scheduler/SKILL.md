---
name: office-scheduler
description: Guide the agent to configure scheduled office tasks
  (定时办公任务). Use when the user asks to set up recurring reminders
  or scheduled jobs for reimbursements, approvals, or reports.
metadata:
  deepchatFeature: office-automation
---

# office-scheduler

Guide the agent to configure scheduled office tasks using the cronjob
Agent Tool combined with office-automation MCP tools.

## Runtime Context

- Plugin id: `${OWNER_PLUGIN_ID}`.
- Plugin root: `${PLUGIN_ROOT}`.
- Servers: `office-reimbursement`, `office-workflow`, and the agent `cronjob` tool.

## When To Activate

- 用户要求定时/每周/每月提醒（报销提醒、审批催办、报表生成）
- register_workflow_callback 返回 cronConfig 需要落地为 cronjob 时
- 用户要求管理（查看/暂停/删除）已有办公定时任务

## Task Templates

### 报销提醒 (weekly)

- cron: `0 9 * * 1`（每周一 09:00）
- task: 提醒用户整理上周发票，并列出 list_reimbursements 中未提交的草稿

### 审批催办 (interval)

- cron: `*/30 * * * *`（每 30 分钟，按 callback 配置）
- task: 对 register_workflow_callback 登记的实例调用 track_workflow，
  状态变化时通知用户；到达终态（APPROVED/REJECTED/CANCELED）后删除本任务

### 月度报表 (monthly)

- cron: `0 9 1 * *`（每月 1 日 09:00）
- task: list_reimbursements 汇总上月报销数据，生成月度报销统计

## Workflow

1. 明确任务目标、频率与投递方式（delivery targets）
2. 按模板生成 cron 表达式与任务描述（cron 表达式用英文，任务描述用用户语言）
3. 调用 `cronjob` Agent Tool 创建任务
4. 向用户确认创建结果与下次执行时间

## Important Notes

- cron 表达式遵循标准 5 字段格式；分钟级任务最短间隔 1 分钟
- 任务描述必须是自包含的：调度会话没有当前上下文，需写明调用哪些工具、判定条件、终态清理
- 涉及提单/撤销等写操作的定时任务必须只做"提醒"，由用户人工确认后执行
