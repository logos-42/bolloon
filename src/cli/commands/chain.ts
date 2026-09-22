/**
 * chain.ts — P6 `bolloon chain ...` (链命令组)
 * =========================================================================
 * 一个命令组, 五组能力, **全部复用 P3/P4/P5 的现成实现** (本文件不新写任何链上判定):
 *
 *   bolloon chain status                     → chain-config + escrow-client (+ 余额/确认数口径)
 *   bolloon chain escrow show <taskKey>      → escrow-client.getEscrow (链上 19 字段)
 *   bolloon chain timeline   <taskKey>       → chain-index-query.getEscrowTimeline (链上事件时间线)
 *                                              + onchain-trade.recoverOnchainTrade (本机视角, 纯读盘)
 *   bolloon chain index status|stats|sync    → chain-index-query / chain-indexer.ChainIndexer.syncFrom
 *   bolloon chain trade create|submit-proof|release|recover
 *                                            → onchain-trade 的 createEscrowStep / submitProofStep /
 *                                              releaseStep / recoverOnchainTrade (不重写)
 *
 * 四条红线 (与 P3/P4 的冻结口径逐条一致):
 *   ① **绝不打印/落盘私钥** —— 本文件不读私钥、不造 signer; `chain status` 只报钱包**可用性 + 公开地址**;
 *      链上写操作的签名只由 P3 `sendChainTxGuarded` → `authorizeWalletSignature` 唯一放行闸产生。
 *   ② **不确定一律 `CHAIN_UNCERTAIN`** (确认数不够 / receipt 读不到 / 事件对不上) —— 绝不报成功;
 *      「读不到合约」与「合约里没有这条 escrow」是两个不同的码 (`CHAIN_UNAVAILABLE` vs `ESCROW_NOT_FOUND`)。
 *   ③ `local-dev` (chainId 31337) 只报链上事实, **永不产出 `fully_settled`** (本命令组根本不写结算事实)。
 *   ④ 失败一律走 §2 冻结信封 (`ok:false` + `code` + `next_action`); 被标可疑 (重组/事件消失) → `REORG_SUSPECTED`。
 *
 * P6 新增错误码 (append-only, 不改任何冻结码含义):
 *   `CHAIN_NOT_CONFIGURED` · `CHAIN_UNAVAILABLE` · `CHAIN_UNCERTAIN` · `CHAIN_TX_REVERTED`
 *   `ESCROW_NOT_FOUND` · `INSUFFICIENT_FUNDS` · `NOT_AUTHORIZED` · `REORG_SUSPECTED`
 *   `INDEX_IDENTITY_CHANGED` (2026-09-22 P5 修正: 换合约部署/换链实例 ⇒ 索引身份变了, **不是重组**)
 */

import * as os from 'os';
import {
  type CliFlags, type CommandResult, type Envelope, type Code, type NextAction,
  okEnvelope, failEnvelope, line, title, hint, plain, opt,
} from '../protocol-envelope.js';
import { isPaymentMode, PAYMENT_MODES, type PaymentMode } from '../../agents/task-contract.js';

const home = (): string => os.homedir();

export const CHAIN_USAGE = `
${title('bolloon chain')}
  bolloon chain status [--json]
      链配置 (chainId / RPC / escrow / token / 确认数) + RPC 可达性 + 合约 bytecode + 钱包可用性 (地址公开, 私钥绝不打印)

  bolloon chain escrow show <taskKey> [--json]
      读链上 escrow (19 字段): state = ACTIVE|RELEASED|DISPUTED|REFUNDED

  bolloon chain timeline <taskKey> [--json]
      链上事件时间线 (索引里的真事件) + 本机视角 (chain-state.json 的 create/proof/release 记录)

  bolloon chain index status|stats|sync|rebuild [--from-block <n>] [--json]
      索引高度/最后同步 / 全量统计 / 增量同步 (从 deployment block 起扫, 分页+去重+重组回退) /
      全量重建 (换过合约部署 → **干净重建**: 丢弃旧身份的记录, 采用当前身份, 报 identityChanged)

  bolloon chain trade create --task-id <id> --agent <addr> --amount <USDC> [--asset <token>] \\
                            [--deadline <unix秒>] [--confirmation-window <秒>] [--proof-version <n>] [--gate confirmed|finalized]
  bolloon chain trade submit-proof --task-id <id> --result <正文|sha256:hex> [--manifest-digest <正文|sha256:hex>]
  bolloon chain trade release --task-id <id>
  bolloon chain trade recover (--task-id <id> | --task-key <hex>)

选项: --json · --quiet · --request-id <id> · --timeout <ms> · --task-key <hex>
判据永远是信封里的 ok/code; 失败码见 skills/bolloon-network/SKILL.md「链上能力」一节。
链上写操作的签名走 P3 放行闸 (fail-closed): 未授权 → NOT_AUTHORIZED, 且**不发交易、不碰私钥**。

链上**写**操作 (create|submit-proof|release) 的**授权意图**:
  --payment-mode <manual|policy|autonomous|agent-authorized>   声明"在何种支付模式下签这笔链上写"
  --request-id <id>                                            显式幂等/授权键 (参与放行闸 requestId 的确定性派生)
  两个都是**可选**(CLI 缺省沿用历史口径 agent-authorized / 确定性派生), 但 **MCP 写 tool 强制显式携带**;
  声明本身**不授权** —— 最终还是看本机放行闸 (authorizeWalletSignature, fail-closed)。
--payment-mode manual|policy 会被放行闸直接拒 (modeIsAutonomous): 它只能**收紧**, 不可能放权。
chain trade expire 不存在 (仓库没实现) —— 需要它请先实现合约侧子命令再暴露, 不许在 MCP 层假装。

索引身份 (identity = chainId + escrowAddress + 部署块) 随索引一并落盘 (identity 字段):
  换过合约部署 / anvil 重启换了链实例 ⇒ 索引文件属于**另一次部署** —— chain index sync 一律拒绝,
  报 **INDEX_IDENTITY_CHANGED** (next_action=needs_human, 这次不扫不写), **不是** REORG_SUSPECTED;
  修法只有一个: bolloon chain index rebuild (干净重建: 丢弃旧身份的记录, 采用当前身份, 如实报丢弃条数)。
chain index status 里的 escrow/部署块就是**这份索引**的身份 —— 它不该等于当前链配置时, 先 rebuild。
`;

// ── 测试注入 (生产不设; 生产唯一构造入口仍是 EscrowClient({ config })) ──────────

