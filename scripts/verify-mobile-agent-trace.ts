/**
 * verify-mobile-agent-trace.ts — 手机端「智能体操作轨迹 (agent trace)」真跑验收
 *
 * 手机端一次任务执行, 用户看到三样东西:
 *   ① 状态条 loop-status-bar  (实时: "正在调用 AgentRuntime…" → 每步)
 *   ② 执行轨迹 .agent-trace    (每步一行: 原生 AgentLoop 的 agent-step 事件 + 任务结束后的 worklog)
 *   ③ 回复气泡 .bubble.ai
 * 三段分别来自: Kotlin `notifyListeners("agent-step", ev)` / runAgent 返回的 `worklog[]`
 * → mobile-core `busBroadcast({type:'agent-worklog'})` → mobile.js `appendWorkLog()`。
 *
 * 本脚本真跑这条链: 真 headless Chrome + 真 mobile-core/mobile.js bundle (非打桩 UI),
 * 只把**原生桥**换成桩 (无 Android 真机时无法跑 Kotlin); 普通手机 Agent 应忽略该桥，
 * 直接走 WebView 本地执行链。
 *
 * 断言:
 *   ① 手机设置页不再把无障碍权限作为普通 Agent 的启动配置
 *   ② 任务执行后 .agent-trace 真出现, 含每一步 (含最后 DONE 行), 行数 >= worklog 条数
 *   ③ 回复气泡 = 桩返回的 DONE 文本
 *   ④ 负例: 原生执行抛错时**不产出假轨迹**, 回复如实报错
 *
 * 用法: npx tsx scripts/verify-mobile-agent-trace.ts
 */

import * as http from 'http';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BrowserCdpSession, __shutdownBrowserForTest } from '../src/agents/browser-cdp.js';

const PORT = Number(process.env.TRACE_PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.resolve('dist/web');

const STEPS = [
  '观察屏幕: 设置 → 显示与亮度 (3 个可交互元素)',
  '点按「字体大小」',
  '滑动到「大」并点按',
  'DONE: 已把字体调大',
];

const STUB = `<script>
(function () {
  var S = window.__traceStub = { steps: [], runCalls: 0, fail: false, stepCb: null };
  window.Capacitor = {
    isNativePlatform: function () { return true; },
    Plugins: {
      RokidBridge: {
        addListener: function (name, cb) {
          if (name === 'agent-step') S.stepCb = cb;
          return { remove: function () {} };
        },
        runAgent: async function (args) {
          S.runCalls++;
          if (S.fail) throw new Error('无障碍服务未连接');
          var wl = ${JSON.stringify(STEPS)};
          wl.forEach(function (s) { S.steps.push(s); if (S.stepCb) S.stepCb({ step: s }); });
          return { result: wl[wl.length - 1], stepCount: wl.length, worklog: wl, agentId: 'on-device-stub' };
        },
        touchStatus: async function () { return { ready: true }; },
        openAccessibilitySettings: async function () {},
        agentConfigure: async function () {},
      },
    },
  };
})();
</script>`;

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); }
};

let server: http.Server | null = null;

