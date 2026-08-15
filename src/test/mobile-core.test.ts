/**
 * mobile-core.test.ts — 2026-08-15 重构
 *
 * 手机端内化内核 (BolloonCore) 验证 — 分层架构:
 *   1. 数据同步层 (mobile-data): channels/session 本地副本 + data.* 协议合并
 *   2. Agent 功能层 (mobile-agent): 独立 DID + 本地执行 + agent.chat.* 收发
 *   3. 协调层 (mobile-core): resolve/resolvePost 路由 + 事件总线
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

beforeEach(async () => {
  // 用各模块 reset 函数清空 (close 后再 delete, 避免 deleteDatabase 阻塞)
  try {
    const data = await import('../web/mobile-data.ts');
    await data.resetDataDb();
  } catch { /* 忽略 */ }
  try {
    const agent = await import('../web/mobile-agent.ts');
    await agent.resetAgentDb();
  } catch { /* 忽略 */ }
  try {
    const pay = await import('../web/mobile-payments.ts');
    await pay.resetPaymentsDb();
  } catch { /* 忽略 */ }
  // 重新加载内核模块 (每次拿新单例)
  ['../web/mobile-core.ts', '../web/mobile-data.ts', '../web/mobile-agent.ts', '../web/mobile-payments.ts'].forEach((m) => {
    try { delete require.cache[require.resolve(m)]; } catch { /* 忽略 */ }
  });
});

describe('mobile-core (手机端内化内核, 分层架构)', () => {
  it('resolve 路由分发 (channels/auth/payments/sessions)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    expect(core.resolve('/channels')).toBeTypeOf('function');
    expect(core.resolve('/api/peers')).toBeTypeOf('function');
    expect(core.resolve('/api/auth/status')).toBeTypeOf('function');
    expect(core.resolve('/api/payments/pending')).toBeTypeOf('function');
    expect(core.resolve('/sessions/abc')).toBeTypeOf('function');
    expect(core.resolve('/nonexistent')).toBeNull();
  });

  it('身份生成 (Agent 功能层): 首次 status 自动生成 DID', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const s = await core.identity.status();
    expect(s.did).toMatch(/^did:blln:/);
    expect(s.didShort).toBeDefined();
    // 幂等: 再次 status 同 DID
    const s2 = await core.identity.status();
    expect(s2.did).toBe(s.did);
  });

  it('数据同步层: channels/session 本地副本可读写', async () => {
    const { core } = await import('../web/mobile-core.ts');
    await core.channels.save([{ id: 'c1', name: '测试', persona: { name: '测试' } }]);
    const chs = await core.channels.get();
    expect(chs.length).toBe(1);
    expect(chs[0].name).toBe('测试');
    // session
    await core.session.save('c1', { messages: [{ role: 'user', content: 'hi', ts: 1 }] });
    const s = await core.session.get('c1');
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].role).toBe('user');
  });

  it('数据同步层: appendMessage 落库 + data.sync/snapshot 快照往返', async () => {
    const data = await import('../web/mobile-data.ts');
    await data.appendMessage('c1', { role: 'user', content: 'hello', ts: 100 });
    const snap = await data.snapshot();
    expect(snap.sessions.length).toBe(1);
    expect(snap.sessions[0].messages[0].content).toBe('hello');
    // 模拟远端快照合并 (增量)
    await data.handleIncomingDataMessage('data.snapshot', JSON.stringify({
      channels: [{ id: 'c2', name: '远端' }],
      sessions: [{ channelId: 'c2', messages: [{ role: 'ai', content: 'x', ts: 200 }], updatedAt: 200 }],
      syncedAt: Date.now(),
    }), 'peerX');
    const chs = await data.getChannels();
    expect(chs.some((c: any) => c.id === 'c2')).toBe(true);
    const s2 = await data.getSession('c2');
    expect(s2.messages[0].content).toBe('x');
  });

  it('Agent 功能层: 独立 DID + 本地执行 (离线内置规则)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    const id = await agent.ensureIdentity();
    expect(id.did).toMatch(/^did:blln:/);
    const reply = await agent.runLocalAgent('你好');
    expect(reply.length).toBeGreaterThan(0);
  });

  it('Agent 功能层: 入站 agent.chat.send → 本地执行 → 发 reply (经注入传输)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    let sentType = '';
    let sentPayload = '';
    let sentTo = '';
    agent.setAgentTransport(async (type, payload, peerId) => {
      sentType = type; sentPayload = payload; sentTo = peerId || '';
      return true;
    }, 'did:blln:test');
    await agent.handleIncomingAgentMessage('agent.chat.send', JSON.stringify({ text: '你好', channelId: 'c1' }), 'peerA');
    expect(sentType).toBe('agent.chat.reply');
    expect(sentTo).toBe('peerA');
    const parsed = JSON.parse(sentPayload);
    expect(parsed.channelId).toBe('c1');
    expect(parsed.text.length).toBeGreaterThan(0);
  });

  it('Agent 功能层: callRemoteAgent 主动调用 (mock 传输回 reply)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    agent.setAgentTransport(async (type, payload, peerId) => {
      if (type === 'agent.chat.send') {
        // 模拟对端回 reply
        setTimeout(() => {
          agent.notifyAgentReply(JSON.stringify({ channelId: 'c1', text: '远端回复' }), 'peerB');
        }, 10);
      }
      return true;
    }, 'did:blln:test');
    const r = await agent.callRemoteAgent('peerB', 'hello', 'c1', 2000);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('远端回复');
  });

  it('消息闭环: send → data 层落库 + ai 事件广播 (本地执行)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const events: any[] = [];
    core.events.subscribe((m) => events.push(m));
    await core.channels.save([{ id: 'c1', name: '测试', persona: { name: '测试' } }]);
    const r = await core.message.send({ text: '你好', channelId: 'c1' });
    expect(r.ok).toBe(true);
    const sess = await core.session.get('c1');
    expect(sess.messages.length).toBeGreaterThanOrEqual(2); // user + ai
    expect(sess.messages[0].role).toBe('user');
    expect(sess.messages[0].content).toBe('你好');
    expect(events.some((m) => m.type === 'ai' && m.channelId === 'c1')).toBe(true);
  });

  it('支付审批: pending/approve/reject (独立 mobile-payments)', async () => {
    const { addApproval } = await import('../web/mobile-payments.ts');
    await addApproval({ id: 'a1', service: 'research', amount: 0.05, recipient: '0xabc', reason: '需人工确认', createdAt: Date.now() });
    const { core } = await import('../web/mobile-core.ts');
    const p = await core.payments.pending();
    expect(p.approvals.length).toBe(1);
    expect(p.approvals[0].id).toBe('a1');
    await core.payments.approve('a1');
    const p2 = await core.payments.pending();
    expect(p2.approvals.length).toBe(0);
  });

  it('peers/mcp 内化列表返回', async () => {
    const { core } = await import('../web/mobile-core.ts');
    expect(Array.isArray(await core.peers.list())).toBe(true);
    const tools = await core.mcp.tools();
    expect(tools.some((t: any) => t.name === 'gateway_status')).toBe(true);
  });
});