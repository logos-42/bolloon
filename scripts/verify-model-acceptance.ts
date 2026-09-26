/**
 * verify-model-acceptance.ts — 模型切换链路 **P8 终验** (16 条逐条真跑, 2026-09-26)
 *
 * ## 这道门与已有的八道门是什么关系
 *
 * 已有的门各管一段 (P0/P1 选择入口 · P2 选择器 · P3 注册表 · P4 URL 链 · P5 发现与缓存 ·
 * P6 入口收敛 · P7 长任务策略 · 飞轮冻结)。**"那道门绿过"不等于"这条验收已过"** ——
 * 这条验收是**独立重跑**: 在**当前集成树**上把 16 条逐条再跑一次, 而且刻意与那些门
 * **不同一个进程 / 不同一份 home**: 每个子进程都是新进程, 假上游在父进程里,
 * 于是"跨进程读到同一份配置""重启仍生效""两进程同时写不互相覆盖"这三类才算真验到。
 *
 * ## 真跑的含义
 *
 * · 假上游 = 127.0.0.1 上的真 HTTP 服务器 (说 OpenAI 兼容协议)。路由/协议/HTTP/请求体
 *   都是真的, 只有"对面是谁"是假的 —— 它把**每一笔请求**记下来 (方法/路径/请求体里的
 *   model 名/有没有带工具声明), 于是"下一次请求真命中 B"有**盘的证据**而不是内存字段。
 * · 每次"调用模型"都是真 `getMinimax().chat()` 发出去的真 HTTP。
 * · 切换走**真入口** (`selectModel` / `runModelCommand` / `bolloon model` 真 argv 子进程)。
 * · 有反事实臂的地方, 反事实臂也**真跑**(把旧行为原样执行一次), 不是嘴上说的。
 *
 * ## 成本诚实
 *
 * 全程用假上游: **没有真 LLM 调用、没有真凭据**。报告里的"模型调用次数"是打到假上游的
 * 真 HTTP 次数 (成本 0)。凭据全是 `stub-*` 假值, 报告与产物里不出现真 key。
 *
 * ## 用法
 *
 *   npx tsx scripts/verify-model-acceptance.ts            # 跑全部 16 条
 *   npx tsx scripts/verify-model-acceptance.ts 1 4 7 12   # 只跑指定条 (调试用; 报告会标 partial)
 *
 * 退出码: 0 = 16 条全过 (含反事实臂都符合预期); 1 = 有条目红; 2 = 脚本自身崩了。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type { AddressInfo } from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-acceptance-'));
const HOME = path.join(TMP, 'home');
const BOLLOON_HOME = path.join(HOME, '.bolloon');

// 隔离必须在任何 src 模块被 import 之前生效 (config-store / run-store 的路径在模块加载期算)
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_HOME = BOLLOON_HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
// 隔离 home 里没有 `bolloon setup` 的引导状态 → `createGoal` 的初始化硬门禁会拦。
// 这里用代码里**已经有**的那个旁路开关 (与 setup 向导同一条), 而不是把机主**真实**的
// LLM 配置复制进来 (那会引入真凭据, 也会换掉本验收自己的基线配置) —— 如实写进报告。
process.env.BOLLOON_SETUP_IN_PROGRESS = '1';
delete process.env.BOLLOON_MODEL_SKIP_PROBE;
delete process.env.BOLLOON_SESSION_KEY;

/** 假上游地址 (main 里起好之后填; 后面几个条目要用) */
let A_BASE = '';
let D_BASE = '';
/** 变异脚本跑完后由环境变量传进来 (变异脚本自己真跑本门, 这里只把结论记进报告) */
const MUTATION_M4_RED = process.env.BOLLOON_ACCEPTANCE_M4_RED === '1';

const ONLY = process.argv.slice(2).map((s) => Number(s)).filter((n) => Number.isFinite(n));
const CHILD = 'scripts/lib/model-acceptance-child.ts';
const CLI_ENTRY = 'src/cli-entry.ts';

// ============================================================
// 记录 / 断言
// ============================================================

interface Check { label: string; ok: boolean; evidence: string }
interface Counterfactual {
  /** 反事实臂在做什么 (旧行为 / 拿掉修复) */
  arm: string;
  /** 期望看到什么 (通常是"与修复后相反") */
  expected: string;
  /** 真跑到的结果 */
  observed: string;
  ok: boolean;
}
interface ItemReport {
  id: number;
  title: string;
  method: string;
  checks: Check[];
  artifacts: string[];
  counterfactuals: Counterfactual[];
}
interface Report { generatedAt: string; home: string; items: ItemReport[]; modelCalls: number; notes: string[] }

const report: Report = { generatedAt: new Date().toISOString(), home: TMP, items: [], modelCalls: 0, notes: [] };
const itemById = new Map<number, ItemReport>();

function startItem(id: number, title: string, method: string): ItemReport {
  const it: ItemReport = { id, title, method, checks: [], artifacts: [], counterfactuals: [] };
  report.items.push(it);
  itemById.set(id, it);
  return it;
}
function chk(it: ItemReport, label: string, cond: boolean, evidence = ''): boolean {
  it.checks.push({ label, ok: !!cond, evidence: String(evidence).slice(0, 900) });
  return !!cond;
}
function cf(it: ItemReport, arm: string, expected: string, observed: string, ok: boolean): void {
  it.counterfactuals.push({ arm, expected, observed: String(observed).slice(0, 900), ok: !!ok });
}
function art(it: ItemReport, s: string): void { if (!it.artifacts.includes(s)) it.artifacts.push(s); }

const failures: string[] = [];
function fail(id: number, label: string, why: string): void {
  failures.push(`[${String(id).padStart(2, '0')}] ${label}: ${why.slice(0, 300)}`);
}

// ============================================================
// 假上游 (真 HTTP; 记下每一笔请求)
// ============================================================

interface StubHit { at: number; method: string; path: string; model: string; hasTools: boolean; authOk: boolean }
interface Stub {
  label: string;
  port: number;
  baseUrl: string;
  hits: StubHit[];
  /** 可运行时翻转: 目录端点是否 404 / 是否拒绝工具声明 */
  mode: { catalog: 'ok' | 'missing'; rejectTools: boolean };
  catalogHits(): number;
  chatHits(): number;
  reset(): void;
  close(): Promise<void>;
}

function startStub(opts: {
  label: string;
  basePath?: string;
  models: string[];
  key?: string | null;
  rejectTools?: boolean;
  catalog?: 'ok' | 'missing';
}): Promise<Stub> {
  const basePath = opts.basePath ?? '/v1';
  const hits: StubHit[] = [];
  const mode = { catalog: opts.catalog ?? 'ok' as 'ok' | 'missing', rejectTools: !!opts.rejectTools };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const auth = String(req.headers.authorization || req.headers['x-api-key'] || '');
      const authOk = !opts.key || auth === `Bearer ${opts.key}` || auth === String(opts.key);
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'); } catch { body = null; }
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      hits.push({
        at: Date.now(), method: String(req.method || 'GET'), path: url.pathname,
        model: String(body?.model || ''), hasTools, authOk,
      });
      res.setHeader('content-type', 'application/json');

      if (url.pathname === `${basePath}/models`) {
        if (!authOk) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid api key' } })); return; }
        if (mode.catalog === 'missing') { res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'not found' } })); return; }
        res.statusCode = 200;
        res.end(JSON.stringify({ object: 'list', data: opts.models.map((id) => ({ id, object: 'model', owned_by: 'stub' })) }));
        return;
      }

      if (url.pathname === `${basePath}/chat/completions`) {
        if (!authOk) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid api key' } })); return; }
        if (hasTools && mode.rejectTools) {
          // 明确"不接受工具/函数声明" —— 这正是 tool_call_unsupported 的触发形状
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'tools/function calling is not supported by this model' } }));
          return;
        }
        if (hasTools) {
          res.statusCode = 200;
          res.end(JSON.stringify({
            id: 'stub', object: 'chat.completion', model: body?.model || 'stub',
            choices: [{
              index: 0, finish_reason: 'tool_calls',
              message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
              },
            }],
          }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({
          id: 'stub', object: 'chat.completion', model: body?.model || 'stub',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `pong:${opts.label}:${body?.model || '?'}` } }],
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `stub 不认这个路径: ${url.pathname}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        label: opts.label, port, baseUrl: `http://127.0.0.1:${port}${basePath}`,
        hits, mode,
        catalogHits: () => hits.filter((h) => h.path.endsWith('/models')).length,
        chatHits: () => hits.filter((h) => h.path.endsWith('/chat/completions')).length,
        reset: () => { hits.length = 0; },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ============================================================
// 子进程 (真进程; 必须异步 spawn —— 同步会堵住父进程的事件循环, 假上游就没人应答)
// ============================================================

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME, USERPROFILE: HOME, BOLLOON_HOME };
}

async function runProc(cmd: string, args: string[], timeoutMs = 240_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv() });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已死 */ } }, timeoutMs);
    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (out += c));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out + String(e) }); });
  });
}

interface ChildOut { ok?: boolean; [k: string]: any }

async function runChild(payload: Record<string, unknown>, timeoutMs = 240_000): Promise<{ code: number; stdout: string; out: ChildOut | null }> {
  const json = JSON.stringify({ home: HOME, bolloonHome: BOLLOON_HOME, ...payload });
  const r = await runProc('npx', ['tsx', CHILD, json], timeoutMs);
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD:')) || '';
  let out: ChildOut | null = null;
  if (line) { try { out = JSON.parse(line.slice('CHILD:'.length)); } catch { out = null; } }
  return { code: r.code, stdout: String(r.stdout || ''), out };
}

/** 真 CLI 进程 (`bolloon model ...` = src/cli-entry.ts 的 model 命令面) */
async function runCli(args: string[], timeoutMs = 240_000): Promise<{ code: number; stdout: string }> {
  return runProc('npx', ['tsx', CLI_ENTRY, ...args], timeoutMs);
}

// ============================================================
// 小工具
// ============================================================

const CONFIG_PATH = path.join(BOLLOON_HOME, 'bolloon-config.json');
const SESSIONS_PATH = path.join(BOLLOON_HOME, 'model-sessions.json');

function shaOf(file: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return 'missing'; }
}
function readJson(file: string, fallback: any): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function rowModel(provider: string): string {
  return String(readJson(CONFIG_PATH, {}).providers?.[provider]?.model ?? '(无)');
}
function activeProvider(): string {
  return String(readJson(CONFIG_PATH, {}).activeProvider ?? '(无)');
}
/** 一条"关键行" —— 从真文件里摘出来进报告 (不是复述内存) */
function kv(label: string, value: string): string { return `${label}=${value}`; }
function short(s: unknown, n = 150): string { return String(s ?? '').replace(/\s+/g, ' ').slice(0, n); }

