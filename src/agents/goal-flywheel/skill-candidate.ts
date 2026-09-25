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

// ============================================================================
// P1b ② Skill 升级通道 (M2 接线, 2026-09-26)
// ============================================================================
//
// 一条 Skill 从「评审里的一句话」变成「正式 Skill」必须走六个阶段, 一个都不许跳
// (阶段的固定顺序由 `SKILL_CHANNEL_STAGES` 钉住):
//
//   ① `structure`          结构化    —— 冻结契约的必备字段齐全, 且不命中垃圾理由
//   ② `schema_validation`  schema    —— 输入输出契约是**能用的契约** (不是占位符/残破文本)
//   ③ `dedup`              去重      —— 与已有 Skill 不重复; 同一批候选之间也不许重复
//   ④ `permission`         安全权限  —— 请求者身份合法 + 草案不带危险面
//                                      (写正式 skills 目录 / 凭证面 / 提权动作)
//   ⑤ `trial_snapshot`    快照试用  —— `snapshotScope='next_run_only'`: 只影响**下一次** Run,
//                                      绝不覆盖正在执行的那份 snapshot
//   ⑥ `reuse_confirmation` 复用确认  —— **下一条 Run 真的成功复用它 (带证据) 之后**才提升;
//                                      同一条 Run 自己说自己成功不算; 复用失败/无证据 → 不提升
//
// 为什么准入与提升必须是两个出口 (`openSkillTrial` / `settleSkillTrial`):
//   一旦合成一处, "谁负责确认它真的被复用过"就没有归属 —— 于是"评审说好就转正"会以
//   "反正评估过了"的样子混进来。`openSkillTrial` 只**准入** (它返回的 `promotion` 恒为 `null`),
//   提升的唯一出口是 `settleSkillTrial`, 且它不信任调用方传进来的字段: 自己复核内容哈希,
//   自己重算垃圾门 (与 `draftPromotion` 的防御性重算同一手法)。
//
// 与其他模块的关系: 本段**零 I/O**、不读钟 (时间一律 `now` 注入), 注册表/候选/复用事实全部
//   由参数传入 —— 因此同一个判据既能被收尾接线层在"候选刚被提取出来"时调用 (准入),
//   也能在**下一条 Run 的成功点**上被调用 (结算)。

/** 六个阶段的**固定顺序** (少一个 = 通道被跳过) */
export const SKILL_CHANNEL_STAGES = [
  'structure',
  'schema_validation',
  'dedup',
  'permission',
  'trial_snapshot',
  'reuse_confirmation',
] as const;
export type SkillChannelStage = (typeof SKILL_CHANNEL_STAGES)[number];

export const SKILL_CHANNEL_STAGE_TEXT: Record<SkillChannelStage, string> = {
  structure: '结构化: 冻结契约必备字段齐全, 且不命中垃圾理由',
  schema_validation: 'schema 校验: 输入输出契约可用 (不是占位符/残破文本)',
  dedup: '去重: 不与已有 Skill 重复, 同批候选之间也不许重复',
  permission: '安全权限: 请求者身份合法 + 草案不带危险面 (正式 skills 目录/凭证/提权)',
  trial_snapshot: 'next_run_only 快照试用: 只影响下一次 Run, 不覆盖正在执行的 snapshot',
  reuse_confirmation: '复用确认: 下一条 Run 真的成功复用它 (带证据) 之后才提升',
};

/** 阶段裁决只有四种 —— `pending` / `not_reached` 也是**如实**的结论, 不许当成 pass */
export const SKILL_CHANNEL_STAGE_STATUSES = ['pass', 'refused', 'pending', 'not_reached'] as const;
export type SkillChannelStageStatus = (typeof SKILL_CHANNEL_STAGE_STATUSES)[number];

export interface SkillChannelStageVerdict {
  stage: SkillChannelStage;
  status: SkillChannelStageStatus;
  reason: string;
}

export interface SkillChannelRefusal {
  stage: SkillChannelStage;
  reason: string;
}

/** 谁能请求"开一次试用" */
export const SKILL_CHANNEL_ACTORS = ['human', 'supervisor', 'runner', 'closure'] as const;
export type SkillChannelActor = (typeof SKILL_CHANNEL_ACTORS)[number];

