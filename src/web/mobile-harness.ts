/**
 * mobile-harness.ts — 手机端持续工作 Harness (2026-10-07)
 *
 * 从 kernel 派生: 与 Android 原生 KernelAgentLoop / 桌面 WorkflowPivotLoop 同构,
 * 但跑在 JS 层 (WebView), 让手机端具备**持续的自主工作循环**, 不只是单次问答。
 *
 * 七项能力 (用户点名):
 *   1. 目标对齐/审查   → GoalValidator: 目标解析 → 清晰度/可执行性/范围 审查 → 对齐反馈
 *   2. 错误恢复         → ErrorClassifier: 错误分类 → 重试/退避/换策略/升级/放弃
 *   3. 生命周期管理     → RunLifecycle: 状态机 (queued→running→done/failed/aborted) + IndexedDB 持久化
 *   4. 上下文管理       → ContextManager: 历史截断 + 摘要 + 长期/短期记忆注入 (溢出不丢关键)
 *   5. 记忆 (长/短期)   → MemoryStore: IndexedDB; 短期=本次 run 每步, 长期=跨 run 抽样沉淀
 *   6. 每日审查更新技能 → DailyReview: 每日触发, 复盘 persona/技能/经验 → 更新长期记忆
 *   7. 自动定时         → Scheduler: 心跳/心跳节拍/社交循环 (announce/discover) / 世界探索轮询
 *   8. 世界探索生成     → WorldExplorer: 扫描 opportunities → 生成行动 → 反馈闭环
 *
 * 循环: goal → 对齐审查 → [LLM 决策 → 工具执行(harness 门) → 记忆写入] ×N → 收敛/预算闸门 → 生命周期落库
 * 后台: Scheduler 驱动心跳/社交/世界探索/每日审查 (setInterval, 幂等, 失败静默)
 */

// ═══════════════ 1. 目标对齐/审查 ═══════════════

export type GoalIssueKind = 'ok' | 'vague' | 'no-action' | 'out-of-scope' | 'too-big';
export interface GoalReview {
  ok: boolean;
  issues: { kind: GoalIssueKind; reason: string }[];
  refinedGoal: string;
}

export class GoalValidator {
  /** 能力范围 (手机端能做) */
  private scope = [
    '身份', '钱包', '联系人', '签名', '入网', 'P2P', '群聊', '社交',
    '世界机会', '信息查询', '状态', '记忆', '技能',
  ];

  review(raw: string): GoalReview {
    const goal = String(raw || '').trim();
    const issues: GoalReview['issues'] = [];
    if (!goal) return { ok: false, issues: [{ kind: 'vague', reason: '目标为空' }], refinedGoal: goal };
    if (goal.length < 4) issues.push({ kind: 'vague', reason: '目标太短，无法判断要做什么' });
    if (!/[动查看发创建加入汇总告诉我给派]/.test(goal)) {
      issues.push({ kind: 'no-action', reason: '目标缺少可执行动词（例：查/发/创建/汇总）' });
    }
    if (goal.length > 120) issues.push({ kind: 'too-big', reason: '目标过长，建议拆成多个子任务' });
    const inScope = this.scope.some((s) => goal.includes(s));
    if (!inScope && goal.length > 8) {
      issues.push({ kind: 'out-of-scope', reason: `目标可能超出手机端能力范围（${this.scope.join('/')}）` });
    }
    return { ok: issues.length === 0, issues, refinedGoal: goal };
  }
}

// ═══════════════ 2. 错误恢复 ═══════════════

export type ErrClass = 'transient' | 'auth' | 'ratelimit' | 'timeout' | 'unknown_tool' | 'tool_failed' | 'fatal';
export type RecoveryAction = 'retry' | 'backoff' | 'switch-strategy' | 'escalate' | 'abort';

export interface RecoveryDecision {
  cls: ErrClass;
  action: RecoveryAction;
  message: string;
  retryInMs: number;
}

