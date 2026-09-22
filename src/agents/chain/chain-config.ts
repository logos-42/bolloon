/**
 * chain-config.ts — 链桥配置 (P3: Bolloon 链桥)
 *
 * 这个文件只做一件事: 把「链在哪 / 合约在哪 / 要几个确认 / 用哪个钱包」这四类
 * **可配置事实**从确定的地方读出来, 并且**绝不硬编码任何密钥**。
 *
 * 读取优先级 (不可颠倒; 这是硬规则):
 *   ① 环境变量            — 进程显式给的最优先
 *   ② 本地安全配置文件     — `~/.bolloon/chain.json` (0600, 只放公开事实 + 可选 RPC/地址)
 *   ③ 报错                — 取不到就抛错, 不许猜、不许 fallback 到某个内置地址
 *
 * 钱包私钥单独一条链 (同样 ①②③), 且**显式拒绝**任何看起来像别的 agent 的钱包目录
 * (例如 `~/.hermes/wallets/...`) —— 那不属于本进程, 读了就是越权。
 *
 * 确认数口径 (写成配置, 不硬编码在逻辑里):
 *   confirmed = 1   — 至少被 1 个区块压住, 才允许说「链上结算了」
 *   finalized = 12  — 12 个确认, 才允许说「最终确定」
 *   两档都可以用 env / chain.json 覆盖, 但**只能调大不能调小到 0**
 *   (0 确认 = 只要交易在内存池就算数, 那不是结算, 是幻觉)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** anvil / hardhat 默认本地链 */
export const LOCAL_DEV_CHAIN_ID = 31337;

/** USDC 标准精度 (公开事实, 不是密钥) */
export const DEFAULT_TOKEN_DECIMALS = 6;

/**
 * 确认数默认值 —— **配置**, 不是逻辑里的魔法数字。
 * 改这里 / 用 env / 用 chain.json 都能覆盖。
 */
export const DEFAULT_CONFIRMATIONS: ChainConfirmations = Object.freeze({
  /** 低于这个数一律不许说「已结算」 */
  confirmed: 1,
  /** 达到这个数才允许说「最终确定」 */
  finalized: 12,
});

export interface ChainConfirmations {
  confirmed: number;
  finalized: number;
}

export interface ChainConfig {
  chainId: number;
  networkName: string;
  rpcUrl: string;
  escrowAddress: string;
  tokenAddress: string | null;
  tokenDecimals: number;
  confirmations: ChainConfirmations;
  /** 每个字段的来源 (审计用: 出问题要能说清"这个值哪来的") */
  sources: Record<string, string>;
}

export class ChainConfigError extends Error {
  constructor(message: string, public readonly missing: string[]) {
    super(message);
    this.name = 'ChainConfigError';
  }
}

// ── 路径 ────────────────────────────────────────────────────────────────────

export function bolloonHome(home?: string): string {
  return path.join(home || process.env.HOME || os.homedir(), '.bolloon');
}

/** 本地安全配置 (公开事实 + 可选 RPC/地址; 私钥**不**放这里) */
export function chainConfigPath(home?: string): string {
  return path.join(bolloonHome(home), 'chain.json');
}

/** 本机钱包文件 (与 x402 路径同一份; 0600) */
export function walletFilePath(home?: string): string {
  return path.join(bolloonHome(home), 'wallet.json');
}

/**
 * 别的 agent / 别的框架的钱包目录绝不许被本模块读取。
 * 这里不是"建议", 是拒绝执行。
 */
const FOREIGN_WALLET_MARKERS = [
  `${path.sep}.hermes${path.sep}wallets`,
  `${path.sep}.claude${path.sep}wallets`,
  `${path.sep}.codex${path.sep}wallets`,
];

export function assertNotForeignWalletPath(p: string): void {
  const abs = path.resolve(p);
  for (const marker of FOREIGN_WALLET_MARKERS) {
    if (abs.includes(marker)) {
      throw new ChainConfigError(
        `拒绝读取其它 agent 的钱包目录: ${abs} (只允许 ~/.bolloon/wallet.json 或本进程环境变量)`,
        ['wallet.privateKey'],
      );
    }
  }
}

// ── 读取辅助 ────────────────────────────────────────────────────────────────

function readLocalChainJson(home?: string): Record<string, any> | null {
  const p = chainConfigPath(home);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // 坏文件 = 当作没有 (但下面每个字段都会落到报错, 不会静默给默认值)
  }
}

