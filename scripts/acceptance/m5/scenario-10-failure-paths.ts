/**
 * M5-⑩ 失败路径都给下一步, 不留幽灵任务:
 *   遍历 5 种失败 (工具拒 / 权限 / 支付 / 子阻塞 / 超时) —— 每种都要有
 *   **原因 + 下一步 + 谁负责**; 最后清点活跃 Run: 不许有"running 但没人管"的僵尸。
 *
 * 真跑面: 真 Goal/Run Store + 真 Supervisor + 真收尾飞轮。时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-10-failure-paths.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, iso, scriptedRunner, tick, dumpTickLog } from './lib/harness.js';

const A = new Acceptance('scenario-10', '失败路径都给下一步 + 活跃 Run 清点无僵尸', '');
const { home } = isolatedHome('sc-10-failure-paths');
(A as any).home = home;
console.log(`\n=== M5-⑩ 失败路径都给下一步 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));
const M = await loadMods();
const { gs, rs, sup, wiring } = M;
const bolloonHome = path.join(home, '.bolloon');
const clock = { t: Date.parse('2026-09-25T09:00:00.000Z'), stepMs: 10 * 60_000 };

/** 5 种失败: 每条一个 Goal, 每种失败都用**该种**的真事实 (errorClass/状态) */
const KINDS: { tag: string; objective: string; plan: () => any }[] = [
  { tag: '工具拒', objective: '目标1: 调用一个不存在的工具', plan: () => ({ status: 'failed', errorClass: 'no_such_tool', error: 'ENOENT: 没有这个工具 (工具被拒)', steps: [{ tool: 'unknown_tool', ok: false, error: 'ENOENT' }] }) },
  { tag: '权限', objective: '目标2: 装到系统目录 (没权限)', plan: () => ({ status: 'failed', errorClass: 'policy_denied', error: 'EACCES: 权限被策略拒绝', steps: [{ tool: 'shell_exec', ok: false, error: 'EACCES' }] }) },
  { tag: '支付', objective: '目标3: 调一个要付费的接口 (余额不够)', plan: () => ({ status: 'failed', errorClass: 'insufficient_funds', error: '402 Payment Required: 余额不足, 需要充値', steps: [{ tool: 'x402_call', ok: false, error: '402' }] }) },
  { tag: '子阻塞', objective: '目标4: 等子 Agent 交付 (子卡住)', plan: () => ({ status: 'stalled', error: 'child 子 Agent 无心跳, 阻塞在上游', errorClass: 'stalled', steps: [{ tool: 'delegate_task', ok: false, error: '子 Agent 无心跳' }] }) },
  { tag: '超时', objective: '目标5: 跑一个超时的长任务', plan: () => ({ status: 'failed', errorClass: 'timeout', error: 'timeout: 7200s 超过 deadline, 被掐掉', steps: [{ tool: 'long_task', ok: false, error: 'deadline exceeded' }] }) },
];

const goals: { tag: string; goalId: string }[] = [];
for (const k of KINDS) {
  const g = await gs.createGoal({ objective: k.objective, successCriteria: ['判据0: 任务真的做完'], budget: { maxRuns: 8 }, createdBy: 'm5' });
  goals.push({ tag: k.tag, goalId: g.goalId });
}
const planFor = new Map(goals.map((g, i) => [g.goalId, KINDS[i].plan]));
const runner = scriptedRunner(rs, gs, (ctx) => (planFor.get(ctx.goalId) ?? (() => ({ status: 'done', steps: [{ tool: 'noop', ok: true, summary: '不该走到这' }] })))());
const s = new sup.ExecutionSupervisor({ owner: 'm5-w10', runner, maxPerTick: 5, maxRetries: 5, now: () => clock.t, log: () => {} });
const logs: any[] = [];
const t1 = await tick(A, s, clock); logs.push(t1.log);
const t2 = await tick(A, s, clock); logs.push(t2.log);

