/**
 * run-agent-heartbeat.ts — 社交心跳双节点自动交流 + 生命周期仿真 (2026-07-21)
 *
 * 目的: 在不依赖真实网络 (Hyperswarm DHT) 与 LLM 的前提下, 用内存总线把两个
 *       AgentHeartbeat 实例 (NodeA / NodeB) 连起来, 验证:
 *         1. 双方 beacon 互相宣告存活 (心跳)
 *         2. 各自社交决策循环自主决定跟对方发起对话
 *         3. 远端 agent 被"唤醒"并自动回复 (chat.reply) → 产生"效果"
 *         4. 效果达标 → 目标达成 → 智能体进入 RESTING, **不再一直社交** (核心诉求)
 *         5. stop() 优雅清理定时器, 关闭后 beacon 也停止
 *
 * 运行: npx tsx scripts/ablation/run-agent-heartbeat.ts
 */
import { AgentHeartbeat, type PeerInfo, type SelfInfo, type SocialDecision, type AgentGoal, type LifecyclePhase } from '../../src/social/agent-heartbeat.js';

type Bus = {
  send: (fromPk: string, toPk: string, op: string, payload: any) => void;
};

function createBus(): { bus: Bus; register: (pk: string, node: AgentHeartbeat) => void } {
  const nodes = new Map<string, AgentHeartbeat>();
  const bus: Bus = {
    send(fromPk, toPk, op, payload) {
      const recipient = nodes.get(toPk);
      if (!recipient) return;
      if (op === 'agent.chat.send') {
        // 模拟"远端 agent 被唤醒并回复" — 真实环境由 server.ts:529 的 agent.chat.send 处理器完成
        const reply = mockRemoteAgent(toPk, fromPk, payload.channelId, payload.text);
        const sender = nodes.get(fromPk);
        if (sender) sender.handleIncoming('agent.chat.reply', { channelId: payload.channelId, text: reply }, toPk);
      } else {
        recipient.handleIncoming(op, payload, fromPk);
      }
    },
  };
  return { bus, register: (pk, node) => nodes.set(pk, node) };
}

function mockRemoteAgent(recipientPk: string, fromPk: string, channelId: string, text: string): string {
  const who = recipientPk.startsWith('A') ? 'NodeA' : 'NodeB';
  return `[${who} 自动回复] 收到你的消息:"${text.slice(0, 24)}…"。我这边也正想就这个话题跟你同步一下进展, 咱们保持心跳常联系。`;
}

function makeNode(name: string, otherPk: string, bus: Bus, log: string[], lifecycleLog: string[]): AgentHeartbeat {
  const selfPk = name.padEnd(64, name === 'NodeA' ? '0' : '1');
  const self: SelfInfo = {
    publicKey: selfPk,
    agentId: `agent-${name}`,
    name,
    channels: [{ id: `${name}-home`, name: `${name} 主页` }],
  };
  const otherPeer: PeerInfo = {
    publicKey: otherPk,
    name: name === 'NodeA' ? 'NodeB' : 'NodeA',
    channels: [{ id: `${name === 'NodeA' ? 'NodeB' : 'NodeA'}-home`, name: '对方主页' }],
  };
  // 目标: 与对方同步协作进展 — 配额 2 次, 收到 1 条有效回复即达成 → RESTING
  const goal: AgentGoal = {
    id: `goal-${name}`,
    description: `与 ${name === 'NodeA' ? 'NodeB' : 'NodeA'} 同步协作进展`,
    maxInitiations: 2,
    effectThreshold: 1,
  };
  const node = new AgentHeartbeat({
    self: () => self,
    getPeers: () => [otherPeer],
    getGoal: () => goal,
    transport: {
      send: async (pk, op, payload) => {
        log.push(`${name} --${op}--> ${pk.slice(0, 6)}… (${op === 'agent.heartbeat' ? 'beacon' : (payload?.text || '').slice(0, 20)})`);
        bus.send(selfPk, pk, op, payload);
        return 'SENT';
      },
    },
    decide: async (): Promise<SocialDecision> => ({
      initiate: true,
      targetPeerPublicKey: otherPk,
      targetChannelId: otherPeer.channels[0].id,
      message: `你好, 我是 ${name}。我刚完成了一轮本地推理, 想跟你确认下协作方向。`,
    }),
    onReply: (info) => {
      log.push(`${name} <<chat.reply<< ${info.fromPublicKey.slice(0, 6)}… : ${info.text.slice(0, 30)}…`);
    },
    onPeerAlive: (peer) => {
      log.push(`${name} 收到 ${peer.name} 的心跳 (在线)`);
    },
    onLifecycleChange: (phase: LifecyclePhase, snap) => {
      lifecycleLog.push(`${name} 生命周期 → ${phase} (目标:${snap.goal?.initiationsUsed ?? 0}/${snap.goal?.maxInitiations ?? '?'} 发起, 效果 ${snap.goal?.effectfulReplies ?? 0}/${snap.goal?.effectThreshold ?? '?'})`);
    },
    beaconIntervalMs: 300,
    socialIntervalMs: 600,
    cooldownMs: 2000,
    enabled: true,
    socialEnabled: true,
  });
  return node;
}

