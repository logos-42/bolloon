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
| ① | Kernel 模块清单 | ✅ `plan.ts` **59 条 owner** 覆盖 **574 个产品码文件**(层划分在 `roster.ts`) |
| ② | 每个模块唯一 owner | ✅ 角色线 owner + disposition(keep/converge/freeze/…) + phase; 门判「每文件恰好命中一条」 |
| ③ | 入口调用关系图 | ✅ **9 行 / 27 调用点**(直调 24 · readline 3); 门重扫全仓 `prompt*(` 必须逐字相等 |
| ④ | 旧代码删除台账 | ✅ 8 字段格式门 + **第一批候选 96 条**用**集合 sha256** 冻结 (增/删/替换都判红) |
| ⑤ | Kernel import 白名单 | ✅ `KERNEL_ALLOWED_IMPORT_PREFIXES` + K1 门 |
| ⑥ | 模块越权检测 | ✅ K2 门 (五条禁令 +1 派生; 实测 4 处欠账) |
| ⑦ | Kernel 行数棘轮 | ✅ K3 门 (预算 450 / 冻结 450) |

⇒ **K0 = 7/7 完成** (2026-10-02 第三批, 提交见 §12; ②③④ 与它们的门 + 真盘变异 4/4 一起交付)。

### 7.2 阶段表 (修订编号)

| 阶段 | 内容 | 判据 / 完成标准 | 完成度 |
| --- | --- | --- | --- |
| **K0 冻结架构与删除台账** | 7 项交付物 (§7.1) | 能说清每段代码属哪个模块 · 能说清哪些准备删除 · **没有任何「以后再看」的核心事实来源** | ✅ **7/7** |
| **K1 清理 constraint-runtime** | 拆三层 `primitives` / `runtime-adapters` / `domain-libraries`; 按 5 步顺序删 (§7.3) | Kernel 只依赖 primitives · 领域能力**只能经 Tool Capability 接入** · archive/reference/test fixture 不进运行时包 · 无调用模块已移除 · 假连接/placeholder 已删 · 现有测试全绿 | 🟡 **①完成 · ②已开两刀 + 测试面接入** (删 35 文件/547 行, §14/§15/§16/§17); ③删 placeholder ④改 Tool Provider ⑤删旧导出 **未做** |
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

## 13. K0 第三批验收 (②③④ + 三道新门, 2026-10-02 真跑证据)

**交付物**: `src/kernel/plan.ts` (143 行, 台账数据) · `src/kernel/gate-scan.ts` 追加判据 · `src/test/kernel-plan.test.ts` (K4/K5/K6)。

**K0 ②③④ 的实际内容** (全部机械生成, 不手写):

| 交付物 | 内容 | 判据 |
| --- | --- | --- |
| ② 模块 owner | **59 条 owner** 覆盖 **574 个产品码文件** (最长前缀匹配; 角色线 owner + `disposition` ∈ keep/converge/migrate/freeze + `phase`) | 每文件**恰好**命中一条 · 键不重复 · 键在盘上真实存在(空承诺判红) |
| ③ 入口调用关系图 | **9 行 / 27 调用点**: 直调 24 (`web/server.ts` 11 · `index.ts` 8 · `runner-resolver.ts` 1 · `routes-tasks.ts` 1) + 适配器内部 3 (`pi-sdk.ts` pivot 分派) + readline 提示 3 (`cli/interface.ts`) | 门重扫全仓 `prompt*(` 的 (file,kind,method,count) 多重集必须**逐字相等** ⇒ 新旁路当场红 |
| ④ 删除台账 | 8 字段格式门 (`validateDeletionRecord`, `remainingRefs` 必须为 0) + **第一批候选 96 条** | 候选集用**集合 sha256** 冻结 (增/删/替换任一都判红); 目录分布同时冻结 |

**真跑**: 三门 **61/61** · `tsc --noEmit` 0 错 · **双档预算定点** (代码 585 / 台账 143, 各自 `= frozen`)。
**真盘变异 4/4 符合预期** (探针**先断言基线全绿**, 再逐例注入 → 红 → 逐字节还原 + sha256):

