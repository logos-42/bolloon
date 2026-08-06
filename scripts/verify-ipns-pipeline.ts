/**
 * verify-ipns-pipeline.ts — IPNS 发布管道最后一公里验证 (2026-08-06)
 *
 * 验证链: CID → IPNS resolve → index.html → assets → gateway 渲染
 *   ✓ CID exists (IPFS 上有内容)
 *   ✓ IPNS resolve (name → /ipfs/<CID>)
 *   ✓ index.html available (可读取, 相对路径资源引用)
 *   ✓ assets available (style.css / client.js 可读取)
 *   ✓ gateway render (本地 gateway HTTP 200 + HTML 完整)
 *
 * 用法: npx tsx scripts/verify-ipns-pipeline.ts [<ipns-name-or-cid>]
 * 无参数: 用默认 key 'ui-deploy' 验证最近一次发布
 */
import { IpfsClient } from '@diap/sdk';

const API = 'http://127.0.0.1:5001';
const GW = 'http://127.0.0.1:8080';
const DEFAULT_KEY = 'ui-deploy';

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

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
}

async function main() {
  const arg = process.argv[2]?.trim();
  console.log('=== Bolloon IPNS 发布管道验证 ===\n');

  // 1. 解析目标: 参数是 k51 name / CID / 空(用 ui-deploy key)
  let ipnsName = arg || '';
  if (!ipnsName) {
    try {
      const keys = await kubo('/api/v0/key/list');
      const k = (keys.Keys || []).find((x: any) => x.Name === DEFAULT_KEY);
      if (k) { ipnsName = k.Id; console.log(`[key] 用默认 key: ${DEFAULT_KEY} → ${k.Id.slice(0, 20)}...`); }
      else { ipnsName = 'self'; console.log(`[key] 无 ${DEFAULT_KEY}, 用 self`); }
    } catch { ipnsName = 'self'; }
  }
  console.log(`[目标] ${ipnsName}\n`);

  // 2. IPNS resolve → CID
  let cid = '';
  try {
    const r = await kubo(`/api/v0/name/resolve?arg=${encodeURIComponent(ipnsName)}&recursive=true&nocache=true`, 60000);
    cid = String(r.Path).replace(/^\/ipfs\//, '');
    check('IPNS resolve', !!cid && /^Qm|^bafy/.test(cid), `${ipnsName.slice(0, 20)}... → ${cid.slice(0, 30)}...`);
  } catch (e: any) {
    check('IPNS resolve', false, `失败: ${e.message}`);
    console.log('\n❌ 管道中断 (resolve 失败). 先发布: ipfs name publish /ipfs/<CID> --key=<key>');
    process.exit(1);
  }

  // 3. CID 存在性 (cat index.html)
  let html = '';
  try {
    html = await kubo(`/api/v0/cat?arg=${cid}/index.html`);
    check('CID exists + index.html', typeof html === 'string' && html.includes('<html'), `${html.length} 字符`);
  } catch (e: any) {
    // 兼容单文件 CID (无 index.html 子路径)
    try {
      html = await kubo(`/api/v0/cat?arg=${cid}`);
      check('CID exists (单文件)', typeof html === 'string' && html.length > 0, `${html.length} 字符`);
    } catch (e2: any) {
      check('CID exists', false, `cat 失败: ${e2.message}`);
      process.exit(1);
    }
  }

  // 4. 相对路径资源引用检查 (IPFS 发布必需)
  const relRefs = html.match(/(?:href|src)="\.\/[^"]+"/g) || [];
  const absRefs = html.match(/(?:href|src)="\/(?!api)[^"]+"/g) || [];
  check('资源相对路径', relRefs.length > 0, `${relRefs.length} 个相对引用${absRefs.length > 0 ? ` ⚠️ ${absRefs.length} 个绝对路径(可能 404): ${absRefs.slice(0, 3).join(' ')}` : ''}`);

  // 5. assets 可读取 (style.css + client.js)
  const assets = ['style.css', 'client.js'];
  for (const a of assets) {
    try {
      const data = await kubo(`/api/v0/cat?arg=${cid}/${a}`);
      check(`asset: ${a}`, typeof data === 'string' && data.length > 1000, `${data.length} bytes`);
    } catch {
      check(`asset: ${a}`, false, '不可读取');
    }
  }

  // 6. gateway 渲染 (本地 gateway)
  try {
    const resp = await fetch(`${GW}/ipns/${ipnsName}/`, { method: 'GET' });
    const text = await resp.text();
    check('gateway render', resp.status === 200 && text.includes('Bolloon Agent'), `HTTP ${resp.status}, ${text.length} 字符`);
  } catch (e: any) {
    check('gateway render', false, `gateway 不可达: ${e.message} (本地 Kubo gateway 需在 8080 运行)`);
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== 结果: ${passed}/${results.length} 通过 ===`);
  console.log(`CID: ${cid}`);
  console.log(`IPNS: ${ipnsName}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
