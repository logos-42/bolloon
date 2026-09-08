// ─── 资源级 x402 钱包自动配置 ─────────────────────────────────────────────
//   首次调用自动生成一个 EVM 钱包 (viem/accounts, 私钥+地址), 持久化到
//   ~/.bolloon/wallet.json (mode 0600). 之后幂等加载同一钱包.
//   资源自动绑定到它: 卖家收款地址(resource.wallet) / 铸造接收地址 / 购买付款签名.
//   x402 支付复用该私钥签名; 资金由用户向 address 充值 (自动配置=密钥/绑定, 不代发币).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface WalletRecord { privateKey: string; address: string }

export interface WalletDeps {
  read?: () => Promise<string | null>;
  write?: (payload: string) => Promise<void>;
  now?: () => string;
}

async function defaultRead(): Promise<string | null> {
  try {
    const { readFile } = await import('fs/promises');
    const home = (globalThis as any).process?.env?.HOME || '';
    return await readFile(`${home}/.bolloon/wallet.json`, 'utf8');
  } catch { return null; }
}

async function defaultWrite(payload: string): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  const home = (globalThis as any).process?.env?.HOME || '';
  await mkdir(`${home}/.bolloon`, { recursive: true });
  await writeFile(`${home}/.bolloon/wallet.json`, payload, { mode: 0o600 });
}

/** 加载或创建钱包 (幂等): 有则返回, 无则 viem 生成 + 落盘 0600. */
export async function loadOrCreateWallet(deps: WalletDeps = {}): Promise<WalletRecord> {
  const read = deps.read ?? defaultRead;
  const write = deps.write ?? defaultWrite;
  const existing = await read();
  if (existing) {
    try {
      const w = JSON.parse(existing);
      if (w && w.privateKey && w.address) return { privateKey: String(w.privateKey), address: String(w.address) };
    } catch { /* corrupted → regenerate */ }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const rec: WalletRecord = { privateKey, address: account.address };
  await write(JSON.stringify(rec));
  return rec;
}

/** 便捷: 只取地址 (绑定资源/铸造接收). */
export async function walletAddress(deps: WalletDeps = {}): Promise<string> {
  const w = await loadOrCreateWallet(deps);
  return w.address;
}
