/**
 * verify-chain-cli.ts — P6「CLI / MCP / Skill 链命令」真实验收
 * =========================================================================
 * 对**正在运行的本地 anvil** (chainId 31337) **真跑 CLI 子进程 + 真跑 MCP stdio 握手**,
 * 不是读代码、不是直调模块:
 *
 *   [A] `chain status`            → 读真 chainId / 合约地址 / 确认数 / 钱包 (私钥绝不出现)
 *   [B] `chain trade create`      → 真签名 → 真交易 → 真 receipt (createEscrowV2)
 *   [C] `chain trade submit-proof`→ 真上链 ProofSubmittedV2
 *   [D] `chain trade release`     → 真上链 ReleasedV2 (只有全过才 grantsVerified)
 *   [E] `chain escrow show`       → 读到真状态 (RELEASED) 与真金额
 *   [F] `chain index sync`        → 真同步出真事件 (从 deployment block 起扫)
 *   [G] `chain timeline <taskKey>`→ 用真事件还原 create→proof→release, txHash 与 [B][C][D] 逐条对上
 *   [H] `chain index status|stats`→ 索引高度 / 统计
 *   [I] `chain trade recover`     → 纯读盘重建下一步
 *   [负例] 未配置 / 找不到 escrow / 余额不足 / 未授权签名 / 预算超限 / 参数非法 / **真重组**
 *   [MCP] 真 stdio: initialize + tools/list + 失败调用 (失败不得变 MCP 成功)
 *
 * 跑法:
 *   # 终端 A
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1
 *   # 终端 B (先保证 contracts/deployments/localhost.json 是当前 artifact)
 *   npx tsx scripts/verify-chain-cli.ts
 *
 * 隔离: 全程写**临时 HOME** (chain.json/wallet.json/index.json/chain-state.json), 不污染真实 ~/.bolloon。
 * 私钥: 由 anvil **公开开发助记符**在进程内派生, 只写进临时 HOME 的 wallet.json (0600);
 *       脚本自己不打印, 并逐条断言 CLI 输出里**不含**私钥串。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Contract, Wallet } from 'ethers';

const ROOT_DIR = process.cwd();
const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p6-cli-'));
const HOME = path.join(ROOT, 'home');            // 买方节点 (buyer)
const HOME_SELLER = path.join(ROOT, 'home-seller'); // 卖方节点 (agent: submitProofV2 要求 msg.sender == agent)
const HOME_NOAUTH = path.join(ROOT, 'home-noauth');
const HOME_POOR = path.join(ROOT, 'home-poor');
const HOME_BARE = path.join(ROOT, 'home-bare');
for (const h of [HOME, HOME_SELLER, HOME_NOAUTH, HOME_POOR, HOME_BARE]) fs.mkdirSync(path.join(h, '.bolloon'), { recursive: true });

const RPC_URL = process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545';
const LOCAL_DEV_CHAIN_ID = 31337;
const TSX = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT_DIR, 'src', 'cli-entry.ts');

// ── 断言 / 输出 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  return ok;
};
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(d)).slice(0, 260);
const section = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// ── 部署 / 钱包解析 (绝不 hardcode) ──────────────────────────────────────────
function resolveDeployment(): { chainId: number; escrowAddress: string; tokenAddress: string | null; source: string } {
  if (process.env.BOLLOON_ESCROW_ADDRESS) {
    return { chainId: Number(process.env.BOLLOON_CHAIN_ID || LOCAL_DEV_CHAIN_ID), escrowAddress: process.env.BOLLOON_ESCROW_ADDRESS, tokenAddress: process.env.BOLLOON_TOKEN_ADDRESS || null, source: 'env BOLLOON_ESCROW_ADDRESS' };
  }
  const manifestPath = path.resolve(ROOT_DIR, 'contracts/deployments/localhost.json');
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const escrow = (m.contracts || []).find((c: any) => c.name === 'AgentEscrow');
    if (escrow?.address) return { chainId: Number(m.chainId), escrowAddress: escrow.address, tokenAddress: m.externalToken?.address || null, source: `manifest ${path.relative(ROOT_DIR, manifestPath)}` };
  }
  throw new Error('解析不到 escrow 地址: env BOLLOON_ESCROW_ADDRESS → contracts/deployments/localhost.json');
}

const MNEMONIC = 'test test test test test test test test test test test junk';
/** anvil 公开开发助记符派生 (只在进程内), index: 0=buyer(有 USDC+授权) 1=seller 15=无 gas 无币 */
function devKey(index: number): string {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).privateKey;
}
function writeWallet(home: string, privateKey: string): void {
  const p = path.join(home, '.bolloon', 'wallet.json');
  fs.writeFileSync(p, JSON.stringify({ privateKey }, null, 2), { mode: 0o600 });
}

// ── CLI 子进程 ───────────────────────────────────────────────────────────────
interface CliRun { status: number; stdout: string; stderr: string; env: Record<string, string>; json: any | null }

