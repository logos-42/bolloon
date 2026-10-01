/**
 * 技能账本 + 单条回滚 + 写来源隔离 (2026-10-01, 按"账本而非闸门"的形态做)。
 *
 * 三件事:
 *  ① **账本**: 每次技能变更追加一条 JSONL(前后清单 + 内容寻址备份)⇒ 可单条回滚 ✓。
 *     放 JSONL 不放数据库: 耐久 · 可 grep · 数据库重置也不丢 ✓。
 *  ② **单条回滚**: 按 id 还原那一次变更; **唯独回滚是 fail-closed** ✓(安全快照拿不到就拒绝回滚,
 *     绝不"半还原"✗); 其余全部吞错只记日志(账本坏掉不该挡住干活 ✓)。
 *  ③ **写来源隔离**: 用 AsyncLocalStorage 区分"用户点名要的写"(foreground ✓)与
 *     "自审/复盘产生的写"(review ✓)⇒ 自审**只许治理自己造出来的技能** ✓, 用户要的归用户 ✓。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type WriteOrigin = 'foreground' | 'review';

const originStore = new AsyncLocalStorage<{ origin: WriteOrigin }>();

/** 在"自审"上下文里跑一段(其余一律按 foreground ✓) */
export function runWithWriteOrigin<T>(origin: WriteOrigin, fn: () => T): T {
  return originStore.run({ origin }, fn);
}
export function currentWriteOrigin(): WriteOrigin {
  return originStore.getStore()?.origin ?? 'foreground';
}
export function isReviewWrite(): boolean {
  return currentWriteOrigin() === 'review';
}

export function ledgerPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills', '.skill-ledger.jsonl');
}
export function blobsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills', '.ledger-blobs');
}

export interface LedgerEntry {
  id: string;
  at: number;
  origin: WriteOrigin;
  tool: string;                 // create_skill / update_skill / rollback
  skill: string;                // 技能名
  file: string;                 // 技能文件绝对路径
  beforeSha?: string;           // 变更前内容哈希(blobs 里可取回 ✓)
  afterSha?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  note?: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 把内容按哈希存进 blobs(已存在则复用 ✓ 天然去重) */
function putBlob(text: string, home?: string): string {
  const h = sha256(text);
  const p = path.join(blobsDir(home), h);
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, { mode: 0o600 });
    }
  } catch { /* 备份失败 ⇒ 由调用方决定是否允许这次变更(见 captureBefore) */ }
  return h;
}

/** 变更前快照: 返回 beforeSha(拿不到安全快照时返回 undefined ⇒ 回滚能力缺失, 调用方须知道 ✓) */
export function captureSkillBefore(file: string, home?: string): { beforeSha?: string; bytesBefore?: number } {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return { beforeSha: putBlob(text, home), bytesBefore: text.length };
  } catch {
    return {};   // 文件不存在(新建)= 正常; 读不到 = 快照缺失
  }
}

/** 追加一条账本(吞错只记日志 ✓ —— 账本坏掉不该挡住干活) */
export function appendLedger(entry: Omit<LedgerEntry, 'id' | 'at'> & { id?: string; at?: number }, home?: string): LedgerEntry {
  const full: LedgerEntry = { id: entry.id || crypto.randomBytes(8).toString('hex'), at: entry.at ?? Date.now(), ...entry } as LedgerEntry;
  try {
    const p = ledgerPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(full) + '\n', { mode: 0o600 });
  } catch { /* telemetry, not a gate */ }
  return full;
}

export function readLedger(home?: string): LedgerEntry[] {
  try {
    const raw = fs.readFileSync(ledgerPath(home), 'utf-8');
    const out: LedgerEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}

/** 这个技能是不是"自审造出来的"?(决定自审有没有资格改它 ✓) */
export function isAgentCreated(skill: string, home?: string): boolean {
  return readLedger(home).some((e) => e.skill === skill && e.tool === 'create_skill' && e.origin === 'review');
}

/**
 * 自审写前的资格检查(只读判断, 不改任何东西 ✓):
 * 自审只许动**自己造出来**的技能 ✓; 用户点名要的归用户 ✓。
 */
export function reviewMayTouch(skill: string, home?: string): { ok: boolean; reason: string } {
  if (!isReviewWrite()) return { ok: true, reason: 'foreground(用户点名要的写)' };
  return isAgentCreated(skill, home)
    ? { ok: true, reason: 'review(该技能由自审创建, 可治理)' }
    : { ok: false, reason: '该技能不是自审创建的(用户点名要的归用户)⇒ 自审只记候选, 不动它' };
}

/**
 * 单条回滚: 把某次变更前的快照还原回去 ✓。
 * **fail-closed**: 快照缺失/内容哈希对不上 ⇒ 拒绝(绝不半还原 ✗)。
 */
export function rollbackEntry(id: string, home?: string): { ok: boolean; reason: string; restored?: string } {
  const entry = readLedger(home).find((e) => e.id === id);
  if (!entry) return { ok: false, reason: `账本里没有 id=${id}` };
  if (entry.tool === 'create_skill') {
    // 创建类变更: 回滚 = 删掉那个文件(要用户明确同意 ⇒ 这里只报告, 不擅自删 ✗)
    return { ok: false, reason: '该条是"新建技能"; 回滚等于删除文件 —— 需要你明确同意, 我不擅自删' };
  }
  if (!entry.beforeSha) return { ok: false, reason: '该条没有变更前快照 ⇒ 拒绝回滚(fail-closed, 不做半还原)' };
  try {
    const blob = fs.readFileSync(path.join(blobsDir(home), entry.beforeSha), 'utf-8');
    if (sha256(blob) !== entry.beforeSha) return { ok: false, reason: '快照内容与哈希不符 ⇒ 拒绝回滚' };
    fs.writeFileSync(entry.file, blob, { mode: 0o600 });
    appendLedger({ origin: 'foreground', tool: 'rollback', skill: entry.skill, file: entry.file, beforeSha: entry.afterSha, afterSha: entry.beforeSha, note: `回到 ${entry.id}` }, home);
    return { ok: true, reason: `已回滚到变更前(${entry.id})`, restored: entry.file };
  } catch (e) {
    return { ok: false, reason: `回滚失败: ${String((e as Error)?.message || e).slice(0, 120)}` };
  }
}
