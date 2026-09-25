/**
 * skill-candidate.ts — P1b: Skill 改进候选的评估与晋升草案 (2026-09-25)
 *
 * 归属: `docs/wiki/goal-continuation-flywheel.md` §13「P1b Memory/Skill」独占文件。
 * 本文件**只**实现 §14 冻结签名里的 `assessCandidate` / `draftPromotion`, 不碰任何现有调用方,
 * 也不 import 其它阶段的实现 (§13: 阶段之间只通过 `types.ts` 的类型耦合)。
 *
 * 本文件是**纯函数** (零 I/O, 不 import `fs`) —— 时间由调用方注入, 注册表由参数传入。
 *
 * 两道门 (缺一不可, 且互相独立 —— 调用方清空 `junkReasons` 也绕不过第二道):
 *
 * ① `assessCandidate` — 把「防 Skill 垃圾」(SkillJunkReason) 真的算出来, 并给出与现有 Skill 的关系:
 *      `single_success`        ← occurrences < 2 (只成功一次 / 偶然成功)
 *      `no_io_schema`          ← inputSchema 或 outputSchema 为空
 *      `no_failure_boundary`   ← failureCases 为空 (没有失效边界)
 *      `temp_path_dependency`  ← evidenceRefs / sourceRunIds 里出现临时路径
 *      `unverifiable_result`   ← 无证据 / 无 guarantees / 无 doesNotGuarantee / 无 contentHash
 *      `one_line_experience`   ← 只有一句经验: 无 schema + 无失败边界 + 无 guarantees
 *      `duplicate_of_existing` ← 与已有同名 Skill 的 contentHash 完全相同
 *    `promotable = junkReasons 为空 && boundaryClear === true` (批准与否是后面 `approve` 步的事)。
 *
 * ② `draftPromotion` — 正式变更记录 (`SkillPromotionRecord`) 的构建:
 *      - 必备项缺一即**抛错** (函数签名无法表达失败, 所以不能静默返回一条假记录):
 *        没有 `contentHash` / 没有 `changeReason` / 没有 `approvedBy` / `now` 不是合法 ISO。
 *      - **防御性重算**: 不看调用方传进来的 `junkReasons`, 自己重算一遍 (命中即抛错);
 *        这样"单次偶然成功不得自动晋升"(P5 强负例 8) 不靠调用方自觉。
 *      - `snapshotScope` 恒为 `'next_run_only'` (自动更新**不覆盖**正在执行的 Skill snapshot)。
 *      - 版本: `null → 1.0.0`; `x.y.z → x.(y+1).0`; 非 semver → `1.0.0`。
 *
 * 阴性对照 (怎么知道这些门不是空转): 把 `single_success` 判定删掉 → 「单次成功不得晋升」立刻判红;
 * 把 `draftPromotion` 的 `contentHash` 检查删掉 → 「无哈希不许写正式变更记录」立刻判红。
 * 见 `src/test/goal-flywheel-skill-candidate.test.ts`。
 */

