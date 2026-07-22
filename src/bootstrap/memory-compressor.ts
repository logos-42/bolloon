/**
 * Memory Compressor — session 消息 → LLM 摘要 → ~/.bolloon/memory/<agentId>/sessions/
 *
 * 触发: 每次 /message 处理后, saveSession 之后 (server.ts:2073 之后)
 * 行为:
 *   - 读 session messages
 *   - 只压缩 cursor 之后的增量 (≥ 4 条新 messages 才压缩, 防频繁)
 *   - 调 LLM 生成中文摘要 (失败 fallback 到纯模板)
 *   - append 模式写入 <safe-channelId>__<safe-sessionId>.summary.md
 *   - 维护 cursor 文件 <safe-channelId>__<safe-sessionId>.cursor
 *
 * 失败静默: 调用方 try/catch 后 console.warn, 不阻塞主对话.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface MemoryCompressOptions {
  agentId: string;
  channelId: string;
  sessionId: string;
  home?: string;
  /** 触发压缩的最小新消息数 (默认 4) */
  minNewMessages?: number;
}

export interface MemoryCompressResult {
  summaryPath: string;
  cursorPath: string;
  messagesCount: number;
  bytesWritten: number;
  skipped?: 'no-new-messages' | 'too-few-messages' | 'error';
  error?: string;
}

export interface SessionMessageLite {
  type: 'user' | 'ai' | string;
  content: string;
  timestamp?: string;
}

export function sanitizeAgentId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function sanitizeKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128);
}

/**
 * ~/.bolloon/memory/<sanitizedAgentId>/
 */
export function getMemoryDir(agentId: string, home?: string): string {
  return path.join(home || os.homedir(), '.bolloon', 'memory', sanitizeAgentId(agentId));
}

/**
 * ~/.bolloon/memory/<agentId>/sessions/<safe-channelId>__<safe-sessionId>.summary.md
 */
export function getSessionSummaryPath(agentId: string, channelId: string, sessionId: string, home?: string): string {
  const key = `${sanitizeKey(channelId)}__${sanitizeKey(sessionId)}`;
  return path.join(getMemoryDir(agentId, home), 'sessions', `${key}.summary.md`);
}

export function getSessionCursorPath(agentId: string, channelId: string, sessionId: string, home?: string): string {
  const key = `${sanitizeKey(channelId)}__${sanitizeKey(sessionId)}`;
  return path.join(getMemoryDir(agentId, home), 'sessions', `${key}.cursor`);
}

/**
 * Session 缓存文件路径 (跟 server.ts:1806 sessionKey 规则一致)
 */
function getSessionCacheFile(channelId: string, sessionId: string, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'sessions', 'cache');
  const safeChannel = sanitizeKey(channelId);
  const safeSession = sanitizeKey(sessionId).replace(/:/g, '__');
  return path.join(root, `${safeChannel}__${safeSession}.json`);
}

async function readCursor(cursorPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(cursorPath, 'utf-8');
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursorPath: string, value: number): Promise<void> {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  await fs.writeFile(cursorPath, String(value), 'utf-8');
}

async function readSessionMessages(sessionCacheFile: string): Promise<SessionMessageLite[]> {
  try {
    const raw = await fs.readFile(sessionCacheFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.messages)) return parsed.messages;
    return [];
  } catch {
    return [];
  }
}

/**
 * 纯模板摘要 (LLM 失败 fallback, 不依赖外部调用)
 */
function templateSummary(opts: {
  channelId: string;
  sessionId: string;
  newMessages: SessionMessageLite[];
  timestamp: string;
}): string {
  const userMsgs = opts.newMessages.filter(m => m.type === 'user');
  const aiMsgs = opts.newMessages.filter(m => m.type === 'ai');
  const userSnippet = userMsgs.slice(0, 3).map(m => `  - ${m.content.slice(0, 80)}`).join('\n');
  const aiSnippet = aiMsgs.slice(0, 3).map(m => `  - ${m.content.slice(0, 80)}`).join('\n');
  return `# Session 摘要 — ${opts.channelId} / ${opts.sessionId}

时间: ${opts.timestamp}
新增消息数: ${opts.newMessages.length} (user=${userMsgs.length}, ai=${aiMsgs.length})

## 用户关键提问
${userSnippet || '  (无)'}

## AI 关键回答
${aiSnippet || '  (无)'}

## 备注
- 此摘要由模板生成 (LLM 调用失败 fallback)
`;
}

