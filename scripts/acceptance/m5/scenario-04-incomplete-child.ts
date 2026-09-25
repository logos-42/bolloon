/**
 * M5-④ 子 Agent 输出不完整, 父拒"完成": 缺证据就逐条列出缺什么, 不得当 done
 *
 * 两条真路径都跑:
 *   (A) 真 `SubAgentManager.delegateTask(..., {goalId, successCriteria})` → 子 Agent 回一句漂亮但零证据的
 *       "全部做完了" → 任务**不得**变 completed (留在 in_progress + 记下为什么不接受)。
 *   (B) 真 `handleChildReport` 收到一份**结构完整、自称 completed、但没有逐条证据**的报告 →
 *       `outcome='incomplete'`, `missingEvidence` **逐条列项**, 父 Goal 不得变 completed, pendingReports 不清。
 * 阴性对照: 同一份合同, 补上逐条证据 → 真接受 (门不是恒红); 另一份没有合同的回报 → 明确 `no_contract` (不许糊涂接受)。
 * 时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-04-incomplete-child.ts
 */
import * as path from 'node:path';
import {
  Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, paths, readJson, iso,
} from './lib/harness.js';

const A = new Acceptance('scenario-04', '子 Agent 输出不完整 → 父逐条拒收 (不当 done)', '');
const { home } = isolatedHome('sc-04-incomplete-child');
(A as any).home = home;
console.log(`\n=== M5-④ 子 Agent 输出不完整, 父拒"完成" ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));

const M = await loadMods();
const { gs, rs, sup, wiring } = M;

const t0 = Date.now();
const goal = await gs.createGoal({
  objective: '父目标: 等子 Agent 交付"数据采集"能力 (缺什么就该说缺什么)',
  successCriteria: ['判据0: 子 Agent 交付带 e2e 证据的采集结果'],
  requiredSkills: ['collect_data'],
  createdBy: 'm5',
});
const r0 = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId: goal.goalId, goal: goal.objective });
await rs.finishRun(r0.runId, { status: 'failed', error: 'ENOTFOUND 本地没有 collect_data 能力' });
await gs.attachRun(goal.goalId, r0.runId);

// ── (A) 真子 Agent 管理路径: 一句"全部做完了" ──────────────────────────────
A.section('[A] 真 SubAgentManager: 漂亮话 + 零证据');
const { SubAgentManager } = await import('../../../src/agents/subagent-manager.js');
const mgr = new SubAgentManager({ storagePath: path.join(home, '.bolloon', 'agents') });
await mgr.initialize();
await mgr.registerAgent({ name: 'Coder', capabilities: ['collect_data'] } as any);
const { task, workContract } = await mgr.delegateTask(
  'm5-user', '采集 e2e 数据', ['collect_data'], 'normal', undefined,
  { goalId: goal.goalId, successCriteria: ['采集 e2e 数据'], home },
);
A.check('(A) 真子任务带着合同出门 (workId 一致 + 必带证据非空)',
  !!workContract && task.workId === workContract!.workId && (workContract!.requiredEvidence ?? []).length > 0,
  workContract ? `workId=${task.workId} requiredEvidence=${JSON.stringify(workContract!.requiredEvidence)}` : '没有合同');
await mgr.updateTaskStatus(task.id, 'completed', '全部做完了, 一切正常');
const taskAfter = await mgr.getTask(task.id);
A.check('(A) 只喊"做完了"**不接受为完成** (任务仍在 in_progress)',
  taskAfter!.status === 'in_progress', `status=${taskAfter!.status}`);
A.check('(A) 拒收理由写清了缺什么 (error 里点名"不接受为完成")',
  /不接受为完成/.test(String(taskAfter!.error)), String(taskAfter!.error).slice(0, 200));
const gA = await gs.readGoal(goal.goalId);
A.check('(A) 父 Goal 仍然"等在跑的子工作" (pendingReports 没被清掉)',
  (gA!.continuation?.pendingReports ?? []).some((p: any) => p.workId === task.workId),
  JSON.stringify((gA!.continuation?.pendingReports ?? []).map((p: any) => p.workId)));
A.check('(A) 父 Goal 不得因为子 Agent 自称完成而完成', gA!.status !== 'completed', `status=${gA!.status}`);

// ── (B) 真回报核验路径: 结构完整但缺证据 ──────────────────────────────────
A.section('[B] handleChildReport: 自称 completed 但缺逐条证据');
const childAgentId = workContract!.childAgentId;
const baseReport = (over: Partial<any>) => ({
  workId: task.workId, childAgentId, status: 'completed',
  summary: '交付 data.json (自称完成)', evidence: [], artifacts: [],
  checks: [], unresolvedItems: [], blockReason: null,
  nextRecommendation: '交给父汇总', durationMs: 12, reportedAt: iso(Date.now()),
  ...over,
});
const hollow = await wiring.handleChildReport({ goalId: goal.goalId, workId: task.workId, report: baseReport({}), home });
A.check('(B) 缺证据的"完成"被判 incomplete, accepted=false',
  hollow.outcome === 'incomplete' && hollow.accepted === false, `outcome=${hollow.outcome} reason=${hollow.reason}`);
A.check('(B) 逐条列出缺的证据项 (不是一句"证据不足")',
  hollow.missingEvidence.length >= 1 && hollow.missingEvidence.every((e: string) => e.length > 0),
  `missingEvidence=${JSON.stringify(hollow.missingEvidence)} missingFields=${JSON.stringify(hollow.missingFields)}`);
A.check('(B) 缺的正是合同里要求的那几项 (可逐条对上)',
  (workContract!.requiredEvidence ?? []).every((r: string) => hollow.missingEvidence.includes(r)),
  `合同要求=${JSON.stringify(workContract!.requiredEvidence)}`);
const gB = await gs.readGoal(goal.goalId);
A.check('(B) 母 Goal 不得变 completed, 且不改判在跑的子工作 (pendingReports 仍在)',
  gB!.status !== 'completed' && (gB!.continuation?.pendingReports ?? []).some((p: any) => p.workId === task.workId),
  `status=${gB!.status} pending=${JSON.stringify((gB!.continuation?.pendingReports ?? []).map((p: any) => p.workId))}`);
A.check('(B) 收件箱里留着这次核验的结论 (可审计, 不是阅后即焚)',
  !!(await readJson<any>(wiring.reportPathFor(goal.goalId, task.workId, home))),
  wiring.reportPathFor(goal.goalId, task.workId, home));

// ── 阴性对照 ──────────────────────────────────────────────────────────────
A.section('[对照] 补齐逐条证据 → 真接受; 无合同的回报 → 明确拒');
const full = await wiring.handleChildReport({
  goalId: goal.goalId, workId: task.workId, home,
  report: baseReport({
    evidence: workContract!.requiredEvidence.map((r: string) => ({ kind: r, ref: 'data.json', note: '真实产物' })),
    checks: workContract!.successCriteria.map((s: string) => ({ name: `criterion:${s}`, verdict: 'pass', detail: '读到数据' })),
  }),
});
A.check('[对照] 逐条证据齐了 → 真接受 (门不是恒判红)', full.accepted === true && full.outcome === 'accepted', `outcome=${full.outcome} reason=${full.reason}`);
const gFull = await gs.readGoal(goal.goalId);
A.check('[对照] 接受后待回报清干净 (阻塞巡检的输入面同步收缩)',
  !(gFull!.continuation?.pendingReports ?? []).some((p: any) => p.workId === task.workId),
  JSON.stringify((gFull!.continuation?.pendingReports ?? []).map((p: any) => p.workId)));

const noContract = await wiring.handleChildReport({
  goalId: goal.goalId, workId: 'work-不存在的合同', home, report: baseReport({ workId: 'work-不存在的合同' }),
});
A.check('[对照] 没有合同的回报 = no_contract (不糊涂接受)',
  noContract.outcome === 'no_contract' && noContract.accepted === false, `outcome=${noContract.outcome} reason=${noContract.reason}`);

// ── 逐条补证的过程也要能对上: 缺的项 → 补的项 ──────────────────────────────
A.check('合同 + 回报 + 核验记录三份都在盘上 (真产物, 不是内存里的判断)',
  !!(await readJson<any>(wiring.contractPathFor(goal.goalId, task.workId, home))),
  wiring.contractPathFor(goal.goalId, task.workId, home));
A.artifact(paths.works(home, goal.goalId), 'goal-works 目录 (合同/心跳/回报/核验)');
A.artifact(wiring.reportPathFor(goal.goalId, task.workId, home), '回报 + 核验结论');
A.note(`(A) 任务状态=${taskAfter!.status} · (B) 缺证据 ${hollow.missingEvidence.length} 项 · 补证后 outcome=${full.outcome}`);
await mgr.destroy();
void sup;
void paths;
A.finish();
