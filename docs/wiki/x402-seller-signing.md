---
title: x402 卖方本机签名交付 (接口冻结): 私钥不出本机 · 卖方不在线只能拿到"已付款待签名"
source: session (leo 2026-09-28 要求"卖方本机签名交付这条去中心化链路的本机半边 + 接口冻结"; 契约取自 src/agents/x402/paid-info-protocol.ts · paid-info-store.ts · src/web/routes-x402-info.ts · src/agents/agent-identity.ts)
created: 2026-09-28
last_confirmed: 2026-09-28
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [x402, paid-info, seller-signing, ed25519, hmac, nonce, replay-protection, pending-queue, cli, facilitator, base, usdc, pay.bolloon.cn, interface-freeze]
---

# x402 卖方本机签名交付 (接口冻结): 私钥不出本机

**一句话**: 买方付了款, 但**内容信封由卖方本机用自己的 DIAP 私钥签**; 服务器 (ECS) 只持
**卖方公钥**, 只负责"收钱 → 落待办 → 把待办交给本机 → 收下本机签好的信封 → 发给买方"。
**服务器在任何时刻都造不出一个能过验签的信封** —— 这是这条链路的存在理由。

**红线 (不可协商)**

1. 私钥永不上服务器。把 DIAP 私钥放进跑在别人云上的付费端点 = 交出卖方身份。
2. 服务器侧**钉住卖方公钥** (`<服务目录>/.bolloon/seller-key.json`) 是**必须**的:
   没钉住就拒收信封 (`SELLER_KEY_NOT_PINNED`), **不是**"先信一次"。
3. 卖方不在线 ⇒ 买方**只能**拿到 `202 已付款待签名`, **拿不到信封**。不许用假信封/旧内容冒充交付。
4. 本次**没有**真钱结算, **没有**链上交易, **没有** facilitator 调用 (见 §六、§十)。

**复用而不新造**: 签名算法 (`ed25519Sign` / `ed25519Verify`)、被签内容 (`itemId + contentHash + source + receiptHash`)、
信封形状 (`proof.{did,publicKeyHex,signature,payload}`)、402 的 `accepts`、结算校验
(`checkAndSettlePayment`) **全部是仓内已有的**; 本链路只加了"待办队列"与"回传通道"两件事。

---

## 一、数据流图

```text
  买方 (agent / 人)                         ECS  120.26.82.43  (pay.bolloon.cn)
  ─────────────────                        ─────────────────────────────────────
  ①  GET /api/x402/info/:id  ──────────▶   ┌─ 无 X-PAYMENT ─────────────────────────┐
      没有付款头                             │ 402 + accepts (逐字, 未改一个字)      │
                                            └───────────────────────────────────────┘
  ②  带 X-PAYMENT 再来  ───────────────▶   ③ checkAndSettlePayment()   ← 既有函数
                                                │  付款通过 + 卖方未签
                                                ▼
                                            ④ 落待办 (写文件, 无数据库)
                                               <服务目录>/.bolloon/x402-seller-pending/pnd_*.json
                                                │
                                             回 202 {status:'paid_awaiting_signature',
                                                     pendingId, retrieval:{token,path}}
  ⑤ 买方存下 token, 之后轮询 retrieval.path  ─▶ 202 (卖方没签时一直 202)  ← **诚实口径**
                                               │
  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ 卖方本机 (私钥在这里) ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
                                               │
  ⑥ bolloon x402 pending list  ──────────▶    │  GET /api/x402/seller/pending
     (HMAC 认证: key/ts/nonce/sig)            │    ↑ 认不过 → 401; 没配密钥 → 403
                                               ▼
  ⑦ bolloon x402 pending show <id>  ────▶  待办详情 (付款凭据哈希/txHash/内容哈希/来源)
                                               │
  ⑧ 智能体或人**看明白再按** (人/agent 确认)
                                               │
  ⑨ bolloon x402 pending sign <id>
     · 读本机 ~/.bolloon/identity.json (私钥)
     · 既有 ed25519Sign() 签 canonical(payload)
     · 本机**先自检** ed25519Verify → 不过就不发
     · POST .../envelope  ─────────────▶    ⑩ acceptSignedEnvelope() 四道门:
                                               ① 待办在且未签 ② 公钥==钉住的卖方公钥
                                               ③ ed25519Verify ④ 载荷/内容哈希逐字一致
                                               → 存信封 + 待办置 signed
  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
  ⑪ GET /api/x402/info/:id/pending/:token ─▶ ⑫ 200 + {content, proof{...}}   ← 只读, 不重跑结算
      ⑬ 买方**离线**验签: ed25519Verify(proof.publicKeyHex, canonical(proof.payload),
                                        proof.signature)  或 verifyEnvelope(envelope)
```

**两条"不要"** (都是真踩过的坑, 不是理论):

- 买方**不要**靠"重放同一张 X-PAYMENT"来取信封 —— 服务器会**再跑一遍结算**, 而回执自带时间戳
  (local-dev 的 `settledAt` 是 `new Date()`), 于是拿到的是**另一个** receipt ⇒ 又落一条新待办,
  永远取不回刚才那个信封; facilitator 模式下重放还会被判重复结算。**取件必须走只读 token。**
- 卖方**不要**在服务器上放私钥"图省事" (那正是这条链路要解决的问题)。

---

## 二、待办记录结构 (冻结)

一条待办 = 一个文件: `<服务目录>/.bolloon/x402-seller-pending/<pendingId>.json`, `0600`, 原子写。
`pendingId = 'pnd_' + sha256(receiptHash)[0:16]` —— **由结算回执哈希派生**, 同一张凭据重算得到同一 id。

```jsonc
{
  "protocol": "bolloon-x402-seller/1",
  "pendingId": "pnd_e340cd62ea760e3a",
  "status": "awaiting_signature",        // awaiting_signature | signed | expired
  "itemId": "info_efficode_spec_pack",
  "title": "…",
  "providerDid": "did:key:z6Mk…",        // 必须 == identity.json 的 did, 否则本机拒签
  "contentHash": "sha256:…",             // 卖方**发布时**定的内容哈希 (签名时逐字对上)
  "contentCid": "…",                      // 可选
  "source": { "kind": "self", "refs": [], "note": "…" },
  "price": { "amount": "0.012", "currency": "USDC", "network": "base-sepolia", "payTo": "0x…" },
  "payment": {
    "mode": "facilitator",                 // facilitator | local-dev
    "receipt": "…(X-PAYMENT-RESPONSE 原文, base64)…",
    "receiptHash": "sha256:…",             // ★ 幂等键 + 签名绑定项
    "txHash": "…", "payer": "0x…",
    "network": "base-sepolia", "amount": "0.012", "currency": "USDC",
    "settledAt": "2026-09-28T…Z"
  },
  "createdAt": "2026-09-28T…Z",           // 买方触发结算(服务器时间)
  "expiresAt": "2026-10-05T…Z",           // TTL = 7 天; 过了不许再签
  "signedAt": "…",                        // 签完才有
  "envelopeHash": "sha256:…"              // 签完才有 (信封本体: envelopes/<receiptHash>.json)
}
```

