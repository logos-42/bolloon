/**
 * tui-select.ts — 全屏可滚动光标选择器 + 掩码输入 (模型切换交互层, 2026-09-27)
 *
 * ## 为什么单列一个模块
 *
 * 分步选择器有七步 (供应商 → 凭证 → 模型 → 参数 → 作用域 → 测试 → 确认), 每一步都要"从候选里挑一个"。
 * 曾经每步各印一份清单再问序号, 于是:
 *   · 清单比终端高就"印满就没了" —— 用户看不到后面的项 (223 家目录就是这个规模);
 *   · 没有光标, 只能用眼睛找序号, 也没有高亮/颜色可辨认;
 *   · 七步各写一套渲染 = 七份会各自腐烂的代码。
 * 所以本模块提供**一个**选择器组件 + 一个掩码输入组件, 七步共用 (调用方只给候选与标题)。
 *
 * ## 六种同级的一等选择方式 (不是"主/次", 谁都别退化成脚本专用)
 *
 *   ① `↑` / `↓`  移动光标行 (行首 `→` + **accent 底/深色字**高亮), 到边上自动滚窗;
 *   ② `Enter`    确认当前光标行 (**落在分组标题上 = 展开/收起那一组**, 不会误选);
 *   ③ **数字跳行** 直接敲 `12` = 跳到第 12 行 (高亮当场跟过去, 状态行 `第 i/N` 同时变),
 *      多位数逐位收窄, 越界**说清范围**而不是静默不动;
 *   ④ **字母/`/` 筛选** 敲字符/`/` 进入过滤 (大小写不敏感, 匹配 id/名字/族), **命中项平铺** ——
 *      收起的分组也挡不住命中 (等价于"自动展开命中的那一组"); `Backspace` 逐字退, 空 = 回全量;
 *   ⑤ **分组折叠** `空格` 切换 / `←` 收起 / `→` 展开 —— 光标在哪一组就作用于哪一组
 *      (标题行上直接按也行); 收起的分组**只占一行且照写家数** (`── 未配置凭据 (200 家) ›`);
 *   ⑥ **滚动指示** 视窗上下边各一行 `↑ 上面还有 N 家` / `↓ 下面还有 N 家`; 视窗外的行**根本不画**。
 *
 * 取消: `Esc` / `Ctrl-C` 随时干净取消; 列表末尾还有一行 `Cancel` 可移动过去 + `Enter` 取消;
 * 查询为空时 `q` 也取消, 空格=折叠 (查询非空时 `q`/空格只是过滤字符 —— 否则"敲字筛"与快捷键会打架)。
 *
 * ## 为什么是"固定高度视窗 + 可折叠分组" (leo 2026-09-27 口径)
 *
 * 候选集是**全部家** (内置 + 自定义 + 整个目录 ≈ 233 家), 一屏画不完是必然的 ——
 * 但**不能靠藏家数来让页面放得下**: 中间候选区高度固定 (`min(12, 终端高-头尾)`),
 * 只画可见的那几行; 其余靠滚动/搜索/折叠消化。折叠只决定"画不画成员行",
 * 家数永远写在标题上, 搜索也一定搜得到 —— 折叠是可逆的排版, 不是隐藏。
 *
 * ## 符号 + 颜色**双通道** (leo 的要求: 不许只靠颜色)
 *
 * 语义全部先写在**符号/文字**里 (`●` 可用 / `○` 未配置 / `← 当前` / `special (需专用鉴权, 未支持)` /
 * `无基址 …` / `内置|自定义|目录`), 颜色只是加速扫视的第二通道 —— 且颜色**只有一个来源**:
 * `./theme.ts` 的 `THEME` token (与 Web UI 同一套 bolloon 色系), 本文件一个 hex 字面量都没有。
 * `NO_COLOR` / `TERM=dumb` / 非终端下关掉颜色也**仍然分得清** —— 有真终端字节的验收门钉住这两条。

 *
 * ## 降级 (三条路径, 都要能走)
 *
 *   · 真终端 + 有 raw mode → 本模块的全屏菜单;
 *   · 没有 raw mode / 终端太矮 / 显式 `BOLLOON_NO_TUI=1` → **退回数字文本问答** (由
 *     `model-selector.ts` 的 `printOptions` 那条路承担), 脚本仍可用;
 *   · 非 TTY (管道/重定向) → 清单 + 用法 dump, 不等待输入。
 *   本模块自己**不做任何降级决定**, 由调用方按 `tuiCapable()` 分流 —— 判据只有一处。
 *
 * ## 边界 (硬)
 *
 * 本模块**只产"用户选了哪个 value"**, 不读配置文件、不写配置文件、不碰模型运行时。
 * 写盘仍只有 `selectModel()` 一处 (见 `src/llm/model-selection.ts`)。
 * 掩码输入的值只活在内存里, 从不进屏幕/日志/报告 —— 屏幕上只有 `•` 与长度。
 */

import { THEME, fg, bg, colorEnabled, TONE_TOKEN, type Tone } from './theme.js';

// ============================================================
// ANSI 原语 (散落的转义码只在这里)
// ============================================================

const E = '\x1b';
const RESET = `${E}[0m`;
/** 反白 (当前光标行的高亮: 结构判据 + 无真彩时的兜底) */
const REVERSE = `${E}[7m`;
const BOLD = `${E}[1m`;
const HIDE_CURSOR = `${E}[?25l`;
const SHOW_CURSOR = `${E}[?25h`;
/** 从光标清到屏幕末 (重绘一帧的起点: 既真的清掉上一帧, 也是帧的分界) */
const ERASE_DOWN = `${E}[J`;
/** 清到行末 (每一行都用它, 免得窄终端里残留上一帧的长尾巴) */
const ERASE_EOL = `${E}[K`;

/**
 * 行色调 → bolloon 调色板 token (唯一颜色事实源是 `theme.ts`)。
 *
 * 颜色只是**第二通道**: 语义本体永远写在 label 的符号/文字里 (●/○/← 当前/special/无基址),
 * 所以 `NO_COLOR` / `TERM=dumb` / 非终端下关掉颜色, 信息一点都不丢。
 */
export type TuiTone = Tone;

/** 调子 → 前景 SGR。表**从 `theme.ts` 的 `TONE_TOKEN` 生成**, 这里不再写第二份映射。 */
const TONE: Record<TuiTone, string> = Object.fromEntries(
  (Object.keys(TONE_TOKEN) as Tone[]).map((t) => [t, t === 'plain' ? '' : fg(THEME[TONE_TOKEN[t]])]),
) as Record<TuiTone, string>;

