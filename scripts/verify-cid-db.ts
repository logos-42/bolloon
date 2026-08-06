/**
 * verify-cid-db.ts — CIDDatabase (OrbitDBAdapter) 全链路验证 (2026-08-06)
 * save → load → update → version → list → share → load(网络块) → close
 * 跑法: npx tsx scripts/verify-cid-db.ts
 */
import { OrbitDBAdapter, type CIDRecord } from '../src/orbitdb/cid-database.js';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const dir = path.join(os.tmpdir(), `bolloon-cid-db-test-${Date.now()}`);
  const db = new OrbitDBAdapter(dir);
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${extra}`); }
  };

  console.log('[1] save → 生成内容寻址 CID');
  const r1 = await db.save({ agentId: 'agent-A', type: 'memory', content: { note: '第一次记忆' }, metadata: { source: 'test' } });
  check('save 返回 CID', /^bafy/.test(r1.id), r1.id);
  check('type/agentId 正确', r1.type === 'memory' && r1.agentId === 'agent-A');
  check('version=1', r1.version === 1);

  console.log('[2] load 按 CID 读回');
  const r2 = await db.load(r1.id);
  check('load 命中', !!r2 && r2.content.note === '第一次记忆');
  check('内容寻址 (同内容同 CID)', (await db.save({ agentId: 'agent-A', type: 'memory', content: { note: '第一次记忆' }, metadata: { source: 'test' } })).id === r1.id);

  console.log('[3] update → 版本链');
  const r3 = await db.update(r1.id, { note: '第二次记忆' });
  check('update 返回新版本', !!r3 && r3.version === 2 && r3.parentId === r1.id);
  const chain = await db.version(r3!.id);
  check('version 链 = [v1, v2]', chain.length === 2 && chain[0].version === 1 && chain[1].version === 2);

  console.log('[4] list 过滤');
  await db.save({ agentId: 'agent-B', type: 'state', content: { mode: 'idle' } });
  const mems = await db.list({ agentId: 'agent-A' });
  check('list agent-A = 2 条', mems.length === 2);
  const states = await db.list({ type: 'state' });
  check('list type=state = 1 条', states.length === 1);

  console.log('[5] share → 块进 helia blockstore → load 拉块解码');
  const shareRef = await db.share(r1.id);
  check('share 返回 bolloon-cid://', shareRef.startsWith('bolloon-cid://'));
  const remote = await (db as any).load(r1.id);
  check('share 后仍可 load', !!remote);

  console.log('[6] close');
  await db.close();
  check('close 无异常', true);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FAIL:', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });
