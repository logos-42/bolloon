---
title: 前缀 KV 命中链: stable system + 只追加 history + CURRENT TURN 只在尾部
source: session (leo 2026-09-28 反馈「缓存复用方面, 目前文件还存在问题, 缓存无法命中」+ 参考实现 hufeide/bolloon 的 src/llm/pi-ai.ts 机制逐条 + 离线门 verify-kv-prefix)
created: 2026-09-28
last_confirmed: 2026-09-28
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [llm, kv-cache, prefix-cache, pi-ai, pi-sdk, system-prompt, cache-prompt, llamacpp, prompt-profile, acceptance, mutation]
---

# 前缀 KV 命中链: stable system + 只追加 history + CURRENT TURN 只在尾部

**口径 (leo 2026-09-28 原话)**: 「在缓存复用方面, 目前文件还存在问题, **缓存无法命中**」。
参考实现是朋友那份 `hufeide/bolloon` 的 `src/llm/pi-ai.ts` (只取这一个文件看机制, 不 clone 仓) ——
**机制照搬, 代码不整文件替换** (他们那份 `sanitizeToolsForApi` = 0, 我们的工具名净化是唯一的,
整文件替换会把净化和 `registryAuth()` 一起丢掉)。

## 一、为什么"缓存无法命中": 前缀复用的判据是**字节**

自建/云端的前缀 KV (llama.cpp 的 slot / `cache_prompt`, OpenAI/DeepSeek 的 prompt cache / `cached_tokens`)
复用的判据只有一条: **这次请求体的 messages 从头开始**逐字节**等于上次已缓存的那段**。
不是"语义相同", 是**字节相同**。我们原来那条链上有三处会让字节从很靠前的位置就分叉:

| # | 原来的样子 | 后果 |
|---|---|---|
| 1 | system 每轮现拼 (`buildSystemPromptAsync(context)`), 且 registry 里的**动态层** (项目上下文/git 状态) 也在 system 里 | system 末尾一变 → system 那条消息整条作废 → **它后面全废** |
| 2 | `chat()` 把"当前轮动态区"注入进最后一条 user 消息, 但**只改了发出去的那份数组**, 没有回写调用方自己的 history | 下一轮调用方**重建** messages (`buildMessages()` 每轮新建对象) → 那条 user 退回注入前 → 前缀从 U1 就失配 (`第1次 S H D1 U1` vs `第2次 S H U1 U2`, 丢了 D1) |
| 3 | tools 按调用方数组顺序直发, 嵌套 `parameters.properties` 的 key 顺序也随风抖 | tools 段字节抖动 → **整个前缀**作废 |
| 4 | `stream: true` 时没带 `stream_options.include_usage` | SSE 末帧没有 `usage` → 命中率**测都测不到** (只能盲猜) |

## 二、修法: 一条链只留一个"会变"的位置

```text
[ system ]  = 装配稳定段 (registry 非动态层 + wd + bolloon-runtime 尾标)   ← 跨轮**逐字节不动**
              (+ 调用方自己给的稳定 system; 它变了才会从这条起分叉, 见 §五)
[ history ] = 只追加, 永不重写 (U1 注入后 **写回调用方 history**, 下一轮照样是它)
[ 尾部 ]    = 最后一条 user 消息前部 = CURRENT TURN 区 (标记 + 动态层 + reserve + 调用方易变段)
```

**只有最后那个位置会变**, 所以前缀永远命中前 N 条。

### 机制逐条 (他们怎么改的 → 我们怎么落)

