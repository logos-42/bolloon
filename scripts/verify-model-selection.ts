/**
 * verify-model-selection.ts — 「模型切换统一入口 + 有效模型配置」真跑验收 (2026-09-26)
 *
 * 对应验收条 (P8 里 P0/P1 能覆盖的那些):
 *   1  切 provider → 下一次请求真命中
 *   2  同 provider 切 model → 请求体里的 model 真变
 *   3  自定义 base URL 指向本地 HTTP server → 真命中该地址
 *   4  错 key / 错 URL / 错 model → 都不能切换成功 (且配置文件字节不变)
 *   5  CLI 与 Web 读到同一份配置
 *   6  重启 (新进程) 后仍生效
 *   7  Session 切换不改变 Global
 *   8  Global 切换影响新 Session
 *   9  长任务中途切默认模型 → 旧 Run 保留原快照
 *   10 下一 Run 用新模型
 *   12 两个进程同时切配置 → 不互相覆盖
 *   13 旧 llm-config.json 可迁移
 *   16 切换失败后旧模型仍可用
 *
 * 真跑的含义: 本地起**真 HTTP 服务器**扮演模型服务, 切换后调真 `getMinimax().chat()`,
 * 断言请求**真的打到**那台服务器、请求体里的 model **真的**是那一串 —— 不是查内存字段。
 *
 * 用法: npx tsx scripts/verify-model-selection.ts
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-verify-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_MODEL_SKIP_PROBE;

const ROOT = process.cwd();
const CHILD = path.join(ROOT, 'scripts', 'lib', 'model-selection-child.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(t: string): void { console.log(`\n[${t}]`); }

function sha(file: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return 'missing'; }
}

/** 读 JSON 文件, 缺文件/损坏时给 fallback —— 让"文件没被创建"表现成断言失败, 而不是把整轮验收炸掉 */
function readJsonOr(file: string, fallback: any): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

// ── 本地假模型服务 ─────────────────────────────────────────────

interface Hit { url: string; model: string; auth: string }
interface Stub {
  port: number;
  label: string;
  hits: Hit[];
  basePath: string;
  close: () => Promise<void>;
}

