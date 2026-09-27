/**
 * verify-model-ux.ts — `bolloon model` 交互体验验收门 (**真 pty**, 2026-09-27)
 *
 * 为什么必须真 pty: 被测行为里有一条硬分支 —— `process.stdin.isTTY`。
 *   `printf '1\n' | bolloon model` 测到的是**非终端**那条路 (清单+用法), 不是用户敲命令时走的那条。
 *   所以本门用 `scripts/lib/pty-drive.py` 开真伪终端跑, 并且"等渲染出现再喂下一步" —— 等待本身就是断言。
 *
 * 验的七件事 (对应 leo 亲测报的口径):
 *   ① 裸敲 `bolloon model` = 切换启动命令: 真终端里第一屏**就是**带序号/状态/当前项标记的供应商列表,
 *      **不许**先刷一坨供应商清单+用法; 管道/非 TTY 才退回清单+用法 (脚本可读, 不卡等待输入)。
 *   ② 选择器每一步都**先印选项再问** (供应商→凭证→模型→参数→作用域→测试→确认):
 *      title → 至少一条 `N) ...` → `共 N 项 · 回空 = 第 1 项` → 提问行。顺序要真对, 不是"文本里出现过"。
 *   ③ 非法输入要给**原因**再重问 (序号越界说范围), 不是无声重来。
 *   ④ EOF/Ctrl-D → 干净取消, **一个字节都不写** (不许把"没有输入了"读成"回车=1")。
 *   ⑤ 真开关: 切换真落盘 (配置逐字节变了) + 探测真打到**假上游** (证明不是空转)。
 *   ⑥ `pick` / `list` 两个子命令都保留 (`list` 只读, 不写配置)。
 *   ⑦ **变异判红** (门承重): 拿掉"印选项"这一步 / 拿掉"裸敲直接进选择器" —— 聚焦检查必须判红。
 *
 * 报告口径: 只贴**真渲染** (pty 原始输出里摘), 计数与结论都从盘上/输出里算, 不从内存复述。
 * 凭据: 假上游 + 隔离 home + 洗过的 env (把 `*_API_KEY/*_KEY/*_TOKEN/*_SECRET` 全删掉再 spawn);
 *      报告里**不出现任何 key 值** (被测代码自己也不回显, 只记"已解析").
 * 退出码: 0 = 全过; 1 = 有红; 2 = 脚本自身崩了。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-ux-'));
const HOME = path.join(TMP, 'home');
const BH = path.join(HOME, '.bolloon');

// 隔离先做: 本门不 import src 模块 (整条链路走子进程), 但假上游与本门自己的路径也要隔离
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_HOME = BH;
process.env.BOLLOON_SKIP_UPDATE = '1';
process.env.BOLLOON_SKIP_SETUP = '1';
process.env.BOLLOON_SKIP_KUBO = '1';

const ENTRY = path.join(ROOT, 'src', 'cli-entry.ts');
const DRIVER = path.join(ROOT, 'scripts', 'lib', 'pty-drive.py');
const CONFIG = path.join(BH, 'bolloon-config.json');

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

function readJson(p: string, fb: any): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; }
}

function short(s: unknown, n = 150): string { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }

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

interface PlanStep { name: string; expect?: string; send?: string; timeout_s?: number }
interface PtyStepResult { name: string; expect?: string; matched: boolean; waited_ms: number; sent?: string }
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

/**
 * 跑一轮真 pty。
 *
 * ⚠️ 必须**异步** spawn: 假上游跑在**本进程**里, `spawnSync` 会把父进程的事件循环堵死 ⇒
 * 子进程的探测请求没人应答, 量到的是"上游连不上"这种假红 (sibling gate 踩过同一个坑)。
 */
