/**
 * mobile-core.ts — 手机端内核协调层 (2026-08-15 重构)
 *
 * 目标: 手机是"独立逻辑", 数据同步 ≠ agent 功能, 两块独立子系统:
 *   1. mobile-data.ts  — 数据同步层 (IndexedDB 副本, data.* 协议, 与远端双向同步)
 *   2. mobile-agent.ts — Agent 功能层 (独立 DID, Kotlin AgentRuntime, agent.chat.* 协议)
 *
 * 本文件只做两件事:
 *   a) 对外暴露与 mobile.js 对接的 API 面 (resolve/resolvePost/events, 同 server.ts 语义)
 *   b) P2P 入站消息路由: 按 type 前缀分发给 data / agent 层
 *
 * 不在这里混数据与智能: 落库走 data 层, 执行走 agent 层.
 */

// ============ 事件总线 (替代 SSE) ============

type BusHandler = (msg: any) => void;
const busHandlers = new Set<BusHandler>();

function busBroadcast(msg: any) {
  for (const h of busHandlers) h(msg);
}
function busSubscribe(fn: BusHandler): () => void {
  busHandlers.add(fn);
  return () => busHandlers.delete(fn);
}

/**
 * 手机端已解锁钱包的私钥 —— 私钥隔离: 只在内部签名处读取, 绝不返回给调用方/LLM.
 * 未解锁或没有钱包 → null (调用方给出人话提示).
 */
async function phonePrivateKey(walletId?: string): Promise<string | null> {
  try {
    const w: any = await import('./mobile-wallet.js');
    const st: any = await w.listWallets();
    const list: any[] = (st && st.wallets) || [];
    const target = walletId ? list.find((x) => x.id === walletId) : list.find((x) => x.unlocked);
    if (!target || !target.unlocked) return null;
    const r: any = await w.exportWallet(target.id);
    return (r && (r.privateKey || r.priv)) || null;
  } catch { return null; }
}

// ============ P2P 消息路由: 数据同步 (data.*) vs Agent 功能 (agent.*) ============

/** 统一发送封装 (mobile-p2p), 供 data/agent 层注入 */
async function sendViaP2P(type: string, payload: string, peerId?: string): Promise<boolean> {
  try {
    const { sendMobileP2PMessage } = await import('./mobile-p2p.js');
    const agent = await import('./mobile-agent.js');
    const id = await agent.ensureIdentity();
    return await sendMobileP2PMessage(peerId || '*', type, payload, id.did);
  } catch {
    return false;
  }
}

/** 入站 P2P 消息路由 (由 network.start 的 onMobileP2PMessage 调用) */
async function routeIncomingMessage(payload: string, fromPeer: string): Promise<void> {
  try {
    // 格式: DID:<did>|type:payload  或  type:payload
    let body = payload;
    if (body.startsWith('DID:')) {
      const sep = body.indexOf('|');
      if (sep > 0) body = body.substring(sep + 1);
    }
    const colonIdx = body.indexOf(':');
    const type = colonIdx > 0 ? body.substring(0, colonIdx) : body;
    const msgBody = colonIdx > 0 ? body.substring(colonIdx + 1) : '';

    // data.* → 数据同步层
    if (type.startsWith('data.')) {
      const dataLayer = await import('./mobile-data.js');
      await dataLayer.handleIncomingDataMessage(type, msgBody, fromPeer);
      return;
    }
    // 社交/服务注册协议 → 自动社交层
    if (/^(registry\.|agent\.hello)/.test(type)) {
      try {
        const social = await import('./mobile-social.js');
        const ag = await import('./mobile-agent.js');
        const id = await ag.ensureIdentity();
        await social.handleSocialMessage(type, msgBody, fromPeer, { ownDid: id.did, send: sendViaP2P, store: social.getDefaultSocialStore() });
      } catch { /* 社交消息失败不影响其它路由 */ }
      return;
    }
    // agent.* → Agent 功能层
    if (type.startsWith('agent.')) {
      const agentLayer = await import('./mobile-agent.js');
      await agentLayer.handleIncomingAgentMessage(type, msgBody, fromPeer);
      return;
    }
    // phone.* → 手机自治控制面 (独立于桌面 AgentLoop)
    if (type.startsWith('phone.')) {
      const agentLayer = await import('./mobile-agent.js');
      await agentLayer.handleIncomingPhoneMessage(type, msgBody, fromPeer);
      return;
    }
  } catch { /* 路由失败静默 */ }
}

// ============ 深链 (bolloon://) — iOS 系统入口 (Siri / 快捷指令 / Spotlight) ============
// 协议与 ios/App/App/BolloonIntents.swift 一一对应:
//   bolloon://agent/run?name=<name>[&goal=<text>]   运行智能体
//   bolloon://agent/status?name=<name>              查看智能体状态
// 这里只做**纯解析** (不抛异常, 非法就 ok:false);
// 具体打开哪个页面由 mobile.js 的 handleDeepLinkUrl() 决定 (它在 window 上监听原生事件).

export interface DeepLinkResult {
  ok: boolean;
  action?: 'run' | 'status';
  name?: string;
  goal?: string;
  error?: string;
}

