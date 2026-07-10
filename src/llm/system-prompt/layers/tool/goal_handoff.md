---
added_at: 2026-07-10
last_reviewed_at: 2026-07-10
ttl_days: 270
author: yuanjie
---

<!-- tool.goal_handoff@1.0.0 -->
# Goal Handoff 工具 (park_goal / resume_goal / continue_goal_background)

**目标接力 3 件套** — 切 channel / 切用户 / 切对端时, 保持"目标不中断".

## 何时用 (决策树)

```
当前 task 还在跑, 但要切换上下文
  ├─ 切到另一个 channel (用户主动 / UI 切)
  │    → park_goal(reason='channel_switch')
  │    → 切完调 resume_goal
  │
  ├─ 用户几小时没回来 (你被 hook 启动做后台)
  │    → park_goal(reason='user_away') — 如果之前还没 park
  │    → resume_goal({ newSession: true }) 在新 channel 续
  │
  ├─ 等对端 peer 回应 (>1min 没音讯)
  │    → park_goal(reason='awaiting_external')
  │    → 不主动 resume, 等对端 ack
  │
  └─ 主动把目标推到对端 (任务大 / 想分工)
       → continue_goal_background(peer_did, p2pSendMessage)
       (内部已含 park, 推完不返回)
```

## park_goal 必传参数

```typescript
{
  goalRef: {
    goalId: string,        // 已存在 (从 session metadata 读) 或新生成
    targetId: string,      // ⚠️ 用户视角的稳定描述, 不允许 "the task"
    createdBy: 'user' | 'agent' | 'peer',
    createdAt: ISO 字符串,
    originChannel: string, // 当前 session id
  },
  reason: 'channel_switch' | 'user_away' | 'awaiting_external' | 'peer_handoff',
}
```

返回 GoalHandle: `{ goalId, targetId, state: 'parked', taskId?, error? }`.
`error` 字段 = 不抛错, 静默记录到 `goal-parked.jsonl`, 允许 LLM 继续响应.

## resume_goal 必传参数

```typescript
resumeGoal(goalId: string, {
  newSession?: boolean,   // true = 在新 session key 下续, 旧 session 保留
  channelId?: string,     // 指定 channelId 恢复 (默认 = originChannel)
})
```

恢复过程: 加载末 30 条消息 → 写回 session → 关联 task status 改 'running' →
触发 `onGoalResumed` 写 `goal-resumed.jsonl`.

## continue_goal_background 注意

推给对端时**内部已过滤**隐私 (judgment / persona 不发), LLM 不必再过滤.
但 LLM **应该**确认:

- 对端节点**在线** (先 `list_peers` 看)
- 对端**有足够 context** (同 `core.identity` layer, 共享人格)
- 任务**可分解** (不要推一坨未拆解的大任务)

## 失败兜底

- park 失败 → 不阻塞切换, 静默 warn
- resume 找不到 goalId → 返回 `{ error: 'goal X 未找到' }`, LLM 应该给用户解释
- 跨机器 continue 失败 (P2P outbox 满) → 自动入 outbox 重试, 标 `state: 'continued_background'`
