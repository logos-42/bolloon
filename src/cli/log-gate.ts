/**
 * log-gate.ts — 启动期日志闸门 (2026-09-26)
 *
 * 为什么要有这一层 (而不是逐个文件删 console.log):
 * 启动刷屏不是某一处, 而是**很多模块各自 console.log** ——
 *   `src/web/server.ts`    → `[web] webRoot` / `[createWebServer]` / `[runs] 对账` / `[context]` /
 *                            `[did-catalog]` / `[自愈]` / `[ipfs]` / `[supervisor]` / `开始生成 P2P 身份...`
 *   `src/llm/pi-ai.ts`     → `[PiAIModel]` / `[pi-ai timing]`
 *   `src/bootstrap/*`      → `[bootstrap]`
 *   `src/pi-ecosystem-mcp` → `[McpAdapter]`
 *   `src/network/*`        → `[IrohTransport]`
 *   `node_modules/@diap/sdk` (依赖库) → `2026-…T [info]: …`
 * 逐个文件去删既不收敛 (后来者会再加回来), 也挡不住依赖库。所以闸门装在**输出层**
 * (`process.stdout.write` / `process.stderr.write` / `console.*`), 一处生效, 覆盖三个启动面:
 *   - `cli-interactive`  CLI 交互启动 (stdout 归 Ink 所有: 加载日志直接丢, 信号行改道 stderr)
 *   - `web`              dashboard / web 启动 (按行丢加载日志, 其它原样透传)
 *   - `plain`            其它启动面 (同上, 不做 console 替换)
 *
 * 三条不可违反的口径 (leo 明确):
 * ① **默认静默** —— 加载日志默认不上控制台 (必要的 spinner / 品牌框 / 状态栏由 Ink 自己渲染, 不走这里);
 * ② **诊断不丢** —— 被静默掉的每一行都落到日志文件; `--verbose` / `BOLLOON_VERBOSE=1` 时**一行不改**地全量回流;
 * ③ **错误 / 降级 / 需人介入的信息不算加载日志** —— `carriesHumanSignal()` 判定的行在**任何模式**下都可见
 *    (交互 CLI 里改道 stderr, 不污染 Ink 的 stdout 画布)。
 *
 * 逃生口: `BOLLOON_LOG_GATE=0` (或 `off` / `false`) 彻底不装闸门 (与 verbose 的区别是 verbose 仍写文件)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspect } from 'util';

export type LogGateMode = 'cli-interactive' | 'web' | 'plain';

export const VERBOSE_ENV = 'BOLLOON_VERBOSE';
export const GATE_ENV = 'BOLLOON_LOG_GATE';

export interface StartupLogGateOptions {
  /** 启动面 (决定是否替换 console.* / 信号行是否改道 stderr), 默认 'plain' */
  mode?: LogGateMode;
  /** 用于探测 `--verbose` 的参数表, 默认 process.argv */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** 日志文件路径, 默认 `~/.bolloon/logs/startup.log` (或 `$BOLLOON_HOME/logs/startup.log`) */
  logPath?: string;
  /** 强制 verbose (优先于 args/env 探测) */
  verbose?: boolean;
  /** 强制关闸 (优先于 args/env) */
  disabled?: boolean;
  /** 不写日志文件 (只给单测用) */
  writeFile?: boolean;
}

export interface StartupLogGateStats {
  /** 从控制台丢掉的行数 */
  suppressed: number;
  /** 原样放行到控制台的行数 */
  forwarded: number;
  /** 因带「错误/降级/需人介入」信号而被放行的行数 (是 forwarded 的子集) */
  signalKept: number;
  /** 写进日志文件的行数 */
  fileLines: number;
  /** 日志文件不可写时的原因 (null = 正常) */
  fileError: string | null;
}

export interface StartupLogGateHandle {
  readonly mode: LogGateMode;
  readonly verbose: boolean;
  /** false = 闸门没装 (verbose / disabled), 控制台行为与未装时一致 */
  readonly filtering: boolean;
  readonly logPath: string;
  readonly stats: StartupLogGateStats;
  stop(): void;
}

// ---------------------------------------------------------------------------
// 行分类
// ---------------------------------------------------------------------------