/**
 * 光标行的高亮 SGR (2026-09-27 leo 口径: 切换界面上色, 别灰白; 三改: 对比要够)。
 *
 * 写法刻意是 **REVERSE + accent 底 + 近黑字**: 反白会把前景/底色互换, 于是实际渲染出来是
 * **accent 底 + `THEME.cursor` 近黑字** —— bolloon 主色块 + 深色字, 对比度 ~11:1。
 * (这里刻意不写那个 hex —— 本文件 hex 字面量必须为 0, 颜色只从 `theme.ts` 来。)
 * 为什么不直接 `bg(accent)`: 反白序列是**结构判据** (验收门靠 `ESC[7m…ESC[0m` 认"哪一行是高亮"),
 * 拿掉它等于把可核证据删了; 而且万一哪台终端吃掉 `7m`, 也还是"深字压主色块"能看清。
 * 无真彩时 (`color=false`) 整段不上, 只剩 `→ ` 前缀 —— 符号通道不依赖颜色。
 */
const CURSOR_SGR = `${REVERSE}${BOLD}${fg(THEME.cursor)}${bg(THEME.accent)}`;

/**
 * 帮助行 —— 每一种一等选择方式 + 折叠键 + 取消, 全都写出来 (leo 口径: 键位写进头行)。
 * 大清单靠"固定高度视窗 + 分组折叠"消化, 所以折叠/展开键必须与 ↑↓ 同权写在头行。
 */
export const TUI_HINT = '↑↓ 移动 · ←→/空格 折叠分组 · Enter 确认 · / 搜索 · 数字跳行 · Esc 取消';

/**
 * 纯平铺单选列表 (无分组) 的提示 —— 不带折叠键, 与参考的 provider 单选列表一致
 * (leo 2026-10-05: `bolloon model` 显示一直折叠不方便 → 供应商列表改纯平铺)。
 * 折叠键只在候选真的带分组 (有 `group` 字段) 时才出现在头行。
 */
export const TUI_HINT_FLAT = '↑↓ 移动 · Enter 确认 · / 搜索 · 数字跳行 · Esc 取消';

/** 掩码字符 (屏幕上绝不出现明文) */
export const MASK_CHAR = '•';

/**
 * 中间候选区的**固定高度上限** (每步可见行数上限; 实际视窗 = min(VIEWPORT_MAX, 终端高-头尾),
 * leo 2026-10-05: 「选择高度窗口要扩大」→ 从 12 提到 40, 高终端下一屏能看到更多家, 超出靠滚窗)。
 */
export const VIEWPORT_MAX = 40;

/** 分组收起的标记 (收起 = 只画标题 + 家数; 展开 = 标题 + 成员) */
export const GROUP_COLLAPSED_MARK = '›';
/** 分组展开的标记 */
export const GROUP_EXPANDED_MARK = '▾';


// ============================================================
// 颜色开关 (一处判据)
// ============================================================

/**
 * 输出流要不要上色。
 *
 * 三条判据, 缺一不可: ① 目标流是 TTY (管道里塞 ANSI 是污染, 脚本没法读);
 * ② `NO_COLOR` 非空 (这是公认约定: 只要设了就关色); ③ `TERM` 不是 `dumb`。
 * 拿不到 `isTTY` (某些宿主) 时按"不是终端"处理 —— 宁可不猜。
 */
export function ansiEnabled(out: NodeJS.WriteStream = process.stdout): boolean {
  return colorEnabled(!!out.isTTY);
}

/** 一个 tone 的着色函数 (不上色时原样返回) */
export function toneWrap(text: string, tone: TuiTone, color: boolean): string {
  if (!color || tone === 'plain' || !TONE[tone]) return text;
  return `${TONE[tone]}${text}${RESET}`;
}

// ============================================================
// 显示宽度 (CJK 双宽 / 组合符零宽) —— 窄终端不撑破靠它
// ============================================================

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/** 去掉 ANSI 转义 (算宽度前必须先去, 否则颜色码被当成可见字符) */
export function stripAnsi(s: string): string {
  return String(s ?? '').replace(ANSI_RE, '');
}

/** 一个 code point 占几列 (东亚宽 = 2; 组合符/零宽 = 0; 其余 = 1) */
function codePointWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;              // 组合用附加符
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;              // 变体选择符
  if (cp >= 0x1100 && cp <= 0x115f) return 2;              // 谚文字母
  if (cp >= 0x2e80 && cp <= 0x303e) return 2;              // CJK 部首/标点
  if (cp >= 0x3041 && cp <= 0x33ff) return 2;              // 假名/CJK 兼容
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2;              // CJK 扩展 A
  if (cp >= 0x4e00 && cp <= 0x9fff) return 2;              // CJK 统一表意
  if (cp >= 0xa000 && cp <= 0xa4cf) return 2;              // 彝文
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;              // 谚文音节
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;              // CJK 兼容表意
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;              // CJK 兼容形式
  if (cp >= 0xff00 && cp <= 0xff60) return 2;              // 全角形式
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;              // 全角符号
  if (cp >= 0x1f300 && cp <= 0x1f64f) return 2;            // emoji
  if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2;
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2;
  return 1;
}

/** 可见宽度 (先剥 ANSI; 宽字符按 2 算) */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += codePointWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * 按可见宽度截断到 `max` 列 (超了结尾放一个 `…`)。
 *
 * ⚠️ **本来就放得下时原样返回 `s`** (不 stripAnsi) —— 否则调用方刚上好的颜色/高亮会被这一句抹掉。
 * 真需要截断时返回的是**纯文本**截断结果 (颜色码不保留): 单行截断没法知道"该在哪儿把 SGR 补回来",
 * 与其截出一串半截转义码, 不如老实给出纯文本。所以**要保留颜色的行必须先按纯文本截好再上色**。
 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(s) <= max) return s;
  const plain = stripAnsi(s);
  const budget = Math.max(0, max - 1);
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 按可见宽度右填空格到 `width` (高亮行要铺满底色用); 只接受**纯文本** */
function padToWidth(plain: string, width: number): string {
  const w = displayWidth(plain);
  return w >= width ? truncateToWidth(plain, width) : plain + ' '.repeat(width - w);
}

// ============================================================
// 按键解析 (纯函数 —— 单测直接喂字节, 不用真终端)
// ============================================================

