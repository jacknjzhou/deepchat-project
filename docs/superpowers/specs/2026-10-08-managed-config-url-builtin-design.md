# 构建期注入托管配置地址并在关于页展示 — 设计

日期：2026-10-08
状态：已确认（用户批准）

## 背景与目标

`DEEPCHAT_MANAGED_CONFIG_URL` 目前只能通过运行时环境变量配置（主进程 [composition.ts:520](file:///d:/sync-workspace/traework/tools-market-project/deepchat-project/src/main/app/composition.ts#L520) 读取，无 dotenv、无应用内设置项）。企业批量部署时逐机设置环境变量成本高。

目标：

1. 构建安装包时可注入一个**默认**托管配置地址，打进包内
2. 客户端「设置 → 关于」页展示生效的服务地址（未配置时也显示区块）

## 数据流与优先级

```
构建期（CI / 本地打包）
  MAIN_VITE_MANAGED_CONFIG_URL=https://.../managed/config pnpm run build:win
  → electron-vite 将主进程 bundle 中的 import.meta.env.MAIN_VITE_MANAGED_CONFIG_URL 替换为字面量

运行期解析（单一函数）
  ① process.env.DEEPCHAT_MANAGED_CONFIG_URL      运行时环境变量（最高优先）
  ② import.meta.env.MAIN_VITE_MANAGED_CONFIG_URL  构建注入默认
  ③ 都无 → ''（未配置）

关于页展示
  有值 → 地址（可复制）+ 来源标签（「环境变量」/「内置配置」）
  无值 → 区块仍显示，内容「未配置企业托管」
```

- 空串 / 纯空格视为未设置（trim 后判定）
- 现有 dev 用法（终端 `$env:DEEPCHAT_MANAGED_CONFIG_URL=...`）不受影响，并保留为企业 IT 应急覆盖手段

## 代码改动点

| 位置 | 改动 |
| --- | --- |
| `src/main/app/composition.ts`（现 520 行附近） | 读取函数改为 ①②③ 解析，产出 `{ endpoint, source: 'env' \| 'builtin' \| 'none' }`；实现形态（返回对象 vs 两个函数）实施时定 |
| device 路由（`getAppVersion` 所在文件） | 暴露 `managedEndpoint` + `managedEndpointSource` 给渲染端（扩展既有返回或新增轻量方法，实施时按该路由文件惯例定） |
| `src/renderer/settings/components/AboutUsSettings.vue` | 版本信息区附近新增「企业托管配置」区块：地址（可复制）+ 来源标签；数据经 deviceClient 获取 |
| `src/renderer/src/i18n/*/about.json`（20 locale） | 新增键：区块标题、来源标签 ×2、未配置文案（zh-CN 中文，其余 en-US 同文，仓库惯例） |
| `.env.example` 与构建文档 | 记录 `MAIN_VITE_MANAGED_CONFIG_URL` 用法与 CI 传参示例 |
| `electron.vite.config.ts` | 预期无需改动（electron-vite 内建 `MAIN_VITE_*` 支持）；若实测主进程不生效，则在 main 段显式 `define` 兜底 |

## 边界与错误处理

- 构建未注入 + 无环境变量 → 关于页显示「未配置企业托管」；功能行为与现状一致（`skipped`，不发起请求）
- 地址非法（如缺协议头）→ 现有同步行为不变（`new URL()` 抛错 → `unavailable` → 静默保留缓存）；关于页**如实显示**该地址，不做展示层校验（所见即所得，便于排障）
- 不做运行时可编辑（保持「企业下发」语义）；不做服务端覆盖层

## 测试

- 主进程：解析优先级单测（env > builtin > none；空串 / 纯空格视为未设置）
- 渲染端：AboutUsSettings 三态渲染（env 来源 / builtin 来源 / 未配置）
- 构建链路（手动验收）：`MAIN_VITE_MANAGED_CONFIG_URL=... pnpm run build:win` 产出的安装包，关于页显示地址且来源为「内置配置」

## 非目标

- 运行时修改托管地址的 UI
- 服务端下发托管地址（覆盖层）
- extraResources JSON 资源方案（已评估，YAGNI）
