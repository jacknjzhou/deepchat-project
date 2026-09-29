---
name: web-scraper
description: "使用 DeepChat 内置浏览器工具（YoBrowser）与本地已配置的模型抓取网页并提取内容。支持 JS 渲染页面、新闻文章识别、正文清洗、元数据与实体提取（人物/机构/地点/事件）、批量增量抓取。当用户需要抓取网页内容、提取文章正文、采集结构化数据或批量整理网页信息时使用此 Skill。"
description_zh: "使用内置浏览器工具与本地模型抓取网页、提取正文与实体，零外部服务依赖。"
version: 2.0.0
---

# 网页抓取与内容提取（内置浏览器 + 本地模型）

## 简介

本 Skill 基于 DeepChat 内置浏览器工具（YoBrowser）与**当前会话已配置的模型**完成网页抓取与内容理解，无需任何外部 API Key 或第三方抓取/LLM 服务：

- 网页获取：内置 `load_url` + `cdp_send`（会话浏览器，支持 JS 渲染页面）
- 正文清洗、元数据与实体提取：由当前会话模型直接完成（不调用任何外部 LLM 服务）
- 静态页回退：`exec` + curl

## 前置条件

1. 无需任何 API Key。
2. 网页获取使用内置浏览器工具（yobrowser 服务）：`get_browser_status` / `load_url` / `cdp_send`。
3. 如需"搜索发现 URL"，用户可在 MCP 设置中自行配置搜索服务；未配置时请让用户提供具体 URL 列表，不要臆造 URL。

## 核心工具

### 内置浏览器（yobrowser）

| 工具 | 用途 |
|---|---|
| `get_browser_status` | 查询会话浏览器状态；首次使用或出现异常时先调用它 |
| `load_url` | 导航到 URL 并等待 DOM 就绪（默认 30 秒超时）。**只返回页面状态（url/title 等），不返回正文** |
| `cdp_send` | 向当前页面发送白名单 CDP 命令，用于提取内容 |

`cdp_send` 参数为 `{ method, params? }`，常用组合：

| 目的 | method 与 params |
|---|---|
| 提取页面正文文本 | `Runtime.evaluate`，`{"expression": "document.body.innerText", "returnByValue": true}` |
| 提取文章区域正文（更干净） | `Runtime.evaluate`，`{"expression": "document.querySelector('article')?.innerText \|\| document.body.innerText", "returnByValue": true}` |
| 查找元数据（og:type、ld+json、meta 标签） | `Runtime.evaluate`，`{"expression": "document.querySelector('head')?.outerHTML", "returnByValue": true}` |
| 触发懒加载后重取 | 先 `Runtime.evaluate` 执行 `window.scrollTo(0, document.body.scrollHeight)`，稍候重新提取 |
| 刷新页面（SPA 未渲染完时） | `Page.reload`，再重新提取 |

