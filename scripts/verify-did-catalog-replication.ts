/**
 * verify-did-catalog-replication.ts — DID 目录 → OrbitDB 自动复制全栈验证 (2026-08-08)
 *
 * 真实 OrbitDB (helia + events store) 验证 (单进程单节点 — 与 server/CLI 同构):
 *   [1] 发布: 本地 WAL 事件 → events store (事件流, 内容寻址, 落盘)
 *   [2] 回放: 第二个 DidCatalog 实例 (模拟设备B) 启动复制流 → 自动拉取 → 目录出现远端行
 *   [3] 反向: 设备B 写入 → 设备A 复制流拉取合并 (双向)
 *   [4] 轨迹: TrajectoryRecorder → 落盘 + OrbitDB keyvalue store 读回
 *   [5] 断点续传: 重启复制流 (新 state) → 游标推进不重复发布
 *
 * 跑法: npx tsx scripts/verify-did-catalog-replication.ts
 * 依赖: 首次会拉起 helia 节点 (~30-60s), 无需网络 (单机 self-host pubsub).
 * 注意: 同一进程内 OrbitDB 实例是单例 (leveldb LOCK), 多设备场景=多进程/多机.
 */
import { OrbitDBAdapter } from '../src/orbitdb/cid-database.js';
import { startDidCatalogReplication } from '../src/orbitdb/did-catalog-replication.js';
import { DidCatalog } from '../src/storage/did-catalog.js';
import {
  TrajectoryRecorder,
  saveTrajectoryToDisk,
  saveTrajectoryToOrbit,
  loadTrajectory,
  listTrajectories,
} from '../src/orbitdb/trajectory-store.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const base = path.join(os.tmpdir(), `bolloon-rep-verify-${Date.now()}`);
  const home = path.join(base, 'home');
  const dataDir = path.join(base, 'orbitdb');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const DID = 'did:key:z6MkVerifyReplication';
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${extra}`); }
  };

  console.log('[0] 准备: 本地目录 + 真实 OrbitDB 适配器 (单例 helia)');
  const db = new OrbitDBAdapter(dataDir);
  const catA = new DidCatalog(DID, { home, deviceId: 'devA' });
  await catA.load();

  console.log('[1] 设备A: 启动复制流 (events store) + 发布本地 WAL');
  const repA = await startDidCatalogReplication(DID, { home, db, auto: false });
  check('events store 打开 (有地址)', repA.storeAddress.length > 10, repA.storeAddress);
  await catA.upsert('memory', 'm-1', { note: '验证第一条' });
  await catA.upsert('persona', 'p-1', { name: '小星' });
  await catA.persist();
  const published = await repA.publishPending();
  check(`publishPending 发布 2 条 (实际 ${published})`, published === 2, `got=${published}`);

  console.log('[1.5] 断点续传: 重启复制流 (同 state) → 游标推进不重复发布');
  const repA2 = await startDidCatalogReplication(DID, { home, db, auto: false });
  const published2 = await repA2.publishPending();
  check(`重启后 publishPending = 0 (实际 ${published2})`, published2 === 0, `got=${published2}`);
  const r2 = await repA2.syncNow();
  check(`重启后 syncNow = 0 (实际 applied=${r2.applied} merged=${r2.merged})`, r2.applied + r2.merged === 0);
  await repA2.stop();

  console.log('[2] 设备B (同 DID, 第二个目录实例): 启动复制流 → 自动拉取远端事件');
  const catB = new DidCatalog(DID, { home, deviceId: 'devB' });
  await catB.load();
  const repB = await startDidCatalogReplication(DID, { home, db, auto: false });
  const rowB = catB.get('memory', 'm-1');
  check('设备B 目录出现远端 memory 行 (自动复制)', !!rowB && (rowB.data as any).note === '验证第一条');
  check('设备B 目录出现远端 persona 行', !!catB.get('persona', 'p-1'));

  console.log('[3] 反向合并: 设备B 写入 → 设备A 拉取 (双向)');
  await catB.upsert('skills', 's-1', { name: '双向技能' });
  await catB.persist();
  const pB = await repB.publishPending();
  check(`设备B 发布新事件 (实际 ${pB})`, pB === 1, `got=${pB}`);
  const syncedA = await repA.syncNow();
  check(`设备A syncNow 合并 (applied=${syncedA.applied}, merged=${syncedA.merged})`, syncedA.applied >= 1);
  await catA.load(); // 同步结果已 persist → 重载内存目录
  const s1 = catA.get('skills', 's-1');
  check('设备A 目录出现设备B 写入的 skills 行', !!s1 && (s1.data as any).name === '双向技能');

  console.log('[4] 智能体运行轨迹: 落盘 + OrbitDB keyvalue');
  const rec = new TrajectoryRecorder({ agentId: 'agent-verify', input: '验证轨迹', channelId: 'ch-v', did: DID });
  rec.recordStep({ type: 'thinking', content: '🤔 开始' });
  rec.recordStep({ type: 'tool', tool: 'list_files', content: '🔧 list_files' });
  rec.recordStep({ type: 'tool', tool: 'list_files', content: '📤 结果: 2 个文件' });
  const run = rec.endRun('验证完成', 'ok');
  const file = await saveTrajectoryToDisk(run, home);
  check('轨迹落盘 ~/.bolloon/trajectories/', !!file && file.includes('trajectories'));
  const orbitOk = await saveTrajectoryToOrbit(run, { db, home });
  check('轨迹写入 OrbitDB (keyvalue bolloon-trajectories-*)', orbitOk === true);
  const loaded = await loadTrajectory(run.runId, home);
  check('轨迹磁盘读回 (steps=3, reply 一致)', !!loaded && loaded.steps.length === 3 && loaded.reply === '验证完成');
  const list = await listTrajectories(home);
  check('listTrajectories 可见', list.some(x => x.runId === run.runId));

  console.log('[5] 清理');
  await repA.stop();
  await repB.stop();
  await db.close().catch(() => {});
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify failed:', e);
  process.exit(1);
});
