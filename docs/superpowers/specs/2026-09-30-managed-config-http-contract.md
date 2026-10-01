# 企业托管配置 HTTP 契约（v1）

> 本文档从**已实现的客户端代码**提取，描述 DeepChat 客户端期望的服务端接口行为，供服务端实现参考。
> 来源：`src/main/managed/client.ts`、`src/main/managed/types.ts`、`src/main/managed/index.ts`、`src/main/managed/applyAgentModels.ts`。

## 1. 端点配置

| 项 | 值 |
| --- | --- |
| 来源 | 环境变量 `DEEPCHAT_MANAGED_CONFIG_URL`（**仅此一处**，无设置项回退） |
| 未配置 | 客户端整体跳过（`skipped`），不发起任何请求，全部功能按普通用户行为运行 |
| 方法 | `GET` |
| 超时 | 默认 8000 ms，超时即 abort（视为 `unavailable`） |
| 触发时机 | ① 应用启动（provider 初始化之后、documents 迁移之前，**不阻塞启动**）② 用户手动刷新（设置页） |

## 2. 请求

### 2.1 Query 参数

均由客户端自动附加，全部来自 Windows 登录身份。

| 参数 | 含义 | 示例 |
| --- | --- | --- |
| `username` | 登录用户名 | `zhouruijie` |
| `domain` | 域 / 机器名 | `SRIBD` |
| `hostname` | 主机名 | `PC-02-2023-0032` |
| `sid` | 用户 / 机器 SID | `S-1-5-21-...` |

### 2.2 请求头

| 头 | 值 |
| --- | --- |
| `Accept` | `application/json` |
| `X-DeepChat-Client` | 客户端版本号（取不到时为 `unknown`） |
| `X-DeepChat-Device-Id` | 同 `sid` |

### 2.3 示例

```
GET /managed/config?username=zhouruijie&domain=SRIBD&hostname=PC-02-2023-0032&sid=S-1-5-21-... HTTP/1.1
Accept: application/json
X-DeepChat-Client: 1.0.1
X-DeepChat-Device-Id: S-1-5-21-...
```

## 3. 状态码语义（注意副作用）

| 状态码 | 客户端判定 | 客户端行为 |
| --- | --- | --- |
| `200` | `applied` | 解析并**写入**托管配置；缓存到本地；重新拉取各托管 provider 的模型列表；按匹配预填 Agent 默认值 |
| `204` / `404` | `absent` | **破坏性**：删除此前写入的所有托管 provider、清除运行期托管的 Agent 默认值、清空托管态 |
| `401` / `403` | `denied` | 同上（破坏性清除） |
| 其它非 2xx（含 `5xx`） | `unavailable` | **保留缓存并重新应用一次**；托管态不变 |
| 2xx 但 JSON 非法 / 顶层 schema 校验失败 | `unavailable` | 同上 |
| 网络错误 / 超时 / 连接被拒 | `unavailable` | 同上 |

> **服务端务必注意**：`404` 会**删除客户端上已有的托管配置**。仅在「该用户确实无托管配置」时返回 `404` / `204`。用户的身份查询或后端暂时不可用时，请返回 `5xx`（客户端按 `unavailable` 保留缓存，离线可用），否则会造成客户端配置被误清。

## 4. `200` 响应体

### 4.1 顶层

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | 正整数（int） | 是 | 契约版本，当前用 `1` |
| `defaultProviderKey` | 非空字符串 | 否 | `agentModels` 匹配时的**优先级锚点**（指向 `providers[].key`）；缺省或未命中则按 `providers[]` 顺序取第一个 |
| `providers` | 数组 | 是（可为空数组） | **逐项校验**：坏条目单独丢弃并记 warning，不会导致整包失败 |
| `agentModels` | 对象或 null | 否 | 内置 Agent 四项模型默认值，**只下发模型 id** |
| `documents` | 对象或 null | 否 | 智能信息提取（单据识别）模型与参数，**锁定项** |

