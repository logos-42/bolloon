/**
 * log-gate 单测 (2026-09-26)
 *
 * 覆盖四件事:
 * ① 行分类: 加载日志 (模块 tag / ISO 时间戳 / inspect dump) 判「静默」, Ink 状态栏、Ink 步骤行、JSON 信封判「放行」;
 * ② 信号行 (失败/未就绪/超时/⚠/error/EADDRINUSE) **任何模式下都不许被吞**, 但 `0 个错误` 这类否定式良性计数不算信号;
 * ③ 模式差异: 默认丢弃加载日志 / verbose 一行不改 / cli-interactive 里信号行改道 stderr;
 * ④ 诊断不丢: 被丢弃的行必须真的落进日志文件; 全静默 chunk 也必须回调 (否则 Ink 渲染链会卡死)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isStartupLogLine,
  carriesHumanSignal,
  isStartupVerbose,
  isGateDisabled,
  startupLogPath,
  installStartupLogGate,
  resetStartupLogGate,
  VERBOSE_ENV,
  GATE_ENV,
} from '../cli/log-gate.js';

// ---------------------------------------------------------------------------
// 真实启动输出里的原文 (取自 2026-09-26 实测 `bolloon --web` / `bolloon --cli` 捕获)
// ---------------------------------------------------------------------------
const LOADING_LINES = [
  '[web] webRoot = /Users/apple/Downloads/bolloon/dist/web',
  '[bootstrap] context 收集完成: 62 judgments, 1298 skills',
  '[HumanValueStore] Initialized at /Users/apple/.bolloon/human-values',
  '[createWebServer] bootstrap 完成 (3506ms)',
  '[runs] 对账: 1 条上次中断的运行已标 interrupted (muhxcbn1-f4c7e3)',
  '[supervisor-host] #1 认领 1 · 执行 1 · 跳过 32',
  '[PiAIModel] Initializing with provider: deepseek model: deepseek-v4-flash',
  '[McpAdapter] Discovered 2 MCP servers',
  '[IrohTransport] Started, node: 3c2eeee23cc2d276...',
  '[自愈] 共恢复 1 个丢失的 channel',
  '[agent-registry] OrbitDB 服务注册表 已启用',
  '2026-09-26T06:16:57.905Z [info]: ✅ 智能体验证管理器已创建',
  '2026-09-26T06:17:09.296Z [info]: ✅ Kubo 本地节点完全就绪',
  // 没有 module tag 的启动自述行 (web/server.ts 的 P2P 身份打印)
  '开始生成 P2P 身份...',
  '复用 P2P 身份: did:key:z6MkouEdNKr2sZfJ...',
  'DID: did:key:z6MkouEdNKr2sZfJE7yueyp23dJjCysFsrMLQRJi1hx4fooG',
  'P2P 身份已生成: did:key:z6MkouEdNKr2sZfJE7yueyp23dJjCysFsrMLQRJi1hx4fooG',
];

const KEEP_LINES = [
  // Ink 自己渲染的界面: 状态栏、步骤行、品牌框、技能清单 —— 都不是加载日志
  'minimax · MiniMax-M3  │ real test msg │ ⏱ 0s │ 0/1M │ [░░░░░░░░░░] 0.00%',
  '  ⟳ [1/5] 生成 DIAP 身份',
  '  ✓ [1/5] 复用 DIAP 身份',
  '  ● IPFS 本地 Kubo 就绪 → IPNS 发布/解析可用',
  '╭─────────────────────────── 🚀 Bolloon · 启动面板 ───────────────────────────╮',
  'openclaw-imports: 3d-web-experience, ab-test-setup, academic-deep-research',
  '  "schema": "bolloon-version/1",',
  'bolloon network status',
];

describe('log-gate 行分类', () => {
  it('加载日志行全部判「静默」(模块 tag / ISO 时间戳)', () => {
    for (const l of LOADING_LINES) {
      expect(isStartupLogLine(l), `应判静默: ${l}`).toBe(true);
    }
  });

  it('Ink 渲染内容 / 步骤行 / JSON 信封判「放行」(不能误吞)', () => {
    for (const l of KEEP_LINES) {
      expect(isStartupLogLine(l), `应放行: ${l}`).toBe(false);
    }
  });

  it('console.log 对象转储 (kp.publicKey: Uint8Array(32) [) 是加载日志', () => {
    expect(isStartupLogLine('kp.publicKey: Uint8Array(32) [')).toBe(true);
  });

  it('信号行: 失败 / 未就绪 / 超时 / error / EADDRINUSE 都算「需人介入」', () => {
    for (const l of [
      '[did-catalog] OrbitDB 复制启动失败 (非致命, 稍后可用 API 重试): Cannot access x',
      '[supervisor] 初始化未就绪 (setup, 阶段 identity_pending) → 只诊断, 不执行 Goal',
      '2026-09-26T06:17:21.323Z [warn]:   ⚠️ 守护进程启动超时，可稍后手动运行 `ipfs daemon`',
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:54188",
      'fatal: 端口被占用',
    ]) {
      expect(carriesHumanSignal(l), `应判信号: ${l}`).toBe(true);
    }
  });

  it('零计数短语 (`0 个错误` / `0 个转人工`) 不算信号 —— 否则每次正常启动都留一行噪声', () => {
    expect(carriesHumanSignal('[bootstrap] 完成 (3639ms, 0 个错误)')).toBe(false);
    expect(carriesHumanSignal('  ● Bootstrap 完成 (3506ms, 0 个非致命错误)')).toBe(false);
    // 对账状态行: 全是 0 计数 → 没事要人管, 属噪声
    expect(carriesHumanSignal('[supervisor] 支付对账: 0 条已钉结算事实 · 0 条绝不重付 · 0 条等付款 · **唤醒 3 个 Goal** · 0 个转人工')).toBe(false);
  });

  it('同一行里除了零计数**还有**别的失败/超时 → 仍然算信号 (抠短语不等于放行整行)', () => {
    expect(carriesHumanSignal('[supervisor] 支付对账失败: 0 个转人工, 请人工核对 ledger')).toBe(true);
    expect(carriesHumanSignal('2026-09-26T06:17:21.323Z [warn]: 对账 0 个错误但连接超时')).toBe(true);
  });

  it('真有人要介入的 N>0 计数仍算信号 (5 个转人工 ≠ 0 个转人工)', () => {
    expect(carriesHumanSignal('[supervisor] 支付对账: 5 个转人工, 需人工处理')).toBe(true);
  });
});

describe('log-gate verbose / 逃生口 / 日志路径', () => {
  it('--verbose / BOLLOON_VERBOSE=1 都算诊断模式', () => {
    expect(isStartupVerbose(['--cli', '--verbose'], {})).toBe(true);
    expect(isStartupVerbose(['--verbose=true'], {})).toBe(true);
    expect(isStartupVerbose(['--cli'], { [VERBOSE_ENV]: '1' })).toBe(true);
    expect(isStartupVerbose(['--cli'], { [VERBOSE_ENV]: 'on' })).toBe(true);
    expect(isStartupVerbose(['--cli'], {})).toBe(false);
    expect(isStartupVerbose(['--cli'], { [VERBOSE_ENV]: '0' })).toBe(false);
  });

  it(`${GATE_ENV}=0 是彻底不装闸门 (与 verbose 的区别: verbose 仍写文件)`, () => {
    expect(isGateDisabled({ [GATE_ENV]: '0' })).toBe(true);
    expect(isGateDisabled({ [GATE_ENV]: 'off' })).toBe(true);
    expect(isGateDisabled({ [GATE_ENV]: '1' })).toBe(false);
    expect(isGateDisabled({})).toBe(false);
  });

  it('日志路径: BOLLOON_HOME 优先, 否则 homedir/.bolloon/logs/startup.log', () => {
    expect(startupLogPath({ BOLLOON_HOME: '/tmp/x' }, '/home/u')).toBe('/tmp/x/logs/startup.log');
    expect(startupLogPath({}, '/home/u')).toBe(path.join('/home/u', '.bolloon', 'logs', 'startup.log'));
  });
});

// ---------------------------------------------------------------------------
// 闸门行为: 直接换掉 process.stdout/stderr.write 与 console.* 再装闸门
// (闸门在 install 时 bind 当前 write, 所以替换必须发生在 install 之前)
// ---------------------------------------------------------------------------

let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error; info: typeof console.info; debug: typeof console.debug };
let out: string[] = [];
let err: string[] = [];
let tmpDir = '';

function capture(): void {
  out = [];
  err = [];
  process.stdout.write = ((chunk: any, encOrCb?: any, cb?: any) => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    const f = typeof encOrCb === 'function' ? encOrCb : cb;
    if (typeof f === 'function') f();
    return true;
  }) as any;
  process.stderr.write = ((chunk: any, encOrCb?: any, cb?: any) => {
    err.push(typeof chunk === 'string' ? chunk : String(chunk));
    const f = typeof encOrCb === 'function' ? encOrCb : cb;
    if (typeof f === 'function') f();
    return true;
  }) as any;
}

beforeEach(() => {
  savedWrite = process.stdout.write;
  savedErrWrite = process.stderr.write;
  savedConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-gate-'));
});

afterEach(() => {
  resetStartupLogGate();
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  console.log = savedConsole.log;
  console.warn = savedConsole.warn;
  console.error = savedConsole.error;
  console.info = savedConsole.info;
  console.debug = savedConsole.debug;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
});

describe('log-gate 默认静默 (dashboard/web 面)', () => {
  it('加载日志不上控制台, 普通行原样放行', () => {
    capture();
    const gate = installStartupLogGate({ mode: 'web', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    process.stdout.write('[web] webRoot = /x\nminimax · MiniMax-M3  │ ⏱ 0s\n[bootstrap] 完成 (3506ms, 0 个错误)\n');
    expect(gate.filtering).toBe(true);
    expect(out.join('')).toBe('minimax · MiniMax-M3  │ ⏱ 0s\n');
    expect(gate.stats.suppressed).toBe(2);
    expect(gate.stats.forwarded).toBe(1);
  });

  it('信号行放行 (错误/降级不许被吞)', () => {
    capture();
    const gate = installStartupLogGate({ mode: 'web', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    process.stdout.write('[supervisor] 初始化未就绪 (setup, 阶段 identity_pending) → 只诊断, 不执行 Goal\n');
    expect(out.join('')).toContain('初始化未就绪');
    expect(gate.stats.signalKept).toBe(1);
  });

  it('整 chunk 全被静默时仍回调一次 (Ink 渲染链依赖 write callback)', async () => {
    capture();
    installStartupLogGate({ mode: 'web', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    let cbCalled = false;
    process.stdout.write('[web] webRoot = /x\n[bootstrap] 完成 (1ms, 0 个错误)\n', () => { cbCalled = true; });
    expect(out.join('')).toBe('');
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => setTimeout(r, 5));
    expect(cbCalled).toBe(true);
  });

  it('诊断不丢: 被静默的行落到日志文件', () => {
    capture();
    const logPath = path.join(tmpDir, 'nested', 'startup.log');
    const gate = installStartupLogGate({ mode: 'web', args: [], logPath, env: {} });
    process.stdout.write('[HumanValueStore] Initialized at /x\n[bootstrap] 完成 (1ms, 0 个错误)\n');
    const body = fs.readFileSync(logPath, 'utf8');
    expect(body).toContain('[HumanValueStore] Initialized at /x');
    expect(body).toContain('[bootstrap] 完成 (1ms, 0 个错误)');
    expect(gate.stats.fileLines).toBe(2);
    expect(gate.stats.fileError).toBeNull();
  });

  it('verbose: 一行不改地全量回流 (同时仍写文件)', () => {
    capture();
    const logPath = path.join(tmpDir, 'startup.log');
    const gate = installStartupLogGate({ mode: 'web', verbose: true, logPath, env: {} });
    const chunk = '[web] webRoot = /x\n[bootstrap] 完成 (1ms, 0 个错误)\n';
    process.stdout.write(chunk);
    expect(gate.filtering).toBe(false);
    expect(out.join('')).toBe(chunk);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('[web] webRoot = /x');
  });

  it(`${GATE_ENV}=0: 不装闸门 (env 逃生口)`, () => {
    capture();
    const gate = installStartupLogGate({ mode: 'web', args: [], logPath: path.join(tmpDir, 'startup.log'), env: { [GATE_ENV]: '0' } });
    process.stdout.write('[web] webRoot = /x\n');
    expect(gate.filtering).toBe(false);
    expect(out.join('')).toBe('[web] webRoot = /x\n');
  });
});

describe('log-gate CLI 交互面 (stdout 归 Ink)', () => {
  it('console.log 的加载日志不进 stdout; 信号行改道 stderr', () => {
    capture();
    installStartupLogGate({ mode: 'cli-interactive', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    console.log('[PiAIModel] Initializing with provider: deepseek');
    console.log('[supervisor] 初始化未就绪 (setup, 阶段 identity_pending) → 只诊断, 不执行 Goal');
    expect(out.join('')).toBe('');                       // stdout 一行都没被占 (Ink 画布干净)
    expect(err.join('')).toContain('初始化未就绪');        // 但需要人介入的那行看得见
    expect(err.join('')).not.toContain('PiAIModel');
  });

  it('console.error 永远可见 (走 stderr)', () => {
    capture();
    installStartupLogGate({ mode: 'cli-interactive', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    console.error('Fatal: listen EADDRINUSE 127.0.0.1:54188');
    expect(err.join('')).toContain('EADDRINUSE');
  });

  it('Ink 的 ANSI 渲染原样放行', () => {
    capture();
    installStartupLogGate({ mode: 'cli-interactive', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    const frame = '\x1b[2K╭─ 🚀 Bolloon · 启动面板 ─╮\n│ ⟳ 正在加载技能 / 工具... │\n';
    process.stdout.write(frame);
    expect(out.join('')).toBe(frame);
  });

  it('stop() 之后行为回到原样 (不改变调用方后续输出)', () => {
    capture();
    const gate = installStartupLogGate({ mode: 'cli-interactive', args: [], logPath: path.join(tmpDir, 'startup.log'), env: {} });
    gate.stop();
    resetStartupLogGate();
    process.stdout.write('[web] webRoot = /x\n');
    expect(out.join('')).toBe('[web] webRoot = /x\n');
  });
});
