---
title: 链式活动账本与链上锚定 (Bolloon Activity Ledger) — 设计计划
source: leo 2026-09-21 "并不是这样快照，而是根据区块链特性来进行记录，设计计划"
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: current
status: draft
tags: [pulse, ledger, blockchain, anchor, merkle, design]
---

# 链式活动账本 + 链上锚定 (设计计划)

## 0. 一句话

把公开观察层从「节点定期导出静态快照」换成「**节点本地哈希链账本 + 定期把批次根锚定到链上**」:
网页不再读一份会被重写的文件,而是**读链** —— 数字由链上锚点派生、每笔都可由任何人复算验证,
页面跟着**区块头**前进(≈2 秒一个块)而不是跟着 2 小时一次的部署前进。

## 1. 用到区块链的哪些特性(这是本设计的理由,不是装饰)

| 特性 | 在我们的用法里解决什么问题 |
|---|---|
| **追加不可改 (append-only)** | 活动记录一旦入链就不能被节点事后重写 —— 解决"节点说自己活跃过"无法佐证 |
| **全局顺序 + 时间戳** | 所有节点的活动有**唯一可比的先后**;区块时间 = 可信时间源(不依赖本地时钟) |
| **哈希链 / Merkle 根** | 一次锚定覆盖一批活动;任何一条被改,根就对不上 —— 篡改可被自动发现 |
| **最终性 (finality)** | 区分 `pending / confirmed / finalized` —— 不再把"刚提交"说成"已成立" |
| **任何人可读** | 公开投影不再需要谁"发布";任何人用任意 RPC 都能读到同一份事实 |
| **不可否认 (签名)** | 锚定交易由节点 DID 对应地址签发 —— 节点不能否认自己锚定过 |

## 2. 数据模型:本地哈希链 → Merkle 批次 → 链上锚点

### 2.1 本地账本 (append-only, 哈希链)

`~/.bolloon/ledger/<channel>.jsonl`(channel 可多:本机、每个已加入网络各一条)

```json
{ "seq": 1287, "at": 1760000000000, "kind": "task_completed",
  "capabilityGroup": "research", "agentDigest": "a1b2…", "taskDigest": "9f3c…",
  "payloadDigest": "sha256:…", "prevHash": "sha256:…", "hash": "sha256:…" }
```

- `hash = sha256(prevHash ‖ canonical(entry 去掉 hash))` —— **改一条就断链**,`bolloon ledger verify` 能定位到第几条断的。
- **只存摘要**:原始 DID / peerId / 任务正文 / 金额精确值**永不入账本**(沿用现有 `assertNoPrivateFields` 同一套红线)。
- `seq` 单调递增、不可跳号(跳号 = 断链,校验会报)。

### 2.2 Merkle 批次

每 **N 条**或每 **T 分钟**(取先到者)封一批:

```
batch = { channel, fromSeq, toSeq, count, merkleRoot, timeRange: [from, to], prevAnchorTx? }
```

### 2.3 链上锚点 (Base Sepolia 起, 后续可换网络)

一笔**极简交易**,calldata 即承诺:

```
bolloon-anchor-v1 | channelId | fromSeq | toSeq | count | merkleRoot | schemaVersion
```

- 从 **`~/.bolloon/wallet.json` 的地址**发出(与 x402 同一把钱包、同一套 `authorizeWalletSignature` 放行闸 + 签名审计)。
- **频率**:默认 **每 10 分钟或每 50 条**封一批(≈144 笔/天就够;Base 上单笔 gas 极低)。
- **成本闸**:沿用 `economic-policy`(单笔/日累计上限)+ 新增 `anchorBudget`(锚定不能挤占任务预算);超限 → 只写本地批次、标 `unanchored`,**不硬发**。
- **最终性**:`pending`(已广播未打包)→ `confirmed`(1 确认)→ `finalized`(N 确认,默认 12)。对外文案**逐级如实**,不许把 `pending` 说成"已完成"。

## 3. 事件白名单(与现有 Pulse 保持一致,只新增经济类)

`node_joined` · `manifest_published` · `capability_announced` · `peer_connected` · `delegation_completed`
\+ `task_posted` · `task_accepted` · `task_completed` · `trade_settled` · `trade_verified` · `wallet_signed`

> 这些**已经是现有 Pulse 的白名单**(2026-09-21 已实现),本设计不改语义,只把**落点**从 `network-pulse/events.json` 换成链式账本 + 锚点。

## 4. 公开投影:由链派生,而不是由节点发布

`GET /api/public/network/progress` 改为**两源合成**:

1. **链源(主)**:用任意公开 RPC 读该节点(或一组节点)的锚定交易 →
   - `anchors`:数量、最近锚点时间、每笔的最终性等级
   - `totals`:可由锚点 calldata 的 `count` 直接累加(活动条数);任务/签名/交易数**需要批次明细**才能精确(见下)
   - `chain`:网络名 / 最新区块号 / 区块时间 / RPC 来源
2. **明细源(辅)**:批次明细(每条活动的摘要)**不进链**(太贵),走 IPFS CID / `bolloon.cn/network-pulse-batches/<txHash>.json`
   - 投影里给出"这个数字对应哪个 txHash 的哪一批" → **任何人可下载明细、复算 Merkle 根、与链上 calldata 比对**。

**页面文案(诚实边界,逐字保留现有口径)**:

| 数据来源 | 文案 |
|---|---|
| 只有本机账本、还没锚定 | 当前节点观察到 |
| 有锚点 + 明细核验通过 | 链上锚定 · 可验证(锚点 N 笔 · 已最终确定 M 笔) |
| 链不可达/无锚点 | 快照不可用 —— 不是"网络为空" |

## 5. 前端行为:跟着区块头走(这才叫"持续轮转")

- **主循环 = 链头轮询**:`eth_blockNumber` + 锚点事件(每 **5–10 秒**,可配);新块到达 → 重算派生量 → **只更新变化的文本节点**。
- **活动流轮转**:展示最近 K 条锚点/活动,新块到达时**滚动前进**(不是每 2 小时整块换)。
- **不用整站部署**:链就是数据源 → 彻底摆脱 CF Pages 500 次/月部署配额,也不需要 Worker+KV。
- **降级链(逐级,全部如实)**:链 RPC 不可达 → 同源签名快照(`network-pulse.json`,保留) → `unavailable`。
- 移动端/弱网:RPC 超时 5s、退避 30/60/120s、`prefers-reduced-motion` 关动效;数值缺项**不显示**,不拿 0 冒充。

## 6. 可验证性:任何人都能自己算

```
bolloon pulse verify <txHash>          # 拉链上锚点 + 明细 → 复算 Merkle 根 → 比对 calldata
bolloon ledger verify [--channel x]    # 本机哈希链逐条校验, 报第一条断链的 seq
```

验收必须包含一条**独立复算**:在**另一个进程/另一个 HOME**里,只用 `txHash` + 公开明细,复算出与链上相同的根 —— 不是"我们自己说对"。

## 7. 与现有实现的关系(替换 / 保留)

| 现有件 | 处置 |
|---|---|
| `src/agents/network-pulse.ts`(事件白名单/匿名化/去重/隐私阈值/三态) | **保留**(语义不变) |
| `network-pulse/events.json` | **升级**为链式账本 `ledger/*.jsonl`(带 `prevHash`/`hash`);旧文件读进来自动补链(一次性) |
| `scripts/export-network-pulse.ts`(静态快照导出) | **降级为降级档**:链可达时不用它 |
| cron `bolloon-pulse-refresh`(每 2h 导出+部署) | **保留但降频**(快照只是兜底;主力走链) |
| 交易写路径挂钩 `emitTradePulse`(交付/验真/链上结算) | **保留**,改为写链式账本 |
| `wallet-signatures.jsonl`(签名审计) | **保留**;签名同时产生一条 `wallet_signed` 账本条目 |

## 8. 分阶段实施

| 阶段 | 内容 | 判据 |
|---|---|---|
| **L1 链式账本** | `src/agents/ledger.ts`:追加/校验/断链定位/枚举;`network-pulse` 改为写它;单测含"改一条→校验报错" | 链校验通过;篡改 1 条 → 报出 seq;`bolloon ledger verify` 真跑 |
| **L2 Merkle 批次** | 封批 + 根计算 + 明细落盘(`batches/<root>.json`) | 一批 50 条 → 根稳定;明细改动 → 根不符 |
| **L3 链上锚定** | `src/agents/anchor.ts`:构造 calldata、走**同一把钱包 + 同一放行闸**、广播、跟踪最终性;`anchorBudget` 成本闸 | 真发一笔 Base Sepolia 锚定 tx;`pending→confirmed→finalized` 状态如实;超预算 → `unanchored` 不硬发 |
| **L4 由链派生的公开投影** | 公开接口改两源合成;明细随站点发布;三档降级 | 关掉本地台账、只给 RPC → 投影仍能出数;文案三档正确 |
| **L5 前端跟区块** | 链头轮询 + 锚点增量 + 活动流前进;降级链 | 真域名:新块到达 → 数字自动变;**无整站部署** |
| **L6 独立复算** | `pulse verify <txHash>` + 跨 HOME 复算验收 | 另一进程只用 txHash 复算出同一根 |

## 9. 风险与诚实边界(必须先写清楚,免得后面自欺)

1. **链只证明"某节点在某时刻锚定过某个根"** —— 它**不证明**那些 P2P 活动本身为真。所以文案永远说"锚定 · 可验证",不说"全网真实发生"。
2. **明细不进链**(成本)→ 明细可被节点选择性发布;缓解:批次只发**必须的聚合**,且锚点连续不跳号;跳号本身就是一个可被发现的信号。
3. **链上仍无 DID/正文/精确金额** —— 只有渠道标识、序号区间、条数、根;`assertNoPrivateFields` 继续兜底。
4. **测试网 ≠ 价值证明**:Base Sepolia 只证明"锚定通路成立";与 x402 同一口径。
5. **gas/额度**:超预算 → 只写本地(标 `unanchored`),**不硬发、不伪造**。
6. **不会把 `pending` 说成最终**:最终性等级逐级如实,`local-dev` 永不进链上口径。

## 10. 与 EigenFlux 的关系(定位,不抄实现)

EigenFlux 用**中心化 Go 服务 + Postgres + 活动消费管道**换取"持续在线";本设计用**哈希链 + 链上锚定 + 公共 RPC**换到同一个体验(网页持续前进),但**不需要一台中心服务器**,并且数字**任何人可复算**。两者都在解决"让访客看到网络在长",我们这条路的额外好处是:**数据源不是我们的服务器,所以没有"信我们"这一环**。
