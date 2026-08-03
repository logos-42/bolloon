import { initializeMcpAdapter, listTools, getAdapterStatus, executeTool } from '../src/pi-ecosystem-mcp/index.js';

async function main() {
  console.log('=== initializeMcpAdapter ===');
  await initializeMcpAdapter();
  console.log('status:', JSON.stringify(getAdapterStatus()));
  console.log('tools:', listTools().map((t) => t.name));
  if (listTools().length === 0) {
    console.log('❌ 工具未注册 — connectAndDiscover 失败');
    process.exit(1);
  }
  console.log('\n=== executeTool(echo) ===');
  const r = await executeTool('echo', { text: 'hello-from-bolloon' });
  console.log(JSON.stringify(r));
  const r2 = await executeTool('add', { a: 10, b: 32 });
  console.log(JSON.stringify(r2));
  process.exit(0);
}
main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
