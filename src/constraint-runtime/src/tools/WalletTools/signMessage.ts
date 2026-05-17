import { Wallet } from 'ethers';

export interface SignMessageParams {
  message: string;
  privateKey: string;
}

export interface SignMessageResult {
  address: string;
  message: string;
  signature: string;
}

export async function signMessage(params: SignMessageParams): Promise<SignMessageResult> {
  const wallet = new Wallet(params.privateKey);
  const signature = await wallet.signMessage(params.message);

  return {
    address: wallet.address,
    message: params.message,
    signature,
  };
}