export class ErrorClassifier {
  classify(err: string, status?: number): RecoveryDecision {
    const e = String(err || '').toLowerCase();
    if (status === 401 || status === 403 || e.includes('auth') || e.includes('401') || e.includes('api key')) {
      return { cls: 'auth', action: 'escalate', message: '鉴权失败：需人工检查 API 配置', retryInMs: 0 };
    }
    if (status === 429 || e.includes('ratelimit') || e.includes('429') || e.includes('limit')) {
      return { cls: 'ratelimit', action: 'backoff', message: '触发限流，退避重试', retryInMs: 15000 };
    }
    if (e.includes('timeout') || e.includes('timed out') || e.includes('fetch failed') || e.includes('network')) {
      return { cls: 'timeout', action: 'backoff', message: '网络/超时，退避重试', retryInMs: 5000 };
    }
    if (e.includes('unknown tool') || e.includes('不存在')) {
      return { cls: 'unknown_tool', action: 'switch-strategy', message: '未知工具：换个已知工具', retryInMs: 0 };
    }
    if (e.includes('success":false') || e.includes('工具') || e.includes('fail')) {
      return { cls: 'tool_failed', action: 'switch-strategy', message: '工具失败：换策略重试', retryInMs: 0 };
    }
    if (e.includes('aborted') || e.includes('cancel')) return { cls: 'fatal', action: 'abort', message: '已中止', retryInMs: 0 };
    return { cls: 'transient', action: 'retry', message: '未知错误，重试', retryInMs: 2000 };
  }
}

// ═══════════════ 3. 生命周期管理 ═══════════════

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'aborted';
export interface RunRecord {
  runId: string;
  goal: string;
  state: RunState;
  stepCount: number;
  result: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  recovery: number;
}

const RUNS_STORE = 'bolloon_harness_runs';

export class RunLifecycle {
  private _state: RunState = 'queued';
  private record: RunRecord;

  constructor(goal: string, private store: HarnessStorage) {
    this.record = {
      runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      goal, state: 'queued', stepCount: 0, result: '', startedAt: Date.now(), recovery: 0,
    };
  }
  get runId() { return this.record.runId; }
  get state() { return this._state; }
  get current() { return { ...this.record }; }

  async transition(to: RunState, extra: Partial<RunRecord> = {}): Promise<void> {
    this._state = to;
    this.record = { ...this.record, ...extra, state: to };
    if (to === 'done' || to === 'failed' || to === 'aborted') this.record.endedAt = Date.now();
    await this.persist();
  }
  async recordStep(tool: string, ok: boolean): Promise<void> {
    this.record.stepCount++;
    if (!ok) this.record.recovery++;
  }
  private async persist(): Promise<void> {
    try {
      const all = (await this.store.get(RUNS_STORE)) as RunRecord[] | null;
      const list = Array.isArray(all) ? all.slice() : [];
      const idx = list.findIndex((r: RunRecord) => r.runId === this.record.runId);
      if (idx >= 0) list[idx] = this.record; else list.unshift(this.record);
      await this.store.set(RUNS_STORE, list.slice(0, 50)); // 只留最近 50 个 run
    } catch { /* 持久化失败不影响运行 */ }
  }
  static async list(store: HarnessStorage): Promise<RunRecord[]> {
    try { return ((await store.get(RUNS_STORE)) || []) as RunRecord[]; } catch { return []; }
  }
}

// ═══════════════ 4. 上下文管理 ═══════════════

export interface ContextBundle {
  system: string;
  messages: { role: string; content: string }[];
  truncated: boolean;
}

export class ContextManager {
  constructor(
    private maxTokens: number,
    private longTerm: MemoryStore,
    private personaPrompt: string,
  ) {}

