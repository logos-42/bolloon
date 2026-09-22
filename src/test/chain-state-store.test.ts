/**
 * chain-state-store.test.ts — 落盘 / 重启恢复 / 重组对账 (P3, ④)
 *
 * 覆盖:
 *   · 关键状态 (escrow 地址/txHash/taskKey/确认数/最后检查块) 落盘且能读回
 *   · 进程重启后能从持久记录重建「已确认/待确认/被重组/未知」
 *   · 重组 (换了块 / 链上查不到 / 事件消失) → 检出 + 标不可信, **不静默当已结算**
 *   · 标记不可信后 recoverChainState 不再把它的 settled 里
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  upsertChainTx, loadChainState, recoverChainState, reconcileChainState,
  markSuspect, getChainTxRecord, findByTxHash, chainStatePath, recordVerdict, emptyChainState,
  reconciledSettledIds,
} from '../agents/chain/chain-state-store.js';
import type { ChainSettlementVerdict } from '../agents/chain/chain-settlement.js';
import { clientWith, fakeProvider, receipt, releasedV2Log, escrowTuple, TASK_KEY, OTHER_TASK_KEY } from './chain-test-helpers.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chainstate-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const TXH = '0x' + 'de'.repeat(32);
const RID = 'chaintx-releaseV2-aaaa';

const seed = (over: any = {}) => upsertChainTx({
  requestId: RID, method: 'releaseV2', taskKey: TASK_KEY, escrowAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  chainId: 31337, txHash: TXH, confirmations: 3, lastCheckedBlock: 100, blockNumber: 98,
  status: 'confirmed', reason: 'seed', eventMatched: true, matchedEvent: 'ReleasedV2',
  ...over,
}, HOME);

const verdict = (over: Partial<ChainSettlementVerdict>): ChainSettlementVerdict => ({
  chainSettled: false, status: 'unknown', reason: 'x', confirmationsRequired: 1, requiredGate: 'confirmed',
  rpcAvailable: true, checkedAt: Date.now(), evidence: {}, ...over,
});

describe('落盘 / 读回', () => {
  it('关键状态必须落盘 (escrow 地址/txHash/taskKey/确认数/最后检查块)', async () => {
    await seed();
    const rec = getChainTxRecord(RID, HOME);
    expect(rec).not.toBeNull();
    expect(rec!.escrowAddress).toBe('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
    expect(rec!.txHash).toBe(TXH);
    expect(rec!.taskKey).toBe(TASK_KEY);
    expect(rec!.confirmations).toBe(3);
    expect(rec!.lastCheckedBlock).toBe(100);
    // 真写到盘上了
    expect(fs.existsSync(chainStatePath(HOME))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(chainStatePath(HOME), 'utf8'));
    expect(onDisk.records[RID].txHash).toBe(TXH);
    expect(onDisk.escrowAddresses).toContain('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
  });

  it('upsert 追加 history (可回放), 不丢旧状态', async () => {
    await seed();
    await upsertChainTx({
      requestId: RID, method: 'releaseV2', taskKey: TASK_KEY, escrowAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      chainId: 31337, txHash: TXH, confirmations: 12, lastCheckedBlock: 110, blockNumber: 98,
      status: 'finalized', reason: 'more confs',
    }, HOME);
    const rec = getChainTxRecord(RID, HOME)!;
    expect(rec.status).toBe('finalized');
    expect(rec.confirmations).toBe(12);
    expect(rec.history.length).toBeGreaterThanOrEqual(2);
    expect(rec.history[0].status).toBe('confirmed');
  });

  it('坏文件 / 没文件 → 空状态 (不猜)', () => {
    fs.mkdirSync(path.dirname(chainStatePath(HOME)), { recursive: true });
    fs.writeFileSync(chainStatePath(HOME), '{not json', 'utf8');
    const s = loadChainState(HOME);
    expect(s.schemaVersion).toBe(emptyChainState().schemaVersion);
    expect(s.records).toEqual({});
    expect(s.escrowAddresses).toEqual([]);
  });

  it('findByTxHash 大小写不敏感', async () => {
    await seed();
    expect(findByTxHash(TXH.toUpperCase().replace('0X', '0x'), HOME)?.requestId).toBe(RID);
  });
});

describe('重启恢复 (只读盘, 不联网)', () => {
  it('从持久记录重建 已确认/待确认/被重组/未知', async () => {
    await seed({ requestId: 'r-conf', status: 'confirmed', confirmations: 4, blockNumber: 90, eventMatched: true });
    await seed({ requestId: 'r-final', status: 'finalized', confirmations: 20, blockNumber: 70, eventMatched: true });
    await seed({ requestId: 'r-pend', status: 'pending', confirmations: 0, blockNumber: 100, eventMatched: true });
    await seed({ requestId: 'r-reorg', status: 'reorged', suspect: true, eventMatched: true });
    await seed({ requestId: 'r-unknown', status: 'unknown', confirmations: 0, eventMatched: null });
    await seed({ requestId: 'r-rev', status: 'reverted', eventMatched: false });

    const r = recoverChainState(HOME);
    expect(r.total).toBe(6);
    expect(r.settled.map((x) => x.requestId).sort()).toEqual(['r-conf', 'r-final']);
    expect(r.pending.map((x) => x.requestId)).toEqual(['r-pend']);
    expect(r.reorged.map((x) => x.requestId)).toEqual(['r-reorg']);
    expect(r.unknown.map((x) => x.requestId)).toEqual(['r-unknown']);
    expect(r.reverted.map((x) => x.requestId)).toEqual(['r-rev']);
    expect(r.lastCheckedBlock).toBe(100);
    expect(r.escrowAddresses.length).toBe(1);
  });

  it('★ 被标不可信的记录绝不算 settled (哪怕状态写着 confirmed)', async () => {
    await seed({ requestId: 'r-suspect', status: 'confirmed', confirmations: 9, eventMatched: true, suspect: true, suspectReason: '重组' });
    const r = recoverChainState(HOME);
    expect(r.settled).toEqual([]);
    expect(r.suspect.map((x) => x.requestId)).toEqual(['r-suspect']);
  });

  it('recordVerdict: reorged 判定 → 自动 suspect, 且 history 记下原因', async () => {
    const rec = await recordVerdict(
      { requestId: RID, method: 'releaseV2', taskKey: TASK_KEY, escrowAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', chainId: 31337, txHash: TXH },
      verdict({ status: 'reorged', chainSettled: false, reason: '重组: 换了块', blockNumber: 105, confirmations: 2, latestBlock: 106 }),
      HOME,
    );
    expect(rec.suspect).toBe(true);
    expect(rec.suspectReason).toContain('重组');
    expect(rec.lastCheckedBlock).toBe(106);
  });
});

describe('重组对账', () => {
  it('★ 同一 txHash 换了块 → reorged + suspect, 不再 settled', async () => {
    await seed({ blockNumber: 98, confirmations: 3, eventMatched: true });
    // 链上现在说这笔在块 105
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 105, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
    }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.reorged.length).toBe(1);
    expect(rep.newlySuspect).toEqual([RID]);
    const rec = getChainTxRecord(RID, HOME)!;
    expect(rec.status).toBe('reorged');
    expect(rec.suspect).toBe(true);
    expect(recoverChainState(HOME).settled).toEqual([]);
  });

  it('★ 链上查不到 (曾记在块 98) → reorged, 不当已结算', async () => {
    await seed({ blockNumber: 98, eventMatched: true });
    const client = clientWith(fakeProvider({ receipt: null, latestBlock: 200 }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.reorged.length).toBe(1);
    expect(getChainTxRecord(RID, HOME)!.suspect).toBe(true);
  });

  it('★ 之前核上的事件在链上消失 → reorged + suspect', async () => {
    await seed({ blockNumber: 98, eventMatched: true, matchedEvent: 'ReleasedV2' });
    // 同一个块, 但日志里没有 ReleasedV2 了
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [] }),
      latestBlock: 200,
    }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.reorged.length).toBe(1);
    const rec = getChainTxRecord(RID, HOME)!;
    expect(rec.suspect).toBe(true);
    expect(rec.suspectReason).toContain('事件');
  });

  it('RPC 不可用 → 进 unknown 且 rpcErrors 计数, 绝不变成 confirmed', async () => {
    await seed({ blockNumber: 98, eventMatched: true });
    const client = clientWith(fakeProvider({ receiptThrows: 'ECONNREFUSED' }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.rpcErrors).toBe(1);
    expect(rep.unknown.length).toBe(1);
    expect(rep.confirmed.length).toBe(0);
    expect(getChainTxRecord(RID, HOME)!.status).toBe('unknown');
  });

  it('确认数不够 → pending (不是 confirmed)', async () => {
    await seed({ blockNumber: 100, eventMatched: true });
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 100, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 100,
      escrow: escrowTuple({ state: 1 }),
    }));
    const rep = await reconcileChainState(client, { home: HOME, gate: 'finalized' });
    expect(rep.pending.length).toBe(1);
    expect(rep.pending[0].required).toBe(12);
  });

  it('一切正常 → confirmed, 不误报重组', async () => {
    await seed({ blockNumber: 98, eventMatched: true });
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
      escrow: escrowTuple({ state: 1 }),
    }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.confirmed.length).toBe(1);
    expect(rep.newlySuspect).toEqual([]);
    expect(getChainTxRecord(RID, HOME)!.status).toBe('finalized');
  });

  it('已 finalized 且不可疑 → 默认跳过 (省 RPC)', async () => {
    await seed({ status: 'finalized', blockNumber: 50, confirmations: 100, eventMatched: true });
    const client = clientWith(fakeProvider({ receiptThrows: 'should not be called' }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.scanned).toBe(0);
    expect(rep.rpcErrors).toBe(0);
    // 显式要求不跳过 → 会去查
    const rep2 = await reconcileChainState(client, { home: HOME, skipFinalized: false });
    expect(rep2.scanned).toBe(1);
  });

  it('markSuspect 显式标不可信 (绝不静默)', async () => {
    await seed();
    const r = await markSuspect(RID, '人工复核: 块被回滚', HOME);
    expect(r!.suspect).toBe(true);
    expect(recoverChainState(HOME).settled).toEqual([]);
    expect(await markSuspect('nope', 'x', HOME)).toBeNull();
  });
});

/**
 * 忙链 / 深确认 / 已 finalized 的对账。
 * 这一组对应 2026-09-22 的假失败: 共享 anvil 上别的进程也在出块 → 记录的确认数自己涨过
 * finalized 门槛 → 落盘时就是 `finalized` → `skipFinalized` 默认跳过它 → 报告里 `confirmed=0`
 * → 调用方 (验收/账单) 把「已最终确定」误读成「这条没对账/没结算」。
 * 修法: 跳过的记录**必须显式出现在报告里** (skippedFinalized), 且用 reconciledSettledIds
 * 才能正确回答「对账后它还算已结算吗」。
 */
