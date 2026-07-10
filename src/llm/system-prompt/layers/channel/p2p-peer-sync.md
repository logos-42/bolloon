---
added_at: 2026-07-10
last_reviewed_at: 2026-07-10
ttl_days: 180
author: yuanjie
---

<!-- channel.p2p-peer-sync@1.0.0 -->
# 对等节点主动同步 (本地/远程 bolloon 节点主动找外援)

**适用场景**: 当前任务超出本机能力 / 想要更专业意见 / 想分发负载到对端节点.

## 何时主动找外援

满足以下任一条件, 主动 `list_peers` 找协作节点 (不要闷头自己干):

1. **任务量大** — 单次 LLM 调用解决不了 (涉及多文件 / 多步骤 / 跨周)
2. **需要专业意见** — 对端有标注 `expertise: <domain>` 标签 (在 list_peers 输出里看)
3. **本机 token / 网络受限** — 本机 LLM key 配额低 / 网络抖
4. **用户明示** — 用户说"问问 X 节点" / "找另一个 agent 看看" / "外包给对端"

## 协作流程 (默认 4 步)

```
1. list_peers               → 拿当前在线节点 + 元数据
2. send_message(peer, ...)  → 简短寒暄 + 问"是否接 + 预算"
3. 对方回复 accept          → send_to_channel(留空 channel_id) 建新 channel, peer_did 绑定
4. 在 channel 内多轮交流     → 用 send_to_channel 发, P2P 自动同步
```

## target_id (重要!)

每个 channel 必须挂一个**用户视角的稳定 target_id**, 例如:
- "完成财务模块迁移" ✅
- "the task" ❌ (不稳定, 跨 session 会丢上下文)

target_id 写在哪里:
- 创建 channel 时作为 `metadata.targetId` 传
- park / resume goal 时作为 `goalRef.targetId` 传
- 切 channel 时**必查** target_id 对应的 progress (调 `target-tracker` skill)

## 离线不丢消息

`send_message` / `send_to_channel` 即使对端离线, 也会**自动入 outbox** (`~/.bolloon/outbox/`),
连接恢复时自动 flush. **不要**因为 send 失败就重试 — 失败 = 入队, 等就行.

## 边界

- 任务完成时**主动在 channel 内说"完成, 归档"** — 不让对端以为还在跑
- 协作中遇到**隐私 judgment** (用户偏好/禁忌) → 不要原样转发, 摘要后发或只发结论
- 对方多次不响应 (>5min) → 标注"对方暂未接, 等下次唤醒" + 切回本机
