/**
 * verify-model-ux.ts — `bolloon model` 交互体验验收门 (**真 pty**, 2026-09-27)
 *
 * 为什么必须真 pty: 被测行为里有一条硬分支 —— `process.stdin.isTTY`。
 *   `printf '1\n' | bolloon model` 测到的是**非终端**那条路 (清单+用法), 不是用户敲命令时走的那条。
 *   所以本门用 `scripts/lib/pty-drive.py` 开真伪终端跑, 并且"等渲染出现再喂下一步" —— 等待本身就是断言。
 *
 * ⚠️ 驱动时序 (踩过坑, 写在这里免得再踩): `pty-drive` 的语义是
 *   **先等本步的 expect 出现 → 再把本步的 `send` 喂进去**。所以"发一个键"的正确写法是
 *   「上一/本步的 expect 已被当前画面满足」+ `send`, 然后**下一步**的 expect 才是这个键的效果。
 *   把"等待按键效果"和"发送按键"写在同一步 = 永远等不到 (上一条线就是这么写坏的)。
 *
 * 验的十四件事 (对应 leo 亲测报的口径; ⑨-⑬ 是 2026-09-27 二改加的口径):
 *   ① 裸敲 `bolloon model` = 切换启动命令: 真终端里第一屏**就是**带序号/状态/当前项标记的供应商列表,
 *      **不许**先刷一坨供应商清单+用法; 管道/非 TTY 才退回清单+用法 (脚本可读, 不卡等待输入)。
 *   ② 四条同级选择方式都真生效: ↑/↓ 高亮**真位移** (两帧反白行对比) · 数字跳选 · 逐字/`/` 筛选
 *      (列表**真变短**且状态行 `已筛`/`第 i/N` 真变) · 滚动窗口 (光标越过窗口时窗口真的滚)。
 *   ③ 非法输入**说清为什么** (序号 0 = "从 1 开始"; 超范围报实际范围), 不是无声重来。
 *   ④ EOF / Ctrl-D → 干净取消, **一个字节都不写**。
 *   ⑤ 凭证步**四条路可达** (保持 / 替换 / 清除 / 改用环境变量) + 掩码输入: 独特探针串走一遍,
 *      pty **原始输出里该串 0 命中**, 且屏幕上有掩码字符 `•` (长度对得上 ⇒ 输入真收到了)。
 *   ⑥ 版面预算: 每步**主屏** (非选择器帧) 渲染 ≤ 12 行; 主屏**不出现**黑名单串
 *      (`未知原因` / 逐行复读的 `工具调用=未知` / 教程行 `看目录:` / 假二次确认 `还要继续尝试切换吗`)。
 *      另有正向对照: `--verbose` 时这些内部细节**必须真的打出来** (证明是"挪走"不是"删掉")。
 *   ⑦ 真开关: 切换真落盘 (配置 sha 变了) + 探测真打到**假上游** (记录到真请求, 不是空转);
 *      探测**失效**时 (连不上) 停在这一步、不写盘、也不出现假二次确认。
 *   ⑧ `list` 子命令只读 (配置 sha 不变)。
 *   ⑨ **候选集 = 盘上全部家** (内置 13 + 自定义 + 目录全部): 第 1 步头行/标题里的 `共 N 家` 与
 *      盘上真算的家数逐家对齐 (允许的排除项必须在报告里点名), 目录家**搜得到、选得中、能继续走流程**。
 *   ⑩ **固定高度视窗 + 分组折叠**: 单帧渲染总行数 ≤ 终端高度 (不是靠终端回滚缓冲才"看得完") ·
 *      收起的分组标题**照写家数**且与盘上真算一致 · `空格/→` 展开真生效 (两帧对比) ·
 *      `special (需专用鉴权, 未支持)` / `无基址 (需自定义 baseUrl)` 的家在真 pty 屏幕上真能看到。
 *   ⑪ **颜色只有一个来源**: 屏幕上的真彩序列 (`38;2;` / `48;2;`) 用到的 RGB **全部**来自
 *      `src/cli/theme.ts` 的调色板 (本门真读那个文件, 不复制一份) · 光标行有背景 + 反白 ·
 *      `NO_COLOR=1` 下仍然靠符号分得清 (●/○/→/分组标记) · `tui-select.ts` + `model-selector.ts`
 *      里 hex 字面量计数 == 0 (全走 `THEME.*` / `fg()` / `bg()`)。
 *   ⑫ **(三改加) 光标落在任意行类上都有明显选中态**: 分组标题 / 普通项 / `special` / `无基址` /
 *      `←当前` / `Cancel` 逐类比"选中 vs 未选中"两帧**原始字节** (选中帧该行带 `48;2;` 或 `7m` ·
 *      两帧字节不同 · 未选中行不带底色)。光标行落在哪一行**不看哪行有反白** (那是被测对象),
 *      而是由状态行 `第 i/N` + 帧几何自推 —— 正是这条抓出了 leo 踩的"分组标题行没有选中态"。
 *   ⑬ **长列表响应性 (给真耗时)**: 候选平铺成 200+ 行时**连续 20 次按键**, 每一次按键都
 *      **等"新的 `第 i/N · 筛选 …` 帧"出现** —— 等的毫秒数就是这一键的重绘延迟 (视窗定位 / 滚动 /
 *      摊行 全在这条路径上); 逐次记下来报 p50/p95/max, 并断言序号序列真的 1,2,…,21 逐行递进。
 *      (判据不是"按完没崩" —— 那种假判据对"卡"一无所获。)
 *   ⑭ **变异判红** (门承重): 19 条变异逐条跑, 每条都必须把自己的判据打红
 *      (其中 M18 = 把分组标题行的选中态拿掉 · M19 = 选中态只剩 `→ ` 标记没有颜色 —— 这两条就是
 *       leo 报的这一类回归的守门人)。
 *
 * 报告口径: 只贴**真渲染** (pty 原始输出里摘), 计数与结论都从盘上/输出里算, 不从内存复述。
 * 凭据: 假上游 + 隔离 home + 洗过的 env (把 `*_API_KEY/*_KEY/*_TOKEN/*_SECRET` 全删掉再 spawn);
 *      本门自己种进配置的 key 是**每轮随机生成**的, 既不打印也不进报告 (报告里只有 `[REDACTED]` / 指纹)。
 * 退出码: 0 = 全过; 1 = 有红; 2 = 脚本自身崩了。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
// ★ 颜色断言只用**真事实源**: 本门从 `theme.ts` 真读调色板来比对 (不在这里抄一份 hex ——
//   抄一份的话"配色统一"就变成了自证)。
import { THEME } from '../src/cli/theme.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-ux-'));
const HOME = path.join(TMP, 'home');
const BH = path.join(HOME, '.bolloon');
const CONFIG = path.join(BH, 'bolloon-config.json');

// 隔离先做: 本门不 import src 的运行时模块 (整条链路走子进程), 但假上游与本门自己的路径也要隔离
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_HOME = BH;
process.env.BOLLOON_SKIP_UPDATE = '1';
process.env.BOLLOON_SKIP_SETUP = '1';
process.env.BOLLOON_SKIP_KUBO = '1';

const ENTRY = path.join(ROOT, 'src', 'cli-entry.ts');
const DRIVER = path.join(ROOT, 'scripts', 'lib', 'pty-drive.py');
/** 直接用仓里的 tsx 二进制 (`npx` 会带上 npm 的 spinner/更新提示, 那是**噪音**, 会污染"主屏"判定) */
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

// ============================================================
// ANSI 原语 (与 src/cli/tui-select.ts 同一套)
// ============================================================