- **不含**任何私钥、不含共享密钥 (测试有一门专门断这个: 队列文件里出现私钥/secret 即红)。
- 只读视图 (`pendingView`) 把过期待办**当场**算成 `status:'expired'`, 不改盘上文件 —— 状态是时间的函数, 不是谁写进去的。
- 信封按 `receiptHash` 存 (`envelopes/<sha256>.json`), 与待办分开: 待办是"要做的事", 信封是"已交付的事实"。

---

## 三、认证: 0600 共享密钥 + HMAC(时间戳 + nonce) 防重放

队列端点是**卖方私有**的 (列出的待办含买方付款凭据哈希/txHash/付款方地址), 所以除了 TLS 之外再加一层:

| 项 | 值 |
| --- | --- |
| 密钥文件 (本机, 卖方) | `~/.bolloon/x402-seller-auth.json` — **0600** |
| 密钥文件 (服务器) | `<服务目录>/.bolloon/x402-seller-auth.json` — **0600** (只放共享密钥, 只给该服务用户读) |
| 密钥本体 | `secret`: 32 字节随机 → base64; 另有 `keyId` 明文标识 |
| 协商 | 谁生成都行; 用带外通道 (scp / 口令) 把**同一个文件**放到两边, 两边指纹必须一致 (`bolloon x402 pending auth-init` 打印指纹) |
| 算法 | HMAC-SHA256, `timingSafeEqual` 比较 (不用 `===`, 不给计时侧信道) |

**被签的规范串** (五样缺一不可; 查询串**不参与**签名 —— 只签 pathname):

```text
  METHOD\nPATH\nts\nnonce\nsha256hex(请求体原文)
```

**请求头** (四个都要):

```text
  x-bolloon-seller-key:   <keyId>
  x-bolloon-seller-ts:    <毫秒时间戳>
  x-bolloon-seller-nonce: <16 字节随机 hex, 一次性>
  x-bolloon-seller-sig:   <HMAC-SHA256(secret, 规范串) hex>
```

**服务端三道门, 顺序不能乱**:

1. **签名** — HMAC 不匹配 → `401 SELLER_AUTH_SIGNATURE_INVALID`
2. **时间戳** — `|now - ts| ≤ 5min` → 否则 `401 SELLER_AUTH_EXPIRED` (重放窗口只有 5 分钟)
3. **一次性 nonce** — 台账里出现过 → `401 SELLER_AUTH_REPLAY`

> 为什么**先验签再记账**: 如果先记 nonce 再验签, 攻击者不需要密钥 —— 随便发一堆垃圾签名就能把
> 任意 nonce 提前"用掉", 合法请求反而被当成重放 (拒绝服务)。所以只有**验签通过**的 nonce 才入账。
>
> nonce 台账**落盘** (`x402-seller-pending/.nonces.json`, 0600) 并顺手清理超出窗口的旧 nonce:
> 服务重启**不是**"重放窗口刷新"——重启后台账还在。

未配置密钥时, 队列端点回 **403 `SELLER_AUTH_NOT_CONFIGURED`** (不是 401, 也不是空列表):
"没配密钥"和"你签错了"是两件不同的事, 必须能分得开。

---

## 四、幂等与一次性 nonce

| 维度 | 键 | 行为 |
| --- | --- | --- |
| 认证 | nonce (一次性, 落盘台账) | 同一个 nonce 第二次 → 401 REPLAY |
| 待办 | `receiptHash` = `sha256:<结算回执原文>` | 同一个 receipt 第二次 → **不新落一条**, 返回同一条待办 (`created:false`) |
| 交付 | 已有信封 (`envelopes/<receiptHash>.json`) | 再交付 → 直接给**同一个**信封 (幂等) |
| 改写已交付事实 | 待办已 `signed` | 交**另一个**信封 → `PENDING_ALREADY_SIGNED` (拒收); 逐字相同的信封 → 幂等成功 |
| 取件 | 取件 token = `pendingId` | 只读, 不重跑结算; 同一 token 反复取 → 同一信封 |
| 直付交易 (mode=direct) | `txHash` (小写, 落盘台账 `<服务目录>/.bolloon/x402-direct-txs.json` 0600) | 同一个 txHash + 同一条 item → 回执**逐字相同** ⇒ 同一条待办 (`reused:true`); 同一个 txHash 拿去换**另一条** item → `409 TXHASH_ALREADY_USED` |

**两个诚实的边界**:

- 幂等键是 **receiptHash**, 不是"X-PAYMENT 原文"。local-dev 模式下回执带 `settledAt` 时间戳,
  所以**重放同一张 X-PAYMENT 会得到新 receipt → 新待办** (测试里有一条反面对照专证这件事)。
  facilitator 模式下 receipt 由 facilitator 签发, 同一张凭据**能**稳定映射到同一 receipt (取决于 facilitator 是否幂等)。
  **`direct` 模式**下回执由卖方端点**自己按确定性规则**生成 (`txHash` + 台账首见 `settledAt`),
  所以**同一个 txHash 反复提交必然得到同一 receiptHash → 同一待办** (幂等不依赖任何外部服务的脾气)。
- 取件 token 是**不记名 token**: 谁拿到谁能取内容。facilitator 模式下 receipt 含 facilitator 的结算结果
  (`txHash` 等), 卖方之外不可推导; **local-dev 模式下买方能自己算出 receipt ⇒ token 不提供保密性**
  —— local-dev 是联调模式, **不是安全边界** (这条与 `access-protocol-v1` 的 local-dev 红线同口径)。
  **`direct` 模式同理不提供保密性**(回执内容 = 买方自己发的那笔交易 + 卖方读链结论, 买方本就能复算):
  direct 里"付款事实"本来就是公开的 —— 它的价值是**不引入托管**, 不是给 token 加密。

---

## 五、超时与失败: 买方**看到什么** (诚实口径)

| 场景 | 买方看到 | 卖方看到 | 事实 |
| --- | --- | --- | --- |
| 没付款 | `402` + accepts (逐字不变) | — | 没付款 |
| 付了款, 卖方**不在线** | `202 {status:'paid_awaiting_signature', pendingId, retrieval, hint}`; 之后轮询取件 → **一直是 202** | 待办躺在队列里 | **已付款, 未交付** —— 不是失败, 但也**不是**"拿到了内容" |
| 付了款, 卖方**签完** | 取件 → `200` + 信封 → 离线验签通过 | 待办 `signed` | 交付完成 |
| 待办过期 (卖方 7 天没签) | 取件 → `410 {status:'pending_expired'}`; 卖方侧也拒签 | 待办 `expired` | 已付款但**不再交付**; 退款是**另一个议题** (本链路不含退款, 见 §十) |
| 取件 token 错/不属于这条 item | `404` | — | 不区分"不存在"和"不是你的", 不泄漏存在性 |
| 服务器没配共享密钥 | (卖方本机) 队列端点 `403 SELLER_AUTH_NOT_CONFIGURED` → **本机也无权拉取** | 同上 | 不是"没有待办", 是**没配密钥** |
| 服务器没钉卖方公钥 | 卖方签字后 POST 被 `503 SELLER_KEY_NOT_PINNED` 拒收 | 本机看到明确错误 | 宁可拒收, 也不"先信一次" |
| 本机 identity 的 did ≠ 待办 providerDid | 本机**拒签** (不是签错了再报错) | 待办仍 awaiting | 防"用错钥匙签了别人的单" |
| 本机内容哈希 ≠ 待办 contentHash | 本机**拒签**, 且服务器侧也会 `CONTENT_HASH_MISMATCH` | 待办仍 awaiting | 防"挂 A 卖 B" |
| **直付**: 只有一条 RPC 认这笔付款 (另一条读不到/还没同步) | POST `/payment` → **402 `DIRECT_PAYMENT_NOT_VERIFIED`** (附 `paymentAttempt.rpcChecks` 逐条状态) | 待办**不落** (没核验通过就不认领) | **不确定 ⇒ 不交付**; 买方可以直接重投**同一个 txHash** (幂等, 不会再扣钱) |
| **直付**: txHash 拿去换另一条资源 | **409 `TXHASH_ALREADY_USED`** | — | 一笔链上付款只换一条资源 |
| **直付**: 本部署没开 direct | **503 `DIRECT_MODE_DISABLED`** | — | 这条链上路径没开 (仍然只发 402), **不许读成"付了款没给货"** |

