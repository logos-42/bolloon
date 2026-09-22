/**
 * chain-config.ts — 链桥配置 (P3: Bolloon 链桥)
 *
 * 这个文件只做一件事: 把「链在哪 / 合约在哪 / 要几个确认 / 用哪个钱包」这四类
 * **可配置事实**从确定的地方读出来, 并且**绝不硬编码任何密钥**。
 *
 * 读取优先级 (不可颠倒; 这是硬规则):
 *   ① 环境变量            — 进程显式给的最优先
 *   ② 本地安全配置文件     — `~/.bolloon/chain.json` (0600, 只放公开事实 + 可选 RPC/地址)
 *   ③ 仓库部署 manifest    — `contracts/deployments/<network>.json` (按 chainId / networkName
 *                            等**锚**匹配; 详见下面「第 ③ 层」一节), 只填 ①② 没给的字段
 *   ④ 报错                — 取不到就抛错, 不许猜、不许 fallback 到某个内置地址
 *
 * 第 ③ 层不是"猜地址": manifest 是部署脚本写进仓库的**部署事实** (chainId + 地址 +
 * 部署块 + bytecodeHash)。它让"换个 HOME / CI 上跑"也能拿到同一台机器刚部署的合约,
 * 而不是把「本机没写 chain.json」错报成「链没配置」。选中它必须有**锚**, 有歧义就报错。
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

// ── 第 ③ 层: 仓库里的部署 manifest ──────────────────────────────────────────
//
// 为什么有这一层 (2026-09-22 修「靠环境巧合才绿的门」):
//   链上地址是**部署事实**, 已经逐字写在仓库的 `contracts/deployments/*.json` 里
//   (部署脚本自己写的: chainId / 合约地址 / 部署块 / bytecodeHash / 构造参数)。
//   只认 env 与 `~/.bolloon/chain.json` 的后果是: 换个 HOME (CI、别的机器、验收用的
//   临时 HOME) 就没有链配置 → `chain status` 报 CHAIN_NOT_CONFIGURED, 而**同一份仓库里
//   刚刚部署出的合约地址其实就在手边**。那不是"链没配置", 是"配置读的层太少"。
//
// 口径 (与 chain-indexer 解析 deployment block 同源, 不另立第二套):
//   ① env (`BOLLOON_*`) → ② `~/.bolloon/chain.json` → ③ 仓库 manifest → ④ 报错
//   ③ 必须**有锚**才允许被选中: 锚 = ① ② 里已知的 chainId / networkName / rpcUrl /
//     escrowAddress 任一。没有锚就说不出"这是哪条链的部署" → 一律不选 (**不猜**)。
//   多份 manifest 同时匹配 → 歧义 → 不选 (报错里列出候选, 让人说清是哪份)。
//   文件名 `<networkName>.json` 与已知 networkName 一致时**优先** (仓库约定: 一个网络一份)。
//   ③ 只能**填 ① ② 没给的字段** —— 优先级不可颠倒。
//   合约地址在 manifest 里可能记在两处: `.token.address` (自部署替身) 或
//   `.externalToken.address` (外部真 token, 如 USDC) —— 两个都认, 后者是回退。

export const DEPLOYMENTS_DIR_ENV = 'BOLLOON_DEPLOYMENTS_DIR';

/** 部署 manifest 目录: env → 从 cwd 往上找 `contracts/deployments` → cwd 下的默认位置 */
export function deploymentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DEPLOYMENTS_DIR_ENV];
  if (fromEnv) return path.resolve(String(fromEnv));
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'contracts', 'deployments');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), 'contracts', 'deployments');
}

export interface DeploymentManifest {
  /** 文件绝对路径 */
  path: string;
  /** 展示用 (相对 cwd; 不在 cwd 下则给绝对路径) */
  label: string;
  chainId: number | null;
  networkName: string | null;
  rpcUrl: string | null;
  escrowAddress: string;
  escrowBlockNumber: number | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  /** token 记在哪: '.token' (自部署) / '.externalToken' (外部真 token) */
  tokenField: '.token' | '.externalToken' | null;
}

