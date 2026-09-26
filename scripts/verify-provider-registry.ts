/**
 * verify-provider-registry.ts — 「供应商注册表 + 兼容协议 + 自定义供应商」真跑验收 (P3, 2026-09-26)
 *
 * 真跑的含义: 本地起**真 HTTP 服务器**扮演一个 openai 兼容的模型服务; 自定义供应商通过真实配置
 * 读写路径落盘; 跨进程用**真子进程** (`npx tsx -e`) 读回; 协议映射后的模型调用**真的打到**那台
 * 服务器 (请求体里的 model / 认证头都被服务器记下来核对)。
 *
 * 覆盖:
 *   R1 注册表内容: 优先保障清单在册 · 九项能力字段项项有出处 · 与既有真表逐项相等
 *   R2 源码级门: 工具调用能力 = 客户端路由表里发得出原生 tools 的分支 (双向相等)
 *   R3 兼容协议: 认证头/目录端点/运行期 provider 映射 (真 fetch 到真服务器)
 *   R4 自定义供应商真跑: 落盘 → 新进程读回 → 注册表认得 → **真调用打到自定义 baseUrl**
 *   R5 元数据填充点: 只 import config-store 的新进程里已接线; 撤掉 → 回到"未知"
 *   R6 长期任务执行器门: 有真结论才允许, 拒绝必须给理由
 *   R7 向后兼容: 旧配置 (无 customProviders) 字节不变; 旧 llm-config.json 里的自定义默认**不被改掉**
 *   R8 凭据: 全程打印/快照/磁盘报告里没有 key 明文
 *
 * 用法: npx tsx scripts/verify-provider-registry.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-provider-registry-verify-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_SESSION_KEY;

const ROOT = process.cwd();
const SECRET = 'sk-stub-gw-please-never-print-7742';

let passed = 0;
let failed = 0;
const failures: string[] = [];
/** 所有打印过的行 —— 最后统一核对"里面没有 key 明文" */
const printed: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  const line = `  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`;
  printed.push(line);
  if (cond) { passed++; console.log(line); }
  else { failed++; failures.push(name); console.log(line); }
}
function section(t: string): void {
  const line = `\n[${t}]`;
  printed.push(line);
  console.log(line);
}
function sha(file: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch { return 'missing'; }
}
function readBytes(file: string): string {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}
/** 尾号显示 (凭据只许这样出现在输出里) */
function tail(s: string): string {
  return `****${String(s).slice(-4)}`;
}

// ── 本地假模型服务 ─────────────────────────────────────────────

interface Stub {
  port: number;
  hits: Array<{ method: string; url: string; model: string; auth: string; token: string }>;
  close: () => Promise<void>;
}

