/**
 * memory-store.ts — 结构化记忆条目 (P0, 2026-10-14, decentralized-memory-design §2)
 *
 * 与 memory-recall.ts (会话摘要召回) 互补: 摘要文件是「整段会话的压缩」,
 * 这里是「结构化单条记忆」—— kind / importance / refs 证据链, 可单独召回/删除/固化。
 *
 * P0 范围 (小步, 零新依赖):
 *   - MemoryEntry 模型 + 原子 JSONL 持久化 (~/.bolloon/memory/<agentId>/entries.jsonl)
 *   - save (自动 importance 启发式打分) / recall (关键词 + importance 加权) / remove
 *   - 无 embedding (P1 接), 无 OrbitDB 复制 (P3 接)
 *
 * 借鉴 Hermes (decentralized-memory-design §1.5):
 *   - 写入落盘, prompt 注入走「每轮召回」快照, 不实时重建 (冻结快照 ≠ 实时写)
 *   - 条目摘要进上下文, 全文按需拉取 (progressive disclosure)
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';

export type MemoryKind = 'fact' | 'insight' | 'preference' | 'event' | 'relationship' | 'skill-feedback';

export interface MemoryEntry {
  id: string;                // sha256(agentId + content)
  agentId: string;
  content: string;           // 结构化后的记忆文本 (用户原话/事实/偏好)
  kind: MemoryKind;
  importance: number;        // 0-1, 启发式打分 (长度/关键词/手动)
  createdAt: string;         // ISO
  updatedAt: string;
  source: string;            // 'session' | 'manual' | 'tool'
  refs: string[];            // goalId/runId 证据链
  crystallized: boolean;     // 固化 (多次召回/用户确认 → true)
  recallCount: number;       // 被召回次数 (importance 动态升的依据)
}

export interface MemorySaveInput {
  content: string;
  kind?: MemoryKind;
  importance?: number;       // 手动覆盖 (0-1); 缺省启发式
  source?: string;
  refs?: string[];
}

export interface MemoryRecallHit {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryRecallOptions {
  query: string;
  limit?: number;            // 默认 3
  minScore?: number;         // 默认 0 (有命中即算)
}

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export function memoryEntriesPath(agentId: string, homeDir?: string): string {
  const base = homeDir || home();
  return path.join(base, '.bolloon', 'memory', agentId, 'entries.jsonl');
}

/** 空内容/纯空白 → 拒绝存 (与 evaluateQuality 同口径: 空串不是记忆) */
function validContent(content: string): boolean {
  return String(content || '').trim().length >= 2;
}

/** importance 启发式: 长度 + 特定信号词 (P0 无 LLM 打分, 不引依赖) */
export function heuristicImportance(content: string, kind: MemoryKind = 'fact', manual?: number): number {
  if (typeof manual === 'number') return Math.min(1, Math.max(0, manual));
  const t = String(content || '');
  let score = 0.3; // 基线
  if (t.length > 100) score += 0.2;       // 长记忆 = 更可能是重要细节
  if (/喜欢|偏好|讨厌|禁止|必须|永远|从不|重要|注意|记住|约定/.test(t)) score += 0.25; // 用户强语义
  if (kind === 'preference' || kind === 'relationship') score += 0.2;
  if (kind === 'skill-feedback') score += 0.15;
  return Math.min(1, score);
}

/** 关键词提取 (与 memory-recall.tokenizeQuery 同口径: 中文 2-gram + 英文分词) */
function tokenize(text: string): string[] {
  const clean = String(text || '').toLowerCase().trim();
  if (!clean) return [];
  const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '在', '和', '与', '吗', '呢', '吧', '这', '那', '个', '请', '帮', '一下', '一个', '怎么', '如何', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'for', 'and']);
  const out: string[] = [];
  // 英文词
  for (const w of clean.match(/[a-z][a-z0-9_]+/g) || []) {
    if (!STOP.has(w)) out.push(w);
  }
  // 中文 2-gram
  const cjk = (clean.match(/[\u4e00-\u9fff]+/g) || []).join('');
  for (let i = 0; i < cjk.length - 1; i++) {
    const g = cjk.slice(i, i + 2);
    if (!STOP.has(g)) out.push(g);
  }
  return out;
}

/** 词 → 分数 (词面命中 1 + 干净长词加权, 不引 TF-IDF, P1 换向量) */
function scoreText(text: string, tokens: string[]): number {
  const t = String(text || '').toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) score += tok.length >= 4 ? 1.2 : 1;
  }
  return score;
}