**硬话**: 卖方不在线时买方**拿不到信封** —— 这条链路不提供任何"服务器代签"或"先给内容后补签"的兜底。
若业务上不能接受"付了钱可能拿不到货", 该在**结算前**解决 (例如卖方在线性检查/托管), 不是在交付层做假。

---

## 六、与 facilitator 的关系: 两种结算路, **都不引入平台**

本链路只管**付款之后**的交付 (签名/回传/取件)。付款怎么完成由既有 `checkAndSettlePayment` 决定,
它支持两条路, **都不需要任何第三方平台账号或平台代收**:

| | 路 A: 自建 relayer | 路 B: 买方直付 + txHash 链上校验 (**已实现, 已上机**) |
| --- | --- | --- |
| 谁发交易 | 我们的 relayer (自建 EOA) 走 EIP-3009 `transferWithAuthorization` | **买方自己**在他的钱包里发 USDC 转账 (或 4337 账号) |
| 服务器角色 | 调 facilitator (`/verify` + `/settle`) | 服务器**只读链**: 按 `txHash` 取交易/回执, 校验 to/amount/asset/confirmation 数, 且**两条不同 RPC 交叉一致** |
| 私钥在哪 | relayer 私钥在**我们的**结算机上 (不是卖方机器, 也**不是**平台) | 买方钱包 |
| 卖方本机 | **不参与付款**, 只参与签名交付 | 同 |
| 现状 | 代码路径在 (`checkAndSettlePayment` 的 facilitator 分支), **本部署未启用** (`/api/health` 如实报 `settlement.mode=none`) | **已实现 + 已部署**: `BOLLOON_X402_DIRECT=1` ⇒ `/api/health` 报 `settlement:{mode:"direct", onchain:true, custody:"none"}`; 真钱跑通见 §十一 |

**两条路的共同点 (这才是关键)**: 无论哪条路, 交付都**只能**由卖方本机签名完成 ⇒ 平台/服务器
在**任何**配置下都无法冒名交付。反过来说: facilitator 若被攻破, 最多影响"钱怎么动",
**不影响"谁签的字"**。

> 本部署的付款头仍然接受 `local-dev` (联调凭据, 需要显式 `allowLocalDev`) —— 那是**联调**模式,
> 不是结算。`local-dev`/`facilitator` 两条老路**都没有**在本部署开启: 本部署只有 `direct` 是链上的,
> 且 `/api/health` 会逐字说清 (`onchain:true` + `custody:"none"` + RPC 清单 + 确认数门槛)。

---

## 七、接口冻结 (端点 + 错误码)

### 7.1 买方侧 (对外, 无认证)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/x402/info/:id` | 无付款头 → **402 + accepts (逐字不变)**; 有付款头 → 200 信封 / 202 已付款待签名 |
| POST | `/api/x402/info/:id/payment` | **去中心化直付 (mode=direct, 需 `BOLLOON_X402_DIRECT=1`)**: body `{"txHash":"0x…"}` (买方自己发的 USDC 转账) → 链上核验通过 → **202 待签 + 取件 token**; 没过 → 402 (accepts 逐字 + 原因); 没开 → 503; txHash 形状不对 → 400; 同一 txHash 换别的资源 → 409。**这不改变上面那条 GET 的 402 分支** |
| GET | `/api/x402/info/:id/pending/:token` | **取件 (只读)**: 200 信封 / 202 待签 / 410 过期 / 404 token 无效 |

402 响应体 = 既有 `buildPaymentRequired()` 的输出 + `error`, 并带
`X-PAYMENT-REQUIRED: <accepts JSON>`。**本次改动没有碰这条分支的任何字节** (测试里对 402 体逐字断言)。

202 响应体 (冻结形状):

```jsonc
{ "ok": true, "status": "paid_awaiting_signature",
  "pendingId": "pnd_…", "itemId": "info_…", "title": "…", "contentHash": "sha256:…",
  "payment": { "mode": "facilitator", "receiptHash": "sha256:…", "txHash": "…", "payer": "0x…", "network": "base-sepolia" },
  "retrieval": { "token": "pnd_…", "path": "/api/x402/info/:id/pending/pnd_…",
                 "note": "卖方不在线时这里一直回 202 (已付款待签名); 签好后回 200 + 信封" },
  "hint": "…", "retry": "…" }
```

### 7.2 卖方侧 (队列, 需 HMAC 认证)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/x402/seller/pending[?status=awaiting_signature]` | 待办列表 (+ `counts`); 查询串不参与签名 |
| GET | `/api/x402/seller/pending/:pendingId` | 单条待办 (含付款凭据哈希/txHash/付款方) |
| POST | `/api/x402/seller/pending/:pendingId/envelope` | 回传本机签好的信封 (body = 信封 JSON) |

错误码 (冻结, 客户端按码分支, 不解析中文):

```text
  认证: SELLER_AUTH_NOT_CONFIGURED(403) · SELLER_AUTH_REQUIRED(401) · SELLER_AUTH_KEY_UNKNOWN(401)
        SELLER_AUTH_BAD_TS(401) · SELLER_AUTH_EXPIRED(401) · SELLER_AUTH_SIGNATURE_INVALID(401)
        SELLER_AUTH_REPLAY(401)
  待办: PENDING_NOT_FOUND(404) · PENDING_STATE_INVALID(409) · PENDING_EXPIRED(410)
        PENDING_ALREADY_SIGNED(409)
  收信封: ENVELOPE_MISSING_PROOF(400) · SELLER_KEY_NOT_PINNED(503) · SELLER_KEY_MISMATCH(400)
        SIGNATURE_INVALID(400) · PAYLOAD_MISMATCH(400) · CONTENT_HASH_MISMATCH(400)
  直付: DIRECT_MODE_DISABLED(503) · INVALID_ARGUMENT(400) · TXHASH_INVALID(400)
        DIRECT_PAYMENT_NOT_VERIFIED(402, 附 accepts 逐字 + paymentAttempt.rpcChecks)
        TXHASH_ALREADY_USED(409)
  其他: 405 (非 GET/POST) · 500
```

> 具体 HTTP 码以 `handleSellerApi` 的返回为准 (SIGNATURE_INVALID/PAYLOAD_MISMATCH/CONTENT_HASH_MISMATCH
> 归在 400 一族, `PENDING_ALREADY_SIGNED` 归 409); 上表是**契约**, 改动必须同步改本页与测试。

