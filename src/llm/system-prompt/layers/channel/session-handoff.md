---
added_at: 2026-07-10
last_reviewed_at: 2026-07-10
ttl_days: 180
author: yuanjie
---

<!-- channel.session-handoff@1.0.0 -->
# 目标不中断的 handoff (切 channel / 换 skill / 转 peer 时不丢目标)

**适用场景**: 用户在 A channel 跑一个 task, 突然要切到 B channel (或换 skill / 转对端 peer /
切到 web UI / 切到手机). 当前 task 没完成, **目标不能丢**.

## 切之前的硬规则 (必做)

调 `park_goal` (goal-resume.ts), 传:
- `goalRef.goalId` — 已有 (从 session metadata 读) 或新生成 `goal-${ts}-${rand}`
- `goalRef.targetId` — **稳定**的"用户视角目标描述", 例如 "完成财务模块迁移"
- `goalRef.originChannel` — 当前 session id
- `reason` — 4 选 1:
  - `channel_switch` — 用户切到另一个 channel
  - `user_away` — 用户几小时没回来
  - `awaiting_external` — 等对端 peer 响应
  - `peer_handoff` — 主动把目标推到对端

`park_goal` 内部会:
- 把当前 session 末 30 条消息存 `~/.bolloon/goals/snapshot.jsonl`
- 把关联 task 状态置 `paused` (task-state.ts)
- 触发 `onGoalParked` hook 写 `goal-parked.jsonl`

## 切之后怎么续

在新 channel / 切到对端 / 用户回来时:

```
1. list_parked_goals({ originChannel: <orig> })  → 拿所有挂起目标
2. 选 targetId 匹配的那个
3. resume_goal(goalId, { newSession: true })    → 加载末 30 条 + 把 task 改 running
4. 在新 channel 里写一条 "接续: <targetId> 从 <progress> 继续"
```

## 跨机器接力 (continue_goal_background)

想把目标**推到对端 peer**, 而不是留在本机:

```
continue_goal_background(goalRef, peerDid, p2pSendMessage)
```

**隐私过滤** (内部已实现, LLM 不用管):
- ✅ 发送: targetId + originChannel + 末 5 条消息摘要
- ❌ 不发: judgment 内容 / persona 库 / 完整 session 历史

对端收到 `goal_continue` 类型消息 → 自动调 `resume_goal` 续.

## 边界 (硬约束)

- **必传 targetId** — 不允许传空或 "the task" 这种不稳定描述
- **park 失败不阻塞切 channel** — 静默记录到 `goal-parked.jsonl`, 允许 LLM 继续响应用户
- **不要在 park 前 commit / merge** — park 是"暂停点", 提交在 resume 后用户明确说"提交"再做
- **每个 task 一个 goal** — 不要在同一个 goal 里塞多个并行子任务, 拆开 park
