import { buildClobClient } from './clobShared';

export interface CancelOrderParams {
  /** 取消订单的钱包私钥 (用于派生 API key 鉴权) */
  privateKey: string;
  /** 要取消的订单 ID (orderID) */
  orderId: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  funder?: string;
}

export interface CancelOrderResult {
  success: boolean;
  message?: string;
  raw?: any;
}

export async function cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult> {
  if (!params.privateKey) {
    return { success: false, message: '取消订单需要提供钱包私钥 privateKey' };
  }
  if (!params.orderId) {
    return { success: false, message: 'orderId 必填' };
  }
  try {
    const { client } = await buildClobClient({
      privateKey: params.privateKey,
      creds: { apiKey: params.apiKey, apiSecret: params.apiSecret, apiPassphrase: params.apiPassphrase },
      funder: params.funder,
    });
    const resp: any = await client.cancelOrder({ orderID: params.orderId });
    return { success: true, message: '已提交取消', raw: resp };
  } catch (e: any) {
    return { success: false, message: `取消失败: ${e?.message || e}` };
  }
}
