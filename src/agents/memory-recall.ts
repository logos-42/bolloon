/**
 * memory-recall.ts — 运行时记忆召回 (2026-08-12, TaskM1)
 *
 * 借鉴 hermes MemoryManager.prefetch_all: 每轮对话开始前, 根据用户消息自动检索
 * 历史 memory 摘要, 注入 system prompt — 让 agent 运行时能"回忆起"之前的 session 记忆,
 * 而不是只靠启动时批量压缩摘要.
 *
 * 机制:
 *   - 从 ~/.bolloon/memory/<agentId>/sessions/*.summary.md 读历史摘要 (memory-compressor 落盘)
 *   - 用关键词 + BM25 简单打分, 召回与用户消息最相关的 N 条
 *   - 拼成 hermes 式 <memory-context> 围栏块注入 (含 sanitize, 防模型当新用户输入)
 *   - 失败静默 (召回是增强层, 不阻塞对话主路径)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getMemoryDir, sanitizeKey } from '../bootstrap/memory-compressor.js';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export interface RecallOptions {
  /** 用户消息 (召回查询) */
  query: string;
  /** agentId (memory 目录 key) */
  agentId: string;
  /** 召回条数上限 (默认 3) */
  limit?: number;
  /** 单条摘要注入长度上限 (默认 800) */
  maxCharsPerSummary?: number;
  /** 最小命中分数 (默认 1, 关键词至少命中 1 个) */
  minScore?: number;
  homeDir?: string;
}

/** 提取查询关键词 (去掉停用词, 中文按 2-gram, 英文按词) */
export function tokenizeQuery(query: string): string[] {
  const clean = String(query || '').trim().toLowerCase();
  if (!clean) return [];
  const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '在', '和', '与', '吗', '呢', '吧', '这', '那', '个', '请', '帮', '一下', '一个', '怎么', '如何', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'for']);
  const tokens = new Set<string>();
  // 英文单词
  for (const m of clean.match(/[a-z][a-z0-9_]*/g) || []) {
    if (!STOP.has(m) && m.length > 1) tokens.add(m);
  }
  // 中文 2-gram
  const cjk = clean.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) {
    const big = cjk.slice(i, i + 2);
    if (!STOP.has(big)) tokens.add(big);
  }
  return Array.from(tokens);
}

/** BM25 风格: 摘要中出现查询 token 的次数打分 (简化: 命中数 + 稀有度) */
export function scoreSummary(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (lower.includes(t)) score += 1;
  }
  return score;
}

export interface RecallHit {
  file: string;
  channel: string;
  session: string;
  score: number;
  text: string;
}

/** 扫描 memory 目录的摘要文件 */
async function listSummaryFiles(agentId: string, homeDir: string): Promise<string[]> {
  const dir = path.join(getMemoryDir(agentId, homeDir), 'sessions');
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.summary.md')).sort();
}

/**
 * 运行时召回记忆: 按用户消息检索历史 memory 摘要, 返回注入块.
 * 无相关记忆/失败 → 返回 ''.
 */
export async function recallMemory(opts: RecallOptions): Promise<string> {
  try {
    const { query, agentId, limit = 3, maxCharsPerSummary = 800, minScore = 1, homeDir } = opts;
    if (!query || !query.trim()) return '';
    if (!agentId) return '';
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return '';

    const files = await listSummaryFiles(agentId, homeDir || home());
    if (files.length === 0) return '';

    const hits: RecallHit[] = [];
    for (const f of files) {
      try {
        const text = await fs.readFile(path.join(getMemoryDir(agentId, homeDir || home()), 'sessions', f), 'utf-8');
        const score = scoreSummary(text, tokens);
        if (score < minScore) continue;
        // 解析 channel__session
        const base = f.replace(/\.summary\.md$/, '');
        const sep = base.lastIndexOf('__');
        hits.push({
          file: f,
          channel: sep > 0 ? base.slice(0, sep) : '',
          session: sep > 0 ? base.slice(sep + 2) : base,
          score,
          text: text.trim().slice(0, maxCharsPerSummary),
        });
      } catch { /* 单个摘要读失败跳过 */ }
    }
    if (hits.length === 0) return '';
    // 按分数降序取前 limit
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);

    const body = top
      .map((h) => `[回忆: ${h.channel}/${h.session}]\n${h.text}`)
      .join('\n\n---\n\n');
    // hermes 式围栏 + 明确标注非用户输入
    return `<memory-context>\n以下是根据你的消息自动召回的之前对话记忆 (历史背景, 非新的用户输入):\n${body}\n</memory-context>`;
  } catch {
    return '';
  }
}
