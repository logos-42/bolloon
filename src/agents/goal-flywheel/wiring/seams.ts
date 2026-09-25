/**
 * goal-flywheel/wiring/seams.ts — 「唯一责任链」的**接线接缝注册表** (M0 冻结, 2026-09-25)
 *
 * ## 为什么要有这一层
 *
 * P0–P4 的七个模块 (continuation-decision / run-closure / memory-layers / skill-candidate /
 * work-contract / work-monitor / goal-change) 已经实现并接进了真实执行路径
 * (`src/agents/goal-flywheel-wiring.ts`)。但"接进去了"和"只有那么一条链"是两件事:
 * 只要还有第二个地方能结束 Run、能改 Goal 状态、能决定是否继续, 就会出现**两套事实**。
 *
 * 本文件把那条链**切成五个接缝** (seam), 每个接缝只回答一个问题, 并**声明自己归哪个阶段独占**:
 *
 * ```
 * Supervisor → Goal continuation → Runner/子 Agent → Run → closeRun → Memory + Skill 候选 → 下一次 continuation
 *                ↑ continuation        ↑ contract        ↑ closure        ↑ closure
 *                                                        ↑ monitor (阻塞)
 *                ↑ change (新要求注入 + 用户可见态)
 * ```
 *
 * ## 这个文件归 M0 独占 (接线阶段); M1–M4 只读不改
 *
 * M0 之后 M1–M4 **全部并行**。并发安全靠一条硬规则:
 *   **每个阶段只准改 `owns` 与 `wiringPoints` 列出的那些文件, 且两份清单不许有交集。**
 * 这条规则不是写在文档里让人自觉遵守 —— `seamRosterViolations()` 就是它的可执行判据,
 * 由 `src/test/goal-flywheel-wiring-freeze.test.ts` 真跑; 一旦两个阶段声明同一个文件, 门立刻判红。
 *
 * ## 每个接缝长什么样
 *
 * 接缝实现放在同目录的**一个文件**里 (`module` 字段), 只依赖三样东西:
 *   ① 本目录 `seams.ts` 里的**接口** (M0 冻结);
 *   ② `../types.js` 的冻结类型;
 *   ③ **自己那个阶段**的实现模块 (例如 closure 接缝 → `../run-closure.js`)。
 * 其余一切 (Goal/Run 的事实读取、落盘、决策函数的实例) 全部**按参数注入** ——
 * 因此没有任何两个阶段会 import 到同一个实现文件, 也就不会有 merge 冲突。
 */

// ============================================================================
// §1. 阶段与接缝的名册 (并行划分的**唯一事实来源**)
// ============================================================================

/** M0 = 接线冻结 (本文件); M1–M4 = 之后的四个并行阶段 */
export const WIRING_STAGES = ['M1', 'M2', 'M3', 'M4'] as const;
export type WiringStage = (typeof WIRING_STAGES)[number];

export const SEAM_IDS = ['continuation', 'closure', 'contract', 'monitor', 'change'] as const;
export type SeamId = (typeof SEAM_IDS)[number];

export interface SeamDescriptor {
  id: SeamId;
  /** 这条接缝归哪个阶段独占改写 */
  stage: WiringStage;
  /** 接缝回答的**唯一**问题 (写成问句: 说不清就是在造第二个责任中心) */
  question: string;
  /** 接缝实现文件 (相对本目录), 归本阶段独占 */
  module: string;
  /** 本阶段**只准**改这些文件 (相对仓库根; 含自己的测试) */
  owns: readonly string[];
  /** 本阶段允许改的**现有调用方**接线点 (相对仓库根) —— 与别的阶段不许重叠 */
  wiringPoints: readonly string[];
}

/**
 * 名册。`owns` / `wiringPoints` 的**不相交**由 `seamRosterViolations()` 强制。
 *
 * 划分依据 (与设计稿 §13 的所有权表同源):
 *   · M1 = P0 (节奏由进展决定) 的接线深化;
 *   · M2 = P1 + P1b (强制收尾 + Memory 分层 + Skill 候选通道) 的接线深化 ——
 *     **`closeRun` 只属于这一条接缝**, 因此 M2 是"所有终止路径"的唯一收口;
 *   · M3 = P2 + P3 (子 Agent 合同 + 阻塞监控) —— 两个接缝同属一个阶段, 因为它们改的是同一批事实
 *     (工作合同 / 心跳 / 回报 / 阻塞), 并行拆到两个阶段只会互相踩;
 *   · M4 = P4 (新要求注入 + 用户可见态)。
 */
