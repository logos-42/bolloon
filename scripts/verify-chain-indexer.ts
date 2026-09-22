/**
 * verify-chain-indexer.ts — P5「链上索引器」真实验收
 * =========================================================================
 * 全部断言都对着**真节点**跑, 不用假 provider (假链场景在 src/test/chain-indexer.test.ts):
 *
 *   A. 本地 anvil (chainId 31337): 先真发交易造事件 (create/proof/release/expire), 再验收
 *      ① 增量不重扫: 第二次 sync 的区间 = [lastSyncedBlock+1, head], 一条也不落回已扫区间
 *      ② 重复同步不出重: 显式 fromBlock=deploymentBlock 全量补扫 → inserted=0, deduped=总数
 *      ③ reorg 回退正确: anvil_rollback 回退掉含真事件的块 → 该记录标 suspect (仍在, 不删),
 *         lastSyncedBlock 回退; 再用**同一笔 raw tx** 重新打包 → suspect 复位 (restored)
 *      ④ 从 deployment block 重建 == 增量: rebuild() 与增量逐条比对 same=true
 *      ⑤ 分页跨越多个 block-range 不错漏: pageSize=1 与 pageSize=2000 两次重建结果必须逐条一致
 *      ⑥ finality 分层: 真链上等 12 个块后, 老事件从 confirmed → finalized
 *      ⑦ ExpiredV2 (F2b) 真事件也能被索引/解码 (stats.expired)
 *      ⑧ 只读查询接口 (timeline / cursor / stats / 索引高度) 对真索引读数
 *
 *   B. Base Sepolia 真网 (chainId 84532): **只读**从 manifest 的 deployment block 起同步
 *      目前该合约应当 0 条事件 —— 如实报 0, 并用扫过的区间/页数/块数证明"确实扫过",
 *      而不是"没扫就说没有"。顺带记录: 该 RPC 是否接受"单次大区间" getLogs。
 *
 * 跑法 (anvil 要先在跑):
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 &
 *   npx tsx scripts/verify-chain-indexer.ts
 *   只跑本地: npx tsx scripts/verify-chain-indexer.ts --local-only
 *
 * 隔离/边界:
 *   · 索引写在**临时 HOME** (不污染真实 ~/.bolloon); 私钥**不打印不落盘** (只用 anvil 公开开发助记符);
 *   · 只读 RPC 不需要密钥; 绝不写 contracts/ 下的任何文件 (部署块从 manifest **读**)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HDNodeWallet, Mnemonic, Wallet, Contract, JsonRpcProvider, formatUnits } from 'ethers';

const CHAIN = await import('../src/agents/chain/index.js');
const { parseDeploymentManifest } = await import('../src/agents/chain/chain-config.js');
const {
  ChainIndexer, INDEX_IFACE, resolveDeploymentInfo, compareIndexes,
  getIndexStatus, getIndexStats, getEscrowTimeline, fetchIndexSince,
  createJsonRpcProvider, computeTaskKeyOffChain, LOCAL_DEV_CHAIN_ID,
  INDEX_IDENTITY_CHANGED,
} = CHAIN as any;
const { AGENT_ESCROW_V2_ABI } = await import('../src/agents/chain/escrow-client.js');

// ── 断言工具 ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  return ok;
};
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).slice(0, 300);
const section = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

// ── 临时 HOME (索引不污染真实 ~/.bolloon) ───────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-indexer-verify-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const ERC20_ABI = [
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)', 'function mint(address,uint256)',
];
const WRITE_ABI = [...(AGENT_ESCROW_V2_ABI as unknown as string[]), 'function expireV2(bytes32 taskKey)'];

const LOCAL_RPC = process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545';
const ONLY_LOCAL = process.argv.includes('--local-only');

/**
 * 从 manifest 解析某条链的部署信息 (绝不硬编码地址/块号)。
 * ★ 解析走 chain-config 的 `parseDeploymentManifest` —— 与生产同一份代码:
 *   token 地址可能记在 `.token.address` (自部署替身) 或 `.externalToken.address` (外部真 token),
 *   手写一遍 `m.externalToken?.address` 就会在本地 mock 部署上拿到 undefined
 *   (2026-09-22 实测: 本脚本就是在这里 `new Contract(undefined)` 炸的)。
 */
function manifestDeployment(networkName: string): any {
  const p = path.resolve(process.cwd(), `contracts/deployments/${networkName}.json`);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  const man = parseDeploymentManifest(p, m);
  if (!man) throw new Error(`${p} 里没有可认的 AgentEscrow 部署事实 (不猜地址, 也不硬编码)`);
  return {
    manifest: m, man,
    escrowAddress: man.escrowAddress,
    rpcUrl: man.rpcUrl,
    chainId: man.chainId,
    tokenAddress: man.tokenAddress,
    tokenDecimals: man.tokenDecimals,
    deploymentBlock: man.escrowBlockNumber,
  };
}

const contentHashOf = (s: string) => CHAIN.computeResultHashOffChain(`sha256:${s}`);

