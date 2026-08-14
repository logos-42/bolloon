/**
 * verify-agent-gateway.ts — Agent Gateway 真实链路验证 (2026-08-14)
 *
 * 验证闭环: 注册服务 → shareNetworkLink 生成 orbitdb 链接 → joinNetwork(orbitdb://)
 *          (真实 openStoreByAddress 复制) → 自动加入 (maybeAutoJoinGateway) → 幂等 → 重启恢复.
 *
 * 运行: npx tsx scripts/verify-agent-gateway.ts
 * 说明: 使用隔离 HOME (tmp), 不污染真实 ~/.bolloon; 真实 OrbitDB 节点 (helia).
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getAgentRegistry, resetAgentRegistry } from '../src/agents/agent-registry.js';
import { gatewayRegisterAgent, gatewayStatus } from '../src/agents/agent-gateway.js';
import {
  parseNetworkLink,
  detectGatewayLink,
  joinNetwork,
  maybeAutoJoinGateway,
  listJoinedNetworks,
  shareNetworkLink,
  restoreJoinedNetworks,
} from '../src/agents/gateway-network.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-gw-verify-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

async function main() {
  // 隔离 home (gateway-networks.json + agent-registry.json 落 tmp)
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  await fs.mkdir(fakeHome, { recursive: true });
  resetAgentRegistry();
  console.log('=== Agent Gateway 真实链路验证 ===\n');

  // [1] 注册服务 (真实 OrbitDB registry, warm)
  console.log('[1] 注册服务 → 生成本机分享链接');
  const reg = getAgentRegistry();
  const r1 = await gatewayRegisterAgent(
    { capability: 'research', price: '0.05', per: 'query', description: '验证用研究服务' },
    { did: 'did:diap:verify-node', name: 'Verify Node', wallet: '0xverify' },
  );
  check('gatewayRegisterAgent ok', r1.ok, JSON.stringify(r1));
  const { warmAgentRegistry } = await import('../src/agents/agent-registry.js');
  await warmAgentRegistry(); // gatewayRegisterAgent 内部已 warm, 这里显式等待确保 ready
  check('registry OrbitDB ready', reg.ready);
  check('registry storeAddress 非空', !!reg.storeAddress, reg.storeAddress);

  const share = await shareNetworkLink({ name: 'verify-network' });
  check('shareNetworkLink 生成 orbitdb 链接', share.ok, share.error || '');
  check('链接格式 orbitdb://', share.link?.startsWith('orbitdb://'), share.link || '');
  console.log(`    link: ${share.link}`);

  // [2] 链接解析 (纯函数)
  console.log('\n[2] 链接解析 + 检测');
  const parsed = parseNetworkLink(share.link!);
  check('parseNetworkLink kind=orbitdb', parsed?.kind === 'orbitdb');
  check('parseNetworkLink networkName=verify-network', parsed?.networkName === 'verify-network');
  const detected = detectGatewayLink(`来我们网络: ${share.link} 一起干活`);
  check('detectGatewayLink 从文本找到链接', detected === share.link, detected || '');
  check('detectGatewayLink 无链接返回 null', detectGatewayLink('普通消息') === null);

  // [3] 真实 joinNetwork (orbitdb:// → openStoreByAddress 复制)
  console.log('\n[3] joinNetwork(orbitdb://) 真实复制');
  const j = await joinNetwork(share.link!);
  check('joinNetwork ok', j.ok, j.error || '');
  check('joinNetwork 拉到 1 个服务', j.total === 1, `total=${j.total}`);
  check('joinNetwork linkKind=orbitdb', j.linkKind === 'orbitdb');

  // [4] 幂等
  console.log('\n[4] 幂等 (重复加入)');
  const j2 = await joinNetwork(share.link!);
  check('再次加入 already=true', j2.already === true, JSON.stringify(j2));

  // [5] 自动加入 (消息触发)
  console.log('\n[5] maybeAutoJoinGateway (消息自动加入)');
  const note = await maybeAutoJoinGateway(`我收到一个网络邀请: ${share.link}`);
  check('已在网络 → 静默 (null)', note === null, note || '');
  // 用新网络 (不同 did → 不同 store) 再验证一次通知
  const { OrbitDBAgentRegistry } = await import('../src/agents/agent-registry.js');
  const reg2 = new OrbitDBAgentRegistry('did:other-node', undefined as any, path.join(fakeHome, '.bolloon', 'agent-registry-2.json'));
  await reg2.warm();
  await reg2.register({
    agentId: 'did:diap:other1', name: 'Other', wallet: '0xo',
    service: { name: 'coding', description: 'c', price: { amount: '0.1', currency: 'USDC', per: 'task' } },
  } as any);
  const share2 = await shareNetworkLink({ name: 'second-net', registry: reg2 });
  check('第二个网络链接生成', share2.ok, share2.error || '');
  const note2 = await maybeAutoJoinGateway(`加入: ${share2.link}`);
  check('新网络 → 自动加入通知', note2?.includes('已自动加入'), note2 || '');

  // [6] 状态 + 成员
  console.log('\n[6] 状态与成员');
  const status = await gatewayStatus();
  check('gatewayStatus 含 research 服务', status.includes('research'));
  const nets = await listJoinedNetworks();
  check('成员 2 个网络 (同 store 幂等 key 合并?)', nets.length >= 1, `nets=${nets.length}`);
  for (const n of nets) console.log(`    [${n.kind}] ${n.name || n.link.slice(0, 40)} (${n.serviceCount} 服务)`);

  // [7] 重启恢复
  console.log('\n[7] restoreJoinedNetworks (重启恢复)');
  resetAgentRegistry(); // 模拟重启 (新单例)
  const restore = await restoreJoinedNetworks();
  check('恢复统计 restored>=1', restore.restored >= 1, JSON.stringify(restore));
  const status2 = await gatewayStatus();
  check('恢复后 registry 有服务', status2.includes('research'));

  // [8] P2P 群组 (微信式群聊, 真实 OrbitDB events store write:'*')
  console.log('\n[8] P2P 群组 (微信群聊式)');
  const { createGroup, joinGroup, groupSend, groupMessages, groupMembers, listGroups, groupInfo, restoreGroups } =
    await import('../src/agents/gateway-group.js');
  const g = await createGroup('验证群', { from: 'did:diap:verify-node' });
  check('createGroup ok', g.ok, g.error || '');
  check('群组链接含 type=group', g.group?.link.includes('type=group'), g.group?.link || '');
  const snd = await groupSend(g.group!.id, '你好, 我是验证节点', 'did:diap:verify-node');
  check('groupSend ok', snd.ok, snd.error || '');
  const gmsgs = await groupMessages(g.group!.id);
  check('群消息读回', gmsgs.some((m) => m.text.includes('验证节点')), JSON.stringify(gmsgs.slice(-2)));
  const jg = await joinGroup(g.group!.link);
  check('joinGroup 幂等 (already)', jg.already === true, JSON.stringify(jg));
  const members = await groupMembers(g.group!.id);
  check('群成员含 verify-node', members.includes('did:diap:verify-node'), JSON.stringify(members));
  const gi = await groupInfo(g.group!.id);
  check('groupInfo 消息数>=2 (欢迎+1)', (gi?.messageCount ?? 0) >= 2, JSON.stringify(gi));
  const gl = await listGroups();
  check('listGroups >= 1', gl.length >= 1, `groups=${gl.length}`);
  const rg = await restoreGroups();
  check('restoreGroups 恢复', rg.restored >= 1, JSON.stringify(rg));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