| 变异 | 结果 |
| --- | --- |
| K4: `plan.ts` 删掉 `llm/` owner 条目 | 判红 (K4 覆盖门报无归属) · 还原相同 |
| K5: `web/i18n.ts` 注入 `await agent.prompt('x')` | 判红 (入口图报新旁路) · 还原相同 |
| K6: 给候选文件注入副作用 `import './x.js'` | 判红 (候选集变 ⇒ sha 不等) · 还原相同 |
| **阴性对照**: 非 kernel 文件加无害注释 | **仍绿** · 还原相同 |

**过程中修掉的 2 个真缺陷 (探针/阴性对照照出来的)**:
1. **判据漏「副作用 import」** —— `import './x.js';` 既无 `from` 也无括号, 原先的说明符正则看不见它 ⇒ 入边少算 ⇒ **删除候选虚高**。已修 (`FROM_RE` 加第三分支) 并用一条专门用例锁住。修完重算: 候选集**未变** (该形态在相关文件里本就不存在), 但判据从此完整。
2. **我改了判据却没重设行数预算** —— 加完分支后 kernel 代码从 583 涨到 585, 而预算还冻结在 583 ⇒ 门红。**是"阴性对照必须先断言基线全绿"这一步把它照出来的** (我第一版探针没做基线断言, 差点把"本来就红"当成"变异后红")。已把基线断言写进探针, 并重设双档预算。

**顺带量出的事实 (交给 K1/第一批清理用)**: 96 个 0 入边候选里 **61 个在 `src/bollharness/`** —— 那是**另一个项目的镜像**(带自己的 `.boll/skills` 与 `scripts/checks/*`), 却住在 Bolloon 的 `src/` 里; 它是"第一批立即可清"的头号目标。

## 14. K1 第一批验收 (第①步: 统计真实 import + 三层分类, 2026-10-02 真跑证据)

**交付物**: `src/kernel/plan-constraint.ts` (三层名册 + 引用台账 + 欠账) · `src/kernel/gate-scan.ts` 追加 K1 判据 · `src/test/kernel-constraint.test.ts`。
**范围**: leo 的 5 步删除顺序里**只做完第 ① 步** (先统计真实 import)。②移除无调用 ③删假连接/placeholder ④领域模块改显式 Tool Provider ⑤删旧导出与兼容层 —— **都还没做**, 不许记成已完成。

### 14.1 真读出来的六条事实

| 事实 | 数字 |
| --- | --- |
| constraint-runtime **源码** | **94 文件 / 2492 行** —— A 原语 15 文件(401 行) · B 领域 24(797) · C 不进内核 55(1294) |
| **空壳** (≤20 行 `index.ts`) | **33 个 / 460 行** —— 移植留下的骨架, 第一批清理的直接对象 |
| ~~**构建产物混进源码树** `dist/` 被 commit~~ **← 这条我说错了 (§16.3 更正)** | `dist/` 其实被 `.gitignore` 忽略、**从未进 git**; 但它是**运行期必需**的 (内含 32 个快照 json, tsc 不复制) |
| **自带测试从来不跑** | `tests/` 4 文件 —— 仓里 vitest 配置把整个 constraint-runtime 目录 exclude 掉 |
| 主仓引用 | **30 点** (prod 19 / test 11) → 台账 **23 条** (prod 12 / test 11) |
| 集中度 | prod 引用只落在 **7 个目标**: 包入口 + PolymarketSDK 5 模块 + SafeSDK/deploySafe |

### 14.2 三道判据 (真跑 4 门 75/75 · tsc 0 错 · 真盘变异 4/4)

| 判据 | 现状 |
| --- | --- |
| **A 类必须可解释** | 15 条逐个写"接入说明": 5 条 `pkg-entry` (有引用者作证) · **5 条 `unused-debt`** (主仓 0 引用: execution_registry · tool_pool · cost_tracker · cost_hook · models) ⇒ 棘轮冻结, K1 复核后决定留/删 |
| **B 类只能经 Tool Capability** | ⚠️ **12 处直连欠账** —— `pi-sdk-tools.ts` 直接 import PolymarketSDK×5 + SafeSDK×1 (各 2 处), 全部登记, **K7 还清** |
| **C 类不许被 prod import** | ✅ **0 处** (立门防未来: 多一条就红) |
| 台账逐字相等 | 重算 30 点必须与台账双向相等 ⇒ 任何新引用点当场红 (扫描面排除名单冻结为 1 条: 本门自己的探针文件) |

### 14.3 本轮修掉的三个真缺陷 (都不是产品代码的错, 是门自己的)