function httpJson(method: string, url: string, body?: any, timeoutMs = 60_000): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = d ? JSON.parse(d) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed, raw: d });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('http timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  fs.mkdirSync(BOLLOON_HOME, { recursive: true });

  // 假上游: 五台 + 一台"目录端点坏掉"的
  const A = await startStub({ label: 'A', basePath: '/v1', models: ['stubA-1', 'stubA-2', 'race-a'], key: 'stub-k-a' });
  const B = await startStub({ label: 'B', basePath: '/alt/v1', models: ['stubB-1', 'stubB-2', 'race-b'], key: 'stub-k-b' });
  const C = await startStub({ label: 'C', basePath: '/weird/path/v9', models: ['stubC-1'], key: 'stub-k-c' });
  const D = await startStub({ label: 'D', basePath: '/v1', models: ['no-tool-model'], key: 'stub-k-d', rejectTools: true });
  const E = await startStub({ label: 'E', basePath: '/v1', models: ['live-m1'], key: 'stub-k-e' });

  const stubs = [A, B, C, D, E];
  A_BASE = A.baseUrl;
  D_BASE = D.baseUrl;

  const MS: any = await import('../src/llm/model-selection.js');
  const CS: any = await import('../src/llm/config-store.js');
  const MD: any = await import('../src/llm/model-discovery.js');
  const MP: any = await import('../src/agents/model-policy.js');
  const RS: any = await import('../src/agents/run-store.js');
  const GS: any = await import('../src/agents/goal-store.js');
  const { getMinimax, initMinimax } = await import('../src/llm/pi-ai.js');

  console.log(`\n════ 模型切换验收 (P8 终验, 16 条逐条真跑) ════`);
  console.log(`隔离 home: ${TMP}`);
  console.log(`假上游: A=${A.baseUrl} · B=${B.baseUrl} · C=${C.baseUrl} · D=${D.baseUrl}(拒工具声明) · E=${E.baseUrl}`);
  console.log(`说明: 模型调用全部打到上面这些**本地假上游** (非真 LLM), 凭据全是 stub-* 假值\n`);

  // ── 预置: 内置四家的凭证 + 自定义供应商 (后面条目按需切) ──────
  await CS.llmConfigStore.initialize();
  await CS.llmConfigStore.updateProvider('openai', { enabled: true, apiKey: 'stub-k-a', baseUrl: A.baseUrl, model: 'stubA-1' });
  await CS.llmConfigStore.updateProvider('deepseek', { enabled: true, apiKey: 'stub-k-b', baseUrl: B.baseUrl, model: 'stubB-1' });
  await CS.llmConfigStore.updateProvider('kimi', { enabled: true, apiKey: 'stub-k-c', baseUrl: C.baseUrl, model: 'stubC-1' });
  await CS.llmConfigStore.updateProvider('glm', { enabled: true, apiKey: 'stub-k-d', baseUrl: D.baseUrl, model: 'no-tool-model' });
  await CS.llmConfigStore.updateProvider('qwen', { enabled: true, apiKey: 'stub-k-e', baseUrl: E.baseUrl, model: 'live-m1' });
  await CS.llmConfigStore.setCustomProviders({
    notoolgw: {
      providerId: 'notoolgw', displayName: '不声明工具调用的网关', baseUrl: D.baseUrl,
      protocol: 'openai-compatible', apiKey: 'stub-k-d', model: 'no-tool-model', models: ['no-tool-model'],
      capabilities: { toolCalling: 'no' },
    },
    toolgw: {
      providerId: 'toolgw', displayName: '声明支持工具调用的网关', baseUrl: A.baseUrl,
      protocol: 'openai-compatible', apiKey: 'stub-k-a', model: 'stubA-1', models: ['stubA-1'],
      capabilities: { toolCalling: 'yes', reasoning: 'no' },
    },
  });

  const want = (id: number) => ONLY.length === 0 || ONLY.includes(id);

  /** 每次"真调一次模型"都从这里走 —— 顺便记成本 */
  const realCall = async (label: string): Promise<{ reply?: string; error?: string }> => {
    try {
      const r: any = await getMinimax().chat(`accept-${label}`);
      report.modelCalls++;
      return { reply: String(r?.reply ?? '') };
    } catch (e: any) {
      report.modelCalls++;
      return { error: short(e?.message || e, 200) };
    }
  };

  // ────────────────────────────────────────────────────────
  if (want(1)) await item01(A, B, MS, realCall, runChild, runCli);
  // ────────────────────────────────────────────────────────
  if (want(2)) await item02(B, MS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(3)) await item03(C, A, B, MS, realCall, runChild);
  // ────────────────────────────────────────────────────────
  if (want(4)) await item04(A, B, MS, realCall, runChild);
  // ────────────────────────────────────────────────────────
  if (want(5)) await item05(A, C, MS, runChild, runCli, realCall);
  // ────────────────────────────────────────────────────────
  if (want(6)) await item06(C, MS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(7)) await item07(A, B, MS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(8)) await item08(A, MS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(9)) await item09(A, B, MS, RS, GS, realCall);
  // ────────────────────────────────────────────────────────
  if (want(10)) await item10(A, MS, MP, RS, GS);
  // ────────────────────────────────────────────────────────
  if (want(11)) await item11(A, B, MS, MP, RS, GS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(12)) await item12(A, B, C, E, MS, runChild);
  // ────────────────────────────────────────────────────────
  if (want(13)) await item13(B, runChild);
  // ────────────────────────────────────────────────────────
  if (want(14)) await item14(E, MS, MD);
  // ────────────────────────────────────────────────────────
  if (want(15)) await item15(D, MS, realCall, runChild);
  // ────────────────────────────────────────────────────────
  if (want(16)) await item16(B, MS, realCall, runChild, getMinimax, initMinimax);

  // ── 收尾 ──────────────────────────────────────────────────
  for (const s of stubs) await s.close().catch(() => undefined);

  // ── 打印 ─────────────────────────────────────────────────
  const totalChecks = report.items.reduce((n, i) => n + i.checks.length, 0);
  const totalCf = report.items.reduce((n, i) => n + i.counterfactuals.length, 0);
  const redChecks = report.items.flatMap((i) => i.checks.filter((c) => !c.ok).map((c) => `[${i.id}] ${c.label} — ${c.evidence}`));
  const redCf = report.items.flatMap((i) => i.counterfactuals.filter((c) => !c.ok).map((c) => `[${i.id}] 反事实 ${c.arm} — 期望: ${c.expected}; 实到: ${c.observed}`));

  console.log('\n' + '─'.repeat(72));
  for (const it of report.items) {
    const cfOk = it.counterfactuals.length === 0 || it.counterfactuals.every((c) => c.ok);
    const pass = it.checks.every((c) => c.ok) && cfOk;
    console.log(`\n[${String(it.id).padStart(2, '0')}] ${it.title} — ${pass ? 'PASS' : 'FAIL'} (${it.checks.filter((c) => c.ok).length}/${it.checks.length} 断言`
      + `${it.counterfactuals.length ? ` · 反事实 ${it.counterfactuals.filter((c) => c.ok).length}/${it.counterfactuals.length} 符合预期` : ''})`);
    console.log(`     做法: ${it.method}`);
    for (const c of it.checks) console.log(`     ${c.ok ? '✅' : '❌'} ${c.label}${c.evidence ? ` — ${c.evidence}` : ''}`);
    for (const c of it.counterfactuals) {
      console.log(`     ${c.ok ? '↔' : '❌'} 反事实: ${c.arm}`);
      console.log(`        期望: ${c.expected}`);
      console.log(`        实到: ${c.observed}`);
    }
    if (it.artifacts.length) console.log(`     产物: ${it.artifacts.join(' · ')}`);
  }

  // ── 判定 ─────────────────────────────────────────────────
  for (const it of report.items) {
    for (const c of it.checks) if (!c.ok) fail(it.id, c.label, c.evidence);
    for (const c of it.counterfactuals) if (!c.ok) fail(it.id, `反事实 ${c.arm}`, `期望 ${c.expected} / 实到 ${c.observed}`);
  }

  const partial = ONLY.length > 0;
  const outPath = path.join(TMP, 'model-acceptance-report.json');
  await fsp.writeFile(outPath, JSON.stringify({ ...report, partial, only: ONLY }, null, 2), 'utf-8');

  console.log('\n' + '='.repeat(72));
  console.log(`verify-model-acceptance: 条目 ${report.items.length}/16 · 断言 ${totalChecks - redChecks.length}/${totalChecks} 过 · 反事实 ${totalCf - redCf.length}/${totalCf} 符合预期`);
  console.log(`模型调用 (真 HTTP 打到本地假上游, **非真 LLM**): ${report.modelCalls} 次 · 成本 0`);
  console.log(`报告 JSON: ${outPath}${partial ? ` (partial: 只跑了 ${ONLY.join(',')})` : ''}`);
  if (redChecks.length || redCf.length) {
    console.log('红项:');
    for (const r of [...redChecks, ...redCf]) console.log(`  · ${r}`);
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================
// 第 1 条: CLI `/model` 从 A 切到 B, 下一次请求命中 B
// ============================================================

async function item01(A: Stub, B: Stub, MS: any, realCall: any, runChild: any, runCli: any): Promise<void> {
  const it = startItem(1, 'CLI `/model` 从 provider A 切到 B, 下一次请求命中 B (不是同一家)',
    '父进程先用统一入口落到 A (openai@A) → 子进程 (真进程) 里 *先按旧配置装配好运行时*, 再走会话内 `/model` 切到 B, '
    + '然后**同一个进程**里真打一次模型请求; 再用**真 CLI argv 进程** (`bolloon model ...` = src/cli-entry.ts) 两个方向各切一次, 每次切换后另起进程真打一次请求。'
    + '假上游把每一笔请求 (路径 + 请求体里的 model) 都记下来了。');

  // 1) 基线: A
  const base = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '基线切到 openai/stubA-1@A 成功 (真探测假上游)', base.ok === true, short(base.message || MS.formatEffectiveModel(base.effective)));
  chk(it, '盘上 activeProvider=openai, openai.model=stubA-1', activeProvider() === 'openai' && rowModel('openai') === 'stubA-1',
    `${kv('activeProvider', activeProvider())} ${kv('providers.openai.model', rowModel('openai'))}`);
  art(it, `${CONFIG_PATH} (activeProvider=${activeProvider()})`);

  // 2) **同进程**会话内切换 A→B, 下一次请求...
  const chatsB0 = B.chatHits(), chatsA0 = A.chatHits();
  const sw = await runChild({ mode: 'session-switch', arg: `deepseek stubB-1 --base-url ${B.baseUrl}`, label: 'after-cli-switch' });
  const printed = short(sw.out?.printed || sw.stdout, 200);
  chk(it, `会话内 \`/model deepseek stubB-1 --base-url ${short(B.baseUrl, 40)}\` 切换成功 (同进程, 真 argv 形状)`,
    sw.out?.ok === true && /已切换到 deepseek/.test(String(sw.out?.printed || '')), printed);
  chk(it, '**下一次请求命中 B** (同进程内运行时真被换掉, reply 带回假上游标签)', String(sw.out?.reply || '').startsWith('pong:B:'),
    `${kv('reply', String(sw.out?.reply))} · B chat +${B.chatHits() - chatsB0} 笔 · A chat +${A.chatHits() - chatsA0} 笔`);
  chk(it, 'A 这一轮一笔都没收到 (不是"两边都打")', A.chatHits() === chatsA0, `${kv('A.chatHits', String(A.chatHits()))}`);
  const lastB = B.hits.filter((h) => h.path.endsWith('/chat/completions')).at(-1);
  chk(it, 'B 记下的请求体里 model=stubB-1', lastB?.model === 'stubB-1', `${kv('path', String(lastB?.path))} ${kv('model', String(lastB?.model))}`);
  art(it, `${B.label} 记录: ${JSON.stringify(B.hits.filter((h) => h.path.endsWith('/chat/completions')).slice(-1))}`);

  // 3) **真 CLI 进程** 双向: B → A (真 argv) → 新进程真打请求
  const cliToA = await runCli(['model', 'openai', 'stubA-1', '--base-url', A.baseUrl]);
  chk(it, '真 CLI 进程 `bolloon model openai stubA-1 --base-url <A>` 切换成功',
    /已切换到 openai/.test(cliToA.stdout), short(cliToA.stdout.split('\n').filter((l) => l.includes('当前生效') || l.includes('已切换')).join(' | '), 220));
  const callA = await runChild({ mode: 'call', label: 'cli-to-a' });
  chk(it, '切到 A 后另起进程真打请求命中 A (reply 带 A 标签)', String(callA.out?.reply || '').startsWith('pong:A:'), `${kv('reply', String(callA.out?.reply))}`);

  const cliToB = await runCli(['model', 'deepseek', 'stubB-1', '--base-url', B.baseUrl]);
  chk(it, '真 CLI 进程 `bolloon model deepseek stubB-1 --base-url <B>` 切换成功 (跨 provider)',
    /已切换到 deepseek/.test(cliToB.stdout), short(cliToB.stdout.split('\n').filter((l) => l.includes('当前生效') || l.includes('已切换')).join(' | '), 220));
  const callB = await runChild({ mode: 'call', label: 'cli-to-b' });
  chk(it, '切到 B 后下一秒请求命中 B (真 CLI 进程写的配置被新进程真读到)',
    String(callB.out?.reply || '').startsWith('pong:B:stubB-1'), `${kv('reply', String(callB.out?.reply))}`);

  // 4) 反事实: 旧行为 = 只写配置、不重建运行时
  const legacy = await runChild({
    mode: 'legacy-switch', label: 'legacy',
    target: { provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a' },
  });
  cf(it,
    '旧行为 (拿掉修复): 先按 B 装配好运行时, 再只写配置文件 + 换 activeProvider, **不重建运行时** → 下一次请求仍打 B',
    '下一次请求命中**旧**端点 B (reply=pong:B:*), 而盘上有效配置已经是 openai/stubA-1 (= P0 修的那个"切了不生效"缺陷)',
    `装配时=${legacy.out?.bootedWith}; 之后盘上有效配置=${legacy.out?.nowEffective}; 请求 reply=${legacy.out?.reply}`,
    String(legacy.out?.reply || '').startsWith('pong:B:') && String(legacy.out?.nowEffective || '').startsWith('openai/'));

  // 恢复基线 (B), 免得后面的条目起点漂
  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  void MS;
}

// ============================================================
// 第 2 条: 同 provider 只切 model → 请求体里的 model 真变
// ============================================================

async function item02(B: Stub, MS: any, runChild: any): Promise<void> {
  const it = startItem(2, '同 provider 只切 model, 请求体里的 model 真变',
    'provider 固定 deepseek、baseUrl 固定指向假上游 B, 只把 model 从 stubB-1 换成 stubB-2 (走会话内 `/model` 的同一函数, 切换后再真打一次请求); '
    + '断言用**假上游记下的请求体**逐笔对照: 换之前那一笔写的是 stubB-1, 换之后写的是 stubB-2。');

  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  const before = B.hits.filter((h) => h.path.endsWith('/chat/completions')).at(-1);

  const beforeCfg = shaOf(CONFIG_PATH);
  const sw = await runChild({ mode: 'session-switch', arg: `deepseek stubB-2 --base-url ${B.baseUrl}`, label: 'model-only' });
  chk(it, '同 provider 只换 model 切换成功', sw.out?.ok === true && /已切换到 deepseek/.test(String(sw.out?.printed || '')),
    short(String(sw.out?.printed || ''), 160));

  const after = B.hits.filter((h) => h.path.endsWith('/chat/completions')).at(-1);
  chk(it, '切换后请求体里的 model 真的是 stubB-2', String(sw.out?.reply || '').startsWith('pong:B:stubB-2'),
    `${kv('reply', String(sw.out?.reply))} · 上一笔 model=${after?.model}`);
  chk(it, '盘上只有这一格变: providers.deepseek.model stubB-1→stubB-2, baseUrl 未变',
    rowModel('deepseek') === 'stubB-2' && readJson(CONFIG_PATH, {}).providers?.deepseek?.baseUrl === B.baseUrl && activeProvider() === 'deepseek',
    `${kv('providers.deepseek.model', rowModel('deepseek'))} ${kv('providers.deepseek.baseUrl', String(readJson(CONFIG_PATH, {}).providers?.deepseek?.baseUrl))} ${kv('activeProvider', activeProvider())} ${kv('config sha', beforeCfg + '→' + shaOf(CONFIG_PATH))}`);
  art(it, `${CONFIG_PATH} providers.deepseek={model:${rowModel('deepseek')}, baseUrl:${short(B.baseUrl, 40)}}`);

  cf(it,
    '反事实对照 (同一字段的时间轴): 换之前那一笔请求写的是旧 model',
    '换之前的那一笔请求体里必须是 stubB-1 (若两笔都是 stubB-2, 说明 model 字段不跟着配置走, 这条断言就是空的)',
    `换之前那一笔 model=${before?.model} (发生于切换前) · 换之后那一笔 model=${after?.model}`,
    before?.model === 'stubB-1' && after?.model === 'stubB-2');
}

// ============================================================
// 第 3 条: 自定义 base URL 指向本地 HTTP server, 请求真命中该地址
// ============================================================

async function item03(C: Stub, A: Stub, B: Stub, MS: any, realCall: any, runChild: any): Promise<void> {
  const it = startItem(3, '自定义 base URL 指向本地 HTTP server, 请求真命中该地址',
    '给内置供应商 kimi 配一个**非常规路径**的 base URL (`/weird/path/v9`, 还故意带尾斜杠 → 验规范化), 走统一入口切换, 然后真打一次请求, '
    + '读假上游 C 记下的**路径**; 同时断言 A/B 一笔都没收到。');

  const beforeCfg = shaOf(CONFIG_PATH);
  const sel = await MS.selectModel({ provider: 'kimi', model: 'stubC-1', baseUrl: `http://127.0.0.1:${C.port}/weird/path/v9/`, apiKey: 'stub-k-c', scope: 'global' });
  chk(it, '带尾斜杠的自定义 URL 切换成功 (且被规范化)', sel.ok === true && sel.effective?.baseUrl === C.baseUrl,
    `${kv('effective.baseUrl', String(sel.effective?.baseUrl))} ${short(sel.message || '')}`);
  chk(it, '盘上写的就是这个地址 (不是供应商默认地址)', readJson(CONFIG_PATH, {}).providers?.kimi?.baseUrl === C.baseUrl,
    `${kv('providers.kimi.baseUrl', String(readJson(CONFIG_PATH, {}).providers?.kimi?.baseUrl))}`);

  const c0 = C.chatHits(), a0 = A.chatHits(), b0 = B.chatHits();
  const call = await realCall('custom-url');
  const hit = C.hits.filter((h) => h.path.endsWith('/chat/completions')).at(-1);
  chk(it, '请求真命中这台本地 server (C chat +1)', C.chatHits() === c0 + 1 && String(call.reply || '').startsWith('pong:C:'),
    `${kv('reply', String(call.reply))} · C +${C.chatHits() - c0}`);
  chk(it, '命中的**路径就是自定义那条** /weird/path/v9/chat/completions', hit?.path === '/weird/path/v9/chat/completions',
    `${kv('recorded.path', String(hit?.path))} · ${kv('config sha', beforeCfg + '→' + shaOf(CONFIG_PATH))}`);
  chk(it, 'A / B 两台一笔都没收到 (没有隐藏地打别的地址)', A.chatHits() === a0 && B.chatHits() === b0,
    `${kv('A +', String(A.chatHits() - a0))} ${kv('B +', String(B.chatHits() - b0))}`);
  art(it, `${C.label} 记录: ${JSON.stringify(C.hits.slice(-1))}`);

  // 只读探测也要走这条地址 (不写盘)
  const probe = await MS.runConnectionProbe({ provider: 'kimi', model: 'stubC-1', baseUrl: `http://127.0.0.1:${C.port}/weird/path/v9`, apiKey: 'stub-k-c' });
  chk(it, '只读探测 P4 原语解析出的 baseUrl 与写入的一致, 来源=显式, 工具调用已证',
    probe.ok === true && probe.baseUrl === C.baseUrl && probe.baseUrlSource === 'explicit',
    `${kv('probe.baseUrl', String(probe.baseUrl))} ${kv('baseUrlSource', String(probe.baseUrlSource))} ${kv('toolCalling', String(probe.toolCalling))}`);
  art(it, `probe.checks=${probe.checks.length} 步: ${probe.checks.map((c: any) => `${c.step}${c.ok ? '✓' : '✗'}`).join(',')}`);

  // 人工算一次反事实臂的输出 (只跑一次: 真打上游, 不重复浪费)
  const badUrlSel = await MS.selectModel({ provider: 'kimi', model: 'stubC-1', baseUrl: `http://127.0.0.1:${C.port}/no/such/path`, apiKey: 'stub-k-c', scope: 'global' });
  cf(it,
    '反事实对照 (隐藏 URL / 路径不一致会怎样): 把同一个模型指到"这个地址上没有该路径"的地方',
    '探测**必须判红**并给出类别 (不许静默退回默认地址, 也不许回"切换成功"); 盘上地址保持不变',
    `${kv('failureClass', String(badUrlSel.failureClass))} · ${short(badUrlSel.message || '', 170)} · 盘上仍是 ${String(readJson(CONFIG_PATH, {}).providers?.kimi?.baseUrl)}`,
    badUrlSel.ok === false && !!badUrlSel.failureClass && readJson(CONFIG_PATH, {}).providers?.kimi?.baseUrl === C.baseUrl);
  void runChild;
}

// ============================================================
// 第 4 条: 四类错误都不能切换成功, 且盘上配置字节不变
// ============================================================

async function item04(A: Stub, B: Stub, MS: any, realCall: any, runChild: any): Promise<void> {
  const it = startItem(4, '错 key / 错 URL / 错 model / 畸形 URL 都**不能**切换成功, 且盘上配置字节不变',
    '先把默认落定 deepseek/stubB-1@B, 记下配置文件 sha256; 然后连试四类错误切换 (每类都真打假上游, 不是构造字符串), '
    + '逐条断言失败类别 + 失败后配置字节数不变 + 有效配置仍是旧的那一份。');

  const base = await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  chk(it, '基线 deepseek/stubB-1 落定', base.ok === true, short(base.message || ''));
  const before = shaOf(CONFIG_PATH);
  const beforeEff = await MS.effectiveModelConfig({});

  const badKey = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-wrong', scope: 'global' });
  chk(it, '① 错 key 被拒 (auth_failed, 401 来自假上游)', badKey.ok === false && badKey.failureClass === 'auth_failed' && shaOf(CONFIG_PATH) === before,
    `${kv('failureClass', String(badKey.failureClass))} · ${short(badKey.message || '', 150)}`);

  const badUrl = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '② 错 URL (没人听的端口) 被拒 (provider_unreachable / timeout)',
    badUrl.ok === false && ['provider_unreachable', 'timeout'].includes(String(badUrl.failureClass)) && shaOf(CONFIG_PATH) === before,
    `${kv('failureClass', String(badUrl.failureClass))} · ${short(badUrl.message || '', 150)}`);

  const badModel = await MS.selectModel({ provider: 'openai', model: 'no-such-model-xyz', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '③ 错 model (目录里没有) 被拒 (model_not_found)',
    badModel.ok === false && badModel.failureClass === 'model_not_found' && shaOf(CONFIG_PATH) === before,
    `${kv('failureClass', String(badModel.failureClass))} · ${short(badModel.message || '', 150)}`);

  const malformed = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: 'not-a-url', apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '④ 畸形 URL 被拒 (invalid_url)', malformed.ok === false && malformed.failureClass === 'invalid_url' && shaOf(CONFIG_PATH) === before,
    `${kv('failureClass', String(malformed.failureClass))} · ${short(malformed.message || '', 150)}`);

  const afterEff = await MS.effectiveModelConfig({});
  chk(it, '四次失败后: 配置字节未变 + 有效配置仍是 deepseek/stubB-1',
    shaOf(CONFIG_PATH) === before && afterEff.provider === beforeEff.provider && afterEff.model === beforeEff.model && afterEff.configHash === beforeEff.configHash,
    `${kv('config sha', `${before} → ${shaOf(CONFIG_PATH)}`)} · 生效=${afterEff.provider}/${afterEff.model} hash=${afterEff.configHash}`);
  art(it, `${CONFIG_PATH} sha256[:16]=${shaOf(CONFIG_PATH)} (四次失败前后相同)`);

  // 反事实: 一次**正确**的切换必须真改字节 —— 否则"字节没变"这句是空的
  const goodSwitch = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  const afterGood = shaOf(CONFIG_PATH);
  cf(it,
    '反事实对照 (这条断言会不会是空的): 一次**正确**的切换之后, 同一个 sha256 必须变',
    '正确切换后配置字节**变了** (若不变, 说明"失败后字节不变"根本不证明任何事 —— 空断言)',
    `正确切换 ok=${goodSwitch.ok}, sha ${before} → ${afterGood} (${before === afterGood ? '没变 ⇒ 断言是空的' : '变了 ⇒ 断言有判别力'})`,
    goodSwitch.ok === true && afterGood !== before);
  art(it, `正确切换后 sha256[:16]=${afterGood} (与失败路径对照)`);

  // 还原基线 (B)
  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  const still = await realCall('after-4-failures');
  chk(it, '四类错误之后旧模型仍能真跑 (→ 第 16 条的运行时侧; 这里先做一次端到端)', String(still.reply || '').startsWith('pong:B:stubB-1'), kv('reply', String(still.reply)));
  void runChild;
}

// ============================================================
// 第 5 条: CLI 与 Web 切换后读到同一份配置
// ============================================================

async function item05(A: Stub, C: Stub, MS: any, runChild: any, runCli: any, realCall: any): Promise<void> {
  const it = startItem(5, 'CLI 与 Web 切换后读到**同一份**配置',
    '真起 express + `registerLlmConfigRoutes` 的**真 HTTP 监听**; ① 用**真 CLI 进程**切到 kimi@C → 读 Web `GET /api/llm-config`; '
    + '② 用 Web `POST /api/llm-provider` 切回 deepseek → 读**真 CLI 进程**的 `model status --json`。两个方向都真跨进程。');

  const expressMod: any = await import('express');
  const express = expressMod.default || expressMod;
  const app = express();
  app.use(express.json());
  const { registerLlmConfigRoutes } = await import('../src/web/routes-llm-config.js');
  registerLlmConfigRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const wport = (server.address() as AddressInfo).port;
  const WEB = `http://127.0.0.1:${wport}`;
  art(it, `Web 真 HTTP: ${WEB} (express + registerLlmConfigRoutes)`);

  try {
    // ① CLI (真进程) → Web
    const cli = await runCli(['model', 'kimi', 'stubC-1', '--base-url', C.baseUrl]);
    chk(it, '真 CLI 进程切到 kimi/stubC-1 成功', /已切换到 kimi/.test(cli.stdout), short(cli.stdout.split('\n').find((l) => l.includes('已切换')) || '', 160));
    const webCfg = await httpJson('GET', `${WEB}/api/llm-config`);
    chk(it, `Web 读到的 activeProvider = CLI 刚切的那一家`,
      webCfg.status === 200 && webCfg.body?.activeProvider === 'kimi' && webCfg.body?.providers?.kimi?.model === 'stubC-1'
      && webCfg.body?.providers?.kimi?.baseUrl === C.baseUrl,
      `${kv('web.activeProvider', String(webCfg.body?.activeProvider))} ${kv('web.providers.kimi', JSON.stringify(webCfg.body?.providers?.kimi ? { model: webCfg.body.providers.kimi.model, baseUrl: webCfg.body.providers.kimi.baseUrl } : null))}`);

    // ② Web → CLI (真进程) + 独立进程读回
    const webSel = await httpJson('POST', `${WEB}/api/llm-provider`, { provider: 'deepseek' });
    chk(it, 'Web `POST /api/llm-provider` 切到 deepseek 成功 (返回 effective)',
      webSel.status === 200 && webSel.body?.ok === true && webSel.body?.effective?.provider === 'deepseek',
      `${kv('HTTP', String(webSel.status))} ${kv('effective', `${webSel.body?.effective?.provider}/${webSel.body?.effective?.model}`)}`);

    const cliStatus = await runCli(['model', 'status', '--json']);
    const parsed = (() => { try { return JSON.parse(cliStatus.stdout.slice(cliStatus.stdout.indexOf('{'))); } catch { return null; } })();
    chk(it, '真 CLI 进程 `model status --json` 读到 Web 那次切换 (provider/model 逐字相同)',
      parsed?.effective?.provider === 'deepseek' && parsed?.effective?.model === 'stubB-1' && parsed?.effective?.baseUrl === String(readJson(CONFIG_PATH, {}).providers?.deepseek?.baseUrl),
      `${kv('cli.effective', `${parsed?.effective?.provider}/${parsed?.effective?.model}`)} ${kv('web.effective', `${webSel.body?.effective?.provider}/${webSel.body?.effective?.model}`)}`);

    const childRead = await runChild({ mode: 'effective' });
    chk(it, '第三个进程 (CHILD) 读到的与 Web 返回的逐字段一致',
      childRead.out?.effective?.provider === webSel.body?.effective?.provider
      && childRead.out?.effective?.model === webSel.body?.effective?.model
      && childRead.out?.effective?.baseUrl === webSel.body?.effective?.baseUrl
      && childRead.out?.effective?.configHash === webSel.body?.effective?.configHash,
      `${kv('child.effective', `${childRead.out?.effective?.provider}/${childRead.out?.effective?.model} hash=${childRead.out?.effective?.configHash}`)} ${kv('web hash', String(webSel.body?.effective?.configHash))}`);
    art(it, `${CONFIG_PATH} (CLI 与 Web 读的是同一个文件: ${path.basename(CONFIG_PATH)})`);

    // 反事实: 放一份"诱饵"旧配置文件 —— 两个入口都必须无视它
    const decoy = path.join(BOLLOON_HOME, 'llm-config.json');
    await fsp.writeFile(decoy, JSON.stringify({ activeProvider: 'gemini', providers: { gemini: { enabled: true, apiKey: 'stub-decoy', baseUrl: 'http://127.0.0.1:1/v1', model: 'decoy-model' } }, updatedAt: '2026-01-01T00:00:00.000Z' }, null, 2));
    const webAfterDecoy = await httpJson('GET', `${WEB}/api/llm-config`);
    const cliAfterDecoy = await runChild({ mode: 'effective' });
    await fsp.rm(decoy, { force: true });
    cf(it,
      '反事实对照 (换个文件会不会也"一致"): 放一份诱饵 `llm-config.json` (写 gemini/decoy-model), 让两个入口再读',
      '两个入口都必须**无视**诱饵 (仍报 deepseek/stubB-1) —— 否则"读到同一份"就只是"随便哪一份", 不成立',
      `Web 报 activeProvider=${webAfterDecoy.body?.activeProvider} · 独立进程报 ${cliAfterDecoy.out?.effective?.provider}/${cliAfterDecoy.out?.effective?.model} (诱饵写的是 gemini/decoy-model)`,
      webAfterDecoy.body?.activeProvider === 'deepseek' && cliAfterDecoy.out?.effective?.provider === 'deepseek');

    const routed = await realCall('after-web-switch');
    chk(it, '这条"同一份"配置是能真跑的 (Web 切完之后真请求命中 deepseek 那台 B 上游)',
      String(routed.reply || '').startsWith('pong:B:stubB-1'), kv('reply', String(routed.reply)));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  void A; void MS;
}

// ============================================================
// 第 6 条: 重启 CLI 后仍生效
// ============================================================

async function item06(C: Stub, MS: any, runChild: any): Promise<void> {
  const it = startItem(6, '重启 CLI 后配置仍生效 (新进程读同一份盘上事实)',
    '用统一入口把全局落到 kimi/stubC-1@C → 起一个**全新进程**读有效配置 → 与父进程逐字段比 (含 configHash); '
    + '再起第二个新进程复读一次 (两次都新起, 不共享任何内存缓存)。');

  const sel = await MS.selectModel({ provider: 'kimi', model: 'stubC-1', baseUrl: C.baseUrl, apiKey: 'stub-k-c', scope: 'global' });
  chk(it, '切换成功', sel.ok === true, short(sel.message || ''));

  const parent = await MS.effectiveModelConfig({});
  const child1 = await runChild({ mode: 'effective' });
  const child2 = await runChild({ mode: 'effective' });
  const same = (a: any, b: any) => a?.provider === b?.provider && a?.model === b?.model && a?.baseUrl === b?.baseUrl
    && a?.configHash === b?.configHash && a?.protocol === b?.protocol && a?.authRef === b?.authRef;

  chk(it, '新进程 1 读到的与父进程逐字段相同 (provider/model/baseUrl/protocol/authRef/configHash)',
    same(child1.out?.effective, parent),
    `${kv('child1', `${child1.out?.effective?.provider}/${child1.out?.effective?.model} hash=${child1.out?.effective?.configHash}`)} ${kv('parent', `${parent.provider}/${parent.model} hash=${parent.configHash}`)}`);
  chk(it, '再新起一个进程读 (第二次重启) 仍相同', same(child2.out?.effective, parent),
    `${kv('child2 hash', String(child2.out?.effective?.configHash))}`);
  chk(it, '盘上 activeProvider 就是 kimi (重启读的是文件, 不是"上次选过什么")', activeProvider() === 'kimi', kv('activeProvider', activeProvider()));
  art(it, `${CONFIG_PATH} (activeProvider=${activeProvider()}, configHash=${parent.configHash})`);

  // 反事实: 一个**没落盘**的选择 (会话级只写 model-sessions.json) 不应该被新进程当成全局默认
  const sessSel = await MS.selectModel({ provider: 'openai', model: 'stubA-1', scope: 'session', sessionKey: 'sess-restart-arm' });
  const afterSess = await runChild({ mode: 'effective' });
  cf(it,
    '反事实对照 (重启验的是"落盘"还是"最后一次选择"): 会话级切到 openai/stubA-1 (只写会话绑定), 再新起进程读',
    '新进程仍读全局 kimi/stubC-1 (会话绑定不属于"重启后仍生效"的那一层); 若它读到 openai 就说明这条验收分不清两层',
    `会话级切换 ok=${sessSel.ok} → 新进程读到 ${afterSess.out?.effective?.provider}/${afterSess.out?.effective?.model} (scope=${afterSess.out?.effective?.source})`,
    afterSess.out?.effective?.provider === 'kimi' && afterSess.out?.effective?.source === 'global');

  const routed = await runChild({ mode: 'call', label: 'restart' });
  chk(it, '新进程真打一次请求: 命中 C (重启后真能用)', String(routed.out?.reply || '').startsWith('pong:C:'), kv('reply', String(routed.out?.reply)));
}

// ============================================================
// 第 7 条: Session 切换不改变 Global
// ============================================================

async function item07(A: Stub, B: Stub, MS: any, runChild: any): Promise<void> {
  const it = startItem(7, 'Session 切换不改变 Global (别的会话不受影响)',
    '全局定在 deepseek/stubB-1@B, 记下配置字节; 用**另一个进程**做一次会话级切换 (scope=session, 指向 openai/stubA-1), '
    + '断言: 配置字节一个都没变 · 绑定写进 model-sessions.json · 另一个会话读到的是全局 · 这个会话真打请求命中 A。');

  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  const cfgBytes = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const cfgSha = shaOf(CONFIG_PATH);

  const sess = await runChild({ mode: 'select', target: { provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, scope: 'session', sessionKey: 'sess-7' } });
  chk(it, '会话级切换成功 (走统一入口, 不需要重复给 key)', sess.out?.ok === true, short(sess.out?.message || `${sess.out?.effective?.provider}/${sess.out?.effective?.model}`));
  chk(it, '这次生效的作用域标成 session', sess.out?.effective?.source === 'session', kv('source', String(sess.out?.effective?.source)));
  chk(it, '**Global 配置文件字节一个都没变**', fs.readFileSync(CONFIG_PATH, 'utf-8') === cfgBytes, `${kv('config sha', `${cfgSha} → ${shaOf(CONFIG_PATH)}`)}`);
  const bind = readJson(SESSIONS_PATH, { sessions: {} });
  chk(it, '会话绑定落在 model-sessions.json (sess-7 → openai/stubA-1)', bind.sessions?.['sess-7']?.provider === 'openai' && bind.sessions?.['sess-7']?.model === 'stubA-1',
    `${kv('sessions.sess-7', JSON.stringify(bind.sessions?.['sess-7'] || null))}`);
  chk(it, '绑定文件里没有 key 明文', !JSON.stringify(bind).includes('stub-k-'), kv('含 stub-k-', String(JSON.stringify(bind).includes('stub-k-'))));
  art(it, `${SESSIONS_PATH} sessions.sess-7={provider:${bind.sessions?.['sess-7']?.provider}, model:${bind.sessions?.['sess-7']?.model}}`);

  const other = await runChild({ mode: 'effective', sessionKey: 'sess-7-other' });
  chk(it, '别的会话不受影响 (读到的仍是全局 deepseek/stubB-1, source=global)',
    other.out?.effective?.provider === 'deepseek' && other.out?.effective?.source === 'global',
    `${kv('sess-7-other', `${other.out?.effective?.provider}/${other.out?.effective?.model}`)} ${kv('source', String(other.out?.effective?.source))}`);

  const routed = await runChild({ mode: 'call', label: 'sess-7', sessionKey: 'sess-7' });
  chk(it, '这个会话真打请求命中 A (会话级切换真的路由了, 不只是写了个文件)',
    String(routed.out?.reply || '').startsWith('pong:A:'), kv('reply', String(routed.out?.reply)));

  const conflict = await runChild({ mode: 'select', target: { provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'session', sessionKey: 'sess-7' } });
  chk(it, '会话级切换里带凭证 → 被拒 (credential_scope_conflict; 凭证只属于全局)',
    conflict.out?.ok === false && conflict.out?.failureClass === 'credential_scope_conflict',
    `${kv('failureClass', String(conflict.out?.failureClass))} · ${short(conflict.out?.message || '', 140)}`);

  // 反事实: 同一个选择用 scope=global 必须真改字节 (证明"没变"不是空的)
  const asGlobal = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  const shaAfterGlobal = shaOf(CONFIG_PATH);
  cf(it,
    '反事实对照 (把作用域拿掉 = 旧行为): 同一个选择改用 scope=global',
    '全局字节**必须变** (若同样不变, 说明"会话级不改全局"这条断言是空的 —— 无论选什么字节都不动)',
    `scope=global 切换 ok=${asGlobal.ok}, sha ${cfgSha} → ${shaAfterGlobal} (${cfgSha === shaAfterGlobal ? '没变 ⇒ 空断言' : '变了 ⇒ 有判别力'})`,
    asGlobal.ok === true && shaAfterGlobal !== cfgSha);

  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
}

// ============================================================
// 第 8 条: Global 切换影响新 Session
// ============================================================

async function item08(A: Stub, MS: any, runChild: any): Promise<void> {
  const it = startItem(8, 'Global 切换影响新 Session',
    '把全局切到 openai/stubA-2@A → 起一个**全新会话键**读有效配置 (必须跟着变) → 再用真请求确认路由; '
    + '同时对照"已有绑定的老会话" (不该被带走)。');

  const sel = await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  chk(it, 'Global 切到 openai/stubA-2 成功', sel.ok === true, short(sel.message || ''));

  const fresh = await runChild({ mode: 'effective', sessionKey: 'sess-8-brand-new' });
  chk(it, '全新会话读到新的全局默认 (source=global)',
    fresh.out?.effective?.provider === 'openai' && fresh.out?.effective?.model === 'stubA-2' && fresh.out?.effective?.source === 'global',
    `${kv('fresh', `${fresh.out?.effective?.provider}/${fresh.out?.effective?.model}`)} ${kv('source', String(fresh.out?.effective?.source))}`);

  const routed = await runChild({ mode: 'call', label: 'sess-8-new', sessionKey: 'sess-8-brand-new' });
  const hit = A.hits.filter((h) => h.path.endsWith('/chat/completions')).at(-1);
  chk(it, '新会话真打请求: 命中 A 且请求体里的 model 是新模型 stubA-2',
    String(routed.out?.reply || '').startsWith('pong:A:stubA-2') && hit?.model === 'stubA-2',
    `${kv('reply', String(routed.out?.reply))} ${kv('A 最新一笔 model', String(hit?.model))}`);

  // 反事实: 有绑定的老会话不该被 Global 带走 (否则"影响新会话"就退化成"影响所有会话")
  const bound = await runChild({ mode: 'effective', sessionKey: 'sess-7' });
  cf(it,
    '反事实对照 (这条会不会是"影响所有会话"): 第 7 条留下的老会话 sess-7 (绑着 openai/stubA-1) 再读一次',
    '老会话仍读它自己的绑定 (source=session, model=stubA-1 ≠ 新的 stubA-2) —— 证明 Global 只影响**新**会话',
    `${kv('sess-7', `${bound.out?.effective?.provider}/${bound.out?.effective?.model}`)} ${kv('source', String(bound.out?.effective?.source))} (新全局是 openai/stubA-2)`,
    bound.out?.effective?.model === 'stubA-1' && bound.out?.effective?.source === 'session');

  art(it, `${CONFIG_PATH} activeProvider=${activeProvider()} providers.openai.model=${rowModel('openai')}`);
}

// ============================================================
// 第 9 条: 长任务中途切默认模型 → 旧 Run 保留原配置快照
// ============================================================

const run1 = { id: '' };

async function item09(A: Stub, B: Stub, MS: any, RS: any, GS: any, realCall: any): Promise<void> {
  const it = startItem(9, '长任务中途切默认模型 → 旧 Run 保留原配置快照',
    '全局定在 deepseek/stubB-1@B → 取一份 Run 快照 → 真 `startRun` 建 Run (盘上记录) → 执行中把全局切到 openai/stubA-1@A → '
    + '从**盘上**重读 Run 记录逐字段对照; 并用 `detectRunConfigDrift` 反向核一次 (它必须**看得出**已经漂了, 否则"快照没变"可能只是没人能分辨)。');

  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  const snap1 = await MS.captureRunModelConfig();
  const goal = await GS.createGoal({ objective: 'P8 验收: 长任务中途换默认模型', channelId: 'ch-p8', createdBy: 'verify-model-acceptance' });
  const run = await RS.startRun({ surface: 'cli', goalId: goal.goalId, goal: goal.objective, modelConfig: snap1 });
  run1.id = run.runId;
  chk(it, 'Run 建好且带快照 (盘上记录)', run.modelConfig?.provider === 'deepseek' && run.modelConfig?.model === 'stubB-1',
    `${kv('runId', run.runId)} ${kv('snapshot', JSON.stringify(run.modelConfig))}`);

  const midSwitch = await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '执行中把全局切到 openai/stubA-1 成功 (且 hash 与快照不同)', midSwitch.ok === true && midSwitch.effective?.configHash !== snap1.configHash,
    `${kv('new hash', String(midSwitch.effective?.configHash))} ${kv('snapshot hash', snap1.configHash)}`);

  const back = await RS.readRun(run.runId);
  const diff = ['provider', 'model', 'baseUrl', 'configHash', 'selectionScope']
    .filter((f) => JSON.stringify(back?.modelConfig?.[f]) !== JSON.stringify(snap1[f]));
  chk(it, '盘上这条 Run 的快照**逐字段没变** (provider/model/baseUrl/configHash/selectionScope)', diff.length === 0,
    diff.length ? `漂了: ${diff.join(',')}` : `${kv('盘上快照', JSON.stringify(back?.modelConfig))}`);
  art(it, `${path.join(HOME, '.bolloon', 'runs', `${run.runId}.json`)} → modelConfig=${JSON.stringify(back?.modelConfig)}`);
  art(it, `${path.join(HOME, '.bolloon', 'goals', `${goal.goalId}.json`)}`);

  const drift = await MS.detectRunConfigDrift(run.runId);
  chk(it, '反向校验看得出"现在已漂": detectRunConfigDrift.drifted=true 且点名了变化的字段',
    drift?.verified === true && drift?.drifted === true && Array.isArray(drift?.fields) && drift.fields.length > 0,
    `${short(drift?.message || '', 220)}`);
  chk(it, '漂移报告说的是"快照 B / 现在 A"这两个具体值', drift?.fields.some((f: any) => f.field === 'model' && f.snapshot === 'stubB-1' && f.current === 'stubA-1'),
    JSON.stringify((drift?.fields || []).map((f: any) => `${f.field}:${f.snapshot}→${f.current}`)));

  const cur = await MS.effectiveModelConfig({});
  chk(it, '当前有效配置是新的 (openai/stubA-1) —— 与 Run 快照并存, 两者各自可用',
    cur.provider === 'openai' && cur.model === 'stubA-1' && back?.modelConfig?.provider === 'deepseek',
    `${kv('当前生效', `${cur.provider}/${cur.model}`)} ${kv('Run 快照', `${back?.modelConfig?.provider}/${back?.modelConfig?.model}`)}`);

  cf(it,
    '反事实对照 (快照如果被"现读默认"顶掉会怎样): 同一时刻重解析一次有效配置, 与 Run 快照并排看',
    '重解析拿到的是**新**模型 (openai/stubA-1), 而 Run 快照仍是 deepseek/stubB-1 —— 两者不同; 若实现改成"读 Run 时现解析", 它就会等于新模型 (即漂移)',
    `重解析=${cur.provider}/${cur.model} (hash=${cur.configHash}) · Run 快照=${back?.modelConfig?.provider}/${back?.modelConfig?.model} (hash=${back?.modelConfig?.configHash})`,
    cur.configHash !== back?.modelConfig?.configHash && back?.modelConfig?.model === 'stubB-1');

  // 真跑一次: 当前配置确实换了, 旧端点不再被默认使用
  const routed = await realCall('after-mid-switch');
  chk(it, '切完之后真请求命中新端点 A (默认确实换了)', String(routed.reply || '').startsWith('pong:A:stubA-1'), kv('reply', String(routed.reply)));
}

// ============================================================
// 第 10 条: 下一 Run 用新模型
// ============================================================

async function item10(A: Stub, MS: any, MP: any, RS: any, GS: any): Promise<void> {
  const it = startItem(10, '下一个 Run 使用新模型',
    '拿第 9 条那条 Run 当下一条的"上一条 Run", 走 P7 的唯一决定函数 `resolveNextRunModel` (Goal 没写策略 → 默认 auto) → '
    + '按它的 `startRunModelConfig` 真 `startRun`, 再从盘上读新 Run 的快照。');

  if (!run1.id) { chk(it, '依赖第 9 条的 Run (未跑第 9 条)', false, '第 9 条没跑 → 这条无法独立验证'); return; }

  const next = await MP.resolveNextRunModel({ prevRunId: run1.id, goalId: (await RS.readRun(run1.id))?.goalId });
  chk(it, '决定函数给出"用最新 Global" (source=global, 新模型=stubA-1)',
    next.decision.source === 'global' && next.decision.config?.provider === 'openai' && next.decision.config?.model === 'stubA-1',
    MP.formatModelDecision(next.decision));
  chk(it, '承认"换了" (新 configHash ≠ 上一条 Run 的快照 hash)',
    next.decision.switched === true && next.decision.config?.configHash !== (await RS.readRun(run1.id))?.modelConfig?.configHash,
    `${kv('new hash', String(next.decision.config?.configHash))} ${kv('prev hash', String((await RS.readRun(run1.id))?.modelConfig?.configHash))}`);

  const run2 = await RS.startRun({ surface: 'cli', goalId: (await RS.readRun(run1.id))?.goalId, goal: 'P8 验收: 下一个 Run', modelConfig: next.startRunModelConfig });
  const run2Back = await RS.readRun(run2.runId);
  const run1Back = await RS.readRun(run1.id);
  chk(it, '新 Run 的盘上快照就是新模型 (openai/stubA-1)', run2Back?.modelConfig?.model === 'stubA-1' && run2Back?.modelConfig?.provider === 'openai',
    `${kv('runId', run2.runId)} ${kv('新 Run 快照', JSON.stringify(run2Back?.modelConfig))}`);
  chk(it, '两条 Run 的快照不同 (旧 Run 一个字节没被改写)', run1Back?.modelConfig?.configHash === (await RS.readRun(run1.id))?.modelConfig?.configHash
    && run2Back?.modelConfig?.configHash !== run1Back?.modelConfig?.configHash,
    `${kv('run1', String(run1Back?.modelConfig?.model))} hash=${String(run1Back?.modelConfig?.configHash)} · ${kv('run2', String(run2Back?.modelConfig?.model))} hash=${String(run2Back?.modelConfig?.configHash)}`);
  art(it, `${path.join(HOME, '.bolloon', 'runs', `${run2.runId}.json`)} → modelConfig=${JSON.stringify(run2Back?.modelConfig)}`);

  cf(it,
    '反事实对照 (新 Run 会不会"继承"旧配置): 同一时刻并排读新旧两条 Run 的快照',
    '新 Run = 新模型, 旧 Run = 旧模型; 若两条相同, 说明"下一 Run 用新模型"没发生 (或旧 Run 被改写)',
    `run1=${run1Back?.modelConfig?.provider}/${run1Back?.modelConfig?.model} (hash=${run1Back?.modelConfig?.configHash}) vs run2=${run2Back?.modelConfig?.provider}/${run2Back?.modelConfig?.model} (hash=${run2Back?.modelConfig?.configHash})`,
    run1Back?.modelConfig?.model === 'stubB-1' && run2Back?.modelConfig?.model === 'stubA-1');
  void A; void MS; void GS;
}

// ============================================================
// 第 11 条: Supervisor 恢复时继续用正确的 Run/Goal 模型策略
// ============================================================

async function item11(A: Stub, B: Stub, MS: any, MP: any, RS: any, GS: any, runChild: any): Promise<void> {
  const it = startItem(11, 'Supervisor 恢复时继续用正确的 Run/Goal 模型策略',
    '① 起**真 ExecutionSupervisor** 的 `tickOnce` (执行器注入 —— 它不出网, 但调度/决策/Run 装配全是真路径), '
    + '目标上写 `pinned` 策略固定 B; 断言交给执行器的 `req.modelConfig` 是**固定的那一份**(不是刚切的全局 A), 且 `kind=resume`。'
    + '② `session` 策略无绑定 → 冻在上一条 Run 的快照。'
    + '③ **恢复时真装配**: 另起进程按 Run 快照装配运行时 (真 `applyRunModelConfigToRuntime`) 再真打请求 —— 必须命中快照那台 B。');

  // 全局先切到 A: 这样"恢复时用 B"才有判别性
  await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });
  const snapB = MS.runModelConfigOf
    ? MS.runModelConfigOf({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, protocol: 'openai-compatible', authRef: 'provider:deepseek', reasoning: false, reasoningMode: 'unset', temperature: null, scope: 'global', source: 'global', updatedAt: new Date().toISOString(), configHash: MS.configHashOf({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl }) })
    : null;

  const pinGoal = await GS.createGoal({ objective: 'P8 验收: Supervisor pinned 恢复', channelId: 'ch-p8-sup', createdBy: 'verify-model-acceptance' });
  await MP.writeGoalModelPolicy(pinGoal.goalId, { mode: 'pinned', pin: { provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl } }, { updatedBy: 'verify-model-acceptance' });
  const pinRun = await RS.startRun({ surface: 'cli', goalId: pinGoal.goalId, goal: pinGoal.objective, modelConfig: snapB });
  // 把 Run 挂到 Goal 的 currentRunId 上 (Supervisor 的 runGoal 就是从 goal.currentRunId 取"上一条 Run");
  // 再给这条 Run 一条**可核验进展** —— 飞轮接线 (冻结门 goal-flywheel-wiring-freeze) 的规则是
  // "本轮有新证据才有继续的资格", 没有证据的运行会被飞轮判 needs_decision、不自动唤醒。
  // 这一步只是为了让它"有资格被唤醒", 与模型策略无关 (策略断言在第 3/4 条断言里)。
  await RS.addRunEvidence(pinRun.runId, ['P8 验收: 假上游已响应 (给飞轮一条可核验进展)']);
  await RS.recordStep(pinRun.runId, { tool: 'stub-probe', ok: true, summary: 'P8 验收: 假上游 /models 已回目录' });
  await GS.attachRun(pinGoal.goalId, pinRun.runId);
  const stalled = await RS.setRunStatus(pinRun.runId, 'stalled', { summary: 'P8 验收: 模拟失速, 待 Supervisor 恢复' });
  chk(it, '建好一条可恢复的 Run (running → stalled, 盘上状态=stalled)', stalled.ok === true && (await RS.readRun(pinRun.runId))?.status === 'stalled',
    `${kv('runId', pinRun.runId)} ${kv('status', String((await RS.readRun(pinRun.runId))?.status))} ${kv('goal.currentRunId', String((await GS.readGoal(pinGoal.goalId))?.currentRunId))}`);

  const { ExecutionSupervisor } = await import('../src/agents/execution-supervisor.js');
  const captured: any[] = [];
  const sup = new ExecutionSupervisor({
    owner: `p8-acceptance:${process.pid}`,
    maxPerTick: 8,
    runner: async (req: any) => { captured.push({ goalId: req.goal?.goalId, kind: req.kind, prevRunId: req.prevRunId, modelConfig: req.modelConfig }); return { status: 'blocked', reply: 'P8 验收: 注入执行器 (不出网)' }; },
    log: () => undefined,
  });
  const tick = await sup.tickOnce();
  const mine = captured.find((c) => c.goalId === pinGoal.goalId);
  chk(it, 'Supervisor `tickOnce` 真跑了 (真调度路径) 且轮到了这条 Goal', !!mine,
    `${kv('tick', String(tick.tick))} ${kv('executed', JSON.stringify(tick.executed.map((e) => e.goalId)))} ${kv('captured', String(captured.length))}`);
  chk(it, '`kind=resume` (上一条 Run 是可恢复态, 走的是恢复而不是新开一条)', mine?.kind === 'resume', `${kv('kind', String(mine?.kind))} ${kv('prevRunId', String(mine?.prevRunId))}`);
  chk(it, '**交给执行器的模型 = pinned 固定的那一份** (deepseek/stubB-1@B, 不是刚切的全局 openai/stubA-1)',
    mine?.modelConfig?.provider === 'deepseek' && mine?.modelConfig?.model === 'stubB-1' && mine?.modelConfig?.baseUrl === B.baseUrl
    && mine?.modelConfig?.configHash !== (await MS.effectiveModelConfig({})).configHash,
    `${kv('req.modelConfig', JSON.stringify(mine?.modelConfig))} · 此刻全局=${(await MS.effectiveModelConfig({})).provider}/${(await MS.effectiveModelConfig({})).model}`);
  art(it, `${path.join(HOME, '.bolloon', 'goals', `${pinGoal.goalId}.json`)} (modelPolicy=pinned) + ${path.join(HOME, '.bolloon', 'runs', `${pinRun.runId}.json`)}`);

  // ② session 策略无绑定 → 冻在上一条 Run 的快照
  const sGoal = await GS.createGoal({ objective: 'P8 验收: Supervisor session 策略', channelId: 'ch-p8-sup', createdBy: 'verify-model-acceptance' });
  await MP.writeGoalModelPolicy(sGoal.goalId, { mode: 'session' }, { updatedBy: 'verify-model-acceptance' });
  const sRun = await RS.startRun({ surface: 'cli', goalId: sGoal.goalId, goal: sGoal.objective, sessionKey: 'sess-11', modelConfig: snapB });
  const sNext = await MP.resolveNextRunModel({ prevRunId: sRun.runId, goalId: sGoal.goalId, sessionKey: 'sess-11-none' });
  chk(it, 'session 策略且无会话绑定 → 沿用上一条 Run 的快照并标冻结 (不被新全局带走)',
    sNext.decision.config?.model === 'stubB-1' && sNext.decision.frozen === true,
    MP.formatModelDecision(sNext.decision));

  // ③ 恢复时真装配 + 真请求
  const resumed = await runChild({ mode: 'install-run', runId: pinRun.runId, label: 'resume' });
  chk(it, '按 Run 快照装配运行时: 装进去的那一份与快照逐字相同 (provider/model/baseUrl/configHash)',
    resumed.out?.applied?.provider === 'deepseek' && resumed.out?.applied?.model === 'stubB-1'
    && resumed.out?.applied?.baseUrl === B.baseUrl && resumed.out?.applied?.configHash === resumed.out?.snapshot?.configHash,
    `${kv('applied', JSON.stringify(resumed.out?.applied))}`);
  chk(it, '恢复后真打请求**命中快照那台 B** (不是此刻的全局 A)', String(resumed.out?.reply || '').startsWith('pong:B:stubB-1'),
    kv('reply', String(resumed.out?.reply)));

  const globalArm = await runChild({ mode: 'call', label: 'global-arm' });
  cf(it,
    '反事实对照 (恢复如果按"当前全局"装配会打到哪): 同一时刻另起进程按**当前有效配置**(全局)装配再真打请求',
    '按全局装配会命中 **A** (openai/stubA-1) —— 与按快照恢复命中的 B 不同; 这条对照证明"用 Run 自己那份"不是自动成立的',
    `按全局装配 → reply=${globalArm.out?.reply}`,
    String(globalArm.out?.reply || '').startsWith('pong:A:stubA-1'));
}

