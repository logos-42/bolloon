import { describe, it, expect, beforeEach } from 'vitest';
// 手机端自动社交单测 (注入 mem store / spy send / fake fetch, 不依赖浏览器)
import {
  buildServiceDeclaration,
  toRegistryEntry,
  mergeServiceLists,
  announceSelf,
  discoverAgents,
  shouldHeartbeat,
  getHeartbeatState,
  setHeartbeatState,
  heartbeat,
  onPeerConnected,
  handleSocialMessage,
  createMemoryStore,
  emptySocialState,
  SOCIAL_MESSAGE_TYPES,
  DEFAULT_HEARTBEAT_MS,
} from '../web/mobile-social.js';

/** 记录 send 调用的 spy 传输 */
function spySend(result = true) {
  const calls: Array<{ type: string; payload: any; peerId?: string }> = [];
  const fn = async (type: string, payload: string, peerId?: string) => {
    calls.push({ type, payload: JSON.parse(payload), peerId });
    return result;
  };
  return { fn: fn as any, calls };
}

/** fake fetch 工厂 */
function fakeFetch(body: any, ok = true, status = 200) {
  const urls: string[] = [];
  let lastInit: any = null;
  const fn: any = async (url: string, init?: any) => {
    urls.push(url);
    lastInit = init;
    return { ok, status, json: async () => body };
  };
  return { fn, urls, init: () => lastInit };
}

const DID = 'did:blln:abc123';

