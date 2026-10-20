/**
 * session-commands.ts — CLI 会话命令的纯逻辑 (可单测, 不带 I/O)
 *
 * 2026-10-20 新增: 给 CLI 补一组会话/上下文/信息命令 (/history /save /status
 * /context /usage /title /whoami /refine …)。所有**格式化与计算**放这里,
 * index.ts 只做接线 (读 agent/写盘/上屏)。判据与既有风格一致:
 *   只格式化, 不落盘; 落盘/读盘一律由调用方做。
 */

/** 消息最小形状 (来自 pi-sdk-types.Message, 只取需要的字段) */
export interface CliMsg {
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: string;
}

/** 去掉 ANSI 色码 (导出/摘要必须干净文本) */
export function stripAnsi(s: string): string {
  return String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** 单条消息的显示摘要 (一行, 截断到 maxChars) */
export function messageSummary(msg: CliMsg, maxChars = 160): string {
  const label = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
  const body = stripAnsi(msg.content || '').replace(/\s+/g, ' ').trim();
  const clipped = body.length > maxChars ? body.slice(0, maxChars) + '…' : body;
  return clipped ? `${label} ${clipped}` : `${label} (空)`;
}

/** /history [N] — 最近 N 条消息的文本 (默认 20, 上限 100) */
export function buildHistoryText(messages: CliMsg[], n = 20): { lines: string[]; shown: number; total: number } {
  const total = messages.length;
  const count = Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : 20, 100));
  const tail = messages.slice(-count);
  return { lines: tail.map((m) => messageSummary(m)), shown: tail.length, total };
}

/** /save — 会话导出文档 (md / json)。元数据只放标题与导出时间, 不碰消息本身 */
export function buildSaveDoc(
  messages: CliMsg[],
  format: 'md' | 'json',
  meta: { title?: string; sessionKey?: string; exportedAt?: string },
): string {
  const title = meta.title?.trim() || meta.sessionKey || 'bolloon-session';
  const exportedAt = meta.exportedAt || new Date().toISOString();
  if (format === 'json') {
    return JSON.stringify(
      { title, sessionKey: meta.sessionKey || null, exportedAt, messages: messages.map((m) => ({ role: m.role, content: m.content })) },
      null, 2,
    );
  }
  const rows = messages.map((m) => {
    const who = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 Bolloon' : `⚙️ ${m.role}`;
    return `### ${who}\n\n${stripAnsi(m.content || '').trim() || '(空)'}`;
  });
  return `# ${title}\n\n> 导出时间: ${exportedAt}\n\n${rows.join('\n\n')}\n`;
}

/** /title [名字] — 空参 = 只查看 (返回 set:null, 调用方显示当前); 有参 = 要写入的新标题 */
export function resolveTitleArg(arg: string): { set: string | null } {
  const t = String(arg || '').trim();
  if (!t) return { set: null };
  return { set: t.slice(0, 60) };
}

/** /context — 上下文用量格式化 */
export function formatContextUsage(usage: {
  usedTokens: number; maxTokens: number; pct: number; stage: string;
  lastCompressedAt?: number; lastSavedTokens?: number;
}): string {
  const k = (v: number) => `${Math.round(v / 1000)}k`;
  const pct = Math.round(usage.pct * 100);
  const stageText: Record<string, string> = {
    normal: '正常', warning: '⚠ 接近压缩阈值', compressing: '压缩中', compressed: '已压缩',
  };
  const last = usage.lastCompressedAt
    ? ` · 上次压缩 ${new Date(usage.lastCompressedAt).toLocaleTimeString()} (省 ${k(usage.lastSavedTokens || 0)})`
    : '';
  return `${k(usage.usedTokens)} / ${k(usage.maxTokens)} tokens (${pct}%) · ${stageText[usage.stage] || usage.stage}${last}`;
}

/** /status — 状态总览的行组装 (调用方给什么显示什么) */
export function formatStatusLines(parts: Array<[string, string]>): string[] {
  return parts.map(([k, v]) => `  ${k}: ${v}`);
}

/** /refine — 从会话尾部拼一段复盘输入 (≥40 字才值得审, 与 experience-review 口径一致) */
export function buildTurnSummary(messages: CliMsg[], maxChars = 2000): string {
  const tail = messages.slice(-12);
  const text = tail
    .map((m) => (m.role === 'user' ? `用户: ${m.content}` : m.role === 'assistant' ? `Bolloon: ${m.content}` : ''))
    .filter(Boolean)
    .join('\n')
    .slice(-maxChars);
  return text.trim();
}
