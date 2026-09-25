/**
 * goal-change.ts — P4 「新要求注入」的分诊 (triage) 与生效 (apply) 规则 (2026-09-25)
 *
 * 问题: 用户在长期执行中途说的话, 最容易被"顺手直接改掉当前 Run 的判据" —— 于是
 * 已发生的历史被悄悄改写, 子 Agent 还在按旧判据跑, 预算被 Agent 自己批大了。
 *
 * 本文件把「新要求」变成一条**可追溯的变更记录** + 一次**可审计的生效判定**:
 *   ① `ingestChange`   —— 逐字记录原文与来源 (不解析, 不改写, 不读真实钟)
 *   ② `classifyChange` —— 确定性启发式分类 (8 类) + 影响面 + 是否需重规划
 *   ③ `applyChange`    —— 决定"排入下一 Run / 待批准 / 不生效", 并给出下一 Run 指令
 *
 * 边界 (ownership, 见 docs/wiki/goal-continuation-flywheel.md §13–§14):
 *   · 纯函数: 不读真实钟 (`now` 一律注入) · 不做 I/O (不 import fs) · 不改写任何输入
 *   · **只**依赖冻结面 `./types.js` 的类型; 不 import 任何其它阶段的实现文件
 *   · 冻结的三个签名 (§14) 保持原样; 其余导出是本阶段新增的辅助面
 *   · 不写 store / 不改现有调用方: `applyChange` **只返回** 判定, 落库由接线层做
 *
 * 冻结面 5 条规则 (`GOAL_CHANGE_RULES`) 在本文件里的落点:
 *   1 user_revocation_wins          → 用户来源的 abort 在分类阶段**压过**同批其余意图;
 *                                     生效阶段必排入下一 Run, 且不增判据版本
 *   2 agent_cannot_approve_budget   → 非用户来源的"扩大/方向不明"预算变更**永不**返回
 *                                     `next_run` (只有可证明的**收紧**才放行)
 *   3 criteria_change_bumps_version → 只有「用户来源 + 完成判据变化」才 +1; 其余一律不动,
 *                                     且已排入/已生效的请求不许二次 +1
 *   4 history_not_rewritten         → 每条 `nextRunDirective` 都自带"只影响后续 Run"声明;
 *                                     纯函数不改写任何输入对象 (深冻结也能过)
 *   5 children_receive_new_version  → 每条 `nextRunDirective` 都带子 Agent 条款;
 *                                     `childChangeDirective` 给出逐 workId 的下发内容
 */

import { CHANGE_SOURCES } from './types.js';
import type {
  ChangeImpact,
  ChangeKind,
  ChangePriority,
  ChangeScope,
  ChangeSource,
  ChangeStatus,
  GoalChangeRequest,
  GoalChangeRule,
  IsoTimestamp,
} from './types.js';

// ============================================================================
// §0. 规则 id —— 直接引用冻结面 GOAL_CHANGE_RULES 的取值
//     (冻结面若改了枚举取值, 这里 `satisfies` 会编译失败, 而不是静默漂移)
// ============================================================================

const RULES = {
  revocation: 'user_revocation_wins',
  budget: 'agent_cannot_approve_budget',
  criteria: 'criteria_change_bumps_version',
  history: 'history_not_rewritten',
  children: 'children_receive_new_version',
} satisfies Record<string, GoalChangeRule>;

// ============================================================================
// §1. 确定性关键词表 (与 goal-criteria.ts 同一风格: 不依赖 LLM, 失败不伪造成功)
// ============================================================================

/** 撤销必须**指向目标本身**才成立 —— "取消预算上限"指预算, 不是撤销 (否则误杀目标) */
const ABORT_PATTERNS: RegExp[] = [
  /(撤销|终止|放弃|停掉|停止|取消)(掉|执行)?(这个|该|当前的)?(目标|任务|工作|活儿|活|计划|需求)/,
  /(别|不要|不用)(再)?继续(这个|该)?(目标|任务|工作|活儿)/,
  /^(不做了|别做了|算了)[。.!！]?$/,
  /\babort\b/,
  /cancel the (goal|task|work)/,
];

const CRITERIA_PATTERNS: RegExp[] = [
  /判据|完成标准|完成条件|验收标准|验收条件|判定标准|完成的定义|算完成|criteria|definition of done/,
];

/** 判据"重申" (不是改判据) 的用词 —— 用于把 criteria 意图降级为 clarification */
const CRITERIA_RESTATE_PATTERNS: RegExp[] = [
  /照旧|不变|保持|重申|强调|记住|再确认|确认一下|仍然|还是(按|用|以)/,
];

