---
title: 群内子讨论与统一分享/邀请设计（orbit store 下的小组讨论 + 跨传输统一入口）
source: session
created: 2026-10-28
last_confirmed: 2026-10-28
schema_version: 2
audience: self
stage: draft
status: draft
confidence: high
entity_type: chapter
tags: [group-chat, orbitdb, sub-topic, subgroup, sharing, invite, transport, iroh, pubsub, acl]
---

# 群内子讨论与统一分享/邀请 — 「orbit 群聊 / pubsub / iroh 一样吗」的定位答案

> leo 原话：*「分享和邀请加入 orbitdb 的群聊和 pubsub 和 iroh 群聊一样吗？在一个群聊里面，小组内进行讨论，也就是一个组织内部进行讨论。所以有的时候，你需要把这个 orbit 的群聊和其他的功能混合在一块儿，或者是分开讨论。可以分享是最好的。」*

## 1. 结论先行：三者**不在同一层**，此前**确实不统一**

| 层 | 是什么 | 本仓库位置 | 有没有"群"这件事 |
| --- | --- | --- | --- |
| **存储 / 权威层** | OrbitDB events store：内容寻址 + hash 链 + 逐条签名 + ACL | Rust `bolloon-p2p/group_orbit.rs`（`GroupOrbitHub` · `OrbitStore`） | **有**，唯一真源 |
| **传输层** | 搬块 / 搬包 | TS `gateway-group.ts` / `hybrid-messenger.ts` / `iroh-transport.ts`；Rust 侧是 HTTP 点到点（`BlockExchange` 端口） | **没有**，不含群成员/邀请语义 |
| **分享 / 邀请层** | 投放与准入 | 本页新增：`/api/groups/{id}/share` + `/api/groups/join` | 此前**分裂三种机制** |

改造前的事实（均有源码为凭）：

1. **邀请**只有 orbit 群有：`make_invite_link` 签出 `bolloon://join/<gid>?t=<sig>&exp=&by=<owner>&m=<manifest>`，链接**自带 manifest ⇒ 对方开出的是同一个 store**（内容寻址，不是另建一个长得一样的群）。
2. 但**该邀请机能在运行时从未接线** —— 全仓只有 `group_orbit.rs` 自己的单测调用过 `make_invite_link` / `verify_invite_link` / `import_group`，**没有任何 HTTP 路由用到它**。
3. **分享**当时分裂成三套互不相干的机制：会话 → `token` 只读快照页；world card → 信封 broadcast/friends（friends 模式下没人收到时如实回报）；orbit 群 → 签名邀请链接。**且没有 `/api/groups/{id}/share` 这种针对群的入口**。
4. **pubsub / iroh 不是群**，也没有自己的成员登记；把它们跟"群"并列比是分层错位。

## 2. 群内小组讨论：**子讨论 = 独立子 store**，而不是给消息加 topic 字段

### 2.1 取舍理由

| 方案 | 后果 |
| --- | --- |
| 给每条消息加 `topic` 字段 | 要迁移既有 entry 结构；且"哪些人能在这个小组说话"仍无 scope —— 现有 `GroupAcl` 是**整群级**（`OwnerOnly` / `Whitelist` / `Open`） |
| **子讨论 = 独立子 store（选这个）** | 自带 manifest ⇒ 自带 ACL；**分享/邀请与整群自动同源**（同一套 `make_invite_link`）；不动既有 entry 结构 |

### 2.2 落地形状

- `GroupMeta.parent: Option<String>` —— 指向父群；**必须 `#[serde(default)]`**，否则既有落盘 `groups.json` 反序列化会失败（向后兼容）。
- `create_topic(parent, topic_id, name, members, kp, now)`：
  - 子讨论的 manifest = `GroupAcl::Whitelist(members)` ⇒ **只有组织内部能写**，且这是**硬约束**：`WriteAcl::allows` 与既有单测（`acl_owner_only_blocks_stranger_on_disk_store`）已钉死**本地 append 也会拦外人**（不是只在复制接收时才拦）。
  - **顺序即原子性**：先在父群写一条签名 `topic` entry（记录子讨论 id / address / 成员），成功后才建子 store ⇒ 父群写不进就直接失败，**不留孤儿子群**（单测 `topic_requires_parent_write_permission` 为证）。
