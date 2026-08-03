import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createDecision,
  loadDecision,
  updateDecisionStatus,
  listDecisions,
  decisionToContext,
} from '../agents/decision-store.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-decision-store-test-${Date.now()}`);
const tmpBolloon = path.join(tmpHome, '.bolloon');
let oldHome = '';
let oldBolloonHome = '';

describe('decision-store (Context OS §7 九要素决策协议)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    oldBolloonHome = process.env.BOLLOON_HOME || '';
    process.env.HOME = tmpHome;
    // judgeness store 优先用 BOLLOON_HOME (完整 .bolloon 路径), human-value-store 用 HOME/.bolloon
    process.env.BOLLOON_HOME = tmpBolloon;
    await fs.mkdir(tmpBolloon, { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.BOLLOON_HOME = oldBolloonHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('createDecision 落盘 + 9 要素结构完整', async () => {
    const r = await createDecision({
      problem: 'P2P 消息重试策略: 指数退避还是固定间隔',
      options: [
        { label: '指数退避', costs: '实现稍复杂', benefits: '减轻对端压力, 抗网络抖动', risks: '长尾重试延迟高 (可恢复)' },
        { label: '固定间隔', costs: '实现简单', benefits: '延迟可预测', risks: '拥塞时加剧对端压力' },
        { label: '什么都不做', includeDoNothing: true, costs: '维持现状', benefits: '零改动', risks: '消息丢失不恢复' },
      ],
      infoGaps: '对端队列深度未知',
      recommendation: '指数退避',
      timing: '跨机 P2P 已实测丢包',
      rollback: '连续 3 次超时 → 回退固定间隔',
      stakes: 'high',
      domain: '网络',
    });
    expect(r.ok).toBe(true);
    expect(r.decision!.status).toBe('draft');
    expect(r.decision!.options).toHaveLength(3);
    expect(r.decision!.options[2].includeDoNothing).toBe(true);
    expect(r.decision!.problem).toContain('重试策略');

    const loaded = await loadDecision(r.decision!.decisionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.rollback).toContain('回退固定间隔');
    expect(loaded!.context.stakes).toBe('high');
  });

  it('createDecision 缺 problem / 缺 options → error', async () => {
    const noProblem = await createDecision({ problem: '', options: [{ label: 'A' }] });
    expect(noProblem.ok).toBe(false);
    const noOptions = await createDecision({ problem: '问题', options: [] });
    expect(noOptions.ok).toBe(false);
  });

  it('decide → 状态 decided + 自动 reflect 到 judgeness (HumanJudgment + JudgenessDescription)', async () => {
    const r = await createDecision({
      problem: '是否给本地智能体加决策协议工具',
      options: [{ label: '加', costs: '2 天开发', benefits: '决策可追溯', risks: '低' }],
      recommendation: '加',
      stakes: 'medium',
      domain: '产品',
    });
    const d = await updateDecisionStatus(r.decision!.decisionId, { decide: true }, { byAgentId: 'agent-test' });
    expect(d.ok).toBe(true);
    expect(d.decision!.status).toBe('decided');
    expect(d.decision!.decidedAt).toBeTruthy();
    expect(d.decision!.reflection).toBeTruthy();
    expect(d.decision!.reflection!.hvId).toMatch(/^hv-/);

    // human-values 落盘
    const hvPath = path.join(tmpBolloon, 'human-values', 'judgments.json');
    const hvRaw = await fs.readFile(hvPath, 'utf-8');
    const judgments = JSON.parse(hvRaw);
    expect(judgments.some((j: any) => j.id === d.decision!.reflection!.hvId)).toBe(true);

    // judgeness descriptions 落盘
    if (d.decision!.reflection!.jdId) {
      const jdPath = path.join(tmpBolloon, 'judgeness', 'descriptions', `${d.decision!.reflection!.jdId}.md`);
      const jdRaw = await fs.readFile(jdPath, 'utf-8');
      expect(jdRaw).toContain('descriptionId:');
      expect(jdRaw).toContain('openState: locked'); // 阶段0 临时价值点, agent 不能自动 publish
      expect(jdRaw).toContain('visibility: private');
    }
  });

  it('decide 缺 recommendation → error', async () => {
    const r = await createDecision({
      problem: '测试决策',
      options: [{ label: 'A', costs: '', benefits: '', risks: '' }],
    });
    const d = await updateDecisionStatus(r.decision!.decisionId, { decide: true });
    expect(d.ok).toBe(false);
    expect(d.error).toContain('recommendation');
  });

  it('rollback → 状态 rolled-back + 教训入库 (reject)', async () => {
    const r = await createDecision({
      problem: '是否切到新 RPC 提供方',
      options: [{ label: '切', costs: '迁移成本', benefits: '更稳', risks: '未知兼容性' }],
      recommendation: '切',
      stakes: 'high',
      domain: '网络',
    });
    const d = await updateDecisionStatus(r.decision!.decisionId, { rollback: true, reason: '实测延迟更高, 回滚到原提供方' });
    expect(d.ok).toBe(true);
    expect(d.decision!.status).toBe('rolled-back');

    const hvPath = path.join(tmpBolloon, 'human-values', 'judgments.json');
    const judgments = JSON.parse(await fs.readFile(hvPath, 'utf-8'));
    const lesson = judgments.find((j: any) => j.decision.includes('回滚决策'));
    expect(lesson).toBeTruthy();
    expect(lesson.decision_type).toBe('reject');
  });

  it('listDecisions 状态过滤 + decisionToContext 含 9 要素', async () => {
    const a = await createDecision({ problem: '决策A: 列表过滤测试', options: [{ label: 'A' }] });
    await updateDecisionStatus(a.decision!.decisionId, { decide: true, recommendation: 'A' });
    await createDecision({ problem: '决策B: draft 状态', options: [{ label: 'B' }] });

    const decided = await listDecisions('decided');
    expect(decided.length).toBeGreaterThanOrEqual(1);
    expect(decided.every((d) => d.status === 'decided')).toBe(true);

    const ctx = decisionToContext(decided[0]);
    expect(ctx).toContain('决策A');
    expect(ctx).toContain('推荐:');
  });
});
