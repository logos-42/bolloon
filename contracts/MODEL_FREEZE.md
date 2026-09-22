# MODEL_FREEZE — 合约侧链上模型冻结 (Phase 1)

> 给写合约的人看的短版。完整审计/证据/差距表在 `docs/wiki/chain-model-freeze.md`。
> 状态: **只冻结, 未改任何 `.sol`**。下面标 **【P2 必须做】** 的都还没做。

## 0. 现状一句话

| 合约 | 文件 | 现状 |
|---|---|---|
| `AgentEscrow` | `contracts/evm/contracts/AgentEscrow.sol`(139 行) | 7 方法 / 6 事件已实现并测试通过(11 用例); **缺 11 个字段、缺 3 类事件、`claimAfterTimeout` 可不带 proof 取款** |
| `AgentTreasury` | `contracts/evm/contracts/AgentTreasury.sol`(197 行) | 资金池;**`payAgent` 是 `onlyOwner`(L100)** → 只能当组织出纳, **不得当 A2A 主路径** |
| `AgentDirectory` | — | **不存在** → 【P2 必须做】新增 |
| `AgentTradeLedger` | — | **不存在** → 冻结决定:**不新增**, 事件并入 `AgentEscrow`(条件是事件表补齐) |
| `ResourceERC721` | `contracts/ResourceERC721.sol` | 资产化, 与结算无关 |
| `contracts/solana/agent-economy` | Anchor | 不在本次 EVM 口径内 |

## 1. 编译 / 测试命令(实测, 2026-09-22)

```bash
# 合约真正住在 contracts/evm/ (Hardhat 子项目)
cd contracts/evm && npm ci            # 首次: 需要网络; 本次装了 hardhat 2.29.0
cd contracts/evm && npx hardhat compile   # → Compiled 3 Solidity files successfully (evm target: paris)
cd contracts/evm && npx hardhat test      # → 20 passing (1s)

# Foundry (contracts/ 根; solc 0.8.24, optimizer off)
export PATH=$HOME/.foundry/bin:$PATH
cd contracts && forge build --skip 'evm/node_modules/**'   # 装了 hardhat 依赖后必须带 --skip
cd contracts && forge test  --skip 'evm/node_modules/**'   # → 18 passed (只有 ResourceERC721 的用例)
```

**坑(F0)**: `contracts/foundry.toml` 是 `src="."`, 所以装了 `contracts/evm/node_modules` 之后 **`forge build` 会去编 node_modules 里的样板合约并报错**(`^0.5.0` / `^0.8.28` 需求无法满足)。修法(未改, 等确认): `foundry.toml` 加 `skip = ["evm/node_modules/**"]`。
Escrow/Treasury **在 Foundry 侧没有任何 Solidity 测试**, 只有 Hardhat 的 20 个 JS 用例。

## 2. 字段表(冻结)

### 2.1 现状(`AgentEscrow.sol`)

```solidity
struct Escrow { address buyer; address agent; uint256 amount; EscrowState state;
                string taskId; uint256 createdAt; bytes32 proofHash; }   // L26-34
mapping(bytes32 => Escrow) escrows;   bytes32[] taskIds;                     // L36-37
uint256 public releaseTimeout;        // L47 — 构造后无 setter, 且是全局的(无 per-task deadline)
enum EscrowState { ACTIVE, RELEASED, DISPUTED, REFUNDED }                    // L24 — 无 CLAIMED
```

### 2.2 【P2 必须做】补这 11 个字段 + 去掉上链的 `string taskId`

`bytes32 taskKey` · `bytes32 termsHash` · `bytes32 quoteHash` · `bytes32 inputHash` · `bytes32 resultHash` · `bytes32 manifestHash` · `uint256 chainId` · `uint32 contractVersion` · `uint64 createdBlock` · `uint64 deadline`(每任务) · `uint32 confirmationWindow` · `address paymentAsset`(每 escrow) · `uint16 proofVersion`

规则: 存 `bytes32 taskKey`, **不再存 `string taskId`**(原始 id 留本地/加密链下)。

## 3. 事件签名(冻结)

### 3.1 现有(签名不改, 别破坏已测 ABI)

```solidity
event EscrowCreated(bytes32 indexed taskId, address buyer, address agent, uint256 amount);        // L39
event ProofSubmitted(bytes32 indexed taskId, bytes32 proofHash);                                 // L40
event Released(bytes32 indexed taskId, address agent, uint256 amount);                           // L41
event Disputed(bytes32 indexed taskId);                                                          // L42
event Refunded(bytes32 indexed taskId, address buyer, uint256 amount);                           // L43
event ClaimedAfterTimeout(bytes32 indexed taskId, address agent, uint256 amount);                // L44
```

