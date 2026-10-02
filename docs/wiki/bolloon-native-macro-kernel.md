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

## 18. K2 门落地 (先落门再动代码) —— RunContext 状态外置

### 18.1 真读数 (2026-10-02, 剥注释后)

`agents/pi-sdk.ts` **4099 行**里, Pi 实例上挂着 **8 个可变运行状态字段 / 共 182 处 `this.` 访问**:

| 字段 | 声明行 | `this.` 访问 | 该搬进 RunContext 的哪个位置 |
| --- | --- | --- | --- |
| `messageHistory` | 272 | **53** | `history` |
| `currentRunId` | 471 | **36** | `runId` |
| `currentChannelId` | 458 | 21 | `channelId` |
| `currentAgentId` | 460 | 20 | `agentId` |
| `currentGoalId` | 1725 | 19 | `goalId` |
| `currentOnStream` | 442 | 15 | `eventSink` |
| `currentIntent` | 463 | 10 | `intent` |
| `currentSignal` | 443 | 8 | `abortSignal` |

**症结**: `runReActLoop(onStream?, signal?)` (`pi-sdk.ts:1923`) 只收 2 个参数, 却隐式依赖上面 8 个字段 ⇒ 两个 Run 只要共用实例就必然互相污染 (这正是 K2 要拆的东西)。目标签名: `runReActLoop(ctx: RunContext)`。

### 18.2 门的三条口径 (`src/test/kernel-runcontext.test.ts`, 6 道门合计 91/91 绿)

1. **逐字段计数必须与冻结值双向相等** —— 多一处 = 新增泄漏; 少一处 = 改了代码没改账 ⇒ 必须**显式 rebase 台账** (迁移必须是看得见的动作);
2. **`migrated: true` 的字段访问必须为 0** —— 假完成判红;
3. **每个字段都要有 RunContext 落点** —— 不然"外置"没有落点。

**RunContext 目标清单** = leo 点名的 11 项 + **`intent`** (我自己加的: `currentIntent` 也得有家, 否则第 ③ 条判红 —— 这是对 leo 清单的一处补充, 已记录)。

**判别力自证 (4 种坏形状)** + **真盘变异 (2 例)**: 基线绿 → 往 `pi-sdk.ts` 真加一处 `this.currentRunId` / `this.messageHistory` 访问 ⇒ 各自判红 (`runcontext-access-drift`) → **逐字节还原** (sha256 相同) → 绿。

### 18.3 台账 (逐字段一条, 全部 `migrated: false` —— K2 尚未开工)

`src/kernel/plan-runcontext.ts`: 8 条 `RunStateField` (name / declaredAt / accesses / into / migrated / payDownIn) + `RUN_CONTEXT_TARGET` (12 项) + `RUN_CONTEXT_ACCESS_TOTAL = 182` + 循环入口登记 (`pi-sdk.ts:1923` 现状签名与目标签名)。

**下一步 (K2 主体)**: 先挑**面最小的一个字段做样例迁移** (`currentOnStream` 15 处 → `ctx.eventSink`), 走通"迁移一格 ⇒ 台账降一格 ⇒ 门保持绿"的流程, 再推进其余 7 个。

### 18.4 一处自效果 (记下来免得下次惊讶)

每加一个台账文件, **K6 删除候选就多一条** (`plan-runcontext.ts` 是新的 0 入边产物 ⇒ 候选 98→99)。台账文件在"谁 import 它"这件事上天然是孤岛 —— 判据按 0 入边算候选时, **台账/名册类文件要靠 OWNER 名册豁免**, 不能真当删除对象。

## 19. K2 第一格状态迁移: `currentOnStream` → `RunContext.eventSink` (已落地)

### 19.1 做了什么

1. 新模块 `src/agents/run-context.ts`: `RunContext` 接口 (leo 的 11 项 + `intent`) + `createRunContext()` 工厂 (**未给的字段一律显式置空, 不继承上一个 Run 的残留**)。
2. `pi-sdk.ts`: 删掉实例字段 `currentOnStream`, 改挂 `private runCtx: RunContext`; **15 处 `this.currentOnStream` 全部改为 `this.runCtx.eventSink`**; 两个入口 (`promptStream` / `promptWithPivotLoop`) 改用 `createRunContext({ eventSink })` 建立本轮 Context; 5 个清空点改成「换一个空 Context」。
3. 台账下调: `currentOnStream` 15 → **0**, `migrated: true`; `RUN_CONTEXT_ACCESS_TOTAL` 182 → **167**; 新增 `RUN_CONTEXT_MIGRATED_FROZEN = 1` + `RUN_CONTEXT_DONE` 清单; 测试里的「K2 尚未开工」断言改成**棘轮** (已迁移字段数 == 冻结值, 且与 DONE 清单一致, 未搬的字段不许被标成已搬)。