| 机制 | 他们那份 | 我们这版落点 |
|---|---|---|
| ① system 装配缓存 + stable/dynamic 拆分 | 模块级 `_systemPromptCache` (单槽 + TTL 10min + `clearSystemPromptCache()`), `buildSystemPromptParts()` 按 wd 缓存 | `src/llm/pi-ai.ts`: `_systemPromptCache` / `SYSTEM_PROMPT_CACHE_TTL_MS=10min` / `clearSystemPromptCache()` / `systemPromptCacheStamp()` (诊断) / `systemPromptStableHash()`; 拆分靠 `splitLayerBlocks()` 按装配器写的 `<!-- id@version -->` 头 + registry 的 `source==='function'` 层集合 |
| ② dynamic 移出 system | 动态文本进 CURRENT TURN 区, 不再留 system | 同上; 动态层与 system **逐轮都不同**的部分彻底分离 (门断言 `dynamic.project-context` 不在 system 里) |
| ③ 注入回写调用方 history | `chat()` 原地写回传入数组 + `ChatResult.messages` 回带; pi-sdk 据此写回自己的 messageHistory | `chat()` 注入即**原地改**传入数组, 并在 `ChatResult.messages` 回带最终 wire; `src/agents/pi-sdk.ts` 新增**导出的纯函数** `writeBackCurrentTurnInto(history, wire)` (门直接驱它), ReAct 循环每轮调用 |
| ④ 注入幂等 | 标记 `<!-- current-turn: runtime/git/p2p -->`, 已含则跳过 | 同标记 (`CURRENT_TURN_MARKER`); `injectCurrentTurn()` 返回 `{injected, index, reason: 'injected'\|'already'\|'no-user-message'\|'no-dynamic-text'}`; 找不到 user 消息时**明确追加**一条, 绝不写回 system |
| ⑤ 工具 schema 规范化 | `canonicalizeJson()` (递归排 key, **数组保序**) + `canonicalizeTools()` (按 `function.name` 排序) | 同两函数; 我们的顺序是 `canonicalizeTools(sanitizeToolsForApi(tools))` —— **净化边界保住**, 只是排完序更稳 |
| ⑥ `cache_prompt` 开关 | 请求体加 `cache_prompt`, 仅 `main-agent` 为 true; `BOLLOON_DISABLE_CACHE_PROMPT=1` 彻底关 | `shouldUseCachePrompt(purpose)` + **只对本机 endpoint 带** (`isLocalEndpoint()`): `cache_prompt` 是自建服务的扩展字段, 云端不认它, 白带一个未知字段有 400 风险 —— 这层收窄是**我们这边的决定**, 理由写在 `callOpenAI` 注释里 |
| ⑦ initPiAI 指纹幂等 | 指纹 = provider/model/baseUrl/apiKey 的 sha256[:8]; 一致就永远复用, 变了才 `clearSystemPromptCache()` + 重建 | `modelFingerprint()`(16 hex, **只出 hash 不出明文**) + `currentModelFingerprint()`; 指纹**多带 `providerId`** (本仓的自定义供应商真名, 少了它换供应商不重建) |
| ⑧ 诊断日志 | `[kv-server] purpose=… cached=N prompt=N hit=X%` (取 `usage.prompt_tokens_details.cached_tokens` / llama.cpp `timings.cache_n`); `DEBUG_PROMPT_PREFIX=1` 逐消息 `[kv-debug]` | 同两条, **只打数字与 hash**; 我们多一条 `[prompt-profile]` (见 §四) 与"与上一次请求逐条比对"的分叉点报告 |
| ⑨ `stream_options.include_usage` | `stream=true` 时带上 | 同; 流式走真正的 SSE 消费分支 (累积 delta + `onToken` + 末帧 usage), 拿不到 SSE 就仍是原来的 JSON 路径 |
| ⑩ llama.cpp 支持 | `llamacpp` provider (`http://localhost:8080/v1`, `LLAMACPP_MODEL`, key 可空) | 声明 id `llamacpp` 接 **`openai` 协议分支** (与本仓"声明 id ≠ 协议分支"一致), `LLAMACPP_BASE_URL`/`LLAMACPP_MODEL`/`LLAMACPP_API_KEY` 三个 env 与空 key 不带鉴权头; **没进内置 13 家的配置表/注册表** (理由见 §五) |
| ⑪ P2P/一次性请求改轻量 | 他们只是提了一句"里边的 P2P 的请求携带了 system prompt, 可以换成轻量的请求" | 我们真做了: 按 `purpose` 分流, **只有 `main-agent` 是重路径**, 其余 (`summarize`/`improve`/`auto-compact`/`social`/`health`/`p2p`/`cron`/`judgment`/`probe`/`chat` 与**缺省**) 走轻量 system (无完整前缀 / 无工具全集 / 无 CURRENT TURN) |

### 调用方易变段也搬进 CURRENT TURN (这一处是我们多做的, 也是真正让主对话命中的那一下)

`src/agents/pi-sdk.ts` 的 ReAct 循环**每 iteration 重建 systemPrompt**, 里面 `refineContext` (改进提示随质量分/错误数变)
与 `loopProgressSection` (循环进度) 每轮都在变 —— 留在 system 里 = 头一条消息就作废 = 前缀**永远不命中**。
所以这两段从 system 模板里**移出** (一字未改, 只换位置), 走 `chat()` 的新参数 `currentTurnContext`, 进 CURRENT TURN 区:

```ts
// 移出前 (每轮 system 都不同 ⇒ 前缀永远 miss)
const systemPrompt = `...${refineContext}
${this.currentIntentHint}
${loopProgressSection}
${toolDefs}...`;
// 移出后
const currentTurnContext = `${refineContext}${loopProgressSection}`;   // → chat() 的第 8 个参数 → CURRENT TURN
```

