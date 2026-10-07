/**
 * runner-resolver.ts — 独立宿主的**分阶段**执行器解析 (2026-09-16, 批次 2-C.2)
 *
 * 起因: 独立宿主"没有 tick 日志、没有建 Run"这种故障无法定位 —— 20 秒超时只能说"超时",
 * 说不出卡在哪。这一层把解析拆成有序阶段, 每阶段记 开始/结束/耗时/失败分类/超时原因:
 *
 *   resolve_goal → resolve_agent → load_identity → load_session → load_skills
 *                → init_llm → create_session → prepare_resume → ready
 *
 * 任一必需阶段失败 → `{ ok:false, kind:'unresolved', reason:'<阶段>: <原因>', stages }`
 *  → Supervisor **只诊断**: 不建 Run、不改 Goal 状态、不伪造失败; 原因进 wakeReport/宿主状态。
 *
 * 顺带修一个真根因: 独立宿主此前**没有初始化 LLM 层**, 于是 `PiAgentSession.prompt()` 判定
 * `minimaxAvailable=false` 走 fallback 提前返回 —— 既不调模型也不建 Run, 上层只看到"执行完成但没有 Run"。
 * 现在 `init_llm` 是必需阶段, LLM 不可用直接 unresolved (而不是偷偷退化成 fallback)。
 */

import * as os from 'os';
import { deliverThroughActor } from '../kernel/channel-actor.js';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { readGoal, type GoalRecord } from './goal-store.js';
import { buildContinuationPlan } from './run-store.js';
import type { GoalExecutionRequest, GoalRunner, RunnerResolution } from './execution-supervisor.js';

export const RESOLVE_STAGES = [
  'resolve_goal',
  'resolve_agent',
  'load_identity',
  'load_session',
  'load_skills',
  'init_llm',
  'create_session',
  'prepare_resume',
  'ready',
] as const;

export type ResolveStage = typeof RESOLVE_STAGES[number];

export interface StageReport {
  stage: ResolveStage;
  ok: boolean;
  ms: number;
  /** 人可读观测 (来源/数量/耗时上下文) */
  note?: string;
  error?: string;
  /** 失败分类: config / auth / timeout / io / unknown (便于按类处理) */
  errorClass?: string;
  /** 是否为必需阶段 (失败即 unresolved) */
  required: boolean;
}

export interface StagedResolution extends RunnerResolution {
  stages: StageReport[];
  /** 卡住/失败的那个阶段 (ok=true 时为空) */
  failedStage?: ResolveStage;
}

export interface StagedResolverOptions {
  /** 建 agent session 的超时 (默认 20s) */
  createTimeoutMs?: number;
  /** 每阶段的超时 (默认 30s) */
  stageTimeoutMs?: number;
  /** 显式关闭自动执行 (只诊断) */
  allow?: boolean;
  home?: string;
  cwd?: string;
  log?: (msg: string) => void;
  /** 注入用 (测试) */
  createAgent?: (channelId: string, goalId: string) => Promise<any> | any;
  /** 注入用 (测试): 返回 LLM 配置摘要 */
  probeLlm?: () => Promise<{ ok: boolean; provider?: string; model?: string; hasKey?: boolean; reason?: string }>;
}

function classify(err: unknown, stage: ResolveStage): string {
  const m = String((err as Error)?.message || err || '').toLowerCase();
  if (m.includes('超时') || m.includes('timeout')) return 'timeout';
  if (stage === 'init_llm') return 'config';
  if (m.includes('eacces') || m.includes('enoent') || m.includes('eperm')) return 'io';
  return 'unknown';
}

/** 读本机 LLM 配置摘要 (只看结构与有无, 不打印任何密钥) */
export async function probeLlmConfig(home: string = os.homedir()): Promise<{ ok: boolean; provider?: string; model?: string; hasKey?: boolean; reason?: string }> {
  try {
    // 2026-10-06 技术债清理: 只读 canonical bolloon-config.json (旧 llm-config.json 已废弃, 迁移逻辑在 config-store)
    const raw = JSON.parse(await fsp.readFile(path.join(home, '.bolloon', 'bolloon-config.json'), 'utf8'));
    const active = raw.activeProvider || raw.provider;
    const providers = raw.providers || {};
    const p = providers[active] || {};
    const needsKey = p.requiresApiKey !== false;
    const hasKey = !!(p.apiKey || p.api_key || process.env[`${String(active).toUpperCase()}_API_KEY`]);
    if (!active) return { ok: false, reason: 'bolloon-config.json 没有 activeProvider' };
    if (needsKey && !hasKey) return { ok: false, provider: active, model: p.model, hasKey: false, reason: `provider ${active} 需要 apiKey 但没配` };
    return { ok: true, provider: active, model: p.model, hasKey };
  } catch (err) {
    return { ok: false, reason: `bolloon-config.json 不可读: ${String((err as Error)?.message || err).slice(0, 100)}` };
  }
}

