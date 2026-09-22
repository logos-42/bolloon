---
title: 链上模型冻结 (Phase 1) — 合约盘点 / 职责边界 / 事件与字段 / §3 硬规则差距
source: 审计 (2026-09-22 session) + docs/wiki/chain-settlement-design.md + raw/paste_2_112614 (§2/§3/§11/§12)
created: 2026-09-22
last_confirmed: 2026-09-22
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [chain, escrow, treasury, directory, freeze, audit, phase1]
---

# 链上模型冻结 (Phase 1)

> **本页性质**: 这是 **P1「合约审计与链上模型冻结」的产物**, 不是设计稿。凡标「冻结」的条目都是 **P2 及之后必须照做的口径**;
> 凡标「待定」的条目都写明了**卡在哪**。所有结论都带**可核验证据**(`文件:行号` 或**真实命令输出**)。
>
> **本次未改任何代码**: 未改 `src/**`、未改 `contracts/**/*.sol`、未 commit。产物只有本页 + `contracts/MODEL_FREEZE.md` + `docs/wiki/index.md` / `docs/wiki/log.md` 的索引与日志登记。

## 0. 一句话结论

- `AgentEscrow` **是**任务交易主合约的**正确选择**, 但**现状不具备成为事实源的条件**(缺 11 个字段、缺 3 类事件、有 1 个可绕过 proof 的取款口子) → **必须先出 v2 再部署**(P2)。
- `AgentTreasury` **冻结为组织资金出纳**, `payAgent` 是 `onlyOwner` → **普通任务交易禁止走 Treasury**; 并且**现状 `trade.ts` 并没有误用 Treasury**(它压根不碰任何合约), 真正的主路径是 **x402 facilitator 直付**(无 escrow、无 proof 绑定)。
- `AgentDirectory` **新增**(必需, 否则"错收款地址会被拒"无法实现)。
- `AgentTradeLedger` **不新增**(并入 Escrow 事件), 但**带条件**——现状事件不满足"仅靠事件重建时间线"。
- 五条硬规则里 **R5 已满足**, **R1 半满足**, **R2/R3 完全不满足**, **R4 链下满足/链上不满足**。

## 1. 合约盘点(先盘点, 不假设)

### 1.1 三个 Solidity 项目并存, 不是一个

| 项目 | 路径 | 构建 | solc | 优化 | 拥有的合约 |
|---|---|---|---|---|---|
| **Foundry 主项目** | `contracts/` (`contracts/foundry.toml`) | `forge` | `0.8.24` (`foundry.toml` `solc_version`, `src="."`, `out="out"`, `test="test"`) | **off** (`optimizer=false`) | `ResourceERC721.sol`(assetization, 与结算无关) + `test/ResourceERC721.t.sol`(18 用例) |
| **Hardhat 子项目** | `contracts/evm/` (`contracts/evm/hardhat.config.js`) | `npx hardhat` | `0.8.24` | **on** (`runs: 200`) | **`AgentEscrow.sol` / `AgentTreasury.sol`** + `mocks/MockERC20.sol`; 测试 `test/escrow.test.js`(11) / `test/treasury.test.js`(9) |
| **Solana (Anchor)** | `contracts/solana/agent-economy/` | `anchor`/`cargo` | — | — | `programs/agent-economy` (`F5rt6Skd9MW6oePaFa8TEfpo6zAUBqo53uH46nNgUY2G`; `register_agent`/`pay_agent`/`update_reputation`) — **不在本次 EVM 口径内** |

**结算相关的两个合约只住在 `contracts/evm/`, 不在 Foundry 主项目的 `src` 语义里** —— 但 `foundry.toml` 的 `src="."` 会把 `evm/` 一起编进去(见 §10.3 的坑)。

### 1.2 `AgentEscrow` — `contracts/evm/contracts/AgentEscrow.sol` (139 行)

- 状态: `token`(immutable IERC20, L21) · `owner`(L22) · `escrows: mapping(bytes32 => Escrow)`(L36) · `taskIds: bytes32[]`(L37) · `releaseTimeout: uint256`(L47, **构造后无 setter**)。
- `struct Escrow`(L26-34): `buyer` · `agent` · `amount` · `state` · **`string taskId`** · `createdAt` · `proofHash`。
- `enum EscrowState { ACTIVE, RELEASED, DISPUTED, REFUNDED }`(L24) —— **没有 CLAIMED**。
- 方法: `createEscrow(address,uint256,string)`(L58) · `submitProof(bytes32,bytes32)`(L70) · `release(bytes32)`(L80) · `claimAfterTimeout(bytes32)`(L94) · `dispute(bytes32)`(L105) · `refund(bytes32)` **onlyOwner**(L114) · `releaseAfterArbitration(bytes32)` **onlyOwner**(L123) · `balance()`(L136)。
- 事件: `EscrowCreated(bytes32 indexed,address,address,uint256)`(L39) · `ProofSubmitted(bytes32 indexed,bytes32)`(L40) · `Released(bytes32 indexed,address,uint256)`(L41) · `Disputed(bytes32 indexed)`(L42) · `Refunded(bytes32 indexed,address,uint256)`(L43) · `ClaimedAfterTimeout(bytes32 indexed,address,uint256)`(L44)。
- **现有 taskKey 切径**(L61, L131-133): `taskKey = keccak256(abi.encodePacked(taskIdString))` = `keccak256(UTF-8 bytes of taskId)`。测试把它当口径用: `contracts/evm/test/escrow.test.js:34` `ethers.keccak256(ethers.toUtf8Bytes(taskId))`, 与合约一致(该用例真实通过)。

