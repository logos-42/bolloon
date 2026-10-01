/**
 * startup-notice.ts — 启动**前言 / 就绪度报告**的上屏闸门 (2026-09-27)
 *
 * ## 这一层解决什么
 *
 * `src/cli/log-gate.ts` 盖的是**通用加载日志**(按行形状判: module tag / ISO 时间戳 / P2P 自述)。
 * 但 `bolloon --cli` 启动前还有**另一条**刷屏路径, 它不带任何 tag, 所以上一轮没盖到:
 *
 *   ① `src/index.ts` 交互启动前的门禁检查 → `describeSetup(ev)` 整段
 *      (`初始化状态: …  门禁: …` / `就绪度: basic=✗ …` / `已完成: …` / `配置来源: …` /
 *       `已存输入: …` / `缺 (basic): …` / `下一步: …`);
 *   ② `runSetupWizard` 的续跑前言 (那个 `╭─ Bolloon 初始化 …╮` 框 + `Onboard 模式: …` +
 *      每步 `✓/✗` + `✅ 初始化完成 …` + 收尾再报一遍 `describeSetup`)。
 *
 * leo 口径 (2026-09-27): **打完 `bolloon --cli` 就该直接看到面板** —— 上面那些属于
 * 「启动前的日志」, 默认一个字节都不该上屏; 但**没做好/要人下手的事不许被吞**。
 *
 * ## 三条出口 (与 log-gate 同构, 但对象是"前言"而不是"加载日志")
 *
 *   · 默认: 收进内存缓冲 → **不上屏**, 但**照抄进启动日志文件** (诊断不丢);
 *   · `--verbose` / `BOLLOON_VERBOSE=1` / `BOLLOON_STARTUP_PREAMBLE=1`:
 *     一行不改地写回 stderr (与修前逐字一致, 也是验收门的"修前对照");
 *   · **失败 / 需人介入**: 由 `alertsFromSetup()` 折成**面板内一行提示**, 交给 Ink 渲染
 *     (不是启动前大段刷屏)。判据复用 `log-gate.ts` 的 `carriesHumanSignal()` —— 只有一处。
 *
 * ## 什么时候必须**当场**把缓冲吐出来
 *
 * 前言被静默的前提是"后面有面板接着显示"。一旦流程变成**要人当场回答**(向导问问题)或者
 * **根本走不到面板**(初始化中断/非零退出), 缓冲就必须先落屏 —— 否则就变成"信息被吞"。
 * 这两条出口分别在 `runSetupWizard`(问问题前 `flushStartupNotices()`) 与
 * `src/index.ts`(退出前) 显式调用。
 */

import { carriesHumanSignal, isStartupVerbose, logStartupLine, VERBOSE_ENV } from './log-gate.js';

/** 显式要求"把启动前言打出来"(排查用; 语义 = 修前的默认行为) */
export const PREAMBLE_ENV = 'BOLLOON_STARTUP_PREAMBLE';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** 前言要不要上屏 */
export function startupPreambleVisible(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
): boolean {
  const v = (env[PREAMBLE_ENV] ?? '').trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  return isStartupVerbose(args, env);
}

/** 缓冲里攒下的前言行 (默认模式的"没上屏但没丢"的那一份) */
const buffer: string[] = [];
/** 面板里要显示的就绪度行 (一行, 来自 `readinessLine()`) */
let readiness: string | null = null;
/** 面板里要显示的告警行 (失败/需人介入; 一条一行) */
const alerts: string[] = [];

/** 复位 (单测 / 同进程多次启动用) */
export function resetStartupNotices(): void {
  buffer.length = 0;
  alerts.length = 0;
  readiness = null;
}

