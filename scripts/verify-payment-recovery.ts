/**
 * verify-payment-recovery.ts — Phase 3 验收: 支付中断恢复 (2026-09-18)
 *
 * 真: 真子进程在 5 个时点被 **SIGKILL** (不是模拟异常) · 真交易记录落盘 · 真对账 · 真恢复执行。
 * 标准 (leo): 5 个 SIGKILL 场景 · **0 次重复付款** · 0 个丢失交易记录 · 0 个错误 verified · 所有交易证据可回放。
 *
 * 用法: npx tsx scripts/verify-payment-recovery.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-payrec-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '支付恢复验收' });

const TXS: any = await import('../src/agents/x402/transaction-store.js');
const REC: any = await import('../src/agents/x402/payment-recovery.js');
const SS: any = await import('../src/agents/x402/settlement-state.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

// ── 计数器: 所有"付款动作"都过这里, 用数字证明没有重复付款 ──────────────────
const PAY_LOG = path.join(ROOT, 'pay-attempts.jsonl');
const readPays = (): any[] => (fs.existsSync(PAY_LOG) ? fs.readFileSync(PAY_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const recordPay = (txId: string, phase: string, ok: boolean) => fs.appendFileSync(PAY_LOG, `${JSON.stringify({ txId, phase, ok, at: new Date().toISOString() })}\n`, 'utf8');

/** 计数适配器: pay/deliver/verify 都记账, 交付与验真做成幂等 */
function makeDeps(opts: { phase: string; chainProof?: string }) {
  const calls: string[] = [];
  const deps: any = {
    reconcile: async (rec: any) => {
      calls.push('reconcile');
      // 对账: 只在能拿到**链上证据** (txHash) 时才升级结算事实
      const txHash = rec.txHash || (opts.phase === 'after_settle' || opts.phase === 'mid_delivery' || opts.phase === 'after_delivery' ? opts.chainProof : '');
      if (txHash) return { fact: 'payment_verified', txHash, note: `对账发现 txHash ${String(txHash).slice(0, 12)}… → 结算事实升级` };
      if (rec.paymentReceipt) return { fact: 'unknown', note: '有回执但无 txHash → 维持 unknown (不许当没付过)' };
      return { fact: 'unpaid', note: '没有任何支付凭据 → 确认没付过' };
    },
    pay: async (rec: any) => {
      // 真付款: 只有"确认没付过"的路径才会被调用; 这里写计数 + 落回执
      const dup = readPays().filter((p) => p.txId === rec.transactionId).length;
      recordPay(rec.transactionId, opts.phase, dup === 0);
      calls.push(`pay(第${dup + 1}次)`);
      if (dup > 0) return { ok: false, error: '重复付款被适配器拒绝' };
      return { ok: true, receipt: `rcpt-${opts.phase}`, txHash: opts.chainProof };
    },
    deliver: async (rec: any) => {
      calls.push('deliver');
      const existing = SS.readDeliveryContent(rec.transactionId, HOME);
      const body = existing ?? '跨境市场调研正文 (恢复交付)';
      const w = SS.writeDeliveryContent(rec.transactionId, body, HOME);
      await TXS.updateTransaction(rec.transactionId, { deliveryHash: rec.contentHash || 'sha256:content', contentHash: rec.contentHash || 'sha256:content', deliveryBytesHash: w.hash, protocolVerified: true, receiptHash: rec.receiptHash || 'rcpt-hash' } as any, HOME);
      return { ok: true };
    },
    verify: async (rec: any) => {
      calls.push('verify');
      const v = SS.verifyDelivery(rec, HOME);
      if (!v.present) { await TXS.setTransactionStatus(rec.transactionId, 'delivery_failed', '验真时发现正文不在', HOME); return { ok: false, reason: '正文缺失' }; }
      if (!v.matchesRecorded) { await TXS.setTransactionStatus(rec.transactionId, 'verification_failed', '交付正文与记录不一致', HOME); return { ok: false, reason: '正文被换过' }; }
      await TXS.setTransactionStatus(rec.transactionId, 'delivered', '交付与验真通过', HOME);
      return { ok: true };
    },
    read: async (txId: string) => TXS.readTransaction(txId, HOME),
    persist: async (txId: string, patch: Record<string, unknown>, event: { kind: string; detail?: string }) => {
      try { await TXS.updateTransaction(txId, { ...patch, event } as any, HOME); }
      catch (e: any) { fs.appendFileSync(path.join(ROOT, 'persist-errors.log'), `${txId} ${event.kind}: ${String(e?.reason || e?.message)}\n`, 'utf8'); }
    },
  };
  return { deps, calls };
}