/** 解析一份 manifest (形状不对 → null; 绝不猜)。**只读**, 不含任何密钥。 */
export function parseDeploymentManifest(file: string, raw: any): DeploymentManifest | null {
  const escrow = (raw?.contracts || []).find((c: any) => c?.name === 'AgentEscrow');
  if (!escrow || !isAddress(escrow.address)) return null;
  const tokenField: DeploymentManifest['tokenField'] = isAddress(raw?.token?.address)
    ? '.token'
    : (isAddress(raw?.externalToken?.address) ? '.externalToken' : null);
  const tokenRaw = tokenField ? raw[tokenField.slice(1)] : null;
  const blk = Number(escrow.blockNumber);
  const rel = path.relative(process.cwd(), file);
  return {
    path: file,
    label: rel && !rel.startsWith('..') ? rel : file,
    chainId: posInt(raw?.chainId),
    networkName: typeof raw?.networkName === 'string' && raw.networkName ? String(raw.networkName) : null,
    rpcUrl: typeof raw?.rpcUrl === 'string' && raw.rpcUrl ? String(raw.rpcUrl) : null,
    escrowAddress: String(escrow.address),
    escrowBlockNumber: Number.isInteger(blk) && blk >= 0 ? blk : null,
    tokenAddress: tokenField ? String(tokenRaw.address) : null,
    tokenDecimals: posInt(tokenRaw?.decimals),
    tokenField,
  };
}

