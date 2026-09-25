/**
 * wiring/closure.ts — 接缝 ②「这一条 Run 收尾了吗, 收尾产物落在哪里?」  (**M2 独占**)
 *
 * 归属: `seams.ts` 的 `SEAM_ROSTER` 里 `id: 'closure'`, `stage: 'M2'`。
 * M2 只准改本文件 + 本接缝声明的 `wiringPoints`
 * (`goal-flywheel/{run-closure,memory-layers,skill-candidate}.ts`)。
 *
 * ## 这条接缝钉住的两条冻结规则
 *
 * **规则 ③ 只有 closeRun 能关闭 Run**: 全仓只有 `goal-flywheel/run-closure.ts` 定义
 * `closeRun`, 只有 M0 接线层 (`goal-flywheel-wiring.ts`) 与**本文件**能碰它。
 *
 * **规则 ④ 所有终止路径必须经过 closeRun**: 成功 / 失败 / 中断 / 超时 / 人工暂停 /
 * 崩溃恢复 / 权限·支付·工具失败 / 子 Agent 被阻塞 —— 八类终止**都**走收尾漏斗。
 * 本文件把这句话做成**可执行**的两半:
 *   · `CLOSURE_TERMINAL_PATHS` + `terminalRegistryCoverage()`: 把 run-store 的每一个**终止状态**
 *     映射到名册上的终止路径, 并检查 seams.ts 名册上的每条终止路径都被认领 —— 留下一条没人管的
 *     路径, 门立刻判红 (而不是靠"我记得改过了");
 *   · `auditTerminalCoverage()`: 给一批**真的终止过**的 Run, 逐条查它有没有收尾记录 ——
 *     这才是"必经阶段"的可核验形式 (终止了但没收尾 = 缺口)。
 *
 * ## 收尾产物的三项**真读盘**审计 (接缝问的"落在哪里", 不看返回值只看盘)
 *
 *   ① 用户汇报 / closure 决策记录两个文件**真的存在**;
 *   ② P1b 的**分层 Memory 目录**里真有属于这条 Run 的记录, 且**落层正确** (layer 与目录一致);
 *   ③ P1b 的**候选文件**只带 `snapshotScope='next_run_only'` + `appliesToRunningRun=false`
 *      (试用范围; 落盘时丢了这两个字段 = 正在执行的 snapshot 可能被覆盖)。
 * ②③ 是**条件检查**: 盘上没有这类产物时不判红 (一条 Run 可以如实"没有可提取的候选"),
 * 但只要它落盘了, 就必须符合 P1b 的分层/试用不变量 —— 于是它既能抓到真回归, 又不会因
 * "某条 Run 本来就是空的"刷假红 (门一旦有假阳性就会被白名单掉, 真信号也没了)。
 *
 * ## 收尾产物不完整 = `artifactsComplete:false` (**不是** `ok:false`)
 *
 * 任何一条终止路径都必须交出完整产物: 9 步 · 决策 · 下一步 · 与决策自洽的 continuation ·
 * continuation 的时间戳属于**这一轮** · 用户汇报 (六类可见态 + 只暴露允许字段) · 两个产物文件。
 * 缺任何一项 → `artifactsComplete:false` + `receipt.audit.missing` 点名 (结构化原因, 不是 boolean)。
 * 收尾照做, 但**不许**当成"收好了"。
 *
 * ★ 为什么不用 `ok:false` 表达缺口 (2026-09-26 实测教训): 接缝协议里 `ok:false` 就是**被拒**
 * (`seams.ts` 的 `isRefusal`: `ok===false && typeof reason === 'string'`)。收尾真做了却报 ok:false,
 * 监督者 (execution-supervisor) 会走"收尾被拒"分支 —— 这条 Run 从 `report.closures` 里消失,
 * 于是"产物有缺口"被伪装成"收尾被拒", 两件事同时失真 (一条真收尾的 Run 看起来根本没收尾)。
 * 所以 `ok` 只表达"这次调用做成了吗", 缺口走 `artifactsComplete`。
 *
 * ## 为什么是 `Once` (幂等)
 *
 * 真实链路上同一条 Run 会被两处看见:
 *   · Runner (pi-sdk / CLI) 自己在 Run 结束时就收尾 (它知道最细的上下文);
 *   · Supervisor 在 Runner 返回后又收一遍 (它负责 Goal 层决策)。
 * 若两边都真收, 就会写出两份 Memory / 两份候选 / 两条 closure 决策记录 —— 又是两套事实。
 * 所以收尾入口是 `closeRunOnce`: **同一条 runId 只允许收一次**, 第二次返回
 * `alreadyClosed: true` 且**不写任何东西**。幂等判据用的是既有的 closure 决策记录
 * (`.bolloon/goal-decisions/<goalId>--<runId>--closure.json`) —— **不新增存储**。
 *
 * ## M2 之后仍缺的一环 (如实说明, 需要 M0 接线层的钩子)
 *
 * P1b 的 Skill 升级通道 (`skill-candidate.ts` 的 `openSkillTrial` / `settleSkillTrial`) 是**纯函数**:
 *   · **准入** (①–⑤) 要在"候选刚被提取出来"时调用 —— 那一处是 M0 接线层的 `closeGoalRun` /
 *     `writeSkillCandidate` (M0 冻结面, 本线不能改);
 *   · **提升** (⑥) 要在**下一条 Run 成功复用**的那个成功点上调用 —— 那一处目前没有钩子。
 * 本文件把接缝该做的部分做完 (产物审计里已经会检查候选文件的试用范围), 通道本身与其判据在
 * `skill-candidate.ts` 落地并自带测试; 接线请见本线提交说明里给主线的钩子清单。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  CONTINUATION_DECISIONS,
  MEMORY_LAYERS,
  MUST_NOT_EXPOSE_FIELDS,
  USER_REPORT_FIELDS,
  USER_VISIBLE_STATES,
} from '../types.js';
import type {
  ContinuationDecision,
  ContinuationDecisionKind,
  GoalContinuationRecord,
  IsoTimestamp,
  UserReport,
  WorkReportStatus,
} from '../types.js';
import { MEMORY_LAYERS_ROOT } from '../memory-layers.js';
import { CLOSURE_STEP_ORDER, GOAL_STATE_FOR_DECISION } from '../run-closure.js';
import { TERMINAL_PATHS, WIRING_CALLERS, refuse, type SeamRefusal, type WiringCaller } from './seams.js';

export const CLOSURE_SEAM_ID = 'closure' as const;

/**
 * Skill 候选落盘根 (与 M0 接线层的 `SKILL_CANDIDATES_ROOT` 必须**逐字相同**)。
 *
 * 为什么不 import M0: 那会造成 `closure.ts → goal-flywheel-wiring.ts → wiring/index.ts → closure.ts`
 * 的循环 (M0 是接缝的宿主)。所以这里声明一份, 由本线的测试断言它与 M0 的常量相等 ——
 * 一旦漂移, 门判红 (不是靠人记得改两处)。
 */