1. **块注释里写 `**/` 会提前闭合注释** —— 我在 JSDoc 里写 vitest 的 glob 路径 `**/constraint-runtime/**`, 其中的 `*/` 把注释截断, 后半句变成**裸标识符** ⇒ `ReferenceError: constraint is not defined`。**tsc 不报**(语法上合法), 只有在 import 时才炸。路径 glob 尤其容易踩。
2. **判据的目标键与名册键扩展名不一致** —— 台账里 target 是模块名 (`tools/SafeSDK/deploySafe`), 名册键是文件路径 (`…/deploySafe.ts`) ⇒ 判据要三种写法都试, 否则 C 类越界会被误判成"未分类"。
3. **本门自己测试文件里的人造引用串被当成真引用** —— 判别力自证会往测试里写 `import '…/constraint-runtime/…'`, 引用台账一算就多一条 ⇒ 落成**冻结的排除名单**(只许 1 条)。这正是本仓那条老规矩: 拿子串当判据前先排除自己刚写的东西。

## 15. K1 第②步 (移除无调用模块) —— 核验**推翻了直觉排序**, 真删 2 项

### 15.1 核验结果: 我上一轮排的"第一批优先级" 4 项里错了 3 项

| 我上轮的排序 | 核验结论 | 依据 |
| --- | --- | --- |
| 1. `dist/` 89 个构建产物 (最低风险) | ❌ **不可删 —— 它才是运行期目标** | `pi-sdk-tools.ts` 动态 import `…/constraint-runtime/dist/tools/{PolymarketSDK/*,SafeSDK/deploySafe}.js` (6 处); `Dockerfile:167` 把 `src/constraint-runtime/dist` COPY 进 `node_modules/@bolloon/constraint-runtime/dist`; `CR/package.json` 的 `main`/`exports` = `dist/index.js`, `files=['dist/**/*']`。**源码树不是运行期目标** ⇒ 删 dist 直接断 B 类工具与包入口 |
| 2. 33 个"空壳" index.ts (460 行) | ❌ **它们不是空壳, 是"存档壳"** | 每个都 `import { loadArchiveMetadata }` 并读 `reference_data/subsystems/<name>.json` 快照 ⇒ 与 `_archive_helper.ts` / `reference_data/` 同生共死 |
| 3. C 类 placeholder (remote/ssh/teleport) | ❌ **可达包入口, 不是纯删** | `CR/src/index.ts:21-22` re-export `runParityAudit` / `runRemoteMode` / `runSshMode` / `runTeleportMode`, `dist/index.js` 有编译副本 ⇒ 删除必须**同时改 index.ts + 重建 dist** |
| 4. `src/bollharness/` (61 个 0 入边) | ❌ **是第三方 vendored 框架** | `scripts/gen-copyright-source.ts:25` 明写「版权属 bollharness contributors, 不进版权登记」; `scripts/smoke-esm.mjs:38` 引用 `dist/bollharness/...` ⇒ 处置要先定归属, 不是机械删 |
| — | ✅ **真正 0 引用的只有 2 个 15 行 stub** | `CR/src/migrations/` · `CR/src/remote/` |

**教训 (值得留档)**: 删除的难点不在"删", 在"删之前证明不欠别人"。我按"看着像构建垃圾 / 看着像空壳"排的序, 第 ① 步真读 import 之后 3 项全被推翻 —— 这正是 leo 把"先统计真实 import"放在 5 步里的第 1 位的原因。

### 15.2 真删 (第一刀)

| 目标 | 行数 | 引用 | 处置 |
| --- | --- | --- | --- |
| `src/constraint-runtime/src/migrations/` | 15 | 仓内 0 (含 CR 自身与 dist) · 不在 `CR/src/index.ts` 导出面 | ✅ 已删 |
| `src/constraint-runtime/src/remote/` | 15 | 同上 | ✅ 已删 |

8 字段删除记录写在 `src/kernel/plan.ts` 的 `DELETION_LEDGER` (target / oldEntry / replacement / remainingRefs=0 / runtimeHits=0 / acceptance / rollbackCommit / deletedAt)。

