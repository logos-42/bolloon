/**
 * x402-buyer-command.ts — 买方侧: `bolloon x402 pay <endpoint> [--with-memo]`
 *
 * 一句话: **买方用自己的钱包, 自己签、自己发**一笔 EIP-3009 `transferWithAuthorization`,
 * 把 USDC 直接打到卖方的 `accepts.payTo`, 然后把 txHash 交回卖方端点。
 * 全程**没有任何 facilitator / 平台 / 托管**; 付款方(买方)自己付 gas。
 *
 * `--with-memo` 是本命令与"随便转一笔"的全部区别:
 *   把**订单身份**按约定 v1 编进 EIP-3009 的 `nonce` (见 `src/agents/x402/order-identity.ts`),
 *   于是"谁付 · 多少 · 给谁 · **买的是哪件**"落在**同一笔交易**里, 卖方与任何第三方
 *   都能从链上日志 (AuthorizationUsed) 读出并复算。不带 `--with-memo` 时用随机 nonce ——
 *   付得成, 但那笔交易在链上**没有订单身份** (卖方会如实报「直转(无订单标识)」)。
 *
 * 红线 (写进代码, 不靠自觉):
 *   · 私钥**只从文件读** (`--key-file <path>` 或 `BOLLOON_X402_BUYER_KEY_FILE`), 绝不进命令行/日志/回显;
 *     只有付款方自己的地址会打印出来。
 *   · **不在一个交易里自付自收**: payTo == 买方地址 → 直接拒。
 *   · 金额上限 `--max-payment` (缺省 20000 原子 = 0.02 USDC) —— 超过就拒, 不"问一下再发"。
 *   · EIP-712 域**不写死**: 先读链上 `DOMAIN_SEPARATOR()` 再拿候选 (name/version) 对账,
 *     对不上就**拒签并说清试过哪些** (USDC 的 EIP-712 name 是 "USD Coin" 不是 "USDC" ——
 *     用错 name 签出来链上必 revert, 这不是"可能不兼容")。
 *   · 发之前: 两条 RPC 交叉核 `chainId`/USDC 余额/ETH 余额/gasPrice + `estimateGas` 成功 + 本地验签回买方地址。
 */

import * as fs from 'fs/promises';
// 链/网络口径的事实源留在 direct-payment.ts (不在这里另抄一份 chainId 表 / RPC 表)
import { CHAIN_ID_BY_NETWORK, DEFAULT_DIRECT_RPCS } from '../agents/x402/direct-payment.js';
import {
  computeOrderNonce, decodeOrderNonce, orderIdentityFromLogs,
  eip712DomainSeparator,
  USDC_EIP712_NAME_CANDIDATES, USDC_EIP712_VERSION_CANDIDATES,
  SELECTOR_DOMAIN_SEPARATOR,
  ORDER_NONCE_TAG_ASCII, ORDER_IDENTITY_PROTOCOL, ORDER_NONCE_TAG,
  type OrderIdentity,
} from '../agents/x402/order-identity.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

const DEFAULT_MAX_PAYMENT_ATOMIC = '20000';   // 0.02 USDC —— 与"单品 ≤0.02 USDC"授权口径一致
const USDC_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function balanceOf(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function version() view returns (string)',
  'function name() view returns (string)',
];

interface ParsedArgs {
  endpoint?: string;
  keyFile?: string;
  rpcs: string[];
  seq: number;
  validSeconds: number;
  maxPayment: string;
  confirmations: number;
  withMemo: boolean;
  json: boolean;
  dryRun: boolean;
  timeoutMs: number;
}

