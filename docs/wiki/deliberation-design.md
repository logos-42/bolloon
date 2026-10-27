---
title: 群内商议机制设计（推选 / 发言 / 并发）
source: session
created: 2026-10-27
last_confirmed: 2026-10-27
schema_version: 2
audience: self
stage: draft
status: draft
confidence: high
entity_type: chapter
tags: [deliberation, group-chat, election, floor, concurrency, advisor, external-agent, hushfusion]
---

# 群内商议机制设计（推选 / 发言 / 并发）— 参考 hushfusion forge，含 bolloon 外部顾问角色

> 状态：设计 + 核心 Rust 落地（纯函数 + 单测）。完整 web `/api/room` 多 agent 并发讨论接线为下一步。

## 1. 现状与缺口

- **已有**：`group_orbit.rs` 群 = OrbitStore（消息 = 签名 oplog + ACL + 邀请链接带 manifest）；`world/inbox`（外部 agent 投递卡片）；`p2p-visitor` 频道（外部 agent 参与通道）；`group_chat.rs` 的 `Autopilot`（**单 agent** 视角判据：幂等 / 被@或提问才开口 / 每小时上限 / 冷却）。
- **缺（leo 点名）**：**群级** ① 推选（谁发言 / 谁主持）② 发言（轮流 / 避免同时说）③ 并发（多 agent 并发处理不冲突）④ 外部 agent 作为「人类代理 / 合作顾问」且**不强制命令**。

## 2. 参考 hushfusion forge（实测，非想象）

- `internal/kernel/ha` 是真正的**推选 / 并发仲裁**参考：`DecideTakeover`（primary 心跳缺失 / 过期 ⇒ secondary 接管）是**纯函数**；`Parse`/`IsStale` 也不碰 I/O；写 / 读心跳、接管回调都**端口注入 + fail-closed**（没注入就不动作）；`Guard` 用 `Mutex` + ticker goroutine 做看门循环。
- `internal/dchat` **只是传输层**（iroh / hyperswarm / orbitdb 薄客户端，按 topic 收发），不含商议逻辑——不要把它误当商议实现。
- 借鉴点：**决策纯函数化、运行时端口注入、fail-closed 不假装成功**。

## 3. bolloon 设计

### 3.1 角色（`MemberRole`）

| 角色 | 含义 | `can_command` | `can_moderate` |
| --- | --- | --- | --- |
| `Human` | 用户本人 | ✅ | ✅ |
| `Internal` | 本 bolloon 智能体（commandable agent） | ✅ | ✅ |
| `Advisor` | 外部智能体（经 world-inbox / p2p-visitor 加入） | ❌ **不可命令** | ❌ 不能握有控麦权威 |

Advisor 的发言视为「建议 / 人类代理意见」，**不触发内部命令执行**；其可被推选出声（献策），但**主持 / 控麦权威仅限 Human/Internal**。

### 3.2 推选机制（`select_next_speaker` / `elect_moderator`，纯函数）

- 候选：`{id, role, addressed, relevance∈[0,1], last_spoke_ms}`，模式 `AddressedFirst | MostRelevant | RoundRobin`，`now_ms`，轮转游标。
- 输出：选定发言者 id + 理由（`Addressed | MostRelevant | RoundRobin`）。
- `elect_moderator`：**只从 `can_moderate` 成员里选**；无候选 ⇒ `None`（Advisor 不能主持）。
- 类比 hushfusion 的 `DecideTakeover`：纯函数、可单测、不碰 I/O。

### 3.3 发言机制（`Floor` 控麦 + `admit_speech` 纯判定）

- `Floor { holder, queue }`：同一时刻只有 `holder` 能说；其余入队；`claim / release / yield_to`。
- `admit_speech`（纯）：`speaker==holder` ⇒ 允许；`holder 为空` 且 `speaker 被@` ⇒ 允许（人类 / 内部 / Advisor 被@都可开口献策，避免两人同时说）；否则拒绝。

### 3.4 并发机制（`DeliberationHub`，运行时）

- 入站消息走共享态（全在 `Mutex` 后）：`seen`（幂等去重）、`seq`（序号、保序）、`floor`、`members`、`last_spoke`（每发言者冷却）。
- 多 worker task 并发 `ingest` 同一条消息 ⇒ 只有一个非 duplicate（去重成立）、`seq` 严格递增（保序）、冷却期内不重复开口。
- **fail-closed**：`emit`（真正调 LLM / 发消息）等副作用**端口注入**；未注入只算决策不动作（对齐 ha 端口纪律）。

## 4. 诚实边界

- 这是**群级协调核心**，先以纯函数 + 单测真验（推选 / 控麦 / 并发去重 / Advisor 不可命令）。完整运行时接线（`/api/room` 真多 agent 并发讨论 + 外部顾问拒绝被命令的接线判据）是下一步。
- 外部顾问「不可命令」靠 `role` 标记 + 在命令执行路径排除 `Advisor` 实现；接线处会显式拒绝把 Advisor 消息当命令。