/**
 * MemoryStore — 单 agent 的结构化记忆 (每实例对应一个 agentId, 不跨 agent)
 *
 * 文件锁: fcntl 不可用 (Windows) 时退化为无锁 (与 Hermes 同思路, 原子 rename 兜底)。
 * 防并发写坏: 写入 → tmp 文件 → rename 原子替换。
 */
export class MemoryStore {
  private readonly agentId: string;
  private readonly file: string;
  private entries: Map<string, MemoryEntry> = new Map();

  constructor(agentId: string, homeDir?: string) {
    this.agentId = agentId;
    this.file = memoryEntriesPath(agentId, homeDir);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.entries.clear();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as MemoryEntry;
          if (e?.id) this.entries.set(e.id, e);
        } catch { /* 单行损坏跳过 (append-only, 不整文件作废) */ }
      }
    } catch { /* 文件不存在 = 空记忆 */ }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const lines = [...this.entries.values()].map((e) => JSON.stringify(e));
    await fs.writeFile(tmp, lines.join('\n') + (lines.length ? '\n' : ''));
    await fs.rename(tmp, this.file); // 原子替换, 并发读不碰半截文件
  }

  async save(input: MemorySaveInput): Promise<MemoryEntry> {
    const content = String(input.content || '').trim();
    if (!validContent(content)) throw new Error('记忆内容太短 (至少 2 个字符)');
    const now = new Date().toISOString();
    const id = createHash('sha256').update(`${this.agentId}|${content}`).digest('hex').slice(0, 32);
    const existing = this.entries.get(id);
    const entry: MemoryEntry = {
      id,
      agentId: this.agentId,
      content,
      kind: input.kind || existing?.kind || 'fact',
      importance: heuristicImportance(content, input.kind || existing?.kind, input.importance),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      source: input.source || existing?.source || 'manual',
      refs: input.refs || existing?.refs || [],
      crystallized: existing?.crystallized || false,
      recallCount: existing?.recallCount || 0,
    };
    this.entries.set(id, entry);
    await this.persist();
    return entry;
  }

  /** 召回: 关键词命中 + importance 加权; 命中后 recallCount++ 并落盘 (动态升权) */
  async recall(opts: MemoryRecallOptions): Promise<MemoryRecallHit[]> {
    const tokens = tokenize(opts.query);
    if (tokens.length === 0 || this.entries.size === 0) return [];
    const limit = opts.limit || 3;
    const minScore = opts.minScore ?? 0;
    const hits: MemoryRecallHit[] = [];
    for (const e of this.entries.values()) {
      const s = scoreText(e.content, tokens);
      if (s <= minScore) continue;
      const weighted = Math.min(5, s) * (0.4 + 0.6 * e.importance); // importance 加权
      hits.push({ entry: e, score: weighted });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    // 命中 → recallCount++ (动态升权), 每 10 次 importance +0.05
    if (top.length > 0) {
      let changed = false;
      for (const h of top) {
        h.entry.recallCount++;
        if (h.entry.recallCount % 10 === 0 && h.entry.importance < 1) {
          h.entry.importance = Math.min(1, h.entry.importance + 0.05);
        }
        changed = true;
      }
      if (changed) await this.persist().catch(() => { /* 计数写失败不阻塞召回 */ });
    }
    return top;
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async list(limit = 50): Promise<MemoryEntry[]> {
    return [...this.entries.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}

/** 单例 (per-agent 分桶, 与 getContextStore 同模式); 测试可传 homeDir */
const stores = new Map<string, MemoryStore>();
export function getMemoryStore(agentId: string, homeDir?: string): MemoryStore {
  const key = `${homeDir || home()}|${agentId}`;
  let s = stores.get(key);
  if (!s) {
    s = new MemoryStore(agentId, homeDir);
    stores.set(key, s);
  }
  return s;
}

/** 召回 → 拼注入文本 (progressive disclosure: 只带摘要级内容 + id, 全文按需 load) */
export function formatRecallBlock(hits: MemoryRecallHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h, i) => {
    const e = h.entry;
    const tag = `${e.kind}${e.crystallized ? '★' : ''}`;
    return `[${i + 1}] (${tag}, 权重 ${e.importance.toFixed(2)}) ${e.content.slice(0, 200)}`;
  });
  return `<memory-context>\n${lines.join('\n')}\n</memory-context>`;
}

/** 测试辅助: 清空分桶 (隔离 HOME 时用) */
export function resetMemoryStores(): void {
  stores.clear();
}