function usage(): void {
  console.log(`${BOLD}bolloon x402 pay <endpoint> [选项]${RESET}`);
  console.log('  买方**自己**发一笔 EIP-3009 transferWithAuthorization 到卖方 accepts.payTo, 再把 txHash 交回卖方端点');
  console.log('');
  console.log(`${BOLD}选项:${RESET}`);
  console.log(`  --with-memo              把订单身份按约定 v1 编进 nonce (标签 ${ORDER_NONCE_TAG_ASCII} ${ORDER_NONCE_TAG}) —— 买方侧自证`);
  console.log('  --key-file <path>        买方钱包文件 (JSON {privateKey} 或裸 0x…); 也可用 BOLLOON_X402_BUYER_KEY_FILE ★ 私钥只从文件读');
  console.log('  --rpc <url[,url]>        RPC (缺省按 network 取 2 条; 余额/gasPrice 交叉核对)');
  console.log('  --seq <n>                订单序号 (缺省 0; 同一买家重复买同一件必须换一个, 链上 (payer,nonce) 只能用一次)');
  console.log('  --valid-seconds <n>      授权有效期 (缺省 900s; validAfter = 现在-60)');
  console.log(`  --max-payment <atomic>   付款上限 (原子单位, 缺省 ${DEFAULT_MAX_PAYMENT_ATOMIC} = 0.02 USDC) —— 超了就拒`);
  console.log('  --confirmations <n>      发出后等几个确认再交回卖方 (卖方门槛 2)');
  console.log('  --dry-run                只算/只签, 不发交易');
  console.log('  --json                   只输出 JSON');
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    rpcs: [], seq: 0, validSeconds: 900, maxPayment: DEFAULT_MAX_PAYMENT_ATOMIC,
    confirmations: 2, withMemo: false, json: false, dryRun: false, timeoutMs: 60_000,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => { const v = args[++i]; if (v === undefined) throw new Error(`${a} 缺参数`); return v; };
    if (a === '--with-memo' || a === '--memo') out.withMemo = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--key-file') out.keyFile = next();
    else if (a === '--rpc' || a === '--rpc-url') out.rpcs.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--seq') out.seq = Number(next());
    else if (a === '--valid-seconds') out.validSeconds = Number(next());
    else if (a === '--max-payment') out.maxPayment = String(next());
    else if (a === '--confirmations') out.confirmations = Number(next());
    else if (a === '--timeout-sec') out.timeoutMs = Number(next()) * 1000;
    else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
    else rest.push(a);
  }
  out.endpoint = rest[0];
  out.keyFile = out.keyFile || process.env.BOLLOON_X402_BUYER_KEY_FILE || undefined;
  return out;
}

interface RpcFacts {
  rpc: string;
  chainId: number;
  blockNumber: number;
  usdcBalance: string;
  ethBalance: string;
  gasPrice: string;
  nonce: number;
}

async function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 15_000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    if (j?.error) throw new Error(`${method}: ${String(j.error.message || 'error').slice(0, 140)}`);
    return j.result;
  } finally { clearTimeout(t); }
}

function pad32(hexNo0x: string): string { return hexNo0x.padStart(64, '0'); }
function addrWord(addr: string): string { return pad32(String(addr).replace(/^0x/, '').toLowerCase()); }

/** 读一条 RPC 上的余额/gasPrice/chainId (交叉核对用) */
async function readFacts(url: string, buyer: string, asset: string): Promise<RpcFacts> {
  const [cid, bn, usdc, eth, gp, nonce] = await Promise.all([
    rpcCall(url, 'eth_chainId', []),
    rpcCall(url, 'eth_blockNumber', []),
    rpcCall(url, 'eth_call', [{ to: asset, data: `0x70a08231${addrWord(buyer)}` }, 'latest']),
    rpcCall(url, 'eth_getBalance', [buyer, 'latest']),
    rpcCall(url, 'eth_gasPrice', []),
    rpcCall(url, 'eth_getTransactionCount', [buyer, 'pending']),
  ]);
  return {
    rpc: new URL(url).host,
    chainId: Number(BigInt(cid)),
    blockNumber: Number(BigInt(bn)),
    usdcBalance: String(BigInt(usdc)),
    ethBalance: String(BigInt(eth)),
    gasPrice: String(BigInt(gp)),
    nonce: Number(BigInt(nonce)),
  };
}

const fmtUsdc = (atomic: string): string => (Number(BigInt(atomic)) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const fmtEth = (wei: string): string => (Number(BigInt(wei)) / 1e18).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');

/** 从钱包文件里读私钥 (只在脚本内使用, 任何路径都不回显) */
async function loadBuyerKey(keyFile: string): Promise<string> {
  const raw = (await fs.readFile(keyFile, 'utf-8')).trim();
  let key = raw;
  try {
    const j = JSON.parse(raw);
    key = String(j?.privateKey || j?.private_key || j?.key || '');
  } catch { /* 裸 hex 文件 */ }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key.trim())) {
    throw new Error(`钱包文件里没找到 0x + 64 hex 的 privateKey (文件: ${keyFile}) —— 不打印内容, 请自行检查格式`);
  }
  return key.trim();
}