describe('忙链 / 深确认 / 已 finalized 的对账 (「跳过」不许被当成「没结算」)', () => {
  it('★ 记录时只 1 个确认, 对账时链上已出到 ≥12 确认 (忙链上别人也在出块) → 本轮重算成 finalized', async () => {
    await seed({ status: 'confirmed', confirmations: 1, blockNumber: 98, eventMatched: true });
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 120, // 忙链: 别人把这些块出了 → 98 号块现在有 23 个确认
      escrow: escrowTuple({ state: 1 }),
    }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.scanned).toBe(1);
    expect(rep.skippedFinalized).toEqual([]);
    expect(rep.confirmed.map((r) => r.requestId)).toEqual([RID]);
    expect(rep.confirmed[0].confirmations).toBe(23);
    expect(rep.confirmed[0].status).toBe('finalized'); // 23 >= 12 → 深确认
    expect(reconciledSettledIds(rep)).toEqual([RID]);
    expect(getChainTxRecord(RID, HOME)!.status).toBe('finalized');
  });

  it('★ 落盘时就已经 finalized (深确认) → 默认跳过重算, 但必须**显式**出现在 skippedFinalized, 且仍算已结算', async () => {
    await seed({ status: 'finalized', confirmations: 16, blockNumber: 50, eventMatched: true });
    const client = clientWith(fakeProvider({ receiptThrows: 'should not be called: 已 final 的不该再花 RPC' }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.scanned).toBe(0);
    expect(rep.rpcErrors).toBe(0);
    expect(rep.confirmed).toEqual([]); // 没重算 → 不在 confirmed (旧代码到此就"什么都不说"了)
    // ★ 但绝不静默消失: 它必须被显式列出来
    expect(rep.skippedFinalized.map((r) => r.requestId)).toEqual([RID]);
    expect(rep.skippedFinalized[0].status).toBe('finalized');
    expect(rep.skippedFinalized[0].confirmations).toBe(16);
    expect(rep.skippedFinalized[0].reason).toContain('跳过');
    // ★ 合起来看: 它对账后仍然是已结算的
    expect(reconciledSettledIds(rep)).toEqual([RID]);
    // 报告自洽: 范围内每条记录都被交代过 (要么重算, 要么显式跳过)
    expect(rep.considered).toBe(rep.scanned + rep.skippedFinalized.length);
  });

  it('★ (回归) 只看 confirmed 会把已 final 的当成"没对账" —— 忙链上 A 已 final + B 被回滚的真实形态', async () => {
    await seed({ requestId: 'r-a', status: 'finalized', confirmations: 16, blockNumber: 50, eventMatched: true });
    await seed({ requestId: 'r-b', status: 'reorged', suspect: true, blockNumber: 51, eventMatched: true });
    const client = clientWith(fakeProvider({ receiptThrows: 'skip' }));
    const rep = await reconcileChainState(client, { home: HOME });
    // 旧判据 (只看 confirmed) 在这里得出"什么都没对账" → 假红
    expect(rep.confirmed.filter((r) => r.requestId === 'r-a')).toEqual([]);
    // ★ 正确判据: 两种事实合起来
    expect(reconciledSettledIds(rep)).toContain('r-a');
    expect(reconciledSettledIds(rep)).not.toContain('r-b');
    expect(recoverChainState(HOME).settled.map((r) => r.requestId)).toEqual(['r-a']);
  });

  it('★ 已 finalized 但被标可疑 → 绝不跳过 (必须真去链上复核, 检出重组)', async () => {
    await seed({ status: 'finalized', confirmations: 40, blockNumber: 98, eventMatched: true, suspect: true, suspectReason: '人工怀疑' });
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 105, logs: [releasedV2Log(TASK_KEY)] }), // 换了块 → 重组
      latestBlock: 200,
    }));
    const rep = await reconcileChainState(client, { home: HOME });
    expect(rep.scanned).toBe(1);
    expect(rep.skippedFinalized).toEqual([]);
    expect(rep.reorged.map((r) => r.requestId)).toEqual([RID]);
    expect(reconciledSettledIds(rep)).toEqual([]);
    expect(rep.considered).toBe(rep.scanned + rep.skippedFinalized.length);
  });

  it('skipFinalized:false → 已 final 的也真去链上重算, skippedFinalized 为空', async () => {
    await seed({ status: 'finalized', confirmations: 40, blockNumber: 98, eventMatched: true });
    const client = clientWith(fakeProvider({
      receipt: receipt({ status: 1, blockNumber: 98, logs: [releasedV2Log(TASK_KEY)] }),
      latestBlock: 200,
      escrow: escrowTuple({ state: 1 }),
    }));
    const rep = await reconcileChainState(client, { home: HOME, skipFinalized: false });
    expect(rep.scanned).toBe(1);
    expect(rep.skippedFinalized).toEqual([]);
    expect(rep.confirmed.map((r) => r.requestId)).toEqual([RID]);
    expect(reconciledSettledIds(rep)).toEqual([RID]);
  });

  it('★ reorged 判定不丢"曾记在哪个块" (否则下一次对账只能说 unknown, 说不出"被回滚了")', async () => {
    await seed({ blockNumber: 98, confirmations: 3, eventMatched: true });
    const gone = clientWith(fakeProvider({ receipt: null, latestBlock: 200 }));
    const rep1 = await reconcileChainState(gone, { home: HOME });
    expect(rep1.reorged.map((r) => r.requestId)).toEqual([RID]);
    expect(getChainTxRecord(RID, HOME)!.blockNumber).toBe(98); // ★ 旧块号必须留住
    // 再对账一次: 必须**重复检出** reorged (而不是退化成 unknown)
    const rep2 = await reconcileChainState(gone, { home: HOME, skipFinalized: false });
    expect(rep2.reorged.map((r) => r.requestId)).toEqual([RID]);
    expect(rep2.unknown).toEqual([]);
    expect(recoverChainState(HOME).settled).toEqual([]);
  });
});
