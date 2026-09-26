/**
 * connection-probe.test.ts — 探测原语的**聚焦门** (P4, 2026-09-26)
 *
 * 覆盖两半:
 *   A. 纯函数 (URL 解析/规范化/凭证引用/信封识别/状态码分类/网络错误分类)
 *   B. **每一类失败都用真本地 HTTP 服务器造出来** (含"挂起不响应"的超时), 不是打桩。
 *
 * 关键判据:
 *   · 7 类失败一个不少 —— 末尾一条断言全轮的观测集合恰好等于 `PROBE_FAILURE_CLASSES`。
 *   · 失败绝不静默退回默认: "给了但写错"的显式 URL **不会**掉到配置/默认那一层。
 *   · URL 规范化与入口 `normalizeBaseUrl()` **逐例一致** (原语接进入口时不产生"两处真相")。
 *   · 凭证值永不进返回值 (拿真 key 打真 401, 结果序列化里不许出现它)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { AddressInfo } from 'net';

let CP: typeof import('../llm/connection-probe.js');
let MS: typeof import('../llm/model-selection.js');

const TMP = path.join(os.tmpdir(), 'bolloon-conn-probe-' + Date.now());

/** 全轮观测到的失败类别 —— 末尾断言它恰好是那 7 个 */
const observedClasses = new Set<string>();

beforeAll(async () => {
  process.env.BOLLOON_HOME = TMP;
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  await fs.mkdir(TMP, { recursive: true });
  CP = await import('../llm/connection-probe.js');
  MS = await import('../llm/model-selection.js');
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ───────────────────────── 真 HTTP 假模型服务 ─────────────────────────

interface Stub {
  origin: string;
  port: number;
  paths: string[];       // 收到的请求路径 (按顺序)
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** 起一台真服务器。`hang:true` = 收下请求但**永不响应** (造 timeout 用) */
async function startStub(
  handler: Handler,
  opts: { hang?: boolean } = {},
): Promise<Stub> {
  const paths: string[] = [];
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      paths.push(req.url || '');
      if (opts.hang) return; // 挂起: 不 writeHead、不 end
      handler(req, res, Buffer.concat(chunks).toString('utf-8'));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    paths,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy(); // 挂起的连接必须先掐断, 否则 close 不返回
      server.close(() => r());
    }),
  };
}

const json = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const openaiCatalog = (ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

/** 一台"正常"的 OpenAI 兼容服务: 目录 + 模型调用 + 工具调用 */
function openaiServer(opts: { models: string[]; key?: string; toolsAnswer?: 'call' | 'plain' | 'reject' }): Handler {
  return (req, res, body) => {
    const auth = String(req.headers.authorization || '');
    if (opts.key && auth !== `Bearer ${opts.key}`) return json(res, 401, { error: { message: 'invalid api key' } });
    if (req.url === '/v1/models') return json(res, 200, openaiCatalog(opts.models));
    if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(body || '{}');
      const withTools = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (withTools && opts.toolsAnswer === 'reject') {
        return json(res, 400, { error: { message: 'tools is not supported by this model' } });
      }
      const message = withTools && opts.toolsAnswer === 'call'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe_tool', arguments: '{}' } }] }
        : { role: 'assistant', content: `pong:${payload.model}` };
      return json(res, 200, { id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: withTools && opts.toolsAnswer === 'call' ? 'tool_calls' : 'stop' }] });
    }
    json(res, 404, { error: { message: `no route ${req.url}` } });
  };
}

// ═════════════════════════ A. 纯函数 ═════════════════════════

