/**
 * goal-flywheel/work-contract.ts — P2 「子 Agent 工作合同」(独立模块, **未接线**)
 *
 * 解决的问题 (设计 §7 / §14 P2): 现在子 Agent "回一段文本也能算数"。
 * 这一层给出**唯一**的派遣前契约 (`AgentWorkContract`) 与**结构化回报**的核验,
 * 让父能明确回答三件事:
 *   ① 这份合同签得合不合法 —— 缺目标 / 缺判据 / deadline 早于 now / 金额没币种 → **拒签** (抛错)
 *   ② 这份回报够不够格 —— 缺字段 / 缺判据证据 / 越界 (`ChildProhibition`)
 *   ③ 能不能算「完成」 —— 只有: 状态 `completed` + 报告完整 + 逐条判据有证据 + 没越界 + 没超期
 *
 * 边界 (刻意不做, 与设计 §13 一致):
 *   - **不做 I/O, 不读真实钟**: 时间一律由 `now` / `deadline` / `reportedAt` 注入;
 *     本文件不 import `fs` / `node:*` / 任何阶段的实现文件, 只 import `./types.js` 的类型与枚举。
 *   - **不改现有调用方**: `execution-supervisor.ts` / `goal-store.ts` / `pi-sdk.ts` / watchdog 一律没碰。
 *     派遣时签合同、收到回报时核验 —— 那是接线 (单一所有者) 后续的事。
 *   - **不做监控**: "多久没心跳 / 要不要接管" 是 P3 (`work-monitor.ts`) 的事;
 *     本文件只核验报告内容, 不判断时间流逝 (因此 `acceptsAsComplete` 没有 `now` 参数)。
 *
 * 回报协议 (`bolloon-work-report/1`, 即合同里的 `reportSchema`):
 *   - 每条 `successCriteria` 都要有**两件**东西:
 *       ① 一条证据: `WorkEvidence.kind` 或 `.ref` === `criterion:<判据原文>`
 *       ② 一条检查: `WorkCheck.name` === `criterion:<判据原文>` 且 `verdict === 'pass'`
 *   - `issueWorkContract` 把这条约定**写进合同的 `requiredEvidence`**, 子不需要猜。
 *   - 对自称 `completed` 的报告: 上述任意一条缺失 → 判越界 `mark_unverified_as_complete`
 *     (设计 §10 强负例 7: 漂亮但无证据的结果 → 父 Goal **不完成**)。
 *   - 非 `completed` 的报告 (`partial` / `blocked` / `failed` / `cancelled`) **允许**判据未满足
 *     (被卡住本来就拿不到证据, 硬要证据只会逼出假证据), 但仍然必须带**至少一条**证据
 *     (禁"只回一段文本"), 且 `blocked` 必须给结构化 `BlockRecord` (禁写成一句"有问题")。
 *
 * 无法从回报核验的两条禁则 (`mutate_parent_goal_state` / `spawn_unbounded_subtasks`):
 * 回报里**没有对应字段**, 本文件**不假装**能查 —— 见 `NOT_CHECKABLE_FROM_REPORT`,
 * 由监控层 / 接线层拦。
 */

import {
  CHILD_PROHIBITIONS,
  CHECK_VERDICTS,
  WORK_REPORT_STATUSES,
} from './types.js';
import type {
  AgentWorkContract,
  AgentWorkReport,
  ChildCancelPolicy,
  ChildFailurePolicy,
  ChildProhibition,
  IsoTimestamp,
  WorkBudget,
  WorkCheck,
  WorkEvidence,
  WorkReportStatus,
} from './types.js';

// ============================================================================
// §0. 常量与默认值 (合同里没有入参的字段, 默认值在这里一份写死)
// ============================================================================

/** 回报协议名 (写进合同的 `reportSchema`) */
export const WORK_REPORT_SCHEMA = 'bolloon-work-report/1';

/** 判据引用前缀: `criterion:<判据原文>` —— 证据与检查都按这个名字对齐 */
export const CRITERION_REF_PREFIX = 'criterion:';

/** 心跳默认间隔 (没有预算/期限约束时) */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳下限 (再短就是噪音) */
export const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
/** 心跳上限 (再长就等于没有心跳) */
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

