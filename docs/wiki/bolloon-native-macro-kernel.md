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
| **K2 Pi 可变状态外置** | message history / stream callback / signal / failed tool / channel identity / run identity / loop state → `RunContext` 或 `ChannelContext` | Pi 不持有 Goal·Run 状态/长期恢复/Channel 全局/Model 全局配置/Tool 权限; **完成此步后才允许删 Pi 对应字段与旧辅助方法** | ✅ **外置面 100%** (`RUN_CONTEXT_ACCESS_TOTAL = 0` · 8 字段全迁出 · 判据 `scanSessionFieldResidence`/`scanRunIdSeed`); session/actor 那一半在 **K5** 落地 (§24.3 口径: 两个百分比不许合并) |
| **K3 统一所有入口队列** | 8 个入口 (Web/CLI/P2P/cron/followup/social heartbeat/supervisor/独立宿主) 只能投递事件: `External Event → ChannelMailbox.enqueue() → ChannelActor → Kernel Loop → Run/Goal/Evidence` | 同 Channel 只允许一个执行循环 · 不同 Channel 可并发 · **所有入口只能投递, 不能直接调 `prompt()`** · 外部事件不能直接改 Goal · CLI 与 Web 不各维护一套循环 | ✅ **入口投递 24/24 + 请求式** (判据 `scanEntryDelivery`/`scanExecutionRequest`; web 11 · `index.ts` 11 · routes-tasks 1 · runner-resolver 1 · `cli/interface.ts` 空真完成; 残留 `.prompt(` 全在台账登记的非执行点/排除 receiver) |
| **K4 合并两套 Agent Loop** | `KernelLoop`: prepare → model call → harness tool call → checkpoint → reducer → continuation → finish; Pi 只做 `messages → model response`; Pivot/ReAct/旧 loop 降为策略或 Adapter | CLI/Web 同一任务产生一致的 Run/Goal 事实 · pause/SIGKILL/预算耗尽/模型切换行为一致 · 旧 loop 无任何入口引用 · 真跑长期任务通过后才删旧分支 | ❌ **未开始** (判据: 仓内无 `kernel/kernel-loop.ts`; 本行要的是"合并两套 Agent Loop", 与 §49–§51/log 里被称作 "K4" 的 `AUTHORITY_DEBT` 越权欠账**不是同一件事** —— 按本表 K5 行注释, 那三条欠账属 "K0 的 4 处欠账"。⚠️ 编号用词待与 leo 对齐, 不自行改名) |
| **K5 Channel Actor Runtime** | mailbox / session context / model binding / cancellation / outbound queue / heartbeat / backpressure / close-restart; **目标不是多线程, 而是隔离状态** | 16 channel 并发 · 同 channel 10 条消息不乱序 · Web/CLI/P2P 同输不串台 · 一个 channel 卡住不拖死其他 · 页面关闭后仍由 Supervisor 接管 | ✅ **八步做完** (`K5_STEP8.claimedComplete=true` · stage=`field-deletion-complete` · 5 访问器归零 · 5 暂存字段已删 · 入口 4/4; 判据 `scanStep8Completion`/`scanAccessorSurface`/`scanStagingFieldDeletion`。**如实**: "16 channel 并发 / 页面关闭后 Supervisor 接管"这条验收矩阵尚未逐条真跑) |
| **K6 ModelRuntime** | `acquire(modelSnapshot)` **只读**; 多供应商并发 · 连接池 · timeout · cancellation · 429 退避 · circuit breaker · capability 检查 · provider fallback · usage 记录; **已有的 `selectModel`/registry/catalog/Run snapshot 继续保留, 不重做** | 不自行改 provider 配置 · API key · 默认 URL · Global model · Run snapshot | ✅ **能力 9/9** (stage=`capabilities-done`: 连接复用 · timeout · 取消 · 多供应商并发 · 429 退避 · 熔断 · 能力检查 · provider 回退 · usage 记录; 判据 `scanModelRuntimeFile`/`scanModelRuntimeLedger`; **如实**: 只做了单元/真跑级验证, 未接进真实调用路径的端到端压测) |
| **K7 Harness 唯一系统调用门** | `discover → permission → policy → budget → idempotency → execute → verify → evidence → event`; 覆盖 普通工具/MCP/Skill/delegate/子 Agent/联系人/支付/文件写入/外部通信 | **任何绕过 Harness 的代码都视为架构缺陷**; 工具旁路全删 | 🟡 **第一步完成 (台账 + 门, 行为零改变)**: 9 阶段/9 覆盖面清单化 (§57) · 执行点**逐点分类**普查 17 处 (1 主执行 · 2 skill · 1 MCP · 1 注册表 · **3 旁路候选** · 其余同名不同物/import/定义) · 判据 `scanHarnessLedger`/`countHarnessExecSites` (纯函数, 按盘重算 + 双向) · 11 条测试含 9 条判别力。**未做**: 3 条旁路真收敛 · 覆盖面逐个走门 |
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

## 28. K5 第 4 步第一版: 被全量回归否掉, 已回退 (证据 + 钉住的反例)

### 28.1 我做了什么 (已回退)

把 history 的**本体**搬进 `actor.state.messageHistory`:
`PiAgentSession.messageHistory` 从实例字段改成**访问器** (绑定 actor 后读写全落 actor 的数组) + `attachActor()` 收养绑定前已有的历史。想法是「所有权真转移, 调用点零改动」。

### 28.2 全量回归怎么否掉它

```
全量 4742 测试 ⇒ 6 红 (3 文件)
① 会话隔离被打破 (5 红): persistence-e2e-flow ×2 · session-resume-e2e ×3
   症状一致: **新构造的 session 已经看见别人的 history** (`expected 2 to be 0`, `expected 6 to be 0`, `expected 5 to be 0`)
   根因: actor 注册键 = `peerId` 的 `:` 前段 (或 `default`), 而**会话身份 (SessionStore key) 在 hydrate 时才出现**
        ⇒ 两个独立 session 共用同一个 actor ⇒ history 串台
② K2 门拦下 (1 红): pi-run-context-wiring「session 级字段必须**仍是实例字段**」
   —— 第 4 步没落地前不许留半搬状态 (门是对的)
```

### 28.3 结论 (写进 K5 约束, 不是"下次注意")

| 约束 | 依据 |
| --- | --- |
| **history 归属不能按 channel 前缀** —— 必须按**会话身份** (SessionStore key) | 5 红全出自"同 channel 前缀、不同会话身份"这一形状 |
| **归属转移点必须挪到 hydrate/resume** —— 身份在那时才解析; 构造期拿不到身份 | 构造期只有 `peerId`/`default`, 信息不足 |
| **一个 Pi 实例用多个 key 时不许串** (测试里真实存在: `resume('cli:a')` 后 `save('cli:b')`) | persistence / session-resume 的既有用法 |
| K2 ↔ K5 的**中间态不允许存在**: 要么字段还在实例上, 要么整块搬完 | K2 镜像门 |

### 28.4 钉住的反例 (这一刀留下的最有价值的东西)

新增门用例: **同 channel 前缀的两个独立 session 不许看见彼此 history** —— A 先 `resume` 出 2 条, B 随后构造时必须**仍是 0**, 只有 B 自己 resume 那个 key 之后才看得到。
⇒ 谁再按"channel 前缀"共享 history, 这条立刻红 (不必等全量)。

### 28.5 已回退到绿

```
回退: pi-sdk.ts 恢复 `private messageHistory: Message[] = []` · 去掉 attachActor/访问器
      pi-sdk-types.ts 去掉 attachActor · 工厂改回直接赋 `session.actor`
      台账: fieldsMigrated 回到 0, migratedFieldNames 回到 [] (进度位不许虚报)
全量: **316 文件 / 4742 测试全绿** · tsc 0 错 · K5 门 17/17
保留: 注册表 + 会话工厂绑定 (第 3 步) · 判据 ③b (进度位与名单必须一致) · 钉住的反例 · 门 ③b 的三条判别力用例
```

### 28.6 一条操作教训

回退一个代码段落时, 我用 `find(首次出现的结尾标记)` 定位段落末尾 —— 结果**留了一个多余的 `}`**, 让 pi-sdk.ts 出现数千个语法错误 (tsc 直接把整file 判废)。
⇒ 规矩: **删段落要用语法结构定位 (花括号配平/整块函数边界), 不要用"某个字符串的首次出现"**; 删完立刻 `tsc` 验。

## 29. K5 第 4 步第二版: 按约束重做, 成功 (messageHistory 所有权转移)

### 29.1 改了什么 (相对被否的第一版)

| 维度 | 第一版 (否掉) | 第二版 (本次) |
| --- | --- | --- |
| actor 注册键 | `peerId` 的 `:` **前段** (channel 前缀) | **会话身份**: `loadSessionKey` 优先, 否则**整条** `peerId` |
| 无身份时 | 落 `default` 兜底桶 | **不归属** (没有 actor, history 仍归实例) —— 宁可不共享, 不许串台 |
| `state.channelId` | = 键 | **另取** `peerId` 的 `:` 前段 (channel 归属与身份键解耦) |
| K2 门 | 逐字段正则写死「session 级字段必须仍是实例字段」 | **读 K5 台账**的交接契约: 声明了才放行, 声明了不存在的字段也判红 |

### 29.2 落地物

```
src/kernel/channel-actor.ts       getOrCreateActor(actorKey, init) —— 键=会话身份; channelId = init.channelId ?? key
src/agents/pi-sdk.ts              `messageHistory` 实例字段 → **访问器** (绑定 actor 后读写全落 actor 的数组)
                                  + `attachActor()` (收养绑定前已有的本地历史, 防两份历史)
src/agents/pi-sdk-types.ts        AgentSession.attachActor?(actor)
src/agents/pi-sdk-session-factory.ts  attachActor(): 身份 = loadSessionKey || peerId; 无身份 ⇒ 不绑定
src/kernel/gate-scan.ts           scanSessionFieldResidence(code, sessionFields, migratedByK5) —— K2↔K5 交接契约 (纯函数)
src/kernel/plan-channel-actor.ts  fieldsMigrated 0 → **1/4** · migratedFieldNames ['messageHistory']
```

### 29.3 真跑验证 (全部行为级, 不看源码断言)

| 用例 | 断言 |
| --- | --- |
| **无身份 ⇒ 不归属** | `createAgentSession({})` ⇒ `session.actor === undefined` (没有 default 兜底桶) |
| **同前缀不同身份 ⇒ 隔离** | `peerId='k5probe-a:s1'` vs `'k5probe-a:s2'`: 两者 `channelId` 都是 `k5probe-a`, 但 **actor 不同** |
| **同身份 ⇒ 共享** | 两个 session 同 `loadSessionKey` ⇒ **同一 actor**; 向一个写 history, 另一个立刻看见 |
| **所有权真转移** | `resumeSession()` 灌进来的历史**落在 `actor.state.messageHistory`**; 直接往 actor 数组 push, `saveCurrentSession()` 写出的就是它 (同一个数组对象, 不是副本) |
| **不同身份隔离** | 另一个身份 ⇒ 自己的 actor, history 为 0 |
| **钉住的反例** (第 4 步第一版留下的) | 同 channel 前缀的两个独立 session **不许看见彼此 history** —— 仍然绿 |
| **K2↔K5 交接契约** | ① 真实源码 + 空迁移名单 ⇒ 判红 (`session-field-vanished`) ② 声明一个 K2 里不存在的字段 ⇒ 判红 ③ 盘上真实台账 ⇒ 绿 |

### 29.4 为什么这一版能过而第一版不能

被否的第一版把**channel 前缀**当成了 history 的隔离粒度 —— 而仓库里 history 的隔离粒度是**会话** (SessionStore key)。第二版把键换成会话身份, 并**取消了兜底桶**(没有身份就不共享), 于是"同 channel 下不同会话"再也不会落进同一个桶。
K2 门则从"写死的禁令"改成"**由台账开关的交接契约**" —— 门不再需要为 K5 让路而变橡皮章: 没声明就消失照样红。

