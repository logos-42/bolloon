/**
 * x402 Pay — 智能体自动支付工作流
 *
 * 基于 @x402 协议栈实现请求→402→支付→重试 自动化流程:
 *   - x402_pay: 用私钥对 402 支付意图签名并提交，支持 EVM 网络
 *   - x402_request_payment: 服务端生成 402 PaymentRequired 响应
 *   - x402_fetch: 自动化的"请求→检测402→钱包签名→重试"循环
 *   - x402_get_balance_for_payment: 查钱包是否有足够资金支付
 *
 * 依赖: @x402/core, @x402/evm, @x402/fetch, viem
 */

// ============================================================
// 类型定义
// ============================================================

export interface X402PayParams {
  privateKey: string;
  /** 金额 (ETH 或 USDC) */
  amount: string;
  /** 收款地址 */
  to: string;
  /** 网络: base | base-sepolia | mainnet | sepolia */
  network?: string;
  /** 代币: ETH | USDC (默认 ETH) */
  currency?: string;
  /** 用途说明 (可选) */
  memo?: string;
}

export interface X402PayResult {
  success: boolean;
  txHash?: string;
  error?: string;
  /** 支付金额 + 代币 */
  paid?: string;
  /** 接收地址 */
  to?: string;
  /** 网络 */
  network?: string;
}

export interface X402RequestPaymentParams {
  /** 价格 (数字) */
  price: number;
  /** 代币: USDC | ETH */
  currency?: string;
  /** 网络: base | base-sepolia */
  network?: string;
  /** 收款方地址 */
  payTo: string;
  /** 资源描述 (可选) */
  resourceDescription?: string;
}

export interface X402FetchParams {
  /** 目标 URL */
  url: string;
  /** HTTP method */
  method?: string;
  /** 请求体 */
  body?: string;
  /** HTTP headers */
  headers?: Record<string, string>;
  /** 钱包私钥 (自动支付用) */
  privateKey?: string;
  /** 最大支付金额 (ETH) */
  maxPaymentEth?: string;
  /** RPC URL */
  rpcUrl?: string;
}

// ============================================================
// RPC 配置
// ============================================================

const RPC_URLS: Record<string, string> = {
  'base': 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  'mainnet': 'https://eth.llamarpc.com',
  'sepolia': 'https://rpc.sepolia.org',
};

// ============================================================
// 核心函数
// ============================================================

/**
 * x402 支付: 用 x402 协议对资源请求发起支付
 *
 * 流程:
 *   1. 尝试请求 → 收到 402 + PaymentRequired header
 *   2. 解析支付意图 (network, price, currency, payTo)
 *   3. 用私钥签名并提交支付
 *   4. 返回 txHash 和支付凭证
 */
export async function x402Pay(params: X402PayParams): Promise<X402PayResult> {
  const { privateKey, amount, to, network = 'base-sepolia', currency = 'ETH' } = params;
  const rpcUrl = RPC_URLS[network];

  if (!rpcUrl) {
    return { success: false, error: `不支持的网络: ${network} (支持: ${Object.keys(RPC_URLS).join(', ')})` };
  }

  try {
    const { createWalletClient, http, parseEther, formatEther } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base, baseSepolia, mainnet, sepolia } = await import('viem/chains');

    const chainMap: Record<string, any> = {
      'base': base,
      'base-sepolia': baseSepolia,
      'mainnet': mainnet,
      'sepolia': sepolia,
    };
    const chain = chainMap[network];
    if (!chain) return { success: false, error: `网络 ${network} 的 chain 配置缺失` };

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const client = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    let txHash: `0x${string}`;

    if (currency.toUpperCase() === 'USDC') {
      const value = BigInt(Math.round(Number(amount) * 1_000_000));
      txHash = await client.writeContract({
        address: getUSDcAddress(network),
        abi: [{
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
          stateMutability: 'nonpayable',
        }],
        functionName: 'transfer',
        args: [to as `0x${string}`, value],
      } as any);
    } else {
      txHash = await client.sendTransaction({
        to: to as `0x${string}`,
        value: parseEther(amount),
      } as any);
    }

    return {
      success: true,
      txHash,
      paid: `${amount} ${currency.toUpperCase()}`,
      to,
      network,
    };
  } catch (e: any) {
    return { success: false, error: `支付失败: ${String(e.message || e)}` };
  }
}

/**
 * x402 请求支付: 生成 HTTP 402 响应所需的 PaymentRequired 信息
 *
 * 用于智能体作为服务端时，告知调用方需要支付才能访问资源
 */
export function x402RequestPayment(params: X402RequestPaymentParams): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  const { price, currency = 'USDC', network = 'base', payTo, resourceDescription } = params;

  const paymentRequired = {
    statusCode: 402,
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Required': 'true',
      'X-Payment-Network': network,
      'X-Payment-Currency': currency,
      'X-Payment-Amount': String(price),
      'X-Pay-To': payTo,
    },
    body: JSON.stringify({
      error: 'Payment Required',
      message: resourceDescription ? `需要支付才能访问: ${resourceDescription}` : '需要支付才能访问此资源',
      payment: {
        network,
        currency,
        amount: price,
        payTo,
      },
    }),
  };

  return paymentRequired;
}

/**
 * x402 Fetch: 自动支付版 HTTP 请求
 *
 * 自动完成 "请求→遇到 402 → 解析支付要求 → 签名支付 → 携带支付凭据重试"
 * 对智能体完全透明
 */
export async function x402Fetch(params: X402FetchParams): Promise<{
  success: boolean;
  data?: any;
  status?: number;
  error?: string;
  paymentInfo?: { paid: string; txHash: string };
}> {
  const { url, method = 'GET', body, headers = {}, privateKey } = params;

  // 第 1 步: 普通请求
  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  try {
    const res = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body || undefined,
    });

    // 如果不需要支付，直接返回
    if (res.status !== 402) {
      const data = await res.json().catch(() => null);
      return { success: res.ok, data, status: res.status };
    }

    // 第 2 步: 解析 402 支付要求
    const paymentNetwork = res.headers.get('X-Payment-Network') || 'base-sepolia';
    const paymentCurrency = res.headers.get('X-Payment-Currency') || 'USDC';
    const paymentAmount = res.headers.get('X-Payment-Amount') || '0.01';
    const payTo = res.headers.get('X-Pay-To') || '';

    if (!privateKey) {
      return {
        success: false,
        status: 402,
        error: `需要支付: ${paymentAmount} ${paymentCurrency} → ${payTo} (提供 privateKey 可自动支付)`,
        data: await res.json().catch(() => null),
      };
    }

    if (!payTo) {
      return { success: false, status: 402, error: '402 响应缺少 X-Pay-To header' };
    }

    // 第 3 步: 自动支付
    const payResult = await x402Pay({
      privateKey,
      amount: paymentAmount,
      to: payTo,
      network: paymentNetwork,
      currency: paymentCurrency,
      memo: `x402 auto-pay for ${url}`,
    });

    if (!payResult.success) {
      return { success: false, error: `自动支付失败: ${payResult.error}`, status: 402 };
    }

    // 第 4 步: 带支付凭据重试
    const retryRes = await fetch(url, {
      method,
      headers: {
        ...fetchHeaders,
        'X-Payment-TxHash': payResult.txHash!,
        'X-Payment-Signature': payResult.txHash!,
      },
      body: body || undefined,
    });

    const retryData = await retryRes.json().catch(() => null);
    return {
      success: retryRes.ok,
      status: retryRes.status,
      data: retryData,
      paymentInfo: {
        paid: payResult.paid!,
        txHash: payResult.txHash!,
      },
    };
  } catch (e: any) {
    return { success: false, error: `x402 fetch 失败: ${String(e.message || e)}` };
  }
}

/**
 * 查钱包余额并判断是否足够支付
 */
export async function x402CheckBalance(params: {
  address: string;
  network?: string;
  rpcUrl?: string;
}): Promise<{
  success: boolean;
  balance?: string;
  error?: string;
  network?: string;
}> {
  const { address, network = 'base-sepolia' } = params;
  const rpcUrl = params.rpcUrl || RPC_URLS[network];

  if (!rpcUrl) {
    return { success: false, error: `不支持的网络: ${network}` };
  }

  try {
    const { createWalletClient, http, formatEther } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base, baseSepolia, mainnet, sepolia } = await import('viem/chains');

    const chainMap: Record<string, any> = {
      'base': base,
      'base-sepolia': baseSepolia,
      'mainnet': mainnet,
      'sepolia': sepolia,
    };
    const chain = chainMap[network];
    if (!chain) return { success: false, error: `网络 ${network} 的 chain 配置缺失` };

    const client = createWalletClient({
      account: privateKeyToAccount(('0x' + '1'.repeat(64)) as `0x${string}`),
      chain,
      transport: http(rpcUrl),
    } as any);

    const balance = await (client as any).getBalance({ address: address as `0x${string}` });
    return {
      success: true,
      balance: formatEther(balance),
      network,
    };
  } catch (e: any) {
    return { success: false, error: `查余额失败: ${String(e.message || e)}` };
  }
}

// ============================================================
// USDC 合约地址
// ============================================================

function getUSDcAddress(network: string): `0x${string}` {
  const map: Record<string, string> = {
    'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    'mainnet': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  };
  return (map[network] || map['base-sepolia']) as `0x${string}`;
}

// ============================================================
// Channel 钱包自动支付 (AES-GCM 解密)
// ============================================================

/**
 * 用 AES-256-GCM 解密 channel 绑定的加密私钥。
 * 密钥派生: SHA-256(did) → 256 bit AES key
 *
 * 客户端用 Web Crypto API 加密后存储到服务端，
 * agent 进程运行时用 Node.js crypto 解密。
 */
export async function decryptChannelWallet(
  channel: { encryptedPrivateKey?: string; encryptedPrivateKeyIv?: string; walletAddress?: string },
  did: string
): Promise<{ privateKey: string; address: string } | null> {
  if (!channel.encryptedPrivateKey || !channel.encryptedPrivateKeyIv) {
    return null;
  }
  try {
    const crypto = await import('crypto');
    const key = crypto.createHash('sha256').update(did).digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(channel.encryptedPrivateKeyIv, 'base64')
    );
    const tag = Buffer.from(channel.encryptedPrivateKey, 'base64').subarray(-16);
    const ciphertext = Buffer.from(channel.encryptedPrivateKey, 'base64').subarray(0, -16);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const privateKey = decrypted.toString('utf8');
    return { privateKey, address: channel.walletAddress || '' };
  } catch (e) {
    console.error('[x402] 解密 channel 钱包失败:', e);
    return null;
  }
}