---
added_at: 2026-07-10
last_reviewed_at: 2026-07-10
ttl_days: 270
author: yuanjie
---

<!-- tool.p2p_request@1.0.0 -->
# P2P 工具集 (list_peers / send_message / broadcast / send_to_channel / check_inbox / agent_call)

P2P 工具的**语义区别** — 选错了会污染对端或浪费 token.

## 决策树 (按场景选)

```
想 "知道有哪些节点在线"
  → list_peers

想 "给某节点发一条短消息 (不建 channel)"
  → send_message(peer_id, message)
    e.g. 问对方是否接任务 / 通知进展 / 简单寒暄

想 "广播给所有节点"
  → broadcast_message(message)
    e.g. 广播"我刚发布了新版本 v0.2.16"
    ⚠️ 慎用 — 每次广播每节点都收一条, token 消耗 = 节点数 × 消息长度

想 "建一个长期 channel 与某节点多轮协作"
  → send_to_channel(channel_id='', message, peer_did)
    channel_id 留空 = 自动建; peer_did 绑定 = 后续消息通过 P2P 自动同步到对端
    用 channel 的场景: 跨多轮的复杂协作 / 需要保留上下文 / 切换后还能找到

想 "查看我收到的所有消息 (本地 + 远程)"
  → check_inbox(max=50)
    返回按时间倒序; 触发 onMessage hook 的消息都进 _inboxMessages

想 "调对端 agent 执行一个完整任务 (含 LLM 推理)"
  → agent_call(peer_did, task, options)
    ⚠️ 对端会启动独立 LLM 轮次, 消耗对端 token; 你拿回的是结构化结果
```

## 离线和连接

所有 send_* 工具**失败不报错给用户** — 自动入 outbox (`~/.bolloon/outbox/`),
等连接恢复自动 flush. 工具返回 `{ success: false, error: "queued" }` 视为成功.

如果你需要确认"对端真的收到了", 用 `check_inbox` 看是否有 ack 类型消息.

## 隐私过滤 (LLM 必做)

`send_message` / `send_to_channel` / `broadcast_message` 之前:

- ❌ 不发 judgment 库内容 (调 `humanValueStore.list` 看 privacy 标签)
- ❌ 不发 API key / 凭证 / 路径里的私密信息
- ✅ 可发: targetId / 任务描述 / 公开文档摘要 / 代码片段
- ⚠️ 摘要后发: 用户偏好 (改写为通用描述, 不带具体值)

## 接收端注意

`check_inbox` 拿到的不一定都是人类消息 — 也可能是对端 agent 调 `agent_call` 推过来的任务.
判断: 消息 metadata 里的 `fromDid` / `peerName` 字段; 是 DID 形式 = agent, 人类名 = 人.
