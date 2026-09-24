/**
 * verify-orbitdb-durable.ts — OrbitDB **跨进程**持久化验收 (2026-09-24)
 *
 * 要证的那件事: `createBolloonIpfs(dataDir)` 把区块与 datastore 真落盘, 于是
 * OrbitDB store (特别是 gateway-group 的群 events store) 能在**新进程**里用地址重开,
 * 并读到既有条目 —— 不是同进程内自演, 也不是内存缓存。
 *
 * 全景 (每一步都是**独立 node 进程**, 由本脚本 spawn):
 *   ① create    建群 + 发 2 条消息 → 干净退出 (orbitdb.stop + helia.stop)
 *   ② read      新进程用**群链接**重开 → 必须读到那 2 条, 逐字一致
 *   ③ append    再一个新进程追加 1 条 → 第 4 个进程读到 3 条 (真持久化, 不是缓存)
 *   ③b trail     又一个新进程走 task-group 发送闸发一条真 `[bolloon-task]` 过程痕迹
 *   ④ 负控制 1  换一个**空 dataDir** 开同一地址 → 必须**大声失败**
 *                (模块层抛 STORE_UNREACHABLE; CLI `task trail` 必须 TRANSPORT_FAILED,
 *                 且**不许**把"读不到"说成"群里本期没有过程痕迹")
 *   ④ 正对照    同一个 dataDir 下同一条 CLI 必须成功 (证明上一条不是 CLI 坏了)
 *   ⑤ 负控制 2  写入后被 `kill -9` (不优雅退出) → 新进程要么读到已写条目,
 *                要么如实报错; 不许静默丢数据后显示"空群"
 *
 * 跑法:
 *   npx tsx scripts/verify-orbitdb-durable.ts            # 编排 (①-⑤)
 *   npx tsx scripts/verify-orbitdb-durable.ts --stage <name> ...   # 子进程 (内部用)
 *
 * 隔离: 每个子进程都把自己的 HOME/USERPROFILE 指到测试根目录下 ——
 *   群列表落 $HOME/.bolloon/gateway-groups.json, OrbitDB 落 $HOME/.bolloon/orbitdb,
 *   所以"换 HOME"就等于"换 dataDir"。真实 ~/.bolloon 不会被碰。
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const RESULT_PREFIX = '##RESULT##';
const STAGE_TIMEOUT_MS = 240_000;

// ── 计数 ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const skipped: string[] = [];
const failures: string[] = [];

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${detail === undefined ? '' : ` — ${brief(detail)}`}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail === undefined ? '' : ` — ${brief(detail)}`}`);
  }
}
function skip(name: string, why: string): void {
  skipped.push(`${name} — ${why}`);
  console.log(`  ⏭️  SKIPPED: ${name} (${why})`);
}
function brief(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

// ── 子进程工具 ──────────────────────────────────────────────────────────────

/**
 * 跑 TS 用 `node --import tsx <file>` —— **单进程**。
 * 不能用 `node_modules/.bin/tsx`: 那个 CLI 会再 fork 一个 node 子进程跑真脚本,
 * 于是 `kill -9` 只杀掉包装器, 真 worker 变成孤儿**继续持有 LevelDB 锁**,
 * 后续进程开 store 就会失败 —— ⑤ 的负控制会被自己的夹具污染 (已踩过)。
 */
function nodeArgs(args: string[]): string[] {
  return ['--import', 'tsx', ...args];
}

/** 进程是否还活着 */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 清掉上一次跑崩留下的 --stage hang 孤儿 (它们会一直占着 LevelDB 锁) */
function killStaleWorkers(): number {
  const r = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf-8' });
  if (r.status !== 0) return 0;
  let n = 0;
  for (const line of String(r.stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === process.pid) continue;
    if (cmd.includes(SELF) && cmd.includes('--stage hang')) {
      try { process.kill(pid, 'SIGKILL'); n++; } catch { /* 已经没了 */ }
    }
  }
  return n;
}

interface StageRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  result: any | null;
  parseError?: string;
}

/** 从子进程 stdout 里抠出 `##RESULT## {json}` */
function extractResult(stdout: string): { result: any | null; parseError?: string } {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(RESULT_PREFIX)) continue;
    const raw = line.slice(RESULT_PREFIX.length).trim();
    try {
      return { result: JSON.parse(raw) };
    } catch (e: any) {
      return { result: null, parseError: `子进程 JSON 解析失败: ${String(e?.message || e)} :: ${raw.slice(0, 200)}` };
    }
  }
  return { result: null, parseError: '子进程没有输出 ##RESULT## 行' };
}

function stageEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

/** 跑一个子进程 stage (同步等待) */
function runStage(stage: string, args: string[], home: string, timeoutMs = STAGE_TIMEOUT_MS): StageRun {
  const r = spawnSync(process.execPath, nodeArgs([SELF, '--stage', stage, ...args]), {
    cwd: ROOT,
    env: stageEnv(home),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  const { result, parseError } = extractResult(stdout);
  return { code: r.status, signal: r.signal, stdout, stderr, result, parseError };
}

/** 跑真实 CLI (bolloon task trail …) */
function runCli(args: string[], home: string, timeoutMs = STAGE_TIMEOUT_MS): StageRun {
  const r = spawnSync(process.execPath, nodeArgs(['src/cli-entry.ts', ...args]), {
    cwd: ROOT,
    env: stageEnv(home),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return { code: r.status, signal: r.signal, stdout, stderr, result: extractJsonObject(stdout) };
}

/** 从 CLI stdout 里抠出那个 pretty-print 的信封 JSON */
function extractJsonObject(out: string): any | null {
  const start = out.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(out.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function tail(s: string, n = 6): string {
  return s.trim().split('\n').slice(-n).join('\n');
}

// ── 子进程 stage 实现 (每个都是独立进程) ────────────────────────────────────

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function closeDb(): Promise<void> {
  try {
    const { getCIDDatabase } = await import('../src/orbitdb/cid-database.js');
    await getCIDDatabase().close();
  } catch { /* 关闭失败不影响判定 */ }
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`${RESULT_PREFIX} ${JSON.stringify(result)}\n`);
}

const EXPLICIT_A = ['第一条: 区块落盘了吗', '第二条: 新进程还读得到吗'];
const EXPLICIT_C = '第三条: 追加的这条也是真的';

/** ① create: 建群 + 发 2 条 → 干净退出 */
async function stageCreate(argv: string[]): Promise<number> {
  const name = flag(argv, '--name') || `durable-${Date.now().toString(36)}`;
  const GG: any = await import('../src/agents/gateway-group.js');
  const r = await GG.createGroup(name, { from: 'did:diap:owner-A', hello: '群建好了' });
  if (!r.ok || !r.group) {
    emit({ ok: false, step: 'createGroup', error: r.error });
    return 1;
  }
  const id = r.group.id as string;
  const sent: string[] = [];
  for (const t of EXPLICIT_A) {
    const s = await GG.groupSend(id, t, 'agent-alice');
    if (!s.ok) { emit({ ok: false, step: 'groupSend', text: t, error: s.error }); return 1; }
    sent.push(t);
  }
  const msgs = await GG.groupMessages(id, 500);
  const texts = msgs.map((m: any) => m.text);
  const ok = EXPLICIT_A.every((t) => texts.includes(t));
  const out = {
    ok, pid: process.pid, step: 'create',
    name, id, address: r.group.address, link: r.group.link,
    total: texts.length, texts, sent,
  };
  emit(out);
  await closeDb();
  return ok ? 0 : 1;
}

/** ② / ③ read: 用群链接重开 (新进程) 并读回 */
async function stageRead(argv: string[]): Promise<number> {
  const link = flag(argv, '--group') || '';
  const GG: any = await import('../src/agents/gateway-group.js');
  const joined = await GG.joinGroup(link);
  if (!joined.ok || !joined.group) {
    emit({ ok: false, step: 'joinGroup', pid: process.pid, error: joined.error });
    await closeDb();
    return 1;
  }
  const id = joined.group.id as string;
  let texts: string[] = [];
  let dataDir: string | null = null;
  try {
    const { getCIDDatabase } = await import('../src/orbitdb/cid-database.js');
    const db: any = getCIDDatabase();
    const msgs = await GG.groupMessages(id, 500);
    texts = msgs.map((m: any) => m.text);
    dataDir = db.ipfsPaths?.dataDir ?? null;
    emit({
      ok: true, pid: process.pid, step: 'read', already: !!joined.already,
      id, address: joined.group.address, dataDir,
      count: texts.length, texts,
    });
    await closeDb();
    return 0;
  } catch (e: any) {
    emit({
      ok: false, pid: process.pid, step: 'read', id, address: joined.group.address,
      readFailed: true, errName: e?.name ?? null, code: e?.code ?? null,
      error: String(e?.message ?? e).slice(0, 300),
    });
    await closeDb();
    return 1;
  }
}

/** ③ append: 追加 1 条 (独立进程) */
async function stageAppend(argv: string[]): Promise<number> {
  const text = flag(argv, '--text') || '追加一条';
  const link = flag(argv, '--group') || '';
  const GG: any = await import('../src/agents/gateway-group.js');
  const joined = await GG.joinGroup(link);
  if (!joined.ok || !joined.group) {
    emit({ ok: false, step: 'joinGroup', error: joined.error });
    await closeDb();
    return 1;
  }
  const id = joined.group.id as string;
  const s = await GG.groupSend(id, text, 'agent-bob');
  if (!s.ok) {
    emit({ ok: false, pid: process.pid, step: 'append', error: s.error });
    await closeDb();
    return 1;
  }
  const msgs = await GG.groupMessages(id, 500);
  const texts = msgs.map((m: any) => m.text);
  emit({ ok: texts.includes(text), pid: process.pid, step: 'append', id, count: texts.length, texts });
  await closeDb();
  return texts.includes(text) ? 0 : 1;
}

/**
 * ③b 过程痕迹: 走真实的 `task-group` 发送闸, 往群里发一条 `[bolloon-task]` 事实行。
 * 这样下一个进程里的真 CLI (`bolloon task trail --group <链接>`) 有东西可读 ——
 * 证明的不只是"消息落盘", 而是**任务过程痕迹**这条跨进程链路。
 */
async function stageTrail(argv: string[]): Promise<number> {
  const link = flag(argv, '--group') || '';
  const GG: any = await import('../src/agents/gateway-group.js');
  const TG: any = await import('../src/agents/task-group.js');
  const joined = await GG.joinGroup(link);
  if (!joined.ok || !joined.group) {
    emit({ ok: false, step: 'joinGroup', error: joined.error });
    await closeDb();
    return 1;
  }
  const id = joined.group.id as string;
  const built = TG.buildPostMessage({
    kind: 'deliver',
    announcementId: 'ann-verify-0001',
    hash: 'a'.repeat(64),
    bytes: 123,
  });
  if (!built.ok) {
    emit({ ok: false, pid: process.pid, step: 'trail', where: 'buildPostMessage', error: built.message });
    await closeDb();
    return 1;
  }
  const sent = await TG.sendTrailMessage(id, built.text, 'agent-verify');
  if (!sent.ok) {
    emit({ ok: false, pid: process.pid, step: 'trail', where: 'sendTrailMessage', error: sent.error });
    await closeDb();
    return 1;
  }
  emit({ ok: true, pid: process.pid, step: 'trail', id, text: built.text });
  await closeDb();
  return 0;
}

/** ④ 负控制 (模块层): 直接按地址开 store —— 期待**抛**, 不是 null */
async function stageOpenAddr(argv: string[]): Promise<number> {
  const addr = flag(argv, '--addr') || '';
  const dataDir = flag(argv, '--datadir') || undefined;
  const { OrbitDBAdapter } = await import('../src/orbitdb/cid-database.js');
  const db: any = new OrbitDBAdapter(dataDir);
  try {
    const store = await db.openStoreByAddress(addr, 'events', { replica: false, accessController: { write: ['*'] } });
    const all = store ? await store.all() : null;
    emit({ ok: true, pid: process.pid, step: 'open-addr', dataDir: db.dataDir, gotStore: !!store, entries: all ? all.length : null, threw: false });
    await db.close();
    return 0;
  } catch (e: any) {
    emit({
      ok: false, pid: process.pid, step: 'open-addr', dataDir: db.dataDir,
      threw: true, errName: e?.name ?? null, code: e?.code ?? null,
      error: String(e?.message ?? e).slice(0, 400),
    });
    try { await db.close(); } catch { /* 忽略 */ }
    return 0; // 抛是**期待**的结果, 退出码交给编排器判
  }
}

/** ⑤ 负控制 2: 写入 → 打印标记 → 一直挂着 (等父进程 kill -9) */
async function stageHang(argv: string[]): Promise<number> {
  const name = flag(argv, '--name') || `hang-${Date.now().toString(36)}`;
  const GG: any = await import('../src/agents/gateway-group.js');
  const r = await GG.createGroup(name, { from: 'did:diap:owner-E', hello: '脏退出群' });
  if (!r.ok || !r.group) { emit({ ok: false, step: 'createGroup', error: r.error }); return 1; }
  const id = r.group.id as string;
  for (const t of EXPLICIT_A) {
    const s = await GG.groupSend(id, t, 'agent-dave');
    if (!s.ok) { emit({ ok: false, step: 'groupSend', error: s.error }); return 1; }
  }
  const msgs = await GG.groupMessages(id, 500);
  const texts = msgs.map((m: any) => m.text);
  emit({
    ok: true, pid: process.pid, step: 'hang', name, id, address: r.group.address, link: r.group.link,
    total: texts.length, texts, written: EXPLICIT_A,
    note: '已写完 2 条, 现在不关闭节点, 等父进程 SIGKILL',
  });
  // 不 close, 不 exit —— 保持进程活着, 让父进程 kill -9
  setInterval(() => { /* 挂住 */ }, 60_000);
  await new Promise<void>(() => { /* 永不 resolve */ });
  return 0;
}

async function runStageChild(stage: string, argv: string[]): Promise<number> {
  switch (stage) {
    case 'create': return stageCreate(argv);
    case 'read': return stageRead(argv);
    case 'append': return stageAppend(argv);
    case 'trail': return stageTrail(argv);
    case 'open-addr': return stageOpenAddr(argv);
    case 'hang': return stageHang(argv);
    default: {
      process.stderr.write(`未知 stage: ${stage}\n`);
      return 2;
    }
  }
}

// ── 编排 ────────────────────────────────────────────────────────────────────

const BASE = path.join(os.tmpdir(), 'bolloon-orbitdb-durable');
const HOME_MAIN = path.join(BASE, 'home-main');
const HOME_NEG = path.join(BASE, 'home-neg-empty-datadir');

function freshDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
}

/** 数一数某个 dataDir 下真落了多少文件 (证据: 区块/datastore 真的写下去了) */
function countFiles(dir: string): { files: number; blocks: number; datastore: number } {
  const walk = (d: string): number => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
        const f = path.join(d, e.name);
        return n + (e.isDirectory() ? walk(f) : 1);
      }, 0);
    } catch { return 0; }
  };
  return {
    files: walk(dir),
    blocks: walk(path.join(dir, 'blocks')),
    datastore: walk(path.join(dir, 'datastore')),
  };
}

