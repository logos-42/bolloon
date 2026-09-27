/**
 * theme.ts — bolloon TUI 主题 token (唯一颜色事实源)
 * 与 Web UI 一致: 主色 #c4d640, 文本 #d8d8c8, 警告 #f59e0b, 成功 #22c55e, 错误 #ef4444。
 * 组件一律引用 THEME.*, 不再散落 hex 字面量。后续可扩展皮肤/深色切换。
 */
export const THEME = {
  accent: '#c4d640',        // 主色 (bolloon 绿)
  text: '#d8d8c8',          // 正文
  muted: '#606058',         // 次要/暗层
  dim: '#909088',           // 更暗
  ok: '#22c55e',            // 成功
  error: '#ef4444',         // 错误
  warn: '#f59e0b',          // 警告
  border: '#3a3a36',        // 暗描边
  borderBright: '#8a8a7e',  // 对话框边框提亮
  /**
   * 光标行的**字色** (2026-09-27 三改: 压在 accent 底上的近黑, 对比度 ~11:1)。
   *
   * 原来压在 accent 底上是 `muted` (#606058) —— 对比只有 ~3.9:1, 在真终端里看着"灰糊糊一片",
   * 而且分组标题行当时**压根没进高亮分支** (leo 亲测: 光标停在标题上看不出选中)。
   * 光标是"你在哪儿"的唯一指示, 必须一眼看到: 底色 = `accent` (主色块), 字色 = 本 token (近黑)。
   * 仍然只有这一个色源 —— 组件里不许写第二份 RGB。
   */
  cursor: '#141410',        // 光标行字色 (accent 底上的近黑)
} as const;

export type ThemeToken = keyof typeof THEME;

/** '#c4d640' → '\x1b[38;2;196;214;64m' ANSI 前景色码 */
export function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * '#c4d640' → '\x1b[48;2;196;214;64m' ANSI **背景**色码 (2026-09-27)。
 *
 * 与 `fg()` 同一个调色板, 只换通道 —— 光标行要"accent 底色 + 深色字"就靠它,
 * 不许在组件里再写一份 RGB (散落 hex 是这条线的病根)。
 */
export function bg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

// ============================================================
// 语义调子 → token (2026-09-27)
// ============================================================

/**
 * 语义调子。TUI 全屏选择器与"七步主屏"共用这一张表 ——
 * 谁都不许再写第二份"什么调子用什么色" (那是 `theme.ts` 该管的唯一一件事)。
 */
export type Tone = 'ok' | 'warn' | 'dim' | 'accent' | 'plain' | 'muted' | 'text' | 'error';

/** 调子 → 调色板 token (唯一映射) */
export const TONE_TOKEN: Record<Tone, ThemeToken> = {
  accent: 'accent',   // 主色: 光标底色 / 标题 / ← 当前
  ok: 'ok',           // 成功 / ● 可用
  warn: 'warn',       // 警告: special (未支持) / 无基址 / 探测异常
  error: 'error',     // 错误: 输入非法 / 切换失败
  muted: 'muted',     // 提示 / 头行 / 分组标题
  dim: 'dim',         // 更暗: ○ 未配置凭据 / 次要脚注
  text: 'text',       // 正文
  plain: 'text',      // 无调子 = 正文
};

/**
 * 要不要上色 —— **唯一判据** (TUI 与主屏共用):
 *   ① 输出得是真终端; ② 没设 `NO_COLOR`; ③ `TERM` 不是 `dumb`。
 * 关掉颜色时**信息一点都不丢**: 所有语义都另有符号/文字 (●/○/→/›/▾/← 当前)。
 */
export function colorEnabled(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!isTTY && !env.NO_COLOR && env.TERM !== 'dumb';
}

/**
 * 给**一整行**套上调子的前景色 (主屏/选择器都走这里)。
 * `color === false` → 原样返回 (一个字节的 SGR 都不加)。
 */
export function tint(line: string, tone: Tone, color = true): string {
  if (!color) return line;
  return `${fg(THEME[TONE_TOKEN[tone] ?? 'text'])}${line}\x1b[0m`;
}