const CRITERIA_CHANGE_PATTERNS: RegExp[] = [
  /改成|改为|变更|变成|换成|替换|调整为|增加|新增|加上|再加|删掉|删除|去掉|不再|取消|降低标准|提高标准/,
];

const BUDGET_PATTERNS: RegExp[] = [
  /预算|budget|成本上限|花费上限|开销上限|最大轮次|轮次上限|maxruns|时限|deadline|时间上限|耗时上限/,
];

const BUDGET_INCREASE_PATTERNS: RegExp[] = [
  /提高|增加|加大|扩大|放宽|上调|提升|更多|增至|提到|取消上限|去掉上限|不限预算|取消预算(限制|上限)|延长/,
];

const BUDGET_DECREASE_PATTERNS: RegExp[] = [
  /降低|减少|减小|收紧|缩减|下调|缩短|压缩/,
];

const PERMISSION_PATTERNS: RegExp[] = [
  /权限|授权|permission|允许访问|允许使用|允许调用|禁止访问|禁止使用|工具白名单|可以访问/,
];

const SCOPE_EXPANSION_PATTERNS: RegExp[] = [
  /顺便|另外(也|要|再|还有)|还要|也要(把|做|改)|再多做|多做一点|扩展范围|扩大范围|范围扩大|额外(也)?要|多做一个/,
];

const SCOPE_REDUCTION_PATTERNS: RegExp[] = [
  /只做|只保留|只提交|只改|缩小范围|范围缩小|砍掉|先不做|不用做|减少范围|减掉|不做(这个|那)?部分/,
];

const PRIORITY_PATTERNS: RegExp[] = [
  /优先级|优先|先做|后做|提前|插队|加急|priority/,
];

const KIND_LABELS: Record<ChangeKind, string> = {
  clarification: '补充说明',
  priority_change: '优先级变化',
  success_criteria_change: '完成判据变化',
  budget_change: '预算变更',
  permission_change: '权限变更',
  scope_expansion: '范围扩大',
  scope_reduction: '范围缩小',
  abort: '撤销/终止',
};

/** 需要重规划的类别 (abort 是终止, 不重规划; clarification 不动计划) */
const REPLAN_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'priority_change',
  'success_criteria_change',
  'budget_change',
  'permission_change',
  'scope_expansion',
  'scope_reduction',
]);

/** 来源决定默认优先级 (用户最高; 撤销另有 user_revocation) */
const SOURCE_PRIORITY: Record<ChangeSource, ChangePriority> = {
  user: 'high',
  agent: 'normal',
  external: 'normal',
  system: 'low',
};

/** 生效判定的终态: 这三种状态再调 `applyChange` 一律拒绝 (幂等, 防重复增版本) */
const TERMINAL_STATUSES: readonly ChangeStatus[] = ['applied', 'scheduled_next_run', 'superseded'];

// ============================================================================
// §2. 小工具
// ============================================================================

function hasAny(text: string, pats: RegExp[]): boolean {
  return pats.some((p) => p.test(text));
}

function lower(s: unknown): string {
  return String(s ?? '').toLowerCase();
}