export const SEAM_ROSTER: readonly SeamDescriptor[] = [
  {
    id: 'continuation',
    stage: 'M1',
    question: '这个 Goal 现在该不该开下一轮, 为什么?',
    module: 'continuation.ts',
    owns: [
      'src/agents/goal-flywheel/wiring/continuation.ts',
      'src/test/goal-flywheel-wiring-continuation.test.ts',
    ],
    wiringPoints: [
      'src/agents/goal-flywheel/continuation-decision.ts',
    ],
  },
  {
    id: 'closure',
    stage: 'M2',
    question: '这一条 Run 收尾了吗, 收尾产物落在哪里?',
    module: 'closure.ts',
    owns: [
      'src/agents/goal-flywheel/wiring/closure.ts',
      'src/test/goal-flywheel-wiring-closure.test.ts',
    ],
    wiringPoints: [
      'src/agents/goal-flywheel/run-closure.ts',
      'src/agents/goal-flywheel/memory-layers.ts',
      'src/agents/goal-flywheel/skill-candidate.ts',
    ],
  },
  {
    id: 'contract',
    stage: 'M3',
    question: '这一步该派给谁, 回报算不算完成?',
    module: 'contract.ts',
    owns: [
      'src/agents/goal-flywheel/wiring/contract.ts',
      'src/test/goal-flywheel-wiring-contract.test.ts',
    ],
    wiringPoints: [
      'src/agents/goal-flywheel/work-contract.ts',
      'src/agents/subagent-manager.ts',
    ],
  },
  {
    id: 'monitor',
    stage: 'M3',
    question: '有谁卡住了, 该谁动手?',
    module: 'monitor.ts',
    owns: [
      'src/agents/goal-flywheel/wiring/monitor.ts',
      'src/test/goal-flywheel-wiring-monitor.test.ts',
    ],
    wiringPoints: [
      'src/agents/goal-flywheel/work-monitor.ts',
    ],
  },
  {
    id: 'change',
    stage: 'M4',
    question: '人中途改了什么要求, 用户该看到哪一类状态?',
    module: 'change.ts',
    owns: [
      'src/agents/goal-flywheel/wiring/change.ts',
      'src/test/goal-flywheel-wiring-change.test.ts',
    ],
    wiringPoints: [
      'src/agents/goal-flywheel/goal-change.ts',
      'src/web/server.ts',
    ],
  },
] as const;

export const SEAM_MODULES: readonly string[] = SEAM_ROSTER.map((s) => s.module);

export function seamOf(id: SeamId): SeamDescriptor {
  const found = SEAM_ROSTER.find((s) => s.id === id);
  if (!found) throw new Error(`未知接缝: ${String(id)}`);
  return found;
}

export function seamModuleOf(id: SeamId): string {
  return seamOf(id).module;
}

export function stageOf(id: SeamId): WiringStage {
  return seamOf(id).stage;
}

/** 某阶段独占的全部文件 (owns + wiringPoints) */
export function filesOfStage(stage: WiringStage): string[] {
  const out: string[] = [];
  for (const s of SEAM_ROSTER.filter((x) => x.stage === stage)) {
    out.push(...s.owns, ...s.wiringPoints);
  }
  return out;
}

// ============================================================================
// §2. 并行不相交判据 (可执行, 不是文档里的君子协定)
// ============================================================================

export interface RosterViolation {
  kind: 'stage_overlap' | 'missing_owner' | 'unowned_seam' | 'empty_claim';
  /** 撞车的文件 (kind=stage_overlap 时) 或涉及的文件/接缝 */
  file: string;
  /** 撞在一起的两个阶段 */
  stages: WiringStage[];
  reason: string;
}

