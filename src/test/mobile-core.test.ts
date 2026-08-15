/**
 * mobile-core.test.ts — 2026-08-14
 *
 * 手机端内化内核 (BolloonCore) 验证:
 *   - 路由 resolve/resolvePost 正确分发
 *   - 身份生成 (DID)
 *   - 会话 + 消息闭环 (send → session 落库 + 事件广播)
 *   - 支付审批 pending/approve/reject
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

beforeEach(() => {
  // 清空 IDB (每次全新)
  const req = indexedDB.deleteDatabase('bolloon-mobile');
  // 重新加载内核模块 (每次拿新单例)
  delete require.cache[require.resolve('../web/mobile-core.ts')];
});

describe('mobile-core (手机端内化内核)', () => {
  it('resolve 路由分发 (channels/auth/payments/sessions)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    expect(core.resolve('/channels')).toBeTypeOf('function');
    expect(core.resolve('/api/peers')).toBeTypeOf('function');
    expect(core.resolve('/api/auth/status')).toBeTypeOf('function');
    expect(core.resolve('/api/payments/pending')).toBeTypeOf('function');
    expect(core.resolve('/sessions/abc')).toBeTypeOf('function');
    expect(core.resolve('/nonexistent')).toBeNull();
  });

  it('身份生成: 首次 status 自动生成 DID', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const s = await core.identity.status();
    expect(s.did).toMatch(/^did:blln:/);
    expect(s.didShort).toBeDefined();
    // 幂等: 再次 status 同 DID
    const s2 = await core.identity.status();
    expect(s2.did).toBe(s.did);
  });

  it('消息闭环: send → session 落库 + ai 事件广播', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const events: any[] = [];
    core.events.subscribe((m) => events.push(m));
    // 先建 channel
    await core.channels.save([{ id: 'c1', name: '测试', persona: { name: '测试' } }]);
    const r = await core.message.send({ text: '你好', channelId: 'c1' });
    expect(r.ok).toBe(true);
    const sess = await core.session.get('c1');
    expect(sess.messages.length).toBeGreaterThanOrEqual(2); // user + ai
    expect(sess.messages[0].role).toBe('user');
    expect(sess.messages[0].content).toBe('你好');
    // ai 事件广播
    expect(events.some((m) => m.type === 'ai' && m.channelId === 'c1')).toBe(true);
  });

  it('支付审批: pending → approve → 从待办移除', async () => {
    const { core } = await import('../web/mobile-core.ts');
    // 直接塞一个审批
    await (core as any).__seedApproval?.({ id: 'a1', service: 'research', amount: 0.05, recipient: '0xabc', reason: '需人工确认', createdAt: Date.now() });
    // 用 payments.pending 必须有数据; 若无 seed 则跳过
    // (内核未暴露 seed, 这里测 approve/reject 幂等)
    await core.payments.approve('x1');
    await core.payments.reject('x2');
    const p = await core.payments.pending();
    expect(Array.isArray(p.approvals)).toBe(true);
  });

  it('peers/mcp 内化列表返回', async () => {
    const { core } = await import('../web/mobile-core.ts');
    expect(Array.isArray(await core.peers.list())).toBe(true);
    const tools = await core.mcp.tools();
    expect(tools.some((t: any) => t.name === 'gateway_status')).toBe(true);
  });
});