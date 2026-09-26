---
title: 长期任务 / Supervisor 的模型策略 (Goal modelPolicy · 在跑 Run 不漂移 · 非幂等不重跑)
source: session (leo 2026-09-26 计划 P7 + 代码实测)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, goal, supervisor, run-store, policy, run-snapshot, idempotency, replay-guard, acceptance]
---

# 长期任务 / Supervisor 的模型策略 (P7)

> 要回答的问题: 一个跑了三天、跨了 12 条 Run 的长期目标, 用户中途把全局默认模型从 A 换成 B ——
> ① 正在跑的那条 Run 会不会**静默漂移**? ② 下一个 Run 该用谁? ③ 换了模型之后,
> 已经成功执行过的**非幂等动作**(写文件 / 提交 / 付款)会不会被重做一遍?
>
> 代码: `src/agents/model-policy.ts` (策略解析 + 决定 + 守卫 + 事件) ·
> `src/agents/run-store.ts` (`modelSwitches` 账本 + `recordModelSwitch`) ·
> 验收 `scripts/verify-model-policy.ts` · 单测 `src/test/model-policy.test.ts`。
>
> 上游: [model-selection-protocol.md](./model-selection-protocol.md) §5「每 Run 快照」是**真源** ——
> 本层不另建一份模型配置来源, 也不重写任何一条老 Run 的快照。

## 1. 三条规则 (逐条可判)

| 规则 | 判据 (能被判红的那句话) |
| --- | --- |
| 切 Global **不自动改写**正在执行的 Run | `resolveRunModel({intent:'current_run'})` 返回的 `config` **逐字段等于**该 Run 的 `modelConfig` 快照, 且 `frozen=true`; 盘上快照字节不变 |
| 新 Run **默认用最新 Global** | `resolveNextRunModel({prevRunId})` 在 `mode=auto` 下 `source='global'`, 且新 Run 的落盘快照 `configHash` 与旧的不同 |
| 同一个 Goal 换不换由 `modelPolicy` 决定 | `auto` / `pinned` / `session` 三种模式各自的决定来源与 `switched` 取值 (见 §2) |
| 发生切换**写 Run 事件** | `RunRecord.modelSwitches[]` + `harness` 镜像事件 (outcome/mode/source/guardsCarried) |
| 模型变了**不**构成重跑非幂等工具的理由 | 切换后下一个 Run 的非幂等守卫条数不减少, 重放同一动作时真工具**不被调用**, 探针文件字节数不变 |

**事实边界 (最要紧的一条)**: Run 自己的 `modelConfig` 快照**一旦定稿就永不改写**。
本层算出来的「该用哪一份」只用于①下一个 Run 的启动快照, ②切换事件 —— 它不回头改老 Run。
所以「在跑的 Run 不漂移」不是靠自觉, 而是**结构上没有那条写入路径**。

## 2. `modelPolicy` 三种模式

```
~/.bolloon/model-policy/<goalId>.json      ← 策略加成文件 (与 goals/ 同级, 0600, 原子写)
```

Goal 记录上**若**已经带 `modelPolicy` 字段 (主线补字段那条路), 则**以记录为准**, sidecar 自动让位 ——
`readGoalModelPolicy()` 的读取顺序就是 `goal_record > sidecar > 未声明`。

| 模式 | 新 Run 用哪一份 (`source`) | 在跑的 Run | Supervisor 挑备用模型 |
| --- | --- | --- | --- |
| `auto` (未声明时的默认) | 最新有效默认 (`global`) | 不动 (快照) | 允许, 但**只对模型相关失败类别** |
| `pinned` | Goal 固定的 provider/model/baseUrl (`goal_pin`, `selectionScope='run'`) | 不动; 与固定不符时**只记冲突事实** | 不许 (固定就是要可追溯) |
| `session` | 当前交互会话的绑定 (`session`); 没有绑定 → 保住上一条 Run 的快照 | 不动 | 不许 (Supervisor 不在那个会话里) |

**保守降级方向** (宁可不动, 也不擅自跟随全局):

| 情形 | 处理 |
| --- | --- |
| `mode` 拼错 / 未来值 | `ok=false`, `mode` 记 `unknown`, 决定退回"沿用上一条 Run 快照", 理由里点名原值 |
| `pinned` 缺 `provider`/`model` | `ok=false` → 谁都不许换 (也不会退化成"跟随全局") |
| 写一份不完整的 `pinned` | **拒绝落盘** (写一份用不了的策略比不写更坏) |
| 策略文件损坏 | `origin='invalid'` + `problems` —— 不许被说成"没有策略" |
| 没有上一条 Run 也没有可用默认 | `config=null`, 如实说"没有", **不编**一份出来 |

`switched` 是**事实**陈述 (这一份与记录里的那份不同), 不是"切换被允许" —— 二者在 `frozen`/`outcome` 上分开表达。

## 3. Supervisor 按失败类别挑备用模型

| 失败类别 | 允许? | 理由 |
| --- | --- | --- |
| `transient` · `auth` · `no_such_tool` · `unparsable` | ✅ (`auto` 下) | 与模型相关: 换一个模型可能真的解决 |
| `bad_args` · `policy_denied` · `persist_failed` · `crash` · `external_no_reply` | ⛔ | 与模型无关 —— 换模型只会**掩盖**问题 |
| 任何类别 + `pinned` / `session` / `unknown` | ⛔ | 策略不允许 (理由逐条不同, 都写进 `reason`) |

挑候选时**跳过与当前相同的那一份** (同一份不算"备用"); 候选为空/全同 → `ok=false` + 原因, 不硬凑。

## 4. 非幂等守卫: 模型变了 ≠ 可以从头再来

- 守卫来源与恢复/续跑**同一套算法**: Run 步骤里 `ok=true` 且 `isNonIdempotentTool()` 为真
  (只读白名单外的都算非幂等, 保守)。参数指纹用记录层同一个 `argsDigestOf()`。
- `planSwitchContinuation()` 把守卫**独立于模型决定**地算出来, 并报出 `guardsDropped`
  (**恒应为 0**) —— 「模型变了就清空守卫」这种写法会直接把这个数字顶起来, 门禁据此判红。
- 跨 Run 守卫的**真执行入口**是执行链自己的重放守卫 (`setContinuationGuards` → 命中即跳过,
  步骤摘要记 `[恢复保护]`), 本层只负责**别把守卫弄丢**。
- 换个参数的动作照跑: 只有"同工具 + 同指纹"才算重做, 换了参数是新动作。

## 5. 验收 (真跑)

`scripts/verify-model-policy.ts` —— **36 检查点 / PASS 36 · FAIL 0**
(其中 3 条是"假模型服务真的收到了请求 / 请求体里的 model 真是那一串"的计数断言)。
真跑的含义: 起**真 HTTP 服务器**扮演模型服务 (返回真 `tool_calls`), 用**真 agent 会话**驱动**真工具**
(`terminal` 往探针文件追加), 断言读的是**盘上 Run 记录**与**探针文件字节数**。

| # | 判据 | 手段 (真跑) |
| --- | --- | --- |
| 1 | 在跑的 Run 不被改写 | 真 `startRun` 带快照 → 真切全局默认 → 真读回: 快照逐字段相等 + `frozen` |
| 2 | 新 Run 用最新 Global | 决定里的快照真开新 Run, 落盘 `configHash` 与旧的不同 |
| 3 | `pinned` 全局切了也不换 | sidecar 写策略 → 全局切到 B → 新 Run 仍是固定三元组 (hash 用 `configHashOf` 复核) |
| 4 | `session` 双分支 | 无绑定 → 抓住旧快照; 有绑定 → `source='session'` |
| 5 | Supervisor 备用边界 | `transient` 选中候选 / `bad_args` 拒 / `pinned` 拒 (理由逐条断言) |
| 6 | 事件真落盘 | `modelSwitches` 顺序 (frozen → switched) + `from/to` 两份 hash + `harness` 镜像 (deny/note) |
| 7 | **非幂等负控制** | 真 agent+真工具: 模型 A 跑出一次副作用 (探针 1B) → 切到 B → 下一个 Run 带守卫重放同一命令 → **探针仍 1B**, 步骤记 `[恢复保护]` |
| 8 | [7] 的**敏感性对照** | 同样条件但**不带守卫** → 探针变 2B (同一动作真的重做了一次) |

**没有第 8 条, 第 7 条就不成立** —— "探针没长"可能只是探针不灵敏; 第 8 条证明这套探针能抓到真实重做。

### 变异验证 (改坏必须判红)

| 变异 | 单测 | 真跑验收 |
| --- | --- | --- |
| **M1** 在跑的 Run 也跟着最新默认换模型 | **4 红** | **34 PASS / 2 FAIL** (正是「在跑的 Run 仍返回自己的快照」「被标成冻结」两条) |
| **M2** 模型一变就清空跨 Run 非幂等守卫 | **2 红** | **30 PASS / 6 FAIL** (探针 1B→2B, 步骤不再记 `[恢复保护]`, `guardsDropped=5`, 并连带打掉第 8 条对照) |

M1/M2 都按**行为**改 (不是改字符串), 改完先确认盘上 hash 变了再跑。

## 6. 接线状态 (诚实版)

- **已落地**: 策略解析 / 决定 / 守卫 / 事件 / 策略文件 / 两个 I/O 入口
  (`resolveCurrentRunModel` · `resolveNextRunModel`) 全部可用, 真跑验收通过。
- **还没接的钩子** (需主线在别的文件里加一行, 本层不擅自改):
  1. `src/agents/execution-supervisor.ts` **`:678-713`** (`runGoal`): 在 `const guards = plan?.replayGuards || []` (**`:681`**)
     之后调 `resolveNextRunModel({ prevRunId, goalId: goal.goalId })`, 把 `startRunModelConfig` 与
     `continuation.guards` 交给 resolver/runner (`:713`) —— 现在 Supervisor 的 continuation 守卫仍走
     `buildContinuationPlan` 那一份 (那一份**也带**守卫, 所以"不重跑"这条在 Supervisor 路径上没有缺口;
     缺口是"新 Run 按 Goal 策略选模型"与"切换事件留痕"这两件)。
     签名建议: `GoalExecutionRequest` (**`:202`**) 加 `modelConfig?: RunModelConfig` (可选, 老调用方不受影响)。
  2. `src/agents/execution-supervisor.ts` **`:166`** (`const cls = run.errorClass || 'unknown'`): 这就是失败类别的
     落点, 在这里调 `supervisorMaySwitchModel({ mode, errorClass: cls })` 再决定要不要挑备用 —— 现在没有调用点。
  3. `src/agents/goal-store.ts` **`:114`** (`GoalRecord`): 加 `modelPolicy?: { mode; pin? }` 字段 ——
     `readGoalModelPolicy()` 已经**优先读记录字段**, 字段一旦补上 sidecar 自动让位 (无需改本层)。
- **没做的**: CLI/Web 命令面 (如 `/model policy <goalId> auto|pinned|session`) 与 UI 展示 —— 本层只出 API 与事实。