### 19.2 这一刀被自己的判据拦了一次 (值得记)

我第一版在入口用「快照式」把 6 个**尚未迁移**的字段也抄进 Context (`channelId: this.currentChannelId` …) —— 结果 6 个字段各 +2 处读, 总量从 182 只降到 178。
这违反了 leo 定的方向判据: **「新层出现后, 旧写口的调用点数只许不变或减少」**。改成只搬 `eventSink` 之后:

| | 迁移前 | 迁移后 |
| --- | --- | --- |
| `currentOnStream` | 15 | **0** |
| 其余 7 个字段 | 167 | **167 (一处没动)** |
| 合计 | 182 | **167 (纯减)** |

`currentSignal` 也顺手削掉了一处 (`createRunContext({ abortSignal: this.currentSignal })` 这个读也算新增) —— 这一刀必须**纯减**, 一个"过渡期读数装置"都不许留。

### 19.3 验证 (真跑)

- `npx tsc --noEmit` ⇒ **0 错**;
- 6 道 kernel 门 ⇒ **91/91**;
- 覆盖 stream / loop / persistence 的 6 个测试文件 (`react-loop` · `persistence-e2e-flow` · `session-resume-e2e` · `web-server-session` · `parse-tool-call-loop` · `pi-sdk`) ⇒ **87/87**;
- 端到端消融 `npx tsx scripts/ablation/run.ts` ⇒ **15/16**; 唯一失败的 `[C2] 搜索 prompt × 3 次` **在把 pi-sdk.ts 换回 HEAD 的基线对照下同样失败** (answerRate 2/3 vs 我的 1/3) ⇒ **与本次迁移无关** (LLM 冷启动波动), 不算回归。

### 19.4 下一格

按面从小到大: `currentSignal` (8) → `currentIntent` (10) → `currentGoalId` (19) → `currentAgentId` (20) → `currentChannelId` (21) → `currentRunId` (36) → `messageHistory` (53)。每格都要: 迁移 ⇒ 台账下调 ⇒ 门保持绿 ⇒ 真跑一次。
`currentSignal` 那格会引入一个新问题: 它是 `AbortSignal`, 迁移后 `ctx.abortSignal` 才是唯一出处, 取消语义要跟上 (`RunContext` 里的取消位)。

## 20. K2 第 2 格: `currentSignal` → `RunContext.abortSignal` (已落地)

### 20.1 迁移 (8 处 → 0)

| 原处 | 处置 |
| --- | --- |
| `promptStream` 入口 `this.currentSignal = options?.signal ?? null;` | **删除** —— Context 已经在同一行建好 (`createRunContext({ eventSink, abortSignal })`) |
| `promptWithPivotLoop` 入口 `this.currentSignal = signal ?? null;` | **折进 Context** (`createRunContext({ eventSink: onStream, abortSignal: signal ?? null })`) |
| 5 个「用完即清」点的 `this.currentSignal = null;` | **删除** —— 复位改成「换一个空 Context」(`createRunContext()` 的 abortSignal 本来就是 null) |
| pivot `loop.execute(..., this.currentSignal ?? undefined, ...)` | 改读 **`this.runCtx.abortSignal ?? undefined`** |

台账: `currentSignal` 8 → **0** (`migrated: true`) · `RUN_CONTEXT_ACCESS_TOTAL` 167 → **159** · `MIGRATED_FROZEN` 1 → **2** · `DONE` 清单加 `currentSignal`。
**其余 6 个字段一处没动** (messageHistory 53 / currentRunId 36 / currentChannelId 21 / currentAgentId 20 / currentGoalId 19 / currentIntent 10) —— 仍然是纯减。

### 20.2 补了一个**此前不存在的**测试: `pi-run-context-wiring.test.ts` (8 用例)

