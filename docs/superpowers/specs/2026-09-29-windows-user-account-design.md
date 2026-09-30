# Windows 登录用户账户信息获取设计（Windows User Account Info）

- 日期：2026-09-29
- 状态：待用户评审
- 范围：`device.getInfo` 契约扩展，主进程采集当前登录 Windows 用户的基本账户标识并透传给 renderer

## 1. 背景与目标

需求：DeepChat 在 Windows 上安装并运行后，能够获取**当前登录的 Windows 用户**的账户信息。

### 可行性结论

**可行。** 主进程（Electron main）以当前登录的交互用户身份运行，进程 token 即登录用户 token：

- 基本标识（用户名/域名/主机名/主目录）可通过 Node 内置 API 与环境变量零成本获取，无需管理员权限、无需新增依赖
- SID 需要一次系统命令（`whoami /user` 或 PowerShell `WindowsIdentity`）；项目已有 `child_process.execAsync` 先例（`DeviceService.getDiskSpace()` 调用 `wmic`）

### 目标

1. `device.getInfo` 返回值扩展可选字段 `winAccount`，包含 username / domain / hostname / homeDir / sid
2. 仅 Windows 生效；macOS / Linux 返回 `null`，不阻塞原有信息
3. SID 获取失败时降级为 `null`，不影响 `getInfo` 整体成功

### 非目标（本版不做）

- 不做显示全名（FullName）、微软账户邮箱/UPN、用户头像
- 不做提权场景校正（右键管理员以其他账户运行时，采到的是提权账户，属已知边界）
- 不做遥测上报、不做隐私设置开关（仅本地读取与透传）
- 不改变现有安装器（NSIS）行为；安装器提权上下文中的用户信息不可靠，本设计只在应用运行期采集

## 2. 决策记录

| 决策点 | 结论 |
| --- | --- |
| 信息范围 | 基本标识：username / domain / hostname / homeDir / sid（用户确认） |
| 落地方案 | 方案 A：扩展现有 `device.getInfo` 契约，不新增独立 route |
| SID 获取 | `child_process.execAsync` 调用 `whoami /user` 解析，主进程内幂等缓存 |
| 失败策略 | SID 失败降级 `null`；其余字段为同步 API，理论上不失败 |
| 跨平台 | 非 win32 平台 `winAccount` 固定为 `null` |
| 信息展示 | 关于页只读"系统信息"卡片（用户确认，见 §6） |
| 新增依赖 | 无 |

## 3. 字段可行性

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| username | `os.userInfo().username`（进程 token）或 `process.env.USERNAME` | 微软账户登录时为本地配置文件名（通常是邮箱前 5 位），不是邮箱 |
| domain | `process.env.USERDOMAIN` | 本地账户即机器名，域账户即 NETBIOS 域名 |
| hostname | `os.hostname()` | — |
| homeDir | `os.homedir()`（同 `USERPROFILE`） | — |
| sid | `whoami /user` 解析 | Node 无原生 API；Windows 上 `os.userInfo()` 的 uid/gid 无意义，不可用 |

已核实先例：`src/main/mcp/processEnvironment.ts` 已在使用 `USERNAME`/`USERPROFILE` 环境变量。

## 4. 契约设计

### 4.1 类型（`src/shared/types/device.ts`）

```ts
export type WindowsAccountInfo = {
  username: string
  domain: string
  hostname: string
  homeDir: string
  sid: string | null
}

export type DeviceInfo = {
  // ...现有字段不变
  winAccount: WindowsAccountInfo | null
}
```

### 4.2 Zod schema（`src/shared/contracts/domainSchemas.ts`）

`DeviceInfoSchema` 追加：

```ts
winAccount: z
  .object({
    username: z.string(),
    domain: z.string(),
    hostname: z.string(),
    homeDir: z.string(),
    sid: z.string().nullable()
  })
  .nullable()
```

`device.getInfo` route 契约（`device.routes.ts`）结构不变，output 内的 `DeviceInfoSchema` 自动携带新字段。

### 4.3 渲染端

`DeviceClient` 透传，无需改动；展示消费方见 §6（关于页系统信息卡片）。

## 5. 实现设计（`src/main/device/index.ts`）

`getDeviceInfo()` 内：

1. 非 win32：`winAccount: null`
2. win32：
   - `username = os.userInfo().username`、`homeDir = os.homedir()`、`hostname = os.hostname()`（同步，不失败）
   - `domain = process.env.USERDOMAIN ?? ''`
   - `sid`：调用私有方法 `getWindowsSid()`（见下），失败返回 `null`

### SID 获取

- 命令：`whoami /user`（系统自带，无 UAC 弹窗），解析输出行中的 `S-1-5-...`
- 正则：`/S-1-\d+(?:-\d+)+/` 取首个匹配
- 幂等缓存：模块级 `let cachedSid: string | null | undefined`（`undefined` 表示未取过），进程生命周期内仅执行一次
- 超时：`exec` 传 `{ timeout: 5000 }`，超时/非零退出/解析失败一律 `null` 并记 debug 日志
- 不使用 PowerShell：启动开销大且策略受限环境下可能被禁

