/**
 * k10-transport-port.test.ts — K10 ④: **通信入口端口** (transport)
 *
 * 两段判据: A. 端口本身 (未注入即拒 · 派发 · 归一化 · 校验 · 审计) ·
 *          B. **真调方法体**: `PiAgentSession.sendMessage/broadcast` 必须经端口, 且失败要**响亮**
 *             (发送有副作用 —— 静默丢消息比抛错更糟), 源级钉住"不许再直接对传输说话"。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TRANSPORT_OPS, TRANSPORT_NEEDS_TARGET, submitTransport, transportAudit, resetTransportAudit,
  type TransportPorts,
} from '../kernel/transport.js';

beforeEach(() => resetTransportAudit());

describe('K10 ④-A. 端口: 未注入即拒 / 派发 / 校验 / 审计', () => {
  it('未注入 ⇒ 三个动作都拒, detail 指明缺哪个 port', async () => {
    for (const op of TRANSPORT_OPS) {
      const out = await submitTransport({ op, origin: 'test', peerId: 'p1' }, {});
      expect(out.ok, `${op} 未注入必须拒`).toBe(false);
      expect(out.detail).toMatch(/port 未注入/);
      expect(out.via).toBe('kernel-transport');
    }
  });

  it('派发: send 的入参原样透出; peers 的返回值从 result 取', async () => {
    const seen: any[] = [];
    const ports: TransportPorts = {
      send: async (p, k, payload) => { seen.push(['send', p, k, payload]); return { ok: true }; },
      broadcast: async (k, payload) => { seen.push(['bcast', k, payload]); return { ok: true }; },
      peers: async () => ['peer-a', 'peer-b'],
    };
    const a = await submitTransport({ op: 'send', origin: 'test', peerId: 'p9', payload: '你好' }, ports);
    expect(a.ok).toBe(true);
    expect(seen[0]).toEqual(['send', 'p9', 'message', '你好']);
    const b = await submitTransport({ op: 'broadcast', origin: 'test', payload: '大家' }, ports);
    expect(b.ok).toBe(true);
    expect(seen[1]).toEqual(['bcast', 'message', '大家']);
    const c = await submitTransport({ op: 'peers', origin: 'test' }, ports);
    expect(c.ok).toBe(true);
    expect(c.result).toEqual(['peer-a', 'peer-b']);
  });

  it('端口拒绝 / 抛异常: 都判失败且带原文 (不吞)', async () => {
    const refuse: TransportPorts = { send: async () => ({ ok: false, reason: '围栏拒: 不在允许名单' }) };
    const r1 = await submitTransport({ op: 'send', origin: 'test', peerId: 'p1' }, refuse);
    expect(r1.ok).toBe(false);
    expect(r1.detail).toContain('端口拒绝');
    expect(r1.detail).toContain('不在允许名单');

    const boom: TransportPorts = { broadcast: async () => { throw new Error('ECONNRESET 对端断了'); } };
    const r2 = await submitTransport({ op: 'broadcast', origin: 'test' }, boom);
    expect(r2.ok).toBe(false);
    expect(r2.detail).toContain('ECONNRESET');
  });

  it('校验: 未知 op / 缺 origin / send 缺 peerId; broadcast 不需要目标', async () => {
    const ports: TransportPorts = { broadcast: async () => ({ ok: true }) };
    expect((await submitTransport({ op: 'nope' as any, origin: 't' }, ports)).detail).toMatch(/未知通信动作/);
    expect((await submitTransport({ op: 'send', origin: '', peerId: 'p' }, ports)).detail).toMatch(/origin/);
    expect((await submitTransport({ op: 'send', origin: 't' }, ports)).detail).toMatch(/缺少 peerId/);
    expect(TRANSPORT_NEEDS_TARGET.send).toBe(true);
    expect(TRANSPORT_NEEDS_TARGET.broadcast).toBe(false);
    expect((await submitTransport({ op: 'broadcast', origin: 't' }, ports)).ok).toBe(true);
  });

  it('审计流水: op / origin / target / ok', async () => {
    await submitTransport({ op: 'send', origin: 'pi-session', peerId: 'peer-7', payload: 'x' }, { send: async () => ({ ok: true }) });
    const a = transportAudit();
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ op: 'send', origin: 'pi-session', target: 'peer-7', ok: true });
  });
});

describe('K10 ④-B. 真调方法体: 会话的 send/broadcast 经端口, 失败响亮', () => {
  it('sendMessage / broadcast 把消息送到注入的端口 (真实方法体, 不构造 session)', async () => {
    const { PiAgentSession } = await import('../agents/pi-sdk.js');
    const sent: any[] = [];
    const proto: any = PiAgentSession.prototype;
    const fakeThis = {
      transportPorts: (): TransportPorts => ({
        send: async (p: string, k: string, payload: string) => { sent.push(['send', p, k, payload]); return { ok: true }; },
        broadcast: async (k: string, payload: string) => { sent.push(['bcast', k, payload]); return { ok: true }; },
      }),
    };
    await proto.sendMessage.call(fakeThis, 'peer-x', '你好');
    await proto.broadcast.call(fakeThis, '大家好');
    expect(sent).toEqual([['send', 'peer-x', 'message', '你好'], ['bcast', 'message', '大家好']]);
  });

  it('端口拒绝 ⇒ **抛** (发送有副作用: 静默丢消息比抛错更糟)', async () => {
    const { PiAgentSession } = await import('../agents/pi-sdk.js');
    const proto: any = PiAgentSession.prototype;
    const refusing = { transportPorts: (): TransportPorts => ({ send: async () => ({ ok: false, reason: '闸门拒' }) }) };
    await expect(proto.sendMessage.call(refusing, 'peer-x', 'x')).rejects.toThrow(/send 未发出.*闸门拒/s);
    const refusingB = { transportPorts: (): TransportPorts => ({ broadcast: async () => ({ ok: false, reason: '无对端' }) }) };
    await expect(proto.broadcast.call(refusingB, 'x')).rejects.toThrow(/broadcast 未发出.*无对端/s);
  });
});

describe('K10 ④-C. 反回归: 上层不许再直接对传输说话', () => {
  it('pi-sdk 的 sendMessage/broadcast 经端口; 不许出现直接调 p2pNetwork 的发送', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    expect(src, '不许直接 await p2pNetwork.sendMessage(').not.toMatch(/await\s+p2pNetwork\.sendMessage\(/);
    expect(src, '不许直接 await p2pNetwork.broadcast(').not.toMatch(/await\s+p2pNetwork\.broadcast\(/);
    expect((src.match(/submitTransport\(/g) || []).length, '两处发送都该经端口').toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/transportPorts\(\): TransportPorts/);
  });
});
