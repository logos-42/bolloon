/**
 * model-policy.ts — 长期任务 / Supervisor 的模型策略 (P7, 2026-09-26)
 *
 * 要解决的问题: 一个跑到一半的长任务, 用户切了全局默认模型 —— 这条执行链会不会**静默漂移**?
 * 「漂移」的三种表现都在这层堵掉:
 *   ① 在跑的 Run 被改成新模型 (历史执行链再也解释不清);
 *   ② 新 Run 该用新模型却继续吃旧的 (用户切了不生效);
 *   ③ 模型换了, 于是已经成功执行过的**非幂等动作**被重做一遍 (重复写文件 / 重复付款 / 重复提交)。
 *
 * 三条规则 (与计划 P7 逐条对齐):
 *   · 切 Global **不自动改写正在执行的 Run**; 新 Run 默认用最新 Global。
 *   · 同一个 Goal 换不换模型由 Goal 的 `modelPolicy` 决定:
 *       `auto`    新 Run 可换 (当前 Run 不换); 允许 Supervisor 按**模型相关**失败类别挑备用模型
 *       `pinned`  该 Goal 全程固定 provider/model/baseUrl (与实际快照冲突时**不改写**, 只留冲突事实)
 *       `session` 只跟随当前交互会话的绑定; Global 的新默认**不传播**进这个 Goal
 *   · 发生切换**写 Run 事件**; 模型变了**不构成**重跑非幂等工具的理由 (守卫照带)。
 *
 * 事实边界 (与记录层/入口层的分工):
 *   · **真源**是 Run 自己的模型快照 `RunRecord.modelConfig` (P1 定稿) —— 本层不另建一份配置来源,
 *     也不复算它: `intent='current_run'` 时**原样**返回快照, 一个字都不改。
 *   · 本层算出来的 `to` 只用于**下一个 Run 的启动快照**和**切换事件**; 它绝不回写老 Run 的快照。
 *   · 策略解析纯函数化 (`resolveRunModel` 不碰磁盘), I/O 壳在文件后半段 (`resolveNextRunModel`)。
 *
 * 策略存哪: `~/.bolloon/model-policy/<goalId>.json` (与 Goal 记录同级目录, 加成文件)。
 * 为什么不写进 Goal 记录: Goal 记录是别处的写入面, 本层不改它; 而 Goal 记录上**若**已带
 * `modelPolicy` 字段 (未来主线补上), 本层**优先读它** —— 那条路一旦接通, sidecar 自动让位。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  configHashOf,
  normalizeBaseUrl,
  effectiveModelConfig,
  readSessionSelection,
  type EffectiveModelConfig,
  type ModelSelection,
  type RunModelConfig,
} from '../llm/model-selection.js';

import {
  argsDigestOf,
  isNonIdempotentTool,
  readRun,
  recordModelSwitch,
  type ErrorClass,
  type RunRecord,
  type RunStatus,
  type RunModelSwitchEvent,
  type RunModelSwitchMode,
} from './run-store.js';

// ============================================================
// 类型: 策略
// ============================================================

/** `auto` 新 Run 可换 / `pinned` 全程固定 / `session` 只跟随当前交互会话 */
export type GoalModelPolicyMode = 'auto' | 'pinned' | 'session';