/** 判据引用名 (证据与检查共用) */
export function criterionRef(criterion: string): string {
  return `${CRITERION_REF_PREFIX}${criterion}`;
}

/**
 * 默认失败处置 (设计 §7 职责划分 + §8 处理规则):
 *   - 心跳没了: 先 `stall` (标停), **不是**自动接管 —— 接管要先查 lease (P3)
 *   - 预算用尽: `stop_and_report` (硬底线, 不许自行扩预算)
 *   - 工具被拒: `report` (强调**不自动绕过 Harness**)
 *   - 反复失败: `escalate` (升级给父, 不许自己重试到天荒地老)
 */
export const DEFAULT_FAILURE_POLICY: ChildFailurePolicy = Object.freeze({
  onHeartbeatMiss: 'stall',
  onBudgetExhausted: 'stop_and_report',
  onToolDenied: 'report',
  onRepeatedFailure: 'escalate',
});

/** 默认取消策略: 宽限收尾 + 保留工件 (取消不该销毁已产出的东西) */
export const DEFAULT_CANCEL_POLICY: ChildCancelPolicy = Object.freeze({
  onParentCancel: 'graceful',
  graceMs: 3_000,
  preserveArtifacts: true,
  onParentGoalClosed: 'finish_current_step',
});

/**
 * 能从**回报本身**核验的禁则 (本文件真的实现并测了)。
 * 固定优先级 = `CHILD_PROHIBITIONS` 的声明顺序 (同一份报告只回第一条, 结果可复现)。
 */
export const REPORT_CHECKABLE_PROHIBITIONS: readonly ChildProhibition[] = [
  'expand_own_budget',
  'mark_unverified_as_complete',
  'rewrite_success_criteria',
];

/**
 * 回报里**没有字段**可供核验的禁则 —— 本文件不假装能查, 由监控层 / 接线层拦。
 * (`AgentWorkReport` 里既没有"父 Goal 状态的镜像", 也没有"派生了几条子任务"的记录。)
 */
export const NOT_CHECKABLE_FROM_REPORT: readonly ChildProhibition[] = [
  'mutate_parent_goal_state',
  'spawn_unbounded_subtasks',
];

// ============================================================================
// §1. 工具 (纯函数: 无 I/O, 无全局状态, 不读真实钟)
// ============================================================================

/** 拒签合同的错误 —— 带上**结构化**原因清单 (不许只给一句人话) */
export class WorkContractError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`拒绝签发工作合同: ${issues.join('; ')}`);
    this.name = 'WorkContractError';
    this.issues = issues;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ISO 时间戳宽松判定: 必须是 `YYYY-MM-DD…` 且 `Date.parse` 认得出 (宽松是为兼容全仓既有写法) */
function isIsoLike(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

function isWorkReportStatus(v: unknown): v is WorkReportStatus {
  return WORK_REPORT_STATUSES.includes(v as WorkReportStatus);
}

/** 去重但保留首次出现顺序 */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** FNV-1a 32 位 (两次不同种子拼成 16 位十六进制) —— 让 workId 可复现, 不引入随机数/时钟依赖 */
function fnv1a32(input: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 稳定哈希 (同一输入 → 同一结果; 不读时钟, 不用随机数) */
export function stableHash(input: string): string {
  return fnv1a32(input, 0x811c9dc5) + fnv1a32(`${input}\u0000#2`, 0x01000193);
}

/** 深冻结 (合同是只读的) */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 拷贝 `inputs` 再冻结 —— **不动调用方的对象** (只冻结我们自己的副本)。
 * `structuredClone` 拿不到的类型 (函数/Promise 等) 退化为浅拷贝, 但绝不抛。
 */
function cloneInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(inputs) as Record<string, unknown>;
  } catch {
    return { ...inputs };
  }
}

/**
 * 心跳间隔推导 (合同里没有这个入参, 只能推):
 *   取 min(默认 30s, 预算时长/6, 到 deadline 剩余/3), 再夹到 [5s, 60s]。
 * 理由: 心跳至少要能在"预算用尽 / 超期"之前发出几次, 长预算也不许把心跳拉长到没意义。
 */
