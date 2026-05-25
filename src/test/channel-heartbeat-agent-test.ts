/**
 * Channel Heartbeat Agent Test
 *
 * 测试场景：
 * 1. Heartbeat Agent 自动发现和解析 DiapDoc
 * 2. 自动心跳发布 persona 到 IPFS
 * 3. 基于判断力的 Harness 调用
 * 4. 多智能体自动对话
 *
 * 运行: npx tsx src/test/channel-heartbeat-agent-test.ts
 */

import { config } from 'dotenv';
import { createHeartbeatAgent, ChannelHeartbeatAgent, HeartbeatAgentRegistry } from '../social/channels/channel-heartbeat-agent.js';
import { createDiapDocParser } from '../social/channels/diap-doc-parser.js';

config();

const PORT_ALICE = 9001;
const PORT_BOB = 9002;

async function testDiapDocParser() {
  console.log('\n========================================');
  console.log('  DiapDoc Parser 测试');
  console.log('========================================\n');

  const parser = createDiapDocParser();

  // 测试标准 DiapDoc
  const standardDoc = {
    id: 'did:key:z6MkhaXqE2qVYVJ5V5Z7Z8Z9Z0Z1Z2Z3Z4Z5Z6Z7Z8Z9Z0Z',
    name: 'TestAgent',
    version: '1.0',
    capabilities: ['对话', '分析', '协作'],
    interests: ['AI', '编程'],
    peerId: 'QmTestPeer123',
    channels: [
      { id: 'ch_001', name: 'AI Discussion', topic: 'AI技术讨论' },
      { id: 'ch_002', name: 'Coding Help', topic: '编程帮助' }
    ]
  };

  const result = parser.parse(JSON.stringify(standardDoc));

  if (result.success && result.doc) {
    console.log('✅ 解析成功');
    console.log(`  ID: ${result.doc.id}`);
    console.log(`  Name: ${result.doc.name}`);
    console.log(`  Capabilities: ${result.doc.capabilities.join(', ')}`);
    console.log(`  Channels: ${result.doc.channels?.map(c => c.name).join(', ')}`);
  } else {
    console.log('❌ 解析失败:', result.error);
  }

  // 测试兼容性格式
  const compatDoc = {
    did: 'did:key:zCompatibleDoc',
    name: 'CompatibleAgent',
    capability: ['代码审查', '架构设计'],
    interest: ['软件开发'],
    peer_id: 'QmCompatPeer',
    channel: [
      { channelId: 'ch_comp_001', channelName: 'Dev Chat' }
    ]
  };

  const compatResult = parser.parse(JSON.stringify(compatDoc));

  if (compatResult.success && compatResult.doc) {
    console.log('\n✅ 兼容性格式解析成功');
    console.log(`  ID: ${compatResult.doc.id}`);
    console.log(`  Capabilities: ${compatResult.doc.capabilities.join(', ')}`);
  } else {
    console.log('\n❌ 兼容性解析失败:', compatResult.error);
  }

  console.log('\n========================================\n');
}

