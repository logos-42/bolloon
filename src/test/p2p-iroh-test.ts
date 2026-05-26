/**
 * P2P iroh 测试 - 通过 CID 解析 DID 文档并使用 iroh 建立连接
 *
 * 流程:
 * 1. 生成 DID → 发布到 IPFS → 获得 CID
 * 2. 通过 CID 从 IPFS 解析 DID 文档
 * 3. 使用 iroh 直接通过 Node ID 连接
 */

import crypto from 'node:crypto';
import { KeyManager, AgentAuthManager } from '@diap/sdk';
import { irohTransport } from '../network/iroh-transport.js';
import { initIrohIntegration, getIrohIntegration } from '../network/iroh-integration.js';

const IPFS_ENDPOINT = 'http://127.0.0.1:5001';

interface AgentInfo {
  did: string;
  name: string;
  cid: string;
  irohNodeId: string;
}

// ============================================================
// 步骤 1: 发布 DID 到 IPFS
// ============================================================
async function publishDIDToIPFS(name: string): Promise<AgentInfo> {
  console.log('\n[步骤 1] 发布 DID 到 IPFS...');

  // 生成 DID
  const keyPair = KeyManager.generate();
  const did = keyPair.did;
  console.log(`  ✅ DID 生成: ${did}`);

  // 获取已有的 iroh Node ID
  const irohNodeId = irohTransport.getNodeId();
  console.log(`  ✅ iroh 节点 ID: ${irohNodeId}`);

  // 发布 DID 到 IPFS（使用 AgentAuthManager）
  const authManager = await AgentAuthManager.newWithRemoteIpfs(IPFS_ENDPOINT, IPFS_ENDPOINT);
  const result = await authManager.registerAgent({ name, services: [] }, keyPair, '');

  console.log(`  ✅ IPFS CID: ${result.cid}`);

  return {
    did,
    name,
    cid: result.cid || '',
    irohNodeId: irohNodeId || '',
  };
}

// ============================================================
// 步骤 2: 从 CID 解析 DID 文档
// ============================================================
async function resolveDIDFromIPFS(cid: string): Promise<{ did: string; name: string } | null> {
  console.log('\n[步骤 2] 从 IPFS 解析 DID 文档...');

  try {
    // 直接使用 fetch 获取
    const response = await fetch(`${IPFS_ENDPOINT}/api/v0/cat?arg=${cid}`, {
      method: 'POST'
    });
    const content = await response.text();
    const doc = JSON.parse(content);

    console.log(`  ✅ DID 文档解析成功`);
    console.log(`     DID: ${doc.id}`);
    console.log(`     名称: ${doc.name || 'N/A'}`);

    return {
      did: doc.id,
      name: doc.name || 'Unknown',
    };
  } catch (e) {
    console.log(`  ❌ 解析失败: ${(e as Error).message}`);
    return null;
  }
}

// ============================================================
// 步骤 3: 通过 iroh 连接并发送消息
// ============================================================
async function connectAndMessage(targetNodeId: string, message: string): Promise<void> {
  console.log('\n[步骤 3] 通过 iroh 发送消息...');
  console.log(`  📤 目标节点: ${targetNodeId.substring(0, 20)}...`);
  console.log(`  📝 消息: ${message}`);

  const success = await irohTransport.sendMessage(
    targetNodeId,
    'chat',
    new TextEncoder().encode(message)
  );

  if (success) {
    console.log('  ✅ 消息发送成功');
  } else {
    console.log('  ⚠️  消息发送失败（对方可能不在线）');
  }
}

// ============================================================
// 接收消息处理
// ============================================================
function setupMessageHandler() {
  console.log('\n[监听] 设置消息处理器...');

  irohTransport.onMessage('chat', (msg) => {
    const content = new TextDecoder().decode(msg.payload);
    console.log(`\n  💬 收到消息 from ${msg.from.substring(0, 12)}...: ${content}`);

    // 回复
    const reply = `ACK: 已收到 "${content.substring(0, 30)}..."`;
    irohTransport.sendMessage(msg.from, 'chat', new TextEncoder().encode(reply));
    console.log(`  📤 发送回复: ${reply}`);
  });

  irohTransport.onMessage('*', (msg) => {
    console.log(`\n  📩 收到未知类型消息 [${msg.type}] from ${msg.from.substring(0, 12)}...`);
  });

  console.log('  ✅ 消息处理器已设置');
}

// ============================================================
// 主测试流程
// ============================================================
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     P2P iroh 测试 - CID 解析 + 直接 Node ID 连接        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const isPublisher = args.includes('--publish');
  const targetCid = args.find(a => a.startsWith('--cid='))?.split('=')[1];
  const targetNodeId = args.find(a => a.startsWith('--node='))?.split('=')[1];
  const testMessage = args.find(a => a.startsWith('--msg='))?.split('=')[1] || 'Hello from iroh!';

  // 初始化 iroh（所有模式都需要）
  console.log('\n[初始化] 启动 iroh transport...');
  try {
    await irohTransport.start(undefined, false);
    console.log('  ✅ iroh transport 已启动');
  } catch (e) {
    console.log(`  ❌ iroh 启动失败: ${(e as Error).message}`);
    return;
  }

  // 设置消息处理器
  setupMessageHandler();

  // 模式 1: 发布 DID（电脑 A）
  if (isPublisher) {
    const agentName = `bolloon-${Date.now()}`;
    const info = await publishDIDToIPFS(agentName);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📋 分享给另一台电脑的信息:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  DID: ${info.did}`);
    console.log(`  CID: ${info.cid}`);
    console.log(`  iroh Node ID: ${info.irohNodeId}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n  用法:');
    console.log(`  电脑 B: npx tsx src/test/p2p-iroh-test.ts --cid=${info.cid} --node=${info.irohNodeId}`);
    console.log('\n  等待消息... (Ctrl+C 退出)\n');

    // 保持运行
    await new Promise(() => {});
  }

  // 模式 2: 解析 CID 并连接（电脑 B）
  else if (targetCid) {
    const resolved = await resolveDIDFromIPFS(targetCid);

    if (!resolved) {
      console.log('❌ 无法解析 DID 文档');
      return;
    }

    // 如果提供了 Node ID，直接连接
    if (targetNodeId) {
      console.log(`\n  🎯 连接到节点: ${targetNodeId.substring(0, 20)}...`);

      await connectAndMessage(targetNodeId, testMessage);

      console.log('\n  等待回复... (5秒后退出)');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      console.log(`\n  ⚠️  DID 文档已解析，但需要 Node ID 才能连接`);
      console.log(`     DID: ${resolved.did}`);
      console.log(`     名称: ${resolved.name}`);
      console.log('\n  注意: DID 文档中需要包含 iroh Node ID 信息');
      console.log('  请使用 --node=<iroh-node-id> 参数直接指定节点 ID');
    }
  }

  // 帮助信息
  else {
    console.log('\n用法:');
    console.log('');
    console.log('  电脑 A (发布方):');
    console.log('    npx tsx src/test/p2p-iroh-test.ts --publish');
    console.log('');
    console.log('  电脑 B (连接方):');
    console.log('    npx tsx src/test/p2p-iroh-test.ts --cid=<CID> --node=<iroh-node-id> --msg=<消息>');
    console.log('');
    console.log('示例:');
    console.log('  A: npx tsx src/test/p2p-iroh-test.ts --publish');
    console.log('  B: npx tsx src/test/p2p-iroh-test.ts --cid=QmXXX --node=xyz123 --msg="Hello!"');
  }
}

main().catch(console.error);