/** 正整数解析; 非法 / 0 / 负数 → null */
function posInt(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDR_RE.test(v);
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export interface LoadChainConfigOptions {
  home?: string;
  /** 显式覆盖 (测试用; 优先级最高) */
  overrides?: Partial<ChainConfig>;
  env?: NodeJS.ProcessEnv;
}

/**
 * 读链配置。取不到必需项 → 抛 `ChainConfigError` 并列出缺哪些。
 * **不猜地址, 不给默认合约地址** —— 猜错的地址比报错危险得多。
 */
export function loadChainConfig(opts: LoadChainConfigOptions = {}): ChainConfig {
  const env = opts.env || process.env;
  const home = opts.home;
  const file = readLocalChainJson(home);
  const sources: Record<string, string> = {};
  const missing: string[] = [];

  // ① RPC
  let rpcUrl: string | null = null;
  if (env.BOLLOON_CHAIN_RPC_URL) { rpcUrl = String(env.BOLLOON_CHAIN_RPC_URL); sources.rpcUrl = 'env BOLLOON_CHAIN_RPC_URL'; }
  else if (env.BOLLOON_RPC_URL) { rpcUrl = String(env.BOLLOON_RPC_URL); sources.rpcUrl = 'env BOLLOON_RPC_URL'; }
  else if (env.RPC_URL) { rpcUrl = String(env.RPC_URL); sources.rpcUrl = 'env RPC_URL'; }
  else if (file?.rpcUrl) { rpcUrl = String(file.rpcUrl); sources.rpcUrl = `${chainConfigPath(home)} .rpcUrl`; }
  else missing.push('rpcUrl');

  // ② chainId
  let chainId: number | null = null;
  if (posInt(env.BOLLOON_CHAIN_ID) !== null) { chainId = posInt(env.BOLLOON_CHAIN_ID); sources.chainId = 'env BOLLOON_CHAIN_ID'; }
  else if (posInt(file?.chainId) !== null) { chainId = posInt(file?.chainId); sources.chainId = `${chainConfigPath(home)} .chainId`; }
  else missing.push('chainId');

  // ③ escrow 地址
  let escrowAddress: string | null = null;
  if (env.BOLLOON_ESCROW_ADDRESS) {
    if (!isAddress(env.BOLLOON_ESCROW_ADDRESS)) throw new ChainConfigError(`BOLLOON_ESCROW_ADDRESS 不是合法地址: ${env.BOLLOON_ESCROW_ADDRESS}`, ['escrowAddress']);
    escrowAddress = env.BOLLOON_ESCROW_ADDRESS; sources.escrowAddress = 'env BOLLOON_ESCROW_ADDRESS';
  } else if (file?.escrowAddress) {
    if (!isAddress(file.escrowAddress)) throw new ChainConfigError(`${chainConfigPath(home)} .escrowAddress 不是合法地址`, ['escrowAddress']);
    escrowAddress = file.escrowAddress; sources.escrowAddress = `${chainConfigPath(home)} .escrowAddress`;
  } else missing.push('escrowAddress');

  // ④ token 地址 (可空 — 只做 escrow 操作时不必给)
  let tokenAddress: string | null = null;
  if (isAddress(env.BOLLOON_TOKEN_ADDRESS)) { tokenAddress = env.BOLLOON_TOKEN_ADDRESS; sources.tokenAddress = 'env BOLLOON_TOKEN_ADDRESS'; }
  else if (isAddress(file?.tokenAddress)) { tokenAddress = file.tokenAddress; sources.tokenAddress = `${chainConfigPath(home)} .tokenAddress`; }
  else sources.tokenAddress = '未配置 (只做 escrow 读/写时不需要)';

  // ⑤ token decimals
  let tokenDecimals = DEFAULT_TOKEN_DECIMALS;
  sources.tokenDecimals = '默认 (USDC=6)';
  const envDec = posInt(env.BOLLOON_TOKEN_DECIMALS);
  const fileDec = posInt(file?.tokenDecimals);
  if (envDec !== null) { tokenDecimals = envDec; sources.tokenDecimals = 'env BOLLOON_TOKEN_DECIMALS'; }
  else if (fileDec !== null) { tokenDecimals = fileDec; sources.tokenDecimals = `${chainConfigPath(home)} .tokenDecimals`; }

  // ⑥ 确认数 (配置值; 非法/0 一律落到默认值而不是"0 确认")
  const envConfirmed = posInt(env.BOLLOON_CONFIRMATIONS_CONFIRMED);
  const envFinalized = posInt(env.BOLLOON_CONFIRMATIONS_FINALIZED);
  const fileConfirmed = posInt(file?.confirmations?.confirmed);
  const fileFinalized = posInt(file?.confirmations?.finalized);
  let confirmed = DEFAULT_CONFIRMATIONS.confirmed;
  let finalized = DEFAULT_CONFIRMATIONS.finalized;
  if (fileConfirmed !== null) confirmed = fileConfirmed;
  if (fileFinalized !== null) finalized = fileFinalized;
  if (envConfirmed !== null) confirmed = envConfirmed;
  if (envFinalized !== null) finalized = envFinalized;
  sources.confirmations = envConfirmed !== null || envFinalized !== null
    ? 'env BOLLOON_CONFIRMATIONS_*'
    : (fileConfirmed !== null || fileFinalized !== null ? `${chainConfigPath(home)} .confirmations` : '默认 (confirmed=1, finalized=12)');
  // finalized 不能比 confirmed 还低 —— 静默修正是不允许的, 这是配置自洽性检查
  if (finalized < confirmed) {
    throw new ChainConfigError(`确认数配置不自洽: finalized(${finalized}) < confirmed(${confirmed})`, ['confirmations']);
  }

  // ⑦ networkName
  let networkName = 'unknown';
  if (env.BOLLOON_NETWORK_NAME) { networkName = String(env.BOLLOON_NETWORK_NAME); sources.networkName = 'env BOLLOON_NETWORK_NAME'; }
  else if (file?.networkName) { networkName = String(file.networkName); sources.networkName = `${chainConfigPath(home)} .networkName`; }
  else sources.networkName = '默认 unknown';

  if (missing.length) {
    throw new ChainConfigError(
      `链配置缺失: ${missing.join(', ')}。读取优先级 = 环境变量 → ${chainConfigPath(home)} → 报错; ` +
      `本模块不猜合约地址。缺 RPC 时设 BOLLOON_CHAIN_RPC_URL; 缺 escrow 时设 BOLLOON_ESCROW_ADDRESS。`,
      missing,
    );
  }

  const cfg: ChainConfig = {
    chainId: chainId!, networkName, rpcUrl: rpcUrl!,
    escrowAddress: escrowAddress!, tokenAddress, tokenDecimals,
    confirmations: Object.freeze({ confirmed, finalized }) as ChainConfirmations,
    sources,
  };
  return { ...cfg, ...(opts.overrides || {}), sources };
}

/**
 * 确认数门槛判定 (纯函数, 单一实现 —— 所有"够不够确认"的判断都走这里)。
 * `finalizedAt >= confirmedAt` 由配置保证; 这里只做数值比较, 不修状态。
 */
export function meetsConfirmations(
  confirmations: number,
  gate: 'confirmed' | 'finalized',
  cfg: ChainConfirmations = DEFAULT_CONFIRMATIONS,
): boolean {
  const need = gate === 'finalized' ? cfg.finalized : cfg.confirmed;
  return Number.isFinite(confirmations) && confirmations >= need;
}

// ── 钱包私钥 (同样 ①②③; 绝不硬编码) ────────────────────────────────────────

export interface WalletKeyResult {
  privateKey: string;
  /** 只说来源, 不含密钥本身 */
  source: string;
}

export interface ReadWalletKeyOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 读本机钱包私钥 (唯一的密钥读取入口)。
 * ① 环境变量 ② `~/.bolloon/wallet.json` ③ 报错。
 * 返回值里的 `privateKey` **只许在调用栈的局部变量里存在** —— 调用方不得打印/落盘/进审计。
 */
export function readWalletPrivateKey(opts: ReadWalletKeyOptions = {}): WalletKeyResult {
  const env = opts.env || process.env;
  const fromEnv = env.BOLLOON_WALLET_PRIVATE_KEY || env.BOLLOON_LOCAL_DEV_PRIVATE_KEY;
  const envName = env.BOLLOON_WALLET_PRIVATE_KEY ? 'BOLLOON_WALLET_PRIVATE_KEY' : 'BOLLOON_LOCAL_DEV_PRIVATE_KEY';
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(fromEnv))) {
      throw new ChainConfigError(`${envName} 格式不对 (要 0x + 64 hex)`, ['wallet.privateKey']);
    }
    return { privateKey: String(fromEnv), source: `env ${envName}` };
  }

  const wf = walletFilePath(opts.home);
  assertNotForeignWalletPath(wf);
  if (!fs.existsSync(wf)) {
    throw new ChainConfigError(
      `本机没有可用钱包: ${wf} 不存在, 且未设 BOLLOON_WALLET_PRIVATE_KEY。` +
      `读取优先级 = 环境变量 → ~/.bolloon/wallet.json → 报错 (绝不硬编码密钥, 也不读别的 agent 的钱包目录)。`,
      ['wallet.privateKey'],
    );
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(wf, 'utf8'));
  } catch {
    throw new ChainConfigError(`${wf} 读不出来 / 不是合法 JSON`, ['wallet.privateKey']);
  }
  const pk = String(raw?.privateKey || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new ChainConfigError(`${wf} 里没有可用的 privateKey 字段 (要 0x + 64 hex)`, ['wallet.privateKey']);
  }
  return { privateKey: pk, source: '~/.bolloon/wallet.json' };
}

/**
 * 只探测钱包是否可用 (绝不返回私钥)。给"要不要签名"的判据用。
 */
export function walletAvailable(opts: ReadWalletKeyOptions = {}): { available: boolean; source: string; reason?: string } {
  try {
    const r = readWalletPrivateKey(opts);
    return { available: r.privateKey.length === 66, source: r.source };
  } catch (e: any) {
    return { available: false, source: 'none', reason: String(e?.message || e).slice(0, 200) };
  }
}