### 3.2 【P2 必须做】v2 事件(补齐"网页仅靠事件重建时间线")

```solidity
event EscrowCreatedV2(bytes32 indexed taskKey, bytes32 indexed quoteHash, address indexed buyer,
                      address agent, address paymentAsset, uint256 amount, uint256 deadline,
                      uint32 confirmationWindow, uint16 proofVersion, uint32 contractVersion);
event ProofSubmittedV2(bytes32 indexed taskKey, bytes32 resultHash, bytes32 manifestHash,
                       bytes32 proofHash, uint16 proofVersion);
event ReleasedV2(bytes32 indexed taskKey, address to, uint256 amount, uint8 by);  // by: 0=buyer 1=仲裁 2=超时
event RefundedV2(bytes32 indexed taskKey, address to, uint256 amount, bytes32 reasonHash);
event DisputedV2(bytes32 indexed taskKey, address by, bytes32 reasonHash);

// AgentDirectory
event AgentRegistered(bytes32 indexed didHash, address indexed payoutAddress, bytes32 manifestHash,
                      bytes32 capabilityRoot, uint256 version);
event AgentManifestUpdated(bytes32 indexed didHash, bytes32 manifestHash, bytes32 capabilityRoot, uint256 version);
event AgentRevoked(bytes32 indexed didHash, address payoutAddress);
```

**为什么必须补**: 现在 `release`(L87)与 `releaseAfterArbitration`(L128)共用 `Released` → 只看事件**分不清是买方确认还是仲裁出金**; `Disputed` 没有 `reasonHash`/发起人。

## 4. 哈希切径(冻结 —— 另一方必须能独立复算)

1. 链上 32 字节值一律 `keccak256`; `sha256` 只用于**链下内容摘要**(`"sha256:<hex>"`)。
2. **多字段哈希一律 `abi.encode`**(32 字节对齐), 禁止对多动态类型用 `abi.encodePacked`。
3. 每个哈希第一个参数是域标签(`bytes32` ASCII 右补零):
   `bolloon.task.v1` / `bolloon.terms.v1` / `bolloon.quote.v1` / `bolloon.proof.v1` / `bolloon.cap.v1` / `bolloon.reason.v1`。
4. 单值字符串哈希 = `keccak256(abi.encodePacked(s))`(= `keccak256(bytes(utf8(s)))`)。

```solidity
taskKey = keccak256(abi.encode(bytes32("bolloon.task.v1"), taskIdString));
// 过渡兼容(现状合约, L131-133): keccak256(abi.encodePacked(taskIdString))
//   → 两个值都要进 deployment manifest, 否则历史交易对不上

quoteHash = keccak256(abi.encode(bytes32("bolloon.quote.v1"), requestId, payTo, paymentAsset,
                                 chainId, amountAtomic, quoteIssuedAt));
termsHash = keccak256(abi.encode(bytes32("bolloon.terms.v1"), taskKey, quoteHash, paymentAsset,
                                 chainId, amountAtomic, deadline, confirmationWindow));

// 链下内容摘要(既有口径, 双方同源): sha256:<hex> = "sha256:" + sha256Hex(canonicalJson/content)
resultHash = keccak256(bytes(utf8("sha256:<hex of result content>")));
inputHash  = keccak256(bytes(utf8("sha256:<hex of canonical input>")));
manifestHash = keccak256(bytes(utf8("sha256:<hex of canonical manifest>")));
proofHash = keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion));  // 版本绑进哈希

didHash = keccak256(abi.encodePacked(didString));         // 如 "did:diap:xxx"
capabilityRoot = Merkle(capability 字典序排序, leaf_i = keccak256(abi.encode(bytes32("bolloon.cap.v1"), uint256(i), capability_i)));
```

`canonicalize` 口径 = 键递归排序 + 丢 `undefined` + `JSON.stringify`(复用 `src/agents/x402/paid-info-protocol.ts:128-140`), 别另写。

## 5. chainId / token / 确认数 / 版本(冻结)

