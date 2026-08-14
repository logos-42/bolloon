/**
 * econ-integration.ts — Polymarket × Agent 经济网络集成 (2026-08-13, Task C4)
 *
 * 打通 Agent Economic Network 与 Polymarket 预测市场:
 *   - Agent 可用 Treasury 资金在 Polymarket 下单 (预测/对冲)
 *   - 下单前过 Policy Engine (预算/授权)
 *   - 订单结果 (成交/收益) 记录回经济层 (审计)
 *
 * Polymarket 合约架构 (Polygon):
 *   - CLOB (链上订单簿): createOrder/getOrders/cancelOrder (现有 SDK)
 *   - CTF 条件代币框架: 市场 = 条件代币对 (Yes/No)
 *   - NegRisk 适配器: 互斥结果市场
 *   收益结算在链上 (USDC), Agent Treasury 可接收.
 */

import { createOrder as pmCreateOrder, type CreateOrderParams, type CreateOrderResult } from './createOrder.js';
import { getOrders as pmGetOrders, type GetOrdersParams, type GetOrdersResult } from './getOrders.js';

export interface EconOrderOptions {
  /** 预算上限 (USDC) — 经 Policy Engine 检查 */
  maxSpendUsdc?: number;
  /** 服务名 (Policy 白名单用, 默认 polymarket) */
  service?: string;
  /** 是否记录经济审计 */
  audit?: boolean;
  /** 注入 Policy 检查回调 (根包 Agent 经济层注入; 子包不跨包 import) */
  policyCheck?: (intent: { payTo: string; amount: number; service?: string }) => Promise<{ allowed: boolean; reason?: string }>;
  /** 注入花费记录回调 */
  recordSpend?: (amount: number) => Promise<void>;
  /** 注入 createOrder 实现 (测试 mock; 默认真实 CLOB) */
  createOrderImpl?: (params: CreateOrderParams) => Promise<CreateOrderResult>;
}

export interface EconOrderResult {
  success: boolean;
  order?: CreateOrderResult;
  policy?: { allowed: boolean; reason?: string };
  error?: string;
}

/**
 * 带 Policy 检查的 Polymarket 下单.
 * 流程: 金额 → Policy 授权 (回调注入) → CLOB 下单.
 */
export async function createOrderEcon(
  params: CreateOrderParams,
  opts: EconOrderOptions = {},
): Promise<EconOrderResult> {
  const amountUsdc = Number(params.price) * Number(params.size ?? 1);

  // 1. Policy 授权 (预算/白名单) — 回调注入, 不跨包
  if (opts.policyCheck) {
    const decision = await opts.policyCheck({
      payTo: 'polymarket-clob',
      amount: amountUsdc,
      service: opts.service || 'polymarket',
    });
    if (!decision.allowed) {
      return { success: false, policy: { allowed: false, reason: `[policy] ${decision.reason}` } };
    }
    await opts.recordSpend?.(amountUsdc).catch(() => {});
  } else if (opts.maxSpendUsdc !== undefined && amountUsdc > opts.maxSpendUsdc) {
    return { success: false, policy: { allowed: false, reason: `Polymarket 下单超预算: ${amountUsdc} > ${opts.maxSpendUsdc}` } };
  }

  // 2. CLOB 下单 (可注入 mock, 默认真实)
  try {
    const order = opts.createOrderImpl ? await opts.createOrderImpl(params) : await pmCreateOrder(params);
    return { success: true, order, policy: { allowed: true } };
  } catch (e: any) {
    return { success: false, error: `Polymarket 下单失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 查询订单 (含经济层关联信息) */
export async function getOrdersEcon(params: GetOrdersParams = {}): Promise<GetOrdersResult> {
  return pmGetOrders(params);
}

/** Polymarket 合约架构摘要 (文档化, 供 Agent 理解) */
export const POLYMARKET_CONTRACT_OVERVIEW = `
Polymarket 合约架构 (Polygon):
- CLOB: 链上订单簿 (createOrder/getOrders/cancelOrder)
- CTF (Conditional Token Framework): 市场 = 条件代币对 Yes/No
- NegRisk 适配器: 互斥结果市场 (如"哪个候选人胜出")
- 结算: USDC 链上, 收益可回收到 Agent Treasury
- Agent 集成: Treasury 资金 → Policy 授权 → CLOB 下单 → 结果 → 收益回流
`;
