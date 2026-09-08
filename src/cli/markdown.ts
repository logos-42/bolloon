// ─── 内联 Markdown 分词渲染 (Hermes 学习 #4 之 MessageLine) ────────────────
//   把正文里的 `code` / **bold** / _italic_ / __underline__ 转成 ANSI 高亮,
//   供 renderUserMessage / renderAgentMessage 在出框前套用 (字节变长, dispWidth 剥 ANSI 不计宽).
//   仅内联分段; ```
//   多行代码块折叠/Thinking/ToolTrail 折叠 仍待续.

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const UNDER = '\x1b[4m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';

export function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c: string) => `${CYAN}${c}${R}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c: string) => `${BOLD}${c}${R}`)
    .replace(/__([^_]+)__/g, (_, c: string) => `${UNDER}${c}${R}`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, (_m, p: string, c: string) => `${p}${GREEN}${c}${R}`);
}
