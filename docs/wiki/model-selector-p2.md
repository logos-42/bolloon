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

## 8. 真交互 TUI 收尾: 掩码凭证 · 版面减法 · 修「目录里没有就硬拒」误杀 (2026-09-27)

真终端那条路 (`bolloon model` 裸敲 = 第一屏就是选择器) 这一轮**用真 pty 逐键验收**, 并把两件
**先量后改**的实测事实写在这里。

### 8.1 两条实测事实 (先跑出来, 再下结论)

**① 「没颜色」的根因不是 `NO_COLOR` / `TERM` / 非 TTY —— 那条路径压根没有上色代码。**
同一个真 pty、同一个环境变量下逐个数 SGR 序列:

| 命令 | SGR 序列数 |
|---|---|
| `bolloon help` | **24 个** |
| `bolloon model list` | **0 个** |

⇒ 环境侧一切正常 (同一个 pty 里 `help` 就能上色), 是**模型那条路径自己没有着色调用**。这一条
把「是不是 `NO_COLOR` 挡住了」这个方向的排查**直接关掉**。

**② 上游 `/models` **不是**「可用模型」的全集 —— 拿它当判据会误杀真能用的模型。**
用**真凭证**对真上游发最小请求, 逐条实测:

| 模型 | chat 请求结果 | 在上游 `/models` 里吗 |
|---|---|---|
| `deepseek-v4-flash` | **HTTP 200 · choices 正常** | **否** |
| `deepseek-chat` | HTTP 200 | 否 |
| `deepseek-flash` | HTTP 200 | 是 |
| `deepseek-v4-pro` | HTTP 200 | 是 |

⇒ 旧实现在 §「模型接口可用」那一步拿 `/models` 当白名单, **目录里没有就直接判 `model_not_found`**
—— 用户先被允许选中, 到第 6 步探测时才被拦, **`deepseek-v4-flash` 这种真能用的名字被硬杀**。
改法: 目录里没有 → **只作警告** (`目录里没有 X — /models 不是全集, 继续真试一次由端点裁决`),
真拒的判据**只有一个**: 发一次请求, 端点自己拒。放行的同时 `modelAcceptedOutsideCatalog=true`
把「上游目录未列出」这个事实**带出去照实说** (不回头改判成失败, 也不假装它在目录里)。

### 8.2 凭证步: 四条路都在屏上, 输入走掩码

供应商**已配 key** 时, 凭证步给的是四条**并列可达**的路 (不是「有 key 就静默跳过」):

| 选项 | 行为 |
|---|---|
| `保持现有 (指纹 fp:…)` | 沿用盘上的 key, **不回显 key**, 只给指纹 |
| `替换 (重新输入, 掩码)` | 走掩码输入框 |
| `清除存盘的 key` | 显式删掉 |
| `改用环境变量 (<VAR>)` | 只记来源 (`env:<VAR>`), 不落盘 |
| `取消` | 一个字节都不写 |

**掩码**: 输入框里逐字符画 `•` + `(N 字符)` 计数, 明文**不回显**。真 pty 验收用的是**唯一探针串**
(整轮随机), 断言 pty **原始输出里该串 0 命中** —— 也就是「屏幕上真的没有明文」。同时:
屏上**有**掩码字符 `•` 且长度计数与输入长度**对上** (证明输入**真被收到**, 不是静默丢掉);
唯一会印出 key 的字节是回显尾 4 位那行 (`****1234`), 探针前段 0 命中。
取消 (凭证步中途 Esc / 探测失效 / Ctrl-D) 后, 配置 sha 逐字节不变。

### 8.3 版面预算: 每步主屏 ≤ 12 行 + 四条黑名单串

用户真正逐行读的是**主屏** (帧内滚动列表不算 —— 那是选择器自己的窗口)。主屏行的取样办法:
帧里每一行都带 `ERASE_EOL` (`\x1b[K`), 主屏行从不带 ⇒ 用这个**结构判据**把帧剔掉, 量剩下的。

