/**
 * verify-url-chain.ts — 「API URL 完整切换链路」真跑验收 (P4, 2026-09-26)
 *
 * 审的是 `src/llm/connection-probe.ts` 这个**独立探测原语**。真跑的含义: 本地起**真 HTTP
 * 服务器**扮演模型服务, 每一类失败都用真服务器 (或真环境条件) 造出来 —— 不是打桩。
 *
 * 覆盖:
 *   S1 四层优先级 (显式 > 配置 > 供应商默认 > 环境变量) —— 用"请求真的打到了哪一台服务器"证明
 *   S2 重复 /v1 合并 —— 用服务器**收到的请求路径**证明
 *   S3 七类失败逐类造出 (含"挂起不响应"的 timeout)
 *   S4 失败绝不静默退回旧/默认 (写错的显式 URL 不会掉到配置/默认那一层)
 *   S5 凭证只进请求头: 真 key 打真 401, 结果序列化里不许出现它
 *   S6 通过路径 + 工具能力三态
 *   S7 源码级门 (结构判据) —— 变异验证的落点
 *
 * 用法: npx tsx scripts/verify-url-chain.ts
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

const ROOT = process.cwd();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n[${t}]`); }

// ── 真 HTTP 假模型服务 ─────────────────────────────────────────

interface Stub {
  label: string;
  origin: string;
  port: number;
  paths: string[];
  hits: number;
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function startStub(label: string, handler: Handler, opts: { hang?: boolean } = {}): Promise<Stub> {
  const paths: string[] = [];
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      paths.push(req.url || '');
      if (opts.hang) return; // 挂起: 收下请求, 永不响应
      handler(req, res, Buffer.concat(chunks).toString('utf-8'));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    label, origin: `http://127.0.0.1:${port}`, port, paths,
    get hits() { return paths.length; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  } as Stub;
}

const json = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** 一台正常的 OpenAI 兼容服务 (可指定工具行为) */
function openaiHandler(opts: { models: string[]; key?: string; tools?: 'call' | 'plain' | 'reject' }): Handler {
  return (req, res, body) => {
    if (opts.key && String(req.headers.authorization || '') !== `Bearer ${opts.key}`) {
      return json(res, 401, { error: { message: 'invalid api key' } });
    }
    if (req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: opts.models.map((id) => ({ id, object: 'model' })) });
    }
    if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(body || '{}');
      const withTools = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (withTools && opts.tools === 'reject') return json(res, 400, { error: { message: 'tools is not supported by this model' } });
      const message = withTools && opts.tools === 'call'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe_tool', arguments: '{}' } }] }
        : { role: 'assistant', content: `pong:${payload.model}` };
      return json(res, 200, { id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: withTools && opts.tools === 'call' ? 'tool_calls' : 'stop' }] });
    }
    json(res, 404, { error: { message: `no route ${req.url}` } });
  };
}

const observed = new Set<string>();
/** 每一类失败的样本 (S3 造出来的) —— S4 用它统一断言"失败没有被当成成功/没有默认地址" */
const allFailures: Array<{ failureClass?: string; ok: boolean; baseUrl: string; baseUrlSource: string | null }> = [];
const keep = <T extends { ok: boolean; failureClass?: string; baseUrl: string; baseUrlSource: string | null }>(r: T): T => {
  if (!r.ok && r.failureClass) { observed.add(r.failureClass); allFailures.push(r); }
  return r;
};

