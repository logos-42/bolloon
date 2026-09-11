/**
 * mobile-chain.ts — 手机端独立链上模块 (WebView / Capacitor, 不需要电脑端)
 *
 * 用户需求 (2026-09-11):
 *  让手机自己用钱包私钥 ① 签 x402 支付授权 (EIP-712 / EIP-3009 TransferWithAuthorization,
 *  产出可直接放进 HTTP 头的 `X-PAYMENT`) ② 自己构造/签名/广播 EVM 交易, 包括把资源/服务
 *  注册上链 (ResourceERC721.mint(address,uint256,string), tokenUri = ipfs://<CID>)。
 *
 * 设计约束:
 *  - 纯浏览器实现, **不 import 任何 node 内置模块** (fs/path/os/crypto 一律不碰)。
 *  - 所有网络访问走可注入 `fetchImpl`; 所有配置读写走可注入 `storage` (默认 localStorage)。
 *  - 全部导出函数失败**绝不抛异常** → 统一返回 `{ ok:false, error }`。
 *    (`rpcRequest` 例外: 它抛可捕获错误, 由上层包成 ok:false。)
 *  - 签名 / calldata 全部用 viem (与 desktop 端 @x402 一致, 浏览器安全)。
 */
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, getAddress, keccak256, numberToHex, toHex } from 'viem';

// ============================================================
// 类型
// ============================================================

export interface ChainConfig {
  /** JSON-RPC 端点 */
  rpcUrl: string;
  /** EVM chainId */
  chainId: number;
  /** 逻辑网络名: base | base-sepolia | mainnet | sepolia */
  network: string;
  /** 默认支付代币符号 */
  token: string;
}

/** 最小存储接口 (localStorage 兼容); 测试可注入内存实现 */
export interface ChainStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface JsonRpcOptions {
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AccountResult {
  ok: boolean;
  address?: string;
  account?: ReturnType<typeof privateKeyToAccount>;
  error?: string;
}

export interface TokenInfo {
  /** ERC-20 合约地址 */
  asset: string;
  /** EIP-712 domain name */
  name: string;
  /** EIP-712 domain version */
  version: string;
  decimals: number;
}

export interface SignX402Params {
  privateKey: string;
  /** 收款地址 */
  to: string;
  /** 人类单位金额 (如 '1.5' = 1.5 USDC) */
  amount: string | number;
  /** 代币符号, 默认 USDC */
  currency?: string;
  /** 网络 (base | eip155:8453 ...), 默认取 chain config */
  network?: string;
  /** 授权有效期 (秒), 默认 600 */
  validForSec?: number;
  /** 覆盖当前时间 (unix 秒) — 测试用 */
  now?: number;
  /** 覆盖 nonce (bytes32 hex) — 测试用 */
  nonce?: string;
  /** x402 协议版本, 默认 2 */
  x402Version?: number;
}

export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface SignX402Result {
  ok: boolean;
  authorization?: X402Authorization;
  signature?: string;
  /** 可直接放入 HTTP 头的 X-PAYMENT 值 (base64(JSON)) */
  header?: string;
  x402Version?: number;
  /** 供测试/审计断言用的 EIP-712 结构 */
  typedData?: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: typeof AUTHORIZATION_TYPES;
    primaryType: 'TransferWithAuthorization';
    message: X402Authorization;
  };
  error?: string;
}

export interface SendTxResult {
  ok: boolean;
  txHash?: string;
  /** 已签名的原始交易 (0x...) */
  raw?: string;
  error?: string;
}

export interface MintResourceParams {
  privateKey: string;
  /** ResourceERC721 合约地址 */
  contract: string;
  /** 铸币归属地址 */
  to: string;
  tokenId: string | number | bigint;
  /** metadata 指针, 传 'ipfs://<CID>' 或裸 CID 皆可 */
  tokenUri: string;
  network?: string;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  chainId?: number;
}

export interface MintResourceResult extends SendTxResult {
  /** mint(...) 的完整 calldata */
  data?: string;
  tokenId?: string;
  tokenUri?: string;
}

