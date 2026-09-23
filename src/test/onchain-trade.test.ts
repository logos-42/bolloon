/**
 * onchain-trade.test.ts — P4「任务交易闭环」的判定/恢复单测 (假链, 不联网)
 *
 * 覆盖:
 *   · M1 预算硬约束 (单任务 0.05 / 单次 0.02, 超了拒绝并指明哪一层)
 *   · 摘要口径 (sha256:<hex> → keccak256(utf8(...)))
 *   · 验真门: chainSettled=false / 合约不是 RELEASED / local-dev → 一律到不了 verified
 *   · 写路径: local-dev 永远写不出 fully_settled; 链上不确定时保持未结算
 *   · 重启恢复: 纯读盘给出 nextAction (不确定≠失败, 回滚≠可自动重发, 重组→待人工)
 *   · resumeOnchainTrade: 在对账之后只在安全动作上推进 (不重付 / 不静默标 verified)
 *
 * 真链 (真签名/真 receipt/真事件) 在 scripts/verify-onchain-trade-loop.ts 里跑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkOnchainAmount, atomicToUsdc, sha256Digest, chainHashOf, onchainTaskKey,
  recoverOnchainTrade, runOnchainTradeLoop, resumeOnchainTrade,
  createEscrowStep, submitProofStep, releaseStep,
  evaluateChainVerifiedGate, applyChainSettlementToTransaction,
  type OnchainPaymentVerifier, type OnchainTradeRequest,
} from '../agents/chain/onchain-trade.js';
import { computeResultHashOffChain, EscrowClient } from '../agents/chain/escrow-client.js';
import { upsertChainTx, chainStatePath } from '../agents/chain/chain-state-store.js';
import type { ChainSettlementVerdict } from '../agents/chain/chain-settlement.js';
import { beginTransaction, readTransaction, updateTransaction } from '../agents/x402/transaction-store.js';
import { writeDeliveryContent, CURRENT_SCHEMA_VERSION } from '../agents/x402/settlement-state.js';
import { computeContentHash } from '../agents/x402/paid-info-protocol.js';
import { computeReceiptHash, computeDeliveryHash } from '../agents/x402/transaction-protocol.js';
import { clientWith, fakeProvider, receipt, fakeSigner } from './chain-test-helpers.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-onchaintrade-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const TXH = '0x' + 'ab'.repeat(32);
const TASK_ID = 'p4-unit-task';
const TASK_KEY = onchainTaskKey(TASK_ID);
const ESCROW = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const AGENT = '0x' + 'a0'.repeat(20);

const verdict = (over: Partial<ChainSettlementVerdict>): ChainSettlementVerdict => ({
  chainSettled: false, status: 'unknown', reason: 'x', confirmationsRequired: 1, requiredGate: 'confirmed',
  rpcAvailable: true, checkedAt: Date.now(), evidence: {}, ...over,
});

const seedRec = (over: any = {}) => upsertChainTx({
  requestId: `chaintx-${over.method || 'createEscrowV2'}-${Math.random().toString(16).slice(2, 10)}`,
  method: 'createEscrowV2', taskKey: TASK_KEY, escrowAddress: ESCROW, chainId: 31337,
  txHash: TXH, confirmations: 3, lastCheckedBlock: 100, blockNumber: 98,
  status: 'confirmed', reason: 'seed', ...over,
}, HOME);

describe('M1 预算硬约束 + 摘要口径', () => {
  it('0.02 USDC (20000 原子) 在单次上限内', () => {
    const d = checkOnchainAmount({ amountAtomic: 20_000n, decimals: 6 });
    expect(d.ok).toBe(true);
    expect(d.amountUsdc).toBe('0.02');
    expect(d.budget.taskBudget).toBe(0.05);
    expect(d.budget.perPurchase).toBe(0.02);
  });
  it('0.03 超单次上限 → 拒绝, 且指明哪一层', () => {
    const d = checkOnchainAmount({ amountAtomic: 30_000n, decimals: 6 });
    expect(d.ok).toBe(false);
    expect(d.layer).toBe('perPurchase');
    expect(String(d.reason)).toContain('单次购买上限');
  });
  it('任务预算被收窄到 0.01 → 0.02 那笔被拦下 (单次上限本身由任务预算收紧)', () => {
    const d = checkOnchainAmount({ amountAtomic: 20_000n, decimals: 6, budget: { taskBudget: 0.01 } });
    expect(d.ok).toBe(false);
    expect(d.layer).toBe('perPurchase');
    expect(`${d.reason} ${d.why.join(' ')}`).toContain('任务预算');
  });
  it('0 / 负数 / 非有限数 → 拒绝 (不猜)', () => {
    expect(checkOnchainAmount({ amountAtomic: 0n, decimals: 6 }).ok).toBe(false);
    expect(checkOnchainAmount({ amountAtomic: -1n, decimals: 6 }).ok).toBe(false);
  });
  it('原子单位 → 十进制只做位移, 不四舍五入', () => {
    expect(atomicToUsdc(50_000n, 6)).toBe('0.05');
    expect(atomicToUsdc(100_000n, 6)).toBe('0.1');
    expect(atomicToUsdc(1n, 6)).toBe('0.000001');
    expect(atomicToUsdc(1_000_000n, 6)).toBe('1');
  });
  it('resultHash 口径 = keccak256(utf8("sha256:<hex>"))', () => {
    const d = sha256Digest('hello');
    expect(d.startsWith('sha256:')).toBe(true);
    expect(chainHashOf(d)).toBe(computeResultHashOffChain(d));
  });
});

describe('验真门 evaluateChainVerifiedGate', () => {
  const mkRec = async (over: Partial<any> = {}) => {
    const { record } = await beginTransaction({ requestId: `req-${Math.random().toString(16).slice(2, 8)}`, metadata: { itemId: 'skill-x' }, buyerDid: 'did:key:buyer' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted' } as any, HOME);
    return (await updateTransaction(record.transactionId, { status: 'paying', settlementFact: 'payment_submitted', ...over } as any, HOME))!;
  };

  it('chainSettled=false → 绝不 verified, 原因如实', () => {
    const r = evaluateChainVerifiedGate({
      rec: { transactionId: 't', status: 'paying', chainSettled: false, paymentMode: 'escrow', settlementFact: 'payment_submitted', events: [] } as any,
      home: HOME, verdict: verdict({ status: 'pending', reason: '确认数 1 < 门槛 12' }), taskKey: TASK_KEY,
    });
    expect(r.verified).toBe(false);
    expect(r.blockedBy[0]).toContain('chainSettled !== true');
  });

  it('链上成立但合约状态不是 RELEASED → 不 verified', () => {
    const r = evaluateChainVerifiedGate({
      rec: { transactionId: 't', status: 'settled', chainSettled: true, paymentMode: 'escrow', settlementFact: 'fully_settled', events: [] } as any,
      home: HOME,
      verdict: verdict({ chainSettled: true, status: 'confirmed', txHash: TXH, eventMatched: true, escrowState: 'ACTIVE', confirmations: 3, confirmationsRequired: 1 }),
      taskKey: TASK_KEY,
    });
    expect(r.verified).toBe(false);
    expect(r.blockedBy.join(' ')).toContain('RELEASED');
  });

  it('local-dev 记录 + 链上判定 → 八项门拒绝 (永远到不了 fully_settled)', () => {
    const r = evaluateChainVerifiedGate({
      rec: { transactionId: 't', status: 'paying', chainSettled: false, paymentMode: 'local-dev', settlementFact: 'payment_submitted', events: [] } as any,
      home: HOME,
      verdict: verdict({ chainSettled: true, status: 'confirmed', txHash: TXH, eventMatched: true, escrowState: 'RELEASED', confirmations: 3, confirmationsRequired: 1 }),
      taskKey: TASK_KEY,
    });
    expect(r.verified).toBe(false);
    expect(r.blockedBy.join(' ')).toMatch(/local-dev|结算事实迁移被拒/);
  });
});

describe('写路径 applyChainSettlementToTransaction', () => {
  const settledVerdict = () => verdict({
    chainSettled: true, status: 'confirmed', txHash: TXH, eventMatched: true, matchedEvent: 'ReleasedV2',
    escrowState: 'RELEASED', confirmations: 2, confirmationsRequired: 1,
  });

  async function fullRecord(opts: { mode?: string } = {}) {
    const { record } = await beginTransaction({ requestId: `req-${Math.random().toString(16).slice(2, 8)}`, metadata: { itemId: 'skill-x' }, buyerDid: 'did:key:buyer' }, HOME);
    const body = JSON.stringify({ summary: '调研结论', findings: [{ claim: 'x', source: 'y' }] });
    const wr = writeDeliveryContent(record.transactionId, body, HOME);
    const receiptHash = computeReceiptHash('chain-release:' + TXH);
    await updateTransaction(record.transactionId, { status: 'quoted' } as any, HOME);
    await updateTransaction(record.transactionId, {
      status: 'paying', paymentMode: (opts.mode || 'escrow') as any, settlementFact: 'payment_submitted',
      txHash: TXH, chainSettled: false, protocolVerified: true,
      contentHash: computeContentHash(body), deliveryHash: computeContentHash(body),
      deliveryBytesHash: wr.hash, receiptHash,
      execution: { ok: true, tool: 'skill_exec', schemaOk: true, outputHash: wr.hash },
      goalCriteriaMet: true,
      resourceOutcome: { installed: true, executed: true, outputContract: 'pass', criteriaHit: true },
    } as any, HOME);
    return readTransaction(record.transactionId, HOME);
  }

  it('链上成立 + 八项门全过 → 一次原子写 verified + fully_settled', async () => {
    const rec = (await fullRecord())!;
    const r = await applyChainSettlementToTransaction({
      rec, home: HOME, verdict: settledVerdict(), taskKey: TASK_KEY, execution: rec.execution as any, goalCriteriaMet: true,
    });
    expect(r.verified).toBe(true);
    expect(r.status).toBe('verified');
    expect(r.settlementFact).toBe('fully_settled');
    const after = (await readTransaction(rec.transactionId, HOME))!;
    expect(after.status).toBe('verified');
    expect(after.chainSettled).toBe(true);
    expect(after.settlementFact).toBe('fully_settled');
  });

  it('local-dev 记录: 链上判定为真也写不出 fully_settled / verified', async () => {
    const rec = (await fullRecord({ mode: 'local-dev' }))!;
    const r = await applyChainSettlementToTransaction({
      rec, home: HOME, verdict: settledVerdict(), taskKey: TASK_KEY, execution: rec.execution as any, goalCriteriaMet: true,
    });
    expect(r.verified).toBe(false);
    const after = (await readTransaction(rec.transactionId, HOME))!;
    expect(after.settlementFact).not.toBe('fully_settled');
    expect(after.status).not.toBe('verified');
  });

  it('确认数不够 (pending) → 不 verified, 结算事实保持未到链上口径', async () => {
    const rec = (await fullRecord())!;
    const r = await applyChainSettlementToTransaction({
      rec, home: HOME,
      verdict: verdict({ status: 'pending', reason: '确认数 1 < 500', confirmations: 1, confirmationsRequired: 500 }),
      taskKey: TASK_KEY, execution: rec.execution as any, goalCriteriaMet: true,
    });
    expect(r.verified).toBe(false);
    const after = (await readTransaction(rec.transactionId, HOME))!;
    expect(after.status).not.toBe('verified');
    expect(after.settlementFact).not.toBe('fully_settled');
  });

  it('RPC 读不到 (unknown) → 不确定≠失败: 不回写成 unpaid, 也不 verified', async () => {
    const rec = (await fullRecord())!;
    const r = await applyChainSettlementToTransaction({
      rec, home: HOME,
      verdict: verdict({ status: 'unknown', reason: 'RPC 不可用', rpcAvailable: false }),
      taskKey: TASK_KEY, execution: rec.execution as any, goalCriteriaMet: true,
    });
    expect(r.verified).toBe(false);
    const after = (await readTransaction(rec.transactionId, HOME))!;
    expect(after.settlementFact).toBe('payment_submitted');
    expect(after.chainSettled).toBe(false);
  });
});

describe('重启恢复 recoverOnchainTrade (纯读盘)', () => {
  it('没有任何链上记录 → 允许安全从头走', async () => {
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.found).toBe(false);
    expect(r.nextAction).toBe('create_escrow');
    expect(r.mustNotRepay).toBe(false);
    expect(r.statePath).toBe(chainStatePath(HOME));
  });

  it('托管已上链 + 执行失败 (没产物) → 待人工, 且绝不重付', async () => {
    await seedRec({ method: 'createEscrowV2' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('needs_human');
    expect(r.mustNotRepay).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('托管');
  });

  it('托管已上链 + 执行产物在手 → 安全继续 (submit_proof)', async () => {
    await seedRec({ method: 'createEscrowV2' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID, pendingResultDigest: 'sha256:abc' });
    expect(r.nextAction).toBe('submit_proof');
    expect(r.mustNotRepay).toBe(true);
  });

  it('create 结论未定 (确认数不够) → verify_only (不确定≠失败, 不许重发)', async () => {
    await seedRec({ method: 'createEscrowV2', status: 'pending', confirmations: 0 });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('verify_only');
    expect(r.mustNotRepay).toBe(true);
  });

  it('create 回滚 → 待人工 (回滚≠可以自动重发)', async () => {
    await seedRec({ method: 'createEscrowV2', status: 'reverted', reason: 'receipt.status=0' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('needs_human');
    expect(r.mustNotRepay).toBe(false);
  });

  it('证明已上链 + 还没释放 → 可以安全释放', async () => {
    await seedRec({ method: 'createEscrowV2' });
    await seedRec({ method: 'submitProofV2', txHash: '0x' + 'cd'.repeat(32), resultHash: '0x' + '11'.repeat(32) });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('release');
    expect(r.mustNotRepay).toBe(true);
  });

  it('释放已确认 + 状态 RELEASED → done/verified', async () => {
    await seedRec({ method: 'createEscrowV2' });
    await seedRec({ method: 'submitProofV2', txHash: '0x' + 'cd'.repeat(32) });
    await seedRec({ method: 'releaseV2', txHash: '0x' + 'ef'.repeat(32), escrowState: 'RELEASED' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('done');
    expect(r.verified).toBe(true);
    expect(r.mustNotRepay).toBe(true);
  });

  it('释放确定但合约状态不是 RELEASED → 待人工 (不静默 verified)', async () => {
    await seedRec({ method: 'createEscrowV2' });
    await seedRec({ method: 'submitProofV2', txHash: '0x' + 'cd'.repeat(32) });
    await seedRec({ method: 'releaseV2', txHash: '0x' + 'ef'.repeat(32), escrowState: 'ACTIVE' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('needs_human');
    expect(r.verified).toBe(false);
  });

  it('任何一条被标可疑 (重组) → 待人工, 且不算 settled', async () => {
    await seedRec({ method: 'createEscrowV2' });
    await seedRec({ method: 'submitProofV2', txHash: '0x' + 'cd'.repeat(32) });
    await seedRec({ method: 'releaseV2', txHash: '0x' + 'ef'.repeat(32), escrowState: 'RELEASED', suspect: true, status: 'reorged', suspectReason: '同一 txHash 换块' });
    const r = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(r.nextAction).toBe('needs_human');
    expect(r.verified).toBe(false);
    expect(r.blockedBy.join(' ')).toContain('可疑');
  });
});

describe('runOnchainTradeLoop / resumeOnchainTrade (假链脚本化判定)', () => {
  const scripted = (): OnchainPaymentVerifier => async ({ txHash, chainSettlement }) => {
    const ev = chainSettlement?.expect?.eventName;
    if (ev === 'EscrowCreatedV2') {
      return verdict({ chainSettled: true, status: 'confirmed', txHash, eventMatched: true, matchedEvent: ev, escrowState: 'ACTIVE', confirmations: 2, confirmationsRequired: 1 });
    }
    if (ev === 'ProofSubmittedV2') {
      return verdict({ chainSettled: true, status: 'confirmed', txHash, eventMatched: true, matchedEvent: ev, escrowState: 'ACTIVE', confirmations: 2, confirmationsRequired: 1 });
    }
    return verdict({ chainSettled: true, status: 'confirmed', txHash, eventMatched: true, matchedEvent: 'ReleasedV2', escrowState: 'RELEASED', confirmations: 2, confirmationsRequired: 1 });
  };

  function req(over: Partial<OnchainTradeRequest> = {}): OnchainTradeRequest {
    const provider = fakeProvider({ receipt: receipt({ status: 1, blockNumber: 98 }) });
    const client = new EscrowClient({ escrowAddress: ESCROW, provider });
    const buyer = fakeSigner(provider, { address: '0x' + 'b0'.repeat(20) }).signer;
    const seller = fakeSigner(provider, { address: AGENT }).signer;
    return {
      client, home: HOME, taskId: TASK_ID, agentAddress: AGENT, amountAtomic: 20_000n,
      paymentAsset: '0x' + '55'.repeat(20),
      termsDigest: sha256Digest('terms'), quoteDigest: sha256Digest('quote'), inputDigest: sha256Digest('input'),
      deadline: 9_999_999_999n, confirmationWindow: 3600, proofVersion: 1,
      buyerSigner: buyer, sellerSigner: seller, verifyOnChain: scripted(),
      env: { BOLLOON_AGENT_AUTHORIZED: '1', BOLLOON_WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32) } as any,
      ...over,
    };
  }

  it('全闭环 (create→执行→proof→release) → verified, 且链上记录落盘', async () => {
    const r = await runOnchainTradeLoop(req(), async () => ({ ok: true, resultDigest: sha256Digest('result') }));
    expect(r.create?.ok).toBe(true);
    expect(r.proof?.ok).toBe(true);
    expect(r.release?.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.recovery.nextAction).toBe('done');
    expect(fs.existsSync(chainStatePath(HOME))).toBe(true);
  });

  it('执行失败 (托管已注资) → 不上证明/不释放, 待人工且绝不重付', async () => {
    const r = await runOnchainTradeLoop(req(), async () => ({ ok: false, reason: '技能超时' }));
    expect(r.create?.ok).toBe(true);
    expect(r.proof).toBeNull();
    expect(r.release).toBeNull();
    expect(r.verified).toBe(false);
    expect(r.recovery.nextAction).toBe('needs_human');
    expect(r.recovery.mustNotRepay).toBe(true);
  });

  it('create 没成功 → 不执行、不提交证明', async () => {
    let executed = false;
    let createSends = 0;
    const r = await runOnchainTradeLoop(req({
      settleRetryAttempts: 0,   // 固定返回 pending 的假判定器: 关掉重读 (测分支, 不测网络抖动)
      verifyOnChain: async ({ txHash, chainSettlement }) => {
        if (chainSettlement?.expect?.eventName === 'EscrowCreatedV2') {
          createSends++;
          return verdict({ chainSettled: false, status: 'pending', txHash, reason: '确认数不足' });
        }
        return verdict({ chainSettled: true, status: 'confirmed', txHash });
      },
    }), async () => { executed = true; return { ok: true, resultDigest: sha256Digest('r') }; });
    expect(r.create?.ok).toBe(false);
    expect(executed).toBe(false);
    expect(r.verified).toBe(false);
    expect(createSends).toBe(1);            // 只判定一次 (重读被显式关掉了)
  });

  it('★ 刚 broadcast 后读到旧高度 (假 pending) → 只重读不定案, 绝不重发交易', async () => {
    let judged = 0;
    const base = req({
      settleRetryDelayMs: 1,               // 别让测试真等
      verifyOnChain: async ({ txHash }) => {
        judged++;
        // 第 1 次: 公共 RPC 的后端还停在前一个块 → 确认数 0 (钱其实已进托管)
        if (judged === 1) {
          return verdict({ chainSettled: false, status: 'pending', txHash, confirmations: 0, confirmationsRequired: 1, reason: '确认数 0 < 门槛 1 (confirmed) → 还没到可以判结算的程度' });
        }
        return verdict({ chainSettled: true, status: 'confirmed', txHash, eventMatched: true, matchedEvent: 'EscrowCreatedV2', escrowState: 'ACTIVE', confirmations: 1, confirmationsRequired: 1 });
      },
    });
    const step = await createEscrowStep(base);
    expect(step.ok).toBe(true);            // 重读之后判成 confirmed
    expect(judged).toBe(2);                // 恰好重读一次
    expect(step.txHash).not.toBe('');      // ★ 交易只发了一笔 (重读 ≠ 重发)
    const recorded = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(recorded.records.filter((x) => x.method === 'createEscrowV2').length).toBe(1);
  });

  it('★ 事件对得上但合约状态读回旧值 (event_mismatch) → 重读后判成已释放', async () => {
    let judged = 0;
    const step = await releaseStep(req({
      settleRetryDelayMs: 1,
      verifyOnChain: async ({ txHash }) => {
        judged++;
        // 第 1 次: receipt/事件都是新的, 但 eth_call 读回的 escrow 状态还停在 ACTIVE
        if (judged === 1) {
          return verdict({ chainSettled: false, status: 'event_mismatch', txHash, eventMatched: true, matchedEvent: 'ReleasedV2', escrowState: 'ACTIVE', reason: '事件对得上但合约状态是 ACTIVE, 期望 RELEASED' });
        }
        return verdict({ chainSettled: true, status: 'confirmed', txHash, eventMatched: true, matchedEvent: 'ReleasedV2', escrowState: 'RELEASED', confirmations: 1, confirmationsRequired: 1 });
      },
    }));
    expect(step.ok).toBe(true);
    expect(judged).toBe(2);
  });

  it('pending + RPC 读不到 (rpcAvailable=false) → 不重读, 如实停在未定', async () => {
    let judged = 0;
    const step = await releaseStep(req({
      settleRetryDelayMs: 1,
      verifyOnChain: async ({ txHash }) => { judged++; return verdict({ chainSettled: false, status: 'pending', txHash, rpcAvailable: false, reason: '读 receipt 失败' }); },
    }));
    expect(step.ok).toBe(false);
    expect(judged).toBe(1);                // RPC 不可用 → 重读没意义, 一次就够
  });

  it('放行闸未授权 → 不发交易, 不写审计', async () => {
    const r = await runOnchainTradeLoop(req({ env: {} as any }), async () => ({ ok: true, resultDigest: sha256Digest('r') }));
    expect(r.create?.authorized).toBe(false);
    expect(r.create?.txHash).toBe('');
    expect(r.create?.reason).toContain('放行闸拒绝');
  });

  it('★ submitProof 后 release 前崩溃 → 重启后从 chain-state.json 续上并释放', async () => {
    const base = req();
    // 第一次: create + 真执行 + proof 都成了, 但**还没走 release** 就崩了
    const create = await createEscrowStep(base);
    const proof = await submitProofStep(base, sha256Digest('result'));
    expect(create.ok).toBe(true);
    expect(proof.ok).toBe(true);

    // 重启: 纯读盘 → 可以安全释放 (钱在托管里, 不是第二次付款)
    const rec = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(rec.nextAction).toBe('release');
    expect(rec.mustNotRepay).toBe(true);
    expect(rec.verified).toBe(false);

    // 续跑: 只走 release (不再 create, 不再 proof → 不会重付)
    const resumed = await resumeOnchainTrade({ ...base, dryRun: false });
    expect(resumed.steps.map((s) => s.method)).toEqual(['releaseV2']);
    expect(resumed.done).toBe(true);
    expect(resumed.verified).toBe(true);
    const after = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(after.nextAction).toBe('done');
  });

  it('★ release 尝试过但结论未知 (RPC 读不到) → verify_only (不确定≠失败), 重新对账后才 done', async () => {
    const base = req();
    const create = await createEscrowStep(base);
    const proof = await submitProofStep(base, sha256Digest('result'));
    expect(create.ok && proof.ok).toBe(true);
    // release 真发出去了, 但判定读不到 RPC → unknown
    const release = await releaseStep({ ...base, verifyOnChain: async ({ txHash }) => verdict({ chainSettled: false, status: 'unknown', txHash, reason: 'RPC 不可用', rpcAvailable: false }) });
    expect(release.txHash).not.toBe('');
    expect(release.ok).toBe(false);

    const rec = recoverOnchainTrade({ home: HOME, taskId: TASK_ID });
    expect(rec.nextAction).toBe('verify_only');
    expect(rec.mustNotRepay).toBe(true);
    expect(rec.verified).toBe(false);

    // RPC 回来 → 重新对账 (会把 release 判成 confirmed) → done + verified
    const resumed = await resumeOnchainTrade({ ...base, dryRun: false });
    expect(resumed.reverified.length).toBeGreaterThanOrEqual(3);
    expect(resumed.done).toBe(true);
    expect(resumed.verified).toBe(true);
  });
});

describe('交易记录初始态', () => {
  it('新建记录 schema 版本是 v2 且 ssettleFact=unpaid', async () => {
    const { record } = await beginTransaction({ requestId: 'req-schema', metadata: {}, buyerDid: 'did:key:b' }, HOME);
    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(record.settlementFact).toBe('unpaid');
    expect(computeDeliveryHash('x').length).toBe(64);
  });
});

describe('任务链路入口 runTaskOnchain (预算闸/资源门的诚实出口)', () => {
  const TOR = async () => (await import('../agents/task/task-onchain-runner.js'));
  const fakeClient: any = { escrowAddress: '0x' + 'ee'.repeat(20), chainId: 31337, confirmations: { confirmed: 1, finalized: 12 } };
  const base = () => ({
    task: '判断这款厨房用品是否适合进入日本市场', home: HOME,
    client: fakeClient, agentAddress: AGENT, paymentAsset: '0x' + '55'.repeat(20),
    buyerSigner: undefined as any, sellerSigner: undefined as any,
  });

  it('预算非法 → 不产生托管/没有交易, 报告卡=需要你处理', async () => {
    const { runTaskOnchain } = await TOR();
    const r = await runTaskOnchain({ ...base(), budget: 'abc' } as any);
    expect(r.ok).toBe(false);
    expect(r.card.status).toBe('需要你处理');
    expect(r.transactionId).toBe('');
    expect(r.chain.verified).toBe(false);
    expect(String(r.card.blocker)).toContain('预算');
  });

  it('没有任何可执行资源 → 不买, 如实报告 (链上 false)', async () => {
    const { runTaskOnchain } = await TOR();
    const r = await runTaskOnchain({ ...base(), budget: '0.05', skillPaths: [], choose: async () => null } as any);
    expect(r.ok).toBe(false);
    expect(r.transactionId).toBe('');
    expect(r.chain.verified).toBe(false);
    expect(r.chain.statuses).toEqual([]);
  });

  it('输入建不出来 (数值字段在任务里没有锚点) → 未开托管、没花钱 (不先注资)', async () => {
    const { runTaskOnchain } = await TOR();
    // 中性夹具: 两个必填数值字段, 任务文本里只有符号 μ0X_P 里的那个 0 (旧实现会把它编成数字)
    const contract = {
      name: 'neutral-consistency', version: '1.0.0',
      inputSchema: {
        type: 'object', required: ['field_A', 'field_B'],
        properties: { field_A: { type: 'number' }, field_B: { type: 'number' }, relation: { type: 'string' } },
      },
      outputSchema: { type: 'object', required: [] },
      verification: { requiredFields: [] },
      execution: { entrypoint: 'noop.mjs' },
    };
    const r = await runTaskOnchain({
      ...base(), budget: '0.05', perPurchase: '0.001',
      task: '核对 记号 μ0X_P 下的两数是否自洽',
      choose: async () => ({ name: 'neutral-consistency', version: '1.0.0', dir: '/nonexistent', contract }),
    } as any);
    expect(r.ok).toBe(false);
    expect(r.transactionId).toBe('');            // ★ 链上写操作一次都没发生 (不会被卡在托管里)
    expect(r.chain.verified).toBe(false);
    expect(r.chain.statuses).toEqual([]);
    expect(String(r.card.blocker)).toContain('输入');
  });
});
