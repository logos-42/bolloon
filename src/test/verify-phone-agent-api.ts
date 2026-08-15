/**
 * verify-phone-agent-api.ts — 2026-08-15 (tsx 集成测试, 不走 vitest)
 *
 * 验证手机端自治控制双面 (Phone API → AgentRuntime):
 *   1. P2P 控制面 (phone.* 协议): 桌面发 phone.agent.run → 手机独立 AgentLoop 执行 → 回 phone.agent.result
 *   2. 本地 HTTP API: 手机 WebView 内 localhost server → POST /api/phone/agent/run → 手机自治执行
 *
 * 手机不需要经过电脑同意也可以操作: 执行主体是手机本身 (fallback 模式: 内置规则; 真机: Kotlin AgentRuntime).
 *
 * 跑: npx tsx src/test/verify-phone-agent-api.ts
 */
import 'fake-indexeddb/auto';
import { P2PNetwork } from '../network/p2p.js';

async function main() {
  console.log('[verify] ========== 1. 启动桌面节点 (P2P 控制端) ==========');
  const desktop = new P2PNetwork();
  const dInfo = await desktop.createNode({ enableAutoNat: false, enableUPnP: false });
  const wsAddr = dInfo.multiaddrs.find((a: string) => a.includes('/ws')) || dInfo.multiaddrs[0];
  console.log('[verify] 桌面 peerId:', dInfo.peerId.slice(0, 12), 'ws:', wsAddr);

  // 桌面收手机回执 (消息带 DID:<did>|type:payload 前缀)
  function stripDid(rawText: string): string {
    return rawText.replace(/^DID:[^|]*\|/, '');
  }
  function parseBody(text: string, typePrefix: string): any {
    let body = stripDid(text);
    if (body.startsWith(typePrefix + ':')) body = body.slice((typePrefix + ':').length);
    try { return JSON.parse(body); } catch { return null; }
  }
  const desktopGot: Record<string, any> = {};
  desktop.onMessage('phone.agent.result', (raw: any, from: string) => {
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    desktopGot.result = parseBody(text, 'phone.agent.result');
    console.log('[verify] 桌面收到 phone.agent.result:', stripDid(text).slice(0, 140), 'from', from.slice(0, 10));
  });
  desktop.onMessage('phone.agent.status.reply', (raw: any, from: string) => {
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    desktopGot.status = parseBody(text, 'phone.agent.status.reply');
    console.log('[verify] 桌面收到 phone.agent.status.reply:', stripDid(text).slice(0, 140), 'from', from.slice(0, 10));
  });

  console.log('[verify] ========== 2. 启动手机端 (mobile-core, 自治节点) ==========');
  const { default: core } = await import('../web/mobile-core.js');
  const { getMobileP2PState, getMobileP2PConnections } = await import('../web/mobile-p2p.js');
  const netState = await core.network.start([wsAddr]);
  console.log('[verify] mobile-core network:', JSON.stringify(netState));

  await new Promise((r) => setTimeout(r, 3500));
  const st = getMobileP2PState();
  console.log('[verify] 手机连接数:', st.peerCount, 'peers:', st.peerIds.map((p) => p.slice(0, 10)));
  const conns = getMobileP2PConnections();
  console.log('[verify] 活跃连接:', conns.map((c) => c.peer.slice(0, 10) + '@' + (c.addr || '?').slice(0, 30)));

  // ---- 面 1: P2P 控制 (桌面 → 手机) ----
  console.log('[verify] ========== 3. P2P 控制面: 桌面发 phone.agent.run → 手机自治执行 ==========');
  // 手机自己的 peerId = network.start 返回的 nodeId (不是手机连到桌面的那个连接)
  const phonePeerId = netState.nodeId;
  if (!phonePeerId) { console.error('[verify] ❌ 手机未连接到桌面'); process.exit(1); }
  console.log('[verify] 手机 peerId:', phonePeerId.slice(0, 12));

  await desktop.sendMessage(phonePeerId, 'phone.agent.run', JSON.stringify({ goal: '帮我看看今天有什么安排', requestId: 'req-1' }));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('[verify] 桌面收到 result:', desktopGot.result ? JSON.stringify({ ok: desktopGot.result.ok, mode: desktopGot.result.mode, result: (desktopGot.result.result || '').slice(0, 80), did: desktopGot.result.did }) : '(无)');

  await desktop.sendMessage(phonePeerId, 'phone.agent.status', '');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('[verify] 桌面收到 status:', desktopGot.status ? JSON.stringify({ did: desktopGot.status.did, mode: desktopGot.status.mode, capabilities: desktopGot.status.capabilities }) : '(无)');

  const p2pOk = !!(desktopGot.result && desktopGot.result.ok && desktopGot.status && desktopGot.status.ok);
  console.log(p2pOk ? '[verify] ✅ P2P 控制面通过 (手机自治执行 + 回执)' : '[verify] ❌ P2P 控制面未通过');

  // ---- 面 2: 本地 HTTP API ----
  console.log('[verify] ========== 4. 本地 HTTP API: POST /api/phone/agent/run ==========');
  const httpApi = await import('../web/mobile-http-api.js');
  const server = await httpApi.startLocalHttpServer(7791);
  if (server) {
    try {
      const res = await fetch('http://127.0.0.1:7791/health');
      const health = await res.json();
      console.log('[verify] HTTP /health:', JSON.stringify(health));

      const stRes = await fetch('http://127.0.0.1:7791/api/phone/status');
      const stJson = await stRes.json();
      console.log('[verify] HTTP status:', JSON.stringify({ did: stJson.did, mode: stJson.mode, capabilities: stJson.capabilities }));

      const runRes = await fetch('http://127.0.0.1:7791/api/phone/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: '给我介绍下 Bolloon', requestId: 'http-1' }),
      });
      const runJson = await runRes.json();
      console.log('[verify] HTTP run:', JSON.stringify({ ok: runJson.ok, mode: runJson.mode, result: (runJson.result || '').slice(0, 80), requestId: runJson.requestId }));
      server.close();
      console.log('[verify] HTTP 本地 server 已关闭');
    } catch (e: any) {
      console.error('[verify] ❌ HTTP 本地 server 调用失败:', String(e?.message || e).slice(0, 100));
      server.close();
      process.exit(1);
    }
  } else {
    console.log('[verify] ⚠️ 非 Node 环境, 跳过本地 HTTP server (用 handleHttpRequest 直测)');
    const r = await httpApi.handleHttpRequest('POST', '/api/phone/agent/run', JSON.stringify({ goal: '直接调用测试', requestId: 'direct-1' }));
    console.log('[verify] 直调 handleHttpRequest run:', JSON.stringify({ status: r.status, ok: r.body?.ok, mode: r.body?.mode }));
  }

  const pass = p2pOk;
  console.log(pass ? '\n✅ PASS: 手机自治控制双面 (P2P phone.* + 本地 HTTP) → AgentRuntime 全通' : '\n❌ FAIL: 部分控制面未通过');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('verify error:', e); process.exit(1); });