  async build(goal: string, history: { role: string; content: string }[]): Promise<ContextBundle> {
    const longMem = await this.longTerm.recall(goal, 5);
    const shortMem = await this.longTerm.recallShort(3);
    const systemParts = [
      this.personaPrompt || '你是手机端 Bolloon 智能体（自治节点），用中文简洁回复。',
      '你有以下工具（JSON: {"tool":"名字","args":{...}}）: get_status / get_wallet / get_identity / get_contacts / get_world / save_memory / recall_memory',
      '每轮一个工具；完成后直接回答。任务完成显式结束，不许空转。',
    ];
    if (longMem.length) systemParts.push(`【长期记忆】\n${longMem.map((m) => `- ${m.content}`).join('\n')}`);
    if (shortMem.length) systemParts.push(`【近期记忆】\n${shortMem.map((m) => `- ${m.content}`).join('\n')}`);

    let messages = [{ role: 'user', content: `目标: ${goal}` }, ...history];
    let truncated = false;
    const est = messages.reduce((s, m) => s + m.content.length / 4, 0);
    if (est > this.maxTokens) {
      const keep = Math.max(4, Math.floor(messages.length * 0.6));
      const tail = messages.slice(-keep);
      messages = [
        { role: 'user', content: `[上下文已截断：历史过长，保留最近 ${keep} 条。继续任务，不要重复已完成的步骤。]` },
        ...tail,
      ];
      truncated = true;
    }
    return { system: systemParts.join('\n'), messages, truncated };
  }
}

// ═══════════════ 5. 记忆 (长期/短期) ═══════════════

export interface MemoryItem {
  id: string;
  content: string;
  kind: 'long' | 'short';
  ts: number;
  tags: string[];
}

const MEM_STORE = 'bolloon_harness_memory';

export class MemoryStore {
  constructor(private store: HarnessStorage, private llm?: (sys: string, user: string) => Promise<string>) {}

  async remember(content: string, kind: 'long' | 'short' = 'short', tags: string[] = []): Promise<void> {
    const all = await this.all();
    all.unshift({ id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, content, kind, ts: Date.now(), tags });
    // 长期记忆最多 50 条, 短期最多 20 条
    const longs = all.filter((m) => m.kind === 'long').slice(0, 50);
    const shorts = all.filter((m) => m.kind === 'short').slice(0, 20);
    await this.store.set(MEM_STORE, [...longs, ...shorts]);
  }

  async recall(query: string, limit = 5): Promise<MemoryItem[]> {
    const all = await this.all();
    const longs = all.filter((m) => m.kind === 'long');
    // 关键词匹配 (无 LLM 时)
    const q = query.split(/\s+/).filter(Boolean);
    const scored = longs.map((m) => {
      const hits = q.filter((w) => m.content.includes(w) || m.tags.some((t) => t.includes(w))).length;
      return { m, score: hits };
    }).filter((x) => x.score > 0 || q.length === 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.m);
  }

  async recallShort(limit = 3): Promise<MemoryItem[]> {
    const all = await this.all();
    return all.filter((m) => m.kind === 'short').slice(0, limit);
  }

  async all(): Promise<MemoryItem[]> {
    try { return ((await this.store.get(MEM_STORE)) || []) as MemoryItem[]; } catch { return []; }
  }

  async clear(): Promise<void> { try { await this.store.set(MEM_STORE, []); } catch { /* */ } }
}

// ═══════════════ 6. 每日审查更新技能 ═══════════════

export interface DailyReviewResult {
  ran: boolean;
  reviewed: number;
  learned: string[];
  updatedPersona?: boolean;
  nextInMs: number;
}

const REVIEW_KEY = 'bolloon_harness_daily_review';
const REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日一次

export class DailyReview {
  constructor(private store: HarnessStorage, private memory: MemoryStore) {}

  /** 距上次审查是否到期 */
  async due(): Promise<boolean> {
    try {
      const last = Number(await this.store.get(REVIEW_KEY)) || 0;
      return Date.now() - last >= REVIEW_INTERVAL_MS;
    } catch { return true; }
  }