export type KeyEvent =
  | { type: 'up' } | { type: 'down' }
  | { type: 'left' } | { type: 'right' }
  | { type: 'pageup' } | { type: 'pagedown' }
  | { type: 'home' } | { type: 'end' }
  | { type: 'enter' } | { type: 'esc' } | { type: 'ctrl-c' } | { type: 'ctrl-d' }
  | { type: 'backspace' } | { type: 'tab' } | { type: 'ctrl-u' }
  | { type: 'char'; ch: string }
  /** 括号粘贴 (终端把整段粘贴包在 `\x1b[200~ … \x1b[201~` 里): 当作一串字符, **一个字节都不回显** */
  | { type: 'paste'; text: string }
  /** 触控板/鼠标滚轮 (SGR 上报): dy=+1 向上滚动, dy=-1 向下滚动 —— 在列表里等价于 ↑/↓ */
  | { type: 'wheel'; dy: 1 | -1 };

/** 已知的"多字节转义序列"前缀 —— 尾巴停在这些前缀上时先别当 Esc, 等下一块数据 */
const SEQ_PREFIXES = ['\x1b[', '\x1bO'];

function seqEvent(seq: string): KeyEvent | null {
  switch (seq) {
    case '\x1b[A': case '\x1bOA': return { type: 'up' };
    case '\x1b[B': case '\x1bOB': return { type: 'down' };
    case '\x1b[D': case '\x1bOD': return { type: 'left' };    // ← 收起光标所在分组
    case '\x1b[C': case '\x1bOC': return { type: 'right' };   // → 展开光标所在分组
    case '\x1b[5~': return { type: 'pageup' };
    case '\x1b[6~': return { type: 'pagedown' };
    case '\x1b[H': case '\x1b[1~': case '\x1bOH': return { type: 'home' };
    case '\x1b[F': case '\x1b[4~': case '\x1bOF': return { type: 'end' };
    default: return null;
  }
}

/**
 * SGR 鼠标上报的滚轮码 (触控板两指滚动 / 鼠标滚轮)。
 * 序列形如 `\x1b[<状态码;列;行M` (按下) 或 `…m` (释放, 滚轮无释放)。状态码 = 基准 + 修饰位：
 *   · 64 = 滚轮上 / 65 = 滚轮下 (卷滚类没有"行坐标", 但上报仍带; 我们只用方向)
 *   · 滚轮方向键 (向上滚 = 看更早内容 ⇒ 等价 ↑; 向下滚 = 看更后内容 ⇒ 等价 ↓)
 * 注意: 只有卷滚状态码 (64-67) 会持续滚动期间反复出现; 按下类 (0-2) 是点击, 由调用方忽略。
 */
export function wheelFromSgr(code: number): { dy: 1 | -1 } | null {
  if (code === 64) return { dy: 1 };   // 滚轮上 → 列表往上滚 (等价 ↑)
  if (code === 65) return { dy: -1 };  // 滚轮下 → 列表往下滚 (等价 ↓)
  return null;                          // 其它码 (左/中/右键、平移) 不当作滚动
}

/**
 * 把一块输入拆成按键事件。**返回的 `rest` 是"还没凑齐的尾巴"** —— 调用方留着与下一块拼。
 *
 * 为什么要有 `rest`: 真终端里 `\x1b`(Esc) 与 `\x1b[B`(↓) 是**同一段前缀**。一块数据刚好停在 `\x1b`
 * 上时, 不能立刻当成 Esc (那会把方向键拆成"取消 + [B"两个键)。所以尾巴是完整序列前缀就先留着,
 * 由调用方的超时把"孤独的 Esc"补成真 Esc。
 */
