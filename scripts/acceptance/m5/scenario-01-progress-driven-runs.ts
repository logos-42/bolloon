/**
 * M5-① 没有固定轮次: 按进展跳 Run 自动完成 (+ 反事实对照 + 紧预算刹车)
 *
 * 真跑面: 真 `ExecutionSupervisor` + 真 Goal/Run Store + 真收尾飞轮, 隔离 HOME。
 * 时钟: **注入** (每 tick 推 10 分钟, 不 sleep) —— 本场景不需要真等, 如实标注 `clock: injected`。
 *
 * 三部分:
 *   A 正例: 3 条判据的 Goal, 执行器每轮满足一条 + 写一条 Run 证据 → 必须自己走到 `completed`,
 *           且**每一轮 Run 收尾都产出 `ContinuationDecision`** (不是靠固定轮次撞出来)。
 *   B 反事实: 同一形状的 Goal, 执行器**不产任何证据** → 抬到 50 轮也完不成 (结论随证据变, 不随轮次变)。
 *   C 紧预算: `budget.maxRuns = 1` 的 Goal, 第二轮禁止再开 Run 且 **Goal 不得变成 failed** (要交人/保持可继续)。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-01-progress-driven-runs.ts
 */
import * as path from 'node:path';
import {
  Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, scriptedRunner, skillReview,
  tick, dumpTickLog, continuationDecisionComplete, readAllJson, readJson, paths, exists, type TickLog,
} from './lib/harness.js';

