import { randomBytes } from 'crypto';
import { Wallet } from 'ethers';

export interface CreateWalletResult {
  address: string;
  privateKey: string;
  mnemonic: string;
  createdAt: string;
}

export async function createWallet(): Promise<CreateWalletResult> {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase ?? '',
    createdAt: new Date().toISOString(),
  };
}