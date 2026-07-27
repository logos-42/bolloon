/**
 * p2p-helper.ts — P2P 辅助连接器，帮助完整 Bolloon 与远程 peer 建立连接
 * 用法: npx tsx p2p-helper.ts &
 */
import { P2PDirect } from './src/network/p2p-direct.js';
import { addOrUpdatePeer } from './src/network/known-peers.js';

const REMOTE_PK = 'd92489cadd2a05063fbf3c0790817c0a81649436beb4a087ebab38d15a3ab61c';

const p2p = new P2PDirect({ name: 'p2p-helper' });
await p2p.start();
console.log(`[helper] publicKey: ${p2p.getPublicKey()}`);
await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
console.log('[helper] topic joined');

// 连接远程
await addOrUpdatePeer('mechrevo', REMOTE_PK, 'helper bootstrap');
console.log('[helper] 尝试连接远程...');
const r = await p2p.sendToWithWait(REMOTE_PK, JSON.stringify({
  v: 3, op: 'agent.heartbeat',
  payload: { fromPublicKey: p2p.getPublicKey(), name: 'helper', channels: [], ts: Date.now() },
}), 15000).catch(() => 'TIMEOUT');
console.log(`[helper] 连接结果: ${r}`);

p2p.on('connection', (evt: any) => console.log(`[helper] 🔗 ${evt.remotePublicKey.substring(0,16)}...`));
p2p.on('data', (evt: any) => {
  const t = evt.data.toString().substring(0, 120);
  console.log(`[helper] 📨 ${evt.fromPublicKey.substring(0,12)}...: ${t}`);
});

setInterval(() => {
  const msg = JSON.stringify({
    v: 3, op: 'agent.heartbeat',
    payload: { fromPublicKey: p2p.getPublicKey(), name: 'helper', channels: [], ts: Date.now() },
  });
  p2p.broadcast(msg);
}, 30_000);

console.log('[helper] 保持在线...');
