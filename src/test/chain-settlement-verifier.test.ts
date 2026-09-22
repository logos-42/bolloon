/**
 * chain-settlement-verifier.test.ts — 链上结算判定的单测 (P3, 修 F5)
 *
 * 覆盖 (题干点名要的):
 *   · 确认数门: 不够 → 不是 verified
 *   · receipt 失败 (status==0) → 不是 verified
 *   · 事件不匹配 (taskKey/resultHash 对不上) → 不是 verified
 *   · 重组 (同一 txHash 换了块 / 链上查不到) → 不是 verified, 标 reorged
 *   · RPC 不可用 → 如实报 unknown, 绝不冒报已结算
 *   · 拿到 txHash 但确认数够 + 事件对得上 → 才 chainSettled: true
 */
import { describe, it, expect } from 'vitest';
import {
  verifyChainSettlement, createChainSettlementVerifier, createDefaultChainSettlementVerifier,
} from '../agents/chain/chain-settlement.js';
import { DEFAULT_CONFIRMATIONS } from '../agents/chain/chain-config.js';
import {
  clientWith, fakeProvider, receipt, releasedV2Log, escrowTuple, escrowCreatedV2Log,
  TASK_KEY, OTHER_TASK_KEY, RESULT_HASH, ESCROW_ADDR,
} from './chain-test-helpers.js';

const GATE = { confirmations: { confirmed: 1, finalized: 12 } };

describe('verifyChainSettlement — 确认数门', () => {
  it('确认数 > 门槛 + 事件对得上 → chainSettled=true, status=confirmed', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 98,
      escrow: escrowTuple({ state: 1 }), // RELEASED
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'escrow', taskKey: TASK_KEY, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' },
      ...GATE,
    });
    expect(v.chainSettled).toBe(true);
    expect(v.status).toBe('confirmed');
    expect(v.confirmations).toBe(1);
    expect(v.eventMatched).toBe(true);
    expect(v.matchedEvent).toBe('ReleasedV2');
    expect(v.escrowState).toBe('RELEASED');
  });

  it('确认数不够 (最新块 == 交易块, 门槛 5) → pending, chainSettled=false', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 98,
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'escrow', taskKey: TASK_KEY },
      confirmations: { confirmed: 5, finalized: 12 },
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('pending');
    expect(v.confirmations).toBe(1);
    expect(v.confirmationsRequired).toBe(5);
    expect(v.reason).toContain('确认数 1 < 门槛 5');
  });

  it('确认数 = 门槛边界 → 刚好放行', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 96, logs: [releasedV2Log(TASK_KEY)] }), latestBlock: 100 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY },
      confirmations: { confirmed: 5, finalized: 12 },
    });
    expect(v.confirmations).toBe(5);
    expect(v.chainSettled).toBe(true);
  });

  it('确认数 ≥ finalized → status=finalized', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 80, logs: [releasedV2Log(TASK_KEY)] }), latestBlock: 100 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.status).toBe('finalized');
    expect(v.chainSettled).toBe(true);
  });
});

describe('verifyChainSettlement — receipt 失败 / 拿不到', () => {
  it('receipt.status == 0 → reverted, chainSettled=false (钱没动)', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 0, blockNumber: 98, logs: [] }), latestBlock: 120 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('reverted');
    expect(v.reason).toContain('回滚');
  });

  it('receipt 为 null 且以前没认过 → unknown, chainSettled=false', async () => {
    const p = fakeProvider({ receipt: null, latestBlock: 120 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('unknown');
    expect(v.reason).toContain('没被打包');
  });

  it('没有 txHash → not_attempted, chainSettled=false (从不宣称")', async () => {
    const p = fakeProvider({});
    const v = await verifyChainSettlement(clientWith(p), { txHash: '', expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('not_attempted');
  });
});

describe('verifyChainSettlement — 事件匹配', () => {
  it('taskKey 对不上 → event_mismatch, 即便确认数很够也不许判已结算', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 50, logs: [releasedV2Log(OTHER_TASK_KEY)] }),
      latestBlock: 200,
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
    expect(v.eventMatched).toBe(false);
    expect(v.reason).toContain('不是我们要的那笔');
  });

  it('resultHash 对不上 → event_mismatch (更严的核对)', async () => {
    const ev = releasedV2Log(TASK_KEY);
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 50, logs: [ev] }), latestBlock: 200 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'escrow', taskKey: TASK_KEY, resultHash: RESULT_HASH },
      ...GATE,
    });
    // ReleasedV2 不带 resultHash 字段 → 匹配不上 (要求核对就必须核对到)
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
  });

  it('escrow 状态不符 (期望 RELEASED, 实际 ACTIVE) → event_mismatch', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 50, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
      escrow: escrowTuple({ state: 0 }), // ACTIVE
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'escrow', taskKey: TASK_KEY, expectEscrowState: 'RELEASED' },
      ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
    expect(v.escrowState).toBe('ACTIVE');
  });

  it('事件对得上 + 合约状态读不到 → 仍可判已结算, 但如实标注 escrowState=null', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 50, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
    });
    // 让 escrows() 读不到
    (p as any).call = async () => { throw new Error('call failed'); };
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(true);
    expect(v.escrowState).toBeNull();
    expect((v.evidence as any).escrowReadError).toBeTruthy();
  });

  it('别的合约发出的日志不算数 (只看 escrow 合约)', async () => {
    const foreign = { ...releasedV2Log(TASK_KEY), address: '0x' + '99'.repeat(20) };
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 50, logs: [foreign] }), latestBlock: 200 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
  });
});

