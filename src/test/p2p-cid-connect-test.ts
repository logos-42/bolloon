/**
 * P2P CID 连接测试 - 验证通过 CID 自动解析 DID 文档并建立连接
 *
 * 流程:
 * 1. 电脑 A: 生成 DID → 发布到 IPFS → 获得 CID → 分享给 B
 * 2. 电脑 B: 接收 CID → 从 IPFS 解析 DID 文档 → 提取连接信息 → 建立 P2P
 */

import crypto from 'node:crypto';
import { KeyManager, IpfsClient } from '@diap/sdk';
import { createHyperswarmCommunicator, createTopic, type P2PConnection } from '@diap/sdk';

const IPFS_ENDPOINT = 'http://127.0.0.1:5001';
const P2P_TOPIC = 'bolloon-test-v2'; // 测试用主题

interface AgentInfo {
  did: string;
  name: string;
  cid: string;
  peerPublicKey: string;
}

// ============================================================
// 步骤 1: 发布 DID 到 IPFS（电脑 A）
// ============================================================
async function publishDIDToIPFS(name: string): Promise<{ did: string; cid: string; keyPair: any }> {
  console.log('\n[步骤 1] 发布 DID 到 IPFS...');

  // 生成 DID
  const keyPair = KeyManager.generate();
  const did = keyPair.did;
  console.log(`  ✅ DID 生成: ${did}`);

  // 构建 DID 文档（标准 DIAP 格式）
  const didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ],
    id: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: `did:key:${Buffer.from(keyPair.publicKey).toString('base64url')}`
    }],
    authentication: [`${did}#key-1`],
    capabilityInvocation: [`${did}#key-1`],
    capabilityDelegation: [`${did}#key-1`],
    // 扩展字段：智能体信息
    name: name,
    capabilities: ['chat', 'reasoning', 'judgment-injection'],
    interests: ['ai', 'p2p'],
    channels: [{ id: 'main', name: '主对话' }]
  };

  // 上传到 IPFS
  const ipfs = new IpfsClient(IPFS_ENDPOINT, null);
  const docJson = JSON.stringify(didDoc);

  const formData = new FormData();
  const blob = new Blob([docJson], { type: 'application/json' });
  formData.append('file', blob, 'did-doc.json');

  const response = await fetch(`${IPFS_ENDPOINT}/api/v0/add`, {
    method: 'POST',
    body: formData
  });
  const result = await response.text();
  const cidMatch = result.match(/"Hash":"([^"]+)"/);
  const cid = cidMatch ? cidMatch[1] : '';

  console.log(`  ✅ DID 文档发布到 IPFS: ${cid}`);

  return { did, cid, keyPair };
}

// ============================================================
// 步骤 2: 从 IPFS 解析 DID 文档（电脑 B）
// ============================================================
async function resolveDIDFromIPFS(cid: string): Promise<{ did: string; name: string; capabilities: string[] } | null> {
  console.log('\n[步骤 2] 从 IPFS 解析 DID 文档...');

  const ipfs = new IpfsClient(IPFS_ENDPOINT, null);

  try {
    const content = await ipfs.get(cid);
    const doc = JSON.parse(content);

    console.log(`  ✅ DID 文档解析成功`);
    console.log(`     DID: ${doc.id}`);
    console.log(`     名称: ${doc.name || 'N/A'}`);
    console.log(`     能力: ${(doc.capabilities || []).join(', ') || 'N/A'}`);

    return {
      did: doc.id,
      name: doc.name || 'Unknown',
      capabilities: doc.capabilities || []
    };
  } catch (e) {
    console.log(`  ❌ 解析失败: ${(e as Error).message}`);
    return null;
  }
}

// ============================================================
// 步骤 3: 建立 P2P 连接
// ============================================================
async function establishP2PConnection(): Promise<{ comm: any; publicKey: string }> {
  console.log('\n[步骤 3] 初始化 P2P 网络...');

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const comm = createHyperswarmCommunicator({
    server: true,
    client: true,
    autoConnect: true,
    maxConnections: 5,
    seed: seed as any
  });

  // 先启动
  await comm.start();
  console.log('  ✅ P2P 网络已启动');

  const topic = createTopic(P2P_TOPIC) as Buffer;
  await comm.joinTopic(topic);

  console.log(`  ✅ 已加入 P2P 主题: ${P2P_TOPIC}`);

  // 获取本机公钥
  const publicKey = (comm as any).publicKey || '';
  console.log(`  ✅ 本机节点 ID: ${publicKey.substring(0, 16)}...`);

  return { comm, publicKey };
}