export const SKILL_CANDIDATES_ROOT = '.bolloon/skill-candidates';

// ============================================================================
// §1. 终止路径名册 (规则 ④ 的第一半: 每条终止路径都有归属)
// ============================================================================

export const CLOSURE_TERMINAL_KINDS = [
  'success',
  'failure',
  'interrupted',
  'crash_recovery',
  'stall',
  'manual_stop',
  'timeout',
  'permission_or_payment_or_tool_failure',
  'child_agent_blocked',
  'escalated_to_human',
  'awaiting_external',
] as const;
export type ClosureTerminalKind = (typeof CLOSURE_TERMINAL_KINDS)[number];

/**
 * run-store 里**会终结/收束一条 Run** 的状态 (相对地 `queued` / `running` 是"还在飞", 见
 * `RUN_IN_FLIGHT_STATUSES`)。
 *
 * ★ 2026-09-26 实测修正: `recovering` **必须**在里面 —— 中断恢复路径上, Runner 先调
 *   `prepareResume` (Run → recovering), 收尾看到的 Run 状态就是 `recovering` (实测: 监督者的
 *   resume 分支就是这样收尾的)。漏掉它, 这条路径的收尾就会被判"没登记在任何终止路径上"。
 */
export const RUN_TERMINAL_STATUSES = [
  'done',
  'failed',
  'aborted',
  'interrupted',
  'recovering',
  'stalled',
  'paused',
  'needs_human',
  'awaiting_external',
] as const;

/** 还没结束的状态 (在这个状态下收尾 = 收尾一个还在飞的 Run, 记 note 而不是判缺口) */
export const RUN_IN_FLIGHT_STATUSES = ['queued', 'running'] as const;

export interface ClosureTerminalPath {
  kind: ClosureTerminalKind;
  label: string;
  /** seams.ts 名册上对应的终止路径 (`TERMINAL_PATHS[].path`, **逐字**) */
  seamLabels: readonly string[];
  /** 这条路径终结时 Run 可以处于哪些状态 (申报必须与 Run 事实一致) */
  runStatuses: readonly string[];
  /** 该状态**主**归哪条路径 (一条终止状态只允许一个主归属) */
  primary?: boolean;
  why: string;
}

/**
 * 八类终止 (§5 的清单是**最低要求**) + 三类 run-store 的其余终止状态。
 *
 * 为什么多出三类: `needs_human` (无进展熔断/需要人决定) 与 `awaiting_external` (挂起等外部)
 * 同样是"这条 Run 结束了", 它们**也必须**收尾 —— 名册漏掉它们, 那两条路径就会静默绕过唯一责任链。
 * 另外三条 (`timeout` / `permission_or_payment_or_tool_failure` / `child_agent_blocked`) 在
 * run-store 里只表现为 `failed` / `aborted` / `stalled` / `needs_human`: 它们是**由调用方申报**的
 * 具体路径 (同一个出口, 但收尾时要如实写明是哪一类), 所以与主归属共用状态集。
 */
