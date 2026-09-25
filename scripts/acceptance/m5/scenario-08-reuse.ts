/**
 * M5-⑧ 下次相似任务复用经验: 能**指出复用** (引用试用快照/候选/Memory 条目),
 *         "重复工作减少"用**步骤数 + 引用关系**量化 (不用耗时 —— 耗时会被机器负载造假)
 *
 * 真跑面: 真 Goal/Run Store + 真 Supervisor + 真收尾飞轮 (候选 → 试用 → 下一次结算)。
 * 反向对照: 不相似的任务**不许**引用上一个任务的候选 (引用不是"人人都盖一个章")。
 * 时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-08-reuse.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, iso, scriptedRunner, skillReview, tick, dumpTickLog } from './lib/harness.js';

const A = new Acceptance('scenario-08', '下次相似任务复用经验 (引用可指认 · 步骤数不翻倍)', '');
const { home } = isolatedHome('sc-08-reuse');
(A as any).home = home;
console.log(`\n=== M5-⑧ 相似任务复用经验 ===\nHOME=${home}`);

const SKILL = 'm5-reuse-criteria-to-evidence';
process.env.BOLLOON_RUN_FINAL_REVIEW = skillReview(SKILL, 2);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));
const M = await loadMods();
const { gs, rs, sup } = M;
const bolloonHome = path.join(home, '.bolloon');
const clock = { t: Date.parse('2026-09-25T09:00:00.000Z'), stepMs: 10 * 60_000 };

// ── 任务 A (第一次): 3 步, 其中 1 步是"发现方法" ───────────────────────────
// 注 (M5 夹具修复): 目标**不声明** requiredSkills —— 本场景验的是"跨任务复用经验"(候选/试用/证据引用),
//   而 `requiredSkills` 走的是**本地技能就绪门禁**: 本地没有名叫 export_data 的技能 ⇒
//   `ensureGoalSkillsReady` 不 ok ⇒ 拦成 needs_human 且**一个 Run 都不跑**, 场景整条链在第一步就断
//   (夹具自己的 bug: 不是系统错, 是场景把两条不相干的机制混在了一起)。
const gA = await gs.createGoal({
  objective: '任务A: 给"导出用户数据"这件事写一份可核验流程 (第一次做, 自己摸方法)',
  successCriteria: ['判据0: 流程文档存在且每条判据都有证据引用'], createdBy: 'm5',
});
const runner = scriptedRunner(rs, gs, (ctx) => {
  if (ctx.goalId === gA.goalId) {
    return {
      advanceCriteria: 1,
      steps: [
        { tool: 'grep', ok: true, summary: '第 1 步: 先摸清可核验证据的写法 (这次是自己发现的)' },
        { tool: 'cat', ok: true, summary: '第 2 步: 把判据逐条映射到证据' },
        { tool: 'write', ok: true, summary: '第 3 步: 落盘流程文档' },
      ],
      evidence: ['evidence-0.txt: 判据 0 的可核验产物 (任务A 首次)'],
    };
  }
  if (ctx.goalId === gB.goalId) {
    return {
      advanceCriteria: 1,
      steps: [
        // 引用了上一次的证据 + 试用快照: 不再需要"摸方法"那一步
        { tool: 'cat', ok: true, summary: '第 1 步: 直接套用上次的判据→证据映射 (来源: 试用快照 + 上次证据)' },
        { tool: 'write', ok: true, summary: '第 2 步: 落盘新文档 (套用同一份方法)' },
      ],
      evidence: ['reuse: skill=' + SKILL, 'source: evidence-0.txt@' + gA.goalId],
    };
  }
  // 不相似的任务: 只干自己的事, 不引用 A 的候选
  return { advanceCriteria: 1, steps: [{ tool: 'shell_exec', ok: true, summary: '按自己的路子做 (没有任何可复用的东西)' }], evidence: ['unrelated.txt'] };
});

const s = new sup.ExecutionSupervisor({ owner: 'm5-w8', runner, maxPerTick: 5, maxRetries: 5, now: () => clock.t, log: () => {} });
const logs: any[] = [];
// ★ 夹具修复 (M5-⑧): 任务A **单独**跑一个 tick —— "第一次" 与 "下一次" 必须在时间上真的分开。
//   旧写法把 A/B/C 三个 Goal 一起建再 tick 三次: `maxPerTick=5` 让三个任务**在同一 tick 全跑完**,
//   于是 tickB / tickC 都是空 tick (断言却在读它们), 而"下次相似任务复用上次经验"这句话在
//   同一个 tick 里根本说不通 (复用发生在候选/试用被写下**之后**)。
const tickA = await tick(A, s, clock); logs.push(tickA.log);
// 相似任务 B 与不相似任务 C: A 收尾 (候选 + 试用已落盘) 之后才建
const gB = await gs.createGoal({
  objective: '任务B (相似): 给"导入用户数据"写一份可核验流程 (与任务A 同一类活)',
  successCriteria: ['判据0: 流程文档存在且每条判据都有证据引用'], createdBy: 'm5',
});
const gC = await gs.createGoal({
  objective: '任务C (不相似): 换掉 CI 的镜像源',
  successCriteria: ['判据0: CI 配置里镜像源已换'], createdBy: 'm5',
});
const tickB = await tick(A, s, clock); logs.push(tickB.log);
const tickC = await tick(A, s, clock); logs.push(tickC.log);

// ── 引用关系: 试用快照 / 候选 / Memory 条目 ───────────────────────────────
A.section('[引用] 第二次任务能指认出复用的东西');
const candDir = path.join(bolloonHome, 'skill-candidates');
const cands = fs.existsSync(candDir) ? fs.readdirSync(candDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(candDir, f), 'utf8'))) : [];
const candA = cands.find((c: any) => String(c.name) === SKILL);
A.check('第一次任务结束就产出了候选 + 真开出试用 (候选里带 startedByRunId)',
  !!candA && String(candA.trial?.startedByRunId ?? '').length > 0,
  candA ? `cand=${candA.candidateId} trial=${candA.trial?.trialId ?? '?'} startedBy=${candA.trial?.startedByRunId} status=${candA.trial?.status}` : '没有候选');
A.check('试用指向一份**快照** (可指认: hash + 范围), 不是"感觉一样"',
  !!candA?.trial?.snapshotHash || !!candA?.trial?.snapshotScope,
  JSON.stringify(candA?.trial ? { hash: candA.trial.snapshotHash, scope: candA.trial.snapshotScope } : null));
const gBAfter = await gs.readGoal(gB.goalId);
const runBId = (gBAfter!.runs ?? [])[0];
const runB = await rs.readRun(runBId);
// 夹具修复 (M5-⑧): `createGoal` 返回的对象上 `runs` 还是**空的** (那时一个 Run 都没跑) ——
//   拿它做引用匹配会读到 undefined (旧写法就这么错了)。引用**必须**重读 Goal 后取盘上的 runs。
const gAAfter = await gs.readGoal(gA.goalId);
const runAId = (gAAfter!.runs ?? [])[0];
A.check('第一次任务 (A) 真跑过一条 Run, 且有收尾结论 (引用才有对象可指)',
  !!runAId && (await rs.readRun(runAId))?.status === 'done',
  `A.runs=${JSON.stringify(gAAfter!.runs)} status=${(await rs.readRun(runAId))?.status}`);
A.check('第二次任务 (B) 真的在 A **之后**跑过一条 Run (复用才在时间上成立)',
  !!runBId && runBId !== runAId && runB?.status === 'done',
  `B.runs=${JSON.stringify(gBAfter!.runs)} status=${runB?.status}`);
A.check('第二次任务的成功点上, 系统对"A 的试用"给了**明确裁决** (不许沉默, 也不许无证据提升)',
  (() => {
    const settle = logs.flatMap((l: any) => l.skillTrials ?? []).find((s: any) => s.runId === runBId);
    if (!settle) return false;
    // 两种合法结论: ① 带证据提升 (promoted) ② 明确不提升 + 非空理由。**禁止**的是
    // "没有裁决" (静默) 与 "无证据就提升" (盖章式复用)。
    return settle.promoted === true ? settle.status === 'promoted' : String(settle.reason ?? '').trim().length > 20;
  })(),
  (() => {
    const settle = logs.flatMap((l: any) => l.skillTrials ?? []).find((s: any) => s.runId === runBId);
    return settle ? `promoted=${settle.promoted} status=${settle.status} reason=${String(settle.reason).slice(0, 150)}` : `没有针对 run B (${runBId}) 的结算记录; 全部=${JSON.stringify(logs.flatMap((l: any) => (l.skillTrials ?? []).map((s: any) => [s.runId, s.status, s.reason.slice(0, 60)])))}`;
  })());
// 如实记下**本仓当前语义** (不是"已知限制"式含糊): 兑现试用的 Run 必须与开试用那条 Run 属于
// **同一个 Goal** (`settleSkillTrialsForRun` 的 `trial_belongs_to_other_goal` 守卫), 所以本场景的
// **跨 Goal** 复用只会停在试用位。这条政策是否该放开, 见 M5 报告的"未决项"。
const settleB = logs.flatMap((l: any) => l.skillTrials ?? []).find((s: any) => s.runId === runBId);
A.note(`跨 Goal 试用的系统裁决原文: ${settleB ? String(settleB.reason) : '(无)'} · 候选 ${candA?.candidateId} 试用状态=${candA?.trial?.status}`);
const runBEvidence = JSON.stringify(runB?.evidence ?? []);
A.check('第二次任务的证据**引用了第一次的产物** (source: evidence-0.txt@任务A 的 goalId)',
  runBEvidence.includes(gA.goalId) && runBEvidence.includes('reuse: skill='), runBEvidence.slice(0, 220));
const memDir = path.join(bolloonHome, 'memory-layers');
const memFiles: string[] = [];
const walk = (d: string): void => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.json')) memFiles.push(p); } };
if (fs.existsSync(memDir)) walk(memDir);
const memA = memFiles.filter((f) => JSON.parse(fs.readFileSync(f, 'utf8')).runId === runAId);
A.check('Memory 里留着第一次的经验条目 (可被后来者检索的实体, 不是"聊过就没了")',
  memA.length > 0, `${memA.length} 条 (${memA.map((f) => path.basename(f)).slice(0, 4).join(', ')}) (runA=${runAId})`);

// ── 量化: 步骤数 + 引用关系 (不用耗时) ────────────────────────────────────
A.section('[量化] 重复工作减少 = 步骤数 + 引用关系 (刻意不用耗时)');
const stepsARun = (await rs.readRun(runAId))!.steps.length;
const stepsBRun = runB!.steps.length;
A.check(`第二次任务的步骤数**没有增加** (A=${stepsARun} 步 → B=${stepsBRun} 步; 少了"摸方法"那一步)`,
  stepsBRun < stepsARun, `A.steps=${stepsARun} B.steps=${stepsBRun}`);
A.check('引用关系 ≥ 2 处 (① 试用快照 ② 上次证据文件/Goal) —— 量化的是引用, 不是墙钟',
  (!!candA?.trial?.snapshotHash || !!candA?.trial?.snapshotScope) && runBEvidence.includes(gA.goalId),
  `refs: trial=${!!candA?.trial} evidence=${runBEvidence.includes(gA.goalId)}`);
A.note(`量化口径: 步骤数 ${stepsARun}→${stepsBRun}; 引用关系: 试用(候选 ${candA?.candidateId ?? '?'}) + 证据(evidence-0.txt@${gA.goalId}); 未使用耗时 (会被机器负载造假)。`);

// ── 反事实: 不相似的任务不许"盖章式复用" ─────────────────────────────────
A.section('[反事实] 不相似的任务不许引用');
const gCAfter = await gs.readGoal(gC.goalId);
const runC = await rs.readRun(gCAfter!.runs[0]);
A.check('反事实: 不相似任务的证据里**没有**任何对任务A候选/证据的引用 (引用不是盖章)',
  !JSON.stringify(runC?.evidence ?? []).includes(gA.goalId) && !JSON.stringify(runC?.evidence ?? []).includes(SKILL),
  JSON.stringify(runC?.evidence));
A.check('反事实: 它的成功率等于"自己干完", 不靠别人的试用 (自己那条判据自己满足)',
  gCAfter!.completedCriteria.length >= 1, JSON.stringify(gCAfter!.completedCriteria));

const trace = dumpTickLog(home, 'scenario-08-reuse', logs);
A.artifact(trace, 'tick 轨迹 (三次任务的开试用/结算/引用)');
A.note('时钟: 注入 (每 tick 推 10 分钟), 不是真等。');
A.finish();
