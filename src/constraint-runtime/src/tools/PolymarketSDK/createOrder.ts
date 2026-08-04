import { OrderSide, buildSecureClient, fetchMarketMeta, resolveTokenId } from './clobShared.js';

export interface CreateOrderParams {
  /** 下单钱包私钥 (0x...), 用于 EIP-712 订单签名 */
  privateKey: string;
  /** 市场 ID (condition id) */
  marketId: string;
  side: 'BUY' | 'SELL';
  /** 限价 0-1, 需符合市场 tickSize */
  price: number;
  /** 数量 (买单=花费 pUSD 份额, 卖单=卖出份额) */
  size: number;
  /** 显式 tokenID (优先于 outcome) */
  tokenId?: string;
  /** outcome: "Yes"/"No" 或索引 0/1, 默认取第一个 (通常是 Yes) */
  outcome?: string | number;
  /** 已存在的 API key (兼容保留, 新 SDK 不需要) */
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  /** 资金地址 (默认 = 私钥地址) */
  funder?: string;
  orderType?: 'GTC' | 'GTD';
}

export interface CreateOrderResult {
  success: boolean;
  message?: string;
  orderId?: string;
  status?: string;
  raw?: any;
}

/** 限价单下单 (@polymarket/client 统一 SDK placeLimitOrder, 2026-08-04 迁移). */
export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  if (!params.privateKey) {
    return { success: false, message: '下单需要提供钱包私钥 privateKey (用于 EIP-712 订单签名)' };
  }
  if (!params.marketId) {
    return { success: false, message: 'marketId 必填' };
  }
  try {
    const meta = await fetchMarketMeta(params.marketId);
    const tokenID = resolveTokenId(meta, params.tokenId, params.outcome);
    if (!tokenID) {
      return { success: false, message: '无法解析 tokenID (outcome 不匹配或市场无 clobTokenIds)' };
    }
    const { client } = await buildSecureClient({ privateKey: params.privateKey, funder: params.funder });
    const resp: any = await client.placeLimitOrder({
      tokenId: tokenID,
      price: Number(params.price),
      size: Number(params.size),
      side: params.side === 'SELL' ? OrderSide.SELL : OrderSide.BUY,
    });
    return {
      success: true,
      orderId: resp?.orderId ?? resp?.id,
      status: resp?.status ?? resp?.orderStatus,
      raw: resp,
    };
  } catch (e: any) {
    return { success: false, message: `下单失败: ${e?.message || e}` };
  }
}