/** `[web]` `[bootstrap]` `[supervisor-host]` `[McpAdapter]` `[PiAIModel]` … (ASCII 模块 tag) */
const MODULE_TAG_ASCII = /^[ \t]{0,8}\[[A-Za-z_][A-Za-z0-9_.:-]*\]/;
/** `[自愈]` `[迁移:openclaw]` … (中文模块 tag) */
const MODULE_TAG_CJK = /^[ \t]{0,8}\[[\u4e00-\u9fff][^\]\n]{0,24}\]/;
/** `2026-09-26T06:16:57.905Z [info]: …` (依赖库/自研 logger 的 ISO 时间戳行) */
const ISO_TIMESTAMP_LINE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
/** `kp.publicKey: Uint8Array(32) [` —— console.log 直接打印对象时的 inspect dump 开头 */
const INSPECT_DUMP_OPEN = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*: (?:Uint8Array|Buffer|Map|Set|Array)\(\d+\) \[$/;

/**
 * 少量**没有 module tag** 的启动自述行 (`src/web/server.ts` 的 P2P 身份打印)。
 * 它们是加载过程的叙述, 不是结果 —— 默认静默, 但照样落日志文件。
 * 每条 pattern 都按行首锚定, 只覆盖实测观察到的那几句, 不做宽泛匹配。
 */
const UNTAGGED_STARTUP_NARRATION: readonly RegExp[] = [
  /^开始生成 P2P 身份\.\.\.$/,
  /^(?:复用|新建) P2P 身份: /,
  /^P2P 身份已生成: /,
  /^DID: did:/,
  // 2026-10-01 (用户连续三次: 「iroh: … / 主题: … 还没去掉」): 这几句**不带模块标签也不带时间戳** ✗
  //   ⇒ 原来不在任何判据里 ⇒ 闸门、console 拦截、writeOut 三道全都拦不住 ✓。
  //   仍然按行首锚定、只覆盖**实测观察到**的形状 ✓(不做宽泛匹配 ✓); 带缩进也要认 ✓。
  /^[ \t]*iroh:\s*[0-9a-f]{6,}/i,
  /^[ \t]*主题:\s*[0-9a-f]{8}/i,
  /^[ \t]*复用 DID:\s*did:/i,
  /^[ \t]+名称:\s*[\w.\-]{2,40}\s*$/,
];

/** 「错误 / 降级 / 需人介入」信号 —— 命中的行**任何模式下都不许被吞** */
const HUMAN_SIGNAL = new RegExp([
  '失败', '错误', '异常', '拒绝', '未就绪', '未完成', '未配置', '不可用', '降级', '回退',
  '超时', '转人工', '中断', '损坏', '缺失', '冲突', '警告', '不安全', '越权', '请先', '占用',
  '⚠', '✗', '⛔', '❌',
  '\\berror\\b', '\\bfail(?:ed|ure|s)?\\b', '\\bfatal\\b', '\\bwarn(?:ing)?\\b', '\\btimeout\\b',
  '\\bcannot\\b', '\\bunable\\b', '\\brefused\\b', '\\bdenied\\b', '\\bunavailable\\b',
  '\\bdegraded\\b', '\\bcrash(?:ed)?\\b', '\\bnot ready\\b',
  'ERR_[A-Z]+', 'ECONN', 'EACCES', 'ENOENT', 'EADDRINUSE', 'EADDRNOTAVAIL',
].join('|'), 'i');

/**
 * 「0 个错误 / 0 个转人工 / 0 errors」这类**零计数**短语 —— 意思是「没有要人管的事」, 不算信号。
 * 先把这些短语抠掉再判信号: 这样「同一行里还写了别的失败/超时」仍然会被判成信号,
 * 而 `N 个转人工` (N>0) 这种真要人介入的行照样保留。
 */
const BENIGN_COUNT = /0\s*(?:个|条)(?:非致命)?(?:错误|转人工|失败|异常)|no errors?|0 errors?/gi;

/** 这一行是不是「加载日志」(默认模式下从控制台丢掉, 写进日志文件) */
export function isStartupLogLine(line: string): boolean {
  if (!line) return false;
  return MODULE_TAG_ASCII.test(line)
    || MODULE_TAG_CJK.test(line)
    || ISO_TIMESTAMP_LINE.test(line)
    || INSPECT_DUMP_OPEN.test(line)
    || UNTAGGED_STARTUP_NARRATION.some((re) => re.test(line));
  // inspect dump 的续行 (纯数字/逗号) 由 filterText 的 dump 状态机处理, 这里不判
}

/**
 * 「可选启动富化」任务的失败 —— **落日志, 但默认不占屏**。
 *
 * 2026-09-30 (leo: 「都是启动期可选富化任务失败, 却用带时间戳的'失败'打在屏上」):
 *   `[warn]: ⚠️ 本地 IPNS 发布失败: TimeoutError … ❌ 失败 (30003ms)` 这类来自 SDK / 内部后台任务,
 *   用户启动时**无可行动**(看见了也没法处理), 但句子带'失败' ⇒ 按'错误不许被吞'被放上屏 = 纯噪音。
 *   它们仍然**一字不漏落 startup.log**, `--verbose` 照原样上屏 ⇒ 诊断能力一点不丢。
 *   这是把「要不要占屏」和「要不要留痕」分开, 不是把错误藏起来。
 *
 * 判据要求**同时**命中「上面这条窄规则」+「失败词」; 只命中一个照旧按人味信号上报。
 *   **刻意只覆盖这两类**: SDK 的 IPNS 发布重试行 + 上下文扫描超时。
 *   不收 `ipfs daemon 启动超时, 可稍后手动运行` 这类**可行动**提示 —— 门自己的契约测试
 *   (`log-gate.test.ts` 的"信号行"用例) 就是拿它当反例, 第一版规则太宽时被它判红。
 */
const OPTIONAL_BOOT_TASK = /(?:本地\s*IPNS\s*发布失败|IPNS\s*发布失败[，,]\s*尝试备用发布|上下文扫描\s*未完成|上下文扫描\s*超时|Bolloon 上下文扫描)/;

/**
 * SDK(winston) 的**进度诊断**行形状: `2026-09-30T09:27:03.848Z [info]: 结果: ❌ 失败 (30004ms)`。
 *
 * 2026-09-30 (leo): 这类行来自 @diap/sdk 的 logger —— 它**直写控制台、绕过日志门**, 句子里带
 *   "失败/❌" ⇒ 按"错误不许被吞"被放上屏, 但它是 `[info]` 级**进度尾巴**(IPNS 发布 30s 超时), 启动时不可行动。
 *
 * **只吞 info/debug, 绝不吞 warn/error** —— 这条收窄是门自己的契约测试逼出来的:
 *   `log-gate.test.ts` 断言 `… [warn]: ⚠️ 守护进程启动超时, 可稍后手动运行 ipfs daemon` 必须算人味信号
 *   (它确实可行动)。第一版规则连 warn 一起吞 ⇒ 被那条测试判红, 于是收窄。
 */
// 2026-09-30 真机修正: 原来只认"以 ISO 时间戳开头 + 未染色的 [info]:"。
//   实测真身是 `[2026-…] 2026-…Z [[32minfo[39m]: …` —— 行首可能有日志器加的 `[ts] ` 前缀,
//   `[info]` 里的 info 还会被 ANSI 染色 ⇒ 两条都让旧规则漏网, 于是
//   `2026-09-30T10:22:44.768Z [info]:   结果: ❌ 失败 (30004ms)` 照样上屏 (leo 报过多次)。
const SDK_DIAG_LINE = /^(?:\[[^\]]*\]\s*)?\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*\[(?:\x1b\[[0-9;]*m)*(?:info|debug)(?:\x1b\[[0-9;]*m)*\]:/i;

/** 这一行是不是「错误 / 降级 / 需人介入」—— 是则任何模式下都不许被静默 */
export function carriesHumanSignal(line: string): boolean {
  if (!line) return false;
  const l = line.replace(BENIGN_COUNT, ' ');
  const isSignal = HUMAN_SIGNAL.test(l);
  // SDK 诊断行 (info/warn/debug): 只落日志, 不占屏 —— error 级不在其中, 照旧上报
  if (SDK_DIAG_LINE.test(l)) return false;
  // 可选启动富化的失败: 留痕(日志)但默认不占屏 —— 见 OPTIONAL_BOOT_TASK 的说明
  if (isSignal && OPTIONAL_BOOT_TASK.test(l)) return false;
  return isSignal;
}

// ---------------------------------------------------------------------------
// verbose / disabled / 日志路径
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'verbose']);

