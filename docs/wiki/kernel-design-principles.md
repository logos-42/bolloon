---
title: Bolloon Kernel 设计原则与动机
source: compiled from current repository architecture and kernel migration decisions (2026-10-14)
created: 2026-10-14
last_confirmed: 2026-10-14
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [kernel, architecture, macro-kernel, pi-adapter, harness, supervisor, channel-actor, model-runtime]
---

# Bolloon Kernel 设计原则与动机

## 1. 一句话定义

Bolloon Kernel 是一个进程内的 Agent 运行机制核心：它不替 Agent 思考，也不替业务模块做判断，而是把模型、工具、通道和长期任务组织成一条可并发、可取消、可恢复、可审计的执行路径。

核心承诺是：

> Pi 负责想和说，Harness 负责准不准做，Kernel 负责怎么运行，Supervisor 负责什么时候继续，Goal/Run/Evidence 负责证明到底发生了什么。

这不是把所有逻辑集中到一个“大类”里，而是把高频、跨能力共享的机制集中起来，同时把业务判断和事实来源留在各自边界内。

## 2. 为什么需要 Kernel

最初的 Pi Agent 很适合完成一次对话，但长期任务、多通道和多模型并发会暴露出不同的问题：

1. 模型调用、会话历史、工具循环、通道状态、持久化和恢复容易混在同一个 Agent 对象里。
2. CLI、Web、手机端、Supervisor 等入口如果各自调用一套循环，就会产生第二条执行路径，行为逐渐漂移。
3. 多个 Run 共享可变字段时，消息历史、当前目标、当前通道和当前运行身份可能互相污染。
4. 模型供应商切换、工具执行、取消、超时和资源占用缺少统一的生命周期机制。
5. 长任务不能只靠页面或一次 `prompt()` 存活；它需要 Goal、Run、Checkpoint、Lease 和恢复判定。
6. 支付、通信、Skill 等高风险能力必须经过统一门禁，并把结果写入同一条证据链。

因此 Kernel 的动机不是“Pi 不够大，所以再造一个更大的 Agent”，而是把 Pi 中的机制依赖抽出来，使 Agent 智能和运行机制可以分别演进。

## 3. 选择宏内核，而不是全面重写

### 3.1 宏内核的含义

Bolloon 采用“进程内宏内核 + 微内核式接口”的折中：

- 共享机制仍在同一个进程内，避免每轮模型调用、工具调用和事件流都经过网络序列化。
- 模块之间通过明确的 Port、Adapter、Capability 和生命周期接口协作，不允许任意读取对方私有状态。
- Kernel 内部可以高效共享运行资源，但外部只能通过稳定入口提交请求、取消任务、获取状态和接收事件。

这保留了本地 Agent 的低延迟和低部署复杂度，又把最容易失控的边界冻结下来。

### 3.2 取舍

宏内核的优点是低延迟、调试直接、共享状态成本低、适合当前单机和多终端 Agent。代价是模块仍处在同一进程崩溃域，边界不如独立服务天然隔离。

当前阶段选择这个取舍，是因为真正的瓶颈是执行路径和状态所有权，而不是服务数量。只有当吞吐、故障隔离或团队边界明确要求时，才把某个 Port 外置成进程或服务；不能为了“看起来像分布式”提前引入网络状态同步。

### 3.3 为什么不立即完全替换 Pi

Pi 仍然可以作为一个 Agent Adapter：它负责 prompt 装配、模型协议适配、响应解析和兼容行为。Kernel 先接管机制边界，再逐步减少 Pi 的内部责任。

替换的判断标准不是文件行数，而是：

- 是否已有第二个 Adapter 能通过同一组 Kernel Port 运行；
- 是否能在不依赖 Pi 私有字段的情况下完成 Run、恢复和证据闭环；
- 是否能用同一套 Harness、Supervisor 和验收循环验证；
- 删除 Pi 旧路径后是否没有行为和事实来源倒退。

在这些条件满足前，直接重写 Pi 只会把已验证的兼容性重新变成风险。

## 4. 设计原则

### 原则 1：Kernel 只做机制，不做业务判断

Kernel 负责队列、Mailbox、Actor 生命周期、模型运行时租约、取消、超时、资源管理、传输端口和执行请求的调度。

Kernel 不负责判断“这个目标是否完成”“是否应该付款”“哪个 Skill 更适合”“回复是否可信”。这些判断属于 reducer、policy、Agent 或 domain module。

### 原则 2：Harness 不是第二个 Kernel

Harness 只做允许、拒绝、记录和 fail-closed。它可以阻止一次工具调用，但不负责长期调度、模型选择、通信管理或 Goal reducer。

这样才能区分两种问题：Kernel 判断“这次执行如何被运行”；Harness 判断“这次动作是否被允许”。

### 原则 3：单一执行路径

所有入口都应收敛到同一条路径：

```text
CLI / Web / Mobile / P2P / Cron / Supervisor
        ↓
Channel Actor / Mailbox
        ↓
ExecutionRequest → Kernel lifecycle
        ↓
Pi Adapter 或其他 Agent Adapter
        ↓
Harness beforeToolCall
        ↓
Tool / Skill / Capability
        ↓
afterToolCall → Run evidence → reducer → continuation
```