export interface Erc20TransferParams {
  privateKey: string;
  /** 收款地址 (不是代币合约) */
  to: string;
  /** 人类单位金额 */
  amount: string | number;
  /** 代币合约地址, 默认按 network 解析 USDC */
  token?: string;
  decimals?: number;
  network?: string;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  chainId?: number;
}

export interface RegisterServiceParams {
  privateKey: string;
  /** ResourceERC721 合约地址 */
  contract: string;
  agentId: string;
  serviceName: string;
  /** 内容 CID (可带 ipfs:// 前缀) */
  cid: string;
  /** 归属地址, 默认签名者本人 */
  to?: string;
  /** 指定 tokenId; 缺省时由 agentId+serviceName 确定性派生 */
  tokenId?: string | number | bigint;
  network?: string;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  chainId?: number;
}

export interface RegisterServiceResult extends MintResourceResult {
  agentId?: string;
  serviceName?: string;
}

// ============================================================
// 常量 / 注册表
// ============================================================

const CONFIG_KEY = 'bolloon_chain_config';

export const DEFAULT_CHAIN_CONFIG: ChainConfig = {
  rpcUrl: 'https://mainnet.base.org',
  chainId: 8453,
  network: 'base',
  token: 'USDC',
};

const DEFAULT_VALID_FOR_SEC = 600;
const DEFAULT_ERC20_GAS_LIMIT = 100000n;
const DEFAULT_MINT_GAS_LIMIT = 250000n;
const DEFAULT_MAX_FEE_PER_GAS = 1000000000n; // 1 gwei
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 100000000n; // 0.1 gwei

export const NETWORKS: Record<string, { chainId: number; caip2: string; v1: string }> = {
  base: { chainId: 8453, caip2: 'eip155:8453', v1: 'base' },
  'base-sepolia': { chainId: 84532, caip2: 'eip155:84532', v1: 'base-sepolia' },
  mainnet: { chainId: 1, caip2: 'eip155:1', v1: 'mainnet' },
  sepolia: { chainId: 11155111, caip2: 'eip155:11155111', v1: 'sepolia' },
};

/** network → 符号 → 代币元数据 (EIP-712 domain name/version + decimals) */
export const TOKENS: Record<string, Record<string, TokenInfo>> = {
  base: {
    USDC: { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', decimals: 6 },
  },
  'base-sepolia': {
    USDC: { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2', decimals: 6 },
  },
  mainnet: {
    USDC: { asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin', version: '2', decimals: 6 },
  },
  sepolia: {
    USDC: { asset: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', name: 'USDC', version: '2', decimals: 6 },
  },
};

/** EIP-3009 TransferWithAuthorization 类型 (与 @x402/evm 一致) */
export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** ERC-20 transfer(address,uint256) */
export const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/** ResourceERC721.mint(address,uint256,string) */
export const RESOURCE_ERC721_ABI = [
  {
    name: 'mint',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'tokenUri', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// ============================================================
// 小工具 (无 node 依赖)
// ============================================================

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const memoryFallback = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as ChainStorage;
})();

function resolveStorage(storage?: ChainStorage): ChainStorage {
  if (storage) return storage;
  const g = globalThis as unknown as { localStorage?: ChainStorage };
  if (g && g.localStorage && typeof g.localStorage.getItem === 'function') return g.localStorage;
  return memoryFallback;
}

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl;
  const g = globalThis as unknown as { fetch?: typeof fetch };
  if (g && typeof g.fetch === 'function') return g.fetch.bind(globalThis);
  throw new Error('fetch 不可用: 请注入 fetchImpl');
}

function normalizePrivateKey(privateKey: string): `0x${string}` {
  const t = (privateKey || '').trim();
  return (t.startsWith('0x') ? t : `0x${t}`) as `0x${string}`;
}

function randomNonceHex(): string {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const bytes = new Uint8Array(32);
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toHex(bytes);
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 纯 JS bytes → base64 (不依赖 btoa/Buffer, 浏览器与 node 通吃) */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
  }
  return out;
}

/** UTF-8 字符串 → base64 */
export function base64EncodeUtf8(str: string): string {
  return bytesToBase64(new TextEncoder().encode(str));
}

/** 人类单位金额 → 最小单位 (bigint); 非法金额抛错 (调用方已包 ok:false) */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const s = typeof amount === 'number' ? String(amount) : String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`无效金额: ${amount}`);
  const [intPart, fracPart = ''] = s.split('.');
  const paddedFrac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0');
}

