export interface ConfirmTransactionParams {
  safeAddress: string;
  safeTxHash: string;
  signerAddress: string;
  signature?: string;
}

export async function confirmTransaction(params: ConfirmTransactionParams): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message: 'Safe transaction confirmation requires protocol kit with signer configured.',
  };
}