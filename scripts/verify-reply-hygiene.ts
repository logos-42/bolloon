#!/usr/bin/env node
/**
 * verify-reply-hygiene.ts — 「内部运行日志不进对话回复流」的验收门 (2026-09-27)
 *
 * leo 报的原话: 会话里的**回复流**混进了给开发者看的运行日志 ——
 *   `🔄 开始 ReAct 循环...`(他说的"开始 React 循环") · `🧷 运行已登记 (...)` ·
 *   `✅ 处理完成，共 N 次循环` · `🔄 目标对齐 review N/2: 深挖续跑` …
 *
 * 这道门要证明的是**五件互相独立的事**, 缺一件都算没做到:
 *   A 发送点声明完备 (源码级): pi-sdk 里那 20 类内部运行日志的 status 事件全部带 `internal: true`;
 *     同时**阴性对照** —— 用户真需要看到的状态 (Reflection / 真失败 / 收尾被拒 / 运行被外部停) 不许被标,
 *     否则"0 命中"是靠"一把全吞"换来的。
 *   B 默认模式真跑 (真 CLI 源码 + 真 LLM + 真 pty): 黑名单**每串 0 命中**,
 *     且同一次抓包里**必须有**用户可见内容 (答案框 + 工具行 + 用户消息回显) —— 否则 0 命中是空文档假绿。
 *   C 搬走不是删掉: 同一批行落进 `${BOLLOON_HOME}/logs/startup.log`, 按 `[运行] ` 通道可逐串 grep 到。
 *   D 诊断可召回: `BOLLOON_VERBOSE=1` 时这些行**原样回到屏上** (且照样落盘)。
 *   E 前后对比 (真数字): 修复前的真抓包 fixture 里数得出 >0 行 → 修复后 0 行; 回复流唯一行数一起给。
 *   F 变异判红 (3 条): ① 判据恒 false (内部日志又透回回复流) → B 必红
 *                     ② 日志行生成拿掉 (只静默不落盘) → C 必红
 *                     ③ 把发送点的 `internal: true` 拿掉 (回到"按内容猜") → B 必红
 *
 * 归属与纪律:
 *   · 修法是**在发送点拦**: 事件带 `internal: true` (emit 侧声明), CLI 的回复流组装口只认这个声明,
 *     不新增第二条回复组装路径, 也不在渲染层拿子串当主方案;
 *   · 真 LLM 凭证: 从本机 `~/.bolloon` 复制进隔离 HOME, **不打印 / 不进报告**, 且断言抓包里没有 key 原文;
 *   · 隔离 HOME 用完即删 (里面有凭证副本);
 *   · pty 驱动用 `scripts/lib/pty-drive.py` (等渲染出现再喂输入, 不用固定 sleep)。
 *
 * 用法:
 *   npx tsx scripts/verify-reply-hygiene.ts                  # 全跑 (含真会话; 机器空载约 4-6 分钟)
 *   npx tsx scripts/verify-reply-hygiene.ts --only-source    # 只跑 A (无 LLM, 秒级; 变异对照用)
 *   npx tsx scripts/verify-reply-hygiene.ts --skip-mutations # 跳过 F
 *   npx tsx scripts/verify-reply-hygiene.ts --keep-home      # 保留隔离 HOME (默认删, 内含凭证副本)
 *
 * 退出码: 0 = 全绿 (含显式 skipped); 1 = 有断言红; 2 = 脚本自身前置条件不满足。
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = process.cwd();
const ARGV = process.argv.slice(2);
const ONLY_SOURCE = ARGV.includes('--only-source');
const SKIP_MUTATIONS = ARGV.includes('--skip-mutations');
const KEEP_HOME = ARGV.includes('--keep-home');

const PTY_DRIVE = path.join(ROOT, 'scripts', 'lib', 'pty-drive.py');
const PI_SDK = path.join(ROOT, 'src', 'agents', 'pi-sdk.ts');
const HYGIENE_SRC = path.join(ROOT, 'src', 'cli', 'reply-hygiene.ts');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'reply-hygiene', 'before-reply-stream.txt');

// ---------------------------------------------------------------------------
// 判据 (在这一层**独立重写**一遍, 不 import 被测模块自证)
// ---------------------------------------------------------------------------

/** 黑名单串: leo 点名的两条 (含他写的 "React" 拼法) + 诊断里真跑捕获到的同族内部行 */
const BLACKLIST: readonly string[] = [
  '开始 ReAct 循环',        // leo: "开始 React 循环"
  '开始 React 循环',        // 他原话里的字面拼法 (代码里没有, 也必须 0 命中)
  '目标对齐',               // leo 点名
  '运行已登记',
  '处理完成，共',
  '目标仍在进行',
  '工具结果汇报超限',
  '执行完成，继续循环',
  '评估是否需要压缩上下文',
  '上下文压缩:',
  '提取最终回答',
  'reactive compaction 预检',
  '恢复保护',
  '自动重试 loop',
  'loop 自动压缩',
  '参数: {',
];

