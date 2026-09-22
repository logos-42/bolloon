/**
 * verify-chain-explorer.ts — P7「网页 Explorer」真实验收
 * =========================================================================
 * 全部对着**真东西**跑: 真链 (本地 anvil 31337 真事件) · 真索引文件 · 真 web server (真 HTTP) ·
 * 真 Google Chrome (CDP, 真读页面上的数字 / 真点「加载更多」/ 真交未知 taskKey)。
 * 不 mock 路由、不 mock fetch (只有「退化路径」故意指向死端口, 那才是要验的场景)。
 *
 * 断言分组:
 *   ① 索引是**真**的: 从 manifest 的 deployment block 起真同步本地链, 落了真事件 (条数/事件名都打印)
 *   ② 路由真数据: /api/chain/index/{status,stats,events,timeline} 的 HTTP 状态码 + 返回内容
 *      与盘上 index.json **逐项核对** (stats 由本脚本独立重算, 不复用查询层, 避免自证)
 *   ③ cursor 增量: limit=3 拉第 1 页 → 用 nextCursor 拉第 2 页 → 两页拼起来 == 全量, 无重叠无遗漏
 *   ④ 时间线: 真 taskKey 的事件与索引一致; **未知 taskKey 返回空** (不是编造); 非法 taskKey 400
 *   ⑤ 页面资源: /explorer 与 /chain 都能拿到 HTML; HTML 含必要钩子; 编译产物含前端纪律, 且**无 innerHTML**
 *   ⑥ 真 Chrome: 页面上读到的数字 == 路由 JSON; 点「加载更多」行数真增加; 点行看单 escrow 时间线;
 *      未知 taskKey 显示显式空态; 整页可见文本**不含完整地址/哈希/DID**; 无 console 报错
 *   ⑦ 降级: 后端不可用 → 路由层 fetchSnapshot 与页面都进显式降级态, 数字全 '—' (不拿 0 顶替)
 *
 * 跑法 (anvil 要先在跑):
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 &
 *   npx tsx scripts/verify-chain-explorer.ts                 # 默认: 临时 HOME (不污染真实 ~/.bolloon)
 *   npx tsx scripts/verify-chain-explorer.ts --home "$HOME"  # 对着真实 HOME 的 ~/.bolloon/chain/index.json
 *   npx tsx scripts/verify-chain-explorer.ts --no-chrome     # 跳过浏览器段 (只跑 HTTP/静态资源)
 *
 * 边界: 不发任何付款/放款以外的写操作; 不打印私钥 (只用 anvil 公开开发助记符); 不碰 contracts/ 任何文件。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { JsonRpcProvider, Contract, HDNodeWallet, Mnemonic, Wallet } from 'ethers';

// ── 断言工具 ────────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const failures: string[] = [];
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail !== undefined ? `  — ${fmt(detail)}` : ''}`); }
  return ok;
}
const fmt = (d: unknown) => (typeof d === 'string' ? d : j(d)).slice(0, 320);
const section = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
// 事件页 (cursor 增量) 的条目**没有**顶层 taskKey (只有 args.taskKey), 索引条目两层都有 —— 取键统一从这里走
const keyOf = (e: any) => String(e?.taskKey || e?.args?.taskKey || '').toLowerCase();

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
};
const USE_REAL_HOME = argv.includes('--real-home') || argVal('--home') !== null;
const HOME = argVal('--home') || fs.mkdtempSync(path.join(os.tmpdir(), 'cx-verify-'));
const NO_CHROME = argv.includes('--no-chrome');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCAL_RPC = process.env.BOLLOON_CHAIN_RPC_URL || 'http://127.0.0.1:8545';
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const INDEX_FILE = path.join(HOME, '.bolloon', 'chain', 'index.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Chrome 一定要用**真实 HOME** 起 (实测: 把 HOME 指到临时目录的 Chrome, 一遇到真实
//   HTTP 导航就把 CDP 整条挂住 —— Page.navigate 永不返回; 浏览器进程归浏览器进程, 别让
//   验收的 HOME 隔离污染它)。先把它记下来, 再覆盖 process.env.HOME。
const REAL_HOME_FOR_BROWSER = process.env.HOME || os.homedir();

// ★ 只读路由按 process.env.HOME 解析 ~/.bolloon/chain/index.json —— 验收要保证
//   "路由读的那份文件 == 本脚本核对的那份", 所以这里把 HOME 钉死成参数给的那个。
//   (临时模式 = 隔离; --home $HOME = 对着真实的 ~/.bolloon/chain/index.json 验)
process.env.HOME = HOME;

// 前端模块 (纯函数直接 import 真源码, 不复制一份逻辑)
const CX: any = await import('../src/web/chain-explorer.js');
// 索引/链上模块
const CHAIN: any = await import('../src/agents/chain/index.js');
const { ChainIndexer, resolveDeploymentInfo, getIndexStatus, getIndexStats } = CHAIN;
const { AGENT_ESCROW_V2_ABI } = await import('../src/agents/chain/escrow-client.js');

const ERC20_ABI = [
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function allowance(address,address) view returns (uint256)',
];
const WRITE_ABI = [...(AGENT_ESCROW_V2_ABI as unknown as string[])];

async function main() {
  console.log(`HOME               : ${HOME}${USE_REAL_HOME ? '  (真实 HOME)' : '  (临时 HOME, 不污染 ~/.bolloon)'}`);
  console.log(`索引文件           : ${INDEX_FILE}`);
  console.log(`本地 RPC           : ${LOCAL_RPC}`);

  // ═════════════════════════════════════════════════════════════════════════
  section('① 造真索引: 本地 anvil 真事件 (从 manifest 的 deployment block 起)');
  const manifest = JSON.parse(fs.readFileSync(path.resolve('contracts/deployments/localhost.json'), 'utf8'));
  const escrowAddr = manifest.contracts.find((c: any) => c.name === 'AgentEscrow').address;
  const tokenAddr = manifest.externalToken.address;
  const provider = new JsonRpcProvider(LOCAL_RPC);
  let chainId = 0;
  try { chainId = Number((await provider.getNetwork()).chainId); } catch (e: any) {
    console.log(`  ❌ 连不上本地链 ${LOCAL_RPC}: ${e?.message}`);
    console.log('  先起 anvil: DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545');
    process.exit(1);
  }
  check('本地链 chainId == 31337 (真 anvil)', chainId === 31337, chainId);
  const head = await provider.getBlockNumber();
  const info = resolveDeploymentInfo({
    chainId: 31337, escrowAddress: escrowAddr, deploymentsDir: path.resolve('contracts/deployments'),
  });
  console.log(`  escrow           : ${CX.shortHex(escrowAddr)}  (完整值只在内存里, 打印也短写)`);
  console.log(`  deploymentBlock  : ${info.deploymentBlock} (来源: ${info.source})`);
  console.log(`  链上 head        : ${head}`);
  check('索引起点来自 manifest (非硬编码)', info.deploymentBlock === Number(manifest.contracts.find((c: any) => c.name === 'AgentEscrow').blockNumber), info.deploymentBlock);

  const idx = new ChainIndexer({
    provider, escrowAddress: escrowAddr, chainId: 31337, networkName: 'localhost',
    deploymentBlock: info.deploymentBlock, deploymentSource: info.source, home: HOME, pageSize: 2000,
  });

  // 先造一条**刚上链**的事件 (真交易), 证明"新事件会进索引, 页面随后能看到它"。
  let freshNote = '(未尝试)';
  let freshTaskKey: string | null = null;
  try {
    const buyer = new Wallet(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(DEV_MNEMONIC), "m/44'/60'/0'/0/0").privateKey, provider);
    const agent = new Wallet(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(DEV_MNEMONIC), "m/44'/60'/0'/0/1").privateKey, provider);
    const token = new Contract(tokenAddr, ERC20_ABI, provider);
    const escrow = new Contract(escrowAddr, WRITE_ABI, provider);
    const allowance: bigint = await token.allowance(buyer.address, escrowAddr);
    const AMOUNT = 10_000_000n;
    if (allowance < AMOUNT) {
      freshNote = `(跳过: buyer allowance ${allowance} < ${AMOUNT})`;
    } else {
      const taskId = `bolloon-explorer-verify-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const taskKey = CHAIN.computeTaskKeyOffChain(taskId);
      const now = BigInt((await provider.getBlock('latest'))!.timestamp);
      const pop = await escrow.connect(buyer).createEscrowV2.populateTransaction(
        taskKey, agent.address, AMOUNT, tokenAddr,
        CHAIN.computeResultHashOffChain(`terms:${taskId}`), CHAIN.computeResultHashOffChain(`quote:${taskId}`),
        CHAIN.computeResultHashOffChain(`input:${taskId}`), CHAIN.computeResultHashOffChain(`manifest:${taskId}`),
        now + 3600n, 3600, 1,
      );
      const fee = await provider.getFeeData();
      const nonce = await provider.getTransactionCount(buyer.address, 'pending');
      const raw = await buyer.signTransaction({
        ...pop, nonce, chainId: 31337, type: 2, gasLimit: 900_000n,
        maxFeePerGas: fee.maxFeePerGas ?? 2_000_000_000n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1_000_000_000n,
      });
      const sent = await provider.broadcastTransaction(raw);
      const rc = await sent.wait();
      freshNote = `tx=${CX.shortHex(sent.hash)} block=${rc!.blockNumber} status=${rc!.status}`;
      freshTaskKey = String(taskKey).toLowerCase();
      console.log(`  新造事件 (真交易) : ${freshNote}  taskKey=${CX.shortHex(taskKey)}`);
      await sleep(1000); // 让 anvil 的新块 / provider 的 blockNumber 缓存都稳定下来
    }
  } catch (e: any) {
    freshNote = `(造新事件失败, 如实降级: ${String(e?.shortMessage || e?.message || e).slice(0, 120)})`;
    console.log(`  ⚠ ${freshNote}`);
  }

  const sync = await idx.syncFrom();
  console.log(`  同步              : 扫 [${sync.scanFrom}, ${sync.scanTo}] pages=${sync.pages} 日志=${sync.logsFound} 新增=${sync.inserted} 去重=${sync.deduped}`);
  check('索引文件落在 HOME/.bolloon/chain/index.json', fs.existsSync(INDEX_FILE), INDEX_FILE);
  const disk = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  check('索引里有真事件 (entries > 0)', disk.entries.length > 0, `${disk.entries.length} 条 · head=${disk.headBlock} · lastSyncedBlock=${disk.lastSyncedBlock}`);
  check('每条事件都有 txHash/blockNumber/logIndex/finality',
    disk.entries.every((e: any) => /^0x[0-9a-f]{64}$/i.test(String(e.txHash)) && Number.isInteger(e.blockNumber) && Number.isInteger(e.logIndex) && ['observed', 'confirmed', 'finalized'].includes(e.finality)),
    disk.entries.slice(0, 1).map((e: any) => `${e.eventName}@${e.blockNumber}+${e.logIndex} ${e.finality}/${e.confirmations}conf`));
  if (freshTaskKey) {
    check('刚造的那笔真交易已进索引 (新事件会流到页面)', disk.entries.some((e: any) => keyOf(e) === freshTaskKey), `${CX.shortHex(freshTaskKey)} 在索引里`);
  }
  const finalitySeen = new Set(disk.entries.map((e: any) => e.finality));
  console.log(`  finality 实见档位  : ${[...finalitySeen].join(', ')}  (门槛 confirmed=${disk.confirmations.confirmed} / finalized=${disk.confirmations.finalized}, 确认数 = head-block+1)`);
  check('★ finality 不是写死的: 每条都等于按门槛从确认数算出来的值',
    disk.entries.every((e: any) => {
      const conf = disk.headBlock - e.blockNumber + 1;
      const want = conf >= disk.confirmations.finalized ? 'finalized' : (conf >= disk.confirmations.confirmed ? 'confirmed' : 'observed');
      return e.confirmations === conf && e.finality === want;
    }), `例: head=${disk.headBlock} 的条目 → ${disk.entries.filter((e: any) => e.blockNumber === disk.headBlock).map((e: any) => `${e.finality}/${e.confirmations}`).join(',') || '无'}`);

  // ═════════════════════════════════════════════════════════════════════════
  section('② 真 HTTP: 路由返回的必须与盘上 index.json 一致 (逐项核对)');
  // ★ 真“监听”: web server 起在**子进程**里 (bolloon --web), 本进程只做 HTTP/浏览器客户端。
  //   为什么不用同进程 createWebServer: 实测同进程跑 bolloon 时, Chrome 的 CDP
  //   Page.navigate / Runtime.evaluate 会整条挂住 (页面永远不 ready)。子进程模式既是
  //   生产里真正的跑法 (bolloon --web), 也让验收脚本本身保持干净。
  const PORT = 54100 + Math.floor(Math.random() * 400);
  const serverOut: string[] = [];
  // 子进程脚本 (写在临时 HOME 里, 跑完随 HOME 一起删): 只做"真监听", 故意不调 openBrowser
  // (bolloon --web 会 `open <url>` 打开你的真浏览器 —— 验收不该劫持用户的浏览器)
  const childScript = path.join(HOME, '__verify-web-server.mts');
  fs.writeFileSync(childScript, [
    `const { createWebServer } = await import(${JSON.stringify(path.resolve('src/web/server.js'))});`,
    `const started = await createWebServer(Number(process.env.PORT), { selfImprove: false, host: '127.0.0.1' });`,
    `console.log('BOLLOON_PORT=' + started.port);`,
  ].join('\n'), 'utf8');
  const serverChild = spawn('npx', ['tsx', childScript], {
    cwd: process.cwd(),
    env: { ...process.env, HOME, PORT: String(PORT), BOLLOON_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const noteOut = (d: any) => { const s = String(d); serverOut.push(s); if (serverOut.length > 400) serverOut.shift(); };
  serverChild.stdout.on('data', noteOut);
  serverChild.stderr.on('data', noteOut);
  let listeningPort = PORT;
  let up = false;
  for (let i = 0; i < 200; i++) { // 最多 100s (bolloon 冷启动含 P2P/cron 约 25s)
    const m = /BOLLOON_PORT=(\d+)/.exec(serverOut.join(''));
    if (m) listeningPort = Number(m[1]);
    try { const r = await fetch(`http://127.0.0.1:${listeningPort}/api/health`); if (r.status === 200) { up = true; break; } } catch { /* 还在启动 */ }
    await sleep(500);
  }
  const BASE = `http://127.0.0.1:${listeningPort}`;
  console.log(`  web server        : ${BASE}  (子进程 ${'`'}createWebServer${'`'} 真监听 · HOME=${HOME} · pid=${serverChild.pid} · 冷启动 ${up ? 'OK' : '失败'})`);
  check('★ 真监听: 子进程 web server 起来并 /api/health 200', up, `HTTP ${up ? 200 : '未就绪'} · BOLLOON_PORT=${listeningPort}`);
  if (!up) {
    console.log('  子进程输出尾部:'); console.log(serverOut.join('').split('\n').slice(-12).map((l) => `    ${l}`).join('\n'));
  }

  try {
    // ②-a status
    const rStatus = await fetch(`${BASE}/api/chain/index/status`);
    const bStatus: any = await rStatus.json();
    check('GET /api/chain/index/status → 200', rStatus.status === 200, `HTTP ${rStatus.status}`);
    check('status.ok === true', bStatus.ok === true);
    check('★ 高度与 index.json 一致 (lastSyncedBlock)', bStatus.status.lastSyncedBlock === disk.lastSyncedBlock, `${bStatus.status.lastSyncedBlock} == ${disk.lastSyncedBlock}`);
    check('★ head 与 index.json 一致', bStatus.status.headBlock === disk.headBlock, `${bStatus.status.headBlock} == ${disk.headBlock}`);
    check('★ 事件条数与 index.json 一致', bStatus.status.entries === disk.entries.length, `${bStatus.status.entries} == ${disk.entries.length}`);
    check('★ 最后同步时间与 index.json 一致', bStatus.status.lastSyncedAt === disk.lastSyncedAt, `${bStatus.status.lastSyncedAt} == ${disk.lastSyncedAt}`);
    check('★ escrow 地址与 index.json 一致', String(bStatus.status.escrowAddress).toLowerCase() === String(disk.escrowAddress).toLowerCase(), bStatus.status.escrowAddress);
    check('确认数门槛来自索引 (1/12)', bStatus.status.confirmations?.confirmed === 1 && bStatus.status.confirmations?.finalized === 12, bStatus.status.confirmations);

    // ②-b stats: 本脚本独立重算 (不复用查询层, 避免"自己验自己")
    const rStats = await fetch(`${BASE}/api/chain/index/stats`);
    const bStats: any = await rStats.json();
    const live = disk.entries.filter((e: any) => !e.suspect);
    const byName = (n: string) => live.filter((e: any) => e.eventName === n).length;
    const recomputed = {
      entries: disk.entries.length,
      tasks: new Set(live.filter((e: any) => e.eventName === 'EscrowCreatedV2').map((e: any) => keyOf(e))).size,
      created: byName('EscrowCreatedV2'), proofSubmitted: byName('ProofSubmittedV2'), released: byName('ReleasedV2'),
      refunded: byName('RefundedV2'), disputed: byName('DisputedV2'), expired: byName('ExpiredV2'),
    };
    check('GET /api/chain/index/stats → 200', rStats.status === 200, `HTTP ${rStats.status}`);
    check('★ stats.entries == 独立重算', bStats.stats.entries === recomputed.entries, `${bStats.stats.entries} == ${recomputed.entries}`);
    check('★ tasks(唯一 taskKey) == 独立重算', bStats.stats.tasks === recomputed.tasks, `${bStats.stats.tasks} == ${recomputed.tasks}`);
    for (const k of ['created', 'proofSubmitted', 'released', 'refunded', 'disputed', 'expired'] as const) {
      check(`★ ${k} == 独立重算`, bStats.stats[k] === recomputed[k], `${bStats.stats[k]} == ${recomputed[k]}`);
    }
    const diskBf = { observed: 0, confirmed: 0, finalized: 0 } as any;
    for (const e of disk.entries) diskBf[e.finality]++;
    check('★ byFinality 三档 == 独立重算', j(bStats.stats.byFinality) === j(diskBf), `${j(bStats.stats.byFinality)} == ${j(diskBf)}`);
    check('三档之和 == 总条数 (没有第四条腿)', bStats.stats.byFinality.observed + bStats.stats.byFinality.confirmed + bStats.stats.byFinality.finalized === bStats.stats.entries);

    // ═══════════════════════════════════════════════════════════════════════
    section('③ cursor 增量: 第 1 页 + 第 2 页 == 全量 (无重叠 / 无遗漏)');
    const rFull = await fetch(`${BASE}/api/chain/index/events?limit=1000`);
    const bFull: any = await rFull.json();
    const full: any[] = bFull.page.events;
    check('GET /api/chain/index/events?limit=1000 → 200', rFull.status === 200, `HTTP ${rFull.status} · ${full.length} 条`);
    check('★ 全量 == 盘上 index.json 条数', full.length === disk.entries.length, `${full.length} == ${disk.entries.length}`);
    check('全量按 (blockNumber, logIndex) 升序', full.every((e: any, i: number) => i === 0 || e.blockNumber > full[i - 1].blockNumber || (e.blockNumber === full[i - 1].blockNumber && e.logIndex > full[i - 1].logIndex)));

    const rP1 = await fetch(`${BASE}/api/chain/index/events?limit=3`);
    const bP1: any = await rP1.json();
    const p1 = { events: bP1.page.events, nextCursor: bP1.page.nextCursor, hasMore: bP1.page.hasMore, remaining: bP1.page.remaining };
    check('第 1 页 (limit=3) → 200 且正好 3 条', rP1.status === 200 && p1.events.length === 3, `HTTP ${rP1.status} · ${p1.events.length} 条 · hasMore=${p1.hasMore}`);
    check('第 1 页 nextCursor = 末条的 (block, logIndex)', p1.events.length === 3 && p1.nextCursor?.blockNumber === p1.events[2].blockNumber && p1.nextCursor?.logIndex === p1.events[2].logIndex, p1.nextCursor);

    const rP2 = await fetch(`${BASE}/api/chain/index/events?blockNumber=${p1.nextCursor?.blockNumber}&logIndex=${p1.nextCursor?.logIndex}&limit=3`);
    const bP2: any = await rP2.json();
    const p2 = { events: bP2.page.events, nextCursor: bP2.page.nextCursor, hasMore: bP2.page.hasMore, remaining: bP2.page.remaining };
    check('第 2 页 (带 cursor) → 200 且正好 3 条', rP2.status === 200 && p2.events.length === 3, `HTTP ${rP2.status} · ${p2.events.length} 条`);
    check('★ 第 2 页严格在 cursor 之后 (无缝)', p1.events.length === 3 && p2.events.length === 3 && CX.pageBoundaryIsExact(p1, p2),
      `p1末=${p1.events[2]?.blockNumber}:${p1.events[2]?.logIndex} → p2首=${p2.events[0]?.blockNumber}:${p2.events[0]?.logIndex}`);
    const k1 = new Set(p1.events.map((e: any) => CX.cursorKey(e)));
    check('★ 两页无重叠 (cursor key 不相交)', p2.events.every((e: any) => !k1.has(CX.cursorKey(e))), [...k1].join(','));
    const merged = CX.mergeEntries([], [...p1.events, ...p2.events]);
    check('★ 两页拼起来 == 全量的前 6 条 (逐条一致)', j(merged) === j(full.slice(0, 6)), `${merged.length} 条`);
    check('分页不丢: remaining 递减', p1.remaining === full.length && p2.remaining === full.length - 3, `${p1.remaining} → ${p2.remaining}`);

    // 全量分页走一遍: 每页 7 条, 拼起来必须与全量逐条相等
    const pages: any[] = [];
    let cursor: any = null;
    for (let guard = 0; guard < 500; guard++) {
      const q = cursor ? `blockNumber=${cursor.blockNumber}&logIndex=${cursor.logIndex}&` : '';
      const r = await fetch(`${BASE}/api/chain/index/events?${q}limit=7`);
      const b: any = await r.json();
      pages.push({ events: b.page.events, nextCursor: b.page.nextCursor, hasMore: b.page.hasMore, remaining: b.page.remaining });
      if (!b.page.hasMore) break;
      cursor = b.page.nextCursor;
    }
    let acc: any[] = [];
    for (const p of pages) acc = CX.mergeEntries(acc, p.events);
    check(`★ ${pages.length} 页走完拼起来 == 全量 (无重叠无遗漏)`, j(acc) === j(full), `${acc.length} == ${full.length}`);
    check('翻页期间 hasMore=false 只在最后一页出现', pages.slice(0, -1).every((p) => p.hasMore) && !pages[pages.length - 1].hasMore);
    check('空 cursor (越界) 返回空页而不是报错', await (async () => {
      const r = await fetch(`${BASE}/api/chain/index/events?blockNumber=99999999&logIndex=0&limit=5`);
      const b: any = await r.json();
      return r.status === 200 && b.page.events.length === 0 && b.page.hasMore === false;
    })());

    // ═══════════════════════════════════════════════════════════════════════
    section('④ 单个 escrow 时间线 + 未知 taskKey (返回空, 不编造)');
    const realKey = keyOf(full[0]);
    const rTl = await fetch(`${BASE}/api/chain/index/timeline?taskKey=${realKey}`);
    const bTl: any = await rTl.json();
    const expected = disk.entries.filter((e: any) => keyOf(e) === realKey)
      .sort((a: any, b: any) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    check('GET /api/chain/index/timeline (真 taskKey) → 200', rTl.status === 200, `HTTP ${rTl.status} · ${bTl.timeline?.count} 条`);
    check('★ 时间线条数 == 索引里该 taskKey 的条数', bTl.timeline.count === expected.length, `${bTl.timeline.count} == ${expected.length}`);
    check('★ 时间线事件与索引逐条一致 (事件名+块号+logIndex)',
      j(bTl.timeline.events.map((e: any) => `${e.eventName}@${e.blockNumber}:${e.logIndex}`)) === j(expected.map((e: any) => `${e.eventName}@${e.blockNumber}:${e.logIndex}`)),
      j(bTl.timeline.events.map((e: any) => `${e.eventName}@${e.blockNumber}:${e.logIndex}`)));
    check('时间线带 finality (三档之一) 与 confirmations',
      bTl.timeline.events.every((e: any) => ['observed', 'confirmed', 'finalized'].includes(e.finality) && Number.isInteger(e.confirmations)), bTl.timeline.events.map((e: any) => e.finality).join(','));
    check('时间线状态由事件推出 (非 null 当有 create 事件)', typeof bTl.timeline.state === 'string' && bTl.timeline.state.length > 0, bTl.timeline.state);

    // 事件顺序: 真有一个 create→proof→release 的完整链时, 顺序必须对
    const chainLike = expected.map((e: any) => e.eventName);
    const hasFullLifecycle = chainLike.includes('EscrowCreatedV2') && chainLike.includes('ProofSubmittedV2') && chainLike.includes('ReleasedV2');
    if (hasFullLifecycle) {
      const order = ['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2'].map((n) => chainLike.indexOf(n));
      check('create → proof → release 顺序递增 (真生命周期)', order[0] < order[1] && order[1] < order[2], order.join('<'));
    } else {
      console.log(`  ⚠ 这条 taskKey 不是完整生命周期 (${chainLike.join(',')}) — 顺序断言改到全量里找一条完整链`);
      const complete = findCompleteLifecycle(full);
      if (complete) {
        const rC = await fetch(`${BASE}/api/chain/index/timeline?taskKey=${complete.key}`);
        const bC: any = await rC.json();
        const names = bC.timeline.events.map((e: any) => e.eventName);
        const o = ['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2'].map((n) => names.indexOf(n));
        check('create → proof → release 顺序递增 (真生命周期)', o[0] > -1 && o[0] < o[1] && o[1] < o[2], `${shortenedKey(complete.key)}: ${names.join(' → ')}`);
      } else {
        check('存在一条完整生命周期 (create→proof→release) 可验顺序', false, '索引里没有完整链');
      }
    }

    const unknownKey = '0x' + 'ab'.repeat(32);
    const rUnk = await fetch(`${BASE}/api/chain/index/timeline?taskKey=${unknownKey}`);
    const bUnk: any = await rUnk.json();
    check('GET timeline (未知但合法 taskKey) → 200 + 空时间线', rUnk.status === 200 && bUnk.timeline.count === 0 && bUnk.timeline.events.length === 0 && bUnk.timeline.state === null,
      `HTTP ${rUnk.status} · count=${bUnk.timeline.count} state=${bUnk.timeline.state}`);
    check('★ 未知 taskKey 没有被编造出来 (索引里确实没有)', !disk.entries.some((e: any) => keyOf(e) === unknownKey));
    check('未知 taskKey 的回显是它自己 (没被替换成别的)', String(bUnk.timeline.taskKey).toLowerCase() === unknownKey, bUnk.timeline.taskKey);

    const rBad = await fetch(`${BASE}/api/chain/index/timeline?taskKey=0xnothex`);
    check('非法 taskKey → 400 (拒而不是硬搜)', rBad.status === 400, `HTTP ${rBad.status}`);
    const rBadCursor = await fetch(`${BASE}/api/chain/index/events?blockNumber=-1&logIndex=0`);
    check('非法 cursor → 400', rBadCursor.status === 400, `HTTP ${rBadCursor.status}`);

    // ═══════════════════════════════════════════════════════════════════════
    section('⑤ 页面资源与前端纪律 (静态资源真拉一遍)');
    const rPage = await fetch(`${BASE}/explorer`);
    const html = await rPage.text();
    check('GET /explorer → 200 + text/html', rPage.status === 200 && String(rPage.headers.get('content-type')).includes('text/html'), `HTTP ${rPage.status} · ${rPage.headers.get('content-type')} · ${html.length} 字节`);
    const rChain = await fetch(`${BASE}/chain`);
    const htmlChain = await rChain.text();
    check('GET /chain (别名) → 200 同一页', rChain.status === 200 && htmlChain === html, `HTTP ${rChain.status} · 字节一致=${htmlChain === html}`);

    const hooks: Array<[string, string]> = [
      ['#chain-explorer-root', 'id="chain-explorer-root"'],
      ['#cx-state (aria-live)', 'id="cx-state"'],
      ['aria-live', 'aria-live="polite"'],
      ['#cx-height', 'id="cx-height"'],
      ['#cx-lastsync', 'id="cx-lastsync"'],
      ['#cx-entries', 'id="cx-entries"'],
      ['#cx-tasks', 'id="cx-tasks"'],
      ['#cx-released', 'id="cx-released"'],
      ['#cx-refunded', 'id="cx-refunded"'],
      ['#cx-disputed', 'id="cx-disputed"'],
      ['#cx-expired', 'id="cx-expired"'],
      ['#cx-final-observed', 'id="cx-final-observed"'],
      ['#cx-final-confirmed', 'id="cx-final-confirmed"'],
      ['#cx-final-finalized', 'id="cx-final-finalized"'],
      ['#cx-timeline-body', 'id="cx-timeline-body"'],
      ['#cx-more (加载更多)', 'id="cx-more"'],
      ['#cx-task-form', 'id="cx-task-form"'],
      ['#cx-degraded (降级态)', 'id="cx-degraded"'],
      ['无障碍: cx-reload', 'id="cx-reload"'],
    ];
    for (const [label, needle] of hooks) check(`HTML 钩子 ${label}`, html.includes(needle));
    check('HTML 含双语 data-zh/data-en', (html.match(/data-zh=/g) || []).length >= 15 && (html.match(/data-en=/g) || []).length >= 15,
      `data-zh=${(html.match(/data-zh=/g) || []).length} data-en=${(html.match(/data-en=/g) || []).length}`);
    check('HTML 含 prefers-reduced-motion 处理', html.includes('prefers-reduced-motion'));
    check('HTML 引用编译产物 /chain-explorer.js', html.includes('chain-explorer.js'));

    const rJs = await fetch(`${BASE}/chain-explorer.js`);
    const js = await rJs.text();
    check('GET /chain-explorer.js → 200 + javascript', rJs.status === 200 && /javascript/.test(String(rJs.headers.get('content-type'))), `HTTP ${rJs.status} · ${js.length} 字节`);
    const jsNeed: Array<[string, string]> = [
      ['textContent (活动文本不用 innerHTML)', 'textContent'],
      ['⚠ 无 innerHTML (硬红线)', 'innerHTML'],
      ['prefers-reduced-motion', 'prefers-reduced-motion'],
      ['aria-live 相关的状态更新', 'cx-state'],
      ['cursor 增量加载', 'nextCursor'],
      ['finality 三档字面量 observed', 'observed'],
      ['finality 三档字面量 confirmed', 'confirmed'],
      ['finality 三档字面量 finalized', 'finalized'],
      ['指数退避', 'backoffDelayMs'],
      ['请求超时 (AbortController)', 'AbortController'],
      ['轮询', 'POLL_INTERVAL_MS'],
      ['短写 0x… 省略号', '…'],
      ['降级态字面量', 'degraded'],
    ];
    for (const [label, needle] of jsNeed) {
      const hit = js.includes(needle);
      check(`JS ${label}`, needle === 'innerHTML' ? !hit : hit, hit ? '命中' : '未命中');
    }
    check('JS 里没有把完整地址塞进 DOM 属性的写法 (无 data-taskkey=完整值)', !/setAttribute\(\s*['"]data-taskkey['"]/.test(js));

    // ═══════════════════════════════════════════════════════════════════════
    section('⑥ 真 Chrome: 页面上读到的数字 == 路由数据; 真点「加载更多」; 真查未知 taskKey');
    if (NO_CHROME || !fs.existsSync(CHROME)) {
      check('真 Chrome 可用', false, NO_CHROME ? '--no-chrome' : `没找到 ${CHROME}`);
    } else {
      let browser: any = null;
      try {
        browser = await openChrome();
      } catch (e: any) {
        check('真 Chrome 启动 (CDP)', false, String(e?.message || e).slice(0, 160));
      }
      try {
        if (!browser) { /* 启动失败 → 上面已记失败, 不静默 */ } else {
        // ⑥-a 正常态
        await browser.goto(`${BASE}/explorer`);
        const ready = await browser.waitFor(`document.documentElement.dataset.cxReady === '1'`, 20000);
        check('页面加载完成 (data-cx-ready=1)', ready);
        const dom = await browser.evalJSON(`({
          status: document.documentElement.dataset.cxStatus,
          height: document.getElementById('cx-height').textContent.trim(),
          head: document.getElementById('cx-head').textContent.trim(),
          entries: document.getElementById('cx-entries').textContent.trim(),
          tasks: document.getElementById('cx-tasks').textContent.trim(),
          released: document.getElementById('cx-released').textContent.trim(),
          refunded: document.getElementById('cx-refunded').textContent.trim(),
          disputed: document.getElementById('cx-disputed').textContent.trim(),
          expired: document.getElementById('cx-expired').textContent.trim(),
          observed: document.getElementById('cx-final-observed').textContent.trim(),
          confirmed: document.getElementById('cx-final-confirmed').textContent.trim(),
          finalized: document.getElementById('cx-final-finalized').textContent.trim(),
          lastsync: document.getElementById('cx-lastsync').textContent.trim(),
          escrow: document.getElementById('cx-escrow').textContent.trim(),
          state: document.getElementById('cx-state').textContent.trim(),
          rows: document.querySelectorAll('#cx-timeline-body .cx-row').length,
          moreLabel: document.getElementById('cx-more').textContent.trim(),
          moreDisabled: document.getElementById('cx-more').disabled,
          firstRow: (document.querySelector('#cx-timeline-body .cx-row') || {}).textContent || '',
        })`);
        console.log(`  页面读到          : height=${dom.height} entries=${dom.entries} tasks=${dom.tasks} released=${dom.released} expired=${dom.expired}`);
        console.log(`  finality 页面读到 : observed=${dom.observed} confirmed=${dom.confirmed} finalized=${dom.finalized}`);
        console.log(`  首行文本          : ${String(dom.firstRow).replace(/\s+/g, ' ').slice(0, 200)}`);
        check('页面状态 = live (未降级)', dom.status === 'live', dom.status);
        check('★ 页面索引高度 == 路由 status.lastSyncedBlock', dom.height === String(bStatus.status.lastSyncedBlock), `${dom.height} == ${bStatus.status.lastSyncedBlock}`);
        check('★ 页面 head == 路由 head', dom.head === String(bStatus.status.headBlock), `${dom.head} == ${bStatus.status.headBlock}`);
        check('★ 页面事件总数 == 路由 stats.entries', dom.entries === String(bStats.stats.entries), `${dom.entries} == ${bStats.stats.entries}`);
        check('★ 页面 tasks == 路由 stats.tasks', dom.tasks === String(bStats.stats.tasks), `${dom.tasks} == ${bStats.stats.tasks}`);
        check('★ 页面 released == 路由 stats.released', dom.released === String(bStats.stats.released), `${dom.released} == ${bStats.stats.released}`);
        check('★ 页面 refunded/disputed/expired == 路由', dom.refunded === String(bStats.stats.refunded) && dom.disputed === String(bStats.stats.disputed) && dom.expired === String(bStats.stats.expired),
          `${dom.refunded}/${dom.disputed}/${dom.expired} == ${bStats.stats.refunded}/${bStats.stats.disputed}/${bStats.stats.expired}`);
        check('★ 页面 finality 三档 == 路由 byFinality',
          dom.observed === String(bStats.stats.byFinality.observed) && dom.confirmed === String(bStats.stats.byFinality.confirmed) && dom.finalized === String(bStats.stats.byFinality.finalized),
          `${dom.observed}/${dom.confirmed}/${dom.finalized} == ${bStats.stats.byFinality.observed}/${bStats.stats.byFinality.confirmed}/${bStats.stats.byFinality.finalized}`);
        check('★ 最后同步时间是真时间 (非 "—")', dom.lastsync !== '—' && /前|ago/.test(dom.lastsync), dom.lastsync);
        check('★ escrow 地址在页面上是短写 (0x… 带省略号, 非完整 40hex)', /^0x[0-9a-f]{4}…[0-9a-f]{4}$/i.test(dom.escrow), dom.escrow);
        check('首屏只拉一页 (行数 == limit 25 或全量)', dom.rows === Math.min(25, full.length), `${dom.rows} 行`);
        check('「加载更多」可用 (hasMore)', dom.moreDisabled === false && /加载更多|load more/.test(dom.moreLabel), dom.moreLabel);

        // ⑥-b 真点「加载更多」: 行数增加, 且不重复
        const beforeClick = await browser.evalJSON(`Array.from(document.querySelectorAll('#cx-timeline-body .cx-row')).map((r) => r.textContent.replace(/\\s+/g,' ').trim())`);
        await browser.evalJS(`document.getElementById('cx-more').click(); 1`);
        const grew = await browser.waitFor(`document.querySelectorAll('#cx-timeline-body .cx-row').length > ${dom.rows}`, 8000);
        const after = await browser.evalJSON(`({
          n: document.querySelectorAll('#cx-timeline-body .cx-row').length,
          texts: Array.from(document.querySelectorAll('#cx-timeline-body .cx-row')).map((r) => r.textContent.replace(/\\s+/g,' ').trim()),
        })`);
        check('★ 真点「加载更多」后行数增加 (cursor 增量加载)', grew && after.n > dom.rows, `${beforeClick.length} → ${after.n} 行`);
        check('★ 首屏那几行在追加后逐字未变 (不是整页重拉)', j(after.texts.slice(0, beforeClick.length)) === j(beforeClick), `${beforeClick.length} 行原样`);
        check('★ 页面新增的行 == 路由全量里对应的那几行 (含块号:logIndex)',
          after.texts.slice(dom.rows).every((t: string, i: number) => t.includes(`#${full[dom.rows + i].blockNumber}:${full[dom.rows + i].logIndex}`)),
          `${after.n - dom.rows} 行新增 · 例: ${String(after.texts[dom.rows] || '').slice(0, 100)}`);
        const idxAttr = await browser.evalJSON(`Array.from(document.querySelectorAll('#cx-timeline-body .cx-row')).map((r) => Number(r.getAttribute('data-idx')))`);
        check('★ DOM 里没有重复行 (data-idx 唯一)', new Set(idxAttr).size === idxAttr.length && idxAttr.length === after.n, `${new Set(idxAttr).size}/${idxAttr.length}`);

        // ⑥-c 点某一行的「看时间线」→ 单 escrow 时间线
        await browser.evalJS(`Array.from(document.querySelectorAll('#cx-timeline-body .cx-row button.cx-link')).find((b) => !b.disabled).click(); 1`);
        const taskLoaded = await browser.waitFor(`document.querySelectorAll('#cx-task-body .cx-row').length > 0`, 8000);
        const taskDom = await browser.evalJSON(`({
          rows: document.querySelectorAll('#cx-task-body .cx-row').length,
          title: document.getElementById('cx-task-title').textContent.trim(),
          first: (document.querySelector('#cx-task-body .cx-row') || {}).textContent || '',
        })`);
        const clickedKey = keyOf(full[0]);
        const expectedRows = disk.entries.filter((e: any) => keyOf(e) === clickedKey).length;
        check('★ 点行 → 该 escrow 时间线真加载', taskLoaded && taskDom.rows === expectedRows, `${taskDom.rows} 行 (索引里该 taskKey ${expectedRows} 条)`);
        check('★ 时间线标题是短写 taskKey + 状态', /^0x[0-9a-f]{4}…[0-9a-f]{4}/i.test(taskDom.title), taskDom.title);
        check('时间线首行: 块号:logIndex + 事件名 + finality 档位',
          /#\d+:\d+/.test(taskDom.first) && /(EscrowCreatedV2|ProofSubmittedV2|ReleasedV2|RefundedV2|DisputedV2|ExpiredV2)/.test(taskDom.first)
            && /(观测中|已确认|已最终|observed|confirmed|finalized)/.test(taskDom.first),
          String(taskDom.first).replace(/\s+/g, ' ').slice(0, 160));
        const taskRowMeta = await browser.evalJSON(`Array.from(document.querySelectorAll('#cx-task-body .cx-row')).map((r) => r.getAttribute('data-finality'))`);
        check('时间线每行都带 data-finality ∈ 三档', taskRowMeta.length > 0 && taskRowMeta.every((f: string) => ['observed', 'confirmed', 'finalized'].includes(f)), j(taskRowMeta));

        // ⑥-d 真提交一个未知 taskKey → 显式空态
        await browser.evalJS(`(() => { const i = document.getElementById('cx-task-input'); i.value = '${unknownKey}'; document.getElementById('cx-task-form').requestSubmit(); return 1; })()`);
        const gotEmpty = await browser.waitFor(`!!document.getElementById('cx-task-empty')`, 8000);
        const emptyText = await browser.evalJS(`(document.getElementById('cx-task-empty') || {}).textContent || ''`);
        const inputCleared = await browser.evalJS(`document.getElementById('cx-task-input').value`);
        check('★ 未知 taskKey → 显式空态文案 (不是编造的行)', gotEmpty && /从未出现|never seen|没有/.test(String(emptyText)), String(emptyText).slice(0, 140));
        check('未知 taskKey 后时间线区 0 行 (没有假数据)', (await browser.evalJS(`document.querySelectorAll('#cx-task-body .cx-row').length`)) === 0);
        check('输入框里的完整 taskKey 用完即清 (页面不留完整值)', String(inputCleared) === '', `"${inputCleared}"`);

        // ⑥-e 隐私: 整页可见文本不得出现完整地址/哈希/DID/IP
        const bodyText = await browser.evalJS(`document.body.innerText`);
        const leaks = {
          addr40: (String(bodyText).match(/0x[0-9a-fA-F]{40}/g) || []).length,
          hash64: (String(bodyText).match(/0x[0-9a-fA-F]{64}/g) || []).length,
          did: (String(bodyText).match(/did:[a-z]+:/g) || []).length,
          ipv4: (String(bodyText).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []).length,
        };
        check('★ 整页可见文本无完整钱包地址 (0x+40hex)', leaks.addr40 === 0, j(leaks));
        check('★ 整页可见文本无完整哈希 (0x+64hex: txHash/taskKey) ', leaks.hash64 === 0, `泄露 ${leaks.hash64} 处`);
        check('★ 无 DID / 无 IPv4 (peerId/IP 不外泄)', leaks.did === 0 && leaks.ipv4 === 0, j(leaks));
        check('页面里有短写 (0x… 省略号) 说明确实显示的是短写', /0x[0-9a-f]{4}…[0-9a-f]{4}/i.test(String(bodyText)));
        check('无 console 报错 / 未捕获异常', browser.errors.length === 0, browser.errors.slice(0, 3));

        // ⑥-f 降级: 指向死端口
        await browser.goto(`${BASE}/explorer?apiBase=http://127.0.0.1:9`);
        const degReady = await browser.waitFor(`document.documentElement.dataset.cxReady === '1'`, 20000);
        const deg = await browser.evalJSON(`({
          status: document.documentElement.dataset.cxStatus,
          degradedVisible: getComputedStyle(document.getElementById('cx-degraded')).display !== 'none',
          reason: document.getElementById('cx-degraded-reason').textContent.trim(),
          height: document.getElementById('cx-height').textContent.trim(),
          entries: document.getElementById('cx-entries').textContent.trim(),
          tasks: document.getElementById('cx-tasks').textContent.trim(),
          released: document.getElementById('cx-released').textContent.trim(),
          rows: document.querySelectorAll('#cx-timeline-body .cx-row').length,
          timelineText: document.getElementById('cx-timeline-body').textContent.trim(),
        })`);
        check('★ 后端不可用 → 页面进降级态', degReady && deg.status === 'degraded', `data-cx-status=${deg.status}`);
        check('★ 降级横幅可见 + 写明原因', deg.degradedVisible && deg.reason.length > 0, deg.reason.slice(0, 120));
        check('★ 降级时数字全是 "—" (不拿 0 顶替假数据)', [deg.height, deg.entries, deg.tasks, deg.released].every((v: string) => v === '—'), `${deg.height}/${deg.entries}/${deg.tasks}/${deg.released}`);
        check('★ 降级时时间线 0 行 + 明确说明', deg.rows === 0 && /降级|backend unavailable/.test(deg.timelineText), String(deg.timelineText).slice(0, 120));

        // ⑥-g 三档都要真出现: 抬高门槛 (confirmed=500) → 同一批真事件全落 observed 档,
        //      路由与页面必须**跟着门槛变** (证明三档是算出来的, 不是前端写死的三个数字)
        const idxHigh = new ChainIndexer({
          provider, escrowAddress: escrowAddr, chainId: 31337, networkName: 'localhost',
          deploymentBlock: info.deploymentBlock, deploymentSource: info.source, home: HOME, pageSize: 2000,
          confirmations: { confirmed: 500, finalized: 1000 },
        });
        await idxHigh.syncFrom();
        const rHigh = await fetch(`${BASE}/api/chain/index/stats`);
        const bHigh: any = await rHigh.json();
        console.log(`  抬高门槛 (confirmed=500): byFinality = ${j(bHigh.stats.byFinality)}`);
        check('★ 门槛=500 时: 原本 finalized 的全降级 (finalized=0, 且 observed 非空)',
          bHigh.stats.byFinality.finalized === 0
            && bHigh.stats.byFinality.observed + bHigh.stats.byFinality.confirmed === bHigh.stats.entries
            && bHigh.stats.byFinality.observed > 0,
          j(bHigh.stats.byFinality));
        await browser.goto(`${BASE}/explorer`);
        await browser.waitFor(`document.documentElement.dataset.cxReady === '1'`, 20000);
        const domHigh = await browser.evalJSON(`({
          o: document.getElementById('cx-final-observed').textContent.trim(),
          c: document.getElementById('cx-final-confirmed').textContent.trim(),
          f: document.getElementById('cx-final-finalized').textContent.trim(),
        })`);
        check('★ 页面三档 == 抬高门槛后的真值 (页面读的是索引, 不是硬编码)',
          domHigh.o === String(bHigh.stats.byFinality.observed) && domHigh.c === String(bHigh.stats.byFinality.confirmed) && domHigh.f === String(bHigh.stats.byFinality.finalized),
          `页面 ${domHigh.o}/${domHigh.c}/${domHigh.f} · 路由 ${bHigh.stats.byFinality.observed}/${bHigh.stats.byFinality.confirmed}/${bHigh.stats.byFinality.finalized}`);
        check('★ 门槛一改页面数字就跟着变 (同一页第二次读, 不是缓存/写死的)',
          domHigh.f !== dom.finalized && domHigh.o !== dom.observed,
          `改前 ${dom.observed}/${dom.confirmed}/${dom.finalized} → 改后 ${domHigh.o}/${domHigh.c}/${domHigh.f}`);
        await idx.syncFrom(); // 还原默认门槛 (1/12)
        const rBack = await fetch(`${BASE}/api/chain/index/stats`);
        const bBack: any = await rBack.json();
        check('★ 还原默认门槛后 finality 回到 finalized/confirmed (索引没被写坏)',
          bBack.stats.byFinality.finalized + bBack.stats.byFinality.confirmed === bBack.stats.entries,
          j(bBack.stats.byFinality));
        }
      } catch (e: any) {
        check('Chrome 段的断言没有异常中断', false, String(e?.message || e).slice(0, 200));
      } finally {
        try { await browser?.close?.(); } catch { /* noop */ }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    section('⑦ 后端不可用: 路由层与数据层的降级语义 (不抛假数据)');
    const deadBase = 'http://127.0.0.1:9';
    const snapDead = await CX.fetchSnapshot(deadBase);
    check('★ fetchSnapshot(死端口) → degraded', snapDead.status === 'degraded', snapDead.status);
    check('★ 降级快照里 indexStatus/stats 都是 null (没有假对象)', snapDead.indexStatus === null && snapDead.stats === null);
    check('降级快照带可读原因', typeof snapDead.error === 'string' && snapDead.error.length > 0, snapDead.error);
    let threw = false;
    try { await CX.fetchPage(deadBase, null, { limit: 3 }); } catch { threw = true; }
    check('fetchPage(死端口) 抛出 (而不是返回空页假装没数据)', threw);
    const snapTimeout = await CX.fetchSnapshot('http://10.255.255.1:9', { timeoutMs: 300 });
    check('请求超时 → degraded (AbortController 真的生效)', snapTimeout.status === 'degraded', String(snapTimeout.error).slice(0, 80));
    const rLive = await fetch(`${BASE}/api/health`);
    check('降级场景不影响 server 其它接口 (/api/health 仍 200)', rLive.status === 200, `HTTP ${rLive.status}`);

    // ═══════════════════════════════════════════════════════════════════════
    section('⑧ 纯函数 (页面与验收脚本共用同一份逻辑)');
    const SAMPLE: any = { blockNumber: 123, logIndex: 4, blockHash: '0x' + 'aa'.repeat(32), txHash: '0x' + 'bb'.repeat(32), eventName: 'ReleasedV2', confirmations: 13, finality: 'finalized', suspect: false, args: { taskKey: '0x' + 'cc'.repeat(32), amount: '10000000', to: '0x' + 'dd'.repeat(20) } };
    check('shortHex(地址) == 0xdddd…dddd 形式', CX.shortHex(SAMPLE.args.to) === '0xdddd…dddd', CX.shortHex(SAMPLE.args.to));
    check('shortHex(哈希) 短写且不含完整值', CX.shortHex(SAMPLE.txHash).length <= 12 && !CX.isFullHash(CX.shortHex(SAMPLE.txHash)), CX.shortHex(SAMPLE.txHash));
    check('renderEntryText 行里没有完整地址/哈希', !/0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}/.test(CX.renderEntryText(SAMPLE)), CX.renderEntryText(SAMPLE));
    check('backoffDelayMs 指数递增且封顶 30s', [0, 1, 2, 3, 10].map((n: number) => CX.backoffDelayMs(n)).join(',') === '1000,2000,4000,8000,30000', [0, 1, 2, 3, 10].map((n: number) => CX.backoffDelayMs(n)).join(','));
    check('mergeEntries 去重 (同 cursor 只留一条)', CX.mergeEntries([SAMPLE], [SAMPLE]).length === 1);
    check('mergeEntries 排序 (块号+logIndex)', j(CX.sortEntries([{ ...SAMPLE, blockNumber: 9 }, { ...SAMPLE, blockNumber: 3 }]).map((e: any) => e.blockNumber)) === j([3, 9]));
    check('finalityOf 只认三档 (别的值 → unknown, 不硬塞)', CX.finalityOf({ finality: 'weird' }) === 'unknown' && CX.finalityOf({ finality: 'observed' }) === 'observed');
    check('eventTone 分类与 stats 分类一致', CX.eventTone('EscrowCreatedV2') === 'created' && CX.eventTone('ExpiredV2') === 'expired' && CX.eventTone('RefundedV2') === 'refunded' && CX.eventTone('DisputedV2') === 'disputed');
    check('num(null) == "—" (缺值不当 0)', CX.num(null) === '—' && CX.num(0) === '0');
    check('空态文案明说"查不到"而不是"状态未知"', /从未出现|no events/.test(CX.emptyTimelineText('0x1234…abcd', 'zh')) && /从未出现|no events/.test(CX.emptyTimelineText('0x1234…abcd', 'en')));
  } finally {
    try { serverChild.kill('SIGKILL'); } catch { /* noop */ }
    await sleep(300);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('⑨ 结果');
  console.log(`  索引             : ${INDEX_FILE}`);
  console.log(`  事件             : ${disk.entries.length} 条 / ${getIndexStats({ home: HOME }).tasks} 个 taskKey (chainId ${getIndexStatus({ home: HOME }).chainId})`);
  console.log(`  新造 observed 事件: ${freshNote}`);
  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed) { console.log('  ❌ 失败项:'); failures.forEach((f) => console.log(`     - ${f}`)); }
  else console.log(`  ✅ 全部断言通过 (${passed}/${passed + failed})`);
  if (!USE_REAL_HOME) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } }
  process.exit(failed ? 1 : 0);
}

function shortenedKey(k: string) { return `${k.slice(0, 6)}…${k.slice(-4)}`; }

/** 从全量事件里找一条 create→proof→release 完整链 (打印用) */
function findCompleteLifecycle(entries: any[]): { key: string } | null {
  const byKey = new Map<string, string[]>();
  for (const e of entries) {
    const k = keyOf(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e.eventName);
  }
  for (const [key, names] of byKey) {
    if (['EscrowCreatedV2', 'ProofSubmittedV2', 'ReleasedV2'].every((n) => names.includes(n))) return { key };
  }
  return null;
}

// ── 真 Chrome (CDP) 最小驱动 ────────────────────────────────────────────────
async function openChrome() {
  const PORT = 9333 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-chrome-'));
  console.log(`  chrome            : 启动 (headless=new, CDP :${PORT})`);
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-allow-origins=*',
    '--window-size=1280,1000', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, HOME: REAL_HOME_FOR_BROWSER },
  });
  let wsUrl = '';
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list: any = await r.json();
      const page = list.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!wsUrl) { try { child.kill('SIGKILL'); } catch { /* noop */ } throw new Error('Chrome CDP 没起来 (18s 内没有 page target)'); }
  console.log(`  chrome            : CDP 就绪 ${wsUrl.replace(/^ws:\/\/[^/]+/, 'ws://127.0.0.1')}`);
  const ws = new WebSocket(wsUrl);
  const opened = await new Promise<string>((res) => {
    const t = setTimeout(() => res('TIMEOUT'), 8000);
    (ws as any).onopen = () => { clearTimeout(t); res('OPEN'); };
    (ws as any).onerror = (e: any) => { clearTimeout(t); res(`ERROR ${String(e?.message || e)}`); };
  });
  if (opened !== 'OPEN') {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    throw new Error(`Chrome CDP WebSocket 没打开 (${opened})`);
  }
  const pending = new Map<number, (v: any) => void>();
  let msgId = 0;
  const errors: string[] = [];
  (ws as any).onmessage = (ev: any) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(`[console] ${(m.params.args || []).map((a: any) => a.value || a.type).join(' ')}`.slice(0, 160));
    if (m.method === 'Runtime.exceptionThrown') errors.push(`[exception] ${String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text).slice(0, 160)}`);
  };
  // 每个 CDP 调用都带超时 —— 浏览器卡住不能让验收挂死
  const cdp = (method: string, params: any = {}) => new Promise<any>((res, rej) => {
    const i = ++msgId;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} 超时`)); }, 15000);
    pending.set(i, (v: any) => { clearTimeout(timer); res(v); });
    (ws as any).send(JSON.stringify({ id: i, method, params }));
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  const evalJS = async (expr: string): Promise<any> => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(`页面异常: ${j(r.result.exceptionDetails).slice(0, 200)}`);
    return r?.result?.result?.value;
  };
  return {
    errors,
    evalJS,
    evalJSON: evalJS,
    async goto(url: string) { await cdp('Page.navigate', { url }); await sleep(600); },
    async waitFor(expr: string, ms: number) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await evalJS(`!!(${expr})`)) return true; } catch { /* 页面还在切 */ }
        await sleep(250);
      }
      return false;
    },
    async close() { try { (ws as any).close(); } catch { /* noop */ } try { child.kill('SIGKILL'); } catch { /* noop */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ } },
  };
}

await main();