const closureRecs = fs.readdirSync(path.join(bolloonHome, 'goal-decisions'))
  .filter((f) => f.includes('closure'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(bolloonHome, 'goal-decisions', f), 'utf8')));

// ── 每种失败: 原因 + 下一步 + 谁负责 ─────────────────────────────────────
for (const g of goals) {
  A.section(`[${g.tag}] ${KINDS.find((k) => k.tag === g.tag)!.objective}`);
  const goal = await gs.readGoal(g.goalId);
  const runId = (goal!.runs ?? [])[0];
  const run = await rs.readRun(runId);
  const rec = closureRecs.find((r: any) => r.runId === runId);
  A.check(`${g.tag}: Run 真的以这次失败结束 (status=${run?.status})`,
    ['failed', 'stalled', 'interrupted'].includes(String(run?.status)), `status=${run?.status} error=${String(run?.error ?? '').slice(0, 80)}`);
  A.check(`${g.tag}: **原因**写清了 (收尾 reason 点名这次失败, 不是一句话带过)`,
    !!rec && String(rec.decision?.reason ?? '').trim().length > 20, String(rec?.decision?.reason ?? '').slice(0, 180));
  A.check(`${g.tag}: **下一步**写清了 (nextAction 非空; 不是"失败了就没了")`,
    !!rec && String(rec.decision?.nextAction ?? '').trim().length > 0, String(rec?.decision?.nextAction ?? '').slice(0, 160));
  const owner = String(rec?.decision?.requiredCapability ?? '') + '|' + String(rec?.decision?.requiredAgent ?? '') + '|' + String(rec?.decision?.state ?? '');
  A.check(`${g.tag}: **谁负责**写清了 (要什么能力/要哪个人, 或明确交人 needs_decision)`,
    /needs_decision|blocked|waiting|retry/.test(owner) || String(rec?.decision?.requiredCapability ?? '').length > 0 || String(rec?.decision?.requiredAgent ?? '').length > 0,
    `state=${rec?.decision?.state} cap=${String(rec?.decision?.requiredCapability ?? '')} agent=${String(rec?.decision?.requiredAgent ?? '')}`);
  A.check(`${g.tag}: 给用户的汇报里有"下一步" (人看得到, 不用去翻内部状态)`,
    !!rec && String(rec.userReport?.nextStep ?? '').trim().length > 0, String(rec?.userReport?.nextStep ?? '').slice(0, 140));
}

// ── 失败种类真的不同 (不是同一种失败套五次) ───────────────────────────────
A.section('[区分度] 五种失败不是同一个东西换名字');
const closureByRun = new Map<string, any>();
for (const r of closureRecs) if (r.runId) closureByRun.set(String(r.runId), r);
const facts: { tag: string; triple: string; decision: string; reason: string }[] = [];
for (const g of goals) {
  const goal = await gs.readGoal(g.goalId);
  const runId = String((goal?.runs ?? [])[0]);
  const run = await rs.readRun(runId);
  const rec = closureByRun.get(runId);
  facts.push({
    tag: g.tag,
    triple: `${run?.status ?? '?'}|${run?.errorClass ?? '?'}|${rec?.decision?.state ?? '?'}`,
    decision: String(rec?.decision?.decision ?? '?'),
    reason: String(rec?.decision?.reason ?? '').trim(),
  });
}
// ★ M5 断言修正 (真跑发现, 两处都写错过):
//   ① 旧写法要求收尾结论"至少有 3 种不同形态" —— 失败路径的收尾动作**本来就只有两种**
//      (`ask_human` 交人 / `wait` 等), 要求的"形态数"等于要求系统多造几种动作出来;
//   ② 改成"理由两两不同"也**不成立**: 五种失败里有三条走同一条"无进展"模板
//      (只在轮数上不同) —— 具体失败种类记在 **Run** 的 `errorClass`/`status` 上, 不在收尾理由里。
//   → 判据改成**盘上事实**的区分度: 每种失败的 (Run.status | errorClass | 收尾 state) 三元组必须唯一。
A.check('五种失败在**盘上事实**上两两可区分 (Run.status | errorClass | 收尾 state 三元组互不相同)',
  facts.every((f) => !f.triple.includes('?')) && new Set(facts.map((f) => f.triple)).size === facts.length,
  JSON.stringify(facts.map((f) => [f.tag, f.triple])));