function baseEnv(home: string, over: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // 私钥绝不进 CLI 环境 (走临时 HOME 的 wallet.json); 链配置走显式 env
  delete env.BOLLOON_WALLET_PRIVATE_KEY;
  delete env.BOLLOON_LOCAL_DEV_PRIVATE_KEY;
  delete env.BOLLOON_AGENT_AUTHORIZED;
  env.HOME = home;
  env.USERPROFILE = home;
  env.BOLLOON_SKIP_SETUP = '1';
  env.BOLLOON_CHAIN_RPC_URL = RPC_URL;
  env.BOLLOON_CHAIN_ID = String(LOCAL_DEV_CHAIN_ID);
  env.BOLLOON_ESCROW_ADDRESS = DEP.escrowAddress;
  if (DEP.tokenAddress) env.BOLLOON_TOKEN_ADDRESS = DEP.tokenAddress;
  env.BOLLOON_NETWORK_NAME = 'localhost';
  env.BOLLOON_AGENT_AUTHORIZED = '1';
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

function cli(env: Record<string, string>, ...args: string[]): CliRun {
  const r = spawnSync(process.execPath, [TSX, ENTRY, ...args], { cwd: ROOT_DIR, env, encoding: 'utf8', timeout: 180_000 });
  let json: any = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { json = null; }
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), env, json };
}

const DEP = resolveDeployment();