// ============================================================
// 第 12 条: 两个进程同时切配置 → 不互相覆盖
// ============================================================

async function item12(A: Stub, B: Stub, C: Stub, E: Stub, MS: any, runChild: any): Promise<void> {
  const it = startItem(12, '两个进程同时切配置 → 不互相覆盖',
    '(a) 同时起**两个真进程**各切一家 (deepseek / openai), 各写各的 model, 然后读盘看两家的改动是不是都在; '
    + '(b) 一个进程持跨进程锁做 read-modify-write (中间故意停 900ms), 同时父进程再切第三家 —— 两边的改动都必须活下来。');

  // 先把两家落成一个可辨识的初值
  await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  await MS.selectModel({ provider: 'openai', model: 'stubA-1', baseUrl: A.baseUrl, apiKey: 'stub-k-a', scope: 'global' });

  // (a) 两个**真进程**在同一瞬间各切一家 (屏障发令, 不是 sleep 猜时机)
  const readyDir = path.join(TMP, 'race');
  fs.mkdirSync(readyDir, { recursive: true });
  const goPath = path.join(readyDir, 'go');
  const r1 = path.join(readyDir, 'p1.ready');
  const r2 = path.join(readyDir, 'p2.ready');
  const p1 = runChild({ mode: 'select-race', target: { provider: 'deepseek', model: 'race-b', baseUrl: B.baseUrl, apiKey: 'stub-k-b' }, readyPath: r1, goPath });
  const p2 = runChild({ mode: 'select-race', target: { provider: 'openai', model: 'race-a', baseUrl: A.baseUrl, apiKey: 'stub-k-a' }, readyPath: r2, goPath });
  const waitReady = Date.now() + 20000;
  while ((!fs.existsSync(r1) || !fs.existsSync(r2)) && Date.now() < waitReady) await new Promise((r) => setTimeout(r, 10));
  chk(it, '(a) 两个真进程都在屏障上就位 (真并发, 不是先后跑)', fs.existsSync(r1) && fs.existsSync(r2),
    `${kv('p1.ready', String(fs.existsSync(r1)))} ${kv('p2.ready', String(fs.existsSync(r2)))}`);
  fs.writeFileSync(goPath, 'go');
  const [p1r, p2r] = await Promise.all([p1, p2]);
  chk(it, '(a) 两个真进程各自切换都成功', p1r.out?.ok === true && p2r.out?.ok === true,
    `P1=${p1r.out?.ok ? 'ok' : String(p1r.out?.failureClass)} P2=${p2r.out?.ok ? 'ok' : String(p2r.out?.failureClass)}`);
  chk(it, '(a) 进程 1 的改动活着 (providers.deepseek.model=race-b)', rowModel('deepseek') === 'race-b',
    `${kv('providers.deepseek.model', rowModel('deepseek'))}`);
  chk(it, '(a) 进程 2 的改动活着 (providers.openai.model=race-a)', rowModel('openai') === 'race-a',
    `${kv('providers.openai.model', rowModel('openai'))}`);
  chk(it, '(a) activeProvider 是两位之一 (不是"第三个值"/空)',
    ['deepseek', 'openai'].includes(activeProvider()), kv('activeProvider', activeProvider()));
  art(it, `${CONFIG_PATH} → deepseek=${rowModel('deepseek')} openai=${rowModel('openai')} activeProvider=${activeProvider()}`);

  // (b) 持锁 read-modify-write (窗口 900ms) + 并发切换
  const hold = runChild({ mode: 'holdwrite', target: { provider: 'kimi', model: 'stubC-hold-1' }, holdMs: 900, lock: true });
  await new Promise((r) => setTimeout(r, 200));   // 让对方先拿到锁 (一次性错峰, 不是轮询)
  const concurrent = await MS.selectModel({ provider: 'qwen', model: 'live-m1', baseUrl: E.baseUrl, apiKey: 'stub-k-e', scope: 'global' });
  const holdRes = await hold;
  chk(it, '(b) 持锁进程完成', holdRes.out?.ok === true, `${kv('lock', String(holdRes.out?.lock))}`);
  chk(it, '(b) 持锁期间的并发切换也成功', concurrent.ok === true, short(concurrent.message || `${concurrent.effective?.provider}/${concurrent.effective?.model}`));
  chk(it, '(b) 持锁进程写的 kimi 改动活着', rowModel('kimi') === 'stubC-hold-1', kv('providers.kimi.model', rowModel('kimi')));
  chk(it, '(b) 并发的 qwen 改动没有被对方的陈旧快照覆盖', rowModel('qwen') === 'live-m1' && activeProvider() === 'qwen',
    `${kv('providers.qwen.model', rowModel('qwen'))} ${kv('activeProvider', activeProvider())}`);

  // (c) 互斥的**直接**判决 (不靠"丢没丢"这种靠调度撞运气的结果):
  //     一个真进程在临界区里停 900ms 并落下"我正持锁"的标记; 父进程在窗口里发起切换 ——
  //     它必须**等到锁释放之后**才可能写完。拿掉锁 (M4a) 时它 10ms 就写完了。
  const marker = path.join(TMP, 'lock-held.marker');
  const holdC = runChild({ mode: 'holdwrite', target: { provider: 'glm', model: 'no-tool-model' }, holdMs: 900, lock: true, markerPath: marker });
  const waitMarker = Date.now() + 20000;
  while (!fs.existsSync(marker) && Date.now() < waitMarker) await new Promise((r) => setTimeout(r, 10));
  const tAttempt = Date.now();
  const duringHold = await MS.selectModel({ provider: 'kimi', model: 'stubC-1', baseUrl: C.baseUrl, apiKey: 'stub-k-c', scope: 'global' });
  const tDone = Date.now();
  const holdCRes = await holdC;
  const heldUntil = Number(holdCRes.out?.t1 || 0);
  chk(it, '(c) 窗口真的开始了 (持锁进程已在临界区里落了标记, 父进程此刻发起切换)',
    fs.existsSync(marker) && tAttempt < heldUntil,
    `${kv('marker', String(fs.existsSync(marker)))} ${kv('父进程发起切换', `${tAttempt} < 对方释放 ${heldUntil}`)}`);
  chk(it, '(c) 并发切换**必须等到锁释放之后**才写完 (实测等待 ' + `${Math.max(0, tDone - tAttempt)}ms)` + ')',
    tDone >= heldUntil,
    `${kv('父进程写完', String(tDone))} ${kv('对方临界区结束', String(heldUntil))} ${kv('等待', `${tDone - tAttempt}ms`)} · 本次切换 ok=${duringHold.ok}`);

  cf(it,
    '反事实对照 (跨进程互斥那两条机制一起拿掉 —— 由变异脚本 `verify-model-acceptance-mutations.py` 的 M4 执行: '
    + '① `withConfigLock` 空转 (不真建锁文件) ② 配置签名恒等 (不再看文件变没变))',
    '同一份门在那两个变异下必须**判红** (两个进程各读旧配置 → 后写的把先写的整份覆盖掉)',
    '见变异脚本输出: M4 → 本门判红 (红项里包含第 12 条)',
    MUTATION_M4_RED === true);
  art(it, '反事实证据由 scripts/verify-model-acceptance-mutations.py 的 M4 提供 (输出摘录见 wiki 报告)');
}

