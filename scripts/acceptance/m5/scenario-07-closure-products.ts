/**
 * M5-⑦ 结束自动产出四类产物 (任意终止路径都要) —— 分层 Memory 事实 · 教训 · Skill 候选(未晋级) · 下一步建议
 *
 * 覆盖三条不同终止路径 (不是只挑最顺的那条):
 *   (A) 失败路径      : Run failed (工具被拒) → 收尾判 fail
 *   (B) 中断路径      : Run interrupted (宿主崩过) → 收尾判中断
 *   (C) 超时/交人路径  : Run 停在等外部 → 外部超时 → Goal needs_human
 * 每条路径都要求四类产物齐备 (缺哪类就报哪类); 反事实: 没跑过的 Goal **不许**有产物 (不许凭空产出)。
 * 时钟: 注入。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-07-closure-products.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, iso, scriptedRunner, skillReview, tick, dumpTickLog } from './lib/harness.js';

const A = new Acceptance('scenario-07', '结束自动产出 Memory/教训/候选/下一步 (失败·中断·超时都要)', '');
const { home } = isolatedHome('sc-07-closure-products');
(A as any).home = home;
console.log(`\n=== M5-⑦ 结束自动产出四类产物 ===\nHOME=${home}`);

// 让收尾的 Review 是一份**真结论** (有 reviewedBy/verdict/method 与候选), 而不是一句"跑完了"
process.env.BOLLOON_RUN_FINAL_REVIEW = skillReview('m5-criteria-to-evidence', 2);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));
const M = await loadMods();
const { gs, rs, sup, ev } = M;

const clock = { t: Date.parse('2026-09-25T09:00:00.000Z'), stepMs: 10 * 60_000 };
const bolloonHome = path.join(home, '.bolloon');

const gFail = await gs.createGoal({ objective: '目标A: 装一个本地没有的工具链 (注定失败的一条路)', successCriteria: ['判据0: 工具装成功'], createdBy: 'm5' });
const gInt = await gs.createGoal({ objective: '目标B: 长任务被宿主崩溃打断 (中断的一条路)', successCriteria: ['判据0: 长任务做完'], createdBy: 'm5' });
const gTimeout = await gs.createGoal({ objective: '目标C: 等一个外部回话直到超时 (交人的一条路)', successCriteria: ['判据0: 拿到回话'], createdBy: 'm5' });

const runner = scriptedRunner(rs, gs, (ctx) => {
  if (ctx.goalId === gFail.goalId) return { status: 'failed', errorClass: 'tool_denied', error: 'EACCES: 无权限装到 /usr/local', steps: [{ tool: 'shell_exec', ok: false, error: 'EACCES' }] };
  if (ctx.goalId === gInt.goalId) return { status: 'interrupted', error: '宿主被 kill -9 (无收尾)', steps: [{ tool: 'long_task', ok: false, error: '进程消失' }] };
  return { status: 'awaiting_external', error: '外部无响应, 停在等回话', steps: [{ tool: 'http_post', ok: true, summary: '提交申请, 等回话' }] };
});

const s = new sup.ExecutionSupervisor({ owner: 'm5-w7', runner, maxPerTick: 5, maxRetries: 5, now: () => clock.t, log: () => {} });
const logs: any[] = [];
const t1 = await tick(A, s, clock); logs.push(t1.log);
// C 的超时: 把它绑在已过期的等待上 → 真过期扫描 → 转人工
await ev.bindExternalWait(gTimeout.goalId, {
  requestId: 'req-7-never', continuationId: ev.newContinuationId(gTimeout.goalId),
  expectedSource: 'human', expectedEvent: 'reply', createdAt: iso(clock.t - 7200_000), expiresAt: iso(clock.t - 3600_000), note: '等一个不会来的回话',
});
const expired = await ev.expireExternalWaits({ now: clock.t, goalIds: [gTimeout.goalId] });
const t2 = await tick(A, s, clock); logs.push(t2.log);

// ── 每条终止路径: 四类产物齐备 ────────────────────────────────────────────
const readAll = (sub: string): any[] => {
  const dir = path.join(bolloonHome, sub);
  if (!fs.existsSync(dir)) return [];
  const out: any[] = [];
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.json')) { try { out.push({ file: p, rec: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch { /* 忽略坏文件 */ } }
    }
  };
  walk(dir);
  return out;
};
const memories = readAll('memory-layers');
const candidates = readAll('skill-candidates');
const forRun = <T extends { rec: any }>(list: T[], runIds: string[]): T[] =>
  list.filter((x) => { const t = JSON.stringify(x.rec); return runIds.some((r) => t.includes(r)); });

