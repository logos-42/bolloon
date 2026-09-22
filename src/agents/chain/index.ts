/**
 * src/agents/chain/index.ts — 链桥模块出口 (P3: Bolloon 链桥 / P5: 链上索引器)
 *
 * 七件事的入口:
 *   · chain-config        — 链配置 / 确认数门槛 / 钱包路径 (env → 本地安全配置 → 报错)
 *   · escrow-client       — AgentEscrow v2 真链读写 + 5 个 v2 事件监听 (ethers v6)
 *   · chain-settlement    — 「到底结算了没有」的唯一判定 (修 F5)
 *   · chain-wallet        — 链上签名的唯一放行闸 + 签名审计
 *   · chain-state-store   — 落盘 / 重启恢复 / 重组对账
 *   · chain-indexer       — P5: v2 事件索引器 (分页扫 / 增量 / 去重 / 重组回退 / 全量重建)
 *   · chain-index-query   — P5: 只读查询 (时间线 / cursor 增量 / 统计 / 索引高度)
 */

export * from './chain-config.js';
export * from './escrow-client.js';
export * from './chain-settlement.js';
export * from './chain-wallet.js';
export * from './chain-state-store.js';
export * from './onchain-trade.js';
export * from './chain-indexer.js';
export * from './chain-index-query.js';