/** 收/发一行前言: 可见模式写 stderr (与修前逐字一致), 默认模式进缓冲 + 落日志文件 */
export function noticeLine(line: string, opts: { visible?: boolean } = {}): void {
  const visible = opts.visible ?? startupPreambleVisible();
  for (const l of String(line).split('\n')) {
    if (l === '' && line === '') { /* 空行也照收: 前言里有排版空行 */ }
    logStartupLine(l);                 // 诊断不丢: 无论上不上屏都落盘
    if (visible) { process.stderr.write(l + '\n'); continue; }
    buffer.push(l);
    // 失败/需人介入的行不许只躺在缓冲里 —— 同时折成面板告警 (去重)
    if (carriesHumanSignal(l) && !alerts.includes(l)) alerts.push(l);
  }
}

/** 缓冲里的前言行数 (验收门读它做对照) */
export function bufferedNoticeLines(): string[] {
  return [...buffer];
}

/** 把缓冲**当场**写到 stderr (要人回答 / 走不到面板时的兜底出口) */
export function flushStartupNotices(): void {
  if (buffer.length === 0) return;
  const payload = buffer.join('\n') + '\n';
  buffer.length = 0;
  process.stderr.write(payload);
}

/**
 * 丢掉缓冲 (2026-09-27): **已经走到面板**时用 —— 剩下的纯前言不上屏 (它在 startup.log 里),
 * 但它也就没必要继续留在内存里等下一次启动重放。
 */
export function clearBufferedNotices(): void {
  buffer.length = 0;
}

/** 设置面板里的就绪度行 (一行) */
export function setStartupReadiness(line: string | null): void {
  readiness = line;
}

/** 追加一条面板告警 (失败/需人介入) */
export function pushStartupAlert(line: string): void {
  if (!line) return;
  if (!alerts.includes(line)) alerts.push(line);
}

export interface StartupPanelNotes {
  /** 一行就绪度 (`就绪: basic ✓ · agent ✓ · durable ✗ · network ✓ · 详情: …`) */
  readiness: string | null;
  /** 失败/需人介入的提示行 (面板里逐行显示) */
  alerts: string[];
}

/** 取走面板要显示的内容 (取走即清 —— 免得下次启动重复显示) */
export function takeStartupPanelNotes(): StartupPanelNotes {
  const notes: StartupPanelNotes = { readiness, alerts: [...alerts] };
  readiness = null;
  alerts.length = 0;
  return notes;
}

// ---------------------------------------------------------------------------
// 格式化 (纯函数 —— 单测与验收门直接喂它)
// ---------------------------------------------------------------------------

/** 详情查询命令 (面板提示里指的那个显式出口; 与 `cli-entry.ts` 的实现同一句) */
export const SETUP_STATUS_CMD = 'bolloon setup status';

const mark = (v: boolean): string => (v ? '✓' : '✗');

/**
 * 一行就绪度: `就绪: basic ✓ · agent ✓ · durable ✗ · network ✓ · 详情: bolloon setup status`
 *
 * 为什么是"一行"而不是原来那 4 行明细: 面板里放得下, 一眼看得出来, 细节按需查
 * (`bolloon setup status` 打全量 / `--verbose` 打修前那一段)。
 */
export function readinessLine(
  readiness: { basic?: boolean; agent?: boolean; durable?: boolean; network?: boolean },
  cmd: string = SETUP_STATUS_CMD,
): string {
  return `就绪: basic ${mark(!!readiness.basic)} · agent ${mark(!!readiness.agent)}`
    + ` · durable ${mark(!!readiness.durable)} · network ${mark(!!readiness.network)}`
    + ` · 详情: ${cmd}`;
}

/** `evaluateSetup()` 结果里我们要用到的字段 (结构性子集 —— 不 import 被测模块的类型, 免成环) */
export interface SetupEvalLike {
  gate: string;
  reasons?: string[];
  nextActions?: string[];
  state?: {
    readiness?: { basic?: boolean; agent?: boolean; durable?: boolean; network?: boolean };
    readinessWhy?: { basic?: string[]; agent?: string[]; durable?: string[]; network?: string[] };
    lastError?: { stage?: string; errorClass?: string; message?: string };
    allow?: { agent?: boolean; supervisor?: boolean };
  };
}

