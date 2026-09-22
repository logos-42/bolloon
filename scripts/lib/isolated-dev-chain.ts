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
 *
 * ── macOS 上「anvil 起不来」的真因 (2026-09-22 修) ────────────────────────────
 *   foundry 的 anvil 在 macOS 上动态链到 libusb (`otool -L` 里写死
 *   `/usr/local/opt/libusb/lib/libusb-1.0.0.dylib`)。这个库不在 → dyld 直接
 *   `Library not loaded` → anvil 收到 SIGABRT → 原实现只会报「隔离链没能在 30000ms
 *   内就绪」, **把动态库问题伪装成超时**。
 *   原实现的两个错:
 *     (a) 只在 `!process.env.DYLD_LIBRARY_PATH` 时补一个目录, 而且用 `os.homedir()`
 *         (`= $HOME`) 拼 `~/.local/lib` —— 用干净 HOME (CI / 验收 / 临时 HOME) 跑时
 *         它指向空目录 → 补了个寂寞。**"用户 HOME 下刚好有 libusb" 不能是运行前提。**
 *     (b) 子进程环境变量整份继承 process.env —— 起不起得来取决于外层 shell 恰好设了什么。
 *   现在: `otool -L` 认缺哪些库 → 按顺序探测真实候选目录 (账号真实 HOME 的
 *   `~/.local/lib` 优先, 再 `/usr/local/lib`、`/opt/homebrew/lib`、libusb 的 opt 前缀,
 *   并沿用 env 里已有的值) → 命中才拼 `DYLD_LIBRARY_PATH` → 一个都找不到就**立刻**
 *   抛人话 (怎么装 / 怎么指), 不浪费 30s 重试; 子进程 env 走显式白名单。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
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
  /** anvil 可执行文件 (缺省 env ANVIL_BIN → 探测 ~/.foundry/bin/anvil) */
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

/**
 * 账号**真实** HOME —— 不看 `$HOME`。
 * `os.userInfo().homedir` 来自 getpwuid: 干净/临时 HOME 下它仍指向真账号目录,
 * 所以"真账号 HOME 里装的 dylib"照样能被找到 (这是本模块不再依赖 $HOME 的关键)。
 */
export function realUserHome(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch { /* 无 passwd 的受限环境 → 退化 */ }
  return env.HOME || os.homedir();
}