function startStub(opts: { expectedKey: string }): Promise<Stub> {
  const hits: Stub['hits'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      const auth = String(req.headers.authorization || '');
      const token = String(req.headers['x-token'] || '');
      let model = '';
      try { model = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}').model || ''; } catch { /* 记空串 */ }
      hits.push({ method: req.method || '', url, model, auth, token });
      if (auth !== `Bearer ${opts.expectedKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad or missing api key' } }));
        return;
      }
      if (url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-gw-model-1' }, { id: 'stub-gw-model-2' }] }));
        return;
      }
      if (url === '/v1/chat/completions' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion',
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
        port, hits,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}

/** 真子进程: 只 import config-store (+ 注册表/目录) 后打印一行 JSON */
function childJson(home: string, body: string): any {
  const script = `(async () => {${body}})();`;
  const r = spawnSync('npx', ['tsx', '-e', script], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, BOLLOON_HOME: home, HOME: home, USERPROFILE: home },
    timeout: 120_000,
  });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
  if (!line) throw new Error(`子进程没输出 (exit=${r.status}): ${String(r.stderr || '').slice(-300)}`);
  return JSON.parse(line.slice('CHILD:'.length));
}

async function main(): Promise<void> {
  const PR: any = await import('../src/llm/provider-registry.js');
  const MC: any = await import('../src/llm/model-catalog.js');
  const CS: any = await import('../src/llm/config-store.js');
  const MS: any = await import('../src/llm/model-selection.js');
  const STORE: any = await import('../src/llm/custom-provider-store.js');
  const { initMinimax, getMinimax } = await import('../src/constraints/index.js');

  const CFG = path.join(HOME, 'bolloon-config.json');
  const LEGACY = path.join(HOME, 'llm-config.json');

  const stub = await startStub({ expectedKey: SECRET });
  const baseUrl = `http://127.0.0.1:${stub.port}/v1`;

  try {
    // ────────────────────────────────────────────────────────
    section('R1 注册表内容: 优先清单 + 九项字段项项有出处 + 与既有真表相等');

    const mustHave = ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax', 'kimi', 'qwen', 'glm', 'openrouter', 'ollama', 'grok'];
    ok('计划点名的十一家全在册', mustHave.every((id) => PR.getProviderRegistryEntry(id)?.kind === 'builtin'),
      `${PR.listProviderRegistry().length} 家在册`);
    ok('在册内置 = 既有内置表 (13 家, 一个不多不少)',
      PR.listBuiltinProviderIds().sort().join(',') === Object.keys(CS.DEFAULT_PROVIDER_CONFIGS).sort().join(','));

    let missingProvenance: string[] = [];
    for (const e of PR.listProviderRegistry()) {
      for (const f of PR.REQUIRED_REGISTRY_FIELDS) {
        const val = (e as any)[f];
        const prov = e.provenance?.[f];
        if (val === undefined || !prov) missingProvenance.push(`${e.id}.${f}`);
      }
    }
    ok(`九项能力字段 (${PR.REQUIRED_REGISTRY_FIELDS.length} 项) 每项都有值 + 有出处`,
      missingProvenance.length === 0, missingProvenance.slice(0, 3).join(', ') || '共 13 家 × 9 项');

    let mismatch: string[] = [];
    for (const id of PR.listBuiltinProviderIds()) {
      const e = PR.getProviderRegistryEntry(id);
      const def = CS.DEFAULT_PROVIDER_CONFIGS[id];
      const info = CS.PROVIDER_INFO[id];
      const same = e.defaultBaseUrl === MS.normalizeBaseUrl(def.baseUrl)
        && e.defaultModel === def.model
        && e.protocol === MS.protocolOf(id)
        && e.reasoning === (MS.supportsReasoning(id) ? 'yes' : 'unknown')
        && JSON.stringify(e.apiKeyEnvVars) === JSON.stringify(MS.envKeyNamesOf(id))
        && e.requiresApiKey === (info.requiresApiKey !== false);
      if (!same) mismatch.push(id);
    }
    ok('每家的默认 URL/默认模型/协议/reasoning/环境变量/要不要 key 都等于既有真表',
      mismatch.length === 0, mismatch.join(', ') || '13/13 一致');
    ok('本地判定是真判定: ollama/local 本地, 云端不是',
      PR.getProviderRegistryEntry('ollama').isLocal === true
      && PR.getProviderRegistryEntry('local').isLocal === true
      && PR.getProviderRegistryEntry('openai').isLocal === false);
    ok('已存在的那个冲突如实保留 (注册表说 ollama 免 key, 默认配置表说要 key)',
      PR.getProviderRegistryEntry('ollama').requiresApiKey === false
      && CS.DEFAULT_PROVIDER_CONFIGS.ollama.requiresApiKey === true);

    // ────────────────────────────────────────────────────────
    section('R2 源码级门: 工具调用能力不是编的 (对齐客户端路由表)');

    const piAi = readBytes(path.join(ROOT, 'src', 'llm', 'pi-ai.ts'));
    const start = piAi.indexOf('switch (this.provider) {');
    const end = piAi.indexOf('default:', start);
    const block = start >= 0 && end > start ? piAi.slice(start, end) : '';
    const native: string[] = [];
    let pending: string[] = [];
    for (const line of block.split('\n')) {
      const c = line.match(/^\s*case '([^']+)':\s*$/);
      if (c) { pending.push(c[1]); continue; }
      const r = line.match(/return this\.(\w+)\((.*)\);/);
      if (r) { if (r[2].includes('openaiTools')) native.push(...pending); pending = []; }
    }
    const claimed = PR.listProviderRegistry().filter((e: any) => e.toolCalling === 'yes').map((e: any) => e.id).sort();
    ok('路由表解析到了发原生 tools 的分支 (锚点没失效)', native.length > 0, native.join(', '));
    ok('注册表说"支持工具调用"的 = 路由表真发得出 tools 的 (双向相等)',
      native.slice().sort().join(',') === claimed.join(','), `路由表=${native.slice().sort().join(',')} 注册表=${claimed.join(',')}`);
    ok('反例如实登记: openrouter/anthropic/gemini/ollama 在这条运行路径上工具调用发不出去',
      ['openrouter', 'anthropic', 'gemini', 'ollama'].every((id) => PR.getProviderRegistryEntry(id).toolCalling === 'no'));

    // ────────────────────────────────────────────────────────
    section('R3 兼容协议: 认证怎么摆 + 目录端点 (真 fetch 到真服务器)');

    const eOpenai = PR.getProviderRegistryEntry('openai');
    const eOllama = PR.getProviderRegistryEntry('ollama');
    ok('openai 认证 = Authorization: Bearer', eOpenai.auth.kind === 'bearer' && eOpenai.auth.header === 'Authorization');
    ok('ollama 认证 = 不放凭据 + 目录端点是 /api/tags',
      eOllama.auth.kind === 'none' && eOllama.modelsEndpoint === 'http://localhost:11434/api/tags');
    ok('anthropic 没有可用目录端点 → manual (空串, 不编)', PR.getProviderRegistryEntry('anthropic').discovery === 'manual'
      && PR.getProviderRegistryEntry('anthropic').modelsEndpoint === '');

    const spec = {
      providerId: 'stub-gw',
      displayName: '本地假网关',
      baseUrl,
      protocol: 'openai-compatible',
      apiKey: SECRET,
      model: 'stub-gw-model-1',
      modelsEndpoint: '/models',
      authHeader: 'Authorization',
      models: ['stub-gw-model-1', 'stub-gw-model-2'],
      capabilities: { toolCalling: 'yes', contextLength: 65536 },
    };
    const add = await STORE.addCustomProvider(spec);
    ok('自定义供应商真落盘 (走真实配置写路径)', add.ok === true, add.reason || `id=${spec.providerId}`);
    const onDisk = JSON.parse(readBytes(CFG) || '{}');
    ok('盘上 customProviders 有这一格 + 协议/地址/模型都在',
      onDisk?.customProviders?.['stub-gw']?.protocol === 'openai-compatible'
      && onDisk?.customProviders?.['stub-gw']?.baseUrl === baseUrl
      && onDisk?.customProviders?.['stub-gw']?.model === 'stub-gw-model-1');
    ok('内置供应商那一格没被动 (deepseek 仍在默认表里)',
      !!onDisk?.providers?.deepseek, onDisk?.providers?.deepseek?.model);

    const entry = PR.getProviderRegistryEntry('stub-gw');
    ok('注册表认得这家 (kind=custom, 声明优先)', entry?.kind === 'custom' && entry?.displayName === '本地假网关');
    ok('目录端点: 相对路径拼在自定义 baseUrl 后', entry?.modelsEndpoint === `${baseUrl}/models`, entry?.modelsEndpoint);

    const auth = PR.authHeadersFor(entry, SECRET);
    const probe = await fetch(entry.modelsEndpoint, { headers: auth.headers });
    const probeBody: any = await probe.json().catch(() => null);
    const lastHit = stub.hits[stub.hits.length - 1];
    ok('用注册表产出的认证头真取到了目录 (200 + 2 个模型)',
      probe.status === 200 && Array.isArray(probeBody?.data) && probeBody.data.length === 2, `HTTP ${probe.status}`);
    ok('服务器收到的正是那个头 (只显示尾号)',
      lastHit.auth === `Bearer ${SECRET}`, `Authorization: Bearer ${tail(lastHit.auth.replace('Bearer ', ''))}`);

    // ────────────────────────────────────────────────────────
    section('R4 协议映射真跑: 自定义供应商的请求真打到自定义 baseUrl');

    const runtimeId = PR.runtimeProviderIdOf(entry);
    ok('协议 → 运行期分支映射: openai-compatible → openai', runtimeId === 'openai', runtimeId);
    initMinimax({ provider: runtimeId, apiKey: SECRET, baseUrl: entry.defaultBaseUrl, model: entry.defaultModel });
    const before = stub.hits.length;
    const reply = await getMinimax().chat('ping-from-custom-provider');
    const chatHit = stub.hits.slice(before).find((h) => h.url === '/v1/chat/completions');
    ok('请求真的打到自定义 baseUrl 的 /chat/completions', !!chatHit, chatHit ? `${chatHit.method} ${chatHit.url}` : '没有命中');
    ok('请求体里的 model 就是自定义供应商声明的那个', chatHit?.model === 'stub-gw-model-1', chatHit?.model);
    ok('鉴权头也真的发出去了 (服务器认了 key, 只显示尾号)', chatHit?.auth === `Bearer ${SECRET}`, tail(SECRET));
    ok('回复对得上 (不是本地编的)', String(reply?.reply || '') === 'pong:stub-gw-model-1', String(reply?.reply || '').slice(0, 60));

    // ────────────────────────────────────────────────────────
    section('R5 元数据填充点: 真接线 + 只填自己有真值的项');

    const child = childJson(HOME, `
      const cs = await import('./src/llm/config-store.js');
      const mc = await import('./src/llm/model-catalog.js');
      const pr = await import('./src/llm/provider-registry.js');
      await cs.llmConfigStore.initialize();
      const src = pr.providerRegistryMetadataSource();
      console.log('CHILD:' + JSON.stringify({
        sources: mc.listModelMetadataSources(),
        custom: src.metadataOf({ provider: 'stub-gw', model: 'stub-gw-model-1' }) || null,
        builtin: src.metadataOf({ provider: 'deepseek', model: 'deepseek-v4-flash' }) || null,
        registered: pr.getProviderRegistryEntry('stub-gw')?.kind || null,
      }));
    `);
    ok('新进程只 import config-store, 填充点就已经接线 (不靠谁记得手动注册)',
      (child.sources || []).includes('provider-registry'), (child.sources || []).join(','));
    ok('新进程里自定义供应商的能力事实 = 声明值 (origin=custom)',
      child.custom?.toolCalling === 'yes' && child.custom?.contextLength === 65536 && child.custom?.origin === 'custom',
      JSON.stringify(child.custom));
    ok('新进程里内置供应商的模型级能力**仍然是"未知"** (不拿供应商级数据装模型级)',
      child.builtin?.toolCalling === undefined && child.builtin?.reasoning === undefined && child.builtin?.requiresApiKey === true,
      JSON.stringify(child.builtin));

    // 真撤掉填充点 → 回到未知
    const realSources = MC.listModelMetadataSources();
    MC.resetModelMetadataSources();
    const afterReset = MC.listModelMetadataSources();
    PR.registerProviderRegistryMetadataSource();
    const afterBack = MC.listModelMetadataSources();
    ok('撤掉填充点 → 站点清空; 接回去 → 又只有一条 (幂等)',
      realSources.includes('provider-registry') && afterReset.length === 0
      && afterBack.filter((s: string) => s === 'provider-registry').length === 1,
      `${realSources.join(',')} → ${afterReset.length} → ${afterBack.join(',')}`);

    // ────────────────────────────────────────────────────────
    section('R6 长期任务执行器门: 有真结论才允许, 拒绝必须给理由');

    ok('有原生工具调用的内置分支允许当长期任务执行器',
      ['openai', 'deepseek', 'kimi', 'glm', 'qwen'].every((id) => PR.canServeLongRunningTasks(id) === true));
    ok('发不出工具调用的分支拒绝, 且理由点名"工具调用"',
      ['anthropic', 'gemini', 'openrouter', 'ollama'].every((id) => PR.canServeLongRunningTasks(id) === false
        && String(PR.longRunningRefusalReason(id)).includes('工具调用')),
      String(PR.longRunningRefusalReason('ollama')).slice(0, 80));
    ok('自定义供应商: 声明了 toolCalling=yes + openai-compatible → 允许',
      PR.canServeLongRunningTasks('stub-gw') === true, PR.longRunningRefusalReason('stub-gw') || 'allowed');
    const noCap = await STORE.addCustomProvider({ ...spec, providerId: 'stub-nocap', capabilities: undefined });
    ok('自定义供应商没声明工具调用能力 → 拒绝 (不拿未知当可用)',
      noCap.ok === true && PR.canServeLongRunningTasks('stub-nocap') === false
      && String(PR.longRunningRefusalReason('stub-nocap')).includes('未知'),
      String(PR.longRunningRefusalReason('stub-nocap')).slice(0, 80));

    // ────────────────────────────────────────────────────────
    section('R7 向后兼容: 旧配置原样可用 (P8 #13 在 P3 这一层)');

    // 1) 旧配置 (只有内置, 没有 customProviders 这一格) → 读一下不改盘
    const oldCfg = {
      activeProvider: 'deepseek',
      providers: { deepseek: { enabled: true, apiKey: 'k-old', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', requiresApiKey: false } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(CFG, JSON.stringify(oldCfg, null, 2), { mode: 0o600 });
    CS.llmConfigStore.invalidate();
    const shaBefore = sha(CFG);
    await CS.llmConfigStore.initialize();
    const eff = await MS.effectiveModelConfig({});
    ok('旧配置的有效模型配置 = 原来那一份 (provider/model/baseUrl)',
      eff.provider === 'deepseek' && eff.model === 'deepseek-v4-flash' && eff.baseUrl === 'https://api.deepseek.com/v1',
      `${eff.provider}/${eff.model}`);
    ok('initialize() 读一遍**不改盘** (字节不变)', sha(CFG) === shaBefore, `${shaBefore}`);
    const reloaded: any = await CS.llmConfigStore.getConfig();
    const builtinCount = PR.listBuiltinProviderIds().length;
    const presentBuiltins = PR.listBuiltinProviderIds().filter((id: string) => !!reloaded.providers[id]).length;
    ok(`内置 ${builtinCount} 家在读出来的配置里仍然齐全 (缺的用默认补齐)`, presentBuiltins === builtinCount, `${presentBuiltins}/${builtinCount}`);
    ok('旧配置里自定义那一格 = 空表 (旧配置没有这一格不会报错)', reloaded.customProviders !== undefined
      && Object.keys(reloaded.customProviders).length === 0, JSON.stringify(reloaded.customProviders));

    // 2) 旧文件名 + 自定义端点是默认模型 → 不许被静默改成 ollama
    fs.writeFileSync(LEGACY, JSON.stringify({
      activeProvider: 'my-gw',
      providers: { 'my-gw': { enabled: true, apiKey: '', baseUrl, model: 'stub-gw-model-2', requiresApiKey: false } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2), { mode: 0o600 });
    fs.rmSync(CFG, { force: true });
    CS.llmConfigStore.invalidate();
    const legacyChild = childJson(HOME, `
      const cs = await import('./src/llm/config-store.js');
      const ms = await import('./src/llm/model-selection.js');
      const st = await import('./src/llm/custom-provider-store.js');
      const pr = await import('./src/llm/provider-registry.js');
      const cfg = await cs.llmConfigStore.getConfig();
      const eff = await ms.effectiveModelConfig({});
      const loaded = await st.loadCustomProviders();
      console.log('CHILD:' + JSON.stringify({
        activeProvider: cfg.activeProvider,
        effective: { provider: eff.provider, model: eff.model, baseUrl: eff.baseUrl },
        absorbed: loaded.absorbed.map((a) => a.providerId),
        protocol: loaded.providers['my-gw']?.protocol || null,
        registryKind: pr.getProviderRegistryEntry('my-gw')?.kind || null,
      }));
    `);
    ok('旧 llm-config.json 里的自定义默认**没被改成 ollama** (新进程实测)', legacyChild.activeProvider === 'my-gw', legacyChild.activeProvider);
    ok('迁移后有效配置仍是那一家/那个模型/那个地址',
      legacyChild.effective?.provider === 'my-gw' && legacyChild.effective?.model === 'stub-gw-model-2' && legacyChild.effective?.baseUrl === baseUrl,
      JSON.stringify(legacyChild.effective));
    ok('旧写法被**吸收**进注册表 (协议按 base URL 主机名推)', legacyChild.registryKind === 'custom'
      && legacyChild.absorbed?.includes('my-gw'), `absorbed=${(legacyChild.absorbed || []).join(',')} protocol=${legacyChild.protocol}`);
    ok('旧文件被迁移进新文件名', fs.existsSync(CFG));

    // ────────────────────────────────────────────────────────
    section('R8 凭据: 全程没有明文 key');

    const dump = [
      ...printed,
      JSON.stringify(PR.listProviderRegistry()),
      JSON.stringify(await STORE.redactCustomProviders({ 'stub-gw': spec })),
      await STORE.customProvidersFileSnippet(),
      STORE.formatCustomProviderLine(spec),
    ].join('\n');
    ok('打印/注册表条目/脱敏导出里没有 key 明文',
      !dump.includes(SECRET), `检查了 ${printed.length} 行输出 + 注册表 + 脱敏副本`);
    ok('脱敏导出把凭据写成 [REDACTED]', JSON.stringify(await STORE.redactCustomProviders({ 'stub-gw': spec })).includes('[REDACTED]'));
    ok('注册表条目里根本没有 apiKey 这个字段 (凭据不进注册表)',
      !Object.prototype.hasOwnProperty.call(entry, 'apiKey'));
    ok('配置文件权限 0600', (fs.statSync(CFG).mode & 0o777) === 0o600);

  } finally {
    await stub.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`verify-provider-registry: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
  if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
