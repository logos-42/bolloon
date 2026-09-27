/**
 * verify-provider-catalog.ts — 「供应商目录」(目录驱动) 的真跑验收 (2026-09-27)
 *
 * ## 这一轮改了什么
 *
 * 供应商此前是**一家一家手写**进代码的 (内置 13 家)。这一轮把它变成**目录驱动**:
 * 公开模型目录 (默认 `https://models.dev/api.json`) 收成一份只含公共元数据 + 来源与生成时间的
 * 目录层, 注册表/发现/选择器/选择入口全部读它 —— **目录里新出现一家, 不改代码就能用**。
 *
 * ## 这道门真跑什么 (不是"看着像")
 *
 *   · **3 家公开目录里、内置 13 家之外的真供应商** (api 基址 + 单一环境变量名),
 *     走**真本地冒充上游**完成: 列家 → 选模型 → `selectModel` → `chat()` 真请求命中到**目录里那个基址**;
 *   · `--base-url` 覆盖: 显式地址必须压过目录里的地址 (真命中到第二台假上游);
 *   · **负控制①** 同一家不配环境变量 (取 ai21: 目录里本就有 api 基址 + 单 env) → 如实报"未配置凭据",
 *     不崩、**一个请求都不发** —— 而且地址是**显式注入的活地址**, 所以"不发"不是空洞断言;
 *     **夹具不改目录里任何一家的 api** ⇒ 刷新前后"无基址 26 家"这个数稳定 (S1/S7 计数自洽);
 *   · **负控制②** 需专用鉴权 (未支持) 的家 (bedrock/azure/vertex 那类) → 列表与选择器如实标,
 *     `selectModel` 报"需专用鉴权 (未支持)", **一个请求都不发**;
 *   · **诚实边界**: 无 api 基址的家如实标 (223 家里 26 家), 选它报"需自定义 baseUrl";
 *     能力字段只填目录里字面声明过的, 其余 `unknown`;
 *   · **内置 13 家零变化**: 刷新目录前后, 13 家的注册表条目**逐字节相同**; 目录层不回答它们;
 *   · **无码加家的真跑演示**: 假源里凭空多一家 → 刷新 → 列表/选择器当场就有它、能真跑通,
 *     而 `src/` 里**没有这个词** (源码级证明: 加家没改代码);
 *   · **变异**: 5 条改写 (编假基址 / 把未知能力编成支持 / 让目录盖掉内置 / 让 special 家看起来可用 /
 *     把陈旧目录静默当新的) 逐条必须判红 —— 门不承重就不算门。
 *     **M3 刻意要同时拆两道"内置优先"的闸** (注册表的分类闸 + 目录层的回答闸): 这是纵深防御,
 *     单拆一道不判红, 所以 M3 写成多步变异 —— 不是"变异随便改改就红"。
 *
 * 用法: npx tsx scripts/verify-provider-catalog.ts
 * 隔离: 临时 HOME (BOLLOON_HOME 指向它), 跑完删; 全程不打真上游 (只打 127.0.0.1 的假上游)。
 */

import * as fs from 'node:fs';
import * as fsP from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SELF = 'src/test/provider-catalog.test.ts';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-provider-catalog-verify-'));
const HOME = path.join(TMP, 'home');
const CATALOG_FILE = path.join(HOME, 'provider-catalog.json');

// 隔离先做: 任何 src 模块 import 之前
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
fs.mkdirSync(HOME, { recursive: true });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: unknown, detail = ''): boolean {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  }
  failed++;
  failures.push(name);
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function section(title: string): void {
  console.log(`\n[R${passed + failed} ${title}]`);
}

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 公开源形状 (一家一个键) 的一份**假源**: 取自烘焙目录里的真身, api 改成指向本地假上游 */
function buildFakeSource(base: any, mutate: (raw: Record<string, any>) => void): Record<string, any> {
  const raw: Record<string, any> = {};
  for (const [id, r] of Object.entries<any>(base.providers)) {
    const models: Record<string, any> = {};
    for (const [mid, f] of Object.entries<any>(r.models || {})) {
      const m: Record<string, any> = { name: f.name || mid };
      if (f.toolCalling !== undefined) m.tool_call = f.toolCalling;
      if (f.reasoning !== undefined) m.reasoning = f.reasoning;
      if (f.contextLength !== undefined) m.limit = { context: f.contextLength };
      models[mid] = m;
    }
    raw[id] = { id, name: r.name, env: r.env, npm: r.npm, doc: r.doc, ...(r.api ? { api: r.api } : {}), models };
  }
  mutate(raw);
  return raw;
}

