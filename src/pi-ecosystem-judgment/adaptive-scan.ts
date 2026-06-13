/**
 * Adaptive Scan — 类 B 自迭代入口
 *
 * 扫描 ~/.bolloon/human-values/usage.jsonl + judgments.json,
 * 生成"自适应建议" (只读, 不改库). 用户在 UI 接受/拒绝后
 * 才会真正生效, 写入 evolution.jsonl 留作审计.
 *
 * 设计原则 (类 B 边界):
 * - 不自动改库 (避免 AI 越权)
 * - 所有建议可逆 (接受/拒绝都行, 接受后写 evolution.jsonl 留痕)
 * - 失败静默 (主对话不阻塞)
 * - 单次扫描纯本地 + 内存计算, 无 LLM 调用 (避免 LLM 幻觉污染)
 *
 * 触发时机:
 * - 用户主动: UI "📊 自适应" tab 点 "重新扫描"
 * - 被动: 每天首次进入判断力 modal 时自动跑一次 (缓存 24h)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadAllJudgments, type HumanJudgment } from './human-value-store.js';

// 用 getter 函数而非模块顶层 const: process.env.HOME 在测试 beforeAll 才设,
// 模块顶层求值时还是真 home. 运行时求值才能正确响应测试 fixture.
function getUsageLogPath(): string {
  return (os.homedir() || process.env.HOME || '/tmp') + '/.bolloon/human-values/usage.jsonl';
}
function getEvolutionLogPath(): string {
  return (os.homedir() || process.env.HOME || '/tmp') + '/.bolloon/human-values/evolution.jsonl';
}

export type SuggestionKind = 'stale' | 'rising' | 'unused';
export type SuggestionAction = 'deprecate' | 'boost' | 'review';

export interface AdaptiveSuggestion {
  /** unique key: kind + judgmentId */
  key: string;
  kind: SuggestionKind;
  judgmentId: string;
  /** judgment 的 decision 文本 (供 UI 显示) */
  decision: string;
  /** 触发原因 */
  reason: string;
  /** 建议动作 */
  action: SuggestionAction;
  /** 相关数据 (count / 频率) */
  metrics: {
    usage7d: number;
    usage30d: number;
    daysSinceLastUse: number;
    totalUsage: number;
  };
  /** 扫描时间 */
  scannedAt: string;
}

