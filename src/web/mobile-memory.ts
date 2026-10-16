/**
 * mobile-memory.ts — 手机原生记忆内核 (2026-10-16, leo: 手机端智能体运行循环补 memory 设计迭代 + 人际关系分类)
 *
 * 与桌面 memory-store 同构但 **browser-safe** (localStorage, 无 fs):
 *   - MemoryEntry 结构化单条记忆: kind / importance / TTL / decay / recallCount
 *   - **人际关系分类** (手机原生模式): 每条 relationship 记忆带 relation{kind, trust},
 *     分类 family / friend / work / acquaintance / stranger (从通讯录/加好友/聊天内容迭代)
 *   - 记忆迭代: remember() 落库, recall() 关键词+importance 加权召回,
 *     每轮循环后 autoIterate() 把「本次会话新事实/关系」提炼入库 (规则启发式, 零 LLM 成本)
 *   - 快照 snapshot()/restore(): run 开始 bootstrap 恢复, run 结束落快照, 重启不丢
 *   - TTL: 带 ttlMs 的条目过期即标记 decayed (不删, 与桌面口径一致)
 *   - 指纹: memoryFingerprint() = 记忆摘要 hash, 参与上下文缓存 key
 *
 * 存储: localStorage 键 `bolloon_mobile_memory_<agentId>` (浏览器/WebView/测试全可用)
 */
export type MobileMemoryKind = 'fact' | 'insight' | 'preference' | 'event' | 'relationship' | 'skill-feedback';
export type MobileRelationKind = 'family' | 'friend' | 'work' | 'acquaintance' | 'stranger';

export interface MobileMemoryRelation {
  /** 对方 DID (或手机号目录里的 contactId) */
  did: string;
  kind: MobileRelationKind;
  /** 信任度 0-1 (加好友/多次正向交互上升, 忽略/拒绝下降) */
  trust: number;
}

export interface MobileMemoryEntry {
  id: string;                // sha256(agentId + content)
  agentId: string;
  content: string;
  kind: MobileMemoryKind;
  importance: number;        // 0-1 启发式
  createdAt: string;
  updatedAt: string;
  source: 'session' | 'manual' | 'tool' | 'iterate';
  /** TTL (毫秒): 过期 → decayed (临时事实/事件类条目用) */
  ttlMs?: number;
  decayed?: boolean;
  crystallized?: boolean;    // 固化: 多次召回/用户确认 → 不 decay
  recallCount: number;
  lastRecalledAt?: string;
  /** 人际关系分类 (kind === 'relationship' 时必有) */
  relation?: MobileMemoryRelation;
}

export interface MobileMemorySnapshot {
  version: 1;
  agentId: string;
  entries: MobileMemoryEntry[];
  savedAt: string;
}

const memKey = (agentId: string) => `bolloon_mobile_memory_${agentId}`;

/** 轻量 hash (记忆指纹/条目 id, 不涉密) */
export function quickHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < String(text || '').length; i++) {
    h ^= String(text || '').charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '_' + String(text || '').length.toString(36);
}

export function validMemoryContent(content: string): boolean {
  return String(content || '').trim().length >= 2;
}

/** importance 启发式 (与桌面同口径): 长度 + 强语义词 + kind 加权 */
export function heuristicImportance(content: string, kind: MobileMemoryKind = 'fact'): number {
  const t = String(content || '');
  let score = 0.3;
  if (t.length > 100) score += 0.2;
  if (/喜欢|偏好|讨厌|禁止|必须|永远|从不|重要|注意|记住|约定|家人|朋友|同事/.test(t)) score += 0.25;
  if (kind === 'preference' || kind === 'relationship') score += 0.2;
  if (kind === 'skill-feedback') score += 0.15;
  return Math.min(1, score);
}

/** 人际关系分类: 从文本/来源推断 relation kind (规则启发式; 未知 = stranger) */
export function classifyRelation(text: string, source: string = ''): MobileRelationKind {
  const t = String(text || '').toLowerCase();
  const src = String(source || '').toLowerCase();
  if (/家人|妈妈|爸爸|母亲|父亲|儿子|女儿|老婆|老公|妻子|丈夫|兄弟|姐妹/.test(t)) return 'family';
  if (/同事|客户|供应商|老板|领导|下属|同事|合作/.test(t)) return 'work';
  if (/朋友|好友|哥们|闺蜜|兄弟|认识的人/.test(t)) return 'friend';
  if (/directory|phone|手机号|通讯录/.test(src)) return 'acquaintance';
  return 'stranger';
}

/**
 * 手机记忆库 (localStorage 持久化; 内存缓存避免每次读盘)。
 * 测试注入 fake localStorage (mobile-core.test 模式) 即可用。
 */
export class MobileMemory {
  private agentId: string;
  private entries: MobileMemoryEntry[] = [];
  private loaded = false;

