---
entity_type: protocol
status: current
last_confirmed: 2026-09-29
tags: [x402, chain-index, pulse, payment-index, public-display]
title: 链上交互索引: 付款行并入统一索引(任务与付款同一张表) + 计数口径修正
source: session (leo 2026-09-29 "我要记录的是链上数据, 不是本机数据, 网关要显示的是所有交互" / "消息·心跳·任务往来可以先不上链"; 契约取自 src/agents/chain/transfer-index.ts · transfer-classify.ts · src/agents/network-pulse.ts · scripts/export-network-pulse.ts)
created: 2026-09-29
schema_version: 2
audience: self
stage: current
confidence: high
---

# 链上交互索引(付款行并入统一索引)

> 一句话: 网关/首页的「链上交互」区里, **任务(escrow 合约事件)与付款(USDC 转账)是同一张表的两类行**,
> 全部来自 Base 主网扫描, 逐行可核验(块号 + tx_hash); 本节点观察类指标(节点/智能体/签名)已从该计数行移除。

## 1. 为什么不是"本机数据"

leo 2026-09-29 逐字口径: 「**我要记录的是链上数据, 不是本机数据, 网关要显示的是所有交互**」,
后确认「**消息/心跳/任务往来可以先不上链**」⇒ 只有链上那部分进入网关, 且**不为链下交互另建账本**。

因此:
- 网关计数 = ① escrow 合约事件 ② 关注地址集内的 USDC `Transfer`。二者都来自链上扫描。
- 消息/心跳/任务报文(HTTP 面)**不上链、不进网关、不另立账本**。
- x402 的 402 询价只留服务器滚动访问日志 ⇒ 「多少人来看过价」**目前不可见**(不编造)。

## 2. 扫描口径(实现)

| 项 | 值 |
|---|---|
| 目标合约 | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| 过滤 | `topics[0]=Transfer` 且 `to`/`from` ∈ 可配关注地址集 |
| 地址集配置 | `~/.bolloon/chain.json` 的 `watchAddresses`(关注) / `ownAddresses`(自有, 用于区分"转入(非销售)") |
| 分页 | **≤2000 块/页**(Base 公共 RPC `eth_getLogs` 上限; 30000/15000/7500/3750 窗口实测全被拒) |
| 回退 | 每轮 32 块 rewind |
| 游标 | `~/.bolloon/chain/transfers.json`(与 escrow 索引 `index.json` 分离) |
| 交叉核对 | 同一结论需 ≥2 条 RPC 一致; 矛盾 ⇒ 判"不确定" |

## 3. 行分类(不许只按"有 USDC 转入"计数)

实测 4+1 行说明为什么必须分类:

| 块 | 时间 | 金额 | 来源 | 分类 |
|---|---|---|---|---|
| 51640437 | 09-22 17:43 | +0.685959 | `0xb4cb8009…`(自有钱包) | **转入(非销售)** |
| 51685757 | 09-23 18:54 | +0.001 | escrow 合约 `0x4e689f98…` | **escrow 退款**(对应 RefundedV2@51685757) |
| 51686009 | 09-23 19:02 | +0.001 | escrow 合约 | **escrow 退款**(对应 RefundedV2@51686009) |
| 51901934 | 09-28 19:00 | +0.01 | `0x6a3f7975…`(外部) | **外部付款**(与卖方台账对上 ⇒ 经 x402 流程) |
| 51930989 | 09-29 11:08 | +0.01 | `0x6a3f7975…`(外部) | **外部付款**(链上 BOL1 nonce 自证 ⇒ 经 x402 流程) |

顶部计数的口径句(**不许写"收入/成交额"**):
「链上转入 N 笔 · 其中经 x402 流程 M 笔 · 合计 X USDC(含退款/自有转入, 逐行可核验)」+ 覆盖起止块 + 落后块数。

## 4. 计数口径修正(2026-09-29)

事故: 页面上出现「已结算 5 > 已完成 3」的自相矛盾读数。根因 = `tasks_settled` 把 **ReleasedV2 3 笔 + RefundedV2 2 笔**一起算了。

修正后:
- `tasks_settled` **只算 ReleasedV2**(钱真从合约释放给卖方)
- `tasks_refunded` / `tasks_disputed` 各自独立字段(争议 → 退款 ≠ 成交)
- `tasks_verified` 保持 `null` + 「未接入」(不用 0 冒充)
- 本机指标(节点/智能体/钱包签名)从网关计数行移除

索引实况(2026-09-29 11:2x): 15 行 = 5 任务 × 3 事件; `EscrowCreatedV2 5 · ProofSubmittedV2 3 · ReleasedV2 3 · DisputedV2 2 · RefundedV2 2`;
块区间 51640623–51714186(部署周测试交易); 覆盖 51640073→51931064(live head 51931080, 落后 16 块)。

## 5. 与 x402 订单身份的关系

链上**没有任何 x402 标记** —— x402 的一次付款在链上只是一笔普通 ERC-20 转账。要让它自证"买的是哪件",
需要 EIP-3009 的 `nonce` 携带订单标识(详见 `docs/wiki/x402-order-identity.md`)。
付款行标注「经 x402 流程」的判据因此分两级:
1. **链上自证**: tx 内同时有 `Transfer` 与 `AuthorizationUsed(payer, nonce)`, 且 nonce 前 4 字节 = `BOL1`
2. **台账交叉核**: txHash 出现在卖方端点 `GET /api/x402/seller/summary`(链下台账); 端点不可达 ⇒ 标 **未知 + 原因**, 绝不用 0

## 6. 未做 / 在途(如实)

- **bolloon-UI 的门重基准尚未全绿**: `scripts/verify-site.mjs` 最后一次全跑 425 passed / 15 failed(断言重基准 + 1 个真 bug 已修待重部署确认); 分页门(15 行 1 页 → 20 行 2 页)与 2 个多实例门未改。收尾线在跑。
- 该页面临时未纳入 `docs/wiki/log.md` 表格行: 提交时 `log.md` / `current-status.md` 正被**另一个并发写入者** staged(update/dual-source 工作流), 为不打包他人在途改动, 本次记录只落本页。
- 端点 `GET /api/x402/seller/summary` 是**公开聚合面**(无认证); 凭据/取件面仍在 HMAC 队列。
- 全链级"所有智能体的 x402 记录"**不做**: 链上只有地址没有智能体身份; 要做需先有「地址 ↔ DID 绑定登记」层。
