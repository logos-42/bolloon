/**
 * lib/park-host.ts — M5-⑤ 的"停在等外部的宿主" (子进程)
 *
 * 它做的是真事: 起一个 Run、记 1 步真进展、存 checkpoint, 然后把这条 Run **停在 awaiting_external**
 * (等外部回话), 再**退出** (宿主停机/重启)。于是盘上留下一条"宿主已不在的停放 Run" ——
 * 这正是"事件到达后必须有人接手"的那个场景。
 *
 * 用法: HOME=<隔离> M5_PARK_GOAL=<goalId> M5_PARK_MARKER=<file> npx tsx lib/park-host.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const goalId = process.env.M5_PARK_GOAL!;
const marker = process.env.M5_PARK_MARKER!;
const src = (p: string) => `../../../../src/agents/${p}`;
const gs: any = await import(src('goal-store.js'));
const rs: any = await import(src('run-store.js'));

const goal = await gs.readGoal(goalId);
if (!goal) {
  fs.writeFileSync(marker, JSON.stringify({ error: `goal 不存在: ${goalId}` }));
  process.exit(2);
}
const rec = await rs.startRun({ surface: 'cli', channelId: 'ch-m5', goalId, goal: goal.objective });
await gs.attachRun(goalId, rec.runId);
await rs.recordStep(rec.runId, { tool: 'http_post', ok: true, summary: '第 1/3 步: 已向外部提交申请 (幂等)' });
await rs.saveCheckpoint(rec.runId, {
  completedActions: 1,
  pendingAction: 'wait_external_reply',
  nextAction: '第 2/3 步: 收到备案号回包后校验 (第 1 步已完成, 不要重做)',
  contextRef: path.basename(process.env.HOME || ''),
});
await rs.finishRun(rec.runId, { status: 'awaiting_external', summary: '外部无响应, 停在等回话' });
// 宿主退出前做它该做的收尾 (生产里 Run 结束同样必过收尾飞轮): 把"这次停在等外部"的结论
// 经唯一写入出口落回 Goal —— 否则 Goal 会停在"执行中", 而界面显示的是**没人会跑**的执行中。
const wiring: any = await import(src('goal-flywheel-wiring.js'));
const closure = await wiring.closeRunOnce({
  goalId, runId: rec.runId, caller: 'runner',
  finalReview: '宿主停机: Run 停在等外部 (等 ICP 备案号回复), 由后续可信事件唤醒后从 checkpoint 接手',
  terminalKind: 'awaiting_external',
}).catch((e: Error) => ({ error: e.message }));
// 收尾写了产物 (上半段) 还要把"下一步是什么"经 reducer 写回 Goal (下半段) —— 生产里
// Supervisor/`onRunTerminal` 都是这么两步走; 少了这一步 Goal 会停在"执行中"。
const applied = (closure as any)?.outcome
  ? await wiring.applyClosureToGoal(goalId, (closure as any).outcome, 'runner').catch((e: Error) => ({ error: e.message }))
  : { skipped: 'closure 没给 outcome' };
fs.writeFileSync(marker, JSON.stringify({
  pid: process.pid, runId: rec.runId, goalId, at: new Date().toISOString(), status: 'awaiting_external',
  closure: JSON.stringify(closure).slice(0, 400),
  applied: JSON.stringify(applied).slice(0, 200),
}, null, 2));
console.log(`[park-host] pid=${process.pid} run=${rec.runId} 停在 awaiting_external, 宿主退出`);
