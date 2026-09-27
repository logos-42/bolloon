#!/usr/bin/env -S npx tsx
/**
 * verify-cli-panel.ts — 「启动直接进面板 + 失败不吞 + 面板可复制 + 打字不抖」验收门 (2026-09-27)
 *
 * leo 口径 (原话):
 *   · 「这一部分启动前的日志没有去掉, 应该直接在 `bolloon --cli` 命令启动后, 开始渲染面板。
 *      打开后, 内部内容好像还不支持复制…」
 *   · 「最底部输入框在打字的时候, 会有抖动, 要修复」
 *
 * 所以这一门盯四件事 (全部走**真 pty** + 真字节, 不做函数级模拟):
 *
 *   A 默认启动  : 从进程启动到面板第一帧之间, **除必要 spinner 外输出行数 = 0**;
 *                那坨初始化/就绪度/onboard 续跑前言一行都不许上屏 (但照落 startup.log)。
 *                ⚠ 但"面板之前 0 行"不许拿"把失败静默掉"换 —— 所以 A1 之外还有 A7 把它钉住:
 *                真发生过的降级 (地面真值 = 本轮隔离 HOME 下的 startup.log) **必须**能在
 *                **面板里**定位到原文 (启动期那条 DID→IPFS 降级因此折进面板告警通道)。
 *   B verbose   : `BOLLOON_VERBOSE=1` 下同一坨**一字不少地回来** (修前对照的真实行数)。
 *   C 失败不吞  : 门禁未就绪时, 面板里必须看得到 `/!\ 未就绪 …` 那一行 (不是启动前刷屏)。
 *   D 复制真验  : `/copy` 必须真把字节喂进剪贴板命令 (stub 收到多少字符 = 面板报多少字符);
 *                **还要走一遍真系统剪贴板** (不覆盖 `BOLLOON_CLIPBOARD_CMD` → 用被测代码挑的 `pbcopy`,
 *                门用独立的 `pbpaste` 读回来; 跑完把用户原来的内容放回去) —— C4–C7。
 *   E 打字不抖  : 逐字符真键入, **每一帧行数恒 == 终端高**, 输入行行号恒定, 帧间差异只落在
 *                输入行/状态栏 (历史区不动)。
 *   F 不打断选择: 运行期**不许**出现 `ESC[2J ESC[3J ESC[H` (清屏+清回滚缓冲) —— 那是"选不中"的根因。
 *                只允许收尾卸载时那一次。
 *   G 向导那一程: 到不了面板时, 攒着的前言**必须先落屏** (不落屏 = 吞), 且 verbose 下清单不缺。
 *   H 会话内 /model: 家数 == 盘上真算 · 连续 ↓ 能到候选末尾 · 每帧 ≤ 固定视窗;
 *                **H5–H14 是 2026-09-27 的收尾验**: 直接打字即筛 (`n` `v` `i` → 光标落在命中行) ·
 *                退格逐字恢复 · 筛词态数字跳选 · Esc 两级语义 (选择器 → 回面板 / 面板 → 双击退出) ·
 *                **取消后真配置 sha 逐字节不变** · 选择器与面板的逐帧几何。
 *
 * 变异模式 (--mutation): 故意把源码改坏 → 门必须变红 (证明这些断言不是恒真)。
 *   M1 前言刷回启动前 (startupPreambleVisible 恒 true)  → A1/A2 必红
 *   M2 把失败提示一并吞掉 (告警数组清空)                 → A4 必红
 *   M3 输入框不按宽度裁剪 (宽+高都拿掉)                  → D1/D4 必红
 *   M4 输入栏不加高 1 行 (只留宽裁剪)                    → D2/D2b 必红 (窄终端占位文案换行)
 *   M5 状态栏不加高 1 行                                 → D2b 必红 (状态串在窄终端换行)
 *   M6 降级提示只落盘、不折面板 (bootNotice 里那一步拿掉) → A7 必红 (证明"降级真的看得见"不是恒真)
 *
 * 用法:
 *   npx tsx scripts/verify-cli-panel.ts                # 跑全部
 *   npx tsx scripts/verify-cli-panel.ts --mutation     # 变异 (会临时改源码并 tsc 重建, 跑完还原)
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = process.cwd();
const ENTRY = path.join(ROOT, 'dist', 'cli-entry.js');
const PTY = path.join(ROOT, 'scripts', 'pty-run.py');
const MUTATION = process.argv.includes('--mutation');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-panel-'));
const HOME_BROKEN = path.join(TMP, 'home-broken');
/** 剪贴板 stub 放**短路径**下: 面板那条 `✅ 已复制 … (工具 · N 字符)` 里带工具路径,
 *  路径一长, 行尾的"自报字符数"就被挤出取证窗口 (右侧还有 36 列侧栏) → C2 判不了。 */