/** 归一化网络名 (支持 'base' 与 'eip155:8453') */
export function normalizeNetwork(network?: string): string {
  const n = (network || DEFAULT_CHAIN_CONFIG.network).trim();
  if (NETWORKS[n]) return n;
  if (n.startsWith('eip155:')) {
    const chainId = parseInt(n.split(':')[1], 10);
    const found = Object.keys(NETWORKS).find((k) => NETWORKS[k].chainId === chainId);
    if (found) return found;
  }
  throw new Error(`不支持的链上网络: ${network}`);
}

/** 解析某网络下的代币元数据 */
export function resolveToken(network: string, symbol = 'USDC'): TokenInfo | undefined {
  const table = TOKENS[network];
  if (!table) return undefined;
  return table[symbol.toUpperCase()];
}

// ============================================================
// 配置持久化
// ============================================================

/** 读取链上配置 (缺省 = Base mainnet 8453 + USDC) */
export function getChainConfig(storage?: ChainStorage): ChainConfig {
  try {
    const raw = resolveStorage(storage).getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CHAIN_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ChainConfig> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CHAIN_CONFIG };
    return { ...DEFAULT_CHAIN_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CHAIN_CONFIG };
  }
}

/** 写入链上配置 (与默认值/既有值合并) */
export function setChainConfig(cfg: Partial<ChainConfig>, storage?: ChainStorage): ChainConfig {
  const merged: ChainConfig = { ...getChainConfig(storage), ...(cfg || {}) };
  try {
    resolveStorage(storage).setItem(CONFIG_KEY, JSON.stringify(merged));
  } catch {
    /* 存储不可用时仅返回内存态, 不抛 */
  }
  return merged;
}

// ============================================================
// JSON-RPC over fetch
// ============================================================

let rpcSeq = 1;

/**
 * 发一条 JSON-RPC 请求, 返回 result。
 * RPC 报错 / 网络异常 / 无 result → 抛可捕获 Error (上层包 ok:false)。
 */
export async function rpcRequest<T = unknown>(
  method: string,
  params: unknown[] = [],
  opts: JsonRpcOptions = {}
): Promise<T> {
  const rpcUrl = opts.rpcUrl || getChainConfig().rpcUrl || DEFAULT_CHAIN_CONFIG.rpcUrl;
  const f = resolveFetch(opts.fetchImpl);
  const id = rpcSeq++;
  const res = await f(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res || typeof (res as Response).json !== 'function') {
    throw new Error('RPC 响应无效 (无 json())');
  }
  const json = (await (res as Response).json()) as
    | { result?: unknown; error?: { code?: number; message?: string } }
    | null;
  if (!json) throw new Error('RPC 空响应');
  if (json.error) {
    const code = json.error.code !== undefined ? `${json.error.code} ` : '';
    throw new Error(`RPC 错误: ${code}${json.error.message || '未知错误'}`);
  }
  return json.result as T;
}

// ============================================================
// 账户
// ============================================================

/** 私钥 → 账户 (确定性地址)。失败返回 { ok:false, error }。 */
export function accountFromPrivateKey(privateKey: string): AccountResult {
  try {
    if (!privateKey || typeof privateKey !== 'string') throw new Error('私钥不能为空');
    const account = privateKeyToAccount(normalizePrivateKey(privateKey));
    return { ok: true, address: account.address, account };
  } catch (e) {
    return { ok: false, error: `解析私钥失败: ${errMsg(e)}` };
  }
}

// ============================================================
// x402 支付授权 (EIP-712 / EIP-3009)
// ============================================================

/**
 * 用私钥签 x402 支付授权, 产出可直接放进 HTTP 头的 X-PAYMENT。
 *
 * payload 形状与 @x402 一致:
 *   { x402Version: 2, payload: { authorization, signature } }
 * header = base64(JSON.stringify(payload))
 */