### 1.3 `AgentTreasury` — `contracts/evm/contracts/AgentTreasury.sol` (197 行)

- 状态: `token`(immutable, L22) · `owner`(L23) · `allocation: Allocation`(L34, 6 类权重/分母 1000) · `frozen`(L37) · `registeredAgents`(L40) · `agentReputation`(L41) · `dailySpend: mapping(uint256=>uint256)`(L44) · `dailyLimit`(L45) · `pendingOwner`/`withdrawRequestedAt`(L49-50)。
- 方法: `deposit(uint256)`(L77, 任何人) · `allocate(uint256)` **onlyOwner**(L84) · **`payAgent(address,uint256)` onlyOwner + notFrozen**(L100) · `registerAgent(address,uint256)` **onlyOwner**(L115) · `updateReputation` onlyOwner(L123) · `updateAllocation` onlyOwner(L132) · `updateDailyLimit` onlyOwner(L140) · `transferOwnership`/`acceptOwnership`(L148/L154) · `setFrozen`(L163) · `requestEmergencyWithdraw`/`emergencyWithdraw`(L174/L178) · `balance()`(L189)。
- 事件: `Deposited(address indexed,uint256)`(L52) · `AgentRegistered(address indexed,uint256)`(L53) · **`AgentPaid(address indexed,uint256)`(L54, 没有 taskKey/escrow 关联)** · `Allocated(string,uint256)`(L55) · `FreezeToggled(bool)`(L56) · `AllocationUpdated(Allocation)`(L57) · `DailyLimitUpdated(uint256)`(L58) · `OwnershipTransferRequested/Transferred`(L59-60) · `EmergencyWithdraw(address indexed,uint256)`(L61)。
- `payAgent` 的门(L100-111): `onlyOwner` + `!frozen` + `registeredAgents[agent]` + `agentReputation>=60` + `dailySpend[day]+amount<=dailyLimit`。

### 1.4 **不存在**的合约(用全仓 grep 证明)

`AgentDirectory` / `AgentTradeLedger` / 任何 `escrow-client` / `src/agents/chain/` 目录 —— **在仓库里一个都没有**。
grep `taskKey|termsHash|quoteHash|manifestHash|capabilityRoot|didHash|contractVersion|confirmationWindow|proofVersion|paymentAsset` 在 `*.sol/*.ts/*.js` 中**零命中**(唯一命中是 `dist/**` 与 `.kilo/**` 里同名的**无关**符号: `orbitdb/kanban-store.ts` 的本地 `taskKey(id)`、`external-engines/delegate-handle.ts` 的 `DELEGATE_CONTRACT_VERSION`)。

### 1.5 链下侧(集成现状, 决定了"计划 §7 表"的两行结论)

| 事实 | 证据 |
|---|---|
| `trade.ts` **完全不碰合约** | `src/agents/x402/trade.ts:12-18` 只 import `transaction-protocol / transaction-store / settlement-state`; 付款走 `buyInfo`(L182-183) |
| 真实付款 = **x402 facilitator `/verify`+`/settle`** | `src/agents/x402/paid-info-store.ts:229,244,248,255,264` (`BOLLOON_X402_FACILITATOR`) |
| 或 `local-dev`(显式开关) | `paid-info-store.ts:275` (`BOLLOON_X402_LOCAL_VERIFY=1`) |
| **`chainSettled` 只由"有没有 txHash 字符串"决定** | `paid-info-store.ts:414-419` → `chainSettled: !!txHash` |
| **全仓 `src/` 没有任何 receipt / 确认数 / 事件重读** | grep `waitForTransactionReceipt\|getTransactionReceipt\|confirmations` 在 `src/`(排除 vendored `node_modules`) **零命中** |
| `Treasury.payAgent` 只有一处调用方 | `src/agents/treasury-bridge.ts:129-134` ← 被 `src/agents/pi-sdk-tools.ts:2636-2690`(`treasury_pay` / `treasury_status` 两个 LLM 工具)与 `src/test/treasury-bridge.test.ts` 使用; **`trade.ts` 不引用它** |
| 直付的另一条路(x402 原生) | `src/agents/x402/x402Pay.ts:143`(`writeContract` ERC20 transfer)/`:159`(原生转账) —— **直接打款给 `payTo`, 无 escrow** |
| 网络/代币表(硬编码, 无 env) | `paid-info-store.ts:120-132`(`USDC_BY_NETWORK`/`assetFor`); `x402Pay.ts:80-95`(`RPC_URLS`/`EVM_NETWORKS`), `:417`(重复一份 base-sepolia USDC) |
| 链下生命周期/结算事实(11 态 + 8 事实 + 红线) | `settlement-state.ts:25-36`(状态) · `:156-166`(事实) · `:184-186`(`CHAIN_BACKED_FACTS` / `LOCAL_DEV_MAX_FACT='payment_submitted'`) · `:196-198`(local-dev 禁升) |
| 链下 `verified` 的判定 | `transaction-protocol.ts:153-156`(`evaluateTransactionSuccess`: `chainSettled !== true` → 直接拒, 门槛行在 `:154`) |
| 本地事实源 | `transaction-store.ts:32-34`(`transactionId = tx-<sha256(requestId)[:12]>`, 确定性 id) |

## 2. 冻结 A: `AgentEscrow` 是任务交易主合约

