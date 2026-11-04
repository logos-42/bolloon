/**
 * self-model.ts — agent 的**自定信念与目标**（短期 / 中期 / 长期），并按信念挑动作
 *
 * 为什么有这个文件：
 *   主动性此前只有「信号驱动的自改」(heartbeat/self-improve-bus) 与「用户下发的目标」
 *   (GoalStore)。agent 自己**没有长期持有的立场** —— 每轮行为方向全靠当轮输入。
 *   这里补上"自模型"这一层：
 *     · 信念 (belief) = agent 自己立的判断（价值 / 身份 / 世界观 / 方法论）
 *     · 目标 (self goal) = 信念落到时间尺度上的投影（short / mid / long）
 *     · 动作 = 按信念给目标排序后的**下一个动作**，经既有 suggestion 队列交给 agent 去做
 *
 * 与既有目标体系的关系（不造第二套目标状态）：
 *   GoalStore (`~/.bolloon/goals/<id>.json`) 仍是**可执行目标**的唯一事实来源；
 *   本模块只存"agent 自己想成为什么、想推进什么"，是 Goal 的**上游意图**。
 *   挑出来的动作不直接开 Goal，而是进 `suggestions.json`（cron/策略的既有通道），
 *   由 agent 或用户决定是否升级成 Goal —— 不越过 goal-flywheel 的冻结纪律。
 *
 * 四条纪律（与 judgment / dream 同源）：
 *   1. 纯函数判定（pickNextAction / renderSelfModelBlock）不碰 I/O，可单测
 *   2. 反向不静默覆盖：新信念与旧信念反向 → 两边都标 contested，等人裁
 *   3. 信念不豁免底线：想绕过门控/权限/审计/带私钥出门的"信念"入库即拒
 *   4. 目标不许悬空：只有 done/dropped 算结束；久不推进要如实报 stale
 *
 * 落盘：`~/.bolloon/self-model.json`（原子写 + 进程内互斥链，对齐 suggestions.ts）
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ────────────────────────── 常量 ──────────────────────────

export const MAX_BELIEFS = 32;
export const MAX_GOALS = 24;
/** 相似判定阈值（中文 bigram，与 judgment merge 同口径） */
export const MERGE_THRESHOLD = 0.6;
export const MAX_STATEMENT_CHARS = 160;
/** 信念要能支配行动的最低置信度 */
export const MIN_DRIVING_CONFIDENCE = 0.5;
/** 同一目标两次主动动作的最小间隔 */
export const GOAL_COOLDOWN_MS = 30 * 60 * 1000;

/** 硬底线：信念里出现即拒（自定信念 ≠ 自定规则） */
export const FLOOR_HINTS: readonly string[] = [
  '绕过门控',
  '跳过门控',
  '忽略权限',
  '不做审计',
  '泄露私钥',
  '发送密钥',
  '私钥发给',
  '无授权转账',
  '无视安全',
  'bypass harness',
];

const NEGATION_HINTS = ['不要', '不许', '禁止', '别'];

// ────────────────────────── 类型 ──────────────────────────

export type BeliefKind = 'value' | 'identity' | 'worldview' | 'method';
export type BeliefOrigin = 'self' | 'user' | 'experience' | 'peer';
export type BeliefStatus = 'active' | 'contested' | 'retired';

export interface Belief {
  id: string;
  statement: string;
  kind: BeliefKind;
  origin: BeliefOrigin;
  /** 0~1 */
  confidence: number;
  evidence: string[];
  status: BeliefStatus;
  confirmations: number;
  contradictions: number;
  createdAt: string;
  updatedAt: string;
}

export type GoalHorizon = 'short' | 'mid' | 'long';
export type SelfGoalState = 'proposed' | 'active' | 'paused' | 'done' | 'dropped';

export interface SelfGoal {
  id: string;
  statement: string;
  horizon: GoalHorizon;
  /** 支撑它的信念 id（行动理由可追溯） */
  supports: string[];
  /** 0~1 */
  priority: number;
  state: SelfGoalState;
  progress: string[];
  createdAt: string;
  updatedAt: string;
  lastActedAt?: string;
}

