/**
 * p2p-mobile-desktop-bridge.ts — 2026-08-15 (tsx 集成测试, 不走 vitest)
 *
 * 验证 Phase 2: 手机端浏览器 libp2p 节点 (websockets) 能连桌面节点 (tcp+ws) 并互通 /agent/message.
 *
 * 跑: npx tsx src/test/p2p-mobile-desktop-bridge.ts
 */
import { P2PNetwork } from '../network/p2p.js';

async function main() {
  console.log('[test] 1. 启动桌面节点 (tcp + ws)...');
  const desktop = new P2PNetwork();
  const dInfo = await desktop.createNode({ enableAutoNat: false, enableUPnP: false });
  const wsAddr = dInfo.multiaddrs.find((a: string) => a.includes('/ws')) || dInfo.multiaddrs[0];
  console.log('[test] 桌面 peerId:', dInfo.peerId.slice(0, 12), 'ws:', wsAddr);
  const dProto = (desktop as any).node?.getProtocols?.() || [];
  console.log('[test] 桌面注册协议数:', dProto.length, '含agent/message:', dProto.includes('/agent/message'));

  // 桌面注册消息 handler (公开 API onMessage)
  const desktopGot: string[] = [];
  desktop.onMessage('agent.chat.send', (raw: any, from: string) => {
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    desktopGot.push(text);
    console.log('[test] 桌面收到 agent.chat.send:', text.slice(0, 60), 'from', from.slice(0, 10));
  });
  // 诊断: messageHandlers 是否注册了 agent.chat.send
  const mhKeys = Array.from((desktop as any).messageHandlers?.keys?.() || []);
  console.log('[test] 桌面 messageHandlers:', mhKeys.join(','));

  console.log('[test] 2. 启动手机端节点 (websockets)...');
  const { startMobileP2P, sendMobileP2PMessage, onMobileP2PMessage, getMobileP2PState, getMobileP2PConnections } = await import('../web/mobile-p2p.js');
  const mobileState = await startMobileP2P({ seedAddrs: [wsAddr] });
  console.log('[test] 手机节点状态:', JSON.stringify(mobileState));

  const mobileGot: string[] = [];
  onMobileP2PMessage((payload, from) => {
    mobileGot.push(payload);
    console.log('[test] 手机收到:', payload.slice(0, 50), 'from', from.slice(0, 12));
  });

  await new Promise((r) => setTimeout(r, 3500));
  const st2 = getMobileP2PState();
  console.log('[test] 3.5s 后手机连接数:', st2.peerCount, 'peers:', st2.peerIds.map((p) => p.slice(0, 10)));
  const conns = getMobileP2PConnections();
  console.log('[test] 活跃连接:', conns.map((c) => c.peer.slice(0, 10) + '@' + (c.addr || '?').slice(0, 30)));
  const dConns = (desktop as any).node?.getConnections?.() || [];
  console.log('[test] 桌面连接数:', dConns.length, dConns.map((c: any) => c.remotePeer.toString().slice(0, 10)));

  // 手机 → 桌面 (用 /agent/message 协议, 桌面 onMessage 收到)
  const ok = await sendMobileP2PMessage(dInfo.peerId, 'agent.chat.send', JSON.stringify({ text: 'hi from mobile', channelId: 'mobile-c1' }), 'did:mob:test');
  console.log('[test] 手机发送成功:', ok);

  await new Promise((r) => setTimeout(r, 2000));
  console.log('[test] 桌面收到数:', desktopGot.length);
  console.log('[test] 手机收到数:', mobileGot.length);

  const pass = desktopGot.length >= 1;
  console.log(pass ? '\n✅ PASS: 手机 websockets 节点 ↔ 桌面节点 互通' : '\n❌ FAIL: 未互通');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('test error:', e); process.exit(1); });