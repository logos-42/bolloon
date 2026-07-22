import { buildClobClient } from './clobShared';

export interface GetOrdersParams {
  /** 查询订单的钱包私钥 (用于派生 API key 鉴权) */
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

export async function getOrders(params: GetOrdersParams = {}): Promise<GetOrdersResult> {
  if (!params.privateKey) {
    return { orders: [], message: '查询订单需要提供钱包私钥 privateKey' };
  }
  try {
    const { client } = await buildClobClient({
      privateKey: params.privateKey,
      creds: { apiKey: params.apiKey, apiSecret: params.apiSecret, apiPassphrase: params.apiPassphrase },
      funder: params.funder,
    });
    const resp: any = await client.getOpenOrders(params.marketId ? { market: params.marketId } : {});
    const orders = Array.isArray(resp) ? resp : resp?.orders ?? [];
    return { orders, message: 'OK' };
  } catch (e: any) {
    return { orders: [], message: `查询失败: ${e?.message || e}` };
  }
}
