/**
 * explorer.ts — 区块浏览器映射 (chainId → 公网浏览器) + **交易**链接构造
 *
 * 只回答一件事: **这条链有没有已知的公网浏览器**。
 *   · 有 → `https://<explorer>/tx/0x…` (公开可核验的链上事实)
 *   · 认不出 / 本机隔离开发链 (31337) → **null** —— 没有公网浏览器就**不给链接**,
 *     绝不编造 `href="#"`、死链或猜一个域名 (宁缺勿错)。
 *
 * 隐私红线 (2026-09-23 leo 拍板; 同日收窄):
 *   · 允许出现在公开快照里的 0x 字符串**只有两种**: 交易哈希 (0x+64 hex) 与 escrow **合约**地址
 *     (0x+40 hex) —— 它们本来就是公开链上事实。
 *   · 但**页面只可点交易**: escrow 合约地址保留在行数据里供索引/诊断, **不渲染、不生成合约链接**
 *     (所以本文件**没有** address 链接构造器 —— 少一个能凭空造出合约链接的入口)。
 *   · EOA / 钱包地址 (买方·卖方·payTo 之类)、taskKey 原文、taskId、args 里的地址、DID、
 *     peer IP / multiaddr、私钥 —— **一个都不许**经这里或别处进快照。
 *   · 本文件只构造 URL, 不读盘不发 RPC, 也从不接受「调用方说它是合约地址」的自我声明。
 */

/** chainId → 公网浏览器 base URL (白名单; 认不出的一律没有) */
export const EXPLORER_BY_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  8453: 'https://basescan.org',            // Base 主网
  84532: 'https://sepolia.basescan.org',   // Base Sepolia 测试网
  1: 'https://etherscan.io',               // Ethereum 主网
  11155111: 'https://sepolia.etherscan.io', // Sepolia 测试网
});

/** 交易哈希: 小写 0x + 64 位十六进制 (词法唯一形状) */
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
/** 地址: 小写 0x + 40 位十六进制 (合约地址同样长这样 —— 是**谁**由调用方的白名单决定) */
export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * 浏览器**交易**链接形状 (反向校验用): https + 已知浏览器域名 + `/tx/0x64hex`。
 * 给守卫 / 单测一把「这不是我们造的链接」的尺子 —— 端口 / 凭据 / 别的路径 (含 `/address/`) 一律不认。
 */
export const EXPLORER_URL_RE = /^https:\/\/(?:[a-z0-9-]+\.)*(?:basescan\.org|etherscan\.io)\/tx\/0x[0-9a-f]{64}$/;

/** chainId 有没有已知公网浏览器 → base URL; 认不出 (含本机 31337) → null */
export function explorerBaseUrl(chainId: number): string | null {
  const id = Number(chainId);
  if (!Number.isInteger(id) || id < 0) return null;
  return EXPLORER_BY_CHAIN[id] ?? null;
}

/** 交易链接; 链没浏览器 / 哈希非法 → null (调用方**不要**填 null 之外的占位) */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = explorerBaseUrl(chainId);
  const h = String(txHash ?? '').toLowerCase();
  if (!base || !TX_HASH_RE.test(h)) return null;
  return `${base}/tx/${h}`;
}

/** 这个字符串是不是我们亲手造的那种**交易**浏览器链接 (守卫 / 单测用) */
export function isExplorerUrl(url: unknown): boolean {
  return typeof url === 'string' && EXPLORER_URL_RE.test(url);
}
