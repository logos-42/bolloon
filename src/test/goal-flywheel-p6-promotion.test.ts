/**
 * goal-flywheel P6 · ② 候选转正的**后半程** (真 run → 收尾候选 → 评估 → 晋升记录 → 只影响下一次 Run)
 * — 2026-09-26
 *
 * 归属: `docs/wiki/goal-flywheel-p5-acceptance.md` §5「收尾候选转正的完整链路」那条未验证项 + §6 第 2 条。
 * 被验对象: `run-closure.closeRun`(真落盘) → `skill-candidate.assessCandidate` → `draftPromotion`
 * → `skills-manager.snapshot` (真盘上的 Skill 版本解析) —— 不 stub 被验对象。
 *
 * 整链一次跑通 (每个断言都指向真盘上的产物):
 *   ① 真 Run 收尾 → 候选**真落** `~/.bolloon/skill-candidates/`, 带真 `contentHash` (P5 修的缺口 5);
 *   ② `assessCandidate` 对**同一份**候选不判垃圾 → `promotable === true` (门不是永远拒绝);
 *   ③ `draftPromotion` 产出的晋升记录带 `approval.state='approved'` + 同一 `contentHash` + 版本推进;
 *   ④ `snapshotScope === 'next_run_only'`: **正在执行的 Goal 记录的版本逐字节不变**, 盘上正在跑的那份
 *      `SKILL.md` 一个字节都没动 —— 而新版本落盘后**下一次 Run 的**版本解析 (`snapshot`) 立刻变;
 *   ⑤ 全链**没有任何一步自动批准**: 收尾产出的候选 `approval.state='not_requested'`,
 *      `skills/` 目录里从头到尾没有多出任何文件 (正式写入是 `skills-manager` 的职责, 本链只到草案)。
 *
 * 强负例 (必须**不**转正):
 *   - 真 run + 只有一次偶然成功的评审 (`occurrences: 1`) → 收尾判 `rejected` + 盘上不留候选 +
 *     `draftPromotion` 抛"不得晋升"; 对照: 同一形状把 `occurrences` 提到 3 → 才 `draft` + 真落盘;
 *   - **防御性重算**: 把好候选的 `occurrences` 改回 1 且**手工把 `junkReasons` 清空**
 *     (模拟调用方"自觉") → `assessCandidate` 仍判 `single_success`, `draftPromotion` 仍抛。
 *
 * 变异验证 (改坏主不变量 → 必红 → 恢复, 哈希前后一致): 见本文件所在提交的说明;
 * 本文件至少钉住两处: `single_success` 判据 (改坏 → 「偶然成功不得转正」用例红)、
 * `snapshotScope` (改坏 → 「只影响下一次 Run」用例红)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import type { SkillImprovementCandidate } from '../agents/goal-flywheel/types.js';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `p6-promo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  delete process.env.BOLLOON_RUN_FINAL_REVIEW;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

function iso(ms: number): string { return new Date(ms).toISOString(); }

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    wiring: await import('../agents/goal-flywheel-wiring.js'),
    candidate: await import('../agents/goal-flywheel/skill-candidate.js'),
    skills: await import('../agents/skills-manager.js'),
    fly: await import('../agents/goal-flywheel/index.js'),
  };
}

async function listDir(p: string): Promise<string[]> {
  try { return (await fs.readdir(p)).sort(); } catch { return []; }
}

async function sha256File(p: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
}

/** 结构化评审 (可拆解成候选): occurrences 可调 —— 1 就是"只有一次偶然成功" */
function review(name: string, occurrences: number): string {
  return JSON.stringify({
    reviewedBy: 'p6-verifier',
    verdict: 'reusable',
    methodEffective: '先把判据逐条映射成证据清单再执行',
    methodFailed: '一开始直接开跑, 收尾才发现缺证据',
    nextTimeChange: '开跑前先写证据清单',
    facts: [{ claim: 'evidence-0.txt 已产出', assertion: 'confirmed', refs: ['evidence-0.txt'] }],
    skills: [{
      name,
      purpose: '把每一条成功判据逐条映射到可核验证据的固定流程 (先列证据清单, 再执行, 最后逐条回填)',
      occurrences,
      boundaryClear: true,
      inputSchema: '{ criteria: string[] }',
      outputSchema: '{ evidenceRefs: string[] }',
      guarantees: ['每条判据都有证据引用'],
      doesNotGuarantee: ['不保证证据本身真实 (只保证逐条对应)'],
      failureCases: ['判据不可核验时应当停下并报阻塞, 不许硬凑证据'],
      evidenceRefs: ['evidence-0.txt'],
    }],
  });
}

