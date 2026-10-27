---
title: 双核 Kernel — 对等互维互保设计（草稿）
source: 由 leo 2026-10-27 双核意图推导，落地于 rust/crates/bolloon-kernel/src/dual_core.rs
created: 2026-10-27
last_confirmed: 2026-10-27
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [kernel, dual-core, ha, heartbeat, fencing, staggered-phase, reliability]
---

# 双核 Kernel — 对等互维互保设计（草稿）

> leo 原话: "kernel 是双核，互相有维护和保护，类似人类的双肺和双肾功能。细节上可以有分工。"
> 补充要求: "双核心跳互相是**间隔相位**运行，这样可以同时了解对方和自己的节奏。"

## 0. 一句话

两个**对等**的 kernel 实例（A / B）像双肺双肾一样：平时互相观测与维护，出事时互相保护并代偿；执行权仍靠 lease + fencing 唯一，分工只发生在"维护面"而不产生第二条执行路径。

## 1. 对等性（双肺/双肾的硬要求）

- A 与 B 都是**完整** kernel 实例，任一都能承担全部职责（可代偿）—— 不是主备热切。
- 现在 `ha-arbiter.ts` 是 `primary` / `standby` **单向**（备探主，主不探备），要升级为对等互判。
- Rust 侧 `dual_core.rs` 已是 `CoreId::{A,B}` 对等结构，`peer()` 取对端。

## 2. 间隔相位心跳（staggered phase, leo 指定机制）

- 两核对 `phase` 取 `interval/2` 错开：`A@0, B@Δ/2, A@Δ, B@3Δ/2 ...`
- 这样**每个核在自己两次心跳之间都恰好看到对方一次新鲜心跳** —— 同时感知"对方节奏"和"自己节奏"，不会被同拍淹没（同拍时双方一起跳，互不可见）。
- `BeatSchedule::delay_to_next_beat(start, now)` 用 `start + 相位 + k·间隔` 精确计算下一个本核起跳时刻，互插顺序由数学保证（测试 `staggered_phase_interleaves` 验证 `A0<B0<A1<B1<...`）。

## 3. 互维护 M（Maintenance，平时就在做）

| 编号 | 机制 | 说明 |
| --- | --- | --- |
| M1 | 双向心跳 | 双方都写、都探（今天只有备探主）；错相位保证互插 |
| M2 | 状态镜像与交叉校验 | 对端 checkpoint / evidence / runIds 一致性比对，不一致先报警不擅自改 |
| M3 | 租约续期与孤儿接管 | 复用 `reconcileOrphans + prepareResume`（宿主注入 `RecoveryAction`） |
| M4 | 配置对齐 | 心跳里 `configDigest`；版本漂移即拒绝接管（防旧核接管新事实） |

## 4. 互保护 P（Protection，关键在"不做什么"）

| 编号 | 机制 | 说明 | Rust 落地 |
| --- | --- | --- | --- |
| P1 | 防双主 | `O_EXCL` 主锁 + fencing token（单调递增，写入 Run 带 token，旧 token 写入作废） | `DualArbiter` takeover 时 `new_fence = max(本核, 对端最后 fence)+1`；`observe_peer` 拒绝旧栅栏重放（`old_fence_replay_rejected`） |
| P2 | 防误接管 | stale 时间 + 二次确认窗口双维成立，避免 GC/抖动误杀活核 | `should_takeover` 需持续 stale ≥ `confirm_window` 才接管（`stale_then_takeover_bumps_fence` 先 `confirming` 后接管） |
| P3 | 过载不接管 | 对端过载时**不接管**（先本地降级），否则双核一起雪崩 | 对端 `load ≥ overload_threshold` 且活着 → `peer-overloaded-defer`（`peer_overloaded_defers`） |
| P4 | 证据保护 | 接管必须写 Run evidence，禁止静默改事实（原则 9） | 接管后调 `RecoveryAction::recover()`（端口注入，未注入则 Noop） |

## 5. 分工 D（可选偏向，不破坏单一执行路径）

- D1：A 偏执行面（queue / lease / cancel / 模型租约），B 偏维护面（checkpoint 落盘 / 证据校验 / 恢复预热 / cron / 仲裁）。
- D2：分工只是**偏好**不是权限，任一核都能顶全部（双肺可代偿）。
- D3：**执行权唯一**永远由 lease + fencing 决定，分工分的是"维护面"—— 不产生第二条执行路径（守原则 3）。

