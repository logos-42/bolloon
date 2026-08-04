import { buildSecureClient } from './clobShared.js';

export interface GetOrdersParams {
  /** 查询订单的钱包私钥 */
  privateKey?: string;
  /** 按市场 ID 过滤 (可选) */
  marketId?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  funder?: string;
}

export interface GetOrdersResult {
  orders: any[];
  message: string;
}

/** 查未成交订单 (@polymarket/client 统一 SDK listOpenOrders, 2026-08-04 迁移). */
export async function getOrders(params: GetOrdersParams = {}): Promise<GetOrdersResult> {
  if (!params.privateKey) {
    return { orders: [], message: '查询订单需要提供钱包私钥 privateKey' };
  }
  try {
    const { client } = await buildSecureClient({ privateKey: params.privateKey, funder: params.funder });
    const pages = client.listOpenOrders(params.marketId ? { marketId: params.marketId } : {});
    const page = await pages.firstPage();
    const orders = (page.items || []).map((o: any) => ({
      id: o.orderId ?? o.id,
      status: o.status,
      side: o.side,
      price: o.price,
      size: o.size,
      marketId: o.marketId,
      raw: o,
    }));
    return { orders, message: 'OK' };
  } catch (e: any) {
    return { orders: [], message: `查询失败: ${e?.message || e}` };
  }
}
