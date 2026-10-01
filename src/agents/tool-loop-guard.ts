/**
 * tool-loop-guard.ts — 工具调用的**停滞观测与温和引导** (2026-10-01)
 *
 * 为什么需要它 (用户原话: 「一个简单的任务居然花这么多次工具调用」):
 *   原先的防重只有一条「同工具连续 5 次 ⇒ 注入一条提示, 然后重置计数」。实测模型无视提示后
 *   完全没刹车 —— 同一个 get_identity 连调 10 次 ✗; 而且**只看工具名**, 连"同工具换参数的正常
 *   迭代"(逐文件读)也会被误判。
 *   反过来"硬停"也不行 (用户明确否决): 那是在症状上下手, 而且会堵掉正当的重复轮询。
 *
 * 所以这里采用**分类 + 温和合成**的口径:
 *   ① 工具先分类: 幂等读 / 有副作用 / 可重复轮询 (含命名约定 `_poll` / `_get_result`);
 *   ② 判据看**签名** (工具名 + 参数的规范 JSON 的哈希), 不只看工具名 ⇒ 换参数不误伤;
 *   ③ 命中停滞**不拒绝执行**, 而是产出一条**引导文本**追加在真结果后面 (保留模型的选择权);
 *   ④ 完全相同的**结果**从第 2 次起用**引用 stub** 替代 (省上下文; 且明确告诉模型"与上次相同");
 *   ⑤ 抓**循环** (A→B→A→B…, 周期 ≤4): 相邻重复计数会被交替调用清零, 只抓相邻的会漏;
 *   ⑥ 失败宽容类工具 (跑测试红了 / grep 空 / 页面超时) 的"失败"是正常工作输出, 不参与停滞判定。
 *
 * 纯逻辑, 不碰 IO / 不发请求 —— 便于单测与变异验证。
 */
import { createHash } from 'node:crypto';

/** 幂等只读类: 同参数重复调用不会产生新信息 (但允许换参数继续用) */
/**
 * **结果恒定**的工具 (2026-10-01): 同一会话内反复调, 返回**永远一样**, 且答案本身很短。
 *   用户实测: `get_identity` 连调 3–4 次 ✗ —— 原有"引用 stub"有字符数门槛, 而它的输出才 ~90 字符
 *   ⇒ 门槛拦不住 ⇒ 模型看不出"再问也一样"。
 * 规矩 (工具设置层, 不做硬刹车): 从**第 2 次**完全相同的调用起, 直接把结果换成一句标准答复,
 *   明确告诉模型"答案就在上面那次返回里, 再调不会变" ⇒ 去掉它重复调的理由。
 */
export const CONSTANT_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'get_identity', 'bolloon_config_get', 'get_agent_info', 'whoami',
]);

export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'list_files', 'search_files', 'get_identity', 'get_operation_logs',
  'list_remote_channels', 'list_context_layers', 'read_context_assets', 'get_balance', 'wallet_list',
  'web_search', 'web_extract', 'check_inbox',
]);

/** 有副作用类: 重复调用可能是正当的 (例如再跑一条命令), 由"同签名同结果"判定停滞 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'terminal', 'shell_exec', 'execute_code', 'write_file', 'patch', 'set_persona', 'memory',
  'todo_list', 'send_message', 'send_to_remote_channel', 'delegate_task', 'create_group', 'set_wallet',
]);

/** 轮询类: 同参数重复**本来就正当** (等异步任务), 永不触发相同调用提示 */
export const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(['process_manage', 'check_task_status']);
/** 生成/MCP 轮询工具的命名约定 (与上面同理) */
export const REPEATABLE_SUFFIXES: readonly string[] = ['_poll', '_get_result'];

/** 失败的"正常输出"类: 红了/空结果/超时属于工作产出, 不参与停滞判定 */
export const FAILURE_TOLERANT_TOOLS: ReadonlySet<string> = new Set(['terminal', 'shell_exec', 'execute_code', 'web_search', 'web_extract']);

/** 第几次**连续相同 (工具+参数+结果)** 触发引导 (3 = 容忍一次复核) */
export const IDENTICAL_CALL_THRESHOLD = 3;
/** 抓循环时最长的周期 (A→B→A→B 的周期是 2) */
export const MAX_CYCLE_PERIOD = 4;
/** 历史窗口: 够放最长的周期若干圈 + 余量 */
export const CYCLE_HISTORY = 64;
/** 结果达到这个字符数才值得用 stub 替代 (太短本来就省不了多少) */
export const STUB_MIN_CHARS = 512;
/**
 * **同签名 + 同结果**的重复调用: 门槛降到这个值 (2026-10-01, 优化 #1 的收尾)。
 * 为什么单独一条: 512 是"值不值得压缩"的门槛 ✗, 而"同一个调用又跑了一遍、结果一字不差"**本身就是浪费** ✓
 *   —— 实测 `get_identity` 输出才 ~90 字符 ⇒ 卡在 512 门外, 于是被连调 3–4 次 ✓。
 * 现在: 同签名重复 且 结果一致 且 ≥64 字符 ⇒ 从第 2 次起换引用 stub ✓ (少于 64 字符的本来也占不了多少上下文, 放行 ✓)。
 */