export interface ChainCommandDeps {
  /** 注入链客户端 (测试用假链; 不给 = new EscrowClient({ config })) */
  client?: (cfg: unknown) => unknown;
  /** 注入链上判定器 (测试; 不给 = P3 的 verifyPaymentOnChain) */
  verifyOnChain?: unknown;
  /** 注入索引器 (测试用假链; 不给 = new ChainIndexer({ config, home })) —— 只为单测不联网, 生产不给 */
  indexer?: (cfg: unknown, home: string) => unknown;
}
let deps: ChainCommandDeps | null = null;
export function setChainCommandDepsForTesting(d: ChainCommandDeps | null): void {
  deps = d;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const TASK_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** 「钱不够」类真实 revert 文案 (余额/授权/原生币 gas) —— 别把 RPC 故障误判成钱不够 */
const INSUFFICIENT_RE = /insufficient|exceeds allowance|exceeds balance|transfer amount exceeds|ERC20Insufficient/i;

export function isHexTaskKey(v: unknown): boolean {
  return typeof v === 'string' && TASK_KEY_RE.test(v.trim());
}

/** 十进制 USDC 串 → 原子单位 (超精度**拒绝**, 不静默截断) */
export function toAtomicUnits(usdc: string, decimals: number): bigint | null {
  const s = String(usdc).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function optInt(flags: CliFlags, name: string, def?: number): number | undefined {
  const v = opt(flags, name);
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

/** 摘要口径: `sha256:` 前缀原样透传, 否则按正文算 sha256 (与 P4 sha256Digest 同一实现) */
function digestOf(raw: string, sha256Digest: (s: string) => string): string {
  return raw.startsWith('sha256:') ? raw : sha256Digest(raw);
}

function humanFail(head: string, env: { code: Code; message: string; next_action: NextAction; data?: Record<string, unknown> }): string {
  const extra = env.data?.missing ? `\n  缺失: ${(env.data.missing as string[]).join(', ')}` : '';
  return `${title(head)}\n  ✗ ${env.message}${extra}\n  code: ${env.code} · 下一步: ${env.next_action ?? '无需额外动作'}`;
}

function taskKeyArg(flags: CliFlags): string | null {
  const v = flags.positionals[2] || opt(flags, '--task-key');
  return v && TASK_KEY_RE.test(String(v).trim()) ? String(v).trim().toLowerCase() : null;
}

/** 链配置 (缺 → CHAIN_NOT_CONFIGURED, 列出缺哪些; 绝不猜地址) */
async function loadCfg(opts: { requireToken?: boolean } = {}): Promise<{ ok: true; cfg: any } | { ok: false; envelope: Envelope }> {
  const CFG: any = await import('../../agents/chain/chain-config.js');
  try {
    // requireToken: 真写 (createEscrow) 必须知道**付哪个 token** —— 拿不到就给可操作的错
    // (三层来源逐个点名 + 怎么修), 而不是让下游报含糊的"缺少参数"。
    return { ok: true, cfg: CFG.loadChainConfig({ home: home(), requireToken: opts.requireToken === true }) };
  } catch (e: any) {
    const missing = Array.isArray(e?.missing) ? e.missing : [];
    const tokenGap = missing.includes('tokenAddress');
    return {
      ok: false,
      envelope: failEnvelope(
        'CHAIN_NOT_CONFIGURED',
        String(e?.message || e).slice(0, 400),
        {
          missing,
          home: home(),
          configPath: CFG.chainConfigPath(home()),
          deploymentsDir: CFG.deploymentsDir(process.env),
          // ★ 缺"付款资产"时把修法一并放进信封 (机器可执行, 不用去猜) —— 见 chain-config.tokenAddressGuidance
          ...(tokenGap ? {
            tokenAddress: null,
            howToFix: [
              'export BOLLOON_TOKEN_ADDRESS=0x… (真 USDC 或本地 MockERC20)',
              `在 ${CFG.chainConfigPath(home())} 写 {"tokenAddress":"0x…","tokenDecimals":6}`,
              '让部署 manifest 记 token 地址, 并给出能唯一定位它的锚 (BOLLOON_CHAIN_ID / BOLLOON_NETWORK_NAME)',
              '本次显式传 --asset 0x… (只影响这一次调用)',
            ],
          } : {}),
        },
        [],
        'needs_human',
      ),
    };
  }
}

async function makeClient(cfg: any): Promise<any> {
  if (deps?.client) return deps.client(cfg);
  const { EscrowClient } = await import('../../agents/chain/escrow-client.js');
  return new EscrowClient({ config: cfg });
}

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function chainCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'status': return chainStatus(flags);
    case 'escrow': return chainEscrow(flags);
    case 'timeline': return chainTimeline(flags);
    case 'index': return chainIndex(flags);
    case 'trade': return chainTrade(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 chain 子命令: ${sub}` : '缺少 chain 子命令', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human'),
        human: CHAIN_USAGE,
      };
  }
}

// ── chain status ────────────────────────────────────────────────────────────

async function chainStatus(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon chain status';
  const loaded = await loadCfg();
  if (!loaded.ok) return { envelope: loaded.envelope, human: humanFail(head, loaded.envelope) };
  const cfg = loaded.cfg;
  const CFG: any = await import('../../agents/chain/chain-config.js');

  const data: Record<string, unknown> = {
    chainId: cfg.chainId,
    networkName: cfg.networkName,
    rpcUrl: cfg.rpcUrl,
    escrowAddress: cfg.escrowAddress,
    tokenAddress: cfg.tokenAddress,
    tokenDecimals: cfg.tokenDecimals,
    confirmations: { confirmed: cfg.confirmations.confirmed, finalized: cfg.confirmations.finalized },
    confirmationsSemantics: {
      observed: `确认数 < ${cfg.confirmations.confirmed} (只在链上被观测到)`,
      confirmed: `确认数 ≥ ${cfg.confirmations.confirmed}`,
      finalized: `确认数 ≥ ${cfg.confirmations.finalized}`,
    },
    localDev: cfg.chainId === 31337,
    sources: cfg.sources,
    configPath: CFG.chainConfigPath(home()),
    walletPath: CFG.walletFilePath(home()),
    rpcOk: false,
    latestBlock: null,
    escrowBytecode: null,
    onChainContractVersion: null,
    wallet: { available: false, source: 'none', reason: null, address: null, nativeBalanceEth: null, tokenBalanceUsdc: null },
    privateKeyPrinted: false,
    writesMoneyOn: null,
    note: '钱包只报可用性与公开地址; 私钥永不出本命令; local-dev (chainId 31337) 永不产出 fully_settled',
  };

  let client: any = null;
  try {
    client = await makeClient(cfg);
    data.latestBlock = await client.getLatestBlockNumber();
    data.rpcOk = true;
    try {
      const code = await client.provider.getCode(cfg.escrowAddress);
      data.escrowBytecode = typeof code === 'string' && code.length > 2;
    } catch { /* bytecode 读不到 → 保持 null (不假装有) */ }
    try { data.onChainContractVersion = await client.contractVersion(); } catch { /* 可选 */ }
  } catch (e: any) {
    return {
      envelope: failEnvelope(
        'CHAIN_UNAVAILABLE',
        `连不上链 / 读不到 head: ${String(e?.shortMessage || e?.message || e).slice(0, 240)}`,
        { ...data, requestedBy: head },
        [],
        'needs_human',
      ),
      human: humanFail(head, { code: 'CHAIN_UNAVAILABLE' as Code, message: `连不上 ${cfg.rpcUrl}`, next_action: 'needs_human', data }),
    };
  }

  // 钱包: 只报可用性 + 公开地址 (私钥留在 walletAvailable 内部)
  const w = CFG.walletAvailable({ home: home() });
  const wallet = data.wallet as Record<string, unknown>;
  wallet.available = w.available === true;
  wallet.source = w.source;
  wallet.reason = w.reason ?? null;
  if (w.available === true) {
    try {
      const signer = client.localSigner({ home: home() });
      wallet.address = await signer.getAddress();
      const native = await client.provider.getBalance(wallet.address as string);
      wallet.nativeBalanceEth = `${Number(native) / 1e18}`;
      if (cfg.tokenAddress) {
        const { Contract } = await import('ethers');
        const erc20 = new Contract(cfg.tokenAddress, ['function balanceOf(address) view returns (uint256)'], client.provider);
        const bal = await erc20.balanceOf(wallet.address as string);
        wallet.tokenBalanceAtomic = bal.toString();
        const { atomicToUsdc } = await import('../../agents/chain/onchain-trade.js');
        wallet.tokenBalanceUsdc = atomicToUsdc(BigInt(bal), cfg.tokenDecimals);
      }
    } catch (e: any) {
      wallet.balanceError = String(e?.shortMessage || e?.message || e).slice(0, 160);
    }
  }

  const human = [
    title(head),
    line('chainId', `${data.chainId}${data.localDev ? ' (本地开发链 — local-dev 永不 fully_settled)' : ''}`),
    line('network', String(data.networkName)),
    line('RPC', `${data.rpcUrl} (可达: ${data.rpcOk ? '是' : '否'})`),
    line('latestBlock', String(data.latestBlock ?? '(读不到)')),
    line('escrow', `${data.escrowAddress} (bytecode: ${data.escrowBytecode === null ? '未读' : data.escrowBytecode ? '有' : '无'} · 链上版本 ${data.onChainContractVersion ?? '?'})`),
    line('token', `${data.tokenAddress ?? '(未配置)'} · decimals=${data.tokenDecimals}`),
    line('确认数', `confirmed ≥ ${cfg.confirmations.confirmed} · finalized ≥ ${cfg.confirmations.finalized}`),
    line('钱包可用', `${w.available ? '是' : '否'} (${w.source})`),
    ...(wallet.address ? [
      line('钱包地址', String(wallet.address)),
      line('原生币', `${wallet.nativeBalanceEth ?? '?'}`),
      ...(wallet.tokenBalanceUsdc != null ? [line('token 余额', `${wallet.tokenBalanceUsdc} (${wallet.tokenBalanceAtomic} 原子)`)] : []),
    ] : []),
    ...(wallet.reason ? [line('钱包不可用', String(wallet.reason).slice(0, 120))] : []),
    `\n  ${hint('私钥永不打印/落盘; 链上写操作的签名走 (fail-closed) 放行闸')}`,
  ].join('\n');

  return { envelope: okEnvelope('OK', `链 configuration 就绪: chainId=${data.chainId} · escrow=${data.escrowAddress}`, data, [String(data.escrowAddress), cfg.rpcUrl], null), human };
}

// ── chain escrow show ───────────────────────────────────────────────────────

async function chainEscrow(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon chain escrow show';
  if (flags.positionals[1] !== 'show') {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '只实现了 `chain escrow show <taskKey>`', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human'), human: CHAIN_USAGE };
  }
  const raw = flags.positionals[2] || opt(flags, '--task-key') || '';
  if (!isHexTaskKey(raw)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `taskKey 必须是 0x + 64 hex (收到: ${String(raw).slice(0, 80) || '(空)'})`, { taskKey: String(raw).slice(0, 80) }, [], 'needs_human'),
      human: `${title(head)}\n  ✗ taskKey 不合法 (要 0x + 64 hex)`,
    };
  }
  const taskKey = String(raw).trim().toLowerCase();
  const loaded = await loadCfg();
  if (!loaded.ok) return { envelope: loaded.envelope, human: humanFail(head, loaded.envelope) };

  let client: any;
  let e: any;
  try {
    client = await makeClient(loaded.cfg);
    e = await client.getEscrow(taskKey);
  } catch (err: any) {
    // ★ 读不到 ≠ 不存在: 读不到一律 CHAIN_UNAVAILABLE (绝不冒报 ESCROW_NOT_FOUND)
    return {
      envelope: failEnvelope('CHAIN_UNAVAILABLE', `读不到 escrow (RPC/合约调用失败, **不代表不存在**): ${String(err?.shortMessage || err?.message || err).slice(0, 240)}`, { taskKey, escrowAddress: loaded.cfg.escrowAddress }, [], 'reconcile'),
      human: `${title(`${head} ${taskKey}`)}\n  ✗ 读不到 (RPC 问题), 不代表不存在 — 稍后重试`,
    };
  }
  if (!e) {
    return {
      envelope: failEnvelope('ESCROW_NOT_FOUND', `链上 ${loaded.cfg.escrowAddress} 里没有 taskKey=${taskKey} 对应的 escrow (buyer==0)`, { taskKey, escrowAddress: loaded.cfg.escrowAddress }, [taskKey], 'wait'),
      human: `${title(`${head} ${taskKey}`)}\n  链上没有这条 escrow (buyer==0)\n  ${hint('下一步: 先 create (bolloon chain trade create) 或确认 taskId/taskKey 对不对')}`,
    };
  }

  const { atomicToUsdc } = await import('../../agents/chain/onchain-trade.js');
  const data = {
    taskKey,
    taskKeyMatches: String(e.taskKey).toLowerCase() === taskKey,
    escrowAddress: loaded.cfg.escrowAddress,
    chainId: loaded.cfg.chainId,
    chainIdOnChain: e.chainId.toString(),
    buyer: e.buyer,
    agent: e.agent,
    amountAtomic: e.amount.toString(),
    amountUsdc: atomicToUsdc(e.amount, loaded.cfg.tokenDecimals),
    state: e.stateName,
    stateCode: e.state,
    paymentAsset: e.paymentAsset,
    proofVersion: e.proofVersion,
    proofHash: e.proofHash,
    resultHash: e.resultHash,
    termsHash: e.termsHash,
    quoteHash: e.quoteHash,
    inputHash: e.inputHash,
    manifestHash: e.manifestHash,
    deadline: e.deadline.toString(),
    confirmationWindow: e.confirmationWindow,
    createdAt: e.createdAt.toString(),
    createdBlock: e.createdBlock,
    contractVersion: e.contractVersion,
    localDev: loaded.cfg.chainId === 31337,
    note: '链上原文 (19 字段); 判据仍是 receipt/事件/确认数 —— 状态=RELEASED 不等于本机已 verified',
  };
  const human = [
    title(`${head} ${taskKey}`),
    line('状态', `${e.stateName} (${e.state})`),
    line('buyer', String(e.buyer)),
    line('agent', String(e.agent)),
    line('金额', `${data.amountUsdc} (${data.amountAtomic} 原子)`),
    line('资产', String(e.paymentAsset)),
    line('deadline', String(e.deadline)),
    line('确认窗口', String(e.confirmationWindow)),
    line('proofVersion', String(e.proofVersion)),
    line('resultHash', String(e.resultHash)),
    line('escrow 合约', String(loaded.cfg.escrowAddress)),
  ].join('\n');
  return { envelope: okEnvelope('OK', `escrow ${taskKey}: ${e.stateName} · ${data.amountUsdc} USDC`, data, [taskKey, String(e.buyer), String(e.agent), String(loaded.cfg.escrowAddress)], null), human };
}

// ── chain timeline ──────────────────────────────────────────────────────────

async function chainTimeline(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon chain timeline';
  const raw = flags.positionals[1] || opt(flags, '--task-key') || '';
  if (!isHexTaskKey(raw)) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `taskKey 必须是 0x + 64 hex (收到: ${String(raw).slice(0, 80) || '(空)'})`, { taskKey: String(raw).slice(0, 80) }, [], 'needs_human'), human: `${title(head)}\n  ✗ taskKey 不合法 (要 0x + 64 hex)` };
  }
  const taskKey = String(raw).trim().toLowerCase();
  const IQ: any = await import('../../agents/chain/chain-index-query.js');
  const OT: any = await import('../../agents/chain/onchain-trade.js');

  const tl = IQ.getEscrowTimeline(taskKey, { home: home() });
  const index = IQ.getIndexStatus({ home: home() });
  let local: any = null;
  try { local = OT.recoverOnchainTrade({ home: home(), taskKey }); } catch (e: any) {
    local = { error: String(e?.message || e).slice(0, 200) };
  }

  if (tl.count === 0 && !(local && local.found)) {
    return {
      envelope: failEnvelope('ESCROW_NOT_FOUND', `索引里没有 taskKey=${taskKey} 的事件, 本机 chain-state.json 里也没有它的链上记录`, { taskKey, indexPath: index.indexPath, lastSyncedBlock: index.lastSyncedBlock, entries: index.entries }, [taskKey], 'wait'),
      human: `${title(`${head} ${taskKey}`)}\n  索引与本机记录里都没有这条任务\n  ${hint('下一步: bolloon chain index sync 先把链上事件同步下来')}`,
    };
  }

  const suspect = tl.hasSuspect === true || (local?.records || []).some((r: any) => r.suspect === true);
  const data = {
    taskKey,
    /** 只按事件推出来的状态 (不读链) */
    state: tl.state,
    count: tl.count,
    events: tl.events,
    finalityLegend: { observed: '只在链上被观测到 (确认数 < confirmed 门槛)', confirmed: '≥ confirmed 门槛', finalized: '≥ finalized 门槛' },
    reconstructed: tl.events.map((e: any) => `${e.eventName}@${e.blockNumber}(${e.finality})`),
    index: { indexPath: index.indexPath, lastSyncedBlock: index.lastSyncedBlock, lastSyncedAt: index.lastSyncedAt, entries: index.entries },
    local: local ? {
      found: local.found, nextAction: local.nextAction, mustNotRepay: local.mustNotRepay, verified: local.verified,
      reason: local.reason, blockedBy: local.blockedBy, statePath: local.statePath,
      records: (local.records || []).map((r: any) => ({ method: r.method, txHash: r.txHash, status: r.status, confirmations: r.confirmations, suspect: r.suspect })),
    } : null,
    hasSuspect: suspect,
    chainSettled: local?.verified === true,
    note: '链上事件时间线 (索引) + 本机视角 (纯读盘); verified 只认「链上释放确认 + 事件对上 + 合约 RELEASED」',
  };

  const evidence = Array.from(new Set([taskKey, ...tl.events.map((e: any) => e.txHash), ...((local?.records || []).map((r: any) => r.txHash))].filter(Boolean))).slice(0, 20) as string[];

  if (suspect) {
    return {
      envelope: failEnvelope('REORG_SUSPECTED', `这条时间线里有被标可疑的记录 (重组/事件消失) → 一律不算已结算`, data, evidence, 'reconcile'),
      human: `${title(`${head} ${taskKey}`)}\n  ✗ 有被标可疑的记录 (重组) — 不算已结算\n  code: REORG_SUSPECTED · 下一步: reconcile`,
    };
  }
  const human = [
    title(`${head} ${taskKey}`),
    line('事件数', `${tl.count} (链上索引)`),
    line('推出状态', String(tl.state ?? '(未定)')),
    line('本机 verified', local?.verified ? '是' : '否'),
    line('本机 nextAction', String(local?.nextAction ?? '(无记录)')),
    ...tl.events.map((e: any) => `    ${String(e.blockNumber).padStart(7)} #${e.logIndex} ${e.eventName} (${e.finality}, ${e.confirmations} 确认)  ${e.txHash.slice(0, 18)}…`),
    ...(local?.records?.length ? [`\n  本机链上记录 (chain-state.json):`, ...local.records.map((r: any) => `    ${r.method}  ${r.status}  conf=${r.confirmations}  ${r.txHash.slice(0, 18)}…`)] : []),
  ].join('\n');
  return { envelope: okEnvelope('OK', `时间线 ${tl.count} 条事件 · 状态 ${tl.state ?? '(未定)'}`, data, evidence, null), human };
}

// ── chain index status|stats|sync|rebuild ───────────────────────────────────

/** 索引身份 → 一行人话 (chainId · escrow · 部署块) —— 读的人一眼看到这份索引是谁的 */
function identityLine(i: any): string {
  if (!i) return '(未知)';
  return `chainId=${i.chainId} · escrow=${i.escrowAddress} · 部署块=${i.deploymentBlock}`;
}

/** 身份变更后唯一该做的事 (与 chain-indexer 的 INDEX_IDENTITY_REBUILD_COMMAND 同一句) */
const IDENTITY_FIX = 'bolloon chain index rebuild';

/** 造索引器 (测试可注入假链; 生产唯一构造入口仍是 new ChainIndexer({ config, home })) */
async function makeIndexer(cfg: unknown): Promise<any> {
  if (deps?.indexer) return deps.indexer(cfg, home());
  const { ChainIndexer } = await import('../../agents/chain/chain-indexer.js');
  return new ChainIndexer({ config: cfg as any, home: home() });
}

async function chainIndex(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[1];
  const IQ: any = await import('../../agents/chain/chain-index-query.js');
  if (sub === 'status') {
    const s = IQ.getIndexStatus({ home: home() });
    const never = s.lastSyncedAt == null;
    const data = { ...s, synced: !never, note: never ? '索引从未同步过 (本机没有任何链上事件记录)' : '读本机索引文件 (不发 RPC)' };
    return {
      envelope: okEnvelope('OK', never ? `索引从未同步 (文件 ${s.indexPath})` : `索引高度 ${s.lastSyncedBlock} · ${s.entries} 条事件 (suspect ${s.suspects})`, data, [s.indexPath], null),
      human: [title('bolloon chain index status'), line('索引文件', s.indexPath), line('已同步到', never ? '(从未)' : `${s.lastSyncedBlock}`), line('事件数', `${s.entries} (suspect ${s.suspects})`), line('最后同步', s.lastSyncedAt ? new Date(s.lastSyncedAt).toISOString() : '(从未)'), line('部署块', `${s.deploymentBlock} (${s.deploymentSource})`), line('索引身份', identityLine(s.identity)), line('确认数门槛', `confirmed ≥ ${s.confirmations.confirmed} · finalized ≥ ${s.confirmations.finalized}`)].join('\n'),
    };
  }
  if (sub === 'stats') {
    const st = IQ.getIndexStats({ home: home() });
    const data = { ...st, note: 'suspect (被回退) 的记录不计入业务计数, 单独报出' };
    return {
      envelope: okEnvelope('OK', `链上事件统计: ${st.tasks} 个任务 · created ${st.created} / proof ${st.proofSubmitted} / released ${st.released}`, data, [st.escrowAddress], null),
      human: [title('bolloon chain index stats'), line('任务数', st.tasks), line('created', st.created), line('proof', st.proofSubmitted), line('released', st.released), line('refunded', st.refunded), line('disputed', st.disputed), line('expired', st.expired), line('分档', `observed ${st.byFinality.observed} · confirmed ${st.byFinality.confirmed} · finalized ${st.byFinality.finalized}`), line('suspect', st.suspects)].join('\n'),
    };
  }
  if (sub === 'sync') {
    const head = 'bolloon chain index sync';
    const loaded = await loadCfg();
    if (!loaded.ok) return { envelope: loaded.envelope, human: humanFail(head, loaded.envelope) };
    const from = optInt(flags, '--from-block', undefined);
    let idx: any;
    try {
      idx = await makeIndexer(loaded.cfg);
    } catch (e: any) {
      // 索引起点解析不到 (部署 manifest 缺) → 配置类失败, 不猜 0
      return {
        envelope: failEnvelope('CHAIN_NOT_CONFIGURED', `索引起点解析失败 (部署 manifest / BOLLOON_ESCROW_DEPLOYMENT_BLOCK): ${String(e?.message || e).slice(0, 300)}`, { escrowAddress: loaded.cfg.escrowAddress, chainId: loaded.cfg.chainId }, [], 'needs_human'),
        human: humanFail(head, { code: 'CHAIN_NOT_CONFIGURED' as Code, message: '索引起点解析失败', next_action: 'needs_human' }),
      };
    }
    let r: any;
    try {
      r = await idx.syncFrom(from);
    } catch (e: any) {
      // ★ 身份变更 ≠ 重组 (2026-09-22 P5 修正): 索引文件属于另一次部署/另一条链实例时,
      //   indexer 在任何 RPC/写盘之前就拒了 —— 这里把它翻成一个**可操作**的新码,
      //   绝不落进 CHAIN_UNAVAILABLE (看不到原因) 或 REORG_SUSPECTED (把人引去查分叉)。
      if (e?.code === 'INDEX_IDENTITY_CHANGED' || e?.name === 'ChainIndexIdentityChangedError') {
        const oldI = e?.oldIdentity ?? null;
        const newI = e?.newIdentity ?? null;
        return {
          envelope: failEnvelope(
            'INDEX_IDENTITY_CHANGED',
            `索引身份变了 (**这不是重组**): 索引文件属于 ${identityLine(oldI)}, 当前链是 ${identityLine(newI)} —— 旧索引里的事件不属于当前合约/链实例。这次**没扫、没写盘**。修法: ${IDENTITY_FIX}`,
            {
              identityChanged: true, oldIdentity: oldI, newIdentity: newI,
              indexPath: IQ.currentIndexPath(home()),
              escrowAddress: loaded.cfg.escrowAddress, chainId: loaded.cfg.chainId,
              scanned: false, wroteIndex: false,
              suggestedCommand: IDENTITY_FIX,
              howToFix: [
                `${IDENTITY_FIX} --json   (干净重建: 丢弃旧身份的记录, 采用当前身份)`,
                '想留旧部署的索引 → 把 BOLLOON_* 指回旧部署/旧链, 或用 BOLLOON_INDEX_* 给它单独一个索引文件 (别覆盖)',
              ],
              note: '换合约部署/anvil 重启会让索引文件属于另一次部署; 把两边的事件混在一个文件里会污染 status/stats/timeline 的每一处读数 —— 所以这里什么都不动',
            },
            [String(oldI?.escrowAddress ?? ''), String(newI?.escrowAddress ?? '')].filter(Boolean),
            'needs_human',
          ),
          human: [
            title(head),
            '  ✗ 索引身份变了 (**这不是重组**) — 这次没扫、没写盘',
            line('旧索引', identityLine(oldI)),
            line('当前链', identityLine(newI)),
            hint(`  下一步: ${IDENTITY_FIX} (干净重建: 丢弃旧身份记录, 采用当前身份)`),
          ].join('\n'),
        };
      }
      return {
        envelope: failEnvelope('CHAIN_UNAVAILABLE', `同步失败 (RPC/读链): ${String(e?.shortMessage || e?.message || e).slice(0, 260)}`, { fromBlock: from ?? null, escrowAddress: loaded.cfg.escrowAddress }, [], 'reconcile'),
        human: humanFail(head, { code: 'CHAIN_UNAVAILABLE' as Code, message: '同步失败', next_action: 'reconcile' }),
      };
    } finally { try { idx.close(); } catch { /* noop */ } }

    const data = {
      mode: r.mode, requestedFrom: r.requestedFrom, scanFrom: r.scanFrom, scanTo: r.scanTo,
      pages: r.pages, blocksScanned: r.blocksScanned, logsFound: r.logsFound,
      inserted: r.inserted, deduped: r.deduped, restored: r.restored,
      markedSuspect: r.markedSuspect, rewoundTo: r.rewoundTo,
      headBlock: r.headBlock, headBlockHash: r.headBlockHash, lastSyncedBlock: r.lastSyncedBlock,
      entries: r.entries, suspects: r.suspects, durationMs: r.durationMs,
      /** 扫这些日志时**实际用的**身份 (与落盘身份同源) */
      identity: r.identity ?? null,
      indexPath: IQ.currentIndexPath(home()),
      writesMoney: false, writesKeys: false,
      note: '索引只是链上事件的本地缓存 (可删可重建); 它**不是**结算事实, 判据仍是 receipt/事件/确认数',
    };
    // 重组回退 → 有记录被标可疑 → 不报成功
    if ((r.markedSuspect ?? 0) > 0 || r.rewoundTo != null) {
      const idData = r.identity ?? {};
      // 回退点 = 扫描下界 (部署块 - 1) 时: 整个已索引区间都对不上 —— 说清楚这不是"某一块分叉",
      // 并且**绝不**把回退点报到部署块以下 (回退不到那里: 那些块从来不在本索引的扫描范围内)。
      const deepRewind = r.markedSuspect > 0 && r.rewoundTo != null
        && r.rewoundTo <= Math.max(0, Number(idData.deploymentBlock ?? 0) - 1);
      return {
        envelope: failEnvelope(
          'REORG_SUSPECTED',
          deepRewind
            ? `同步时检出**整段**对不上: 回退到扫描下界 ${r.rewoundTo} (部署块 ${idData.deploymentBlock} - 1, 再往下不属于本索引的扫描范围), 标可疑 ${r.markedSuspect} 条 (记录保留, 不当没发生)。若你最近换过合约部署/换过链, 那不是重组 → 先 \`${IDENTITY_FIX}\``
            : `同步时检出重组: 回退到 ${r.rewoundTo}, 标可疑 ${r.markedSuspect} 条 (记录保留, 不当没发生)`,
          { ...data, deepRewind, rewoundToIsScanFloor: deepRewind, scanFloor: Math.max(0, Number(idData.deploymentBlock ?? 0) - 1) },
          [String(r.headBlockHash)],
          'reconcile',
        ),
        human: `${title(head)}\n  ✗ ${deepRewind ? `整段对不上: 回退到扫描下界 ${r.rewoundTo}` : `检出重组: 回退到 ${r.rewoundTo}`}, 标 suspect ${r.markedSuspect} 条\n  ${hint(deepRewind ? `若换过合约部署/换过链 → 先 ${IDENTITY_FIX} (身份变更不是重组)` : '下一步: bolloon chain index stats 看 suspect, 再决定是否 rebuild')}`,
      };
    }
    return {
      envelope: okEnvelope('OK', `同步完成: 新增 ${r.inserted} 条 (去重 ${r.deduped}), 共 ${r.entries} 条 · 扫到 ${r.scanTo}/${r.headBlock}`, data, [String(r.headBlockHash), String(r.headBlock)], null),
      human: [title(head), line('扫描区间', `${r.scanFrom} → ${r.scanTo}`), line('本页/区块', `${r.pages} 页 / ${r.blocksScanned} 块`), line('新增/去重', `${r.inserted} / ${r.deduped}`), line('索引事件数', `${r.entries} (suspect ${r.suspects})`), line('已同步到', r.lastSyncedBlock), line('索引身份', identityLine(r.identity)), line('耗时', `${r.durationMs}ms`)].join('\n'),
    };
  }
  if (sub === 'rebuild') {
    // ★ 薄包装 ChainIndexer.rebuild (本分支**不新写任何业务逻辑**): 全量重扫 → 身份变更时干净重建。
    const head = 'bolloon chain index rebuild';
    const loaded = await loadCfg();
    if (!loaded.ok) return { envelope: loaded.envelope, human: humanFail(head, loaded.envelope) };
    let idx: any;
    try {
      idx = await makeIndexer(loaded.cfg);
    } catch (e: any) {
      return {
        envelope: failEnvelope('CHAIN_NOT_CONFIGURED', `索引起点解析失败 (部署 manifest / BOLLOON_ESCROW_DEPLOYMENT_BLOCK): ${String(e?.message || e).slice(0, 300)}`, { escrowAddress: loaded.cfg.escrowAddress, chainId: loaded.cfg.chainId }, [], 'needs_human'),
        human: humanFail(head, { code: 'CHAIN_NOT_CONFIGURED' as Code, message: '索引起点解析失败', next_action: 'needs_human' }),
      };
    }
    let r: any;
    try {
      r = await idx.rebuild({ persist: true });
    } catch (e: any) {
      return {
        envelope: failEnvelope('CHAIN_UNAVAILABLE', `重建失败 (RPC/读链): ${String(e?.shortMessage || e?.message || e).slice(0, 260)}`, { escrowAddress: loaded.cfg.escrowAddress }, [], 'reconcile'),
        human: humanFail(head, { code: 'CHAIN_UNAVAILABLE' as Code, message: '重建失败', next_action: 'reconcile' }),
      };
    } finally { try { idx.close(); } catch { /* noop */ } }

    const data = {
      mode: r.mode, identity: r.identity, identityChanged: r.identityChanged === true,
      oldIdentity: r.oldIdentity ?? null, newIdentity: r.newIdentity ?? null,
      discardedEntries: r.discardedEntries ?? 0,
      scanFrom: r.identity?.deploymentBlock ?? null, scanTo: r.headBlock,
      pages: r.pages, blocksScanned: r.blocksScanned, logsFound: r.logsFound,
      entries: r.entries, headBlock: r.headBlock,
      comparison: r.comparison, durationMs: r.durationMs, persisted: r.persisted === true,
      indexPath: IQ.currentIndexPath(home()),
      writesMoney: false, writesKeys: false,
      note: r.identityChanged
        ? '身份变更 → **干净重建**: 旧身份的记录被丢弃 (不是标 suspect), 索引现在只属于当前身份; 索引只是本地缓存, 不是结算事实'
        : '全量重建 (身份未变): 与增量结果逐条比对, 旧的 suspect 记录照旧保留; 索引只是本地缓存, 不是结算事实',
    };
    const diff = r.comparison ? (r.comparison.missingInB.length + r.comparison.extraInB.length + r.comparison.mismatched.length) : 0;
    if (r.identityChanged) {
      return {
        envelope: okEnvelope(
          'OK',
          `身份变更 → 干净重建完成: 丢弃 ${data.discardedEntries} 条属于旧身份 (${identityLine(data.oldIdentity)}) 的记录, 索引现在只属于 ${identityLine(data.newIdentity)} · ${r.entries} 条事件`,
          data,
          [String(r.newIdentity?.escrowAddress ?? ''), String(r.headBlock)].filter(Boolean),
          null,
        ),
        human: [
          title(head),
          line('身份变更', '是 (换合约部署/换链实例) — 这是**干净重建**, 不是重组'),
          line('旧身份 (已丢弃)', `${identityLine(data.oldIdentity)} · 丢弃 ${data.discardedEntries} 条记录 (不标 suspect)`),
          line('新身份 (已采用)', identityLine(data.newIdentity)),
          line('扫描区间', `${data.scanFrom} → ${data.scanTo}`),
          line('重建结果', `${r.entries} 条事件 (与重建前逐条比对 same=${r.comparison?.same})`),
          line('索引文件', String(data.indexPath)),
        ].join('\n'),
      };
    }
    return {
      envelope: okEnvelope('OK', `全量重建完成: ${r.entries} 条事件 (身份未变; 与增量比对 same=${r.comparison?.same}, 差 ${diff} 处)`, data, [String(r.headBlockHash ?? ''), String(r.headBlock)].filter(Boolean), null),
      human: [
        title(head),
        line('身份变更', '否 (索引身份与当前链一致)'),
        line('索引身份', identityLine(data.newIdentity)),
        line('扫描区间', `${data.scanFrom} → ${data.scanTo}`),
        line('重建结果', `${r.entries} 条事件 · 与增量比对 same=${r.comparison?.same} (差 ${diff} 处)`),
        line('索引文件', String(data.indexPath)),
      ].join('\n'),
    };
  }
  return {
    envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 chain index 子命令: ${sub}` : '缺少 chain index 子命令 (status|stats|sync|rebuild)', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human'),
    human: CHAIN_USAGE,
  };
}

// ── chain trade create|submit-proof|release|recover ─────────────────────────

type Step = {
  stage: string; method: string | null; ok: boolean; chainSettled: boolean; chainStatus: string | null;
  txHash: string; blockNumber: number | null; gasUsed?: string | null; requestId: string | null;
  authorized: boolean; authReason?: string; auditWritten?: boolean; recorded: boolean; grantsVerified: boolean;
  escrowState: string | null; reason: string; verdict: any;
};

const STAGE_LABEL: Record<string, string> = { create: 'createEscrowV2', proof: 'submitProofV2', release: 'releaseV2' };

/**
 * ★ 一步链上结果 → 信封 (唯一的映射点; 只做**翻译**, 不重新判定)。
 * 顺序即安全性顺序: 未授权 → 没发出去 → 回滚 → 重组 → 没确定 → (只有全过才) ok。
 */
function stepEnvelope(stage: string, step: Step, extra: Record<string, unknown> = {}): Envelope {
  const v = step.verdict || {};
  const data: Record<string, unknown> = {
    stage: step.stage,
    method: step.method ?? STAGE_LABEL[stage] ?? null,
    authorized: step.authorized === true,
    authReason: step.authReason ?? null,
    txHash: step.txHash || null,
    blockNumber: step.blockNumber ?? null,
    gasUsed: step.gasUsed ?? null,
    requestId: step.requestId ?? null,
    chainSettled: step.chainSettled === true,
    chainStatus: step.chainStatus ?? null,
    eventMatched: v.eventMatched ?? null,
    matchedEvent: v.matchedEvent ?? null,
    confirmations: v.confirmations ?? null,
    confirmationsRequired: v.confirmationsRequired ?? null,
    requiredGate: v.requiredGate ?? null,
    escrowState: step.escrowState ?? null,
    rpcAvailable: v.rpcAvailable ?? null,
    grantsVerified: step.grantsVerified === true,
    judgmentRecorded: step.recorded === true,
    signatureAuditWritten: step.auditWritten === true,
    privateKeyTouched: false,
    reason: step.reason,
    ...extra,
  };
  const evidence = [step.txHash, step.requestId].filter(Boolean) as string[];

  if (!step.authorized) {
    return failEnvelope('NOT_AUTHORIZED', `签名放行闸拒绝 (fail-closed, 未取私钥/未发交易): ${step.authReason || step.reason}`, data, evidence, 'needs_human');
  }
  if (!step.txHash) {
    const insufficient = INSUFFICIENT_RE.test(step.reason);
    return failEnvelope(
      insufficient ? 'INSUFFICIENT_FUNDS' : 'CHAIN_TX_REVERTED',
      insufficient
        ? `余额/授权不足 —— 交易在广播前就被拒 (钱没动): ${step.reason}`
        : `交易没有发出去 (广播前失败/合约拒绝): ${step.reason}`,
      data, evidence,
      insufficient ? 'raise_budget' : 'needs_human',
    );
  }
  if (step.chainStatus === 'reverted') {
    return failEnvelope('CHAIN_TX_REVERTED', `链上明确回滚 (receipt.status=0, 钱没动): ${step.reason}`, data, evidence, 'needs_human');
  }
  if (step.chainStatus === 'reorged') {
    return failEnvelope('REORG_SUSPECTED', `交易被重组 (不可信, 绝不当已结算): ${step.reason}`, data, evidence, 'reconcile');
  }
  if (step.chainSettled !== true) {
    return failEnvelope('CHAIN_UNCERTAIN', `链上结论未定 (${step.chainStatus}): ${step.reason} —— 不确定 ≠ 失败, 也绝不报成功`, data, evidence, 'reconcile');
  }
  if (stage === 'release' && step.grantsVerified !== true) {
    return failEnvelope('CHAIN_UNCERTAIN', `释放已上链但未全过 (事件/状态/确认数) → 不许标 verified: ${step.reason}`, data, evidence, 'reconcile');
  }
  return okEnvelope('OK', `${STAGE_LABEL[stage] ?? stage} 链上成立 (${step.chainStatus}, 确认数 ${v.confirmations ?? '?'}/${v.confirmationsRequired ?? '?'})`, data, evidence, null);
}

function humanStep(stage: string, env: Envelope): string {
  const d = env.data as any;
  const rows = [
    title(`bolloon chain trade ${stage}${d.method ? ` (${d.method})` : ''}`),
    line('结果', env.ok ? '链上成立' : '未成立'),
    line('txHash', String(d.txHash ?? '(无 — 没发出去)')),
    line('block/确认', `${d.blockNumber ?? '?'} / ${d.confirmations ?? '?'} (需 ${d.confirmationsRequired ?? '?'})`),
    line('chainSettled', String(d.chainSettled)),
    line('chainStatus', String(d.chainStatus ?? '?')),
    line('事件对上', String(d.eventMatched)),
    line('escrow 状态', String(d.escrowState ?? '(读不到)')),
    line('签名审计', String(d.signatureAuditWritten)),
  ];
  if (!env.ok) rows.push(`\n  ✗ ${env.message}\n  code: ${env.code} · 下一步: ${env.next_action ?? '无需额外动作'}`);
  return rows.join('\n');
}

/**
 * deadline 的默认值: max(链上最新块时间, 本机时间) + 窗口。
 * 为什么不能只用本机时间: 链的时钟**可能领先/落后本机**(本地 anvil 常常是),
 * 用本机时间算出来的 deadline 会被合约判成 "deadline in past" —— 这不是猜, 是链上事实。
 */
async function defaultDeadline(client: any, windowSec = 3600): Promise<bigint> {
  let chainTs = 0;
  try {
    const b = await client?.provider?.getBlock?.('latest');
    chainTs = Number(b?.timestamp || 0);
  } catch { /* 读不到块就退回本机时间 (不猜链时间) */ }
  const base = Math.max(Number.isFinite(chainTs) ? chainTs : 0, Math.floor(Date.now() / 1000));
  return BigInt(base + windowSec);
}

/** 组装一条链上交易意图 (摘要口径与 task-onchain-runner 完全一致: 均由 taskId 确定性派生) */
async function buildTradeRequest(flags: CliFlags, cfg: any, client: any): Promise<{ ok: true; req: any; taskId: string; taskKey: string; decimals: number; amountUsdc: string | null; paymentMode: PaymentMode | null } | { ok: false; envelope: Envelope }> {
  const OT: any = await import('../../agents/chain/onchain-trade.js');
  const taskId = opt(flags, '--task-id') || flags.requestId || '';
  if (!taskId) {
    return { ok: false, envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --task-id (链上 taskKey 由它确定性派生)', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human') };
  }
  // ★ 授权意图 (链上写操作): 只**翻译**成放行闸能看的两个字段, 不在这里判"能不能签"。
  //    给了就必须是冻结词表里的值 (非法值拒绝, 不静默退回); 没给 = 沿用历史口径 (CLI 老用法不变)。
  const modeRaw = opt(flags, '--payment-mode');
  if (modeRaw !== undefined && !isPaymentMode(modeRaw)) {
    return {
      ok: false,
      envelope: failEnvelope('INVALID_ARGUMENT', `--payment-mode 非法: ${String(modeRaw).slice(0, 40)} (要 ${PAYMENT_MODES.join('|')})`, { paymentMode: String(modeRaw).slice(0, 40), accepted: [...PAYMENT_MODES] }, [], 'needs_human'),
    };
  }
  const paymentMode: PaymentMode | undefined = isPaymentMode(modeRaw) ? modeRaw : undefined;
  const decimals = Number(cfg.tokenDecimals || 6);
  const amountUsdc = opt(flags, '--amount') ?? null;

  // 卖方地址 (create 必填; proof/release 由合约里的 escrow 决定, 这里只做形状校验)
  const agent = opt(flags, '--agent');
  if (agent !== undefined && !ADDR_RE.test(agent)) {
    return { ok: false, envelope: failEnvelope('INVALID_ARGUMENT', `--agent 不是合法地址: ${agent}`, {}, [], 'needs_human') };
  }
  const paymentAsset = opt(flags, '--asset') || cfg.tokenAddress;
  if (!paymentAsset) {
    // ★ 可操作的错: 真写需要**付款资产**地址, 但三层 (env / chain.json / 仓库 manifest) 都拿不到。
    //   报 CHAIN_NOT_CONFIGURED (不是含糊的 INVALID_ARGUMENT) + 明说怎么修。
    const CFG: any = await import('../../agents/chain/chain-config.js');
    return {
      ok: false,
      envelope: failEnvelope(
        'CHAIN_NOT_CONFIGURED',
        CFG.tokenAddressGuidance({ home: home(), networkName: cfg.networkName, env: process.env }),
        {
          missing: ['tokenAddress'],
          tokenAddress: cfg.tokenAddress ?? null,
          networkName: cfg.networkName,
          configPath: CFG.chainConfigPath(home()),
          deploymentsDir: CFG.deploymentsDir(process.env),
          manifestSource: cfg.sources?.deploymentManifest ?? null,
          howToFix: [
            'export BOLLOON_TOKEN_ADDRESS=0x… (真 USDC 或本地 MockERC20)',
            `在 ${CFG.chainConfigPath(home())} 写 {"tokenAddress":"0x…","tokenDecimals":6}`,
            '让部署 manifest 记 token 地址, 并给锚 (BOLLOON_CHAIN_ID / BOLLOON_NETWORK_NAME) 让它唯一可选中',
            '本次显式传 --asset 0x… (只影响这一次调用)',
          ],
        },
        [],
        'needs_human',
      ),
    };
  }
  if (!ADDR_RE.test(String(paymentAsset))) {
    return { ok: false, envelope: failEnvelope('INVALID_ARGUMENT', `--asset 不是合法地址: ${paymentAsset}`, {}, [], 'needs_human') };
  }
  const amountAtomic = amountUsdc === null ? null : toAtomicUnits(amountUsdc, decimals);
  if (amountUsdc !== null && amountAtomic === null) {
    return { ok: false, envelope: failEnvelope('INVALID_ARGUMENT', `--amount 非法 (要正的十进制, 最多 ${decimals} 位小数): ${amountUsdc}`, { tokenDecimals: decimals }, [], 'needs_human') };
  }

  const deadlineArg = optInt(flags, '--deadline', undefined);
  const deadline = deadlineArg !== undefined
    ? BigInt(deadlineArg)
    : await defaultDeadline(client, 3600);
  const confirmationWindow = optInt(flags, '--confirmation-window', 3600)!;
  const proofVersion = optInt(flags, '--proof-version', 1)!;
  const gate = (opt(flags, '--gate') === 'finalized' ? 'finalized' : 'confirmed') as 'confirmed' | 'finalized';
  const manifestRaw = opt(flags, '--manifest-digest');

  const req: any = {
    client,
    home: home(),
    taskId,
    agentAddress: agent || '0x' + '00'.repeat(20),
    amountAtomic: amountAtomic ?? 0n,
    paymentAsset: String(paymentAsset),
    termsDigest: OT.sha256Digest(`terms:${taskId}`),
    quoteDigest: OT.sha256Digest(`quote:${taskId}`),
    inputDigest: OT.sha256Digest(`input:${taskId}`),
    manifestDigest: manifestRaw ? digestOf(manifestRaw, OT.sha256Digest) : OT.sha256Digest(`manifest:${taskId}`),
    proofVersion,
    deadline,
    confirmationWindow,
    network: cfg.networkName,
    tokenDecimals: decimals,
    gate,
    env: process.env,
    // ★ 授权意图 (只往下传, 不在这里判定): 模式 + 显式幂等/授权键
    ...(paymentMode ? { paymentMode } : {}),
    ...(flags.requestId ? { intentNonce: flags.requestId } : {}),
  };
  if (deps?.verifyOnChain) req.verifyOnChain = deps.verifyOnChain;
  return { ok: true, req, taskId, taskKey: OT.onchainTaskKey(taskId), decimals, amountUsdc, paymentMode: paymentMode ?? null };
}

async function chainTrade(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[1];
  if (!['create', 'submit-proof', 'submit_proof', 'release', 'recover'].includes(String(sub))) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 chain trade 子命令: ${sub}` : '缺少 chain trade 子命令 (create|submit-proof|release|recover)', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human'),
      human: CHAIN_USAGE,
    };
  }
  // recover 是**纯读盘** (不联网/不发交易) → 不需要链客户端, 也**不要求链配置**
  if (sub === 'recover') return chainTradeRecover(flags);

  // create 是**真写** (真移钱) → 必须有付款资产地址; 拿不到就报可操作的 CHAIN_NOT_CONFIGURED
  // (submit-proof / release 不在这里拦: 它们的资产字段是"声明口径", 由 buildTradeRequest 兜底)
  const loaded = await loadCfg({ requireToken: sub === 'create' });
  if (!loaded.ok) return { envelope: loaded.envelope, human: humanFail('bolloon chain trade', loaded.envelope) };
  const cfg = loaded.cfg;

  let client: any;
  try { client = await makeClient(cfg); } catch (e: any) {
    return { envelope: failEnvelope('CHAIN_NOT_CONFIGURED', `造不出链客户端: ${String(e?.message || e).slice(0, 240)}`, {}, [], 'needs_human'), human: humanFail('bolloon chain trade', { code: 'CHAIN_NOT_CONFIGURED' as Code, message: '造不出链客户端', next_action: 'needs_human' }) };
  }

  const built = await buildTradeRequest(flags, cfg, client);
  if (!built.ok) return { envelope: built.envelope, human: humanFail('bolloon chain trade', built.envelope) };
  const { req, taskKey, decimals, amountUsdc, paymentMode } = built;
  const OT: any = await import('../../agents/chain/onchain-trade.js');
  /**
   * 回显调用方的**授权意图声明** (不是授权结论)。
   * ★ 口径: `paymentMode` 是"我按什么模式声明的", `declaredRequestId` 是"我为哪次请求声明"——
   *   真正放不放行仍由本机放行闸 (`authorizeWalletSignature`, fail-closed) 决定, 这里不替它表态。
   */
  const authIntent = {
    paymentMode: paymentMode ?? 'agent-authorized',
    declaredRequestId: flags.requestId ?? null,
    note: '声明 ≠ 授权: 是否真签名由本机放行闸决定 (未授权 / 重复 requestId / 超额 一律拒)',
  };

  if (sub === 'create') {
    if (!amountUsdc) {
      return { envelope: failEnvelope('INVALID_ARGUMENT', 'create 需要 --amount <USDC> (如 0.02)', {}, [], 'needs_human'), human: CHAIN_USAGE };
    }
    if (!ADDR_RE.test(String(opt(flags, '--agent') || ''))) {
      return { envelope: failEnvelope('INVALID_ARGUMENT', 'create 需要 --agent <卖方收款地址>', {}, [], 'needs_human'), human: CHAIN_USAGE };
    }
    // M1 预算闸 (P4 checkOnchainAmount 是唯一预算判定; 本命令组不另立一条)
    const budget = OT.checkOnchainAmount({ amountAtomic: req.amountAtomic, decimals });
    if (!budget.ok) {
      const env = failEnvelope('BUDGET_EXCEEDED', `预算门拒绝 (${budget.layer || 'budget'}): ${budget.reason}`, { layer: budget.layer ?? null, amountUsdc: budget.amountUsdc, budget: budget.budget, why: budget.why, authIntent }, [], 'raise_budget');
      return { envelope: env, human: humanFail('bolloon chain trade create', env) };
    }
    const step: Step = await OT.createEscrowStep(req);
    const env = stepEnvelope('create', step, { taskId: req.taskId, taskKey, amountAtomic: req.amountAtomic.toString(), amountUsdc: budget.amountUsdc, escrowAddress: cfg.escrowAddress, authIntent });
    return { envelope: env, human: humanStep('create', env) };
  }

  if (sub === 'submit-proof' || sub === 'submit_proof') {
    const rawResult = opt(flags, '--result');
    if (!rawResult) {
      return { envelope: failEnvelope('INVALID_ARGUMENT', 'submit-proof 需要 --result <正文|sha256:hex> (链上 resultHash 的来源)', {}, [], 'needs_human'), human: CHAIN_USAGE };
    }
    const resultDigest = digestOf(rawResult, OT.sha256Digest);
    const manifestRaw = opt(flags, '--manifest-digest');
    const step: Step = await OT.submitProofStep(req, resultDigest, manifestRaw ? digestOf(manifestRaw, OT.sha256Digest) : req.manifestDigest);
    const env = stepEnvelope('proof', step, {
      taskId: req.taskId, taskKey, resultDigest,
      onchainResultHash: OT.chainHashOf(resultDigest),
      authIntent,
    });
    return { envelope: env, human: humanStep('submit-proof', env) };
  }

  // release
  const step: Step = await OT.releaseStep(req);
  const env = stepEnvelope('release', step, { taskId: req.taskId, taskKey, authIntent });
  return { envelope: env, human: humanStep('release', env) };
}

/** `chain trade recover`: 纯读盘重建本机链上事实 → 下一步 (不联网、不猜、不改记录、不发交易) */
async function chainTradeRecover(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon chain trade recover';
  const OT: any = await import('../../agents/chain/onchain-trade.js');
  const taskId = opt(flags, '--task-id') || flags.requestId;
  const taskKey = opt(flags, '--task-key') || flags.positionals[2];
  if (!taskId && !isHexTaskKey(taskKey)) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '需要 --task-id <id> 或 --task-key <0x..64hex>', { usage: plain(CHAIN_USAGE.trim()) }, [], 'needs_human'), human: CHAIN_USAGE };
  }
  const r = OT.recoverOnchainTrade({ home: home(), taskId, taskKey });
  const nextMap: Record<string, NextAction> = {
    create_escrow: null, submit_proof: 'needs_human', release: 'needs_human',
    verify_only: 'reconcile', done: null, needs_human: 'needs_human',
  };
  const data = {
    found: r.found, taskId: r.taskId, taskKey: r.taskKey,
    nextAction: r.nextAction, nextActionToken: nextMap[r.nextAction] ?? 'needs_human',
    mustNotRepay: r.mustNotRepay, verified: r.verified, reason: r.reason, blockedBy: r.blockedBy,
    statePath: r.statePath,
    records: r.records.map((x: any) => ({ method: x.method, txHash: x.txHash, status: x.status, confirmations: x.confirmations, blockNumber: x.blockNumber, suspect: x.suspect, suspectReason: x.suspectReason ?? null, escrowState: x.escrowState ?? null })),
    writesMoney: false, writesKeys: false,
    note: '纯读盘 (~/.bolloon/chain/chain-state.json): 只给下一步建议, 不发交易/不重付/不自动退款',
  };
  const evidence = r.records.map((x: any) => x.txHash).filter(Boolean) as string[];
  const human = [
    title(head),
    line('找到链上事实', r.found ? '是' : '否'),
    line('taskKey', r.taskKey),
    line('下一步', `${r.nextAction} (next_action=${nextMap[r.nextAction] ?? 'needs_human'})`),
    line('绝不重付', String(r.mustNotRepay)),
    line('链上可信', String(r.verified)),
    ...r.records.map((x: any) => `    ${x.method}  ${x.status}  conf=${x.confirmations}  suspect=${x.suspect}  ${String(x.txHash).slice(0, 18)}…`),
    `\n  ${r.reason}`,
  ].join('\n');

  const suspectRecords = r.records.filter((x: any) => x.suspect === true);
  const suspect = suspectRecords.length > 0 || (r.nextAction === 'needs_human' && /可疑|重组/.test(r.reason));
  if (suspect) {
    // ★ 只要这条 taskKey 下有**任何**被标不可信的记录, 就一律按「绝不重付 + 待人工」处理 ——
    //   即使 P4 因为缺 create 记录而给出 create_escrow, 也不许在这里把可疑记录读成"可以安全从头走"。
    //   P4 的原始判定仍原样保留在 p4NextAction / p4MustNotRepay 里 (不篡改口径)。
    return {
      envelope: failEnvelope('REORG_SUSPECTED', `有链上记录被标不可信 (重组/事件消失) → 待人工, 绝不当已结算: ${r.reason}`, {
        ...data,
        mustNotRepay: true,
        p4NextAction: r.nextAction,
        p4MustNotRepay: r.mustNotRepay,
        suspectRecords: suspectRecords.map((x: any) => ({ method: x.method, txHash: x.txHash, suspectReason: x.suspectReason ?? null })),
      }, evidence, 'needs_human'),
      human,
    };
  }
  if (r.nextAction === 'verify_only') {
    return { envelope: failEnvelope('CHAIN_UNCERTAIN', `链上结论未定 → 先对账, 不许重发: ${r.reason}`, data, evidence, 'reconcile'), human };
  }
  if (r.nextAction === 'needs_human') {
    const reverted = /回滚/.test(r.reason);
    return { envelope: failEnvelope(reverted ? 'CHAIN_TX_REVERTED' : 'CHAIN_UNCERTAIN', r.reason, data, evidence, 'needs_human'), human };
  }
  return { envelope: okEnvelope('OK', `本机链上事实: nextAction=${r.nextAction} · verified=${r.verified}`, data, evidence, nextMap[r.nextAction] ?? null), human };
}