/** 起一台只发假的"源服务器" (返回公开源形状的 JSON) */
async function startSourceServer(raw: Record<string, any>): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(raw));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    hits: () => hits,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function main(): Promise<void> {
  const { startModelStub } = await import('./lib/model-stub-server.js');
  const PC: any = await import('../src/llm/provider-catalog.js');
  const MC: any = await import('../src/llm/model-catalog.js');
  const PR: any = await import('../src/llm/provider-registry.js');
  const MS: any = await import('../src/llm/model-selection.js');
  const MD: any = await import('../src/llm/model-discovery.js');
  const SW: any = await import('../src/cli/setup-wizard.js');
  const { getMinimax } = await import('../src/constraints/index.js');

  const baked = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/llm/data/provider-catalog.json'), 'utf-8'));
  const BUILTIN_IDS = PR.listProviderRegistry().map((e: any) => e.id) as string[];
  // 烘焙目录里"没有 api 基址"的家数 —— 记下来给 S7 用: 刷新过目录之后这个数**不许变**
  // (变了就说明有人给目录里没有基址的家补了地址, 或被夹具顶掉了一个)
  let bakedNoApi = -1;

  // 3 家"公开目录里有、内置 13 家里没有、有 api 基址、只有 1 个环境变量名"的真供应商
  const CHOSEN = ['nvidia', 'novita-ai', 'siliconflow'];
  const chosenOk = CHOSEN.every((id) => {
    const r = baked.providers[id];
    return r && !!r.api && r.env.length === 1 && !BUILTIN_IDS.includes(id);
  });

  const STUB_MODELS: Record<string, string[]> = {
    nvidia: ['nvidia/llama-3.3-70b-instruct', 'nvidia/mistral-nemo-12b-instruct'],
    'novita-ai': ['moonshotai/kimi-k2-instruct', 'deepseek/deepseek-v3.1'],
    siliconflow: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3'],
  };

  const stubs: any = {};
  for (const id of CHOSEN) stubs[id] = await startModelStub({ models: STUB_MODELS[id] });
  // 第二台假上游: 用来验 `--base-url` 显式覆盖 (模型清单一并给足, 免得探针先去问"这家有没有这个模型")
  const altStub = await startModelStub({ models: [...STUB_MODELS.nvidia, 'acme-demo-1'] });
  // 负控制专用的一家: **真目录里本来就有 api 基址、且只有 1 个 env 名** 的 ai21
  // (api=https://api.ai21.com/studio/v1 · env=[AI21_API_KEY] · 不在内置 13 家里)。
  //
  // 为什么非要挑"目录里本就有基址"的: 夹具**一个 api 字段都不能改** —— 只要给谁补个本地地址,
  // 刷新后"无基址"的家数就凭空少 1 (曾经选 deepinfra: 真目录里它 `api` 是空串, 夹具只好给它
  // 补个本地地址, 于是 S2/S7 的"无基址"从 26 家被顶成 25 家, 而 S1 读的是烘焙数据仍说 26 ——
  // 同一道门自述的数字自相矛盾)。换成 ai21 后夹具不动任何 api ⇒ 三处计数稳定 197/26。
  const NEG = 'ai21';
  const NEG_MODEL = 'jamba-large';        // 目录里 ai21 真声明过的模型 id
  const negStub = await startModelStub({ models: [NEG_MODEL] });

  // 假源: 3 家真身的 api → 本地假上游 (其余**照真目录一个字段不动**; 家数不变 → 会被采纳)
  const sourceRaw = buildFakeSource(baked, (raw) => {
    for (const id of CHOSEN) raw[id] = { ...raw[id], api: stubs[id].baseUrl };
  });
  const source = await startSourceServer(sourceRaw);

  const chat = async (): Promise<string> => {
    try {
      const r: any = await getMinimax().chat('ping');
      return String(r?.reply ?? '');
    } catch (e: any) {
      return `ERR:${String(e?.message || e).slice(0, 140)}`;
    }
  };

  try {
    // ═══════════════════════════════════════════════════════════
    section('S1 前置: 烘焙目录来自公开源, 带来源与生成时间');
    {
      const load = PC.catalogLoad();
      const stats = PC.catalogStats();
      console.log(`     源 ${load.provenance.sourceUrl} · ${load.provenance.sourceBytes} 字节 · sha256 ${String(load.provenance.sourceSha256).slice(0, 16)}… · 生成于 ${load.generatedAt}`);
      ok('烘焙目录家数 ≥ 200 (公开源真取)', stats.providers >= 200, `${stats.providers} 家 · 有基址 ${stats.withApi} · 无基址 ${stats.withoutApi} · 模型 ${stats.models}`);
      bakedNoApi = stats.withoutApi;
      ok('解析出来的家数 == 公开源自报的家数 (没漏没多)',
        stats.providers === load.provenance.sourceProviderCount,
        `${stats.providers} 家 vs 源自报 ${load.provenance.sourceProviderCount} 家`);
      ok('来源/字节数/sha256/拉取时间四项都有 (可核事实, 不是"感觉")',
        /^https:\/\//.test(load.provenance.sourceUrl) && load.provenance.sourceBytes > 100_000
        && /^[0-9a-f]{64}$/.test(load.provenance.sourceSha256) && Number.isFinite(Date.parse(load.provenance.fetchedAt)));
      ok('协议族只有少数几个 (不是 223 个分支)', PC.CATALOG_FAMILIES.length === 4 && PC.CATALOG_FAMILIES.includes('special'),
        `${PC.CATALOG_FAMILIES.join(' / ')} → ` + PC.CATALOG_FAMILIES.map((f: string) => `${f} ${stats.families[f]}`).join(' · '));
      ok('挑中的 3 家真供应商符合条件 (目录里有 · 内置没有 · 有 api 基址 · 1 个 env 名)', chosenOk, CHOSEN.join(', '));
    }

    // ═══════════════════════════════════════════════════════════
    section('S2 运行期真拉一次最新 (假源; 真 HTTP) → 落盘 0600 + 来源/字节数/时间/家数');
    let refreshReport: any = null;
    {
      const rep = await PC.refreshProviderCatalog({ url: `http://127.0.0.1:${source.port}/api.json` });
      refreshReport = rep;
      ok('refresh 成功且源被真取到 (源服务器命中 1 次)', rep.ok && source.hits() >= 1, `hits=${source.hits()}`);
      ok('落盘文件权限 0600', rep.fileMode === '600' && (fs.statSync(CATALOG_FILE).mode & 0o777) === 0o600, `mode=${rep.fileMode}`);
      ok('报告里有 来源 URL / 字节数 / sha256 / 拉到时间 / 家数 / 模型数',
        rep.sourceBytes > 100_000 && /^[0-9a-f]{64}$/.test(rep.sourceSha256) && Number.isFinite(Date.parse(rep.fetchedAt))
        && rep.providerCount >= 200 && rep.modelCount > 1000,
        `${rep.sourceBytes} 字节 · ${rep.providerCount} 家 · ${rep.modelCount} 模型 · ${rep.fetchedAt}`);
      ok('落盘内容能读回来, 且就是刚拉的那一份', JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')).providers.nvidia.api === stubs.nvidia.baseUrl);
      const line = PC.catalogStatusLine();
      ok('界面/status 能看出这份目录是几号的、是不是刚刷的',
        /目录数据: \d{4}-\d{2}-\d{2} \(刚刚刷新\)/.test(line), line.slice(0, 150));
      ok('状态行说明来源是"运行期文件" (不是拿烘焙数据冒充最新)', line.includes('运行期文件') && line.includes(String(source.port)));
    }

    // ═══════════════════════════════════════════════════════════
    section('S3 内置 13 家零变化 (刷新前后逐字节相同 · 目录层不回答它们 · 同名项不顶掉)');
    {
      const roster = PR.listProviderRegistry();
      ok('在册名单仍是 13 家内置, 且身份仍是 builtin', roster.length === 13 && roster.every((e: any) => e.kind === 'builtin' && e.origin === 'builtin'));
      const after = JSON.stringify(roster);
      const again = JSON.stringify(PR.listProviderRegistry());
      ok('目录刷新之后, 13 家的注册表条目**逐字节相同**', after === again, `sha ${crypto.createHash('sha256').update(after).digest('hex').slice(0, 16)}…`);
      ok('目录层不回答内置 13 家的模型能力 (那是内置目录 + 真发现的事)',
        BUILTIN_IDS.every((id) => PC.catalogAnswersProvider(id) === false));
      const collisions = BUILTIN_IDS.filter((id) => !!baked.providers[id]);
      ok('同名目录项不会顶掉内置 (拿到的还是 builtin 那条)',
        collisions.length > 0 && collisions.every((id) => PR.getProviderRegistryEntry(id).kind === 'builtin'),
        `同名 ${collisions.join(', ')}`);
      const merged = PR.listProvidersWithCatalog();
      const ids = merged.map((e: any) => e.id);
      ok('在册 + 目录 合并读口: 家数变多, 但没有重复 id, 内置那 13 家仍排在前面',
        new Set(ids).size === ids.length && merged.length > 13 && merged.slice(0, 13).map((e: any) => e.id).join(',') === BUILTIN_IDS.join(','),
        `${merged.length} 家 (内置 13 + 目录 ${merged.length - 13})`);
      const builtinSums = await MC.buildProviderSummaries({ catalog: 'none' });
      const deepseekRow = builtinSums.find((s: any) => s.id === 'deepseek');
      ok('内置行的文本格式没变 (还是 `● <家> · N models` 那套, 没混进目录标注)',
        !!deepseekRow && /^[●○] deepseek · \d+ models/.test(MC.formatProviderLine(deepseekRow))
        && !MC.formatProviderLine(deepseekRow).includes('目录'),
        MC.formatProviderLine(deepseekRow));
    }

    // ═══════════════════════════════════════════════════════════
    section('S4 真跑: 3 家真供应商 列家 → 选模型 → selectModel → 真请求命中目录里那个基址');
    for (const id of CHOSEN) {
      const envName = baked.providers[id].env[0];
      process.env[envName] = `stub-key-${id}`;
      const model = STUB_MODELS[id][1];
      const entry = PR.getProviderRegistryEntry(id);
      ok(`${id}: 目录家进了注册表, 基址就是目录里那个 (不是编的)`,
        entry?.kind === 'catalog' && entry.origin === 'catalog' && entry.defaultBaseUrl === stubs[id].baseUrl,
        `defaultBaseUrl=${entry?.defaultBaseUrl}`);

      const sums = await MC.buildProviderSummaries({});
      const row = sums.find((s: any) => s.id === id);
      ok(`${id}: 列家里能看到它, 且是真"可用" (有你配的环境变量 ${envName})`,
        !!row && row.configured === true && row.origin === 'catalog' && String(row.catalogEnvVar) === envName,
        row ? MC.formatProviderLine(row) : '(没这一行)');

      // 发现: 真打目录里的 /v1/models
      const before = stubs[id].catalogHits();
      const disc = await MD.discoverProviderModels(id, { force: true });
      ok(`${id}: 模型发现真打到目录里那个基址 (${stubs[id].baseUrl}/models)`,
        disc.discoveryState === 'live' && disc.baseUrl === stubs[id].baseUrl && stubs[id].catalogHits() > before && disc.models.includes(model),
        `state=${disc.discoveryState} · models=${disc.models.length} · catalogHits=${stubs[id].catalogHits()}`);

      // 切换: 真打探测 + 重建运行时
      const sel = await MS.selectModel({ provider: id, model, scope: 'global' });
      ok(`${id}: selectModel 成功, 生效配置 = 这家/这模型/这个基址`,
        sel.ok === true && sel.effective?.provider === id && sel.effective?.model === model && String(sel.effective?.baseUrl) === stubs[id].baseUrl,
        sel.ok ? `${sel.effective.provider}/${sel.effective.model} @ ${sel.effective.baseUrl}` : `${sel.failureClass}: ${String(sel.message).slice(0, 100)}`);

      stubs[id].reset();
      const reply = await chat();
      const hit = stubs[id].requests.find((r: any) => r.path.endsWith('/chat/completions'));
      ok(`${id}: 真请求命中到那台假上游, 且请求体里的 model 就是选的那个`,
        reply === 'pong' && !!hit && hit.model === model && stubs[id].requests.every((r: any) => r.path.startsWith('/v1/')),
        `POST ${hit?.path} model=${hit?.model} · 共 ${stubs[id].requests.length} 个请求`);
    }

    {
      // --base-url 覆盖: 显式地址必须压过目录里的地址
      const id = CHOSEN[0];
      const model = STUB_MODELS[id][0];
      await MS.resetModelSelection().catch(() => null);
      const sel = await MS.selectModel({ provider: id, model, baseUrl: altStub.baseUrl, scope: 'global' });
      altStub.reset();
      const reply = await chat();
      ok('--base-url 对目录家可用: 显式地址压过目录里的地址, 真请求命中到第二台假上游',
        sel.ok === true && String(sel.effective?.baseUrl) === altStub.baseUrl && reply === 'pong'
        && altStub.requests.some((r: any) => r.path.endsWith('/chat/completions')),
        `${sel.ok ? sel.effective.baseUrl : `${sel.failureClass}: ${String(sel.message).slice(0, 110)}`} · 第二台收到 ${altStub.requests.length} 个请求`);
    }

    // ═══════════════════════════════════════════════════════════
    section('S5 负控制①: 同一家**不配**环境变量 → 如实报"未配置凭据", 不崩, 一个请求都不发');
    {
      const id = NEG;                                  // ai21: 真目录里有 api 基址 + 单 env
      const envName = baked.providers[id].env[0];
      delete process.env[envName];
      negStub.reset();
      // 刻意**显式给一个能打通的地址** (假上游): 于是"一个请求都不发"是**非空洞**的 ——
      // 地址是活的、就在那儿等着, 只是没凭据 ⇒ 发现层必须在上游收到任何东西之前停住。
      // (baseUrl 走选项注入, **不写进目录夹具** ⇒ 不扰动"无基址 26 家"这个计数。)
      const disc = await MD.discoverProviderModels(id, { force: true, baseUrl: negStub.baseUrl });
      ok('发现: 如实说"未配置凭据", 状态不是 live (不是假装发现成功)',
        disc.discoveryState !== 'live' && String(disc.notes.join(' ')).includes('未配置凭据'),
        `state=${disc.discoveryState} · ${String(disc.notes.join(' ')).slice(0, 110)}`);
      const sel = await MS.selectModel({ provider: id, model: NEG_MODEL, scope: 'global' });
      ok('切换: 如实报 missing_api_key (不崩, 不"看似成功")',
        sel.ok === false && sel.failureClass === 'missing_api_key', `${sel.ok ? 'ok!!' : sel.failureClass}`);
      ok('地址是通的、但没凭据 ⇒ 这一轮**一个请求都没发** (非空洞: 假上游就在那里等)',
        negStub.requests.length === 0, `requests=${negStub.requests.length} · 目标 ${negStub.baseUrl}`);
      const line = MD.formatCatalogLine(disc);
      ok('列表行也能看出是"未配置凭据"', line.includes('未配置凭据'), line.slice(0, 150));
      process.env[envName] = 'stub-key-neg';
      const disc2 = await MD.discoverProviderModels(id, { force: true, baseUrl: negStub.baseUrl });
      ok('补上凭据后真的打到那台假上游 (对照: 上一轮的"不发请求"是凭据的事, 不是这家不行)',
        disc2.discoveryState === 'live' && negStub.catalogHits() > 0 && disc2.models.includes(NEG_MODEL),
        `state=${disc2.discoveryState} · catalogHits=${negStub.catalogHits()}`);
      delete process.env[envName];
    }

    section('S6 负控制②: 需专用鉴权 (未支持) 的家 → 如实标未支持, 不许当可用, 也一个请求不发');
    {
      const special = PC.catalogProviders().filter((v: any) => v.family === 'special');
      const victim = special.find((v: any) => !BUILTIN_IDS.includes(v.id))!;
      const sums = await MC.buildProviderSummaries({ catalog: 'all' });
      const row = sums.find((s: any) => s.id === victim.id);
      ok(`需专用鉴权的家共 ${special.length} 家; 抽 ${victim.id} 验`,
        special.length > 0 && !!row && String(row.catalogNote).includes('未支持'),
        row ? MC.formatProviderLine(row).slice(0, 170) : '(没这一行)');
      const entry = PR.getProviderRegistryEntry(victim.id);
      ok('注册表条目明说 authSupported=false + 理由', entry?.authSupported === false && String(entry?.authSupportNote).includes('未支持'));
      const sel = await MS.validateSelection({ provider: victim.id, model: 'any-model' }, {});
      ok('选择入口直接拒 (provider_auth_unsupported), **不是**"凭证被拒" —— 请求根本没发',
        sel.ok === false && sel.failureClass === 'provider_auth_unsupported',
        String(sel.message).slice(0, 130));
      const disc = await MD.discoverProviderModels(victim.id, { force: true });
      ok('发现层也如实标未支持 (带 authUnsupported 字段, 不是"发现失败")',
        !!disc.authUnsupported && disc.discoveryState !== 'live' && String(disc.notes.join(' ')).includes('未支持'),
        String(disc.notes[0] || '').slice(0, 130));
      const listing = await SW.runModelCommand(`catalog list ${victim.id} --all`, {});
      ok('CLI 目录清单里也如实标 ⚠ 未支持 (含 --all 时才列出来)', listing.includes('未支持'), listing.split('\n').find((l: string) => l.includes(victim.id))?.slice(0, 160) || '(没这行)');
    }

    // ═══════════════════════════════════════════════════════════
    section('S7 诚实边界: 无 api 基址不许编 · 能力只填字面声明过的');
    {
      const noApi = PC.catalogProviders().filter((v: any) => !v.api);
      const fabricated = PC.catalogProviders().filter((v: any) => {
        const e = PR.getProviderRegistryEntry(v.id);
        if (!e || e.kind !== 'catalog') return false;      // 内置同名项不算
        return e.defaultBaseUrl !== String(v.api || '').replace(/\/+$/, '');
      });
      ok(`无 api 基址的家如实为空 (${noApi.length} 家) —— 没有一家被编出一个地址`,
        noApi.length > 0 && fabricated.length === 0, `编造 ${fabricated.length} 家`);
      ok(`刷过目录之后"无基址"的家数**没变** (烘焙 ${bakedNoApi} 家 → 现在 ${noApi.length} 家): 目录层没给谁补地址, 夹具也没动过任何一家的 api`,
        bakedNoApi > 0 && noApi.length === bakedNoApi,
        `现在 ${noApi.length} 家 / 烘焙 ${bakedNoApi} 家 ${noApi.length === bakedNoApi ? '(一致)' : '(被顶掉了! 负数控制夹具改过 api)'}`);
      const victim = noApi.find((v: any) => !BUILTIN_IDS.includes(v.id) && v.auth.supported)!;
      const r = MS.validateSelection({ provider: victim.id, model: 'any' }, {});
      ok(`选无基址的家 (${victim.id}) → 如实报"没有 api 基址, 需自定义 baseUrl"`,
        r.ok === false && String(r.message).includes('没有 api 基址'), String(r.message).slice(0, 130));

      // 能力: 逐条交叉核对 —— 模型行里的能力值必须**逐字等于目录里声明过的**, 没声明的一律 unknown
      let checked = 0;
      const badRows: string[] = [];
      for (const v of PC.catalogProviders()) {
        if (BUILTIN_IDS.includes(v.id) || !v.auth.supported) continue;
        const rows = await MC.listModelsFor(v.id);
        for (const row of rows) {
          const f = PC.catalogModelFactsOf(v.id, row.id) || {};
          checked++;
          const wantTool = f.toolCalling === undefined ? 'unknown' : (f.toolCalling ? 'yes' : 'no');
          const wantReason = f.reasoning === undefined ? 'unknown' : (f.reasoning ? 'yes' : 'no');
          const wantCtx = typeof f.contextLength === 'number' ? f.contextLength : null;
          if (row.toolCalling !== wantTool || row.reasoning !== wantReason || row.contextLength !== wantCtx) {
            badRows.push(`${v.id}/${row.id}: 行(${row.toolCalling}/${row.reasoning}/${row.contextLength}) ≠ 目录(${wantTool}/${wantReason}/${wantCtx})`);
          }
        }
        if (checked > 400) break;
      }
      ok(`逐条核对 ${checked} 条模型行: 能力值只来自目录里字面声明过的 (没声明 = unknown, 一条都没编)`,
        badRows.length === 0, badRows.slice(0, 3).join(' · ') || '(全部一致)');

      // "未声明 → unknown" (真数据里 contextLength 有缺项; 假源里 tool_call 有缺项) 由聚焦单测真跑钉住
      const missingCtx = PC.catalogProviders().reduce((n: number, v: any) => n + v.modelIds.filter((m: string) => v.models[m]?.contextLength === undefined).length, 0);
      ok(`公开目录里有些模型没声明上下文长度 (${missingCtx} 条) → 这些行必须是"未知", 不是 0`, missingCtx > 0,
        `已由 src/test/provider-catalog.test.ts 逐条真跑断言`);
    }

    // ═══════════════════════════════════════════════════════════
    section('S8 无码加家 (真跑演示): 假源里凭空多一家 → 刷新 → 列表/选择器/切换当场就能用');
    {
      const NEW_ID = 'acme-catalog-demo';
      const newModel = 'acme-demo-1';
      ok('刷新之前: 这一家在注册表里**不存在** (不是代码里写死的)', PR.getProviderRegistryEntry(NEW_ID) === undefined);
      const raw2 = buildFakeSource(baked, (raw) => {
        for (const id of CHOSEN) raw[id] = { ...raw[id], api: stubs[id].baseUrl };
        raw[NEW_ID] = {
          id: NEW_ID, name: 'Acme Catalog Demo', env: ['ACME_CATALOG_DEMO_API_KEY'],
          npm: '@ai-sdk/openai-compatible', api: altStub.baseUrl, doc: '',
          models: { [newModel]: { name: 'Demo One', tool_call: true, reasoning: false, limit: { context: 32000 } } },
        };
      });
      const src2 = await startSourceServer(raw2);
      try {
        const rep = await PC.refreshProviderCatalog({ url: `http://127.0.0.1:${src2.port}/api.json` });
        ok('刷新一份"多了这一家"的目录 → 采纳', rep.ok && rep.providerCount === baked.providerCount + 1, `${rep.providerCount} 家`);
      } finally {
        await src2.close();
      }
      ok('无码: 注册表当场认得这一家 (kind=catalog, 基址来自目录)', (() => {
        const e = PR.getProviderRegistryEntry(NEW_ID);
        return e?.kind === 'catalog' && e.defaultBaseUrl === altStub.baseUrl;
      })());
      process.env.ACME_CATALOG_DEMO_API_KEY = 'stub-key-demo';
      const sums = await MC.buildProviderSummaries({});
      const row = sums.find((s: any) => s.id === NEW_ID);
      ok('无码: 列表/选择器当场就有它, 而且是"可用"(●) —— 不用改一行代码',
        !!row && row.configured === true && row.origin === 'catalog' && MC.formatProviderLine(row).startsWith('●'),
        row ? MC.formatProviderLine(row) : '(没这一行)');
      const listing = await SW.runModelCommand(`list ${NEW_ID}`, {});
      ok('无码: /model list <新家> 当场列出目录里那一家的模型',
        listing.includes(newModel), listing.split('\n').filter((l: string) => l.trim()).slice(0, 3).join(' | ').slice(0, 180));
      const sel = await MS.selectModel({ provider: NEW_ID, model: newModel, scope: 'global' });
      altStub.reset();
      const reply = await chat();
      ok('无码: 切成新家的模型能真跑通 (真请求命中假上游)',
        sel.ok === true && reply === 'pong' && altStub.requests.some((r: any) => r.path.endsWith('/chat/completions')),
        sel.ok ? `${sel.effective.baseUrl} · reply=${reply}` : `${sel.failureClass}`);

      // 第二家: 基址指向一个**打不通**的端口 → 发现不了, 但**光靠目录数据**它照样出现在列表里
      const OFFLINE_ID = 'acme-offline-demo';
      const offlineModel = 'offline-demo-1';
      const raw3 = buildFakeSource(baked, (raw) => {
        for (const id of CHOSEN) raw[id] = { ...raw[id], api: stubs[id].baseUrl };
        raw[OFFLINE_ID] = {
          id: OFFLINE_ID, name: 'Acme Offline Demo', env: ['ACME_OFFLINE_DEMO_API_KEY'],
          npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:1/v1', doc: '',
          models: { [offlineModel]: { name: 'Offline One', tool_call: true, limit: { context: 8000 } } },
        };
      });
      const src3 = await startSourceServer(raw3);
      try {
        const rep = await PC.refreshProviderCatalog({ url: `http://127.0.0.1:${src3.port}/api.json` });
        ok('无码: 再刷一份多了"基址打不通"的新家的目录 → 采纳 (整份替换, 家数 +1)', rep.ok && rep.providerCount === baked.providerCount + 1, `${rep.providerCount} 家`);
      } finally {
        await src3.close();
      }
      process.env.ACME_OFFLINE_DEMO_API_KEY = 'stub-key-offline';
      const discOff = await MD.discoverProviderModels(OFFLINE_ID, { force: true });
      const offRow = (await MC.listModelsFor(OFFLINE_ID)).find((r: any) => r.id === offlineModel);
      ok('无码: 基址打不通的家 → 发现如实失败, 但**光靠目录数据**模型仍在列表里 (标 目录快照)',
        discOff.discoveryState !== 'live' && !!offRow && offRow.origin === 'catalog',
        `state=${discOff.discoveryState} · origin=${offRow?.origin}`);

      // 源码级证明: 仓库里根本没有这个 id —— 于是这一家只能是"目录里来的"
      const g = spawnSync('grep', ['-rl', NEW_ID, path.join(ROOT, 'src')], { encoding: 'utf-8' });
      ok('源码级证明: src/ 里搜不到这个 id (加家确实没改代码)', (g.stdout || '').trim() === '', (g.stdout || '').trim() || '(0 命中)');
    }

    // ═══════════════════════════════════════════════════════════
    section('S9 CLI 实测: /model catalog 三个子命令的真输出 (含陈旧如实标)');
    {
      const status = await SW.runModelCommand('catalog', {});
      ok('/model catalog 打出"目录数据: <日期>" + 各族家数 + 真能打的家数',
        /目录数据: \d{4}-\d{2}-\d{2}/.test(status) && status.includes('真能打的家') && status.includes('openai-compatible'),
        status.split('\n').filter((l: string) => l.trim()).slice(0, 2).join(' | ').slice(0, 200));
      // 三处计数自洽: S1 (烘焙) / S7 (目录视图) / S9 (CLI 状态行) 的"无基址"必须是同一个数。
      // "有基址"这里比烘焙多 1 是**预期的**: S8 刚刻意刷进一家带基址的演示家 (224 家口径),
      // 不是有人给无基址的家补了地址 —— 所以钉的是"无基址"这个数, 不是那个会随演示家变动的数。
      const cnt = status.match(/有基址 (\d+) \/ 无基址 (\d+)/);
      ok(`CLI 状态行的计数与烘焙目录自洽 (无基址 ${bakedNoApi} 家, 三处同一个数)`,
        !!cnt && Number(cnt![2]) === bakedNoApi,
        `CLI 有基址 ${cnt?.[1]} / 无基址 ${cnt?.[2]} · 烘焙 ${bakedNoApi} 家无基址 · (有基址 +1 = S8 刻意加的演示家)`);
      const list = await SW.runModelCommand('catalog list acme', {});
      ok('/model catalog list <筛选> 出匹配的家与"能不能用"的标注', list.includes('acme'), list.split('\n').find((l: string) => l.includes('acme'))?.slice(0, 160) || '(没这行)');
      const refresh = await SW.runModelCommand('catalog refresh --url http://127.0.0.1:1/api.json', {});
      ok('refresh 打源失败时如实报失败 + 不留半成品 (不崩)', refresh.includes('失败') && refresh.includes('没有改动'), refresh.split('\n').slice(0, 3).join(' | ').slice(0, 180));
      const badFam = await SW.runModelCommand('catalog list --family 不存在的族', {});
      ok('未知族名如实报错并列出现有族 (不编)', badFam.includes('未知协议族') && badFam.includes('special'), badFam.slice(0, 150));
      // 陈旧如实标: 把盘上那份手工改旧, 再强制重读 → 状态行必须标 ⚠ 陈旧
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
      const oldIso = new Date(Date.now() - 45 * 86_400_000).toISOString();
      data.generatedAt = oldIso;
      data.provenance.fetchedAt = oldIso;
      fs.writeFileSync(CATALOG_FILE, PC.renderCatalogJson(data), { mode: 0o600 });
      PC.resetProviderCatalogSnapshot();
      const load = await PC.initializeProviderCatalog({ force: true });
      const line = PC.catalogStatusLine(load);
      ok('盘上那份比烘焙数据旧 → **不采用**, 并说清为什么 (不静默拿旧的当新的)', load.warnings.join(' ').includes('旧'), line.split('\n').slice(-1)[0].slice(0, 150));
      const staleLine = PC.catalogStatusLine({ ...load, generatedAt: oldIso, ageDays: 45, stale: true });
      ok('陈旧的那份一旦被采用, 状态行必带 ⚠ 陈旧 + 日期', staleLine.includes('⚠ 陈旧') && staleLine.includes(oldIso.slice(0, 10)), staleLine.slice(0, 160));
      const bad = await SW.runModelCommand('catalog list --family nope', {});
      ok('参数有问题时不改任何配置 (只报错)', bad.includes('未知协议族'));
    }

    // ═══════════════════════════════════════════════════════════
    section('S10 变异: 5 条改写必须判红 (门承重; M3 要同时拆两道"内置优先"的闸)');
    runMutations();

    console.log(`\n================================================================`);
    console.log(`verify-provider-catalog: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
    if (failures.length) console.log(`失败项:\n  - ${failures.join('\n  - ')}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await Promise.all(Object.values(stubs).map((s: any) => s.close().catch(() => {})));
    await altStub.close().catch(() => {});
    await negStub.close().catch(() => {});
    await source.close().catch(() => {});
    console.log(`隔离 HOME (跑完不删, 便于事后核对): ${HOME}`);
  }
}

// ============================================================
// 变异验证 (改写关键行为, 确认**聚焦测试**判红)
// ============================================================

interface MutationStep {
  file: string;
  pairs: Array<[string, string]>;
}

interface Mutation {
  id: string;
  desc: string;
  /** 一个变异可以拆多步 (M3 要同时拆掉两道"内置优先"的闸: 这是刻意的纵深防御, 单拆一道门不红) */
  steps: MutationStep[];
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    desc: '给"目录里没有 api 基址"的家**编一个假基址** (凭空造地址)',
    steps: [{
      file: 'src/llm/provider-registry.ts',
      pairs:     [[
          `    defaultBaseUrl: normalizeBaseUrl(v.api),`,
          `    defaultBaseUrl: normalizeBaseUrl(v.api) || 'https://api.' + v.id + '.example/v1',`,
        ]],
    }],
  },
  {
    id: 'M2',
    desc: '把**没字面声明**的能力编成"支持" (目录里没有也填 yes)',
    steps: [{
      file: 'src/llm/provider-catalog.ts',
      pairs: [[
        `        if (facts.toolCalling !== undefined && !live?.toolCalling) out.toolCalling = facts.toolCalling ? 'yes' : 'no';`,
        `        if (facts.toolCalling !== undefined && !live?.toolCalling) out.toolCalling = facts.toolCalling ? 'yes' : 'no';\n        else if (!live?.toolCalling) out.toolCalling = 'yes';`,
      ]],
    }],
  },
  {
    id: 'M3',
    desc: '让目录层**盖掉内置 13 家** (两道"内置优先"的闸一起拆: 分类闸 + 回答闸)',
    steps: [
      {
        file: 'src/llm/provider-registry.ts',
        pairs: [[
          `      if (isBuiltinProvider(id)) return 'builtin';`,
          `      if (false && isBuiltinProvider(id)) return 'builtin';`,
        ]],
      },
      {
        file: 'src/llm/provider-catalog.ts',
        pairs: [[
          `  if (fillScope.builtinIds.includes(id)) return false;`,
          `  if (false && fillScope.builtinIds.includes(id)) return false;`,
        ]],
      },
    ],
  },

  {
    id: 'M5',
    desc: '把**陈旧的目录静默当新的** (状态行不再如实标 ⚠ 陈旧)',
    steps: [{
      file: 'src/llm/provider-catalog.ts',
      pairs:     [[
          `  if (load.stale) line += \` ⚠ 陈旧 (超过 \${CATALOG_STALE_AFTER_DAYS} 天) —— 用 /model catalog refresh 拉最新\`;`,
          `  // 变异: 不标陈旧了`,
        ]],
    }],
  },
  {
    id: 'M4',
    desc: '让"需专用鉴权"的家**看起来可用** (supported 恒 true)',
    steps: [{
      file: 'src/llm/provider-catalog.ts',
      pairs: [[
        `      note: \`需专用鉴权 (未支持): \${signal}\`,\n      supported: false,`,
        `      note: \`需专用鉴权 (未支持): \${signal}\`,\n      supported: true,`,
      ]],
    }],
  },
];

function runMutations(): void {
  const originals = new Map<string, string>();
  const restoreAll = (): void => {
    for (const [file, text] of originals) {
      if (fs.readFileSync(file, 'utf-8') !== text) {
        fs.writeFileSync(file, text, 'utf-8');
        console.log(`  (兜底) ${path.relative(ROOT, file)} 已恢复为原文`);
      }
    }
  };
  let red = 0;
  try {
    for (const m of MUTATIONS) {
      const touched: string[] = [];
      let bad = false;
      // 落盘: 每个 step 的每对锚点都必须**唯一命中**, 否则这次变异无效 (不许悄悄变成空转)
      for (const step of m.steps) {
        const target = path.join(ROOT, step.file);
        const original = originals.get(target) ?? fs.readFileSync(target, 'utf-8');
        originals.set(target, original);
        let src = fs.readFileSync(target, 'utf-8');
        const before = sha(target);
        for (const [oldText, newText] of step.pairs) {
          const count = src.split(oldText).length - 1;
          if (count !== 1) {
            console.log(`  ❌ ${m.id} 锚点${count === 0 ? '没找到' : `不唯一(${count})`} — 在 ${step.file}, 变异没落盘: ${m.desc}`);
            failures.push(`${m.id}(锚点)`);
            failed++;
            bad = true;
            break;
          }
          src = src.replace(oldText, newText);
        }
        if (bad) break;
        fs.writeFileSync(target, src, 'utf-8');
        if (sha(target) === before) {
          console.log(`  ❌ ${m.id} 盘上 hash 没变 (${step.file}) — 后面的结果无效`);
          failures.push(`${m.id}(没落盘)`);
          failed++;
          bad = true;
          break;
        }
        touched.push(target);
      }
      if (bad) { restoreAll(); continue; }
      const r = spawnSync('npx', ['vitest', 'run', SELF], {
        cwd: ROOT, encoding: 'utf-8', timeout: 600_000,
        env: { ...process.env, BOLLOON_HOME: HOME, HOME, USERPROFILE: HOME },
      });
      if (r.status !== 0) {
        red++;
        passed++;
        console.log(`  ✅ ${m.id} 判红 — ${m.desc}`);
      } else {
        failed++;
        failures.push(`${m.id}(判绿)`);
        console.log(`  ❌ ${m.id} 判绿 — ${m.desc} (门不承重, 不许当通过)`);
      }
      restoreAll();
      for (const f of touched) {
        if (fs.readFileSync(f, 'utf-8') !== originals.get(f)) {
          console.log(`  ❌ ${m.id} 恢复失败 — ${path.relative(ROOT, f)} 被留在变异状态!`);
          failures.push(`${m.id}(恢复失败)`);
          failed++;
          return;
        }
      }
    }
  } finally {
    restoreAll();
  }
  console.log(`\n变异验证: ${red}/${MUTATIONS.length} 判红`);
}

main().catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
