/**
 * 验证 Web 上网工具 (2026-08-04): fetch_url + web_search 真实可用
 * 用法: npx tsx scripts/verify-web-tools.ts
 */
import { registerBuiltinTools } from '../src/agents/pi-sdk-tools.js';

async function main() {
  const tools = new Map();
  const ctx: any = { tools, agentId: 'verify-web', cwd: process.cwd() };
  registerBuiltinTools(ctx);

  const missing = ['fetch_url', 'web_search'].filter((n) => !tools.has(n));
  if (missing.length) { console.log(`FAIL: 缺 ${missing.join(',')}`); process.exit(1); }
  console.log('OK: fetch_url + web_search 已注册');

  // fetch_url: 抓 example.com
  const f = await tools.get('fetch_url').execute({ url: 'https://example.com/' });
  console.log(f.success ? `fetch_url OK: ${f.output.slice(0, 120)}` : `fetch_url FAIL: ${f.error}`);

  // web_search: 搜索 bolloon
  const s = await tools.get('web_search').execute({ query: 'bolloon agent p2p' });
  console.log(s.success ? `web_search OK: ${s.output.slice(0, 200)}` : `web_search FAIL: ${s.error}`);

  if (!f.success || !s.success) process.exit(1);
  console.log('\n✅ 上网工具验证通过');
  process.exit(0);
}

main().catch((e) => { console.error('脚本失败:', e); process.exit(1); });
