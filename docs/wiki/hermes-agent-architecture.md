---
title: Hermes Agent 架构借鉴 (多智能体协作/生命周期/工具循环/状态语义/workspace kinds)
source: D:\AI\hermes-agent (源码通读)
created: 2026-08-11
last_confirmed: 2026-08-11
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [hermes, architecture, multi-agent, subagent-lifecycle, tool-loop, status-semantics, workspace-kinds, kanban, borrow]
compiled_from: [hermes-agent-repo]
---

# Hermes Agent 架构借鉴

> 用户指定学习 D:\AI\hermes-agent 的五个主题, 对照 Bolloon 现状找可借鉴设计。

## 1. 核心多智能体协作层 — `agent/subagent_lifecycle.py` (540 行) + `tools/delegate_tool.py`

**设计哲学: 进程内线程协作 + 不可变契约 + 防伪 handle, 不依赖分布式 DB。**

- **不可变契约**: `SubagentLaunchRequest` / `SubagentHandle` / `SubagentStatus` / `SubagentTerminalState` / `SubagentResult` / `SubagentCancelResult` 全是 frozen dataclass, `PUBLIC_CONTRACT_VERSION = 1` (subagent_lifecycle.py:26, 50-136)。插件只能拿到契约对象, 拿不到 AIAgent 本体 (subagent_lifecycle.py:3-5) — 边界最小化。
- **状态机 9 态**: `SubagentState` = PENDING → STARTING → RUNNING → SUCCEEDED / FAILED / INTERRUPTED / CANCEL_REQUESTED → CANCELLED / UNKNOWN (subagent_lifecycle.py:38-47)。取消是两段式: `CANCEL_REQUESTED` (已受理) → `CANCELLED` (落地), 与"已请求但还没停"区分。
- **HMAC 签名 handle**: `capability = HMAC(secret, subagent_id + parent_session_id + created_at)` (subagent_lifecycle.py:375-381), `_record()` 校验: contract_version 类型严格 + capability 用 `hmac.compare_digest` 比对 + **父 session 必须匹配当前 active parent**。子 agent 拿到 handle 也伪造不了、跨 session 用不了 — 防提权。
- **correlation_id 去重**: 同一 parent session 内重复 correlation 直接拒绝 (subagent_lifecycle.py:210-216) — 幂等创建。
- **终态保留 1h**: `_TERMINAL_RETENTION_SECONDS = 3600`, registry 只保留终态快照, "never returns live records" (subagent_lifecycle.py:151, 390-400) — 结果可查但活动记录不外泄。
- **DaemonThreadPoolExecutor** (max_workers=8): wedged/abandoned 子任务绝不让 atexit join 阻塞解释器退出 (subagent_lifecycle.py:160-165)。
- **API**: launch / status / wait / cancel / result / reconnect (subagent_lifecycle.py:198-345)。`reconnect` 诚实报告序列化 handle 重启后无法重连, 而不是假装拉起新工作。
- **父绑定**: `bind_subagent_parent` contextvar 按 turn 绑定父 agent (subagent_lifecycle.py:172-184)。
- delegate_tool.py 侧: `_build_child_preserving_parent_tools` (子继承父工具但可裁剪), `interrupt_subagent` / `steer_subagent` (网关可干预子 agent), `list_active_subagents`, 最大并发/深度/超时全部可配置 (_get_max_concurrent_children / _get_max_spawn_depth / _get_child_timeout)。

**对照 Bolloon**: 你的多智能体协调走 orbitdb (分布式持久化, 跨设备, WAL 回放) — hermes 是进程内线程 + 契约。借鉴点:
① 契约不可变 + 版本号 (bolloon 的 sidechain/delegate 记录是自由 JSON, 可加 contract_version)
② handle 签名防伪造 (orbitdb 消息层可以给 subagent handle 加 HMAC, 防跨 channel 冒用)
③ 两段式取消 (CANCEL_REQUESTED → CANCELLED) 比单布尔 cancelled 更诚实
④ 终态保留 + 不泄活记录 (bolloon trajectory/sidechain 是 append-only, 可以加 retention)

