/**
 * verify-group-shard-bound.ts — P0b/P3 门: **打开成本由单片大小决定, 不由总历史决定** (2026-09-30)
 *
 * 立这道门的原因 (P0b 实测): OrbitDB 打开一个 events store 要从 heads 遍历整条 oplog DAG,
 * 301 条 = 70s 才一次成形, 1001 条在 300s 窗口里完不成 ⇒ 每开一次群 O(总条数) ⇒ 1 万 agent 不可用。
 *
 * 本门用一个干净的对照来量"有没有变成常数":
 *   建两个群 (同一个写者节点 A):
 *     · 小群 = 200 条 (1 片)
 *     · 大群 = 1000 条 (5 片, 每片 200)
 *   然后各起**一个全新节点** (各自隔离 HOME, 拨号到 A), 只读 manifest + **最后一片**:
 *     · 断言: 大群的尾部打开耗时 **不显著高于** 小群 (<= 1.5x) ⇒ 打开成本与总历史无关
 *   再加一条对照 (老路径): 同一个 A 另建一个 1000 条的**单库**群, 新节点按地址打开它
 *     ⇒ 有界等待 120s, 期望"没完成" —— 这就是分片要解决的问题本身 (如实报, 不当失败判据)。
 *
 * 跑法: npx tsx scripts/verify-group-shard-bound.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CHILD = path.join(REPO, 'scripts', 'lib', 'group-node-child.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-shard-'));
const HOLD_MS = 600000;

interface Res { ok: boolean; [k: string]: unknown }
interface BgNode { kill: () => void; result: Promise<Res> }
const live: ChildProcess[] = [];

function startNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000) {
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
      if (!line) return resolve({ ok: false, fatal: 'child 没输出 @@OUT', stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 400) });
      try { resolve(JSON.parse(line.slice(6))); } catch (e) { resolve({ ok: false, fatal: `解析失败: ${String(e)}` }); }
    });
  });
  return { first, closed, kill: () => { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } } };
}
async function runNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000): Promise<Res> {
  return startNode(home, spec, timeoutMs).closed;
}
function holdNode(home: string, spec: Record<string, unknown>, timeoutMs = 420000): BgNode {
  const n = startNode(home, { ...spec, holdMs: HOLD_MS }, timeoutMs);
  return { kill: n.kill, result: n.first };
}
function dialableAddrs(addrs: unknown): string[] {
  const list = Array.isArray(addrs) ? (addrs as string[]) : [];
  const loopback = list.filter((a) => a.includes('/ip4/127.0.0.1/tcp/'));
  return loopback.length ? loopback.slice(0, 1) : list.filter((a) => !a.includes('webrtc-direct')).slice(0, 1);
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void { checks.push({ name, pass, detail }); }
const kb = (n: unknown) => `${(Number(n || 0) / 1024).toFixed(1)}KB`;

async function main(): Promise<void> {
  console.log('P0b/P3 · 分片让「打开成本」与总历史解耦');
  console.log(`   节点根目录: ${ROOT}`);
  console.log('');

  // ── 逐组串行 (2026-09-30 踩过: 两个 hold 节点共用一个 HOME 会撞 LevelDB 锁 ⇒ 第二个起不来,
  //    返回的结果里没有 shards, 门自己崩。每个"写者"必须有自己的 HOME, 且前一个要退出后再起下一个)
  const W = 180000;
  const nShards = (r: Res) => (Array.isArray(r.shards) ? (r.shards as unknown[]).length : -1);

  // 组 1: 小群 (200 条 / 1 片) —— 量尾部
  const a = holdNode(path.join(ROOT, 'a1'), { phase: 'shard_append', group: 'small', count: 200, from: 'A' });
  const A1r = await a.result;
  console.log(`   A 小群: ${A1r.appended} 条 / ${nShards(A1r)} 片 · 写耗时=${A1r.sendMs}ms · 磁盘=${kb(A1r.diskBytes)}`);
  const t1 = await runNode(path.join(ROOT, 'c-small'), { phase: 'shard_tail', group: 'small', address: A1r.manifestAddress, addrs: dialableAddrs(A1r.addrs) }, W);
  a.kill();

  // 组 2: 大群 (1000 条 / 5 片) —— 量尾部
  const a2 = holdNode(path.join(ROOT, 'a2'), { phase: 'shard_append', group: 'big', count: 1000, from: 'A' });
  const A2 = await a2.result;
  console.log(`   A 大群: ${A2.appended} 条 / ${nShards(A2)} 片 · 写耗时=${A2.sendMs}ms · 磁盘=${kb(A2.diskBytes)}`);
  const t2 = await runNode(path.join(ROOT, 'c-big'), { phase: 'shard_tail', group: 'big', address: A2.manifestAddress, addrs: dialableAddrs(A2.addrs) }, W);
  a2.kill();

  // 组 3: 老路径对照 (单库群 1000 条)
  const a3 = holdNode(path.join(ROOT, 'a3'), { phase: 'create_and_send', group: 'legacy1000', count: 1000, from: 'A' });
  const A3 = await a3.result;
  console.log(`   A 对照(单库群): ${A3.appended} 条 · 写耗时=${A3.sendMs}ms · 磁盘=${kb(A3.diskBytes)}`);
  console.log('');
  console.log('   新节点「只读 manifest + 最后一片」:');
  console.log(`      小群 (200 条 / 1 片): manifest 打开=${t1.manifestMs}ms 等到=${t1.manifestWaitMs}ms · 尾部=${t1.tailMs}ms 读回=${t1.tailEntries} 条(完整=${t1.tailComplete}) · 片数=${t1.shardCount}`);
  console.log(`      大群 (1000 条 / 5 片): manifest 打开=${t2.manifestMs}ms 等到=${t2.manifestWaitMs}ms · 尾部=${t2.tailMs}ms 读回=${t2.tailEntries} 条(完整=${t2.tailComplete}) · 片数=${t2.shardCount}`);
  if (t1.error || t2.error) console.log(`      错误: small=${t1.error} big=${t2.error}`);
  if (!A1r.ok) console.log(`      (A 小群已报错) ${JSON.stringify(A1r).slice(0, 200)}`);
  console.log('');

  // ── 老路径对照: 单库群 1000 条, 有界等 120s
  const legacy = await runNode(path.join(ROOT, 'c-legacy'), { phase: 'join_and_wait', address: A3.address, addrs: dialableAddrs(A3.addrs), waitFor: 1001, timeoutMs: 120000 }, 200000);
  console.log('   对照 · 老路径 (单库群 1000 条, 新节点按地址打开, 上限 120s):');
  console.log(`      读回=${legacy.seen} 条 · timedOut=${legacy.timedOut} · 等=${legacy.waitedMs}ms${legacy.openError ? ' · 打开错误=' + String(legacy.openError).slice(0, 120) : ''}`);
  console.log('');

  const T1 = Number(t1.tailMs), T2 = Number(t2.tailMs);
  const ok1 = Number(t1.tailEntries) === 200 && Number(t2.tailEntries) === 200;
  // 2026-09-30 自己踩的假绿: 大群那次返回 0 条 / 0ms, 也"通过"了比值判据 —— 计时只在该侧**真读到**
  // 时才有意义。所以先要求两侧都 complete 且条数对得上, 再比时间; 否则这条判据直接判红并说明。
  const bothComplete = t1.tailComplete === true && t2.tailComplete === true && Number(t1.tailEntries) === 200 && Number(t2.tailEntries) === 200;
  const ok2 = bothComplete && T2 <= Math.max(T1 * 1.5, T1 + 5000);
  check('两个群的尾部都读回 200 条 (整片, 且完整)', ok1 && t1.tailComplete === true && t2.tailComplete === true,
        `小群=${t1.tailEntries}(完整=${t1.tailComplete}) 大群=${t2.tailEntries}(完整=${t2.tailComplete}) (期望各 200 且完整)`);
  check('大群(1000 条/5 片)尾部打开不显著慢于小群(200 条/1 片) ⇒ 打开成本与总历史解耦', ok2,
        bothComplete ? `小群 ${T1}ms vs 大群 ${T2}ms (判据: 大群 <= max(1.5×小群, 小群+5s))`
                     : `两侧都不是"真读到 200 条", 时间不可比 (小群 ${T1}ms/${t1.tailEntries} 条 complete=${t1.tailComplete}; 大群 ${T2}ms/${t2.tailEntries} 条 complete=${t2.tailComplete}) ⇒ 判红`);
  check('尾部只打开 1 片 (不扫全历史)', Number(t1.openedShards) === 1 && Number(t2.openedShards) === 1,
        `小群 openedShards=${t1.openedShards} · 大群 openedShards=${t2.openedShards}`);
  console.log('   与老路径的对照 (不作为判据, 作为"分片要解决什么"的证据):');
  console.log(`      单库群 1000 条: 新节点 120s 内读回 ${legacy.seen} 条 (timedOut=${legacy.timedOut})`);
  console.log('');

  const bad = checks.filter((c) => !c.pass);
  console.log('   判据:');
  for (const c of checks) console.log(`      ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败, 见上' : ''));
  console.log(`   节点数据留档: ${ROOT}`);
  for (const p of live) { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } }
  if (!bad.length) { try { fs.rmSync(ROOT, { recursive: true, force: true }); console.log('   (全绿, 临时节点目录已清理)'); } catch { /* 忽略 */ } }
  process.exit(bad.length ? 1 : 0);
}

void main();
