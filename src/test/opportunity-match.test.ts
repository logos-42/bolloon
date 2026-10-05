/**
 * opportunity-match.test.ts — 意图 ↔ 机会 匹配引擎 (2026-10-05, Intent Network P0)
 *
 * 测: 透明打分 (tag×0.5 + kw×0.3 + budget×0.2 每个都有构成) · 机会源=本地 board ·
 * 无意图→无匹配 (不是错误) · minScore/limit 生效 · 预算适配。
 * 全部隔离 HOME (world/intents + tasks/board 都是隔离目录)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { setIntent } from '../agents/intent-store.js';
import { scanOpportunities } from '../agents/opportunity-match.js';
import { saveAnnouncement } from '../agents/task-board.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-opp-test-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');

function makeAnnouncement(capability: string, instruction: string, opts: { budget?: { maxAmount: string; currency: 'USDC' | 'ETH'; network: string } | null; deadline?: number; status?: string; buyerDid?: string } = {}) {
  const buyerDid = opts.buyerDid ?? 'did:key:z6Mkbuyer000000000000000000000000000000000000000';
  const announcementId = `ann-${crypto.randomBytes(8).toString('hex')}`;
  const instructionPreview = instruction.slice(0, 60);
  return {
    protocol: 'bolloon-task-board/1',
    kind: 'announcement',
    announcementId,
    capability,
    instructionDigest: crypto.createHash('sha256').update(instruction).digest('hex'),
    instructionPreview,
    buyerDid,
    buyerPublicKeyHex: 'a'.repeat(64),
    budget: opts.budget === undefined ? null : opts.budget,
    deadline: opts.deadline ?? Date.now() + 86400000,
    paymentMode: 'policy' as const,
    createdAt: Date.now(),
    instruction,
    status: (opts.status ?? 'open') as any,
    updatedAt: Date.now(),
    claims: [],
    signature: '',
  };
}

describe('opportunity-match (透明打分 · 源=本地 board)', () => {
  beforeEach(async () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(fakeHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function seedBoards(rows: Array<{ capability: string; instruction: string; status?: string }>) {
    for (const r of rows) {
      const a = makeAnnouncement(r.capability, r.instruction, { status: r.status });
      const saved = saveAnnouncement(a as any, fakeHome);
      if (!saved.ok) throw new Error(`seed 失败: ${saved.error}`);
    }
  }

  it('没有意图 → 无匹配, 不是错误', async () => {
    await seedBoards([{ capability: 'fusion-partner', instruction: '寻找磁约束合作' }]);
    const r = await scanOpportunities();
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(0);
  });

  it('意图匹配到同标签公告 → 卡片带透明 score 构成', async () => {
    await seedBoards([{ capability: 'fusion-partner', instruction: '寻找 magnetic control 磁约束 合作者' }]);
    await setIntent({ text: '建立聚变公司 找 fusion magnetic control 合作' });
    const r = await scanOpportunities();
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    const top = r.results[0];
    expect(top.source).toBe('local'); // BoardEntry.source: 'local' | 'registry'
    expect(top.breakdown).toHaveProperty('tagOverlap');
    expect(top.breakdown).toHaveProperty('keywordHit');
    expect(top.breakdown).toHaveProperty('budgetFit');
    expect(top.score).toBeGreaterThanOrEqual(0.4);
  });

  it('不匹配的公告不进候选 (关键词完全不同)', async () => {
    await seedBoards([{ capability: 'cooking-recipes', instruction: '家常菜谱大全' }]);
    await setIntent({ text: '建立聚变创业公司 fusion plasma' });
    const r = await scanOpportunities();
    expect(r.results).toHaveLength(0);
  });

  it('minScore 过滤: 高分才进', async () => {
    await seedBoards([{ capability: 'fusion-partner', instruction: 'fusion magnetic control 磁约束 合作', budget: { maxAmount: '100000', currency: 'USDC', network: 'base' } }]);
    await setIntent({ text: '建立聚变公司 fusion 合作', budget: '100000' });
    const all = await scanOpportunities({ minScore: 0 });
    const strict = await scanOpportunities({ minScore: 0.9 });
    expect(all.results.length).toBeGreaterThan(0);
    expect(strict.results.length).toBe(0); // 除非 score≥0.9, 否则空
  });

  it('预算是 TaskBudget 对象或 null 都处理 (不崩)', async () => {
    await seedBoards([
      { capability: 'with-budget', instruction: '给预算的任务 fusion' },
      { capability: 'no-budget', instruction: '无预算的任务 fusion' },
    ]);
    // 造带预算的公告
    const withB = makeAnnouncement('with-budget-2', 'another fusion task', { budget: { maxAmount: '50000', currency: 'USDC', network: 'base' } });
    saveAnnouncement(withB as any, fakeHome);
    await setIntent({ text: 'fusion 任务', budget: '100000' });
    const r = await scanOpportunities();
    expect(r.ok).toBe(true);
  });

  it('limit 截断候选数', async () => {
    for (let i = 0; i < 5; i++) {
      await seedBoards([{ capability: `fusion-task-${i}`, instruction: `fusion 匹配任务 ${i} magnetic control` }]);
    }
    await setIntent({ text: 'fusion magnetic control 任务' });
    const r = await scanOpportunities({ limit: 2 });
    expect(r.results.length).toBeLessThanOrEqual(2);
  });
});