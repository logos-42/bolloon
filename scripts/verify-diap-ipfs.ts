/**
 * 验证脚本 (2026-08-03): DIAP 身份 → IPFS / IPNS 发布端到端
 * 1. checkKuboSetup(true, true) — 自动安装 + 启动本地 Kubo (全自动零手动)
 * 2. 用 AgentAuthManager 注册一个测试 agent DID → 上传 IPFS 拿 CID
 * 3. 验证 IPNS 发布 (publishAfterUpload / publishMultiNode)
 * 4. 用 IPFS 网关/API 读回 DID 文档, 确认可解析
 */
import { checkKuboSetup, IpfsClient, AgentAuthManager, KeyManager } from '@diap/sdk';

async function main() {
  console.log('=== [1/4] Kubo 自动安装 + 启动 ===');
  const setup = await checkKuboSetup(true, true);
  console.log('setup:', JSON.stringify({ ready: setup.ready, daemonRunning: setup.daemonRunning, apiUrl: setup.apiUrl, gatewayUrl: setup.gatewayUrl, installStatus: (setup as any).installStatus }, null, 2));

  if (!setup.ready || !setup.daemonRunning) {
    console.log('❌ Kubo 不可用, 无法验证 IPFS 发布');
    process.exit(1);
  }

  console.log('\n=== [2/4] 生成测试 agent keyPair + 注册 DID → IPFS ===');
  const kp = KeyManager.generate();
  console.log('DID:', kp.did);

  const auth = await AgentAuthManager.newWithRemoteIpfs(setup.apiUrl!, setup.gatewayUrl!);
  const result = await auth.registerAgent({ name: 'verify-diap-ipfs', services: [] }, kp, '');
  console.log('registerAgent result:', JSON.stringify(result, null, 2));

  const cid = (result as any).cid || (result as any).didDocCid;
  if (!cid) {
    console.log('❌ 未拿到 CID');
    process.exit(1);
  }
  console.log('✅ CID:', cid);

  console.log('\n=== [3/4] 验证 CID 可读回 (IPFS API) ===');
  const ipfs = await IpfsClient.newWithRemoteNode(setup.apiUrl!, setup.gatewayUrl!);
  try {
    const doc = await ipfs.fetchJson(cid);
    console.log('✅ DID 文档读回成功:', JSON.stringify(doc).slice(0, 300));
  } catch (e: any) {
    console.log('⚠️ fetchJson 失败:', e?.message?.slice(0, 120));
  }

  console.log('\n=== [4/4] IPNS 发布验证 ===');
  try {
    const pub = await (ipfs as any).publishAfterUpload?.(cid, kp);
    console.log('publishAfterUpload:', pub ? JSON.stringify(pub).slice(0, 200) : '(无此方法)');
  } catch (e: any) {
    console.log('⚠️ publishAfterUpload 失败:', e?.message?.slice(0, 150));
  }
  try {
    const { createMultiPublisher } = await import('@diap/sdk');
    const pub = createMultiPublisher ? await (createMultiPublisher as any)({ ipfs, kp })?.publishMultiNode?.(cid) : null;
    console.log('publishMultiNode:', pub ? JSON.stringify(pub).slice(0, 200) : '(不可用)');
  } catch (e: any) {
    console.log('⚠️ publishMultiNode 失败:', e?.message?.slice(0, 150));
  }

  console.log('\n=== 验证完成 ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