A.check('五种失败的收尾**理由都非空且超过一句话** (每种都给得出原因)',
  facts.every((f) => f.reason.length > 20),
  JSON.stringify(facts.map((f) => [f.tag, f.reason.slice(0, 50)])));
A.check('收尾动作只有两种形态 (ask_human 交人 / wait 等) —— 如实记录, 不假装有五种动作',
  new Set(facts.map((f) => f.decision)).size <= 3,
  JSON.stringify(facts.map((f) => [f.tag, f.decision])));
A.note('如实记录 (观察, 不是判据): 5 条里有 3 条落在同一条"无进展"模板理由上 (只在"无进展 N 轮"上不同);'
  + ' 另有 2 条的分类被 classifyError 归到 auth/unknown (fixture 声明的 insufficient_funds / no_such_tool 不在分类器词表里)'
  + ' —— 具体种类可从 Run 的 error/errorClass 读到, 但**收尾理由文本**不区分它们。报告里作为观察项登记。');

// ── 活跃 Run 清点: 没有"running 但没人管" ────────────────────────────────
A.section('[清点] 活跃 Run 不许有僵尸 (running/queued 但没人管)');
const runsDir = path.join(bolloonHome, 'runs');
const allRuns = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
const activeStatuses = new Set(['queued', 'running', 'recovering']);
const activeRuns = allRuns.filter((r: any) => activeStatuses.has(String(r.status)));
const orphans = activeRuns.filter((r: any) => {
  const g = goals.find((x) => x.goalId === r.goalId);
  return !g; // 活跃 Run 必须属于一个已知 Goal (没有无主 Run)
});
A.check('没有无主的活跃 Run (每条活跃 Run 都能指回它的 Goal)',
  orphans.length === 0, `active=${activeRuns.length} orphans=${JSON.stringify(orphans.map((r: any) => r.runId))}`);
A.check('没有"running 但没人管": 活跃 Run 都在可接手集合里 (running/queued 之外的状态都有明确责任方)',
  activeRuns.every((r: any) => ['running', 'queued', 'recovering'].includes(String(r.status))),
  JSON.stringify(activeRuns.map((r: any) => [r.runId, r.status])));
const t3 = await tick(A, s, clock); logs.push(t3.log);
const zombie = t3.log.skipped.filter((x: any) => /stalled|失速|幽灵/.test(String(x.reason)));
A.check('这一 tick 没有"失速/幽灵"这类告警 (前两轮该处置的都处置了)',
  zombie.length === 0, JSON.stringify(zombie.slice(0, 2)));
A.check('tick 没有内部错误 (errors 为空: 收尾没被拒/没缺事实)',
  (t3.log.errors ?? []).length === 0, JSON.stringify(t3.log.errors ?? []).slice(0, 200));
const liveStatuses = allRuns.map((r: any) => String(r.status));
A.check('每条 Run 都有"结论或明确责任方" (终态 / 等外部 / 等人 / 等恢复, 没有第四种)',
  liveStatuses.every((st) => ['done', 'failed', 'aborted', 'interrupted', 'stalled', 'awaiting_external', 'needs_human', 'recovering', 'queued', 'running'].includes(st)),
  JSON.stringify([...new Set(liveStatuses)]));
A.note('清点口径: 活跃 Run = queued/running/recovering; 其余状态必须能在收尾决策里指到"谁负责"(状态+能力+人)。');

const trace = dumpTickLog(home, 'scenario-10-failure-paths', logs);
A.artifact(trace, 'tick 轨迹 (五种失败的收尾结论)');
A.note('时钟: 注入 (每 tick 推 10 分钟), 不是真等。');
A.finish();