## 30. K5 第 4 步续: hydrate / persist 的实现体搬进 Actor (操作搬迁 2/4)

### 30.1 为什么"所有权转移"还不够

第 4 步第一段把 history 的**本体**搬进了 actor (读写都落到 actor 的数组), 但三个操作的**实现体**还挂在 Pi 里:
`hydrate` 是「load → filter → 截断 → 替换」**读-改-写三拍**; `persist` 是「边写边读」地 `map` 出落盘形状。
两者与 `append` 并发时互相踩 —— 压缩 / 工具回灌期间落盘可能抓到半截 history。

### 30.2 交付物

| 位置 | 内容 |
| --- | --- |
| `channel-actor.ts` | `hydrateHistory<T>({load, filter, maxMessages})` —— 三步全在**邮箱内**执行; `historySnapshot<T>()` —— persist 的取数拍 (走邮箱 ⇒ 一致快照); `appendMessage<T>(msg)` —— 串行追加 (备用, 供后续接 25 个 push 点) |
| `plan-channel-actor.ts` | `HISTORY_OPS` = `['hydrate','append','compact','persist']` (**唯一来源**) + 进度 `historyOpsMigrated 2/4` · `historyOpsNames ['hydrate','persist']` |
| `gate-scan.ts` | 判据 **③c**: 操作搬迁位与名单必须一致 · 名字必须 ∈ `HISTORY_OPS` · 不许超总量 |
| `agents/pi-sdk.ts` | `hydrateMessageHistory` / `saveCurrentSession` **绑定 actor 时委托**给 Actor (业务侧只交**纯回调** `load`/`filter`, 内核不 import 业务模块); **未绑定 actor 的会话走原路径 ⇒ 行为不变** |

### 30.3 真跑验证

| 用例 | 断言 |
| --- | --- |
| **串行 (决定性)** | 先提交 hydrate (其 `load` 故意慢 25ms), 紧接着提交 snapshot ⇒ **snapshot 看得见刚灌进去的 2 条** (若并发则必为空) |
| **截断规则** | `maxMessages: 1` ⇒ 只剩最后 1 条 |
| **空历史不破坏现状** | `load → null` ⇒ 返回 0, 现有 history 不动 |
| **委托证据 (Pi 侧)** | `resumeSession` + `saveCurrentSession` 之后 `actor.mailbox.processed` **增加 ≥2 拍** ⇒ 确实走了 actor (不是"看起来像"), 且落盘内容 round-trip 一致 |
| **判据 ③c 判别力** | 计数与名单不一致 ⇒ 红 · 名字不在 `HISTORY_OPS` ⇒ 红 · 超总量 ⇒ 红 |

## 31. K5 第 4 步续: append 收敛 (history 写入的唯一漏斗 · 操作 3/4)

### 31.1 迁移前的盘上事实 (实测, 写进台账)

```
this.messageHistory.push(…)  × 31
this.messageHistory.pop()     × 1
this.messageHistory = …       × 3   (hydrate 回灌 / 两次压缩后的整块替换)
```

### 31.2 交付物

| 位置 | 内容 |
| --- | --- |
| `agents/pi-sdk.ts` | 三个**唯一漏斗**: `pushHistory(...msgs)` · `popHistory()` · `replaceHistory(next)`; 31+1+3 处调用点全部改为走漏斗。**漏斗有意做成同步**: 调用点写完立刻要读 (`length`/索引/`slice`), 改成 `await` 会改变同拍可见性 ⇒ 它交付的是**归属与可数性**, 并发安全由入口投递进 mailbox 负责 (K5 第 5 步) |
| `channel-actor.ts` | `appendMessageSync` / `popMessageSync` / `replaceHistory` (同步写入面) + 原有的排队版 `appendMessage` |
| `plan-channel-actor.ts` | `HISTORY_WRITE_SITES` (迁移前实测值) + `HISTORY_WRITE_FUNNEL` + 操作进度 **3/4** (hydrate · append · persist) |
| `gate-scan.ts` | `scanHistoryWriteSites`: **每个直写模式在盘上必须为 0 处** + 三个漏斗方法必须存在 |

### 31.3 两个被门抓到的真问题 (都不是测试抓到的)

1. **自递归** —— 机械替换把漏斗**自身**的兜底分支也换掉了 (`else this.pushHistory(m)`)，成了无限递归。测试没抓到，因为只跑过"绑定了 actor"的分支；**是判据 `scanHistoryWriteSites` 的探针把它照出来的**。修: 兜底分支写 `this._history`；并**补了一条专测兜底分支的用例**。
2. **改了盘上没改账** —— K2 台账冻结 `messageHistory: 56` 处访问，漏斗化后实为 **21** ⇒ K2 门红 ("少一处而不改账"). 这正是那条判据要的效果。修: 两本台账同步更新 (K2 的 `RUN_CONTEXT_FIELDS` 21 + `RUN_CONTEXT_ACCESS_TOTAL` 161→126；K5 移交字段 56→21)，并注明**这不是"泄漏消失"，是迁移动作的可见痕迹**。
   **交叉验证**: 56 − 21 = **35** = 31 (push) + 1 (pop) + 3 (赋值) —— 两个独立的冻结数字互相对得上。

### 31.4 真跑验证

| 用例 | 断言 |
| --- | --- |
| **漏斗落到 actor** | 绑定 actor 的会话: `pushHistory(...)` 两条 ⇒ actor 的 history 增长; `popHistory()` 取回; `replaceHistory([...])` 整块换掉 |
| **兜底分支** (曾藏递归洞) | 无身份的会话: `pushHistory/popHistory/replaceHistory` 全部落在**本地数组**上, 语义与迁移前一致 |
| **判据判别力** | 盘上源码三模式**都为 0**; 注入一处直写 ⇒ 立刻红; 漏斗方法被删 ⇒ 红 |

### 31.5 一处操作教训 (第 N 次: 引号/转义)

在被 Python 字符串包住的补丁里写 TS 的 `'\n'`，会被 Python 先吃掉一层转义 ⇒ 落盘成**真换行**，语法直接破。
⇒ 规矩: 写这类补丁时**别在字符串字面量里写字面量换行** —— 用 `split(/\r?\n/)` 正则可省一处，`join(String.fromCharCode(10))` 可省另一处。

## 32. K5 第 4 步收官: compact 落地拍 (rebase) — history 操作 4/4

### 32.1 先做分析, 再决定动哪里 (两处压缩路径性质不同)

| 路径 | 形状 | 有没有窗口 |
| --- | --- | --- |
| **同步压缩** (`compressHistorySync` + `replaceHistory`) | 取快照与替换是**同一拍相邻两行**, 中间没有 await | **没有** ⇒ 不需要改, 只留注释警戒 ("若哪天插入 await, 必须改成 rebaseHistory") |
| **异步压缩** (`await compactPipeline(...)` → 落地) | 取快照 … await … 整块替换 | **有** ⇒ 期间的 append 会被替换**丢掉** (lost update) |

### 32.2 交付物

| 位置 | 内容 |
| --- | --- |
| `channel-actor.ts` | **`rebaseHistory(compacted, snapshotLen)`**: 走邮箱 + 把**快照之后新追加的尾部原样接回** (`arr = [...compacted, ...tail]`), 返回 `{ keptTail }`; 越界快照长度不炸 (防御) |
| `agents/pi-sdk.ts` | 异步压缩前记 `snapshotLen = this.messageHistory.length`; 落地时**绑定 actor 就交它 rebase** (并在 `keptTail > 0` 时 warn), 未绑定走原路径 |
| `plan-channel-actor.ts` | `historyOpsMigrated **4/4**` (hydrate · append · compact · persist) |

### 32.3 真跑验证

| 用例 | 断言 |
| --- | --- |
| **尾部不被吃掉** (决定性) | 2 条历史 → 取快照 (`snapshotLen=2`) → 提交 rebase (压缩结果 1 条) → **同时**用 `appendMessageSync` 追加 1 条 (模拟循环里的同步 push) ⇒ `keptTail=1`, 最终 `['C1','m3']` |
| **反例对照** | 同样的场景若用"整块替换"(`replaceHistory`), 那条新消息**确实没了** (实现里同时断言了这一点 —— 说明本拍修的是真行为) |
| **防御** | `snapshotLen=999` (压缩期间 history 变短) ⇒ `keptTail=0`, 不乱吞 |
| **落地拍必须在盘上** | 判据断言源码里有 `this.actor.rebaseHistory<Message>(` (防止有人把接线回退掉) |

### 32.4 台账又被门抓了一次 (同一条判据第二次生效)

加 `snapshotLen = this.messageHistory.length` ⇒ `messageHistory` 访问数 21 → **22** ⇒ K2 门立刻红 ("改了盘上没改账")。
⇒ 两本台账同步 (K2 22 + 总量 127; K5 移交字段 22), 并在台账里写明"**门已两次拦下这类不同步**"。

## 33. K5 步骤③: 三个会话绑定迁入 Actor (fields 4/4)

### 33.1 落地物

`currentChannelId` / `currentAgentId` / `currentGoalId` 三个会话绑定的**本体**住进 `actor.state.channelId` / `.agentId` / `.goalBinding`:
Pi 侧改为**访问器** (与 `messageHistory` 同一手法: 调用点零改动, 写入点一个没删), `attachActor()` **收养**构造期/入参已设的值 (actor 侧已有值时不覆盖 —— 同一会话身份以先到者为准)。

### 33.2 这一格的关键判断: 访问数**不变** (与 messageHistory 那格相反)

| 字段 | 访问数 | 说明 |
| --- | --- | --- |
| `messageHistory` | 56 → **22** | 上一格把 35 处写入收敛进漏斗 ⇒ 访问数真的降了 (必须同步 K2 冻结值) |
| `currentChannelId` / `currentAgentId` / `currentGoalId` | **24 / 21 / 22 不变** | 只换**所有权** (值住哪), 没删任何访问点 ⇒ **不动** K2 台账 |

⇒ 判据的"少一处才红"在这里**不该**触发, 一处也没少 (实测总量 127 = 台账 127 ✓)。

### 33.3 测试逼出来的一个**静默行为变化** (已修)

第一版让工厂把 `state.channelId` 预置成 `peerId` 的 `:` 前段 —— 结果会话在入口设置之前就读到非空值, 而 `currentChannelId` 原先一直是 `''` 直到 prompt/入口注入。
受影响面: `cm.makeSnapshot({channelId})` · compaction 的 `cacheScope: this.currentChannelId || 'default'`。
⇒ 修: **工厂不预置 channelId** (只预置 `agentId`, 那是构造入参); 注册表也不再"没给 channelId 就拿身份键当 channel"。
⇒ 语义定清: **注册键 = 会话身份; `state.channelId` = 会话当前绑定的 channel** (由入口设置), 两者解耦。

### 33.4 真跑验证

| 用例 | 断言 |
| --- | --- |
| **构造期收养** | `createAgentSession({agentId:'agent-A'})` ⇒ `actor.state.agentId === 'agent-A'` 且实例侧暂存 `_agentId === ''` (不许两份真相) |
| **写入落 actor** | `s.currentChannelId='ch-x'` / `s.currentGoalId='goal-1'` ⇒ actor 侧可见; 直接改 actor ⇒ 实例读得到 |
| **同身份共享** | 同 `loadSessionKey` 的另一个 session ⇒ 同一 actor, 三处绑定一致 |
| **跨身份隔离** | 另一个身份 ⇒ 自己的 actor, 三处绑定为 `''` |

### 33.5 一条判据口径的坑 (顺手记下)

K2 的访问计数**只剥 `//` 行注释, 不剥 `*` 块注释** —— 我在块注释里写了带 `this.` 前缀的字段名, 计数就虚增 1, 被门照出。
⇒ 规矩: **别在注释里写出"台账计数的那种字面形态"**。计数口径量的是**代码**访问; 拿注释去凑数或补注释凑数都是错的。

## 34. K5 步骤④ 起手: 入口投递 (web 用户路径 3/8 执行点)

### 34.1 投递助手放在内核里 (为的是能真跑验证, 不是为好看)