async function testHeartbeatAgent() {
  console.log('\n========================================');
  console.log('  Heartbeat Agent 测试');
  console.log('========================================\n');

  const registry = new HeartbeatAgentRegistry();

  // 创建 Alice
  const alice = createHeartbeatAgent({
    name: 'Alice',
    port: PORT_ALICE,
    autoDiscovery: true,
    autoDialogue: false,
    capabilities: ['架构设计', '代码审查']
  });

  // 创建 Bob
  const bob = createHeartbeatAgent({
    name: 'Bob',
    port: PORT_BOB,
    autoDiscovery: true,
    autoDialogue: false,
    capabilities: ['代码编写', '调试']
  });

  // 注册
  registry.register(alice);
  registry.register(bob);

  // 启动
  await alice.start();
  await bob.start();

  console.log('━━━ 模拟发现流程 ━━━\n');

  // 模拟 Alice 发现 Bob
  const announcement = {
    leaderDid: bob.getDid(),
    channelName: 'Bob 的频道',
    channelId: 'ch_bob_001',
    topic: '开发协作',
    capabilities: ['代码编写', '调试'],
    interests: ['编程', '架构']
  };

  alice.handleChannelAnnouncement(announcement);
  console.log(`[Alice] 发现 Bob，存储到已发现列表`);

  // 获取 Bob 的信息
  const alicePeers = alice.getDiscoveredPeers();
  console.log(`\n[Alice] 已发现 ${alicePeers.length} 个对等节点:`);
  for (const peer of alicePeers) {
    console.log(`  - ${peer.name} (${peer.did.substring(0, 20)}...)`);
    console.log(`    Capabilities: ${peer.capabilities.join(', ')}`);
  }

  // 测试对话
  console.log('\n━━━ 对话测试 ━━━\n');

  const dialogueScript = [
    { from: 'Alice', to: 'Bob', content: 'Bob，我们设计一个新的用户认证系统。' },
    { from: 'Bob', to: 'Alice', content: '好的，需要哪些功能？' },
    { from: 'Alice', to: 'Bob', content: '登录、注册、找回密码，还要支持社交登录。' },
    { from: 'Bob', to: 'Alice', content: '明白了。安全性要求高吗？' },
    { from: 'Alice', to: 'Bob', content: '需要处理金融数据，安全很重要。帮我分析一下架构设计。' },
    { from: 'Bob', to: 'Alice', content: '好的，我来检查架构设计。' },
    { from: 'Alice', to: 'Bob', content: '架构不错。帮我 review 代码。' },
    { from: 'Bob', to: 'Alice', content: '代码审查完成，需要优化错误处理。' },
    { from: 'Alice', to: 'Bob', content: '好的，现在分解任务。' },
    { from: 'Bob', to: 'Alice', content: '任务已分解为 4 个子任务。' }
  ];

  let harnessCallCount = 0;
  const gateStats = new Map<number, number>();

  for (let i = 0; i < dialogueScript.length; i++) {
    const { from, to, content } = dialogueScript[i];
    const targetAgent = from === 'Alice' ? bob : alice;

    console.log(`[${from}] >>> ${content}`);

    const result = await targetAgent.handleMessage(
      from === 'Alice' ? alice.getDid() : bob.getDid(),
      from,
      content
    );

    console.log(`[${to}] 处理结果:`);
    if (result.harnessCalled) {
      console.log(`   🧠 调用 Harness: Gate ${result.gate}`);
      harnessCallCount++;
      gateStats.set(result.gate!, (gateStats.get(result.gate!) || 0) + 1);
    } else {
      console.log(`   🧠 普通回复`);
    }
    console.log(`   📤 ${result.response.substring(0, 60)}...`);
    console.log('');

    await new Promise(r => setTimeout(r, 200));
  }

  // 结果汇总
  console.log('━━━ 结果汇总 ━━━\n');
  console.log(`Harness 调用次数: ${harnessCallCount}`);
  console.log('\nGate 统计:');
  for (const [gate, count] of Array.from(gateStats.entries()).sort((a, b) => a[0] - b[0])) {
    const gateNames: Record<number, string> = {
      1: '架构设计', 2: '代码审查', 4: '安全检查',
      5: '任务分解', 7: '代码实现', 8: '测试验证'
    };
    console.log(`  Gate ${gate} (${gateNames[gate] || '未知'}): ${count} 次`);
  }

  const success = harnessCallCount >= 3;
  console.log(`\n${success ? '✅' : '⚠️'} ${success ? '测试成功' : '测试部分成功'}`);

  // 清理
  registry.clear();

  console.log('\n========================================\n');

  return success;
}

async function testAutoHeartbeat() {
  console.log('\n========================================');
  console.log('  自动心跳测试');
  console.log('========================================\n');

  const agent = createHeartbeatAgent({
    name: 'AutoHeartbeatTest',
    port: 9010,
    autoDiscovery: true,
    autoDialogue: false
  });

  await agent.start();
  console.log(`[${agent.getName()}] 已启动`);
  console.log(`  DID: ${agent.getDid()}`);
  console.log(`  CID: ${agent.getOwnCID() || 'N/A'}`);

  // 等待几个心跳周期
  console.log('\n等待自动心跳...');
  await new Promise(r => setTimeout(r, 5000));

  const peers = agent.getDiscoveredPeers();
  console.log(`\n发现的对等节点: ${peers.length}`);

  agent.stop();
  console.log('\n========================================\n');
}

async function main() {
  try {
    await testDiapDocParser();
    await testHeartbeatAgent();
    await testAutoHeartbeat();
    process.exit(0);
  } catch (err) {
    console.error('测试失败:', err);
    process.exit(1);
  }
}

main();