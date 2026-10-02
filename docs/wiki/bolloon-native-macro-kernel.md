---
title: Bolloon Native Macro-Kernel — 进程内 Agent 内核 (方向 · 边界 · K0–K10 台账)
source: session (leo 2026-10-02 架构陈述两轮 + 本仓现状真读: pi-sdk.ts / pi-harness.ts / pi-ai.ts / model-selection.ts / run-store.ts / constraint-runtime / seams.ts)
created: 2026-10-02
last_confirmed: 2026-10-02
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [kernel, architecture, macro-kernel, pi, actor, channel-runtime, scheduler, harness, model-runtime, capability, constraint-runtime, plan]
---

# Bolloon Native Macro-Kernel

## 0. 一句话与归属

**Bolloon Native Macro-Kernel = 一个进程内的高性能 Agent 操作系统核心: 模块化 · 统一调度 · 共享状态受控; Pi 是过渡适配器。**

**归属**: leo (2026-10-02) 的**意图层**决定 —— 意图只有人能改, Agent 只读。
**要替换的不是 `Pi` 这个名字, 是它现在承担的架构角色**:

```
现在:  Pi     = Agent 的核心事实来源 (4099 行里同时装着 模型/会话/Channel/工具/ReAct/Harness/持久化/通信)
将来:  Kernel = 事实来源
       Pi     = 可替换的一个推理适配器 (推理循环 + 提示装配)
```

**目标 (leo 原话)**: 「把 K0–K10 的所有阶段完成, 这是 goal」。台账见 §7; 完成度一律以**真跑门**为准, 未完成标 `❌ 未开始`, 不许叙述式汇报。

## 1. 形态选择: 宏内核形态 + 微内核式接口

leo 原话要点: 「不是把所有代码塞进一个大模块, 而是建立一个**进程内、低开销、共享状态、统一调度**的核心; 各能力以模块形式插入核心, **但不能互相随意越权**。」

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

派生一条: **Channel 不能直接写 Run** —— 来自 §7 的 K3「入口收口」。

## 2. 最终架构

```text
CLI / Web / Mobile / P2P / Cron / Supervisor
                    ↓
            Bolloon Native Kernel
                    ↓
 ┌──────────┬──────────┬──────────┬──────────┐
 Channel    Scheduler  Model      Tool      Policy
 Runtime               Runtime    Runtime   /Harness
 └──────────┴──────────┴──────────┴──────────┘
                    ↓
          Goal / Run / Evidence / Recovery
                    ↓
       Pi Adapter / Native Adapter / Mobile Adapter
```

**宏内核的含义** (leo 逐条): 同一进程 · 直接内存调用 · 统一调度 · 共享状态但受接口限制 · 高性能异步事件流 · 不拆微服务 · 不允许模块互相访问私有状态。

## 3. `constraint-runtime` 定位 (leo 分类)

实体在 `src/constraint-runtime/` (带自己的 `package.json` —— 是**移植层**)。三类处置:

| 类 | 内容 | 处置 |
| --- | --- | --- |
| **A 原语** (晋升为底层) | `ToolPermissionContext` · `BudgetTracker` · `SkillRegistry` · tool metadata / capability registry · 少量纯函数型 Session/History 工具 | 进 Kernel (K1 清点时定接口) |
| **B 领域工具** | WalletTools · SafeSDK · Polymarket · OpenCLI | 留作外部工具, 经 capability adapter 接入 |
| **C 不进 Kernel** | remote/ssh/teleport placeholder · archive/reference mirror · 无关 CLI/UI · 旧移植层 · **任何直接改 Goal/Run/权限/模型配置的模块** | 隔离/归档, Kernel 不许 import |

**红线**: 不许把 `constraint-runtime` 整体改造成新的巨型核心 (那就只是换了个名字重蹈 §6 第⑤条)。
**K1 清点的重点修正**: Budget 支持累计/预留/释放/对账 · Permission 返回结构化拒绝 · SkillRegistry 与执行器分离 · Session 不再是全局可变状态中心 · Tool registry 不负责执行副作用 · 所有上下文带 `channelId/goalId/runId`。

