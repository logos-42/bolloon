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

/** 折叠阈值: ≥ 这么多行 或 ≥ 这么多字符 */
export const PASTE_MIN_LINES = 8;
export const PASTE_MIN_CHARS = 1200;

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
  const base: CollapsedPaste = { sendText: s, lines, chars: s.length, collapsed: false };
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
    return {
      sendText: `[粘贴 #${n}: ${lines} 行 → ${file}]\n(整段已存到上面这个文件 —— 需要看细节就 read_file 读它, 不用我重述)`,
      path: file,
      lines,
      chars: s.length,
      collapsed: true,
    };
  } catch {
    return base;
  }
}
