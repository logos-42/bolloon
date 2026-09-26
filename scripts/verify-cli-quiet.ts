#!/usr/bin/env node
/**
 * verify-cli-quiet.ts — 「启动期加载日志默认静默」的验收门 (2026-09-26)
 *
 * 它要证明的是 **四件互相独立的事**, 缺一件都算没做到:
 *   A2 默认模式: 加载日志从控制台消失 (给出前后真实行数)
 *   A3 诊断模式: `--verbose` / `BOLLOON_VERBOSE=1` 时原来的行**一字不少地回来**
 *   A4 诊断不丢: 默认模式控制台看不到的那些行, 在日志文件里查得到 (同一进程内逐字比对)
 *   A5/A6 错误不吞: 启动期的降级/错误信息 (含定向注入的真错误) 照样显示
 * 另加 A7 (CLI 交互启动: 静默但保留 spinner/门禁提示) 与 A8 (子命令 / `--version json` 不受影响)。
 *
 * 用法:
 *   npx tsx scripts/verify-cli-quiet.ts                  # 全跑
 *   npx tsx scripts/verify-cli-quiet.ts --only-default   # 只跑「基线 + 默认静默」(变异对照用)
 *   npx tsx scripts/verify-cli-quiet.ts --window 26      # B/D/V 三轮的观察窗口秒数 (默认 26; A6/A7 固定 20s)
 *   npx tsx scripts/verify-cli-quiet.ts --mutation       # 阴性对照: 打成不过滤 → A2 必须红 → 恢复 → 必须绿
 *
 * 判据全部**真跑真进程** (`dist/cli-entry.js` / `dist/index.js`), 不调库函数。
 * 「加载日志」的形状判据在本文件里**独立重写** (不 import isStartupLogLine —— 那会用自己证明自己)。
 * 日志文件路径按**已文档化的契约**独立算一遍: `BOLLOON_HOME` 优先, 否则 `~/.bolloon` + `/logs/startup.log`。
 * A7 用 macOS 自带 `script -q /dev/null` 开真 pty —— Ink 的 TUI 没有 TTY 就不渲染, 拿管道测等于没测。
 * ⚠️ `--mutation` 会临时改写 `src/cli/log-gate.ts` 并 `tsc` (try/finally 恢复), 它不 push。
 */
import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = process.cwd();
const ENTRY = path.join(ROOT, 'dist', 'cli-entry.js');
const MAIN = path.join(ROOT, 'dist', 'index.js');
const GATE_SRC = path.join(ROOT, 'src', 'cli', 'log-gate.ts');
/** 独立算日志文件路径 (已文档化的契约: `BOLLOON_HOME` 优先, 否则 `~/.bolloon`) —— 不 import 被测模块 */
const DATA_DIR = (process.env.BOLLOON_HOME ?? '').trim() || path.join(os.homedir(), '.bolloon');
const LOG_PATH = path.join(DATA_DIR, 'logs', 'startup.log');

const argv = process.argv.slice(2);
const argVal = (name: string, dflt: number): number => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const WINDOW_MS = argVal('--window', 26) * 1000;
const SHORT_MS = 20_000;
const MUTATION = argv.includes('--mutation');
const ONLY_DEFAULT = argv.includes('--only-default');
const HAS_PTY_CMD = fs.existsSync('/usr/bin/script');

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

/** 「加载日志」的行形状: module tag (`[web]`/`[自愈]`) · ISO 时间戳 · 无 tag 的启动自述行 */
const LOADING_RE = /^\s*(?:\[[A-Za-z_][A-Za-z0-9_.:-]*\]|\[[\u4e00-\u9fff][^\]\n]{0,24}\]|20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d|开始生成 P2P 身份\.\.\.$|(?:复用|新建) P2P 身份: |P2P 身份已生成: |DID: did:)/;

/** 「错误 / 降级 / 需人介入」的行 —— 这些**任何模式下都必须出现** */
const SIGNAL_RE = /失败|错误|异常|未就绪|不可用|降级|超时|转人工|警告|⚠|⛔|❌|✗|\berror\b|\bfatal\b|\bwarn(?:ing)?\b|EACCES|EADDRINUSE/i;

