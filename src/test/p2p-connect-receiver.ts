/**
 * P2P 接收端测试 - 电脑 B 使用 CID 解析并连接
 */

import { irohTransport } from '../network/iroh-transport.js';

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║     P2P 接收端 - 解析 CID 并连接        ║');
  console.log('╚═══════════════════════════════════════════╝');

  // 从命令行获取参数
  const args = process.argv.slice(2);
  const cid = args.find(a => a.startsWith('--cid='))?.split('=')[1];
  const nodeId = args.find(a => a.startsWith('--node='))?.split('=')[1];

  if (!cid || !nodeId) {
    console.log('\n用法:');
    console.log('  npx tsx src/test/p2p-connect-receiver.ts --cid=<CID> --node=<iroh-node-id>');
    console.log('\n示例:');
    console.log('  npx tsx src/test/p2p-connect-receiver.ts \\');
    console.log('    --cid=QmXjU6RJZRgBphuMAD9gka2JMuEKvSutTLwsfHbrBb4JGQ \\');
    console.log('    --node=327914b4744c67e0dbe3307175b22d893e14413cd9ca7f1a5667d565702575b4');
    return;
  }

  console.log(`\n📡 CID: ${cid}`);
  console.log(`🔗 目标节点: ${nodeId.substring(0, 20)}...`);

  // 1. 启动 iroh
  console.log('\n[1] 启动 iroh...');
  await irohTransport.start();
  const myNodeId = irohTransport.getNodeId();
  console.log(`  ✅ 我的节点 ID: ${myNodeId}`);

  // 2. 解析 CID
  console.log('\n[2] 解析 DID 文档...');
  try {
    const response = await fetch(`http://127.0.0.1:5001/api/v0/cat?arg=${cid}`, {
      method: 'POST'
    });
    const content = await response.text();
    const doc = JSON.parse(content);
    console.log(`  ✅ 解析成功!`);
    console.log(`     DID: ${doc.id}`);
    console.log(`     名称: ${doc.name || 'N/A'}`);
  } catch (e) {
    console.log(`  ⚠️  解析失败（可能对方离线）: ${(e as Error).message}`);
  }

  // 3. 设置消息监听
  console.log('\n[3] 设置消息监听...');
  irohTransport.onMessage('chat', (msg) => {
    console.log(`\n  💬 收到消息 from ${msg.from.substring(0, 16)}...`);
    console.log(`     内容: ${new TextDecoder().decode(msg.payload)}`);

    // 回复
    const reply = `ACK from ${myNodeId?.substring(0, 8)}: 已收到!`;
    irohTransport.sendMessage(msg.from, 'chat', new TextEncoder().encode(reply));
    console.log(`  📤 发送回复`);
  });
  console.log('  ✅ 等待消息...');

  // 4. 尝试连接并发送消息
  console.log('\n[4] 尝试连接目标节点...');
  const success = await irohTransport.sendMessage(
    nodeId,
    'chat',
    new TextEncoder().encode(`Hello from receiver at ${Date.now()}!`)
  );

  if (success) {
    console.log('  ✅ 消息发送成功!');
  } else {
    console.log('  ⚠️  消息发送失败（目标可能离线）');
    console.log('     消息将在对方上线时自动送达');
  }

  console.log('\n  等待消息... (Ctrl+C 退出)\n');

  // 保持运行
  await new Promise(() => {});
}

main().catch(console.error);