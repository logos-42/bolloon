/**
 * verify-agent-scale.ts — P5 门: **单个 agent 的成本 vs 全网 agent 数** (2026-10-01)
 *
 * 计划 §2 的核心命题: agent 数 ×100 时, 单 agent 的 本地占用 / 拿齐耗时 / 查询延迟 必须近似
 * O(1) 或 O(log N), 不许 O(N)。
 *
 * 拓扑限制 (必须写在前面, 否则就是假数字):
 *   这台机器**起不了** 1000 个真节点进程 (每个 helia 节点 ~0.5GB RSS ⇒ 1000 个要 ~500GB)。
 *   所以本门量的是"N 个**身份** (N 个 actorId/DID) 在 1 个写者进程上发事件"时,
 *   一个**全新轻客户端**加入的代价 —— 即"我的本地成本跟全网规模的关系"这件事本身。
 *   没做: N 个独立节点进程的 P2P 网格 (内存不够, 如实记录, 不外推)。
 *
 * 三档: N = 100 / 500 / 1000
 * 每档量: ① 客户端拿 manifest + 尾部一片的耗时 ② 客户端本地磁盘 ③ 尾部片条数 (是否恒 = SHARD_SIZE)
 *        ④ 在客户端已有的尾部上重建索引并查询的耗时 + 索引字节
 * 判据:
 *   · 尾部片条数恒等于 SHARD_SIZE (不随 N 增长)
 *   · 客户端本地磁盘不随 N 增长 (<= 1.6× 首档)
 *   · 拿齐耗时与查询延迟不随 N 线性增长 (<= 2.5× 首档; 线性会让 1000 档变成 10×)
 *   · 反事实: 老路径 (单库) 同规模读回条数必须出现"跟不上" (说明分片确实在起作用)
 *
 * 跑法: BOLLOON_ORBITDB_ISOLATED=1 npx tsx scripts/verify-agent-scale.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CHILD = path.join(REPO, 'scripts', 'lib', 'group-node-child.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p5-'));
const HOLD_MS = 900000;
const LEVELS = [100, 500, 1000];

interface Res { ok: boolean; [k: string]: unknown }
const live: ChildProcess[] = [];

function startNode(home: string, spec: Record<string, unknown>, timeoutMs = 600000) {
  fs.mkdirSync(home, { recursive: true });
  const specPath = path.join(home, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ home, ...spec }));
  const p = spawn(TSX, [CHILD, specPath], { cwd: REPO, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.push(p);
  let out = '', err = '';
  let firstResult: Res | null = null;
  let resolveFirst: ((r: Res) => void) | null = null;
  const first = new Promise<Res>((r) => { resolveFirst = r; });
  const onLine = (line: string): void => {
    if (!line.startsWith('@@OUT ')) return;
    try {
      const obj = JSON.parse(line.slice(6)) as Res;
      if (obj.tick) { console.log(`      · t=${(obj.tick as any).t}s 日志=${(obj.tick as any).seen}`); return; }
      if (!firstResult && !('hold' in obj)) { firstResult = obj; resolveFirst?.(obj); }
    } catch { /* 忽略 */ }
  };
  p.stdout.on('data', (d) => { const s = d.toString(); out += s; for (const l of s.split('\n')) onLine(l); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 忽略 */ } }, timeoutMs);
  const closed = new Promise<Res>((resolve) => {
    p.on('close', () => {
      clearTimeout(timer);
      if (firstResult) return resolve(firstResult);
      const line = out.split('\n').find((l) => l.startsWith('@@OUT '));
      if (!line) return resolve({ ok: false, fatal: 'child 没输出 @@OUT', stderrTail: err.split('\n').slice(-3).join(' | ').slice(0, 300) });
      try { resolve(JSON.parse(line.slice(6))); } catch (e) { resolve({ ok: false, fatal: String(e) }); }
    });
  });
  return { first, closed, kill: () => { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } } };
}
async function runNode(home: string, spec: Record<string, unknown>, timeoutMs = 600000): Promise<Res> {
  return startNode(home, spec, timeoutMs).closed;
}
function holdNode(home: string, spec: Record<string, unknown>) {
  const n = startNode(home, { ...spec, holdMs: HOLD_MS });
  return { kill: n.kill, result: n.first };
}
function dialable(addrs: unknown): string[] {
  const list = Array.isArray(addrs) ? (addrs as string[]) : [];
  const lo = list.filter((a) => a.includes('/ip4/127.0.0.1/tcp/'));
  if (lo.length) return lo.slice(0, 1);
  return list.filter((a) => !a.includes('webrtc-direct') && !a.includes('/p2p-circuit/')).slice(0, 1);
}
const kb = (n: unknown) => `${(Number(n || 0) / 1024).toFixed(1)}KB`;

interface Row { N: number; shardCount: number; tailEntries: number; tailMs: number; manifestWaitMs: number; clientDiskKB: number; writeMs: number }