/** anvil 可执行文件: ANVIL_BIN → 真实账号 HOME 的 ~/.foundry/bin/anvil → $HOME 的 */
export function defaultAnvilBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANVIL_BIN) return env.ANVIL_BIN;
  const candidates = [
    path.join(realUserHome(env), '.foundry', 'bin', 'anvil'),
    path.join(env.HOME || os.homedir(), '.foundry', 'bin', 'anvil'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

// ── macOS 动态库定位 (anvil 需要 libusb) ─────────────────────────────────────

/** anvil 在 macOS 上会链到的第三方库名 (otool 用不了时的兜底探测名单) */
export const MACOS_DYLIB_NAMES: readonly string[] = Object.freeze(['libusb-1.0.0.dylib']);

/** 分 `:` 的路径列表 (去空/去重) */
function splitPathList(v: unknown): string[] {
  return [...new Set(String(v || '').split(':').map((s) => s.trim()).filter(Boolean))];
}

/**
 * 按**优先级顺序**给出候选库目录 (只给候选, 命中与否由上面一层判)。
 *   ① 账号真实 HOME 的 ~/.local/lib   ← 不能被 $HOME 影响
 *   ② $HOME 的 ~/.local/lib           (临时 HOME 里也装了库的情况)
 *   ③ /usr/local/lib · /opt/homebrew/lib (brew 的默认 lib 目录, Intel / Apple Silicon)
 *   ④ /usr/local/opt/libusb/lib · /opt/homebrew/opt/libusb/lib (brew formula 的 opt 前缀)
 *   ⑤ env DYLD_LIBRARY_PATH / DYLD_FALLBACK_LIBRARY_PATH 里**已有的值**
 */
export function dylibCandidateDirs(env: NodeJS.ProcessEnv = process.env, userHome?: string): string[] {
  const out: string[] = [];
  const push = (d?: string | null) => { const t = d && String(d).trim(); if (t && !out.includes(t)) out.push(t); };
  const uh = userHome || realUserHome(env);
  if (uh) push(path.join(uh, '.local', 'lib'));
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(uh)) push(path.join(env.HOME, '.local', 'lib'));
  push('/usr/local/lib');
  push('/opt/homebrew/lib');
  push('/usr/local/opt/libusb/lib');
  push('/opt/homebrew/opt/libusb/lib');
  for (const d of splitPathList(env.DYLD_LIBRARY_PATH)) push(d);
  for (const d of splitPathList(env.DYLD_FALLBACK_LIBRARY_PATH)) push(d);
  return out;
}

/** `otool -L <bin>` (拿不到 → null: 非 macOS / 没装 CLI 工具) */
export function runOtool(bin: string): string | null {
  try {
    const r = spawnSync('/usr/bin/otool', ['-L', bin], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  } catch {
    return null;
  }
}

/**
 * 从 `otool -L` 输出里挑出**本机不存在的非系统**动态库 (绝对路径)。
 * 系统自带的 (/usr/lib、/System) 与 @rpath/@loader_path 一律不管 —— 那些不归 DYLD_LIBRARY_PATH 管。
 */
export function missingDylibsFromOtool(
  _bin: string,
  output: string,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  const out: string[] = [];
  for (const line of String(output || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('/')) continue;                                        // 首行 "bin:" 与 @rpath 跳过
    if (t.startsWith('/usr/lib/') || t.startsWith('/System/')) continue;     // 系统自带
    const p = t.split(' (')[0].trim();
    if (!/\.(dylib|so)$/.test(p)) continue;
    if (!exists(p)) out.push(p);
  }
  return [...new Set(out)];
}

export interface DylibProbeOptions {
  anvilBin?: string;
  env?: NodeJS.ProcessEnv;
  /** 账号真实 HOME (测试注入; 缺省 os.userInfo().homedir) */
  userHome?: string;
  /** 文件存在性检查 (测试注入假 FS) */
  exists?: (p: string) => boolean;
  /** otool 输出注入; `null` = 用不了 (非 macOS / 没装); 不传 = 真跑 otool */
  otool?: ((bin: string) => string | null) | null;
}

export interface DylibProbeResult {
  anvilBin: string;
  /** otool 认出的、本机缺失的非系统动态库 (绝对路径) */
  missing: string[];
  /** 需要被补上的库文件名 */
  neededNames: string[];
  /** 探测过的候选目录 (按优先级; 报错里会列出来) */
  probed: string[];
  /** 候选里**真存在且提供了所需库**的目录 (按优先级) */
  dirs: string[];
  /** 最终要传给 anvil 的 DYLD_LIBRARY_PATH (null = 不需要/没有) */
  dyldLibraryPath: string | null;
  /** 修不了时的**可操作**报错 (null = 没问题) */
  error: string | null;
}

/**
 * 探测 anvil 在 macOS 上需要的动态库, 并算出该传给它的 DYLD_LIBRARY_PATH。
 * 纯函数式 (除默认的 otool/exists 外无副作用) —— 单测可注入假 FS 与假 otool 输出。
 */
export function probeMacosDylibs(opts: DylibProbeOptions = {}): DylibProbeResult {
  const env = opts.env || process.env;
  const anvilBin = opts.anvilBin || defaultAnvilBin(env);
  const exists = opts.exists || fs.existsSync;
  const userHome = opts.userHome || realUserHome(env);
  const otoolFn = opts.otool === undefined ? runOtool : opts.otool;

  const otoolOut = otoolFn ? otoolFn(anvilBin) : null;
  let missing: string[] = [];
  let neededNames: string[] = [];
  /** 知道**确切**缺什么 → 修不了就必须报错 (不知道就不敢断言缺) */
  let strict = false;
  if (otoolOut != null) {
    missing = missingDylibsFromOtool(anvilBin, otoolOut, exists);
    neededNames = missing.map((p) => path.basename(p));
    strict = neededNames.length > 0;
  } else {
    neededNames = [...MACOS_DYLIB_NAMES];   // 兜底: 按已知库名探一探, 找不到也不报错 (不敢断言缺)
  }

  const probed = dylibCandidateDirs(env, userHome);
  const dirs: string[] = [];
  const providedBy = new Map<string, string>();
  for (const d of probed) {
    if (!exists(d)) continue;
    let hit = false;
    for (const n of neededNames) {
      if (exists(path.join(d, n))) { hit = true; if (!providedBy.has(n)) providedBy.set(n, d); }
    }
    if (hit) dirs.push(d);
  }

  // env 里已有的值原样保留 (排最前 = 调用方的显式选择优先), 再把命中的目录追加进去
  const merged: string[] = [];
  for (const d of [...splitPathList(env.DYLD_LIBRARY_PATH), ...dirs]) {
    if (!merged.includes(d)) merged.push(d);
  }
  const dyldLibraryPath = merged.length ? merged.join(':') : null;

  const unresolved = neededNames.filter((n) => !providedBy.has(n));
  const error = strict && unresolved.length
    ? `anvil 缺 macOS 动态库, 本机探测不到: ${unresolved.join(', ')}\n` +
      `  缺的是 (otool -L 认出来的): ${missing.join(', ')}\n` +
      `  anvil: ${anvilBin}\n` +
      `  探测过的候选目录 (都没有这些库, 存在性已查): ${probed.join(', ') || '(无)'}\n` +
      `  怎么修 (任选一条):\n` +
      `    1) 装一个:  brew install libusb      (装完通常在 /opt/homebrew/lib 或 /usr/local/lib)\n` +
      `    2) 已经有 libusb, 但不在上面那些目录 → 显式把它的目录给这一层:\n` +
      `         DYLD_LIBRARY_PATH=<libusb 所在目录> npx tsx <你的脚本>\n` +
      `    3) 换一个不依赖 libusb 的 anvil:  ANVIL_BIN=/path/to/anvil\n` +
      `  (本模块刻意不依赖"用户 HOME 下刚好有 libusb": 探测不到就直接报这个错, 不会伪装成 30s 超时)`
    : null;

  return { anvilBin, missing, neededNames, probed, dirs, dyldLibraryPath, error };
}

// ── anvil 子进程的环境变量 (显式白名单, 不整份继承) ──────────────────────────

/**
 * 允许透传给 anvil 的环境变量 (明文列出)。
 * 为什么要白名单: 原来 `{...process.env}` —— 能不能起来取决于外层 shell 恰好设了什么;
 * 而且链私钥类变量 (BOLLOON_*) 没有任何理由出现在 anvil 进程里。
 */
export const ANVIL_ENV_WHITELIST: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR',
  'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
]);