为什么必须补: 取消/推流这两个语义原来靠实例字段**隐式**共享给两个循环, 搬进 Context 后**漏接一处不会编译报错, 症状只会是"取消不生效 / 流断在半路"**; 而仓里此前**没有任何测试覆盖 `promptStream` 的取消语义** (`pi-sdk.test.ts` 里那个 AbortController 自己标注为"装饰性")。

判据 (源码级 + 单元级, **剥注释**):
1. 已迁移字段不许再以 `private <field>:` 形式出现;
2. 两个入口必须把 `eventSink` / `abortSignal` 建进 Context;
3. 两个循环必须从 Context 取值 (`this.runCtx.eventSink` / `this.runCtx.abortSignal`);
4. 已迁移字段不许再有 `this.<field>` 访问;
5. 「用完即清」必须是"换空 Context" (`createRunContext()` 复位 ≥5 处);
6. 单元: `createRunContext` 未给字段**显式置空** (不继承上一个 Run 的残留) + `AbortSignal` 语义真的透传 (abort 后 `ctx.abortSignal.aborted === true`)。

**变异自证 3 例** (内存里改源码文本, 不动盘): ① 把 `private currentSignal` 注回 ⇒ 红; ② 入口漏建 `abortSignal` ⇒ 红; ③ 循环改回读 `this.currentSignal` ⇒ 红; ④ 注释里提到旧字段名 ⇒ **不红** (剥注释)。

### 20.3 下一格

`currentIntent` (10) → `currentGoalId` (19) → `currentAgentId` (20) → `currentChannelId` (21) → `currentRunId` (36) → `messageHistory` (53)。
`messageHistory` 那格是真正的大头 (53 处), 也是"两个并发 Run 的 history 不互相污染"这条 K2 验收标准的落点。

## 21. K2 第 3 格: `currentIntent` → `RunContext.intent` (已落地)

### 21.1 迁移 (10 处 → 0)

`RunContext.intent` 用**联合类型** `RunIntent` (`question | code_edit | multi_step | chitchat | document`) —— 与旧实例字段的字面量集合一致, 不然 `!== 'chitchat'` 这类比较会失去类型约束。
工厂默认 `'chitchat'`: 它是**中性默认值** (与旧字段初值相同), 不是"继承上一个 Run 的残留"。

台账: `currentIntent` 10 → **0** (`migrated`) · `RUN_CONTEXT_ACCESS_TOTAL` 159 → **149** · `MIGRATED_FROZEN` 2 → **3** · `DONE` += `currentIntent`。其余 5 个字段一处没动。

### 21.2 迁移途中抓到的两个真陷阱 (都靠"数一数"抓出来)

1. **前缀误伤**: `this.currentIntent` 是 `this.currentIntentHint` 的**前缀** —— 机械改名把 7 处 `currentIntentHint` 也改成了 `this.runCtx.intentHint` (那个字段**不在**迁移名单里, 应该留在实例上)。
   **抓法**: 改名处数 (17) ≠ 台账冻结值 (10) ⇒ 立刻回查。判据: **改名数必须等于台账数**, 不等就是误伤或漏改。
2. **顺序陷阱 (差点成真)**: `prompt()` 里 `finally` 有一处「换空 Context」复位 —— 如果它落在 `runReActLoop(this.runCtx.eventSink …)` **之前**, 推流会被静默切断 (UI 表现为"没有回复")。
   逐行核对后确认: 那次复位在 **pivot 分支的 `finally`** 里, 而该分支先 `return` 了 ⇒ 非 pivot 路径不会经过它 ✓。
   顺带确认一个**刻意保留的原有怪癖**: `prompt()` 调 `promptWithPivotLoop(input, undefined, …)` 不传 onStream ⇒ pivot 路径的 eventSink 为 null —— 旧代码同样把 `currentOnStream` 覆盖成 null, 所以**行为等价**, 不是回归。
   **没有**在 `promptWithPivotLoop` 入口重建 Context: 它在被 `prompt()`/`promptStream()` 调用时会冲掉刚建好的 eventSink/abortSignal (真回归); 而它被直接调用 (测试) 时, `this.runCtx` 正好是"上一轮清空后的空 Context", 与旧代码 `currentOnStream=null` 的状态等价。

### 21.3 验证

