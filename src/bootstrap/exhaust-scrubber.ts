/**
 * exhaust-scrubber.ts — 上下文废气涡轮 (2026-07-22 设计 C)
 *
 * 思想锚点: 涡轮增压 (Turbocharger)
 *   排气 (废气) = session-window dropped / memory-compressor skipped / compaction stage drops / truncation
 *   涡轮 (本模块) = 采样丢弃事件, 聚合成"背压"指标
 *   进气增压 = 背压反向调进气侧参数 (压缩阈值 / 检索 top-k / judgment 注入 maxChars)
 *   燃烧室 (prompt) = 废气**不进**这里 (保持精准), 只让压力调参
 *
 * 拍板: 上下文废气 → 不进 prompt, 只调参, 进 log/memory, 隐式
 *
 * 三个职责:
 *   1. recordExhaust(event): 采样丢弃事件 → 环形缓冲 + 落盘 ~/.bolloon/engine/backpressure.jsonl (log)
 *   2. getBackpressure(): 算背压等级 (idle/low/medium/high) — 进气侧读它调参
 *   3. getInjectionMaxChars(level): 背压 → judgment 注入 maxChars 映射 (进气增压)
 *   4. maybeWriteExhaustMemory(): 背压高峰持续 → 模板摘要写 memory (月度滚动, 不调 LLM)
 *
 * 设计原则:
 *   - 零新数据源: 只订阅已有丢弃事件
 *   - 隐式: 用户看不到废气内容, 只看到压力等级 (可选背压表)
 *   - 静默: 任何失败 console.warn 不阻塞主流程
 *   - 不存原文: 只存 source + reason + 估算 token 数 (防隐私/膨胀)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type PressureLevel = 'idle' | 'low' | 'medium' | 'high';

export interface ExhaustEvent {
  /** 废气来源 */
  source:
    | 'session-window'
    | 'memory-compressor'
    | 'compaction'
    | 'context-collector'
    | 'context-hierarchy';
  /** 丢弃原因标签 (不存原文): 'window-lru-dropped' | 'compress-skipped:too-few' | 'stage-fold:microcompact' | 'truncated' ... */
  reason: string;
  /** 估算丢弃的 token 数 (可选, 粗略) */
  droppedTokens?: number;
  ts: string;
}

export interface BackpressureSnapshot {
  level: PressureLevel;
  /** 环形缓冲内事件总数 */
  dropCount: number;
  /** 估算丢弃 token 累计 */
  droppedTokensTotal: number;
  /** 每分钟事件速率 (最近 60s) */
  dropRatePerMin: number;
  lastTs: string;
  /** 按 source 分桶计数 */
  bySource: Record<string, number>;
}

// ============== 路径 ==============

function getEngineDir(home?: string): string {
  return path.join(home || os.homedir(), '.bolloon', 'engine');
}

function getBackpressureLogPath(home?: string): string {
  return path.join(getEngineDir(home), 'backpressure.jsonl');
}

function getMemoryEngineDir(agentId: string, home?: string): string {
  // 跟 memory-compressor.ts 一致: ~/.bolloon/memory/<agentId>/engine/
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(home || os.homedir(), '.bolloon', 'memory', safe, 'engine');
}

// ============== 状态 (模块级单例, 跟 chat-archiver 同模式) ==============

const RING_CAPACITY = 100;
const ringBuffer: ExhaustEvent[] = [];
let droppedTokensTotal = 0;
const bySource: Record<string, number> = {};
let monthlyHighCount = 0; // 当月 high 事件累计 (触发 memory 摘要用)

// ============== 采样 (涡轮入口) ==============

/**
 * 记录一个废气事件. 推入环形缓冲 + 落盘 jsonl (log). 静默失败.
 *
 * @param event  废气事件 (source + reason + 可选 droppedTokens; ts 不传则自动填)
 * @param home   可选 home 目录 (测试注入)
 */
export async function recordExhaust(
  event: Omit<ExhaustEvent, 'ts'> & { ts?: string },
  home?: string
): Promise<void> {
  try {
    const full: ExhaustEvent = {
      ts: event.ts || new Date().toISOString(),
      source: event.source,
      reason: event.reason,
      droppedTokens: event.droppedTokens,
    };

    // 环形缓冲
    ringBuffer.push(full);
    if (ringBuffer.length > RING_CAPACITY) {
      ringBuffer.shift();
    }

    // 计数
    if (full.droppedTokens && full.droppedTokens > 0) {
      droppedTokensTotal += full.droppedTokens;
    }
    bySource[full.source] = (bySource[full.source] || 0) + 1;

    // 落盘 jsonl (log) — append 模式, 跟 chat-archiver 同
    const logPath = getBackpressureLogPath(home);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(full) + '\n', 'utf-8');

    // high 事件累计 → 触发 memory 摘要 (火忘)
    const snap = getBackpressure(home);
    if (snap.level === 'high') {
      monthlyHighCount++;
      // 每 10 次 high 触发一次 memory 摘要 (节流, 防频繁写盘)
      if (monthlyHighCount % 10 === 0) {
        maybeWriteExhaustMemorySummary('default', home).catch(() => { /* 静默 */ });
      }
    }
  } catch (err) {
    console.warn('[exhaust-scrubber] recordExhaust failed (non-fatal):', err);
  }
}

/**
 * 同步版本 (供不方便 await 的调用方; 只更新内存环形缓冲, 不落盘).
 * 落盘由下次 async recordExhaust 或显式 flush 触发.
 */
