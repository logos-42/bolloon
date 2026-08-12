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
  /** 'user' | 'ai' — 兼容读取: SessionStore 存的是 role ('user'/'assistant'), 老格式是 type */
  type: 'user' | 'ai' | string;
  content: string;
  timestamp?: string;
}

/** 统一消息字段: SessionStore (session-store.ts) 用 role, 老 cache 格式用 type. 读成 SessionMessageLite. */
function toLite(m: any): SessionMessageLite {
  const raw = m && typeof m === 'object' ? m : { content: String(m ?? '') };
  let type: string = raw.type ?? raw.role ?? '';
  if (type === 'assistant') type = 'ai';
  if (type === 'system' || type === 'tool') type = 'system';
  return {
    type: type || 'unknown',
    content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? ''),
    timestamp: raw.timestamp || raw.createdAt,
  };
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
export function getSessionCacheFile(channelId: string, sessionId: string, home?: string): string {
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
    const list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.messages) ? parsed.messages : [];
    // 2026-08-06: 统一 role/type 字段 (SessionStore 写 role, 老格式写 type), 过滤空壳消息
    return list.map((m) => toLite(m)).filter(m => m.type !== 'unknown' && m.content);
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
 * 2026-08-06 修复: 之前调用不存在的 pi-ai.generateText → 100% 抛错 → 永远模板 fallback.
 * 改用真实接口 getMinimax().chat(userMsg, systemPrompt) (pi-ai.ts 导出的 PiAIModel).
 * 用动态 import + 失败静默 — 不引入 pi-ai 强依赖 (避免循环).
 */
async function tryLlmSummary(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const piAi = await import('../llm/pi-ai.js');
    const getMinimax = (piAi as any).getMinimax;
    if (typeof getMinimax !== 'function') throw new Error('getMinimax not exported');
    const llm = getMinimax();
    if (!llm || typeof llm.chat !== 'function') throw new Error('LLM chat not available');
    const result = await llm.chat(userPrompt, systemPrompt);
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
    // 2026-08-03 (Context OS P4): 摘要 prompt 要求输出"价值点"段 — 供收尾路由入库 judgeness
    const sysPrompt = '你是 bolloon 记忆压缩助手. 输入是一段 session 消息历史 (用户问题 + AI 回答), 输出 200-400 字中文摘要, 包含 3-5 条关键发现和未完成事项. 不要寒暄, 不要复述已知. 格式: ## 关键发现 / ## 待办. 最后单独输出 ## 价值点 段: 0-3 行, 每行 `- (类型) 一句话内容`, 类型 ∈ decision|lesson|knowledge|insight (decision=做出了什么决定; lesson=哪里出错下次怎么避免; knowledge=修正了什么认知; insight=改变了判断的洞察). 没有就写 `- (无)`';
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

  // 2026-08-08 (DID 目录写穿): 摘要同步进 DID 目录 memory 表 — WAL 事件 → 多设备同步/OrbitDB 复制.
  //   失败静默: 目录不可用不影响原磁盘写入.
  try {
    const { catalogUpsertQuiet } = await import('../storage/did-catalog-bridge.js');
    await catalogUpsertQuiet('memory', `sessions/${agentId}/${path.basename(summaryPath)}`, {
      agentId,
      channelId: opts.channelId,
      sessionId: opts.sessionId,
      kind: 'summary',
      file: path.basename(summaryPath),
      summary: summaryBody.slice(0, 4000),
      size: summaryBody.length,
      updatedAt: Date.now(),
    }, { home: opts.home });
  } catch { /* 静默 */ }

  // 2026-08-03 (Context OS P4): 价值点分类路由 — 把摘要里的 decision/lesson/knowledge/insight
  //   自动写入 human-values + judgeness (Context OS §6 对话收尾: 价值不流失).
  //   失败静默, 不阻塞主对话. 幂等: 相同 decision 文本跳过.
  try {
    await routeValuePointsToJudgeness({
      agentId,
      channelId: opts.channelId,
      summaryBody,
      home,
    });
  } catch { /* 静默 */ }

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

// ============================================================
// 2026-08-03 (Context OS P4): 价值点分类路由 → human-values + judgeness
// Context OS §6 对话收尾 Step1-2: 提取价值点 → 找唯一落点.
//   类型映射:
//     decision  → HumanJudgment decision_type='approve', source='trajectory'
//     lesson    → HumanJudgment decision_type='reject',  source='trajectory'
//     knowledge → HumanJudgment decision_type='approve', source='implicit'
//     insight   → HumanJudgment decision_type='approve', source='implicit'
//   每条都 reflectAfterJudgment → JudgenessDescription (openState=locked = 阶段0 临时价值点)
// ============================================================

export type ValuePointType = 'decision' | 'lesson' | 'knowledge' | 'insight';

export interface ValuePoint {
  type: ValuePointType;
  content: string;
}

/**
 * 解析摘要里的 `## 价值点` 段.
 * 容错 3 种行格式: `- (decision) 内容` / `- decision: 内容` / `- decision 内容`
 * 无该段 / `- (无)` → 返回 [].
 */
export function extractValuePoints(summaryBody: string): ValuePoint[] {
  if (!summaryBody) return [];
  const m = summaryBody.match(/##\s*价值点\s*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/);
  if (!m) return [];
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  const out: ValuePoint[] = [];
  const typeSet: ValuePointType[] = ['decision', 'lesson', 'knowledge', 'insight'];
  for (const line of lines) {
    const stripped = line.replace(/^[-*•]\s*/, '');
    if (stripped === '(无)' || stripped === '无' || stripped === '') continue;
    // - (type) content | - type: content | - type content
    const m2 = stripped.match(/^\(?(\w+)\)?\s*[:：]?\s+(.+)$/);
    if (!m2) continue;
    const t = m2[1].toLowerCase() as ValuePointType;
    if (!typeSet.includes(t)) continue;
    const content = m2[2].trim();
    if (content.length < 4) continue;
    out.push({ type: t, content });
  }
  return out.slice(0, 3);
}

export interface RouteValuePointsOpts {
  agentId: string;
  channelId: string;
  summaryBody: string;
  home?: string;
}

/** 幂等检查: human-values 里已有相同 decision 文本 → 跳过 (防重复入库) */
async function alreadyRouted(decisionText: string, home?: string): Promise<boolean> {
  try {
    const { loadAllJudgments } = await import('../pi-ecosystem-judgment/human-value-store.js');
    const all = await loadAllJudgments();
    return all.some((j) => String(j.decision).trim() === decisionText.trim());
  } catch {
    return false; // 读失败 → 不跳过 (重试语义)
  }
}

/**
 * 把摘要里的价值点路由到 human-values + judgeness + Context OS 资产层.
 * 失败静默 (由调用方 try/catch), 单条失败不影响其余.
 * 落点 (Context OS §6 Step2 唯一落点):
 *   decision → decisions/ (decision-store, 不重复写资产层)
 *   lesson   → human-values + judgeness + 12-Analysis/ (复盘)
 *   knowledge→ human-values + judgeness + 07-Knowledge/
 *   insight  → human-values + judgeness + 08-Insights/
 * 返回写入条数 (测试/日志用).
 */
export async function routeValuePointsToJudgeness(opts: RouteValuePointsOpts): Promise<number> {
  const points = extractValuePoints(opts.summaryBody);
  if (points.length === 0) return 0;

  let written = 0;
  for (const p of points) {
    try {
      const decisionText = p.content.slice(0, 300);
      if (await alreadyRouted(decisionText, opts.home)) continue;

      const { storeHumanJudgment } = await import('../pi-ecosystem-judgment/human-value-store.js');
      const { reflectAfterJudgment } = await import('../judgeness/reflect.js');

      const isLesson = p.type === 'lesson';
      const judgment = await storeHumanJudgment({
        decision: decisionText,
        decision_type: isLesson ? 'reject' : 'approve',
        reasons: [`来源: session 摘要价值点 (${p.type})`],
        values_derived: [],
        context: {
          domain: opts.channelId?.startsWith('ch_') ? '通用' : (opts.channelId || '通用'),
          complexity: 'simple',
          stakes: 'low',
          time_pressure: 'low',
        },
        metadata: {
          source: isLesson ? 'trajectory' : 'implicit',
          confidence: 0.6,
          revisable: true,
        },
        status: 'active',
        appliesTo: [],
      });

      await reflectAfterJudgment(judgment, 'agent', sanitizeAgentId(opts.agentId)).catch(() => null);
      written += 1;

      // 2026-08-03 (Context OS P5): 唯一落点 — knowledge/insight/lesson 写入资产层
      //   (幂等: 同标题已存在则跳过; 失败静默不影响主流程)
      const assetLayer =
        p.type === 'knowledge' ? '07-Knowledge' :
        p.type === 'insight' ? '08-Insights' :
        p.type === 'lesson' ? '12-Analysis' : null;
      if (assetLayer) {
        try {
          const { writeContextAsset } = await import('./context-os.js');
          await writeContextAsset({
            layer: assetLayer,
            title: p.content.slice(0, 40),
            content: `> 来源: session 价值点自动路由 (${p.type})\n\n${p.content}\n\n## 价值判断自检\n未来哪个具体场景会用到它? (待确认后固化, 当前 stage0)` ,
            tags: [p.type, 'auto-routed'],
            domain: opts.channelId,
          }, opts.home);
        } catch { /* 资产层写入失败不影响 */ }
      }
    } catch {
      /* 单条失败跳过 */
    }
  }
  return written;
}