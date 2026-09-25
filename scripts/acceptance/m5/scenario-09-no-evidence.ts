/**
 * M5-⑨ 没证据不能显示完成: 造一个"看着干完了"的 Run (Run=done + 一句"全部完成"),
 *         但完成门必须**挡住**: 状态不得是完成, 页面/CLI 面的投影也不得显示完成。
 *
 * 三条防线都真调 (不是只查一个字段):
 *   ① 收尾飞轮的判据 (decision 不得是 complete)
 *   ② Goal 完成门 `completeGoalIfEligible` (必须拒绝, 并说清缺什么)
 *   ③ 用户可见态投影 (`goalVisibleState` / `toUserVisibleState` 不得是"完成")
 * 正向对照: 同一条路, 把证据补齐 → 真判完成 (门不是恒红)。
 * 时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-09-no-evidence.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, iso, scriptedRunner, tick, dumpTickLog, continuationDecisionComplete } from './lib/harness.js';

const A = new Acceptance('scenario-09', '没证据不能显示完成 (收尾门/完成门/界面投影三层都挡)', '');
const { home } = isolatedHome('sc-09-no-evidence');
(A as any).home = home;
console.log(`\n=== M5-⑨ 没证据不能显示完成 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));
const M = await loadMods();
const { gs, rs, sup, wiring, monitor } = M;
const { USER_VISIBLE_STATES } = await import('../../../src/agents/goal-flywheel/types.js');
const bolloonHome = path.join(home, '.bolloon');
const clock = { t: Date.parse('2026-09-25T09:00:00.000Z'), stepMs: 10 * 60_000 };

const goal = await gs.createGoal({
  objective: '给导出功能写文档并保证 3 条判据都有证据',
  successCriteria: [
    '判据0: 文档存在 (有文件)',
    '判据1: 文档里每条判据都有证据引用 (有 diff)',
    '判据2: 全量测试全绿 (有测试输出)',
  ],
  budget: { maxRuns: 8 },
  createdBy: 'm5',
});

let phase = 0;
const runner = scriptedRunner(rs, gs, (ctx) => {
  if (phase === 0) {
    // "看着干完了": Run 正常结束 + 一句响亮的"全部完成", 但**一条判据都没满足**
    return {
      steps: [{ tool: 'write', ok: true, summary: '写了文档, 我觉得全部完成了' }],
      evidence: ['claim.txt: "全部完成, 没有问题" (只有口号, 没有产物引用)'],
    };
  }
  // 补证据: 3 条判据逐条带可核验产物
  return {
    advanceCriteria: 3,
    steps: [{ tool: 'shell_exec', ok: true, summary: '补齐 3 条判据的证据并落盘' }],
    evidence: ['evidence-0.txt: 文档存在', 'evidence-1.txt: diff 输出', 'evidence-2.txt: 测试全绿输出'],
  };
});
const s = new sup.ExecutionSupervisor({ owner: 'm5-w9', runner, maxPerTick: 5, maxRetries: 5, now: () => clock.t, log: () => {} });
const logs: any[] = [];
const t1 = await tick(A, s, clock); logs.push(t1.log);

// ── ① 收尾飞轮: 不得判 complete ──────────────────────────────────────────
A.section('[①] 收尾飞轮的结论 (Run=done 但零判据满足)');
const decFiles = fs.readdirSync(path.join(bolloonHome, 'goal-decisions')).filter((f) => f.includes('closure'));
const dec1 = JSON.parse(fs.readFileSync(path.join(bolloonHome, 'goal-decisions', decFiles[0]), 'utf8'));
A.check('收尾决策**不是** complete (一句"全部完成"不算完成)',
  String(dec1.decision?.decision) !== 'complete', `decision=${dec1.decision?.decision} state=${dec1.decision?.state}`);
A.check('收尾决策本身字段齐备 (不是"少写几个字段"糊过去)',
  continuationDecisionComplete(dec1.decision).ok, JSON.stringify(continuationDecisionComplete(dec1.decision)));
A.check('收尾说清了为什么不算完成 (reason 点名判据/证据)',
  /判据|证据/.test(String(dec1.decision?.reason ?? '')), String(dec1.decision?.reason ?? '').slice(0, 200));

// ── ② Goal 完成门: 必须拒绝 ──────────────────────────────────────────────
A.section('[②] Goal 完成门 completeGoalIfEligible');
const gate1 = await gs.completeGoalIfEligible(goal.goalId);
const g1 = await gs.readGoal(goal.goalId);
A.check('完成门**拒绝**判完成 (ok=false, 且不是空理由)',
  gate1.ok === false && String(gate1.reason ?? '').trim().length > 0, `ok=${gate1.ok} reason=${String(gate1.reason).slice(0, 200)}`);
A.check('拒绝时说清了**缺什么** (missing 逐条列项)',
  (gate1.missing ?? []).length > 0, JSON.stringify(gate1.missing));
A.check('Goal 状态**不得**是 completed (盘上事实也不许显示完成)',
  g1!.status !== 'completed', `status=${g1!.status}`);
A.check('已满足判据数 = 0 (没证据就是没满足, 不许自己给自己记账)',
  g1!.completedCriteria.length === 0, JSON.stringify(g1!.completedCriteria));

// ── ③ 用户可见态投影: 不得显示"完成" ─────────────────────────────────────
A.section('[③] 界面/CLI 投影 (同一份判定, 界面不另拼)');
// 词汇纪律: `UserVisibleState` 是**六类闭集** (executing / waiting_external_reply / child_blocked /
//   no_progress / needs_your_decision / ended) —— 里面**没有** 'completed' 这个取值。
//   所以"界面显示完成"的诚实判据是 **ended** (旧写法断言 `vis !== 'completed'` 恒真: 那个字符串
//   永远不可能出现 —— 断言写错了, 不是系统对了; M5 报告里如实记了这一条)。
const vis = await wiring.goalVisibleState({ goalId: goal.goalId, now: iso(clock.t) });
A.check('没证据这一轮: 用户可见态**不是**"已结束" (界面不许比系统更乐观)',
  vis !== 'ended', `visibleState=${vis}`);
A.check('用户可见态是一个"真实存在的态" (六类闭集里的一员, 不是 undefined/空字符串)',
  USER_VISIBLE_STATES.includes(vis), String(vis));
A.check('CLI 面的投影与之一致 (同一个函数, 不是两套拼法)',
  monitor.toUserVisibleState(g1!.continuation, [], dec1.decision) === vis || vis === 'needs_your_decision',
  `monitor=${monitor.toUserVisibleState(g1!.continuation, [], dec1.decision)} wiring=${vis}`);
A.check('汇报里**没有**"已完成/完成"这类结论 (不许在给用户的话里造假)',
  !/完成(了)?[。.!！]?$/.test(String(dec1.userReport?.conclusion ?? '').trim()), String(dec1.userReport?.conclusion ?? '').slice(0, 160));

// ── 正向对照: 补齐证据 → 真判完成 ────────────────────────────────────────
A.section('[正向对照] 补齐逐条证据 → 真判完成 (门不是恒红)');
phase = 1;
const t2 = await tick(A, s, clock); logs.push(t2.log);
const g2 = await gs.readGoal(goal.goalId);
const gate2 = await gs.completeGoalIfEligible(goal.goalId);
A.check('补齐证据后: 3 条判据全部满足 (真 markCriterion + 真证据)',
  g2!.completedCriteria.length === 3, JSON.stringify(g2!.completedCriteria));
A.check('补齐证据后: 完成门放行 (ok=true)',
  gate2.ok === true, `ok=${gate2.ok} reason=${String(gate2.reason).slice(0, 160)}`);
const g3 = await gs.readGoal(goal.goalId);
A.check('补齐证据后: 状态真变 completed (与"没证据时"形成对照)',
  g3!.status === 'completed', `status=${g3!.status}`);
// ★ M5-⑥ 根因验证 (真跑): 完成这条路**必须**把收尾 continuation 落盘。
//   修前: `applyGoalStatePlan` 在完成分支里按 `wakeReason === 'completed'` 跳过写入 ⇒ 盘上留着上一条
//   Run 的 `state:'active'` + 旧 `lastDecisionId` + 旧 `nextAction('由这一步的结果决定…')`,
//   而投影只读 continuation ⇒ **已完成**的 Goal 显示"正在执行"。
const decFiles3 = fs.readdirSync(path.join(bolloonHome, 'goal-decisions')).filter((f) => f.includes('closure'));
const closures3 = decFiles3.map((f) => JSON.parse(fs.readFileSync(path.join(bolloonHome, 'goal-decisions', f), 'utf8')));
const lastRunId = (g3!.runs ?? [])[g3!.runs.length - 1];
const decC = closures3.find((d: any) => d.runId === lastRunId);
A.check('完成这条路上: 收尾 continuation **真落盘** (state=completed + lastDecisionId 指向本次收尾决策, nextAction 不再是上一步的兜底话)',
  String(g3!.continuation?.state) === 'completed'
  && String(g3!.continuation?.lastDecisionId) === String(decC?.decision?.decisionId)
  && !/由这一步的结果决定/.test(String(g3!.continuation?.nextAction ?? '')),
  `cont.state=${g3!.continuation?.state} lastDecisionId=${g3!.continuation?.lastDecisionId} 本次收尾决策id=${decC?.decision?.decisionId} nextAction=${String(g3!.continuation?.nextAction).slice(0, 70)}`);
const vis2 = await wiring.goalVisibleState({ goalId: goal.goalId, now: iso(clock.t) });
A.check('补齐证据后: 界面投影是"已结束"(ended), **不是**"正在执行"(executing) —— 界面不比系统乐观',
  vis2 === 'ended', `visibleState=${vis2}`);
A.check('反向: 没证据那一轮 (Goal=active) 的投影**不是**"已结束" (不许把进行中的说成完成)',
  vis !== 'ended' && vis !== ('completed' as any), `没证据那轮 visibleState=${vis} (Goal status=active)`);

// ── ④ 防御验证 (真跑): 派生记录落后 ≠ 界面可以撒谎 ─────────────────────────
A.section('[④] 防御: 已完成的 Goal 上即使 continuation 落后, 界面也不许说"正在执行"');
const goodCont = (await gs.readGoal(goal.goalId))!.continuation;
// 人为把**落后**的那份 continuation 写回去 (模拟旧版本留下的 / 别的写入者覆盖的派生记录)
await gs.setContinuation(goal.goalId, {
  state: 'active' as any,
  wakeReason: 'active' as any,
  nextAction: '由这一步的结果决定 (恢复时先读最近一步的 summary/error)',
  lastDecisionId: 'decision:STALE:old-run',
});
const visStale = await wiring.goalVisibleState({ goalId: goal.goalId, now: iso(clock.t) });
A.check('已完成 Goal + 落后的 continuation ⇒ 投影仍是"已结束" (界面以 Goal **本体**为准, 派生记录说了不算)',
  visStale === 'ended', `visibleState=${visStale} (此时盘上 continuation.state=active, goal.status=completed)`);
await gs.setContinuation(goal.goalId, goodCont as any); // 还原真记录 (不留人为痕迹)
const visRestored = await wiring.goalVisibleState({ goalId: goal.goalId, now: iso(clock.t) });
A.check('还原真 continuation 后投影不变 (还原到位)', visRestored === 'ended', `visibleState=${visRestored}`);

const trace = dumpTickLog(home, 'scenario-09-no-evidence', logs);
A.artifact(trace, 'tick 轨迹 (挡住那一轮 vs 放行那一轮)');
A.note('时钟: 注入 (每 tick 推 10 分钟), 不是真等。');
A.finish();
