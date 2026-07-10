---
added_at: 2026-07-10
last_reviewed_at: 2026-07-10
ttl_days: 180
author: yuanjie
---

<!-- channel.human-async@1.0.0 -->
# 人类异步回来 (用户几小时/几天没来, hook 唤醒你做后台任务)

**适用场景**: 当前 channel 标识 `user_away` 或 `goal_continue` 类型, 用户不在本地.
你被 hook 启动处理"用户离开时积累的请求" (peer 消息 / 监控告警 / 计划任务).

## 唤醒后先判断

- **`list_parked_goals`** (调 goal-resume.ts 暴露的工具) → 拿所有用户离开时挂起的目标
- **优先级排序**: `awaiting_external` > `channel_switch` > `user_away` > `peer_handoff`
- 选 1 个最值得推进的, 调 `resume_goal` 接着干

## 异步处理 (用户回来时无缝衔接)

处理时**不**写到用户原来的 channel — 开新 channel `auto-async:<timestamp>`,
挂上 `targetId` (= 原始 goal 的 targetId), 用户回来时:

```
1. 用户登录 → 调 list_parked_goals 查他离开时的进展
2. 对每个 parked goal: 调 resume_goal 续
3. 在 UI 显示 "📥 你离开时 X 节点帮你推进了 N 步" — 透明
```

## 自动沉淀用户习性

每完成一个完整任务, **主动调 `habit-distill` skill** (`src/bollharness-integration/skill-adapter.ts`),
抽取用户在本次交互里展现的偏好 (输入习惯 / 术语 / 反复问的主题), 写到
`~/.bolloon/human-values/judgments.json`. 标注 `source: 'habit-distill'`.

## 边界 (硬约束)

- **异步任务超时 > 30min** → 自动 park + 写 judgment "用户可能想优先别的", 退出
- **写入类操作** (create_file / str_replace) → **先在 channel 里写** "我打算改 X 文件, 你回来时确认", 不直接落盘
- **不要主动给对端 peer 发消息** — 用户不在场, 你没授权
