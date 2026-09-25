/**
 * 门: 「Goal 长期执行飞轮」P1 **强制收尾飞轮** (`src/agents/goal-flywheel/run-closure.ts`)。
 *
 * 这一层要钉住的是"收尾**真的做了**"这件事本身, 所以断言分五组:
 *   ① 流水线形状: 9 步固定顺序 (§5) · 返回字段**恰好**是 §14 那 9 个 · 重放得到同一批 memoryId
 *   ② Final Review 的采信门 (负控制): 空 / 散文 / 没有评审人 / verdict=one_off → 不产 lesson
 *   ③ 事实分层 (负控制): 声明 confirmed 却拿不出来源 → **降级为推测**, 且推测**不进**用户汇报的证据
 *   ④ Skill 候选门 (负控制): 一次偶然成功 / 依赖 /tmp / 无 IO 契约 / 无失败边界 → 不许送去写盘
 *   ⑤ 收尾收紧 (最强负控制): 决策说 complete 但**没有任何已确认证据** → 不许以"完成"收场
 *   ⑥ 注入与隔离: hardLimits/noProgressStreak 原样透传给 decide; 本文件不读真实钟、不 import fs、
 *      不 import 其它阶段的实现 (只有 types/goal-store/run-store 的类型)
 *
 * 变异验证 (报告里给数字): 拿掉 `tightenDecision` 里的 complete 证据门 → ⑤ 与 ⑥ 的用例判红;
 *   把推测的 `confirmedRefs` 改回携带引用 → ③ 判红。恢复后全绿。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  closeRun,
  parseFinalReview,
  gateClosureCandidate,
  RunClosureError,
  CLOSURE_MAX_FACTS,
  CLOSURE_RESULT_FIELDS,
  CLOSURE_STEP_ORDER,
} from '../agents/goal-flywheel/run-closure.js';
import {
  RUN_CLOSURE_STEPS,
  USER_REPORT_FIELDS,
  MUST_NOT_EXPOSE_FIELDS,
  USER_VISIBLE_STATES,
} from '../agents/goal-flywheel/types.js';
import type {
  ContinuationDecision,
  MemoryRecord,
  SkillImprovementCandidate,
  UserReport,
} from '../agents/goal-flywheel/types.js';
import type { CloseRunDeps, CloseRunInput, CloseRunResult, ClosureDecider } from '../agents/goal-flywheel/run-closure.js';
import type { RunRecord } from '../agents/run-store.js';
import type { GoalRecord } from '../agents/goal-store.js';

// ---------------------------------------------------------------------------
// 夹具 (全部显式构造; 不读真实钟)
// ---------------------------------------------------------------------------

const NOW = '2026-09-25T12:00:00.000Z';

function runFixture(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    goalId: 'goal-1',
    surface: 'cli',
    goal: '把收尾做成固定流水线',
    pid: 4242,
    host: 'test-host',
    startedAt: '2026-09-25T11:00:00.000Z',
    updatedAt: '2026-09-25T11:59:00.000Z',
    status: 'done',
    steps: [
      { n: 1, ts: '2026-09-25T11:01:00.000Z', tool: 'read_file', ok: true, summary: '读了设计稿' },
      { n: 2, ts: '2026-09-25T11:02:00.000Z', tool: 'write_file', ok: false, error: 'EACCES 无写权限' },
    ],
    budget: { maxSteps: 60, deadlineMs: 1_800_000 },
    recovery: [],
    evidence: ['build/x.js#sha256:abc123'],
    ...over,
  };
}

function emptyRun(over: Partial<RunRecord> = {}): RunRecord {
  return runFixture({ steps: [], evidence: [], ...over });
}

const GOOD_SKILL = {
  name: 'closure-fixture',
  purpose: '把 Run 收尾做成固定流水线, 而不是随手一收',
  occurrences: 2,
  boundaryClear: true,
  inputSchema: '{ runId: string }',
  outputSchema: '{ steps: string[] }',
  guarantees: ['每一步都留痕'],
  doesNotGuarantee: ['自动修好失败的步骤'],
  failureCases: ['Run 既无步骤也无证据时只能记 skip'],
  evidenceRefs: ['run-1#step:1'],
};

/** 一份被采信的结构化评审 (可逐字段覆盖) */
function reviewText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reviewedBy: 'leo',
    verdict: 'reusable',
    methodEffective: '先写失败测试再实现',
    methodFailed: '两条线同时写同一个 wiki 页面',
    nextTimeChange: '下次先跑一次全量基线再动代码',
    facts: [{ claim: '构建产物已更新', assertion: 'confirmed', refs: ['build/x.js#sha256:abc123'] }],
    skills: [GOOD_SKILL],
    ...over,
  });
}