/** `pinned` 的固定三元组 (baseUrl 归一化后存; 缺 baseUrl = 用该 provider 的默认 URL, 由入口层解析) */
export interface GoalModelPin {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface GoalModelPolicy {
  mode: GoalModelPolicyMode;
  /** 仅 `pinned` 有意义 (且必须完整, 否则按保守语义处理) */
  pin?: GoalModelPin;
  updatedAt?: string;
  /** 谁写的 (人 / supervisor / cli); 只作审计 */
  updatedBy?: string;
  note?: string;
}

/** 策略从哪读到的 (读不到就是默认, 不假装用户设过) */
export type GoalModelPolicyOrigin = 'goal_record' | 'sidecar' | 'default' | 'invalid';

export interface GoalModelPolicyView {
  /** 解析后的策略 (任何情况下都有一个可用的; 解析失败时是保守策略) */
  policy: GoalModelPolicy;
  origin: GoalModelPolicyOrigin;
  /** 解析失败/降级的原因 (ok=true 时为空) */
  problems: string[];
  /** 盘上原始的 Policy 值 (审计/复现用; 读不到就是 undefined) */
  raw?: unknown;
}

export interface PolicyParseResult {
  ok: boolean;
  policy: GoalModelPolicy;
  reason?: string;
}

/**
 * 解析 Goal 模型策略。**两种输入都要能吃**: 记录字段直接给的对象 / sidecar 文件里的对象。
 *
 * 缺省与降级的口径 (宁可不动, 也不擅自跟随全局):
 *   · 没有这个字段 (`undefined`/`null`) → `auto` (计划里 `auto` 是未声明时的默认行为), ok=true;
 *   · 未知模式 (拼错 / 新版本写的未来值) → 保留字面模式不识别 → 降级成**冻结语义**的 `auto` 且 ok=false,
 *     并把原文原因带出去 (调用方记事件时必须照说, 不许美化);
 *   · `pinned` 缺 provider/model → ok=false (不完整的固定 = 谁也不许换)。
 */
export function parseGoalModelPolicy(raw: unknown): PolicyParseResult {
  if (raw === undefined || raw === null) {
    return { ok: true, policy: { mode: 'auto' }, reason: 'Goal 未声明 modelPolicy → 按 auto (新 Run 可换, 当前 Run 不换)' };
  }
  const obj = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!obj || typeof obj !== 'object') {
    return { ok: false, policy: { mode: 'auto' }, reason: `modelPolicy 不是对象 (收到 ${typeof raw}) → 降级为 auto, 且不自动改写在跑的 Run` };
  }
  const rec = obj as Record<string, unknown>;
  const rawMode = String(rec.mode ?? '').trim().toLowerCase();
  if (rawMode === 'auto' || rawMode === 'pinned' || rawMode === 'session') {
    const policy: GoalModelPolicy = { mode: rawMode };
    if (rec.note !== undefined) policy.note = String(rec.note).slice(0, 300);
    if (rec.updatedBy !== undefined) policy.updatedBy = String(rec.updatedBy).slice(0, 100);
    if (rec.updatedAt !== undefined) policy.updatedAt = String(rec.updatedAt).slice(0, 40);
    if (rawMode === 'pinned') {
      const pinRaw = (rec.pin ?? {}) as Record<string, unknown>;
      const provider = String(pinRaw.provider ?? rec.provider ?? '').trim().toLowerCase();
      const model = String(pinRaw.model ?? rec.model ?? '').trim();
      const baseUrl = String(pinRaw.baseUrl ?? rec.baseUrl ?? '').trim();
      if (!provider || !model) {
        return { ok: false, policy: { mode: 'pinned' }, reason: 'pinned 策略缺 pin.provider/pin.model → 固定不下来 (保守: 保持原模型, 不跟随全局)' };
      }
      policy.pin = { provider, model, ...(baseUrl ? { baseUrl: normalizeBaseUrl(baseUrl) } : {}) };
    }
    return { ok: true, policy };
  }
  return {
    ok: false,
    policy: { mode: 'auto' },
    reason: `未知的 modelPolicy.mode='${String(rec.mode)}' (只认 auto/pinned/session) → 降级为 auto 且**不自动改写在跑的 Run**`,
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** 策略存成一行给人看: 三种模式各自的语义都要能读出来 */
export function describeGoalModelPolicy(p: GoalModelPolicy): string {
  switch (p.mode) {
    case 'pinned':
      return p.pin
        ? `pinned · 全程固定 ${p.pin.provider}/${p.pin.model}${p.pin.baseUrl ? ` @ ${p.pin.baseUrl}` : ' @ 供应商默认 URL'}`
        : 'pinned · 但固定配置不完整 (保守: 谁都不许换)';
    case 'session':
      return 'session · 只跟随当前交互会话的绑定 (Global 的新默认不传播进这个 Goal)';
    default:
      return 'auto · 新 Run 用最新默认, 当前 Run 不换; Supervisor 可按模型相关失败类别挑备用';
  }
}

// ============================================================
// 类型: 决定
// ============================================================

/** 调用方问的是什么: 这条 Run 现在该用什么 / 下一个 Run 该用什么 */
export type ModelIntent = 'current_run' | 'next_run';

/** 配置来自哪一层 (与 RunModelSwitchEvent.source 同域) */
export type ModelConfigSource = 'run_snapshot' | 'goal_pin' | 'session' | 'global' | 'supervisor_fallback' | 'none';

export interface ModelConflictField {
  /** `snapshot` = 与 Goal 的固定策略冲突的那一侧 */
  field: 'provider' | 'model' | 'baseUrl';
  snapshot: string;
  pinned: string;
}

export interface RunModelDecision {
  intent: ModelIntent;
  /** 这条 Run 的 id (决定是**关于哪条 Run** 的) */
  runId: string;
  goalId?: string;
  mode: GoalModelPolicyMode | 'unknown';
  /** 策略是否解析成功 (false 时 mode 只是回退值, 语义是"谁都不许换") */
  policyOk: boolean;
  /**
   * 这个 Run (或下一个 Run) 该用的那一份。
   * `null` = 拿不到一份可信的配置 (老 Run 没有快照 / 没有可用 Global) —— 如实说"没有", 不编一份。
   */
  config: RunModelConfig | null;
  source: ModelConfigSource;
  /** 是否发生了相对「当前记录里的那一份」的模型变化 */
  switched: boolean;
  /** 是否被策略冻住 (在跑的 Run / pinned / 策略解析失败): 冻住 = 不许换, 也不许被上游改写 */
  frozen: boolean;
  /** 与 Goal 固定策略的冲突事实 (只有 pinned 才可能非空) */
  conflict: ModelConflictField[];
  /** 人可读理由 (可直接落事件/打给用户) */
  reason: string;
}

/** 终态 = 这条 Run 不会再执行; 其余 (含 stalled/interrupted/paused) 都算"还在链子上", 快照是权威 */
export const TERMINAL_RUN_STATUSES: RunStatus[] = ['done', 'failed', 'aborted'];

export function isTerminalRunStatus(status: RunStatus | string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as RunStatus);
}

/**
 * 从一份配置算出 Run 快照 (与 `runModelConfigOf` 同一 hash 算法 —— 不另写一份摘要函数)。
 * 归一化在这里做: 同一个地址写 `http://h/v1/` 和 `http://h/v1` 必须得到同一个 hash。
 */
export function runConfigOf(opts: {
  provider: string;
  model: string;
  baseUrl: string;
  selectionScope: RunModelConfig['selectionScope'];
  capturedAt?: string;
}): RunModelConfig {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || '');
  return {
    provider: String(opts.provider || ''),
    model: String(opts.model || ''),
    baseUrl,
    configHash: configHashOf({ provider: String(opts.provider || ''), model: String(opts.model || ''), baseUrl }),
    selectionScope: opts.selectionScope,
    capturedAt: opts.capturedAt || new Date().toISOString(),
  };
}