白名单方法还包括 `DOM.getDocument` / `DOM.querySelector` / `DOM.querySelectorAll` / `DOM.getOuterHTML` / `Page.captureScreenshot` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`。返回文本过长时分段提取（如按 `article`、`main` 等容器缩小范围），不要整页原始 HTML 粘进上下文。

### 静态页回退（exec + curl）

浏览器不可用或只需静态 HTML 时：

```bash
curl -sL --max-time 30 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" "<url>"
```

原始 HTML 体积大，仅用于再加工（如配合 grep 定位数据片段），不要整页输出到对话。

## 操作流程

### 1. 明确目标

开始前确认：要抓取哪些 URL 或站点；提取什么内容（正文 / 元数据 / 实体 / 特定字段）；单页还是批量；输出格式（对话内 / JSON 文件 / Markdown）。

### 2. 获取页面

1. `load_url` 导航到目标 URL
2. `cdp_send`（`Runtime.evaluate` + `document.body.innerText`）提取正文
3. 文本过短或为空 → 页面可能未渲染完：`Page.reload` 后重新提取，或先滚动触发懒加载；仍不足 → 检查是否需要登录或被反爬拦截
4. 浏览器异常（`yobrowser_unavailable`）→ 先 `get_browser_status` 再重新 `load_url`；仍失败改用 curl 回退（仅静态页）

### 3. 新闻/文章识别（启发式）

用提取到的 URL 与页面内容判断，无需脚本：

- URL 模式：含 `/YYYY/MM/`、`/news/`、`/article/`、`/blog/`，或结尾是数字 ID
- 页面含 `og:type=article` 或 Schema.org 的 NewsArticle/Article/BlogPosting（在 head 的 `application/ld+json` 中）
- 有作者署名、发布日期、多个长段落

非新闻页按普通页面处理，跳过新闻专属元数据。

### 4. 清洗与元数据提取（模型完成）

- 去掉导航、广告、推荐位等样板内容，保留正文；统一空白与编码
- 提取：标题、作者、发布时间、更新时间、站点名、栏目、标签
- 判断付费墙：hard（正文不可见）/ soft（内容在 DOM 中但被隐藏）/ none——**只提取公开可见内容**
- 元数据缺失时如实标注 null，不要编造

### 5. 实体提取（模型完成）

对**干净正文**（不是原始 HTML）由当前会话模型直接抽取，不要生成调用外部 API 的脚本：

- 人物（姓名 / 角色 / 上下文）
- 机构（公司 / 政府 / NGO / 其他）
- 地点（城市 / 省州 / 国家 / 地址）
- 事件与日期
- 实体间关系（主体—关系—客体）

长文分段抽取后按名称去重（大小写不敏感）。

### 6. 批量处理

1. 逐个 URL 处理：`load_url` → `cdp_send` 提取 → 模型清洗/抽取 → `write` 保存
2. 同一域名请求之间保持节奏（必要时用 `exec` 执行 `timeout` / `sleep` 间隔 ≥ 0.5 秒），失败时降速而不是重试风暴
3. **增量保存**：每处理若干条就 `write` 一次结果文件；开始前先读已有结果文件，跳过已处理的 URL（断点续传）
4. 失败 URL 单独记入 failed 列表，不静默丢弃

## 输出要求

- 默认直接在对话中输出；用户要求保存时用 `write` 生成 JSON 或 Markdown
- 结构化结果每条包含来源与质量信息：

```json
{
  "url": "...",
  "method": "browser | curl",
  "paywall": "none | soft | hard",
  "data_quality": "high | medium | low",
  "title": "...",
  "author": "...",
  "date_published": "...",
  "word_count": 0,
  "text": "清洗后的正文",
  "entities": { "people": [], "organizations": [], "locations": [], "events": [], "relationships": [] },
  "crawled_at": "ISO 8601 时间"
}
```

- `data_quality`：正文充分且元数据齐全 → high；部分缺失 → medium；几乎没有有效内容 → low

## 安全规则

- 未经用户明确批准，不抓取需要登录/认证的页面；批准后可请用户在会话浏览器预览中手动登录，再继续提取
- 遵守 robots.txt；同一域名请求间隔至少 0.5 秒
- 不绕过硬付费墙：只提取已公开返回给客户端的内容
- 本 Skill 不使用任何 API Key，不要在生成的文件或脚本中写入任何密钥

## 能力边界

- `load_url` 只返回页面状态，正文必须用 `cdp_send` 提取
- `cdp_send` 仅支持白名单 CDP 方法，不支持任意 CDP 命令
- 搜索类 MCP 工具（如已配置）只返回"标题+URL+摘要"，不抓全文
- 本 Skill 面向适度规模的抓取（单页到几十页的串行处理）；大规模并发爬取超出目标，请如实告知用户
- 强反爬站点（验证码、指纹检测）可能无法获取内容，如实报告失败原因，不要编造内容

## 故障排除

| 现象 | 处理 |
|---|---|
| `load_url` 返回 yobrowser_unavailable | 先 `get_browser_status` 再重新 `load_url`；仍失败改用 exec + curl 抓静态页 |
| 提取文本过短/为空 | SPA 未渲染完：`Page.reload` 或滚动懒加载后重取；检查是否需登录 |
| curl 返回 403/429 | 站点反爬：改用内置浏览器工具；或降低频率稍后重试 |
| 中文乱码 | 放弃 curl，改用内置浏览器提取（浏览器天然处理编码） |
| 页面无限加载/超时 | 确认 URL 有效；告知用户该站点可能屏蔽自动化访问 |
| 元数据/实体为空 | 如实输出空值并说明原因，不要编造 |