/**
 * 认识但**不许**开试用的主体。
 *
 * `child_agent`: 子 Agent 不能给自己的产出开试用 —— 试用是通向正式 Skill 的第一步, 而子 Agent
 * 越界清单 (`CHILD_PROHIBITIONS.mutate_parent_goal_state` / `mark_unverified_as_complete`) 的精神
 * 正是"不许自己给自己盖章"。子 Agent 可以**提**候选, 由父/宿主开试用。
 */
export const SKILL_CHANNEL_FORBIDDEN_ACTORS = ['child_agent'] as const;

/** 试用记录 (准入后产生; 提升与否由 `settleSkillTrial` 决定) */
export interface SkillTrialRecord {
  trialId: string;
  skillName: string;
  candidateId: string;
  /** 试用的是**哪一份内容** (没有它就没法证明"复用的就是这一份") */
  contentHash: string;
  fromVersion: string | null;
  toVersion: string;
  /** 只影响**下一次** Run (类型级陈述) */
  snapshotScope: 'next_run_only';
  /** 绝不覆盖正在执行的那一份 (类型上是 false, 运行期也复核) */
  appliesToRunningRun: false;
  /** 开试用时**正在运行**的那份 snapshot 哈希 (可核验: 试用没有动它) */
  runningSnapshotHash: string | null;
  status: 'trialing' | 'promoted' | 'rolled_back';
  startedAt: IsoTimestamp;
  startedBy: SkillChannelActor;
  /** 哪条 Run 提的这份候选 (试用必须能追到 Run) */
  startedByRunId: string;
  /** 兑现试用的那**下一条** Run (还没兑现时 null) */
  trialRunId: string | null;
  /** 成功复用的可核验证据 (空数组 = 还没被验证复用过 → 不许提升) */
  reuseEvidenceRefs: string[];
  reason: string;
}

export interface SkillChannelAdmission {
  ok: boolean;
  /** 六个阶段逐条裁决 (含 `not_reached`: 不许静默省略) */
  stages: SkillChannelStageVerdict[];
  refusal: SkillChannelRefusal | null;
  /** 准入后开的试用记录; 未准入为 null */
  trial: SkillTrialRecord | null;
  /** 准入**不是**晋升: 这个字段恒为 null (类型级陈述在运行期也成立) */
  promotion: null;
}

// ---------------------------------------------------------------------------
// ② schema 校验 (纯)
// ---------------------------------------------------------------------------

export const SKILL_SCHEMA_MIN_LENGTH = 3;
/** 这些"契约"等于没写 (占位的形状太多, 所以列成清单, 不靠长度猜) */
export const SKILL_SCHEMA_PLACEHOLDERS = [
  'tbd', 'todo', 'n/a', 'na', 'none', 'null', 'undefined', 'unknown', 'any', 'x', '-', '--',
  '...', '???', '待定', '随便', '无', '未定', '略',
] as const;

export const SKILL_CONTRACT_SIGNALS = ['json_object', 'object_literal', 'named_contract', 'described_contract'] as const;
export type SkillContractSignal = (typeof SKILL_CONTRACT_SIGNALS)[number];

export interface SkillContractVerdict {
  ok: boolean;
  signal: SkillContractSignal | null;
  reason: string | null;
}

const IDENT_TOKEN = /[A-Za-z_][A-Za-z0-9_./-]*/;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/**
 * 校验一份输入/输出契约够不够"能用"。
 *
 * 它比 `deriveJunkReasons` 的 `no_io_schema` (只看非空) 严一档, 但刻意**不**要求是合法 JSON:
 * 本仓真实的契约既有 JSON Schema 文本, 也有对象字面量形状的简写 (`{ criteria: string[] }`)
 * 与命名契约 (`bolloon-probe-input/1`) —— 把合法形状误杀, 门就会被人用"放宽判据"解决掉。
 * 所以只拦三类**确实没用**的东西:
 *   空 / 占位符 (TBD 这种) · 括号残缺 (`{ criteria: string[]` 用不了) · 没有任何可指认的字段名。
 */
