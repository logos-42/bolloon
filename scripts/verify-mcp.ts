/**
 * 验证脚本 (2026-08-03): bolloon MCP 适配器 — 配置发现 + 工具执行链路
 */
import { discoverMcpServers, initializeMcpAdapter, startServer, discoverTools, executeTool, getAdapterStatus } from '../src/pi-ecosystem-mcp/index.js';

async function main() {
  console.log('=== [1/4] MCP server 配置发现 (读 ~/.mcp.json) ===');
  const servers = await discoverMcpServers();
  console.log('发现 MCP servers:', JSON.stringify(servers, null, 2));
  if (servers.length === 0) {
    console.log('❌ 未发现任何 MCP server 配置');
    process.exit(1);
  }

  console.log('\n=== [2/4] 初始化适配器 + 启动 server 进程 ===');
  await initializeMcpAdapter();
  const status = getAdapterStatus();
  console.log('adapter status:', JSON.stringify(status));

  const started = await startServer('echo-mcp');
  console.log('startServer(echo-mcp):', started);
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n=== [3/4] 工具发现 (tools/list) ===');
  const tools = await discoverTools('echo-mcp');
  console.log('发现工具:', tools.map((t) => t.name).join(', '));

  console.log('\n=== [4/4] 工具执行 (tools/call) ===');
  const r1 = await executeTool('echo', { text: 'hello-from-bolloon' });
  console.log('echo 结果:', JSON.stringify(r1));
  const r2 = await executeTool('add', { a: 10, b: 32 });
  console.log('add 结果:', JSON.stringify(r2));

  console.log('\n=== 验证完成 ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