function sameConfig(a: RunModelConfig | null | undefined, b: RunModelConfig | null | undefined): boolean {
  if (!a || !b) return false;
  return a.configHash === b.configHash
    && normalizeBaseUrl(a.baseUrl || '') === normalizeBaseUrl(b.baseUrl || '')
    && a.provider === b.provider
    && a.model === b.model;
}

// ============================================================
// 纯函数: 核心决定
// ============================================================

export interface ResolveRunModelInput {
  intent: ModelIntent;
  /** 关于哪条 Run 的决定 (current_run 必传; next_run 时是"上一个 Run", 可省) */
  run?: Pick<RunRecord, 'runId' | 'goalId' | 'status' | 'modelConfig'> | null;
  /** Goal 策略 (原始值也行 —— 内部会解析) */
  policy?: unknown;
  /** 策略解析问题的留痕 (origin=invalid 时把它带进 reason) */
  policyProblems?: string[];
  /** 最新**有效**默认配置 (调用方算好传进来; 不传 = 没有可用默认) */
  latest?: EffectiveModelConfig | null;
  /** 会话层绑定 (mode=session 用) */
  sessionBinding?: ModelSelection | null;
  /** 调用方要按同一时刻定稿 (测试/复现用) */
  now?: string;
}

/**
 * 唯一决定函数 (纯函数: 不读盘、不写盘)。
 *
 * 语义表 (逐行可判):
 *
 * | intent        | 条件                                   | config 来源       | frozen | switched |
 * | ------------- | -------------------------------------- | ----------------- | ------ | -------- |
 * | current_run   | 有快照                                 | **Run 快照**      | true   | false    |
 * | current_run   | 无快照 (P1 之前的老记录)                | null (不编造)     | true   | false    |
 * | next_run auto | 有最新有效默认                          | 最新默认          | false  | hash 不同则 true |
 * | next_run auto | 没有最新有效默认                        | 上一份快照        | true   | false    |
 * | next_run pinned | pin 完整                              | Goal 固定三元组   | false  | hash 不同则 true |
 * | next_run pinned | pin 不完整 (或策略解析失败)             | 上一份快照/最新默认 | true  | false    |
 * | next_run session | 有会话绑定                            | 会话绑定          | false  | hash 不同则 true |
 * | next_run session | 无会话绑定                             | 上一份快照, 再退最新默认 | true | false |
 *
 * `switched=true` 只说明"这一份与记录里的那份不同" —— 它是**事实**陈述, 不是"切换被允许"。
 */
