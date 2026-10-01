/**
 * 长输入/粘贴的"折叠" (2026-10-01, 用户: 「输入文本框有压缩吗…教给 bolloon」)。
 *
 * 学到并会照做的做法(研究得到的口径, 用自己的话写):
 *   ① 折叠的**产出** = 把整段写到一个文件 + 输入处留**一行短引用**(带 序号/行数/路径) ⇒ 输入框和对话流都不会被一大段糊满;
 *   ② 关键设计: 这个短引用**指向文件**, 需要细节时**读文件**就能拿到全文 ⇒ 效果上**无损**;
 *   ③ 阈值由**前端**决定(没有硬阈值约定) ⇒ 我取"≥8 行 或 ≥1200 字符"。
 * 顺带解决另一件事: 长用户消息不再整段躺在历史里 ⇒ 等价于"超长用户消息要精简"那条口径, 而且**在入口就收住**(比压缩时再精简更早 ✓)。
 *
 * 纪律: 只对**长输入**生效(短的一句不动 ✓) · 文件落 `~/.bolloon/pastes/`(0600 ✓) · 失败**绝不打断发送**(退化成原样发送 ✓)。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 折叠阈值。**按真实数据定的** (2026-10-01 实测: 用户的一次粘贴 = 479 + 137 两块的纯文本,
 * 旧阈值 8 行 / 1200 字符**两个都没到** ⇒ 不折叠 ⇒ 原文进输入框 ⇒ 里面 '/'/'@'/'#' 触发弹窗
 * ⇒ "没编号 + 有弹窗" 同一个根因 ✓)。
 * 新口径: **只要是多行(含换行)就折叠** ✓ —— 输入框里本来不可能有换行(回车即提交 ✓) ⇒ 含换行必是粘贴 ✓;
 *   单行则到 300 字符就折叠 ✓。Enter 本身是单个 '\n' ⇒ 但 `looksLikePasteChunk` 已按长度排除 ⇒ 不会误解 ✓。
 */
export const PASTE_MIN_LINES = 2;
export const PASTE_MIN_CHARS = 300;

export function pastesDir(home = os.homedir()): string {
  return path.join(home, '.bolloon', 'pastes');
}

export function pasteLineCount(text: string): number {
  return String(text ?? '').split('\n').length;
}

export function shouldCollapsePaste(text: string, opts: { minLines?: number; minChars?: number } = {}): boolean {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return pasteLineCount(s) >= (opts.minLines ?? PASTE_MIN_LINES) || s.length >= (opts.minChars ?? PASTE_MIN_CHARS);
}

export interface CollapsedPaste {
  /** **输入框里显示**的短引用 (只有一行, 不带解释) */
  inputText: string;
  /** 真正发给模型/落进对话流的文本 (短引用 + 取全文的指引) */
  sendText: string;
  /** 全文落盘位置 (失败时为空 ⇒ 调用方原样发送) */
  path?: string;
  lines: number;
  chars: number;
  collapsed: boolean;
}

/**
 * 把长输入折叠成"一行引用 + 文件路径"。写盘失败 ⇒ 原样返回(不打断用户) ✓。
 */
