/**
 * 思考记录的可视化 (2026-10-01, 用户: 「bolloon 智能体思考的记录可以也显示出来吗」)。
 *
 * 现状: 模型那边**是有**思考内容的 (deepseek 思考模式: `reasoning_content`, 非流式攒在
 *   `ChatResult.reasoningContent`, 流式在 delta 里累), 但只被用来回带(wire 协议要求), **没显示** ✗。
 * 规矩: 显示但要**可控** —— 默认开(用户要的), 能一键关(BOLLOON_SHOW_THINKING=0), 且有界(字符/行数封顶,
 *   免得思考本身把屏幕和上下文吃爆)。显示形态是**暗色块**并标明"思考(未验证)", 与正式回答区分开。
 */
export const REASONING_MAX_CHARS = 1500;
export const REASONING_MAX_LINES = 12;

/** 是否显示思考 (默认**开**; BOLLOON_SHOW_THINKING=0/false/off 关) */
export function shouldShowReasoning(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.BOLLOON_SHOW_THINKING ?? '').trim().toLowerCase();
  if (!v) return true;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** 归一化: 去掉多余空行; 无内容 ⇒ 空串 */
export function normalizeReasoning(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
    .filter((l, i, arr) => !(l.trim() === '' && (i === 0 || arr[i - 1].trim() === '')))
    .join('\n')
    .trim();
}

/**
 * 渲染成给终端的一段 (纯函数, 便于门测)。有界 + 标出被省略的量。
 * 返回空串 = 不该显示 (没内容/被关掉)。
 */
export function formatReasoningForDisplay(
  text: string,
  opts: { enabled?: boolean; maxChars?: number; maxLines?: number } = {},
): string {
  const enabled = opts.enabled ?? shouldShowReasoning();
  if (!enabled) return '';
  const clean = normalizeReasoning(text);
  if (!clean) return '';
  const maxChars = opts.maxChars ?? REASONING_MAX_CHARS;
  const maxLines = opts.maxLines ?? REASONING_MAX_LINES;
  let lines = clean.split('\n');
  let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); truncated = true; }
  let out = lines.join('\n');
  if (out.length > maxChars) { out = out.slice(0, maxChars); truncated = true; }
  return truncated ? `${out}\n…[思考已截断]` : out;
}