function deriveHeartbeatIntervalMs(
  budget: WorkBudget,
  deadline: IsoTimestamp | null,
  now: IsoTimestamp,
): number {
  const candidates: number[] = [DEFAULT_HEARTBEAT_INTERVAL_MS];
  if (isFiniteNumber(budget?.maxDurationMs) && budget.maxDurationMs > 0) {
    candidates.push(Math.floor(budget.maxDurationMs / 6));
  }
  if (deadline !== null && isIsoLike(deadline) && isIsoLike(now)) {
    const remaining = Date.parse(deadline) - Date.parse(now);
    if (remaining > 0) candidates.push(Math.floor(remaining / 3));
  }
  const raw = Math.min(...candidates);
  return Math.min(Math.max(raw, MIN_HEARTBEAT_INTERVAL_MS), MAX_HEARTBEAT_INTERVAL_MS);
}

// ============================================================================
// §2. 签发合同 (issueWorkContract)
// ============================================================================

/**
 * 签发子 Agent 工作合同 (设计 §14 冻结签名)。
 *
 * 合同不合法就**不签** —— 抛 `WorkContractError` (带 `issues` 结构化原因), 不做"差不多就行"的宽容。
 * 返回的对象是**深冻结**的: 子拿到的合同不能被就地改写 (失败/取消策略、判据、预算都不可改)。
 *
 * `workId` 由 (goalId, parentRunId, childAgentId, capability, objective, now) 稳定哈希得出 ——
 * 同输入同 id (可复现、可幂等), 不读时钟也不用随机数。
 */
export function issueWorkContract(input: {
  goalId: string; parentRunId: string; childAgentId: string;
  capability: string; objective: string; inputs: Record<string, unknown>; allowedTools: string[];
  budget: WorkBudget; deadline: IsoTimestamp | null; successCriteria: string[]; now: IsoTimestamp; issuedBy: string;
}): AgentWorkContract {
  const issues: string[] = [];

  const named: [string, unknown][] = [
    ['goalId', input.goalId],
    ['parentRunId', input.parentRunId],
    ['childAgentId', input.childAgentId],
    ['capability', input.capability],
    ['objective', input.objective],
    ['issuedBy', input.issuedBy],
  ];
  for (const [name, value] of named) {
    if (!isNonEmptyString(value)) issues.push(`${name} 为空/缺失 (合同必须有明确的 ${name})`);
  }

  if (!isIsoLike(input.now)) issues.push('now 不是合法 ISO 时间戳');

  if (input.deadline !== null) {
    if (!isIsoLike(input.deadline)) {
      issues.push('deadline 不是合法 ISO 时间戳 (null = 不设期限)');
    } else if (isIsoLike(input.now) && Date.parse(input.deadline) < Date.parse(input.now)) {
      issues.push('deadline 早于签发时间 now (还没开始就超期的合同不许签)');
    }
  }

  if (!isPlainObject(input.inputs)) issues.push('inputs 必须是结构化对象 (Record<string, unknown>)');

  const rawCriteria = Array.isArray(input.successCriteria) ? input.successCriteria : [];
  const criteriaTrimmed = rawCriteria.map((c) => (typeof c === 'string' ? c.trim() : ''));
  if (criteriaTrimmed.some((c) => c.length === 0)) issues.push('successCriteria 含空条目');
  const successCriteria = dedupe(criteriaTrimmed.filter((c) => c.length > 0));
  if (successCriteria.length === 0) {
    issues.push('successCriteria 为空 (没有成功判据 = 没有"完成"的定义, 这种合同一定会扯皮)');
  }

  const rawTools = Array.isArray(input.allowedTools) ? input.allowedTools : [];
  const toolsTrimmed = rawTools.map((t) => (typeof t === 'string' ? t.trim() : ''));
  if (toolsTrimmed.some((t) => t.length === 0)) issues.push('allowedTools 含空条目');
  // 空数组是合法的: "无工具授权" (只能基于 inputs 推理) —— 但不许出现空字符串这种脏数据
  const allowedTools = dedupe(toolsTrimmed.filter((t) => t.length > 0));

  const budget = input.budget;
  if (!isPlainObject(budget)) {
    issues.push('budget 缺失 (子不许自行扩预算, 所以父必须把上限写清)');
  } else {
    for (const field of ['maxSteps', 'maxDurationMs', 'maxAmount'] as const) {
      const v = budget[field];
      if (v === null || v === undefined) continue;
      if (!isFiniteNumber(v) || v <= 0) {
        issues.push(`budget.${field} 必须是 null 或正数 (现在: ${String(v)})`);
        continue;
      }
      if (field === 'maxSteps' && !Number.isInteger(v)) issues.push('budget.maxSteps 必须是整数');
    }
    if (budget.maxAmount !== null && budget.maxAmount !== undefined && !isNonEmptyString(budget.currency)) {
      issues.push('budget.maxAmount 有值但 budget.currency 为空 (金额没有币种 = 无法核验)');
    }
  }

  if (issues.length > 0) throw new WorkContractError(issues);

  const workId = `work-${stableHash(
    [input.goalId, input.parentRunId, input.childAgentId, input.capability, input.objective, input.now].join('\u0000'),
  )}`;

  const contract: AgentWorkContract = {
    workId,
    goalId: input.goalId,
    parentRunId: input.parentRunId,
    childAgentId: input.childAgentId,
    capability: input.capability,
    objective: input.objective,
    inputs: cloneInputs(input.inputs),
    allowedTools,
    budget: {
      maxSteps: budget.maxSteps ?? null,
      maxDurationMs: budget.maxDurationMs ?? null,
      maxAmount: budget.maxAmount ?? null,
      currency: budget.currency ?? null,
    },
    deadline: input.deadline,
    successCriteria,
    reportSchema: WORK_REPORT_SCHEMA,
    heartbeatIntervalMs: deriveHeartbeatIntervalMs(budget, input.deadline, input.now),
    failurePolicy: { ...DEFAULT_FAILURE_POLICY },
    cancelPolicy: { ...DEFAULT_CANCEL_POLICY },
    // 约定写进合同: 每条判据一条证据 (子不需要猜要交什么)
    requiredEvidence: successCriteria.map((c) => criterionRef(c)),
    issuedAt: input.now,
    issuedBy: input.issuedBy,
  };

  return deepFreeze(contract);
}