export const CLOSURE_TERMINAL_PATHS: readonly ClosureTerminalPath[] = [
  {
    kind: 'success',
    label: '成功 (Run 正常完成)',
    seamLabels: ['成功 (Run 正常完成)'],
    runStatuses: ['done'],
    primary: true,
    why: 'Runner 正常跑完 → 收尾决定了"目标是否完成", 不能只在成功时顺手收个尾',
  },
  {
    kind: 'failure',
    label: '失败 (Runner 内 finishRun)',
    seamLabels: ['失败 / 中断恢复 (Runner 内 finishRun)'],
    runStatuses: ['failed'],
    primary: true,
    why: '失败也是事实: 失败 Run 同样要写 Memory/候选并给出下一步',
  },
  {
    kind: 'interrupted',
    label: '中断恢复 (Runner 内 finishRun)',
    seamLabels: ['失败 / 中断恢复 (Runner 内 finishRun)', '崩溃恢复 (孤儿对账 → interrupted) / 失速 (stalled)'],
    runStatuses: ['interrupted', 'recovering'],
    primary: true,
    why: '中断的 Run 不许"没收尾就没了": 恢复决策与收尾事实要落在同一份记录上; 恢复路径上收尾时 Run 正处于 recovering (Runner 已 prepareResume)',
  },
  {
    kind: 'crash_recovery',
    label: '崩溃恢复 (孤儿对账)',
    seamLabels: ['崩溃恢复 (孤儿对账 → interrupted) / 失速 (stalled)'],
    runStatuses: ['interrupted', 'recovering'],
    why: '进程死掉后由 run-store 对账判 interrupted, 再经终止钩子回到唯一责任链',
  },
  {
    kind: 'stall',
    label: '失速 (stalled)',
    seamLabels: ['崩溃恢复 (孤儿对账 → interrupted) / 失速 (stalled)'],
    runStatuses: ['stalled'],
    primary: true,
    why: '巡检判定无进展 → stalled 同样要收尾 (否则"没有进展"永远不产生教训)',
  },
  {
    kind: 'manual_stop',
    label: '人工暂停 / 中止 (外部控制面)',
    seamLabels: ['人工暂停 / 中止 (外部控制面)'],
    runStatuses: ['paused', 'aborted'],
    primary: true,
    why: '人叫停是最强语义: 收尾必须如实记"是谁停的、还剩什么", 不许假装完成',
  },
  {
    kind: 'timeout',
    label: '超时 / 预算耗尽 (收尾即放弃)',
    seamLabels: ['超时 / 预算耗尽 (收尾即放弃)'],
    runStatuses: ['failed', 'aborted'],
    why: '与失败/中止共用出口; 由调用方申报具体是超时还是预算耗尽 (收尾要如实写明)',
  },
  {
    kind: 'permission_or_payment_or_tool_failure',
    label: '权限 / 支付 / 工具失败',
    seamLabels: ['失败 / 中断恢复 (Runner 内 finishRun)'],
    runStatuses: ['failed', 'aborted', 'interrupted'],
    why: '与失败共用 finishRun 出口; 由调用方申报是哪一类 (这三类失败最常被"重试掉", 必须留事实)',
  },
  {
    kind: 'child_agent_blocked',
    label: '子 Agent 被阻塞 (升级 / 接管)',
    seamLabels: ['子 Agent 被阻塞 (升级 / 接管)'],
    runStatuses: ['stalled', 'needs_human'],
    why: '子被阻塞会终结父的一轮 Run (stalled/needs_human) → 同样要过收尾',
  },
  {
    kind: 'escalated_to_human',
    label: '升级给人 (needs_human)',
    seamLabels: ['失败 / 中断恢复 (Runner 内 finishRun)'],
    runStatuses: ['needs_human'],
    primary: true,
    why: '无进展熔断 / 需要人决定 → Run 以 needs_human 结束, 收尾要写清"等人做什么"',
  },
  {
    kind: 'awaiting_external',
    label: '挂起等外部 (awaiting_external)',
    seamLabels: ['失败 / 中断恢复 (Runner 内 finishRun)'],
    runStatuses: ['awaiting_external'],
    primary: true,
    why: '等外部回话也是一次终止 (由事件或 wakeAt 唤醒) —— 收尾要写下唤醒条件',
  },
] as const;

/** 终止状态 → **主**终止路径 (拿不到 = 这个状态没有归属, 门必须跟着补) */
export function closureTerminalKindFor(status: unknown): ClosureTerminalKind | null {
  const s = String(status ?? '');
  if (!s) return null;
  const hit = CLOSURE_TERMINAL_PATHS.find((p) => p.primary === true && p.runStatuses.includes(s));
  return hit ? hit.kind : null;
}

/** 申报的终止路径是否接受这个 Run 状态 (truthfulness: 不许把失败路径报成成功路径) */
export function terminalKindAccepts(kind: ClosureTerminalKind, status: unknown): { ok: boolean; reason: string } {
  const s = String(status ?? '');
  const path0 = CLOSURE_TERMINAL_PATHS.find((p) => p.kind === kind);
  if (path0) {
    if (path0.runStatuses.includes(s)) return { ok: true, reason: `路径 ${kind} 接受状态 ${s}` };
    return {
      ok: false,
      reason: `终止路径申报与 Run 事实不符: 申报 ${kind}, 但 Run 状态是 ${s || '(未知)'} (该路径只接受: ${path0.runStatuses.join(' / ')})`,
    };
  }
  return { ok: false, reason: `终止路径 ${kind} 不在名册上 (CLOSURE_TERMINAL_KINDS)` };
}

export interface TerminalCoverage {
  /** 有终止状态没有主归属 (非空 = 有路径会静默收尾) */
  unmappedStatuses: string[];
  /** seams.ts 名册上登记过的终止路径, 本接缝一条都没认领 (登记过时) */
  unclaimedSeamLabels: string[];
  /** 本接缝登记引用了 seams.ts 名册上不存在的路径 (说了一个不存在的世界) */
  unknownSeamLabels: string[];
  kindCount: number;
  seamPathCount: number;
}

/**
 * 名册自检 (纯函数): 终止状态 ↔ 终止路径**互相覆盖**。
 *
 * 阴性对照: 把 `escalated_to_human` 从名册里删掉 → `unmappedStatuses` 立刻出现 `needs_human`;
 * 把 seams.ts 名册里某条路径改名 → `unknownSeamLabels` + `unclaimedSeamLabels` 同时出现。
 */
export function terminalRegistryCoverage(
  registry: readonly ClosureTerminalPath[] = CLOSURE_TERMINAL_PATHS,
  seamPaths: readonly { path: string }[] = TERMINAL_PATHS,
): TerminalCoverage {
  const seamLabels = seamPaths.map((p) => String(p.path));
  const claimed = new Set<string>();
  for (const p of registry) for (const l of p.seamLabels) claimed.add(l);

  return {
    unmappedStatuses: RUN_TERMINAL_STATUSES.filter((s) => !registry.some((p) => p.primary === true && p.runStatuses.includes(s))),
    unclaimedSeamLabels: seamLabels.filter((l) => !claimed.has(l)),
    unknownSeamLabels: [...claimed].filter((l) => !seamLabels.includes(l)),
    kindCount: registry.length,
    seamPathCount: seamLabels.length,
  };
}

// ============================================================================
// §2. 收尾产物的必备面 (规则 ④ 的第二半: 收尾必须**做完**且**落在盘上**)
// ============================================================================

export const CLOSURE_ARTIFACT_KINDS = [
  'steps',
  'decision',
  'next_action',
  'continuation_state',
  'continuation_time',
  'user_report',
  'terminal_kind',
  'artifact_paths',
  'artifact_files',
  'memory_layers',
  'candidate_trial_scope',
] as const;
export type ClosureArtifactKind = (typeof CLOSURE_ARTIFACT_KINDS)[number];

