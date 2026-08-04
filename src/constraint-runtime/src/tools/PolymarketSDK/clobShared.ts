/**
 * Polymarket 下单/查单/撤单 共享依赖
 *
 * 2026-08-04: 迁移到官方统一 SDK @polymarket/client (替代已弃用的 @polymarket/clob-client + polymarket-sdk)
 *   - 公开数据: createPublicClient() → listMarkets / fetchMarket / fetchOrderBook
 *   - 交易: createSecureClient({ signer: privateKey(pk) }) → placeLimitOrder / cancelOrder / listOpenOrders
 *   - 签名走 SDK 内部 (EIP-712), 无需手动派生 API key
 *
 * chainId = 137 (Polygon), host = https://clob.polymarket.com
 */

import { createSecureClient, OrderSide } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { privateKeyToAccount } from 'viem/accounts';

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
 */
export async function fetchMarketMeta(marketId: string): Promise<MarketMeta> {
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
  throw new Error(`Gamma 市场元数据获取失败 (HTTP ${res.status}): ${marketId}`);
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
 * 构造已鉴权的 SecureClient (@polymarket/client 统一 SDK).
 * 签名/鉴权全在 SDK 内部处理, creds (旧式 API key) 参数保留兼容但不再需要.
 */
export async function buildSecureClient(params: BuildClientParams): Promise<{ client: any; address: string }> {
  const pk = normalizePrivateKey(params.privateKey);
  const account = privateKeyToAccount(pk);
  const client = await createSecureClient({ signer: privateKey(pk) });
  return { client, address: account.address };
}

/** 兼容旧名 (老调用方) */
export const buildClobClient = buildSecureClient;

export { OrderSide };