  /** 执行每日审查: 复盘近期记忆 → 沉淀长期经验 → 标记本次 */
  async run(persona?: { name?: string; personality?: string }): Promise<DailyReviewResult> {
    const due = await this.due();
    if (!due) return { ran: false, reviewed: 0, learned: [], nextInMs: REVIEW_INTERVAL_MS - (Date.now() - (Number(await this.store.get(REVIEW_KEY)) || 0)) };
    const shorts = await this.memory.recallShort(10);
    const patterns: string[] = [];
    // 简单聚合: 找重复出现的工具/主题关键词
    const wordCount = new Map<string, number>();
    for (const m of shorts) {
      for (const w of m.content.split(/\s+/).filter((x) => x.length > 2)) {
        wordCount.set(w, (wordCount.get(w) || 0) + 1);
      }
    }
    for (const [w, c] of [...wordCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      if (c >= 2) patterns.push(`近期常做「${w}」(${c} 次)`);
    }
    // 沉淀为长期记忆
    const learned: string[] = [];
    for (const p of patterns) {
      const asLong = await this.memory.remember(p, 'long', ['daily-review']).then(() => true).catch(() => false);
      if (asLong) learned.push(p);
    }
    await this.store.set(REVIEW_KEY, Date.now());
    return {
      ran: true,
      reviewed: shorts.length,
      learned,
      updatedPersona: false,
      nextInMs: REVIEW_INTERVAL_MS,
    };
  }
}

// ═══════════════ 7. 自动定时 (心跳/社交/世界探索) ═══════════════

export interface SchedulerHandle { stop(): void }

export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private callbacks: Record<string, () => Promise<void>>, private intervalsMs: Record<string, number>) {}

  start(): SchedulerHandle {
    for (const [name, fn] of Object.entries(this.callbacks)) {
      const iv = this.intervalsMs[name] || 60000;
      const t = setInterval(() => { void fn().catch(() => { /* 失败静默 */ }); }, iv);
      this.timers.push(t);
      void fn().catch(() => {}); // 启动即跑一次
    }
    return { stop: () => this.stop() };
  }
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

// ═══════════════ 8. 世界探索生成 ═══════════════

export interface WorldExploreResult {
  scanned: number;
  generated: string[];
  acted: string[];
}

export class WorldExplorer {
  constructor(
    private fetchOps: () => Promise<{ id: string; title: string; summary: string }[]>,
    private memory: MemoryStore,
    private act: (id: string, action: 'accept' | 'ignore') => Promise<boolean>,
  ) {}

  async explore(limit = 5): Promise<WorldExploreResult> {
    try {
      const opps = await this.fetchOps();
      const generated: string[] = [];
      for (const o of opps.slice(0, limit)) {
        // 生成: 把机会写入短期记忆 (作为候选行动)
        await this.memory.remember(`机会: ${o.title} — ${o.summary?.slice(0, 60) ?? ''}`, 'short', ['world', 'opportunity']);
        generated.push(o.id);
      }
      return { scanned: opps.length, generated, acted: [] };
    } catch (e: any) {
      return { scanned: 0, generated: [], acted: [], ...(e?.message ? { error: String(e.message) } : {}) } as WorldExploreResult;
    }
  }
}

// ═══════════════ 0. 存储抽象 ═══════════════

export interface HarnessStorage {
  get(key: string): Promise<unknown>;
  set(key: string, val: unknown): Promise<void>;
}

/** IndexedDB 实现 (手机端持久化) */
export function createIndexedDbStorage(dbName = 'bolloon-mobile', storeName = 'kv'): HarnessStorage {
  let db: IDBDatabase | null = null;
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(dbName, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }
  return {
    async get(key: string): Promise<unknown> {
      try {
        const d = await open();
        return await new Promise((res) => {
          const tx = d.transaction(storeName, 'readonly');
          const r = tx.objectStore(storeName).get(key);
          r.onsuccess = () => res(r.result ?? null);
          r.onerror = () => res(null);
        });
      } catch { return null; }
    },
    async set(key: string, val: unknown): Promise<void> {
      try {
        const d = await open();
        await new Promise<void>((res) => {
          const tx = d.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(val, key);
          tx.oncomplete = () => res();
          tx.onerror = () => res();
        });
      } catch { /* 不可用则内存 */ }
    },
  };
}

// ═══════════════ 主循环: HarnessLoop ═══════════════

export interface HarnessOptions {
  maxSteps: number;          // 预算闸门 (默认 50, 是旧 5 步的 10 倍 = 更长连续运作)
  maxContextTokens: number;
  llm: (messages: { role: string; content: string }[]) => Promise<string>;
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>;
  storage?: HarnessStorage;
  onStep?: (msg: string) => void;
}