`tsc --noEmit` 0 错 · **7 道门 99/99** (接线门自动覆盖新字段 —— 它的"已迁移字段不许有 `this.<field>` 访问"是遍历 `RUN_CONTEXT_DONE` 的, 加一个字段就多一条检查) · `workflow-pivot-loop` + `pi-sdk` + `react-loop` **62/62**。

### 21.4 下一格

`currentGoalId` (19) → `currentAgentId` (20) → `currentChannelId` (21) → `currentRunId` (36) → `messageHistory` (53)。
最后两格是硬骨头: `currentRunId` 要接 Run 生命周期 (落盘/恢复), `messageHistory` 是 K2 验收标准「两个并发 Run 的 history 不互相污染」的落点。

## 22. K2 第 4 格: `currentGoalId` —— **改判, 不搬** (台账第一次拒绝迁移)

### 22.1 证据 (2026-10-02 真读 `pi-sdk.ts`)

| 面 | 事实 |
| --- | --- |
| 写入口① | `setGoalId(goalId)` (行 1747) —— **公开 API**, CLI/Web/runner 在 run **之前**注入 ("有 goalId 就在该 Goal 下执行") |
| 写入口② | run 内部 (行 2024 / 1091): 未绑定时 `findActiveGoal` 或 `createGoal`, 然后 `startRun({ goalId })` —— **run 会写它, 且必须活到下一个 run** |
| 读出口 | harness 上下文 (1914) · 轨迹/报告 (2866 / 2995 / 3006 / 3023) · `bindExternalWait` (1804-1806) |
| 另有 | 1081/1091 · 2003/2024 的「暂存-重绑-还原」模式 (跨块共享) |

**⇒ 它是会话级绑定 (跨 Run 存活), 不是"每轮 Run 状态"。**

### 22.2 为什么"入口 copy 一份进 Context"是错的

run 内的写会落进 **per-run** Context ⇒ 会话字段不被更新 ⇒ **下一个 run 走"未绑定 ⇒ 重新 `findActiveGoal`"分支** ⇒ 行为改变 (旧行为是复用同一绑定)。
⇒ 它该收进的是**会话/通道级持有者** (K5 Channel Actor 的 actor 状态), 不是 RunContext。**K2 不碰它。**

### 22.3 落成的东西

1. **台账加 `scope` 栏** (`'run' | 'session'`): 7 个 `run` 级 = K2 的外置面; 1 个 `session` 级 (`currentGoalId`, 19 处访问, **不迁移**)。
   `RUN_CONTEXT_RUN_SCOPED = 7` + `RUN_CONTEXT_SESSION_SCOPED_NOTE` (写清证据与"为什么不能搬")。
2. **双向规则** (两条镜像, 各配判据):
   - 已迁移字段 ⇒ **不许**再以实例字段形式存在, 且 `this.<field>` 访问必须为 0 (旧规则);
   - session 级字段 ⇒ **必须仍是实例字段**, 且不许出现在 `DONE` 清单里 (新规则)。
3. 判据: `kernel-runcontext.test.ts` + `pi-run-context-wiring.test.ts` 各加一条 (共 **17/17** 绿); `tsc` 0 错。

**这一格的价值**: 台账第一次**拒绝**迁移, 而不是硬搬。冻结值 (19) 保持不变 —— 它不是"没迁完", 是"不该迁"。

## 23. K2 第 5~8 格一次定性: **K2 的 per-run 外置面只有 3 个字段, 且已 100% 完成**

### 23.1 逐字段按**写入点**定性 (不看名字, 看谁写/何时写)

| 字段 | 访问 | 写入点证据 | 判定 |
| --- | --- | --- | --- |
| `messageHistory` | 53 | 3 个写入点**全是整体替换**: hydrate(680) / compact(3243) / 真破坏性更新(3445) | **session 级** —— 它就是"会话记忆"本身, 跨 Run 累积 |
| `currentRunId` | 36 | 1989 行在 resume 里 `= this.resumeRunId` **然后才调 prompt**; 2036 在 run 内; 3034/3038 清空 | **run-boundary** —— 属 Run, 但值在入口**之前**就设好 |
| `currentChannelId` | 21 | 4 个写入点全是 `= channelId ?? this.currentChannelId` —— **显式保留**上一轮的值; 3895 直设 | **session 级** —— 设计上就跨 Run 存活 |
| `currentAgentId` | 20 | **只有 1 个**: 构造函数 547 行 `= config.agentId` (createAgentSession 注入) | **session 级** —— 会话创建时定 |
| `currentGoalId` | 19 | §22 已定性 | **session 级** |
| `currentOnStream` / `currentSignal` / `currentIntent` | 0 / 0 / 0 | — | **run 级 · 已迁移** |