export function resolveRunModel(input: ResolveRunModelInput): RunModelDecision {
  const parsed = parseGoalModelPolicy(input.policy);
  const problems = [...(input.policyProblems || []), ...(parsed.reason && !parsed.ok ? [parsed.reason] : [])];
  const policy = parsed.policy;
  const prev = input.run?.modelConfig || null;
  const runId = input.run?.runId || '';
  const goalId = input.run?.goalId;
  const now = input.now || new Date().toISOString();
  const base = {
    intent: input.intent,
    runId,
    goalId,
    mode: parsed.ok ? policy.mode : ('unknown' as const),
    policyOk: parsed.ok,
    conflict: [] as ModelConflictField[],
  };

  // ── ① 这条 Run 自己: 快照是**唯一真源**, 一个字都不改 ──────────────
  if (input.intent === 'current_run') {
    const conflict = policy.mode === 'pinned' && policy.pin && prev ? pinConflict(prev, policy.pin) : [];
    if (!prev) {
      return {
        ...base, config: null, source: 'none', switched: false, frozen: true, conflict,
        reason: `这条 Run 没有模型快照 (P1 之前的老记录) → 无法回答它当时用哪一份, 也不替它改写成新默认`,
      };
    }
    const reasons = [
      `正在执行的 Run 用**自己的快照** (${prev.provider}/${prev.model} @ ${prev.baseUrl}, hash=${prev.configHash})`,
      'Global 切换不自动改写它的快照',
    ];
    if (conflict.length) reasons.push(`但它与 Goal 的 pinned 固定策略不符 (${conflict.map((c) => c.field).join(', ')}) → 只留冲突事实, 不在跑动中换模型`);
    if (!parsed.ok) reasons.push(`策略解析失败 (${problems.join('; ')}) → 保守: 保持原模型`);
    return {
      ...base, config: prev, source: 'run_snapshot', switched: false, frozen: true, conflict,
      reason: reasons.join('; '),
    };
  }

  // ── ② 下一个 Run: 由策略决定 ──────────────────────────────────────
  const latestConfig: RunModelConfig | null = input.latest
    ? runConfigOf({
      provider: input.latest.provider,
      model: input.latest.model,
      baseUrl: input.latest.baseUrl,
      selectionScope: input.latest.source,
      capturedAt: now,
    })
    : null;

  // 策略用不了 (解析失败 / pinned 不完整) → 冻住: 能不动就不动
  const policyUnusable = !parsed.ok || (policy.mode === 'pinned' && !policy.pin);

  if (policyUnusable) {
    const keep = prev || latestConfig;
    return {
      ...base,
      config: keep,
      source: prev ? 'run_snapshot' : (latestConfig ? 'global' : 'none'),
      switched: false,
      frozen: true,
      reason: keep
        ? `策略不可用 (${problems.join('; ') || 'pinned 缺固定配置'}) → 保守: 沿用 ${prev ? '上一个 Run 的快照' : '最新默认'}, **不**跟随全局切换`
        : `策略不可用 (${problems.join('; ') || 'pinned 缺固定配置'}) 且没有任何可用配置 → 无法为新 Run 定一份模型`,
    };
  }

  if (policy.mode === 'pinned' && policy.pin) {
    const pinned = runConfigOf({
      provider: policy.pin.provider,
      model: policy.pin.model,
      baseUrl: policy.pin.baseUrl || latestConfig?.baseUrl || '',
      selectionScope: 'run',       // Goal 显式绑定 = 优先级最高的那一层
      capturedAt: now,
    });
    if (!pinned.baseUrl) {
      // 固定里没写 URL, 又没有可继承的默认 → 缺一块就是缺一块, 不猜
      return {
        ...base, config: null, source: 'goal_pin', switched: false, frozen: true,
        reason: `pinned 固定了 ${policy.pin.provider}/${policy.pin.model}, 但 baseUrl 既未固定也无处继承 → 不为新 Run 编造地址`,
      };
    }
    return {
      ...base, config: pinned, source: 'goal_pin', switched: !sameConfig(prev, pinned), frozen: false,
      reason: pinned.provider === prev?.provider && pinned.model === prev?.model && normalizeBaseUrl(pinned.baseUrl) === normalizeBaseUrl(prev?.baseUrl || '')
        ? `pinned: 新 Run 用的仍是固定那一条 (${pinned.provider}/${pinned.model} @ ${pinned.baseUrl})`
        : `pinned: 新 Run 用 Goal 固定的 ${pinned.provider}/${pinned.model} @ ${pinned.baseUrl} (与上一个 Run 的 ${prev ? `${prev.provider}/${prev.model} hash=${prev.configHash}` : '无快照'} 不同)`,
    };
  }

  if (policy.mode === 'session') {
    const sb = input.sessionBinding;
    if (sb && sb.provider && sb.model) {
      const fromSession = runConfigOf({
        provider: sb.provider,
        model: sb.model,
        baseUrl: sb.baseUrl || latestConfig?.baseUrl || '',
        selectionScope: 'session',
        capturedAt: now,
      });
      return {
        ...base, config: fromSession, source: 'session', switched: !sameConfig(prev, fromSession), frozen: false,
        reason: `session: 新 Run 跟随当前交互会话的绑定 (${fromSession.provider}/${fromSession.model} @ ${fromSession.baseUrl}); Global 的切换不传播进这个 Goal`,
      };
    }
    const keep = prev || latestConfig;
    return {
      ...base,
      config: keep,
      source: prev ? 'run_snapshot' : (latestConfig ? 'global' : 'none'),
      switched: false,
      frozen: true,
      reason: keep
        ? `session: 当前没有会话绑定 → 保守沿用 ${prev ? '上一个 Run 的快照 (不让 Global 的新默认漏进来)' : '最新默认 (首次执行)'}`
        : 'session: 当前没有会话绑定, 也没有任何可用配置 → 无法为新 Run 定一份模型',
    };
  }

  // auto
  if (!latestConfig) {
    const keep = prev;
    return {
      ...base,
      config: keep, source: prev ? 'run_snapshot' : 'none', switched: false, frozen: true,
      reason: keep
        ? `auto: 读不到最新有效默认 → 保守沿用上一个 Run 的快照 (${keep.provider}/${keep.model} hash=${keep.configHash}), 不假装换了`
        : 'auto: 读不到最新有效默认, 也没有历史快照 → 无法为新 Run 定一份模型',
    };
  }
  return {
    ...base, config: latestConfig, source: 'global', switched: !sameConfig(prev, latestConfig), frozen: false,
    reason: prev
      ? (sameConfig(prev, latestConfig)
        ? `auto: 新 Run 用最新默认 (与上一个 Run 同一份, hash=${latestConfig.configHash})`
        : `auto: 新 Run 用最新默认 ${latestConfig.provider}/${latestConfig.model} @ ${latestConfig.baseUrl} (hash=${latestConfig.configHash}); 上一个 Run 是 ${prev.configHash}`)
      : `auto: 首次执行, 用最新默认 (${latestConfig.provider}/${latestConfig.model} @ ${latestConfig.baseUrl})`,
  };
}

function pinConflict(snapshot: RunModelConfig, pin: GoalModelPin): ModelConflictField[] {
  const out: ModelConflictField[] = [];
  if (snapshot.provider !== pin.provider) out.push({ field: 'provider', snapshot: snapshot.provider, pinned: pin.provider });
  if (snapshot.model !== pin.model) out.push({ field: 'model', snapshot: snapshot.model, pinned: pin.model });
  if (pin.baseUrl && normalizeBaseUrl(snapshot.baseUrl || '') !== normalizeBaseUrl(pin.baseUrl)) {
    out.push({ field: 'baseUrl', snapshot: normalizeBaseUrl(snapshot.baseUrl || ''), pinned: normalizeBaseUrl(pin.baseUrl) });
  }
  return out;
}

