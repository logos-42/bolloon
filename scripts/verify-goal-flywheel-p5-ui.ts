/**
 * verify-goal-flywheel-p5-ui.ts — 长期执行面板 (`/goals`) · 真 server 进程 + 真 headless Chrome 真 DOM 验收 (2026-09-25)
 *
 * 为什么要有这个: 「页面上到底显示什么」只有真浏览器真 DOM 能验 —— grep 源码证明不了:
 *   · 状态列显示的是**六类用户可见态** (zh 标签 + 原 code), 还是把内部状态 (retry_wait / stalled / recovering) 直接上屏;
 *   · 真点按「新要求」→ prompt → POST /api/goals/:id/requirement → 下一个 Run 的指令真被改写 (原话逐字),
 *     且已发生的 Run 记录逐字节不变;
 *   · 真点按「唤醒」→ POST /api/goals/:id/wake → **接口/页面/盘上三处是否一致**。
 *
 * ★ 2026-09-25 (P5 收口) 本脚本的断言已从"如实记录缺口"翻成"断言修复后行为" ——
 *   两处缺口 (① 唤醒只清等待事实、goal.status 不动 ⇒ 界面说"已唤醒"而事实没动;
 *   ② 用户原话没进 continuation.nextAction ⇒ 界面上看不到自己提的要求) 都在生产代码里修掉了,
 *   所以下面带 ★ 的检查是**回归门**: 谁再把这两处改回去, 这里立刻红。
 *   每一处都配了阴性对照 (另开一个目标, 验同一动作没有连带改它)。
 *
 * 做法 (与 scripts/verify-mobile-tasks-ui.ts 同款: 真 Chrome + 裸 CDP):
 *   1) 临时 HOME, 用真 goal-store 种两个 Goal (一个"无进展"、一个"等外部") + 一条真 Run;
 *   2) 起**真 web server**: 本脚本以 `--serve` 自孵一个子进程跑 `createWebServer` (页面/路由/存储全真);
 *   3) 真 Chrome headless; 每次点按后回读**盘上的 Goal 事实**对账。
 *
 * ★ 关键工程坑 (代价换来的, 别再踩): **驱动 CDP 的那段代码必须跑在新鲜子进程里** (`--drive`)。
 *   本机实测: 在"自己 spawn 了 server + Chrome 的父进程"里, DevTools 的 WS 能 open、`send` 也不报错,
 *   但**永远收不到任何回包** (Runtime.enable / Runtime.evaluate 全部石沉大海, 只能靠 8s 超时往前走);
 *   同一台机器上, 另一个**新鲜进程**对**同一个 Chrome** 发同一条命令, 立刻拿到结果。
 *   (CLI/SDK 的真实用户拿的是别人起好的 Chrome, 不踩这个坑 ⇒ 这是**验收 harness 的坑, 不是产品缺陷**。)
 *   另一个坑: 把目标 URL 放在 Chrome 命令行上生成的那个"命令行目标", CDP 命令也会石沉大海 ——
 *   所以 Chrome 用 `about:blank` 起, 页面目标一律用 `PUT /json/new?<url>` 新建再驱动。
 *
 * 退出码: 0 = 全过; 1 = 有断言失败; 2 = 环境不满足 (没 Chrome / server 或 CDP 起不来) → 未验证
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8917 + Math.floor(Math.random() * 60);
const CDP_PORT = 9433 + Math.floor(Math.random() * 300);
const SELF = path.resolve(process.argv[1] || 'scripts/verify-goal-flywheel-p5-ui.ts');   // 本文件 (tsx 直接跑; ESM 下没有 __filename)
const MODE = process.argv.includes('--serve') ? 'serve' : process.argv.includes('--drive') ? 'drive' : 'default';
const argAfter = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : ''; };

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    const d = detail === undefined ? '' : ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`;
    console.log(`  ❌ ${name}${d}`);
  }
};

function useTempHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-ui-home-'));
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  process.env.BOLLOON_SETUP_IN_PROGRESS = '1';
  process.env.BOLLOON_RUN_PERSIST = 'strict';
  return h;
}

/** --serve: 只把真 web server 起起来 (子进程里跑) */
async function serveOnly() {
  // ★ 必须复用父进程种好数据的那个 HOME —— 这里再 mkdtemp 一个新的会读到空 store
  const h = argAfter('--serve');
  if (h) { process.env.HOME = h; process.env.USERPROFILE = h; }
  process.env.BOLLOON_SETUP_IN_PROGRESS = '1';
  const { createWebServer } = await import('../src/web/server.js');
  const { port } = await createWebServer(PORT, { selfImprove: false, host: '127.0.0.1' });
  console.log(`P5UI_READY=${port}`);   // 父进程靠这行确认监听
  setInterval(() => { /* 保持常驻 */ }, 60_000);
}