async function main(): Promise<void> {
  const CP: typeof import('../src/llm/connection-probe.js') = await import('../src/llm/connection-probe.js');

  // 四台"位置不同"的服务: 用来证明请求真的落在赢的那一层
  const D_explicit = await startStub('explicit', openaiHandler({ models: ['from-explicit'] }));
  const A_configured = await startStub('configured', openaiHandler({ models: ['from-configured'] }));
  const B_providerDefault = await startStub('providerDefault', openaiHandler({ models: ['from-provider'] }));
  const C_env = await startStub('env', openaiHandler({ models: ['from-env'] }));

  const base = (s: Stub) => `${s.origin}/v1`;
  const probeAt = (extra: Record<string, unknown>) => CP.probe({
    providerId: 'openai', protocol: 'openai-compatible', model: 'm', apiKeyRef: 'none', timeoutMs: 3000, ...extra,
  });

  try {
    // ────────────────────────────────────────────────────────
    section('S1 四层优先级 — 用"请求真的打到哪一台"证明, 不看内存字段');
    const before = { D: D_explicit.hits, A: A_configured.hits, B: B_providerDefault.hits, C: C_env.hits };
    const r1 = await probeAt({ baseUrl: base(D_explicit), configuredBaseUrl: base(A_configured), providerDefaultUrl: base(B_providerDefault), envBaseUrlValue: base(C_env), model: 'from-explicit' });
    ok('四层都给 → 来源是 explicit', r1.baseUrlSource === 'explicit', String(r1.baseUrlSource));
    ok('真的只打到 explicit 那台', D_explicit.hits > 0 && A_configured.hits === before.A && B_providerDefault.hits === before.B && C_env.hits === before.C,
      `D+${D_explicit.hits - before.D} A+${A_configured.hits - before.A} B+${B_providerDefault.hits - before.B} C+${C_env.hits - before.C}`);
    ok('explicit 那台真的全过 (ok:true)', r1.ok === true, r1.message);

    const r2 = await probeAt({ configuredBaseUrl: base(A_configured), providerDefaultUrl: base(B_providerDefault), envBaseUrlValue: base(C_env), model: 'from-configured' });
    ok('去掉显式 → 来源是 configured', r2.baseUrlSource === 'configured', String(r2.baseUrlSource));
    ok('真的打到 configured 那台', A_configured.hits > before.A && r2.ok, `A hits=${A_configured.hits}`);

    const r3 = await probeAt({ providerDefaultUrl: base(B_providerDefault), envBaseUrlValue: base(C_env), model: 'from-provider' });
    ok('再去掉配置 → 来源是 provider', r3.baseUrlSource === 'provider', String(r3.baseUrlSource));
    ok('真的打到 provider 默认那台', B_providerDefault.hits > before.B && r3.ok, `B hits=${B_providerDefault.hits}`);

    const r4 = await probeAt({ envBaseUrlValue: base(C_env), model: 'from-env' });
    ok('只剩环境变量 → 来源是 env', r4.baseUrlSource === 'env', String(r4.baseUrlSource));
    ok('真的打到 env 那台', C_env.hits > before.C && r4.ok, `C hits=${C_env.hits}`);

    const r5 = await probeAt({});
    ok('四层全空 → invalid_url 且没有来源 (不编默认)', keep(r5).failureClass === 'invalid_url' && r5.baseUrlSource === null && r5.baseUrl === '',
      `${r5.failureClass} source=${r5.baseUrlSource} url='${r5.baseUrl}'`);

    const r6 = await probeAt({ baseUrl: '   ', configuredBaseUrl: base(A_configured), model: 'from-configured' });
    ok('显式给了纯空白 = 没给 → 轮到配置层', r6.baseUrlSource === 'configured' && r6.ok, String(r6.baseUrlSource));

    // ────────────────────────────────────────────────────────
    section('S2 重复 /v1 合并 — 用服务器收到的路径证明');
    const pathsBefore = D_explicit.paths.length;
    const r7 = await probeAt({ baseUrl: `${D_explicit.origin}/v1/v1/`, model: 'from-explicit' });
    const seenPaths = D_explicit.paths.slice(pathsBefore);
    ok('带重复 /v1 与尾斜杠仍通过', r7.ok === true, r7.message);
    ok('生效 URL 只剩单层 /v1', r7.baseUrl === `${D_explicit.origin}/v1`, r7.baseUrl);
    ok('服务器收到的路径是 /v1/models (不是 /v1/v1/models)', seenPaths.includes('/v1/models') && !seenPaths.some((p) => p.includes('/v1/v1')), seenPaths.join(' '));

    // ────────────────────────────────────────────────────────
    section('S3 七类失败逐类真造 (含挂起不响应的 timeout)');

    // ① invalid_url — 畸形串 (不发请求)
    const f1 = await probeAt({ baseUrl: 'not-a-url' });
    ok('invalid_url · 畸形 URL', keep(f1).failureClass === 'invalid_url', f1.message);

    // ① invalid_url — 真服务器: 所有路由 404, 服务根上也没有别的协议
    const nowhere = await startStub('nowhere', (_q, res) => json(res, 404, { error: { message: 'no route' } }));
    try {
      const f1b = await probeAt({ baseUrl: `${nowhere.origin}/v1` });
      ok('invalid_url · 真服务器上端点不存在', keep(f1b).failureClass === 'invalid_url', f1b.message);
    } finally { await nowhere.close(); }

    // ② auth_failed — 真服务器 401
    const authSrv = await startStub('auth', openaiHandler({ models: ['m'], key: 'the-right-key' }));
    try {
      const f2 = await probeAt({ baseUrl: base(authSrv), apiKeyRef: 'env:V', resolveSecret: async () => 'the-wrong-key' });
      ok('auth_failed · 真 401', keep(f2).failureClass === 'auth_failed', f2.message);
    } finally { await authSrv.close(); }

    // ③ provider_unreachable — ①端口没人听 ②真 5xx
    const doomed = await startStub('doomed', openaiHandler({ models: ['m'] }));
    const deadPort = doomed.port;
    await doomed.close();
    const f3 = await probeAt({ baseUrl: `http://127.0.0.1:${deadPort}/v1` });
    ok('provider_unreachable · 端口没人听 (真 ECONNREFUSED)', keep(f3).failureClass === 'provider_unreachable', f3.message);

    const fiveOh = await startStub('5xx', (_q, res) => json(res, 503, { error: { message: 'upstream down' } }));
    try {
      const f3b = await probeAt({ baseUrl: base(fiveOh) });
      ok('provider_unreachable · 真 5xx', keep(f3b).failureClass === 'provider_unreachable', f3b.message);
    } finally { await fiveOh.close(); }

    // ④ model_not_found — 真目录里没有这个名字
    const catSrv = await startStub('catalog', openaiHandler({ models: ['alpha-1', 'beta-2'] }));
    try {
      const f4 = await probeAt({ baseUrl: base(catSrv), model: 'ghost-9' });
      ok('model_not_found · 目录可达但没有这个名字', keep(f4).failureClass === 'model_not_found', f4.message);
      ok('model_not_found 的结果里带回真目录', Array.isArray(f4.catalog) && f4.catalog.length === 2, JSON.stringify(f4.catalog));
    } finally { await catSrv.close(); }

    // ⑤ protocol_mismatch — 真 ollama 形状的服务, 按 openai 兼容探
    const ollamaSrv = await startStub('ollama', (_q, res) => json(res, 200, { models: [{ name: 'llama3:8b', digest: 'deadbeef', size: 1234 }] }));
    try {
      const f5 = await probeAt({ baseUrl: `${ollamaSrv.origin}/v1`, model: 'llama3:8b' });
      ok('protocol_mismatch · 交叉判定认出对方是 ollama', keep(f5).failureClass === 'protocol_mismatch' && f5.message.includes('ollama'), f5.message);
    } finally { await ollamaSrv.close(); }

    // ⑥ tool_call_unsupported — 目录与模型调用都通, 一加工具就被拒
    const noTools = await startStub('no-tools', openaiHandler({ models: ['m'], tools: 'reject' }));
    try {
      const f6 = await probeAt({ baseUrl: base(noTools), model: 'm' });
      ok('tool_call_unsupported · 模型调用那关过了, 工具那关没过',
        keep(f6).failureClass === 'tool_call_unsupported'
        && f6.checks.find((c) => c.step === 'model')?.ok === true
        && f6.checks.find((c) => c.step === 'tool_call')?.ok === false,
        f6.message);
    } finally { await noTools.close(); }

    // ⑦ timeout — 真服务器收下请求但挂住不响应
    const hung = await startStub('hung', openaiHandler({ models: ['m'] }), { hang: true });
    try {
      const t0 = Date.now();
      const f7 = await CP.probe({ providerId: 'ollama', baseUrl: hung.origin, protocol: 'ollama', model: 'm', apiKeyRef: 'none', timeoutMs: 600 });
      const dt = Date.now() - t0;
      ok('timeout · 挂起不响应 (真服务器, 真 abort)', keep(f7).failureClass === 'timeout' && dt < 5000, `${f7.failureClass} in ${dt}ms — ${f7.message}`);
    } finally { await hung.close(); }

    ok('七类一个不少: 观测集合 == PROBE_FAILURE_CLASSES',
      [...observed].sort().join(',') === [...CP.PROBE_FAILURE_CLASSES].sort().join(','),
      `观测: ${[...observed].sort().join(',')}`);

    // ────────────────────────────────────────────────────────
    section('S4 失败绝不静默退回旧/默认');
    const goodSrv = await startStub('good', openaiHandler({ models: ['from-configured'] }));
    try {
      const hitsBefore = goodSrv.hits;
      const f8 = keep(await probeAt({ baseUrl: 'not-a-url', configuredBaseUrl: base(goodSrv), providerDefaultUrl: 'https://api.example-default.invalid/v1', model: 'from-configured' }));
      ok('显式写错时不掉到配置层 (类别 invalid_url)', f8.failureClass === 'invalid_url', f8.message);
      ok('来源记的就是显式那一层', f8.baseUrlSource === 'explicit', String(f8.baseUrlSource));
      ok('配置那台一次请求都没收到 (没有偷偷试)', goodSrv.hits === hitsBefore, `hits ${hitsBefore} → ${goodSrv.hits}`);

      const f9 = keep(await probeAt({ baseUrl: `${goodSrv.origin}/wrong-path/v1`, configuredBaseUrl: base(goodSrv), model: 'from-configured' }));
      ok('地址写错时也不掉到配置层', f9.failureClass === 'invalid_url' && f9.baseUrlSource === 'explicit', `${f9.failureClass} @ ${f9.baseUrl}`);

      const dump = JSON.stringify(allFailures);
      ok('所有失败结果里都没出现默认地址', !dump.includes('api.example-default.invalid') && !dump.includes('api.openai.com'), 'ok');
      ok('七类失败样本没有一个 ok:true', allFailures.length > 0 && allFailures.every((x) => x.ok === false), `样本 ${allFailures.length} 个`);
    } finally { await goodSrv.close(); }

    // ────────────────────────────────────────────────────────
    section('S5 凭证只进请求头');
    const SECRET = 'sk-urlchain-secret-4c1d9e';
    const keySrv = await startStub('key', openaiHandler({ models: ['m'], key: 'a-different-key' }));
    try {
      const f10 = await CP.probe({
        providerId: 'openai', baseUrl: base(keySrv), protocol: 'openai-compatible', model: 'm',
        apiKeyRef: 'env:URLCHAIN_PROBE_KEY', resolveSecret: async () => SECRET, timeoutMs: 3000,
      });
      ok('真 key 打真 401 → auth_failed', keep(f10).failureClass === 'auth_failed', f10.message);
      ok('结果序列化里没有 key 值', !JSON.stringify(f10).includes(SECRET), 'ok');
      ok('格式化输出里没有 key 值', !CP.formatProbeResult(f10).includes(SECRET), 'ok');
      ok('只记引用名', f10.authRef === 'env:URLCHAIN_PROBE_KEY', f10.authRef);
      ok('resultLeaksSecret() 自证不漏', CP.resultLeaksSecret(f10, SECRET) === false, 'ok');
    } finally { await keySrv.close(); }

    // ────────────────────────────────────────────────────────
    section('S6 通过路径与工具能力三态');
    const fullSrv = await startStub('full', openaiHandler({ models: ['stub-1'], tools: 'call' }));
    try {
      const p1 = await CP.probe({ providerId: 'openai', baseUrl: base(fullSrv), protocol: 'openai-compatible', model: 'stub-1', apiKeyRef: 'none', timeoutMs: 3000 });
      ok('三关全过 → ok:true (且没有 failureClass)', p1.ok === true && p1.failureClass === undefined, p1.message);
      ok('工具调用拿到真证据 → yes', p1.toolCalling === 'yes', p1.toolCalling);
    } finally { await fullSrv.close(); }

    const plainSrv = await startStub('plain', openaiHandler({ models: ['stub-2'], tools: 'plain' }));
    try {
      const p2 = await CP.probe({ providerId: 'openai', baseUrl: base(plainSrv), protocol: 'openai-compatible', model: 'stub-2', apiKeyRef: 'none', timeoutMs: 3000 });
      ok('接受工具声明但没触发工具调用 → unknown (不许编成 yes)', p2.ok === true && p2.toolCalling === 'unknown', `${p2.ok} / ${p2.toolCalling}`);

      const n0 = plainSrv.hits;
      const p3 = await CP.probe({ providerId: 'openai', baseUrl: base(plainSrv), protocol: 'openai-compatible', model: 'stub-2', apiKeyRef: 'none', timeoutMs: 3000, checkToolCalling: false });
      ok('checkToolCalling:false → ok:true 但没发工具请求 (只 2 个请求)', p3.ok === true && p3.toolCalling === 'unknown' && plainSrv.hits - n0 === 2,
        `+${plainSrv.hits - n0} 请求, ${p3.toolCalling}`);
    } finally { await plainSrv.close(); }

    // ────────────────────────────────────────────────────────
    section('S7 源码级门 (变异验证的落点)');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'llm', 'connection-probe.ts'), 'utf-8');
    for (const cls of CP.PROBE_FAILURE_CLASSES) {
      ok(`源码里逐字有失败类别 '${cls}'`, new RegExp(`['"]${cls}['"]`).test(src));
    }
    ok('失败类别恰好 7 个', CP.PROBE_FAILURE_CLASSES.length === 7, String(CP.PROBE_FAILURE_CLASSES.length));
    ok('源码里没有写死的默认兜底地址', !/api\.openai\.com|localhost:11434|http:\/\/localhost/.test(src), 'ok');
    const touched = ['src/llm/connection-probe.ts', 'src/test/connection-probe.test.ts', 'scripts/verify-url-chain.ts'];
    // 用 \u0068 转义: 判据自身的源码里不能出现那个词, 否则它会把自己判红
    const forbidden = /\u0068ermes/i;
    ok('新增产物里没有外部 Agent 平台的表述', touched.every((f) => !forbidden.test(fs.readFileSync(path.join(ROOT, f), 'utf-8'))), touched.join(' '));
  } finally {
    await D_explicit.close();
    await A_configured.close();
    await B_providerDefault.close();
    await C_env.close();
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`verify-url-chain: ${passed} passed / ${failed} failed`);
  if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
