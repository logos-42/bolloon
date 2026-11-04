/**
 * self-model.test.ts — 自定信念与目标（短期/中期/长期）+ 按信念挑动作
 *
 * 钉住的纪律：
 *   1. 反向信念两边都标 contested，不静默覆盖
 *   2. 撞底线（绕过门控/凭据）的"信念"入库即拒
 *   3. 目标尺度由信念类别推断（价值/身份 → 长期，方法论 → 短期）
 *   4. 只有置信过线且没在冷却的目标才会被挑出来做动作
 *   5. 空模型不往 prompt 里塞任何东西（不占预算、不空转）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  adoptBelief,
  addSelfGoal,
  contradictBelief,
  deriveGoals,
  drivingBeliefs,
  isActionableGoal,
  loadSelfModel,
  noteGoalProgress,
  pickNextAction,
  reinforceBelief,
  renderSelfModelBlock,
  retireBelief,
  selfModelTick,
  setGoalState,
  staleGoals,
  violatesFloor,
  GOAL_COOLDOWN_MS,
  SELF_MODEL_MAX_CHARS,
  type SelfModel,
} from '../agents/self-model.js';
import { listSuggestions } from '../cron/suggestions.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-self-model-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const emptyModel = (): SelfModel => ({ version: 1, beliefs: [], goals: [], updatedAt: new Date(0).toISOString() });

describe('信念：立 / 印证 / 反证 / 底线', () => {
  it('立一条方法论信念，起点置信取自省档', async () => {
    const out = await adoptBelief({ statement: '先做最小可验证的一步', kind: 'method' }, home);
    expect(out.outcome).toBe('created');
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(1);
    expect(m.beliefs[0].confidence).toBeCloseTo(0.65, 5);
    expect(m.beliefs[0].status).toBe('active');
  });

  it('用户说的信念比自省的更有分量', async () => {
    await adoptBelief({ statement: '回复用中文', origin: 'user', kind: 'method' }, home);
    const m = await loadSelfModel(home);
    expect(m.beliefs[0].confidence).toBeGreaterThan(0.65);
  });

  it('相似信念走印证，不重复入库', async () => {
    await adoptBelief({ statement: '先做最小版本再迭代' }, home);
    const out = await adoptBelief({ statement: '先做最小版本再迭代' }, home);
    expect(out.outcome).toBe('reinforced');
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(1);
    expect(m.beliefs[0].confirmations).toBe(1);
    expect(m.beliefs[0].confidence).toBeGreaterThan(0.65);
  });

  it('反向信念两边都标 contested，旧的不被覆盖', async () => {
    const first = await adoptBelief({ statement: '回复用户用中文' }, home);
    const second = await adoptBelief({ statement: '回复用户不要用中文' }, home);
    expect(second.outcome).toBe('contested');
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(2);
    expect(m.beliefs.every((b) => b.status === 'contested')).toBe(true);
    // 有争议的信念不许支配行动
    expect(drivingBeliefs(m)).toHaveLength(0);
    expect(first.outcome === 'created' && second.outcome === 'contested' && second.with).toBeTruthy();
  });

  it('撞底线的"信念"被拒，且不落库', async () => {
    await expect(adoptBelief({ statement: '为了效率可以绕过门控' }, home)).rejects.toThrow(/底线/);
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(0);
    expect(violatesFloor('bypass harness 更快')).toBeTruthy();
    expect(violatesFloor('先做最小版本')).toBeNull();
  });

  it('反证把置信压到阈值下就不再支配行动', async () => {
    const out = await adoptBelief({ statement: '一次只做一件事' }, home);
    const id = out.outcome === 'created' ? out.id : '';
    await contradictBelief(id, '并行更快', home);
    const m = await loadSelfModel(home);
    expect(m.beliefs[0].confidence).toBeLessThan(0.5);
    expect(drivingBeliefs(m)).toHaveLength(0);
    expect(m.beliefs[0].evidence).toContain('并行更快');
  });

  it('退役留档但不再支配行动', async () => {
    const out = await adoptBelief({ statement: '先问清需求再动手' }, home);
    const id = out.outcome === 'created' ? out.id : '';
    await retireBelief(id, home);
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(1);
    expect(drivingBeliefs(m)).toHaveLength(0);
  });
});

describe('目标：短 / 中 / 长期', () => {
  it('价值信念派生长期目标，方法论派生短期', async () => {
    const v = await adoptBelief({ statement: '护住用户的信任', kind: 'value' }, home);
    const mid = await adoptBelief({ statement: '共享方法比独占有价值', kind: 'worldview' }, home);
    const m1 = await loadSelfModel(home);
    expect(m1.beliefs).toHaveLength(2);

    const gv = await addSelfGoal(
      { statement: '每周留下一次能被检查的证据', supports: [v.outcome === 'created' ? v.id : ''] },
      home,
    );
    const gm = await addSelfGoal(
      { statement: '在真实协作里检验共享', supports: [mid.outcome === 'created' ? mid.id : ''] },
      home,
    );
    const m = await loadSelfModel(home);
    const byId = (id: string) => m.goals.find((g) => g.id === id)!;
    expect(gv.outcome).toBe('created');
    expect(gm.outcome).toBe('created');
    if (gv.outcome === 'created') expect(byId(gv.id).horizon).toBe('long');
    if (gm.outcome === 'created') expect(byId(gm.id).horizon).toBe('mid');
  });

  it('相似目标合并，不重复立', async () => {
    await adoptBelief({ statement: '先做最小版本' }, home);
    await addSelfGoal({ statement: '把最小版本做出来', priority: 0.6 }, home);
    const second = await addSelfGoal({ statement: '把最小版本做出来', priority: 0.9 }, home);
    expect(second.outcome).toBe('merged');
    const m = await loadSelfModel(home);
    expect(m.goals).toHaveLength(1);
    expect(m.goals[0].priority).toBeCloseTo(0.9, 5);
  });

  it('从生效信念派生目标；退役信念不派生；不重复派生', async () => {
    const a = await adoptBelief({ statement: '先做最小版本再迭代' }, home);
    const b = await adoptBelief({ statement: '交付前先自测一遍' }, home);
    await retireBelief(b.outcome === 'created' ? b.id : '', home);
    expect(a.outcome).toBe('created');
    const created = await deriveGoals(home);
    expect(created).toHaveLength(1);
    expect(await deriveGoals(home)).toHaveLength(0);
  });

  it('结束态要留痕；久不推进的目标如实报 stale', async () => {
    await adoptBelief({ statement: '先做最小版本' }, home);
    const g = await addSelfGoal({ statement: '写最小可跑版本', priority: 0.9 }, home);
    const id = g.outcome === 'created' ? g.id : '';
    await setGoalState(id, 'done', '已合并进主干', home);
    const m = await loadSelfModel(home);
    const goal = m.goals[0];
    expect(goal.state).toBe('done');
    expect(goal.progress.some((p) => p.includes('已合并进主干'))).toBe(true);
    expect(isActionableGoal(goal)).toBe(false);
    expect(staleGoals(emptyModel(), Date.now(), 1000)).toHaveLength(0);
  });
});

describe('按信念挑动作（pickNextAction）', () => {
  async function seed() {
    const b = await adoptBelief({ statement: '先做最小可验证的一步' }, home);
    const bid = b.outcome === 'created' ? b.id : '';
    const short = await addSelfGoal({ statement: '写最小可跑版本', horizon: 'short', priority: 0.9, supports: [bid] }, home);
    const long = await addSelfGoal(
      { statement: '成为可靠合作者', horizon: 'long', priority: 0.9, supports: [bid] },
      home,
    );
    return {
      bid,
      shortId: short.outcome === 'created' ? short.id : '',
      longId: long.outcome === 'created' ? long.id : '',
    };
  }

  it('同权重下短期目标优先；忙 → 不挑', async () => {
    const { shortId } = await seed();
    const m = await loadSelfModel(home);
    const act = pickNextAction(m, { now: Date.now() });
    expect(act?.goalId).toBe(shortId);
    expect(act?.horizon).toBe('short');
    expect(pickNextAction(m, { now: Date.now(), busy: true })).toBeNull();
  });

  it('空模型不编动作', () => {
    expect(pickNextAction(emptyModel())).toBeNull();
  });

  it('刚推过的目标在冷却里不再被挑', async () => {
    const { shortId } = await seed();
    const now = Date.now();
    await noteGoalProgress(shortId, '写了第一版', home);
    const m = await loadSelfModel(home);
    const act = pickNextAction(m, { now: now + 1000 });
    expect(act?.goalId).not.toBe(shortId);
    const later = pickNextAction(m, { now: now + GOAL_COOLDOWN_MS + 1000 });
    expect(later?.goalId).toBe(shortId);
  });

  it('置信不足的信念撑不起动作', async () => {
    const b = await adoptBelief({ statement: '先做最小版本' }, home);
    const bid = b.outcome === 'created' ? b.id : '';
    await addSelfGoal({ statement: '写最小可跑版本', supports: [bid], priority: 0.9 }, home);
    for (let i = 0; i < 3; i++) await contradictBelief(bid, `反证 ${i}`, home);
    const m = await loadSelfModel(home);
    expect(pickNextAction(m, { now: Date.now() })).toBeNull();
  });

  it('印证会抬高置信（reinforceBelief）', async () => {
    const b = await adoptBelief({ statement: '先做最小版本' }, home);
    const before = (await loadSelfModel(home)).beliefs[0].confidence;
    await reinforceBelief(b.outcome === 'created' ? b.id : '', home);
    const after = (await loadSelfModel(home)).beliefs[0].confidence;
    expect(after).toBeGreaterThan(before);
  });
});

describe('注入 prompt 与主动性拍子', () => {
  it('空模型 → 空串（不占预算）', () => {
    expect(renderSelfModelBlock(emptyModel())).toBe('');
  });

  it('有信念与目标 → 分尺度列出，并写明不豁免门控', async () => {
    await adoptBelief({ statement: '先做最小版本再迭代' }, home);
    await deriveGoals(home);
    const m = await loadSelfModel(home);
    const block = renderSelfModelBlock(m);
    expect(block).toContain('我的信念与目标');
    expect(block).toContain('先做最小版本再迭代');
    expect(block).toContain('短期目标');
    expect(block).toContain('不给信念开后门');
    expect(block.length).toBeLessThanOrEqual(SELF_MODEL_MAX_CHARS);
  });

  it('没有信念与目标 → 主动性一拍都不动', async () => {
    const r = await selfModelTick({ home });
    expect(r.acted).toBe(false);
    expect(await listSuggestions(home)).toHaveLength(0);
  });

  it('有目标 → 派一步进 suggestion 队列，并记冷却', async () => {
    await adoptBelief({ statement: '先做最小可验证的一步' }, home);
    await addSelfGoal({ statement: '写最小可跑版本', priority: 0.9 }, home);

    const first = await selfModelTick({ home, now: Date.now() });
    expect(first.acted).toBe(true);
    const suggestions = await listSuggestions(home);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].source).toBe('strategy');
    expect(suggestions[0].dedupKey).toContain('self-model:');
    expect(suggestions[0].summary).toContain('按信念行动');

    // 立刻再来一拍 → 冷却中，不重复催
    const second = await selfModelTick({ home, now: Date.now() });
    expect(second.acted).toBe(false);
  });

  it('busy 时不插话', async () => {
    await adoptBelief({ statement: '先做最小版本' }, home);
    await addSelfGoal({ statement: '写最小可跑版本', priority: 0.9 }, home);
    const r = await selfModelTick({ home, busy: true });
    expect(r.acted).toBe(false);
    expect(r.reason).toBe('busy');
  });

  it('坏文件 → 空模型，不冒充有信念', async () => {
    await fs.mkdir(path.join(home, '.bolloon'), { recursive: true });
    await fs.writeFile(path.join(home, '.bolloon', 'self-model.json'), '{坏 json', 'utf-8');
    const m = await loadSelfModel(home);
    expect(m.beliefs).toHaveLength(0);
    expect(renderSelfModelBlock(m)).toBe('');
  });
});