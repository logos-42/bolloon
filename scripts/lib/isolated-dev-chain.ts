/**
 * isolated-dev-chain.ts — 验收脚本专用的**一次性私有开发链** (fork 自本地 dev 链)
 *
 * 为什么需要它 (这是「不能有会撒谎的门」的一部分):
 *   共享 anvil 上别的进程也在发交易 → 它们也在出块 → 确认数会自己涨。
 *   任何依赖「此刻确认数恰好是多少」的断言, 在忙链上都会偶发假失败
 *   (2026-09-22: verify-chain-bridge 的「对账后仍然成立的那条保持已确认」就是这么红的:
 *    那条记录的确认数在忙链上早就 ≥12 → 写成 finalized → 默认 skipFinalized 跳过了它 → 报告里什么都没有)。
 *
 * 本模块的做法: 起一条**只属于本次验收的 anvil**, fork 上游开发链的状态:
 *   · 独立进程 + 独立端口 (随机空闲端口), 别人出的块影响不到这里;
 *   · 对上游**只读** (只 fork 一个块高, 不写它、不回滚它、不动它的账户);
 *   · 合约地址 / 部署块 / 历史 receipt 全都能通过 fork 读到 (与 deployments manifest 一致,
 *     所以 manifest 里那笔真实 status=0 的交易照样能当证据用);
 *   · 只有本脚本发的交易才出块 → 确认数可预测; `evm_snapshot`/`evm_revert` 也只影响自己;
 *   · 结束即关 (kill), 不留孤儿进程、不动上游一个字节。
 *
 * 为什么用 fork 而不是 `anvil_dumpState` + `--load-state` 快照整条链:
 *   dumpState 的大小与整条链的历史成正比 (677 块 ≈ 5MB; 上游涨到几十万块时直接 >2GB →
 *   node 字符串上限 / OOM)。fork 只取当前状态, 成本恒定, 上游再大也不怕。
 *
 * 注意: chainId 刻意保持上游的 31337 —— 判定层要求「非 31337 一律拒绝用开发助记符签名」,
 *   隔离靠的是**独立进程/端口 + 自己的出块**, 不是靠换 chainId。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { JsonRpcProvider } from 'ethers';

export interface IsolatedDevChain {
  /** 只属于这条私有链的 RPC 地址 */
  rpcUrl: string;
  port: number;
  chainId: number;
  /** fork 起点块高 (上游 fork 那一刻的 head) */
  forkedAtBlock: number;
  accounts: number;
  /** 上游 RPC (只被 fork 读过) */
  upstreamRpc: string;
  /** anvil 输出的尾部 (排错用) */
  output(): string;
  /** 关链 (kill 子进程) */
  stop(): void;
}

export interface StartIsolatedDevChainOptions {
  /** fork 来源 RPC (缺省 http://127.0.0.1:8545) */
  upstreamRpc?: string;
  /** 链 id (缺省 31337) */
  chainId?: number;
  /** 开发账户数量 (缺省 10, 与上游一致) */
  accounts?: number;
  /** anvil 可执行文件 (缺省 env ANVIL_BIN → ~/.foundry/bin/anvil) */
  anvilBin?: string;
  /** 就绪等待上限 (缺省 30s) */
  readyTimeoutMs?: number;
}

/** 已经起过、还没关掉的私有链 (进程退出时兜底收尸, 不留孤儿 anvil) */
const LIVE = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of LIVE) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    LIVE.clear();
  });
}

function defaultAnvilBin(): string {
  return process.env.ANVIL_BIN || path.join(os.homedir(), '.foundry', 'bin', 'anvil');
}

/** 找一个空闲端口 (让内核给一个, 立刻释放; 只在 127.0.0.1 上) */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))));
    });
  });
}

/**
 * 起一条隔离开发链 (fork 上游状态)。失败会抛错, 错误里带 anvil 输出尾部。
 * ★ 对上游**只读**: 不写状态、不回滚、不动账户。
 */