/** A 段: 发送点应当声明为内部的 20 条 (内容片段, 与 pi-sdk 源码逐字对齐) */
const MUST_BE_INTERNAL: readonly string[] = [
  '↻ 自动重试 loop ${attempt}',
  '🔄 开始 ReAct 循环...',
  '♻️ 从 checkpoint 恢复运行',
  '🧷 运行已登记',
  '🗜️ loop 自动压缩',
  '🔄 循环 ${iteration}/${this.MAX_REACT_ITERATIONS}',
  '📋 参数: ${JSON.stringify(toolCall.args)}',
  '🛡️ 恢复保护',
  '✅ ${toolCall.name} 执行成功',
  '🔄 工具执行完成，继续循环...',
  '🔄 还有 ${unreported} 个工具结果汇报未汇报',
  '🔄 工具结果汇报超限, 强制收尾',
  '🔄 目标对齐 review ${loopReviewCount}',
  '🔄 继续处理，循环 ${iteration}...',
  '📝 提取最终回答，长度 ${reply.length}',
  '✅ 处理完成，共 ${iteration - 1} 次循环',
  '🎯 目标已达成',
  '⚠️ reactive compaction 预检触发',
  '🗜️ 评估是否需要压缩上下文...',
  '🗜️ 上下文压缩: ${stagesApplied',
].map((s) => (s.includes('工具结果汇报未汇报') ? '🔄 还有 ${unreported} 个工具结果未汇报' : s));