// ============================================================================
// §3. 核验回报 (validateChildReport)
// ============================================================================

/**
 * `BlockRecord` 在回报里必须自带这些事实 (缺一项 = 说不清卡在哪, 设计 §8):
 * 必带键 + 必须非空的键。`note` 也算"说清", 空说明等于没报 (禁"有问题"式回报)。
 */
const BLOCK_RECORD_KEYS = [
  'kind',
  'blockedAt',
  'lastProgressAt',
  'owner',
  'dependency',
  'suggestedAction',
  'note',
] as const;

/** 阻塞记录是否说得清 (返回问题清单; 空 = 合格) */
function blockRecordIssues(block: unknown): string[] {
  if (!isPlainObject(block)) return ['blockReason 不是结构化对象 (不许写成一句"有问题")'];
  const issues: string[] = [];
  for (const key of BLOCK_RECORD_KEYS) {
    if (!(key in block)) issues.push(`blockReason 缺字段 ${key}`);
  }
  for (const key of ['kind', 'blockedAt', 'lastProgressAt', 'owner', 'suggestedAction', 'note'] as const) {
    if (key in block && !isNonEmptyString(block[key])) issues.push(`blockReason.${key} 为空`);
  }
  return issues;
}

/** 报告里的检查是否满足某条判据 (`criterion:<原文>` 且 verdict='pass') */
function verdictOfCriterion(report: AgentWorkReport, criterion: string): string | null {
  const checks = Array.isArray(report?.checks) ? (report.checks as WorkCheck[]) : [];
  const hit = checks.find((c) => isPlainObject(c) && (c as WorkCheck).name === criterionRef(criterion));
  if (!hit || !isPlainObject(hit)) return null;
  const verdict = (hit as WorkCheck).verdict;
  return CHECK_VERDICTS.includes(verdict) ? verdict : null;
}

/** 某条证据是否引用了合同要求的证据名 (kind 或 ref 任一对上 —— 精确匹配, 不许模糊) */
function citesRequirement(evidence: unknown, requirement: string): boolean {
  if (!isPlainObject(evidence)) return false;
  const e = evidence as unknown as WorkEvidence;
  return e.kind === requirement || e.ref === requirement;
}

