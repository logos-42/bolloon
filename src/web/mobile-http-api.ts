/**
 * mobile-http-api.ts — 手机端本地 HTTP API (2026-08-15)
 *
 * 手机是自治节点: 外部控制端 (桌面/真机验证脚本/局域网工具) 经 HTTP 触发
 * 手机端独立 AgentLoop 执行, 不需要经过电脑同意.
 *
 * 端点:
 *   GET  /health                      存活检查
 *   GET  /api/phone/status            Agent 状态 (did/mode/llm/capabilities)
 *   POST /api/phone/agent/run         { goal, requestId? } → 手机自治执行 → { ok, result, mode }
 *   POST /api/phone/agent/cancel      { reason? } → 取消当前任务
 *
 * 运行环境:
 *   - Capacitor WebView (浏览器): 无 node:http, 提供 handleHttpRequest (fetch 风格) 供原生 HTTP server 调用
 *   - Node (测试/真机验证脚本): startLocalHttpServer() 起真实 localhost server
 */
import core from './mobile-core.js';

export interface PhoneHttpResponse {
  status: number;
  body: any;
}

/** 处理一个 HTTP 请求 (返回 fetch 风格 Response 或对象) — 供 WebView 原生 HTTP server / Node server 共用 */
export async function handleHttpRequest(method: string, path: string, bodyStr?: string): Promise<PhoneHttpResponse> {
  if (method === 'GET' && (path === '/' || path === '/health')) {
    return { status: 200, body: { ok: true, service: 'bolloon-mobile', time: Date.now() } };
  }
  if (method === 'GET' && path === '/api/phone/status') {
    const st = await core.phone.status();
    return { status: 200, body: st };
  }
  if (method === 'POST' && path === '/api/phone/agent/run') {
    const req = JSON.parse(bodyStr || '{}');
    const result = await core.phone.run(String(req.goal || ''));
    return { status: 200, body: { requestId: req.requestId || '', ...result } };
  }
  if (method === 'POST' && path === '/api/phone/agent/cancel') {
    const req = JSON.parse(bodyStr || '{}');
    const r = await core.phone.cancel(String(req.reason || '本地取消'));
    return { status: 200, body: r };
  }
  return { status: 404, body: { error: `no route: ${method} ${path}` } };
}

/** Node 环境: 起真实 localhost HTTP server (真机验证/测试用). 浏览器环境自动降级为 null */
export async function startLocalHttpServer(port = 7788): Promise<{ close(): void; port: number } | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hasNode = typeof process !== 'undefined' && !!(process.versions?.node);
  if (!hasNode) {
    console.log('[mobile-http-api] 非 Node 环境, 不启动本地 HTTP server (走 handleHttpRequest 供原生层)');
    return null;
  }
  const http = await import('node:http');
  const server = http.createServer(async (req: any, res: any) => {
    const url = new URL(req.url || '/', 'http://localhost');
    let body = '';
    req.on('data', (c: any) => { body += c; });
    req.on('end', async () => {
      try {
        const r = await handleHttpRequest(req.method || 'GET', url.pathname, body);
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.body));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e?.message || e).slice(0, 100) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  console.log(`[mobile-http-api] 本地 HTTP API 已启动: http://127.0.0.1:${port}`);
  return {
    close() { server.close(); },
    port,
  };
}

export default { handleHttpRequest, startLocalHttpServer };