### 4.2 `providers[]` 每项

| 字段 | 类型 | 必填 | 约束 / 客户端行为 |
| --- | --- | --- | --- |
| `key` | 字符串 | 是 | 必须匹配 `^[A-Za-z0-9._-]+$`；本地 id = `managed-` + key（非法字符替换为 `-`） |
| `name` | 字符串 | 是 | 非空，显示名 |
| `apiType` | 字符串 | 是 | 必须是客户端内置注册表已支持的供应商类型（本项目新 API 网关为 `new-api`）；**不认识的类型会被整条跳过** |
| `baseUrl` | 字符串 | 是 | 非空。`new-api` 约定**不带 `/v1`**（例：`https://gw.example.com`） |
| `apiKey` | 字符串 | 是 | 非空，写入本地凭据 |
| `enabled` | 布尔 | 否 | 缺省 `true` |
| `instanceLabel` | 字符串 | 否 | 多实例显示名，缺省取 `name` |

客户端会把该 provider 写成**独立实例**（id = `managed-<key>`，`baseProviderId` = 该 `apiType` 对应的内置 provider id），不与内置条目或用户自建 provider 冲突；后续对该 provider 的增删改在 UI 与 IPC 层被**锁定**。

### 4.3 `agentModels`

```json
"agentModels": {
  "chat": "deepseek-v3",
  "assistant": "gpt-4o-mini",
  "vision": "gpt-4o",
  "imageGeneration": "gpt-image-2"
}
```

| 键 | 对应 Agent 字段 |
| --- | --- |
| `chat` | 默认对话模型 |
| `assistant` | 助手模型 |
| `vision` | 视觉模型 |
| `imageGeneration` | 图像生成模型 |

**只接受模型 id 字符串**（4 个键均可选，全为空则该段视为未下发）。客户端不再下发 provider，归属规则：

1. 启动 / 刷新时先重新拉取各托管 provider 的**实时模型列表**（网关 `/models`）
2. 用 id 去匹配：优先级 = `defaultProviderKey` 对应 provider，其次按 `providers[]` 顺序；命中即选中该 provider 的该模型
3. **匹配不到 → 跳过该键并记 warning**，保留用户当前值（绝不错配）

**写入语义（默认值跟随、用户优先）**：

- 首次下发某键（本地无记录）→ **直接写入，覆盖用户已有值**
- 之后：若用户**未改动**（当前值仍等于上次我们写入的值）→ 跟随新的托管值
- 若用户在我们写入之后**改动过** → 保留用户值，不再覆盖

> **服务端约束**：`agentModels` 里的 id 必须真实存在于对应网关的模型列表中，否则不生效（客户端会跳过并打日志）。推荐让 `defaultProviderKey` 指向的网关能提供全部四项。

### 4.4 `documents`（锁定项）

```json
"documents": {
  "textModel":   { "providerKey": "corp-gw", "modelId": "deepseek-v3", "endpointType": "openai" },
  "visionModel": { "providerKey": "corp-gw", "modelId": "gpt-4o",     "endpointType": "anthropic" },
  "concurrency": 4,
  "temperature": 0.2,
  "maxTokens": 4096
}
```

| 字段 | 类型 | 约束 / 客户端行为 |
| --- | --- | --- |
| `textModel` | 模型 ref | 文本抽取模型 |
| `visionModel` | 模型 ref | 视觉模型 |
| `concurrency` | 数字 | 收敛到 **1–10** 的整数（越界取边界、四舍五入）；非有限数视为未下发 |
| `temperature` | 数字 | 有限数才生效，否则视为未下发 |
| `maxTokens` | 数字 | 必须是**正整数**才生效，否则视为未下发 |

