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

**两个诚实的边界**:

- 幂等键是 **receiptHash**, 不是"X-PAYMENT 原文"。local-dev 模式下回执带 `settledAt` 时间戳,
  所以**重放同一张 X-PAYMENT 会得到新 receipt → 新待办** (测试里有一条反面对照专证这件事)。
  facilitator 模式下 receipt 由 facilitator 签发, 同一张凭据**能**稳定映射到同一 receipt (取决于 facilitator 是否幂等)。
- 取件 token 是**不记名 token**: 谁拿到谁能取内容。facilitator 模式下 receipt 含 facilitator 的结算结果
  (`txHash` 等), 卖方之外不可推导; **local-dev 模式下买方能自己算出 receipt ⇒ token 不提供保密性**
  —— local-dev 是联调模式, **不是安全边界** (这条与 `access-protocol-v1` 的 local-dev 红线同口径)。

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

**硬话**: 卖方不在线时买方**拿不到信封** —— 这条链路不提供任何"服务器代签"或"先给内容后补签"的兜底。
若业务上不能接受"付了钱可能拿不到货", 该在**结算前**解决 (例如卖方在线性检查/托管), 不是在交付层做假。

---

## 六、与 facilitator 的关系: 两种结算路, **都不引入平台**

本链路只管**付款之后**的交付 (签名/回传/取件)。付款怎么完成由既有 `checkAndSettlePayment` 决定,
它支持两条路, **都不需要任何第三方平台账号或平台代收**:

| | 路 A: 自建 relayer | 路 B: 买方直付 + txHash 链上校验 |
| --- | --- | --- |
| 谁发交易 | 我们的 relayer (自建 EOA) 走 EIP-3009 `transferWithAuthorization` | **买方自己**在他的钱包里发 USDC 转账 (或 4337 账号) |
| 服务器角色 | 调 facilitator (`/verify` + `/settle`) | 服务器**只读链**: 按 `txHash` 取交易/回执, 校验 to/amount/asset/confirmation 数 |
| 私钥在哪 | relayer 私钥在**我们的**结算机上 (不是卖方机器, 也**不是**平台) | 买方钱包 |
| 卖方本机 | **不参与付款**, 只参与签名交付 | 同 |
| 现状 | 代码路径在 (`checkAndSettlePayment` 的 facilitator 分支), **本部署未启用** (`/api/health` 如实回 `settlement:{mode:"none",onchain:false}`) | 设计口径见既有链上化设计页; **本次未实现, 未启用** |

**两条路的共同点 (这才是关键)**: 无论哪条路, 交付都**只能**由卖方本机签名完成 ⇒ 平台/服务器
在**任何**配置下都无法冒名交付。反过来说: facilitator 若被攻破, 最多影响"钱怎么动",
**不影响"谁签的字"**。

> 本部署当前的付款头接受 `local-dev` (联调凭据, 需要显式 `allowLocalDev`) —— 这是**联调**模式,
> 不是结算。`/api/health` 一直如实标注 `onchain:false`, 不许把它读成"已上链"。

---

## 七、接口冻结 (端点 + 错误码)

### 7.1 买方侧 (对外, 无认证)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/x402/info/:id` | 无付款头 → **402 + accepts (逐字不变)**; 有付款头 → 200 信封 / 202 已付款待签名 |
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

1. **本次没有任何真钱结算**: 全程 local-dev 凭据; 不发链上交易、不调 facilitator、无真 txHash。
   `/api/health` 仍是 `settlement:{mode:"none", onchain:false}`。
2. **卖方不在线 = 买方只有 202**。没有兜底、没有代签; 也**没有退款通道** (过期后钱已经动过,
   退款属结算层设计, 本链路不含)。
3. **取件 token 是不记名 token**: 泄漏 token = 泄漏内容; local-dev 模式下买方本就能自行推导它。
   生产用路 A/B 时建议在 token 上再加"只认付款方地址"的绑定 (未实现)。
4. **过期待办不会被自动清理**, 也没有"卖方离线告警"推送 (买方只能自己轮询)。
5. **单密钥、无轮换协议**: 共享密钥更换要两边同时换文件; 密钥丢了只能重新 `auth-init` +
   重放服务器文件 (无 KMS/无多 key 并存)。
6. **未做 DID 解析**: 买方只能认定 `self-attested` (签名与内容对得上, 身份/支付未验), 这是
   `verifyEnvelope` 的**如实**结论, 不是本链路的缺陷, 但也不能当成"已验证卖方身份"。
7. ECS 侧 `server.mjs` 与那两个配置文件**不在 git 里** (部署物, 记录见服务器 `RELEASE.txt`);
   换机器要重新放文件 —— 这是本部署的现状, 未做成镜像。
8. **本页描述的服务器侧端点(`/api/x402/seller/**` 与取件通道)在写这一版时还没有部署到
   `pay.bolloon.cn`** —— 线上仍是"只发 402"的那一版 (`GET /api/x402/seller/pending` 实测 **404**)。
   所以: 本页 §一/§三/§七 的接口形态是**本机真跑验证过的契约**, 真实域名下的
   `list/show/sign` **尚未验证**。上机后必须复核 (402 逐字 · health · 队列端点带认证可拉取) 才算打通。