/**
 * 核验子 Agent 回报 (设计 §14 冻结签名)。
 *
 * 三个桶都**返回原因**, 不只是 boolean:
 *   - `missingFields`   —— 字段级不合格: 缺失 / 空 / 格式错 / **与合同不一致**
 *     (例如回报里的 `workId` 不是本合同签发的那个)。`evidence` 为空数组、`checks` 为空数组、
 *     `status='blocked'` 却没给结构化 `blockReason` 都算这里。
 *   - `missingEvidence` —— **自称 `completed`** 时, 合同的 `requiredEvidence` 里查不到对应证据的条目。
 *     (非完成状态本来就允许判据未满足 → 这一桶为空, 但"至少一条证据"仍由 `missingFields` 兜着。)
 *   - `violation`       —— 越界, 取值见 `REPORT_CHECKABLE_PROHIBITIONS`; 多条命中时按
 *     `CHILD_PROHIBITIONS` 声明顺序取第一条 (结果可复现)。
 *
 * 本函数**不改**合同与回报 (测试里用深冻结输入钉住这一点)。
 */
export function validateChildReport(contract: AgentWorkContract, report: AgentWorkReport): {
  ok: boolean; missingFields: string[]; missingEvidence: string[]; violation: ChildProhibition | null;
} {
  // 报告可能根本不是它自称的那个形状 (子只回了文本 / 少字段), 所以按 unknown 读
  const r = (report ?? {}) as unknown as Record<string, unknown>;

  const missingFields: string[] = [];
  if (!isNonEmptyString(r.workId) || r.workId !== contract.workId) missingFields.push('workId');
  if (!isNonEmptyString(r.childAgentId) || r.childAgentId !== contract.childAgentId) missingFields.push('childAgentId');
  if (!isWorkReportStatus(r.status)) missingFields.push('status');
  if (!isNonEmptyString(r.summary)) missingFields.push('summary');
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) missingFields.push('evidence');
  if (!Array.isArray(r.artifacts)) missingFields.push('artifacts');
  if (!Array.isArray(r.checks) || r.checks.length === 0) missingFields.push('checks');
  if (!Array.isArray(r.unresolvedItems)) missingFields.push('unresolvedItems');
  if (!isNonEmptyString(r.nextRecommendation)) missingFields.push('nextRecommendation');
  if (!isFiniteNumber(r.durationMs) || r.durationMs < 0) missingFields.push('durationMs');
  if (!isIsoLike(r.reportedAt)) missingFields.push('reportedAt');

  // 被阻塞 → 必须有能说清卡在哪的阻塞记录 (null 或结构不全都算不合格)
  if (r.status === 'blocked' && !isPlainObject(r.blockReason)) {
    missingFields.push('blockReason');
  } else if (r.blockReason !== null && r.blockReason !== undefined && blockRecordIssues(r.blockReason).length > 0) {
    missingFields.push('blockReason');
  }

  // 判据证据: 只对"自称完成"的报告要求 (非完成状态不许逼出自证)
  const missingEvidence: string[] = [];
  if (r.status === 'completed') {
    const evidence = Array.isArray(r.evidence) ? (r.evidence as WorkEvidence[]) : [];
    for (const requirement of contract.requiredEvidence) {
      if (!evidence.some((e) => citesRequirement(e, requirement))) missingEvidence.push(requirement);
    }
  }

  const violation = detectViolation(contract, report, missingEvidence);

  const ok = missingFields.length === 0 && missingEvidence.length === 0 && violation === null;
  return { ok, missingFields, missingEvidence, violation };
}