/** 真跑一个 Run 并收尾 (成功路径) —— 返回收尾结果 */
async function realRunAndClose(m: Awaited<ReturnType<typeof mods>>, o: {
  home: string; name: string; occurrences: number; now: number;
}) {
  const g = await m.gs.createGoal({ objective: `产出可复用流程 (${o.name})`, successCriteria: ['判据0'], createdBy: 'p6' });
  const rec = await m.rs.startRun({ surface: 'cli', channelId: 'ch-p6', goalId: g.goalId, goal: g.objective });
  await m.rs.recordStep(rec.runId, { tool: 'shell_exec', ok: true, summary: '产出 evidence-0.txt' });
  await m.rs.addRunEvidence(rec.runId, ['evidence-0.txt (sha256 前缀可核验)']);
  await m.rs.finishRun(rec.runId, { status: 'done' });
  await m.gs.attachRun(g.goalId, rec.runId);
  await m.gs.markCriterion(g.goalId, 0, true);
  const out = await m.wiring.closeGoalRun({
    goalId: g.goalId, runId: rec.runId, now: iso(o.now), maxRetries: 2, home: o.home,
    finalReview: review(o.name, o.occurrences),
  });
  return { goalId: g.goalId, runId: rec.runId, out: out! };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-② 候选转正后半程 (真 run → 评估 → 晋升记录 → 只影响下一次 Run)', () => {
  it('(1) 真链: 收尾候选真落盘 → 不判垃圾 → 晋升记录带 approval/contentHash/版本 + next_run_only', async () => {
    const m = await mods();
    const home = TMP;
    const NAME = 'p6-promoted-skill';
    const T0 = Date.now();

    // 0. 盘上先有一份**正在执行**的 Skill (v1.0.0) —— 晋升必须不覆盖它
    const skillDir = path.join(home, '.bolloon', 'skills', NAME);
    await fs.mkdir(skillDir, { recursive: true });
    const v1 = [
      '---',
      `name: ${NAME}`,
      'description: 把判据映射到证据的固定流程 (运行中的版本)',
      'version: 1.0.0',
      '---',
      '',
      '运行中版本正文。',
      '',
    ].join('\n');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), v1, 'utf8');
    const v1Hash = await sha256File(path.join(skillDir, 'SKILL.md'));
    const sm = m.skills.getSkillsManager({ home });
    const before = await sm.snapshot([NAME], { home });
    expect(before.ok).toBe(true);
    expect(before.entries[0].version).toBe('1.0.0');
    expect(before.entries[0].contentHash.length).toBeGreaterThan(0);

    // 1. 真 run + 真收尾 → 候选真落盘 (带真 contentHash)
    const { goalId, runId, out } = await realRunAndClose(m, { home, name: NAME, occurrences: 3, now: T0 });
    expect(out.result.candidates.length).toBe(1);
    const cand = out.result.candidates[0];
    expect(cand.status).toBe('draft');
    expect(cand.contentHash).toBeTruthy();
    expect(cand.sourceRunIds).toEqual([runId]);                       // 真 runId, 不是编的
    expect(cand.approval.state).toBe('not_requested');                 // 自动路径**没有**自己批准
    expect(out.candidatePaths.length).toBe(1);
    expect(await sha256File(out.candidatePaths[0])).toBeTruthy();      // 真文件
    const onDisk = JSON.parse(await fs.readFile(out.candidatePaths[0], 'utf8'));
    expect(onDisk.contentHash).toBe(cand.contentHash);
    expect(onDisk.approval.state).toBe('not_requested');
    expect(onDisk.snapshotScope).toBe('next_run_only');
    expect(onDisk.appliesToRunningRun).toBe(false);
    expect(onDisk.runningSnapshotHash).toBe((await m.wiring.skillSnapshotHash(NAME, home)));   // 运行中那份被如实记下

    // 2. 评估: 同一份候选不判垃圾 → 可晋升 (门不是永远拒绝)
    const assessment = m.candidate.assessCandidate(cand, []);
    expect(assessment.junkReasons).toEqual([]);
    expect(assessment.promotable).toBe(true);
    expect(assessment.comparison).toBe('new');

    // 3. 晋升记录 (人批准后): 带 approval + 同一 contentHash + 版本推进 1.0.0 → 1.1.0
    const promotedAt = iso(T0 + 120_000);
    const rec = m.candidate.draftPromotion(
      cand, before.entries[0].version, '用户批准: 这套流程在 3 个 Run 上都成立', 'leo', promotedAt,
    );
    expect(rec.skillName).toBe(NAME);
    expect(rec.contentHash).toBe(cand.contentHash);
    expect(rec.fromVersion).toBe('1.0.0');
    expect(rec.toVersion).toBe('1.1.0');
    expect(rec.approval).toEqual({
      state: 'approved', approvedBy: 'leo', approvedAt: promotedAt,
      changeReason: '用户批准: 这套流程在 3 个 Run 上都成立',
    });
    expect(rec.sourceRunIds).toEqual([runId]);                         // 晋升记录指真 Run
    expect(rec.evidenceRefs).toEqual(cand.evidenceRefs);
    expect(rec.failureCases.length).toBeGreaterThan(0);
    expect(rec.promotedAt).toBe(promotedAt);

    // 4. 只影响下一次 Run: 正在执行的版本 (盘上文件 + 记录里固定的快照) 逐字节不变
    const skillsAfter = await listDir(path.join(home, '.bolloon', 'skills', NAME));
    expect(skillsAfter).toEqual(['SKILL.md']);                         // 没有新版本目录/文件被写进来
    expect(await sha256File(path.join(skillDir, 'SKILL.md'))).toBe(v1Hash);
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(v1);
    expect(rec.snapshotScope).toBe('next_run_only');
    // 当前 Goal 记录的版本仍是旧的 (记录里那一份 = 正在跑的那一份)
    const goalNow = await m.gs.readGoal(goalId);
    const goalSnap = goalNow!.skillSnapshot ?? [];
    expect(goalSnap.every((s) => s.contentHash === before.entries[0].contentHash)).toBe(true);

    // 5. 下一次 Run 才会看到新版本: 把新版本落盘 → **下一次**的版本解析立刻变, 而记录不变
    const goalBytesBefore = JSON.stringify(goalNow!.skillSnapshot ?? []);
    const v2 = v1.replace('version: 1.0.0', 'version: 1.1.0').replace('运行中版本正文。', '新版本正文 (下一次 Run 生效)。');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), v2, 'utf8');
    const nextRun = await m.skills.getSkillsManager({ home }).snapshot([NAME], { home });
    expect(nextRun.entries[0].version).toBe('1.1.0');
    expect(nextRun.entries[0].contentHash).not.toBe(before.entries[0].contentHash);   // 真的变了 (不是恒等)
    expect(JSON.stringify((await m.gs.readGoal(goalId))!.skillSnapshot ?? [])).toBe(goalBytesBefore);

    // 6. 全链没有自动批准: 正式 skills/ 里从头到尾没有多出文件, 且候选仍是 to_request 状态
    expect((await listDir(path.join(home, '.bolloon', 'skill-candidates'))).length).toBe(1);
    const candOnDisk = JSON.parse(await fs.readFile(out.candidatePaths[0], 'utf8'));
    expect(candOnDisk.approval.state).toBe('not_requested');
    expect(m.fly.RUN_CLOSURE_STEPS.length).toBe(9);
    expect(out.result.steps).toEqual([...m.fly.RUN_CLOSURE_STEPS]);    // 9 步流水线走完 (含写候选那一步)
  });

  it('(2) 强负例: 只有一次偶然成功 → 收尾判 rejected + 盘上不留候选 + 晋升必抛', async () => {
    const m = await mods();
    const home = TMP;
    const NAME = 'p6-one-off-skill';
    const T0 = Date.now();
    const { out } = await realRunAndClose(m, { home, name: NAME, occurrences: 1, now: T0 });

    expect(out.result.candidates.length).toBe(1);
    const bad = out.result.candidates[0];
    expect(bad.status).toBe('rejected');
    expect(bad.junkReasons).toContain('single_success');
    // 盘上**不留**候选 (收尾不把被拒的候选写出去)
    expect(out.candidatePaths).toEqual([]);
    expect(await listDir(path.join(home, '.bolloon', 'skill-candidates'))).toEqual([]);
    expect(out.result.skipped.some((s) => /no_promotable_candidate/.test(s.reason))).toBe(true);
    // 就算硬送去晋升 → 必抛 (不返回假记录)
    expect(m.candidate.assessCandidate(bad, []).promotable).toBe(false);
    expect(() => m.candidate.draftPromotion(bad, null, '看着挺好', 'leo', iso(T0))).toThrow(/不得晋升|single_success/);
    // 对照: 同一形状把 occurrences 提到 3 → 才 draft + 真落盘 (门不是永远拒绝)
    const ok = await realRunAndClose(m, { home: path.join(TMP, 'ok'), name: NAME, occurrences: 3, now: T0 });
    expect(ok.out.result.candidates[0].status).toBe('draft');
    expect(ok.out.candidatePaths.length).toBe(1);
  });

  it('(3) 防御性重算 + 必备项: 调用方"自觉"清空 junkReasons 也绕不过; 缺项必须抛', async () => {
    const m = await mods();
    const home = TMP;
    const T0 = Date.now();
    const { out, runId } = await realRunAndClose(m, { home, name: 'p6-defensive', occurrences: 3, now: T0 });
    const good = out.result.candidates[0];
    expect(m.candidate.assessCandidate(good, []).promotable).toBe(true);

    // ① 把 occurrences 改回 1, 并**手工把 junkReasons 清空** → 仍然不许晋升
    const sneaky: SkillImprovementCandidate = { ...good, occurrences: 1, junkReasons: [] };
    const a = m.candidate.assessCandidate(sneaky, []);
    expect(a.junkReasons).toContain('single_success');
    expect(a.promotable).toBe(false);
    expect(() => m.candidate.draftPromotion(sneaky, null, 'r', 'leo', iso(T0))).toThrow(/不得晋升/);

    // ② 有 contentHash 但边界不清 → 不许晋升 (两条门互相独立)
    const unclear: SkillImprovementCandidate = { ...good, boundaryClear: false, junkReasons: [] };
    expect(m.candidate.assessCandidate(unclear, []).promotable).toBe(false);
    expect(() => m.candidate.draftPromotion(unclear, null, 'r', 'leo', iso(T0))).toThrow(/boundaryClear/);

    // ③ 必备项缺一即抛 (签名表达不了失败, 所以不能静默返回假记录)
    expect(() => m.candidate.draftPromotion(good, null, 'r', '', iso(T0))).toThrow(/approvedBy/);
    expect(() => m.candidate.draftPromotion(good, null, '', 'leo', iso(T0))).toThrow(/changeReason/);
    expect(() => m.candidate.draftPromotion({ ...good, contentHash: null }, null, 'r', 'leo', iso(T0))).toThrow(/contentHash/);
    expect(() => m.candidate.draftPromotion(good, null, 'r', 'leo', '不是时间')).toThrow(/ISO/);
    // 正控: 四项齐 → 真出记录
    const ok = m.candidate.draftPromotion(good, '2.3.4', '用户批准', 'leo', iso(T0));
    expect(ok.toVersion).toBe('2.4.0');
    expect(ok.approval.state).toBe('approved');
    expect(ok.snapshotScope).toBe('next_run_only');

    // ④ 与已有同名同哈希的 Skill 重复 → duplicate_of_existing (注册表那一侧的门)
    const dup = m.candidate.assessCandidate(good, [{ name: good.name, contentHash: good.contentHash!, version: '1.0.0' }]);
    expect(dup.junkReasons).toContain('duplicate_of_existing');
    expect(dup.comparison).toBe('duplicate');
    expect(dup.promotable).toBe(false);
    // 同名不同哈希 → 版本推进 (不是重复)
    const bump = m.candidate.assessCandidate(good, [{ name: good.name, contentHash: 'ffffffffffffffff', version: '1.0.0' }]);
    expect(bump.comparison).toBe('version_bump');
    expect(bump.promotable).toBe(true);
    expect(runId).toBeTruthy();
  });
});
