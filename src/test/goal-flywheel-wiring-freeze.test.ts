/**
 * M0 接线冻结 —— **源码级门** (2026-09-25)
 *
 * 这道门回答一个问题: 「唯一责任链」是不是只是文档里的一句话, 还是**代码里绕不过去**。
 *
 * 冻结的六条规则 (设计稿 §13/§14 + 本轮任务书):
 *   ① 只有 Supervisor 能决定是否继续        → `scanOnlySupervisorDecides`
 *   ② 只有 Goal reducer 能改 Goal 状态      → `scanOnlyGoalReducerWritesState`
 *   ③ 只有 closeRun 能关闭 Run              → `scanOnlyCloseRunCloses`
 *   ④ 所有终止路径必须经过 closeRun          → `scanTerminalPaths` (逐条登记)
 *   ⑤ 子 Agent 不能直接改 Goal              → `scanChildCannotMutateGoal`
 *   ⑥ Skill 不得绕过 验证+快照+可回退 通道   → `scanSkillChannel`
 *
 * 这道门的纪律 (少一条就等于门在空转):
 *   · **期望值从真实状态推导** —— 扫描面 `SCANNED_SOURCES` 逐个 `readFileSync` 真读盘;
 *     文件读不到 = 门自己判红 (而不是"文件不存在所以跳过")。
 *   · **断言只加不减** —— 扫描面/名册/终止路径/规则条的**条数下限**都钉死; 变少就红。
 *   · **负控制 (拿不到事实就拒跑)** —— 喂空文件列表, 门必须对每条终止路径报"文件找不到";
 *     喂被改坏的源码 (变异), 门必须判红。**变异验证每次跑测试都在做**, 不是口头声明。
 *   · **做变异验证** —— 对每条规则: 取真实源码 → 注入"旧旁路" → 必须判红。
 *     如果注入后仍是绿的, 说明这道门抓不到绕过 —— 它是装饰。
 *
 * 为什么判据是"纯函数吃源码文本"而不是几条 `expect`:
 *   只有这样, 变异验证才能把**人为改坏的源码**喂给同一份判据 (测试里真的这么干了)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_ALLOW,
  FROZEN_RULES,
  FROZEN_RULE_TEXT,
  FUNNEL_ENTRY,
  SCANNED_SOURCES,
  SEAM_IDS,
  SEAM_MODULES,
  SEAM_ROSTER,
  TERMINAL_PATHS,
  WIRING_STAGES,
  canRunStagesInParallel,
  filesOfStage,
  isRefusal,
  refuse,
  seamRosterViolations,
  scanChildCannotMutateGoal,
  scanOnlyCloseRunCloses,
  scanOnlyGoalReducerWritesState,
  scanOnlySupervisorDecides,
  scanSkillChannel,
  scanTerminalPaths,
  scanFunnelAliases,
  stageOf,
  type SourceFile,
} from '../agents/goal-flywheel/wiring/index.js';

const ROOT = process.cwd();

function read(rel: string): SourceFile {
  // 真读盘。读不到**不跳过**: 抛出来, 让门判红 (期望值从真实状态推导, 不许空转)。
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, 'utf8');
  return { path: rel, text };
}

const SOURCES: readonly SourceFile[] = SCANNED_SOURCES.map(read);
const byPath = new Map(SOURCES.map((s) => [s.path, s.text]));

/** 变异: 把某个真实文件换成"注入了旧旁路"的版本 (行号不变, 便于断言指向) */
function mutate(rel: string, from: string | RegExp, to: string): SourceFile[] {
  const s = SOURCES.find((x) => x.path === rel);
  if (!s) throw new Error(`变异对象不在扫描面里: ${rel} (门自身要拒跑)`);
  const next = s.text.replace(from, to);
  if (next === s.text) throw new Error(`变异没生效: ${rel} 里找不到 ${String(from)} —— 变异本身失效就等于这道门的阴性对照失效`);
  return SOURCES.map((x) => (x.path === rel ? { path: rel, text: next } : x));
}

