---
title: Bolloon 链上化设计 (AgentEscrow 主路径 + 数据权威划分) — 设计计划 v2
source: raw/paste_2_112614 (leo 2026-09-21 663 行设计稿) + 本仓现状
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: current
status: draft
supersedes: [./network-ledger-design.md]
tags: [chain, escrow, directory, indexer, settlement, design]
---

# Bolloon 链上化设计 v2 — 合约成为资金与状态的事实源

> **编译范围说明(诚实标注)**:本页 §1–§4 已逐条编译自 raw 稿(663 行,`/Users/apple/.hermes/pastes/paste_2_112614.txt`);
> §5–§11 目前只编译到**章节骨架与已知要点**,逐节细节**待补**(raw 稿已登记 manifest,不丢)。
> 本页取代 `network-ledger-design.md`(自建账本 DAG 那一版)——资金与状态的事实源从"节点自建的链"改为**真实 EVM 合约**。

## 0. 这一版改变了什么

上一版:节点自建"签名区块 DAG",账本是事实源。
这一版:**资金与交易状态的事实源是链上合约**;Bollloon 本地记录、facilitator 回执、txHash 存在**都不等于**结算完成。
账本/索引/Pulse/网页都只是**链上事件的派生视图**。

## 1. 重新划分数据权威

### 必须上链(由合约或链上事件确认)

任务交易 ID 的 **hash** · **买方地址** · **Agent 收款地址** · 报价金额 · 币种与网络 · **escrow 创建** · **支付锁定** · 结果证明 hash · **释放 / 退款 / 争议** · **超时领取** · 最终交易状态 · **链上区块号 · 交易哈希 · 日志索引**。

### 只能链下保存

任务正文 · 私人输入文件 · Agent 对话 · 完整结果内容 · 私有 manifest · 私钥 · 内部模型配置 · 私有 P2P 消息。

### 链上只存 6 种 hash

```
taskHash · inputHash · resultHash · contentHash · manifestHash · proofHash
```

需要看正文时,再通过 **CID / 加密存储 / 本地记录**读取,并用**链上 hash 验证内容没被替换**。

## 2. 合约职责(四个合约,职责不许混)

### 2.1 `AgentEscrow` —— 任务交易**主合约**

```
createEscrow → submitProof → release / claimAfterTimeout → dispute → refund / releaseAfterArbitration
```

需要补充/确认的字段:`taskHash` · `quoteHash` · `inputHash` · `resultHash` · `manifestHash` · `chainId` · `contractVersion` · `createdBlock` · `deadline` · `confirmationWindow` · `paymentAsset` · `proofVersion`。

**不要依赖链上完整 `string taskId` 作为唯一依据** —— 改用:

```solidity
bytes32 taskKey;      // 任务标识(哈希)
bytes32 termsHash;    // 条款(报价/币种/网络/期限)整体哈希
bytes32 resultHash;   // 结果证明
```

原始任务 ID 只留本地或加密链下存储。

### 2.2 `AgentTreasury` —— 资金池,**不是**普通双边交易主路径

适合:平台资金池 · 计算资源补贴 · Agent 奖励 · 信誉门槛支付 · 日预算 · 协议资金分配。
但它的 `payAgent` 目前是 **`onlyOwner`**,不适合完全开放的 A2A 交易。因此必须明确:

- **普通任务交易走 `AgentEscrow`**;
- 平台奖励/组织资金走 `AgentTreasury`;
- **不要让 `trade.ts` 把所有交易都误用成 `Treasury.payAgent`**。

### 2.3 `AgentDirectory` —— 链上 Agent 注册承诺(建议新增)

```
registerAgent · updateManifest · publishCapability · revokeAgent
```

链上只记:`didHash` · `payoutAddress` · `manifestHash` · `capabilityRoot` · `version` · `active`。完整 manifest 仍在 P2P/OrbitDB/IPFS。

外部 Agent 由此可验证:是否注册 · 收款地址是否绑定 · manifest 是否更新 · capability 是否变化 · 地址是否已撤销。

### 2.4 `AgentTradeLedger` —— 可选的公共交易日志合约

```solidity
recordTask(taskKey, termsHash)      recordQuote(taskKey, quoteHash)
recordResult(taskKey, resultHash)   recordVerification(taskKey, proofHash)
recordDispute(taskKey, reasonHash)
```

**不持有资金**,只记录公开可验证的生命周期。资金由 `AgentEscrow` 管、公共状态由它记。
若不想增加合约数量,可把事件并入 `AgentEscrow`,但必须保证:**每个状态转换都有事件** · **事件含 taskKey 与 hash** · **网页能只靠事件重建交易时间线**。

## 3. 真正上链的硬规则(不可绕过)

```
没有交易哈希      → 不能标记 chain settlement
没有正确合约事件  → 不能标记 escrow created / released
没有足够确认数    → 不能标记 finalized
没有 proofHash / resultHash → 不能标记 verified
local-dev        → 永远不能标记 fully_settled
```

四个"不等于":

```
本地 JSON 记录        ≠ 链上交易
facilitator 返回成功  ≠ 链上最终确认
txHash 存在           ≠ 合约状态已经正确
receipt 存在          ≠ 资金已经完成结算
```

