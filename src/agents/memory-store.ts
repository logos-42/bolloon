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
import type { EmbeddingAdapter } from '../llm/embedding-adapter.js';
import { cosineSimilarity } from '../llm/embedding-adapter.js';

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
  /** P2: 上次被召回时间 (decay 计算依据; 未召回过 = createdAt) */
  lastRecalledAt?: string;
  /** P2: 已淡化 (decay 后标记, 仍保留不删) */
  decayed?: boolean;
  /** P1: 向量化表示 (adapter 可用时保存; 无则 undefined → 关键词回退) */
  vec?: number[];
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
  /** P1: 查询向量 (adapter 可用时调用方预计算传入; 无 → 关键词回退) */
  queryVec?: number[];
  /** P1: 条目向量优先级阈值 (cosine < 此值的不算命中, 默认 0) */
  minCosine?: number;
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

export interface DecayOptions {
  /** 多少天未召回视为「长期未用」 (默认 30) */
  days?: number;
  /** 淡化后的 importance 乘子 (默认 0.5) */
  factor?: number;
}

/**
 * P2: 价值衰减 (decay) — 长期未被召回的条目降权标记, 不删除。
 * 规则:
 *   - 固化条目 (crystallized) 豁免 (用户确认过/多次命中, 不淡忘)
 *   - 从 lastRecalledAt (未召回过 = createdAt) 起算, 超过 days 天 → decayed=true + importance×factor
 *   - 被召回 → decayed 撤销 (recall 里已处理)
 * 纯函数: 不改 entry, 返回更新后的副本 (无变化返回原引用)。
 */
export function applyDecay(entry: MemoryEntry, nowIso: string, opts: DecayOptions = {}): MemoryEntry {
  if (entry.crystallized) return entry; // 固化豁免
  const days = opts.days ?? 30;
  const factor = opts.factor ?? 0.5;
  const base = entry.lastRecalledAt || entry.createdAt;
  const ms = Date.parse(nowIso) - Date.parse(base);
  if (!Number.isFinite(ms) || ms < 0) return entry;
  const elapsedDays = ms / 86_400_000;
  if (elapsedDays < days) return entry;
  // 幂等: 已淡化过就不再重复降 (decayed 标记本身是终态)
  if (entry.decayed) return entry;
  return {
    ...entry,
    importance: Math.max(0.05, entry.importance * factor),
    decayed: true,
    updatedAt: nowIso,
  };
}

