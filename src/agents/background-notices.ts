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
