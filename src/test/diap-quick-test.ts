/**
 * DIAP Quick Test - 快速验证 DIAP 功能（跳过慢速 IPNS）
 */

import { KeyManager } from '@diap/sdk';

async function main() {
  console.log('\n🔑 DIAP 快速验证测试\n');

  // 1. 生成身份
  console.log('[1] 生成 DIAP 身份...');
  const km = KeyManager.generate();
  console.log(`    ✅ DID: ${km.did}`);

  // 2. 验证可以直接获取公钥
  console.log('\n[2] 获取公钥...');
  const pkHex = Buffer.from(km.publicKey).toString('hex');
  console.log(`    ✅ 公钥: ${pkHex.substring(0, 24)}...`);

  // 3. 测试本地 IPFS
  console.log('\n[3] 测试本地 IPFS...');
  const testContent = JSON.stringify({
    test: true,
    did: km.did,
    timestamp: Date.now()
  });

  try {
    // 上传 - 使用 form-data 格式
    const formData = new FormData();
    const blob = new Blob([testContent], { type: 'application/json' });
    formData.append('file', blob, 'test.json');

    const addResponse = await fetch('http://127.0.0.1:5001/api/v0/add', {
      method: 'POST',
      body: formData
    });
    const addResult = await addResponse.text();
    // IPFS add 返回格式: {"Name":"test.json","Hash":"Qm...","Size":"..."}
    const cidMatch = addResult.match(/"Hash":"([^"]+)"/);
    const cid = cidMatch ? cidMatch[1] : null;

    if (!cid) {
      console.log(`    ⚠️  解析 CID 失败: ${addResult}`);
      throw new Error('CID not found');
    }
    console.log(`    ✅ 上传成功: ${cid}`);

    // 下载
    const getResponse = await fetch(`http://127.0.0.1:5001/api/v0/cat?arg=${cid}`, {
      method: 'POST'
    });
    const retrieved = await getResponse.text();
    const parsed = JSON.parse(retrieved);
    console.log(`    ✅ 下载成功: test=${parsed.test}`);

    console.log('\n═══════════════════════════════════════');
    console.log('  ✅ DIAP + IPFS 基本功能正常！');
    console.log('═══════════════════════════════════════');
    console.log(`\n  本节点信息:`);
    console.log(`  · DID: ${km.did}`);
    console.log(`  · CID: ${cid}`);
    console.log(`\n  供另一台电脑使用的连接信息:`);
    console.log(`  · DID: ${km.did}`);
    console.log(`  · CID: ${cid}`);
    console.log('');

  } catch (e) {
    console.log(`    ❌ IPFS 操作失败: ${(e as Error).message}`);
  }
}

main().catch(console.error);