export const REPEAT_STUB_MIN_CHARS = 64;
/** stub 里保留的参数预览长度 (万一压缩把原结果挤掉, 还能看出当初调了什么) */
export const STUB_ARGS_PREVIEW_CHARS = 120;

export type GuardAction = 'allow' | 'warn';

export interface GuardObservation {
  action: GuardAction;
  /** 判据名: identical_call_streak | identical_cycle */
  code: 'allow' | 'identical_call_streak' | 'identical_cycle';
  /** 追加在真结果**后面**的引导文本 */
  notice?: string;
  /** 替代重复结果的引用 stub (仅当结果够长且非失败) */
  stub?: string;
  /** 连续相同的次数 (引导文本里用) */
  count: number;
}

/** 参数的规范 JSON (键排序 + 紧凑分隔符) —— 让 {a,b} 与 {b,a} 同签名 */
export function canonicalToolArgs(args: unknown): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '';
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** 调用签名: 不可逆 (只留哈希), 不泄漏参数原文 */
export function toolCallSignature(toolName: string, args: unknown): string {
  return createHash('sha256').update(`${toolName}\u0000${canonicalToolArgs(args)}`).digest('hex').slice(0, 16);
}

/** 结果指纹 (判"完全相同的返回") */
export function resultFingerprint(resultText: string): string {
  return createHash('sha256').update(String(resultText ?? '')).digest('hex').slice(0, 16);
}

export function isRepeatableTool(toolName: string): boolean {
  if (REPEATABLE_TOOLS.has(toolName)) return true;
  return REPEATABLE_SUFFIXES.some((s) => toolName.endsWith(s));
}

export interface ObserveInput {
  toolName: string;
  args: unknown;
  /** 工具返回的正文 (成功时的 output) */
  resultText?: string;
  ok?: boolean;
  /** 本轮内是否已见过**同一个结果指纹** */
  seenResultBefore?: boolean;
  /** 结果大小 (字符数), 缺省用 resultText.length */
  resultChars?: number;
  /** 是否与**上一次**调用同签名 (同一个工具+同一份参数又跑了一遍) ⇒ 重复就是浪费, 门槛降到 REPEAT_STUB_MIN_CHARS */
  sameSignatureBefore?: boolean;
}

/**
 * 记录一次调用并给出观测。**纯函数式**: 调用方每次都要把上一次的 streak 传进来
 * (见 `LoopStallState`), 这样状态归属清晰、也便于单测。
 */