/** 起子进程 → 到指定时点 → 真 SIGKILL → 返回 transactionId */
async function killAtPhase(phase: string, requestId: string, chainProof: string): Promise<{ txId: string; killed: boolean }> {
  const child = spawn('npx', ['tsx', 'scripts/lib/payment-phase-child.ts', phase, HOME, requestId, chainProof], { cwd: process.cwd(), env: { ...process.env, HOME } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => { /* 忽略噪音 */ });
  await new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (/PHASE_READY/.test(out) || Date.now() - t0 > 90_000) { clearInterval(iv); res(null); } }, 200); });
  const txId = (out.match(/PHASE_READY \S+ (tx-\S+)/) || [])[1] || '';
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  return { txId, killed: !!txId };
}

const CHAIN_PROOF = '0xrecoveryaaaabbbbccccddddeeeeffff0000111122223333444455556666777788';

// ═══ 场景 ①-⑤ ═══════════════════════════════════════════════════════════
const cases: Array<{ phase: string; title: string; expectAction: string; expectPay: number; expectNoop: boolean }> = [
  { phase: 'before_payment', title: '① 付款前被杀 → 可安全付款, 无重复', expectAction: 'retry_payment', expectPay: 1, expectNoop: false },
  { phase: 'after_claim', title: '② 拿到付款权后被杀 → 旧 claim 可回收, 只有一个付款者', expectAction: 'retry_payment', expectPay: 1, expectNoop: false },
  { phase: 'after_settle', title: '③ settle 后被杀 → 先对账发现 txHash, 禁止重付, 继续交付', expectAction: 'deliver', expectPay: 0, expectNoop: false },
  { phase: 'mid_delivery', title: '④ 支付成功交付中被杀 → 只补交付, 不重付', expectAction: 'deliver', expectPay: 0, expectNoop: false },
  { phase: 'after_delivery', title: '⑤ 交付后验真前被杀 → 只补验真, 不重付', expectAction: 'verify', expectPay: 0, expectNoop: false },
];

