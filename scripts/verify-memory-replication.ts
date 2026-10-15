/**
 * verify-memory-replication.ts — P3b 门: **真两节点** 记忆条目复制基线 (2026-10-15)
 *
 * 为什么有这道门: P3 的 memory-sync.ts 用 fake CIDDatabase 注入测试 (src/test/memory-sync.test.ts),
 * 真复制从来没被验过 — 设计文档 §2.6 明确"P3 需真双节点验证 (wiki 已记「跨机复制未全量验证」, 必须补)"。
 * 本门起**真子进程** (每个 = 一个真 helia/libp2p/OrbitDB 节点, 各自 HOME/身份/随机端口),
 * 走真 dial + 真 pubsub + 真 bitswap 块交换, 并把量如实报出来。
 *
 * 场景:
 *   S1  100 条 : A 开 store 写 100 条记忆 (A **保持在线**) → B(新节点) dial + 按地址打开 → 拿到全部?
 *   S3  反事实 : C 打开同一地址但**不 dial** (A 在线且供块) → 必须看不见 (连接必须来自显式拨号)
 *   S2  1000 条 : 迟到者拿长历史 (记忆复制容量)
 *
 * 判据: 集合指纹 entriesHash (排序 entryId 的 sha256) 相同 = 两侧看到的记忆条目逐条一致。
 * 跑法: npx tsx scripts/verify-memory-replication.ts
 * 环境: BOLLOON_ORBITDB_LEAN_ROUTING=1 BOLLOON_ORBITDB_NO_MDNS=1
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CHILD = path.join(REPO, 'scripts', 'lib', 'memory-node-child.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-mem-p0-'));
const HOLD_MS = 600000;

interface Res { ok: boolean; [k: string]: unknown }
interface BgNode { kill: () => void; result: Promise<Res> }
const live: ChildProcess[] = [];

function startNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000, extraEnv: Record<string, string> = {}): Promise<BgNode & { first: Promise<Res> }> {
  fs.mkdirSync(home, { recursive: true });
  const specPath = path.join(home, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ home, ...spec }));
  const p = spawn(TSX, [CHILD, specPath], { cwd: REPO, env: { ...process.env, HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.push(p);
  let out = '', err = '';
  let firstResult: Res | null = null;
  let resolveFirst: ((r: Res) => void) | null = null;
  const first = new Promise<Res>((r) => { resolveFirst = r; });
  const onLine = (line: string): void => {
    if (!line.startsWith('@@OUT ')) return;
    try {
      const obj = JSON.parse(line.slice(6)) as Res;
      if (obj.tick) { console.log(`         · 探针 t=${(obj.tick as any).t}s 日志=${(obj.tick as any).seen} 订阅者=${(obj.tick as any).subscribers} 磁盘=${(obj.tick as any).diskKB}KB`); return; }
      if (!firstResult && !('hold' in obj)) { firstResult = obj; resolveFirst?.(obj); }
    } catch { /* 忽略坏行 */ }
  };
  p.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    out += text;
    for (const line of text.split('\n')) onLine(line);
  });
  p.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const result = new Promise<Res>((resolve) => {
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已死 */ } resolve({ ok: false, error: `节点超时 (${timeoutMs}ms)`, out: out.slice(-2000), err: err.slice(-1000) }); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out: out.slice(-2000), err: err.slice(-1000) }); });
  });
  return { kill: () => { try { p.kill('SIGKILL'); } catch { /* 已死 */ } }, result, first };
}

function check(name: string, cond: boolean, detail: Record<string, unknown>): void {
  const mark = cond ? '✅' : '❌';
  console.log(`  ${mark} ${name}${cond ? '' : '  <- 失败'}`);
  if (!cond) console.log(`    detail: ${JSON.stringify(detail).slice(0, 600)}`);
}

