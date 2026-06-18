/**
 * 测试 pi-sdk agent 跑 shell_exec 工具的完整路径
 * 看是不是 pre-tool hook 拦截导致 result 是空
 */

import { createAgentSession } from '../src/agents/pi-sdk.js';

async function main() {
  const agent = await createAgentSession({
    cwd: process.cwd(),
    peerId: 'test-agent-' + Date.now(),
  });
  console.log('[TEST] agent created, cwd:', process.cwd());
  console.log('[TEST] tool count:', (agent as any).tools?.size);
  console.log('[TEST] available tools:', Array.from((agent as any).tools?.keys() || []).join(', '));

  const result = await (agent as any).prompt('用 shell_exec 跑 pwd 命令, 把命令输出的 stdout 完整告诉我. 不要理论, 直接调用工具. timeoutMs=5000.');
  console.log('\n[TEST] agent reply:', result?.substring(0, 1000));
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });