export interface AutoPayConfig {
  enabled: boolean;
  walletPrivateKey: string;
  rpcUrl: string;
  maxGasPrice?: string;
  whitelist?: string[];
}

const autoPayStore: Map<string, AutoPayConfig> = new Map();

export interface SetAutoPayParams {
  agentId: string;
  walletPrivateKey: string;
  rpcUrl?: string;
  maxGasPrice?: string;
  whitelist?: string[];
}

export interface AutoPayResult {
  agentId: string;
  enabled: boolean;
  walletAddress: string;
  rpcUrl: string;
}

export async function setAutoPay(params: SetAutoPayParams): Promise<AutoPayResult> {
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(params.walletPrivateKey);

  const config: AutoPayConfig = {
    enabled: true,
    walletPrivateKey: params.walletPrivateKey,
    rpcUrl: params.rpcUrl ?? 'https://eth.llamarpc.com',
    maxGasPrice: params.maxGasPrice,
    whitelist: params.whitelist,
  };

  autoPayStore.set(params.agentId, config);

  return {
    agentId: params.agentId,
    enabled: true,
    walletAddress: wallet.address,
    rpcUrl: config.rpcUrl,
  };
}

export async function getAutoPayConfig(agentId: string): Promise<AutoPayConfig | null> {
  return autoPayStore.get(agentId) ?? null;
}

export async function disableAutoPay(agentId: string): Promise<{ agentId: string; enabled: boolean }> {
  const config = autoPayStore.get(agentId);
  if (config) {
    config.enabled = false;
  }
  return { agentId, enabled: false };
}