async function main(): Promise<void> {
  const LEAN = { BOLLOON_ORBITDB_LEAN_ROUTING: '1', BOLLOON_ORBITDB_NO_MDNS: '1' };
  const results: Array<{ name: string; ok: boolean }> = [];
  const t0 = Date.now();
  console.log('═══ 记忆条目级复制 P3b 真双节点门 ═══');
  console.log(`ROOT: ${ROOT}\n`);

  // ── S1: A 写 100 条 → B 拨号全拿到 ──────────────────────────────
  console.log('──── S1: 100 条 → B 拨号全拿到 (A 保持在线) ────');
  const homeA1 = path.join(ROOT, 's1-a');
  const a1 = await startNode(homeA1, { phase: 'create_and_send', count: 100, holdMs: HOLD_MS }, 300000, LEAN);
  const a1r = await a1.first;
  check('S1 A 建 store 写 100 条', a1r.ok === true, a1r);
  const addr1 = String(a1r.storeAddr || '');
  const addrs1 = (a1r.addrs as string[]) || [];
  if (a1r.ok) {
    const homeB1 = path.join(ROOT, 's1-b');
    const b1 = await startNode(homeB1, { phase: 'join_and_wait', storeAddr: addr1, addrs: addrs1, waitFor: 100, timeoutMs: 90000, pollMs: 700 }, 120000, LEAN);
    const b1r = await b1.first;
    const same = b1r.entriesHash === a1r.entriesHash;
    check('S1 B 拨号打开同 store → 拿到 100 条 (记忆条目复制)', b1r.ok === true && b1r.seen === 100, b1r);
    check('S1 两侧 entriesHash 一致 (条目级收敛)', same, { a: a1r.entriesHash, b: b1r.entriesHash });
    results.push({ name: 'S1 双节点复制 100 条', ok: b1r.ok === true && b1r.seen === 100 && same });
    console.log(`       B 侧: seen=${b1r.seen} waitMs=${b1r.waitMs}ms polls=${b1r.polls} disk=${b1r.diskBytes}B\n`);
    b1.kill();
  } else { results.push({ name: 'S1 双节点复制 100 条', ok: false }); }
  a1.kill();

  // ── S3: C 不 dial → 看不见 (反事实) ──────────────────────────────
  console.log('──── S3: 不拨号 = 看不见 (连接必须来自显式拨号) ────');
  const homeA3 = path.join(ROOT, 's3-a');
  const a3 = await startNode(homeA3, { phase: 'create_and_send', count: 10, holdMs: HOLD_MS }, 300000, LEAN);
  const a3r = await a3.first;
  const addr3 = String(a3r.storeAddr || '');
  if (a3r.ok) {
    const homeC3 = path.join(ROOT, 's3-c');
    const c3 = await startNode(homeC3, { phase: 'join_and_wait', storeAddr: addr3, addrs: [], waitFor: 10, timeoutMs: 15000, pollMs: 700 }, 60000, LEAN);
    const c3r = await c3.first;
    check('S3 未拨号 → 拿不到 (0 条)', c3r.ok === false || (c3r.seen ?? 0) < 10, c3r);
    results.push({ name: 'S3 反事实: 不拨号不可见', ok: (c3r.seen ?? 0) < 10 });
    console.log(`       C 侧: seen=${c3r.seen} (期望 < 10)\n`);
    c3.kill();
  } else { results.push({ name: 'S3 反事实: 不拨号不可见', ok: false }); }
  a3.kill();

  // ── S2: 1000 条长历史迟到者 ──────────────────────────────────────
  console.log('──── S2: 1000 条 → 迟到者拿长历史 ────');
  const homeA2 = path.join(ROOT, 's2-a');
  const a2 = await startNode(homeA2, { phase: 'create_and_send', count: 1000, holdMs: HOLD_MS }, 300000, LEAN);
  const a2r = await a2.first;
  const addr2 = String(a2r.storeAddr || '');
  const addrs2 = (a2r.addrs as string[]) || [];
  if (a2r.ok) {
    const homeB2 = path.join(ROOT, 's2-b');
    const b2 = await startNode(homeB2, { phase: 'join_and_wait', storeAddr: addr2, addrs: addrs2, waitFor: 1000, timeoutMs: 120000, pollMs: 700 }, 150000, LEAN);
    const b2r = await b2.first;
    const same2 = b2r.entriesHash === a2r.entriesHash;
    check('S2 B 迟到者拿到 1000 条 (长历史复制)', b2r.ok === true && b2r.seen === 1000, b2r);
    check('S2 两侧 entriesHash 一致', same2, { a: a2r.entriesHash, b: b2r.entriesHash });
    results.push({ name: 'S2 长历史 1000 条', ok: b2r.ok === true && b2r.seen === 1000 && same2 });
    console.log(`       B 侧: seen=${b2r.seen} waitMs=${b2r.waitMs}ms polls=${b2r.polls} disk=${b2r.diskBytes}B\n`);
    b2.kill();
  } else { results.push({ name: 'S2 长历史 1000 条', ok: false }); }
  a2.kill();

  // ── 汇总 ─────────────────────────────────────────────────────────
  console.log('═══ 汇总 ═══');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);
  const allOk = results.every((r) => r.ok);
  console.log(`\n总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(allOk ? '\nP3b 记忆条目级复制: 全绿 ✅' : '\nP3b 记忆条目级复制: 有失败 ❌');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('门自身异常:', err); process.exit(2); });