function runPty(tag: string, args: string[], plan: { timeout_s: number; steps: PlanStep[] }): Promise<PtyResult> {
  const planPath = path.join(TMP, `${tag}-plan.json`);
  const outPath = path.join(TMP, `${tag}-raw.txt`);
  const jsonPath = path.join(TMP, `${tag}-res.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return new Promise((resolve) => {
    const c = spawn('python3', [
      DRIVER, '--plan', planPath, '--out', outPath, '--json', jsonPath, '--cwd', ROOT, '--',
      'npx', 'tsx', ENTRY, ...args,
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
    const c = spawn('npx', ['tsx', ENTRY, ...args], { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
// 结构分析: "先印选项再问"
// ---------------------------------------------------------------------------

const ASK_PROMPT = '选择 (序号/值, 回车=1)';
const COUNT_LINE = /共 \d+ 项 · 回空 = 第 1 项/;
const NUMBERED = /^\s*\d+\) \S/;

interface AskBlock { options: number; countLine: boolean; ordered: boolean; promptLine: number; hasTitle: boolean; hasReason: boolean }

/**
 * 把渲染切成"每个提问行一块"。两类块分开判:
 *   · **步骤首问块** (块里有标题行: `步骤 N/7` / `选择供应商 (序号` / `选择模型 (` / `temperature (0~2)` /
 *     `这次切换的作用域`): 顺序必须是 title → 至少一条 `N) ...` → `共 N 项 · 回空 = 第 1 项` → 提问行。
 *     只有顺序真对才算"先印选项再问" (文本里恰好都出现过不算 —— 那是另一种东西)。
 *   · **重问块** (同一题上答错了再问一次, 块里没有标题): 不重复刷整张表, 但**必须**带一句为什么
 *     (`✗ ...`), 不许无声重来。
 */
function analyzeAskBlocks(text: string): AskBlock[] {
  const lines = text.split('\n');
  const TITLE = /步骤 \d\/7|选择供应商 \(序号|选择模型 \(|temperature \(0~2\)|这次切换的作用域/;
  const blocks: AskBlock[] = [];
  let options = 0, countLine = false, countIdx = -1, lastNumIdx = -1, hasTitle = false, hasReason = false;
  lines.forEach((l, i) => {
    if (NUMBERED.test(l)) { options++; lastNumIdx = i; }
    if (COUNT_LINE.test(l)) { countLine = true; countIdx = i; }
    if (TITLE.test(l)) hasTitle = true;
    if (/^\s*✗ /.test(l)) hasReason = true;
    if (l.includes(ASK_PROMPT)) {
      blocks.push({
        options, countLine, hasTitle, hasReason,
        ordered: countLine && options > 0 && lastNumIdx < countIdx && countIdx < i,
        promptLine: i,
      });
      options = 0; countLine = false; countIdx = -1; lastNumIdx = -1; hasTitle = false; hasReason = false;
    }
  });
  return blocks;
}

/** 每个提问块的渲染摘要 (进报告; 只摘标题行 + 前 2 条选项, 不刷屏) */
function blockDigest(text: string, b: AskBlock, prevEnd: number): string {
  const lines = text.split('\n').slice(prevEnd, b.promptLine + 1);
  const title = lines.find((l) => l.trim() && !NUMBERED.test(l) && !COUNT_LINE.test(l)) || '';
  const opts = lines.filter((l) => NUMBERED.test(l)).slice(0, 2);
  const count = lines.find((l) => COUNT_LINE.test(l)) || '';
  return [`    ▸ ${short(title, 90)}`, ...opts.map((o) => `        ${short(o, 118)}`), `        ${short(count, 40)}`].join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const BASELINE_MODEL = 'legacy-model-x';
const TARGET_MODEL = 'deepseek-v4-flash';

async function main(): Promise<number> {
  console.log(`\n=== verify-model-ux (真 pty 交互门 · ${path.relative(ROOT, ENTRY)} · TMP=${TMP}) ===`);

  // 假上游: 目录里给两个**真上游也会有的** id, 让"切换目标"能通过连通探测。
  const { startModelStub } = await import('./lib/model-stub-server.js');
  const stub = await startModelStub({ models: ['deepseek-v4-flash', 'deepseek-v4-pro'] });
  fs.mkdirSync(BH, { recursive: true });

  /** 基线配置: 当前生效 deepseek(指向假上游), model 故意设成一个**上游目录里没有**的名字 —— 
   *  这样"切换成功"是可观测的真变化, 而不是同一个名字原地打转。 */
  const baseline = {
    activeProvider: 'deepseek',
    providers: {
      deepseek: { enabled: true, apiKey: 'sk-stub-not-a-real-key', baseUrl: stub.baseUrl, model: BASELINE_MODEL, requiresApiKey: true },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const writeBaseline = (): void => { fs.writeFileSync(CONFIG, JSON.stringify(baseline, null, 2), { mode: 0o600 }); };
  writeBaseline();
  const baselineSha = sha(CONFIG);

  // ── S0 环境 ────────────────────────────────────────────────
  section('S0 环境: 隔离 home + 洗过的 env + 假上游');
  ok('隔离 home 里落盘了基线配置 (activeProvider/model 都是读文件读出来的)',
    readJson(CONFIG, {}).activeProvider === 'deepseek' && readJson(CONFIG, {}).providers?.deepseek?.model === BASELINE_MODEL,
    `activeProvider=${readJson(CONFIG, {}).activeProvider} · model=${readJson(CONFIG, {}).providers?.deepseek?.model} · 基址=假上游 ${stub.baseUrl}`);
  ok('子进程 env 里没有任何凭据类变量 (只列**名字**, 不列值)',
    Object.keys(childEnv()).every((k) => !CRED_RE.test(k)),
    droppedEnvNames.length ? `已删掉 ${droppedEnvNames.length} 个名字形如凭据的 env: ${droppedEnvNames.slice(0, 6).join(', ')}${droppedEnvNames.length > 6 ? ' …' : ''}` : '本来就没有');

  // ── S1 裸敲 `bolloon model` = 直接进选择器 ───────────────────
  section('S1 真终端裸敲 `bolloon model`: 第一屏就是带序号的供应商列表 (不是一个字节都没印)');
  const plan1: PlanStep[] = [
    { name: '第一屏', expect: '步骤 1/7 供应商', send: '99\n', timeout_s: 90 },
    { name: '序号越界后重问', expect: '超出范围', send: 'deepseek\n', timeout_s: 40 },
    { name: '模型清单', expect: '步骤 3/7 模型', send: '2\n', timeout_s: 40 },
    { name: 'reasoning 清单', expect: '步骤 4/7 生成参数', send: '\n', timeout_s: 30 },
    { name: 'temperature 清单', expect: 'temperature \\(0~2\\)', send: '\n', timeout_s: 30 },
    { name: '作用域清单', expect: '步骤 5/7 作用域', send: '\n', timeout_s: 30 },
    { name: '确认清单', expect: '步骤 7/7 确认', send: 'y\n', timeout_s: 60 },
    { name: '切换落地', expect: '✅ 当前生效', send: '<wait>', timeout_s: 60 },
  ];
  const r1 = await runPty('run1', ['model'], { timeout_s: 240, steps: plan1 });
  // 这一轮**真的切换成功** ⇒ 盘上配置当场就变了 (S7 要验的就是这个)。
  // 后面几条"只读命令不许写"的对照必须是**它们各自跑之前**那一份 (切换后), 不是最开始的基线 ——
  // 否则就会把"S7 真的写成功了"误判成"只读命令写了盘"。
  const postSwitchSha = sha(CONFIG);
  const firstScreenEnd = (() => {
    const i = r1.text.indexOf(ASK_PROMPT);
    return i < 0 ? r1.text.length : i;
  })();
  const firstScreen = r1.text.slice(0, firstScreenEnd);
  ok('第一屏就是带序号的供应商表 (≥3 条 `N) ...`)',
    (firstScreen.match(/^\s*\d+\) \S/gm) || []).length >= 3,
    `${(firstScreen.match(/^\s*\d+\) \S/gm) || []).length} 条带序号的行`);
  ok('每行带状态标记 ● / ○ (可用 vs 未配置凭据) 且当前项有 `← 当前`',
    /^\s*\d+\) ● /m.test(firstScreen) && /^\s*\d+\) ○ /m.test(firstScreen) && firstScreen.includes('← 当前'),
    `● 行=${(firstScreen.match(/^\s*\d+\) ● /gm) || []).length} · ○ 行=${(firstScreen.match(/^\s*\d+\) ○ /gm) || []).length} · 当前标记=${firstScreen.includes('← 当前')}`);
  ok('**没有**先刷一坨清单+用法 (非 TTY 路径的 `用法:` / `admit` 一行都不许出现)',
    !r1.text.includes('用法:') && !r1.text.includes('bolloon model admit'),
    `用法块=${r1.text.includes('用法:')} · 用法行=${r1.text.includes('bolloon model admit')}`);
  ok('供应商屏上带了目录口径与新鲜度 (目录驱动那套在交互面上也看得见)',
    /目录数据: \d{4}-\d{2}-\d{2}/.test(firstScreen) && /有基址 \d+ \/ 无基址 \d+/.test(firstScreen),
    short((firstScreen.split('\n').find((l) => l.includes('目录数据:')) || '').trim(), 130));
  ok('pty 是真终端 (原始输出带 `\\r\\n` 行译 —— 管道不会做这种翻译)',
    r1.raw.includes('\r\n'), `raw 里 \\r\\n 出现 ${(r1.raw.match(/\r\n/g) || []).length} 次`);
  report('【S1 第一屏真实渲染 (pty raw, 已去 ANSI)】');
  report(firstScreen.split('\n').filter((l) => l.trim()).map((l) => `    ${short(l, 128)}`).join('\n'));

  // ── S2 每一步先印选项再问 ───────────────────────────────────
  section('S2 七步都在"先印选项再问": title → N) ... → 共 N 项 → 提问行 (顺序要对)');
  const blocks = analyzeAskBlocks(r1.text);
  const stepBlocks = blocks.filter((b) => b.hasTitle);
  const reAsks = blocks.filter((b) => !b.hasTitle);
  ok('≥5 个"步骤首问"块 (供应商/模型/reasoning/temperature/作用域), 每块都先印了选项 (顺序: 选项 → 计数 → 提问)',
    stepBlocks.length >= 5 && stepBlocks.every((b) => b.ordered),
    `${stepBlocks.length} 块首问 (选项数=[${stepBlocks.map((b) => b.options).join(', ')}]) · 顺序全对=${stepBlocks.every((b) => b.ordered)}`
      + ` · 重问块 ${reAsks.length} 个(选项数=[${reAsks.map((b) => b.options).join(', ')}])`);
  ok('答错后的重问块都带了原因 (`✗ ...`), 没有无声重来',
    reAsks.length > 0 && reAsks.every((b) => b.hasReason),
    `${reAsks.length} 个重问块 · 带原因=${reAsks.filter((b) => b.hasReason).length}`);
  const confirmIdx = r1.text.indexOf('(y/n');
  const confirmOptIdx = r1.text.lastIndexOf('1) 确认', confirmIdx);
  ok('确认步同样先印选项 (`1) 确认` 出现在 `(y/n` 之前)',
    confirmIdx > 0 && confirmOptIdx > 0 && confirmOptIdx < confirmIdx,
    `选项行 idx=${confirmOptIdx} · 提问行 idx=${confirmIdx}`);
  report('【S2 每个提问块的真实渲染 (标题 + 前 2 条选项 + 计数行)】');
  let cursor = 0;
  for (const b of blocks.slice(0, 7)) {
    report(blockDigest(r1.text, b, cursor));
    cursor = b.promptLine + 1;
  }

  // ── S3 非法输入 ─────────────────────────────────────────────
  section('S3 非法输入: 说清原因 + 同一步重问 (不是无声重来)');
  ok('序号越界给了原因 (含范围)', /✗ 序号 99 超出范围 \(这里只有 1~\d+ 项\)/.test(r1.text),
    short((r1.text.split('\n').find((l) => l.includes('超出范围')) || '').trim(), 120));
  const afterBad = r1.text.indexOf('超出范围');
  ok('越界之后同一步真的重问了 (越界行之后又出现提问行, 且随后确实选了 deepseek)',
    afterBad > 0 && r1.text.indexOf(ASK_PROMPT, afterBad) > afterBad && r1.text.includes('已选供应商: deepseek'),
    `重问行 idx=${r1.text.indexOf(ASK_PROMPT, afterBad)} · 选中=${r1.text.includes('已选供应商: deepseek')}`);

  // ── S6 `pick` 保留 + EOF 干净取消 (真终端) ───────────────────
  section('S6 `bolloon model pick` 仍保留 + EOF/Ctrl-D 干净取消 (零写入)');
  const r2 = await runPty('run2', ['model'], { timeout_s: 120, steps: [
    { name: '第一屏', expect: '步骤 1/7 供应商', send: '<eof>', timeout_s: 90 },
    { name: '取消回执', expect: '已取消', timeout_s: 30 },
  ] });
  ok('EOF 前选项就已经印出来了 (用户看得见自己在哪一步)',
    (r2.text.slice(0, r2.text.indexOf(ASK_PROMPT) < 0 ? r2.text.length : r2.text.indexOf(ASK_PROMPT)).match(/^\s*\d+\) \S/gm) || []).length >= 3,
    `第一屏带序号行 ${(r2.text.match(/^\s*\d+\) \S/gm) || []).length} 条`);
  ok('EOF/Ctrl-D 被当成"取消"而不是"回车=1" (有明确回执)',
    r2.text.includes('输入已结束 (Ctrl-D / EOF)') && r2.text.includes('已取消, 未改动任何配置'),
    short((r2.text.split('\n').find((l) => l.includes('输入已结束')) || '').trim(), 120));
  ok('EOF 取消**零写入**: 配置逐字节没动 (与这轮开跑前那一份比; 也没有 ✅ 已切换)',
    sha(CONFIG) === postSwitchSha && !r2.text.includes('✅ 已切换'),
    `sha ${sha(CONFIG).slice(0, 16)} == 这轮开跑前 ${postSwitchSha.slice(0, 16)} (基线是 ${baselineSha.slice(0, 16)}) · 出现已切换=${r2.text.includes('✅ 已切换')}`);
  ok('EOF 那条路进程**自然退出** (没被强杀, 退出码 0)',
    !r2.killed && r2.exit === 0, `killed=${r2.killed} · exit=${r2.exit} · 墙钟=${r2.elapsed_s}s`);

  const r6 = await runPty('run4-pick', ['model', 'pick'], { timeout_s: 120, steps: [
    { name: 'pick 也进选择器', expect: '步骤 1/7 供应商', send: '<eof>', timeout_s: 90 },
    { name: '取消回执', expect: '已取消', timeout_s: 30 },
  ] });
  ok('`bolloon model pick` (显式写法) 仍然直接进选择器, 且同样干净取消',
    r6.text.includes('步骤 1/7 供应商') && r6.text.includes('已取消, 未改动任何配置') && sha(CONFIG) === postSwitchSha,
    `进选择器=${r6.text.includes('步骤 1/7 供应商')} · 取消=${r6.text.includes('已取消, 未改动任何配置')} · 配置 sha 未变=${sha(CONFIG) === postSwitchSha}`);

  // ── S5 非 TTY: 清单 + 用法, 不卡等待输入 ────────────────────
  section('S5 非 TTY (管道/脚本): 退回清单+用法, 不卡在等待输入');
  const pipe = await runPipe(['model']);
  ok('管道里裸敲 `bolloon model` → 清单+用法 (脚本可读)',
    pipe.out.includes('用法:') && pipe.out.includes('模型供应商') && /目录数据: \d{4}-\d{2}-\d{2}/.test(pipe.out),
    `用法块=${pipe.out.includes('用法:')} · 目录行=${/目录数据: \d{4}-\d{2}-\d{2}/.test(pipe.out)}`);
  ok('管道里**不进选择器**、不等待输入 (无提问行/无步骤头), 退出码 0',
    !pipe.out.includes(ASK_PROMPT) && !pipe.out.includes('步骤 1/7') && pipe.code === 0,
    `提问行=${pipe.out.includes(ASK_PROMPT)} · 步骤头=${pipe.out.includes('步骤 1/7')} · exit=${pipe.code} · 墙钟=${(pipe.elapsed / 1000).toFixed(1)}s`);
  const listRun = await runPipe(['model', 'list']);
  ok('`bolloon model list` 仍然只读可用 (有输出、没进选择器、没写配置)',
    listRun.code === 0 && listRun.out.trim().length > 40 && !listRun.out.includes(ASK_PROMPT) && sha(CONFIG) === postSwitchSha,
    `exit=${listRun.code} · 输出 ${listRun.out.length} 字符 · 配置 sha 未变=${sha(CONFIG) === postSwitchSha}`);

  // ── S7 真效果: 切换真落盘 + 探测真打到上游 ───────────────────
  section('S7 真效果: 切换逐字节落盘 + 探测真打到假上游 (不是空转)');
  const cfgAfter = readJson(CONFIG, {});
  ok('盘上的模型真变了 (legacy-model-x → deepseek-v4-flash), activeProvider 不变',
    cfgAfter.providers?.deepseek?.model === TARGET_MODEL && cfgAfter.activeProvider === 'deepseek' && sha(CONFIG) !== baselineSha && sha(CONFIG) === postSwitchSha,
    `model=${cfgAfter.providers?.deepseek?.model} · activeProvider=${cfgAfter.activeProvider} · sha ${baselineSha.slice(0, 16)} → ${sha(CONFIG).slice(0, 16)}`);
  const hits = stub.requests.map((x) => `${x.method} ${x.path}`);
  ok('切换过程真打到假上游 (目录端点 + 聊天端点各至少一次)',
    stub.requests.some((x) => x.method === 'GET' && x.path.includes('/models'))
      && stub.requests.some((x) => x.method === 'POST' && x.path.includes('/chat/completions')),
    `${stub.requests.length} 个请求: ${hits.slice(0, 6).join(' | ')}`);
  ok('末屏回执 = 当前生效那一份 (provider/model/作用域 都从真输出里读)',
    r1.steps.every((s) => s.matched) && r1.text.includes('✅ 已切换') && new RegExp(`✅ 当前生效: deepseek/${TARGET_MODEL}`).test(r1.text)
      && !r1.killed && r1.exit === 0,
    `每步命中=${r1.steps.filter((s) => s.matched).length}/${r1.steps.length} · exit=${r1.exit} · killed=${r1.killed} · 墙钟=${r1.elapsed_s}s`);
  report('【S7 第 6/7 步与末屏真实渲染】');
  report(r1.text.split('\n').filter((l) => /步骤 6\/7|步骤 7\/7|供应商: |模型: |基址: |作用域: |凭证: |参数: |✅ 已切换|✅ 当前生效/.test(l))
    .map((l) => `    ${short(l, 132)}`).join('\n'));

  // ── S8 变异: 门承重 ────────────────────────────────────────
  section('S8 变异: 2 条改写必须判红 (门承重 —— 拿掉"印选项"/"裸敲进选择器")');
  await runMutations();

  // ── 收尾 ───────────────────────────────────────────────────
  await stub.close();
  console.log('\n=== 报告 (真渲染摘录) ===');
  console.log(reportLines.join('\n'));
  console.log(`\nverify-model-ux: ${passed} passed / ${failed} failed`);
  if (failed) console.log(`红项: ${failures.join(' · ')}`);
  console.log(`TMP=${TMP}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 变异 (改源码 → 聚焦检查判红 → 逐字节恢复)