/** 解析 bolloon:// 深链; 非法/不认识的 URL → {ok:false,error}, 绝不抛。 */
export function handleDeepLink(rawUrl: unknown): DeepLinkResult {
  try {
    const raw = String(rawUrl ?? '').trim();
    if (!raw) return { ok: false, error: '空链接' };
    const m = /^bolloon:\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?/i.exec(raw);
    if (!m) return { ok: false, error: '不是 bolloon:// 链接' };
    const host = (m[1] || '').toLowerCase();
    const pathSeg = (m[2] || '').replace(/^\/+/, '').split('/')[0].toLowerCase();
    const actionRaw = pathSeg || host;
    if (actionRaw !== 'run' && actionRaw !== 'status') {
      return { ok: false, error: '不认识的 action: ' + (actionRaw || '(空)') };
    }
    if (pathSeg && host !== 'agent') return { ok: false, error: '不认识的 host: ' + host };
    const action = actionRaw as 'run' | 'status';
    let name = '';
    let goal = '';
    for (const pair of (m[3] || '').split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decodeURIComponent((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' '));
      const v = (eq >= 0 ? pair.slice(eq + 1) : '').replace(/\+/g, ' ');
      if (k === 'name') name = decodeURIComponent(v);
      else if (k === 'goal') goal = decodeURIComponent(v);
    }
    const out: DeepLinkResult = { ok: true, action, name };
    if (goal) out.goal = goal;
    return out;
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ============ 内核 API (mobile.js 对接面, 路由到 data/agent 层) ============

export const core = {
  /** 路径 → 内核函数 (mobile.js api.get fallback 链) */
  resolve(path: string): (() => Promise<any>) | null {
    const p = path || '';
    if (p === '/channels') return () => core.channels.get();
    if (p === '/api/peers') return () => core.peers.list();
    if (p === '/api/mcp/tools') return () => core.mcp.tools();
    if (p === '/api/auth/status') return () => core.identity.status();
    if (p === '/api/payments/pending') return () => core.payments.pending();
    if (p === '/api/llm-config') return () => core.data.getLlmConfig();
    if (p === '/api/network/status') return () => core.network.status();
    if (p === '/api/network/desktop-addrs') return () => core.network.desktopAddrs();
    if (p === '/api/social/discover') return () => core.social.discover();
    if (p === '/api/chain/config') return () => core.chain.config();
    if (p === '/api/ipfs/config') return () => core.ipfs.config();
    // 深链探针: GET /api/deeplink?url=<encodeURIComponent(bolloon://...)> → DeepLinkResult
    if (p === '/api/deeplink' || p.startsWith('/api/deeplink?')) {
      const q = p.indexOf('?');
      let urlParam = '';
      for (const pair of (q >= 0 ? p.slice(q + 1) : '').split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if ((eq >= 0 ? pair.slice(0, eq) : pair) !== 'url') continue;
        const v = eq >= 0 ? pair.slice(eq + 1) : '';
        try { urlParam = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { urlParam = v; }
      }
      return () => Promise.resolve(handleDeepLink(urlParam));
    }
    if (p === '/api/helia/status') return () => core.helia.status();
    if (p === '/api/social/status') return () => core.social.status();
    if (p === '/api/trade/trades') return () => core.trade.trades();
    if (p === '/api/wallet/status') return () => core.wallet.status();
    if (p === '/api/wallet/balance') return () => core.wallet.balance();
    // 电脑端数据同步 (登录后/手动): 快照 + 状态 + 判断力缓存
    if (p === '/api/desktop/status') return () => core.desktop.status();
    if (p === '/api/desktop/url') return () => core.desktop.url();
    if (p === '/api/desktop/sync') return () => core.desktop.sync();
    if (p === '/api/judgments/cached') return () => core.desktop.judgments();
    // OrbitDB 本地副本 (库级复制)
    if (p === '/api/orbit/status') return () => core.orbit.status();
    if (p === '/api/orbit/replica') return () => core.orbit.replica();
    if (p.startsWith('/sessions/')) {
      const cid = decodeURIComponent(p.slice('/sessions/'.length));
      return () => core.session.get(cid);
    }
    return null;
  },

  /** POST 路径 → 内核函数 */
  resolvePost(path: string, body: any): (() => Promise<any>) | null {
    const p = path || '';
    if (p === '/message') {
      const b = body || {};
      return () => core.message.send({ text: b.text, channelId: b.channelId });
    }
    if (p === '/api/auth/logout') return () => core.identity.logout();
    if (p === '/api/auth/login') { const b = body || {}; return () => core.identity.login(String(b.name || '')); }
    if (p === '/api/wallet/export') { const b = body || {}; return () => core.wallet.export(String(b.id || '')); }
    if (p === '/api/phone/agent/run') {
      const b = body || {};
      const agentLayer = () => import('./mobile-agent.js');
      return async () => {
        const a = await agentLayer();
        return a.runPhoneAgent(String(b.goal || ''));
      };
    }
    if (p === '/api/phone/agent/cancel') {
      const b = body || {};
      const agentLayer = () => import('./mobile-agent.js');
      return async () => {
        const a = await agentLayer();
        return a.cancelPhoneAgent(String(b.reason || '本地取消'));
      };
    }
    if (p.startsWith('/api/payments/') && p.endsWith('/approve')) {
      const id = p.slice('/api/payments/'.length, -'/approve'.length);
      return () => core.payments.approve(id);
    }
    if (p.startsWith('/api/payments/') && p.endsWith('/reject')) {
      const id = p.slice('/api/payments/'.length, -'/reject'.length);
      return () => core.payments.reject(id);
    }
    if (p === '/api/peers/add') {
      const b = body || {};
      return () => core.peers.add(String(b.addr || b.address || ''));
    }
    if (p === '/api/channels/create') {
      const b = body || {};
      return () => core.channels.createLocalAgent(String(b.name || ''));
    }
    if (p === '/api/channels/delete') {
      const b = body || {};
      return () => core.channels.delete(String(b.id || ''));
    }
    if (p === '/api/channels/rename') {
      const b = body || {};
      return () => core.channels.rename(String(b.id || ''), String(b.name || ''));
    }
    if (p === '/api/llm-config') {
      const b = body || {};
      return async () => {
        await core.data.saveLlmConfig(b);
        const a = await import('./mobile-agent.js');
        const d = await import('./mobile-data.js');
        const active = d.activeProviderConfig(b);
        a.setLlmConfig(active);
        busBroadcast({ type: 'llm-config-synced', provider: b.activeProvider, model: active.model || '' });
        return { ok: true };
      };
    }
    if (p === '/api/wallet/create') {
      const b = body || {};
      return () => core.wallet.create(String(b.name || ''), String(b.mode || 'auto'), b.pass ? String(b.pass) : undefined);
    }
    if (p === '/api/wallet/import') {
      const b = body || {};
      return () => core.wallet.import(String(b.input || ''), String(b.name || ''), String(b.mode || 'auto'), b.pass ? String(b.pass) : undefined);
    }
    if (p === '/api/wallet/unlock') {
      const b = body || {};
      return () => core.wallet.unlock(String(b.id || ''), String(b.pass || ''));
    }
    if (p === '/api/wallet/lock') {
      const b = body || {};
      return () => core.wallet.lock(String(b.id || ''));
    }
    if (p === '/api/wallet/grant') {
      const b = body || {};
      return () => core.wallet.grant(String(b.id || ''), String(b.agentId || ''), !!b.allow);
    }
    if (p === '/api/desktop/url') {
      const b = body || {};
      return () => core.desktop.setUrl(String(b.url || ''));
    }
    if (p === '/api/network/connect') return () => core.network.connect();
    if (p === '/api/social/announce') return () => core.social.announce();
    if (p === '/api/chain/config') { const b = body || {}; return () => core.chain.config(b); }
    if (p === '/api/ipfs/config') { const b = body || {}; return () => core.ipfs.setConfig(b); }
    if (p === '/api/helia/enabled') { const b = body || {}; return () => core.helia.setEnabled(!!b.enabled); }
    if (p === '/api/helia/add') { const b = body || {}; return () => core.helia.add(b.value); }
    if (p === '/api/helia/get') { const b = body || {}; return () => core.helia.get(String(b.cid || '')); }
    if (p === '/api/helia/start') return () => core.helia.start();
    if (p === '/api/helia/stop') return () => core.helia.stop();
    if (p === '/api/ipfs/upload') { const b = body || {}; return () => core.ipfs.upload(String(b.content ?? ''), b.name ? String(b.name) : undefined); }
    if (p === '/api/ipfs/fetch') { const b = body || {}; return () => core.ipfs.fetch(String(b.cid || '')); }
    if (p === '/api/ipfs/cid') { const b = body || {}; return () => core.ipfs.cid(b.value); }
    if (p === '/api/chain/x402-sign') { const b = body || {}; return () => core.chain.signX402(b); }
    if (p === '/api/chain/transfer') { const b = body || {}; return () => core.chain.transfer(b); }
    if (p === '/api/chain/register') { const b = body || {}; return () => core.chain.register(b); }
    if (p === '/api/trade/call') {
      const b = body || {};
      return async () => {
        const t = await import('./mobile-trade.js');
        const w = await import('./mobile-wallet.js');
        const out: any = await t.callService({
          service: b.service,
          request: b.request || {},
          deps: {
            fetchImpl: fetch,
            walletForAgent: (aid: string) => w.walletForAgent(aid),
            getPrivateKey: async (id: string) => { const r: any = await w.exportWallet(id); return r && (r.privateKey || r.priv); },
            // 手机端独立支付: 自己签 x402 授权 (EIP-712/EIP-3009, 无需 gas 无需电脑端)
            payFn: async (spec: any) => {
              const pk = await phonePrivateKey(b.walletId);
              if (!pk) return { success: false, error: '手机钱包未解锁 (我 → 钱包 → 解锁后重试)' };
              const c: any = await import('./mobile-chain.js');
              const sig: any = await c.signX402Authorization({
                privateKey: pk,
                to: spec.to || spec.payTo,
                amount: String(spec.amount ?? ''),
                currency: spec.currency,
                network: spec.network,
              });
              if (!sig || sig.ok === false) return { success: false, error: (sig && sig.error) || 'x402 签名失败' };
              return { success: true, header: sig.header, signature: sig.signature, authorization: sig.authorization };
            },
            policy: b.policy,
          },
        });
        // PROOF 阶段 (协议): 结果算 CID + 尽力上远端 IPFS, 便于别人按 CID 取且可校验
        if (out && out.ok) {
          try {
            const i: any = await import('./mobile-ipfs.js');
            const cid = await i.resultCid(out.result);
            out.resultCid = cid;
            const up: any = await i.ipfsUpload(JSON.stringify(out.result ?? null), 'bolloon-result');
            out.proof = up && up.ok ? { cid: up.cid, provider: up.provider } : { cid, local: true };
          } catch { /* PROOF 失败不影响交易结果 */ }
        }
        return out;
      };
    }
    if (p === '/api/trade/settle') {
      const b = body || {};
      return async () => {
        const t = await import('./mobile-trade.js');
        return t.settleAndRate({ ok: b.ok, service: b.service });
      };
    }
    if (p === '/api/desktop/sync') return () => core.desktop.sync();
    if (p === '/api/orbit/put') {
      const b = body || {};
      return () => core.orbit.put(String(b.name || ''), String(b.key || ''), b.value);
    }
    if (p === '/api/orbit/replicate') return () => core.orbit.replicate();
    if (p === '/api/wallet/balance') {
      const b = body || {};
      return () => core.wallet.balance(b.id ? String(b.id) : undefined);
    }
    if (p === '/api/wallet/agent') {
      const b = body || {};
      return () => core.wallet.forAgent(String(b.agentId || ''));
    }
    return null;
  },

  /** P2P 网络 — 启动浏览器 libp2p 节点, 并注入 data/agent 两层传输 */
  network: {
    /** 电脑端可拨的 P2P ws 地址 (手机不能 listen, 展示+连接用) */
    async desktopAddrs(): Promise<any> { const s = await import('./mobile-sync.js'); return s.desktopP2PAddrs(); },
    /** 连接: start() 内部会自动向电脑端要地址 (无种子时) */
    async connect(): Promise<any> { return core.network.start(); },
    async start(seedAddrs?: string[]): Promise<any> {
      try {
        const { startMobileP2P, getMobileP2PState, onMobileP2PMessage } = await import('./mobile-p2p.js');
        const agentLayer = await import('./mobile-agent.js');
        const dataLayer = await import('./mobile-data.js');

        const id = await agentLayer.ensureIdentity();
        // 手机(WebView)不能 listen → 没有种子时必须向电脑端要可拨地址, 否则节点起来了也没有任何连接
        let seeds = seedAddrs && seedAddrs.length ? seedAddrs : undefined;
        let relayAddrs: string[] | undefined;
        let desktopPeer = '';
        if (!seeds) {
          try {
            const sync = await import('./mobile-sync.js');
            const d = await sync.desktopP2PAddrs();
            if (d.ok && d.addrs.length) { seeds = d.addrs; desktopPeer = d.peerId || ''; }
            // 2026-09-11: 电脑端是中继 → 拿 relayAddrs 显式预约, 手机才有可拨入地址
            if (d.ok && Array.isArray(d.relayAddrs) && d.relayAddrs.length) relayAddrs = d.relayAddrs;
          } catch { /* 电脑端不可达 → 单机模式 */ }
        }
        const st = await startMobileP2P({ seedAddrs: seeds, ownDid: id.did, relayAddrs });
        if (desktopPeer) busBroadcast({ type: 'p2p-desktop', peerId: desktopPeer, addrs: seeds || [] });
        // 自动社交 (E1 DISCOVERY): 广播自身服务声明 + 欢迎已连对端 + 心跳 (协议 5 分钟)
        try {
          const social = await import('./mobile-social.js');
          const syncMod = await import('./mobile-sync.js');
          const sStore = social.createLocalStorageStore();
          const desktopUrl = syncMod.getDesktopUrl();
          social.announceSelf({ ownDid: id.did, ownName: id.name, send: sendViaP2P, peerId: desktopPeer || '*', desktopUrl, fetchImpl: fetch, store: sStore }).catch(() => {});
          for (const pid of (st.peerIds || [])) {
            social.onPeerConnected(pid, { ownDid: id.did, send: sendViaP2P, store: sStore }).catch(() => {});
          }
          setInterval(() => {
            social.heartbeat({ ownDid: id.did, send: sendViaP2P, peerId: desktopPeer || '*', desktopUrl, fetchImpl: fetch, store: sStore }).catch(() => {});
          }, social.DEFAULT_HEARTBEAT_MS);
          busBroadcast({ type: 'social-started' });
        } catch { /* 社交层不可用不影响基础连接 */ }

        // 注入传输: data/agent 两层用同一发送通道
        dataLayer.setDataTransport((type, payload, peerId) => sendViaP2P(type, payload, peerId));
        agentLayer.setAgentTransport((type, payload, peerId) => sendViaP2P(type, payload, peerId), id.did);

        // LLM 配置同步: 桌面 data.llm-config.reply 到达 → 提取 active provider 注入 agent 层
        dataLayer.onLlmConfig(async (cfg) => {
          const active = dataLayer.activeProviderConfig(cfg);
          agentLayer.setLlmConfig(active);
          busBroadcast({ type: 'llm-config-synced', provider: cfg.activeProvider, model: active.model || '' });
        });

        // 入站对端 chat → 数据层写入对端消息 + 事件广播 (对端 on-device 消息同步)
        agentLayer.onInboundChat((text, channelId, fromPeer) => {
          dataLayer.appendMessage(channelId, { role: 'ai', content: text, ts: Date.now(), from: fromPeer })
            .then(() => {
              busBroadcast({ type: 'ai', channelId, content: text, role: 'ai', from: fromPeer });
              busBroadcast({ type: 'done', channelId });
            })
            .catch(() => {});
        });

        // P2P 入站消息 → 路由 (data.* / agent.* 分开处理)
        onMobileP2PMessage((payload, fromPeer) => {
          routeIncomingMessage(payload, fromPeer).catch(() => {});
        });

        // 连上种子后尝试同步一次 (data 层) + 请求桌面 LLM 配置
        st.peerIds?.slice(0, 1).forEach((pid: string) => {
          dataLayer.syncFromPeer(pid).then((s) => {
            if (s.mode === 'online') {
              busBroadcast({ type: 'data-synced', mergedChannels: s.mergedChannels, mergedSessions: s.mergedSessions });
            }
          }).catch(() => {});
          // LLM 配置: 请求桌面同步 (未同步时默认手机端, 由 mobile-agent 内置处理)
          dataLayer.requestLlmConfigFromPeer(pid).catch(() => {});
        });

        return getMobileP2PState();
      } catch (e: any) {
        return { connected: false, peerCount: 0, peerIds: [], error: String(e?.message || e).slice(0, 100) };
      }
    },
    status(): any {
      try {
        const m = (globalThis as any).__mobileP2PStateSync;
        if (m) return m();
        return { connected: false, peerCount: 0, peerIds: [], hint: 'P2P 未启动 (network.start 启动)' };
      } catch { return { connected: false, peerCount: 0, peerIds: [] }; }
    },
  },

  events: {
    subscribe: busSubscribe,
  },

  /** 数据同步层 (独立子系统 #1): 存储 + 同步 */
  data: {
    async getChannels() { const d = await import('./mobile-data.js'); return d.getChannels(); },
    async getSession(channelId: string) { const d = await import('./mobile-data.js'); const s = await d.getSession(channelId); return { messages: s.messages }; },
    async appendMessage(channelId: string, msg: any) { const d = await import('./mobile-data.js'); await d.appendMessage(channelId, msg); },
    async snapshot() { const d = await import('./mobile-data.js'); return d.snapshot(); },
    async syncFromPeer(peerId: string) { const d = await import('./mobile-data.js'); return d.syncFromPeer(peerId); },
    async pushLocal() { const d = await import('./mobile-data.js'); return d.pushLocal(); },
    async getLlmConfig() { const d = await import('./mobile-data.js'); return d.getLlmConfig(); },
    async saveLlmConfig(cfg: any) { const d = await import('./mobile-data.js'); await d.saveLlmConfig(cfg); },
    status() { const d = Promise.resolve(import('./mobile-data.js')); return d; },
  },

  channels: {
    async get(): Promise<any[]> {
      const d = await import('./mobile-data.js');
      return d.getChannels();
    },
    async save(channels: any[]): Promise<void> {
      const d = await import('./mobile-data.js');
      await d.saveChannels(channels);
      busBroadcast({ type: 'channels-updated', count: channels.length });
    },
    async createLocalAgent(name?: string): Promise<any> {
      const d = await import('./mobile-data.js');
      const a = await import('./mobile-agent.js');
      const id = await a.ensureIdentity();
      const existing = await d.getChannels();
      const label = (name || '').trim() || ('本地智能体 ' + (existing.length + 1));
      const ch = {
        id: 'local-' + Date.now(),
        name: label,
        persona: { name: label },
        agentId: id.did,
        preview: '本地新智能体',
        ts: Date.now(),
      };
      const next = [...existing, ch];
      await d.saveChannels(next);
      busBroadcast({ type: 'channels-updated', count: next.length });
      return ch;
    },
    async delete(id: string): Promise<{ ok: boolean; deleted?: number; error?: string }> {
      const d = await import('./mobile-data.js');
      const existing = await d.getChannels();
      const next = existing.filter((c: any) => c.id !== id);
      const deleted = existing.length - next.length;
      // 找不到 → 明确报告 (原实现在这里静默返回 ok, 导致"点了删除没反应也没报错")
      if (deleted === 0) return { ok: false, deleted: 0, error: '本机卡片不是会话 (请用"移除卡片")' };
      await d.saveChannels(next);
      busBroadcast({ type: 'channels-updated', count: next.length });
      return { ok: true, deleted };
    },
    async rename(id: string, name: string): Promise<{ ok: boolean; name?: string; error?: string }> {
      const d = await import('./mobile-data.js');
      const list = await d.getChannels();
      const ch: any = list.find((c: any) => c.id === id);
      if (!ch) return { ok: false, error: '本机卡片不是会话 (改名请改本机身份昵称)' };
      ch.name = name;
      if (ch.persona && typeof ch.persona === 'object') ch.persona.name = name;
      await d.saveChannels(list);
      busBroadcast({ type: 'channels-updated', count: list.length });
      return { ok: true, name };
    },
  },

  session: {
    async get(channelId: string): Promise<{ messages: any[] } | null> {
      const d = await import('./mobile-data.js');
      const s = await d.getSession(channelId);
      return { messages: s.messages };
    },
    async save(channelId: string, session: any): Promise<void> {
      const d = await import('./mobile-data.js');
      await d.saveSession({ channelId, messages: session.messages || [], updatedAt: session.updatedAt || Date.now() });
    },
  },

  identity: {
    async status(): Promise<any> { const a = await import('./mobile-agent.js'); return a.identityStatus(); },
    async login(name: string): Promise<any> { const a = await import('./mobile-agent.js'); return a.loginIdentity(name); },
    async logout(): Promise<any> { const a = await import('./mobile-agent.js'); return a.logoutIdentity(); },
  },

  peers: {
    async list(): Promise<any[]> {
      const local = await (await import('./mobile-data.js')).getChannels();
      try {
        const { getMobileP2PState } = await import('./mobile-p2p.js');
        const st = getMobileP2PState();
        const connected = (st.peerIds || []).map((pid: string) => ({
          id: pid,
          publicKey: pid,
          name: 'P2P-' + pid.slice(0, 8),
          online: true,
        }));
        return connected;
      } catch {
        return [];
      }
    },
    async save(peers: any[]): Promise<void> {
      // 通讯录暂存 (可选持久化)
    },
    async add(addr: string): Promise<any> {
      const p = await import('./mobile-p2p.js');
      return p.addMobilePeer(String(addr || ''));
    },
  },

  wallet: {
    async status(): Promise<any> { const w = await import('./mobile-wallet.js'); return w.listWallets(); },
    async create(name: string, mode: string, pass?: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.createWallet(name, mode as any, pass); },
    async import(input: string, name: string, mode: string, pass?: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.importWallet(input, name, mode as any, pass); },
    async unlock(id: string, pass: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.unlockWallet(id, pass); },
    async lock(id: string): Promise<any> { const w = await import('./mobile-wallet.js'); w.lockWallet(id); return { ok: true }; },
    async grant(id: string, agentId: string, allow: boolean): Promise<any> { const w = await import('./mobile-wallet.js'); return w.grantWallet(id, agentId, allow); },
    async forAgent(agentId: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.walletForAgent(agentId); },
    async balance(id?: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.walletBalance(id); },
    async export(id: string): Promise<any> { const w = await import('./mobile-wallet.js'); return w.exportWallet(id); },
  },

  // 电脑端数据同步: 登录后拉取电脑端 bolloon 全部数据 (快照 → 本地)
  desktop: {
    async url(): Promise<any> { const s = await import('./mobile-sync.js'); return { url: s.getDesktopUrl() }; },
    async setUrl(url: string): Promise<any> { const s = await import('./mobile-sync.js'); s.setDesktopUrl(url); return { ok: true, url: s.getDesktopUrl() }; },
    async sync(): Promise<any> { const s = await import('./mobile-sync.js'); return s.syncFromDesktop(); },
    async status(): Promise<any> { const s = await import('./mobile-sync.js'); return s.getSyncStatus(); },
    async judgments(): Promise<any> { const s = await import('./mobile-sync.js'); return { judgments: s.getCachedJudgments() }; },
  },

  // 自动社交 (E1): 服务声明广播 / 发现 / 心跳 — 协议见 docs/wiki/agent-economic-protocol.md
  social: {
    async announce(): Promise<any> {
      const s = await import('./mobile-social.js');
      const ag = await import('./mobile-agent.js');
      const syncMod = await import('./mobile-sync.js');
      const id = await ag.ensureIdentity();
      return s.announceSelf({ ownDid: id.did, ownName: id.name, send: sendViaP2P, peerId: '*', desktopUrl: syncMod.getDesktopUrl(), fetchImpl: fetch, store: s.createLocalStorageStore(), force: true });
    },
    async discover(query?: string): Promise<any> {
      const s = await import('./mobile-social.js');
      const ag = await import('./mobile-agent.js');
      const syncMod = await import('./mobile-sync.js');
      const id = await ag.ensureIdentity();
      return s.discoverAgents({ ownDid: id.did, ownName: id.name, query, send: sendViaP2P, desktopUrl: syncMod.getDesktopUrl(), fetchImpl: fetch, store: s.createLocalStorageStore() });
    },
    async status(): Promise<any> {
      const s = await import('./mobile-social.js');
      return s.getHeartbeatState(s.createLocalStorageStore());
    },
  },

  // 手机端独立链上能力 (自己签名/发交易, 不需要电脑端; 需在设置里配 RPC)
  chain: {
    async config(cfg?: any): Promise<any> {
      const c: any = await import('./mobile-chain.js');
      return cfg ? c.setChainConfig(cfg) : c.getChainConfig();
    },
    async signX402(opts: any): Promise<any> {
      const pk = await phonePrivateKey(opts.walletId);
      if (!pk) return { ok: false, error: '手机钱包未解锁' };
      const c: any = await import('./mobile-chain.js');
      const r = await c.signX402Authorization({ ...opts, privateKey: pk });
      return r && r.ok ? { ok: true, header: r.header, authorization: r.authorization } : { ok: false, error: r && r.error };
    },
    async transfer(opts: any): Promise<any> {
      const pk = await phonePrivateKey(opts.walletId);
      if (!pk) return { ok: false, error: '手机钱包未解锁' };
      const c: any = await import('./mobile-chain.js');
      return c.erc20Transfer({ ...opts, privateKey: pk });
    },
    async register(opts: any): Promise<any> {
      const pk = await phonePrivateKey(opts.walletId);
      if (!pk) return { ok: false, error: '手机钱包未解锁' };
      const c: any = await import('./mobile-chain.js');
      return c.registerServiceOnChain({ ...opts, privateKey: pk });
    },
  },

  // 本机 IPFS 节点 (Helia + js-libp2p, 真节点: PeerID/blockstore/bitswap)
  //   注意: WebView 不能 listen → 只能拨出; iOS 后台会挂起 → 只在前台在线
  helia: {
    async status(): Promise<any> {
      const h: any = await import('./mobile-helia.js');
      const st = await h.heliaStatus();
      return { ...(st || {}), enabled: h.heliaEnabled() };
    },
    async add(value: any): Promise<any> { const h: any = await import('./mobile-helia.js'); return h.heliaAddJson(value); },
    async get(cid: string): Promise<any> { const h: any = await import('./mobile-helia.js'); return h.heliaGetJson(cid); },
    async start(): Promise<any> { const h: any = await import('./mobile-helia.js'); const r = await h.startMobileHelia(); if (r && r.ok) h.setHeliaEnabled(true); return r; },
    async stop(): Promise<any> { const h: any = await import('./mobile-helia.js'); const r = await h.stopMobileHelia(); h.setHeliaEnabled(false); return r; },
    async setEnabled(enabled: boolean): Promise<any> {
      const h: any = await import('./mobile-helia.js');
      h.setHeliaEnabled(enabled);
      return enabled ? h.startMobileHelia() : h.stopMobileHelia();
    },
  },

  // IPFS (协议 PROOF/资源存储): 本地算验 CID + 远端读写 + 网关回退
  ipfs: {
    async config(cfg?: any): Promise<any> { const i: any = await import('./mobile-ipfs.js'); return cfg ? i.setIpfsConfig(cfg) : i.getIpfsConfig(); },
    async setConfig(cfg: any): Promise<any> { const i: any = await import('./mobile-ipfs.js'); return i.setIpfsConfig(cfg); },
    async upload(content: string, name?: string): Promise<any> { const i: any = await import('./mobile-ipfs.js'); return i.ipfsUpload(content, name); },
    async fetch(cid: string): Promise<any> { const i: any = await import('./mobile-ipfs.js'); return i.ipfsFetch(cid); },
    async cid(value: any): Promise<any> { const i: any = await import('./mobile-ipfs.js'); return { ok: true, cid: await i.computeCid(value) }; },
  },

  // 资源交易 (E2/E3/E4): 402 → 策略 → 支付 → 结果 → 信誉
  trade: {
    async trades(limit?: number): Promise<any> { const t = await import('./mobile-trade.js'); return { trades: t.listTrades(undefined, limit ? { limit } : undefined) }; },
  },

  // OrbitDB 本地副本 (库级复制): 手机端持有与电脑端同地址 store 的副本, 离线可读
  orbit: {
    async status(): Promise<any> { const o = await import('./mobile-orbit.js'); return o.replicaStats(); },
    async replica(): Promise<any> {
      const o = await import('./mobile-orbit.js');
      const stores = o.replicaNames().map((n) => {
        const r = o.getReplica(n);
        return { name: n, address: r.address, count: Object.keys(r.entries).length, entries: o.replicaAll(n) };
      });
      return { stats: o.replicaStats(), stores };
    },
    async put(name: string, key: string, value: any): Promise<any> {
      const o = await import('./mobile-orbit.js');
      o.replicaPut(name, key, value);
      return { ok: true, stats: o.replicaStats() };
    },
    async replicate(): Promise<any> { const s = await import('./mobile-sync.js'); return s.replicateOrbit(); },
  },

  mcp: {
    async tools(): Promise<any[]> {
      return [
        { name: 'gateway_status', description: '查看 Agent 网络状态 (已注册服务 + 信誉)' },
        { name: 'gateway_register', description: '把本 Agent 注册为服务提供者' },
        { name: 'gateway_call', description: '通过 Agent Gateway 调用服务 (自动闭环)' },
        { name: 'gateway_join', description: '通过链接加入共享 Agent 网络' },
      ];
    },
  },

  message: {
    async send({ text, channelId }: { text: string; channelId: string }): Promise<{ ok: boolean; error?: string }> {
      if (!text || !channelId) return { ok: false, error: 'text 和 channelId 必填' };
      const dataLayer = await import('./mobile-data.js');
      const agentLayer = await import('./mobile-agent.js');

      // 1. 数据层: 记录用户消息 (独立副本)
      await dataLayer.appendMessage(channelId, { role: 'user', content: text, ts: Date.now() });
      busBroadcast({ type: 'loop-status', status: 'loading', message: '智能体开始工作...' });
      busBroadcast({ type: 'user', channelId, content: text });
      busBroadcast({ type: 'done', channelId });

      // 2. 通知其他节点 (各自 on-device 处理, 不等回复; 失败静默单机)
      try {
        const { sendMobileP2PMessage } = await import('./mobile-p2p.js');
        const id = await agentLayer.ensureIdentity();
        sendMobileP2PMessage('*', 'agent.chat.send', JSON.stringify({ text, channelId, fromPublicKey: id.did }), id.did).catch(() => {});
      } catch { /* P2P 未就绪则单机 */ }

      // 3. Agent 层: 手机 on-device 执行 (Kotlin AgentRuntime, 离线内置规则)
      try {
        busBroadcast({ type: 'loop-status', status: 'loading', message: '正在调用 AgentRuntime...' });
        const reply = await agentLayer.runLocalAgent(text);
        await dataLayer.appendMessage(channelId, { role: 'ai', content: reply, ts: Date.now() });
        busBroadcast({ type: 'loop-status', status: 'done', message: '执行完成' });
        busBroadcast({ type: 'ai', channelId, content: reply, role: 'ai' });
        busBroadcast({ type: 'done', channelId });
        // 执行过程摘要 (每步 onStep) → 工作记录 UI
        const wl = (agentLayer.getLastWorklog && agentLayer.getLastWorklog()) || [];
        if (wl.length) busBroadcast({ type: 'agent-worklog', lines: wl });
      } catch (e: any) {
        busBroadcast({ type: 'loop-status', status: 'done', message: '执行失败: ' + (e?.message || '').slice(0, 80) });
        busBroadcast({ type: 'ai', channelId, content: '（本地 Agent 未就绪: ' + String(e?.message || e).slice(0, 80) + '）', role: 'ai' });
        busBroadcast({ type: 'done', channelId });
      }
      return { ok: true };
    },
  },

  phone: {
    async run(goal: string) {
      const a = await import('./mobile-agent.js');
      return a.runPhoneAgent(goal);
    },
    async status() {
      const a = await import('./mobile-agent.js');
      return a.phoneStatus();
    },
    async cancel(reason?: string) {
      const a = await import('./mobile-agent.js');
      return a.cancelPhoneAgent(reason);
    },
  },

  payments: {
    async pending(): Promise<{ approvals: any[] }> {
      // 支付审批: 手机本地 (与数据同步/agent 功能并列的独立能力)
      const { loadApprovals } = await import('./mobile-payments.js');
      const all = await loadApprovals();
      return { approvals: all.filter((a: any) => !a.resolved).map(({ retryPayload, ...rest }: any) => rest) };
    },
    async approve(id: string): Promise<void> {
      const { approveApproval } = await import('./mobile-payments.js');
      await approveApproval(id, true);
      busBroadcast({ type: 'payment-approved', id });
    },
    async reject(id: string): Promise<void> {
      const { approveApproval } = await import('./mobile-payments.js');
      await approveApproval(id, false);
      busBroadcast({ type: 'payment-rejected', id });
    },
  },
  // #2 手机入网 (极简按钮入口): 懒加载 browser-safe mobile-gateway
  gateway: {
    async join(link: string): Promise<{ ok: boolean; output: string }> {
      const { mobileGatewayTool } = await import('./mobile-gateway.js');
      return mobileGatewayTool('gateway_join', { link });
    },
    async status(): Promise<{ ok: boolean; output: string }> {
      const { mobileGatewayTool } = await import('./mobile-gateway.js');
      return mobileGatewayTool('gateway_status', {});
    },
    async register(self: any): Promise<{ ok: boolean; output: string }> {
      const { mobileGatewayTool } = await import('./mobile-gateway.js');
      return mobileGatewayTool('gateway_register', { self });
    },
    async autoJoin(text: string): Promise<string | null> {
      const { mobileAutoJoinGateway } = await import('./mobile-gateway.js');
      return mobileAutoJoinGateway(text);
    },
    setDesktopBaseUrl(url: string): void {
      void import('./mobile-gateway.js').then((m) => m.setDesktopBaseUrl(url));
    },
  },
  // #3 扫码入网: 解码二维码图片 (PC /net qr 出码 → 手机拍照解码 → gateway.join)
  qr: {
    async decode(data: Uint8ClampedArray, w: number, h: number): Promise<string | null> {
      const { decodeQrImageData } = await import('./qr.js');
      return decodeQrImageData(data, w, h);
    },
  },
  // 深链解析 (bolloon://) — iOS 系统入口 (Siri / 快捷指令 / Spotlight) 走这条 (2026-09-11)
  handleDeepLink,
};

// 全局暴露给 mobile.js
if (typeof window !== 'undefined') {
  (window as any).BolloonCore = core;
}

export default core;