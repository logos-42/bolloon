/**
 * lib/kill-host.ts — M5-② 的被杀宿主 (子进程)
 *
 * 它做的是**真事**: 起一个 Run、记两步 (其中一步是**非幂等**动作)、存 checkpoint、抢执行权租约,
 * 然后写一个 marker 文件 (父进程据此确认"已经跑到一半"), 之后**等着被 SIGKILL**。
 *
 * 它不是"假的宿主": 落盘的是真 Goal/Run 记录, 用的是真 goal-store / run-store。
 * 用法 (父进程 scenario-02 起它): HOME=<隔离> M5_CHILD_GOAL=<goalId> M5_CHILD_MARKER=<file> npx tsx lib/kill-host.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const goalId = process.env.M5_CHILD_GOAL!;
const marker = process.env.M5_CHILD_MARKER!;
const home = process.env.HOME!;
const src = (p: string) => `../../../../src/agents/${p}`;

const gs: any = await import(src('goal-store.js'));
const rs: any = await import(src('run-store.js'));

const goal = await gs.readGoal(goalId);
if (!goal) {
  fs.writeFileSync(marker, JSON.stringify({ error: `goal 不存在: ${goalId}`, home }));
  process.exit(2);
}
const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId, goal: goal.objective });
await gs.attachRun(goalId, rec.runId);
await rs.recordStep(rec.runId, { tool: 'read_file', ok: true, summary: '第 1/3 步: 读到输入 (幂等)' });
// 非幂等动作: 恢复时**禁止重放** (replayGuards)
await rs.recordStep(rec.runId, {
  tool: 'publish_irreversible',
  ok: true,
  args: { target: 'release-branch' },
  summary: '第 2/3 步: 已把产物发布到远端 (非幂等, 恢复时不许重做)',
});
await rs.saveCheckpoint(rec.runId, {
  completedActions: 2,
  pendingAction: 'collect_receipt',
  nextAction: '第 3/3 步: 收集发布回执并收尾 (前两步已完成, 不要重做)',
  contextRef: path.basename(home),
});
const claimed = await gs.claimGoal(goalId, { owner: `child-${process.pid}`, ttlMs: 3_600_000 });
fs.writeFileSync(marker, JSON.stringify({
  pid: process.pid, runId: rec.runId, goalId, home,
  leaseHeld: !!claimed.ok, leaseId: claimed.lease?.leaseId ?? null, at: new Date().toISOString(),
}, null, 2));
console.log(`[kill-host] pid=${process.pid} run=${rec.runId} 两步已落盘, 等 SIGKILL`);
setInterval(() => {}, 1000);
