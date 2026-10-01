import { dispWidth } from './loading-tui.js';
/**
 * status-segments.ts — 状态栏右侧"活数据"段的纯函数 (leo 2026-09-30)
 *
 * 为什么抽出来: 这段原来内联在 `getStatus()` 里, 只能靠 PTY 抓包看 (那工具不稳),
 *   于是"到底什么时候显示什么"变成谁也说不清的事 —— leo 连着问了几次「这些标识没出现」。
 *   抽成纯函数后: 每种状态**直接跑一遍**, 显示什么、什么时候显示, 一张表说清楚。
 *
 * 语义 (刻意的, 不许改着好看):
 *   ◷ 本轮用时     —— 只在**本轮真的在跑**时显示 (有确切起点才有数)
 *   ↑ ≈N t/s       —— 有**实测**吞吐记录才算 (pi-ai 的 reply 字节 / 耗时); 字节折 token ~3.5B 是估, 所以标 ≈
 *   ⚙ N            —— **常显** (0 = 没有在跑的工具; 0 也是真话, 至少让人看出这段功能是活的)
 *   ✓ Ns           —— 只在上一步真有耗时 (>0) 时显示
 *   没有数据的段一律**不显示** —— 绝不编 0 秒 / 假速率
 */

export interface StatusFacts {
  /** 本轮是否在跑 (cliTurnStartedAt > 0) */
  running: boolean;
  /** 本轮已用时 ms (running 时有效) */
  turnElapsedMs: number;
  /** 上一步用时 ms (0 = 还没跑过) */
  lastTurnMs: number;
  /** 上一步回复字节数 (0 = 还没量到) */
  lastTurnReplyBytes: number;
  /** 在跑的工具数 (常显, 0 也显示) */
  toolCount: number;
  /** 最近一次模型调用的实测吞吐 (null = 本进程还没成功调过) */
  aiTiming?: { bytes: number; ms: number; at: number } | null;
  /** 本轮起点 (用于判断 aiTiming 是否属于本轮) */
  turnStartedAt?: number;
  /** 最近一次模型调用的用量 (算缓存命中率 ◎) */
  aiUsage?: { cached: number; prompt: number; at: number } | null;
  /**
   * 当前会话的 Title/Preview (leo 2026-09-30: 「session 的 Preview 在对话框工具栏右侧做显示」)。
   *   低优先级: 宽度不够时**第一个**被丢 (它只是提示"这条会话在聊什么")。
   */
  sessionPreview?: string;
}

/** 字节 → token 的估算比 (只有这一步是估, 所以显示时标 ≈) */
export const BYTES_PER_TOKEN = 3.5;

/** 返回"标签 值"对 (无 ANSI, 调用方拼颜色) —— 顺序: ◷ ↑ ⚙ ✓ */
export function statusSegments(f: StatusFacts): string[] {
  const out: string[] = [];
  if (f.running) {
    const secs = Math.max(0.1, f.turnElapsedMs / 1000);
    out.push(`◷ ${secs.toFixed(1)}s`);
    const ti = f.aiTiming;
    if (ti && ti.ms > 0 && ti.bytes > 0 && (!f.turnStartedAt || ti.at >= f.turnStartedAt)) {
      const tps = Math.round(ti.bytes / BYTES_PER_TOKEN / (ti.ms / 1000));
      if (tps > 0) out.push(`↑ ≈${tps} t/s`);
    }
  } else if (f.lastTurnMs > 0) {
    out.push(`✓ ${(f.lastTurnMs / 1000).toFixed(1)}s`);
    if (f.lastTurnReplyBytes > 0) {
      const tps = Math.round(f.lastTurnReplyBytes / BYTES_PER_TOKEN / Math.max(0.1, f.lastTurnMs / 1000));
      if (tps > 0) out.push(`↑ ≈${tps} t/s`);
    }
  }
  // ◎ 缓存命中率 = cached / prompt (provider 给的实测值; 没记录/没 prompt 就不显示)
  const u = f.aiUsage;
  if (u && u.prompt > 0) {
    const pct = (u.cached / u.prompt) * 100;
    out.push(`◎ ${pct.toFixed(1)}%`);
  }
  out.push(`⚙ ${f.toolCount}`);        // 常显
  // 会话 Title 不在这里拼 —— leo: 「这个 title 需要顶格右侧」⇒ 由 CLI 右对齐 (见 rightAlignPad)。
  return out;
}

