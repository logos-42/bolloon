import { buildSecureClient } from './clobShared.js';

export interface CancelOrderParams {
  /** 取消订单的钱包私钥 */
  privateKey: string;
  /** 要取消的订单 ID (orderId) */
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

/** 撤单 (@polymarket/client 统一 SDK cancelOrder, 2026-08-04 迁移). */
export async function cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult> {
  if (!params.privateKey) {
    return { success: false, message: '取消订单需要提供钱包私钥 privateKey' };
  }
  if (!params.orderId) {
    return { success: false, message: 'orderId 必填' };
  }
  try {
    const { client } = await buildSecureClient({ privateKey: params.privateKey, funder: params.funder });
    const resp: any = await client.cancelOrder({ orderId: params.orderId });
    return { success: true, message: '已提交取消', raw: resp };
  } catch (e: any) {
    return { success: false, message: `取消失败: ${e?.message || e}` };
  }
}
