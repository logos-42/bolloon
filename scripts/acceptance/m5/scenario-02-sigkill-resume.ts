/**
 * M5-② SIGKILL 之后接续: Goal 不许卡在"幽灵运行中"; 从未完成那一步继续; 已完成步骤不重做
 *
 * 真跑面: **真子进程 + 真 `kill -9`** (宿主进程做了一半, 两步真落盘, 其中一步非幂等) →
 *         真 `ExecutionSupervisor.tickOnce()` (启动对账 `reconcileOrphans` → 终止路径收尾) →
 *         真 `prepareResume` 从 checkpoint 续跑。
 * 时钟: **注入** (reconcile 只看 pid 存活 + 状态, 不看时钟; 本场景不需要真等)。
 *
 * 反事实对照: 若"重启后对账"没生效 → 盘上会一直留着 `status=running` 的幽灵 Run, 且 tick 的
 *   `reconciled.interrupted` 为空 (本用例同时钉住这两个事实, 所以它不是靠"事后看着对"过的)。
 *
 * 用法: npx tsx scripts/acceptance/m5/scenario-02-sigkill-resume.ts
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  Acceptance, isolatedHome, seedReadyHome, ensureGoalGate, loadMods, scriptedRunner,
  tick, dumpTickLog, paths, readJson, type TickLog,
} from './lib/harness.js';

const A = new Acceptance('scenario-02', 'SIGKILL 后接续 (无幽灵运行 · 从未完成那步继续 · 不重做)', '');
const { home } = isolatedHome('sc-02-sigkill');
(A as any).home = home;
console.log(`\n=== M5-② SIGKILL 后接续 ===\nHOME=${home}`);

await seedReadyHome({ home, bolloonHome: path.join(home, '.bolloon') }, (m) => A.note(m));
await ensureGoalGate((m) => A.note(m));

const M = await loadMods();
const { gs, rs, sup, wiring } = M;

const goal = await gs.createGoal({
  objective: '做三步 (第 2 步非幂等): 被杀后**从第 3 步继续**, 不许重做前两步',
  successCriteria: ['判据0: 三步全部完成且第 2 步只出现一次'],
  createdBy: 'm5',
});

// ── 1. 真起一个子宿主, 让它跑到一半 ─────────────────────────────────────────
const marker = path.join(home, 'child-marker.json');
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/acceptance/m5/lib/kill-host.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, USERPROFILE: home, BOLLOON_HOME: path.join(home, '.bolloon'), M5_CHILD_GOAL: goal.goalId, M5_CHILD_MARKER: marker },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += String(d); });
child.stderr.on('data', (d) => { childOut += String(d); });

const waitFor = async (fn: () => boolean | Promise<boolean>, ms: number, label: string): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  A.note(`等待超时 (${label})`);
  return false;
};
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const markerOk = await waitFor(() => fs.existsSync(marker), 60_000, '子宿主 marker');
if (!markerOk) {
  A.check('子宿主真的跑到一半 (marker 落盘)', false, `child 输出: ${childOut.slice(-300)}`);
  A.finish();
} else {
  const info = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number; runId: string; leaseHeld: boolean };
  A.check('子宿主真的起了 Run 并落盘两步 + 持执行权', !!(info.runId && info.leaseHeld), JSON.stringify(info));
  A.artifact(path.join(paths.runs(home), `${info.runId}.json`), '被杀前那条 Run 记录 (2 步)');

  // ── 2. 真 SIGKILL ─────────────────────────────────────────────────────────
  process.kill(info.pid, 'SIGKILL');
  const dead = await waitFor(() => !pidAlive(info.pid), 20_000, '子宿主退出');
  A.check('宿主真被 SIGKILL (进程已不在)', dead, `pid=${info.pid}`);
  A.note(`子宿主输出: ${childOut.trim().split('\n').slice(-2).join(' | ')}`);

  const ghost = await rs.readRun(info.runId);
  A.check('杀之后盘上确实留着"running"的幽灵 Run (这才是要治的病)',
    ghost!.status === 'running' && ghost!.pid === info.pid, `status=${ghost!.status} pid=${ghost!.pid}`);
  const stepsBefore = ghost!.steps.map((s: any) => `${s.tool}:${s.ok}`);
  A.check('被杀前已完成 2 步 (含 1 个非幂等动作)', stepsBefore.length === 2 && stepsBefore[1].startsWith('publish_irreversible'), JSON.stringify(stepsBefore));

  // ── 3. 重启: 新 Supervisor 首 tick 真对账 + 真恢复 ─────────────────────────
  //    反事实对照: 另起一条 **pid 还活着** 的 running Run (pid = 本进程) —— 对账必须**留着**它,
  //    否则"对账"就成了无差别杀 running (本用例同时钉住两个方向)。
  const goalAlive = await gs.createGoal({ objective: '反事实: 宿主还活着的一条 Run', successCriteria: ['不该被对账'], createdBy: 'm5' });
  const aliveRun = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId: goalAlive.goalId, goal: goalAlive.objective });
  await gs.attachRun(goalAlive.goalId, aliveRun.runId);

  const clock = { t: Date.now(), stepMs: 60_000 };
  const seenKinds: string[] = [];
  const resumePlans: any[] = [];
  const s = new sup.ExecutionSupervisor({
    owner: 'm5-w2',
    runner: scriptedRunner(rs, gs, (ctx) => {
      seenKinds.push(ctx.kind);
      if (ctx.kind === 'resume') {
        // 只做**剩下那一步**: 收集回执 + 收尾 (前两步一步都不碰)
        return {
          advanceCriteria: 1,
          steps: [{ tool: 'collect_receipt', ok: true, summary: '第 3/3 步: 收到发布回执 (前两步沿用, 未重做)' }],
          evidence: ['receipt.json: 发布回执 (第 3 步产物)'],
        };
      }
      return { steps: [{ tool: 'collect_receipt', ok: true, summary: '不该走到这里 (应该是 resume)' }] };
    }, {
      onRunStarted: async (rec: any) => { resumePlans.push(rec?.prep ?? null); },
    }),
    maxPerTick: 5,
    maxRetries: 5,
    now: () => clock.t,
    log: () => {},
  });
  const logs: TickLog[] = [];
  for (let i = 0; i < 4; i++) {
    const { log } = await tick(A, s, clock);
    logs.push(log);
    if ((await gs.readGoal(goal.goalId))!.status === 'completed') break;
  }
  A.artifact(await dumpTickLog(home, 'scenario-02-sigkill', logs) as unknown as string, 'SIGKILL 后续跑 tick 轨迹');

  const after = await gs.readGoal(goal.goalId);
  const runAfter = await rs.readRun(info.runId);
  const reconciled = logs[0]?.reconciled ?? { interrupted: [], stillRunning: [], failed: [] };

  A.check('重启后 Goal **没有**卡在幽灵运行中 (盘上不再有 running 的 Run)',
    runAfter!.status !== 'running', `run.status=${runAfter!.status}`);
  A.check('那条 Run 被**真判成 interrupted** 并对账 (tick 报告 reconciled.interrupted 里有它)',
    reconciled.interrupted.includes(info.runId), `reconciled=${JSON.stringify(reconciled)}`);
  A.check('Run 最终落回 done (恢复链 interrupted → recovering → running → done 走完)',
    runAfter!.status === 'done', `status=${runAfter!.status}`);
  A.check('恢复动作被记进 Run 的 recovery 事实 (不是我口头说"恢复了")',
    (runAfter as any).recovery?.some((r: any) => r.action === 'resume'), JSON.stringify((runAfter as any).recovery));
  // 反事实对照: 活着的宿主不许被对账误杀
  const aliveAfter = await rs.readRun(aliveRun.runId);
  A.check('反事实对照: pid 仍活着的 Run **不被**误判 interrupted (对账看的是 pid 存活)',
    aliveAfter!.status === 'running' && reconciled.stillRunning.includes(aliveRun.runId) && !reconciled.interrupted.includes(aliveRun.runId),
    `aliveRun.status=${aliveAfter!.status} stillRunning=${JSON.stringify(reconciled.stillRunning)}`);
  A.check('执行器被告知这是 resume (不是从零开新 Run)', seenKinds.includes('resume'), JSON.stringify(seenKinds));
  A.check('没有新开 Run (同一条 Run 续跑, Goal 仍是 1 条 Run)', after!.runs.length === 1, `runs=${JSON.stringify(after!.runs)}`);
  const stepsAfter = runAfter!.steps.map((s2: any) => `${s2.tool}:${s2.ok}`);
  A.check('从**未完成那一步**继续: 第 3 步 collect_receipt 真的做了',
    stepsAfter.some((x) => x.startsWith('collect_receipt:true')), JSON.stringify(stepsAfter));
  A.check('已完成的步骤**不重做**: 步骤数 2 → 3 (不是 4), 前两步与杀前逐条一致',
    stepsAfter.length === 3 && stepsAfter[0] === stepsBefore[0] && stepsAfter[1] === stepsBefore[1],
    `before=${JSON.stringify(stepsBefore)} after=${JSON.stringify(stepsAfter)}`);
  A.check('非幂等动作只出现一次 (publish_irreversible 计数 = 1, 记录条数没翻倍)',
    stepsAfter.filter((x) => x.startsWith('publish_irreversible')).length === 1,
    JSON.stringify(stepsAfter));
  const guardInfo = resumePlans.find((p) => p?.plan)?.plan;
  A.check('真恢复计划指出"已完成 2 步 + 非幂等守卫" (可核验, 不是嘴上说)',
    !!guardInfo && guardInfo.completedSteps?.length === 2 && (guardInfo.replayGuards?.length ?? 0) >= 1,
    guardInfo ? `completedSteps=${guardInfo.completedSteps.length} replayGuards=${JSON.stringify(guardInfo.replayGuards)}` : '没拿到 plan');

  const goalDecisions = await wiring.readDecisionRecords(goal.goalId, home);
  A.check('被杀那条 Run 也走了收尾飞轮 (有 closure 决策记录)',
    goalDecisions.some((r: any) => r.phase === 'closure' && r.runId === info.runId),
    `decision records=${goalDecisions.length}`);
  A.check('恢复后 Goal 状态没有悬空 (明确下一步, 或已终态)',
    ['completed', 'failed', 'abandoned'].includes(String(after!.status)) || !!after!.continuation?.nextAction,
    `status=${after!.status} nextAction=${String(after!.continuation?.nextAction ?? '').slice(0, 80)}`);

  A.note(`最终: goal.status=${after!.status} · run.status=${runAfter!.status} · steps=${stepsAfter.length}`);
  A.finish();
}