入口可以不同，事实来源和执行机制不能不同。一个新入口若需要复制一套循环，优先认为边界设计有问题。

### 原则 4：状态必须有明确所有者

状态按生命周期归属：

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 会话历史、通道身份、Agent 身份 | Channel Actor | 属于会话，不属于某个 Run |
| 当前 Run 的事件流、取消信号、意图 | RunContext / Run | 入口显式播种，不能靠全局 `currentXxx` 猜测 |
| 模型供应商、连接和并发配额 | ModelRuntime | 以 Port 提供，不散落在 Pi 实例字段 |
| 工具是否允许 | Harness / Policy | 决策可回放，核心约束失败时拒绝 |
| 长期目标、判据、下一次唤醒 | Goal / Supervisor | Goal 跨 Run，Run 只代表有限执行片段 |
| 发生过什么、凭什么完成 | Run / Goal Evidence | 不由 UI、日志或模型回答推断 |

新增状态前必须先回答“谁拥有它、谁能写它、重启后从哪里恢复”。

### 原则 5：事实来源唯一，视图可以很多

Goal 是长期目标事实，Run 是一次有限执行事实，Checkpoint 和 Evidence 是恢复与完成证明。Web、CLI、手机端和日志只能读取或投影这些事实，不能建立平行状态。

支付、联系、Skill 执行等领域可以有自己的 Store，但最终必须通过 Run/Goal Bridge 进入主证据链；“页面显示成功”不等于“任务完成”。

### 原则 6：端口优先于新核心状态

新能力优先以 Port、Adapter 或 Capability 接入，而不是新增全局 Map、独立队列、Session singleton 或新的 `currentXxx` 字段。

可接受的扩展通常是：

```text
Domain capability → Adapter → Kernel Port
                         ↘ Harness Gate → Run/Goal Evidence
```

这样可以替换供应商、执行器或传输方式，而不修改 Pi 主循环。

### 原则 7：核心约束 fail-closed，观察失败可降级

权限、预算、持久化、不可重复副作用和工具安全边界属于核心约束。核心约束自身失效时，宁可阻止动作并进入可诊断状态，也不能静默放行。

SSE、UI hint、调试指标等观察性能力失败，可以继续执行，但必须留下 degradation 记录。任何 fallback 都必须产生真实 Run 事实，不能出现“执行完成但没有 Run”的假成功。

### 原则 8：长期执行由 Supervisor 负责

Kernel 让一次执行可运行；Supervisor 决定何时继续。Supervisor 使用 Goal 状态、Lease、wakeAt、外部事件和 Run reducer 来选择下一步，不把长期调度塞进 Harness 或 Pi。

预算耗尽可以结束一个 Run，但不能自动把 Goal 判为失败；没有执行器只能诊断为 unresolved，不能伪造一次执行；外部等待必须可唤醒、可过期、可审计。

### 原则 9：证据先于成功文案

完成出口必须由结构化判据和证据决定。模型说“完成”、工具返回 0、支付成功或资源已下载，都不能单独让 Goal 变成 completed。

成功至少需要：动作真实发生、输出通过契约验证、命中目标判据、没有未解决项，并且证据已写入 Run/Goal。

### 原则 10：以删除和简化保持内核小

每个新增模块都要说明它解决的共享机制问题。不能提高任务成功率、结果可信度或资金安全的能力暂缓；不能证明自己是唯一执行路径的旁路逐步删除。

删除顺序优先是：重复入口 → 重复状态 → 重复日志判断 → 旧兼容分支 → 最后才是底层模块。删除前先用结构门和真跑验收证明没有调用者与事实依赖。

## 5. 各层职责边界

| 层 | 允许做什么 | 明确不做什么 |
| --- | --- | --- |
| Kernel | 队列、租约、取消、端口、生命周期、资源调度 | 业务判断、目标完成判断、工具策略 |
| Pi / Agent Adapter | prompt、模型请求、响应解析、兼容层 | 直接改 Goal、绕过 Harness、决定最终事实 |
| Harness | allow / deny / record / fail-closed | 长期调度、模型选择、通信编排、复杂业务流程 |
| Supervisor | 唤醒、抢 lease、恢复、重试、开新 Run、写 continuation | 工具授权、模型推理、替代 Run/Goal Store |
| Goal / Run Store | 持久化目标、运行、checkpoint、证据和状态迁移 | 替 Agent 推理，凭日志猜完成 |
| Policy / Reducer | 预算、权限、状态迁移和业务决策 | 持有底层执行队列，复制 Kernel 生命周期 |
| constraint-runtime | 提供约束原语、资源和能力接口 | 变成第二个 Agent 或第二个 Kernel |
| Tool / Skill / Domain | 实现具体能力并返回可验证结果 | 直接绕过 Kernel、Harness 或证据链 |

## 6. 一次请求如何运行

