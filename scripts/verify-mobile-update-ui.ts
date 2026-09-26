/**
 * verify-mobile-update-ui.ts — 手机端「App 更新」页 · 真 headless Chrome 验收 (2026-09-26, update-protocol §13)
 *
 * 为什么必须另有一个真浏览器的门: Node 里没有 DOM, 所以 `verify-mobile-update.ts` 的
 * "验证可启动"只能做到 static-only (结构 + 语法)。**"换了资源以后真能起来吗"这件事, grep 和静态检查
 * 都证明不了** —— 只有在真 WebView (真 Chrome) 里真加载一次才算验过。
 *
 * 做法 (与 scripts/verify-mobile-tasks-ui.ts 同款: 真 Chrome + 裸 CDP, 不依赖 playwright):
 *   · 一个 Node HTTP 服务同时当: ① 壳层页面服务 (dist/web) ② 商店 API (读/写 web 资源目录) ③ 静态资源
 *     ⇒ iframe 加载 `…/staging/mobile.html` 拿到的是**流水线真的写进去的字节**
 *   · 页面里注入一个 HTTP 版 `WebResourceStore` (走 `window.__bolloonWebStore`) —— 接口与真机 store 同一套
 *   · 受控两个源: 真打出来的 web 层 tar.gz + 真 sha1 的假 registry / 假 GitHub API (含"不可达"端口)
 *   · 真点按「设置 → App 更新」→ 检查 / 安装 / 回滚, 断言**真 DOM 上的文字**
 *
 * 退出码: 0 全过 / 1 有断言失败 / 2 环境不满足 (没 Chrome / 没 dist/web)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WEB = path.resolve('dist/web');
const PORT = 8911 + Math.floor(Math.random() * 200);
const CDP_PORT = 9433 + Math.floor(Math.random() * 300);
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-update-chrome-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-update-store-'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    const d = detail === undefined ? '' : ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`;
    console.log(`  ❌ ${name}${d}`);
  }
};

// ── 打包一个"真" web 层包 (内容就是真的 dist/web; 让它真能起来) ──────────────
function makeWebTgz(tag: string): { bytes: Buffer; sha1: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpkg-'));
  const dst = path.join(dir, 'package', 'dist', 'web');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(WEB, dst, { recursive: true });
  // 打上标记, 便于"装完内容真的变了"这类断言
  fs.appendFileSync(path.join(dst, 'mobile.css'), `\n/* ${tag} */\n`);
  const out = path.join(dir, `${tag}.tgz`);
  const r = spawnSync('tar', ['-czf', out, '-C', dir, 'package'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar 失败: ${r.stderr}`);
  const bytes = fs.readFileSync(out);
  return { bytes, sha1: createHash('sha1').update(bytes).digest('hex') };
}

