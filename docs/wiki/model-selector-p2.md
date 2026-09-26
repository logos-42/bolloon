---
title: 模型分步选择器 + 冻结的模型元数据接口 (P2)
source: session (leo 2026-09-26 计划 P2 + 代码实测)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, cli, selector, metadata, catalog, interface, parallel, acceptance, mutation]
---

# 模型分步选择器 + 冻结的模型元数据接口 (P2)

> 承接 P0/P1 ([model-selection-protocol.md](./model-selection-protocol.md))。本轮把 `/model` 从
> 「一步选供应商」变成**七步选择器**, 并把「模型能力」这类现在**没有真来源**的数据做成
> **接口冻结 + 缺失显示"未知"**, 而不是编一个好看的值。
>
> 代码: `src/cli/model-selector.ts` (选择器) · `src/llm/model-catalog.ts` (元数据层 + 冻结接口) ·
> `src/cli/setup-wizard.ts` (命令面) · 最终写盘仍然**只有** `src/llm/model-selection.ts` 的 `selectModel`。

## 1. 七步选择器

```
供应商 → (未配置则输入 key) → 模型 → reasoning/temperature → Session 还是 Global → 测试连接 → 确认切换
```

- 每一步都能取消 (`Esc` / 返回 null) ⇒ **一个字节都不写**; 写盘只发生在第 7 步, 且只通过
  `selectModel(req)` (`validateSelection → 写配置(仅 global) → 更新 scope → 重建运行时 → 更新 session`)。
- 第 6 步「测试连接」探的是**候选配置**, **不写盘**; 用的凭证与真正落盘时**同一份**
  (`resolvedApiKeyOf`: 本次新输入的 key > 配置里的 key > 环境变量) —— 否则"已经配好 key 的供应商"
  会在预检里被上游按未鉴权打回 401, 用户看到一句假的"探测失败"。
- 作用域在第 5 步**显式问**, 不再靠"在会话里就是从会话改"的隐含约定; Session + 新 key 在第 3 步结束前
  就判 `credential_scope_conflict` (凭证是全局概念)。
- `--no-verify` 同时关掉第 6 步预检与第 7 步切换前校验 (离线自测用), 但**参数越界仍然照拒**
  (`temperature ∉ [0,2]` → `invalid_temperature`, 在写盘前)。

**列表长什么样** (用户靠它知道"为什么某个模型可能不能用于工具调用"):

```
● <供应商> · N models            ← 有凭证
○ <供应商> · N models · 未配置 key (ENV_VAR)   ← 缺凭证
● <供应商> · 本地                ← 本地端点 (从 base URL 主机名真判定)
▸ <provider 原始 model ID>  工具调用=未知 · reasoning=未知 · 上下文=未知 · key 已配 · 远端端点
```

模型条目带: **当前生效的置顶**(`▸`) · 模糊搜索(子序列 + 连续子串加权) · **provider 原始 model ID
(逐字保留)** · 工具调用能力 · reasoning 能力 · 上下文长度 · 凭证状态 · 是否本地端点 · 连接失败原因。

## 2. 冻结的模型元数据接口 (P3 供应商注册表 / P5 模型发现 的唯一填充点)

**文件**: `src/llm/model-catalog.ts`。**形状冻结**: 后续阶段只准通过填充点往里填真数据,
**不准改形状**, 也不准在渲染层塞"暂时写死的常量"。

### 2.1 填充点 (P3/P5 实现的接口)

```ts
export interface ModelCapabilityFacts {
  displayName?: string;
  toolCalling?: Capability;      // 'yes' | 'no' | 'unknown'
  reasoning?: Capability;
  contextLength?: number;        // token
  origin?: CatalogOrigin;        // 'curated'|'live'|'cached'|'custom'|'unavailable'
  requiresApiKey?: boolean;
}

export interface ModelMetadataSource {
  id: string;                                  // 'provider-registry' / 'live-discovery' / 'catalog-cache'
  providers?: string[];                        // 省略 = 对所有供应商生效
  metadataOf(ctx: { provider: string; model: string }): ModelCapabilityFacts | undefined;
}

export function registerModelMetadataSource(src: ModelMetadataSource): void;
export function listModelMetadataSources(): string[];   // 顺序 = 生效优先级
export function resetModelMetadataSources(): void;      // 测试用
```