/** 「零计数」短语 (`0 个错误` / `0 个转人工`): 抠掉之后**还剩下**信号词才算信号 (与实现同口径, 独立写一遍) */
const BENIGN_COUNT = /0\s*(?:个|条)(?:非致命)?(?:错误|转人工|失败|异常)|no errors?|0 errors?/gi;

const isHumanSignalLine = (l: string): boolean => SIGNAL_RE.test(l.replace(BENIGN_COUNT, ' '));
const isPureLoading = (l: string): boolean => LOADING_RE.test(l) && !isHumanSignalLine(l);
/** 剥掉行首 ISO 时间戳: 两个进程的同一行日志时间戳必然不同, 比的是载荷 */
const payload = (l: string): string => l.replace(/^\s*20\d\d-\d\d-\d\dT[\d:.]+Z\s+/, '').trimEnd();
/** 去掉 ANSI 转义 (Ink 可能把一个词拆在两次 write 里) */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/**
 * 行身份: 把「每轮必然不同」的部分归一 —— CID/DID/hex 指纹 · 随机 worker/对端 id · 耗时/计数。
 * 只用于 A3 的「同一行回来了」比对; 不含数字的稳定行由 A3b 做**逐字**比对。
 */
const ident = (l: string): string => payload(l)
  .replace(/[1-9A-Za-z]{16,}/g, '<token>')
  .replace(/\b(?=[\w-]*\d)[\w-]{8,}/g, '<id>')
  .replace(/\d+/g, '#');

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