## 2. 生命周期自持

- **子任务生命周期**: 见上 — launch/status/wait/cancel/result/reconnect + `request_hard_interrupt` (agent/interrupt_compat.py)。
- **Cron 自持**: `cron/` = scheduler + jobs + executions + monitor + `lifecycle_guard.py` + notepad。**lifecycle_guard 是精华**: 拒绝 cron 里含 `hermes gateway restart` / `launchctl kickstart` / `systemctl restart` / `pkill` 形状的 job (cron/lifecycle_guard.py:1-30) — 防"agent 自己安排自杀 → supervisor 复活 → 自动 resume → 再自杀"的 SIGTERM 循环。策略是**命令形状锚定** (只匹配真实命令标识符, 不匹配散文), 误报率低。
- **Session 生命周期**: docs/session-lifecycle.md — `SessionSource` (platform/chat_id/chat_type/user_id/thread_id 全描述, gateway/session.py), 会话过期 watching + 重启恢复 + 消息排队 (gateway/run.py)。崩溃后 auto-resume 会找回挂起 turn。
- **电池**: agent/battery.py 只是 TUI 状态栏组件 (psutil + 8s 缓存 + 5 档配色), 不是核心。

**对照 Bolloon**: bolloon 已有 agent-heartbeat (社交/整理心跳) + Watchdog + 运行中自愈 healMissingChannels — 方向一致。借鉴: lifecycle_guard 的"命令形状锚定拒绝"可以直接移植到 terminal 护栏 (现在 denylist 挡 kill -9, 可加"cron prompt 里含重启自身服务命令"检查)。

## 3. 工具调用循环 — `agent/conversation_loop.py` (7757 行, run_conversation @1422)

- **工具参数规范化**: `_canonicalize_tool_call_arguments` (字符串 → 规范化 JSON) + `_canonicalize_api_tool_calls` (把 API 返回的 tool_calls 消息就地规范化, 防格式漂移) (conversation_loop.py:894, 966)。
- **续跑提示**: `_get_continuation_prompt(is_partial_stub, dropped_tools)` (conversation_loop.py:792) — 工具输出被截断/工具被丢时给 LLM 显式续跑提示, 不是静默。
- **引用交接**: `_restore_user_after_reference_handoff` + `_should_skip_model_call_for_reference_handoff` — @引用交接场景跳过冗余模型调用。
- **计费/授权拦截**: `_billing_block_dict` / `_try_refresh_nous_paid_entitlement_credentials` / `_print_billing_or_entitlement_guidance` — 模型调用前拦截欠费/无授权, 自动刷新凭据。
- **Context 引擎选择**: `_apply_context_engine_selection` + `_notify_context_engine_turn_complete` (每轮结束通知 context engine)。
- **system prompt 缓存一致性**: `_stored_prompt_matches_runtime` + `_ensure_cached_system_prompt_static` + `_redecorate_prompt_cache_for_provider` (按 provider 重装饰缓存键, 防缓存错配)。

**对照 Bolloon**: bolloon 的 pi-sdk ReAct loop + workflow-pivot-loop 已有循环进度注入/完成度自查。借鉴: ① 工具参数规范化 (bolloon 有 LLM 文本猜格式 → 工具从未执行的坑, 已用原生 tool_calls 修, hermes 的 canonicalize 是防御纵深) ② continuation prompt 显式化 (bolloon 的 unreported 逃生门类似, 但 hermes 针对"截断/丢工具"专门提示) ③ 计费拦截前置。

## 4. status semantics

- **子任务**: SubagentState 9 态 (见 §1)。
- **会话**: SessionSource.chat_type ∈ {dm, group, channel, thread} + 会话状态/过期 (gateway/session.py)。
- **存储**: hermes_state_schema.py — SQLite schema 用 `schema_read_probe_statements()` (LIMIT 0 探针, 列解析在 prepare 时完成) 探测 live store 结构, 状态查询/压缩互不干扰。
- **电池**: 5 档配色类别 good/warn/bad/critical/dim (agent/battery.py:42-46)。