**模型 ref**：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `providerKey` | 是 | 必须匹配 `^[A-Za-z0-9._-]+$`，且**必须存在于本次 `providers[]` 中**；否则该 ref 被丢弃 |
| `modelId` | 是 | 非空字符串 |
| `endpointType` | 否 | 仅聚合网关（`new-api`）需要，可选值：`openai` \| `openai-response` \| `anthropic` \| `gemini` \| `image-generation` \| `video-generation`；**非法值被丢弃但 ref 保留**（回落为客户端按模型列表推断） |

> **`textModel` 与 `visionModel` 必须同时有效**。只下发其中一个 → **整个 `documents` 段被忽略**（视为未锁定，记 warning）。
> 原因：运行时对缺失字段会回退用户值，若仍整页锁定，用户将无法配置缺失的那个模型（配置死锁）。

**`documents` 生效后的客户端行为**：

- 「设置 → Agent设置 → 智能信息提取模型」页**整页只读**（模型、并发、推理参数均不可改，无保存按钮），页面展示托管生效值
- 运行时**托管优先**：即使绕过 UI 也以托管值为准（逐字段覆盖用户设置；托管未下发的字段回落用户值）

## 5. 完整示例

**请求**

```
GET https://gw.example.com/managed/config?username=zhouruijie&domain=SRIBD&hostname=PC-02-2023-0032&sid=S-1-5-21-...
```

**响应 `200`**

```json
{
  "version": 1,
  "defaultProviderKey": "corp-gw",
  "providers": [
    {
      "key": "corp-gw",
      "name": "企业网关",
      "apiType": "new-api",
      "baseUrl": "https://gw.example.com",
      "apiKey": "sk-xxxxxxxxxxxxxxxx",
      "enabled": true,
      "instanceLabel": "企业网关"
    }
  ],
  "agentModels": {
    "chat": "deepseek-v3",
    "assistant": "gpt-4o-mini",
    "vision": "gpt-4o",
    "imageGeneration": "gpt-image-2"
  },
  "documents": {
    "textModel": { "providerKey": "corp-gw", "modelId": "deepseek-v3", "endpointType": "openai" },
    "visionModel": { "providerKey": "corp-gw", "modelId": "gpt-4o", "endpointType": "anthropic" },
    "concurrency": 4,
    "temperature": 0.2,
    "maxTokens": 4096
  }
}
```

## 6. 服务端实现清单（按优先级）

1. **必须**：按 `username`（必要时结合 `domain` / `hostname` / `sid`）定位用户，返回其被分配的 provider（可多个）+ 模型默认值 + 智能信息提取配置
2. **必须**：`apiType` 用客户端支持的供应商类型字符串（新 API 网关 = `new-api`）；`baseUrl` 不带 `/v1`
3. **必须**：`documents` 若要锁定，`textModel` 与 `visionModel` 都要给，且 `providerKey` 必须在 `providers[]` 里
4. **必须**：确保网关 `GET {baseUrl}/v1/models` 能返回 `agentModels` / `documents` 引用的全部 model id
5. **强烈建议**：身份查询失败或后端异常返回 `5xx` 而非 `404`（`404` 会清掉客户端已有配置）
6. **建议**：`endpointType` 显式声明（尤其 Claude / Gemini 家族），否则依赖客户端推断
7. **可选**：`defaultProviderKey` 指定多个 provider 时的匹配优先级

## 7. 客户端落盘与生效细节

- 托管态存于本地设置键：`managed.config`、`managed.providerIds`、`managed.meta`、`managed.agentModelApplied`
- `absent` / `denied` 时：删除 `managed-` 前缀的 provider（**带前缀守卫**，防误删用户自建）+ 清除「我们写入且用户未改过」的 Agent 值
- `unavailable` 时：读缓存并**重新应用一次**（防本地被改动 / 清空），离线完全可用
- 托管 provider 的模型在刷新后**默认全部开启**（避免「页面锁定 + 模型未开启」死局）
- 已实测：`endpointType: "anthropic"` 会真实走 `POST {baseUrl}/v1/messages`
