/**
 * goal-flywheel P6 · ⑤ 外部事件**去重表命中条件** (只读验证, 不改 `external-events.ts`) — 2026-09-26
 *
 * 归属: `docs/wiki/goal-flywheel-p5-acceptance.md` §5 最后一条未验证项 (原话: 「重复投递的返回是
 * `no_match` (等待已被清), 不是 `duplicate` —— 行为已钉住, 但**去重表到底在什么条件下才会命中**未验证」)。
 *
 * 本文件**只调用** `external-events.ts` 的既有 API (bindExternalWait / deliverExternalEvent)
 * + 真 goal-store, 不改它一个字节; 目的是把"命中条件"写成可重跑的断言。
 *
 * 结论 (由下面用例逐条给出, 每条都有真实返回):
 *   ① **投递成功就清掉等待事实** ⇒ 紧接着重投同一个 eventId 得到 `no_match`, **不是** `duplicate`
 *      (P5 的观察复现了); 这就是"去重表看起来从不命中"的原因;
 *   ② **命中条件**: Goal **再次绑定了等待** (同一 requestId/continuationId/expectedSource),
 *      且该等待**未过期** ⇒ 同一个 eventId 再投 → `duplicate` (且不再写证据、不清等待);
 *   ③ 顺序: **过期判定在去重之前** ⇒ 等待已过期时同名 eventId 得到 `expired`, 不是 `duplicate`;
 *   ④ 去重表是 continuation 上的 **有界 20 条滑动窗口** (`slice(-20)`): 第 21 个之后的旧 eventId
 *      会**掉出窗口而被再次接受** —— 所以它是"近期去重", 不是永久去重表;
 *   ⑤ 不匹配的投递 (来源/关联/缺 eventId/没有 Goal 在等) 一律**不写**去重表 (只返回原因)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `p6-ev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
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
    ev: await import('../agents/external-events.js'),
  };
}

/** 真盘上的等待事实 (绑定/重绑定都走真 API) */
async function bindWait(m: Awaited<ReturnType<typeof mods>>, goalId: string, o: {
  requestId: string; continuationId: string; expiresAt: string; expectedEvent?: string;
}) {
  await m.ev.bindExternalWait(goalId, {
    requestId: o.requestId, continuationId: o.continuationId, expectedSource: 'delegate',
    expectedEvent: o.expectedEvent, createdAt: iso(Date.now()),
    expiresAt: o.expiresAt, note: '等一个 delegate 回包',
  });
}

async function deliveredIds(m: Awaited<ReturnType<typeof mods>>, goalId: string): Promise<string[]> {
  const g = await m.gs.readGoal(goalId);
  return g?.continuation?.deliveredEventIds ?? [];
}

const EVENT = (o: { eventId: string; requestId: string; continuationId: string; eventName?: string; source?: any }) => ({
  source: o.source ?? 'delegate' as const,
  eventId: o.eventId,
  requestId: o.requestId,
  continuationId: o.continuationId,
  eventName: o.eventName,
});