export function isStartupVerbose(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envVal = (env[VERBOSE_ENV] ?? '').trim().toLowerCase();
  if (TRUTHY.has(envVal)) return true;
  return args.some((a) => a === '--verbose' || /^--verbose=(1|true|yes|on)$/i.test(a));
}

export function isGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false' || v === 'no';
}

/**
 * 日志文件路径。
 * `$BOLLOON_HOME/logs/startup.log` 优先 (与 setup-store 的 home 口径一致), 否则 `~/.bolloon/logs/startup.log`。
 * ⚠️ `homeDir` 默认值在**调用时**求值 —— 覆盖 `process.env.HOME` 之前取到的才是真实家目录。
 */
export function startupLogPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const explicit = (env.BOLLOON_HOME ?? '').trim();
  const base = explicit || path.join(homeDir, '.bolloon');
  return path.join(base, 'logs', 'startup.log');
}

// ---------------------------------------------------------------------------
// 闸门本体
// ---------------------------------------------------------------------------

let activeGate: StartupLogGateHandle | null = null;

/**
 * 当前闸门的**文件写入口** (只落盘不上屏的那条路)。
 *
 * 为什么要有它: `startup-notice.ts` 默认把"启动前言"收进内存**不上屏**, 但"诊断不丢"这条
 * 规矩不因为不上屏就作废 —— 那一段必须照样落进 `startup.log`。落盘逻辑(路径/时间戳/失败退场)
 * 只允许有一份, 所以由闸门把它开放出来, 而不是让调用方自己拼一遍。
 */