/** 列出目录里所有能认的 manifest (读不了 / 形状不对的一律跳过, 不静默当空) */
export function listDeploymentManifests(opts: { deploymentsDir?: string } = {}): DeploymentManifest[] {
  const dir = opts.deploymentsDir || deploymentsDir();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: DeploymentManifest[] = [];
  for (const f of files.sort()) {
    const p = path.join(dir, f);
    try {
      const man = parseDeploymentManifest(p, JSON.parse(fs.readFileSync(p, 'utf8')));
      if (man) out.push(man);
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

export interface DeploymentManifestSelection {
  manifest: DeploymentManifest | null;
  /** 目录里所有候选 (报错信息要能列出它们) */
  candidates: DeploymentManifest[];
  /** 为什么选中 / 为什么不选 (可直接进 sources 与报错文案) */
  reason: string;
  deploymentsDir: string;
}

/** 归一化比较用的 rpcUrl (去尾斜杠 + 小写 host 部分原样) */
function normRpc(u: string | null | undefined): string | null {
  if (!u) return null;
  return String(u).trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 按**已知的锚**从 manifest 目录里选一份部署事实。
 *
 * 锚 = chainId / networkName / rpcUrl / escrowAddress (调用方给的都算"必须匹配")。
 * 没有锚 → 不选 (说不出是哪条链); 多份匹配 → 不选 (歧义)。**任何情况下都不猜。**
 */
export function selectDeploymentManifest(opts: {
  chainId?: number | null;
  networkName?: string | null;
  rpcUrl?: string | null;
  escrowAddress?: string | null;
  deploymentsDir?: string;
} = {}): DeploymentManifestSelection {
  const dir = opts.deploymentsDir || deploymentsDir();
  const candidates = listDeploymentManifests({ deploymentsDir: dir });
  const wantChain = opts.chainId ?? null;
  const wantName = opts.networkName && opts.networkName !== 'unknown' ? String(opts.networkName) : null;
  const wantRpc = normRpc(opts.rpcUrl);
  const wantEscrow = isAddress(opts.escrowAddress) ? String(opts.escrowAddress).toLowerCase() : null;

  const anchors = [
    wantChain !== null ? `chainId=${wantChain}` : null,
    wantName ? `networkName=${wantName}` : null,
    wantRpc ? `rpcUrl=${wantRpc}` : null,
    wantEscrow ? `escrowAddress=${wantEscrow}` : null,
  ].filter((x): x is string => !!x);

  const hits = (m: DeploymentManifest): boolean =>
    (wantChain === null || m.chainId === wantChain) &&
    (wantName === null || m.networkName === wantName) &&
    (wantRpc === null || normRpc(m.rpcUrl) === wantRpc) &&
    (wantEscrow === null || m.escrowAddress.toLowerCase() === wantEscrow);

  if (!anchors.length) {
    return {
      manifest: null, candidates, deploymentsDir: dir,
      reason: `没有锚 (chainId / networkName / rpcUrl / escrowAddress 一个都没有) → 说不出是哪条链的部署, 不选${candidates.length ? ` (目录里有 ${candidates.length} 份候选: ${candidates.map((c) => path.basename(c.path)).join(', ')})` : ` (目录 ${dir} 里没有可认的 manifest)`}`,
    };
  }

  // ① 文件名约定优先: <networkName>.json (一个网络一份 manifest)
  if (wantName) {
    const byFile = candidates.filter((m) => path.basename(m.path) === `${wantName}.json`);
    if (byFile.length === 1) {
      const m = byFile[0];
      if (wantChain !== null && m.chainId !== null && m.chainId !== wantChain) {
        return { manifest: null, candidates, deploymentsDir: dir, reason: `文件名 ${path.basename(m.path)} 是 networkName=${wantName} 的部署, 但它记的 chainId=${m.chainId} ≠ 你要的 ${wantChain} → 拒绝跨链取地址` };
      }
      return { manifest: m, candidates, deploymentsDir: dir, reason: `networkName=${wantName} → 文件名 ${path.basename(m.path)} (锚: ${anchors.join(', ')})` };
    }
  }

  // ② 所有给出的锚都必须匹配同一份
  const matched = candidates.filter(hits);
  if (matched.length === 1) {
    return { manifest: matched[0], candidates, deploymentsDir: dir, reason: `锚 ${anchors.join(', ')} 唯一匹配 ${path.basename(matched[0].path)}` };
  }
  if (matched.length === 0) {
    return {
      manifest: null, candidates, deploymentsDir: dir,
      reason: `锚 ${anchors.join(', ')} 在 ${dir} 里一份都匹配不上${candidates.length ? ` (候选: ${candidates.map((c) => `${path.basename(c.path)}(chainId=${c.chainId}, network=${c.networkName}, escrow=${c.escrowAddress})`).join(', ')})` : ' (目录里没有可认的 manifest)'} → 拒绝猜`,
    };
  }
  return {
    manifest: null, candidates, deploymentsDir: dir,
    reason: `锚 ${anchors.join(', ')} 同时匹配 ${matched.length} 份 manifest (${matched.map((c) => path.basename(c.path)).join(', ')}) → 歧义, 拒绝猜; 请用 BOLLOON_NETWORK_NAME 或 BOLLOON_ESCROW_ADDRESS 说清是哪一份, 或用 BOLLOON_DEPLOYMENTS_DIR 指向只放一份 manifest 的目录`,
  };
}

/**
 * 「拿不到 token 地址」的可操作报错文案 (真写 createEscrow 必须有它)。
 * 只说**怎么修**, 不含任何密钥; 三层来源逐个点名。
 */
export function tokenAddressGuidance(opts: { home?: string; networkName?: string | null; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env || process.env;
  const dir = deploymentsDir(env);
  return (
    `真写 (createEscrow) 需要**付款资产** (token) 地址, 但三层都拿不到:` +
    ` ① env BOLLOON_TOKEN_ADDRESS(未设)` +
    ` ② ${chainConfigPath(opts.home)}(无 tokenAddress)` +
    ` ③ 仓库部署 manifest ${dir} 里 networkName=${opts.networkName || 'unknown'} 那份的 .token.address / .externalToken.address` +
    `。怎么修: (a) export BOLLOON_TOKEN_ADDRESS=0x…(真 USDC 或本地 MockERC20);` +
    ` (b) 或在 ${chainConfigPath(opts.home)} 写 {"tokenAddress":"0x…","tokenDecimals":6};` +
    ` (c) 或让部署 manifest 记录 token 地址 (并给出能唯一定位它的锚: BOLLOON_CHAIN_ID / BOLLOON_NETWORK_NAME);` +
    ` (d) 本次只调用也可以显式传 --asset 0x…。本模块**不猜** token 地址 —— 猜错资产地址比报错危险得多。`
  );
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export interface LoadChainConfigOptions {
  home?: string;
  /** 显式覆盖 (测试用; 优先级最高) */
  overrides?: Partial<ChainConfig>;
  env?: NodeJS.ProcessEnv;
  /**
   * 调用方**需要真写** (createEscrow) 时为 true: 拿不到 token 地址 → 抛可操作的
   * `ChainConfigError` (missing=['tokenAddress'] + 三层来源 + 怎么修), 而不是让下游
   * 报一个含糊的"缺少参数"。只做读 / 只做 escrow 操作时保持默认 false。
   */
  requireToken?: boolean;
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
  let networkNameUpper: string | null = null;
  if (env.BOLLOON_NETWORK_NAME) { networkNameUpper = String(env.BOLLOON_NETWORK_NAME); sources.networkName = 'env BOLLOON_NETWORK_NAME'; }
  else if (file?.networkName) { networkNameUpper = String(file.networkName); sources.networkName = `${chainConfigPath(home)} .networkName`; }
  else sources.networkName = '默认 unknown';
  if (networkNameUpper) networkName = networkNameUpper;

  // ⑧ ★ 第 ③ 层: 仓库里的部署 manifest —— 只在 ①② 拿不全时读,
  //    且**只填 ①② 没给的字段** (优先级不可颠倒)。选不中就说清为什么 (不猜)。
  let manSel: DeploymentManifestSelection | null = null;
  const needManifest = !rpcUrl || chainId === null || !escrowAddress || !tokenAddress || !networkNameUpper;
  if (needManifest) {
    manSel = selectDeploymentManifest({
      chainId, networkName: networkNameUpper, rpcUrl, escrowAddress,
      deploymentsDir: env[DEPLOYMENTS_DIR_ENV],
    });
    const man = manSel.manifest;
    if (man) {
      if (!escrowAddress) {
        escrowAddress = man.escrowAddress;
        sources.escrowAddress = `manifest ${man.label} .contracts[AgentEscrow].address`;
      }
      if (chainId === null && man.chainId !== null) {
        chainId = man.chainId;
        sources.chainId = `manifest ${man.label} .chainId`;
      }
      if (!rpcUrl && man.rpcUrl) {
        rpcUrl = man.rpcUrl;
        sources.rpcUrl = `manifest ${man.label} .rpcUrl (部署时记下的 RPC)`;
      }
      if (!tokenAddress && man.tokenAddress) {
        tokenAddress = man.tokenAddress;
        sources.tokenAddress = `manifest ${man.label} ${man.tokenField}.address`;
      }
      // ★ decimals 只在"token 也是从这份 manifest 来的"时才跟着它走 ——
      //   否则会拿 A token 的精度去解释 B token 的金额 (env 给了 token 但没给精度时尤其危险)。
      const tokenFromManifest = !!man.tokenAddress && tokenAddress === man.tokenAddress;
      if (tokenFromManifest && man.tokenDecimals !== null && sources.tokenDecimals === '默认 (USDC=6)') {
        tokenDecimals = man.tokenDecimals;
        sources.tokenDecimals = `manifest ${man.label} ${man.tokenField}.decimals`;
      }
      if (!networkNameUpper && man.networkName) {
        networkName = man.networkName;
        sources.networkName = `manifest ${man.label} .networkName`;
      }
    }
  }
  sources.deploymentManifest = manSel
    ? (manSel.manifest ? `${manSel.manifest.label} — ${manSel.reason}` : `未选中 — ${manSel.reason}`)
    : '未读 (①② 已给全必需字段)';
  sources.deploymentsDir = manSel?.deploymentsDir ?? deploymentsDir(env);

  // ★ 重算「还缺什么」—— 第 ③ 层可能刚把 ①② 没给的字段补齐了。
  //   missing 是各 pass 里 push 的"上层缺口", 到这里必须按**最终值**过滤一遍,
  //   否则会把"manifest 已经补上了"错报成"缺配置"。
  const missingFinal = missing.filter((k) =>
    (k === 'rpcUrl' && !rpcUrl) || (k === 'chainId' && chainId === null) || (k === 'escrowAddress' && !escrowAddress));

  if (missingFinal.length) {
    throw new ChainConfigError(
      `链配置缺失: ${missingFinal.join(', ')}。读取优先级 = 环境变量 → ${chainConfigPath(home)} → 仓库部署 manifest → 报错; ` +
      `本模块不猜合约地址。manifest 层: ${manSel ? manSel.reason : `未读 (缺的字段: ${missingFinal.join(', ')})`}。` +
      `怎么修: ① 设 BOLLOON_CHAIN_RPC_URL / BOLLOON_CHAIN_ID / BOLLOON_ESCROW_ADDRESS; ` +
      `② 或写 ${chainConfigPath(home)} (rpcUrl / chainId / escrowAddress / tokenAddress / tokenDecimals); ` +
      `③ 或给出能**唯一定位** manifest 的锚 (BOLLOON_CHAIN_ID 或 BOLLOON_NETWORK_NAME, 也可用 ${DEPLOYMENTS_DIR_ENV} 指向只放一份 manifest 的目录)。`,
      missingFinal,
    );
  }

  // ★ 真写需要付款资产: 拿不到就报**可操作**的错, 而不是让调用方看到含糊的"缺少参数"
  if (opts.requireToken && !tokenAddress) {
    throw new ChainConfigError(tokenAddressGuidance({ home, networkName, env }), ['tokenAddress']);
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