## 6. 与架构原则的对齐

- 机制而非判断：心跳/租约/栅栏/校验判定零 I/O，读写心跳与恢复动作由端口注入（守 K1）。
- 事实来源唯一：Goal/Run/Evidence 唯一，双核只读+校验，写走同一个 RunStore。
- 状态预算（守原则 4）：**HA 自身只允许新增心跳/lease/fencing 三类状态，不允许新增任何业务状态**。

## 7. Rust 落地现状（2026-10-27）

文件：`rust/crates/bolloon-kernel/src/dual_core.rs`（保留旧 `ha.rs` 不动，逐步迁移）。

- `BeatSchedule`：错相位调度（A 相位 0，B 相位 interval/2）。
- `DualArbiter`：纯判定（互维 M + 互保 P 的判定逻辑），状态只含 seq/fence/对端心跳/首次 stale 时刻。
- `DualGuard`：错相位起跳 → 写本核心跳 → 读对端心跳并 observe → 裁决接管 → 执行恢复。
- `FileHeartbeatStore`：心跳落 `~/.bolloon/kernel-ha/<core>.heartbeat.json`（对齐 TS 侧口径），用 `SystemTime` 墙钟使跨进程 stale 判定成立。
- 接线（`spawn_kernel_ha_from_env`，默认关闭）：
  - `BOLLOON_HA=1`：按 `BOLLOON_KERNEL_CORE`(A|B, 默认 A) 起一个核；两进程各选一个核即互维互保。
  - `BOLLOON_HA=both`：同进程启 A+B（仅本地演示，无进程级崩溃隔离）。
  - `BOLLOON_HA_HOME`：重定向心跳目录（默认 `~/.bolloon/kernel-ha`）。
- 已接线入口：`bolloon-cli`(`main`)、`bolloon-web`(`serve`)；`app-tauri` 通过内嵌 `bolloon_web::serve` 自动继承。
- 当前 `RecoveryAction` 接 `NoopRecovery`（Rust 侧 Run store 恢复动作待接入）；真正孤儿接管/恢复留给后续把宿主恢复动作注入。

测试（33 个 kernel 测试全绿，含 `staggered_phase_interleaves` / `stale_then_takeover_bumps_fence` / `two_cores_exchange_beats_via_store` / `file_store_roundtrip_and_stale`）。

## 8. TS 侧对齐

`src/kernel/ha/ha-arbiter.ts` + `ha-guard.ts` 已实现 `BOLLOON_HA=1` 主备互探与 `O_EXCL` 主锁。后续将其从"主备判定"升级为"对等互判"（本页 M/P/D），并补齐错相位心跳与 P3 过载不接管、P2 二次确认窗口。

## 9. 验收矩阵

| 验收点 | 方法 | 状态 |
| --- | --- | --- |
| 错相位互插 | 单测验证 `A0<B0<A1<B1<...` | ✅ Rust |
| 互维护（双向探测） | 两核经心跳存储互探 Alive | ✅ Rust（MemStore 真测） |
| 防双主（fencing） | 接管 fence 必须 > 对端最后 fence；旧栅栏重放拒绝 | ✅ Rust |
| 防误接管 | 持续 stale ≥ 确认窗口才接管 | ✅ Rust |
| 过载不接管 | 对端过载 → defer | ✅ Rust |
| 跨进程心跳 | 文件存储往返保真 + stale 判定 | ✅ Rust（单测） |
| 真实双进程接管 | 两 `BOLLOON_HA=1 BOLLOON_KERNEL_CORE=A/B` 进程，杀一个另一个接管 | ⏳ 待真跑 |
| 孤儿接管/恢复 | 接管后 `RecoveryAction` 真正 adopt orphan run | ⏳ 待接入 Rust 恢复动作 |
| TS 对等升级 | ha-arbiter 改为对等互判 + 错相位 | ⏳ 待做 |

## 10. 待办

1. Rust 侧把真实 `RecoveryAction`（reconcileOrphans + prepareResume）注入 `DualGuard`，替代 `NoopRecovery`。
2. 真实双进程接管真跑验收（kill -9 一侧，验证另一侧 fence 抬升 + 接管日志）。
3. TS `ha-arbiter` 升级为对等互判 + 错相位心跳 + P3/P2 补齐。
4. 配置对齐（M4 `configDigest`）纳入心跳载荷。