function decideStub(over: Partial<ContinuationDecision> = {}): {
  fn: ClosureDecider;
  calls: Parameters<ClosureDecider>[0][];
} {
  const calls: Parameters<ClosureDecider>[0][] = [];
  const fn: ClosureDecider = (i) => {
    calls.push(i);
    return {
      decisionId: 'dec-1',
      goalId: i.goal.goalId,
      runId: i.run.runId,
      decision: 'continue',
      state: 'progressing',
      reason: '本轮有新的可核验证据',
      nextAction: '继续补齐收尾的边界用例',
      expectedOutcome: '收尾门多一条负控制',
      confidence: 0.7,
      progressDelta: i.progress,
      unresolvedItems: [],
      wakeAt: null,
      requiredCapability: null,
      riskLevel: 'low',
      stopReason: null,
      evidenceRefs: [...i.progress.newEvidence],
      decidedAt: i.now,
      ...over,
    };
  };
  return { fn, calls };
}

function depsStub(over: Partial<CloseRunDeps> = {}): {
  deps: CloseRunDeps;
  memoryCalls: MemoryRecord[][];
  candidateCalls: SkillImprovementCandidate[];
} {
  const memoryCalls: MemoryRecord[][] = [];
  const candidateCalls: SkillImprovementCandidate[] = [];
  const deps: CloseRunDeps = {
    writeMemory: async (records) => {
      memoryCalls.push(records);
      return { written: records.map((r) => r.memoryId), rejected: [] };
    },
    writeCandidate: async (c) => {
      candidateCalls.push(c);
      return `skill-file:${c.name}`;
    },
    decide: decideStub().fn,
    ...over,
  };
  return { deps, memoryCalls, candidateCalls };
}

function inputFixture(over: Partial<CloseRunInput> = {}): CloseRunInput {
  return {
    goalId: 'goal-1',
    runId: 'run-1',
    run: runFixture(),
    finalReview: reviewText(),
    now: NOW,
    ...over,
  };
}

const why = (r: CloseRunResult): string[] => r.skipped.map((s) => s.reason);
const has = (r: CloseRunResult, needle: string): boolean => why(r).some((x) => x.includes(needle));

// ---------------------------------------------------------------------------
// ① 流水线形状
// ---------------------------------------------------------------------------