1. 入口把用户意图提交给 Channel Actor，而不是直接调用某个 Agent 私有循环。
2. Actor 建立或恢复 ExecutionRequest，并由 Kernel 分配 RunContext、取消信号和模型运行时资源。
3. Agent Adapter 组织上下文并请求模型；模型只提出下一步，不拥有执行权限。
4. 工具调用进入 Harness，依次经过未知工具、策略、预算、权限和幂等检查。
5. 被允许的 Tool/Skill 通过 Kernel Port 执行；结果和事件写入 Run。
6. reducer 根据 Run 结果更新 Goal、证据和 continuation；需要等待时交给 Supervisor。
7. 对外界面只投影事实，不自行推导“已完成”。

这条路径让多模型、多通道和未来的第二个 Agent Adapter 共享同一套取消、门禁、恢复和证据语义。

## 7. 与 constraint-runtime 的关系

`constraint-runtime` 是可复用的约束和资源原语层，不是 Kernel 的替代品。

- Kernel 提供运行机制：何时取得资源、如何取消、如何隔离、如何释放。
- constraint-runtime 提供约束能力：预算、配额、资源声明、能力检查和相关 Port。
- Harness 把这些约束放到具体动作的允许/拒绝点。
- Policy 和 reducer 决定约束结果对业务状态的影响。

因此它可以帮助实现宏内核，但不能单独实现多通道调度、Agent 生命周期、长期恢复或模型并发。把 constraint-runtime 直接扩成“万能运行时”会重新制造一个边界不清的第二内核。

## 8. 演进路线

当前路线遵循“先冻结边界，再逐步删除 Pi 内部责任”：

1. **K0：**冻结模块名册、所有权、禁止依赖和验收入口。
2. **K1/K2：**把 Run 级信号、Intent、EventSink 等显式放入 RunContext，减少隐式实例字段。
3. **K3/K4：**收敛执行入口，明确控制面和循环边界，避免多套 Agent Loop。
4. **K5：**以 Channel Actor 管理会话级状态，解决并发 Run 的会话污染。
5. **K6：**把模型供应商、URL、能力和并发资源收敛为 ModelRuntime Port。
6. **K7：**让所有 Skill/Tool 活路径进入 Harness 门，而不是只在旁路验证。
7. **K8：**统一 CLI、Web、移动端和外部事件的通信入口。
8. **K9：**接入第二个 Agent Adapter，验证 Kernel 不依赖 Pi 私有实现。
9. **K10：**删除已无调用者的 Pi 旧路径，并以真跑回归确认行为未退化。

K0–K10 的逐项完成度、机器门和历史决策见 [bolloon-native-macro-kernel.md](./bolloon-native-macro-kernel.md)；本页只维护稳定原则，不复制迁移台账。

## 9. 验证理念：验证闭环，不建验证操作系统

验证只回答三个问题：

1. 是否只有一条 Kernel 执行路径？
2. 危险动作是否必经 Harness，核心约束失败是否 fail-closed？
3. 崩溃、并发和重启后，是否仍能从 Goal/Run/Checkpoint 继续且不重做非幂等动作？

采用三圈验证：

- 日常开发：结构门 + 相关聚焦测试。
- 阶段验收：结构门 + Kernel Smoke + 代表性真跑。
- 高风险变更：再加三个故障样本——工具被拒、工具执行中 SIGKILL、两个 Worker 抢同一 Goal。

发布前再跑全量回归、真实端到端和必要的性能/移动端验证。当前不建立覆盖每个通道、每个模型、每个 Skill 的庞大验证操作系统；矩阵只随真实风险增长。

## 10. 明确非目标

以下内容不属于当前 Kernel 的目标：

- 把 Bolloon 立即拆成完整微服务集群。
- 把所有业务规则、支付状态、联系人状态和 Skill 内容搬进 Kernel。
- 用事件溯源替代所有现有事实 Store。
- 让 Harness 负责长期调度、模型选择或复杂工作流。
- 现在就删除 Pi，或为了减少文件行数重写已稳定的兼容逻辑。
- 为每个新功能新增一套队列、状态机、事件总线或 `currentXxx` 全局字段。

## 11. 新设计的五问清单

任何新增能力在进入代码前，必须回答：

1. 这是机制，还是业务判断？
2. 它的唯一事实来源是什么？
3. 它是否产生了第二条执行路径？
4. 它是否需要进入 Run/Goal 证据链？
5. 能否用 Kernel Port + Adapter + Harness Gate + Evidence 接入，而不修改 Pi 主体？

如果一个功能只能通过继续扩大 `pi-sdk.ts` 才能实现，优先回头检查边界；如果它能成为 Port、Adapter、Gate 和证据桥，才符合宏内核方向。

## 12. 最终判断

Bolloon 的 Kernel 不是“更大的 Agent”，而是一组让 Agent 能够长期、并发、受约束地工作的共享机制。它的价值不在于拥有最多模块，而在于让每个动作都能回答：谁提出、谁允许、在哪里运行、发生了什么、失败后怎么继续。

保持这个边界，Pi 可以被替换，模型供应商可以并发，通道可以增加，Skill 可以购买和执行，而核心的运行语义不必随每个业务功能重新发明一次。
