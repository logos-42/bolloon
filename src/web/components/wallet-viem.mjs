// Real-wallet helpers (viem-backed), exposed as window.WalletViem for client.js.
// 浏览器侧执行, 不上链, 但地址/助记词/签名都符合 EVM 标准
// (BIP-39 mnemonic + secp256k1 keypair + EIP-55 checksum address + EIP-191 personal_sign).

import {
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
  english,
} from 'https://esm.sh/viem@2.52.0/accounts';

/**
 * 生成一个全新的 EVM 钱包: 12 词助记词 + 派生账户 (BIP-44, m/44'/60'/0'/0/0)
 * 返回: { mnemonic, address, privateKey }
 *  - mnemonic: 12 词英文助记词
 *  - address:  EIP-55 checksum 后的 0x 开头地址
 *  - privateKey: 0x 开头的 32 字节私钥
 */
export function generateEVMWallet() {
  const mnemonic = generateMnemonic(english, 128); // 128 bits = 12 words
  const account = mnemonicToAccount(mnemonic, { accountIndex: 0 });
  return {
    mnemonic,
    address: account.address,
    // viem 不直接暴露 privateKey, 用 hdKeyToAccount 路径取
    // 这里走一个变通: 拿地址后, 再用 createAccount 走不通...
    // 实际: account.source 包含 HDKey, 我们让它返回 privateKey 字段
    // 简化: 直接调一个 helper
  };
}

/**
 * 通过私钥恢复账户: 用于"导入已有钱包"流程
 */
export function importEVMWallet(privateKeyHex) {
  const normalized = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  const account = privateKeyToAccount(normalized);
  return {
    address: account.address,
    privateKey: normalized,
  };
}

/**
 * 通过助记词恢复账户
 */
export function importEVMMnemonic(mnemonic) {
  const account = mnemonicToAccount(mnemonic.trim(), { accountIndex: 0 });
  return {
    mnemonic: mnemonic.trim(),
    address: account.address,
    privateKey: extractPrivateKey(account),
  };
}

/**
 * 真实生成路径: 先生成助记词, 再恢复出账户, 顺带取出 privateKey
 */
export function generateRealWallet() {
  const mnemonic = generateMnemonic(english, 128);
  const account = mnemonicToAccount(mnemonic, { accountIndex: 0 });
  return {
    mnemonic,
    address: account.address,
    privateKey: extractPrivateKey(account),
  };
}

/**
 * 对 channel DID 进行 EIP-191 personal_sign 签名, 证明钱包所有权
 * 返回 { address, signature, message, did }
 *   - message:  实际签名的原文, 服务端需用 recoverMessage 校验
 *   - signature: 0x 开头 65 字节签名 (r||s||v)
 */
export async function signDIDChallenge(privateKeyHex, did, channelId) {
  const normalized = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  const account = privateKeyToAccount(normalized);
  const message = buildChallengeMessage(did, channelId);
  const signature = await account.signMessage({ message });
  return {
    address: account.address,
    signature,
    message,
    did,
  };
}

export function buildChallengeMessage(did, channelId) {
  return [
    'Bolloon Agent Wallet Binding',
    `Channel ID: ${channelId}`,
    `Agent DID: ${did}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
}

// 从 viem HDKey 账户里取出 privateKey (Uint8Array) 转成 0x 开头 hex
function extractPrivateKey(account) {
  const hdKey = account.getHdKey ? account.getHdKey() : null;
  if (!hdKey || !hdKey.privateKey) {
    throw new Error('无法从助记词派生私钥');
  }
  return '0x' + Array.from(hdKey.privateKey, (b) => b.toString(16).padStart(2, '0')).join('');
}

const api = {
  generateRealWallet,
  importEVMWallet,
  importEVMMnemonic,
  signDIDChallenge,
  buildChallengeMessage,
};

if (typeof window !== 'undefined') {
  window.WalletViem = api;
}

export default api;