| 取样面 | 每步主屏最多几行 |
|---|---|
| 主流程 (供应商→…) | **2 行** |
| 凭证步流程 | **2 行** (步骤 2 = 2 行: 步骤行 + 已收到 key 行) |
| 探测失效路径 (走到第 5 步) | **3 行** |
| 同一个流程加 `--verbose` | **6 行** (第一步 6 行) |

判据写成 **`≤ 12` 行** (给以后的正常增长留余量), 并配一条**正向对照**: `--verbose` 时那些内部
细节 (`看目录:` / `目录数据:` / `目录分组:`) **真的还能打出来** ⇒ 减法是真**搬走**了, 不是把话删掉。

**黑名单串** (主屏里出现即判红 / 门必红):

| 串 | 为什么是黑名单 |
|---|---|
| `未知原因` | 兜底话术顶掉了真分类 |
| 逐行复读的 `工具调用=未知` | 每行都复读同一个「未知」= 版面又复杂回去 |
| 教程行 `看目录:` | 教程/目录长行塞回主屏 |
| `还要继续尝试切换吗` | 失败后又来一次**假二次确认** |

### 8.4 验收 (真跑) 与变异

`npx tsx scripts/verify-model-ux.ts` — **68 passed / 0 failed, exit 0**。全部断言都靠**真 pty**
(等渲染真的出现再喂下一个键, expect 本身就是断言):

| 断言 | 取样办法 (不信提示文字, 只看结构/字节) |
|---|---|
| 高亮行**真位移** | 两帧**反白行**(`\x1b[7m…\x1b[0m`)逐字对比, 前后不同 |
| 光标序号**真的是** 1→2→3→(↑回)2 | 从各帧状态行抽 `第 i/N` 序列 = `[1, 2, 3, 2]` |
| 数字跳选 | 敲 `9` → 状态行 `第 9/N` + `已跳到第 9 项` |
| 搜索过滤**列表真变短** | 逐帧数**候选项行数**: 全量 14 项 → 筛 `deep` 后 **2** 项 |
| 搜索过滤**状态行数字真变** | 一条 `expect_raw` 同时钉死 `第 1/2 · 筛选 "deep"`; `已筛` 序列最小 **1** < 起始 13 |
| 滚动窗口 | 矮终端 (rows=12, 窗口 H=9) 一直 ↓ → 光标 11 > H, 且**首帧第一项已滚出末帧** |
| 窄终端不撑破 | cols=40 下用**渲染器自己的尺子** `displayWidth` 量每帧每行: 最大 **40 列**, 超宽 **0** 行 |
| 凭证四条路可达 | 四个标签都在屏上渲染出来 |
| 掩码 0 命中 | 见 §8.2 |
| 取消 / 失效后配置 sha 不变 | 取消、EOF、探测失效三条路各自 sha 逐字节相同 |
| 每步 ≤ 12 行 + 黑名单 | 见 §8.3 |
| 真开关 (七步走完) | 落盘 sha 真变 + 盘上 model == 界面上说的那个 + **假上游真收到请求** (目录 2 次 / chat 4 次) |
| 目录外模型 | 端点接受 → 放行 + 标 `acceptedOutsideCatalog`; 负控制: 端点真拒 → 拦住 |
| `model list` 只读 | sha 逐字节不变 |
| 非 TTY (管道) | 退回「清单 + 用法」, 不挂起等待输入 |

**变异判红 9/9** (就地改源码 → 跑门 → 必须红 → 逐字节还原):

| id | 改动 | 红在 |
|---|---|---|
| M1 | 拿掉 ↓ 箭头处理 | 高亮不动 ⇒ 两帧相同 |
| M2 | 拿掉整行反白 | 反白行数 < 2 |
| M3 | 拿掉数字快选 | 状态行不出现 `第 9/N` |
| M4 | 掩码改成回显明文 | 探针串在原始输出里**命中** |
| M5 | 有 key 就静默跳过凭证步 | 屏上不再有 `凭证怎么处理` |
| M6 | 教程行塞回主屏 | 主屏出现 `看目录:` |
| M7 | 未知字段改逐行复读 | 出现 `工具调用=未知` |
| M8 | `verbose` 开关失效 | 主屏出现 `目录数据:` 等内部话术 |
| M9 | 「目录里没有就硬拒」改回来 | 目录外模型被硬拒 (`model_not_found`) |

### 8.5 回归里挖出来的**真回归**: 两道老门的夹具写死了旧语义 (已修)

改判「目录里没有就硬拒」时只动了三处 (`src/llm/connection-probe.ts` + `connection-probe.test.ts` +
`model-selector.test.ts`), **两道老门的夹具没跟着改** —— 于是它们一起变红, 本轮"收到全部门"时才浮出来。
两处**都不是断言写错**, 是**夹具跟真实上游不像**: 真端点遇到不认识的模型就是回 404。

| 门 | 症状 | 真因 |
|---|---|---|
| `verify-model-wiring` | **84 passed / 5 failed** | 夹具 `catalog-missing` (`/models` 里没有 `w-1` 但 chat 照回 200) 在旧语义下一定被硬拒, 于是它被当成 `model_not_found` 的样本; 改判后这台假上游**真的通过探测并写盘** ⇒ `失败不落盘` 与 `全局默认现在是服务 A` 连续倒下 |
| `verify-model-acceptance` | 3 条红 + 第 4 条级联 + 第 16 条 6 条红 | 第 3 条拿 `no-such-model-xyz` 当"错 model"样本, 靠**目录**拦; 改判后桩对任何 model 名都回 200 ⇒ **切换成功并写盘** (`生效=openai/no-such-model-xyz`), 第 4 条的"配置字节未变"和第 16 条整条回滚断言全崩 |

修法是让夹具照真实形状来, **不是把断言改软**:

- `verify-model-wiring.ts`: `model_not_found` 那一格改用**本来就定义好、却一直没人用**的
  `model-ping-404` 桩 (chat 回 404 且 body 带 `model` 字样 ⇒ `classifyStatus` 判 `model_not_found`),
  标签从「目录里没有这个模型」改成「端点自己不认识这个模型 (真 404)」; 并**新增 M6 一节**把改判钉死:
  `catalog-missing` 桩 ⇒ 必须**放行** + `modelAcceptedOutsideCatalog=true` + 配置**真写盘** +
  有效配置真落到它身上 (3 条正向断言, 旧语义下必红)。
- `verify-model-acceptance.ts`: 桩的 `/chat/completions` 加一条 —— 请求的 model 不在它提供的列表里
  就回 **404** (`{"error":{"message":"The model '…' does not exist"}}`)。核对过该脚本 31 处
  `selectModel` 调用: 除 `no-such-model-xyz` 外**每一个 model 都在对应桩的列表里** ⇒ 这条改动只
  影响用它的那三处条目, 零附带。③ 的标签同步改成「端点自己不认识, 真 404」。

- `src/llm/model-selection.ts` 的 `selectModel` **把 `modelAcceptedOutsideCatalog` 丢了**: 探针算出了
  这个事实 (在 `runConnectionProbe` 的返回里), 但入口的成功返回写的是
  `return { ok: true, effective, previous, checks }` —— 字段在 `SelectModelResult` 类型里声明了,
  却**没有一条路能填上**, 调用方/界面永远看不到。收尾时补了透传 (探测结果 → 成功返回), 并把它
  写进 `verify-model-wiring` 的 M6 断言 (旧写法必红)。
  ⚠️ 修的时候踩了一个坑: 用 patch 工具改这一行时, `old_string` 里抄了读工具**显示用的掩码** `apiKey: ***`,
  于是掩码被当成真内容写进了源 (tsc 立刻 TS1109)。教训: 凡含凭证字段的行, **不要**把读到的值抄进 patch
  的 `old_string`; 改成改**相邻行**或用脚本按行号改。

（对照证明旧行为确实是硬拒: `git show HEAD:src/llm/connection-probe.ts` 第 754-757 行
`if (!catalog.includes(model)) { … return fail('model_not_found', …) }`。）

### 8.6 如实留下 (没做到 / 有保留)

1. **掩码的「0 命中」是**整串** 0 命中**: 落盘/切换成功时, 输入框**会**把 key 的**尾 4 位**印在
   主屏的「已收到 key (****1234)」那行 (这是既有行为, 本轮没改)。断言只保证**整串**与**前段**
   不出现在输出里。
2. **颜色没修**: 本轮只把「不是环境挡的、是这条路径没上色」这件事**量清楚并写下** (§8.1①),
   `bolloon model` 那条路径**仍然没有 SGR 着色** —— 要不要上色属版面决策, 留给主线。
3. **上游 `/models` 那条判据只在**一家**上游上实测** (deepseek 的 4 个模型名)。改法是「目录只作警告,
   真请求裁决」, 这条口径对**任何**上游都成立; 但「别家上游的 `/models` 也不是全集」这个更强的
   说法**没有逐家测**。
4. **假上游是本地桩**, 不是真上游: §8.4 那些交互断言全打本地假上游 (0 次真 LLM)。真上游只在
   §8.1② 那个「先量事实」的探针里用过 (4 个模型名, 逐条真 HTTP 200)。
5. **变异是就地改源码再还原**: 一轮被 SIGKILL 打断 (超时/手动杀) 会把改坏的源留在盘上 —— 本轮
   门里加了 **R0 开工前自检** (10 个变异锚点必须全在原位, 缺一个就 exit 2 拒绝开跑)。它防不住
   「正在跑的时候被杀」, 只能保证**下一轮**不会在污染的源上跑出说不清的红绿。
6. **`verify-mobile-model-sync` = 53 绿 / 1 红** (先跑 `npm run build:web` 之后): 唯一那红是**陈旧 IPA**
   (`ipa=0.5.0` vs `npm=0.5.1`), 要 Xcode 重打原生包 —— 本机做不了, 且**不属本轮** (版本号 bump 的那 4 个
   文件还在别人的暂存区; `check-native-artifacts.mjs` 比的是构建产物)。`build:web` 之前它是 14+ 条红
   (整页 `SyntaxError: Cannot use import statement outside a module` = 前端产物没编译) —— 那是**没编译**,
   不是回归。
7. **`verify-cli-quiet` = 11 绿 / 1 红 (A6)**: A6 是**既有的负载/窗口敏感项** —— `log.md` 早有记载:
   「并行跑多道门时 A6 曾判红一次 —— 负载把 20s 窗口拉长, 空载单跑绿, 按负载假红处理」。
   本轮**空载单跑复现出判据要的那行** 3 次 (`[PiAIModel] Error reading apiKey from config: SyntaxError…`
   在启动后 **6.6s** 出现, 与仓内记载的 t≈6.8s 一致); 而**门自己**连跑 3 回都落在
   `[supervisor] 初始化未就绪 (setup, 阶段 connectivity_pending)`、而不是 `(repair, 阶段 provider_pending)`
   —— 即**还没走到读 LLM 配置那一步** (两种阶段的原文都在门捕获的输出里)。A6 的整条源码路径
   (`pi-ai.ts` / `config-store.ts` / `index.ts` / `web/server.ts` / `log-gate.ts`) 本轮**一行都没动**
   (`git diff` 可证) ⇒ 判为**既有假红、不属本轮**, 但**没有修**, 如实记账。
8. **那 4 个版本号文件始终没碰**: `android/app/build.gradle` · `ios/App/App.xcodeproj/project.pbxproj` ·
   `package.json` · `package-lock.json` 在开工前就在暂存区, 本轮**既不 add 也不 commit**, 它们仍以
   "已暂存未提交" 的状态留在原地 (所以收尾的 commit 是**逐文件点名的** `git commit -- <路径>`, 不是裸 commit)。
9. **会话内 (ink) 选择器没有单独跑 pty**: 本门覆盖的是命令行那条路 (`bolloon model`), 会话内 Ink 选择器的
   取消回调只有单测覆盖 (§7③ 的老限制仍在)。

---

## 9. 第 1 步全量候选 + 固定高度视窗与折叠 + bolloon 色系 (2026-09-27 二改)

leo 三条口径 (本轮的验收目标):

1. **"15 家登记在里面显示, 可以更多吗?"** → 第 1 步候选**默认列出全部家** (内置 13 + 自定义 + 目录 223),
   不再"只列有凭证的 + 一行计数概括"。
2. **"不用一下子全部显示, 可以有固定高度或者折叠, 不然页面放不下"** → 中间候选区**固定高度**
   (≤ 12 行, 只画可见行, 视窗外的行**根本不渲染**), **分组可折叠**, 键位写进头行。
3. **"目前是灰白色, 不好看"** → 颜色收回到 **bolloon 色系**, 且**全路径只有一个颜色事实源** `src/cli/theme.ts`。

### 9.1 候选集 = 盘上全部家 (藏家数被明确否掉)

**口径**: 家数多由**界面层**消化 (视窗 + 折叠 + 搜索), **不许靠在候选集里删** ——
藏掉的家搜不到、也数不出来, 用户会以为"没有这家"。

| 项 | 实测 |
|---|---|
| 候选总数 (盘上真算) | **231 家** = 内置 **13** + 自定义 **0** + 目录 **223** − 同名排除 **5** |
| 同名排除项 (逐项点名) | `anthropic` · `deepseek` · `minimax` · `openai` · `openrouter` (目录里也有同名, 内置优先, 不重复) |
| 五个分组 (是**划分**不是筛选) | 当前生效 **1** · 可用 (有凭证/免 key) **2** · 未配置凭据 **199** · 需专用鉴权 (未支持) **14** · 无 api 基址 **15** (合计 231 ✓) |
| 屏上两处数字 | 主屏标题 `共 231 家` 与选择器头行 `共 231 家` **都对上**盘上真算 (不是写死的) |

`buildProviderSummaries` 的默认值从 `catalog:'configured'` 改成 **`catalog:'all'`**;
`'configured'` 与 `'none'` 保留 (给"只看手写那 13 家"这类断言用)。
分组依据落成**纯函数** `providerTierOf` / `providerTierCollapsedByDefault` / `orderProvidersForMenu` /
`PROVIDER_GROUPS` (`src/llm/model-catalog.ts`) —— 主屏、纯文本清单、全屏选择器**共用同一份**, 不各写一套。

### 9.2 固定高度视窗 + 分组折叠 (页面放得下, 而家数照样看得见)

- **视窗**: `viewportHeight(rows) = clamp(rows-3, 3, 12)`; 每帧只渲染 `头行 + (指示行) + body + 状态行`,
  **视窗外的行根本不画** (不是"画完再滚出屏幕" ⇒ 不靠终端回滚缓冲)。
- **折叠**: 分组标题一行 `── 名字 (N 家) ›` (收起) / `▾` (展开) —— **家数永远写在标题上**。
  默认只展开"当前生效 + 可用"; 后三组 (未配置 199 / 需专用鉴权 14 / 无 api 基址 15) 默认收起。
  键位: `空格` 切换 · `←` 收起 · `→` 展开 (作用于光标所在分组; 标题行上直接按也行), 并写进头行提示。
- **搜索**: 有查询词时**命中项平铺** (不画分组标题、不受任何收起状态影响) ——
  "搜索结果被折叠挡住"是最气人的事, 所以命中一律可见。
- **滚动指示**: 视窗上下边各一行 `↑ 上面还有 N 家` / `↓ 下面还有 N 家` (让人知道"没画完"而不是"没有")。
- **数字/`第 i/N` 按"行"算**: 分组标题是**一等行** (能在上面按空格展开), 所以光标序号含标题行。

真 pty 实测 (取门里原文):

| 断言 | 实测 |
|---|---|
| 单帧渲染总行数 ≤ 终端高度 | rows=30 时最大 **14 行** (候选 231 家, 共 13 帧) —— 远小于候选数, 不是"全画出来再滚" |
| 矮终端 (rows=12) | 单帧最大 **≤ 12 行**, 且光标真的走出窗口 (窗口 H=9) |
| 收起的分组标题**照写家数** | `未配置凭据 (选了会先要 key) (199 家)✓` · `需专用鉴权 (未支持) (14 家)✓` · `无 api 基址 (需自定义 baseUrl) (15 家)✓` (与盘上真算逐项一致) |
| 展开真生效 (两帧对比) | 收起帧候选行 **3** → 展开帧 **6** (标记 `›` → `▾`) |
| `special` 家看得到 (原文) | `○ amazon-bedrock · special (需专用鉴权, 未支持) · 无基址 (需自定义 baseUrl) · 缺 key (AWS_ACCESS_…` |
| `无基址` 家看得到 (原文) | `○ aihubmix · 无基址 (需自定义 baseUrl) · 缺 key (AIHUBMIX_API_KEY) · 106 models · 目录 · 族 opena…` |
| 搜索只存在于目录里的家 | 搜 `nvidia` 命中 `→ ○ nvidia · 缺 key (NVIDIA_API_KEY) · 105 models · 目录 · 族 openai-compatible` 并**继续走到凭证步** (不是死胡同) |
| 高亮真位移 (两帧反白行) | 帧1 `→ ● deepseek · ⚠ key 要求不一致 · key 已配 · 2 models` → 帧2 `→ ● ollama · … · 免 key`; `第 i/N` 序列 `[2, 3, 4, 3]` |
| 长列表响应性 (真耗时) | 搜索 `a` 平铺 **230 行** 后连续 **20 次 ↓**: 单键重绘延迟 **p50=157ms / p95=163ms / max=163ms**, 整轮 **5.16s**, 序号 `1..21` 逐行递进, **一次都没超时** |

⚠ 响应性那三个数字是**上界**: pty 驱动是 0.15s 粒度的轮询, 本身带来 ~150ms 量化 (所以 p50 就在量化地板上)。
判据写成 `max ≤ 2000ms`, 并把每次真耗时打进报告 —— 不写"按完没崩"这种对"卡"一无所获的假判据。

### 9.3 颜色只有一个事实源 (`theme.ts`)

`src/cli/theme.ts` 是唯一颜色事实源: `THEME` 调色板 (9 token) + `fg()` / **新增 `bg()`** +
`Tone` 语义调子 + `TONE_TOKEN` (调子→token 唯一映射) + `colorEnabled()` (真终端 × 无 `NO_COLOR` × `TERM≠dumb`) +
`tint()`。组件里**一个 hex 字面量都没有**。

- **光标行**: `REVERSE + BOLD + fg(accent) + bg(muted)` —— 反白把前景/底互换 ⇒ 实际渲染成
  **accent 底色 + muted 灰字** (bolloon 主色块)。为什么不直接 `bg(accent)`:
  反白序列 (`ESC[7m…ESC[0m`) 是**结构判据**, 门靠它认"哪一行是高亮", 拿掉等于把可核证据删了。
  `color=false` 时整段不上, 只剩 `→ ` 前缀 —— 符号通道不依赖颜色。
- **门怎么验"配色统一"**: 门**真读 `theme.ts`** 拿调色板 (不在门里另抄一份), 再把输出里所有
  `38;2;r;g;b` / `48;2;r;g;b` 序列的 RGB 逐条比对 —— 用到 **5 色** (accent `196;214;64` · muted `96;96;88` ·
  ok `34;197;94` · warn `245;158;11` · dim `144;144;136`), 越界 **0**; 光标行有 `48;2;` 底 (9 次) + 反白 (9 次)。
- `tui-select.ts` / `model-selector.ts` 里 hex 字面量计数 **0 / 0** (`theme.ts` 16 = 调色板本体)。
- `NO_COLOR=1` 下真彩序列 **0 条**, 但 `●/○` 状态 · `→ ` 光标 · `── ` 分组标题 + `(N 家) ›` 照旧分得清。

### 9.4 验收 (真跑) 与变异

`npx tsx scripts/verify-model-ux.ts` — **104 passed / 0 failed · exit 0**;
**变异 17/17 判红** 且逐条**逐字节还原** (R0 开工前自检 **19/19** 锚点全在原位, 缺一个就 exit 2)。

本轮在原有 15 条变异上**新增 2 条** (leo 口径点名的"拿掉搜索 / 取消不变性"):

| id | 改动 | 红在 |
|---|---|---|
| **M16** | 拿掉搜索 (字母不再过滤) | 屏上**一次都没有** `筛选 "…"` 帧 (选择器真开起来了, 否则不算红 —— 避免"崩了也判红"的自证) |
| **M17** | 取消也写盘 (话术一个字不改) | **只有配置 sha 会露馅**: 取消后 `sha(config)` 变了 ⇒ 那条"取消后逐字节不变"的断言承重 |

M17 为什么这么写: 提示语仍然是 `已取消, 未改动任何配置`, 界面**看不出问题** ——
所以判据必须是**字节级**的。定点探针先验过一次: 变异后取消 → 盘上真出现 `mut-cancel-1`, sha `ffd7ad9d…` → `a08350f1…`。

变异条目一览 (共 17): M1 方向键失灵 · M2 拿掉高亮 · M3 拿掉数字跳选 · M4 掩码改回显明文 ·
M5 有 key 就跳过凭证步 · M6 教程行塞回主屏 · M7 未知字段逐行复读 · M8 `verbose` 开关失效 ·
M9 「目录里没有就硬拒」改回来 · **M10 只列有凭证的家 (藏家数)** · **M11 折叠默认全展开** ·
**M12 视窗不要了 + 全展开 (版面撑爆终端)** · **M13 拿掉光标行 accent 底色** ·
**M14 一个调子换成调色板外的随手 hex** · **M15 收起标题只给标记不给家数** · **M16 拿掉搜索** · **M17 取消也写盘**。

### 9.5 顺手修掉的真回归 (本轮挖出来的)

**`src/test/model-selector.test.ts` 有一条第 1 步的行形状断言写死了旧顺序**: 旧正则
`/● deepseek · \d+ models/` 在**新行形状**下必然不再命中 (新形状把"为什么不能用"与凭证状态排到**模型数之前**,
依据是**截断存活优先级** —— 尾巴被窄终端切掉时先丢计数, 不丢"为什么不能用")。
**不是把断言改软**: 改成**逐项钉住新形状** + 顺序断言 + `← 当前` 必须在行尾 + 分组标题带家数:

```ts
expect(out).toMatch(/● deepseek · (⚠ key 要求不一致 · )?key 已配 · \d+ models · 内置 · ← 当前/);
expect(effRow.indexOf('key 已配')).toBeLessThan(effRow.indexOf('models'));   // 凭证状态在计数之前
expect(effRow.trim().endsWith('← 当前')).toBe(true);
expect(out).toContain('── 当前生效 (1 家)');
```

### 9.6 如实留下 (没做到 / 有保留)

1. **`verify-model-selection` 在"批跑"里红过一次 (55 passed / 2 failed)**: 红的是**第 12 条"两个进程同时切配置"**
   的并发臂 (进程 1 报 `runtime_rebuild_failed`, 且它的改动被覆盖)。**空载单跑 12/12 全绿**
   (含前置跑完另外两道门之后再跑), 因此是**时序/负载敏感**的红。
   **根因定位 (读源码, 不是猜)**: `src/llm/config-store.ts` 的 `initialize()` 在**任何读失败**时走
   `catch { this.config = getDefaultConfig(); await this.save(); }` (即**把默认配置回写覆盖**),
   而 `save()` 是**非原子的原地 `fs.writeFile`** —— 并发写时读方可能读到半截文件 ⇒
   整份配置被默认值顶掉。**该文件本轮一行没动** (`git diff` 可证), 属**既有缺陷**;
   门里那条断言正是它的探测器。**本轮不修** (不在三条口径内, 修它要连带自己的门与变异), 记账在此。
2. **响应性数字是上界** (见 §9.2 的 ⚠): pty 驱动轮询量化 ~150ms, 所以量到的不是渲染器本身的耗时。
3. **`.git/index` 被别的进程动过一次**: 收尾前发现索引里 `src/cli/tui-select.ts` 是**变异中途**的快照
   (含 `return null; // 变异: 方向键失灵`)。处置: **逐文件重 `git add`** 把索引刷成工作区内容,
   并在提交后核对 (工作区里 `grep 变异` = 0 命中)。
4. **会话内 (ink) 选择器仍没有单独跑 pty** (§7③ / §8.6⑨ 的老限制延续)。
5. **上游 `/models` 不是全集的判定仍只在一家上游实测过** (§8.6③ 的老限制延续)。
