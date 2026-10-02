---
title: Bolloon Native Macro-Kernel — 进程内 Agent 内核 (方向 · 边界 · 迁移台账)
source: session (leo 2026-10-02 架构陈述 + 本仓现状真读: pi-sdk.ts / pi-harness.ts / pi-ai.ts / model-selection.ts / run-store.ts / seams.ts)
created: 2026-10-02
last_confirmed: 2026-10-02
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [kernel, architecture, macro-kernel, pi, actor, channel-runtime, scheduler, harness, model-runtime, capability, plan]
---

# Bolloon Native Macro-Kernel

## 0. 一句话

**Bolloon Native Macro-Kernel = 一个进程内的高性能 Agent 操作系统核心: 内部模块化 · 统一调度 · 共享状态受控; Pi 只是暂时的兼容执行器。**

**归属**: 这是 leo (2026-10-02) 的**意图层**架构决定 —— 意图只有人能改, Agent 只读。本页只做三件事:
① 记录方向与禁令; ② 把「仓里已有」与「真的缺」分开 (免得重造); ③ 给出可机器核验的迁移台账。

**要替换的不是 `Pi` 这个名字, 是它现在承担的架构角色**:

```
现在:  Pi     = Agent 的核心事实来源 (4099 行里同时装着 模型/会话/Channel/工具/ReAct/Harness/持久化/通信)
将来:  Kernel = 事实来源
       Pi     = 可替换的一个推理适配器 (推理循环 + 提示装配)
```

## 1. 形态选择: 宏内核形态 + 微内核式接口

leo 原话要点: 「不是把所有代码塞进一个大模块, 而是建立一个**进程内、低开销、共享状态、统一调度**的核心; 各能力以模块形式插入核心, **但不能互相随意越权**。」

这两半各有理由, 缺一半就退化成当前的失控单体:

| 选择 | 理由 | 反面代价 |
| --- | --- | --- |
| **同进程 (宏内核)** | Goal/Run 状态 · channel mailbox · 模型连接池 · 工具调度器 · 权限与证据链 · 事件总线 高频协作; 拆服务 ⇒ 序列化/网络开销 + 状态同步延迟 + 恢复链复杂 + 多通道上下文漂移 + Harness/Run/Goal 出现旁路 | 崩溃域 = 全进程; 内存共享易形成隐式耦合 (见 §6) |
| **冻接口 (微内核式边界)** | 模块只能走明确接口, 不许摸对方私有状态 ⇒ 换掉任一模块 (含 Pi) 都不牵动别的 | 接口设计错了会变成最贵的返工点 |

**五条越权禁令** (违反即缺陷, 不是风格问题):

```
Channel   不能直接改 Goal
Model     不能直接执行 Tool
Tool      不能直接改权限
Provider  不能直接写 Run
子 Agent  不能直接结束 Goal
```

## 2. 目标模块图 (8 模块) 与现状落点

| 模块 | 仓里现有的落点 | 现状 | 缺口 |
| --- | --- | --- | --- |
| Scheduler | `execution-supervisor.ts` + `supervisor-host.ts` (tick/lease/跨进程互斥) | ✅ 已有 | 与「每通道 Actor 队列」是两层调度, 尚未分层 |
| Channel Runtime | `getAgentForChannel` (per-channel 会话缓存) | ⚠️ 有缓存, **没有 Actor 语义** | mailbox / 取消 / 出站队列 / 通道内串行 |
| Model Runtime | `model-selection.ts` (`selectModel` 唯一入口) + `run-store` 每 Run 快照 + `provider-registry`/`provider-catalog` (223 家) | ✅ 写口已唯一 | **无并发/熔断/路由层**; 无 `acquire(snapshot)` 只读取用口 |
| Tool Runtime | `pi-sdk-tools.ts` (工具实现) + 唯一分发点 (`~` 展开 / 别名映射) | ⚠️ 集中但巨 (4122 行) | 未按能力分组/分片; 调度器与注册表混在一起 |
| Policy / Harness | `pi-harness.ts` (**唯一门面**) + `deny-pipeline` + `pre-tool-validator` + `react-harness` | ✅ 已有且有源码级断言锁边界 | 顺序已是协议的一部分; **`tool-gate` 未纳入门面** |
| Goal / Run State | `goal-store.ts` + `run-store.ts` (11 状态 + 非法迁移拒绝) + `goal-flywheel/wiring/seams.ts` (`SEAM_ROSTER`) | ✅ 已有 | `pi-sdk` 仍有直写 Goal 收尾的旧路径 (应走 `closeRunOnce`/`applyClosureToGoal`) |
| Communication | `iroh-transport` / OrbitDB 群 / gateway / outbox | ✅ 已有 | 入站事件**直接同步调** `agent.promptStream` ⇒ 绕过排队 (见 §3) |
| Module Registry | `SEAM_ROSTER` + 冻结门 (`goal-flywheel-wiring-freeze.test.ts`) | ✅ 有方法论先例 | 未推广成**全仓**的模块名册 |

## 3. 机制与判断的分工 (防止 Kernel 变成第二个巨型 Agent)

| Kernel 只做 (机制) | 由 reducer / 模型做 (判断) |
| --- | --- |
| 调度 · 队列 · 并发 · 取消 · 超时 | 下一步做什么 |
| 资源隔离 · 状态提交 · 事件派发 | 是否继续 / 是否完成 / 是否等待 |
| 记录 (Run/evidence/harness 事件) | 是否需要人工处理 |

判据: **Kernel 里不出现任何业务判定** (不判"该不该继续"、不判"算不算完成"), 它只把事实与许可交给 reducer。Kernel 一旦开始判业务, 就等于换了个名字重写 pi-sdk。

## 4. 五条硬原则 + 三处必须修正

### 4.1 多通道 = 独立 Actor

每个 Channel 拥有: mailbox · session · model binding · cancellation · outbound queue · heartbeat。
**不同 Channel 并发, 单 Channel 内状态更新串行。** 这是治 `currentChannelId` 串台 / 共享 session 的正解。

现状反证 (真读源码, 非推测):

| 入口 | 位置 | 有排队? |
| --- | --- | --- |
| Web `/api/message` | `server.ts:5234` | ✅ 唯一有 per-channel queue 的入口 |
| P2P 入站 | `server.ts:993` | ❌ 直调 |
| 远端 followup | `server.ts:666` | ❌ 直调 |
| 社交心跳 | `server.ts:2636` | ❌ 直调 |
| cron | `server.ts:2579` | ❌ 直调 |
| CLI 输入 | `index.ts:3753` | ❌ 直调 (快速连发即并发) |
| runner-resolver (独立宿主) | `runner-resolver.ts:236` | ❌ 直调 |

5/6 入口绕过排队 + 循环状态全是实例字段 (`messageHistory` · `currentOnStream` · `currentSignal` · `lastFailedTool`) ⇒ 并发循环互相覆盖。**这是本路线真正要治的那一刀。**

### 4.2 模型 = 运行时资源 (**修正一: 只读, 不许成为第二个写口**)

形状接受: `ModelRuntime.acquire(modelSnapshot)` ⇒ 每请求自带 `provider / model / baseUrl / capabilities / configHash`, 才能真做多供应商并发。

**必须钉住的边界**: `acquire()` 只能**读**「有效模型配置」(`effectiveModelConfig` / Run 快照), **绝不许自己写配置**。本仓模型侧已有唯一写口 (`selectModel` + 跨进程锁 + 每 Run 快照 + 16/16 验收)。多一个写口 = 这半年那套验收全部作废 —— 这类回归最贵, 且不会有任何门报警。

### 4.3 Harness = 系统调用门 (**修正二: 已经有了, 这是"提升"不是"新建"**)

`dispatchTool → policy → permission → budget → idempotency → execute → evidence` 这个形状, 仓里 **已存在**:
`pi-harness.ts` 的 `beforeToolCall` 顺序就是 `deny-pipeline → pre-tool-validator(4 步) → react-harness(8-gate)`, 第一层拒绝即止; 且 **pi-sdk 里零直连 gate** 由**源码级断言**锁着 (比读代码 review 可靠)。

要做的是: ① 把 `tool-gate` 纳入门面 (已知缺口); ② 补上 `budget` / `idempotency` / `evidence` 三段进同一顺序; ③ 让门面成为**唯一**工具入口 (含 delegate / MCP / 子 Agent 路径)。

### 4.4 持久化只在边界 (**修正三: 分级已存在, 别重造**)

仓里已有 `core` / `observational` 两级: core 写失败 ⇒ `RunPersistenceError` ⇒ 循环硬闸停 + 落 `needs_human` **且不重试**; observational 失败可继续但必须落降级日志。原子写 + `.bak` 损坏回退 + 跨进程 run 锁也都在。

要补的是**边界清单化**: 明确列出"哪几类状态属于边界提交" (Run/Goal/checkpoint/证据), 其余纯内存 —— 而不是重新设计一套持久化。

### 4.5 第三方 / 高风险不入核心权限

第三方 Skill、外部 provider、高风险工具一律走:

```
Capability API + timeout + cancellation + resource budget + evidence boundary
```

不进核心权限面。仓里已有对应地基: contacts/授权链 · `skill-ledger` 写来源隔离 · `managed-services` 启停分级 · Harness 的 fail-closed。

## 5. 对账表: 你要的 vs 仓里已有 (这节最省钱)

| 目标 | 仓里现成 | 对应门 | 真缺口 |
| --- | --- | --- | --- |
| 统一调度 | `execution-supervisor` / lease / tick | `verify-supervisor*.ts` | 与通道 Actor 队列分层 |
| 共享状态**受控** | `run-store` / `goal-store` / `seams.ts` 名册 | `run-store.test.ts` · `*-wiring-freeze.test.ts` | pi-sdk 直写 Goal 旧路径 |
| 权限统一 | `kill`-类护栏 + `pi-harness` 门面 | `pi-harness.test.ts` (源码级零直连) | `tool-gate` 未纳入 |
| 模型运行时 | `selectModel` + Run 快照 | `verify-model-acceptance.ts` 16/16 | 并发/熔断/路由层; `acquire()` 只读口 |
| 恢复与证据 | Run 11 状态 + `.bak` + 降级日志 | `verify-durable-runs.ts` | 边界清单 |
| 通信 | iroh / OrbitDB / outbox | `verify-group-replication.ts` 等 | 入站事件未走队列 |
| 模块边界可机器校验 | `SEAM_ROSTER` + 冻结门 (方法论先例) | `goal-flywheel-wiring-freeze.test.ts` | 未推广到全仓 |

⇒ 8 项目标里 **5 项已有地基**, 2 项是"分层/收口", 只有 1 项 (**ModelRuntime 并发 + 通道 Actor**) 是真正的新建。**重写的理由不成立。**

## 6. 第 5 个风险 (leo 列了 4 个, 这条最要紧)

leo 已列: ① 单模块异常拖垮进程 ② 内存共享形成隐式耦合 ③ 长跑泄漏 (队列/句柄/上下文) ④ 第三方 Skill 扩大安全边界。

**补第 ⑤ 条: Kernel 自己会变成新的巨型单体。** 这不是万一, 是默认结局 —— 只要没有机器判据, 半年后 `kernel.ts` 就是第二个 4099 行。

三条判断 (全部要**机器核验**, 不靠自觉):

```
K1 目录边界门   内核目录不许 import 业务模块 (源码级断言 import 白名单)
K2 名册越权门   模块 A 直接摸模块 B 的私有状态 ⇒ 判红 (照 SEAM_ROSTER 的手法)
K3 行数棘轮     内核目录行数上限, 只许减不许增 (超限判红)
```

K1–K3 是**开工前**就要有的, 不是收尾补的 —— 它们是唯一能防止"宏内核"重蹈"失控单体"的东西。

## 7. 迁移台账

| 阶段 | 做什么 | 判据门 | 完成度 |
| --- | --- | --- | --- |
| **M0 冻结** | 本页 (方向/禁令/模块图) + K1–K3 三门先落地 | 三门自身可变异判红 | ❌ 未开始 (本页只冻方向) |
| **M1 状态外置** | `messageHistory`/`currentOnStream`/`currentSignal`/`lastFailedTool` 从实例字段搬进 per-Run `RunContext`; 循环只读参数里的 context | 复用 `react-loop.test.ts` + `verify-durable-runs.ts` | ❌ 未开始 |
| **M2 入口收口** | per-session 互斥队列; `prompt`/`promptStream` 统一串行; `onStream` 跟随各自 context | 并发注入 (CLI 连发 + P2P 入站 + 心跳同时打) ⇒ 同 session Run 不交错、历史不重复 | ❌ 未开始 |
| **M3 单循环** | `usePivotLoop` 分叉收敛成一个内核 + pivot 降为 policy | 行为变更逐条写明理由; 双面 (CLI/Web) 同门 | ❌ 未开始 |
| **M4 通道 Actor** | mailbox / cancellation / outbound / heartbeat 归 Channel Runtime | 每通道隔离 + 通道内串行 | ❌ 未开始 |
| **M5 模型运行时** | `ModelRuntime.acquire(snapshot)` 只读口 + 并发上限/熔断/路由 | 只读断言 (不得写配置) + 多供应商并发 | ❌ 未开始 |

**M1–M3 不重写就能做**, 做完 pi 已经是"宏内核"形态; M4/M5 是新增模块。**M0 的第一件事是 K1–K3 的门, 不是内核代码。**

## 8. Pi 的撤换判据

**不按时间, 按判据**:

1. M1–M5 做完后, 若仍有 **>30% 的改动必须落进 `pi-sdk.ts` 内部**(而不是落在某个模块) ⇒ 说明边界抽不干净, 那时重写有真凭据, 不是猜想。
2. 推理适配器可替换性被真验证: 存在**第二个**实现能通过同一套门 (`verify-pi-harness` / `verify-durable-runs` / 双面循环门) ⇒ 才叫"可替换", 否则只是"换了个名字"。
3. 或: 支撑「1 万智能体」那条线时 (见 `agent-event-network-plan.md`), 单进程 N 个可变 session 实例在该量级必然不成立 ⇒ 内核须变成「纯函数 run state + 事件溯源」。**那才是重写的正当触发点, 且属于那条线的里程碑。**

## 9. 诚实边界 (代价与未解决)

- **崩溃域 = 全进程**: 宏内核的固有代价, 靠"独立故障分类 + fail-closed"缓解, 不靠隔离消除。手机端/眼镜端是受限设备, 需要一个"瘦模式"内核剖面 (尚未设计)。
- **接口成本**: 冻接口一旦设计错, 是最贵的返工点 —— 所以 M1 之前不发 M2 的接口。
- **不采信"已接线"**: 本页所有判定以真跑门为准; M1–M5 全部 **0 行代码**, 本页只冻结方向、禁令与判据。
- **与既有验收的关系**: 模型侧那套 16/16 验收、飞轮冻结门 34/34、pi-harness 源码级断言**全部保留**, 本路线是**在其上加层**, 不是替换它们。