describe('URL 规范化 (合并重复 /v1 · 消除隐藏 URL)', () => {
  it('去尾斜杠 / 折叠重复斜杠 (不碰协议后的 //)', () => {
    expect(CP.normalizeChainUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(CP.normalizeChainUrl('http://127.0.0.1:8080//v1')).toBe('http://127.0.0.1:8080/v1');
  });
  it('合并结尾重复的 /v1 — 否则拼出来是 /v1/v1/models', () => {
    expect(CP.normalizeChainUrl('https://api.example.com/v1/v1')).toBe('https://api.example.com/v1');
    expect(CP.normalizeChainUrl('https://api.example.com/v1/v1/v1/')).toBe('https://api.example.com/v1');
  });
  it('中间重复不合并 (那可能是服务端真实路径)', () => {
    expect(CP.normalizeChainUrl('https://x.example/gateway/v1')).toBe('https://x.example/gateway/v1');
  });
  it('空 → 空 (不编一个默认出来)', () => {
    expect(CP.normalizeChainUrl('   ')).toBe('');
  });
  it('与入口 normalizeBaseUrl 逐例一致 (原语接进入口时不许出现两处真相)', () => {
    const cases = [
      'http://127.0.0.1:8080/v1/',
      'http://127.0.0.1:8080//v1',
      'https://api.example.com/v1/v1',
      'https://api.example.com/v1/v1/v1/',
      'https://x.example/gateway/v1',
      'https://x.example/weird/path/v9/',
      '   ',
      '',
      'http://host:1234',
      'not-a-url',
      'https://api.x.com/openai/v1/v1/',
    ];
    for (const c of cases) {
      expect(CP.normalizeChainUrl(c), `case: ${JSON.stringify(c)}`).toBe(MS.normalizeBaseUrl(c));
    }
  });
});

describe('四层优先级 (显式 > 配置 > 供应商默认 > 环境变量)', () => {
  const env = { MY_BASE: 'http://env.example/v1' } as unknown as NodeJS.ProcessEnv;

  it('显式赢过其余三层', () => {
    const r = CP.resolveChainBaseUrl(
      { explicit: 'http://ex.example/v1', configured: 'http://cf.example/v1', providerDefault: 'http://pd.example/v1', envVar: 'MY_BASE' },
      env,
    );
    expect(r.source).toBe('explicit');
    expect(r.baseUrl).toBe('http://ex.example/v1');
  });
  it('配置赢过供应商默认与环境变量', () => {
    expect(CP.resolveChainBaseUrl({ configured: 'http://cf.example/v1', providerDefault: 'http://pd.example/v1', envVar: 'MY_BASE' }, env).source).toBe('configured');
  });
  it('供应商默认赢过环境变量', () => {
    expect(CP.resolveChainBaseUrl({ providerDefault: 'http://pd.example/v1', envVar: 'MY_BASE' }, env).source).toBe('provider');
  });
  it('前三层都缺时才用环境变量', () => {
    const r = CP.resolveChainBaseUrl({ envVar: 'MY_BASE' }, env);
    expect(r.source).toBe('env');
    expect(r.baseUrl).toBe('http://env.example/v1');
  });
  it('四层全空 → 没有来源, 不编默认', () => {
    const r = CP.resolveChainBaseUrl({}, env);
    expect(r.source).toBeNull();
    expect(r.baseUrl).toBe('');
  });
  it('"给了但是空白" = 没给 (才轮到下一层)', () => {
    expect(CP.resolveChainBaseUrl({ explicit: '   ', configured: 'http://cf.example/v1' }, env).source).toBe('configured');
  });
  it('规范化在选中那一层之后发生 (选中的原始串也留着)', () => {
    const r = CP.resolveChainBaseUrl({ explicit: 'http://h.example/v1/v1/' }, env);
    expect(r.baseUrl).toBe('http://h.example/v1');
    expect(r.raw).toBe('http://h.example/v1/v1/');
  });
});

describe('URL 形状校验 / 凭证引用拆解', () => {
  it('畸形与非 http 被形状校验拒', () => {
    expect(CP.validateChainUrlShape('not-a-url').ok).toBe(false);
    expect(CP.validateChainUrlShape('ftp://h.example/v1').ok).toBe(false);
    expect(CP.validateChainUrlShape('http://h.example/v1').ok).toBe(true);
  });
  it('凭证引用只拆名字', () => {
    expect(CP.parseAuthRef('env:DEEPSEEK_API_KEY')).toEqual({ kind: 'env', name: 'DEEPSEEK_API_KEY' });
    expect(CP.parseAuthRef('provider:deepseek')).toEqual({ kind: 'provider', name: 'deepseek' });
    expect(CP.parseAuthRef('none')).toEqual({ kind: 'none', name: '' });
    expect(CP.parseAuthRef(undefined)).toEqual({ kind: 'none', name: '' });
  });
});

describe('信封识别 / 状态码与网络错误分类 (纯函数)', () => {
  it('认出四种协议的目录形状', () => {
    expect(CP.envelopeProtocolOf({ object: 'list', data: [{ id: 'a', object: 'model' }] })).toBe('openai-compatible');
    expect(CP.envelopeProtocolOf({ data: [{ type: 'model', id: 'a' }], has_more: false })).toBe('anthropic');
    expect(CP.envelopeProtocolOf({ models: [{ name: 'models/gemini-1.5-pro' }] })).toBe('gemini');
    expect(CP.envelopeProtocolOf({ models: [{ name: 'llama3', digest: 'abc' }] })).toBe('ollama');
    expect(CP.envelopeProtocolOf({ hello: 'world' })).toBeNull();
    expect(CP.envelopeProtocolOf(null)).toBeNull();
  });
  it('状态码分类: 401/403 → auth_failed · 404 → invalid_url · 429/5xx → provider_unreachable', () => {
    const mk = (status: number) => ({ status } as unknown as Response);
    expect(CP.classifyStatus(mk(401), null, '/x', 'catalog')?.failureClass).toBe('auth_failed');
    expect(CP.classifyStatus(mk(403), null, '/x', 'catalog')?.failureClass).toBe('auth_failed');
    expect(CP.classifyStatus(mk(404), null, 'http://h/models', 'catalog')?.failureClass).toBe('invalid_url');
    expect(CP.classifyStatus(mk(429), null, '/x', 'catalog')?.failureClass).toBe('provider_unreachable');
    expect(CP.classifyStatus(mk(503), null, '/x', 'catalog')?.failureClass).toBe('provider_unreachable');
    expect(CP.classifyStatus(mk(200), null, '/x', 'catalog')).toBeNull();
  });
  it('工具调用步骤: 工具相关 4xx → tool_call_unsupported; 其它 4xx → protocol_mismatch', () => {
    const mk = (status: number) => ({ status } as unknown as Response);
    expect(CP.classifyStatus(mk(400), { error: { message: 'tools not supported' } }, '/x', 'tool')?.failureClass).toBe('tool_call_unsupported');
    expect(CP.classifyStatus(mk(400), { error: { message: 'bad parameter' } }, '/x', 'tool')?.failureClass).toBe('protocol_mismatch');
  });
  it('网络错误分类: 超时标记优先 · 主机名解析失败 → invalid_url · 拒绝连接 → provider_unreachable', () => {
    expect(CP.classifyNetworkError(new Error('boom'), { timedOut: true }, 123).failureClass).toBe('timeout');
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(CP.classifyNetworkError(abort, { timedOut: false }, 123).failureClass).toBe('timeout');
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(CP.classifyNetworkError(dns, { timedOut: false }, 123).failureClass).toBe('invalid_url');
    const refuse = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(CP.classifyNetworkError(refuse, { timedOut: false }, 123).failureClass).toBe('provider_unreachable');
  });
  it('工具调用证据识别 (四种协议各查各的字段)', () => {
    expect(CP.hasToolCallEvidence({ choices: [{ message: { tool_calls: [{ id: 'x' }] } }] })).toBe(true);
    expect(CP.hasToolCallEvidence({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })).toBe(false);
    expect(CP.hasToolCallEvidence({ content: [{ type: 'tool_use', name: 'probe_tool' }] })).toBe(true);
    expect(CP.hasToolCallEvidence({ candidates: [{ content: { parts: [{ functionCall: { name: 'x' } }] } }] })).toBe(true);
  });
  it('失败类别恰好 7 个, 且每个都有人话理由', () => {
    expect(CP.PROBE_FAILURE_CLASSES).toHaveLength(7);
    for (const c of CP.PROBE_FAILURE_CLASSES) expect(CP.PROBE_FAILURE_ZH[c]).toBeTruthy();
    expect([...CP.PROBE_FAILURE_CLASSES]).toEqual([
      'invalid_url', 'auth_failed', 'provider_unreachable', 'model_not_found',
      'protocol_mismatch', 'tool_call_unsupported', 'timeout',
    ]);
  });
});

// ═════════════════════════ B. 真 HTTP 服务器 ═════════════════════════

describe('真 HTTP 服务器: 七类失败逐类造出来', () => {
  it('invalid_url — ①畸形串 (不发任何请求) ②地址上没有本协议端点 ③主机名解析失败 (构造真 ENOTFOUND)', async () => {
    const bad = await CP.probe({ providerId: 'openai', baseUrl: 'not-a-url', protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none' });
    expect(bad.ok).toBe(false);
    expect(bad.failureClass).toBe('invalid_url');
    expect(bad.baseUrlSource).toBe('explicit');
    observedClasses.add(bad.failureClass!);

    // ② 真服务器: 所有路由都 404 (服务根上也没有别的协议的端点) ⇒ 地址不对
    const dead = await startStub((_q, res) => json(res, 404, { error: { message: 'no route' } }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${dead.origin}/v1`, protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('invalid_url');
      observedClasses.add(r.failureClass!);
    } finally { await dead.close(); }

    // ③ 主机名解析失败这条路在**本机**造不出真的: 本机 DNS 把不存在的名字也解析到 sinkhole
    //    (任意 .invalid 都回同一个保留网段地址), 于是真跑只会得到 `UND_ERR_SOCKET`。
    //    这里用**真 ENOTFOUND 形状的错误对象**把分类器那一格钉住 —— 是分类覆盖, 不是真 DNS。
    const enotfoundFetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const dns = await CP.probe({
      providerId: 'openai', baseUrl: 'http://no-such-host.invalid/v1', protocol: 'openai-compatible',
      model: 'm', apiKeyRef: 'none', timeoutMs: 3000, fetchImpl: enotfoundFetch,
    });
    expect(dns.ok).toBe(false);
    expect(dns.failureClass).toBe('invalid_url');
  });

  it('auth_failed — ①服务端 401 ②本地取不到凭证引用 (都不当成功)', async () => {
    const s = await startStub(openaiServer({ models: ['m'], key: 'right-key' }));
    try {
      const r = await CP.probe({
        providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'm',
        apiKeyRef: 'env:PROBE_TEST_KEY', resolveSecret: async () => 'wrong-key', timeoutMs: 3000,
      });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('auth_failed');
      observedClasses.add(r.failureClass!);
    } finally { await s.close(); }

    const noKey = await CP.probe({ providerId: 'deepseek', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-compatible', model: 'm', apiKeyRef: 'provider:deepseek', timeoutMs: 1000 });
    expect(noKey.ok).toBe(false);
    expect(noKey.failureClass).toBe('auth_failed'); // 本地解析不出 ⇒ 根本没发请求
    expect(noKey.checks.some((c) => c.step === 'credential' && !c.ok)).toBe(true);
  });

  it('provider_unreachable — ①端口上没人听 ②服务端 5xx', async () => {
    // ① 先拿一个端口再关掉它
    const tmp = await startStub((_q, res) => json(res, 200, {}));
    const deadPort = tmp.port;
    await tmp.close();
    const refused = await CP.probe({ providerId: 'openai', baseUrl: `http://127.0.0.1:${deadPort}/v1`, protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000 });
    expect(refused.ok).toBe(false);
    expect(refused.failureClass).toBe('provider_unreachable');
    observedClasses.add(refused.failureClass!);

    const boom = await startStub((_q, res) => json(res, 500, { error: { message: 'upstream exploded' } }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${boom.origin}/v1`, protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('provider_unreachable');
    } finally { await boom.close(); }
  });

  it('model_not_found — 目录可达但没有这个名字 (目录也带回来了)', async () => {
    const s = await startStub(openaiServer({ models: ['alpha-1', 'beta-2'] }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'ghost-9', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('model_not_found');
      expect(r.catalog).toEqual(['alpha-1', 'beta-2']);
      observedClasses.add(r.failureClass!);
    } finally { await s.close(); }
  });

  it('protocol_mismatch — ①服务其实是另一个协议 ②回了外协议形状 ③回的压根不是 JSON', async () => {
    // ① ollama 形状的服务, 却按 openai 兼容探
    const ollama = await startStub((_q, res) => json(res, 200, { models: [{ name: 'llama3:8b', digest: 'deadbeef', size: 1 }] }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${ollama.origin}/v1`, protocol: 'openai-compatible', model: 'llama3:8b', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('protocol_mismatch');
      expect(r.message).toContain('ollama');
      observedClasses.add(r.failureClass!);
    } finally { await ollama.close(); }

    // ② 在目录端点回 Gemini 形状
    const gem = await startStub((_q, res) => json(res, 200, { models: [{ name: 'models/gemini-1.5-pro' }] }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${gem.origin}/v1`, protocol: 'openai-compatible', model: 'gemini-1.5-pro', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('protocol_mismatch');
      expect(r.message).toContain('gemini');
    } finally { await gem.close(); }

    // ③ 回了一个网页
    const html = await startStub((_q, res) => json(res, 200, '<html><body>hello</body></html>', 'text/html'));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${html.origin}/v1`, protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('protocol_mismatch');
      expect(r.message).toContain('text/html');
    } finally { await html.close(); }
  });

  it('tool_call_unsupported — 目录与模型调用都通, 一加工具声明就被拒', async () => {
    const s = await startStub(openaiServer({ models: ['m'], toolsAnswer: 'reject' }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('tool_call_unsupported');
      // 模型调用那一关是过了的 —— 证明是"工具"而不是"模型"的问题
      expect(r.checks.find((c) => c.step === 'model')?.ok).toBe(true);
      expect(r.checks.find((c) => c.step === 'tool_call')?.ok).toBe(false);
      observedClasses.add(r.failureClass!);
    } finally { await s.close(); }
  });

  it('timeout — 服务收下请求但挂住不响应', async () => {
    const hung = await startStub((_q, res) => json(res, 200, {}), { hang: true });
    try {
      const t0 = Date.now();
      const r = await CP.probe({ providerId: 'ollama', baseUrl: hung.origin, protocol: 'ollama', model: 'm', apiKeyRef: 'none', timeoutMs: 600 });
      const dt = Date.now() - t0;
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('timeout');
      expect(dt).toBeLessThan(4000); // 真在超时点附近返回, 不是挂死
      expect(r.checks.find((c) => c.step === 'connect')?.detail).toContain('超时');
      observedClasses.add(r.failureClass!);
    } finally { await hung.close(); }
  });
});

describe('真 HTTP 服务器: 通过路径与三条硬规则', () => {
  it('全通过才 ok — 目录/模型/工具三关都过 → ok:true 且工具能力有真证据', async () => {
    const s = await startStub(openaiServer({ models: ['stub-1'], toolsAnswer: 'call' }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'stub-1', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(true);
      expect(r.failureClass).toBeUndefined();
      expect(r.toolCalling).toBe('yes');
      expect(r.catalog).toEqual(['stub-1']);
    } finally { await s.close(); }
  });

  it('端点接受工具声明但没触发工具调用 → ok:true 但工具能力记 unknown (不许编成 yes)', async () => {
    const s = await startStub(openaiServer({ models: ['stub-2'], toolsAnswer: 'plain' }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'stub-2', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(true);
      expect(r.toolCalling).toBe('unknown');
    } finally { await s.close(); }
  });

  it('重复 /v1 被合并 —— 请求真的落在单层 /v1 路径上', async () => {
    const s = await startStub(openaiServer({ models: ['stub-3'], toolsAnswer: 'plain' }));
    try {
      const r = await CP.probe({ providerId: 'openai', baseUrl: `${s.origin}/v1/v1/`, protocol: 'openai-compatible', model: 'stub-3', apiKeyRef: 'none', timeoutMs: 3000 });
      expect(r.ok).toBe(true);
      expect(r.baseUrl).toBe(`${s.origin}/v1`);
      expect(s.paths).toContain('/v1/models');
      expect(s.paths.some((p) => p.includes('/v1/v1'))).toBe(false);
    } finally { await s.close(); }
  });

  it('失败绝不静默退回默认 — 显式 URL 写错时不会掉到配置/供应商默认那一层', async () => {
    const s = await startStub(openaiServer({ models: ['stub-4'] }));
    try {
      const r = await CP.probe({
        providerId: 'openai',
        baseUrl: 'not-a-url',                                  // ← 显式给了但写错
        configuredBaseUrl: `${s.origin}/v1`,                    // ← 配置那一层是好的
        providerDefaultUrl: 'https://api.openai.com/v1',
        protocol: 'openai-compatible', model: 'stub-4', apiKeyRef: 'none', timeoutMs: 3000,
      });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('invalid_url');
      expect(r.baseUrlSource).toBe('explicit');               // 记的就是显式那一层
      expect(s.paths.length).toBe(0);                          // 一次请求都没发出去
    } finally { await s.close(); }
  });

  it('四层全空 → invalid_url, 不编默认地址', async () => {
    const r = await CP.probe({ providerId: 'openai', protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none' });
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('invalid_url');
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBeNull();
  });

  it('凭证值永不进返回值 (真 key 打真 401)', async () => {
    const SECRET = 'sk-probe-secret-9f3a2b';
    const s = await startStub(openaiServer({ models: ['m'], key: 'other-key' }));
    try {
      const r = await CP.probe({
        providerId: 'openai', baseUrl: `${s.origin}/v1`, protocol: 'openai-compatible', model: 'm',
        apiKeyRef: 'env:PROBE_TEST_KEY', resolveSecret: async () => SECRET, timeoutMs: 3000,
      });
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('auth_failed');
      expect(CP.resultLeaksSecret(r, SECRET)).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(r.authRef).toBe('env:PROBE_TEST_KEY'); // 只记引用名
      expect(CP.formatProbeResult(r)).not.toContain(SECRET);
    } finally { await s.close(); }
  });
});

describe('收口: 七类失败一个不少', () => {
  it('本轮真跑造出的类别集合 == PROBE_FAILURE_CLASSES', () => {
    expect([...observedClasses].sort()).toEqual([...CP.PROBE_FAILURE_CLASSES].sort());
  });
});
