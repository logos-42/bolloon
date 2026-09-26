---
title: 供应商注册表 + 兼容协议 + 自定义 endpoint (P3)
source: session (leo 2026-09-26 计划 P3 + 代码实测 + 本机真跑验收)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, provider, registry, protocol, custom-endpoint, migration, backward-compat, acceptance, mutation]
---

# 供应商注册表 + 兼容协议 + 自定义 endpoint (P3)

> 承接 P0/P1 ([model-selection-protocol.md](./model-selection-protocol.md)) 与 P2 ([model-selector-p2.md](./model-selector-p2.md))。
> P2 把「模型元数据」做成**冻结接口 + 缺失显示"未知"**; 本轮 (P3) 把「供应商」从**静态数组**升级为
> **注册表 + 兼容协议**两层, 并把 P2 冻结的元数据填充点真正接上 —— 填的都是**有真值**的项。

**代码**: `src/llm/provider-registry.ts` (注册表 + 兼容协议 + 填充点) ·
`src/llm/custom-provider-store.ts` (自定义供应商持久化/迁移/脱敏) ·
`src/llm/config-store.ts` (只加了一格 `customProviders` + 迁移 + activeProvider 规则, 见 §6)。

## 1. 两层结构

```
① 注册表 (registry)   —— 每家供应商一条**逐项有出处**的记录; 自定义与内置**同一形状**
② 兼容协议 (protocol) —— openai-compatible | anthropic | gemini | ollama
                          自定义供应商只声明协议, 不上改 TS 联合类型
```

- **不再往静态数组里堆名字**: 加一家内置供应商仍然是改 `DEFAULT_PROVIDER_CONFIGS` + `PROVIDER_INFO`
  (那是兼容层), 而**任意第三方兼容服务**走自定义供应商路径, 一个 TS 联合类型都不用动。
- **单一入口不变**: 写盘仍然只有 `model-selection.selectModel`; 本轮新增的写口只有
  `config-store.setCustomProviders` (只动 `customProviders` 一格) —— 它不碰 `providers`/`activeProvider`。

## 2. 注册表九项能力字段 (每项都有真出处)

`ProviderRegistryEntry` 提供计划要求的九项, 外加 `requiresApiKey` / `baseUrlEnvVars` / `longRunningReason` / `provenance`:

| 字段 | 谁是真来源 |
| --- | --- |
| `defaultBaseUrl` 默认 URL | `config-store.DEFAULT_PROVIDER_CONFIGS.baseUrl` (**调用时**读, 不复制一份) |
| `defaultModel` 默认模型 | 同上 `.model` |
| `apiKeyEnvVars` API key 环境变量 | `model-selection.envKeyNamesOf` |
| `discovery` 模型发现方式 (+`modelsEndpoint`) | `config-store.buildTestRequest` 的端点表; **anthropic 例外**: 本仓实测没有可用的 `GET /v1/models` → `manual` (端点为空串, 不编) |
| `auth` 认证方式 | `config-store.buildHeaders` + 客户端各协议分支: bearer / `x-api-key` / `x-goog-api-key`+`?key=` / 本地免凭据 |
| `toolCalling` 是否支持工具调用 | **本文件的新事实**: 客户端路由表里真发得出原生 `tools` 的分支 (见 §3) |
| `reasoning` 是否支持 reasoning | `model-selection.supportsReasoning` (不在集合里 → `unknown`, **不写 `no`**) |
| `isLocal` 是否本地 | `model-catalog.isLocalBaseUrl` (base URL 主机名真判定) |
| `allowsLongRunningExecutor` 是否允许当长期任务执行器 | 本文件判定: `toolCalling === 'yes'` (见 §5) |
| `requiresApiKey` 这家要不要 key | `config-store.PROVIDER_INFO` (P2 已冻结: 注册表是主来源) |
| `baseUrlEnvVars` 覆盖 base URL 的环境变量 | 客户端取 base URL 的那张表 (`OPENAI_BASE_URL`/`OLLAMA_BASE_URL` 等) |

`provenance` 是逐字段出处字典 —— 门禁要求**九项逐项有值且逐项有出处**, 不是"看起来填了"。

**优先保障清单** (`PRIORITY_BUILTIN_IDS`, 只影响展示顺序): OpenAI · Anthropic · Gemini · DeepSeek ·
MiniMax · Kimi · Qwen · GLM · OpenRouter · Ollama · xAI (`grok`); 另有在册的 `mimo` (小米) 与 `local`。
在册内置 = 既有内置表那 **13 家, 一个不多一个不少** (门禁比 `Object.keys(DEFAULT_PROVIDER_CONFIGS)`)。

## 3. 工具调用能力是"**运行时口径**", 不是给厂商 API 背书

`toolCalling` 的定义写死在代码里: **"这家现在能不能用于工具调用"** = 原生 `tools` 真的发得出去吗。
出处是客户端 `generateText()` 的路由表 (只有指向 `callOpenAI(..., openaiTools)` 的分支收得到工具数组):

