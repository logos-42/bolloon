---
title: API URL 完整切换链路 + 探测原语 (P4)
source: session (leo 2026-09-26 计划 P4 + 代码实测)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, url, probe, connection, failure-classification, primitive, acceptance, mutation]
---

# API URL 完整切换链路 + 探测原语 (P4)

> 承接 P0/P1 ([model-selection-protocol.md](./model-selection-protocol.md)) 与 P2
> ([model-selector-p2.md](./model-selector-p2.md))。
>
> **代码**: `src/llm/connection-probe.ts` (**新增, 独立原语**) —— 本轮**没有**改
> `src/llm/model-selection.ts`。本页只描述这个原语; 把它接进唯一切换入口是**主线**的动作。

## 1. 这一层修什么: 「隐藏 URL」与「一句话失败」

换供应商 / 换 API URL 此前只有两种反馈: 一句"切换成功", 或一句笼统的"连接失败"。于是
用户分不清到底是 URL 写错、key 不对、服务没起、模型名不存在、端点其实是**另一个协议**、
模型不支持工具调用, 还是网络干脆挂住了。更糟的是连不上时**静默退回默认 URL** ——
"我明明填了内网地址, 请求却打到了公网", 这就是隐藏 URL。

本层把整条链路做成**一个可判定、失败必分 7 类的原语**。

## 2. 原语签名

```ts
probe(req: ProbeRequest): Promise<ProbeResult>

interface ProbeRequest {
  providerId: string;
  baseUrl?: string;              // 显式 --base-url            (优先级 1)
  configuredBaseUrl?: string;    // 配置里的 provider baseUrl   (优先级 2)
  providerDefaultUrl?: string;   // provider 默认 URL          (优先级 3)
  envBaseUrlVar?: string;        // 环境变量覆盖: 变量名        (优先级 4, 最低)
  envBaseUrlValue?: string;      // 或直接给值 (测试/宿主注入)
  protocol: ModelProtocol;       // 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'
  model: string;
  apiKeyRef?: string;            // 凭证**引用名**: 'provider:<id>' / 'env:<VAR>' / 'none'
  resolveSecret?: (ref) => string | undefined | Promise<...>;  // provider:* 需宿主注入
  timeoutMs?: number;            // 默认 8000, 夹在 200~60000
  checkToolCalling?: boolean;    // 默认 true
  fetchImpl?: typeof fetch;      // 注入 fetch (测试)
}

interface ProbeResult {
  ok: boolean;
  failureClass?: ProbeFailureClass;   // ok=false 必有; ok=true 必无
  message: string;                    // 人话理由 (绝不含凭证值)
  baseUrl: string;                    // 规范化 + 合并重复 /v1 之后**真正会用的**
  baseUrlSource: BaseUrlSource | null;// 'explicit'|'configured'|'provider'|'env' | null
  protocol; model; providerId;
  authRef: string;                    // 引用名, 永不等于 key 值
  toolCalling: 'yes' | 'no' | 'unknown';
  checks: ProbeCheck[];               // 逐步事实 (step: url|protocol|credential|connect|model|tool_call)
  catalog?: string[];
  elapsedMs: number;
}
```

配套导出: `normalizeChainUrl` · `validateChainUrlShape` · `resolveChainBaseUrl` · `parseAuthRef` ·
`envelopeProtocolOf` · `classifyStatus` · `classifyNetworkError` · `fetchWithProbeTimeout` ·
`detectForeignProtocol` · `hasToolCallEvidence` · `formatProbeResult` · `resultLeaksSecret` ·
`PROBE_FAILURE_CLASSES` · `PROBE_FAILURE_ZH` · `BASE_URL_PRIORITY`。

## 3. 四层 URL 解析 (固定顺序) 与"给了但写错"

```
显式 --base-url > 配置里的 provider baseUrl > provider 默认 URL > 环境变量覆盖
```

- 环境变量排在**最后**是计划里定死的顺序 (环境变量只应补凭证/兜底, 不该压过用户明确选的东西)。
- **关键语义**: 某一层**真的给了值**就认它 (哪怕写错了) —— 只有"没给 / 纯空白"才轮到下一层。
  这样"填错 URL"永远不会被一个默认值悄悄盖掉。空白的 `--base-url` 视为"没给"。