/** 越界判定 (纯函数; 固定优先级见 `REPORT_CHECKABLE_PROHIBITIONS`) */
function detectViolation(
  contract: AgentWorkContract,
  report: AgentWorkReport,
  missingEvidence: string[],
): ChildProhibition | null {
  const r = (report ?? {}) as unknown as Record<string, unknown>;

  // ① 超预算: 报告里唯一能核验的预算是耗时 (maxSteps / maxAmount 回报里没有对应字段 → 不假装能查)
  const maxDurationMs = contract.budget?.maxDurationMs ?? null;
  const budgetOverrun = maxDurationMs !== null && isFiniteNumber(r.durationMs) && r.durationMs > maxDurationMs;

  // ② 把未验证的结果标完成
  const evidenceEmpty = !Array.isArray(r.evidence) || r.evidence.length === 0;
  const unresolvedLeft = Array.isArray(r.unresolvedItems) && r.unresolvedItems.length > 0;
  const criteriaWithoutPass = contract.successCriteria.filter((c) => verdictOfCriterion(report, c) !== 'pass');
  const unverifiedComplete =
    r.status === 'completed' &&
    (evidenceEmpty || missingEvidence.length > 0 || criteriaWithoutPass.length > 0 || unresolvedLeft);

  // ③ 私改成功判据: 报告里对合同**没有**的判据给了检查 (自己另立了一套判据)
  const checks = Array.isArray(r.checks) ? (r.checks as unknown[]) : [];
  const forgedCriteria = checks.some((c) => {
    if (!isPlainObject(c)) return false;
    const name = (c as unknown as WorkCheck).name;
    if (!isNonEmptyString(name) || !name.startsWith(CRITERION_REF_PREFIX)) return false;
    return !contract.successCriteria.includes(name.slice(CRITERION_REF_PREFIX.length));
  });

  const hit: ChildProhibition[] = [];
  if (budgetOverrun) hit.push('expand_own_budget');
  if (unverifiedComplete) hit.push('mark_unverified_as_complete');
  if (forgedCriteria) hit.push('rewrite_success_criteria');

  return CHILD_PROHIBITIONS.find((p) => hit.includes(p)) ?? null;
}

// ============================================================================
// §4. 是否接受为完成 (acceptsAsComplete)
// ============================================================================

/**
 * 能不能把这份回报**接受为完成** (设计 §14 冻结签名)。这是父的判定, 不是子的自评。
 *
 * 拒绝原因按固定优先级给第一条 (越早发现越该先说):
 *   ① 自报状态不是 `completed`
 *   ② 报告不完整 (`missingFields`) —— 证据/检查为空的报告一律不接受
 *   ③ 判据缺证据 (`missingEvidence`)
 *   ④ 越界 (`violation`, 含 `mark_unverified_as_complete`)
 *   ⑤ 超期 (`reportedAt > deadline`) —— 超期是**交付时间**问题, 不是报告质量问题:
 *      此时 `validateChildReport` 仍可能 `ok=true` (报告本身合格), 但要父决定是否重签合同。
 *
 * 通过 = 上面五条全不成立 (判据逐条有证据 + 逐条 `pass` 检查 + 无未解决项)。
 */
export function acceptsAsComplete(
  contract: AgentWorkContract,
  report: AgentWorkReport,
): { accepted: boolean; reason: string } {
  const r = (report ?? {}) as unknown as Record<string, unknown>;
  const validation = validateChildReport(contract, report);

  if (r.status !== 'completed') {
    return {
      accepted: false,
      reason: `子 Agent 自报状态 '${String(r.status)}', 不是 'completed' —— 不算完成 (未完成的工作可以继续等, 但不许当完成记账)`,
    };
  }
  if (validation.missingFields.length > 0) {
    return {
      accepted: false,
      reason: `报告不完整, 缺/不合格字段: ${validation.missingFields.join(', ')} (证据与检查为空的报告一律不接受为完成)`,
    };
  }
  if (validation.missingEvidence.length > 0) {
    return {
      accepted: false,
      reason: `判据缺证据: ${validation.missingEvidence.join(', ')} —— 逐条判据没有证据就不算完成`,
    };
  }
  if (validation.violation !== null) {
    return {
      accepted: false,
      reason: `子 Agent 越界 (${validation.violation}) —— 该回报不能被接受为完成, 需要父/监控层处理`,
    };
  }
  if (contract.deadline !== null && isIsoLike(r.reportedAt) && Date.parse(r.reportedAt) > Date.parse(contract.deadline)) {
    return {
      accepted: false,
      reason: `回报时间 ${String(r.reportedAt)} 超过合同 deadline ${contract.deadline} —— 超期交付由父决定是否重签合同, 这里不判完成`,
    };
  }

  const evidenceCount = Array.isArray(r.evidence) ? (r.evidence as unknown[]).length : 0;
  const unresolvedCount = Array.isArray(r.unresolvedItems) ? (r.unresolvedItems as unknown[]).length : 0;
  return {
    accepted: true,
    reason: `${contract.successCriteria.length} 条判据逐条有证据且检查 pass, 证据 ${evidenceCount} 条, 未解决项 ${unresolvedCount} 条 (workId ${contract.workId})`,
  };
}