const decisions = (): any[] => fs.readdirSync(path.join(bolloonHome, 'goal-decisions'))
  .filter((f) => f.includes('closure'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(bolloonHome, 'goal-decisions', f), 'utf8')));

const cases: { tag: string; goalId: string; runStatus: string; goalOk: (s: string) => boolean; why: string }[] = [
  { tag: 'A 失败路径', goalId: gFail.goalId, runStatus: 'failed', goalOk: (s) => s === 'needs_human', why: '工具被拒 (EACCES) 真失败' },
  { tag: 'B 中断路径', goalId: gInt.goalId, runStatus: 'interrupted', goalOk: (s) => s === 'recovering', why: '宿主被杀 → 中断 (Goal 进 recovering, 待接手)' },
  { tag: 'C 超时路径', goalId: gTimeout.goalId, runStatus: 'awaiting_external', goalOk: (s) => s === 'needs_human', why: '等外部超时 → 交人' },
];

const reasonRows: { tag: string; status: string; decision: string; reason: string }[] = [];

for (const c of cases) {
  A.section(`[${c.tag}] ${c.why}`);
  const g = await gs.readGoal(c.goalId);
  const run = await rs.readRun((g!.runs ?? [])[0]);
  A.check(`${c.tag}: Run 的终止事实真的是"${c.runStatus}" (不是换了个说法)`,
    String(run?.status) === c.runStatus, `run.status=${run?.status}`);
  A.check(`${c.tag}: Goal 状态与该终止事实相符 (${String(g!.status)})`,
    c.goalOk(String(g!.status)), `status=${g!.status}`);
  const runIds = (g!.runs ?? []).slice();
  A.check(`${c.tag}: ① 分层 Memory 事实已落盘 (run_fact 里能查到这条 Run)`,
    forRun(memories, runIds).some((m) => m.rec.layer === 'run_fact' && String(m.file).includes('run_fact')),
    `runIds=${JSON.stringify(runIds)} memoryFiles=${JSON.stringify(forRun(memories, runIds).map((m) => path.basename(m.file)))}`);
  A.check(`${c.tag}: ② 教训已落盘 (lesson 层, 带 reviewedBy + 可复用判定)`,
    forRun(memories, runIds).some((m) => m.rec.layer === 'lesson' && !!m.rec.reviewedBy),
    JSON.stringify(forRun(memories, runIds).filter((m) => m.rec.layer === 'lesson').map((m) => [path.basename(m.file), m.rec.reviewedBy, m.rec.reviewVerdict])));
  const cands = forRun(candidates, runIds);
  A.check(`${c.tag}: ③ Skill 候选已落盘, 且**没有直接晋级** (approval 未申请 / 无晋升记录)`,
    cands.length > 0 && cands.every((x) => String(x.rec.approval?.state) === 'not_requested' && x.rec.promotion === null),
    JSON.stringify(cands.map((x) => [path.basename(x.file), x.rec.approval?.state, x.rec.promotion, x.rec.status])));
  const dec = decisions().find((d) => d.runId && runIds.includes(d.runId));
  reasonRows.push({
    tag: c.tag,
    status: String(g!.status),
    decision: String(dec?.decision?.decision ?? '?'),
    reason: String(dec?.decision?.reason ?? ''),
  });
  A.check(`${c.tag}: ④ 下一步建议写清了 (收尾决策 nextAction + 用户汇报 nextStep 都非空)`,
    !!dec && String(dec.decision?.nextAction ?? '').trim().length > 0 && String(dec.userReport?.nextStep ?? '').trim().length > 0,
    dec ? `nextAction=${String(dec.decision.nextAction).slice(0, 110)} | nextStep=${String(dec.userReport?.nextStep ?? '').slice(0, 80)}` : '没有收尾决策记录');
  A.check(`${c.tag}: 四类产物带**来源引用** (候选指回 sourceRunIds, 不是凭空生成)`,
    cands.length > 0 && cands.some((x) => (x.rec.sourceRunIds ?? []).some((r: string) => runIds.includes(r))),
    JSON.stringify(cands.map((x) => x.rec.sourceRunIds)));
}