- `topics(parent)`：按 parent 指针列出子讨论。

### 2.3 "混合"与"分开"如何共存

同一个群里可以两种都有：父群 = **混合**（大家都能看的公共主流）；子 store = **分开**（单独名称、单独成员范围、单独历史）。两者落在同一棵 orbit 树上，父群那条签名 `topic` entry 就是可发现、可复制、不可抵赖的指针。

## 3. 统一分享 / 邀请（leo 说"可以分享是最好的"）

一个入口，**整群与子讨论完全同源、同一套判据**：

| 模式 | 语义 | 产出 |
| --- | --- | --- |
| `mode=join` | 群主签**邀请链接** | `bolloon://join/…`（带 manifest + 过期）→ 对方开出**同一个** store，按其 ACL 写入 |
| `mode=read` | **只读快照**页 | `/share/<token>`，不加入也能看；token = 身份签名派生前 24 hex（不可猜，不依赖随机源） |

- `POST /api/groups/join`：把此前未接线的邀请机能在运行时闭环。验签所需的**邀请者公钥从链接里的 `by=<did>` 反解**（`Did::pubkey()` 同时支持本命 `did:pi:` 与互认 `did:key:z`）⇒ **不需要额外人工交换公钥**；签名被篡改则拒（e2e 已证）。
- 传输层无关：链接/快照都是**逻辑指针**，搬不搬得动取决于底下是 HTTP / pubsub / iroh；换传输不改语义 —— 这正是"分享要和 transport 解耦"的答案。

## 4. 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/groups/{id}/topics` | 建子讨论（`members` 就是"组织内部谁能发言"） |
| GET | `/api/groups/{id}/topics` | 列子讨论 |
| POST | `/api/groups/{id}/say` | 发言（**子讨论本身也是群 id ⇒ 直接复用同一入口**，无需改动） |
| GET | `/api/groups/{id}/messages` | 读历史（子讨论同样复用） |
| POST | `/api/groups/{id}/share` | 统一分享：`join` \| `read` |
| POST | `/api/groups/join` | 凭邀请链接加入同一个 store |

## 5. 门禁（真跑）

- `cargo test -p bolloon-p2p` **66/0**（新增 3 条：`topic_internal_write_outsider_refused` / `topic_is_separate_from_parent_but_recorded_in_it` / `topic_requires_parent_write_permission`）
- `cargo test -p bolloon-web` **17/0**（`share_bootstrap_dream_routes_e2e` 内真跑 HTTP：建群 → 建子讨论 → 两边发帖 → **子讨论消息不混进父群** → 父群留有签名 topic 记录 → `join` 链接带 manifest → `read` 快照页真能打开 → 未知模式明确报错 → 凭链接加入且同一 store → 篡改签名被拒）
- `cargo test -p bolloon-agent` **405/0** · `cargo build --workspace` **0 error**

**拾遗**：群消息的 HTTP 形状字段是 `content` / `sender` / `seq` / `timestamp_ms`（**不是** `text`）—— 这条是 e2e 真跑后才校正的，勿按印象写。

## 6. 诚实边界

1. **子讨论的访问控制是"谁能写"的 scope，不是读隐私**：非成员写不进去，但若对人拿到了底层 block 复制权限，仍然读得到内容。要"只有内部能读"需要加密或不分发，本批未做。
2. **成员变更意味着新 manifest ⇒ 新 address**：`Whitelist` 改成员会改变 store 寻址（manifest 参与寻址），本批**未提供**"就地修改子讨论成员"的迁移 / 换 store 路径。
3. **邀请链接只校签名与过期，不校"邀请者此刻还是不是可授权的人"**：若邀请者当时是群主、后来不是了，链接在过期前仍可用来加入（写入权限仍由 store 的 ACL 决定）。这是策略取舍，本批未收紧。
4. **传输层仍未切到 iroh**：Rust 侧跨机仍是 HTTP 点到点；本批做的分享/邀请是**逻辑指针层**，换传输不改语义，但也未在真 iroh 上跑过。
5. **只读快照页复用了会话分享那套通用渲染**（按 `role` 显示"我"/"智能体"），对群聊场景只做了"自己/他人"二分，没有为群聊专门定制视图。