export function recordExhaustSync(event: Omit<ExhaustEvent, 'ts'> & { ts?: string }): void {
  try {
    const full: ExhaustEvent = {
      ts: event.ts || new Date().toISOString(),
      source: event.source,
      reason: event.reason,
      droppedTokens: event.droppedTokens,
    };
    ringBuffer.push(full);
    if (ringBuffer.length > RING_CAPACITY) ringBuffer.shift();
    if (full.droppedTokens && full.droppedTokens > 0) droppedTokensTotal += full.droppedTokens;
    bySource[full.source] = (bySource[full.source] || 0) + 1;
  } catch { /* 静默 */ }
}

// ============== 聚合 (背压等级) ==============

/**
 * 算当前背压快照. 基于环形缓冲 + 最近 60s 事件速率.
 *
 * 等级映射 (dropRatePerMin = 最近 60s 内事件数 / 60 * 60... 简化为最近 60s 事件数本身):
 *   0       → idle
 *   1-2     → low
 *   3-10    → medium
 *   > 10    → high
 */
export function getBackpressure(_home?: string): BackpressureSnapshot {
  const now = Date.now();
  const recent = ringBuffer.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && now - t < 60_000; // 最近 60s
  });
  const dropRatePerMin = recent.length;

  let level: PressureLevel;
  if (dropRatePerMin === 0) level = 'idle';
  else if (dropRatePerMin <= 2) level = 'low';
  else if (dropRatePerMin <= 10) level = 'medium';
  else level = 'high';

  const srcCount: Record<string, number> = {};
  for (const e of ringBuffer) {
    srcCount[e.source] = (srcCount[e.source] || 0) + 1;
  }

  return {
    level,
    dropCount: ringBuffer.length,
    droppedTokensTotal,
    dropRatePerMin,
    lastTs: ringBuffer.length > 0 ? ringBuffer[ringBuffer.length - 1].ts : '',
    bySource: srcCount,
  };
}

export function getPressureLevel(home?: string): PressureLevel {
  return getBackpressure(home).level;
}

// ============== 进气增压 (背压 → 调参) ==============

/**
 * 背压 → judgment 注入 maxChars 映射 (进气增压核心).
 *
 *   idle/low   → 1800 (放宽注入, 上下文宽裕)
 *   medium     → 1500 (默认, 现状)
 *   high       → 800  (收紧注入, 上下文紧张, 留空间给主任务)
 *
 * 调用方: pi-sdk.ts computeJudgmentGate 的 maxChars 从固定 1500 改为读这个.
 */
export function getInjectionMaxChars(level?: PressureLevel, home?: string): number {
  const lvl = level ?? getPressureLevel(home);
  switch (lvl) {
    case 'idle':
    case 'low':
      return 1800;
    case 'medium':
      return 1500;
    case 'high':
      return 800;
    default:
      return 1500;
  }
}

/**
 * 背压 → 检索 top-k 映射 (进气增压, 检索侧).
 *   idle/low → 8, medium → 5, high → 3
 */
export function getRetrievalTopK(level?: PressureLevel, home?: string): number {
  const lvl = level ?? getPressureLevel(home);
  switch (lvl) {
    case 'idle':
    case 'low':
      return 8;
    case 'medium':
      return 5;
    case 'high':
      return 3;
    default:
      return 5;
  }
}

// ============== memory 落地 (月度摘要, 拍板要求"进 memory") ==============

/**
 * 背压高峰持续 → 模板摘要写 memory (月度滚动, 不调 LLM).
 *   ~/.bolloon/memory/<agentId>/engine/exhaust-<YYYY-MM>.summary.md (append)
 *
 * 让"为什么这段时间上下文一直紧张"沉淀进 memory 供 agent 回看.
 * 节流: 每 10 次 high 触发一次 (recordExhaust 内控制).
 */
export async function maybeWriteExhaustMemorySummary(
  agentId: string,
  home?: string
): Promise<{ written: boolean; path?: string }> {
  try {
    const snap = getBackpressure(home);
    if (snap.level !== 'high') return { written: false };

    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const dir = getMemoryEngineDir(agentId, home);
    const file = path.join(dir, `exhaust-${yearMonth}.summary.md`);
    await fs.mkdir(dir, { recursive: true });

    const block = `\n\n---\n\n## 引擎背压高峰 @ ${now.toISOString()} (level=high)\n\n` +
      `- 最近 60s 丢弃事件: ${snap.dropRatePerMin} 次/min\n` +
      `- 环形缓冲事件总数: ${snap.dropCount}\n` +
      `- 估算丢弃 token 累计: ${snap.droppedTokensTotal}\n` +
      `- 按 source 分布: ${Object.entries(snap.bySource).map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}\n` +
      `- 含义: 上下文持续紧张, 进气侧已自动收紧 (judgment 注入 maxChars=800, 检索 top-k=3)\n`;
    await fs.appendFile(file, block, 'utf-8');
    return { written: true, path: file };
  } catch (err) {
    console.warn('[exhaust-scrubber] maybeWriteExhaustMemorySummary failed (non-fatal):', err);
    return { written: false };
  }
}

// ============== 测试辅助 ==============

/** 重置模块状态 (仅测试用) */
export function __resetForTest(): void {
  ringBuffer.length = 0;
  droppedTokensTotal = 0;
  for (const k of Object.keys(bySource)) delete bySource[k];
  monthlyHighCount = 0;
}