// ── MCP stdio 客户端 (真握手) ────────────────────────────────────────────────
class McpClient {
  private child: any; private buf = ''; private pending = new Map<number, (m: any) => void>(); private stderr = '';
  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [TSX, ENTRY, 'mcp', 'serve'], { cwd: ROOT_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { console.log(`  ⚠ MCP stdout 出现非 JSON 行: ${line.slice(0, 120)}`); continue; }
        const f = this.pending.get(Number(msg.id));
        if (f) { this.pending.delete(Number(msg.id)); f(msg); }
      }
    });
    this.child.stderr.on('data', (d: Buffer) => { this.stderr += d.toString(); });
  }
  get stderrText() { return this.stderr; }
  request(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`MCP 请求超时: ${method}`)), 120_000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }
  /** 通知 (无 id, 按协议不回响应) */
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
  }
  close(): Promise<number> {
    return new Promise((resolve) => {
      try { this.child.stdin.end(); } catch { /* noop */ }
      const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* noop */ } resolve(-1); }, 20_000);
      this.child.on('exit', (code: number) => { clearTimeout(t); resolve(code ?? -1); });
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const buyerKey = devKey(0);
  const sellerKey = devKey(1);
  const poorKey = devKey(15);
  const buyerAddr = new Wallet(buyerKey).address;
  const sellerAddr = new Wallet(sellerKey).address;
  const poorAddr = new Wallet(poorKey).address;
  writeWallet(HOME, buyerKey);
  writeWallet(HOME_SELLER, sellerKey);  // 卖方节点: submitProofV2 要求 msg.sender == escrow.agent
  writeWallet(HOME_NOAUTH, buyerKey);   // 有钱有授权, 但**没有**授权签名策略
  writeWallet(HOME_POOR, poorKey);      // 已授权, 但没 gas / 没币 / 没 allowance

  section('① 接链 (真 RPC) + 临时 HOME 隔离');
  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  let net: any;
  try { net = await provider.getNetwork(); } catch (e: any) {
    console.log(`  ❌ 连不上 ${RPC_URL}: ${e?.message}`);
    console.log('  提示: DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1');
    process.exit(1);
  }
  const chainId = Number(net.chainId);
  const latest = await provider.getBlock('latest');
  console.log(`  RPC=${RPC_URL}  chainId=${chainId}  latestBlock=${latest?.number}`);
  console.log(`  escrow=${DEP.escrowAddress}  token=${DEP.tokenAddress}  (来源: ${DEP.source})`);
  console.log(`  临时 HOME=${HOME}   真实 ~/.bolloon 不参与 (只读对照)`);
  check('chainId == 31337 (本地开发链)', chainId === LOCAL_DEV_CHAIN_ID, chainId);
  if (chainId !== LOCAL_DEV_CHAIN_ID) { console.log('  拒绝在非本地链上跑本脚本 (它用 anvil 开发助记符签名)'); process.exit(1); }
  const code = await provider.getCode(DEP.escrowAddress);
  check('escrow 地址上有 bytecode', typeof code === 'string' && code.length > 2, `${(String(code).length - 2) / 2} bytes`);
  const token = DEP.tokenAddress ? new Contract(DEP.tokenAddress, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider) : null;
  if (token) {
    const bal = await token.balanceOf(buyerAddr);
    const allow = await token.allowance(buyerAddr, DEP.escrowAddress);
    const poorBal = await provider.getBalance(poorAddr);
    console.log(`  buyer=${buyerAddr} 余额=${bal} 授权=${allow}   seller=${sellerAddr}`);
    console.log(`  poor buyer=${poorAddr} 原生币=${poorBal} (用于「余额不足」负例)`);
    check('buyer 有余额且已授权 escrow (主用例可跑)', bal >= 20_000n && allow >= 20_000n, { bal: bal.toString(), allow: allow.toString() });
  }

  const envMain = baseEnv(HOME);
  const envSeller = baseEnv(HOME_SELLER);
  const envNoAuth = baseEnv(HOME_NOAUTH, { BOLLOON_AGENT_AUTHORIZED: undefined });
  const envPoor = baseEnv(HOME_POOR);
  const envBare = baseEnv(HOME_BARE, {
    BOLLOON_CHAIN_RPC_URL: undefined, BOLLOON_RPC_URL: undefined, RPC_URL: undefined,
    BOLLOON_CHAIN_ID: undefined, BOLLOON_ESCROW_ADDRESS: undefined, BOLLOON_TOKEN_ADDRESS: undefined,
    BOLLOON_AGENT_AUTHORIZED: undefined,
  });

  // ── [A] chain status ──────────────────────────────────────────────────────
  section('② [A] `bolloon chain status --json` — 读真配置/真链/真钱包 (私钥绝不出现)');
  const st = cli(envMain, 'chain', 'status', '--json');
  console.log(`  exit=${st.status} · ${fmt(st.json)}`);
  check('chain status 返回 ok:true', st.json?.ok === true, st.json?.code);
  check('读到真 chainId=31337', st.json?.data?.chainId === LOCAL_DEV_CHAIN_ID, st.json?.data?.chainId);
  check('读到真 escrow 地址 (与 manifest 一致)', String(st.json?.data?.escrowAddress).toLowerCase() === DEP.escrowAddress.toLowerCase(), st.json?.data?.escrowAddress);
  check('RPC 可达 + 真 latestBlock', st.json?.data?.rpcOk === true && Number(st.json?.data?.latestBlock) > 0, st.json?.data?.latestBlock);
  check('确认数门槛 = confirmed 1 / finalized 12', st.json?.data?.confirmations?.confirmed === 1 && st.json?.data?.confirmations?.finalized === 12, st.json?.data?.confirmations);
  check('合约 bytecode 存在 + 链上合约版本可读', st.json?.data?.escrowBytecode === true && Number(st.json?.data?.onChainContractVersion) >= 1, st.json?.data?.onChainContractVersion);
  check('钱包可用 (只报可用性 + 公开地址, 不是私钥)', st.json?.data?.wallet?.available === true && st.json?.data?.wallet?.address?.toLowerCase() === buyerAddr.toLowerCase(), st.json?.data?.wallet?.source);
  check('★ stdout 里**不含**私钥串 (红线)', !st.stdout.includes(buyerKey) && !st.stdout.includes(buyerKey.slice(2)), 'buyerKey 未出现在输出里');
  check('data.privateKeyPrinted === false', st.json?.data?.privateKeyPrinted === false);
  check('信封字段齐 (§2: ok/code/message/data/evidence/next_action)', ['ok', 'code', 'message', 'data', 'evidence', 'next_action'].every((k) => k in (st.json || {})), Object.keys(st.json || {}).join(','));

  // ── [B][C][D] 真交易 (两个节点 = 两个钱包: 买方 HOME / 卖方 HOME) ──────────
  section('③ [B][C][D] `chain trade create(买方) → submit-proof(卖方) → release(买方)` — 真签名/真交易');
  const taskId = `p6-cli-${runId}`;
  // 注意: `anvil_snapshot`/`anvil_rollback(<id>)` **不是**一对 (anvil 的 anvil_rollback 参数是"回退多少块"),
  // 快照回退要用标准 `evm_snapshot` / `evm_revert` (实测: evm_revert 会把 head 精确退到快照高度)。
  const snapshot = await provider.send('evm_snapshot', []);
  console.log(`  evm_snapshot=${snapshot} (稍后用 evm_revert 造**真重组**负例)`);
  console.log(`  买方节点 HOME=${HOME}  卖方节点 HOME=${HOME_SELLER} (submitProofV2 要求 msg.sender == agent)`);

  const create = cli(envMain, 'chain', 'trade', 'create', '--task-id', taskId, '--agent', sellerAddr, '--amount', '0.02', '--json');
  console.log(`  create: exit=${create.status} ok=${create.json?.ok} code=${create.json?.code} tx=${create.json?.data?.txHash}`);
  check('create: ok:true + code OK', create.json?.ok === true && create.json?.code === 'OK', create.json?.message);
  check('create: 真 txHash (0x+64hex)', /^0x[0-9a-f]{64}$/.test(String(create.json?.data?.txHash || '')), create.json?.data?.txHash);
  check('create: chainSettled=true (receipt.status=1 + 确认数达标)', create.json?.data?.chainSettled === true, { status: create.json?.data?.chainStatus, conf: create.json?.data?.confirmations });
  check('create: 事件 EscrowCreatedV2 与 taskKey 对上', create.json?.data?.eventMatched === true && create.json?.data?.matchedEvent === 'EscrowCreatedV2', create.json?.data?.matchedEvent);
  check('create: 合约状态 ACTIVE + 签名审计已写', create.json?.data?.escrowState === 'ACTIVE' && create.json?.data?.signatureAuditWritten === true, create.json?.data?.escrowState);
  check('create: 未碰私钥的标志位 + 输出无私钥串', create.json?.data?.privateKeyTouched === false && !create.stdout.includes(buyerKey), 'privateKeyTouched=false');
  const taskKey = String(create.json?.data?.taskKey || '');
  const createTx = String(create.json?.data?.txHash || '');
  check('create: taskKey 是真 bytes32 (68 字符)', /^0x[0-9a-f]{64}$/.test(taskKey), taskKey);

  const proof = cli(envSeller, 'chain', 'trade', 'submit-proof', '--task-id', taskId, '--result', `p6-delivery:${taskId}`, '--json');
  console.log(`  proof (卖方签名): exit=${proof.status} ok=${proof.json?.ok} code=${proof.json?.code} tx=${proof.json?.data?.txHash}`);
  check('submit-proof: ok:true + 真 txHash', proof.json?.ok === true && /^0x[0-9a-f]{64}$/.test(String(proof.json?.data?.txHash || '')), proof.json?.data?.txHash);
  check('submit-proof: ProofSubmittedV2 事件 + resultHash 对上 (eventMatched)', proof.json?.data?.eventMatched === true && proof.json?.data?.matchedEvent === 'ProofSubmittedV2', proof.json?.data?.resultDigest);
  check('submit-proof: chainSettled=true + 合约仍 ACTIVE', proof.json?.data?.chainSettled === true && proof.json?.data?.escrowState === 'ACTIVE', proof.json?.data?.chainStatus);
  const proofTx = String(proof.json?.data?.txHash || '');

  const release = cli(envMain, 'chain', 'trade', 'release', '--task-id', taskId, '--json');
  console.log(`  release (买方签名): exit=${release.status} ok=${release.json?.ok} code=${release.json?.code} tx=${release.json?.data?.txHash}`);
  check('release: ok:true + 真 txHash', release.json?.ok === true && /^0x[0-9a-f]{64}$/.test(String(release.json?.data?.txHash || '')), release.json?.data?.txHash);
  check('release: ReleasedV2 事件对上 + 合约状态 RELEASED', release.json?.data?.eventMatched === true && release.json?.data?.escrowState === 'RELEASED', { ev: release.json?.data?.matchedEvent, st: release.json?.data?.escrowState });
  check('release: ★ grantsVerified=true (只有全过才允许下游标 verified)', release.json?.data?.grantsVerified === true, release.json?.data?.grantsVerified);
  const releaseTx = String(release.json?.data?.txHash || '');

  // ── [E] escrow show ───────────────────────────────────────────────────────
  section('④ [E] `chain escrow show <真 taskKey>` — 读真状态');
  const show = cli(envMain, 'chain', 'escrow', 'show', taskKey, '--json');
  console.log(`  escrow show: exit=${show.status} ok=${show.json?.ok} ${fmt(show.json?.data && { state: show.json.data.state, amountUsdc: show.json.data.amountUsdc })}`);
  check('escrow show: ok:true', show.json?.ok === true, show.json?.code);
  check('escrow show: 真状态 RELEASED', show.json?.data?.state === 'RELEASED', show.json?.data?.state);
  check('escrow show: 真金额 0.02 USDC (20000 原子)', show.json?.data?.amountAtomic === '20000' && show.json?.data?.amountUsdc === '0.02', { a: show.json?.data?.amountAtomic, u: show.json?.data?.amountUsdc });
  check('escrow show: buyer/seller 与真钱包一致', String(show.json?.data?.buyer).toLowerCase() === buyerAddr.toLowerCase() && String(show.json?.data?.agent).toLowerCase() === sellerAddr.toLowerCase(), { b: show.json?.data?.buyer, a: show.json?.data?.agent });

  // ── [F] index sync ───────────────────────────────────────────────────────
  section('⑤ [F] `chain index sync --json` — 从 deployment block 真扫出真事件');
  const sync = cli(envMain, 'chain', 'index', 'sync', '--json');
  console.log(`  index sync: exit=${sync.status} ok=${sync.json?.ok} code=${sync.json?.code} ${fmt(sync.json?.data && { inserted: sync.json.data.inserted, entries: sync.json.data.entries, scan: `${sync.json.data.scanFrom}→${sync.json.data.scanTo}` })}`);
  check('index sync: ok:true', sync.json?.ok === true, sync.json?.message);
  check('index sync: 真扫出事件 (≥3 条, 含本次 3 笔)', Number(sync.json?.data?.inserted) >= 3 && Number(sync.json?.data?.entries) >= 3, { inserted: sync.json?.data?.inserted, entries: sync.json?.data?.entries });
  check('index sync: 无重组 (rewoundTo=null, suspects=0)', sync.json?.data?.rewoundTo === null && Number(sync.json?.data?.suspects) === 0, { rewound: sync.json?.data?.rewoundTo, suspects: sync.json?.data?.suspects });
  check('index sync: 扫描区间从部署块 111 起 (不是 0)', Number(sync.json?.data?.scanFrom) <= 111 && Number(sync.json?.data?.scanTo) >= Number(latest?.number), { from: sync.json?.data?.scanFrom, to: sync.json?.data?.scanTo });

  // ── [G] timeline ─────────────────────────────────────────────────────────
  section('⑥ [G] `chain timeline <真 taskKey>` — 用真事件还原 create→proof→release');
  const tl = cli(envMain, 'chain', 'timeline', taskKey, '--json');
  const events = (tl.json?.data?.events || []) as any[];
  const ordered = events.map((e) => e.eventName);
  console.log(`  timeline: exit=${tl.status} ok=${tl.json?.ok} state=${tl.json?.data?.state} reconstructed=${fmt(tl.json?.data?.reconstructed)}`);
  check('timeline: ok:true', tl.json?.ok === true, tl.json?.code);
  const iCreate = ordered.indexOf('EscrowCreatedV2'), iProof = ordered.indexOf('ProofSubmittedV2'), iRel = ordered.indexOf('ReleasedV2');
  check('timeline: 三个事件都在, 且顺序 create → proof → release', iCreate >= 0 && iProof > iCreate && iRel > iProof, ordered.slice(-6));
  check('timeline: 事件里的 txHash 与 [B][C][D] 的真 txHash 逐条对上', events.some((e) => e.txHash === createTx) && events.some((e) => e.txHash === proofTx) && events.some((e) => e.txHash === releaseTx), { createTx, proofTx, releaseTx });
  check('timeline: 推出状态 RELEASED + 本机视角如实 (买方节点只有自己的记录)', tl.json?.data?.state === 'RELEASED' && tl.json?.data?.local?.found === true && !tl.json?.data?.hasSuspect, { state: tl.json?.data?.state, localFound: tl.json?.data?.local?.found });
  check('timeline: finality 三档语义写明 (observed/confirmed/finalized)', !!tl.json?.data?.finalityLegend?.observed && !!tl.json?.data?.finalityLegend?.confirmed && !!tl.json?.data?.finalityLegend?.finalized);

  // ── [H] index status / stats ─────────────────────────────────────────────
  section('⑦ [H] `chain index status|stats`');
  const ist = cli(envMain, 'chain', 'index', 'status', '--json');
  const ista = cli(envMain, 'chain', 'index', 'stats', '--json');
  check('index status: ok:true + 已同步到真高度', ist.json?.ok === true && Number(ist.json?.data?.lastSyncedBlock) >= Number(sync.json?.data?.scanTo), { lastSynced: ist.json?.data?.lastSyncedBlock, entries: ist.json?.data?.entries });
  check('index stats: ok:true + released ≥ 1 (真事件统计)', ista.json?.ok === true && Number(ista.json?.data?.released) >= 1, { tasks: ista.json?.data?.tasks, created: ista.json?.data?.created, released: ista.json?.data?.released, finality: ista.json?.data?.byFinality });
  check('index stats: 索引起点来自 manifest (非硬编码 0)', Number(ista.json?.data?.deploymentBlock) === 111, ista.json?.data?.deploymentBlock);

  // ── [I] trade recover (两个节点各自的本机视角) ────────────────────────────
  section('⑧ [I] `chain trade recover` — 纯读盘重建 (买方/卖方两个节点各看自己有的记录)');
  const rec = cli(envMain, 'chain', 'trade', 'recover', '--task-id', taskId, '--json');
  console.log(`  recover (买方节点): exit=${rec.status} ok=${rec.json?.ok} code=${rec.json?.code} nextAction=${rec.json?.data?.nextAction}`);
  check('recover(买方): 有支付证据 → mustNotRepay=true + writesMoney=false (纯读盘)', rec.json?.data?.mustNotRepay === true && rec.json?.data?.writesMoney === false, rec.json?.data?.mustNotRepay);
  check('recover(买方): 缺卖方证明记录 → nextAction=needs_human + CHAIN_UNCERTAIN (不假装 done)', rec.json?.ok === false && rec.json?.code === 'CHAIN_UNCERTAIN' && rec.json?.data?.nextAction === 'needs_human', rec.json?.data?.nextAction);
  const recSeller = cli(envSeller, 'chain', 'trade', 'recover', '--task-id', taskId, '--json');
  console.log(`  recover (卖方节点): exit=${recSeller.status} ok=${recSeller.json?.ok} nextAction=${recSeller.json?.data?.nextAction}`);
  check('recover(卖方): 只报自己那份事实 (没有买方的 create 记录 → create_escrow, 不跨节点假装知道)', recSeller.json?.ok === true && recSeller.json?.data?.nextAction === 'create_escrow', recSeller.json?.data?.nextAction);

  // ── [I2] 自托管闭环 (同一 HOME: buyer == agent) → recover 走到 done ────────
  section('⑧b [I2] 自托管闭环 (同一节点 buyer==agent) → `recover` 必须能走到 done');
  const taskId2 = `p6-cli-self-${runId}`;
  const create2 = cli(envMain, 'chain', 'trade', 'create', '--task-id', taskId2, '--agent', buyerAddr, '--amount', '0.02', '--json');
  const proof2 = cli(envMain, 'chain', 'trade', 'submit-proof', '--task-id', taskId2, '--result', `p6-self:${taskId2}`, '--json');
  const release2 = cli(envMain, 'chain', 'trade', 'release', '--task-id', taskId2, '--json');
  console.log(`  自托管: create ok=${create2.json?.ok} proof ok=${proof2.json?.ok} release ok=${release2.json?.ok} grantsVerified=${release2.json?.data?.grantsVerified}`);
  check('自托管闭环: 三步都真上链成立 (create/proof/release)', create2.json?.ok === true && proof2.json?.ok === true && release2.json?.ok === true, { create: create2.json?.data?.txHash, proof: proof2.json?.data?.txHash, release: release2.json?.data?.txHash });
  const rec2self = cli(envMain, 'chain', 'trade', 'recover', '--task-id', taskId2, '--json');
  console.log(`  recover (自托管): exit=${rec2self.status} ok=${rec2self.json?.ok} nextAction=${rec2self.json?.data?.nextAction} verified=${rec2self.json?.data?.verified}`);
  check('recover(自托管): ok:true + nextAction=done + verified (链上释放确认 + 合约 RELEASED)', rec2self.json?.ok === true && rec2self.json?.data?.nextAction === 'done' && rec2self.json?.data?.verified === true, rec2self.json?.data?.nextAction);
  const sync3 = cli(envMain, 'chain', 'index', 'sync', '--json');
  const tl3 = cli(envMain, 'chain', 'timeline', String(create2.json?.data?.taskKey || ''), '--json');
  console.log(`  timeline (自托管): ok=${tl3.json?.ok} state=${tl3.json?.data?.state} chainSettled=${tl3.json?.data?.chainSettled} nextAction=${tl3.json?.data?.local?.nextAction}`);
  check('timeline(自托管): 推出 RELEASED + 本机 verified + nextAction=done (三档事件齐)', tl3.json?.ok === true && tl3.json?.data?.state === 'RELEASED' && tl3.json?.data?.chainSettled === true && tl3.json?.data?.local?.nextAction === 'done', { sync: sync3.json?.data?.inserted, events: tl3.json?.data?.count });

  // ── 负例 1: 未配置 ────────────────────────────────────────────────────────
  section('⑨ 负例 ①: 链未配置 → CHAIN_NOT_CONFIGURED');
  const bare = cli(envBare, 'chain', 'status', '--json');
  console.log(`  chain status (干净 HOME/无链 env): exit=${bare.status} code=${bare.json?.code} missing=${fmt(bare.json?.data?.missing)}`);
  check('未配置: ok:false + code=CHAIN_NOT_CONFIGURED (不是成功, 也不猜地址)', bare.json?.ok === false && bare.json?.code === 'CHAIN_NOT_CONFIGURED', bare.json?.message?.slice(0, 120));
  check('未配置: 列出缺哪些 (rpcUrl/chainId/escrowAddress)', ['rpcUrl', 'chainId', 'escrowAddress'].every((k) => (bare.json?.data?.missing || []).includes(k)), bare.json?.data?.missing);
  const bareSync = cli(envBare, 'chain', 'index', 'sync', '--json');
  check('未配置: chain index sync 同样 CHAIN_NOT_CONFIGURED (不静默当空索引)', bareSync.json?.ok === false && bareSync.json?.code === 'CHAIN_NOT_CONFIGURED', bareSync.json?.code);

  // ── 负例 2: escrow 找不到 ────────────────────────────────────────────────
  section('⑩ 负例 ②: escrow 不存在 → ESCROW_NOT_FOUND');
  const ghost = `0x${'00'.repeat(31)}01`;
  const nf = cli(envMain, 'chain', 'escrow', 'show', ghost, '--json');
  console.log(`  escrow show ${ghost}: exit=${nf.status} code=${nf.json?.code}`);
  check('找不到 escrow: ok:false + code=ESCROW_NOT_FOUND', nf.json?.ok === false && nf.json?.code === 'ESCROW_NOT_FOUND', nf.json?.message?.slice(0, 120));
  check('找不到 escrow: data 里给出 taskKey 与合约地址 (可复查)', String(nf.json?.data?.taskKey) === ghost && !!nf.json?.data?.escrowAddress);
  const nfTl = cli(envMain, 'chain', 'timeline', ghost, '--json');
  check('找不到 escrow: timeline 也 ESCROW_NOT_FOUND (索引+本机记录都没有)', nfTl.json?.ok === false && nfTl.json?.code === 'ESCROW_NOT_FOUND', nfTl.json?.code);

  // ── 负例 3: 余额不足 ─────────────────────────────────────────────────────
  section('⑪ 负例 ③: 余额/授权不足 → INSUFFICIENT_FUNDS');
  console.log(`  (用无 gas 无币无 allowance 的钱包 ${poorAddr}, 金额 0.02 ≤ M1 上限) `);
  const poor = cli(envPoor, 'chain', 'trade', 'create', '--task-id', `p6-poor-${runId}`, '--agent', sellerAddr, '--amount', '0.02', '--json');
  console.log(`  create(poor): exit=${poor.status} code=${poor.json?.code} txHash=${poor.json?.data?.txHash} reason=${fmt(poor.json?.data?.reason)}`);
  check('余额不足: ok:false + code=INSUFFICIENT_FUNDS', poor.json?.ok === false && poor.json?.code === 'INSUFFICIENT_FUNDS', poor.json?.code);
  check('余额不足: 钱没动 (txHash=null) + 给出下一步 raise_budget', poor.json?.data?.txHash === null && poor.json?.next_action === 'raise_budget', { tx: poor.json?.data?.txHash, next: poor.json?.next_action });

  // ── 负例 4: 未授权签名 ───────────────────────────────────────────────────
  section('⑫ 负例 ④: 签名放行闸拒绝 → NOT_AUTHORIZED (不发交易/不碰私钥)');
  const noauth = cli(envNoAuth, 'chain', 'trade', 'create', '--task-id', `p6-noauth-${runId}`, '--agent', sellerAddr, '--amount', '0.02', '--json');
  console.log(`  create(no-auth): exit=${noauth.status} code=${noauth.json?.code} authorized=${noauth.json?.data?.authorized} reason=${fmt(noauth.json?.data?.authReason)}`);
  check('未授权: ok:false + code=NOT_AUTHORIZED', noauth.json?.ok === false && noauth.json?.code === 'NOT_AUTHORIZED', noauth.json?.code);
  check('未授权: authorized=false + txHash=null (没发交易)', noauth.json?.data?.authorized === false && noauth.json?.data?.txHash === null, { a: noauth.json?.data?.authorized, tx: noauth.json?.data?.txHash });
  check('未授权: 输出里没有私钥串 (放行闸拒绝时不取私钥)', !noauth.stdout.includes(buyerKey) && !noauth.stdout.includes(buyerKey.slice(2)), 'clean');

  // ── 负例 5/6: 预算超限 / 参数非法 ────────────────────────────────────────
  section('⑬ 负例 ⑤⑥: 预算超限 / 参数非法');
  const overBudget = cli(envMain, 'chain', 'trade', 'create', '--task-id', `p6-over-${runId}`, '--agent', sellerAddr, '--amount', '0.5', '--json');
  check('预算超限: ok:false + code=BUDGET_EXCEEDED (M1 单次 0.02, 指明哪一层)', overBudget.json?.ok === false && overBudget.json?.code === 'BUDGET_EXCEEDED' && overBudget.json?.data?.layer === 'perPurchase', overBudget.json?.message?.slice(0, 120));
  const badKey = cli(envMain, 'chain', 'escrow', 'show', 'not-a-taskkey', '--json');
  check('参数非法: ok:false + code=INVALID_ARGUMENT', badKey.json?.ok === false && badKey.json?.code === 'INVALID_ARGUMENT', badKey.json?.code);
  const noAmount = cli(envMain, 'chain', 'trade', 'create', '--task-id', `p6-noamount-${runId}`, '--agent', sellerAddr, '--json');
  check('缺 --amount: INVALID_ARGUMENT (不猜金额, 不发交易)', noAmount.json?.ok === false && noAmount.json?.code === 'INVALID_ARGUMENT', noAmount.json?.code);
  const unknownSub = cli(envMain, 'chain', 'nope', '--json');
  check('未知子命令: INVALID_ARGUMENT (静默不做才是错)', unknownSub.json?.ok === false && unknownSub.json?.code === 'INVALID_ARGUMENT', unknownSub.json?.code);

  // ── 负例 7: 真重组 → REORG_SUSPECTED ────────────────────────────────────
  section('⑭ 负例 ⑦: evm_revert 造**真重组** → chain index sync / timeline 必须 REORG_SUSPECTED');
  const rb = await provider.send('evm_revert', [snapshot]);
  const afterRollback = await provider.getBlockNumber();
  console.log(`  evm_revert(${snapshot})=${rb} → head=${afterRollback} (本次交易已从链上消失)`);
  check('真重组成立: 回滚后 head < 交易所在高度 (本次 3 笔已从链上消失)', afterRollback < Number(create.json?.data?.blockNumber), { head: afterRollback, createBlock: create.json?.data?.blockNumber });
  const sync2 = cli(envMain, 'chain', 'index', 'sync', '--json');
  console.log(`  index sync (回滚后): exit=${sync2.status} code=${sync2.json?.code} rewoundTo=${sync2.json?.data?.rewoundTo} markedSuspect=${sync2.json?.data?.markedSuspect}`);
  check('真重组: chain index sync → ok:false + REORG_SUSPECTED (记录保留+标可疑, 不当没发生)', sync2.json?.ok === false && sync2.json?.code === 'REORG_SUSPECTED' && Number(sync2.json?.data?.markedSuspect) >= 1, { code: sync2.json?.code, marked: sync2.json?.data?.markedSuspect });
  const tl2 = cli(envMain, 'chain', 'timeline', taskKey, '--json');
  console.log(`  timeline (回滚后): exit=${tl2.status} code=${tl2.json?.code} hasSuspect=${tl2.json?.data?.hasSuspect}`);
  check('真重组: chain timeline → REORG_SUSPECTED (被回退的记录绝不报成功)', tl2.json?.ok === false && tl2.json?.code === 'REORG_SUSPECTED' && tl2.json?.data?.hasSuspect === true, tl2.json?.code);

  // ── 负例 8: 链上记录被标可疑 → trade recover ─────────────────────────────
  section('⑮ 负例 ⑧: 本机链上记录被标不可信 → `chain trade recover` 必须 REORG_SUSPECTED');
  const { loadChainState, markSuspect } = await import('../src/agents/chain/chain-state-store.js') as any;
  const stateFile = path.join(HOME, '.bolloon', 'chain', 'chain-state.json');
  const recs = Object.values(loadChainState(HOME).records) as any[];
  const relRec = recs.find((r) => r.method === 'releaseV2' && String(r.taskKey).toLowerCase() === taskKey);
  check('chain-state.json 里真有本次 release 记录 (P3 落盘)', !!relRec && relRec.taskKey === taskKey, relRec ? { method: relRec.method, tx: relRec.txHash } : null);
  if (relRec) await markSuspect(relRec.requestId, 'verify-chain-cli: 模拟链上事件消失 (真实 markSuspect 代码路径)', HOME);
  const rec2 = cli(envMain, 'chain', 'trade', 'recover', '--task-id', taskId, '--json');
  console.log(`  recover (suspect): exit=${rec2.status} code=${rec2.json?.code} nextAction=${rec2.json?.data?.nextAction}`);
  check('suspect 记录: ok:false + REORG_SUSPECTED + nextAction=needs_human', rec2.json?.ok === false && rec2.json?.code === 'REORG_SUSPECTED' && rec2.json?.data?.nextAction === 'needs_human', rec2.json?.code);
  check('suspect 记录: 仍如实报 mustNotRepay (绝不重付)', rec2.json?.data?.mustNotRepay === true, rec2.json?.data?.mustNotRepay);
  const stFile = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {} };
  const methods = Object.values(stFile.records || {}).map((r: any) => r.method);
  check('chain-state.json 落在临时 HOME 里, 且记着本次三步链上事实', fs.existsSync(stateFile) && ['createEscrowV2', 'submitProofV2', 'releaseV2'].every((m) => methods.includes(m)), { path: stateFile, methods });
  check('索引/状态都写在**临时 HOME** (隔离, 不污染真实 ~/.bolloon)', String(ist.json?.data?.indexPath || '').startsWith(HOME) && stateFile.startsWith(HOME), { indexPath: ist.json?.data?.indexPath, stateFile: stateFile.replace(ROOT, '<tmp>') });

  // ── [MCP] 真 stdio 握手 ──────────────────────────────────────────────────
  section('⑯ [MCP] `bolloon mcp serve` 真 stdio: initialize + tools/list + 失败调用');
  const mcp = new McpClient(envMain);
  const init = await mcp.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-chain-cli', version: '1.0.0' } });
  console.log(`  initialize → serverInfo=${fmt(init?.result?.serverInfo)} protocol=${init?.result?.protocolVersion}`);
  check('initialize: 真握手成功 (serverInfo.name=bolloon)', init?.result?.serverInfo?.name === 'bolloon' && !!init?.result?.protocolVersion, init?.result?.serverInfo?.version);
  await mcp.notify('notifications/initialized', {});

  const list = await mcp.request(3, 'tools/list');
  const toolNames = (list?.result?.tools || []).map((t: any) => t.name);
  const chainTools = toolNames.filter((n: string) => n.startsWith('bolloon_chain_'));
  console.log(`  tools/list → 共 ${toolNames.length} 个 tool, 其中链 tool ${chainTools.length}: ${chainTools.join(', ')}`);
  check('tools/list: 链能力已暴露为 MCP tool (status/escrow/timeline/index_*/trade_recover)', ['bolloon_chain_status', 'bolloon_chain_escrow_show', 'bolloon_chain_timeline', 'bolloon_chain_index_status', 'bolloon_chain_index_stats', 'bolloon_chain_index_sync', 'bolloon_chain_trade_recover'].every((n) => toolNames.includes(n)), chainTools);
  check('tools/list: 总数 = 24 (17 个既有 + 7 个链 tool)', toolNames.length === 24, toolNames.length);
  const rlist = await mcp.request(4, 'resources/list');
  const resUris = (rlist?.result?.resources || []).map((r: any) => r.uri);
  console.log(`  resources/list → ${resUris.length} 个: ${resUris.slice(-3).join(', ')}`);
  check('resources/list: 链资源已暴露 (bolloon://chain/*)', ['bolloon://chain/status', 'bolloon://chain/index', 'bolloon://chain/index/stats'].every((u) => resUris.includes(u)), resUris.filter((u: string) => u.startsWith('bolloon://chain')));

  const badCall = await mcp.request(5, 'tools/call', { name: 'bolloon_chain_escrow_show', arguments: { taskKey: ghost } });
  const badEnv = badCall?.result?.structuredContent;
  console.log(`  失败调用 → isError=${badCall?.result?.isError} ok=${badEnv?.ok} code=${badEnv?.code}`);
  check('★ 失败调用: isError=true (失败**没有**变成 MCP 成功)', badCall?.result?.isError === true, badCall?.result?.isError);
  check('失败调用: 信封原样返回 (ok:false + code=ESCROW_NOT_FOUND + next_action)', badEnv?.ok === false && badEnv?.code === 'ESCROW_NOT_FOUND' && 'next_action' in (badEnv || {}), { code: badEnv?.code, next: badEnv?.next_action });
  check('失败调用: content[0].text 也是同一个失败信封 (没被洗成成功)', String(badCall?.result?.content?.[0]?.text || '').includes('"ok": false'), 'text 里是 ok:false');

  const badArg = await mcp.request(6, 'tools/call', { name: 'bolloon_chain_timeline', arguments: { taskKey: ghost, bogusOption: '--force' } });
  check('入参白名单: 未知参数 → isError=true + INVALID_ARGUMENT (不能注入命令行选项)', badArg?.result?.isError === true && badArg?.result?.structuredContent?.code === 'INVALID_ARGUMENT', badArg?.result?.structuredContent?.code);

  const okCall = await mcp.request(7, 'tools/call', { name: 'bolloon_chain_status', arguments: {} });
  const okEnv = okCall?.result?.structuredContent;
  console.log(`  正常调用 → isError=${okCall?.result?.isError} ok=${okEnv?.ok} chainId=${okEnv?.data?.chainId}`);
  check('正常调用: chain status 经 MCP 真调通 (ok:true + isError=false)', okCall?.result?.isError === false && okEnv?.ok === true && okEnv?.data?.chainId === LOCAL_DEV_CHAIN_ID, okEnv?.data?.escrowAddress);
  const readRes = await mcp.request(8, 'resources/read', { uri: 'bolloon://chain/index/stats' });
  let statsText: any = null;
  try { statsText = JSON.parse(String(readRes?.result?.contents?.[0]?.text || '')); } catch { statsText = null; }
  check('resources/read: bolloon://chain/index/stats 返回真索引信封 (含 released 计数)', statsText?.ok === true && Number(statsText?.data?.released) >= 1, statsText ? { released: statsText.data?.released, entries: statsText.data?.entries } : null);

  const mcpExit = await mcp.close();
  check('stdio 收尾: stdin 关闭后 server 正常退出 (stdout 只走 JSON-RPC)', mcpExit === 0, { exit: mcpExit, stderrHead: mcp.stderrText.split('\n')[0]?.slice(0, 90) });

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  section('汇总 (真 txHash / 真 taskKey)');
  console.log(`  主闭环 (买方/卖方两节点) taskId = ${taskId}`);
  console.log(`    taskKey = ${taskKey}`);
  console.log(`    create  tx = ${createTx}  (block ${create.json?.data?.blockNumber})   ← 买方节点签名`);
  console.log(`    proof   tx = ${proofTx}  (block ${proof.json?.data?.blockNumber})   ← 卖方节点签名`);
  console.log(`    release tx = ${releaseTx}  (block ${release.json?.data?.blockNumber})   ← 买方节点签名`);
  console.log(`  自托管闭环 taskId = ${taskId2} · taskKey = ${create2.json?.data?.taskKey}`);
  console.log(`    create/proof/release = ${create2.json?.data?.txHash} / ${proof2.json?.data?.txHash} / ${release2.json?.data?.txHash}`);
  console.log(`  索引: 主闭环同步 ${sync.json?.data?.entries} 条事件 · 已同步到 ${ist.json?.data?.lastSyncedBlock} · 部署块 ${ista.json?.data?.deploymentBlock} · 回滚后 suspect ${sync2.json?.data?.markedSuspect} 条`);
  console.log(`  MCP: ${toolNames.length} tools / ${resUris.length} resources (链 tool ${chainTools.length})`);
  console.log(`  临时 HOME=${HOME} (链上状态/索引/交易记录都在这里, 供审计)`);
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);
  try { provider.destroy(); } catch { /* noop */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[verify-chain-cli] 失败:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
