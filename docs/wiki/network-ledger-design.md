---
title: Bolloon Network Ledger — 区块链式网络账本 (设计计划)
source: raw/paste_1_112222 (leo 2026-09-21 设计稿 590 行) + 本仓现状
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: archived
status: stale
supersedes: [./pulse-ledger-design.md]
tags: [ledger, dag, finality, sync, pulse, design]
---

# Bolloon Network Ledger (bolloon-ledger/1)

## 0. 定位(这一条改变一切)

> **Network Pulse 不再是独立快照,而必须是从一条可验证、可追加、可同步的网络账本中实时重放出来的结果。**

```
Ledger blocks        = 事实
Blockchain settlement = 资金事实
Task / Trade replay   = 状态
Network Pulse         = 派生统计
CLI / MCP             = Agent 接入
Skill                 = 外部 Agent 使用协议
Web UI                = Ledger Explorer (账本浏览器)
```

**快照只能当加速缓存,不能当事实来源。** 本设计不依赖 EigenFlux,也**不要求第一版发新链**。

## 1. 核心结构:多节点签名区块 DAG + 可验证最终性

```
Genesis
  ↓
Block A ─────┐
              ├─ Block C
Block B ─────┘
              ↓
          Derived State
              ↓
 Network Pulse / Tasks / Trades / Web UI
```

区块(每个节点都可以出块, **引用一个或多个父区块**):

```json
{
  "network_id": "bolloon-mainnet",
  "height": 1204,
  "parents": ["sha256:block-a", "sha256:block-b"],
  "merkle_root": "sha256:...",
  "created_at": 1760000000000,
  "proposer_did": "did:key:...",
  "events": [],
  "signature": "..."
}
```

七条铁律:

1. 区块**只追加,不覆盖**;
2. 事件拥有**唯一 hash**;
3. 区块**引用父区块**;
4. 区块与事件**都需要签名**;
5. 节点**可以离线出块**,之后再同步;
6. **冲突分支不能删除**,必须保留并标记;
7. Pulse / 任务状态 / 交易列表都是**账本重放后的派生数据**。

## 2. 事件(协议 `bolloon-ledger/1`)

第一批事件类型(22 类):

```
network.genesis · network.member_joined
manifest.published
capability.offered · capability.withdrawn
peer.connected
task.created · task.quoted · task.accepted · task.rejected
task.started · task.progressed · task.completed · task.cancelled
payment.requested · payment.submitted · settlement.confirmed
result.published · result.verified
dispute.opened · dispute.resolved
```

事件结构:

```json
{ "event_id": "sha256:...", "type": "task.created", "subject": "sha256(task-id)",
  "issuer": "did:key:...", "occurred_at": 1760000000000,
  "payload": {}, "causes": [], "signature": "..." }
```

**公开 payload 白名单**:capability **粗类别** · 任务状态 · 金额**区间** · 结算网络 · 交易哈希或公开引用 · 内容哈希 · 结果 CID · 证明状态。

**绝不公开**:原始私钥 · **完整任务正文** · 私有 Agent 名称 · 精确身份关联 · 私有输入文件 · 私人交易上下文。

## 3. Pulse 的新定位:账本消费者

```
Ledger Blocks → Verifier → Event Reducer → Network Pulse Read Model
```

现有统计**全部保留**(Agent 数 · 活跃 Agent · capability 分布 · 最近活动 · `live/stale/unavailable` · `observed/verified`),
但**必须能通过账本完整重建** —— 删掉所有 Pulse 缓存后,下面两条命令必须得到相同结果:

```bash
bolloon ledger replay --from genesis
bolloon network-pulse rebuild
```

`GET /api/public/network/progress` **兼容保留**,但响应里必须带账本依据:

```json
{ "source": "bolloon-network-ledger", "head": "sha256:block-...", "height": 1204,
  "finality": "verified", "generated_from_events": true, "data": {} }
```

它只是**派生视图**,不是系统真相。

## 4. 任务与交易全部写入账本

**发任务**:`task.created → task.quoted → task.accepted → payment.requested → payment.submitted → settlement.confirmed → task.started → task.completed → result.published → result.verified`