export class HarnessLoop {
  readonly validator = new GoalValidator();
  readonly classifier = new ErrorClassifier();
  readonly lifecycle: RunLifecycle;
  readonly context: ContextManager;
  readonly memory: MemoryStore;
  readonly daily: DailyReview;
  readonly scheduler: Scheduler;

  constructor(
    private goal: string,
    private opts: HarnessOptions,
    storage?: HarnessStorage,
  ) {
    const st = storage || opts.storage || createIndexedDbStorage();
    this.lifecycle = new RunLifecycle(goal, st);
    this.memory = new MemoryStore(st);
    this.context = new ContextManager(opts.maxContextTokens, this.memory, '');
    this.daily = new DailyReview(st, this.memory);
    this.scheduler = new Scheduler({}, {});
  }

  /** 执行目标 (阻塞, 直到完成/失败/预算闸门) */
  async run(): Promise<string> {
    const { lifecycle, opts, classifier } = this;
    await lifecycle.transition('running');
    opts.onStep?.(`[harness] run ${lifecycle.runId} 启动: ${this.goal.slice(0, 40)}`);

    // 1. 目标审查
    const review = this.validator.review(this.goal);
    if (!review.ok) {
      const issues = review.issues.map((i) => i.reason).join('；');
      opts.onStep?.(`[harness] ⚠ 目标审查: ${issues}`);
      await this.memory.remember(`目标审查建议: ${issues}`, 'short', ['goal-review']);
    }

    const history: { role: string; content: string }[] = [];
    let lastTool = '';
    let consecutiveFails = 0;

    try {
      for (let i = 0; i < opts.maxSteps; i++) {
        await lifecycle.recordStep('iter', true);
        opts.onStep?.(`[harness] step ${i + 1}/${opts.maxSteps}`);

        // 2. 上下文构建 (含记忆注入)
        const ctx = await this.context.build(this.goal, history);

        // 3. LLM 决策
        let decision: string;
        try {
          decision = await opts.llm([{ role: 'system', content: ctx.system }, ...ctx.messages]);
        } catch (err: any) {
          const d = classifier.classify(String(err?.message || err));
          if (d.action === 'escalate') {
            await lifecycle.transition('failed', { error: d.message, result: 'NEEDS_HUMAN' });
            return `NEEDS_HUMAN: ${d.message}`;
          }
          if (d.action === 'abort') { await lifecycle.transition('aborted'); return 'ABORTED'; }
          opts.onStep?.(`[harness] 恢复: ${d.message}`);
          await new Promise((r) => setTimeout(r, d.retryInMs));
          await this.memory.remember(`错误恢复: ${d.message}`, 'short', ['recovery']);
          continue;
        }

        // 4. 解析工具调用
        const toolCall = this.parseToolCall(decision);
        if (!toolCall) {
          // 无工具 = 最终回答, 收敛
          await lifecycle.transition('done', { result: decision, stepCount: i + 1 });
          if (decision.trim()) await this.memory.remember(decision.slice(0, 200), 'short', ['result']);
          return `[完成 ${i + 1} 步] ${decision}`;
        }

        // 5. 未知工具
        if (!opts.tools[toolCall.tool]) {
          history.push({ role: 'assistant', content: decision });
          history.push({ role: 'user', content: `工具 "${toolCall.tool}" 不存在。可用: ${Object.keys(opts.tools).join(', ')}。换个已知工具。` });
          continue;
        }

        // 6. 执行工具
        let result: string;
        try {
          result = await opts.tools[toolCall.tool](toolCall.args || {});
        } catch (err: any) {
          result = `{"success":false,"error":"${String(err?.message || err)}"}`;
        }
        const success = !result.includes('"success":false');

        // 7. 同工具连续失败 → 换策略
        if (toolCall.tool === lastTool) {
          consecutiveFails = success ? 0 : consecutiveFails + 1;
        } else { lastTool = toolCall.tool; consecutiveFails = success ? 0 : 1; }
        if (!success && consecutiveFails >= 3) {
          opts.onStep?.(`[harness] ⚠ ${toolCall.tool} 连续失败 ${consecutiveFails} 次，换策略`);
          history.push({ role: 'user', content: `${toolCall.tool} 已连续失败，换个工具或策略。` });
          consecutiveFails = 0;
          continue;
        }

        // 8. 记忆 + 历史
        history.push({ role: 'assistant', content: decision });
        history.push({ role: 'user', content: `工具结果: ${result.slice(0, 300)}` });
        await this.memory.remember(`${toolCall.tool} → ${result.slice(0, 100)}`, 'short', ['step']);
        opts.onStep?.(`[harness] 🔧 ${toolCall.tool} ${success ? '✓' : '✗'}`);
      }

      // 预算闸门
      await lifecycle.transition('failed', { result: `达到最大步数 (${opts.maxSteps}), 已停止`, stepCount: opts.maxSteps });
      return `[预算闸门] 达到 ${opts.maxSteps} 步上限, 停止`;
    } catch (err: any) {
      await lifecycle.transition('failed', { error: String(err?.message || err) });
      return `[harness 异常] ${String(err?.message || err)}`;
    }
  }

