export interface ImportWalletParams {
  mnemonic?: string;
  privateKey?: string;
}

export interface ImportWalletResult {
  address: string;
  privateKey: string;
  source: 'mnemonic' | 'privateKey';
}

export async function importWallet(params: ImportWalletParams): Promise<ImportWalletResult> {
  if (!params.mnemonic && !params.privateKey) {
    throw new Error('Either mnemonic or privateKey must be provided');
  }

  const { ethers } = await import('ethers');

  if (params.mnemonic) {
    const wallet = ethers.Wallet.fromPhrase(params.mnemonic);
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      source: 'mnemonic' as const,
    };
  } else {
    const wallet = new ethers.Wallet(params.privateKey!);
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      source: 'privateKey' as const,
    };
  }
}