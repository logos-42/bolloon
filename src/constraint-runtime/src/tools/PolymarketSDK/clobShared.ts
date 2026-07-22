/**
 * Polymarket CLOB 下单/查单/撤单 共享依赖
 *
 * 真实实现基于 @polymarket/clob-client (ClobClient):
 *   - 签名用 viem WalletClient (privateKeyToAccount + polygon + http transport)
 *   - 下单前需 ApiKeyCreds (key/secret/passphrase), 由 createOrDeriveApiKey() 从签名派生
 *   - tokenID / tickSize / negRisk 来自 Gamma 市场元数据 (https://gamma-api.polymarket.com/markets/:id)
 *
 * chainId = 137 (Polygon), host = https://clob.polymarket.com
 */

import { ClobClient, OrderType, Side, ApiKeyCreds } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

export const CLOB_HOST = 'https://clob.polymarket.com';
export const CHAIN_ID = 137;

export interface PolyCreds {
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

export interface MarketMeta {
  clobTokenIds: string[];
  outcomes: string[];
  tickSize: string;
  negRisk: boolean;
}

export function normalizePrivateKey(pk: string): `0x${string}` {
  const s = pk.startsWith('0x') ? pk : `0x${pk}`;
  return s as `0x${string}`;
}

function safeParseArray(v: any): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 从 Gamma 取市场元数据: clobTokenIds / outcomes / tickSize / negRisk.
 * 优先用 Gamma 路径端点 (带 tickSize/negRisk), 失败回退 polymarket-sdk listMarkets({id}).
 */
export async function fetchMarketMeta(marketId: string): Promise<MarketMeta> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(marketId)}`);
    if (res.ok) {
      const m = await res.json();
      return {
        clobTokenIds: safeParseArray(m.clobTokenIds),
        outcomes: safeParseArray(m.outcomes),
        tickSize: typeof m.tickSize === 'string' ? m.tickSize : '0.01',
        negRisk: !!m.negRisk,
      };
    }
  } catch {
    // fall through to sdk
  }
  const { listMarkets } = await import('polymarket-sdk').catch(() => ({ listMarkets: async () => [] }));
  const ms = await listMarkets({ id: marketId });
  const m = ms?.[0];
  if (!m) throw new Error(`未找到市场: ${marketId}`);
  return {
    clobTokenIds: safeParseArray(m.clobTokenIds),
    outcomes: safeParseArray(m.outcomes),
    tickSize: '0.01',
    negRisk: false,
  };
}

/**
 * 由 outcome (如 "Yes"/"No" 或索引 0/1) 或显式 tokenId 解析出要交易的 tokenID.
 * 都不给 → 默认取第一个 clobTokenId (通常是 "Yes").
 */
export function resolveTokenId(meta: MarketMeta, tokenId?: string, outcome?: string | number): string | undefined {
  if (tokenId) return tokenId;
  if (!meta.clobTokenIds || meta.clobTokenIds.length === 0) return undefined;
  if (outcome === undefined || outcome === null) return meta.clobTokenIds[0];
  if (typeof outcome === 'number') return meta.clobTokenIds[outcome];
  const idx = meta.outcomes.findIndex((o) => String(o).toLowerCase() === String(outcome).toLowerCase());
  return idx >= 0 ? meta.clobTokenIds[idx] : undefined;
}

export interface BuildClientParams {
  privateKey: string;
  creds?: PolyCreds;
  funder?: string;
}

/**
 * 构造已鉴权的 ClobClient.
 *  - 若提供完整 apiKey/apiSecret/apiPassphrase → 直接用
 *  - 否则用签名派生 ApiKey (createOrDeriveApiKey, 需联网)
 * signatureType = 0 (EOA / 浏览器钱包, 对应原始私钥签名)
 */
export async function buildClobClient(params: BuildClientParams): Promise<{ client: ClobClient; address: string }> {
  const account = privateKeyToAccount(normalizePrivateKey(params.privateKey));
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const address = account.address;

  let creds: ApiKeyCreds | undefined;
  if (params.creds?.apiKey && params.creds?.apiSecret && params.creds?.apiPassphrase) {
    creds = { key: params.creds.apiKey, secret: params.creds.apiSecret, passphrase: params.creds.apiPassphrase };
  }
  if (!creds) {
    const tmp = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    creds = await tmp.createOrDeriveApiKey();
  }
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, 0, params.funder ?? address);
  return { client, address };
}

export { OrderType, Side };