### 7.3 服务器上必须配的两个文件

```text
  <服务目录>/.bolloon/seller-key.json        # { did, publicKeyHex }  ← **钉住的卖方公钥** (公开信息)
  <服务目录>/.bolloon/x402-seller-auth.json  # { keyId, secret }      ← 队列端点共享密钥 (0600)
```

**只有公钥上服务器** —— `seller-key.json` 里没有、也不许有私钥。

---

## 八、本机 CLI 用法与输出示例

命令面 (冻结): `bolloon x402 pending <子命令>`。

```bash
bolloon x402 pending auth-init [--endpoint URL]   # 本机生成 0600 共享密钥 (+ 指纹, 供人工对拍)
bolloon x402 pending key  [--json]                # 查看本机钥匙来源/DID/公钥 (不打印私钥)
bolloon x402 pending list [--status awaiting_signature] [--json]
bolloon x402 pending show <pendingId> [--json]
bolloon x402 pending sign <pendingId> [--json]    # 本机签名 + 自检 + 回传
```

`--endpoint` 缺省取本机 auth 文件里记的 endpoint; 可用 `BOLLOON_SELLER_HOME` 指向别的 home (测试/多身份用)。

**真跑输出** (本节所有输出都是真终端跑出来的, 隔离 HOME + 本地测试端点, local-dev 凭据, **0 真钱**):

```text
$ bolloon x402 pending list --endpoint http://127.0.0.1:61724
卖方待办 (http://127.0.0.1:61724) — 共 1 条, 待签名 1 条
  pnd_e340cd62ea760e3a  [awaiting_signature]  info_probe_item  0.012 USDC@base-sepolia  2026-09-28T10:43:37.176Z
      内容哈希 sha256:d1590003d74332fb44dfc5717f95262f493260005a3f6232f11ce0a73048eea4 · 付款凭据哈希 sha256:4146f475a392d557b6cd7208694a504819ecb83acb93fd3093b1dc09a6c27bd7 · mode=local-dev
  下一步: bolloon x402 pending show <pendingId> → sign <pendingId>
```

```text
$ bolloon x402 pending show pnd_e340cd62ea760e3a --endpoint http://127.0.0.1:61724
待办 pnd_e340cd62ea760e3a  [awaiting_signature]
  item          info_probe_item  (探针条目)
  卖方 DID      did:key:z6Mkg387qPpY96huADDsHqjR5sJcrPY4j7LiwsBphcRqvRat
  内容哈希      sha256:d1590003d74332fb44dfc5717f95262f493260005a3f6232f11ce0a73048eea4
  来源声明      kind=self refs=0
  价格          0.012 USDC@base-sepolia → 0x1111111111111111111111111111111111111111
  付款          mode=local-dev  0.012 USDC@base-sepolia
  付款凭据哈希  sha256:4146f475a392d557b6cd7208694a504819ecb83acb93fd3093b1dc09a6c27bd7   ← 签名会绑定它
  付款凭据原文  eyJtb2…ZSwi…   (回执原文, 本机要用它重建哈希)
  链上 txHash   local-dev:8119fe8400652147b7f2c6841093fe0e
  付款方        local-dev
  创建/过期     2026-09-28T10:43:37.176Z → 2026-10-05T10:43:37.176Z
  下一步: bolloon x402 pending sign pnd_e340cd62ea760e3a
```

```text
$ bolloon x402 pending sign pnd_e340cd62ea760e3a --endpoint http://127.0.0.1:61724
签名自检: ✅ ed25519Verify 通过
  签名        Jvhifa4lg2eDqrTKeASxR4x5sHnE…  (base64, 完整值用 --json)
  签名公钥    178878b6e879e7048b2e5026b19a9bb3e231371dce86a3d0fde9d214ba772115
  钥匙来源    identity.json (DID did:key:z6Mkg387qPpY96huADDsHqjR5sJcrPY4j7LiwsBphcRqvRat)
  载荷绑定    itemId=info_probe_item · contentHash=sha256:d1590003d74332fb4… · receiptHash=sha256:4146f475a392d557b…
✅ 已回传并收下 — pendingId=pnd_e340cd62ea760e3a envelopeHash=sha256:bb95f1578771b23c41e79d82323070bcb43c622a62bdeafb59e6bb4c8151b40e
   买方下一步: 用取件 token 取 (不要重放付款凭据 —— 会再跑一遍结算):
     GET /api/x402/info/info_probe_item/pending/pnd_e340cd62ea760e3a   → 200 + 信封, 然后 ed25519Verify / verifyEnvelope 离线验签
```

签名的**私钥来自** `~/.bolloon/identity.json` (与 `agent-identity.ts` 同一个文件, 同一个 DID),
`sign` **调用既有 `ed25519Sign()`**, 没有第二套签名实现; 签名前本机先自己 `ed25519Verify` 一遍,
**自检不过就不回传**。

---

## 九、验收证据 (真跑)

测试文件 `src/test/x402-seller-signing.test.ts` — **40/40 通过** (真 HTTP 服务 + 真 `npx tsx src/cli-entry.ts` 子进程):

```text
$ npx vitest run src/test/x402-seller-signing.test.ts
✓ src/test/x402-seller-signing.test.ts (40 tests) 6.55s
 Test Files  1 passed (1)
      Tests  40 passed (40)
```

覆盖: 402 逐字 (含 `accepts[0]` 字段级断言) · 认证四类拒绝 (无头/未知 keyId/时间戳偏移/签名被改) ·
nonce 重放 · 0600 权限 · 幂等 (同 receipt → 同待办) · **反面对照** (重放 X-PAYMENT → 新 receipt, 所以取件走 token) ·
真 CLI 三个子命令 (exit=0 且 stdout 只可能来自 CLI) · 本机先拒签 (内容被改 / DID 不符) ·
服务器侧四道门 (未钉公钥 503 / 别的钥匙 400 / 载荷被改 / 已签不许改写) · 用户队列文件里无私钥/无 secret。

买方侧离线验签 (探针真输出):

```text
ed25519Verify(卖方公钥, canonical(proof.payload), proof.signature) = true
公钥与卖方身份一致 = true · did=did:key:z6Mkg387qPpY96huADDsHqjR5sJcrPY4j7LiwsBphcRqvRat
verifyEnvelope → 🟡 self-attested (签名与内容对得上, 但身份/支付未上链核实)
阴性对照: 内容改 1 字节 → content-integrity ok = false
密钥卫生: identity.json 600 · auth 文件 600 · 队列文件含私钥=false · 含共享密钥=false · CLI 输出含私钥=false
```

---

## 十、没做 / 未验证 / 残余风险 (如实)

1. **【2026-09-28 已过期, 保留作历史】这一版没有任何真钱结算**: 当时全程 local-dev 凭据。
   **现况**: `direct` 模式已实现并上机, 且**已用真钱跑通一次** (0.01 USDC, 见 §十一);
   `/api/health` 现为 `settlement:{mode:"direct", onchain:true, custody:"none"}`。
   `facilitator` 仍**未启用** (那一路的钱会经过第三方/自建 relayer)。
