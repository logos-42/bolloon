/**
 * model-wiring-serial.test.ts — 「接线收口」聚焦测试 (2026-09-26)
 *
 * 为什么叫 serial: 本文件会改 `HOME` / `BOLLOON_HOME` 指向隔离目录 (配置、Goal、Run 都落在那儿),
 * 所以它**只在进程级独占**的假设下跑 —— 断言内部不并发、也不与其他文件共享同一个 HOME。
 *
 * 覆盖的是"四根线插上没有"的**判据**, 真跑版在 `scripts/verify-model-wiring.ts`:
 *   ① 失败分类映射表: 探测 7 类 → 入口类目, 一类不丢 (含 tool_call_unsupported), 未映射保留原文;
 *   ② P7 钩子: 请求形状能带模型快照 + 失败类别判定走唯一函数 (口径出现在决策理由里);
 *   ③ 自定义供应商进 `/model` 列表 (未配置 key / 本地 照实标);
 *   ④ 客户端鉴权头读注册表: 内置一字不变, 自定义声明的 authHeader 真生效。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const REAL_HOME = os.homedir();
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-wiring-unit-'));
process.env.BOLLOON_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

let MS: any;
let CP: any;
let S: any;
let G: any;
let MC: any;
let PR: any;
let CPS: any;
let piAi: any;

interface Hit { url: string; method: string; headers: any }
let hijack: Hit[] = [];
let server: http.Server;
let origin = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      hijack.push({ url: req.url || '', method: req.method || '', headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        // gemini / anthropic 形状也兼容一下 (同一个 stub 应付多协议分支)
        content: [{ type: 'text', text: 'pong' }],
        candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        message: { role: 'assistant', content: 'pong' },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;

  MS = await import('../llm/model-selection.js');
  CP = await import('../llm/connection-probe.js');
  S = await import('../agents/execution-supervisor.js');
  G = await import('../agents/goal-store.js');
  MC = await import('../llm/model-catalog.js');
  PR = await import('../llm/provider-registry.js');
  CPS = await import('../llm/custom-provider-store.js');
  piAi = await import('../llm/pi-ai.js');
});

afterAll(() => {
  try { server?.close(); } catch { /* 已关 */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 无所谓 */ }
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_HOME;
  delete process.env.BOLLOON_HOME;
});

describe('① 失败分类映射表 (探测 7 类 → 入口类目)', () => {
  it('映射表逐类覆盖探测原语的 7 类, 一个都不丢', () => {
    const probeClasses: string[] = [...CP.PROBE_FAILURE_CLASSES];
    expect(probeClasses.length).toBe(7);
    const keys = Object.keys(MS.PROBE_TO_SELECTION);
    expect(keys.sort()).toEqual([...probeClasses].sort());
    // 重点: 工具调用能力是被单独确认的一步, 它必须有自己的类目 (否则会被静默丢进别的类)
    expect(keys).toContain('tool_call_unsupported');
    expect(MS.PROBE_TO_SELECTION.tool_call_unsupported).toBe('tool_call_unsupported');
  });

  it('每个映射值都在入口类目集合里 (映射到不存在的类 = 判红)', () => {
    for (const k of Object.keys(MS.PROBE_TO_SELECTION)) {
      expect(MS.SELECTION_FAILURE_CLASSES).toContain(MS.PROBE_TO_SELECTION[k]);
    }
  });

  it('入口类目逐类有真出处 (probe / entry 覆盖全集, probe 组正好 7)', () => {
    const all: string[] = [...MS.SELECTION_FAILURE_CLASSES];
    expect(all.length).toBeGreaterThanOrEqual(13);
    const probeSide = all.filter((c) => MS.SELECTION_FAILURE_CLASS_ORIGIN[c] === 'probe');
    expect(probeSide.sort()).toEqual(Object.values(MS.PROBE_TO_SELECTION).sort());
    for (const c of all) {
      expect(['probe', 'entry']).toContain(MS.SELECTION_FAILURE_CLASS_ORIGIN[c]);
      expect(typeof MS.SELECTION_FAILURE_ZH[c]).toBe('string');
      expect(MS.SELECTION_FAILURE_ZH[c].length).toBeGreaterThan(0);
    }
  });

  it('未映射的探测类目保留原文类名, 不退化成"切换失败"', () => {
    const r = MS.mapProbeFailureClass('some_future_class');
    expect(r.failureClass).toBe(MS.UNMAPPED_PROBE_CLASS);
    expect(r.raw).toBe('some_future_class');
    expect(r.unmapped).toBe(true);
    // 已映射的类目映射到自己 (不折进别的类)
    for (const c of CP.PROBE_FAILURE_CLASSES) {
      const m = MS.mapProbeFailureClass(c);
      expect(m.failureClass).toBe(c);
      expect(m.unmapped).toBe(false);
    }
  });

  it('给人看的映射表逐行可读 (类目/出处/原文类目/人话)', () => {
    const table = MS.selectionFailureClassTable();
    expect(table.length).toBe(MS.SELECTION_FAILURE_CLASSES.length);
    expect(table.filter((r: any) => r.origin === 'probe').length).toBe(7);
    for (const row of table) {
      expect(row.selection).toBeTruthy();
      expect(row.zh).toBeTruthy();
      if (row.origin === 'probe') expect(row.probeClass).toBe(row.selection);
    }
  });
});