export interface SelfModel {
  version: 1;
  beliefs: Belief[];
  goals: SelfGoal[];
  updatedAt: string;
}

export const HORIZON_LABEL: Record<GoalHorizon, string> = {
  short: '短期',
  mid: '中期',
  long: '长期',
};

export const GOAL_STATE_LABEL: Record<SelfGoalState, string> = {
  proposed: '待启动',
  active: '推进中',
  paused: '暂停',
  done: '已完成',
  dropped: '已放弃',
};

export const KIND_LABEL: Record<BeliefKind, string> = {
  value: '价值',
  identity: '身份',
  worldview: '世界观',
  method: '方法论',
};

export const ORIGIN_LABEL: Record<BeliefOrigin, string> = {
  self: '自省',
  user: '用户',
  experience: '经验',
  peer: '协作',
};

/** 这类信念自然落在哪个时间尺度上 */
export function horizonForKind(kind: BeliefKind): GoalHorizon {
  if (kind === 'value' || kind === 'identity') return 'long';
  if (kind === 'worldview') return 'mid';
  return 'short';
}

/** 起点置信度：用户说的高于自己想的，协作来的最低 */
export function baseConfidence(origin: BeliefOrigin): number {
  if (origin === 'user') return 0.85;
  if (origin === 'self') return 0.65;
  if (origin === 'experience') return 0.6;
  return 0.5;
}

/** 行动紧迫权重：短期最该动，长期是方向 */
export function horizonUrgency(h: GoalHorizon): number {
  if (h === 'short') return 1.0;
  if (h === 'mid') return 0.75;
  return 0.5;
}

// ────────────────────────── 纯函数 ──────────────────────────

/** 中文 bigram jaccard（与 judgment / rust belief 同口径） */
export function jaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const chars = Array.from(s).filter((c) => !/\s/.test(c));
    if (chars.length < 2) return new Set(chars);
    const out = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function hasNegation(s: string): boolean {
  return NEGATION_HINTS.some((w) => s.includes(w));
}

function clampStatement(s: string): string {
  const t = s.trim();
  return t.length <= MAX_STATEMENT_CHARS ? t : t.slice(0, MAX_STATEMENT_CHARS) + '…';
}

/** 硬底线检查：返回命中的提示词（null = 没问题） */
export function violatesFloor(statement: string): string | null {
  const lower = statement.toLowerCase();
  for (const h of FLOOR_HINTS) {
    if (statement.includes(h) || lower.includes(h.toLowerCase())) return h;
  }
  return null;
}

/** 信念能否支配行动 */
export function canDrive(b: Belief): boolean {
  return b.status === 'active' && b.confidence >= MIN_DRIVING_CONFIDENCE;
}

/** 生效中且置信过线的信念（置信降序） */
export function drivingBeliefs(m: SelfModel): Belief[] {
  return m.beliefs.filter(canDrive).sort((a, b) => b.confidence - a.confidence);
}

export function isTerminalGoal(g: SelfGoal): boolean {
  return g.state === 'done' || g.state === 'dropped';
}

export function isActionableGoal(g: SelfGoal): boolean {
  return g.state === 'proposed' || g.state === 'active';
}

