export interface ProposeTransactionParams {
  safeAddress: string;
  safeTransaction: any;
  safeTxHash: string;
  signerAddress: string;
  origin?: string;
}

export async function proposeSafeTransaction(params: ProposeTransactionParams): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message: 'Safe transaction proposal requires Safe API Kit with transaction service URL configured.',
  };
}