**接任务**(接收方八步):① 验证发送方签名 → ② 验证任务事件**已进账本** → ③ 检查 capability → ④ 写 `task.accepted` / `task.rejected` → ⑤ **等待有效支付证明** → ⑥ 执行 → ⑦ 写结果哈希与 CID → ⑧ 由对方确认 `result.verified`。

**交易**:真实资金结算仍以**链上**为最终事实 —— 账本记录**意图/提交/结果**,EVM/Base 回执证明**实际结算**;`settlement.confirmed` **必须引用链上交易哈希**;`verified` **必须同时满足**支付 + 交付 + 内容哈希 + 签名;`local-dev` **只能记为测试结算,不得伪装成链上交易**。

## 5. 去中心化同步(加入时同步账本,而不是下载一个 snapshot)

```
读取 Skill → 获取 network_id 与 genesis_hash → 获取多个 bootstrap peers → 获取当前 heads
→ 请求缺失区块 → 验证 parent/hash/signature → 保存本地区块 → 重放事件
→ 发布自己的 member_joined 与 manifest
```

**CLI/MCP**:`ledger.get_genesis` · `get_heads` · `get_blocks` · `get_event` · `verify_block` · `sync` · `replay` · `subscribe`

**公开 HTTP**:`GET /api/public/network/ledger/{genesis, heads, blocks/:hash, events/:id, sync?after=<block-hash>}`

**浏览器加载**:读 genesis → 读 heads → 存本地 **cursor** → 只请求 cursor 之后的新区块 → 校验区块链 → 重放新事件 → 更新页面。(以后可加 `ledger/stream` 走 SSE/WS,**第一版先用 cursor 轮询**。)

## 6. 最终性三层

| 层 | 含义 | 页面文案 |
|---|---|---|
| `observed` | 单节点看到事件、签名有效,但**还没有其他节点确认** | 已观察到 |
| `confirmed` | **≥2 个独立签名节点**确认,且父区块完整 | 网络已确认 |
| `finalized` | 达到网络配置的 **witness quorum**,或事件已由**链上交易**最终确认 | 链上已结算 |

**不把单个节点看到的内容包装成全球最终事实。**

## 7. 存储

```
Source of truth:  ~/.bolloon/ledger/blocks/<block-hash>
                  ~/.bolloon/ledger/events/<event-id>
                  ~/.bolloon/ledger/heads.json
Derived:          task index · transaction index · capability index · network pulse index · public activity index
```

派生索引**全部可删除并从区块重建**。OrbitDB/IPFS 可作为**复制与传播层**,但**不能只使用可变 key-value snapshot**。

## 8. CLI / MCP / Skill

**CLI 新增**:`ledger init|join <link>|status|heads|sync|verify <block-hash>|replay|tail --follow|export --from <hash> --to <hash>`

**trade 输出必须包含**:当前状态 · **所属区块** · **event ID** · **head hash** · **finality** · 支付证明 · 结果证明 · 下一步动作。(`trade show|events|proof|reconcile`)

**MCP**:tools `bolloon_ledger_{status,sync,verify,replay,tail}` + `bolloon_task_{send,inbox}` + `bolloon_trade_{show,proof}`;
resources `bolloon://ledger/{genesis,heads,blocks/{hash},events/{id},tasks/{id},trades/{id}}`。
**外部 Agent 必须能自己验区块、自己验事件签名、自己检查父区块、区分三层最终性 —— 不盲信某个 API 返回的汇总数字。**

**新 Skill**:`skills/bolloon-network-ledger/SKILL.md`,必须覆盖 14 项(账本是追加式账本而非 snapshot API · 取 genesis · 取 heads · 同步缺失区块 · 验区块与事件 · 重放任务与交易 · 加入网络 · 发布 manifest · 发起与接收任务 · 自主支付 · 查链上结算 · **处理分叉/冲突/过期/未确认记录** · 哪些可公开 · 哪些必须保密)。
核心规则逐字写:**Never treat a progress snapshot as the source of truth. Fetch the ledger head, verify the block chain, and derive the current state from signed events.**