## 三、验收: 离线门 `scripts/verify-kv-prefix.ts` (90/0) + 变异 10/10 判红

假 transport (本机 HTTP stub) 拦下每次请求体, 驱 5 轮以上主对话 + 10 个轻量 purpose; **0 次真 LLM**:

- **① 前缀逐字节**: 第 2 轮 `messages.slice(0, N) === 第 1 轮 messages` (逐字节), 且只尾部新增 2 条;
  第 3 轮 / 工具结果轮 (`tool → user`) 同样守住; 带注入的 `[工具结果]` 条目跨轮逐字节相同。
- **② system**: 三轮 `sha256` 相同; 动态层不在 system; 换调用方 system 后**装配稳定段仍逐字节不变**且缓存未清。
- **③ tools**: 调用方抖顺序 + 抖嵌套 key → 出网 `tools` 字节完全相同 + `function.name` 升序 + 数组保序。
- **④ 工具名净化**: 出网名字全部 `^[a-zA-Z0-9_-]{1,64}$`; `contact.list_authorized → contact_list_authorized`;
  超长截断成 64 (`n{55}_hash8`); 回程 `resolveApiToolName` 能还原。
- **⑤ 幂等**: 同一份 messages 连发两次请求体逐字节相同; 标记不重复; 重复写回第二次必 0 条。
- **⑥ `cache_prompt`**: 逐 purpose 断言 (main-agent=true, 其余 10 个 + 缺省 = false), `BOLLOON_DISABLE_CACHE_PROMPT=1` 彻底关。
- **⑦ initPiAI 指纹**: 同参 → 同实例 (`===`) + 缓存时间戳未变; 换 model → 重建 + 清缓存; 指纹只出 hex。
- **⑧ 轻量分流**: 10 个 purpose 的 system ≤1200 字符 / 无 `bolloon-runtime` / 无工具集 / 无 CURRENT TURN;
  中间插满轻量请求后**主对话前缀照旧逐字节相同** (主对话仍是完整前缀 + 完整工具集)。
- **⑨ 日志卫生**: `[kv-debug] msg=i role=… prefixHash=… chars=…` / tools hash / 分叉点报告 / `[kv-server]` /
  `[prompt-profile]` 全部**只含数字与 hash**, 断言日志里**不含消息内容、不含 system 正文、不含 key**。
- **⑩ 流式**: 请求体真带 `stream_options.include_usage`; SSE 增量交给 `onToken`; 末帧 usage 进 `ChatResult`;
  llama.cpp 的 `timings.cache_n` 形状也认。
- **⑪ llama.cpp**: 声明 id 走 openai 分支真发得出去 / 打到 `LLAMACPP_BASE_URL` / 空 key 不带 `Authorization` /
  `model` 取自 `LLAMACPP_MODEL` / 设了 key 就走 Bearer 且指纹敏感 / **`llamacpp` 不在内置表里**。
- **⑫ 调用方易变段**: 易变段变了 system **逐字节不变**, 前缀照样相同, 新段落在新的当前轮消息上;
  三条**源码级**断言 (systemPrompt 模板不再塞 `loopProgressSection`/`refineContext`; 走 `currentTurnContext`; 回写真接上)。

**变异门 `scripts/verify-kv-prefix-mutations.py`**: 10 条机制逐条拆掉 → 门**必须变红**, 实测 **10/10 判红** (要求 ≥4):
拆回写 (M1/M2) · system 掺时间戳 (M3) · 拆规范化 + 打乱顺序 (M4) · 拆工具名净化 (M5) · 轻量分流失灵 (M6) ·
`cache_prompt` 不分流 (M7) · 拆 `include_usage` (M8) · 指纹恒不等 (M9) · 动态层不拆 (M10)。

## 四、环境变量表 (名 / 默认 / 作用)

