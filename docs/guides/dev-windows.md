# Windows 开发环境搭建

本文补充 `docs/guides/getting-started.md`，专注 Windows 平台下 Electron + 原生模块构建相关的差异与坑。
跨平台的命令与心智模型请先读 `getting-started.md` 与 `docs/ARCHITECTURE.md`。

## 版本基线

与仓库 `package.json` 的 `engines` 与 `packageManager` 字段对齐：

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | `>=24.18.0 <25` | 强制 24.x；不要装 Node 22 LTS 或 20 |
| pnpm | `>=10.34.5 <11` | 仅 pnpm；`preinstall` 会在 npm/yarn 误触发时 fail-fast |
| Python | 3.11 或 3.12 | 供 `node-gyp` 编译原生模块 |
| Git for Windows | 最新 | 自带 Bash；PowerShell 也可 |
| Visual Studio | 2022 Community | 工作负载：*使用 C++ 的桌面开发*；组件勾选 *Windows 10/11 SDK* 与 *MSVC v143 生成工具* |

> Microsoft 已不再单独发布 Build Tools，独立包路径对 DeepChat 的原生依赖不再可靠；优先用 VS 2022 Community。

## 推荐：使用 `mise` 锁版本

仓库根目录已有 `mise.toml`，可直接 `mise trust && mise install` 激活：

```powershell
irm https://mise.run | iex
cd deepchat
mise trust
mise install
mise use node@24.18.0 pnpm@10.34.5
node -v   # v24.18.0
pnpm -v   # 10.34.5
```

不使用 `mise` 时，用 `corepack`：

```powershell
corepack enable
corepack prepare pnpm@10.34.5 --activate
```

## 一次性系统配置

1. **开启开发者模式**：设置 → 隐私和安全 → 开发者选项 → 开。
   `pnpm install` 创建符号链接/硬链接需要它，否则会 `EPERM: operation not permitted, symlink`。
   仅开账户无管理员权限时这是唯一可行路径。
2. **PATH 中可执行 Python**：安装时勾选 *Add Python to PATH*，或在 PowerShell 中：

   ```powershell
   py -3.12 -m pip install --upgrade pip setuptools
   npm config set python "C:\Python312\python.exe"
   ```

3. **关闭 Hyper-V/WSL 与 npm 代理冲突**（如有 `ENETUNREACH` / `EAI_AGAIN` 走 0.0.0.0）：
   electron-vite 把 dev server 绑在 `0.0.0.0:5713`，上游代理会拦截 localhost 时需要保持该默认值。

## 克隆与安装

```powershell
git clone https://github.com/ThinkInAIXYZ/deepchat.git
cd deepchat
pnpm install
pnpm run hooks:install    # 安装 commitlint/pre-commit 等 .githooks
pnpm run installRuntime   # 拉取 uv 与 MCP 运行时，首次较慢
```

`postinstall` 会执行 `electron-builder install-app-deps`，自动按当前 Node ABI 重新编译 `electron`、`sharp`、
`better-sqlite3-multiple-ciphers` 等原生依赖。Windows 上这条最容易因工具链缺失而失败，见下。

## 启动开发模式

```powershell
pnpm run dev          # electron-vite dev --watch，最常用
pnpm run dev:inspect  # 主进程开启 9229 端口，便于 VSCode attach
pnpm run dev:trace    # 关闭 Vue DevTools overlay，方便抓 Trace 日志
```

修改 `src/main/**` 或 `src/preload/**` 会触发主进程重启；修改 `src/renderer/**` 由 Vite HMR 热更新。

## 常用脚本速查

| 任务 | 命令 |
| --- | --- |
| 类型检查 | `pnpm run typecheck`（node + web 双目标） |
| Lint | `pnpm run lint` |
| 格式化 | `pnpm run format` |
| 主进程单测 | `pnpm run test:main` |
| 渲染层单测 | `pnpm run test:renderer` |
| E2E 冒烟 | `pnpm run e2e:smoke` |
| 当前架构打包 | `pnpm run build:win` |
| 显式 x64 | `pnpm run build:win:x64` |
| 显式 arm64 | `pnpm run build:win:arm64` |

## 常见失败与对策

| 症状 | 根因 | 解决 |
| --- | --- | --- |
| `EPERM: operation not permitted, symlink …` | 未开开发者模式 / 无管理员权限 | 开启开发者模式，或在管理员 PowerShell 中运行 |
| `gyp ERR! find VS … MSB3428` 或 `MSVC v143 not found` | VS Build Tools 缺失组件 | 打开 Visual Studio Installer → 修改 → 勾上 *MSVC v143* 与 *Windows 10/11 SDK* |
| `No module named 'distutils'` | Python 3.12 移除了 distutils | `pip install setuptools` |
| `node-gyp` 卡在 `python` 检查 | `npm config get python` 指错 | `npm config set python "C:\Python312\python.exe"` |
| `better-sqlite3-multiple-ciphers` 重装后仍然 ABI 不匹配 | electron 的 Node ABI 与系统 Node 不同 | `pnpm rebuild better-sqlite3-multiple-ciphers --target=$(node -p \"require('electron/package.json').version\")` |
| `sharp` 安装失败 | platform 不在 `optionalDependencies` 列表内 | `pnpm run install:sharp` |
| `pnpm install` 走 npm | 误装或 alias 残留 | `where pnpm` 确认是 Corepack/Cellar 版；删除 `%APPDATA%\npm` 下别名 |
| `electron-builder` Windows 签名报错 | 未配置证书 | 本地调试忽略；正式发版需要 `CSC_LINK` / `CSC_KEY_PASSWORD`，见 `docs/release-flow.md` |
| 路径含空格 / 中文 | `electron-builder` 偶发 | 项目目录保持英文无空格 |
| `better-sqlite3-multiple-ciphers` 重装很慢 | 编译耗时 | 配好工具链后只编译一次；之后用 `pnpm rebuild` 局部重编 |

## 构建产物路径

- `out/main/`、`out/preload/`、`out/renderer/`：electron-vite 输出
- `dist/` 或 `release/`：electron-builder 输出（Windows 为 `DeepChat Setup x.y.z.exe` 与 portable 版）
- `runtime/`：由 `pnpm run installRuntime` 拉取的 MCP / uv / 运行时种子

## Windows 维护者发布

仓库的 `pnpm run release:ff` 在 Windows 上不可用（详见 `CONTRIBUTING.md` 与
`docs/release-flow.md`）。Windows 维护者按 `docs/release-flow.md` 中的 *Manual fallback* 走 PR 审阅
与人工 fast-forward，并在 `release/<version>` 合入 `main` 后手工打 `v<version>` tag。
