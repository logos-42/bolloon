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
} as const;

export type ThemeToken = keyof typeof THEME;

/** '#c4d640' → '\x1b[38;2;196;214;64m' ANSI 前景色码 */
export function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
