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

## 7. 阶段台账 (K0–K10) — **2026-10-02 修订版**

> **修订说明 (leo 完整迁移计划)**: ① 「删除多余内容」升为**正式交付物**, 不是收尾顺手清理;
> ② K0 交付物由 3 项扩到 **7 项** (新增 每模块唯一 owner · 入口调用关系图 · 旧代码删除台账);
> ③ 原「入口收口与单循环」拆成 **K3 统一入口队列** 与 **K4 合并两套 loop** 两阶段
> ⇒ 自 K3 起编号顺延 (**Channel Actor = K5**)。先前记的「K0 ✅ 已完成」按旧定义, 已作废。

### 7.1 K0 交付物清单 (7 项; 缺项不许含糊)

| # | 交付物 | 状态 |
| --- | --- | --- |
| ① | Kernel 模块清单 | 🟡 部分 (8 层划分已入 `roster.ts`; 「每段代码属哪个模块」尚未逐文件覆盖) |
| ② | 每个模块唯一 owner | ❌ 缺 |
| ③ | 入口调用关系图 | ❌ 缺 |
| ④ | 旧代码删除台账 | ❌ 缺 |
| ⑤ | Kernel import 白名单 | ✅ `KERNEL_ALLOWED_IMPORT_PREFIXES` + K1 门 |
| ⑥ | 模块越权检测 | ✅ K2 门 (五条禁令 +1 派生; 实测 4 处欠账) |
| ⑦ | Kernel 行数棘轮 | ✅ K3 门 (预算 450 / 冻结 450) |

⇒ **K0 = 3/7 完成** (⑤⑥⑦)。按修订后的定义, K0 尚未结束。

### 7.2 阶段表 (修订编号)

| 阶段 | 内容 | 判据 / 完成标准 | 完成度 |
| --- | --- | --- | --- |
| **K0 冻结架构与删除台账** | 7 项交付物 (§7.1) | 能说清每段代码属哪个模块 · 能说清哪些准备删除 · **没有任何「以后再看」的核心事实来源** | 🟡 3/7 |
| **K1 清理 constraint-runtime** | 拆三层 `primitives` (Budget/Permission/Capability/Cancellation) / `runtime-adapters` (Session/Tool/Model) / `domain-libraries` (Wallet/Safe/Polymarket/Remote/OpenCLI); 按 5 步顺序删 (§7.3) | Kernel 只依赖 primitives · 领域能力**只能经 Tool Capability 接入** · archive/reference/test fixture 不进运行时包 · 无调用模块已移除 · 假连接/placeholder 已删 · 现有测试全绿 | ❌ 未开始 |
| **K2 Pi 可变状态外置** | message history / stream callback / signal / failed tool / channel identity / run identity / loop state → `RunContext` 或 `ChannelContext` | Pi 不持有 Goal·Run 状态/长期恢复/Channel 全局/Model 全局配置/Tool 权限; **完成此步后才允许删 Pi 对应字段与旧辅助方法** | ❌ 未开始 |
| **K3 统一所有入口队列** | 8 个入口 (Web/CLI/P2P/cron/followup/social heartbeat/supervisor/独立宿主) 只能投递事件: `External Event → ChannelMailbox.enqueue() → ChannelActor → Kernel Loop → Run/Goal/Evidence` | 同 Channel 只允许一个执行循环 · 不同 Channel 可并发 · **所有入口只能投递, 不能直接调 `prompt()`** · 外部事件不能直接改 Goal · CLI 与 Web 不各维护一套循环 | ❌ 未开始 |
| **K4 合并两套 Agent Loop** | `KernelLoop`: prepare → model call → harness tool call → checkpoint → reducer → continuation → finish; Pi 只做 `messages → model response`; Pivot/ReAct/旧 loop 降为策略或 Adapter | CLI/Web 同一任务产生一致的 Run/Goal 事实 · pause/SIGKILL/预算耗尽/模型切换行为一致 · 旧 loop 无任何入口引用 · 真跑长期任务通过后才删旧分支 | ❌ 未开始 |
| **K5 Channel Actor Runtime** | mailbox / session context / model binding / cancellation / outbound queue / heartbeat / backpressure / close-restart; **目标不是多线程, 而是隔离状态** | 16 channel 并发 · 同 channel 10 条消息不乱序 · Web/CLI/P2P 同输不串台 · 一个 channel 卡住不拖死其他 · 页面关闭后仍由 Supervisor 接管 | ❌ 未开始 (**K0 的 4 处欠账在此还清**) |
| **K6 ModelRuntime** | `acquire(modelSnapshot)` **只读**; 多供应商并发 · 连接池 · timeout · cancellation · 429 退避 · circuit breaker · capability 检查 · provider fallback · usage 记录; **已有的 `selectModel`/registry/catalog/Run snapshot 继续保留, 不重做** | 不自行改 provider 配置 · API key · 默认 URL · Global model · Run snapshot | ❌ 未开始 |
| **K7 Harness 唯一系统调用门** | `discover → permission → policy → budget → idempotency → execute → verify → evidence → event`; 覆盖 普通工具/MCP/Skill/delegate/子 Agent/联系人/支付/文件写入/外部通信 | **任何绕过 Harness 的代码都视为架构缺陷**; 工具旁路全删 | ❌ 未开始 |
| **K8 Communication Runtime 收口** | `transport → router → channel mailbox`; **绝不能** `transport → agent.promptStream()`; 统一 Web/CLI/P2P/手机/联系人回复/外部唤醒/cron/Supervisor 事件 | 通信层无直接 Agent 调用 · 无各通道自己的重试/任务恢复/outbound 状态 | ❌ 未开始 |
| **K9 第二个非 Pi Adapter** | 最小 Native Adapter: model call · tool call · stream · cancellation · checkpoint · finish; 必须通过与 Pi **完全相同**的五套验收 (Harness / Durable Run / Supervisor / CLI·Web 双面 / 多模型并发) | 两个 Adapter 都过 ⇒ 才证明 Kernel 真正独立 | ❌ 未开始 |
| **K10 删除 Pi 旧职责** | 8 步删除顺序 (§7.3); Pi 终态 ≈ prompt assembly + provider request + response parsing + stream translation | 迁移后 Pi 职责**仍超原来 30%** ⇒ 不许宣称替换成功 | ❌ 未开始 |

