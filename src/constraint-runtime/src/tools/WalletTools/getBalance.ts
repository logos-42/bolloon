import { JsonRpcProvider } from 'ethers';

export interface GetBalanceParams {
  address: string;
  rpcUrl?: string;
}

export interface GetBalanceResult {
  address: string;
  balance: string;
  balanceEth: string;
  symbol: string;
}

export async function getBalance(params: GetBalanceParams): Promise<GetBalanceResult> {
  const rpcUrl = params.rpcUrl ?? 'https://eth.llamarpc.com';
  const provider = new JsonRpcProvider(rpcUrl);

  const balance = await provider.getBalance(params.address);
  const balanceEth = Number(balance) / 1e18;

  return {
    address: params.address,
    balance: balance.toString(),
    balanceEth: balanceEth.toFixed(6),
    symbol: 'ETH',
  };
}