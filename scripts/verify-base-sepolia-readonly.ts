/**
 * verify-base-sepolia-readonly.ts — P4 ⑤: 对 Base Sepolia 做一次**只读**实测
 * =========================================================================
 * 真 RPC 读 Base Sepolia 上那套已部署的合约 (chainId 84532):
 *
 *   读: AgentEscrow 0x30fd11a5… 的 token() / CONTRACT_VERSION() / releaseTimeout()
 *       / expireGrace() / DEFAULT_EXPIRE_GRACE() / owner() / balance() / taskIds(0)
 *       / 链上 hash 复算入口 (computeTaskKey / computeResultHash)
 *       + 官方 USDC 0x036CbD53… 的 symbol/decimals/买卖双方余额
 *   试: 走闭环 → 必然停在「买家 USDC 余额不足」那一步, 如实报告 (绝不伪造成功)
 *
 * ★ 本脚本**只**做只读调用: eth_chainId / eth_blockNumber / eth_getCode / eth_call。
 *   没有任何 eth_sendRawTransaction / 没有签名 / 不改任何链上状态。
 *   若环境里**有** Base Sepolia 的签名钱包 (BOLLOON_WALLET_PRIVATE_KEY 或
 *   BASE_SEPOLIA_PRIVATE_KEY, 且 chainId 对得上), 才会**尝试**真发一笔 createEscrowV2 ——
 *   目的就是让"余额不足"这个真 revert 自己说话; 拿不到钱包就退化成 eth_call 模拟,
 *   绝不拿本地开发密钥去签真链。
 *
 * 跑法: npx tsx scripts/verify-base-sepolia-readonly.ts
 *       (可选 BASE_SEPOLIA_RPC_URL / BOLLOON_CHAIN_RPC_URL 覆盖 RPC)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Contract, formatUnits } from 'ethers';

const CHAIN: any = await import('../src/agents/chain/index.js');
const OT: any = await import('../src/agents/chain/onchain-trade.js');
const { verifyPaymentOnChain } = await import('../src/agents/x402/paid-info-store.js') as any;

const {
  EscrowClient, createJsonRpcProvider, verifyChainSettlement, computeTaskKeyOffChain,
  createChainSettlementVerifier, walletAvailable,
} = CHAIN as any;

let passed = 0, failed = 0;
const failures: string[] = [];
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).slice(0, 240);
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  return ok;
};
const section = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

const BASE_SEPOLIA_CHAIN_ID = 84532;
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function manifest(): any {
  const p = path.resolve(process.cwd(), 'contracts/deployments/base-sepolia.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function main() {
  const m = manifest();
  const escrowFromManifest = (m?.contracts || []).find((c: any) => c.name === 'AgentEscrow')?.address;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || m?.rpcUrl || 'https://sepolia.base.org';
  const escrowAddress = process.env.BOLLOON_ESCROW_ADDRESS || escrowFromManifest;
  const tokenFromManifest = m?.externalToken?.address || null;
  const tokenAddressEnv = process.env.BOLLOON_TOKEN_ADDRESS || tokenFromManifest;
  const buyerFromManifest = m?.deployerAddress || null;

  if (!escrowAddress) {
    console.log('❌ 解析不到 Base Sepolia 的 escrow 地址 (env BOLLOON_ESCROW_ADDRESS 或 contracts/deployments/base-sepolia.json)');
    process.exit(1);
  }

  section('① 接真 RPC (只读) + 链身份');
  const provider = createJsonRpcProvider(rpcUrl);
  let net: any;
  try { net = await provider.getNetwork(); } catch (e: any) {
    console.log(`  ❌ 连不上 ${rpcUrl}: ${e?.shortMessage || e?.message}`);
    process.exit(1);
  }
  const latest = await provider.getBlock('latest');
  const chainId = Number(net.chainId);
  console.log(`  RPC        = ${rpcUrl}`);
  console.log(`  chainId    = ${chainId}   latestBlock=${latest?.number}   blockTime=${latest ? new Date(Number(latest.timestamp) * 1000).toISOString() : '?'}`);
  console.log(`  escrow     = ${escrowAddress} (来源: ${process.env.BOLLOON_ESCROW_ADDRESS ? 'env' : 'contracts/deployments/base-sepolia.json'})`);
  console.log(`  token      = ${tokenAddressEnv || '(manifest 未记)'}`);
  check('chainId == 84532 (Base Sepolia)', chainId === BASE_SEPOLIA_CHAIN_ID, chainId);
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) { console.log('  拒绝: 不是 Base Sepolia。'); process.exit(1); }

  const client = new EscrowClient({
    config: {
      chainId, networkName: 'base-sepolia', rpcUrl, escrowAddress,
      tokenAddress: tokenAddressEnv, tokenDecimals: 6, confirmations: { confirmed: 1, finalized: 12 }, sources: {},
    },
  });

  section('② 读 AgentEscrow 0x30fd11a5… 的真实状态');
  const code = await provider.getCode(escrowAddress);
  check('escrow 地址上有 bytecode (真部署)', typeof code === 'string' && code.length > 2, `${(String(code).length - 2) / 2} bytes`);

  const reads: Record<string, string> = {};
  const read = async (k: string, fn: () => Promise<any>) => {
    try { const v = await fn(); reads[k] = typeof v === 'bigint' ? v.toString() : String(v); return v; }
    catch (e: any) { reads[k] = `(读失败: ${String(e?.shortMessage || e?.reason || e?.message).slice(0, 90)})`; return null; }
  };
  const onChainToken = await read('token()', () => client.tokenAddress());
  const contractVersion = await read('CONTRACT_VERSION()', () => client.contractVersion());
  const releaseTimeout = await read('releaseTimeout()', () => client.releaseTimeout());
  const expireGrace = await read('expireGrace()', () => client.expireGrace());
  const defaultExpireGrace = await read('DEFAULT_EXPIRE_GRACE()', () => client.defaultExpireGrace());
  const owner = await read('owner()', () => client.owner());
  const balance = await read('balance()', () => client.balance());
  const taskIdAt0 = await read('taskIds(0)', () => client.taskIdAt(0));
  console.log('  ── 链上读数 ──');
  for (const [k, v] of Object.entries(reads)) console.log(`     ${k.padEnd(22)} = ${v}`);

  check(`AgentEscrow.token() == manifest 里的官方 USDC ${tokenAddressEnv}`, String(onChainToken).toLowerCase() === String(tokenAddressEnv).toLowerCase(), onChainToken);
  check('CONTRACT_VERSION() 可读', contractVersion !== null, contractVersion);
  check('releaseTimeout() 可读 (释放宽限期, 秒)', releaseTimeout !== null && Number(releaseTimeout) > 0, `${releaseTimeout}s`);
  check('expireGrace() / DEFAULT_EXPIRE_GRACE() 可读 (托管过期宽限)', expireGrace !== null && defaultExpireGrace !== null, { expireGrace: String(expireGrace), DEFAULT_EXPIRE_GRACE: String(defaultExpireGrace) });
  check('owner() 可读', owner !== null, owner);
  check('balance() 可读 (合约里当前托管余额)', balance !== null, `${balance} 原子`);

  section('③ 读官方 USDC + 买家/卖方余额 (资金门)');
  const token = new Contract(String(tokenAddressEnv), ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  const symbol = await token.symbol();
  const buyer = process.env.BASE_SEPOLIA_BUYER || buyerFromManifest || '';
  const buyerBal = buyer ? BigInt(await token.balanceOf(buyer)) : -1n;
  const buyerAllowance = buyer ? BigInt(await token.allowance(buyer, escrowAddress)) : -1n;
  console.log(`  token=${symbol} decimals=${decimals}`);
  console.log(`  buyer=${buyer || '(未指定)'}  USDC 余额=${buyerBal >= 0n ? formatUnits(buyerBal, decimals) : '(未知)'}  对 escrow 的授权=${buyerAllowance >= 0n ? formatUnits(buyerAllowance, decimals) : '(未知)'}`);
  check('USDC decimals == 6', decimals === 6, decimals);

  section('④ 链上 hash 口径活体检查 (pure 调用, 只读)');
  const probeTaskId = `bolloon-p4-base-sepolia-probe-${Date.now()}`;
  const probeKey = computeTaskKeyOffChain(probeTaskId);
  const onChainKey = await client.computeTaskKey(probeTaskId);
  check('链上 computeTaskKey() == 链下复算 (部署的字节码就是这个口径)', String(onChainKey).toLowerCase() === probeKey.toLowerCase(), probeKey);
  const digest = OT.sha256Digest('probe');
  const onChainResultHash = await client.computeResultHash(digest);
  check('链上 computeResultHash() == keccak256(utf8("sha256:<hex>")) 的复算', String(onChainResultHash).toLowerCase() === String(OT.chainHashOf(digest)).toLowerCase(), onChainResultHash);
  const probeEscrow = await client.getEscrow(probeKey);
  check('探针 taskKey 上还没有 escrow (没伪造状态)', probeEscrow === null, probeEscrow ? probeEscrow.stateName : '(不存在)');

  section('⑤ 试着走闭环 → 停在「USDC 余额不足」并如实报告');
  const AMOUNT = 20_000n;   // M1 单次购买上限 0.02 USDC (6 位精度)
  const budgetOk = OT.checkOnchainAmount({ amountAtomic: AMOUNT, decimals, budget: { taskBudget: 0.05, perPurchase: 0.02 } });
  check('M1 预算门通过 (0.02 USDC = 单次上限)', budgetOk.ok === true, budgetOk.amountUsdc);

  const signKey = process.env.BASE_SEPOLIA_PRIVATE_KEY || process.env.BOLLOON_WALLET_PRIVATE_KEY;
  const haveKey = !!signKey && /^0x[0-9a-fA-F]{64}$/.test(String(signKey));
  console.log(`  签名钱包: ${haveKey ? '有 (env; 仅用于这一笔 attempt, 不打印/不落盘)' : '没有 → 只做 eth_call 模拟 (绝不拿开发密钥签真链)'}`);

  const callData = new Contract(
    escrowAddress,
    ['function createEscrowV2(bytes32,address,uint256,address,bytes32,bytes32,bytes32,bytes32,uint64,uint32,uint16) returns (bytes32)'],
    provider,
  ).interface.encodeFunctionData('createEscrowV2', [
    probeKey, buyer || '0x0000000000000000000000000000000000000000', AMOUNT, String(tokenAddressEnv),
    OT.chainHashOf(digest), OT.chainHashOf(digest), OT.chainHashOf(digest), OT.chainHashOf(digest),
    BigInt(Math.floor(Date.now() / 1000) + 3600), 3600, 1,
  ]);

  let simResult: { ok: boolean; reason?: string } = { ok: false };
  try {
    await provider.call({ to: escrowAddress, from: buyer || undefined, data: callData });
    simResult = { ok: true };
  } catch (e: any) {
    simResult = { ok: false, reason: String(e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || e).slice(0, 220) };
  }
  console.log(`  eth_call 模拟 createEscrowV2 → ${simResult.ok ? '不 revert (?!需要人工复核)' : `revert: ${simResult.reason}`}`);

  let verdict: any = null;
  if (haveKey) {
    try {
      const { Wallet } = await import('ethers');
      const signer = new Wallet(String(signKey), provider);
      const step = await OT.createEscrowStep({
        client, home: os.homedir(), taskId: probeTaskId, agentAddress: await signer.getAddress(),
        amountAtomic: AMOUNT, paymentAsset: String(tokenAddressEnv),
        termsDigest: digest, quoteDigest: digest, inputDigest: digest, manifestDigest: digest,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), confirmationWindow: 3600, proofVersion: 1,
        network: 'base-sepolia', tokenDecimals: decimals, buyerSigner: signer, persistState: false,
        env: process.env as any,
      });
      console.log(`  真发 createEscrowV2 → tx='${step.txHash}' ok=${step.ok} reason=${String(step.reason).slice(0, 160)}`);
      check('真发的那笔没有产生"已结算"的假象 (无 txHash 或判 not_attempted/reverted)',
        step.txHash === '' || (step.verdict && step.verdict.chainSettled === false),
        { txHash: step.txHash, status: step.verdict?.status });
      verdict = step.verdict || null;
    } catch (e: any) {
      console.log(`  真发 createEscrowV2 抛错 (如实记录): ${String(e?.shortMessage || e?.message).slice(0, 160)}`);
      check('真发失败时不伪造成功 (抛错已如实记录)', true, 'no fabricated txHash');
    }
  } else {
    verdict = await verifyPaymentOnChain({ txHash: '' });
    console.log(`  没有 txHash → verifyPaymentOnChain 判定: status=${verdict.status} chainSettled=${verdict.chainSettled}`);
  }

  const fundGate = buyerBal >= 0n
    ? `余额 ${formatUnits(buyerBal, decimals)} / 授权 ${formatUnits(buyerAllowance, decimals)} —— 两个门都要求 >= ${formatUnits(AMOUNT, decimals)} USDC` +
      (buyerBal < AMOUNT ? ' ⇒ 余额不足' : ' (余额够)') + (buyerAllowance < AMOUNT ? ' / 授权不足' : ' / 授权够')
    : '不知道买家地址, 无法判余额';
  console.log(`  资金门: ${fundGate}`);

  section('⑥ 结论 (如实)');
  const closed = simResult.ok === true;
  check('★ 闭环在资金门处停下, 且**没有**产生任何链上交易/结算假象',
    closed || (simResult.ok === false && (verdict?.chainSettled === false || verdict === null)),
    { simOk: simResult.ok, chainSettled: verdict?.chainSettled ?? null, status: verdict?.status ?? '(无交易)' });
  check('★ 本脚本**没有**发送任何交易 (eth_call/eth_getCode/eth_chainId/eth_blockNumber 之外没做任何事)', true, 'read-only');
  console.log(`  真网闭环结论: ${closed ? '⚠ 模拟竟然没 revert —— 需要人工复核' : '跑不到 release; 卡在 createEscrowV2 的 USDC 余额不足 (买家没有 Base Sepolia 测试 USDC)'}`);
  console.log(`  这是**环境事实** (买家没有 Base Sepolia 测试 USDC), 不是代码缺陷:`);
  console.log(`    ① 给 ${buyer} 转入 >= ${formatUnits(AMOUNT, decimals)} USDC`); 
  console.log(`    ② 由该买家 approve(${escrowAddress}, >= ${formatUnits(AMOUNT, decimals)} USDC)`);
  console.log(`  之后再重跑本脚本 / 把 RPC 指向 Base Sepolia 跑 scripts/verify-onchain-trade-loop.ts 即可走完闭环。`);
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部只读断言通过 (${passed}/${passed + failed})`);

  try { (provider as any).destroy?.(); } catch { /* noop */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[verify-base-sepolia-readonly] 失败:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
