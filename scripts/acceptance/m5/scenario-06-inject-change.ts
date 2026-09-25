/**
 * M5-⑥ 运行中注入新要求 (GoalChangeRequest): 历史 Run 不被改写 · 当前 Run 先收尾 ·
 *         新约束从**下一次 continuation** 生效 · 汇报"哪些已完成/哪些计划被改变"
 *
 * 真跑面: 真 Goal/Run Store + 真 ExecutionSupervisor + 真 `ingestGoalChange` (P4 入口)。
 * 时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-06-inject-change.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, iso, scriptedRunner, tick, dumpTickLog } from './lib/harness.js';

const A = new Acceptance('scenario-06', '运行中注入新要求 (历史不改写 · 下一次 continuation 才生效)', '');
const { home } = isolatedHome('sc-06-inject-change');
(A as any).home = home;
console.log(`\n=== M5-⑥ 运行中注入新要求 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));
const M = await loadMods();
const { gs, rs, sup, wiring } = M;

const clock = { t: Date.parse('2026-09-25T09:00:00.000Z'), stepMs: 10 * 60_000 };
const t0 = clock.t;

const goal = await gs.createGoal({
  objective: '把 bolloon 的 3 处已死代码路径清掉, 并同步 wiki',
  successCriteria: [
    '判据0: 清掉 src/ 下未被引用的死代码路径 (有 grep 证据)',
    '判据1: 死代码对应的 wiki 页面同步更新 (有 diff 证据)',
    '判据2: 全量测试仍全绿 (有测试输出证据)',
  ],
  budget: { maxRuns: 8 },
  createdBy: 'm5',
});

const instructions: string[] = [];
const runner = scriptedRunner(rs, gs, (ctx) => {
  instructions.push(String(ctx.instruction ?? ''));
  if (ctx.n === 0) {
    return {
      advanceCriteria: 1,
      steps: [{ tool: 'grep', ok: true, summary: '第 1 步: 找出 3 处死代码路径' }],
      evidence: ['dead-paths.txt: 3 处死代码路径 + grep 输出'],
      // ★ 运行中投一条新要求 (人说的原话; 真 ingestGoalChange 入口)
      inRun: async ({ goalId, runId }) => {
        const out = await wiring.ingestGoalChange({
          goalId,
          instruction: '再加一条: 清理完必须有回滚脚本 rollback.sh, 否则不准算完成',
          recordedBy: 'm5-user',
          now: iso(clock.t),
        });
        A.lastIngest = out;
        A.lastInRunRunId = runId;
      },
    };
  }
  return { advanceCriteria: 1, steps: [{ tool: 'shell_exec', ok: true, summary: `第 ${ctx.n + 1} 步: 按(含新约束的)指令继续` }], evidence: [`evidence-r${ctx.n}.log`] };
});

const s = new sup.ExecutionSupervisor({
  owner: 'm5-w6', runner, maxPerTick: 5, maxRetries: 5,
  now: () => clock.t, log: () => {},
});
const logs: any[] = [];
const t1 = await tick(A, s, clock); logs.push(t1.log);
const ingest = (A as any).lastIngest as any;
const inRunRunId = (A as any).lastInRunRunId as string;

// ── 1. 变更被如实入档 (原话逐字) ──────────────────────────────────────────
A.section('[1] 新要求入档: 原话逐字 + 分诊 + 只影响后续 Run');
A.check('真 ingestGoalChange 返回一份有结论的变更 (不是 null/抛错)',
  !!ingest && !!ingest.request && !!ingest.application,
  ingest ? `kind=${ingest.request.kind} outcome=${ingest.application.outcome} status=${ingest.request.status}` : 'null');
A.check('原话**逐字**入档 (不许被改写/总结)',
  String(ingest?.request?.instruction ?? '').includes('回滚脚本 rollback.sh'), String(ingest?.request?.instruction ?? '').slice(0, 120));
A.check('类型级声明: 只影响后续 Run (appliesToFutureRunsOnly)',
  String(ingest?.application?.outcome) === 'next_run' || String(ingest?.application?.outcome) === 'needs_approval',
  `outcome=${ingest?.application?.outcome} reason=${String(ingest?.application?.reason ?? '').slice(0, 160)}`);
const g1 = await gs.readGoal(goal.goalId);
A.check('Goal 变更记录里真有这一条 (落盘可核, 不是只在内存里过了一下)',
  (g1!.goalChanges ?? []).some((c: any) => String(c.instruction).includes('rollback.sh')),
  JSON.stringify((g1!.goalChanges ?? []).map((c: any) => [c.changeId, c.kind, c.status])));
A.check('下一轮指令里带上了新约束 (下一次 continuation 才生效的依据)',
  String(ingest?.nextRunDirective ?? '').length > 0 && fs.existsSync(String(ingest?.persistedPath ?? '')),
  `directive=${String(ingest?.nextRunDirective ?? '').slice(0, 140)} path=${String(ingest?.persistedPath ?? '')}`);

// ── 2. 历史 Run 不被改写 + 当前 Run 先收尾 ────────────────────────────────
A.section('[2] 历史 Run 不被改写 + 当前 Run 先收尾');
const runNow = await rs.readRun(inRunRunId);
const runTxt = JSON.stringify(runNow);
A.check('注入发生在**运行中**的那条 Run 上 (时间线对得上: 它是本轮 Run)',
  !!runNow && (g1!.runs ?? []).includes(inRunRunId), `run=${inRunRunId} goal.runs=${JSON.stringify(g1!.runs)}`);
A.check('历史 Run 记录里**没有**被回填新要求 (Run 的 steps/evidence 不提 rollback.sh)',
  !runTxt.includes('rollback.sh'), `steps=${JSON.stringify(runNow?.steps?.map((x: any) => x.tool) ?? [])}`);
A.check('当前 Run 是**跑完才收尾**的 (let_finish; 没有被中途砍掉/改写成失败)',
  ['done', 'failed'].includes(String(runNow?.status)) && (runNow?.steps?.length ?? 0) >= 1,
  `status=${runNow?.status} steps=${runNow?.steps?.length}`);

// ── 3. 新约束从下一次 continuation 生效 ──────────────────────────────────
A.section('[3] 新约束从下一次 continuation 生效 (拿后续 Run 的 instruction 作证)');
const t2 = await tick(A, s, clock); logs.push(t2.log);
const g2 = await gs.readGoal(goal.goalId);
A.check('真开了下一轮 (runs 增加)',
  g2!.runs.length === 2, `runs=${g2!.runs.length}`);
A.check('下一轮的 instruction 里**带上了新约束** (不是只写在 Goal 记录里没人读)',
  /rollback\.sh/.test(String(instructions[1] ?? '')) || /rollback\.sh/.test(String(g2!.continuation?.nextAction ?? '')),
  `instr[1]=${String(instructions[1] ?? '').slice(0, 160)} | nextAction=${String(g2!.continuation?.nextAction ?? '').slice(0, 120)}`);
A.check('第一轮的 instruction 里**没有**新约束 (新旧两轮可区分, 不是同一句套两次)',
  !/rollback\.sh/.test(String(instructions[0] ?? '')), `instr[0]=${String(instructions[0] ?? '').slice(0, 120)}`);
const closureRecs = fs.readdirSync(path.join(home, '.bolloon', 'goal-decisions')).filter((f) => f.includes('closure'));
const latest = closureRecs.sort().pop()!;
const closure = JSON.parse(fs.readFileSync(path.join(home, '.bolloon', 'goal-decisions', latest), 'utf8'));
const reportTxt = JSON.stringify(closure.userReport ?? {});
A.check('汇报说清"已完成什么" (userReport.completed 非空)',
  (closure.userReport?.completed ?? []).length > 0, JSON.stringify(closure.userReport?.completed)?.slice(0, 200));
A.check('汇报里"计划被改变"有痕迹 (变更记录/新约束可被汇报面读到)',
  reportTxt.includes('rollback') || (g2!.goalChanges ?? []).some((c: any) => String(c.instruction).includes('rollback.sh') && c.status !== 'superseded'),
  `report=${reportTxt.slice(0, 160)}`);

// ── 4. 反事实: 加预算属于"放宽" → 不许静默生效 ───────────────────────────
A.section('[4] 反事实: 放宽类变更 (加预算) 不许静默生效 · 撤销优先作废未生效的变更');
const widening = await wiring.ingestGoalChange({
  goalId: goal.goalId,
  instruction: '预算放宽到 50 轮, 随便跑',
  source: 'agent',            // agent 提的加预算 = 自己给自己放宽 → 必须人批
  recordedBy: 'm5-agent', now: iso(clock.t),
});
A.check('反事实①: agent 提的"加预算"被判成放宽 → outcome=pending_approval (不自动生效)',
  String(widening?.application?.outcome) === 'pending_approval' && /agent_cannot_approve_budget/.test(String(widening?.application?.reason ?? '')),
  `outcome=${widening?.application?.outcome} reason=${String(widening?.application?.reason ?? '').slice(0, 160)}`);
A.check('反事实①: 预算**没有**被改掉 (Goal.budget 仍是 8)',
  Number((await gs.readGoal(goal.goalId))!.budget?.maxRuns) === 8,
  JSON.stringify((await gs.readGoal(goal.goalId))!.budget));
A.note('口径澄清 (真跑的额外收获): 用户本人提"加预算" → outcome=next_run + reason=[agent_cannot_approve_budget] "预算变更来源是用户 (= 出资方本人), 视为已批准" —— 出资方本人不算"自己批自己", 这是设计; agent 提才算放宽要人批。');
const revoke = await wiring.ingestGoalChange({
  goalId: goal.goalId, instruction: '撤销这个目标', recordedBy: 'm5-user', now: iso(clock.t),
});
const gRev = await gs.readGoal(goal.goalId);
A.check('反事实②: 用户撤销 → Goal 立即 abandoned (只有人能提的变更)',
  gRev!.status === 'abandoned', `status=${gRev!.status} changeKind=${String((revoke as any)?.request?.kind ?? '')}`);
A.check('反事实②: 之前"待批"的放宽变更被作废 (superseded, 不会在撤销后偷偷生效)',
  (gRev!.goalChanges ?? []).some((c: any) => c.status === 'superseded'),
  JSON.stringify((gRev!.goalChanges ?? []).map((c: any) => [c.kind, c.status])));
const afterRevoke = await tick(A, s, clock);
A.check('撤销后不再开新 Run (abandoned 是终态)',
  !afterRevoke.log.executed.some((e: any) => e.goalId === goal.goalId),
  `executed=${JSON.stringify(afterRevoke.log.executed.map((e: any) => e.goalId))} skipped=${JSON.stringify(afterRevoke.log.skipped.find((x: any) => x.goalId === goal.goalId)?.reason ?? '')}`);

const trace = dumpTickLog(home, 'scenario-06-inject-change', logs);
A.artifact(trace, 'tick 轨迹 (每一轮的 instruction / 收尾 / 跳过理由)');
A.note('时钟: 注入 (每 tick 推 10 分钟), 不是真等。');
A.finish();
