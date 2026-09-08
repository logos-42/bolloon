// ─── 网络链接纯函数 (无 Node 依赖, 桌面/手机浏览器共用) ────────────────────
//   parseNetworkLink / detectGatewayLink 从 gateway-network.ts 抽出,
//   供 browser 端 (mobile-gateway) 复用, 不拖 OrbitDB/fs 进 WebView.

export type NetworkLinkKind = 'ipns' | 'orbitdb' | 'http';

export interface ParsedNetworkLink {
  kind: NetworkLinkKind;
  /** ipns: name; orbitdb: address(/orbitdb/<addr>); http: url */
  value: string;
  url?: string;
  name?: string;
  networkName?: string;
}

/** 解析链接字符串 → ParsedNetworkLink (剥离 ?name= query) */
export function parseNetworkLink(link: string): ParsedNetworkLink | null {
  const l = String(link || '').trim();
  if (!l) return null;
  const [base, query] = l.split('?');
  let networkName: string | undefined;
  try {
    networkName = query ? (new URLSearchParams(query).get('name') || undefined) : undefined;
  } catch { /* 忽略坏 query */ }
  if (base.startsWith('ipns://')) return { kind: 'ipns', value: base.slice('ipns://'.length), url: base, networkName };
  if (base.startsWith('orbitdb://')) {
    let address = base.slice('orbitdb://'.length);
    if (!address.startsWith('/')) address = `/${address}`;
    return { kind: 'orbitdb', value: address, url: base, networkName };
  }
  if (base.startsWith('http://') || base.startsWith('https://')) return { kind: 'http', value: base, url: base, networkName };
  return null;
}

/** 从消息文本检测 gateway 链接 (自动加入触发器用) */
export function detectGatewayLink(text: string): string | null {
  const t = String(text || '');
  const re = /(orbitdb:\/\/\/?orbitdb\/[^\s)'"<>，。；]+|ipns:\/\/[^\s)'"<>，。；]+|https?:\/\/[^\s)'"<>，。；]*\/registry(?:\?[^\s)'"<>，。；]*)?)/;
  const m = re.exec(t);
  return m ? m[1].trim() : null;
}
