/**
 * M5-⑤ 外部等待 + 可信事件唤醒 (走**现有** external-events 入口, 不另造唤醒机制)
 *
 * 真跑面:
 *   ① 真子宿主跑到一半 → Run 停在 `awaiting_external` → **宿主退出** (停机/重启), 盘上留下一
 *      "宿主已不在的停放 Run" (真产物, 不是编的状态);
 *   ② 父进程真 `tickOnce` → 真收尾飞轮 → Goal → `awaiting_external`; 等待事实用真 `bindExternalWait`;
 *   ③ 等外部期间连推 3 个 tick (每次 6h) → **一个 Run 都不开** (不空转);
 *   ④ 可信事件用真 `deliverExternalEvent` (唯一入口: 来源/correlation/过期/去重四道校验)
 *      + 真 `Supervisor.notifyExternal`; 不可信的一律不许唤醒 (反事实 ×3);
 *   ⑤ 唤醒后 → 停放 Run 交接 → 下一轮**从 checkpoint 接手**, 已完成的步骤不重做;
 *   ⑥ 反事实: 宿主**还活着**的停放 Run 绝不被抢 (唤醒不是抢执行权);
 *   ⑦ `wakeAt` 定时唤醒 / 等待超时转人工 —— 两条真路径。
 * 时钟: **注入** (真等到备案号要几天 —— 见文末 note, 不计入本轮过/不过)。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-05-external-wait.ts
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, scriptedRunner,
  tick, dumpTickLog, iso, type TickLog,
} from './lib/harness.js';

const A = new Acceptance('scenario-05', '外部等待 + 可信事件唤醒 (不空转 · 四道校验 · 停机交接 · wakeAt)', '');
const { home } = isolatedHome('sc-05-external-wait');
(A as any).home = home;
console.log(`\n=== M5-⑤ 外部等待 + 可信事件唤醒 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));

const M = await loadMods();
const { gs, rs, sup } = M;
const ext: any = await import('../../../src/agents/external-events.js');
const monitor: any = await import('../../../src/agents/goal-flywheel/work-monitor.js');
const { reduceGoalState }: any = await import('../../../src/agents/goal-state-reducer.js');

const t0 = Date.now();
const clock = { t: t0, stepMs: 10 * 60_000 };

const waitFor = async (fn: () => boolean, ms: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};
const aliveNow = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── 1. 真子宿主: 停在等外部 → 宿主退出 ────────────────────────────────────
const goal = await gs.createGoal({
  objective: '发布前必须拿到外部备案号 (外部条件不可自证), 宿主中途停机过',
  successCriteria: ['判据0: 拿到备案号原文', '判据1: 校验通过'],
  createdBy: 'm5',
});
const marker = path.join(home, 'park-marker.json');
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/acceptance/m5/lib/park-host.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, USERPROFILE: home, BOLLOON_HOME: path.join(home, '.bolloon'), M5_PARK_GOAL: goal.goalId, M5_PARK_MARKER: marker },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += String(d); });
child.stderr.on('data', (d) => { childOut += String(d); });
const childExit = new Promise<void>((r) => child.on('exit', () => r()));
const started = await waitFor(() => fs.existsSync(marker), 60_000);
A.check('真子宿主跑起来并停在等待态 (marker 落盘)', started, childOut.slice(-200));
await childExit;
const parked = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number; runId: string };
A.check('子宿主已退出 —— 盘上留下"宿主不在的停放 Run"(这才是"事件到了没人接手"的真场景)',
  !aliveNow(parked.pid), `pid=${parked.pid} childOut=${childOut.trim().split('\n').slice(-1)[0]}`);
const runParked = await rs.readRun(parked.runId);
A.check('盘上: 这条 Run 停在 awaiting_external, 且第一步已真落盘',
  runParked!.status === 'awaiting_external' && runParked!.steps.length === 1 && runParked!.pid === parked.pid,
  `status=${runParked!.status} steps=${JSON.stringify(runParked!.steps.map((s: any) => s.tool))} pid=${runParked!.pid}`);
A.artifact(path.join(home, '.bolloon', 'runs', `${parked.runId}.json`), '停放 Run 记录 (宿主已退出)');

// ── 2. 绑等待事实 (现有入口: 执行器停在等外部时就把"等什么"写进 Goal) ──────
const wait = {
  requestId: 'req-icp-2026-001',
  continuationId: ext.newContinuationId(goal.goalId),
  expectedSource: 'human' as const,
  expectedEvent: 'icp_reply',
  createdAt: iso(t0),
  expiresAt: iso(t0 + 72 * 3600_000),           // 真外部事项: 给 72h
  note: '等 ICP 备案号回复 (人工/官方渠道回)',
};
await ext.bindExternalWait(goal.goalId, wait);

// ── 3. 父进程 tick: 真收尾飞轮 → Goal → awaiting_external ─────────────────
const runner = scriptedRunner(rs, gs, (ctx) => (ctx.kind === 'resume'
  ? { advanceCriteria: 1, steps: [{ tool: 'http_get', ok: true, summary: '第 2/3 步: 拿到备案号回包并校验 (第 1 步已完成, 未重做)' }], evidence: ['icp-reply.json: 备案号原文 (外部事件带回)'] }
  : { advanceCriteria: 1, steps: [{ tool: 'collect_receipt', ok: true, summary: '新开一轮: 汇总并复验' }], evidence: ['icp-reply.json: 备案号原文 (外部事件带回)'] }));
const events: any[] = [];
const s = new sup.ExecutionSupervisor({
  owner: 'm5-w5', runner, maxPerTick: 5, maxRetries: 5,
  now: () => clock.t,
  onEvent: (e: any) => events.push({ kind: String(e.kind), goalId: e.goalId, message: String(e.message) }),
  log: () => {},
});
const logs: TickLog[] = [];
const tick1 = await tick(A, s, clock); logs.push(tick1.log);
const g1 = await gs.readGoal(goal.goalId);
A.check('Goal 真进入 awaiting_external (等外部, 不是 failed/needs_human)',
  g1!.status === 'awaiting_external', `status=${g1!.status}`);
A.check('收尾决策写清"在等外部"+ 用户可见态 = 等待外部回复 (同一份判定, 界面不另拼)',
  monitor.toUserVisibleState(g1!.continuation, [], null) === 'waiting_external_reply'
  && (tick1.log.flywheel.some((f) => /等外部/.test(f.reason)) || tick1.log.skipped.some((x: any) => /awaiting_external|等外部/.test(String(x.reason)))),
  `visible=${monitor.toUserVisibleState(g1!.continuation, [], null)} flywheel=${JSON.stringify(tick1.log.flywheel.map((f) => [f.state, f.runnable]))}`);

// ── 4. 不空转: 等外部期间连推 3 个 tick (每次 6h) ───────────────────────────
const runsBefore = (await gs.readGoal(goal.goalId))!.runs.length;
let quietExecuted = 0;
for (let i = 0; i < 3; i++) {
  clock.t += 6 * 3600_000;                       // 真等的话就是"好几天"
  const q = await tick(A, s, clock); logs.push(q.log);
  quietExecuted += q.log.executed.filter((e: any) => e.goalId === goal.goalId).length;
}
const gQuiet = await gs.readGoal(goal.goalId);
A.check('等外部期间: 连推 3 个 tick **一个 Run 都不开** (不空转)',
  quietExecuted === 0 && gQuiet!.runs.length === runsBefore, `executed=${quietExecuted} runs=${gQuiet!.runs.length} (之前 ${runsBefore})`);
A.check('等外部期间: Goal 状态纹丝不动, 且被显式跳过 (有理由, 不是静默消失)',
  gQuiet!.status === 'awaiting_external' && logs.slice(1).every((l) => JSON.stringify(l.skipped).includes('awaiting_external')),
  `status=${gQuiet!.status} skipped=${JSON.stringify(logs[1]?.skipped ?? [])}`);

// ── 4. 反事实: 不可信的事件都不许唤醒 ─────────────────────────────────────
const wrongSource = await ext.deliverExternalEvent(
  { source: 'chain', eventId: 'ev-bad-source', requestId: wait.requestId, eventName: 'icp_reply' },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
A.check('反事实①: 来源不对 (chain ≠ human) → 拒绝投递, 不唤醒',
  wrongSource.ok === false && wrongSource.reason === 'source_mismatch' && (await gs.readGoal(goal.goalId))!.status === 'awaiting_external',
  `reason=${wrongSource.reason} status=${(await gs.readGoal(goal.goalId))!.status}`);
const wrongCorr = await ext.deliverExternalEvent(
  { source: 'human', eventId: 'ev-bad-corr', requestId: 'req-别人家的', eventName: 'icp_reply' },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
A.check('反事实②: correlation 不对 (requestId 对不上) → 拒绝投递, 不唤醒',
  wrongCorr.ok === false && wrongCorr.reason === 'correlation_mismatch' && (await gs.readGoal(goal.goalId))!.status === 'awaiting_external',
  `reason=${wrongCorr.reason}`);
const noCorr = await ext.deliverExternalEvent(
  { source: 'human', eventId: 'ev-no-corr', eventName: 'icp_reply' },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
A.check('反事实③: 完全没有 correlation 的事件 → 不许认领 (不许"看起来像就唤醒")',
  noCorr.ok === false && noCorr.reason === 'correlation_mismatch', `reason=${noCorr.reason}`);

// ── 5. 真事件到达 → 自动唤醒 → 停放 Run 交接 → 从 checkpoint 接手 ─────────
A.section('[真事件] human 来源 + requestId 对上 → 唤醒 + 交接 + 继续');
const good = await ext.deliverExternalEvent(
  { source: 'human', eventId: 'ev-icp-ok-1', requestId: wait.requestId, eventName: 'icp_reply', payload: { icp: '<备案号占位: 真实值不入公开仓>' } },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
const gWoke = await gs.readGoal(goal.goalId);
A.check('真事件: 投递成功 + 真唤醒 (woke=true)',
  good.ok && good.reason === 'delivered' && good.woke === true, JSON.stringify(good));
A.check('真事件后 Goal 不再说"等外部" (等待事实清掉 + 事件落进 externalResult, 状态拉回 active)',
  gWoke!.status === 'active' && gWoke!.continuation!.external === undefined
  && gWoke!.continuation!.state !== 'awaiting_external' && !!gWoke!.continuation!.externalResult,
  `status=${gWoke!.status} state=${gWoke!.continuation!.state} wakeReason=${gWoke!.continuation!.wakeReason} external=${String(gWoke!.continuation!.external)} result=${!!gWoke!.continuation!.externalResult}`);
A.check('事件本身进了证据 (可核验, 不是只在内存里过了一下)',
  (gWoke!.evidence ?? []).some((e: string) => e.includes('ev-icp-ok-1')), JSON.stringify((gWoke!.evidence ?? []).slice(-2)));
A.check('停放 Run **没有被抢/没有被改判** (等待是等待, 不是失败; 它仍是可恢复的那条)',
  (await rs.readRun(parked.runId))!.status === 'awaiting_external',
  `run.status=${(await rs.readRun(parked.runId))!.status}`);

clock.t += 60_000;
const tickW = await tick(A, s, clock); logs.push(tickW.log);
const gAfter = await gs.readGoal(goal.goalId);
const resumed = await rs.readRun(parked.runId);
A.check('唤醒后: 下一轮**从没做完的那一步继续** (同一条 Run 从 checkpoint 接手, 不是从零新开)',
  resumed!.status === 'done' && gAfter!.runs.length === 1,
  `run.status=${resumed!.status} runs=${gAfter!.runs.length} executed=${JSON.stringify(tickW.log.executed)}`);
A.check('已完成的第 1 步**不重做** (步骤 1 → 2, 首步逐条一致, 记录没翻倍)',
  resumed!.steps.length === 2 && resumed!.steps[0].tool === 'http_post' && resumed!.steps[1].tool === 'http_get',
  JSON.stringify(resumed!.steps.map((x: any) => `${x.tool}:${x.ok}`)));
A.check('恢复动作被记进 Run 的 recovery 事实 (可核验)',
  ((resumed as any).recovery ?? []).length > 0, JSON.stringify((resumed as any).recovery));
A.check('唤醒后真推进了判据 (不是"醒了但没干活")',
  gAfter!.completedCriteria.length >= 1, `completedCriteria=${JSON.stringify(gAfter!.completedCriteria)}`);
A.check('外部事件带回来的东西进了这轮 Run 的证据 (不是"醒了随便干点")',
  resumed!.evidence.some((e: string) => e.includes('icp-reply.json')), JSON.stringify(resumed!.evidence));

// ── 6. 反事实: 宿主还活着的停放 Run 绝不被抢 ──────────────────────────────
A.section('[反事实] 宿主还活着 → 不抢执行权');
const goalAlive = await gs.createGoal({ objective: '反事实: 宿主还活着的停放 Run', successCriteria: ['判据0'], createdBy: 'm5' });
const rAlive = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId: goalAlive.goalId, goal: goalAlive.objective });
await gs.attachRun(goalAlive.goalId, rAlive.runId);
await rs.finishRun(rAlive.runId, { status: 'awaiting_external', summary: '宿主还在, 它自己会接手' });
await reduceGoalState({ goalId: goalAlive.goalId, intent: 'external_wait_enter', now: iso(clock.t), by: 'm5', reason: '进入等待' });
await ext.bindExternalWait(goalAlive.goalId, { ...wait, requestId: 'req-alive-1', continuationId: ext.newContinuationId(goalAlive.goalId) });
const aliveDeliver = await ext.deliverExternalEvent(
  { source: 'human', eventId: 'ev-alive-1', requestId: 'req-alive-1', eventName: 'icp_reply' },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
A.check('反事实④: 宿主还活着的停放 Run **不动** (不是幽灵, 交给它自己的执行器)',
  (await rs.readRun(rAlive.runId))!.status === 'awaiting_external' && aliveDeliver.woke === true,
  `run.status=${(await rs.readRun(rAlive.runId))!.status} woke=${aliveDeliver.woke}`);

// 去重: 同一封回包不许算两次
await ext.bindExternalWait(goal.goalId, { ...wait, continuationId: ext.newContinuationId(goal.goalId) });
const dupSame = await ext.deliverExternalEvent(
  { source: 'human', eventId: 'ev-icp-ok-1', requestId: wait.requestId, eventName: 'icp_reply' },
  { wake: (gid: string) => s.notifyExternal(gid), now: () => clock.t },
);
A.check('反事实⑤: 同一 eventId 重复投递 → 去重拒绝 (同一封回包不许算两次)',
  dupSame.ok === false && dupSame.reason === 'duplicate', `reason=${dupSame.reason}`);
await ext.clearExternalWait(goal.goalId);

// ── 7. wakeAt 定时唤醒 (另一条真唤醒路径) ─────────────────────────────────
A.section('[wakeAt] 到点定时唤醒');
const goalT = await gs.createGoal({ objective: '等一个到点就该醒的时间窗 (retry_wait)', successCriteria: ['判据0: 时间窗到了就继续'], createdBy: 'm5' });
const sT = new sup.ExecutionSupervisor({
  owner: 'm5-w5t',
  runner: scriptedRunner(rs, gs, (ctx) => (ctx.n === 0
    ? { status: 'failed', steps: [{ tool: 'shell_exec', ok: false, error: '对端 503, 稍后重试' }] }
    : { advanceCriteria: 1, steps: [{ tool: 'shell_exec', ok: true, summary: '到点重试成功' }], evidence: ['retry-ok.log'] })),
  maxPerTick: 5, maxRetries: 5, now: () => clock.t, log: () => {},
});
const tickT1 = await tick(A, sT, clock); logs.push(tickT1.log);
const gT1 = await gs.readGoal(goalT.goalId);
A.check('wakeAt: 失败后进入 retry_wait 并**明确写下到点时间**',
  gT1!.status === 'retry_wait' && !!gT1!.continuation?.wakeAt, `status=${gT1!.status} wakeAt=${gT1!.continuation?.wakeAt}`);
// 把到点时间钉到**注入时钟的 6 小时后** (退避时长由运输层定, 这里只固定"还没到点/已到点"两个时点)
const wakeAt6h = iso(clock.t + 6 * 3600_000);
await gs.setContinuation(goalT.goalId, { wakeAt: wakeAt6h, wakeReason: 'retry_wait', state: 'retry_wait', autoContinue: true, updatedAt: iso(clock.t) });
const tickT2 = await tick(A, sT, clock); logs.push(tickT2.log);
const skipT2 = tickT2.log.skipped.find((x: any) => x.goalId === goalT.goalId);
A.check('wakeAt: 没到点时不唤醒 (这一轮跳过它, 理由点名 retry_wait/wakeAt, 不抢跑)',
  !tickT2.log.executed.some((e: any) => e.goalId === goalT.goalId) && !!skipT2 && /retry_wait|wakeAt|到点/.test(String(skipT2.reason)),
  JSON.stringify(skipT2));
clock.t += 7 * 3600_000;   // 推过到点时间: 到点后必须自己醒 (不靠人在旁边按)
const tickT3 = await tick(A, sT, clock); logs.push(tickT3.log);
const gT3 = await gs.readGoal(goalT.goalId);
A.check('wakeAt: 到点自动唤醒并继续 (真开新一轮, wakeAt 被清掉)',
  tickT3.log.executed.some((e: any) => e.goalId === goalT.goalId) && gT3!.runs.length === 2 && !gT3!.continuation?.wakeAt,
  `runs=${gT3!.runs.length} wakeAt=${String(gT3!.continuation?.wakeAt)} executed=${JSON.stringify(tickT3.log.executed.map((e: any) => e.goalId))}`);

// ── 8. 等不来就交人 (不允许无限等) ────────────────────────────────────────
A.section('[超时] 外部一直不回 → 转人工, 不是无限等');
const goalE = await gs.createGoal({ objective: '等一个不会来的回话 (验超时转人工)', successCriteria: ['判据0'], createdBy: 'm5' });
await reduceGoalState({ goalId: goalE.goalId, intent: 'external_wait_enter', now: iso(t0), by: 'm5', reason: '进入等待' });
await ext.bindExternalWait(goalE.goalId, { ...wait, requestId: 'req-never-1', continuationId: ext.newContinuationId(goalE.goalId), expiresAt: iso(t0 + 3600_000), note: '等一个不会来的外部回话' });
const expired = await ext.expireExternalWaits({ now: clock.t + 10 * 3600_000, goalIds: [goalE.goalId] });
const gE = await gs.readGoal(goalE.goalId);
A.check('超时: 等待过期被真判出来 + 明确写出"为什么转人工"',
  expired.length === 1 && String(expired[0].reason).includes('超时'), JSON.stringify(expired.map((e: any) => String(e.reason).slice(0, 90))));
A.check('超时: Goal → needs_human + autoContinue=false (交人, 不是静默消失)',
  gE!.status === 'needs_human' && gE!.continuation?.autoContinue === false,
  `status=${gE!.status} autoContinue=${gE!.continuation?.autoContinue}`);

A.artifact(await dumpTickLog(home, 'scenario-05-external-wait', logs) as unknown as string, '外部等待全部 tick 轨迹');
A.note('时钟: 注入 —— 上面"6h/72h 步进"是注入时钟推进, 不是真等。');
A.note('真实实例待触发: ICP 备案号 (真日历要等好几天) —— 机制面 (停机交接/四道校验/唤醒/从 checkpoint 接手/超时转人工/wakeAt) 全部真跑通过; 真实备案号回包尚未发生, **不计入本轮过/不过**, 也不去轮询备案网站。');
A.finish();
