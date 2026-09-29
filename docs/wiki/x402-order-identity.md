---
title: x402 订单标识 (约定 v1, 标签 BOL1): 把"买的是哪件"编进 EIP-3009 nonce, 与付款同一笔交易自证
source: session (leo 2026-09-29 拍板"公示区只认链上事实, 而 x402 在链上现在只是一笔无名普通转账"; 契约取自 src/agents/x402/order-identity.ts · direct-payment.ts · src/cli/x402-buyer-command.ts)
created: 2026-09-29
last_confirmed: 2026-09-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [x402, order-identity, eip-3009, eip-712, nonce, usdc, base, transferWithAuthorization, direct, paid-info, pay.bolloon.cn, index-handoff]
---

# x402 订单标识 (约定 v1)

## 0. 一句话

普通 USDC 转账在链上只是 `Transfer(from,to,value)` —— **没有"买的是哪件东西"的痕迹**。
EIP-3009 (`transferWithAuthorization`) 的 `nonce` 是**付款方自选的 32 字节**, 还会被
`AuthorizationUsed(authorizer, nonce)` **原样记上链**。把"订单身份"编进这 32 字节,
"谁付 · 多少 · 给谁 · **买什么**"就在**同一笔交易里自证**, 不需要任何平台/托管/第三方。

## 1. 约定 v1 原文 (字节级; 改它 = 换版本号, 不许就地发挥)

```
nonce (32 字节) =
  偏移 0 .. 3   : 标签 0x424f4c31 = ASCII "BOL1"                                  (4 字节)
  偏移 4 .. 7   : orderSeq, uint32 **大端**                                       (4 字节)
  偏移 8 .. 31  : hash24 = keccak256( utf8(itemId) ‖ uint256be(orderSeq) )[0..23]  (24 字节)
```

* `uint256be(orderSeq)` = orderSeq 的 32 字节大端表示; `[0..23]` = 取前 24 字节。
* `itemId` = 卖方上架条目的 id (例: `info_efficode_spec_pack`), 逐字节 utf-8, **不做任何归一化**。
* 协议名 `bolloon-x402-order-identity/1`; 事件 topic0
  `0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5`
  (`AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`; 两个参数都 indexed ⇒
  authorizer 在 `topics[1]`, nonce 在 **`topics[2]`**, 无 data)。

**与最初口头描述的唯一差异 (写清, 不含糊)**: 口头版是"后 28 字节 = keccak256(itemId‖orderSeq) 截断"。
那样编出来的 nonce 里**没有 orderSeq**, 卖方就**复算不了** `keccak256(itemId‖orderSeq)`
(只能对 orderSeq 暴力枚举 —— 既有假阳性风险又不确定) ⇒ "订单自证"根本判不出来。
所以 v1 把 **4 字节 orderSeq 显式编进去**, 哈希只占 24 字节 (192 bit 抗碰撞, 对"订单标识"这个用途远远够用)。

**去重语义 (用错就是"自以为自证了")**:

* 链上 `(authorizer, nonce)` **只能用一次** (用过 `authorizationState` 置位, 再用必 revert)
  ⇒ **同一买家重复买同一件必须换 `orderSeq`** (换不了只有一个后果: 第二笔**链上回滚**, 不是"卖方不认")。
* **不同买家可以用同一个 nonce** —— 去重键是 `(authorizer, nonce)`, authorizer 不同就不冲突。
* ⇒ 唯一键是 `(payer, nonce)`; `nonce` 单独**不是**唯一键。

## 2. EIP-712 域: name **不是** "USDC" (实测)

买方签名必须用与链上一致的域, 否则 token 侧 `ecrecover` 对不上 ⇒ **交易必 revert** (不是"可能不兼容")。

实测 (2026-09-29, `mainnet.base.org` 与 `base.drpc.org` 同值):

| 项 | 值 |
| --- | --- |
| `name()` (ERC20 名, EIP-712 域用的就是它) | **`USD Coin`** ⇒ `name="USDC"` 是**错的** |
| `version()` | `2` |
| `chainId` | `8453` |
| `verifyingContract` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `DOMAIN_SEPARATOR()` | `0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f` |

⇒ 买方 CLI **不写死 name/version**: 先读链上 `DOMAIN_SEPARATOR()`, 再拿候选
(`USD Coin` / `USDC` / `USDC.e` / …×`2` / `1`) 逐个算 `keccak256(abi.encode(typehash, keccak256(name), keccak256(version), chainId, asset))`
跟链上值比, **只在唯一命中时**才签; 全不中 ⇒ **拒签并列出试过哪些**。
仓内还有一条**证伪测试**把这件事钉住 (拿 `name:"USDC"` 算出来的分隔符 ≠ 链上值)。

## 3. 实现 (仓内落点)

