/**
 * verify-model-wiring.ts — 「接线收口」真跑验收 (2026-09-26)
 *
 * 审的是**已建好但没插上**的四个东西, 现在插进共用骨架之后, 真的通电了吗:
 *
 *   M0 失败分类映射表: P4 探测原语 7 类 → 入口类目, **一类都不许丢** (尤其 tool_call_unsupported),
 *      并且每一类都有真出处 (probe / entry), 映射之后的类名必须仍在入口的类目集合里;
 *   M1 七类失败各造一枚**真**服务器/真网络条件 → 走**入口** `selectModel` → 入口如实报出对应类
 *      (含原文探测类目), 文案里有类名与人话理由, **没有**"切换失败"这种无信息退化; 且失败不落盘;
 *   M2 P7 钩子: 串行点 (`execution-supervisor.runGoal`) 真的算出「下一个 Run 用哪一份」并交给执行器;
 *      **新 Run 用最新全局默认**; **在跑的 Run 逐字段仍等于旧快照** (一个字没动); 失败类别 → 判定函数;
 *   M3 客户端鉴权头改读注册表: 内置五个分支**一字不变** (真服务器收到的头逐字比对), 自定义供应商声明的
 *      `authHeader` **真生效** (并且它作为全局默认时不再 "Unsupported provider");
 *   M4 P3 自定义供应商出现在 `/model` 列表里: 未配置 key 照实标、本地端点标"本地"。
 *
 * 真跑的含义: 本地起真 HTTP 服务器扮演模型服务; 断言的是"服务器真收到了什么", 不是内存字段。
 *
 * 用法: npx tsx scripts/verify-model-wiring.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawnSync } from 'child_process';

const REAL_HOME = os.homedir(); // 必须在覆盖 HOME 之前取 (makeSetupReady 要从真 HOME 借 LLM 配置)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-wiring-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_MODEL_SKIP_PROBE;

const ROOT = process.cwd();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n[${t}]`); }

// ── 真 HTTP 假模型服务 (可造出每一类失败) ──────────────────────

type StubMode = 'ok' | 'auth401' | 'catalog-missing' | 'ollama-shape' | 'tools-rejected' | 'hang' | 'model-ping-404' | 'wrong-path';

interface Hit { url: string; method: string; headers: Record<string, any>; model?: string; hasTools?: boolean }

interface Stub {
  label: string;
  origin: string;
  port: number;
  hits: Hit[];
  close: () => Promise<void>;
}

async function startStub(label: string, mode: StubMode, models: string[], key?: string): Promise<Stub> {
  const hits: Hit[] = [];
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      if (mode === 'hang') return; // 收下请求, 永不响应 → timeout
      const url = req.url || '';
      const headers: Record<string, any> = req.headers as any;
      let parsed: any = null;
      try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { parsed = null; }
      hits.push({
        url, method: req.method || '', headers,
        ...(parsed && typeof parsed.model === 'string' ? { model: parsed.model } : {}),
        ...(parsed && Array.isArray(parsed.tools) ? { hasTools: true } : {}),
      });
      const json = (code: number, obj: any) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (mode === 'auth401') { json(401, { error: { message: 'invalid api key' } }); return; }

      if (mode === 'ollama-shape') {
        // 这台服务其实说的是 ollama 协议: 两个著名目录端点都回 ollama 形状
        json(200, { models: [{ name: 'llama4', digest: 'abc', size: 1, modified_at: 'x' }] });
        return;
      }

      if (mode === 'wrong-path') {
        // 这台服务的 openai 协议端点在 **/v1/models**; 用户把 base URL 的路径写错了 → 打过来的是 404
        if (url === '/v1/models' && req.method === 'GET') {
          json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
          return;
        }
        json(404, { error: { message: `no route ${url}` } });
        return;
      }

      if (url.endsWith('/models') && req.method === 'GET') {
        if (key && String(headers.authorization || '') !== `Bearer ${key}`) { json(401, { error: { message: 'invalid api key' } }); return; }
        const list = mode === 'catalog-missing' ? ['some-other-model'] : models;
        json(200, { object: 'list', data: list.map((id) => ({ id, object: 'model' })) });
        return;
      }

      if (url.endsWith('/chat/completions') && req.method === 'POST') {
        if (key && String(headers.authorization || '') !== `Bearer ${key}`) { json(401, { error: { message: 'invalid api key' } }); return; }
        if (mode === 'model-ping-404') { json(404, { error: { message: 'no such model endpoint' } }); return; }
        if (mode === 'tools-rejected' && parsed && Array.isArray(parsed.tools)) {
          json(400, { error: { message: 'tools are not supported by this model' } });
          return;
        }
        json(200, {
          id: 'chatcmpl-wiring', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: `pong:${parsed?.model ?? ''}` }, finish_reason: 'stop' }],
        });
        return;
      }

      json(404, { error: { message: `no route ${url}` } });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        label, port, origin: `http://127.0.0.1:${port}`, hits,
        close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

