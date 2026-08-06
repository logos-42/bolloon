/** 临时验证 v2: 只依赖轻量模块 */
import { llmConfigStore, PROVIDER_INFO } from '../src/llm/config-store.js';

async function kuboApiDirect(pathAndQuery: string): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:5001${pathAndQuery}`, { method: 'POST' });
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('application/json') ? resp.json() : resp.text();
}

async function main() {
  // 1. /ipfs 数据 (等价 kuboApi)
  const id = await kuboApiDirect('/api/v0/id');
  const peers = await kuboApiDirect('/api/v0/swarm/peers');
  console.log('[ipfs] version:', (id as any).AgentVersion, '| peers:', (peers as any)?.Peers?.length);

  // 2. /ipns 数据
  const keys = await kuboApiDirect('/api/v0/key/list');
  console.log('[ipns] keys:', (keys as any)?.Keys?.length);

  // 3. /model picker 数据
  await llmConfigStore.initialize();
  const config = await llmConfigStore.getConfig();
  const items = Object.entries(config.providers).map(([name, p]) => ({
    kind: 'command',
    label: name,
    hint: `${String((PROVIDER_INFO as any)[name]?.name || '').padEnd(14)} ${p.apiKey ? '🔑' : p.requiresApiKey ? '⚠ 无key' : ''}  ${p.model || ''}`,
    insert: name,
  }));
  console.log('[picker] items:', items.length, '→', items.slice(0, 3).map(i => `${i.label} ${i.hint}`).join(' | '));

  // 4. /loop + /now token 估算
  const { estimateTokens } = await import('../src/context-compaction/index.js');
  const h = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀'.repeat(10) }];
  console.log('[loop] estimateTokens:', estimateTokens(h));

  // 5. /memory + /resume 数据
  const { getMemoryDir } = await import('../src/bootstrap/memory-compressor.js');
  const { readdir } = await import('fs/promises');
  const { join } = await import('path');
  const dir = getMemoryDir('agent');
  const files = (await readdir(join(dir, 'sessions')).catch(() => [])).filter((f: string) => f.endsWith('.summary.md'));
  console.log('[memory] summary files:', files.length, files.slice(-2).map(f => f.slice(0, 30)).join(' | '));

  // 6. /goal 数据
  const { listActivePlans } = await import('../src/agents/plan-store.js');
  const plans = await listActivePlans();
  console.log('[goal] active plans:', plans.length, plans.slice(0, 2).map((p: any) => p.goal || p.planId).join(' | '));

  // 7. /judgement 数据
  const { loadAllJudgments } = await import('../src/pi-ecosystem-judgment/human-value-store.js');
  const all = await loadAllJudgments().catch(() => []);
  console.log('[judgement] count:', all.length);

  console.log('\n✅ 全部命令数据源 OK');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