function startStub(opts: { label: string; basePath?: string; expectKey?: string | null; models: string[] }): Promise<Stub> {
  const basePath = opts.basePath ?? '/v1';
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      const auth = String(req.headers.authorization || req.headers['x-api-key'] || '');
      if (url === `${basePath}/models` && req.method === 'GET') {
        if (opts.expectKey && auth !== `Bearer ${opts.expectKey}` && auth !== opts.expectKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: opts.models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (url === `${basePath}/chat/completions` && req.method === 'POST') {
        if (opts.expectKey && auth !== `Bearer ${opts.expectKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        let model = '';
        try { model = JSON.parse(Buffer.concat(chunks).toString('utf-8')).model; } catch { /* 记录空串 */ }
        hits.push({ url, model, auth: auth ? auth.slice(0, 12) : '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: `pong:${model}` }, finish_reason: 'stop' }],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        port, label: opts.label, hits, basePath,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 与真实 CLI 同一条路: 调子进程读有效配置 */
function childEffective(): any {
  const r = spawnSync('npx', ['tsx', CHILD, HOME, 'effective'], {
    cwd: ROOT, encoding: 'utf-8', env: { ...process.env, BOLLOON_HOME: HOME, HOME, USERPROFILE: HOME },
    timeout: 120_000,
  });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
  if (!line) throw new Error(`子进程没输出 (exit=${r.status}): ${String(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice('CHILD:'.length));
}

async function main(): Promise<void> {
  const MS: any = await import('../src/llm/model-selection.js');
  const SW: any = await import('../src/cli/setup-wizard.js');
  const { getMinimax } = await import('../src/constraints/index.js');
  const runStore: any = await import('../src/agents/run-store.js');
  const express = (await import('express')).default as any;

  const modelCfgPath = path.join(HOME, 'bolloon-config.json');
  const legacyPath = path.join(HOME, 'llm-config.json');
  const sessionsPath = path.join(HOME, 'model-sessions.json');

  // 两台"模型服务": A 走默认 /v1, B 走自定义 /alt/v1
  const A = await startStub({ label: 'A', basePath: '/v1', expectKey: 'k-stub-a', models: ['stubA-1', 'stubA-2'] });
  const B = await startStub({ label: 'B', basePath: '/alt/v1', expectKey: 'k-stub-b', models: ['stubB-1'] });

  const callOnce = async (label: string): Promise<string> => {
    try {
      const r = await getMinimax().chat(`ping-${label}`);
      return String(r.reply || '');
    } catch (e: any) { return `ERR:${String(e?.message || e).slice(0, 120)}`; }
  };

  try {
    // ────────────────────────────────────────────────────────
    section('1 切 provider → 下一次请求真命中');
    const sA = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    ok('切到 A 成功', sA.ok, sA.message || MS.formatEffectiveModel(sA.effective));
    const hitsA0 = A.hits.length, hitsB0 = B.hits.length;
    const replyA = await callOnce('a');
    ok('请求真的打到 A', A.hits.length === hitsA0 + 1 && B.hits.length === hitsB0, `A+${A.hits.length - hitsA0} B+${B.hits.length - hitsB0}, reply=${replyA}`);
    ok('A 收到的 model = stubA-1', A.hits[A.hits.length - 1]?.model === 'stubA-1', A.hits[A.hits.length - 1]?.model);

    const sB = await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });
    ok('切到 B 成功', sB.ok, sB.message || MS.formatEffectiveModel(sB.effective));
    const hitsA1 = A.hits.length, hitsB1 = B.hits.length;
    const replyB = await callOnce('b');
    ok('下一次请求打到 B (不再打 A)', B.hits.length === hitsB1 + 1 && A.hits.length === hitsA1, `A+${A.hits.length - hitsA1} B+${B.hits.length - hitsB1}, reply=${replyB}`);

    // ────────────────────────────────────────────────────────
    section('2 同 provider 只切 model → 请求体里的 model 真变');
    const sw = await MS.selectModel({ provider: 'deepseek', model: 'stubB-2', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global', verify: false });
    // B 的目录里没有 stubB-2 → 关掉探测只是为了到达"写配置"这一步; 真实调用仍要真发出去
    ok('同 provider 换 model 写入成功', sw.ok, sw.message || '');
    const before2 = B.hits.length;
    await callOnce('b2');
    ok('请求体里的 model 真的变了', B.hits[B.hits.length - 1]?.model === 'stubB-2', `model=${B.hits[B.hits.length - 1]?.model}`);
    ok('第一次请求也真发出去了', B.hits.length === before2 + 1);

    // ────────────────────────────────────────────────────────
    section('3 自定义 base URL → 请求命中该地址');
    const lastHit = B.hits[B.hits.length - 1];
    ok('命中的 URL 是自定义路径 /alt/v1/chat/completions', lastHit?.url === '/alt/v1/chat/completions', lastHit?.url);
    // 换第三个路径, 证明不是"恰好"命中
    const C = await startStub({ label: 'C', basePath: '/weird/path/v9', expectKey: null, models: ['stubC-1'] });
    const sC = await MS.selectModel({ provider: 'kimi', model: 'stubC-1', baseUrl: `http://127.0.0.1:${C.port}/weird/path/v9/`, apiKey: 'k-stub-c', scope: 'global' });
    ok('带尾斜杠的 URL 被规范化后切换成功', sC.ok, `${sC.effective?.baseUrl} (${sC.message || ''})`);
    ok('尾斜杠被去掉 (没有 /v9//chat)', sC.effective?.baseUrl === `http://127.0.0.1:${C.port}/weird/path/v9`, sC.effective?.baseUrl);
    await callOnce('c');
    ok('请求真打到第三台 (新路径)', C.hits[C.hits.length - 1]?.url === '/weird/path/v9/chat/completions', C.hits[C.hits.length - 1]?.url);
    await C.close();

    // 回到 B, 后续用例以 B 为"旧配置"
    await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });
    const goodEff = await MS.effectiveModelConfig({});

    // ────────────────────────────────────────────────────────
    section('4 错 key / 错 URL / 错 model → 都不能切换成功 (配置字节不变)');
    const beforeBad = sha(modelCfgPath);

    const badKey = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'totally-wrong', scope: 'global' });
    ok('错 key 被拒 (auth_failed)', !badKey.ok && badKey.failureClass === 'auth_failed', `${badKey.failureClass}: ${String(badKey.message || '').slice(0, 90)}`);

    const badModel = await MS.selectModel({ provider: 'openai', model: 'no-such-model-xyz', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    ok('错 model 被拒 (model_not_found)', !badModel.ok && badModel.failureClass === 'model_not_found', `${badModel.failureClass}: ${String(badModel.message || '').slice(0, 90)}`);

    const deadPort = 9; // 几乎不可能有人在听
    const badUrl = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    ok('不可达 URL 被拒 (provider_unreachable)', !badUrl.ok && (badUrl.failureClass === 'provider_unreachable' || badUrl.failureClass === 'timeout'), `${badUrl.failureClass}`);

    const malformed = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: 'not-a-url', apiKey: 'k-stub-a', scope: 'global' });
    ok('畸形 URL 被拒 (invalid_url)', !malformed.ok && malformed.failureClass === 'invalid_url', `${malformed.failureClass}`);

    ok('四次失败后配置文件字节未变', sha(modelCfgPath) === beforeBad, `${beforeBad} → ${sha(modelCfgPath)}`);
    const stillEff = await MS.effectiveModelConfig({});
    ok('四次失败后有效配置仍是 B/stubB-1', stillEff.provider === 'deepseek' && stillEff.model === 'stubB-1', MS.formatEffectiveModel(stillEff));

    // ────────────────────────────────────────────────────────
    section('16 切换失败后旧模型仍可用');
    const hitsB16 = B.hits.length;
    const reply16 = await callOnce('after-fail');
    ok('旧模型仍能真跑', B.hits.length === hitsB16 + 1 && reply16.startsWith('pong:stubB-1'), `reply=${reply16}`);

    // ────────────────────────────────────────────────────────
    section('7 Session 切换不改变 Global');
    // 先定住全局默认 (deepseek @ B), 会话级切换要换到另一家才有判别性
    await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });
    const cfgBefore7 = fs.readFileSync(modelCfgPath, 'utf-8');
    process.env.BOLLOON_SESSION_KEY = 'sess-7';
    const sessSel = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, scope: 'session' });
    ok('会话级切换成功 (不需要重复给 key)', sessSel.ok, sessSel.message || '');
    ok('会话级生效的作用域是 session', sessSel.effective?.source === 'session', sessSel.effective?.source);
    ok('Global 配置文件字节未变', fs.readFileSync(modelCfgPath, 'utf-8') === cfgBefore7);
    const bind = readJsonOr(sessionsPath, { sessions: {} });
    ok('会话绑定落在 model-sessions.json', bind.sessions['sess-7']?.model === 'stubA-1', JSON.stringify(bind.sessions['sess-7'] || {}));
    ok('会话级绑定文件里没有 key 明文', !JSON.stringify(bind).includes('k-stub'), 'ok');
    process.env.BOLLOON_SESSION_KEY = 'sess-7-other';
    const otherSess = await MS.effectiveModelConfig({});
    ok('别的会话不受影响 (仍是全局 deepseek)', otherSess.provider === 'deepseek' && otherSess.source === 'global', MS.formatEffectiveModel(otherSess));
    process.env.BOLLOON_SESSION_KEY = 'sess-7';
    const conflict = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-new-secret', scope: 'session' });
    ok('会话级带凭证被拒 (凭证只属于全局)', !conflict.ok && conflict.failureClass === 'credential_scope_conflict', conflict.failureClass || '');

    // ────────────────────────────────────────────────────────
    section('8 Global 切换影响新 Session');
    process.env.BOLLOON_SESSION_KEY = 'sess-8-brand-new';
    const globalSel = await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    ok('Global 切换成功', globalSel.ok, globalSel.message || '');
    process.env.BOLLOON_SESSION_KEY = 'sess-8-second';
    const newSess = await MS.effectiveModelConfig({});
    ok('全新会话读到新的全局默认', newSess.provider === 'openai' && newSess.model === 'stubA-2' && newSess.source === 'global', MS.formatEffectiveModel(newSess));
    // 回到 B 作为后续"旧配置"
    await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });

    // ────────────────────────────────────────────────────────
    section('9/10 长任务中途切默认模型 → 旧 Run 留原快照 · 新 Run 用新模型');
    const snap1 = await MS.captureRunModelConfig();
    const run1 = await runStore.startRun({ surface: 'cli', goal: '长任务 (切模型前)', modelConfig: snap1 });
    const midSwitch = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    ok('执行中切全局默认成功', midSwitch.ok, midSwitch.message || '');
    const run1Back = await runStore.readRun(run1.runId);
    ok('旧 Run 保留原快照 (provider/model/baseUrl/hash/scope)', !!run1Back?.modelConfig
      && run1Back.modelConfig.provider === 'deepseek' && run1Back.modelConfig.model === 'stubB-1'
      && run1Back.modelConfig.baseUrl === `http://127.0.0.1:${B.port}/alt/v1`
      && !!run1Back.modelConfig.configHash && !!run1Back.modelConfig.selectionScope,
      JSON.stringify(run1Back?.modelConfig || null));
    ok('旧 Run 快照的 hash 与当时有效配置一致', run1Back?.modelConfig?.configHash === snap1.configHash, `${run1Back?.modelConfig?.configHash} vs ${snap1.configHash}`);
    const snap2 = await MS.captureRunModelConfig();
    const run2 = await runStore.startRun({ surface: 'cli', goal: '下一个 Run (切模型后)', modelConfig: snap2 });
    ok('下一个 Run 用新模型', run2.modelConfig?.model === 'stubA-1' && run2.modelConfig?.provider === 'openai', JSON.stringify(run2.modelConfig || null));
    ok('两个 Run 的快照不同', run1.modelConfig?.configHash !== run2.modelConfig?.configHash);

    // ────────────────────────────────────────────────────────
    section('5 CLI 与 Web 读到同一份配置');
    // 先把 kimi 指到还活着的 B (后面 Web 要切到它, 探测得能过)
    await MS.selectModel({ provider: 'kimi', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });
    await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global' });
    // CLI: 走真命令面
    const cliStatus: any = JSON.parse(await SW.runModelCommand('status --json'));
    // Web: 真起 express + 真 HTTP
    const app = express();
    app.use(express.json());
    const webMod: any = await import('../src/web/routes-llm-config.js');
    webMod.registerLlmConfigRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const wport = (server.address() as any).port;
    const j = async (p: string, init?: any) => (await fetch(`http://127.0.0.1:${wport}${p}`, init)).json() as any;

    const webCfg = await j('/api/llm-config');
    ok('Web GET /api/llm-config 的 activeProvider = CLI 的有效 provider',
      webCfg.activeProvider === cliStatus.effective.provider, `${webCfg.activeProvider} vs ${cliStatus.effective.provider}`);
    ok('Web 看到的该 provider model = CLI 的有效 model',
      webCfg.providers[cliStatus.effective.provider]?.model === cliStatus.effective.model,
      `${webCfg.providers[cliStatus.effective.provider]?.model} vs ${cliStatus.effective.model}`);
    ok('Web 看到的 baseUrl 与 CLI 一致',
      webCfg.providers[cliStatus.effective.provider]?.baseUrl === cliStatus.effective.baseUrl,
      `${webCfg.providers[cliStatus.effective.provider]?.baseUrl}`);

    // Web 切 → CLI 立刻读到 (同一个统一入口)
    const webSel = await j('/api/llm-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'kimi' }),
    });
    ok('Web 切 provider 成功且返回 effective', webSel.ok === true && !!webSel.effective, JSON.stringify(webSel.effective || webSel));
    const cliAfterWeb: any = JSON.parse(await SW.runModelCommand('status --json'));
    ok('CLI 立刻读到 Web 的那次切换', cliAfterWeb.effective.provider === 'kimi' && (await MS.effectiveModelConfig({})).provider === 'kimi', cliAfterWeb.effective.provider);
    ok('Web 也读到同一份', (await j('/api/llm-config')).activeProvider === 'kimi');
    await new Promise<void>((r) => server.close(() => r()));

    // ────────────────────────────────────────────────────────
    section('6 重启 (真新进程) 后仍生效');
    const childGot = childEffective();
    const parentNow = await MS.effectiveModelConfig({});
    ok('新进程读到的 provider/model/baseUrl 与父进程一致',
      childGot?.effective?.provider === parentNow.provider
      && childGot?.effective?.model === parentNow.model
      && childGot?.effective?.baseUrl === parentNow.baseUrl,
      `${childGot?.effective?.provider}/${childGot?.effective?.model} @ ${childGot?.effective?.baseUrl}`);

    // ────────────────────────────────────────────────────────
    section('12 两个进程同时切配置 → 不互相覆盖');
    delete process.env.BOLLOON_SESSION_KEY;
    const childEnv = { ...process.env, BOLLOON_HOME: HOME, HOME, USERPROFILE: HOME };
    const runChild = (args: string[]): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const cp = spawn('npx', ['tsx', CHILD, HOME, ...args], { cwd: ROOT, env: childEnv });
        let out = '';
        cp.stdout.on('data', (d) => { out += String(d); });
        cp.stderr.on('data', (d) => { out += String(d); });
        cp.on('close', (code) => resolve({ code, out }));
      });

    // (a) 真并发: 两个进程各切一个 provider, 谁的改动都不许丢
    const [r1, r2] = await Promise.all([
      runChild(['select', 'deepseek', 'stubB-9', `http://127.0.0.1:${B.port}/alt/v1`, 'k-stub-b']),
      runChild(['select', 'openai', 'stubA-9', `http://127.0.0.1:${A.port}/v1`, 'k-stub-a']),
    ]);
    ok('并发进程 1 切换成功', r1.out.includes('"ok":true'), r1.out.slice(-200));
    ok('并发进程 2 切换成功', r2.out.includes('"ok":true'), r2.out.slice(-200));
    const merged = readJsonOr(modelCfgPath, {});
    ok('进程 1 的改动没被覆盖 (deepseek.model=stubB-9)', merged.providers.deepseek.model === 'stubB-9', merged.providers.deepseek.model);
    ok('进程 2 的改动没被覆盖 (openai.model=stubA-9)', merged.providers.openai.model === 'stubA-9', merged.providers.openai.model);
    ok('activeProvider 是其中一个 (不是第三个值)', ['deepseek', 'openai'].includes(merged.activeProvider), merged.activeProvider);

    // (b) 陈旧内存缓存不许覆盖别人的改动 (这才是"不互相覆盖"的判别性用例):
    //     父进程先读一次配置 (把内存缓存灌满) → 另一个进程改 glm → 父进程再切 provider。
    //     如果写盘前不重读, 父进程会把陈旧的整份配置写回去, glm 的改动就凭空消失。
    await MS.effectiveModelConfig({});
    const r3 = await runChild(['select', 'glm', 'glm-marker-1', `http://127.0.0.1:${B.port}/alt/v1`, 'k-stub-b']);
    ok('另一进程写入 glm 标记成功', r3.out.includes('"ok":true'), r3.out.slice(-160));
    const staleSwitch = await MS.selectModel({ provider: 'openai', model: 'stubA-8', baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: 'k-stub-a', scope: 'global', verify: false });
    ok('持有陈旧缓存的进程仍能切换', staleSwitch.ok, staleSwitch.message || '');
    const afterStale = readJsonOr(modelCfgPath, {});
    ok('另一进程写的 glm 改动没被陈旧缓存覆盖', afterStale.providers.glm.model === 'glm-marker-1', afterStale.providers.glm.model);

    // (c) 判别性用例: 另一个进程**正在锁里做 read-modify-write** (窗口 900ms),
    //     此时本进程也去切配置。有跨进程锁 → 本进程必须等它做完, 于是双方的改动都在;
    //     没有锁 → 本进程会在那个窗口里写进去, 然后被对方的陈旧快照覆盖 (改动凭空消失)。
    const hold = runChild(['holdwrite', 'gemini', 'gemini-hold-1', '900']);
    await new Promise((r) => setTimeout(r, 150)); // 让对方先拿到锁 (一次性错峰, 不是轮询)
    const raceSwitch = await MS.selectModel({ provider: 'kimi', model: 'stubB-1', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, apiKey: 'k-stub-b', scope: 'global' });
    const holdRes = await hold;
    ok('持锁进程完成', holdRes.out.includes('"ok":true'), holdRes.out.slice(-120));
    ok('持锁期间的并发切换也成功', raceSwitch.ok, raceSwitch.message || '');
    const afterRace = readJsonOr(modelCfgPath, {});
    ok('持锁进程写的 gemini 改动在', afterRace.providers?.gemini?.model === 'gemini-hold-1', afterRace.providers?.gemini?.model);
    ok('并发的 kimi 改动没有被持锁进程的陈旧快照覆盖', afterRace.providers?.kimi?.model === 'stubB-1', afterRace.providers?.kimi?.model);

    // ────────────────────────────────────────────────────────
    section('13 旧 llm-config.json 可迁移');
    const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-legacy-'));
    await fsp.writeFile(path.join(HOME2, 'llm-config.json'), JSON.stringify({
      activeProvider: 'deepseek',
      providers: { deepseek: { enabled: true, apiKey: 'k-legacy', baseUrl: `http://127.0.0.1:${B.port}/alt/v1`, model: 'legacy-model-1', requiresApiKey: false } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2), { mode: 0o600 });
    const childLegacy = spawnSync('npx', ['tsx', CHILD, HOME2, 'effective'], {
      cwd: ROOT, encoding: 'utf-8', env: { ...process.env, BOLLOON_HOME: HOME2, HOME: HOME2, USERPROFILE: HOME2 }, timeout: 120_000,
    });
    const legacyLine = String(childLegacy.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
    const legacyGot = legacyLine ? JSON.parse(legacyLine.slice('CHILD:'.length)) : null;
    ok('旧文件被迁移进新文件名', fs.existsSync(path.join(HOME2, 'bolloon-config.json')));
    ok('迁移后有效配置 = 旧文件里的那一份',
      legacyGot?.effective?.provider === 'deepseek' && legacyGot?.effective?.model === 'legacy-model-1',
      JSON.stringify(legacyGot?.effective || null));
    await fsp.rm(HOME2, { recursive: true, force: true });

    // ────────────────────────────────────────────────────────
    section('附加: 有效配置里不出现明文 key');
    const dumped = JSON.stringify(await MS.effectiveModelConfig({})) + JSON.stringify(readJsonOr(path.join(HOME, 'model-sessions.json'), {}));
    ok('有效配置/session 绑定里没有 key 明文', !dumped.includes('k-stub-a') && !dumped.includes('k-stub-b') && !dumped.includes('k-legacy'), dumped.slice(0, 120));

  } finally {
    await A.close();
    await B.close();
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`verify-model-selection: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
  if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