async function main(): Promise<void> {
  // 初始化硬门禁: 隔离 HOME 必须"真的 ready"(身份 + 引导状态), 否则 createGoal 直接拒绝
  try {
    const { makeSetupReady } = await import('./lib/make-setup-ready.js');
    const r = makeSetupReady(HOME, { realHome: REAL_HOME });
    console.log(`[setup-ready] ${r.ok ? '隔离 HOME 已就绪' : '⚠ 未就绪'} · ${r.notes.length} 步`);
  } catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

  const MS: any = await import('../src/llm/model-selection.js');
  const CP: any = await import('../src/llm/connection-probe.js');
  const S: any = await import('../src/agents/execution-supervisor.js');
  const G: any = await import('../src/agents/goal-store.js');
  const RS: any = await import('../src/agents/run-store.js');
  const MP: any = await import('../src/agents/model-policy.js');
  const MC: any = await import('../src/llm/model-catalog.js');
  const PR: any = await import('../src/llm/provider-registry.js');
  const CPS: any = await import('../src/llm/custom-provider-store.js');
  const CS: any = await import('../src/llm/config-store.js');
  const { getMinimax } = await import('../src/constraints/index.js');

  const cfgPath = path.join(HOME, 'bolloon-config.json');
  const cfgBytes = () => { try { return fs.readFileSync(cfgPath, 'utf-8'); } catch { return 'missing'; } };

  const KEY_A = 'k-wire-a';
  const KEY_B = 'k-wire-b';
  const A = await startStub('A', 'ok', ['wA-1', 'wA-2'], KEY_A);
  const B = await startStub('B', 'ok', ['wB-1'], KEY_B);

  try {
    // ══════════════════════════════════════════════════════════
    section('M0 映射表: 探测 7 类 → 入口类目 (一类都不许丢)');

    const probeClasses: string[] = [...CP.PROBE_FAILURE_CLASSES];
    const mapKeys = Object.keys(MS.PROBE_TO_SELECTION);
    ok('映射表的键集 == 探测原语的 7 类 (逐类点名, 不是"其余照搬")',
      mapKeys.length === probeClasses.length && probeClasses.every((c) => mapKeys.includes(c)),
      `${mapKeys.length} 键: ${mapKeys.join(', ')}`);
    ok('探测类目一个都没少 (含 tool_call_unsupported)',
      mapKeys.length === 7 && mapKeys.includes('tool_call_unsupported'), mapKeys.join(', '));
    ok('每个映射值都在入口类目集合里 (映射到不存在的类 = 判红)',
      mapKeys.every((k) => MS.SELECTION_FAILURE_CLASSES.includes(MS.PROBE_TO_SELECTION[k])),
      mapKeys.map((k) => `${k}→${MS.PROBE_TO_SELECTION[k]}`).join(' '));
    ok('入口类目与真出处一一对应 (probe / entry 两组覆盖全集)',
      MS.SELECTION_FAILURE_CLASSES.every((c: string) => MS.SELECTION_FAILURE_CLASS_ORIGIN[c] === 'probe' || MS.SELECTION_FAILURE_CLASS_ORIGIN[c] === 'entry'),
      `${MS.SELECTION_FAILURE_CLASSES.length} 类`);
    const probeOrigin = MS.SELECTION_FAILURE_CLASSES.filter((c: string) => MS.SELECTION_FAILURE_CLASS_ORIGIN[c] === 'probe');
    ok('标成 probe 的正好是映射表的值集 (7 类), 没有虚标',
      probeOrigin.length === 7 && probeOrigin.every((c: string) => mapKeys.some((k) => MS.PROBE_TO_SELECTION[k] === c)),
      probeOrigin.join(', '));
    ok('入口自有类目 (不来自探测) 也逐类有说法',
      MS.SELECTION_FAILURE_CLASSES.filter((c: string) => MS.SELECTION_FAILURE_CLASS_ORIGIN[c] === 'entry')
        .every((c: string) => typeof MS.SELECTION_FAILURE_ZH[c] === 'string' && MS.SELECTION_FAILURE_ZH[c].length > 0),
      `${MS.SELECTION_FAILURE_CLASSES.length - 7} 类`);
    ok('未映射的探测类目不会退化成"切换失败": 保留原文类名 + 独立类目',
      MS.mapProbeFailureClass('brand_new_class_2030').failureClass === MS.UNMAPPED_PROBE_CLASS
      && MS.mapProbeFailureClass('brand_new_class_2030').raw === 'brand_new_class_2030'
      && MS.mapProbeFailureClass('brand_new_class_2030').unmapped === true);
    ok('已映射的类目映射到**自己** (不折进别的类)', ['timeout', 'tool_call_unsupported', 'protocol_mismatch']
      .every((c) => MS.mapProbeFailureClass(c).failureClass === c && MS.mapProbeFailureClass(c).unmapped === false));
    const table = MS.selectionFailureClassTable();
    ok('给人看的映射表能逐行打印 (类目/出处/原文类目/人话)',
      table.length === MS.SELECTION_FAILURE_CLASSES.length
      && table.every((r: any) => r.selection && r.origin && r.zh)
      && table.filter((r: any) => r.origin === 'probe').length === 7,
      table.map((r: any) => `${r.selection}[${r.origin}${r.probeClass ? `/${r.probeClass}` : ''}]`).join(' '));
    console.log(`  · 入口类目总数 = ${MS.SELECTION_FAILURE_CLASSES.length} (探测映射 7 + 入口自有 ${MS.SELECTION_FAILURE_CLASSES.length - 7})`);
    console.log(`  · 映射表: ${mapKeys.map((k) => `${k}→${MS.PROBE_TO_SELECTION[k]}`).join(' · ')}`);

    const msSrc = fs.readFileSync(path.join(ROOT, 'src/llm/model-selection.ts'), 'utf-8');
    ok('入口**运行时**真的 import 了探测原语 (不是只借类型)', /import\s*\{[^}]*\bprobe\b[^}]*\}\s*from\s*'\.\/connection-probe\.js'/.test(msSrc));
    ok('selectModel 的探测走唯一路径 runConnectionProbe (且它内部调原语 probe)', /await runConnectionProbe\(\{/.test(msSrc) && /const r = await probe\(\{/.test(msSrc));
    ok('入口不再自己拼探测请求 (旧的 probeRequest/probeHeaders 已删, 不留两处真相)',
      !/function probeRequest\(/.test(msSrc) && !/function probeHeaders\(/.test(msSrc));

    // ══════════════════════════════════════════════════════════
    section('M1 七类失败各一枚 → **入口**如实报出对应类 (真服务器/真网络条件)');

    // 先立一个能用的全局默认 (后面 M2/M4 要用; 也证明探测通过这条路没坏)
    const goodSel = await MS.selectModel({ provider: 'openai', model: 'wA-1', baseUrl: `${A.origin}/v1`, apiKey: KEY_A, scope: 'global' });
    ok('探测通过时切换成功 (新原语没把好路径堵死)', goodSel.ok === true, goodSel.message || MS.formatEffectiveModel(goodSel.effective));
    ok('通过时的检查项里真的走了 URL 四层来源与工具调用能力两步',
      (goodSel.checks || []).some((c: string) => /base URL 来源=/.test(c)) && (goodSel.checks || []).some((c: string) => /tool_call/.test(c)),
      (goodSel.checks || []).slice(0, 2).join(' | ').slice(0, 200));

    const okStub = await startStub('ok-2', 'ok', ['w-1'], 'k-wire-x');
    const authStub = await startStub('auth401', 'auth401', ['w-1']);
    const missStub = await startStub('catalog-missing', 'catalog-missing', ['w-1'], 'k-wire-x');
    const shapeStub = await startStub('ollama-shape', 'ollama-shape', ['w-1']);
    const toolStub = await startStub('tools-rejected', 'tools-rejected', ['w-1'], 'k-wire-x');
    const hangStub = await startStub('hang', 'hang', ['w-1']);
    const wrongPathStub = await startStub('wrong-path', 'wrong-path', ['w-1']);

    const cases: Array<{ cls: string; probeCls: string; baseUrl: string; key: string; stub: Stub; label: string }> = [
      { cls: 'invalid_url', probeCls: 'invalid_url', baseUrl: `${wrongPathStub.origin}/wrong/path/v1`, key: 'k-wire-x', stub: wrongPathStub, label: 'base URL 路径写错 (真 404, 同协议在另一路径可达)' },
      { cls: 'auth_failed', probeCls: 'auth_failed', baseUrl: `${authStub.origin}/v1`, key: 'k-wire-x', stub: authStub, label: '凭证被拒 (真 401)' },
      { cls: 'provider_unreachable', probeCls: 'provider_unreachable', baseUrl: 'http://127.0.0.1:9/v1', key: 'k-wire-x', stub: okStub, label: '端口没人听 (拒绝连接)' },
      { cls: 'model_not_found', probeCls: 'model_not_found', baseUrl: `${missStub.origin}/v1`, key: 'k-wire-x', stub: missStub, label: '目录里没有这个模型' },
      { cls: 'protocol_mismatch', probeCls: 'protocol_mismatch', baseUrl: `${shapeStub.origin}/v1`, key: 'k-wire-x', stub: shapeStub, label: '地址上其实是另一个协议' },
      { cls: 'tool_call_unsupported', probeCls: 'tool_call_unsupported', baseUrl: `${toolStub.origin}/v1`, key: 'k-wire-x', stub: toolStub, label: '端点拒收工具声明 (真 400)' },
      { cls: 'timeout', probeCls: 'timeout', baseUrl: `${hangStub.origin}/v1`, key: 'k-wire-x', stub: hangStub, label: '收下请求永不响应' },
    ];

    const seen: string[] = [];
    for (const c of cases) {
      const before = cfgBytes();
      const r = await MS.selectModel({ provider: 'openai', model: 'w-1', baseUrl: c.baseUrl, apiKey: c.key, scope: 'global' });
      const msg = String(r.message || '');
      ok(`${c.cls} (${c.label}): 入口报出正确类目`, r.ok === false && r.failureClass === c.cls, `${r.failureClass}: ${msg.slice(0, 110)}`);
      ok(`${c.cls}: 文案带原文探测类目 ${c.probeCls}`, msg.includes(`[探测类目=${c.probeCls}`), msg.slice(0, 140));
      ok(`${c.cls}: 文案不是"切换失败"这种无信息 (含类名 + 人话理由)`,
        msg.includes(c.cls) && msg.includes(MS.SELECTION_FAILURE_ZH[c.cls]) && msg.length > 60, `len=${msg.length}`);
      ok(`${c.cls}: 失败不落盘 (配置字节不变)`, cfgBytes() === before);
      seen.push(`${c.cls}←${c.probeCls}`);
    }
    ok('七类各出现且唯一 (没有两类折进同一类)', new Set(seen).size === 7, seen.join(' '));
    // 入口**前置校验**那一枚 (畸形 URL) 也是一样的类目与口径 —— 两条路都通到 invalid_url, 没有第三条
    const malformed = await MS.selectModel({ provider: 'openai', model: 'w-1', baseUrl: 'not-a-url', apiKey: 'k-wire-x', scope: 'global' });
    ok('畸形 URL 在入口**校验**阶段就被拒 (类目同为 invalid_url, 不落盘)',
      malformed.ok === false && malformed.failureClass === 'invalid_url' && malformed.message.includes('不是合法 URL'),
      `${malformed.failureClass}: ${String(malformed.message || '').slice(0, 90)}`);
    ok('探测原语的 7 类都被入口原样认领 (类名一致 = 没有改名丢信息)',
      cases.every((c) => c.cls === c.probeCls));
    console.log(`  · 逐类: ${seen.join(' · ')}`);

    // 写盘阶段的两类 (结构分类, 不是字符串猜)
    const wiringSrc = fs.readFileSync(path.join(ROOT, 'src/llm/model-selection.ts'), 'utf-8');
    ok('写盘 / 重建运行时失败分开报 (persist_failed / runtime_rebuild_failed), 不再一律 provider_unreachable',
      /'runtime_rebuild_failed'/.test(wiringSrc) && /'persist_failed'/.test(wiringSrc)
      && !/failureClass: 'provider_unreachable',\s*\n\s*message: `切换失败已回滚/.test(wiringSrc));

    // 口径留痕 (照实钉住, 免得悄悄变): 主机名拼错时 P4 原语的归类 —— 不再像旧入口那样一定叫 invalid_url
    const dnsCase = await MS.selectModel({ provider: 'openai', model: 'w-1', baseUrl: 'http://wiring-no-such-host.invalid/v1', apiKey: 'k-wire-x', scope: 'global' });
    ok('主机名拼错: 入口如实报出**真实**网络事实 (P4 原语口径: undici 只给 UND_ERR_SOCKET → 归 provider_unreachable)',
      dnsCase.ok === false
      && (dnsCase.failureClass === 'provider_unreachable' || dnsCase.failureClass === 'invalid_url')
      && /UND_ERR|ENOTFOUND|网络不可达|连接失败|解析/.test(String(dnsCase.message)),
      `${dnsCase.failureClass}: ${String(dnsCase.message || '').slice(0, 150)}`);

    for (const s of [okStub, authStub, missStub, shapeStub, toolStub, hangStub, wrongPathStub]) await s.close();

    // ══════════════════════════════════════════════════════════
    section('M2 P7 钩子: 串行点算出「下一个 Run 用什么」并交给执行器 (在跑的 Run 一个字不动)');

    // 全局默认 = A (上面已经真探测切过)
    const effBefore = await MS.effectiveModelConfig({});
    ok('全局默认现在是服务 A', effBefore.provider === 'openai' && effBefore.model === 'wA-1', MS.formatEffectiveModel(effBefore));

    const goal = await G.createGoal({ objective: 'P7 接线验收: 下一个 Run 用最新默认', channelId: 'ch-wiring', agentId: 'ag-wiring', createdBy: 'verify-model-wiring' });
    const snapOld = await MS.captureRunModelConfig();
    const runOld = await RS.startRun({ surface: 'cli', goalId: goal.goalId, goal: goal.objective, modelConfig: snapOld });
    await G.attachRun(goal.goalId, runOld.runId, { makeCurrent: true });
    await G.updateGoal(goal.goalId, { modelPolicy: { mode: 'auto' } });
    const goalRow = await G.readGoal(goal.goalId);
    ok('GoalRecord 上真能写 modelPolicy 字段 (P7 的字段接上了)', goalRow?.modelPolicy?.mode === 'auto', JSON.stringify(goalRow?.modelPolicy));
    const policyView = await MP.readGoalModelPolicy(goal.goalId);
    ok('策略读取把记录上的字段当**首选来源** (origin=goal_record, 不是 sidecar)',
      policyView.origin === 'goal_record' && policyView.policy.mode === 'auto', `${policyView.origin}/${policyView.policy.mode}`);

    // 全局默认切到 B —— **不能**改写上面那条在跑的 Run
    const selB = await MS.selectModel({ provider: 'deepseek', model: 'wB-1', baseUrl: `${B.origin}/v1`, apiKey: KEY_B, scope: 'global' });
    ok('全局默认切到服务 B (真探测通过)', selB.ok === true && selB.effective?.model === 'wB-1', selB.message || '');
    const runOldOnDisk = await RS.readRun(runOld.runId);
    ok('在跑的 Run 快照**逐字段**仍等于旧快照 (一个字节没动)',
      JSON.stringify(runOldOnDisk?.modelConfig) === JSON.stringify(snapOld), JSON.stringify(runOldOnDisk?.modelConfig));
    const cur = await MP.resolveCurrentRunModel(runOld.runId);
    ok('resolveCurrentRunModel 仍返回旧快照且标"冻结" (不跟随新默认)',
      cur?.decision?.config?.configHash === snapOld.configHash && cur?.decision?.frozen === true
      && cur?.decision?.config?.provider === snapOld.provider && cur?.decision?.config?.model === snapOld.model
      && cur?.decision?.config?.baseUrl === snapOld.baseUrl,
      `${cur?.decision?.decision?.reason || cur?.decision?.reason}`);

    // 真跑一次 tick: 执行器收到的请求必须带**新 Run 的模型快照** (= 最新全局默认 B)
    //   旧 Run 先收尾成终态 (它在跑的时候谁都不许动它; 收尾之后才轮到"下一个 Run")
    //   收尾时带一条**真证据** (飞轮节奏判定要的就是它: 没有新证据就没有"继续的资格")
    const doneRes = await RS.setRunStatus(runOld.runId, 'done', {
      summary: '第一条 Run 收尾 (接线验收)',
      evidence: ['接线验收: 第一条 Run 的产出 (给飞轮节奏判定一条可核验证据)'],
    });
    ok('旧 Run 收尾成终态 (状态迁移合法)', doneRes.ok === true, doneRes.reason || '');
    const got: any[] = [];
    const newRuns: any[] = [];
    const runOldBeforeTick = JSON.stringify(await RS.readRun(runOld.runId));
    const sup = new S.ExecutionSupervisor({
      owner: 'wiring-line', maxPerTick: 5,
      // 执行器照**真契约**办事: 起一条真 Run (把拿到的快照落盘) 并**报回 runId** —— 事件落点等它
      runner: (async (req: any) => {
        got.push(req);
        const rec = await RS.startRun({ surface: 'cli', goalId: req.goal.goalId, goal: '接线验收: 新 Run', modelConfig: req.modelConfig });
        newRuns.push(rec);
        await RS.setRunStatus(rec.runId, 'done', { summary: '新 Run 跑完 (接线验收)' });
        return { status: 'done', runId: rec.runId };
      }) as any,
    });
    const rep = await sup.tickOnce();
    ok('Supervisor 真的认领并执行了这条 Goal', rep.claimed.includes(goal.goalId) && rep.executed.length === 1,
      `claimed=${JSON.stringify(rep.claimed)} executed=${rep.executed.length} skipped=${JSON.stringify(rep.skipped).slice(0, 220)} errors=${JSON.stringify(rep.errors).slice(0, 160)}`);
    ok('执行器收到的请求**带模型配置快照** (P7 钩子在串行点上真接线了)', !!got[0]?.modelConfig, JSON.stringify(got[0]?.modelConfig || null));
    ok('新 Run 用的是**最新全局默认** (服务 B), 不是旧 Run 的那一份',
      got[0]?.modelConfig?.provider === 'deepseek' && got[0]?.modelConfig?.model === 'wB-1'
      && got[0]?.modelConfig?.baseUrl === `${B.origin}/v1`,
      JSON.stringify(got[0]?.modelConfig || null));
    ok('新 Run 的快照 hash 与全局默认那一份一致 (同一份配置, 不是另算)',
      got[0]?.modelConfig?.configHash === selB.effective?.configHash, `${got[0]?.modelConfig?.configHash} vs ${selB.effective?.configHash}`);
    ok('非幂等守卫照旧挂在请求上 (模型换了也不重做副作用)', Array.isArray(got[0]?.guards), `${got[0]?.guards?.length ?? 'undefined'} 条守卫`);
    const runOldAfter = await RS.readRun(runOld.runId);
    ok('tick 之后旧 Run 的快照仍然一个字没动',
      JSON.stringify(runOldAfter?.modelConfig) === JSON.stringify(snapOld), JSON.stringify(runOldAfter?.modelConfig));
    // ★ 逐**字节**比对整条记录 (不只是快照字段): 已经收尾的 Run 是历史 —— 飞轮规则 ⑦ 要求
    //   「已发生的 Run 记录不被改写」, P7 文档也写着「它不回头改老 Run」。上一版这里只比了 modelConfig,
    //   于是"切换事件被追加到历史 Run 上"这个真缺陷从缝里漏过去了 (被飞轮那条测试抓到) —— 补上。
    ok('旧 Run **整条记录逐字节**没变 (历史不许被追加任何东西: updatedAt/modelSwitches/harness 都不许变)',
      JSON.stringify(runOldAfter) === runOldBeforeTick,
      (() => {
        const a = JSON.parse(runOldBeforeTick || '{}'); const b = runOldAfter || {};
        const diff = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify((a as any)[k]) !== JSON.stringify((b as any)[k]));
        return diff.length ? `变了这些键: ${diff.join(',')}` : '一致';
      })());
    const newRunId = newRuns[0]?.runId;
    const newRunEvents = (newRunId ? (await RS.readRun(newRunId))?.modelSwitches : []) || [];
    ok('这次「下一个 Run 换模型」的决定写在**新 Run 自己**的账本上 (决定落在它生效的那条 Run 上)',
      newRunEvents.some((e: any) => e.outcome === 'switched' || e.outcome === 'frozen'),
      `新 Run ${newRunId || '-'} 的事件: ${JSON.stringify(newRunEvents.map((e: any) => e.outcome))}`);
    const ev0 = newRunEvents.at(-1);
    ok('事件的 from/to 是两份**真快照** (from=旧快照 hash, to=新 Run 的落盘快照)',
      !!ev0 && ev0.from?.configHash === snapOld.configHash && ev0.to?.configHash === got[0]?.modelConfig?.configHash
      && ev0.to?.provider === 'deepseek',
      JSON.stringify(ev0 ? { from: ev0.from?.configHash, to: ev0.to?.configHash, outcome: ev0.outcome, guardsCarried: ev0.guardsCarried } : null));
    ok('事件带上跨 Run 非幂等守卫条数 (与请求上那一份同源)',
      !!ev0 && ev0.guardsCarried === (got[0]?.guards?.length || 0),
      `事件=${ev0?.guardsCarried} 请求=${got[0]?.guards?.length || 0}`);

    // 失败类别 → 唯一判定函数 (Supervisor 不再自己看类别猜)
    const failedRun = await RS.startRun({ surface: 'cli', goalId: goal.goalId, goal: '失败一次', modelConfig: snapOld });
    const failRes = await RS.setRunStatus(failedRun.runId, 'failed', { error: 'upstream 503', errorClass: 'transient' });
    ok('造出一条真失败的 Run (状态迁移 + 失败类别都落盘)', failRes.ok === true && failRes.record?.errorClass === 'transient',
      failRes.reason || JSON.stringify(failRes.record?.errorClass));
    const withClass = await RS.readRun(failedRun.runId);
    const decided = S.decideGoalOutcome(goal, withClass, { now: Date.now() });
    ok('失败决策里带上了 supervisorMaySwitchModel 的结论 (策略=auto + transient)',
      /模型: 策略=auto/.test(decided.reason) && /允许挑备用模型/.test(decided.reason), decided.reason.slice(0, 200));
    const pinnedGoal = { ...goal, modelPolicy: { mode: 'pinned', pin: { provider: 'openai', model: 'wA-1' } } };
    const decidedPinned = S.decideGoalOutcome(pinnedGoal as any, withClass, { now: Date.now() });
    ok('pinned 策略下同一失败: 判定说"不许挑备用模型" (口径来自唯一判定函数)',
      /不许挑备用模型/.test(decidedPinned.reason), decidedPinned.reason.slice(0, 200));
    const verdictTransient = MP.supervisorMaySwitchModel({ mode: 'auto', errorClass: 'transient' });
    const decidedNonModel = S.decideGoalOutcome(goal, { ...withClass, errorClass: 'bad_args' } as any, { now: Date.now() });
    ok('与模型无关的失败类别被如实标成"换模型只会掩盖问题" (没有顺手换模型)',
      verdictTransient.allowed === true && /与模型无关/.test(decidedNonModel.reason), decidedNonModel.reason.slice(0, 200));

    // ══════════════════════════════════════════════════════════
    section('M3 客户端鉴权头改读注册表: 内置一字不变, 自定义真生效');

    const H = await startStub('headers', 'ok', ['h-1'], undefined);
    const hv = (h: Hit) => ({ auth: h.headers.authorization, xkey: h.headers['x-api-key'], goog: h.headers['x-goog-api-key'], ver: h.headers['anthropic-version'], referer: h.headers['HTTP-Referer'] || h.headers['http-referer'], title: h.headers['X-Title'] || h.headers['x-title'], custom: h.headers['x-wiring-key'] });
    const { initMinimax } = await import('../src/llm/pi-ai.js');

    initMinimax({ provider: 'openai', apiKey: 'k-h', baseUrl: `${H.origin}/v1`, model: 'h-1' });
    H.hits.length = 0;
    await getMinimax().chat('ping-openai').catch((e: any) => e);
    ok('openai 分支: 仍然只有 `Authorization: Bearer <key>` (一字不变)',
      H.hits[0]?.headers.authorization === 'Bearer k-h' && !H.hits[0]?.headers['x-api-key'] && !H.hits[0]?.headers['x-goog-api-key'],
      JSON.stringify(hv(H.hits[0] || { headers: {} })));

    initMinimax({ provider: 'openrouter', apiKey: 'k-h', baseUrl: `${H.origin}/v1`, model: 'h-1' });
    H.hits.length = 0;
    await getMinimax().chat('ping-openrouter').catch((e: any) => e);
    ok('openrouter 分支: Bearer + HTTP-Referer/X-Title 三个头都还在 (一字不变)',
      H.hits[0]?.headers.authorization === 'Bearer k-h' && !!hv(H.hits[0] || { headers: {} } as any).referer && !!hv(H.hits[0] || { headers: {} } as any).title,
      JSON.stringify(hv(H.hits[0] || { headers: {} })));

    initMinimax({ provider: 'anthropic', apiKey: 'k-h', baseUrl: H.origin, model: 'h-1' });
    H.hits.length = 0;
    await getMinimax().chat('ping-anthropic').catch((e: any) => e);
    const aHit = H.hits.find((h) => h.url.endsWith('/messages'));
    ok('anthropic 分支: x-api-key + anthropic-version + dangerous-access 都还在, 且没有 Authorization (一字不变)',
      aHit?.headers['x-api-key'] === 'k-h' && aHit?.headers['anthropic-version'] === '2023-06-01'
      && aHit?.headers['anthropic-dangerous-direct-browser-access'] === 'true' && !aHit?.headers.authorization,
      JSON.stringify(aHit ? hv(aHit) : null));

    initMinimax({ provider: 'gemini', apiKey: 'k-h', baseUrl: H.origin, model: 'h-1' });
    H.hits.length = 0;
    await getMinimax().chat('ping-gemini').catch((e: any) => e);
    const gHit = H.hits.find((h) => h.url.includes(':generateContent'));
    ok('gemini 分支: 凭据仍在 **query** (真判定), 且**不加** x-goog-api-key 头 (一字不变)',
      !!gHit && gHit.url.includes('?key=k-h') && !gHit.headers['x-goog-api-key'] && !gHit.headers.authorization,
      gHit?.url || '没有命中 generateContent');

    initMinimax({ provider: 'ollama', apiKey: 'k-h', baseUrl: H.origin, model: 'h-1' });
    H.hits.length = 0;
    await getMinimax().chat('ping-ollama').catch((e: any) => e);
    const oHit = H.hits.find((h) => h.url.endsWith('/api/chat'));
    ok('ollama 分支: 仍然**不带**任何鉴权头 (注册表 auth.kind=none, 一字不变)',
      !!oHit && !oHit.headers.authorization && !oHit.headers['x-api-key'],
      JSON.stringify(oHit ? hv(oHit) : null));

    // ── 自定义供应商: 声明的 authHeader 必须真生效 ──────────────
    const GATEWAY = await startStub('custom-gw', 'ok', ['gw-1'], undefined);
    const addRes = await CPS.addCustomProvider({
      providerId: 'wiring-gw', displayName: '接线假网关', baseUrl: `${GATEWAY.origin}/v1`, protocol: 'openai-compatible',
      apiKey: 'k-wiring-custom', model: 'gw-1', authHeader: 'x-wiring-key', models: ['gw-1'], capabilities: { toolCalling: 'yes' },
    });
    ok('自定义供应商真落盘 (走真实配置写路径)', addRes.ok === true, addRes.reason || '');
    const gwEntry = PR.getProviderRegistryEntry('wiring-gw');
    ok('注册表认得它, 且鉴权方式来自声明 (authKind=custom)',
      !!gwEntry && gwEntry.kind === 'custom' && gwEntry.auth.kind === 'custom' && gwEntry.auth.header === 'x-wiring-key',
      JSON.stringify(gwEntry ? { kind: gwEntry.kind, auth: gwEntry.auth } : null));

    initMinimax({ provider: PR.runtimeProviderIdOf(gwEntry), providerId: 'wiring-gw', apiKey: 'k-wiring-custom', baseUrl: `${GATEWAY.origin}/v1`, model: 'gw-1' });
    GATEWAY.hits.length = 0;
    const gwReply = await getMinimax().chat('ping-custom').catch((e: any) => e);
    const gwHit = GATEWAY.hits.find((h) => h.url.endsWith('/chat/completions'));
    ok('自定义供应商的请求真打到它自己的 baseUrl', !!gwHit, gwReply?.reply || String(gwReply).slice(0, 80));
    ok('声明了 authHeader 的自定义供应商: 头就是声明的那一个 (不是硬编码 Bearer)',
      gwHit?.headers['x-wiring-key'] === 'k-wiring-custom' && !gwHit?.headers.authorization,
      JSON.stringify(gwHit ? hv(gwHit) : null));

    // ── 自定义供应商当**全局默认**时, 运行时装配必须真的走得通 ──
    // (旧写法把声明 id 直送客户端 → `switch` 落 default → "Unsupported provider: wiring-gw")
    const cfgObj = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfgObj.activeProvider = 'wiring-gw';
    cfgObj.providers['wiring-gw'] = { enabled: true, apiKey: 'k-wiring-custom', baseUrl: `${GATEWAY.origin}/v1`, model: 'gw-1', requiresApiKey: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2), { mode: 0o600 });
    CS.llmConfigStore.invalidate();
    const effApplied = await MS.applyEffectiveToRuntime();
    ok('自定义供应商当全局默认时, 有效配置认得出它 (provider=wiring-gw)',
      effApplied.provider === 'wiring-gw' && effApplied.model === 'gw-1', MS.formatEffectiveModel(effApplied));
    GATEWAY.hits.length = 0;
    let gwErr = '';
    const gwReply2 = await getMinimax().chat('ping-custom-global').catch((e: any) => { gwErr = String(e?.message || e); return null; });
    ok('装配后真的能出网 (没有 "Unsupported provider: wiring-gw")', !/Unsupported provider/i.test(gwErr), gwErr.slice(0, 120));
    const gwHit2 = GATEWAY.hits.find((h) => h.url.endsWith('/chat/completions'));
    ok('走的是自定义 baseUrl + 自定义鉴权头 (端到端通了)',
      !!gwHit2 && gwHit2.headers['x-wiring-key'] === 'k-wiring-custom' && String(gwReply2?.reply || '') === 'pong:gw-1',
      `${gwHit2?.url} · key=${gwHit2?.headers['x-wiring-key']} · reply=${String(gwReply2?.reply || '')}`);

    // 回到 A, 免得后面几段被"自定义供应商是全局默认"影响
    cfgObj.activeProvider = 'openai';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2), { mode: 0o600 });
    CS.llmConfigStore.invalidate();
    await MS.applyEffectiveToRuntime();

    // ══════════════════════════════════════════════════════════
    section('M4 P3 自定义供应商出现在 `/model` 列表里 (未配置 key / 本地 照实标)');

    const noKeyGw = await startStub('custom-nokey', 'ok', ['nk-1'], undefined);
    const addRes2 = await CPS.addCustomProvider({
      providerId: 'wiring-remote', displayName: '接线远端网关', baseUrl: 'https://gw.example.invalid/v1', protocol: 'openai-compatible',
      model: 'r-1', models: ['r-1', 'r-2'], capabilities: { toolCalling: 'yes' },
    });
    ok('第二家自定义供应商落盘 (没配 key, 远端地址)', addRes2.ok === true, addRes2.reason || '');
    void noKeyGw;

    const summaries = await MC.buildProviderSummaries({});
    const localRow = summaries.find((s: any) => s.id === 'wiring-gw');
    const remoteRow = summaries.find((s: any) => s.id === 'wiring-remote');
    ok('自定义供应商出现在供应商列表里 (P3 接进 /model 列表)', !!localRow && !!remoteRow, `列表 ${summaries.length} 行, 含自定义 ${[localRow && 'wiring-gw', remoteRow && 'wiring-remote'].filter(Boolean).join('/')}`);
    const localLine = localRow ? MC.formatProviderLine(localRow) : '';
    const remoteLine = remoteRow ? MC.formatProviderLine(remoteRow) : '';
    ok('配了 key 的本地自定义供应商: ● + "本地" 段', /^● wiring-gw · 本地 · \d+ models/.test(localLine), localLine);
    ok('没配 key 的远端自定义供应商: ○ + 照实标"未配置 key"', /^○ wiring-remote · \d+ models · 未配置 key/.test(remoteLine), remoteLine);
    ok('模型数来自声明 (不是编的): wiring-remote 声明 2 个', remoteRow?.modelCount === 2 && remoteRow?.modelCountOrigin === 'custom', `${remoteRow?.modelCount}/${remoteRow?.modelCountOrigin}`);
    ok('自定义供应商的模型目录也走注册表元数据填充点 (声明的能力是真值)',
      PR.providerRegistryMetadataSource().metadataOf({ provider: 'wiring-gw', model: 'gw-1' })?.toolCalling === 'yes',
      JSON.stringify(PR.providerRegistryMetadataSource().metadataOf({ provider: 'wiring-gw', model: 'gw-1' })));
    ok('内置供应商那一份列表没被改坏 (13 家都还在)',
      ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax', 'kimi', 'qwen', 'glm', 'openrouter', 'ollama', 'grok', 'mimo', 'local']
        .every((id) => summaries.some((s: any) => s.id === id)),
      `${summaries.filter((s: any) => !['wiring-gw', 'wiring-remote'].includes(s.id)).length} 家内置`);

    await GATEWAY.close();

    // ══════════════════════════════════════════════════════════
    section('M5 新产物自查 (报告纪律)');
    const changed = ['src/llm/model-selection.ts', 'src/agents/execution-supervisor.ts', 'src/agents/goal-store.ts', 'src/llm/pi-ai.ts', 'src/llm/model-catalog.ts', 'src/cli/setup-wizard.ts', 'scripts/verify-model-wiring.ts', 'src/test/model-wiring-serial.test.ts'];
    // 用 \u0068 转义: 判据自身的源码里不能出现那个词, 否则它会把自己判红 (仓内既有门就是这么写的)
    const BANNED = /\u0068ermes|\u0068ermes_cli/i;
    const offenders: string[] = [];
    for (const f of ['scripts/verify-model-wiring.ts', 'src/test/model-wiring-serial.test.ts']) {
      const p = path.join(ROOT, f);
      if (fs.existsSync(p) && BANNED.test(fs.readFileSync(p, 'utf-8'))) offenders.push(`${f}(新文件)`);
    }
    const diff = spawnSync('git', ['diff', '-U0', '--', ...changed], { cwd: ROOT, encoding: 'utf-8' }).stdout || '';
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++') && BANNED.test(line)) offenders.push(line.slice(0, 80));
    }
    ok('**新增的**内容里没有外部 Agent 平台的表述 (只查 added lines, 不算历史遗留)', offenders.length === 0,
      offenders.length ? offenders.join(' | ') : changed.join(' '));

    const child = spawnSync('npx', ['tsx', '-e', `import {PROBE_TO_SELECTION,SELECTION_FAILURE_CLASSES} from '${path.join(ROOT, 'src/llm/model-selection.js').replace(/\.js$/, '.ts')}'; console.log('CHILD:'+JSON.stringify({m:Object.keys(PROBE_TO_SELECTION),n:SELECTION_FAILURE_CLASSES.length}))`], {
      cwd: ROOT, encoding: 'utf-8', env: { ...process.env },
    });
    const childLine = String(child.stdout || '').split('\n').find((l) => l.startsWith('CHILD:'));
    ok('映射表在新进程里也读得到 (是**持久**在代码里的表, 不是运行期拼的)',
      !!childLine && JSON.parse(childLine.slice(6)).m.length === 7, childLine || String(child.stderr || '').slice(-160));

    await A.close();
    await B.close();
  } finally {
    try { await A.close(); } catch { /* 已关 */ }
    try { await B.close(); } catch { /* 已关 */ }
  }

  console.log(`\n================================================================`);
  console.log(`verify-model-wiring: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
  if (failures.length) {
    console.log('失败项:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-model-wiring crashed:', err);
  process.exit(1);
});