/** A 段阴性对照: 用户真需要看到的状态 —— 不许被标成内部 (标了就误吞) */
const MUST_NOT_BE_INTERNAL: readonly string[] = [
  '⛔ loop 自动重试 ${MAX_LOOP_RETRIES} 次后仍失败',
  '⚠️ AI 调用失败 ${totalErrors}/${this.MAX_TOTAL_ERRORS}',
  '💡 Reflection:',
  '⚠️ 收尾被拒 (不当作收过)',
  '⏹️ 运行状态保持为',
  '⚠️ LLM 调用失败 (${lastClass})',
];

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function sanitize(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 面板 / 状态栏 / spinner / 输入行 —— 都不是"回复流", 数行数时排除 */
function isChromeLine(t: string): boolean {
  if (!t) return true;
  if (/^[─═╌╭╮╰╯│╔╗╚╝║┃\s·]+$/.test(t)) return true;
  if (/^(❯|deepseek · )/.test(t)) return true;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return true;
  if (t.includes('│') && /(skills|· 21 类|Bolloon Agent v|Session:|模型 |📁|⎇|🧹|⚡|🧠|就绪:)/.test(t)) return true;
  return false;
}

/** 抓包里"回复流"的可见行 (去重: pty 重绘会把同一行印多遍) */
function replyStreamLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (isChromeLine(t)) continue;
    const key = t.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** 回复流里命中的黑名单行 (逐串给数字用) */
function blacklistHits(text: string): Record<string, number> {
  const lines = replyStreamLines(text);
  const hits: Record<string, number> = {};
  for (const pat of BLACKLIST) hits[pat] = lines.filter((l) => l.includes(pat)).length;
  return hits;
}

function totalHits(h: Record<string, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}

/** 日志文件里命中数: 只看 `[运行] ` 这条通道 (被搬走的那一批就该在这里) */
function logHits(logText: string): Record<string, number> {
  const runLines = logText.split('\n').filter((l) => l.includes('[运行] '));
  const hits: Record<string, number> = {};
  for (const pat of BLACKLIST) hits[pat] = runLines.filter((l) => l.includes(pat)).length;
  return hits;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, detail = ''): void {
  passed++;
  console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
}
function bad(name: string, detail: string): void {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name}  — ${detail}`);
}
function skip(name: string, why: string): void {
  console.log(`  ⏭ skipped: ${name}  — ${why}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 真 pty 会话
// ---------------------------------------------------------------------------
interface RunResult {
  raw: string;
  text: string;
  exitCode: number | null;
  elapsedMs: number;
  logText: string;
  home: string;
}

const PROVIDER_ENV: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  kimi: 'KIMI_API_KEY',
  glm: 'GLM_API_KEY',
  qwen: 'QWEN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

function realHome(): string {
  return process.env.BOLLOON_HOME?.trim() || path.join(os.homedir(), '.bolloon');
}

/** 隔离 HOME: 复制 provider 配置 / 身份 / 就绪状态 (凭证只在 0600 文件与子进程环境里流转) */
function makeIsolatedHome(tag: string): { home: string; env: Record<string, string>; keyRaw: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bolloon-reply-hygiene-${tag}-`));
  const bh = path.join(root, '.bolloon');
  fs.mkdirSync(path.join(bh, 'sessions'), { recursive: true });
  const src = realHome();
  for (const f of ['bolloon-config.json', 'llm-config.json', 'config.json', 'setup-state.json', 'agent-registry.json']) {
    const p = path.join(src, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bh, f));
  }
  for (const d of ['identity', 'agents', 'skills', 'persona']) {
    const p = path.join(src, d);
    if (fs.existsSync(p)) fs.cpSync(p, path.join(bh, d), { recursive: true });
  }
  // 干净会话: 只放一个测试频道 (不复制本机会话, 免得和别的线串味)
  fs.writeFileSync(path.join(bh, 'sessions', 'channels.json'), JSON.stringify([
    { id: 'ch-hygiene', name: '回复流卫生', agentId: 'agent-hygiene', persona: { name: 'HygieneAgent', description: '回复流净化验收' } },
  ]));

  // 真凭证 → 子进程环境 (不打印): CLI 的供应商选择按 env 里"有哪些 key"判, 所以必须注入
  const cfgPath = path.join(bh, 'bolloon-config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const provider = String(cfg.activeProvider || '');
  const entry = (cfg.providers || {})[provider] || {};
  const keyRaw = String(entry.apiKey || entry.key || '');
  const envVar = PROVIDER_ENV[provider];
  const env: Record<string, string> = {
    HOME: root,
    BOLLOON_HOME: bh,
    BOLLOON_CRON: '0',
    BOLLOON_SKIP_UPDATE: '1',
  };
  if (envVar && keyRaw) env[envVar] = keyRaw;
  return { home: root, env, keyRaw };
}

function writePlan(file: string, env: Record<string, string>): void {
  const plan = {
    timeout_s: 300,
    settle_ms: 1500,
    cols: 110,
    rows: 40,
    env,
    steps: [
      { name: 'ready', expect: 'Esc 双击退出', send: '看一下当前目录有哪些文件, 一行回我即可\n', timeout_s: 150 },
      { name: 'reply', expect: '◉ Bolloon Agent', send: '<wait>', timeout_s: 180 },
      { name: 'quit', expect: '◉ Bolloon Agent', send: '<eof>', timeout_s: 30 },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-reply-hygiene-tmp-'));

/** 真跑一次会话: 真 CLI 主路径 (src/index.ts, 与 `bolloon --cli` 同一条) + 真 pty + 真 LLM */
function runSession(tag: string, opts: { verbose?: boolean; home?: string; env?: Record<string, string> } = {}): RunResult {
  let home = opts.home;
  let env = opts.env;
  if (!home || !env) {
    const made = makeIsolatedHome(tag);
    home = made.home;
    env = made.env;
  }
  if (opts.verbose) env = { ...env, BOLLOON_VERBOSE: '1' };
  const planPath = path.join(TMP, `plan-${tag}.json`);
  const rawPath = path.join(TMP, `raw-${tag}.txt`);
  const jsonPath = path.join(TMP, `result-${tag}.json`);
  writePlan(planPath, env!);
  const t0 = Date.now();
  const r = spawnSync('python3', [
    PTY_DRIVE, '--plan', planPath, '--out', rawPath, '--json', jsonPath,
    '--cwd', ROOT, '--', 'npx', 'tsx', 'src/index.ts',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 360_000 });
  const elapsedMs = Date.now() - t0;
  const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : '';
  const result = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
  const logPath = path.join(home!, '.bolloon', 'logs', 'startup.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { raw, text: sanitize(raw), exitCode: result.exit ?? null, elapsedMs, logText, home: home! };
}

/** 一次会话"真的跑了"的证据 (阴性对照: 0 命中不能是空文档) */
function sessionReallyRan(r: RunResult): { ok: boolean; why: string } {
  const hasSend = r.text.includes('✓ 已发送');
  const hasAnswer = r.text.includes('◉ Bolloon Agent');
  const hasToolRow = /🔧/.test(r.text);
  // 工具行可能被 Ink 只当 transient 画一下没留在消息流里 —— 那就用**日志里的 [运行] 行**当同一件事的证据:
  // 那批行只有 agent 循环真跑起来才会产生 (它们正是被搬过去的东西), 所以这条路比看屏幕更硬。
  const runLogLines = r.logText.split('\n').filter((l) => l.includes('[运行] ')).length;
  const ranLoop = hasToolRow || runLogLines >= 3;
  return {
    ok: hasSend && hasAnswer && ranLoop,
    why: `用户回显=${hasSend} 答案框=${hasAnswer} 工具行=${hasToolRow} 日志[运行]行=${runLogLines}`,
  };
}

// ---------------------------------------------------------------------------
// A 段 — 发送点声明 (源码级)
// ---------------------------------------------------------------------------
function nearestStatusLine(lines: string[], idx: number): number | null {
  const cands: number[] = [];
  for (let i = Math.max(0, idx - 6); i <= Math.min(lines.length - 1, idx + 6); i++) {
    if (lines[i].includes("type: 'status'")) cands.push(i);
  }
  if (cands.length === 0) return null;
  return cands.sort((a, b) => Math.abs(a - idx) - Math.abs(b - idx))[0];
}

function partA(): void {
  section('A 发送点声明完备 (源码级: pi-sdk 的 status 事件带 internal: true)');
  const src = fs.readFileSync(PI_SDK, 'utf8');
  const lines = src.split('\n');

  let internalOk = 0;
  const missing: string[] = [];
  for (const marker of MUST_BE_INTERNAL) {
    const hits = lines.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) { missing.push(`${marker} (定位 ${hits.length} 处)`); continue; }
    const st = nearestStatusLine(lines, hits[0]);
    if (st === null || !lines[st].includes('internal: true')) { missing.push(`${marker} (行 ${hits[0] + 1} 未标 internal)`); continue; }
    internalOk++;
  }
  if (missing.length === 0) ok(`内部运行日志 20/20 都在发送点声明了`, `${internalOk} 条带 internal: true`);
  else bad(`内部运行日志声明不全 (${internalOk}/${MUST_BE_INTERNAL.length})`, missing.join(' · '));

  const wronglyMarked: string[] = [];
  for (const marker of MUST_NOT_BE_INTERNAL) {
    const hits = lines.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 0) { wronglyMarked.push(`${marker} (源码里找不到, 阴性对照失效)`); continue; }
    for (const h of hits) {
      const st = nearestStatusLine(lines, h);
      if (st !== null && lines[st].includes('internal: true')) wronglyMarked.push(`${marker} 被误标成内部`);
    }
  }
  if (wronglyMarked.length === 0) ok(`用户可见状态 6/6 没被误标成内部 (阴性对照成立)`);
  else bad(`用户可见状态被误吞`, wronglyMarked.join(' · '));

  // 门自己的黑名单必须覆盖 leo 点名的两条 (且真的对应源码里的发送点)
  const literal = ['开始 ReAct 循环', '目标对齐'];
  const covered = literal.filter((s) => BLACKLIST.some((b) => b === s));
  if (covered.length === 2) ok(`门覆盖 leo 点名的两条字面串`, '开始 ReAct / 开始 React 循环 + 目标对齐');
  else bad('黑名单漏了 leo 点名的串', covered.join(','));
}

// ---------------------------------------------------------------------------
// E 段 — 前后对比 (fixture vs 真跑)
// ---------------------------------------------------------------------------
function fixtureInternalLines(): string[] {
  if (!fs.existsSync(FIXTURE)) return [];
  return fs.readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** fixture 头里记下的"修复前同判据"数字 (真抓包量出来的, 由门在 B 段跟真跑对比) */
function fixtureBeforeMetric(): number | null {
  if (!fs.existsSync(FIXTURE)) return null;
  const m = fs.readFileSync(FIXTURE, 'utf8').match(/回复流唯一行\s*(\d+)\s*行/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 变异
// ---------------------------------------------------------------------------
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface Mutation {
  label: string;
  file: string;
  mutate: (src: string) => string | null;
}

const MUTATIONS: Mutation[] = [
  {
    label: 'M1 判据恒 false (内部日志又透回回复流)',
    file: HYGIENE_SRC,
    mutate: (src) => src.replace(
      'return !!e && e.type === \'status\' && e.internal === true;',
      'return false; // MUTATION'),
  },
  {
    label: 'M2 日志行生成拿掉 (只静默不落盘)',
    file: HYGIENE_SRC,
    mutate: (src) => src.replace(
      'return `${INTERNAL_RUN_LOG_PREFIX}${tool ? `${tool} · ` : \'\'}${content}`;',
      'return \'\'; // MUTATION'),
  },
  {
    label: 'M3 发送点标记拿掉 (回到"按内容猜")',
    file: PI_SDK,
    mutate: (src) => src.replace("type: 'status', internal: true, content: '🔄 开始 ReAct 循环...'",
      "type: 'status', content: '🔄 开始 ReAct 循环...'"),
  },
];