**结论(冻结)**: 是。P2 部署的 **`AgentEscrow v2`**(补字段/事件后)是**唯一**持有买家资金并按「proof → release」顺序出金的合约; 一切"任务交易已完成"的链上证据必须能追到它的 `EscrowCreated`/`ProofSubmitted`/`Released`/`Refunded`/`ClaimedAfterTimeout`。

**现状 vs 要求**(缺什么):

| 计划要求(design §2.1 / raw L63-96) | 现状 | 差在哪 |
|---|---|---|
| 主路径 8 方法 | **7 个已实现**(无独立 `recordQuote` 类方法, 也不需要) | — |
| `bytes32 taskKey` 取代 `string taskId` | 两者都有: 存 `string taskId`(L31) + 用 hash 做 key(L36) | **未满足**: 正文式 `string` 仍上链(L31, L64) |
| `quoteHash` | 无 | 缺字段 |
| `inputHash` | 无 | 缺字段 |
| `resultHash` | **只有 `proofHash`**(L33) — 语义混用 | 缺字段/语义需拆 |
| `manifestHash` | 无 | 缺字段 |
| `termsHash` | 无 | 缺字段 |
| `chainId` | 无(合约不存链 id) | 缺字段 |
| `contractVersion` | 无 | 缺字段 |
| `createdBlock` | 只有 `createdAt`(时间戳) | 缺字段 |
| `deadline`(每任务) | 只有**全局** `releaseTimeout`(L47, 无 setter) | 缺"每任务 deadline" |
| `confirmationWindow` | 无 | 缺字段 |
| `paymentAsset`(每 escrow) | 只有**合约级** immutable `token`(L21) | 缺"每 escrow 记录" |
| `proofVersion` | 无 | 缺字段 |

## 3. 冻结 B: `AgentTreasury` 的边界(严查会不会被误用成双边主路径)

**结论(冻结)**:

1. **普通任务交易(买方 ↔ 卖方 Agent)禁止走 `Treasury.payAgent`。** 结构性理由: `payAgent` 是 `onlyOwner`(`AgentTreasury.sol:100`)—— 走它意味着**只有平台 owner 私钥能出钱**, 买方无法自主发起, 且资金流是「平台 → agent」而不是「买方 → agent」, 这与「买方托管、验收后释放」的语义**根本不同**。
2. **`Treasury` 只做四件事**: 资金入池(`deposit`)· 按权重分配/补贴(`allocate`)· 平台奖励与信誉门槛支付(`payAgent`, 有 `registeredAgents`+`reputation>=60`+`dailyLimit` 三道门) · 紧急与治理(`setFrozen`/两段式所有权/延迟提现)。
3. **`AgentPaid(address indexed, uint256)`(L54) 不含 `taskKey`** → 即使有人拿 Treasury 付了任务款, **链上也无法把该笔付款对回任何任务**。这条本身就否掉了"用 Treasury 当任务主路径"的可行性。
4. **`trade.ts` 现状核查(计划 §7 点名要查的)**: **没有误用**。`trade.ts` 不 import 任何合约客户端; 真正的任务付款路径是 **x402 facilitator 直付**或 `local-dev`(见 §1.5)。唯一会调用 `Treasury.payAgent` 的是**显式工具** `treasury_pay`(`pi-sdk-tools.ts:2636-2690`)。
5. **风险(需要冻结住)**: 直付路径与 Treasury 路径**都没有 taskKey 绑定**, 且 `chainSettled` 只凭 `txHash` 字符串(`paid-info-store.ts:419`)。P3 起 `trade.ts` 必须改走 escrow; **在此之前, 任何"链上已验证"的展示都只代表"拿到过一个 txHash 字符串"**(会展示到 UI: `src/web/server.ts:3000`, `src/agents/task/report-card.ts:175`)。
6. **一个任务只允许一种支付路径**(冻结): escrow 路径生效后, 同一个 `requestId` **不得**再走 facilitator 直付 —— 否则同一任务可能有两次真实出金。落地时 `paymentMode` 需要新增 `'escrow'`(现状类型是 `'facilitator' | 'local-dev' | 'none'`, `paid-info-store.ts:192`), 属 **P3 代码改动**。

## 4. 冻结 C: **新增** `AgentDirectory`(结论 + 理由 + 不做的代价)

**结论(冻结)**: **新增**, 与 `AgentEscrow v2` 同批部署(P2)。

- **理由(为什么现在就必须有)**: 现状 `createEscrow` 里 `agent` 是**任意传参**(`AgentEscrow.sol:58,59`), 合约**不校验**该地址是否属于某个已注册 Agent。于是 §12 验收里的「**错误收款地址会被拒绝**」在当前模型下**物理上无法实现** —— 没有任何链上真值可对照。Directory 提供的就是这个真值: `didHash ↔ payoutAddress ↔ manifestHash ↔ capabilityRoot ↔ version ↔ active`。
- **冻结字段/方法**(对齐 design §2.3 / raw L121-147): `registerAgent` · `updateManifest` · `publishCapability` · `revokeAgent`; 只上链 `didHash`/`payoutAddress`/`manifestHash`/`capabilityRoot`/`version`/`active`; 完整 manifest 留在 P2P/OrbitDB/IPFS。
- **不做的代价(明确写清)**: ① 外部 Agent 无法验证"这个收款地址属于这个 Agent"; ② 争议时没有链上证据说明当时绑定的 manifest/能力是什么; ③ §12 的两条验收(错收款地址被拒 / taskKey 不一致被拒)只能靠链下 registry 自述, 等于没有; ④ P7 网页 Explorer 的「Agent 已注册」这类公共事件没有来源(design §9 表里 Pulse 的"Agent 已注册"就指着 Directory 事件)。
- **必须同时解决的职责重叠(冻结)**: `AgentTreasury.registerAgent/agentReputation`(`AgentTreasury.sol:40-41,115,123`)与 Directory **重复**。冻结为: **Directory 是对外注册的唯一真相源**; Treasury 的白名单/信誉在 P3 改为**读 Directory 或退役**, 不得两套并存(否则同一个"agent 已注册"有两个可能矛盾的答案)。