**约定 (冻结)**:

- `metadataOf()` 返回 `undefined` 或**缺某个键** ⇒ 该字段保持 `unknown`; 填充者**不许**顺手补默认值,
  本层也**不补**。
- 优先级 = **注册顺序** (先注册的赢); 同一个 `id` 再注册 = **原地替换, 优先级不变**
  (不是挪到队尾, 否则"后注册的悄悄抢走优先级")。
- 填充点必须是**纯同步**的 (数据要么已经在手, 要么就没有) —— 不许在里面发网络请求拖慢选择器。
- 填充点抛错 = 该项没有数据 (**不把异常变成"不支持"**)。

### 2.2 对外类型 (读的人用的形状)

```ts
export type Capability   = 'yes' | 'no' | 'unknown';            // 没有真来源必须是 unknown, 不许用 false 冒充"不支持"
export type CatalogOrigin = 'curated' | 'live' | 'cached' | 'custom' | 'unavailable';
export type Reachability  = 'ok' | 'failed' | 'unknown';

export const UNKNOWN_TOLERANT_FIELDS = ['toolCalling', 'reasoning', 'contextLength'] as const;
export type UnknownTolerantField = (typeof UNKNOWN_TOLERANT_FIELDS)[number];
export interface UnknownNote { field: UnknownTolerantField; reason: string }   // 逐字段"为什么不知道"

export interface ModelEntry {
  id: string;                    // provider 原始 model ID (逐字保留)
  provider: string;
  displayName: string;           // 没有单独来源时 == id (不编展示名)
  toolCalling: Capability;       // ← 允许 unknown
  reasoning: Capability;         // ← 允许 unknown
  contextLength: number | null;  // ← 允许 null (= 未知)
  requiresApiKey: boolean;       // 注册表(供应商维度)说要不要 key
  credentialReady: boolean;      // 现在手上真的有可用凭证 (或这家不需 key)
  isLocal: boolean;              // base URL 主机名真判定
  origin: CatalogOrigin;
  reachability: Reachability;    // ← 允许 unknown
  failureReason?: string;        // reachability='failed' 时必有
  unknowns: UnknownNote[];       // 空数组 = 这一条能力都有真数据
  current: boolean;              // 就是当前生效的 provider+model
}

export interface ProviderSummary {
  id: string; name: string; protocol: ModelProtocol;
  configured: boolean;           // ● 可用
  requiresApiKey: boolean;       // 注册表 (PROVIDER_INFO)
  configRequiresKey: boolean;    // 配置里那格 (= "别再问我了")
  requiresKeyConflict: boolean;  // 两处说法不一致 → 如实标出, 不挑一个装作不知道
  isLocal: boolean;
  modelCount: number;
  modelCountOrigin: CatalogOrigin;  // 'unavailable' = 没有目录, 所以 0 不是"真的没有模型"
  configuredModel: string; baseUrl: string;
  keyState: 'configured' | 'env' | 'missing' | 'not_required';
  current: boolean; active: boolean;
  providerReasoning: Capability;    // 供应商级, 不是模型级
  reachability: Reachability; failureReason?: string;
}
```

**读函数** (P3/P5 与 UI 都只走这几个, 不自己拼):

```ts
buildProviderSummaries(opts?: { probes?: Record<string,{ok:boolean;detail?:string}>; sessionKey?: string }): Promise<ProviderSummary[]>
listModelsFor(providerId, opts?: { sessionKey?; extra?; probe? }): Promise<ModelEntry[]>   // 当前 model 置顶
resolvedApiKeyOf(provider: string): Promise<string | undefined>                            // 只给请求头用, 永不打印
isLocalBaseUrl(raw: string): boolean
curatedModelIds(provider: string): string[]
curatedOriginOf(provider: string): CatalogOrigin
fuzzyScore(haystack, needle): number | null
searchModelEntries(entries, query): ModelEntry[]
buildModelEntry(model, ctx: BuildEntryContext): ModelEntry
capabilityZh(c: Capability): string        // 'yes'→支持 / 'no'→不支持 / 'unknown'→未知
contextZh(n: number | null): string        // null → 未知; 128000 → 128K
formatProviderLine(s: ProviderSummary): string
formatModelLine(e: ModelEntry): string
unknownFootnote(entries: ModelEntry[]): string[]
export const CURATED_ONLY_REASON = '内置目录只有模型 ID, 没有能力字段 (供应商目录/注册表未接)';
```

