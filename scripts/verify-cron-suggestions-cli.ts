/**
 * verify-cron-suggestions-cli.ts — 终端 /suggestions 与 /cron 真实交互验证
 *
 * 驱动与 TUI processInput 相同的代码路径 (handleSuggestionsCommand + jobs-store/
 * cron-parser/scheduler), 断言每个子命令的可回显输出, 覆盖用户实际操作:
 *   /suggestions         → 列出
 *   /suggestions catalog → 查看内置目录
 *   /suggestions install <key> → 装机 (建议 + 定时任务)
 *   /suggestions list / accept / dismiss / clear
 *   /cron list / add / rm / on / off
 *   Scheduler.tick       → 执行 due job 并 markRun
 *
 * 隔离 HOME: 临时目录, 不碰真实 ~/.bolloon.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-cron-cli-verify-'));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function main() {
  fs.mkdirSync(path.join(TMP, '.bolloon'), { recursive: true });

  // ── [1] /suggestions 列出 + 目录 ──────────────────────────────────
  console.log('[1] /suggestions 列表与目录');
  const { handleSuggestionsCommand } = await import('../src/cron/suggestions-command.js');
  const empty = await handleSuggestionsCommand('', TMP);
  check('空列表提示', /没有待处理建议/.test(empty.text));
  const cat = await handleSuggestionsCommand('catalog', TMP);
  check('catalog 含 daily-review', /daily-review/.test(cat.text));

  // ── [2] /suggestions install 装机 (建议 + 定时任务) ────────────────
  console.log('[2] /suggestions install 装机');
  const inst = await handleSuggestionsCommand('install daily-review', TMP);
  check('install 返回已装机', /已装机/.test(inst.text));
  const { listJobs } = await import('../src/cron/jobs-store.js');
  const jobs = await listJobs(TMP);
  check('装机生成定时任务', jobs.length === 1 && jobs[0].schedule === '0 18 * * *');
  const { listSuggestions } = await import('../src/cron/suggestions.js');
  const sugs = await listSuggestions(TMP);
  check('装机生成建议', sugs.length === 1);

  // ── [3] /suggestions list / accept ────────────────────────────────
  console.log('[3] /suggestions list/accept');
  const lst = await handleSuggestionsCommand('list', TMP);
  check('列表显示装机建议', /每天工作结束后/.test(lst.text));
  const acc = await handleSuggestionsCommand('accept 1', TMP);
  check('accept 消费建议', /已接受/.test(acc.text) && !!acc.accepted);
  check('消费后队列空', (await listSuggestions(TMP)).length === 0);

  // ── [4] /suggestions dismiss / clear ──────────────────────────────
  console.log('[4] /suggestions dismiss/clear');
  const { addSuggestion, clearSuggestions } = await import('../src/cron/suggestions.js');
  await addSuggestion({ dedupKey: 'x', summary: '待清理', source: 'system' }, TMP);
  const dis = await handleSuggestionsCommand('dismiss 1', TMP);
  check('dismiss 忽略建议', /已忽略/.test(dis.text));
  await addSuggestion({ dedupKey: 'y', summary: '又一条', source: 'system' }, TMP);
  const clr = await handleSuggestionsCommand('clear', TMP);
  check('clear 清空', /已清空 1/.test(clr.text));

  // ── [5] /cron list 显示刚装的定时任务 ─────────────────────────────
  console.log('[5] /cron list');
  const { parseSchedule } = await import('../src/cron/cron-parser.js');
  const jobList = await listJobs(TMP);
  const shown = jobList.map((j) => `${j.name} ${j.schedule}`).join(' | ');
  check('list 含每日工作复盘任务', /每日工作复盘/.test(shown));
  check('schedule 可解析', parseSchedule(jobList[0].schedule) != null);

  // ── [6] /cron on/off + Scheduler.tick 执行 due job ───────────────
  console.log('[6] Scheduler.tick 执行 + enabled 开关');
  const { setEnabled } = await import('../src/cron/jobs-store.js');
  const { addJob, removeJob } = await import('../src/cron/jobs-store.js');
  // 关闭 daily-review (cron 不定时, 只验证 enabled 状态翻转)
  await setEnabled(jobList[0].id, false, TMP);
  check('off → enabled=false', (await listJobs(TMP)).every((j) => !j.enabled));
  await setEnabled(jobList[0].id, true, TMP);
  check('on → enabled=true', (await listJobs(TMP)).every((j) => j.enabled));

  // 新增一条立刻 due 的 job, 验证 tick 执行 + markRun
  const quick = await addJob({ name: '立刻任务', schedule: '1s', prompt: '跑' }, TMP);
  const { Scheduler } = await import('../src/cron/scheduler.js');
  let executed: string[] = [];
  const sched = new Scheduler({ exec: async (j) => { executed.push(j.name); }, home: TMP });
  const ran = await sched.tick();
  check('tick 执行 due job', ran >= 1 && executed.includes('立刻任务'));
  check('执行后 runCount 递增', (await listJobs(TMP)).find((j) => j.id === quick.id)!.runCount >= 1);
  await removeJob(quick.id, TMP);

  // ── [7] error 恢复链路 (chat 层 429 → baseLesson 新教训) ───────────
  console.log('[7] error 分类 + recovery plan');
  const { classifyApiError, planRecovery } = await import('../src/llm/error-lessons.js');
  const c = classifyApiError(new Error('429 Too Many Requests'));
  check('429 → rate-limit + backoff-retry', c.category === 'rate-limit' && c.recovery === 'backoff-retry');
  const p = planRecovery(c, 0);
  check('backoff-retry 计划可重试', p.shouldRetry && p.backoffMs === 1000);

  // ── [8] loop-noise 过滤 ───────────────────────────────────────────
  console.log('[8] loop-noise 良性噪音抑制');
  const { isBenignClientWriteNoise } = await import('../src/web/loop-noise.js');
  check('write after end → 良性噪音', isBenignClientWriteNoise(new Error('write after end')));
  check('WinError 10054 → 良性噪音', isBenignClientWriteNoise({ message: 'Error [WinError 10054]' }));
  check('真实错误不吞', !isBenignClientWriteNoise(new Error('Auth failed')));

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('验证脚本失败:', e); process.exit(1); });