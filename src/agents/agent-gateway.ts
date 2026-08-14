/**
 * agent-gateway.ts — Agent Gateway 协调层 (2026-08-14)
 *
 * Agent Economy 的"经济路由器": 统一入口, 内部编排所有已有层.
 * 定位: 入口层 + 协调层 + 安全边界 (不是新系统, 是把 Registry/DIAP/x402/Policy/Reputation/Treasury 粘起来).
 *
 * 简单用法 (入口要小):
 *   gateway.registerAgent({ capability: "research", price: "0.05 USDC" })
 *   gateway.callAgent({ task: "analyze paper", budget: 1, capability: "research" })
 *   gateway.joinNetwork(link)   // 通过链接自动加入共享网络
 *
 * callAgent 自动闭环:
 *   Discovery (registry) → Identity (DIAP) → Negotiation (价格/预算匹配)
 *   → Policy (预算/白名单) → Payment (x402/审批) → Execution → Reputation
 */

import { getAgentRegistry, warmAgentRegistry, type AgentRegistry } from './agent-registry.js';
import { getEconomicPolicy } from './economic-policy.js';
import { getPaymentGate } from './payment-gate.js';
import { getApprovalStore } from './payment-approval.js';
import { recordServiceOutcome, queryReputation } from './agent-reputation.js';

// ============ 类型 ============

export interface GatewayAgentConfig {
  /** 能力名 (research/coding/data/compute...) */
  capability: string;
  /** 价格 (人类单位, 如 "0.05") */
  price: string;
  /** 币种 (默认 USDC) */
  currency?: string;
  /** 计价单位 (query/task/sec...) */
  per?: string;
  /** 服务描述 */
  description?: string;
  /** 收款钱包 (默认取 identity) */
  wallet?: string;
}

export interface GatewayCallOptions {
  /** 任务描述 */
  task: string;
  /** 预算上限 (USDC) */
  budget: number;
  /** 需要的能力 (registry 过滤) */
  capability?: string;
  /** 服务端点 URL (可选, 否则用 registry 里的) */
  url?: string;
  /** 钱包私钥 (x402 支付) */
  privateKey?: string;
}

export interface GatewayCallResult {
  success: boolean;
  provider?: string;        // provider agentId
  decision?: string;        // allow/confirm/deny
  output?: string;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

// ============ 协调层 ============

/**
 * 注册本 Agent 为服务提供者 (身份 + Registry + 信誉初始化).
 */
export async function gatewayRegisterAgent(
  config: GatewayAgentConfig,
  identity: { did: string; name: string; wallet: string },
  deps?: { registry?: AgentRegistry },
): Promise<{ ok: boolean; error?: string }> {
  // 2026-08-14: 生产路径先 warm OrbitDB — 否则注册只落本地文件, 分享链接指向的 store 是空的.
  // 离线/测试环境 warm 失败不阻塞 (注册仍落本地 fallback).
  let registry = deps?.registry;
  if (!registry) {
    try { await warmAgentRegistry(); } catch { /* 离线模式 */ }
    registry = getAgentRegistry();
  }
  const r = await registry.register({
    agentId: identity.did || `did:local:${identity.name}`,
    name: identity.name,
    wallet: config.wallet || identity.wallet,
    service: {
      name: config.capability,
      description: config.description || `${config.capability} 服务`,
      price: {
        amount: config.price,
        currency: (config.currency || 'USDC').toUpperCase(),
        per: config.per || 'query',
      },
    },
    capabilities: [config.capability],
  });
  return { ok: r.ok, error: r.error };
}

/**
 * 调用 Agent 服务 (自动闭环).
 * Discovery → Policy → Payment gate → Approval → Execution → Reputation.
 */
export async function gatewayCallAgent(opts: GatewayCallOptions): Promise<GatewayCallResult> {
  const { task, budget, capability, url, privateKey } = opts;

  // 1. Discovery: 从 Registry 找 provider
  const registry = getAgentRegistry();
  const providers = capability ? await registry.discover(capability) : await registry.list();
  if (providers.length === 0) {
    return { success: false, error: `未找到能力为 '${capability || 'any'}' 的 Agent (先 joinNetwork 或注册)` };
  }
  const provider = providers[0]; // 简版: 取第一个 (完整版按信誉/价格排序)
  const price = parseFloat(provider.service?.price?.amount || '0');

  // 2. Negotiation: 预算检查
  if (price > budget) {
    return { success: false, error: `价格 ${price} 超预算 ${budget}`, provider: provider.agentId };
  }

  // 3. Payment gate (YAML 验证门): allow/confirm/deny
  const gate = getPaymentGate();
  const verdict = gate.evaluate({ service: provider.service?.name, amount: price, recipient: provider.wallet });
  if (verdict.decision === 'deny') {
    return { success: false, error: `[payment-gate] ${verdict.reason}`, provider: provider.agentId, decision: 'deny' };
  }

  // 4. Policy (预算/白名单)
  const policy = getEconomicPolicy();
  const pol = await policy.check({ payTo: provider.wallet, amount: price, service: provider.service?.name });
  if (!pol.allowed) {
    return { success: false, error: `[policy] ${pol.reason}`, provider: provider.agentId, decision: 'deny' };
  }

  // 5. confirm → 创建人工审批 (不自动执行)
  if (verdict.decision === 'confirm') {
    const store = getApprovalStore();
    const approval = await store.create({
      service: provider.service?.name || capability || 'service',
      amount: price,
      recipient: provider.wallet,
      reason: verdict.reason,
      retryPayload: { task, url, privateKey, serviceName: provider.service?.name, args: { task } },
    });
    return {
      success: false,
      error: `需人工确认: ${verdict.reason} (approval=${approval.id})`,
      provider: provider.agentId,
      decision: 'confirm',
      requiresApproval: true,
      approvalId: approval.id,
    };
  }

  // 6. Execution (x402 支付 + 调用服务)
  try {
    const { serviceCall } = await import('./agent-service-client.js');
    const r = await serviceCall({
      serviceName: provider.service?.name || capability || 'service',
      args: { task },
      privateKey,
      url,
      registry,
    });
    if (!r.success) return { success: false, error: r.error, provider: provider.agentId, decision: 'allow' };

    // 7. Reputation: 记录成功
    await recordServiceOutcome(provider.agentId, provider.service?.name || 'service', 'success', registry).catch(() => {});
    return { success: true, provider: provider.agentId, decision: 'allow', output: r.output };
  } catch (e: any) {
    return { success: false, error: `执行失败: ${String(e?.message || e).slice(0, 200)}`, provider: provider.agentId };
  }
}

/**
 * 查询网络状态 (注册表 + 信誉概览).
 */
export async function gatewayStatus(): Promise<string> {
  const registry = getAgentRegistry();
  const services = await registry.list();
  const lines = services.slice(0, 20).map((s) =>
    `  [${s.service?.name}] ${s.name} (${s.service?.price?.amount} ${s.service?.price?.currency}/${s.service?.price?.per}) rep=${s.reputation?.score ?? 'n/a'}`
  );
  return `Agent 网络 (${services.length} 服务):\n${lines.join('\n') || '  (空, 先 joinNetwork 或注册)'}`;
}