export async function startIsolatedDevChain(opts: StartIsolatedDevChainOptions = {}): Promise<IsolatedDevChain> {
  const upstreamRpc = opts.upstreamRpc || 'http://127.0.0.1:8545';
  const chainId = opts.chainId ?? 31337;
  const accounts = opts.accounts ?? 10;
  const anvilBin = opts.anvilBin || defaultAnvilBin();
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  if (!fs.existsSync(anvilBin)) {
    throw new Error(`找不到 anvil: ${anvilBin} (可用 ANVIL_BIN 指定; macOS 上通常要 DYLD_LIBRARY_PATH=~/.local/lib)`);
  }

  // 先确认上游可达 (fork 源不通就没必要起)
  const upProbe = new JsonRpcProvider(upstreamRpc, undefined, { cacheTimeout: -1 });
  let forkedAtBlock = 0;
  try {
    forkedAtBlock = await Promise.race([
      upProbe.getBlockNumber(),
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error(`上游 ${upstreamRpc} 8s 没响应`)), 8000)),
    ]);
  } catch (e: any) {
    try { (upProbe as any).destroy?.(); } catch { /* noop */ }
    throw new Error(`上游 dev 链不可用 (${upstreamRpc}): ${String(e?.message || e).slice(0, 200)}`);
  }
  try { (upProbe as any).destroy?.(); } catch { /* noop */ }

  // macOS 上 foundry 的 anvil 动态链到 libusb (常在 /usr/local/opt/libusb 或 ~/.local/lib)
  // → 子进程要能找得到。调用方没设 DYLD_LIBRARY_PATH 时就补上本机常见目录 (存在才补)。
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!childEnv.DYLD_LIBRARY_PATH) {
    const fallback = path.join(os.homedir(), '.local', 'lib');
    if (fs.existsSync(fallback)) childEnv.DYLD_LIBRARY_PATH = fallback;
  }

  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const child = spawn(anvilBin, [
      '--fork-url', upstreamRpc,
      '--port', String(port),
      '--host', '127.0.0.1',
      '--chain-id', String(chainId),
      '--accounts', String(accounts),
    ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    installExitHook();
    LIVE.add(child);
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    let exited = false;
    let exitInfo = '';
    child.on('exit', (code, signal) => { exited = true; exitInfo = `exit=${code} signal=${signal}`; });

    const stop = () => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      LIVE.delete(child);
    };

    // 就绪探测: RPC 通 + chainId 对 + 能报块高。
    // ★ 单次探测必须带超时: provider 在节点没起来时会自己重试网络探测, 会把循环挂死。
    const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    let dead = false;
    let head: number | null = null;
    while (Date.now() < deadline) {
      if (exited) { dead = true; break; }
      try {
        const [net2, headNow] = await Promise.race([
          Promise.all([provider.getNetwork(), provider.getBlockNumber()]),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 1500)),
        ]) as [any, number];
        if (Number(net2.chainId) === chainId) { ready = true; head = Number(headNow); break; }
      } catch { /* 还没起来 / 单次探测超时 */ }
      if (exited) { dead = true; break; }
      await new Promise((r) => setTimeout(r, 120));
    }
    try { (provider as any).destroy?.(); } catch { /* noop */ }

    if (ready) {
      return {
        rpcUrl, port, chainId, forkedAtBlock: head ?? forkedAtBlock, accounts, upstreamRpc,
        output: () => out,
        stop,
      };
    }
    stop(); // 这一轮没起来 → 收尸并换端口重试
    const tail = out.trim().split('\n').slice(-6).join(' | ') || '(空)';
    const dyldHint = /Library not loaded|dyld/i.test(out)
      ? ' (macOS 上 anvil 缺动态库: 需要 DYLD_LIBRARY_PATH=~/.local/lib 或装 libusb; 本函数已自动补 ~/.local/lib)'
      : '';
    lastErr = new Error(
      `隔离链没能在 ${readyTimeoutMs}ms 内就绪 (端口 ${port}, ${dead ? `${exitInfo} 进程已退出` : '进程还在但 RPC 不通'})` +
      `/ anvil 输出尾部: ${tail}${dyldHint}`,
    );
    if (dead && dyldHint) break; // 动态库类错误重试也没用
  }
  throw lastErr ?? new Error('隔离链启动失败');
}
