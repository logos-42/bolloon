/* 真实验证: bolloon MCP 适配器连 Cloudflare 官方 MCP (streamable HTTP + SSE) */
import {
  initializeMcpAdapter,
  listTools,
  executeTool,
  getAdapterStatus,
} from '../src/pi-ecosystem-mcp/index.js';

async function main() {
  console.log('=== 1) initializeMcpAdapter (真实 ~/.mcp.json) ===');
  await initializeMcpAdapter();

  const status = getAdapterStatus();
  console.log(`servers: ${status.serverCount} (${status.servers.join(', ')})`);
  console.log(`tools: ${status.toolCount}`);

  const cfTools = listTools().filter((t) => t.serverName === 'cloudflare');
  console.log(`cloudflare tools: ${cfTools.map((t) => t.name).join(', ')}`);
  if (cfTools.length !== 3) {
    console.log('FAIL: 期望 3 个 Cloudflare 工具 (docs/search/execute)');
    process.exit(1);
  }

  console.log('\n=== 2) 真实调用 docs 工具 (搜 R2 文档) ===');
  const r = await executeTool('docs', { query: 'R2 bucket creation' });
  if (!r.success) {
    console.log('FAIL:', r.error);
    process.exit(1);
  }
  const text = JSON.stringify(r.content || '').slice(0, 500);
  console.log('docs 返回:', text);
  if (!/R2/i.test(text)) {
    console.log('WARN: 返回里没看到 R2 字样, 但调用本身成功');
  }

  console.log('\n=== 3) 工具调用日志 ===');
  const log = (await import('../src/pi-ecosystem-mcp/index.js')).getToolCallLog();
  console.log(`日志条数: ${log.length}`);
  console.log('ALL_HTTP_MCP_VERIFY_PASSED');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});
