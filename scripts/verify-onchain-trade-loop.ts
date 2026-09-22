/**
 * verify-onchain-trade-loop.ts — P4「任务交易闭环」真链端到端验收
 * =========================================================================
 * 对着**正在运行的本地 anvil** (chainId 31337) 跑真闭环, 不是读代码:
 *
 *   [A] buyer createEscrowV2 (v2 字段 + M1 金额 0.02 USDC)   ← 真签名/真交易/真 receipt
 *   [B] 真执行 (装技能 → 跑技能 → 契约校验) → resultHash = keccak256(utf8("sha256:<hex>"))
 *   [C] seller submitProofV2 (resultHash + proofVersion)      ← 每一步都走 verifyPaymentOnChain
 *   [D] buyer releaseV2 → 只有 chainSettled=true 才把交易标 verified
 *   [负例] 资金不足 / 确认数不够 / release 前重组 / 事件不匹配 / local-dev
 *   [恢复] create 后执行失败 / submitProof 后 release 前崩溃 / release 时读数不可用
 *
 * 跑法:
 *   # 终端 A
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1
 *   # 终端 B (先 `cd contracts/evm && node scripts/deploy.js` 保证 localhost.json 是当前 artifact)
 *   npx tsx scripts/verify-onchain-trade-loop.ts
 *
 * 地址解析: env → ~/.bolloon/chain.json → contracts/deployments/localhost.json (绝不 hardcode 合约地址)
 * 钱包解析: env (BOLLOON_WALLET_PRIVATE_KEY / AGENT_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)
 *           → ~/.bolloon/wallet.json → **仅 chainId==31337** 用 anvil 公开开发助记符派生
 *           (公开文档值, 零资产; 别的链一律拒绝)
 *
 * 隔离: 全程写到一个**临时 HOME** (链上记录 / 交易记录 / 签名审计), 不污染真实 ~/.bolloon;
 *       同时把「标准路径」与临时路径都打印出来对照。
 * 私钥: 只在进程内局部变量与**进程环境变量**里存在, 绝不落盘/打印/提交。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HDNodeWallet, Mnemonic, Wallet, Contract, formatUnits } from 'ethers';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p4-trade-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_AGENT_AUTHORIZED = '1';    // 放行闸的授权来源之一 (本机策略, 进程内)
process.env.BOLLOON_SKIP_SETUP = '1';

const CHAIN: any = await import('../src/agents/chain/index.js');
const OT: any = await import('../src/agents/chain/onchain-trade.js');
const TR: any = await import('../src/agents/task/task-runner.js');
const RC: any = await import('../src/agents/x402/resource-contract.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const SS: any = await import('../src/agents/x402/settlement-state.js');
const PIP: any = await import('../src/agents/x402/paid-info-protocol.js');
const TP: any = await import('../src/agents/x402/transaction-protocol.js');

const { verifyPaymentOnChain } = await import('../src/agents/x402/paid-info-store.js') as any;
const {
  EscrowClient, createJsonRpcProvider, verifyChainSettlement, computeTaskKeyOffChain,
  recoverOnchainTrade, chainStatePath, loadChainState, recordVerdict, DEFAULT_CONFIRMATIONS, LOCAL_DEV_CHAIN_ID,
  readChainSigningPolicy, walletAvailable,
} = CHAIN as any;

// ── 断言 / 输出 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).slice(0, 240);
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  return ok;
};
const section = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const bjson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

// ── 部署 / 钱包解析 (绝不 hardcode) ──────────────────────────────────────────
function resolveDeployment(): { chainId: number; escrowAddress: string; tokenAddress: string | null; source: string } {
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
    if (escrow?.address) return { chainId: Number(m.chainId), escrowAddress: escrow.address, tokenAddress: m.externalToken?.address || m.token?.address || null, source: `manifest ${manifestPath}` };
  }
  throw new Error(`解析不到 escrow 地址: env BOLLOON_ESCROW_ADDRESS → ${chainJson} → contracts/deployments/localhost.json`);
}

function resolveWalletKey(chainId: number, which: 'buyer' | 'agent'): { privateKey: string; source: string } {
  const envKey = which === 'agent'
    ? (process.env.AGENT_PRIVATE_KEY || process.env.BOLLOON_AGENT_PRIVATE_KEY)
    : (process.env.BOLLOON_WALLET_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY);
  if (envKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(envKey)) throw new Error(`env 里的 ${which} 私钥格式不对`);
    return { privateKey: envKey, source: `env (${which})` };
  }
  const wf = path.join(HOME, '.bolloon', 'wallet.json');
  if (fs.existsSync(wf)) {
    const j = JSON.parse(fs.readFileSync(wf, 'utf8'));
    if (/^0x[0-9a-fA-F]{64}$/.test(String(j.privateKey || ''))) return { privateKey: j.privateKey, source: wf };
  }
  if (chainId !== LOCAL_DEV_CHAIN_ID) {
    throw new Error(`没有可用钱包, 且 chainId=${chainId} 不是本地开发链 → 拒绝用公开开发助记符签真链`);
  }
  const m = Mnemonic.fromPhrase('test test test test test test test test test test test junk');
  const idx = which === 'agent' ? "m/44'/60'/0'/0/1" : "m/44'/60'/0'/0/0";
  return { privateKey: HDNodeWallet.fromMnemonic(m, idx).privateKey, source: `anvil 公开开发助记符 (chainId=${chainId}; 零资产非真实钱包)` };
}

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
];

const TASK = '判断这款厨房用品是否适合进入日本市场';
const FIXTURES = path.resolve('scripts/fixtures/skills');
const SKILL = 'cross-border-market-research';
/** M1 硬约束: 单任务 0.05 / 单次购买 0.02 USDC (6 位精度 → 20000 原子) */
const AMOUNT = 20_000n;
const TASK_BUDGET = 0.05;
const PER_PURCHASE = 0.02;

// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const RPC_URL = process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545';
  const dep = resolveDeployment();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  section('① 接链 (真 JsonRpcProvider cacheTimeout:-1) + 部署/资产解析');
  const provider = createJsonRpcProvider(RPC_URL);
  (provider as any).pollingInterval = 250;
  let net: any;
  try { net = await provider.getNetwork(); } catch (e: any) {
    console.log(`  ❌ 连不上 ${RPC_URL}: ${e.message}`);
    console.log(`  提示: DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1`);
    process.exit(1);
  }
  const chainId = Number(net.chainId);
  const latest = await provider.getBlock('latest');
  console.log(`  RPC=${RPC_URL}  chainId=${chainId}  latestBlock=${latest?.number}`);
  console.log(`  escrow=${dep.escrowAddress}  (来源: ${dep.source})`);
  console.log(`  隔离 HOME=${HOME}`);
  console.log(`  链上状态文件(本次)=${chainStatePath(HOME)}`);
  console.log(`  链上状态文件(标准 ~)=${chainStatePath(REAL_HOME)}`);
  check('chainId == 31337 (本地开发链, 才允许用开发密钥)', chainId === LOCAL_DEV_CHAIN_ID, chainId);
  if (chainId !== LOCAL_DEV_CHAIN_ID) { console.log('  拒绝在非本地链上跑本脚本 (它用 anvil 开发密钥签名)。'); process.exit(1); }

  const { privateKey: buyerKey, source: buyerSrc } = resolveWalletKey(chainId, 'buyer');
  const { privateKey: agentKey, source: agentSrc } = resolveWalletKey(chainId, 'agent');
  // ★ 放行闸要求的"本机钱包"落在**进程环境变量**里 (不落盘/不打印); 买方交易走的就是这条真实路径
  process.env.BOLLOON_WALLET_PRIVATE_KEY = buyerKey;
  const policy = readChainSigningPolicy({ home: HOME, env: process.env as any });
  const w = walletAvailable({ home: HOME, env: process.env as any });
  console.log(`  买方钱包来源=${buyerSrc} · 卖方钱包来源=${agentSrc}`);
  console.log(`  放行策略=${policy.source} · 钱包可用=${w.available} (${w.source})`);
  check('签名放行闸: 已授权且本机钱包可用', policy.agentAuthorized === true && w.available === true, { policy: policy.source, wallet: w.source });

  const client = new EscrowClient({
    config: {
      chainId, networkName: 'localhost', rpcUrl: RPC_URL, escrowAddress: dep.escrowAddress,
      tokenAddress: dep.tokenAddress, tokenDecimals: 6, confirmations: DEFAULT_CONFIRMATIONS, sources: {},
    },
  });
  const code = await provider.getCode(dep.escrowAddress);
  check('escrow 地址上有 bytecode', typeof code === 'string' && code.length > 2, `${(String(code).length - 2) / 2} bytes`);
  const onChainVersion = await client.contractVersion();
  const tokenAddr: string = dep.tokenAddress || (await client.tokenAddress());
  const token = new Contract(tokenAddr, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  const symbol = await token.symbol();
  console.log(`  AgentEscrow.CONTRACT_VERSION=${onChainVersion}  token=${symbol}@${tokenAddr} decimals=${decimals}`);
  check('token decimals == 6 (USDC 口径)', decimals === 6, decimals);

  const buyer = new Wallet(buyerKey, provider);
  const agent = new Wallet(agentKey, provider);
  console.log(`  buyer=${buyer.address}  agent=${agent.address}`);

  // ── ② M1 预算硬约束 ────────────────────────────────────────────────────────
  section('② M1 预算硬约束: 单任务 0.05 / 单次购买 0.02 (金额与链上托管一致)');
  const okBudget = OT.checkOnchainAmount({ amountAtomic: AMOUNT, decimals, budget: { taskBudget: TASK_BUDGET, perPurchase: PER_PURCHASE } });
  console.log(`  本次托管金额 = ${okBudget.amountUsdc} USDC (${AMOUNT} 原子)`);
  check('0.02 USDC 通过 M1 预算门', okBudget.ok === true, okBudget.reason);
  const tooBig = OT.checkOnchainAmount({ amountAtomic: 30_000n, decimals, budget: { taskBudget: TASK_BUDGET, perPurchase: PER_PURCHASE } });
  check('0.03 USDC 被单次上限拦下 (指明哪一层)', tooBig.ok === false && tooBig.layer === 'perPurchase', `${tooBig.layer}: ${tooBig.reason}`);
  const narrow = OT.checkOnchainAmount({ amountAtomic: AMOUNT, decimals, budget: { taskBudget: 0.01 } });
  check('任务预算收窄到 0.01 时 0.02 被拦下', narrow.ok === false, `${narrow.layer}: ${narrow.reason}`);

  // ── ③ 资金/授权准备 (真交易) ───────────────────────────────────────────────
  section('③ 资金与授权准备 (真 tx)');
  const bal0 = await token.balanceOf(buyer.address);
  if (bal0 < AMOUNT * 3n) {
    try {
      const t = await token.connect(buyer).mint(buyer.address, AMOUNT * 20n);
      const rc = await t.wait();
      console.log(`  mint tx=${t.hash} block=${rc?.blockNumber} status=${rc?.status}`);
    } catch (e: any) {
      console.log(`  ⚠ mint 不可用 (${String(e?.shortMessage || e?.message).slice(0, 90)}) —— 外部 token 不给 mint 时只能靠已有余额`);
    }
  }
  const allow0 = await token.allowance(buyer.address, dep.escrowAddress);
  if (allow0 < AMOUNT * 3n) {
    const t = await token.connect(buyer).approve(dep.escrowAddress, AMOUNT * 20n);
    const rc = await t.wait();
    console.log(`  approve tx=${t.hash} block=${rc?.blockNumber} status=${rc?.status}`);
  }
  const bal1 = await token.balanceOf(buyer.address);
  const allow1 = await token.allowance(buyer.address, dep.escrowAddress);
  check('buyer 余额 >= 3×0.02 且已授权 escrow', bal1 >= AMOUNT * 3n && allow1 >= AMOUNT, { balance: bal1.toString(), allowance: allow1.toString() });

  // ── ④ 真闭环 ───────────────────────────────────────────────────────────────
  section('④ 真闭环: createEscrowV2 → 真执行技能 → submitProofV2 → releaseV2 → 标 verified');
  const taskId = `bolloon-p4-trade-${runId}`;
  const taskKey = computeTaskKeyOffChain(taskId);
  const onChainKey = await client.computeTaskKey(taskId);
  check('taskKey 链下复算 == 链上 computeTaskKey()', String(onChainKey).toLowerCase() === taskKey.toLowerCase(), taskKey);
  console.log(`  taskId=${taskId}`);
  console.log(`  taskKey=${taskKey}`);

  const deadline = BigInt(Math.max(Number(latest!.timestamp), Math.floor(Date.now() / 1000))) + 3600n;
  const requestId = `p4-onchain-trade-${runId}`;
  const tradeReq: any = {
    client, home: HOME, taskId, agentAddress: agent.address, amountAtomic: AMOUNT, paymentAsset: tokenAddr,
    termsDigest: OT.sha256Digest(`terms:${taskId}`),
    quoteDigest: OT.sha256Digest(`quote:${taskId}`),
    inputDigest: OT.sha256Digest(`input:${taskId}`),
    manifestDigest: OT.sha256Digest(`manifest:${taskId}`),
    proofVersion: 1,
    deadline, confirmationWindow: 3600, network: 'localhost', tokenDecimals: decimals,
    budget: { taskBudget: TASK_BUDGET, perPurchase: PER_PURCHASE },
    // 买方交易**注入 signer 之外**也走放行闸: 这里给 Wallet 是因为密钥本来就只在本进程里
    buyerSigner: buyer, sellerSigner: agent, env: process.env as any,
  };

  // 交易记录 (任务链路侧): discovered → quoted → paying
  const { record: created } = await TXS.beginTransaction({
    requestId,
    metadata: { itemId: SKILL, price: okBudget.amountUsdc, currency: 'USDC', network: 'localhost', payTo: agent.address, providerDid: 'did:key:zLocalSeller' },
    buyerDid: 'did:key:zTaskBuyer',
  }, HOME);
  const txId = created.transactionId;
  await TXS.updateTransaction(txId, { status: 'quoted' } as any, HOME);
  await TXS.updateTransaction(txId, {
    status: 'paying', paymentMode: 'escrow', settlementFact: 'payment_submitted', amount: okBudget.amountUsdc,
    event: { kind: 'escrow:create_intent', detail: `${okBudget.amountUsdc} USDC → escrow ${dep.escrowAddress}` },
  } as any, HOME);
  console.log(`  transactionId=${txId} (paymentMode=escrow)`);

  // (1) createEscrowV2
  const create = await OT.createEscrowStep(tradeReq);
  console.log(`  (1) createEscrowV2 tx=${create.txHash} block=${create.blockNumber} status=${create.chainStatus}`);
  check('createEscrowV2: 真上链 + receipt.status=1 + EscrowCreatedV2 事件对上', create.ok === true && create.chainSettled === true, create.reason);
  check('createEscrowV2: 走了 verifyPaymentOnChain (判定带确认数/事件核对)', create.verdict?.eventMatched === true && create.verdict?.confirmations != null, { c: create.verdict?.confirmations, ev: create.verdict?.matchedEvent });
  check('createEscrowV2: 签名审计已写 (只记摘要)', create.auditWritten === true);
  const escrowAfterCreate = await client.getEscrow(taskKey);
  check('链上 escrow 状态=ACTIVE 且金额==0.02 USDC (20000 原子)', escrowAfterCreate?.stateName === 'ACTIVE' && escrowAfterCreate?.amount === AMOUNT, { state: escrowAfterCreate?.stateName, amount: escrowAfterCreate?.amount?.toString() });
  check('链上 escrow 的 v2 字段齐 (termsHash/quoteHash/inputHash/deadline/confirmationWindow/paymentAsset/proofVersion)',
    !!escrowAfterCreate?.termsHash && !!escrowAfterCreate?.quoteHash && !!escrowAfterCreate?.inputHash
    && Number(escrowAfterCreate?.deadline) > 0 && Number(escrowAfterCreate?.confirmationWindow) > 0
    && String(escrowAfterCreate?.paymentAsset).toLowerCase() === tokenAddr.toLowerCase() && Number(escrowAfterCreate?.proofVersion) === 1,
    { deadline: escrowAfterCreate?.deadline?.toString(), cw: escrowAfterCreate?.confirmationWindow, asset: escrowAfterCreate?.paymentAsset });
  check('链上 termsHash == 链下复算 (口径一致)', String(escrowAfterCreate?.termsHash).toLowerCase() === String(OT.chainHashOf(tradeReq.termsDigest)).toLowerCase());

  // (2) 真执行: 装技能 → 跑技能 → 契约校验 (真代码)
  const SHARE: any = await import('../src/agents/skill-share.js');
  const collected = await SHARE.collectSkillBundle(path.join(FIXTURES, SKILL), { name: SKILL });
  check('技能包收集成功 (真读 fixture 目录)', collected?.ok === true && !!collected?.bundle, collected?.error);
  const delivered = JSON.stringify(collected.bundle);
  const contentHash = PIP.computeContentHash(delivered);
  const installDir = path.join(HOME, '.bolloon', 'tasks', taskId, 'skills', SKILL);
  fs.mkdirSync(installDir, { recursive: true });
  const installed = TR.installBundle(delivered, installDir);
  const fidelity = installed.ok ? await RC.verifyInstallFidelity({ content: delivered, rec: { contentHash }, installDir }) : { ok: false, issues: [installed.error] };
  check('交付内容按包安装到盘上 + 保真检查通过', installed.ok === true && fidelity.ok === true, { files: installed.files, issues: fidelity.issues });
  const loaded = await RC.loadResourceContract(installDir);
  const contract = loaded.ok ? loaded.contract : null;
  const input = TR.deriveSkillInput(contract, TASK);
  const exec = await RC.executeContractSkill({ contract, skillDir: installDir, input, allowedTools: ['skill_exec', 'read_file'], allowCodeExecution: true });
  const outChk = RC.validateResourceOutput(contract, exec.output);
  const sources = TR.extractSources(exec.output);
  const concl = TR.extractConclusion(exec.output);
  console.log(`  执行: ok=${exec.execution.ok} 契约=${outChk.ok ? '通过' : '未通过'} 来源=${sources.length} 结论=${String(concl.conclusion).slice(0, 30)}`);
  check('技能真被执行且输出满足契约', exec.execution.ok === true && outChk.ok === true, outChk.issues);
  const goalCriteriaMet = outChk.ok && sources.length > 0 && !!concl.conclusion;
  check('Goal 判据真命中 (契约通过 + 有来源 + 有结论)', goalCriteriaMet === true, { sources: sources.length, conclusion: concl.conclusion });

  // (3) submitProofV2: 链上结果承诺 = 我手上这份交付内容的摘要
  const resultDigest = OT.sha256Digest(delivered);
  const proof = await OT.submitProofStep(tradeReq, resultDigest, tradeReq.manifestDigest);
  console.log(`  (3) submitProofV2 tx=${proof.txHash} block=${proof.blockNumber} status=${proof.chainStatus}`);
  check('submitProofV2: 真上链 + ProofSubmittedV2 事件与 resultHash 对得上', proof.ok === true && proof.verdict?.eventMatched === true, proof.reason);
  const escrowAfterProof = await client.getEscrow(taskKey);
  check('链上 resultHash == keccak256(utf8("sha256:<hex>")) 的复算值', String(escrowAfterProof?.resultHash).toLowerCase() === String(OT.chainHashOf(resultDigest)).toLowerCase(), escrowAfterProof?.resultHash);
  check('链上 proofHash == 链上 computeProofHash(resultHash, proofVersion)', String(escrowAfterProof?.proofHash).toLowerCase() === String(await client.computeProofHash(escrowAfterProof?.resultHash, 1)).toLowerCase());
  check('提交证明后合约状态仍是 ACTIVE (还没释放)', escrowAfterProof?.stateName === 'ACTIVE', escrowAfterProof?.stateName);

  // (4) releaseV2
  const agentBalBefore = await token.balanceOf(agent.address);
  const release = await OT.releaseStep(tradeReq);
  const agentBalAfter = await token.balanceOf(agent.address);
  console.log(`  (4) releaseV2 tx=${release.txHash} block=${release.blockNumber} status=${release.chainStatus}`);
  check('releaseV2: 真上链 + ReleasedV2 事件对上 + 合约 RELEASED', release.ok === true && release.grantsVerified === true, release.reason);
  check('资金真到账 seller (+0.02 USDC)', agentBalAfter - agentBalBefore === AMOUNT, `delta=${agentBalAfter - agentBalBefore}`);
  const escrowAfterRelease = await client.getEscrow(taskKey);
  check('链上 escrow 状态=RELEASED', escrowAfterRelease?.stateName === 'RELEASED', escrowAfterRelease?.stateName);
  const relTx = await client.getReceipt(release.txHash);
  const relEvents = client.decodeV2Events({ logs: relTx?.logs ?? [], txHash: release.txHash }, 'ReleasedV2');
  check('release receipt 里 ReleasedV2 的 taskKey/to/amount/by 都对', relEvents.length === 1 && String(relEvents[0].args.taskKey).toLowerCase() === taskKey.toLowerCase()
    && String(relEvents[0].args.to).toLowerCase() === agent.address.toLowerCase() && BigInt(relEvents[0].args.amount) === AMOUNT && Number(relEvents[0].args.by) === 0,
    relEvents.length ? bjson(relEvents[0].args) : 'no ReleasedV2 decoded');

  // (5) 验真门: 链上事实 → 交易记录 (只有全过才 verified)
  const wr = SS.writeDeliveryContent(txId, delivered, HOME);
  await TXS.updateTransaction(txId, {
    contentHash, deliveryHash: contentHash, deliveryBytesHash: wr.hash,
    protocolVerified: true, verificationTrust: 'self-attested',
    execution: { ok: true, tool: 'skill_exec', schemaOk: true, sourceDeclared: true, outputHash: PIP.sha256Hex(JSON.stringify(exec.output)) },
    goalCriteriaMet,
    resourceOutcome: { installed: true, executed: true, outputContract: 'pass', criteriaHit: goalCriteriaMet },
    event: { kind: 'resource_outcome', detail: `installed=true executed=true contract=pass criteria=${goalCriteriaMet}` },
  } as any, HOME);
  const recForGate = await TXS.readTransaction(txId, HOME);
  const gated = await OT.applyChainSettlementToTransaction({
    rec: recForGate, home: HOME, verdict: release.verdict, taskKey,
    execution: recForGate.execution, goalCriteriaMet,
    receipt: `chain-release:${release.txHash}`,
  });
  console.log(`  验真门: verified=${gated.verified} status=${gated.status} fact=${gated.settlementFact}${gated.verified ? '' : ` blockedBy=${JSON.stringify(gated.blockedBy)}`}`);
  check('★ 验真门: chainSettled=true + 八项门全过 → 交易标 verified', gated.verified === true && gated.status === 'verified', gated.blockedBy.join(' | '));
  check('★ 结算事实 = fully_settled (链上真释放)', gated.settlementFact === 'fully_settled', gated.settlementFact);
  const finalRec = await TXS.readTransaction(txId, HOME);
  check('交易记录最终态: status=verified / chainSettled=true / txHash 是 release 那笔', finalRec.status === 'verified' && finalRec.chainSettled === true && String(finalRec.txHash).toLowerCase() === release.txHash.toLowerCase(), { st: finalRec.status, chain: finalRec.chainSettled, tx: finalRec.txHash });
  check('交易记录事件链可回放 (含 chain:settled / status:verified)', (await TXS.replayTransaction(txId, HOME)).some((l: string) => l.includes('chain:settled')) && (await TXS.replayTransaction(txId, HOME)).some((l: string) => l.includes('status:verified')), (await TXS.replayTransaction(txId, HOME)).slice(-3));
  const auditRows = fs.existsSync(path.join(HOME, '.bolloon', 'wallet-signatures.jsonl')) ? fs.readFileSync(path.join(HOME, '.bolloon', 'wallet-signatures.jsonl'), 'utf8').trim().split('\n').length : 0;
  check('签名审计写了 (create/submit/release ≥3 条)', auditRows >= 3, `rows=${auditRows}`);
  const auditDump = fs.existsSync(path.join(HOME, '.bolloon', 'wallet-signatures.jsonl')) ? fs.readFileSync(path.join(HOME, '.bolloon', 'wallet-signatures.jsonl'), 'utf8') : '';
  check('★ 审计里没有私钥', !auditDump.includes(buyerKey.slice(2)) && !auditDump.includes(agentKey.slice(2)), 'checked');

  // ── ④b 任务链路入口 (同一套任务件: 预算闸 / 荐资源 / 真执行 / 报告卡) ────────
  section('④b 任务链路入口 runTaskOnchain: 预算闸 → 荐资源 → 托管 → 真执行 → 释放 → 报告卡');
  const TOR: any = await import('../src/agents/task/task-onchain-runner.js');
  const taskRun = await TOR.runTaskOnchain({
    task: TASK, home: HOME, budget: TASK_BUDGET, perPurchase: PER_PURCHASE, skillPaths: [FIXTURES],
    client, agentAddress: agent.address, paymentAsset: tokenAddr, tokenDecimals: decimals,
    buyerSigner: buyer, sellerSigner: agent, deadline, confirmationWindow: 3600,
    network: 'localhost', env: process.env as any, buyerDid: 'did:key:zTaskBuyer',
    requestId: `p4-task-onchain-${runId}`,
  });
  console.log(`  报告卡: status=${taskRun.card.status} 结论=${String(taskRun.card.conclusion).slice(0, 36)}…`);
  console.log(`  链上: verified=${taskRun.chain.verified} create=${taskRun.chain.create} proof=${taskRun.chain.proof} release=${taskRun.chain.release}`);
  check('任务链路: 自动荐资源 + 真执行 + 报告卡=已完成', taskRun.ok === true && taskRun.card.status === '已完成', { skill: taskRun.skill?.name, exec: taskRun.execution });
  check('任务链路: 链上 verified 且 create/proof/release 三笔都有 txHash', taskRun.chain.verified === true && !!taskRun.chain.create && !!taskRun.chain.proof && !!taskRun.chain.release, taskRun.chain);
  check('任务链路: 金额 = M1 单次上限 0.02 USDC', taskRun.amountUsdc === '0.02', taskRun.amountUsdc);
  const taskRunRec = await TXS.readTransaction(taskRun.transactionId, HOME);
  check('任务链路: 交易记录 status=verified / chainSettled=true / paymentMode=escrow', taskRunRec?.status === 'verified' && taskRunRec?.chainSettled === true && taskRunRec?.paymentMode === 'escrow', { st: taskRunRec?.status, chain: taskRunRec?.chainSettled, mode: taskRunRec?.paymentMode });
  check('任务链路: 报告卡明示 escrow 支付方式 + 链上已验证=是', String(taskRun.text).includes('链上已验证: 是'), String(taskRun.text).match(/链上已验证: .{0,6}/)?.[0]);
  check('任务链路: 报告卡不外泄内部术语', !/fully_settled|chainSettled|payment_verified|facilitator/.test(String(taskRun.text)), 'ok');
  check('任务链路: 链上记录里 release 判为可信 (suspect=false)', taskRun.recovery.release?.suspect === false && taskRun.recovery.verified === true, taskRun.recovery.reason);

  // ── ⑤ 负例 ─────────────────────────────────────────────────────────────────
  section('⑤ 负例 (每一条都必须"没结算 + 不许标 verified")');

  // N1 资金不足: 一个没有 token / 没授权的账户
  const poorKey = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase('test test test test test test test test test test test junk'), "m/44'/60'/0'/0/5").privateKey;
  const poor = new Wallet(poorKey, provider);
  const poorTaskId = `bolloon-p4-poor-${runId}`;
  const poorReq: any = { ...tradeReq, taskId: poorTaskId, buyerSigner: poor, agentAddress: agent.address };
  const poorBal = await token.balanceOf(poor.address);
  const poorAllow = await token.allowance(poor.address, dep.escrowAddress);
  const poorCreate = await OT.createEscrowStep(poorReq);
  console.log(`  N1 buyer=${poor.address} balance=${poorBal} allowance=${poorAllow}`);
  console.log(`     createEscrowV2 → tx='${poorCreate.txHash}' authorized=${poorCreate.authorized} reason=${String(poorCreate.reason).slice(0, 90)}`);
  check('N1 资金不足: 交易没发出去 (广播前失败) 且如实报原因', poorBal < AMOUNT && poorCreate.ok === false && poorCreate.txHash === '', `balance=${poorBal}`);
  check('N1 资金不足: 链上没有产生这条 escrow (钱没动)', (await client.getEscrow(computeTaskKeyOffChain(poorTaskId))) === null);
  // 强制 gasLimit → 拿到真 status=0 的 receipt (证据更强)
  let poorForced: any = null;
  try {
    const c = client.contractWith(poor);
    const tx = await c.createEscrowV2(
      computeTaskKeyOffChain(poorTaskId), agent.address, AMOUNT, tokenAddr,
      OT.chainHashOf(tradeReq.termsDigest), OT.chainHashOf(tradeReq.quoteDigest), OT.chainHashOf(tradeReq.inputDigest), OT.chainHashOf(tradeReq.manifestDigest),
      deadline, 3600, 1, { gasLimit: 400_000 },
    );
    const rc = await tx.wait().catch((e: any) => e?.receipt);
    poorForced = { txHash: tx.hash, status: Number(rc?.status), blockNumber: rc?.blockNumber };
  } catch (e: any) {
    poorForced = { txHash: e?.transaction?.hash || '', error: String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 120) };
  }
  console.log(`     强制 gasLimit 真发 → tx=${poorForced?.txHash} status=${poorForced?.status}`);
  check('N1 资金不足: 强制广播的真交易 receipt.status=0 (reverted)', poorForced?.status === 0, bjson(poorForced));
  if (poorForced?.txHash) {
    const v = await verifyPaymentOnChain({ txHash: poorForced.txHash, chainSettlement: { verifier: CHAIN.createChainSettlementVerifier(client, {}), expect: { kind: 'escrow', taskKey: computeTaskKeyOffChain(poorTaskId) } } });
    console.log(`     判定: status=${v.status} chainSettled=${v.chainSettled}`);
    check('N1 ★ 有 txHash 也不算结算: 判 reverted, chainSettled=false', v.chainSettled === false && v.status === 'reverted', v.status);
  }

  // N2 确认数不够: 用同一个真 release tx 抬高门槛
  const strict = await verifyChainSettlement(client, {
    txHash: release.txHash,
    expect: { kind: 'escrow', taskKey, eventName: 'ReleasedV2', expectEscrowState: 'RELEASED' },
    confirmations: { confirmed: 500, finalized: 1000 },
  });
  console.log(`  N2 抬高门槛 confirmed=500 → status=${strict.status} confirmations=${strict.confirmations}/${strict.confirmationsRequired} chainSettled=${strict.chainSettled}`);
  check('N2 ★ 确认数不够 → pending, chainSettled=false (不判已验证)', strict.chainSettled === false && strict.status === 'pending', strict.reason);
  const n2 = await TXS.beginTransaction({ requestId: `p4-n2-${runId}`, metadata: { itemId: SKILL, price: '0.02', currency: 'USDC' }, buyerDid: 'did:key:zTaskBuyer' }, HOME);
  await TXS.updateTransaction(n2.record.transactionId, { status: 'quoted' } as any, HOME);
  await TXS.updateTransaction(n2.record.transactionId, { status: 'paying', paymentMode: 'escrow', settlementFact: 'payment_submitted', txHash: release.txHash, contentHash, deliveryHash: contentHash, deliveryBytesHash: wr.hash, receiptHash: TP.computeReceiptHash('chain-release:' + release.txHash), protocolVerified: true, execution: { ok: true, tool: 'skill_exec', schemaOk: true }, goalCriteriaMet: true } as any, HOME);
  const n2rec = await TXS.readTransaction(n2.record.transactionId, HOME);
  const n2gate = await OT.applyChainSettlementToTransaction({ rec: n2rec, home: HOME, verdict: strict, taskKey, execution: n2rec.execution, goalCriteriaMet: true, receipt: 'chain-release:' + release.txHash });
  const n2after = await TXS.readTransaction(n2.record.transactionId, HOME);
  check('N2 ★ 确认数不够时交易不许标 verified', n2gate.verified === false && n2after.status !== 'verified', { verified: n2gate.verified, status: n2after.status, fact: n2after.settlementFact });
  check('N2 不确定时结算事实没被冒标 fully_settled', n2after.settlementFact !== 'fully_settled', n2after.settlementFact);

  // N3 事件/taskKey 对不上
  const wrongKey = computeTaskKeyOffChain(`not-ours-${runId}`);
  const mismatch = await verifyPaymentOnChain({ txHash: release.txHash, chainSettlement: { verifier: CHAIN.createChainSettlementVerifier(client, {}), expect: { kind: 'escrow', taskKey: wrongKey } } });
  check('N3 ★ 事件 taskKey 对不上 → event_mismatch, chainSettled=false', mismatch.chainSettled === false && mismatch.status === 'event_mismatch', mismatch.status);

  // N4 local-dev 永远到不了 fully_settled (同一份门)
  const localDevFact = SS.canTransitionSettlement('payment_submitted', 'fully_settled', { paymentMode: 'local-dev', chainSettled: true, txHash: release.txHash });
  check('N4 ★ local-dev 路径永远产生不了 fully_settled', localDevFact.ok === false && String(localDevFact.reason).includes('local-dev'), localDevFact.reason);
  const localRec = { transactionId: 'x', status: 'paying', chainSettled: true, paymentMode: 'local-dev', settlementFact: 'payment_submitted', contentHash, deliveryHash: contentHash, receiptHash: 'r', events: [] };
  const localGate = OT.evaluateChainVerifiedGate({ rec: localRec, home: HOME, verdict: release.verdict, taskKey, execution: { ok: true, schemaOk: true }, goalCriteriaMet: true });
  check('N4 ★ local-dev 记录 + 链上判定 → 验真门照样拒绝', localGate.verified === false, localGate.blockedBy.join(' | '));

  // ── ⑥ 重启恢复 (三个真场景) ────────────────────────────────────────────────
  section('⑥ 失败与恢复: 从 chain-state.json 重建并继续 (绝不重付 / 绝不静默标 verified)');

  // R1: createEscrow 已上链但执行失败
  const r1Id = `bolloon-p4-r1-${runId}`;
  const r1Req: any = { ...tradeReq, taskId: r1Id };
  const r1Loop = await OT.runOnchainTradeLoop(r1Req, async () => ({ ok: false, reason: '模拟: 技能执行崩了' }));
  console.log(`  R1 createEscrowV2 tx=${r1Loop.create?.txHash} block=${r1Loop.create?.blockNumber}`);
  check('R1 createEscrowV2 真上链 (托管已注资)', r1Loop.create?.ok === true && r1Loop.create?.txHash !== '', r1Loop.create?.reason);
  check('R1 执行失败 → 不提交证明 / 不释放 (托管里的钱不动)', r1Loop.proof === null && r1Loop.release === null && r1Loop.verified === false, r1Loop.verifiedReason);
  check('R1 如实说明"钱留在托管里"', String(r1Loop.verifiedReason).includes('执行失败') && String(r1Loop.verifiedReason).includes('托管'), r1Loop.verifiedReason);
  // 同一意图再来一次 → 放行闸的幂等审计必须挡住 (绝不重复创建托管/重复付款)
  const r1Dup = await OT.createEscrowStep(r1Req);
  check('R1 ★ 同一意图重复 createEscrowV2 被放行闸拒 (notDuplicate, 没有新交易)', r1Dup.ok === false && r1Dup.txHash === '' && /notDuplicate/.test(String(r1Dup.reason)), r1Dup.reason);
  const r1Rec = recoverOnchainTrade({ home: HOME, taskId: r1Id });
  console.log(`  R1 重启恢复: nextAction=${r1Rec.nextAction} mustNotRepay=${r1Rec.mustNotRepay} verified=${r1Rec.verified}`);
  check('R1 ★ 重启后从 chain-state.json 重建: 待人工 (托管已注资, 没有可提交的结果)', r1Rec.nextAction === 'needs_human' && r1Rec.mustNotRepay === true && r1Rec.verified === false, r1Rec.reason);
  const r1BlockBefore = await provider.getBlockNumber();
  const r1Resumed = await OT.resumeOnchainTrade({ ...r1Req, dryRun: false });
  const r1BlockAfter = await provider.getBlockNumber();
  check('R1 ★ 续跑没有发任何新交易 (不重付)', r1Resumed.steps.length === 0 && r1BlockAfter === r1BlockBefore, { steps: r1Resumed.steps.map((s: any) => s.method), blocks: `${r1BlockBefore}→${r1BlockAfter}` });

  // R2: submitProof 后 release 前崩溃 → 重启后继续
  const r2Id = `bolloon-p4-r2-${runId}`;
  const r2Req: any = { ...tradeReq, taskId: r2Id };
  const r2Create = await OT.createEscrowStep(r2Req);
  const r2Proof = await OT.submitProofStep(r2Req, resultDigest, r2Req.manifestDigest);
  check('R2 create + submitProof 真上链 (模拟崩溃前状态)', r2Create.ok === true && r2Proof.ok === true, { c: r2Create.txHash, p: r2Proof.txHash });
  const r2RecBefore = recoverOnchainTrade({ home: HOME, taskId: r2Id });
  console.log(`  R2 重启恢复: nextAction=${r2RecBefore.nextAction} mustNotRepay=${r2RecBefore.mustNotRepay}`);
  check('R2 ★ 重启后重建 → 可以安全释放 (不是第二次付款)', r2RecBefore.nextAction === 'release' && r2RecBefore.mustNotRepay === true && r2RecBefore.verified === false, r2RecBefore.reason);
  const r2Resume = await OT.resumeOnchainTrade({ ...r2Req, dryRun: false });
  console.log(`  R2 续跑: steps=[${r2Resume.steps.map((s: any) => s.method).join(',')}] reverified=${r2Resume.reverified.length} done=${r2Resume.done}`);
  check('R2 ★ 续跑只走 release (没有 create/proof 重发)', r2Resume.steps.map((s: any) => s.method).join(',') === 'releaseV2', r2Resume.steps.map((s: any) => s.method));
  check('R2 ★ 续跑后链上释放成立 → verified', r2Resume.done === true && r2Resume.verified === true, r2Resume.reason);
  const r2Escrow = await client.getEscrow(computeTaskKeyOffChain(r2Id));
  check('R2 链上 escrow 状态=RELEASED', r2Escrow?.stateName === 'RELEASED', r2Escrow?.stateName);

  // R3: release 时读数不可用 (RPC 读不到) → 不确定≠失败; 读数恢复后重新对账 → verified
  const r3Id = `bolloon-p4-r3-${runId}`;
  const r3Req: any = { ...tradeReq, taskId: r3Id };
  const r3Create = await OT.createEscrowStep(r3Req);
  const r3Proof = await OT.submitProofStep(r3Req, resultDigest, r3Req.manifestDigest);
  check('R3 create + submitProof 真上链', r3Create.ok === true && r3Proof.ok === true, { c: r3Create.txHash, p: r3Proof.txHash });
  const deadVerifier = async ({ txHash }: any) => ({
    chainSettled: false, status: 'unknown', reason: '模拟: release 时 RPC 读不到 (不确定, 不等于失败)',
    txHash, confirmationsRequired: 1, requiredGate: 'confirmed', rpcAvailable: false, checkedAt: Date.now(), evidence: {},
  });
  const r3Release = await OT.releaseStep({ ...r3Req, verifyOnChain: deadVerifier });
  check('R3 release 真发出去了 (有 txHash), 但判定读不到 → 不判已结算', r3Release.txHash !== '' && r3Release.ok === false, { tx: r3Release.txHash, status: r3Release.chainStatus });
  const r3RecBefore = recoverOnchainTrade({ home: HOME, taskId: r3Id });
  console.log(`  R3 重启恢复: nextAction=${r3RecBefore.nextAction} mustNotRepay=${r3RecBefore.mustNotRepay} verified=${r3RecBefore.verified}`);
  check('R3 ★ 不确定≠失败: 状态是 verify_only (不是 needs_human 的大回滚, 也不是 done)', r3RecBefore.nextAction === 'verify_only' && r3RecBefore.verified === false && r3RecBefore.mustNotRepay === true, r3RecBefore.reason);
  const r3Resume = await OT.resumeOnchainTrade({ ...r3Req, dryRun: false });
  console.log(`  R3 重新对账: reverified=[${r3Resume.reverified.map((r: any) => `${r.method}:${r.status}`).join(',')}] done=${r3Resume.done} verified=${r3Resume.verified}`);
  check('R3 ★ 读数恢复后重新对账 → 链上释放成立 → verified', r3Resume.done === true && r3Resume.verified === true, r3Resume.reason);
  check('R3 续跑没有再发交易 (只重新判定了已有 tx)', r3Resume.steps.length === 0, r3Resume.steps.map((s: any) => s.method));

  // R4: release 前真重组 (anvil_rollback)
  const r4Id = `bolloon-p4-r4-${runId}`;
  const r4Req: any = { ...tradeReq, taskId: r4Id };
  const r4Create = await OT.createEscrowStep(r4Req);
  const r4Proof = await OT.submitProofStep(r4Req, resultDigest, r4Req.manifestDigest);
  const r4Release = await OT.releaseStep(r4Req);
  const r4RecBefore = recoverOnchainTrade({ home: HOME, taskId: r4Id });
  check('R4 release 真上链且恢复判定 = done', r4Release.ok === true && r4RecBefore.nextAction === 'done' && r4RecBefore.verified === true, { c: r4Create.txHash, p: r4Proof.txHash, r: r4Release.txHash });
  let reorgSupported = true;
  try { await provider.send('anvil_rollback', [1]); } catch (e: any) { reorgSupported = false; console.log(`  ⚠ 本 RPC 不支持 anvil_rollback (${String(e?.message || e).slice(0, 70)})`); }
  if (reorgSupported) {
    const r4AfterReorg = await verifyChainSettlement(client, {
      txHash: r4Release.txHash, expect: { kind: 'escrow', taskKey: computeTaskKeyOffChain(r4Id), eventName: 'ReleasedV2' },
      recorded: { blockNumber: r4Release.blockNumber, confirmations: 1, status: 'confirmed' },
    });
    check('R4 ★ 真重组: 已上链的 release 被回滚 → reorged, chainSettled=false', r4AfterReorg.chainSettled === false && r4AfterReorg.status === 'reorged', r4AfterReorg.status);
    const r4Resume = await OT.resumeOnchainTrade({ ...r4Req, dryRun: false });
    const r4RecAfter = recoverOnchainTrade({ home: HOME, taskId: r4Id });
    console.log(`  R4 重组后恢复: nextAction=${r4RecAfter.nextAction} verified=${r4RecAfter.verified} suspect=${r4RecAfter.release?.suspect}`);
    check('R4 ★ 重组后恢复判定 = 待人工, 且 verifed 保持 false (不静默当已结算)', r4RecAfter.nextAction === 'needs_human' && r4RecAfter.verified === false, r4RecAfter.reason);
    check('R4 ★ 重组后**没有**自动重发任何交易', r4Resume.steps.length === 0, r4Resume.steps.map((s: any) => s.method));
    const r4Escrow = await client.getEscrow(computeTaskKeyOffChain(r4Id));
    check('R4 链上 escrow 也回退了 (不再是 RELEASED)', r4Escrow?.stateName !== 'RELEASED', r4Escrow?.stateName);
  }

  // ── ⑦ 掉 RPC / 标准路径 ────────────────────────────────────────────────────
  section('⑦ 掉 RPC 与状态文件路径');
  const deadClient = new EscrowClient({ escrowAddress: dep.escrowAddress, provider: { getTransactionReceipt: async () => { throw new Error('ECONNREFUSED 127.0.0.1:9'); } } as any });
  const dead = await verifyChainSettlement(deadClient, { txHash: release.txHash, expect: { kind: 'escrow', taskKey } });
  check('RPC 读不到 → unknown + rpcAvailable=false + chainSettled=false (不冒报)', dead.chainSettled === false && dead.status === 'unknown' && dead.rpcAvailable === false, dead.status);

  const stateFile = chainStatePath(HOME);
  check('链上状态落在 <HOME>/.bolloon/chain/chain-state.json (标准位置)', fs.existsSync(stateFile) && stateFile.endsWith(path.join('.bolloon', 'chain', 'chain-state.json')), stateFile);
  const stateJson = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const methods = Object.values(stateJson.records).map((r: any) => r.method);
  check('chain-state.json 记录了 create/proof/release 三类链上事实', methods.includes('createEscrowV2') && methods.includes('submitProofV2') && methods.includes('releaseV2'), { records: methods.length });
  const realStatePath = chainStatePath(REAL_HOME);
  const realExists = fs.existsSync(realStatePath);
  const realRead = recoverOnchainTrade({ home: REAL_HOME, taskId });   // 纯读盘, 不写不联网
  check('标准路径 ~/.bolloon/chain/chain-state.json 的读取语义一致 (纯读, 不写真实 HOME)', realRead.statePath === realStatePath && realRead.found === realExists, { path: realStatePath, exists: realExists });

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  section('汇总 (真 txHash)');
  console.log(`  主闭环 taskId=${taskId}`);
  console.log(`    createEscrowV2 : ${create.txHash}  (block ${create.blockNumber})`);
  console.log(`    submitProofV2  : ${proof.txHash}  (block ${proof.blockNumber})`);
  console.log(`    releaseV2      : ${release.txHash}  (block ${release.blockNumber})`);
  console.log(`    transactionId  : ${txId}  status=${finalRec.status} fact=${finalRec.settlementFact}`);
  console.log(`  恢复用例 txHash:`);
  console.log(`    R1 createEscrowV2 : ${r1Loop.create?.txHash}`);
  console.log(`    R2 create/proof/release : ${r2Create.txHash} / ${r2Proof.txHash} / ${r2Resume.steps[0]?.txHash ?? '(无)'}`);
  console.log(`    R3 release        : ${r3Release.txHash}`);
  console.log(`    R4 create/proof/release : ${r4Create.txHash} / ${r4Proof.txHash} / ${r4Release.txHash}  (被真重组回滚)`);
  console.log(`    N1 资金不足(强制广播) : ${poorForced?.txHash}`);
  console.log(`  latestBlock=${await provider.getBlockNumber()}  链上状态文件=${stateFile}`);
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);

  try { client.removeAllListeners(); } catch { /* noop */ }
  try { (provider as any).destroy?.(); } catch { /* noop */ }
  console.log(`  (临时 HOME 保留供审计: ${ROOT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[verify-onchain-trade-loop] 失败:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
