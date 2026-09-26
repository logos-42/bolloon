---
title: 模型发现与缓存 (P5)
source: session (leo 2026-09-26 计划 P5 + 代码实测 + 本机真跑验收)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, discovery, cache, provider, fallback, credential-fingerprint, acceptance, mutation]
---

# 模型发现与缓存 (P5)

> 承接 P3 ([provider-registry.md](./provider-registry.md), 供应商注册表 + 兼容协议) 与
> P4 ([model-url-chain.md](./model-url-chain.md), 探测原语 + 失败七类)。
> P3 说了"目录端点在<b>哪</b>、怎么认证", P4 说了"探不通算什么失败"; 本轮 (P5) 是**第一次真的去问**
> 并**把结果缓存下来** —— 于是断网也有清单可用, 而"这家有哪些模型"不再靠猜。

**代码**: `src/llm/model-discovery.ts` (发现 + 缓存 + 回退链 + 填充点) ·
`src/test/model-discovery.test.ts` (27 条单测, 全用真本地 HTTP 服务器) ·
`scripts/verify-model-discovery.ts` (真跑验收 81 条 + 4 条变异)。
本层**没有改** P3/P4 任何文件 (只 import): 端点/认证头走 `provider-registry.authHeadersFor` /
`modelsEndpointOf`, URL 四层优先级走 `connection-probe.resolveChainBaseUrl`, 失败分类走
`classifyStatus` / `classifyNetworkError` / `fetchWithProbeTimeout`。

## 1. 发现: 已认证时优先取 `/models`

```
provider 已认证 (配置里的 key / 环境变量 / 这家本来不需要 key)
  → GET <baseUrl>/models        (openai-compatible · gemini 形状均为 /models)
  → GET <baseUrl>/api/tags      (ollama)
  → 自定义供应商声明的 modelsEndpoint (相对路径拼在它的 baseUrl 后)
没认证 / 没有可用端点 (例如 anthropic, P3 已实测它没有可用的 GET /v1/models)
  → **不发请求**, 如实记下"为什么没问" (凭据缺失 / 发现方式=manual)
```

- base URL 由 `getProviderRegistryEntry` + 配置 + 环境变量解析, **不另拼一份**;
- 请求头由注册表产出 (`bearer` / `x-api-key` / `x-goog-api-key` + `?key=` / 本地免凭据);
- 响应形状三种都认: `{data:[{id}]}` · `{models:[{name}]}` (gemini 会去掉 `models/` 前缀) ·
  `{models:[{name}]}` / `{tags:[...]}` (ollama)。

## 2. 缓存: 按 **provider + baseUrl + 凭证身份** 分桶

| 项 | 值 |
| --- | --- |
| 位置 | `~/.bolloon/model-discovery-cache.json` (mode **0600**; 目录跟随 `BOLLOON_HOME`, **调用时**解析) |
| 键 | `cacheKey = sha256(provider \u0000 baseUrl \u0000 credentialIdentity)` (前 24 位 hex) |
| 凭证身份 | `anonymous` (没凭据) 或 `fp:<sha256 前 16 位>` —— **只有指纹, 没有明文** |
| 有效期 | 默认 **30 分钟** (`DEFAULT_DISCOVERY_TTL_MS`); 新鲜期内直接命中, **一个网络请求都不打** |
| 覆盖时机 | **只有"真取到 ≥1 个模型"才写** (401/500/超时/空清单/垃圾形状都不写) |

- **两个不同的 key 不共用一份缓存**: 同名 provider、同 baseUrl, 只有凭证身份不同 → 两条独立记录,
  断网时各自回退到**自己那份** (门: 变异 M2 把凭证身份从键里拿掉 → 判红)。
- 指纹只是"分桶器", 不是凭据 —— 换 key 就换桶, 同 key 稳定命中。
- 为什么缓存不塞进 `bolloon-config.json`: 那是有跨进程写锁的**配置**文件; 把运行时缓存塞进去会让
  "配置变了"和"缓存变了"混成一件事。缓存坏掉/版本不认识 → 当空表 + 警告, **不影响**发现本身。

## 3. 回退链与五种标记

```
网络不可用 → 上一次成功缓存 (cached)   >  用户声明/手输的模型 (custom)  >  内置目录 (curated)
回退链全空 → unavailable (名单留着, 清单为空, 原因照写)
```

