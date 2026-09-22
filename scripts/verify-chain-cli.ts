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
 *   [MCP 写] 真 stdio: 3 个链上**写** tool (`bolloon_chain_trade_create|submit_proof|release`):
 *            真写一次 (真签名 → 真 txHash → 链上复核 escrow/seller token 余额真变化) ·
 *            未授权被拒 (NOT_AUTHORIZED, 没发交易、没写审计) · 越额被拒 (BUDGET_EXCEEDED) ·
 *            缺授权意图/值非法 → NOT_AUTHORIZED / INVALID_ARGUMENT · **所有失败 isError=true**
 *            成功写必须在 `~/.bolloon/wallet-signatures.jsonl` 留行 (不记密钥/任务正文)
 *
 * 跑法 (默认 = 自建**隔离链** + 自建**临时 HOME**, 不碰别人正在用的 anvil / 不读本机 chain.json):
 *   # 终端 A (本地 dev 链; 只被本脚本 fork 一次状态, 不写不回滚)
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1
 *   # 终端 B
 *   npx tsx scripts/verify-chain-cli.ts
 *   # → 脚本自己起一条私有 anvil (随机端口, fork 上游状态), 自己造 HOME 并把
 *   #   `contracts/deployments/localhost.json` 里的**部署事实**写进每个 HOME 的 chain.json。
 *
 * 密闭性 (2026-09-22 修「靠环境巧合才绿的门」):
 *   · 链: 私有 fork 链 (独立进程/端口, 只有本脚本的交易出块) → `evm_revert` 也只影响自己;
 *         显式给 BOLLOON_CHAIN_RPC_URL 才是"对着别人那条链跑"(排查用)。
 *   · HOME: 每个角色一个**新建临时 HOME**, 里面的 chain.json 由 manifest 现写 → 不需要
 *         预先存在的 `~/.bolloon/chain.json` / 索引 / 状态; 真实 ~/.bolloon 一个字节都不动。
 *   · 子进程 env: 先**清空所有继承来的链配置** (BOLLOON_* / RPC_URL / *_PRIVATE_KEY),
 *         再显式注入 → 外层 shell 里有什么都不影响结论。
 *   · 地址: 全部来自 `contracts/deployments/localhost.json` (经 chain-config 的 manifest 层
 *         解析, 与生产同一份代码), 脚本里**不硬编码任何地址/部署块**。
 *   · 私钥: 由 anvil **公开开发助记符**在进程内派生, 只写进临时 HOME 的 wallet.json (0600);
 *         脚本自己不打印, 并逐条断言 CLI 输出里**不含**私钥串。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Contract, Wallet } from 'ethers';
import { startIsolatedDevChain, probeMacosDylibs, buildAnvilChildEnv } from './lib/isolated-dev-chain.js';
import {
  deploymentsDir, listDeploymentManifests, parseDeploymentManifest,
  chainConfigPath, type DeploymentManifest,
} from '../src/agents/chain/chain-config.js';

const ROOT_DIR = process.cwd();
const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p6-cli-'));
const HOME = path.join(ROOT, 'home');            // 买方节点 (buyer)
const HOME_SELLER = path.join(ROOT, 'home-seller'); // 卖方节点 (agent: submitProofV2 要求 msg.sender == agent)
const HOME_NOAUTH = path.join(ROOT, 'home-noauth');
const HOME_POOR = path.join(ROOT, 'home-poor');
const HOME_BARE = path.join(ROOT, 'home-bare');
const HOME_MANIFEST = path.join(ROOT, 'home-manifest');   // 只有 env 锚, 地址从仓库 manifest 解析
const HOME_AMBIG = path.join(ROOT, 'home-ambig');         // 只有 chainId 锚 → 两份 localhost 变体 → 必须拒绝猜
const HOME_NOTOKEN = path.join(ROOT, 'home-notoken');     // 链配置齐但**三层都拿不到 token**
const EMPTY_DEPLOYMENTS = path.join(ROOT, 'deployments-empty'); // 模拟"仓库里没有这条部署的记录"
for (const h of [HOME, HOME_SELLER, HOME_NOAUTH, HOME_POOR, HOME_BARE, HOME_MANIFEST, HOME_AMBIG, HOME_NOTOKEN]) {
  fs.mkdirSync(path.join(h, '.bolloon'), { recursive: true });
}
fs.mkdirSync(EMPTY_DEPLOYMENTS, { recursive: true });

const EXPLICIT_RPC = process.env.BOLLOON_CHAIN_RPC_URL || process.env.BOLLOON_RPC_URL || process.env.RPC_URL || null;
const UPSTREAM_RPC = process.env.BOLLOON_DEV_CHAIN_RPC_URL || 'http://127.0.0.1:8545';
const LOCAL_DEV_CHAIN_ID = 31337;
const TSX = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT_DIR, 'src', 'cli-entry.ts');

/** 只用开发链的公开事实: 这份脚本永远对着 chainId 31337 的本地链跑 */
const DEPLOY_NETWORK_NAME = process.env.BOLLOON_NETWORK_NAME || 'localhost';

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
function printTally(): void {
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);
}

/**
 * 读 receipt / tx 的安全包装: 空值或非法 txHash (写失败时信封里就是空串) → null。
 * 断言会因此**失败并打印** (而不是让整份脚本崩在 `could not coalesce error` 上,
 * 那样后面的 100 多条断言根本跑不到, 结论也就不可信了)。判定标准没变, 只是不再中断。
 */