const E = '\x1b';
/** 清到行末 —— 全屏选择器**每一行**都带它 ⇒ 它是"这一行属于帧"的结构判据 */
const ERASE_EOL = `${E}[K`;
/** 帧边界: `ESC[<n>A ESC[J` (首帧/收尾是 `ESC[J`) */
const FRAME_SEP_RE = /\x1b\[\d*A\x1b\[J|\x1b\[J/g;

/** 掩码探针 (独特串; 走一遍凭证步之后原始输出里必须 0 命中) —— 不是真 key, 也不参与任何鉴权 */
const MASK_PROBE = 'Zq7MASKPROBEdonotleak9f3a';

/** 本门种进配置的凭证: **每轮随机**, 只进文件/请求头, 不进 stdout/报告 */
const GATE_KEY = `gate-${crypto.randomBytes(12).toString('hex')}`;

/** 探测"目录外模型"用的 baseUrl (由**假上游**给; S/M9 共用这一份, 免得两处各编一个地址) */
let OOC_BASE = '';

/** 主屏黑名单 (2026-09-27 版面减法): 这些串只许出现在 `--verbose` 里, 不许刷在主屏 */
const LAYOUT_BLACKLIST = ['未知原因', '工具调用=未知', '看目录:', '还要继续尝试切换吗'];
/** 每步主屏行数预算 */
const STEP_LINE_BUDGET = 12;

let passed = 0;
let failed = 0;
const failures: string[] = [];
const reportLines: string[] = [];

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

function report(line: string): void {
  reportLines.push(line);
}

function sha(p: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; }
}

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function short(s: unknown, n = 150): string { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** 报告里出现的凭证一律换成这个 (本门没有真 key, 但格式上也不许漏) */
const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// 子进程环境: **洗掉一切凭据类 env** + 隔离 home
// ---------------------------------------------------------------------------

const CRED_RE = /(_API_KEY|_APIKEY|_TOKEN|_SECRET|_KEY)$/i;
const droppedEnvNames: string[] = [];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME, USERPROFILE: HOME, BOLLOON_HOME: BH, TERM: 'xterm-256color',
    BOLLOON_SKIP_UPDATE: '1', BOLLOON_SKIP_SETUP: '1', BOLLOON_SKIP_KUBO: '1',
    BOLLOON_CRON: '0', BOLLOON_SUPERVISOR: '0',
    // 隔离家里没有 `bolloon setup` 的引导状态 —— 用代码里已有的旁路开关 (与 setup 向导同一条),
    //   而不是把机主真实的 LLM 配置(含真凭据)搬进来。
    BOLLOON_SETUP_IN_PROGRESS: '1',
  };
  for (const k of Object.keys(env)) {
    if (CRED_RE.test(k)) { delete env[k]; if (!droppedEnvNames.includes(k)) droppedEnvNames.push(k); }
  }
  delete env.BOLLOON_MODEL_SKIP_PROBE;
  delete env.BOLLOON_SESSION_KEY;
  return env;
}

// ---------------------------------------------------------------------------
// 真 pty: 跑计划 (`expect` 等到了才喂下一步)
// ---------------------------------------------------------------------------

interface PlanStep {
  name: string;
  /** 去 ANSI + 归一化换行之后匹配 (人看的文字) */
  expect?: string;
  /** **原始字节**匹配 (含 ANSI) —— 用来断言"真有高亮/真有掩码字符" */
  expect_raw?: string;
  /** 到这一步为止原始输出里**不许**命中 (例如明文 key) */
  until_absent?: string;
  send?: string;
  timeout_s?: number;
}
interface PtyStepResult {
  name: string; expect?: string; expect_raw?: string; until_absent?: string;
  absent_ok?: boolean | null; matched: boolean; waited_ms: number; sent?: string;
}
interface PtyResult {
  ok: boolean; exit: number | null; killed: boolean; elapsed_s: number;
  steps: PtyStepResult[]; raw: string; text: string; driverOut: string;
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

interface PtyPlan {
  timeout_s: number; settle_ms?: number; cols?: number; rows?: number;
  /** 追加/覆盖子进程 env (值为 null = 删掉这个变量); 无色降级那条路要用它塞 `NO_COLOR=1` */
  env?: Record<string, string | null>;
  steps: PlanStep[];
}

/**
 * 跑一轮真 pty。
 *
 * ⚠️ 必须**异步** spawn: 假上游跑在**本进程**里, `spawnSync` 会把父进程的事件循环堵死 ⇒
 * 子进程的探测请求没人应答, 量到的是"上游连不上"这种假红 (sibling gate 踩过同一个坑)。
 */
function runPty(tag: string, args: string[], plan: PtyPlan): Promise<PtyResult> {
  const planPath = path.join(TMP, `${tag}-plan.json`);
  const outPath = path.join(TMP, `${tag}-raw.txt`);
  const jsonPath = path.join(TMP, `${tag}-res.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return new Promise((resolve) => {
    const c = spawn('python3', [
      DRIVER, '--plan', planPath, '--out', outPath, '--json', jsonPath, '--cwd', ROOT, '--',
      TSX, ENTRY, ...args,
    ], { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let driverOut = '';
    c.stdout?.on('data', (d) => (driverOut += d));
    c.stderr?.on('data', (d) => (driverOut += d));
    const done = (): void => {
      const raw = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : '';
      const res = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) : null;
      resolve({
        ok: !!res?.ok, exit: res?.exit ?? null, killed: !!res?.killed,
        elapsed_s: res?.elapsed_s ?? -1, steps: res?.steps ?? [],
        raw, text: stripAnsi(raw), driverOut,
      });
    };
    c.on('close', done);
    c.on('error', (e) => { driverOut += String(e); done(); });
  });
}

/** 非终端 (管道) 跑法: stdin 是个**关掉的管道** —— 这才能测"非 TTY 退回清单" */
function runPipe(args: string[]): Promise<{ code: number; out: string; elapsed: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(TSX, [ENTRY, ...args], { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 已死 */ } }, 120_000);
    c.stdout?.on('data', (d) => (out += d));
    c.stderr?.on('data', (d) => (out += d));
    try { c.stdin?.end(); } catch { /* 已关 */ }
    c.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, elapsed: Date.now() - t0 }); });
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + String(e), elapsed: Date.now() - t0 }); });
  });
}

// ---------------------------------------------------------------------------
// 帧分析: 高亮行 / 状态行数字 / 主屏行 / 渲染宽度
//
// 渲染器每画一帧 = 头行 + H 行列表 + 状态行; 光标行整行反白 (`ESC[7m…ESC[0m`)。
// 每条帧内行都以 `ESC[K` (清到行末) 结尾 ⇒ 这个序列是"这行属于帧"的**结构判据**,
// 主屏行 (io.print) 永远不带它。于是"主屏"不用猜、不用读提示文字就能切出来。
// ---------------------------------------------------------------------------

/** 一帧里被反白的那一行 (去掉 ANSI + 行首 `→ ` 标记) */
function highlightRows(raw: string): string[] {
  const out: string[] = [];
  const re = /\x1b\[7m([\s\S]*?)\x1b\[0m/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const text = stripAnsi(m[1]).replace(/\s+$/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

/** 状态行里的 `第 i/N` 序列 (按出现顺序) —— 光标真的在动就会变 */
function cursorIndexes(raw: string): number[] {
  const out: number[] = [];
  const re = /第\s*(\d+)\s*\/\s*(\d+)/g;
  let m: RegExpExecArray | null;
  const text = stripAnsi(raw);
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** 状态行里的 `已筛 M 家` 序列 (筛选真的生效了就会变小) */
function filteredCounts(raw: string): number[] {
  const out: number[] = [];
  const re = /已筛\s*(\d+)\s*家/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripAnsi(raw))) !== null) out.push(Number(m[1]));
  return out;
}

/** 每一帧的**内容行** (按帧边界切; 只留带 `ESC[K` 的那些, 去掉 ANSI 与尾部回车) */
function frameBlocks(raw: string): string[][] {
  const blocks: string[][] = [];
  for (const chunk of raw.split(FRAME_SEP_RE)) {
    const lines: string[] = [];
    for (const ln of chunk.split('\n')) {
      const at = ln.indexOf(ERASE_EOL);
      if (at < 0) continue;
      const body = stripAnsi(ln.slice(0, at)).replace(/\r/g, '').trimEnd();
      lines.push(body);
    }
    if (lines.length) blocks.push(lines);
  }
  return blocks;
}

/**
 * 一帧里的**候选项行** (分组标题 `  ── …` 与空行都不算)。
 *
 * ⚠ 光标落在分组标题行上时, 那一行是 `→ ── …` (2026-09-27 三改: 光标行不分行类) —— 它**不是**
 * 候选项行, 所以 `→ ──` 也要排除, 否则"候选项行数"会把光标所在的那个标题行算进去。
 */
function itemLines(block: string[]): string[] {
  return block.filter((l) => l.startsWith('→ ')
    ? !l.startsWith('→ ── ')
    : (l.startsWith('  ') && !l.startsWith('  ── ')));
}

/**
 * **主屏**行: 把帧边界与帧内行剔掉之后剩下的 (即 `io.print` 打出来的那些)。
 * 这是"版面预算"与"黑名单串"两条断言的取样面 —— 用户真正逐行读的是它。
 */
function mainScreenLines(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.replace(FRAME_SEP_RE, '\n').split('\n')) {
    if (chunk.includes(ERASE_EOL)) continue;   // 帧内的行 (含掩码输入行)
    const t = stripAnsi(chunk).replace(/\r/g, '').trim();
    if (t) out.push(t);
  }
  return out;
}

/** 主屏按 `步骤 N/7` 分段 (取"每步渲染了几行") */
function stepSegments(lines: string[]): Array<{ step: number; lines: string[] }> {
  const segs: Array<{ step: number; lines: string[] }> = [];
  let cur: { step: number; lines: string[] } | null = null;
  for (const l of lines) {
    const m = /步骤\s*(\d)\s*\/\s*7/.exec(l);
    if (m) { cur = { step: Number(m[1]), lines: [l] }; segs.push(cur); continue; }
    if (!cur) { cur = { step: 0, lines: [] }; segs.push(cur); }
    cur.lines.push(l);
  }
  return segs;
}

// ---------------------------------------------------------------------------
// 颜色 (⑪): 真彩序列 vs `theme.ts` 的调色板
// ---------------------------------------------------------------------------

/** '#c4d640' → '196;214;64' (真彩序列里的那个写法) */
function rgbOfHex(hex: string): string {
  const h = String(hex || '').trim();
  return `${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}`;
}

/** 调色板 (**从 theme.ts 真读**): token → 'r;g;b' */
function paletteRgb(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [token, hex] of Object.entries(THEME as Record<string, string>)) out.set(token, rgbOfHex(hex));
  return out;
}

interface TrueColorHit { channel: string; rgb: string }

/** 原始输出里所有真彩序列 (`38;2;r;g;b` 前景 / `48;2;r;g;b` 背景) */
function trueColorHits(raw: string): TrueColorHit[] {
  const out: TrueColorHit[] = [];
  const re = /\x1b\[(3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push({ channel: m[1], rgb: `${Number(m[2])};${Number(m[3])};${Number(m[4])}` });
  return out;
}

// ---------------------------------------------------------------------------
// 视窗预算 (⑩): 单帧渲染**总行数** / 帧里的真候选行
// ---------------------------------------------------------------------------

/** 每一帧的渲染行数 (头行 + 视窗内可见行 + 滚动指示行 + 状态行) —— 帧行都带 `ESC[K` */
function frameSizes(raw: string): number[] {
  return frameBlocks(raw).map((b) => b.length).filter((n) => n > 0);
}

/** 一帧里的**真候选行** (以 ●/○ 开头; 分组标题 / 滚动指示 / 状态行都不算) */
function candidateRows(block: string[]): string[] {
  return block.filter((l) => /^(→ | {2})[●○] /.test(l));
}

// ---------------------------------------------------------------------------
// 行类光标态分析 (2026-09-27 三改): "光标在**每一类行**上都有明显选中态" 的可核判据
//
// leo 亲测报的: 光标停在**分组标题行**上时看不出选中 (从前 `isCursor` 只在候选行那一支里算)。
// 上一版门只在**普通候选项**上断言过"高亮真位移", 分组标题 / Cancel / ←当前 / special / 无基址
// 这些行类一条都没覆盖 —— 于是门全绿而用户照样看着没变化。下面这套判据按**行类**逐类比两帧字节。
//
// ⚠ 判"这一帧的光标落在哪一行"**不许**看"哪一行有反白" (那正是被测对象, 拿它当判据 = 自证):
//   每帧的显示行是连续的 (头行 = 第 1 行; 滚动指示行与状态行都能按形状认出来), 于是显示行里
//   第 j 行 (0-based) 的序号 = j+1; 状态行 `第 i/N` 给出**光标行序号 i** ⇒ 序号 == i 的那一行是光标行。
//   前提: 本轮**不出现上滚指示** (`↑ 上面还有 N 家`) —— 它一出现, "第 j 行序号 = j+1" 就不成立。
//   调用方必须先断言这个前提 (本门的 `R11.12.0` 就是干这个的), 不成立就判红, 绝不量歪。
// ---------------------------------------------------------------------------

const STATUS_NUM_RE = /第\s*(\d+)\s*\/\s*(\d+)/;
const SCROLL_IND_RE = /^\s*[↑↓] (上面还有|下面还有) \d+/;
/** 分组标题行 (光标态只是前缀 `→ ` 与 `  ` 的区别) */
const SEP_ROW_RE = /^(→ | {2})── /;
/** `special` 行的语义标记 (用**文字**认行类, 不靠颜色 —— 颜色只是第二通道) */
const SPECIAL_MARK = 'special (需专用鉴权, 未支持)';
const NOBASE_MARK = '无基址 (需自定义 baseUrl)';

interface FrameRow {
  /** 第几帧 (1-based) */
  frame: number;
  /** 该行在本帧显示行里的序号 (1-based; 与状态行 `第 i/N` 同一套编号) */
  ordinal: number;
  /** 状态行说光标就在这一行 */
  cursor: boolean;
  /** **原始字节** (含 ANSI) —— 逐字节对比只用它 */
  raw: string;
  /** 去 ANSI 后的行文字 (只用来认行类) */
  text: string;
}

/** 每帧的**原始**行 (保留 ANSI; 与 `frameBlocks` 同一套切帧规则, 只是不剥色) */
function frameRawBlocks(raw: string): string[][] {
  const blocks: string[][] = [];
  for (const chunk of raw.split(FRAME_SEP_RE)) {
    const lines: string[] = [];
    for (const ln of chunk.split('\n')) {
      const at = ln.indexOf(ERASE_EOL);
      if (at < 0) continue;
      lines.push(ln.slice(0, at).replace(/\r/g, ''));
    }
    if (lines.length) blocks.push(lines);
  }
  return blocks;
}

/** 把 raw 拆成"每一行的原始字节 + 行类文字 + 是不是光标行" (光标行位置由状态行几何自推) */
function frameRowsWithCursor(raw: string): { rows: FrameRow[]; upScrolledFrames: number; frames: number } {
  const rows: FrameRow[] = [];
  let upScrolledFrames = 0;
  const blocks = frameRawBlocks(raw);
  blocks.forEach((block, fi) => {
    const rest = block.slice(1);                        // 第 1 行 = 头行 (标题 + 计数 + 键位)
    const statusRaw = rest.filter((l) => STATUS_NUM_RE.test(stripAnsi(l).trim())).pop();
    if (!statusRaw) return;                             // 没有状态行的块不算一帧
    const cursorOrdinal = Number(STATUS_NUM_RE.exec(stripAnsi(statusRaw))![1]);
    const body = rest.filter((l) => l !== statusRaw && !SCROLL_IND_RE.test(stripAnsi(l)));
    if (rest.some((l) => /^\s*↑ 上面还有/.test(stripAnsi(l)))) upScrolledFrames++;
    body.forEach((l, j) => rows.push({
      frame: fi + 1, ordinal: j + 1, cursor: j + 1 === cursorOrdinal,
      raw: l, text: stripAnsi(l).trimEnd(),
    }));
  });
  return { rows, upScrolledFrames, frames: blocks.length };
}

/** 一行类: 按**文字/形状**认 (颜色不算行类判据 —— NO_COLOR 下也要认得出) */
interface RowClass { name: string; match: (text: string) => boolean }

const ROW_CLASSES: RowClass[] = [
  { name: '分组标题行', match: (t) => SEP_ROW_RE.test(t) },
  {
    name: '普通候选项',
    match: (t) => /^(→ | {2})[●○] /.test(t) && !t.includes('← 当前')
      && !t.includes(SPECIAL_MARK) && !t.includes(NOBASE_MARK) && !/^(→ | {2})Cancel/.test(t),
  },
  { name: '←当前 行', match: (t) => /^(→ | {2})[●○] /.test(t) && t.includes('← 当前') },
  { name: 'special 行', match: (t) => t.includes(SPECIAL_MARK) },
  { name: '无基址 行', match: (t) => t.includes(NOBASE_MARK) && !t.includes(SPECIAL_MARK) },
  { name: 'Cancel 行', match: (t) => /^(→ | {2})Cancel/.test(t) },
];

interface ClassPair {
  name: string;
  /** 该行类被光标选中的那一帧 */
  sel: FrameRow | null;
  /** **同一个内容**、但光标不在它上面的那一帧 (可比: 只有光标态不同) */
  unsel: FrameRow | null;
  /** 选中帧那一行带底色 (`48;2;`) 或反白 (`7m`) */
  selHasColor: boolean;
  /** 未选中帧那一行**也**带颜色 (不许 —— 整屏花了就分不出选中) */
  unselHasColor: boolean;
  /** 两帧该行**原始字节**不同 */
  bytesDiffer: boolean;
  /** 该行类在本轮出现过几行 (选中/未选中各几行) —— 失败时用来自证"是没落过光标还是真没高亮" */
  seen: { total: number; sel: number; unsel: number };
}

/** 行真带底色/反白 (逐字节看 SGR, 不看人眼印象) */
const hasBgOrReverse = (s: string): boolean => s.includes(`${E}[48;2;`) || s.includes(`${E}[7m`);

/**
 * 逐类算"选中 vs 未选中"两帧对比。
 * `dirtyNonCursor` = 带底色却**不是**光标行的那些行 (非空 ⇒ 整屏花掉 / 分不出选中) ⇒ 必须为空。
 */
function rowClassPairs(raw: string): {
  pairs: ClassPair[]; dirtyNonCursor: FrameRow[]; upScrolledFrames: number; frames: number; totalRows: number;
} {
  const { rows, upScrolledFrames, frames } = frameRowsWithCursor(raw);
  const key = (t: string): string => t.replace(/^(→ | {2})/, '');
  const pairs: ClassPair[] = ROW_CLASSES.map((c) => {
    const hit = rows.filter((r) => c.match(r.text));
    const selRows = hit.filter((r) => r.cursor);
    const unselRows = hit.filter((r) => !r.cursor);
    // 取"内容一致, 只有光标态不同"的那一对 —— 这样字节差异只可能来自光标态本身
    const sel = selRows.find((x) => unselRows.some((u) => key(u.text) === key(x.text))) || null;
    const unsel = sel ? (unselRows.find((u) => key(u.text) === key(sel.text)) || null) : null;
    return {
      name: c.name, sel, unsel,
      selHasColor: !!sel && hasBgOrReverse(sel.raw),
      unselHasColor: !!unsel && hasBgOrReverse(unsel.raw),
      bytesDiffer: !!sel && !!unsel && sel.raw !== unsel.raw,
      seen: { total: hit.length, sel: selRows.length, unsel: unselRows.length },
    };
  });
  const dirtyNonCursor = rows.filter((r) => r.raw.includes(`${E}[48;2;`) && !r.cursor);
  return { pairs, dirtyNonCursor, upScrolledFrames, frames, totalRows: rows.length };
}

/** 一行类的"选中态是否真的存在" —— 门与变异检查共用这一把尺 (不许两处各写一份) */
const classOk = (p: ClassPair | undefined): boolean =>
  !!p && !!p.sel && !!p.unsel && p.selHasColor && !p.unselHasColor && p.bytesDiffer;

/** 行类分析的取证文字 (报告/失败细节都用它, 免得两处各拼一次) */
function classDetail(p: ClassPair): string {
  const s = p.sel, u = p.unsel;
  return `${p.name}: 选中${s ? `(帧${s.frame}行${s.ordinal})「${short(stripAnsi(s.raw).trim(), 34)}」` : '(本轮光标没落到过这类行)'}`
    + ` / 未选中${u ? `(帧${u.frame}行${u.ordinal})` : '(无)'}`
    + ` · 选中带底色或反白=${p.selHasColor} · 未选中带色=${p.unselHasColor} · 两帧字节不同=${p.bytesDiffer}`
    + ` · 本类出现过 ${p.seen.total} 行 (选中 ${p.seen.sel}/未选中 ${p.seen.unsel})`;
}

/** 正则里要转义的字符 (分组名里有 `(`/`)`, 直接拼进正则会变成分组) */
function escapeRe(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 变异 (改源码 → 聚焦检查判红 → 逐字节恢复)
// ---------------------------------------------------------------------------

interface MutStep { file: string; pairs: Array<[string, string]> }
/** 变异跑之前记下的事实用它传给 `check` (例如\"取消不变性\"要拿跑之前的配置 sha 做对照) */
interface MutCtx { configShaBefore: string }
interface Mutation {
  id: string; desc: string; steps: MutStep[];
  /** 这个变异下要怎么跑 (`plan`) 与**怎样才能判红** (`check`) —— 每条自己一套, 不共用一把钝刀 */
  plan: (stubBaseUrl: string) => PlanStep[];
  check: (r: PtyResult, ctx: MutCtx) => boolean;
}

/** `↓↑` 高亮位移用 (两帧反白行对比) */
function twoArrowPlan(): PlanStep[] {
  return [
    { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
    { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
    { name: '↓ #1', send: '\\x1b[B', timeout_s: 20 },
    { name: '等第 2 帧', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
    { name: '↓ #2', send: '\\x1b[B', timeout_s: 20 },
    { name: '等第 3 帧', expect_raw: '第\\s*3\\s*/', timeout_s: 20 },
    { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
    { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
  ];
}

/** 只到第一屏 (版面类变异用) */
function firstScreenOnlyPlan(): PlanStep[] {
  return [
    { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
    { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
    { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
    { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
  ];
}

/** 走到**模型步** (模型行的排版/来源标注类变异用) */
function modelStepPlan(): PlanStep[] {
  return [
    { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
    { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
    { name: '选供应商', send: '\\r', timeout_s: 20 },
    { name: '凭证步就绪', expect: '凭证怎么处理', timeout_s: 30 },
    { name: '凭证保持', send: '\\r', timeout_s: 20 },
    { name: '模型选择器就绪', expect: '选择模型 \\(', timeout_s: 30 },
    { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
    { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
  ];
}

/** 走到凭证步 → 选"替换" → 输入探针串 (掩码/凭证步类变异用) */
function credentialPlan(): PlanStep[] {
  return [
    { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
    { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
    { name: '选供应商', send: '\\r', timeout_s: 20 },
    { name: '凭证步就绪', expect: '凭证怎么处理', timeout_s: 30 },
    { name: '移到替换', send: '\\x1b[B', timeout_s: 20 },
    { name: '等第 2 项', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
    { name: '选替换', send: '\\r', timeout_s: 20 },
    { name: '掩码行就绪', expect: 'API key \\[', timeout_s: 25 },
    { name: '输入探针', send: `${MASK_PROBE}\\r`, timeout_s: 20 },
    { name: '模型选择器就绪', expect: '选择模型 \\(', timeout_s: 25 },
    { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
    { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
  ];
}

/**
 * 行类漫游的**期望序号** —— 与盘上真算的分组家数绑定 (不写死行号: 机器上多几家少几家都对得上)。
 *
 * 布局 (三组默认收起时):
 *   [1] 当前生效 标题 · [2..1+uc] 当前项 · [2+uc] 可用 标题 · [3+uc..2+uc+uu] 可用项 ·
 *   [3+uc+uu] 未配置凭据 标题 · [4+uc+uu] 需专用鉴权 标题 · [5+uc+uu] 无 api 基址 标题 · [6+uc+uu] Cancel
 * 由 `main()` 在 R11 里按 `tierCount(...)` 填好 (变异检查与 R11.12 共用同一份)。
 */
const ROWS_CTX = { uc: 0, uu: 0, nb: 0, sa: 0 };

/**
 * 光标**逐类漫游**一轮 (每类行各被选中一次) —— R11.12 与"拿掉行类选中态"那两条变异共用这条计划。
 *
 * 走位: 首帧(候选行) → End(Cancel) → ↑(无 api 基址 标题, 收起) → 空格展开 → ↓(无基址 成员)
 *       → ↑ 回标题 → 空格收起 → ↑(需专用鉴权 标题) → 空格展开 → ↓(special 成员)
 *       → Home(当前生效 标题) → ↓(←当前 行) → ↓(可用 标题) → ↓(普通候选项) → Esc
 * 每一步都用 `第 i/N ·` (i 与 N 都从盘上家数算出来) 等帧出现 —— 等待本身就是"光标真落在这一行上"的断言。
 */
function rowWalkPlan(): PlanStep[] {
  const { uc, uu, nb, sa } = ROWS_CTX;
  const N0 = 6 + uc + uu;                 // 三组收起时的总行数
  const N1 = N0 + nb;                     // 展开"无 api 基址"后
  const N2 = N0 + sa;                     // 再展开"需专用鉴权"后
  const nbTitle = 5 + uc + uu;            // ── 无 api 基址 标题行序号
  const spTitle = 4 + uc + uu;            // ── 需专用鉴权 标题行序号
  const firstUsable = 3 + uc;             // 可用组第一家 (普通候选项)
  const at = (i: number, n: number): string => `第\\s*${i}\\s*/\\s*${n}\\s*·`;
  return [
    { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
    { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
    { name: '首帧光标在候选行 (第 2 行)', expect_raw: at(2, N0), timeout_s: 20 },
    { name: 'End → Cancel 行', send: '\\x1b[F', timeout_s: 20 },
    { name: '↑ → 无 api 基址 标题', send: '\\x1b[A', timeout_s: 20 },
    { name: '等光标落在分组标题行上', expect_raw: at(nbTitle, N0), timeout_s: 20 },
    { name: '空格展开无 api 基址', send: ' ', timeout_s: 20 },
    { name: '等展开回执', expect: '已展开 无 api 基址', timeout_s: 20 },
    { name: '↓ → 无基址 成员', send: '\\x1b[B', timeout_s: 20 },
    { name: '等光标落在无基址行上', expect_raw: at(nbTitle + 1, N1), timeout_s: 20 },
    { name: '↑ 回标题', send: '\\x1b[A', timeout_s: 20 },
    { name: '空格收起无 api 基址', send: ' ', timeout_s: 20 },
    { name: '等收起回执', expect: '已收起 无 api 基址', timeout_s: 20 },
    { name: '↑ → 需专用鉴权 标题', send: '\\x1b[A', timeout_s: 20 },
    { name: '等光标落在 special 标题上', expect_raw: at(spTitle, N0), timeout_s: 20 },
    { name: '空格展开需专用鉴权', send: ' ', timeout_s: 20 },
    { name: '等展开回执 2', expect: '已展开 需专用鉴权', timeout_s: 20 },
    { name: '↓ → special 成员', send: '\\x1b[B', timeout_s: 20 },
    { name: '等光标落在 special 行上', expect_raw: at(spTitle + 1, N2), timeout_s: 20 },
    { name: 'Home → 第 1 行', send: '\\x1b[H', timeout_s: 20 },
    { name: '等第 1 行 (当前生效 标题)', expect_raw: at(1, N2), timeout_s: 20 },
    { name: '↓ → ←当前 行', send: '\\x1b[B', timeout_s: 20 },
    { name: '等第 2 行', expect_raw: at(2, N2), timeout_s: 20 },
    { name: '↓ → 可用 标题', send: '\\x1b[B', timeout_s: 20 },
    { name: '等第 3 行', expect_raw: at(3, N2), timeout_s: 20 },
    { name: '↓ → 普通候选项', send: '\\x1b[B', timeout_s: 20 },
    { name: '等光标落在普通候选项上', expect_raw: at(firstUsable, N2), timeout_s: 20 },
    { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
    { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
  ];
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    desc: '拿掉 ↓ 箭头处理 (箭头键变成没反应 → 高亮不动)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["case '\\x1b[B': case '\\x1bOB': return { type: 'down' };", "case '\\x1b[B': case '\\x1bOB': return null; // 变异: 方向键失灵"]] }],
    plan: () => twoArrowPlan(),
    check: (r) => { const rows = highlightRows(r.raw); return !(rows.length >= 2 && rows[0] !== rows[1]); },
  },
  {
    id: 'M2',
    desc: '拿掉高亮 (光标行不再反白 → 看不出在哪一行)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["buf.push(`${color ? `${CURSOR_SGR}${padded}${RESET}` : truncateToWidth(plain, cols)}${ERASE_EOL}\\r\\n`);", "buf.push(`${truncateToWidth(plain, cols)}${ERASE_EOL}\\r\\n`);"]] }],
    plan: () => twoArrowPlan(),
    check: (r) => highlightRows(r.raw).length < 2,
  },
  {
    id: 'M3',
    desc: '拿掉数字快选 (敲数字不再跳选 → 老用法破了)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["case 'char':", "case 'char-NADA':"]] }],
    plan: () => [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
      { name: '数字 3', send: '3', timeout_s: 20 },
      { name: '等第 3 项', expect_raw: '第\\s*3\\s*/', timeout_s: 20 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ],
    check: (r) => !cursorIndexes(r.raw).includes(3),
  },
  {
    id: 'M4',
    desc: '掩码输入改成**回显明文** (key 直接打到屏幕上)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["const mask = MASK_CHAR.repeat(Math.min(n, cap)) + (n > cap ? `+${n - cap}` : '');", "const mask = String(value);"]] }],
    plan: () => credentialPlan(),
    check: (r) => r.raw.includes(MASK_PROBE),
  },
  {
    id: 'M5',
    desc: '把"已配 key 也给四条路"改回"有 key 就静默跳过凭证步"',
    steps: [{ file: 'src/cli/model-selector.ts', pairs: [['if (summary.requiresApiKey && io.askHidden) {', 'if (false && summary.requiresApiKey && io.askHidden) {']] }],
    plan: () => credentialPlan(),
    check: (r) => !r.text.includes('凭证怎么处理'),
  },
  {
    id: 'M6',
    desc: '把教程/目录长行塞回主屏 (版面又复杂回去)',
    steps: [{ file: 'src/cli/model-selector.ts', pairs: [["verbose('  看目录: /model catalog", "push('  看目录: /model catalog"]] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => mainScreenLines(r.raw).some((l) => l.includes('看目录:')),
  },
  {
    id: 'M7',
    desc: '把"未知字段不显示"改回逐行复读 (每行都写 工具调用=未知)',
    steps: [
      { file: 'src/cli/model-selector.ts', pairs: [['label: formatModelMenuRow(e),', 'label: formatModelLine(e),']] },
      { file: 'src/llm/model-catalog.ts', pairs: [['export function formatModelMenuRow(e: ModelEntry): string {\n  const bits: string[] = [];', "export function formatModelMenuRow(e: ModelEntry): string {\n  if (e) return formatModelLine(e);\n  const bits: string[] = [];"]] },
    ],
    plan: () => modelStepPlan(),
    check: (r) => /工具调用=未知/.test(r.text),
  },
  {
    id: 'M8',
    desc: '把内部实现话术与逐步事实默认打回主屏 (verbose 开关失效)',
    steps: [{ file: 'src/cli/model-selector.ts', pairs: [['const verbose = (s: string) => { try { if (opts.verbose) push(s); }', 'const verbose = (s: string) => { try { push(s); }']] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => /目录数据:|未知原因|selectModel\(\)/.test(r.text),
  },
  {
    id: 'M9',
    desc: '把"目录里没有就硬拒"改回 (误杀真能用的模型 —— 实测 deepseek-v4-flash 就是这种)',
    steps: [{ file: 'src/llm/connection-probe.ts', pairs: [['const notInCatalog = !catalog.includes(model);', "const notInCatalog = !catalog.includes(model);\n  if (notInCatalog) return fail('model_not_found', '变异: 目录里没有就硬拒', { catalog });"]] }],
    plan: () => firstScreenOnlyPlan(),
    check: () => false,   // 由 M9 专用检查 (outOfCatalogProbe) 判, 见 runMutations
  },
  {
    id: 'M10',
    desc: '把"目录家默认全部列出"改回"只列有凭证的家" (藏家数)',
    steps: [{ file: 'src/llm/model-catalog.ts', pairs: [["const catalogMode = opts.catalog ?? 'all';", "const catalogMode = opts.catalog ?? 'configured';   // 变异: 又只列有凭证的了"]] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => Number((/共\s*(\d+)\s*家/.exec((frameBlocks(r.raw)[0] || [])[0] || '') || [])[1]) !== MUT_CTX.totalCandidates,
  },
  {
    id: 'M11',
    desc: '把"默认只展开当前生效+可用"改成全展开 (折叠失效 → 收起标题连带家数一起消失)',
    steps: [{ file: 'src/llm/model-catalog.ts', pairs: [["  return t === 'noCredential' || t === 'specialAuth' || t === 'noBaseUrl';", '  return false;   // 变异: 所有分组都默认展开']] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => !frameBlocks(r.raw).some((b) => b.some((l) => l.includes(MUT_CTX.collapsedHeader))),
  },
  {
    id: 'M12',
    desc: '把"固定高度视窗 + 默认折叠"改回"一次性把全部候选都画出来" (版面撑爆终端)',
    steps: [
      { file: 'src/cli/tui-select.ts', pairs: [['  return Math.max(3, Math.min(VIEWPORT_MAX, Math.max(0, rows - 3)));', '  return Math.max(3, Math.max(0, rows - 3) * 1000);   // 变异: 视窗不要了']] },
      { file: 'src/llm/model-catalog.ts', pairs: [["  return t === 'noCredential' || t === 'specialAuth' || t === 'noBaseUrl';", '  return false;   // 变异: 全展开']] },
    ],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => (frameSizes(r.raw).length ? Math.max(...frameSizes(r.raw)) : 0) > 30,
  },
  {
    id: 'M13',
    desc: '把光标行的 accent 底色拿掉 (只剩反白 → bolloon 主色块没了)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [['const CURSOR_SGR = `${REVERSE}${BOLD}${fg(THEME.cursor)}${bg(THEME.accent)}`;', 'const CURSOR_SGR = `${REVERSE}${BOLD}`;   // 变异: 只有反白, 没有底色']] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => !/\x1b\[48;2;/.test(r.raw),
  },
  {
    id: 'M18',
    desc: '把**分组标题行**的选中态拿掉 (光标站在标题上时那一行与未选中字节完全相同 —— leo 亲测踩的那条)',
    steps: [{
      file: 'src/cli/tui-select.ts',
      pairs: [['      const isCursor = start + i === cursor;',
        "      const isCursor = start + i === cursor && !(line && line.kind === 'sep');   // 变异: 分组标题行没有选中态"]],
    }],
    plan: () => rowWalkPlan(),
    // 红判据: 行类分析里**分组标题行**那一类不再"选中帧带底色/反白 + 两帧字节不同"
    check: (r) => !classOk(rowClassPairs(r.raw).pairs.find((p) => p.name === '分组标题行')),
  },
  {
    id: 'M19',
    desc: '把选中态改成**只有 `→ ` 标记、没有颜色** (符号还在, 但屏幕上看不出哪一行被选中)',
    steps: [{
      file: 'src/cli/tui-select.ts',
      pairs: [['const CURSOR_SGR = `${REVERSE}${BOLD}${fg(THEME.cursor)}${bg(THEME.accent)}`;',
        "const CURSOR_SGR = '';   // 变异: 选中态只剩 `→ ` 标记, 没有颜色/反白"]],
    }],
    plan: () => rowWalkPlan(),
    // 红判据: 任一类行"选中帧带底色或反白"不再成立 (光标行的颜色通道整个没了)
    check: (r) => rowClassPairs(r.raw).pairs.some((p) => !classOk(p)),
  },
  {
    id: 'M14',
    desc: '把一个调子换成调色板外的随手 hex (#ff00ff → 配色又散回各处)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["(Object.keys(TONE_TOKEN) as Tone[]).map((t) => [t, t === 'plain' ? '' : fg(THEME[TONE_TOKEN[t]])]),", "(Object.keys(TONE_TOKEN) as Tone[]).map((t) => [t, t === 'plain' ? '' : (t === 'ok' ? fg('#ff00ff') : fg(THEME[TONE_TOKEN[t]]))]),"]] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => { const palList = [...paletteRgb().values()]; return trueColorHits(r.raw).some((h) => !palList.includes(h.rgb)); },
  },
  {
    id: 'M15',
    desc: '把"收起的分组标题照写家数"改回"只给标记不给家数" (藏家数)',
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [['        plain = `  ── ${line.group} (${line.count} ${unit}) ${mark}`;', '        plain = `  ── ${line.group} ${mark}`;   // 变异: 不给家数']] }],
    plan: () => firstScreenOnlyPlan(),
    check: (r) => !frameBlocks(r.raw).some((b) => b.some((l) => new RegExp(`── .*\\(\\d+ 家\\) ${MUT_CTX.collapsedMark}`).test(l))),
  },
  {
    id: 'M16',
    desc: '拿掉搜索 (敲字母不再过滤 → 长列表里既搜不到目录家, 也回不到全量)',
    steps: [{
      file: 'src/cli/tui-select.ts',
      pairs: [['          query += ch;\n          numBuf = \'\'; note = \'\';\n          cursor = firstItemRow(linesOf());\n          scrollTop = 0;',
        "          note = '变异: 拿掉搜索 (字母不再过滤)';   // 变异"]],
    }],
    plan: () => [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 90 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 30 },
      { name: '敲筛选词', send: 'deep', timeout_s: 15 },
      // 这一步**故意等不到** (搜索被拿掉了) —— 8s 后超时, 原始输出里也就不会有 `筛选 "…"` 帧
      { name: '等筛选生效', expect_raw: '第\\s*1\\s*/\\s*\\d+\\s*·\\s*筛选', timeout_s: 8 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 15 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 20 },
    ],
    // 红判据: 选择器**真开起来了** (否则崩了也算红 = 自证), 但屏上**一次都没有**过滤生效
    check: (r) => r.text.includes('选择供应商') && !/筛选\s*"/.test(r.text),
  },
  {
    id: 'M17',
    desc: '取消也写盘 (取消不变性被拿掉 —— 提示语仍然是"已取消, 未改动任何配置", 只有配置 sha 会露馅)',
    steps: [{
      file: 'src/cli/model-selector.ts',
      pairs: [["  if (!providerId) return done({ ok: false, cancelled: true, reachedStep: 'provider', message: '已取消, 未改动任何配置' });",
        "  if (!providerId) {\n    // 变异: 取消也写盘 (话术一个字不改 —— 只有 sha 会变)\n    try { const CS = await import('../llm/config-store.js'); await CS.llmConfigStore.updateProvider('deepseek' as any, { model: 'mut-cancel-1' }); } catch { /* 变异 */ }\n    return done({ ok: false, cancelled: true, reachedStep: 'provider', message: '已取消, 未改动任何配置' });\n  }"]],
    }],
    plan: () => firstScreenOnlyPlan(),
    // 红判据: sha 变了 (真写盘了) 或干净取消的回执没了 —— 两条都说明"取消不变性"被破坏
    check: (r, ctx) => sha(CONFIG) !== ctx.configShaBefore || !r.text.includes('已取消, 未改动任何配置'),
  },
];

// ---------------------------------------------------------------------------
// "目录外的模型"探针: 端点**接受** / 端点**真拒**两种真实世界下分别怎么判
//
// ⚠ 必须开**子进程**跑: 进程内 `import()` 会被模块缓存钉死 —— 变异把盘上的
//   connection-probe.ts 改了, 同一个进程里的缓存副本还是老代码, 于是 M9 会
//   "通过了但看不出被改过" (假绿)。子进程 = 全新模块图, 量到的才是盘上的源。
// ---------------------------------------------------------------------------

interface OocResult {
  ok: boolean; failureClass: string | null; acceptedOutsideCatalog: boolean;
  catalog: number; message: string; detail: string;
}

/** 在子进程里真发一次探测请求; 结果从 stdout 的 `@@OOC@@{...}` 里取 */
async function probeInChild(baseUrl: string, model: string): Promise<OocResult> {
  const code = [
    "const CP = await import('./src/llm/connection-probe.js');",
    "const r = await CP.probe({ providerId: 'openai', baseUrl: process.argv[1], protocol: 'openai-compatible',"
      + " model: process.argv[2], apiKeyRef: 'none', timeoutMs: 4000 });",
    "process.stdout.write('@@OOC@@' + JSON.stringify({ ok: !!r.ok, failureClass: r.failureClass || null,"
      + " acceptedOutsideCatalog: !!r.modelAcceptedOutsideCatalog, catalog: (r.catalog || []).length,"
      + " message: String(r.message || '') }) + '\\n');",
  ].join('\n');
  const raw = await new Promise<string>((resolve, reject) => {
    const p = spawn(TSX, ['--input-type=module', '-e', code, baseUrl, model], {
      cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`子进程探针 exit=${c}: ${short(err, 300)}`))));
  });
  const m = raw.match(/@@OOC@@(\{.*\})/);
  if (!m) throw new Error(`子进程探针没吐出结果: ${short(raw, 300)}`);
  const j = JSON.parse(m[1]);
  return { ...j, detail: String(j.message || '') };
}

/** 端点接受目录外的名字时会不会通过 (S12 / M9 共用) */
async function outOfCatalogProbe(): Promise<OocResult> {
  return await probeInChild(OOC_BASE, 'out-of-catalog-xyz');
}

/** 负控制: 端点**真拒**这个目录外名字时, 必须是不通过 (返 ok 才算漏) */
async function ourOutOfCatalogRefuseProbe(): Promise<{ verdict: string; catalog: number }> {
  const { startModelStub } = await import('./lib/model-stub-server.js');
  const refusing = await startModelStub({ models: ['stub-ux-a'], refuseUnknownModel: true });
  try {
    const r = await probeInChild(refusing.baseUrl, 'out-of-catalog-xyz');
    return { verdict: r.ok ? 'ok' : String(r.failureClass || 'failed'), catalog: r.catalog };
  } finally { await refusing.close(); }
}

async function probeRaw(tag: string, args: string[], steps: PlanStep[]): Promise<PtyResult> {
  return await runPty(tag, args, { timeout_s: 200, settle_ms: 600, cols: 100, rows: 30, steps });
}

/**
 * 变异检查要用的"盘上真算"期望值 —— 由 `main()` 在 R11 里填好。
 * 为什么不放在 `check` 里现算: 那是**在变异之后**算的 (盘上的源已经被改了), 拿被污染的源算期望值 = 自证。
 */
const MUT_CTX: { totalCandidates: number; collapsedHeader: string; collapsedMark: string } = {
  totalCandidates: 0, collapsedHeader: '', collapsedMark: '',
};


interface DiskCounts {
  total: number; builtin: number; custom: number; catalog: number; excluded: string[];
  tiers: Record<string, number>; searchTarget: string; searchIsCatalogOnly: boolean;
}

/**
 * 候选集与分组家数 —— **在子进程里按盘上的源真算**, 而且 env 与 pty 子进程**逐条一致** (`childEnv()`)。
 *
 * ⚠ 为什么必须同一套 env: "算不算有凭证"这件事本身是 env 决定的 (目录家靠 `*_API_KEY` 从
 *   未配置变可用) —— 门进程自己的 shell 里存着某个 key 时, 在门里算出来的分组家数就会比 pty 里多两家
 *   (踩过: 门报 noCredential=197 / 屏上写 199)。宁可多开一个子进程, 也不要拿两套 env 的数字互相对。
 */
async function diskCountsInChild(): Promise<DiskCounts> {
  const code = [
    "const MC = await import('./src/llm/model-catalog.js');",
    "const PC = await import('./src/llm/provider-catalog.js');",
    "await PC.initializeProviderCatalog();",
    "const all = await MC.buildProviderSummaries({ catalog: 'all' });",
    "const views = PC.catalogProviders();",
    "const origin = (s) => s.origin || 'builtin';",
    "const bIds = new Set(all.filter((s) => origin(s) === 'builtin').map((s) => s.id));",
    "const tiers = {};",
    "for (const t of ['current','usable','noCredential','specialAuth','noBaseUrl']) tiers[t] = all.filter((s) => MC.providerTierOf(s) === t).length;",
    "const want = process.argv[1];",
    "const target = (want && views.some((v) => v.id === want) && !bIds.has(want)) ? want",
    "  : ((all.find((s) => origin(s) === 'catalog' && MC.providerTierOf(s) === 'noCredential') || {}).id || want);",
    "process.stdout.write('@@CNT@@' + JSON.stringify({ total: all.length,"
      + " builtin: all.filter((s) => origin(s) === 'builtin').length,"
      + " custom: all.filter((s) => origin(s) === 'custom').length,"
      + " catalog: views.length, excluded: views.filter((v) => bIds.has(v.id)).map((v) => v.id),"
      + " tiers, searchTarget: target,"
      + " searchIsCatalogOnly: views.some((v) => v.id === target) && !bIds.has(target) }) + '\\n');",
  ].join('\n');
  const raw = await new Promise<string>((resolve, reject) => {
    const p = spawn(TSX, ['--input-type=module', '-e', code, 'nvidia'], {
      cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`子进程家数探针 exit=${c}: ${short(err, 300)}`))));
  });
  const m = raw.match(/@@CNT@@(\{.*\})/);
  if (!m) throw new Error(`子进程家数探针没吐结果: ${short(raw, 300)}`);
  return JSON.parse(m[1]);
}

async function runMutations(): Promise<void> {
  const originals = new Map<string, string>();
  const restoreAll = (): void => {
    for (const [file, text] of originals) {
      if (fs.readFileSync(file, 'utf-8') !== text) {
        fs.writeFileSync(file, text, 'utf-8');
        console.log(`  (兜底) ${path.relative(ROOT, file)} 已恢复为原文`);
      }
    }
  };
  try {
    for (const m of MUTATIONS) {
      section(`变异 ${m.id}: ${m.desc}`);
      let mutated = true;
      for (const st of m.steps) {
        const file = path.join(ROOT, st.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf-8'));
        let text = fs.readFileSync(file, 'utf-8');
        for (const [from, to] of st.pairs) {
          if (!text.includes(from)) { mutated = false; console.log(`    ✗ 找不到变异点: ${short(from, 90)}`); break; }
          text = text.replace(from, to);
        }
        if (!mutated) break;
        fs.writeFileSync(file, text, 'utf-8');
      }
      if (!mutated) {
        ok(`${m.id} 变异点存在 (能在源码里找到要改的那一行)`, false, '找不到要改的行');
        restoreAll();
        continue;
      }
      try {
        let red = false;
        let why = '';
        if (m.id === 'M9') {
          // M9: 专用检查 —— 变异后"目录外的名字"必须被硬拒 (旧行为回来了 ⇒ 门会红)
          const oc = await outOfCatalogProbe();
          red = oc.ok === false && oc.failureClass === 'model_not_found';
          why = red ? `目录外名字被硬拒 (${oc.failureClass}) ⇒ 门会红` : `仍然通过 ⇒ 没抓住 (ok=${oc.ok})`;
        } else {
          const configShaBefore = sha(CONFIG);
          const r = await probeRaw(`mut-${m.id}`, ['model'], m.plan(OOC_BASE));
          red = m.check(r, { configShaBefore });
          why = red ? '判据被破坏 ⇒ 门会红' : `判据仍成立 ⇒ **门漏了** (exit=${r.exit} raw=${r.raw.length}B)`;
        }
        ok(`${m.id} 变异被判红`, red, `${why} · ${m.desc.slice(0, 40)}`);
      } finally {
        restoreAll();
        const stillMutated = [...originals.keys()].some((f) => fs.readFileSync(f, 'utf-8') !== originals.get(f));
        ok(`${m.id} 源码已逐字节恢复`, !stillMutated, stillMutated ? '还有文件与原文不同!' : 'ok');
      }
    }
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 变异残留自检 —— 变异是**就地改源文件**再还原, 所以一轮被 SIGKILL 打断 (超时 / 手动杀)
 * 会把"改坏的源"留在盘上; 下一轮再跑就变成"验证一份被污染的源", 而且红绿完全说不清。
 * 开工前先确认每个变异锚点的 `from` 都还在原位。
 */
function mutationResidue(): string[] {
  const missing: string[] = [];
  for (const m of MUTATIONS) {
    for (const st of m.steps) {
      const fp = path.join(ROOT, st.file);
      const txt = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
      for (const pair of st.pairs) {
        const from = pair[0];
        if (!txt.includes(from)) missing.push(`${m.id} @ ${st.file} ← ${short(from, 56)}`);
      }
    }
  }
  return missing;
}

async function main(): Promise<number> {
  const MS: any = await import('../src/llm/model-selection.js');
  const TUI: any = await import('../src/cli/tui-select.js');
  const { startModelStub } = await import('./lib/model-stub-server.js');

  console.log(`verify-model-ux — 真 pty 交互验收  (HOME=${HOME})`);
  report(`隔离 home: ${HOME}`);
  report(`洗掉的凭据类 env: ${droppedEnvNames.join(', ') || '(本机没有)'}`);
  report(`本门种进配置的凭证: ${REDACTED} (每轮随机, 只进文件与请求头)`);

  // ── R0 开工前自检: 变异锚点必须全在原位 (见 mutationResidue 注释) ──────
  {
    const residue = mutationResidue();
    const anchorCount = MUTATIONS.reduce((n, m) => n + m.steps.reduce((k, st) => k + st.pairs.length, 0), 0);
    ok('R0 开工前: 变异锚点全在原位 (源没被上一轮打断的变异污染)',
      residue.length === 0,
      residue.length ? `残留: ${residue.join(' | ')}` : `${anchorCount}/${anchorCount} 锚点命中 (${MUTATIONS.length} 条变异)`);
    if (residue.length) {
      console.log('\n✗ 源里有**变异残留** —— 先看清 git diff 并还原, 不要在这个状态下跑门。');
      return 2;
    }
  }

  // ── 假上游: 目录 /v1/models 只列两个, 但 chat 端点**接受任意模型名** ──────
  //    这正是 2026-09-27 实测到的真实世界形状 (`/models` 不是可用模型的全集)。
  const stub = await startModelStub({ models: ['stub-ux-a', 'stub-ux-b'] });
  OOC_BASE = stub.baseUrl;
  const dead = 'http://127.0.0.1:9/v1';

  // ── 起点: 把 deepseek 指到假上游 (凭证步要"已配置"才有四条路; 第 6 步要真打到假上游) ──
  const seed = await MS.selectModel({
    provider: 'deepseek', model: 'stub-ux-a', baseUrl: stub.baseUrl,
    apiKey: GATE_KEY, scope: 'global', verify: false,
  });
  ok('起点: deepseek 指到假上游且已配凭证', seed.ok, MS.formatEffectiveModel(seed.effective).replace(GATE_KEY, REDACTED));
  const baseSha = sha(CONFIG);

  try {
    // ══════════════════════════════════════════════════════════
    section('R1 非 TTY (管道) → 退回清单 + 用法, 不卡等待输入');
    // ══════════════════════════════════════════════════════════
    const pipe = await runPipe(['model']);
    ok('管道里 exit 0 且不挂起', pipe.code === 0 && pipe.elapsed < 90_000, `exit=${pipe.code} ${pipe.elapsed}ms`);
    ok('管道里给的是"清单 + 用法" (不是选择器帧)',
      pipe.out.includes('用法:') && pipe.out.includes('bolloon model pick') && !pipe.out.includes('↑↓ 移动'),
      short(pipe.out.split('\n').filter((l) => l.includes('用法:') || l.includes('↑↓'))[0] || '', 90));

    // ══════════════════════════════════════════════════════════
    section('R2 真 TTY 裸敲 `bolloon model` = 直入选择器 (第一屏就是供应商列表)');
    // ══════════════════════════════════════════════════════════
    // 一个 run 里按顺序验: ①首帧就是选择器 ②↑↓ 高亮真位移 ③数字跳选 ④筛选 ⑤非法输入原因 ⑥EOF 干净取消
    // 逐字筛选用**一个只有 1 个命中**的词: 候选集现在是全部家 (200+), 硬写 `deep` 这种常数会随目录变宽/
    //   变窄, 而这条要证的是"N 真的缩了" —— 用 1 命中同时把"筛得准"也钉住。
    const MCc: any = await import('../src/llm/model-catalog.js');
    const probeSums: any[] = await MCc.buildProviderSummaries({ catalog: 'all' });
    const hitsOf = (t: string): number => probeSums.filter((s: any) =>
      TUI.matchesQuery({ value: s.id, label: MCc.formatProviderMenuRow(s) } as any, t)).length;
    const TERM = ['deepseek', 'nvidia', 'groq', 'openai', 'cerebras', 'ollama', 'local']
      .map((t) => ({ t, n: hitsOf(t) })).find((x) => x.n === 1) || { t: 'deepseek', n: Math.max(1, hitsOf('deepseek')) };
    // 选择器里 **Cancel 行恒在末位** (收起/筛选都不隐藏), 所以筛后行数 = 命中家数 + 1
    const FILTERED = TERM.n + 1;
    const OUT_OF_RANGE = String(FILTERED + 2);
    report(`R2 逐字筛选词: 「${TERM.t}」命中 ${TERM.n} 家 (+ Cancel 行 = ${FILTERED} 行; 越界探针用 ${OUT_OF_RANGE})`);
    const mainRun = await probeRaw('ux-main', ['model'], [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: '↓ #1', send: '\\x1b[B', timeout_s: 20 },
      { name: '等第 2 帧', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
      { name: '↓ #2', send: '\\x1b[B', timeout_s: 20 },
      { name: '等第 3 帧', expect_raw: '第\\s*3\\s*/', timeout_s: 20 },
      { name: '↑ 回第 2', send: '\\x1b[A', timeout_s: 20 },
      { name: '数字 9', send: '9', timeout_s: 20 },
      { name: '等第 9 项', expect_raw: '第\\s*9\\s*/', timeout_s: 20 },
      { name: '发 ctrl-u', send: '\\x15', timeout_s: 20 },
      { name: '等清空', expect: '筛选已清空', timeout_s: 20 },
      { name: `逐字筛选 ${TERM.t}`, send: TERM.t, timeout_s: 20 },
      // 一条正则同时钉住两件事: 状态行里的 `第 i/N` 真的缩了 **且** 筛的词就是它
      { name: `等筛选生效 (N 缩到 ${FILTERED})`, expect_raw: `第\\s*1\\s*/\\s*${FILTERED}\\s*·\\s*筛选\\s*"${TERM.t}"`, timeout_s: 20 },
      { name: `超范围 ${OUT_OF_RANGE}`, send: OUT_OF_RANGE, timeout_s: 20 },
      { name: '等原因(超范围)', expect: '超出范围', timeout_s: 20 },
      { name: '再 ctrl-u', send: '\\x15', timeout_s: 20 },
      { name: '等清空 2', expect: '筛选已清空', timeout_s: 20 },
      { name: '序号 0', send: '0', timeout_s: 20 },
      { name: '等原因(从 1 开始)', expect: '序号从 1 开始', timeout_s: 20 },
      { name: 'EOF 取消', send: '<eof>', timeout_s: 25 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ]);
    ok(`真 TTY 一整轮全部 ${mainRun.steps.length} 步按预期出现 (expect 就是断言)`,
      mainRun.ok, `${mainRun.steps.filter((s) => s.matched).length}/${mainRun.steps.length} 步命中 · exit=${mainRun.exit}`);

    // ① 第一屏就是选择器 (不是先刷清单+用法)
    const rawPrefix = mainRun.raw.slice(0, mainRun.raw.indexOf('选择供应商'));
    ok('看见选择器之前**没有**先刷"用法/清单"',
      mainRun.raw.includes('选择供应商') && !/用法:/.test(stripAnsi(rawPrefix)),
      `首帧前 ${rawPrefix.length}B: ${short(stripAnsi(rawPrefix), 80)}`);
    const msLines = mainScreenLines(mainRun.raw);
    ok('主屏第 1 行就是 `步骤 1/7 供应商`',
      /^步骤\s*1\/7\s*供应商/.test(msLines[0] || ''), short(msLines[0] || '(空)', 90));
    ok('主屏里**没有**供应商清单 dump (清单只在管道那条路)',
      msLines.filter((l) => /^[●○]\s/.test(l) || l.includes(' models · ')).length === 0,
      `清单行数=${msLines.filter((l) => /^[●○]\s/.test(l)).length}`);

    // ② 高亮真位移 (两帧反白行对比 —— **不读提示文字**)
    const hi = highlightRows(mainRun.raw);
    ok('高亮行真的换了 (两帧反白行逐字不同)',
      hi.length >= 3 && hi[0] !== hi[1] && hi[1] !== hi[2],
      `帧 1:「${short(hi[0], 46)}」→ 帧 2:「${short(hi[1], 46)}」`);
    const idx = cursorIndexes(mainRun.raw);
    // 行号从 **2** 起: 第 1 行是分组标题 (`── 当前生效 (1 家) ▾`), 第 2 行才是当前生效的那一家 ——
    //   分组标题现在是**一等行** (能在上面按空格展开), 所以整段位移比从前 +1。
    //   断言的是**位移性质** (↓ +1 · ↓ +1 · ↑ −1), 不是某个硬编码的行号。
    ok('光标序号序列 2→3→4→(↑回)3 (状态行数字真的跟着动)',
      idx.slice(0, 4).join(',') === '2,3,4,3', `第 i/N 序列前 4 个 = [${idx.slice(0, 4).join(', ')}]`);
    report(`高亮两帧对比: 帧1「${short(hi[0], 40)}」 vs 帧2「${short(hi[1], 40)}」 (不同)`);
    report(`状态行光标序列: [${idx.slice(0, 4).join(', ')}]`);

    // ③ 数字跳选
    ok('数字 9 真跳到第 9 项 (状态行与高亮同时变)',
      idx.includes(9) && mainRun.text.includes('已跳到第 9 项'), `含第 9 项=${idx.includes(9)}`);
    ok('高亮行数量 ≥ 4 (每按一次键真的重画了一帧)', hi.length >= 4, `反白行数=${hi.length}`);

    // ④ 筛选: 列表真变短 + 状态行数字真变
    const counts = filteredCounts(mainRun.raw);
    const blocks = frameBlocks(mainRun.raw);
    const firstItems = itemLines(blocks[0] || []).length;
    const deepBlock = [...blocks].reverse().find((b) => b.some((l) => l.includes(`筛选 "${TERM.t}"`)));
    const deepItems = deepBlock ? itemLines(deepBlock).length : -1;
    ok('筛选后**列表真的变短了** (候选项行数逐帧对比)',
      deepItems >= 0 && deepItems < firstItems, `全量 ${firstItems} 项 → 筛 "${TERM.t}" 后 ${deepItems} 项`);
    // 比较"筛过之后的最小值"而不是最后一帧 —— 后面还会 ctrl-u 回全量, 拿末帧比是假判据
    ok('状态行 `已筛 M 家` 真的变小了', counts.length >= 2 && Math.min(...counts) < counts[0],
      `已筛序列 = [${counts.join(', ')}] · 最小 ${counts.length ? Math.min(...counts) : '-'} < 起始 ${counts[0]}`);
    ok(`状态行 \`第 i/N\` 的 N 也跟着变小 (筛后 ${FILTERED} 行 = 命中 ${TERM.n} 家 + Cancel)`,
      new RegExp(`第\\s*1\\/\\s*${FILTERED}\\s*·\\s*筛选\\s*"${TERM.t}"`).test(mainRun.text) && FILTERED < firstItems,
      `状态行: ${short((mainRun.text.match(/第\s*1\/\d+[^\n]*/) || [''])[0], 80)}`);
    report(`筛选: 候选项 ${firstItems} → ${deepItems} (词「${TERM.t}」); 已筛 ${counts.join(' → ')}`);

    // ⑤ 非法输入给原因
    ok('序号 0 报"从 1 开始"', mainRun.text.includes('序号从 1 开始'), '');
    ok('超范围报**实际范围** (不是笼统一句失败)', /超出范围 \(这里只有 1~\d+ 项\)/.test(mainRun.text),
      short((mainRun.text.match(/超出范围[^\n]*/) || [''])[0], 80));

    // ⑥ EOF 干净取消
    ok('EOF(Ctrl-D) → 干净取消, 没被当成"回车=第 1 项"',
      mainRun.text.includes('已取消, 未改动任何配置') && mainRun.exit === 0, `exit=${mainRun.exit}`);
    ok('取消后配置 sha 逐字节没变 (EOF 那条路)', sha(CONFIG) === baseSha, `${baseSha.slice(0, 16)} → ${sha(CONFIG).slice(0, 16)}`);

    // ══════════════════════════════════════════════════════════
    section('R3 滚动窗口 (矮终端 rows=12 → 光标越过窗口时窗口真的滚)');
    // ══════════════════════════════════════════════════════════
    // 默认只展开"当前生效 + 可用", 所以"越过窗口"这条要先**展开一个大分组**再走 (收起的分组只有标题行) ——
    // End → ↑ → ↑ 落在「需专用鉴权 (未支持)」标题上 → 空格展开 → 再连续 ↓。
    const scrollSteps: PlanStep[] = [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: 'End 到末行', send: '\\x1b[F', timeout_s: 20 },
      { name: '↑ 到无基址标题', send: '\\x1b[A', timeout_s: 20 },
      { name: '↑ 到需专用鉴权标题', send: '\\x1b[A', timeout_s: 20 },
      { name: '空格展开', send: ' ', timeout_s: 20 },
      { name: '等展开回执', expect: '已展开 需专用鉴权', timeout_s: 20 },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `↓ #${i + 1}`, send: '\\x1b[B', timeout_s: 15 })),
      { name: '等第 17 行', expect_raw: '第\\s*17\\s*/', timeout_s: 20 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ];
    const scrollRun = await runPty('ux-scroll', ['model'], { timeout_s: 200, cols: 100, rows: 12, steps: scrollSteps });
    const sIdx = cursorIndexes(scrollRun.raw);
    const sBlocks = frameBlocks(scrollRun.raw);
    const sFirst = itemLines(sBlocks[0] || []);
    const sLast = itemLines(sBlocks[sBlocks.length - 1] || []);
    const windowH = Math.max(3, Math.min(12 - 3, 40));
    const sFar = sIdx.length ? Math.max(...sIdx) : 0;
    ok('矮终端里一直 ↓ 能把光标带到窗口之外 (走到的行号 > 窗口 H=9)',
      scrollRun.ok && sFar > 1 + windowH,
      `第 i/N 序列 = [${sIdx.join(', ')}] · 最远 ${sFar} · 窗口 H=${windowH}`);
    ok('窗口真的滚了 (首帧里的第一项已经滚出最后一帧)',
      sFirst.length > 0 && !sLast.some((l) => l === sFirst[0]),
      `首帧首项「${short(sFirst[0], 46)}」不在最后一帧 ${sLast.length} 项里`);
    const sSizes = frameSizes(scrollRun.raw);
    ok('矮终端 (rows=12) 下单帧渲染总行数 ≤ 12 (固定高度视窗, 不是靠回滚缓冲)',
      sSizes.length > 0 && Math.max(...sSizes) <= 12,
      `帧行数最多 ${Math.max(...sSizes)} (共 ${sSizes.length} 帧)`);

    // ══════════════════════════════════════════════════════════
    section('R4 窄终端不撑破 (cols=60/40: 每一帧每一行的显示宽度 ≤ 终端列数)');
    // ══════════════════════════════════════════════════════════
    const narrowDetail: string[] = [];
    for (const cols of [60, 40]) {
      const narrowRun = await runPty(`ux-narrow-${cols}`, ['model'], {
        timeout_s: 200, cols, rows: 20,
        steps: [
          { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
          { name: '选择器就绪', expect: '选择供应商', timeout_s: 40 },
          { name: '↓ #1', send: '\\x1b[B', timeout_s: 15 },
          { name: '等第 2 帧', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
          { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
          { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
        ],
      });
      const nLines = frameBlocks(narrowRun.raw).flat();
      const over = nLines.filter((l) => TUI.displayWidth(l) > cols);
      const widest = Math.max(...nLines.map((l) => TUI.displayWidth(l)), 0);
      narrowDetail.push(`${cols} 列: 帧内容行 ${nLines.length} 行 · 最宽 ${widest} 列 · 超宽 ${over.length} 行`);
      ok(`R4 窄终端 (${cols} 列) 下没有一行撑破 —— 用**渲染器自己的尺子** (displayWidth) 量`,
        narrowRun.ok && nLines.length > 0 && over.length === 0,
        `${cols} 列: 帧内容行 ${nLines.length} 行, 最宽 ${widest} 列, 超宽 ${over.length} 行`);
      if (over.length) report(`⚠ 超宽行 (${cols} 列): ${over.slice(0, 3).map((l) => `${TUI.displayWidth(l)}列「${short(l, 40)}」`).join(' | ')}`);
    }
    report(`R4 窄终端: ${narrowDetail.join(' | ')}`);

    // ══════════════════════════════════════════════════════════
    section('R5 凭证步四条路可达 + 掩码输入 0 命中');
    // ══════════════════════════════════════════════════════════
    const credRun = await probeRaw('ux-cred', ['model'], [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: '选供应商', send: '\\r', timeout_s: 20 },
      { name: '凭证步就绪', expect: '凭证怎么处理', timeout_s: 30 },
      { name: '移到替换', send: '\\x1b[B', timeout_s: 20 },
      { name: '等第 2 项', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
      { name: '选替换', send: '\\r', timeout_s: 20 },
      { name: '掩码行就绪', expect: 'API key \\[', timeout_s: 25 },
      { name: '输入探针', send: `${MASK_PROBE}\\r`, timeout_s: 20 },
      { name: '模型选择器就绪', expect: '选择模型 \\(', timeout_s: 25 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ]);
    const credText = credRun.text;
    const credPaths: Array<[string, string]> = [
      ['保持现有', '保持现有'],
      ['替换', '替换'],
      ['清除存盘的 key', '清除存盘的 key'],
      ['改用环境变量', '改用环境变量'],
    ];
    const missing = credPaths.filter(([, needle]) => !credText.includes(needle)).map(([n]) => n);
    ok('凭证步四条路**全都在屏上可达** (保持 / 替换 / 清除 / 改用环境变量)',
      credRun.ok && missing.length === 0, missing.length ? `缺: ${missing.join(', ')}` : '四条路都渲染出来了');
    ok('凭证步真走到了 (标题是 `凭证怎么处理`)', credText.includes('凭证怎么处理'), '');

    // 掩码: 探针串在**原始输出**里 0 命中 + 屏幕上有掩码字符 + 长度对得上
    const probeHits = credRun.raw.split(MASK_PROBE).length - 1;
    ok(`掩码: 探针串在 pty **原始输出**里 0 命中 (实测 ${probeHits} 次)`,
      probeHits === 0, `探针 ${REDACTED} (${MASK_PROBE.length} 字符)`);
    ok('掩码: 屏幕上有掩码字符 `•` (不是什么都不显示)',
      credRun.raw.includes(TUI.MASK_CHAR), `掩码字符 = ${TUI.MASK_CHAR}`);
    ok('掩码: 长度真的对上了 —— 输入**真被收到**, 不是静默丢掉',
      credRun.raw.includes(`(${MASK_PROBE.length} 字符)`), `屏上出现 "(${MASK_PROBE.length} 字符)"`);
    ok('掩码: 明文没有经由"回显尾 4 位"以外的任何路径漏出去',
      !credRun.raw.includes(MASK_PROBE.slice(0, MASK_PROBE.length - 4)), '探针前段 0 命中');
    report(`掩码: 探针 ${REDACTED}(${MASK_PROBE.length} 字符) → 原始输出命中 ${probeHits} 次, 屏上 "(${MASK_PROBE.length} 字符)"`);

    // ══════════════════════════════════════════════════════════
    section('R6 取消 / 探测失效 → 配置 sha 逐字节不变 + 没有假二次确认');
    // ══════════════════════════════════════════════════════════
    ok('凭证步中途取消后配置 sha 逐字节不变', sha(CONFIG) === baseSha, `${baseSha.slice(0, 16)} → ${sha(CONFIG).slice(0, 16)}`);

    // 探测失效那条路: 把 deepseek 指到一个死端口, 走完前五步 → 第 6 步真连不上 → 停住
    await MS.selectModel({ provider: 'deepseek', model: 'stub-ux-a', baseUrl: dead, apiKey: GATE_KEY, scope: 'global', verify: false });
    const deadSha = sha(CONFIG);
    const failRun = await probeRaw('ux-fail', ['model'], [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: '选供应商', send: '\\r', timeout_s: 20 },
      { name: '凭证步就绪', expect: '凭证怎么处理', timeout_s: 30 },
      { name: '凭证保持', send: '\\r', timeout_s: 20 },
      { name: '模型选择器就绪', expect: '选择模型 \\(', timeout_s: 25 },
      { name: '选模型', send: '\\r', timeout_s: 20 },
      { name: '参数步就绪', expect: '步骤 4/7 生成参数', timeout_s: 25 },
      { name: 'reasoning 就绪', expect: '登记支持 reasoning', timeout_s: 25 },
      { name: 'reasoning 不设', send: '\\r', timeout_s: 20 },
      { name: 'temperature 就绪', expect: 'temperature \\(0~2\\)', timeout_s: 25 },
      { name: 'temperature 不设', send: '\\r', timeout_s: 20 },
      { name: '作用域就绪', expect: '这次切换的作用域', timeout_s: 25 },
      { name: '作用域全局', send: '\\r', timeout_s: 20 },
      { name: '探测真失败', expect: '连不上/不认识这个模型', timeout_s: 40 },
    ]);
    ok('第 6 步真探测失败 (真连不上死端口, 不是伪造的失败)',
      failRun.ok && /连不上\/不认识这个模型|provider_unreachable/.test(failRun.text),
      short((failRun.text.match(/✗ 切换未完成[^\n]*/) || [''])[0], 120));
    ok('探测失效后配置 sha 逐字节不变', sha(CONFIG) === deadSha, `${deadSha.slice(0, 16)} → ${sha(CONFIG).slice(0, 16)}`);
    const failMs = mainScreenLines(failRun.raw);
    ok('失效路径**没有**假二次确认 (不问"还要继续尝试切换吗")',
      !failMs.some((l) => l.includes('还要继续尝试切换吗')),
      short(failMs[failMs.length - 1] || '', 100));

    // ══════════════════════════════════════════════════════════
    section('R7 版面预算: 每步主屏 ≤ 12 行 + 黑名单串不在主屏');
    // ══════════════════════════════════════════════════════════
    // 恢复成"能打通假上游"的那一份, 好让 verbose 对照跑在同一个形状上
    await MS.selectModel({ provider: 'deepseek', model: 'stub-ux-a', baseUrl: stub.baseUrl, apiKey: GATE_KEY, scope: 'global', verify: false });

    const layoutRuns: Array<[string, PtyResult]> = [['主流程', mainRun], ['凭证步', credRun], ['失效路径', failRun]];
    let worst = 0;
    let worstName = '';
    const layoutDetail: string[] = [];
    for (const [name, r] of layoutRuns) {
      const segs = stepSegments(mainScreenLines(r.raw)).filter((s) => s.step >= 1);
      const mx = Math.max(0, ...segs.map((s) => s.lines.length));
      layoutDetail.push(`${name}: ${segs.map((s) => `步骤${s.step}=${s.lines.length}行`).join(' ')} (最多 ${mx})`);
      if (mx > worst) { worst = mx; worstName = name; }
      ok(`${name} 每步主屏渲染 ≤ ${STEP_LINE_BUDGET} 行`, mx <= STEP_LINE_BUDGET && segs.length > 0,
        `最多 ${mx} 行 (${segs.map((s) => `步骤${s.step}:${s.lines.length}`).join(' ')})`);
    }
    report(`版面 (每步主屏行数): ${layoutDetail.join(' | ')}`);

    // 黑名单: 主屏不许出现 (只在 --verbose 里出现)
    for (const [name, r] of layoutRuns) {
      const ms = mainScreenLines(r.raw);
      const hit = LAYOUT_BLACKLIST.filter((b) => ms.some((l) => l.includes(b)));
      ok(`${name} 主屏没有黑名单串 (${LAYOUT_BLACKLIST.join(' / ')})`,
        hit.length === 0, hit.length ? `命中: ${hit.join(', ')}` : '一个都没有');
    }

    // 正向对照: --verbose **必须**真的把内部细节打出来 (证明是"挪走"不是"删掉")
    const verboseRun = await probeRaw('ux-verbose', ['model', '--verbose'], [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ]);
    const vMs = mainScreenLines(verboseRun.raw);
    const vHit = ['看目录:', '目录数据:', '目录分组:']
      .filter((b) => vMs.some((l) => l.includes(b)));
    ok('正向对照: `--verbose` 时内部细节**真的打出来了** (不是把话删了)',
      verboseRun.ok && vHit.length === 3, `命中 ${vHit.join(' / ') || '(无)'}`);
    const vSegs = stepSegments(vMs).filter((s) => s.step >= 1);
    const vWorst = Math.max(0, ...vSegs.map((s) => s.lines.length));
    report(`版面 before/after: --verbose 第一步主屏 ${vSegs[0]?.lines.length ?? 0} 行 / 最多 ${vWorst} 行; ` +
      `默认 (减法后) 最多 ${worst} 行 (${worstName})`);
    ok('版面减法是真的 (默认路径比 --verbose 少打内部细节)',
      vWorst > worst || (vSegs[0]?.lines.length ?? 0) > (stepSegments(mainScreenLines(mainRun.raw))[0]?.lines.length ?? 0),
      `--verbose 最多 ${vWorst} 行 vs 默认最多 ${worst} 行`);

    // ══════════════════════════════════════════════════════════
    section('R8 真开关: 切换真落盘 + 探测真打到假上游');
    // ══════════════════════════════════════════════════════════
    await MS.selectModel({ provider: 'deepseek', model: 'stub-ux-a', baseUrl: stub.baseUrl, apiKey: GATE_KEY, scope: 'global', verify: false });
    const beforeCommit = sha(CONFIG);
    stub.reset();
    const commitRun = await probeRaw('ux-commit', ['model'], [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: '选供应商', send: '\\r', timeout_s: 20 },
      { name: '凭证步就绪', expect: '凭证怎么处理', timeout_s: 30 },
      { name: '凭证保持', send: '\\r', timeout_s: 20 },
      { name: '模型选择器就绪', expect: '选择模型 \\(', timeout_s: 25 },
      { name: '换个模型', send: '\\x1b[B', timeout_s: 20 },
      { name: '等第 2 项', expect_raw: '第\\s*2\\s*/', timeout_s: 20 },
      { name: '选模型', send: '\\r', timeout_s: 20 },
      { name: '参数步就绪', expect: '步骤 4/7 生成参数', timeout_s: 25 },
      { name: 'reasoning 就绪', expect: '登记支持 reasoning', timeout_s: 25 },
      { name: 'reasoning 不设', send: '\\r', timeout_s: 20 },
      { name: 'temperature 就绪', expect: 'temperature \\(0~2\\)', timeout_s: 25 },
      { name: 'temperature 不设', send: '\\r', timeout_s: 20 },
      { name: '作用域就绪', expect: '这次切换的作用域', timeout_s: 25 },
      { name: '作用域全局', send: '\\r', timeout_s: 20 },
      { name: '真探测通过', expect: '步骤 6/7 连通测试通过', timeout_s: 40 },
      { name: '确认行就绪', expect: '确认按上面的配置切换', timeout_s: 25 },
      { name: '确认切换', send: '\\r', timeout_s: 40 },
      { name: '切换完成', expect: '已切到', timeout_s: 40 },
    ]);
    ok('七步真走完并切换成功', commitRun.ok && commitRun.text.includes('已切到'),
      short((commitRun.text.match(/✓ 已切到[^\n]*/) || [''])[0], 110));
    const afterCommit = sha(CONFIG);
    ok('切换真落盘 (配置 sha 逐字节变了)', afterCommit !== beforeCommit, `${beforeCommit.slice(0, 16)} → ${afterCommit.slice(0, 16)}`);
    const onDisk = readJson(CONFIG);
    const chosen = (commitRun.text.match(/已选模型:\s*([^\s·]+)/) || [])[1] || '';
    ok('盘上写的 model == 选择器界面上说选的那个',
      !!chosen && onDisk?.providers?.deepseek?.model === chosen,
      `界面 "${chosen}" · 盘上 "${onDisk?.providers?.deepseek?.model}"`);
    const chatHits = stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
    ok('探测**真打到假上游** (假上游记录到了目录请求与 chat 请求)',
      stub.catalogHits() > 0 && chatHits.length > 0,
      `目录 ${stub.catalogHits()} 次 · chat ${chatHits.length} 次 · 最后一次 model=${chatHits[chatHits.length - 1]?.model}`);
    ok('打到假上游的 model 就是选的那个', chatHits.some((r) => r.model === chosen), `chosen=${chosen}`);
    report(`真开关: sha ${beforeCommit.slice(0, 16)} → ${afterCommit.slice(0, 16)}; 假上游记录 目录 ${stub.catalogHits()} 次 / chat ${chatHits.length} 次`);

    // ══════════════════════════════════════════════════════════
    section('R9 `list` 子命令只读 (配置 sha 不变)');
    // ══════════════════════════════════════════════════════════
    const listSha = sha(CONFIG);
    const listRun = await probeRaw('ux-list', ['model', 'list'], [
      { name: '列表输出', expect: 'deepseek|模型|models', timeout_s: 120 },
    ]);
    ok('`model list` 真跑出来东西且 exit 0', listRun.ok && listRun.exit === 0,
      `exit=${listRun.exit} ${short(stripAnsi(listRun.raw), 80)}`);
    ok('`model list` 是只读的 (配置 sha 逐字节不变)', sha(CONFIG) === listSha, `${listSha.slice(0, 16)} → ${sha(CONFIG).slice(0, 16)}`);

    // ══════════════════════════════════════════════════════════
    section('R10 目录外模型: 端点接受就必须放行 (修 model_not_found 误杀) + 端点真拒必须拦住');
    // ══════════════════════════════════════════════════════════
    // 实测事实 (2026-09-27, 真凭证真上游): `/models` **不是**可用模型的全集 ——
    //   deepseek-v4-flash / deepseek-chat 都回 HTTP 200 但不在上游目录里。
    //   所以"目录里没有"只能是**警告**, 真拒绝只能由"端点自己拒了"来判。
    const oc = await outOfCatalogProbe();
    ok('目录外但**端点接受** → 放行 (不再被"目录里没有"误杀)',
      oc.ok === true, `ok=${oc.ok} acceptedOutsideCatalog=${oc.acceptedOutsideCatalog} · ${short(oc.detail, 90)}`);
    ok('放行的同时**如实标出**"上游目录未列出" (不假装它在目录里)',
      oc.acceptedOutsideCatalog === true, `modelAcceptedOutsideCatalog=${oc.acceptedOutsideCatalog}`);
    const neg = await ourOutOfCatalogRefuseProbe();
    ok('负控制: 端点**真拒**这个目录外名字 → 拦住 (放宽判据不等于放过真不通的)',
      neg.verdict !== 'ok', `判成 ${neg.verdict} (目录 ${neg.catalog} 个)`);
    report(`目录外模型: 端点接受 → ok=${oc.ok} (acceptedOutsideCatalog=${oc.acceptedOutsideCatalog}); 端点真拒 → ${neg.verdict}`);

    // ══════════════════════════════════════════════════════════
    // R11 候选集 = 盘上全部家 (内置 + 自定义 + 目录) · 固定高度视窗 · 分组折叠 · 目录家可搜/可选
    // ══════════════════════════════════════════════════════════
    const MCx: any = await import('../src/llm/model-catalog.js');
    // 期望值**从盘上真算**, 而且是与 pty 同一套 env 的子进程算的 (见 diskCountsInChild 注释):
    //   子进程里显式 `catalog:'all'` —— 就算"默认值"被改回 `'configured'` (M10), 这里算出来的仍是**全部家**;
    //   拿自己的默认值当期望值 = 自证, 门就抓不住了。
    const disk = await diskCountsInChild();
    const totalCandidates = disk.total;
    const excluded = disk.excluded;
    const TIERS = ['current', 'usable', 'noCredential', 'specialAuth', 'noBaseUrl'] as const;
    const tierCount = (t: string): number => disk.tiers[t] ?? 0;
    const COLLAPSED = String(TUI.GROUP_COLLAPSED_MARK);
    const EXPANDED = String(TUI.GROUP_EXPANDED_MARK);
    const collapsedHeader = (t: string): string => `── ${MCx.PROVIDER_GROUPS[t]} (${tierCount(t)} 家) ${COLLAPSED}`;
    section(`R11 第 1 步 = 盘上全部家 (视窗 ≤ 终端高 · 分组折叠 · 目录家可搜/可选) [候选 ${totalCandidates} 家]`);
    MUT_CTX.totalCandidates = totalCandidates;
    MUT_CTX.collapsedHeader = collapsedHeader('noCredential');
    MUT_CTX.collapsedMark = COLLAPSED;
    ok('R11.0 候选集 == 内置 + 自定义 + 目录全部 (逐项点名允许的排除项)',
      totalCandidates === disk.builtin + disk.custom + disk.catalog - excluded.length && totalCandidates > 100,
      `内置 ${disk.builtin} + 自定义 ${disk.custom} + 目录 ${disk.catalog} - 同名排除 ${excluded.length} = ${totalCandidates}`
        + (excluded.length ? ` · 排除项: ${excluded.join(', ')}` : ' · 无排除项'));
    ok('R11.0b 五个分组是**划分**不是筛选 (各家数之和 == 候选总数)',
      TIERS.reduce((a, t) => a + tierCount(t), 0) === totalCandidates,
      TIERS.map((t) => `${MCx.PROVIDER_GROUPS[t]}=${tierCount(t)}`).join(' · '));

    // 搜索目标: 只存在于**目录**里的家 (落在默认收起的"未配置凭据"组里 —— 收起挡不住搜索才算数)
    const SEARCH_TARGET = disk.searchTarget;
    const searchIsCatalogOnly = disk.searchIsCatalogOnly;
    const browseRun = await runPty('ux-browse', ['model'], {
      timeout_s: 240, cols: 100, rows: 30,
      steps: [
        { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
        { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
        { name: 'End 到末行', send: '\\x1b[F', timeout_s: 20 },
        { name: '↑ 到无基址标题', send: '\\x1b[A', timeout_s: 20 },
        { name: '等无基址标题 (收起态 · 带家数)', expect_raw: `── 无 api 基址 \\(需自定义 baseUrl\\) \\(${tierCount('noBaseUrl')} 家\\) ${COLLAPSED}`, timeout_s: 20 },
        { name: '空格展开无基址', send: ' ', timeout_s: 20 },
        { name: '等展开回执', expect: '已展开 无 api 基址', timeout_s: 20 },
        { name: '↑ 到需专用鉴权标题', send: '\\x1b[A', timeout_s: 20 },
        { name: '等 special 标题 (收起态 · 带家数)', expect_raw: `── 需专用鉴权 \\(未支持\\) \\(${tierCount('specialAuth')} 家\\) ${COLLAPSED}`, timeout_s: 20 },
        { name: '空格展开 special', send: ' ', timeout_s: 20 },
        { name: '等展开回执 2', expect: '已展开 需专用鉴权', timeout_s: 20 },
        { name: `搜目录家 ${SEARCH_TARGET}`, send: SEARCH_TARGET, timeout_s: 25 },
        { name: '等筛选命中', expect: `筛选 "${SEARCH_TARGET}"`, timeout_s: 25 },
        { name: '选中它', send: '\\r', timeout_s: 25 },
        { name: '继续走到凭证步', expect: '凭证怎么处理', timeout_s: 40 },
        { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
        { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
      ],
    });
    const bBlocks = frameBlocks(browseRun.raw).filter((b) => b.length > 0);
    const bFirst = bBlocks[0] || [];
    const bText = browseRun.text;
    // ① 候选总数 == 盘上真算 (屏上两处都要对得上: 主屏标题 + 选择器头行)
    const pick = (re: RegExp, s: string): number => Number((re.exec(s) || [])[1]);
    const headCount = pick(/共\s*(\d+)\s*家/, bFirst[0] || '');
    const screenLine = mainScreenLines(browseRun.raw).find((l) => /步骤 1\/7 供应商/.test(l)) || '';
    const screenCount = pick(/共\s*(\d+)\s*家/, screenLine);
    ok(`R11.1 候选总数 == 盘上真算的全部家数 (${totalCandidates} 家)`,
      browseRun.ok && headCount === totalCandidates && screenCount === totalCandidates,
      `选择器头行 共 ${headCount} 家 · 主屏标题 共 ${screenCount} 家 · 盘上 ${totalCandidates} 家`
        + ` (内置 ${disk.builtin} + 自定义 ${disk.custom} + 目录 ${disk.catalog} - 同名 ${excluded.length})`);
    // ② 固定高度视窗: 单帧渲染总行数 ≤ 终端高度, 且远小于候选总数 (不是"全画出来再滚")
    const bSizes = frameSizes(browseRun.raw);
    const maxFrame = bSizes.length ? Math.max(...bSizes) : 0;
    ok('R11.2 单帧渲染总行数 ≤ 终端高度 (rows=30) 且远小于候选总数',
      bSizes.length > 0 && maxFrame <= 30 && maxFrame < totalCandidates / 4,
      `最大帧 ${maxFrame} 行 (≤ 30) · 候选 ${totalCandidates} 家 · 共 ${bSizes.length} 帧`);
    // ③ 收起的分组: 标题照写家数, 且与盘上真算一致
    const collapsedDetail = (['noCredential', 'specialAuth', 'noBaseUrl'] as const).map((t) => {
      const hit = bFirst.some((l) => l.includes(collapsedHeader(t)));
      return `${MCx.PROVIDER_GROUPS[t]} (${tierCount(t)} 家)${hit ? '✓' : '✗'}`;
    });
    ok('R11.3 收起的分组标题**照写家数**且与盘上真算一致 (折叠 ≠ 藏家数)',
      collapsedDetail.every((d) => d.endsWith('✓')), collapsedDetail.join(' · '));
    // ④ 展开真生效 (两帧对比: 标记 › → ▾, 该组候选行真的出现在屏幕上)
    const cPick = (b: string[]): number => candidateRows(b).length;
    const beforeFrames = bBlocks.filter((b) => b.some((l) => l.includes(collapsedHeader('noBaseUrl'))));
    const afterFrames = bBlocks.filter((b) => b.some((l) => l.includes(`── 无 api 基址 (需自定义 baseUrl) (${tierCount('noBaseUrl')} 家) ${EXPANDED}`)));
    const before = beforeFrames.length ? beforeFrames[beforeFrames.length - 1] : [];
    const after = afterFrames.length ? afterFrames[0] : [];
    ok('R11.4 `空格/→` 展开真生效 (两帧对比: 标记 › → ▾, 该组候选行真的画出来)',
      before.length > 0 && after.length > 0 && cPick(after) > cPick(before),
      `收起帧候选行 ${cPick(before)} → 展开帧 ${cPick(after)}`);
    // ⑤ 真 pty 原文里能看到 special / 无基址 标记的家
    const specialLine = bText.split('\n').find((l) => /[●○] .*special \(需专用鉴权, 未支持\)/.test(l)) || '';
    const noBaseLine = bText.split('\n').find((l) => /[●○] .*无基址 \(需自定义 baseUrl\)/.test(l)) || '';
    ok('R11.5 真 pty 原文里看到带 `special (需专用鉴权, 未支持)` 标记的家',
      specialLine.length > 0, specialLine ? `原文: ${specialLine.trim()}` : '没看到 (展开 需专用鉴权 分组后仍无)');
    ok('R11.6 真 pty 原文里看到带 `无基址 (需自定义 baseUrl)` 标记的家',
      noBaseLine.length > 0, noBaseLine ? `原文: ${noBaseLine.trim()}` : '没看到 (展开 无 api 基址 分组后仍无)');
    // ⑥ 搜索只存在于目录里的家 → 命中 + 选得中 + 能继续走流程
    const hitLine = bText.split('\n').find((l) => new RegExp(`[●○] ${SEARCH_TARGET} `).test(l)) || '';
    ok(`R11.7 搜索目录家 ${SEARCH_TARGET} 能命中 (默认收起的分组挡不住搜索)`,
      browseRun.ok && hitLine.length > 0 && searchIsCatalogOnly,
      `命中行: ${short(hitLine.trim(), 96)}`);
    ok(`R11.8 选中目录家 ${SEARCH_TARGET} 后真走到凭证步 (能继续走流程, 不是死胡同)`,
      /凭证怎么处理/.test(bText), `屏幕上出现「凭证怎么处理」= ${/凭证怎么处理/.test(bText)}`);
    // ⑦ 颜色只有一个来源: 真彩序列全部出自 theme.ts 调色板 + 光标行有底色 + 反白
    const pal = paletteRgb();
    const palList = [...pal.values()];
    const hits2 = trueColorHits(browseRun.raw);
    const used = [...new Set(hits2.map((h) => h.rgb))];
    const offPalette = used.filter((rgb) => !palList.includes(rgb));
    ok('R11.9 屏幕上真彩序列用到的 RGB **全部**来自 `theme.ts` 的调色板 (本门真读那个文件比对)',
      hits2.length > 0 && offPalette.length === 0,
      `用到 ${used.length} 色: ${used.map((r) => `rgb(${r})`).join(' ')} · 调色板 ${pal.size} 色`
        + ` · 越界 ${offPalette.length}${offPalette.length ? ` (${offPalette.join(' ')})` : ''}`);
    ok('R11.10 光标行有**背景色 + 反白** (`48;2;` + `ESC[7m`), 且有 `→ ` 前缀',
      /\x1b\[48;2;/.test(browseRun.raw) && /\x1b\[7m/.test(browseRun.raw) && /→ [●○]/.test(bText),
      `48;2 序列 ${(browseRun.raw.match(/\x1b\[48;2;/g) || []).length} 个 · 反白 ${(browseRun.raw.match(/\x1b\[7m/g) || []).length} 次`);
    // ⑧ 源码级: hex 字面量归零 (唯一颜色事实源是 theme.ts)
    const hexIn = (rel: string): number => (fs.readFileSync(path.join(ROOT, rel), 'utf-8').match(/#[0-9a-fA-F]{6}\b/g) || []).length;
    const hexA = hexIn('src/cli/tui-select.ts'), hexB = hexIn('src/cli/model-selector.ts'), hexT = hexIn('src/cli/theme.ts');
    ok('R11.11 `tui-select.ts` + `model-selector.ts` 里 hex 字面量计数 == 0 (颜色只从 theme.ts 来)',
      hexA === 0 && hexB === 0 && hexT >= 9,
      `tui-select ${hexA} · model-selector ${hexB} · theme.ts ${hexT} (≥9 = 调色板本体所在的地方)`);

    // ══════════════════════════════════════════════════════════
    // R11.12 光标落在**每一类行**上都必须有明显选中态 (leo 亲测: 停在分组标题行上时看不出选中)
    //
    // 上一版门只在**普通候选项**上断言过"高亮真位移" (两帧反白行对比: `→ ● deepseek` vs `→ ● ollama`),
    // 分组标题 / Cancel / ←当前 / special / 无基址 一条都没覆盖 —— 于是门 104/0 全绿, 而 leo 的光标
    // 正好停在**分组标题行**上, 那一行**压根没进高亮分支**, 屏上与"没选中"逐字节相同。
    // 现在按**行类**逐类比两帧原始字节: ①选中帧该行带底色 (`48;2;`) 或反白 (`7m`) ②两帧该行字节不同
    // ③未选中行**不许**带底色 (否则整屏花掉, 也分不出选中)。
    // ══════════════════════════════════════════════════════════
    section('R11.12 光标行在**每一类行**上都有明显选中态 (选中 vs 未选中 两帧原始字节对比)');
    ROWS_CTX.uc = tierCount('current');
    ROWS_CTX.uu = tierCount('usable');
    ROWS_CTX.nb = tierCount('noBaseUrl');
    ROWS_CTX.sa = tierCount('specialAuth');
    const rowsRun = await runPty('ux-rows', ['model'], {
      timeout_s: 220, cols: 100, rows: 30, steps: rowWalkPlan(),
    });
    const rca = rowClassPairs(rowsRun.raw);
    ok('R11.12.0 行类分析前提: 光标漫游整轮跑完 + 全程**没有上滚指示** (显示行序号 = 第 j 行 j+1 才成立)',
      rowsRun.ok && rca.upScrolledFrames === 0 && rca.frames >= 8,
      `帧 ${rca.frames} · 显示行 ${rca.totalRows} 行 · 上滚指示帧 ${rca.upScrolledFrames}`
        + ` · 步数命中 ${rowsRun.steps.filter((s) => s.matched).length}/${rowsRun.steps.length} · exit=${rowsRun.exit}`);
    for (const p of rca.pairs) {
      ok(`R11.12 [${p.name}] 选中帧该行**带底色或反白** (逐字节看 SGR; 不是凭肉眼印象)`,
        !!p.sel && p.selHasColor, classDetail(p));
      ok(`R11.12 [${p.name}] 选中 vs 未选中 两帧该行**原始字节不同** (行内容一致, 只差光标态)`,
        !!p.sel && !!p.unsel && p.bytesDiffer, classDetail(p));
    }
    ok('R11.12 未选中行**一律不带底色** (只有光标行有 `48;2;`; 否则整屏花掉 = 也分不出选中)',
      rca.dirtyNonCursor.length === 0,
      rca.dirtyNonCursor.length
        ? `带底色的非光标行 ${rca.dirtyNonCursor.length} 行: ${rca.dirtyNonCursor.slice(0, 2).map((r) => short(r.text, 40)).join(' | ')}`
        : '整轮一个都没有');
    const sepPair = rca.pairs.find((p) => p.name === '分组标题行');
    if (sepPair?.sel && sepPair.unsel) {
      report(`R11.12 分组标题行两帧原文 (选中 vs 未选中, 逐字节对比):`);
      report(`   选中  : ${JSON.stringify(sepPair.sel.raw.slice(0, 150))}`);
      report(`   未选中: ${JSON.stringify(sepPair.unsel.raw.slice(0, 150))}`);
    }
    report(`R11.12 逐类结果: ${rca.pairs.map((p) => `${p.name}=${classOk(p) ? '✓' : '✗'}`).join(' · ')}`);
    report(`R11 候选 ${totalCandidates} 家 = 内置 ${disk.builtin} + 自定义 ${disk.custom} + 目录 ${disk.catalog}`
      + ` - 同名 ${excluded.length}${excluded.length ? ` (${excluded.join(',')})` : ''}`
      + ` · 分组 ${TIERS.map((t) => `${t}=${tierCount(t)}`).join('/')} · 最大帧 ${maxFrame} 行 · 目录家 ${SEARCH_TARGET} 可搜/可选中`);

    // ══════════════════════════════════════════════════════════
    // R12 无色降级 (NO_COLOR=1): 一个真彩字节都不发, 但仍靠符号分得清
    // ══════════════════════════════════════════════════════════
    section('R12 NO_COLOR=1 降级: 真彩归零 · 符号仍在 (●/○/→/折叠标记+家数)');
    const ncRun = await runPty('ux-nocolor', ['model'], {
      timeout_s: 200, cols: 100, rows: 30, env: { NO_COLOR: '1' },
      steps: [
        { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
        { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
        { name: '↓ #1', send: '\\x1b[B', timeout_s: 20 },
        { name: '等第 3 行', expect_raw: '第\\s*3\\s*/', timeout_s: 20 },
        { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
        { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
      ],
    });
    const ncHits = trueColorHits(ncRun.raw);
    ok('R12.1 NO_COLOR=1 下原始输出里 0 条真彩序列',
      ncRun.ok && ncHits.length === 0, `真彩序列 ${ncHits.length} 条 (期望 0)`);
    const ncCollapsed = new RegExp(`\\(\\d+ 家\\) ${COLLAPSED}`).test(ncRun.text);
    ok('R12.2 NO_COLOR=1 下仍靠符号分得清 (●/○ 状态 · → 光标 · 折叠标记 + 家数)',
      /[●○] /.test(ncRun.text) && /→ [●○]/.test(ncRun.text) && /── /.test(ncRun.text) && ncCollapsed,
      `●/○=${/[●○] /.test(ncRun.text)} · → 光标=${/→ [●○]/.test(ncRun.text)} · 分组标题=${/── /.test(ncRun.text)} · 折叠+家数=${ncCollapsed}`);
    // R12.3 无色降级下**光标落在分组标题行上**也要分得清 —— 这条正是 leo 踩的那类行的降级通道:
    //   没有颜色就只剩 `→ ` 前缀 (符号通道), 于是"选中 vs 未选中"仍然**逐字节不同**。
    const ncTitle = rowClassPairs(ncRun.raw).pairs.find((p) => p.name === '分组标题行');
    ok('R12.3 NO_COLOR=1 下光标停在分组标题行上仍分得清 (`→ ` 前缀 + 两帧字节不同; 且确实 0 条真彩)',
      !!ncTitle?.sel && !!ncTitle?.unsel && ncTitle.sel.raw.startsWith('→ ')
        && ncTitle.bytesDiffer && !ncTitle.selHasColor && !ncTitle.unselHasColor,
      ncTitle ? `${classDetail(ncTitle)} · 选中行以「→ 」开头=${!!ncTitle.sel && ncTitle.sel.raw.startsWith('→ ')}` : '没抓到分组标题行的两帧对比');

    // ══════════════════════════════════════════════════════════
    const BURST_TERM = 'a';   // 命中 200+ 家的搜索词 (家数从真 pty 的状态行里量, 见 R13.2)
    const BURST = 20;
    section(`R13 长列表响应性 (真耗时): ${BURST_TERM} 平铺成 200+ 行后**连续 ${BURST} 次 ↓**`);
    // ══════════════════════════════════════════════════════════
    // 判据不是"按完没崩" (那样对"卡"一无所获): 每一次按键都用 `expect_raw` 等**新的**
    //   `第 i/N · 筛选 "…"` 帧出现 —— 正则里带上 `筛选 "${BURST_TERM}"` 保证只能匹配**搜索生效之后**的帧
    //   (不会占到搜索前那些旧帧的便宜, 于是不会得到 ~0ms 的假耗时)。等的毫秒数 = 这一键的重绘延迟:
    //   视窗定位 / 滚动 / 200+ 行摊行 全在这条路径上。
    // ⚠ 这个数字是**上界**: pty 驱动是 0.15s 粒度的轮询, 本身带来 ~150ms 量化, 报告里如实这么说。
    const burstSteps: PlanStep[] = [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      { name: `搜 ${BURST_TERM} (平铺长列表)`, send: BURST_TERM, timeout_s: 20 },
      { name: '等搜索生效', expect_raw: `第\\s*1\\s*/\\s*\\d+\\s*·\\s*筛选\\s*"${BURST_TERM}"`, timeout_s: 25 },
    ];
    for (let k = 2; k <= BURST + 1; k++) {
      burstSteps.push({ name: `↓ #${k - 1}`, send: '\\x1b[B', timeout_s: 15 });
      burstSteps.push({ name: `等第 ${k} 行`, expect_raw: `第\\s*${k}\\s*/\\s*\\d+\\s*·\\s*筛选\\s*"${BURST_TERM}"`, timeout_s: 15 });
    }
    burstSteps.push({ name: '发 Esc', send: '\\x1b', timeout_s: 20 });
    burstSteps.push({ name: '取消回执', expect: '已取消|未改动', timeout_s: 25 });
    const burstRun = await runPty('ux-burst', ['model'], { timeout_s: 240, cols: 100, rows: 30, steps: burstSteps });
    const lat = burstRun.steps.filter((s) => /^等第 \d+ 行$/.test(s.name)).map((s) => s.waited_ms);
    const latSorted = [...lat].sort((a, b) => a - b);
    const latP50 = latSorted.length ? latSorted[Math.floor(latSorted.length / 2)] : -1;
    const latP95 = latSorted.length ? latSorted[Math.min(latSorted.length - 1, Math.ceil(latSorted.length * 0.95) - 1)] : -1;
    const latMax = latSorted.length ? latSorted[latSorted.length - 1] : -1;
    // 列表到底多少行: 从**真 pty 输出**的状态行里读 —— 不拿门进程的 env 另算一份 (两套 env 会差几家)
    const listNs = [...burstRun.text.matchAll(new RegExp(`第\\s*\\d+\\s*/\\s*(\\d+)\\s*·\\s*筛选\\s*"${BURST_TERM}"`, 'g'))].map((m) => Number(m[1]));
    const listLen = listNs.length ? Math.max(...listNs) : 0;
    const burstIdx = cursorIndexes(burstRun.raw);
    const runStart = burstIdx.indexOf(1);
    const idxRun = runStart >= 0 ? burstIdx.slice(runStart, runStart + BURST + 1) : [];
    ok(`R13.1 连续 ${BURST} 次 ↓ 每次都真画出了新的一帧 (光标序号 1,2,…,${BURST + 1} 逐行递进)`,
      idxRun.length === BURST + 1 && idxRun.every((v, i) => v === i + 1),
      `序号序列 = [${idxRun.join(', ')}] (期望 [1..${BURST + 1}])`);
    ok(`R13.2 这确实是一份**长列表** (搜索 "${BURST_TERM}" 平铺出 ${listLen} 行 ≥ 150)`,
      listLen >= 150, `真 pty 状态行里的 N = ${listLen} 行 (候选总数 231 家)`);
    ok(`R13.3 长列表下连续按 ${BURST} 次键**不卡** (单键重绘延迟 max ≤ 2000ms, 含 pty 轮询量化)`,
      lat.length === BURST && latMax >= 0 && latMax <= 2000,
      `单键重绘延迟: p50=${latP50}ms · p95=${latP95}ms · max=${latMax}ms (共 ${lat.length}/${BURST} 次真量)`);
    report(`R13 长列表响应性: 列表 ${listLen} 行 · 连续 ${BURST} 次 ↓ 单键重绘延迟 p50=${latP50}ms / p95=${latP95}ms / max=${latMax}ms`
      + ` (含 ~150ms pty 轮询量化, 故为**上界**) · 整轮 ${burstRun.elapsed_s}s · 期间**一次都没超时**`);

    // ══════════════════════════════════════════════════════════
    section(`变异判红 (${MUTATIONS.length} 条)`);
    // ══════════════════════════════════════════════════════════
    await runMutations();

    // ══════════════════════════════════════════════════════════
    console.log(`\n${'='.repeat(64)}`);
    console.log(`verify-model-ux: ${passed} passed / ${failed} failed  (HOME=${HOME})`);
    if (reportLines.length) {
      console.log('\n—— 本门报告 (只含可从盘上/输出里复核的事实; 无凭据) ——');
      for (const l of reportLines) console.log(`  ${l}`);
    }
    if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
    return failed === 0 ? 0 : 1;
  } finally {
    await stub.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error('门自身崩了:', e); process.exit(2); });