| 标记 | 含义 | 落在哪 |
| --- | --- | --- |
| `live` | **本轮**真取到目录 (2xx 且解析出 ≥1 个模型) | `origin` + `discoveryState` |
| `cached` | 用缓存 (新鲜期内命中, 或网络不可用时的上次成功缓存) | `origin` + `discoveryState` |
| `curated` | 清单来自**内置目录** (没端点 / 没凭据 / 从未成功) | `origin` + `discoveryState` |
| `custom` | 来自**用户声明或手工输入**的模型 ID | 逐条在 `modelOrigins` |
| `unavailable` | **本轮发现失败**; 回退链上什么都没有时 `origin` 也是它 | `discoveryState` (+ `origin`) |

**为什么要两个字段** —— 一个事实两种问法: "这份清单从哪来" (`origin`) vs "这一家现在能不能发现"
(`discoveryState`)。只要本轮尝试失败, `discoveryState` 就是 `unavailable` 并带 `failure`
(`failureClass` + 人话理由) —— 哪怕清单是从缓存来的, 界面也必须看见"这次没问通"。

- **有真目录时不再混入内置目录**: 内置清单只有 ID, 混进去会让列表里出现"这台端点上根本不存在的
  模型"; 内置目录只在**没有真目录**时兜底 (`curated`)。手输/声明的模型则**总是**并入 (用户说的, 可撤)。
- 清单合并优先级: `live` > `cached` > `custom` > `curated` (逐条记在 `modelOrigins`)。

## 4. "空目录" ≠ 失败 (也不许把失败当空目录)

| 实况 | 分类 (P4 的七类里选) | 缓存 |
| --- | --- | --- |
| HTTP 401/403 | `auth_failed` | **不写** |
| HTTP 5xx / 429 | `provider_unreachable` | **不写** |
| 无响应 (超时) | `timeout` | **不写** |
| 200 但**0 个模型** | `model_not_found` (理由写明"不当作空目录") | **不写** (不覆盖上次成功缓存) |
| 200 但形状不是目录 | `protocol_mismatch` | **不写** |

**发现失败不许静默删 provider**: 全册列表长度恒等于注册表长度 (`listModelCatalog()` 里失败的家
照样在, 带 `keptDespiteFailure` + 原因 + "没有被删除"的备注), 失败原因进 `listing.unavailable` 索引。

## 5. 自定义模型允许手动输入

```
admitManualModel(providerId, modelId)   → 落进**该桶**的 manualModels, 标记 custom
forgetManualModel(providerId, modelId)  → 撤掉一条
```

- 手输的模型在**断网、端点没目录、凭证被拒**时依然在清单里 (它不经网络);
- 非法 ID 一律拒绝并给理由 (空 / 带空白 / 控制字符 / 超 200 字)。

## 6. 命令面能力 (做成可调用函数 —— **命令面接线不归本层**)

| 命令 | 调用 | 返回 |
| --- | --- | --- |
| `/model refresh` | `refreshModelDiscovery(providerIds?, opts?)` | `DiscoveryRefreshReport { counts, failures, results, cachePath }` (强制真取) |
| `/model refresh --clear` | `clearDiscoveryCache(providerId?)` | 清掉的条数 |
| `/model list` | `listModelCatalog(undefined, opts?)` | `CatalogListing { entries, unavailable, notes }` (一家都不删) |
| `/model list <provider>` | `listModelCatalog(providerId, opts?)` | 同上, 只看一家 |
| 手输自定义模型 | `admitManualModel` / `forgetManualModel` | `{ok, catalog}` / `boolean` |
| 展示 | `formatCatalogLine(catalog)` · `formatListingSummary(listing)` · `catalogOriginZh(o)` | 行文本 (**不含凭据**, 只打指纹) |
| 单家状态 | `resolveDiscoveryTarget(providerId, opts?)` · `discoverProviderModels(providerId, opts?)` | `DiscoveryTarget` (含凭据, 只许用于当次请求) / `DiscoveredCatalog` |

**需接线 (P6 统一入口那条线做)**: 上面这些是**能力**, 命令面 (`src/cli/setup-wizard.ts` /
`src/cli-entry.ts` / `src/web/routes-llm-config.ts`) 尚未调它们 —— 本层不碰命令面文件。

## 7. 元数据填充点 (P2 冻结接口的第二个填充者)

`registerModelMetadataSource({ id: 'live-discovery' })` (调用时自动接线, 幂等):

