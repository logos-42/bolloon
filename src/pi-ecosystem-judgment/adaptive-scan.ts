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
// 跨平台: 优先 process.env.HOME (测试可控), 然后 os.homedir() (Windows 上读 USERPROFILE).
// 用 path.join 而不是字符串拼接, 保证 Windows 上用 \ 分隔.
function getUsageLogPath(): string {
  const home = process.env.HOME || os.homedir() || '/tmp';
  return path.join(home, '.bolloon', 'human-values', 'usage.jsonl');
}
function getEvolutionLogPath(): string {
  const home = process.env.HOME || os.homedir() || '/tmp';
  return path.join(home, '.bolloon', 'human-values', 'evolution.jsonl');
}

export type SuggestionKind = 'stale' | 'rising' | 'unused' | 'causal_conflict' | 'low_causal_power';
export type SuggestionAction = 'deprecate' | 'boost' | 'review';

/**
 * P-Action 1: next-action hint (4 仓库都强调的错误信息 = 修复指令 思想)
 * - deusyu: "Lint error messages should embed fix instructions, turning them into
 *   a self-correction loop the agent can execute."
 * - walkinglabs lecture 10: "POST /api/reset-password returned 500. Check that
 *   the email service config exists..." 而非 "Test failed"
 * - 马书 Capybara v8 4-class behavior mitigation
 * - china-qijizhifeng Agent Debugger LLM 分析
 *
 * 在 adaptive-scan 启发式产出 hint, 不调 LLM (保持类 B 失败静默 + 无 LLM 不变量)
 */
export function suggestionHint(kind: SuggestionKind, action: SuggestionAction, metrics: AdaptiveSuggestion['metrics']): string {
  switch (kind) {
    case 'stale':
      return action === 'deprecate'
        ? `此判断力 30+ 天未使用 (last ${metrics.daysSinceLastUse}d ago, total ${metrics.totalUsage}×). 建议: 接受废弃前, 跑一次 'npm run judgments:search "<topic>"' 确认是否真的不再相关; 若仍相关, 用 boost + active 标签标记, 不要 deprecate.`
        : `Stale judgment 建议: review 后 决定 boost / deprecate. 7d 用量 ${metrics.usage7d}× 30d 用量 ${metrics.usage30d}×.`;
    case 'rising':
      return `🔥 30 天内用量翻倍 (7d=${metrics.usage7d}×, 30d=${metrics.usage30d}×). 建议: 接受 boost 提升该 judgment 的注入优先级; 同时检查 conflicts.jsonl 看是否与其他判断力冲突.`;
    case 'unused':
      return `此判断力从未被注入 (total ${metrics.totalUsage}× = 0). 建议: (1) 跑 'npm run judgments:debug <id>' 确认检测钩子是否正常工作; (2) 若是 false positive, 接受 reject; (3) 若需要激活, 接受 review + 触发 D 路径蒸馏.`;
    case 'causal_conflict':
      return `检测到与另一判断力因果冲突. 建议: 接受 review 后, 优先保留因果强度 (causal power) 高的那条; 或在 persona.json 加一条 human override. 详细因果矩阵: '~/.bolloon/human-values/causal-matrix.json'.`;
    case 'low_causal_power':
      return `此判断力的因果强度持续低 (causal power < 0.3). 建议: 接受 review 后考虑 deprecate; 跑 'npm run causal:audit <id>' 看是哪条 related event 拉低了分数.`;
    default:
      return `建议 review: ${action} 这条 judgment. 7d 用量 ${metrics.usage7d}× 30d 用量 ${metrics.usage30d}×.`;
  }
}

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
  /** P-Action 1: next-action hint (4 仓库共识 — 错误信息 = 修复指令) */
  hint: string;
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
          hint: suggestionHint('rising', 'boost', metrics),
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
        hint: suggestionHint('stale', 'deprecate', metrics),
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
        hint: suggestionHint('unused', 'review', metrics),
        metrics,
        scannedAt: now.toISOString(),
      });
    }
  }

  // 按 action 重要性排序: rising > stale > unused
  const order: Record<SuggestionKind, number> = { rising: 0, stale: 1, unused: 2, causal_conflict: 3, low_causal_power: 4 };
  // 阶段 2: causal_conflict — judgment 库内自动检测冲突对
  const { runConflictDetection } = await import('./causal-judge.js');
  const conflictResult = await runConflictDetection();
  for (const a of judgments) {
    if ((a.status ?? 'active') !== 'active') continue;
    if (!Array.isArray(a.conflictWith) || a.conflictWith.length === 0) continue;
    // 列出每对冲突 (limit 每个 judgment 最多 3 对, 避免 UI 刷屏)
    const conflicts = a.conflictWith.slice(0, 3);
    for (const otherId of conflicts) {
      const other = judgments.find((j) => j.id === otherId);
      if (!other) continue;
      const c = await import('./causal-judge.js');
      const det = c.detectConflict(a, other);
      suggestions.push({
        key: `causal_conflict:${a.id}:${other.id}`,
        kind: 'causal_conflict',
        judgmentId: a.id,
        decision: `${a.decision} ↔ ${other.decision}`,
        reason: det.isConflict ? det.reason : '库内已标冲突, 需 LLM 复核',
        action: 'review',
        hint: suggestionHint('causal_conflict', 'review', { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: 0 }),
        metrics: { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: 0 },
        scannedAt: now.toISOString(),
      });
    }
  }
  // 静默 conflictResult.detected 计数 (已通过 import 触发了)
  void conflictResult;

  // 阶段 2: low_causal_power — 留空 (依赖 do-calculus 跑过后的低边际贡献记录)
  // 当前不主动跑 (cost 高), 仅在 UI 手动触发后, 类 B 下次扫描时捡起来
  // 此处不实现, 留作下个迭代

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
    // P-Action 3: 摄入点扫描 (只跳 prompt-injection, 不扫 PII — judgment 决策文本含人话是合法的)
    const { scanInput, writeScanAudit, shouldHardBlock } = await import('../security/input-scanner.js') as typeof import('../security/input-scanner.js');
    const fieldsToScan = [
      entry.suggestion?.decision ?? '',
      entry.suggestion?.reason ?? '',
    ].join('\n');
    const result = scanInput(fieldsToScan, { source: 'judgment', scanPii: false });
    if (shouldHardBlock(result)) {
      console.warn(`[adaptive-scan] logEvolution 阻断恶意 entry: verdict=${result.verdict}, threats=${result.threats.length}`);
      writeScanAudit(result, { evolutionKey: entry.suggestion?.key, blocked: true }).catch(() => { /* silent */ });
      return;  // 不写磁盘
    }
    if (result.verdict !== 'pass') {
      writeScanAudit(result, { evolutionKey: entry.suggestion?.key, blocked: false }).catch(() => { /* silent */ });
    }
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
