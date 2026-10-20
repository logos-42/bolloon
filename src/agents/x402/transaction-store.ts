/**
 * transaction-store.ts — 交易记录与审计 (Phase 5, 2026-09-16)
 *
 * 位置: `~/.bolloon/transactions/<transactionId>.json` (原子写)。
 * 为什么必须有: 支付不能只是工具内部副作用 —— 进程被杀、买方重试、Supervisor 重启后,
 * 必须能回答"这笔钱到底付了没有、拿到东西没有、算不算成功"。
 *
 * 幂等: `beginTransaction({requestId})` 命中已有记录 → 直接复用 (不重复付款)。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import {
  event, type TransactionRecord, type TransactionStatus, type InfoItemMetadata,
} from './transaction-protocol.js';
import {
  migrateTransactionRecord, deriveSettlementFact, checkLifecycleMove, canTransitionSettlement, isSettlementFact, hasPaymentEvidence,
  CURRENT_SCHEMA_VERSION, type SettlementFact,
} from './settlement-state.js';
import { sha256Hex } from './paid-info-protocol.js';

/**
 * 由 requestId **确定性派生** 交易 id。
 * 为什么必须确定: 并发两个进程用同一 requestId 时, 随机 id + "标记已创建但内容未写入"的窗口
 * 会让两边各建一条记录 (真跑抓到过: 同一 requestId 落了两条交易)。确定性 id 让"同一 requestId"
 * 物理上只能指向同一个文件, 再用独占创建决定谁写第一份。
 */
export function transactionIdForRequest(requestId: string): string {
  return `tx-${sha256Hex(String(requestId)).slice(0, 12)}`;
}

/** 非法状态迁移 (拒绝写入, 不静默修正) */
export class IllegalTransactionTransition extends Error {
  constructor(public readonly reason: string, public readonly transactionId: string, public readonly target: string) {
    super(`拒绝迁移 ${transactionId} → ${target}: ${reason}`);
    this.name = 'IllegalTransactionTransition';
  }
}

export function transactionsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'transactions');
}

function txPath(id: string, home: string): string {
  return path.join(transactionsDir(home), `${id}.json`);
}

export async function saveTransaction(rec: TransactionRecord, home: string = os.homedir()): Promise<TransactionRecord> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const p = txPath(rec.transactionId, home);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  return rec;
}

