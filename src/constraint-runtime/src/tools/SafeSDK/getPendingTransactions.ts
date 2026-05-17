export interface GetPendingTransactionsParams {
  safeAddress: string;
}

export async function getPendingTransactions(params: GetPendingTransactionsParams): Promise<{ transactions: any[]; message: string }> {
  return {
    transactions: [],
    message: 'Pending transaction retrieval requires Safe API Kit with transaction service URL configured.',
  };
}