/**
 * 名册的自检: **两个阶段不许声明同一个文件**。
 *
 * 阴性对照: 把 `monitor.ts` 的 `wiringPoints` 里加上 `src/agents/goal-flywheel/work-contract.ts`
 * (M3 的 contract 接缝也声明了它) → 立刻返回一条 `stage_overlap`。
 * 返回空数组 = 并行划分成立; 非空 = **不许开并行**, 必须改成串行顺序。
 */
export function seamRosterViolations(roster: readonly SeamDescriptor[] = SEAM_ROSTER): RosterViolation[] {
  const out: RosterViolation[] = [];
  const byFile = new Map<string, Set<WiringStage>>();
  const seenSeam = new Set<string>();

  for (const seam of roster) {
    if (seenSeam.has(seam.id)) {
      out.push({ kind: 'unowned_seam', file: seam.id, stages: [seam.stage], reason: `接缝 ${seam.id} 被声明了两次` });
    }
    seenSeam.add(seam.id);

    const claims = [...seam.owns, ...seam.wiringPoints];
    if (claims.length === 0) {
      out.push({ kind: 'empty_claim', file: seam.id, stages: [seam.stage], reason: `接缝 ${seam.id} 没有声明任何文件 (等于没划分)` });
    }
    if (!seam.module || !seam.owns.some((f) => f.endsWith(`/${seam.module}`) || f.endsWith(seam.module))) {
      out.push({ kind: 'missing_owner', file: seam.module || seam.id, stages: [seam.stage], reason: `接缝 ${seam.id} 的实现文件 ${seam.module} 不在自己的 owns 清单里` });
    }
    for (const f of claims) {
      const set = byFile.get(f) ?? new Set<WiringStage>();
      set.add(seam.stage);
      byFile.set(f, set);
    }
  }

  for (const [file, stages] of byFile) {
    if (stages.size > 1) {
      out.push({
        kind: 'stage_overlap',
        file,
        stages: [...stages].sort(),
        reason: `${file} 被 ${[...stages].sort().join(' 与 ')} 同时声明 → 并行会撞车`,
      });
    }
  }
  return out;
}

/** 并行划分是否成立 (门用的布尔出口; 非空即判红)。可传入候选名册做**变异验证**。 */
export function canRunStagesInParallel(
  roster: readonly SeamDescriptor[] = SEAM_ROSTER,
): { ok: boolean; violations: RosterViolation[] } {
  const violations = seamRosterViolations(roster);
  return { ok: violations.length === 0, violations };
}

// ============================================================================
// §3. 六个接缝的共同形态 (接口在 M0 冻结; 实现按阶段各自落)
// ============================================================================

/** 调用方身份: 只有 Supervisor 能决定"是否继续", 因此必须**显式声明**是谁在问 */
export const WIRING_CALLERS = ['supervisor', 'runner', 'child_agent', 'human', 'system'] as const;
export type WiringCaller = (typeof WIRING_CALLERS)[number];

export interface SeamRefusal {
  ok: false;
  /** 结构化原因 (不许只返回 boolean; 让上层能原样记进 report/errors) */
  reason: string;
  /** 是哪条冻结规则拒绝的 (规则号见 files 头的六条) */
  rule: FrozenRule;
}

export const FROZEN_RULES = [
  'only_supervisor_decides_continuation',
  'only_goal_reducer_changes_goal_state',
  'only_close_run_closes_run',
  'all_terminal_paths_pass_close_run',
  'child_cannot_mutate_goal',
  'skill_cannot_bypass_promotion_channel',
] as const;
export type FrozenRule = (typeof FROZEN_RULES)[number];

export const FROZEN_RULE_TEXT: Record<FrozenRule, string> = {
  only_supervisor_decides_continuation: '只有 Supervisor 能决定是否继续',
  only_goal_reducer_changes_goal_state: '只有 Goal reducer 能改 Goal 状态',
  only_close_run_closes_run: '只有 closeRun 能关闭 Run',
  all_terminal_paths_pass_close_run: '所有终止路径必须经过 closeRun',
  child_cannot_mutate_goal: '子 Agent 不能直接改 Goal',
  skill_cannot_bypass_promotion_channel: 'Skill 不得绕过验证+快照+可回退通道 (M6 允许自动晋升, 但不许绕过通道)',
};

