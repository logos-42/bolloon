/**
 * verify-mobile-tasks-ui.ts — 手机端「任务」页 · 真 headless Chrome 验收 (2026-09-25)
 *
 * 为什么要有这个: `data-zh/data-en`、textContent-only、确认页、相对时间只改文字节点 ——
 * 这些都只有在**真浏览器真 DOM** 里才能验; grep 源码证明不了任何一条。
 *
 * 做法 (与 scripts/verify-agent-card-ui.ts 同款: 真 Chrome + 裸 CDP, 不依赖 playwright):
 *   · 起一个静态服务器服务 dist/web (localhost → localStorage 可用)
 *   · 真 Chrome headless 打开 mobile.html
 *   · **只替换传输层**: 把 window.BolloonCore.tasks 的 listGroups/joinGroup/... 换成桩,
 *     relative/shorten/scanText/emptyRequest/describeConfirm 仍用**真的**打包产物
 *     (也就是说: 投影与红线自检走的是手机侧真实代码, 不是测试里重写的)
 *   · 真点按 → 断言真 DOM: 页面文本里绝不出现原始 id/DID; 未签名时不发请求;
 *     确认页展示待发内容; 双语切换真的换文字; 减少动态效果真的生效
 *
 * 退出码: 0 = 全过; 1 = 有断言失败; 2 = 环境不满足 (本机没有 Chrome)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve('dist/web');
const PORT = 8811 + Math.floor(Math.random() * 200);
const CDP_PORT = 9333 + Math.floor(Math.random() * 300);
const PROFILE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'mobile-tasks-chrome-'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    const d = detail === undefined ? '' : ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`;
    console.log(`  ❌ ${name}${d}`);
  }
};

function serve(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const rel = url === '/' ? '/mobile.html' : url;
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('本机没有 Chrome → 跳过 (未验证)'); process.exit(2); }
  if (!fs.existsSync(path.join(ROOT, 'mobile.html'))) { console.error('dist/web/mobile.html 不存在 → 先 npm run build:web'); process.exit(2); }

  const srv = await serve();
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=430,932',
    `http://127.0.0.1:${PORT}/mobile.html`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let wsUrl = '';
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list: any = await r.json();
      const page = list.find((t: any) => t.type === 'page' && String(t.url).includes('mobile.html'));
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!wsUrl) { console.error('CDP 没连上'); srv.close(); chrome.kill('SIGKILL'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e: any) => rej(e); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const exceptions: string[] = [];
  ws.onmessage = (ev: any) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Log.entryAdded') {
      const e = m.params?.entry || {};
      // 只记"页面自己的错"; 本 harness 的静态服务没有 favicon/manifest 之类的资源 → 404 归噪音
      if (e.level === 'error' && !/status of 404/.test(String(e.text || ''))) {
        exceptions.push('[log] ' + String(e.text || '').slice(0, 300));
      }
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      exceptions.push('[console] ' + String((m.params.args || []).map((a: any) => a.value || a.description || '').join(' ')).slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 200));
    }
  };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => {
    const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr: string) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) {
      const desc = String(ex.exception?.description || ex.text || '').slice(0, 300);
      console.log(`  [harness] evaluate 抛错: ${desc.split('\n')[0]}`);
      return { error: desc };
    }
    return { value: r.result?.result?.value };
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // 踩过的坑: headless Chrome 的 CDP 目标可能停在 about:blank (URL 参数只在新建 tab 时生效),
  // 那样就会"对着空白页断言全绿/全红"。所以这里**显式导航**并等到真文档 + load 完成。
  const PAGE_URL = `http://127.0.0.1:${PORT}/mobile.html`;
  await send('Page.navigate', { url: PAGE_URL });
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await evaluate('JSON.stringify({ href: location.href, rs: document.readyState })');
      const v = JSON.parse(String(r.value || '{}'));
      if (String(v.href).includes('mobile.html') && v.rs === 'complete') { loaded = true; break; }
    } catch { /* 还在换页 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!loaded) { console.error('页面没加载到 mobile.html → 未验证'); srv.close(); chrome.kill('SIGKILL'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 2500));   // 等 mobile.js / mobile-core.js 初始化

  console.log('[1] 页面与「任务」tab');
  const boot = await evaluate(`(function(){
    return {
      tabs: document.querySelectorAll('.tab').length,
      tabLabels: Array.prototype.map.call(document.querySelectorAll('.tab'), function(t){ return t.textContent.trim(); }),
      hasTasksPage: !!document.getElementById('page-tasks'),
      hasUi: !!(window.__mobileTasksUi),
      coreLoaded: !!(window.BolloonCore && window.BolloonCore.tasks),
      realHelpers: !!(window.BolloonCore && window.BolloonCore.tasks && typeof window.BolloonCore.tasks.relative === 'function' && typeof window.BolloonCore.tasks.scanText === 'function'),
      langApi: !!(window.__mobileLang && window.__mobileLang.set),
    };
  })()`);
  check('5 个 tab (含「任务」)', boot.value?.tabs === 5, boot.value?.tabLabels);
  check('#page-tasks 存在', boot.value?.hasTasksPage === true, boot.value);
  check('任务页 UI 已挂载 (window.__mobileTasksUi)', boot.value?.hasUi === true, boot.value);
  check('mobile-core 的真投影助手可用 (relative/shorten/scanText)', boot.value?.realHelpers === true, boot.value);
  check('双语 API 存在 (window.__mobileLang)', boot.value?.langApi === true, boot.value);

  const clickTab = await evaluate(`(function(){
    var t = document.querySelector('.tab[data-tab="tasks"]');
    t.click();
    return { title: document.getElementById('topbar-title').textContent, hidden: document.getElementById('page-tasks').hidden, active: t.className };
  })()`);
  check('真点按 tab → 任务页显示 + 标题变「任务」', clickTab.value?.hidden === false && clickTab.value?.title === '任务', clickTab.value);

  console.log('\n[2] 只换传输层 (投影/红线自检用真产物) + 真渲染');
  const RAW_GROUP_ID = 'zdpuAqzRawGroupStoreId1234567890';
  const RAW_ANN_ID = 'ann-19d92abef510ff86';
  const RAW_DID = 'did:key:z6MkShouldNeverRender';
  const HOSTILE = '<img src=x onerror=alert(1)>恶意群名';
  const stub = await evaluate(`(function(){
    var real = window.BolloonCore.tasks;
    window.__realTasks = real;      // 真 transport 留在这里, 最后一节要用它验"够不着就如实说"
    var calls = [];
    var rec = { calls: calls, alertTexts: [], hint: '' };
    window.__probe = rec;
    window.alert = function(m){ rec.alertTexts.push(String(m)); };
    function ok(data){ return Promise.resolve({ ok: true, data: data }); }
    window.BolloonCore.tasks = Object.assign({}, real, {
      deviceSigning: function(){ return rec.canSign !== false; },
      hint: function(){ return '上次: 已入群「协作群」'; },
      setHint: function(t){ rec.hint = String(t); },
      listGroups: function(){ calls.push('listGroups'); return ok([
        { id: ${JSON.stringify(RAW_GROUP_ID)}, name: ${JSON.stringify(HOSTILE)}, idShort: 'zdpuAqzRawGr…', joinedAt: '2026-09-25T02:00:00.000Z' }
      ]); },
      loadBoard: function(){ calls.push('loadBoard'); return ok({ items: [{
        idShort: 'ann-19d92abe…', ref: ${JSON.stringify(RAW_ANN_ID)}, capability: 'research', status: 'open',
        statusLabel: { zh: '可接单', en: 'Open for claims' }, budgetLabel: '50000 USDC · base-sepolia',
        deadlineInMs: 3600000, createdAtMs: Date.now() - 60000, claimCount: 1, preview: '调研某类厨房用品',
        remote: false, claimable: true, signatureVerified: true
      }], localCount: 1, remoteCount: 0, registryReady: true, registryError: null, notes: ['注册表只读到本机那份'] }); },
      loadFlywheel: function(){ calls.push('loadFlywheel'); return ok({ goals: [{
        objectiveShort: '把手机端能力补齐', status: 'active', terminal: false,
        view: { visibleState: 'waiting_external_reply', stateLabel: { zh: '在等外部回复', en: 'Waiting for a reply' },
          report: { conclusion: '已经发出去了, 在等对方', completed: ['判据 #1'], evidence: ['e1'], remaining: ['判据 #2'],
            blockReasons: ['等对接人回', '等对接人回2'], nextStep: '先把判据 #2 的样本补齐', willContinue: true,
            expectedResumeAt: '2026-09-25T03:00:00.000Z', visibleState: 'waiting_external_reply',
            exposedFields: ['conclusion'], generatedAt: '2026-09-25T02:00:00.000Z' },
          blocks: [{ kind: 'buyer_no_reply', kindLabel: { zh: '买家没回', en: 'no buyer reply' },
            ownerLabel: { zh: '买方', en: 'buyer' }, actionLabel: { zh: '催一次', en: 'ping once' }, suggestedAction: 'ping',
            blockedForMs: 7200000, dependency: '对方回复', note: '群消息发了 2 小时没人接', escalationAt: null,
            lastProgressAt: '2026-09-25T00:00:00.000Z' }],
          resumeInMs: 5400000, requiredAgent: '指定执行者: agent-77', riskLevel: 'medium', generatedAt: '2026-09-25T02:00:00.000Z',
          _leak: 'lease' } },
        { objectiveShort: '上季度的渠道调研', status: 'completed', terminal: true,
          view: { visibleState: 'ended', stateLabel: { zh: '已结束', en: 'Ended' },
            report: { conclusion: '这个目标已经结束', completed: ['判据 #1', '判据 #2'], evidence: [], remaining: [],
              blockReasons: [], nextStep: '已经结束了 —— 看看结论, 决定要不要立新目标', willContinue: false,
              expectedResumeAt: null, visibleState: 'ended', exposedFields: ['conclusion'], generatedAt: '2026-09-25T02:00:00.000Z' },
            blocks: [], resumeInMs: null, requiredAgent: null, riskLevel: null, generatedAt: '2026-09-25T02:00:00.000Z' } }
      ], hint: null, note: '本页只读消费 goal-flywheel 的六类用户可见状态 (toUserVisibleState)' }); },
      loadTrail: function(){ calls.push('loadTrail'); return ok({ count: 2, byKind: { announce: 1, claim: 1 }, entries: [
        { idShort: 'ann-19d92abe…', kind: 'announce', kindLabel: { zh: '公告', en: 'Announce' }, sender: 'agent-2d86796f',
          atMs: Date.now() - 120000, facts: [{ k: 'id', v: 'ann-19d92abe…' }, { k: 'cap', v: 'research' }] },
        { idShort: 'ann-19d92abe…', kind: 'claim', kindLabel: { zh: '接单声明', en: 'Claim' }, sender: 'agent-2d86796f',
          atMs: Date.now() - 60000, facts: [{ k: 'price', v: '0.05' }, { k: 'judge', v: ${JSON.stringify(RAW_DID)} }] }
      ], announcementIdsShort: ['ann-19d92abe…'], flags: { announced: true }, inconsistencies: [], redactedCount: 1, ignoredMessages: 1, privacyHits: true }); },
      previewGroupMessage: function(req){ calls.push('preview'); rec.lastPreviewReq = req; return Promise.resolve({ ok: true, data: { text: '[bolloon-task] v=1 kind=announce id=' + String(req.announcementId).slice(0,12) + ' cap=research round=- judge=(未写判据)' } }); },
      execute: function(req){ calls.push('execute'); rec.lastExecuteReq = req; return Promise.resolve({ ok: true, data: { kind: req.kind, text: '已入群「协作群」' } }); },
      emptyRequest: real.emptyRequest, describeConfirm: real.describeConfirm, relative: real.relative,
      shorten: real.shorten, scanText: real.scanText
    });
    return window.__mobileTasksUi.refresh().then(function(){ return { done: true }; });
  })()`);
  check('refresh() 跑通 (桩只换传输层)', stub.value?.done === true, stub.value);

  const rendered = await evaluate(`(function(){
    var txt = document.getElementById('page-tasks').innerText;
    var groups = document.getElementById('tasks-groups');
    var board = document.getElementById('tasks-board');
    var fw = document.getElementById('tasks-flywheel');
    var trail = document.getElementById('tasks-trail');
    return {
      signing: document.getElementById('tasks-signing').textContent,
      signingAttr: document.getElementById('tasks-signing').getAttribute('data-signing'),
      groupRows: groups.querySelectorAll('.list-item').length,
      groupImages: groups.querySelectorAll('img').length,
      groupText: groups.innerText,
      boardRows: board.querySelectorAll('.list-item').length,
      boardText: board.innerText,
      boardRel: board.querySelectorAll('.rel-time[data-delta]').length,
      boardRelText: (board.querySelector('.rel-time[data-delta]') || {}).textContent,
      fwRows: fw.querySelectorAll('.list-item').length,
      fwText: fw.innerText,
      fwRowTexts: Array.from(fw.querySelectorAll('.list-item')).map(function(el){ return el.innerText; }),
      trailRows: trail.querySelectorAll('.list-item').length,
      trailText: trail.innerText,
      relNodes: document.querySelectorAll('#page-tasks .rel-time').length,
      pageText: txt
    };
  })()`);
  const v = rendered.value || {};
  check('签名状态行显示「可签名」+ data-signing=yes', String(v.signingAttr) === 'yes' && /可做设备签名/.test(String(v.signing)), v.signing);
  check('群列表真渲染出 1 行', v.groupRows === 1, v.groupRows);
  check('恶意群名被当**文本**渲染 (没有真的 img 元素)', v.groupImages === 0 && String(v.groupText).includes('<img src=x onerror=alert(1)>'), v.groupText);
  check('公告板真渲染出 1 行', v.boardRows >= 1, v.boardRows);
  check('相对时间节点存在且有文字 (data-delta)', v.boardRel >= 1 && String(v.boardRelText).length > 0, v.boardRelText);
  check('飞轮真渲染出 2 行 (含一个已结束的目标)', v.fwRows === 2, v.fwText);
  check('飞轮: 在等外部回复 + 下一步 + 卡住原因 (真 DOM 文本)', /下一步:/.test(String(v.fwText)) && /买家没回/.test(String(v.fwText)), v.fwText);
  const fwRows: string[] = Array.isArray(v.fwRowTexts) ? v.fwRowTexts : [];
  const endedRow = fwRows.find((r) => r.includes('上季度的渠道调研')) || '';
  const liveRow = fwRows.find((r) => r.includes('把手机端能力补齐')) || '';
  check('飞轮: 第 6 类「已结束」说成已结束 (不混进"正在执行")', /已结束/.test(endedRow) && !/正在执行/.test(endedRow), endedRow);
  check('飞轮: 已结束的目标不承诺"下次醒来"', endedRow.length > 0 && !/下次醒来/.test(endedRow), endedRow);
  check('飞轮: 还在跑的目标才写"下次醒来"', /下次醒来/.test(liveRow), liveRow);
  check('飞轮只读提示来自桌面 note', /toUserVisibleState/.test(String(v.fwText)), v.fwText);
  check('群痕迹真渲染出 2 行 + 隐私提示', v.trailRows === 2 && /有消息命中隐私红线/.test(String(v.trailText)), v.trailText);

  console.log('\n[3] 页面文本里不许出现任何原始标识符');
  const leaks: string[] = [];
  for (const [name, raw] of [['群 store id', RAW_GROUP_ID], ['公告号原文', RAW_ANN_ID], ['DID', RAW_DID]] as const) {
    if (String(v.pageText).includes(raw)) leaks.push(`${name} 出现在页面文本里`);
  }
  check('原始 id / DID 都没进 DOM 文本', leaks.length === 0, leaks);
  check('页面文本里出现的是缩短形式', String(v.pageText).includes('zdpuAqzRawGr…') && String(v.pageText).includes('ann-19d92abe…'), v.pageText?.slice(0, 200));
  check('飞轮里混进的内部字段 (lease) 没有进 DOM', !String(v.fwText).includes('lease'), v.fwText);

  console.log('\n[4] 双语 data-zh/data-en (真切换)');
  const lang = await evaluate(`(function(){
    var el = document.getElementById('tasks-refresh');
    var zh = { text: el.textContent, attrZh: el.getAttribute('data-zh'), attrEn: el.getAttribute('data-en') };
    window.__mobileLang.set('en');
    var en = { text: el.textContent, signing: document.getElementById('tasks-signing').textContent };
    var enRow = document.getElementById('tasks-board').innerText;
    window.__mobileLang.set('zh');
    var back = { text: el.textContent, board: document.getElementById('tasks-board').innerText };
    return { zh: zh, en: en, back: back, enRow: enRow };
  })()`);
  const L = lang.value || {};
  check('中文时按钮文字 = data-zh', L.zh?.text === L.zh?.attrZh && !!L.zh?.attrEn, L.zh);
  check('切 en 后按钮文字 = data-en (真的换了)', L.en?.text === L.zh?.attrEn && L.zh?.attrEn !== L.zh?.attrZh, L.en);
  check('切 en 后签名状态行也是英文', /can sign \(Ed25519\)/.test(String(L.en?.signing)), L.en?.signing);
  check('切回 zh 复原', L.back?.text === L.zh?.attrZh, L.back);

  console.log('\n[5] 高风险动作: 确认页 → 展示待发内容 → 签名发送');
  const confirmFlow = await evaluate(`(async function(){
    function tick(){ return new Promise(function(r){ setTimeout(r, 60); }); }
    document.querySelector('#tasks-board button[data-announce]').click(); await tick();
    var sheet = document.getElementById('task-confirm-sheet');
    var title = document.getElementById('task-confirm-title').textContent;
    var lines = document.getElementById('task-confirm-lines').innerText;
    var groupPicker = document.querySelectorAll('#task-confirm-group button').length;
    var previewBtnHidden = document.getElementById('task-confirm-preview').hidden;
    document.getElementById('task-confirm-preview').click(); await tick(); await tick();
    var content = document.getElementById('task-confirm-content');
    var contentText = content.textContent;
    var contentHidden = content.hidden;
    document.getElementById('task-confirm-yes').click(); await tick(); await tick();
    return {
      sheetHiddenWhenOpen: false, title: title, lines: lines, groupPicker: groupPicker,
      previewBtnHidden: previewBtnHidden, contentText: contentText, contentHidden: contentHidden,
      sheetHiddenAfter: sheet.hidden, executeReq: window.__probe.lastExecuteReq, hint: window.__probe.hint,
      alertTexts: window.__probe.alertTexts, calls: window.__probe.calls
    };
  })()`);
  const C = confirmFlow.value || {};
  check('点「发进群」→ 确认页出现', C.title === '把这期公告发进群', C.title);
  check('确认页列出这一期要发的字段 (群 + 公告号缩短形式)', /群: /.test(String(C.lines)) && /公告号: ann-19d92abe…/.test(String(C.lines)), C.lines);
  check('必须显式选群 (群选择器有 1 个按钮)', C.groupPicker === 1, C.groupPicker);
  check('点预览 → 真去问桌面要那一行', C.contentHidden === false && String(C.contentText).startsWith('[bolloon-task]'), C.contentText);
  check('确认并签名 → 真的调了 execute, 且带的是**完整**公告号引用', C.executeReq?.announcementId === RAW_ANN_ID, C.executeReq);
  check('确认后确认页关闭', C.sheetHiddenAfter === true, C.sheetHiddenAfter);
  check('结果如实回显 (有提示文字)', String(C.hint).length > 0 || (C.alertTexts || []).length > 0, C.hint);

  console.log('\n[6] 不能签名时: 一个请求都不发');
  const noSign = await evaluate(`(async function(){
    function tick(){ return new Promise(function(r){ setTimeout(r, 60); }); }
    window.__probe.canSign = false;
    window.__probe.calls.length = 0;
    window.__probe.alertTexts.length = 0;
    window.__mobileTasksUi.refresh(); await tick(); await tick();
    var signingAttr = document.getElementById('tasks-signing').getAttribute('data-signing');
    var signingText = document.getElementById('tasks-signing').textContent;
    document.getElementById('tasks-group-name').value = '偷袭群';
    document.getElementById('tasks-group-create').click(); await tick();
    var sheetHidden = document.getElementById('task-confirm-sheet').hidden;
    var calls = window.__probe.calls.slice();
    return { signingAttr: signingAttr, signingText: signingText, sheetHidden: sheetHidden, calls: calls, alerts: window.__probe.alertTexts };
  })()`);
  const N = noSign.value || {};
  check('签名状态行变 no (警示)', N.signingAttr === 'no' && /不支持签名/.test(String(N.signingText)), N.signingText);
  check('不能签名 → 不弹确认页', N.sheetHidden === true, N.sheetHidden);
  check('不能签名 → 没发任何 execute 请求', !(N.calls || []).includes('execute'), N.calls);
  check('不能签名 → 明确告知 (不是静默)', /Ed25519/.test(String((N.alerts || []).join(' '))), N.alerts);
  await evaluate(`window.__probe.canSign = true;`);

  console.log('\n[7] 减少动态效果 (prefers-reduced-motion)');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const rm = await evaluate(`(function(){
    var btn = document.querySelector('#page-tasks .sheet-choice') || document.querySelector('.sheet-choice');
    var st = getComputedStyle(btn);
    var m = window.matchMedia('(prefers-reduced-motion: reduce)');
    return { matches: m.matches, transition: st.transitionDuration, animation: st.animationDuration };
  })()`);
  const rmMs = parseFloat(String(rm.value?.transition || '0'));
  check('媒体查询真生效', rm.value?.matches === true, rm.value);
  check('过渡被压到 ~0 (不是 0.3s)', rmMs <= 0.01, rm.value?.transition);
  await send('Emulation.setEmulatedMedia', { features: [] });

  console.log('\n[8] 真实现链路: 未接桌面时如实说"够不着" (不假装成功)');
  const honest = await evaluate(`(async function(){
    function tick(){ return new Promise(function(r){ setTimeout(r, 60); }); }
    // 换回**真的** mobile-core.tasks (没有配桌面地址 → 应当如实报 desktop_offline)
    window.BolloonCore.tasks = window.__realTasks;
    var b = await window.BolloonCore.tasks.loadBoard();
    var g = await window.BolloonCore.tasks.listGroups();
    var f = await window.BolloonCore.tasks.loadFlywheel();
    return {
      board: { ok: b && b.ok, code: b && b.code, err: b && b.error },
      groups: { ok: g && g.ok, code: g && g.code },
      flywheel: { ok: f && f.ok, code: f && f.code }
    };
  })()`);
  const H = honest.value || {};
  check('真 transport: 看板/群/飞轮都如实报 desktop_offline (不假装成功)',
    H.board?.ok === false && H.groups?.ok === false && H.flywheel?.ok === false
    && H.board?.code === 'desktop_offline' && H.groups?.code === 'desktop_offline', H);

  console.log('\n[9] 页面无未捕获异常');
  check('整个过程没有未捕获 JS 异常', exceptions.length === 0, exceptions.slice(0, 3));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`页面: http://127.0.0.1:${PORT}/mobile.html (dist/web)`);
  try { ws.close(); } catch { /* noop */ }
  chrome.kill('SIGKILL');
  srv.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