  constructor(agentId: string) {
    this.agentId = String(agentId || '');
  }

  private key() { return memKey(this.agentId); }

  private readAll(): MobileMemoryEntry[] {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(this.key()) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  private writeAll(list: MobileMemoryEntry[]): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(this.key(), JSON.stringify(list.slice(-200)));
    } catch { /* 写失败静默 (内存态仍可用) */ }
  }

  private ensureLoaded(): void {
    if (!this.loaded) { this.entries = this.readAll(); this.loaded = true; }
  }

  /** 全部条目 (内部用) */
  all(): MobileMemoryEntry[] { this.ensureLoaded(); return [...this.entries]; }

  /** 落一条记忆 (幂等: 同 id 覆盖); 返回条目 */
  remember(input: { content: string; kind?: MobileMemoryKind; importance?: number; source?: string; ttlMs?: number; relation?: MobileMemoryRelation }): MobileMemoryEntry {
    this.ensureLoaded();
    const content = String(input.content || '').trim();
    const source = (input.source as MobileMemoryEntry['source']) || 'session';
    if (!validMemoryContent(content)) {
      // 空内容拒绝存 (与桌面 validContent 同口径)
      const id = quickHash(this.agentId + '|' + content || 'empty');
      const stub: MobileMemoryEntry = { id, agentId: this.agentId, content: content || '（空）', kind: input.kind || 'fact', importance: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source, recallCount: 0 };
      return stub;
    }
    const kind = input.kind || 'fact';
    const now = new Date().toISOString();
    const id = quickHash(this.agentId + '|' + content);
    const importance = typeof input.importance === 'number'
      ? Math.min(1, Math.max(0, input.importance))
      : heuristicImportance(content, kind);
    const entry: MobileMemoryEntry = {
      id, agentId: this.agentId, content, kind,
      importance, createdAt: now, updatedAt: now,
      source,
      ttlMs: input.ttlMs, decayed: false, crystallized: false,
      recallCount: 0,
      ...(kind === 'relationship' && input.relation ? { relation: input.relation } : {}),
    };
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const prev = this.entries[idx];
      this.entries[idx] = { ...prev, ...entry, createdAt: prev.createdAt, recallCount: prev.recallCount, crystallized: prev.crystallized || entry.importance >= 0.8 };
      if (input.relation && prev.relation) {
        // 关系记忆迭代: 信任度按新信息移动 (平均值), 分类按最新文本重判
        this.entries[idx].relation = {
          did: input.relation.did || prev.relation.did,
          kind: input.relation.kind || prev.relation.kind,
          trust: Math.min(1, Math.max(0, (prev.relation.trust + input.relation.trust) / 2)),
        };
      }
    } else {
      this.entries.push(entry);
    }
    this.writeAll(this.entries);
    return this.entries.find((e) => e.id === id) || entry;
  }

  /** 召回: 关键词 + importance 加权; 命中即 +1 recallCount + 刷新 lastRecalledAt (迭代) */
  recall(query: string, opts: { limit?: number; minScore?: number } = {}): MobileMemoryEntry[] {
    this.ensureLoaded();
    this.applyTtl();
    const q = String(query || '').toLowerCase();
    const limit = opts.limit ?? 3;
    const minScore = opts.minScore ?? 0;
    const scored: { e: MobileMemoryEntry; s: number }[] = [];
    for (const e of this.entries) {
      if (e.decayed) continue;
      const c = String(e.content || '').toLowerCase();
      let s = e.importance * 0.5;
      const qTokens = q.split(/\s+/).filter((t) => t.length >= 2);
      const hit = qTokens.filter((t) => c.includes(t)).length;
      if (hit > 0) s += 0.3 * (hit / Math.max(qTokens.length, 1));
      if (qTokens.length && qTokens.some((t) => c.includes(t))) s += 0.2; // 部分命中
      if (e.relation && e.relation.trust >= 0.7) s += 0.1;                // 高信任关系记忆加权
      if (s >= minScore) scored.push({ e, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const hits = scored.slice(0, limit).map((x) => x.e);
    for (const h of hits) {
      const now = new Date().toISOString();
      h.recallCount += 1;
      h.lastRecalledAt = now;
      if (h.recallCount >= 3) h.crystallized = true;  // 多次召回 → 固化 (不 decay)
    }
    if (hits.length) this.writeAll(this.entries);
    return hits;
  }

  /** TTL 过期 → decayed (不删, 与桌面 applyDecay 同精神) */
  applyTtl(nowIso?: string): void {
    this.ensureLoaded();
    const now = Date.parse(nowIso || new Date().toISOString());
    let changed = false;
    for (const e of this.entries) {
      if (e.decayed || e.crystallized || !e.ttlMs) continue;
      const base = Date.parse(e.lastRecalledAt || e.createdAt) || now;
      if (now - base > e.ttlMs) { e.decayed = true; changed = true; }
    }
    if (changed) this.writeAll(this.entries);
  }

  /**
   * 记忆迭代 (每轮循环后调用): 从「用户目标 + 工具结果 + 最终回复」提炼
   * 新事实 / 偏好 / 关系。规则启发式 (零 LLM 成本): 信号词命中即存,
   * 已经存过的同内容自动合并 (remember 幂等)。
   */
  autoIterate(input: { goal?: string; toolResults?: string[]; reply?: string; source?: string }): number {
    this.ensureLoaded();
    const parts = [String(input.goal || ''), ...(input.toolResults || []), String(input.reply || '')];
    const text = parts.filter(Boolean).join('\n');
    if (!text.trim()) return 0;
    let added = 0;
    // ① 偏好记忆 — 兼容「我/用户/本人」主语 (agent 转述用户原话时主语可能是「用户」)
    const pref = text.match(/(?:我|用户|本人)(?:喜欢|偏好|热爱|想要|希望).{2,40}?/g);
    if (pref) {
      for (const m of pref.slice(0, 3)) {
        const content = m.replace(/^(?:我|用户|本人)/, '').trim();
        if (validMemoryContent(content)) { this.remember({ content: '偏好: ' + content, kind: 'preference', source: input.source || 'iterate' }); added++; }
      }
    }
    // ② 禁忌/约定记忆 — 兼容「不要/不能/别」开头 (用户约束)
    const ban = text.match(/不要(?:再)?.{2,40}?|不要.{2,40}?|不能.{2,40}?|禁止.{2,40}?|记住.{2,40}?/g);
    if (ban) {
      for (const m of ban.slice(0, 2)) {
        if (validMemoryContent(m)) { this.remember({ content: '约定: ' + m.trim(), kind: 'insight', source: input.source || 'iterate', importance: 0.6 }); added++; }
      }
    }
    // ③ 关系记忆: 出现「人名/称谓 + 关系词」→ 分类存 (含「同事/合作伙伴」等职场关系)
    const relMatch = text.match(/([一-龥]{2,6})是(?:我的)?(家人|妈妈|爸爸|老婆|老公|朋友|同事|客户|老板|领导|兄弟|姐妹|妻子|丈夫|合作伙伴)/);
    if (relMatch) {
      const name = relMatch[1];
      const kind = classifyRelation(relMatch[0], input.source || '');
      const content = `${name} 是${relMatch[2]}`;
      this.remember({
        content, kind: 'relationship', source: input.source || 'iterate',
        importance: 0.8,
        relation: { did: '', kind, trust: 0.6 },
      });
      added++;
    }
    return added;
  }

  /** 快照 (run 结束/重启恢复用) */
  snapshot(): MobileMemorySnapshot {
    this.ensureLoaded();
    this.applyTtl();
    return { version: 1, agentId: this.agentId, entries: [...this.entries], savedAt: new Date().toISOString() };
  }

  /** 从快照恢复 (bootstrap) — 合并, 不覆盖已有 */
  restore(snap: MobileMemorySnapshot | null): void {
    if (!snap || !Array.isArray(snap.entries)) return;
    this.ensureLoaded();
    for (const e of snap.entries) {
      const exists = this.entries.some((x) => x.id === e.id);
      if (!exists) this.entries.push(e);
    }
    this.writeAll(this.entries);
  }

  /** 记忆指纹: 摘要 hash (参与上下文缓存 key; 记忆变了 → 指纹变 → 缓存 miss) */
  fingerprint(): string {
    this.ensureLoaded();
    this.applyTtl();
    const active = this.entries.filter((e) => !e.decayed).sort((a, b) => a.id.localeCompare(b.id));
    const digest = active.slice(-30).map((e) => `${e.kind}:${e.content.slice(0, 60)}:${e.importance.toFixed(2)}`).join('|');
    return quickHash(digest);
  }
}

/** 独立缓存助手 (mobile-runtime 用): 指纹 → 结果, 带 TTL */
export class MobileCache {
  private prefix: string;
  constructor(prefix = 'bolloon_mobile_cache') { this.prefix = prefix; }
  get<T = any>(key: string, ttlMs = 60_000): T | null {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`${this.prefix}_${key}`) : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.v || typeof parsed.at !== 'number') return null;
      if (Date.now() - parsed.at > ttlMs) return null; // TTL 过期 → miss
      return parsed.v as T;
    } catch { return null; }
  }
  set(key: string, value: any): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(`${this.prefix}_${key}`, JSON.stringify({ v: value, at: Date.now() }));
    } catch { /* 缓存写失败静默 */ }
  }
  clear(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.prefix)) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch { /* 忽略 */ }
  }
}