| 文件 | 作用 |
| --- | --- |
| `src/agents/x402/order-identity.ts` (新) | 约定 v1 的唯一实现: **纯 TS keccak-256** (零依赖, node:crypto 只有 sha3-256 的 padding 不同不能用) · `computeOrderNonce` / `decodeOrderNonce` / `orderItemHash24` / `matchOrderNonce` · `eip712DomainSeparator` / `eip3009Typehash` · **`orderIdentityFromLogs` (纯函数)** · **`readOrderIdentityFromTx` (只读 RPC 入口)** |
| `src/agents/x402/direct-payment.ts` (改) | 卖方核验加第 ⑦ 条: 从**同一条交易**的日志里读 `AuthorizationUsed` 并复算哈希; `orderIdentity` 进 `verdict`/台账/回执/**202 回显**; 台账新增 `NONCE_ALREADY_USED` 幂等门 |
| `src/cli/x402-buyer-command.ts` (新) | 买方 CLI `bolloon x402 pay <endpoint> [--with-memo]`: 自己签 EIP-712、**自己发** `transferWithAuthorization`、把 txHash 交回卖方端点; 私钥**只从文件读** |
| `src/cli-entry.ts` (改) | 挂 `bolloon x402 pay` + 用法两处 |
| `src/test/x402-order-identity.test.ts` (新) | 32 条聚焦测试 (真 HTTP JSON-RPC 夹具回放 AuthorizationUsed + Transfer) |

**卖方判据 (第 ⑦ 条, 缺 AuthorizationUsed 是降级不是拒付)**:

1. 在 `asset` 合约 (USDC) 的日志里找 `AuthorizationUsed` → `(authorizer, nonce)`;
2. nonce 解出来**不是** `BOL1` ⇒ `not-bol1` (有授权事实, 无订单标识) ⇒ **如实降级**;
3. 是 `BOL1` ⇒ 拿**本店真实 item** 的 id + 解出的 `orderSeq` **复算** `keccak256(itemId‖seq)[0..23]`:
   对上 ⇒ **`self-attested` (订单自证成功)**; 对不上 ⇒ `item-mismatch` ⇒ **如实降级**;
4. 一条都没有 (普通转账) ⇒ `no-authorization-used` ⇒ **如实降级为「直转(无订单标识)」**。

**降级不影响交付**(钱到了还是交付), 影响的是"这笔付款对应哪件东西"**能不能被链上证明** —— 所以
`mode != 'self-attested'` 时**任何地方都不许写"自证"**。订单标识**不进**未付款 402 分支
(`accepts` 逐字不变: 上机前后 402 响应体 sha256 同值 `133664c0…adc2`)。

**台账的两个幂等门**: ① 同 txHash + 同 item ⇒ 幂等命中 (回执逐字相同 ⇒ 同 pendingId);
② ★ 同 `(payer, nonce)` 出现在**另一笔 txHash** ⇒ `NONCE_ALREADY_USED` 拒 (链上本来就必 revert,
能走到这一步 = 有人在换 txHash 蹭同一份授权)。不同 payer 同 nonce 不受影响。
老记录 (无 `orderIdentity` 键) 的回执**逐字不变** —— 新键**只在有值时才写**, 键序排在最后。

## 4. 只读入口 (给公示/索引那条线; **它自己不该再实现一遍**)

```ts
import { readOrderIdentityFromTx, orderIdentityFromLogs } from '<repo>/src/agents/x402/order-identity.js';

// ① 只读: 给定一笔转账的 txHash, 从**同一 tx 的日志**里取 nonce → 返回 orderIdentity
const r = await readOrderIdentityFromTx({
  txHash: '0x…',
  itemIds: ['info_efficode_spec_pack'],     // 本店真实 item 的 id (复算哈希用; 只比"正在卖的这件"就传一个)
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // 可选: 限定只认该 token 合约的事件
  rpcUrl: 'https://mainnet.base.org',
});
// r.ok / r.rpc / r.blockNumber / r.error (形状不对或 RPC 读不到: ok:false + error, 不抛)

// ② 已经有日志数组 (例如索引线自己已经 eth_getLogs / 收据在手) ⇒ 纯函数, 零 RPC:
const id = orderIdentityFromLogs(logs, { itemIds: [...], asset: '0x…' });
```

`orderIdentity` 字段 (两端同一形状):

| 字段 | 含义 |
| --- | --- |
| `mode` | `self-attested` / `item-mismatch` / `not-bol1` / `no-authorization-used` / `malformed-nonce` |
| `selfAttested` | **只有 `mode==='self-attested'` 才是 `true`** (页面/回执上"自证"二字只许用它把关) |
| `degraded` | `!selfAttested` (给页面"直转(无订单标识)"用) |
| `nonce` | 交易里读到的 32 字节 nonce (没有事件 ⇒ `null`) |
| `tagPresent` / `tag` / `orderSeq` / `itemIdHash` | 解出来的订单身份 (标签不在 ⇒ `tag=null`, `orderSeq=null`) |
| `payer` | `AuthorizationUsed.authorizer` (无事件时取 `Transfer.from` 兜底) |
| `matchedItemIds` / `checkedItemIds` | 复算命中的本店 item / **拿来比过哪些** (审计用: "比过"也是事实) |
| `detail` | 人话结论, 可直接上屏 |

**两条纪律 (给那条线)**:

1. **别把 `orderIdentity` 当成"卖家承认过"**: 它是**链上事实的投影** —— "这笔付款的 nonce 声明了本店某件 item"。
   卖家是否真的交付过, 要另看卖方台账 (`GET /api/x402/seller/summary`, 那条线的既有物)。
2. **页面上"自证"二字只许挂在 `selfAttested===true` 的行上**; 其余一律写「直转(无订单标识)」。
   排序/计数也不要把两种行混成一个数 (同概念不同口径并排 = 本仓已踩过的坑)。

## 5. 真钱一次 (2026-09-29, 0.01 USDC 单品)

| 笔 | txHash | 链上 |
| --- | --- | --- |
| 主钱包 → 买方 gas ETH (0.00001) | `0x943d2b27796f819c631cfaf7e858d99b7e072a8f3418a52e37baa78a50c59724` | status=1 · gas 21000 × 6 gwei = 0.000000126 ETH |
| 主钱包 → 买方 0.01 USDC | `0xc69bb6f6a9fb1ad4f9340e2ede9b5aed495a79c1b3bdd40fcc292d2cd74223bf` | status=1 · gas 62147 × 6 gwei = 0.000000372882 ETH |
| **买方 → payTo (带 BOL1 nonce)** | **`0x1499e5f2088c49496dd4029dccf5cee26ca42c1e34df3450d793e8f8ffbd02a7`** | status=1 · 块 51930989 · gasUsed 78408 × 6 gwei = **0.000000470448 ETH** · `Transfer(买方→payTo, 10000)` + **`AuthorizationUsed(买方, 0x424f4c31…8db82e)`** |

买方 `0x6A3f797592BEd028F6AfD6DA82339C8e815480eb` ≠ payTo `0xb4e9dCF7…0066` (**不是自付自收**)。
三笔 gas 合计 **0.000000969330 ETH**; 货款 **0.02 USDC** (融资 0.01 + 付款 0.01, 一次性)。
两 RPC 同值: 买方 ETH `0.000019754738888283` → 付完 `0.000019284290888283`; 买方 USDC `0.01` → `0`。

**三跳回显**: 402 (body sha256 与上机前同值) → **202** `pendingId=pnd_2a0da742c4fb3c6f`
`orderIdentity.mode=self-attested` `selfAttested=true` `matchedItemIds=[info_efficode_spec_pack]`
`verifiedBy=[mainnet.base.org, base.drpc.org, 1rpc.io]` → **链上自读复核** (不经过卖方, 两条 RPC 各读一遍):
Transfer `from/to/value` 逐字对, AuthorizationUsed `authorizer` 逐字对, nonce 前 4 字节 = `0x424f4c31`,
独立复算 `keccak256("info_efficode_spec_pack"‖0)[0..23] = 0xf3912008…8db82e` **== nonce 里的哈希**。

⚠ **这一笔的台账记录 (`x402-direct-txs.json`) 是上机前的老代码写的**, 所以它**不带** `orderIdentity` 键
(回执/pendingId 因此逐字未变, 这是刻意设计: 老记录不许被改写); 202 里的 `orderIdentity` 是新代码
**当场从链上重新读出来的**。文档里所有"回执里带 orderIdentity"的断言, 依据是夹具测试 (D 组)。

## 6. 诚实边界 (不许美化)

* **自证的是"付款方声明"不是"卖方承认"** —— 买方可以编一个恰好等于 `keccak256(本店item‖seq)` 的 nonce
  **但它必须先真的把钱付到 `payTo`** 才可能产生这条日志; 反过来"付了钱但 nonce 没带标识"依然只是直转。
* **`orderSeq` 不参与防重放**: 链上防重放靠 `(payer, nonce)`; `orderSeq` 只是"同一买家重复买同一件"时换 nonce 的把手。
* **v1 没有过期时间语义**: `validBefore` 是 EIP-3009 自己的窗口 (买方 CLI 默认 900s), nonce 里不带时间。
* **不做全链扫描**: Base 公共 RPC `eth_getLogs` 单次上限 2000 块 ⇒ 索引侧按 txHash/地址窗口取, 别想"全扫一遍找 BOL1"。
* **没有链上验签**: 卖方判据不含"从 calldata 里取出 v/r/s 再 ecrecover 回买方" —— 目前信任 **token 合约
  自己验过了** (它没验过就不会 emit `AuthorizationUsed`)。要做可以在 v2 加 (需要 `eth_getTransactionByHash` 读 input)。
* **本机签名交付那条链没变**: 订单标识只解决"这笔付款对应哪件", 不解决"卖方不在线时钱到手货没到手"。