```
yes : openai · minimax · deepseek · kimi · glm · qwen · mimo · grok
no  : anthropic · gemini · openrouter · ollama · local   ← 这条协议分支不接收原生 tools
```

**一个实测发现 (值得单开一条修)**: OpenRouter 走的是它自己的 `callOpenRouter` 分支, 那个分支的签名里
**没有** tools 参数 —— 也就是说经本运行时走 OpenRouter 的工具调用**发不出去**。这不是"OpenRouter 不支持工具",
而是**运行时的分支没接**。这条现在被如实登记为 `toolCalling='no'` + `toolCallingEvidence`, 不再被静默忽略。

门禁是**源码级双向相等**: 去 parse `pi-ai.ts` 路由表里收得到 `openaiTools` 的 `case` 集合, 与注册表说 `yes`
的集合逐项相等 (锚点找不到直接判红, 不许当绿)。客户端改了分支而注册表没跟上 → 立刻红。

## 4. 自定义供应商 (通用兼容协议, 不改联合类型)

### 4.1 落盘形状 (`bolloon-config.json` 的 `customProviders` 一格, 与内置同一份配置)

```jsonc
{
  "activeProvider": "deepseek",
  "providers": { /* 内置 13 家照旧 */ },
  "customProviders": {
    "my-gw": {
      "providerId": "my-gw",
      "displayName": "自建网关",
      "baseUrl": "http://127.0.0.1:8080/v1",     // 必需
      "protocol": "openai-compatible",           // 必需: openai-compatible|anthropic|gemini|ollama
      "apiKey": "…",                             // 可省; 与内置同等待遇 (文件 0600, 永不打印)
      "model": "my-model-1",                     // 可省
      "modelsEndpoint": "/models",               // 可省: 相对→拼 baseUrl, 绝对→原样
      "authHeader": "Authorization",             // 可省: 覆盖协议默认 (默认 Authorization 会带 Bearer)
      "apiKeyEnvVar": "MY_GW_KEY",               // 可省
      "models": ["my-model-1", "my-model-2"],    // 可省: 声明式目录
      "capabilities": { "toolCalling": "yes", "reasoning": "yes", "contextLength": 65536 }
    }
  }
}
```

- `capabilities` **不声明就是 `unknown`** —— 本层不补默认值; `unknown` 也不当"可用" (见 §5)。
- 与内置**撞名直接拒绝** (优先保障清单不许被自定义覆盖), 缺 `baseUrl` / 非法 `providerId` 也拒绝, 理由是人话。
- 每次 add/update/remove 都**重新读盘再写**, 只覆盖 `customProviders` 一格 → 不覆盖别的进程刚改的模型选择。

### 4.2 兼容协议 = 运行期映射

```ts
runtimeProviderIdOf(entry)   // 内置 → 自己; 自定义 openai-compatible → 'openai', anthropic/gemini/ollama → 同名分支
authHeadersFor(entry, key)   // → { headers, query } (含凭据, 只许用于当次请求构造)
modelsEndpointOf(entry)      // → 目录端点 (manual 时为空串)
```

于是"自定义供应商能不能真出网"不再靠承诺: 验收里起真 HTTP 服务器扮演 openai 兼容服务, 用
`initMinimax({ provider: runtimeProviderIdOf(entry), baseUrl: entry.defaultBaseUrl, model: entry.defaultModel })`
发一次真请求, 服务器**记下了** `POST /v1/chat/completions` + 请求体里的 `model` + `Authorization` 头 —— 全部对上。

## 5. 长期任务执行器门

```ts
canServeLongRunningTasks(id) → boolean        // 后台 Run/Goal 需要真工具调用
longRunningRefusalReason(id) → string | null  // 拒绝时必须给理由 (点名"工具调用", 不许只回"不支持")
```

- 内置: 允许 ⇔ `toolCalling === 'yes'` (anthropic/gemini/openrouter/ollama/local 一律**不允许**, 理由写清证据)。
- 自定义: 允许 ⇔ **声明** `capabilities.toolCalling === 'yes'` **且**协议是 `openai-compatible`
  (只有这条分支发得出原生 tools)。声明了 `yes` 但协议对不上 → 照样拒绝。
- 这给 P8 #15「不支持 tool calling 的模型被拒绝用于 Agent 执行」提供了**判定依据**;
  实际"拒绝执行"的接线在 P6/P7 的入口层 (本轮不做, 见 §8)。

## 6. 向后兼容: 旧配置原样可用 (P8 #13 在 P3 这一层)

旧配置有 **三种真实形态**, 全在"读"的时候收成规范形, 且**读的时候不写盘**:

| 形态 | 处置 |
| --- | --- |
| 一个字都没写 `customProviders` (绝大多数旧配置) | 空表, 内置 13 家照旧 |
| `customProviders` 是**早期数组形** | 按 `providerId` 收成 map; 坏条目**留名 + 留理由** |
| 只有 `providers.<未知 id>` (旧版本把自定义端点直接写进 providers) | **吸收**成自定义供应商; 协议按 base URL 主机名推 (`localhost:11434` → ollama 等), 并标 `inferredProtocol` |