2. **卖方不在线 = 买方只有 202**。没有兜底、没有代签; 也**没有退款通道** (过期后钱已经动过,
   退款属结算层设计, 本链路不含)。
3. **取件 token 是不记名 token**: 泄漏 token = 泄漏内容; local-dev 模式下买方本就能自行推导它。
   生产用路 A/B 时建议在 token 上再加"只认付款方地址"的绑定 (未实现)。
4. **过期待办不会被自动清理**, 也没有"卖方离线告警"推送 (买方只能自己轮询)。
5. **单密钥、无轮换协议**: 共享密钥更换要两边同时换文件; 密钥丢了只能重新 `auth-init` +
   重放服务器文件 (无 KMS/无多 key 并存)。
6. **未做 DID 解析**: 买方只能认定 `self-attested` (签名与内容对得上, 身份/支付未验), 这是
   `verifyEnvelope` 的**如实**结论, 不是本链路的缺陷, 但也不能当成"已验证卖方身份"。
7. ECS 侧 `server.mjs` 与那几个配置文件**不在 git 里** (部署物, 记录见服务器 `RELEASE.txt`);
   换机器要重新放文件 —— 这是本部署的现状, 未做成镜像。
   本次新增的 `lib/x402/direct-payment.js` 是**仓内编译产物** (`npx tsc` → `dist/agents/x402/`,
   含 `node --check` 自检), 上机只拷贝 + `install -o bolloonpay -g bolloonpay -m 644`;
   已备份 `server.mjs.bak-<ts>` 与 `lib.bak-<ts>` 供一条命令回滚。
8. **【2026-09-28 已解除, 保留作历史】写这一版时服务器侧端点还没上机** (`GET /api/x402/seller/pending`
   实测 404)。**现况**: `/api/x402/seller/**` + 取件通道 + 直付 `/payment` 都已部署到 `pay.bolloon.cn`,
   真实域名下的 `list / show / sign / 取件` 已真跑一次 (输出见 §十一 与 `log.md` 本轮详细段)。
   仍未验证的是**并发与长期运行**: 队列并发写入、台账在多进程下的竞争、长时间无人值守的重试节奏
   —— 本页所有结论都来自**单进程、单笔**的真跑。

**§十一 追加的如实条目 (直付模式)**:

9. **直付不退不追**: 买方发错金额/发错地址, 服务器只会**拒** (钱已经在链上, 谁也拿不回来) ——
   本模式**没有**退款通道, 也没有仲裁。
10. **核验依赖公共 RPC 的可用性**: 少一条 RPC 活着的时机 (或它对较旧交易收据限流/要求 token),
    核验会如实判"不确定"并**拒交付** (fail-closed)。后果是**买方可能被卡住** (钱已付、货取不到),
    出路只有: 等 RPC 恢复后**重投同一个 txHash** (幂等, 不会再扣钱) 或人工介入。
    实测踩到过: `base.publicnode.com` 免费档对稍旧交易回 `-32602 Archive requests require a personal token`
    ⇒ 已从缺省对里剔除, 生产用 `BOLLOON_X402_DIRECT_RPCS` 配三条 (≥2 条一致才算过)。
11. **确认数门槛是"够用"不是"终局"**: 本部署 `BOLLOON_X402_DIRECT_CONFIRMATIONS` 缺省 **2**
    (base 上约几秒)。Base 的真实终局性来自 L1 结算, 本模式**没有**等 L1。
    要更严就调高该 env (代价是买方等待); **重组后已交付的信封不会自动回收** (无回滚语义)。
12. **一台服务器 = 一个信任点 (但只是"读链"这一点)**: 服务器可以撒谎说"链上有一笔付款"吗? ——
    不能凭空造 txHash, 但**它可以选择性地说某笔真实交易有效** (例如假装金额够)。
    所以买方**不该**只信卖方的核验结论: 回执里带 `txHash/payer/payTo/amount`, **买方自己也能两条 RPC 复核**
    (本轮真钱测试就是这么做的: 买方侧独立读链 2/2 一致)。这条要写进买方 SDK 的默认路径才算真的补上 (未做)。
13. **`direct` 与「卖方本机签名」是两件事**: 付款走通了**不等于**拿到货 —— 卖方不在线时买方仍然只有 202。
    真钱测试里这两段是**都**跑通了, 但那是卖方(人)在场; 无人值守时"付了钱、货没到手"的窗口**依然存在**。

---

## 十一、`direct` 模式 (去中心化直付 · 买方自己发交易 · 卖方只读链核验) + 首笔真钱端到端 (2026-09-28)

这一节是**另一种结算路**: 买方用**自己的钱包**把 USDC 直接转到 `payTo`, 把 `txHash` 交回卖方端点,
卖方端点**自己去链上核验**。全程**没有** facilitator、没有平台账号、没有托管地址 ——
钱从买方钱包直达卖方地址, 卖方端点只有**读链**权限 (它连私钥都没有)。

### 11.1 开关与自述 (开/关都能从 health 看出来)

```bash
BOLLOON_X402_DIRECT=1              # 打开 direct 模式 (缺省关: 关着时 /payment 回 503 DIRECT_MODE_DISABLED)
BOLLOON_X402_DIRECT_RPCS=https://mainnet.base.org,https://base.drpc.org,https://1rpc.io/base
BOLLOON_X402_DIRECT_CONFIRMATIONS=2
BOLLOON_X402_DIRECT_TIMEOUT_MS=12000
```

`GET /api/health` (真实回显, 2026-09-28T11:04:29Z):

```json
"settlement": {
  "mode": "direct", "onchain": true, "custody": "none",
  "detail": "买方直付 + 链上核验: 3 条 RPC 交叉 (mainnet.base.org, base.drpc.org, 1rpc.io), 确认数 >= 2; **不经过任何第三方托管/facilitator**",
  "paymentPath": "/api/x402/info/:id/payment",
  "rpcs": ["mainnet.base.org", "base.drpc.org", "1rpc.io"], "minConfirmations": 2
},
"direct": {
  "enabled": true, "onchain": true, "custody": "none",
  "rpcs": ["mainnet.base.org", "base.drpc.org", "1rpc.io"],
  "minRpcAgreement": 2, "minConfirmations": 2, "paymentPath": "/api/x402/info/:id/payment"
}
```

关掉 `BOLLOON_X402_DIRECT` 时: `settlement.mode` 回到 `none`/`local-dev`/`facilitator` (与原来一致),
`direct.enabled=false`, `/payment` 回 **503 `DIRECT_MODE_DISABLED`** 且**不碰链**。**任何情况下都不许**
把 `local-dev` 或 `mode=none` 读成"已上链"。

### 11.2 核验规则 (缺一条就不算付款)

| # | 判据 | 说明 |
| --- | --- | --- |
| 1 | `eth_chainId == 8453` | 每条 RPC 各自核 (回执所在链) |
| 2 | `receipt.status == 1` | 失败交易不算 |
| 3 | 回执日志里有一条 **USDC 合约 `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`** 的 `Transfer` | `topics[0]` = `0xddf252ad…`; 噪声日志不影响 |
| 4 | 该 `Transfer` 的 `to == payTo` (逐字, 大小写不敏感) | 打到别的地址不算 |
| 5 | `value (原子) >= accepts.amount` (10000 = 0.01 USDC) | 少付不算 |
| 6 | `confirmations >= BOLLOON_X402_DIRECT_CONFIRMATIONS` (本部署 2) | 刚进内存池的不算 |
| 7 | **≥2 条不同 RPC 结论一致** (`minRpcAgreement`) | **单条 RPC 说"钱到了"不构成事实**; 只要出现**两条相矛盾**的结论 ⇒ 判"不确定", **不交付** |
| 8 | 该 `txHash` **没有被别的 item 用过** | 见 11.4 幂等 |

