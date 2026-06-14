/**
 * Token Estimator — 4 字符 ≈ 1 token 的粗估
 *
 * 为什么不引 tiktoken 依赖:
 * - bolloon 默认 npm 用户, 引依赖增加 install 体积
 * - Claude Code 论文也指出: 精确 token 计数不是关键, 渐进压缩才是
 * - 4 字符/token 在中文/英文混合场景下误差约 ±20%, 对预算判定足够
 *
 * 失败静默: 任何异常 → 返回估算值 (不抛错)
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: Array<{ content: string; toolResult?: unknown; toolCall?: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil((m.content?.length || 0) / CHARS_PER_TOKEN);
    if (m.toolResult) {
      try {
        const s = typeof m.toolResult === 'string' ? m.toolResult : JSON.stringify(m.toolResult);
        total += Math.ceil(s.length / CHARS_PER_TOKEN);
      } catch { /* circular ref, ignore */ }
    }
    if (m.toolCall) {
      try {
        const s = typeof m.toolCall === 'string' ? m.toolCall : JSON.stringify(m.toolCall);
        total += Math.ceil(s.length / CHARS_PER_TOKEN);
      } catch { /* ignore */ }
    }
  }
  return total;
}

export function estimateStringTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}