/** 一个服务同时干三件事: 壳层页面 / store API / store 静态资源 / 受控两个源 */
function serveAll(pkg: { bytes: Buffer; sha1: string }, tag: string): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const u = String(req.url || '/');
    const p = decodeURIComponent(u.split('?')[0]);

    // ① 受控 npm registry: /reg/<pkg>
    if (p.startsWith('/reg/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        'dist-tags': { latest: '0.5.1' },
        versions: { '0.5.1': { version: '0.5.1', dist: { tarball: `http://127.0.0.1:${PORT}/pkg.tgz`, shasum: pkg.sha1 } } },
      }));
      return;
    }
    // ② 受控 GitHub API
    if (p === '/repos/logos-42/bolloon/commits/master') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: 'c'.repeat(40) }));
      return;
    }
    if (p === '/repos/logos-42/bolloon/releases' || p === '/repos/logos-42/bolloon/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(p === '/repos/logos-42/bolloon/tags' ? [{ name: 'v0.5.1', commit: { sha: 'c'.repeat(40) } }] : []));
      return;
    }
    // ③ 包字节
    if (p === '/pkg.tgz') { res.setHeader('content-type', 'application/octet-stream'); res.end(pkg.bytes); return; }
    // ④ store API (给页面里的 HTTP store 用)
    if (p.startsWith('/api/')) {
      const rel = decodeURIComponent(p.slice('/api/'.length));
      const abs = path.join(STORE, rel);
      if (!abs.startsWith(STORE)) { res.statusCode = 400; res.end('bad'); return; }
      const body: Buffer[] = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const data = Buffer.concat(body);
        try {
          if (req.method === 'PUT') {
            if (rel.endsWith('/__rename')) {
              const from = String(req.headers['x-from'] || '');
              const to = String(req.headers['x-to'] || '');
              fs.mkdirSync(path.dirname(path.join(STORE, to)), { recursive: true });
              fs.rmSync(path.join(STORE, to), { recursive: true, force: true });
              fs.renameSync(path.join(STORE, from), path.join(STORE, to));
            } else {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, data);
            }
            res.statusCode = 204; res.end(); return;
          }
          if (req.method === 'DELETE') { fs.rmSync(abs, { recursive: true, force: true }); res.statusCode = 204; res.end(); return; }
          // GET
          if (!fs.existsSync(abs)) { res.statusCode = 404; res.end(''); return; }
          const st = fs.statSync(abs);
          if (st.isDirectory()) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(fs.readdirSync(abs))); return; }
          res.setHeader('content-type', 'application/octet-stream'); res.end(fs.readFileSync(abs));
        } catch (e: any) { res.statusCode = 500; res.end(String(e?.message || e)); }
      });
      return;
    }
    // ⑤ store 静态资源 (iframe 真加载 staged 资源用)
    if (p.startsWith('/store/')) {
      const abs = path.join(STORE, decodeURIComponent(p.slice('/store/'.length)));
      if (!abs.startsWith(STORE) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
      res.setHeader('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      res.end(fs.readFileSync(abs));
      return;
    }
    // ⑥ 壳层页面 (dist/web)
    const rel = p === '/' ? '/mobile.html' : p;
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve({
    port: PORT, close: () => new Promise((r) => srv.close(() => r())),
  })));
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('本机没有 Chrome → 未验证 (退出码 2)'); process.exit(2); }
  if (!fs.existsSync(path.join(WEB, 'mobile.html'))) { console.error('dist/web/mobile.html 不存在 → 先 npm run build:web'); process.exit(2); }

  console.log('手机端「App 更新」页 — 真 Chrome 验收 (真 DOM + 真 iframe 启动探测)');
  const pkg = makeWebTgz('v051');
  const srv = await serveAll(pkg, 'v051');

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=430,932',
    `http://127.0.0.1:${PORT}/mobile.html`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let wsUrl = '';
  for (let i = 0; i < 80; i++) {
    try {
      const list: any = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const pg = list.find((t: any) => t.type === 'page' && String(t.url).includes('mobile.html'));
      if (pg?.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!wsUrl) { console.error('CDP 没连上'); srv.close(); chrome.kill('SIGKILL'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e: any) => rej(e); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const exceptions: string[] = [];
  const dialogs: string[] = [];
  const origLog = console.log;
  ws.onmessage = (ev: any) => {
    const m = JSON.parse(ev.data);
    // 页面里的 confirm()/alert() 在 CDP 里会**阻塞页面**直到有人处理 —— 不接这一步, 点「安装」就会卡死
    // (踩过: P6 卡在 confirm 上, 整个 harness 静默挂住)
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(String(m.params?.message || '').slice(0, 120));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Log.entryAdded') {
      const e = m.params?.entry || {};
      if (e.level === 'error' && !/status of 404/.test(String(e.text || ''))) exceptions.push('[log] ' + String(e.text || '').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 200));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') exceptions.push('[console] ' + String((m.params.args || []).map((a: any) => a.value || a.description || '').join(' ')).slice(0, 300));
  };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expr: string) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) { const d = String(ex.exception?.description || ex.text || '').slice(0, 300); origLog(`  [harness] evaluate 抛错: ${d.split('\n')[0]}`); return { error: d }; }
    return { value: r.result?.result?.value };
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mobile.html` });
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    const r = await evaluate('JSON.stringify({ href: location.href, rs: document.readyState })');
    try { const v = JSON.parse(String(r.value || '{}')); if (String(v.href).includes('mobile.html') && v.rs === 'complete') { loaded = true; break; } } catch { /* 换页中 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!loaded) { console.error('页面没加载到 mobile.html → 未验证'); srv.close(); chrome.kill('SIGKILL'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 2500));

  // ── 先过首启隐私同意门 (真用户路径): 不过这道门 initApp() 不会跑, 菜单绑定也就不存在 ──
  const consent = await evaluate(`(async function(){
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gate = document.querySelector('#privacy-gate');
    const shown = !!gate && !gate.hidden;
    const agree = document.querySelector('#privacy-agree');
    if (shown && agree) { agree.click(); await sleep(1200); }
    return { shown, agreed: !!agree, menuBound: !!document.querySelector('#item-settings'), updateUi: !!(window.__mobileUpdateUi && window.__mobileUpdateUi.open) };
  })()`);
  check('首启隐私同意门: 真弹过并按真路径同意', consent.value?.shown === true && consent.value?.agreed === true, consent.value);
  check('同意后菜单绑定生效 (#item-settings 有点击处理器)', consent.value?.menuBound === true, consent.value);
  check('暴露 __mobileUpdateUi 行为入口 (与 __mobileTasksUi 同约定)', consent.value?.updateUi === true, consent.value);

  // ── 注入 HTTP store + 受控源配置 ─────────────────────────────────────────
  const injected = await evaluate(`(function(){
    const API = 'http://127.0.0.1:${PORT}/api/';
    const STATIC = 'http://127.0.0.1:${PORT}/store/';
    const enc = (rel) => API + rel.split('/').map(encodeURIComponent).join('/');
    const get = async (rel, bin) => {
      const r = await fetch(enc(rel), { cache: 'no-store' });
      if (!r.ok) return null;
      return bin ? new Uint8Array(await r.arrayBuffer()) : await r.text();
    };
    const store = {
      kind: 'http',
      rootLabel: 'http(store)',
      baseUrl: () => STATIC.replace(/\\/$/, ''),
      list: async (rel) => { const r = await fetch(enc(rel) + '', { cache: 'no-store' }); return r.ok ? await r.json() : []; },
      readText: (rel) => get(rel, false),
      readBytes: (rel) => get(rel, true),
      async writeBytes(rel, data) { await fetch(enc(rel), { method: 'PUT', body: data }); },
      async remove(rel) { await fetch(enc(rel), { method: 'DELETE' }); },
      async exists(rel) { const r = await fetch(enc(rel), { method: 'HEAD', cache: 'no-store' }); return r.ok; },
      async rename(from, to) { await fetch(enc(from + '/__rename'), { method: 'PUT', headers: { 'x-from': from, 'x-to': to } }); },
    };
    window.__bolloonWebStore = store;
    window.__bolloonUpdateConfig = {
      BOLLOON_MOBILE_DEV_BUNDLE_URL: 'http://127.0.0.1:${PORT}/pkg-{sha}.tar.gz',
    };
    return { core: !!(window.BolloonCore && window.BolloonCore.update), hasStore: true };
  })()`);
  check('页面里注入 HTTP store + 配置通道成功', injected.value?.hasStore === true, injected.value);
  check('内核暴露 update 命名空间', injected.value?.core === true, injected.value);

  // ── P1. 词表 / 拒绝表 / 天花板 ────────────────────────────────────────────
  const voc = await evaluate(`(function(){
    const v = window.BolloonCore.update.vocabulary();
    return { n: v.statuses.length, refused: v.refused.length, ceiling: v.nativeCeiling, auto: v.agentContract.autoAllowedSteps.join('/'), human: v.agentContract.humanRequiredSteps.join('/') };
  })()`);
  check('词表: 17 个结论', voc.value?.n === 17, voc.value);
  check('词表: 拒绝表 13 条', voc.value?.refused === 13, voc.value);
  check('天花板写清 App Store / 未知来源', /App Store/.test(voc.value?.ceiling || '') && /未知来源/.test(voc.value?.ceiling || ''), voc.value?.ceiling);
  check('契约: 自动不含 switch, 人在环含 switch/reload/rollback', !/switch/.test(voc.value?.auto || '') && /switch/.test(voc.value?.human || ''), voc.value);

  // ── P2. 真 iframe 启动探测 (这次是真的: 有 DOM) ──────────────────────────
  const prep = await evaluate(`(async function(){
    const up = window.BolloonCore.update;
    const out = await up.prepare({ localIdentity: { version: '0.5.0' }, nativeWritable: true, registryBase: 'http://127.0.0.1:${PORT}/reg', apiBase: 'http://127.0.0.1:${PORT}' });
    return { ok: out.ok, stage: out.stage, status: out.status, to: out.to, mode: out.probe && out.probe.mode, probeOk: out.probe && out.probe.ok, detail: out.probe && out.probe.detail, files: out.fileCount };
  })()`);
  check('真 iframe 启动探测: 用的是真加载 (mode=iframe)', prep.value?.mode === 'iframe', prep.value);
  check('真 iframe 启动探测: staged 资源真起来了 (tabbar + BolloonCore)', prep.value?.probeOk === true, prep.value?.detail);
  check('prepare 停在 awaiting_human (智能体只到这一步)', prep.value?.stage === 'awaiting_human' && prep.value?.ok === true, prep.value);
  console.log(`     ↳ 探测细节: ${String(prep.value?.detail || '').slice(0, 150)}`);

  // ── P3. 真切换 + 切换后真启动 ───────────────────────────────────────────
  const applied = await evaluate(`(async function(){
    const up = window.BolloonCore.update;
    const out = await up.apply({ confirm: true, reuseStaging: true, localIdentity: { version: '0.5.0' }, nativeWritable: true, registryBase: 'http://127.0.0.1:${PORT}/reg', apiBase: 'http://127.0.0.1:${PORT}' });
    const st = await up.state();
    return { ok: out.ok, stage: out.stage, to: out.to, digest: out.digest, channel: st.installedChannel, from: st.installedFrom && st.installedFrom.source, back: st.switchableTo && st.switchableTo.channel, needle: st.needsReload };
  })()`);
  check('真切换成功 (原子替换)', applied.value?.ok === true, applied.value);
  check('状态落盘: 装的是 stable · 来源 npm registry · 能切回 dev', applied.value?.channel === 'stable' && /npm registry/.test(String(applied.value?.from || '')) && applied.value?.back === 'dev', applied.value);
  check('摘要落盘 (sha1:…)', /^sha1:/.test(String(applied.value?.digest || '')), applied.value?.digest);
  const bootAfter = await evaluate(`(async function(){
    // 直接加载"切换后 current 里那一份", 证明换上去的资源真能起来
    return await new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:absolute;left:-9999px;width:400px;height:700px';
      f.src = 'http://127.0.0.1:${PORT}/store/current/mobile.html';
      let done = false;
      const fin = (ok, how) => { if (!done) { done = true; f.remove(); resolve({ ok, how }); } };
      f.onload = () => setTimeout(() => {
        try {
          const w = f.contentWindow, d = f.contentDocument;
          fin(!!(d && d.readyState === 'complete' && d.querySelector('.tabbar') && w.BolloonCore), 'after-swap');
        } catch (e) { fin(false, String(e.message || e)); }
      }, 900);
      f.onerror = () => fin(false, 'load-error');
      document.body.appendChild(f);
      setTimeout(() => fin(false, 'timeout'), 9000);
    });
  })()`);
  check('切换后的 current 在真浏览器里能起来 (tabbar + BolloonCore)', bootAfter.value?.ok === true, bootAfter.value);

  // ── P4. UI: 「设置 → App 更新」页把源身份/能切回/天花板都显示出来 ─────────
  const ui = await evaluate(`(async function(){
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const item = document.querySelector('#item-settings');
    if (!item) return { err: '没有 #item-settings' };
    let clickErr = null;
    try { item.click(); } catch (e) { clickErr = String(e.message || e); }
    await sleep(500);
    const sp = document.querySelector('#settings-page');
    const row = document.querySelector('#settings-update');
    const diag = {
      clickErr,
      hasSettingsPage: !!sp,
      ids: sp ? Array.prototype.map.call(sp.querySelectorAll('.conv-item'), function (e) { return e.id; }) : null,
      bodyHas: document.body.innerHTML.indexOf('App 更新') >= 0,
    };
    const preview = document.querySelector('#update-preview');
    const previewText = preview ? preview.textContent : null;
    if (!row) return { err: '设置页里没有「App 更新」入口', previewText, diag };
    row.click();
    await sleep(700);
    const page = document.querySelector('#update-page');
    if (!page) return { err: '没打开更新页' };
    const idEl = page.querySelector('#update-identity');
    const ceiling = page.querySelector('#update-ceiling');
    // 真点一次检查
    page.querySelector('#update-check').click();
    await sleep(2500);
    const logText = page.querySelector('#update-log').textContent;
    return {
      previewText, idText: idEl.textContent, ceilingText: ceiling.textContent, logText,
      hasButtons: !!(page.querySelector('#update-apply') && page.querySelector('#update-rollback') && page.querySelector('#update-reload')),
      hasChannels: !!(page.querySelector('#update-ch-stable') && page.querySelector('#update-ch-dev')),
    };
  })()`);
  const u = ui.value || {};
  check('设置页有「App 更新」入口 + 预览行', !!u.previewText && /当前/.test(String(u.previewText)), u.previewText);
  check('更新页打开 (身份块 / 几个按钮 / 通道切换都在)', !!u.idText && u.hasButtons === true && u.hasChannels === true, u);
  check('身份块里能看到"当前装的"与"能切回"', /当前装的/.test(String(u.idText)) && /能切回/.test(String(u.idText)), String(u.idText).slice(0, 200));
  check('身份块里写清"哪一层"(web 资源层 · 四个能力)', /web 资源层/.test(String(u.idText)) && /入群/.test(String(u.idText)) && /授权签名/.test(String(u.idText)), '');
  check('页面上写清"会生效吗"(原生壳判据)', /会生效吗/.test(String(u.idText)), '');
  check('天花板在页面上可见 (App Store / 未知来源)', /App Store/.test(String(u.ceilingText)) && /未知来源/.test(String(u.ceilingText)), String(u.ceilingText).slice(0, 120));
  check('真点「检查」后日志里有真结论', /结论: (up_to_date|update_available)/.test(String(u.logText)), String(u.logText).slice(0, 160));

  // ── P5. 拒绝语义在 UI 上看得见 (源不可达) ────────────────────────────────
  const refusedUi = await evaluate(`(async function(){
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const up = window.BolloonCore.update;
    // 真不可达端口 (本机一个没人听的端口)
    const r = await up.report({ localIdentity: { version: '0.5.0' }, registryBase: 'http://127.0.0.1:59999', apiBase: 'http://127.0.0.1:${PORT}' });
    const conn = await up.check({ localIdentity: { version: '0.5.0' }, nativeWritable: true });
    return { status: r.result.status, text: r.lines.join('\\n'), refusedInTable: up.vocabulary().refused.includes(r.result.status), realCheck: conn.status };
  })()`);
  check('源不可达 → 结论是 offline 且属于拒绝表', refusedUi.value?.status === 'offline' && refusedUi.value?.refusedInTable === true, refusedUi.value?.status);
  check('报告里说清"不能判定为最新"(不假装已是最新)', /不能判定为最新/.test(String(refusedUi.value?.text)), String(refusedUi.value?.text).slice(0, 160));

  // ── P6. 安装按钮在没有可装目标时不动手 ───────────────────────────────────
  const applyGuard = await evaluate(`(async function(){
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = document.querySelector('#update-page');
    const before = await fetch('http://127.0.0.1:${PORT}/api/current/mobile.html', { cache: 'no-store' }).then((r) => r.text());
    // 通道切成 dev(缺包地址) → 检查 → 点安装
    await window.BolloonCore.update.setChannel('dev');
    page.querySelector('#update-check').click();
    await sleep(1800);
    page.querySelector('#update-apply').click();
    await sleep(1200);
    const after = await fetch('http://127.0.0.1:${PORT}/api/current/mobile.html', { cache: 'no-store' }).then((r) => r.text());
    const log = page.querySelector('#update-log').textContent;
    return { same: before === after && before.length > 0, log: log.slice(0, 300), channel: window.BolloonCore.update.channel() };
  })()`);
  check('切通道只改偏好 (dev)', applyGuard.value?.channel === 'dev', applyGuard.value);
  check('没有可装目标时点「安装」不动手 (current 逐字未变)', applyGuard.value?.same === true, applyGuard.value);
  console.log(`     ↳ 过程中真弹过 ${dialogs.length} 个确认框 (人在环的证据):`);
  for (const d of dialogs.slice(0, 3)) console.log(`        "${d.replace(/\n/g, ' / ')}"`);

  // ── P7. 无页面级异常 ────────────────────────────────────────────────────
  // 忽略: ① 夹具本来就没有的图标/清单 ② **故意打到死端口**触发的网络错误 ——
  //   那是"源不可达"这道题的**刺激源**, 不是产品缺陷 (结论正确与否由 P5 断言, 不靠这条噪声)
  const IGNORABLE_NOISE = /favicon|manifest|Failed to load resource|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/i;
  // ↑ 2026-09-25 主线接管修正: 原写法只把 "...404" 当噪声, 而本轮的刺激源是 **GitHub 限流 403**
  //   ("Failed to load resource: the server responded with a status of 403") —— 页面据此判
  //   `github_unavailable(rate_limited)` 并拒绝切换, 结论正确性由 P5 那几条断言管;
  //   把它算成"未捕获异常"= 把**刺激源**误判成**缺陷**(假红)。资源加载失败一律不计噪声;
  //   真正的未捕获 JS 异常不含 "Failed to load resource" 字样, 仍然会被这条抓到。
  const realErrors = exceptions.filter((e) => !IGNORABLE_NOISE.test(e));
  check('真 Chrome 里无未捕获异常', realErrors.length === 0, realErrors.slice(0, 3));

  ws.close(); chrome.kill('SIGKILL');
  await srv.close();
  // Chrome 被杀后可能还在写 profile → 清理失败不算失败 (踩过 ENOTEMPTY 把整轮验收带崩)
  await new Promise((r) => setTimeout(r, 600));
  for (const d of [PROFILE_DIR, STORE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 留着无妨 */ } }

  console.log(`\n真浏览器验收: ${passed} 通过 · ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness 崩了:', e); process.exit(1); });