**为什么必须两条 RPC**: 一台 RPC 可以抽风、可以撒谎、可以落后。卖方端点是**唯一**的核验方,
它自己就是一个信任点 —— 所以至少让它**不能靠单一来源**下结论。买方**也**不该只信卖方:
回执里带 `txHash/payer/payTo/amount/network`, 买方用**自己的** RPC 就能复核 (本轮真钱测试就是这么做的)。

### 11.3 HTTP 面 (接上既有 pending/取件链路, 没有第二套)

```
POST /api/x402/info/:id/payment      body: {"txHash":"0x…64hex"}
  → 202 {protocol, pendingId, receiptHash, retrieveUrl, retrieveToken, verify:{…}, paymentAttempt:{rpcChecks}}
  → 402 (核验没过; accepts **逐字** + error.code=DIRECT_PAYMENT_NOT_VERIFIED + rpcChecks 逐条状态)
  → 400 TXHASH_INVALID / 400 INVALID_ARGUMENT / 404 信息不存在 / 409 TXHASH_ALREADY_USED / 503 DIRECT_MODE_DISABLED
GET  /api/x402/info/:id/pending/:token   → 200 信封 / 202 待签 / 410 过期 / 404 token 无效 (既有实现, 未改语义)
```

**真钱跑的完整三跳 (本机 `curl --noproxy '*' --resolve pay.bolloon.cn:443:120.26.82.43`)**:

| 跳 | 请求 | 回显 |
| --- | --- | --- |
| 402 | `GET /api/x402/info/info_efficode_spec_pack` (不带付款头) | **HTTP 402** · body sha256 `133664c0cdb6411fc2d33eede5c0cb8232934dabdf6e5ac8e0e73abc67efadc2` — **上机前后逐字节相同** (改动没有动 402 一个字节) · `accepts.amount=10000` · `network=base` · `payTo=0xb4e9dCF7…0066` |
| 202 | `POST /api/x402/info/info_efficode_spec_pack/payment` `{"txHash":"0x8d06bc84…0ff1"}` | **HTTP 202** · `pendingId=pnd_6396ee5824eaa79f` · `mode=direct` · `confirmed=true` · `confirmations=13` · `payer=0x6a3f…80eb` · `verifiedBy=[mainnet.base.org, base.drpc.org]` · 待办记录 + `retrieveToken` (值不复述) |
| 200 | 买方本机签名后, 用取件 token `GET /api/x402/info/info_efficode_spec_pack/pending/pnd_6396ee5824eaa79f` | **HTTP 200** + 信封 (`envelopeHash=sha256:b05a4de50bb323006802962c2da2aa6fb440a7795832d5572ebd4fea4d37376a`) |

再投一次**同一个 txHash** → **200 + 同一个信封** (不是第二条待办): `/api/health` 的
`sellerQueue.pending=1 / delivered=1` 就是证据 —— 幂等命中, **没有多出第二条待办**。

### 11.4 幂等台账 (落盘, 不靠数据库)

`<服务目录>/.bolloon/x402-direct-txs.json` (**0600**, 本部署 = `/opt/bolloon-pay/.bolloon/x402-direct-txs.json`, 803B):

```json
{"txHash":"0x8d06bc84…0ff1","itemId":"info_efficode_spec_pack","network":"base",
 "payer":"0x6a3f797592bed028f6afd6da82339c8e815480eb","amount":"10000",
 "verifiedBy":["mainnet.base.org","base.drpc.org"],"minConfirmations":2,
 "confirmations":13,"blockNumber":51901934,
 "receiptHash":"sha256:fb2c7becc20499bd42396e7292552af718bb0b7056dc34cc5122fc51234a98b0",
 "custody":"none","firstSeenAt":"2026-09-28T11:00:39.817Z"}
```

- 同 `txHash` + 同 `itemId` ⇒ 回执**逐字相同** (时间取台账**首见** `firstSeenAt`, 不取当前时间)
  ⇒ 同 `receiptHash` ⇒ 同 `pendingId` ⇒ **同一条待办** (`reused:true`)。
- 同 `txHash` + **别的** `itemId` ⇒ **409 `TXHASH_ALREADY_USED`** (一笔链上付款只换一条资源)。
- 台账是唯一事实源: 它没了 = 幂等没了 (**但不影响已交付的信封**, 那些在 `envelopes/` 里)。

### 11.5 首笔真钱端到端 (0.01 USDC · 2026-09-28)

买方钱包 = **全新生成** (0600 文件, **不进仓**): `0x6A3f797592BEd028F6AfD6DA82339C8e815480eb`。
卖方 `payTo` = `0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066` (**≠ 买方地址**, 不是自付自收)。

| # | 做什么 | txHash | 金额 | gasUsed × gasPrice | 实花费 |
| --- | --- | --- | --- | --- | --- |
| 1 | 主钱包 → 买方: gas ETH | `0x9296eadf164194038e06a1c11cc1b4e058df74042705bf4faca5a482a9167dfa` | 0.00001 ETH | 21000 × 6,000,000 wei | 0.000000126 ETH |
| 2 | 主钱包 → 买方: 货款本金 | `0xbb321e11b5d7a5d94610aa9292a153d55e99f5b459d8ba3247a8df0d4bd9d7c1` | **10000 原子 USDC (0.01)** | 62147 × 6,000,000 wei | 0.000000372882 ETH |
| 3 | **买方 → payTo: 真付款** | `0x8d06bc84888ffcb09b47811aab3776c9ef601b454ab79ae62455f436836e0ff1` | **10000 原子 USDC (0.01)** | 40235 × 6,024,837 wei | 0.000000242409316695 ETH |

浏览器: `https://basescan.org/tx/<上面每个 hash>`。
**gas 合计 0.000000741291316695 ETH** (≈ $0.0025 @ $3300/ETH); **货款 0.01 USDC** (一次性, 单品)。
三笔都 `status=1`, 且**三条 RPC 各读一遍收据结论一致** (`recover.mjs`, 3/3)。

余额 (两 RPC 同值, 前 → 后):

| 账户 | 前 | 后 |
| --- | --- | --- |
| 主钱包 (`0xb4e9dCF7…0066`) ETH | 0.00029075 (探针 8 位) | **0.00028024745652117** |
| 主钱包 USDC | 0.663959 | **0.663959** (0.01 出去 → 0.01 从买方回到 `payTo`=同一地址, 净值 0) |
| 买方 (`0x6A3f…80eb`) ETH | 0 | **0.000009754738888283** |
| 买方 USDC | 0 | **0.000000** (全额付掉了) |

> 差额自洽: 主钱包 ETH 减少 `0.0000105` = 转出 0.00001 + 第 1/2 笔 gas (0.000000126 + 0.000000372882)。

### 11.6 本机签名 → 买方离线验签 (真输出)