**必须通过 RPC 重新读取**六项:交易 receipt · 合约事件 · **区块确认数** · 合约存储状态 · token 转账日志 · escrow 当前状态。
**只有全部匹配**,才允许把本地投影更新为 `chainSettled = true` 与 `settlementFact = payment_verified / fully_settled`。

## 4. 与合约的连接层(建议新增 `src/agents/chain/`)

```
chain-config.ts · contract-registry.ts · escrow-client.ts · directory-client.ts
ledger-client.ts · chain-indexer.ts · settlement-verifier.ts · reorg-reconciler.ts
```

| 模块 | 职责 |
|---|---|
| `chain-config` | chain ID · RPC URL · token 地址 · Escrow/Treasury/Directory/Ledger 地址 · 合约版本 · **确认区块数** |
| `contract-registry` | 启动时验证:地址格式 · chain ID · **bytecode 是否存在** · 合约版本 · ABI 兼容 · token decimals · 是否 frozen |
| `escrow-client` | 真实调用 8 个方法(`createEscrow`/`submitProof`/`release`/`claimAfterTimeout`/`dispute`/`refund`/`releaseAfterArbitration`);**每次调用八步**:① 生成 requestId ② 绑定 taskKey ③ 发交易 ④ 等 receipt ⑤ 读事件 ⑥ **读合约状态** ⑦ 写交易投影 ⑧ 返回可验证证据 |
| `settlement-verifier` | 九项匹配:交易成功 · 方法正确 · 合约地址正确 · token 地址正确 · 金额正确 · buyer/agent 匹配 · **taskKey 匹配** · **proofHash 匹配** · 当前状态匹配 |
| `chain-indexer` | 从**链上日志**同步(不依赖本地发起返回):`EscrowCreated`/`ProofSubmitted`/`Released`/`Refunded`/`Disputed`/`ClaimedAfterTimeout`/`AgentRegistered`/`AgentPaid`;支持从部署区块扫描 · **block 游标续扫** · 缺失回补 · 重复日志去重 · **处理链重组(reorg)** · 按 `txHash/blockHash/logIndex` 去重 |

## 5. 交易状态改造

**`transaction-store` 不能继续作为事实来源。** 新关系:

```
Blockchain Contract Events  →  (reducer/verifier)  →  本地交易投影(可重建)  →  CLI / MCP / 网页
```

> 逐节细节待补(raw 稿 §5 起,行 315+)。

## 6. 其余章节(骨架,逐节细节待补)

| 节 | 主题 | raw 行 |
|---|---|---|
| 五 | 交易状态改造 | 315+ |
| 六 | **Agent 自主支付** | 366+ |
| 七 | **Skill / CLI / MCP**(11 步上链流程:取 genesis → 取 chainId/合约地址 → **验证合约 bytecode** → 取 Directory → 建 taskHash → 建 escrow → **等链上确认** → 执行 → 提交 result/proof hash → 读最终合约状态 → 查交易事件) | 394+ |
| 八 | **网页真正读链上记录**(公共 Explorer 视图 + 私有任务视图) | 456+ |
| 九 | **Network Pulse 的链上化** | 509+ |
| 十 | 合约安全与治理(v1 / v2) | 532+ |
| 十一 | 实施阶段:**Phase 1 合约审计与链上模型冻结** → **Phase 2 部署清单与真实网络** → **Phase 3 Bolloon 链桥** → **Phase 4 任务交易闭环** → **Phase 5 链上索引器**(+ 后续) | 560+ |

## 7. 与本仓现状的关系

| 现有件 | 处置 |
|---|---|
| `x402/transaction-store.ts`(本地交易 JSON) | **降级为投影**,不再是事实来源;由链上事件重放 |
| `x402/settlement-state.ts`(8 态事实 + 红线) | **保留语义**,`chainSettled`/`fully_settled` 必须由 §3 的 RPC 六项重读 + 合约状态匹配换取 |
| `x402/trade.ts` 里的付款路径 | **核查是否误用 `Treasury.payAgent`**;普通任务必须走 `AgentEscrow` |
| 已部署的 `AgentEscrow` / `AgentTreasury`(仓库已有合约) | 按 §2 补字段(taskKey/termsHash/resultHash、deadline、confirmationWindow、proofVersion…) |
| `src/agents/chain/*` | **新增**(§4 八个模块) |
| Pulse / UI(已上线) | 改为**链上事件的派生视图**;`observed/confirmed/finalized` 与链上确认数对齐 |

## 8. 诚实边界

1. **链上 ≠ 任务结果正确**:链只证明"任务 key/条款 hash/结果 hash 被登记与释放",结果内容对不对仍要 hash + 交付验证。
2. **正文永不上链**:只上 6 种 hash;正文走 CID/加密/本地,靠 hash 校验未被替换。
3. **确认数不足就是没 finalized**:不许用"我这边看到成功"顶替。
4. **`local-dev` 永不上链上口径**(旧红线继续生效)。
5. **本页是设计稿,尚未实现**;§5–§11 细节待逐节编译。
