/**
 * 后台委派的结果回灌 (2026-10-01, 用户: 「开展子智能体后，bolloon 没有回归」+「还是卡住了，学 hermes」)。
 *
 * 学的是"**起完就走, 结果自己回来**"这个形态:
 *   起委派 ⇒ 立刻返回(带 session id ✓) ⇒ 父智能体继续干别的 ✓ ⇒ 它跑完后, 结果作为**一行提示**注入下一轮 ✓。
 * 判据性质: 只对"我起的后台委派"发提示(命令里带标记 ✓) · **同一条只提示一次**(落盘记号 ✓) · 未跑完/已提示过 ⇒ 不提 ✓。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions } from './process-runner.js';

/** 起后台委派时在命令前加的环境标记 ⇒ 便于识别"这是我起的委派" */
export const DELEGATE_ENV_MARK = 'BOLLOON_DELEGATE=1';

export function noticesPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'delegate-notices.json');
}

function loadNoticed(home?: string): Record<string, number> {
  try {
    const raw = fs.readFileSync(noticesPath(home), 'utf-8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveNoticed(map: Record<string, number>, home?: string): void {
  try {
    const p = noticesPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(map), { mode: 0o600 });
  } catch {
    /* best-effort: 提示记不下来最多重复一次, 不该打断主流程 */
  }
}

/** 收集"已完成、且还没提示过"的后台委派, 每个一条中文提示; 同时落盘记号(只提示一次 ✓) */
export function collectDelegateNotices(
  home?: string,
  /** 便于门注入假 session(默认读真实的 ✓) */
  injected?: Array<{ id: string; cmd: string; status: string; exitCode: number | null }>
): string[] {
  let sessions: Array<{ id: string; cmd: string; status: string; exitCode: number | null }> = [];
  if (injected) sessions = injected;
  else { try { sessions = listSessions(); } catch { return []; } }
  const noticed = loadNoticed(home);
  const lines: string[] = [];
  let changed = false;
  for (const s of sessions) {
    if (!String(s.cmd || '').includes(DELEGATE_ENV_MARK)) continue;   // 只认我起的委派
    if (s.status === 'running') continue;                            // 还没跑完 ⇒ 不提
    if (noticed[s.id]) continue;                                     // 提过 ⇒ 不提
    const how = s.status === 'exited' ? `退出码 ${s.exitCode ?? 0}` : `状态 ${s.status}`;
    lines.push(`[后台委派完成] session ${s.id} · ${how} —— 结果用 \`process poll ${s.id}\` 取; 若已达成目标就继续下一步, 别重发同样的委派。`);
    noticed[s.id] = Date.now();
    changed = true;
  }
  if (changed) saveNoticed(noticed, home);
  return lines;
}

/** 拼成一段(没有就返回空串 ✓) */
export function renderDelegateNotices(home?: string): string {
  const lines = collectDelegateNotices(home);
  return lines.length ? lines.join('\n') : '';
}

/**
 * 通用"待回流"队列 (2026-10-01, 学 async_delegation 的形态)。
 * 形态要点(照抄口径, 不抄实现): 后台产物 ⇒ 投进一个**共享队列** ⇒ 前台**空闲时排空** ⇒
 *   以**新一轮**浮现(**绝不中途插队**)✓; 同一条只浮现一次(落盘记号 ✓); 排空失败不打断主流程 ✓。
 * 用途: 后台委派完成 ✓ · 复盘产出教训(可回流成下一轮的任务源 ✓)。
 */
export interface PendingNotice { kind: 'delegate' | 'review'; text: string; at: number }

export function noticesQueuePath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'notices-queue.jsonl');
}

/** 投递一条(后台线程/异步回调都能安全调 ✓; 失败只吞不抛 ✓) */
export function pushNotice(kind: PendingNotice['kind'], text: string, home: string = os.homedir()): void {
  try {
    const p = noticesQueuePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ kind, text, at: Date.now() } satisfies PendingNotice) + '\n');
  } catch { /* 丢一条提示不该打断主流程 */ }
}

/** 空闲时排空(读走即清空 ✓): 返回"上一轮之后攒下的"通知, 供本轮开头一次性交代 ✓ */
export function drainNotices(home: string = os.homedir()): PendingNotice[] {
  const p = noticesQueuePath(home);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return []; }
  const out: PendingNotice[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.text === 'string' && (o.kind === 'delegate' || o.kind === 'review')) out.push(o as PendingNotice);
    } catch { /* 坏行跳过 */ }
  }
  try { fs.writeFileSync(p, '', { mode: 0o600 }); } catch { /* 清空失败 ⇒ 下轮可能重复一次, 可接受 */ }
  return out;
}

/** 拼成一段"任务源块"(自包含 ✓: 说明是什么 + 现在该做什么 + 别重复) */
export function renderNoticeBlock(home: string = os.homedir()): string {
  const items = drainNotices(home);
  if (!items.length) return '';
  const lines = items.map((n) => n.kind === 'review'
    ? `- [复盘产出] ${n.text}\n  ⇒ 若它意味着要**改代码/改技能**, 现在就把这一步做掉(别只记下来); 若只是知识, 说明它已入库即可。`
    : `- [后台任务完成] ${n.text}`);
  return `【后台回流 · 这是新一轮】上一轮之后攒下 ${items.length} 条, 请在本轮一并处理:\n${lines.join('\n')}`;
}