/** P2: 全库跑一次 decay, 返回被淡化条数 (未调用过 save/recall 的旧条目也会被标) */
export function decayAll(entries: Map<string, MemoryEntry>, nowIso: string, opts: DecayOptions = {}): number {
  let n = 0;
  for (const [id, e] of entries) {
    const after = applyDecay(e, nowIso, opts);
    if (after !== e) {
      entries.set(id, after);
      n++;
    }
  }
  return n;
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

  async save(input: MemorySaveInput, adapter?: EmbeddingAdapter): Promise<MemoryEntry> {
    const content = String(input.content || '').trim();
    if (!validContent(content)) throw new Error('记忆内容太短 (至少 2 个字符)');
    const now = new Date().toISOString();
    const id = createHash('sha256').update(`${this.agentId}|${content}`).digest('hex').slice(0, 32);
    const existing = this.entries.get(id);
    let vec: number[] | undefined = existing?.vec;
    if (adapter && adapter.provider !== 'none') {
      try {
        vec = await adapter.embed(content); // 内容变 → 重算; 内容同 → 复用旧向量
      } catch {
        // 向量化失败不阻塞保存 (记忆仍存, 召回走关键词)
      }
    }
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
      lastRecalledAt: existing?.lastRecalledAt,
      decayed: existing?.decayed,
      vec,
    };
    this.entries.set(id, entry);
    await this.persist();
    return entry;
  }

  /**
   * 召回:
   *   - queryVec 提供 且 条目有 vec → cosine 相似度 (语义召回), 按 importance 加权
   *   - 否则 → 关键词命中 (P0 行为), 完全兼容旧调用
   * 命中后 recallCount++ 并落盘 (动态升权)
   */
  async recall(opts: MemoryRecallOptions): Promise<MemoryRecallHit[]> {
    if (this.entries.size === 0) return [];
    const limit = opts.limit || 3;
    const hits: MemoryRecallHit[] = [];

    const qv = opts.queryVec;
    const useVec = !!qv && qv.length > 0;
    if (useVec) {
      const minCosine = opts.minCosine ?? 0;
      for (const e of this.entries.values()) {
        if (!e.vec || e.vec.length !== qv!.length) continue; // 无向量的旧条目跳过
        const c = cosineSimilarity(qv!, e.vec);
        if (c < minCosine) continue;
        const weighted = c * (0.4 + 0.6 * e.importance); // importance 加权
        if (weighted > 0) hits.push({ entry: e, score: weighted });
      }
    } else {
      const tokens = tokenize(opts.query);
      if (tokens.length === 0) return [];
      const minScore = opts.minScore ?? 0;
      for (const e of this.entries.values()) {
        const s = scoreText(e.content, tokens);
        if (s <= minScore) continue;
        const weighted = Math.min(5, s) * (0.4 + 0.6 * e.importance); // importance 加权
        hits.push({ entry: e, score: weighted });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    // 命中 → recallCount++ + lastRecalledAt 刷新 (动态升权 / decay 重置), 每 10 次 importance +0.05
    if (top.length > 0) {
      const nowIso = new Date().toISOString();
      let changed = false;
      for (const h of top) {
        h.entry.recallCount++;
        h.entry.lastRecalledAt = nowIso;
        if (h.entry.decayed) h.entry.decayed = false; // 被召回 → 淡化撤销
        if (h.entry.recallCount % 10 === 0 && h.entry.importance < 1) {
          h.entry.importance = Math.min(1, h.entry.importance + 0.05);
        }
        changed = true;
      }
      if (changed) await this.persist().catch(() => { /* 计数写失败不阻塞召回 */ });
    }
    return top;
  }

  /** P2: 固化 — 多次召回或用户确认后调用; crystallized=true (进 08-Insights 由调用方负责) */
  async crystallize(id: string): Promise<MemoryEntry | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    const changed = !e.crystallized;
    e.crystallized = true;
    e.importance = Math.min(1, e.importance + 0.1); // 固化 → importance 加成
    e.updatedAt = new Date().toISOString();
    if (changed) await this.persist();
    return e;
  }

  /** P2: 自动固化阈值 — 召回 ≥ 5 次且 importance ≥ 0.6 的条目 (recall 后可调用, 返回新固化条数) */
  async autoCrystallize(): Promise<number> {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.crystallized && e.recallCount >= 5 && e.importance >= 0.6) {
        e.crystallized = true;
        e.importance = Math.min(1, e.importance + 0.1);
        e.updatedAt = new Date().toISOString();
        n++;
      }
    }
    if (n > 0) await this.persist();
    return n;
  }

  /** P2: 统计 (decay 标定 / 审计用) */
  stats(): { total: number; crystallized: number; decayed: number } {
    let crystallized = 0;
    let decayed = 0;
    for (const e of this.entries.values()) {
      if (e.crystallized) crystallized++;
      if (e.decayed) decayed++;
    }
    return { total: this.entries.size, crystallized, decayed };
  }

  /**
   * P3: 合并远端条目 (OrbitDB 拉回的) 到本地, LWW (updatedAt 大者胜)。
   * 返回被采纳的远端条数; 有采纳则落盘。同步前本地必须先 load()。
   */
  async mergeRemote(remote: MemoryEntry[]): Promise<number> {
    let n = 0;
    for (const r of remote) {
      if (!r || !r.id || r.agentId !== this.agentId) continue; // 归属校验: 只合并本 agent
      const l = this.entries.get(r.id);
      if (!l) {
        this.entries.set(r.id, r);
        n++;
      } else if (r.updatedAt > l.updatedAt) {
        this.entries.set(r.id, r);
        n++;
      }
      // 平手 / 本地更新 → 本地胜 (LWW)
    }
    if (n > 0) await this.persist();
    return n;
  }

  /** P3: 导出一份「可在其他节点重建」的条目快照 (不含运行时计数, 只含持久事实) */
  exportEntries(): MemoryEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, vec: undefined })); // vec 不跨节点 (维度依赖 adapter)
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