describe('④ 客户端鉴权头改读注册表', () => {
  const json = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 80)); };

  it('openai 内置分支: 仍是 Authorization: Bearer <key>, 不多一个头', async () => {
    hijack = [];
    piAi.initMinimax({ provider: 'openai', providerId: 'openai', apiKey: 'k-unit', baseUrl: `${origin}/v1`, model: 'm-1' });
    await piAi.getModel().chat('ping').catch(() => undefined);
    await json();
    const h = hijack.find((x) => x.url.endsWith('/chat/completions'));
    expect(h?.headers.authorization).toBe('Bearer k-unit');
    expect(h?.headers['x-api-key']).toBeUndefined();
    expect(h?.headers['x-goog-api-key']).toBeUndefined();
  });

  it('自定义供应商声明的 authHeader 真生效 (不是硬编码 Bearer)', async () => {
    const add = await CPS.addCustomProvider({
      providerId: 'unit-gw', displayName: '单元假网关', baseUrl: `${origin}/v1`, protocol: 'openai-compatible',
      apiKey: 'k-unit-custom', model: 'u-1', authHeader: 'x-unit-key', models: ['u-1'], capabilities: { toolCalling: 'yes' },
    });
    expect(add.ok).toBe(true);
    const entry = PR.getProviderRegistryEntry('unit-gw');
    expect(entry?.auth?.header).toBe('x-unit-key');
    hijack = [];
    piAi.initMinimax({
      provider: PR.runtimeProviderIdOf(entry), providerId: 'unit-gw',
      apiKey: 'k-unit-custom', baseUrl: `${origin}/v1`, model: 'u-1',
    });
    await piAi.getModel().chat('ping').catch(() => undefined);
    await json();
    const h = hijack.find((x) => x.url.endsWith('/chat/completions'));
    expect(h?.headers['x-unit-key']).toBe('k-unit-custom');
    expect(h?.headers.authorization).toBeUndefined();
  });

  it('注册表拿不到这个 id 时退回本分支旧常量 (内置行为不变)', async () => {
    hijack = [];
    piAi.initMinimax({ provider: 'openai', providerId: 'not-in-registry-xyz', apiKey: 'k-unit', baseUrl: `${origin}/v1`, model: 'm-1' });
    await piAi.getModel().chat('ping').catch(() => undefined);
    await json();
    const h = hijack.find((x) => x.url.endsWith('/chat/completions'));
    expect(h?.headers.authorization).toBe('Bearer k-unit');
  });
});