export function refuse(rule: FrozenRule, reason: string): SeamRefusal {
  return { ok: false, reason, rule };
}

export function isRefusal(x: unknown): x is SeamRefusal {
  return !!x && typeof x === 'object' && (x as SeamRefusal).ok === false && typeof (x as SeamRefusal).reason === 'string';
}

/**
 * 六条冻结规则的**源级判据** (纯函数: 吃源码文本, 吐违规清单)。
 *
 * 为什么是纯函数而不是几条 `expect`:
 *   ① 门可以**在做变异验证时喂给它一份被人为改坏的源码** —— 于是"这道门真的能抓到绕过"
 *      变成每次跑测试都在验的事, 而不是我口头说验过 (见 goal-flywheel-wiring-freeze.test.ts);
 *   ② 判据本身可被别的门复用 (例如后续阶段的子门)。
 */
export interface SourceFile {
  /** 相对仓库根的路径 */
  path: string;
  text: string;
}

export interface RuleViolation {
  rule: FrozenRule;
  /** 哪个文件违规 */
  path: string;
  /** 违规的那一行 (1-based) */
  line: number;
  snippet: string;
  reason: string;
}

/**
 * 去掉块注释, 但**保留行号** (用等量换行填空)。
 *
 * 为什么必须做: 门自己的文档里就有"真实绕过长什么样"的代码样例 (`patch.status = ...` +
 * `await updateGoal(...)`)。不剥块注释的话, **门的文档会被门自己判红**, 于是只能把门本身
 * 加进白名单 —— 白名单一多, 真信号就淹了。剥掉注释 = 只看代码, 白名单才能保持最小。
 */
export function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 逐行扫描: 返回 (行号, 文本)。只扫**代码** (块注释 + 行内注释都去掉) */
function lines(text: string): { n: number; s: string }[] {
  return stripBlockComments(text).split(/\r?\n/).map((s, i) => ({ n: i + 1, s }));
}

/** 去掉行内注释与字符串里的假阳性 (只做保守处理: 不改变行号) */
function stripLineComment(s: string): string {
  const i = s.indexOf('//');
  return i >= 0 ? s.slice(0, i) : s;
}

/**
 * 规则 ①: 只有 Supervisor 能决定是否继续。
 * 判据: 调用「下一步该不该跑」那条判定链 (`decideGoalStep` / `decideContinuation`) 的文件
 *      必须在允许清单里 (Supervisor 本体 + continuation 接缝 + 判定模块自身与它的测试)。
 */