let activeFileWriter: ((lines: string[]) => void) | null = null;

/** 追加一行到启动日志文件 (不上屏)。闸门没装时按**已文档化的路径契约**自己落盘。 */
export function logStartupLine(line: string): void {
  try {
    if (activeFileWriter) { activeFileWriter([line]); return; }
    const p = startupLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 落盘失败绝不影响启动 */ }
}

/** 取当前闸门 (未装 = null); 验收脚本用它读 stats */
export function getStartupLogGate(): StartupLogGateHandle | null {
  return activeGate;
}

/** 单测用: 卸掉当前闸门 */
export function resetStartupLogGate(): void {
  activeGate?.stop();
  activeGate = null;
}

/** 把 console.* 的参数拼成一行文本 (对齐 console 的 printf 风格: 第一个参数含 %s 时替换) */
function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const first = args[0];
  if (typeof first === 'string' && /%[sdioOj]/.test(first)) {
    let i = 1;
    // eslint-disable-next-line no-control-regex
    const interp = first.replace(/%[sdioOj]/g, () => stringify(args[i++]));
    return [interp, ...args.slice(i).map(stringify)].join(' ');
  }
  return args.map(stringify).join(' ');
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'object' && v !== null) {
    try {
      return inspect(v, { depth: 2, breakLength: 120 });
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function installStartupLogGate(opts: StartupLogGateOptions = {}): StartupLogGateHandle {
  if (activeGate) return activeGate;

  const env = opts.env ?? process.env;
  const mode: LogGateMode = opts.mode ?? 'plain';
  const verbose = opts.verbose ?? isStartupVerbose(opts.args ?? process.argv.slice(2), env);
  const disabled = opts.disabled ?? isGateDisabled(env);
  const logPath = opts.logPath ?? startupLogPath(env);
  const filterConsole = mode === 'cli-interactive';
  const rerouteSignals = mode === 'cli-interactive';
  const writeFile = opts.writeFile !== false;

  const stats: StartupLogGateStats = {
    suppressed: 0, forwarded: 0, signalKept: 0, fileLines: 0, fileError: null,
  };
  const filtering = !verbose && !disabled;

  // ---- 日志文件 (append; 每 chunk 一次 appendFileSync, 保证进程被强杀也不丢) ----
  let fileReady = writeFile;
  if (fileReady) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `# ${new Date().toISOString()} startup log (mode=${mode} verbose=${verbose} pid=${process.pid}) argv=${process.argv.slice(2).join(' ')}\n`);
    } catch (e) {
      fileReady = false;
      stats.fileError = `日志文件不可写: ${logPath} (${(e as Error).message})`;
    }
  }

  const fileBuf: string[] = [];
  function writeLines(lines: string[]): void {
    if (!fileReady || lines.length === 0) return;
    for (const l of lines) fileBuf.push(l);
    const payload = fileBuf.map((l) => `[${new Date().toISOString()}] ${l}`).join('\n') + '\n';
    fileBuf.length = 0;
    try {
      fs.appendFileSync(logPath, payload);
      stats.fileLines += lines.length;
    } catch (e) {
      fileReady = false;
      stats.fileError = `日志文件写入失败: ${(e as Error).message}`;
    }
  }

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origConsole = {
    log: console.log, info: console.info, debug: console.debug,
    warn: console.warn, error: console.error,
  };

  // inspect dump 的多行续行状态 (按流各自维护)
  const dumpState = { stdout: false, stderr: false };

  type Verdict = 'signal' | 'loading' | 'plain';

  function classify(line: string, stream: 'stdout' | 'stderr'): Verdict {
    const trimmed = line.trim();
    if (dumpState[stream]) {
      if (trimmed === ']') dumpState[stream] = false;
      return 'loading';
    }
    if (carriesHumanSignal(line)) return 'signal';
    if (isStartupLogLine(line)) {
      if (INSPECT_DUMP_OPEN.test(line)) dumpState[stream] = true;
      return 'loading';
    }
    return 'plain';
  }

  /** 按行判定: 返回要写到「本流」的内容; 加载日志丢掉 (写文件), 信号行按模式处理 */
  function filterText(text: string, stream: 'stdout' | 'stderr'): string {
    const parts = text.split('\n');
    const trailingNewline = parts.length > 1 && parts[parts.length - 1] === '';
    if (trailingNewline) parts.pop();
    const kept: string[] = [];
    const toFile: string[] = [];
    for (const line of parts) {
      const verdict = classify(line, stream);
      toFile.push(line);
      if (verdict === 'loading') {
        stats.suppressed++;
        continue;
      }
      if (verdict === 'signal') {
        stats.signalKept++;
        stats.forwarded++;
        // 交互 CLI: stdout 是 Ink 的画布 —— 信号行改道 stderr, 既不丢也不糊屏
        if (rerouteSignals && stream === 'stdout') {
          origStderr(line + '\n');
          continue;
        }
        kept.push(line);
        continue;
      }
      stats.forwarded++;
      kept.push(line);
    }
    writeLines(toFile);
    if (kept.length === 0) return '';
    return kept.join('\n') + (trailingNewline ? '\n' : '');
  }

  function makeStreamWrapper(orig: typeof origStdout, stream: 'stdout' | 'stderr') {
    return function wrapper(chunk: any, encOrCb?: any, cb?: any): boolean {
      const cbFn = typeof encOrCb === 'function' ? encOrCb : typeof cb === 'function' ? cb : null;
      const enc = typeof encOrCb === 'string' ? encOrCb : undefined;
      let out = chunk;
      try {
        const text = typeof chunk === 'string'
          ? chunk
          : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        const filtered = filterText(text, stream);
        if (filtered === text) return (orig as any)(chunk, encOrCb, cb);
        out = filtered;
      } catch {
        // 闸门自身出错绝不吞内容: 原样放行
        return (orig as any)(chunk, encOrCb, cb);
      }
      if (out === '') {
        // 整 chunk 都被静默: 仍要按 Node 语义回调一次, 否则 Ink 的渲染链会卡死
        if (cbFn) process.nextTick(cbFn);
        return true;
      }
      return (orig as any)(out, enc, cbFn ?? undefined);
    };
  }

  function makeConsoleFn(): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const text = formatConsoleArgs(args);
      const toFile: string[] = [];
      for (const line of text.split('\n')) {
        toFile.push(line);
        if (carriesHumanSignal(line)) {
          // 需人介入的信息必须可见: 交互 CLI 的 stdout 归 Ink, 所以走 stderr
          stats.signalKept++;
          origStderr(line + '\n');
        } else {
          stats.suppressed++;
        }
      }
      writeLines(toFile);
    };
  }

  function makeConsoleError(): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const text = formatConsoleArgs(args);
      writeLines(text.split('\n'));
      stats.forwarded++;
      origStderr(text + '\n');
    };
  }

  let stopped = false;
  const handle: StartupLogGateHandle = {
    mode,
    verbose,
    filtering,
    logPath,
    stats,
    stop() {
      if (stopped) return;
      stopped = true;
      if (activeFileWriter === writeLines) activeFileWriter = null;
      if (filtering) {
        process.stdout.write = origStdout as any;
        process.stderr.write = origStderr as any;
        if (filterConsole) {
          console.log = origConsole.log;
          console.info = origConsole.info;
          console.debug = origConsole.debug;
          console.warn = origConsole.warn;
          console.error = origConsole.error;
        }
      }
    },
  };

  if (filtering) {
    process.stdout.write = makeStreamWrapper(origStdout, 'stdout') as any;
    process.stderr.write = makeStreamWrapper(origStderr, 'stderr') as any;
    if (filterConsole) {
      console.log = makeConsoleFn();
      console.info = makeConsoleFn();
      console.debug = makeConsoleFn();
      console.warn = makeConsoleFn();
      console.error = makeConsoleError();
    }
  } else if (fileReady) {
    // verbose / disabled: 控制台一行不改, 但为了「诊断不丢」仍把内容抄一份进日志文件
    const tee = (orig: typeof origStdout) => (chunk: any, encOrCb?: any, cb?: any) => {
      try {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        writeLines(text.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')));
      } catch { /* 抄写失败不影响放行 */ }
      return (orig as any)(chunk, encOrCb, cb);
    };
    process.stdout.write = tee(origStdout) as any;
    process.stderr.write = tee(origStderr) as any;
  }
  if (stats.fileError && verbose) {
    origStderr(`${stats.fileError}\n`);
  }

  activeGate = handle;
  if (fileReady) activeFileWriter = writeLines;
  return handle;
}