```
$ npx tsx src/cli-entry.ts x402 pending list
卖方待办 (https://pay.bolloon.cn) — 共 1 条, 待签名 0 条
  pnd_6396ee5824eaa79f  [signed]  info_efficode_spec_pack  0.01 USDC@base  2026-09-28T11:00:39.817Z
      内容哈希 sha256:868f7ffe…3e24c7 · 付款凭据哈希 sha256:fb2c7bec…a98b0 · mode=direct

$ npx tsx src/cli-entry.ts x402 pending show pnd_6396ee5824eaa79f
  付款          mode=direct  0.01 USDC@base
  付款凭据哈希  sha256:fb2c7becc20499bd42396e7292552af718bb0b7056dc34cc5122fc51234a98b0   ← 签名会绑定它
  链上 txHash   0x8d06bc84888ffcb09b47811aab3776c9ef601b454ab79ae62455f436836e0ff1
  付款方        0x6a3f797592bed028f6afd6da82339c8e815480eb
  已签信封哈希  sha256:b05a4de50bb323006802962c2da2aa6fb440a7795832d5572ebd4fea4d37376a

$ npx tsx src/cli-entry.ts x402 pending sign pnd_6396ee5824eaa79f --endpoint https://pay.bolloon.cn
   (exit=0) 真跑关键两行; 字面量取自 src/cli/x402-seller-command.ts:185 / :195:
签名自检: ✅ ed25519Verify 通过
✅ 已回传并收下 — pendingId=pnd_6396ee5824eaa79f envelopeHash=sha256:b05a4de50bb323006802962c2da2aa6fb440a7795832d5572ebd4fea4d37376a
   (同一次输出里的其它固定行: 签名公钥 4fd6d7d974be905b2cea6234d76b28384a4024fc317de77a6a0de82df15593af ·
    钥匙来源 identity.json (DID did:key:z6MkjpvG9Zu3DSYpE72LCApMVKYkZa4WMNGyPRBVc8acn83g) ·
    载荷绑定 itemId=info_efficode_spec_pack · contentHash=sha256:868f7ffe… · receiptHash=sha256:fb2c7bec…)
```

**签名幂等是"拒"不是"重签"**: 再跑一次 `sign` → `❌ 这条待办状态是 signed — 不能签 (已签过/已过期都不许重签)`;
而**服务器**侧重投同一个 txHash → **200 + 同一个信封**。两边都封死"同一笔付款产生两个版本"。

买方侧**离线**(不经过服务器) 验签 (`verify-envelope.mts`, 只用信封 + 卖方公钥):

```
trust = self-attested · ok = true
   ✔ protocol / content-integrity / provider-signature (ed25519 ok, key 4fd6d7d974be…)
   ✔ signed-payload-consistency / payment-binding / source-provenance / expected-item
   ✘ did-binding (soft): 未提供 DID 解析器 (跳过)   ← 如实: 未做 DID 解析 ⇒ 只能认定 self-attested
✅ 内容哈希重算 == item.contentHash  sha256:868f7ffeb6577612a12a35b122bc4532e0ea38c201991f5acd83faa30c3e24c7
✅ 信封内容逐字 == 卖方本机发布的内容副本  bytes=20103
✅ 回执 txHash == 买方支付的 txHash  0x8d06bc84…0ff1
✅ 回执 payer == 信封 payer  0x6a3f797592bed028f6afd6da82339c8e815480eb
✅ 回执自称 direct / custody=none
✅ 阴性①: 内容改 1 字节 → content-integrity 红 + unverified
✅ 阴性②: 改签名载荷 → ed25519Verify 失败 + content-only
✅ 阴性③: 换公钥 → 验签失败 + content-only
=== 总判定: ✅ 离线验签通过, 三个阴性对照全部按预期失败 ===
```

### 11.7 实现位置与测试

| 件 | 说明 |
| --- | --- |
| `src/agents/x402/direct-payment.ts` (新) | direct 模式全部: 判定 + 多 RPC 交叉 + 台账 + HTTP handler (`handleDirectPayment` / `directHealth` / `directPaymentEnabled`) |
| `src/test/x402-direct-payment.test.ts` (新) | 聚焦测试: 起**真 HTTP JSON-RPC 服务** (回放夹具, 含噪声日志/落后节点/互相矛盾的节点), 不靠真网络 |
| `src/web/routes-x402-info.ts` | 新增 `POST /api/x402/info/:id/payment` 路由 + envelope `mode` 三态映射 |
| `src/agents/x402/{paid-info-protocol,paid-info-store,seller-signing}.ts` | 类型联合加 `'direct'` (无新协议、无第二套信封) |
| 上机物 | `dist/agents/x402/*.js` → `/opt/bolloon-pay/app/lib/x402/` + 新版 `server.mjs` |

---

## 十二、公开只读汇总 `GET /api/x402/seller/summary` (2026-09-29)

> 一句话: 这是**卖方本机的交付台账 (链下)**, 对外只读 —— 每笔都对应一笔**已在链上核验过**
> 的直付交易 (带 `tx_hash` + 块号 + 区块浏览器链接), 第三方可**自己**上链复核。

### 12.1 它与 §十/§十一 的分工 (别混)

| | 谁看 | 认证 | 内容 |
| --- | --- | --- | --- |
| `GET /api/x402/seller/pending` (§十一) | **卖方本机** | **HMAC 认证** (0600 共享密钥) | 待办 + **付款凭据原文** + 取件 token (私有面) |
| `GET /api/x402/seller/summary` (§十二, 新) | 任何人 / 网页 / 统一索引区 | **无** (公开只读) | **聚合数字 + 公开链上事实** (tx_hash / 块号 / 浏览器链接) |

- 两条都长在 `^~ /api/x402/` 之下 (**nginx 白名单不用动**)。
- 汇总分支必须挂在队列分支**之前** —— 队列分支是 `p.startsWith('/api/x402/seller/')`, 放后面会把 summary 一起 401 掉。

### 12.2 数据源与口径

| 源 | 文件 | 用来算什么 |
| --- | --- | --- |
| 直付台账 | `<服务目录>/.bolloon/x402-direct-txs.json` | `chain_verified_sales` · `revenue` · `by_item` · `latest` · `sales[]` · `txs{}` |
| 交付队列 | `<服务目录>/.bolloon/x402-seller-pending/*.json` | `delivered` · `awaiting_signature` · `pending_total` · `delivered_tx_hashes[]` |

- **每请求实时读盘, 不缓存** (新成交 / 新签名不必重启服务)。
- 计数口径 = **本端点收款地址上、经链上核验的直付成交**; **不是**全网站点销量, **也不是**合约托管/结算总量 (托管结算在链上合约里)。
- 交付队列只读**状态 / 时间 / `payment.txHash`**, **凭据原文一律不读出来**。
- 读不到任何源 → 空数组 + 0 且**仍 200** (不 500, 不拿"读不到"冒充"没成交")。

### 12.3 隐私红线 (硬; 由 `auditSellerSummaryLeaks` 在代码里守着)

- **绝不返回**: 取件 token · 付款凭据原文 / 回执哈希 · 任何密钥 / DID · **任何 EOA 或合约地址**
  (付款人 `from` · 收款人 `to` · 资产合约 `asset` · item 的 `payTo` 全都不出)。