/** 一行决定 (CLI/UI/日志都能直接用) */
export function formatModelDecision(d: RunModelDecision): string {
  const cfg = d.config
    ? `${d.config.provider}/${d.config.model} @ ${d.config.baseUrl} (hash=${d.config.configHash}, scope=${d.config.selectionScope})`
    : '(没有可用的模型配置)';
  return `${d.intent} · mode=${d.mode} · source=${d.source} · ${d.switched ? '已换' : (d.frozen ? '冻结' : '未换')} · ${cfg} · ${d.reason}`;
}

// ============================================================
// 非幂等守卫: 模型变了 ≠ 可以重做副作用
// ============================================================

export interface ReplayGuard {
  tool: string;
  argsDigest?: string;
  summary: string;
}

export interface SwitchContinuationPlan {
  /** 与上一个 Run 的快照比, 模型是否真的变了 (变了也要带守卫) */
  modelChanged: boolean;
  from: RunModelConfig | null;
  to: RunModelConfig | null;
  /** 跨 Run **必须**守住的非幂等动作 (模型切换不构成清空理由) */
  guards: ReplayGuard[];
  /** 上一个 Run 已成功的非幂等动作条数 (分母) */
  previousGuardCount: number;
  /**
   * 没被带上的守卫条数 (**恒应为 0**)。非 0 = 这一层把"模型变了"当成了"可以从头再来",
   * 那是重复副作用的入口 —— 验收拿它判红, 不靠人去读代码。
   */
  guardsDropped: number;
  /** 给下一个 Run 的指令补充 (明确写"不许重做") */
  instructionNote: string;
}

/** 一条 Run 里已成功的**非幂等**动作 (恢复/续跑的守卫来源; 与 run-store 的算法一致) */
export function guardsOfRun(rec: Pick<RunRecord, 'steps'>): ReplayGuard[] {
  return (rec.steps || [])
    .filter((s) => s.ok && isNonIdempotentTool(s.tool))
    .map((s) => ({ tool: s.tool, argsDigest: s.argsDigest, summary: s.summary || '(已执行)' }));
}

