---
title: Agent Economic Protocol 设计 (智能体经济网络)
source: session + 用户设想 + bolloon 现有能力梳理
created: 2026-08-13
last_confirmed: 2026-08-13
schema_version: 2
audience: self
stage: current
status: current
confidence: medium
entity_type: protocol
tags: [agent-economy, x402, registry, policy-engine, treasury, reputation, escaprow, agent-gdp, protocol]
---

# Agent Economic Protocol 设计 (智能体经济网络)

> 梦想: 自动化交流的智能体形成智能合约网络, 互相转钱支付, 为每个人提供收入。
> 核心转变: 交易主体从"人/公司"变成"Agent + Wallet + Contract"。
> 参考: arXiv:2507.19550 (Multi-Agent Economies, A2A+x402+ledger) / arXiv:2605.30998 (x402 free-riding) / arXiv:2607.12575 (x402 真实性测量)。

## 一、总体架构

```text
HUMAN → Personal Agent → Agent Network (A↔B↔C) → Payment Layer (x402) → Smart Contract (Treasury/Escrow) → Real Economy
```

关键原则:
- **支付不创造收入** — 必须有外部价值入口 (Human/Company → $ → Agent), 网络内循环才有乘数效应。
- **交易量 ≠ 经济规模** — 区分 self/internal/A2A/human-funded/external revenue; 核心指标是 External Value Inflow。
- **LLM 不直接掌握私钥** — Payment Intent → Policy Engine → Signer → Chain。

## 二、7 协议 (Agent Economic Loop)

```text
IDENTITY → DISCOVERY → NEGOTIATION → EXECUTION → PROOF → PAYMENT → REPUTATION → MORE WORK ↺
```

| # | 协议 | 问题 | bolloon 现有 | 缺口 |
|---|------|------|------------|------|
| 1 | Identity | Who are you? | DIAP (DID+ownerDid) ✅ | — |
| 2 | Discovery | What can you do? | agent_call/A2A/P2P ✅ | Agent 服务注册/定价/发现 (Registry) |
| 3 | Negotiation | What will you do? How much? | — | ❌ 报价/接受/拒绝 (x402 价格协商) |
| 4 | Execution | Did you actually do it? | Agent Loop ✅ | 服务执行 (带结果 CID) |
| 5 | Proof | 执行证明 | IPFS CID 🟡 | 结果 CID + 完成签名 |
| 6 | Payment | Who gets paid? | x402 (fetch/pay/request) ✅ | 支付闭环 (402→支付→服务→结算) |
| 7 | Reputation | Should I trust you? | judgment 系统 🟡 | Agent 信誉分 (成功率/争议/失败) |
| 8 | Governance | Who controls? | — | Treasury/Escrow (后续) |

## 三、bolloon 组件映射

| 层 | bolloon 已有 |
|----|------------|
| Agent Identity | DIAP (@diap/sdk, DID, ownerDid) |
| Wallet | wallet_create/import/get_balance/send_tx/transferToken/autoPay |
| Payment | x402 (x402_pay / x402_fetch / x402_request_payment) |
| Agent Comm | agent_call / send_to_peer / P2P |
| Storage | IPFS/IPNS + OrbitDB (WAL 复制) |
| Reputation 基础 | judgment 系统 (判断力/决策/价值点) |
| Runtime | pi-sdk Agent Loop + Android Agent Runtime |
| UI | A2UI / mobile / web |

## 四、MVP 设计 (Phase 1: Agent-to-Agent 服务市场)

不写复杂合约, 先做真实经济活动:

### E1: Agent 服务 Registry

每个 Agent 声明服务:

```json
{
  "agent_id": "did:diap:xxx",
  "wallet": "0xabc...",
  "service": {
    "name": "research",
    "description": "研究/资料检索",
    "price": { "amount": "0.05", "currency": "USDC", "per": "query" },
    "endpoint": "agent://research/query"
  },
  "capabilities": ["research", "data", "compute"],
  "reputation": { "tasks": 0, "success": 0, "score": 0 }
}
```

存: OrbitDB keyvalue `bolloon-agent-registry` (跨设备同步)。

### E2: x402 支付闭环

```text
Agent A (buyer)
  → POST /agent/service/call (x402 Request)
  ← 402 Payment Required (price + wallet)
  → x402_pay (Agent A wallet 签名付款)
  → 200 service result
```

bolloon 已具备 x402 工具, 需要: 服务端 (provider) 暴露 x402 受保护的服务端点 + 调用方 (buyer) 自动化付款。

### E3: Policy Engine (安全核心)

```text
LLM
 ↓ Payment Intent
 ↓ Policy Engine
 ├── amount < per_transaction_limit?
 ├── recipient in allowed?
 ├── service in allowed?
 ├── reputation >= threshold?
 └── daily budget not exceeded?
     ↓
  Signer (钱包私钥, LLM 不可见)
     ↓
  Chain
```

落地: `src/agents/economic-policy.ts` — 预算 (daily/per-tx) + 授权白名单 + 签名隔离 (x402 支付走 policy, 不暴露私钥给 LLM)。

### E4: Reputation (MVP 简化)

每次结算后更新: tasks++, success/failed/disputed。reputation = success/tasks。

## 五、安全设计 (参考 arXiv:2605.30998)

- Free-riding 防护: 支付上下文绑定 (请求 ID + 金额 + 服务 + 时间戳), 防重放。
- 私钥隔离: LLM 只见 Payment Intent, 不见私钥; Policy Engine 是唯一签名入口。
- 预算冻结: daily_spending > limit → freeze (判断力负向回收模式可复用)。

## 六、指标 (Agent GDP)

```text
Agent GDP = Σ verified service value (外部资金 + 网络内增值)
Network Velocity = Agent GDP / Treasury Capital
```

不统计 TPS/交易量 (防假量)。

## 七、里程碑

| 阶段 | 内容 | 状态 |
|------|------|------|
| M0 | 本设计文档 | ✅ db4e753 |
| M1 | Agent 服务 Registry (E1): OrbitDB+本地, registry_register/registry_discover, /api/registry | ✅ dcf8abd |
| M2 | x402 支付闭环 (E2): service_call + 402 响应生成 (Registry 价格驱动) | ✅ 1de3bb3 |
| M3 | Policy Engine (E3): 预算/白名单/速率/签名隔离 + policy_config 工具 | ✅ 7f7f6f5 |
| M4 | Reputation 整合 (E4): 结算后更新信誉 (success/failed/disputed → score) + 工具 | ✅ 8e085af |
| M4v | 支付闭环全链路验证脚本 (17/17: registry/service_call/policy/402/reputation/持久化) | ✅ 3cdf93d |
| M5 | Treasury/Escrow 合约 | 后续 |

## 关联

- 代码: src/agents/pi-sdk-tools.ts (wallet/x402) / src/network/ (A2A) / src/orbitdb/ (存储)
- 参考: arXiv:2507.19550 / 2605.30998 / 2607.12575 / OpenAI Agents SDK handoffs