const CLIP_DIR = fs.mkdtempSync('/tmp/bp-clip-');
const CLIP_STUB = path.join(CLIP_DIR, 'clip.sh');
const CLIP_OUT = path.join(CLIP_DIR, 'clip.txt');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');
const stripSync = (s: string): string => s.replace(/\x1b\[\?2026[hl]/g, '').replace(/\x1b\[\?25[hl]/g, '');
const stripErase = (s: string): string => s.replace(/(?:\x1b\[2K\x1b\[1A)+/g, '').replace(/\x1b\[2K/g, '').replace(/\x1b\[G/g, '');

/** 前言行清单 (leo 逐条点过的那一坨; 默认模式**一行都不许**出现在面板之前) */
const PREAMBLE_MARKERS = [
  '初始化状态:', '就绪度: basic=', '已完成: ', '配置来源:', '已存输入:', '缺 (basic)', '缺 (agent)',
  '缺 (durable)', '下一步: ', 'Onboard 模式', '初始化完成', '启动命令行界面',
];

interface Check { name: string; ok: boolean | 'skip'; detail: string }
const results: Check[] = [];
function record(name: string, ok: boolean | 'skip', detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok === 'skip' ? '⊘ SKIP' : ok ? '✓ PASS' : '✗ FAIL'}  ${name} — ${detail}`);
}
const assert = (name: string, ok: boolean, detail: string): void => record(name, ok, detail);

interface KeyEvent { at: number; keys?: string; resize?: [number, number]; wait_for?: string; after?: number }

interface PtyRun {
  raw: string;
  /** 原始字节 (VT 回放要用**字节偏移**定位 —— pty-run.py 的按键 mark 里记的就是字节数) */
  rawBuf: Buffer;
  bytes: number;
  frames: string[];        // 每帧原文 (含 ANSI)
  frameLines: string[][];  // 每帧逐行 (ANSI 已剥)
  linesBeforeFirstFrame: string[];
  preBytes: number;
  keys: Array<{ kind: string; at: number; data?: string; bytes: number; frames?: number }>;
  /** pty-run.py 里子进程的真退出码 (null = 到点还活着, 被收尸); 判 Esc 那一级「真退出」要用它 */
  exit: number | null;
  /** pty-run.py 的看门狗有没有开过枪 (true = 到 --secs 还活着, 被 Ctrl+C/SIGKILL 收尾) */
  watchdog: boolean;
}

function runPty(opts: { rows: number; cols: number; secs: number; env: Record<string, string>; keys?: KeyEvent[]; tag: string }): PtyRun {
  const out = path.join(TMP, `${opts.tag}.bin`);
  const keysFile = path.join(TMP, `${opts.tag}.keys.json`);
  fs.writeFileSync(keysFile, JSON.stringify(opts.keys || []), 'utf-8');
  /**
   * pty-run.py 的退出码用不上 (它自己总是 0) —— 真正的判据是它**打在 stdout 上的那行 JSON**:
   *   `exit` = 子进程的退出码 (null = 到点还活着被收尸), `watchdog` = 看门狗是否开过枪。
   * 判「Esc 那一级真的退出了进程」必须用这个, 不能用 python 自己的状态码。
   */
  const once = (): { raw: string; rawBuf: Buffer; status: number | null; exit: number | null; watchdog: boolean } => {
    const args = [PTY, '--rows', String(opts.rows), '--cols', String(opts.cols), '--secs', String(opts.secs), '--out', out];
    args.push('--keys-file', keysFile);
    for (const [k, v] of Object.entries(opts.env)) args.push('--env', `${k}=${v}`);
    args.push('--cwd', ROOT, '--', process.execPath, ENTRY, '--cli');
    const r = spawnSync('python3', args, { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    let raw = '';
    try { raw = fs.readFileSync(out, 'utf-8'); } catch { raw = ''; }
    let rawBuf = Buffer.alloc(0);
    try { rawBuf = fs.readFileSync(out); } catch { rawBuf = Buffer.alloc(0); }
    let meta: any = {};
    try { meta = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { meta = {}; }
    return { raw, rawBuf, status: r.status, exit: typeof meta.exit === 'number' ? meta.exit : null, watchdog: !!meta.watchdog };
  };
  let run = once();
  // 空抓包 = 这一轮**什么都没测到** (进程压根没起来 / 被系统掐了), 不是被测行为。
  //   重跑一次并**在报告里点名** —— 这是夹具容错, 不是放宽判据 (断言一个字没改)。
  if (run.raw.length === 0) {
    fs.writeFileSync(out, '', 'utf-8');
    run = once();
    console.log(`  · [夹具] ${opts.tag} 首次空抓包 → 重跑一次 (status=${run.status})`);
  }
  if (run.status !== 0 && run.raw.length === 0) {
    throw new Error(`pty-run 失败 (status=${run.status}): 空抓包`);
  }
  const { exit, watchdog } = run;
  const raw = run.raw;
  const rawBuf = run.rawBuf;
  const parts = raw.split('\x1b[?2026h');
  const pre = parts[0] ?? '';
  const frames = parts.slice(1).map((p) => {
    const i = p.indexOf('\x1b[?2026l');
    return '\x1b[?2026h' + (i >= 0 ? p.slice(0, i + 8) : p);
  });
  const frameLines = frames.map((f) => stripAnsi(stripErase(stripSync(f))).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()));
  const linesBeforeFirstFrame = stripAnsi(pre).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  let keys: any[] = [];
  try { keys = JSON.parse(fs.readFileSync(out + '.keys.json', 'utf-8')); } catch { keys = []; }
  return { raw, rawBuf, bytes: raw.length, frames, frameLines, linesBeforeFirstFrame, preBytes: pre.length, keys, exit, watchdog };
}

/** 收尾那一帧是卸载渲染, 允许它清屏 (Ink 的 shouldClearOnUnmount) */
function clearsBeforeTeardown(run: PtyRun): number {
  const n = run.frames.length;
  let count = 0;
  for (let i = 0; i < Math.max(0, n - 1); i++) if (run.frames[i].includes('\x1b[2J')) count++;
  return count;
}

const panelLines = (run: PtyRun): string[] => run.frameLines.flat();
/** 全片可读文本 (ANSI 已剥) —— 判"这一段到底上屏没有"时比单行可靠 (一行的尾巴可能被侧栏换行拆开) */
const allText = (run: PtyRun): string => stripAnsi(run.raw);
const hasPre = (run: PtyRun, marker: string): boolean => run.linesBeforeFirstFrame.some((l) => l.includes(marker));

/**
 * 本轮**隔离 HOME** 的启动日志 —— A7 的**地面真值**。
 *
 * 为什么要从盘上读而不是看屏幕: 屏幕是**被判对象**。降级要是被静掉了, 屏幕上"什么都没有",
 * 拿屏幕当"这轮没发生降级"的证据, 就等于把**吞**判成绿 (门自己骗自己)。盘上的日志不一样 ——
 * `log-gate` / `bootNotice` 落盘是**无条件**的 (与上不上屏无关), 所以它说发生了, 就必须看得见。
 * 路径按已文档化契约自己算 (子进程 env 里没设 `BOLLOON_HOME` ⇒ 用 `$HOME/.bolloon`)。
 */
const startupLogOf = (tag: string): string => {
  const p = path.join(TMP, `home-${tag}`, '.bolloon', 'logs', 'startup.log');
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 真系统剪贴板 / 真配置文件 sha —— 「收尾两验」各要一把**独立**的尺子
// ---------------------------------------------------------------------------

/**
 * 系统剪贴板命令**在这里写死** (macOS: pbcopy/pbpaste)。
 *  为什么不复用被测代码的 `clipboardCommand()`: 那把尺子属于被测对象 ——
 *  拿它去读「写进去的东西」等于自己证明自己 (规则 5)。门这边独立写一遍。
 */
const SYS_COPY = process.platform === 'darwin' ? 'pbcopy' : null;
const SYS_PASTE = process.platform === 'darwin' ? 'pbpaste' : null;

interface SysClip { ok: boolean; text: string; err?: string }

/** 真读**系统剪贴板** (不是 stub 文件) */
function sysClipRead(): SysClip {
  if (!SYS_PASTE) return { ok: false, text: '', err: `本平台 (${process.platform}) 没有写死可用的读取命令` };
  const r = spawnSync(SYS_PASTE, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 << 20 });
  if (r.error) return { ok: false, text: '', err: `调用 ${SYS_PASTE} 失败: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, text: '', err: `${SYS_PASTE} 退出码 ${r.status}` };
  return { ok: true, text: String(r.stdout ?? '') };
}

/** 真写**系统剪贴板** —— 只用于跑完把用户原来的内容原样放回去 */
function sysClipWrite(text: string): { ok: boolean; err?: string } {
  if (!SYS_COPY) return { ok: false, err: `本平台 (${process.platform}) 没有写死可用的写入命令` };
  const r = spawnSync(SYS_COPY, [], { input: text, encoding: 'utf8', timeout: 5000 });
  if (r.error) return { ok: false, err: `调用 ${SYS_COPY} 失败: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, err: `${SYS_COPY} 退出码 ${r.status}` };
  return { ok: true };
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex');
/** 文件的 sha256; 读不到 → null (判红用的「量不到」, 不当绿) */
function fileSha(p: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
/** 剪贴板文本归一化: 只判「是不是同一条内容」, 换行风格与尾部空白不算差异 */
const normClip = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/**
 * 每个场景**一个干净 HOME** —— 共享一个 HOME 时, 前一个场景跑完会把 setup/会话状态写进去,
 * 后面的场景看到的是"已经被前一轮改过"的世界 (真踩过: 同一份代码, 两轮 preamble 一条是
 * `credential_pending` 一条是 `identity_pending`) ⇒ B 段"老路径 vs verbose 逐行对"会假红。
 */
const BASE_ENV = (tag: string): Record<string, string> => ({
  BOLLOON_SKIP_UPDATE: '1', BOLLOON_SKIP_KUBO: '1',
  HOME: path.join(TMP, `home-${tag}`),
});

/**
 * 面板就绪信号 (**在"当前帧"里**同时满足两条):
 *   ① 输入行的快捷键提示出现了 —— Ink 挂上了, raw mode 开了;
 *   ② 启动期的 `⟳ 正在加载技能 / 工具...` 那行**已经换掉**了 —— 还在加载时打字会被吞
 *      (真踩过: at=11.9s 喂进去的按键, 屏上输入框还是空的; 那一轮 16s 里总共只画了 3 帧)。
 * ⚠ 不能用 `输入消息`: Ink 给占位文案首字插了反白光标码, 那个串**在字节里不连续** (`\x1b[7m输\x1b[27m\x1b[90m入消息`)。
 */
const PANEL_READY = '^(?![\\s\\S]*正在加载技能)[\\s\\S]*Esc 双击退出';

function scenarioA(): PtyRun {
  return runPty({ tag: 'A-default', rows: 24, cols: 100, secs: 12, env: { ...BASE_ENV('A'), BOLLOON_SKIP_SETUP: '1' } });
}
function scenarioB(): PtyRun {
  return runPty({ tag: 'B-verbose', rows: 24, cols: 100, secs: 12, env: { ...BASE_ENV('B'), BOLLOON_SKIP_SETUP: '1', BOLLOON_VERBOSE: '1' } });
}
/**
 * 修前路径的等价物: `BOLLOON_STARTUP_PREAMBLE=1` = 老行为 (前言一律上屏)。
 * 🤔 为什么要有它: "verbose 下一字不少地回来" 这种话**不能靠一张手写清单**证明 ——
 *   清单里那几条有的是**环境相关**的 (比如 `已存输入:` 只在 setup store 里真存过 provider 输入时才打,
 *   隔离 HOME 下这一条时有时无 —— 真踩过一次: 同一份代码, 两条 marker 时有时无)。
 *   正确做法: 同一轮里再跑一遍**老路径**, 拿它当基准 → verbose 必须**含老路径打出来的每一条**。
 */
function scenarioLegacy(): PtyRun {
  return runPty({ tag: 'L-legacy', rows: 24, cols: 100, secs: 12, env: { ...BASE_ENV('L'), BOLLOON_SKIP_SETUP: '1', BOLLOON_STARTUP_PREAMBLE: '1' } });
}
/**
 * `/copy` 那一串按键 (两个场景共用: stub 一条 + **真系统剪贴板**一条)。
 * 宽度给到 140 列 / 高度 40 行: 面板右侧有 36 列侧栏, 100 列时那条 `✅ 已复制 … (工具 · N 字符)`
 * 会被换行/裁掉尾巴 → 取证窗口不够 (不是被测行为); 转录区在 24 行窗口里会把新追加的那行挤出可视区。
 * 时序: 第一个按键**等面板真出来** (wait_for), 后面按 `after` 逐个喂。
 */
function scenarioCopy(tag: string, extra: Record<string, string>): PtyRun {
  const cmd = '/copy';
  const keys: KeyEvent[] = [];
  [...cmd].forEach((ch, i) => keys.push(i === 0
    ? { at: 0.2, wait_for: PANEL_READY, keys: ch }
    : { at: 0.2, after: 0.25, keys: ch }));
  // 打 `/` 会先弹命令窗 → 第一个 Enter 是"应用候选", 第二个 Enter 才真提交 (与真人操作一致)
  keys.push({ at: 0.2, after: 0.8, keys: '\\r' });
  keys.push({ at: 0.2, after: 1.2, keys: '\\r' });
  return runPty({
    tag, rows: 40, cols: 140, secs: 30,
    env: { ...BASE_ENV(tag), BOLLOON_SKIP_SETUP: '1', ...extra },
    keys,
  });
}
/** stub 路: 剪贴板命令换成一个只把字节落盘的脚本 (验「内容真的交给了系统剪贴板程序」) */
function scenarioC(): PtyRun {
  return scenarioCopy('C-copy', { BOLLOON_CLIPBOARD_CMD: CLIP_STUB });
}
/**
 * **真系统剪贴板**路: 一个字节都不覆盖剪贴板命令 —— 走被测代码自己挑的 `pbcopy`,
 * 门再用**独立**的 `pbpaste` 读回来。收尾验的第 2 条要的正是这一条 (stub 不算)。
 */
function scenarioCReal(): PtyRun {
  return scenarioCopy('C-copy-real', {});
}
function scenarioD(): PtyRun {
  // 逐字符真键入 (含中文): 面板真出来再打, 一个字一个字打
  const word = 'nvidia-provider-\u6d4b\u8bd5';
  const keys: KeyEvent[] = [];
  [...word].forEach((ch, i) => {
    const esc = ch.codePointAt(0)! > 127 ? `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}` : ch;
    keys.push(i === 0
      ? { at: 0.2, wait_for: PANEL_READY, keys: esc }
      : { at: 0.2, after: 0.45, keys: esc });
  });
  return runPty({ tag: 'D-typing', rows: 24, cols: 60, secs: 30, env: { ...BASE_ENV('D'), BOLLOON_SKIP_SETUP: '1' }, keys });
}
function scenarioF(): PtyRun {
  // 上滚暂停跟随 / End 回底 (探针 + 帧双证据)
  // 先敲 `/help` 把历史撑到**可滚**: 只有启动面板那十几行时 maxTop=0, Ctrl+U 压根不响应
  //   (keymap 在 `totalLines > availH` 才认滚动键) → 断言会恒假。
  const keys: KeyEvent[] = [];
  [...'/help'].forEach((ch, i) => keys.push(i === 0
    ? { at: 0.2, wait_for: PANEL_READY, keys: ch }
    : { at: 0.2, after: 0.3, keys: ch }));
  keys.push({ at: 0.2, after: 0.9, keys: '\\r' });   // 应用候选
  keys.push({ at: 0.2, after: 1.0, keys: '\\r' });   // 提交 → /help 刷一屏历史
  keys.push({ at: 0.2, after: 2.5, keys: '\\u0015' });
  keys.push({ at: 0.2, after: 0.4, keys: '\\u0015' });
  keys.push({ at: 0.2, after: 0.4, keys: '\\u0015' });
  keys.push({ at: 0.2, after: 4.0, keys: '\\u0005' });   // Ctrl+E = 回到底部
  return runPty({
    tag: 'F-scroll', rows: 24, cols: 80, secs: 26,
    env: { ...BASE_ENV('F'), BOLLOON_SKIP_SETUP: '1', BOLLOON_TUI_PROBE: path.join(TMP, 'F-probe.jsonl') },
    keys,
  });
}
/**
 * 坏 HOME + **不**跳向导 (`BOLLOON_SKIP_SETUP` 不给): 这一程走不到"面板无人打扰"那条路 ——
 * 向导必须当场问人。铁律是"要人下手之前, 攒着的前言必须先落屏", 否则就是**吞信息**。
 * 这条场景是 A 段的另一面: A 证明"到得了面板就 0 行", G 证明"到不了面板就一行不少"。
 */
function scenarioG(verbose = false): PtyRun {
  const env: Record<string, string> = { ...BASE_ENV('G') };
  if (verbose) env.BOLLOON_VERBOSE = '1';
  return runPty({ tag: verbose ? 'G-wizard-verbose' : 'G-wizard', rows: 24, cols: 120, secs: 14, env });
}
/**
 * 会话内 `/model` (= leo 点名的第 4 条): **与 `bolloon model` 子命令共用同一套选择器**,
 * 而且在会话里也真能一路 ↓ 到候选末尾。三层证据:
 *   ① 屏上真出选择器 (`共 N 家登记`), 且 N == 门**自己从盘上真算**出来的家数
 *      (门直接调选择器用的那个 `buildProviderSummaries`, 不另写一套数法);
 *   ② 连续 ↓ 真走到底: 状态行 `第 i/N` 从 1 一路到 **N** (不截断在视窗边界);
 *   ③ 每次重绘的行数 ≤ 终端高 (固定高度视窗, 不靠终端回滚缓冲"看得完")。
 * 环境: **真 HOME** —— 目录 (models.dev 抓下来的那批) 落在 ~/.bolloon,
 *   换成隔离 HOME 等于把候选集本身换掉, 那就不叫"盘上真算"了。
 */
function scenarioH(): PtyRun {
  const DOWN = '\\u001b[B';
  const keys: KeyEvent[] = [];
  [...'/model'].forEach((ch, i) => keys.push(i === 0
    ? { at: 0.2, wait_for: PANEL_READY, keys: ch }
    : { at: 0.2, after: 0.25, keys: ch }));
  keys.push({ at: 0.2, after: 0.9, keys: '\\r' });      // 应用候选
  keys.push({ at: 0.2, after: 1.0, keys: '\\r' });      // 提交 `/model`
  // 开窗要一两秒 (要读盘把家数算出来) —— 等"家登记"这行真出现在**当前帧**再开始按 ↓,
  //   否则会打在前面还没起来的那一帧上 (等于测了个空)。
  // 阶段 1 (折叠态): 一路 ↓ 走到**行集末尾** (行集 = 展开的分组 + 折叠组各占 1 行 + Cancel)
  keys.push({ at: 0.2, wait_for: '家登记', after: 0.6, keys: DOWN.repeat(100) });
  for (let c = 0; c < 2; c++) keys.push({ at: 0.2, after: 0.5, keys: DOWN.repeat(100) });
  // 阶段 2 (展开全部折叠组): 交替 `↓` `→` —— `→` 落在分组标题上就展开它, 落在成员行上只是
  //   一句无害提示; 一路走到底 ⇒ 每个折叠组都被展开 (这就是"↓ 能到每个折叠组尾部"的操作路径)
  const LEG = `${DOWN}\\u001b[C`.repeat(20);
  for (let c = 0; c < 26; c++) keys.push({ at: 0.2, after: 0.2, keys: LEG });
  // 阶段 3: 展开之后再一路 ↓ 压到底 (候选 231 家那个行集的末尾)
  for (let c = 0; c < 4; c++) keys.push({ at: 0.2, after: 0.6, keys: DOWN.repeat(100) });
  return runPty({
    tag: 'H-model', rows: 30, cols: 100, secs: 55,
    env: { BOLLOON_SKIP_UPDATE: '1', BOLLOON_SKIP_KUBO: '1', BOLLOON_SKIP_SETUP: '1' },
    keys,
  });
}
/**
 * 会话内 `/model` 的**打字即筛 + 逐帧几何 + Esc 两级语义** (2026-09-27 收尾验, leo 点名:
 *   「直接打 `nvi` → 光标落在 `nvidia` 行」+ 退格恢复 + 筛词态数字跳选 + Esc 取消不动配置)。
 *
 * 与 scenarioH **同一条入口** (会话内 `/model` → `runModelCommand` → 与 `bolloon model` 同一个
 * `tuiSelect`), 只是按键换成这四组; 每一组都 `wait_for`「画面真的回应了」再按下一组
 * (固定秒数会把按键打进行缓冲 —— 本门在 C 段踩过一次)。退格那一段只能靠 `after` 间隔
 * (退格后的屏上文本与去程**逐字相同** ⇒ wait_for 认不出新旧帧); 那一段的判据因此落在
 * **采到的帧**上: 少一帧就是红, 不会假绿。
 *   ① 直接打 `n` `v` `i` (不先按 `/`) → 头行 `已筛 N 家` 逐字缩小, 末态命中 1 家;
 *   ② 筛词态敲 `1` `2` (行集 = 命中家数 + 末行 Cancel) → `第 2/2`; 再敲 `9` → 越界给原因;
 *   ③ 退格逐字退 → `"nv"` / `"n"` / 全量 (去程回程的帧几何要对得上);
 *   ④ Esc 两级: 选择器那一级 → 取消回面板 (进程不退, Ink 继续画帧); 面板那一级 →
 *      **孤立一击不退** (隔 1.2s 的两击之间帧号必须还在长), 只有 500ms 内的一对才真退出 (屏上收尾帧可读)。
 * 环境: **真 HOME** (候选集 = 盘上真算的那批, 与 H 一致) ⇒ 配置 sha 就是用户真配置的 sha。
 */
function scenarioH2(): PtyRun {
  const BS = '\\u007f';
  const ESC = '\\u001b';
  const keys: KeyEvent[] = [];
  [...'/model'].forEach((ch, i) => keys.push(i === 0
    ? { at: 0.2, wait_for: PANEL_READY, keys: ch }
    : { at: 0.2, after: 0.25, keys: ch }));
  keys.push({ at: 0.2, after: 0.9, keys: '\\r' });      // 应用候选
  keys.push({ at: 0.2, after: 1.0, keys: '\\r' });      // 提交 `/model`
  // ① 直接打字 (不按 `/`)
  keys.push({ at: 0.2, wait_for: '家登记', after: 0.6, keys: 'n' });
  keys.push({ at: 0.2, wait_for: '筛选 "n"', after: 0.4, keys: 'v' });
  keys.push({ at: 0.2, wait_for: '筛选 "nv"', after: 0.4, keys: 'i' });
  // ② 筛词态数字跳选
  keys.push({ at: 0.2, wait_for: '筛选 "nvi"', after: 0.5, keys: '1' });
  keys.push({ at: 0.2, wait_for: '第 1/2', after: 0.4, keys: '2' });
  keys.push({ at: 0.2, wait_for: '第 2/2', after: 0.4, keys: '9' });     // 越界 → 给原因
  // ③ 退格逐字退 (`超出范围` 那条 note 是唯一不会在去程出现过的标记)
  keys.push({ at: 0.2, wait_for: '超出范围', after: 0.5, keys: BS });    // "nvi" → "nv"
  keys.push({ at: 0.2, after: 0.7, keys: BS });                          // "nv" → "n"
  keys.push({ at: 0.2, after: 0.7, keys: BS });                          // "n" → 全量
  // ④ Esc 两级语义
  //   ⚠ 会话内取消**不落文字回执** (实测屏上「已取消/未改动」0 命中 —— 回面板本身就是反馈),
  //    所以第一击的 wait_for 只能等「面板的输入行重新上屏」(`❯ ` 在选择器那块屏里不会出现)。
  keys.push({ at: 0.2, after: 1.2, keys: ESC });                                     // ① 选择器 Esc → 回面板
  //   '模型选择 (分步)' 是**选择器返回之后**才 appendLine 的 ⇒ 只有面板回到前台才在屏上。
  //   ⚠ 面板这一级要分"孤立一击"与"双击"两种时序分别验: 相隔 1.2s (> DOUBLE_ESC_MS=500) 的两击
  //   都**不该**退出 (帧号必须还长); 只有 150ms 内的一对才真退出 —— 这才叫"两级语义"。
  keys.push({ at: 0.2, wait_for: '模型选择 \\(分步\\)', after: 1.2, keys: ESC }); // ② 面板: 孤立一击
  keys.push({ at: 0.2, after: 1.2, keys: ESC });                                     // ③ 再孤立一击 (仍不该退)
  keys.push({ at: 0.2, after: 0.15, keys: ESC });                                    // ④ 与前一击 150ms 内 → 真退出
  return runPty({
    tag: 'H2-model-typing', rows: 30, cols: 100, secs: 60,
    env: { BOLLOON_SKIP_UPDATE: '1', BOLLOON_SKIP_KUBO: '1', BOLLOON_SKIP_SETUP: '1' },
    keys,
  });
}

/**
 * 门自己从盘上真算的「某个筛选词命中哪几家」—— 筛法用**选择器同一个** `matchesQuery`
 * (不在门里另写一套), 候选集用 `buildProviderSummaries({})` (与 H1 同一个来源)。
 * 期望值一律走这里派生, 不写死 220/3/1 这种会随目录变的数 (honest-verification-gates 规则 5)。
 */
const diskFilterHits = async (term: string): Promise<Array<{ id: string; label: string }>> => {
  try {
    const mc: any = await import('../src/llm/model-catalog.js');
    const tui: any = await import('../src/cli/tui-select.js');
    const sums: any[] = await mc.buildProviderSummaries({});
    return sums
      .map((s) => ({ id: String(s.id), label: String(mc.formatProviderMenuRow(s)) }))
      .filter((x) => tui.matchesQuery({ value: x.id, label: x.label } as any, term));
  } catch { return []; }
};


const probeLines = (p: string): any[] => {
  try { return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 盘上真算的供应商家数 —— 直接调**选择器用的那个函数** (`buildProviderSummaries`),
 * 门里不另写一套数法 (否则就是"拿自己算的数验自己算的数")。
 */
const diskProviderCount = async (): Promise<number> => {
  try {
    const m: any = await import('../src/llm/model-catalog.js');
    const s: unknown[] = await m.buildProviderSummaries({});
    return Array.isArray(s) ? s.length : -1;
  } catch { return -1; }
};

async function main(): Promise<number> {
  fs.mkdirSync(HOME_BROKEN, { recursive: true });
  fs.writeFileSync(CLIP_STUB, `#!/bin/sh\ncat > ${JSON.stringify(CLIP_OUT).replace(/"/g, '')}\n`, { mode: 0o755 });
  console.log(`\n=== verify-cli-panel (真 pty · tmp=${TMP}) ===\n`);

  // ── A 默认启动: 面板之前 0 行 ─────────────────────────────────────────────
  const A = scenarioA();
  record('A0 前置: 真的拿到面板帧 (否则后面的"静默"断言恒真)',
    A.frames.length >= 3, `帧数=${A.frames.length} · 总字节=${A.bytes}`);
  assert('A1 启动到面板之间输出行数 = 0 (前言默认不上屏)',
    A.linesBeforeFirstFrame.length === 0,
    `第一帧之前: 字节=${A.preBytes} 行数=${A.linesBeforeFirstFrame.length}` +
    (A.linesBeforeFirstFrame.length ? ` · 漏出来的行: ${A.linesBeforeFirstFrame.slice(0, 3).join(' | ')}` : ''));
  const leaked = A.linesBeforeFirstFrame.filter((l) => PREAMBLE_MARKERS.some((m) => l.includes(m)));
  assert('A2 前言行清单一行都没漏 (初始化状态/就绪度/已完成/配置来源/已存输入/缺/下一步/Onboard)',
    leaked.length === 0, `命中 ${leaked.length} 行${leaked.length ? `: ${leaked.slice(0, 2).join(' | ')}` : ''}`);
  const panel = panelLines(A);
  assert('A3 就绪度进了面板 (一行就绪度, 不是启动前那 4 行明细)',
    panel.some((l) => l.includes('就绪: basic')),
    `面板里: ${panel.filter((l) => l.includes('就绪')).slice(0, 1).join(' | ') || '(没找到)'}`);
  assert('A4 门禁未就绪的失败提示**没被吞** (面板内一行 `/!\ …`)',
    panel.some((l) => l.includes('/!\\') && (l.includes('未就绪') || l.includes('缺'))),
    `面板告警: ${panel.filter((l) => l.includes('/!\\')).slice(0, 1).join(' | ') || '(没找到)'}`);
  const hs = A.frameLines.map((f) => f.length);
  assert('A5 面板帧几何: 每帧行数 == 终端高 (24)',
    A.frames.length > 0 && hs.every((n) => n === 24),
    `帧高: ${[...new Set(hs)].join(',')} (期望全部 24) · 帧数=${hs.length}`);
  assert('A6 运行期无 clearTerminal (ESC[2J ESC[3J ESC[H) —— 只允许卸载那一次',
    clearsBeforeTeardown(A) === 0,
    `运行期清屏帧数=${clearsBeforeTeardown(A)} · 全片 2J=${A.raw.split('\x1b[2J').length - 1} 次 (卸载 1 次正常)`);

  // ── A7 「面板之前 0 行」与「降级看得见」必须**同时**成立 (2026-09-27 口径收口) ──────────
  //  踩过的坑: 启动期那条 `⚠ [2/5] 发布 DID → IPFS` (本机没有可用 IPFS 时 DID 发布的**真降级**)
  //  原样走 stderr → 面板之前刷出 1 行 ⇒ A1 红; 而"为了让 A1 绿"直接把它静掉 ⇒ 降级被吞 (更坏)。
  //  两条口径都不让: 该行**折进面板告警通道** (与 `/!\ ⚠ 未就绪 …` 同一出路)。
  //  判据 (两面缺一不可):
  //    ① 地面真值 (`startup.log`, 无条件落盘) 说这一轮**真发生过**降级 —— 不看屏幕,
  //       否则"被吞"和"没发生"在屏幕上长得一模一样, 门会自己骗自己;
  //    ② 那就必须能在**面板里**逐字定位到它 —— 再叠加 A1 的"面板前 0 行",
  //       "看得见"才不是靠启动前刷屏换来的。
  const aLogText = startupLogOf('A');
  const degradeHappened = /IPFS 发布失败|发布 DID → IPFS 失败/.test(aLogText);
  const panelDegrade = panelLines(A).find((l) => l.includes('发布 DID → IPFS') && l.includes('⚠'));
  assert('A7 降级真能看到 (日志里发生过 → 面板里必须定位到原文; 不许靠"面板前刷屏"换可见)',
    degradeHappened
      ? (!!panelDegrade && A.linesBeforeFirstFrame.length === 0)
      : A.linesBeforeFirstFrame.length === 0,
    (degradeHappened
      ? `盘上日志: 这一轮真发生了 DID→IPFS 降级 · 面板内定位=${panelDegrade ? panelDegrade.trim().slice(0, 110) : '(面板里没找到 —— 降级被吞了!)'}`
      : `盘上日志: 这一轮**没发生** DID→IPFS 降级 ⇒ 只验"面板前 0 行"这一半 (不许拿"没发生"当"看得见")`)
      + ` · 启动前=${A.linesBeforeFirstFrame.length} 行 · 日志=${aLogText ? `${aLogText.length} 字符` : '(读不到)'}`);

  // ── B verbose 对照 (基准 = 同一轮里的**老路径**, 不是手写清单) ─────────────
  const B = scenarioB();
  const LEG = scenarioLegacy();
  const bLines = B.linesBeforeFirstFrame;
  const lLines = LEG.linesBeforeFirstFrame;
  // 清单只用于**报告**, 判据是"老路径打出来的每一条, verbose 都得有"
  const need = PREAMBLE_MARKERS.filter((m) => hasPre(LEG, m));
  const missing = need.filter((m) => !hasPre(B, m));
  assert('B1 verbose 含**老路径**打出来的每一条前言 (逐条对)',
    need.length >= 8 && missing.length === 0,
    `老路径 ${lLines.length} 行 / verbose ${bLines.length} 行 · 老路径命中清单 ${need.length} 项, verbose 缺 ${missing.length}${missing.length ? `: ${missing.join(',')}` : ''}`);
  // 「一字不少」的独立旁证: 老路径的每一条**非环境相关**行都必须在 verbose 里逐字找到
  const lUniq = lLines.filter((l) => !/log-gate\]/.test(l));           // log-gate 那行带 tmp 路径, 逐字比会假红
  const notFound = lUniq.filter((l) => !bLines.some((x) => x === l));
  assert('B2 修前后对照: 默认 0 行 vs 老路径/verbose 全量, 且 verbose **逐字**含老路径全部行 (同一轮同一构建)',
    A.linesBeforeFirstFrame.length === 0 && lLines.length > 0 && bLines.length >= lLines.length
      && lUniq.length >= 10 && notFound.length === 0,
    `修后默认=${A.linesBeforeFirstFrame.length} 行 · 修前等价 (BOLLOON_STARTUP_PREAMBLE=1)=${lLines.length} 行 · verbose=${bLines.length} 行`
      + ` · verbose 逐字缺 ${notFound.length} 行 (可比 ${lUniq.length} 行)`
      + (notFound.length ? `: ${notFound.slice(0, 2).join(' | ').slice(0, 140)}` : '')
      + ` (verbose 多出来的那部分是 log-gate 的启动日志全量转储, 属另一道闸 —— 所以比"包含", 不比"等长")`);
  assert('B3 verbose 逐行含老路径 (去掉带 tmp 路径的 log-gate 行后逐字比)',
    lUniq.length >= 10 && notFound.length === 0,
    `老路径 ${lUniq.length} 行可比 · 逐字找不到 ${notFound.length} 行${notFound.length ? `: ${notFound.slice(0, 2).join(' | ').slice(0, 120)}` : ''}`);

  // ── C 复制真验 ───────────────────────────────────────────────────────────
  const C = scenarioC();
  let clip = '';
  try { clip = fs.readFileSync(CLIP_OUT, 'utf-8'); } catch { clip = ''; }
  const cpanel = panelLines(C);
  const okLine = cpanel.find((l) => l.includes('已复制'));
  // 自报字符数从**全片**里取: 面板右侧有 36 列侧栏, 那一行的尾巴可能被换行/裁剪拆开
  const reported = Number((allText(C).match(/已复制[\s\S]{0,400}?(\d+)\s*字符/) || [])[1] ?? -1);
  assert('C1 `/copy` 真把字节喂进剪贴板命令 (stub 收到非空文本)',
    clip.trim().length > 0,
    `stub 收到 ${clip.length} 字符 (内容不入报告) · 面板行: ${okLine ? okLine.slice(0, 60) : '(没找到 ✅ 行)'}`);
  assert('C2 面板自报字符数 == stub 实收字符数 (不是"假装复制了")',
    reported >= 0 && reported === clip.length,
    `面板报 ${reported} 字符 · stub 实收 ${clip.length} 字符`);
  assert('C3 复制路径下也没有清屏打断 (面板帧无 2J)',
    clearsBeforeTeardown(C) === 0, `运行期清屏帧数=${clearsBeforeTeardown(C)}`);
  // ── C 之真 (2026-09-27 收尾验): **真系统剪贴板** ──────────────────────────
  //  C1/C2 只证明「内容真交给了系统剪贴板程序」(stub 是那个程序) —— 这一条把 stub 拆掉:
  //  一个字节都不覆盖 `BOLLOON_CLIPBOARD_CMD`, 让被测代码自己挑 `pbcopy`,
  //  门再用**独立**的 `pbpaste` 读回来。跑完把用户原来的剪贴板放回去 (真验不是毁现场)。
  const savedClip = sysClipRead();
  const CR = scenarioCReal();
  const afterReal = sysClipRead();
  const crText = allText(CR);
  const reportedReal = Number((crText.match(/已复制[\s\S]{0,400}?(\d+)\s*字符/) || [])[1] ?? -1);
  const toolName = (crText.match(/已复制[\s\S]{0,200}?\(([A-Za-z0-9_.\-\/]+)\s*·\s*\d+\s*字符\)/) || [])[1] ?? '(没解析到工具名)';
  assert('C4 前置: 真系统剪贴板这一次读取有效 (pbpaste 可用且先存下原内容)',
    savedClip.ok, savedClip.ok
      ? `原剪贴板 ${savedClip.text.length} 字符已留存 (内容不入报告) · 工具=${SYS_PASTE}`
      : `读不到真剪贴板: ${savedClip.err} —— 读不到就不许把 C5/C6 当绿`);
  assert('C5 `/copy` 走的是**真系统剪贴板**: pbpaste 读回的字节数 == 面板自报字符数 (不是只喂了 stub)',
    afterReal.ok && reportedReal >= 0 && (afterReal.text.length === reportedReal || normClip(afterReal.text).length === reportedReal),
    `面板报 ${reportedReal} 字符 · pbpaste 读到 ${afterReal.ok ? afterReal.text.length : '?'} 字符`
      + ` (归一化后 ${afterReal.ok ? normClip(afterReal.text).length : '?'}) · 面板指名的工具=${toolName}`
      + (afterReal.ok ? '' : ` · 读取失败: ${afterReal.err}`));
  assert('C6 真剪贴板里的内容 == stub 那一路收到的内容 (同一条回复, 归一化后逐字相同)',
    afterReal.ok && clip.length > 0 && normClip(afterReal.text) === normClip(clip),
    `stub 路 ${clip.length} 字符 sha=${sha256(normClip(clip)).slice(0, 12)}`
      + ` · 真剪贴板 ${afterReal.ok ? afterReal.text.length : '?'} 字符 sha=${afterReal.ok ? sha256(normClip(afterReal.text)).slice(0, 12) : '?'}`
      + ` (内容不入报告) · 面板指名的工具=${toolName}`);
  const restored = savedClip.ok ? sysClipWrite(savedClip.text) : { ok: false, err: '没读到原内容, 不动它' };
  assert('C7 跑完把用户原来的剪贴板放回原位 (验完不毁现场)',
    savedClip.ok && restored.ok && normClip(sysClipRead().text) === normClip(savedClip.text),
    savedClip.ok
      ? `还原 ${restored.ok ? '成功' : `失败: ${restored.err}`} · 回读 sha=${sha256(normClip(sysClipRead().text)).slice(0, 12)}`
      : `原内容没读到 (${savedClip.err}), 未改动`);
  // ── D 打字不抖 ───────────────────────────────────────────────────────────
  const D = scenarioD();
  // "打字之后"的帧由 pty 侧记的**帧号**切 (喂键那一刻已画了几帧)。
  //   旧写法按累计字节比 pty 侧的 bytes —— 单位就对不上 (多字节 UTF-8 vs JS string 长度),
  //   于是把启动那几帧也算成"打字帧", 断言从第一对帧就红。
  const firstKey = D.keys.find((k) => k.kind === 'keys');
  const firstFrames = firstKey?.frames ?? -1;
  const typingFrames: number[] = [];
  for (let i = 0; i < D.frames.length; i++) if (firstFrames >= 0 && i >= firstFrames) typingFrames.push(i);
  record('D0 前置: 按键真的在面板起来之后才喂进去 (帧号可定位)',
    firstFrames >= 1, `首个按键时已画 ${firstFrames} 帧 (pty 侧实测) · 总帧数=${D.frames.length}`);
  const tf = typingFrames.map((i) => D.frameLines[i]);
  const dHeights = tf.map((f) => f.length);
  assert('D1 打字期间每帧行数恒定 == 终端高 (60 列窄屏)',
    tf.length >= 3 && dHeights.every((n) => n === 24),
    `帧数=${tf.length} · 帧高集合=${[...new Set(dHeights)].join(',')} (期望 {24})`);
  const inputRowIdx = (f: string[]): number => f.reduce((acc, l, i) => (l.includes('❯ ') ? i : acc), -1);
  const idxs = tf.map(inputRowIdx);
  assert('D2 输入行行号恒定 (输入框不移动)',
    idxs.length > 0 && idxs.every((i) => i === idxs[0]) && idxs[0] >= 0,
    `输入行号集合=${[...new Set(idxs)].join(',')} (期望单一值; 共 ${idxs.length} 帧)`);
  // 几何不动: 三条整宽分隔线 + 状态栏的行号必须逐帧一致 (内容变可以, 位置不许变)
  const sepRows = (f: string[]): number[] => f.map((l, i) => (l.trim().length > 20 && /^─+$/.test(l.trim()) ? i + 1 : 0)).filter(Boolean);
  const sepSets = tf.map((f) => sepRows(f).join(','));
  const statusRowIdx = (f: string[]): number => f.reduce((acc, l, i) => (l.includes('⏱') ? i : acc), -1);
  const statusSets = tf.map((f) => statusRowIdx(f));
  assert('D2b 固定栏行号恒定 (3 条分隔线 + 状态栏 —— 版面骨架不移)',
    new Set(sepSets).size === 1 && new Set(statusSets).size === 1,
    `分隔线行号集合=${[...new Set(sepSets)].join(' | ')} · 状态栏行号集合=${[...new Set(statusSets)].join(',')}`);
  // 逐帧对比: 差异只允许落在 输入行/状态栏/活动行 (活动行 = 分隔线之上那一行)
  const dynamicRows = (f: string[]): Set<number> => {
    const s = new Set<number>();
    const ir = inputRowIdx(f); if (ir >= 0) s.add(ir + 1);
    const sr = statusRowIdx(f); if (sr >= 0) s.add(sr + 1);
    const firstSep = sepRows(f)[0]; if (firstSep) s.add(firstSep - 1);   // 活动行 (思考/整理/暂停提示)
    return s;
  };
  const diffs: Array<{ a: number; b: number; rows: number[]; allowed: boolean }> = [];
  for (let i = 1; i < tf.length; i++) {
    const x = tf[i - 1], y = tf[i];
    if (x.length !== y.length) { diffs.push({ a: i - 1, b: i, rows: [-1], allowed: false }); continue; }
    const rows: number[] = [];
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) rows.push(k + 1);
    const allowed = new Set([...dynamicRows(x), ...dynamicRows(y)]);
    diffs.push({ a: i - 1, b: i, rows, allowed: rows.every((r) => allowed.has(r)) });
  }
  const changed = diffs.filter((d) => d.rows.length > 0);
  const minimal = changed.filter((d) => d.allowed);
  assert('D3 打字引起的重绘最小: 至少 3 对相邻帧差异**只**在输入行/状态栏/活动行 (历史区一动不动)',
    minimal.length >= 3,
    `变化帧对=${changed.length} · 其中"只动动态行"=${minimal.length} · 逐行对比: ` +
    changed.map((d) => `#${d.a}→#${d.b}{${d.rows.join(',')}}${d.allowed ? '' : '⚠'}`).join(' ') +
    ` · 允许的动态行(末帧)={${[...dynamicRows(tf[tf.length - 1] || [])].join(',')}}`);
  const lastTf = tf[tf.length - 1] || [];
  const typingLine = lastTf[inputRowIdx(lastTf)] || '';
  assert('D4 长输入按宽度裁剪 (不换行 → 帧高不涨; 中文也没打乱几何)',
    dHeights.every((n) => n === 24) && /nvidia/.test(allText(D)),
    `末帧输入行="${typingLine.trim().slice(0, 60)}" (全片含 nvidia: ${/nvidia/.test(allText(D))})`);

  // ── F 上滚暂停跟随 / 回底 ────────────────────────────────────────────────
  const F = scenarioF();
  const probes = probeLines(path.join(TMP, 'F-probe.jsonl'));
  const paused = probes.filter((p) => p.stick === false && (p.top ?? 0) > 0);
  const back = probes.filter((p) => p.stick === true && (p.top ?? 0) >= (p.maxTop ?? 0));
  assert('F1 上滚后**暂停跟随** (探针: stick=false 且 top>0)',
    paused.length > 0, `暂停样本=${paused.length} · 末个: ${paused.length ? JSON.stringify(paused[paused.length - 1]).slice(0, 140) : '(无)'}`);
  assert('F2 面板里给出暂停提示行 (不是默默把用户拉回底部)',
    panelLines(F).some((l) => l.includes('已暂停跟随')),
    `提示行: ${panelLines(F).find((l) => l.includes('已暂停跟随')) || '(没找到)'}`);
  assert('F3 End/Ctrl+E 回到底部后恢复跟随 (探针: stick=true 且 top==maxTop)',
    back.length > 0 && (paused.length === 0 || back[back.length - 1].t > paused[paused.length - 1].t),
    `回底样本=${back.length} · 排序: 暂停(t=${paused.length ? paused[paused.length - 1].t : '-'}) → 回底(t=${back.length ? back[back.length - 1].t : '-'})`);

  // ── G 走不到面板 (向导要人当场回答) 时, 前言**必须先落屏** ────────────────
  //   A 段证明"到得了面板就 0 行前言"; G 段证明另一面 —— 到不了面板时一行不少 (否则就是吞)。
  const G = scenarioG(false);
  const GV = scenarioG(true);
  const asked = G.linesBeforeFirstFrame.some((l) => l.includes('你的称呼') || l.includes('模式: setup'));
  assert('G0 前置: 向导真的问到人了 (屏上有提问行 —— 否则 G1–G3 判不了)',
    asked, `第一帧之前 ${G.linesBeforeFirstFrame.length} 行 · 末尾: ${G.linesBeforeFirstFrame.slice(-1)[0] || '(空)'}`);
  assert('G1 要人当场回答 → 攒着的前言**先落屏** (走不到面板 ≠ 吞掉)',
    G.linesBeforeFirstFrame.length >= 10,
    `第一帧之前 ${G.linesBeforeFirstFrame.length} 行 (对比 A 默认模式=0 行) · 前 3 行: ${G.linesBeforeFirstFrame.slice(0, 3).join(' | ').slice(0, 160)}`);
  assert('G2 失败原因 / 下一步真的看得见 (不是只丢一句"未就绪")',
    hasPre(G, '未就绪') && hasPre(G, '下一步') && (hasPre(G, '缺 (basic)') || hasPre(G, '缺 (agent)')),
    `命中: 未就绪=${hasPre(G, '未就绪')} 下一步=${hasPre(G, '下一步')} 缺=${hasPre(G, '缺 (basic)') || hasPre(G, '缺 (agent)')}`);
  assert('G3 向导自己的续跑前言也在 (Onboard 模式 —— SKIP_SETUP 场景里没有的那条)',
    hasPre(G, 'Onboard 模式'), `Onboard 模式: ${hasPre(G, 'Onboard 模式')}`);
  // `已存输入:` 是**环境相关**行 (setup store 里真存过 provider 输入才有) —— 本段不强制;
  //   它的"在/不在"由 B1/B3 的**老路径基准**逐条对 (同一轮里跑两遍, 不靠手写清单)。
  const gTodo = PREAMBLE_MARKERS.filter((m) => m !== '初始化完成' && m !== '已存输入:');
  assert('G4 verbose 下这一程的清单一项不缺 (含 Onboard 模式; A/B 场景覆盖不到的那两条)',
    gTodo.every((m) => hasPre(GV, m)),
    `verbose 第一帧前 ${GV.linesBeforeFirstFrame.length} 行 · 清单 ${gTodo.length} 项缺 ${gTodo.filter((m) => !hasPre(GV, m)).length}${gTodo.filter((m) => !hasPre(GV, m)).length ? ': ' + gTodo.filter((m) => !hasPre(GV, m)).join(',') : ''}`);

  // ── H 会话内 /model: 与子命令共用同一套选择器 + ↓ 能到候选末尾 ────────────
  const H = scenarioH();
  const hText = allText(H);
  const hCount = Number((hText.match(/共\s*(\d+)\s*家登记/) || [])[1] ?? -1);
  const diskCount = await diskProviderCount();
  assert('H1 会话内 `/model` 真出全屏选择器, 家数 == 门从盘上真算的家数',
    hCount > 0 && hCount === diskCount,
    `屏上「共 ${hCount} 家登记」· 盘上真算 = ${diskCount} 家 (门直接调 buildProviderSummaries)`);
  const hSeen = [...hText.matchAll(/第\s*(\d+)\/(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const folded = hSeen.filter((p) => p[1] <= 20);
  const expanded = hSeen.filter((p) => p[1] > 200);
  const foldedMax = folded.length ? Math.max(...folded.map((p) => p[0])) : -1;
  const foldedN = folded.length ? folded[folded.length - 1][1] : -1;
  const expMax = expanded.length ? Math.max(...expanded.map((p) => p[0])) : -1;
  const expN = expanded.length ? expanded[expanded.length - 1][1] : -1;
  assert('H2a 折叠态: 连续 ↓ 真能走到行集末尾 (i 走到 == N, 不是卡在窗口边界)',
    folded.length > 2 && foldedMax === foldedN,
    `折叠态采到 ${folded.length} 帧 · 最大 i=${foldedMax} / N=${foldedN}`);
  assert('H2b 展开全部折叠组后: ↓ 真能走到候选末尾 (i == N > 200, 即盘上那 231 家那个行集)',
    expanded.length > 2 && expN > 200 && expMax === expN,
    `展开态采到 ${expanded.length} 帧 · 最大 i=${expMax} / N=${expN} (折叠态 N=${foldedN})`);
  // 选择器每次都从**头行** (`… 共 231 家 · 已筛 … 家`) 起手重绘 → 相邻两个头行之间的行数就是那一帧的高度。
  // ⚠ 不要用"相邻两条状态行"当界: 选择器是**原地重绘** (光标上移 + 擦除), 原始字节里两帧会黏在一行上。
  const hLines = stripAnsi(H.raw).replace(/\r/g, '').split('\n');
  const hSt = hLines.map((l, i) => (l.includes('已筛 ') ? i : -1)).filter((i) => i >= 0);
  const hHeights = hSt.slice(0, -1).map((v, i) => hSt[i + 1] - v);
  // 固定视窗 = 12 行内容 (VIEWPORT_MAX) + 头行 + 状态行 + 上下各一行"还有 N 家" = 最多 16 行
  assert('H3 选择器每帧总行数 ≤ 16 (固定视窗 12 行 + 头/状态/上下指示) 且 ≤ 终端高 30',
    hHeights.length > 10 && hHeights.every((n) => n <= 16 && n <= 30),
    `帧高分布=${[...new Set(hHeights)].sort((a, b) => a - b).join(',')} · 采到 ${hHeights.length} 帧 · 最大 ${Math.max(...hHeights)} 行 ≤ 终端高 30`);
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');
  const gotCmd = /runModelCommand\(\s*modelArg/.test(idxSrc);
  const gotTio = /modelTtyIO\(\)/.test(idxSrc);
  const gotShared = /tui-select\.js/.test(idxSrc);
  assert('H4 与 CLI 子命令共用同一套选择器 (源码级: 会话内那条也走 runModelCommand + tui-select)',
    gotCmd && gotTio && gotShared,
    `src/index.ts: runModelCommand=${gotCmd} · modelTtyIO=${gotTio} · tui-select=${gotShared}`);

  // ── H2 会话内 /model: 打字即筛 + 逐帧几何 + Esc 两级语义 (2026-09-27 收尾验) ──
  //  取证口径 (不猜终端状态): pty-run 给每个按键记了 `bytes` = **按下它之前**已收到的字节数,
  //  所以 window(键) = raw[bytes(键) : bytes(下一个键)] 就是「这个键按下之后选择器画出来的那一帧」。
  //  一次重绘的字节流 = `ESC[<n>A ESC[J` + 头行 + 候选行… + 状态行(无换行) ⇒ 逐行可数、逐字可比。
  //  期望值一律从盘上真算 (`diskFilterHits`), 不写死 220/3/1 —— 目录一变这些数就变。
  const CFG_REAL = path.join(os.homedir(), '.bolloon', 'bolloon-config.json');
  const cfgBefore = fileSha(CFG_REAL);
  const H2 = scenarioH2();
  const cfgAfter = fileSha(CFG_REAL);
  const marks = H2.keys.filter((k) => k.kind === 'keys');
  const markOf = (data: string, nth = 0): any => marks.filter((k) => k.data === data)[nth];
  const winLines = (a: any, b: any): string[] => {
    if (!a || !b) return [];
    return stripAnsi(H2.rawBuf.slice(a.bytes, b.bytes).toString('utf8'))
      .split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter((l) => l.trim().length > 0);
  };
  /** 一个按键窗口里**最后一帧**的读数 (窗口里偶尔有两帧: 初绘 + 重绘 ⇒ 取最后一帧) */
  const frameOf = (a: any, b: any) => {
    const rows = winLines(a, b);
    const headIdx = (() => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].includes('选择供应商')) return i; return -1; })();
    const stIdx = (() => { for (let i = rows.length - 1; i >= 0; i--) if (i > headIdx && /第 \d+\/\d+/.test(rows[i])) return i; return -1; })();
    const curIdx = rows.findIndex((l, i) => i > headIdx && l.startsWith('→ '));
    const status = stIdx >= 0 ? rows[stIdx].replace(/^\s+/, '') : '';
    // 状态行偶尔会被写到**上一帧窗口的末尾** (两次重绘在字节上粘成一行 —— 数字键那两帧实测如此),
    //   这时本窗口只剩头行+候选行: 行数按「头行 → 窗口末行 + 1(隐含的那行状态)」算, 不谎报 0。
    const height = headIdx >= 0 ? (stIdx > headIdx ? stIdx - headIdx + 1 : rows.length - headIdx + 1) : -1;
    return {
      rows,
      head: headIdx >= 0 ? rows[headIdx] : '',
      hasStatus: stIdx > headIdx,
      shown: Number(((headIdx >= 0 ? rows[headIdx] : '').match(/已筛\s*(\d+)\s*家/) || [])[1] ?? -1),
      query: (status.match(/筛选 "([^"]*)"/) || [])[1] ?? '',
      idxInList: (status.match(/第 (\d+)\/(\d+)/) || [])[1] ?? '',
      status,
      height,
      cursorText: curIdx >= 0 ? rows[curIdx].trim() : '',
      ok: headIdx >= 0,
    };
  };
  const SF = {
    full: frameOf(markOf('\\r', 1), markOf('n')),          // 打字前 (第二个回车之后)
    n: frameOf(markOf('n'), markOf('v')),
    nv: frameOf(markOf('v'), markOf('i')),
    nvi: frameOf(markOf('i'), markOf('1')),
    d1: frameOf(markOf('1'), markOf('2')),
    d2: frameOf(markOf('2'), markOf('9')),
    d9: frameOf(markOf('9'), markOf('\\u007f', 0)),
    bs1: frameOf(markOf('\\u007f', 0), markOf('\\u007f', 1)),
    bs2: frameOf(markOf('\\u007f', 1), markOf('\\u007f', 2)),
    bs3: frameOf(markOf('\\u007f', 2), markOf('\\u001b', 0)),
  };
  const idsN = (await diskFilterHits('n')).map((h) => h.id);
  const idsNV = (await diskFilterHits('nv')).map((h) => h.id);
  const idsNVI = (await diskFilterHits('nvi')).map((h) => h.id);
  const keyFrames = [SF.full, SF.n, SF.nv, SF.nvi, SF.bs1, SF.bs2, SF.bs3];
  record('H5 前置: 打字那十个按键各自都采到了头行, 关键七帧还要有状态行 (否则 H6–H13 全是空判)',
    Object.values(SF).every((f) => f.ok) && keyFrames.every((f) => f.hasStatus),
    `十帧读数: ${Object.entries(SF).map(([k, v]) => `${k}=${v.ok ? 'ok' : '缺头行'}(已筛 ${v.shown}${v.hasStatus ? '' : ',状态行并入上帧'})`).join(' · ')}`);
  assert('H6 直接打字即筛 (不用先按 `/`): 头行「已筛 N 家」逐字缩小, 末态 == 门从盘上真算的命中家数',
    SF.full.shown === diskCount && SF.n.shown > SF.nv.shown && SF.nv.shown > SF.nvi.shown &&
      SF.nvi.shown === idsNVI.length && SF.n.shown >= idsN.length && SF.nv.shown >= idsNV.length,
    `屏上「已筛」: 全量 ${SF.full.shown} → "n" ${SF.n.shown} → "nv" ${SF.nv.shown} → "nvi" ${SF.nvi.shown}`
      + ` · 门从盘上真算 (id+行文下界): "n" ${idsN.length} / "nv" ${idsNV.length} / "nvi" ${idsNVI.length}`
      + ` (候选共 ${diskCount}; 屏上可能多于下界 —— 选择器连名字/hint/分组一起匹配)`);
  assert('H7 打字命中后**光标真的落在那一行** (不只看列表变短)',
    idsNVI.length > 0 && SF.nvi.cursorText.length > 0 && idsNVI.every((id) => SF.nvi.cursorText.includes(id)),
    `门真算 "nvi" 命中 ${idsNVI.join(',') || '(0)'} · 屏上光标行=「${SF.nvi.cursorText.slice(0, 58)}」 (第 ${SF.nvi.idxInList} 项)`);
  assert('H8 退格逐字恢复: 回程「已筛」数与去程逐字相同, 最后回到全量 (= 门真算的候选总数)',
    SF.bs1.shown === SF.nv.shown && SF.bs2.shown === SF.n.shown && SF.bs3.shown === diskCount &&
      SF.bs1.query === 'nv' && SF.bs2.query === 'n' && SF.bs3.query === '',
    `去程→回程: "nv" ${SF.nv.shown}→${SF.bs1.shown} · "n" ${SF.n.shown}→${SF.bs2.shown} · 全量 ${SF.full.shown}→${SF.bs3.shown}`
      + ` (门真算 ${diskCount}) · 回程屏上筛词=["${SF.bs1.query}","${SF.bs2.query}","${SF.bs3.query}"]`);
  const rowsInFilter = idsNVI.length + 1;   // 筛选态行集 = 命中家数 + 末行 Cancel
  assert('H9 筛词态数字跳选仍对 (`2` 跳到第 2 行 = 末行 Cancel; `9` 越界并报出真实范围)',
    SF.d2.status.includes(`第 2/${rowsInFilter}`) && SF.d2.status.includes('已跳到第 2 项') &&
      /Cancel/.test(SF.d2.cursorText) &&
      new RegExp(`超出范围 \\(这里只有 1~${rowsInFilter} 项\\)`).test(SF.d9.rows.concat(SF.d2.rows).join('\n')),
    `筛词态行数 N=${rowsInFilter} (命中 ${idsNVI.length} + Cancel) · 按 2 后: 「${SF.d2.status.slice(0, 62)}」 光标行「${SF.d2.cursorText.slice(0, 30)}」`
      + ` · 按 9 后屏上出现: ${new RegExp(`超出范围 \\(这里只有 1~${rowsInFilter} 项\\)`).test(SF.d9.rows.concat(SF.d2.rows).join('\n'))}`);
  const escKeys = marks.filter((k) => k.data === '\\u001b');
  const selEsc = escKeys[0], escA = escKeys[1], escB = escKeys[2], escC = escKeys[3];
  // 面板那一级: ① 孤立一击 → 必须**不退** (下一击之前帧还在长); ② 500ms 内的双击 → 真退出。
  const aliveAfterLone = !!escA && !!escB && Number(escB.frames) > Number(escA.frames);
  const tail = H2.raw.slice(-500);
  const teardown = /\x1b\[\?25h/.test(tail);
  const crashed = /Unhandled|Error:|at Object\./.test(H2.raw.slice(-3000));
  const inkAfterSel = H2.frameLines.slice(selEsc?.frames ?? Number.MAX_SAFE_INTEGER);
  assert('H10 Esc 第一级 (选择器): 取消回面板 —— 进程不退 (Ink 继续画帧), 选择器消失 + 输入行回来',
    escKeys.length >= 3 && !!selEsc && inkAfterSel.length >= 2 &&
      inkAfterSel.some((f) => f.some((l) => l.includes('❯ '))),
    `屏上 Esc 事件 ${escKeys.length} 次 · 选择器 Esc 之后 Ink 帧=${inkAfterSel.length}`
      + ` · 输入行回来=${inkAfterSel.some((f) => f.some((l) => l.includes('❯ ')))}`
      + ` · 附注: 会话内取消的文字回执与时机有关 (实测有/无都出现过), 这一条只钉"选择器真没了 + 输入行回来 + 进程不退"`);
  assert('H11 Esc 第二级 (面板): 孤立一击不退出 (下一击前帧还在长), 500ms 内的双击才真退出 (屏上收尾可读)',
    escKeys.length >= 4 && aliveAfterLone && teardown && !crashed,
    `孤立一击之后再画帧=${aliveAfterLone} (帧号 ${escA?.frames} → ${escB?.frames}) · 收尾帧=${teardown} · 崩溃痕迹=${crashed}`
      + ` · 子进程 exit=${H2.exit === null ? '(没读到, 以收尾帧为准)' : H2.exit} watchdog=${H2.watchdog}`
      + ` · 附注: 第一击的「再按一次 Esc」提示行**可能来不及上屏** (350ms 内就退出了), 故判据落在"不退/真退"上`);
  assert('H12 Esc 取消之后配置 sha 逐字节不变 (读真 HOME 的 bolloon-config.json)',
    cfgBefore !== null && cfgAfter !== null && cfgBefore === cfgAfter,
    `跑前 sha=${cfgBefore ? cfgBefore.slice(0, 16) : '(读不到 → 判红)'} → 跑后 sha=${cfgAfter ? cfgAfter.slice(0, 16) : '(读不到 → 判红)'}`
      + ` · 文件=${CFG_REAL}`);
  // 逐帧几何: 固定视窗 (≤12 行) + 头行 + 状态行 (+ 上下指示) ⇒ 单帧 ≤ 16 行 (硬预算);
  //   「同一筛选态去/回程」画出来的帧必须**同高、同行号、同计数** (= 恢复的是同一版版面, 不是"看起来像")。
  const MAX_SEL_LINES = 16;
  const heights = Object.fromEntries(Object.entries(SF).map(([k, v]) => [k, v.height]));
  const sameGeometry = SF.n.height === SF.bs2.height && SF.nv.height === SF.bs1.height &&
    SF.full.height === SF.bs3.height && SF.n.idxInList === SF.bs2.idxInList && SF.nv.idxInList === SF.bs1.idxInList;
  assert(`H13 选择器逐帧几何: 每帧 ≤ ${MAX_SEL_LINES} 行 (硬预算) 且同一筛选态去/回程帧高·行号逐字相同`,
    Object.values(heights).every((h) => h > 0 && h <= MAX_SEL_LINES) && sameGeometry,
    `帧高: ${Object.entries(heights).map(([k, v]) => `${k}=${v}`).join(' ')} (最大 ${Math.max(...Object.values(heights))} ≤ ${MAX_SEL_LINES})`
      + ` · 去/回程同态: "n" ${SF.n.height}行/第${SF.n.idxInList}项 vs ${SF.bs2.height}行/第${SF.bs2.idxInList}项`
      + ` · "nv" ${SF.nv.height}行/第${SF.nv.idxInList}项 vs ${SF.bs1.height}行/第${SF.bs1.idxInList}项`);
  const panelBack = inkAfterSel.slice(0, -1);
  const pHeights = [...new Set(panelBack.map((f) => f.length))];
  assert('H14 Esc 回面板后: 面板帧行数 == 终端高 30 (选择器那套几何没把面板带歪)',
    panelBack.length >= 2 && pHeights.length === 1 && pHeights[0] === 30,
    `回面板后帧数=${panelBack.length} (不含卸载帧) · 帧高集合={${pHeights.join(',')}} (期望 {30})`);

  return printSummary();
}

function printSummary(): number {
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skip = results.filter((r) => r.ok === 'skip').length;
  console.log(`\n=== 结果: ${pass}/${results.length} 通过${skip ? ` · ${skip} 跳过` : ''}${fail ? ` · ${fail} 失败` : ''} ===`);
  if (fail) console.log('失败项: ' + results.filter((r) => r.ok === false).map((r) => r.name.split(' ')[0]).join(', '));
  return fail === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 变异 (改源码 → 重建 → 断言目标检查变红 → 还原)
// ---------------------------------------------------------------------------

interface Mutation { id: string; file: string; from: string; to: string; target: string[] }

const MUTATIONS: Mutation[] = [
  {
    id: 'M1 把前言刷回启动前',
    file: 'src/cli/startup-notice.ts',
    from: 'export function startupPreambleVisible(\n  env: NodeJS.ProcessEnv = process.env,\n  args: string[] = process.argv.slice(2),\n): boolean {\n  const v = (env[PREAMBLE_ENV] ?? \'\').trim().toLowerCase();\n  if (TRUTHY.has(v)) return true;\n  return isStartupVerbose(args, env);',
    to: 'export function startupPreambleVisible(\n  env: NodeJS.ProcessEnv = process.env,\n  args: string[] = process.argv.slice(2),\n): boolean {\n  void env; void args; // MUTATION: 前言一律刷回启动前\n  return true;',
    target: ['A1', 'A2'],
  },
  {
    id: 'M2 把失败提示一并吞掉 (告警数组清空)',
    file: 'src/index.ts',
    from: '  const notes = takeStartupPanelNotes();',
    to: '  const notes = takeStartupPanelNotes();\n  notes.alerts.length = 0; // MUTATION: 吞掉失败提示',
    target: ['A4'],
  },
  {
    id: 'M3 输入框不按宽度裁剪',
    file: 'src/cli/ink-app.tsx',
    from: '        <Box width={Math.max(10, budget.cols - 2)} height={1} overflow="hidden" flexShrink={0}>',
    to: '        <Box flexShrink={0}>',
    target: ['D1', 'D4'],
  },
  {
    id: 'M4 输入栏不加高 1 行 (占位文案在窄终端换行 → 打字时整块位移)',
    file: 'src/cli/ink-app.tsx',
    from: '        <Box width={Math.max(10, budget.cols - 2)} height={1} overflow="hidden" flexShrink={0}>',
    to: '        <Box width={Math.max(10, budget.cols - 2)} overflow="hidden" flexShrink={0}>',
    target: ['D2', 'D2b'],
  },
  {
    id: 'M5 状态栏不加高 1 行 (状态串在窄终端换行 → 底下固定栏整块漂)',
    file: 'src/cli/ink-app.tsx',
    from: '      <Box height={1} width={budget.cols} overflow="hidden">\n        <Text>{status}</Text>',
    to: '      <Box>\n        <Text>{status}</Text>',
    target: ['D2b'],
  },
  {
    id: 'M6 降级提示只落盘、不折面板 (降级被吞)',
    file: 'src/index.ts',
    from: '  logStartupLine(line);                       // 诊断不丢: 无论上不上屏\n  if (!carriesHumanSignal(line)) return;      // 纯进度: 默认口径下不上屏\n  if (startupPanelReady) appendLine(`${C_WARN}/!\\\\ ${line}${RESET}`);\n  else pushStartupAlert(line);',
    to: '  logStartupLine(line);\n  return; // MUTATION: 折进面板那一步拿掉 (降级只落盘 = 被吞)',
    target: ['A7'],
  },
];

function build(): boolean {
  const r = spawnSync('npx', ['tsc'], { cwd: ROOT, encoding: 'utf-8', timeout: 300_000 });
  return r.status === 0;
}

/**
 * 变异残留自检 —— 变异是**就地改源文件**再还原, 一轮被 SIGKILL 打断 (超时 / 手动杀)
 * 会把"改坏的源"留在盘上 (真踩过一次: `src/index.ts` 里留下 `notes.alerts.length = 0; // MUTATION: …`)。
 * 命中残留 / 锚点不见了 → **拒绝开跑**, 否则红绿完全说不清。跑完请人工确认再重来。
 */
function mutationResidue(): string[] {
  const bad: string[] = [];
  for (const m of MUTATIONS) {
    const fp = path.join(ROOT, m.file);
    const txt = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
    if (txt.includes(m.to)) bad.push(`${m.id}: ${m.file} 里还留着改坏的源`);
    if (!txt.includes(m.from)) bad.push(`${m.id}: ${m.file} 里找不到待改片段 (锚点不见了)`);
  }
  return bad;
}

async function mutationMode(): Promise<number> {
  console.log(`\n=== verify-cli-panel --mutation (每条: 改坏源码 → 重建 → 断言目标检查变红) ===\n`);
  let bad = 0;
  // ── R0 开工前自检 (残留 / 锚点) ─────────────────────────────────────────
  const residue = mutationResidue();
  if (residue.length) {
    record('R0 开工前自检: 锚点全在原位且无上一轮残留', false,
      `${residue.length} 处问题 —— 拒绝开跑: ${residue.join(' | ')}`);
    return 1;
  }
  record('R0 开工前自检: 锚点全在原位且无上一轮残留', true,
    `${MUTATIONS.length} 条变异锚点全命中, 无残留 (上一轮若被 SIGKILL 打断会留在这里)`);
  for (const m of MUTATIONS) {
    const p = path.join(ROOT, m.file);
    const orig = fs.readFileSync(p, 'utf-8');
    if (!orig.includes(m.from)) {
      record(`${m.id} (前置: 能定位到源码片段)`, false, `${m.file} 里没找到待改片段 —— 变异无效, 不当作通过`);
      bad++;
      continue;
    }
    fs.writeFileSync(p, orig.replace(m.from, m.to), 'utf-8');
    let reds: string[] = [];
    try {
      if (!build()) { record(`${m.id} (重建)`, false, 'tsc 失败 —— 变异没能跑起来'); bad++; continue; }
      results.length = 0;
      await main();
      reds = results.filter((r) => m.target.some((t) => r.name.startsWith(t)) && r.ok === false).map((r) => r.name.split(' ')[0]);
    } finally {
      fs.writeFileSync(p, orig, 'utf-8');
    }
    const ok = reds.length > 0;
    record(`${m.id} → 门必红`, ok, ok ? `目标检查判红: ${[...new Set(reds)].join(',')}` : `目标检查仍全绿 (${m.target.join(',')}) —— 门是恒真的, 不算通过`);
    if (!ok) bad++;
  }
  if (!build()) console.log('!! 还原后 tsc 失败, 请检查工作区');
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log(`\n=== 变异结果: ${pass}/${results.length} 通过${fail ? ` · ${fail} 失败` : ''} ===`);
  return bad === 0 ? 0 : 1;
}

const code = MUTATION ? await mutationMode() : await main();
process.exit(code);
