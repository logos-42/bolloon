/**
 * chat-archiver.ts — 按 peer 月度归档聊天记录 + 接 memory 摘要
 *
 * 设计目的 (2026-07-05):
 *   解决"对方不在线也能看到历史"的核心问题.
 *   sessions/cache/<channelId>.json 单文件无限增长, 超过 50MB 直接拒绝加载.
 *
 *   新方案:
 *     - 每次 /message 处理后, 同时写到 3 个地方:
 *       ① sessions/cache/<channelId>.json (原有, 最近窗口用)
 *       ② ~/.bolloon/peers/<pk>/chat-<YYYY-MM>.md (按 peer 月度归档)
 *       ③ ~/.bolloon/memory/<agentId>/peers/<pk>/<YYYY-MM>.summary.md (月度摘要)
 *
 *   触发时机:
 *     - appendChatArchive(): 每次保存远端/本地 user + ai 消息后立即调用 (高频)
 *     - compressMonthlyArchive(): 月底 / 90 天滚动 / 显式调用 (低频, 调 LLM 摘要)
 *
 *   peer 维度 而不是 channel 维度: 同一个远端节点可能跨多个 channel 协作,
 *   按 peer 归档才能完整还原"与对方的对话历史".
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as peerFs from '../network/peer-fs.js';

// ============== 路径 ==============

const HOME = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');

export function getPeerSummaryDir(agentId: string, publicKey: string): string {
  const safeAgent = sanitizeId(agentId);
  const safePeer = sanitizeId(publicKey);
  return path.join(HOME, 'memory', safeAgent, 'peers', safePeer);
}

export function getPeerSummaryPath(agentId: string, publicKey: string, yearMonth: string): string {
  return path.join(getPeerSummaryDir(agentId, publicKey), `${yearMonth}.summary.md`);
}

export function getPeerSummaryCursorPath(agentId: string, publicKey: string, yearMonth: string): string {
  return path.join(getPeerSummaryDir(agentId, publicKey), `${yearMonth}.cursor`);
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ============== 类型 (复用 peer-fs 的 ChatArchiveEntry) ==============

export interface ArchiveEntry {
  ts: string;
  source: 'local' | 'remote' | 'ai-mention' | 'ai-mention-remote';
  channelId?: string;
  channelName?: string;
  text: string;
  fromPublicKey?: string;
  fromAgentId?: string;
  /** session 端的消息 type (user / ai), 便于摘要时分段 */
  msgType?: 'user' | 'ai';
}

export interface ArchiveOpts {
  publicKey: string;
  entry: ArchiveEntry;
}

export interface CompressOpts {
  agentId: string;
  publicKey: string;
  yearMonth?: string;
  home?: string;
  /** 触发压缩的最小新消息数 (默认 20, 月度比单 session 阈值高) */
  minNewEntries?: number;
}

export interface CompressResult {
  summaryPath: string;
  cursorPath: string;
  entriesCount: number;
  bytesWritten: number;
  skipped?: 'no-new-entries' | 'too-few-entries' | 'no-archive' | 'error';
  error?: string;
}

// ============== appendChatArchive — 高频, 每次 message 都调 ==============

/**
 * 追加一条 chat entry 到 peer 的月度归档.
 * 不依赖 LLM, 纯文件 IO; 失败静默不阻塞主对话.
 */
export async function appendChatArchive(opts: ArchiveOpts): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    await peerFs.appendChat(opts.publicKey, opts.entry);
    return { ok: true, path: peerFs.getPeerChatPath(opts.publicKey) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ============== compressMonthlyArchive — 低频, 月底/显式调 ==============

/**
 * 读取月度 markdown 归档, 调 LLM 摘要, append 写到 memory.
 * 用 cursor 跟踪已摘要到第几行, 增量压缩.
 */
async function readArchiveLines(publicKey: string, yearMonth: string): Promise<string[]> {
  const file = peerFs.getPeerChatPath(publicKey, yearMonth);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return raw.split('\n');
  } catch {
    return [];
  }
}

