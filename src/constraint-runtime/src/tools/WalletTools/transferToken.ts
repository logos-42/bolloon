import { Wallet, Contract } from 'ethers';

export interface TransferTokenParams {
  tokenAddress: string;
  to: string;
  amount: string;
  rpcUrl?: string;
  privateKey: string;
  decimals?: number;
}

export interface TransferTokenResult {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  amount: string;
  status: 'pending' | 'success' | 'failed';
}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export async function transferToken(params: TransferTokenParams): Promise<TransferTokenResult> {
  const rpcUrl = params.rpcUrl ?? 'https://eth.llamarpc.com';
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(params.privateKey, provider);

  const tokenContract = new Contract(params.tokenAddress, ERC20_ABI, wallet);
  const decimals = params.decimals ?? (await tokenContract.decimals());
  const amount = BigInt(params.amount) * BigInt(10) ** BigInt(decimals);

  const tx = await tokenContract.transfer(params.to, amount);
  const receipt = await tx.wait();

  return {
    hash: tx.hash,
    from: wallet.address,
    to: params.to,
    tokenAddress: params.tokenAddress,
    amount: params.amount,
    status: receipt?.status === 1 ? 'success' : 'failed',
  };
}

import { JsonRpcProvider } from 'ethers';