| 项 | 值 | 状态 |
|---|---|---|
| chainId 取径 | `uint256` EIP-155: `84532` base-sepolia / `8453` base; 本地 `31337`(Hardhat) **永不产出链上结算口径** | 取径冻结, 部署链待定(P2) |
| token | **USDC, decimals = 6** | 冻结(合约的 `require(token.transfer(...))` 依赖"返回 bool"的 USDC) |
| token 地址 base-sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 冻结 |
| token 地址 base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 冻结(未用) |
| 合约地址 | — | **待定**(仓库无 deployment manifest; P2 部署后落 `contracts/evm/deployments/<chainId>.json`) |
| 确认数 | — | **待定**, 建议 `finalized=12 / confirmed=1`; 落地在 P3 `src/agents/chain/chain-config.ts` |
| 合约版本 | 已审计现状 = **v0(无版本字段)**; P2 部署带 v2 事件者 = **v1, `uint32 = 1`** | v0 冻结, v1 数值部署时写死 |

## 6. 写合约时必须先修的 4 条(本次未改)

| # | 修什么 | 证据 |
|---|---|---|
| **F2** | `claimAfterTimeout` 必须要求 `proofHash != bytes32(0)` —— 现在**零证明也能取款** | `AgentEscrow.sol:94-102`(对比 `release` 的 `:84`) |
| **F1** | 补 §2.2 的 11 字段 + 去掉 `string taskId` | `:31`, `:64` |
| **F3** | 补 §3.2 事件(`ReleasedV2.by` / `DisputedV2.reasonHash` / `EscrowCreatedV2` 带 terms+quote) | `:87` vs `:128`, `:42` |
| **F4** | `Treasury.registerAgent/agentReputation` 与 `AgentDirectory` **职责二选一**(冻结: Directory 为对外真相源, Treasury 改读它或退役); 另: `Treasury.allocate` **只 emit 事件不转钱**(`AgentTreasury.sol:84-97`)—— 别把它当转账记录 |

`AgentTreasury` 边界(冻结): `payAgent`(onlyOwner, `:100`)只用于**平台奖励/补贴/组织资金**; 普通任务交易**必须**走 `AgentEscrow`; `AgentPaid` 不含 `taskKey`(**结构性证据**: 走 Treasury 的任务款在链上无法对回任务)。

## F2b (2026-09-22) — permissionless `expire` 逃生路径

**背景**: F2 给 `claimAfterTimeout*` 加了 `proofHash != 0` 门槛后, 出现新锁定风险 —— agent 不交 proof 且 buyer 不 dispute 时资金永久锁死(`refund*` 仅 `onlyOwner` 且仅 `DISPUTED`)。leo 拍板补 permissionless 逃生口。

- **新增**: `expireV2(bytes32 taskKey)` 与 v1 版 `expire(bytes32 taskId)`, 均 **permissionless(任何人可调)**。
- **条件**: `ACTIVE` ∧ `proofHash == 0` ∧ `block.timestamp >= claimableAt(e) + expireGrace`; 效果 = **全额退回 buyer** → 状态 `EXPIRED`。
- **enum**: `EscrowState { ACTIVE, RELEASED, DISPUTED, REFUNDED, EXPIRED }` —— `EXPIRED` **追加在末尾(=4)**, 旧值 0/1/2/3 不变。
- **`expireGrace`**: public 状态变量, 构造时写 `DEFAULT_EXPIRE_GRACE = 7 days`, owner 可用 `setExpireGrace` 调(必须 >0 且 ≤ uint32)。**刻意不做成构造参数** —— 改构造签名会让已部署实例与 manifest 的 `constructorArgs` 失配。
- **事件**: `ExpiredV2(bytes32 indexed taskKey, address indexed caller, address indexed refundedTo, uint256 amount)` + `ExpireGraceUpdated`。
- **与 F2 互补**: 有 proof → `expire` revert `proof exists`(只能走 claim); 未过 grace → `grace not elapsed`; 非 ACTIVE/重复调用 → `not active`; 未知 key → `unknown task`(补的一道防线: mapping 缺省值恰为 `buyer=0,state=ACTIVE,amount=0`, 无此前置检查会让随机 key 在 grace 后"成功"写入幻觉状态)。
- **新增接口**: `expire` `0xc6441798` · `expireV2` `0x02c58a63` · `expireAt` `0x12d89732` · `setExpireGrace` `0x5c9442f1` · `expireGrace()` `0x3a6ff880` · `DEFAULT_EXPIRE_GRACE()` `0x57500bdd` · `ExpiredV2` topic0 `0x517f3d5ae4ce226ad2ddd19ebb76fbf5446cc187b99bdb98e3442e21af73a7d5`。与 21 个既有选择器无冲突。
- **真实输出(我复跑)**: `npx hardhat test` → **56 passing** · `forge test` → **50 passed/0 failed**(3224) · 真链 e2e(`scripts/e2e-expire.js`)4 笔真交易(其中 1 笔故意 status 0), 收尾托管余额 = 0。