### 2.3 本轮哪些字段是"未知" (没有真来源, 一律不编)

| 字段 | 现在从哪来 | 状态 |
| --- | --- | --- |
| `toolCalling` / `reasoning` / `contextLength` (模型级) | 只等填充点。内置目录 (~13 家) **只有模型 ID** | **全部 `unknown` / `null`** → 列表显示"未知" + 脚注写清原因 |
| `reachability` | 只有真探过才有结论 (`probes` / 选择器第 6 步) | 没探过 = `unknown` |
| `requiresApiKey` | 内置注册表 `PROVIDER_INFO` (真值) | 真值 |
| `credentialReady` | 配置里的 key / 环境变量 | 真值 |
| `isLocal` | base URL 主机名 | 真值 (函数判定, 不是白名单) |
| `modelCount` / `modelCountOrigin` | 内置目录 | 真值 (`unavailable` 时显示"无内置目录"而不是 0) |
| `requiresKeyConflict` | 注册表 vs 配置 (两处真相) | 真值 —— **实测 ollama 就是冲突的** (注册表 false / 默认配置 true) |

## 3. 唯一写盘路径 (可核证据)

1. **源码级门** (`src/test/model-selector.test.ts`, 只看代码不看注释): `src/cli/model-selector.ts`
   必须含 `selectModel(` 且**不含** `updateProvider(` / `setActiveProvider(` / `initMinimax(` / `writeFileSync(`;
   `setup-wizard.ts` 的 `runModelCommand` 段与会话内 `/model` 段同理。
2. **行为级门**: 选择器在七步里任意取消 ⇒ 全局配置 + 会话绑定**字节不变** (sha 比对);
   第 5 步选 Session (不带 key) ⇒ 只写会话绑定, 全局文件字节不变。
3. **变异** (`scripts/verify-model-selector-mutations.py`): 在 `runModelCommand` 里插一句
   `llmConfigStore.updateProvider(...)` ⇒ 源码门**判红** (M1); 把选择器的 `selectModel` 词界改名 ⇒
   **判红** (M2)。改前先确认盘上 sha256 真的变了, 否则不算数。

## 4. 验收 (真跑) 与变异

`scripts/verify-model-selector.ts` — 真起本地假模型服务 + 真子进程 + 真 `getMinimax().chat()`:
**51 passed / 0 failed** (7s)。`npx tsx scripts/verify-model-selection.ts` (P0 门) 仍是 **55/0**。

| # | 判据 | 手段 |
| --- | --- | --- |
| S1 | 七步真走完 → 下一次请求真命中选的那个 model | 本地 HTTP server 记请求体 `model` |
| S1 | 模型不在内置目录 → 允许**手工输入原始 ID**, 仍走完参数/作用域/提交 | 打印里明确"使用手工输入的 model ID" |
| S2 | 列表三种行形状 + 能力显示"未知" + 凭证两态 (`key 已配`/`缺 key`) | 读渲染出的行 |
| S3 | 填充点真接线: 注册 → 真值出现; 撤掉 → 回到"未知" | 真注册/真撤 |
| S4 | `runModelCommand('pick')` 与选择器同一份; `status --json` 读到同一份 | 真命令面 + 真读回 |
| S5 | 预检失败 → 用户不继续 → **配置字节不变**; 参数越界在写盘前被拒 | sha 比对 |
| S6 | 真子进程改配置 + mtime/size **撞车** → 改动不被陈旧快照覆盖 | 真子进程 + 真 utimes |
| S7 | Run 快照反查: 一致→"一致"; 外部改过→点名 `model`+`configHash`; 没快照→null | 真 `startRun` + 真子进程改盘 |
| S8 | 新进程读到同一份; 输出里没有 key 明文 | 真子进程 |