```
kernel/channel-actor.ts  deliverThroughActor(holder, run)
   有 actor ⇒ 投进它的 mailbox (同一会话身份的输入**排队**执行)
   无 actor ⇒ 直接跑 (行为与迁移前一致)
```
放在内核的好处: 它是"入口 → 内核"的唯一接缝, 于是**不起 server 就能单测真语义** (排队 / 跨身份并行 / 无身份兜底), 而不是靠读源码断言。

### 34.2 接线与进度 (两个数字都由门从盘上重算)

```
web/server.ts  promptStream( 执行点共 **8** 处; 已投递 **3** 处 (用户消息 / 第二条路径 / 重新生成)
台账 entrySites { file: 'web/server.ts', total: 8, wired: 3 }
判据 scanEntryDelivery: total 必须等于盘上 `promptStream(` 计数; wired 必须等于盘上 `deliverThroughActor(` 计数;
                        wired ≤ total。⇒ **新增入口执行点不登记 ⇒ 红; 少包一处却把 wired 写大 ⇒ 红** (自报无效)
```

`entriesWired` 保持 **0/4**: 四个**粗粒度**入口 (web / CLI / P2P / Supervisor) 要**全部执行点接完**才算数 —— 不给"接了一部分就宣布一条入口完成"留口子。

### 34.3 真跑验证

| 用例 | 断言 |
| --- | --- |
| **同身份排队** (K5 验收①) | 同一 actor 两个输入 (慢 30ms + 快 1ms) ⇒ 实测 `a:start a:end b:start b:end`, 结果 `['a','b']` —— 第二个**等**第一个 |
| **跨身份并行** | 各带自己的 actor ⇒ 实测 `c:start d:start d:end c:end` (短的先结束, 说明真并发) |
| **无身份兜底** | `{}` / `null` ⇒ 直跑, 行为不变 |
| **判据判别力** | 真实盘上 ⇒ 绿; wired 写大 / total 不登记 / wired>total ⇒ 各判红 |

### 34.4 一处编译期坑

闭包里 TS **不保留 null 收窄** (`let agent: AgentSession | null`) ⇒ wrapped 调用在闭包内报 `possibly null`。
⇒ 收成局部 `const agentForRun = agent;` 再进闭包 (比 `!` 干净)。

## 35. K5 步骤④: web 入口投递完成 (entriesWired 1/4) + 重入安全网

### 35.1 先修死锁风险, 再接入口 (顺序很重要)

`SerialMailbox` 是**无重入**的: 已在 mailbox 里跑的任务若再往同一个 mailbox 投递并 await, 就是**自锁** (新任务排在自己后面)。入口投递一旦覆盖到"运行中会被调用"的执行点 (LLM 回调 / judge / 工具内再问) 就会踩到。
⇒ `channel-actor.ts` 引入 **`AsyncLocalStorage` 记住"当前跑在哪个 actor 的上下文里"**: 同 actor 重入 ⇒ **直跑**; 不同 actor ⇒ 照常排队; `deliverThroughActor` 出口处据此分支。

**真盘变异证明它是承重的**: 临时删掉那行判断 ⇒ 重入用例 `Test timed out in 5000ms` (真死锁); 加回 ⇒ 绿。

### 35.2 入口执行点的精确口径 (判据与台账必须同一口径)

计数规则 (`countEntryExecutionPoints`, 写成纯函数): 只数 `.<promptStream>(` 与 `.<prompt>(` (**非流式也算** —— 它同样启动一次执行); 先剥 `//` 行注释并丢掉 `*` 开头行; **排除 `this.prompt(...)`** (CLI 的 readline 提示)。
⇒ 实测踩过两个污染: 注释里的示例 (虚增) 与 `this.prompt('> ')` (虚增 3)。

### 35.3 全入口面清单 (逐文件, 两个数字都由门从盘上重算)

| 文件 | 执行点 | 已投递 | 归属入口 |
| --- | --- | --- | --- |
| `web/server.ts` | **11** | **11** | web (用户消息 / P2P 中继 / 任务 / cron / 心跳) |
| `web/routes-tasks.ts` | **1** | **1** | web 任务路由 |
| `index.ts` | 8 | 0 | CLI 主入口 (未开始) |
| `cli/interface.ts` | 0 | 0 | 它的 `prompt` 是 readline ⇒ 无执行点 |
| `agents/runner-resolver.ts` | 1 | 0 | 子 Agent / Supervisor 面 (未开始) |

⇒ **`entriesWired 0/4 → 1/4`** (web 入口全部执行点接完才算一条, 不给"接一部分就宣布"留口子)。

### 35.4 顺带两个编译期坑

1. 闭包里 TS **不保留收窄** (`let agent: AgentSession | null` / `if (task.description)`) ⇒ 两处都要先收成局部 `const`, 再进闭包。
2. `deliverThroughActor` 的 holder 形参写 `{ actor?: ChannelActor }` 会触发 TS 弱类型检查 ("no properties in common with type…"), 因为调用点 receiver 类型五花八门 ⇒ 形参放宽成 `unknown`, 取值处运行时收窄 (取不到就直跑)。

## 36. K5 步骤④: CLI 与子 Agent/Supervisor 两条面接完 (entriesWired 3/4)

### 36.1 先认点, 再接线 (不能照正则批量替换)

`index.ts` 按口径算出 8 处, 逐个认下来后发现 **1 处不是执行点**:
`index.ts:489` 的 `s.prompt('📩 收到 …')` —— `s` 是文件顶部的 **UI 打印助手** (`banner/step/success/warn/error/info/prompt`), 它只打印, 不启动执行。
⇒ 计数口径增加 **`excludeReceivers` (台账里的数据, 冻结)**: `this` = CLI readline (`this.prompt('> ')`); `s` = UI 打印助手。
   名单改动会出现在 diff 里 ⇒ 不能拿它偷偷把执行点数变小; 判据里还配了判别力用例 (不排除时算 1, 排除后算 0)。

### 36.2 接线结果 (两个数字仍由门从盘上重算)

| 文件 | 执行点 | 已投递 | 归属入口 |
| --- | --- | --- | --- |
| `web/server.ts` | 11 | **11** | web (用户消息 / P2P 中继 / 任务 / cron / 心跳) |
| `web/routes-tasks.ts` | 1 | **1** | web 任务路由 |
| `index.ts` | **7** | **7** | **CLI 主入口** (交互式 + `--prompt` 直调 + 心跳 llm 回调) |
| `cli/interface.ts` | 0 | 0 | readline ⇒ 无执行点 |
| `agents/runner-resolver.ts` | 1 | **1** | **子 Agent / Supervisor 面** |

⇒ **`entriesWired 1/4 → 3/4`** (web · CLI · 子Agent/Supervisor)。剩 **P2P 入站**: 它在 `index.ts` 里走 `comm.on('message') → dispatchTask(...)`, 而 `dispatchTask` 的 agent 调用面**尚未逐个认下来** ⇒ 不先宣布完成。

### 36.3 一处多行调用怎么包

`index.ts:3753` 的 `a.prompt(trimmed, { …30+ 行 options… })` 是**多行**调用 ⇒ 用**括号配平**定位收尾行 (实测 3753 → 3851), 再把收尾的 `});` 改成 `}));`。
⇒ 规矩: 多行调用不能靠"找下一个 `});`"猜, 要用计数器配平 (否则很容易改到别人的收尾)。

### 36.4 一处工具坑

判据里**动态拼正则** (`new RegExp` 由 receiver 名单生成) 被转义吃坏 (经 Python 补丁写入后语法直接破) ⇒ 改成**不用动态正则**: 先 `match` 出调用, 再用 `excludeReceivers.includes(recv)` 判定。
⇒ 规矩: 判据/口径这类要长命的小函数, **避开动态正则与转义** —— 正则字面量 + `includes` 更稳。

## 37. K5 步骤④ 完成: 入口投递 4/4 (web · CLI · P2P 入站 · Supervisor)

### 37.1 关键发现: 原口径漏了**一整类**入口

P2P 入站处理的是 `summarize` / `improve` 任务, 它调的是 **`a.summarizeDocument(...)` / `a.improveDocument(...)`** —— 不叫 `prompt`。
⇒ 只数 `prompt/promptStream` 会让这条入口**永远数不到** (实测 `index.ts` 因此漏 4 处)。
⇒ 修: 口径的**方法名单也做成台账数据** (`AGENT_ENTRY_METHODS`, 冻结), 并写明**故意不计**的三种 (`readDocument` 纯 IO · `suggestRename` 单次小调用不写历史 · `runWorkflow` 内部会再调 prompt ⇒ 计入会双算)。若哪天它们变成"启动一次执行", **先改台账再改代码**。

### 37.2 最终清单 (两个数字都由门从盘上重算)

| 文件 | 执行点 | 已投递 | 入口 |
| --- | --- | --- | --- |
| `web/server.ts` | 11 | 11 | web |
| `web/routes-tasks.ts` | 1 | 1 | web |
| `index.ts` | **11** | **11** | CLI 主入口 + **P2P 入站** (含文档摘要/改写) |
| `cli/interface.ts` | 0 | 0 | (readline, 无执行点 ⇒ **空真完成**) |
| `agents/runner-resolver.ts` | 1 | 1 | Supervisor / 子 Agent |

### 37.3 入口级声明做成**双向**判据

`K5_ENTRY_GROUPS` (入口 → 文件) + 判据:
* 说完成 ⇒ 它的文件必须**全部** `total === wired`; 文件都有执行点却没接完 ⇒ 红;
* 说没完成 ⇒ 必须**真有**文件没接完 (都接完了还标未完成 ⇒ 红, 逼台账前进);
* `entriesWired` 必须等于"标完成的入口数" ⇒ 数字与分组不许各自为政。

⇒ **`entriesWired 3/4 → 4/4`**: 四个入口 (web · CLI · P2P 入站 · Supervisor/子Agent) 全部执行点已投进 Actor mailbox。

### 37.4 一处判据语义修正

`total === 0` 的文件 (如 `cli/interface.ts`) 必须算**空真完成** —— 否则"入口声明完成"会因为它永远判红 (实测被自己的判据拦下过一次)。

### 37.5 一次自伤与恢复 (记下来)

用行号手术搬移台账里的常量块时把文件**改坏了两轮** (注释头被吃、声明重复、大段内容被删)。
⇒ 正确的收尾方式: **`git checkout HEAD -- <file>` 恢复该文件到上一提交, 再按正确顺序重落改动**。
   ⚠️ 注意 `git checkout -- <file>` 是**从索引恢复** —— 若坏内容已被 `git add` 过, 它不会回退; 必须显式写 `HEAD`。

## 38. K5 步骤⑤: channel 级串行锁 (能力落地 + 证据 + 明示开关, 不静默过度串行)

### 38.1 先取证据, 再决定要不要真改行为

| 事实 | 出处 |
| --- | --- |
| web 的 channel 只有**一个** `currentSessionId` ⇒ `sessionKey = <channelId>:<currentSessionId>` | `web/server.ts:1566-1567` |
| 会话可切换 (`[新会话] 已切换到: …`), 旧会话仍留在内存 | `web/client.ts:1004` + `channelSessions` 缓存 |
| 切换后两个身份**各写自己的 history** (无污染) —— 污染风险只来自"同身份并发" | K5 第 4 步: history 本体按**会话身份**归属 |

⇒ **结论**: 活跃会话上, **身份级串行已经等价于 channel 级串行** (用户消息都投到同一个身份)。
channel 级锁只在"跨会话切换"这一稀有时刻才有额外作用, 代价是**同 channel 的多 agent (P2P) 也被串起来**。
⇒ 这一步**不静默改行为**: 把能力落地 + 证据写进台账 + 开关明示, 是否全局启用是**意图层**的决定。

### 38.2 交付物

| 位置 | 内容 |
| --- | --- |
| `channel-actor.ts` | `channelQueues` 注册表 + `getChannelQueue(channelId)` + `channelQueueCount()`; `channelCtx` (ALS) 防**重入自锁**; `deliverThroughActor(holder, run, { serializeByChannel })` (opt-in, 默认 false); `resetActors()` 一并清空 channel 队列 |
| `plan-channel-actor.ts` | `K5_CHANNEL_LOCK = { available: true, enabled: false, callSites: 0, evidence: 'web/server.ts:1566-1567 …' }` |
| `gate-scan.ts` | `scanChannelLock(sources, lock)` —— **双向**: 启用 ⇒ 必须真有调用点传 `serializeByChannel:true`; 未启用 ⇒ 一个都不许有; `callSites` 必须等于盘上计数 |

### 38.3 真跑验证 (6 组)

| 用例 | 断言 |
| --- | --- |
| **同 channel 跨身份排队** (身份锁做不到的那一半) | 两个 actor 同 `channelId` + 开锁 ⇒ `x:start x:end y:start y:end` |
| **默认不开锁** | 同 channel 两个身份默认各跑各的 (短的先结束) ⇒ 证明**没有**被过度串行化 |
| **跨 channel 开锁仍并行** | `m:start n:start n:end m:end` |
| **重入不自锁** | 已在同 channel 队列的任务里再投递 ⇒ 直跑 (返回 `outer(inner)`) |
| **空 channelId** | 开锁也安全 ⇒ 退回身份级 |
| **holder 语义守门** | 把 **actor 本身**当 holder 传 ⇒ 走兜底直跑且 `mailbox.processed === 0` |

### 38.4 一个自伤的测试 bug (值得记)

新用例第一版全红: 我把 **actor 本身**当成 holder 传进去 (`deliverThroughActor(actor, …)`) —— 而该函数收的是**带 `.actor` 的 holder** (生产里传的是 agent session)。
⇒ 症状是"开了锁却不排队, 连 mailbox 都没走" (`pending` 全 0)。教训: **症状指向"没进队"时, 先怀疑参数形状, 再怀疑队列实现**; 并补了一条"holder 语义守门"用例把这种误用钉住。

## 39. K5 步骤⑥: Run 身份归属 Actor (`currentRunId` → `actor.activeRun`)

### 39.1 交付物

| 位置 | 内容 |
| --- | --- |
| `agents/pi-sdk.ts` | `currentRunId` 由实例字段改成**访问器**: 未绑定 actor ⇒ 本地暂存 `_runId`; 绑定后 ⇒ 本体是 `actor.state.activeRun` (与步骤③三个会话绑定同一手法)。`seedRunContext()` (K2 留下的**唯一播种读取**) 自动读到 actor 里的值 ⇒ 两种口径下 runId 来源一致 |
| `channel-actor.ts` | `attachActor()` 增加 Run 身份**收养** (绑定前若已有活跃 Run —— 例如从 checkpoint 恢复 —— 不许丢) |
| `plan-channel-actor.ts` | `K5_RUN_BOUNDARY = { field: 'currentRunId', into: 'actor.activeRun', migrated: true, seedReads: 1 }` |
| `gate-scan.ts` | `scanRunBoundaryResidence(code, rb)` —— **双向**: 标已迁 ⇒ 源码里**不许再有** `private currentRunId [=:]`; 标未迁 ⇒ 必须还有 ⇒ 半搬状态判红 |

### 39.2 为什么访问数**不变** (与 messageHistory 那格对照)

`currentRunId` 的 38 处访问**全部保留** (只是值住到了 actor 里) ⇒ K2 台账**不动** (实测 38 = 38)。
反之 `messageHistory` 那格是把 35 处写入收敛进漏斗 ⇒ 访问数真降 ⇒ 必须同步冻结值。**两种迁移痕迹不同, 先算再改。**

### 39.3 真跑验证

| 用例 | 断言 |
| --- | --- |
| **本体住进 actor** | `s.currentRunId = 'run-x'` ⇒ `actor.state.activeRun === 'run-x'`; 直改 actor ⇒ 实例读得到 |
| **播种读到 actor 的值** | `s.seedRunContext().runId === 'run-y'` (K2 的唯一入口在两种口径下都成立) |
| **未绑定会话** | 走本地暂存, `seedRunContext().runId` 仍是本地值 (行为不变) |
| **判据双向判别力** | 把实例字段声明注回去 ⇒ 红; 台账标未迁而源码已迁 ⇒ 红 |

### 39.4 同一类坑第三次踩到 (已升级为规矩)

我在**块注释**里写了"带 self. 前缀 + 字段名"的字面形态来讲解"访问数不变", 结果 K2 计数**虚增 1** (38→39) 被门当场照出。
⇒ 规矩 (第三次): **注释里不许出现台账计数的字面形态** —— K2 的口径只剥 `//` 行注释, **不剥 `*` 块注释**; 而且**讲解计数的注释**最容易被写进去 (三次里有两次是讲解口径本身)。

## 40. K5 步骤⑦: Pi 只接收一次性的 `ExecutionRequest`

### 40.1 交付物

| 位置 | 内容 |
| --- | --- |
| `channel-actor.ts` | `ExecutionRequest` 补齐 `onStream?` (给了走 `promptStream`, 不给走 `prompt`) —— 一次性请求的形状定死 |
| `agents/pi-sdk.ts` | **`applyExecutionRequest(req)`**: 把请求里的绑定 (channelId/agentId/goalId/resumeRunId) 落到位 (走访问器 ⇒ 本体进 actor); **没给的不覆盖**。**`runExecution(req)`**: Pi 的**唯一执行入口** —— 先落位再派发 |
| `agents/pi-sdk-types.ts` | 接口补 `applyExecutionRequest?` / `runExecution?` |
| `web/server.ts` | 用户消息路径改成**请求式**: 构造 `{input, channelId, signal, onStream}` → `deliverThroughActor(session, () => session.runExecution!(req))` (**模板站点**) |
| `plan-channel-actor.ts` | `K5_EXECUTION_REQUEST = { methodAdded: true, converted: 1, wiredTotal: 24, remaining: 23 }` (remaining 是**派生值**, 明示) |
| `gate-scan.ts` | `scanExecutionRequest(...)` —— 请求式点数**从盘上重算** · 不许超总量 · Pi 侧必须真的有那两个方法 (双向) |

### 40.2 判据只验"真数得到"的那一半 (不编造可验证性)

位置参数式的形态太多 (多行调用 / `as any` / 带参箭头) ⇒ **行级正则数不准**。
与其编一个假精确的门, 不如: **请求式 (converted) 钉死**, 剩下那半用 `remaining = wiredTotal − converted` 的**算术**表示, 并在台账里注明它是派生的。

### 40.3 真跑验证

| 用例 | 断言 |
| --- | --- |
| **绑定落位** | `applyExecutionRequest({channelId, agentId, goalId, resumeRunId})` ⇒ `actor.state.{channelId,agentId,goalBinding}` 全部到位; `resumeRunId` (run-boundary 值) 也设上 |
| **没给的不覆盖** | 只给 `channelId` 再调一次 ⇒ agentId/goalBinding/resumeRunId 保持 |
| **唯一入口存在** | `typeof session.runExecution === 'function'` |
| **判据判别力** | 盘上请求式点数写错 ⇒ 红 · 台账说没加而 pi-sdk 里有 ⇒ 红 · 超总量 ⇒ 红 |

### 40.4 顺带补上口径的一个洞 (被门当场抓出)

把 web 用户路径改成请求式后, `web/server.ts` 的执行点计数从 **11 掉到 10** —— 因为口径的方法名单里没有 `runExecution` (新入口) ⇒ 门立刻红。
⇒ 修: `AGENT_ENTRY_METHODS` 加上 `runExecution`, 并允许非空断言/可选调用 (`runExecution!(`) —— 否则"改写成请求式"的站点会从计数里**消失**。
   **这条洞很有代表性: 引入新入口方法时, 口径的方法名单必须同步** (否则迁移看起来像"执行点凭空少了")。

### 40.5 门当场抓到两条**真回归** (不是假红) —— 迁移必须同步的账

改成请求式后, 全量立刻红了 4 条 (2 文件), 全是"改代码没改账":

| 门 | 报了什么 | 为什么该报 |
| --- | --- | --- |
| **K0 ③ 入口调用关系图** | `表里有但盘上扫不到` + 直调总数 25 ≠ 冻结 24 | `runExecution` 内部**新增** 2 处派发 (`prompt` / `promptStream`), server.ts 用户路径**少** 1 处 ⇒ 表与冻结值都要更新 |
| **K2 逐字段计数** | 三个绑定的访问数各 +1 (24/21/22 → 25/22/23), 总量 127 → 130 | `applyExecutionRequest` 把请求里的绑定写进这三个字段 (各一处写) —— 这是**真实新增访问** |

⇒ 处置: ① `ENTRY_GRAPH` 加两行 `adapter-internal` (`runExecution` 的派发) 并把 `ENTRY_DIRECT_CALLS_FROZEN_AT` 24 → **25**, 注明"这是**形态变化**不是旁路复活";
② K2 三个字段计数 + 总量同步, 且 **K5 的移交字段表逐字跟上** (跨台账判据强制)。
⇒ 教训: **引入"新入口方法"会同时动两张账** (入口调用图 + 逐字段访问计数) —— 改形态时必须一次性把两张账都改掉。

## 41. K5 步骤⑧: 删除实例侧"绑定前暂存"字段 (5 个) —— 前置是"每个 session 都有 actor"

### 41.1 为什么先补前置, 而不是硬删

要删 Pi 实例侧的暂存字段 (`_history` / `_channelId` / `_agentId` / `_goalId` / `_runId`), 前提是**任何 session 都有 actor**。当时的现实: 只有"有会话身份"的 session 才被 factory 绑定 actor; 没身份的 session 靠暂存字段活着。
⇒ 造一个 **私有 actor** (`createPrivateActor()`, **不注册** ⇒ 别人拿不到) 给无身份的 session —— 隔离性比"猜一个共享键"更保守, 语义与暂存字段完全等价 (每个 session 自己一份)。

### 41.2 交付物

| 位置 | 内容 |
| --- | --- |
| `channel-actor.ts` | `createPrivateActor()` (不注册; `privateActorCount()` 供诊断) · `resetActors()` 一并清零 |
| `agents/pi-sdk.ts` | **5 个暂存字段删除**; 访问器直接读写 `this.actor!.state.*`; 三个 history 漏斗只剩一条路径 (写 actor) ⇒ 顺带**彻底消灭了"兜底分支写错成自递归"的可能**; 构造器: `this.actor = config.actor ?? createPrivateActor()` |
| `pi-sdk-types.ts` | `AgentSessionConfig.actor?` —— **工厂在构造前注入** |
| `pi-sdk-session-factory.ts` | `withActor(config)`: 先算身份 → `getOrCreateActor(identity)` → 带 `actor` 构造。**构造期异步回灌因此直接落进身份 actor** |
| `plan-channel-actor.ts` | `K5_FIELD_DELETION { sourceFields, deletedStagingFields }` |
| `gate-scan.ts` | `scanStagingFieldDeletion(piCode, del)` —— **双向**: 台账说删了 ⇒ 源码不许再有 `private <field>`; 源码里没了却没登记 ⇒ 红 |

### 41.3 踩到的真回归: 构造期回灌落进"被遗弃的私有 actor"

第一版是"构造完再 `attachActor()` 换成身份 actor"。探针显示: 日志说 **"从 cli:probe 回灌 2 条历史 (经 Channel Actor)"**, 但 `actor.state.messageHistory.length === 0`。
根因: 构造期回灌是**异步**的 —— 它绑的是**出生时的私有 actor** (`hydrateHistory` 走的是那一刻的 actor 的 mailbox), 而工厂随后把 `this.actor` 换成身份 actor ⇒ 那批回灌写进了**没人再看的私有 actor**。
⇒ 修法: **把身份 actor 在构造前注入** (`config.actor`) ⇒ 回灌直接落在正确的家。
⇒ 教训: 迁移"值住哪"时, **异步初始化 + 中途换家**是典型的静默丢数据形态; 正确姿势是**家先定好再出生**。

### 41.4 两处测试卫生问题 (自己造的)

1. 往共享单例 session 里 `push('only-mine')` (**裸字符串**, 没有 `.content`) ⇒ 后面用例读到 `[undefined, 'local1']`。修: 塞**消息对象**。
2. 无身份用例拿的是工厂**单例** (会被同文件其它用例污染), 且 `forceNew` 是工厂的**第二参**, 塞进 config 不生效 ⇒ 用例不自足。修: `createAgentSession({cwd}, true)`。

### 41.5 门与判据

- `scanStagingFieldDeletion` 双向判 (删了却还在 / 没了却没登记);
- `scanHistoryWriteSites` 仍要求"直写 0 处" —— 三个漏斗改成只走 actor 后依旧满足 ✓;
- K5 门全套 (35 用例) 通过。

## 42. K5 步骤⑧ 后半: 访问器**不硬删**, 改成棘轮 + 逐条核 7 条删除前置

### 42.1 量过才决定: 删访问器 = 大范围改名

实测 pi-sdk **内部**对 5 个已迁字段访问器的引用: `messageHistory 21` · `currentChannelId 25` · `currentAgentId 22` · `currentGoalId 23` · `currentRunId 38` = **129 处**; 外部还有 10 个文件引用 (index.ts / web/ / workflow-pivot-loop / snip-collapse / execution-supervisor / goal-flywheel-wiring / goal-store …)。
⇒ 一次性硬删就是**大范围改名**, 与本仓纪律 (删除必须有依据 + 不做大爆炸重构) 相冲。

### 42.2 交付物

| 位置 | 内容 |
| --- | --- |
| `plan-channel-actor.ts` | `K5_ACCESSOR_SURFACE { accessorFields, frozenInPiSdk, where, why }` —— **棘轮**: 引用数只许减 |
| `gate-scan.ts` | `scanAccessorSurface` —— 从盘上重算, 与台账**逐字相等** (增 ⇒ 迁移回退; 减 ⇒ 改了盘没改账) |
| `plan-channel-actor.ts` | `K5_DELETION_PRECONDITIONS` 从 `string[]` 升级成 `{ text, backedBy }[]` —— **每条前置必须点名背书** |
| `gate-scan.ts` | `scanPreconditionBacking` —— 背书必须是**盘上存在的文件** 或 gate-scan 里存在的判据名 (只核背书存在, **不代替真跑**) |

### 42.3 7 条前置的背书 (核过, 名副其实)

| 前置 | 背书 (真跑在) |
| --- | --- |
| Pi 不再拥有 session 状态 | `K5_FIELD_DELETION` + 门 37 用例 |
| 所有入口经过 Actor | `scanEntryDelivery` (wiredTotal === total) |
| 同 Channel 串行 / 跨 Channel 并发真跑 | 门 114 串行 · 315 跨身份并行 · 367 跨 channel 并行 |
| 重启后 history/Goal/Run 恢复 | `session-resume-e2e` · `persistence-e2e-flow` |
| currentRunId 不再由 Pi 播种 | `scanRunIdSeed` |
| Pi 字段访问只剩推理临时变量 | `K5_ACCESSOR_SURFACE` |
| 旧字段零引用门禁 | `scanStagingFieldDeletion` (双向) |

### 42.4 钉住静默丢数据 (步骤⑧ 实测过的那条)

新增回归用例: 带 `loadSessionKey` 的 session 构造后, 断言 ① `actor.state.messageHistory.length === 2` ② `s.actor === peekActor(会话身份)` —— 即回灌必须落进**注册表里的那个身份 actor**, 不许落进"被遗弃的私有 actor"(第一版 bug 的形状)。

### 42.5 代价可见

加这两条判据 + 棘轮台账 ⇒ 内核**代码**行数 1650 → **1698** · 台账 915 → **952**, K3 行数棘轮门当场判红 ⇒ 冻结值同步 (改动现于 diff, 不是偷偷涨)。

## 43. K5 步骤⑧ 批次 1: `messageHistory` 访问器删除 (21 → 0) —— 机械改名的三个真陷阱

### 43.1 为什么先做这一个字段

`messageHistory` 是 5 个访问器里语义最清楚的一个 (写入早已收敛到唯一漏斗) ⇒ 拿它当"分批删访问器"的第一批:
把 pi-sdk 内 19 个代码站点改成显式读 `this.actor!.state.messageHistory`, 注释里的字面量也一并改成文字 (不放开计数上限), 然后**删掉 getter/setter**。
账: `K5_ACCESSOR_SURFACE.frozenInPiSdk.messageHistory 21 → 0` · K2 `accesses 22 → 0` + 总数 `130 → 108` · K5 移交字段 `22 → 0`。

### 43.2 删 setter 引出的真问题: "凭空出现的自有属性"

删掉 setter 后, 测试里 `(session as any).messageHistory = [...]` **不再报错**, 而是给对象加了一个**新的自有属性**
(真历史仍在 actor 里, 是空的) ⇒ `full-loop-e2e` 报 `expected +0 to be 4`。
**修法不是把 setter 加回来**, 而是把"种历史"变成**唯一漏斗的公开入口**: `replaceHistory(next)` 由 private 升 public
(接口 `AgentSession.replaceHistory?`), 测试改走它 —— 直接赋数组会**换掉数组身份** (actor 里那份还是空的), 那是静默丢数据。
漏斗可见性因此成了台账的一部分: `HISTORY_WRITE_FUNNEL` 从 `string[]` 升级成 `{ name, vis, why? }`, 判据双向核
(公开的必须没 `private` 修饰符; private 的必须有 —— TS 里 public 是默认, 判"没有 private"而不是"有 public")。

### 43.3 顺手清掉一处两份真相

`gate-scan.ts` 里另抄了一份 `HISTORY_WRITE_FUNNEL` 常量 (与 plan 台账同名同值) ⇒ 改台账不改它, 判据会**看着还绿**。
已删, 改成由台账传入: `scanHistoryWriteSites(code, funnel)` —— 台账是数据, 判据是纯函数。并加"拿不到事实就拒跑"
(funnel 为空 ⇒ 直接报红, 不许跳过)。

### 43.4 三次自伤 (机械改名的真陷阱, 逐条记下)

1. **机械替换会误伤"夹具源码文本"**: `kernel-runcontext.test.ts` 里有一段**故意写成 `this.messageHistory` 的源码文本**(用来证明 K2 判据真在数它), 被我的批量替换一起改了 ⇒ 判据的判别力被悄悄削弱。**已回退该文件**。
2. **机械替换会误伤同名对象**: `p2p-agent-harness-flow.ts` 是个**假 session**(没有 `actor`) ⇒ 改成 `this.actor.state...` 会**运行时炸**(tsc 因为是 `any` 不会报)。**已回退该文件**。
3. **`= [` 多行赋值不能靠正则收尾**: 替换后留下 `);` 的缺口; 我第一版"深度>0 遇到 `;` 就补 `)`"的算法在**合法语句**上也插了括号 ⇒ 把 4 个测试文件改成**语法错误**(vite transform 直接崩, 而 `tsc` 竟然仍是绿的)。**正解**: 回退全部, 用"从赋值起点扫到**括号/方括号/花括号深度 0 的那个 `;`**"的语句跨度算法重做。

### 43.5 教训

- 机械改名**必须先量"同名不同物"的处数** (假对象、夹具源码文本、注释散文), 再决定替换范围;
- `tsc` 绿**不等于**能跑: 语法结构错在 vite/oxc 那层才崩 —— 改完要看**能不能真跑**, 不看单个静态检查;
- 兜底/回退是你自己的工具: 批量改名一律**先 `git checkout HEAD -- <文件集>`** 再换算法重做, 不要在坏版本上打补丁。

## 44. K5 步骤⑧ 批次 2: `currentAgentId` 访问器删除 (22 → 0)

- pi-sdk 内 22 处 (2 写: `applyExecutionRequest` / 构造器 · 20 读) → `this.actor!.state.agentId`; 访问器 getter/setter 删除。
- **外部读 1 处**: `index.ts` 的 CLI 状态行 `(a as any).currentAgentId` —— 删访问器后会**静默变成 `—`** (TS `private` 只是编译期, 运行时本来可达, 所以它一直"能用")。
  改成 `(a as any).actor?.state?.agentId` (**读本体**)。教训: 删一个字段前, 必须把**全仓**同名引用找全 —— 外部通过 `as any` 读私有成员是隐形的耦合。
- 判据探针换到仍存在的访问器 (`private get currentChannelId`) —— 否则棘轮判据的判别力用例会静默失效 (它靠"注入一处引用 ⇒ 必须红")。
- 账: `K5_ACCESSOR_SURFACE.currentAgentId 22 → 0` · K2 `accesses 22 → 0` · 总数 `108 → 86` · K5 移交 `22 → 0`。
- 剩余 3 个访问器 = 86 处 (`currentChannelId 25` · `currentGoalId 23` · `currentRunId 38`)。

## 45. K5 步骤⑧ 批次 3: `currentGoalId` 访问器删除 (23 → 0)

- pi-sdk 内 23 处 (3 写: `applyExecutionRequest` / Goal 绑定 / Run 登记后回填) → `this.actor!.state.goalBinding`; 访问器删除, 原地留下口径注释 (leo 的"Goal 绑定必须显式"不变)。
- 外部生产引用 **0** ✓ (只有判据/测试在用)。
- **判据自己的探针要跟着换**: 棘轮判据有条判别力用例, 靠 `PI_SRC_TEXT.replace('this.currentGoalId', ...)` 模拟"改了盘没改账" ⇒ 该字段归零后这个替换**命中 0 次** ⇒ 用例会**静默失效**。已把探针换成仍存在的 `this.currentChannelId`。
- **跨台账判据当场抓到一次漏改**: 我先猜了 K2 那行的 `declaredAt`, 猜错 ⇒ 只有 K5 那本改成 0, 判据报
  `currentGoalId 访问数 K5=0 ≠ K2=23 (两个台账必须逐字相等)`。**用盘上原文改**, 不要凭记忆拼台账行。
- 账: `K5_ACCESSOR_SURFACE.currentGoalId 23 → 0` · K2 `accesses 23 → 0` · 总数 `86 → 63` · K5 移交 `23 → 0`。
- 剩 2 个 = 63 处 (`currentChannelId 25` · `currentRunId 38`)。

## 46. K5 步骤⑧ 批次 4: `currentChannelId` 访问器删除 (25 → 0)

- pi-sdk 内 **25 处** (22 行 — 有几行出现两次) → `this.actor!.state.channelId`; 访问器删除。
- **全仓同名命中分三类**, 只有一类要改: ① `web/ui/message-renderer.ts` 的 `ctx.currentChannelId` 是**另一个对象** (渲染上下文) ② `web/client-loop-status.ts` 的 `(window as any).currentChannelId` 是**浏览器全局** ③ `index.ts` 两处 `agent.currentChannelId` / `(a as any).currentChannelId` 才是 session 私有读 ⇒ 改成读本体。
- **`index.ts:1992` 是一处真安全逻辑**: `/resume` 前比对"这个 run 属于哪个 channel 与本会话当前 channel 是否一致"。删掉访问器后 `active` 会**静默变成 `''`** ⇒ 判断直接通过 ⇒ **那道闸无声消失**。这类"删字段会静默跳过一段逻辑"的位置比"读出来显示成 —"更危险。
- **判据探针第二次搬家**: 棘轮判据的两条判别力用例 (bumped / shaved) 原锚在 `currentChannelId`, 该字段归零后又会命中 0 次 ⇒ 一起改锚到最后一个还没删的 `currentRunId`。
- 账: `K5_ACCESSOR_SURFACE.currentChannelId 25 → 0` · K2 `accesses 25 → 0` · 总数 `63 → 38` · K5 移交 `25 → 0`。
- 只剩 1 个 = 38 处 (`currentRunId`)。

## 47. K5 步骤⑧ 批次 5 (收尾): `currentRunId` 访问器删除 —— 5 个访问器全部归零

- pi-sdk 内 **38 处** (37 行) → `this.actor!.state.activeRun`; 访问器删除。**至此 pi-sdk 里 5 个 session 字段的访问器全清**
  (`messageHistory` / `currentAgentId` / `currentGoalId` / `currentChannelId` / `currentRunId`), 129 处调用点全部改成直接读写本体。
- **13 处外部命中全是 Goal 对象的同名字段** (`Goal.currentRunId`, 定义在 goal-store): `web/server.ts` · `goal-flywheel-wiring` ×5 · `goal-store` ×3 · `execution-supervisor` ×2 · `index.ts` ×1
  ⇒ **一个都不许动**。这是"同名不同物"最大的一次 —— 只看名字会误伤 13 处。
- **判据的夹具也要跟着换形态**: `scanRunIdSeed` 的播种模式原是 `runId: this.currentRunId,`, 源码改成读本体后该模式**命中 0** ⇒ 判据会假红。已把模式改成 `runId: this.actor!.state.activeRun` (语义不变: 恰好一处播种读取, 且在 `seedRunContext` 体内), 并把 `frozenTotal` 从 38 改成 **0** (名字已从 pi-sdk 消失)。
- **棘轮判据的探针第三次重做**: 5 个字段全 0 之后, "从真实片段替换" 与 "减向 (count < frozen)" 都**失去前提**。按纪律把过时断言**改写成现在真正相信的性质**:
  ① 探针改成"前置一行对已删字段的**假引用**" (判据是纯函数, 只吃文本, 不需要真实锚点) ⇒ 计数 0→1 必须红;
  ② "减向"断言删除并写明原因 (0 不可能更少, 该方向在归零后无前提) —— 保留"缺失冻结值 ⇒ 红"与"盘上=台账"两条。
- 账: `K5_ACCESSOR_SURFACE` 5 项**全部为 0** · K2 `accesses 38 → 0` · **`RUN_CONTEXT_ACCESS_TOTAL = 0`** (8 个字段全部迁出 Pi) · K5 移交字段 `38 → 0`。
- K5 删除前置第 ⑥ 条 ("Pi 的字段访问只剩推理所需的临时变量") 现在有了**可数的证据**: 5 个字段在 pi-sdk 侧 0 引用。

## 48. K5 步骤⑧ 的"完成"做成可重算的声明 (不是自报)

### 48.1 交付物

| 位置 | 内容 |
| --- | --- |
| `plan-channel-actor.ts` | **`K5_STEP8`** —— 终态声明: `claimedComplete: true` + 三个**派生**计数 (5 访问器归零 / 5 暂存字段已删 / 入口 4/4) |
| 同上 | `K5Stage` 联合类型加 `'field-deletion-complete'`; `K5_PROGRESS.stage` 前推到此值 |
| `gate-scan.ts` | **`scanStep8Completion(piCode, step8, surface, fieldDeletion)`** —— 把三条件**从盘上重算**: 任一不成立而声明完成 ⇒ 红; **事实三条全成立而台账说没完成 ⇒ 也红** (双向, 事实优先) |
| 门测试 | 4 条判别力: 注入访问器引用 ⇒ 红 · 把 `private _history` 放回来 ⇒ 红 · 入口 3/4 却说完成 ⇒ 红 · 事实完成却说没完成 ⇒ 红; 且测试**直接接 `K5_STEP8` 本体**, 不绕开台账 |

### 48.2 顺带的纪律修正

门的 stage 断言原本钉死 `'registry-built'` —— 阶段前推后它红了。**保留原意图、改指向**: 断言改成"当前阶段值 + '阶段已过容器 ⇒ 容器文件必须真的在'",
而不是把断言放宽成"阶段随便什么都行"(那等于删掉这条门)。

### 48.3 现在"⑧ 完成"是机器可查的

三条条件全部可数: 访问器引用 0 处 · 暂存字段声明 0 个 · 入口 4/4。任何后来的改动只要让其中一条不成立, 门立刻红;
反过来, 谁想把 `claimedComplete` 改回 `false`(退出声明), 也会红 —— 台账必须与事实同步。

## 49. K4 第一步: 越权欠账的**排期过期**变成门能抓的东西 (3 条欠账逐条对盘 + 重排)

### 49.1 逐条对盘 (只读核实)

`AUTHORITY_DEBT` 实际是 **3 条** (K1 那本"12 处 B 类直连"是 `plan-constraint.ts` 的另一本账, 别混):

| 禁令 | 文件 | 调用 | 台账 | 盘上实测 |
| --- | --- | --- | --- | --- |
| channel-must-not-write-goal | web/server.ts | setContinuation | 1 | **1** (3401, 唤醒 Goal 自动继续) |
| channel-must-not-write-run | web/server.ts | setRunStatus | 2 | **2** (3463 变更注入 / 3598 外部 approve-resume) |
| channel-must-not-write-run | web/server.ts | recordRecovery | 1 | **1** (3580 人工批准后继续) |

结论: **台账与盘上逐字一致** (双向判据本身也在跑)。四处都是**用户发起的控制动作** (唤醒 / 变更注入 / 批准继续) —— 按内核口径应由**内核控制面**执行写, channel 只提交请求。

### 49.2 发现的真问题: 排期过期 ("欠账烂在账上")

三条都写着 `payDownIn: 'K5'`, 而 **K5 已收工** (有 `K5_STEP8` + `scanStep8Completion` 作证) —— 欠账没还, 承诺却已经过期。
台账自己的注释就写着"不许台账烂在上面", 但**没有任何判据在管这件事** ⇒ 它只能靠人记得。

### 49.3 交付物

| 位置 | 内容 |
| --- | --- |
| `roster.ts` | **`STAGE_STATUS`** (数据): 各 K 阶段的完工状态 (`K0/K2/K3/K5 done` · `K1 partial` · 其余 `not-started`) |
| `roster.ts` | `DebtEntry` 加 **`note`** (重排/还款路径必须写明); 三条欠账 **`payDownIn: 'K5' → 'K4'`** + note 写明"K5 的目标是字段/入口收口, 未含跨层写"与还款路径 (内核控制面代为写) |
| `gate-scan.ts` | **`scanDebtPaydownStaleness(debt, stageStatus)`** —— ① 排期指向**已收工**的阶段 ⇒ 红 ② 没排期 ⇒ 红 ③ 没写还款路径 (note < 10 字) ⇒ 红 |
| `kernel-authority.test.ts` | 4 条判别力: 过期排期 / 缺 note / 缺排期 / 阶段状态本身必须与事实一致 (`K5 === 'done'`, `K4 !== 'done'`) |

### 49.4 为什么这条小而有价值

"排期过期"是一类**没有载荷的承诺**: 它让报告与台账看起来在推进, 实际那条欠账已经**无主**。
现在把"无主"变成可判的: 谁想把 K4 标成 `done` 而不还欠账, 门立刻红; 谁想静悄悄把 `payDownIn` 指向下一个阶段而不写原因, 也红。

## 50. K4 第二步: 内核控制面 (RunControl) 落地 + 真还第一条债 (`recordRecovery`)

### 50.1 形状 (先打通一条, 再批量搬)

| 位置 | 内容 |
| --- | --- |
| **新增** `kernel/control.ts` (~130 行) | `submitRunControl(req, ports)` —— **唯一入口**: 校验 (kind 合法 / 定位字段齐 / `origin` 非空不许匿名) → 派发到注入的 port → **记审计**; 一律**返回结果对象**, 不抛 (禁用异常表达"拒了") |
| 同上 | `RUN_CONTROL_KINDS` (3 种) + `RUN_CONTROL_REQUIRED` (每种必填 runId/goalId) —— **数据**, 判据与实现共用一份 |
| 同上 | `runControlAudit()` 环形 200 条: **拒收也留痕** (否则"谁被拒过"无从追) |
| `roster.ts` | `KERNEL_FILES` 登记 `kernel/control.ts` (双向判据: 盘上多一个未登记内核文件 ⇒ 红) |
| `web/server.ts` (approve 路由) | 不再直接调 `recordRecovery` —— 改为 `submitRunControl({kind:'record-recovery', origin:'web', …}, { recordRecovery })`; 拒绝时回 500 并带上 `outcome.detail` |
| `AUTHORITY_DEBT` | **删掉 `recordRecovery` 那条**; `AUTHORITY_DEBT_FROZEN_AT` **3 → 2** (棘轮下调, diff 里可见) |

### 50.2 为什么"还债"是机器可验的

`kernel-authority.test.ts` 的欠账判据是**双向**的 (`debtDiff`: missing / extra 都必须为空):
- 删了台账条目而 channel 侧**还有**调用 ⇒ `missing` 非空 ⇒ 红;
- 调用真没了而台账**还留着** ⇒ `extra` 非空 ⇒ 红。
⇒ 欠账从 3 降到 2 这件事**不是声明**, 是被判据逼出来的。

### 50.3 边界与诚实的说明

- 内核**不许 import 业务模块** (`KERNEL_ALLOWED_IMPORT_PREFIXES = ['kernel/']`) ⇒ 写原语由 **ports 注入** (依赖倒置)。
- 因此 channel 里**仍保留** `import('../agents/run-store.js')` 的 import 边 —— 那是**端口绑定 (wiring)**, 不是写调用;
  禁令的检测模式是 `write-call` (只数调用), 口径差写在债条的 `note` 里。若要连 import 边也去掉, 得把 wiring 挪到组合根 (下一批可选)。
- 新增 `src/test/kernel-control.test.ts`: 派发 (3 种 kind 各走自己的 port) · 拒收 7 种坏形状全返回 `ok=false` 且不抛 · 审计留痕 (含拒收) · 台账一致性 (欠账里不许再有 recordRecovery, 冻结值已随还款下调)。

### 50.4 代价可见

新增内核文件 ⇒ 代码档预算 1800 → **1924** (K3 棘轮当场拦, 同步冻结值)。

## 51. K4 第三步: 剩下 2 条债搬完 ⇒ `AUTHORITY_DEBT` 归零 (3 → 0)

### 51.1 一个必须先补的语义 (否则会把"被拒"当"成功")

pause/abort 路由**依赖 port 的返回值** (`setRunStatus` 返回 `{ ok:false, reason }` 表示状态迁移被拒, 入口据此回 409),
而第一版控制面只看"port 有没有抛异常" ⇒ **被拒会被当成成功** (409 变 200)。
⇒ 控制面补 **`portRefusal(res)`**: 端口返回 `{ ok:false }` ⇒ 控制面也报 `ok=false`, `detail = '端口拒绝: <reason>'`, 并把
`result` **原样带上** (调用方可能还要用它)。这条语义有专测 (端口拒绝 / 端口正常两向)。

### 51.2 三处搬迁 (channel 只提交请求)

| 入口 | 原写法 | 现写法 |
| --- | --- | --- |
| `/api/goals/:goalId/wake` (force 加急) | `await setContinuation(goalId, {...})` | `submitRunControl({ kind:'wake-goal', origin:'web', goalId, payload:{...} }, { setContinuation })` |
| 变更注入的停止 (seam 回调) | `const r = await setRunStatus(...)` | `submitRunControl({ kind:'set-run-status', … }, { setRunStatus })` ⇒ `{ ok, reason: detail }` |
| `/api/runs/:runId/{pause,abort}` | `const r = await setRunStatus(...)` + 409 | `submitRunControl(...)` + 409 (**语义不变**: `detail` 去掉 `端口拒绝: ` 前缀后就是原来的 `reason`) |

搬完 `grep` 确认: `web/server.ts` 里**零裸调用** (`setRunStatus` / `setContinuation` / `recordRecovery` 都只在 ports 绑定处出现)。

### 51.3 收尾

- `AUTHORITY_DEBT` **清空** (`AUTHORITY_DEBT_FROZEN_AT` 3 → 0); `STAGE_STATUS.K4` → `'partial'` (欠账已归零, 但模块边界收口未完)。
- **空台账是被判据盯住的事实**: 双向欠账判据在空台账下通过 ⇒ 说明三条禁令在 channel 侧**零违规**; 任何一处新的直写都会立刻让 `missing` 非空 ⇒ 红。
- 顺带修一处**夹具依赖实时台账**的坏味道: 判别力用例原从 `AUTHORITY_DEBT` 取样本, 台账归零后用例自己失效 ⇒ 改成**自造样本** (判别力不该随台账长度变化)。

## 52. K6 第一步: ModelRuntime 台账 + 门 (先立判据再写运行时)

### 52.1 先纠正一处顺序错误

上一轮我建议"跳去 K7 还 B 类直连账", 但设计页写明 **交付顺序不许跳: K0 → … → K5 → K6 → K7 → …** ⇒ K6 在前。
(K7 那本 `B_DIRECT_IMPORT_DEBT` = 6 个 target × 2 次匹配 = 12, 已对盘一致; 它的修法要**动 CR 包导出面**, 属挂起的"公开契约"口径 ⇒ 更该等 K6 之后按顺序做。)

### 52.2 为什么 K6 第一件事不是写运行时

K2 的实操证明过一条通用判据: **新层出现后, 旧写口的调用点数只许不变或减少** —— 它**拦回过一次 assistant 的实现**。
K6 要动多供应商并发, 最大的风险不是"写得慢", 而是"新层顺手把 provider 配置 / API key / 全局 model 也改了",
于是同一份状态有了两个写口 —— 那不是新能力, 是**回归**。所以先量、先冻、先用判据把"只读"钉住。

### 52.3 交付物

| 位置 | 内容 |
| --- | --- |
| **新增** `kernel/plan-modelruntime.ts` (105 行数据) | `MODEL_WRITE_PORTS` (9 个旧写口 + 实测调用点数, **合计 11**) · `MODEL_WRITE_PORTS_FROZEN_AT = 11` · `MODEL_RUNTIME_ACQUIRE_RULE` (只读 + ratchet 口径文案) · `MODEL_RUNTIME_CAPABILITIES` (9 项能力, 每项带 why + status) · `MODEL_RUNTIME_OUT_OF_SCOPE` (5 条红线: 不改 provider 配置/API key/默认 URL/Global model/Run snapshot) · `K6_PROGRESS` (stage + runtimePath) |
| `gate-scan.ts` | **`countModelWritePortCalls(files, name)`** —— **台账与判据共用的唯一口径** (全仓排除 `test/` `kernel/`, `name(` 匹配数, **去掉含 `function name` 的声明行**) · **`scanModelRuntimeLedger(...)`** 五条规则 (棘轮逐口重算 / 合计自洽 / 能力与越界清单 / 假进度 / 只读要求) |
| **新增** `test/kernel-modelruntime.test.ts` | 5 用例: 扫描面非空 (门不许空转) · 盘上台账一致 · **口径抽查三条** · **6 种坏形状判别力** · 清单不是空壳 |

### 52.4 实测到的两个事实

1. **旧写口 11 个调用点**, 其中 `setCustomProviderSnapshot` 自己占 5 处 (config-store 3 + custom-provider-store 2);
2. **3 个写口在主仓零调用** (`addCustomProvider` / `updateCustomProvider` / `removeCustomProvider`) —— 登记为"零调用写口", 棘轮只许不变或减 (将来要么收进控制面, 要么删)。

### 52.5 口径与判别力的两个坑 (都在写门时暴露)

- **声明行会被算成调用点**: 第一版口径把 `export function addCustomProvider(` 自己那行算了一个调用点, 额度虚高 ⇒ 口径加"去掉含 `function name` 的声明行", 并配一条反例断言。
- **判别力用例的方向**: "回退"必须在**盘上**制造新调用 (不是改账里的数字); "账没跟上"要让**盘上少**调用。方向写反的用例会绿着却什么都没验。

## 53. K6 第二步: `kernel/model-runtime.ts` 只读骨架 (连接复用 · timeout · cancellation)

### 53.1 形状

```
acquire(snapshot) -> ModelLease
  · 只读: 只读 provider/model/baseUrl/timeoutMs/capabilities, 一个都不回写 (snapshot 常被上层冻结, 写它会当场抛)
  · 池: key = provider::model::baseUrl ⇒ 同一 key 只开一条连接 (再 acquire 记 reused)
  · call(req, {signal}): 每次调用一个**受控 AbortController** —— 超时与外部取消都走它 (底层只认一个 signal)
      超时 ⇒ ModelTimeoutError 且**中止**底层调用 (不是干等); finally 里 clearTimeout (否则定时器泄漏)
      外部取消 ⇒ ModelAbortError; 已取消的 signal ⇒ 立刻拒, 不发起调用
  · release(): 归还租约 (不关连接, 连接归池); 归还后再 call ⇒ 明确报"租约已归还"
  · closeAll(): 进程收尾关所有连接
```

`ModelRuntimePorts.openConnection(snapshot, signal)` 由外部注入 ⇒ **内核不 import 业务模块** (KERNEL_ALLOWED_IMPORT_PREFIXES)。

### 53.2 只读的两半证据

| 半 | 判据/测试 |
| --- | --- |
| 机械半 | **`scanModelRuntimeFile`**: 运行时文件里**不许出现任何旧写口名** (9 个), 且必须真含 `acquire(` / `AbortController` / `clearTimeout`, `capabilitiesDone` == 清单里 done 的条数 |
| 真跑半 | **冻结 snapshot 上 acquire+call 一路不抛** (`Object.freeze` + 严格模式 ⇒ 任何回写都会抛) · 端口调用计数证明"只读路径不碰写口" |

### 53.3 能力状态推进 (只许按事实)

`connection-pool` / `timeout` / `cancellation` → `done` (3/9); `K6_PROGRESS.stage` `not-started → runtime-built`;
`capabilitiesDone = 3` 由判据机械核 (和清单里 done 的条数必须相等 ⇒ 不许自报)。

### 53.4 真跑用例 (6 条)

只读 (冻结 snapshot) · 连接复用 (`opened=1` · `reused=1` · 不同 model 另开) · timeout (30ms 预算 vs ~200ms 调用 ⇒ `ModelTimeoutError` + `timeouts=1`) ·
cancellation (20ms 后 abort ⇒ `ModelAbortError`; 已取消的 signal 立刻拒) · 归还后不可用 · 判据读写分离 (含 4 条判别力, 含"空文件 ⇒ 拒跑")。

### 53.5 一个随阶段前推而失效的判别力用例

坏形状 ⑤ 原本是"标 `not-started` 而文件在" —— 阶段前推到 `runtime-built` 后它就**不成立了** ⇒ 改成**把账硬写回 `not-started`** 来构造同一个坏形状。
(同类修正已第四次: **断言的前提会随事实变化, 改了事实就要回头改断言的构造方式**, 而不是把断言删掉。)

## 54. K6 第三步: 多供应商并发 + 429 退避 (能力 3/9 → 5/9)

### 54.1 为什么这两个一起做

它们是**一对**: 退避决定"什么时候让出通道", 并发决定"同时能开几条"。分开做会出现两种假通过 —— 只有退避: 不限并发 ⇒ 429 越退越多;
只有并发: 不限流 ⇒ 撞 429 就整体失败。两者都只动运行时内部, 不碰 provider 配置 (没有越界风险)。

### 54.2 形状

| 位置 | 内容 |
| --- | --- |
| 并发槽 | **逐 key** 计数 (`active` + `waiters`); 排队**可取消** (排队期间 abort ⇒ `ModelAbortError`, 且**不发起到连接**); 还槽时**直接转让**给下一个等待者 (不空放) |
| 429 识别 | `isRateLimited(x)`: 端口把限流表达成 **返回值 `status:429`** 或**抛带 status 的错**都认; 也认 `error` 里含 429 / rate limit |
| 退避策略 | **`BACKOFF_POLICY`** 写成数据 (base 200ms · factor 2 · max 5000ms · **jitter ±25%** · maxRetries 3) + **`backoffDelayMs(n, {retryAfterMs, random})`** 纯函数 (抖动可注入 ⇒ 测试可精确断言); **尊重上游 `Retry-After` (取最大值)** |
| 语义 | 退避用**注入的 sleep** ⇒ 真跑用例不必真等; 退避期间取消 ⇒ 立刻抛; 重试用尽 ⇒ 如实失败并写明"限流重试用尽 (N 次)" (不许无限重试) |
| 统计 | `concurrencyWaits` · `maxObservedConcurrency` · `rateLimited` · `retries` · `lastBackoffMs` |

### 54.3 真跑用例抓到一个真 bug (记下来)

**槽"转让"后等待者又自增一次** ⇒ `active` 虚高 (实测 `maxObservedConcurrency = 2` 而端口侧真实峰值 = 1)。
用例里两条证据并排 (端口自己的 live 计数 + 运行时的统计) 才照出来: 只断言运行时统计会看到"2 条并发"而**以为**上限没生效;
只断言端口计数则**看不到**运行时的账错了。⇒ 修: 转让路径置 `granted` 标记, 被转让者不再自增。

### 54.4 一个用例自身失效的形态 (第 5 次同类)

"退避期间取消"原本用**瞬时 sleep** 注入 ⇒ 整个重试循环在 abort 之前就跑完了 ⇒ 用例**绿着却什么都没验**。
修法: 给这条用例一个**真占住时间**的 sleep (≤60ms)。教训: **注入式"让时间消失"的夹具, 用了它就得保证被测的时序真的存在**。

### 54.5 真跑用例 (8 条)

并发上限 `maxConcurrency=1` 不重叠 (峰值 1 + `concurrencyWaits=1`) · `=3` 真重叠 (峰值 3 且无排队) · **排队可取消** (排队者从未发起) ·
429 两次后成功 (`retries=2` · 退避序列 **`[200,400]`** 在 jitter 归零时可精确断言) · 一直 429 ⇒ 用尽即失败 (`retries=3`) ·
退避期间取消 ⇒ 立刻抛 · 纯函数退避曲线 (含封顶 5000 与 `Retry-After` 取最大) · `isRateLimited` 三向。

## 55. K6 第四步: 熔断 (三态) + 能力检查 (能力 5/9 → 7/9)

### 55.1 熔断

| 项 | 内容 |
| --- | --- |
| 策略 (数据) | **`BREAKER_POLICY`**: 阈值 3 次 · 冷却 30s · 半开探测 1 个 |
| 三态 | `closed` → (连续失败达阈值) → `open` → (冷却到) → `half-open` → (探测成功) `closed` / (探测失败) **立刻重新开路并重新计时** |
| 快速失败 | 开路且未到冷却 ⇒ 抛 `ModelCircuitOpenError` 并**不发起调用、不排队** (fail fast 才有意义) |
| 什么算失败 | **`countsTowardBreaker`**: 取消 (调用方) ✗ · 429 (交给退避) ✗ · 超时 ✓ · 其它故障 ✓ |
| 诊断 | `breakerStates()` 逐 key 只读状态 · `stats.circuitOpened / failFast / halfOpenProbes / breakerClosed` |

**一处口径必须写清楚 (否则用例会自己骗自己)**: 端口**自己**抛 `AbortError` 而**运行时的 signal 没被取消**, 那是"供应商侧中止" ⇒ **计入熔断**;
只有"运行时 signal 被取消"(外部 signal 或超时) 才归一化成 `ModelAbortError` 而**不计入**。
⇒ 所以"调用方取消不计入熔断"这条用例必须用**外部 signal** 制造取消 (第一版用端口自抛的 AbortError, 结果熔断被打开了 —— 是**用例的场景不真实**, 不是实现错)。

### 55.2 能力检查 (直接怼 K6 红线的一项)

`acquire(snapshot, { require: ['vision'] })`:
- snapshot **声明了** `capabilities` ⇒ 缺一个就拒 (`ModelCapabilityError` 列出缺哪些);
- snapshot **没声明** `capabilities` ⇒ **不许猜**: 拒并写明"未知能力 (snapshot 未声明 capabilities)";
- **拒在开连接之前** ⇒ 真跑断言 `opened === 0` (不浪费一次连接);
- 只读: 不写 snapshot / 不改任何 provider 配置 (冻结的 `capabilities` 数组跑完仍原样) —— 这正是"不自行改 provider 配置 / API key / 默认 URL / Global model / Run snapshot"那条红线的具体形态。

### 55.3 真跑用例 (4 条 12 个断言组)

开路 → 快速失败 (断言**调用计数没涨**) → 冷却未到仍快速失败 → 冷却到放探测 → 成功闭合 (半开/闭合计数各 1) ·
半开探测失败 ⇒ 重新开路 (开路次数 2) · 不计入熔断三类 (外部取消 ✗ · 429 ✗ · 故障 ✓, 含四个纯函数断言) ·
能力检查两向 + 连接零开销 + 冻结数组原样。

## 56. K6 收尾: provider fallback + usage 记录 ⇒ **能力 9/9, K6 收口**

### 56.1 fallback: 只从 snapshot 派生候选, 绝不碰全局

`snapshot.fallbackProviders` (只读, 来自 Run snapshot) ⇒ 候选清单 = `[主 provider, ...备用]`; 每个候选**各建副本** (`{...snapshot, provider: p}`) 而不是改原对象。
入口 `acquire()` 的只读契约不变: 真跑断言**原 snapshot 的 provider 与备用列表跑完一字未改**。
逐候选: 各自过熔断门 → 各自取并发槽 → 各自跑 429 退避 → 失败则下一个; 全失败 ⇒ 结果里写明 `全部候选失败 (p1 → p2)` (不假装成功)。
**取消不回退**: 调用方 abort 就是不要了, 再去试别的 provider 是错的 (真跑断言 `fallbacks === 0`)。

### 56.2 收尾时暴露的真问题: 加 fallback 会**悄悄改掉单候选的契约**

第一版把所有失败都收敛成"结果对象", 于是 **timeout / 熔断开路**在**单候选**场合从"抛出"变成了"返回失败" —— 调用方原来靠 `catch (ModelTimeoutError / ModelCircuitOpenError)` 区分, 现在**静默拿不到**了 (3 个既有用例当场红)。
⇒ 定成规则并写进实现注释: **时机类拒绝 (熔断开路) 与超时的"抛"只在没有下一个候选时保留**; 有下一个候选才回退。
```ts
if (err instanceof ModelTimeoutError) { if (ci + 1 < candidates.length) { fallback; } else throw err; }
if (gate) { if (ci + 1 < candidates.length) { fallback; } else throw new ModelCircuitOpenError(gate); }
```
**教训**: 给一个老契约"加新路径"时, 先问"**单候选场合的行为有没有变**" —— 新能力最容易的代价就是把老调用方的 catch 悄悄废掉。

### 56.3 usage 记录 (内核不碰 RunStore)

`ModelRuntimePorts.recordUsage` **注入**: 成功与"全候选失败"都记一条 (真实 provider / model / ms / attempts / fallback 标记 / 结果里透传的 usage)。
**记账端口抛错不许影响调用结果** (只记 `usageDropped`) —— 真跑用例专门让它抛一次, 断言调用照样成功。
内核只读统计 (`usageRecorded / usageDropped`), 落盘/入账交给 K4 控制面那边的端口实现 ⇒ 不越界。

### 56.4 真跑用例 (6 条) + 一个用例随事实失效

回退 (只读断言 + `opened === ['p1','p2']`) · 无备用 ⇒ 行为与以前一致 · 全候选失败 ⇒ 写明试过哪些 · **取消不回退** ·
usage 两向 (含端口抛错) · **429 用尽也可回退** (容量问题不是 bug; 且断言限流不开路)。
另: 判据用例里"`capabilitiesDone=9` 应判红"在 **9/9 全做完后变成恒真** (9 == 9 不再报) ⇒ 换成 `3` 才构造得出坏形状 —— 与"判别力用例随事实失效"同类 (第 6 次)。

## 57. K7 第一步: Harness 唯一系统调用门的台账与执行点普查 (门先于实现)

### 57.1 开工前的关键判断 (决定这一步该做什么)

设计页 §7 K7 目标形态 = `discover → permission → policy → budget → idempotency → execute → verify → evidence → event`,
覆盖普通工具/MCP/Skill/delegate/子 Agent/联系人/支付/文件写入/外部通信; 判据 = **任何绕过 Harness 的代码都视为架构缺陷**。

**判断: Harness 作系统调用门是「提升」不是「新建」** —— `deny → pre-tool-validator → react-harness` 这条顺序**已经存在**,
且被源码级断言锁着 (`src/test/pi-harness.test.ts`: "那唯一一处对 pre-tool-validator 的引用在门面内部 (注入), 不在调用点";
`pre-tool-validator` 在调用点匹配数 **0**, 真身是 `validatePreToolUse` 且只在 `pi-harness.ts` 出现)。
⇒ K7 要补的不是"再写一个门", 而是三件: ① 9 阶段 + 9 覆盖面**清单化** (每项写清"现在谁承担它")
② 把"谁在执行"**数出来并逐点分类** ③ 收敛旁路。

### 57.2 执行点普查 (口径必须写成纯函数, 否则台账与盘上必然对不上)

口径 = **剥掉块注释 (保留换行) 与行注释之后**, 数 `\.execute\s*\(` 与 `executeTool` 的**匹配次数**。
先量后判: 原始匹配置信 17 处, **逐点分类**后得到真形状:

| 类别 | 处 | 说明 |
| `main` | 1 | `pi-sdk.ts:2715` 主执行点 (经门链) |
| `skill` | 2 | `pi-sdk.ts:989 sk.execute` · `pi-sdk.ts:4144 skillRegistry.execute` (+ `skill-adapter.ts:673` 第二条路径) |
| `mcp` | 1 | `pi-sdk-tools.ts:2570 mcp.executeTool` |
| `registry` | 1 | `tool-registry.ts:153` (唯一咽喉候选) |
| **`bypass`** | **3** | `workflow-pivot-loop.ts:613` 直执行 · `pi-sdk.ts:1330` 内置 tscTool 直调 · skill 的第二条路径 |
| `homonym` | 4 | `loop.execute` (`pi-sdk.ts:1831` / `workflow-pivot-loop.ts:1129`) · `session.execute` (`browser-cdp.ts:799`) · `params.execute` (`chain-wallet.ts:246`) · `options.execute` (`agent-delegate-server.ts:200`) |
| `decl` / `import` / `ledger-string` | 4 | `pi-ecosystem-mcp/index.ts:272` 定义 · 两处 import 列表 · `plan-deletion.ts:32` 台账字符串 |

**为什么必须分类**: 不分类就会把 17 处一律当"工具执行", 得出完全错误的缺口数 (同名不同物 4 处 + 定义/import/台账 4 处 = 8 处根本不是执行点)。

### 57.3 判据 (`kernel/gate-scan.ts`)

`stripJsComments(src)` (块注释按行占位, 不破坏行号) + `countHarnessExecSites(src)` (唯一口径) +
`scanHarnessLedger(ledger, { readFile, planFileExists })`:
9 阶段顺序/唯一/gate 文件真存在 · 9 覆盖面 canonical 真存在 · 执行点**逐文件重算**并与台账相等 (增=新旁路未登记 / 减=改了盘没改账) ·
合计 == `progress.execSitesTotal` · 旁路逐条有替代路径 (五条件第 ① 条) 且目标文件真在 · 台账自报与盘上**双向**一致 ·
**文件读不出来 ⇒ 拒跑** (不许跳过)。

### 57.4 门当场抓到我自己的三处错 (真跑才发现)

① 路径口径混用 (gate 写仓根相对、普查写 `src/` 相对) ⇒ 11 条 finding;
② 我**凭空写了一个不存在的 `goal-flywheel/limits.ts`** —— HardLimits 真身在 `src/agents/goal-flywheel/run-closure.ts`;
③ 旁路 target 写成带括注的自由文本 (`skill 的两条执行路径 (pi-sdk.ts:4144 ...)`) ⇒ 文件解析失败。
⇒ 教训: **台账里的每个路径都是"必须存在的断言", 写着它的时候就要能被判据核**; 自由文本式引用会被判据当场拆掉。

### 57.5 代价与验证

K3 棘轮当场拦 (代码 2555 → **2659** · 台账 1054 → **1184**) 并按纪律同步冻结值 (加门真涨行数, 写进日志让 diff 可见)。
验证: 10 个内核门 **181/181 全绿** · tsc 0 错 · 提交 `366c271`。

### 57.6 未做 (如实)

3 条旁路**尚未真收敛** (本步只登记 + 立判据) · 9 个覆盖面**尚未逐个走门** (现在只是"说得清谁管") ·
`scanHarnessLedger` 目前只核"台账与盘上一致", 还不能证明"执行路径真的只有一条" —— 那要等旁路收敛后由新的判据承担。

### 57.7 第二步 (待做) 的收敛计划 —— 锚点已实测, 下一个窗口可直接开工

**目标旁路**: `src/agents/workflow-pivot-loop.ts:613` `const result = await tool.execute(toolCall.args ?? {});`
(它就在"重复工具调用检测"之后 —— 与主路径 `pi-sdk.ts:2715` 的
`await ((toolCall as any).__t0 = Date.now(), tool.execute(expandHomeArgs(toolCall.args)))` **是两处独立执行**。)

**先要读清的一件事 (第二步的第一刀)** —— **2026-10-02 已实测并给定论**:
主路径**确实经门链**。证据 (全在 `src/agents/pi-sdk.ts`):
- 执行点 `2715` 位于 `private async runReActLoop(...)` (**2055** 起) 之内;
- 该函数内 ~2622 处有实调 `this.harness.*`(`ctx: this.harnessCtx()`), 注释逐字写着顺序
  `deny-pipeline → pre-tool-validator(4 步链) → react-harness(8-gate)`, 并按 `toolDecision.rejectedBy`
  分派拒收文案(`deny-pipeline` / `react-harness` / `harness-error`);
- 同一处注释记着旧账: **"旧实现是这三处在不同位置各自调用 (且有两条路径 fail-open); 现在 pi-sdk 不再散调任何 gate"**
  ⇒ 主路径的门是**前置且唯一**的。
⇒ 定论: **旁路数维持 3**, `workflow-pivot-loop.ts:613` 是**真旁路** (它在另一个类里执行工具, 那条路径上没有 harness 调用)。
⇒ 收敛工作量因此明确: 给 pivot loop 注入一个"每次工具调用前先过门"的**端口回调**(与 pi-sdk 用同一个 harness 实例),
让它与主路径共用判定, 而不是自己直调 `tool.execute`。

**收敛手法 (倾向, 未定案)**: 让 pivot loop 与主路径共用**同一个执行入口**(最自然是 `tool-registry.ts:153` 那个
"唯一咽喉候选"), 由它内部串 `deny → pre-tool-validator → execute → 读回自证`; 两处调用点只传参。
这样"执行只有一条咽喉"是可以被判据核的 (核调用点数: 除注册表自身外, 其它文件 `tool.execute(` 应为 0)。

**必须按五删除条件做**: ① 唯一替代路径=注册表 ② 全仓无有效引用 (逐文件 `grep` 到 0)
③ 真跑覆盖旧能力 (pivot loop 的工具调用要有真跑用例) ④ 一次完整回归 + 一次故障恢复
⑤ 留可回滚提交点。**8 字段删除记录**照 K1 的格式写。

**3 条旁路的处置预案**: ① pivot loop ⇒ 走上表咽喉 ② `pi-sdk.ts:1330` 内置 tscTool ⇒ 要么走门, 要么在
`K7_BYPASS_CANDIDATES` 里改成"显式诊断白名单"(写明理由与不可被模型触达的证据) ③ skill 两条路径
(`pi-sdk.ts:4144` 与 `skill-adapter.ts:673`) ⇒ 收敛成一条。

### 57.8 一处定性闭环 (2026-10-02 当天补)

普查里最后一条"待确认"已定性: `src/web/agent-delegate-server.ts:200` 的 `options.execute({...})` 是
**注入的执行器端口** (`execute?: (req: DelegateExecutionRequest) => Promise<DelegateExecutionResult>`, 见该文件 66 行) ——
委派服务器**自己不执行工具** ⇒ **不是旁路**, 新增 kind `port-callback` 归它, 并写明
"注入的那个执行器有没有走门"属于 delegate 覆盖面的事, 不在执行点普查里。
