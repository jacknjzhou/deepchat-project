# Changelog

## 2.0.0

- 去除 AI Hive OpenAPI 依赖：不再需要 API Key、`init` 初始化、任务轮询与图片上传
- 移除 `scripts/imagegen.py` 与 `references/config.example.json`
- 改为调用 DeepChat 内置 `image_generate` agent 工具，使用 Agent 设置中配置的图像生成模型
- 参数对齐 `image_generate`：`prompt` / `size` / `quality` / `outputFormat` / `background` / `moderation`
- 明确能力边界：不支持参考图输入（图生图）

## 1.1.0

- 搜索覆盖：GPT Image 2、GPT-Image-2、GPTImage2、OpenAI Image 2、ChatGPT Images、Image2、文生图、图生图、图片编辑、电商图、广告图、详情页、带货、种草
- 独立模型与能力入口，不与其他 Skill 合并
- 保持 Seedance 2.5 参考包的目录与文档风格
- 实时读取模型配置、路由和价格快照

## 1.0.0

- 基于 AI Hive SDK 裸接口模板派生
- 固定 Skill 名称：`gpt-image-2`
- 固定底层图片模型映射
- 自动上传媒体、轮询任务和下载结果
