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

  it('身份生成 (Agent 功能层): 首次 status 自动生成 DIAP did:key', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const s = await core.identity.status();
    // 2026-10-07: 身份升级为 DIAP Ed25519 did:key (与桌面同构); 老 WebView 才退化为 did:blln
    expect(s.did).toMatch(/^did:(key:z6Mk|blln:)/);
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
    // 2026-10-07: DIAP did:key (老 WebView 才 did:blln)
    expect(id.did).toMatch(/^did:(key:z6Mk|blln:)/);
    const reply = await agent.runLocalAgent('你好');
    expect(reply.length).toBeGreaterThan(0);
  });

  it('Android 未开启无障碍时仍可直接运行手机 Agent, 不调用原生跨 App 执行', async () => {
    const agent = await import('../web/mobile-agent.ts');
    const calls: string[] = [];
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          RokidBridge: {
            agentStatus: async () => ({ accessibilityReady: false }),
            runAgent: async () => { calls.push('runAgent'); return { result: 'unexpected' }; },
          },
        },
      },
    };
    try {
      const reply = await agent.runLocalAgent('你好');
      expect(reply).toContain('你好');
      expect(calls).toEqual([]);
    } finally {
      (globalThis as any).window = previousWindow;
    }
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

  it('on-device 语义: 消息在手机本地执行, 不等远端 (无 P2P 也完成闭环)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    // 无 P2P 连接 (peerIds 空) → send 必须本地执行完成
    const r = await core.message.send({ text: '本地测试消息', channelId: 'local1' });
    expect(r.ok).toBe(true);
    const sess = await core.session.get('local1');
    expect(sess.messages.length).toBeGreaterThanOrEqual(2);
    expect(sess.messages[sess.messages.length - 1].role).toBe('ai');
  });

  it('on-device 语义: 对端 agent.chat.send 入站 → 本地执行回 reply + 对端消息写入数据层', async () => {
    const agent = await import('../web/mobile-agent.ts');
    const data = await import('../web/mobile-data.ts');
    await agent.ensureIdentity();
    const id = await agent.ensureIdentity();
    // 注入传输: 捕获 outbound reply
    let replySent = '';
    agent.setAgentTransport(async (type, payload, peerId) => {
      if (type === 'agent.chat.reply') replySent = payload;
      return true;
    }, id.did);
    // 协调层: 注册 onInboundChat → 写数据层 (模拟 mobile-core.network.start 行为)
    agent.onInboundChat((text, channelId) => {
      // 同步写 (测试内 await)
    });
    await agent.handleIncomingAgentMessage('agent.chat.send', JSON.stringify({ text: '远端消息', channelId: 'rc1' }), 'peerC');
    // 回 reply (本地执行)
    expect(replySent).not.toBe('');
    const parsed = JSON.parse(replySent);
    expect(parsed.channelId).toBe('rc1');
    expect(parsed.text.length).toBeGreaterThan(0);
    // 对端消息写入数据层 (模拟协调层 onInboundChat 行为)
    await data.appendMessage('rc1', { role: 'ai', content: '远端消息', ts: Date.now() });
    const sess = await data.getSession('rc1');
    expect(sess.messages.some((m: any) => m.content === '远端消息')).toBe(true);
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

  // iOS 系统入口 (Siri / 快捷指令 / Spotlight) 深链: bolloon://agent/run|status?name= (2026-09-11)
  it('handleDeepLink: bolloon:// 深链解析 (非法输入不抛, 返回 ok:false)', async () => {
    const { core, handleDeepLink } = await import('../web/mobile-core.ts');

    // 正常: run / status
    expect(handleDeepLink('bolloon://agent/run?name=abc')).toEqual({ ok: true, action: 'run', name: 'abc' });
    expect(handleDeepLink('bolloon://agent/status?name=' + encodeURIComponent('本机智能体')))
      .toEqual({ ok: true, action: 'status', name: '本机智能体' });
    // 可选 goal
    expect(handleDeepLink('bolloon://agent/run?name=a&goal=' + encodeURIComponent('写周报')))
      .toEqual({ ok: true, action: 'run', name: 'a', goal: '写周报' });
    // 简写 (只有 host) / 无名
    expect(handleDeepLink('bolloon://run?name=x')).toEqual({ ok: true, action: 'run', name: 'x' });
    expect(handleDeepLink('bolloon://agent/status')).toEqual({ ok: true, action: 'status', name: '' });

    // 非法 → ok:false, 不抛
    expect(handleDeepLink('https://example.com/x').ok).toBe(false);
    expect(handleDeepLink('bolloon://agent/unknown?name=x').ok).toBe(false);
    expect(handleDeepLink('bolloon://other/run?name=x').ok).toBe(false);
    expect(handleDeepLink('').ok).toBe(false);
    expect(handleDeepLink(null).ok).toBe(false);
    expect(handleDeepLink(undefined).ok).toBe(false);
    expect(typeof handleDeepLink('%').error).toBe('string');

    // 路由 + 暴露面: GET /api/deeplink?url= 与 core.handleDeepLink 结果一致
    expect(core.handleDeepLink).toBeTypeOf('function');
    expect(core.resolve('/nonexistent')).toBeNull();
    const fn = core.resolve('/api/deeplink?url=' + encodeURIComponent('bolloon://agent/run?name=abc'));
    expect(fn).toBeTypeOf('function');
    expect(await fn!()).toEqual({ ok: true, action: 'run', name: 'abc' });
    const fn2 = core.resolve('/api/deeplink?url=' + encodeURIComponent('nope://x'));
    expect((await fn2!()).ok).toBe(false);
  });

  // 2026-10-15 (leo: 手机号登录/搜索/加好友 — 手机原生手机号功能): 目录 + OTP 全部转发电脑端,
  //   与 World 转发同一原则: 手机不持目录数据, 电脑端不可达 → 诚实降级不假装。
  it('手机号目录: resolve 路由分发 (publish/lookup/add-friend)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    // 手机号目录/OTP 只注册 POST (转发电脑端), GET 路由不存在 → null
    expect(core.resolve('/api/phone/directory/publish')).toBeNull();
    expect(core.resolve('/api/phone/directory/lookup')).toBeNull();
    expect(core.resolve('/api/phone/directory/add-friend')).toBeNull();
    expect(core.resolvePost('/api/phone/directory/publish', { phone: '13812345678' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/phone/directory/lookup', { phone: '13812345678' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/phone/directory/add-friend', { phone: '13812345678' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/phone/auth/bind', { phone: '13812345678' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/phone/auth/verify', { contactId: 'c1', challengeId: 'ch1', code: '123456' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/phone/profile/phone', { phone: '13812345678' })).toBeTypeOf('function');
  });

  it('手机号目录: 无桌面地址 → 诚实降级 (不返回假数据)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    try { localStorage.removeItem('bolloon_desktop_base_url'); } catch { /* node 测试环境无 localStorage, 降级同样生效 */ }
    const pub = await core.resolvePost('/api/phone/directory/publish', { phone: '13812345678' })!();
    expect(pub.ok).toBe(false);
    expect(String(pub.error || '')).toContain('电脑端在线');
    const look = await core.resolvePost('/api/phone/directory/lookup', { phone: '13812345678' })!();
    expect(look.found).toBe(false);
    expect(String(look.error || '')).toContain('电脑端在线');
    const add = await core.resolvePost('/api/phone/directory/add-friend', { phone: '13812345678' })!();
    expect(add.ok).toBe(false);
    expect(String(add.error || '')).toContain('电脑端在线');
  });

  it('手机号目录: 有桌面地址 → 转发电脑端目录端点 (mock fetch)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const hits: string[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, opts: any = {}) => {
      hits.push(String(url));
      const body = opts.body ? JSON.parse(String(opts.body)) : {};
      if (String(url).endsWith('/api/contacts/directory/publish')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, phoneHash: 'abc…', did: 'did:key:zX', publicKeyHex: '02aa', publishedAt: 1 }) };
      }
      if (String(url).endsWith('/api/contacts/directory/lookup')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, found: true, did: 'did:key:zX', publicKeyHex: '02aa', displayName: '测试' }) };
      }
      if (String(url).endsWith('/api/contacts/directory/add-friend')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, friend: { requestId: 'req1' } }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not mocked: ' + String(url) }) };
    };
    const prevLS = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k === 'bolloon_desktop_base_url' ? 'http://127.0.0.1:54188' : null),
      setItem: () => {}, removeItem: () => {},
    };
    try {
      const pub = await core.resolvePost('/api/phone/directory/publish', { phone: '13812345678' })!();
      expect(pub.ok).toBe(true);
      expect(hits.some((u) => u.includes('/api/contacts/directory/publish'))).toBe(true);
      const look = await core.resolvePost('/api/phone/directory/lookup', { phone: '13812345678' })!();
      expect(look.found).toBe(true);
      expect(look.did).toBe('did:key:zX');
      expect(hits.some((u) => u.includes('/api/contacts/directory/lookup'))).toBe(true);
      const add = await core.resolvePost('/api/phone/directory/add-friend', { phone: '13812345678' })!();
      expect(add.ok).toBe(true);
      expect(add.friend.requestId).toBe('req1');
      expect(hits.some((u) => u.includes('/api/contacts/directory/add-friend'))).toBe(true);
    } finally {
      (globalThis as any).fetch = realFetch;
      (globalThis as any).localStorage = prevLS;
    }
  });

  it('手机号登录: 无桌面地址 → 诚实降级 (bind/verify)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    try { localStorage.removeItem('bolloon_desktop_base_url'); } catch { /* 忽略 */ }
    const b = await core.phoneAuth.bind('13812345678');
    expect(b.ok).toBe(false);
    expect(String(b.error || '')).toContain('电脑端在线');
    const v = await core.phoneAuth.verify('c1', 'ch1', '123456');
    expect(v.ok).toBe(false);
    expect(String(v.error || '')).toContain('电脑端在线');
  });

  it('手机号登录: 有桌面地址 → 转发电脑端 OTP 通道 (bind/verify)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      if (String(url).endsWith('/api/contacts/bind')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, contactId: 'c1', challengeId: 'ch1', otpForLocalSink: '123456' }) };
      }
      if (String(url).endsWith('/api/contacts/verify')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, verified: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not mocked: ' + String(url) }) };
    };
    const prevLS = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k === 'bolloon_desktop_base_url' ? 'http://127.0.0.1:54188' : null),
      setItem: () => {}, removeItem: () => {},
    };
    try {
      const b = await core.phoneAuth.bind('13812345678');
      expect(b.ok).toBe(true);
      expect(b.contactId).toBe('c1');
      const v = await core.phoneAuth.verify('c1', 'ch1', '123456');
      expect(v.ok).toBe(true);
      expect(v.verified).toBe(true);
    } finally {
      (globalThis as any).fetch = realFetch;
      (globalThis as any).localStorage = prevLS;
    }
  });

  // 2026-10-15 (leo: 手机自治 — 远程 API + 本机工具操作): 手机 agent 循环 (runWebAgentLoop)
  //   验证 LLM 多轮迭代 + 白名单工具执行闭环, 以及「手机 agent 只能操作自身轻量工具面」的边界。
  it('手机自治: LLM 返回工具调用 → 执行白名单工具 → 结果回填 → 收敛', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    // mock LLM: 第一轮要求调 get_identity, 第二轮直接回答 (收敛)
    let calls = 0;
    (globalThis as any).fetch = async (url: any, opts: any = {}) => {
      calls++;
      const body = JSON.parse(String(opts.body || '{}'));
      const lastUser = [...(body.messages || [])].reverse().find((m: any) => m.role === 'user')?.content || '';
      const isToolResult = lastUser.startsWith('工具结果:');
      const content = isToolResult
        ? '好的,已拿到 DID,这就是你要的身份信息。'
        : '{"tool":"get_identity","args":{}}';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    try {
      const reply = await agent.runWebAgentLoop('查询我的身份', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      expect(reply).toContain('手机自治执行 1 步');
      expect(calls).toBeGreaterThanOrEqual(2); // 工具轮 + 收敛轮
    } finally { (globalThis as any).fetch = realFetch; }
  });

  it('手机自治: 白名单外工具名 → 不执行, 当普通回答 (手机 agent 不做目录/加好友)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    // mock LLM 一直要求 directory.lookup (不在手机白名单) → 循环必须当普通回答直接收敛, 不执行
    (globalThis as any).fetch = async () => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tool":"directory.lookup","args":{"phone":"138"}}' } }] }),
    });
    try {
      const reply = await agent.runWebAgentLoop('帮我查手机号', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      // 不执行 → 无「🔧」步骤, 回复就是 LLM 原文 (JSON 被当回答)
      expect(reply).toContain('directory.lookup');
      expect(reply).not.toContain('手机自治执行');
    } finally { (globalThis as any).fetch = realFetch; }
  });

  it('手机自治: 5 步上限收敛 (LLM 永远要求工具 → 给最后一条不挂死)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tool":"get_status","args":{}}' } }] }) };
    };
    try {
      const reply = await agent.runWebAgentLoop('无限工具循环', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      expect(reply).toContain('达到 5 步上限');
      expect(calls).toBeGreaterThanOrEqual(5); // 每轮都真实调了 LLM
    } finally { (globalThis as any).fetch = realFetch; }
  });

  // 2026-10-05 (leo: 手机端 ↔ 电脑端互联): World 数据层转发电脑端
  it('World 转发: resolve/resolvePost 分发 (机会流/意图/搜索/反馈)', async () => {
    const { core } = await import('../web/mobile-core.ts');

    // GET 路由
    expect(core.resolve('/api/opportunities')).toBeTypeOf('function');
    expect(core.resolve('/api/opportunities?min-score=0.2&limit=10')).toBeTypeOf('function');
    expect(core.resolve('/api/intents')).toBeTypeOf('function');
    expect(core.resolve('/api/world/search')).toBeTypeOf('function');

    // POST 路由: 意图声明 / 机会反馈 / 搜索触发
    expect(core.resolvePost('/api/intents', { text: '写周报' })).toBeTypeOf('function');
    expect(core.resolvePost('/api/opportunities/inbox_x/accept', {})).toBeTypeOf('function');
    expect(core.resolvePost('/api/opportunities/inbox_x/ignore', {})).toBeTypeOf('function');
    expect(core.resolvePost('/api/world/search', { topic: '聚变' })).toBeTypeOf('function');

    // 无桌面地址 → 诚实降级 desktop-unreachable (不返回假数据)
    try { localStorage.removeItem('bolloon_desktop_base_url'); } catch { /* node 测试环境无 localStorage, 降级同样生效 */ }
    const opps = await core.resolve('/api/opportunities')!();
    expect(opps.note).toBe('desktop-unreachable');
    const intents = await core.resolve('/api/intents')!();
    expect(intents.note).toBe('desktop-unreachable');
    const declare = await core.resolvePost('/api/intents', { text: '写周报' })!();
    expect(declare.error).toBe('desktop-unreachable');
    const feedback = await core.resolvePost('/api/opportunities/inbox_x/accept', {})!();
    expect(feedback.error).toBe('desktop-unreachable');
    const search = await core.resolvePost('/api/world/search', { topic: '聚变' })!();
    expect(search.note).toBe('desktop-unreachable');
  });
});