### 7.3 删除原则 (正式交付物)

| 类型 | 处理方式 |
| --- | --- |
| 核心事实来源 | 保留并收敛 |
| 新 Kernel 必须复用的能力 | 搬迁后**删除旧入口** |
| 暂时有用但不属于核心 | 冻结, 不继续扩展 |
| 无调用 / 重复 / 旁路实现 | 验证后删除 |

**五个删除条件 (缺一不许删)**: ① 有新的唯一替代路径 ② 全仓没有有效 import / 动态引用 / CLI·Web 路由引用
③ 真跑验证已覆盖旧路径对应能力 ④ 至少一次完整回归 + 一次故障恢复验证 ⑤ 留一个可回滚提交点 (不是丢弃历史)。
**不许以「看起来没用」作为删除依据。**

**删除记录 (每批必写, 8 字段)**: `删除对象` · `旧入口` · `替代入口` · `剩余引用` · `运行时命中次数` ·
`覆盖的验收` · `回滚提交` · `删除日期`。

**每批删除前后至少跑**: tsc · 相关聚焦测试 · 入口真跑 · Durable Run 真跑 · Supervisor 真跑 · Harness 真跑 ·
模型选择真跑 · CLI/Web 双面验证; **收尾再跑全量测试 + wiki 四门禁**。

**暂时不能删除 (最长板, 不是冗余复杂度)**: GoalStore · RunStore · PiHarness · ExecutionSupervisor ·
model-selection 协议 · transaction evidence · contact consent · durable recovery · provider registry · 既有验收脚本。

**三批删除顺序**:
- **第一批 (立即可清)**: 无 import 的依赖与模块 · 假连接/假成功的 remote runtime · 仅旧实验的 placeholder ·
  重复的配置读取 · 重复的模型 URL 解析 · 失效兼容字段 · 没有入口的 CLI 命令 · 只在旧文档存在的流程。
- **第二批 (完成队列后)**: 各入口直调 `prompt` 的路径 · 每个入口自己的 session 管理 · 重复的并发锁 ·
  Web/CLI 各自的 loop 分支 · P2P/cron/followup 的局部恢复逻辑。
- **第三批 (完成 Kernel 后)**: Pi 内部 Goal/Run 事实 · Pi 内部模型配置事实 · Pi 内部工具权限判断 ·
  Pi 内部长期任务调度 · Pi 内部通信发送逻辑。

**K1 的 5 步删除顺序**: ① 先统计真实 import ② 移除无调用模块 ③ 删除假连接/假成功/placeholder API
④ 把领域模块改成显式 Tool Provider ⑤ 最后删旧导出与兼容层。

**K10 的 8 步删除顺序**: ① Pi 的 Goal/Run 写入 ② Pi 的模型配置解析 ③ Pi 的 Channel 状态 ④ Pi 的通信入口
⑤ Pi 的旧工具 gate ⑥ 旧 loop ⑦ 兼容层 ⑧ 最后再决定是否删 Pi Adapter 本身。

**交付顺序** (不许跳): K0 → K1 → K2 → K3 → K4 → K5 → K6 → K7 → K8 → K9 → K10。

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

## 10. 最终完成标准 (6 条, 全部成立才算完成)

1. 所有入口只有**一条** Kernel 执行路径。
2. 同 Channel 不串台, 不同 Channel 可并发。
3. 多模型、多供应商可并发且**互不覆盖配置**。
4. 所有工具调用都经过 Harness。
5. Goal / Run / Evidence / Recovery **没有第二套事实来源**。
6. Pi 可以被 Native Adapter 替换而不修改业务层。

> 不是「Pi 文件删掉了」。**这次不做"大爆炸式换内核", 而做"以删除为结果的内核迁移"**
> (先删旁路 → 再删重复状态 → 最后删 Pi 的职责), 每一阶段都让代码更小、入口更少、性能更稳,
> 同时不牺牲 Bolloon 最核心的长期执行 / 受约束购买 / 真实执行 / 证据回放能力。

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

**欠账台账 (棘轮)**: 3 条 / 4 处调用, 全部标明由 **K5** 还清; 条数冻结值 3, 只许减不许增。
**执行行为**: **一字未改** —— `grep` 证 `src/kernel/` 无任何业务模块引用 (K0 只立门, 不搬代码)。