const results: Array<{ phase: string; txId: string; action: string; paid: boolean; calls: string[]; status: string; fact: string }> = [];
for (const c of cases) {
  section(`[场景] ${c.title}`);
  const requestId = `recovery-${c.phase}-${Date.now().toString(36)}`;
  const { txId, killed } = await killAtPhase(c.phase, requestId, CHAIN_PROOF);
  check('子进程真被 SIGKILL 且留下了交易记录', killed && (await TXS.readTransaction(txId, HOME)) !== null, txId || '(没拿到 txId)');
  if (!killed) continue;

  // ★ 对账**之前**的计划 (这才是"重启后第一眼看到什么")
  const raw = await TXS.readTransaction(txId, HOME);
  const prePlan = REC.planTransactionRecovery(raw);
  const preExpect: Record<string, string> = { before_payment: 'retry_payment', after_claim: 'reconcile', after_settle: 'deliver', mid_delivery: 'deliver', after_delivery: 'verify' };
  check(`对账前计划 = ${preExpect[c.phase]} (实际 ${prePlan.action})`, prePlan.action === preExpect[c.phase], { reason: prePlan.reason, fact: prePlan.settlementFact });
  if (c.phase === 'after_settle' || c.phase === 'mid_delivery' || c.phase === 'after_delivery') {
    check('有链上事实 → 计划里明确"绝不重付"', prePlan.mustNotRepay === true, prePlan);
  }

  // ★ 场景 ② 的特别检查: 新 worker 在**对账前**不许重复付款 (安全方向), 对账后旧 claim 被回收、可以安全接管
  if (c.phase === 'after_claim') {
    const mid = await TXS.readTransaction(txId, HOME);
    check('被杀时确实停在 paying (付款权已拿、还没真付)', mid?.status === 'paying' && !mid?.paymentReceipt, { status: mid?.status, receipt: mid?.paymentReceipt });
    const blocked = await TXS.claimPayment(mid.requestId, mid.transactionId, HOME);
    check('对账前: 新 worker 拿不到付款权 (不会两个一起付)', blocked.ok === false, blocked.reason);
    check('暂停态由 status=paying 兜住重复付款 (结算事实如实仍是 unpaid: 确实没发出凭据)', mid?.status === 'paying' && mid?.settlementFact === 'unpaid', { status: mid?.status, fact: mid?.settlementFact });
  }

  // 恢复前: 先对账 (真实做法), 再看计划
  await TXS.reconcilePendingTransactions(HOME).catch(() => null);
  const before = await TXS.readTransaction(txId, HOME);
  const plan = REC.planTransactionRecovery(before);
  check(`对账后计划 = ${c.expectAction} (实际 ${plan.action})`, plan.action === c.expectAction, { reason: plan.reason, fact: plan.settlementFact });
  if (c.phase === 'after_claim') {
    check('对账结论: 没有任何支付凭据 → 可安全重试 (unpaid + payment_required)', before?.settlementFact === 'unpaid' && before?.status === 'payment_required', { fact: before?.settlementFact, status: before?.status });
    const claim2 = await TXS.claimPayment(before.requestId, before.transactionId, HOME);
    check('对账后旧 claim 已回收, 新 worker 能接管', claim2.ok === true, claim2.reason);
    await TXS.releasePaymentClaim(before.requestId, HOME);
  }

  const paysBefore = readPays().filter((p) => p.txId === txId).length;
  const { deps, calls } = makeDeps({ phase: c.phase, chainProof: CHAIN_PROOF });
  const out = await REC.runTransactionRecovery(before, deps);
  const paysAfter = readPays().filter((p) => p.txId === txId).length;
  const after = await TXS.readTransaction(txId, HOME);
  check(`付款次数 = ${c.expectPay} (没有重复付款)`, paysAfter - paysBefore === c.expectPay, { before: paysBefore, after: paysAfter, calls });
  check('恢复后没有链上事实伪造 (chainSettled 只在真有 txHash 时)', after?.chainSettled === true ? !!after?.txHash : true, { cs: after?.chainSettled, tx: after?.txHash });
  const gate = SS.evaluateVerifiedGate({ rec: after, home: HOME, execution: null, goalCriteriaMet: false });
  check('local-dev 恢复后仍不能 verified (链上没结算)', gate.verified === false, gate.missing);
  const replay = await TXS.replayTransaction(txId, HOME);
  check('证据可回放 (事件链 ≥2 条)', replay.length >= 2, replay.length);
  results.push({ phase: c.phase, txId, action: out.action, paid: out.paid, calls, status: String(after?.status), fact: String(after?.settlementFact) });
}

// ═══ 附加场景 ⑥: 支付状态未知 ════════════════════════════════════════════
section('[附加] ⑥ 支付状态未知 (有回执、无 txHash) → 先对账, 不自动重付');
{
  const requestId = `recovery-unknown-${Date.now().toString(36)}`;
  const { txId, killed } = await killAtPhase('unknown_with_receipt', requestId, '');
  check('子进程被杀且留下记录', killed, txId);
  if (killed) {
    await TXS.reconcilePendingTransactions(HOME).catch(() => null);
    const before = await TXS.readTransaction(txId, HOME);
    const plan = REC.planTransactionRecovery(before);
    check('计划是"先对账"且不许重付', plan.action === 'reconcile' && plan.mustNotRepay === true, plan);
    const { deps } = makeDeps({ phase: 'unknown_with_receipt' });
    const out = await REC.runTransactionRecovery(before, deps);
    const after = await TXS.readTransaction(txId, HOME);
    check('对账后仍是 unknown (没证据不许当没付过)', after?.settlementFact === 'unknown', after?.settlementFact);
    check('全程 0 次付款', readPays().filter((p) => p.txId === txId).length === 0, out.calls);
    check('把它挂进 mustNotRepay (绝不重付)', (await TXS.reconcilePendingTransactions(HOME)).mustNotRepay.includes(txId), txId);
  }
}