/**
 * 尝试调 LLM 生成更精炼的中文摘要. 失败 → 抛错, 由 caller fallback.
 *
 * 用动态 import + 失败静默 — 不引入 pi-ai 强依赖 (避免循环).
 */
async function tryLlmSummary(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const piAi = await import('../llm/pi-ai.js');
    const generateText = (piAi as any).generateText;
    if (typeof generateText !== 'function') throw new Error('generateText not exported');
    const result = await generateText({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 800,
    });
    const text = (result as any)?.reply || (result as any)?.text || '';
    if (typeof text !== 'string' || text.length < 20) throw new Error('LLM returned too-short text');
    return text;
  } catch (e: any) {
    throw new Error(`LLM call failed: ${e?.message || String(e)}`);
  }
}

export async function compressSessionToMemory(opts: MemoryCompressOptions): Promise<MemoryCompressResult> {
  const agentId = sanitizeAgentId(opts.agentId);
  const home = opts.home || os.homedir();
  const summaryPath = getSessionSummaryPath(agentId, opts.channelId, opts.sessionId, home);
  const cursorPath = getSessionCursorPath(agentId, opts.channelId, opts.sessionId, home);
  const sessionCacheFile = getSessionCacheFile(opts.channelId, opts.sessionId, home);

  const allMessages = await readSessionMessages(sessionCacheFile);
  const cursor = await readCursor(cursorPath);
  const newMessages = allMessages.slice(cursor);
  const minNew = opts.minNewMessages ?? 4;

  if (allMessages.length === 0) {
    return { summaryPath, cursorPath, messagesCount: 0, bytesWritten: 0, skipped: 'no-new-messages' };
  }
  if (newMessages.length < minNew) {
    return { summaryPath, cursorPath, messagesCount: newMessages.length, bytesWritten: 0, skipped: 'too-few-messages' };
  }

  const timestamp = new Date().toISOString();
  let summaryBody: string;

  try {
    const sysPrompt = '你是 bolloon 记忆压缩助手. 输入是一段 session 消息历史 (用户问题 + AI 回答), 输出 200-400 字中文摘要, 包含 3-5 条关键发现和未完成事项. 不要寒暄, 不要复述已知. 格式: ## 关键发现 / ## 待办.';
    const recentSnippet = newMessages.slice(-10).map(m => `[${m.type}] ${m.content}`).join('\n---\n').slice(0, 6000);
    const userPrompt = `Channel: ${opts.channelId}\nSession: ${opts.sessionId}\n时间: ${timestamp}\n新增消息数: ${newMessages.length}\n\n最近消息:\n${recentSnippet}`;
    summaryBody = await tryLlmSummary(sysPrompt, userPrompt);
  } catch (e: any) {
    summaryBody = templateSummary({
      channelId: opts.channelId,
      sessionId: opts.sessionId,
      newMessages,
      timestamp,
    });
  }

  const block = `\n\n---\n\n## 增量摘要 @ ${timestamp} (${newMessages.length} messages)\n\n${summaryBody.trim()}\n`;

  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.appendFile(summaryPath, block, 'utf-8');
  await writeCursor(cursorPath, allMessages.length);

  // 2026-07-22 设计 C: 废气采样 — 压缩成功 = 上下文需要压缩的信号, 记入涡轮 (隐式)
  //   废气不进 prompt, 只调参 (背压高 → judgment 注入收紧). 落 log/memory.
  try {
    const { recordExhaust } = await import('./exhaust-scrubber.js');
    recordExhaust({
      source: 'memory-compressor',
      reason: 'compress-summary-written',
      droppedTokens: newMessages.length * 200, // 粗估 200 tokens/msg
    }, opts.home).catch(() => { /* 静默 */ });
  } catch { /* 静默 */ }

  return {
    summaryPath,
    cursorPath,
    messagesCount: newMessages.length,
    bytesWritten: Buffer.byteLength(block, 'utf-8'),
  };
}