// 变异脚本跑完后由环境变量传进来 (测试纪律: 变异脚本自己真跑本门, 这里只汇报它红没红)

// ============================================================
// 第 13 条: 旧 llm-config.json 可迁移
// ============================================================

async function item13(B: Stub, runChild: any): Promise<void> {
  const it = startItem(13, '旧 `llm-config.json` 可迁移',
    '另开一个隔离 home, **只**写一份旧文件名 `llm-config.json` (带机主当时选的 provider/model/baseUrl), 起一个全新进程读有效配置 —— '
    + '断言迁移真发生 (新文件名出现) 且内容逐字是旧文件那一份。');

  const HOME2 = path.join(TMP, 'legacy-home');
  const BH2 = path.join(HOME2, '.bolloon');
  fs.mkdirSync(BH2, { recursive: true });
  const legacy = {
    activeProvider: 'deepseek',
    providers: {
      deepseek: { enabled: true, apiKey: 'stub-k-legacy', baseUrl: B.baseUrl, model: 'legacy-model-1', requiresApiKey: false },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const legacyBytes = JSON.stringify(legacy, null, 2);
  await fsp.writeFile(path.join(BH2, 'llm-config.json'), legacyBytes, { mode: 0o600 });

  const migrated = await runProc('npx', ['tsx', CHILD, JSON.stringify({ home: HOME2, bolloonHome: BH2, mode: 'effective' })]);
  const line = String(migrated.stdout).split('\n').find((l) => l.startsWith('CHILD:')) || '';
  const out = line ? JSON.parse(line.slice('CHILD:'.length)) : null;
  const newPath = path.join(BH2, 'bolloon-config.json');
  chk(it, '迁移真发生 (新文件名 bolloon-config.json 出现, 日志里有迁移提示)',
    fs.existsSync(newPath) && /已迁移/.test(String(migrated.stdout)), `${kv('exists', String(fs.existsSync(newPath)))} ${short(String(migrated.stdout).split('\n').find((l) => l.includes('已迁移')) || '', 120)}`);
  chk(it, '迁移是**逐字节复制** (不是重编一份)', fs.existsSync(newPath) && fs.readFileSync(newPath, 'utf-8') === legacyBytes,
    `${kv('sha 旧', shaOf(path.join(BH2, 'llm-config.json')))} ${kv('sha 新', shaOf(newPath))}`);
  chk(it, '新进程读到的有效配置 = 旧文件里那一份 (deepseek/legacy-model-1@B)',
    out?.effective?.provider === 'deepseek' && out?.effective?.model === 'legacy-model-1' && out?.effective?.baseUrl === B.baseUrl,
    `${kv('effective', `${out?.effective?.provider}/${out?.effective?.model}@${out?.effective?.baseUrl}`)} ${kv('hash', String(out?.effective?.configHash))}`);
  chk(it, '迁移读回的有效配置里没有 key 明文', !JSON.stringify(out?.effective || {}).includes('stub-k-legacy'),
    kv('含明文', String(JSON.stringify(out?.effective || {}).includes('stub-k-legacy'))));
  art(it, `${newPath} (由 ${path.join(BH2, 'llm-config.json')} 迁移而来, sha256[:16]=${shaOf(newPath)})`);

  // 反事实: 同一份内容但**不叫旧文件名** (放到 .bak 上) → 迁移不发生, 读到的是内置默认
  const HOME3 = path.join(TMP, 'legacy-home-nobak');
  const BH3 = path.join(HOME3, '.bolloon');
  fs.mkdirSync(BH3, { recursive: true });
  await fsp.writeFile(path.join(BH3, 'llm-config.json.bak'), legacyBytes, { mode: 0o600 });
  const noMig = await runProc('npx', ['tsx', CHILD, JSON.stringify({ home: HOME3, bolloonHome: BH3, mode: 'effective' })]);
  const line3 = String(noMig.stdout).split('\n').find((l) => l.startsWith('CHILD:')) || '';
  const out3 = line3 ? JSON.parse(line3.slice('CHILD:'.length)) : null;
  cf(it,
    '反事实对照 (迁移到底有没有起作用): 同一份内容改名叫 `llm-config.json.bak` (不触发迁移)',
    '读到的**不是** legacy-model-1, 而是内置默认那一份 (→ 证明上面拿到的 legacy 值确实来自迁移这条链, 不是"随便读到了什么")',
    `不迁移时读到 ${out3?.effective?.provider}/${out3?.effective?.model} (source=${out3?.effective?.source})`,
    out3?.effective?.model !== 'legacy-model-1');
  void runChild;
}

// ============================================================
// 第 14 条: provider `/models` 不可用时, 缓存与手动模型仍可用
// ============================================================

async function item14(E: Stub, MS: any, MD: any): Promise<void> {
  const it = startItem(14, 'provider `/models` 不可用时, 缓存与手动模型仍可用',
    '先把 qwen 指到假上游 E (目录端点正常), 真取一次目录 + 手输一个目录里没有的模型; **然后把 E 的目录端点翻成 404** (真 404, 不是构造), '
    + '再真取一次 + 列目录: 看缓存里的模型与手输模型是不是仍在, 这家 provider 是不是还在列表里 (不许静默删)。');

  await MS.selectModel({ provider: 'qwen', model: 'live-m1', baseUrl: E.baseUrl, apiKey: 'stub-k-e', scope: 'global' });
  const refreshed = await MD.refreshModelDiscovery('qwen', { force: true });
  const liveCatalog = refreshed.results.find((c: any) => c.provider === 'qwen');
  chk(it, '目录端点正常时真取到上游清单 (origin=live, 含 live-m1)',
    liveCatalog?.models?.includes('live-m1') && refreshed.failures.length === 0,
    `${kv('origin', String(liveCatalog?.origin))} ${kv('models', String((liveCatalog?.models || []).join(',')))}`);
  const admitted = await MD.admitManualModel('qwen', 'manual-m9');
  chk(it, '手输模型记进发现缓存 (manual-m9)', admitted.ok === true, `${kv('ok', String(admitted.ok))} ${String(admitted.reason || '')}`);

  // 把目录端点翻成 404
  const prevMode = E.mode.catalog;
  E.mode.catalog = 'missing';
  try {
    const afterFail = await MD.refreshModelDiscovery('qwen', { force: true });
    const failCatalog = afterFail.results.find((c: any) => c.provider === 'qwen');
    chk(it, '目录端点 404 时: 失败被如实记下 (failures 里有 qwen + 类别)', afterFail.failures.some((f: any) => f.provider === 'qwen'),
      JSON.stringify(afterFail.failures.map((f: any) => `${f.provider}:${f.failureClass}`)));
    chk(it, '**provider 没有被静默删掉** (仍在结果里, 状态 unavailable + 原因)', !!failCatalog && failCatalog.keptDespiteFailure === true,
      `${kv('discoveryState', String(failCatalog?.discoveryState))} ${kv('keptDespiteFailure', String(failCatalog?.keptDespiteFailure))} ${kv('reason', short(failCatalog?.failureReason || '', 90))}`);
    chk(it, '**缓存里的模型仍可用** (清单里仍有 live-m1)', failCatalog?.models?.includes('live-m1'),
      `${kv('origin', String(failCatalog?.origin))} ${kv('models', String((failCatalog?.models || []).join(',')))}`);
    chk(it, '**手输的模型仍可用** (清单里仍有 manual-m9)', failCatalog?.models?.includes('manual-m9'),
      `${kv('manualModels', String(JSON.stringify(failCatalog?.manualModels || [])))}`);
    art(it, `${path.join(BOLLOON_HOME, 'model-discovery-cache.json')} (含 qwen 桶: models=${short(JSON.stringify(failCatalog?.models || []), 120)})`);

    // 端到端: 即使目录端点坏了, 这个模型仍能真跑 (切/调不依赖目录端点)
    const stillSwitch = await MS.selectModel({ provider: 'qwen', model: 'live-m1', baseUrl: E.baseUrl, apiKey: 'stub-k-e', scope: 'global', verify: false });
    chk(it, '目录端点坏掉也不影响"用它" (切到同一个模型不依赖目录端点)', stillSwitch.ok === true, short(stillSwitch.message || ''));

    // 反事实: 清掉缓存 → 上游那份就没了 (证明"仍可用"是缓存在兜)
    const cleared = await MD.clearDiscoveryCache('qwen');
    const afterClear = await MD.listModelCatalog('qwen', { force: true });
    const clearCatalog = afterClear.entries.find((c: any) => c.provider === 'qwen');
    cf(it,
      '反事实对照 (缓存到底是不是在兜): 清掉发现缓存, 上游目录端点**仍是 404**, 再列一次',
      '清缓存后 live-m1 **消失** (只剩内置目录/声明的那一份) → 证明上面"仍可用"确实是缓存在兜 (不是上游仍好着)',
      `清了 ${cleared} 条缓存 → 现在 models=${short(JSON.stringify(clearCatalog?.models || []), 140)} (origin=${clearCatalog?.origin}); provider 仍在列表=${!!clearCatalog}`,
      clearCatalog?.models?.includes('live-m1') !== true && !!clearCatalog);

    // 手动模型在"缓存被清 + 上游 404"下仍能重新记进去 (手输这条路的独立性)
    const manualAgain = await MD.admitManualModel('qwen', 'manual-m9');
    const afterManual = await MD.listModelCatalog('qwen', { force: true });
    const manualCatalog = afterManual.entries.find((c: any) => c.provider === 'qwen');
    chk(it, '缓存被清干净 + 上游 404 时, 手输模型仍能再记进去并出现在清单里',
      manualAgain.ok === true && manualCatalog?.models?.includes('manual-m9'),
      `${kv('admit.ok', String(manualAgain.ok))} ${kv('models', short(JSON.stringify(manualCatalog?.models || []), 120))}`);
  } finally {
    E.mode.catalog = prevMode;
  }
}

// ============================================================
// 第 15 条: 不支持 tool calling 的模型被拒用于 Agent 执行
// ============================================================

async function item15(D: Stub, MS: any, realCall: any, runChild: any): Promise<void> {
  const it = startItem(15, '不支持 tool calling 的模型**被拒**于 Agent 执行',
    '假上游 D 对"带工具声明的请求"回 400 (明确说不支持 tools) —— 走统一入口切到 glm/no-tool-model@D: 必须被拒且类别是 `tool_call_unsupported`; '
    + '再查注册表: 未声明工具调用能力的自定义供应商不得作为长期任务执行器, 且不会被挑成 Supervisor 备用候选。');

  const before = shaOf(CONFIG_PATH);
  const sel = await MS.selectModel({ provider: 'glm', model: 'no-tool-model', baseUrl: D.baseUrl, apiKey: 'stub-k-d', scope: 'global' });
  chk(it, '切到"拒绝工具声明"的模型被拒 (failureClass=tool_call_unsupported)',
    sel.ok === false && sel.failureClass === 'tool_call_unsupported', `${kv('failureClass', String(sel.failureClass))} · ${short(sel.message || '', 200)}`);
  chk(it, '被拒后盘上配置字节未变 (没留下半成功状态)', shaOf(CONFIG_PATH) === before, `${kv('config sha', `${before} → ${shaOf(CONFIG_PATH)}`)}`);
  const checks = (sel.checks || []).join(' | ');
  chk(it, '探测的逐步事实里真出现 tool_call 那一步的否证', /tool_call/i.test(checks), short(checks, 320));
  art(it, `探测事实: ${short(checks, 300)}`);
  void realCall; void runChild;

  // 注册表侧: 未声明工具调用能力的自定义供应商不得当长期任务执行器
  const REG: any = await import('../src/llm/provider-registry.js');
  const noTool = REG.getProviderRegistryEntry('notoolgw');
  const toolGw = REG.getProviderRegistryEntry('toolgw');
  chk(it, '注册表: notoolgw (声明 toolCalling=no) → allowsLongRunningExecutor=false 且会给理由',
    noTool?.allowsLongRunningExecutor === false && !!noTool?.longRunningReason,
    `${kv('toolCalling', String(noTool?.toolCalling))} ${kv('allowsLongRunningExecutor', String(noTool?.allowsLongRunningExecutor))} ${kv('reason', short(noTool?.longRunningReason || '', 120))}`);
  chk(it, '注册表: toolgw (声明 toolCalling=yes) → allowsLongRunningExecutor=true (不是"一律拒绝")',
    toolGw?.allowsLongRunningExecutor === true, `${kv('toolCalling', String(toolGw?.toolCalling))} ${kv('reason', short(toolGw?.longRunningReason || '', 120))}`);
  chk(it, 'canServeLongRunningTasks: notoolgw=false, toolgw=true',
    REG.canServeLongRunningTasks('notoolgw') === false && REG.canServeLongRunningTasks('toolgw') === true,
    `${kv('notoolgw', String(REG.canServeLongRunningTasks('notoolgw')))} ${kv('toolgw', String(REG.canServeLongRunningTasks('toolgw')))}`);

  const cur = await MS.captureRunModelConfig();
  const cands = await MS.usableFallbackCandidates(cur);
  chk(it, 'Supervisor 备用候选里**不会**出现"不能当长期任务执行器"的那家',
    !cands.some((c: any) => c.provider === 'notoolgw'),
    `候选=${JSON.stringify(cands.map((c: any) => `${c.provider}/${c.model}`))}`);

  // 反事实: 把同一台上游的"拒绝工具声明"关掉 → 同一个切换必须成功 (证明拒的是工具调用能力, 不是"这台机器一律不成")
  D.mode.rejectTools = false;
  try {
    const selOk = await MS.selectModel({ provider: 'glm', model: 'no-tool-model', baseUrl: D.baseUrl, apiKey: 'stub-k-d', scope: 'global' });
    cf(it,
      '反事实对照 (换掉那个"不支持工具调用"的假上游行为): 同一台地址改为接受工具声明, 再切一模一样的一次',
      '这一次必须**切换成功** —— 若同样失败, 说明拒绝的原因不是工具调用能力 (这条验收就指错了对象)',
      `ok=${selOk.ok} failureClass=${selOk.failureClass ?? '(无)'} effective=${selOk.effective?.provider}/${selOk.effective?.model} config sha ${before}→${shaOf(CONFIG_PATH)}`,
      selOk.ok === true);
  } finally {
    D.mode.rejectTools = true;
  }
}

// ============================================================
// 第 16 条: 切换失败后旧模型仍可继续用
// ============================================================

async function item16(B: Stub, MS: any, realCall: any, runChild: any, getMinimax: any, initMinimax: any): Promise<void> {
  const it = startItem(16, '切换失败后旧模型仍可继续用',
    '基线 deepseek/stubB-1@B → 做一次会失败的切换 (错 model) → 断言: ① 失败后**同进程**真打请求仍命中 B; '
    + '② 另起进程也仍命中 B; ③ 盘上配置未变。反事实: 人工把运行时指到那个被拒的候选 (模拟"没有回滚"), 同一台 B 就**用不了了**。');

  const base = await MS.selectModel({ provider: 'deepseek', model: 'stubB-1', baseUrl: B.baseUrl, apiKey: 'stub-k-b', scope: 'global' });
  chk(it, '基线 deepseek/stubB-1@B', base.ok === true, short(base.message || ''));
  const cfgBefore = shaOf(CONFIG_PATH);

  const bad = await MS.selectModel({ provider: 'openai', model: 'no-such-model-xyz', baseUrl: (A_BASE as string), apiKey: 'stub-k-a', scope: 'global' });
  chk(it, '一次会失败的切换: 错 model 被拒 (model_not_found)', bad.ok === false && bad.failureClass === 'model_not_found',
    `${kv('failureClass', String(bad.failureClass))} · ${short(bad.message || '', 170)}`);
  chk(it, '失败信息明确说"旧配置仍生效" (不是一个含糊的"失败")', /仍生效|保持原样|旧配置/.test(String(bad.message || '')), short(bad.message || '', 200));

  const inProc = await realCall('after-fail-16');
  chk(it, '① 失败后**同进程**真打请求仍命中 B (运行时回滚了, 不是指向被拒候选)', String(inProc.reply || '').startsWith('pong:B:stubB-1'), kv('reply', String(inProc.reply)));
  const other = await runChild({ mode: 'call', label: 'after-fail-16-child' });
  chk(it, '② 另起进程也仍命中 B', String(other.out?.reply || '').startsWith('pong:B:stubB-1'), kv('reply', String(other.out?.reply)));
  chk(it, '③ 盘上配置未变 + 有效配置仍是旧的那一份',
    shaOf(CONFIG_PATH) === cfgBefore && (await MS.effectiveModelConfig({})).model === 'stubB-1',
    `${kv('config sha', `${cfgBefore} → ${shaOf(CONFIG_PATH)}`)} ${kv('有效模型', (await MS.effectiveModelConfig({})).model)}`);

  // 失败之后旧模型在**新进程**里也照常可用 (真打一次)
  const stillWorks = await runChild({ mode: 'call', label: 'after-failure' });
  chk(it, '失败之后旧模型在**另一个进程**里照样真打请求命中 B (不是只有本进程还活着)',
    String(stillWorks.out?.reply || '').startsWith('pong:B:stubB-1'), kv('reply', String(stillWorks.out?.reply)));

  // 反事实: 如果没有回滚 (运行时仍指着被拒的候选), 旧模型就用不了了
  initMinimax({ provider: 'openai' as any, providerId: 'openai', apiKey: 'stub-k-a', baseUrl: 'http://127.0.0.1:9/v1', model: 'no-such-model-xyz' });
  const poisonedCall = await realCall('poisoned');
  const restored = await MS.applyEffectiveToRuntime();
  const restoredCall = await realCall('restored');
  cf(it,
    '反事实对照 (没有回滚会怎样): 手工把运行时指到那个被拒的候选 (死端口 + 不存在的模型), 模拟"失败但没回滚"的半成功态',
    '此时真打请求会**失败** (用不了); 再按有效配置装回去 → 又能命中 B。于是"失败后旧模型仍可用"不是自动成立的, 是回滚换来的',
    `半成功态: ${poisonedCall.reply ? `reply=${poisonedCall.reply}` : `error=${poisonedCall.error}`} · 装回有效配置后: reply=${restoredCall.reply ?? restoredCall.error} (applied=${restored.provider}/${restored.model})`,
    !String(poisonedCall.reply || '').startsWith('pong:') && String(restoredCall.reply || '').startsWith('pong:B:stubB-1'));
  void runChild;
  void B;
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
