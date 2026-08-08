// verify-global-install.mjs — 验证已安装全局包 (0.3.45) 新功能真实可用 (纯 node, 与 CLI 同解析路径)
const G = '/Users/apple/.npm-global/lib/node_modules/@bolloon/bolloon-agent';
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');

const home = path.join(os.tmpdir(), `bolloon-global-install-verify-${Date.now()}`);
await fs.mkdir(path.join(home, '.bolloon', 'identity'), { recursive: true });
await fs.mkdir(path.join(home, '.bolloon', 'memory', 'agentX', 'sessions'), { recursive: true });
await fs.writeFile(path.join(home, '.bolloon', 'identity', 'user.json'),
  JSON.stringify({ did: 'did:key:z6MkGlobalVerify', publicKeyHex: 'aa', name: 'global-test' }), 'utf-8');
await fs.writeFile(path.join(home, '.bolloon', 'memory', 'agentX', 'sessions', 'ch__s.summary.md'),
  '# 摘要\n\n全局包验证摘要\n', 'utf-8');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('[1] 全局包新模块加载');
const bridge = await import(path.join(G, 'dist/storage/did-catalog-bridge.js'));
const traj = await import(path.join(G, 'dist/orbitdb/trajectory-store.js'));
const replication = await import(path.join(G, 'dist/orbitdb/did-catalog-replication.js'));
check('did-catalog-bridge 加载', typeof bridge.backfillDidCatalog === 'function');
check('trajectory-store 加载', typeof traj.TrajectoryRecorder === 'function');
check('did-catalog-replication 加载', typeof replication.startDidCatalogReplication === 'function');

console.log('[2] DID 目录桥 (回填 + 写穿)');
const cat = await bridge.openUserCatalog({ home });
const r = await bridge.backfillDidCatalog(cat, { home });
const mem = r.find((x) => x.table === 'memory');
check(`回填 memory 表 (added=${mem?.added})`, (mem?.added ?? 0) >= 1);
const ok = await bridge.catalogUpsertQuiet('memory', 'sessions/agentX/ch__s2.summary.md',
  { agentId: 'agentX', summary: '写穿验证', updatedAt: Date.now() }, { home });
check('写穿 catalogUpsertQuiet', ok === true);
const cat2 = await bridge.openUserCatalog({ home }); // 新实例 → 从磁盘读
const row = cat2.get('memory', 'sessions/agentX/ch__s2.summary.md');
check('写穿行可读 (重载磁盘)', !!row && row.data.summary === '写穿验证');

console.log('[3] 运行轨迹 (落盘 + OrbitDB)');
const rec = new traj.TrajectoryRecorder({ agentId: 'agentX', input: '全局包验证', channelId: 'ch', did: 'did:key:z6MkGlobalVerify' });
rec.recordStep({ type: 'thinking', content: '🤔' });
rec.recordStep({ type: 'tool', tool: 'list_files', content: '🔧 list_files' });
const run = rec.endRun('完成', 'ok');
const file = await traj.saveTrajectoryToDisk(run, home);
check('轨迹落盘', !!file && file.includes('trajectories'));
const loaded = await traj.loadTrajectory(run.runId, home);
check('轨迹读回 (steps=2)', !!loaded && loaded.steps.length === 2 && loaded.reply === '完成');
const orbitOk = await traj.saveTrajectoryToOrbit(run, { home });
check('轨迹写入 OrbitDB (真实 helia)', orbitOk === true);

console.log('[4] 复制流启动 (events store 打开)');
const rep = await replication.startDidCatalogReplication('did:key:z6MkGlobalVerify', { home, intervalMs: 60000 });
check('复制流启动 (有 store 地址)', rep.storeAddress.length > 10, rep.storeAddress);
await rep.stop();

await fs.rm(home, { recursive: true, force: true }).catch(() => {});
console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