/** 去重合并 (同 tool + 同指纹只留一条; 没有指纹的按 tool 留一条最保守的) */
export function mergeGuards(...lists: ReplayGuard[][]): ReplayGuard[] {
  const out: ReplayGuard[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const g of list || []) {
      const key = `${g.tool}\u0000${g.argsDigest || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool: g.tool, argsDigest: g.argsDigest, summary: g.summary });
    }
  }
  return out;
}

/**
 * 为"下一个 Run"生成跨 Run 守卫 —— 不管模型换没换。
 *
 * 为什么单独成函数 (而不是直接用 buildContinuationPlan): 模型切换这件事最容易被人顺手写成
 * 「换了模型 → 计划失效 → 从头再来」。这里把守卫**独立于模型决定**地算出来, 并且报出
 * `guardsDropped` 供门禁断言; 换模型的逻辑再怎么写, 都不该让这个数字变成非 0。
 */
export function planSwitchContinuation(opts: {
  prevRun: Pick<RunRecord, 'steps' | 'modelConfig'> | null;
  decision: RunModelDecision;
  /** 已算好的恢复计划 (来自 run-store.buildContinuationPlan); 不给就用 Run 步骤自己算 */
  plan?: { replayGuards?: ReplayGuard[] } | null;
}): SwitchContinuationPlan {
  const from = opts.prevRun?.modelConfig || null;
  const to = opts.decision.config;
  const previous = opts.prevRun ? guardsOfRun(opts.prevRun) : [];
  const guards = mergeGuards(opts.plan?.replayGuards || [], previous);
  const dropped = previous.filter((p) => !guards.some((g) => g.tool === p.tool && (g.argsDigest || '') === (p.argsDigest || ''))).length;
  const modelChanged = !!from && !!to ? !sameConfig(from, to) : false;
  const uniq = mergeGuards(guards).filter((g) => isNonIdempotentTool(g.tool));
  return {
    modelChanged,
    from,
    to,
    guards: uniq,
    previousGuardCount: previous.length,
    guardsDropped: dropped,
    instructionNote: uniq.length
      ? `${modelChanged ? '模型已切换' : '模型未变'}, 但以下非幂等动作**此前已成功执行过**, 绝不重复执行 (换模型不是重做副作用的理由): ${uniq.slice(-8).map((g) => g.tool).join(', ')}`
      : '没有需要守住的非幂等动作 (此前没有成功执行过这类工具)',
  };
}

/**
 * 「这一步要不要真执行」的唯一判定 (与执行链里的重放守卫同语义)。
 *
 * 匹配规则 (保守): 工具名相等 且 (守卫没记指纹 或 这一步没指纹 或 指纹相等) → 跳过。
 * 也就是说**只有确认是同一个动作**才跳过; 换了参数的动作照跑 (那是新动作, 不是重做)。
 */
export function shouldSkipAsReplay(guards: ReplayGuard[], tool: string, args: unknown): { skip: boolean; summary?: string } {
  const d = argsDigestOf(args);
  const hit = (guards || []).find((g) => g.tool === tool && (!g.argsDigest || !d || g.argsDigest === d));
  return hit ? { skip: true, summary: hit.summary } : { skip: false };
}

// ============================================================
// Supervisor: 按失败类别挑备用模型
// ============================================================

/** 与模型**相关**的失败类别: 换一个模型可能真的解决 (网络/鉴权/工具调用能力/输出不可解析) */
export const MODEL_RELATED_ERROR_CLASSES: ErrorClass[] = ['transient', 'auth', 'no_such_tool', 'unparsable'];

export interface FallbackVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Supervisor 能不能给下一个 Run 挑备用模型?
 *   auto  + 模型相关失败 → 允许 (计划原文: 允许 Supervisor 按失败类别选备用模型)
 *   auto  + 非模型相关   → 不允许 (工具参数错/策略拒绝/持久化失败, 换模型解决不了, 只会掩盖)
 *   pinned               → 不允许 (固定就是要可追溯; 只能暂停/找人)
 *   session              → 不允许 (只跟随交互会话, Supervisor 不在那个会话里)
 */
export function supervisorMaySwitchModel(opts: { mode: GoalModelPolicyMode | 'unknown'; errorClass?: ErrorClass }): FallbackVerdict {
  const cls = opts.errorClass;
  if (opts.mode !== 'auto') {
    return { allowed: false, reason: opts.mode === 'pinned'
      ? 'pinned: 全程固定 provider/model/baseUrl → Supervisor 不许挑备用模型 (只能暂停/找人)'
      : opts.mode === 'session'
        ? 'session: 模型只跟随当前交互会话 → Supervisor 不在那个会话里, 不许挑备用模型'
        : '策略模式未知 → 保守: 不许挑备用模型' };
  }
  if (!cls) return { allowed: false, reason: 'auto: 没有失败类别 → 不为"顺手换个模型"开门' };
  if (!MODEL_RELATED_ERROR_CLASSES.includes(cls)) {
    return { allowed: false, reason: `auto: 失败类别 ${cls} 与模型无关 (工具参数/权限/持久化/外部等待) → 换模型只会掩盖问题` };
  }
  return { allowed: true, reason: `auto: 失败类别 ${cls} 与模型相关 → 允许挑备用模型` };
}

/** 从候选里挑第一个**与当前不同**的一份 (同一份不算备用; 挑不到就如实说没有) */
export function pickFallbackConfig(
  current: RunModelConfig | null,
  candidates: RunModelConfig[],
): { ok: boolean; config?: RunModelConfig; reason: string } {
  for (const c of candidates || []) {
    if (!c || !c.provider || !c.model) continue;
    if (sameConfig(current, c)) continue;
    return { ok: true, config: c, reason: `备用模型: ${c.provider}/${c.model} @ ${c.baseUrl} (hash=${c.configHash})` };
  }
  return { ok: false, reason: '没有可用备用模型 (候选为空, 或全都与当前那一份相同)' };
}

// ============================================================
// 策略存储 (加成文件, 与 Goal 记录同级)
// ============================================================

export function modelPolicyDir(): string {
  return path.join(os.homedir(), '.bolloon', 'model-policy');
}

export function modelPolicyPath(goalId: string): string {
  return path.join(modelPolicyDir(), `${goalId}.json`);
}

/** 原子写 (tmp + rename + 0600): 读到的永远是完整 JSON */
async function writePolicyFile(goalId: string, value: GoalModelPolicy): Promise<void> {
  await fs.mkdir(modelPolicyDir(), { recursive: true });
  const p = modelPolicyPath(goalId);
  const tmp = `${p}.${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, p);
}

/**
 * 写 Goal 的策略 (统一入口: 归一化 + 加时间戳, 调用方不许自己拼 JSON)。
 * `pinned` 必须带完整 pin, 否则**拒绝写** (写一份用不了的策略比不写更坏)。
 */
export async function writeGoalModelPolicy(
  goalId: string,
  policy: GoalModelPolicy,
  opts: { updatedBy?: string } = {},
): Promise<{ ok: boolean; policy?: GoalModelPolicy; reason?: string }> {
  const parsed = parseGoalModelPolicy(policy);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const value: GoalModelPolicy = {
    ...parsed.policy,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.updatedBy || 'unknown',
  };
  await writePolicyFile(String(goalId), value);
  return { ok: true, policy: value };
}

/**
 * 读 Goal 的策略。
 * 优先 Goal 记录上的 `modelPolicy` 字段 (未来主线接上就自动生效); 没有才读 sidecar;
 * 都没有 = 未声明 (origin='default', 语义为 auto)。**读不到 ≠ 不许换**, 但读不到也**不许假装读到**。
 */
export async function readGoalModelPolicy(goalId: string, opts: { goalRecord?: unknown } = {}): Promise<GoalModelPolicyView> {
  let record: any = opts.goalRecord;
  if (record === undefined) {
    try {
      const { readGoal } = await import('./goal-store.js');
      record = await readGoal(String(goalId));
    } catch { record = null; }
  }
  const fromRecord = record && typeof record === 'object' ? (record as any).modelPolicy : undefined;
  if (fromRecord !== undefined && fromRecord !== null) {
    const parsed = parseGoalModelPolicy(fromRecord);
    return {
      policy: parsed.policy,
      origin: parsed.ok ? 'goal_record' : 'invalid',
      problems: parsed.ok ? [] : [parsed.reason || 'goal_record 上的 modelPolicy 解析失败'],
      raw: fromRecord,
    };
  }
  let fileText: string | undefined;
  try {
    fileText = await fs.readFile(modelPolicyPath(String(goalId)), 'utf8');
  } catch (err) {
    // 文件不存在 = 未声明 (不是"读到了一份坏策略"); 读失败 (权限/盘错) 要能被看见, 不能当成"没有"
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      return {
        policy: { mode: 'auto' },
        origin: 'invalid',
        problems: [`策略文件读不出来 (${code}): 按"未声明"处理, 但这一条要如实带出去`],
        raw: undefined,
      };
    }
    return { policy: { mode: 'auto' }, origin: 'default', problems: [], raw: undefined };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(fileText));
  } catch (err) {
    // 损坏 ≠ 没声明: 损坏要变成"保守 + 留痕", 不能静默当成默认策略
    return {
      policy: { mode: 'auto' },
      origin: 'invalid',
      problems: [`策略文件损坏 (${String((err as Error)?.message || err).slice(0, 120)}): 按保守语义处理 (不跟随全局), 并且这一条不许被说成"没有策略"`],
      raw: undefined,
    };
  }
  const parsed = parseGoalModelPolicy(raw);
  return {
    policy: parsed.policy,
    origin: parsed.ok ? 'sidecar' : 'invalid',
    problems: parsed.ok ? [] : [parsed.reason || 'sidecar 里的 modelPolicy 解析失败'],
    raw,
  };
}