export function observeToolCall(state: LoopStallState, input: ObserveInput): GuardObservation {
  const ok = input.ok !== false;
  const tolerant = FAILURE_TOLERANT_TOOLS.has(input.toolName);
  const repeatable = isRepeatableTool(input.toolName);
  const text = String(input.resultText ?? '');
  const chars = input.resultChars ?? text.length;

  // ① 轮询类: 同参数重复本就正当 ⇒ 只记录, 不出声
  if (repeatable) {
    state.push(input.toolName, input.args, text);
    return { action: 'allow', code: 'allow', count: 0 };
  }

  const sig = toolCallSignature(input.toolName, input.args);
  const fp = resultFingerprint(text);
  const prev = state.last;
  const sameAsPrev = !!prev && prev.sig === sig && prev.fp === fp;

  // ② 连续相同 (工具 + 参数 + 结果): 每次 +1, 否则归 1
  state.streak = sameAsPrev ? state.streak + 1 : 1;
  state.push(input.toolName, input.args, text);

  // ③ 失败宽容类工具的失败不参与停滞判定 (红测试/空 grep 是产出, 不是卡住)
  if (!ok && tolerant) {
    return { action: 'allow', code: 'allow', count: state.streak };
  }


  // ③.5 恒定结果工具 (get_identity 这类): 从第 2 次起换标准答复 —— 不管结果长短
  if (sameAsPrev && CONSTANT_RESULT_TOOLS.has(input.toolName) && ok) {
    return {
      action: 'allow',
      code: 'allow',
      count: state.streak,
      stub:
        `[已答] ${input.toolName} 的结果在本次会话内**恒定不变**(它读的是固定身份/配置, 不是活数据)。` +
        `上面那一次返回就是答案, 直接用它作答即可; 再调一次只会得到同样的内容。` +
        `若确实需要变化, 请改用写类工具(如 set_persona / 相应 update 工具)。`,
    };
  }

  // ④ 结果引用 stub: 从**第 2 次**完全相同的返回起 (够长才替代; 失败永不替代)
  let stub: string | undefined;
  // 2026-10-01 (优化 #1 收尾): 同签名重复 + 结果一字不差 ⇒ 用更低门槛 (重复本身就是浪费, 不管长短)
  const repeatFloor = input.sameSignatureBefore ? REPEAT_STUB_MIN_CHARS : STUB_MIN_CHARS;
  if (ok && input.seenResultBefore && chars >= repeatFloor) {
    stub = `[结果引用] 与本次会话中此前一次 ${input.toolName} 的返回**逐字相同** (${chars} 字符, 已折叠)。`
      + `参数预览: ${canonicalToolArgs(input.args).slice(0, STUB_ARGS_PREVIEW_CHARS)}`;
  }

  if (state.streak >= IDENTICAL_CALL_THRESHOLD) {
    // ⑤ 连续相同达阈值 ⇒ 温和引导 (不拒绝执行)
    return {
      action: 'warn',
      code: 'identical_call_streak',
      count: state.streak,
      stub,
      notice: `[系统提示] 这是第 ${state.streak} 次**用完全相同的参数**调用 ${input.toolName}, 且返回与上次完全相同。`
        + `重复调用不会得到新信息 —— 请换参数、换工具, 或基于已有结果直接回答。`,
    };
  }

  // ⑥ 循环检测: 最近 N 次里出现了周期 ≤4 的重复串 (相邻计数会被交替调用清零, 只抓相邻必漏)
  const cycle = detectCycle(state.history);
  if (cycle) {
    return {
      action: 'warn',
      code: 'identical_cycle',
      count: cycle.laps,
      stub,
      notice: `[系统提示] 检测到最近 ${cycle.laps} 圈重复同一组 ${cycle.period} 次调用`
        + `(以 ${input.toolName} 结尾), 参数与返回都逐字相同。请不要重复这一组 —— 换参数、换工具, 或基于已有结果直接回答。`,
    };
  }

  return { action: 'allow', code: 'allow', count: state.streak, stub };
}

interface Step { sig: string; fp: string }

/** 每轮 ReAct 循环一份的停滞状态 */
export class LoopStallState {
  streak = 0;
  last: Step | null = null;
  readonly history: Step[] = [];
  /** 已见过的结果指纹 (用于"完全相同返回"的 stub 判定) */
  readonly seenResults = new Set<string>();

  push(toolName: string, args: unknown, resultText: string): void {
    const step: Step = { sig: toolCallSignature(toolName, args), fp: resultFingerprint(resultText) };
    this.last = step;
    this.history.push(step);
    if (this.history.length > CYCLE_HISTORY) this.history.shift();
    this.seenResults.add(step.fp);
  }

  /** 这个结果指纹此前是否出现过 (供 observeToolCall 的 seenResultBefore) */
  hasSeenResult(text: string): boolean {
    return this.seenResults.has(resultFingerprint(text));
  }

  reset(): void {
    this.streak = 0;
    this.last = null;
    this.history.length = 0;
    this.seenResults.clear();
  }
}

/**
 * 找"最近若干圈完全重复"的串: 对每个候选周期 p ∈ [1, MAX_CYCLE_PERIOD],
 * 看末尾是否由同一个 p 长度的块**重复 ≥ THRESHOLD 次**组成 (块内每个 (签名,结果指纹) 都相同)。
 * 返回圈数与周期, 没有则 null。
 */