const A = new Acceptance('scenario-01', '无固定轮次 · 按进展跳 Run 自动完成 (+反事实 +紧预算)', '');
const { home } = isolatedHome('sc-01-progress');
(A as any).home = home;
console.log(`\n=== M5-① 按进展跳 Run 自动完成 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));

const M = await loadMods();
const { gs, rs, sup, wiring } = M;
process.env.BOLLOON_RUN_FINAL_REVIEW = skillReview('m5-criteria-to-evidence', 2);

// ── A. 正例: 有进展 → 跳 Run 完成 ───────────────────────────────────────────
A.section('[A] 有进展: 3 条判据逐条落地 → 自己判完成');
const runIds: string[] = [];
const sA = new sup.ExecutionSupervisor({
  owner: 'm5-w1',
  runner: scriptedRunner(rs, gs, (ctx) => ({
    advanceCriteria: 1,
    steps: [{ tool: 'shell_exec', ok: true, summary: `第 ${ctx.n + 1} 轮: 落地一条判据` }],
    evidence: [`第 ${ctx.n + 1} 轮产物清单已写`],
  }), { onRunStarted: (rec) => { runIds.push(rec.runId); } }),
  maxPerTick: 5,
  maxRetries: 5,
  now: () => clockA.t,
  log: () => {},
});
const clockA = { t: Date.now(), stepMs: 10 * 60_000 };
const goalA = await gs.createGoal({
  objective: '把 3 条判据逐条落地 (每轮至少一条可核验证据)',
  successCriteria: ['判据0: 有 A→B 的路径证据', '判据1: 有对端回执', '判据2: 复验通过'],
  createdBy: 'm5',
});
const logsA: TickLog[] = [];
for (let i = 0; i < 12; i++) {
  const { log } = await tick(A, sA, clockA);
  logsA.push(log);
  const g = await gs.readGoal(goalA.goalId);
  if (g!.status === 'completed') break;
}
const afterA = await gs.readGoal(goalA.goalId);
const decisionsA = await wiring.readDecisionRecords(goalA.goalId, home);
const closuresA = decisionsA.filter((r: any) => r.phase === 'closure');
A.artifact(path.join(home, '.bolloon', 'goal-decisions'), `A 决策记录 (${decisionsA.length} 条)`);
A.artifact(await dumpTickLog(home, 'scenario-01-A', logsA) as unknown as string, 'A tick 轨迹');

A.check('A: Goal 自行走到 completed (没有靠轮次上限)', afterA!.status === 'completed', `status=${afterA!.status}`);
A.check('A: 真的跳了 ≥3 个 Run', afterA!.runs.length >= 3, `runs=${afterA!.runs.length}`);
A.check('A: 3 条判据全部由证据满足', afterA!.completedCriteria.length === 3, `completedCriteria=${JSON.stringify(afterA!.completedCriteria)}`);
A.check('A: 每个 Run 都产出一条收尾决策 (closure 记录数 = Run 数)',
  closuresA.length === afterA!.runs.length, `closures=${closuresA.length} runs=${afterA!.runs.length}`);
const incomplete = closuresA.filter((r: any) => !continuationDecisionComplete(r.decision).ok);
A.check('A: 每条收尾决策的冻结字段都齐 (缺字段 = 收尾没做完)',
  incomplete.length === 0,
  incomplete.length ? incomplete.map((r: any) => `${r.runId}:${JSON.stringify(continuationDecisionComplete(r.decision).missing)}`).join(' | ') : null);
const seqA = closuresA.map((r: any) => r.decision.decision);
A.check('A: 决策序列是 continue… → complete (最后一条才是完成)',
  seqA.length >= 3 && seqA[seqA.length - 1] === 'complete' && seqA.slice(0, -1).every((d: string) => d === 'continue'),
  JSON.stringify(seqA));
const continueReasons = closuresA.filter((r: any) => r.decision.decision === 'continue').map((r: any) => String(r.decision.reason));
A.check('A: 继续的依据是"新的可核验证据/新判据", 不是"第几轮"',
  continueReasons.length > 0 && continueReasons.every((r) => /可核验进展|新增证据|进展/.test(r)),
  continueReasons[0]);

// ── B. 反事实: 不产证据 → 轮次上限再大也完不成 ──────────────────────────────
A.section('[B] 反事实: 执行器零证据 → 轮次上限抬到 50 也完不成');
const ohB = isolatedHome('sc-01-noprogress');
(A as any).home = ohB.home;
await seedReadyHome(ohB, (m) => A.note(m));
delete process.env.BOLLOON_GOAL_MAX_RUNS;
const goalB = await gs.createGoal({
  objective: '同一形状的目标, 但每轮都产不出证据',
  successCriteria: ['判据0: 有 A→B 的路径证据', '判据1: 有对端回执', '判据2: 复验通过'],
  createdBy: 'm5',
});
const clockB = { t: Date.now(), stepMs: 5 * 60_000 };  // 步长 < 单 Run 上限/无进展窗口, 隔离出"无进展熔断"这一条
const sB = new sup.ExecutionSupervisor({
  owner: 'm5-w1',
  runner: scriptedRunner(rs, gs, () => ({ status: 'failed', steps: [{ tool: 'shell_exec', ok: false, error: '对端拒绝 (ECONNRESET)' }] })),
  maxPerTick: 5,
  maxRetries: 2, // 熔断阈值 = maxRetries + 1 = 3 (与真实配置同一口径)
  now: () => clockB.t,
  log: () => {},
});
const logsB: TickLog[] = [];
for (let i = 0; i < 8; i++) logsB.push((await tick(A, sB, clockB)).log);
const afterB = await gs.readGoal(goalB.goalId);
const decisionsB = await wiring.readDecisionRecords(goalB.goalId, ohB.home);
const closuresB = decisionsB.filter((r: any) => r.phase === 'closure');
A.artifact(await dumpTickLog(ohB.home, 'scenario-01-B-noprogress', logsB) as unknown as string, 'B tick 轨迹 (零证据)');
A.check('B: 零证据时**完不成** (status≠completed)', afterB!.status !== 'completed', `status=${afterB!.status}`);
A.check('B: 一条判据都不会自己变成满足', afterB!.completedCriteria.length === 0, `completedCriteria=${afterB!.completedCriteria.length}`);
const lastClosureB = closuresB[closuresB.length - 1];
const stopTextB = [
  ...closuresB.map((r: any) => String(r.decision.reason)),
  ...decisionsB.filter((r: any) => r.phase === 'preflight').map((r: any) => String(r.runnableReason)),
  ...logsB.flatMap((l) => l.flywheel.map((f) => f.reason)),
].join(' || ');
A.check('B: 停的依据指向"无进展/没有新证据", 不是"第 N 轮"',
  /无进展|没有新的可核验证据|条证据都没有|没有继续的资格/.test(stopTextB),
  lastClosureB ? lastClosureB.decision.reason : '没有收尾记录');
A.check('B: 熔断真实生效 (命中"无进展熔断阈值"或明确写"无进展 N 轮")',
  /熔断/.test(stopTextB),
  stopTextB.slice(0, 240));

// ── C. 紧预算: budget.maxRuns = 1 → 第二轮不许开 Run, 且 Goal 不得 failed ────
A.section('[C] 紧预算: budget.maxRuns=1 → Run 结束而 Goal 保持可继续/交人 (不是 failed)');
const ohC = isolatedHome('sc-01-budget');
(A as any).home = ohC.home;
await seedReadyHome(ohC, (m) => A.note(m));
const goalC = await gs.createGoal({
  objective: '有一条判据的目标, 但预算只给 1 个 Run',
  successCriteria: ['判据0: 有证据', '判据1: 复验通过'],
  budget: { maxRuns: 1 },
  createdBy: 'm5',
});
const clockC = { t: Date.now(), stepMs: 10 * 60_000 };
const sC = new sup.ExecutionSupervisor({
  owner: 'm5-w1',
  runner: scriptedRunner(rs, gs, () => ({ advanceCriteria: 1, steps: [{ tool: 'shell_exec', ok: true, summary: '第一轮落地一条判据' }] })),
  maxPerTick: 5,
  maxRetries: 5,
  now: () => clockC.t,
  log: () => {},
});
const logsC: TickLog[] = [];
for (let i = 0; i < 4; i++) logsC.push((await tick(A, sC, clockC)).log);
const afterC = await gs.readGoal(goalC.goalId);
const decisionsC = await wiring.readDecisionRecords(goalC.goalId, ohC.home);
A.artifact(await dumpTickLog(ohC.home, 'scenario-01-C-budget', logsC) as unknown as string, 'C tick 轨迹 (预算耗尽)');
A.check('C: 只跑了预算允许的 1 个 Run (没超预算空转)', afterC!.runs.length === 1, `runs=${afterC!.runs.length}`);
A.check('C: 预算耗尽后 Goal **不是 failed** (刹车, 不是判死)', afterC!.status !== 'failed', `status=${afterC!.status}`);
const executedAfterBudget = logsC.slice(1).reduce((n, l) => n + l.executed.length, 0);
A.check('C: 预算耗尽后 tick 不再开新 Run (executed=0)', executedAfterBudget === 0, `executed=${executedAfterBudget}`);
const budgetStopText = [
  ...logsC.slice(1).flatMap((l) => l.skipped.map((s) => s.reason)),
  ...decisionsC.map((r: any) => String(r.runnableReason)),
  ...decisionsC.map((r: any) => String(r.decision?.reason)),
].join(' || ');
A.check('C: 刹车理由**点名预算上限** (可核验, 不是沉默停)',
  /预算/.test(budgetStopText), budgetStopText.slice(0, 300));
A.check('C: 预算刹车后 Goal 状态与"交人/可继续"自洽 (active / needs_human 均算过, 只排除 failed/abandoned)',
  ['active', 'needs_human', 'paused', 'retry_wait', 'stalled'].includes(String(afterC!.status)),
  `status=${afterC!.status} autoContinue=${afterC!.continuation?.autoContinue}`);
A.note(`C 最终状态: status=${afterC!.status} · autoContinue=${afterC!.continuation?.autoContinue} · continuation.state=${afterC!.continuation?.state}`);

const decisionsFileC = path.join(paths.decisions(ohC.home), `${goalC.goalId}--`);
const sampleC = decisionsC.find((r: any) => /预算/.test(String(r.runnableReason)));
if (sampleC) A.artifact(path.join(paths.decisions(ohC.home), `${sampleC.goalId}--${sampleC.runId}--preflight.json`), 'C 预算刹车的那条决策记录');

void exists;
void readJson;
void readAllJson;

A.finish();