- **允许**: `tx_hash`(0x+64) 与 `explorer_tx`(区块浏览器**交易**链接) —— 本来就是公开链上事实。
- 判据是「**键名白名单 + 值形态**」双判: 键名命中禁用词即剔 (带一份 ALLOWED_KEYS 白名单,
  免得 `awaiting_signature` 被 `signature` 误伤); 值里出现 0x+40 地址 / 非白名单键下的 0x+64 → 剔除
  (地址形态用负向前瞻与 64 位哈希区分, 否则哈希前 40 位会被误判); `txs{}` 的**键**必须逐个是
  0x+64 且行内只许 `itemId/amount/settledAt`; 行级泄漏剔除该行并计入 `privacy_blocked`,
  顶层泄漏则**不对外给这个对象** (退回空结果), 宁少报也不泄漏。

### 12.4 返回体 (机器可读)

```jsonc
{
  "protocol": "bolloon-x402-seller-summary/1",
  "ok": true,
  "scope": { "title": …, "ledger": … /* 卖方本机台账(链下), 不是链上索引 */, "verifiable": …, "not": … },
  "generated_at": "2026-09-29T02:53:55.648Z",
  "totals": { "chain_verified_sales": 1, "delivered": 1, "delivered_unverifiable": 0,
              "awaiting_signature": 0, "pending_total": 1 },
  "delivered_tx_hashes": ["0x8d06bc84…0ff1"],                       // 已交付笔数 → 对应链上 txHash
  "txs": { "0x8d06bc84…0ff1": { "itemId": "info_efficode_spec_pack", "amount": "10000", "settledAt": "…" } },
  "total_atomic": "10000",
  "revenue": { "amount_atomic": "10000", "amount_display": "0.01 USDC", "currency": "USDC" },
  "by_item": [ { "item_id": …, "sales": 1, "amount_atomic": "10000", "amount_display": "0.01 USDC", "currency": "USDC", "network": "base" } ],
  "latest": { "settled_at": …, "item_id": …, "amount_atomic": "10000", "currency": "USDC", "network": "base",
              "chain_id": 8453, "block_number": 51901934,
              "tx_hash": "0x8d06bc84…0ff1", "explorer_tx": "https://basescan.org/tx/0x8d06bc84…0ff1" },
  "sales": [ /* 同上, 按时间倒序, 每笔一行 */ ],
  "privacy_blocked": 0
}
```

- `txs{}` 的字段名是 **camelCase**(`itemId/amount/settledAt`) 且**键就是 txHash** —— 这是给
  「统一索引区」交叉核用的最小机器面 (链上只看得见普通 ERC-20 转账, 单看链分不出"走没走 x402");
  仓内消费方 `scripts/x402-seller-summary.ts` 按这个形状建索引 (`totalAtomic` / `total_atomic` 两个
  兼容键都给)。**改形状 = 那边会静默变成「口径未知」**, 所以 `src/test/x402-seller-summary.test.ts`
  里照着它的抽取规则钉了契约。
- 该链**没有已知浏览器** (如本机 31337) → `explorer_tx` 键整个不存在 (绝不编死链)。

### 12.5 实现与上机物

| 件 | 说明 |
| --- | --- |
| `src/agents/x402/seller-summary.ts` (新) | `buildSellerSummary(home)` (聚合 + 隐私守卫) · `sellerSummaryResponse(home)` (HTTP 形状, 永远 200) · `auditSellerSummaryLeaks(obj)` (判据, 单测直接跑) |
| `src/test/x402-seller-summary.test.ts` (新) | 13 条: 计数 / 按 item 汇总 / 时间倒序 / 空目录 / 坏文件 / 过期待签名不冒充可交付 / 已交付→txHash 列表 / 未知链不给链接 / 隐私审计含**变异验证** / `txs{}` 契约 |
| `src/agents/x402/paid-info-store.ts` | 只加 `fromAtomicAmount` (原子→人读, 纯整数, `toAtomicAmount` 的逆; 展示用, 不参与判定) |
| `src/agents/chain/explorer.ts` | (既有) `explorerTxUrl(chainId, txHash)` —— 白名单 4 条链, 只造 `/tx/0x64hex`, **没有地址链接构造器** |
| 上机物 | `dist/agents/x402/seller-summary.js` → `/opt/bolloon-pay/app/lib/x402/` · `dist/agents/x402/paid-info-store.js` (带新函数) · **`dist/agents/chain/explorer.js` → `lib/chain/` (新目录)** · 新版 `server.mjs` (381→400 行) |

### 12.6 部署与验证 (本轮真跑)

```bash
# 备份 → 语法检查 → 就位 → (就位后) 真 import 试加载 → restart → 5s 后 active
cp -p server.mjs server.mjs.bak-<ts>; cp -a lib lib.bak-<ts>
node --check server.mjs                                    # 候选文件本地检查
install -o bolloonpay -g bolloonpay -m 644 <候选> <目标>     # 644 + 属主 bolloonpay
node --input-type=module -e "await import('file:///opt/bolloon-pay/app/lib/x402/seller-summary.js')"  # ★ 就位后试加载
systemctl restart bolloon-pay; sleep 5; systemctl is-active bolloon-pay
```

- ⚠️ **试加载必须在 lib 同级齐全的目录里跑**: `seller-summary.js → paid-info-store.js → paid-info-protocol.js`
  是**兄弟相对导入**, 在只放了 `seller-summary.js` 的 staging 目录里试会报 `ERR_MODULE_NOT_FOUND` (本轮真撞到)。
- 公网真验 (`curl --noproxy '*' --resolve pay.bolloon.cn:443:120.26.82.43`): summary **200** · `seller/pending`
  仍 **401 `SELLER_AUTH_REQUIRED`** · 不带付款头 402 body sha256 `133664c0…dc2` **逐字未变** (上机未碰 :id 那支) · health **200**。
- 回滚: `cp -a server.mjs.bak-<ts> server.mjs && rm -rf lib && cp -a lib.bak-<ts> lib && systemctl restart bolloon-pay`
  (回滚后 summary 回 404; 402/health/pending 不受影响)。本轮记录追加在服务器 `/opt/bolloon-pay/RELEASE.txt`。

### 12.7 未做 / 边界 (如实)

- **不做全链扫描**: 端点只覆盖**本收款地址上的直付成交**。Base 公共 RPC 的 `eth_getLogs`
  **单次上限 2000 块**, 大窗口会被拒 (`eth_getLogs is limited to a 2,000 range`) ⇒ 要扫必须 ≤2000 分块。
- 核验依赖 **≥2 条公共 RPC 结论一致** (矛盾即不记账) ⇒ 台账是"已核验过的事实", 不是"链上全量"。
- 该端点**公开无认证** —— 它是聚合面, 只出聚合与公开链上事实; **凭据/取件面仍在 HMAC 队列**里, 由 §十一 守着。
- **页面上的付款/成交展示不由本端点负责**: Store / 可售资产区块**只讲「是什么 / 多少钱 / 怎么买 + 诚实边界」**,
  销量与链上交互的统一展示区归另一条线 (2026-09-29 leo 拍板)。
- 卖方不在线时买方仍只有 `202 已付款待签名` (交付是本机签名, 与"钱到了"是两件事)。