- `origin`: 只在这个模型**真在**本层清单里、且来源**不是** `curated` 时填 (curated 是 P2 自己的默认
  口径, 本层不认领);
- `toolCalling` / `reasoning` / `contextLength` / `displayName`: **只填响应体里字面写着的**
  (`context_length`/`contextLength`/`context_window`/`inputTokenLimit`/`max_input_tokens`,
  `capabilities.tool_calling` 之类的**字面 `true`/`false`**); 字符串 "yes"、`"128k"` 一律**不当结论**;
- 纯同步: 只读进程内快照 (`currentDiscoveryCatalog`), 不在填充点里发请求/读盘;
- 于是 `/model list` 里真目录给了什么就显示什么, 没给的一律**未知** (不编)。

## 8. 凭据纪律

- `apiKey` 只存在于 `DiscoveryTarget.apiKey` (当次请求构造用), **不进** `DiscoveredCatalog`、
  不进缓存文件、不进打印行/报告;
- 缓存里存的端点 URL **不带认证 query** (gemini 那类 `?key=` 的协议最容易从 URL 漏出去 —— 有门);
- 失败理由/备注会带上游响应片段 → 一律过 `redactSecretIn()` (上游回显收到的那把 key 时,
  输出里是 `[REDACTED]`);
- 展示层只打**指纹** (`fp:xxxx`) 或"未配置凭据 / 免 key"。

## 9. 真跑与门禁 (本轮实测)

- `npx tsx scripts/verify-model-discovery.ts` → **81 passed / 0 failed**;
  五种标记 (live/cached/curated/custom/unavailable) **全部在真跑里出现过** (V9);
- 真跑用的假服务: 正常 `/models` · 401 (把收到的凭据回显出来, 用来验脱敏) · 500 · **挂起** (超时) ·
  200 空清单 · 200 垃圾形状 · gemini 形状 (key 在 `?key=`);
- 单测 `src/test/model-discovery.test.ts` → **27/27**;
- **变异 4/4 判红** (先证明落盘 hash 变了, 再跑聚焦测试): M1 发现失败静默删 provider ·
  M2 缓存键丢掉凭证身份 (两个 key 共用) · M3 把 401 当空目录 · M4 缓存里存明文凭证;
- `tsc --noEmit` **0 错**; 飞轮冻结门 `goal-flywheel-wiring-freeze.test.ts` **34/34**;
  P0 门 55/0 · P2 门 51/0 · P3 门 44/0 · P4 门 50/0 不变红;
- 跨进程: 真子进程 (`npx tsx -e`) 读同一份缓存, 指纹/清单/路径均一致。

## 10. 没做到 / 有保留 (如实)

1. **命令面没接线** —— `/model refresh` / `/model list [<provider>]` 目前只是**可调用函数**,
   没挂到 CLI/Web 命令上 (命令面文件属 P0/P6 那条线, 本层按分工没碰)。
2. `live` 只认 **≥1 个模型**: 端点回 200 + 空清单被当成失败 (`model_not_found`)。若某家端点上真的
   一个模型都没有 (例如还没拉过模型的本地 ollama), 本层不会把它缓存成"空目录", 而是走回退链并标
   `unavailable` —— 这是**刻意的** (用一次空回包把目录钉空比报错更糟), 但代价是"真的空"与"回包坏了"
   在缓存层看不出区别。
3. 能力字段只填响应体字面写着的: 现在能填的多是自建网关/新协议才有 (`context_length`、
   `capabilities.tool_calling`); 主流厂商的 `/models` 只回 ID ⇒ 工具调用/reasoning/上下文仍是**未知**,
   与 P2 的口径一致 (没有真数据不编)。
4. `discoveryState` 与 `origin` 两个字段是同一事实的两种问法 —— 界面要**两个都看**才不会把
   "有缓存但这次没问通"显示成一切正常; 命令面接线时要记得。
5. 缓存是**进程共享但无锁**的 (临时文件 + rename): 两个进程同时发现同一家会各写一次 (后写赢),
   内容等价所以不影响正确性; 真正的"同时改配置"锁在配置层 (P0), 缓存层刻意不引锁。
6. 未在真公网端点上跑过 (本轮全部是本地真 HTTP 服务器 + 真子进程); 真实厂商的 `/models` 形状差异
   (分页、`object: "list"` 之外的信封) 只在 gemini/ollama/openai 三种形状上验证过。