/** --drive <BASE> <CDP_PORT> <HOME> <goalA> <goalB> <原话>: 真 CDP + 真 DOM 断言 (必须新鲜进程) */
async function driveOnly() {
  const BASE = argAfter('--drive');
  const CDP = Number(process.argv[process.argv.indexOf('--drive') + 2]);
  const HOME = process.argv[process.argv.indexOf('--drive') + 3];
  const GOAL_A = process.argv[process.argv.indexOf('--drive') + 4];
  const GOAL_B = process.argv[process.argv.indexOf('--drive') + 5];
  const ORIGINAL = process.argv[process.argv.indexOf('--drive') + 6];
  if (!BASE || !CDP || !HOME || !GOAL_A || !GOAL_B || !ORIGINAL) { console.error('--drive 参数不全 → 未验证'); process.exit(2); }
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  const gs = await import('../src/agents/goal-store.js');
  const rs = await import('../src/agents/run-store.js');
  const types = await import('../src/agents/goal-flywheel/types.js');

  // 新建一个**新鲜页面目标**再驱动 (命令行目标收不到命令, 见文件头)
  let wsUrl = '';
  for (let i = 0; i < 20 && !wsUrl; i++) {
    try {
      // ★ 不要 encodeURIComponent: Chrome 的 /json/new 把 '?' 后面的整串当 URL, 编码了会变成非法地址 (页面停在 about:blank)
      const nt = await fetch(`http://127.0.0.1:${CDP}/json/new?${BASE}/goals`, {
        method: 'PUT', signal: AbortSignal.timeout(5_000),
      });
      const t: any = await nt.json();
      if (t?.webSocketDebuggerUrl) wsUrl = t.webSocketDebuggerUrl;
    } catch { /* 再试 */ }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) { console.error('CDP 没连上 → 未验证'); process.exit(2); }

  const ws = new WebSocket(wsUrl);
  const opened = await new Promise<string>((res) => {
    const t = setTimeout(() => res('timeout'), 10_000);
    ws.onopen = () => { clearTimeout(t); res('open'); };
    ws.onclose = () => { clearTimeout(t); res('closed'); };
    ws.onerror = () => { clearTimeout(t); res('error'); };
  });
  if (opened !== 'open') { console.error(`CDP WebSocket 没打开 (${opened}) → 未验证`); process.exit(2); }

  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const pageErrors: string[] = [];
  ws.onmessage = (ev: any) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 200));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') pageErrors.push('[console] ' + String((m.params.args || []).map((a: any) => a.value || a.description || '').join(' ')).slice(0, 200));
  };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => {
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); res({ timeout: true }); }, 10_000);
    pending.set(mid, (v) => { clearTimeout(t); res(v); });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr: string) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r?.timeout) return { error: 'evaluate 超时', value: undefined } as any;
    const ex = r.result?.exceptionDetails;
    if (ex) return { error: String(ex.exception?.description || ex.text || '').slice(0, 300), value: undefined } as any;
    return { value: r.result?.result?.value };
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}/goals` });   // 显式导航 (不吃 about:blank)

  let loaded = false, lastSeen = '';
  for (let i = 0; i < 40; i++) {
    const r = await evaluate('JSON.stringify({ href: location.href, rs: document.readyState })');
    lastSeen = String(r.value ?? r.error ?? 'null');
    try {
      const v = JSON.parse(String(r.value || '{}'));
      if (String(v.href).includes('/goals') && v.rs === 'complete') { loaded = true; break; }
    } catch { /* 还在换页 */ }
    await new Promise((r2) => setTimeout(r2, 300));
  }
  if (!loaded) { console.error(`页面没加载到 /goals → 未验证 (最后一次读数: ${lastSeen})`); process.exit(2); }
  for (let i = 0; i < 30; i++) {   // 等 refresh() 把两张表填出来
    const r = await evaluate(`document.querySelectorAll('#goals tbody tr').length`);
    if (Number(r.value) >= 2) break;
    await new Promise((r2) => setTimeout(r2, 300));
  }

  console.log(`\n[0] 连接: ${BASE}/goals · CDP=${CDP} · HOME=${HOME}`);
  const runABytesBefore = JSON.stringify(await rs.readRun((await gs.readGoal(GOAL_A))!.runs[0]));

  // ── [1] 结构 + 口径 ────────────────────────────────────────────────────────
  console.log('\n[1] 真 DOM: 页面结构 + 状态列口径 (六类用户可见态)');
  const boot = await evaluate(`(function(){
    function cells(tr){ return Array.prototype.map.call(tr.querySelectorAll('td'), function(td){ return td.textContent.trim(); }); }
    return {
      title: document.title, h1: document.querySelector('h1').textContent.trim(),
      rows: document.querySelectorAll('#goals tbody tr').length,
      runRows: document.querySelectorAll('#runs tbody tr').length,
      sup: document.getElementById('sup').textContent,
      bodyText: document.body.innerText,
      goalCells: Array.prototype.map.call(document.querySelectorAll('#goals tbody tr'), cells),
      buttons: Array.prototype.map.call(document.querySelectorAll('#goals tbody tr:first-child button'), function(b){ return b.textContent.trim(); }),
    };
  })()`);
  const bv: any = boot.value || {};
  check('获取到真 DOM 快照', bv.rows !== undefined, boot.error || '');
  check('页面标题 / H1 是长期执行面板', bv.title === 'Bolloon 长期执行' && bv.h1 === '长期执行面板', { title: bv.title, h1: bv.h1 });
  check('目标表真的渲染出 2 行 (真 API → 真 DOM)', bv.rows === 2, bv.rows);
  check('运行表至少 1 行 (真 /api/runs)', Number(bv.runRows) >= 1, bv.runRows);
  check('Supervisor 条显示 ticks/lease (真 /api/supervisor)', /Supervisor/.test(String(bv.sup)) && /ticks=/.test(String(bv.sup)) && /lease=/.test(String(bv.sup)), bv.sup);
  check('操作列有「新要求」「唤醒」按钮', Array.isArray(bv.buttons) && bv.buttons.includes('新要求') && bv.buttons.includes('唤醒'), bv.buttons);

  const labelNoProgress = types.USER_VISIBLE_STATE_LABELS.no_progress.zh;
  const labelWaiting = types.USER_VISIBLE_STATE_LABELS.waiting_external_reply.zh;
  const cellA = (bv.goalCells || []).find((c: string[]) => c[0].includes(GOAL_A));
  const cellB = (bv.goalCells || []).find((c: string[]) => c[0].includes(GOAL_B));
  check(`目标 A 状态列 = ${labelNoProgress} (no_progress)`, /no_progress/.test(cellA?.[1] || '') && String(cellA?.[1]).includes(labelNoProgress), cellA?.[1]);
  check(`目标 B 状态列 = ${labelWaiting} (waiting_external_reply)`, /waiting_external_reply/.test(cellB?.[1] || '') && String(cellB?.[1]).includes(labelWaiting), cellB?.[1]);
  check('判据列显示 0/2 (真计数)', String(cellA?.[2] || '').includes('0/2'), cellA?.[2]);
  check('下一动作列显示 continuation.nextAction', String(cellA?.[3] || '').includes('等用户决定'), cellA?.[3]);

  console.log('\n[2] 真 DOM 里不出现任何内部状态词');
  for (const w of ['retry_wait', 'stalled', 'recovering', 'leaseId', 'leaseUntil', 'decisionId', 'contentHash']) {
    check(`页面文本不含内部词 ${w}`, !String(bv.bodyText || '').includes(w));
  }

  console.log('\n[3] 真点按「新要求」→ prompt → POST → 下一个 Run 的指令真被改写');
  const click = await evaluate(`(async function(){
    window.__promptCalls = [];
    window.prompt = function(m){ window.__promptCalls.push(String(m)); return ${JSON.stringify(ORIGINAL)}; };
    var trs = document.querySelectorAll('#goals tbody tr');
    var btn = null;
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].textContent.indexOf(${JSON.stringify(GOAL_A)}) >= 0) {
        var bs = trs[i].querySelectorAll('button');
        for (var j = 0; j < bs.length; j++) if (bs[j].textContent.trim() === '新要求') btn = bs[j];
      }
    }
    if (!btn) return { clicked: false };
    btn.click();                                   // 真点按
    for (var k = 0; k < 40; k++) {                 // 等 fetch + refresh 落定
      await new Promise(function(r){ setTimeout(r, 150); });
      var lg = document.getElementById('log').textContent || '';
      if (lg.indexOf('changeId') >= 0 || lg.indexOf('error') >= 0) break;
    }
    return { clicked: true, promptCalls: window.__promptCalls, log: document.getElementById('log').textContent };
  })()`);
  const cv: any = click.value || {};
  check('「新要求」按钮真被点到 (prompt 被调用, 问句含"原话逐字")', cv.clicked === true && String(cv.promptCalls?.[0] || '').includes('原话逐字'), cv.promptCalls || cv.error);
  let logJson: any = null;
  try { logJson = JSON.parse(String(cv.log || '{}')); } catch { /* 非 JSON */ }
  check('页面日志显示 ok:true + changeId (真 POST 回来了)', logJson?.ok === true && !!logJson?.changeId, logJson);
  check('接口回话 = 用户来源 / 已生效 (outcome=next_run)', logJson?.outcome === 'next_run', logJson);
  check('接口回话里"下一 Run 指令"含原话逐字', String(logJson?.nextRunDirective || '').includes(ORIGINAL), String(logJson?.nextRunDirective || '').slice(0, 200));

  const goalAOnDisk = await gs.readGoal(GOAL_A);
  check('盘上 Goal 的 nextAction 真含原话 (下一 Run 会读到)', String(goalAOnDisk?.continuation?.nextAction || '').includes(ORIGINAL), goalAOnDisk?.continuation?.nextAction);
  check('落盘路径存在且含原话', !!logJson?.persistedPath && fs.existsSync(logJson.persistedPath)
    && fs.readFileSync(logJson.persistedPath, 'utf8').includes(ORIGINAL), logJson?.persistedPath);
  check('已发生的 Run 记录逐字节不变 (历史不被改写)', JSON.stringify(await rs.readRun((await gs.readGoal(GOAL_A))!.runs[0])) === runABytesBefore);
  const refreshed = await evaluate(`document.querySelectorAll('#goals tbody tr').length`);
  check('点按后表格照样刷新 (没把页面点崩)', Number(refreshed.value) === 2, refreshed.value);

  console.log('\n[4] 真点按「唤醒」→ 接口怎么说 vs Goal 真状态 (缺口 1 修复后: 接口/页面/盘上三处一致)');
  const aBefore = JSON.stringify(await gs.readGoal(GOAL_A));   // 阴性对照基准: 唤醒 B 之前 A 的记录
  const wake = await evaluate(`(async function(){
    var trs = document.querySelectorAll('#goals tbody tr');
    var btn = null;
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].textContent.indexOf(${JSON.stringify(GOAL_B)}) >= 0) {
        var bs = trs[i].querySelectorAll('button');
        for (var j = 0; j < bs.length; j++) if (bs[j].textContent.trim() === '唤醒') btn = bs[j];
      }
    }
    if (!btn) return { clicked: false };
    document.getElementById('log').textContent = '';
    btn.click();
    for (var k = 0; k < 40; k++) {
      await new Promise(function(r){ setTimeout(r, 150); });
      var lg = document.getElementById('log').textContent || '';
      if (lg.indexOf('woke') >= 0 || lg.indexOf('error') >= 0) break;
    }
    return { clicked: true, log: document.getElementById('log').textContent };
  })()`);
  const wv: any = wake.value || {};
  let wakeJson: any = null;
  try { wakeJson = JSON.parse(String(wv.log || '{}')); } catch { /* 非 JSON */ }
  check('「唤醒」按钮真被点到', wv.clicked === true, wv);
  check('接口回话 = 已唤醒 (woke:true, "下一次 Supervisor tick 会推进它")', wakeJson?.ok === true && wakeJson?.woke === true, wakeJson || wv.log);
  const goalBOnDisk = await gs.readGoal(GOAL_B);
  // ★ 修复后 (原缺口 1 = 唤醒只清等待事实、goal.status 仍是 awaiting_external ⇒ 下一次 tick executed=0)
  check('★ 盘上 Goal 状态真被拉回 active (唤醒不再是空操作)', String(goalBOnDisk?.status) === 'active',
    { status: goalBOnDisk?.status, state: goalBOnDisk?.continuation?.state, wakeReason: goalBOnDisk?.continuation?.wakeReason });
  check('★ continuation.state 同步成 active (界面口径与事实同源)',
    String(goalBOnDisk?.continuation?.state) === 'active', goalBOnDisk?.continuation?.state);
  const apiAfter: any = await (await fetch(`${BASE}/api/goals`, { signal: AbortSignal.timeout(10_000) })).json();
  const visB = apiAfter.visible?.[(apiAfter.goals || []).findIndex((g: any) => g.goalId === GOAL_B)];
  check('★ API visible = executing (接口回话与页面口径不再自相矛盾)', visB === 'executing', visB);
  const labelExecuting = types.USER_VISIBLE_STATE_LABELS.executing.zh;
  const rowAfter = await evaluate(`(function(){
    var trs = document.querySelectorAll('#goals tbody tr');
    for (var i = 0; i < trs.length; i++) if (trs[i].textContent.indexOf(${JSON.stringify(GOAL_B)}) >= 0) return trs[i].querySelectorAll('td')[1].textContent.trim();
    return null;
  })()`);
  check(`★ 界面证据: 页面状态列 = ${labelExecuting} (不再是"等待外部回复")`,
    String(rowAfter.value || '').includes(labelExecuting) && !String(rowAfter.value || '').includes(labelWaiting), String(rowAfter.value || ''));
  // ★ 阴性对照: 这次唤醒只动"真在等外部事件"的那个目标 —— 同页面另一个目标不受牵连
  //   (A 在 [3] 里刚被注入过新要求 ⇒ 它的 continuation.state 由 P4 语义改成 active,
  //    所以这里不拿"状态列 = 无进展"当控制点, 而是直接对账**盘上记录逐字节没被动过**)
  const goalAOnDisk2 = await gs.readGoal(GOAL_A);
  const aAfter = JSON.stringify(goalAOnDisk2);
  check('阴性对照: 唤醒 B 没有动 A 的记录 (逐字节对账)', aBefore === aAfter,
    { before: aBefore.slice(0, 120), after: aAfter.slice(0, 120) });
  check('阴性对照: A 仍然 autoContinue=false (唤醒没有解除它的"等人决定")',
    goalAOnDisk2?.continuation?.autoContinue === false, goalAOnDisk2?.continuation?.autoContinue);

  console.log('\n[5] 页面自身没有 JS 异常');
  check('无未捕获异常 / console.error', pageErrors.length === 0, pageErrors);

  console.log(`\n结果: ${passed} 过 / ${failed} 失败`);
  try { ws.close(); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  if (MODE === 'serve') { await serveOnly(); return; }
  if (MODE === 'drive') { await driveOnly(); return; }   // ★ 别漏: 否则 --drive 子进程会再 spawn 一个自己, 无限递归
  if (!fs.existsSync(CHROME)) { console.error('本机没有 Chrome → 跳过 (未验证)'); process.exit(2); }

  const HOME = useTempHome();
  const gs = await import('../src/agents/goal-store.js');
  const rs = await import('../src/agents/run-store.js');

  // ── 种两个 Goal + 一条真 Run (盘上事实; 页面必须如实反映) ───────────────────
  const goalA = await gs.createGoal({ objective: 'P5-UI 目标 A: 卡住无进展', successCriteria: ['判据0', '判据1'], createdBy: 'p5-ui' });
  const goalB = await gs.createGoal({ objective: 'P5-UI 目标 B: 等外部回复', successCriteria: ['判据0'], createdBy: 'p5-ui' });
  await gs.setContinuation(goalA.goalId, { state: 'stalled', autoContinue: false, wakeReason: 'needs_human', nextAction: '等用户决定是否换计划' });
  await gs.updateGoal(goalB.goalId, { status: 'awaiting_external' });
  await gs.setContinuation(goalB.goalId, { state: 'awaiting_external', autoContinue: true, wakeReason: 'awaiting_external', needsExternal: '等对端回执 (requestId=req-ui-1)' });
  const runA = await rs.startRun({ surface: 'cli', channelId: 'ch', goalId: goalA.goalId, goal: goalA.objective });
  await rs.recordStep(runA.runId, { tool: 'shell_exec', ok: true, summary: '做了一步' });
  await rs.finishRun(runA.runId, { status: 'failed', error: '对端 504' });
  await gs.attachRun(goalA.goalId, runA.runId);

  // ── 子进程起真 web server, 等它报 ready ────────────────────────────────────
  const serverLog: string[] = [];
  const srv: ChildProcess = spawn('npx', ['tsx', SELF, '--serve', HOME], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), P5UI_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout?.on('data', (b: Buffer) => { const s = String(b); serverLog.push(s); process.stdout.write('[srv] ' + s); });
  srv.stderr?.on('data', (b: Buffer) => { serverLog.push(String(b)); });
  let BASE = '';
  for (let i = 0; i < 1200; i++) {   // 真 web server 要起 IPFS/Kubo + DID + Hyperswarm, 本机实测 ~3.5–5 min
    const m = /P5UI_READY=(\d+)/.exec(serverLog.join(''));
    if (m) { BASE = `http://127.0.0.1:${m[1]}`; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!BASE) { console.error('web server 没起来 (P5UI_READY 没出现) → 未验证'); try { srv.kill('SIGKILL'); } catch { /**/ } process.exit(2); }
  const api = await (await fetch(`${BASE}/api/goals`, { signal: AbortSignal.timeout(10_000) })).json() as any;
  console.log(`\n(server 就绪: ${BASE}, /api/goals count=${api.count} visible=${JSON.stringify(api.visible)})`);

  // ── 真 Chrome: about:blank 起, 页面目标用 /json/new 新建 ───────────────────
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-ui-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900',
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  const cleanup = () => {
    try { srv.kill('SIGKILL'); } catch { /**/ }
    try { chrome.kill('SIGKILL'); } catch { /**/ }
  };
  for (let i = 0; i < 40; i++) {
    try {
      const v: any = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3_000) })).json();
      if (v?.webSocketDebuggerUrl) break;
    } catch { /* 再等 */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── 真 DOM 断言: 在**新鲜子进程**里跑 (父进程直接驱动 CDP 收不到回包, 见文件头) ──
  const ORIGINAL = '另外必须支持离线模式, 不许依赖网络';
  const drv = spawn('npx', ['tsx', SELF, '--drive', BASE, String(CDP_PORT), HOME, goalA.goalId, goalB.goalId, ORIGINAL], {
    cwd: process.cwd(), env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  drv.stdout?.on('data', (b: Buffer) => process.stdout.write(String(b)));
  drv.stderr?.on('data', (b: Buffer) => process.stdout.write(String(b)));
  const code: number = await new Promise((res) => drv.on('exit', (c) => res(c ?? 2)));
  cleanup();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  if (code === 2) console.error('DOM 驱动未连上 (环境不满足) → 未验证');
  process.exit(code);
}

main().catch((err) => { console.error('harness 崩了:', err); process.exit(1); });
