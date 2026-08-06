/**
 * smoke-orbitdb.ts — OrbitDB + helia 最小可用性验证 (2026-08-06)
 * createBolloonIpfs → createOrbitDB → keyvalue store → put/get → 关闭
 * 跑法: npx tsx scripts/smoke-orbitdb.ts
 */
import { createBolloonIpfs } from '../src/orbitdb/ipfs-node.js';
import { createOrbitDB } from '@orbitdb/core';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const t0 = Date.now();
  console.log('[smoke] createBolloonIpfs...');
  const node = await createBolloonIpfs(path.join(os.tmpdir(), 'bolloon-smoke-ipfs'));
  console.log(`[smoke] helia 就绪 (${Date.now() - t0}ms), peerId=${node.peerId.slice(0, 16)}...`);

  const t1 = Date.now();
  const orbitdb = await createOrbitDB({
    ipfs: node.helia as any,
    directory: path.join(os.tmpdir(), 'bolloon-smoke-orbitdb'),
  });
  console.log(`[smoke] orbitdb 就绪: ${orbitdb.id} (${Date.now() - t1}ms)`);

  console.log('[smoke] create keyvalue store...');
  const kv = await orbitdb.open('smoke-test', { type: 'keyvalue' });
  console.log(`[smoke] store 地址: ${kv.address}`);

  await kv.put('hello', { agentId: 'test', ts: Date.now(), msg: '你好 OrbitDB' });
  const v = await kv.get('hello');
  console.log('[smoke] get:', JSON.stringify(v));

  if (!v || v.msg !== '你好 OrbitDB') throw new Error('put/get 不一致');

  await orbitdb.stop();
  await node.stop();
  console.log(`[smoke] 全部通过 (总耗时 ${Date.now() - t0}ms)`);
  process.exit(0);
}

main().catch(e => {
  console.error('[smoke] FAIL:', e?.message || e);
  console.error(e?.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