async function stage<T>(
  stages: StageReport[], name: ResolveStage, required: boolean, timeoutMs: number,
  fn: () => Promise<T>, log?: (m: string) => void, noteOf?: (v: T) => string | undefined,
): Promise<{ ok: boolean; value?: T; report: StageReport }> {
  const t0 = Date.now();
  log?.(`[resolver] ${name} 开始`);
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_r, rej) => {
        const t = setTimeout(() => rej(new Error(`${name} 超时 (${timeoutMs}ms)`)), timeoutMs);
        t.unref?.();
      }),
    ]);
    const report: StageReport = { stage: name, ok: true, ms: Date.now() - t0, required, note: noteOf?.(value) };
    stages.push(report);
    log?.(`[resolver] ${name} 完成 ${report.ms}ms`);
    return { ok: true, value, report };
  } catch (err) {
    const report: StageReport = {
      stage: name, ok: false, ms: Date.now() - t0, required,
      error: String((err as Error)?.message || err).slice(0, 200),
      errorClass: classify(err, name),
    };
    stages.push(report);
    log?.(`[resolver] ${name} 失败 ${report.ms}ms: ${report.error}`);
    return { ok: false, report };
  }
}

/** 阶段报告一行摘要 (CLI / 日志 / wakeReport 用) */
export function formatStages(stages: StageReport[]): string {
  return stages.map((s) => `${s.stage}${s.ok ? '✓' : '✗'}${s.ms}ms`).join(' → ');
}

/**
 * 分阶段解析"谁来执行这个 Goal"。
 * 与 web 宿主同构: 都返回一个 runner; 差别只在"用什么上下文建 session"。
 */