## 5. 冻结 D: **不新增** `AgentTradeLedger`(带条件 + 代价)

**结论(冻结)**: **不新增**, 把公共生命周期记录**并入 `AgentEscrow` 事件**。

- **理由**: `AgentTradeLedger` 不持资金(raw L161-163), 是纯事件合约。若单列, 则「escrow 状态改变」与「公共日志记录」是**两次独立写入**, 存在一边成功一边失败的原子性缺口; 且多一个需要治理/升级/多签的合约。并入 Escrow 后, **一条交易日志 = 一个链上事实**, P5 索引器只需扫一个地址。
- **生效条件(硬)**: design §2.4 / raw L165-169 的三个条件必须全部满足, 否则退回"新增 Ledger":
  1. 每个状态转换都有事件;
  2. 事件包含 `taskKey` 与对应 hash;
  3. 网页可以**只靠事件**重建交易时间线。
  **现状不满足条件 2、3**(见 §6.4 事件缺口) → 所以这条"不新增"是**有条件冻结**, 条件是 P2 的 v2 事件表。
- **代价(诚实写)**: ① Escrow ABI 变大, P5 索引器要按 topic 过滤; ② 未来若想让第三方只读"公共日志"而不暴露 escrow 细节(金额/买卖方), 需要再加合约或加一层最小事件合约; ③ 事件里不能放 `string reason`(gas/索引), 只能用 `reasonHash`, 网页要展示争议原因必须结合链下数据。

## 6. 事件与字段冻结

### 6.1 通用哈希规则(冻结, 双方必须能独立复算)

1. **链上 32 字节值一律 `keccak256`**(EVM 原生)。`sha256` 只用于**链下内容摘要**(仓库既有口径, 见 6.3)。
2. **多字段哈希一律用 `abi.encode`**(32 字节对齐、无拼接歧义), **禁止**对多个动态类型用 `abi.encodePacked`。
3. **每个哈希第一个参数是域标签**: `bytes32` ASCII, 右补零。已冻结四个:
   `bytes32("bolloon.task.v1")` · `bytes32("bolloon.terms.v1")` · `bytes32("bolloon.quote.v1")` · `bytes32("bolloon.proof.v1")` · `bytes32("bolloon.cap.v1")`。
4. **单值字符串**用 `keccak256(abi.encodePacked(s))`(等价于 `keccak256(bytes(utf8(s)))`), 只有一个动态参数时无歧义 —— 这正是现状 `_taskHash`(`AgentEscrow.sol:131-133`)的做法。
5. 所有 hash 的**入参顺序 = 本节表格声明顺序**, 不得靠命名猜。

### 6.2 冻结切径表(逐项, 精确到类型与拼接顺序)

| 值 | 冻结定义 | 谁能复算 | 现状 |
|---|---|---|---|
| `taskKey` **v2** | `keccak256(abi.encode(bytes32("bolloon.task.v1"), taskIdString))` | 任一持有 `taskId`(= 现有 x402 `requestId` 字符串) 的一方 | 缺(v2 新增)。**过渡兼容**: 现有合约用 `keccak256(abi.encodePacked(taskIdString))`(L131-133) — 两者都必须在 deployment manifest 里登记, 否则历史交易对不上 |
| `quoteHash` | `keccak256(abi.encode(bytes32("bolloon.quote.v1"), requestId, payTo, paymentAsset, chainId, amountAtomic, quoteIssuedAt))` | 买卖双方(报价四要素都来自 402 响应体: `paid-info-store.ts:164-172`) | 缺 |
| `termsHash` | `keccak256(abi.encode(bytes32("bolloon.terms.v1"), taskKey, quoteHash, paymentAsset, chainId, amountAtomic, deadline, confirmationWindow))` | 双方 | 缺 |
| `contentHash`(链下既有口径) | `"sha256:" + sha256Hex(content)` = `computeContentHash`(`paid-info-protocol.ts:148-150`) | 双方(卖方签名时也算它) | **已有**, 直接复用 |
| `inputHash` | `keccak256(bytes(utf8(computeContentHash(canonicalize(inputPayload)))))` | 双方 | 缺 |
| `resultHash` | `keccak256(bytes(utf8(computeContentHash(resultContent))))` —— 即**对链下 `"sha256:<hex>"` 字符串整体取 keccak** | 双方(拿到结果正文即可复算) | 缺(现在被 `proofHash` 兼着) |
| `manifestHash` | 同 `resultHash` 口径, 对象换成 manifest 的 `canonicalize()` 结果 | 卖方 + 任一想验证的第三方 | 缺 |
| `proofHash` | `keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion))` —— **把 `proofVersion` 绑进哈希**, 防"旧版 proof 当新版" | 双方 | 现状 = 任意 `bytes32`(测试用 `keccak256(utf8("cid:QmResult123"))`, `escrow.test.js:29`) |
| `reasonHash`(争议) | `keccak256(abi.encode(bytes32("bolloon.reason.v1"), taskKey, reasonText))` | 发起方 + 仲裁方 | 缺(`Disputed` 无此参数) |
| `didHash`(Directory) | `keccak256(abi.encodePacked(didString))`, `didString` = 现有 `did:diap:*` / `did:key:*`(`agent-registry.ts` / `agent-identity.ts` 口径) | 任何人 | 缺 |
| `capabilityRoot`(Directory) | capability 字符串先**按字典序排序**, `leaf_i = keccak256(abi.encode(bytes32("bolloon.cap.v1"), uint256(i), capability_i))`, root = 相邻两两 `keccak256(abi.encode(sortedPair))`; 空列表 = `bytes32(0)` | 任何人 | 缺 |
| `chainId` | EIP-155 数值(`uint256`): `84532` base-sepolia / `8453` base(与 `x402Pay.ts:88-95` 的 `eip155:NNNN` 同一取径) | 任何人 | 缺(链下已有映射表) |