/**
 * 收尾结果的最小面。
 *
 * 刻意只带**冻结层类型** (`../types.js` 的 `ContinuationDecision` / `GoalContinuationRecord` /
 * `UserReport`): 于是接缝不必 import 接线层的 `CloseRunResult`, 也不会有循环依赖,
 * 而调用方 (Supervisor) 依然拿得到"下一步是什么"的全量决策 —— 不做有损投影。
 */

/**
 * 候选产出处开出的 Skill 试用 (**只看结论**; 试用记录本体写在候选文件里, 不在这里再存一份)。
 *
 * 为什么形态是结构化的而不是直接转发 M2 的 `SkillChannelAdmission`: 接缝不 import 别的阶段
 * 实现 (同一纪律见 `toClosureView` / run-closure 的文件头), 但调用方必须能核验
 * "候选产出时到底开没开成试用、卡在哪一步" —— 于是这里固定一份最小的结构化面。
 */
export interface TrialOpeningView {
  candidateId: string;
  skillName: string;
  /** 准入结论: 六个阶段全过 = true (未过 → false, 且 `refusal` 说清卡在哪一步) */
  ok: boolean;
  /** 六阶段逐条裁决 (含 `not_reached` —— 不许静默省略) */
  stages: readonly { stage: string; status: string; reason: string }[];
  refusal: { stage: string; reason: string } | null;
  /** 候选文件落点 (垃圾候选不落盘 → null) */
  path: string | null;
}

export interface ClosureOutcomeView {
  runId: string;
  goalId: string;
  /** 走过几步 (冻结面 RUN_CLOSURE_STEPS 有 9 步; 少一步 = 收尾没做完) */
  steps: number;
  /** 权威继续决策 (全量, 不是摘要) */
  decision: ContinuationDecision;
  /** 飞轮权威 continuation (写回 Goal 前的那一份) */
  continuation: GoalContinuationRecord;
  /** 用户汇报 (P4b 第一份输出) */
  userReport: UserReport;
  /** 本轮 Run 的状态 (收尾时读到的事实) */
  runStatus: WorkReportStatus | string;
  memories: number;
  candidates: number;
  /**
   * ★ 2026-09-25 (串行收口): 候选产出处**开出**的 Skill 试用 (每个候选一份)。
   * 这是 M2 通道在真路径上的入口证据 —— 「候选写出来了但没开试用」在这里就能看见 (数组短了)。
   */
  trials: readonly TrialOpeningView[];
  reportPath: string;
  decisionRecordPath: string;
}

/** 真读盘的结果 (不是复述入参) */
export interface ClosureArtifactProbe {
  /** 真的读到盘了吗 (路径不是本仓布局 / 读盘失败 → false, 如实说) */
  scanned: boolean;
  home: string | null;
  reportFile: boolean;
  decisionRecordFile: boolean;
  /** `<home>/.bolloon/memory-layers/<layer>/` 里属于这条 Run 的记录数 */
  memoryFiles: number;
  /** 落错层的记忆 (`layer` 与目录不一致 → P1b 分层被破坏) */
  layerMismatches: string[];
  /** 属于这条 Run 的候选文件数 */
  candidateFiles: number;
  /** 候选文件里试用范围不对的 (必须是 next_run_only + 不作用于运行中的 Run) */
  trialScopeViolations: string[];
  notes: string[];
}

/**
 * 从产物路径反推 `<home>`: `<home>/.bolloon/<root>/<file>` → 去掉最后 3 段。
 * 路径不是这个布局 (或不是绝对路径) → null (接缝**不猜**, 直接如实说"扫不了")。
 */
export function homeFromArtifactPath(artifactPath: unknown): string | null {
  const p = typeof artifactPath === 'string' ? artifactPath : '';
  if (!p || !path.isAbsolute(p)) return null;
  let cur = p;
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(cur);
    if (!parent || parent === cur) return null;
    cur = parent;
  }
  // 倒数第二段必须是 `.bolloon` (布局判据: 否则它只是"碰巧有三层"的路径)
  if (path.basename(path.dirname(path.dirname(p))) !== '.bolloon') return null;
  return cur;
}

