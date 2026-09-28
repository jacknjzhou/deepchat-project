# Changelog — web-scraper

All notable changes to this skill will be documented in this file.

## [2.0.0] — 2026-09-28

### Changed
- 本地化改造：移除 OpenRouter 依赖（`OPENROUTER_API_KEY` 与外部 LLM API 调用），实体提取改由本地已配置的会话模型直接完成
- 网页抓取改用 DeepChat 内置浏览器工具（YoBrowser：`load_url` + `cdp_send`，支持 JS 渲染），静态页回退 `exec` + curl
- 清洗、新闻识别与元数据提取改由会话模型完成，移除 Python 依赖清单与脚本生成流程

### Removed
- 删除 OpenClaw 平台清单 claw.json

## [1.0.0] — 2025-02-23

### Added
- Initial release
- 5-stage extraction pipeline
- News/article detection with URL pattern and Schema.org analysis
- Multi-strategy cascade (static HTTP → Playwright → Scrapy)
- Boilerplate removal via trafilatura
- Structured metadata extraction with YAML config
- LLM entity extraction via OpenRouter (optional)
- Rate limiting with exponential backoff
- Incremental saving and checkpointing
- Paywall detection (hard/soft/none)