/** 从链上 DOMAIN_SEPARATOR 反查真正的 EIP-712 域 (name/version 不写死) */
async function resolveTokenDomain(
  rpcUrl: string, asset: string, chainId: number,
): Promise<{ name: string; version: string; verifyingContract: string; onchainSep: string; verified: true } | {
  error: string; onchainSep?: string; tried: string[];
}> {
  const onchainSep = String(await rpcCall(rpcUrl, 'eth_call', [{ to: asset, data: SELECTOR_DOMAIN_SEPARATOR }, 'latest']));
  const tried: string[] = [];
  for (const name of USDC_EIP712_NAME_CANDIDATES) {
    for (const version of USDC_EIP712_VERSION_CANDIDATES) {
      const sep = eip712DomainSeparator({ name, version, chainId, verifyingContract: asset });
      tried.push(`${name}/${version}=${sep.slice(0, 12)}…`);
      if (sep.toLowerCase() === onchainSep.toLowerCase()) {
        return { name, version, verifyingContract: asset, onchainSep, verified: true };
      }
    }
  }
  return { error: '候选 EIP-712 域都对不上链上 DOMAIN_SEPARATOR()', onchainSep, tried };
}

/** 极简 ABI 解码 string (只处理 offset+len+data) */
function decodeAbiString(hex: string): string | null {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 128) return null;
  try {
    const off = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2;
    const len = Number(BigInt(`0x${h.slice(off, off + 64)}`));
    return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf-8');
  } catch { return null; }
}

/**
 * `bolloon x402 pay <endpoint> [--with-memo]` —— 返回退出码。
 *   0 = 卖方端点 202/200 且 (带 memo 时) 订单自证成功; 1 = 失败 (原因写清); 2 = 用法/参数错
 */
