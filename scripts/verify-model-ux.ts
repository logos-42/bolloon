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
 * 验的九件事 (对应 leo 亲测报的口径):
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
 *   ⑨ **变异判红** (门承重): 9 条变异逐条跑, 每条都必须把自己的判据打红。
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

interface PtyPlan { timeout_s: number; settle_ms?: number; cols?: number; rows?: number; steps: PlanStep[] }

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

/** 一帧里的**候选项行** (分组标题 `  ── …` 与空行都不算) */
function itemLines(block: string[]): string[] {
  return block.filter((l) => l.startsWith('→ ') || (l.startsWith('  ') && !l.startsWith('  ── ')));
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
// 变异 (改源码 → 聚焦检查判红 → 逐字节恢复)
// ---------------------------------------------------------------------------

interface MutStep { file: string; pairs: Array<[string, string]> }
interface Mutation {
  id: string; desc: string; steps: MutStep[];
  /** 这个变异下要怎么跑 (`plan`) 与**怎样才能判红** (`check`) —— 每条自己一套, 不共用一把钝刀 */
  plan: (stubBaseUrl: string) => PlanStep[];
  check: (r: PtyResult) => boolean;
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
    steps: [{ file: 'src/cli/tui-select.ts', pairs: [["buf.push(`${color ? `${REVERSE}${BOLD}${padded}${RESET}` : truncateToWidth(plain, cols)}${ERASE_EOL}\\r\\n`);", "buf.push(`${truncateToWidth(plain, cols)}${ERASE_EOL}\\r\\n`);"]] }],
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
          const r = await probeRaw(`mut-${m.id}`, ['model'], m.plan(OOC_BASE));
          red = m.check(r);
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
    ok('R0 开工前: 变异锚点全在原位 (源没被上一轮打断的变异污染)',
      residue.length === 0,
      residue.length ? `残留: ${residue.join(' | ')}` : '10/10 锚点命中');
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
      { name: '逐字筛选 deep', send: 'deep', timeout_s: 20 },
      // 一条正则同时钉住两件事: 状态行里的 `第 i/N` 真的缩了 **且** 筛的词就是 deep
      { name: '等筛选生效 (N 变小)', expect_raw: '第\\s*1\\s*/\\s*2\\s*·\\s*筛选\\s*"deep"', timeout_s: 20 },
      { name: '超范围 5', send: '5', timeout_s: 20 },
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
    ok('光标序号序列 1→2→3→(↑回)2 (状态行数字真的跟着动)',
      idx.slice(0, 4).join(',') === '1,2,3,2', `第 i/N 序列前 4 个 = [${idx.slice(0, 4).join(', ')}]`);
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
    const deepBlock = [...blocks].reverse().find((b) => b.some((l) => l.includes('筛选 "deep"')));
    const deepItems = deepBlock ? itemLines(deepBlock).length : -1;
    ok('筛选后**列表真的变短了** (候选项行数逐帧对比)',
      deepItems >= 0 && deepItems < firstItems, `全量 ${firstItems} 项 → 筛 "deep" 后 ${deepItems} 项`);
    // 比较"筛过之后的最小值"而不是最后一帧 —— 后面还会 ctrl-u 回全量, 拿末帧比是假判据
    ok('状态行 `已筛 M 家` 真的变小了', counts.length >= 2 && Math.min(...counts) < counts[0],
      `已筛序列 = [${counts.join(', ')}] · 最小 ${counts.length ? Math.min(...counts) : '-'} < 起始 ${counts[0]}`);
    ok('状态行 `第 i/N` 的 N 也跟着变小 (筛后只剩 1 家 + Cancel)',
      /第\s*1\/2\s/.test(mainRun.text.replace(/\s+/g, ' ')) || /第 1\/2/.test(mainRun.text),
      short(mainRun.text.match(/共\s*\d+\s*家[^\n]*/) ? mainRun.text.match(/共\s*\d+\s*家[^\n]*/)![0] : '', 90));
    report(`筛选: 候选项 ${firstItems} → ${deepItems}; 已筛 ${counts.join(' → ')}`);

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
    const scrollSteps: PlanStep[] = [
      { name: '首帧', expect: '步骤 1/7 供应商', timeout_s: 120 },
      { name: '选择器就绪', expect: '选择供应商 \\(', timeout_s: 40 },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `↓ #${i + 1}`, send: '\\x1b[B', timeout_s: 15 })),
      { name: '等第 11 项', expect_raw: '第\\s*11\\s*/', timeout_s: 20 },
      { name: '发 Esc', send: '\\x1b', timeout_s: 20 },
      { name: '取消回执', expect: '已取消|未改动', timeout_s: 25 },
    ];
    const scrollRun = await runPty('ux-scroll', ['model'], { timeout_s: 200, cols: 100, rows: 12, steps: scrollSteps });
    const sIdx = cursorIndexes(scrollRun.raw);
    const sBlocks = frameBlocks(scrollRun.raw);
    const sFirst = itemLines(sBlocks[0] || []);
    const sLast = itemLines(sBlocks[sBlocks.length - 1] || []);
    const windowH = Math.max(3, Math.min(12 - 3, 40));
    ok('矮终端里一直 ↓ 能把光标带到窗口之外 (第 11 项 > 窗口 H=9)',
      scrollRun.ok && sIdx.includes(11) && 11 - 1 >= windowH,
      `第 i/N 序列 = [${sIdx.join(', ')}] · 窗口 H=${windowH}`);
    ok('窗口真的滚了 (首帧里的第一项已经滚出最后一帧)',
      sFirst.length > 0 && !sLast.some((l) => l === sFirst[0]),
      `首帧首项「${short(sFirst[0], 46)}」不在最后一帧 ${sLast.length} 项里`);

    // ══════════════════════════════════════════════════════════
    section('R4 窄终端不撑破 (cols=40: 每一帧每一行的显示宽度 ≤ 40)');
    // ══════════════════════════════════════════════════════════
    const narrowRun = await runPty('ux-narrow', ['model'], {
      timeout_s: 200, cols: 40, rows: 20,
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
    const over = nLines.filter((l) => TUI.displayWidth(l) > 40);
    ok('窄终端 (40 列) 下没有一行撑破 —— 用**渲染器自己的尺子** (displayWidth) 量',
      narrowRun.ok && nLines.length > 0 && over.length === 0,
      `帧内容行 ${nLines.length} 行, 最宽 ${Math.max(...nLines.map((l) => TUI.displayWidth(l)), 0)} 列, 超宽 ${over.length} 行`);
    if (over.length) report(`⚠ 超宽行: ${over.slice(0, 3).map((l) => `${TUI.displayWidth(l)}列「${short(l, 40)}」`).join(' | ')}`);

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