async function main() {
  const local = manifestDeployment('localhost');
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  // ═══════════════════════════════════════════════════════════════════════
  section('① 本地 anvil: 接链 + 从 manifest 解析索引起点');
  const provider = createJsonRpcProvider(LOCAL_RPC) as JsonRpcProvider;
  let net: any;
  try { net = await provider.getNetwork(); } catch (e: any) {
    console.log(`  ❌ 连不上 ${LOCAL_RPC}: ${e.message}\n  先起 anvil: DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545`);
    process.exit(1);
  }
  const chainId = Number(net.chainId);
  check('本地链 chainId == 31337', chainId === LOCAL_DEV_CHAIN_ID, chainId);
  if (chainId !== LOCAL_DEV_CHAIN_ID) { console.log('  拒绝在非本地链上跑本地部分'); }

  const w0 = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(DEV_MNEMONIC), "m/44'/60'/0'/0/0");
  const w1 = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(DEV_MNEMONIC), "m/44'/60'/0'/0/1");
  const w2 = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(DEV_MNEMONIC), "m/44'/60'/0'/0/2");
  const buyer = new Wallet(w0.privateKey, provider);
  const agent = new Wallet(w1.privateKey, provider);
  const third = new Wallet(w2.privateKey, provider);
  console.log(`  RPC          : ${LOCAL_RPC}`);
  console.log(`  escrow       : ${local.escrowAddress}  (来自 contracts/deployments/localhost.json)`);
  console.log(`  token        : ${local.tokenAddress}`);
  console.log(`  buyer        : ${buyer.address}   agent: ${agent.address}   third: ${third.address}`);

  const info = resolveDeploymentInfo({
    chainId: LOCAL_DEV_CHAIN_ID, escrowAddress: local.escrowAddress,
    deploymentsDir: path.resolve(process.cwd(), 'contracts/deployments'),
  });
  const deploymentBlock = info.deploymentBlock;
  console.log(`  起点         : deploymentBlock=${deploymentBlock}  (来源: ${info.source})`);
  check('索引起点来自 manifest 的 deployment block (非硬编码)', deploymentBlock === Number(local.manifest.contracts.find((c: any) => c.name === 'AgentEscrow').blockNumber), deploymentBlock);

  const escrow = new Contract(local.escrowAddress, WRITE_ABI, provider);
  const token = new Contract(local.tokenAddress, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  const code = await provider.getCode(local.escrowAddress);
  check('escrow 地址上有 bytecode', String(code).length > 2, `${(String(code).length - 2) / 2} bytes`);
  console.log(`  token        : ${await token.symbol()} decimals=${decimals}  head=${await provider.getBlockNumber()}`);

  // ── 真发交易的辅助 (可拿到 raw tx, 重组后用同一笔 raw 重新打包) ──────────
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /**
   * 发一笔真交易, 并把**原始 raw** 留下来 (重组后用同一笔 raw 重新打包)。
   * 共享 anvil 上别的进程可能也在用同一个账户发交易 → nonce 会撞车, 所以广播阶段带重试
   * (只重试"广播被拒"的 nonce 竞争; 一旦广播成功, wait 失败不再重发, 避免重复交易)。
   */
  const sendRaw = async (populate: () => Promise<any>, signer: Wallet) => {
    let sent: any = null;
    let raw = '';
    for (let attempt = 1; ; attempt++) {
      const pop = await populate();
      const nonce = await provider.getTransactionCount(signer.address, 'pending');
      // ★ 必须自己填 fee: signTransaction 不会自动补 maxFeePerGas (sendTransaction 才会),
      //   不填就会得到 maxFeePerGas=0 的 raw tx → 真节点回 "max fee per gas less than block base fee"。
      const fee = await provider.getFeeData();
      raw = await signer.signTransaction({
        ...pop,
        nonce,
        chainId: LOCAL_DEV_CHAIN_ID,
        type: 2,
        gasLimit: pop.gasLimit ?? 900_000n,
        maxFeePerGas: pop.maxFeePerGas ?? fee.maxFeePerGas ?? 2_000_000_000n,
        maxPriorityFeePerGas: pop.maxPriorityFeePerGas ?? fee.maxPriorityFeePerGas ?? 1_000_000_000n,
      });
      try {
        sent = await provider.broadcastTransaction(raw);
        break;
      } catch (e: any) {
        const msg = String(e?.shortMessage || e?.message || e);
        if (attempt < 4 && /nonce|already known|replacement|underpriced/i.test(msg)) { await sleep(400); continue; }
        throw e;
      }
    }
    const rc = await sent.wait();
    return { txHash: sent.hash, raw, blockNumber: Number(rc!.blockNumber), status: Number(rc!.status), logs: rc!.logs };
  };
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await provider.send('evm_mine', []); };

  const AMOUNT = 10_000_000n; // 10 USDC
  const mkEscrow = async (label: string, opts: { deadline?: bigint; window?: number; signer?: Wallet } = {}) => {
    const taskId = `bolloon-indexer-${label}-${runId}`;
    const taskKey = computeTaskKeyOffChain(taskId);
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    const out = await sendRaw(() => escrow.connect(opts.signer || buyer).createEscrowV2.populateTransaction(
      taskKey, agent.address, AMOUNT, local.tokenAddress,
      contentHashOf(`terms:${taskId}`), contentHashOf(`quote:${taskId}`), contentHashOf(`input:${taskId}`), contentHashOf(`manifest:${taskId}`),
      opts.deadline ?? now + 3600n, opts.window ?? 3600, 1,
    ), opts.signer || buyer);
    return { taskId, taskKey, ...out };
  };

  // ★ 资金前提由**本脚本自己**保证, 不靠别人留下的链上状态:
  //   共享 anvil 上别的验收跑一趟就会把 allowance 花掉 → 老断言"不需要新增 approve 也能发真交易"
  //   是"环境巧合才绿"的典型 (2026-09-22 实测: allowance 只剩 0.18 USDC → 直接炸在 create 上)。
  //   这里先按本脚本实际要用的量补齐 (本地 MockERC20 的 mint/approve 是公开的), 再断言补完够用。
  const NEED_ALLOWANCE = AMOUNT * 6n;   // 本脚本最多造 6 个 escrow (A/B/C/D/E/F)
  const bal0 = await token.balanceOf(buyer.address);
  const allow0 = await token.allowance(buyer.address, local.escrowAddress);
  const topUp: string[] = [];
  if (bal0 < NEED_ALLOWANCE) {
    const r = await (await token.connect(buyer).mint(buyer.address, NEED_ALLOWANCE * 2n)).wait();
    topUp.push(`mint ${formatUnits(NEED_ALLOWANCE * 2n, decimals)} (tx ${r!.hash})`);
  }
  if (allow0 < NEED_ALLOWANCE) {
    const r = await (await token.connect(buyer).approve(local.escrowAddress, NEED_ALLOWANCE * 10n)).wait();
    topUp.push(`approve ${formatUnits(NEED_ALLOWANCE * 10n, decimals)} (tx ${r!.hash})`);
  }
  const balance = await token.balanceOf(buyer.address);
  const allowance = await token.allowance(buyer.address, local.escrowAddress);
  console.log(`  buyer 资金前提: 余额=${formatUnits(balance, decimals)} · allowance=${formatUnits(allowance, decimals)}${topUp.length ? ` ← 本脚本自己补的: ${topUp.join(' · ')}` : ' (链上本来就有)'}`);
  check('buyer 余额 + allowance ≥ 本脚本要用的量 (不足时自己 mint/approve, 不靠别人留下的状态)',
    balance >= NEED_ALLOWANCE && allowance >= NEED_ALLOWANCE, { balance: balance.toString(), allowance: allowance.toString(), need: NEED_ALLOWANCE.toString(), topUp });

  // ═══════════════════════════════════════════════════════════════════════
  section('② 造真事件 (A: createEscrowV2 → submitProofV2 → releaseV2)');
  const A = await mkEscrow('A');
  console.log(`  A create   tx=${A.txHash} block=${A.blockNumber} status=${A.status}`);
  const AProof = await sendRaw(() => escrow.connect(agent).submitProofV2.populateTransaction(
    A.taskKey, contentHashOf(`result:${A.taskId}`), contentHashOf(`manifest:${A.taskId}`), 1), agent);
  const ARel = await sendRaw(() => escrow.connect(buyer).releaseV2.populateTransaction(A.taskKey), buyer);
  console.log(`  A proof    tx=${AProof.txHash} block=${AProof.blockNumber}`);
  console.log(`  A release  tx=${ARel.txHash} block=${ARel.blockNumber}`);
  check('三笔真交易都 status=1', [A, AProof, ARel].every((t) => t.status === 1));
  const escrowState = await escrow.escrows(A.taskKey);
  check('链上 escrow A 状态 = RELEASED(1)', Number(escrowState.state) === 1, Number(escrowState.state));

  // ═══════════════════════════════════════════════════════════════════════
  section('③ 首次同步 (从 deployment block 分页扫, pageSize=8)');
  const mkIdx = (extra: any = {}) => new ChainIndexer({
    provider, escrowAddress: local.escrowAddress, chainId: LOCAL_DEV_CHAIN_ID, networkName: 'localhost',
    deploymentBlock, home: HOME, pageSize: 8, reorgDepth: 16, ...extra,
  });
  const idx = mkIdx();
  let t0 = Date.now();
  const s1 = await idx.syncFrom();
  console.log(`  scan [${s1.scanFrom}, ${s1.scanTo}]  页数=${s1.pages}  块数=${s1.blocksScanned}  日志=${s1.logsFound}  新增=${s1.inserted}  去重=${s1.deduped}  耗时=${Date.now() - t0}ms`);
  check('第一次同步从 deploymentBlock 开始', s1.scanFrom === deploymentBlock, s1.scanFrom);
  check('分页跨越多个 block-range (页数 > 1)', s1.pages > 1, `pages=${s1.pages}`);
  check('每页 ≤ pageSize=8', s1.ranges.every((r: any) => r.to - r.from + 1 <= 8));
  check('区间无缝无重叠且完整覆盖 [deploymentBlock, head]',
    s1.ranges[0].from === deploymentBlock && s1.ranges[s1.ranges.length - 1].to === s1.scanTo &&
    s1.ranges.every((r: any, i: number) => i === 0 || r.from === s1.ranges[i - 1].to + 1),
    `${s1.ranges.length} 页`);
  check('块数 = head - deploymentBlock + 1', s1.blocksScanned === s1.scanTo - deploymentBlock + 1, s1.blocksScanned);
  const tlA = idx.timeline(A.taskKey);
  check('A 的三条真事件都入库 (create/proof/release)',
    tlA.events.map((e: any) => e.eventName).join(',') === 'EscrowCreatedV2,ProofSubmittedV2,ReleasedV2',
    tlA.events.map((e: any) => `${e.eventName}@${e.blockNumber}`).join(' '));
  check('A 的溯源状态 = RELEASED', tlA.state === 'RELEASED', tlA.state);
  const relEntry = tlA.events.find((e: any) => e.eventName === 'ReleasedV2');
  check('ReleasedV2 解码字段正确 (to/amount/by)', relEntry.args.by === '0' && BigInt(relEntry.args.amount) === AMOUNT && String(relEntry.args.to).toLowerCase() === agent.address.toLowerCase(), j(relEntry.args));
  check('索引高度 = head', idx.status().lastSyncedBlock === s1.scanTo, `${idx.status().lastSyncedBlock}/${s1.scanTo}`);
  check('索引文件已落盘 (~/.bolloon/chain/index.json)', fs.existsSync(path.join(HOME, '.bolloon', 'chain', 'index.json')), idx.indexPath);

  // ═══════════════════════════════════════════════════════════════════════
  section('④ 增量: 第二次同步不重扫 (无新块 → 空转; 有新块 → 只扫新区间)');
  const before = idx.load().entries.length;
  const s2 = await idx.syncFrom();
  check('无新块时: 0 页 / 0 块 / 0 新增', s2.pages === 0 && s2.blocksScanned === 0 && s2.inserted === 0, `pages=${s2.pages} blocks=${s2.blocksScanned}`);
  check('索引条数不变 (幂等)', idx.load().entries.length === before, before);

  const B = await mkEscrow('B');
  const s3 = await idx.syncFrom();
  console.log(`  B create   tx=${B.txHash} block=${B.blockNumber}`);
  console.log(`  增量区间   [${s3.scanFrom}, ${s3.scanTo}]  块数=${s3.blocksScanned}  新增=${s3.inserted}`);
  check('★ 增量不重扫: 起点 = 上次高度 + 1', s3.scanFrom === s2.scanTo + 1, `${s3.scanFrom} = ${s2.scanTo}+1`);
  check('★ 所有区间都落在 [lastSyncedBlock+1, head] 内', s3.ranges.every((r: any) => r.from > s2.scanTo), j(s3.ranges));
  check('只新增 B 的那 1 条 (A 的 3 条没被重扫成重复)', s3.inserted === 1 && s3.deduped === 0, `inserted=${s3.inserted} deduped=${s3.deduped}`);
  check('B 的 EscrowCreatedV2 入库', idx.timeline(B.taskKey).events.length === 1);

  section('⑤ 去重: 显式从 deploymentBlock 全量补扫 → 0 重复');
  const total = idx.load().entries.length;
  const s4 = await idx.syncFrom(deploymentBlock);
  console.log(`  全量补扫 [${s4.scanFrom}, ${s4.scanTo}]  日志=${s4.logsFound}  新增=${s4.inserted}  命中去重=${s4.deduped}`);
  check('★ 全量补扫: 新增 0 条, 全部命中去重', s4.inserted === 0 && s4.deduped === total, `inserted=${s4.inserted} deduped=${s4.deduped} total=${total}`);
  check('索引条数不变 (幂等重跑无重复)', idx.load().entries.length === total, total);
  const keys = idx.load().entries.map((e: any) => e.key);
  check('所有 key 唯一 (txHash:logIndex)', new Set(keys).size === keys.length, `${new Set(keys).size}/${keys.length}`);

  // ═══════════════════════════════════════════════════════════════════════
  section('⑥ finality 分层: 等 12 个块 → 老事件 confirmed → finalized');
  const confBefore = idx.timeline(A.taskKey).events[0].finality;
  await mine(12);
  const s5 = await idx.syncFrom();
  const aCreated = idx.timeline(A.taskKey).events[0];
  console.log(`  A.create 块=${aCreated.blockNumber} 确认数=${aCreated.confirmations} finality: ${confBefore} → ${aCreated.finality}`);
  check('A.create 升级为 finalized (≥12 确认)', aCreated.finality === 'finalized', `${aCreated.finality} (${aCreated.confirmations} 确认)`);
  const stats0 = getIndexStats({ home: HOME });
  console.log(`  byFinality: ${j(stats0.byFinality)}`);
  check('finality 三档之和 = 索引总条数', stats0.byFinality.observed + stats0.byFinality.confirmed + stats0.byFinality.finalized === stats0.entries, j(stats0.byFinality));
  check('B (较新) 仍是 confirmed 或 finalized (按确认数分层)', ['confirmed', 'finalized'].includes(idx.timeline(B.taskKey).events[0].finality));

  // ═══════════════════════════════════════════════════════════════════════
  section('⑦ 重组: anvil_rollback 回退掉含真事件的块 → 标 suspect (不删) + 同一笔 raw 重新打包复位');
  const D = await mkEscrow('D'); // 顶块上的真事件
  const s6 = await idx.syncFrom();
  const dEntry = idx.timeline(D.taskKey).events[0];
  console.log(`  D create   tx=${D.txHash} block=${D.blockNumber}  索引块=${dEntry.blockNumber}  suspect=${dEntry.suspect}`);
  check('D 的真事件已入库且未标可疑', !!dEntry && dEntry.suspect === false, dEntry?.key);
  const headBeforeReorg = await provider.getBlockNumber();

  let usedRollback = false;
  // 共享 anvil 上别的进程也在出块 → 回退**深度**要算出来 (head - D 的块号 + 1), 不能写死 1,
  // 否则可能回退掉别人的空块, 而 D 的那个块还在链上。
  let rollbackDepth = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const h = await provider.getBlockNumber();
    rollbackDepth = Math.max(1, h - D.blockNumber + 1);
    try {
      await provider.send('anvil_rollback', [rollbackDepth]);
      usedRollback = true;
    } catch (e: any) {
      console.log(`  ⚠ anvil_rollback 不可用: ${String(e?.message || e).slice(0, 80)}`);
      break;
    }
    const gone = (await provider.getTransactionReceipt(D.txHash)) === null;
    if (gone) break;
    console.log(`  ⚠ anvil_rollback 深度 ${rollbackDepth} 没盖住 D 的块 (head 仍在动) → 重试`);
  }
  const headAfterRollback = await provider.getBlockNumber();
  console.log(`  anvil_rollback [${rollbackDepth}] → head ${headBeforeReorg} → ${headAfterRollback} (used=${usedRollback})`);
  let rollbackTxGone = false;
  try { rollbackTxGone = (await provider.getTransactionReceipt(D.txHash)) === null; } catch { rollbackTxGone = true; }
  check('★ 真回滚: D 的交易在链上已不存在 (receipt=null)', rollbackTxGone, `tx=${D.txHash} depth=${rollbackDepth}`);

  const s7 = await idx.syncFrom();
  console.log(`  重扫 [${s7.scanFrom}, ${s7.scanTo}]  markedSuspect=${s7.markedSuspect}  rewoundTo=${s7.rewoundTo}  orphans=${s7.orphans.length}`);
  const dAfter = idx.timeline(D.taskKey).events[0];
  check('★ 被回退的记录**仍在索引里** (不是静默丢弃)', !!dAfter && dAfter.key === dEntry.key, dAfter?.key);
  check('★ 被回退的记录标 suspect=true', dAfter?.suspect === true, dAfter?.suspectReason);
  check('★ 被回退的记录 finality 降为 observed', dAfter?.finality === 'observed', dAfter?.finality);
  check('★ 索引高度回退到新 head', idx.status().lastSyncedBlock === headAfterRollback, `${idx.status().lastSyncedBlock}/${headAfterRollback}`);
  check('★ 回退后索引高度 < 该记录块号 (记录已不在已扫区间内, 所以只能靠 suspect 表达)', idx.status().lastSyncedBlock < dEntry.blockNumber, `${idx.status().lastSyncedBlock} < ${dEntry.blockNumber}`);
  check('★ orphans 明确列出该记录 (回退后未再出现)', s7.orphans.includes(dEntry.key), j(s7.orphans.slice(0, 3)));
  check('A/B 的更早事件不受影响 (未被误标)', idx.timeline(A.taskKey).events.every((e: any) => !e.suspect), idx.timeline(A.taskKey).events.map((e: any) => e.suspect).join(','));

  // 用**同一笔 raw 交易**重新打包 (同 txHash + 同 logIndex) → suspect 应被复位。
  // 注意: 共享 anvil 上别人可能刚用掉这个 nonce → raw 重放会撞 nonce; 撞了就如实降级 (不等于删掉断言)。
  let replayOk = false;
  let replayNote = '';
  for (let attempt = 1; attempt <= 3 && !replayOk; attempt++) {
    try {
      const replay = await provider.broadcastTransaction(D.raw);
      const rc = await replay.wait();
      replayOk = true;
      console.log(`  同一笔 raw 重新打包 → tx=${replay.hash} block=${rc!.blockNumber}`);
    } catch (e: any) {
      replayNote = String(e?.shortMessage || e?.message || e).slice(0, 100);
      await sleep(500);
    }
  }
  if (replayOk) {
    const s8 = await idx.syncFrom();
    const dRestored = idx.timeline(D.taskKey).events[0];
    console.log(`  restored=${s8.restored}  复位后 suspect=${dRestored?.suspect} block=${dRestored?.blockNumber}`);
    check('同一 txHash 重新上链 → key 仍是同一条 (去重没被破坏)', dRestored?.key === dEntry.key, `${dRestored?.key} vs ${dEntry.key}`);
    check('★ 重新出现 → suspect 复位 (restored ≥ 1)', s8.restored >= 1 && dRestored?.suspect === false, `restored=${s8.restored}`);
    check('复位后记了 history (可回放)', (idx.load().entries.find((e: any) => e.key === dEntry.key)!.history as any[]).some((h: any) => /重新上链|复位/.test(String(h.note))), j((idx.load().entries.find((e: any) => e.key === dEntry.key)!.history as any[]).slice(-1)));
    check('复位后统计里 suspects 归零', getIndexStats({ home: HOME }).suspects === 0, getIndexStats({ home: HOME }).suspects);
  } else {
    // 共享链 nonce 竞争 → raw 重放不可行。如实说明, 并换一条**能验的事**:
    // 新发一笔 (新 txHash) → 必须作为新条目入库, 而那条被回退的记录**仍然留在索引里为 suspect**。
    console.log(`  ⚠ 共享 anvil nonce 竞争: raw 重放失败 (${replayNote}) → 本机无法强制"同一 txHash 重新上链"`);
    console.log(`     (该路径在单测 src/test/chain-indexer.test.ts 里用假链覆盖: 换块复位 + 同块同哈希复位 共 2 条)`);
    const D2 = await mkEscrow('D2');
    await idx.syncFrom();
    const stillSuspect = idx.timeline(D.taskKey).events[0];
    const newEntry = idx.timeline(D2.taskKey).events[0];
    check('★ (降级验证) 被回退的记录仍留在索引里为 suspect, 新交易照常入库', stillSuspect?.suspect === true && !!newEntry && newEntry.suspect === false, `旧=${stillSuspect?.suspect} 新=${newEntry?.key?.slice(0, 20)}…`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('⑧ F2b ExpiredV2: 真事件也能被索引解码');
  const E = await mkEscrow('E', { deadline: BigInt((await provider.getBlock('latest'))!.timestamp) + 10n, window: 60 });
  const expireAt = BigInt(await escrow.expireAt(E.taskKey));
  const nowTs = BigInt((await provider.getBlock('latest'))!.timestamp);
  const jump = Number(expireAt - nowTs) + 60;
  await provider.send('evm_increaseTime', [jump]);
  await provider.send('evm_mine', []);
  console.log(`  E create   tx=${E.txHash} block=${E.blockNumber}; 时间旅行 +${jump}s (越过 expireAt=${expireAt})`);
  let expireOut: any = null;
  try {
    expireOut = await sendRaw(() => escrow.connect(third).expireV2.populateTransaction(E.taskKey), third);
  } catch (e: any) {
    console.log(`  ⚠ expireV2 发交易失败: ${String(e?.shortMessage || e?.message || e).slice(0, 120)}`);
  }
  if (expireOut) {
    console.log(`  E expire   tx=${expireOut.txHash} block=${expireOut.blockNumber} status=${expireOut.status}`);
    const s9 = await idx.syncFrom();
    const exp = idx.timeline(E.taskKey).events.find((e: any) => e.eventName === 'ExpiredV2');
    check('★ 真链 ExpiredV2 被索引并解码 (caller/refundedTo/amount)',
      !!exp && String(exp.args.refundedTo).toLowerCase() === buyer.address.toLowerCase() && BigInt(exp.args.amount) === AMOUNT && Number(expireOut.status) === 1,
      exp ? `${j(exp.args)} @${exp.blockNumber}` : `inserted=${s9.inserted}`);
    check('stats.expired ≥ 1', getIndexStats({ home: HOME }).expired >= 1, getIndexStats({ home: HOME }).expired);
  } else {
    check('★ 真链 ExpiredV2 被索引并解码', false, 'expireV2 未能发出 (见上)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('⑨ 从 deployment block 全量重建 == 增量结果');
  const incEntries = idx.load().entries;
  t0 = Date.now();
  const rb = await idx.rebuild({ persist: false });
  console.log(`  rebuild: 扫 [${rb.ranges[0].from}, ${rb.ranges[rb.ranges.length - 1].to}]  页数=${rb.pages}  块数=${rb.blocksScanned}  日志=${rb.logsFound}  条数=${rb.entries}  耗时=${Date.now() - t0}ms`);
  const cmp = rb.comparison;
  console.log(`  比对: same=${cmp.same} countA=${cmp.countA} countB=${cmp.countB} missing=${cmp.missingInB.length} extra=${cmp.extraInB.length} mismatch=${cmp.mismatched.length}`);
  check('★ 重建起点 = deploymentBlock (不是 0, 也不是上次高度)', rb.ranges[0].from === deploymentBlock, rb.ranges[0].from);
  check('★ 重建结果与增量结果逐条一致 (same=true)', cmp.same === true, j({ missing: cmp.missingInB.slice(0, 2), extra: cmp.extraInB.slice(0, 2), mismatch: cmp.mismatched.slice(0, 2) }));
  check('重建条数 = 增量条数 (非 suspect)', rb.entries === incEntries.filter((e: any) => !e.suspect).length, `${rb.entries} vs ${incEntries.filter((e: any) => !e.suspect).length}`);
  const rbPersist = await idx.rebuild({ persist: true });
  check('rebuild(persist=true) 落盘后 rebuiltAt 记录在案', idx.load().rebuiltAt > 0 && rbPersist.comparison.same === true, idx.status().rebuiltAt);
  check('重建后 lastSyncedBlock = head', idx.status().lastSyncedBlock === rbPersist.headBlock, `${idx.status().lastSyncedBlock}/${rbPersist.headBlock}`);

  section('⑩ 分页边界 (真链): pageSize=1 vs pageSize=2000 两次全量重建必须逐条一致');
  const idxBig = mkIdx({ pageSize: 2000, indexPath: path.join(TMP, 'pbig.json') });
  t0 = Date.now();
  const bigRes = await idxBig.rebuild({ persist: true });
  const tBig = Date.now() - t0;
  const idx1 = mkIdx({ pageSize: 1, indexPath: path.join(TMP, 'p1.json') });
  t0 = Date.now();
  const oneRes = await idx1.rebuild({ persist: true });
  const tOne = Date.now() - t0;
  console.log(`  pageSize=2000: 页数=${bigRes.pages} 块数=${bigRes.blocksScanned} 条数=${bigRes.entries} 耗时=${tBig}ms`);
  console.log(`  pageSize=1   : 页数=${oneRes.pages} 块数=${oneRes.blocksScanned} 条数=${oneRes.entries} 耗时=${tOne}ms`);
  const cmp2 = compareIndexes(idx1.load().entries, idxBig.load().entries);
  check('★ 逐块扫 (pageSize=1) 与整段扫 (pageSize=2000) 结果逐条一致 (跨越多个 block-range 不错漏)', cmp2.same === true, j({ countA: cmp2.countA, countB: cmp2.countB, missing: cmp2.missingInB.slice(0, 3), mismatch: cmp2.mismatched.slice(0, 3) }));
  check('pageSize=1 时页数 = 块数 (每块一页)', oneRes.pages === oneRes.blocksScanned, `${oneRes.pages}/${oneRes.blocksScanned}`);
  check('pageSize=2000 时页数更少但条数相同', bigRes.pages < oneRes.pages && bigRes.entries === oneRes.entries, `${bigRes.pages} < ${oneRes.pages}`);
  check('两种分页方式都与主索引逐条一致', compareIndexes(idxBig.load().entries, idx.load().entries.filter((e: any) => !e.suspect)).same === true);

  section('⑪ 只读查询接口 (对真索引读数)');
  const status = getIndexStatus({ home: HOME });
  console.log(`  status : 链=${status.chainId} escrow=${status.escrowAddress} 起点=${status.deploymentBlock} 高度=${status.lastSyncedBlock} head=${status.headBlock} 条数=${status.entries} suspect=${status.suspects}`);
  console.log(`           最后同步 ${new Date(status.lastSyncedAt).toISOString()} (${(status.lastSyncedAgoMs! / 1000).toFixed(1)}s 前) 确认门槛 confirmed=${status.confirmations.confirmed}/finalized=${status.confirmations.finalized}`);
  check('索引高度 + 最后同步时间可读', Number.isInteger(status.lastSyncedBlock) && status.lastSyncedAt > 0, `h=${status.lastSyncedBlock}`);
  const chainHeadNow = await provider.getBlockNumber();
  check('索引高度 = 链 head', status.lastSyncedBlock === chainHeadNow, `索引=${status.lastSyncedBlock} 链=${chainHeadNow}`);
  const stats = getIndexStats({ home: HOME });
  console.log(`  stats  : tasks=${stats.tasks} created=${stats.created} proof=${stats.proofSubmitted} released=${stats.released} refunded=${stats.refunded} disputed=${stats.disputed} expired=${stats.expired} suspects=${stats.suspects}`);
  console.log(`           byFinality=${j(stats.byFinality)} byEvent=${j(stats.byEvent)}`);
  check('统计里 tasks/released/expired 都 ≥ 我们的真事件数', stats.tasks >= 3 && stats.released >= 1 && stats.expired >= 1, j({ tasks: stats.tasks, released: stats.released, expired: stats.expired }));
  check('tasks = 去重的 EscrowCreatedV2 数', stats.tasks === new Set(idx.load().entries.filter((e: any) => e.eventName === 'EscrowCreatedV2' && !e.suspect).map((e: any) => e.taskKey)).size);
  const tlA2 = getEscrowTimeline(A.taskKey, { home: HOME });
  console.log(`  timeline(A): ${tlA2.count} 条 → ${tlA2.events.map((e: any) => `${e.eventName}@${e.blockNumber}(${e.finality})`).join(' ')}`);
  check('按 taskKey 查时间线正确 (3 条 + RELEASED)', tlA2.count === 3 && tlA2.state === 'RELEASED');
  const p1 = fetchIndexSince(null, { home: HOME, limit: 5 });
  const p2 = fetchIndexSince(p1.nextCursor, { home: HOME, limit: 5 });
  console.log(`  cursor : 第1页 ${p1.events.length} 条 remaining=${p1.remaining} next=(${p1.nextCursor.blockNumber},${p1.nextCursor.logIndex}) → 第2页首条 block=${p2.events[0]?.blockNumber}`);
  check('cursor 增量拉取: 严格大于 cursor 且可续拉', p1.events.length === 5 && (p2.events[0].blockNumber > p1.nextCursor.blockNumber || (p2.events[0].blockNumber === p1.nextCursor.blockNumber && p2.events[0].logIndex > p1.nextCursor.logIndex)), `(${p1.nextCursor.blockNumber},${p1.nextCursor.logIndex})`);
  check('cursor 无新数据时返回空 (不重复吐)', fetchIndexSince({ blockNumber: stats.headBlock!, logIndex: 999 }, { home: HOME }).events.length === 0, `head=${stats.headBlock}`);
  const cursorTotal = (() => { let c: any = null, n = 0, guard = 0; for (;;) { const pg = fetchIndexSince(c, { home: HOME, limit: 7 }); n += pg.events.length; c = pg.nextCursor; if (!pg.hasMore || ++guard > 200) break; } return n; })();
  check('cursor 分页把所有条目拉完 (总数一致)', cursorTotal === stats.entries, `${cursorTotal}/${stats.entries}`);

  // ═══════════════════════════════════════════════════════════════════════
  section('⑪b ★ 索引身份 (换合约部署 ≠ 重组): sync 拒绝混数据 / rebuild 干净重建');
  const DEAD_ESCROW = '0x' + '9b'.repeat(20);      // 上一轮部署的 escrow (当前链上 eth_getCode = 0x)
  const deadCode = await provider.getCode(DEAD_ESCROW);
  const oldPath = path.join(TMP, 'index-old-deployment.json');
  // 用**旧身份**在真节点上扫一次, 造出"上一轮部署留下的索引文件" (真文件, 真 lastSyncedAt)
  const oldIdx = new ChainIndexer({
    provider, escrowAddress: DEAD_ESCROW, chainId: LOCAL_DEV_CHAIN_ID, networkName: 'localhost',
    deploymentBlock, home: HOME, indexPath: oldPath, pageSize: 200,
  });
  await oldIdx.syncFrom();
  const oldRaw = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  console.log(`  旧索引: identity=${j(oldRaw.identity)}  entries=${oldRaw.entries.length}  runs=${oldRaw.runs.length}`);
  check('旧部署索引已落盘, 且写着**自己的**身份 (chainId + escrowAddress + 部署块)',
    oldRaw.identity?.chainId === LOCAL_DEV_CHAIN_ID && oldRaw.identity?.escrowAddress === DEAD_ESCROW.toLowerCase() && oldRaw.identity?.deploymentBlock === deploymentBlock,
    j(oldRaw.identity));
  check('旧 escrow 在当前链上确实没有合约 (eth_getCode=0x) —— 身份变更的真实现场', deadCode === '0x', `code=${String(deadCode).slice(0, 12)}`);

  // 同一条链 / 同一份索引文件, 换成**当前**身份 → sync 必须拒绝 (不扫、不写、不报重组)
  const curIdx = new ChainIndexer({
    provider, escrowAddress: local.escrowAddress, chainId: LOCAL_DEV_CHAIN_ID, networkName: 'localhost',
    deploymentBlock, home: HOME, indexPath: oldPath, pageSize: 200,
  });
  const beforeTxt = fs.readFileSync(oldPath, 'utf8');
  let idErr: any = null;
  try { await curIdx.syncFrom(); } catch (e: any) { idErr = e; }
  console.log(`  sync(当前身份) → ${idErr ? `${idErr.code} / next=${idErr.nextAction}` : '没报错 (❌ 该拒绝)'}`);
  check('★ sync 遇身份变更 → 抛 INDEX_IDENTITY_CHANGED (不是 REORG_SUSPECTED), next_action=needs_human',
    idErr?.code === INDEX_IDENTITY_CHANGED && idErr?.nextAction === 'needs_human', idErr?.code ?? '(无错)');
  check('★ 拒绝时如实给出 old/new 身份 + 修法命令',
    idErr?.oldIdentity?.escrowAddress === DEAD_ESCROW.toLowerCase() && idErr?.newIdentity?.escrowAddress === local.escrowAddress.toLowerCase() && String(idErr?.suggestedCommand).includes('chain index rebuild'),
    j({ old: idErr?.oldIdentity, new: idErr?.newIdentity, fix: idErr?.suggestedCommand }));
  check('★ 拒绝时索引文件**逐字节未变** (绝不把两个身份混在一起)', fs.readFileSync(oldPath, 'utf8') === beforeTxt, `${beforeTxt.length} bytes`);
  check('★ 拒绝时没有追加 run 记录 (没扫、没写)', JSON.parse(fs.readFileSync(oldPath, 'utf8')).runs.length === oldRaw.runs.length);

  // rebuild → 干净重建: 采用当前身份, 旧身份记录一条不留
  const idRb = await curIdx.rebuild({ persist: true });
  console.log(`  rebuild → identityChanged=${idRb.identityChanged} 丢弃=${idRb.discardedEntries} 条数=${idRb.entries} 起止=[${idRb.ranges[0].from}, ${idRb.ranges[0].to}]`);
  check('★ rebuild 报 identityChanged=true + old/new 身份 + 丢弃条数 (不粉饰)',
    idRb.identityChanged === true && idRb.oldIdentity?.escrowAddress === DEAD_ESCROW.toLowerCase() && idRb.newIdentity.escrowAddress === local.escrowAddress.toLowerCase() && idRb.discardedEntries === oldRaw.entries.length,
    j({ changed: idRb.identityChanged, discarded: idRb.discardedEntries, old: idRb.oldIdentity }));
  const newRaw = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  check('★ 干净重建后索引身份 = 当前 (escrow/部署块都换成新值, 不再沿用旧文件的)',
    newRaw.escrowAddress.toLowerCase() === local.escrowAddress.toLowerCase() && newRaw.deploymentBlock === deploymentBlock && newRaw.identity.escrowAddress === local.escrowAddress.toLowerCase(),
    j({ escrowAddress: newRaw.escrowAddress, deploymentBlock: newRaw.deploymentBlock, identity: newRaw.identity }));
  check('★ 重建后每一条记录都属于当前身份 (旧 escrow 一条不留, 也不是标 suspect)',
    newRaw.entries.length === idRb.entries && newRaw.entries.every((e: any) => e.address.toLowerCase() === local.escrowAddress.toLowerCase())
      && newRaw.entries.every((e: any) => e.blockNumber >= deploymentBlock),
    `${newRaw.entries.length} 条, suspects=${newRaw.entries.filter((e: any) => e.suspect).length}`);
  check('★ 干净重建重扫出的事件数 = 主索引的真实事件数 (数据没丢, 丢的只是旧身份)',
    newRaw.entries.length === idx.load().entries.filter((e: any) => !e.suspect).length,
    `${newRaw.entries.length} vs ${idx.load().entries.filter((e: any) => !e.suspect).length}`);
  const afterFix = await curIdx.syncFrom();
  check('★ 修完之后 sync 恢复正常 (身份已一致, 增量照常)', afterFix.lastSyncedBlock === afterFix.headBlock, `h=${afterFix.lastSyncedBlock}`);
  const noChange = await idx.rebuild({ persist: true });
  check('身份未变时 rebuild 行为与历史一致 (identityChanged=false, 不丢弃任何记录, 仍与增量逐条 same)',
    noChange.identityChanged === false && noChange.discardedEntries === 0 && noChange.comparison.same === true,
    j({ changed: noChange.identityChanged, discarded: noChange.discardedEntries, same: noChange.comparison.same }));

  // ═══════════════════════════════════════════════════════════════════════
  if (!ONLY_LOCAL) {
    section('⑫ Base Sepolia 真网只读同步 (从 manifest 的 deployment block 开始)');
    const sep = manifestDeployment('base-sepolia');
    const sepInfo = resolveDeploymentInfo({
      chainId: sep.chainId, escrowAddress: sep.escrowAddress,
      deploymentsDir: path.resolve(process.cwd(), 'contracts/deployments'),
    });
    console.log(`  RPC          : ${sep.rpcUrl}`);
    console.log(`  chainId      : ${sep.chainId}   escrow: ${sep.escrowAddress}`);
    console.log(`  起点         : deploymentBlock=${sepInfo.deploymentBlock}  (来源: ${sepInfo.source})`);
    const sepProvider = createJsonRpcProvider(sep.rpcUrl) as JsonRpcProvider;
    let sepNet: any;
    try { sepNet = await sepProvider.getNetwork(); } catch (e: any) {
      check('Base Sepolia RPC 可达', false, String(e?.message || e).slice(0, 120));
    }
    if (sepNet) {
      const sepHead = await sepProvider.getBlockNumber();
      check('Base Sepolia chainId == 84532', Number(sepNet.chainId) === 84532, Number(sepNet.chainId));
      const sepCode = await sepProvider.getCode(sep.escrowAddress);
      check('Base Sepolia 上 escrow 地址有 bytecode (链身份核对)', String(sepCode).length > 2, `${(String(sepCode).length - 2) / 2} bytes`);
      console.log(`  当前 head    : ${sepHead}  待扫块数: ${sepHead - sepInfo.deploymentBlock + 1}`);

      // (a) 分页同步 (pageSize=100)
      const sepIdx = new ChainIndexer({
        provider: sepProvider, escrowAddress: sep.escrowAddress, chainId: sep.chainId, networkName: 'base-sepolia',
        deploymentBlock: sepInfo.deploymentBlock, home: HOME, indexPath: path.join(TMP, 'base-sepolia-index.json'),
        pageSize: 100, reorgDepth: 8,
      });
      t0 = Date.now();
      const ss = await sepIdx.syncFrom();
      const dt = Date.now() - t0;
      // 注意: Base Sepolia 约 2s 出块 → 同步期间 head 会往前挪。所有覆盖性断言都用**同步自己读到的 head** (ss.scanTo),
      // 不用扫描前读到的 sepHead (否则链一动断言就假失败)。
      console.log(`  同步结果     : 扫 [${ss.scanFrom}, ${ss.scanTo}]  页数=${ss.pages}  块数=${ss.blocksScanned}  日志=${ss.logsFound}  新增=${ss.inserted}  耗时=${dt}ms`);
      console.log(`  扫过的区间   : ${ss.ranges.length <= 6 ? j(ss.ranges) : `${j(ss.ranges.slice(0, 3))} … ${j(ss.ranges.slice(-2))} (共 ${ss.ranges.length} 页)`}`);
      check('★ 真网同步: 事件数如实为 0 (没有就报没有)', ss.inserted === 0 && sepIdx.load().entries.length === 0, `logsFound=${ss.logsFound}`);
      check('★ 证明"确实扫过了": 区间从 deploymentBlock 连续覆盖到 head',
        ss.ranges[0].from === sepInfo.deploymentBlock && ss.ranges[ss.ranges.length - 1].to === ss.scanTo &&
        ss.ranges.every((r: any, i: number) => i === 0 || r.from === ss.ranges[i - 1].to + 1),
        `${ss.ranges.length} 页 / ${ss.blocksScanned} 块, 扫描期间 head ${sepHead} → ${ss.scanTo}`);
      check('真网 blocksScanned = head - deploymentBlock + 1', ss.blocksScanned === ss.scanTo - sepInfo.deploymentBlock + 1, ss.blocksScanned);
      check('真网索引高度 = head, 最后同步时间已记', sepIdx.status().lastSyncedBlock === ss.scanTo && sepIdx.status().lastSyncedAt > 0, `${sepIdx.status().lastSyncedBlock}`);
      check('真网全量统计: 全部 0 (tasks/released/refunded/disputed/expired)', (() => {
        const s = sepIdx.stats();
        return s.tasks === 0 && s.released === 0 && s.refunded === 0 && s.disputed === 0 && s.expired === 0;
      })(), j(sepIdx.stats()));

      // (b) 全量重建 (同一区间, 应与增量一致 —— 两边都是空)
      const sepRb = await sepIdx.rebuild({ persist: true });
      check('真网 rebuild: 同样 0 条, 与增量比对 same=true', sepRb.comparison.same === true && sepRb.entries === 0, `same=${sepRb.comparison.same} entries=${sepRb.entries}`);
      console.log(`  真网 rebuild : 扫 [${sepRb.ranges[0].from}, ${sepRb.ranges[sepRb.ranges.length - 1].to}] 页数=${sepRb.pages} 块数=${sepRb.blocksScanned} 日志=${sepRb.logsFound} 条数=${sepRb.entries}`);

      // (c) provider 的 block-range 限制: 单次把整段塞进一个 getLogs 会怎样 (记录事实, 不假设)
      const bigIdx = new ChainIndexer({
        provider: sepProvider, escrowAddress: sep.escrowAddress, chainId: sep.chainId, networkName: 'base-sepolia',
        deploymentBlock: sepInfo.deploymentBlock, home: HOME, indexPath: path.join(TMP, 'base-sepolia-big.json'),
        pageSize: Math.max(1, sepHead - sepInfo.deploymentBlock + 1), reorgDepth: 4,
      });
      const totalBlocks = sepHead - sepInfo.deploymentBlock + 1;
      try {
        const big = await bigIdx.syncFrom();
        const rs = big.ranges;
        const covered = rs.length > 0 && rs[0].from === sepInfo.deploymentBlock && rs[rs.length - 1].to === big.scanTo
          && rs.every((r: any, i: number) => i === 0 || r.from === rs[i - 1].to + 1);
        const note = (bigIdx.load().runs.slice(-1)[0] as any)?.note || '';
        console.log(`  单次大区间 getLogs: ${big.pages === 1 ? `被接受 (1 次调用扫 ${totalBlocks} 块)` : `被拒 → 自适应对半拆成 ${big.pages} 页${note ? ` (${note})` : ''}`}`);
        check('★ 单次超大区间: 被接受或对半拆兜底, 区间仍无缝覆盖全部块 (不漏扫)',
          covered && big.scanFrom === sepInfo.deploymentBlock && big.inserted === 0,
          `${big.pages} 页 覆盖=${covered} 块数=${big.blocksScanned}`);
      } catch (e: any) {
        check('★ 单次超大区间: 被接受或对半拆兜底, 区间仍无缝覆盖全部块 (不漏扫)', false, `抛错: ${String(e?.shortMessage || e?.message || e).slice(0, 120)}`);
      }
      try { (sepProvider as any).destroy?.(); } catch { /* noop */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('汇总');
  console.log(`  临时 HOME (索引落盘处): ${HOME}` + (fs.existsSync(path.join(HOME, '.bolloon', 'chain', 'index.json')) ? `  (${fs.statSync(path.join(HOME, '.bolloon', 'chain', 'index.json')).size} bytes)` : ''));
  const finalStatus = getIndexStatus({ home: HOME });
  console.log(`  本地索引: 起点块=${finalStatus.deploymentBlock} 高度=${finalStatus.lastSyncedBlock} 条数=${finalStatus.entries} suspect=${finalStatus.suspects} 最后同步=${new Date(finalStatus.lastSyncedAt!).toISOString()}`);
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);

  try { (provider as any).destroy?.(); } catch { /* noop */ }
  if (process.env.KEEP_TMP !== '1') fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`  (KEEP_TMP=1 → 保留 ${TMP})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[verify-chain-indexer] 失败:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