export async function resolveGoalRunner(req: GoalExecutionRequest, opts: StagedResolverOptions = {}): Promise<StagedResolution> {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log;
  const stageTimeout = opts.stageTimeoutMs ?? 30_000;
  const createTimeout = opts.createTimeoutMs ?? (Number(process.env.BOLLOON_SUPERVISE_CREATE_TIMEOUT_MS) || 20_000);
  const stages: StageReport[] = [];
  const fail = (report: StageReport, reason: string): StagedResolution => ({
    ok: false, kind: 'none', reason, stages, failedStage: report.stage,
  });

  if (opts.allow === false) {
    return fail({ stage: 'resolve_goal', ok: false, ms: 0, required: true, error: '本地执行被显式关闭' }, 'resolve_goal: 本地执行被显式关闭 (BOLLOON_SUPERVISE_AGENT=0) → 只诊断');
  }

  // 1. resolve_goal —— 目标是否可执行
  const g = req.goal as GoalRecord | undefined;
  const goalCheck = await stage(stages, 'resolve_goal', true, stageTimeout, async () => {
    if (!g?.goalId) throw new Error('没有 goalId');
    const fresh = await readGoal(g.goalId);
    if (!fresh) throw new Error(`Goal 不存在: ${g.goalId}`);
    if (fresh.status === 'paused' || fresh.status === 'needs_human') throw new Error(`Goal 状态 ${fresh.status} 不允许自动执行`);
    return fresh;
  }, log);
  if (!goalCheck.ok) return fail(goalCheck.report, `resolve_goal: ${goalCheck.report.error} → 只诊断, Goal 状态未改动`);
  const goal = goalCheck.value!;

  // 2. resolve_agent —— 用哪个 agent 身份执行
  const agentCheck = await stage(stages, 'resolve_agent', true, stageTimeout, async () => {
    if (!goal.channelId && !req.prevRunId) throw new Error('Goal 没有 channelId (无法确定 agent 上下文)');
    return { channelId: goal.channelId || '', agentId: goal.agentId || '' };
  }, log);
  if (!agentCheck.ok) return fail(agentCheck.report, `resolve_agent: ${agentCheck.report.error} → 只诊断 (不建 Run)`);
  const { channelId, agentId } = agentCheck.value!;

  // 3. load_identity —— 身份可读性 (缺身份不致命, 但要留痕)
  await stage(stages, 'load_identity', false, stageTimeout, async () => {
    const files = ['keypair.json', 'agent-registry.json'].map((f) => path.join(home, '.bolloon', f));
    const found: string[] = [];
    for (const f of files) if (await fsp.stat(f).then(() => true).catch(() => false)) found.push(path.basename(f));
    return found;
  }, log, (found) => (found.length ? `身份文件: ${found.join(', ')}` : '无身份文件 (用系统临时身份)'));

  // 4. load_session —— 会话存储可读性
  await stage(stages, 'load_session', false, stageTimeout, async () => {
    const dir = path.join(home, '.bolloon', 'sessions');
    return fsp.stat(dir).then((st) => st.isDirectory()).catch(() => false);
  }, log, (ok) => (ok ? `会话目录可读: ${path.join(home, '.bolloon', 'sessions')}` : '会话目录不存在 (将新建)'));

  // 5. load_skills —— 技能视图可读性 (2-G.2 起会变成必需阶段)
  await stage(stages, 'load_skills', false, stageTimeout, async () => {
    const { getSkillsManager } = await import('./skills-manager.js');
    const list = await getSkillsManager({ home, cwd }).view();
    return { total: list.length, enabled: list.filter((s) => s.status === 'enabled').length, invalid: list.filter((s) => s.status === 'invalid').length };
  }, log, (r) => `技能视图: ${r.total} 个 (enabled ${r.enabled}, invalid ${r.invalid})`);

  // 6. init_llm —— **必需**: LLM 可用 (否则 agent 会退化成 fallback, 既不调模型也不建 Run)
  const llmCheck = await stage(stages, 'init_llm', true, stageTimeout, async () => {
    const probe = opts.probeLlm ? await opts.probeLlm() : await probeLlmConfig(home);
    if (!probe.ok) throw new Error(probe.reason || 'LLM 不可用');
    const { initMinimax } = await import('../constraints/index.js');
    initMinimax();
    return probe;
  }, log, (probe) => `provider=${probe.provider} model=${probe.model ?? '(默认)'} key=${probe.hasKey ? '有' : '免'}`);
  if (!llmCheck.ok) {
    return fail(llmCheck.report, `init_llm: ${llmCheck.report.error} → 只诊断 (不发起会退化成 fallback 的执行)`);
  }

  // 7. create_session —— 真 agent session
  let agent: any;
  const sessCheck = await stage(stages, 'create_session', true, createTimeout, async () => {
    if (opts.createAgent) { agent = await opts.createAgent(channelId, goal.goalId); return true; }
    const { createAgentSession } = await import('./pi-sdk.js');
    agent = await createAgentSession({ cwd, peerId: `supervise:${channelId || agentId}`, channelId: channelId || undefined } as any, true);
    return !!agent;
  }, log);
  if (!sessCheck.ok || !agent) return fail(sessCheck.report, `create_session: ${sessCheck.report.error} → 只诊断 (不建 Run)`);

  // 8. prepare_resume —— 恢复计划 (只读; 真正 prepareResume 由 runner 在运行时做, 保证状态迁移与执行同一时刻)
  let resumeNote = '新 Run (无历史)';
  if (req.prevRunId) {
    const planCheck = await stage(stages, 'prepare_resume', false, stageTimeout, async () => {
      const plan = await buildContinuationPlan(req.prevRunId!);
      if (!plan) throw new Error(`读不到上一条 Run: ${req.prevRunId}`);
      resumeNote = `已完成 ${plan.completedSteps.length} 步, 非幂等守卫 ${plan.replayGuards.length} 条`;
      return plan;
    }, log);
    if (!planCheck.ok) resumeNote = `恢复计划读取失败: ${planCheck.report.error}`;
  }
  stages.push({ stage: 'ready', ok: true, ms: 0, required: true, note: `runner 就绪 (channel=${channelId || '-'}, ${resumeNote})` });

  const runner: GoalRunner = async (r) => {
    if (r.kind === 'resume' && r.prevRunId && typeof agent.resumeRun === 'function') {
      const res = await agent.resumeRun(r.prevRunId);
      return { runId: r.prevRunId, status: res?.ok ? 'done' : 'failed', error: res?.ok ? undefined : res?.reason };
    }
    agent.setGoalId?.(goal.goalId);
    agent.setContinuationGuards?.(r.guards || []);
    // 2026-10-02 (K8): 同上 —— 经唯一入口 runExecution
    const reply = await deliverThroughActor(agent, () => agent.runExecution({ input: r.instruction }));
    const runId = agent.getLastRunId?.() || agent.getRunId?.() || '';
    // 没有 Run = 这次执行没有事实记录: 如实报告, 不让上层把"没跑"当"跑完"
    if (!runId) {
      return { status: 'failed', error: `执行没有产生 Run 记录 (agent 可能走了 fallback/未初始化路径): ${String(reply || '').slice(0, 120)}` };
    }
    return { runId, status: 'done', reply: typeof reply === 'string' ? reply.slice(0, 500) : undefined };
  };

  return { ok: true, kind: 'standalone', runner, stages };
}

/** 已启动的独立宿主把最近一次解析报告写给上层 (wakeReport / API / CLI 用) */
export function latestFailedStage(res: StagedResolution): { stage?: ResolveStage; reason?: string } {
  return { stage: res.failedStage, reason: res.ok ? undefined : res.reason };
}

/** 供 CLI/诊断: 一次解析的完整人类可读报告 */
export function describeResolution(res: StagedResolution): string {
  const failed = res.stages.find((s) => !s.ok);
  const head = res.ok ? '✅ 可执行' : `⛔ 不可执行 (卡在 ${res.failedStage})`;
  const lines = [`${head}${res.reason ? ` — ${res.reason}` : ''}`, `阶段: ${formatStages(res.stages)}`];
  for (const s of res.stages) if (s.note) lines.push(`  · ${s.stage}: ${s.note}`);
  if (failed?.error) lines.push(`  ✗ 失败分类=${failed.errorClass} 原因=${failed.error}`);
  return lines.join('\n');
}

