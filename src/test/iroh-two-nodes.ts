import { irohTransport } from '../network/iroh-transport.js';

const args = process.argv.slice(2);
const role = args[0] as 'server' | 'client';
const targetNodeId = args[1];

if (!role || !['server', 'client'].includes(role)) {
  console.log('Usage:');
  console.log('  Server: npx tsx src/test/iroh-two-nodes.ts server');
  console.log('  Client: npx tsx src/test/iroh-two-nodes.ts client <server-node-id>');
  process.exit(1);
}

async function runServer() {
  console.log('[Server] Starting iroh transport...');
  const node = await irohTransport.start();
  console.log('[Server] Node ID:', node.nodeId);
  console.log('[Server] Address:', node.addr);
  console.log('[Server] Waiting for connections...\n');

  let messageCount = 0;

  irohTransport.onMessage('ping', (msg) => {
    messageCount++;
    console.log(`[Server] Received ping #${messageCount} from ${msg.from.substring(0, 16)}...`);
    console.log(`[Server] Payload: "${new TextDecoder().decode(msg.payload)}"`);

    // 回复 pong
    irohTransport.sendMessage(msg.from, 'pong', new TextEncoder().encode('pong response'));
  });

  irohTransport.onMessage('data', (msg) => {
    messageCount++;
    console.log(`[Server] Received data #${messageCount}: ${msg.payload.length} bytes`);
  });

  // 保持运行
  await new Promise(resolve => setTimeout(resolve, 60000));
}

async function runClient(targetId: string) {
  if (!targetId) {
    console.error('[Client] Error: target node ID required');
    process.exit(1);
  }

  console.log('[Client] Starting iroh transport...');
  const node = await irohTransport.start();
  console.log('[Client] Node ID:', node.nodeId);
  console.log('[Client] Target:', targetId);
  console.log('[Client] Connecting to server...\n');

  // 等待连接建立
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 发送 ping
  console.log('[Client] Sending ping...');
  const sent = await irohTransport.sendMessage(targetId, 'ping', new TextEncoder().encode('hello server'));
  console.log('[Client] Ping sent:', sent);

  // 发送数据
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('[Client] Sending data...');
  const data = new Uint8Array(1024).fill(65); // 1KB of 'A'
  await irohTransport.sendMessage(targetId, 'data', data);
  console.log('[Client] Data sent: 1024 bytes');

  // 等待响应
  await new Promise(resolve => setTimeout(resolve, 2000));

  irohTransport.onMessage('pong', (msg) => {
    console.log(`[Client] Received pong from ${msg.from.substring(0, 16)}...`);
    console.log(`[Client] Payload: "${new TextDecoder().decode(msg.payload)}"`);
  });

  // 等待更多响应
  await new Promise(resolve => setTimeout(resolve, 3000));

  await irohTransport.shutdown();
  console.log('[Client] Done');
}

if (role === 'server') {
  runServer();
} else {
  runClient(targetNodeId!);
}