⇒ **K2 的 per-run 外置面 = 3 个字段 (`eventSink` / `abortSignal` / `intent`), 全部已迁移**
   (`RUN_CONTEXT_RUN_SCOPED = 3` == `RUN_CONTEXT_DONE.length`, 由门强制相等)。
   累计: `this.` 访问 **182 → 149**; 其余 5 个字段**一处没动** (不是"没迁完", 是"不该迁")。

### 23.2 三条连带结论 (都需要 leo 的意图层确认)

1. **`currentRunId` 是 `run-boundary`**: 迁它需要在入口**显式播种** (`createRunContext({ runId: this.currentRunId })`), 这**会新增对旧实例字段的读** ⇒ 与「只许不变或减少」判据冲突。它必须作为**独立一格**记账并说明理由, 不能混进"纯减"里。
2. **4 个 session 级字段该归 K5 Channel Actor 的 actor 状态**, 不是 RunContext。硬搬会改行为 (goalId 那格已证: run 内的写会落进 per-run Context ⇒ 会话绑定不更新 ⇒ 下一轮重新 `findActiveGoal`)。
3. **「两个并发 Run 的 history 不互相污染」这条 K2 验收标准, K2 达不成** —— `messageHistory` 是**会话记忆**, 共享是它的本质; 要"不互相污染"必须让**每个 channel 有自己的会话/history** (K5 Channel Actor), 或让每个 Run 在不可变基准上各写各自分支。**建议把这条验收标准的落点改判到 K5**, K2 保留的是"循环只吃显式 Context"这半条 (已由 3 个字段 + 接线门兑现)。

### 23.3 门 (K2 收口的三条)

1. `scope` 只能是 `run` / `run-boundary` / `session`;
2. **`run` 级必须全部已迁移** (`runScoped.filter(!migrated) === []` 且 `runScoped.length === DONE.length`) ⇒ 这条一绿 = K2 外置面收工;
3. **`session` / `run-boundary` 一律不许标 `migrated`**, 且 `session` 级必须**仍是实例字段** (镜像规则, 在接线门里判)。

`tsc` 0 错 · **7 道门 101/101**。

## 24. K2 收尾 (leo 2026-10-02 口径固化) —— 外置面 100% 完成, 不再搬字段

### 24.1 口径原文落地

| 口径 | 落地物 |
| --- | --- |
| ① 允许**一次入口播种读取** | `PiAgentSession.seedRunContext()` —— **唯一一处** `createRunContext({ runId: this.currentRunId, ...extra })`; 两个入口 (`prompt` / `promptStream`) 调它; 5 个复位点仍是**纯清空** (`createRunContext()`, 不携带身份) |
| ② 单独记账 | `CURRENT_RUN_ID_SEED_READS = 1` · `CURRENT_RUN_ID_SEED_SITES = 2` · `CURRENT_RUN_ID_SEED_NOTE` |
| ③ 不得混进"必须下降"的统计 | 台账 `currentRunId.accesses = 38 = 37(历史) + 1(播种)`, 并在注释里写明**净变化拆解** |
| ④ 4 个 session 字段归 Channel Actor | 台账 `scope: 'session'` ×4 + `RUN_CONTEXT_REMAINING_NOTE` |
| ⑤ K2/K5 验收标准重划 | `K2_ACCEPTANCE` (7 条) · `K5_ACCEPTANCE` (6 条) · `K2_PROGRESS = { runContextExternalized: '100%', sessionActorization: '未开始' }` |

**每一条都由门强制** (新增 `scanRunIdSeed`, 4 条规则 + 4 个变异用例):
1. `currentRunId` 总访问 == 冻结 38 ⇒ **循环内不得新增读取点** (任何新读取点都让总数变);
2. 播种读取**恰好 1 处且只在 `seedRunContext` 体内**;
3. 调用播种的入口**恰好 2 处**;
4. 复位点**不得**带播种。

### 24.2 这一格踩的两个坑 (都是"记账口径"类, 值得留档)