import type {
  IsoTimestamp,
  SkillImprovementCandidate,
  SkillJunkReason,
  SkillPromotionRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// 对外常量 / 小工具 (纯)
// ---------------------------------------------------------------------------

/** 出现这些片段 = 依赖临时路径 (跨机器重放必挂) */
export const TEMP_PATH_HINTS = [
  '/tmp/',
  '/var/tmp/',
  '/var/folders/',
  '/private/tmp/',
  '\\temp\\',
  'tmpdir',
] as const;

/** 该引用是否指向临时路径 */
export function looksLikeTempPath(ref: string): boolean {
  const t = typeof ref === 'string' ? ref.toLowerCase() : '';
  if (t.trim().length === 0) return false;
  return TEMP_PATH_HINTS.some((h) => t.includes(h)) || t.startsWith('/tmp');
}

/** 已有 Skill 的最小身份 (与 §14 冻结签名一致) */
export interface ExistingSkillIdentity {
  name: string;
  contentHash: string;
  version: string;
}

/** `assessCandidate` 的返回 (与 §14 冻结签名一致) */
export interface CandidateAssessment {
  junkReasons: SkillJunkReason[];
  promotable: boolean;
  comparison: 'new' | 'duplicate' | 'version_bump';
}

const NON_EMPTY = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isValidIso(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim().length === 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return false;
  return Number.isFinite(Date.parse(v));
}

/**
 * 「防 Skill 垃圾」判定。`existing` 只用于 `duplicate_of_existing` —— 因此
 * `draftPromotion` 传空数组复算时**刻意**查不出重复 (重复要靠注册表, 这一条由 `assessCandidate` 负责)。
 */
export function deriveJunkReasons(
  c: SkillImprovementCandidate,
  existing: ExistingSkillIdentity[],
): SkillJunkReason[] {
  const out: SkillJunkReason[] = [];
  const push = (r: SkillJunkReason): void => {
    if (!out.includes(r)) out.push(r);
  };

  // 只成功一次 → 偶然成功, 不许转正 (P5 强负例 8)
  if (!Number.isFinite(c.occurrences) || c.occurrences < 2) push('single_success');

  // 无明确输入输出
  if (!NON_EMPTY(c.inputSchema) || !NON_EMPTY(c.outputSchema)) push('no_io_schema');

  // 无失败边界
  if (len(c.failureCases) === 0) push('no_failure_boundary');

  // 依赖临时路径
  const refs = [...(Array.isArray(c.evidenceRefs) ? c.evidenceRefs : []), ...(Array.isArray(c.sourceRunIds) ? c.sourceRunIds : [])];
  if (refs.some((r) => looksLikeTempPath(r))) push('temp_path_dependency');

  // 结果不可验证: 没证据 / 没草案哈希 / 只声明保证却不声明边界
  if (len(c.evidenceRefs) === 0) push('unverifiable_result');
  if (!NON_EMPTY(c.contentHash)) push('unverifiable_result');
  if (len(c.guarantees) === 0) push('unverifiable_result');
  if (len(c.doesNotGuarantee) === 0) push('unverifiable_result');

  // 只是一句经验: 除了名字/目的以外什么都没有
  if (len(c.failureCases) === 0 && !NON_EMPTY(c.inputSchema) && !NON_EMPTY(c.outputSchema) && len(c.guarantees) === 0) {
    push('one_line_experience');
  }

  // 与已有 Skill 完全重复 (同名 + 同 contentHash)
  const dup = existing.some((e) => e.name === c.name && NON_EMPTY(c.contentHash) && e.contentHash === c.contentHash);
  if (dup) push('duplicate_of_existing');

  return out;
}

// ---------------------------------------------------------------------------
// §14 冻结签名 ①: assessCandidate
// ---------------------------------------------------------------------------

/**
 * 评估一个 Skill 改进候选: 命中哪些垃圾理由 / 能不能晋升 / 与现有 Skill 是什么关系。
 *
 * `promotable` 的含义是「过了垃圾门 + 边界清晰」, **不等于已批准** ——
 * `approve` 与 `write_content_hash_and_change_reason` 是流程里后面的步骤。
 */
export function assessCandidate(
  c: SkillImprovementCandidate,
  existing: ExistingSkillIdentity[],
): CandidateAssessment {
  const registry = Array.isArray(existing) ? existing : [];
  const junkReasons = deriveJunkReasons(c, registry);

  const same = registry.find((e) => e.name === c.name);
  let comparison: CandidateAssessment['comparison'];
  if (!same) comparison = 'new';
  else if (NON_EMPTY(c.contentHash) && same.contentHash === c.contentHash) comparison = 'duplicate';
  else comparison = 'version_bump';

  const promotable = junkReasons.length === 0 && c.boundaryClear === true;

  return { junkReasons, promotable, comparison };
}

// ---------------------------------------------------------------------------
// §14 冻结签名 ②: draftPromotion
// ---------------------------------------------------------------------------

/** 版本推进: `null → 1.0.0`; `x.y.z → x.(y+1).0`; 非 semver → `1.0.0` */
export function bumpSkillVersion(fromVersion: string | null): string {
  if (!NON_EMPTY(fromVersion)) return '1.0.0';
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(fromVersion.trim());
  if (!m) return '1.0.0';
  return `${Number(m[1])}.${Number(m[2]) + 1}.0`;
}

/**
 * 构造正式 Skill 变更记录 (批准后才写; 带 contentHash 与变更原因)。
 *
 * 签名 (§14) 无法表达失败, 所以任何"不该晋升"的输入一律**抛错**, 不返回假记录:
 *   - `approvedBy` / `changeReason` / `now` / 候选的 `contentHash` 缺一即抛
 *   - 候选命中垃圾理由 (含调用方没写进 `junkReasons` 的那些, 本函数自行重算) 即抛
 *   - `boundaryClear !== true` 即抛 (边界不清的候选不许成为正式 Skill)
 */
export function draftPromotion(
  c: SkillImprovementCandidate,
  existingVersion: string | null,
  changeReason: string,
  approvedBy: string,
  now: IsoTimestamp,
): SkillPromotionRecord {
  if (!NON_EMPTY(approvedBy)) {
    throw new Error('draftPromotion: approvedBy 必填 (没有批准人不许写正式变更记录)');
  }
  if (!NON_EMPTY(changeReason)) {
    throw new Error('draftPromotion: changeReason 必填 (正式变更必须带变更原因)');
  }
  if (!isValidIso(now)) {
    throw new Error(`draftPromotion: now 必须是合法 ISO 时间戳 (收到 ${JSON.stringify(now)})`);
  }
  if (!NON_EMPTY(c.contentHash)) {
    throw new Error('draftPromotion: contentHash 必填 (没有草案哈希不许写正式变更记录)');
  }

  // 防御性重算: 不信调用方传进来的 junkReasons (duplicate 需注册表, 这里查不到)
  const junk = uniq([...(Array.isArray(c.junkReasons) ? c.junkReasons : []), ...deriveJunkReasons(c, [])]);
  if (junk.length > 0) {
    throw new Error(`draftPromotion: 候选命中垃圾理由, 不得晋升: ${junk.join(', ')}`);
  }
  if (c.boundaryClear !== true) {
    throw new Error('draftPromotion: boundaryClear 必须为 true (边界不清的候选不得晋升)');
  }

  return {
    skillName: c.name,
    fromVersion: NON_EMPTY(existingVersion) ? existingVersion : null,
    toVersion: bumpSkillVersion(existingVersion),
    contentHash: c.contentHash,
    changeReason,
    sourceRunIds: [...(c.sourceRunIds ?? [])],
    evidenceRefs: [...(c.evidenceRefs ?? [])],
    failureCases: [...(c.failureCases ?? [])],
    inputSchema: c.inputSchema,
    outputSchema: c.outputSchema,
    guarantees: [...(c.guarantees ?? [])],
    doesNotGuarantee: [...(c.doesNotGuarantee ?? [])],
    approval: {
      state: 'approved',
      approvedBy,
      approvedAt: now,
      changeReason,
    },
    /** 自动更新不覆盖正在执行的 Skill snapshot (类型级陈述) */
    snapshotScope: 'next_run_only',
    promotedAt: now,
  };
}