/** 另外按前缀透传的 (dyld 调试开关 / foundry 自己的配置 / 本模块的开关) */
export const ANVIL_ENV_PREFIXES: readonly string[] = Object.freeze(['DYLD_', 'FOUNDRY_', 'LC_', 'ANVIL_']);

/**
 * 造 anvil 子进程的 env: 白名单透传 (`PATH`/`HOME`/`DYLD_LIBRARY_PATH` 都在里面)
 * + DYLD_LIBRARY_PATH 用探测结果覆盖 (探测结果里已包含调用方原本给的值)。
 */
export function buildAnvilChildEnv(probe: DylibProbeResult, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ANVIL_ENV_WHITELIST.includes(k) || ANVIL_ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  if (!out.HOME) out.HOME = realUserHome(base);
  if (probe.dyldLibraryPath) out.DYLD_LIBRARY_PATH = probe.dyldLibraryPath;
  return out;
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
    throw new Error(
      `找不到 anvil: ${anvilBin} (可用 ANVIL_BIN 指定; macOS 上通常要 DYLD_LIBRARY_PATH=~/.local/lib)` +
      ` —— 本模块会探测 ~/.local/lib 等候选目录, 但可执行文件本身必须存在`,
    );
  }

  // ★ macOS: anvil 动态链到 libusb —— 先探测 (不看 $HOME), 修不了就**立刻**报人话。
  //   为什么不等重试: 缺库是 SIGABRT, 重试 30s 只会把真因伪装成"就绪超时"。
  const dylibs = probeMacosDylibs({ anvilBin, env: process.env });
  if (dylibs.error) throw new Error(dylibs.error);
  const childEnv = buildAnvilChildEnv(dylibs);

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
      ? ` (macOS 缺动态库; 已探测并传给 anvil 的 DYLD_LIBRARY_PATH=${dylibs.dyldLibraryPath ?? '(空 — 没探测到需要的库)'}` +
        ` → 仍缺的话按 probeMacosDylibs 的报错口径修: brew install libusb 或显式设 DYLD_LIBRARY_PATH)`
      : '';
    lastErr = new Error(
      `隔离链没能在 ${readyTimeoutMs}ms 内就绪 (端口 ${port}, ${dead ? `${exitInfo} 进程已退出` : '进程还在但 RPC 不通'})` +
      `/ anvil 输出尾部: ${tail}${dyldHint}`,
    );
    if (dead && dyldHint) break; // 动态库类错误重试也没用
  }
  throw lastErr ?? new Error('隔离链启动失败');
}