1. **`open(G,"w").write(open(G).read()…)` 把我自己的 judge 文件截断** —— `open(G,"w")` 先截断, 再读就是空 ⇒ `gate-scan.ts` 掉了 538 行。这是**同一坑第二次** (§16.3 记过一次)。修法: 先读进变量再写。恢复靠 git + 重新正确追加。
2. **两个判据用了两种计数口径** —— 逐字段判据按**行数** (`if (rx.test(line)) actual += 1`), 新播种判据按**匹配次数** ⇒ 同一台账在"一行含两处"(1916 行)处给出 37 / 38 两个答案。
   修法: **统一为匹配次数**, 并**整体重算**逐字段冻结值。⇒ 由此暴露一条必须写清的账: session 级那几个字段"变大"**不是新增泄漏, 是换口径**:

   | 字段 | 行数口径(旧) | 匹配口径(现) |
   | --- | --- | --- |
   | `messageHistory` | 53 | **56** |
   | `currentChannelId` | 21 | **24** |
   | `currentGoalId` | 19 | **22** |
   | `currentAgentId` | 20 | **21** |
   | `currentRunId` | 36 (+1 播种) | **38** |

   **同口径的迁移前/后**: `04f64fb`(K2 第一次迁移之前) **193** → 现在 **161** (净 **-32**) = 三个 run 级字段 **-33** (15+8+10) **+ 播种 +1**。

### 24.3 K2 完成定义 (正式口径)

> **所有真正 run-scoped 的状态都进入 RunContext; session 状态和 run-boundary 状态不被错误搬迁。**

```text
K2 RunContext 外置面：100%   (eventSink ✅ · abortSignal ✅ · intent ✅ · currentRunId ✅ 入口播种)
K2 Session Actor 化：未开始  (messageHistory / channelId / agentId / goalId ⏭ K5)
```

**这两个百分比不许合并** —— 合并就会把"外置面完成"读成"K2 完成", 而 K5 那半还没开始。

### 24.4 交给 K5 的清单 (从 K2 移出)

验收标准 (6 条): 同 Channel 串行 (排队, 不并发改 history) · 不同 Channel history 完全隔离 · 同 Channel 多 Run 不互相污染 · 页面/CLI/P2P/Supervisor 进同一 mailbox · Actor 崩溃可由 Supervisor 恢复 · `messageHistory` 不再由 Pi 拥有。

Actor 状态容器 (9 项): `channelId` · `agentId` · `goalBinding` · `messageHistory` · `mailbox` · `activeRun` · `cancellation` · `outbound stream` (+ 串行执行锁)。

迁移步骤 (8 步, leo 定): 建 Actor 状态容器 → `messageHistory` 的 hydrate/compact/append/persist 入 Actor → `channelId/agentId/goalId` 入 Actor → 所有入口改投递消息 → 每 Channel 串行锁 → `currentRunId` 改 Actor `activeRun`/ExecutionFrame → Pi 只接一次性 `ExecutionRequest` → 删除 Pi 中对应字段。

**删除旧字段的前置条件 (7 条, 全满足才删)**: Pi 不再拥有 session 状态 · 所有入口经 Channel Actor · 同 Channel 串行/跨 Channel 并发**真跑通过** · 重启后 history/Goal/Run 仍能恢复 · `currentRunId` 不再由 Pi 播种 · Pi 的字段访问只剩推理所需临时变量 · 旧字段**零引用门禁通过**。

## 25. K5 第 1 步: Channel Actor 台账与门 (先落门, 容器未建)

### 25.1 落地物

`src/kernel/plan-channel-actor.ts` (85 行) + `src/test/kernel-channel-actor.test.ts` (门, 9 用例):