/**
 * 按可用宽度取舍 (2026-09-30, 真机抓包照出来的问题):
 *   整行 ~130 字符, 112 列终端里**右边的段直接被截掉** ⇒ 看着像"没出现"。
 *   规则: 丢的顺序 = ↑ → ◎ → ✓ → ◷ (⚙ 永不丢 —— 它最短, 且"有没有在跑工具"最有信息量);
 *   每一段都按显示宽算 (中文 2 列)。
 */
export function fitSegments(segs: string[], avail: number, widthFn: (s: string) => number = dispWidth): string[] {
  // 2026-09-30: 宽度一律用 loading-tui 的 dispWidth (按 East Asian Width 表) ——
  //   之前这里和 getStatus 各写了一份 "charCode > 255 ⇒ 2" 的启发式, 它把 `│ ░ ◷ ▸ ◎ ✓ ↑ ⚙`
  //   这些**单宽**符号都算成 2 列 ⇒ 右对齐时每行凭空多占十几列 (leo: 「没有完全右对齐」)。
  const w = (s: string) => widthFn(s);
  const dropOrder = ['↑', '◎', '✓', '◷'];       // 先丢谁 (从重要性的低到高; ⚙ 永不丢)
  let cur = [...segs];
  const total = () => cur.reduce((n, s) => n + w(s), 0) + Math.max(0, cur.length - 1) * 3;   // 3 = ' │ '
  for (const tag of dropOrder) {
    if (total() <= avail) break;
    const i = cur.findIndex(s => s.startsWith(tag));
    if (i >= 0) cur.splice(i, 1);
  }
  return cur;
}

/**
 * 右对齐一段注释 (会话 Title) 需要的**左填充空格数** (纯函数, 可确定性验证)。
 *
 * leo 2026-09-30: 「这个 title 需要顶格右侧」= 贴终端右边缘, 不在段后面跟着走。
 * 规则:
 *   · 目标右边缘 = width - 1 (**绝不出正好等于终端宽度的行** —— 终端自动换行会把版面撑歪);
 *   · 至少留 1 个空格与左边内容分开 (挨着就分不清是标题还是段);
 *   · 放不下 (pad < 1) 返回 null ⇒ 调用方**不显示**标题 (宁可没有, 不挤坏这一行)。
 */
export function rightAlignPad(usedWidth: number, noteWidth: number, width: number): number | null {
  const pad = (width - 1) - usedWidth - noteWidth;
  return pad >= 1 ? pad : null;
}

/**
 * **保守测宽** (2026-10-01, 修"底栏整块重复打印")。
 *
 * 背景: `dispWidth` 按 East Asian Width 只把 **W/F 区**算 2 列, 而我们在底栏实际用了一批
 * **Ambiguous(A) 区**的字符 —— `·`(00B7) `↑`(2191) `◎`(25CE) `≈`(2248) `│`(2502)
 * `—`(2014) `─`(2500) 等。它们在**部分终端/字体**下占 **2 列**, 我们按 1 列算 ⇒ 整行可能
 * 超宽 1–2 列 ⇒ 终端**自动折行**多出一行 ⇒ Ink 的光标数学被打乱 ⇒ **整个底栏被重复打印**
 * (用户屏上同一条状态栏出现三份, 只有计时在变)。也正因为 `◎`/`↑` 不是每屏都有, 症状是"偶尔"。
 *
 * 口径: 这里把这些**我们确实用到的** Ambiguous 字符一律按 **2 列**算 (宁可短一列, 绝不超宽)。
 * 取的是**保守子集** —— 不追求覆盖全部 A 区, 只覆盖底栏/状态栏里会出现的那些; 新增符号时补进来。
 */
const AMBIGUOUS_AS_WIDE = new Set<string>([
  '·', '↑', '↓', '◎', '≈', '│', '─', '—', '↕', '§', '¶', '×', '÷', '±', '°', 'µ', '∞', '≠',
]);

/** 保守宽度: dispWidth + Ambiguous 字符每个再加 1 列 (即按 2 列算) */
export function dispWidthSafe(s: string): number {
  const plain = String(s || '');
  let extra = 0;
  for (const ch of plain) if (AMBIGUOUS_AS_WIDE.has(ch)) extra += 1;
  return dispWidth(plain) + extra;
}