describe('① 收尾流水线的形状 (§5 固定顺序 + §14 冻结返回面)', () => {
  it('成功 / 失败 / 中断恢复后的 Run 都走同一串 9 步, 顺序与冻结清单一致', async () => {
    for (const run of [
      runFixture(),
      runFixture({ status: 'failed', error: 'LLM 超时' }),
      runFixture({
        status: 'interrupted',
        recovery: [{ ts: '2026-09-25T11:30:00.000Z', errorClass: 'timeout', message: '进程被杀', action: 'resume', attempt: 1, recovered: true }],
      }),
    ]) {
      const { deps } = depsStub();
      const res = await closeRun(inputFixture({ run }), deps);
      expect(res.steps).toEqual([...RUN_CLOSURE_STEPS]);
      expect(res.steps).toHaveLength(9);
      expect(res.nextStep.trim().length).toBeGreaterThan(0);
    }
    expect(CLOSURE_STEP_ORDER).toEqual(RUN_CLOSURE_STEPS);
  });

  it('返回字段恰好是 §14 冻结的 9 个 (多一个/少一个都会当场看出)', async () => {
    const { deps } = depsStub();
    const res = await closeRun(inputFixture(), deps);
    expect(Object.keys(res).sort()).toEqual([...CLOSURE_RESULT_FIELDS].sort());
    expect([...CLOSURE_RESULT_FIELDS].sort()).toEqual(
      ['steps', 'facts', 'lessons', 'candidates', 'nextStep', 'decision', 'userReport', 'continuation', 'skipped'].sort(),
    );
  });

  it('空 Run + 空评审: 9 步照样走完, 缺口逐条给出原因 (不静默跳过)', async () => {
    const { deps } = depsStub();
    const res = await closeRun(inputFixture({ run: emptyRun(), finalReview: '   ' }), deps);
    expect(res.steps).toEqual([...RUN_CLOSURE_STEPS]);
    expect(has(res, 'final_review_unstructured: empty_final_review')).toBe(true);
    expect(has(res, 'no_memory_records')).toBe(true);
    expect(has(res, 'no_candidate_extracted')).toBe(true);
    // 四类产物里"事实/教训/候选"为空是**如实**为空, 不是忘了做 —— 缺口都在 skipped 里
    expect(res.facts).toEqual([]);
    expect(res.lessons).toEqual([]);
    expect(res.candidates).toEqual([]);
    expect(res.nextStep.trim().length).toBeGreaterThan(0);
  });

  it('重放同一输入: memoryId 一致, 结果深度相等 (收尾幂等)', async () => {
    const a = await closeRun(inputFixture(), depsStub().deps);
    const b = await closeRun(inputFixture(), depsStub().deps);
    expect(a.facts.map((f) => f.memoryId)).toEqual(b.facts.map((f) => f.memoryId));
    expect(a.candidates.map((c) => c.candidateId)).toEqual(b.candidates.map((c) => c.candidateId));
    expect(b).toEqual(a);
  });

  it('还在跑的 Run: 明确记"没有结束可收尾", 不假装收过尾', async () => {
    const { deps } = depsStub();
    const res = await closeRun(inputFixture({ run: runFixture({ status: 'running' }) }), deps);
    expect(has(res, 'run_still_running')).toBe(true);
    expect(res.skipped.some((s) => s.step === 'run_ended')).toBe(true);
  });

  it('中断恢复后的 Run: 恢复尝试被记成已确认事实 (不是"没发生")', async () => {
    const { deps } = depsStub();
    const run = runFixture({
      status: 'interrupted',
      recovery: [{ ts: '2026-09-25T11:30:00.000Z', errorClass: 'timeout', message: '进程被杀', action: 'resume', attempt: 1, recovered: false }],
    });
    const res = await closeRun(inputFixture({ run }), deps);
    const recoveryFact = res.facts.find((f) => f.memoryId === 'mem:run-1:recovery');
    expect(recoveryFact).toBeDefined();
    expect(recoveryFact!.assertion).toBe('confirmed');
    expect(recoveryFact!.confirmedRefs).toEqual(['run-1#recovery:1']);
    expect(has(res, 'run_still_running')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② Final Review 的采信门 (负控制)
// ---------------------------------------------------------------------------

describe('② Final Review 的采信门', () => {
  it('空评审 / 散文评审 / 没有评审人 → 一律不采信, 且原因分开 (负控制)', () => {
    expect(parseFinalReview('').reason).toBe('empty_final_review');
    expect(parseFinalReview('这次挺顺利的, 下次注意点。').reason).toBe('no_json_found');
    expect(parseFinalReview('[1,2,3]').reason).toBe('not_a_json_object');
    expect(parseFinalReview(JSON.stringify({ verdict: 'reusable' })).reason).toBe('missing_reviewed_by');
    for (const bad of ['', '散文', JSON.stringify({ verdict: 'reusable' })]) {
      expect(parseFinalReview(bad).structured).toBe(false);
    }
  });

  it('评审没有评审人 → 不产 lesson, 但事实/其它产物照旧 (负控制)', async () => {
    const { deps } = depsStub();
    const res = await closeRun(
      inputFixture({ finalReview: reviewText({ reviewedBy: '   ' }) }),
      deps,
    );
    expect(res.lessons).toEqual([]);
    expect(has(res, 'lesson_skipped: review_not_structured: missing_reviewed_by')).toBe(true);
    expect(res.facts.length).toBeGreaterThan(0);
  });

  it('verdict=one_off → 不产 lesson (一次性的做法不许当教训)', async () => {
    const res = await closeRun(inputFixture({ finalReview: reviewText({ verdict: 'one_off' }) }), depsStub().deps);
    expect(res.lessons).toEqual([]);
    expect(has(res, 'lesson_skipped: review_verdict_one_off')).toBe(true);
  });

  it('lesson 三件套缺一件 → 不产 lesson, 原因点名缺了哪个字段', async () => {
    const res = await closeRun(
      inputFixture({ finalReview: reviewText({ methodFailed: '  ' }) }),
      depsStub().deps,
    );
    expect(res.lessons).toEqual([]);
    expect(has(res, 'lesson_skipped: lesson_fields_missing: methodFailed')).toBe(true);
  });

  it('被采信的结构化评审 → 产 lesson 且写进 Memory (正例, 与上面几条对照)', async () => {
    const { deps, memoryCalls } = depsStub();
    const res = await closeRun(inputFixture(), deps);
    expect(res.lessons).toHaveLength(1);
    const lesson = res.lessons[0];
    expect(lesson.layer).toBe('lesson');
    expect(lesson.reviewVerdict).toBe('reusable');
    expect(lesson.reviewedBy).toBe('leo');
    expect(lesson.methodFailed).toContain('wiki');
    expect(memoryCalls).toHaveLength(1);
    expect(memoryCalls[0].some((r) => r.memoryId === lesson.memoryId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ③ 事实分层: 推测永不当证据 (负控制)
// ---------------------------------------------------------------------------

describe('③ 事实分层: 已确认 vs 推测', () => {
  it('成功与失败步骤都记为已确认事实 (失败也是事实)', async () => {
    const res = await closeRun(inputFixture(), depsStub().deps);
    const ok = res.facts.find((f) => f.memoryId === 'mem:run-1:step:1')!;
    const bad = res.facts.find((f) => f.memoryId === 'mem:run-1:step:2')!;
    expect(ok.assertion).toBe('confirmed');
    expect(ok.confirmedRefs).toEqual(['run-1#step:1']);
    expect(bad.assertion).toBe('confirmed');
    expect(bad.content).toContain('失败');
    expect(bad.content).toContain('EACCES');
    // ① 失败步的事实也允许进汇报的"阻塞原因", 但只在 blockReasons, 不在"已完成"
    const res2 = await closeRun(inputFixture(), depsStub().deps);
    expect(res2.userReport.blockReasons.some((b) => b.includes('EACCES'))).toBe(true);
    expect(res.userReport.completed.some((c) => c.includes('EACCES'))).toBe(false);
  });

  it('评审声明 confirmed 却拿不出来源 → 降级为推测, 且不带任何证据引用 (负控制)', async () => {
    const { deps } = depsStub();
    const res = await closeRun(
      inputFixture({
        run: emptyRun(),
        finalReview: reviewText({
          skills: [],
          facts: [
            { claim: '用户应该会喜欢这个方案', assertion: 'confirmed', refs: [] },
            { claim: '我猜是缓存的问题', assertion: 'inferred', refs: ['guess#1'] },
          ],
        }),
      }),
      deps,
    );
    const fact = res.facts.find((f) => f.memoryId === 'mem:run-1:review-fact:0')!;
    expect(fact.assertion).toBe('inferred');
    expect(fact.confirmedRefs).toEqual([]);
    expect(fact.evidenceRefs).toEqual([]);
    expect(fact.content).toContain('降级为推测');
    // 自己承认是推测、却顺手带了来源的, 同样不许把这些来源挂成"已确认引用"
    const guess = res.facts.find((f) => f.memoryId === 'mem:run-1:review-fact:1')!;
    expect(guess.assertion).toBe('inferred');
    expect(guess.confirmedRefs).toEqual([]);
    expect(guess.evidenceRefs).toEqual([]);
    // 推测一个引用都不许进用户汇报的证据
    expect(res.userReport.evidence).toEqual([]);
  });

  it('推测不比已确认的事实多进一分证据 (评审同时给两类, 汇报只留已确认的)', async () => {
    const { deps } = depsStub();
    const res = await closeRun(
      inputFixture({
        run: emptyRun(),
        finalReview: reviewText({
          skills: [],
          facts: [
            { claim: '构建产物哈希是 abc', assertion: 'confirmed', refs: ['build/x.js#sha256:abc123'] },
            { claim: '大概是缓存问题', assertion: 'inferred', refs: ['guess#1'] },
          ],
        }),
      }),
      deps,
    );
    expect(res.userReport.evidence).toEqual(['build/x.js#sha256:abc123']);
    expect(res.userReport.evidence).not.toContain('guess#1');
  });

  it('事实条数封顶: 超出的丢弃并记原因 (上限不是暗默认)', async () => {
    const steps = Array.from({ length: CLOSURE_MAX_FACTS + 10 }, (_, i) => ({
      n: i + 1,
      ts: '2026-09-25T11:00:00.000Z',
      tool: 'noop',
      ok: true,
      summary: `第 ${i + 1} 步`,
    }));
    const res = await closeRun(
      inputFixture({ run: runFixture({ steps, evidence: [] }), finalReview: '' }),
      depsStub().deps,
    );
    expect(res.facts).toHaveLength(CLOSURE_MAX_FACTS);
    expect(has(res, 'facts_capped: 保留前 50 条, 丢弃 10 条')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ Skill 候选门 (负控制)
// ---------------------------------------------------------------------------

describe('④ Skill 候选门: 防 Skill 垃圾', () => {
  it('一次偶然成功 (occurrences=1) → 候选被判垃圾, 且**不送去写盘** (负控制)', async () => {
    const { deps, candidateCalls, memoryCalls } = depsStub();
    const res = await closeRun(
      inputFixture({ finalReview: reviewText({ skills: [{ ...GOOD_SKILL, occurrences: 1 }] }) }),
      deps,
    );
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].status).toBe('rejected');
    expect(res.candidates[0].junkReasons).toContain('single_success');
    expect(candidateCalls).toHaveLength(0); // ← 关键: 没资格写盘的候选到不了写盘口
    expect(has(res, 'no_promotable_candidate')).toBe(true);
    // 但信号还是要进 Memory (供人复核), 且类型级不许直接转正
    const signal = memoryCalls[0].find((r) => r.layer === 'skill_signal');
    expect(signal).toBeDefined();
    expect((signal as { promotesDirectly: boolean }).promotesDirectly).toBe(false);
  });

  it('依赖临时路径 / 无 IO 契约 / 无失败边界 / 只是一句经验 → 各自命中对应垃圾理由', () => {
    expect(gateClosureCandidate({ ...GOOD_SKILL, evidenceRefs: ['/tmp/run-1/out.txt'] }).junk).toContain('temp_path_dependency');
    expect(gateClosureCandidate({ ...GOOD_SKILL, inputSchema: '', outputSchema: '' }).junk).toContain('no_io_schema');
    expect(gateClosureCandidate({ ...GOOD_SKILL, failureCases: [] }).junk).toContain('no_failure_boundary');
    expect(gateClosureCandidate({ ...GOOD_SKILL, boundaryClear: false }).junk).toContain('no_failure_boundary');
    expect(gateClosureCandidate({ ...GOOD_SKILL, purpose: '很好用' }).junk).toContain('one_line_experience');
    expect(gateClosureCandidate({ ...GOOD_SKILL, guarantees: [], doesNotGuarantee: [] }).junk).toContain('no_failure_boundary');
    // 合格的那条必须一条垃圾理由都不命中 (门不是"什么都拦")
    expect(gateClosureCandidate(GOOD_SKILL).junk).toEqual([]);
    // 候选永远不带批准
    expect(gateClosureCandidate(GOOD_SKILL).candidate.approval.state).toBe('not_requested');
  });

  it('合格候选 → 写盘一次; 写盘口返回 null → 明确记为"没写成"', async () => {
    const { deps, candidateCalls } = depsStub();
    const ok = await closeRun(inputFixture(), deps);
    expect(candidateCalls).toHaveLength(1);
    expect(ok.candidates[0].status).toBe('draft');
    expect(has(ok, 'candidate_not_written')).toBe(false);

    const { deps: deps2 } = depsStub({ writeCandidate: async () => null });
    const nulled = await closeRun(inputFixture(), deps2);
    expect(has(nulled, 'candidate_not_written: cand:run-1:0:closure-fixture')).toBe(true);
  });

  it('写候选抛错 → 记原因, 收尾照旧走完 (收尾不能中途断掉)', async () => {
    const { deps } = depsStub({
      writeCandidate: async () => {
        throw new Error('磁盘满');
      },
    });
    const res = await closeRun(inputFixture(), deps);
    expect(has(res, 'write_candidate_failed: cand:run-1:0:closure-fixture: 磁盘满')).toBe(true);
    expect(res.steps).toEqual([...RUN_CLOSURE_STEPS]);
    expect(res.userReport.nextStep.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 收尾收紧: 没有证据不许以"完成"收场 (最强负控制)
// ---------------------------------------------------------------------------

describe('⑤ 收尾收紧: complete 必须有已确认证据, 且未解决项为空', () => {
  it('决策 complete 但本轮没有任何已确认证据 → 不许收成完成 (负控制)', async () => {
    const { deps } = depsStub({ decide: decideStub({ decision: 'complete', state: 'completed' }).fn });
    const res = await closeRun(
      inputFixture({
        run: emptyRun(),
        finalReview: reviewText({ skills: [], facts: [{ claim: '我觉得已经做完了', assertion: 'inferred', refs: [] }] }),
      }),
      deps,
    );
    expect(res.decision.decision).not.toBe('complete');
    expect(res.decision.decision).toBe('ask_human');
    expect(res.decision.state).toBe('needs_decision');
    expect(res.decision.stopReason).toBeNull();
    expect(has(res, 'complete_without_confirmed_evidence')).toBe(true);
    expect(res.userReport.willContinue).toBe(true);
    expect(res.userReport.visibleState).toBe('needs_your_decision');
    expect(res.userReport.conclusion).toContain('收尾收紧');
    expect(res.continuation.state).toBe('needs_human');
    expect(res.continuation.autoContinue).toBe(false);
  });

  it('决策 complete 且有已确认证据 → 保持完成 (正例, 与上一条对照)', async () => {
    const { deps } = depsStub({ decide: decideStub({ decision: 'complete', state: 'completed' }).fn });
    const res = await closeRun(inputFixture(), deps); // run 有步骤 + 有 run 级证据
    expect(res.decision.decision).toBe('complete');
    expect(has(res, 'complete_without_confirmed_evidence')).toBe(false);
    expect(res.userReport.willContinue).toBe(false);
    expect(res.userReport.evidence.length).toBeGreaterThan(0);
    expect(res.continuation.state).toBe('completed');
    expect(res.continuation.autoContinue).toBe(false);
    expect(res.userReport.conclusion).toContain('判据已满足');
  });

  it('决策 complete 但还有未解决项 → 同样不许收成完成 (负控制)', async () => {
    const { deps } = depsStub({
      decide: decideStub({ decision: 'complete', state: 'completed', unresolvedItems: ['第三步的验收还没跑'] }).fn,
    });
    const res = await closeRun(inputFixture(), deps);
    expect(res.decision.decision).toBe('ask_human');
    expect(has(res, 'complete_with_unresolved_items: 1')).toBe(true);
    expect(res.userReport.remaining).toEqual(['第三步的验收还没跑']);
  });

  it('判 fail 不给停止理由 / 非终态却带 stopReason → 记结构化原因 (不替 P0 改判)', async () => {
    const { deps } = depsStub({ decide: decideStub({ decision: 'fail', state: 'failed', stopReason: null }).fn });
    const res = await closeRun(inputFixture(), deps);
    expect(has(res, 'fail_without_stop_reason')).toBe(true);

    const { deps: deps2 } = depsStub({
      decide: decideStub({ decision: 'continue', state: 'progressing', stopReason: 'no_value_continuing' }).fn,
    });
    const res2 = await closeRun(inputFixture(), deps2);
    expect(has(res2, 'stop_reason_outside_terminal: decision=continue')).toBe(true);
    expect(res2.decision.decision).toBe('continue'); // 不改判, 只记
  });

  it('decision 与 state 不自洽 → 记原因; 空 nextAction → 兜底且说明 (Goal 不许悬空)', async () => {
    const { deps } = depsStub({ decide: decideStub({ decision: 'continue', state: 'no_progress' }).fn });
    const res = await closeRun(inputFixture(), deps);
    expect(has(res, 'decision_state_mismatch: decision=continue state=no_progress')).toBe(true);

    const { deps: deps2 } = depsStub({ decide: decideStub({ nextAction: '   ' }).fn });
    const res2 = await closeRun(inputFixture(), deps2);
    expect(has(res2, 'next_action_empty')).toBe(true);
    expect(res2.nextStep.trim().length).toBeGreaterThan(0);

    // 终态空 nextAction → 也不许是空串
    const { deps: deps3 } = depsStub({
      decide: decideStub({ decision: 'fail', state: 'failed', stopReason: 'objective_unreachable', nextAction: '' }).fn,
    });
    const res3 = await closeRun(inputFixture(), deps3);
    expect(res3.nextStep).toContain('终态');
  });
});

// ---------------------------------------------------------------------------
// ⑥ 两份输出: 用户汇报 + 机器继续记录
// ---------------------------------------------------------------------------

describe('⑥ 两份输出 (用户汇报 / 机器继续记录)', () => {
  it('用户汇报的键集恰好是允许暴露的字段 (+ 汇报自身的元数据), 内部字段一个都不出现', async () => {
    const res = await closeRun(inputFixture(), depsStub().deps);
    const keys = Object.keys(res.userReport);
    // 冻结面: 9 个内容字段 + 暴露面/生成时间两个元数据字段 —— 多一个都不行
    expect(keys.sort()).toEqual([...USER_REPORT_FIELDS, 'exposedFields', 'generatedAt'].sort());
    const exposed: (keyof UserReport)[] = res.userReport.exposedFields;
    for (const f of exposed) expect(USER_REPORT_FIELDS as readonly string[]).toContain(f);
    for (const forbidden of MUST_NOT_EXPOSE_FIELDS) expect(keys).not.toContain(forbidden);
    // 文本里也不许出现内部词 (只给用户结论与下一步)
    const blob = JSON.stringify(res.userReport);
    for (const forbidden of ['lease', 'reducer', 'retry_counter', 'worker_owner']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('三处 nextStep 一致且非空 (Goal 不允许"没有下一步"的悬空态)', async () => {
    for (const over of [{}, { decision: 'wait' as const, state: 'waiting_external' as const }]) {
      const { deps } = depsStub({ decide: decideStub(over).fn });
      const res = await closeRun(inputFixture(), deps);
      expect(res.nextStep).toBe(res.continuation.nextAction);
      expect(res.nextStep).toBe(res.userReport.nextStep);
      expect(res.continuation.nextAction.trim().length).toBeGreaterThan(0);
      expect(res.continuation.updatedAt).toBe(NOW);
      expect(res.continuation.lastDecisionId).toBe(res.decision.decisionId);
    }
  });

  it('等外部: 状态/唤醒时间/自动继续三处一致', async () => {
    const { deps } = depsStub({
      decide: decideStub({ decision: 'wait', state: 'waiting_external', wakeAt: '2026-09-25T13:00:00.000Z' }).fn,
    });
    const res = await closeRun(inputFixture(), deps);
    expect(res.continuation.state).toBe('awaiting_external');
    expect(res.continuation.wakeAt).toBe('2026-09-25T13:00:00.000Z');
    expect(res.continuation.autoContinue).toBe(true);
    expect(res.userReport.expectedResumeAt).toBe('2026-09-25T13:00:00.000Z');
    expect(res.userReport.visibleState).toBe('waiting_external_reply');
  });

  it('要人决定: 不许自动继续', async () => {
    const { deps } = depsStub({ decide: decideStub({ decision: 'ask_human', state: 'needs_decision' }).fn });
    const res = await closeRun(inputFixture(), deps);
    expect(res.continuation.state).toBe('needs_human');
    expect(res.continuation.autoContinue).toBe(false);
    expect(res.userReport.visibleState).toBe('needs_your_decision');
    expect(res.userReport.willContinue).toBe(true); // 会继续, 但得等人
  });

  it('delegate: requiredAgent 跟着能力走; 没给能力就明确记原因 (不静默发空合同)', async () => {
    const { deps } = depsStub({
      decide: decideStub({ decision: 'delegate', state: 'waiting_agent', requiredCapability: 'web-scraping' }).fn,
    });
    const res = await closeRun(inputFixture(), deps);
    expect(res.continuation.requiredAgent).toBe('web-scraping');
    expect(res.continuation.state).toBe('active');
    expect(has(res, 'delegate_without_capability')).toBe(false);

    const { deps: deps2 } = depsStub({
      decide: decideStub({ decision: 'delegate', state: 'waiting_agent', requiredCapability: null }).fn,
    });
    const res2 = await closeRun(inputFixture(), deps2);
    expect(has(res2, 'delegate_without_capability')).toBe(true);
  });

  it('五类用户可见态以外的内部取值不许透出; 终态无对应取值这一保留项也钉住', async () => {
    for (const d of ['continue', 'wait', 'delegate', 'ask_human', 'complete', 'fail', 'pause'] as const) {
      const state =
        d === 'wait'
          ? ('waiting_external' as const)
          : d === 'delegate'
            ? ('waiting_agent' as const)
            : d === 'complete'
              ? ('completed' as const)
              : d === 'fail'
                ? ('failed' as const)
                : d === 'pause'
                  ? ('needs_decision' as const)
                  : d === 'ask_human'
                    ? ('needs_decision' as const)
                    : ('progressing' as const);
      const { deps } = depsStub({ decide: decideStub({ decision: d, state, requiredCapability: d === 'delegate' ? 'x' : null }).fn });
      const res = await closeRun(inputFixture(), deps);
      expect(USER_VISIBLE_STATES as readonly string[]).toContain(res.userReport.visibleState);
    }
    // 保留项: 冻结的五类里没有终态 → 终态汇报沿用 'executing' (加第 6 类需改冻结层, 那要单独一个提交)
    expect(USER_VISIBLE_STATES as readonly string[]).not.toContain('completed');
  });
});

// ---------------------------------------------------------------------------
// ⑦ 依赖注入 / 依赖失效
// ---------------------------------------------------------------------------

describe('⑦ 依赖全部参数注入, 失效时如实留痕', () => {
  it('注入的 goal / hardLimits / noProgressStreak 原样交给 decide (不偷偷造)', async () => {
    const decide = decideStub();
    const { deps } = depsStub({ decide: decide.fn });
    const goal: GoalRecord = {
      goalId: 'goal-1',
      objective: '把收尾做成固定流水线',
      successCriteria: ['9 步都走', '推测不当证据'],
      constraints: [],
      status: 'active',
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T11:00:00.000Z',
      runs: ['run-1'],
      completedCriteria: [0],
      unresolvedItems: [],
      evidence: ['build/x.js#sha256:abc123'],
    };
    const hardLimits = { maxRunDurationMs: 60_000, maxGoalBudget: 5, noProgressCircuitBreaker: 2 };
    await closeRun(inputFixture({ goal, hardLimits, noProgressStreak: 4 }), deps);
    expect(decide.calls).toHaveLength(1);
    expect(decide.calls[0].goal).toBe(goal);
    expect(decide.calls[0].hardLimits).toBe(hardLimits);
    expect(decide.calls[0].noProgressStreak).toBe(4);
    expect(decide.calls[0].now).toBe(NOW);
    expect(decide.calls[0].progress.stepsAdvanced).toBe(1); // 只有第 1 步成功
    expect(decide.calls[0].progress.newEvidence).toEqual(['build/x.js#sha256:abc123']);
  });

  it('没注入底线/计数时用写明的退化值: 无进展按 1 起步, 空判据不可能判完成', async () => {
    const decide = decideStub();
    const { deps } = depsStub({ decide: decide.fn });
    await closeRun(inputFixture({ run: emptyRun(), finalReview: '' }), deps);
    expect(decide.calls[0].noProgressStreak).toBe(1);
    expect(decide.calls[0].goal.successCriteria).toEqual([]); // 空判据 → 按冻结语义不许自动判完成
    expect(decide.calls[0].hardLimits.noProgressCircuitBreaker).toBeGreaterThan(0);
    expect(decide.calls[0].hardLimits.maxRunDurationMs).toBe(1_800_000);
  });

  it('writeMemory 抛错 → 后面几步照走, 原因写清楚', async () => {
    const { deps } = depsStub({
      writeMemory: async () => {
        throw new Error('磁盘只读');
      },
    });
    const res = await closeRun(inputFixture(), deps);
    expect(has(res, 'write_memory_failed: 磁盘只读')).toBe(true);
    expect(res.steps).toEqual([...RUN_CLOSURE_STEPS]);
    expect(res.userReport.nextStep.trim().length).toBeGreaterThan(0);
    expect(res.continuation.lastDecisionId).toBe('dec-1');
  });

  it('writeMemory 拒绝若干条 / 报告数与交付数不符 → 逐条记原因', async () => {
    const { deps } = depsStub({
      writeMemory: async (records) => ({
        written: records.slice(1).map((r) => r.memoryId),
        rejected: [{ memoryId: records[0].memoryId, reason: '与已有事实重复' }],
      }),
    });
    const res = await closeRun(inputFixture(), deps);
    expect(has(res, 'memory_rejected: mem:run-1:step:1: 与已有事实重复')).toBe(true);
    expect(has(res, 'memory_written_count_mismatch')).toBe(false);

    const { deps: deps2 } = depsStub({ writeMemory: async () => ({ written: ['only-one'], rejected: [] }) });
    const res2 = await closeRun(inputFixture(), deps2);
    expect(has(res2, 'memory_written_count_mismatch')).toBe(true);
  });

  it('decide 抛错 → 显式失败 (不编一个决策出来), 错误带步骤名', async () => {
    const { deps } = depsStub({
      decide: () => {
        throw new Error('P0 决策器炸了');
      },
    });
    await expect(closeRun(inputFixture(), deps)).rejects.toBeInstanceOf(RunClosureError);
    await closeRun(inputFixture(), deps).catch((e: unknown) => {
      expect((e as RunClosureError).step).toBe('continuation_decision');
      expect((e as RunClosureError).message).toContain('P0 决策器炸了');
    });
  });
});

// ---------------------------------------------------------------------------
// ⑧ 阶段隔离 / 纯粹性 (源级门: 不靠人肉记忆)
// ---------------------------------------------------------------------------

describe('⑧ 阶段隔离与纯粹性', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/goal-flywheel/run-closure.ts'), 'utf8');

  it('不读真实钟、不做 I/O (时间一律 now 注入)', () => {
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/from 'node:fs'/);
    expect(src).not.toMatch(/from 'fs'/);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('只 import 冻结面与既有 store 的类型 (不 import 其它阶段的实现)', () => {
    const specs = [...src.matchAll(/^import (?:type )?[^;]*from '([^']+)';$/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(['./types.js', '../goal-store.js', '../run-store.js']).toContain(s);
    }
    // 别的阶段实现文件的名字一个都不许出现 (名字出现在注释里也要能自查)
    for (const other of ['continuation-decision', 'memory-layers', 'skill-candidate', 'work-contract', 'work-monitor', 'goal-change']) {
      expect(specs.some((s) => s.includes(other))).toBe(false);
    }
  });

  it('冻结面没被本线动过: types.ts 仍是纯类型, index.ts 仍只转发', () => {
    const typesSrc = fs.readFileSync(path.join(process.cwd(), 'src/agents/goal-flywheel/types.ts'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(process.cwd(), 'src/agents/goal-flywheel/index.ts'), 'utf8');
    expect(typesSrc).not.toMatch(/^import /m);
    expect(typesSrc).not.toMatch(/^export function /m);
    expect(indexSrc).toMatch(/export \* from '\.\/types\.js';/);
    expect(indexSrc).not.toMatch(/\bfunction\b/);
  });
});