export interface AdaptiveScanResult {
  scannedAt: string;
  judgmentsTotal: number;
  usageEntriesScanned: number;
  suggestions: AdaptiveSuggestion[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface UsageEntry {
  ts: string;
  channelId: string | null;
  usedIds: string[];
}

async function readUsageLog(): Promise<UsageEntry[]> {
  try {
    const content = await fs.readFile(getUsageLogPath(), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .map((l) => {
        try { return JSON.parse(l) as UsageEntry; } catch { return null; }
      })
      .filter((e): e is UsageEntry => Boolean(e) && Array.isArray(e?.usedIds));
  } catch {
    return [];
  }
}

function countByJudgment(entries: UsageEntry[]): Map<string, { total: number; last7d: number; last30d: number; lastUseTs: number | null }> {
  const now = Date.now();
  const cutoff7d = now - 7 * DAY_MS;
  const cutoff30d = now - 30 * DAY_MS;
  const map = new Map<string, { total: number; last7d: number; last30d: number; lastUseTs: number | null }>();
  for (const e of entries) {
    const ts = new Date(e.ts).getTime();
    for (const id of e.usedIds) {
      const cur = map.get(id) || { total: 0, last7d: 0, last30d: 0, lastUseTs: null };
      cur.total++;
      if (ts >= cutoff7d) cur.last7d++;
      if (ts >= cutoff30d) cur.last30d++;
      if (cur.lastUseTs === null || ts > cur.lastUseTs) cur.lastUseTs = ts;
      map.set(id, cur);
    }
  }
  return map;
}

/**
 * 主扫描函数: 纯本地计算, 无 LLM
 */
export async function runAdaptiveScan(): Promise<AdaptiveScanResult> {
  const now = new Date();
  const nowTs = now.getTime();
  const [judgments, entries] = await Promise.all([
    loadAllJudgments(),
    readUsageLog(),
  ]);
  const usage = countByJudgment(entries);
  const suggestions: AdaptiveSuggestion[] = [];

  for (const j of judgments) {
    if ((j.status ?? 'active') !== 'active') continue;

    const id = j.id;
    const u = usage.get(id) || { total: 0, last7d: 0, last30d: 0, lastUseTs: null };
    const daysSinceLastUse = u.lastUseTs === null
      ? Math.floor((nowTs - new Date(j.timestamp).getTime()) / DAY_MS)
      : Math.floor((nowTs - u.lastUseTs) / DAY_MS);

    const metrics = {
      usage7d: u.last7d,
      usage30d: u.last30d,
      daysSinceLastUse,
      totalUsage: u.total,
    };

    // rising: 7 天频率 > 30 天均值的 1.5 倍, 且至少用过 2 次 (避免噪声)
    if (u.last30d > 0 && u.last7d >= 2) {
      const dailyAvg30 = u.last30d / 30;
      const dailyRate7 = u.last7d / 7;
      if (dailyRate7 > dailyAvg30 * 1.5) {
        suggestions.push({
          key: `rising:${id}`,
          kind: 'rising',
          judgmentId: id,
          decision: j.decision,
          reason: `7 天使用率 (${dailyRate7.toFixed(2)}/d) 是 30 天均值的 ${(dailyRate7 / dailyAvg30).toFixed(1)} 倍`,
          action: 'boost',
          metrics,
          scannedAt: now.toISOString(),
        });
        continue; // 不再归入 unused/stale
      }
    }

    // stale: 90 天未使用 + 总使用 < 3 (低频 + 长期不用)
    if (u.total < 3 && daysSinceLastUse >= 90) {
      suggestions.push({
        key: `stale:${id}`,
        kind: 'stale',
        judgmentId: id,
        decision: j.decision,
        reason: `已 ${daysSinceLastUse} 天未使用, 总使用仅 ${u.total} 次`,
        action: 'deprecate',
        metrics,
        scannedAt: now.toISOString(),
      });
      continue;
    }

    // unused: 30 天未使用 + 总使用 < 5 (中频但近期没在用)
    if (u.total < 5 && daysSinceLastUse >= 30) {
      suggestions.push({
        key: `unused:${id}`,
        kind: 'unused',
        judgmentId: id,
        decision: j.decision,
        reason: `已 ${daysSinceLastUse} 天未使用, 总使用 ${u.total} 次 (可能不再相关)`,
        action: 'review',
        metrics,
        scannedAt: now.toISOString(),
      });
    }
  }

  // 按 action 重要性排序: rising > stale > unused
  const order: Record<SuggestionKind, number> = { rising: 0, stale: 1, unused: 2 };
  suggestions.sort((a, b) => order[a.kind] - order[b.kind]);

  return {
    scannedAt: now.toISOString(),
    judgmentsTotal: judgments.length,
    usageEntriesScanned: entries.length,
    suggestions,
  };
}

// ============================================================
// 接受/拒绝: 写 evolution.jsonl 留痕, 不直接改 judgments.json
// (真正的库修改在调用方做, 这里只 log)
// ============================================================

export type EvolutionAction = 'accept' | 'reject' | 'revert';

export interface EvolutionEntry {
  ts: string;
  action: EvolutionAction;
  suggestion: AdaptiveSuggestion;
  /** 实际应用时写了什么 (空=未应用) */
  appliedPatch?: Record<string, unknown>;
}

export async function logEvolution(entry: EvolutionEntry): Promise<void> {
  try {
    await fs.mkdir(path.dirname(getEvolutionLogPath()), { recursive: true });
    await fs.appendFile(getEvolutionLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[adaptive-scan] logEvolution failed:', err);
  }
}

export async function readEvolutionLog(limit: number = 50): Promise<EvolutionEntry[]> {
  try {
    const content = await fs.readFile(getEvolutionLogPath(), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try { return JSON.parse(l) as EvolutionEntry; } catch { return null; }
      })
      .filter((e): e is EvolutionEntry => Boolean(e));
  } catch {
    return [];
  }
}

// ============================================================
// 缓存: 避免每次打开 modal 都扫一次
// ============================================================

let lastScan: { at: number; result: AdaptiveScanResult } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function getCachedScan(force: boolean = false): Promise<AdaptiveScanResult> {
  if (!force && lastScan && Date.now() - lastScan.at < CACHE_TTL_MS) {
    return lastScan.result;
  }
  const result = await runAdaptiveScan();
  lastScan = { at: Date.now(), result };
  return result;
}

export function clearAdaptiveScanCache(): void {
  lastScan = null;
}