async function main(): Promise<void> {
  console.log('OrbitDB 跨进程持久化验收 (每个步骤都是独立 node 进程)');
  console.log(`仓库: ${ROOT}`);
  console.log(`测试根: ${BASE}  (HOME_MAIN=${HOME_MAIN} · HOME_NEG=${HOME_NEG})`);

  const stale = killStaleWorkers();
  if (stale) console.log(`  (先清掉上次遗留的 ${stale} 个 --stage hang 孤儿进程: 它们会一直占着 LevelDB 锁)`);
  freshDir(BASE);
  fs.mkdirSync(HOME_MAIN, { recursive: true });
  fs.mkdirSync(HOME_NEG, { recursive: true });

  const t0 = Date.now();

  // ── ① 进程 A: 建群 + 发 2 条 → 干净退出 ────────────────────────────────
  section('① 进程 A: 建群 + 发 2 条消息 → 干净退出');
  const A = runStage('create', ['--name', 'durable-group'], HOME_MAIN);
  console.log(`  [A] pid/退出码=${A.code} signal=${A.signal}`);
  if (A.result) console.log(`  [A] ${brief(A.result)}`);
  else console.log(`  [A] stderr: ${tail(A.stderr)}`);
  if (!A.result) {
    check('① 进程 A 输出可解析的结果', false, A.parseError || tail(A.stderr, 12));
    return finish();
  }
  const link: string = A.result.link;
  const address: string = A.result.address;
  const gid: string = A.result.id;
  check('① 进程 A 真建了群并发进 2 条 (群内总条目 = 欢迎语 + 2)', A.code === 0 && A.result.ok === true && A.result.total === 3, {
    code: A.code, total: A.result.total, texts: A.result.texts,
  });
  check('① 群地址是 OrbitDB store 地址 (/orbitdb/…)', typeof address === 'string' && address.startsWith('/orbitdb/'), address);

  const dirA = path.join(HOME_MAIN, '.bolloon', 'orbitdb');
  const ipfsA = path.join(dirA, 'ipfs');
  const filesA = countFiles(ipfsA);
  check('① 进程 A 退出后 dataDir 下真有 ipfs/ 区块目录 (不是内存)', filesA.blocks > 0 && filesA.datastore > 0, {
    ipfsDir: ipfsA, ...filesA,
  });

  // ── ② 进程 B: 用群链接重开 → 读到那 2 条 ──────────────────────────────
  section('② 进程 B (新进程): 用群链接重开 → 必须读到那 2 条');
  const B = runStage('read', ['--group', link], HOME_MAIN);
  console.log(`  [B] pid/退出码=${B.code} signal=${B.signal}`);
  if (B.result) console.log(`  [B] ${brief(B.result)}`);
  else console.log(`  [B] stderr: ${tail(B.stderr)}`);
  if (!B.result) {
    check('② 进程 B 输出可解析的结果', false, B.parseError || tail(B.stderr, 12));
    return finish();
  }
  const bTexts: string[] = Array.isArray(B.result.texts) ? B.result.texts : [];
  check('② 新进程里 groupMessages 不抛 (store 真开得了)', B.code === 0 && B.result.ok === true, {
    code: B.code, error: B.result.error ?? null,
  });
  check('② 读到 ①写的 2 条, 内容逐字一致', EXPLICIT_A.every((t) => bTexts.includes(t)), {
    want: EXPLICIT_A, got: bTexts,
  });
  check('② 群内总条目仍为 3 (欢迎语 + 2 条)', B.result.count === 3, { count: B.result.count });

  // ── ③ 进程 C 追加 1 条 → 进程 D 读到 3 条 ─────────────────────────────
  section('③ 进程 C 追加 1 条 → 进程 D 读到 3 条 (真持久化, 不是缓存)');
  const C = runStage('append', ['--group', link, '--text', EXPLICIT_C], HOME_MAIN);
  console.log(`  [C] pid/退出码=${C.code} · ${C.result ? brief(C.result) : tail(C.stderr)}`);
  check('③ 进程 C 追加成功且自己读回可见', C.code === 0 && C.result?.ok === true, { code: C.code, error: C.result?.error ?? null });

  const D = runStage('read', ['--group', link], HOME_MAIN);
  console.log(`  [D] pid/退出码=${D.code} · ${D.result ? brief(D.result) : tail(D.stderr)}`);
  const dTexts: string[] = Array.isArray(D.result?.texts) ? D.result.texts : [];
  const want3 = [...EXPLICIT_A, EXPLICIT_C];
  check('③ 进程 D 读到 3 条显式消息, 逐字一致', D.code === 0 && want3.every((t) => dTexts.includes(t)), {
    want: want3, got: dTexts,
  });
  check('③ 进程 D 群内总条目 = 4 (欢迎语 + 3)', D.result?.count === 4, { count: D.result?.count });

  // ── ③b 过程痕迹 (真 task-group 闸) → 给 CLI 正对照留可读的东西 ─────────
  section('③b 另一个新进程走 task-group 发送闸发一条真过程痕迹 ([bolloon-task] deliver)');
  const T2 = runStage('trail', ['--group', link], HOME_MAIN);
  console.log(`  [T2] pid/退出码=${T2.code} · ${T2.result ? brief(T2.result) : tail(T2.stderr)}`);
  check('③b 过程痕迹真发进群 (过隐私闸 + 落盘)', T2.code === 0 && T2.result?.ok === true, {
    code: T2.code, error: T2.result?.error ?? null, text: T2.result?.text ?? null,
  });

  // ── ④ 负控制: 另一个空 dataDir 开同一地址 → 必须大声失败 ──────────────
  section('④ 负控制: 换一个空 dataDir 开同一地址 → 必须大声失败 (不许显示成"没有消息")');
  // HOME_NEG 只有群列表, 没有 orbitdb 区块 —— 相当于"我本地有这个群, 但没同步过内容"
  fs.mkdirSync(path.join(HOME_NEG, '.bolloon'), { recursive: true });
  fs.copyFileSync(
    path.join(HOME_MAIN, '.bolloon', 'gateway-groups.json'),
    path.join(HOME_NEG, '.bolloon', 'gateway-groups.json'),
  );
  const negIpfs = path.join(HOME_NEG, '.bolloon', 'orbitdb', 'ipfs');
  check('④ 空 dataDir 侧确实没有区块 (前置事实)', countFiles(negIpfs).blocks === 0, { dir: negIpfs });

  const N1 = runStage('open-addr', ['--addr', address], HOME_NEG, 120_000);
  console.log(`  [N1 模块层] pid/退出码=${N1.code} · ${N1.result ? brief(N1.result) : tail(N1.stderr)}`);
  check('④ 模块层: openStoreByAddress 在空 dataDir 上**抛**(不是返回 null)', N1.result?.threw === true, {
    got: N1.result ?? null,
  });
  check('④ 抛的是 STORE_UNREACHABLE 且带原始原因', N1.result?.code === 'STORE_UNREACHABLE' && /block broker|No block|not found|NotFound/i.test(String(N1.result?.error ?? '')), {
    name: N1.result?.errName, code: N1.result?.code, error: N1.result?.error,
  });

  const N2 = runCli(['task', 'trail', '--group', link, '--from', 'agent-verify', '--json'], HOME_NEG, 120_000);
  const nEnv = N2.result;
  console.log(`  [N2 CLI 负控制] 退出码=${N2.code} code=${nEnv?.code ?? '?'} ok=${nEnv?.ok}`);
  check('④ CLI `task trail` 在空 dataDir 上退出码非 0', N2.code !== 0, { code: N2.code, signal: N2.signal });
  check('④ CLI 信封 ok=false 且 code=TRANSPORT_FAILED', nEnv?.ok === false && nEnv?.code === 'TRANSPORT_FAILED', {
    ok: nEnv?.ok, code: nEnv?.code, message: nEnv?.message,
  });
  check('④ CLI **没有**把"读不到"说成"群里本期没有过程痕迹"', !/没有过程痕迹/.test(N2.stdout), {
    stdout: tail(N2.stdout, 8),
  });
  check('④ CLI 明说没降级到本地缓存 (localFallback=false)', nEnv?.data?.localFallback === false, nEnv?.data ?? null);

  const P = runCli(['task', 'trail', '--group', link, '--from', 'agent-verify', '--json'], HOME_MAIN, 120_000);
  const pEnv = P.result;
  console.log(`  [P CLI 正对照] 退出码=${P.code} ok=${pEnv?.ok} count=${pEnv?.data?.count}`);
  check('④ 正对照: 同一 dataDir 下同一条 CLI 成功 (证明上一条不是 CLI 坏了)', P.code === 0 && pEnv?.ok === true, {
    code: P.code, ok: pEnv?.ok, message: pEnv?.message,
  });
  check('④ 正对照: CLI 跨进程读回 ③b 那条过程痕迹 (count=1, deliver=1)', pEnv?.data?.count === 1 && pEnv?.data?.byKind?.deliver === 1, {
    count: pEnv?.data?.count, byKind: pEnv?.data?.byKind, announcements: pEnv?.data?.announcements,
  });
  check('④ 正/负对照的 code 真的不同 (OK vs TRANSPORT_FAILED)', pEnv?.code === 'OK' && nEnv?.code === 'TRANSPORT_FAILED', {
    pos: pEnv?.code, neg: nEnv?.code,
  });

  // ── ⑤ 负控制 2: 写入后被 kill -9 → 新进程要么读到, 要么如实报错 ───────
  section('⑤ 负控制 2: 写入后 kill -9 (不优雅退出) → 新进程要么读到已写条目, 要么如实报错');
  const hung: ChildProcess = spawn(process.execPath, nodeArgs([SELF, '--stage', 'hang', '--name', 'dirty-exit-group']), {
    cwd: ROOT,
    env: stageEnv(HOME_MAIN),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 自成进程组 → 可以整组 SIGKILL (不留孤儿占锁)
  });
  let hangOut = '';
  let hangErr = '';
  hung.stdout!.on('data', (d) => { hangOut += String(d); });
  hung.stderr!.on('data', (d) => { hangErr += String(d); });

  const hangResult = await new Promise<any | null>((resolve) => {
    const deadline = Date.now() + 180_000;
    const timer = setInterval(() => {
      const { result } = extractResult(hangOut);
      if (result) { clearInterval(timer); resolve(result); }
      else if (Date.now() > deadline) { clearInterval(timer); resolve(null); }
    }, 250);
    hung.on('exit', () => { const { result } = extractResult(hangOut); clearInterval(timer); resolve(result); });
  });

  if (!hangResult || hangResult.ok !== true) {
    check('⑤ 脏退出进程先把 2 条写完', false, { result: hangResult, stderr: tail(hangErr, 8) });
    try { hung.kill('SIGKILL'); } catch { /* 忽略 */ }
  } else {
    check('⑤ 脏退出进程已写完 (marker 收到, 此刻区块应已落文件)', hangResult.total === 3, { total: hangResult.total });
    // 整组 SIGKILL: 真 worker 的 pid 必须真的死掉 (否则它会继续占着 LevelDB 锁, 污染后面的读)
    let killedGroup = false;
    try { process.kill(-hung.pid!, 'SIGKILL'); killedGroup = true; } catch { /* 退回归单个 kill */ }
    const killed = hung.kill('SIGKILL');
    const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (hung.exitCode !== null || hung.signalCode !== null) return resolve({ code: hung.exitCode, signal: hung.signalCode });
      hung.on('exit', (code, signal) => resolve({ code, signal }));
    });
    await new Promise((r2) => setTimeout(r2, 800));
    check('⑤ 进程真的被 SIGKILL 干掉 (不是优雅退出)', exitInfo.signal === 'SIGKILL', {
      killedGroup, killed, ...exitInfo, pid: hangResult.pid,
    });
    check('⑤ 真 worker 进程已被彻底杀掉 (不留占锁孤儿)', !isAlive(hangResult.pid), { workerPid: hangResult.pid });

    const R = runStage('read', ['--group', hangResult.link], HOME_MAIN);
    console.log(`  [R] pid/退出码=${R.code} · ${R.result ? brief(R.result) : tail(R.stderr)}`);
    const rTexts: string[] = Array.isArray(R.result?.texts) ? R.result.texts : [];
    const readBack = R.code === 0 && R.result?.ok === true && EXPLICIT_A.every((t) => rTexts.includes(t));
    const honestFail = R.result?.ok === false && R.result?.readFailed === true;
    check('⑤ kill -9 后新进程**要么读到已写条目, 要么如实报错** (绝不许静默显示空群)', readBack || honestFail, {
      读到: readBack, 如实报错: honestFail, result: R.result,
    });
    check('⑤ 强结果: kill -9 后真读到那 2 条 (文件级落盘, 不优雅退出也不丢)', readBack, {
      want: EXPLICIT_A, got: rTexts, error: R.result?.error ?? null,
    });
    if (readBack) {
      console.log('     → 结果: 读到了 (区块是文件级落盘, 进程被 kill -9 也不丢)');
    } else if (honestFail) {
      console.log(`     → 结果: 如实报错 (没有拿"空群"糊弄): ${R.result?.error}`);
    } else {
      console.log('     → 结果: 既没读到也没报错 —— 这是**静默丢数据**, 最坏情况');
    }
  }

  // ── 残留限制的显式 skipped ────────────────────────────────────────────
  section('显式 SKIPPED: 本脚本**没有**验过的东西');
  skip('两台机器之间经 OrbitDB 复制看到彼此的群消息', '本任务只要求同机跨进程持久化; 跨机同步仍需 peers + block broker (bitswap), 是另一条线');
  skip('多个进程**同时**写同一个 store 的并发语义', 'OrbitDB/mortice 的跨进程互斥不在本次范围; 本脚本是顺序多进程');

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed, ${skipped.length} skipped (耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  if (failures.length) console.log(`失败明细:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  console.log(`证据目录 (保留, 可自查): ${BASE}`);
  return finish();
}

function finish(): void {
  process.exit(failed === 0 ? 0 : 1);
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const si = argv.indexOf('--stage');
if (si >= 0) {
  const stage = argv[si + 1];
  runStageChild(stage, argv.slice(si + 2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[stage ${stage}] 崩了: ${e?.stack || e}\n`);
      process.exit(1);
    });
} else {
  main().catch((e) => {
    console.error(`编排器崩了: ${e?.stack || e}`);
    process.exit(1);
  });
}