**删除后的真跑 (4 项)**:
1. `npx tsc --noEmit` ⇒ **0 错**;
2. 五道 kernel 门 `kernel-{deletion,constraint,plan,boundary,authority}` ⇒ **82/82**;
3. 引用 constraint-runtime 的两个主仓测试 (`wallet-polymarket-verify` / `econ-integration`) ⇒ **20/20**;
4. **运行期真跑**: `require('./src/constraint-runtime/dist/index.js')` ⇒ 加载成功, 25 个导出符号完好 (`runRemoteMode`/`runSshMode`/`runTeleportMode`/`runParityAudit` 都是 function) —— 证明删 CR **源码** stub 对运行期**零影响**。

### 15.3 新门: 删除就绪台账必须与盘上事实同步 (K1-d)

`src/kernel/plan-deletion.ts` 记 7 条 verdict + 引用证据; `src/test/kernel-deletion.test.ts` 按三种形状判红:

- `ready` ⇒ 目标在盘上**存在且 0 引用** —— 有引用就不许 ready;
- `blocked` ⇒ blocker 文件存在**且现在还真的提到这个目标** —— 借口过期就必须改判 ready;
- `done` ⇒ 目标不在盘上**且台账里有删除记录** —— 删了必须留账。

判据本身也修了一个缺陷: 对**目录目标**取 basename 没有判别力 (`src/constraint-runtime/src/` → `src`), 会让判据恒真 ⇒ 改成可显式给判别名 (`needle`)。另外证据面不能只有 `.ts` —— dist 的耦合证据在 `Dockerfile` / `package.json` 里。

## 16. K1 第②步批二 —— 可达性闭包 + 快照派发盲区, 删 33 个文件 (判错 4 次, 每次都抓住了)

### 16.1 换了个更有依据的工具: 从包入口算**可达闭包**

`入口闭包 = 30 / 88 个源文件` ⇒ 58 个不可达 (1310 行)。但"不可达"只是**第一道**筛子, 后面还压着三道:

| 筛子 | 剔除了什么 |
| --- | --- |
| ① 静态可达闭包 | 58 个不可达 |
| ② 主仓**精确深路径**引用 | 13 个 (PolymarketSDK 6 · SafeSDK/deploySafe · OpenCLI…) —— 主仓走 `constraint-runtime/dist/tools/...` 动态 import |
| ③ **`tools_snapshot.json` 的 208 条 source_hint** | **11 个** —— `tools.ts` 启动读快照 → `PORTED_TOOLS` (**实测 184 条**) → `executeToolFromSnapshot` 按 hint **数据驱动 import**。**静态分析完全看不见这条边** |
| ④ 编译期依赖 (`platform.d.ts`) | 1 个 —— 见 16.2 |
| ⇒ 真死代码 | **33 个 / 517 行** |

### 16.2 这一次判错的地方 (4 次, 每次都留下判据)

| 判错 | 怎么被抓出来 | 落成的判据 |
| --- | --- | --- |
| 把 `platform.d.ts` 当死代码删 | **CR `tsc` 报 TS7016** (它是 `declare module 'platform'` 环境声明: 没人 import, 但 `setup.ts` 靠它编译) | verdict 增加 `not-deletable` 类; 判据对 `.d.ts` **一律不判 ready** |
| 把 11 个 `tools/**` 当死代码 | 读 `tools_snapshot.json` 发现它们是**派发目标** | "快照点名"升为删除前必查项 |
| 上轮把 33 个存档壳叫"空壳可直删" | 它们引 `_archive_helper` → 读子系统快照 | 闭包分析取代形态判断 |
| **干净重建把 dist 的 32 个 json 抹了** | **包入口真跑打出 `Snapshot not found`** (`PORTED_TOOLS` 184→0, 只有一行 warn, **无报错**) | 新门 **K1-e** (见 16.4) |

### 16.3 更正 §14.1 的一处错误说法

我先前写「`dist/` 89 文件被 commit 进 src/」—— **错的**。`.gitignore:2` 就有 `dist/`, 它**从未进 git**。真相是:
`dist/` = 忽略的构建产物 **+ 运行期必需的 32 个快照 json** (`tools_snapshot` / `commands_snapshot` / `archive_surface_snapshot` / `subsystems/*.json`), 而 **CR 的 build 只有 `tsc` (不复制 .json)**。

### 16.4 新门 K1-e: dist 存在则必须完整 (抓"静默降级")

`dist/` 在 ⇒ 必须带 `reference_data/*.json` = **32** 个, 且源侧每个 json 在 dist 侧都存在。**真盘变异验证**: 挪走 `tools_snapshot.json` ⇒ 门红 (`expected 31 to be 32`); 还原 ⇒ 15/15 绿。
判据对"本地没有构建的干净克隆"不判 (不背别人的锅)。