export function parseKeys(chunk: string, rest = ''): { events: KeyEvent[]; rest: string } {
  let buf = rest + chunk;
  const events: KeyEvent[] = [];
  while (buf.length) {
    // 括号粘贴: 整段取出, 一个字都不回显 (只记长度)
    if (buf.startsWith('\x1b[200~')) {
      const end = buf.indexOf('\x1b[201~');
      if (end < 0) { buf = buf.slice('\x1b[200~'.length); continue; }
      events.push({ type: 'paste', text: buf.slice(6, end) });
      buf = buf.slice(end + '\x1b[201~'.length);
      continue;
    }
    if (buf.startsWith('\x1b')) {
      // SGR 鼠标上报 (触控板/鼠标滚轮): `\x1b[<状态码;列;行M`(按下) 或 `…m`(释放)。
      //   状态码前有个 `<`, 通用 `ESC[ 参数 终字符` 正则会把它吞掉, 所以要在这里单独吃。
      //   只把滚轮 (64/65) 转成 `wheel` 事件; 点击/平移 (0-2 等) 就此忽略 —— 用户只要滚动翻列表。
      if (buf.startsWith('\x1b[<')) {
        const sm = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
        if (sm) {
          const w = wheelFromSgr(Number(sm[1]));
          if (w) events.push({ type: 'wheel', dy: w.dy });
          buf = buf.slice(sm[0].length);
          continue;
        }
        // `\x1b[<` 或 `\x1b[<64` 这种不完整尾巴: 等下一块拼全 (别把数字当输入)
        if (/^\x1b\[<[0-9;]*$/.test(buf)) break;
        buf = buf.slice(1);
        continue;
      }
      // 尽量吃掉一个完整转义序列: ESC [ 参数 终字符 / ESC O 字符
      const m = /^\x1b\[([0-9;]*)([a-zA-Z~])/.exec(buf) || /^\x1b(O.)/.exec(buf);
      if (m) {
        const ev = seqEvent(m[0]);
        if (ev) events.push(ev);
        buf = buf.slice(m[0].length);
        continue;
      }
      if (SEQ_PREFIXES.some((p) => p.startsWith(buf) || buf.startsWith(p))) {
        // `\x1b` / `\x1b[` / `\x1bO` 这种前缀: 等下一块
        if (buf.length <= 2 && SEQ_PREFIXES.some((p) => p.startsWith(buf))) break;
        buf = buf.slice(1);          // 认不出来的序列: 丢掉 ESC 本身, 不把后续字符当输入
        continue;
      }
      // 后面已经是普通字符 → 这是一个"孤独的 Esc"
      events.push({ type: 'esc' });
      buf = buf.slice(1);
      continue;
    }
    const ch = buf[0];
    buf = buf.slice(1);
    if (ch === '\r' || ch === '\n') events.push({ type: 'enter' });
    else if (ch === '\x03') events.push({ type: 'ctrl-c' });
    else if (ch === '\x04') events.push({ type: 'ctrl-d' });
    else if (ch === '\x7f' || ch === '\x08') events.push({ type: 'backspace' });
    else if (ch === '\t') events.push({ type: 'tab' });
    else if (ch === '\x15') events.push({ type: 'ctrl-u' });
    else if (ch === '\x1b') events.push({ type: 'esc' });
    else if (ch.codePointAt(0)! < 0x20) { /* 其余控制字符: 忽略 */ }
    else events.push({ type: 'char', ch });
  }
  return { events, rest: buf };
}

/** 尾巴是不是"只差一块数据的转义前缀" (是的话不能立刻当成 Esc) */
function tailIsEscapePrefix(rest: string): boolean {
  if (!rest.startsWith('\x1b')) return false;
  // SGR 鼠标尾巴 (`\x1b[<`, `\x1b[<64`, …): 是不完整的上报序列, **不是**孤独 Esc —— 等完整 `…M/m` 来
  //   再解析成滚轮/忽略。若 30ms 后仍不完整, 丢弃即可 (鼠标上报被终端自己保证成块到达)。
  if (rest.startsWith('\x1b[<')) return true;
  return SEQ_PREFIXES.some((p) => p.startsWith(rest) || rest.startsWith(p));
}

// ============================================================
// 终端能力判定 (只有一处)
// ============================================================

export const MIN_ROWS = 6;

/**
 * 能不能用全屏菜单。判据全在这里, 别的文件不许再各判一次:
 *   · stdin/stdout 都是 TTY (管道/重定向 → 走 dump 或文本问答);
 *   · stdin 有 `setRawMode` (没有 raw mode 就拿不到逐键输入, 退回文本问答);
 *   · 终端高度 ≥ `MIN_ROWS` (太矮画不出菜单 —— 退回文本问答, 而不是画个畸形的);
 *   · `TERM` 不是 `dumb`; `BOLLOON_NO_TUI=1` 时强制退回 (给"无 curses 降级"留一条可测的路)。
 */
export function tuiCapable(): boolean {
  if (process.env.BOLLOON_NO_TUI === '1') return false;
  if (String(process.env.TERM || '').toLowerCase() === 'dumb') return false;
  const sin: any = process.stdin;
  const sout: any = process.stdout;
  if (!sin?.isTTY || !sout?.isTTY) return false;
  if (typeof sin.setRawMode !== 'function') return false;
  const rows = Number(sout.rows || 0);
  if (rows && rows < MIN_ROWS) return false;
  return true;
}

/** 终端尺寸 (拿不到就给保守默认值; `cols` 小于 20 不可信, 按 80 处理) */
function termSize(out: NodeJS.WriteStream, override?: { cols?: number; rows?: number }): { cols: number; rows: number } {
  const c = Number(override?.cols ?? (out as any).columns ?? 80);
  const r = Number(override?.rows ?? (out as any).rows ?? 24);
  return { cols: c >= 20 ? Math.floor(c) : 80, rows: r >= MIN_ROWS ? Math.floor(r) : 24 };
}

// ============================================================
// raw 会话 (逐键输入 + 隐藏光标 + 一定恢复)
// ============================================================

interface KeyHandler { (k: KeyEvent): void }

class RawSession {
  private rest = '';
  private timer: NodeJS.Timeout | null = null;
  private dataFn: ((chunk: string) => void) | null = null;
  private resizeFn: (() => void) | null = null;
  private closed = false;
  private readonly stdin: any;
  private readonly stdout: NodeJS.WriteStream;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdin = process.stdin as any;
    this.stdout = stdout;
  }

  open(onKey: KeyHandler, onResize?: () => void): void {
    this.stdin.setRawMode(true);
    this.stdin.resume();
    try { this.stdin.setEncoding('utf8'); } catch { /* 有的宿主不给设, 不影响 */ }
    this.dataFn = (chunk: string) => {
      const { events, rest } = parseKeys(chunk, this.rest);
      this.rest = rest;
      for (const ev of events) onKey(ev);
      // 尾巴停在转义前缀上: 给 30ms 凑齐, 凑不齐就把"孤独的 Esc"补出去
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (tailIsEscapePrefix(this.rest)) {
        this.timer = setTimeout(() => {
          const lone = this.rest;
          this.rest = '';
          this.timer = null;
          if (lone) onKey({ type: 'esc' });
        }, 30);
      }
    };
    this.stdin.on('data', this.dataFn);
    if (onResize) {
      this.resizeFn = onResize;
      process.on('SIGWINCH', this.resizeFn);
    }
    // 开 SGR 鼠标上报 (触控板/滚轮) —— 让终端把两指滚动当成 `\x1b[<64|65;…` 发进来,
    //   `?1006h` = SGR 坐标格式, `?1000h` = 按下/释放事件。关闭时还原 (`close`)。
    this.write(`${E}[?1006h${E}[?1000h`);
    this.write(HIDE_CURSOR);
  }

  write(s: string): void { this.stdout.write(s); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dataFn) this.stdin.removeListener('data', this.dataFn);
    if (this.resizeFn) process.removeListener('SIGWINCH', this.resizeFn);
    // 还原鼠标上报 + 显示光标 (退出后触控板/鼠标回到终端自己的行为: 能划选文本、能正常右键)
    try { this.write(`${E}[?1000l${E}[?1006l`); } catch { /* 已关闭 */ }
    this.write(SHOW_CURSOR);
    try { this.stdin.setRawMode(false); } catch { /* 已恢复 */ }
    try { this.stdin.pause(); } catch { /* 无所谓 */ }
  }
}

// ============================================================
// 全屏可滚动菜单
// ============================================================

export interface TuiChoice {
  value: string;
  /** 已含状态符号的行文字 (符号由调用方给 —— 语义本体, 不许只靠颜色) */
  label: string;
  hint?: string;
  /** 分组标题 (同一个分组只印一次; 目录家很多, 靠它分段) */
  group?: string;
  tone?: TuiTone;
  /** 这一项等于"取消" (列表末尾的 Cancel 行) */
  cancel?: boolean;
  /**
   * 这一项所在分组**默认收起** (每组的第一个候选给一次就够)。
   *
   * 收起的分组在屏幕上只占**一行**: `── 名字 (208) ›` —— **家数照写**, 只是成员行不画。
   * 233 家靠"固定高度视窗 + 可折叠分组"消化, **不是靠把家从候选集里藏掉**:
   * 折叠只影响画不画, 不影响它在不在列表里、能不能搜到、能不能用数字跳过去。
   */
  groupCollapsed?: boolean;
}

export interface TuiSelectOptions {
  /** 计数单位 (供应商 = '家', 其余 = '项') */
  unit?: string;
  /** 初始光标落点 (按 value; 命中不了就停在第一行候选) */
  initialValue?: string;
  cancelLabel?: string;
  color?: boolean;
  out?: NodeJS.WriteStream;
  /** 尺寸覆盖 (窄终端验收用; 不传就真读终端) */
  cols?: number;
  rows?: number;
}

