/**
 * scripts/acceptance/m5/lib/harness.ts — M5 长周期真跑验收的公共夹具 (2026-09-25)
 *
 * 归属: `docs/wiki/goal-continuation-flywheel.md` (飞轮设计稿) + 本轮任务书 (M5 十场景)。
 *
 * 这一层只做四件事, 全部**真**做, 不 stub 被验对象:
 *   ① **隔离 HOME**: 每个场景一个独立目录 (`$M5_ROOT/<场景>/home`), 真 `os.homedir()` 指过去,
 *      绝不碰用户真 `~/.bolloon`; 场景用 `makeSetupReady` 把 HOME 补成 ready (验收要的是"已配置好的机器")。
 *   ② **真执行器**: 只在 `ExecutionSupervisor` 的设计注入点 (`runner`) 注入一个确定性执行器 ——
 *      它自己用真 API 落 Run 事实 (`startRun` / `recordStep` / `addRunEvidence` / `finishRun` / `attachRun`)。
 *      被验对象 (Goal/Run Store · Supervisor · 收尾飞轮 · 合同 · 阻塞监控 · 变更注入) 一个都不 stub。
 *   ③ **判定**: `check(name, ok, detail)` 逐条落盘 (JSON) —— 报告里的每个"过/没过"都能追到具体断言。
 *   ④ **成本记账**: 每个场景数出 Run 数 / LLM 调用数 / 墙钟, 汇总进 `cost.json`。
 *
 * ★ 诚实条款 (会写进报告):
 *   · 执行器是**注入的确定性执行器**, 因此 `llmCalls` 恒为 0 —— 这不是"省了调用", 而是**没有真调模型**;
 *     长周期里"模型决定下一步"的那部分由本地确定性逻辑替代。真模型调用未被本轮覆盖。
 *   · 时钟: 每个场景显式声明 `clock: 'injected' | 'real'` (注入假钟推进 / 真等)。不许含糊。
 *   · 未就绪的 HOME: `createGoal` 有初始化硬门禁。本夹具先真读 gate; gate !== ready 时如实打印,
 *     并用代码里既有的测试通道 `BOLLOON_SETUP_IN_PROGRESS=1` 继续 (记进 notes, 不假装 ready)。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export const REAL_HOME = os.homedir();
export const REPO_ROOT = path.resolve(process.env.M5_REPO_ROOT || process.cwd());
/** 产物根 (默认 /tmp/bolloon-m5/<stamp>): 场景跑出的真文件都在这里, 报告里给的就是这些路径 */
export const M5_ROOT = process.env.M5_ROOT || path.join(os.tmpdir(), 'bolloon-m5', process.env.M5_STAMP || 'standalone');
export const RESULTS_DIR = path.join(M5_ROOT, 'results');

// ─────────────────────────────────────────────────────────────────────────────
// 判定与产物记账
// ─────────────────────────────────────────────────────────────────────────────

export interface Check {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface ScenarioResultFile {
  id: string;
  title: string;
  home: string;
  startedAt: string;
  wallMs: number;
  clock: 'injected' | 'real';
  passed: number;
  failed: number;
  checks: Check[];
  notes: string[];
  artifacts: { path: string; note: string }[];
  cost: { runs: number; llmCalls: number; supervisorTicks: number };
  exitCode: number;
}

function short(v: unknown, n = 320): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s ?? '').slice(0, n);
}