**对照 Bolloon**: bolloon 的 task 状态/循环状态是隐式的。借鉴: 把"已请求/已受理/已落地"三段区分 (CANCEL_REQUESTED vs CANCELLED) 引入 bolloon 的任务取消; 状态枚举集中定义 + 探针式 schema 校验 (bolloon 有 wiki_check 但运行时存储 schema 校验可以学 probe 模式)。

## 5. workspace kinds — `hermes_cli/kanban_db.py` + `tools/kanban_tools.py`

- `VALID_WORKSPACE_KINDS = {"scratch", "worktree", "dir"}` (kanban_db.py:135)。设计意图: **workspace_kind 把"协调"和"git worktree"解耦** — 研究/运维/数字分身 workload 和编码 workload 并存 (kanban_db.py:56-58)。
- 并发策略: SQLite WAL + `BEGIN IMMEDIATE` 写事务 + **tasks.status / tasks.claim_lock 的 compare-and-swap (CAS)** — 至多一个 worker 能认领任务, 输家看到 0 行受影响就退出, "无重试循环, 无分布式锁机制" (kanban_db.py:60-70)。原子性按 board (每个 board 独立 DB)。
- 生命周期: archived 任务的 scratch workspace 会被 prune (kanban.py:3185-3197, 非 scratch 不删)。

**对照 Bolloon**: bolloon 的 server-storage 已有 updateChannels 互斥锁 (2026-07-24)。借鉴: ① workspace_kind 显式建模 — bolloon 的 context-os 12+3 层文件夹可以加 kind 字段区分 scratch(临时)/worktree(项目)/dir(持久) ② CAS 认领替代 read-modify-write — bolloon 修过并发覆盖丢 channel 的坑, CAS (先 UPDATE WHERE status=claimed 再检查行数) 是比互斥锁更强的方案。

## 结论 (可落地 5 条)

1. subagent handle 加 contract_version + HMAC 签名 (防伪造/防跨 channel)
2. 取消改两段式状态 (CANCEL_REQUESTED → CANCELLED)
3. terminal 护栏加"cron/任务里重启自身服务"命令形状拒绝 (lifecycle_guard 模式)
4. 工具循环加参数 canonicalize 防御 + 截断/丢工具显式 continuation prompt
5. workspace/context-os 层加 kind 建模 + 认领用 CAS

## 落地状态 (2026-08-11 全部完成, 一次一 commit)

| # | 落地内容 | commit |
|---|---------|--------|
| 1 | `src/external-engines/delegate-handle.ts` — DELEGATE_CONTRACT_VERSION=1 + DelegateHandle (delegateId/ownerDid/correlationId/createdAt/capability), HMAC-SHA256 签名 + timingSafeEqual + ownerDid 强制匹配; delegate_to_engine 工具带 handle, sidechain 记录验真; 7 测试 | 84fe3b1 |
| 2 | `src/web/task-cancel.ts` 纯函数状态机 + `POST /api/tasks/:taskId/cancel` (pending→cancelled direct / running→cancel-requested→executor 观测落 cancelled); Task.status + 两态; 5 测试 | b66eecc |
| 3 | `checkTerminalCommand` 新增 6 条自生命周期命令模式 (bolloon restart / pm2 / systemctl / pkill / taskkill), 命令形状锚定不误伤散文; 测试 11 拒 7 放 | 45433bf |
| 4 | `canonicalizeToolCallArguments` 三级降级 (直接→截尾→去围栏) + continuationHints 续跑提示 (未知工具/输出>12K 注入【工具续跑提示】); 7 测试 | 97d35dc |
| 5 | Context OS 层 kind 建模 (12 stable / output·research work / tmp scratch) + 任务认领 CAS (withTaskQueueLock 互斥链 + claimTaskForExecution/claimNextPendingTask, 输家不重试); 8 测试 | 3ae042b |

顺带修复: minimax flaky (AbortController 装饰性 bug → boundedCall 限时静默跳过) + lefthook 并行→串行 (vitest worker 不再被 tsc 饿死) — 同 b66eecc。