export function collapsePaste(
  text: string,
  opts: { home?: string; now?: Date; counter?: number; minLines?: number; minChars?: number } = {},
): CollapsedPaste {
  const s = String(text ?? '');
  const lines = pasteLineCount(s);
  const base: CollapsedPaste = { inputText: s, sendText: s, lines, chars: s.length, collapsed: false };
  if (!shouldCollapsePaste(s, opts)) return base;
  try {
    const home = opts.home || os.homedir();
    const dir = pastesDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const n = opts.counter ?? (() => {
      try { return fs.readdirSync(dir).filter((f) => f.startsWith('paste_')).length + 1; } catch { return 1; }
    })();
    const hhmmss = (opts.now || new Date()).toTimeString().slice(0, 8).replace(/:/g, '');
    const file = path.join(dir, `paste_${n}_${hhmmss}.txt`);
    fs.writeFileSync(file, s, { encoding: 'utf-8', mode: 0o600 });
    // 输入框那份**不能带 '@' '/' '#'** —— 它们会触发补全弹窗(实测: 粘贴后弹窗冒出来 ✗)。
    //   所以输入框只放"序号 + 行数"; **完整路径只出现在发送出去的那份**(sendText)里 ✓。
    const inputRef = `[粘贴 ${n} · ${lines} 行]`;
    const ref = `[粘贴 #${n}: ${lines} 行 → ${file}]`;
    return {
      inputText: inputRef,
      sendText: `${ref}\n(整段已存到上面这个文件 —— 需要看细节就 read_file 读它, 不用我重述)`,
      path: file,
      lines,
      chars: s.length,
      collapsed: true,
    };
  } catch {
    return base;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 粘贴"真实形态"处理 (2026-10-01, 用户连报三次「还是会有弹窗，无法进入输入框」后补)
//
// 教训: 我先前假设"一次粘贴 = 一个 chunk" ✗ —— 真实终端里至少两种形态会打脸:
//   ① **括号粘贴**: 终端把整段包在 `\x1b[200~ … \x1b[201~` 里 ⇒ 我的"含 ESC 就不当粘贴"直接放弃 ✗
//      ⇒ 原文进了输入框 ⇒ 里面的 '@'/'/'/'#' 触发补全弹窗 ⇒ 弹窗又把后续按键吃掉 ⇒ "无法进入输入框" ✗;
//   ② **逐行成块**: 多行粘贴可能一行一个 chunk ⇒ 每块都短 ⇒ 都不够折叠阈值 ✗。
// 对策: 先剥括号标记 ⇒ 再判断"像不像粘贴" ⇒ 把**一串**粘贴块**攒起来**(80ms 静默算一次粘贴结束) ⇒ 整段折叠 ✓;
//   并且在粘贴进行期间**抑制补全弹窗** ✓(粘进来的文本不该弹窗 ✓)。
// ─────────────────────────────────────────────────────────────────────────────

/** 括号粘贴标记 (终端自动加的, 必须剥掉再判断) */
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

export function stripBracketedPaste(text: string): string {
  return String(text ?? '').split(PASTE_START).join('').split(PASTE_END).join('');
}

export function hasBracketedPasteMarker(text: string): boolean {
  const s = String(text ?? '');
  return s.includes(PASTE_START) || s.includes(PASTE_END);
}

/** 一个 chunk 是否"像粘贴"(而不是手敲/方向键): 长、含换行、或带括号粘贴标记 */
export const PASTE_CHUNK_MIN_CHARS = 40;
export function looksLikePasteChunk(chunk: string): boolean {
  const s = String(chunk ?? '');
  if (!s) return false;
  // ⚠️ 2026-10-01 修正: **单个 \n 就是回车** —— 早先"含换行即粘贴"会把回车吞掉 ✗(Enter 提交不了 ✗)。
  //   现在: 长度够才算粘贴; 换行只在"已经够长"时作为辅助信号; 括号粘贴标记也要有实际内容。
  if (s.length >= PASTE_CHUNK_MIN_CHARS) return true;
  // 带括号粘贴标记 ⇒ 只要剥掉标记后**有内容**就是粘贴(标记只可能来自终端的粘贴路径 ✓)
  if (hasBracketedPasteMarker(s) && s.replace(/\u001b\[20[01]~/g, '').length > 0) return true;
  return false;
}

/** 攒块的静默窗口: 这么久没有新块 ⇒ 认为"这次粘贴结束了" */
export const PASTE_BURST_IDLE_MS = 80;


/**
 * 粘贴形态**观测** (有界, 只记形态不记正文) ⇒ `~/.bolloon/logs/input-chunks.jsonl`。
 * 为什么留它: 这次"弹窗/进不去输入框"连报三轮, 全靠**猜** chunk 形态 ✗ ⇒ 以后一眼能看出真实形态 ✓。
 * 纪律: best-effort(失败静默) · 只记 长度/有无括号标记/有无换行/有无 ESC · 上限 500 行(超了就重写)。
 */
export function logPasteChunk(info: { len: number; marker: boolean; nl: boolean; esc: boolean; tab?: boolean }, home = os.homedir()): void {
  try {
    const dir = path.join(home, '.bolloon', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'input-chunks.jsonl');
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').split('\n').length > 500) fs.writeFileSync(file, '', 'utf-8');
    } catch { /* 忽略 */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...info }) + '\n', 'utf-8');
  } catch { /* 观测失败绝不影响输入 */ }
}


/**
 * **输入框只能是单行** (2026-10-01, 用户: 「发送框也会分成好几行」)。
 * 为什么必须净化: Ink 的输入组件拿到带 `\n` 的值就会**撑成多行** ⇒ 底部输入栏被顶高、
 *   内容置顶的布局跟着抖 ✗。所以: 值进输入框之前一律把换行压成空格 ✓(原文照旧进文件/照旧发出去 ✓,
 *   只是**显示**单行 —— 显示单行不等于内容丢 ✓)。
 */
export function singleLine(text: string): string {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[\t]/g, ' ');
}


/**
 * 粘贴后**短暂封住补全弹窗**的判定 (2026-10-01, 按真实数据收尾)。
 * 实测: 一次粘贴是**一整块 762 字符纯文本** ✓(无括号标记/无换行) ⇒ 它的最后一个 token 只要以 '/' 开头,
 *   或含不在字母数字后面的 '@'/'#' ⇒ `getMention` 就会返回命中 ⇒ 弹窗 ⇒ **抢走输入焦点** ✗。
 * 双保险: ① 超长输入(>400 字符)本来就不该当 mention 来源 ✓; ② 粘贴后 **1.5 秒内** 一律不弹 ✓
 *   —— 封禁期一过(或用户手动敲键)立刻恢复, 免得影响正常的 '@'/'/'/'#' 补全 ✓。
 */
export const PASTE_MENTION_SHIELD_MS = 1500;
export const MENTION_MAX_INPUT_CHARS = 400;

export function shouldSuppressMention(input: string, shieldUntil: number, now = Date.now()): boolean {
  if (String(input ?? '').length > MENTION_MAX_INPUT_CHARS) return true;
  return Number(shieldUntil || 0) > now;
}