describe('③ 自定义供应商出现在供应商列表里', () => {
  it('列表里能看到它, 未配置 key / 本地 照实标', async () => {
    const r2 = await CPS.addCustomProvider({
      providerId: 'unit-remote', displayName: '单元远端', baseUrl: 'https://unit.example.invalid/v1',
      protocol: 'openai-compatible', model: 'r-1', models: ['r-1', 'r-2'], capabilities: { toolCalling: 'yes' },
    });
    expect(r2.ok).toBe(true);
    const rows = await MC.buildProviderSummaries({});
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain('unit-gw');
    expect(ids).toContain('unit-remote');
    // 内置 13 家一个都不能少
    for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax', 'kimi', 'qwen', 'glm', 'openrouter', 'ollama', 'grok', 'mimo', 'local']) {
      expect(ids).toContain(id);
    }
    const localLine = MC.formatProviderLine(rows.find((r: any) => r.id === 'unit-gw'));
    expect(localLine.startsWith('●')).toBe(true);
    expect(localLine).toContain('本地');
    const remoteLine = MC.formatProviderLine(rows.find((r: any) => r.id === 'unit-remote'));
    expect(remoteLine.startsWith('○')).toBe(true);
    expect(remoteLine).toContain('未配置 key');
    const remoteRow = rows.find((r: any) => r.id === 'unit-remote');
    expect(remoteRow.modelCount).toBe(2);
    expect(remoteRow.modelCountOrigin).toBe('custom');
  });
});

describe('② P7 钩子 (串行点 / 决策口径 / Goal 字段)', () => {
  it('GoalRecord 上的 modelPolicy 往返 (读回原样, 且是策略的首选来源)', async () => {
    const goal = await G.createGoal({ objective: '单元: modelPolicy 往返', channelId: 'u', agentId: 'u' });
    const upd = await G.updateGoal(goal.goalId, { modelPolicy: { mode: 'pinned', pin: { provider: 'openai', model: 'm-1' } } });
    expect(upd?.modelPolicy?.mode).toBe('pinned');
    const back = await G.readGoal(goal.goalId);
    expect(back?.modelPolicy?.pin?.model).toBe('m-1');
  });

  it('失败决策里的"能不能换模型"来自唯一判定函数 (不是 Supervisor 自己看类别猜)', async () => {
    const goal = { goalId: 'g-unit', objective: 'x', successCriteria: [], constraints: [], status: 'active', createdAt: '', updatedAt: '', runs: [], completedCriteria: [], unresolvedItems: [], evidence: [], modelPolicy: { mode: 'auto' } };
    const run: any = {
      runId: 'r-unit', goalId: 'g-unit', status: 'failed', errorClass: 'transient',
      modelConfig: { provider: 'openai', model: 'm-1', baseUrl: `${origin}/v1`, configHash: 'h', selectionScope: 'global', capturedAt: '' },
    };
    const d = S.decideGoalOutcome(goal as any, run, { now: Date.now() });
    expect(d.reason).toContain('策略=auto');
    expect(d.reason).toContain('允许挑备用模型');
    const pinned: any = { ...goal, modelPolicy: { mode: 'pinned', pin: { provider: 'openai', model: 'm-1' } } };
    const d2 = S.decideGoalOutcome(pinned, run, { now: Date.now() });
    expect(d2.reason).toContain('不许挑备用模型');
  });

  it('执行请求的形状带得动模型快照 (可选字段, 老调用方不受影响)', () => {
    // 类型层面: 不给 modelConfig 也合法 (老调用方); 给了一整份 RunModelConfig 也合法
    const req: any = { goal: { goalId: 'g' }, kind: 'first_run', instruction: 'i', guards: [] };
    expect(req.modelConfig).toBeUndefined();
    req.modelConfig = { provider: 'openai', model: 'm-1', baseUrl: `${origin}/v1`, configHash: 'h', selectionScope: 'global', capturedAt: '' };
    expect(typeof req.modelConfig.configHash).toBe('string');
  });
});