type Check = { name: string; ok: boolean | 'skip'; detail: string };
const results: Check[] = [];
function record(name: string, ok: boolean | 'skip', detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok === 'skip' ? '⊘ SKIP' : ok ? '✓ PASS' : '✗ FAIL'}  ${name} — ${detail}`);
}
function assert(name: string, ok: boolean, detail: string): void { record(name, ok, detail); }

// ---------------------------------------------------------------------------
// 真跑 (真入口 / 真进程 / 真窗口)
// ---------------------------------------------------------------------------

interface Proc {
  child: ReturnType<typeof spawn>;
  out: () => string;
  err: () => string;
  lines: () => string[];
  code: () => number | null;
}

function spawnCli(args: string[], env: Record<string, string>, viaPty = false): Proc & { exited: Promise<number | null> } {
  // viaPty: Ink 的 TUI 需要真 TTY, 否则直接抛 "Raw mode is not supported";
  //   用 macOS 自带 `script -q /dev/null <cmd>` 开一个 pty, 不加依赖。
  const [cmd, cmdArgs] = viaPty && HAS_PTY_CMD
    ? ['/usr/bin/script', ['-q', '/dev/null', process.execPath, ...args]]
    : [process.execPath, args];
  // detached: 让 `cli-entry.js → index.js` 这棵树进**同一个新进程组**,
  //   否则 kill 只杀掉 cli-entry, 孙进程 index.js 会活着占着管道 → `close` 永不触发 (曾把门挂死)。
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { err += d.toString(); });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', () => resolve(child.exitCode));
  });
  return {
    child,
    exited,
    out: () => out,
    err: () => err,
    lines: () => `${out}${err}`.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0),
    code: () => child.exitCode,
  };
}

/** 杀掉整棵进程树 (进程组) —— 长驻 dashboard 的孙进程也要一起下去 */
function killTree(p: ReturnType<typeof spawnCli>): void {
  const pid = p.child.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { p.child.kill('SIGKILL'); } catch { /* 已退出 */ } }
}

/** 观察窗口: 到点杀整棵树; 等 stdio 关干净再取文本, 且有硬上界 (门永远不许挂死) */
async function observe(p: ReturnType<typeof spawnCli>, ms: number): Promise<ReturnType<typeof spawnCli>> {
  const t = setTimeout(() => killTree(p), ms);
  await Promise.race([p.exited, new Promise((res) => setTimeout(res, ms + 6000))]);
  clearTimeout(t);
  killTree(p); // 兜底: 保证不留后台残留
  await Promise.race([p.exited, new Promise((res) => setTimeout(res, 1500))]);
  return p;
}

function logSize(): number {
  try { return fs.statSync(LOG_PATH).size; } catch { return 0; }
}
function readLogRegion(from: number): string {
  try { return fs.readFileSync(LOG_PATH).subarray(from).toString('utf8'); } catch { return ''; }
}

const BASE_ENV = { BOLLOON_SKIP_UPDATE: '1', BOLLOON_SKIP_SETUP: '1' };
const GATE_OFF_ENV = { ...BASE_ENV, BOLLOON_LOG_GATE: '0' };
const VERBOSE_ENV = { ...BASE_ENV, BOLLOON_VERBOSE: '1' };

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`\n=== verify-cli-quiet (窗口 ${WINDOW_MS / 1000}s · entry=${path.relative(ROOT, ENTRY)}${ONLY_DEFAULT ? ' · 只跑默认静默' : ''}) ===\n`);

  // B: 基线 (闸门不装 = 完全没有静默)
  const base = await observe(spawnCli([ENTRY, '--web'], GATE_OFF_ENV), WINDOW_MS);
  const basePure = [...new Set(base.lines().filter(isPureLoading))];
  const baseSig = [...new Set(base.lines().filter(isHumanSignalLine))];
  console.log(`[基线 LOG_GATE=0] 控制台总行数=${base.lines().length} · 加载日志类=${basePure.length} · 信号行=${baseSig.length}`);

  assert('A1 前置: 基线里真的存在加载日志行 (否则「静默」这条断言恒真 = 空门)',
    basePure.length >= 5,
    `基线加载日志类 ${basePure.length} 行 (期望 ≥5); 样本: ${basePure.slice(0, 2).join(' | ') || '(空)'}`);
  if (basePure.length < 5) {
    console.log('\n基线都量不到加载日志 → 不继续跑 (后面的静默断言会白绿)。');
    printSummary();
    return 1;
  }
  // B2: 再跑一轮基线 —— 拿「两轮都出现」的行当**跨进程比对基准**
  //   (P2P 新连接、超时告警这类"事件"不是每轮都有, 拿单轮当基准会把「事件没再发生」误判成「诊断没回流」)
  const base2 = await observe(spawnCli([ENTRY, '--web'], GATE_OFF_ENV), WINDOW_MS);
  const base2Idents = new Set(base2.lines().map(ident));
  const stablePure = basePure.filter((l) => base2Idents.has(ident(l)));
  const volatilePure = basePure.filter((l) => !base2Idents.has(ident(l)));
  console.log(`[基线#2]       控制台总行数=${base2.lines().length} · 两轮都出现的稳定加载日志=${stablePure.length} · 单轮特有(事件类)=${volatilePure.length}`);

  assert('A1b 前置: 跨轮稳定样本足够多 (否则「一字不少地回来」这条断言样本太薄)',
    stablePure.length >= 20,
    `两轮基线交集 ${stablePure.length} 行 (期望 ≥20); 单轮特有 ${volatilePure.length} 行 (事件类, 不参与跨进程比对`
      + (volatilePure.length ? `, 例: ${volatilePure[0].slice(0, 100)}` : '') + ')');

  // D: 默认模式
  const dStart = logSize();
  const def = await observe(spawnCli([ENTRY, '--web'], BASE_ENV), WINDOW_MS);
  const dRegion = readLogRegion(dStart);
  const defPure = def.lines().filter(isPureLoading);
  const defSig = def.lines().filter(isHumanSignalLine);
  console.log(`[默认模式]     控制台总行数=${def.lines().length} · 加载日志类=${defPure.length} · 信号行=${defSig.length}`);

  assert('A2 默认静默: 加载日志不上控制台 (给前后真实行数)',
    defPure.length === 0,
    `控制台总行数 ${base.lines().length} → ${def.lines().length}; 加载日志类 ${basePure.length} → ${defPure.length}`
      + (defPure.length ? `; 残留: ${defPure.slice(0, 3).join(' | ')}` : ''));

  if (ONLY_DEFAULT) {
    printSummary();
    return results.some((r) => r.ok === false) ? 1 : 0;
  }

  // V: 诊断模式 (env 开关)
  //   V 轮的窗口比基线**长 8s**: 基线里有些行在 24-26s (IPNS 发布序列) 才出现,
  //   窗口一样长会变成「比赛谁先被杀」—— 那会把「诊断没回流」和「采样边界」混在一起。
  const VER_WINDOW_MS = WINDOW_MS + 8000;
  const vStart = logSize();
  const ver = await observe(spawnCli([ENTRY, '--web'], VERBOSE_ENV), VER_WINDOW_MS);
  const vRegion = readLogRegion(vStart);
  const verLines = ver.lines();
  const verPure = [...new Set(verLines.filter(isPureLoading))];
  const verIdents = new Set(verLines.map(ident));
  const missing = stablePure.filter((l) => !verIdents.has(ident(l)));
  console.log(`[诊断模式 env] 控制台总行数=${verLines.length} · 加载日志类=${verPure.length}`);

  assert('A3 诊断回流: 稳定加载日志一字不少地回来 (逐行, 行首时间戳/CID/随机id/耗时归一后比对)',
    missing.length === 0,
    `跨轮稳定加载日志 ${stablePure.length} 行 → 诊断模式全部回来 (缺 ${missing.length})`
      + (missing.length ? `; 缺: ${missing.slice(0, 3).join(' | ')}` : '')
      + `; 诊断轮加载日志类总数 ${verPure.length} (基线单轮 ${basePure.length})`);

  const stableSamples = stablePure.filter((l) => !/\d/.test(l));
  const stableMissing = stableSamples.filter((l) => !verLines.includes(l));
  assert('A3b 诊断回流 (逐字): 不含数字的稳定样本必须原样出现',
    stableMissing.length === 0,
    `稳定样本 ${stableSamples.length} 条 · 逐字缺失 ${stableMissing.length} 条` + (stableMissing.length ? `; 缺: ${stableMissing.join(' | ')}` : ''));

  // A3d: 同一进程内的**双向**检查 —— 诊断轮写进文件的行, 控制台同样看得见 (一个字都不少)
  const fileLinesV = vRegion.split('\n')
    .map((l) => l.replace(/^\[20\d\d-\d\d-\d\dT[\d:.]+Z\]\s?/, '').trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith('# '));
  const filePureV = [...new Set(fileLinesV.filter(isPureLoading))];
  const fileOnly = filePureV.filter((l) => !verLines.includes(l));
  assert('A3d 诊断模式一行不落: 该轮进程写进日志文件的行, 控制台上同样看得见 (同一进程逐字双向)',
    filePureV.length > 0 && fileOnly.length === 0,
    `诊断轮文件区段 ${filePureV.length} 种加载日志行 → 控制台缺失 ${fileOnly.length}`
      + (fileOnly.length ? `; 仅文件里有: ${fileOnly.slice(0, 3).join(' | ')}` : ''));

  // V2: 诊断模式 (命令行开关 `--verbose`, 经 cli-entry 透传给 index.js)
  const flagRun = await observe(spawnCli([ENTRY, '--web', '--verbose'], BASE_ENV), 14_000);
  const flagPure = flagRun.lines().filter(isPureLoading);
  assert('A3c 诊断回流 (CLI 开关): `--web --verbose` 与 env 开关等价, 同样全量输出',
    flagPure.length >= 5,
    `--verbose 那一轮控制台加载日志类=${flagPure.length} 行 (期望 ≥5)`
      + (flagPure.length ? `; 例: ${flagPure[0].slice(0, 110)}` : ''));

  // 文件那一份
  const verPureInFile = verPure.filter((l) => vRegion.includes(l));
  const stableInDefaultRegion = stableSamples.filter((l) => dRegion.includes(l));
  const dRegionLines = dRegion.split('\n').filter((l) => l.trim().length > 0).length;
  assert('A4 诊断不丢: 控制台看不到的行真的在日志文件里 (逐字)',
    stableInDefaultRegion.length === stableSamples.length && verPure.length > 0 && verPureInFile.length === verPure.length,
    `${LOG_PATH} · 默认轮写入区段 ${dRegionLines} 行, 含稳定样本 ${stableInDefaultRegion.length}/${stableSamples.length};`
      + ` 诊断轮加载日志 ${verPure.length} 行在文件里查到 ${verPureInFile.length}`
      + (stableInDefaultRegion.length < stableSamples.length
        ? `; 缺: ${stableSamples.filter((l) => !dRegion.includes(l)).join(' | ')}` : ''));

  // A5: 环境里的真降级
  const sigKept = baseSig.filter((l) => def.lines().some((d) => ident(d) === ident(l)));
  if (baseSig.length === 0) {
    record('A5 错误不吞 (环境真降级)', 'skip', `基线窗口(${WINDOW_MS / 1000}s)内没有降级/错误行 —— 判不了, 不计入通过`);
  } else {
    assert('A5 错误不吞: 基线里的降级/错误行在默认模式下照样显示',
      sigKept.length >= 1,
      `基线信号行 ${baseSig.length} 条 · 默认模式复现 ${sigKept.length} 条` + (sigKept.length ? `; 例: ${sigKept[0].slice(0, 130)}` : ''));
  }

  // A6: 定向注入的真错误 (夹具自造, 不依赖环境)
  const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-quiet-'));
  fs.mkdirSync(path.join(brokenHome, '.bolloon'), { recursive: true });
  fs.writeFileSync(path.join(brokenHome, '.bolloon', 'bolloon-config.json'), '{"activeProvider": "deepseek", "providers": {', 'utf8');
  const errProc = await observe(spawnCli([MAIN, '--web'], {
    ...BASE_ENV, HOME: brokenHome, BOLLOON_HOME: path.join(brokenHome, '.bolloon'),
  }), SHORT_MS);
  fs.rmSync(brokenHome, { recursive: true, force: true });
  const errLines = errProc.lines();
  const errPure = errLines.filter(isPureLoading);
  const injected = errLines.find((l) => /Error reading apiKey from config|SyntaxError/.test(l));
  assert('A6 错误不吞 (定向注入): 坏配置引发的启动期真错误必须可见, 且该轮加载日志仍为 0',
    !!injected && errPure.length === 0,
    `隔离 HOME 写坏 bolloon-config.json → 命中错误行=${!!injected}; 该轮加载日志类=${errPure.length}`
      + (injected ? `; 原文: ${injected.slice(0, 150)}` : ''));

  // A7: CLI 交互启动 (开真 pty, 否则 Ink 的 TUI 压根不渲染)
  const cli = await observe(spawnCli([ENTRY, '--cli'], BASE_ENV, true), SHORT_MS);
  const cliLines = cli.lines();
  const cliPure = cliLines.filter(isPureLoading);
  const cliText = stripAnsi(cli.out());
  const panelMark = ['启动面板', '🚀 Bolloon'].find((k) => cliText.includes(k)) || '';
  const promptMark = ['输入消息', '@智能体', '/queue'].find((k) => cliText.includes(k)) || '';
  const gateMark = ['BOLLOON_SKIP_SETUP=1', '门禁'].find((k) => cliText.includes(k)) || '';
  assert('A7 CLI 交互启动: 加载日志 0 行, 但启动面板/输入提示 与门禁提示都还在',
    cliPure.length === 0 && !!panelMark && !!promptMark && !!gateMark,
    `pty=${HAS_PTY_CMD} · 加载日志类=${cliPure.length}; 面板命中="${panelMark}"; 输入提示命中="${promptMark}"; 门禁提示命中="${gateMark}"`
      + (cliPure.length ? `; 残留: ${cliPure.slice(0, 3).join(' | ')}` : ''));

  // A8: 子命令 + 机器可读输出
  const subProblems: string[] = [];
  for (const s of [['network', 'status'], ['task', 'board'], ['p2p', 'status']]) {
    const p = await observe(spawnCli([ENTRY, ...s], BASE_ENV), SHORT_MS);
    const pure = p.lines().filter(isPureLoading);
    if (p.code() !== 0) subProblems.push(`bolloon ${s.join(' ')} exit=${p.code()}`);
    if (pure.length) subProblems.push(`bolloon ${s.join(' ')} 出现加载日志 ${pure.length} 行`);
    if (p.out().trim().length === 0) subProblems.push(`bolloon ${s.join(' ')} 无输出`);
  }
  const vp = await observe(spawnCli([ENTRY, '--version', 'json'], BASE_ENV), SHORT_MS);
  let verOk = false;
  let verDetail = '未解析';
  try {
    const raw = vp.out();
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    verOk = !!j.packageVersion && j.schema === 'bolloon-version/1';
    verDetail = `schema=${j.schema} version=${j.packageVersion}`;
  } catch (e) {
    verDetail = `JSON 解析失败: ${(e as Error).message}`;
  }
  assert('A8 子命令 + 机器可读输出不受闸门影响',
    subProblems.length === 0 && verOk,
    subProblems.length ? subProblems.join('; ') : `3 个子命令 exit 0 / 无加载日志 / 有输出; --version json ${verDetail}`);

  printSummary();
  return results.some((r) => r.ok === false) ? 1 : 0;
}