export class Acceptance {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];
  readonly artifacts: { path: string; note: string }[] = [];
  readonly startedAt = new Date().toISOString();
  private readonly t0 = Date.now();
  supervisorTicks = 0;

  constructor(
    readonly id: string,
    readonly title: string,
    readonly home: string,
    readonly clock: 'injected' | 'real' = 'injected',
  ) {}

  check(name: string, ok: boolean, detail?: unknown): boolean {
    const d = detail === undefined || detail === null ? null : short(detail);
    this.checks.push({ name, ok: !!ok, detail: d });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${!ok && d ? ` — ${d}` : ok && d ? ` (${d})` : ''}`);
    return !!ok;
  }

  note(msg: string): void {
    this.notes.push(msg);
    console.log(`  · ${msg}`);
  }

  /** 记一个真产物 (打印绝对路径, 报告里可直接去看) */
  artifact(p: string, note: string): string {
    this.artifacts.push({ path: p, note });
    console.log(`  📄 ${note}: ${p}`);
    return p;
  }

  section(t: string): void {
    console.log(`\n${t}`);
  }

  get failed(): number {
    return this.checks.filter((c) => !c.ok).length;
  }

  /** 成本记账: Run 数 / LLM 调用数 (注入执行器 → 真调模型 0 次) / tick 数 */
  async cost(runsDir?: string): Promise<{ runs: number; llmCalls: number; supervisorTicks: number }> {
    const dir = runsDir ?? path.join(this.home, '.bolloon', 'runs');
    let runs = 0;
    try {
      runs = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).length;
    } catch {
      runs = 0;
    }
    return { runs, llmCalls: 0, supervisorTicks: this.supervisorTicks };
  }

  /** 收尾: 打印结论 + 落一份 JSON 结果 (退出码 = 失败条数 > 0 ? 1 : 0) */
  finish(): ScenarioResultFile {
    const failed = this.failed;
    const result: ScenarioResultFile = {
      id: this.id,
      title: this.title,
      home: this.home,
      startedAt: this.startedAt,
      wallMs: Date.now() - this.t0,
      clock: this.clock,
      passed: this.checks.length - failed,
      failed,
      checks: this.checks,
      notes: this.notes,
      artifacts: this.artifacts,
      cost: { runs: 0, llmCalls: 0, supervisorTicks: this.supervisorTicks },
      exitCode: failed > 0 ? 1 : 0,
    };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, `${this.id}.json`);
    // cost.runs 由 countRuns 填 (finish 前的真值), 这里同步读一次
    try {
      result.cost.runs = countRunsSync(this.home);
    } catch {
      result.cost.runs = 0;
    }
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\n${failed > 0 ? '❌' : '✅'} ${this.id} ${this.title}: ${result.passed} 过 / ${failed} 败 · 墙钟 ${(result.wallMs / 1000).toFixed(1)}s · Run ${result.cost.runs} · 结果文件 ${file}`);
    process.exitCode = result.exitCode;
    // 验收脚本会加载 P2P / 探针 / 定时器这类会留句柄的模块 —— 判定跑完就显式收口。
    // 先 flush stdout 再退, 保证管道里拿到完整输出 (不靠"进程自己会不会退"这种运气)。
    process.stdout.write('', () => {
      setImmediate(() => process.exit(result.exitCode));
    });
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 隔离 HOME
// ─────────────────────────────────────────────────────────────────────────────