**`canonicalize` 口径**(冻结): 键递归排序、丢弃 `undefined`、`JSON.stringify` —— 直接复用 `paid-info-protocol.ts:128-140`, 不得另写一套。

### 6.3 事件冻结

**现有事件签名(冻结: 不改签名, 避免破坏既有 ABI/测试)**

| 事件 | 签名(精确) | 位置 |
|---|---|---|
| `EscrowCreated` | `(bytes32 indexed taskId, address buyer, address agent, uint256 amount)` | `AgentEscrow.sol:39` |
| `ProofSubmitted` | `(bytes32 indexed taskId, bytes32 proofHash)` | `:40` |
| `Released` | `(bytes32 indexed taskId, address agent, uint256 amount)` | `:41` |
| `Disputed` | `(bytes32 indexed taskId)` | `:42` |
| `Refunded` | `(bytes32 indexed taskId, address buyer, uint256 amount)` | `:43` |
| `ClaimedAfterTimeout` | `(bytes32 indexed taskId, address agent, uint256 amount)` | `:44` |
| Treasury 现有 10 个 | 见 §1.3 | `AgentTreasury.sol:52-61` |

**v2 必须新增的事件(冻结提案; P2 实现时按此表, 索引字段 ≤3)**

| 事件 | 签名 | 状态转换 |
|---|---|---|
| `EscrowCreatedV2` | `(bytes32 indexed taskKey, bytes32 indexed quoteHash, address indexed buyer, address agent, address paymentAsset, uint256 amount, uint256 deadline, uint32 confirmationWindow, uint16 proofVersion, uint32 contractVersion)` | ACTIVE(创建) |
| `ProofSubmittedV2` | `(bytes32 indexed taskKey, bytes32 resultHash, bytes32 manifestHash, bytes32 proofHash, uint16 proofVersion)` | ACTIVE(有 proof) |
| `ReleasedV2` | `(bytes32 indexed taskKey, address to, uint256 amount, uint8 by)` — **`by`: 0=buyer 确认 / 1=仲裁 / 2=超时领取** | RELEASED(出金) |
| `RefundedV2` | `(bytes32 indexed taskKey, address to, uint256 amount, bytes32 reasonHash)` | REFUNDED |
| `DisputedV2` | `(bytes32 indexed taskKey, address by, bytes32 reasonHash)` | DISPUTED |
| `AgentRegistered`(Directory) | `(bytes32 indexed didHash, address indexed payoutAddress, bytes32 manifestHash, bytes32 capabilityRoot, uint256 version)` | Directory |
| `AgentManifestUpdated`(Directory) | `(bytes32 indexed didHash, bytes32 manifestHash, bytes32 capabilityRoot, uint256 version)` | Directory |
| `AgentRevoked`(Directory) | `(bytes32 indexed didHash, address payoutAddress)` | Directory |

`EscrowCreatedV2` 只带 `quoteHash`/`deadline` 等要素, `termsHash` 由二者+V2 之外参数派生(见 6.2) → 第三方可用 `quoteHash` + 公开报价复算 `termsHash`, **满足"另一方独立复算"**。

### 6.4 现状事件缺口(为什么 §5 的"不新增 Ledger"是有条件的)

| 缺口 | 证据 | 后果 |
|---|---|---|
| `Disputed` 没有 `reasonHash`、没有发起人 | `AgentEscrow.sol:42` | 争议原因无法上链/无法验证; 网页不知道谁提的 |
| **`release` 与 `releaseAfterArbitration` 共用 `Released`** | `:87` 与 `:128` | **仅靠事件无法区分"买方确认释放"与"仲裁释放"** → 违反"网页仅靠事件重建时间线" |
| `EscrowCreated` 不带 `termsHash`/`quoteHash`/`deadline`/`paymentAsset` | `:39` | 事件无法重建"条款是什么", 只能读存储; 且无法验证条款未被改 |
| 没有 `contractVersion` / `chainId` 事件或字段 | 全合约无 | `contract-registry`(design §4)无法做"合约版本/ABI 兼容"校验 |
| 无 `QuoteRecorded` 类事件 | raw L154-159 的 `recordQuote` 在现状无对应 | 报价 hash 无处登记 |
| 超时领取后 `state = RELEASED`(无 CLAIMED) | `:99` | 状态语义与 buyer release 合并, 只能靠事件名区分 |