**变异验证** (`scripts/verify-model-selector-mutations.py`): **10/10 判红** —— M1 第二条写盘路径 ·
M2 选择器不走唯一入口 · M3 工具调用能力编造 `yes` · M4 渲染层把未知翻成"支持" · M5 抽掉锁内
`invalidate()` · M6 反查永远说"没漂移" · M7 把 key 明文打进日志 · M8 `configHash` 不含 model ·
M9 "要不要 key"改回以配置为准 · M10 第 4 步不再收窄列表。

## 5. 上轮三条遗留的处理结果

### ① 锁内 `invalidate()` 现在有门钉住 (上轮一条变异没判红)

- **结论: 它是承重的**, 条件恰好是"文件签名撞车"。签名 = `${mtimeMs}:${size}`, 所以当另一个进程
  改写配置、且**同一整毫秒 + 同字节数**时, `initialize()` 的签名检查发现不了 ⇒ 只有锁内显式
  `invalidate()` 能保证重读。实测路径 (S6): 父进程缓存 `glm-orig-1` → 真子进程改成 `glm-mark-1`
  (`glm-orig-1`/`glm-mark-1` 同为 10 字符, 字节数一致) → `utimes` 拨回同一整毫秒 → **签名检查确实
  看不见** (缓存仍是旧值, 这条也断言了) → 父进程再切一次配置 → 子进程的改动**活下来**。
- 门: 单测 `遗留①: 锁内 invalidate() 承重 —— mtime+size 撞车时必须重读`; 变异 M5 (抽掉 `invalidate()`)
  **判红**。上轮"0 条红"是因为当时没有构造撞车 (mtime/size 都不同 → 签名检查自己就重读了)。

### ② 真启动验收 + 启动停滞的证据 (上轮只挂真路由, 没起完整服务)

- **停滞是真的, 但根因不是 DID/IPNS —— 是夹具探错了端口。** `src/index.ts` 的 web 模式读
  `parseInt(process.env.PORT || '54188')`, **根本不解析 `--port`**; 而 `scripts/ablation/run.ts`
  只传了 `--port`, 端口契约从来没生效 (夹具的 `PORT` 恰好等于默认值 54188, 所以过去"看起来能用")。
  ⇒ 已修: 夹具改为传 `PORT` 环境变量, 并把启动超时 180s → 300s。
- **冷启动实测 ~143s** (进程起到监听): tsx 首次编译 ~40s + 启动序列 5 步;
  其中 DID→IPFS 上传后**发布 IPNS** 一段最重 —— 本地 Kubo 守护等待 20s 超时 +
  本地 IPNS 发布 30s 超时 + 备用发布 (总计约 80s)。启动序列**串行**, web 监听排在 P2P/DID 之后,
  所以"服务没准备好"是真的, 只是原因在时序而不在死锁。
- **真启动验收已跑通**: `npx tsx scripts/ablation/run.ts` → `[server:main] ready` +
  `GET /api/health` **200** (`{"ok":true,...}`) → 16 项端到端 **15 通过 / 1 失败**。
  失败那 1 项不是本轮引入: 上游回 `400 Invalid 'tools[120].function.name'`
  (工具名不匹配 `^[a-zA-Z0-9_-]+$`) —— 属**工具注册表**的问题, 与模型选择无关 (见 §6)。
- 顺带记录: 启动时 `[did-catalog] OrbitDB 复制启动失败 (非致命): Cannot access 'userIdentityCache'
  before initialization` —— 是**真** TDZ 问题 (非致命, 可 API 重试), 本轮不动。

### ③ `configHash` 反向校验 (上轮只用于快照与回显)

- 新增 `compareRunModelConfig(snapshot, current)` (纯函数) 与 `detectRunConfigDrift(runId)`
  (从盘上 Run 记录取快照, 与**现在生效**的那份比)。
- 语义: **逐字段**点名漂移 (`provider`/`model`/`baseUrl`/`configHash`), 不只比 hash;
  一致就明说"一致"; 现状读不出来 → `verified:false` 且**不假装"一致"**; 没有快照 / 没有这个 Run → `null`
  (不编一份出来)。
- 接线点: `pi-sdk.resumeRun` —— 恢复前核对, 漂了就 `console.warn` 并在返回值里带 `modelDrift`;
  旧 Run 记录**不被改写** (S7 断言了)。