## 6. 信息展示（设置 → 关于页）

用户确认：账户信息在**关于页**以只读"系统信息"卡片展示（`AboutUsSettings.vue`）。

### 呈现规则

- 仅 Windows 显示（`winAccount === null` 时整卡隐藏，macOS/Linux 无感知）
- 位置：版本号与更新渠道区块之后、更新说明卡片之前
- 复用该页现有卡片视觉（`rounded-xl border border-border/80 bg-card/70 p-4 shadow-sm`），键值对左键右值，等宽字体渲染值
- 数据来源：`onMounted` 调用 `deviceClient.getDeviceInfo()` 取 `winAccount`；SID 不做掩码（本地只读展示），但提供复制按钮方便报障贴单

### 布局（BEFORE/AFTER，仅 Windows）

```
BEFORE                              AFTER
┌────────────────────────┐          ┌────────────────────────┐
│        [logo]          │          │        [logo]          │
│      DeepChat          │          │      DeepChat          │
│       v1.x.x           │          │       v1.x.x           │
│  更新渠道: [stable ▾]   │          │  更新渠道: [stable ▾]   │
└────────────────────────┘          ├────────────────────────┤
                                    │ 系统信息                │
                                    │ 用户名    zhangsan  ⧉  │
                                    │ 域名      DESKTOP-ABC⧉ │
                                    │ 主机名    DESKTOP-ABC⧉ │
                                    │ 主目录    C:\Users\zs⧉ │
                                    │ SID       S-1-5-21-… ⧉ │
                                    └────────────────────────┘
```

### 改动点

1. `src/renderer/settings/components/AboutUsSettings.vue`：新增 `winAccount` 加载逻辑与系统信息卡片（含逐行复制按钮，用现有 clipboard 工具/VueUse `useClipboard`）
2. i18n：新增 `about.systemInfo.title` / `about.systemInfo.username` / `domain` / `hostname` / `homeDir` / `sid` 六键，同步全部 20 个 locale 文件
3. 测试：扩展 `test/renderer/components/AboutUsSettings.test.ts`——mock `deviceClient.getDeviceInfo()` 返回含 `winAccount` 的数据断言卡片渲染与字段值；`winAccount: null` 断言卡片不渲染

## 7. 错误处理与边界

| 场景 | 行为 |
| --- | --- |
| 非 Windows 平台 | `winAccount: null` |
| `whoami` 失败/超时/输出无法解析 | `sid: null`，其余字段正常返回 |
| 提权运行且账户不同 | 采到提权账户信息（已知边界，不做校正） |
| 域环境/本地账户 | `USERDOMAIN` 均有值，无需分支 |

## 8. 测试与验证

- 扩展现有 `test/main/device/deviceService.test.ts`：
  - 非 win32 返回 `winAccount: null`（mock `process.platform`）
  - win32：mock `os.userInfo`/`os.homedir`/`os.hostname`/`USERDOMAIN` + mock `child_process.exec` 返回含 SID 的 `whoami` 输出 → 字段断言；exec 抛错 → `sid: null` 且不 reject
  - SID 幂等缓存：两次调用仅触发一次 exec
- 组件测试：`test/renderer/components/AboutUsSettings.test.ts` 扩展（见 §6 改动点 3）
- 回归：`test/main/routes/dispatcher.test.ts`（引用了 `device.getInfo`）通过
- 既有检查：`pnpm typecheck`、`pnpm i18n`、`oxfmt`、相关 vitest 套件

## 9. 隐私考量

SID 属可关联个人标识。当前仅本地读取与本地展示，不外发；若未来接入遥测，需在隐私设置与隐私政策中声明。主进程日志不打印 SID 全文。

## 10. 实施清单

1. `src/shared/types/device.ts`：新增 `WindowsAccountInfo`，`DeviceInfo` 追加 `winAccount`
2. `src/shared/contracts/domainSchemas.ts`：`DeviceInfoSchema` 追加 `winAccount`
3. `src/main/device/index.ts`：`getDeviceInfo()` 填充 `winAccount`；新增 `getWindowsSid()`（exec + 缓存 + 降级）
4. `src/renderer/settings/components/AboutUsSettings.vue`：系统信息卡片（加载、渲染、复制按钮）
5. i18n：`about.systemInfo.*` 六键同步 20 个 locale 文件
6. `test/main/device/deviceService.test.ts`：扩展 DeviceService 单测
7. `test/renderer/components/AboutUsSettings.test.ts`：扩展组件单测
8. 运行验证：typecheck、i18n、oxfmt、device/renderer 相关 vitest、dispatcher 回归