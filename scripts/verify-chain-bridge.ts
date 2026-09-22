/**
 * verify-chain-bridge.ts — P3「Bolloon 链桥」真链端到端验收
 * =========================================================================
 * 对着**正在运行的本地 anvil** (chainId 31337) 跑真链路:
 *   真签名 → 真发交易 (createEscrowV2 → submitProofV2 → releaseV2) → 真读 receipt 与 event
 *   → 确认数不足时不判 verified → 确认足够后判 verified
 *   → 真重组 (anvil_rollback) / 掉 RPC 时如实报未结算
 *
 * 跑法:
 *   # 终端 A
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1
 *   # 终端 B
 *   npx tsx scripts/verify-chain-bridge.ts
 *
 * 地址解析 (绝不 hardcode 合约地址): 环境变量 → ~/.bolloon/chain.json → 部署 manifest
 *   (contracts/deployments/localhost.json)
 * 钱包解析: 环境变量 (BOLLOON_WALLET_PRIVATE_KEY / AGENT_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)
 *   → ~/.bolloon/wallet.json → **仅当 chainId == 31337** 用 anvil 公开开发助记符派生
 *   (anvil 默认助记符是公开文档值, 零成本零资产, 非真实钱包; 别的链一律拒绝)
 *
 * 隔离: 链上状态 (/chain) 与签名审计 (wallet-signatures.jsonl) 都写到**临时 HOME**,
 *   不污染用户真实的 ~/.bolloon。审计写入走的是与生产同一份代码 (只是根目录不同)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { HDNodeWallet, Mnemonic, Wallet, Contract, formatUnits } from 'ethers';

const CHAIN = await import('../src/agents/chain/index.js');
const {
  EscrowClient, createJsonRpcProvider, verifyChainSettlement, createChainSettlementVerifier,
  sendChainTxGuarded, chainRequestIdOf, readChainSigningPolicy,
  recordVerdict, recoverChainState, loadChainState, markSuspect, chainStatePath, reconcileChainState,
  computeTaskKeyOffChain, LOCAL_DEV_CHAIN_ID, DEFAULT_CONFIRMATIONS,
} = CHAIN as any;

// ── 临时 HOME (不污染真实 ~/.bolloon) ────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chainbridge-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });

// ── 断言小工具 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else {
    failed++; failures.push(name);
    console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`);
  }
  return ok;
};
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).slice(0, 220);
const section = (t: string) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);
let getSuspect: (id: string) => boolean = () => false;

// ── 地址/钱包解析 (env → chain.json → manifest; 绝不 hardcode) ────────────────
function resolveDeployment(): { chainId: number; escrowAddress: string; tokenAddress: string | null; source: string } {
  const envRpcGiven = !!(process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL);
  if (process.env.BOLLOON_ESCROW_ADDRESS) {
    return {
      chainId: Number(process.env.BOLLOON_CHAIN_ID || LOCAL_DEV_CHAIN_ID),
      escrowAddress: process.env.BOLLOON_ESCROW_ADDRESS,
      tokenAddress: process.env.BOLLOON_TOKEN_ADDRESS || null,
      source: 'env BOLLOON_ESCROW_ADDRESS',
    };
  }
  const chainJson = path.join(HOME, '.bolloon', 'chain.json');
  if (fs.existsSync(chainJson)) {
    const j = JSON.parse(fs.readFileSync(chainJson, 'utf8'));
    if (j.escrowAddress) return { chainId: Number(j.chainId), escrowAddress: j.escrowAddress, tokenAddress: j.tokenAddress || null, source: chainJson };
  }
  const manifestPath = path.resolve(process.cwd(), 'contracts/deployments/localhost.json');
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const escrow = (m.contracts || []).find((c: any) => c.name === 'AgentEscrow');
    if (escrow?.address) {
      return { chainId: Number(m.chainId), escrowAddress: escrow.address, tokenAddress: m.token?.address || null, source: `manifest ${manifestPath}` };
    }
  }
  throw new Error(
    `解析不到 escrow 地址。优先级: env BOLLOON_ESCROW_ADDRESS → ${chainJson} → contracts/deployments/localhost.json` +
    (envRpcGiven ? '' : ' (也没给 RPC)'),
  );
}

async function resolveWalletKey(chainId: number): Promise<{ privateKey: string; source: string }> {
  const envKey = process.env.BOLLOON_WALLET_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (envKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(envKey)) throw new Error('env 里的私钥格式不对');
    return { privateKey: envKey, source: 'env (BOLLOON_WALLET_PRIVATE_KEY | AGENT_PRIVATE_KEY | DEPLOYER_PRIVATE_KEY)' };
  }
  const wf = path.join(HOME, '.bolloon', 'wallet.json');
  if (fs.existsSync(wf)) {
    const j = JSON.parse(fs.readFileSync(wf, 'utf8'));
    if (/^0x[0-9a-fA-F]{64}$/.test(String(j.privateKey || ''))) return { privateKey: j.privateKey, source: wf };
  }
  if (chainId !== LOCAL_DEV_CHAIN_ID) {
    throw new Error(`没有可用钱包, 且 chainId=${chainId} 不是本地开发链 → 拒绝用开发助记符签名 (绝不拿公开开发密钥签真链)`);
  }
  // anvil 默认助记符 = 公开文档值 (零资产, 仅本地链; 上一条 already 拒绝非 31337)
  const m = Mnemonic.fromPhrase('test test test test test test test test test test test junk');
  const w0 = HDNodeWallet.fromMnemonic(m, "m/44'/60'/0'/0/0");
  const w1 = HDNodeWallet.fromMnemonic(m, "m/44'/60'/0'/0/1");
  return {
    privateKey: process.env.__BRIDGE_USE_AGENT_ACCOUNT === '1' ? w1.privateKey : w0.privateKey,
    source: `anvil 公开开发助记符 (chainId=${chainId}; 零资产非真实钱包)`,
  };
}

// ── manifest 里那笔真 status=0 的交易 (不 hardcode) ──────────────────────────
function manifestRevertedTx(): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'contracts/deployments/localhost.json'), 'utf8'));
    const h = m?.f2Assertion?.evidence?.realTxHash_status0;
    return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? h : null;
  } catch { return null; }
}

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
];

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  const RPC_URL = process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545';
  const dep = resolveDeployment();

  section('① 接链 (真 JsonRpcProvider, cacheTimeout: -1)');
  const provider = createJsonRpcProvider(RPC_URL);
  (provider as any).pollingInterval = 250; // 事件监听要快一点 (真链上等事件)
  let net: any;
  try { net = await provider.getNetwork(); } catch (e: any) {
    console.log(`  ❌ 连不上 RPC ${RPC_URL}: ${e.message}`);
    console.log(`\n  提示: 先起 anvil → DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545`);
    process.exit(1);
  }
  const chainId = Number(net.chainId);
  const blockNow = await provider.getBlockNumber();
  console.log(`  RPC          : ${RPC_URL}`);
  console.log(`  chainId      : ${chainId}   latestBlock: ${blockNow}`);
  console.log(`  escrow       : ${dep.escrowAddress}   (来源: ${dep.source})`);
  console.log(`  token        : ${dep.tokenAddress ?? '(未配置)'}`);
  console.log(`  确认数配置   : confirmed=${DEFAULT_CONFIRMATIONS.confirmed} finalized=${DEFAULT_CONFIRMATIONS.finalized}`);

  check('chainId == 31337 (本地开发链)', chainId === LOCAL_DEV_CHAIN_ID, chainId);
  if (chainId !== LOCAL_DEV_CHAIN_ID) {
    console.log('  拒绝在非本地链上跑这个脚本 (它用 anvil 开发密钥签名)。');
    process.exit(1);
  }
  const { privateKey, source: keySource } = await resolveWalletKey(chainId);
  console.log(`  签名钱包     : ${keySource}`);
  // ★ 放行闸要求 walletAvailable=true。本机钱包的合法来源之一就是**环境变量** ——
  //   这里把解析到的密钥放进**进程内**环境 (不落盘、不打印、不进任何文件), 让放行闸
  //   走与生产同一路径 (env → wallet.json → 报错) 的 env 分支。
  process.env.BOLLOON_WALLET_PRIVATE_KEY = privateKey;

  const client = new EscrowClient({ config: { chainId, networkName: 'localhost', rpcUrl: RPC_URL, escrowAddress: dep.escrowAddress, tokenAddress: dep.tokenAddress, tokenDecimals: 6, confirmations: DEFAULT_CONFIRMATIONS, sources: {} } });
  getSuspect = (id: string) => loadChainState(HOME).records[id]?.suspect === true;

  section('② 合约真读数 + hash 口径交叉核对');
  const code = await provider.getCode(dep.escrowAddress);
  check('escrow 地址上有 bytecode', typeof code === 'string' && code.length > 2, `codeLength=${(String(code).length - 2) / 2} bytes`);
  const onChainVersion = await client.contractVersion();
  console.log(`  AgentEscrow.CONTRACT_VERSION = ${onChainVersion}`);
  const tokenAddr: string = dep.tokenAddress || (await client.tokenAddress());
  const token = new Contract(tokenAddr, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  check('token decimals == 6 (USDC 替身)', decimals === 6, decimals);
  console.log(`  token        : ${await token.symbol()} @ ${tokenAddr}`);

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const taskIdA = `bolloon-chainbridge-A-${runId}`;
  const taskKeyA = computeTaskKeyOffChain(taskIdA);
  const onChainKeyA = await client.computeTaskKey(taskIdA);
  check('taskKey: 链下复算 == 链上 computeTaskKey()', String(onChainKeyA).toLowerCase() === taskKeyA.toLowerCase(), `${taskKeyA} vs ${onChainKeyA}`);

  // ── 资金准备 (buyer = 签名账户; agent = 另一个本地账户) ───────────────────
  const buyer = new Wallet(privateKey, provider);
  const agentKey = process.env.AGENT_PRIVATE_KEY
    || HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase('test test test test test test test test test test test junk'), "m/44'/60'/0'/0/1").privateKey;
  const agent = new Wallet(agentKey, provider);
  console.log(`  buyer        : ${buyer.address}`);
  console.log(`  agent        : ${agent.address}`);

  const AMOUNT = 100_000_000n; // 100 USDC (6 位)
  const needsMint = (await token.balanceOf(buyer.address)) < AMOUNT * 4n;
  if (needsMint) {
    const t = await token.connect(buyer).mint(buyer.address, AMOUNT * 10n);
    await t.wait();
    console.log(`  mint tx      : ${t.hash}`);
  }
  const allow = await token.allowance(buyer.address, dep.escrowAddress);
  if (allow < AMOUNT * 4n) {
    const t = await token.connect(buyer).approve(dep.escrowAddress, AMOUNT * 10n);
    await t.wait();
    console.log(`  approve tx   : ${t.hash}`);
  }
  check('buyer 余额足够 + 已 approve escrow', (await token.balanceOf(buyer.address)) >= AMOUNT && (await token.allowance(buyer.address, dep.escrowAddress)) >= AMOUNT);

  section('③ 签名放行闸 (fail-closed; 未授权一律拒)');
  const intentFor = (method: string, key: string, amount = '0') => ({
    method, taskKey: key, amountAtomic: amount, network: 'localhost', capability: 'chain.escrow', mode: 'agent-authorized' as const,
  });
  const savedEnv = { ...process.env };
  delete process.env.BOLLOON_AGENT_AUTHORIZED;
  const policyWhenOff = readChainSigningPolicy({ home: HOME, env: process.env as any });
  const unauthorized = await sendChainTxGuarded({
    client, intent: intentFor('releaseV2', taskKeyA), home: HOME, env: process.env as any,
    signer: agent,
    execute: async () => { throw new Error('不该被调用'); },
  });
  check('未授权: 放行闸拒绝且 execute 未被调用', unauthorized.allowed === false, unauthorized.reason);
  check('未授权: 没有写审计', unauthorized.auditWritten === false, `policy.source=${policyWhenOff.source}`);

  process.env.BOLLOON_AGENT_AUTHORIZED = '1';
  const policyWhenOn = readChainSigningPolicy({ home: HOME, env: process.env as any });
  check('授权来源是本机策略 (env BOLLOON_AGENT_AUTHORIZED=1)', policyWhenOn.agentAuthorized === true && policyWhenOn.source.includes('env'), policyWhenOn.source);
  const authorized = await sendChainTxGuarded({
    client, intent: { ...intentFor('releaseV2', taskKeyA), intentNonce: 'dry-run' }, home: HOME, env: process.env as any, signer: agent,
    execute: async () => 'dry-run-ok',
  });
  check('授权后放行 (dry-run 不真的发交易; 用 intentNonce 避免占用真意图的幂等键)', authorized.allowed === true, `requestId=${authorized.auth.requestId}`);

  section('④ 真交易闭环: createEscrowV2 → submitProofV2 → releaseV2 (走放行闸)');
  // 冻结口径: resultHash/inputHash/manifestHash = keccak256(utf8("sha256:<hex>"))
  const sha256DigestOf = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
  const contentHashOf = (s: string) => CHAIN.computeResultHashOffChain(sha256DigestOf(s));
  const args = {
    termsHash: contentHashOf(`terms:${taskIdA}`),
    quoteHash: contentHashOf(`quote:${taskIdA}`),
    inputHash: contentHashOf(`input:${taskIdA}`),
    manifestHash: contentHashOf(`manifest:${taskIdA}`),
    resultHash: contentHashOf(`result:${taskIdA}`),
    proofVersion: 1,
  };
  // 交叉核对: resultHash 链上复算必须一致
  const onChainResultHash = await client.computeResultHash(sha256DigestOf(`result:${taskIdA}`));
  check('resultHash: 链下复算 == 链上 computeResultHash()', String(onChainResultHash).toLowerCase() === args.resultHash.toLowerCase(), args.resultHash);

  const latestTs = BigInt((await provider.getBlock('latest'))!.timestamp);
  const deadline = latestTs + 3600n;

  // 真事件监听: 在发交易之前挂上, 收到的必须是真链事件
  let listened: any = null;
  const offReleased = client.onReleasedV2((a: any) => { listened = a; }, { taskKey: taskKeyA });

  const escrowBefore = await client.getEscrow(taskKeyA);
  console.log(`  创建前 escrow: ${escrowBefore ? escrowBefore.stateName : '(不存在)'}`);
  const agentBalBefore = await token.balanceOf(agent.address);

  // (1) createEscrowV2
  const createIntent = intentFor('createEscrowV2', taskKeyA, AMOUNT.toString());
  const createRes = await sendChainTxGuarded({
    client, intent: createIntent, home: HOME, env: process.env as any, signer: buyer,
    execute: (signer: any) => client.createEscrowV2({
      taskKey: taskKeyA, agent: agent.address, amount: AMOUNT, paymentAsset: tokenAddr,
      termsHash: args.termsHash, quoteHash: args.quoteHash, inputHash: args.inputHash, manifestHash: args.manifestHash,
      deadline, confirmationWindow: 3600, proofVersion: args.proofVersion,
    }, signer),
  });
  const createOut = createRes.outcome;
  console.log(`  (1) createEscrowV2  tx=${createOut?.txHash}  block=${createOut?.blockNumber}  gas=${createOut?.gasUsed}  status=${createOut?.status}`);
  check('createEscrowV2: 真发出去并成功 (receipt.status==1)', createOut?.broadcast === true && createOut?.status === 1, createOut?.txHash);
  check('createEscrowV2: 审计写了一条 (只记摘要)', createRes.auditWritten === true);
  const afterCreate = await client.getEscrow(taskKeyA);
  check('create 后链上状态 = ACTIVE', afterCreate?.stateName === 'ACTIVE', afterCreate?.stateName);

  // (2) submitProofV2
  const proofRes = await sendChainTxGuarded({
    client, intent: intentFor('submitProofV2', taskKeyA), home: HOME, env: process.env as any, signer: agent,
    execute: (signer: any) => client.submitProofV2(taskKeyA, args.resultHash, args.manifestHash, args.proofVersion, signer),
  });
  const proofOut = proofRes.outcome;
  console.log(`  (2) submitProofV2   tx=${proofOut?.txHash}  block=${proofOut?.blockNumber}  gas=${proofOut?.gasUsed}  status=${proofOut?.status}`);
  check('submitProofV2: 真发出去并成功', proofOut?.broadcast === true && proofOut?.status === 1, proofOut?.txHash);
  const escrowProof = await client.getEscrow(taskKeyA);
  const onChainProofHash = await client.computeProofHash(args.resultHash, args.proofVersion);
  check('链上存入的 proofHash == 链上复算口径', String(escrowProof?.proofHash).toLowerCase() === String(onChainProofHash).toLowerCase(), escrowProof?.proofHash);

  // (3) releaseV2
  const relRes = await sendChainTxGuarded({
    client, intent: intentFor('releaseV2', taskKeyA), home: HOME, env: process.env as any, signer: buyer,
    execute: (signer: any) => client.releaseV2(taskKeyA, signer),
  });
  const relOut = relRes.outcome;
  console.log(`  (3) releaseV2       tx=${relOut?.txHash}  block=${relOut?.blockNumber}  gas=${relOut?.gasUsed}  status=${relOut?.status}`);
  check('releaseV2: 真发出去并成功', relOut?.broadcast === true && relOut?.status === 1, relOut?.txHash);
  const afterRelease = await client.getEscrow(taskKeyA);
  const agentBalAfter = await token.balanceOf(agent.address);
  check('release 后链上状态 = RELEASED', afterRelease?.stateName === 'RELEASED', afterRelease?.stateName);
  check('资金真到账 agent (+' + formatUnits(AMOUNT, decimals) + ')', agentBalAfter - agentBalBefore === AMOUNT, `delta=${agentBalAfter - agentBalBefore}`);

  // 真 receipt 里解码 3 个 v2 事件
  const decodeSafe = (outcome: any, name: string) => (outcome ? client.decodeV2Events(outcome, name) : []);
  const decodedCreate = decodeSafe(createOut, 'EscrowCreatedV2');
  const decodedProof = decodeSafe(proofOut, 'ProofSubmittedV2');
  const decodedRelease = decodeSafe(relOut, 'ReleasedV2');
  check('receipt 里有 EscrowCreatedV2 且 taskKey 对得上', decodedCreate.length === 1 && decodedCreate[0].args.taskKey === taskKeyA, decodedCreate.length);
  check('receipt 里有 ProofSubmittedV2 且 resultHash 对得上', decodedProof.length === 1 && String(decodedProof[0].args.resultHash).toLowerCase() === args.resultHash.toLowerCase());
  check('receipt 里有 ReleasedV2 且 by==0 (buyer 释放)', decodedRelease.length === 1 && Number(decodedRelease[0].args.by) === 0);

  // 真事件监听 (等真链事件; 超时如实报)
  const waited = listened ? { args: listened } : await (async () => {
    const got = await client.waitForV2Event('ReleasedV2', { taskKey: taskKeyA, timeoutMs: 8000 });
    return got ? { args: got.args } : null;
  })();
  const bjson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const waitedDetail = waited ? bjson(waited.args) : '未收到 (超时)';
  check('5 个 v2 事件监听: 真收到 ReleasedV2 (taskKey/amount/by 都对)', !!waited && waited.args.taskKey === taskKeyA && BigInt(waited.args.amount) === AMOUNT && Number(waited.args.by) === 0, waitedDetail);
  offReleased();

  section('⑤ 确认数门: 不足不判 verified, 够了才判');
  const relTx: string = relOut?.txHash || '';
  const verify = createChainSettlementVerifier(client);
  const lowGate = await verify({ txHash: relTx, expect: { kind: 'escrow', taskKey: taskKeyA, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' }, gate: 'confirmed', recorded: undefined });
  console.log(`  [默认门槛 confirmed=1] status=${lowGate.status} confirmations=${lowGate.confirmations} chainSettled=${lowGate.chainSettled}`);
  check('确认数够默认门槛 → chainSettled=true', lowGate.chainSettled === true && (lowGate.status === 'confirmed' || lowGate.status === 'finalized'), lowGate.status);

  const strict = await verifyChainSettlement(client, {
    txHash: relTx,
    expect: { kind: 'escrow', taskKey: taskKeyA, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' },
    confirmations: { confirmed: 500, finalized: 1000 }, // 真链上此刻不可能有 500 个确认
  });
  console.log(`  [抬高门槛 confirmed=500] status=${strict.status} confirmations=${strict.confirmations}/${strict.confirmationsRequired} chainSettled=${strict.chainSettled}`);
  check('★ 确认数不足时不判 verified (pending, chainSettled=false)', strict.chainSettled === false && strict.status === 'pending', strict.reason);

  section('⑥ 反假阳性: 同一 txHash, 期望不符 → 绝不判已结算');
  const wrongKey = computeTaskKeyOffChain(`not-ours-${runId}`);
  const mismatch = await verify({ txHash: relTx, expect: { kind: 'escrow', taskKey: wrongKey } });
  check('★ taskKey 对不上 → event_mismatch, chainSettled=false', mismatch.chainSettled === false && mismatch.status === 'event_mismatch', mismatch.status);
  const evOnly = await verify({ txHash: relTx, expect: { kind: 'escrow', taskKey: taskKeyA, eventName: 'RefundedV2' } });
  check('★ 事件名对不上 (要求 RefundedV2) → 不判已结算', evOnly.chainSettled === false && evOnly.status === 'event_mismatch', evOnly.reason);
  const revertedTx = manifestRevertedTx();
  if (revertedTx) {
    const rev = await verify({ txHash: revertedTx, expect: { kind: 'escrow', taskKey: taskKeyA } });
    const revAny = rev.status === 'reverted' ? rev : await verify({ txHash: revertedTx });
    check('★ receipt 失败 (status=0) 的真交易 → reverted, chainSettled=false', revAny.chainSettled === false && (revAny.status === 'reverted' || revAny.status === 'unknown'), revAny.status);
  } else {
    console.log('  (manifest 里没有 status=0 的交易记录 → 跳过 receipt 失败用例)');
  }

  section('⑥b 真链 claimAfterTimeoutV2 (无 proof → 真 revert, status 0 不算结算)');
  const taskIdC = `bolloon-chainbridge-C-${runId}`;
  const taskKeyC = computeTaskKeyOffChain(taskIdC);
  const nowTsC = BigInt((await provider.getBlock('latest'))!.timestamp); // 当场读
  const mkC = {
    termsHash: contentHashOf(`terms:${taskIdC}`), quoteHash: contentHashOf(`quote:${taskIdC}`),
    inputHash: contentHashOf(`input:${taskIdC}`), manifestHash: contentHashOf(`manifest:${taskIdC}`),
  };
  const rC1 = await sendChainTxGuarded({
    client, intent: intentFor('createEscrowV2', taskKeyC, AMOUNT.toString()), home: HOME, env: process.env as any, signer: buyer,
    execute: (signer: any) => client.createEscrowV2({
      taskKey: taskKeyC, agent: agent.address, amount: AMOUNT, paymentAsset: tokenAddr,
      // ★ 必须**当场**读块时间且留出余量: anvil 每个新块时间戳 = max(prev+1, 墙上时钟),
      //   所以 deadline == prev 块时间戳 会立刻变成 "deadline in past"。这里 +10s, 下面再 warp 300s 越过窗口。
      termsHash: mkC.termsHash, quoteHash: mkC.quoteHash, inputHash: mkC.inputHash, manifestHash: mkC.manifestHash,
      deadline: nowTsC + 10n, confirmationWindow: 60, proofVersion: 1,
    }, signer),
  });
  check('escrow C: createEscrowV2 真上链', rC1.outcome?.status === 1, rC1.outcome?.txHash || rC1.outcome?.error || rC1.reason);

  // 时间旅行越过 deadline + confirmationWindow (anvil 支持)
  let warped = true;
  try { await provider.send('evm_increaseTime', [300]); await provider.send('evm_mine', []); } catch { warped = false; }
  const cState = await client.getEscrow(taskKeyC);
  const claimable = await client.claimableAt(taskKeyC);
  const nowTs = BigInt((await provider.getBlock('latest'))!.timestamp);
  console.log(`  now=${nowTs} claimableAt(C)=${claimable} 已超时=${nowTs >= claimable} 状态=${cState?.stateName}`);

  // 静态调用先读 revert reason
  const staticClaim = await client.staticCallClaimAfterTimeout(taskKeyC, agent.address);
  check('★ 静态调用 claimAfterTimeoutV2(无 proof) 真 revert 且理由是 no proof submitted',
    staticClaim.ok === false && String(staticClaim.reason).includes('no proof submitted'), `reason=${staticClaim.reason} (warped=${warped})`);

  // 真发一笔必然失败的 claim (显式 gasLimit 绕过 estimateGas 预检)
  const claimIntent = intentFor('claimAfterTimeoutV2', taskKeyC);
  const claimRes = await sendChainTxGuarded({
    client, intent: claimIntent, home: HOME, env: process.env as any, signer: agent,
    execute: async (signer: any) => {
      const c = client.contractWith(signer);
      try {
        const tx = await c.claimAfterTimeoutV2(taskKeyC, { gasLimit: 300_000 });
        const rc = await tx.wait();
        return { txHash: tx.hash, status: Number(rc.status), broadcast: true, reverted: Number(rc.status) === 0, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed?.toString() ?? null, logs: rc.logs ?? [] };
      } catch (e: any) {
        const rc = e?.receipt;
        return { txHash: e?.transaction?.hash || e?.receipt?.hash || '', status: rc ? Number(rc.status) : null, broadcast: !!rc, reverted: rc ? Number(rc.status) === 0 : false, blockNumber: rc?.blockNumber ?? null, gasUsed: rc?.gasUsed?.toString() ?? null, logs: rc?.logs ?? [], error: String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 200) };
      }
    },
  });
  const claimOut = claimRes.outcome;
  console.log(`  claimAfterTimeoutV2 tx=${claimOut?.txHash} block=${claimOut?.blockNumber} status=${claimOut?.status} err=${String(claimOut?.error || '').slice(0, 60)}`);
  check('★ 真发 claimAfterTimeoutV2 → 真交易 status==0 (reverted)', claimOut?.broadcast === true && claimOut?.status === 0, `status=${claimOut?.status}`);
  const claimVerdict = await verifyChainSettlement(client, { txHash: claimOut?.txHash || '', expect: { kind: 'escrow', taskKey: taskKeyC } });
  check('★ 这笔真 reverted 的交易 → 判定 reverted, chainSettled=false (不因为它有 txHash 就算结算)',
    claimVerdict.chainSettled === false && claimVerdict.status === 'reverted', claimVerdict.status);
  const cAfterClaim = await client.getEscrow(taskKeyC);
  check('★ revert 后资金未动: escrow C 仍 ACTIVE', cAfterClaim?.stateName === 'ACTIVE', cAfterClaim?.stateName);

  section('⑦ 真重组 (anvil_rollback): 已上链的交易被回滚 → 必须判 reorged');
  const taskIdB = `bolloon-chainbridge-B-${runId}`;
  const taskKeyB = computeTaskKeyOffChain(taskIdB);
  const mkB = {
    termsHash: contentHashOf(`terms:${taskIdB}`), quoteHash: contentHashOf(`quote:${taskIdB}`),
    inputHash: contentHashOf(`input:${taskIdB}`), manifestHash: contentHashOf(`manifest:${taskIdB}`),
    resultHash: contentHashOf(`result:${taskIdB}`), proofVersion: 1,
  };
  const rB1 = await sendChainTxGuarded({
    client, intent: intentFor('createEscrowV2', taskKeyB, AMOUNT.toString()), home: HOME, env: process.env as any, signer: buyer,
    execute: (signer: any) => client.createEscrowV2({
      taskKey: taskKeyB, agent: agent.address, amount: AMOUNT, paymentAsset: tokenAddr,
      termsHash: mkB.termsHash, quoteHash: mkB.quoteHash, inputHash: mkB.inputHash, manifestHash: mkB.manifestHash,
      deadline, confirmationWindow: 3600, proofVersion: 1,
    }, signer),
  });
  const rB2 = await sendChainTxGuarded({
    client, intent: intentFor('submitProofV2', taskKeyB), home: HOME, env: process.env as any, signer: agent,
    execute: (signer: any) => client.submitProofV2(taskKeyB, mkB.resultHash, mkB.manifestHash, 1, signer),
  });
  const rB3 = await sendChainTxGuarded({
    client, intent: intentFor('releaseV2', taskKeyB), home: HOME, env: process.env as any, signer: buyer,
    execute: (signer: any) => client.releaseV2(taskKeyB, signer),
  });
  const topTx = rB3.outcome;
  const topTxHash: string = topTx?.txHash || '';
  console.log(`  escrow B 三笔: create=${rB1.outcome?.txHash} proof=${rB2.outcome?.txHash} release=${topTxHash} (block ${topTx?.blockNumber})`);
  const beforeReorg = await verify({ txHash: topTxHash, expect: { kind: 'escrow', taskKey: taskKeyB, eventName: 'ReleasedV2' } });
  check('重组前: B 的 release 判已结算', beforeReorg.chainSettled === true, beforeReorg.status);

  let reorgSupported = true;
  try {
    await provider.send('anvil_rollback', [1]);
  } catch (e: any) {
    reorgSupported = false;
    console.log(`  ⚠ 该 RPC 不支持 anvil_rollback (${String(e?.message || e).slice(0, 80)}) → 改用注入式重组 (标注清楚)`);
  }
  const blockAfterReorg = await provider.getBlockNumber();
  console.log(`  回滚后 latestBlock=${blockAfterReorg}`);
  if (reorgSupported) {
    const afterReorg = await verifyChainSettlement(client, {
      txHash: topTxHash,
      expect: { kind: 'escrow', taskKey: taskKeyB, eventName: 'ReleasedV2' },
      recorded: { blockNumber: topTx?.blockNumber, confirmations: 1, status: 'confirmed' }, // 旧事实: 曾在那个块确认过
    });
    console.log(`  重组后判定: status=${afterReorg.status}  ${afterReorg.reason}`);
    check('★ 真重组: 交易被回滚 → reorged, chainSettled=false (不静默当已结算)', afterReorg.chainSettled === false && afterReorg.status === 'reorged', afterReorg.status);
    const bState = await client.getEscrow(taskKeyB);
    check('★ 真重组: 链上 escrow B 状态也回退了 (不再是 RELEASED)', bState?.stateName !== 'RELEASED', bState?.stateName);
  } else {
    const afterReorg = await verify({ txHash: topTxHash, expect: { kind: 'escrow', taskKey: taskKeyB }, recorded: { blockNumber: (topTx?.blockNumber ?? 0) - 1, status: 'confirmed' } });
    check('(注入式) 同一 txHash 曾被记在另一个块 → reorged, chainSettled=false', afterReorg.chainSettled === false && afterReorg.status === 'reorged', afterReorg.status);
  }

  section('⑧ 掉 RPC: 如实报「不知道」, 绝不冒报已结算');
  // (a) 明确掉线的 provider (每次读数都抛连接错误)
  const deadClient = new EscrowClient({
    escrowAddress: dep.escrowAddress,
    provider: { getTransactionReceipt: async () => { throw new Error('ECONNREFUSED 127.0.0.1:9'); } } as any,
  });
  const dead = await verifyChainSettlement(deadClient, { txHash: relTx, expect: { kind: 'escrow', taskKey: taskKeyA } });
  console.log(`  status=${dead.status} rpcAvailable=${dead.rpcAvailable}  ${dead.reason}`);
  check('★ RPC 不可用 → unknown + rpcAvailable=false + chainSettled=false', dead.chainSettled === false && dead.status === 'unknown' && dead.rpcAvailable === false, dead.status);
  const noHash = await verify({ txHash: '' });
  check('没有 txHash → not_attempted (从不"有 hash 就算结算")', noHash.chainSettled === false && noHash.status === 'not_attempted', noHash.status);

  // (b) 真·连不通的端口 (JsonRpcProvider 会一直重试网络探测 → 用超时兜住, 不许它把脚本挂住)
  const unreachableProvider = createJsonRpcProvider('http://127.0.0.1:9');
  const unreachableClient = new EscrowClient({ escrowAddress: dep.escrowAddress, provider: unreachableProvider });
  const raceRes: any = await Promise.race([
    verifyChainSettlement(unreachableClient, { txHash: relTx }).catch((e: any) => ({ chainSettled: false, status: 'unknown', reason: String(e?.message || e) })),
    new Promise((r) => setTimeout(() => r('__timeout__'), 6000)),
  ]);
  try { (unreachableProvider as any).destroy?.(); } catch { /* noop */ }
  if (raceRes === '__timeout__') {
    check('★ 真连不通的 RPC (127.0.0.1:9): 6s 内没有给出"已结算"→ 超时不计为已结算', true, 'timeout ≠ settled');
  } else {
    check('★ 真连不通的 RPC (127.0.0.1:9) → 不判已结算', raceRes.chainSettled === false, `${raceRes.status}: ${String(raceRes.reason).slice(0, 80)}`);
  }

  section('⑨ 落盘 / 重启恢复 / 重组对账');
  // A: 已确认 (真实链上仍然成立)   B: 曾记在块 82 已确认, 但那块已被 anvil_rollback 回滚掉
  const ridA = chainRequestIdOf({ method: 'releaseV2', taskKey: taskKeyA, amountAtomic: '0' }, chainId);
  const ridB = chainRequestIdOf({ method: 'releaseV2', taskKey: taskKeyB, amountAtomic: '0' }, chainId);
  const recBase = { requestId: ridA, method: 'releaseV2' as const, taskKey: taskKeyA, escrowAddress: dep.escrowAddress, chainId, txHash: relTx };
  await recordVerdict(recBase, lowGate, HOME);
  await recordVerdict({ ...recBase, requestId: ridB, taskKey: taskKeyB, txHash: topTxHash }, beforeReorg, HOME);

  const statePath = chainStatePath(HOME);
  check('关键状态已落盘 (escrow/txHash/taskKey/确认数/最后检查块)', fs.existsSync(statePath), statePath);
  const persisted = loadChainState(HOME);
  const one = persisted.records[ridA] as any;
  check('落盘记录含 escrowAddress/txHash/taskKey/confirmations/lastCheckedBlock', !!one?.escrowAddress && !!one?.txHash && !!one?.taskKey && one?.confirmations >= 0 && one?.lastCheckedBlock != null, JSON.stringify({ escrow: one?.escrowAddress, confirmations: one?.confirmations, lastCheckedBlock: one?.lastCheckedBlock }));

  // ★ 重启恢复: 只读盘, 不联网
  const rec1 = recoverChainState(HOME);
  console.log(`  重启恢复 (纯读盘): total=${rec1.total} settled=${rec1.settled.length} pending=${rec1.pending.length} reorged=${rec1.reorged.length} unknown=${rec1.unknown.length} suspect=${rec1.suspect.length}`);
  check('重启恢复能从持久记录重建 (2 条都先记为已确认)', rec1.total === 2 && rec1.settled.length === 2, `settled=${rec1.settled.length}`);

  // ★ 真对账: 拿持久记录里的旧事实去链上复核 → B 的那笔已经被回滚, 必须翻成 reorged + 不可信
  const rep = await reconcileChainState(client, { home: HOME });
  console.log(`  对账 (reconcileChainState): scanned=${rep.scanned} confirmed=${rep.confirmed.length} reorged=${rep.reorged.length} pending=${rep.pending.length} unknown=${rep.unknown.length} newlySuspect=${JSON.stringify(rep.newlySuspect)}`);
  check('★ 对账把被回滚的交易标为 reorged', rep.reorged.some((r: any) => r.taskKey === taskKeyB), `reorged=${rep.reorged.length}`);
  check('★ 对账把这条标为不可信 (suspect)', rep.newlySuspect.includes(ridB) || getSuspect(ridB), `newlySuspect=${JSON.stringify(rep.newlySuspect)}`);
  check('★ 对账后仍然成立的那条保持已确认', rep.confirmed.some((r: any) => r.taskKey === taskKeyA), `confirmed=${rep.confirmed.length}`);
  const rec2 = recoverChainState(HOME);
  check('★ 被标重组的记录绝不算 settled', !rec2.settled.some((r: any) => r.taskKey === taskKeyB) && rec2.reorged.some((r: any) => r.taskKey === taskKeyB), `settled=${rec2.settled.length} reorged=${rec2.reorged.length}`);
  await markSuspect(ridB, '端到端验收: 重组复核', HOME);
  check('显式 markSuspect 生效 (suspect=true)', recoverChainState(HOME).suspect.some((r: any) => r.requestId === ridB), true);

  section('⑩ 签名审计 (只记摘要, 无正文无私钥)');
  const auditPath = path.join(HOME, '.bolloon', 'wallet-signatures.jsonl');
  check('审计文件已写', fs.existsSync(auditPath), auditPath);
  let rows: any[] = [];
  try { rows = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* 没有 */ }
  const dumped = JSON.stringify(rows);
  check('审计条目数 >= 3 (create/submit/release)', rows.length >= 3, `rows=${rows.length}`);
  check('★ 审计里没有私钥', !dumped.includes(privateKey) && !dumped.toLowerCase().includes(privateKey.toLowerCase().slice(2)), `可能泄漏 ${privateKey.length} 字符`);
  check('★ 审计里没有任务正文 (digest 之类的字段也检查)', !rows.some((r) => Object.keys(r).some((k) => ['instruction', 'taskText', 'raw', 'payload', 'content'].includes(k))));
  console.log(`  审计样例: ${JSON.stringify(rows[rows.length - 1]).slice(0, 200)}`);

  // 恢复被删掉的环境变量, 免得影响同进程后续
  process.env = savedEnv;

  section('汇总');
  console.log(`  真 txHash (escrow A):`);
  console.log(`    createEscrowV2 : ${createOut?.txHash} (block ${createOut?.blockNumber})`);
  console.log(`    submitProofV2  : ${proofOut?.txHash} (block ${proofOut?.blockNumber})`);
  console.log(`    releaseV2      : ${relTx} (block ${relOut?.blockNumber})`);
  console.log(`  真 txHash (escrow B, 重组用):`);
  console.log(`    releaseV2      : ${topTxHash} (block ${topTx?.blockNumber})`);
  console.log(`  current-status 检查点: latestBlock=${await provider.getBlockNumber()}`);
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) {
    console.log(`  ❌ 失败项:`);
    failures.forEach((f) => console.log(`     - ${f}`));
  } else {
    console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);
  }

  // 收尾: 摘监听 + 销毁 provider (否则事件轮询/网络重试会吊住进程)
  try { client.removeAllListeners(); } catch { /* noop */ }
  try { (provider as any).destroy?.(); } catch { /* noop */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[verify-chain-bridge] 失败:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