function runMutation(m: Mutation): void {
  const orig = fs.readFileSync(m.file, 'utf8');
  const origSha = sha256(orig);
  const mutated = m.mutate(orig);
  if (mutated === null || mutated === orig) {
    bad(`${m.label} → 变异没生效`, `${path.relative(ROOT, m.file)} 里没找到变异锚点 (改成按词界整段匹配后重试)`);
    return;
  }
  try {
    fs.writeFileSync(m.file, mutated);
    if (sha256(fs.readFileSync(m.file, 'utf8')) === origSha) {
      bad(`${m.label} → 变异没落盘`, '写盘后 hash 未变');
      return;
    }
    const r = runSession(`mut-${m.label.slice(0, 2)}`);
    const hits = blacklistHits(r.text);
    const ran = sessionReallyRan(r);
    const logRun = logHits(r.logText);
    const red = m.label.startsWith('M2') ? totalHits(logRun) === 0 : totalHits(hits) > 0;
    if (!ran.ok) {
      bad(`${m.label} → 判不了`, `这次会话没真跑出用户可见内容 (${ran.why}); 变异结论作废`);
    } else if (red) {
      ok(`${m.label} → 门必红 (真判红)`,
        m.label.startsWith('M2') ? '日志 `[运行] ` 通道命中 0 (只静默没落盘)' : `回复流命中 ${totalHits(hits)} 行`);
    } else {
      bad(`${m.label} → 门没红 (假绿)`, `回复流命中 ${totalHits(hits)} · 日志命中 ${totalHits(logRun)}`);
    }
  } finally {
    fs.writeFileSync(m.file, orig);
    const back = sha256(fs.readFileSync(m.file, 'utf8'));
    if (back !== origSha) bad(`${m.label} → 恢复失败`, `${path.relative(ROOT, m.file)} sha256 与原文件不一致`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function fmt(h: Record<string, number>): string {
  return Object.entries(h).map(([k, v]) => `${k}=${v}`).join(' · ');
}

async function main(): Promise<number> {
  console.log('verify-reply-hygiene — 内部运行日志不进对话回复流 (真跑真进程)');
  console.log(`  仓库: ${ROOT}`);
  console.log(`  跑法: npx tsx src/index.ts (与 bolloon --cli 同一条主路径) + scripts/lib/pty-drive.py 真 pty`);

  partA();

  const fixture = fixtureInternalLines();
  section('E 修复前后对比 (修复前 = 真抓包 fixture, 修复后 = 本次真跑)');
  if (fixture.length >= 5) {
    ok(`fixture 阳性对照: 修复前回复流里数得出 ${fixture.length} 行内部运行日志`,
      `举例: ${fixture[0]} / ${fixture.find((l) => l.includes('目标对齐')) || '—'}`);
    console.log('    [逐串] 修复前 fixture 命中 / 修复后真跑命中 (同一个判据):');
    for (const pat of BLACKLIST) {
      console.log(`      ${pat}: ${fixture.filter((l) => l.includes(pat)).length} / (见 B 段)`);
    }
  } else {
    bad('fixture 阳性对照不足', `只解析出 ${fixture.length} 行; 门对"0 命中"的判定会退化成空文档假绿`);
  }

  if (ONLY_SOURCE) {
    console.log(`\n--only-source: 跳过 B/C/D/F (需要真 LLM)`);
    return finish();
  }

  const made = makeIsolatedHome('main');
  if (!Object.keys(made.env).some((k) => /_API_KEY$/.test(k))) {
    skip('B–D/F 真会话', '本机 ~/.bolloon 里没有可映射到 env 的 provider 凭证 → 需要真 LLM 的判据全部判不了');
    return finish();
  }

  let r: RunResult | null = null;
  try {
    section('B 默认模式真跑: 黑名单每串 0 命中 (且会话真的跑了)');
    r = runSession('default', { home: made.home, env: made.env });
    const ran = sessionReallyRan(r);
    if (ran.ok) ok('这次会话真跑了 (阴性对照: 0 命中不是空文档)', `${ran.why} · ${(r.elapsedMs / 1000).toFixed(0)}s`);
    else bad('这次会话没有用户可见内容 → 0 命中判不了', ran.why);

    const hits = blacklistHits(r.text);
    const bad0 = Object.entries(hits).filter(([, v]) => v > 0);
    if (bad0.length === 0) ok(`黑名单 ${BLACKLIST.length} 串全部 0 命中 (回复流唯一行 ${replyStreamLines(r.text).length} 行)`);
    else bad('回复流里仍有内部运行日志', fmt(Object.fromEntries(bad0)));

    // 隐私: 抓包里不许出现 key 原文
    if (made.keyRaw && r.raw.includes(made.keyRaw)) bad('凭证泄漏', '抓包里出现了 provider key 原文');
    else ok('凭证未进抓包 (断言 key 原文 0 命中)');

    // 行数对比 (同一个 replyStreamLines 口径, 修复前数字来自真抓包 fixture 头)
    const beforeLines = fixtureBeforeMetric();
    const afterLines = replyStreamLines(r.text).length;
    if (beforeLines === null) bad('修复前数字缺失', `${path.relative(ROOT, FIXTURE)} 头里没写"回复流唯一行 N 行"`);
    else if (afterLines < beforeLines) ok('回复流唯一行数下降 (同任务 · 同判据)', `修复前 ${beforeLines} 行 → 修复后 ${afterLines} 行 (内部运行日志 ${fixture.length} → 0 行)`);
    else bad('回复流没变短', `修复前 ${beforeLines} → 修复后 ${afterLines}`);

    section('C 搬走不是删掉: 同一批行在日志文件里');
    const lh = logHits(r.logText);
    const runLines = r.logText.split('\n').filter((l) => l.includes('[运行] '));
    if (runLines.length >= 3) ok(`日志文件 ${path.relative(ROOT, path.join(r.home, '.bolloon', 'logs', 'startup.log'))} 里 [运行] 通道 ${runLines.length} 行`);
    else bad('日志文件里没有搬到该搬的地方', `[运行] 通道只有 ${runLines.length} 行`);
    const exercised = Object.entries(lh).filter(([, v]) => v > 0);
    if (exercised.length > 0) ok(`被搬走的行在日志里逐串可查 (${exercised.length} 串命中)`, fmt(Object.fromEntries(exercised)));
    else bad('日志里查不到任何黑名单串', '搬走变成了删掉');
    console.log(`    [逐串实测] 回复流命中 / 日志文件命中:`);
    for (const pat of BLACKLIST) console.log(`      ${pat}: ${hits[pat]} / ${lh[pat]}`);

    section('D 诊断可召回: --verbose 时原样回到屏上');
    const rv = runSession('verbose', { verbose: true });
    const hv = blacklistHits(rv.text);
    const anyBack = totalHits(hv) > 0;
    const ranV = sessionReallyRan(rv);
    if (!ranV.ok) bad('verbose 轮没真跑', ranV.why);
    else if (anyBack) ok(`BOLLOON_VERBOSE=1 下这些行原样回来 (命中 ${totalHits(hv)} 行)`, fmt(Object.fromEntries(Object.entries(hv).filter(([, v]) => v > 0))));
    else bad('verbose 下也看不到 → 诊断丢了', '黑名单命中 0');
    const lhv = logHits(rv.logText);
    if (totalHits(lhv) > 0) ok(`verbose 轮照样落盘 (日志 ${totalHits(lhv)} 串命中)`);
    else bad('verbose 轮没落盘', '日志 [运行] 通道 0 命中');
    try { if (!KEEP_HOME) fs.rmSync(rv.home, { recursive: true, force: true }); } catch { /* 清理失败不致命 */ }
  } finally {
    if (!KEEP_HOME) { try { fs.rmSync(made.home, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  section('F 变异判红');
  if (SKIP_MUTATIONS) {
    skip('M1/M2/M3 变异', '--skip-mutations');
  } else {
    for (const m of MUTATIONS) runMutation(m);
  }

  return finish();
}

function finish(): number {
  console.log(`\nverify-reply-hygiene: ${passed} passed / ${failed} failed`);
  if (failures.length > 0) console.log(`  红的: ${failures.join(' | ')}`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}).catch((e) => {
  console.error('verify-reply-hygiene 崩了:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(2);
});