export function countRunsSync(home: string): number {
  try {
    return fs.readdirSync(path.join(home, '.bolloon', 'runs')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export interface IsoHome {
  home: string;
  bolloonHome: string;
}

/**
 * 造一个隔离 HOME 并把 `os.homedir()` 指过去 (真 `process.env.HOME`)。
 * `fresh=false` 时复用已有目录 (同一场景里要跨进程/跨阶段共享一个 HOME)。
 */
export function isolatedHome(tag: string, opts: { fresh?: boolean; note?: (m: string) => void } = {}): IsoHome {
  const home = path.join(M5_ROOT, tag, 'home');
  const bolloonHome = path.join(home, '.bolloon');
  if (opts.fresh !== false) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.mkdirSync(bolloonHome, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.BOLLOON_HOME = bolloonHome;
  // 验收脚本自己不该被 supervisor/cron/P2P 干扰
  process.env.BOLLOON_SKIP_KUBO = '1';
  process.env.BOLLOON_CRON = '0';
  process.env.BOLLOON_SUPERVISOR = '0';
  process.env.BOLLOON_SKIP_UPDATE = '1';
  return { home, bolloonHome };
}

/** 让隔离 HOME 处于 ready (真写 setup-state / identity; LLM 配置从真 HOME 复制, 值不打印) */
export async function seedReadyHome(home: IsoHome, note?: (m: string) => void): Promise<void> {
  const { makeSetupReady } = await import('../../../lib/make-setup-ready.js');
  const r = makeSetupReady(home.bolloonHome, { realHome: REAL_HOME, name: 'M5 验收用户', did: 'did:key:zM5Acceptance' });
  for (const n of r.notes) note?.(`[home] ${n}`);
}

/** 真读初始化门禁 (不绕过): gate='ready' 才算真的就绪 */
export async function readSetupGate(): Promise<{ gate: string; stage: string }> {
  const mod: any = await import('../../../../src/setup/setup-store.js');
  const r = await mod.getSetupGateCached({ light: true });
  return { gate: String(r?.gate ?? 'unknown'), stage: String(r?.state?.stage ?? 'unknown') };
}

/**
 * 真跑前置: 门禁不是 ready 时, 用代码里既有的**测试通道**继续, 并如实记账
 * (不假装 ready; gate 值会进报告)。
 */
export async function ensureGoalGate(note: (m: string) => void): Promise<{ gate: string; bypass: boolean }> {
  let gate = 'unknown';
  try {
    const g = await readSetupGate();
    gate = g.gate;
    note(`初始化门禁真值: gate=${g.gate} stage=${g.stage}`);
  } catch (e) {
    note(`初始化门禁读取失败 (${short(e, 120)}) → 走测试通道`);
    process.env.BOLLOON_SETUP_IN_PROGRESS = '1';
    return { gate: 'unreadable', bypass: true };
  }
  if (gate !== 'ready') {
    process.env.BOLLOON_SETUP_IN_PROGRESS = '1';
    note(`⚠ gate=${gate} (不是 ready) → 本轮用既有测试通道 BOLLOON_SETUP_IN_PROGRESS=1 继续; 这是环境让步, 不是产品就绪`);
    return { gate, bypass: true };
  }
  return { gate, bypass: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

export const iso = (ms: number): string => new Date(ms).toISOString();

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return (await fsp.readdir(p)).sort();
  } catch {
    return [];
  }
}

export async function readJson<T = any>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 一个目录下所有 json 的解析结果 (按文件名排序; 读不到的跳过并留痕) */
export async function readAllJson<T = any>(dir: string): Promise<{ file: string; rec: T }[]> {
  const out: { file: string; rec: T }[] = [];
  for (const f of (await listDir(dir)).filter((x) => x.endsWith('.json'))) {
    const rec = await readJson<T>(path.join(dir, f));
    if (rec) out.push({ file: path.join(dir, f), rec });
  }
  return out;
}

/** 真跑常用目录 */
export const paths = {
  runs: (home: string) => path.join(home, '.bolloon', 'runs'),
  goals: (home: string) => path.join(home, '.bolloon', 'goals'),
  decisions: (home: string) => path.join(home, '.bolloon', 'goal-decisions'),
  reports: (home: string) => path.join(home, '.bolloon', 'goal-reports'),
  works: (home: string, goalId: string) => path.join(home, '.bolloon', 'goal-works', goalId),
  changes: (home: string) => path.join(home, '.bolloon', 'goal-changes'),
  candidates: (home: string) => path.join(home, '.bolloon', 'skill-candidates'),
  memory: (home: string, layer: string) => path.join(home, '.bolloon', 'memory-layers', layer),
};

// ─────────────────────────────────────────────────────────────────────────────
// 真模块 (延迟 import: 环境变量先落定)
// ─────────────────────────────────────────────────────────────────────────────

export async function loadMods(): Promise<any> {
  return {
    gs: await import('../../../../src/agents/goal-store.js'),
    rs: await import('../../../../src/agents/run-store.js'),
    sup: await import('../../../../src/agents/execution-supervisor.js'),
    wiring: await import('../../../../src/agents/goal-flywheel-wiring.js'),
    fly: await import('../../../../src/agents/goal-flywheel/index.js'),
    ev: await import('../../../../src/agents/external-events.js'),
    reducer: await import('../../../../src/agents/goal-state-reducer.js'),
    monitor: await import('../../../../src/agents/goal-flywheel/work-monitor.js'),
    contract: await import('../../../../src/agents/goal-flywheel/work-contract.js'),
    candidate: await import('../../../../src/agents/goal-flywheel/skill-candidate.js'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入执行器 (唯一被替换的东西; 落在 GoalRunner 的设计入口上)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunPlan {
  status?: 'done' | 'failed' | 'interrupted' | 'awaiting_external' | 'stalled';
  error?: string;
  errorClass?: string;
  steps?: { tool: string; ok: boolean; summary?: string; error?: string }[];
  evidence?: string[];
  /** 满足 N 条未满足判据 (真 `markCriterion`, 每条带一条可核验证据), 同时写 Run 证据 */
  advanceCriteria?: number;
  /** Run 开跑之后 (仍在 Run 内) 要做的事 —— 例如"运行中注入新要求" */
  inRun?: (rec: { runId: string; goalId: string }) => Promise<void> | void;
}

export interface RunnerCtx {
  kind: string;
  prevRunId?: string;
  goalId: string;
  objective: string;
  instruction: string;
  n: number;
}

function markCriteria(gs: any, rs: any, goalId: string, runId: string, count: number): Promise<number[]> {
  return (async () => {
    const g = await gs.readGoal(goalId);
    const done: number[] = [];
    if (!g) return done;
    let left = count;
    for (let i = 0; i < (g.successCriteria ?? []).length && left > 0; i++) {
      if (g.completedCriteria.includes(i)) continue;
      const ev = `evidence-${i}.txt: 判据 ${i} 的可核验产物 (run ${runId})`;
      await gs.markCriterion(goalId, i, true, ev);
      await rs.addRunEvidence(runId, [ev]);
      done.push(i);
      left--;
    }
    return done;
  })();
}

/**
 * 确定性执行器: 自己用真 API 落 Run 事实。
 * `plan(ctx)` 决定这一轮跑到什么状态、做几步、有没有进展。
 * resume 分支 (kind='resume') 走**真** `prepareResume`, 并**只记新步骤** —— 已完成的步骤不重做。
 */
export function scriptedRunner(
  rs: any,
  gs: any,
  plan: (ctx: RunnerCtx) => RunPlan | Promise<RunPlan>,
  hooks: { onRunStarted?: (rec: any, ctx: RunnerCtx) => Promise<void> | void } = {},
): any {
  let n = 0;
  return (async (req: any) => {
    const ctx: RunnerCtx = {
      kind: req.kind,
      prevRunId: req.prevRunId,
      goalId: req.goal.goalId,
      objective: req.goal.objective,
      instruction: String(req.instruction ?? ''),
      n: n++,
    };
    const p = (await plan(ctx)) ?? {};

    if (req.kind === 'resume' && req.prevRunId) {
      // 真恢复路径: 状态机给"能不能续"的结论, 我们只续没做完的那一步
      const prep = await rs.prepareResume(req.prevRunId).catch((e: any) => ({ ok: false, reason: String(e?.message || e) }));
      // 恢复真正开始执行时 recovering → running (生产侧 pi-sdk.ts:1602 就是这么做的;
      // 不调它的话 finishRun(done) 会被状态机拒 → Run 永远停在 recovering)
      if (prep?.ok) await rs.markRunRunning(req.prevRunId).catch(() => false);
      for (const s of p.steps ?? []) await rs.recordStep(req.prevRunId, s);
      if (p.advanceCriteria) await markCriteria(gs, rs, ctx.goalId, req.prevRunId, p.advanceCriteria);
      if (p.evidence) await rs.addRunEvidence(req.prevRunId, p.evidence);
      await hooks.onRunStarted?.({ runId: req.prevRunId, goalId: ctx.goalId, prep }, ctx);
      // 仍在 Run 内要做的事 (例如"运行中注入新要求") —— Run 还没结束, 历史不许被改写
      await p.inRun?.({ runId: req.prevRunId, goalId: ctx.goalId });
      await rs.finishRun(req.prevRunId, { status: p.status ?? 'done', error: p.error });
      return { runId: req.prevRunId, status: p.status ?? 'done', reply: `resume (plan.ok=${prep?.ok === true})` };
    }

    const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId: ctx.goalId, goal: ctx.objective });
    await gs.attachRun(ctx.goalId, rec.runId);
    for (const s of p.steps ?? []) await rs.recordStep(rec.runId, s);
    if (p.advanceCriteria) await markCriteria(gs, rs, ctx.goalId, rec.runId, p.advanceCriteria);
    if (p.evidence) await rs.addRunEvidence(rec.runId, p.evidence);
    await hooks.onRunStarted?.(rec, ctx);
    // 仍在 Run 内要做的事 (例如"运行中注入新要求") —— Run 还没结束, 历史不许被改写
    await p.inRun?.({ runId: rec.runId, goalId: ctx.goalId });
    if (p.errorClass) {
      // run-store 没有"直接写 errorClass"的入口 → 通过 error 文本让 classifyError 认出来
      await rs.finishRun(rec.runId, { status: p.status ?? 'failed', error: `${p.errorClass}: ${p.error ?? ''}`.trim() });
    } else {
      await rs.finishRun(rec.runId, { status: p.status ?? 'done', error: p.error });
    }
    return { runId: rec.runId, status: p.status ?? 'done' };
  }) as any;
}

/** 结构化 final review (让收尾真的产出教训 / Skill 候选); 与 P5 验收同一份口径 */
export function skillReview(name: string, occurrences = 2): string {
  return JSON.stringify({
    reviewedBy: 'm5-verifier',
    verdict: 'reusable',
    methodEffective: '先解析判据再执行',
    methodFailed: '一开始直接开跑',
    nextTimeChange: '先写证据清单',
    facts: [{ claim: '判据 0 已满足', assertion: 'confirmed', refs: ['evidence-0.txt'] }],
    skills: [
      {
        name,
        purpose: '把判据逐条映射到可核验证据的固定流程',
        occurrences,
        boundaryClear: true,
        inputSchema: '{ criteria: string[] }',
        outputSchema: '{ evidenceRefs: string[] }',
        guarantees: ['每条判据都有证据引用'],
        doesNotGuarantee: ['不保证证据本身真实'],
        failureCases: ['判据不可核验时应当停下'],
        evidenceRefs: ['evidence-0.txt'],
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// tick 驱动 (注入时钟: 每 tick 推进一步; 不是 sleep 轮询)
// ─────────────────────────────────────────────────────────────────────────────

export interface TickLog {
  tick: number;
  at: string;
  executed: { goalId: string; runId?: string; status?: string }[];
  skipped: { goalId: string; reason: string }[];
  errors: string[];
  closures: { runId: string; decision: string; steps: number; memories: number; candidates: number }[];
  flywheel: { goalId: string; decision: string; state: string; runnable: boolean; reason: string; source: string; visibleState: string }[];
  blocks: { goalId: string; workId: string; kind: string; action: string; note: string }[];
  /** 启动对账 (只有第一次 tick 有内容): 谁的 run 被真判成 interrupted / 谁的 pid 还活着 */
  reconciled: { interrupted: string[]; stillRunning: string[]; failed: string[] };
  supervised: { stalled: string[]; failed: string[] };
  workContracts: { goalId: string; workId: string; capability: string }[];
  skillTrials: any[];
  skillTrialOpenings: any[];
  monitorEscalated: string[];
  monitorSilentRisk: boolean;
}

/** 推一个 tick 并把关键面收成可审计的结构 (原始 report 也留着) */
export async function tick(A: Acceptance, sup: any, clock: { t: number; stepMs?: number }): Promise<{ log: TickLog; report: any }> {
  const report: any = await sup.tickOnce();
  A.supervisorTicks++;
  const log: TickLog = {
    tick: report.tick,
    at: new Date(clock.t).toISOString(),
    executed: report.executed ?? [],
    skipped: report.skipped ?? [],
    errors: report.errors ?? [],
    closures: (report.closures ?? []).map((c: any) => ({ runId: c.runId, decision: c.decision, steps: c.steps, memories: c.memories, candidates: c.candidates })),
    flywheel: (report.flywheel ?? []).map((f: any) => ({
      goalId: f.goalId, decision: f.decision, state: f.state, runnable: f.runnable,
      reason: f.reason, source: f.source, visibleState: f.visibleState,
    })),
    blocks: report.blocks ?? [],
    reconciled: report.reconciled ?? { interrupted: [], stillRunning: [], failed: [] },
    supervised: report.supervised ?? { stalled: [], failed: [] },
    workContracts: report.workContracts ?? [],
    skillTrials: report.skillTrials ?? [],
    skillTrialOpenings: report.skillTrialOpenings ?? [],
    monitorEscalated: report.monitor?.escalated ?? [],
    monitorSilentRisk: !!report.monitor?.silentRisk,
  };
  clock.t += clock.stepMs ?? 10 * 60_000;
  return { log, report };
}

/** 落一份 tick 轨迹 (可核验: 报告里给的路径) */
export function dumpTickLog(home: string, name: string, logs: TickLog[]): string {
  const dir = path.join(home, '.bolloon', 'm5-traces');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2), 'utf8');
  return file;
}

/** 一条收尾决策记录 (closure 阶段) 的字段齐备性检查 (冻结契约: 缺字段 = 收尾没做完) */
export function continuationDecisionComplete(d: any): { ok: boolean; missing: string[] } {
  const required = [
    'decisionId', 'goalId', 'runId', 'decision', 'state', 'reason', 'nextAction',
    'expectedOutcome', 'confidence', 'progressDelta', 'unresolvedItems', 'wakeAt',
    'requiredCapability', 'riskLevel', 'stopReason', 'evidenceRefs',
  ];
  const missing = required.filter((k) => d === null || d === undefined || !(k in d));
  const empty = ['decisionId', 'reason', 'nextAction', 'expectedOutcome'].filter((k) => !String(d?.[k] ?? '').trim());
  return { ok: missing.length === 0 && empty.length === 0, missing: [...missing, ...empty.map((k) => `${k}(空)`) ] };
}