/** FNV-1a 指纹 (纯函数, 不引 crypto/不读钟: 同一输入必得同一 id, 便于去重) */
function fingerprint(parts: string[]): string {
  const s = parts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function head(s: string, n = 60): string {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 判据版本归一 (缺省/非法 → 1); **只做归一, 不做 +1** */
function normalizeVersion(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

function budgetBaseline(b: unknown): number | null {
  if (typeof b === 'number' && Number.isFinite(b)) return b;
  if (b && typeof b === 'object') {
    const rec = b as Record<string, unknown>;
    for (const k of ['maxRuns', 'deadlineMs', 'maxSteps', 'maxAmount']) {
      const v = rec[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

// ============================================================================
// §3. 意图探测 (导出: 接线层用它把一句话拆成多条变更)
// ============================================================================

/**
 * 从原话里探测**所有**变更意图 (不去重以外不做裁剪, 交给 `classifyChange` 做消歧)。
 * 返回空数组 = 没有可识别的变更意图 (即 `clarification`)。
 *
 * 刻意返回原文命中的**全部**意图: 一句话里出现两个不同领域的意图时,
 * 一个 `kind` 字段装不下 —— 宁可让人拆开重提, 也不许静默丢掉一条要求。
 */
export function detectChangeIntents(instruction: string): ChangeKind[] {
  const t = lower(instruction);
  const out: ChangeKind[] = [];
  if (hasAny(t, ABORT_PATTERNS)) out.push('abort');
  if (hasAny(t, CRITERIA_PATTERNS)) out.push('success_criteria_change');
  if (hasAny(t, BUDGET_PATTERNS)) out.push('budget_change');
  if (hasAny(t, PERMISSION_PATTERNS)) out.push('permission_change');
  if (hasAny(t, SCOPE_EXPANSION_PATTERNS)) out.push('scope_expansion');
  if (hasAny(t, SCOPE_REDUCTION_PATTERNS)) out.push('scope_reduction');
  if (hasAny(t, PRIORITY_PATTERNS)) out.push('priority_change');
  return out;
}

/** 判据相关的话是不是"重申既有判据"(而不是改判据) */
function isCriteriaRestatement(instruction: string, criteria: string[]): boolean {
  const t = lower(instruction);
  if (hasAny(t, CRITERIA_CHANGE_PATTERNS)) return false;
  if (hasAny(t, CRITERIA_RESTATE_PATTERNS)) return true;
  return criteria.some((c) => c.length >= 2 && t.includes(lower(c)));
}

// ============================================================================
// §4. 预算方向 (规则 2 的判定依据)
// ============================================================================

export type BudgetDirection = 'increase' | 'decrease' | 'unspecified';

export interface BudgetDelta {
  direction: BudgetDirection;
  /** 变更前的基准 (goal 里能读到才有) */
  from: number | null;
  /** 指令里能读到的新值 */
  to: number | null;
  /** 凭什么这么判 (审计用; 判不出就是判不出, 不编) */
  basis: string;
}

/**
 * 判断预算变更是"扩大 / 收紧 / 判不出"。
 * 数值优先 (有基准可比大小); 否则看方向用词; 两者都判不出 → `unspecified`。
 * 注意: `applyChange` 拿不到 goal.budget, 因此生效阶段只能做**纯文本**判定 ——
 * 判不出时按"不得自动批准"保守处理 (见 §6)。
 */
export function detectBudgetDirection(instruction: string, goalBudget?: unknown): BudgetDelta {
  const t = lower(instruction);
  const nums = (t.match(/\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  const last = nums.slice(-1)[0];
  const to: number | null = typeof last === 'number' ? last : null;
  const from = budgetBaseline(goalBudget);
  const inc = hasAny(t, BUDGET_INCREASE_PATTERNS);
  const dec = hasAny(t, BUDGET_DECREASE_PATTERNS);

  if (from !== null && to !== null && from !== to) {
    return {
      direction: to > from ? 'increase' : 'decrease',
      from,
      to,
      basis: `数值比较: ${from} → ${to}`,
    };
  }
  if (inc && !dec) return { direction: 'increase', from, to, basis: '指令用词指向扩大' };
  if (dec && !inc) return { direction: 'decrease', from, to, basis: '指令用词指向收紧' };
  if (inc && dec) return { direction: 'unspecified', from, to, basis: '同时出现扩大与收紧用词 → 不猜' };
  return { direction: 'unspecified', from, to, basis: '既无可比数值, 也无明确方向用词 → 不猜 (保守按需批准)' };
}

/**
 * 这个变更是不是"放宽" —— 放宽只能由 principal (user) 决定。
 * agent 可以收紧 (预算变小 / 范围变小), 不能放宽 (扩预算 / 扩范围 / 加权限 / 改写"什么算完成" / 撤销目标)。
 */
export function isWidening(kind: ChangeKind, direction: BudgetDirection = 'unspecified'): boolean {
  switch (kind) {
    case 'abort':
    case 'success_criteria_change':
    case 'permission_change':
    case 'scope_expansion':
      return true;
    case 'budget_change':
      return direction !== 'decrease';
    default:
      return false;
  }
}

// ============================================================================
// §5. ① 记录 —— 原话逐字入档 (不解析)
// ============================================================================

/**
 * 接收一条新要求: **逐字**记录原文 + 来源 + 记录者 + 时间。
 * 不解析、不判断、不改写 —— 分类是 `classifyChange` 的事。
 *
 * `kind` 在未分诊时取最保守的 `clarification` (不改判据/不扩预算),
 * 且 `status='received'` 会让 `applyChange` 直接拒绝 —— 未分诊的变更不可能生效。
 *
 * @throws 当 goalId / instruction / recordedBy / now 缺失, 或 source 不是合法来源。
 */
export function ingestChange(input: {
  goalId: string;
  source: ChangeSource;
  instruction: string;
  recordedBy: string;
  now: IsoTimestamp;
}): GoalChangeRequest {
  const goalId = String(input?.goalId ?? '').trim();
  const instruction = typeof input?.instruction === 'string' ? input.instruction : '';
  const recordedBy = String(input?.recordedBy ?? '').trim();
  const now = String(input?.now ?? '').trim();
  if (!goalId) throw new Error('[goal-change] ingestChange: goalId 不能为空');
  if (!instruction.trim()) throw new Error('[goal-change] ingestChange: instruction 不能为空 (用户原话必须逐字记录)');
  if (!recordedBy) throw new Error('[goal-change] ingestChange: recordedBy 不能为空 (变更必须可追溯)');
  if (!now) throw new Error('[goal-change] ingestChange: now 必须由调用方注入 (本模块不读真实钟)');
  if (!CHANGE_SOURCES.includes(input.source)) {
    throw new Error(`[goal-change] ingestChange: 非法 source "${String(input.source)}" (合法: ${CHANGE_SOURCES.join('/')})`);
  }

  return {
    changeId: `chg_${fingerprint([goalId, input.source, instruction, recordedBy, now])}`,
    goalId,
    source: input.source,
    instruction, // 逐字: 不做 trim / 不做转义 (原文就是原文)
    interpreted: null,
    priority: SOURCE_PRIORITY[input.source],
    kind: 'clarification', // 未分诊前的保守占位, 不代表真分类
    scope: { kind: 'goal', targetIds: [goalId] },
    impact: {
      affectsObjective: false,
      affectsCriteria: false,
      affectsBudget: false,
      affectsPermission: false,
      affectedWorkIds: [],
    },
    effectiveAt: now, // 本飞轮语义: 最早生效点是"下一次 Run"
    requiresReplan: false,
    status: 'received',
    recordedAt: now,
    recordedBy,
    appliesToFutureRunsOnly: true,
  };
}

// ============================================================================
// §6. ② 分类 —— 8 类 + 影响面 + 是否需重规划
// ============================================================================

function impactFor(kind: ChangeKind, scope: ChangeScope): ChangeImpact {
  return {
    affectsObjective: kind === 'scope_expansion' || kind === 'scope_reduction' || kind === 'abort',
    affectsCriteria: kind === 'success_criteria_change',
    affectsBudget: kind === 'budget_change',
    affectsPermission: kind === 'permission_change',
    affectedWorkIds: scope.kind === 'child_work' ? [...new Set(scope.targetIds)] : [],
  };
}

const EMPTY_IMPACT = (scope: ChangeScope): ChangeImpact => impactFor('clarification', scope);

function describeKind(kind: ChangeKind, r: GoalChangeRequest, dir: BudgetDelta | null): string {
  switch (kind) {
    case 'abort':
      return `撤销/终止: 在下一个 Run 边界终止该目标 (优先级最高, 压过同批其余变更)`;
    case 'success_criteria_change':
      return `完成判据变化: **必须增版本号** (批准时 criteriaVersion +1); 本文不改写已在执行的 Run 历史`;
    case 'budget_change':
      return `预算变更 (方向=${dir ? dir.direction : 'unspecified'}; ${dir ? dir.basis : '未判定'}): 非用户来源不得自动批准`;
    case 'permission_change':
      return `权限变更: 权限是安全面, 只有 principal (user) 能放宽`;
    case 'scope_expansion':
      return `范围扩大: 目标影响面变大 → 需重规划, 且只有 principal 能放宽`;
    case 'scope_reduction':
      return `范围缩小: 只收紧, 不改判据 → 可排入下一 Run`;
    case 'priority_change':
      return `优先级变化: 不改变完成判据, 只调整下一步顺序`;
    default:
      return `补充说明: 不改判据/预算/权限, 也不增判据版本`;
  }
}

/**
 * 分类: 把原话收敛成**一个** `kind` + 影响面 + 是否需重规划 + 人类可读摘要。
 *
 * 消歧规则 (全部写死成规则, 不靠模型):
 *   · 判据"重申" (照旧/确认一下/原句重复) → `clarification`, **不**算改判据
 *   · 判据"变更" 出现时, 范围修饰词 (去掉/只保留…) 视为对判据本身的编辑, 不再重复算成范围变更
 *   · **用户撤销优先** (规则 1): 同批其余意图一律作废 → `kind='abort'`, `priority='user_revocation'`
 *   · 其余多意图 (一个 kind 装不下) → 退回 `status='received'` + `interpreted=null` (交人拆开重提)
 *
 * 已经是终态 (`applied`/`scheduled_next_run`/`superseded`) 的记录不许被重新分类
 * (否则等于把已生效的变更又拉回可再次生效的状态)。
 */
export function classifyChange(
  r: GoalChangeRequest,
  goal: { successCriteria: string[]; budget?: unknown },
): GoalChangeRequest {
  if (TERMINAL_STATUSES.includes(r.status)) return { ...r, appliesToFutureRunsOnly: true };

  const t = lower(r.instruction);
  const criteria = Array.isArray(goal?.successCriteria) ? goal.successCriteria.map(String) : [];
  let intents = detectChangeIntents(r.instruction);

  if (intents.includes('success_criteria_change') && isCriteriaRestatement(r.instruction, criteria)) {
    intents = intents.filter((k) => k !== 'success_criteria_change');
  }
  if (intents.includes('success_criteria_change')) {
    // "判据里去掉最后一条" 是对判据的编辑, 不是范围缩小
    intents = intents.filter((k) => k !== 'scope_expansion' && k !== 'scope_reduction' && k !== 'priority_change');
  }

  const scope: ChangeScope = r.scope ?? { kind: 'goal', targetIds: [r.goalId] };
  const base: GoalChangeRequest = {
    ...r,
    priority: SOURCE_PRIORITY[r.source],
    scope,
    impact: EMPTY_IMPACT(scope),
    appliesToFutureRunsOnly: true,
  };

  // 规则 1: 用户明确撤销优先 —— 压过同批其余意图
  if (r.source === 'user' && intents.includes('abort')) {
    const superseded = intents.filter((k) => k !== 'abort');
    return {
      ...base,
      kind: 'abort',
      priority: 'user_revocation',
      status: 'triaged',
      requiresReplan: false,
      impact: impactFor('abort', scope),
      interpreted:
        `${describeKind('abort', r, null)}; 原文: ${head(r.instruction)}` +
        (superseded.length ? `; 同批的 ${superseded.join('/')} 一律作废 (superseded), 需单独重新提交` : ''),
    };
  }

  // 一个 kind 装不下多个意图 → 不猜, 交人
  if (intents.length > 1) {
    return {
      ...base,
      kind: 'clarification',
      status: 'received',
      interpreted: null,
      requiresReplan: false,
      impact: EMPTY_IMPACT(scope),
    };
  }

  const kind: ChangeKind = intents.length === 1 ? intents[0] : 'clarification';
  const dir = kind === 'budget_change' ? detectBudgetDirection(r.instruction, goal?.budget) : null;
  const impact = impactFor(kind, scope);

  return {
    ...base,
    kind,
    status: 'triaged',
    requiresReplan: REPLAN_KINDS.has(kind),
    impact,
    interpreted: `${KIND_LABELS[kind]}: ${describeKind(kind, r, dir)}; 影响面: ${impactLabel(impact)}; 原文: ${head(r.instruction)}`,
  };
}

function impactLabel(i: ChangeImpact): string {
  const parts: string[] = [];
  if (i.affectsObjective) parts.push('目标');
  if (i.affectsCriteria) parts.push('判据');
  if (i.affectsBudget) parts.push('预算');
  if (i.affectsPermission) parts.push('权限');
  if (i.affectedWorkIds.length) parts.push(`子任务(${i.affectedWorkIds.length})`);
  return parts.length ? parts.join('/') : '无';
}

/**
 * 把变更范围收到具体子 Agent 工作上 (规则 5 的数据来源)。
 * 冻结面 `classifyChange` 看不到在跑的 workId, 所以由接线层在这一步注入。
 */
export function scopeChangeToWork(r: GoalChangeRequest, workIds: string[]): GoalChangeRequest {
  const ids = [...new Set((workIds ?? []).map(String).filter(Boolean))];
  const scope: ChangeScope = { kind: ids.length ? 'child_work' : 'goal', targetIds: ids.length ? ids : [r.goalId] };
  return { ...r, scope, impact: { ...r.impact, affectedWorkIds: ids }, appliesToFutureRunsOnly: true };
}

// ============================================================================
// §7. ③ 生效判定
// ============================================================================

export interface ChangeApplication {
  /** 排入下一 Run / 待批准 / 不生效 */
  outcome: 'next_run' | 'pending_approval' | 'rejected';
  /** 是否必须重规划 (`pending_approval` 时表示"批准后必须重规划") */
  requiresReplan: boolean;
  /** 下一 Run 的指令 (规则 4 + 规则 5 的条款永远附在里面) */
  nextRunDirective: string;
  /** 判定后的判据版本 (只有规则 3 会 +1; 其余一律原值) */
  criteriaVersion: number;
  /** 结构化理由 (点名生效的是哪条规则) */
  reason: string;
}

/**
 * 注入状态后**必须**下发的条款 (规则 4): 新要求只影响后续 Run。
 * 任何生效/待批准的变更都带这条 —— 不靠调用方记得写。
 */
function historyClause(v: number): string {
  return `[${RULES.history}] 本次变更只影响后续 Run (criteriaVersion=v${v}): 当前 Run 已发生的历史 / 证据 / 已完成步骤一律不改写、不回填。`;
}

/** 子 Agent 条款 (规则 5): 受影响子 Agent 必须先拿到变更版本 */
function childClause(r: GoalChangeRequest, v: number): string {
  const workIds = [...new Set(r.impact.affectedWorkIds)];
  if (!workIds.length) {
    return `[${RULES.children}] 本次变更无受影响子 Agent (impact.affectedWorkIds 为空); 若有在跑的子 Agent, 下发前必须先补全影响面 (scopeChangeToWork)。`;
  }
  const action = r.kind === 'abort' ? '停止并按父的 cancelPolicy 收尾' : '按变更版本继续下一步';
  return `[${RULES.children}] 下列子 Agent 必须**先确认收到**变更版本 (criteriaVersion=v${v}) 再${action}; 未确认前不得按旧版本继续: ${workIds.join(', ')}。`;
}

function compose(
  r: GoalChangeRequest,
  outcome: ChangeApplication['outcome'],
  requiresReplan: boolean,
  criteriaVersion: number,
  reason: string,
  parts: string[],
): ChangeApplication {
  const directive = [...parts, historyClause(criteriaVersion), childClause(r, criteriaVersion)].join('\n');
  return { outcome, requiresReplan, nextRunDirective: directive, criteriaVersion, reason };
}

function reject(criteriaVersion: number, reason: string): ChangeApplication {
  return {
    outcome: 'rejected',
    requiresReplan: false,
    nextRunDirective: `不做任何变更: ${reason}`,
    criteriaVersion,
    reason,
  };
}

function pendingReason(r: GoalChangeRequest, dir: BudgetDelta): string {
  switch (r.kind) {
    case 'abort':
      return `[${RULES.revocation}] 撤销/终止只有用户 (principal) 能发起: 来源 ${r.source} 的 abort 不允许自动生效, 需人确认 (用户自己撤销时优先级最高)`;
    case 'budget_change':
      return `[${RULES.budget}] 来源 ${r.source} 的预算变更方向=${dir.direction} (${dir.basis}) —— 不是"可证明的收紧", Agent 不得自行批准扩大预算, 需人批准`;
    case 'success_criteria_change':
      return `[${RULES.criteria}] 来源 ${r.source} 不得改写"什么算完成": 待人批准后才 criteriaVersion +1`;
    case 'permission_change':
      return `[principal_only] 权限是安全面: 来源 ${r.source} 不得自行放宽权限, 需人批准`;
    default:
      return `[principal_only] 来源 ${r.source} 不得扩大目标范围 (范围扩大抬高风险面), 需人批准`;
  }
}

function pendingEffect(r: GoalChangeRequest): string {
  switch (r.kind) {
    case 'abort':
      return `批准后: 在下一个 Run 边界终止该目标; 同批未生效的变更一并作废 (superseded)。`;
    case 'budget_change':
      return `批准后: 按用户原话调整预算上限并排入下一个 Run。`;
    case 'success_criteria_change':
      return `批准后: criteriaVersion +1, 下一次 Run 起按新判据判定 (旧证据保留, 不改写)。`;
    case 'permission_change':
      return `批准后: 只在下一个 Run 生效; 正在跑的子 Agent 按新权限继续。`;
    default:
      return `批准后: 下一个 Run 重新规划 (范围变大)。`;
  }
}

/**
 * 生效判定 (纯函数, 不改写输入)。
 *
 * 判定顺序 (先安全后便利):
 *   0. 未分诊 (`received` / `interpreted=null`) → 拒绝: 没理解的要求不许改变行为
 *   1. 终态 (`scheduled_next_run`/`applied`/`superseded`) → 拒绝: 幂等, 防二次增判据版本
 *   2. 用户撤销 (规则 1) → 排入下一 Run (且不增判据版本)
 *   3. 非用户来源的"放宽" (扩预算/加权限/扩范围/改判据/撤销) → 待批准 (规则 2/3)
 *   4. 其余 (补充说明 / 优先级 / 用户提出的变更 / 收紧类) → 排入下一 Run
 */
export function applyChange(
  r: GoalChangeRequest,
  goal: { criteriaVersion: number },
): ChangeApplication {
  const base = normalizeVersion(goal?.criteriaVersion);

  // 0. 未分诊
  if (r.status === 'received' || !r.interpreted) {
    const intents = detectChangeIntents(r.instruction);
    const why =
      intents.length > 1
        ? `原话同时命中 ${intents.length} 个变更意图 (${intents.join('/')}), 一个 kind 装不下 —— 需拆成多条 GoalChangeRequest 重新提交`
        : `还没有分类摘要 (status=${r.status}, interpreted=${r.interpreted === null ? 'null' : '有'}), 先 classifyChange 或交人分诊`;
    return reject(base, `[未分诊] 变更 ${r.changeId} ${why}, 不许直接生效 (不改写历史/不改判据版本)`);
  }

  // 1. 终态幂等
  if (TERMINAL_STATUSES.includes(r.status)) {
    return reject(base, `[幂等] 变更 ${r.changeId} 状态已是 ${r.status}, 不重复生效 (尤其不许二次 +1 判据版本)`);
  }

  // 2. 规则 1: 用户明确撤销优先
  if (r.kind === 'abort') {
    if (r.source === 'user' && r.priority === 'user_revocation') {
      return compose(r, 'next_run', false, base, `[${RULES.revocation}] 用户明确撤销优先级最高: 排入下一个 Run 终止该目标; 判据版本不变`, [
        `用户明确撤销: 在下一个 Run 边界终止该目标, 不做任何补救式继续; 同批未生效的变更一并作废 (superseded)。`,
      ]);
    }
    return compose(r, 'pending_approval', true, base, pendingReason(r, { direction: 'unspecified', from: null, to: null, basis: '-' }), [
      `待批准 (outcome=pending_approval): 批准前不动任何东西 —— 不终止目标、不排入下一 Run、判据版本不变。`,
      pendingEffect(r),
      `批准路径: 由人确认后以 source='user' 重新记录 (见 approvalAsUserChange), 原话逐字保留。`,
    ]);
  }

  const dir: BudgetDelta =
    r.kind === 'budget_change'
      ? detectBudgetDirection(r.instruction) // 生效阶段拿不到 goal.budget → 纯文本判定
      : { direction: 'unspecified', from: null, to: null, basis: '-' };

  // 3. 规则 2/3: 非用户来源不得"放宽"
  if (isWidening(r.kind, dir.direction) && r.source !== 'user') {
    return compose(r, 'pending_approval', true, base, pendingReason(r, dir), [
      `待批准 (outcome=pending_approval): 批准前不动任何东西 —— 不排入下一 Run、判据版本不变、不改写历史。`,
      pendingEffect(r),
      `批准路径: 由人确认后以 source='user' 重新记录 (见 approvalAsUserChange), 原话逐字保留。`,
    ]);
  }

  // 4. 规则 3: 只有"用户来源 + 改判据"才 +1
  if (r.kind === 'success_criteria_change') {
    const next = base + 1;
    return compose(r, 'next_run', true, next, `[${RULES.criteria}] 用户改完成判据: criteriaVersion ${base} → ${next}; 只有改判据才 +1`, [
      `完成判据变更: criteriaVersion ${base} → ${next}; 下一次 Run 起按新判据判定 (旧判据下已产生的证据保留, 不改写)。`,
    ]);
  }

  // 5. 其余: 补充说明 / 优先级 / 收紧类 / 用户提出的放宽
  const reason =
    r.kind === 'budget_change'
      ? r.source === 'user'
        ? `[${RULES.budget}] 预算变更来源是用户 (= 出资方本人), 视为已批准; 判据版本不变`
        : `[${RULES.budget}] 非用户来源但方向可证明为收紧 (${dir.basis}), 只变小不扩大 → 允许排入下一 Run; 判据版本不变`
      : `[无放宽] ${KIND_LABELS[r.kind]} 不扩大风险面 (来源 ${r.source}) → 排入下一 Run; 判据版本不变`;
  return compose(r, 'next_run', REPLAN_KINDS.has(r.kind), base, reason, [effectFor(r, dir, base)]);
}

function effectFor(r: GoalChangeRequest, dir: BudgetDelta, v: number): string {
  switch (r.kind) {
    case 'budget_change':
      return r.source === 'user'
        ? `预算变更 (用户本人提出 = 已批准, 方向=${dir.direction}): 按用户原话调整预算上限, 排入下一个 Run。`
        : `预算只收紧 (方向=decrease): 允许排入下一个 Run; 若收紧后已低于已消耗量, 接线层须在开跑前停下交人。`;
    case 'permission_change':
      return `权限变更 (用户本人决定): 只在下一个 Run 生效, 正在跑的子 Agent 按新权限继续 (旧产出不改写)。`;
    case 'scope_expansion':
      return `范围扩大 (用户本人提出 = 已批准): 下一个 Run 重新规划。`;
    case 'scope_reduction':
      return `范围缩小: 只收紧目标范围, 排入下一个 Run (判据版本不变)。`;
    case 'priority_change':
      return `优先级变化: 不改变完成判据, 下一个 Run 按新优先级排序。`;
    default:
      return `补充说明: 只作为下一次 Run 的上下文 (v${v}), 不改判据/预算/权限, 也不增判据版本。`;
  }
}

// ============================================================================
// §8. 配套面: 状态推进 / 覆盖旧变更 / 人工批准 / 子 Agent 下发
// ============================================================================

/** 判定结果 → 变更记录该落到哪个状态 (接线层负责真的写) */
export function nextStatusFor(outcome: ChangeApplication['outcome']): ChangeStatus {
  if (outcome === 'next_run') return 'scheduled_next_run';
  if (outcome === 'pending_approval') return 'needs_approval';
  return 'rejected';
}

/** 规则 1 的推论: 用户撤销压过一切 → 之前未生效的变更一律作废 */
export function shouldSupersedePending(r: GoalChangeRequest): boolean {
  return r.kind === 'abort' && r.source === 'user' && r.priority === 'user_revocation';
}

/**
 * 人工批准路径 (规则 2/3 的出口)。
 *
 * 冻结的 `GoalChangeRequest` **没有**批准字段, 因此批准这件事在本模块里的表达是:
 * **由人 (principal) 以 `source='user'` 重新记录同一条变更** —— Agent 的原始请求永远是
 * `pending_approval`, 没有任何代码路径能让 Agent 自己把扩预算变成 `next_run`。
 */
export function approvalAsUserChange(
  r: GoalChangeRequest,
  approvedBy: string,
  now: IsoTimestamp,
): GoalChangeRequest {
  const approved = ingestChange({ goalId: r.goalId, source: 'user', instruction: r.instruction, recordedBy: approvedBy, now });
  const classified = classifyChange(approved, { successCriteria: [] });
  if (classified.status !== 'triaged') return classified; // 原话本身就有歧义 → 还是要人拆
  return {
    ...classified,
    interpreted: `人工批准 (${approvedBy}): 采纳来源 ${r.source} 的变更 ${r.changeId}; ${classified.interpreted}`,
  };
}

/** 逐 workId 下发的变更内容 (规则 5) */
export interface ChildChangeDirective {
  workIds: string[];
  criteriaVersion: number;
  directive: string;
  mustAckBeforeNextStep: true;
  rewritesHistory: false;
}

export function childChangeDirective(r: GoalChangeRequest, applied: { criteriaVersion: number }): ChildChangeDirective {
  const workIds = [...new Set(r.impact.affectedWorkIds)];
  const v = normalizeVersion(applied?.criteriaVersion);
  const action = r.kind === 'abort' ? '停止并按父的 cancelPolicy 收尾' : `按变更版本 (criteriaVersion=v${v}) 继续下一步`;
  const directive = workIds.length
    ? `[${RULES.children}] 变更 ${r.changeId} 下发到 ${workIds.length} 个子 Agent (${workIds.join(', ')}): 每个子必须先确认收到 criteriaVersion=v${v} 再${action}; 未确认前不得按旧版本继续。`
    : `[${RULES.children}] 变更 ${r.changeId} 没有受影响子 Agent (affectedWorkIds 为空): 若有在跑的子 Agent, 下发前必须先补全影响面。`;
  return { workIds, criteriaVersion: v, directive, mustAckBeforeNextStep: true, rewritesHistory: false };
}