async function readSummaryCursor(cursorPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(cursorPath, 'utf-8');
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeSummaryCursor(cursorPath: string, value: number): Promise<void> {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  await fs.writeFile(cursorPath, String(value), 'utf-8');
}

/**
 * 尝试调 LLM 生成月度摘要. 失败 → 抛错, 由 caller fallback 到模板.
 */
async function tryMonthlyLlm(systemPrompt: string, userPrompt: string): Promise<string> {
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
      maxTokens: 1000,
    });
    const text = (result as any)?.reply || (result as any)?.text || '';
    if (typeof text !== 'string' || text.length < 20) throw new Error('LLM returned too-short text');
    return text;
  } catch (e: any) {
    throw new Error(`LLM call failed: ${e?.message || String(e)}`);
  }
}

/**
 * 模板 fallback: 简单统计 user/ai 数量, 列前 5 条关键内容.
 */
function templateMonthlySummary(opts: {
  publicKey: string;
  yearMonth: string;
  entries: ArchiveEntry[];
  timestamp: string;
}): string {
  const user = opts.entries.filter(e => e.msgType === 'user' || e.source === 'local' || e.source === 'remote');
  const ai = opts.entries.filter(e => e.msgType === 'ai' || e.source?.startsWith('ai-mention'));
  const channelSet = new Set(opts.entries.map(e => e.channelName).filter(Boolean));

  const sampleUser = user.slice(0, 5).map(e => `  - [${e.ts}] ${e.text.slice(0, 80)}`).join('\n');
  const sampleAi = ai.slice(0, 5).map(e => `  - [${e.ts}] ${e.text.slice(0, 80)}`).join('\n');

  return `# 月度对话摘要 — ${opts.yearMonth} (peer ${opts.publicKey.slice(0, 12)}…)

时间: ${opts.timestamp}
对话轮次: ${opts.entries.length} (user=${user.length}, ai=${ai.length})
涉及 channel: ${Array.from(channelSet).slice(0, 10).join(', ') || '(无)'}

## 用户关键提问
${sampleUser || '  (无)'}

## AI 关键回答
${sampleAi || '  (无)'}

## 备注
- 此摘要由模板生成 (LLM 调用失败 fallback)
`;
}

/**
 * 解析 markdown 归档为 entries (用 "### " 切分)
 */