async function main() {
  const log: string[] = [];
  const lifecycleLog: string[] = [];
  const { bus, register } = createBus();

  const pkA = 'NodeA'.padEnd(64, '0');
  const pkB = 'NodeB'.padEnd(64, '1');

  const nodeA = makeNode('NodeA', pkB, bus, log, lifecycleLog);
  const nodeB = makeNode('NodeB', pkA, bus, log, lifecycleLog);
  register(pkA, nodeA);
  register(pkB, nodeB);

  console.log('=== 社交心跳双节点仿真启动 (NodeA ↔ NodeB, 目标驱动生命周期) ===');
  nodeA.start();
  nodeB.start();

  await new Promise((r) => setTimeout(r, 4000));

  const stopAt = Date.now();
  nodeA.stop();
  nodeB.stop();

  console.log('\n--- 生命周期轨迹 ---');
  for (const line of lifecycleLog) console.log('  ' + line);

  console.log('\n--- 事件流 (节选) ---');
  for (const line of log.slice(0, 20)) console.log('  ' + line);
  if (log.length > 20) console.log(`  ... (共 ${log.length} 条)`);

  const beacons = log.filter((l) => l.includes('--agent.heartbeat-->')).length;
  const initiates = log.filter((l) => l.includes('--agent.chat.send-->')).length;
  const replies = log.filter((l) => l.includes('<<chat.reply<<')).length;
  const heartbeatsSeen = log.filter((l) => l.includes('收到') && l.includes('心跳')).length;
  const reachedResting = lifecycleLog.some((l) => l.includes('→ RESTING'));
  const beaconsAfterStop = log.filter((l) => l.includes('--agent.heartbeat-->') && l.startsWith('Node')).length; // 近似: stop 后无新日志
  // 精确: stop 后不应再有新 beacon — 用时间戳无法从 log 文本判断, 改为检查 lifecycle 终态
  const finalPhaseA = nodeA.getLifecycle().phase;
  const finalStartedA = nodeA.getLifecycle().started;

  console.log('\n--- 统计 ---');
  console.log(`  beacon 发送:     ${beacons}`);
  console.log(`  自主发起对话:   ${initiates}`);
  console.log(`  自动回复收到:   ${replies}`);
  console.log(`  心跳互相感知:   ${heartbeatsSeen}`);
  console.log(`  进入 RESTING:   ${reachedResting ? '是 ✅ (目标达成后停止社交, 不会一直社交)' : '否'}`);
  console.log(`  stop() 后状态:  phase=${finalPhaseA}, started=${finalStartedA} ${finalStartedA ? '❌' : '✅ (定时器已清理)'}`);

  const ok =
    beacons >= 2 &&
    initiates >= 2 &&
    replies >= 2 &&
    heartbeatsSeen >= 2 &&
    reachedResting &&
    !finalStartedA;
  console.log(`\n结果: ${ok ? 'PASS ✅ 本地↔远端智能体顺畅自动交流, 且达成效果后自动 RESTING + 优雅关闭' : 'FAIL ❌'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('仿真失败:', e);
  process.exit(1);
});