// ============================================================
// I/O 壳: 一条命令算出「下一个 Run 该用什么」并写事件
// ============================================================

export interface ResolveCurrentRunModelOptions {
  policy?: unknown;
  /** 直接给一份"最新默认" (省略 = 自己读盘; 显式给 null = 断言"读不到任何默认") */
  latest?: LatestOverride;
  /** 是否把"冻结/冲突"这次决定写成 Run 事件 (查询默认不写事实) */
  record?: boolean;
  now?: string;
}

/** 允许调用方跳过读盘: 直接给一份最新默认 (测试/复现用) */
type LatestOverride = EffectiveModelConfig | null | undefined;

/**
 * 唯一 I/O 入口: 「这条**已在执行**的 Run 该用哪一份模型」。
 *
 * 回答只有一个基本面: **它自己的快照** (P1 定稿的那一份), 无论 Global 现在是什么。
 * 与 `resolveNextRunModel` 的分工: 这里回答"现在这条", 那里回答"下一条"。
 * `record=true` 时把结论写成 Run 事件 (含"与 pinned 策略冲突"这种必须留痕的事实)。
 */
export async function resolveCurrentRunModel(
  runId: string,
  opts: ResolveCurrentRunModelOptions = {},
): Promise<{ decision: RunModelDecision; policyOrigin: GoalModelPolicyOrigin; policyProblems: string[]; event?: { ok: boolean; reason?: string } } | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  let policy = opts.policy;
  let policyOrigin: GoalModelPolicyOrigin = 'default';
  let policyProblems: string[] = [];
  if (policy === undefined && rec.goalId) {
    const view = await readGoalModelPolicy(rec.goalId);
    policy = view.policy;
    policyOrigin = view.origin;
    policyProblems = view.problems;
  }
  let latest: EffectiveModelConfig | null = null;
  if (opts.latest !== undefined) latest = opts.latest || null;
  else { try { latest = await effectiveModelConfig({}); } catch { latest = null; } }

  const decision = resolveRunModel({ intent: 'current_run', run: rec, policy, policyProblems, latest, sessionBinding: null, now: opts.now });

  let event: { ok: boolean; reason?: string } | undefined;
  if (opts.record && decision.config) {
    const res = await recordModelSwitch(runId, {
      to: decision.config,
      from: rec.modelConfig || null,
      outcome: decision.conflict.length ? 'conflict' : 'frozen',
      mode: (decision.mode === 'auto' || decision.mode === 'pinned' || decision.mode === 'session' ? decision.mode : 'unknown') as RunModelSwitchMode,
      source: decision.source,
      reason: decision.reason.slice(0, 400),
      guardsCarried: 0,
      goalId: rec.goalId,
    });
    event = { ok: res.ok, reason: res.reason };
  }
  return { decision, policyOrigin, policyProblems, event };
}

export interface NextRunModelResolution {
  decision: RunModelDecision;
  /** 跨 Run 非幂等守卫 (模型变了也照带); 没有上一个 Run 时为 null */
  continuation: SwitchContinuationPlan | null;
  /** 新 Run 的启动快照 (给 `startRun({modelConfig})`); 拿不到配置时为 undefined */
  startRunModelConfig?: RunModelConfig;
  /** 事件写入结果 (记不上要说出来, 不许沉默) */
  event: { ok: boolean; reason?: string; onRunId?: string };
  /** 策略从哪读的 (审计) */
  policyOrigin: GoalModelPolicyOrigin;
  policyProblems: string[];
}

export interface ResolveNextRunModelOptions {
  /** Goal 的模型策略 (显式给就优先; 不给则从 Goal 记录 / sidecar 读) */
  policy?: unknown;
  goalId?: string;
  /** 上一个 Run (新 Run 要与它的快照比"换没换") */
  prevRunId?: string;
  sessionKey?: string;
  /** 最新有效默认 (不传 = 现读一份; 读不出来就是 null, 不编) */
  latest?: EffectiveModelConfig | null;
  /** Supervisor 失败分类 + 备用候选 (按策略与类别决定是否允许用备用) */
  errorClass?: ErrorClass;
  fallbackCandidates?: RunModelConfig[];
  /** 事件写在哪个 Run 上 (默认 prevRunId; 都没传就只算不写, 并在 event.reason 里说清) */
  recordEventOnRunId?: string;
  now?: string;
}

