/**
 * input-history.ts — 输入历史落盘 (leo 2026-09-30: 「输入历史有落盘文件夹吗，要实现一下」)
 *
 * 之前: 历史只在内存 (`ink-app.tsx` 的 historyRef, 上限 100, **重启即失**)。
 * 现在: 落 `~/.bolloon/history/`, **一渠道一文件** `input-<channelId>.jsonl` (0600) ——
 *   渠道隔离 (不同 agent/channel 的输入不该互相串), 重启后 ↑ 还能翻出来。
 *
 * 四条纪律:
 *   1. **秘密不入历史** —— 64 位 hex 私钥 / `privateKey` / 助记词形态 (12+ 个小写词) 一律不写盘。
 *      输入历史是纯文本、会被翻出来、也可能被贴出去; 钱包助记词进去就是事故。
 *   2. **不打断输入** —— 落盘失败只记日志 (console.error), 绝不让打字报错。
 *   3. **去重** —— 连续重复的同一行不重复写 (↑ 翻起来不烦)。
 *   4. **有上限** —— 内存 200 / 文件 500 (超了重写成最后 500, 原子写)。
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** 内存里最多留多少条 (CLI 进程内) */
export const MEMORY_CAP = 200;
/** 文件里最多留多少条 (超了裁剪) */
export const FILE_CAP = 500;

let scope = 'default';
/** 由 CLI 在切渠道时调用 (index.ts), 决定写哪个文件 */
export function setHistoryScope(channel?: string | null): void {
  scope = sanitizeChannel(channel) || 'default';
}
export function historyScope(): string { return scope; }

function sanitizeChannel(channel?: string | null): string {
  return String(channel || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
}

export function historyDir(): string {
  return path.join(process.env.HOME || '/tmp', '.bolloon', 'history');
}

export function historyFile(channel?: string | null): string {
  const ch = sanitizeChannel(channel) || scope || 'default';
  return path.join(historyDir(), `input-${ch}.jsonl`);
}

/**
 * 看着像秘密的输入 —— **不写历史**。
 * 判据刻意保守 (宁可漏存一条普通输入, 也不能把私钥/助记词写进历史文件):
 *   · 64 位 hex (可带 0x) / 40 位 hex 地址不拦 (地址是公开的)
 *   · 出现 privateKey / private_key / mnemonic / 助记词 字样
 *   · 12 个以上连续小写单词 (助记词形态)
 */
export function looksSecret(line: string): boolean {
  const s = String(line || '');
  if (/0x[0-9a-fA-F]{64}\b/.test(s)) return true;
  if (/\b(privateKey|private_key|mnemonic|助记词|seedPhrase|seed_phrase)\b/i.test(s)) return true;
  // 助记词形态: 整行 (去掉常见前缀/标点) 是 12/15/18/21/24 个小写词
  const words = s.replace(/^[^A-Za-z]*/, '').trim().split(/\s+/);
  if (words.length >= 12 && words.length <= 30 && words.every(w => /^[a-z]{3,8}$/.test(w))) return true;
  return false;
}

/** 读历史 (新→旧? 不, 这里按**旧→新**返回: 与内存数组同序, ↑ 取最后一条) */
export async function loadInputHistory(channel?: string | null): Promise<string[]> {
  try {
    const text = await fs.readFile(historyFile(channel), 'utf-8');
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const v = JSON.parse(line);
        if (typeof v === 'string' && v.trim()) out.push(v);
      } catch { /* 坏行跳过 (历史坏了不该让 CLI 起不来) */ }
    }
    return out.slice(-MEMORY_CAP);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    console.error(`[input-history] 读不了 ${historyFile(channel)}: ${String(e?.message || e).slice(0, 120)}`);
    return [];
  }
}

/**
 * 追加一条 (去重: 与最后一条相同则不写)。
 * 返回 true = 真写了; false = 跳过了 (秘密/空/重复) —— 调用方可以据此决定是否提示。
 */
export async function appendInputHistory(line: string, channel?: string | null): Promise<boolean> {
  const v = String(line || '').trim();
  if (!v) return false;
  if (looksSecret(v)) {
    console.error(`[input-history] 这行看着像密钥/助记词, **不写历史** (长度 ${v.length})`);
    return false;
  }
  const file = historyFile(channel);
  try {
    await fs.mkdir(historyDir(), { recursive: true });
    // 去重: 看最后一条
    const existing = await loadInputHistory(channel);
    if (existing.length && existing[existing.length - 1] === v) return false;
    await fs.appendFile(file, JSON.stringify(v) + '\n', { encoding: 'utf-8', mode: 0o600 });
    try { await fs.chmod(file, 0o600); } catch { /* 已足够 */ }
    if (existing.length + 1 > FILE_CAP + 300) {
      // 裁剪: 原子重写成最后 FILE_CAP 条
      const kept = [...existing, v].slice(-FILE_CAP);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, kept.map(x => JSON.stringify(x) + '\n').join(''), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tmp, file);
    }
    return true;
  } catch (e: any) {
    // 不打断输入: 只记日志
    console.error(`[input-history] 写不了 ${file}: ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}