- 门: `src/test/model-selector.test.ts` 的 `遗留③` 组 (5 条) + 真跑 S7 (真子进程改盘 → 抓到漂移);
  变异 M6 (反查永远说"没漂移") 与 M8 (`configHash` 不含 model) 都**判红**。

## 6. 并行名册 (P2 之后的文件归属)

**新建 (本轮产出的, 别人的线不许改形状)**:

| 文件 | 谁填 |
| --- | --- |
| `src/llm/model-catalog.ts` | 形状冻结; **只允许 P3/P5 通过 `registerModelMetadataSource()` 填真数据** |
| `src/cli/model-selector.ts` | 七步流程归本轮; 新增步骤 = 回主线串行 |
| `src/test/model-selector.test.ts` · `scripts/verify-model-selector.ts` · `scripts/verify-model-selector-mutations.py` | 本轮的门 |

**共用文件 (只准在"自己那一段"上改)**:

| 文件 | 本轮改动的段 |
| --- | --- |
| `src/llm/model-selection.ts` | 新增 `readSessionSelection` / `compareRunModelConfig` / `detectRunConfigDrift` / `providerDisplayName`; `ModelSelection` 增生成参数; `EffectiveModelConfig` 增 `reasoning`/`temperature`; `SelectionFailureClass` 增类; `formatEffectiveModel` 输出; `materialize()` 增字段; **`selectModel` 主体与锁语义未改** |
| `src/cli/setup-wizard.ts` | `ModelCommandIO` (+`ask?`) · `ParsedModelCommand.action` (+`'pick'`) · `parseModelCommand` · `providerLines` · `formatProviderStatus` · `runModelCommand` (接 pick + 文案) · `askLine` |
| `src/cli-entry.ts` | `handleModelCommand` (改用 `buildProviderSummaries`/`formatProviderLine`) |
| `src/index.ts` | 仅会话内 `/model` 那一段 (借 ink 选择器 + 交给 `runModelCommand`) |
| `src/cli/ink-app.tsx` | 仅程序化选择器: `__inkOpenPicker` 增加**取消回调** (Esc 现在会通知调用方) |
| `src/agents/pi-sdk.ts` | 仅 `resumeRun` (加漂移核对) + 一行 import |
| `src/llm/config-store.ts` | 仅 `ProviderConfig` 增 `reasoning?: boolean` (用户偏好; 缺失 = 没选过) |
| `scripts/ablation/run.ts` | 仅 `startServer` (PORT 环境变量 + 超时 300s) |

## 7. 如实留下 (没做到 / 有保留)

1. **模型级能力 (`工具调用`/`reasoning`/`上下文长度`) 现在全是"未知"** —— 内置目录只有 ~13 家 ×
   少量模型 ID, 没有能力字段。本轮**只定义接口 + 显示"未知"**, 真数据由 P3/P5 填。
2. **`requiresApiKey` 有两处真相且现在冲突**: 内置注册表说 `ollama` 不需要 key,
   `DEFAULT_PROVIDER_CONFIGS.ollama.requiresApiKey` 却是 `true`。本层以**注册表**为准, 并把冲突
   标在列表行上 (`⚠ key 要求不一致`); **要不要统一由 P3 决定** (本轮不改默认配置, 免得动到别的线的判据)。
3. **会话内 (ink) 拿不到文本输入**: `__inkOpenPicker` 只有选择、没有输入框, 所以会话内的选择器
   **没有模糊搜索、没有自定义 temperature**, 且需要新输入 key 时给的是"去系统终端跑
   `bolloon model key`"的指引 (不把 key 打进会话回显)。命令行那条路 (`bolloon model pick`) 七步齐全。
4. **启动停滞只定位到"port 契约 + 串行时序 + IPNS 段 ~80s"**, DID/IPFS 那几段没有逐行计时
   (没有把 `--inspect`/profiler 挂上去); 143s 是冷启动单次实测, 热启动没测。
5. **消融 15/16 里失败的那 1 项没修**: `tools[120].function.name` 非法。它是**工具注册表**的问题,
   不属本轮的模型选择范围 (本轮只负责如实报告, 见 §5②)。