/**
 * 底栏左段的**可用宽度预算** (2026-10-01)。
 * 不变量: 保守宽度(left) + 至少 1 格 + 保守宽度(title) ≤ width - 1
 * ⇒ 在任何终端字体下都不会因为"正好等于终端宽"而自动折行 (折行会让 Ink 光标数学错位,
 *   表现就是整块底栏被重复打印)。
 */
export function statusLineBudget(width: number, leftPlainWidth: number, notePlain: string, margin = 8): number {
  const room = width - 1 - dispWidthSafe(notePlain) - 1 - Math.max(0, leftPlainWidth) - margin;
  return Math.max(20, room);
}

/** 按**保守宽度**截断 (兜底: 即便有没登记进表的歧义字符, 也不会把行撑出终端) */
export function truncateSafe(s: string, maxWidth: number): string {
  const text = String(s || '');
  if (dispWidthSafe(text) <= maxWidth) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = dispWidthSafe(ch);
    if (w + cw > Math.max(0, maxWidth - 1)) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}


/** 画线字符的**保守**宽度 (U+2500 属 East Asian Width = Ambiguous ⇒ 部分终端按 2 列渲染) */
/**
 * 分界线默认字符 (2026-10-01, 用户报「输入框宽度变窄了」)。
 *
 * 上一版把 `─`(U+2500, East Asian Width = **Ambiguous**)按 **2 列**算字符数 ⇒ 在"真的按 2 列渲染"
 * 的终端上不折行了 ✓, 但线只剩**一半长** ✗ —— 用户看到的就是"输入框变窄"。
 * 两难: Ambiguous 字符的宽度**由终端决定**, 想既全宽又绝不折行, 只能用**宽度确定是 1 列**的字符。
 * **用户要的是好看**: 所以默认就用 `─` 且按 1 列算 ⇒ **满宽实线** ✓ (2026-10-01 用户明确: 「我不要这样的虚线」)。
 * 如果哪台终端的 `─` 是 2 列宽, 那它这种满宽线会折行 ⇒ 用 `BOLLOON_RULE_CHAR_WIDTH=2` 一键退回半宽。
 */
export function defaultRuleChar(): string {
  const env = String(process.env.BOLLOON_RULE_CHAR || '').trim();
  return env ? env.slice(0, 1) : '─';
}
export const RULE_CHAR_SAFE_WIDTH = dispWidthSafe(defaultRuleChar());

/**
 * 生成一条**保证不折行**的水平线 (2026-10-01)。
 *
 * 用户实测: 底栏那块(输入提示行 + 三条分界线)整块被**重复打印 4 次** ✗。
 * 根因: 分界线写的是 `'─'.repeat(W - 1)` —— `─`(U+2500) 是 **Ambiguous 宽度**:
 *   按 1 列算应该是 W-1 个, 但很多终端按 **2 列**渲染 ⇒ 整行变成 2×(W-1) 列 ✗✗
 *   ⇒ 超出终端宽 ⇒ 终端**自动折行** ⇒ Ink 光标数学错乱 ⇒ 整块反复重打。
 * 规矩: 一律按**保守宽度**(Ambiguous 当 2 列)算字符数 —— 宁可线短一点, 绝不超宽。
 *   另一端(终端真的按 1 列渲染)只会让线看起来短一半, 不会坏。
 */
export function ruleFor(width: number, char: string = defaultRuleChar()): string {
  // 2026-10-01 (用户: 「我不要这样的虚线」): 默认 `─` 且**按 1 列**算 ⇒ 满宽的实线 ✓
  //   代价: 某些终端把 `─`(Ambiguous) 渲染成 2 列 ⇒ 这种全宽线会超过终端宽、触发折行(底栏重复打印)。
  //   给那种机器留了一键开关:  BOLLOON_RULE_CHAR_WIDTH=2   ⇒ 按 2 列算(线短一半, 但不折行)。
  //   也可以换字符:      BOLLOON_RULE_CHAR=-
  const override = parseInt(String(process.env.BOLLOON_RULE_CHAR_WIDTH || ''), 10);
  const per = Math.max(1, Number.isFinite(override) && override > 0 ? override : 1);
  const cells = Math.max(2, Math.floor(Math.max(0, width) / per));
  return char.repeat(cells);
}