export async function signX402Authorization(params: SignX402Params): Promise<SignX402Result> {
  try {
    const { privateKey, to, amount } = params;
    if (!to) throw new Error('收款地址 to 不能为空');
    const currency = (params.currency || DEFAULT_CHAIN_CONFIG.token || 'USDC').toUpperCase();
    const network = normalizeNetwork(params.network);
    const net = NETWORKS[network];
    const token = resolveToken(network, currency);
    if (!token) throw new Error(`网络 ${network} 不支持代币 ${currency}`);

    const account = privateKeyToAccount(normalizePrivateKey(privateKey));
    const value = toBaseUnits(amount, token.decimals);
    const now = typeof params.now === 'number' ? params.now : Math.floor(Date.now() / 1000);
    const validFor = typeof params.validForSec === 'number' ? params.validForSec : DEFAULT_VALID_FOR_SEC;

    const authorization: X402Authorization = {
      from: account.address,
      to: getAddress(to),
      value: value.toString(),
      validAfter: '0',
      validBefore: String(now + validFor),
      nonce: params.nonce || randomNonceHex(),
    };

    const domain = {
      name: token.name,
      version: token.version,
      chainId: net.chainId,
      verifyingContract: getAddress(token.asset),
    };

    const message = {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    };

    const signature = await account.signTypedData({
      domain,
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
    });

    const x402Version = params.x402Version ?? 2;
    const header = base64EncodeUtf8(JSON.stringify({ x402Version, payload: { authorization, signature } }));

    return {
      ok: true,
      authorization,
      signature,
      header,
      x402Version,
      typedData: {
        domain,
        types: AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorization,
      },
    };
  } catch (e) {
    return { ok: false, error: `签 x402 授权失败: ${errMsg(e)}` };
  }
}

// ============================================================
// EVM 交易构造 / 签名 / 广播
// ============================================================

interface BuildSendParams {
  privateKey: string;
  to: string;
  data: string;
  value?: bigint;
  chainId: number;
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  gasLimit?: bigint;
}

async function buildSignAndSend(
  p: BuildSendParams
): Promise<{ raw: string; txHash: string }> {
  const account = privateKeyToAccount(normalizePrivateKey(p.privateKey));
  const opts: JsonRpcOptions = { rpcUrl: p.rpcUrl, fetchImpl: p.fetchImpl };

  const nonceHex = await rpcRequest<string>('eth_getTransactionCount', [account.address, 'pending'], opts);
  const nonce = Number(BigInt(nonceHex || '0x0'));

  let maxFeePerGas = DEFAULT_MAX_FEE_PER_GAS;
  let maxPriorityFeePerGas = DEFAULT_MAX_PRIORITY_FEE_PER_GAS;
  try {
    const gasPriceHex = await rpcRequest<string>('eth_gasPrice', [], opts);
    if (gasPriceHex) {
      maxPriorityFeePerGas = BigInt(gasPriceHex);
      maxFeePerGas = maxPriorityFeePerGas * 2n;
    }
  } catch {
    /* 用默认费, 不阻塞 */
  }

  let gas = p.gasLimit ?? DEFAULT_ERC20_GAS_LIMIT;
  try {
    const estHex = await rpcRequest<string>(
      'eth_estimateGas',
      [{ from: account.address, to: p.to, data: p.data, value: numberToHex(p.value ?? 0n) }],
      opts
    );
    if (estHex) gas = (BigInt(estHex) * 12n) / 10n; // +20% 缓冲
  } catch {
    /* 用默认 gas, 不阻塞 */
  }

  const raw = await account.signTransaction({
    chainId: p.chainId,
    to: getAddress(p.to),
    data: p.data as `0x${string}`,
    value: p.value ?? 0n,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  });

  const txHash = await rpcRequest<string>('eth_sendRawTransaction', [raw], opts);
  return { raw, txHash: String(txHash) };
}