/**
 * 唯一 I/O 入口: 「下一个 Run 用什么模型」。
 *
 * 做四件事, 顺序固定 (算 → 守 → 记 → 交):
 *   ① 读事实: 上一个 Run 的快照 + Goal 策略 + 最新有效默认 + 会话绑定;
 *   ② 决定: `resolveRunModel({intent:'next_run'})` (纯函数);
 *   ③ 守卫: `planSwitchContinuation` —— **模型换不换都带跨 Run 非幂等守卫**;
 *   ④ 记事件: 把这次决定写成 Run 事件 (switched/frozen/conflict 都写, 结果如实)。
 *
 * 它**不启动 Run**, 也**不改**任何老 Run 的快照: 只回答"下一份该是什么", 由调用方去 startRun。
 */
export async function resolveNextRunModel(opts: ResolveNextRunModelOptions = {}): Promise<NextRunModelResolution> {
  const prevRun = opts.prevRunId ? await readRun(opts.prevRunId) : null;
  const goalId = opts.goalId || prevRun?.goalId;

  let policy = opts.policy;
  let policyOrigin: GoalModelPolicyOrigin = 'default';
  let policyProblems: string[] = [];
  if (policy === undefined && goalId) {
    const view = await readGoalModelPolicy(goalId);
    policy = view.policy;
    policyOrigin = view.origin;
    policyProblems = view.problems;
  } else if (policy === undefined) {
    policy = undefined;   // 未声明 → auto (parse 的缺省)
  }

  let latest: EffectiveModelConfig | null;
  if (opts.latest !== undefined) latest = opts.latest;
  else {
    try { latest = await effectiveModelConfig({ sessionKey: opts.sessionKey }); } catch { latest = null; }
  }
  let sessionBinding: ModelSelection | null = null;
  try { sessionBinding = await readSessionSelection(opts.sessionKey); } catch { sessionBinding = null; }

  const decision = resolveRunModel({
    intent: 'next_run',
    run: prevRun,
    policy,
    policyProblems,
    latest,
    sessionBinding,
    now: opts.now,
  });

  // Supervisor 备用模型: 策略 + 失败类别都允许才换; 不允许时**不改**决定, 只说原因
  let finalDecision = decision;
  if (opts.errorClass || (opts.fallbackCandidates && opts.fallbackCandidates.length)) {
    const verdict = supervisorMaySwitchModel({ mode: decision.mode, errorClass: opts.errorClass });
    if (verdict.allowed) {
      const picked = pickFallbackConfig(decision.config, opts.fallbackCandidates || []);
      if (picked.ok && picked.config) {
        finalDecision = {
          ...decision,
          config: picked.config,
          source: 'supervisor_fallback',
          switched: !sameConfig(prevRun?.modelConfig || null, picked.config),
          frozen: false,
          reason: `${decision.reason}; ${verdict.reason}; ${picked.reason}`,
        };
      } else if (opts.errorClass) {
        finalDecision = { ...decision, reason: `${decision.reason}; ${verdict.reason}; ${picked.reason}` };
      }
    } else {
      finalDecision = { ...decision, reason: `${decision.reason}; ${verdict.reason}` };
    }
  }

  const continuation = prevRun ? planSwitchContinuation({ prevRun, decision: finalDecision }) : null;

  // 事件: 只有真的"有一个 Run 可挂"时才写; 挂不上要如实说 (不是沉默地不记)
  const targetRunId = opts.recordEventOnRunId || opts.prevRunId;
  let event: NextRunModelResolution['event'] = { ok: false, reason: '没有可挂事件的 Run (既没给 prevRunId 也没给 recordEventOnRunId) → 本次决定未落盘' };
  if (targetRunId && finalDecision.config) {
    const outcome: RunModelSwitchEvent['outcome'] =
      finalDecision.conflict.length ? 'conflict'
        : finalDecision.switched ? 'switched'
          : 'frozen';
    const res = await recordModelSwitch(targetRunId, {
      to: finalDecision.config,
      from: prevRun?.modelConfig || null,
      outcome,
      mode: (finalDecision.mode === 'auto' || finalDecision.mode === 'pinned' || finalDecision.mode === 'session'
        ? finalDecision.mode
        : 'unknown') as RunModelSwitchMode,
      source: finalDecision.source === 'none' ? 'none' : finalDecision.source,
      reason: finalDecision.reason.slice(0, 400),
      guardsCarried: continuation ? continuation.guards.length : 0,
      goalId,
    });
    event = { ...res, onRunId: targetRunId };
    if (!res.ok) event.reason = `${res.reason} (决定已做出但没留下事件: ${finalDecision.reason.slice(0, 120)})`;
  } else if (targetRunId) {
    event = { ok: false, onRunId: targetRunId, reason: '决定里没有可用的模型配置 → 不写事件 (不编一份没有的配置)' };
  }

  return {
    decision: finalDecision,
    continuation,
    startRunModelConfig: finalDecision.config || undefined,
    event,
    policyOrigin,
    policyProblems,
  };
}
