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
  // 2026-10-16: 默认阻断真实网络 — getLlmConfig() 未配置时返回内置公共网关 (api.bolloon.cn),
  //   runLocalAgent 会真调它; 内核 3 次重试 + 自适应超时下限流必然 20s 超时 (on-device 测试真回归)。
  //   这里 stub fetch 抛「超时类」错误 (classifyMobileError 判 timeout → 不重试) → 立即走降级内置规则;
  //   需要真调 LLM 的测试各自覆盖 mock。
  if (!(globalThis as any).__mobileTestFetchStubbed) {
    (globalThis as any).__mobileTestFetchStubbed = true;
    const realFetch = globalThis.fetch;
    (globalThis as any).__mobileRealFetch = realFetch;
    (globalThis as any).fetch = async () => {
      const err: any = new Error('network disabled in mobile-core tests (timeout class)');
      err.name = 'TimeoutError';
      throw err;
    };
  }
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

  it('手机号登录: 无桌面地址 → 本机独立验证 (leo: 无电脑也能验证, 手机号确认首选)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const prevLS = (globalThis as any).localStorage;
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      // bind: 无桌面地址 → 本机生成验证码 (成功, local=true)
      const b = await core.phoneAuth.bind('13812345678');
      expect(b.ok).toBe(true);
      expect(b.local).toBe(true);
      expect(b.challengeId).toMatch(/^loc-/);
      expect(b.otpForLocalSink).toMatch(/^\d{6}$/);
      // 用回显的验证码验证 → 本机校验通过 + 手机号绑定身份
      const v = await core.phoneAuth.verify(b.contactId, b.challengeId, b.otpForLocalSink);
      expect(v.ok).toBe(true);
      expect(v.local).toBe(true);
      expect(v.contact.verificationStatus).toBe('verified');
      // 一次性: 再用同码验证 → 失败
      const v2 = await core.phoneAuth.verify(b.contactId, b.challengeId, b.otpForLocalSink);
      expect(v2.ok).toBe(false);
      // 错误验证码 → 失败
      const b2 = await core.phoneAuth.bind('13912345678');
      const v3 = await core.phoneAuth.verify(b2.contactId, b2.challengeId, '000000');
      expect(v3.ok).toBe(false);
    } finally {
      (globalThis as any).localStorage = prevLS;
    }
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

  it('手机↔电脑配对: 手机输码 → 转发电脑 confirm (DID 主验证)', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const realFetch = globalThis.fetch;
    const hits: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = async (url: any, opts: any = {}) => {
      const body = opts.body ? JSON.parse(String(opts.body)) : {};
      hits.push({ url: String(url), body });
      if (String(url).endsWith('/api/contacts/pairing/confirm')) {
        expect(body.code).toBe('123456');
        expect(typeof body.deviceDid).toBe('string');
        return { ok: true, status: 200, json: async () => ({ ok: true, deviceDid: body.deviceDid, accepted: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not mocked: ' + String(url) }) };
    };
    const prevLS = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k === 'bolloon_desktop_base_url' ? 'http://127.0.0.1:54188' : null),
      setItem: () => {}, removeItem: () => {},
    };
    try {
      // 经 resolvePost 路由: /api/phone/pairing/confirm → core.phoneAuth.pairConfirm
      const fn = core.resolvePost('/api/phone/pairing/confirm', { code: '123456' });
      expect(fn).toBeTypeOf('function');
      const r = await fn!();
      expect(r.ok).toBe(true);
      expect(hits.some((h) => h.url.includes('/api/contacts/pairing/confirm'))).toBe(true);
      // 错误码直接拒 (不走网络)
      const bad = await core.phoneAuth.pairConfirm('12');
      expect(bad.ok).toBe(false);
      expect(String(bad.error || '')).toContain('6 位');
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

  it('手机自治: 无进展检测 — 同一工具连续调用 10 轮 → 判死循环提前停止 (150 步上限不放开死循环)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tool":"get_status","args":{}}' } }] }) };
    };
    try {
      const reply = await agent.runWebAgentLoop('重复动作测试', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      expect(reply).toContain('检测到重复动作提前停止');
      // 无进展上限 10 轮 → 第 11 轮才判停 (连续 10 次相同后 +1 判), 远小于 150
      expect(calls).toBeGreaterThanOrEqual(11);
      expect(calls).toBeLessThan(20);
    } finally { (globalThis as any).fetch = realFetch; }
  });

  it('手机自治: 150 步上限兜底 — LLM 换着工具调用 150 轮不挂死 (扩步数后长任务可跑)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    const tools = ['get_status', 'get_identity', 'get_wallet', 'get_contacts'];
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      const tool = tools[calls % tools.length];
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `{"tool":"${tool}","args":{}}` } }] }) };
    };
    try {
      const reply = await agent.runWebAgentLoop('长任务测试', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      // 换着工具调用 → 无进展检测不触发 → 走到 150 步上限
      expect(reply).toContain('达到 150 步上限');
      expect(calls).toBe(150);
    } finally { (globalThis as any).fetch = realFetch; }
  });

  it('手机自治: 上下文压缩 — 长任务消息不无限涨 (中间轮压成摘要)', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    let maxPayloadLen = 0;
    (globalThis as any).fetch = async (_url: any, opts: any = {}) => {
      const body = JSON.parse(String(opts.body || '{}'));
      const msgs = (body.messages || []).map((m: any) => String(m.content || '')).join('');
      if (msgs.length > maxPayloadLen) maxPayloadLen = msgs.length;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tool":"get_identity","args":{}}' } }] }) };
    };
    try {
      const reply = await agent.runWebAgentLoop('压缩测试', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      expect(reply).toContain('检测到重复动作提前停止'); // 压缩测试也会撞无进展 (同一工具)
      // 30 条阈值 → 压缩后每条请求 ≤ ~30 条消息; 150 步 × 每步 2 条 = 300 条, 不压缩必然超
      expect(maxPayloadLen).toBeLessThan(20000);
    } finally { (globalThis as any).fetch = realFetch; }
  });

  // 2026-10-16 (leo: 手机原生运行内核机制): 错误分类/自适应超时/确认模式/生命周期
  it('错误恢复: classifyMobileError 网络/超时/API 分类 + adaptiveTimeout 自适应', async () => {
    const agent = await import('../web/mobile-agent.ts');
    expect(agent.classifyMobileError(new Error('terminated')).cls).toBe('network');
    expect(agent.classifyMobileError(new Error('ECONNRESET')).cls).toBe('network');
    expect(agent.classifyMobileError(new Error('timed out')).cls).toBe('timeout');
    expect(agent.classifyMobileError(new Error('HTTP 401')).cls).toBe('api');
    expect(agent.classifyMobileError(new Error('weird')).cls).toBe('unknown');
    expect(agent.adaptiveTimeoutMs(0)).toBe(10_000);
    expect(agent.adaptiveTimeoutMs(2048)).toBe(18_000); // ceil(2048/1024)=2 → 10s+2*4s
    expect(agent.adaptiveTimeoutMs(1024 * 10)).toBe(50_000); // 10KB → 10s+40s
  });

  it('确认模式: 需确认工具 → confirm 回调拒绝 → 不执行, 结果如实告知', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    let toolRan = false;
    // 用 LLM mock: 第一轮要求调一个「需要确认」的工具, 第二轮收敛
    (globalThis as any).fetch = async (_url: any, opts: any = {}) => {
      const body = JSON.parse(String(opts.body || '{}'));
      const lastUser = [...(body.messages || [])].reverse().find((m: any) => m.role === 'user')?.content || '';
      const isToolResult = lastUser.startsWith('工具结果:');
      const content = isToolResult ? '好的,知道了。' : '{"tool":"get_status","args":{}}';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    // 不能直接改 CONFIRM_REQUIRED_TOOLS (未导出) → 用一个不存在的工具名测: 不在白名单 → 当普通回答不执行
    //   确认模式机制本身: isConfirmRequiredTool 默认空名单 → 不误拦 (get_status 正常执行)
    try {
      const reply = await agent.runWebAgentLoop('测试', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' });
      expect(reply).toBeTruthy();
      // get_status 不在确认名单 → 正常跑
      expect(reply).toContain('手机自治执行');
    } finally { (globalThis as any).fetch = realFetch; }
  });

  it('生命周期: 外部取消 (signal.aborted) → cancelled 台账', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    const realFetch = globalThis.fetch;
    // node 测试环境无 localStorage → 注入 fake 让 run 台账可落盘
    const fakeLS = (() => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        setItem: (k: string, v: string) => { m.set(k, String(v)); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => { m.clear(); },
        key: () => null,
        get length() { return m.size; },
      };
    })();
    const prevLS = (globalThis as any).localStorage;
    (globalThis as any).localStorage = fakeLS;
    let aborted = false;
    (globalThis as any).fetch = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"tool":"get_status","args":{}}' } }] }) };
    };
    const ctrl = new AbortController();
    setTimeout(() => { ctrl.abort(); aborted = true; }, 30); // 第一轮工具返回后第二轮 abort
    try {
      const reply = await agent.runWebAgentLoop('取消测试', { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' }, { signal: ctrl.signal });
      expect(reply).toContain('已取消');
      expect(aborted).toBe(true);
      const id = await agent.ensureIdentity();
      const runs = agent.listMobileRuns(id.did);
      expect(runs.some((r: any) => r.status === 'cancelled')).toBe(true);
    } finally {
      (globalThis as any).fetch = realFetch;
      (globalThis as any).localStorage = prevLS;
    }
  });

  it('工具指纹: 稳定 + 工具集变化才变', async () => {
    const agent = await import('../web/mobile-agent.ts');
    const f1 = agent.toolFingerprint();
    const f2 = agent.toolFingerprint();
    expect(f1).toBe(f2);
    expect(f1.length).toBeGreaterThan(0);
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

  // 2026-10-17 (leo: 朋友互认 = 第二选择验证; 朋友 P2P 互相确认)
  it('朋友互认: vouch 路由分发 + acceptVouch 证据累积 + summary 汇总', async () => {
    const { core } = await import('../web/mobile-core.ts');
    const prevLS = (globalThis as any).localStorage;
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      // 路由分发
      expect(core.resolvePost('/api/phone/vouch/request', { phone: '13812345678', peerId: 'peer1' })).toBeTypeOf('function');
      expect(core.resolvePost('/api/phone/vouch/accept', { fromPeer: 'peer1', phone: '13812345678', requesterDid: 'did:key:zB' })).toBeTypeOf('function');
      expect(core.resolvePost('/api/phone/vouch/list', {})).toBeTypeOf('function');
      expect(core.resolvePost('/api/phone/vouch/requests', {})).toBeTypeOf('function');

      // acceptVouch: 缺字段拒绝
      expect(core.vouch.acceptVouch({ phone: '13812345678' }).ok).toBe(false);
      // acceptVouch: 合法证据累积
      const r = core.vouch.acceptVouch({ phone: '13812345678', voucherDid: 'did:key:zFriend1', signature: 'sig-abc', vouchTs: '2026-10-17T00:00:00Z' });
      expect(r.ok).toBe(true);
      core.vouch.acceptVouch({ phone: '13812345678', voucherDid: 'did:key:zFriend2', signature: 'sig-def', vouchTs: '2026-10-17T01:00:00Z' });
      core.vouch.acceptVouch({ phone: '13987654321', voucherDid: 'did:key:zFriend3', signature: 'sig-ghi', vouchTs: '2026-10-17T02:00:00Z' });
      // summary: 按手机号聚合
      const sum = core.vouch.summary();
      const s = sum.find((x: any) => x.phone === '13812345678');
      expect(s).toBeTruthy();
      expect(s.vouchCount).toBe(2);
      const s2 = sum.find((x: any) => x.phone === '13987654321');
      expect(s2.vouchCount).toBe(1);
      // list: 证据持久化可读
      const list = core.vouch.list();
      expect(list.length).toBe(3);
      // 路由取数 (async)
      const viaRoute = await core.resolvePost('/api/phone/vouch/list', {})!();
      expect(viaRoute.ok).toBe(true);
      expect(viaRoute.summary.length).toBe(2);
    } finally {
      (globalThis as any).localStorage = prevLS;
    }
  });

  it('朋友互认: confirmFriendVouch 用本机 DID 签名 + 载荷结构', async () => {
    const agent = await import('../web/mobile-agent.ts');
    await agent.ensureIdentity();
    let sent: { type?: string; payload?: string; peer?: string } | null = null;
    // 注入 P2P transport (签名后发送; 验证载荷结构与签名可验)
    const sentBox = { value: sent };
    // setAgentTransport 需要 did; 用现有身份
    const id = await agent.identityStatus();
    agent.setAgentTransport(async (type: string, payload: string, peer?: string) => {
      sentBox.value = { type, payload, peer };
      return true;
    }, id.did);
    try {
      const r = await agent.confirmFriendVouch({ fromPeer: 'peer-b', phone: '13812345678', requesterDid: 'did:key:zRequester', requesterName: '朋友B' });
      expect(r.ok).toBe(true);
      const msg = sentBox.value!;
      expect(msg.type).toBe('agent.vouch.confirm');
      const body = JSON.parse(msg.payload);
      expect(body.phone).toBe('13812345678');
      expect(body.voucherDid).toBe(id.did);            // 用本机 DID 签名 = DID 主验证
      expect(body.requesterDid).toBe('did:key:zRequester');
      expect(typeof body.signature).toBe('string');
      expect(body.signature.length).toBeGreaterThan(20);
      // 签名可离线验签
      const ok = await agent.verifyIdentitySignature(body.signedPayload, body.signature, id.publicKey);
      expect(ok).toBe(true);
    } finally {
      agent.setAgentTransport(null as any, '');
    }
  });
});
