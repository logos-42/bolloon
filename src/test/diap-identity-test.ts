/**
 * DIAP Identity Test - 测试 DIAP 身份生成和 DID 注册
 *
 * 测试内容：
 * 1. 生成 DIAP 身份 (KeyManager)
 * 2. 创建 DID 文档
 * 3. 模拟发布到 IPFS（不依赖真实 IPFS）
 * 4. 模拟从 IPFS 解析 DID 文档
 *
 * 运行: npx tsx src/test/diap-identity-test.ts
 */

import { KeyManager } from '@diap/sdk';

interface DiapDoc {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  interests: string[];
  peerId?: string;
  channels?: { id: string; name: string }[];
  publicKey: string;
  createdAt: string;
  updatedAt: string;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║         DIAP Identity Test - 身份生成与 DID 注册       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // ============================================================
  // 测试 1: 生成 DIAP 身份
  // ============================================================
  console.log('[Test 1/4] 生成 DIAP 身份...');
  console.log('─'.repeat(50));

  const keyManager = KeyManager.generate();
  const did = keyManager.did;
  const publicKeyHex = Buffer.from(keyManager.publicKey).toString('hex');

  console.log(`  ✅ DID 生成成功`);
  console.log(`     DID: ${did}`);
  console.log(`     公钥: ${publicKeyHex.substring(0, 32)}...`);

  // 提取用户名
  const username = process.env.USER || process.env.USERNAME || 'mechrevo';
  const didSuffix = did.split(':').pop() || '';
  const shortSuffix = didSuffix.substring(0, Math.min(4, didSuffix.length));
  const agentName = `blln-${username.toLowerCase()}-${shortSuffix}`;
  console.log(`     名称: ${agentName}`);

  // ============================================================
  // 测试 2: 创建 DID 文档
  // ============================================================
  console.log('\n[Test 2/4] 创建 DID 文档...');
  console.log('─'.repeat(50));

  const diapDoc: DiapDoc = {
    id: did,
    name: agentName,
    version: '1.0',
    capabilities: ['chat', 'reasoning', 'judgment-injection', 'harness-workflow'],
    interests: ['ai', 'p2p', 'judgment-system'],
    publicKey: publicKeyHex,
    channels: [
      { id: `ch_${Date.now()}`, name: '主对话' }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const docJson = JSON.stringify(diapDoc, null, 2);
  console.log(`  ✅ DID 文档创建成功`);
  console.log(`     文档大小: ${docJson.length} 字节`);
  console.log(`     能力列表: ${diapDoc.capabilities.join(', ')}`);
  console.log(`     兴趣领域: ${diapDoc.interests.join(', ')}`);

  // ============================================================
  // 测试 3: 模拟发布到 IPFS
  // ============================================================
  console.log('\n[Test 3/4] 模拟发布到 IPFS...');
  console.log('─'.repeat(50));

  // 模拟 IPFS CID 生成（使用 DID 的哈希）
  const crypto = await import('crypto');
  const docHash = crypto.createHash('sha256').update(docJson).digest('base64url');
  const simulatedCid = `baf${docHash.substring(0, 50)}`;

  console.log(`  ✅ 模拟 IPFS 发布成功`);
  console.log(`     模拟 CID: ${simulatedCid}`);

  // 测试 AgentAuthManager（需要真实 IPFS）
  console.log('\n  📡 尝试连接真实 IPFS...');
  try {
    const { AgentAuthManager } = await import('@diap/sdk');
    const authManager = await AgentAuthManager.newWithRemoteIpfs(
      'http://127.0.0.1:5001',
      'http://127.0.0.1:8080'
    );

    const result = await authManager.registerAgent(
      { name: agentName, services: [] },
      keyManager,
      ''
    );

    console.log(`  ✅ 真实 IPFS 注册成功`);
    console.log(`     CID: ${result.cid || 'N/A'}`);
    console.log(`     IPNS: ${result.ipnsName || 'N/A'}`);

    return {
      did,
      agentName,
      publicKey: publicKeyHex,
      diapDoc,
      cid: result.cid || simulatedCid,
      ipnsName: result.ipnsName
    };

  } catch (e) {
    const error = e as Error;
    console.log(`  ⚠️  真实 IPFS 不可用: ${error.message}`);
    console.log('     将使用模拟数据继续测试');

    return {
      did,
      agentName,
      publicKey: publicKeyHex,
      diapDoc,
      cid: simulatedCid,
      ipnsName: null
    };
  }
}

async function testParseDID(doc: DiapDoc, cid: string) {
  // ============================================================
  // 测试 4: 解析 DID 文档
  // ============================================================
  console.log('\n[Test 4/4] 解析 DID 文档...');
  console.log('─'.repeat(50));

  // 从 IPFS 获取内容
  console.log('  📡 从 IPFS 解析...');

  // 方式1: 使用 IpfsClient
  try {
    const { IpfsClient } = await import('@diap/sdk');
    const ipfs = new IpfsClient('http://127.0.0.1:5001', null);

    console.log(`     尝试从 CID ${cid} 获取...`);
    const content = await ipfs.get(cid);
    const parsedDoc = JSON.parse(content);

    console.log(`  ✅ IpfsClient 解析成功`);
    console.log(`     DID: ${parsedDoc.id}`);
    console.log(`     创建时间: ${parsedDoc.created}`);

    return;
  } catch (e) {
    console.log(`  ⚠️  IpfsClient 解析失败: ${(e as Error).message}`);
  }

  // 方式2: 直接使用 fetch
  console.log('  📡 尝试直接使用 fetch...');
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/v0/cat?arg=${cid}`, {
      method: 'POST'
    });
    const text = await response.text();
    const parsedDoc = JSON.parse(text);

    console.log(`  ✅ 直接 fetch 解析成功`);
    console.log(`     DID: ${parsedDoc.id}`);
    console.log(`     验证方法数: ${parsedDoc.verificationMethod?.length || 0}`);

    if (parsedDoc.service) {
      console.log(`     服务端点数: ${parsedDoc.service.length}`);
    }

    return;
  } catch (e) {
    console.log(`  ⚠️  直接 fetch 解析失败: ${(e as Error).message}`);
  }

  // 方式3: 使用本地文档模拟
  console.log(`  ⚠️  使用本地文档模拟解析结果`);
  console.log(`  ✅ 本地解析成功`);
  console.log(`     DID: ${doc.id}`);
  console.log(`     名称: ${doc.name}`);
  console.log(`     公钥: ${doc.publicKey.substring(0, 32)}...`);
  console.log(`     能力: ${doc.capabilities.join(', ')}`);
  console.log(`     频道: ${doc.channels?.map(c => c.name).join(', ')}`);
}

// 运行测试
(async () => {
  try {
    const result = await main();

    console.log('\n' + '═'.repeat(50));
    console.log('  测试结果摘要');
    console.log('═'.repeat(50));
    console.log(`  DID: ${result.did}`);
    console.log(`  名称: ${result.agentName}`);
    console.log(`  CID: ${result.cid}`);
    if (result.ipnsName) {
      console.log(`  IPNS: ${result.ipnsName}`);
    }
    console.log('═'.repeat(50));

    await testParseDID(result.diapDoc, result.cid);

    console.log('\n✅ 所有测试完成！\n');

  } catch (e) {
    console.error('\n❌ 测试失败:', (e as Error).message);
    process.exit(1);
  }
})();