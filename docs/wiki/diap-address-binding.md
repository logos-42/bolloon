---
title: DIAP 地址↔DID 绑定登记 (diap-address-binding/1)
source: session
created: 2026-09-29
last_confirmed: 2026-09-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [diap, address-binding, did, ed25519, eip191, off-chain-registration, privacy-gate, payer-identity, network-pulse]
---

# DIAP 地址↔DID 绑定登记 (`diap-address-binding/1`)

**为什么要它**: 链上只有 `Transfer(from, to, value)` —— `from` 是一个裸 EOA。网关要把付款行读成
「谁付的」, 只能靠一份**登记**把一个地址翻成智能体身份。这份登记**不是链上事实** (链上没有地方放它),
所以它是一条**链下登记**: 一份被**两侧分别签名**的声明, 可以离线复验 (leo 2026-09-29 拍板)。

**身份不另造一套**: DID / 公钥 / 私钥全部走仓内既有的 DIAP 身份 —— `~/.bolloon/identity.json`
(`@diap/sdk` 的 `KeyManager.fromFile`, 与 `src/agents/agent-identity.ts` / 卖方签名同一份),
签名复用既有 `ed25519Sign` / `ed25519Verify` / `canonicalize` (`src/agents/x402/paid-info-protocol.ts`)。

---

## §1 声明正文 (冻结)

签名对象**只有这一段字节串** (canonical: 键按 `sort_keys` 排序 + 无空格, UTF-8):

```json
{"protocol":"diap-address-binding/1","did":"did:key:z6Mk…","address":"0x…全小写","chainId":8453,"issuedAt":"<ISO8601>","expiresAt":null,"nonce":"<32 位小写 hex = 16 字节, 一次性>"}
```

| 字段 | 约束 | 说明 |
|---|---|---|
| `protocol` | 必须 `diap-address-binding/1` | 协议名; 换协议名 ⇒ 整条拒 |
| `did` | `did:key:z…` (Ed25519 multibase) | **必须**由 `did_public_key` 派生出来 (`did_matches_public_key`) —— 凭空写一个别人的 DID 过不了 |
| `address` | **全小写** `0x` + 40 hex | 声明认领的地址 |
| `chainId` | 正整数 (谓词: 8453 = Base 主网) | 只作声明域, 不联链 |
| `issuedAt` | ISO8601 | 签发时刻 |
| `expiresAt` | ISO8601 或 `null` | `null` = 不过期; 过期 ⇒ 整条拒 |
| `nonce` | 32 位小写 hex (16 字节) | **一次性**; 同一枚 nonce 出现两次 ⇒ 两条都拒 (fail-closed) |

`statement_json` 落盘保存的是**被签名的那份字节串**; 验证时**重算** `canonicalize(statement)` 并与它
逐字节比对 —— **不是 canonical 的那一份直接拒** (哪怕它对签名本身没影响)。
`id` = `ab-` + `sha256(statement_json)` 前 16 位 ⇒ 改一个字节就换 id。

## §2 双侧证明 (不可协商)

| 侧 | 谁签 | 对什么签 | 证明什么 |
|---|---|---|---|
| `sig_did` | **DID 私钥** (Ed25519, raw 32 字节种子) | `statement_json` | 这个 DID 认领这个地址 |
| `sig_addr` | **该地址私钥** (EIP-191 `personal_sign`) | **同一份** `statement_json` | 这个地址的主人同意被这样认领 |

判定 = `ed25519Verify(did_public_key, statement_json, sig_did)`
**且** `ethers.verifyMessage(statement_json, sig_addr).toLowerCase() === statement.address`。

**缺一侧 / 任一侧不通过 ⇒ 拒**; 不许静默降级成「可信」。为什么必须两侧: 只有 DID 签名 ⇒ 任何人可以
声称任意地址; 只有地址签名 ⇒ 证明不了那是哪个智能体。**两侧分别报结论**
(`sig_did_ok` / `sig_addr_ok`), 所以「缺一侧」与「两侧都错」在输出里分得开。

**名字 (label) 的覆盖**: 冻结正文里没有 label 字段, 所以名字另有一枚 `label_sig` (DID 私钥对
`canonicalize({...statement, label})` 签名) —— **有 label 就必须验 `label_sig`**, 验不过 ⇒ **整条绑定拒**
(不是"名字不显示"这么轻)。没有 label 的绑定照旧只要两枚签名。

## §3 验签判据 (逐条)

`checks[]` 里每一条都会被真跑 (不短路), 任一不过 ⇒ `ok=false` + `reasons[]`:

`protocol` · `statement_present` · `statement_protocol` · `statement_did_shape` · `statement_address_shape` ·
`statement_chain_id` · `statement_nonce_shape` · `did_public_key_shape` · **`did_matches_public_key`** ·
**`statement_canonical`** · **`id_matches_statement`** · **`sig_did`** · **`sig_addr`** ·
**`label_covered`** (有 label 时) · `label_shape` · **`not_expired`** · **`nonce_unused`** (给了本机索引才判,
没给会如实写「这一条没跑」)。

## §4 命令面 (CLI)

```bash
# 登记 (双侧签名 + 落盘前**自验通过**才算成功)
bolloon identity bind-address --address 0x…全小写 --address-key-file <私钥文件> \
    [--label <名>] [--did-key-file <identity.json>] [--chain-id 8453] \
    [--expires-at <ISO8601>] [--bindings-dir <目录>] [--json]

bolloon identity bindings list   [--bindings-dir <目录>] [--json]   # 列 + 逐条重验
bolloon identity bindings show   <file> [--json]                    # 正文/签名/判据
bolloon identity bindings verify <file> [--bindings-dir <目录>] [--json]   # **不过 = 非零退出码**
bolloon identity bindings publish --out <path> [--bindings-dir <目录>] [--json]  # 对外投影 (只出短写)
```

红线 (在代码里落实, 不只是文档):

- **没有默认钱包路径** —— `--address-key-file` 必填。不替用户在 `~/.hermes/wallets/` 之类的地方挑一把钥匙
  (那正是「手滑拿主钱包签名」的来源)。
- 私钥只在进程内用一瞬, **不进 stdout / 不进绑定文件 / 不进日志** (输出里只有地址 + DID + 短写)。
- 落盘前**自验不通过 ⇒ 整条命令失败**(`POLICY_DENIED`), 不留半成品。
- `nonce` 生成前先查本机索引, 撞了就换。
- 同 id (同一份正文) **不许覆盖** —— 改一个字节会换 id, 同 id 说明正文一字未变。

## §5 绑定库 (`~/.bolloon/bindings/`)

- 每份绑定一个文件 `ab-<16 hex>.json` (**0600**; 里面**没有**私钥, 但仍是私有事实);
- 聚合索引 `index.json`: 每条的 `id/address/did/did_short/name_short/chainId/issuedAt/expiresAt/verified_at/file`
  + `nonces{nonce→id}` (**一次性判据的唯一来源**);
- **加载给快照时逐条重验** (`loadPayerIdentityIndex`): 不是信 `verified_at` 这个时间戳, 而是当场把
  `verifyAddressBinding` 再跑一遍。重验不过的**一条都不进表**并**如实记账** (`rejected[{id,reasons}]`);
- nonce 唯一性只在**验签通过**的记录之间判 (索引是扫目录来的, 一条垃圾文件不该能把真绑定顶成"重放");
  同一枚 nonce 落在两条上 ⇒ **两条都拒** (分不清谁是先来的就不猜);
- 同一地址有多条 (换 DID 重登记) ⇒ 取 `issuedAt` 最新的那条 (平手取 id 小的, 确定性)。

## §6 索引集成: 付款行多出 `payer_identity`

`src/agents/network-pulse.ts` 的付款行构建 (`buildPaymentRowsFromTransfers`) 在**付款方地址命中已验签绑定**时
多出一个字段 (键集冻结, 只有这 5 个):

```json
"payer_identity": {"name_short":"x402-buyer-test","did_short":"z6MkqX2ejeXv",
                   "verified":true,"method":"diap-address-binding/1","source":"off-chain-signed"}
```

- **没有匹配的已验签绑定 ⇒ 这个键整个不出现**(不是空名、不是 null、不猜名字、不出 DID);
- 只有 `payment_in` 行才可能有它 (别的行没有"付款方"这一说);
- `name_short` = label 清洗 (`[A-Za-z0-9._-]` + 中日文, ≤24 字符);
  `did_short` = `did:key:` **之后**前 12 字符 —— **不带 `did:` 前缀**(页面上不许出现 DID 形态, 前缀本身就是被门禁的形态);
- **地址本身不出公开面**(页面/快照的传统口径)。`bindings publish` 的对外投影里地址只以
  `address_hash`(sha256 前 16 位) 出现 —— 网关是**本机**按地址匹配的, 不需要把 EOA 发出去。
- 快照顶层多一块 **`payer_identity_scope`** (口径): `loaded/verified/rejected/rejected_reasons/rows_with_identity/
  reason/label{zh,en}/note{zh,en}/method/source` —— 页面就地把这一段标成
  **「链下登记(可离线验签)」**, 不与块号/tx_hash 混为一类表述。