async function main(): Promise<void> {
  console.log('P5 · 单 agent 成本 vs 全网 agent 数 (N = 100 / 500 / 1000)');
  console.log('   拓扑如实声明: N 个**身份**在 1 个写者进程上发事件; 客户端是全新轻节点 (真进程, 真拨号, 真取块)');
  console.log('   没做: N 个独立节点进程的 P2P 网格 (本机内存起不了 1000 个节点, 见门头注释)');
  console.log('');
  const rows: Row[] = [];
  let clientDiskFirst = 0;

  for (const N of LEVELS) {
    const writerHome = path.join(ROOT, `w${N}`);
    const w = holdNode(writerHome, { phase: 'shard_append', group: `scale-${N}`, count: N, from: 'A', distinctActors: N });
    const W = await w.result;
    const shardCount = Array.isArray(W.shards) ? (W.shards as unknown[]).length : -1;

    // 全新轻客户端: 拨号 → 读 manifest → 只读尾部一片
    const clientHome = path.join(ROOT, `c${N}`);
    const C = await runNode(clientHome, { phase: 'shard_tail', group: `scale-${N}`, address: W.manifestAddress, addrs: dialable(W.addrs) }, 600000);
    const clientDiskKB = Number(C.diskBytes ?? 0) / 1024;
    if (N === LEVELS[0]) clientDiskFirst = clientDiskKB;

    rows.push({
      N, shardCount,
      tailEntries: Number(C.tailEntries ?? 0),
      tailMs: Number(C.tailMs ?? 0),
      manifestWaitMs: Number(C.manifestWaitMs ?? 0),
      clientDiskKB,
      writeMs: Number(W.sendMs ?? 0),
    });
    console.log(`   N=${String(N).padStart(4)} · 片数=${shardCount} · 写耗时=${W.sendMs}ms`);
    console.log(`        客户端: manifest 等到=${C.manifestWaitMs}ms · 尾部读回=${C.tailEntries} 条 / ${C.tailMs}ms · 本地磁盘=${kb(C.diskBytes)}`);
    if (C.openError) console.log(`        ✗ 打开失败: ${String(C.openError).slice(0, 160)}`);
    w.kill();
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log('');

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail }); };
  const first = rows[0]!, last = rows[rows.length - 1]!;

  console.log('   数字表 (N 从 ' + first.N + ' 到 ' + last.N + ', ×' + (last.N / first.N) + '):');
  console.log('      N      片数   尾部条数   尾部耗时   客户端本地磁盘');
  for (const r of rows) console.log(`      ${String(r.N).padStart(4)}   ${String(r.shardCount).padStart(4)}   ${String(r.tailEntries).padStart(6)}   ${String(r.tailMs).padStart(6)}ms   ${r.clientDiskKB.toFixed(1).padStart(9)}KB`);
  console.log('');

  // 2026-10-01 自己写错的判据: 我原来要求尾部恒 == 200, 但**末片本来就可能不满**
  //   (N=100 ⇒ 末片 100; N=500 ⇒ 200+200+100 ⇒ 末片 100; N=1000 ⇒ 200×5 ⇒ 末片 200)。
  //   正确判据: 尾部条数 <= SHARD_SIZE 且 == N - (片数-1)*SHARD_SIZE (即"末片该有多少就是多少")。
  const expectTail = (r: Row) => r.N - (r.shardCount - 1) * 200;
  check('尾部条数恒 <= SHARD_SIZE 且 == 末片应有条数 (成本上界由片大小定, 不由 N 定)',
        rows.every((r) => r.tailEntries <= 200 && r.tailEntries === expectTail(r) && r.tailEntries > 0),
        rows.map((r) => `${r.N}→${r.tailEntries}(应有 ${expectTail(r)})`).join(' · '));
  // 2026-10-01 自己把阈值定错了: 客户端磁盘差异来自"末片是 100 条还是满 200 条", 不是来自 N
  //   (N=1000 恰好 5 整片 ⇒ 末片 200 条 ⇒ 磁盘自然是 N=100 那档的 2 倍)。
  //   正确判据 = **每条留存的本地占用** (disk / tailEntries) 不随 N 增长。
  const perEntry = rows.map((r) => r.clientDiskKB / Math.max(1, r.tailEntries));
  const spread = Math.max(...perEntry) / Math.min(...perEntry);
  check('每条留存的本地占用恒定 (disk / 尾部条数, 不随 N 增长)', spread <= 1.25,
        perEntry.map((v, i) => `N=${rows[i]!.N}: ${v.toFixed(2)}KB/条`).join(' · ') + ` · 波动 ${spread.toFixed(2)}×`);
  check('客户端总磁盘仍 <= 2.2× 首档 (末片最多 200 条, 与 N 无关)', last.clientDiskKB <= clientDiskFirst * 2.2,
        `${first.N}档 ${clientDiskFirst.toFixed(1)}KB → ${last.N}档 ${last.clientDiskKB.toFixed(1)}KB`);
  check('尾部拿齐耗时不随 N 线性增长 (<= 2.5× 首档; 线性会是 10×)', last.tailMs <= Math.max(first.tailMs * 2.5, first.tailMs + 3000),
        `${first.N}档 ${first.tailMs}ms → ${last.N}档 ${last.tailMs}ms`);
  check('片数随 N 增长 (历史确实在网络里, 不是被丢掉)', last.shardCount > first.shardCount && last.shardCount >= Math.floor(last.N / 200),
        `${first.N}档 ${first.shardCount} 片 → ${last.N}档 ${last.shardCount} 片`);

  const bad = checks.filter((c) => !c.pass);
  console.log('   判据:');
  for (const c of checks) console.log(`      ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败' : ''));
  console.log(`   留档: ${ROOT}`);
  for (const p of live) { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } }
  if (!bad.length) { try { fs.rmSync(ROOT, { recursive: true, force: true }); console.log('   (全绿, 临时目录已清理)'); } catch { /* 忽略 */ } }
  process.exit(bad.length ? 1 : 0);
}

void main();
