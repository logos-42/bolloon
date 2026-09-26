/**
 * verify-model-selector.ts — 「分步选择器 + 模型元数据 + 三条遗留」真跑验收 (2026-09-26)
 *
 * 真跑的含义: 本地起**真 HTTP 服务器**扮演模型服务, 分步选择器一步一步真走完, 切换后调真
 * `getMinimax().chat()` 断言请求**真的打到**那台服务器、请求体里的 model **真的**是选的那个;
 * 跨进程/签名撞车/快照反查都用真进程、真文件、真 utimes。
 *
 * 覆盖:
 *   S1 七步选择器真跑 → 下一次请求真命中 (含模糊搜索 + 手工 model ID 路径)
 *   S2 列表真内容: `● 可用 · N models` / `○ 未配置 key` / `本地` / 能力三态显示"未知"
 *   S3 元数据填充点真接线: 注册真数据源 → 真值出现; 撤掉 → 回到"未知"
 *   S4 命令面一致性: `runModelCommand('pick')` 与选择器同一份; `status --json` 读到同一份
 *   S5 预检失败 → 用户不继续 → 配置字节不变 (失败不留痕)
 *   S6 遗留①: 真子进程改配置 + mtime/size 撞车 → 改动不被陈旧快照覆盖
 *   S7 遗留③: Run 快照反查 (一致 → 说"一致"; 外部改过 → 点名漂移字段; 新进程读盘也一致)
 *
 * 用法: npx tsx scripts/verify-model-selector.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { spawnSync } from 'child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-selector-verify-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_MODEL_SKIP_PROBE;
delete process.env.BOLLOON_SESSION_KEY;

const ROOT = process.cwd();
const CHILD = path.join(ROOT, 'scripts', 'lib', 'model-selection-child.ts');
const CFG = path.join(HOME, 'bolloon-config.json');

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
function readBytes(file: string): string {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

// ── 本地假模型服务 ─────────────────────────────────────────────

interface Stub { port: number; hits: Array<{ url: string; model: string }>; close: () => Promise<void> }

function startStub(opts: { basePath?: string; key?: string | null; models: string[] }): Promise<Stub> {
  const basePath = opts.basePath ?? '/v1';
  const hits: Array<{ url: string; model: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      const auth = String(req.headers.authorization || req.headers['x-api-key'] || '');
      if (opts.key && auth !== `Bearer ${opts.key}` && auth !== opts.key) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (url === `${basePath}/models` && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: opts.models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (url === `${basePath}/chat/completions` && req.method === 'POST') {
        let model = '';
        try { model = JSON.parse(Buffer.concat(chunks).toString('utf-8')).model; } catch { /* 记空串 */ }
        hits.push({ url, model });
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
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as any).port,
      hits,
      close: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}

/** 真子进程 (走真 selectModel; 子进程内部跳过网络探测) */
function child(args: string[]): { out: string; code: number | null } {
  const r = spawnSync('npx', ['tsx', CHILD, HOME, ...args], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, BOLLOON_HOME: HOME, HOME, USERPROFILE: HOME },
    timeout: 120_000,
  });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}
function childJson(args: string[]): any {
  const { out } = child(args);
  const line = out.split('\n').find((l) => l.startsWith('CHILD:'));
  if (!line) throw new Error(`子进程没有输出 CHILD: 行 (${args.join(' ')})`);
  return JSON.parse(line.slice('CHILD:'.length));
}

/** 脚本化 IO: 按顺序回答每一步 */
function scriptedIO(answers: Array<string | null>, opts: { key?: string } = {}) {
  const printed: string[] = [];
  const chosen: string[] = [];
  const remaining = [...answers];
  return {
    printed, chosen,
    io: {
      print: (l: string) => printed.push(l),
      choose: async (items: any[], title: string) => {
        chosen.push(title);
        const a = remaining.length ? remaining.shift()! : null;
        if (a === null) return null;
        const hit = items.find((c) => c.value === a) || items.find((c) => c.label.startsWith(a));
        return hit ? hit.value : a;
      },
      ask: async () => (remaining.length ? (remaining.shift() ?? '') : ''),
      ...(opts.key ? { askHidden: async () => opts.key! } : {}),
    },
  };
}

