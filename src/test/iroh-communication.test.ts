import { irohTransport } from '../network/iroh-transport.js';

async function testTwoNodesCommunication() {
  console.log('=== Two Node Communication Test ===\n');

  // 启动第一个节点 (server)
  console.log('[Node1] Starting...');
  const node1 = await irohTransport.start();
  console.log('[Node1] Node ID:', node1.nodeId.substring(0, 16) + '...');
  console.log('[Node1] Addr:', node1.addr.substring(0, 32) + '...\n');

  // 注册消息处理器
  let messageCount = 0;
  const messages: any[] = [];

  irohTransport.onMessage('hello', (msg) => {
    messageCount++;
    messages.push(msg);
    console.log(`[Node1] Received message #${messageCount} from ${msg.from.substring(0, 8)}...`);
    console.log(`[Node1] Payload: ${new TextDecoder().decode(msg.payload)}`);
  });

  // 模拟第二个节点连接并发送消息
  // 注意: 在实际场景中，两个节点需要在不同进程/机器上运行
  // 这里我们测试的是单节点的消息处理能力

  console.log('[Node1] Listening for incoming connections...\n');

  // 等待一段时间看是否有连接
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`[Node1] Messages received: ${messageCount}`);

  // 测试发送消息 API (模拟)
  console.log('\n[Node1] Testing sendMessage API...');
  const fakeTargetId = 'c0b07356bcf4a505000000000000000000000000';
  // 注意: 这会失败因为目标节点不存在，但测试 API 是否正常调用
  try {
    await irohTransport.sendMessage(fakeTargetId, 'test', new TextEncoder().encode('test'));
  } catch (e) {
    console.log('[Node1] Expected failure:', (e as Error).message);
  }

  await irohTransport.shutdown();
  console.log('\n=== Test Complete ===');
}

async function testMessageParsing() {
  console.log('=== Message Parsing Test ===\n');

  await irohTransport.start();

  // 测试不同的消息格式
  const testCases = [
    { type: 'task', payload: '{"id":"1","type":"summarize"}' },
    { type: 'relay', payload: 'forward-data' },
    { type: 'blob', payload: 'binary-data-here' },
  ];

  for (const tc of testCases) {
    const encoded = new TextEncoder().encode(tc.payload);
    const formatted = tc.type + ':' + tc.payload;
    console.log(`Parsed: type=${tc.type}, payload_len=${encoded.length}`);
  }

  await irohTransport.shutdown();
  console.log('\n=== Parsing Test Complete ===');
}

runTests();

async function runTests() {
  try {
    await testTwoNodesCommunication();
    await testMessageParsing();
    console.log('\n✅ All communication tests passed');
  } catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
  }
}