export function validateSkillContract(text: unknown, which: 'input' | 'output'): SkillContractVerdict {
  const where = `${which}_schema`;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, signal: null, reason: `${where}_empty: 契约是空的` };
  }
  const t = text.trim();
  if (t.length < SKILL_SCHEMA_MIN_LENGTH) {
    return { ok: false, signal: null, reason: `${where}_too_short: 比 ${SKILL_SCHEMA_MIN_LENGTH} 个字符还短, 说不清契约` };
  }
  if ((SKILL_SCHEMA_PLACEHOLDERS as readonly string[]).includes(t.toLowerCase())) {
    return { ok: false, signal: null, reason: `${where}_placeholder: "${t}" 是占位符, 不是契约` };
  }
  if (
    countChar(t, '{') !== countChar(t, '}') ||
    countChar(t, '(') !== countChar(t, ')') ||
    countChar(t, '[') !== countChar(t, ']')
  ) {
    return { ok: false, signal: null, reason: `${where}_unbalanced: "${t}" 括号不配对 (残缺的契约用不了)` };
  }
  if (!IDENT_TOKEN.test(t)) {
    return { ok: false, signal: null, reason: `${where}_no_named_field: "${t}" 里没有任何可指认的字段名/类型名` };
  }
  const first = t[0];
  if (first === '{' || first === '[') {
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, signal: 'json_object', reason: null };
      }
    } catch {
      // 不是 JSON —— 不一定不是契约 (对象字面量简写是本仓常见的写法)
    }
    return { ok: true, signal: 'object_literal', reason: null };
  }
  if (/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(t)) return { ok: true, signal: 'named_contract', reason: null };
  return { ok: true, signal: 'described_contract', reason: null };
}

// ---------------------------------------------------------------------------
// ④ 安全权限: 危险面清单 (纯)
// ---------------------------------------------------------------------------

export interface ForbiddenSurface {
  id: string;
  pattern: RegExp;
  why: string;
  /** 扫哪些字段: `contract` = 契约面; `any` = 草案任何地方 */
  scope: 'contract' | 'any';
}

/**
 * 试用**不许带**的三类面。清单刻意很短 —— 每加一条都可能误杀合法草案, 而误杀会让人用
 * "放宽判据"来解 (那时真信号也被一起埋掉)。所以只放三类没有争议的:
 *   ① 草案直接指向正式 Skill 目录 → 那就是绕过"验证+快照+可回退"通道;
 *   ② 草案依赖凭证面 → 凭证永不进 Skill (连描述都不该进产物);
 *   ③ 草案带提权动作 → 试用期不许带提权面。
 */
export const FORBIDDEN_TRIAL_SURFACES: readonly ForbiddenSurface[] = [
  {
    id: 'writes_formal_skill_dir',
    pattern: /\.bolloon\/skills\b/,
    why: '草案指向正式 Skill 目录 → 绕过 验证+快照+可回退 通道',
    scope: 'any',
  },
  {
    id: 'credential_path',
    pattern: /(llm-config\.json|credentials?\.json|id_rsa|\.ssh\/|keychain|\.env\b)/i,
    why: '草案依赖凭证面 → 凭证永不进 Skill',
    scope: 'contract',
  },
  {
    id: 'privilege_escalation',
    pattern: /(\bsudo\b|chmod\s+777|\bsetuid\b|\brunas\b)/i,
    why: '草案带提权动作 → 试用不许带提权面',
    scope: 'contract',
  },
];

export interface ForbiddenSurfaceHit {
  id: string;
  where: string;
  why: string;
}

