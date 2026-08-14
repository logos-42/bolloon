/**
 * agent-service-client.ts — Agent 服务调用闭环 (2026-08-13, Phase E2)
 *
 * Agent Economic Network 的 Execution+Payment 层:
 *   buyer: 从 Registry 发现服务 → 调服务端点 → 收到 402 → x402 自动支付 → 拿结果
 *   provider: 基于 Registry 价格生成 402 响应 → 收钱 → 提供服务
 *
 * 复用: x402Pay.ts 的 x402Fetch (自动 402→支付→重试) + x402RequestPayment (生成 402).
 * MVP: 闭环逻辑可测 (mock fetch), 真实链上支付需 funded wallet.
 */

import { getAgentRegistry } from './agent-registry.js';
import type { AgentService } from './agent-registry.js';

export interface ServiceCallOptions {
  /** 目标服务名 (registry discover 用) */
  serviceName: string;
  /** 服务调用参数 */
  args?: Record<string, unknown>;
  /** buyer 钱包私钥 (x402 自动支付用) */
  privateKey?: string;
  /** 服务端点 URL (未给则用 registry 里的 endpoint) */
  url?: string;
  /** 最大支付金额 (USDC/ETH 人类单位) */
  maxPaymentAmount?: string;
  /** 注入 registry (测试用; 默认全局单例) */
  registry?: import('./agent-registry.js').AgentRegistry;
}

export interface ServiceCallResult {
  success: boolean;
  service?: AgentService;
  paid?: boolean;
  txHash?: string;
  output?: string;
  error?: string;
  /** YAML 验证门: confirm 时需人工审批 */
  requiresApproval?: boolean;
}

/**
 * buyer 侧: 调用 Agent 服务 (402 自动支付).
 * 流程: registry 发现 → x402Fetch(url) → 402 → 自动签名支付 → 服务结果
 */
export async function serviceCall(opts: ServiceCallOptions): Promise<ServiceCallResult> {
  const { serviceName, args, privateKey, url, maxPaymentAmount, registry } = opts;

  // 1. 从 Registry 发现服务
  const reg = registry ?? getAgentRegistry();
  const services = await reg.discover(serviceName);
  if (services.length === 0) {
    return { success: false, error: `注册表未找到服务: ${serviceName}` };
  }
  const service = services[0];

  // 2. 确定端点
  const endpoint = url || service.endpoint;
  if (!endpoint) {
    return { success: false, error: `服务 ${serviceName} 无端点 (endpoint), 无法调用`, service };
  }

  // 3. 调服务 (x402 自动支付: 402 → 签名 → 重试)
  try {
    const { x402Fetch } = await import('./x402/x402Pay.js');
    // 2026-08-13: YAML 验证门 (不全部交给 AI) — 支付前先过 payment-policy.yaml 规则链
    const { getPaymentGate } = await import('./payment-gate.js');
    const gate = getPaymentGate();
    const amount = parseFloat(service.service?.price?.amount || '0');
    const gateVerdict = gate.evaluate({ service: service.service?.name, amount, recipient: service.wallet });
    if (gateVerdict.decision === 'deny') {
      return { success: false, error: `[payment-gate] ${gateVerdict.reason}`, service };
    }
    if (gateVerdict.decision === 'confirm') {
      return { success: false, error: `[payment-gate] 需人工确认: ${gateVerdict.reason} (confirm 后重试)`, service, requiresApproval: true };
    }
    // Phase E3: Policy Engine 授权 (预算/白名单) — 通过才允许自动支付
    let effectiveKey = privateKey;
    if (privateKey) {
      const { getEconomicPolicy } = await import('./economic-policy.js');
      const policy = getEconomicPolicy();
      const decision = await policy.check({
        payTo: service.wallet,
        amount,
        currency: service.service?.price?.currency,
        service: service.service?.name,
        timestamp: Date.now(),
      });
      if (!decision.allowed) {
        return { success: false, error: `[policy] ${decision.reason}`, service };
      }
      effectiveKey = privateKey; // policy 通过 → 允许签名支付
      // 记录花费 (结算后) — 预记, 实际结算在链上
      await policy.recordSpend(amount).catch(() => {});
    }
    const result = await x402Fetch({
      url: endpoint,
      method: 'POST',
      body: JSON.stringify(args || {}),
      headers: { 'Content-Type': 'application/json' },
      privateKey: effectiveKey,
      maxPaymentAmount: maxPaymentAmount || service.service?.price?.amount,
    });
    if (!result.success) {
      return { success: false, error: result.error || 'x402 调用失败', service };
    }
    // 有 paymentInfo 说明经过了 402 支付; data 是服务结果
    const paid = !!result.paymentInfo || (result.status ?? 0) >= 200;
    return {
      success: true,
      service,
      paid,
      output: typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? ''),
    };
  } catch (e: any) {
    return { success: false, error: `服务调用异常: ${e?.message}`, service };
  }
}

/**
 * provider 侧: 生成 x402 402 响应 (基于 Registry 价格).
 * 返回 402 响应对象 (含 PaymentRequired header 语义), 供服务端点使用.
 */
export async function serviceRequestPayment(
  agentId: string,
  serviceName: string,
  registry?: import('./agent-registry.js').AgentRegistry,
): Promise<{ price: number; currency: string; payTo: string; resourceDescription: string } | { error: string }> {
  const reg = registry ?? getAgentRegistry();
  const services = await reg.list();
  const service = services.find((s) => s.agentId === agentId && s.service?.name === serviceName);
  if (!service) {
    return { error: `agent ${agentId} 未注册服务 ${serviceName}` };
  }
  const price = parseFloat(service.service.price.amount || '0');
  const currency = service.service.price.currency || 'USDC';
  const payTo = service.wallet;
  if (!payTo) return { error: '服务无收款钱包' };
  return {
    price,
    currency,
    payTo,
    resourceDescription: `${serviceName} service by ${service.name}`,
  };
}

/**
 * provider 侧: 基于 Registry 价格生成 402 PaymentRequired 响应体.
 * 复用 x402RequestPayment.
 */
export async function buildPaymentRequiredResponse(agentId: string, serviceName: string, registry?: import('./agent-registry.js').AgentRegistry): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const info = await serviceRequestPayment(agentId, serviceName, registry);
  if ('error' in info) {
    return { status: 500, headers: {}, body: JSON.stringify({ error: info.error }) };
  }
  const { x402RequestPayment } = await import('./x402/x402Pay.js');
  const r = x402RequestPayment({
    price: info.price,
    currency: info.currency as any,
    payTo: info.payTo,
    resourceDescription: info.resourceDescription,
  });
  return {
    status: r.statusCode,
    headers: r.headers,
    body: r.body,
  };
}