/**
 * 一行"**光标能落的行**": 分组标题 或 候选项。
 *
 * 光标走的是"行", 所以 **↑↓ / 数字跳选 / 第 i/N 都按行算** —— 分组标题是一等行 (能在上面按空格展开),
 * 收起的分组只留标题行, 成员行**根本不渲染** (不是画完再滚出屏幕)。
 */
export type DisplayLine =
  | { kind: 'sep'; group: string; count: number; collapsed: boolean }
  | { kind: 'item'; item: TuiChoice; itemIndex: number };

/** 过滤: 大小写不敏感, 匹配 value(id) / label(名字+状态) / hint / group(族) */
export function matchesQuery(item: TuiChoice, query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [item.value, item.label, item.hint || '', item.group || ''].join('\n').toLowerCase();
  return hay.includes(q);
}

/**
 * 把候选行摊成"可画/可落"的行 (**纯函数** —— 单测与验收门都能直接喂它复核)。
 *
 * 三条规矩:
 *   ① 有搜索词时**平铺命中项**: 不画分组标题, 也不受任何分组收起状态影响 ——
 *      搜索结果被折叠挡住是最气人的事, 所以命中项一律可见 (等价于"自动展开命中的那一组");
 *   ② 无搜索词时按分组分段: 每个分组一行标题 (`── 名字 (N) ›|▾`, **家数永远照写**),
 *      收起的分组不画成员行 (这就是"只画可见的 N 行"的出处);
 *   ③ 无分组的候选项 (模型/参数/作用域那些步骤) 原样逐行出 —— 行为与从前一致。
 */
export function buildDisplayLines(items: TuiChoice[], collapsed: Set<string>, query: string): DisplayLine[] {
  const lines: DisplayLine[] = [];
  if (String(query || '').trim()) {
    items.forEach((item, itemIndex) => lines.push({ kind: 'item', item, itemIndex }));
    return lines;
  }
  const counts = new Map<string, number>();
  for (const it of items) if (it.group) counts.set(it.group, (counts.get(it.group) || 0) + 1);
  let lastGroup: string | undefined;
  items.forEach((item, itemIndex) => {
    const g = item.group;
    if (g && g !== lastGroup) {
      const isCollapsed = collapsed.has(g);
      lines.push({ kind: 'sep', group: g, count: counts.get(g) || 0, collapsed: isCollapsed });
      lastGroup = g;
    }
    if (g && collapsed.has(g)) return;      // 收起: 只留标题行, 成员行不渲染
    if (item.cancel) { lines.push({ kind: 'item', item, itemIndex }); return; }
    lines.push({ kind: 'item', item, itemIndex });
  });
  return lines;
}

/** 视窗高度: 中间候选区**固定高度** = min(12, 终端高 - 头尾各一行) —— 超出的行根本不画 */
export function viewportHeight(rows: number): number {
  return Math.max(3, Math.min(VIEWPORT_MAX, Math.max(0, rows - 3)));
}


/**
 * 全屏光标选择器。返回选中项的 `value`; `null` = 取消
 * (Esc / Ctrl-C / `q`(查询为空时) / 末尾 Cancel 行 / 输入流结束)。
 *
 * 屏幕上永远只有: 头行(标题+计数+键位) · **固定高度视窗内的可见行** · 状态行。
 * 视窗外的行**根本不画** (不是画完再滚出屏幕); 上下边各有一行"还有 N 家"的滚动指示,
 * 让人知道"没画完"而不是"没有"。分组标题可折叠: 收起的分组只占一行且照写家数。
 */