export function scanOnlySupervisorDecides(
  files: readonly SourceFile[],
  allowed: readonly string[] = DEFAULT_ALLOW.onlySupervisorDecides,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const f of files) {
    if (allowed.includes(f.path)) continue;
    for (const { n, s } of lines(f.text)) {
      const code = stripLineComment(s);
      if (/\bdecideGoalStep\s*\(/.test(code) || /\bdecideContinuation\s*\(/.test(code)) {
        out.push({
          rule: 'only_supervisor_decides_continuation',
          path: f.path,
          line: n,
          snippet: s.trim().slice(0, 140),
          reason: `${f.path} 调用了继续判定 —— 只有 Supervisor 能决定是否继续 (或经 continuation 接缝)`,
        });
      }
    }
  }
  return out;
}

/**
 * 规则 ②: 只有 Goal reducer 能改 Goal 状态。
 *
 * 判据刻意**按文件**判而不是按行判: 真实绕过长这样 ——
 * ```ts
 * const patch = { goalChanges: changes };
 * patch.status = 'abandoned';        // ← 这一行没有 updateGoal
 * await updateGoal(goalId, patch);   // ← 这一行没有 status
 * ```
 * 按行判会同时漏掉这两行。所以判据 = **同一个文件里同时出现"写 Goal 的调用"与"状态赋值信号"**,
 * 行号只用于报告 (指向那条 `updateGoal`)。允许清单只有两处: Goal 存储本体 (定义 + 完成门 + lease)
 * 与 Goal reducer (唯一漏斗)。
 */
export function scanOnlyGoalReducerWritesState(
  files: readonly SourceFile[],
  allowed: readonly string[] = DEFAULT_ALLOW.onlyGoalReducerWritesState,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  // 只盯**能写 status 的原语** `updateGoal`。刻意不含 setUnresolved / setCriteria / markCriterion ——
  // 那些写的是未解决项与判据 (不是状态), 把它们也算进来只会在无关文件上刷假阳性 (例如
  // task-runner 写判据 + 恰好有个 `status: '已完成'` 的业务字面量), 而门一旦有假阳性就会被
  // 加白名单"解决", 于是真信号也被顺手埋掉。
  const CALL = /\bupdateGoal\s*\(/;
  // `(?!=)` 排除 `x.status === 'done'` 这种**比较** (它不是赋值); `status:` 字面量才是指针。
  //
  // 这道判据**故意偏严**: `.status =` 不区分"这是 Goal 还是 Run 的状态"。代价是某个只写 Run 状态
  // 的文件一旦也开始写 Goal (哪怕是写证据), 就会被要求改道 —— 而"改道到 reducer"正是我们要的结果。
  // 宽松的版本 (只认 goal 前缀的变量名) 会放过 `const p = {...}; p.status = 'failed'` 这种真绕过,
  // 那个代价比"多走一次 reducer"大得多。这条取舍写在这里, 是为了下一个人不必再猜。
  const STATUS_SIGNAL = /\.status\s*=(?!=)|\bstatus\s*:\s*['"]/;
  for (const f of files) {
    if (allowed.includes(f.path)) continue;
    const ls = lines(f.text);
    const callLines = ls.filter(({ s }) => CALL.test(stripLineComment(s)));
    if (callLines.length === 0) continue;
    const statusLines = ls.filter(({ s }) => STATUS_SIGNAL.test(stripLineComment(s)));
    if (statusLines.length === 0) continue;
    out.push({
      rule: 'only_goal_reducer_changes_goal_state',
      path: f.path,
      line: statusLines[0].n,
      snippet: statusLines[0].s.trim().slice(0, 140),
      reason: `${f.path} 同时写了 Goal (${callLines.length} 处调用, 首处 :${callLines[0].n}) 与 Goal 状态 `
        + `(:${statusLines.map((x) => x.n).join(',')}) —— 状态变更必须经 Goal reducer (唯一漏斗)`,
    });
  }
  return out;
}

/**
 * 规则 ③: 只有 closeRun 能关闭 Run。
 * 判据: `closeRun(` 只许出现在收尾模块本体 (定义) 与接线适配层 (它注入真依赖)。
 */
export function scanOnlyCloseRunCloses(
  files: readonly SourceFile[],
  allowed: readonly string[] = DEFAULT_ALLOW.onlyCloseRunCloses,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const f of files) {
    if (allowed.includes(f.path)) continue;
    for (const { n, s } of lines(f.text)) {
      const code = stripLineComment(s);
      if (/(?<![A-Za-z0-9_])closeRun\s*\(/.test(code) || /\bimport\s*\{[^}]*\bcloseRun\b/.test(code)) {
        out.push({
          rule: 'only_close_run_closes_run',
          path: f.path,
          line: n,
          snippet: s.trim().slice(0, 140),
          reason: `${f.path} 触碰了 closeRun —— 关闭 Run 只有一条路 (closeRun, 经接线层的 closeRunOnce)`,
        });
      }
    }
  }
  return out;
}

/**
 * 规则 ④: 所有终止路径必须经过 closeRun。
 *
 * 判据 (与 ③ 不同, 这条管的是"路径有没有被收口"): 名册上每一个**终止路径**
 * (成功 / 失败 / 中断 / 超时 / 人工暂停 / 崩溃恢复 / 权限·支付·工具失败 / 子 Agent 被阻塞)
 * 都必须在同一个文件里出现"经过收尾漏斗"的调用 (`closeRunOnce` / `closeGoalRun`)。
 * 少一条 = 那条路径会绕过唯一责任链。
 */
export interface TerminalPath {
  /** 人类可读的路径名 (成功/失败/中断/…) */
  path: string;
  /** 这条路径在哪里被终结 (相对仓库根) */
  file: string;
  /** 终止动作的源级特征 (必须真的出现在该文件里) */
  marker: RegExp;
  /** 该文件里必须出现的"收口"调用 */
  via: RegExp;
}

/**
 * 收尾漏斗的**唯一入口名字**。
 *
 * 所有终止路径必须在这里出现"经过收尾漏斗"的调用。为了不让"改个名字"变成第三条路,
 * 允许的名字是一个**封闭集合** (本体 + 经审计的薄壳别名), 且别名必须真的调本体
 * (由 `scanFunnelAliases` 每次跑测试时检查 —— 别名不许长成第二个漏斗)。
 */
export const FUNNEL_ENTRY = 'closeRunOnce';
export const FUNNEL_ALIASES = ['closeTaskRun'] as const;
/** 匹配"经过收尾漏斗"的调用 (带词界, 避免 `__removed_closeRunOnce(` 这种假命中) */
export const FUNNEL_CALL_RE = /(?<![A-Za-z0-9_])(?:closeRunOnce|closeGoalRun|closeTaskRun)\s*\(/;

export const TERMINAL_PATHS: readonly TerminalPath[] = [
  {
    path: '成功 (Run 正常完成)',
    file: 'src/agents/execution-supervisor.ts',
    marker: /await\s+runner\s*\(/,
    via: FUNNEL_CALL_RE,
  },
  {
    path: '失败 / 中断恢复 (Runner 内 finishRun)',
    file: 'src/agents/pi-sdk.ts',
    marker: /await\s+finishRun\s*\(/,
    via: FUNNEL_CALL_RE,
  },
  {
    path: '超时 / 预算耗尽 (收尾即放弃)',
    file: 'src/agents/task/task-runner.ts',
    marker: /await\s+finishRun\s*\(/,
    via: FUNNEL_CALL_RE,
  },
  {
    path: '崩溃恢复 (孤儿对账 → interrupted) / 失速 (stalled)',
    file: 'src/agents/run-store.ts',
    marker: /await\s+finishRun\s*\(/,
    via: /(?<![A-Za-z0-9_])onRunTerminal\s*\(/,
  },
  {
    path: '人工暂停 / 中止 (外部控制面)',
    file: 'src/agents/execution-supervisor.ts',
    marker: /runExternallyPaused|applyFlywheelStop/,
    via: FUNNEL_CALL_RE,
  },
  {
    path: '子 Agent 被阻塞 (升级 / 接管)',
    file: 'src/agents/execution-supervisor.ts',
    marker: /applyBlockHandling\s*\(/,
    via: FUNNEL_CALL_RE,
  },
] as const;

/**
 * 别名不许长成第二个漏斗: 每个 `FUNNEL_ALIASES` 里的函数, 函数体里必须真的调 `closeRunOnce(`。
 * (别名存在的唯一理由是"非 Supervisor 宿主也要用同一条链", 不是"给某条路径开个后门"。)
 */
export function scanFunnelAliases(
  files: readonly SourceFile[],
  aliases: readonly string[] = FUNNEL_ALIASES,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const alias of aliases) {
    const owner = files.find((f) => new RegExp(`(?:function|const)\\s+${alias}\\s*[(<=]`).test(f.text));
    if (!owner) {
      out.push({
        rule: 'all_terminal_paths_pass_close_run',
        path: alias,
        line: 0,
        snippet: '',
        reason: `收尾漏斗的别名 ${alias} 在整个扫描面里都找不到定义 —— 登记过时了`,
      });
      continue;
    }
    const at = owner.text.search(new RegExp(`(?:function|const)\\s+${alias}\\s*[(<=]`));
    const body = owner.text.slice(at, at + 2000);
    if (!new RegExp(`(?<![A-Za-z0-9_])${FUNNEL_ENTRY}\\s*\\(`).test(body)) {
      out.push({
        rule: 'all_terminal_paths_pass_close_run',
        path: owner.path,
        line: owner.text.slice(0, at).split('\n').length,
        snippet: body.split('\n')[0].trim().slice(0, 140),
        reason: `${owner.path} 的 ${alias} 没有在函数体里调 ${FUNNEL_ENTRY} —— 别名长成了第二个漏斗 (两条链 = 两套事实)`,
      });
    }
  }
  return out;
}

export function scanTerminalPaths(
  files: readonly SourceFile[],
  paths: readonly TerminalPath[] = TERMINAL_PATHS,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  for (const p of paths) {
    const text = byPath.get(p.file);
    if (text === undefined) {
      out.push({
        rule: 'all_terminal_paths_pass_close_run',
        path: p.file,
        line: 0,
        snippet: '',
        reason: `终止路径「${p.path}」登记在 ${p.file}, 但这个文件不存在或没被扫描到 (门自身不能空转)`,
      });
      continue;
    }
    const ls = lines(text);
    const hit = ls.find(({ s }) => p.marker.test(stripLineComment(s)));
    if (!hit) {
      out.push({
        rule: 'all_terminal_paths_pass_close_run',
        path: p.file,
        line: 0,
        snippet: '',
        reason: `终止路径「${p.path}」的终止动作 (${p.marker}) 在 ${p.file} 里找不到 —— 登记过时了, 门必须跟着改`,
      });
      continue;
    }
    if (!p.via.test(text)) {
      out.push({
        rule: 'all_terminal_paths_pass_close_run',
        path: p.file,
        line: hit.n,
        snippet: hit.s.trim().slice(0, 140),
        reason: `终止路径「${p.path}」在 ${p.file}:${hit.n} 终结, 但该文件没有经过收尾漏斗 (${p.via}) → 这条路径绕过了唯一责任链`,
      });
    }
  }
  return out;
}

/**
 * 规则 ⑤: 子 Agent 不能直接改 Goal。
 * 判据: 子 Agent 侧的任何模块都不许触碰 Goal 状态写入面或 continuation 写入面。
 */
export function scanChildCannotMutateGoal(
  files: readonly SourceFile[],
  allowed: readonly string[] = DEFAULT_ALLOW.childCannotMutateGoal,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  const CHILD_SIDE = /(subagent|child-agent|child_agent|delegate)/i;
  for (const f of files) {
    if (allowed.includes(f.path)) continue;
    if (!CHILD_SIDE.test(f.path)) continue;
    for (const { n, s } of lines(f.text)) {
      const code = stripLineComment(s);
      if (/\bupdateGoal\s*\(/.test(code) || /\bsetContinuation\s*\(/.test(code)) {
        out.push({
          rule: 'child_cannot_mutate_goal',
          path: f.path,
          line: n,
          snippet: s.trim().slice(0, 140),
          reason: `${f.path} 是子 Agent 侧, 却直接写 Goal 状态/continuation → 越界 (CHILD_PROHIBITIONS.mutate_parent_goal_state)`,
        });
      }
    }
  }
  return out;
}

/**
 * 规则 ⑥: Skill 不得绕过**验证 + 快照 + 可回退**通道。
 *
 * 注意措辞: M6 之后会允许**自动**晋升, 所以判据**不是**"不许自动",
 * 而是"不许**绕过通道**": 任何把 Skill 写进正式 skills/ 的动作都必须同时有
 *   ① 验证 (validate/验收) ② 快照 (snapshotScope / contentHash) ③ 可回退 (fromVersion / 变更原因)。
 * 判据 = 出现"写正式 Skill 目录"的模块必须在通道白名单里, 且白名单里的模块必须真的带这三样。
 */
export const SKILL_CHANNEL_EVIDENCE = [
  '/.bolloon/skills/',
] as const;

export function scanSkillChannel(
  files: readonly SourceFile[],
  allowed: readonly string[] = DEFAULT_ALLOW.skillChannel,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const f of files) {
    if (allowed.includes(f.path)) continue;
    for (const { n, s } of lines(f.text)) {
      const code = stripLineComment(s);
      // 写正式 Skill 目录 (skills/<name>/SKILL.md) 的路径形态
      if (/['"`][^'"`]*\.bolloon\/skills\//.test(code) && /\bwriteFile\s*\(|\bwrite\b|\bcopyFile\s*\(/.test(code)) {
        out.push({
          rule: 'skill_cannot_bypass_promotion_channel',
          path: f.path,
          line: n,
          snippet: s.trim().slice(0, 140),
          reason: `${f.path} 直接写正式 Skill 目录 → 必须走 验证+快照+可回退 通道`,
        });
      }
    }
  }
  return out;
}

// ============================================================================
// §4. 允许清单 (每条规则一份; 改这里 = 改冻结面, 必须单独提交并说明为什么)
// ============================================================================

export const DEFAULT_ALLOW = {
  /** 规则 ①: 谁能做"继续/不继续"的判定 */
  onlySupervisorDecides: [
    'src/agents/execution-supervisor.ts',
    'src/agents/goal-flywheel-wiring.ts',
    'src/agents/goal-flywheel/wiring/continuation.ts',
    'src/agents/goal-flywheel/continuation-decision.ts',
    'src/agents/mobile-flywheel-view.ts',
  ],
  /**
   * 规则 ②: 谁能写 Goal 状态。
   *
   * 只有三处 (每一处都有"为什么绕不过去"的理由):
   *   · `goal-store.ts` —— 原语本体 (它定义 `updateGoal`; 门不可能把一个函数挡在它自己外面);
   *   · `goal-state-reducer.ts` —— **唯一漏斗** (intent → plan → apply);
   *   · `goal-flywheel-wiring.ts` —— M0 组合层: 它的职责就是"把飞轮结论落进 Goal", 且**只经 reducer**
   *     (下面 `REDUCER_DELEGATES` 那条断言会检查它真的调了 `reduceGoalState`, 所以这个白名单
   *      不能用来越过漏斗 —— 它是"允许改自己的非状态字段 (goalChanges/证据) 并把状态改道 reducer")。
   * 除此之外任何文件同时出现 updateGoal + 状态信号 = 判红。
   */
  onlyGoalReducerWritesState: [
    'src/agents/goal-store.ts',
    'src/agents/goal-state-reducer.ts',
    'src/agents/goal-flywheel-wiring.ts',
  ],
  /** 规则 ③: 谁能碰 closeRun */
  onlyCloseRunCloses: [
    'src/agents/goal-flywheel/run-closure.ts',
    'src/agents/goal-flywheel-wiring.ts',
    'src/agents/goal-flywheel/wiring/closure.ts',
    // 门的本体: 它里面**写着** `closeRun(` 这个正则字面量 (用来找绕过), 不是真的调用它
    'src/agents/goal-flywheel/wiring/seams.ts',
  ],
  /** 规则 ⑤: 子 Agent 侧 (除此之外的子 Agent 文件不许出现写 Goal 的调用) */
  childCannotMutateGoal: [
    'src/agents/goal-flywheel-wiring.ts',
    'src/agents/goal-flywheel/wiring/contract.ts',
    'src/agents/goal-flywheel/work-contract.ts',
    'src/agents/agent-delegate-server.ts',
  ],
  /** 规则 ⑥: 谁能写正式 Skill 目录 (通道本身) */
  skillChannel: [
    'src/agents/skills-manager.ts',
    'src/agents/skill-writer.ts',
    'src/agents/goal-flywheel-wiring.ts',
    'src/agents/skill-readiness.ts',
  ],
} as const;

// ============================================================================
// §5. 扫描面 (哪些文件进门的视野)
// ============================================================================

/** 门上要扫的源文件 (相对仓库根)。门自己会断言每个路径都真的存在 (不许拿空集糊过去)。 */
export const SCANNED_SOURCES: readonly string[] = [
  'src/agents/execution-supervisor.ts',
  'src/agents/pi-sdk.ts',
  'src/agents/goal-store.ts',
  'src/agents/goal-state-reducer.ts',
  'src/agents/run-store.ts',
  'src/agents/skills-manager.ts',
  'src/agents/skill-readiness.ts',
  'src/agents/subagent-manager.ts',
  'src/agents/goal-criteria.ts',
  'src/agents/external-events.ts',
  'src/agents/contacts/chain.ts',
  'src/agents/task/task-runner.ts',
  'src/agents/goal-flywheel-wiring.ts',
  'src/agents/mobile-flywheel-view.ts',
  'src/web/server.ts',
  ...SEAM_ROSTER.map((s) => `src/agents/goal-flywheel/wiring/${s.module}`),
  'src/agents/goal-flywheel/wiring/seams.ts',
] as const;