async function statIsFile(p: string): Promise<boolean> {
  if (!p) return false;
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readJsonObjects(dir: string): Promise<{ file: string; value: Record<string, unknown> | null }[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { file: string; value: Record<string, unknown> | null }[] = [];
  for (const f of names.filter((n) => n.endsWith('.json')).sort()) {
    let value: Record<string, unknown> | null = null;
    try {
      value = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      value = null;
    }
    out.push({ file: f, value });
  }
  return out;
}

/**
 * 真读盘: 这条 Run 的收尾产物到底在不在, 形态对不对。
 *
 * 读盘失败也**不抛**: 记为 `scanned:false` + note (拿不到事实就说拿不到, 不假装收好也不假装没收)。
 */
export async function probeClosureArtifacts(view: ClosureOutcomeView): Promise<ClosureArtifactProbe> {
  const notes: string[] = [];
  const base: ClosureArtifactProbe = {
    scanned: false,
    home: null,
    reportFile: false,
    decisionRecordFile: false,
    memoryFiles: 0,
    layerMismatches: [],
    candidateFiles: 0,
    trialScopeViolations: [],
    notes,
  };

  const home = homeFromArtifactPath(view?.reportPath) ?? homeFromArtifactPath(view?.decisionRecordPath);
  if (!home) {
    notes.push('artifact_layout_unknown: 产物路径不是 <home>/.bolloon/<root>/<file> 的形状 (或不是绝对路径) → 不猜盘上位置, 本项审计记为未扫');
    return base;
  }

  try {
    const reportFile = await statIsFile(view.reportPath);
    const decisionRecordFile = await statIsFile(view.decisionRecordPath);
    const runId = String(view.runId ?? '');

    const memoryFiles: string[] = [];
    const layerMismatches: string[] = [];
    for (const layer of MEMORY_LAYERS) {
      for (const { file, value } of await readJsonObjects(path.join(home, MEMORY_LAYERS_ROOT, layer))) {
        if (!value || String(value.runId ?? '') !== runId) continue;
        memoryFiles.push(`${layer}/${file}`);
        if (String(value.layer ?? '') !== layer) {
          layerMismatches.push(`${layer}/${file}: 记录里的 layer=${String(value.layer)} (落错层)`);
        }
      }
    }

    let candidateFiles = 0;
    const trialScopeViolations: string[] = [];
    for (const { file, value } of await readJsonObjects(path.join(home, SKILL_CANDIDATES_ROOT))) {
      if (!value || String(value.proposedByRunId ?? '') !== runId) continue;
      candidateFiles += 1;
      // ★ 候选本身**没有**范围字段 (`SkillImprovementCandidate` 里没有 snapshotScope —— 范围是
      //   `openSkillTrial` 在开试用时写进 `SkillTrialRecord`/`SkillPromotionRecord` 的)。
      //   所以这里只查"**若**它声明了范围, 声明得安全吗": 声明了 all_runs / 作用于运行中的 Run
      //   = 会覆盖正在执行的 snapshot → 判红。字段缺席**不是**缺口 (那是"还没开试用", 由通道管),
      //   只记一条 note —— 否则这条检查会对每条正常 Run 刷假红。
      const declaresScope = Object.prototype.hasOwnProperty.call(value, 'snapshotScope')
        || Object.prototype.hasOwnProperty.call(value, 'appliesToRunningRun');
      if (declaresScope) {
        const scope = String(value.snapshotScope ?? '');
        const applies = value.appliesToRunningRun;
        if (scope !== 'next_run_only' || applies !== false) {
          trialScopeViolations.push(`${file}: snapshotScope=${scope || '(空)'}, appliesToRunningRun=${String(applies)} (试用必须 next_run_only 且不作用于运行中的 Run)`);
        }
      }
    }

    return {
      scanned: true,
      home,
      reportFile,
      decisionRecordFile,
      memoryFiles: memoryFiles.length,
      layerMismatches,
      candidateFiles,
      trialScopeViolations,
      notes,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    notes.push(`artifact_scan_failed: 读盘失败 (${msg}) → 本项审计记为未扫, 不假装收好`);
    return base;
  }
}

export interface ClosureAudit {
  complete: boolean;
  missing: ClosureArtifactKind[];
  reasons: string[];
  /** 软提示: 不算缺, 但必须如实记下来 */
  notes: string[];
  terminalKind: {
    derived: ClosureTerminalKind | null;
    claimed: ClosureTerminalKind | null;
    truthful: boolean;
    reason: string;
  };
  probe: ClosureArtifactProbe | null;
}

const FORBIDDEN_REPORT_WORDS = MUST_NOT_EXPOSE_FIELDS.map((f) => String(f));

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/**
 * 收尾产物审计 (**纯函数**; 盘上那一半由 `probeClosureArtifacts` 传进来)。
 *
 * 期望值全部从**真实结构**推导: 步数来自 `CLOSURE_STEP_ORDER`, 决策取值来自
 * `CONTINUATION_DECISIONS`, 决策↔状态映射来自 `run-closure.GOAL_STATE_FOR_DECISION`
 * (单一来源, 不在这里重抄), 用户汇报的面来自 `USER_REPORT_FIELDS` / `USER_VISIBLE_STATES` /
 * `MUST_NOT_EXPOSE_FIELDS`。因此这些冻结面一旦变了, 审计**跟着变**, 不会变成一句过期的话。
 */
export function auditClosureOutcome(
  view: ClosureOutcomeView | null,
  ctx: { now: IsoTimestamp; claimedKind?: ClosureTerminalKind | null; probe?: ClosureArtifactProbe | null },
): ClosureAudit {
  const missing: ClosureArtifactKind[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];
  const claimed = ctx?.claimedKind ?? null;
  const probe = ctx?.probe ?? null;
  const runStatus = String(view?.runStatus ?? '');
  const derived = closureTerminalKindFor(runStatus);
  const truth = claimed ? terminalKindAccepts(claimed, runStatus) : { ok: derived !== null, reason: '' };
  const terminalKind = {
    derived,
    claimed,
    truthful: truth.ok,
    reason: truth.ok
      ? claimed
        ? `申报路径 ${claimed} 与 Run 状态 ${runStatus} 一致`
        : `未申报终止路径; 由 Run 状态 ${runStatus} 推导为 ${String(derived)}`
      : claimed
        ? truth.reason
        : `Run 状态 ${runStatus || '(未知)'} 没有登记在任何终止路径上 → 有路径会静默绕过收尾 (名册必须跟着补)`,
  };

  const mark = (kind: ClosureArtifactKind, reason: string): void => {
    if (!missing.includes(kind)) missing.push(kind);
    reasons.push(reason);
  };

  if (!view) {
    mark('artifact_paths', 'no_outcome: 拿不到收尾产物 (不编造一份)');
    return { complete: false, missing, reasons, notes, terminalKind, probe };
  }

  // ── 步 / 决策 / 下一步 / continuation ────────────────────────────────────
  if (!(view.steps >= CLOSURE_STEP_ORDER.length)) {
    mark('steps', `收尾只走了 ${view.steps}/${CLOSURE_STEP_ORDER.length} 步 (被截断的收尾不算收尾)`);
  }
  const d = view.decision;
  if (!d || typeof d.decisionId !== 'string' || !d.decisionId || !(CONTINUATION_DECISIONS as readonly string[]).includes(String(d.decision))) {
    mark('decision', `继续决策缺失/不合法 (decisionId=${String(d?.decisionId)}, decision=${String(d?.decision)})`);
  }
  if (!String(view.continuation?.nextAction ?? '').trim()) {
    mark('next_action', 'Goal 上没有任何"下一步" → 悬空态 (冻结纪律: 只有终态可以不回答下一步)');
  }
  if (d && (CONTINUATION_DECISIONS as readonly string[]).includes(String(d.decision))) {
    const expected = GOAL_STATE_FOR_DECISION[d.decision];
    if (String(view.continuation?.state ?? '') !== expected) {
      mark('continuation_state', `continuation.state=${String(view.continuation?.state)} 与决策 ${d.decision} 要求的 ${expected} 不一致`);
    }
  }
  if (String(view.continuation?.updatedAt ?? '') !== String(ctx.now ?? '')) {
    mark('continuation_time', `continuation.updatedAt=${String(view.continuation?.updatedAt)} 不是这一轮的时间 (${String(ctx.now)}) → 不许拿上一轮的 continuation 冒充`);
  }

  // ── 用户汇报 (P4b 第一份输出) ────────────────────────────────────────────
  const rep = view.userReport;
  if (!rep || typeof rep !== 'object') {
    mark('user_report', '缺少用户汇报 (收尾必须给人一份能读的结论)');
  } else {
    if (!(USER_VISIBLE_STATES as readonly string[]).includes(String(rep.visibleState))) {
      mark('user_report', `用户可见态 ${String(rep.visibleState)} 不在六类里`);
    }
    if (!sameStringSet((rep.exposedFields ?? []) as readonly string[], USER_REPORT_FIELDS)) {
      mark('user_report', `暴露面与 USER_REPORT_FIELDS 不一致 (收到 ${String((rep.exposedFields ?? []).length)} 项) → 汇报面不许自己长`);
    }
    const leaked = Object.keys(rep as unknown as Record<string, unknown>).filter((k) => FORBIDDEN_REPORT_WORDS.includes(k));
    if (leaked.length > 0) {
      mark('user_report', `用户汇报里出现了内部字段: ${leaked.join(', ')}`);
    }
    const text = JSON.stringify(rep);
    const wordHits = FORBIDDEN_REPORT_WORDS.filter((w) => text.includes(w));
    if (wordHits.length > 0) {
      notes.push(`report_text_mentions_internal_words: ${wordHits.join(', ')} —— 值里的自由文本 (决策理由等) 不由本接缝改写, 交 M4 的可见态线处理`);
    }
  }

  // ── 终止路径 (规则 ④: 说不清是哪条路径的收尾等于没收) ─────────────────────
  if (!terminalKind.truthful) {
    if (!claimed && (RUN_IN_FLIGHT_STATUSES as readonly string[]).includes(runStatus)) {
      // 还在飞的状态收尾 (外部暂停等): 不判缺口 —— 它本来就还没"终止", 但如实记一条 note
      notes.push(`run_status_in_flight: 收尾时 Run 仍是 ${runStatus} (还没终止) → 无终止路径可归属, 本次不判缺口`);
    } else {
      mark('terminal_kind', terminalKind.reason);
    }
  }

  // ── 产物落点 ─────────────────────────────────────────────────────────────
  if (!String(view.reportPath ?? '') || !String(view.decisionRecordPath ?? '')) {
    mark('artifact_paths', '收尾没有给出产物路径 (产物落在哪里答不出来)');
  }
  if (probe?.scanned) {
    if (!probe.reportFile) mark('artifact_files', `用户汇报文件不在盘上: ${view.reportPath}`);
    if (!probe.decisionRecordFile) mark('artifact_files', `closure 决策记录不在盘上: ${view.decisionRecordPath}`);
    if (view.memories > 0 && probe.memoryFiles === 0) {
      mark('memory_layers', `收尾报告写了 ${view.memories} 条事实, 但盘上找不到属于这条 Run 的分层记录 (${MEMORY_LAYERS_ROOT}/)`);
    }
    if (probe.layerMismatches.length > 0) {
      mark('memory_layers', `落错层的记忆: ${probe.layerMismatches.join('; ')}`);
    }
    if (probe.trialScopeViolations.length > 0) {
      mark('candidate_trial_scope', `候选文件丢了 next_run_only 试用范围: ${probe.trialScopeViolations.join('; ')}`);
    }
    notes.push(...probe.notes);
  } else {
    notes.push('artifact_disk_check_skipped: 没能读盘 (路径布局未知/读盘失败) → 产物"在不在盘上"这一项本次未验');
  }

  return { complete: missing.length === 0, missing, reasons, notes, terminalKind, probe };
}

// ============================================================================
// §3. 收据 (接缝回答"产物落在哪里"的那张单子)
// ============================================================================

export interface ClosureReceipt {
  runId: string;
  goalId: string;
  /** 调用方申报的终止路径 (`unspecified` = 没申报, 由 Run 事实推导) */
  claimedTerminalKind: ClosureTerminalKind | 'unspecified';
  /** 由 Run 事实推导出的终止路径 */
  derivedTerminalKind: ClosureTerminalKind | null;
  terminalKindTruthful: boolean;
  steps: number;
  decision: ContinuationDecisionKind | null;
  state: string | null;
  nextAction: string;
  memories: number;
  candidates: number;
  temporaryArchived: number | null;
  artifacts: {
    reportPath: string;
    decisionRecordPath: string;
    reportOnDisk: boolean | null;
    decisionRecordOnDisk: boolean | null;
    memoryFiles: number | null;
    candidateFiles: number | null;
  };
  audit: ClosureAudit;
}

/** 收据的字段集 (断言只加不减: 字段变少 = 收据在退步) */
export const CLOSURE_RECEIPT_FIELDS = [
  'runId',
  'goalId',
  'claimedTerminalKind',
  'derivedTerminalKind',
  'terminalKindTruthful',
  'steps',
  'decision',
  'state',
  'nextAction',
  'memories',
  'candidates',
  'temporaryArchived',
  'artifacts',
  'audit',
] as const;

function buildReceipt(
  view: ClosureOutcomeView,
  audit: ClosureAudit,
  claimed: ClosureTerminalKind | null,
  temporaryArchived: number | null,
): ClosureReceipt {
  const probe = audit.probe;
  return {
    runId: view.runId,
    goalId: view.goalId,
    claimedTerminalKind: claimed ?? 'unspecified',
    derivedTerminalKind: audit.terminalKind.derived,
    terminalKindTruthful: audit.terminalKind.truthful,
    steps: view.steps,
    decision: (view.decision?.decision ?? null) as ContinuationDecisionKind | null,
    state: (view.continuation?.state ?? null) as string | null,
    nextAction: String(view.continuation?.nextAction ?? ''),
    memories: view.memories,
    candidates: view.candidates,
    temporaryArchived,
    artifacts: {
      reportPath: String(view.reportPath ?? ''),
      decisionRecordPath: String(view.decisionRecordPath ?? ''),
      reportOnDisk: probe?.scanned ? probe.reportFile : null,
      decisionRecordOnDisk: probe?.scanned ? probe.decisionRecordFile : null,
      memoryFiles: probe?.scanned ? probe.memoryFiles : null,
      candidateFiles: probe?.scanned ? probe.candidateFiles : null,
    },
    audit,
  };
}

// ============================================================================
// §4. 接缝本体
// ============================================================================

export interface ClosureSeamDeps {
  /** 幂等判据: 这条 Run 已经有 closure 决策记录了吗 */
  hasClosure: (goalId: string, runId: string) => Promise<boolean>;
  /** 收尾本体 (M0 接线层注入的真实现: closeRun + Memory 落盘 + 候选 + 用户汇报) */
  closeGoalRun: (input: {
    goalId: string;
    runId: string;
    now: IsoTimestamp;
    finalReview: string;
    maxRetries?: number;
  }) => Promise<ClosureOutcomeView | null>;
  /** 任务结束 → 归档过期临时记忆 (P1b: temporary 层自动过期) */
  purgeTemporary?: () => Promise<number>;
  /** 记一条审计事实 (谁在什么时候因为什么收了尾) */
  note?: (line: string) => void;
}

export interface CloseRunOnceResult {
  /**
   * 这次调用**做成了**吗 (真收了尾 / 幂等短路)。
   *
   * ★ 注意语义: `ok:false` 在这套接缝协议里 = **被拒** (`seams.ts` 的 `isRefusal` 判据就是
   * `ok===false && typeof reason === 'string'`)。所以"收尾做了但产物有缺口"**不许**用 ok:false 表达
   * (会被调用方当成拒绝 → 真收尾的 Run 从 report 里消失), 改用 `artifactsComplete`。
   */
  ok: boolean;
  /** 这次调用**没有**做事 (同一条 Run 已经收过尾) */
  alreadyClosed: boolean;
  goalId: string;
  runId: string;
  outcome: ClosureOutcomeView | null;
  reason: string;
  /** 收尾产物齐不齐 (M2 新增; 缺什么看 `receipt.audit.missing`) */
  artifactsComplete?: boolean;
  /** 收据 (M2 新增, 可选: 老调用方不读它也照样编译) */
  receipt?: ClosureReceipt | null;
}

export interface ClosureSeam {
  readonly id: typeof CLOSURE_SEAM_ID;
  readonly stage: 'M2';
  closeRunOnce(input: {
    goalId: string;
    runId: string;
    caller: WiringCaller;
    now: IsoTimestamp;
    finalReview?: string;
    maxRetries?: number;
    /** 申报的终止路径 (不申报 = 由 Run 事实推导; 申报了就必须与事实一致) */
    terminalKind?: ClosureTerminalKind;
  }): Promise<CloseRunOnceResult | SeamRefusal>;
}

/** 幂等标记 + 审计行 (落进既有的 closure 决策记录, 不新增存储) */
export const CLOSURE_IDEMPOTENCY_NOTE =
  '同一条 runId 只允许收一次尾: 第二次调用返回 alreadyClosed=true 且不写任何东西 '
  + '(判据 = 既有的 .bolloon/goal-decisions/<goalId>--<runId>--closure.json 是否存在)';

export function createClosureSeam(deps: ClosureSeamDeps): ClosureSeam {
  return {
    id: CLOSURE_SEAM_ID,
    stage: 'M2',
    async closeRunOnce(input) {
      const goalId = String(input?.goalId ?? '');
      const runId = String(input?.runId ?? '');
      const caller = input?.caller;
      const now = input?.now;

      // ── ① 说不清是哪条 Run / 谁在收 / 什么时候收 → 一律拒 ────────────────────
      if (!goalId || !runId) {
        return refuse(
          'all_terminal_paths_pass_close_run',
          `拒绝: 收尾缺少 ${!goalId ? 'goalId' : 'runId'} —— 说不清是哪条 Run 的收尾等于没收`,
        );
      }
      if (!now) {
        return refuse('all_terminal_paths_pass_close_run', '拒绝: 收尾没有时间戳 (now 必须注入, 不许读真实钟)');
      }
      if (!(WIRING_CALLERS as readonly string[]).includes(String(caller))) {
        return refuse(
          'all_terminal_paths_pass_close_run',
          `拒绝: 调用方 "${String(caller)}" 不是已知身份 (只认 ${WIRING_CALLERS.join('/')}) —— 收尾要记清是谁在收`,
        );
      }
      if (caller === 'child_agent') {
        return refuse(
          'child_cannot_mutate_goal',
          '拒绝: 子 Agent 不能收尾 (收尾会改 Goal 的 continuation 与 Memory) —— 由父/宿主收 (CHILD_PROHIBITIONS.mutate_parent_goal_state)',
        );
      }

      const claimed = input?.terminalKind ?? null;
      if (claimed !== null && !(CLOSURE_TERMINAL_KINDS as readonly string[]).includes(String(claimed))) {
        return refuse(
          'all_terminal_paths_pass_close_run',
          `拒绝: "${String(claimed)}" 不是名册上的终止路径 (只认 ${CLOSURE_TERMINAL_KINDS.join('/')}) —— 路径不明就不许收尾`,
        );
      }

      // ── ② 幂等: 同一条 Run 只真收一次 ─────────────────────────────────────
      if (await deps.hasClosure(goalId, runId)) {
        deps.note?.(`[closure] run=${runId} 已经收过尾 → 幂等短路 (caller=${caller})`);
        return {
          ok: true,
          alreadyClosed: true,
          goalId,
          runId,
          outcome: null,
          receipt: null,
          reason: `同一条 Run 已收尾 (${runId}) → 不重复写: ${CLOSURE_IDEMPOTENCY_NOTE}`,
        };
      }

      // ── ③ 真收尾 ─────────────────────────────────────────────────────────
      const outcome = await deps.closeGoalRun({
        goalId,
        runId,
        now,
        finalReview: input.finalReview ?? '',
        maxRetries: input.maxRetries,
      });
      if (!outcome) {
        return {
          ok: false,
          alreadyClosed: false,
          goalId,
          runId,
          outcome: null,
          receipt: null,
          reason: `收尾做不到: 拿不到 Run 或 Goal 事实 (goal=${goalId} run=${runId}) → 不编造收尾产物`,
        };
      }

      // ── ④ P1b: temporary 层过期归档 (任务结束的必经一步) ────────────────────
      let archived: number | null = null;
      if (deps.purgeTemporary) {
        archived = await deps.purgeTemporary().then((n) => (Number.isFinite(n) ? n : null), () => null);
      }

      // ── ⑤ 产物审计: 收尾做完了吗 + 落在哪里 (真读盘) ────────────────────────
      const probe = await probeClosureArtifacts(outcome);
      const audit = auditClosureOutcome(outcome, { now, claimedKind: claimed, probe });
      const receipt = buildReceipt(outcome, audit, claimed, archived);
      const kind = receipt.claimedTerminalKind === 'unspecified' ? String(receipt.derivedTerminalKind) : receipt.claimedTerminalKind;

      deps.note?.(
        `[closure] run=${runId} 收尾 ${outcome.steps} 步 → ${receipt.decision} (路径=${kind}, caller=${caller}, `
        + `产物完整=${audit.complete}${audit.complete ? '' : `, 缺: ${audit.missing.join(',')}`})`,
      );

      if (!audit.complete) {
        // ★ 2026-09-26 (M2) 为什么这里**不能**返回 ok:false:
        //   接缝协议里 ok:false 就是"被拒" (`seams.ts` 的 `isRefusal` 判据 =
        //   `ok===false && typeof reason === 'string'`)。收尾**真的做完了**却报 ok:false, 调用方会把它
        //   当拒绝处理 —— 实测: 监督者会把这条 Run 从 report.closures 里丢掉 (一条真收尾的 Run 变成
        //   "没收尾"), 于是"产物有缺口"这个信号被伪装成"收尾被拒", 两件事都失真。
        //   所以: 产品缺口走 `artifactsComplete:false` + reason 首句 + 收据里的明细, 不用 ok 表达。
        return {
          ok: true,
          alreadyClosed: false,
          goalId,
          runId,
          outcome,
          artifactsComplete: false,
          receipt,
          reason: `收尾完成但产物有缺口 (路径=${kind}): 缺 ${audit.missing.join(', ')} —— ${audit.reasons.join(' | ')}`,
        };
      }

      return {
        ok: true,
        alreadyClosed: false,
        goalId,
        runId,
        outcome,
        artifactsComplete: true,
        receipt,
        reason: `收尾 ${outcome.steps} 步 → ${String(receipt.decision)} (路径=${kind}; 产物齐)`,
      };
    },
  };
}

// ============================================================================
// §5. 终止路径覆盖 (规则 ④ 的可核验形式: 终止了就必须有收尾记录)
// ============================================================================

export interface TerminalTermination {
  goalId: string;
  runId: string;
  kind: ClosureTerminalKind;
  terminatedAt: IsoTimestamp;
}

export interface TerminalCoverageGap {
  runId: string;
  kind: ClosureTerminalKind | 'unknown_kind';
  terminatedAt: IsoTimestamp;
  reason: string;
}

/**
 * 拿一批**真的终止过**的 Run, 逐条查它们有没有收尾记录。
 *
 * 为什么这条判据不能只靠源码扫描: "所有终止路径都调了漏斗"是**代码形状**,
 * 而"这条真的终止过的 Run 到底收没收尾"是**事实**。两者都要有; 后者只能这样查。
 * 读不到 (`hasClosure` 抛错) 时按"没收到"处理并如实记原因 —— 不许把"查不出来"当成"收过了"。
 */
export async function auditTerminalCoverage(input: {
  terminations: readonly TerminalTermination[];
  hasClosure: (goalId: string, runId: string) => Promise<boolean>;
}): Promise<{ checked: number; covered: string[]; gaps: TerminalCoverageGap[] }> {
  const covered: string[] = [];
  const gaps: TerminalCoverageGap[] = [];
  for (const t of input.terminations) {
    if (!(CLOSURE_TERMINAL_KINDS as readonly string[]).includes(String(t.kind))) {
      gaps.push({ runId: t.runId, kind: 'unknown_kind', terminatedAt: t.terminatedAt, reason: `终止路径 "${String(t.kind)}" 不在名册上 → 说不清它该不该走收尾` });
      continue;
    }
    let closed = false;
    let why = '';
    try {
      closed = await input.hasClosure(t.goalId, t.runId);
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (closed) covered.push(t.runId);
    else gaps.push({ runId: t.runId, kind: t.kind, terminatedAt: t.terminatedAt, reason: why ? `查收尾记录失败: ${why}` : `这条 Run 以 ${t.kind} 终止, 但没有收尾记录 → 绕过了唯一责任链` });
  }
  return { checked: input.terminations.length, covered, gaps };
}
