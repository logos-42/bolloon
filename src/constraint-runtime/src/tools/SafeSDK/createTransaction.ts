export interface CreateTransactionParams {
  safeAddress: string;
  to: string;
  value: string;
  data: string;
  operation?: number;
}

export interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: number;
}

export async function createTransaction(params: CreateTransactionParams): Promise<SafeTransaction> {
  return {
    to: params.to,
    value: params.value,
    data: params.data,
    operation: params.operation ?? 0,
  };
}