/** 自己构造 + 签名 + 广播一笔 ERC-20 transfer */
export async function erc20Transfer(params: Erc20TransferParams): Promise<SendTxResult> {
  try {
    const network = normalizeNetwork(params.network);
    const net = NETWORKS[network];
    const chainId = params.chainId ?? net.chainId;

    let tokenAddress = params.token;
    let decimals = params.decimals;
    if (!tokenAddress || decimals === undefined) {
      const meta = resolveToken(network, DEFAULT_CHAIN_CONFIG.token || 'USDC');
      if (meta) {
        decimals = decimals ?? meta.decimals;
        tokenAddress = tokenAddress || meta.asset;
      }
    }
    if (!tokenAddress) throw new Error(`无法确定代币合约 (network=${network})`);
    if (decimals === undefined) decimals = 6;

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(params.to), toBaseUnits(params.amount, decimals)],
    });

    const { raw, txHash } = await buildSignAndSend({
      privateKey: params.privateKey,
      to: tokenAddress,
      data,
      value: 0n,
      chainId,
      rpcUrl: params.rpcUrl,
      fetchImpl: params.fetchImpl,
      gasLimit: DEFAULT_ERC20_GAS_LIMIT,
    });

    return { ok: true, txHash, raw };
  } catch (e) {
    return { ok: false, error: `ERC-20 转账失败: ${errMsg(e)}` };
  }
}

/** 自己上链把资源铸成 ResourceERC721 (calldata = mint(address,uint256,string)) */
export async function mintResourceToken(params: MintResourceParams): Promise<MintResourceResult> {
  try {
    const network = normalizeNetwork(params.network);
    const net = NETWORKS[network];
    const chainId = params.chainId ?? net.chainId;

    const tokenIdStr = String(params.tokenId);
    const tokenUri = params.tokenUri.startsWith('ipfs://') || params.tokenUri.includes('://')
      ? params.tokenUri
      : `ipfs://${params.tokenUri}`;

    const data = encodeFunctionData({
      abi: RESOURCE_ERC721_ABI,
      functionName: 'mint',
      args: [getAddress(params.to), BigInt(params.tokenId), tokenUri],
    });

    const { raw, txHash } = await buildSignAndSend({
      privateKey: params.privateKey,
      to: params.contract,
      data,
      value: 0n,
      chainId,
      rpcUrl: params.rpcUrl,
      fetchImpl: params.fetchImpl,
      gasLimit: DEFAULT_MINT_GAS_LIMIT,
    });

    return { ok: true, txHash, raw, data, tokenId: tokenIdStr, tokenUri };
  } catch (e) {
    return { ok: false, error: `上链铸资源失败: ${errMsg(e)}` };
  }
}

/** 由 agentId + serviceName 确定性派生 tokenId */
export function deriveTokenId(agentId: string, serviceName: string): bigint {
  return BigInt(keccak256(toHex(`${agentId}:${serviceName}`)));
}

/** 把服务/资源注册上链 (内部调 mintResourceToken, tokenUri = ipfs://<cid>) */
export async function registerServiceOnChain(
  params: RegisterServiceParams
): Promise<RegisterServiceResult> {
  try {
    const account = privateKeyToAccount(normalizePrivateKey(params.privateKey));
    const to = params.to ? getAddress(params.to) : account.address;
    const tokenId =
      params.tokenId !== undefined ? params.tokenId : deriveTokenId(params.agentId, params.serviceName);
    const cid = params.cid.startsWith('ipfs://') ? params.cid : `ipfs://${params.cid}`;

    const mint = await mintResourceToken({
      privateKey: params.privateKey,
      contract: params.contract,
      to,
      tokenId,
      tokenUri: cid,
      network: params.network,
      rpcUrl: params.rpcUrl,
      fetchImpl: params.fetchImpl,
      chainId: params.chainId,
    });

    if (!mint.ok) return { ...mint, agentId: params.agentId, serviceName: params.serviceName };
    return {
      ...mint,
      agentId: params.agentId,
      serviceName: params.serviceName,
      tokenId: String(tokenId),
      tokenUri: cid,
    };
  } catch (e) {
    return { ok: false, error: `注册服务上链失败: ${errMsg(e)}` };
  }
}
