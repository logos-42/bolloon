/**
 * 验证 IPFS/IPNS agent 工具 (2026-08-04):
 * ipfs_add → ipfs_cat → ipfs_ls → ipns_publish → ipns_resolve 全链路
 * 用法: npx tsx scripts/verify-ipfs-tools.ts
 */
import { registerBuiltinTools } from '../src/agents/pi-sdk-tools.js';

async function main() {
  const tools = new Map();
  const ctx: any = { tools, agentId: 'verify-agent' };
  registerBuiltinTools(ctx);

  const names = ['ipfs_add', 'ipfs_cat', 'ipfs_ls', 'ipns_publish', 'ipns_resolve'];
  const missing = names.filter((n) => !tools.has(n));
  if (missing.length > 0) {
    console.log(`FAIL: 缺少工具 ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`OK: 5 个工具已注册 (${names.join(', ')})`);

  const run = async (name: string, args: any) => {
    const t = tools.get(name);
    console.log(`\n── ${name}(${JSON.stringify(args)}) ──`);
    const r = await t.execute(args);
    console.log(r.success ? r.output : `ERR: ${r.error}`);
    return r;
  };

  // 1. 上传
  const payload = `Bolloon IPFS 工具验证 ${new Date().toISOString()}\nline2 hello ipfs`;
  const add = await run('ipfs_add', { content: payload, name: 'verify.txt' });
  if (!add.success) process.exit(1);
  const cid = add.output.match(/CID: ([a-zA-Z0-9]+)/)?.[1];
  if (!cid) { console.log('FAIL: 未解析出 CID'); process.exit(1); }

  // 2. 读回
  const cat = await run('ipfs_cat', { cid });
  if (!cat.success || !cat.output.includes('hello ipfs')) { console.log('FAIL: cat 读回不一致'); process.exit(1); }

  // 3. 列目录 (单个文件, 期望 1 项)
  await run('ipfs_ls', { cid });

  // 4. IPNS 发布 (每次用新 key, 避开同 key 重发布的缓存延迟)
  const keyName = `verify-${Date.now()}`;
  const pub = await run('ipns_publish', { cid, keyName });
  if (!pub.success) process.exit(1);
  const ipnsName = pub.output.match(/name: (k51[a-zA-Z0-9]+)/)?.[1];
  if (!ipnsName) { console.log('FAIL: 未解析出 IPNS name'); process.exit(1); }

  // 5. IPNS 解析
  const res = await run('ipns_resolve', { name: ipnsName });
  if (!res.success || !res.output.includes(cid)) { console.log('FAIL: resolve 未回到原 CID'); process.exit(1); }

  console.log('\n✅ 全链路通过: add → cat → ls → publish → resolve');
  process.exit(0);
}

main().catch((e) => { console.error('脚本失败:', e); process.exit(1); });