## 4. 机制与判断的分工 (防止 Kernel 变成第二个巨型 Agent)

| Kernel 只做 (机制) | 由 reducer / 模型做 (判断) |
| --- | --- |
| 调度 · 队列 · 并发 · 取消 · 超时 | 下一步做什么 |
| 资源隔离 · 状态提交 · 事件派发 · 记录 | 是否继续 / 是否完成 / 是否等待 / 是否要人工 |

判据: **Kernel 里不出现任何业务判定** (不判"该不该继续"、不判"算不算完成"), 它只把事实与许可交给 reducer。Kernel 一旦开始判业务, 就等于换了个名字重写 `pi-sdk`。

## 5. 对账表: 已有地基 vs 真缺口 (判断"要不要重写"的依据)

先真读 (不猜): `pi-sdk.ts` **4099 行** · `pi-sdk-tools.ts` 4122 · `pi-ai.ts` 1723 (合计 ≈11k) · **48 个非测试源码文件 + 32 个测试文件**引用 `pi-sdk*` · 95 道 `verify-*.ts` 里 **21 道**钉在 pi 上 · 近 60 天 `pi-sdk.ts` 改 **54 次**。

| 目标 | 仓里现成 | 对应门 | 真缺口 |
| --- | --- | --- | --- |
| 统一调度 | `execution-supervisor` / lease / tick | `verify-supervisor*.ts` | 与通道 Actor 队列**分层** |
| 共享状态受控 | `run-store` / `goal-store` / `seams.ts` 名册 | `run-store.test.ts` · `*-wiring-freeze.test.ts` | `pi-sdk` 直写 Goal 旧路径 |
| 权限统一 | `pi-harness` 门面 (源码级零直连锁死) | `pi-harness.test.ts` | `tool-gate` 未纳入门面 |
| 模型运行时 | `selectModel` 唯一写口 + 每 Run 快照 | `verify-model-acceptance.ts` 16/16 | 并发/熔断/路由层; `acquire()` 只读口 |
| 恢复与证据 | Run 11 状态 + 原子写 + `.bak` + 分级 | `verify-durable-runs.ts` | 边界清单化 |
| 通信 | iroh / OrbitDB / outbox | `verify-group-replication.ts` | 入站事件未走队列 |
| 模块边界可机器校验 | `SEAM_ROSTER` + 冻结门 (方法论先例) | `goal-flywheel-wiring-freeze.test.ts` | 未推广成全仓名册 |

⇒ 8 项里 **5 项已有地基**, 2 项是分层/收口, **只有 Channel Actor 与并发 ModelRuntime 是真新建**。**重写的理由不成立。**

**三处必须钉死的修正** (防重造 / 防回归):

1. **`ModelRuntime.acquire(snapshot)` 必须只读** —— 每请求自带 `provider/model/baseUrl/capabilities/configHash` 的形状对, 但它只能**读**「有效模型配置」。模型侧已有唯一写口 (`selectModel` + 跨进程锁 + 每 Run 快照 + 16/16 验收); 多一个写口 = 那套验收全部作废**且没有任何门会报警**。判据: 新层出现后旧写口 (`selectModel(`) 调用点数只许不变或减少。
2. **Harness 作系统调用门是"提升"不是"新建"** —— `pi-harness.ts` 的 `beforeToolCall` 顺序 (`deny-pipeline → pre-tool-validator → react-harness`, 第一层拒绝即止) 已是该形状, 且 `pi-sdk` 零直连 gate 由**源码级断言**锁着。要补: `tool-gate` 纳入 · `budget`/`idempotency`/`evidence` 进同一顺序 · 覆盖 delegate/MCP/手机/子 Agent。
3. **持久化边界分级已存在** —— `core`/`observational` + `RunPersistenceError` 硬闸 (停且不重试) + 原子写 + `.bak` + 跨进程 run 锁。要补的是**边界清单化**, 不是重造一套。

## 6. 第 5 个风险与 K1/K2/K3 机器门

leo 列了四个风险: ① 单模块异常拖垮进程 ② 内存共享成隐式耦合 ③ 长跑泄漏 (队列/句柄/上下文) ④ 第三方 Skill 扩大安全边界。

**补第 ⑤ 条, 且它最要紧**: **Kernel 自己会变成下一个巨型单体。** 这不是万一, 是默认结局 —— 只要没有机器判据, 半年后 `kernel.ts` 就是第二个 4099 行。

三条门**必须在开工前落地**, 不能收尾补 (手法照 `SEAM_ROSTER` + `goal-flywheel-wiring-freeze.test.ts`):

```
K1 目录边界门   内核目录的每条仓内 import 必须落在允许前缀内 (现阶段只许 kernel/ 内部;
                对外能力一律经 contracts/ports/adapters 传入, 不许内核自己伸手摸业务模块)
K2 模块越权门   五条禁令 + 1 条派生。关键: 禁令落在**写/改入口**上, 不是"整层不许 import" ——
                tools→shell-guard 的只读校验合法, tools→allowTool() 才是越权
K3 行数棘轮门   kernel 目录行数上限, 只许减不许增; 要加就得同时改「预算」与「冻结值」两个数字
```

## 7. 阶段台账 (K0–K10, leo 定序; 完成度以真跑为准)

| 阶段 | 内容 | 判据 / 完成标准 | 完成度 |
| --- | --- | --- | --- |
| **K0 边界冻结与安全门** | 先不改执行行为, 立 K1/K2/K3 三门 | 三门各有正例 · 各有变异 · 变异真判红 · 不改现有行为 | ✅ **已完成** (提交 `26ffa6d`, 证据见 §12) |
| **K1 Runtime 清点与原语提取** | `constraint-runtime` 做 A/B/C 分类; 提取 Kernel 原语 | Kernel 只依赖 A 类 · B 类走 capability adapter · C 类不再被 import · 现有测试全绿 | ❌ 未开始 |
| **K2 RunContext 状态外置** | `messageHistory`/`currentOnStream`/`currentSignal`/`lastFailedTool`/`currentChannelId`/`currentRunId`/`currentIntent` 搬进 `RunContext` (含 `requestId`/`channelId`/`agentId`/`goalId`/`runId`/`modelSnapshot`/`history`/`abortSignal`/`budget`/`eventSink`/`harnessContext`); 循环只吃显式 Context | 两并发 Run 的 history 不互污 · 两 channel 的 stream 不串台 · 一个 Run 取消不影响另一个 · SIGKILL 后可按 RunContext 恢复 | ❌ 未开始 |
| **K3 入口收口与单循环** | 六个入口 (P2P / 远端 followup / 社交心跳 / cron / CLI / 独立 Supervisor) 全部改走 `submit(request) → resolve channel → enqueue → create RunContext → execute → close`; CLI 与 Web 双循环收敛成一个 Kernel Loop, Pivot 降为策略 | 同 Channel 恒串行 · 不同 Channel 可并发 · CLI/Web 行为一致 · 无入口绕过队列 · 所有循环经同一 Harness 与 Run 收尾 | ❌ 未开始 |
| **K4 Channel Actor Runtime** | 每 channel = 独立 Actor (mailbox/session/model binding/cancellation/outbound queue/heartbeat/active Run) | 16 channel 并发无串台 · 一个 channel 模型超时不阻塞其他 · P2P/CLI/Web/cron 同时输入不重复执行 · channel 重启能恢复自己的 session/Goal | ❌ 未开始 (**K0 登记的 4 处欠账在此还清**) |
| **K5 ModelRuntime** | `acquire(snapshot)` / `invoke(request)` / `release(handle)`; 每请求不可变快照; provider adapter · 连接池 · 并发限制 · 超时 · 取消 · 熔断 · 健康状态 · tool-calling/reasoning 能力 · 失败路由 · 连接复用 | 多 provider 并行 · 同 provider 复用连接 · 一个 provider 挂不影响其他 · 限流只影响自己队列 · Supervisor 按失败类别切备用 · Run 记准确快照 | ❌ 未开始 |
| **K6 Harness 系统调用化** | `dispatchTool → deny → permission → validation → policy → budget → idempotency → execute → evidence → event`; 扩 `pi-harness` (tool-gate/预算/幂等/证据/payment/contact/delegate/MCP/子 Agent/手机端) | Kernel 之外没有工具执行入口 · Pi/子 Agent/MCP/手机/P2P 同门 · 任一门失败都落 Run 事实 · 不许 fail-open | ❌ 未开始 |
| **K7 通信 Runtime 收口** | 三层 `Transport → Message Router → Channel Mailbox`; Router 管路由/requestId 幂等/身份验证/事件来源/优先级/重试/回执, **不能直接调 Agent** | 通信不阻塞模型执行 · 模型慢不堵消息接收 · 消息不被错 channel 消费 · 远端事件可恢复 · 发送/接收/唤醒都有事件证据 | ❌ 未开始 |
| **K8 Pi 兼容适配器** | `Kernel → PiAdapter → PiAgentSession`, 只实现旧接口 (`prompt`/`promptStream`/`resumeSession`/`getIdentity`); Pi 不再管 Goal/Run/模型选择/provider 写配置/channel 调度/工具权限/证据/Supervisor 决策 | CLI/Web/P2P/Supervisor 都从 Kernel 进入 · Pi 只剩推理适配 · 第二个 Adapter 可接入 · 两适配器过同一 Harness 门 | ❌ 未开始 |
| **K9 Native Adapter** | 不依赖 Pi 的第二个推理执行器; 第一阶段不求更聪明, 只求: 接 ModelRuntime · 生成工具调用 · 收工具结果 · 返最终输出 · 过同一 Harness · 过同一 Run/Goal · 支持取消/超时/恢复 | 同上 (这是判断 Pi 是否真可替换的关键) | ❌ 未开始 |
| **K10 Pi 降级与移除** | 按 6 条件判定, **不是"删文件"** | ① Kernel 接管所有入口 ② 第二个 Adapter 过验收 ③ Pi 代码 70%+ 职责已移出 ④ `pi-sdk.ts` 不再是状态事实来源 ⑤ 替换 Pi 不改 Web/CLI/Supervisor ⑥ 长期执行验收仍全过 | ❌ 未开始 |

**交付顺序** (leo 定, 不许跳): K0 → K1 → K2 → K3 → K4 → K5 → K6 → K7 → K8 → K9 → K10。

## 8. 验收矩阵 (leo 定)

| 维度 | 条目 |
| --- | --- |
| **并发** | 16 channel 并发 · 4 provider 并发 · 同 channel 连提 10 条 · P2P/CLI/cron 同时提交 · 多子 Agent 同时调工具 · **不出现串台 / 重复 Run / 重复工具副作用** |
| **模型** | provider A/B/C 同时跑 · 同 provider 多模型并发 · 自定义 URL · 连接失败 · 429 限流 · 超时 · 自动熔断 · **fallback 不重复执行工具** · 运行中切默认模型不改旧 Run |
| **长任务** | 跨多 Run · 跨模型继续 · SIGKILL 恢复 · 页面与 CLI 都消失后恢复 · 外部等待唤醒 · 预算耗尽 · pause 后重启仍暂停 · 子 Agent 阻塞后重新派遣 |
| **安全** | 未授权工具被拒 · policy 失败不放行 · 支付不重复 · contact 不重复 · MCP 不能绕过 Harness · 子 Agent 不能结束 Goal · Skill 不能直接写权限 · provider 不能直接写 Run |
| **性能** | 先建 Pi 基线, 再要求: 单请求 p95 ≤ 基线 110% · 多通道吞吐不低于基线 · 连接复用后首 token / 工具往返有改善 · 内存增长可控 · 队列有上限与背压 · 一个 provider 故障不扩到全局 · 无未释放 timer/stream/AbortController |

## 9. 明确不做

微服务 · Kafka/Redis 消息集群 · 全面 Event Sourcing · 重写 Web/CLI · 重写 Goal/Run · 重写模型选择 · 把 `constraint-runtime` 全部文件搬进 Kernel · 一开始就删 Pi · 为"架构干净"重新实现已验收的支付 / 联系人 / Skill / Supervisor。

## 10. 最终完成定义

不是"Pi 文件被删除", 而是:

> Bolloon 的 CLI、Web、手机、P2P、Supervisor 和子 Agent 都通过 Native Kernel 执行; Channel 可并发隔离, ModelRuntime 可并发调用多供应商, Harness 是唯一系统调用门, Goal/Run 是唯一事实来源, Pi 可以被第二个推理适配器替换而不影响上层协议。

## 11. 诚实边界

- **崩溃域 = 全进程**: 宏内核固有代价, 靠"独立故障分类 + fail-closed"缓解, 不靠隔离消除。手机端/眼镜端是受限设备, 需要一个"瘦模式"内核剖面 (尚未设计)。
- **接口成本**: 冻接口一旦设计错, 是最贵的返工点 ⇒ **K2 之前不发 K3 的接口**。
- **不采信"已接线"**: 本页完成度只认真跑门的输出; 每阶段收尾必须给出「注入缺陷会红、拿掉环境会红」的证据。
- **与既有验收的关系**: **在其上加层** —— 保留模型侧 16/16 · 飞轮冻结门 34/34 · `pi-harness` 源码级断言。

## 12. K0 验收结果 (2026-10-02, 真跑证据)

**交付物** (提交 `26ffa6d`):

| 文件 | 作用 |
| --- | --- |
| `src/kernel/roster.ts` | 冻结面 (**数据, 零 import**): 8 层划分 · 五条禁令 +1 派生 · 欠账台账 · 行数预算。它自己就是 K1 的第一个样本 |
| `src/kernel/gate-scan.ts` | 判据 (**纯函数吃源码文本**): `scanKernelImports` / `scanProhibition` / `debtDiff` / `countCodeLines` |
| `src/test/kernel-boundary.test.ts` | K1 + K3 门 (12 条) |
| `src/test/kernel-authority.test.ts` | K2 门 (25 条) |

**真跑**: `npx vitest run src/test/kernel-boundary.test.ts src/test/kernel-authority.test.ts` → **37/37** · `npx tsc --noEmit` → **0 错** · 相邻面 (`pi-harness.test.ts` + `run-store.test.ts`) → **56/56** (未回归)。

**真盘变异 4/4 符合预期** (真实文件上注入 → 门红 → 逐字节还原 + sha256 核验):

| 变异 | 结果 |
| --- | --- |
| K1: `src/kernel/gate-scan.ts` 注入 `import { serve } from '../web/server.js'` | **判红** (4 failed) · 还原 sha256 相同 |
| K2: `src/web/i18n.ts` 注入 `setRunStatus('r1','running')` | **判红** (1 failed) · 还原 sha256 相同 |
| K3: `src/kernel/gate-scan.ts` 追加一行 | **判红** (2 failed) · 还原 sha256 相同 |
| **阴性对照**: 非 kernel 文件加一句无害注释 | **仍绿** (25/25) —— 证明门不是"任何改动都红" |

**K2 首次量出的真实事实** (这才是门的价值, 不是"它绿了"):

| 禁令 | 现状 |
| --- | --- |
| Model 不能直接执行 Tool | ✅ 0 违规 (`llm/**` 无到工具执行模块的 import) |
| Provider 不能直接写 Run | ✅ 0 违规 (唯一 `llm→state` 是 `model-selection.ts:1521` 的动态 import, 调 `readRun` **只读**, 源码注释写明「避免双向静态依赖」) |
| Tool 不能直接改权限 | ✅ 0 违规 (`tools→shell-guard` 3 处全是只读校验; `allowTool()/denyTool()` 0 处) |
| Channel 不能直接改 Goal | ⚠️ **1 处欠账**: `web/server.ts:3399` `setContinuation()` |
| Channel 不能直接写 Run (派生) | ⚠️ **3 处欠账**: `web/server.ts` `setRunStatus()` ×2 · `recordRecovery()` ×1 |
| 子 Agent 不能直接结束 Goal | ✅ 0 违规 (`runner-resolver.ts` 只 `readGoal`) |

**欠账台账 (棘轮)**: 3 条 / 4 处调用, 全部标明由 **K4** 还清; 条数冻结值 3, 只许减不许增。
**执行行为**: **一字未改** —— `grep` 证 `src/kernel/` 无任何业务模块引用 (K0 只立门, 不搬代码)。
