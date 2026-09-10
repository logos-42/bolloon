// CDP 探针 (verbose): 自己从 /json 取目标, 读取 Android WebView 真实渲染状态
const WebSocket = require('ws');
const http = require('http');

const getJson = () => new Promise((res, rej) => {
  http.get('http://127.0.0.1:9222/json', (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

(async () => {
  const targets = await getJson();
  const page = targets.find((t) => t.type === 'page');
  console.log('target:', page.url, '| title:', page.title);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const v = r && r.result && r.result.result;
    if (!v) return r && r.error ? JSON.stringify(r.error) : undefined;
    if (v.subtype === 'error') return 'ERR: ' + v.description;
    return v.value;
  };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  ws.on('error', (e) => { console.error('WS ERROR:', e.message); process.exit(1); });
  ws.on('open', async () => {
    console.log('ws open');
    try {
      await send('Runtime.enable');
      const out = {};
      out.url = await evalJs('location.href');
      out.title = await evalJs('document.title');
      out.scripts = await evalJs("[...document.querySelectorAll('script')].map(s=>s.getAttribute('src')||'(inline)')");
      out.globals = await evalJs('[typeof window.BolloonCore, typeof window.Capacitor]');
      out.coreKeys = await evalJs('window.BolloonCore ? Object.keys(window.BolloonCore).slice(0,20) : null');
      out.netCore = await evalJs(
        "(()=>{const e=performance.getEntriesByType('resource').find(r=>r.name.includes('mobile-core'));return e?{name:e.name,transfer:e.transferSize,decoded:e.decodedBodySize}:null})()"
      );
      out.bodyText = await evalJs('document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(0,700)');
      out.tabbar = await evalJs("[...document.querySelectorAll('.tabbar *, nav *')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,12)");
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('EVAL FAIL', e.message);
    }
    ws.close();
    process.exit(0);
  });
  setTimeout(() => { console.error('TIMEOUT (no open in 25s)'); process.exit(1); }, 25000);
})();