/** 支撑信念的平均置信（没挂信念 → 0，不许凭空空转） */
export function supportConfidence(m: SelfModel, supports: string[]): number {
  let sum = 0;
  let n = 0;
  for (const id of supports) {
    const b = m.beliefs.find((x) => x.id === id);
    if (b && canDrive(b)) {
      sum += b.confidence;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export interface ActionContext {
  now?: number;
  /** 正在跑任务 → 不插话 */
  busy?: boolean;
  cooldownMs?: number;
}

export interface NextAction {
  goalId: string;
  statement: string;
  horizon: GoalHorizon;
  score: number;
  reason: string;
}

/**
 * 按信念挑下一个动作（**纯函数**）
 *
 * 打分 = 支撑信念平均置信 × 目标权重 × 尺度紧迫 × 久未推进加成；冷却中的目标跳过。
 * 返回 null 时不编动作 —— 原因由调用方如实说明。
 */
export function pickNextAction(m: SelfModel, ctx: ActionContext = {}): NextAction | null {
  if (ctx.busy) return null;
  if (drivingBeliefs(m).length === 0) return null;
  const now = ctx.now ?? Date.now();
  const cooldown = ctx.cooldownMs ?? GOAL_COOLDOWN_MS;

  let best: NextAction | null = null;
  for (const g of m.goals.filter(isActionableGoal)) {
    const conf = supportConfidence(m, g.supports);
    if (conf < MIN_DRIVING_CONFIDENCE) continue;
    // 冷却只针对"刚动过的目标"；从没动过的不该被创建时间卡住
    if (g.lastActedAt) {
      const last = Date.parse(g.lastActedAt);
      if (Number.isFinite(last) && now - last < cooldown) continue;
    }
    const lastTs = Date.parse(g.lastActedAt ?? g.createdAt);
    const sinceMs = Number.isFinite(lastTs) ? Math.max(0, now - lastTs) : 0;
    const staleBonus = Math.min(0.3, (sinceMs / (24 * 3600 * 1000)) * 0.1);
    const score = conf * g.priority * horizonUrgency(g.horizon) * (1 + staleBonus);
    if (!best || score > best.score) {
      best = {
        goalId: g.id,
        statement: g.statement,
        horizon: g.horizon,
        score,
        reason: `信念支撑置信 ${conf.toFixed(2)} · ${HORIZON_LABEL[g.horizon]}目标 · 权重 ${g.priority.toFixed(2)} · 距上次推进 ${(sinceMs / 3600000).toFixed(1)}h`,
      };
    }
  }
  return best;
}

/** 久未推进的目标（如实报，不装作在推进） */
export function staleGoals(m: SelfModel, now: number, thresholdMs: number): SelfGoal[] {
  return m.goals.filter(isActionableGoal).filter((g) => {
    const ts = Date.parse(g.lastActedAt ?? g.createdAt);
    return Number.isFinite(ts) && now - ts >= thresholdMs;
  });
}

export const SELF_MODEL_MAX_CHARS = 900;
export const PROMPT_TOP_BELIEFS = 5;
export const PROMPT_GOALS_PER_HORIZON = 2;

/**
 * 渲染成 system prompt 的一块（**纯函数**；空模型 → 空串，不占预算）
 *
 * 这是"根据信念来做"真正生效的地方：模型每轮都能看到自己立过什么、在推什么、为什么推。
 */
export function renderSelfModelBlock(m: SelfModel): string {
  if (m.beliefs.length === 0 && m.goals.length === 0) return '';
  const lines: string[] = ['# 我的信念与目标 (我自己立的, 可按新证据修订)'];

  const driving = drivingBeliefs(m);
  if (driving.length > 0) {
    lines.push('', '## 信念');
    for (const b of driving.slice(0, PROMPT_TOP_BELIEFS)) {
      lines.push(
        `- [${KIND_LABEL[b.kind]}·${ORIGIN_LABEL[b.origin]}] ${b.statement} (置信 ${b.confidence.toFixed(2)})`,
      );
    }
  }
  const contested = m.beliefs.filter((b) => b.status === 'contested');
  if (contested.length > 0) {
    lines.push('', '## 有争议 (未裁, 别当定论用)');
    for (const b of contested.slice(0, 3)) lines.push(`- ${b.statement} (反证 ${b.contradictions} 次)`);
  }
  for (const h of ['short', 'mid', 'long'] as GoalHorizon[]) {
    const items = m.goals
      .filter((g) => g.horizon === h && isActionableGoal(g))
      .slice(0, PROMPT_GOALS_PER_HORIZON);
    if (items.length === 0) continue;
    lines.push('', `## ${HORIZON_LABEL[h]}目标`);
    for (const g of items) lines.push(`- [${GOAL_STATE_LABEL[g.state]} ${g.id}] ${g.statement}`);
  }
  lines.push(
    '',
    '纪律: 按上面这些取舍; 有新证据就修订 (reinforce/contradict), 不给信念开后门 — 门控/权限/审计/凭据规则不由信念改写。',
  );
  const text = lines.join('\n');
  return text.length > SELF_MODEL_MAX_CHARS ? text.slice(0, SELF_MODEL_MAX_CHARS) : text;
}

// ────────────────────────── 落盘 ──────────────────────────

function selfModelPath(home: string): string {
  return path.join(home, '.bolloon', 'self-model.json');
}

function emptyModel(): SelfModel {
  return { version: 1, beliefs: [], goals: [], updatedAt: new Date(0).toISOString() };
}

/** 读盘（坏文件 → 空模型，绝不冒充有信念） */
export async function loadSelfModel(home: string = os.homedir()): Promise<SelfModel> {
  try {
    const raw = await fs.readFile(selfModelPath(home), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SelfModel>;
    if (parsed?.version === 1 && Array.isArray(parsed.beliefs) && Array.isArray(parsed.goals)) {
      return {
        version: 1,
        beliefs: parsed.beliefs,
        goals: parsed.goals,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    }
    return emptyModel();
  } catch {
    return emptyModel();
  }
}

// 进程内互斥链（对齐 suggestions.ts）：所有写操作串行，失败不毒化链
let modelLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = modelLock.then(fn);
  modelLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeModel(m: SelfModel, home: string): Promise<void> {
  const p = selfModelPath(home);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), 'utf-8');
  await fs.rename(tmp, p); // 原子写：不留半截 JSON
}

function nextId(prefix: 'belief' | 'goal', m: SelfModel): string {
  const n = (prefix === 'belief' ? m.beliefs.length : m.goals.length) + 1;
  // 用 random 后缀避免删过条目后 id 复用（id 要能当引用用）
  return `${prefix}-${String(n).padStart(4, '0')}-${crypto.randomBytes(2).toString('hex')}`;
}

// ────────────────────────── 信念：立 / 印证 / 反证 / 退役 ──────────────────────────

export type AdoptOutcome =
  | { outcome: 'created'; id: string }
  | { outcome: 'reinforced'; id: string; confidence: number }
  | { outcome: 'contested'; id: string; with: string };

export interface AdoptInput {
  statement: string;
  kind?: BeliefKind;
  origin?: BeliefOrigin;
  confidence?: number;
  evidence?: string;
}

/**
 * 立一条信念（入库即演化）：
 * - 撞底线 → 抛错；空陈述 → 抛错
 * - 与同类既有信念相似 ≥ MERGE_THRESHOLD → 印证加强（不重复入库）
 * - 与既有反向（相似 ≥ 0.5 且否定词一有一无）→ **两边都标 contested**，旧的不覆盖
 */
export async function adoptBelief(input: AdoptInput, home: string = os.homedir()): Promise<AdoptOutcome> {
  return withLock(async () => {
    const statementRaw = (input.statement ?? '').trim();
    if (!statementRaw) throw new Error('信念陈述为空');
    const floor = violatesFloor(statementRaw);
    if (floor) throw new Error(`信念撞底线 (不许用信念改写门控/权限/审计/凭据): ${floor}`);
    const statement = clampStatement(statementRaw);
    const kind = input.kind ?? 'method';
    const origin = input.origin ?? 'self';
    const now = new Date().toISOString();

    const m = await loadSelfModel(home);

    // 只在同类信念里比对（跨类相似多半是巧合措辞）
    let best: { sim: number; idx: number } | null = null;
    m.beliefs.forEach((b, idx) => {
      if (b.status === 'retired' || b.kind !== kind) return;
      const sim = jaccard(statement, b.statement);
      if (!best || sim > best.sim) best = { sim, idx };
    });

    if (best) {
      const { sim, idx } = best as { sim: number; idx: number };
      const old = m.beliefs[idx];
      // 反向：新信念入库，旧信念也标 contested —— 不覆盖，留给人裁
      if (sim >= 0.5 && hasNegation(statement) !== hasNegation(old.statement)) {
        old.status = 'contested';
        old.contradictions += 1;
        old.updatedAt = now;
        const id = nextId('belief', m);
        m.beliefs.push({
          id,
          statement,
          kind,
          origin,
          confidence: Math.min(1, Math.max(0, input.confidence ?? baseConfidence(origin))),
          evidence: input.evidence ? [input.evidence] : [],
          status: 'contested',
          confirmations: 0,
          contradictions: 0,
          createdAt: now,
          updatedAt: now,
        });
        m.updatedAt = now;
        await writeModel(m, home);
        return { outcome: 'contested', id, with: old.id } as AdoptOutcome;
      }
      if (sim >= MERGE_THRESHOLD) {
        old.confirmations += 1;
        old.confidence = Math.min(0.99, old.confidence + 0.05);
        if (old.status === 'contested' && old.contradictions === 0) old.status = 'active';
        if (input.evidence && !old.evidence.includes(input.evidence)) old.evidence.push(input.evidence);
        old.updatedAt = now;
        m.updatedAt = now;
        await writeModel(m, home);
        return { outcome: 'reinforced', id: old.id, confidence: old.confidence } as AdoptOutcome;
      }
    }

    if (m.beliefs.length >= MAX_BELIEFS) {
      throw new Error(`信念数已达上限 ${MAX_BELIEFS}（先退役旧信念）`);
    }
    const id = nextId('belief', m);
    m.beliefs.push({
      id,
      statement,
      kind,
      origin,
      confidence: Math.min(1, Math.max(0, input.confidence ?? baseConfidence(origin))),
      evidence: input.evidence ? [input.evidence] : [],
      status: 'active',
      confirmations: 0,
      contradictions: 0,
      createdAt: now,
      updatedAt: now,
    });
    m.updatedAt = now;
    await writeModel(m, home);
    return { outcome: 'created', id } as AdoptOutcome;
  });
}

/** 手动印证一条既有信念（置信上调，有上限） */
export async function reinforceBelief(id: string, home: string = os.homedir()): Promise<number> {
  return withLock(async () => {
    const m = await loadSelfModel(home);
    const b = m.beliefs.find((x) => x.id === id);
    if (!b) throw new Error(`没有这个信念 id: ${id}`);
    b.confirmations += 1;
    b.confidence = Math.min(0.99, b.confidence + 0.1);
    b.updatedAt = new Date().toISOString();
    m.updatedAt = b.updatedAt;
    await writeModel(m, home);
    return b.confidence;
  });
}

/** 反证一条信念：置信下调；跌破阈值或反证多于印证 ⇒ 标 contested（不删，留给人工裁） */
export async function contradictBelief(
  id: string,
  evidence?: string,
  home: string = os.homedir(),
): Promise<BeliefStatus> {
  return withLock(async () => {
    const m = await loadSelfModel(home);
    const b = m.beliefs.find((x) => x.id === id);
    if (!b) throw new Error(`没有这个信念 id: ${id}`);
    b.contradictions += 1;
    b.confidence = Math.max(0, b.confidence - 0.2);
    if (evidence && !b.evidence.includes(evidence)) b.evidence.push(evidence);
    if (b.confidence < MIN_DRIVING_CONFIDENCE || b.contradictions > b.confirmations) b.status = 'contested';
    b.updatedAt = new Date().toISOString();
    m.updatedAt = b.updatedAt;
    await writeModel(m, home);
    return b.status;
  });
}

/** 退役一条信念（留档，不再支配行动） */
export async function retireBelief(id: string, home: string = os.homedir()): Promise<void> {
  return withLock(async () => {
    const m = await loadSelfModel(home);
    const b = m.beliefs.find((x) => x.id === id);
    if (!b) throw new Error(`没有这个信念 id: ${id}`);
    b.status = 'retired';
    b.updatedAt = new Date().toISOString();
    m.updatedAt = b.updatedAt;
    await writeModel(m, home);
  });
}

// ────────────────────────── 目标：立 / 推进 / 结束 / 派生 ──────────────────────────

export interface GoalInput {
  statement: string;
  /** 不给 → 由支撑信念的类别推断；再没有 → 短期 */
  horizon?: GoalHorizon;
  supports?: string[];
  priority?: number;
}

export type GoalOutcome = { outcome: 'created'; id: string } | { outcome: 'merged'; id: string };

/** 立一个自定目标（相似目标不重复立，只并进支撑信念） */
export async function addSelfGoal(input: GoalInput, home: string = os.homedir()): Promise<GoalOutcome> {
  return withLock(async () => {
    const raw = (input.statement ?? '').trim();
    if (!raw) throw new Error('目标陈述为空');
    const floor = violatesFloor(raw);
    if (floor) throw new Error(`目标撞底线: ${floor}`);
    const statement = clampStatement(raw);
    const now = new Date().toISOString();

    const m = await loadSelfModel(home);

    // 支撑信念：没指定就按语句相似度自动挂（行动理由要能追溯）
    let supports = [...(input.supports ?? [])];
    if (supports.length === 0) {
      const driving = drivingBeliefs(m);
      let pick: { id: string; sim: number } | null = null;
      for (const b of driving) {
        const sim = jaccard(statement, b.statement);
        if (!pick || sim > pick.sim) pick = { id: b.id, sim };
      }
      if (pick && pick.sim > 0.1) supports = [pick.id];
    }

    // 时间尺度：显式给 > 由支撑信念类别推断 > 默认短期（短期可落地，长期是方向）
    const horizon =
      input.horizon ??
      (supports.length > 0
        ? (() => {
            const b = m.beliefs.find((x) => x.id === supports[0]);
            return b ? horizonForKind(b.kind) : 'short';
          })()
        : 'short');

    // 已有相似未结束目标 → 并入，不重复立
    const existing = m.goals.find((g) => !isTerminalGoal(g) && jaccard(statement, g.statement) >= MERGE_THRESHOLD);
    if (existing) {
      for (const s of supports) if (!existing.supports.includes(s)) existing.supports.push(s);
      existing.priority = Math.max(existing.priority, Math.min(1, Math.max(0, input.priority ?? 0.5)));
      existing.updatedAt = now;
      m.updatedAt = now;
      await writeModel(m, home);
      return { outcome: 'merged', id: existing.id } as GoalOutcome;
    }

    if (m.goals.length >= MAX_GOALS) throw new Error(`目标数已达上限 ${MAX_GOALS}（先结束旧目标）`);
    const id = nextId('goal', m);
    m.goals.push({
      id,
      statement,
      horizon,
      supports,
      priority: Math.min(1, Math.max(0, input.priority ?? 0.5)),
      state: 'proposed',
      progress: [],
      createdAt: now,
      updatedAt: now,
    });
    m.updatedAt = now;
    await writeModel(m, home);
    return { outcome: 'created', id } as GoalOutcome;
  });
}

/** 从生效信念派生目标（已有在推目标的信念跳过；返回新建的 id） */
export async function deriveGoals(home: string = os.homedir()): Promise<string[]> {
  const m = await loadSelfModel(home);
  const created: string[] = [];
  for (const b of drivingBeliefs(m)) {
    const already = m.goals.some((g) => !isTerminalGoal(g) && g.supports.includes(b.id));
    if (already) continue;
    const statement =
      b.kind === 'method'
        ? `把「${b.statement}」用在这周的第一件实际任务上`
        : b.kind === 'worldview'
          ? `检验「${b.statement}」在真实协作里是否成立`
          : b.kind === 'value'
            ? `按「${b.statement}」做事, 并留下能被检查的证据`
            : `让「${b.statement}」在每次回应里站得住`;
    try {
      const out = await addSelfGoal(
        { statement, horizon: horizonForKind(b.kind), supports: [b.id], priority: b.confidence },
        home,
      );
      if (out.outcome === 'created') created.push(out.id);
    } catch {
      // 撞底线/超上限 → 跳过，不让派生整体失败
    }
  }
  return created;
}

/** 切目标状态（结束态写进 progress 留痕） */
export async function setGoalState(
  id: string,
  state: SelfGoalState,
  note?: string,
  home: string = os.homedir(),
): Promise<void> {
  return withLock(async () => {
    const m = await loadSelfModel(home);
    const g = m.goals.find((x) => x.id === id);
    if (!g) throw new Error(`没有这个目标 id: ${id}`);
    g.state = state;
    g.updatedAt = new Date().toISOString();
    if (note) g.progress.push(`[${GOAL_STATE_LABEL[state]}] ${note}`);
    else if (isTerminalGoal(g)) g.progress.push(`[${GOAL_STATE_LABEL[state]}] (无说明)`);
    m.updatedAt = g.updatedAt;
    await writeModel(m, home);
  });
}

/** 记一笔推进（同时刷新 lastActedAt，供冷却） */
export async function noteGoalProgress(id: string, note: string, home: string = os.homedir()): Promise<void> {
  return withLock(async () => {
    const m = await loadSelfModel(home);
    const g = m.goals.find((x) => x.id === id);
    if (!g) throw new Error(`没有这个目标 id: ${id}`);
    const now = new Date().toISOString();
    g.progress.push(clampStatement(note));
    g.lastActedAt = now;
    g.updatedAt = now;
    if (g.state === 'proposed') g.state = 'active';
    m.updatedAt = now;
    await writeModel(m, home);
  });
}

// ────────────────────────── 主动性：按信念挑一步交给 agent ──────────────────────────

export interface SelfModelTickResult {
  acted: boolean;
  goalId?: string;
  summary?: string;
  reason?: string;
}

/**
 * 主动性一拍（cron / 空闲时调用）：
 *
 * 1. 没立过信念 → 不动（主动性没有方向，不许空转）
 * 2. busy 或不够空闲 → 不动
 * 3. 按信念挑一步 → 写进既有 suggestion 队列（cron 的既有通道），并记 lastActedAt
 *
 * 不直接开 Goal：升级成 Goal 由 agent/用户决定（不越 goal-flywheel 的冻结纪律）。
 */
export async function selfModelTick(input: {
  now?: number;
  busy?: boolean;
  home?: string;
} = {}): Promise<SelfModelTickResult> {
  const now = input.now ?? Date.now();
  const home = input.home ?? os.homedir();
  const m = await loadSelfModel(home);
  if (m.beliefs.length === 0 && m.goals.length === 0) {
    return { acted: false, reason: '还没立过信念与目标 — 先 belief_add / goal_add' };
  }
  if (input.busy) return { acted: false, reason: 'busy' };

  const action = pickNextAction(m, { now, busy: false });
  if (!action) {
    return { acted: false, reason: '没有可动的目标（都在冷却或置信不足）' };
  }
  const summary = `按信念行动（${HORIZON_LABEL[action.horizon]}目标 ${action.goalId}）: ${action.statement} — 理由: ${action.reason}`;
  try {
    const { addSuggestion } = await import('../cron/suggestions.js');
    await addSuggestion({ dedupKey: `self-model:${action.goalId}`, summary, source: 'strategy' }, home);
  } catch (e) {
    return { acted: false, reason: `建议队列写入失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  // 记一次"动过"，让同一目标进入冷却（防止每拍都催同一件事）
  await noteGoalProgress(action.goalId, `主动性派单: ${summary.slice(0, 80)}`, home);
  return { acted: true, goalId: action.goalId, summary };
}