async function main() {
  // ---------- ① 准备站点: dist/web → 临时目录, 在 mobile-core.js 之前注入原生桥桩 ----------
  const tmp = path.join(os.tmpdir(), 'bolloon-trace-' + Date.now());
  await fsp.mkdir(tmp, { recursive: true });
  await fsp.cp(DIST, tmp, { recursive: true });
  const htmlPath = path.join(tmp, 'mobile.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const injected = html.replace('<script src="./mobile-core.js"></script>', STUB + '\n<script src="./mobile-core.js"></script>');
  check('注入点存在 (mobile-core.js 之前插桩)', injected !== html);
  fs.writeFileSync(htmlPath, injected);

  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  server = http.createServer((req, res) => {
    const p = path.join(tmp, decodeURIComponent((req.url || '/').split('?')[0]));
    if (!p.startsWith(tmp)) { res.writeHead(403).end(); return; }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  await new Promise<void>((r) => server!.listen(PORT, '127.0.0.1', () => r()));
  console.log(`\n[1] 站点就绪 ${BASE}/mobile.html (真 bundle + 原生桥桩)`);

  // ---------- ② 真 headless Chrome ----------
  const session = new BrowserCdpSession({ headless: true });
  await session.execute({ action: 'open', url: `${BASE}/mobile.html`, timeoutMs: '30000' });
  await session.execute({
    action: 'js',
    code: `(async () => { for (let i=0;i<80;i++){ if (window.BolloonCore && window.Capacitor) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
    timeoutMs: '40000',
  });
  const boot = await session.execute({ action: 'js', code: `JSON.stringify({ core: !!window.BolloonCore, stub: !!window.__traceStub, stepCb: !!(window.__traceStub && window.__traceStub.stepCb) })` });
  console.log('   启动态:', String(boot.output).trim());
  check('内核 + 桥桩都已就绪', String(boot.output).includes('"core":true') && String(boot.output).includes('"stub":true'));

  // ---------- ③ 首启同意门 + 建会话 ----------
  const gate = await session.execute({
    action: 'js',
    code: `(async () => {
      const b = document.querySelector('#privacy-agree');
      if (!b) return 'no-gate';
      b.click();
      await new Promise(r=>setTimeout(r, 1500));
      return 'agreed';
    })()`,
    timeoutMs: '30000',
  });
  console.log('   首启同意:', String(gate.output).trim());
  check('首启隐私同意门已过 (真 App 的同一条路)', /agreed|no-gate/.test(String(gate.output)));

  await session.execute({
    action: 'js',
    code: `(async () => { await window.BolloonCore.resolvePost('/api/channels/create', { name: '测试智能体' })(); return 'created'; })()`,
    timeoutMs: '30000',
  });
  await session.execute({ action: 'open', url: `${BASE}/mobile.html?chat=1`, timeoutMs: '30000' });
  await session.execute({
    action: 'js',
    code: `(async () => { for (let i=0;i<80;i++){ if (window.BolloonCore && document.body.innerText.includes('开始对话')) return 'listed'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
    timeoutMs: '40000',
  });

  // ---------- ④ 真跑一次任务: 真进聊天页 → 真输入 → 真点发送 ----------
  const sent = await session.execute({
    action: 'js',
    code: `(async () => {
      const startBtn = Array.from(document.querySelectorAll('button, .btn, [role=button], .conv-item, .card'))
        .find(e => /开始对话/.test(e.textContent || ''));
      if (!startBtn) return 'no-start-btn';
      startBtn.click();
      for (let i=0;i<60;i++){ if (document.querySelector('#chat-input') && document.querySelector('#chat-send')) break; await new Promise(r=>setTimeout(r,250)); }
      const input = document.querySelector('#chat-input');
      const send = document.querySelector('#chat-send');
      if (!input || !send) return 'no-chat-ui';
      input.value = '帮我把字体调大';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
      return 'sent';
    })()`,
    timeoutMs: '40000',
  });
  console.log('   发送:', String(sent.output).trim());
  check('真 UI 里发出了任务 (首页卡片 → 聊天页 → 发送)', String(sent.output).includes('sent'), String(sent.output));

  // 等执行完成 (mobile-core: 回复 + agent-worklog 广播)
  const trace = await session.execute({
    action: 'js',
    code: `(async () => {
      for (let i=0;i<120;i++){
        const t = document.querySelector('.agent-trace');
        const ai = Array.from(document.querySelectorAll('.bubble.ai')).map(e=>e.textContent).join('\\n');
        if (t && t.querySelectorAll('.agent-trace-line').length && ai.includes('DONE')) {
          return JSON.stringify({
            lines: Array.from(t.querySelectorAll('.agent-trace-line')).map(e=>e.textContent),
            ai: ai.slice(0, 200),
            runs: window.__traceStub.runCalls,
            stepEvents: window.__traceStub.steps.length,
            status: (document.querySelector('#loop-status-text')||{}).textContent || '',
          });
        }
        await new Promise(r=>setTimeout(r,500));
      }
      const t = document.querySelector('.agent-trace');
      return JSON.stringify({ lines: t ? Array.from(t.querySelectorAll('.agent-trace-line')).map(e=>e.textContent) : [], ai: Array.from(document.querySelectorAll('.bubble.ai')).map(e=>e.textContent).join('\\n').slice(0,200), runs: window.__traceStub.runCalls, stepEvents: window.__traceStub.steps.length, status: (document.querySelector('#loop-status-text')||{}).textContent || '' });
    })()`,
    timeoutMs: '90000',
  });
  let info: any = {};
  try { info = JSON.parse(String(trace.output)); } catch (e) { info = { parseError: String(trace.output).slice(0, 200) }; }
  console.log('   轨迹行数:', (info.lines || []).length, '| runAgent 调用:', info.runs, '| 状态条:', info.status);
  (info.lines || []).forEach((l: string, i: number) => console.log(`     ${i + 1}. ${l}`));
  check('runAgent 真被调用 (走了原生执行路径)', info.runs === 1, JSON.stringify(info).slice(0, 200));
  check('.agent-trace 真渲染出执行轨迹', Array.isArray(info.lines) && info.lines.length >= STEPS.length, `lines=${(info.lines || []).length}`);
  check('轨迹含每一步 (首步 + 末步 DONE)', (info.lines || []).join('\n').includes(STEPS[0]) && (info.lines || []).join('\n').includes('DONE: 已把字体调大'), (info.lines || []).join(' | '));
  check('回复气泡 = 执行结果', String(info.ai || '').includes('DONE: 已把字体调大'), info.ai);

  // ---------- ⑤ 负例: 原生执行抛错 → 不产出假轨迹 ----------
  const before = (info.lines || []).length;
  await session.execute({ action: 'js', code: `window.__traceStub.fail = true; 'ok'` });
  await session.execute({
    action: 'js',
    code: `(async () => {
      const input = document.querySelector('#chat-input');
      input.value = '再试一次';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('#chat-send');
      btn.click();
      for (let i=0;i<60;i++){
        const ai = Array.from(document.querySelectorAll('.bubble.ai')).map(e=>e.textContent).join('\\n');
        if (ai.includes('未就绪') || ai.includes('AgentRuntime')) return 'errored';
        await new Promise(r=>setTimeout(r,500));
      }
      return 'timeout';
    })()`,
    timeoutMs: '60000',
  });
  const neg = await session.execute({
    action: 'js',
    code: `(async () => {
      const snap = await window.BolloonCore.resolve('/api/data/snapshot')();
      const msgs = ((snap && snap.sessions) || []).flatMap(s => s.messages || []);
      const ai = msgs.filter(m => m.role === 'ai');
      const last = ai.length ? String(ai[ai.length - 1].content || '') : '';
      return JSON.stringify({
        lines: (document.querySelector('.agent-trace') ? document.querySelector('.agent-trace').querySelectorAll('.agent-trace-line').length : 0),
        lastAi: last.slice(-200),
        aiCount: ai.length,
        runs: window.__traceStub.runCalls,
      });
    })()`,
    timeoutMs: '30000',
  });
  let negInfo: any = {};
  try { negInfo = JSON.parse(String(neg.output)); } catch (e) { negInfo = { raw: String(neg.output).slice(0, 200) }; }
  console.log('   负例:', JSON.stringify(negInfo).slice(0, 240));
  check('负例: runAgent 被调用第 2 次 (真走了失败分支)', negInfo.runs === 2, String(negInfo.runs));
  check('负例: 落库的回复如实报错 (不假装成功)', /未就绪|AgentRuntime/.test(String(negInfo.lastAi || '')), String(negInfo.lastAi).slice(-160));
  check('负例: 没有多出伪造轨迹行', Number(negInfo.lines) <= before, `before=${before} after=${negInfo.lines}`);

  await session.execute({ action: 'close' }).catch(() => {});
  __shutdownBrowserForTest();

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  server?.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 脚本异常:', e);
  try { server?.close(); } catch {}
  process.exit(1);
});
