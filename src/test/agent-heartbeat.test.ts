/**
 * agent-heartbeat.test.ts — 社交心跳单元验证 (mock transport/decide, 无网络/无 LLM)
 *
 * 覆盖:
 *  1. beacon: 周期性向已知 peer 发 agent.heartbeat
 *  2. 自主发起: 社交决策返回 initiate=true → 发 agent.chat.send 给目标 peer 渠道
 *  3. 回复: 收到 agent.chat.reply → onReply 回调
 *  4. 冷却: 冷却窗口内不重复主动发起
 *  5. 存活: 收到 agent.heartbeat → liveness 更新
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentHeartbeat, type PeerInfo, type SelfInfo, type SocialDecision, type SendOutcome } from '../social/agent-heartbeat.js';

const SELF: SelfInfo = {
  publicKey: 'self'.padEnd(64, '0'),
  agentId: 'agent-self',
  name: 'NodeA',
  channels: [{ id: 'local-ch-1', name: '主页' }],
};

const PEER_B: PeerInfo = {
  publicKey: 'peerB'.padEnd(64, '1'),
  name: 'NodeB',
  channels: [{ id: 'remote-ch-b', name: 'NodeB 主页' }],
};

function makeTransport() {
  const sent: Array<{ pk: string; op: string; payload: any }> = [];
  const transport = {
    send: vi.fn(async (pk: string, op: string, payload: any): Promise<SendOutcome> => {
      sent.push({ pk, op, payload });
      return 'SENT';
    }),
  };
  return { transport, sent };
}

describe('AgentHeartbeat', () => {
  it('beacon: 向已知 peer 发 agent.heartbeat', async () => {
    const { transport, sent } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      socialEnabled: false,
    });
    await hb.tickBeacon();
    const beacon = sent.find((s) => s.op === 'agent.heartbeat' && s.pk === PEER_B.publicKey);
    expect(beacon).toBeDefined();
    expect(beacon!.payload.fromPublicKey).toBe(SELF.publicKey);
    expect(beacon!.payload.name).toBe('NodeA');
    expect(beacon!.payload.channels[0].id).toBe('local-ch-1');
  });

  it('自主发起: decide 返回 initiate=true → 发 agent.chat.send', async () => {
    const { transport, sent } = makeTransport();
    const decide = vi.fn(async (): Promise<SocialDecision> => ({
      initiate: true,
      targetPeerPublicKey: PEER_B.publicKey,
      targetChannelId: 'remote-ch-b',
      message: '你好 NodeB, 我是 NodeA, 有个想法想聊聊',
    }));
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      decide,
      socialEnabled: true,
    });
    // 先 beacon 让 peer 存活
    await hb.tickBeacon();
    await hb.tickSocial();
    const chat = sent.find((s) => s.op === 'agent.chat.send' && s.pk === PEER_B.publicKey);
    expect(chat).toBeDefined();
    expect(chat!.payload.channelId).toBe('remote-ch-b');
    expect(chat!.payload.text).toContain('NodeB');
    expect(chat!.payload.fromPublicKey).toBe(SELF.publicKey);
    expect(hb.getLastInitiated(PEER_B.publicKey)).toBeGreaterThan(0);
  });

  it('回复: 收到 agent.chat.reply → 触发 onReply', () => {
    const { transport } = makeTransport();
    const onReply = vi.fn();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      onReply,
    });
    hb.handleIncoming('agent.chat.reply', { channelId: 'remote-ch-b', text: '收到! 我也正想找你' }, PEER_B.publicKey);
    expect(onReply).toHaveBeenCalledWith({
      fromPublicKey: PEER_B.publicKey,
      channelId: 'remote-ch-b',
      text: '收到! 我也正想找你',
    });
  });

  it('冷却: 冷却窗口内不重复主动发起', async () => {
    const { transport, sent } = makeTransport();
    const decide = vi.fn(async (): Promise<SocialDecision> => ({
      initiate: true,
      targetPeerPublicKey: PEER_B.publicKey,
      targetChannelId: 'remote-ch-b',
      message: '再来一条',
    }));
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      decide,
      cooldownMs: 60_000,
      socialEnabled: true,
    });
    await hb.tickBeacon();
    await hb.tickSocial(); // 第一次发起
    const afterFirst = sent.filter((s) => s.op === 'agent.chat.send').length;
    await hb.tickSocial(); // 冷却内, 应被跳过
    const afterSecond = sent.filter((s) => s.op === 'agent.chat.send').length;
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // 没有新增
  });

  it('存活: 收到 agent.heartbeat → liveness 更新 + onPeerAlive', () => {
    const { transport } = makeTransport();
    const onPeerAlive = vi.fn();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      onPeerAlive,
    });
    hb.handleIncoming('agent.heartbeat', { name: 'NodeB', channels: PEER_B.channels }, PEER_B.publicKey);
    const live = hb.getLiveness().find((l) => l.publicKey === PEER_B.publicKey);
    expect(live).toBeDefined();
    expect(onPeerAlive).toHaveBeenCalled();
    expect(onPeerAlive.mock.calls[0][0].name).toBe('NodeB');
  });

  it('不向自己发 beacon / 不决策联络自己', async () => {
    const { transport, sent } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [SELF], // 只有自己
      transport,
      socialEnabled: false,
    });
    await hb.tickBeacon();
    expect(sent.length).toBe(0); // 跳过自己
  });

  it('生命周期: 目标达成(收到有效回复) → RESTING, 不再主动社交', async () => {
    const { transport, sent } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      getGoal: () => ({ id: 'g1', description: '与 NodeB 同步进展', maxInitiations: 5, effectThreshold: 1 }),
      decide: async () => ({ initiate: true, targetPeerPublicKey: PEER_B.publicKey, targetChannelId: 'remote-ch-b', message: '你好 NodeB' }),
      socialEnabled: true,
    });
    await hb.tickBeacon();
    await hb.tickSocial(); // 发起 1 次
    expect(hb.getLastInitiated(PEER_B.publicKey)).toBeGreaterThan(0);
    // 收到有效回复 → 效果达标 → 目标达成
    hb.handleIncoming('agent.chat.reply', { channelId: 'remote-ch-b', text: '好的, 进展我同步给你' }, PEER_B.publicKey);
    expect(hb.getLifecycle().phase).toBe('RESTING');
    expect(hb.getLifecycle().goal?.achieved).toBe(true);
    const before = sent.filter((s) => s.op === 'agent.chat.send').length;
    await hb.tickSocial(); // RESTING 阶段应跳过
    const after = sent.filter((s) => s.op === 'agent.chat.send').length;
    expect(after).toBe(before);
  });

  it('生命周期: 配额耗尽 → RESTING', async () => {
    const { transport, sent } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      getGoal: () => ({ id: 'g2', description: '一次性同步', maxInitiations: 1, effectThreshold: 5 }),
      decide: async () => ({ initiate: true, targetPeerPublicKey: PEER_B.publicKey, targetChannelId: 'remote-ch-b', message: 'hi' }),
      cooldownMs: 10,
      socialEnabled: true,
    });
    await hb.tickBeacon();
    await hb.tickSocial(); // 发起 1 次, 配额用尽
    expect(hb.getLifecycle().goal?.initiationsUsed).toBe(1);
    await hb.tickSocial(); // 配额耗尽 → RESTING, 不再发
    expect(hb.getLifecycle().phase).toBe('RESTING');
    const count = sent.filter((s) => s.op === 'agent.chat.send').length;
    expect(count).toBe(1);
  });

  it('生命周期: 连续发起却无效果 → 退避 RESTING (不会一直社交)', async () => {
    const { transport, sent } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      getGoal: () => ({ id: 'g3', description: '试探', maxInitiations: 10, effectThreshold: 100 }),
      decide: async () => ({ initiate: true, targetPeerPublicKey: PEER_B.publicKey, targetChannelId: 'remote-ch-b', message: '在吗' }),
      cooldownMs: 10,
      minAttemptsBeforeBackoff: 1,
      noEffectWindowMs: 0,
      socialEnabled: true,
    });
    await hb.tickBeacon();
    await hb.tickSocial(); // 第 1 次 (无回复)
    expect(hb.getLifecycle().goal?.initiationsUsed).toBe(1);
    await new Promise((r) => setTimeout(r, 3)); // 让"无效果"时长超过窗口
    await hb.tickSocial(); // 1 次无效果 → 退避 RESTING
    expect(hb.getLifecycle().phase).toBe('RESTING');
    const count = sent.filter((s) => s.op === 'agent.chat.send').length;
    expect(count).toBe(1); // 第 2 次未发
  });

  it('生命周期: pause/resume 阶段切换 + stop 清理定时器', async () => {
    const { transport } = makeTransport();
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport,
      socialEnabled: true,
      beaconIntervalMs: 50,
      socialIntervalMs: 50,
    });
    hb.start();
    expect(hb.getLifecycle().phase).toBe('DISCOVERING');
    hb.pause();
    expect(hb.getLifecycle().phase).toBe('PAUSED');
    hb.resume();
    expect(hb.getLifecycle().phase).toBe('DISCOVERING');
    hb.stop();
    expect(hb.getLifecycle().started).toBe(false);
    expect(hb.getLifecycle().phase).toBe('PAUSED');
  });

  // === 2026-08-10: 自动整理心跳 (与社交并列的第三条心跳) ===
  it('organize: tickOrganize 调 organize 回调 + start/end 事件', async () => {
    const events: Array<{ phase: string; summary?: string }> = [];
    const organize = vi.fn(async (): Promise<{ done: boolean; summary: string }> => {
      return { done: true, summary: '进化 1 个 skill' };
    });
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: true,
      organize,
      onOrganizeEvent: (evt) => events.push(evt),
    });
    await hb.tickOrganize();
    expect(organize).toHaveBeenCalledTimes(1);
    expect(events[0].phase).toBe('start');
    expect(events[1].phase).toBe('end');
    expect(events[1].summary).toContain('进化 1 个 skill');
    expect(hb.isOrganizeEnabled()).toBe(true);
  });

  it('organize: 无 organize 回调 → isOrganizeEnabled=false, tick 不跑', async () => {
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
    });
    expect(hb.isOrganizeEnabled()).toBe(false);
    const r = await hb.tickOrganize();
    expect(r).toBeUndefined();
  });

  it('organize: organizeEnabled=false → 不跑整理 (即使有回调)', async () => {
    const organize = vi.fn(async () => ({ done: true }));
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: false,
      organize,
    });
    expect(hb.isOrganizeEnabled()).toBe(false);
    await hb.tickOrganize();
    expect(organize).not.toHaveBeenCalled();
  });

  it('organize: 回调抛错 → onOrganizeEvent error + 异常上抛, 重入锁释放', async () => {
    const events: Array<{ phase: string; error?: string }> = [];
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: true,
      organize: async () => {
        throw new Error('organize boom');
      },
      onOrganizeEvent: (evt) => events.push(evt),
    });
    await expect(hb.tickOrganize()).rejects.toThrow('organize boom');
    expect(events[0].phase).toBe('start');
    expect(events[1].phase).toBe('error');
    expect(events[1].error).toContain('organize boom');
    // 锁已释放 → 再跑一次 (这次换正常回调)
    const hb2 = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: true,
      organize: async () => ({ done: true }),
    });
    await expect(hb2.tickOrganize()).resolves.toBeDefined();
  });

  it('organize: 重入锁 — 并发 tickOrganize 只跑一次', async () => {
    let runs = 0;
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: true,
      organize: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 10));
        return { done: true };
      },
    });
    await Promise.all([hb.tickOrganize(), hb.tickOrganize()]);
    expect(runs).toBe(1);
  });

  it('organize: start() 启动定时 + stop() 清理 (organize=关闭时 start 日志无 organize)', async () => {
    const organize = vi.fn(async () => ({ done: true }));
    const hb = new AgentHeartbeat({
      self: () => SELF,
      getPeers: () => [PEER_B],
      transport: makeTransport().transport,
      organizeEnabled: true,
      organize,
      beaconIntervalMs: 50,
      socialIntervalMs: 50,
      socialEnabled: false,
    });
    hb.start();
    expect(hb.isOrganizeEnabled()).toBe(true);
    hb.stop();
    expect(hb.getLifecycle().started).toBe(false);
  });
});