export async function x402PayCommand(args: string[]): Promise<number> {
  let opt: ParsedArgs;
  try { opt = parseArgs(args); } catch (e: any) {
    console.error(`${RED}参数错误:${RESET} ${e?.message}`);
    usage();
    return 2;
  }
  if (!opt.endpoint) { usage(); return 2; }
  const log = (...a: unknown[]) => { if (!opt.json) console.log(...a); };

  try {
    // ── 0. 买方钱包 (私钥只在内存里; 只打印地址)
    if (!opt.keyFile) {
      console.error(`${RED}缺 --key-file${RESET} (或 env BOLLOON_X402_BUYER_KEY_FILE) —— 私钥只从文件读, 不进命令行`);
      return 2;
    }
    const privateKey = await loadBuyerKey(opt.keyFile);
    // 动态 import: 只有走到这条路才需要 ethers (其余 x402 子命令不受影响)
    const { Wallet, JsonRpcProvider, Contract, Signature, verifyTypedData, TypedDataEncoder } = await import('ethers');
    const wallet = new Wallet(privateKey);
    const buyer = wallet.address;

    // ── 1. GET 拿 402 + accepts
    const res = await fetch(opt.endpoint, { headers: { accept: 'application/json' } });
    const bodyText = await res.text();
    let body: any = null;
    try { body = JSON.parse(bodyText); } catch { /* 非 JSON */ }
    let accepts: any = body?.accepts?.[0];
    if (!accepts) {
      const hdr = res.headers.get('x-payment-required') || res.headers.get('X-PAYMENT-REQUIRED');
      if (hdr) { try { accepts = JSON.parse(hdr)?.[0]; } catch { /* 忽略 */ } }
    }
    if (res.status !== 402 || !accepts) {
      console.error(`${RED}预期 402 + accepts, 实际 HTTP ${res.status}${RESET} ${String(body?.error || bodyText).slice(0, 200)}`);
      return 1;
    }
    const network = String(accepts.network || '');
    const chainId = CHAIN_ID_BY_NETWORK[network];
    const asset = String(accepts.asset || '');
    const payTo = String(accepts.payTo || '');
    const amount = String(accepts.amount || '0');
    const itemId = String(accepts.extra?.itemId || new URL(opt.endpoint).pathname.split('/').filter(Boolean).pop() || '');
    if (!chainId) { console.error(`${RED}不认识的 network=${network}${RESET}`); return 1; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      console.error(`${RED}accepts 里的 asset/payTo 形状不对${RESET}`); return 1;
    }
    if (String(accepts.scheme || 'exact') !== 'exact') { console.error(`${RED}不支持的 scheme=${accepts.scheme}${RESET}`); return 1; }
    // ★ 不在一个交易里自付自收
    if (payTo.toLowerCase() === buyer.toLowerCase()) {
      console.error(`${RED}payTo 就是买方自己${RESET} (${payTo}) —— 自付自收不算交易, 拒发`);
      return 1;
    }
    if (BigInt(amount) > BigInt(opt.maxPayment)) {
      console.error(`${RED}金额 ${amount} 超过 --max-payment ${opt.maxPayment}${RESET} —— 拒发`);
      return 1;
    }
    if (!itemId) { console.error(`${RED}accepts.extra.itemId 与 URL 都没给出 itemId —— 无法编订单标识${RESET}`); return 1; }

    const rpcs = opt.rpcs.length ? opt.rpcs : (DEFAULT_DIRECT_RPCS[network] || []);
    if (!rpcs.length) { console.error(`${RED}没有可用 RPC (--rpc 指定)${RESET}`); return 1; }

    log(`${BOLD}卖方报价${RESET} (GET ${opt.endpoint} → 402)`);
    log(`  item=${itemId} 金额=${amount} 原子 (${fmtUsdc(amount)} USDC) payTo=${payTo}`);
    log(`  network=${network} chainId=${chainId} asset=${asset}`);
    log(`  买方=${buyer} (gas 由买方自己出, 无 facilitator/托管)`);

    // ── 2. 两条 RPC 交叉核余额/gasPrice
    const facts: RpcFacts[] = [];
    for (const u of rpcs.slice(0, 3)) {
      try { facts.push(await readFacts(u, buyer, asset)); }
      catch (e: any) { log(`${YELLOW}· RPC ${new URL(u).host} 读不到: ${String(e?.message || e).slice(0, 100)}${RESET}`); }
    }
    if (!facts.length) { console.error(`${RED}所有 RPC 都读不到 —— 不发交易${RESET}`); return 1; }
    for (const f of facts) {
      if (f.chainId !== chainId) { console.error(`${RED}RPC ${f.rpc} 在 chainId=${f.chainId}, 期望 ${chainId}${RESET}`); return 1; }
    }
    log(`${BOLD}链上余额/费用交叉核对${RESET} (${facts.length} 条 RPC)`);
    for (const f of facts) {
      log(`  ${f.rpc}: 块 ${f.blockNumber} · USDC ${fmtUsdc(f.usdcBalance)} · ETH ${fmtEth(f.ethBalance)} · gasPrice ${f.gasPrice} wei · txNonce ${f.nonce}`);
    }
    if (facts.length >= 2) {
      const usdcSame = facts.every((f) => f.usdcBalance === facts[0].usdcBalance);
      const ethSame = facts.every((f) => f.ethBalance === facts[0].ethBalance);
      log(`  ${usdcSame ? '✅' : `${YELLOW}⚠${RESET}`} USDC 余额两 RPC ${usdcSame ? '一致' : '不一致'} · ETH ${ethSame ? '一致' : '不一致'}`);
      if (!usdcSame || !ethSame) { console.error(`${RED}两个 RPC 对余额说法不一致 —— 不确定, 不发交易${RESET}`); return 1; }
    }
    const maxGasPrice = facts.reduce((a, f) => (BigInt(f.gasPrice) > BigInt(a) ? f.gasPrice : a), facts[0].gasPrice);
    if (BigInt(facts[0].usdcBalance) < BigInt(amount)) {
      console.error(`${RED}USDC 余额不足${RESET}: 有 ${fmtUsdc(facts[0].usdcBalance)}, 需要 ${fmtUsdc(amount)}`);
      return 1;
    }
    const gasCeiling = BigInt(maxGasPrice) * 150_000n;   // 上界估算 (实际 ~60-80k)
    if (BigInt(facts[0].ethBalance) < gasCeiling) {
      console.error(`${RED}ETH 不够付 gas${RESET}: 有 ${fmtEth(facts[0].ethBalance)}, 上界需要 ${fmtEth(gasCeiling.toString())}`);
      return 1;
    }

    // ── 3. EIP-712 域: 拿链上 DOMAIN_SEPARATOR 反查, 不写死
    const t0 = facts[0].rpc;
    const sendRpc = rpcs[0];
    const dom = await resolveTokenDomain(sendRpc, asset, chainId);
    if ('error' in dom) {
      console.error(`${RED}EIP-712 域无法确定${RESET}: 链上 DOMAIN_SEPARATOR=${dom.onchainSep} 与所有候选都对不上 (试过: ${dom.tried.join(', ')}) —— 拒签`);
      return 1;
    }
    log(`${BOLD}EIP-712 域${RESET} (链上 DOMAIN_SEPARATOR 反查通过, 不写死)`);
    log(`  name="${dom.name}" version="${dom.version}" chainId=${chainId} verifyingContract=${asset}`);
    log(`  DOMAIN_SEPARATOR=${dom.onchainSep} ${DIM}(候选里唯一命中的那个)${RESET}`);

    // ── 4. 授权 + 订单标识 nonce
    const nowSec = Math.floor(Date.now() / 1000);
    const validAfter = nowSec - 60;
    const validBefore = nowSec + opt.validSeconds;
    let nonce: string;
    if (opt.withMemo) {
      nonce = computeOrderNonce(itemId, opt.seq);
      const d = decodeOrderNonce(nonce);
      log(`${BOLD}订单标识 (约定 v1)${RESET}`);
      log(`  nonce=${nonce}`);
      log(`  标签=${d.tag}(${ORDER_NONCE_TAG}) orderSeq=${d.orderSeq} itemIdHash=${d.itemIdHash}`);
      log(`  ${DIM}卖方会用本店 item 复算 keccak256(${itemId}‖${d.orderSeq})[0..23] 比对${RESET}`);
      log(`  ${DIM}★ 同一买家重复买同一件要换 --seq: 链上 (payer, nonce) 只能用一次${RESET}`);
    } else {
      const { randomBytes } = await import('node:crypto');
      nonce = `0x${randomBytes(32).toString('hex')}`;
      log(`${YELLOW}未带 --with-memo: 用随机 nonce, 这笔交易在链上没有订单身份 (卖方会如实报「直转(无订单标识)」)${RESET}`);
    }
    log(`${BOLD}授权窗口${RESET} validAfter=${validAfter} validBefore=${validBefore} (${opt.validSeconds}s)`);

    // ── 5. EIP-712 签名 + 本地验签
    const domain = { name: dom.name, version: dom.version, chainId, verifyingContract: asset };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    };
    const value = { from: buyer, to: payTo, value: amount, validAfter, validBefore, nonce };
    const signature = await wallet.signTypedData(domain, types, value);
    const recovered = verifyTypedData(domain, types, value, signature);
    if (recovered.toLowerCase() !== buyer.toLowerCase()) {
      console.error(`${RED}本地验签回不到买方地址 (${recovered}) —— 不发出${RESET}`);
      return 1;
    }
    const sig = Signature.from(signature);
    log(`${GREEN}✅ EIP-712 签名完成并本地验签通过${RESET} (signer=${recovered})`);
    log(`  structHash=${TypedDataEncoder.hashStruct('TransferWithAuthorization', types, value)}`);
    log(`  v=${sig.v} r=${sig.r.slice(0, 18)}… s=${sig.s.slice(0, 18)}…`);

    const plan = {
      protocol: ORDER_IDENTITY_PROTOCOL,
      endpoint: opt.endpoint, itemId, network, chainId, asset, payTo, amount, buyer,
      nonce, withMemo: opt.withMemo,
      validAfter, validBefore,
      rpcs, t0, maxGasPriceWei: maxGasPrice,
      balancesBefore: facts.map((f) => ({ rpc: f.rpc, usdc: f.usdcBalance, eth: f.ethBalance, txNonce: f.nonce })),
      signature, domain,
    };

    // ── 6. estimateGas
    const provider = new JsonRpcProvider(sendRpc, chainId, { cacheTimeout: -1 });
    const contract = new Contract(asset, USDC_ABI, wallet.connect(provider));
    let gasEstimate: bigint;
    try {
      gasEstimate = await contract.transferWithAuthorization.estimateGas(
        buyer, payTo, amount, validAfter, validBefore, nonce, sig.v, sig.r, sig.s,
      );
    } catch (e: any) {
      console.error(`${RED}estimateGas 失败${RESET}: ${String(e?.shortMessage || e?.message || e).slice(0, 300)}`);
      console.error('  (链上预演没过就不发 —— 常见原因: EIP-712 域/参数不对、授权窗口过期、余额不足)');
      return 1;
    }
    log(`${GREEN}✅ estimateGas 成功${RESET}: ${gasEstimate} gas (上界估算约 ${fmtEth((gasEstimate * BigInt(maxGasPrice)).toString())} ETH)`);

    if (opt.dryRun) {
      console.log(JSON.stringify({ ...plan, dryRun: true, gasEstimate: gasEstimate.toString() }, null, 2));
      return 0;
    }

    // ── 7. 发交易 (买方自己发: 付款方付 gas)
    const feeData = await provider.getFeeData();
    const tx = await contract.transferWithAuthorization(
      buyer, payTo, amount, validAfter, validBefore, nonce, sig.v, sig.r, sig.s,
      { gasLimit: (gasEstimate * 13n) / 10n, maxFeePerGas: feeData.maxFeePerGas ?? undefined, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined },
    );
    log(`${BOLD}已发出${RESET} txHash=${tx.hash} (买方自己签、自己发, gas 从买方账户扣)`);
    const receipt = await tx.wait(opt.confirmations);
    if (!receipt || receipt.status !== 1) {
      console.error(`${RED}交易失败/回滚${RESET} txHash=${tx.hash} status=${receipt?.status}`);
      return 1;
    }
    const gasUsed = BigInt(receipt.gasUsed);
    const gasPaid = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? maxGasPrice);
    log(`${GREEN}✅ 交易已确认${RESET} 块 ${receipt.blockNumber} · gasUsed ${gasUsed} · gasPrice ${receipt.gasPrice} wei · 实付 gas ${fmtEth(gasPaid.toString())} ETH · 确认数 ≥ ${opt.confirmations}`);

    // ── 8. 链上自读复核 (不信卖方, 自己从日志里解一次订单标识)
    const logs = (receipt.logs || []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data }));
    const selfRead: OrderIdentity = orderIdentityFromLogs(logs, { itemIds: [itemId], asset });
    log(`${BOLD}① 自己读链复核${RESET} (与卖方无关)`);
    log(`  mode=${selfRead.mode} nonce=${selfRead.nonce} orderSeq=${selfRead.orderSeq}`);
    log(`  ${selfRead.detail}`);
    if (opt.withMemo && !selfRead.selfAttested) {
      console.error(`${YELLOW}⚠ 自己读链也没能自证 (mode=${selfRead.mode}) —— 继续把 txHash 交给卖方, 但如实说明${RESET}`);
    }

    // ── 9. 交回卖方端点
    const payUrl = `${opt.endpoint.replace(/\/+$/, '')}/payment`;
    const post = await fetch(payUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: tx.hash }),
    });
    const postText = await post.text();
    let postBody: any = null;
    try { postBody = JSON.parse(postText); } catch { /* 非 JSON */ }
    log(`${BOLD}② 卖方端点回执${RESET} POST ${payUrl} → HTTP ${post.status}`);
    log(`  status=${postBody?.status || '-'} orderIdentityMode=${postBody?.payment?.orderIdentityMode || postBody?.orderIdentity?.mode || '-'}`);
    log(`  orderIdentitySelfAttested=${postBody?.payment?.orderIdentitySelfAttested ?? postBody?.orderIdentity?.selfAttested ?? '-'}`);
    log(`  ${postBody?.orderIdentity?.detail || ''}`);

    const out = {
      ok: post.status === 200 || post.status === 202,
      httpStatus: post.status,
      endpoint: opt.endpoint,
      txHash: tx.hash,
      explorer: `https://basescan.org/tx/${tx.hash}`,
      itemId, network, chainId, amount, currency: 'USDC', payTo, payer: buyer,
      gasUsed: gasUsed.toString(), gasPrice: String(receipt.gasPrice ?? maxGasPrice), gasPaidWei: gasPaid.toString(),
      blockNumber: Number(receipt.blockNumber), withMemo: opt.withMemo, nonce,
      orderIdentitySelfReadFromChain: selfRead,
      sellerResponse: postBody ?? postText.slice(0, 2000),
    };
    if (opt.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      log(`${BOLD}③ 浏览器${RESET} https://basescan.org/tx/${tx.hash}`);
      log(`${post.status === 202 || post.status === 200 ? GREEN + '✅' : RED + '❌'}${RESET} 最终 HTTP ${post.status}${postBody?.retrieval?.path ? ` · 取件 ${postBody.retrieval.path}` : ''}`);
    }
    if (post.status !== 200 && post.status !== 202) return 1;
    if (opt.withMemo && (postBody?.payment?.orderIdentitySelfAttested ?? postBody?.orderIdentity?.selfAttested) !== true) return 1;
    return 0;
  } catch (e: any) {
    console.error(`${RED}失败:${RESET} ${String(e?.shortMessage || e?.message || e)}`);
    return 1;
  }
}

/** 给 `bolloon x402` 帮助文本用的一句说明 (与实现写在一起, 免得文档漂移) */
export const X402_PAY_HELP_LINE =
  'bolloon x402 pay <endpoint> --with-memo   # 买方自己发 EIP-3009 transferWithAuthorization (nonce 带订单标识 BOL1)';