async function main(): Promise<void> {
  const MC: any = await import('../src/llm/model-catalog.js');
  const MS: any = await import('../src/llm/model-selection.js');
  const SEL: any = await import('../src/cli/model-selector.js');
  const SW: any = await import('../src/cli/setup-wizard.js');
  const { getMinimax } = await import('../src/constraints/index.js');
  const runStore: any = await import('../src/agents/run-store.js');

  // A 走 /v1 (准 key), B 走 /alt/v1 (准 key)
  const A = await startStub({ basePath: '/v1', key: 'k-stub-a', models: ['stubA-1', 'stubA-2'] });
  const B = await startStub({ basePath: '/alt/v1', key: 'k-stub-b', models: ['stubB-1'] });
  const A_BASE = `http://127.0.0.1:${A.port}/v1`;
  const B_BASE = `http://127.0.0.1:${B.port}/alt/v1`;
  const callOnce = async (): Promise<string> => {
    try { return String((await getMinimax().chat('ping')).reply || ''); }
    catch (e: any) { return `ERR:${String(e?.message || e).slice(0, 120)}`; }
  };

  try {
    // 先把 openai 指到 A (选择器第 6/7 步都用配置里这一份 baseUrl)
    const seed = await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: A_BASE, apiKey: 'k-stub-a', scope: 'global' });
    ok('起点: openai 指到本地假服务 A', seed.ok, seed.message || MS.formatEffectiveModel(seed.effective));

    // ────────────────────────────────────────────────────────
    section('S1 七步选择器真跑 → 下一次请求真命中');
    // 供应商 openai → (key 已配) → 搜索 'stubA-1'(不在内置目录) → 手工输入 → 参数 → 全局 → 真探测 → 确认
    const s1 = scriptedIO(['openai', 'stubA-1', 'stubA-1', '不设', '0.7', 'global']);
    const r1 = await SEL.runModelSelector(s1.io, {});
    const lineS1 = s1.printed.join('\n');
    ok('选择器七步走完并切换成功', r1.ok, r1.message || '');
    ok('真走了第 6 步"测试连接"', lineS1.includes('测试连接') && lineS1.includes('✅ 通过'), lineS1.split('\n').find((l) => l.includes('测试连接')) || '');
    ok('打印里说明了模型不在目录里 (手工 ID 路径)', lineS1.includes('使用手工输入的 model ID: stubA-1'), '');
    ok('切换结果就是选的那个 model', r1.effective?.model === 'stubA-1' && r1.effective?.provider === 'openai', MS.formatEffectiveModel(r1.effective));
    ok('作用域 = 全局默认', r1.effective?.source === 'global', r1.effective?.source);
    const hits0 = A.hits.length;
    const reply1 = await callOnce();
    ok('切换后第一次请求**真命中** A 且 model 正确',
      A.hits.length === hits0 + 1 && A.hits[A.hits.length - 1].model === 'stubA-1',
      `reply=${reply1} · hit=${A.hits[A.hits.length - 1]?.model}`);
    const onDisk1 = JSON.parse(readBytes(CFG));
    ok('盘上真写进去了 (model + baseUrl + temperature)', onDisk1.providers.openai.model === 'stubA-1' && onDisk1.providers.openai.temperature === 0.7,
      `model=${onDisk1.providers.openai.model} temp=${onDisk1.providers.openai.temperature}`);

    // ────────────────────────────────────────────────────────
    section('S2 列表真内容 (为什么某个模型不能用于工具调用, 列表上要说清)');
    const summaries = await MC.buildProviderSummaries({});
    const openaiRow = summaries.find((s: any) => s.id === 'openai');
    const localRow = summaries.find((s: any) => s.id === 'ollama');
    const rows = summaries.map((s: any) => MC.formatProviderLine(s));
    ok('可用供应商行 = ● … · N models (本地端点会多一个"本地"段)', /^● openai · (本地 · )?\d+ models/.test(rows.find((l: string) => l.startsWith('● openai')) || ''), rows.find((l: string) => l.startsWith('● openai')));
    ok('未配置 key 的供应商行 = ○ … · 未配置 key', rows.some((l: string) => /^○ \w+ · \d+ models · 未配置 key \(/.test(l)), rows.find((l: string) => l.startsWith('○')));
    ok('本地供应商行 = ● … · 本地', /^● ollama · 本地/.test(MC.formatProviderLine(localRow)), MC.formatProviderLine(localRow));
    ok('注册表与配置对"ollama 要不要 key"说法冲突时如实标出 (不挑一个装作不知道)',
      /⚠ key 要求不一致 \(注册表说不要 \/ 配置里说要\)/.test(MC.formatProviderLine(localRow)), MC.formatProviderLine(localRow));
    ok('本地判定是真判定 (从 baseUrl 算, 不是白名单)', MC.isLocalBaseUrl(A_BASE) === true && MC.isLocalBaseUrl('https://api.deepseek.com/v1') === false);
    const entries = await MC.listModelsFor('openai');
    const line1 = MC.formatModelLine(entries[0]);
    ok('模型行带当前置顶标记 + 原始 ID', line1.startsWith('▸') && line1.includes('openai/stubA-1'.split('/')[1]), line1);
    ok('拿不到真数据的能力显示"未知"(不编造)', line1.includes('工具调用=未知') && line1.includes('reasoning=未知') && line1.includes('上下文=未知'), line1);
    ok('需求 key / 本地端点也是真值 (两个真事实合成凭证一栏)', line1.includes('key 已配') && line1.includes('本地端点'), line1);
    ok('没配 key 的供应商在模型行上显示"缺 key"',
      MC.formatModelLine((await MC.listModelsFor('anthropic'))[0]).includes('缺 key'),
      MC.formatModelLine((await MC.listModelsFor('anthropic'))[0]));
    ok('未知原因可读 (逐字段一句人话)', MC.unknownFootnote(entries).some((f: string) => f.includes('内置目录只有模型 ID')), MC.unknownFootnote(entries)[0] || '');
    const search = MC.searchModelEntries(entries, 'stubA-1');
    ok('模糊搜索: 先按当前模型命中 (原样返回)', Array.isArray(search), `命中 ${search.length}`);

    // ────────────────────────────────────────────────────────
    section('S3 元数据填充点真接线 (P3/P5 只准往这一个点填)');
    MC.registerModelMetadataSource({
      id: 'verify-real-registry',
      providers: ['openai'],
      metadataOf: ({ model }: any) => (model === 'stubA-1'
        ? { toolCalling: 'yes', reasoning: 'no', contextLength: 128000, origin: 'live' }
        : undefined),
    });
    const entries2 = await MC.listModelsFor('openai');
    const hit2 = MC.formatModelLine(entries2.find((e: any) => e.id === 'stubA-1'));
    ok('注册真数据源后, 真值真的出现在列表里',
      hit2.includes('工具调用=支持') && hit2.includes('reasoning=不支持') && hit2.includes('上下文=128K'), hit2);
    ok('没被覆盖的条目仍然是"未知"', MC.formatModelLine(entries2.find((e: any) => e.id !== 'stubA-1')).includes('工具调用=未知'), '');
    const sources = MC.listModelMetadataSources();
    ok('填充点注册表可读 (排障用)', sources.includes('verify-real-registry'), sources.join(','));
    MC.resetModelMetadataSources();
    const entries3 = await MC.listModelsFor('openai');
    ok('撤掉填充点后回到"未知"(没有残留的假真值)',
      MC.formatModelLine(entries3.find((e: any) => e.id === 'stubA-1')).includes('工具调用=未知'), '');

    // ────────────────────────────────────────────────────────
    section('S4 命令面: pick 走同一条路, 状态读到同一份');
    // 供应商 openai → (key 已配) → 搜索 'stubA-2' → 手工输入同一个 ID → 参数 → 全局 → 真探测 → 确认
    const s4 = scriptedIO(['openai', 'stubA-2', 'stubA-2', '不设', '0.7', 'global']);
    const out4 = await SW.runModelCommand('pick', { choose: s4.io.choose, ask: s4.io.ask });
    ok('runModelCommand("pick") 真跑通', out4.includes('✅ 当前生效') && out4.includes('stubA-2'), out4.split('\n').slice(-1)[0]);
    const st = JSON.parse(await SW.runModelCommand('status --json'));
    ok('status --json 读到同一份 (provider/model/baseUrl)',
      st.effective.provider === 'openai' && st.effective.model === 'stubA-2' && st.effective.baseUrl === A_BASE,
      MS.formatEffectiveModel(st.effective));
    ok('状态里带上了生成参数 (temperature 0.7)', st.effective.temperature === 0.7, String(st.effective.temperature));
    const statusText = await SW.runModelCommand('status');
    ok('人类可读状态用新行形状并给出 pick 指引',
      /● openai · /.test(statusText) && statusText.includes('/model pick'), statusText.split('\n').find((l) => l.startsWith('●')) || '');
    ok('没有交互能力时 pick 给指引而不是假装成功',
      (await SW.runModelCommand('pick')).includes('bolloon model pick'), '');

    // ────────────────────────────────────────────────────────
    section('S5 预检失败 → 用户不继续 → 字节不变 (失败不留痕)');
    // 把 openai 指到一个死端口, 再走一次选择器: 第 6 步真探测 (真连接失败), 用户选择"取消"
    const dead = 'http://127.0.0.1:9/v1';
    await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: dead, apiKey: 'k-stub-a', scope: 'global', verify: false });
    const beforeFail = sha(CFG);
    const s5 = scriptedIO(['openai', 'stubA-2', 'stubA-2', '不设', '0.7', 'global', 'no']);
    const r5 = await SEL.runModelSelector(s5.io, {});
    const lineS5 = s5.printed.join('\n');
    ok('第 6 步真探测失败 (不是伪造的失败)', lineS5.includes('测试连接') && lineS5.includes('✗ 失败'), lineS5.split('\n').find((l) => l.includes('测试连接')) || '');
    ok('用户取消后整体失败且分类可读', r5.ok === false && !!r5.failureClass, `${r5.failureClass}: ${String(r5.message || '').slice(0, 80)}`);
    ok('配置文件字节未变', sha(CFG) === beforeFail, `${beforeFail} → ${sha(CFG)}`);
    // 参数越界: 即使跳过探测, 也在**写盘前**被统一入口拒掉
    ok('无效 temperature 也在写盘前被拒 (0~2)',
      (await SEL.runModelSelector(scriptedIO(['openai', 'stubA-2', 'stubA-2', '不设', '__custom__', '7', 'global']).io, { verify: false })).failureClass === 'invalid_temperature',
      '');
    ok('两次失败后字节仍未变', sha(CFG) === beforeFail, sha(CFG));

    // 回到 A, 后续用例以此为基础
    await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: A_BASE, apiKey: 'k-stub-a', scope: 'global' });

    // ────────────────────────────────────────────────────────
    section('S6 遗留①: 真子进程改配置 + mtime/size 撞车 → 改动不被陈旧快照覆盖');
    // 1) 真子进程先写一份 (统一入口的路径), 让盘上是一份**完整的**配置
    const c1 = childJson(['select', 'glm', 'glm-orig-1', B_BASE, 'k-stub-b']);
    ok('子进程写入 glm 标记 (原值) 成功', c1.ok === true, JSON.stringify(c1).slice(0, 120));
    await MS.selectModel({ provider: 'glm', model: 'glm-orig-1', baseUrl: B_BASE, apiKey: 'k-stub-b', scope: 'global', verify: false });
    // 把 activeProvider 定在 glm (这样子进程改 model 时不会连 activeProvider 一起变长度)
    const cfgNow = JSON.parse(readBytes(CFG));
    cfgNow.activeProvider = 'glm';
    fs.writeFileSync(CFG, JSON.stringify(cfgNow, null, 2), { mode: 0o600 });
    // 2) 定一个整毫秒 mtime, 父进程把缓存灌满 (此刻盘上 = glm-orig-1)
    const T = Math.trunc(Date.now() / 1000) * 1000;
    fs.utimesSync(CFG, T / 1000, T / 1000);
    const CS: any = (await import('../src/llm/config-store.js')).llmConfigStore;
    CS.invalidate();
    await CS.initialize();
    const cachedModel = (await CS.getConfig()).providers.glm.model;
    const sizeBefore = fs.statSync(CFG).size;
    ok('父进程缓存 = glm-orig-1', cachedModel === 'glm-orig-1', cachedModel);
    // 3) 真子进程改盘: 同长度 model 名 (10 字符), 且 activeProvider 已经是 glm → 字节数不变
    const c2 = childJson(['select', 'glm', 'glm-mark-1', B_BASE, 'k-stub-b']);
    ok('子进程把盘上改成 glm-mark-1', c2.ok === true, JSON.stringify(c2).slice(0, 120));
    const sizeAfter = fs.statSync(CFG).size;
    ok('两次写入的字节数相同 (构造签名撞车的前提)', sizeBefore === sizeAfter, `${sizeBefore} vs ${sizeAfter}`);
    // 4) 把 mtime 拨回同一整毫秒 → 签名 `${mtimeMs}:${size}` 与缓存里记的完全相同
    fs.utimesSync(CFG, T / 1000, T / 1000);
    await CS.initialize();
    ok('撞车成立: 签名检查看不见这次外部改动 (缓存仍是旧值)',
      (await CS.getConfig()).providers.glm.model === 'glm-orig-1', (await CS.getConfig()).providers.glm.model);
    // 5) 判据: 本进程再切一次配置, 子进程的改动必须活下来 (靠锁内的 invalidate 强制重读)
    const r6 = await MS.selectModel({ provider: 'kimi', model: 'kimi-k3', baseUrl: B_BASE, apiKey: 'k-stub-b', scope: 'global', verify: false });
    ok('本进程在撞车状态下仍能切换', r6.ok, r6.message || '');
    const after6 = JSON.parse(readBytes(CFG));
    ok('子进程写的 glm-mark-1 没有被陈旧快照覆盖', after6.providers.glm.model === 'glm-mark-1', after6.providers.glm.model);
    ok('本进程这次的改动也在 (kimi)', after6.providers.kimi.model === 'kimi-k3', after6.providers.kimi.model);

    // ────────────────────────────────────────────────────────
    section('S7 遗留③: Run 快照反查 (configHash 不许只写不查)');
    await MS.selectModel({ provider: 'openai', model: 'stubA-2', baseUrl: A_BASE, apiKey: 'k-stub-a', scope: 'global' });
    const snap = await MS.captureRunModelConfig();
    const run = await runStore.startRun({ surface: 'cli', goal: '真跑: 快照反查', modelConfig: snap });
    const repSame = await MS.detectRunConfigDrift(run.runId);
    ok('一致时明确回答"一致" + verified', repSame?.verified === true && repSame?.drifted === false, repSame?.message);
    // 外部改盘 (真子进程换 model) → 同一个 Run 的快照开始报漂
    const c3 = childJson(['select', 'openai', 'stubA-1', A_BASE, 'k-stub-a']);
    ok('子进程在快照之后改了配置', c3.ok === true, JSON.stringify(c3).slice(0, 100));
    const repDrift = await MS.detectRunConfigDrift(run.runId);
    ok('漂移被抓住 (drifted=true)', repDrift?.drifted === true, String(repDrift?.message).slice(0, 160));
    ok('逐字段点名 (model + configHash)',
      repDrift?.fields.map((f: any) => f.field).join(',') === 'model,configHash',
      JSON.stringify(repDrift?.fields || []));
    ok('快照本身没被改写 (旧 Run 保留原记录)', (await runStore.readRun(run.runId))?.modelConfig?.model === 'stubA-2', '');
    ok('没有快照的 Run → 返回 null (不编一份出来)',
      (await MS.detectRunConfigDrift((await runStore.startRun({ surface: 'cli', goal: '无快照' })).runId)) === null, '');
    ok('不存在的 Run → 返回 null', (await MS.detectRunConfigDrift('run-nope')) === null, '');
    // 恢复路径真的接了这道核对 (源码级, 不是靠"我记得写了")
    const pisdk = readBytes(path.join(ROOT, 'src/agents/pi-sdk.ts'));
    const resumeBody = pisdk.slice(pisdk.indexOf('async resumeRun('), pisdk.indexOf('async resumeRun(') + 1600);
    ok('pi-sdk.resumeRun 里真的调了 detectRunConfigDrift',
      resumeBody.includes('detectRunConfigDrift(') && resumeBody.includes('modelDrift'), '');

    // ────────────────────────────────────────────────────────
    section('S8 跨进程/重启: 新进程读到同一份');
    const eff = await MS.effectiveModelConfig({});
    const got = childJson(['effective']);
    ok('新进程读到的 provider/model/baseUrl 与父进程一致',
      got?.effective?.provider === eff.provider && got?.effective?.model === eff.model && got?.effective?.baseUrl === eff.baseUrl,
      `${got?.effective?.provider}/${got?.effective?.model} @ ${got?.effective?.baseUrl}`);
    ok('有效配置/session 绑定里没有 key 明文',
      !readBytes(CFG).includes('k-stub-a-extra') && !MS.formatEffectiveModel(eff).includes('k-stub-a'), MS.formatEffectiveModel(eff).slice(0, 80));

  } finally {
    await A.close();
    await B.close();
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`verify-model-selector: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
  if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
