import { Wallet, TransactionRequest, JsonRpcProvider } from 'ethers';

export interface SendTransactionParams {
  to: string;
  value: string;
  data?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  rpcUrl?: string;
  privateKey: string;
}

export interface SendTransactionResult {
  hash: string;
  from: string;
  to: string;
  value: string;
  status: 'pending' | 'success' | 'failed';
  blockNumber?: number;
  gasUsed?: string;
}

export async function sendTransaction(params: SendTransactionParams): Promise<SendTransactionResult> {
  const rpcUrl = params.rpcUrl ?? 'https://eth.llamarpc.com';
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(params.privateKey, provider);

  const tx: TransactionRequest = {
    to: params.to,
    value: BigInt(params.value),
    data: params.data ? `0x${params.data}` : undefined,
    gasLimit: params.gasLimit ? BigInt(params.gasLimit) : undefined,
    maxFeePerGas: params.maxFeePerGas ? BigInt(params.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas ? BigInt(params.maxPriorityFeePerGas) : undefined,
  };

  const response = await wallet.sendTransaction(tx);
  const receipt = await response.wait();

  return {
    hash: response.hash,
    from: wallet.address,
    to: params.to,
    value: params.value,
    status: receipt?.status === 1 ? 'success' : 'failed',
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
  };
}