/** 扫一份候选草案有没有踩危险面; 返回空数组 = 没踩 */
export function scanForbiddenTrialSurfaces(c: Partial<SkillImprovementCandidate> | null | undefined): ForbiddenSurfaceHit[] {
  const contractFields: [string, string][] = [
    ['name', String(c?.name ?? '')],
    ['purpose', String(c?.purpose ?? '')],
    ['inputSchema', String(c?.inputSchema ?? '')],
    ['outputSchema', String(c?.outputSchema ?? '')],
    ['guarantees', (c?.guarantees ?? []).join(' | ')],
    ['doesNotGuarantee', (c?.doesNotGuarantee ?? []).join(' | ')],
    ['failureCases', (c?.failureCases ?? []).join(' | ')],
  ];
  const anyFields: [string, string][] = [
    ...contractFields,
    ['evidenceRefs', (c?.evidenceRefs ?? []).join(' | ')],
    ['sourceRunIds', (c?.sourceRunIds ?? []).join(' | ')],
  ];

  const out: ForbiddenSurfaceHit[] = [];
  for (const surface of FORBIDDEN_TRIAL_SURFACES) {
    for (const [where, text] of surface.scope === 'any' ? anyFields : contractFields) {
      if (!text) continue;
      if (surface.pattern.test(text)) {
        out.push({ id: surface.id, where, why: surface.why });
        break; // 同一类面只报一次 (原因清单要读得完)
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① 结构化的必备字段 (冻结契约里**不许为空**的那些)
// ---------------------------------------------------------------------------

/** 冻结契约里必须非空的**文本**字段 (缺一个 = 候选不结构化, 不许进通道) */
export const CANDIDATE_REQUIRED_TEXT_FIELDS = ['name', 'purpose', 'inputSchema', 'outputSchema', 'contentHash'] as const;
/** 必须非空的**清单**字段 */
export const CANDIDATE_REQUIRED_LIST_FIELDS = ['sourceRunIds', 'evidenceRefs', 'failureCases', 'guarantees', 'doesNotGuarantee'] as const;

/** 返回空数组 = 结构化通过; 否则返回缺/不合格的字段名 (结构化原因, 不是 boolean) */
export function structureMissingFields(c: Partial<SkillImprovementCandidate> | null | undefined): string[] {
  if (!c || typeof c !== 'object') return ['(candidate)'];
  const missing: string[] = [];
  for (const f of CANDIDATE_REQUIRED_TEXT_FIELDS) {
    const v = c[f];
    if (typeof v !== 'string' || v.trim().length === 0) missing.push(f);
  }
  for (const f of CANDIDATE_REQUIRED_LIST_FIELDS) {
    const v = c[f];
    if (!Array.isArray(v) || v.length === 0) missing.push(f);
  }
  if (!Number.isFinite(c.occurrences) || Number(c.occurrences) < 2) missing.push('occurrences>=2');
  if (c.boundaryClear !== true) missing.push('boundaryClear=true');
  return missing;
}

// ---------------------------------------------------------------------------
// ①–⑤ 准入: openSkillTrial
// ---------------------------------------------------------------------------

export interface SkillTrialInput {
  candidate: SkillImprovementCandidate;
  /** 已有 Skill 身份 (注册表); 空数组 = 拿不到注册表 → 只做批内去重 (不假装"不重复") */
  existing?: ExistingSkillIdentity[];
  /** 同一批里**排在前面**的候选 (批内去重: 同名第二次不许再开一次试用) */
  siblings?: readonly SkillImprovementCandidate[];
  /** 谁在请求开试用 */
  requestedBy: string;
  /** 开试用时正在运行的那份 snapshot 哈希 (可核验试用没动它; 拿不到就 null) */
  runningSnapshotHash?: string | null;
  now: IsoTimestamp;
}

function emptyStageVerdicts(): Record<SkillChannelStage, SkillChannelStageVerdict> {
  const out = {} as Record<SkillChannelStage, SkillChannelStageVerdict>;
  for (const s of SKILL_CHANNEL_STAGES) out[s] = { stage: s, status: 'not_reached', reason: 'not_reached' };
  return out;
}

/**
 * 通道 ①–⑤: 把一份候选**准入到试用位**。返回的 `promotion` 恒为 `null` —— 准入不是晋升。
 *
 * 六个阶段**逐条**给出裁决 (被拒之后的下游阶段是 `not_reached`, 不是"省略") ——
 * 因为"哪一步拒的、后面还有哪些步没走"本身就是给人看的事实。
 */
export function openSkillTrial(input: SkillTrialInput): SkillChannelAdmission {
  const c = (input?.candidate ?? null) as SkillImprovementCandidate | null;
  const now = input?.now;
  const registry = Array.isArray(input?.existing) ? input.existing : [];
  const siblings = Array.isArray(input?.siblings) ? input.siblings : [];
  const verdicts = emptyStageVerdicts();
  let refusal: SkillChannelRefusal | null = null;
  let trial: SkillTrialRecord | null = null;

  const pass = (stage: SkillChannelStage, reason: string): void => {
    verdicts[stage] = { stage, status: 'pass', reason };
  };
  const refuse = (stage: SkillChannelStage, reason: string): void => {
    verdicts[stage] = { stage, status: 'refused', reason };
    refusal = { stage, reason };
  };
  const finish = (): SkillChannelAdmission => {
    const why = refusal ? `被 ${(refusal as SkillChannelRefusal).stage} 阶段拦住` : '';
    for (const s of SKILL_CHANNEL_STAGES) {
      if (verdicts[s].status === 'not_reached') verdicts[s].reason = `not_reached: ${why}`;
    }
    return {
      ok: refusal === null,
      stages: SKILL_CHANNEL_STAGES.map((s) => verdicts[s]),
      refusal,
      trial,
      promotion: null,
    };
  };

  // 时间必须注入且合法 (本模块不读真实钟)
  if (!isValidIso(now)) {
    verdicts.trial_snapshot = {
      stage: 'trial_snapshot',
      status: 'refused',
      reason: 'invalid_now: 试用时间必须是合法 ISO 时间戳 (时间由调用方注入, 不许读真实钟)',
    };
    refusal = { stage: 'trial_snapshot', reason: 'invalid_now: 时间由调用方注入, 不许读真实钟' };
    return finish();
  }

  if (!c) {
    refuse('structure', 'structure_incomplete: 候选缺失 (拿不到候选就没有"结构化"可言)');
    return finish();
  }

  // ── ① 结构化 ─────────────────────────────────────────────────────────────
  const missing = structureMissingFields(c);
  if (missing.length > 0) {
    refuse('structure', `structure_incomplete: 必备字段为空/不合格: ${missing.join(', ')}`);
  } else {
    const junk = deriveJunkReasons(c, registry);
    if (junk.length > 0) {
      refuse('structure', `structure_junk: 命中垃圾理由: ${junk.join(', ')} (偶然成功/无 IO 契约/无失败边界/结果不可验证都不得进通道)`);
    } else {
      pass('structure', `冻结契约必备字段齐全 (occurrences=${c.occurrences}, boundaryClear=${c.boundaryClear === true})`);
    }
  }

  // ── ② schema 校验 ────────────────────────────────────────────────────────
  if (!refusal) {
    const inV = validateSkillContract(c.inputSchema, 'input');
    const outV = validateSkillContract(c.outputSchema, 'output');
    if (!inV.ok) refuse('schema_validation', inV.reason ?? 'input_schema_invalid');
    else if (!outV.ok) refuse('schema_validation', outV.reason ?? 'output_schema_invalid');
    else pass('schema_validation', `契约可用: input=${inV.signal}, output=${outV.signal}`);
  }

  // ── ③ 去重 ───────────────────────────────────────────────────────────────
  if (!refusal) {
    const sameName = registry.find((e) => e.name === c.name);
    const batchDup = siblings.find((s) => String(s?.name ?? '') === c.name);
    if (sameName && NON_EMPTY(c.contentHash) && sameName.contentHash === c.contentHash) {
      refuse('dedup', `duplicate_of_existing: 与已有 Skill ${c.name} 内容完全相同 (contentHash=${c.contentHash}) → 不需要新版本`);
    } else if (batchDup) {
      refuse('dedup', `duplicate_in_batch: 同一批里已有同名候选 ${c.name} → 一次收尾只开一次试用`);
    } else {
      const comparison = assessCandidate(c, registry).comparison;
      pass('dedup', sameName ? `与已有 Skill ${c.name} 同名但内容不同 → ${comparison}` : '新 Skill (注册表里没有同名项)');
    }
  }

  // ── ④ 安全权限 ───────────────────────────────────────────────────────────
  if (!refusal) {
    const actor = String(input?.requestedBy ?? '');
    if ((SKILL_CHANNEL_FORBIDDEN_ACTORS as readonly string[]).includes(actor)) {
      refuse('permission', 'child_cannot_open_trial: 子 Agent 不能给自己的产出开试用 (提候选可以, 开试用由父/宿主做)');
    } else if (!(SKILL_CHANNEL_ACTORS as readonly string[]).includes(actor)) {
      refuse('permission', `unknown_actor: "${actor}" 不是已知请求者 (只认 ${SKILL_CHANNEL_ACTORS.join('/')})`);
    } else {
      const hits = scanForbiddenTrialSurfaces(c);
      if (hits.length > 0) {
        refuse('permission', `forbidden_surface: ${hits.map((h) => `${h.id}@${h.where}`).join(', ')}; ${hits[0].why}`);
      } else {
        pass('permission', `请求者=${actor}; 草案未踩危险面 (正式 skills 目录/凭证/提权)`);
      }
    }
  }

  // ── ⑤ next_run_only 快照试用 ─────────────────────────────────────────────
  if (!refusal) {
    const hash = String(c.contentHash ?? '').trim();
    const proposedByRunId = String(c.proposedByRunId ?? '').trim();
    if (!proposedByRunId) {
      refuse('trial_snapshot', 'trial_without_run_id: 候选说不清是哪条 Run 提的 → 试用无法被兑现');
    } else if (!hash) {
      refuse('trial_snapshot', 'trial_without_content_hash: 没有草案哈希 → 无法证明复用/提升的是同一份内容');
    } else {
      const runningSnapshotHash = typeof input?.runningSnapshotHash === 'string' ? input.runningSnapshotHash : null;
      const same = registry.find((e) => e.name === c.name)?.version ?? null;
      trial = {
        trialId: `trial:${c.candidateId}`,
        skillName: c.name,
        candidateId: c.candidateId,
        contentHash: hash,
        fromVersion: same,
        toVersion: bumpSkillVersion(same),
        snapshotScope: 'next_run_only',
        appliesToRunningRun: false,
        runningSnapshotHash,
        status: 'trialing',
        startedAt: now,
        startedBy: input.requestedBy as SkillChannelActor,
        startedByRunId: proposedByRunId,
        trialRunId: null,
        reuseEvidenceRefs: [],
        reason: '试用已开: 只影响下一次 Run (scope=next_run_only, appliesToRunningRun=false); 在**下一条 Run** 成功复用并带证据之前不得提升',
      };
      pass('trial_snapshot', trial.reason);
    }
  }

  // ── ⑥ 复用确认 (准入时**只能**是 pending: 兑现要等下一条 Run) ─────────────
  if (!refusal && trial) {
    verdicts.reuse_confirmation = {
      stage: 'reuse_confirmation',
      status: 'pending',
      reason: 'pending_next_run_reuse: 提升的唯一出口是 settleSkillTrial (下一条 Run 成功复用并带证据; 同一条 Run 自己说自己成功不算)',
    };
  }

  return finish();
}

// ---------------------------------------------------------------------------
// ⑥ 结算: settleSkillTrial (提升的唯一出口)
// ---------------------------------------------------------------------------

export interface SkillTrialReuse {
  /** 复用它的那一条 Run —— 必须**不是**开试用时的那一条 */
  runId: string;
  succeeded: boolean;
  /** 成功复用的**可核验证据** (空数组 = 无证据, 不算成功) */
  evidenceRefs?: string[];
  /** 提升必须有人/主体批准 + 变更原因 (正式变更的必备项, 不设默认) */
  approvedBy: string;
  changeReason: string;
  now: IsoTimestamp;
}

export interface SkillTrialSettlement {
  ok: boolean;
  /** 结算依据的是通道哪个阶段 */
  stage: SkillChannelStage;
  status: SkillTrialRecord['status'];
  /** 结算后的试用记录 (回退/仍未兑现时 status 保持真相) */
  trial: SkillTrialRecord;
  /** 真的提升时才有 (否则 null) */
  promotion: SkillPromotionRecord | null;
  reason: string;
}

/**
 * 通道 ⑥: **下一条 Run 成功复用之后**才结算。
 *
 * 只有一种输入会产出 `promotion`: 试用在 `trialing` + 复用的是**另一条** Run + 复用成功 +
 * 带可核验证据 + 待提升的候选与试用记录是同一份内容 + 提升带批准人与变更原因。
 * 其余一律**不提升**, 并如实给出结构化原因 (复用失败 → `rolled_back`; 无证据 → 留在 `trialing`)。
 */
export function settleSkillTrial(input: {
  trial: SkillTrialRecord;
  candidate: SkillImprovementCandidate;
  reuse: SkillTrialReuse;
}): SkillTrialSettlement {
  const trial = input?.trial as SkillTrialRecord;
  if (!trial || typeof trial !== 'object' || typeof trial.status !== 'string') {
    throw new Error('settleSkillTrial: trial 必填 (没有试用记录就没有"结算"这回事)');
  }
  const c = (input?.candidate ?? null) as SkillImprovementCandidate | null;
  const reuse = input?.reuse;

  const keep = (status: SkillTrialRecord['status'], reason: string): SkillTrialSettlement => ({
    ok: false,
    stage: 'reuse_confirmation',
    status,
    trial: { ...trial, status, reason },
    promotion: null,
    reason,
  });

  if (trial.status !== 'trialing') {
    return {
      ok: false,
      stage: 'reuse_confirmation',
      status: trial.status,
      trial,
      promotion: null,
      reason: `not_trialing: 试用状态已是 ${trial.status} → 不许重复结算`,
    };
  }
  const reuseRunId = String(reuse?.runId ?? '');
  if (!reuseRunId || reuseRunId === trial.startedByRunId) {
    return keep(
      'trialing',
      `same_run_cannot_promote: 试用的"下次复用"必须是**另一条** Run (试用由 ${trial.startedByRunId} 开, 收到 ${reuseRunId || '(空)'})`,
    );
  }
  if (!reuse.succeeded) {
    return keep('rolled_back', `trial_reuse_failed: 下一条 Run (${reuseRunId}) 复用失败 → 回退, 不提升`);
  }
  const evidence = (reuse.evidenceRefs ?? []).filter((x) => NON_EMPTY(x));
  if (evidence.length === 0) {
    return keep('trialing', 'reuse_without_evidence: 复用没有可核验证据 → 无证据不算成功 (与"无证据不许判目标完成"同一纪律), 留在试用位');
  }
  const hash = String(c?.contentHash ?? '').trim();
  if (!hash || hash !== trial.contentHash) {
    return keep('trialing', `candidate_content_hash_mismatch: 待提升的候选 (${hash || '(空)'}) 与试用记录 (${trial.contentHash}) 不是同一份内容 → 不许换内容冒充`);
  }

  let promotion: SkillPromotionRecord;
  try {
    promotion = draftPromotion(c as SkillImprovementCandidate, trial.fromVersion, reuse.changeReason, reuse.approvedBy, reuse.now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return keep('trialing', `promotion_refused: ${msg}`);
  }

  const settled: SkillTrialRecord = {
    ...trial,
    status: 'promoted',
    trialRunId: reuseRunId,
    reuseEvidenceRefs: evidence,
    reason: `下一条 Run (${reuseRunId}) 成功复用并带 ${evidence.length} 条证据 → 提升为 ${promotion.toVersion} (变更原因: ${reuse.changeReason}; 批准人: ${reuse.approvedBy})`,
  };
  return { ok: true, stage: 'reuse_confirmation', status: 'promoted', trial: settled, promotion, reason: settled.reason };
}

/** 通道的纪律 (给接线层/门引用, 不在这里重写第二遍) */
export const SKILL_TRIAL_RULES = [
  '准入不是晋升: openSkillTrial 的 promotion 恒为 null, 提升的唯一出口是 settleSkillTrial',
  '试用的"下次复用"必须是另一条 Run: 同一条 Run 自己说自己成功不算',
  '复用必须带可核验证据: 无证据不算成功, 留在试用位',
  '复用失败 → 回退 (rolled_back), 不提升',
  '提升必须带批准人与变更原因 (正式变更的必备项)',
  '试用范围恒为 next_run_only: 不覆盖正在执行的 Skill snapshot',
] as const;