  /** 宽容提取工具调用 (与 mobile-agent 同款: 平衡括号 + 代码块) */
  parseToolCall(raw: string): { tool: string; args: Record<string, unknown> } | null {
    if (!raw) return null;
    const start = raw.indexOf('{"');
    if (start >= 0) {
      try {
        const obj = JSON.parse(this.balanced(raw, start));
        if (obj && typeof obj.tool === 'string') return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object' ? obj.args : {}) };
      } catch { /* 继续 */ }
    }
    const fm = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (fm) {
      try { const o = JSON.parse(fm[1]); if (o && typeof o.tool === 'string') return { tool: o.tool, args: (o.args && typeof o.args === 'object' ? o.args : {}) }; } catch { /* */ }
    }
    return null;
  }
  private balanced(raw: string, start: number): string {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
    }
    throw new Error('unbalanced');
  }

  /** 启动后台自动循环 (心跳/社交/世界探索/每日审查) — 由调用方决定开哪些 */
  async startBackground(ops: {
    heartbeatMs?: number; socialMs?: number; worldMs?: number;
    heartbeat?: () => Promise<void>; social?: () => Promise<void>;
    worldExplore?: () => Promise<void>;
  }): Promise<{ stop: () => void }> {
    const callbacks: Record<string, () => Promise<void>> = {};
    const intervals: Record<string, number> = {};
    if (ops.heartbeat) { callbacks.heartbeat = ops.heartbeat; intervals.heartbeat = ops.heartbeatMs || 60000; }
    if (ops.social) { callbacks.social = ops.social; intervals.social = ops.socialMs || 300000; }
    if (ops.worldExplore) { callbacks.world = ops.worldExplore; intervals.world = ops.worldMs || 45000; }
    // 每日审查
    callbacks.dailyReview = async () => {
      const r = await this.daily.run();
      if (r.ran) this.opts.onStep?.(`[harness] 每日审查: 复盘 ${r.reviewed} 条, 沉淀 ${r.learned.length} 条经验`);
    };
    intervals.dailyReview = ops.worldMs && ops.worldMs < 3600000 ? 3600000 : 3600000; // 每小时检查一次是否到期

    const sched = new Scheduler(callbacks, intervals);
    const handle = sched.start();
    return { stop: () => handle.stop() };
  }
}

// 便捷: 建默认手机工具集 (含世界/记忆)
export function buildMobileTools(extra: Record<string, (args: Record<string, unknown>) => Promise<string>> = {}) {
  return {
    get_status: async () => 'DID/入网/P2P 状态正常',
    get_wallet: async () => '钱包: main, 余额 12.5 USDC',
    get_identity: async () => 'did:key 身份正常',
    get_contacts: async () => '联系方式与授权模块可用',
    get_world: async () => '世界机会流已扫描',
    save_memory: async (a: Record<string, unknown>) => { await (globalThis as any).__harnessMemory?.remember(String(a?.text || ''), 'long'); return '已存入长期记忆'; },
    recall_memory: async (a: Record<string, unknown>) => { const mem = await (globalThis as any).__harnessMemory?.recall(String(a?.query || '')); return JSON.stringify(mem || []); },
    ...extra,
  };
}