| 台账内容 | 条数 |
| --- | --- |
| **Actor 状态项** | **9** (`channelId` · `agentId` · `goalBinding` · `messageHistory` · `mailbox` · `activeRun` · `cancellation` · `outboundStream` · `serialLock`) —— 每项带"为什么"与 owner |
| **验收标准** | **6** (同 Channel 串行 / 跨 Channel 隔离 / 同 Channel 多 Run 不污染 / 四入口进同一 mailbox / Actor 崩溃可恢复 / `messageHistory` 不再由 Pi 拥有) |
| **迁移步骤** | **8** (容器 → history 的 hydrate/compact/append/persist → 三个会话字段 → 入口投递 → 串行锁 → `activeRun` → Pi 只收 `ExecutionRequest` → 删字段) |
| **删除前置** | **7** (Pi 不再拥有 session 状态 / 入口全经 Actor / 串行与跨 Channel 并发**真跑通过** / 重启后仍能恢复 / `currentRunId` 不再由 Pi 播种 / Pi 只剩推理临时变量 / 旧字段零引用门禁通过) |
| **从 K2 移交的字段** | **4** (`messageHistory` 56 · `currentChannelId` 24 · `currentAgentId` 21 · `currentGoalId` 22, match 口径) |
| **进度位** | `stage: 'not-started'` · `containerPath` · `fieldsMigrated 0/4` · `entriesWired 0/4` |

### 25.2 门的三条硬要求 (本步重点)

1. **完整性**: 9 状态项 (名字唯一 · 每项非空) · 验收 ≥6 · 步骤 =8 · 前置 =7 · 验收里**真接住了**从 K2 移来的「history 不互相污染」;
2. **与盘上事实同步**: 标 `not-started` ⇒ 容器文件**必须真的不存在**; 反过来标了进度就必须有文件 (**真读盘核对**, 不是自说自话);
3. **跨台账一致**: 移交的 4 个字段访问数必须与 K2 台账 (session 级) **逐字相等**, 数量也要一致 (4==4)。
   ⇒ 两个台账各说各话会立刻判红。**5 个判别力用例 + 1 个变异用例**。

### 25.3 顺带解掉一个循环 (豁免规则)

每加一个台账文件, K6 删除候选集就变一次 (已因此被迫改过三次 sha: `plan-deletion` / `plan-runcontext` / `plan-channel-actor`)。根因: 台账/名册在"0 入边"口径下**天然是孤岛**。
⇒ 落成规则: **`kernel/roster.ts` 与 `kernel/plan*.ts` 一律不算删除候选** (`LEDGER_SELF_EXEMPT`)。删除台账不是"删死代码", 走它自己的 8 字段记录流程。重算后候选 **100 → 95**。

### 25.4 一条测试卫生教训

K5 的变异用例原本在 `src/kernel/` 里**真建文件再删** —— 8 个测试文件并行跑时, 别的 worker 正在扫同一目录 ⇒ **采集期竞态** (表现为 `kernel-constraint.test.ts` 的并行假红; 单跑 16/16 绿)。
⇒ 规矩: **测试不许在被并行扫描的源码目录里做文件系统变异**。判据是纯函数, `exists` 就是它设计好的接缝 —— 注入即可; 盘上事实由另一条只读断言保证 (容器真的不存在)。

## 26. K5 第 2 步: Actor 容器落地 (纯新增 · 行为零改变 · 串行真跑)

### 26.1 交付物 `src/kernel/channel-actor.ts` (133 行)

| 部件 | 内容 |
| --- | --- |
| `ActorState` | 9 项与台账逐条对应: `channelId` · `agentId` · `goalBinding` · `messageHistory` · `mailbox` · `activeRun` · `cancellation` · `outboundStream` (**`serialLock` 由 `SerialMailbox` 承担**) |
| `createActorState()` | 未给的字段**显式置空** (镜像 K2 的「不继承残留」规矩) |
| `SerialMailbox` | **同 Channel 串行邮箱**: `submit()` 立即返回 promise 但**排队执行**; 队列尾巴吞掉错误 ⇒ **一个任务抛错不毒化后续任务**; `pending`/`processed` 可观测; `drain()` 等空 |
| `ChannelActor` | `state` + `mailbox` 绑定; `submit(fn)` 串行执行; `beginCancellation()/abort()` 取代 Pi 上的 `currentSignal` |
| `ExecutionRequest` | K5 第 7 步的目标形态: Pi 只接收**一次性**请求 (`input`/`channelId`/`agentId?`/`goalId?`/`resumeRunId?`/`signal?`) |

**行为零改变**: 目前**没有任何入口往里投递** —— 现有链路仍走 Pi 实例字段。容器只是先把"归宿"落实。

### 26.2 真跑验证 (不是"看起来对")

`kernel-channel-actor.test.ts` 13 用例 (其中 6 条是本步新增):

