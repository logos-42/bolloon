/**
 * judgeness · rank.ts — Discover 排名算法 (反攻期 O2)
 *
 * 设计原则 (与 plan §DISCOVER-RANKING 一致):
 *   - 可解释, 不黑盒
 *   - 4 因子线性: rank_score = a*recency + b*breadth + c*depth + d*trust
 *   - 权重可调 (visibility.yaml.ranking 段; 缺省 0.4/0.2/0.2/0.2)
 *   - 每条 ranked 项带 why 字段解释
 *
 * 防御期: 此文件已写, 但 routes-hearth.ts 的 /discover 还没接它 (DEFENSE_MODE).
 */

import type { JudgenessDescription } from './types.js';

export interface RankedItem {
  description: JudgenessDescription;
  rankScore: number;             // 0..1
  why: {
    recency: number;             // 0..1
    breadth: number;
    depth: number;
    trust: number;
  };
}

export interface RankWeights {
  recency: number;
  breadth: number;
  depth: number;
  trust: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  recency: 0.4,
  breadth: 0.2,
  depth: 0.2,
  trust: 0.2,
};

export interface RankOpts {
  weights?: RankWeights;
  /** ms; default 30 天 */
  recencyWindow?: number;
  /** 受信任 peer pk 集合 (allowlist 来源) */
  trustedPks?: Set<string>;
  /** 每条 description owner 的 pubkey (按 descriptionId → pk map 注入) */
  ownerPkMap?: Map<string, string>;
  /** "now" for tests */
  nowMs?: number;
}

/** 主函数. */
export function rankDescriptions(
  descs: JudgenessDescription[],
  opts: RankOpts = {}
): RankedItem[] {
  const w = opts.weights ?? DEFAULT_RANK_WEIGHTS;
  const recencyWindow = opts.recencyWindow ?? 30 * 24 * 60 * 60 * 1000;
  const now = opts.nowMs ?? Date.now();
  const trusted = opts.trustedPks ?? new Set<string>();
  const ownerMap = opts.ownerPkMap ?? new Map<string, string>();

  const out: RankedItem[] = [];
  for (const d of descs) {
    const recency = computeRecency(d, now, recencyWindow);
    const breadth = computeBreadth(d);
    const depth = computeDepth(d);
    const ownerPk = ownerMap.get(d.descriptionId) ?? '__unknown__';
    const trust = trusted.has(ownerPk) ? 1 : 0.3; // 不是 allowlist 也有 0.3 base score (public 维度)
    const score = w.recency * recency + w.breadth * breadth + w.depth * depth + w.trust * trust;
    out.push({
      description: d,
      rankScore: clamp01(score),
      why: { recency, breadth, depth, trust },
    });
  }
  // 排序: rankScore desc, recency desc tiebreaker
  out.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    return b.description.createdAt.localeCompare(a.description.createdAt);
  });
  return out;
}

// ---- 子函数 (可单测) ----

export function computeRecency(d: JudgenessDescription, now: number, window: number): number {
  const t = Date.parse(d.createdAt);
  if (!Number.isFinite(t)) return 0;
  const age = Math.max(0, now - t);
  if (age >= window) return 0;
  return 1 - age / window;
}

export function computeBreadth(d: JudgenessDescription): number {
  const topics = new Set(d.scope.topics ?? []);
  const domains = new Set(d.scope.domains ?? []);
  const all = new Set([...topics, ...domains]);
  // 3 = 满分 (覆盖广)
  return clamp01(all.size / 3);
}

export function computeDepth(d: JudgenessDescription): number {
  const facets = d.facets ?? {};
  const filled = ['judgment', 'taste_aesthetic', 'novelty_score', 'imaginative_score', 'curiosity_vector']
    .filter((k) => (facets as any)[k] !== undefined && (facets as any)[k] !== null).length;
  // 5 维满分 1; 加 basis 文本可冲 1.2 (clamp 1)
  const basis = d.basis ?? {};
  const basisBonus = ['taste_basis', 'novelty_basis', 'imagination_basis']
    .filter((k) => typeof (basis as any)[k] === 'string' && ((basis as any)[k] as string).length > 5).length;
  return clamp01(filled / 5 + basisBonus * 0.06);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