- 四层全空 → `invalid_url`, `baseUrl=''`, `baseUrlSource=null` —— **不编一个默认出来**。
- 选中哪一层会逐字记进 `baseUrlSource`, 原始串记进 `checks[0].detail` (不想让人猜"规范化改了什么")。

### 3.1 规范化: 合并重复 `/v1`

```ts
normalizeChainUrl('https://api.example.com/v1/v1/')  // → 'https://api.example.com/v1'
normalizeChainUrl('http://127.0.0.1:8080//v1')       // → 'http://127.0.0.1:8080/v1'
normalizeChainUrl('https://x.example/gateway/v1')    // → 不动 (中间重复可能是真路径)
```

只处理**结尾**叠加: `…/v1/gateway/v1` 这种中间重复可能是服务端真实路径, 合并它就是改用户的地址。
`schema://host` 里的 `//` 不动。

与切换入口的 `normalizeBaseUrl()` **语义逐例一致** —— 有一条单测拿 11 个用例逐例比对两者
(含空白串与畸形串), 一旦分叉立刻判红。这是为了原语被接进入口时**不出现"两处真相"**。

## 4. 探测流程 (6 步) 与 7 类失败

```
URL 解析 → 规范化/合并 /v1 → 协议形状校验 → 解析凭证
        → 轻量连接探测(目录端点) → 模型接口可用(目录成员 + 真模型调用) → 工具调用能力
```

每一关用的端点与请求体 (按协议):

| 协议 | 目录/连通 | 模型调用 | 工具调用 |
| --- | --- | --- | --- |
| openai-compatible | `GET {base}/models` | `POST {base}/chat/completions` | 同上 + `tools[{type:'function',…}]` + `tool_choice:'auto'` |
| anthropic | `GET {base}/models` (`x-api-key` + `anthropic-version`) | `POST {base}/messages` | 同上 + `tools[{name,input_schema}]` |
| gemini | `GET {base}/models` (`x-goog-api-key`) | `POST {base}/models/{model}:generateContent` | 同上 + `tools[].functionDeclarations` |
| ollama | `GET {base}/api/tags` | `POST {base}/api/chat` (`stream:false`) | 同上 + `tools` |

### 4.1 七类失败各自怎么判

| 类别 | 判定依据 |
| --- | --- |
| `invalid_url` | ① 形状非法 (非 http/https / 解析不了 / 四层全空) ② 目录端点 404/405 且在**服务根**上交叉试不出任何协议端点 ③ 网络层 `ENOTFOUND`/`EAI_AGAIN` |
| `auth_failed` | ① 目录/模型/工具任一步 401 或 403 ② **本地**按 `apiKeyRef` 解析不出密钥 (未发任何请求; `provider:*` 需宿主注入 `resolveSecret`) |
| `provider_unreachable` | ① 网络层 `ECONNREFUSED`/`ECONNRESET`/`EHOSTUNREACH`/`UND_ERR_*` ② 429 ③ 5xx |
| `model_not_found` | 目录可解析且**不含**该模型名; 或模型调用端点回 404/405 且报文提到 model |
| `protocol_mismatch` | ① 服务根上交叉判定发现**另一个协议**的目录端点 (点名是哪个协议 + 证据 URL) ② 目录端点回 200 但信封是别的协议形状 ③ 回的压根不是 JSON (带 Content-Type) ④ 其余非工具相关 4xx |
| `tool_call_unsupported` | 工具调用那一步被 4xx 拒且报文提到 tool/function **而模型调用那一步是过的** (类别归属精确到"工具") |
| `timeout` | 超时标记置真 (真 `AbortController.abort()`), 不是靠错误文本猜 |

**类别与人话分开**: `PROBE_FAILURE_ZH` 只做"类别 → 人话"的翻译, 判据里不产生形容词。

### 4.2 「你其实是另一个协议」怎么真判出来

主目录端点回 404/405 (或回了个认不出的形状 / 非 JSON) 时, 到**服务根**上依次试
`/api/tags` · `/v1beta/models` · `/v1/models`, 用**目录信封**认出对方到底是哪种协议:

- 认出**别的**协议 → `protocol_mismatch`, 证据里点名 (`…/api/tags 回 200 且是 ollama 形状`)。
- 认出**同一个**协议 (只是路径不同) → 仍是 `invalid_url`, 但人话里带上线索
  ("同一协议在 …/v1/models 上有端点 — 检查 base URL 路径是否少了/多了")。
- 什么都认不出 → 按状态码给类别, **不硬说协议不符**。

## 5. 三条硬规则 (写在实现里)

1. **失败绝不静默退回旧/默认**。选中哪一层显式记录; 显式 URL 写错时类别是 `invalid_url` 且
   来源记 `explicit`, **不会**去试配置/默认那一层 (真跑里断言了"配置那台一次请求都没收到")。
2. **失败绝不当成功**。任何一步没过 ⇒ `ok === false` 且 `failureClass` 非空。
3. **凭证只进请求头**。只回引用名 (`authRef`); 响应片段只取报文的 `error.message`/`message`
   (不含请求头), 因此不会把 key 带出来。有 `resultLeaksSecret()` 供门自证。

## 6. 真跑证据 (可核)

```bash
npx tsc --noEmit                                  # 我的三个文件 0 错 (见 §9 保留②)
npx vitest run src/test/connection-probe.test.ts  # 34 passed / 0 failed  (1.9s)
npx tsx scripts/verify-url-chain.ts               # 50 passed / 0 failed
```

`scripts/verify-url-chain.ts` (真起本地 HTTP 服务器, 不是打桩) 七段:

| 段 | 判据 | 手段 |
| --- | --- | --- |
| S1 | 四层优先级 | 四台**各有不同模型清单**的真服务器, 断言"请求真的打到赢的那一台, 其余 0 命中" |
| S2 | 重复 `/v1` 合并 | 服务器**收到的请求路径**逐字是 `/v1/models`, 不含 `/v1/v1` |
| S3 | 七类失败 | 逐类真造 (含"收下请求但挂住不响应"的 timeout, 真 abort, 602ms) + 一条完整性断言 |
| S4 | 不静默退回 | 显式写错 → `invalid_url` + 来源 `explicit` + 配置那台 0 请求; 12 个失败样本 `baseUrl` 里无默认地址 |
| S5 | 凭证不回显 | 真 key 打真 401 → `auth_failed`, 结果/格式化输出里都没有 key 值 |
| S6 | 通过路径与工具三态 | 三关全过 `ok:true`; 有工具调用证据→`yes`; 只接受声明→`unknown`; `checkToolCalling:false` 时只发 2 个请求 |
| S7 | 源码级门 | 7 个类别逐字在源码里 · 类别恰好 7 个 · **源码无写死兜底地址** · 三个新增产物无外部平台表述 |

`src/test/connection-probe.test.ts` 另有纯函数半边: 信封识别 · 状态码分类 · 网络错误分类 ·
凭证引用拆解 · 与入口 `normalizeBaseUrl` 的 11 例一致性。

## 7. 变异验证 (改前先确认盘上 sha 真变了)

按**词界/整行**改坏 `connection-probe.ts`, 期望聚焦门 + 验收脚本**双双判红**, 改完即还原:

| # | 变异 | 聚焦门 | 验收脚本 |
| --- | --- | --- | --- |
| M1 | 工具被拒时的类别 `tool_call_unsupported` → `protocol_mismatch` | 3 红 | 48/2 红 |
| M2 | 四层优先级反了 (环境变量提到最前) | 4 红 | 39/**11** 红 |
| M3 | 超时被吞成 `provider_unreachable` | 3 红 | 48/2 红 |
| M4 | `PROBE_FAILURE_CLASSES` 摘掉 `model_not_found` (只剩 6 类) | 2 红 | 47/2 红 |

还原后 `sha = 9a05802fd7e4ff53` 与基线一致, 聚焦门与验收脚本重新全绿。

## 8. 与唯一切换入口的边界 (接进动作在主线)

- `probe()` **不写任何东西** —— 不写配置、不重建运行时、不碰会话绑定。它是"能给结论的探测",
  不是"切换"。写盘仍**只有** `model-selection.selectModel()` 一条路。
- 本文件**不 import** `model-selection.ts` 的任何运行时符号 (只用 `import type` 拿 `ModelProtocol`,
  编译期擦除), 也不碰配置存储 ⇒ 加载它零副作用。
- 因此 `provider:<id>` 形态的凭证引用**取不到值** (密钥在配置存储里) —— 这是刻意的: 原语不读盘,
  由宿主注入 `resolveSecret`。取不到时报 `auth_failed` 并在 `checks` 里说清是"本地取不到"。
- 接进 `selectModel` 时需要一处转换: 入口的 `ProbeResult`(内部) 与本文的 `ProbeResult`(导出)
  同名不同形, 收口时由主线统一 (本轮不动入口, 避免动到别人的判据)。

## 9. 如实留下 (没做到 / 有保留)

1. **未接线**。本轮只交付原语 + 门 + 验收; `selectModel` 的探测**仍是**它自己那份
   `probeSelection`。因此 P8 的 15 条**没有**因为本轮而发生变化, §8 的转换动作没做。
2. **`tsc --noEmit` 全仓当前是红的, 但不是本轮的**。唯一一条错误在并行线的
   `src/llm/custom-provider-store.ts(86,63)` (该文件不在 HEAD 里, 属其他阶段的在建产物)。
   本轮的三个文件 0 错 (写这个原语后的第一次 `tsc` 退出码 0; 现在那次全仓跑里也没有一条落在
   `connection-probe.ts` / `connection-probe.test.ts` / `verify-url-chain.ts`)。
3. **`scripts/verify-model-selector.ts` 当前是红的, 但不是本轮的**。它以
   `ReferenceError: Cannot access 'metadataSources' before initialization` 崩在
   `model-catalog.ts:185 ← provider-registry.ts:846 ← provider-registry.ts:849 (模块顶层调用)` ——
   并行线新加的 `provider-registry.ts` 在模块顶层注册填充点, 而 `config-store.ts` (同批在建)
   又 import 它, 与 `model-catalog.ts` 形成环 → TDZ。证据: ①本轮三个文件全部物理挪走后再跑,
   同一个崩溃逐字复现; ②直接 `import` **未改动**的 `model-catalog.js` 也照样崩。
   `verify-model-selection.ts` 仍是 **55/0**, 冻结门仍是 **34/34** (它们不 import model-catalog)。
4. **本机造不出真的主机名解析失败**。本机 DNS 把不存在的名字也解析到 sinkhole (任意 `.invalid`
   都回同一个保留网段地址), 真跑只会得到 `UND_ERR_SOCKET` → 归 `provider_unreachable`。
   所以 `invalid_url` 的 `ENOTFOUND` 那一格用**真形状的错误对象**覆盖分类器 (单测里注明),
   真服务器那条路造出的是"端点不存在 (404)"。这是分类覆盖, **不是**真 DNS 失败。
5. **`toolCalling` 的 `unknown` 不等于不支持**。端点接受了工具声明但本次没触发工具调用时记
   `unknown` (不许编成 `yes`, 也不许当 `no`)。要把它判死, 需要**强制**工具调用
   (`tool_choice` 指定函数名), 但那会误伤不接受对象形 `tool_choice` 的服务端 —— 本轮没做,
   留给"拒绝不支持工具调用的模型用于 Agent 执行"那一条 (P7/P8) 去定策略。
6. **`UND_ERR_SOCKET` 归 `provider_unreachable`**。被 sinkhole 劫持的主机名会表现为"连上又被
   关掉", 本原语按"连不上供应商"如实报, 不硬猜成 `invalid_url`。
7. **重复 `/v1` 只合并结尾叠加** (`/v1/v1` → `/v1`)。中间重复 (`/v1/gateway/v1`) 不动 ——
   与入口 `normalizeBaseUrl` 保持一致, 宁可少合并也不改用户地址。
8. **本轮的 wiki 只回写这一页 + `index.md` 的一行登记**。`index.md` 不在并行名册的文件归属里,
   但 `python scripts/wiki_check.py` 会判"新页面没有被 index.md 引用" ⇒ 不做这一步就等于
   **自己把仓里的 wiki 门弄红**。权衡后只加了一行 (与 P2 那一轮 `index.md | 1 +` 的做法一致),
   没有动 `log.md` / `current-status.md` —— 那两页仍由主线在收口时统一登记。