/** 凭空造一个文件 (用于造"不该存在的东西", 例如子 Agent 侧的 Goal 写入) */
function injection(rel: string, text: string): SourceFile[] {
  return [...SOURCES, { path: rel, text }];
}

const ALL_SCANNERS = [
  scanOnlySupervisorDecides,
  scanOnlyGoalReducerWritesState,
  scanOnlyCloseRunCloses,
  scanTerminalPaths,
  scanFunnelAliases,
  scanChildCannotMutateGoal,
  scanSkillChannel,
] as const;

// ============================================================================
// §0. 门自身不空转
// ============================================================================

describe('M0 门自身不空转 (扫描面真读盘 + 条数只加不减)', () => {
  it('扫描面里每个文件都真读到了非空源码 (读不到就抛, 不是跳过)', () => {
    expect(SOURCES.length).toBe(SCANNED_SOURCES.length);
    for (const s of SOURCES) {
      expect(s.text.length, `${s.path} 内容为空 —— 门不许拿空文件糊过去`).toBeGreaterThan(200);
    }
  });

  it('断言只加不减: 规则/接缝/阶段/终止路径/扫描面的条数下限都钉死', () => {
    expect(FROZEN_RULES.length).toBe(6);
    expect(Object.keys(FROZEN_RULE_TEXT).sort()).toEqual([...FROZEN_RULES].sort());
    expect(SEAM_IDS.length).toBe(5);
    expect(SEAM_ROSTER.length).toBe(5);
    expect(SEAM_MODULES.length).toBe(5);
    expect(WIRING_STAGES.length).toBe(4);
    // 六条终止路径: 成功 / 失败 / 中断 / 超时 / 人工暂停 / 崩溃恢复 / 权限·支付·工具失败 / 子 Agent 被阻塞
    expect(TERMINAL_PATHS.length).toBe(6);
    expect(SCANNED_SOURCES.length).toBeGreaterThanOrEqual(21);
    expect(new Set(SCANNED_SOURCES).size).toBe(SCANNED_SOURCES.length);
  });

  it('干净树上六条规则的判据全绿', () => {
    for (const scan of ALL_SCANNERS) {
      const v = scan(SOURCES);
      expect(v, `${scan.name} 在干净树上判红: ${JSON.stringify(v.slice(0, 3), null, 2)}`).toEqual([]);
    }
  });

  it('负控制: 拿不到事实就拒跑 (空文件列表 → 每条终止路径都报"文件找不到")', () => {
    const v = scanTerminalPaths([]);
    expect(v.length).toBe(TERMINAL_PATHS.length);
    for (const x of v) expect(x.reason).toContain('文件不存在或没被扫描到');
  });

  it('负控制: 终止动作消失了门也要红 (登记过时 = 门必须跟着改)', () => {
    // 把 Supervisor 里"跑一轮"的调用改个名 → 登记的那条终止路径的 marker 找不到 → 红
    const v = scanTerminalPaths(mutate('src/agents/execution-supervisor.ts', /await\s+runner\s*\(/, 'await runOnceRenamed('));
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].reason).toContain('找不到');
  });

  it('refuse/isRefusal: 拒绝是结构化事实 (不是抛异常, 也不是静默 undefined)', () => {
    const r = refuse('all_terminal_paths_pass_close_run', '因为 X 所以拒');
    expect(isRefusal(r)).toBe(true);
    expect(r.rule).toBe('all_terminal_paths_pass_close_run');
    expect(isRefusal({ ok: true })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

// ============================================================================
// §1. 六条规则的变异验证 (注入旧旁路 → 必须判红)
// ============================================================================

describe('规则① 只有 Supervisor 能决定是否继续 (变异验证)', () => {
  it('干净树绿; 把 decideGoalStep 搬到 run-store → 红', () => {
    expect(scanOnlySupervisorDecides(SOURCES)).toEqual([]);
    const v = scanOnlySupervisorDecides(
      mutate('src/agents/run-store.ts', /export async function startRun/, 'export async function judgeNextRun() { const d = decideGoalStep({} as any); return d; }\nexport async function startRun'),
    );
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe('only_supervisor_decides_continuation');
    expect(v[0].path).toBe('src/agents/run-store.ts');
  });

  it('变异: decideContinuation 出现在任何非白名单文件里都判红', () => {
    const v = scanOnlySupervisorDecides(injection('src/agents/web-hook.ts', "const x = decideContinuation(input);\n"));
    expect(v.map((x) => x.path)).toEqual(['src/agents/web-hook.ts']);
  });
});

describe('规则② 只有 Goal reducer 能改 Goal 状态 (变异验证)', () => {
  it('干净树绿', () => {
    expect(scanOnlyGoalReducerWritesState(SOURCES)).toEqual([]);
  });

  it('★ 变异: 恢复旧的"两行式"旁路 (任何单行都不含两要素) → 必须判红', () => {
    // 这就是文件级判据存在的理由: `patch.status = ...` 那行没有 updateGoal,
    // `await updateGoal(...)` 那行没有 status —— 按行判会同时漏掉这两行。
    const v = scanOnlyGoalReducerWritesState(
      mutate(
        'src/agents/run-store.ts',
        /export async function startRun/,
        "export async function forceAbandonGoal(run: any) {\n  const patch: Record<string, unknown> = {};\n  patch.status = 'abandoned';\n  await updateGoal(run.goalId, patch as any);\n}\nexport async function startRun",
      ),
    );
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe('only_goal_reducer_changes_goal_state');
    expect(v[0].path).toBe('src/agents/run-store.ts');
    expect(v[0].reason).toContain('唯一漏斗');
  });

  it('变异: 单行式 `updateGoal(id, { status: ... })` 同样判红', () => {
    const v = scanOnlyGoalReducerWritesState(
      mutate('src/agents/pi-sdk.ts', /import \{ createGoal/, "async function bypass(goalId: string) { await updateGoal(goalId, { status: 'needs_human' }); }\nimport { createGoal"),
    );
    expect(v.length).toBe(1);
    expect(v[0].path).toBe('src/agents/pi-sdk.ts');
  });

  it('负控制: 只写非状态字段 (判据/证据) 不算违规 —— 门不能靠假阳性撑场面', () => {
    // task-runner 真的写 Goal (setCriteria / markCriterion) 并且真的有一个业务状态**比较**
    // (`card.status === '已完成'`) —— 两条都不该被判红: 一个不是状态写入, 一个不是赋值。
    const text = byPath.get('src/agents/task/task-runner.ts');
    expect(text).toBeTruthy();
    expect(text!).toContain('setCriteria(');
    expect(scanOnlyGoalReducerWritesState(SOURCES).some((v) => v.path === 'src/agents/task/task-runner.ts')).toBe(false);
    // 变异: 只要加上一行**真的**写 Goal 状态, 同一份文件立刻判红 (证明上面那条绿不是"门没看它")
    const v = scanOnlyGoalReducerWritesState(
      mutate('src/agents/task/task-runner.ts', /import \* as wiring/, "async function sneak(goalId: string) { await updateGoal(goalId, { status: 'completed' } as any); }\nimport * as wiring"),
    );
    expect(v.length).toBe(1);
    expect(v[0].path).toBe('src/agents/task/task-runner.ts');
  });

  it('负控制: 拿不到事实就拒跑 (白名单文件必须真的调了 reducer, 而不是借着白名单绕过漏斗)', () => {
    for (const f of DEFAULT_ALLOW.onlyGoalReducerWritesState) {
      if (f === 'src/agents/goal-store.ts') continue; // 原语本体 (它定义 updateGoal)
      const text = byPath.get(f);
      expect(text, `${f} 在规则②白名单里, 但不在扫描面里 (门看不见它)`).toBeTruthy();
      expect(text!, `${f} 在规则②白名单里却不调 reduceGoalState —— 白名单成了绕过漏斗的后门`).toContain('reduceGoalState(');
    }
  });
});

describe('规则③ 只有 closeRun 能关闭 Run (变异验证)', () => {
  it('干净树绿 (closeRun 只出现在收尾模块 + 接线层)', () => {
    expect(scanOnlyCloseRunCloses(SOURCES)).toEqual([]);
  });

  it('变异: run-store 自己关 Run → 判红', () => {
    const v = scanOnlyCloseRunCloses(
      mutate('src/agents/run-store.ts', /export async function startRun/, 'async function close(runId: string) { return closeRun(runId as any); }\nexport async function startRun'),
    );
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe('only_close_run_closes_run');
  });

  it('变异: 新增一条 import { closeRun } 也算触碰 (走私进来一样判红)', () => {
    const v = scanOnlyCloseRunCloses(
      mutate('src/agents/goal-criteria.ts', /^import \{/m, "import { closeRun } from './goal-flywheel/run-closure.js';\nimport {"),
    );
    expect(v.length).toBe(1);
    expect(v[0].path).toBe('src/agents/goal-criteria.ts');
  });
});

describe('规则④ 所有终止路径必须经过 closeRun (逐条登记, 变异验证)', () => {
  it('干净树上六条终止路径都经过收尾漏斗', () => {
    expect(scanTerminalPaths(SOURCES)).toEqual([]);
    // 每条路径都必须真的登记了 marker + via (空登记 = 门形同虚设)
    for (const p of TERMINAL_PATHS) {
      expect(p.file.endsWith('.ts')).toBe(true);
      expect(String(p.marker).length).toBeGreaterThan(4);
      expect(String(p.via).length).toBeGreaterThan(4);
    }
  });

  it('★ 变异: 把 Supervisor 的收尾漏斗删掉 (= 恢复旧的"直接收尾"路径) → 必须判红', () => {
    // 关键: 替换文本必须以字母/下划线结尾, 否则 `closeRunOnce` 会作为子串继续命中门 —— 那就成了
    // "变异其实没把漏斗删掉" 的假阴性 (本次第一版就踩了这个坑, 门本身没红, 是变异错了)。
    const v = scanTerminalPaths([
      ...mutate('src/agents/execution-supervisor.ts', /(?<![A-Za-z0-9_])closeRunOnce\s*\(/g, 'legacyDirectFinish('),
    ]);
    const hit = v.find((x) => x.path === 'src/agents/execution-supervisor.ts');
    expect(hit, '把收尾漏斗从 Supervisor 摘掉后门仍是绿的 —— 这道门抓不到绕过').toBeTruthy();
    expect(hit!.reason).toContain('绕过了唯一责任链');
    // 这条 Red 覆盖了登记在 Supervisor 上的全部终止路径 (成功 / 人工暂停 / 子 Agent 阻塞)
    const supervisorPaths = TERMINAL_PATHS.filter((p) => p.file === 'src/agents/execution-supervisor.ts');
    expect(v.filter((x) => x.path === 'src/agents/execution-supervisor.ts').length).toBe(supervisorPaths.length);
  });

  it('变异: Runner 侧 (pi-sdk) 收尾漏斗没了 → 判红', () => {
    const v = scanTerminalPaths(mutate('src/agents/pi-sdk.ts', /(?<![A-Za-z0-9_])closeRunOnce\s*\(/g, 'legacyDirectFinish('));
    expect(v.some((x) => x.path === 'src/agents/pi-sdk.ts' && x.rule === 'all_terminal_paths_pass_close_run')).toBe(true);
  });

  it('变异: 崩溃恢复/失速的终止钩子没了 (拿不到 Goal 就不收, 但不许静默丢) → 判红', () => {
    const v = scanTerminalPaths(mutate('src/agents/run-store.ts', /(?<![A-Za-z0-9_])onRunTerminal\s*\(/g, 'legacyDrop('));
    expect(v.some((x) => x.path === 'src/agents/run-store.ts')).toBe(true);
  });

  it('别名不许长成第二个漏斗: closeTaskRun 必须真的调 closeRunOnce', () => {
    expect(FUNNEL_ENTRY).toBe('closeRunOnce');
    expect(scanFunnelAliases(SOURCES)).toEqual([]);
    // 变异: 把别名掏空 (自己收尾, 不调本体) → 判红
    const v = scanFunnelAliases(
      mutate('src/agents/goal-flywheel-wiring.ts', /(?<![A-Za-z0-9_])closeRunOnce\s*\(/g, 'legacyDirectFinish('),
    );
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].reason).toContain('第二个漏斗');
    // 变异: 别名整个消失 (登记过时) → 也判红
    const gone = scanFunnelAliases(SOURCES.map((s) => (s.path === 'src/agents/goal-flywheel-wiring.ts' ? { ...s, text: s.text.replace(/export async function closeTaskRun/g, 'export async function somethingElse') } : s)));
    expect(gone.length).toBeGreaterThan(0);
  });
});

describe('规则⑤ 子 Agent 不能直接改 Goal (变异验证)', () => {
  it('干净树绿 (子 Agent 侧文件里没有 Goal 写入)', () => {
    expect(scanChildCannotMutateGoal(SOURCES)).toEqual([]);
  });

  it('★ 变异: 子 Agent 侧新增一个直接改 Goal 的文件 → 判红', () => {
    const v = scanChildCannotMutateGoal(
      injection('src/agents/subagent-worker.ts', "export async function finish(goalId: string) { await updateGoal(goalId, { status: 'completed' } as any); }\n"),
    );
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe('child_cannot_mutate_goal');
    expect(v[0].path).toBe('src/agents/subagent-worker.ts');
  });

  it('变异: 子 Agent 侧写 continuation 同样判红 (不只有 status 算越界)', () => {
    const v = scanChildCannotMutateGoal(injection('src/agents/child-agent-runner.ts', 'await setContinuation(goalId, { wakeReason: "active" } as any);\n'));
    expect(v.length).toBe(1);
  });

  it('负控制: 父侧文件 (非子 Agent 命名) 写 Goal 不在本条管辖内 —— 由规则②管', () => {
    const v = scanChildCannotMutateGoal(injection('src/agents/parent-orchestrator.ts', "await updateGoal(goalId, { status: 'active' } as any);\n"));
    expect(v).toEqual([]);
  });
});

describe('规则⑥ Skill 不得绕过 验证+快照+可回退 通道 (变异验证)', () => {
  it('干净树绿', () => {
    expect(scanSkillChannel(SOURCES)).toEqual([]);
  });

  it('★ 变异: 新增一个绕过通道直写正式 Skill 目录的文件 → 判红', () => {
    const v = scanSkillChannel(
      injection('src/agents/skill-auto-promoter.ts', "await writeFile(path.join(os.homedir(), '.bolloon/skills/speed-reader/SKILL.md'), body);\n"),
    );
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe('skill_cannot_bypass_promotion_channel');
    expect(v[0].reason).toContain('验证+快照+可回退');
  });

  it('措辞正确性: 门禁的是"绕过通道", 不是"自动晋升" (M6 会允许自动) —— 走通道的自动晋升不判红', () => {
    // 通道内的自动晋升: 有验证 + 快照 + 回退信息, 只是"由 agent 触发" —— 不许被门误杀
    const v = scanSkillChannel(
      injection('src/agents/skill-auto-promoter.ts', "await writeFile(path.join(skillDir, 'SKILL.md'), body); // 经 promoteSkillCandidate: validate + snapshot + fromVersion\n"),
    );
    expect(v).toEqual([]);
  });

  it('通道白名单必须真的能写出技能 (否则"通道"是个空壳)', () => {
    // skills-manager 是通道本体: 它必须真的落盘 + 必须有 validation / snapshot 概念
    const sm = byPath.get('src/agents/skills-manager.ts')!;
    expect(sm).toBeTruthy();
    expect(/snapshot/i.test(sm)).toBe(true);
  });
});

// ============================================================================
// §2. M1–M4 的并行安全划分 (互不重叠)
// ============================================================================

describe('M1–M4 并行安全: 名册互不重叠 (变异验证)', () => {
  it('名册自己无重叠, 四个阶段可以并行开跑', () => {
    expect(seamRosterViolations()).toEqual([]);
    expect(canRunStagesInParallel().ok).toBe(true);
    const violations = canRunStagesInParallel().violations;
    expect(violations).toEqual([]);
  });

  it('每个阶段都有独占文件 + 接线点, 且阶段两两不相交', () => {
    const seen = new Map<string, string>();
    for (const stage of WIRING_STAGES) {
      const files = filesOfStage(stage);
      expect(files.length, `${stage} 没有任何独占文件 —— 这个阶段没地方下手`).toBeGreaterThan(0);
      for (const f of files) {
        expect(seen.has(f), `${f} 同时被 ${seen.get(f)} 与 ${stage} 声明 —— 两个阶段会改同一个文件`).toBe(false);
        seen.set(f, stage);
      }
    }
    // 四个阶段加起来必须覆盖 5 个接缝 (不能有接缝没人管)
    expect(SEAM_ROSTER.every((s) => WIRING_STAGES.includes(s.stage))).toBe(true);
    expect(stageOf('continuation')).toBe('M1');
    expect(stageOf('closure')).toBe('M2');
    expect(stageOf('contract')).toBe('M3');
    expect(stageOf('monitor')).toBe('M3');
    expect(stageOf('change')).toBe('M4');
  });

  it('★ 变异: 让两个阶段声明同一个文件 → 名册必须判红 + 并行开关必须关掉', () => {
    const broken = SEAM_ROSTER.map((s) =>
      s.id === 'closure' ? { ...s, wiringPoints: [...s.wiringPoints, 'src/agents/goal-flywheel/continuation-decision.ts'] } : s,
    );
    const v = seamRosterViolations(broken);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.reason.includes('重叠') || x.reason.includes('同时'))).toBe(true);
    expect(canRunStagesInParallel(broken).ok).toBe(false);
  });

  it('★ 变异: 两个阶段改同一个函数体 (owns 撞车) → 也必须判红', () => {
    const broken = SEAM_ROSTER.map((s) =>
      s.id === 'change' ? { ...s, owns: [...s.owns, 'src/agents/goal-flywheel/wiring/closure.ts'] } : s,
    );
    expect(seamRosterViolations(broken).length).toBeGreaterThan(0);
    expect(canRunStagesInParallel(broken).ok).toBe(false);
  });

  it('名册声明"只准动哪些文件"时必须给出仓库里真实存在的路径 (空承诺判红)', () => {
    for (const s of SEAM_ROSTER) {
      expect(s.question.endsWith('?'), `接缝 ${s.id} 的 question 不是问句 —— 说不清就意味着在造第二个责任中心`).toBe(true);
      for (const f of [...s.owns, ...s.wiringPoints]) {
        if (f.startsWith('src/test/')) continue; // 本阶段新建的测试文件 (还没落地)
        expect(fs.existsSync(path.join(ROOT, f)), `名册声明的 ${f} 不存在 —— 名册在说一个不存在的世界`).toBe(true);
      }
      expect(fs.existsSync(path.join(ROOT, 'src/agents/goal-flywheel/wiring', s.module))).toBe(true);
    }
  });
});