export function detectCycle(history: readonly Step[]): { period: number; laps: number } | null {
  const h = history;
  for (let p = 1; p <= MAX_CYCLE_PERIOD; p++) {
    const need = p * IDENTICAL_CALL_THRESHOLD;
    if (h.length < need) continue;
    const tail = h.slice(-need);
    let same = true;
    for (let i = p; i < need && same; i++) {
      if (tail[i].sig !== tail[i % p].sig || tail[i].fp !== tail[i % p].fp) same = false;
    }
    if (same) return { period: p, laps: IDENTICAL_CALL_THRESHOLD };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 2026-10-01 第二轮 (继续学): 三处补上
//   ① **无进展**是独立一轴: 幂等工具即使**换了参数**, 只要结果与上次相同 ⇒ 也是无进展
//      (原先只抓"同参数" ⇒ 换个措辞再问一遍就绕过去了)
//   ② **进展的定义 = 有副作用的调用成功过** (纯读再多都不算) ⇒ 用它清零失败/无进展计数
//   ③ 升级策略**按在场与否分流**: 有人在 ⇒ 只提醒(从不阻止执行); 无人值守 ⇒ 才允许拦/停
//      (人在场时不该替用户做决定; 但 cron/supervisor 这种无人值守的场景, 该果断收)
// ───────────────────────────────────────────────────────────────────────────

/** 有副作用 = 会改变世界 (文件/进程/网络/资金/记忆). 唯一判据, 供"进展"与"无进展"用 */
export function toolMayHaveSideEffect(toolName: string): boolean {
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (IDEMPOTENT_TOOLS.has(toolName)) return false;
  if (isRepeatableTool(toolName)) return false;
  // 未登记的工具按"可能有副作用"处理 (保守: 不轻易判定"它没改变世界")
  return true;
}

/** 阈值矩阵 (不同轴不同限, 不搞单值一刀切) */
export interface LoopGuardThresholds {
  exactFailureWarnAfter: number;
  exactFailureBlockAfter: number;
  sameToolFailureWarnAfter: number;
  sameToolFailureHaltAfter: number;
  noProgressWarnAfter: number;
  noProgressBlockAfter: number;
  /** 提醒永不禁执行; 硬动作默认关, 只在无人值守时开 */
  hardStopEnabled: boolean;
}

export const DEFAULT_THRESHOLDS: LoopGuardThresholds = {
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 5,
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 5,
  hardStopEnabled: false,
};

/** 无人值守场景 (cron / supervisor / 非交互) —— 那里才默认允许拦与停 */
export function defaultHardStopFor(context: { unattended?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (typeof context.unattended === 'boolean') return context.unattended;
  const env = context.env || process.env;
  return env.BOLLOON_UNATTENDED === '1' || env.BOLLOON_CRON === '1' || env.BOLLOON_SUPERVISOR === '1';
}

export interface NoProgressState {
  lastResultFp: string;
  count: number;
}

export interface ProgressBookkeeping {
  /** 某签名的失败已被"有副作用的成功"抵销 (key = 签名) */
  progressClearedSignatures: Set<string>;
  /** 幂等工具的无进展计数 (key = 工具名) */
  noProgress: Map<string, NoProgressState>;
}

export function newProgressBookkeeping(): ProgressBookkeeping {
  return { progressClearedSignatures: new Set(), noProgress: new Map() };
}

/**
 * 记一次调用结果, 维护"进展 / 无进展"两本账。
 * - 有副作用的调用**成功** ⇒ 视为进展: 清掉该签名的失败标记 + 清掉**所有**无进展记录
 *   (世界变了 ⇒ 之前"读了没变化"的判定作废)
 * - 幂等工具: 结果指纹与上次相同 ⇒ 无进展 +1 (**参数变没变不影响**), 不同 ⇒ 归 1
 */
export function trackProgress(
  book: ProgressBookkeeping,
  input: { toolName: string; args: unknown; resultText?: string; ok?: boolean },
  thresholds: LoopGuardThresholds = DEFAULT_THRESHOLDS,
): { action: GuardAction; code: 'allow' | 'idempotent_no_progress'; count: number; notice?: string } {
  const ok = input.ok !== false;
  const sig = toolCallSignature(input.toolName, input.args);
  const fp = resultFingerprint(String(input.resultText ?? ''));

  if (ok && toolMayHaveSideEffect(input.toolName)) {
    book.progressClearedSignatures.add(sig);
    if (book.noProgress.size > 0) book.noProgress.clear();
    return { action: 'allow', code: 'allow', count: 0 };
  }

  if (!toolMayHaveSideEffect(input.toolName)) {
    const prev = book.noProgress.get(input.toolName);
    const count = prev && prev.lastResultFp === fp ? prev.count + 1 : 1;
    book.noProgress.set(input.toolName, { lastResultFp: fp, count });
    if (count >= thresholds.noProgressWarnAfter) {
      return {
        action: 'warn',
        code: 'idempotent_no_progress',
        count,
        notice: `[系统提示] 连续 ${count} 次读取类调用 (${input.toolName}) 返回的都是**同一份内容**`
          + `(参数不同也一样) —— 世界没有变化, 再读还是它。请基于已有内容作答, 或改去查别的来源。`,
      };
    }
    return { action: 'allow', code: 'allow', count };
  }

  return { action: 'allow', code: 'allow', count: 0 };
}