## 9. 网页 Explorer(取代"数字快照")

```
Genesis → Ledger Heads → Recent Blocks → Verify → Replay → Render
```

页面显示:当前 ledger height · 最近确认区块 · 网络 finality · 最近任务与交易事件 · capability 活跃变化 · 交易状态 · 链上结算记录 · 每条记录对应的 **block hash / event hash** · `observed/confirmed/finalized`。

`/api/public/network/progress` 可继续用于**首屏加速**,但必须带 `head / height / proof / source / derived_from`,且**浏览器仍可通过账本接口自行校验**。
**`stale` 的含义改为「同步滞后」,而不是「快照过期」。**

## 10. 六阶段实施

| 阶段 | 内容 |
|---|---|
| **1 账本协议** | genesis · 区块格式 · 事件格式 · **canonical encoding** · hash/签名/Merkle proof · observed/confirmed/finalized |
| **2 本地 Ledger Store** | 内容寻址区块存储 · heads 管理 · **原子写入** · 区块验证 · 事件验证 · 从 genesis replay · 派生索引重建 |
| **3 P2P 同步** | handshake · heads exchange · missing block sync · 多父区块 · **分叉保留** · witness 确认 · 节点离线恢复 |
| **4 任务与交易接入** | task/payment/settlement/result/dispute 事件 · 任务状态从账本重放 · 交易状态从账本重放 |
| **5 CLI/MCP/Skill** | ledger CLI · task/trade CLI · MCP tools+resources · `bolloon-network-ledger` Skill · 外部 Agent 加入示例 · 双节点与多节点协议验证 |
| **6 网页 Explorer** | ledger heads · block/event API · cursor 增量加载 · **浏览器端校验** · 任务与交易时间线 · Pulse 派生展示 |

## 11. 验收标准(13 条,全部硬性)

1. **删除所有快照后可以从 genesis 重建页面状态**;
2. 新节点可以**同步历史区块**;
3. **篡改区块会被拒绝**;
4. **篡改事件签名会被拒绝**;
5. 多节点**离线产生的分支可以合并**;
6. 单节点事件**只能显示为 `observed`**;
7. 交易状态能够**从事件重放**;
8. **链上交易哈希能够验证 settlement**;
9. Agent **重启后不会重复付款**;
10. 网页加载的是**增量区块**,而不是重新下载全量快照;
11. 公共接口返回的是**可验证记录**;
12. Network Pulse **只是派生索引**;
13. 其他 Agent **只依靠 Skill + CLI/MCP** 就能加入并使用网络。

## 12. 与本仓现状的关系

| 现有件 | 处置 |
|---|---|
| `src/agents/network-pulse.ts`(事件白名单/匿名化/去重/隐私阈值/三态) | **保留语义**,改为**账本消费者**(Verifier → Reducer → Read Model) |
| `network-pulse/events.json` | 升级为内容寻址 `ledger/{blocks,events,heads.json}` |
| `export-network-pulse.ts` + cron 每 2h 快照 | **降级为缓存/兜底档**(不再是事实来源) |
| `emitTradePulse`(交易写路径挂钩) | 保留,改为**写账本事件** |
| `wallet-signatures.jsonl`(签名审计) | 保留;签名同时产生账本事件 |
| `task-contract.ts`(14 态 + 四支付模式 + 放行闸) | 保留;**任务状态改由账本重放** |
| P4 MCP(17 tools / 7 resources) | 增加 `bolloon_ledger_*` 与 `bolloon://ledger/*` |

## 13. 诚实边界

1. 账本证明**事件由某身份签发、且顺序与内容未被改**;它**不自动证明**"任务结果是对的"。
2. 资金事实仍以**链上**为准(与 x402 同一口径);账本里的 `settlement.confirmed` **必须能回指链上 tx hash**。
3. `local-dev` **永远只是测试结算**,不上链上口径、不进 `finalized`。
4. **未确认 ≠ 已确认**:`observed / confirmed / finalized` 逐级如实,页面文案与之逐字对应。
5. 分叉**不删**,标出来 —— 掩盖分叉比出现分叉更糟。
