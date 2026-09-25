/**
 * M5-③ 子 Agent 卡死, 监控接管: 不手动调 sweep, 也能被 `tickOnce` 检出 → 上报 → 交人
 *
 * 真跑面: 真 Goal/Run Store + 真 `ExecutionSupervisor.tickOnce()` (它内部走 M3 的**统一巡检**
 *         `flywheelSeams().monitor.sweepAll`) + 真工作合同 (`dispatchChildWork` 由 Supervisor 的
 *         delegate 分支签发) + 真阻塞判定 (`detectBlocks` / `applyBlockHandling`)。
 * 本场景**一次都不手动调** `collectWorkBlocks` / `sweepAll` —— 检测必须发生在 tick 里面。
 * 时钟: **注入** (子 Agent 的"心跳冻结"用注入时钟表达: 心跳停在 t0, tick 在 t0+10min)。
 *
 * 反事实对照: 同一 tick 里再加一份**心跳新鲜**的子工作 —— 它不得被判 no_heartbeat (证明检测不是无差别开火)。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-03-child-stall.ts
 */
import * as path from 'node:path';
import {
  Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, scriptedRunner,
  tick, dumpTickLog, paths, readJson, exists, iso, type TickLog,
} from './lib/harness.js';

const A = new Acceptance('scenario-03', '子 Agent 卡死: tickOnce 内被检出 → 上报 → 交人 (无需手动 sweep)', '');
const { home } = isolatedHome('sc-03-child-stall');
(A as any).home = home;
console.log(`\n=== M5-③ 子 Agent 卡死被监控接管 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));

const M = await loadMods();
const { gs, rs, sup, wiring, monitor } = M;

const t0 = Date.now();
const events: { kind: string; goalId?: string; message: string }[] = [];

// 目标声明一个本节点没有的能力 → 飞轮的裁决是 delegate (缺能力 → 派活), 合同由 Supervisor 真签发
const goal = await gs.createGoal({
  objective: '需要一个本节点没有的能力才能继续 (子 Agent 会卡死)',
  successCriteria: ['判据0: 能力交付'],
  requiredSkills: ['no-such-capability-xyz'],
  createdBy: 'm5',
});
// 先有一条"失败且零进度"的 Run 事实 → 否则只有 first_run 捷径, 轮不到节奏判定
const r0 = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId: goal.goalId, goal: goal.objective });
await rs.finishRun(r0.runId, { status: 'failed', error: 'ENOTFOUND no-such-capability-xyz 无法解析' });
await gs.attachRun(goal.goalId, r0.runId);

const clock = { t: t0, stepMs: 10 * 60_000 };
const s = new sup.ExecutionSupervisor({
  owner: 'm5-w3',
  runner: scriptedRunner(rs, gs, () => ({
    steps: [{ tool: 'shell_exec', ok: true, summary: '这一步由子 Agent 凭合同交付' }],
  })),
  maxPerTick: 5,
  maxRetries: 2,
  now: () => clock.t,
  onEvent: (e: any) => events.push({ kind: String(e.kind), goalId: e.goalId, message: String(e.message) }),
  log: () => {},
});

// ── tick 1: 真签发工作合同 (子 Agent 拿到活) ────────────────────────────────
const tick1 = await tick(A, s, clock);
A.artifact(await dumpTickLog(home, 'scenario-03-tick1-contract', [tick1.log]) as unknown as string, 'tick1 轨迹 (签发合同)');
A.check('tick1: 真的签发了工作合同 (子 Agent 不是"派个任务", 是管理一份合同)',
  tick1.log.workContracts.length >= 1, JSON.stringify(tick1.log.workContracts));
const workId = tick1.log.workContracts[0]?.workId ?? '';
const contractPath = wiring.contractPathFor(goal.goalId, workId, home);
const contract = await readJson<any>(contractPath);
A.check('合同真落盘 + 带必带证据/成功判据/心跳间隔 (可核验)',
  !!contract && (contract.requiredEvidence ?? []).length > 0 && (contract.successCriteria ?? []).length > 0 && !!contract.heartbeatIntervalMs,
  contract ? `capability=${contract.capability} requiredEvidence=${contract.requiredEvidence.length} heartbeatIntervalMs=${contract.heartbeatIntervalMs}` : '读不到合同');
A.artifact(contractPath, '工作合同');
let g1 = await gs.readGoal(goal.goalId);
A.check('父 Goal 记着"等这份回报" (阻塞巡检的输入面)',
  (g1!.continuation?.pendingReports ?? []).some((p: any) => p.workId === workId),
  JSON.stringify((g1!.continuation?.pendingReports ?? []).map((p: any) => p.workId)));

// ── 冻结子 Agent 的心跳: 只写一次, 之后再也不写 (卡死) ─────────────────────
const hbAt = iso(t0 + 1_000);
await wiring.recordWorkHeartbeat(goal.goalId, workId, hbAt, home);
// 反事实对照用的第二份子工作: 心跳**新鲜**(写在 tick2 时刻附近)
const w2 = await wiring.dispatchChildWork({
  goalId: goal.goalId, parentRunId: r0.runId, childAgentId: 'child-alive', capability: 'alive_cap',
  objective: '心跳正常的子工作 (对照用)', budget: { maxSteps: 5, maxDurationMs: 1_800_000, maxAmount: null, currency: null },
  successCriteria: ['有结论'], now: iso(t0 + 1_000), issuedBy: 'm5', home,
});
await wiring.recordWorkHeartbeat(goal.goalId, w2.workId, iso(t0 + 10 * 60_000), home);

const continuationBefore = (await gs.readGoal(goal.goalId))!.continuation ?? null;

// ── tick 2: **只调 tickOnce**, 检测/上报/交人都必须发生在它内部 ──────────────
const manualSweeps = 0; // 本文件从头到尾没有手动调 collectWorkBlocks / sweepAll
clock.t = t0 + 10 * 60_000;
const tick2 = await tick(A, s, clock);
A.artifact(await dumpTickLog(home, 'scenario-03-tick2-detect', [tick2.log]) as unknown as string, 'tick2 轨迹 (检出 + 上报)');

const stallBlocks = tick2.log.blocks.filter((b) => b.workId === workId);
const aliveBlocks = tick2.log.blocks.filter((b) => b.workId === w2.workId);
A.check('不手动 sweep: 卡死被 tickOnce 自身检出 (report.blocks 出现 no_heartbeat)',
  stallBlocks.some((b) => b.kind === 'no_heartbeat'), JSON.stringify(tick2.log.blocks));
A.check('被处置成"上报父/升级"一档 (处置动作 escalate_parent, 不是越权接管)',
  stallBlocks.some((b) => b.action === 'escalate_parent') && !stallBlocks.some((b) => b.action === 'takeover'),
  JSON.stringify(stallBlocks));
// 冻结口径 (P5/M0 两个测试都钉着): `monitor.escalated` **只收 needs_human 档**; `escalate_parent`
// 是单独一档 —— 所以这里为空是设计, 不是漏报。交人靠 Goal 状态 + 未解决项 + 可见态三处一致来核。
A.check('按冻结口径: escalate_parent 档不进 monitor.escalated 清单 (空 = 设计, 不是漏报)',
  tick2.log.monitorEscalated.length === 0,
  `escalated=${JSON.stringify(tick2.log.monitorEscalated)} actions=${JSON.stringify(stallBlocks.map((b) => b.action))}`);
A.check('巡检这一格自己记着可见态 (tick 内的用户视角, 不是界面另拼)',
  (tick2.report?.monitor?.goals ?? []).some((c: any) => c.goalId === goal.goalId && c.visibleState === 'needs_your_decision'),
  JSON.stringify((tick2.report?.monitor?.goals ?? []).map((c: any) => `${c.goalId}:${c.visibleState}`)));

const g2 = await gs.readGoal(goal.goalId);
A.check('Goal 进入 needs_human + 不再自动唤醒 (交人)',
  g2!.status === 'needs_human' && g2!.continuation?.autoContinue === false,
  `status=${g2!.status} autoContinue=${g2!.continuation?.autoContinue}`);
A.check('未解决项里记着这条阻塞 (不是静默)',
  (g2!.continuation?.unresolvedItems ?? []).join(' ').includes('no_heartbeat'),
  JSON.stringify(g2!.continuation?.unresolvedItems));

// 用户可见态: 阻塞 → 需你决定 (同一份判定函数, 不是界面自己拼一套)
const realBlocks = tick2.report?.monitor?.goals?.find((c: any) => c.goalId === goal.goalId)?.blocks ?? [];
const visibleBefore = monitor.toUserVisibleState(continuationBefore, realBlocks, null);
const visibleAfter = await wiring.goalVisibleState({ goalId: goal.goalId, now: iso(clock.t), home });
A.check('用户可见态走"子 Agent 被阻塞 → 需要你决定" (两个态都是真判定出来的)',
  visibleBefore === 'child_blocked' && visibleAfter === 'needs_your_decision',
  `before=${visibleBefore} after=${visibleAfter} (tick 检出的真 BlockRecord 数=${realBlocks.length})`);

// 反事实对照: 心跳新鲜的子工作不得被判 no_heartbeat
A.check('反事实对照: 心跳新鲜的那份子工作**没有**被判 no_heartbeat (检测不是无差别开火)',
  !aliveBlocks.some((b) => b.kind === 'no_heartbeat'), JSON.stringify(aliveBlocks));
A.check('心跳冻结有物证: 卡死那份的心跳文件停在 t0+1s, 之后再没写',
  (await exists(wiring.heartbeatPathFor(goal.goalId, workId, home))) && (await readJson<any>(wiring.heartbeatPathFor(goal.goalId, workId, home)))?.at === hbAt,
  `heartbeat.at=${(await readJson<any>(wiring.heartbeatPathFor(goal.goalId, workId, home)))?.at} (tick2 时刻=${iso(clock.t)})`);
A.artifact(wiring.heartbeatPathFor(goal.goalId, workId, home), '冻结的心跳文件');
A.artifact(paths.works(home, goal.goalId), 'goal-works 目录 (合同 + 心跳)');

A.note(`本文件手动调 sweepAll/collectWorkBlocks 次数 = ${manualSweeps} (检测全部由 tickOnce 内部完成)`);
A.note(`最终: goal.status=${g2!.status} · 阻塞 kind=${stallBlocks.map((b) => b.kind).join(',')} · 动作=${stallBlocks.map((b) => b.action).join(',')}`);
void paths;
A.finish();
