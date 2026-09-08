import { describe, it, expect } from 'vitest';
// 手机端 browser-safe gateway 单测 (注入 fetch/storage, 不依赖浏览器)
import { parseNetworkLink, detectGatewayLink } from '../agents/network-link.js';
import { mobileJoinNetwork, mobileRegister, mobileNetworkStatus, mobileAutoJoinGateway, mobileGatewayTool, getDesktopBaseUrl, setDesktopBaseUrl } from '../web/mobile-gateway.js';
import type { MobileGatewayOpts } from '../web/mobile-gateway.js';

function memStore() {
  let m: any[] = [];
  return { get: () => m, set: (x: any[]) => { m = x; } };
}
const fetchOk = (body: any): any => ({ ok: true, json: async () => body });
const fetchRes = (res: any) => () => res;

describe('network-link (纯函数, 手机/桌面共用)', () => {
  it('parse orbitdb/ipns/http + ?name=', () => {
    expect(parseNetworkLink('orbitdb:///orbitdb/Qmaddr?name=alpha')?.kind).toBe('orbitdb');
    expect(parseNetworkLink('ipns://myname')?.kind).toBe('ipns');
    expect(parseNetworkLink('https://x.com/registry')?.kind).toBe('http');
    expect(parseNetworkLink('https://x.com/registry?name=beta')?.networkName).toBe('beta');
    expect(parseNetworkLink('垃圾')).toBeNull();
  });
  it('detectGatewayLink 从文本抽链接', () => {
    expect(detectGatewayLink('加网 https://x.com/registry?name=a 谢谢')).toContain('/registry');
    expect(detectGatewayLink('好')).toBeNull();
  });
});

describe('mobile-gateway (#2 手机入网)', () => {
  it('http registry 拉取+合并成员, 返回 meta', async () => {
    const storage = memStore();
    const opts: MobileGatewayOpts = {
      fetch: fetchRes(fetchOk({ services: [{ agentId: 'did:1', service: { name: 'coding' } }], meta: { networkId: 'n1', capacityOfMembers: 5 } })),
      storage,
    };
    const r = await mobileJoinNetwork('https://x.com/registry?name=net1', opts);
    expect(r.ok).toBe(true);
    expect(r.joined).toBe(1);
    expect(r.meta.networkId).toBe('n1');
    expect(storage.get().length).toBe(1);
  });

  it('orbitdb 无 desktopBaseUrl → 明确提示', async () => {
    const r = await mobileJoinNetwork('orbitdb:///orbitdb/Qmaddr', { fetch: fetchRes(fetchOk({ services: [] })) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('桌面');
  });

  it('orbitdb 有 desktopBaseUrl → 转发桌面成功', async () => {
    const r = await mobileJoinNetwork('orbitdb:///orbitdb/Qmaddr', {
      fetch: fetchRes({ ok: true, json: async () => ({ ok: true, joined: 2, total: 3 }) }),
      desktopBaseUrl: 'http://192.168.1.5:54188',
    });
    expect(r.ok).toBe(true);
    expect(r.viaDesktop).toBe(true);
    expect(r.total).toBe(3);
  });

  it('mobileRegister 合并本机声明 + status', () => {
    const storage = memStore();
    mobileRegister({ agentId: 'did:myself', name: 'me', service: { name: 'research' } }, { storage });
    mobileRegister({ agentId: 'did:myself', name: 'me2', service: { name: 'research' } }, { storage }); // upsert
    expect(mobileNetworkStatus({ storage }).length).toBe(1);
    expect(mobileNetworkStatus({ storage })[0].name).toBe('me2');
  });

  it('mobileAutoJoinGateway 检测链接自动入网', async () => {
    const storage = memStore();
    const opts: MobileGatewayOpts = {
      fetch: fetchRes(fetchOk({ services: [{ agentId: 'did:a', service: { name: 'data' } }], meta: {} })),
      storage,
    };
    const note = await mobileAutoJoinGateway('加入 https://x.com/registry?name=alpha', opts);
    expect(note).toContain('已加入');
    expect(note).toContain('alpha');
    expect(storage.get().length).toBe(1);
  });

  it('mobileGatewayTool 分派: join/status/register', async () => {
    const storage = memStore();
    const opts: MobileGatewayOpts = {
      fetch: fetchRes(fetchOk({ services: [{ agentId: 'did:z', service: { name: 'coding' } }], meta: { networkId: 'n9' } })),
      storage,
    };
    const j = await mobileGatewayTool('gateway_join', { link: 'https://x.com/registry?name=netX' }, opts);
    expect(j.ok).toBe(true);
    expect(j.output).toContain('netX');
    const s = await mobileGatewayTool('gateway_status', {}, opts);
    expect(s.ok).toBe(true);
    expect(s.output).toContain('did:z');
    const r = await mobileGatewayTool('gateway_register', { self: { agentId: 'did:me', name: 'me', service: { name: 'research' } } }, opts);
    expect(r.ok).toBe(true);
    expect(mobileNetworkStatus({ storage }).some((m) => m.agentId === 'did:me')).toBe(true);
    expect((await mobileGatewayTool('gateway_join', {}, opts)).ok).toBe(false); // 缺 link
  });

  it('desktopBaseUrl 配置持久化 (node 无 localStorage → 不抛)', () => {
    setDesktopBaseUrl('http://192.168.1.5:54188');
    expect(typeof getDesktopBaseUrl()).toBe('string'); // 无 localStorage 返回 ''
  });
});