export function tuiSelect(
  choices: TuiChoice[],
  title: string,
  opts: TuiSelectOptions = {},
): Promise<string | null> {
  if (!choices.length) return Promise.resolve(null);
  const out = opts.out ?? process.stdout;
  const color = opts.color ?? ansiEnabled(out);
  const unit = opts.unit ?? '项';

  const real = choices.filter((c) => !c.cancel);
  const cancelRow: TuiChoice = {
    value: '__cancel__',
    label: opts.cancelLabel ?? 'Cancel',
    hint: '取消本次切换 (不改动任何配置)',
    tone: 'warn',
    cancel: true,
  };

  let query = '';
  let cursor = 0;                 // 光标**行**号 (下标进 lines: 分组标题行也算一行)
  let scrollTop = 0;
  let note = '';                  // 非法输入/提示 (状态行里说清为什么)
  let numBuf = '';                // 数字跳行的累计缓冲 (多位数)
  let rendered = 0;               // 上一帧写了几行 (重绘时向上回退这么多行)
  let first = true;
  let done = false;

  // ★ 分组折叠状态 (候选集本身**不动**): 默认从候选的 `groupCollapsed` 标记来
  //   (第 1 步的"未配置凭据 / 需专用鉴权 / 无基址"三组默认收起), 用户按键只改这一份。
  const collapsed = new Set<string>();
  for (const c of real) if (c.group && c.groupCollapsed) collapsed.add(c.group);

  /** 当前该画/该落哪些行 (过滤 → 折叠 → 摊行, 全在纯函数里) */
  const linesOf = (): DisplayLine[] =>
    buildDisplayLines([...real.filter((c) => matchesQuery(c, query)), cancelRow], collapsed, query);

  /** 落在第一行**候选**上 (跳过分组标题 —— 标题是折叠手柄, 不是默认落点) */
  const firstItemRow = (ls: DisplayLine[]): number => {
    const i = ls.findIndex((l) => l.kind === 'item');
    return i >= 0 ? i : 0;
  };

  if (opts.initialValue) {
    const ls = linesOf();
    const i = ls.findIndex((l) => l.kind === 'item' && l.item.value === opts.initialValue);
    cursor = i >= 0 ? i : firstItemRow(ls);
  } else {
    cursor = firstItemRow(linesOf());
  }

  /** 光标所在行 (越界时钳回最后一行) */
  const cursorLine = (ls: DisplayLine[]): DisplayLine | undefined => ls[Math.max(0, Math.min(cursor, ls.length - 1))];

  /** 光标当前所属的分组名 (标题行 → 自己; 候选行 → 它那一组; 没有 → undefined) */
  const groupAtCursor = (ls: DisplayLine[]): string | undefined => {
    const l = cursorLine(ls);
    if (!l) return undefined;
    return l.kind === 'sep' ? l.group : l.item.group;
  };

  /**
   * 展开/收起"光标所在的那一组"。收起后把光标**停在该分组的标题行**上 ——
   * 光标永远站在看得见的行上 (收起的那一瞬间原候选行就没了, 不挪光标等于把光标画丢)。
   */
  const setGroupCollapsed = (g: string, want: boolean): void => {
    if (want === collapsed.has(g)) { note = want ? `${g} 已经是收起的` : `${g} 已经是展开的`; return; }
    if (want) collapsed.add(g); else collapsed.delete(g);
    const after = linesOf();
    const at = after.findIndex((l) => (l.kind === 'sep' ? l.group === g : l.item.group === g));
    if (at >= 0) cursor = at;
    const sep = after.find((l) => l.kind === 'sep' && l.group === g);
    const count = sep && sep.kind === 'sep' ? sep.count : 0;
    note = want
      ? `已收起 ${g} (${count} ${unit}) — 空格/→ 可再展开`
      : `已展开 ${g} (${count} ${unit})`;
  };

  const render = (): void => {
    const { cols, rows } = termSize(out, opts);
    const H = viewportHeight(rows);                     // 固定高度视窗 (≤12 行)
    const lines = linesOf();
    const total = lines.length;
    if (cursor > total - 1) cursor = total - 1;
    if (cursor < 0) cursor = 0;

    // ── 定位视窗: 先把光标放进窗口, 再为"还有 N 家"指示行让位 (让位后可能再挤一次) ──
    let top = Math.max(0, Math.min(scrollTop, Math.max(0, total - H)));
    for (let pass = 0; pass < 4; pass++) {
      const above0 = top > 0;
      const below0 = top + H - (above0 ? 1 : 0) < total;
      const body0 = Math.max(1, H - (above0 ? 1 : 0) - (below0 ? 1 : 0));
      const start0 = top + (above0 ? 1 : 0);
      let nt = top;
      if (cursor < start0) nt = Math.max(0, cursor - (above0 ? 1 : 0));
      else if (cursor > start0 + body0 - 1) nt = cursor - body0 + 1 - (above0 ? 1 : 0);
      nt = Math.max(0, Math.min(nt, Math.max(0, total - H)));
      if (nt === top) break;
      top = nt;
    }
    scrollTop = top;
    const above = top > 0;
    const below = top + H - (above ? 1 : 0) < total;
    const body = Math.max(1, H - (above ? 1 : 0) - (below ? 1 : 0));
    const start = top + (above ? 1 : 0);

    // `已筛` = **命中筛选的家数** ——
    //   折叠是通用能力: 只在候选真的带分组时才出现在提示与状态里 (模型选择器现为纯平铺单选列表,
    //   不带分组 → 提示里不出现折叠键, 与参考图一致)。折叠机制仍保留给需要分组的调用方用。
    const filteredItems = real.filter((c) => matchesQuery(c, query)).length;
    const collapsedGroups = [...collapsed].filter((g) => real.some((c) => c.group === g));
    const hasGroups = real.some((c) => c.group);
    // 头行: 标题 + 计数 (共 N 家 · 已筛 M 家) + 键位提示 —— **不滚** (每帧都画)。
    //   提示按候选是否带分组裁剪: 无分组 (纯平铺) 时只给移动/确认/搜索/数字/Esc, 不带折叠键。
    const hint = hasGroups ? TUI_HINT : TUI_HINT_FLAT;
    const head = `${String(title).replace(/[::]\s*$/, '')} · 共 ${real.length} ${unit} · 已筛 ${filteredItems} ${unit}  ${hint}`;
    // 状态行: `第 i/N` 与 `筛选 "x"` 必须相邻 (既有验收门按这个形状钉"数字真的跟着动")
    const shownIdx = cursor + 1;
    const status = [
      `第 ${shownIdx}/${total}`,
      query ? `筛选 "${query}"` : '',
      query ? '命中平铺 (折叠不挡命中)' : '',
      !query && collapsedGroups.length ? `收起 ${collapsedGroups.length} 组` : '',
      note,
      query ? '' : 'q=取消',
    ].filter(Boolean).join(' · ');

    const buf: string[] = [];
    buf.push(`${first ? '' : `${E}[${rendered}A`}${ERASE_DOWN}`);
    // 头行: 先按纯文本截到宽度, 再上色 (顺序反了的话颜色码会被截断丢掉)
    buf.push(`${toneWrap(truncateToWidth(head, cols), 'accent', color)}${ERASE_EOL}\r\n`);
    if (above) buf.push(`${toneWrap(truncateToWidth(`  ↑ 上面还有 ${top} ${unit}`, cols), 'muted', color)}${ERASE_EOL}\r\n`);
    for (let i = 0; i < body; i++) {
      const line = lines[start + i];
      // 先算**纯文本**行内容并按宽度截断/补齐, 再决定怎么上色 —— 保证"颜色不被截断抹掉 + 不撑破"
      let plain = '';
      let tone: TuiTone = 'plain';
      if (line && line.kind === 'sep') {
        const mark = line.collapsed ? GROUP_COLLAPSED_MARK : GROUP_EXPANDED_MARK;
        // 分组标题**照写家数** (折叠 ≠ 藏家数): `── 未配置凭据 (200 家) ›`
        plain = `  ── ${line.group} (${line.count} ${unit}) ${mark}`;
        tone = 'muted';
      } else if (line) {
        const bodyText = `${line.item.label}${line.item.hint ? ` — ${line.item.hint}` : ''}`;
        plain = `  ${bodyText}`;
        tone = line.item.tone ?? 'plain';
      } else {
        continue;                                   // 窗口尾部没有行: **不画空行**
      }
      // ★ 光标行 (2026-09-27 三改: **光标在任意行类上都有明显选中态**)。
      //   leo 亲测报的正是"光标停在分组标题行上, 一行粉都没有" —— 那不是配色问题, 是**这一行类
      //   压根没进高亮分支**: 从前 `isCursor` 只在候选行那一支里算, 分组标题行 (sep) 永远是 false,
      //   于是光标站在标题上时屏上与"没选中"字节完全相同 (只有个 `  ` 前缀, 连 `→` 都没有)。
      //   现在: 判据只有一句 `start + i === cursor`, 与行类无关; 分组标题 / 普通项 / `special` /
      //   `无基址` / `← 当前` / `Cancel` 一律照此高亮。
      const isCursor = start + i === cursor;
      if (isCursor) {
        // `  ` 前导换成 `→ ` (两者都占 2 列, 补齐宽度不受影响) —— 符号通道在 NO_COLOR 下也分得清
        plain = `→ ${plain.slice(2)}`;
        // ★ 光标行: `→ ` 前缀 + **accent 底 / 近黑字** (见 CURSOR_SGR; 反白序列同时是结构判据)
        const padded = padToWidth(truncateToWidth(plain, cols), cols);
        buf.push(`${color ? `${CURSOR_SGR}${padded}${RESET}` : truncateToWidth(plain, cols)}${ERASE_EOL}\r\n`);
        continue;
      }
      buf.push(`${toneWrap(truncateToWidth(plain, cols), tone, color)}${ERASE_EOL}\r\n`);
    }
    if (below) buf.push(`${toneWrap(truncateToWidth(`  ↓ 下面还有 ${total - (start + body)} ${unit}`, cols), 'muted', color)}${ERASE_EOL}\r\n`);
    buf.push(`${toneWrap(truncateToWidth(status, cols), 'muted', color)}${ERASE_EOL}`);
    // 帧共 1(头) + (above?1:0) + body + (below?1:0) + 1(状态) ≤ 终端高度 行 (硬预算)
    rendered = 1 + (above ? 1 : 0) + body + (below ? 1 : 0);
    out.write(buf.join(''));
    first = false;
  };

  const finish = (value: string | null): void => {
    if (done) return;
    done = true;
    if (rendered > 0) out.write(`${E}[${rendered}A${ERASE_DOWN}`);
    resolve(value);
  };

  let resolve: (v: string | null) => void = () => { /* 立刻被赋值 */ };
  const promise = new Promise<string | null>((res) => { resolve = res; });

  const session = new RawSession(out);
  const onKey = (k: KeyEvent): void => {
    const maxIdx = linesOf().length - 1;
    const clampCursor = (): void => { cursor = Math.max(0, Math.min(cursor, linesOf().length - 1)); };
    switch (k.type) {
      case 'up': {
        if (cursor > 0) cursor--; else cursor = maxIdx;
        numBuf = ''; note = '';
        break;
      }
      case 'down': {
        if (cursor < maxIdx) cursor++; else cursor = 0;
        numBuf = ''; note = '';
        break;
      }
      // 触控板两指滚动 / 鼠标滚轮 (SGR 上报): 滚上=↑, 滚下=↓ —— 和方向键同一套移动逻辑
      case 'wheel': {
        if (k.dy === 1) { if (cursor > 0) cursor--; else cursor = maxIdx; }
        else { if (cursor < maxIdx) cursor++; else cursor = 0; }
        numBuf = ''; note = '';
        break;
      }
      case 'pageup': {
        cursor = Math.max(0, cursor - Math.max(1, Math.floor(viewportHeight(termSize(out, opts).rows) / 2)));
        numBuf = ''; note = '';
        break;
      }
      case 'pagedown': {
        cursor = Math.min(maxIdx, cursor + Math.max(1, Math.floor(viewportHeight(termSize(out, opts).rows) / 2)));
        numBuf = ''; note = '';
        break;
      }
      case 'home': cursor = 0; numBuf = ''; note = ''; break;
      case 'end': cursor = maxIdx; numBuf = ''; note = ''; break;
      // ── 折叠/展开 (leo 口径: `←` 收起 / `→` 展开 / `空格` 切换) ──
      case 'left': {
        const g = groupAtCursor(linesOf());
        if (g) setGroupCollapsed(g, true); else note = '这一行没有分组可收起';
        numBuf = '';
        break;
      }
      case 'right': {
        const g = groupAtCursor(linesOf());
        if (g) setGroupCollapsed(g, false); else note = '这一行没有分组可展开';
        numBuf = '';
        break;
      }
      case 'char': {
        const ch = k.ch;
        if (ch === '/' && query === '') {
          // `/` = 显式进入筛选 (输字同样即时筛; 这一条只是把"我要筛选"说明白)
          note = '筛选模式: 直接敲字即过滤 (Backspace 退字, 清空 = 回全量)';
          break;
        }
        if (ch === ' ' && query === '') {
          // 空格 = 折叠/展开光标所在分组 (搜索时它是**普通过滤字符**, 免得"搜带空格的词"没法打)
          const g = groupAtCursor(linesOf());
          if (g) setGroupCollapsed(g, !collapsed.has(g)); else note = '这一行没有分组可折叠';
          numBuf = '';
          break;
        }
        if (/[0-9]/.test(ch)) {
          // ★ 数字跳行: 逐位累计 (先 1 再 2 = 第 12 行), 高亮当场跟过去
          const next = `${numBuf}${ch}`;
          const n = Number(next);
          if (n >= 1 && n <= maxIdx + 1) {
            numBuf = next;
            cursor = n - 1;
            note = `已跳到第 ${n} 项`;
          } else if (numBuf === '' && ch === '0') {
            note = `✗ 序号从 1 开始 (没有第 0 项)`;
          } else {
            // 多位数越界 → 退化成"只有最后这一位"再试 (标准做法), 单个数越界就报范围
            const last = Number(ch);
            if (next.length > 1 && last >= 1 && last <= maxIdx + 1) {
              numBuf = ch; cursor = last - 1; note = `已跳到第 ${last} 项 (${next} 越界)`;
            } else {
              numBuf = ''; note = `✗ 序号 ${next} 超出范围 (这里只有 1~${maxIdx + 1} 项)`;
            }
          }
        } else if (ch === 'q' && query === '') {
          session.close(); finish(null); return;
        } else {
          // ★ 字母/文字 = 真筛选 (过滤后序号按新序重排, 命中项平铺 —— 收起的分组也挡不住命中)
          query += ch;
          numBuf = ''; note = '';
          cursor = firstItemRow(linesOf());
          scrollTop = 0;
        }
        break;
      }
      case 'paste': {
        query += k.text.replace(/[\r\n]+/g, ' ');
        numBuf = ''; note = '';
        cursor = firstItemRow(linesOf());
        scrollTop = 0;
        break;
      }
      case 'backspace': {
        if (query) { query = query.slice(0, -1); cursor = firstItemRow(linesOf()); scrollTop = 0; note = ''; }
        else if (numBuf) { numBuf = ''; note = ''; }
        else { note = '已在全量列表 (没有可退的筛选词)'; }
        break;
      }
      case 'ctrl-u': { query = ''; numBuf = ''; note = '筛选已清空 (回全量)'; cursor = firstItemRow(linesOf()); scrollTop = 0; break; }
      case 'enter': {
        const hit = linesOf()[cursor];
        if (!hit) { session.close(); finish(null); return; }
        // 落在分组标题上: Enter = 展开/收起 (它不是候选, 选不了 —— 所以不会"选了个标题"这种鬼事)
        if (hit.kind === 'sep') { setGroupCollapsed(hit.group, !hit.collapsed); clampCursor(); render(); return; }
        if (hit.item.cancel) { session.close(); finish(null); return; }
        session.close();
        finish(hit.item.value);
        return;
      }
      case 'esc': case 'ctrl-c': case 'ctrl-d': {
        session.close();
        finish(null);
        return;
      }
      default: break;
    }
    render();
  };

  session.open(onKey, () => { render(); });
  // 先把终端切进 raw (关掉 ONLCR 之类的输出后处理), 再画第一帧 —— 否则首帧的 `\r\n` 会被
  //   tty 驱动再插一个 `\r` (量到 `\r\r\n`), 而且"首帧之前"那段是唯一没有逐键能力的窗口。
  render();
  return promise;
}

// ============================================================
// 掩码输入 (API key 专用) + 普通行输入
// ============================================================

export interface MaskedInputOptions {
  /** 屏幕上的提示语前缀 (不许把 key 放进来) */
  prompt: string;
  /** 额外说明行 (状态/指纹/落盘位置 —— 由调用方给, 只含非明文事实) */
  note?: string;
  out?: NodeJS.WriteStream;
  color?: boolean;
  cols?: number;
  /** 掩码最多画几个 (太长的 key 只画前 N 个, 免得撑破行) */
  maskCap?: number;
}

/** 掩码输入的结果: `value` 只活在内存里; `eof` = 输入流结束/Ctrl-D/Esc/Ctrl-C */
export interface MaskedInputResult { value: string; eof: boolean; cancelled: boolean }

/**
 * 掩码输入 —— **API key 只能走这里**。
 *
 * 三条硬规矩:
 *   ① 屏幕上只出现 `•` 与长度, **明文一个字节都不回显** (也不进日志/报告);
 *   ② 粘贴整段也算输入 (括号粘贴标记被吃掉), 同样只画掩码;
 *   ③ 拿不到 raw mode 时**如实降级并说明** —— 交给调用方走 readline 隐藏输入, 绝不静默变成明文回显。
 */
export function tuiAskMasked(opts: MaskedInputOptions): Promise<MaskedInputResult> {
  const out = opts.out ?? process.stdout;
  const color = opts.color ?? ansiEnabled(out);
  const cap = opts.maskCap ?? 24;
  let value = '';
  let done = false;
  let resolve: (r: MaskedInputResult) => void = () => { /* 赋值于下方 */ };
  const promise = new Promise<MaskedInputResult>((res) => { resolve = res; });

  const line = (): string => {
    const n = displayWidth(value);
    const mask = MASK_CHAR.repeat(Math.min(n, cap)) + (n > cap ? `+${n - cap}` : '');
    return `${opts.prompt} [${mask}] ${n ? `(${n} 字符)` : '(还没输入)'}`;
  };

  const draw = (): void => {
    const { cols } = termSize(out, opts);
    out.write(`\r${truncateToWidth(line(), cols)}${ERASE_EOL}`);
  };

  const finish = (r: MaskedInputResult): void => {
    if (done) return;
    done = true;
    session.close();
    out.write('\r\n');
    resolve(r);
  };

  /** 掩码输入的按键处理: 只累加/退格, 屏幕上永远只有掩码 */
  const onKey = (k: KeyEvent): void => {
    switch (k.type) {
      case 'char': value += k.ch; draw(); break;
      case 'paste': value += k.text.replace(/[\r\n]+/g, ''); draw(); break;
      case 'backspace': value = value.slice(0, -1); draw(); break;
      case 'ctrl-u': value = ''; draw(); break;
      // 掩码规则: 方向键/Home/End 一律不动内容 (改 key 只能退格重打, 免得半截编辑出错)
      case 'enter': finish({ value: value.trim(), eof: false, cancelled: false }); break;
      case 'esc': case 'ctrl-c': finish({ value: '', eof: false, cancelled: true }); break;
      case 'ctrl-d': finish({ value: '', eof: true, cancelled: true }); break;
      default: break;
    }
  };

  if (opts.note) out.write(`${truncateToWidth(opts.note, termSize(out, opts).cols)}${ERASE_EOL}\r\n`);

  const session = new RawSession(out);
  session.open(onKey);
  draw();
  return promise;
}

export interface LineInputOptions {
  prompt: string;
  note?: string;
  defaultValue?: string;
  out?: NodeJS.WriteStream;
  color?: boolean;
  cols?: number;
}

/** 普通单行输入 (搜索词/温度那种); 同样回退行内重绘, 但**明文可见** (它不是秘密) */
export function tuiAskLine(opts: LineInputOptions): Promise<MaskedInputResult> {
  const out = opts.out ?? process.stdout;
  let value = '';
  let done = false;
  let resolve: (r: MaskedInputResult) => void = () => { /* 赋值于下方 */ };
  const promise = new Promise<MaskedInputResult>((res) => { resolve = res; });

  const draw = (): void => {
    const { cols } = termSize(out, opts);
    const tail = opts.defaultValue !== undefined && !value ? ` [${opts.defaultValue}]` : '';
    out.write(`\r${truncateToWidth(`${opts.prompt}${tail} ${value}`, cols)}${ERASE_EOL}`);
  };
  const finish = (r: MaskedInputResult): void => {
    if (done) return;
    done = true;
    session.close();
    out.write('\r\n');
    resolve(r);
  };
  /** 普通行的按键处理 (明文可见 —— 这条输入不是秘密) */
  const onKey = (k: KeyEvent): void => {
    switch (k.type) {
      case 'char': value += k.ch; draw(); break;
      case 'paste': value += k.text.replace(/[\r\n]+/g, ''); draw(); break;
      case 'backspace': value = value.slice(0, -1); draw(); break;
      case 'ctrl-u': value = ''; draw(); break;
      case 'enter': finish({ value: value.trim() || (opts.defaultValue ?? ''), eof: false, cancelled: false }); break;
      case 'esc': case 'ctrl-c': finish({ value: '', eof: false, cancelled: true }); break;
      case 'ctrl-d': finish({ value: '', eof: true, cancelled: true }); break;
      default: break;
    }
  };
  if (opts.note) out.write(`${truncateToWidth(opts.note, termSize(out, opts).cols)}${ERASE_EOL}\r\n`);
  const session = new RawSession(out);
  session.open(onKey);
  draw();
  return promise;
}

/** 掩码输入的自我描述 (进报告/日志/界面都只用这一句, 里面没有明文) */
export function maskSummary(value: string): string {
  const n = displayWidth(value);
  if (!n) return '(空)';
  return `${MASK_CHAR.repeat(Math.min(n, 8))} (${n} 字符)`;
}
