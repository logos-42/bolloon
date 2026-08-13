/**
 * verify-agent-economy.ts — Agent Economic Network 全链路验证 (2026-08-13)
 *
 * 验证闭环: Registry 注册 → discover → service_call → x402 402 检测 → Policy 授权 → reputation 更新.
 *
 * 说明: 真实链上支付需要 funded 钱包 + RPC; 本脚本验证 402 协商/策略/信誉的完整逻辑链
 *       (serviceCall 无 privateKey 时走 402 检测路径).
 *
 * 运行: npx tsx scripts/verify-agent-economy.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OrbitDBAgentRegistry } from '../src/agents/agent-registry.js';
import { serviceCall, buildPaymentRequiredResponse } from '../src/agents/agent-service-client.js';
import { LocalEconomicPolicy } from '../src/agents/economic-policy.js';
import { recordServiceOutcome, queryReputation } from '../src/agents/agent-reputation.js';

const tmp = path.join(os.tmpdir(), 'bolloon-econ-verify-' + Date.now());
const localFile = path.join(tmp, 'registry.json');
const policyFile = path.join(tmp, 'policy.json');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

async function main() {
  console.log('=== Agent Economic Network 全链路验证 ===\n');

  // 1. Registry: 注册服务
  console.log('[1] Registry 注册');
  const reg = new OrbitDBAgentRegistry('did:verify', undefined as any, localFile);
  // 注册直接走本地 (不 warm OrbitDB, 验证本地 fallback)
  await fs.mkdir(tmp, { recursive: true });
  const svc = {
    agentId: 'did:diap:research1',
    name: 'Research Agent',
    wallet: '0xabc123def456',
    service: { name: 'research', description: '资料检索与研究', price: { amount: '0.05', currency: 'USDC', per: 'query' } },
    capabilities: ['research', 'data'],
  };
  const r1 = await reg.register(svc as any);
  check('register ok', r1.ok);

  // 2. discover
  console.log('\n[2] Registry 发现');
  const found = await reg.discover('research');
  check('discover 找到 research', found.length === 1);
  check('定价 0.05 USDC/query', found[0]?.service?.price?.amount === '0.05');

  // 3. 402 响应生成 (provider 侧)
  console.log('\n[3] provider 402 响应 (基于 Registry 价格)');
  const resp402 = await buildPaymentRequiredResponse('did:diap:research1', 'research', reg);
  check('402 status', resp402.status === 402);
  check('价格头 X-Payment-Amount=0.05', resp402.headers['X-Payment-Amount'] === '0.05');
  check('收款头 X-Pay-To', resp402.headers['X-Pay-To'] === '0xabc123def456');
  check('body 含 Payment Required', resp402.body.includes('Payment Required'));

  // 4. service_call 无私钥 → 402 检测
  console.log('\n[4] service_call (buyer, 无私钥 → 402 检测)');
  const call1 = await serviceCall({ serviceName: 'research', url: 'https://svc.example.com/research', registry: reg });
  // 服务端点不存在/网络错误 → 失败但服务解析成功
  check('service 解析成功', call1.service?.agentId === 'did:diap:research1');
  check('调用失败 (无网络端点/需支付)', call1.success === false);

  // 5. Policy Engine: 授权检查
  console.log('\n[5] Policy Engine (预算/白名单)');
  const policy = new LocalEconomicPolicy(policyFile);
  await policy.load();
  policy.updateConfig({ perTransactionLimit: 0.1, dailyLimit: 0.1, allowedServices: ['research'] });
  // 服务 $0.05 < 单笔 $0.1 → 允许
  const d1 = await policy.check({ payTo: '0xabc123def456', amount: 0.05, service: 'research' });
  check('小额 research 授权通过', d1.allowed === true);
  // 超单笔 → 拒绝
  const d2 = await policy.check({ payTo: '0xabc123def456', amount: 5, service: 'research' });
  check('超单笔拒绝', d2.allowed === false);
  // 未授权服务 → 拒绝
  policy.updateConfig({ allowedServices: ['research'] });
  const d3 = await policy.check({ payTo: '0xabc123def456', amount: 0.05, service: 'coding' });
  check('未授权服务拒绝', d3.allowed === false);
  // 日预算耗尽 → 冻结
  await policy.recordSpend(0.1);
  const d4 = await policy.check({ payTo: '0xabc123def456', amount: 0.05, service: 'research' });
  check('日预算冻结', d4.allowed === false);

  // 6. Reputation: 结果记录
  console.log('\n[6] Reputation (服务结算后)');
  const rep1 = await recordServiceOutcome('did:diap:research1', 'research', 'success', reg);
  check('success 记录 ok', rep1.ok === true);
  await recordServiceOutcome('did:diap:research1', 'research', 'success', reg);
  await recordServiceOutcome('did:diap:research1', 'research', 'failed', reg);
  const q = await queryReputation('did:diap:research1', 'research', reg);
  check('3 任务记录', q.entries[0]?.reputation?.tasks === 3);
  check('score = 2/3', Math.abs((q.entries[0]?.reputation?.score ?? 0) - 2 / 3) < 0.01);

  // 7. 持久化
  console.log('\n[7] 持久化 (registry 本地 fallback)');
  const reg2 = new OrbitDBAgentRegistry('did:verify', undefined as any, localFile);
  const again = await reg2.list();
  check('重启后服务仍在', again.length === 1);

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