| 变量 | 默认 | 作用 | 读它的地方 |
|---|---|---|---|
| `BOLLOON_LLM_TIMEOUT` | `120000` (ms) | 单次 LLM 请求超时。**本地大模型首 token 慢**时可设 `300000` (别默认改大: 会把真超时也拖住) | `pi-ai.ts` |
| `BOLLOON_DISABLE_CACHE_PROMPT` | 不设 (= 开) | `=1` 时彻底不带 `cache_prompt` (本地服务上抢 slot 时关它) | `pi-ai.ts` `shouldUseCachePrompt()` |
| `DEBUG_PROMPT_PREFIX` | 不设 (= 关) | `=1` 时逐消息打 `[kv-debug] msg=i role=… prefixHash=… chars=…` + tools hash + **与上一次请求的分叉点**; **只打数字与 hash** | `pi-ai.ts` |
| `BOLLOON_PROMPT_PROFILE` | 不设 (= 关) | `=1` 时每轮打一行 `[prompt-profile] purpose=… source=… profile=full\|light systemCache=hit\|miss stable=N dynamic=N history=N msgs=N tools=N toolsHash=…` (**只打数字与 hash**) | `pi-ai.ts` |
| `BOLLOON_DUMP_BODY` | 不设 (= 关) | `=1` 时把请求体落盘 (排查上游 4xx 用; **会写文件**, 默认关) | `pi-ai.ts` |
| `LLAMACPP_BASE_URL` | `http://localhost:8080/v1` | llama.cpp 服务地址 (设了它 = 自动按 `llamacpp` 走) | `pi-ai.ts` |
| `LLAMACPP_MODEL` | `local` | llama.cpp 侧加载的模型名 (随服务端 `-m` 走, 客户端不自造) | `pi-ai.ts` `mapModel()` |
| `LLAMACPP_API_KEY` | 空 | llama.cpp 的 key (**可空**; 空时**不带鉴权头**) | `pi-ai.ts` `getApiKey()` |

模板同步在 `.env.example` (只留变量名与空值, **永不放假值**); 真值仍只走 `~/.bolloon/llm-config.json`。

## 五、如实留下的边界与保留 (没做到 / 没动)

1. **调用方自己那截 system 一变, 前缀就从第一条 system 消息起分叉** —— 这是参考实现的形状 (调用方的
   system 覆盖拼在稳定段**之后**、同一条 system 消息里)。门把这条**如实断言出来** (第 1 条消息处分叉)
   而不是藏起来。要让"跨轮调用方 system 也变"的场景命中, 得把调用方那截也拆成稳定/易变两半 —— 那是下一处。
2. **`llamacpp` 没进内置 13 家的配置表 (`DEFAULT_PROVIDER_CONFIGS`) / P3 注册表**: 那两张表被源码级门钉着
   (`provider-registry.test.ts` 断言"注册表里能收 native tools 的 provider 集合 == 内置 ids"、"内置名单 == 配置表 keys";
   `provider-catalog.test.ts` / `verify-provider-catalog.ts` 断言 `roster.length === 13`、`bolloon model` 的
   "候选 231 家 = 内置 13 + …")。把 `llamacpp` 塞进去要同时改这些门与目录计数 —— 属于另一条线的冻结面, 本轮**没动**。
   现在要走:**env 驱动** (`LLAMACPP_BASE_URL`) 或按自定义供应商登记 (id=`llamacpp`, protocol=`openai-compatible`)。
3. **`cache_prompt` 只对本机 endpoint 带** (本机 = `localhost`/`127.0.0.1`/`::1`/`0.0.0.0`/`host.docker.internal`):
   云端那几家不认这个字段, 我们**没**在云请求里带它 —— 与参考实现"无条件带"不同, 这是收窄, 不是遗漏。
4. **没做真 LLM 的两轮命中率对比** (要真 key + 真发两次; 本轮验收按"离线可断言"口径做实, 真验留给有 key 的环境):
   命令形态是 `DEBUG_PROMPT_PREFIX=1 BOLLOON_PROMPT_PROFILE=1` 跑两轮, 看 `[kv-server] cached=/prompt=/hit=`
   与 `[prompt-profile] systemCache=hit`。
5. **`providerId` 只进 pi-ai 侧的指纹/分支**, 没动 TS 的内置联合类型 (`ModelProvider`) —— 改它会连锁到
   config-store 的三张 `Record<ModelProvider, …>` 表与上面第 2 条的门。

## 六、关联

- 代码: `src/llm/pi-ai.ts` (机制主体) · `src/agents/pi-sdk.ts` (`writeBackCurrentTurnInto` + 易变段改道) ·
  `src/agents/workflow-pivot-loop.ts` (pivot 也是主对话, 显式 `main-agent`)
- 门: `scripts/verify-kv-prefix.ts` (90/0) · `scripts/verify-kv-prefix-mutations.py` (10/10 判红) ·
  单测 `src/test/kv-prefix.test.ts` (37)
- 相关页: [provider-registry.md](./provider-registry.md) · [model-selection-protocol.md](./model-selection-protocol.md) ·
  [cli-reply-stream-hygiene.md](./cli-reply-stream-hygiene.md)