**导出前自检** `payerIdentityIssues` (已并入 `snapshotConsistencyIssues`, 不过就**拒绝导出**):
行里有身份就必须有口径块 · 每条身份必须 `verified===true` + 键集恰好 5 个 + 短写形状精确且不含 `0x`/`did:` ·
只许长在 `payment_in` 行上 · `rows_with_identity` 必须等于行里**真数出来**的条数 · 口径说 `verified=0` 却行里有身份 ⇒ 判红。

## §7 隐私门 (有意修改, 只收紧)

站点侧 `bolloon-UI/scripts/pulse-privacy-check.py` 新增**第三批精确化**(理由写在文件头注释里):
`payer_identity` 是快照里**第一处**「文字名字」, 改动前它**根本没被解释**(写 `verified:false`、换协议名、
塞个空名字都能过)。现在它被单独核六件事: 出现位置只许 `confirmed_activity[i].payer_identity` ·
键集恰好 5 个 · 取值逐字对 (`verified` 必须**恰好是 `True`**) · 短写形状 + 不许含 `0x`/`did:`/`/`/空白 ·
只许长在 `payment_in` 行 · 顶层口径块形状 (label 双语 / 计数整数 / `rows_with_identity` 与行数相等)。

**为什么不算放宽**: EOA / 完整 DID / 取件 token / 凭据的规则**一字未改**; `SHAPES`(裸 0x40/0x64/DID/
multiaddr/peerID/IPNS) 仍在**所有位置**生效 (包括 `payer_identity` 里的每个值); 新增判据**全部**是
"不满足就拒"。对照测试 `scripts/test-pulse-guard.sh` 从 **29 条**增到 **46 条** (17 条新增: 2 条合法必须过 +
15 条注入必须拒), 真跑 **46 通过 / 0 不符**。

## §8 真跑证据 (2026-09-29)

- 本机真绑定: 测试买方地址 `0x6a3f797592bed028f6afd6da82339c8e815480eb`
  (`~/.hermes/wallets/x402-buyer-test.json`) ↔ **新建 DID** `did:key:z6MkqX2ejeXvsZbDAmJqTtAzc8dYhdp6VcMBYWGRcwFXygsL`
  → `ab-49e98fec0f50e745` · `verify` **17/17 判据全过, exit=0**。**没有用主钱包私钥签任何东西。**
- 阴性对照: 改一个字节再验 ⇒ `SIGNATURE_INVALID`, 退出码 1 (地址被改后 `statement_canonical` /
  `id_matches_statement` / `sig_did` / `sig_addr` / `label_covered` 一起响)。
- 快照: 两个真付款行 (blk 51901934 / 51930989) 多出 `payer_identity`
  (`name_short=x402-buyer-test` · `did_short=z6MkqX2ejeXv` · `verified=true`)。
- 两通道 (CF Pages + 备案主机) 快照 sha256 **逐字节相同**; 页面上 2 个 `.pulse-payer-word`,
  口径句以「付款方身份 2 行（链下登记·可离线验签）」收尾; 页面可见文本无 DID 形态 / 无 40 位地址。
- `verify-site.mjs` 线上 `https://bolloon.cn` **445 passed / 0 failed / 0 skipped**;
  页面上带名字的断言做了变异验证 (拿掉渲染 ⇒ 3 条真判红, 恢复后逐字节还原)。

## §9 未做 / 边界 (如实)

- **`label` (名字) 不在冻结正文里**, 由另一枚 `label_sig` 覆盖 —— 换成"把 label 编进正文"是 v2 的事
  (现在这样不改冻结格式, 但记录里多一个签名字段)。
- **`chainId` 只是声明域**, 没有链上校验 (声明不联链); 本机也没有"同一地址只能有一条绑定"的全局约束 ——
  多条并存时按 `issuedAt` 取最新 (旧条不删, 也不进表)。
- **发布通道只有"本机导出 + 本机 CLI publish"**: 没有 P2P/公共注册表广播, 别的节点拿不到这份登记
  (要跨机, 得先把 `bindings publish --out` 的产物放到双方都能取的地方, 且**各节点仍要自己能验签**)。
- **页面只显示名字 + DID 短写**: 没有"点开看绑定详情/验签"的页面 (离线复验走 `bindings verify`)。
- **没有到期回收**: `expiresAt` 到了只是"验签不过"(不出名字), 文件本身不自动清理。
- **没有密钥轮换流程**: 换 DID 要重新签一条 (旧条留在库里, 按 `issuedAt` 让位)。
- 绑定库是**本机私有事实**: 谁控制这台机器, 谁就能改自己的库 —— 对外可核验性来自**签名**, 不是来自这台机器。
