/**
 * system-prompt health — 每层 lifecycle 状态扫描
 *
 * 严格对齐 deusyu 论文 "Harness Gardening 3-6 月" + walkinglabs Lifecycle 4-stage
 * + 马书 ch05+ch13 systemPromptSection + 89 FF 的版本/owner 治理思想.
 *
 * 设计:
 *   - 输入: 完整 layer list (assembleSystemPrompt 返回的 layers[])
 *   - 输出: 每层 health 状态 (ok | stale | overdue-review | missing-frontmatter)
 *   - 失败静默: 任何 layer 读失败 → 标 'missing-frontmatter' 而非抛错
 *
 * 决策 (cross-repo_caveats 选边):
 *   - dynamic layers (function source) → 标 'ok' (last_reviewed_at = now), 视作 runtime-managed
 *   - frontmatter author 拒绝 'llm-judge' 之外的不合法值 → 标 'missing-frontmatter'
 */

import type { PromptLayer, SectionMeta, AppliesTo } from './registry.js';

export type LayerHealth = 'ok' | 'stale' | 'overdue-review' | 'missing-frontmatter' | 'dynamic';

export interface LayerHealthEntry {
  id: string;
  health: LayerHealth;
  ageDays: number;
  ttlDays: number;
  /** 距离过期还有多少天 (负数 = 已过期) */
  remainingDays: number;
  author: string | null;
  lastReviewedAt: string | null;
  notes?: string;
  /** 该层是否在当前 context 下被装配 (assembleSystemPrompt 调用过) */
  active: boolean;
}

export interface HealthReport {
  scannedAt: string;
  total: number;
  okCount: number;
  staleCount: number;
  overdueCount: number;
  missingCount: number;
  dynamicCount: number;
  entries: LayerHealthEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 兼容运行时: dynamic layer 没有 meta, 视作 'dynamic' (last_reviewed = now) */
function isDynamic(l: PromptLayer): boolean {
  return l.source === 'function';
}

/** 评估单层 health */
export function evaluateLayer(l: PromptLayer, now: Date = new Date()): LayerHealthEntry {
  if (isDynamic(l)) {
    return {
      id: l.id,
      health: 'dynamic',
      ageDays: 0,
      ttlDays: -1,
      remainingDays: -1,
      author: l.meta?.author ?? 'runtime',
      lastReviewedAt: now.toISOString(),
      active: false,  // 由 caller (assembleSystemPrompt) 决定
    };
  }
  if (!l.meta) {
    // frontmatter 解析失败或缺失
    return {
      id: l.id,
      health: 'missing-frontmatter',
      ageDays: -1,
      ttlDays: -1,
      remainingDays: -1,
      author: null,
      lastReviewedAt: null,
      active: false,
    };
  }
  const reviewedAt = new Date(l.meta.lastReviewedAt).getTime();
  if (isNaN(reviewedAt)) {
    return {
      id: l.id,
      health: 'missing-frontmatter',
      ageDays: -1,
      ttlDays: l.meta.ttlDays,
      remainingDays: -1,
      author: l.meta.author,
      lastReviewedAt: l.meta.lastReviewedAt,
      active: false,
    };
  }
  const ageMs = now.getTime() - reviewedAt;
  const ageDays = Math.floor(ageMs / DAY_MS);
  const remainingDays = l.meta.ttlDays - ageDays;
  let health: LayerHealth;
  if (remainingDays < 0) {
    health = 'overdue-review';
  } else if (remainingDays < l.meta.ttlDays * 0.2) {
    health = 'stale';  // 剩余 < 20% ttl 触发告警
  } else {
    health = 'ok';
  }
  return {
    id: l.id,
    health,
    ageDays,
    ttlDays: l.meta.ttlDays,
    remainingDays,
    author: l.meta.author,
    lastReviewedAt: l.meta.lastReviewedAt,
    notes: l.meta.notes,
    active: false,  // caller 决定
  };
}

/** 评估整组 layer (输入: assembleSystemPrompt 返回的 layers[]) */
export function evaluateLayers(layers: PromptLayer[], now: Date = new Date()): HealthReport {
  const entries = layers.map((l) => evaluateLayer(l, now));
  return summarize(entries, now);
}

/** 汇总: 给一批 entries 算 counts */
function summarize(entries: LayerHealthEntry[], now: Date): HealthReport {
  const counts = { ok: 0, stale: 0, overdue: 0, missing: 0, dynamic: 0 };
  for (const e of entries) {
    if (e.health === 'ok') counts.ok++;
    else if (e.health === 'stale') counts.stale++;
    else if (e.health === 'overdue-review') counts.overdue++;
    else if (e.health === 'missing-frontmatter') counts.missing++;
    else if (e.health === 'dynamic') counts.dynamic++;
  }
  return {
    scannedAt: now.toISOString(),
    total: entries.length,
    okCount: counts.ok,
    staleCount: counts.stale,
    overdueCount: counts.overdue,
    missingCount: counts.missing,
    dynamicCount: counts.dynamic,
    entries,
  };
}

/** 标记当前 context 下激活的 layer (在 assembleSystemPrompt 调用后用) */
export function markActive(report: HealthReport, activeIds: Set<string>): HealthReport {
  return {
    ...report,
    entries: report.entries.map((e) => ({ ...e, active: activeIds.has(e.id) })),
  };
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetHealthForTest(): void {
  // 无内部状态, 保留 API 一致
}