// ============================================================
// 步骤 4: 发送/接收消息
// ============================================================
async function testMessaging(comm: any, isInitiator: boolean) {
  console.log('\n[步骤 4] 测试消息收发...');

  const messageLog: string[] = [];

  comm.on('message', (msg: any, conn: P2PConnection) => {
    const content = new TextDecoder().decode(msg.content);
    console.log(`  📩 收到消息: ${content}`);
    messageLog.push(`收到: ${content}`);

    // 回复
    const reply = isInitiator
      ? `ACK: 已收到 "${content}"`
      : `响应: 你好，我是接收方`;
    conn.send(new TextEncoder().encode(reply));
    console.log(`  📤 发送回复: ${reply}`);
  });

  comm.on('connection', (conn: P2PConnection) => {
    console.log(`  🔌 新连接: ${conn.publicKey.substring(0, 8)}...`);

    // 发起方发送测试消息
    if (isInitiator && messageLog.length === 0) {
      setTimeout(() => {
        const testMsg = `Hello from ${isInitiator ? 'Initiator' : 'Receiver'} at ${new Date().toISOString()}`;
        conn.send(new TextEncoder().encode(testMsg));
        console.log(`  📤 发送测试消息: ${testMsg}`);
      }, 1000);
    }
  });

  return messageLog;
}

// ============================================================
// 主测试流程
// ============================================================
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     P2P CID 连接测试 - 验证 DID 文档解析与自动连接     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const isInitiator = args.includes('--initiator');
  const shareCid = args.find(a => a.startsWith('--cid='))?.split('=')[1];

  // 电脑 A: 发布 DID 到 IPFS
  if (isInitiator) {
    const agentName = `test-agent-${Date.now()}`;
    const { did, cid } = await publishDIDToIPFS(agentName);

    // 建立 P2P
    const { comm, publicKey } = await establishP2PConnection();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📋 分享给另一台电脑的信息:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  CID: ${cid}`);
    console.log(`  主题: ${P2P_TOPIC}`);
    console.log(`  你的节点 ID: ${publicKey.substring(0, 20)}...`);
    console.log('═══════════════════════════════════════════════════════════\n');

    await testMessaging(comm, true);

    console.log('\n  等待消息... (Ctrl+C 退出)');

  }
  // 电脑 B: 从 CID 解析并连接
  else if (shareCid) {
    const resolved = await resolveDIDFromIPFS(shareCid);

    if (!resolved) {
      console.log('❌ 无法解析 DID 文档');
      return;
    }

    console.log(`\n  准备连接到 ${resolved.name}...`);

    // 建立 P2P（加入同一主题）
    const { comm, publicKey } = await establishP2PConnection();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📋 本机信息:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  DID: ${resolved.did}`);
    console.log(`  名称: ${resolved.name}`);
    console.log(`  主题: ${P2P_TOPIC}`);
    console.log(`  你的节点 ID: ${publicKey.substring(0, 20)}...`);
    console.log('═══════════════════════════════════════════════════════════\n');

    await testMessaging(comm, false);

    console.log('\n  等待消息... (Ctrl+C 退出)');

  } else {
    console.log('\n用法:');
    console.log('  电脑 A (发起方): npx tsx src/test/p2p-cid-connect-test.ts --initiator');
    console.log('  电脑 B (接收方): npx tsx src/test/p2p-cid-connect-test.ts --cid=<CID>');
    console.log('\n测试步骤:');
    console.log('  1. 在电脑 A 运行 --initiator，记录显示的 CID');
    console.log('  2. 在电脑 B 运行 --cid=<上一步的CID>');
    console.log('  3. 观察 P2P 连接和消息收发');
  }
}

main().catch(console.error);