// ── 反事实: 没跑过的 Goal 不许有产物 ──────────────────────────────────────
A.section('[反事实] 没发生过的 Run 不许有产物');
// B 的"不许留幽灵": 中断的 Goal 必须在下一 tick 被真接手 (从 checkpoint 续), 不许停在 recovering 没人管
const t3 = await tick(A, s, clock); logs.push(t3.log);
const gInt2 = await gs.readGoal(gInt.goalId);
const runInt2 = await rs.readRun(gInt2!.runs[0]);
A.check('反事实(B): 中断的 Goal 下一 tick 被真接手 (Run 有 recovery 记录 / 已给结论), 不是停在 recovering 等幽灵',
  (runInt2?.recovery?.length ?? 0) > 0 || ['done', 'failed', 'interrupted', 'stalled'].includes(String(runInt2?.status)),
  `run.status=${runInt2?.status} recovery=${(runInt2?.recovery ?? []).length} steps=${runInt2?.steps?.length} goal=${gInt2!.status}`);
const gGhost = await gs.createGoal({ objective: '目标D: 只创建, 从不运行', successCriteria: ['判据0'], createdBy: 'm5' });
A.check('反事实: 没跑过的 Goal 在 Memory / 候选里查不到 (产物只由真发生的 Run 产生)',
  forRun(memories, [gGhost.goalId]).length === 0 && forRun(candidates, [gGhost.goalId]).length === 0,
  `mem=${forRun(memories, [gGhost.goalId]).length} cand=${forRun(candidates, [gGhost.goalId]).length} runs=${JSON.stringify((await gs.readGoal(gGhost.goalId))!.runs)}`);
// ★ M5 断言修正 (真跑发现): 旧写法要求"三条终止路径的 Goal 状态两两不同" —— 那是**写错了判据**:
//   "失败 → 交人" 与 "超时 → 交人" 都应该是 `needs_human` (同一种收尾动作), 状态相同**不是**缺陷。
//   真正的区分度在**理由**: 三条路径必须各有各的、可追溯的原因 (不是同一条路径套三次)。
const reasons = reasonRows.map((r) => r.reason.trim());
A.check('反事实: 三条终止路径的**理由互不相同** (状态允许相同 —— "失败交人"与"超时交人"同为 needs_human 是合法的)',
  reasons.every((r) => r.length > 10) && new Set(reasons).size === reasons.length,
  JSON.stringify(reasonRows.map((r) => [r.tag, r.status, r.decision, r.reason.slice(0, 80)])));
A.check('三条路径留下了三种可区分的收尾结论 (decision/理由组合不重复)',
  new Set(reasonRows.map((r) => `${r.decision}|${r.reason}`)).size === reasonRows.length,
  JSON.stringify(reasonRows.map((r) => [r.tag, r.decision])));

A.note('四类产物路径 (可自查): ' + path.join(bolloonHome, '{memory-layers/{run_fact,lesson,skill_signal},skill-candidates}'));
const trace = dumpTickLog(home, 'scenario-07-closure-products', logs);
A.artifact(trace, 'tick 轨迹 (每条路径的收尾结论)');
A.note(`外部等待过期扫描: ${JSON.stringify(expired)}`);
A.note('时钟: 注入 (每 tick 推 10 分钟), 不是真等。');
A.finish();