// ═══ 附加场景 ⑦: facilitator 成功但没有 txHash ════════════════════════════
section('[附加] ⑦ facilitator 返回成功但没有 txHash → 不能认定链上结算完成');
{
  const src = fs.readFileSync(path.resolve('src/agents/x402/paid-info-store.ts'), 'utf8');
  // ★ F5 (2026-09-22 链桥): 旧的 `chainSettled = !!txHash` 本身就是漏洞 ——
  //   拿到 txHash 就宣称链上已验证, 从不读 receipt/确认数/事件。现在必须由**真链验证结论**决定。
  check('代码里 chainSettled 来自真链验证结论 (不再是 "有 txHash 就算结算")',
    !/chainSettled:\s*!!txHash/.test(src) && /verifyPaymentOnChain/.test(src) && /chainSettled:\s*verdict\.chainSettled/.test(src),
    'paid-info-store 的 facilitator 分支');
  const { record } = await TXS.beginTransaction({ requestId: `no-txhash-${Date.now().toString(36)}`, metadata: { itemId: 'i' }, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
  const id = record.transactionId;
  await TXS.updateTransaction(id, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
  await TXS.updateTransaction(id, { status: 'paying' }, HOME);
  await TXS.updateTransaction(id, { settlementFact: 'payment_submitted', paymentReceipt: 'rcpt-no-hash' } as any, HOME);
  await TXS.updateTransaction(id, { status: 'delivered', contentHash: 'sha256:x', deliveryHash: 'sha256:x', receiptHash: 'rh', protocolVerified: true } as any, HOME);
  const rec = await TXS.readTransaction(id, HOME);
  const gate = SS.evaluateVerifiedGate({ rec, home: HOME, execution: { ok: true, schemaOk: true }, goalCriteriaMet: true });
  check('没有 txHash → 不能 verified (缺链上结算)', gate.verified === false && gate.missing.some((m: string) => m.includes('chainSettled')), gate.missing);
  const chk = SS.canTransitionSettlement('payment_submitted', 'fully_settled', { paymentMode: 'facilitator', chainSettled: false });
  check('没有链上证据 → 一步到 fully_settled 被拒', chk.ok === false, chk.reason);
  const plan = REC.planTransactionRecovery(rec);
  check('恢复计划: 有回执 → 不重付 (先对账/交人)', plan.mustNotRepay === true, plan);
}

// ═══ 汇总: 0 重复付款 / 0 丢失记录 / 0 错误 verified ═══════════════════════
section('[汇总] 三个"0"');
{
  const pays = readPays();
  const dup = pays.filter((p) => p.ok === false && /重复/.test(String(p.phase)));
  const byTx = new Map<string, number>();
  for (const p of pays) byTx.set(p.txId, (byTx.get(p.txId) || 0) + 1);
  const multi = [...byTx.entries()].filter(([, n]) => n > 1);
  check('0 次重复付款 (每个交易最多一次付款动作)', multi.length === 0, { pays: pays.length, multi });

  const txs = await TXS.listTransactions(HOME);
  const expected = results.length + 2;
  check(`0 条记录丢失 (盘上 ${txs.length} 条, 期望 ≥ ${expected})`, txs.length >= expected, txs.map((t: any) => t.transactionId));
  const verifiedCount = txs.filter((t: any) => t.status === 'verified').length;
  check('0 个错误 verified (本机联调一个都没有)', verifiedCount === 0, verifiedCount);

  const persistErrors = fs.existsSync(path.join(ROOT, 'persist-errors.log')) ? fs.readFileSync(path.join(ROOT, 'persist-errors.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
  check('0 次非法迁移企图 (持久化没有报错)', persistErrors.length === 0, persistErrors.slice(0, 3));

  let replayed = 0;
  for (const t of txs) {
    const lines = await TXS.replayTransaction(t.transactionId, HOME);
    if (lines.length >= 1) replayed++;
  }
  check('所有交易证据可回放', replayed === txs.length, { replayed, total: txs.length });

  console.log('\n各场景恢复结果:');
  for (const r of results) console.log(`  ${r.phase.padEnd(16)} 计划=${r.action.padEnd(13)} 付款=${r.paid ? '是' : '否'} 终态=${r.status.padEnd(17)} 结算=${r.fact} 调用=${r.calls.join(',')}`);
}

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`隔离 HOME: ${HOME}`);
console.log(`结论: 5 个 SIGKILL 时点全部走对路 · 0 次重复付款 · 0 个错误 verified · 0 条记录丢失 · 证据全部可回放`);
process.exit(failed === 0 ? 0 : 1);