## 7. 冻结: chainId / token / 确认数 / 合约版本

| 项 | 冻结结果 | 来源/证据 | 状态 |
|---|---|---|---|
| **chainId** | 目标 `84532`(base-sepolia, 测试网) → 后续 `8453`(base); **本地 `31337` 仅供 Hardhat 测试** | `x402Pay.ts:88-95`(`eip155:84532`/`eip155:8453`); `contracts/evm/hardhat.config.js:10`(`hardhat: { chainId: 31337 }`) | 取径冻结; **部署链未最终拍定** |
| **token** | `USDC`, `decimals = 6` | `paid-info-store.ts:135-142`(USDC=6) · `treasury-bridge.ts:124`(`decimals ?? 6`) | **冻结** |
| token 地址(base-sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `paid-info-store.ts:122` 与 `x402Pay.ts:417`(两处一致) | 冻结(测试网) |
| token 地址(base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `paid-info-store.ts:121` | 冻结(主网, 未用) |
| token 地址(mainnet/sepolia) | `0xA0b8…eB48` / `0x1c7D…7238` | `paid-info-store.ts:123-124` | 记录, 非目标网 |
| **合约地址** | **待定** — 仓库里**没有任何 deployment manifest**, grep `*deploy*` 零命中; Escrow 连 env 入口都没有(Treasury 有 `BOLLOON_TREASURY_RPC/ADDRESS/TOKEN/KEY`, `pi-sdk-tools.ts:2639-2642`) | `find -iname '*deploy*'` 空 | **待定**(卡在 P2 部署) |
| **确认数** | **待定** — 全仓 `src/` 无任何确认数逻辑(grep 零命中)。**建议值(等 leo 拍)**: `base-sepolia / base: finalizedAfterConfirmations = 12`, `confirmedAfterConfirmations = 1`, `hardhat(31337) 不出现在生产配置里` | grep `confirmations` 在 `src/`(排除 vendored ethers)零命中 | **待定**; 落地位置 = P3 `src/agents/chain/chain-config.ts` |
| **合约版本** | 现状三个合约**都没有版本字段** → 冻结为「已审计版本 = **v0 (2026-08-13, 无版本字段)**」; P2 部署的带 §6.3 事件的版本 = **v1, `uint32 = 1`**, 作为构造参数 immutable + deployment manifest 记录 | 全合约无 `version`; `git log` 显示合约最近改动 `b472585`/`28c5702` | **v0 冻结 / v1 数值待 P2 部署时写死** |

**一条不可绕过的冻结(与 §3 R5 对齐)**: `chainId = 31337`(Hardhat/本地)与任何 `local-dev` 支付模式, **永远不得**产生 `chainSettled = true` / `fully_settled` / `verified`(现状已满足, 见 §8 R5)。

## 8. 计划 §3「五条硬规则」↔ 现状代码差距表

| # | 硬规则(raw L176-181) | 现状 | 差距在哪一行 |
|---|---|---|---|
| **R1** | 没有交易哈希 → 不能标记 chain settlement | **半满足** | 判定门槛存在(`transaction-protocol.ts:153-156(门槛行 154)` 要求 `chainSettled===true`; `settlement-state.ts:196-198` 拦 local-dev), 但 **`chainSettled` 的来源只是"facilitator 回了 txHash 字符串"**(`paid-info-store.ts:414-419` `chainSettled: !!txHash`)。tx 是否真的上链、是否成功、合约状态对不对 —— **一次都没查**。→ 违反"**txHash 存在 ≠ 合约状态已经正确**" |
| **R2** | 没有正确合约事件 → 不能标记 escrow created/released | **不满足** | `src/` 里**没有任何代码读取 Escrow 事件**(grep `EscrowCreated` 在 `src/` 零命中)。链下用 HTTP 回执 + 本地记录代替事件 → 计划 §3 要求"必须通过 RPC 重新读取六项"(receipt/事件/确认数/存储/token 日志/escrow 状态)**一项都没做** |
| **R3** | 没有足够确认数 → 不能标记 finalized | **不满足** | 全仓无确认数概念(grep 零命中, 唯一命中在 vendored `ethers`)。当前语义是"facilitator 返回即 finalized" |
| **R4** | 没有 `proofHash`/`resultHash` → 不能标记 verified | **链下满足 / 链上不满足** | 链下: `verified` 要求 `contentHash` 匹配 + 签名 + `receiptHash` + `chainSettled`(`transaction-protocol.ts:153-156(门槛行 154)`, `trade.ts:264-290`)——**满足**。链上: **`claimAfterTimeout` 不要求 `proofHash != 0`**(`AgentEscrow.sol:94-102`, 与 `release` 的 `:84` 形成对比)→ Agent **可以零证明拿走托管资金**并把 state 置为 `RELEASED`; 事件 `ClaimedAfterTimeout` 也不含任何 hash。同时 `Escrow` 里没有 `resultHash`, `proofHash` 语义被兼用 |
| **R5** | `local-dev` → 永远不能标记 fully_settled | **满足** | `settlement-state.ts:186`(`LOCAL_DEV_MAX_FACT='payment_submitted'`)· `:196-198`(local-dev → `payment_verified/partially_settled/fully_settled` **一律拒**)· `transaction-protocol.ts:154`(local-dev 判 `verified` 直接 false)· `trade.ts:197-198`(local-dev 只写 `payment_submitted`)· 测试 `src/test/settlement-state.test.ts:72-80` 覆盖 |

## 9. 必须先改清单(P2/P3 动代码时按序办; **本次未改**)

**F0(工具链, 已被本次实测的坑固化)**: `contracts/foundry.toml` 未排除 Hardhat 子项目 → 一旦按 P2 要求装好 `contracts/evm/node_modules`, **`forge build` 直接失败**(forge 的 `src="."` 会走进 `evm/node_modules/**` 去编 `^0.5.0`/`^0.8.28` 的样板文件)。**修法**: `foundry.toml` 加 `skip = ["evm/node_modules/**"]`(或 `evm/lib/**` 同类排除)。**未改, 等确认**(证据见 §10.3)。
**F1**: `AgentEscrow` 补 §2 表里 11 个字段(`termsHash/quoteHash/inputHash/resultHash/manifestHash/chainId/contractVersion/createdBlock/deadline/confirmationWindow/paymentAsset/proofVersion`), 并把 `string taskId` 从存储里**去掉**(只留 `bytes32 taskKey`)。
**F2**: `claimAfterTimeout` 必须要求 `proofHash != bytes32(0)`(修 R4)。
**F3**: 事件补齐 §6.3 v2 表(尤其 `ReleasedV2.by` 区分 buyer/仲裁/超时; `DisputedV2.reasonHash`; `EscrowCreatedV2` 带 terms/quote/deadline/paymentAsset/version)。
**F4**: `Treasury` 与 `Directory` 的注册/信誉职责二选一(§4 冻结: Directory 为对外真相源)。
**F5**: `paid-info-store.ts:414-419` 的 `chainSettled = !!txHash` 必须由 P3 `settlement-verifier` 的**六项 RPC 重读**替换; 在此之前 UI(`web/server.ts:3000`, `report-card.ts:175`)的"链上已验证"只代表"拿到过 txHash"。
**F6**: 建 deployment manifest(`contracts/evm/deployments/<chainId>.json` 或等价物): 地址 + 部署区块 + bytecode hash + chainId + token 地址 + decimals + contractVersion; 并给 Escrow 补 env/配置入口(现在只有 Treasury 有)。
**F7**: USDC 地址表**三处重复**(`paid-info-store.ts:120-125`、`x402Pay.ts:417`、`src/test/x402-fetch.test.ts:7` 的 fixture), P3 `chain-config.ts` 上线后必须收敛为**单一来源**, 否则"错 token 会被拒"保证不了。
**F8**: 合约加 `contractVersion`(F1 的一部分), 否则 design §4 的 `contract-registry` 校验项无法落地。

**盘点中发现的明确缺陷(记录在案, 本次不改)**

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| D1 | `claimAfterTimeout` 无 proof 门槛 | `AgentEscrow.sol:94-102` | Agent 可零证明取走资金; 与 R4 冲突(见 §8 R4) |
| D2 | `releaseTimeout` **无 setter** 且是**全局**的 | `:47`,`:51-55` | 无 per-task `deadline`; 部署后不能调整; 无法表达"这笔 3 天、那笔 30 天" |
| D3 | `DISPUTED` 后**无任何超时兜底** | `:105-111`; 对比 E1 只兜底 `ACTIVE`(:94-102) | 争议一旦提起, 资金可被 owner 无限期扣在合约里(与 E1"防资金永久锁定"的修复精神不一致) |
| D4 | **`Treasury.allocate` 只 emit `Allocated` 事件, 不移动任何资金** | `:84-97`(`_allocated` 只有 `emit`) | 事件字面"按权重分配"而余额不变; 审计者极易把事件当转账记录 → 与 design §3"事件=公开记录"的前提冲突 |
| D5 | 未用 `SafeERC20`; `require(token.transfer(...))` | `:63,86,100,118,127` 等 | 对**不返回 bool** 的 ERC20(如 USDT)会 revert。USDC 返回 bool 所以当前可用 → **冻结 token 为 USDC** 是这条的前提 |
| D6 | 无 reentrancy guard | 全合约无 `nonReentrant` | 状态先置位后转账(`release` :85-86)已按 CEI 写, 风险低; 但引入外部 token 回调时需评估 |
| D7 | `taskIds` 数组无限增长, 无分页 event 化的枚举 | `:37,65` | 链上遍历不可行 → P5 索引器只能靠事件(更印证 §5 需要好事件) |
| D8 | 现状 `Released` 无法区分出金原因(同 §6.4) | `:87` vs `:128` | 时间线重建失败 |

## 10. 可运行性证据(真实命令与输出尾部)

> 环境: macOS · node `v24.13.0` · `forge 1.8.1`(`~/.foundry/bin`)· `hardhat 2.29.0`(本次 `npm ci` 装入 `contracts/evm/node_modules`, 已 gitignore)。
> `git status --short` 在本节所有命令后**均为空**(产物都在 ignore 内)。

### 10.1 Hardhat(合约真正所在) — 通过

```
$ cd contracts/evm && npx hardhat compile
Downloading compiler 0.8.24
Compiled 3 Solidity files successfully (evm target: paris).

$ cd contracts/evm && npx hardhat test
  AgentEscrow — Agent 服务托管
    ✔ createEscrow 创建托管 (资金入池)
    ✔ submitProof 后 buyer release 释放给 agent
    ✔ 无证明不能 release
    ✔ dispute 冻结 → owner refund 退款给 buyer
    ✔ dispute 后 owner 仲裁释放给 agent
    ✔ E2: agent 地址为 0 拒绝创建 (防资金黑洞)
    ✔ amount=0 拒绝创建
    ✔ E3: proofHash=0 拒绝提交 (0 不是有效证明)
    ✔ E1: 超时前 agent 不能 claim
    ✔ E1: 超时后 agent 可 claim (防资金永久锁定)
    ✔ E1: dispute 后不可 claim (争议优先)

  AgentTreasury — Agent 经济资金池
    ✔ deposit 外部资金进入 Treasury
    ✔ allocate 按权重分配 (事件)
    ✔ payAgent 信誉不足拒绝
    ✔ payAgent 日预算超限拒绝 (状态 dailyLimit, 不可绕过)
    ✔ payAgent 成功支付 + 日支出记录
    ✔ frozen 后拒绝所有操作
    ✔ updateAllocation 权重校验 (非 1000 拒绝)
    ✔ 两段式所有权转移
    ✔ 紧急提款需等待期

  20 passing (1s)
```

### 10.2 Foundry — 通过(需排除 Hardhat 依赖, 见 F0)

**真实基线(树内无任何 node_modules)**:

```
$ cd contracts && forge build      # exit 0
$ cd contracts && forge test
Suite result: ok. 18 passed; 0 failed; 0 skipped; finished in 2.36ms (30.20ms CPU time)
Ran 1 test suite in 14.84ms (15.52ms CPU time): 18 tests passed, 0 failed, 0 skipped (18 total tests)
$ ls out/ | grep -E 'Agent|Resource'
AgentEscrow.sol   AgentTreasury.sol   MockERC20.sol   ResourceERC721.sol   ResourceERC721.t.sol
```

要点: **Foundry 也编 `AgentEscrow`/`AgentTreasury`/`MockERC20`**(`src="."` 的副作用), 用的是 `0.8.24+commit.e11b9ed9` 且 `optimizer: {enabled: False}`(`foundry.toml` 口径); **但 `forge test` 只跑 `ResourceERC721Test` 18 个用例 —— Escrow/Treasury 在 Foundry 侧一个 Solidity 测试都没有**(只有 Hardhat 的 20 个 JS 用例)。

### 10.3 装好 Hardhat 依赖之后的坑(F0 的证据)

```
$ cd contracts && forge build
Unable to resolve imports:
      "truffle/Assert.sol" in ".../contracts/evm/node_modules/eth-gas-reporter/mock/test/TestMetacoin.sol"
Error: Encountered invalid compiler version in evm/node_modules/eth-gas-reporter/mock/contracts/ConvertLib.sol:
       No compiler version exists that matches the version requirement: ^0.5.0
Encountered invalid compiler version in evm/node_modules/hardhat/sample-projects/typescript-viem/contracts/Lock.sol:
       No compiler version exists that matches the version requirement: ^0.8.28
$ cd contracts && forge build --skip 'evm/node_modules/**'   # exit 0
$ cd contracts && forge test  --skip 'evm/node_modules/**'
Suite result: ok. 18 passed; 0 failed; 0 skipped; finished in 15.52ms
Ran 1 test suite in 26.30ms (15.52ms CPU time): 18 tests passed, 0 failed, 0 skipped (18 total tests)
```

**结论**: 两个工具链**现在可以同时存在**, 条件是 `forge build/test` 带 `--skip 'evm/node_modules/**'`(或按 F0 写进 `foundry.toml`)。这不是本次引入的新问题 —— 是 `src="."` + 子项目 node_modules 的固有冲突, 只是**第一次被实测暴露**。

## 11. 待定项(卡在哪)

| 待定 | 卡在哪 |
|---|---|
| 部署链(84532 还是 8453) | 需要在 P2 决定; 仓库里没有任何部署记录/manifest 可作依据 |
| 合约地址(Escrow/Directory/Treasury/Ledger) | 卡在 P2 部署; 现状无 manifest、Escrow 无 env 入口 |
| **确认数阈值**(`finalized`/`confirmed`) | 仓库内无任何来源; 需 leo 拍板(建议 12/1, 见 §7) |
| `contractVersion` 数值 | 需 P2 部署时写死(冻结规则已定: `uint32`, v1 起步) |
| `EscrowCreatedV2` 的最终字段顺序/是否拆两个事件 | 需要 P2 实现者按 §6.3 表落 Solidity; 顺序一旦上链即不可改 |
| `paymentMode` 新增 `'escrow'` 的枚举边界 | P3 代码改动(`paid-info-store.ts:192`), 与 `settlement-state.ts` 的迁移表要对齐后才能改 |
| `AgentDirectory` 与 `AgentTreasury.registerAgent` 的退役节奏 | 需 leo 决定"先并存双写, 还是一次性切 Directory" |
| `contracts/solana/` 是否纳入本次链上化 | 计划全文未提 Solana; 本次按**不纳入**处理 |

## 12. 与其他页面的关系

- 上游设计: [chain-settlement-design.md](./chain-settlement-design.md)(本页把它的 §2/§3 变成可核对的冻结项与差距表); 旧账本设计 [network-ledger-design.md](./network-ledger-design.md)(已被取代)。
- 链下语义(本页不改, 但要与之对齐): [transaction-two-layer-state.md](./transaction-two-layer-state.md) · [payment-recovery-protocol.md](./payment-recovery-protocol.md) · [milestone-dispute-responsibility.md](./milestone-dispute-responsibility.md)。
- 合约侧短版(给写合约的人看): `contracts/MODEL_FREEZE.md`。