// ═════════════════════════════════════════════════════════════════════════════
describe('P6-⑤ 外部事件去重: 命中条件 / 不命中条件 / 与过期判定的先后 / 20 条窗口', () => {
  it('(1) 命中条件: "投递成功就清等待" ⇒ 立即重投是 no_match; 只有**重新绑定等待**后同 eventId 才是 duplicate', async () => {
    const m = await mods();
    const T0 = Date.now();
    const g = await m.gs.createGoal({ objective: '等 delegate 回包', successCriteria: ['判据0'], createdBy: 'p6' });
    const R1 = 'req-dup-1';
    const C1 = 'cont-dup-1';
    await bindWait(m, g.goalId, { requestId: R1, continuationId: C1, expiresAt: iso(T0 + 30 * 60_000) });

    // ① 首次投递: delivered, 事件事实 + 去重表都写进 continuation
    const first = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-dup', requestId: R1, continuationId: C1, eventName: 'result' }));
    expect(first.ok).toBe(true);
    expect(first.reason).toBe('delivered');
    expect(first.goalId).toBe(g.goalId);
    expect(await deliveredIds(m, g.goalId)).toEqual(['ev-dup']);
    const evidenceAfterFirst = ((await m.gs.readGoal(g.goalId))?.evidence ?? []).length;
    expect((await m.gs.readGoal(g.goalId))!.continuation!.external).toBeUndefined();   // 等待事实被清 ⇒ 这是关键

    // ② 紧接着重投同一 eventId → 没有候选 (等待已被清) ⇒ no_match, **不是 duplicate**
    const again = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-dup', requestId: R1, continuationId: C1, eventName: 'result' }));
    expect(again.reason).toBe('no_match');
    expect(again.ok).toBe(false);

    // ③ 命中条件: **重新绑定**同一 requestId/continuationId/source (未过期) → 同一个 eventId → duplicate
    await bindWait(m, g.goalId, { requestId: R1, continuationId: C1, expiresAt: iso(Date.now() + 30 * 60_000) });
    const dup = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-dup', requestId: R1, continuationId: C1, eventName: 'result' }));
    expect(dup.reason).toBe('duplicate');
    expect(dup.ok).toBe(false);
    expect(String(dup.detail)).toContain('ev-dup');
    expect(dup.goalId).toBe(g.goalId);
    // 被去重挡下的投递: 不写证据、不清等待 (事实没被动过)
    expect(((await m.gs.readGoal(g.goalId))?.evidence ?? []).length).toBe(evidenceAfterFirst);
    expect((await m.gs.readGoal(g.goalId))!.continuation!.external).toBeTruthy();
    expect(await deliveredIds(m, g.goalId)).toEqual(['ev-dup']);

    // ④ 换一个 eventId (同一份等待) → 真投递 (去重不过度)
    const other = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-dup-2', requestId: R1, continuationId: C1, eventName: 'result' }));
    expect(other.reason).toBe('delivered');
    expect(await deliveredIds(m, g.goalId)).toEqual(['ev-dup', 'ev-dup-2']);
  });

  it('(2) 不命中: 过期判定在去重**之前**; 关联/来源/缺 id 一律不写去重表', async () => {
    const m = await mods();
    const T0 = Date.now();
    const g = await m.gs.createGoal({ objective: '边界用例', successCriteria: ['判据0'], createdBy: 'p6' });
    const R = 'req-neg', C = 'cont-neg';

    // ① 等待已过期 + 同名 eventId (去重表里其实有它) → expired, 不是 duplicate
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(T0 + 60_000) });
    const ok1 = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-neg', requestId: R, continuationId: C, eventName: 'result' }), { now: () => T0 });
    expect(ok1.reason).toBe('delivered');
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(T0 - 1000) });      // 已过期
    const exp = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-neg', requestId: R, continuationId: C, eventName: 'result' }));
    expect(exp.reason).toBe('expired');
    expect(await deliveredIds(m, g.goalId)).toEqual(['ev-neg']);                                     // 去重表没变

    // ② 来源不匹配 → source_mismatch
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(Date.now() + 60_000) });
    const src = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-x', requestId: R, continuationId: C, source: 'p2p' }));
    expect(src.reason).toBe('source_mismatch');
    // ③ requestId 不匹配 → correlation_mismatch
    const corr = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-x', requestId: '别的请求', continuationId: C }));
    expect(corr.reason).toBe('correlation_mismatch');
    // ④ 事件名不匹配 (等待指定了 expectedEvent) → event_mismatch
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(Date.now() + 60_000), expectedEvent: 'final' });
    const name = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-x', requestId: R, continuationId: C, eventName: 'screen' }));
    expect(name.reason).toBe('event_mismatch');
    // ⑤ 缺 eventId → 直接拒 (无法去重)
    const noId = await m.ev.deliverExternalEvent({ ...EVENT({ eventId: '', requestId: R, continuationId: C }), eventId: '' } as any);
    expect(noId.reason).toBe('correlation_mismatch');
    expect(String(noId.detail)).toMatch(/eventId/);
    // 以上四条都不许动去重表
    expect(await deliveredIds(m, g.goalId)).toEqual(['ev-neg']);

    // ⑥ 没有任何 Goal 在等 (无 goalId 且全部等待已清) → no_match
    await m.ev.clearExternalWait(g.goalId);
    const noOne = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-y', requestId: R, continuationId: C }));
    expect(noOne.reason).toBe('no_match');

    // ⑦ 指定了 goalId 但那个 Goal 没在等 → 也 no_match (不猜)
    const explicit = await m.ev.deliverExternalEvent({ ...EVENT({ eventId: 'ev-z', requestId: R, continuationId: C }), goalId: g.goalId } as any);
    expect(explicit.reason).toBe('no_match');
  });

  it('(3) 去重表是**有界 20 条滑动窗口** (不是永久): 第 21 个之后的旧 eventId 会被再次接受', async () => {
    const m = await mods();
    const g = await m.gs.createGoal({ objective: '窗口边界', successCriteria: ['判据0'], createdBy: 'p6' });
    const R = 'req-win', C = 'cont-win';

    for (let i = 1; i <= 21; i++) {
      await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(Date.now() + 60_000) });
      const r = await m.ev.deliverExternalEvent(EVENT({ eventId: `ev-${i}`, requestId: R, continuationId: C, eventName: 'result' }));
      expect(r.reason, `第 ${i} 次投递应当 delivered`).toBe('delivered');
    }
    const ids = await deliveredIds(m, g.goalId);
    expect(ids.length).toBe(20);                       // slice(-20): 有界
    expect(ids).toContain('ev-21');
    expect(ids).not.toContain('ev-1');                 // 最早的掉出窗口

    // 掉出窗口的 ev-1 再投一次 (重新绑定等待) → **被再次接受** (dedupe 命中不了)
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(Date.now() + 60_000) });
    const replay = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-1', requestId: R, continuationId: C, eventName: 'result' }));
    expect(replay.reason).toBe('delivered');
    // 窗口内仍有的 ev-20 → duplicate (对照: 窗口内的照样挡得住)
    await bindWait(m, g.goalId, { requestId: R, continuationId: C, expiresAt: iso(Date.now() + 60_000) });
    const inside = await m.ev.deliverExternalEvent(EVENT({ eventId: 'ev-20', requestId: R, continuationId: C, eventName: 'result' }));
    expect(inside.reason).toBe('duplicate');
    const after = await deliveredIds(m, g.goalId);
    expect(after.length).toBe(20);
    expect(after[after.length - 1]).toBe('ev-1');
  });
});
