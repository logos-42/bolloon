/**
 * group-node-child.ts — 真两节点复制验收的**子进程** (2026-09-30, P0)
 *
 * 为什么必须子进程: `getCIDDatabase()` 是**进程内单例** (一个 helia/OrbitDB 节点),
 * 所以"两个真节点"只能是两个真进程 —— 用 fake CIDDatabase 注入的那种测试
 * (src/test/gateway-group.test.ts 等 5 个文件) 从来验不到真复制。
 *
 * 用法:  <tsx> scripts/lib/group-node-child.ts <spec.json>
 * 一个进程 = 一个节点 (自己的 HOME / 身份 / blockstore / 随机端口)。
 * stdout: 每个阶段一行 `@@OUT {json}`; 便于父进程逐行解析。
 *
 * spec 形状:
 *   { home, phase, group?, address?, addrs?, dial?, count?, from?, waitFor?, timeoutMs?, pollMs?, sendWhileNotConnected? }
 * phase:
 *   create_and_send  建 events store (write:['*']) + 欢迎消息 + 追加 count 条 → 报 address/link/peerId/addrs
 *   join_and_wait    (可选 dial addrs) → 按地址打开 → 等 seen >= waitFor → 报 seen/keysHash/耗时/磁盘
 *   open_and_wait    同上, 但用于"自己创建的节点重启后回来" (不 dial 时只读本地)
 *   send_only        按地址打开 (不 dial) 后追加 count 条 → 证明成员离线也能写
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OrbitDBAdapter, type OrbitDBStore } from '../../src/orbitdb/cid-database.js';

interface Spec {
  home: string;
  phase: 'create_and_send' | 'join_and_wait' | 'open_and_wait' | 'send_only';
  group?: string;
  address?: string;
  addrs?: string[];
  dial?: boolean;
  count?: number;
  from?: string;
  waitFor?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** 阶段完成后**保持节点在线**多久 (ms) —— 真两节点验收里, 供块的节点必须活着 */
  holdMs?: number;
}

const specPath = process.argv[2];
if (!specPath) { console.error('用法: group-node-child.ts <spec.json>'); process.exit(2); }
const spec: Spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const dataDir = path.join(spec.home, '.bolloon', 'orbitdb');

function out(obj: Record<string, unknown>): void {
  process.stdout.write('@@OUT ' + JSON.stringify(obj) + '\n');
}

/** 递归统计目录字节数 (P0 要量"本地占用") */
function diskBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return total;
}

/** 事件流的集合指纹: 排序后的 key 列表做 sha256 —— 两节点收敛 = 同一个 hash */
async function keysHash(store: OrbitDBStore): Promise<{ hash: string; seen: number }> {
  const all = await store.all();
  const keys = all.map((r) => r.key).sort();
  const h = crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
  return { hash: h, seen: all.length };
}

async function waitForCount(store: OrbitDBStore, want: number, timeoutMs: number, pollMs: number) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    seen = (await store.all()).length;
    if (seen >= want) return { seen, timedOut: false, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { seen, timedOut: true, waitedMs: Date.now() - t0 };
}

/**
 * 阶段做完后按 spec.holdMs 保持在线 (默认 0 = 立刻退出)。
 * 2026-09-30 教训: 第一版阶段结束就 exit, 于是对端拨号得到 ECONNREFUSED、
 * 拉块得到 "Failed to load block" —— 看着像复制坏了, 其实是**供块的节点已经不在**。
 */
async function holdIfAsked(db: OrbitDBAdapter): Promise<void> {
  const ms = spec.holdMs ?? 0;
  if (ms <= 0) return;
  out({ hold: true, holdMs: ms, phase: spec.phase, home: spec.home, peerId: db.peerId, addrs: db.listenAddrs() });
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const db = new OrbitDBAdapter(dataDir);
  const base = { phase: spec.phase, home: spec.home, dataDir };
  const t0 = Date.now();

  try {
    if (spec.phase === 'create_and_send') {
      const group = spec.group || 'p0-group';
      const store = await db.openStore(`bolloon-gw-group-${group}`, 'events', { accessController: { write: ['*'] } });
      await store.add({ from: spec.from || 'A', text: `📢 群主创建了群「${group}」`, ts: Date.now() });
      const n = spec.count ?? 0;
      const tSend = Date.now();
      for (let i = 0; i < n; i++) {
        await store.add({ from: spec.from || 'A', text: `e${i}`, seq: i, ts: Date.now() });
      }
      const hash = await keysHash(store);
      out({ ...base, ok: true, address: store.address, link: `orbitdb://${store.address}?type=group&name=${group}`,
            appended: n + 1, sendMs: Date.now() - tSend, peerId: db.peerId, addrs: db.listenAddrs(),
            keysHash: hash.hash, seen: hash.seen, diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(0);
    }

    if (spec.phase === 'send_only') {
      const store = await db.openStoreByAddress(spec.address!, 'events', { accessController: { write: ['*'] } });
      if (!store) { out({ ...base, ok: false, error: 'openStoreByAddress 返回 null' }); process.exit(1); }
      const before = (await store.all()).length;
      const n = spec.count ?? 0;
      let err: string | null = null;
      let written = 0;
      for (let i = 0; i < n; i++) {
        try { await store.add({ from: spec.from || 'B', text: `off${i}`, seq: i, ts: Date.now() }); written++; }
        catch (e: any) { err = String(e?.message || e).slice(0, 200); break; }
      }
      const hash = await keysHash(store);
      out({ ...base, ok: err === null, before, written, error: err, keysHash: hash.hash, seen: hash.seen,
            peerId: db.peerId, addrs: db.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(err === null ? 0 : 1);
    }

    // join_and_wait / open_and_wait
    const dialed: string[] = [];
    const dialErrors: string[] = [];
    if (spec.dial !== false && Array.isArray(spec.addrs)) {
      for (const a of spec.addrs) {
        try { await db.dial(a); dialed.push(a); }
        catch (e: any) { dialErrors.push(`${a} → ${String(e?.message || e).slice(0, 120)}`); }
      }
    }
    let store: OrbitDBStore | null = null;
    let openError: string | null = null;
    const tOpen = Date.now();
    try { store = await db.openStoreByAddress(spec.address!, 'events', { accessController: { write: ['*'] } }); }
    catch (e: any) { openError = `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 220)}`; }
    const openMs = Date.now() - tOpen;

    if (!store) {
      out({ ...base, ok: false, openError, dialed, dialErrors, peerId: db.peerId, addrs: db.listenAddrs(),
            seen: 0, diskBytes: diskBytes(dataDir), openMs, totalMs: Date.now() - t0 });
      await db.close();
      process.exit(0); // 打不开是**如实结果**, 由父进程判 (不当崩溃)
    }

    const want = spec.waitFor ?? 1;
    const w = await waitForCount(store, want, spec.timeoutMs ?? 60000, spec.pollMs ?? 500);
    const hash = await keysHash(store);
    out({ ...base, ok: !w.timedOut, openError: null, dialed, dialErrors, openMs, ...w,
          keysHash: hash.hash, seen: hash.seen, peerId: db.peerId, addrs: db.listenAddrs(),
          diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
    await holdIfAsked(db);
    await db.close();
    process.exit(0);
  } catch (e: any) {
    out({ ...base, ok: false, fatal: String(e?.message || e).slice(0, 300) });
    try { await db.close(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  try { await dbForSignal?.close(); } catch { /* 忽略 */ }
  process.exit(0);
});
let dbForSignal: OrbitDBAdapter | null = null;

void main();
