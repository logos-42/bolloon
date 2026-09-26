/**
 * model-stub-server.ts — 模型端点**假上游** (验收用, 2026-09-26)
 *
 * 为什么需要它: 模型选择的验收要真跑四种动作 —— 连通探测 (P4)、模型发现 (P5)、
 * 切换入口 (P6)、长任务恢复装配。这些动作都要打**模型端点**。打真上游的话:
 *   · 要真凭据 (不能进仓/进报告);
 *   · 网络抖动会让门时红时绿 (假红)。
 * 所以在 127.0.0.1 上起一个说 OpenAI 兼容协议的假上游 —— 路由是真的, 协议是真的,
 * 只有"对面是谁"是假的。**它不做任何鉴权判断**(不是安全边界), 只记录"谁来过、要了什么",
 * 好让门能验证"这一步真的打到了上游"而不是空转。
 *
 * 记录里**只留方法与路径**, 不留请求头/正文 —— 免得凭据经由这个口子进日志。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  at: number;
  method: string;
  path: string;
  /** 正文里声明的模型名 (取不到就是空) */
  model: string;
  /** 请求里带没带工具声明 (探测第 ⑥ 步会问) */
  hasTools: boolean;
}

export interface StubServer {
  port: number;
  baseUrl: string;
  /** 到目前为止收到过的请求 (按时间顺序) */
  requests: StubRequest[];
  /** 目录端点被命中几次 (发现/探测都打它) */
  catalogHits(): number;
  reset(): void;
  close(): Promise<void>;
}

export interface StubOptions {
  /** 目录端点返回的模型 id (默认两个, 用来证明"切换/发现真的在看上游清单") */
  models?: string[];
  /** `true` = 工具声明请求回一句带 tool_calls 的响应 (工具调用能力=已证支持) */
  toolCalling?: boolean;
  /** 端口 (0 = 让系统挑) */
  port?: number;
}

export async function startModelStub(opts: StubOptions = {}): Promise<StubServer> {
  const models = (opts.models && opts.models.length ? opts.models : ['stub-model-a', 'stub-model-b']).slice();
  const toolCalling = opts.toolCalling !== false;
  const requests: StubRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: any = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
      requests.push({
        at: Date.now(),
        method: String(req.method || 'GET'),
        path: url.pathname,
        model: String(parsed?.model || ''),
        hasTools,
      });
      res.setHeader('content-type', 'application/json');
      // 目录端点 (OpenAI 兼容: /models; 有的客户端会把 /v1 归一后直接打 /models)
      if (url.pathname === '/models' || url.pathname.endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'stub' })) }));
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        if (hasTools && toolCalling) {
          res.end(JSON.stringify({
            id: 'stub', object: 'chat.completion', model: parsed?.model || 'stub',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
              },
            }],
          }));
          return;
        }
        res.end(JSON.stringify({
          id: 'stub', object: 'chat.completion', model: parsed?.model || 'stub',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        }));
        return;
      }
      // 认不出的路径: 明确 404 (别假装成功 —— 那样门会把"打错地方"当成"通")
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `stub 不认这个路径: ${url.pathname}` } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    catalogHits: () => requests.filter((r) => r.path.endsWith('/models')).length,
    reset: () => { requests.length = 0; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
