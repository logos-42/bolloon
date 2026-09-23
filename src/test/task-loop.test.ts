/**
 * task-loop.test.ts — M1 任务闭环的单测 (纯函数为主, 快且确定)
 *
 * 真跑的端到端在 `scripts/verify-task-loop.ts` (需要真 HTTP + 真执行);
 * 这里覆盖: 预算三层闸 · 报告卡两条硬门 · 10 态→4 态映射 · 顾问打分/关联 · 输入推导 · 幂等 requestId。
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  M1_BUDGET_LIMITS, resolveTaskBudget, checkPurchaseAllowed, previewPurchaseImpact, assertNoExpansion,
} from '../agents/task/task-budget.js';
import { buildReportCard, humanStatusFrom, renderReportCard } from '../agents/task/report-card.js';
import { tokenizeTask, scoreSkill, linkListing, adviseResource } from '../agents/task/resource-advisor.js';
import {
  deriveSkillInput, extractConclusion, extractSources, defaultCriteria, defaultRequestId, installBundle,
  mapFailureStatus, failureStageFor, hasExecutionEvidence, refetchDeliveredContent,
} from '../agents/task/task-runner.js';
import * as fs from 'fs';
import * as os from 'os';

const FIXTURES = path.resolve('scripts/fixtures/skills');

describe('M1 预算闸 (单任务 0.05 / 单次 0.02 / 单日 0.10, 取 min, 不许扩大)', () => {
  it('缺省就是 M1 硬上限', () => {
    const r = resolveTaskBudget();
    expect(r.ok).toBe(true);
    expect(r.plan!.taskBudget).toBe(M1_BUDGET_LIMITS.task);
    expect(r.plan!.perPurchase).toBe(M1_BUDGET_LIMITS.perPurchase);
    expect(r.plan!.daily).toBe(M1_BUDGET_LIMITS.daily);
  });

  it('给多了 → 取 min 且显式留痕 (不静默)', () => {
    const r = resolveTaskBudget({ taskBudget: '0.5', perPurchase: '0.4', daily: '5' });
    expect(r.plan!.taskBudget).toBe(0.05);
    expect(r.plan!.perPurchase).toBe(0.02);
    expect(r.plan!.daily).toBe(0.1);
    expect(r.plan!.clamped).toEqual({ task: true, perPurchase: true, daily: true });
    expect(r.plan!.why.join(' ')).toContain('超过 M1 上限');
  });

  it('单次上限不能超过任务预算', () => {
    const r = resolveTaskBudget({ taskBudget: '0.03' });
    expect(r.plan!.perPurchase).toBeLessThanOrEqual(0.03);
  });

  it('非法输入一律拒绝 (不猜)', () => {
    expect(resolveTaskBudget({ taskBudget: 'abc' }).ok).toBe(false);
    expect(resolveTaskBudget({ taskBudget: '0' }).ok).toBe(false);
    expect(resolveTaskBudget({ daily: '-2' }).ok).toBe(false);
  });

  it('三层闸各自会拦, 且指明是哪一层', () => {
    const plan = resolveTaskBudget().plan!;
    expect(checkPurchaseAllowed({ amount: '0.03', plan }).layer).toBe('perPurchase');
    expect(checkPurchaseAllowed({ amount: '0.012', plan, spentInTask: 0.045 }).layer).toBe('taskBudget');
    expect(checkPurchaseAllowed({ amount: '0.012', plan, spentToday: 0.095 }).layer).toBe('daily');
    expect(checkPurchaseAllowed({ amount: '0.012', plan }).allowed).toBe(true);
  });

  it('购买前能算出价格与预算影响', () => {
    const plan = resolveTaskBudget().plan!;
    const lines = previewPurchaseImpact(plan, '0.012');
    expect(lines.join(' ')).toContain('占任务预算');
    expect(lines.join(' ')).toContain('剩余');
  });

  it('执行中扩大预算 → 拒绝 (用户只给一次)', () => {
    const plan = resolveTaskBudget().plan!;
    expect(assertNoExpansion(plan, { ...plan, taskBudget: 0.5 }).ok).toBe(false);
    expect(assertNoExpansion(plan, { ...plan, perPurchase: 0.5 }).ok).toBe(false);
    expect(assertNoExpansion(plan, { ...plan }).ok).toBe(true);
  });
});

describe('报告卡两条硬门 (买到没执行 / 执行了没证据 → 不许变绿)', () => {
  it('买到 Skill 但没执行 → 需要你处理 + hardGate', () => {
    const c = buildReportCard({ task: 't', paid: true, executed: false, evidenceRef: {} });
    expect(c.status).toBe('需要你处理');
    expect(c.hardGate).toBe('bought_not_executed');
    expect(c.conclusion).toBe('证据不足');
  });

  it('执行了但没证据 → 需要你处理 + hardGate', () => {
    const c = buildReportCard({ task: 't', paid: true, executed: true, outputContract: '通过', resourceVerified: '通过', evidenceComplete: false, evidenceRef: {} });
    expect(c.status).toBe('需要你处理');
    expect(c.hardGate).toBe('executed_without_evidence');
  });

  it('三项校验任一未过 → 不许显示"已完成"', () => {
    const base = { task: 't', paid: true, executed: true, evidenceComplete: true, evidenceRef: {} } as any;
    expect(buildReportCard({ ...base, outputContract: '未通过', resourceVerified: '通过' }).status).toBe('需要你处理');
    expect(buildReportCard({ ...base, outputContract: '通过', resourceVerified: '未通过' }).status).toBe('需要你处理');
  });

  it('全部达标才显示已完成', () => {
    const c = buildReportCard({ task: 't', conclusion: '适合', paid: true, executed: true, outputContract: '通过', resourceVerified: '通过', evidenceComplete: true, evidenceRef: { goalId: 'g' } });
    expect(c.status).toBe('已完成');
    expect(c.hardGate).toBeUndefined();
  });

  it('内部 10 态 → 4 个用户态 (术语不外泄)', () => {
    expect(humanStatusFrom({ lifecycle: 'quoted' })).toBe('正在获取能力');
    expect(humanStatusFrom({ lifecycle: 'paying' })).toBe('正在获取能力');
    expect(humanStatusFrom({ lifecycle: 'settled' })).toBe('正在执行');
    expect(humanStatusFrom({ lifecycle: 'delivered' })).toBe('正在执行');
    expect(humanStatusFrom({ lifecycle: 'verified' })).toBe('已完成');
    expect(humanStatusFrom({ lifecycle: 'disputed' })).toBe('需要你处理');
    expect(humanStatusFrom({ lifecycle: 'policy_denied' })).toBe('需要你处理');
    expect(humanStatusFrom({ stage: 'prepare' })).toBe('准备中');
  });

  it('渲染文本不含任何内部术语', () => {
    const c = buildReportCard({ task: 't', conclusion: '适合', paid: true, executed: true, outputContract: '通过', resourceVerified: '通过', evidenceComplete: true, evidenceRef: { goalId: 'g', runId: 'r', transactionId: 'tx' } });
    const text = renderReportCard(c);
    for (const bad of ['quoted', 'payment_required', 'fully_settled', 'chainSettled', 'facilitator', 'lease', 'settlementFact']) {
      expect(text).not.toContain(bad);
    }
    expect(text).toContain('本次使用');
    expect(text).toContain('查看完整证据');
  });
});

describe('顾问: 确定性匹配 (无语义搜索/无推荐系统)', () => {
  it('中文 bigram + 英文词切分, 可复现', () => {
    const a = tokenizeTask('判断这款厨房用品是否进入日本市场');
    expect(tokenizeTask('判断这款厨房用品是否进入日本市场')).toEqual(a);
    expect(a).toContain('日本');
    expect(tokenizeTask('cross-border market research')).toContain('market');
  });

  it('名字命中权重高于描述', () => {
    const byName = scoreSkill({ tokens: ['market'], name: 'market-research', description: '' });
    const byDesc = scoreSkill({ tokens: ['market'], name: 'other', description: 'market stuff' });
    expect(byName.score).toBeGreaterThan(byDesc.score);
  });

  it('报价关联: id 同名 / note 里的 skill= / 标题包含', () => {
    expect(linkListing('sk', [{ id: 'sk', price: { amount: '0.01' } }])?.amount).toBe('0.01');
    expect(linkListing('sk', [{ id: 'x', source: { note: 'skill=sk@1.0.0' } }])?.itemId).toBe('x');
    expect(linkListing('sk', [{ id: 'y', title: '本机 sk 资源' }])?.itemId).toBe('y');
    expect(linkListing('sk', [{ id: 'z', title: '别的' }])).toBeUndefined();
  });

  it('夹具技能被识别为可执行候选 (契约解析吃内联 JSON)', async () => {
    const r = await adviseResource({ task: '判断这款厨房用品是否适合进入日本市场', skillPaths: [FIXTURES] });
    expect(r.needed).toBe(true);
    expect(r.chosen?.name).toBe('cross-border-market-research');
    expect(r.chosen?.contract.execution.entrypoint).toBe('run.mjs');
    expect(r.chosen?.why.length).toBeGreaterThan(0);
  });

  it('没有可执行资源 → needed:false 且说明原因 (不猜)', async () => {
    const r = await adviseResource({ task: '随便问问', skillPaths: [] });
    expect(r.needed).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('输入推导 / 结论抽取 / 判据 / 幂等 id', () => {
  const contract = {
    inputSchema: { type: 'object', required: ['product'], properties: { product: { type: 'string' }, market: { type: 'string' }, budgetUsd: { type: 'number' } } },
    verification: { requiredFields: ['summary', 'findings'], evidenceFields: ['sources'] },
  };

  it('商品名清洗 + 可选市场字段识别到才填', () => {
    const input = deriveSkillInput(contract, '判断这款厨房用品是否适合进入日本市场');
    expect(String(input.product)).toContain('厨房用品');
    expect(String(input.product)).not.toContain('市场');
    expect(input.market).toBe('日本');
  });

  it('数字字段只在任务里真有数字时才填', () => {
    expect(deriveSkillInput(contract, '厨房用品进入日本, 预算 100 美元').budgetUsd).toBe(100);
    expect(deriveSkillInput(contract, '厨房用品进入日本').budgetUsd).toBeUndefined();
  });

  it('数字字段不编造: 任务里无关的数字(如技术符号里的 0)不会被塞进数值字段', () => {
    const fusion = {
      inputSchema: {
        type: 'object', required: ['field_T', 'tc_K'],
        properties: { field_T: { type: 'number' }, tc_K: { type: 'number' }, factor: { type: 'number' }, relation: { type: 'string' } },
      },
    };
    // 旧实现把「任务里第一个数字」塞给每个数值字段 → 命中符号 μ0H_P 里的 "0" → 全变 0
    const task = '据 μ0H_P ≈ 1.84·T_c 这一关系, 判定 12.2 T ↔ 6.63 K 是否自洽';
    expect(deriveSkillInput(fusion, task).field_T).toBeUndefined();
    expect(deriveSkillInput(fusion, task).tc_K).toBeUndefined();
    expect(deriveSkillInput(fusion, task).factor).toBeUndefined();
    // 有锚点(字段名/别名紧邻数字)才填 → 调用方本来就能靠输入把数字说清楚
    const anchored = deriveSkillInput(fusion, 'field_T=12.2, tc_K=6.63, factor=1.84');
    expect(anchored.field_T).toBe(12.2);
    expect(anchored.tc_K).toBe(6.63);
    expect(anchored.factor).toBe(1.84);
  });

  it('结论/来源抽取不猜语义', () => {
    expect(extractConclusion({ conclusion: '适合进入' }).conclusion).toBe('适合进入');
    expect(extractConclusion({ suitable: false }).conclusion).toBe('不适合');
    expect(extractConclusion({}).conclusion).toBeUndefined();
    expect(extractSources({ sources: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(extractSources({ findings: [{ source: 'x' }, { source: 'y' }] })).toEqual(['x', 'y']);
    expect(extractSources({})).toEqual([]);
  });

  it('判据来自契约 (可判定条目)', () => {
    const c = defaultCriteria(contract);
    expect(c.length).toBeGreaterThanOrEqual(3);
    expect(c[0]).toContain('summary');
  });

  it('requestId 按 (任务+预算) 确定性派生 → 重跑不重复付款', () => {
    expect(defaultRequestId('任务A', 0.05)).toBe(defaultRequestId('任务A', 0.05));
    expect(defaultRequestId('任务A', 0.05)).not.toBe(defaultRequestId('任务A', 0.06));
    expect(defaultRequestId('任务A', 0.05)).toMatch(/^task-[0-9a-f]{16}$/);
  });
});

describe('M4 出口口径 (纯函数)', () => {
  it('有输出但契约不过 → verification_failed; 没产出 → delivery_failed', () => {
    expect(mapFailureStatus({ producedOutput: true, contractOk: false })).toBe('verification_failed');
    expect(mapFailureStatus({ producedOutput: false, contractOk: false })).toBe('delivery_failed');
    expect(mapFailureStatus({ producedOutput: true, contractOk: true })).toBe('delivery_failed');
  });

  it('失败阶段: 装不上→install / 没产出→execute / 产出不合契约→output_contract', () => {
    expect(failureStageFor({ installOk: false, producedOutput: true, contractOk: true })).toBe('install');
    expect(failureStageFor({ installOk: true, producedOutput: false, contractOk: false })).toBe('execute');
    expect(failureStageFor({ installOk: true, producedOutput: true, contractOk: false })).toBe('output_contract');
    expect(failureStageFor({ installOk: true, producedOutput: true, contractOk: true })).toBeUndefined();
  });

  it('报告卡明示支付模式与链上已验证状态 (M3 边界对用户可见)', () => {
    const c = buildReportCard({
      task: 't', conclusion: '适合', paid: true, executed: true, outputContract: '通过', resourceVerified: '通过', evidenceComplete: true,
      payment: { mode: 'local-dev', chainSettled: false, trust: 'self-attested' },
      evidenceRef: { goalId: 'g' },
    });
    const text = renderReportCard(c);
    expect(text).toContain('支付方式: 本机联调 (local-dev)');
    expect(text).toContain('链上已验证: 否');
    expect(text).toContain('不冒充链上结算');
  });

  it('已付款但未执行的证据判定 (非幂等保护用)', () => {
    expect(hasExecutionEvidence({ resourceOutcome: { executed: true } })).toBe(true);
    expect(hasExecutionEvidence({ execution: { ok: true } })).toBe(true);
    expect(hasExecutionEvidence({ resourceOutcome: { executed: false }, execution: { ok: false } })).toBe(false);
    expect(hasExecutionEvidence(null)).toBe(false);
  });

  it('补交付: 没有支付凭据时明确报"不能补", 不猜', async () => {
    const r = await refetchDeliveredContent({ url: 'http://127.0.0.1:1/x', receipt: '' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('没有支付凭据');
  });
});

describe('交付包安装: 越界路径必须拒绝', () => {
  it('正常包能落盘', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-install-'));
    const r = installBundle(JSON.stringify({ name: 's', files: { 'SKILL.md': 'x', 'src/run.mjs': 'y' } }), dir);
    expect(r.ok).toBe(true);
    expect(r.files).toBe(2);
    expect(fs.existsSync(path.join(dir, 'src', 'run.mjs'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('越界路径 (../ 或绝对路径) → 拒绝安装', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-install-bad-'));
    expect(installBundle(JSON.stringify({ files: { '../evil.sh': 'x' } }), dir).ok).toBe(false);
    expect(installBundle(JSON.stringify({ files: { '/tmp/evil.sh': 'x' } }), dir).ok).toBe(false);
    expect(installBundle('not json', dir).ok).toBe(false);
    expect(installBundle(JSON.stringify({ files: {} }), dir).ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