### 16.5 本批真删 (33 个, 三组记录进 DELETION_LEDGER, 每条带逐个成员 `targets`)

| 组 | 内容 | 依据 |
| --- | --- | --- |
| 26 个移植存档壳 | `assistant/`…`voice/` 各 15 行, 自述 "Python placeholder package" | 闭包外 + 主仓 0 引用 + 快照 0 点名 |
| `_archive_helper.ts` | 只被上面 26 个调用 | 同上 |
| 6 个根级移植残留 | `cost_hook` / `execution_registry` / `ink` / `port_manifest` / `query` / `system_init` | 同上 |

**删除后真跑 (5 项)**: CR `tsc` 0 错 · 主仓 `tsc` 0 错 · 五道 kernel 门 **82/82** · 引用 CR 的两个主仓测试 **20/20** · **运行期真跑** 包入口 25 个导出完好 + `PORTED_TOOLS` 184 条。
**连带冻结量重算 (删除的连锁反应)**: CR 源码 92→**59** 文件 / 2460→**1925** 行 · A15/B24/C55 → **A13/B24/C22** · stub 31→5 · dist 计数改为 `.d.ts` 口径 54/783 · 双档预算 768/445。

### 16.6 还挡着的两条 (verdict = blocked, 各有真实 blocker)

- `CR/dist` —— 删它断 B 类工具与包入口 (`pi-sdk-tools` 动态 import + `Dockerfile:167` COPY + `main/exports` 指向它);
- `CR/src/reference_data/` —— 同目录混着**运行期派发台账** (`tools_snapshot.json`) ⇒ 不能整目录删; `subsystems/*.json` 在 26 个壳删掉后已成**孤立数据**, 要单独决定。

## 17. K1-f: 把「现有 constraint-runtime 测试继续全绿」从空话变成真门

### 17.1 发现: 那条验收标准当时是**空的**

K1 的完成标准写着「现有 constraint-runtime 测试继续全绿」。实测:
- CR 自带 **4 个测试 / 117 行**, 测的正是 **A 类原语** (`AgentCoordinator` / `ToolPermissionContext` / `BudgetTracker` / `SkillRegistry` / `DeepThinkingEngine`);
- 跑起来 **13/13 全绿, 393ms**;
- 但主仓 `vitest.config.ts` 里 `include` 只有 `src/test/**`, `exclude` 又有 `**/constraint-runtime/**` ⇒ **它们从来没有跑过**。

⇒ 一条"永远绿"的标准等于没有标准。**测试面为空就是拿不到事实**, 按本仓的规矩应当拒跑而不是默认通过。

### 17.2 处置: 接进默认套件 + 把这件事本身做成门

`vitest.config.ts`: `include` 加 `src/constraint-runtime/tests/**/*.test.ts`, 去掉整目录 exclude (保留 `**/dist/**`)。默认配置下实测 **4 files / 13 tests 绿**。

新门 **K1-f** (`kernel-constraint.test.ts`) 判三件事:
1. `include` 必须覆盖 CR 的测试;
2. `exclude` **不许**再把整个 `constraint-runtime` 排除掉;
3. 4 个测试文件 + 5 个被测源文件必须**真实存在** (空承诺判红)。

**真盘变异双验** (基线 84/84 绿):
| 变异 | 结果 |
| --- | --- |
| 把 `'**/constraint-runtime/**'` 加回 exclude | K1-f **红** ✓ |
| 把 include 里的 CR 测试glob 去掉 | K1-f **红** ✓ |
| 还原 | 16/16 绿 ✓ |

### 17.3 判据自己踩的坑 (本仓第三次同款)

K1-f 第一版**判据红了, 但红在错的原因上**: 它用 `not.toContain("'**/constraint-runtime/**'")` 读 `vitest.config.ts`, 而**我自己的注释里引用了这个被禁的串** ⇒ 判据把注释当成真配置。
修法落在判据里: **先剥注释再判** (`stripLineComment` 逐行映射; 注意它是**逐行**的, 传整文只会截到第一个 `//`)。
⇒ 这是同一个根因的第三次出现 (前两次: 本门测试里的人造引用串被当成真引用; 快照点名被静态分析漏掉)。**规矩**: 判据吃源码文本前先剥注释; 判据的范围里不能包含判据自己。