describe('mobile-social (手机端自动社交)', () => {
  let store: ReturnType<typeof createMemoryStore>;
  beforeEach(() => { store = createMemoryStore(); });

  // ---- 1. 服务声明结构符合 E1 规范字段 ----
  it('buildServiceDeclaration 结构符合 Agent Economic Protocol §四 E1', () => {
    const d = buildServiceDeclaration({
      did: DID,
      name: '炁球手机',
      wallet: '0xabc0000000000000000000000000000000000001',
      serviceName: 'research',
      description: '研究/资料检索',
      price: { amount: '0.05', currency: 'USDC', per: 'query' },
      endpoint: 'agent://research/query',
      capabilities: ['research', 'data', 'compute'],
    });
    expect(d.agent_id).toBe(DID);
    expect(d.wallet).toBe('0xabc0000000000000000000000000000000000001');
    expect(d.service.name).toBe('research');
    expect(d.service.description).toBe('研究/资料检索');
    expect(d.service.price).toEqual({ amount: '0.05', currency: 'USDC', per: 'query' });
    expect(d.service.endpoint).toBe('agent://research/query');
    expect(d.capabilities).toEqual(['research', 'data', 'compute']);
    expect(d.reputation).toEqual({ tasks: 0, success: 0, score: 0 });
    // did 必填
    expect(() => buildServiceDeclaration({ did: '' })).toThrow();
  });

  it('默认值合理 (无 wallet/price → USDC/query, endpoint 自动生成) + toRegistryEntry 兼容桌面 M1', () => {
    const d = buildServiceDeclaration({ did: DID });
    expect(d.wallet).toBe('');
    expect(d.service.price.currency).toBe('USDC');
    expect(d.service.price.per).toBe('query');
    expect(d.service.endpoint).toBe('agent://local-agent/query');
    expect(d.capabilities.length).toBeGreaterThan(0);
    const e = toRegistryEntry(d);
    expect(e.agentId).toBe(DID);
    expect(e.service.name).toBe('local-agent');
    expect(e.reputation).toHaveProperty('failed', 0);
    expect(e).toHaveProperty('updatedAt');
  });

  // ---- 2. 首次 announce 发出正确消息 (P2P + HTTP) ----
  it('announceSelf 首次: P2P 发 registry.register + HTTP POST /api/registry/register', async () => {
    const send = spySend(true);
    const fetch = fakeFetch({ ok: true });
    const r = await announceSelf({
      ownDid: DID,
      send: send.fn,
      peerId: 'peer-1',
      desktopUrl: 'http://192.168.1.5:7788/',
      fetchImpl: fetch.fn,
      store,
    });
    expect(r.ok).toBe(true);
    expect(r.via).toEqual({ p2p: true, http: true });
    // P2P 消息类型 + 载荷
    expect(send.calls.length).toBe(1);
    expect(send.calls[0].type).toBe(SOCIAL_MESSAGE_TYPES.REGISTER);
    expect(send.calls[0].peerId).toBe('peer-1');
    expect(send.calls[0].payload.declaration.agent_id).toBe(DID);
    expect(send.calls[0].payload.fromPublicKey).toBe(DID);
    // HTTP 端点 (末尾斜杠被归一) + 桌面结构 body
    expect(fetch.urls[0]).toBe('http://192.168.1.5:7788/api/registry/register');
    const body = JSON.parse(fetch.init().body);
    expect(body.agentId).toBe(DID);
    expect(body.service.name).toBe('local-agent');
  });

  // ---- 3. 重复调用幂等 ----
  it('announceSelf 同一目标重复调用 → 幂等, 不再发送', async () => {
    const send = spySend(true);
    const deps = { ownDid: DID, send: send.fn, peerId: 'peer-1', store };
    const first = await announceSelf(deps);
    const second = await announceSelf(deps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already-announced');
    expect(send.calls.length).toBe(1); // 只发过一次
    // force → 允许重发
    const third = await announceSelf({ ...deps, force: true });
    expect(third.skipped).toBeUndefined();
    expect(send.calls.length).toBe(2);
  });

  // ---- 4. 同一 peer 只欢迎一次 ----
  it('onPeerConnected 幂等: 同一 peer 只欢迎一次, 第二次 duplicate', async () => {
    const send = spySend(true);
    const deps = { ownDid: DID, ownName: 'phone', send: send.fn, store };
    const a = await onPeerConnected('peer-A', deps);
    const b = await onPeerConnected('peer-A', deps);
    expect(a.welcomed).toBe(true);
    expect(a.type).toBe(SOCIAL_MESSAGE_TYPES.HELLO);
    expect(b.welcomed).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(send.calls.length).toBe(1);
    expect(send.calls[0].type).toBe(SOCIAL_MESSAGE_TYPES.HELLO);
    expect(send.calls[0].peerId).toBe('peer-A');
    expect(send.calls[0].payload.did).toBe(DID);
  });

  it('onPeerConnected 不同 peer 各自欢迎一次 + 空 peerId 报 error', async () => {
    const send = spySend(true);
    const deps = { ownDid: DID, send: send.fn, store };
    await onPeerConnected('peer-A', deps);
    await onPeerConnected('peer-B', deps);
    expect(send.calls.length).toBe(2);
    const bad = await onPeerConnected('', deps);
    expect(bad.welcomed).toBe(false);
    expect(String(bad.error)).toContain('peerId');
  });

  it('onPeerConnected 发送失败 → 不记账 (可重试)', async () => {
    const send = spySend(false);
    const deps = { ownDid: DID, send: send.fn, store };
    const a = await onPeerConnected('peer-X', deps);
    expect(a.welcomed).toBe(false);
    expect(store.get().welcomedPeers['peer-X']).toBeUndefined();
    const b = await onPeerConnected('peer-X', deps);
    expect(b.welcomed).toBe(false); // 仍失败但确实重试了
    expect(send.calls.length).toBe(2);
  });

  // ---- 5. 发现结果合并去重 ----
  it('discoverAgents 合并 HTTP + 已知 + 我方声明, 按 agent_id 去重', async () => {
    const remote = [
      { agentId: 'did:blln:a', service: { name: 'research' } },
      { agentId: 'did:blln:b', service: { name: 'coding' } },
    ];
    const fetch = fakeFetch({ services: remote, count: 2 });
    const own = buildServiceDeclaration({ did: DID, serviceName: 'local-agent' });
    const known = [
      { agentId: 'did:blln:b', service: { name: 'coding-v2' } }, // 覆盖旧值
      { agentId: 'did:blln:c', service: { name: 'data' } },
    ];
    const r = await discoverAgents({
      ownDid: DID,
      declaration: own,
      known,
      desktopUrl: 'http://10.0.0.9:7788',
      fetchImpl: fetch.fn,
      store,
    });
    expect(r.ok).toBe(true);
    expect(r.sources).toContain('http');
    expect(r.sources).toContain('known');
    // 4 个唯一 agent (a,b,c + self), b 被 known 覆盖
    expect(r.total).toBe(4);
    const ids = r.services.map((s: any) => s.agent_id || s.agentId);
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    const b = r.services.find((s: any) => (s.agent_id || s.agentId) === 'did:blln:b');
    expect(b.service.name).toBe('coding-v2');
    expect(ids).toContain(DID); // 我方服务也在列表里
    // 写回 store
    expect(store.get().discovered.length).toBe(4);
  });

  it('mergeServiceLists 纯函数: 后者覆盖, 忽略空对象/无键项', () => {
    const a = [{ agentId: 'x', service: { name: 'old' } }];
    const b = [{ agentId: 'x', service: { name: 'new' } }, { junk: true }, null as any];
    const m = mergeServiceLists(a, b);
    expect(m.length).toBe(1);
    expect(m[0].service.name).toBe('new');
  });

  // ---- 6. heartbeat 节流 ----
  it('shouldHeartbeat: 未到间隔 false, 到点 true, lastTs<=0 立即', () => {
    expect(shouldHeartbeat(0, 1000, 60000)).toBe(true);
    expect(shouldHeartbeat(1000, 2000, 60000)).toBe(false);
    expect(shouldHeartbeat(1000, 61000, 60000)).toBe(true);
    expect(shouldHeartbeat(1000, 2000, 0)).toBe(false);
  });

  it('heartbeat 未到间隔 → throttled, 不发送', async () => {
    const send = spySend(true);
    setHeartbeatState(1000, store);
    const r = await heartbeat({ ownDid: DID, send: send.fn, peerId: 'p', store, now: () => 2000, intervalMs: 60000 });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('throttled');
    expect(send.calls.length).toBe(0);
    expect(getHeartbeatState(store).lastTs).toBe(1000); // 未变
  });

  // ---- 7. 心跳到点发送 ----
  it('heartbeat 到点 → 发送 registry.register 并更新 lastTs', async () => {
    const send = spySend(true);
    setHeartbeatState(1000, store);
    const r = await heartbeat({
      ownDid: DID, send: send.fn, peerId: 'p', store,
      now: () => 1000 + DEFAULT_HEARTBEAT_MS, intervalMs: DEFAULT_HEARTBEAT_MS,
    });
    expect(r.sent).toBe(true);
    expect(r.reason).toBe('interval-elapsed');
    expect(r.via?.p2p).toBe(true);
    expect(send.calls.length).toBe(1);
    expect(send.calls[0].type).toBe(SOCIAL_MESSAGE_TYPES.REGISTER);
    expect(send.calls[0].payload.heartbeat).toBe(true);
    expect(getHeartbeatState(store).lastTs).toBe(1000 + DEFAULT_HEARTBEAT_MS);
    // 紧接着再调 → 被节流
    const r2 = await heartbeat({ ownDid: DID, send: send.fn, peerId: 'p', store, now: () => 1000 + DEFAULT_HEARTBEAT_MS, intervalMs: DEFAULT_HEARTBEAT_MS });
    expect(r2.sent).toBe(false);
    expect(send.calls.length).toBe(1);
  });

  // ---- 8. 网络失败返回 error 不抛出 ----
  it('网络失败: announceSelf 返回 ok:false + error, 不抛出', async () => {
    const boom: any = async () => { throw new Error('network down'); };
    const sendBoom: any = async () => { throw new Error('p2p down'); };
    const r = await announceSelf({ ownDid: DID, send: sendBoom, peerId: 'p', desktopUrl: 'http://1.2.3.4:7788', fetchImpl: boom, store });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('down');
    expect(r.via).toEqual({ p2p: false, http: false });
  });

  it('网络失败: discoverAgents 返回 ok:false + error, 不抛出; 无通道也给明确 error', async () => {
    const boom: any = async () => { throw new Error('network down'); };
    const r = await discoverAgents({ ownDid: '', desktopUrl: 'http://1.2.3.4:7788', fetchImpl: boom, store });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('network down');

    const none = await announceSelf({ ownDid: DID, store });
    expect(none.ok).toBe(false);
    expect(String(none.error)).toContain('注册通道');
  });

  it('电脑端返回非 200 → ok:false 带状态码 (不抛出)', async () => {
    const fetch = fakeFetch({}, false, 503);
    const r = await announceSelf({ ownDid: DID, desktopUrl: 'http://1.2.3.4:7788', fetchImpl: fetch.fn, store });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('503');
  });

  // ---- 附加: 入站路由 ----
  it('handleSocialMessage: registry.discover → 回 registry.discover.reply (含我方服务)', async () => {
    const send = spySend(true);
    const own = buildServiceDeclaration({ did: DID, serviceName: 'local-agent' });
    const res = await handleSocialMessage(
      SOCIAL_MESSAGE_TYPES.DISCOVER,
      JSON.stringify({ query: '', fromPublicKey: 'did:blln:other' }),
      'peer-Z',
      { ownDid: DID, declaration: own, send: send.fn, store },
    );
    expect(res.handled).toBe(true);
    expect(res.replied).toBe(SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY);
    expect(send.calls[0].type).toBe(SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY);
    expect(send.calls[0].peerId).toBe('peer-Z');
    expect(send.calls[0].payload.services.some((s: any) => s.agent_id === DID)).toBe(true);
  });

  it('handleSocialMessage: registry.discover.reply 合并去重 + agent.hello 标记已知 + 未知类型不管', async () => {
    const send = spySend(true);
    const deps = { ownDid: DID, send: send.fn, store };
    await handleSocialMessage(
      SOCIAL_MESSAGE_TYPES.REGISTER,
      JSON.stringify({ declaration: { agent_id: 'did:blln:other', service: { name: 'r' } }, fromPublicKey: 'did:blln:other' }),
      'peer-Z', deps,
    );
    expect(send.calls[0].type).toBe(SOCIAL_MESSAGE_TYPES.REGISTER_REPLY);
    await handleSocialMessage(
      SOCIAL_MESSAGE_TYPES.DISCOVER_REPLY,
      JSON.stringify({ services: [{ agent_id: 'did:blln:other', service: { name: 'r2' } }, { agent_id: 'did:blln:third', service: { name: 't' } }] }),
      'peer-Z', deps,
    );
    const disc = store.get().discovered;
    expect(disc.length).toBe(2); // other 去重, third 新增
    expect(disc.find((s: any) => s.agent_id === 'did:blln:other').service.name).toBe('r2');
    await handleSocialMessage(SOCIAL_MESSAGE_TYPES.HELLO, JSON.stringify({ did: 'did:blln:other' }), 'peer-H', deps);
    expect(store.get().welcomedPeers['peer-H']).toBeGreaterThan(0);
    const unknown = await handleSocialMessage('whatever.else', '{}', 'peer-H', deps);
    expect(unknown.handled).toBe(false);
    // 坏 JSON 不抛出
    const bad = await handleSocialMessage(SOCIAL_MESSAGE_TYPES.REGISTER, 'not-json', 'peer-H', deps);
    expect(bad.handled).toBe(true);
  });

  it('emptySocialState 形状正确', () => {
    expect(emptySocialState()).toEqual({ welcomedPeers: {}, lastHeartbeatTs: 0, announced: {}, discovered: [] });
  });
});
