/**
 * p2p-mobile-desktop-bridge.ts — 2026-08-15 (tsx 集成测试, 不走 vitest)
 *
 * 验证 Phase 2: 手机端浏览器 libp2p 节点 (websockets) 能连桌面节点 (tcp+ws) 并互通 /agent/message.
 * 2026-08-15 扩展: 验证 data.llm-config 同步 — 桌面注册 data provider, 手机请求 → 收到 reply 并保存.
 *
 * 跑: npx tsx src/test/p2p-mobile-desktop-bridge.ts
 */
import 'fake-indexeddb/auto';
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

  // 2026-08-15: 桌面注册 data.llm-config 提供者 (模拟桌面 llm-config.json 内容)
  desktop.registerDataProvider('data.llm-config', async () => {
    return JSON.stringify({
      activeProvider: 'deepseek',
      providers: {
        deepseek: { enabled: true, apiKey: 'sk-test-desktop', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
      },
      updatedAt: Date.now(),
    });
  });
  console.log('[test] 桌面已注册 data.llm-config provider');

  console.log('[test] 2. 启动手机端节点 (websockets, 经 mobile-core.network.start 注入 transport + 路由)...');
  const { core } = await import('../web/mobile-core.js');
  const { startMobileP2P, sendMobileP2PMessage, onMobileP2PMessage, getMobileP2PState, getMobileP2PConnections } = await import('../web/mobile-p2p.js');
  const netState = await core.network.start([wsAddr]);
  console.log('[test] mobile-core network 状态:', JSON.stringify(netState));

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

  // 2026-08-15: 手机请求桌面 LLM 配置 → 期望收到 data.llm-config.reply (经 core 路由到 data 层)
  const dataLayer = await import('../web/mobile-data.js');
  const reqOk = await dataLayer.requestLlmConfigFromPeer(dInfo.peerId);
  console.log('[test] 手机请求 LLM 配置成功:', reqOk);
  await new Promise((r) => setTimeout(r, 1500));
  const llmCfg = await dataLayer.getLlmConfig();
  const synced = llmCfg.providers?.deepseek?.apiKey === 'sk-test-desktop';
  console.log('[test] 手机同步到的 LLM 配置 provider:', llmCfg.activeProvider, 'apiKey 匹配:', synced);

  const pass = desktopGot.length >= 1 && synced;
  console.log(pass ? '\n✅ PASS: 手机 websockets 节点 ↔ 桌面节点 互通 + data.llm-config 同步' : '\n❌ FAIL: 未互通或 LLM 配置未同步');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('test error:', e); process.exit(1); });