describe('verifyChainSettlement — 重组', () => {
  it('同一 txHash 换了块号 → reorged, chainSettled=false', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 105, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
      recorded: { blockNumber: 98, confirmations: 3, status: 'confirmed' },
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('reorged');
    expect(v.reason).toContain('重组');
  });

  it('以前认过 (有块号), 现在链上查不到 → reorged (不是"没上链", 也不是已结算)', async () => {
    const p = fakeProvider({ receipt: null, latestBlock: 200 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
      recorded: { blockNumber: 98, confirmations: 5, status: 'confirmed' },
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('reorged');
    expect(v.reason).toContain('重组');
  });

  it('块号没变 → 不算重组 (正常复跑不会误报)', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
      recorded: { blockNumber: 98, confirmations: 5, status: 'confirmed' },
    });
    expect(v.status).toBe('finalized');
    expect(v.chainSettled).toBe(true);
  });
});

describe('verifyChainSettlement — RPC 不可用', () => {
  it('读 receipt 抛错 → unknown + rpcAvailable=false, 绝不冒报已结算', async () => {
    const p = fakeProvider({ receiptThrows: 'ECONNREFUSED 127.0.0.1:8545' });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('unknown');
    expect(v.rpcAvailable).toBe(false);
    expect(v.reason).toContain('付款状态未知');
  });

  it('读最新块高抛错 → unknown (数不了确认数就不许说结算)', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 50, logs: [releasedV2Log(TASK_KEY)] }), blockThrows: 'timeout' });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('unknown');
    expect(v.rpcAvailable).toBe(false);
  });

  it('默认验证器在链配置取不到时 → config_unavailable 且 chainSettled=false (不抛错)', async () => {
    const verifier = createDefaultChainSettlementVerifier({
      home: '/nonexistent-home-for-test',
      env: {} as any,
    });
    const v = await verifier({ txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY } });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('config_unavailable');
    expect(v.reason).toContain('无法做真链验证');
  });

  it('createChainSettlementVerifier 透传 gate', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }), latestBlock: 98 });
    const verifier = createChainSettlementVerifier(clientWith(p), { gate: 'finalized' });
    const v = await verifier({ txHash: '0x' + 'de'.repeat(32), expect: { kind: 'escrow', taskKey: TASK_KEY } });
    expect(v.chainSettled).toBe(false);
    expect(v.requiredGate).toBe('finalized');
    expect(v.confirmationsRequired).toBe(DEFAULT_CONFIRMATIONS.finalized);
  });
});

describe('判定器不会假装 — escrow 未创建的 tx', () => {
  it('EscrowCreatedV2 事件存在但要求 ReleasedV2 → event_mismatch', async () => {
    const p = fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 50, logs: [escrowCreatedV2Log(TASK_KEY)] }),
      latestBlock: 200,
    });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'escrow', taskKey: TASK_KEY, eventName: 'ReleasedV2' },
      ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
    expect((v.evidence as any).decodedEvents).toEqual(['EscrowCreatedV2']);
  });

  it('erc20_transfer 模式: 缺 tokenAddress → unknown (核不了就不判)', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 50, logs: [] }), latestBlock: 200 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32), expect: { kind: 'erc20_transfer' }, ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('unknown');
    expect(v.reason).toContain('没给 tokenAddress');
  });

  it('erc20_transfer 模式: 没有匹配 Transfer → event_mismatch', async () => {
    const p = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 50, logs: [] }), latestBlock: 200 });
    const v = await verifyChainSettlement(clientWith(p), {
      txHash: '0x' + 'de'.repeat(32),
      expect: { kind: 'erc20_transfer', tokenAddress: ESCROW_ADDR, to: '0x' + '11'.repeat(20), minAmount: 1n },
      ...GATE,
    });
    expect(v.chainSettled).toBe(false);
    expect(v.status).toBe('event_mismatch');
  });
});