async function safeReceipt(provider: JsonRpcProvider, hash: unknown): Promise<any | null> {
  const h = String(hash || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return null;
  try { return await provider.getTransactionReceipt(h); } catch { return null; }
}
async function safeTx(provider: JsonRpcProvider, hash: unknown): Promise<any | null> {
  const h = String(hash || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return null;
  try { return await provider.getTransaction(h); } catch { return null; }
}

// ── 部署事实解析 (经 chain-config 的 manifest 层 —— 与生产同一份代码, 脚本不 hardcode) ──
interface Deployment {
  chainId: number;
  networkName: string;
  rpcUrl: string | null;
  escrowAddress: string;
  tokenAddress: string;
  tokenDecimals: number;
  /** 部署块 (来自 manifest 的 contracts[AgentEscrow].blockNumber) */
  deploymentBlock: number;
  manifestPath: string;
  label: string;
}

function resolveDeployment(): Deployment {
  const dir = deploymentsDir();
  const all = listDeploymentManifests({ deploymentsDir: dir });
  const byFile = all.filter((m) => path.basename(m.path) === `${DEPLOY_NETWORK_NAME}.json`);
  const man: DeploymentManifest | undefined = byFile.length === 1
    ? byFile[0]
    : all.find((m) => m.chainId === LOCAL_DEV_CHAIN_ID && m.networkName === DEPLOY_NETWORK_NAME);
  if (!man) {
    throw new Error(
      `拿不到本地开发链的部署事实: ${dir} 里没有 ${DEPLOY_NETWORK_NAME}.json` +
      ` (候选: ${all.map((m) => path.basename(m.path)).join(', ') || '无'})。` +
      ` 本脚本不硬编码合约地址 —— 先做一次本地部署: cd contracts/evm && npx hardhat compile && node scripts/deploy.js`,
    );
  }
  const missing: string[] = [];
  if (man.chainId !== LOCAL_DEV_CHAIN_ID) missing.push(`chainId=${man.chainId} (要 ${LOCAL_DEV_CHAIN_ID})`);
  if (!man.tokenAddress) missing.push('token 地址 (manifest .token.address / .externalToken.address)');
  if (man.tokenDecimals === null) missing.push('token decimals');
  if (man.escrowBlockNumber === null) missing.push('contracts[AgentEscrow].blockNumber');
  if (missing.length) {
    throw new Error(`${man.label} 里缺: ${missing.join(', ')} —— 这份脚本不硬编码这些值, 也不猜`);
  }
  return {
    chainId: man.chainId as number,
    networkName: man.networkName || DEPLOY_NETWORK_NAME,
    rpcUrl: man.rpcUrl,
    escrowAddress: man.escrowAddress,
    tokenAddress: man.tokenAddress as string,
    tokenDecimals: man.tokenDecimals as number,
    deploymentBlock: man.escrowBlockNumber as number,
    manifestPath: man.path,
    label: man.label,
  };
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

/** 把**部署事实**写进某个 HOME 的 chain.json (第 ② 层配置; 由 manifest 现写, 不靠预置) */
function writeChainJson(home: string, cfg: Record<string, unknown>): void {
  const p = chainConfigPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ── CLI 子进程 ───────────────────────────────────────────────────────────────
interface CliRun { status: number; stdout: string; stderr: string; env: Record<string, string>; json: any | null }

/**
 * ★ 清空**继承来的**链配置再注入 (这是"密闭"的关键一步)。
 * 外层 shell 里有没有 BOLLOON_ESCROW_ADDRESS / BOLLOON_TOKEN_ADDRESS / RPC_URL /
 * 私钥, 都不能改变本门的结论 —— 否则测的就是"这台机器恰好配了什么"。
 */
const STRIPPED_ENV_RE = /^(BOLLOON_|RPC_URL$|.*_PRIVATE_KEY$|MNEMONIC$|DEPLOYER_|AGENT_)/;

function baseEnv(home: string, over: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIPPED_ENV_RE.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.BOLLOON_SKIP_SETUP = '1';
  env.BOLLOON_AGENT_AUTHORIZED = '1';   // 授权闸的"已授权"开关 (未授权的 HOME 会显式删掉它)
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

function cli(env: Record<string, string>, ...args: string[]): CliRun {
  const r = spawnSync(process.execPath, [TSX, ENTRY, ...args], { cwd: ROOT_DIR, env, encoding: 'utf8', timeout: 180_000 });
  let json: any = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { json = null; }
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), env, json };
}

let DEP: Deployment;
try {
  DEP = resolveDeployment();
} catch (e: any) {
  // ★ 顶层解析失败 = 这份门**没法跑**, 不是"全绿"。打印一句人话 + 怎么修, 然后 exit 1。
  console.error(`\n[verify-chain-cli] 拿不到部署事实, 门不跑: ${String(e?.message || e)}`);
  console.error('  (拿不到部署事实时绝不静默跳过断言 —— 那才是会撒谎的门)');
  process.exit(1);
}
/** 本脚本自己用的链 (默认 = 隔离链; 显式给 RPC 才是共享链) */
let RPC_URL = EXPLICIT_RPC || '';

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
  writeWallet(HOME_POOR, poorKey);      // 已授权, 但没 gas / 没币 / no allowance
  writeWallet(HOME_MANIFEST, buyerKey); // 配置只从 env 锚 + 仓库 manifest 来
  writeWallet(HOME_NOTOKEN, buyerKey);  // 链配置齐但没有 token → 真写必须给可操作的错

  section('① 链来源 (默认隔离链: 别人的块影响不到断言) + 临时 HOME (chain.json 由 manifest 现写)');
  let isolated: any = null;
  if (EXPLICIT_RPC) {
    RPC_URL = EXPLICIT_RPC;
    console.log(`  模式        : 共享链 (你显式给了 RPC, 不隔离) → ${RPC_URL}`);
    console.log(`  ⚠ 这条链上别的进程也在出块; 本脚本的期望值全部从**当时的真实链状态**推导`);
  } else {
    try {
      isolated = await startIsolatedDevChain({ upstreamRpc: UPSTREAM_RPC, chainId: LOCAL_DEV_CHAIN_ID });
      RPC_URL = isolated.rpcUrl;
      process.on('exit', () => { try { isolated?.stop(); } catch { /* noop */ } });
      console.log(`  模式        : 隔离链 (一次性; fork 自 ${UPSTREAM_RPC}, 对上游只读)`);
      console.log(`  私有 RPC    : ${RPC_URL}  chainId=${isolated.chainId}  fork 起点块=${isolated.forkedAtBlock}`);
      console.log(`  隔离效果    : 独立 anvil 进程/端口; evm_snapshot/evm_revert 只影响自己, 不搅别人的块`);
    } catch (e: any) {
      console.log(`  ❌ 起不了隔离链: ${String(e?.message || e).slice(0, 320)}`);
      console.log('  先起本地 dev 链 (只会被本脚本 fork 一次状态):');
      console.log('    DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1');
      console.log('  或显式对着已有链跑 (不隔离): BOLLOON_CHAIN_RPC_URL=<url> npx tsx scripts/verify-chain-cli.ts');
      process.exit(1);
    }
  }
  // ★ anvil 子进程 env (2026-09-22 修): 白名单透传 + DYLD_LIBRARY_PATH 由**真实候选探测**拼出。
  //   原来用 os.homedir() 拼 ~/.local/lib —— 干净/临时 HOME 下那是空目录 → anvil 链不到 libusb
  //   → dyld: Library not loaded → SIGABRT → 上层只看到"隔离链没能在 30000ms 内就绪"。
  const dylibProbe = probeMacosDylibs({});
  const anvilChildEnv = buildAnvilChildEnv(dylibProbe);
  console.log(`  anvil env   : PATH=${anvilChildEnv.PATH ? '透传' : '缺!'} HOME=${anvilChildEnv.HOME || '(缺!)'} ` +
    `DYLD_LIBRARY_PATH=${dylibProbe.dyldLibraryPath ?? '(空 — anvil 不缺第三方库)'}`);
  if (dylibProbe.missing.length) {
    console.log(`  anvil 缺库  : ${dylibProbe.missing.join(', ')} → 由 ${dylibProbe.dirs.join(':') || '(探测不到!)'} 提供`);
  }
  check('anvil 子进程 env: 白名单透传 PATH/HOME, DYLD_LIBRARY_PATH 由真候选探测拼出 (不靠 $HOME)',
    typeof anvilChildEnv.PATH === 'string' && !!anvilChildEnv.HOME && !dylibProbe.error
    && (dylibProbe.dirs.length === 0 || String(anvilChildEnv.DYLD_LIBRARY_PATH).includes(dylibProbe.dirs[0])),
    { dyld: anvilChildEnv.DYLD_LIBRARY_PATH ?? null, missing: dylibProbe.missing, dirs: dylibProbe.dirs });
  console.log(`  部署事实    : ${DEP.label}  chainId=${DEP.chainId}  escrow=${DEP.escrowAddress}`);
  console.log(`                token=${DEP.tokenAddress} · decimals=${DEP.tokenDecimals} · 部署块=${DEP.deploymentBlock} (来自仓库 manifest, 无硬编码)`);
  console.log(`  真实 HOME   : ${REAL_HOME} —— 本脚本不往那里写任何东西; 临时根目录 ${ROOT}`);
  check('部署事实来自仓库 manifest (chainId 31337 + escrow/token/部署块齐全)', DEP.chainId === LOCAL_DEV_CHAIN_ID && !!DEP.escrowAddress && !!DEP.tokenAddress && DEP.deploymentBlock > 0, DEP.label);
  check('manifest 里记的 token decimals 已解析 (非硬编码 6)', DEP.tokenDecimals === 6, DEP.tokenDecimals);
  check('临时 HOME 与真实 HOME 不同 (隔离成立)', HOME.startsWith(ROOT) && HOME !== REAL_HOME, { home: HOME.replace(ROOT, '<tmp>'), realHome: REAL_HOME });

  // ★ 把部署事实写进各角色的临时 HOME (chain.json = 第 ② 层);
  //   主用例的子进程 env 里**一个链配置都不带** → 全靠 chain.json, 也不靠外层 shell 碰巧配了什么
  const CHAIN_JSON_BASE = {
    rpcUrl: RPC_URL, chainId: DEP.chainId, networkName: DEP.networkName,
    escrowAddress: DEP.escrowAddress, tokenAddress: DEP.tokenAddress, tokenDecimals: DEP.tokenDecimals,
  };
  for (const h of [HOME, HOME_SELLER, HOME_NOAUTH, HOME_POOR]) writeChainJson(h, CHAIN_JSON_BASE);
  writeChainJson(HOME_NOTOKEN, { rpcUrl: RPC_URL, chainId: DEP.chainId, networkName: DEP.networkName, escrowAddress: DEP.escrowAddress });
  check('各临时 HOME 的 chain.json 已由 manifest 现写 (不依赖本机预置的 ~/.bolloon/chain.json)',
    [HOME, HOME_SELLER, HOME_NOAUTH, HOME_POOR].every((h) => fs.existsSync(chainConfigPath(h)))
    && !fs.existsSync(chainConfigPath(HOME_BARE)) && !fs.existsSync(chainConfigPath(HOME_MANIFEST)),
    { 临时HOME: HOME.replace(ROOT, '<tmp>') });

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
  console.log(`  escrow=${DEP.escrowAddress}  token=${DEP.tokenAddress}  (来源: 仓库 manifest ${DEP.label})`);
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
  // 未配置: 没 chain.json, 也没有任何链 env (manifest 层也没锚 → 必须拒绝猜)
  const envBare = baseEnv(HOME_BARE);
  // 第 ③ 层: 只给**锚** (RPC + chainId + networkName); escrow/token/decimals 从仓库 manifest 解析
  const envManifest = baseEnv(HOME_MANIFEST, {
    BOLLOON_CHAIN_RPC_URL: RPC_URL, BOLLOON_CHAIN_ID: String(DEP.chainId), BOLLOON_NETWORK_NAME: DEP.networkName,
  });
  // 只有 chainId 一个锚 → 仓库里两份 localhost 变体都匹配 → 必须拒绝猜 (歧义)
  const envAmbig = baseEnv(HOME_AMBIG, { BOLLOON_CHAIN_ID: String(DEP.chainId) });
  // 链配置齐, 但仓库里没有这条部署的记录 (空 manifest 目录) → token 三层都拿不到
  const envNoToken = baseEnv(HOME_NOTOKEN, { BOLLOON_DEPLOYMENTS_DIR: EMPTY_DEPLOYMENTS });

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

  // ── [A2] 链配置三层口径 (env → chain.json → 仓库 manifest → 报错) ──────────
  section('②b [A2] 链配置三层口径: env → ~/.bolloon/chain.json → 仓库 manifest (按锚匹配, 不猜)');

  // (1) 主用例就已经证明了第 ② 层: 子进程 env 里**没有任何链配置**, 全部来自 chain.json
  check('第 ② 层: env 里没有链配置时也读到真 chainId/escrow/token (全靠临时 HOME 的 chain.json)',
    envMain.BOLLOON_CHAIN_RPC_URL === undefined && envMain.BOLLOON_ESCROW_ADDRESS === undefined && envMain.BOLLOON_TOKEN_ADDRESS === undefined
    && st.json?.ok === true && String(st.json?.data?.sources?.escrowAddress || '').includes('chain.json'),
    st.json?.data?.sources?.escrowAddress);
  check('chain status 如实报 sources (含 manifest 层结论与用到的目录, 可审计)',
    typeof st.json?.data?.sources?.deploymentManifest === 'string' && typeof st.json?.data?.sources?.deploymentsDir === 'string',
    st.json?.data?.sources?.deploymentManifest);
  check('隔离: configPath / walletPath 都指向临时 HOME (真实 ~/.bolloon 不参与)',
    String(st.json?.data?.configPath || '').startsWith(HOME) && String(st.json?.data?.walletPath || '').startsWith(HOME),
    { configPath: String(st.json?.data?.configPath || '').replace(ROOT, '<tmp>') });

  // (2) 第 ③ 层: 只给锚 (RPC/chainId/networkName) → escrow/token/decimals 由仓库 manifest 给出
  const mst = cli(envManifest, 'chain', 'status', '--json');
  console.log(`  manifest 层 (只给 RPC+chainId+networkName): ok=${mst.json?.ok} escrow=${mst.json?.data?.escrowAddress} token=${mst.json?.data?.tokenAddress}`);
  console.log(`    sources.escrowAddress = ${fmt(mst.json?.data?.sources?.escrowAddress)}`);
  check('第 ③ 层: 只给锚 → escrow 地址从仓库 manifest 解析, 与 manifest 逐字一致',
    mst.json?.ok === true && String(mst.json?.data?.escrowAddress).toLowerCase() === DEP.escrowAddress.toLowerCase()
    && String(mst.json?.data?.sources?.escrowAddress || '').includes('manifest'),
    mst.json?.data?.sources?.escrowAddress);
  check('第 ③ 层: token 地址 + decimals 也从 manifest 来 (不再是 null, 也不冒充默认精度)',
    String(mst.json?.data?.tokenAddress).toLowerCase() === DEP.tokenAddress.toLowerCase()
    && mst.json?.data?.tokenDecimals === DEP.tokenDecimals
    && String(mst.json?.data?.sources?.tokenAddress || '').includes('manifest'),
    { token: mst.json?.data?.tokenAddress, decimals: mst.json?.data?.tokenDecimals, src: mst.json?.data?.sources?.tokenAddress });
  check('第 ③ 层: chainId/networkName 与 manifest 一致 (不会绑到别的链的部署上)',
    mst.json?.data?.chainId === DEP.chainId && mst.json?.data?.networkName === DEP.networkName,
    { chainId: mst.json?.data?.chainId, net: mst.json?.data?.networkName });
  check('第 ③ 层: 这个 HOME 里**没有** chain.json (证明确实走的 manifest, 不是文件层)',
    !fs.existsSync(chainConfigPath(HOME_MANIFEST)), chainConfigPath(HOME_MANIFEST).replace(ROOT, '<tmp>'));

  // (3) 歧义: 只有 chainId 一个锚, 仓库里两份 localhost 变体都匹配 → 必须拒绝猜
  const amb = cli(envAmbig, 'chain', 'status', '--json');
  console.log(`  歧义锚 (只有 chainId): ok=${amb.json?.ok} code=${amb.json?.code} missing=${fmt(amb.json?.data?.missing)}`);
  check('歧义: 只有 chainId 锚 → ok:false + CHAIN_NOT_CONFIGURED (多份匹配就是不猜)',
    amb.json?.ok === false && amb.json?.code === 'CHAIN_NOT_CONFIGURED', amb.json?.code);
  check('歧义: 报错里列出候选 manifest (不是含糊一句"缺配置")',
    /歧义/.test(String(amb.json?.message)) && /localhost-external\.json/.test(String(amb.json?.message)),
    String(amb.json?.message).slice(0, 220));

  // (4) token 三层都拿不到: 读路径不受影响; 真写必须给**可操作**的错
  const ntk = cli(envNoToken, 'chain', 'status', '--json');
  check('无 token 时读路径不受影响: chain status 仍 ok:true + tokenAddress=null + 来源写"未配置"',
    ntk.json?.ok === true && ntk.json?.data?.tokenAddress === null && String(ntk.json?.data?.sources?.tokenAddress || '').includes('未配置'),
    ntk.json?.data?.sources?.tokenAddress);
  const ntkCreate = cli(envNoToken, 'chain', 'trade', 'create', '--task-id', `p6-notoken-${runId}`, '--agent', sellerAddr, '--amount', '0.02', '--json');
  console.log(`  create (无 token): exit=${ntkCreate.status} code=${ntkCreate.json?.code} missing=${fmt(ntkCreate.json?.data?.missing)}`);
  check('★ 真写拿不到 token → CHAIN_NOT_CONFIGURED (不是含糊的 INVALID_ARGUMENT)',
    ntkCreate.json?.ok === false && ntkCreate.json?.code === 'CHAIN_NOT_CONFIGURED' && (ntkCreate.json?.data?.missing || []).includes('tokenAddress'),
    ntkCreate.json?.code);
  check('★ 这个错**可操作**: 点名 env / chain.json / manifest 三层来源 + 给出 howToFix',
    /BOLLOON_TOKEN_ADDRESS/.test(String(ntkCreate.json?.message))
    && /chain\.json/.test(String(ntkCreate.json?.message))
    && /manifest/.test(String(ntkCreate.json?.message))
    && Array.isArray(ntkCreate.json?.data?.howToFix) && ntkCreate.json.data.howToFix.length >= 3,
    String(ntkCreate.json?.message).slice(0, 240));
  check('真写拿不到 token 时**没发交易** (无 txHash) + 输出无私钥串',
    (ntkCreate.json?.data?.txHash ?? null) === null && !ntkCreate.stdout.includes(buyerKey), 'clean');

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
  check(`index sync: 扫描区间从部署块 ${DEP.deploymentBlock} (manifest 记的) 起, 不是 0`, Number(sync.json?.data?.scanFrom) <= DEP.deploymentBlock && Number(sync.json?.data?.scanTo) >= Number(latest?.number), { from: sync.json?.data?.scanFrom, to: sync.json?.data?.scanTo, want: DEP.deploymentBlock });

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
  check(`index stats: 索引起点来自 manifest 的部署块 (${DEP.deploymentBlock}, 非硬编码 0)`, Number(ista.json?.data?.deploymentBlock) === DEP.deploymentBlock, ista.json?.data?.deploymentBlock);
  check('index status: 起点来源如实标成 manifest (不是 test/硬编码)', /manifest/.test(String(ist.json?.data?.deploymentSource || '')), ist.json?.data?.deploymentSource);

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
  check('未配置: 报错说清三层来源 + 怎么修 + manifest 层为什么没选中 (没有锚就不猜)',
    /仓库部署 manifest/.test(String(bare.json?.message)) && /没有锚/.test(String(bare.json?.message)) && /BOLLOON_CHAIN_RPC_URL/.test(String(bare.json?.message)),
    String(bare.json?.message).slice(0, 260));
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
  const WRITE_TOOL_NAMES = ['bolloon_chain_trade_create', 'bolloon_chain_trade_submit_proof', 'bolloon_chain_trade_release'];
  check('tools/list: 3 个链上**写** tool 已暴露 (create/submit_proof/release)', WRITE_TOOL_NAMES.every((n) => toolNames.includes(n)), WRITE_TOOL_NAMES.filter((n) => toolNames.includes(n)));
  check('tools/list: 总数 = 27 (17 个既有 + 7 个链只读 + 3 个链写)', toolNames.length === 27, toolNames.length);
  const wCreateTool = (list?.result?.tools || []).find((t: any) => t.name === 'bolloon_chain_trade_create');
  check('写 tool 的 inputSchema: paymentMode/requestId 是 required (裸调不了)',
    ['taskId', 'agent', 'amount', 'paymentMode', 'requestId'].every((k) => (wCreateTool?.inputSchema?.required || []).includes(k)),
    wCreateTool?.inputSchema?.required);
  check('写 tool 的描述写明「真签名 + 真移钱」并要调用方自己保证已授权',
    /真签名/.test(String(wCreateTool?.description)) && /真移钱/.test(String(wCreateTool?.description)) && /调用方必须自己保证已授权/.test(String(wCreateTool?.description)),
    String(wCreateTool?.description).slice(0, 120));
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

  // ── [MCP-W] 链上**写** tool: 真签名真移钱 · 授权意图必填 · 失败不变成成功 ─────
  section('⑰ [MCP 写] `bolloon_chain_trade_create|submit_proof|release` — 真写 / 未授权拒 / 越额拒 / 审计');
  const { chainRequestIdOf } = await import('../src/agents/chain/chain-wallet.js') as any;
  const { onchainTaskKey } = await import('../src/agents/chain/onchain-trade.js') as any;
  const auditOf = (h: string): string[] => {
    const p = path.join(h, '.bolloon', 'wallet-signatures.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
  };
  const tokenBal = async (a: string): Promise<bigint> => (token ? BigInt(await token.balanceOf(a)) : 0n);
  const MCP_WRITE_TASK = `p6-mcp-write-${runId}`;
  const ridCreate = `p6mcp-${runId}-create`;
  const ridProof = `p6mcp-${runId}-proof`;
  const ridRelease = `p6mcp-${runId}-release`;

  const mcpW = new McpClient(envMain);
  const wInit = await mcpW.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-chain-cli-write', version: '1.0.0' } });
  check('MCP 写会话: initialize 真握手 (serverInfo.name=bolloon)', wInit?.result?.serverInfo?.name === 'bolloon', wInit?.result?.serverInfo?.version);
  await mcpW.notify('notifications/initialized', {});
  const wList = await mcpW.request(2, 'tools/list');
  const wNames = (wList?.result?.tools || []).map((t: any) => t.name);
  check('MCP 写会话: tools/list 能看到 3 个写 tool 且总数 = 27', WRITE_TOOL_NAMES.every((n) => wNames.includes(n)) && wNames.length === 27, wNames.length);

  // ① 真写 create: 买方节点真签名 → 真交易 → 真 USDC 进 escrow 托管
  const escrowBal0 = await tokenBal(DEP.escrowAddress);
  const auditBefore = auditOf(HOME).length;
  const wCreate = await mcpW.request(3, 'tools/call', { name: 'bolloon_chain_trade_create', arguments: { taskId: MCP_WRITE_TASK, agent: sellerAddr, amount: '0.02', paymentMode: 'agent-authorized', requestId: ridCreate } });
  const wcEnv = wCreate?.result?.structuredContent;
  const wcTxHash = String(wcEnv?.data?.txHash || '');
  console.log(`  MCP create: isError=${wCreate?.result?.isError} ok=${wcEnv?.ok} code=${wcEnv?.code} tx=${wcTxHash}`);
  check('★ MCP 真写 create: isError=false + ok:true + code OK', wCreate?.result?.isError === false && wcEnv?.ok === true && wcEnv?.code === 'OK', wcEnv?.message?.slice(0, 120));
  check('MCP 真写 create: 真 txHash + chainSettled + EscrowCreatedV2 + escrow ACTIVE', /^0x[0-9a-f]{64}$/.test(wcTxHash) && wcEnv?.data?.chainSettled === true && wcEnv?.data?.matchedEvent === 'EscrowCreatedV2' && wcEnv?.data?.escrowState === 'ACTIVE', { tx: wcTxHash, st: wcEnv?.data?.escrowState });
  check('MCP 真写 create: 授权意图声明被如实回显 (paymentMode + declaredRequestId)', wcEnv?.data?.authIntent?.paymentMode === 'agent-authorized' && wcEnv?.data?.authIntent?.declaredRequestId === ridCreate, wcEnv?.data?.authIntent);
  check('MCP 真写 create: 输出里没有私钥串 + privateKeyTouched=false (红线)', !String(wCreate?.result?.content?.[0]?.text || '').includes(buyerKey) && wcEnv?.data?.privateKeyTouched === false, 'clean');
  const wcReceipt = await safeReceipt(provider, wcTxHash);
  const wcTxObj = await safeTx(provider, wcTxHash);
  check('★ 链上复核 (不信信封): receipt.status=1 且 tx.to == escrow 合约', wcReceipt?.status === 1 && String(wcTxObj?.to).toLowerCase() === DEP.escrowAddress.toLowerCase(), { status: wcReceipt?.status, to: wcTxObj?.to, block: wcReceipt?.blockNumber });
  const escrowBal1 = await tokenBal(DEP.escrowAddress);
  check('★ 链上复核: 真移钱 —— escrow 的 token 余额 +20000 原子 (0.02 USDC)', escrowBal1 - escrowBal0 === 20000n, { before: escrowBal0.toString(), after: escrowBal1.toString() });

  const auditNew = auditOf(HOME).slice(auditBefore);
  const lastRow = auditNew.length ? JSON.parse(auditNew[auditNew.length - 1]) : null;
  const expectRid = chainRequestIdOf({ method: 'createEscrowV2', taskKey: onchainTaskKey(MCP_WRITE_TASK), amountAtomic: '20000', intentNonce: ridCreate }, LOCAL_DEV_CHAIN_ID);
  check('审计: 成功写在 ~/.bolloon/wallet-signatures.jsonl 真留 1 行 (临时 HOME)', auditNew.length === 1, { path: path.join(HOME, '.bolloon', 'wallet-signatures.jsonl').replace(ROOT, '<tmp>'), lines: auditOf(HOME).length });
  check('审计: requestId = 按**声明的 requestId** 派生的链上 requestId (声明真进了放行闸)', lastRow?.requestId === expectRid, { got: lastRow?.requestId, want: expectRid });
  check('审计: 不记私钥 / 不记任务正文 (只记摘要)', !!lastRow && !auditNew.join('').includes(buyerKey) && !/"privateKey"|"mnemonic"|"seed"|"secret"|"instruction"|"taskText"/.test(auditNew.join('')), Object.keys(lastRow || {}).join(','));

  // ② submit-proof (卖方节点签名) + ③ release (买方签名) —— 同一个 MCP 写闭环
  const sellerBal0 = await tokenBal(sellerAddr);
  const sellerAudit0 = auditOf(HOME_SELLER).length;
  const mcpS = new McpClient(envSeller);
  await mcpS.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-chain-cli-write-seller', version: '1.0.0' } });
  await mcpS.notify('notifications/initialized', {});
  const wProof = await mcpS.request(2, 'tools/call', { name: 'bolloon_chain_trade_submit_proof', arguments: { taskId: MCP_WRITE_TASK, result: `mcp-delivery:${MCP_WRITE_TASK}`, paymentMode: 'agent-authorized', requestId: ridProof } });
  const wpEnv = wProof?.result?.structuredContent;
  console.log(`  MCP submit-proof (卖方): isError=${wProof?.result?.isError} ok=${wpEnv?.ok} tx=${wpEnv?.data?.txHash}`);
  check('★ MCP 真写 submit-proof (卖方节点真签名): isError=false + ok:true + ProofSubmittedV2', wProof?.result?.isError === false && wpEnv?.ok === true && wpEnv?.data?.matchedEvent === 'ProofSubmittedV2', wpEnv?.data?.txHash);
  check('MCP 真写 submit-proof: 声明要求卖方节点显式授权 (statement 里 authIntent 回显)', wpEnv?.data?.authIntent?.declaredRequestId === ridProof, wpEnv?.data?.authIntent);
  check('审计: 卖方节点的 submit-proof 也留 1 行 (各自 HOME 独立)', auditOf(HOME_SELLER).length === sellerAudit0 + 1, auditOf(HOME_SELLER).length);
  const sProofExit = await mcpS.close();
  check('卖方 MCP 会话收尾: 正常退出', sProofExit === 0, sProofExit);

  const wRelease = await mcpW.request(4, 'tools/call', { name: 'bolloon_chain_trade_release', arguments: { taskId: MCP_WRITE_TASK, paymentMode: 'agent-authorized', requestId: ridRelease } });
  const wrEnv = wRelease?.result?.structuredContent;
  console.log(`  MCP release: isError=${wRelease?.result?.isError} ok=${wrEnv?.ok} code=${wrEnv?.code} tx=${wrEnv?.data?.txHash}`);
  check('★ MCP 真写 release (买方真签名): isError=false + ok:true + grantsVerified + escrow RELEASED', wRelease?.result?.isError === false && wrEnv?.ok === true && wrEnv?.data?.grantsVerified === true && wrEnv?.data?.escrowState === 'RELEASED', { tx: wrEnv?.data?.txHash, st: wrEnv?.data?.escrowState });
  const sellerBal1 = await tokenBal(sellerAddr);
  check('★ 链上复核: release 后 seller 的 token 余额 +20000 原子 (钱真到账 seller)', sellerBal1 - sellerBal0 === 20000n, { before: sellerBal0.toString(), after: sellerBal1.toString() });
  check('审计: 买方节点共 +2 行 (create + release), 卖方 1 行 —— 每次成功写都留痕', auditOf(HOME).length === auditBefore + 2, auditOf(HOME).length - auditBefore);

  // ④ 未授权 (有钱包、有链配置, 但本机没授权) → 必须被放行闸拒, 且不写审计
  const mcpN = new McpClient(envNoAuth);
  await mcpN.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-chain-cli-noauth', version: '1.0.0' } });
  await mcpN.notify('notifications/initialized', {});
  const noAuthAudit0 = auditOf(HOME_NOAUTH).length;
  const nCreate = await mcpN.request(2, 'tools/call', { name: 'bolloon_chain_trade_create', arguments: { taskId: `p6-mcp-noauth-${runId}`, agent: sellerAddr, amount: '0.02', paymentMode: 'agent-authorized', requestId: `p6mcp-${runId}-noauth` } });
  const nEnv = nCreate?.result?.structuredContent;
  console.log(`  MCP create (未授权): isError=${nCreate?.result?.isError} ok=${nEnv?.ok} code=${nEnv?.code} authReason=${fmt(nEnv?.data?.authReason)}`);
  check('★ 未授权: isError=true + ok:false + code=NOT_AUTHORIZED (没变成 MCP 成功)', nCreate?.result?.isError === true && nEnv?.ok === false && nEnv?.code === 'NOT_AUTHORIZED', nEnv?.code);
  check('未授权: authorized=false + txHash=null (没发交易) + 原因指明 agentAuthorized', nEnv?.data?.authorized === false && (nEnv?.data?.txHash ?? null) === null && /agentAuthorized/.test(String(nEnv?.data?.authReason)), nEnv?.data?.authReason);
  check('未授权: 没写审计 (拒签不留痕) + 输出无授权意图代填', auditOf(HOME_NOAUTH).length === noAuthAudit0 && !String(nCreate?.result?.content?.[0]?.text || '').includes(buyerKey), auditOf(HOME_NOAUTH).length);

  const nMissing = await mcpN.request(3, 'tools/call', { name: 'bolloon_chain_trade_release', arguments: { taskId: 'whatever' } });
  const nmEnv = nMissing?.result?.structuredContent;
  check('★ 缺 paymentMode/requestId: isError=true + NOT_AUTHORIZED + requiresExplicitAuthorization (fail-closed)', nMissing?.result?.isError === true && nmEnv?.code === 'NOT_AUTHORIZED' && nmEnv?.data?.requiresExplicitAuthorization === true, nmEnv?.data?.missing);
  const nBadMode = await mcpN.request(4, 'tools/call', { name: 'bolloon_chain_trade_release', arguments: { taskId: 'whatever', paymentMode: 'auto-pilot', requestId: 'r-1' } });
  check('paymentMode 不在冻结词表: isError=true + INVALID_ARGUMENT (不静默退回)', nBadMode?.result?.isError === true && nBadMode?.result?.structuredContent?.code === 'INVALID_ARGUMENT', nBadMode?.result?.structuredContent?.code);
  const nManual = await mcpN.request(5, 'tools/call', { name: 'bolloon_chain_trade_create', arguments: { taskId: `p6-mcp-manual-${runId}`, agent: sellerAddr, amount: '0.02', paymentMode: 'manual', requestId: `p6mcp-${runId}-manual` } });
  const nmManEnv = nManual?.result?.structuredContent;
  check('★ 声明 manual (词表合法但非自主): 被放行闸按 modeIsAutonomous 拒 → NOT_AUTHORIZED + 没发交易', nManual?.result?.isError === true && nmManEnv?.code === 'NOT_AUTHORIZED' && nmManEnv?.data?.authorized === false && (nmManEnv?.data?.txHash ?? null) === null, nmManEnv?.data?.authReason);
  const mcpNExit = await mcpN.close();
  check('未授权 MCP 会话收尾: 正常退出', mcpNExit === 0, mcpNExit);

  // ⑤ 越额 (0.5 > M1 单次上限 0.02) → 预算门拒, 钱没动、审计不增
  const auditBeforeOver = auditOf(HOME).length;
  const wOver = await mcpW.request(5, 'tools/call', { name: 'bolloon_chain_trade_create', arguments: { taskId: `p6-mcp-over-${runId}`, agent: sellerAddr, amount: '0.5', paymentMode: 'agent-authorized', requestId: `p6mcp-${runId}-over` } });
  const woEnv = wOver?.result?.structuredContent;
  console.log(`  MCP create (越额 0.5): isError=${wOver?.result?.isError} ok=${woEnv?.ok} code=${woEnv?.code} layer=${woEnv?.data?.layer}`);
  check('★ 越额 (0.5 > M1 单次 0.02): isError=true + BUDGET_EXCEEDED + layer=perPurchase', wOver?.result?.isError === true && woEnv?.ok === false && woEnv?.code === 'BUDGET_EXCEEDED' && woEnv?.data?.layer === 'perPurchase', woEnv?.message?.slice(0, 120));
  check('越额: 钱没动 (txHash 缺席/null) + next_action=raise_budget + 没写审计', (woEnv?.data?.txHash ?? null) === null && woEnv?.next_action === 'raise_budget' && auditOf(HOME).length === auditBeforeOver, { next: woEnv?.next_action });
  const wExit = await mcpW.close();
  check('写会话收尾: stdin 关闭后 server 正常退出', wExit === 0, wExit);

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
  console.log(`  MCP 写 (真签名真移钱): create tx = ${wcTxHash} · proof tx = ${wpEnv?.data?.txHash} · release tx = ${wrEnv?.data?.txHash}`);
  console.log(`    链上复核: escrow 余额 ${escrowBal0} → ${escrowBal1} 原子 · seller 余额 ${sellerBal0} → ${sellerBal1} 原子 · 审计 ${path.join(HOME, '.bolloon', 'wallet-signatures.jsonl').replace(ROOT, '<tmp>')}`);
  console.log(`  临时 HOME=${HOME} (链上状态/索引/交易记录都在这里, 供审计)`);
  console.log(`  链来源 = ${EXPLICIT_RPC ? `共享链 ${RPC_URL}` : `隔离链 (fork 自 ${UPSTREAM_RPC}, 跑完即关) ${RPC_URL}`} · 部署事实来自 ${DEP.label}`);
  printTally();
  try { provider.destroy(); } catch { /* noop */ }
  try { isolated?.stop(); } catch { /* noop */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  // ★ 脚本自身异常也要落进台账并打印: 否则"没看到红的断言行"会被误读成"全绿"
  console.error('\n[verify-chain-cli] 脚本异常:', e?.shortMessage || e?.message || e);
  if (process.env.DEBUG) console.error(e?.stack);
  failed += 1;
  failures.push(`脚本异常 (不是断言失败): ${String(e?.shortMessage || e?.message || e).slice(0, 160)}`);
  printTally();
  process.exit(1);
});
