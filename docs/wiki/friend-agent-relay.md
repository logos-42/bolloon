---
title: 好友 × 对方开放的智能体 + 跨机对话 (设计 + 落地)
source: session
created: 2026-10-30
last_confirmed: 2026-10-30
schema_version: 2
audience: self
stage: current
status: current
confidence: medium
entity_type: chapter
type: design
since: 2026-10-30
owner: leo
tags: [contacts, friends, agents, cross-machine, rust-web]
---

# 好友 × 对方开放的智能体 + 跨机对话

> 用户需求 (2026-10-30): 「点击加的好友, 可以看到对方开放的智能体; 点击对方智能体可以跨机聊天」。
> 这一页记**设计取舍**与**诚实边界**, 代码落在 `rust/crates/bolloon-web/src/{native.rs,server.rs}`。

## 1. 数据流 (谁执行什么)

```
本机 (A)                                   对端 (B)
────────────────────────────────────────   ──────────────────────────────────────────
点好友 did_b
  GET  /api/friends/{did_b}/agents
    └─ 遍历 directory_peers 的基址
       └─ 逐个 GET {peer}/api/quic/addr 认领 did ───►  对端自报 did
    └─ GET {peer}/api/agents/public?did=did_a ─────►  GET /api/agents/public
                                                        ├─ 校验 did_a 是 B 的好友 (fail-closed)
                                                        └─ 列出 B 的开放智能体 (name/soul 摘要)
点某个智能体 + 说话
  POST /api/friends/{did_b}/chat                 ─────►  POST /api/agents/public/chat
       {agent_id, text}                                   ├─ 校验 from_did 是 B 的好友
                                                          ├─ 校验该智能体对好友开放
                                                          └─ call_model_metered() 真跑一轮
       {reply} ◄───────────────────────────────────────────  返回那句回答
```

**执行位置**: 推理发生在**拥有该智能体的那台机器**(B)。A 只是转发与展示, 不复制对方的 persona/记忆,
也不把对方的智能体塞进本机 agents 列表 —— 否则「同一份人格两个真源」必然分叉。

## 2. 权限与门禁 (两条都 fail-closed)

| 面 | 判据 | 拒绝时的返回 |
| --- | --- | --- |
| `GET /api/agents/public` | 必须带 `?did=` 且该 did 在本机 `friends.friends()` 里 | `{ok:false, error:"对方不是本机好友, 不列智能体"}` |
| `POST /api/agents/public/chat` | 同上 + 目标智能体对好友开放 | `{ok:false, error:...}` (不泄露智能体是否存在) |

- 代理面 (`/api/friends/{did}/...`) 先校验 `did` 是本机好友, 再找对端基址。
- 找不到对端基址 / 对端不在线 ⇒ 返回 `note` 说明**具体原因**(「已登记的 N 个对端里没有 X」),
  **不返回空数组冒充「对方没有智能体」** —— 这是本轮唯一的诚实底线。

## 3. 「开放」的语义与开关

- **缺省对好友开放**: 好友关系本身是双方明确同意过的 (好友请求 → consent), 所以默认可见;
- 关闭方式 = 在该智能体目录放一个标记文件 `~/.bolloon/rust/agents/<id>/private.json`
  (存在即关闭)。**不改持久化 schema**, 避免为一个开关动 `AgentView` 的存档格式;
- 本机 UI 目前没有这个开关的入口 —— 这算是已知缺口(见 §5)。

## 4. 为什么走 HTTP 代理, 不走 P2P 广播

- 现有基建里 `directory_peers` + `/api/quic/addr` 已经解决了「did → 可达基址」这一跳,
  复用它可以**零新增信任模型**; 广播式发现需要第二节点常在线且要处理去重/伪造;
- 代价: 双方节点必须**互相可达**(同机 / 局域网 / 有公网地址)。跨 NAT 目前依赖已有的 QUIC 直连,
  不做额外打洞 —— 打不通就如实报 `对端不可达`。

## 5. 诚实边界 (未做 / 做不到)

1. **跨 NAT**: 没有内网穿透时, 只有同机/同局域网/有公网基址的两端能互相拉取;
2. **对端智能体的多轮记忆**: 每次跨机消息是**单轮**(对端不带入之前的跨机上下文),
   要连续对话需在 B 侧按 (from_did, agent_id) 维护会话, 本轮未做;
3. **开放开关没有 UI**: 目前只能放/删 `private.json` 文件;
4. **附件/图片**: 只传文本;
5. **多端**: 眼镜/手机端没有这套入口 (手机是电脑端的感知窗口)。

## 6. 验收姿势 (可复现)

两台节点 (同机不同 `BOLLOON_HOME` + 不同端口) 是最小真环境:

```bash
# A 与 B 各自起服务
BOLLOON_HOME=/tmp/bl-a ./rust/target/debug/bolloon web --port 55001
BOLLOON_HOME=/tmp/bl-b ./rust/target/debug/bolloon web --port 55002

# B 建一个智能体; A 直连 B (互加好友 + 登记基址)
curl -s -XPOST localhost:55002/api/agents -d '{"name":"小测"}'
curl -s -XPOST localhost:55001/api/node/connect -d '{"url":"http://127.0.0.1:55002"}'

# A 看 B 开放的智能体; A 让 B 的智能体回一句
curl -s "localhost:55001/api/friends/<did_b>/agents"
curl -s -XPOST "localhost:55001/api/friends/<did_b>/chat" -d '{"agent_id":"<id>","text":"你好"}'
```

判据: 第一条返回 B 的智能体名 (说明跨机列举通了); 第二条返回 `{ok:true,reply}` 或
`{ok:false,error:"对端模型调用失败: ..."}` —— **后者也是过了两道门禁的真到达**,
只有 `{error:"...不可达"}` 才算链路没通。