**顺带修掉一个真 bug**: 旧 `initialize()` 只认内置表, `activeProvider` 指向自定义端点时会被**静默改成
`ollama`** —— 用户的自定义默认模型直接失效。现在内置 / 已注册自定义 / 配置里真有这一格且写了地址或模型
三种都算数, 三者都不是才退 `ollama`。

读不出形状的那一格**不静默当空表** (记 rejected); 有读不出来的条目时**写操作直接拒绝**并说明
"写回会把这几种写法丢掉, 先修好再改" —— 宁可不动, 不偷偷抹掉用户写的东西。

## 7. 元数据填充点: 只填自己有真值的项 (+ 一条 import 顺序的教训)

`registerModelMetadataSource` 只注册**一个** source (`id='provider-registry'`), 它**只**回答:

- `requiresApiKey`: 注册表维度的事实 (每家都答);
- `origin: 'custom'` + `toolCalling`/`reasoning`/`contextLength`: **只有自定义供应商、且只在
  `capabilities` 里显式声明过**才答;
- **内置供应商的模型级能力一个都不填** —— 内置注册表只有**供应商级**能力, 模型级能力只有真目录 (P5) 能给。
  拿供应商级数据装成模型级就是 P2 明令禁止的"编一个看起来像真的值"。

**接线点不在模块体**: 本模块与 `config-store`/`model-catalog` 是循环 import, 模块体的执行时机取决于
"谁是入口" —— 实测 `model-catalog` 先被别的入口拉起来时, 模块体里注册会撞上对方 `metadataSources` 的
**TDZ**, 整个进程起不来 (`verify-model-selector.ts` 真的崩过)。改成 **调用时接线**: 任何一次配置读
(`llmConfigStore.initialize()`) 或自定义供应商读都会顺手接上 (幂等, 只做一次), 不依赖 import 顺序。
副作用是好事: 测试里显式 `resetModelMetadataSources()` 之后**不会**被偷偷加回来。

## 8. 验收、门禁与变异 (真跑数字)

| 产物 | 结果 |
| --- | --- |
| `scripts/verify-provider-registry.ts` (真跑: 本地假模型服务 + 真 `fetch` + 真 `getMinimax().chat()` + 真子进程) | **44 passed / 0 failed** |
| `src/test/provider-registry.test.ts` + `provider-registry-migration.test.ts` (聚焦单测) | **39 passed / 0 failed** |
| `scripts/verify-provider-registry-mutations.py` (8 条变异) | **8/8 判红** (先确认盘上 sha256 变了) |
| 未削弱既有门 | 飞轮冻结门 **34/34** · `verify-model-selection.ts` **55/0** · `verify-model-selector.ts` **51/0** |
| `npx tsc --noEmit` | **0 错** |

变异清单 (改坏 → 聚焦测试判红): M1 谎称 gemini 发得出工具调用 · M2 自定义只看声明不看协议 · M3 把供应商级
能力当模型级填下去 · M4 `activeProvider` 又只认内置表 · M5 协议推断不再看 11434 · M6 key 明文进展示行 ·
M7 自定义 `authHeader` 被忽略 · M8 不再拒绝与内置撞名。

## 9. 没做到 / 有保留 (逐条)

1. **自定义供应商还没进选择器列表**: `model-catalog.buildProviderSummaries` 仍在 `DEFAULT_PROVIDER_CONFIGS`
   上遍历 (那是 P2 的文件, 本轮不动), 所以 `/model` 的第 1 步暂时看不到自定义供应商。注册表把清单
   (`listProviderRegistry()` / `customProviderEntries()`) 交给 P4/P6, 接线不是本轮的活。
2. **`authHeader` 只在注册表的请求构造路径生效**: 聊天客户端 `pi-ai.ts` 各分支写死了自己的鉴权头
   (anthropic 的 `x-api-key`、openai 的 `Authorization`)。自定义 `authHeader` 要真的进聊天请求, 得等 P4
   的链路改造 (该文件不在本轮名册内)。验收里对**非默认**头只做到"注册表产出的头被真服务器收到"。
3. **`toolCalling='no'` 是运行时口径**: 它不是"厂商 API 不支持工具"的断言。若后续给 OpenRouter/Anthropic
   补上原生 tools 分支, 这张表必须跟着改 (门禁会逼着改 —— 这正是设计意图)。
4. **模型级能力仍然大面积 `unknown`**: 内置 13 家的模型级 `toolCalling`/`reasoning`/`contextLength` 只有
   真目录 (P5) 能给, 本轮不编。列表脚注文案 (`CURATED_ONLY_REASON`) 属 P2 文件, 未同步改写。
5. **`longRunningRefusalReason` 只提供判定, 不提供拦截**: P8 #15 的"拒绝执行"要在入口层接 (P6/P7)。
6. 认证 `authHeader` 的 `Authorization` 前缀规则写死为 `Bearer`; 需要 `Token`/裸值前缀的自定义头暂不支持。