| 用例 | 断言 |
| --- | --- |
| **串行语义** | 入队 a(30ms)/b(10ms)/c(1ms) —— 后入队者更短, **若并发必交错**; 实测执行序 `a:start a:end b:start b:end c:start c:end`, 结果 `['a','b','c']`, `pending=0 · processed=3` |
| **抛错不阻塞** | 先 bad(throw)后 good(42): `bad` 以 `boom` reject · `good` 正常返回 42 · 队列跑空 |
| **跨 Actor 隔离** | 两个 channel 各 push 自己的 history ⇒ 互不可见, `channelId` 不同 |
| **取消位** | `beginCancellation()` → `aborted=false`; `abort()` → `aborted=true` 且 `cancellation=null` |
| **容器语义** | 未给字段显式置空 (8 个字段逐个断言) |

### 26.3 台账前进 + 两条判据同步更新

`stage: 'not-started' → 'container-built'` (附进度历史与"这一步交付了什么"), 门的"与盘上事实同步"因此翻面: 现在要求 **容器必须真的存在**, 且 `fieldsMigrated/entriesWired` **必须仍是 0** (容器建了 ≠ 字段迁了 / 入口接了)。
两个变异用例随之换方向 (镜像): ① 标 `not-started` 而容器存在 ⇒ 红; ② 标 `container-built` 而盘上没有 ⇒ 红。

## 27. K5 第 3 步: Actor 注册表 + 会话工厂绑定 (一个 channel 一个 actor 成立)

### 27.1 为什么先做这一步

第 2 步只落了「容器类」, 但**没有落点**: `messageHistory` 要迁入 Actor, 前提是**每个 channel 有自己的 actor**。「history 存哪」必须先有答案, 否则第 4 步 (迁 history) 无处可迁。

### 27.2 交付物

| 位置 | 内容 |
| --- | --- |
| `src/kernel/channel-actor.ts` | **注册表**: `getOrCreateActor(channelId, init?)` · `peekActor` · `actorCount` · `resetActors` (测试用)。**幂等**: 同 channelId 永远同一个实例; `init` **只在新建时生效** (既有 actor 不被后来的 init 覆盖 —— 防止「后到的调用冲掉先建会话的状态」); 空 channelId 落 `default` 桶 |
| `src/agents/pi-sdk-types.ts` | `AgentSession.actor?: ChannelActor` (契约里的一等字段, 免得工厂里做 `any` 转换) |
| `src/agents/pi-sdk.ts` | `PiAgentSession.actor?: ChannelActor` —— 注释明写**现在只做归属**, 状态仍在实例字段上 |
| `src/agents/pi-sdk-session-factory.ts` | `attachActor(session, config)` + **3 个创建点全部包装**。channelId 取 `config.peerId` 的 `:` **前段** (per-channel session key 的形状本就是 `<channel>:<sessionId>`) |

### 27.3 这一步**没有**做的事 (不许夸大进度)

```
fieldsMigrated 仍 0/4    —— 没有搬任何字段 (messageHistory 仍在 Pi 实例上)
entriesWired   仍 0/4    —— 没有任何入口把执行投递进 mailbox (submit() 尚未被业务调用)
行为          零改变     —— 现有链路仍读 Pi 实例字段; actor 只是「存在的归属」
```

### 27.4 真跑验证

| 用例 | 断言 |
| --- | --- |
| **注册表语义** | 同 channelId 两次拿到**同一实例**; 不同 channelId 隔离; `channelId` 正确落盘; `init` 不覆盖既有 actor; 空串落 `default`; `peekActor` 不建; `resetActors` 清空 |
| **真跑 (会话工厂)** | `createAgentSession({peerId:'k5probe-a:s1'/'k5probe-a:s2'/'k5probe-b:s1'})` ⇒ ① `actor.state.channelId === 'k5probe-a'` (**从 peerId 里正确切出 channel**) ② 同 channel 的两个 session **共享同一 actor** ③ 跨 channel **不同 actor** ④ 向一个 actor 写 history, 另一个**确实为空** |

### 27.5 回归面

工厂动过 ⇒ 跑了**所有提到 `createAgentSession` / `pi-sdk-session-factory` 的测试**: `pi-sdk` · `session-resume-e2e` · `persistence-e2e-flow` · `full-loop-e2e` · `workflow-pivot-loop` · `session-gets-identity-doc` · `pi-sdk-tools-validation` 等 + 8 个 kernel 门 = **15 文件 / 179 测试全绿**。
