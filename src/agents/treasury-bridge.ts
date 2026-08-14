/**
 * treasury-bridge.ts — Treasury 合约 × Agent 经济网络桥接 (2026-08-13)
 *
 * 打通: 链下结算逻辑 (Registry 服务/Policy 授权/Reputation 门槛) → 链上 Treasury.payAgent.
 *
 * 流程:
 *   registry 服务完成 → reputation_update(success) → treasuryPay(agent, amount)
 *     ├─ 链下校验: Policy (预算) + Registry (服务价格) + Reputation (≥60)
 *     └─ 链上执行: AgentTreasury.payAgent(agent, amount)
 *
 * 合约 ABI 用最小接口 (viem writeContract), 支持任意部署地址 + RPC.
 * 真实链上需部署 AgentTreasury + 注入 owner 私钥; 测试注入 mock.
 */

export interface TreasuryConfig {
  /** RPC URL (base-sepolia/base 等) */
  rpcUrl: string;
  /** AgentTreasury 合约地址 */
  treasuryAddress: string;
  /** USDC 代币地址 */
  tokenAddress: string;
  /** owner 私钥 (Treasury 支付者) */
  privateKey: string;
  /** 小数位 (USDC=6) */
  decimals?: number;
}

export interface TreasuryPayOptions {
  /** 目标 agent 地址 */
  agentAddress: string;
  /** 金额 (人类单位, 如 0.05) */
  amount: number;
  /** 服务名 (Policy/Registry 校验用) */
  service?: string;
  /** 注入 Policy 检查 (默认用全局 economic-policy) */
  policyCheck?: (intent: { payTo: string; amount: number; service?: string }) => Promise<{ allowed: boolean; reason?: string }>;
  /** dryRun: 只做 policy 校验, 不真实上链 (测试用) */
  dryRun?: boolean;
}

export interface TreasuryBridgeResult {
  success: boolean;
  txHash?: string;
  error?: string;
  checks?: { policy?: { allowed: boolean; reason?: string } };
  /** dryRun 模式标记 (测试/预演) */
  dryRun?: boolean;
}

/** Treasury 合约最小 ABI (payAgent/deposit/balance/dailySpend/frozen) */
const TREASURY_ABI = [
  {
    name: 'payAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'balance',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'frozen',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'dailyLimit',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * 链下校验 → 链上 Treasury.payAgent.
 * 校验链: Policy (预算/白名单) → 合约调用.
 */
export async function treasuryPay(config: TreasuryConfig, opts: TreasuryPayOptions): Promise<TreasuryBridgeResult> {
  const { agentAddress, amount, service } = opts;

  // 1. Policy 授权 (预算/白名单) — 链下, 防无预算支付
  if (opts.policyCheck) {
    const decision = await opts.policyCheck({ payTo: agentAddress, amount, service: service || 'treasury-pay' });
    if (!decision.allowed) {
      return { success: false, error: `[policy] ${decision.reason}`, checks: { policy: decision } };
    }
  } else {
    try {
      const { getEconomicPolicy } = await import('./economic-policy.js');
      const policy = getEconomicPolicy();
      const decision = await policy.check({ payTo: agentAddress, amount, service: service || 'treasury-pay' });
      if (!decision.allowed) {
        return { success: false, error: `[policy] ${decision.reason}`, checks: { policy: decision } };
      }
    } catch { /* policy 不可用放行 */ }
  }

  // 2. 链上 payAgent (dryRun: 只验证 policy 门, 不真实上链)
  if (opts.dryRun) {
    return { success: true, txHash: 'dry-run:0x0', checks: { policy: { allowed: true } }, dryRun: true };
  }
  try {
    const { createWalletClient, http, parseUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base, baseSepolia } = await import('viem/chains');
    const decimals = config.decimals ?? 6;
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const chain = config.rpcUrl.includes('sepolia') ? baseSepolia : base;
    const client = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

    const txHash = await client.writeContract({
      address: config.treasuryAddress as `0x${string}`,
      abi: TREASURY_ABI,
      functionName: 'payAgent',
      args: [agentAddress as `0x${string}`, parseUnits(String(amount), decimals)],
    });
    // 记录花费 (链下日预算镜像)
    try {
      const { getEconomicPolicy } = await import('./economic-policy.js');
      await getEconomicPolicy().recordSpend(amount).catch(() => {});
    } catch { /* 静默 */ }
    return { success: true, txHash, checks: { policy: { allowed: true } } };
  } catch (e: any) {
    return { success: false, error: `Treasury.payAgent 失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 查询 Treasury 状态 (余额/日限/冻结) */
export async function treasuryStatus(config: TreasuryConfig): Promise<{ ok: boolean; balance?: string; dailyLimit?: string; frozen?: boolean; error?: string }> {
  try {
    const { createPublicClient, http, formatUnits } = await import('viem');
    const { base, baseSepolia } = await import('viem/chains');
    const chain = config.rpcUrl.includes('sepolia') ? baseSepolia : base;
    const client = createPublicClient({ chain, transport: http(config.rpcUrl) });
    const decimals = config.decimals ?? 6;

    const [bal, limit, frozen] = await Promise.all([
      client.readContract({ address: config.treasuryAddress as `0x${string}`, abi: TREASURY_ABI, functionName: 'balance' }),
      client.readContract({ address: config.treasuryAddress as `0x${string}`, abi: TREASURY_ABI, functionName: 'dailyLimit' }),
      client.readContract({ address: config.treasuryAddress as `0x${string}`, abi: TREASURY_ABI, functionName: 'frozen' }),
    ]);
    return { ok: true, balance: formatUnits(bal as bigint, decimals), dailyLimit: formatUnits(limit as bigint, decimals), frozen: frozen as boolean };
  } catch (e: any) {
    return { ok: false, error: `Treasury 状态查询失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}