/**
 * 从门禁结论折出**面板告警行** (失败/需人介入才给, 就绪时给空数组)。
 *
 * 三条规矩:
 *   ① 只在"真有事"时出声 (gate !== ready / 有 lastError) —— 就绪时面板不加噪音;
 *   ② 每条都是**一行**, 且带上"下一步怎么办"或"去哪看全量";
 *   ③ 不许只说"未就绪"三个字 —— 必须点出第一条具体原因 (`readinessWhy` 优先, 再退 `reasons`)。
 */
export function alertsFromSetup(ev: SetupEvalLike | null | undefined): string[] {
  if (!ev) return [];
  const state = ev.state || {};
  const out: string[] = [];
  const why = state.readinessWhy || {};
  const firstWhy = [why.basic, why.agent, why.durable].flatMap((a) => a || []).find((x) => !!x);
  const firstReason = (ev.reasons || []).find((x) => !!x);
  if (ev.gate !== 'ready') {
    const detail = firstWhy || firstReason || '未说明 (跑 `' + SETUP_STATUS_CMD + '` 看全量)';
    out.push(`⚠ 未就绪 (门禁: ${ev.gate}): ${detail}`);
    const next = (ev.nextActions || [])[0];
    if (next) out.push(`  下一步: ${next} · 全量: ${SETUP_STATUS_CMD}`);
  }
  const le = state.lastError;
  if (le && (le.message || le.stage)) {
    out.push(`⛔ 上次初始化失败 [${le.errorClass || 'unknown'}] ${le.stage || ''}: ${String(le.message || '').slice(0, 160)}`);
    out.push(`  处置: \`bolloon setup\` 会从失败阶段继续 · 全量: ${SETUP_STATUS_CMD}`);
  }
  return out;
}

/**
 * 这个未就绪状态是否**只差"连通性复测"** (2026-10-01)。
 *
 * 为什么单列这一类: 连通性实测结果 >24h 就"过期", 此后**每次启动**都会命中未就绪 ⇒
 * 启动路径会去跑整个 setup 向导 ⇒ 向导按"真跑了步骤就要把前言放出来"的规矩刷约 30 行
 * (初始化框 / Onboard 模式 / 每步 ✓✗ / 就绪度报告) —— 用户明确不要看到这些。
 * 这类不需要在启动时抢跑: 门禁照旧拦住 agent 执行 (不绕过), 用户按需跑 `bolloon setup --test` 即可。
 *
 * 判据 (两条都满足才算):
 *   ① 门禁是 setup 且 basic 就绪度没过;
 *   ② basic 的原因里**只**出现连通性复测相关字样 (连通 / 过期 / 重测 / connectivity)。
 * 首次使用 (缺 provider/key) 的 basic 原因不匹配 ⇒ 仍然照常跑向导 (onboarding 不能被跳过)。
 */
export function onlyConnectivityRetest(ev: SetupEvalLike | null | undefined): boolean {
  if (!ev || ev.gate === 'ready') return false;
  const basic = ev.state?.readiness?.basic;
  if (basic !== false) return false;
  const reasons = (ev.state?.readinessWhy?.basic || []).map((x) => String(x));
  if (reasons.length === 0) return false;
  const connLike = /连通|过期|重测|connectivity|expired/i;
  return reasons.every((r) => connLike.test(r));
}

/** verbose 模式下那句"现在是全量"的提示 (默认不出现) */
export function preambleHintLine(env: NodeJS.ProcessEnv = process.env): string {
  return `[startup] 诊断模式 (--verbose / ${VERBOSE_ENV}=1 / ${PREAMBLE_ENV}=1): 启动前言全量输出`
    + ' (默认模式下这部分只在面板里给一行就绪度 + 失败提示)';
}