// ---------------------------------------------------------------------------

interface MutStep { file: string; pairs: Array<[string, string]> }
interface Mutation { id: string; desc: string; steps: MutStep[]; /** 聚焦检查: 变异下应当失败的那条 */ probe: 'first-screen-options' | 'bare-goes-to-selector' }

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    desc: '把"逐条印出选项"这一步整个拿掉 (问之前什么都不印 → 只剩一句光秃秃的 `选择 (序号/值, 回车=1)`)',
    steps: [{
      file: 'src/cli/model-selector.ts',
      pairs: [[
        '      push(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? ` — ${c.hint}` : \'\'}`);',
        '      // 变异: 不印选项了',
      ]],
    }],
    probe: 'first-screen-options',
  },
  {
    id: 'M2',
    desc: '把"裸敲 = 直接进选择器"那条真终端分支拿掉 (退回先刷清单+用法)',
    steps: [{
      file: 'src/cli-entry.ts',
      pairs: [[
        '  if (modelArgs.length === 0 && tty) {',
        '  if (false && modelArgs.length === 0 && tty) {',
      ]],
    }],
    probe: 'bare-goes-to-selector',
  },
];

/** 变异下重跑第一屏 (只等第一屏, 不再往下走 —— 变异只需要看第一屏对不对) */
async function firstScreenOf(args: string[]): Promise<{ text: string; steps: PtyStepResult[] }> {
  const r = await runPty(`mut-${Math.random().toString(36).slice(2, 8)}`, args, {
    timeout_s: 90,
    steps: [{ name: '第一屏', expect: '选择 \\(序号/值, 回车=1\\)|用法:', timeout_s: 45 }],
  });
  // 只在"第一屏"范围内判定: 截到第一个提问行
  const i = r.text.indexOf(ASK_PROMPT);
  return { text: i < 0 ? r.text : r.text.slice(0, i), steps: r.steps };
}

