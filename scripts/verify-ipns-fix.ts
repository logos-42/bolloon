/**
 * verify-ipns-fix.ts — IPNS 修复端到端验证 (2026-08-06)
 *
 * 验证链: add → cat → publish → resolve(nocache) → cat via ipns
 * 重点验证修复:
 *   1. resolve 带 nocache=true 返回新 CID (不再缓存旧值)
 *   2. publish 用确定性 key 名 (非 [object Object])
 *   3. 内容回读
 */
import { IpfsClient } from '@diap/sdk';

const API = 'http://127.0.0.1:5001';
const GW = 'http://127.0.0.1:8080';

async function kubo(pathAndQuery: string, timeoutMs = 30000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API}${pathAndQuery}`, { method: 'POST', signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp.text();
  } finally { clearTimeout(t); }
}

async function main() {
  console.log('=== [1] 上传内容 → CID ===');
  const ipfs = await IpfsClient.newWithRemoteNode(API, GW);
  const content = `ipns-fix-verify-${Date.now()}`;
  const up = await ipfs.upload(content, 'verify-data');
  console.log(`CID: ${up.cid}`);

  console.log('\n=== [2] cat 回读 ===');
  const back = await kubo(`/api/v0/cat?arg=${up.cid}`);
  console.log(`内容: ${JSON.stringify(back)} (匹配=${back === content})`);

  console.log('\n=== [3] IPNS 发布 (确定性 key 名: verify-fix-key) ===');
  const keyName = 'verify-fix-key';
  await ipfs.ensureKeyExists(keyName);
  const pub = await ipfs.publishIpns(up.cid, keyName, '8760h', '1h');
  console.log(`name: ${pub.name}\nvalue: ${pub.value}`);

  console.log('\n=== [4] resolve 无 nocache (老行为, 可能缓存旧值) ===');
  try {
    const r1 = await kubo(`/api/v0/name/resolve?arg=/ipns/${pub.name}`);
    console.log(`→ ${r1.Path}`);
  } catch (e) { console.log(`→ (无缓存记录, 正常)`); }

  console.log('\n=== [5] resolve 带 nocache=true (修复后行为, 应返回新 CID) ===');
  const r2 = await kubo(`/api/v0/name/resolve?arg=/ipns/${pub.name}&recursive=true&nocache=true`, 60000);
  const resolvedCid = String(r2.Path).replace(/^\/ipfs\//, '');
  console.log(`→ ${r2.Path} (匹配新 CID=${resolvedCid === up.cid})`);

  console.log('\n=== [6] cat via /ipns/<name> ===');
  const viaIpns = await kubo(`/api/v0/cat?arg=/ipns/${pub.name}`);
  console.log(`内容: ${JSON.stringify(viaIpns)} (匹配=${viaIpns === content})`);

  console.log('\n=== [7] 验证 key 名不是 [object Object] ===');
  const keys = await kubo('/api/v0/key/list');
  const badKey = (keys.Keys || []).find((k: any) => k.Name === '[object Object]');
  console.log(`[object Object] key 存在: ${!!badKey} (修复后 publish 不再产生)`);

  const allOk = back === content && resolvedCid === up.cid && viaIpns === content;
  console.log(`\n${allOk ? '✅ 全部通过' : '❌ 有失败'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