function parseArchiveEntries(lines: string[]): Array<{ startLine: number; entry: ArchiveEntry }> {
  const out: Array<{ startLine: number; entry: ArchiveEntry }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('### ')) {
      const header = lines[i];
      // 解析 "### 2026-07-05 10:30:45 UTC [channelName] — source"
      const m = header.match(/^### (.+?)\s*(?:\[(.+?)\])?\s*—\s*(\S+?)(?:\s+\(.+?\))?$/);
      if (m) {
        const ts = m[1].replace(/\s+UTC$/, '').trim();
        const channelName = m[2];
        const source = m[3] as ArchiveEntry['source'];
        // 找下一段 "### " 或 "---" 之间的内容
        let j = i + 1;
        const bodyLines: string[] = [];
        while (j < lines.length && !lines[j].startsWith('### ') && !lines[j].startsWith('---')) {
          bodyLines.push(lines[j]);
          j++;
        }
        const text = bodyLines.join('\n').trim();
        out.push({
          startLine: i,
          entry: {
            ts: ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z',
            source,
            channelName,
            text,
          }
        });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * 主入口: 压缩月度归档到 memory.
 */
export async function compressMonthlyArchive(opts: CompressOpts): Promise<CompressResult> {
  const agentId = sanitizeId(opts.agentId);
  const publicKey = opts.publicKey;
  const yearMonth = opts.yearMonth || peerFs.currentYearMonth();
  const home = opts.home || HOME;

  const summaryPath = getPeerSummaryPath(agentId, publicKey, yearMonth);
  const cursorPath = getPeerSummaryCursorPath(agentId, publicKey, yearMonth);
  const archivePath = peerFs.getPeerChatPath(publicKey, yearMonth);

  // 读归档
  const lines = await readArchiveLines(publicKey, yearMonth);
  if (lines.length === 0) {
    return { summaryPath, cursorPath, entriesCount: 0, bytesWritten: 0, skipped: 'no-archive' };
  }

  // 解析 entries
  const allEntries = parseArchiveEntries(lines);
  const cursor = await readSummaryCursor(cursorPath);
  const newEntries = allEntries.slice(cursor);
  const minNew = opts.minNewEntries ?? 20;

  if (newEntries.length < minNew) {
    return { summaryPath, cursorPath, entriesCount: newEntries.length, bytesWritten: 0, skipped: 'too-few-entries' };
  }

  const timestamp = new Date().toISOString();
  let summaryBody: string;

  try {
    const sysPrompt = '你是 bolloon 月度记忆压缩助手. 输入是按 peer 月度归档的聊天记录 markdown, 输出 400-800 字中文摘要, 包含: 1) 关键合作主题; 2) 共同完成的成果; 3) 待跟进事项; 4) 对方能力偏好. 不要寒暄, 不复述已知.';
    const recentSnippet = newEntries.slice(-30).map(e => {
      const ts = e.entry.ts;
      const chan = e.entry.channelName ? `[${e.entry.channelName}]` : '';
      return `[${ts}]${chan} ${e.entry.source}: ${e.entry.text}`;
    }).join('\n').slice(0, 8000);
    const userPrompt = `Peer: ${publicKey}\n月份: ${yearMonth}\n时间: ${timestamp}\n新增条数: ${newEntries.length}\n\n最近对话:\n${recentSnippet}`;
    summaryBody = await tryMonthlyLlm(sysPrompt, userPrompt);
  } catch (e: any) {
    summaryBody = templateMonthlySummary({
      publicKey,
      yearMonth,
      entries: newEntries.map(e => e.entry),
      timestamp,
    });
  }

  const block = `\n\n---\n\n## 增量摘要 @ ${timestamp} (${newEntries.length} entries)\n\n${summaryBody.trim()}\n`;

  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.appendFile(summaryPath, block, 'utf-8');
  await writeSummaryCursor(cursorPath, allEntries.length);

  return {
    summaryPath,
    cursorPath,
    entriesCount: newEntries.length,
    bytesWritten: Buffer.byteLength(block, 'utf-8'),
  };
}

/**
 * 把 session.json 中的所有消息按 peer 切分, 一次性 archive 到各 peer 月度文件.
 * 用于: ① 启动时迁移已有 session 历史到 peer archive; ② 兜底补档.
 */
export async function archiveSessionMessagesForPeer(opts: {
  publicKey: string;
  messages: Array<{
    type: 'user' | 'ai';
    content: string;
    timestamp?: string;
    channelId?: string;
    channelName?: string;
    source?: string;
    fromPublicKey?: string;
  }>;
}): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors = 0;
  for (const m of opts.messages) {
    const ts = m.timestamp || new Date().toISOString();
    const entry: ArchiveEntry = {
      ts,
      source: (m.source as any) || (m.type === 'user' ? 'remote' : 'ai-mention'),
      channelId: m.channelId,
      channelName: m.channelName,
      text: m.content,
      fromPublicKey: m.fromPublicKey || opts.publicKey,
      msgType: m.type,
    };
    const r = await appendChatArchive({ publicKey: opts.publicKey, entry });
    if (r.ok) written++;
    else errors++;
  }
  return { written, errors };
}

/**
 * 列出指定 peer 所有可用的月度摘要 (按月份倒序)
 */
export async function listPeerSummaries(agentId: string, publicKey: string): Promise<Array<{ yearMonth: string; path: string; size: number }>> {
  const dir = getPeerSummaryDir(agentId, publicKey);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter(e => /^\d{4}-\d{2}\.summary\.md$/.test(e))
      .map(e => ({
        yearMonth: e.replace(/^\d{4}-\d{2}\./, '').replace(/\.summary\.md$/, ''),
        path: path.join(dir, e),
        size: fsSync.statSync(path.join(dir, e)).size,
      }))
      .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  } catch {
    return [];
  }
}