function mutatedProbeFails(m: Mutation, screen: { text: string }): boolean {
  if (m.probe === 'first-screen-options') {
    const b = analyzeAskBlocks(screen.text + '\n' + ASK_PROMPT); // 把提问行补上, 只看这一块
    return !(b.length > 0 && b[0].ordered);
  }
  return !screen.text.includes('步骤 1/7 供应商');
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
      let bad = false;
      const touched: string[] = [];
      for (const step of m.steps) {
        const target = path.join(ROOT, step.file);
        const original = originals.get(target) ?? fs.readFileSync(target, 'utf-8');
        originals.set(target, original);
        let src = original;
        const before = sha(target);
        for (const [oldText, newText] of step.pairs) {
          const count = src.split(oldText).length - 1;
          if (count !== 1) {
            console.log(`  ❌ ${m.id} 锚点${count === 0 ? '没找到' : `不唯一(${count})`} — 在 ${step.file}, 变异没落盘: ${short(m.desc, 70)}`);
            ok(`${m.id} 变异落盘 (锚点唯一命中)`, false, `锚点命中 ${count} 次`);
            bad = true;
            break;
          }
          src = src.replace(oldText, newText);
        }
        if (bad) break;
        fs.writeFileSync(target, src, 'utf-8');
        if (sha(target) === before) {
          console.log(`  ❌ ${m.id} 盘上 hash 没变 (${step.file})`);
          bad = true;
          break;
        }
        touched.push(target);
      }
      if (bad) { restoreAll(); continue; }

      const screen = await firstScreenOf(['model']);
      const redNow = mutatedProbeFails(m, screen);
      if (redNow) {
        ok(`${m.id} 判红 — ${short(m.desc, 80)}`, true,
          `聚焦检查(${m.probe})在变异下不成立: 第一屏里带序号行 ${(screen.text.match(/^\s*\d+\) \S/gm) || []).length} 条 · 含步骤头=${screen.text.includes('步骤 1/7')}`);
      } else {
        ok(`${m.id} 判红 — ${short(m.desc, 80)}`, false, '门没承重: 变异后聚焦检查**仍然通过** (不许当通过)');
      }
      restoreAll();
      for (const f of touched) {
        if (fs.readFileSync(f, 'utf-8') !== originals.get(f)) {
          console.log(`  ❌ ${m.id} 恢复失败 —— ${path.relative(ROOT, f)} 被留在变异状态!`);
          ok(`${m.id} 恢复 (逐字节回到原文)`, false, `${path.relative(ROOT, f)} 未恢复`);
          return;
        }
      }
      ok(`${m.id} 恢复 (逐字节回到原文, sha 一致)`,
        touched.every((f) => sha(f) === crypto.createHash('sha256').update(originals.get(f)!).digest('hex')),
        touched.map((f) => path.relative(ROOT, f)).join(', '));
    }
  } finally {
    restoreAll();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error('验收脚本自身崩了:', e); process.exit(2); });
