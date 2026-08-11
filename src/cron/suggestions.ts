/**
 * suggestions.ts — 轻量建议队列 (sticky-note suggestions)
 *
 * 借鉴 Hermes agent cron/suggestions.py + suggestion_catalog.py 心智:
 *   - 建议是一个个"待办/提醒/下一动作", 由调度器/策略/系统在合适的时机塞入
 *   - 同一 dedup_key 只保留最新的一个 (避免同一提醒重复刷屏)
 *   - MAX_PENDING 上限, 超出自动丢最旧的 (队列有界, 不无限膨胀)
 *   - 用户可接受 (accept) / 忽略 (dismiss) / 全部清空 (clear)
 *   - 每个 suggestion 记住来源 (source) / 摘要 (summary) / 到期 (dueAt?, 可选)
 *   - 落盘 ~/.bolloon/suggestions.json, 进程内互斥链序列化 (对齐 server-storage)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export const MAX_PENDING = 5; // 借鉴 hermes: 建议队列有界, 最长该数

export interface Suggestion {
  id: string;
  dedupKey: string;
  summary: string;
  source: string; // 'schedule' | 'strategy' | 'system' | 'user'
  relatedTaskId?: string;
  dueAt?: string; // ISO; 可选到期提醒
  createdAt: string;
}

interface SuggestionFile {
  version: 1;
  items: Suggestion[];
}

function getSuggestionsPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'suggestions.json');
}

// 进程内互斥链: 所有写操作串行, 失败不毒化链 (对齐 server-storage 的 updateChannels 设计)
let suggestionsLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = suggestionsLock.then(fn);
  suggestionsLock = run.then(() => undefined, () => undefined);
  return run;
}

async function readAll(home: string): Promise<SuggestionFile> {
  try {
    const raw = await fs.readFile(getSuggestionsPath(home), 'utf-8');
    const parsed = JSON.parse(raw) as SuggestionFile;
    if (parsed?.version === 1 && Array.isArray(parsed.items)) return parsed;
    return { version: 1, items: [] };
  } catch {
    return { version: 1, items: [] };
  }
}

async function writeAll(file: SuggestionFile, home: string): Promise<void> {
  const p = getSuggestionsPath(home);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // 原子写: 先写临时文件再 rename, 避免半截 JSON (对齐 plan-store 直接重写该校验线)
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

/**
 * 添加一条建议. 同一 dedupKey 已存在 → 更新其 summary/来源, 并重置插入到队尾; 不超过 MAX_PENDING.
 * @returns 新构建 (或更新后) 的 suggestion
 */
export async function addSuggestion(
  input: { dedupKey: string; summary: string; source: Suggestion['source']; relatedTaskId?: string; dueAt?: string },
  home: string = os.homedir(),
): Promise<Suggestion> {
  return withLock(async () => {
    const file = await readAll(home);
    const existing = file.items.find((s) => s.dedupKey === input.dedupKey);
    const now = new Date().toISOString();
    const entry: Suggestion = {
      id: existing?.id ?? crypto.randomUUID(),
      dedupKey: input.dedupKey,
      summary: input.summary,
      source: input.source,
      relatedTaskId: input.relatedTaskId,
      createdAt: existing?.createdAt ?? now,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    };
    file.items = file.items.filter((s) => s.dedupKey !== input.dedupKey);
    file.items.push(entry);
    while (file.items.length > MAX_PENDING) file.items.shift(); // 丢最旧的
    await writeAll(file, home);
    return entry;
  });
}

/** 全部未完成建议 */
export async function listSuggestions(home: string = os.homedir()): Promise<Suggestion[]> {
  return withLock(async () => (await readAll(home)).items);
}

/** 接受: 从队列移除并返回它 (调用方可据此做后续动作, 如转成 task) */
export async function acceptSuggestion(id: string, home: string = os.homedir()): Promise<Suggestion | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const idx = file.items.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    const [removed] = file.items.splice(idx, 1);
    await writeAll(file, home);
    return removed;
  });
}

/** 忽略: 从队列移除 */
export async function dismissSuggestion(id: string, home: string = os.homedir()): Promise<boolean> {
  return withLock(async () => {
    const file = await readAll(home);
    const before = file.items.length;
    file.items = file.items.filter((s) => s.id !== id);
    if (file.items.length === before) return false;
    await writeAll(file, home);
    return true;
  });
}

/** 全部清空 */
export async function clearSuggestions(home: string = os.homedir()): Promise<number> {
  return withLock(async () => {
    const file = await readAll(home);
    const n = file.items.length;
    file.items = [];
    await writeAll(file, home);
    return n;
  });
}