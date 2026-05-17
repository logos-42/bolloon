export interface GetBalanceParams {
  safeAddress: string;
}

export async function getBalance(params: GetBalanceParams): Promise<{ balance: string; message: string }> {
  return {
    balance: '0',
    message: 'Balance retrieval requires protocol kit with RPC provider configured.',
  };
}