export async function readTransaction(id: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  const raw = await readTransactionRaw(id, home);
  if (!raw) return null;
  const migrated = migrateTransactionRecord(raw);
  if (migrated.changed) {
    // 迁移必须可回放: 事件全保留 + 追加一条 migrate-v2; 写回时保留原文件备份
    try {
      const p = txPath(id, home);
      if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-v1`);
      await saveTransaction(migrated.record, home);
    } catch { /* 写不回不影响本次读取结果 */ }
  }
  return migrated.record;
}

async function readTransactionRaw(id: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  try { return JSON.parse(await fsp.readFile(txPath(id, home), 'utf8')) as TransactionRecord; } catch { return null; }
}

export async function listTransactions(home: string = os.homedir()): Promise<TransactionRecord[]> {
  try {
    const files = (await fsp.readdir(transactionsDir(home))).filter((f) => f.startsWith('tx-') && f.endsWith('.json'));
    const out: TransactionRecord[] = [];
    for (const f of files) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(transactionsDir(home), f), 'utf8'))); } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  } catch { return []; }
}

/** 幂等键查找: 同一个 requestId 只允许一笔交易 */
export async function findByRequestId(requestId: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  const all = await listTransactions(home);
  return all.find((t) => t.requestId === requestId) || null;
}

export interface BeginInput {
  requestId: string;
  metadata: Partial<InfoItemMetadata>;
  buyerDid: string;
  providerDid?: string;
  goalId?: string;
  runId?: string;
}

/**
 * 开始/复用一笔交易 (幂等 + **原子认领**)。
 *
 * 2026-09-16 修: 旧实现是"先查再写" —— 两个并发进程会同时看不到记录, 各写一条,
 * 同一个 requestId 出现两笔交易 (真跑并发用例逼出来的)。现在用 O_EXCL 标记文件认领:
 * 只有一个进程能创建记录, 另一个读它的 transactionId 复用。
 */
export async function beginTransaction(input: BeginInput, home: string = os.homedir()): Promise<{ record: TransactionRecord; reused: boolean }> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const id = transactionIdForRequest(input.requestId);

  // ① 确定性 id 已经指向一份记录 → 直接复用 (文件可能正在被写 → 短暂轮询)
  let existing = await readTransaction(id, home);
  for (let i = 0; i < 20 && !existing && fs.existsSync(txPath(id, home)); i++) {
    await new Promise((r) => setTimeout(r, 100));
    existing = await readTransaction(id, home);
  }
  if (existing) return { record: existing, reused: true };

  // ② 兼容历史上用随机 id 落盘的记录: 同一 requestId 有过交易就复用
  const legacy = await findByRequestId(input.requestId, home);
  if (legacy) return { record: legacy, reused: true };

  // ③ 真正没有 → 独占创建 (并发下只有一个能成功; 另一个回到 ①/② 复用)
  const rec: TransactionRecord = {
    transactionId: id,
    requestId: input.requestId,
    itemId: String(input.metadata.itemId || ''),
    buyerDid: input.buyerDid,
    providerDid: input.providerDid || String(input.metadata.providerDid || ''),
    price: input.metadata.price,
    currency: input.metadata.currency,
    network: input.metadata.network,
    payTo: input.metadata.payTo,
    paymentMode: 'none',
    chainSettled: false,
    status: 'discovered',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    settlementFact: 'unpaid',
    goalId: input.goalId,
    runId: input.runId,
    startedAt: new Date().toISOString(),
    events: [event('discovered', `item=${input.metadata.itemId || '?'} requestId=${input.requestId}`)],
  };
  try {
    const fh = await fsp.open(txPath(id, home), 'wx');           // ★ 独占: 并发只有一个成功
    await fh.writeFile(JSON.stringify(rec, null, 2), 'utf8');
    await fh.close();
    return { record: rec, reused: false };
  } catch {
    // 别人抢先创建了 → 等它写完再复用 (绝不覆盖对方已经推进的状态)
    let other = await readTransaction(id, home);
    for (let i = 0; i < 20 && !other; i++) {
      await new Promise((r) => setTimeout(r, 100));
      other = await readTransaction(id, home);
    }
    if (other) return { record: other, reused: true };
    const byReq = await findByRequestId(input.requestId, home);
    if (byReq) return { record: byReq, reused: true };
    return { record: await saveTransaction(rec, home), reused: false };
  }
}

/** 追加事件 + 更新状态 (唯一写路径, 保证 events 有序可回放) */
export async function updateTransaction(
  transactionId: string,
  patch: Partial<TransactionRecord> & { event?: { kind: string; detail?: string } },
  home: string = os.homedir(),
): Promise<TransactionRecord | null> {
  const rec = await readTransaction(transactionId, home);
  if (!rec) return null;
  const { event: ev, ...rest } = patch;

  // ★ Phase 0: 结算事实变化**无条件留痕** (调用方忘了给 event 也不许丢审计)
  const factChanged = rest.settlementFact && String(rest.settlementFact) !== String(rec.settlementFact || '');
  const ev2 = ev || (factChanged ? { kind: `settlement:${rest.settlementFact}`, detail: '结算事实变更 (自动留痕)' } : undefined);

  // ★ Phase 0/4: 迁移必须合法 —— 非法就拒绝 (抛错), 不静默修正。
  //   判定顺序: 先结算事实(它是状态的依据), 再状态; 两者都按**应用 patch 之后**的记录判断
  //   (允许"结算 + 状态"在一次写里原子推进, 例如 fully_settled + verified)。
  if (rest.settlementFact && String(rest.settlementFact) !== String(rec.settlementFact || '')) {
    const from = isSettlementFact(rec.settlementFact) ? String(rec.settlementFact) : deriveSettlementFact(rec);
    const chk = canTransitionSettlement(from, String(rest.settlementFact), {
      paymentMode: rec.paymentMode,
      chainSettled: rec.chainSettled === true || (rest as any).chainSettled === true,
      txHash: String(rec.txHash || (rest as any).txHash || ''),
    });
    if (!chk.ok) throw new IllegalTransactionTransition(chk.reason || '非法结算迁移', transactionId, `fact:${rest.settlementFact}`);
  }
  if (rest.status && String(rest.status) !== String(rec.status)) {
    const effective = (rest.settlementFact ? { ...rec, settlementFact: rest.settlementFact as any } : rec) as TransactionRecord;
    const chk = checkLifecycleMove(effective, String(rest.status));
    if (!chk.ok) throw new IllegalTransactionTransition(chk.reason || '非法迁移', transactionId, String(rest.status));
  }
  const next: TransactionRecord = {
    ...rec,
    ...rest,
    events: ev2 ? [...(rec.events || []), event(ev2.kind, ev2.detail)] : (rec.events || []),
  };
  const saved = await saveTransaction(next, home);
  // ★ 公开观察层: 真实交易活动 → 脉冲事件 (fire-and-forget; 统计失败绝不影响交易主路径)
  try {
    const np: any = await import('../network-pulse.js');
    void np.emitTradePulse(rec, saved, home);
  } catch { /* noop */ }
  return saved;
}

export async function setTransactionStatus(transactionId: string, status: TransactionStatus, detail?: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  return updateTransaction(transactionId, { status, ...(status === 'settled' ? { settledAt: new Date().toISOString() } : {}), ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}), ...(status === 'verified' ? { verifiedAt: new Date().toISOString() } : {}), event: { kind: `status:${status}`, detail } }, home);
}

/**
 * 结算事实的专用写路径 (钱动没动与生命周期分开记; 非法迁移一律拒绝)。
 * `local-dev` 想写 payment_verified/fully_settled 会被这里挡下。
 */
export async function setSettlementFact(
  transactionId: string,
  fact: SettlementFact,
  detail?: string,
  home: string = os.homedir(),
): Promise<TransactionRecord | null> {
  return updateTransaction(transactionId, { settlementFact: fact, event: { kind: `settlement:${fact}`, detail } } as any, home);
}

/** 审计回放 (CLI/Web 用): 一笔交易按时间顺序的完整事件链 */
export async function replayTransaction(transactionId: string, home: string = os.homedir()): Promise<string[]> {
  const rec = await readTransaction(transactionId, home);
  if (!rec) return [];
  return (rec.events || []).map((e) => `${e.at} ${e.kind}${e.detail ? ` — ${e.detail}` : ''}`);
}

/** 未完成交易 (付了钱但没交付/没验真) —— 重启后要能查出来, 不许静静丢掉 */
export async function pendingTransactions(home: string = os.homedir()): Promise<TransactionRecord[]> {
  const all = await listTransactions(home);
  return all.filter((t) => ['payment_required', 'paying', 'settled', 'delivery_failed', 'verification_failed'].includes(t.status));
}

// ── Phase 1: 支付阶段 claim (并发/重启安全) ────────────────────────────────

/** 已经付过钱的终态: **绝不允许**重新进入付款流程 (必须先对账) */
export const PAID_STATUSES = ['paying', 'settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'] as const;

function claimPath(requestId: string, home: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(transactionsDir(home), `.claim-${safe}`);
}

export interface ClaimResult { ok: boolean; reason?: string; holder?: string; record?: TransactionRecord }

/**
 * 抢"这笔 requestId 的付款权" —— 用 O_EXCL 独占创建 claim 文件, 天然跨进程互斥。
 * 两个进程同时用同一个 requestId 时: 只有一个能进入 paying, 另一个复用同一 transactionId。
 */
export async function claimPayment(requestId: string, transactionId: string, home: string = os.homedir()): Promise<ClaimResult> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const existing = await findByRequestId(requestId, home);
  if (existing && (PAID_STATUSES as readonly string[]).includes(existing.status)) {
    // 已经付过 (或正在付/已交付) → 不允许再付一次, 复用同一交易
    return { ok: false, reason: `该 requestId 已有交易处于 ${existing.status} (不允许重复付款)`, record: existing };
  }
  const cp = claimPath(requestId, home);
  try {
    const fh = await fsp.open(cp, 'wx');                      // ★ 独占: 并发只有一个成功
    await fh.writeFile(JSON.stringify({ holder: transactionId, pid: process.pid, at: new Date().toISOString() }), 'utf8');
    await fh.close();
    return { ok: true, holder: transactionId, record: existing || undefined };
  } catch (err: any) {
    // 已被别人持有 → 看看持有者是否还活着 (死了就接管)
    try {
      const info = JSON.parse(await fsp.readFile(cp, 'utf8'));
      const alive = Number(info?.pid) ? isPidAlive(Number(info.pid)) : true;
      if (!alive) {
        await fsp.rm(cp, { force: true });
        const fh = await fsp.open(cp, 'wx');
        await fh.writeFile(JSON.stringify({ holder: transactionId, pid: process.pid, at: new Date().toISOString() }), 'utf8');
        await fh.close();
        return { ok: true, holder: transactionId, record: existing || undefined };
      }
      return { ok: false, reason: `付款权被另一个进程持有 (holder=${info?.holder}, pid=${info?.pid}) → 复用同一交易, 不重复付款`, record: existing || undefined };
    } catch {
      return { ok: false, reason: `无法取得付款权: ${String(err?.message || err).slice(0, 120)}`, record: existing || undefined };
    }
  }
}

export async function releasePaymentClaim(requestId: string, home: string = os.homedir()): Promise<void> {
  await fsp.rm(claimPath(requestId, home), { force: true }).catch(() => {});
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 对账: SIGKILL 之后重启必须先看"钱到底付了没有", 再决定能不能重付。
 *   paying + 无 txHash  → payment_pending (可安全重试: 没证据证明付过)
 *   settled/delivered/verified → 绝不重付, 只恢复交付/验真
 */
export async function reconcilePendingTransactions(home: string = os.homedir()): Promise<{ requeued: string[]; mustNotRepay: string[]; notes: string[] }> {
  const all = await listTransactions(home);
  const requeued: string[] = [];
  const mustNotRepay: string[] = [];
  const notes: string[] = [];
  for (const t of all) {
    const fact = isSettlementFact(t.settlementFact) ? t.settlementFact : deriveSettlementFact(t);
    const evidence = hasPaymentEvidence({ ...t, settlementFact: fact });
    const status = String(t.status);

    // ★ Phase 3: 有支付证据 (或有链上事实) → 一律进 mustNotRepay, 而且要把事实钉死
    if (evidence) {
      mustNotRepay.push(t.transactionId);
      if (fact === 'unknown' || fact === 'payment_submitted') {
        // 有 txHash 就能确认链上结算; 没有就维持"待确认", 继续挂在对账队列
        if (t.txHash) {
          try { await setSettlementFact(t.transactionId, t.chainSettled ? 'payment_verified' : 'payment_verified', '对账: 发现 txHash → 结算事实升级为 payment_verified', home); } catch { /* 非法迁移则保持原值 */ }
          notes.push(`${t.transactionId}: 发现 txHash → payment_verified (不重付)`);
        } else {
          notes.push(`${t.transactionId}: 有支付凭据但没有 txHash → 维持 ${fact}, 需 facilitator 澄清 (不重付)`);
        }
      }
      continue;
    }

    // 没有支付证据的"付款中/待付款" → 允许安全重试 (写清对账依据)
    if (status === 'paying' || status === 'payment_required' || fact === 'unknown') {
      try { await setSettlementFact(t.transactionId, 'unpaid', '对账: 没有支付凭据/txHash → 确认没付过', home); } catch { /* 已是 unpaid 则忽略 */ }
      if (status !== 'payment_required') {
        await updateTransaction(t.transactionId, {
          status: 'payment_required',
          event: { kind: 'reconcile', detail: '重启对账: 没有支付证据 → 允许安全重试' },
        }, home);
      } else {
        await updateTransaction(t.transactionId, { event: { kind: 'reconcile', detail: '重启对账: 仍无支付证据 → 保持 payment_required (可安全重试)' } }, home);
      }
      await releasePaymentClaim(t.requestId, home);
      requeued.push(t.transactionId);
      notes.push(`${t.transactionId}: 无支付证据 → payment_required + unpaid (可安全重试)`);
    }
  }
  return { requeued, mustNotRepay, notes };
}

export async function spentSummary(home: string = os.homedir()): Promise<{ count: number; total: number; byMode: Record<string, number> }> {
  const all = await listTransactions(home);
  let total = 0; const byMode: Record<string, number> = {};
  let count = 0;
  for (const t of all) {
    if (!['settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'].includes(t.status)) continue;
    // 金额只认 amount (原子单位/十进制字符串), 绝不 Number(price 对象)
    const rawAmount = typeof t.amount === 'string' || typeof t.amount === 'number' ? t.amount : undefined;
    const amt = Number(rawAmount ?? 0) || 0;
    total += amt; count++;
    byMode[t.paymentMode] = (byMode[t.paymentMode] || 0) + amt;
  }
  return { count, total, byMode };
}