function printSummary(): void {
  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === 'skip').length;
  console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
}

// ---------------------------------------------------------------------------
// 阴性对照: 把闸门的过滤打成不生效 → 「默认静默」必须红 → 恢复 → 必须绿
// ---------------------------------------------------------------------------

const MUTATE_FROM = '  if (filtering) {\n    process.stdout.write = makeStreamWrapper';
const MUTATE_TO = '  if (false && filtering) {\n    process.stdout.write = makeStreamWrapper';

function runGate(windowSec: number): number {
  try {
    execSync(`npx tsx scripts/verify-cli-quiet.ts --only-default --window ${windowSec}`, { cwd: ROOT, stdio: 'inherit' });
    return 0;
  } catch {
    return 1;
  }
}

function mutationMode(): number {
  console.log('\n=== 阴性对照: 变异 log-gate 的过滤开关 (改后必须红, 恢复后必须绿) ===');
  const original = fs.readFileSync(GATE_SRC, 'utf8');
  const mutated = original.replace(MUTATE_FROM, MUTATE_TO);
  if (mutated === original) {
    console.log('✗ 变异没生效 (替换点没命中) —— 按纪律: 先查变异有没有落盘, 再怀疑门');
    return 1;
  }
  let redExit = -1;
  try {
    fs.writeFileSync(GATE_SRC, mutated, 'utf8');
    const h = createHash('sha1').update(fs.readFileSync(GATE_SRC)).digest('hex').slice(0, 12);
    console.log(`[变异] 盘上 hash 已变 (${h}) → 重建 dist ...`);
    execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
    console.log('[变异] 跑门 (期望 A2 红) ...');
    redExit = runGate(18);
  } finally {
    fs.writeFileSync(GATE_SRC, original, 'utf8');
  }
  console.log('[变异] 已恢复原文件 → 重建 dist ...');
  execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
  const hashBack = createHash('sha1').update(fs.readFileSync(GATE_SRC)).digest('hex').slice(0, 12);
  console.log(`[变异] 恢复态 hash=${hashBack} (应与变异前一致) → 复跑门 (期望绿) ...`);
  const greenExit = runGate(18);
  const ok = redExit !== 0 && greenExit === 0;
  console.log(`\n=== 变异验证: 变异态 exit=${redExit} (期望非 0) · 恢复态 exit=${greenExit} (期望 0) → ${ok ? '✓ 判据成立' : '✗ 判据不成立'} ===`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------

(async () => {
  const code = MUTATION ? mutationMode() : await main();
  // 长驻子进程已被 SIGKILL; 显式退出, 免得管道句柄把进程挂住
  process.exit(code);
})();
